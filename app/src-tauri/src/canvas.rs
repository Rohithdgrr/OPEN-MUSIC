//! canvas.rs — Now Playing Canvas: a short looping video behind the album art.
//!
//! Two sources, one slot (design: docs/spotify-android-canvas.md §14):
//!
//! - **Apple Music animated artwork — the default, no account.** The public
//!   web player's own bearer is scraped out of music.apple.com's JS bundle
//!   (verified live 2026-10-17: ~66 days of validity, no login, no cookie),
//!   then used to search the catalog for the track's album (or, failing that,
//!   the track itself → its parent album) with `extend=editorialVideo`. The
//!   artwork's HLS ladder resolves to a single-file byte-range fMP4 that a
//!   plain `<video>` plays directly — no hls.js, no MSE.
//! - **Spotify Canvas — the `sp_dc` cookie route (R2, not implemented here).**
//!   §13 proved the app's OAuth sign-in cannot serve Canvas: the query needs a
//!   logged-in *web session*, same as every other third-party client.
//!
//! So the command needs no configuration. A miss — no artwork for this
//! title, Apple unreachable, … — reads as `Ok(None)` and the album art simply
//! stays; errors are reserved for genuinely retryable failures and are never
//! cached, while successful *misses* are memoised so a track without artwork
//! is not re-searched on every paint. The feature is opt-in at the UI layer
//! (`tm-canvas`) and best-effort everywhere: nothing here may block playback.
//!
//! Videos are downloaded once into the disk cache (`<cache>/canvas/<id>.mp4`,
//! budget-managed like art) and served to the WebView by the loopback relay's
//! `/canvas` route, so the WebView CSP needs no new origins and the renderer
//! stays unchanged (it loads `http://127.0.0.1:<port>/canvas?id=…&token=…`).

use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// kv key of the stored `sp_dc` cookie — the R2 hook (docs §14.1). Stored by
/// the settings UI either way, read only once the Spotify route lands.
pub const SPDC_KEY: &str = "spotify:sp_dc";

/// How long a successful lookup — including an honest `None` — is memoised.
const CANVAS_TTL: Duration = Duration::from_secs(6 * 60 * 60);

const AM_HOME: &str = "https://music.apple.com";
const AM_API: &str = "https://amp-api-edge.music.apple.com/v1/catalog/us/search";
const AM_ORIGIN: &str = "https://music.apple.com";
const AM_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";
/// Spotify-Canvas rendition floor (§17): the *centred 9:16 crop* of the
/// picked AVC rendition must be at least 720×1280. Apple's tall cuts are 3:4
/// (e.g. 1078×1438 → 808×1438), so a width-only floor would pick a 830×1106
/// cut whose 9:16 crop is only 622 wide. When no variant clears the floor the
/// picker keeps the largest crop area and the renderer still presents it.
const AM_MIN_WIDTH: u32 = 720;
const AM_MIN_HEIGHT: u32 = 1280;
const CANVAS_ASPECT_W: u64 = 9;
const CANVAS_ASPECT_H: u64 = 16;
const AM_SEARCH_LIMIT: &str = "8";
/// Refuse absurd downloads; real files are 0.5–2 MB.
const AM_MAX_VIDEO_BYTES: usize = 12 * 1024 * 1024;

// ------------------------------------------------------------- state -

/// Process-wide Canvas state: one HTTP client, the lookup cache, and the
/// scraped Apple web token (cleared and re-scraped on a 401).
pub struct CanvasState {
    http: reqwest::Client,
    /// `title|artist|album` → relay URL, or `None` for an honest miss.
    cache: moka::future::Cache<String, Option<String>>,
    token: std::sync::Mutex<Option<String>>,
}

impl CanvasState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(AM_UA)
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

/// What the command hands back. `url: null` ⇒ the renderer keeps the art.
#[derive(Debug, Clone, Serialize)]
pub struct Canvas {
    /// `http://127.0.0.1:<port>/canvas?id=…&token=…`, served by the relay.
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AmSearchResponse {
    #[serde(default)]
    resources: Option<AmResources>,
}

#[derive(Debug, Deserialize)]
struct AmResources {
    #[serde(default)]
    albums: std::collections::HashMap<String, AmAlbum>,
    #[serde(default)]
    songs: std::collections::HashMap<String, AmSong>,
}

#[derive(Debug, Deserialize)]
struct AmAlbum {
    #[serde(default)]
    attributes: Option<AmAlbumAttributes>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmAlbumAttributes {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    artist_name: Option<String>,
    #[serde(default)]
    editorial_video: Option<AmEditorialVideo>,
}

/// The four animated-artwork cuts Apple ships; square first in `master_of`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmEditorialVideo {
    #[serde(default)]
    motion_detail_square: Option<AmMotionVideo>,
    #[serde(default)]
    motion_square_video1x1: Option<AmMotionVideo>,
    #[serde(default)]
    motion_detail_tall: Option<AmMotionVideo>,
    #[serde(default)]
    motion_tall_video3x4: Option<AmMotionVideo>,
}

#[derive(Debug, Deserialize)]
struct AmMotionVideo {
    #[serde(default)]
    video: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AmSong {
    #[serde(default)]
    attributes: Option<AmSongAttributes>,
    #[serde(default)]
    relationships: Option<AmSongRelationships>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmSongAttributes {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    artist_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AmSongRelationships {
    #[serde(default)]
    albums: Option<AmRefList>,
}

#[derive(Debug, Deserialize)]
struct AmRefList {
    #[serde(default)]
    data: Vec<AmRef>,
}

#[derive(Debug, Deserialize)]
struct AmRef {
    #[serde(default)]
    id: String,
}

// ------------------------------------------------------------- search -

#[derive(Clone, Copy)]
enum AmKind {
    Albums,
    Songs,
}

impl AmKind {
    fn types(self) -> &'static str {
        match self {
            Self::Albums => "albums",
            Self::Songs => "songs",
        }
    }
}

enum AmReply {
    Json(serde_json::Value),
    Unauthorized,
}

/// One catalog search attempt with an explicit token.
async fn am_request(
    state: &CanvasState,
    kind: AmKind,
    query: &str,
    token: &str,
) -> Result<AmReply, String> {
    let mut url = url::Url::parse(AM_API).map_err(|e| format!("Apple API URL: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("term", query);
        pairs.append_pair("types", kind.types());
        pairs.append_pair("format[resources]", "map");
        pairs.append_pair("extend", "editorialVideo");
        pairs.append_pair("l", "en-US");
        pairs.append_pair("limit", AM_SEARCH_LIMIT);
        pairs.append_pair("platform", "web");
        match kind {
            AmKind::Albums => {
                pairs.append_pair("fields[albums]", "name,artistName,editorialVideo");
            }
            AmKind::Songs => {
                pairs.append_pair("include[songs]", "albums");
            }
        }
    }
    let resp = state
        .http
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Origin", AM_ORIGIN)
        .header("Referer", format!("{AM_ORIGIN}/"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("animated artwork search failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(AmReply::Unauthorized);
    }
    if !status.is_success() {
        return Err(format!("animated artwork search: HTTP {status}"));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("animated artwork search body failed: {e}"))?;
    serde_json::from_str(&body)
        .map(AmReply::Json)
        .map_err(|e| format!("animated artwork search was not JSON: {e}"))
}

/// Search with the scraped token; one transparent re-scrape on a 401.
async fn am_search(
    state: &CanvasState,
    kind: AmKind,
    query: &str,
) -> Result<serde_json::Value, String> {
    let token = am_token(state).await?;
    match am_request(state, kind, query, &token).await? {
        AmReply::Json(json) => Ok(json),
        AmReply::Unauthorized => {
            // The bundle rotates its token; re-scrape once before giving up.
            if let Ok(mut guard) = state.token.lock() {
                *guard = None;
            }
            let token = am_token(state).await?;
            match am_request(state, kind, query, &token).await? {
                AmReply::Json(json) => Ok(json),
                AmReply::Unauthorized => {
                    Err("Apple rejected the scraped web token twice".to_string())
                }
            }
        }
    }
}

/// The AMPWebPlay bearer, scraped from the public web player and memoised.
async fn am_token(state: &CanvasState) -> Result<String, String> {
    if let Some(token) = state.token.lock().ok().and_then(|guard| guard.clone()) {
        return Ok(token);
    }
    let home = fetch_text(&state.http, AM_HOME).await?;
    let bundle =
        find_bundle_path(&home).ok_or_else(|| "Apple Music web bundle not found".to_string())?;
    let script = fetch_text(&state.http, &format!("{AM_HOME}{bundle}")).await?;
    let jwt = find_amp_jwt(&script)
        .ok_or_else(|| "Apple Music web token not in the bundle".to_string())?;
    if let Ok(mut guard) = state.token.lock() {
        *guard = Some(jwt.clone());
    }
    Ok(jwt)
}

async fn fetch_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("animated artwork request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("animated artwork request: HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("animated artwork body failed: {e}"))
}

// ------------------------------------------------------------- scraping -

/// `/assets/index~<hash>.js` out of the storefront HTML.
fn find_bundle_path(home: &str) -> Option<&str> {
    let start = home.find("/assets/index~")?;
    let rest = &home[start..];
    let end = rest.find(['"', '\'', '>', ' ', '?']).unwrap_or(rest.len());
    let path = &rest[..end];
    path.ends_with(".js").then_some(path)
}

/// The bundle carries several JWTs; the API bearer is the one whose payload
/// says `iss: AMPWebPlay`. Falls back to the first JWT-shaped string, so a
/// signing change reads as "try it" rather than "no token".
fn find_amp_jwt(script: &str) -> Option<String> {
    let bytes = script.as_bytes();
    let mut i = 0usize;
    let mut fallback: Option<String> = None;
    while let Some(rel) = script[i..].find("eyJ") {
        let start = i + rel;
        let mut end = start;
        while end < bytes.len() {
            let b = bytes[end];
            let ok = b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.';
            if !ok {
                break;
            }
            end += 1;
        }
        if end.saturating_sub(start) > 40 && script[start..end].matches('.').count() == 2 {
            let candidate = &script[start..end];
            if jwt_says_amp_web_play(candidate) {
                return Some(candidate.to_string());
            }
            if fallback.is_none() {
                fallback = Some(candidate.to_string());
            }
        }
        i = end.max(start + 1);
    }
    fallback
}

fn jwt_says_amp_web_play(jwt: &str) -> bool {
    let Some(payload) = jwt.split('.').nth(1) else {
        return false;
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload));
    match decoded {
        Ok(bytes) => String::from_utf8_lossy(&bytes).contains("\"iss\":\"AMPWebPlay\""),
        Err(_) => false,
    }
}

// ------------------------------------------------------------- matching -

/// Lowercase, non-alphanumerics collapsed to single spaces. Unicode-safe so
/// non-Latin names still compare consistently.
fn normalize_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else {
            pending_space = true;
        }
    }
    out
}

/// 2 = exact name, 1 = containment (the shorter side must be ≥ 4 chars so a
/// tiny subject cannot match everything), `None` = no match.
fn name_match(candidate: &str, subject: &str) -> Option<u8> {
    let candidate = normalize_key(candidate);
    let subject = normalize_key(subject);
    if candidate.is_empty() || subject.is_empty() {
        return None;
    }
    if candidate == subject {
        return Some(2);
    }
    let (shorter, longer) = if candidate.len() <= subject.len() {
        (&candidate, &subject)
    } else {
        (&subject, &candidate)
    };
    if shorter.len() >= 4 && longer.contains(shorter.as_str()) {
        return Some(1);
    }
    None
}

/// Loose artist agreement: whole-string containment, or any meaningful word
/// in common ("Arijit Singh" matches our "Arijit Singh, Mithoon"). No artist
/// on our side ⇒ nothing to check ⇒ accept.
fn artist_agrees(candidate: &str, artist: &str) -> bool {
    let artist = normalize_key(artist);
    if artist.is_empty() {
        return true;
    }
    let candidate = normalize_key(candidate);
    if candidate.is_empty() {
        return false;
    }
    if candidate.contains(&artist) {
        return true;
    }
    artist
        .split(' ')
        .filter(|word| word.len() >= 3)
        .any(|word| {
            candidate
                .split(' ')
                .any(|candidate_word| candidate_word == word)
        })
}

/// Query cleanup: drop parenthesised/bracketed clauses and the feat./ft.
/// tokens, collapse whitespace. The matcher does the precision work; the
/// search API is happier with a bare "title artist".
fn clean_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let mut cleaned = String::with_capacity(out.len());
    for token in out.split_whitespace() {
        let lower = token.to_lowercase();
        if matches!(
            lower.as_str(),
            "feat." | "feat" | "ft." | "ft" | "featuring"
        ) {
            continue;
        }
        cleaned.push_str(token);
        cleaned.push(' ');
    }
    cleaned.trim().to_string()
}

// ------------------------------------------------------------- picking -

/// Tall-first rendition order: the canvas fills the phone screen (§15), so
/// the 3:4 cuts are the right shape; square is the fallback for releases that
/// ship nothing tall.
fn master_of(ev: &AmEditorialVideo) -> Option<String> {
    for cut in [
        &ev.motion_detail_tall,
        &ev.motion_tall_video3x4,
        &ev.motion_detail_square,
        &ev.motion_square_video1x1,
    ] {
        if let Some(video) = cut.as_ref().and_then(|m| m.video.as_deref()) {
            if !video.is_empty() {
                return Some(video.to_string());
            }
        }
    }
    None
}

/// Best album for `subject` (the album name): exact match beats containment,
/// the artist must agree, and the artwork must exist.
fn best_album<'a>(
    albums: impl Iterator<Item = &'a AmAlbum>,
    subject: &str,
    artist: &str,
) -> Option<&'a AmAlbum> {
    let mut best: Option<(u8, &'a AmAlbum)> = None;
    for album in albums {
        let Some(attrs) = album.attributes.as_ref() else {
            continue;
        };
        if attrs.editorial_video.is_none()
            || !artist_agrees(attrs.artist_name.as_deref().unwrap_or(""), artist)
        {
            continue;
        }
        let Some(tier) = name_match(attrs.name.as_deref().unwrap_or(""), subject) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((best_tier, _)) => tier > *best_tier,
        };
        if better {
            best = Some((tier, album));
        }
    }
    best.map(|(_, album)| album)
}

fn pick_album_master(json: &serde_json::Value, subject: &str, artist: &str) -> Option<String> {
    let parsed: AmSearchResponse = serde_json::from_value(json.clone()).ok()?;
    let resources = parsed.resources?;
    let album = best_album(resources.albums.values(), subject, artist)?;
    master_of(album.attributes.as_ref()?.editorial_video.as_ref()?)
}

/// Best song when the album tier found nothing: title match (exact beats
/// containment) + artist agreement + the parent album must carry artwork.
/// A caller-provided album hint decides between releases the same track
/// appears on (SimpMusic's demote rule).
fn pick_song_master(
    json: &serde_json::Value,
    title: &str,
    artist: &str,
    album_hint: &str,
) -> Option<String> {
    let parsed: AmSearchResponse = serde_json::from_value(json.clone()).ok()?;
    let resources = parsed.resources?;
    let hint = album_hint.trim();
    let mut best: Option<(u8, u8, &AmAlbum)> = None;
    for song in resources.songs.values() {
        let Some(attrs) = song.attributes.as_ref() else {
            continue;
        };
        if !artist_agrees(attrs.artist_name.as_deref().unwrap_or(""), artist) {
            continue;
        }
        let Some(title_tier) = name_match(attrs.name.as_deref().unwrap_or(""), title) else {
            continue;
        };
        let parent_id = song
            .relationships
            .as_ref()
            .and_then(|rels| rels.albums.as_ref())
            .and_then(|list| list.data.first())
            .map(|reference| reference.id.as_str());
        let Some(parent) = parent_id.and_then(|id| resources.albums.get(id)) else {
            continue;
        };
        let Some(parent_attrs) = parent.attributes.as_ref() else {
            continue;
        };
        if parent_attrs.editorial_video.is_none() {
            continue;
        }
        let hint_tier = if hint.is_empty() {
            0
        } else {
            name_match(parent_attrs.name.as_deref().unwrap_or(""), hint).unwrap_or(0)
        };
        let better = match &best {
            None => true,
            Some((best_title, best_hint, _)) => (title_tier, hint_tier) > (*best_title, *best_hint),
        };
        if better {
            best = Some((title_tier, hint_tier, parent));
        }
    }
    let (_, _, album) = best?;
    master_of(album.attributes.as_ref()?.editorial_video.as_ref()?)
}

// ------------------------------------------------------------- playlists -

#[derive(Debug)]
struct AmVariant {
    width: u32,
    height: u32,
    bandwidth: u64,
    codecs: String,
    uri: String,
}

/// One attribute value out of an m3u8 attribute list. Pieces are comma-
/// separated, so `BANDWIDTH=` cannot accidentally match inside
/// `AVERAGE-BANDWIDTH=` (verified against the real Apple playlists).
fn find_attr<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    for piece in attrs.split(',') {
        let piece = piece.trim();
        if let Some(rest) = piece.strip_prefix(key) {
            return Some(rest.trim_matches('"'));
        }
    }
    None
}

/// HLS master → one entry per AVC video rendition. I-FRAME lines and the
/// HEVC ladders are dropped by construction (no `#EXT-X-STREAM-INF:` prefix
/// on the former, no `avc1` codec on the latter).
fn parse_variants(master: &str) -> Vec<AmVariant> {
    let mut out = Vec::new();
    let mut pending: Option<(u32, u32, u64, String)> = None;
    for line in master.lines() {
        let line = line.trim();
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let (width, height) = find_attr(attrs, "RESOLUTION=")
                .and_then(parse_resolution)
                .unwrap_or((0, 0));
            let bandwidth = find_attr(attrs, "BANDWIDTH=")
                .and_then(|b| b.parse().ok())
                .unwrap_or(0);
            let codecs = find_attr(attrs, "CODECS=").unwrap_or("").to_string();
            pending = Some((width, height, bandwidth, codecs));
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some((width, height, bandwidth, codecs)) = pending.take() {
                out.push(AmVariant {
                    width,
                    height,
                    bandwidth,
                    codecs,
                    uri: line.to_string(),
                });
            }
        }
    }
    out
}

/// `1078x1438` → `(1078, 1438)`. Both axes are required; a malformed line is
/// treated as unknown rather than as a zero-height candidate.
fn parse_resolution(raw: &str) -> Option<(u32, u32)> {
    let (width, height) = raw.split_once(['x', 'X'])?;
    let width = width.trim().parse().ok()?;
    let height = height.trim().parse().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

/// The largest centred 9:16 box inside `width × height`. For Apple's 3:4
/// cuts this keeps the full height and trims the sides; for a square or a
/// landscape source it keeps the full width and trims the top/bottom.
fn crop_9x16(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let width = width as u64;
    let height = height as u64;
    // Compare w/h with 9/16 without floating point: w*16 vs h*9.
    if width * CANVAS_ASPECT_H >= height * CANVAS_ASPECT_W {
        (
            (height * CANVAS_ASPECT_W / CANVAS_ASPECT_H) as u32,
            height as u32,
        )
    } else {
        (
            width as u32,
            (width * CANVAS_ASPECT_H / CANVAS_ASPECT_W) as u32,
        )
    }
}

fn meets_canvas_floor(width: u32, height: u32) -> bool {
    let (w, h) = crop_9x16(width, height);
    w >= AM_MIN_WIDTH && h >= AM_MIN_HEIGHT
}

/// Smallest AVC rendition whose 9:16 crop clears 720×1280; largest crop area
/// when none does. A square ladder therefore still returns its best square.
fn pick_variant(variants: &[AmVariant]) -> Option<&AmVariant> {
    let mut avc: Vec<&AmVariant> = variants
        .iter()
        .filter(|v| v.width > 0 && v.height > 0 && v.codecs.contains("avc1"))
        .collect();
    if avc.is_empty() {
        return None;
    }
    avc.sort_by_key(|v| (v.bandwidth, v.width, v.height));
    if let Some(variant) = avc.iter().find(|v| meets_canvas_floor(v.width, v.height)) {
        return Some(variant);
    }
    avc.into_iter().max_by_key(|v| {
        let (w, h) = crop_9x16(v.width, v.height);
        (u64::from(w) * u64::from(h), v.bandwidth)
    })
}

/// `EXT-X-MAP:URI="…"` — the single media file of a byte-range playlist.
fn parse_map_uri(playlist: &str) -> Option<&str> {
    for line in playlist.lines() {
        if let Some(attrs) = line.trim().strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = find_attr(attrs, "URI=").filter(|uri| !uri.is_empty()) {
                return Some(uri);
            }
        }
    }
    None
}

fn join_uri(base: &str, uri: &str) -> Option<String> {
    url::Url::parse(base)
        .ok()?
        .join(uri)
        .ok()
        .map(|joined| joined.to_string())
}

// ------------------------------------------------------------- resolve -

/// 16 hex chars of FNV-1a over the file URL — the disk-cache id and the relay
/// key. Short on purpose (`check_id` caps ids at 32 alphanumerics).
fn video_id(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

async fn download_video(http: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("animated artwork download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("animated artwork download: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("animated artwork download body failed: {e}"))?;
    if bytes.is_empty() {
        return Err("animated artwork file came back empty".to_string());
    }
    if bytes.len() > AM_MAX_VIDEO_BYTES {
        return Err("animated artwork file is suspiciously large".to_string());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("canvas cache dir: {e}"))?;
    }
    let tmp = dest.with_extension("part");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| format!("animated artwork write failed: {e}"))?;
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("animated artwork promote failed: {e}"))
}

/// The full Apple round trip for one lookup. `Err` ⇒ retryable, not cached;
/// `Ok(None)` ⇒ an honest miss, cached.
async fn resolve_canvas(
    state: &CanvasState,
    app: &crate::proxy::AppState,
    title: &str,
    artist: &str,
    album: &str,
) -> Result<Option<String>, String> {
    // Tier 1: the album the track belongs to (only when the caller knows it).
    let mut master: Option<String> = None;
    if !album.trim().is_empty() {
        let query = clean_query(&format!("{album} {artist}"));
        let json = am_search(state, AmKind::Albums, &query).await?;
        master = pick_album_master(&json, album, artist);
    }
    // Tier 2: the track itself; its parent album decides between releases.
    if master.is_none() {
        let query = clean_query(&format!("{title} {artist}"));
        let json = am_search(state, AmKind::Songs, &query).await?;
        master = pick_song_master(&json, title, artist, album);
    }
    let Some(master) = master else {
        return Ok(None);
    };

    // Ladder: master → smallest rendition whose 9:16 crop is ≥720×1280 →
    // its one file. The renderer publishes the crop box it actually got.
    let master_txt = fetch_text(&state.http, &master).await?;
    let variants = parse_variants(&master_txt);
    let chosen = pick_variant(&variants)
        .ok_or_else(|| "no usable rendition in the animated artwork".to_string())?;
    let variant_url = join_uri(&master, &chosen.uri)
        .ok_or_else(|| "rendition URL did not resolve".to_string())?;
    let variant_txt = fetch_text(&state.http, &variant_url).await?;
    let file_uri = parse_map_uri(&variant_txt)
        .ok_or_else(|| "no media file in the rendition playlist".to_string())?;
    let file_url = join_uri(&variant_url, file_uri)
        .ok_or_else(|| "media file URL did not resolve".to_string())?;

    // Download once; the relay serves it off the disk cache from then on.
    let id = video_id(&file_url);
    let path = app.disk.canvas_path(&id);
    if tokio::fs::metadata(&path).await.is_err() {
        download_video(&state.http, &file_url, &path).await?;
    }
    Ok(Some(format!(
        "http://127.0.0.1:{}/canvas?id={}&token={}",
        app.port, id, app.session_token
    )))
}

// ------------------------------------------------------------- commands -

/// Resolve the looping video behind the current track. `title`/`artist` are
/// the keys; `album` and `isrc` are optional hints (isrc is kept for the R2
/// Spotify source and unused today). Never fatal: every answer is `Ok`.
#[tauri::command]
pub async fn fetch_canvas(
    state: tauri::State<'_, CanvasState>,
    app: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
    title: String,
    artist: String,
    album: Option<String>,
    isrc: Option<String>,
) -> Result<Canvas, String> {
    let _ = isrc; // R2 hook — docs/spotify-android-canvas.md §14.1.
    let album = album.unwrap_or_default();
    if title.trim().is_empty() && artist.trim().is_empty() {
        return Ok(Canvas { url: None });
    }
    let key = format!(
        "{}|{}|{}",
        title.trim().to_lowercase(),
        artist.trim().to_lowercase(),
        album.trim().to_lowercase()
    );
    let state: &CanvasState = &state;
    let app: &crate::proxy::AppState = &app;
    let url = state
        .cache
        .try_get_with(key, resolve_canvas(state, app, &title, &artist, &album))
        .await
        .map_err(|e| (*e).clone())?;
    Ok(Canvas { url })
}

/// Store / clear the `sp_dc` cookie. Empty string clears it.
#[tauri::command]
pub fn set_canvas_cookie(
    app: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
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
pub fn canvas_configured(app: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>) -> bool {
    app.store()
        .ok()
        .and_then(|s| s.kv_get(SPDC_KEY).ok().flatten())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

// ------------------------------------------------------------- tests -

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = r#"#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-I-FRAME-STREAM-INF:AVERAGE-BANDWIDTH=419611,BANDWIDTH=503700,VIDEO-RANGE=SDR,CODECS="avc1.64001f",RESOLUTION=486x486,URI="iframe.m3u8"
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2125654,_AVG-BANDWIDTH=2125654,BANDWIDTH=2499558,CODECS="avc1.64001f",RESOLUTION=768x768
v768.m3u8
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1859556,BANDWIDTH=2118342,CODECS="hvc1.2.20000000.L123.B0",RESOLUTION=768x768
v768hevc.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=298911,CODECS="avc1.64001f",RESOLUTION=360x360
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=560111,CODECS="avc1.64001f",RESOLUTION=456x456
v456.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=801112,CODECS="avc1.64001f",RESOLUTION=486x486
v486.m3u8
"#;

    const VARIANT: &str = r#"#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="P359476169_Anull_video_gr210_sdr_486x486-.mp4",BYTERANGE="897@0"
#EXTINF:4.56667,
#EXT-X-BYTERANGE:101066@897
P359476169_Anull_video_gr210_sdr_486x486-.mp4
#EXT-X-ENDLIST
"#;

    fn encode(s: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
    }

    #[test]
    fn finds_the_web_player_bundle() {
        let home = r#"<html><script type="module" crossorigin src="/assets/index~bc39edf62f.js"></script></html>"#;
        assert_eq!(find_bundle_path(home), Some("/assets/index~bc39edf62f.js"));
        assert_eq!(find_bundle_path("<html>no bundle here</html>"), None);
    }

    #[test]
    fn prefers_the_amp_web_play_jwt() {
        let header = "eyJhbGciOiJFUzI1NiJ9";
        let other = format!(
            "{header}.{}.{}",
            encode(r#"{"iss":"OtherService","exp":1}"#),
            encode("sig1")
        );
        let amp = format!(
            "{header}.{}.{}",
            encode(r#"{"iss":"AMPWebPlay","exp":2}"#),
            encode("sig2")
        );
        let bundle = format!("var a=\"{other}\";var b=\"{amp}\";");
        assert_eq!(find_amp_jwt(&bundle).as_deref(), Some(amp.as_str()));
    }

    #[test]
    fn falls_back_to_the_first_scraped_jwt() {
        let header = "eyJhbGciOiJFUzI1NiJ9";
        let only = format!(
            "{header}.{}.{}",
            encode(r#"{"iss":"MapsWeb"}"#),
            encode("sig")
        );
        let bundle = format!("x {only} y");
        assert_eq!(find_amp_jwt(&bundle).as_deref(), Some(only.as_str()));
        assert_eq!(find_amp_jwt("nothing here"), None);
    }

    #[test]
    fn name_matching_prefers_exact_but_allows_containment() {
        assert_eq!(name_match("After Hours", "after hours"), Some(2));
        assert_eq!(name_match("After Hours (Deluxe)", "After Hours"), Some(1));
        assert_eq!(name_match("Dawn FM", "After Hours"), None);
        // "Ani" is inside "Animal", but a 3-char subject must not match.
        assert_eq!(name_match("Animal", "Ani"), None);
    }

    #[test]
    fn artists_agree_on_overlap() {
        assert!(artist_agrees("Arijit Singh", "Arijit Singh, Mithoon"));
        assert!(artist_agrees("coldplay", "Coldplay"));
        assert!(!artist_agrees("Pritam", "Arijit Singh"));
        assert!(artist_agrees("Whoever", ""));
    }

    #[test]
    fn queries_drop_brackets_and_feat_tokens() {
        assert_eq!(
            clean_query("Kesariya (From \"Brahmastra\") - Single"),
            "Kesariya - Single"
        );
        assert_eq!(
            clean_query("Tum Hi Ho feat. Arijit Singh"),
            "Tum Hi Ho Arijit Singh"
        );
        assert_eq!(clean_query("[Live] Coldplay"), "Coldplay");
    }

    #[test]
    fn attribute_scan_does_not_confuse_average_bandwidth() {
        let attrs = "AVERAGE-BANDWIDTH=2125654,_AVG-BANDWIDTH=2125654,BANDWIDTH=2499558,CODECS=\"avc1.64001f\",RESOLUTION=768x768";
        assert_eq!(find_attr(attrs, "BANDWIDTH="), Some("2499558"));
        assert_eq!(find_attr(attrs, "RESOLUTION="), Some("768x768"));
        assert_eq!(find_attr(attrs, "CODECS="), Some("avc1.64001f"));
    }

    #[test]
    fn rendition_pick_is_smallest_large_enough_avc() {
        let variants = parse_variants(MASTER);
        assert_eq!(variants.len(), 5);
        assert!(variants.iter().all(|v| !v.uri.contains("iframe")));
        // A square ladder cannot meet a 9:16 720×1280 floor; the picker still
        // returns the variant with the largest crop area so the renderer has
        // something to present.
        assert_eq!(
            pick_variant(&variants).map(|v| v.uri.as_str()),
            Some("v768.m3u8")
        );
        assert_eq!(pick_variant(&[]).map(|v| v.uri.as_str()), None);
    }

    const TALL_MASTER: &str = r#"#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.64001f",RESOLUTION=310x414
v310.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.64001f",RESOLUTION=554x738
v554.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001f",RESOLUTION=830x1106
v830.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f",RESOLUTION=1078x1438
v1078.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64001f",RESOLUTION=1080x1440
v1080.m3u8
"#;

    #[test]
    fn rendition_pick_meets_the_canvas_9x16_floor() {
        let variants = parse_variants(TALL_MASTER);
        assert_eq!(variants.len(), 5);
        assert_eq!(crop_9x16(310, 414), (232, 414));
        assert_eq!(crop_9x16(830, 1106), (622, 1106));
        assert!(
            !meets_canvas_floor(830, 1106),
            "830-wide tall cut must fail the 720-wide crop floor"
        );
        assert_eq!(crop_9x16(1078, 1438), (808, 1438));
        assert!(meets_canvas_floor(1078, 1438));
        assert_eq!(crop_9x16(1080, 1440), (810, 1440));
        assert!(meets_canvas_floor(1080, 1440));
        // 1078×1438 is the smallest bandwidth that clears the floor, so the
        // 24.9 MB 1080×1440 cut is never chosen for this ladder.
        assert_eq!(
            pick_variant(&variants).map(|v| v.uri.as_str()),
            Some("v1078.m3u8")
        );
    }

    #[test]
    fn resolution_parsing_and_crop_math() {
        assert_eq!(parse_resolution("1078x1438"), Some((1078, 1438)));
        assert_eq!(parse_resolution(" 720 X 1280 "), Some((720, 1280)));
        assert_eq!(parse_resolution("768"), None);
        assert_eq!(parse_resolution("0x1280"), None);
        assert_eq!(crop_9x16(768, 768), (432, 768));
        assert_eq!(crop_9x16(1920, 1080), (607, 1080));
        assert_eq!(crop_9x16(720, 1280), (720, 1280));
        assert_eq!(crop_9x16(0, 0), (0, 0));
        assert!(!meets_canvas_floor(768, 768));
        assert!(!meets_canvas_floor(1920, 1080));
        assert!(meets_canvas_floor(720, 1280));
    }

    #[test]
    fn ext_x_map_and_uri_join() {
        assert_eq!(
            parse_map_uri(VARIANT),
            Some("P359476169_Anull_video_gr210_sdr_486x486-.mp4")
        );
        let master = "https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/71/98/05/x.m3u8";
        let variant = join_uri(master, "v486.m3u8").unwrap();
        assert_eq!(
            variant,
            "https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/71/98/05/v486.m3u8"
        );
        let file = join_uri(&variant, "P359-.mp4").unwrap();
        assert_eq!(
            file,
            "https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/71/98/05/P359-.mp4"
        );
    }

    #[test]
    fn album_pick_requires_artwork_and_artist_agreement() {
        let json = serde_json::json!({
            "resources": {
                "albums": {
                    "1": {"attributes": {"name": "After Hours", "artistName": "The Weeknd",
                          "editorialVideo": {"motionDetailTall": {"video": "https://m/tall.m3u8"}}}},
                    "2": {"attributes": {"name": "After Hours (Deluxe)", "artistName": "The Weeknd",
                          "editorialVideo": {"motionDetailSquare": {"video": "https://m/sq.m3u8"}}}},
                    "3": {"attributes": {"name": "After Hours", "artistName": "A Cover Band"}},
                    "4": {"attributes": {"name": "Dawn FM", "artistName": "The Weeknd",
                          "editorialVideo": {"motionDetailSquare": {"video": "https://m/dawn.m3u8"}}}}
                }
            }
        });
        // Exact name (tier 2) beats the deluxe containment (tier 1), even
        // though the deluxe ships the square cut; album 3 has no artwork.
        assert_eq!(
            pick_album_master(&json, "After Hours", "The Weeknd").as_deref(),
            Some("https://m/tall.m3u8")
        );
        assert_eq!(
            pick_album_master(&json, "Entirely Different", "The Weeknd"),
            None
        );
    }

    #[test]
    fn song_pick_uses_the_parent_album() {
        let json = serde_json::json!({
            "resources": {
                "songs": {
                    "s1": {"attributes": {"name": "Kesariya", "artistName": "Arijit Singh"},
                           "relationships": {"albums": {"data": [{"id": "a1"}]}}},
                    "s2": {"attributes": {"name": "Kesariya", "artistName": "Arijit Singh"},
                           "relationships": {"albums": {"data": [{"id": "a2"}]}}},
                    "s3": {"attributes": {"name": "Kesariya", "artistName": "Pritam"},
                           "relationships": {"albums": {"data": [{"id": "a2"}]}}}
                },
                "albums": {
                    "a1": {"attributes": {"name": "Kesariya (From \"Brahmastra\") - Single"}},
                    "a2": {"attributes": {"name": "Brahmastra",
                           "editorialVideo": {"motionDetailSquare": {"video": "https://m/b.m3u8"}}}}
                }
            }
        });
        // s1's parent has no artwork; s3's artist disagrees; s2 carries it.
        assert_eq!(
            pick_song_master(&json, "Kesariya", "Arijit Singh", "Brahmastra").as_deref(),
            Some("https://m/b.m3u8")
        );
        assert_eq!(
            pick_song_master(&json, "Kesariya", "Nobody At All", "Brahmastra"),
            None
        );
    }

    #[test]
    fn song_pick_demotes_an_album_hint_mismatch() {
        let json = serde_json::json!({
            "resources": {
                "songs": {
                    "s1": {"attributes": {"name": "Tum Kya Mile", "artistName": "Arijit Singh"},
                           "relationships": {"albums": {"data": [{"id": "wrong"}]}}},
                    "s2": {"attributes": {"name": "Tum Kya Mile", "artistName": "Arijit Singh"},
                           "relationships": {"albums": {"data": [{"id": "right"}]}}}
                },
                "albums": {
                    "wrong": {"attributes": {"name": "Compilation A",
                             "editorialVideo": {"motionDetailSquare": {"video": "https://m/wrong.m3u8"}}}},
                    "right": {"attributes": {"name": "Rocky Aur Rani Kii Prem Kahaani",
                             "editorialVideo": {"motionDetailSquare": {"video": "https://m/right.m3u8"}}}}
                }
            }
        });
        assert_eq!(
            pick_song_master(
                &json,
                "Tum Kya Mile",
                "Arijit Singh",
                "Rocky Aur Rani Kii Prem Kahaani"
            )
            .as_deref(),
            Some("https://m/right.m3u8")
        );
    }

    #[test]
    fn tall_cuts_are_preferred_for_full_bleed() {
        let square = || {
            Some(AmMotionVideo {
                video: Some("https://m/sq.m3u8".to_string()),
            })
        };
        let tall = || {
            Some(AmMotionVideo {
                video: Some("https://m/tall.m3u8".to_string()),
            })
        };
        // Both shapes ship: the tall cut is the full-bleed canvas.
        let ev = AmEditorialVideo {
            motion_detail_square: square(),
            motion_square_video1x1: None,
            motion_detail_tall: tall(),
            motion_tall_video3x4: None,
        };
        assert_eq!(master_of(&ev).as_deref(), Some("https://m/tall.m3u8"));
        // The 3:4 cut also outranks the square when it is all the release has.
        let ev = AmEditorialVideo {
            motion_detail_square: square(),
            motion_square_video1x1: None,
            motion_detail_tall: None,
            motion_tall_video3x4: tall(),
        };
        assert_eq!(master_of(&ev).as_deref(), Some("https://m/tall.m3u8"));
        // Nothing tall: square is still the fallback.
        let ev = AmEditorialVideo {
            motion_detail_square: square(),
            motion_square_video1x1: None,
            motion_detail_tall: None,
            motion_tall_video3x4: None,
        };
        assert_eq!(master_of(&ev).as_deref(), Some("https://m/sq.m3u8"));
    }

    #[test]
    fn video_ids_are_stable_hex() {
        let a = video_id("https://example.com/a.mp4");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, video_id("https://example.com/a.mp4"));
        assert_ne!(a, video_id("https://example.com/b.mp4"));
    }
}
