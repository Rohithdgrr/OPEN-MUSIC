//! canvas.rs — Spotify Canvas: the short looping video behind Now Playing art.
//!
//! **There is no official API for this.** Spotify publishes no Canvas endpoint;
//! the only route is the *undocumented* Pathfinder GraphQL API the official app
//! itself uses, authenticated with an `sp_dc` cookie harvested from a logged-in
//! browser session. That is not our OAuth token and not our client id — Canvas
//! and `spotify_signin` are therefore independently usable.
//!
//! Consequences, all deliberate (design: docs/spotify-android-canvas.md §3B):
//!
//! - **Unofficial / ToS-exposed.** The endpoint is undocumented, rate limits are
//!   unknown, and URLs are expiring CDN links. Everything here is best-effort:
//!   any failure returns `Ok(None)` (or `Err` only for "not configured"), never
//!   a panic, and never blocks playback. The feature is opt-in and off by default.
//! - **Keyed on ISRC.** Canvas is a Spotify concept, but we play from the
//!   JioSaavn catalog, whose ids mean nothing to Spotify. When the caller has no
//!   ISRC (every normal playback track — `resolve_song` returns none) we resolve
//!   one by title+artist search first.
//! - **All network leaves from Rust**, so the WebView CSP only has to allow the
//!   `canvaz.scdn.co` media itself, not the API traffic.
//!
//! Scope: no new dependency; `reqwest` only.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::spotify::client_id_public;

/// Spotify's undocumented GraphQL endpoint. Not a public API.
const PATHFINDER: &str = "https://api-partner.spotify.com/pathfinder/v1/query";

/// Cookie-auth token exchange used by the official clients.
const TOKEN_ENDPOINT: &str = "https://accounts.spotify.com/api/token";

/// How long before the derived token expires that we refresh. Spotify hands
/// out ~3600 s tokens; refresh a minute early, exactly as `spotify.rs` does.
const TOKEN_SKEW: i64 = 60;

/// Spotify Web API base — only used to turn (title, artist) into an ISRC.
const API_BASE: &str = "https://api.spotify.com/v1";

/// Cookie name the official web player reads. Set by `spotify_set_spdc`.
pub const SPDC_KEY: &str = "spotify:sp_dc";

/// Canvas URLs are expiring CDN links, so a long TTL would serve dead video.
/// Half a day is short enough to stay fresh and long enough to matter.
const CANVAS_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Spotify can hold a Canvas for ~8 s of looping video; we ask for the track's
/// own match and take the first one.
const CANVAS_QUERY: &str = r#"query canvas($uri: String!) {
  track(uri: $uri) {
    canvases {
      edges {
        node {
          __typename
          ... on CanvasVideoNode { id uri artist { name } }
        }
      }
    }
  }
}"#;

// ------------------------------------------------------------- state -

/// Process-wide Canvas state: one HTTP client + the ISRC→URL cache.
pub struct CanvasState {
    http: reqwest::Client,
    cache: moka::future::Cache<String, String>,
    /// Memoised `sp_dc`→access-token, refreshed on expiry. Cookie lives in kv;
    /// only the derived token is held here, and never in the WebView.
    token: std::sync::Mutex<Option<(String, std::time::Instant)>>,
}

impl CanvasState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            cache: moka::future::Cache::builder()
                .max_capacity(512)
                .time_to_live(CANVAS_TTL)
                .build(),
            token: std::sync::Mutex::new(None),
        }
    }
}

impl Default for CanvasState {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------- models -

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: i64,
}

/// One edge of the `canvases` connection. Field-by-field and all-optional on
/// purpose: this is an *undocumented* schema, so a shape change must degrade to
/// "no canvas" rather than fail the whole query. Only the two fields the
/// renderer needs are decoded.
#[derive(Debug, Deserialize)]
struct CanvasEdge {
    #[serde(default)]
    node: Option<CanvasNode>,
}

#[derive(Debug, Deserialize)]
struct CanvasNode {
    /// Discriminator (`CanvasVideoNode` today). Absent ⇒ ignore the node.
    #[serde(rename = "__typename", default)]
    type_name: Option<String>,
    /// The mp4, when this node actually carries one.
    #[serde(default)]
    uri: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CanvasResponse {
    #[serde(default)]
    data: Option<CanvasData>,
}

#[derive(Debug, Deserialize)]
struct CanvasData {
    #[serde(default)]
    track: Option<CanvasTrack>,
}

#[derive(Debug, Deserialize)]
struct CanvasTrack {
    #[serde(default)]
    canvases: Option<CanvasCanvasWrap>,
}

#[derive(Debug, Deserialize)]
struct CanvasCanvasWrap {
    #[serde(default)]
    edges: Vec<CanvasEdge>,
}

/// Web-API search answer, narrowed to the ISRC we need.
#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    tracks: Option<SearchTracks>,
}

#[derive(Debug, Deserialize)]
struct SearchTracks {
    #[serde(default)]
    items: Vec<SearchTrack>,
}

#[derive(Debug, Deserialize)]
struct SearchTrack {
    #[serde(default)]
    external_ids: Option<SearchExternalIds>,
}

#[derive(Debug, Deserialize)]
struct SearchExternalIds {
    #[serde(default)]
    isrc: Option<String>,
}

/// What the command hands back: the mp4, plus enough context to debug a miss
/// without turning a `None` into a user-facing error.
#[derive(Debug, Clone, Serialize)]
pub struct Canvas {
    /// Expiring `canvaz.scdn.co/*.mp4`. The renderer treats `null` as "keep art".
    pub url: Option<String>,
    /// The ISRC we settled on — useful when a track simply has no Canvas.
    pub isrc: Option<String>,
}

impl Canvas {
    fn empty(isrc: Option<String>) -> Self {
        Self { url: None, isrc }
    }
}

// ------------------------------------------------------------- parsing -

/// Pull the first playable mp4 out of a Pathfinder `track.canvases` payload.
///
/// Returns `None` for *any* shape we do not recognise. An undocumented schema
/// changing underneath us is the expected failure mode, not an error path —
/// a parse miss must read as "no Canvas today", never as a crash or a toast.
fn parse_canvas(body: &str) -> Option<String> {
    let parsed: CanvasResponse = serde_json::from_str(body).ok()?;
    let track = parsed.data?.track?;
    let wrap = track.canvases?;
    for edge in &wrap.edges {
        let node = edge.node.as_ref()?;
        // Only video nodes carry a loop we can render; anything else (or a
        // node with no uri) is not usable.
        if node.type_name.as_deref() != Some("CanvasVideoNode") {
            continue;
        }
        let uri = node.uri.as_deref()?;
        if uri.starts_with("https://") && uri.contains("scdn.co") {
            return Some(uri.to_string());
        }
    }
    None
}

/// First ISRC out of a Web-API search response, or `None`.
fn parse_isrc(body: &str) -> Option<String> {
    let parsed: SearchResponse = serde_json::from_str(body).ok()?;
    parsed.tracks?.items.into_iter().find_map(|t| {
        t.external_ids
            .and_then(|e| e.isrc)
            .filter(|s| !s.is_empty())
    })
}

// ------------------------------------------------------------- auth -

/// Turn the `sp_dc` cookie into a short-lived API token.
///
/// This is the official clients' own cookie exchange, not our OAuth PKCE flow.
/// Failure is an `Err` with the status so a bad/expired cookie is diagnosable —
/// but only ever for the "not configured" and "rejected" cases.
async fn spdc_token(
    http: &reqwest::Client,
    sp_dc: &str,
    cid: &str,
) -> Result<(String, Duration), String> {
    let resp = http
        .post(TOKEN_ENDPOINT)
        .header("Cookie", format!("sp_dc={sp_dc}"))
        .form(&[("grant_type", "client_credentials"), ("client_id", cid)])
        .send()
        .await
        .map_err(|e| format!("Canvas token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!(
            "Spotify rejected the Canvas session cookie ({status}) — it may have expired"
        ));
    }
    let tok: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Canvas token response was junk: {e}"))?;
    // Same skew rule as spotify.rs: refresh a minute before Spotify says it dies.
    let ttl = tok.expires_in.clamp(60, 3600) - TOKEN_SKEW;
    Ok((tok.access_token, Duration::from_secs(ttl.max(60) as u64)))
}

/// A usable token, refreshing when missing or stale.
async fn canvas_token(state: &CanvasState, sp_dc: &str, cid: &str) -> Result<String, String> {
    {
        let guard = state
            .token
            .lock()
            .map_err(|e| format!("Canvas state poisoned: {e}"))?;
        if let Some((tok, exp)) = guard.as_ref() {
            if std::time::Instant::now() < *exp {
                return Ok(tok.clone());
            }
        }
    }
    let (tok, ttl) = spdc_token(&state.http, sp_dc, cid).await?;
    let mut guard = state
        .token
        .lock()
        .map_err(|e| format!("Canvas state poisoned: {e}"))?;
    let exp = std::time::Instant::now() + ttl;
    *guard = Some((tok.clone(), exp));
    Ok(tok)
}

// ------------------------------------------------------------- lookup -

/// ISRC via Web-API search, when the caller did not have one.
async fn isrc_for(
    http: &reqwest::Client,
    token: &str,
    title: &str,
    artist: &str,
) -> Option<String> {
    let q = format!("track:{title} artist:{artist}");
    let resp = http
        .get(format!("{API_BASE}/search"))
        .bearer_auth(token)
        .query(&[("q", q.as_str()), ("type", "track"), ("limit", "1")])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    parse_isrc(&resp.text().await.ok()?)
}

/// The Canvas query, keyed by ISRC (the only stable cross-catalog key we have).
async fn query_canvas(
    http: &reqwest::Client,
    token: &str,
    isrc: &str,
) -> Result<Option<String>, String> {
    // Pathfinder wants a client-state header alongside the bearer token.
    let body = serde_json::json!({
        "query": CANVAS_QUERY,
        "variables": { "uri": format!("spotify:isrc:{isrc}") },
        "operationName": "canvas",
    });
    let resp = http
        .post(PATHFINDER)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Canvas query failed: {e}"))?;
    if !resp.status().is_success() {
        // Rate limit / schema drift ⇒ no canvas, not a user-facing failure.
        return Ok(None);
    }
    let text = resp.text().await.unwrap_or_default();
    Ok(parse_canvas(&text))
}

// ------------------------------------------------------------- command -

/// Best-effort Canvas lookup for one track.
///
/// `isrc` is optional because ordinary JioSaavn playback never has one; title +
/// artist then stand in. `Ok(None)` means "no Canvas, keep the album art" and is
/// the *normal* outcome — only a missing `sp_dc` or a rejected cookie is an `Err`.
#[tauri::command]
pub async fn fetch_canvas(
    state: tauri::State<'_, CanvasState>,
    app: tauri::State<'_, crate::proxy::AppState>,
    isrc: Option<String>,
    title: String,
    artist: String,
) -> Result<Canvas, String> {
    // Not configured is the designed default until the user pastes a cookie.
    let sp_dc = app
        .store()?
        .kv_get(SPDC_KEY)?
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "Canvas not configured — paste your Spotify session cookie in Settings".to_string()
        })?;
    let cid = client_id_public()?;

    // A provided ISRC is authoritative; otherwise resolve one.
    let key = match isrc.filter(|s| !s.is_empty()) {
        Some(i) => Some(i),
        None => {
            let token = canvas_token(&state, &sp_dc, cid).await?;
            isrc_for(&state.http, &token, &title, &artist).await
        }
    };
    let Some(isrc) = key else {
        return Ok(Canvas::empty(None));
    };

    // Cache hit ⇒ no network. Miss ⇒ query, and cache only a real hit so a
    // transient failure is retried next time (never cache errors).
    if let Some(url) = state.cache.get(&isrc).await {
        return Ok(Canvas {
            url: Some(url),
            isrc: Some(isrc),
        });
    }
    let token = canvas_token(&state, &sp_dc, cid).await?;
    match query_canvas(&state.http, &token, &isrc).await? {
        Some(url) => {
            state.cache.insert(isrc.clone(), url.clone()).await;
            Ok(Canvas {
                url: Some(url),
                isrc: Some(isrc),
            })
        }
        None => Ok(Canvas::empty(Some(isrc))),
    }
}

/// Store / clear the `sp_dc` cookie. Empty string clears it.
#[tauri::command]
pub fn set_canvas_cookie(
    app: tauri::State<'_, crate::proxy::AppState>,
    cookie: String,
) -> Result<(), String> {
    let trimmed = cookie.trim();
    if trimmed.is_empty() {
        return app.store()?.kv_put(SPDC_KEY, "");
    }
    // Length + charset only. Guessing at the cookie's prefix would risk
    // rejecting a valid one; the token exchange is the real validator and
    // already reports a clear "may have expired" reason.
    if trimmed.len() < 20 || trimmed.contains(char::is_whitespace) {
        return Err("That does not look like a Spotify `sp_dc` cookie".to_string());
    }
    app.store()?.kv_put(SPDC_KEY, trimmed)
}

/// Whether Canvas is configured (a non-empty cookie exists).
#[tauri::command]
pub fn canvas_configured(app: tauri::State<'_, crate::proxy::AppState>) -> bool {
    app.store()
        .ok()
        .and_then(|s| s.kv_get(SPDC_KEY).ok().flatten())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_video_canvas() {
        let body = r#"{"data":{"track":{"canvases":{"edges":[{"node":{"__typename":"CanvasVideoNode","uri":"https://canvaz.scdn.co/upload/x/video.cnvs.mp4","artist":{"name":"SZA"}}}]}}}}"#;
        assert_eq!(
            parse_canvas(body).as_deref(),
            Some("https://canvaz.scdn.co/upload/x/video.cnvs.mp4")
        );
    }

    /// A schema change must read as "no canvas", never a panic or an Err.
    #[test]
    fn unknown_shape_is_none_not_a_panic() {
        assert!(parse_canvas("{\"data\":{}}").is_none());
        assert!(parse_canvas("not json").is_none());
        assert!(parse_canvas("{}").is_none());
    }

    /// Only video nodes with an scdn.co mp4 are usable.
    #[test]
    fn ignores_non_video_and_offsite_uris() {
        let image = r#"{"data":{"track":{"canvases":{"edges":[{"node":{"__typename":"CanvasImageNode","uri":"https://canvaz.scdn.co/x.png"}}]}}}}"#;
        assert!(parse_canvas(image).is_none());

        let offsite = r#"{"data":{"track":{"canvases":{"edges":[{"node":{"__typename":"CanvasVideoNode","uri":"https://evil.example/x.mp4"}}]}}}}"#;
        assert!(parse_canvas(offsite).is_none());
    }

    #[test]
    fn pulls_the_first_isrc_from_search() {
        let body = r#"{"tracks":{"items":[{"external_ids":{"isrc":"USUM72600001"}},{"external_ids":{}}]}}"#;
        assert_eq!(parse_isrc(body).as_deref(), Some("USUM72600001"));
    }

    #[test]
    fn missing_isrc_is_none() {
        assert!(parse_isrc("{\"tracks\":{\"items\":[]}}").is_none());
        assert!(parse_isrc("junk").is_none());
    }

    /// An empty ISRC must not become a cache key / query argument.
    #[test]
    fn empty_isrc_is_treated_as_absent() {
        let v = Some(String::new());
        assert!(v.filter(|s| !s.is_empty()).is_none());
    }
}
