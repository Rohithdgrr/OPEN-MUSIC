//! video.rs — InnerTube transport for the Now Playing backdrop.
//!
//! Spec: `docs/song-video.md` §8, §15, §17. Scope is deliberately narrow:
//! this module does the two POSTs, reads the responses mechanically, remembers
//! the resolved byte URL, and mints the loopback relay URL.
//!
//! **No decision lives here.** Which candidate is *the* song, which itag is
//! acceptable, and whether a miss gets cached are all decided by
//! `app/src/videomatch.js` (§16.2) — Rust only forwards what the search and
//! player endpoints actually returned, so the matcher exists in one language.
//!
//! The returned shapes are camelCase because their only consumer is the
//! WebView module, which already declares those field names.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Protocol facts (§2, §16.1) ─────────────────────────────────────────────

pub const SEARCH_URL: &str = "https://music.youtube.com/youtubei/v1/search";
pub const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player";
const WEB_REMIX_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const WEB_REMIX_VERSION: &str = "1.20250219.01.00";
/// Song-only search filter — the url-encoded `EgWKAQIIAWoKEAkQBRAKEAMQBA==`.
const SONGS_FILTER: &str = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";
const IOS_KEY: &str = "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc";
const IOS_VERSION: &str = "20.10.4";
const IOS_UA: &str =
    "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const WEB_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// §4: a resolved byte URL is short-lived; the match identity is not.
const URL_TTL: Duration = Duration::from_secs(30 * 60);
/// Video id learned from a plan, so the relay can re-resolve after expiry.
const KNOWN_TTL: Duration = Duration::from_secs(6 * 60 * 60);

// ── DTOs ───────────────────────────────────────────────────────────────────

/// One search row, shaped exactly like `videomatch.js::rowFromRenderer`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub video_id: String,
    pub title: String,
    pub credit: String,
    pub parts: Vec<String>,
    pub album: String,
    pub duration_secs: u32,
    pub plays: u64,
    pub channel: String,
}

/// One adaptive format, shaped like `videomatch.js::playerFormats`'s output.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub itag: u32,
    pub mime_type: String,
    pub url: String,
    pub has_cipher: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub size_bytes: u64,
    pub quality: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playability {
    pub status: String,
    pub reason: String,
    pub video_id: String,
    pub title: String,
    pub length_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub playability: Playability,
    pub formats: Vec<Format>,
}

/// What the relay holds for one `track|itag` pair.
#[derive(Clone, Debug)]
pub struct PreparedVideo {
    pub video_id: String,
    pub url: String,
}

#[derive(Default)]
pub struct VideoMeters {
    searches: AtomicU64,
    players: AtomicU64,
    relay_hits: AtomicU64,
    relay_resolves: AtomicU64,
    errors: AtomicU64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStats {
    pub searches: u64,
    pub players: u64,
    pub relay_hits: u64,
    pub relay_resolves: u64,
    pub errors: u64,
    pub prepared: u64,
    pub known: u64,
}

impl VideoMeters {
    fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// Transport caches. Lives inside `AppState` so the axum relay can read it.
pub struct VideoCache {
    /// `"{track_id}|{itag}"` → resolved byte URL (30 min, §4 L1).
    pub prepared: moka::future::Cache<String, PreparedVideo>,
    /// `track_id` → video id (6 h), so the relay can self-heal an expired URL.
    pub known: moka::future::Cache<String, String>,
    pub meters: VideoMeters,
}

impl VideoCache {
    pub fn new() -> Self {
        Self {
            prepared: moka::future::Cache::builder()
                .max_capacity(400)
                .time_to_live(URL_TTL)
                .build(),
            known: moka::future::Cache::builder()
                .max_capacity(400)
                .time_to_live(KNOWN_TTL)
                .build(),
            meters: VideoMeters::default(),
        }
    }

    pub fn note_search(&self) {
        VideoMeters::bump(&self.meters.searches);
    }

    pub fn note_player(&self) {
        VideoMeters::bump(&self.meters.players);
    }

    pub fn note_relay_hit(&self) {
        VideoMeters::bump(&self.meters.relay_hits);
    }

    pub fn note_relay_resolve(&self) {
        VideoMeters::bump(&self.meters.relay_resolves);
    }

    pub fn note_error(&self) {
        VideoMeters::bump(&self.meters.errors);
    }

    pub fn stats(&self) -> VideoStats {
        VideoStats {
            searches: self.meters.searches.load(Ordering::Relaxed),
            players: self.meters.players.load(Ordering::Relaxed),
            relay_hits: self.meters.relay_hits.load(Ordering::Relaxed),
            relay_resolves: self.meters.relay_resolves.load(Ordering::Relaxed),
            errors: self.meters.errors.load(Ordering::Relaxed),
            prepared: self.prepared.entry_count(),
            known: self.known.entry_count(),
        }
    }
}

impl Default for VideoCache {
    fn default() -> Self {
        Self::new()
    }
}

// ── Request bodies (identical to the P0-verified probe) ────────────────────

pub fn search_body(query: &str) -> Value {
    json!({
        "context": { "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": WEB_REMIX_VERSION,
            "hl": "en",
            "gl": "US",
        }},
        "query": query,
        "params": SONGS_FILTER,
    })
}

pub fn player_body(video_id: &str) -> Value {
    json!({
        "context": { "client": {
            "clientName": "IOS",
            "clientVersion": IOS_VERSION,
            "deviceMake": "Apple",
            "deviceModel": "iPhone16,2",
            "osName": "iPhone",
            "osVersion": "18.3.2.22D82",
            "hl": "en",
            "gl": "US",
        }},
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    })
}

// ── Response parsing (mechanical; mirrors videomatch.js) ──────────────────

fn runs_text(text: &Value) -> String {
    if let Some(runs) = text.get("runs").and_then(Value::as_array) {
        return runs
            .iter()
            .map(|r| r.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<String>();
    }
    text.get("simpleText")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn find_video_id(node: &Value, depth: usize) -> String {
    if depth > 8 {
        return String::new();
    }
    match node {
        Value::Object(map) => {
            if let Some(id) = map.get("videoId").and_then(Value::as_str) {
                if !id.is_empty() {
                    return id.to_string();
                }
            }
            for (key, value) in map {
                // A watchEndpoint carries the *parent* item's id in some
                // layouts; the renderer's own fields win (JS parity).
                if key == "watchEndpoint" || key == "watchPlaylistEndpoint" {
                    continue;
                }
                let found = find_video_id(value, depth + 1);
                if !found.is_empty() {
                    return found;
                }
            }
            String::new()
        }
        Value::Array(items) => items
            .iter()
            .map(|item| find_video_id(item, depth + 1))
            .find(|id| !id.is_empty())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn collect_rows<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    match node {
        Value::Object(map) => {
            if let Some(row) = map.get("musicResponsiveListItemRenderer") {
                out.push(row);
                return; // its children are the same row
            }
            for value in map.values() {
                collect_rows(value, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_rows(item, out);
            }
        }
        _ => {}
    }
}

fn parse_duration(text: &str) -> u32 {
    let parts: Vec<&str> = text.trim().split(':').collect();
    let nums: Option<Vec<u32>> = parts.iter().map(|p| p.parse::<u32>().ok()).collect();
    let Some(nums) = nums else { return 0 };
    match nums.len() {
        2 => nums[0] * 60 + nums[1],
        3 => nums[0] * 3600 + nums[1] * 60 + nums[2],
        _ => 0,
    }
}

fn parse_play_count(text: &str) -> u64 {
    let s = text.to_ascii_lowercase().replace(',', "");
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let Ok(num) = s[start..i].parse::<f64>() else {
                return 0;
            };
            let mult = match bytes.get(i) {
                Some(b'k') => 1e3,
                Some(b'm') => 1e6,
                Some(b'b') => 1e9,
                _ => 1.0,
            };
            return (num * mult).round() as u64;
        }
        i += 1;
    }
    0
}

/// Split a padded credit line into names. `feat.`/`ft.` count as separators,
/// same as `videomatch.js::creditParts`.
pub fn credit_parts(value: &str) -> Vec<String> {
    let cleaned = value
        .replace("feat.", ",")
        .replace("feat ", ",")
        .replace("ft.", ",")
        .replace(" ft ", ", ");
    cleaned
        .split([',', '&'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// Lowercase, drop bracket groups, keep alphanumerics — the "is this the same
/// name" normalisation from `videomatch.js::sameName`.
fn name_key(value: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    for ch in value.to_lowercase().chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 && ch.is_alphanumeric() => out.push(ch),
            _ if depth == 0 => out.push(' '),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_name(a: &str, b: &str) -> bool {
    let x = name_key(a);
    !x.is_empty() && x == name_key(b)
}

/// One search row → candidate (`videomatch.js::rowFromRenderer`).
pub fn row_from_renderer(row: &Value) -> Option<Candidate> {
    let cols: Vec<String> = row
        .get("flexColumns")
        .and_then(Value::as_array)
        .map(|cols| {
            cols.iter()
                .map(|c| {
                    runs_text(
                        c.pointer("/musicResponsiveListItemFlexColumnRenderer/text")
                            .unwrap_or(&Value::Null),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let title = cols.first().map(|s| s.trim().to_string()).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    // Column 1 carries artist/album/duration and column 2 the play count
    // (measured, §13.2); older fixtures put everything in column 1. Joining
    // every column after the title reads both layouts.
    let detail = cols
        .iter()
        .skip(1)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" • ");
    let mut duration_secs = 0u32;
    let mut plays = 0u64;
    let mut credit: Vec<String> = Vec::new();
    for piece in detail.split('•').map(str::trim).filter(|p| !p.is_empty()) {
        if duration_secs == 0 && parse_duration(piece) > 0 && piece.contains(':') {
            duration_secs = parse_duration(piece);
            continue;
        }
        if plays == 0 && piece.to_ascii_lowercase().contains("play") {
            plays = parse_play_count(piece);
            continue;
        }
        credit.push(piece.to_string());
    }
    let video_id = row
        .pointer("/playlistItemData/videoId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| find_video_id(row, 0));
    if video_id.is_empty() {
        return None;
    }
    let meaningful: Vec<String> = credit
        .into_iter()
        .filter(|p| !same_name(p, &title))
        .collect();
    let credit_text = meaningful.join(", ");
    let album = if meaningful.len() > 1 {
        meaningful.last().cloned().unwrap_or_default()
    } else {
        String::new()
    };
    Some(Candidate {
        video_id,
        title,
        parts: credit_parts(&credit_text),
        credit: credit_text,
        album,
        duration_secs,
        plays,
        channel: String::new(),
    })
}

/// Whole search response → candidates, de-duplicated by video id. Walks for
/// the row renderer instead of pinning a fixed path (§16.2 #6).
pub fn parse_search_rows(json: &Value) -> Vec<Candidate> {
    let mut rows = Vec::new();
    collect_rows(json, &mut rows);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(cand) = row_from_renderer(row) {
            if seen.insert(cand.video_id.clone()) {
                out.push(cand);
            }
        }
    }
    out
}

/// Player response → normalized adaptive formats (`videomatch.js::playerFormats`).
pub fn normalize_formats(json: &Value) -> Vec<Format> {
    let list = json
        .pointer("/streamingData/adaptiveFormats")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    list.iter()
        .filter_map(|f| {
            let itag = f.get("itag").and_then(Value::as_u64).unwrap_or(0) as u32;
            let mime_type = f.get("mimeType").and_then(Value::as_str).unwrap_or("").to_string();
            if itag == 0 || mime_type.is_empty() {
                return None;
            }
            let url = f.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let has_cipher = url.is_empty()
                && (f.get("signatureCipher").is_some() || f.get("cipher").is_some());
            Some(Format {
                itag,
                mime_type,
                url,
                has_cipher,
                width: f.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
                height: f.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
                fps: f.get("fps").and_then(Value::as_u64).unwrap_or(0) as u32,
                size_bytes: f
                    .get("contentLength")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0),
                quality: f
                    .get("qualityLabel")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Playability + identity (`videomatch.js::playability`).
pub fn playability(json: &Value) -> Playability {
    let status = json
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_string();
    Playability {
        status,
        reason: json
            .pointer("/playabilityStatus/reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        video_id: json
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        title: json
            .pointer("/videoDetails/title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        length_seconds: json
            .pointer("/videoDetails/lengthSeconds")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0),
    }
}

/// `formats` → the byte URL for `itag`, when it is progressive and plain.
pub fn format_url(formats: &[Format], itag: u32) -> Option<String> {
    formats
        .iter()
        .find(|f| f.itag == itag && !f.url.is_empty() && !f.has_cipher)
        .map(|f| f.url.clone())
}

// ── Host guard (§8.2) ─────────────────────────────────────────────────────

/// The only hosts the video relay may fetch: YouTube's media CDN. Everything
/// else — including the loopback itself — is refused, the same SSRF rule the
/// art/stream relays already apply.
pub fn video_host_ok(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|e| format!("invalid video url: {e}"))?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err(format!("video url must be http(s): {raw}"));
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err("video url missing host".into());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if ip.is_loopback()
            || ip.is_unspecified()
            || match ip {
                std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_broadcast(),
                std::net::IpAddr::V6(v6) => v6.is_unique_local() || v6.is_unicast_link_local(),
            }
        {
            return Err(format!("video host not allowed: {host}"));
        }
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(format!("video host not allowed: {host}"));
    }
    if host != "googlevideo.com" && !host.ends_with(".googlevideo.com") {
        return Err(format!("video host not allowed: {host}"));
    }
    Ok(u)
}

// ── Transport ──────────────────────────────────────────────────────────────

/// One POST with a single calm retry on transport failure / 5xx / 429
/// (§8.3 — never a retry loop). The body is re-cloned per attempt.
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    user_agent: &str,
    body: &Value,
) -> Result<Value, String> {
    let mut last = String::new();
    for attempt in 0..2 {
        let resp = client
            .post(url)
            .query(&[("key", key), ("prettyPrint", "false")])
            .header(reqwest::header::USER_AGENT, user_agent)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(body)
            .send()
            .await;
        match resp {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp
                        .json::<Value>()
                        .await
                        .map_err(|e| format!("video response was not JSON: {e}"));
                }
                last = format!("upstream {status}");
                let retryable =
                    status.as_u16() == 429 || status.as_u16() >= 500;
                if !retryable || attempt == 1 {
                    return Err(last);
                }
            }
            Err(e) => {
                last = format!("upstream failed: {e}");
                if attempt == 1 {
                    return Err(last);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    Err(last)
}

/// POST the WEB_REMIX search and return the rows the matcher needs.
pub async fn search(client: &reqwest::Client, query: &str) -> Result<Vec<Candidate>, String> {
    let json = post_json(
        client,
        SEARCH_URL,
        WEB_REMIX_KEY,
        WEB_UA,
        &search_body(query),
    )
    .await?;
    Ok(parse_search_rows(&json))
}

/// POST the iOS player and return playability + progressive formats.
pub async fn player(client: &reqwest::Client, video_id: &str) -> Result<PlayerInfo, String> {
    let json = post_json(
        client,
        PLAYER_URL,
        IOS_KEY,
        IOS_UA,
        &player_body(video_id),
    )
    .await?;
    Ok(PlayerInfo {
        playability: playability(&json),
        formats: normalize_formats(&json),
    })
}

/// Re-resolve a byte URL for `(video_id, itag)` — used by `video_relay` when
/// the caller supplies no URL and by the relay after a 403/410.
pub async fn resolve_format_url(
    client: &reqwest::Client,
    video_id: &str,
    itag: u32,
) -> Result<String, String> {
    let info = player(client, video_id).await?;
    if info.playability.status != "OK" {
        return Err(format!(
            "video unavailable: {} {}",
            info.playability.status, info.playability.reason
        ));
    }
    format_url(&info.formats, itag).ok_or_else(|| format!("video has no plain rendition {itag}"))
}

// ── IPC commands (§8.1) ────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayUrl {
    pub url: String,
    pub itag: u32,
}

fn check_track_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("track id 1..64 chars".into());
    }
    Ok(())
}

fn check_video_id(id: &str) -> Result<(), String> {
    if id.len() < 6
        || id.len() > 32
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid video id: {id}"));
    }
    Ok(())
}

/// Search YouTube Music for candidates. Returns the *rows*, not a verdict —
/// ranking and the accept/reject bar live in `videomatch.js` (§16.2 #1).
#[tauri::command]
pub async fn video_search(
    query: String,
    state: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
) -> Result<Vec<Candidate>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("query is empty".into());
    }
    let q: String = q.chars().take(200).collect();
    state.video.note_search();
    match search(&state.client, &q).await {
        Ok(rows) => Ok(rows),
        Err(e) => {
            state.video.note_error();
            Err(e)
        }
    }
}

/// Player handshake for one candidate: playability + progressive renditions.
#[tauri::command]
pub async fn video_player(
    video_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
) -> Result<PlayerInfo, String> {
    check_video_id(&video_id)?;
    state.video.note_player();
    match player(&state.client, &video_id).await {
        Ok(info) => Ok(info),
        Err(e) => {
            state.video.note_error();
            Err(e)
        }
    }
}

/// Remember the chosen rendition and mint the loopback URL the WebView loads.
/// `url` comes from the `video_player` answer; it is re-validated here so a
/// caller can never point the relay outside the media CDN.
#[tauri::command]
pub async fn video_relay(
    track_id: String,
    video_id: String,
    itag: u32,
    url: Option<String>,
    state: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
) -> Result<RelayUrl, String> {
    check_track_id(&track_id)?;
    check_video_id(&video_id)?;
    let url = match url.filter(|u| !u.trim().is_empty()) {
        Some(u) => {
            video_host_ok(&u)?;
            u
        }
        None => match resolve_format_url(&state.client, &video_id, itag).await {
            Ok(u) => u,
            Err(e) => {
                state.video.note_error();
                return Err(e);
            }
        },
    };
    state.video.known.insert(track_id.clone(), video_id.clone()).await;
    state
        .video
        .prepared
        .insert(
            format!("{track_id}|{itag}"),
            PreparedVideo {
                video_id,
                url,
            },
        )
        .await;
    Ok(RelayUrl {
        url: crate::proxy::video_url_for(state.port, &track_id, itag, &state.session_token),
        itag,
    })
}

/// Transport scoreboard for diagnostics (`_verify` / probe scripts).
#[tauri::command]
pub async fn video_stats(
    state: tauri::State<'_, std::sync::Arc<crate::proxy::AppState>>,
) -> Result<VideoStats, String> {
    Ok(state.video.stats())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(text: &str) -> Value {
        json!({ "runs": [{ "text": text }] })
    }

    /// The measured row from docs/song-video.md §13.2, trimmed to the fields
    /// the parser reads.
    fn kesariya_row() -> Value {
        json!({
            "musicResponsiveListItemRenderer": {
                "playlistItemData": { "videoId": "NJAv_7lHUIU" },
                "flexColumns": [
                    { "musicResponsiveListItemFlexColumnRenderer": {
                        "text": run("Kesariya (From \"Brahmastra\")")
                    }},
                    { "musicResponsiveListItemFlexColumnRenderer": {
                        "text": run("Arijit Singh • Kesariya (From \"Brahmastra\") • 4:29")
                    }},
                    { "musicResponsiveListItemFlexColumnRenderer": {
                        "text": run("973M plays")
                    }}
                ]
            }
        })
    }

    #[test]
    fn parses_a_real_search_row_into_the_js_candidate_shape() {
        let json = kesariya_row();
        let mut rows = Vec::new();
        collect_rows(&json, &mut rows);
        let cand = row_from_renderer(rows[0]).expect("row parses");
        assert_eq!(cand.video_id, "NJAv_7lHUIU");
        assert_eq!(cand.title, "Kesariya (From \"Brahmastra\")");
        assert_eq!(cand.duration_secs, 269);
        assert_eq!(cand.plays, 973_000_000);
        // The song name echoed into the credit line is not an album (§16.2 #5).
        assert_eq!(cand.album, "");
        assert_eq!(cand.parts, vec!["Arijit Singh".to_string()]);
    }

    #[test]
    fn finds_rows_under_an_unfamiliar_layout() {
        // The walker must not depend on contents.tabbedSearchResultsRenderer: a
        // layout shuffle that yielded zero rows would negative-cache every track.
        let json = json!({
            "weird": { "wrapper": [ { "shelf": { "items": [kesariya_row()] } } ] }
        });
        let rows = parse_search_rows(&json);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].video_id, "NJAv_7lHUIU");
    }

    #[test]
    fn duplicate_video_ids_collapse() {
        let json = json!({ "items": [kesariya_row(), kesariya_row()] });
        assert_eq!(parse_search_rows(&json).len(), 1);
    }

    #[test]
    fn formats_are_normalized_and_ciphered_rows_flagged() {
        let json = json!({ "streamingData": { "adaptiveFormats": [
            { "itag": 136, "mimeType": "video/mp4; codecs=\"avc1\"", "url": "https://r1.googlevideo.com/videoplayback?x=1",
              "width": 720, "height": 720, "fps": 30, "contentLength": "1814821", "qualityLabel": "720p" },
            { "itag": 137, "mimeType": "video/mp4; codecs=\"avc1\"", "signatureCipher": "s=abc" },
            { "itag": 0, "mimeType": "" }
        ]}});
        let formats = normalize_formats(&json);
        assert_eq!(formats.len(), 2);
        assert_eq!(formats[0].itag, 136);
        assert_eq!(formats[0].height, 720);
        assert_eq!(formats[0].size_bytes, 1_814_821);
        assert!(!formats[0].has_cipher);
        assert!(formats[1].has_cipher);
        assert_eq!(format_url(&formats, 136).as_deref(), Some("https://r1.googlevideo.com/videoplayback?x=1"));
        assert_eq!(format_url(&formats, 137), None, "ciphered rows are unusable");
        assert_eq!(format_url(&formats, 999), None);
    }

    #[test]
    fn playability_reads_status_details_and_length() {
        let json = json!({
            "playabilityStatus": { "status": "OK" },
            "videoDetails": { "videoId": "NJAv_7lHUIU", "title": "Kesariya", "lengthSeconds": "268" }
        });
        let p = playability(&json);
        assert_eq!(p.status, "OK");
        assert_eq!(p.video_id, "NJAv_7lHUIU");
        assert_eq!(p.length_seconds, 268);

        let gated = json!({ "playabilityStatus": { "status": "LOGIN_REQUIRED", "reason": "Sign in" } });
        assert_eq!(playability(&gated).status, "LOGIN_REQUIRED");
    }

    #[test]
    fn relay_refuses_anything_but_the_media_cdn() {
        assert!(video_host_ok("https://r1.googlevideo.com/videoplayback?x=1").is_ok());
        assert!(video_host_ok("https://googlevideo.com/x").is_ok());
        for bad in [
            "http://127.0.0.1:8787/stream?id=x",
            "http://localhost/x",
            "https://evil.example.com/x",
            "https://googlevideo.com.evil.example/x",
            "file:///etc/passwd",
            "http://10.0.0.5/x",
            "http://[::1]/x",
        ] {
            assert!(video_host_ok(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn duration_and_play_count_parse_the_observed_text() {
        assert_eq!(parse_duration("4:29"), 269);
        assert_eq!(parse_duration("1:02:03"), 3723);
        assert_eq!(parse_duration("not a time"), 0);
        assert_eq!(parse_play_count("973M plays"), 973_000_000);
        assert_eq!(parse_play_count("1.2B"), 1_200_000_000);
        assert_eq!(parse_play_count("1,234 plays"), 1234);
        assert_eq!(parse_play_count(""), 0);
    }

    #[test]
    fn credits_split_on_the_separators_a_catalog_uses() {
        assert_eq!(
            credit_parts("Pritam, Shashwat Singh & Antara Mitra"),
            vec!["Pritam", "Shashwat Singh", "Antara Mitra"]
        );
        assert_eq!(credit_parts("Arijit Singh feat. Pritam"), vec!["Arijit Singh", "Pritam"]);
    }

    #[test]
    fn request_bodies_are_the_probe_verified_shapes() {
        let s = search_body("Kesariya Arijit Singh Brahmastra");
        assert_eq!(s.pointer("/context/client/clientName").unwrap(), "WEB_REMIX");
        assert_eq!(s["query"], "Kesariya Arijit Singh Brahmastra");
        assert!(s["params"].as_str().unwrap().ends_with("%3D%3D"));

        let p = player_body("NJAv_7lHUIU");
        // The iOS client is load-bearing: it is what returns plain `url`s.
        assert_eq!(p.pointer("/context/client/clientName").unwrap(), "IOS");
        assert_eq!(p["videoId"], "NJAv_7lHUIU");
    }

    #[test]
    fn the_same_name_normalisation_ignores_brackets_and_case() {
        assert!(same_name("Kesariya (From \"Brahmastra\")", "Kesariya"));
        assert!(!same_name("Kesariya", "Deva Deva"));
    }
}
