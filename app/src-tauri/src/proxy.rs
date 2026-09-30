//! Localhost byte-range relay.
//!
//! Owns: the axum server on 127.0.0.1, scheme/host allow-listing, verbatim
//! Range forwarding, and the process-wide memo caches shared with the Tauri
//! command path via `Arc<AppState>`.
//!
//! The relay is a pass-through, not a policy engine: upstream status codes —
//! including failures — are relayed verbatim.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::jiosaavn::{
    best_quality, check_id, fetch_song, qualify_url, search_songs, validate_media_url, Probe,
    SearchPage, Song,
};

/// Response headers relayed from upstream. Everything else is dropped
/// deliberately (no cookies, no correlation ids, no server fingerprinting).
const RELAYED_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
];

/// Bytes between two download-progress callbacks (~40 events for a song).
const REPORT_EVERY: u64 = 256 * 1024;

/// Session cache ceilings: every search query is a unique key, so a
/// long-running session must not grow these maps without bound.
const RESOLVED_CAP: usize = 400;
const QUALIFIED_CAP: usize = 800;
const SEARCH_CAP: usize = 500;
const LYRICS_CAP: usize = 500;

/// Insert into a session cache, dropping one arbitrary entry when full.
/// ponytail: arbitrary eviction, no TTL — session-lived maps only need a
/// ceiling, not an LRU; swap in `moka` if hit rate ever becomes measurable.
fn put_capped<V>(map: &mut HashMap<String, V>, cap: usize, key: String, val: V) {
    if map.len() >= cap && !map.contains_key(&key) {
        if let Some(evictee) = map.keys().next().cloned() {
            map.remove(&evictee);
        }
    }
    map.insert(key, val);
}

/// One file in the offline vault, as recorded in `<vault>/index.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DownloadEntry {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub image: String,
    pub duration_secs: u64,
    pub quality: String,
    /// Absolute path of the file on disk.
    pub path: String,
    pub bytes: u64,
    /// Unix seconds — the vault is sorted by this.
    pub at: u64,
}

/// Everything the Downloads screen needs in one round trip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Vault {
    pub dir: String,
    pub entries: Vec<DownloadEntry>,
}

pub struct AppState {
    /// Metadata + probes: total 25 s timeout.
    pub client: reqwest::Client,
    /// Media bodies: connect/read timeouts only, NO total timeout.
    pub media: reqwest::Client,
    pub port: u16,
    /// Where downloaded files are kept (`<Downloads>/TRANCE MUSIC`).
    pub vault: std::path::PathBuf,
    /// song id -> full resolved song (memoised mirror round-trip)
    pub resolved: tokio::sync::Mutex<HashMap<String, Song>>,
    /// CDN url -> probe result (memoised qualification)
    pub qualified: tokio::sync::Mutex<HashMap<String, Probe>>,
    /// search query -> results (memoised to avoid hammering the mirror)
    pub search_cache: tokio::sync::Mutex<HashMap<String, SearchPage>>,
    /// song id -> lyrics (only non-empty answers are stored)
    pub lyrics_cache: tokio::sync::Mutex<HashMap<String, crate::lyrics::Lyrics>>,
    /// Serializes manifest read-modify-write: two downloads finishing at the
    /// same time must not overwrite each other's row (last-write-wins).
    manifest_lock: std::sync::Mutex<()>,
}

impl AppState {
    pub fn new(port: u16, vault: std::path::PathBuf) -> Self {
        sweep_partials(&vault);
        Self {
            client: crate::jiosaavn::api_client(),
            media: crate::jiosaavn::media_client(),
            port,
            vault,
            resolved: tokio::sync::Mutex::new(HashMap::new()),
            qualified: tokio::sync::Mutex::new(HashMap::new()),
            search_cache: tokio::sync::Mutex::new(HashMap::new()),
            lyrics_cache: tokio::sync::Mutex::new(HashMap::new()),
            manifest_lock: std::sync::Mutex::new(()),
        }
    }

    /// Resolve a song id to its full detail, memoised for the process.
    pub async fn cached_song(&self, id: &str) -> Result<Song, String> {
        if let Some(song) = self.resolved.lock().await.get(id).cloned() {
            return Ok(song);
        }
        let song = fetch_song(&self.client, id).await?;
        put_capped(
            &mut *self.resolved.lock().await,
            RESOLVED_CAP,
            id.to_string(),
            song.clone(),
        );
        Ok(song)
    }

    /// Resolve a song id to a direct CDN url (320 kbps preference).
    pub async fn cached_url(&self, id: &str) -> Result<String, String> {
        let song = self.cached_song(id).await?;
        best_quality(&song.qualities, "320kbps")
            .map(|q| q.url)
            .ok_or_else(|| "no stream qualities".to_string())
    }

    /// Qualify a CDN url (3 probes), memoised for the process.
    pub async fn cached_qualify(&self, url: &str) -> Result<Probe, String> {
        if let Some(probe) = self.qualified.lock().await.get(url).copied() {
            return Ok(probe);
        }
        let probe = qualify_url(&self.client, url).await?;
        put_capped(
            &mut *self.qualified.lock().await,
            QUALIFIED_CAP,
            url.to_string(),
            probe,
        );
        Ok(probe)
    }

    /// Search the catalog, memoised per query+limit+page to avoid hammering upstream.
    pub async fn cached_search(
        &self,
        query: &str,
        limit: u32,
        page: u32,
    ) -> Result<SearchPage, String> {
        let key = format!("{}:{limit}:{page}", query.to_lowercase());
        if let Some(hit) = self.search_cache.lock().await.get(&key).cloned() {
            return Ok(hit);
        }
        let result = search_songs(&self.client, query, limit, page).await?;
        put_capped(
            &mut *self.search_cache.lock().await,
            SEARCH_CAP,
            key,
            result.clone(),
        );
        Ok(result)
    }

    /// Best available lyrics for a song, memoised per song id.
    ///
    /// Only answers with content are stored: a provider that was merely down
    /// must not be remembered as "this song has no lyrics".
    pub async fn cached_lyrics(
        &self,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        duration: u32,
    ) -> Result<crate::lyrics::Lyrics, String> {
        if let Some(hit) = self.lyrics_cache.lock().await.get(id).cloned() {
            return Ok(hit);
        }
        let lyrics = crate::lyrics::fetch(&self.client, id, title, artist, album, duration).await?;
        if lyrics.has_content() {
            put_capped(
                &mut *self.lyrics_cache.lock().await,
                LYRICS_CAP,
                id.to_string(),
                lyrics.clone(),
            );
        }
        Ok(lyrics)
    }

    /// Download a whole media file to `dest`.
    ///
    /// Refuses anything outside the media allow-list and refuses to keep a
    /// file that does not match the declared `Content-Length`: a truncated
    /// download must never masquerade as a complete song. Bytes land in a
    /// `.part` sibling first and are renamed into place only once verified,
    /// so a crash mid-download leaves garbage, never a half song under its
    /// final name (stale `.part` files are swept at boot).
    ///
    /// `on_progress(received, total)` is called at the start, roughly every
    /// 256 KB, and once with the final byte count. Returns path + bytes.
    pub async fn download_to(
        &self,
        url: &str,
        dest: &Path,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(PathBuf, u64), String> {
        use tokio::io::AsyncWriteExt;

        let url = validate_media_url(url)?;
        let resp = self
            .media
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("download failed: HTTP {status}"));
        }
        let declared = resp.content_length();
        on_progress(0, declared);

        let part = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {}: {e}", part.display()))?;
        let mut written: u64 = 0;
        let mut next_report: u64 = REPORT_EVERY;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            let chunk =
                chunk.map_err(|e| format!("download interrupted after {written} bytes: {e}"))?;
            written += chunk.len() as u64;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {}: {e}", part.display()))?;
            if written >= next_report {
                on_progress(written, declared);
                next_report = written + REPORT_EVERY;
            }
        }
        drop(file);
        on_progress(written, declared);

        if let Some(declared) = declared {
            if written != declared {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("truncated download: {written} of {declared} bytes"));
            }
        }
        tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| format!("commit {}: {e}", dest.display()))?;
        Ok((dest.to_path_buf(), written))
    }

    // ---------------------------------------------------------------- vault -

    fn manifest(&self) -> PathBuf {
        self.vault.join("index.json")
    }

    /// Vault contents: recorded entries whose file is still on disk, newest
    /// first, plus the directory itself for the storage card.
    ///
    /// ponytail: a `stat` per entry over a hand-sized list — a filesystem
    /// watcher is only worth it once the vault holds thousands of files.
    pub fn vault(&self) -> Vault {
        let entries = read_manifest(&self.manifest())
            .into_iter()
            .filter(|e| Path::new(&e.path).is_file())
            .collect();
        Vault {
            dir: self.vault.display().to_string(),
            entries,
        }
    }

    /// Persist one download. Re-downloading the same song replaces its row
    /// instead of duplicating it.
    pub fn record(&self, entry: DownloadEntry) -> Result<(), String> {
        let _guard = self.manifest_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = read_manifest(&self.manifest());
        entries.retain(|e| e.id != entry.id);
        entries.push(entry);
        write_manifest(&self.manifest(), &entries)
    }

    /// Drop the record for `id` before a re-download: that file is about to
    /// be rewritten, so it must stop resolving as a playable copy meanwhile.
    pub fn forget(&self, id: &str) -> Result<(), String> {
        let _guard = self.manifest_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = read_manifest(&self.manifest());
        if !entries.iter().any(|e| e.id == id) {
            return Ok(());
        }
        entries.retain(|e| e.id != id);
        write_manifest(&self.manifest(), &entries)
    }

    /// Delete a file by the path we recorded for it — paths from the IPC
    /// boundary are never touched, only ones we wrote ourselves.
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let _guard = self.manifest_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = read_manifest(&self.manifest());
        let index = entries
            .iter()
            .position(|e| e.path == path)
            .ok_or_else(|| "that file is not in your vault".to_string())?;
        let victim = PathBuf::from(&entries[index].path);
        if victim.starts_with(&self.vault) && victim.is_file() {
            std::fs::remove_file(&victim)
                .map_err(|e| format!("delete {}: {e}", victim.display()))?;
        }
        entries.remove(index);
        write_manifest(&self.manifest(), &entries)
    }

    /// Reveal a recorded file in the system file manager.
    pub fn reveal(&self, path: &str) -> Result<(), String> {
        let entry = read_manifest(&self.manifest())
            .into_iter()
            .find(|e| e.path == path)
            .ok_or_else(|| "that file is not in your vault".to_string())?;
        open_in_folder(Path::new(&entry.path))
    }

    /// Reveal the vault folder itself — no caller-supplied path involved.
    pub fn reveal_vault(&self) -> Result<(), String> {
        open_in_folder(&self.vault)
    }
}

/// Remove `*.part` leftovers — downloads (or a manifest write) interrupted
/// by a crash. They are unreachable by design, so they are pure garbage.
fn sweep_partials(vault: &Path) {
    let Ok(dir) = std::fs::read_dir(vault) else {
        return;
    };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("part"))
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn read_manifest(path: &Path) -> Vec<DownloadEntry> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new(); // first run: no manifest yet, nothing to recover
    };
    match serde_json::from_slice(&bytes) {
        Ok(entries) => entries,
        // An interrupted/external write left garbage behind, but the audio
        // files themselves are intact — rebuild the rows from disk rather
        // than pretending every download never happened.
        Err(_) => rebuild_manifest(path),
    }
}

/// Rebuild manifest rows from the files on disk. Metadata that lived only
/// in `index.json` (real song id, album art, duration) is unrecoverable:
/// the row keeps title/artist from the `<artist> - <title>` filename, size
/// and mtime, and gets a stable synthetic id so play/reveal/delete keep
/// working until the song is downloaded again.
/// ponytail: does not parse audio tags for the lost fields; upgrade path:
/// read the m4a `moov` atom if they ever matter.
fn rebuild_manifest(path: &Path) -> Vec<DownloadEntry> {
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let now = unix_now();
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let file = entry.path();
        if !file.is_file() {
            continue;
        }
        let Some(ext) = file.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !(ext.eq_ignore_ascii_case("m4a")
            || ext.eq_ignore_ascii_case("mp4")
            || ext.eq_ignore_ascii_case("mp3"))
        {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        let stem = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let (artist, title) = match stem.split_once(" - ") {
            Some((a, t)) => (a.to_string(), t.to_string()),
            None => (String::new(), stem.clone()),
        };
        let at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(now);
        let path_str = file.to_string_lossy().into_owned();
        out.push(DownloadEntry {
            id: recovered_id(&path_str),
            title,
            artist,
            album: String::new(),
            image: String::new(),
            duration_secs: 0,
            quality: "unknown".into(),
            bytes: meta.len(),
            path: path_str,
            at,
        });
    }
    // Append order of the original manifest was chronological; keep it.
    out.sort_by_key(|e| e.at);
    // Heal the file so the scan runs once, not on every listing.
    if !out.is_empty() {
        let _ = write_manifest(path, &out);
    }
    out
}

/// Stable synthetic id for a recovered row: 16 hex chars pass `check_id`
/// (≤32 chars, alnum only) and cannot collide with a real JioSaavn id in
/// practice. FNV-1a — deterministic, four lines, no dependency.
fn recovered_id(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_manifest(path: &Path, entries: &[DownloadEntry]) -> Result<(), String> {
    let json =
        serde_json::to_vec_pretty(entries).map_err(|e| format!("encode vault manifest: {e}"))?;
    // Write-then-rename: an interrupted write leaves a `.part` (swept at
    // boot), never a truncated index.json that would orphan every file.
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("commit {}: {e}", path.display()))
}

/// Reveal `path` (selecting it) in the platform file manager.
#[cfg(target_os = "windows")]
fn open_in_folder(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn open_in_folder(path: &Path) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/stream", get(stream))
        .route("/file", get(vault_file))
        .with_state(state)
}

/// Serve one saved file from the vault with byte ranges, so a downloaded
/// song scrubs exactly like a streamed one.
///
/// The query carries a song id, never a path: the file is found in the
/// manifest we wrote ourselves and re-checked against the vault root.
async fn vault_file(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let id = match params.get("id") {
        Some(id) => id.clone(),
        None => return bad_request("missing ?id="),
    };
    if let Err(e) = check_id(&id) {
        return bad_request(e);
    }
    let entry = match state.vault().entries.into_iter().find(|e| e.id == id) {
        Some(e) => e,
        None => return (StatusCode::NOT_FOUND, "not in the vault").into_response(),
    };
    let path = PathBuf::from(entry.path);
    if !path.starts_with(&state.vault) {
        return (StatusCode::FORBIDDEN, "outside the vault").into_response();
    }
    // Size comes from metadata: the range is answered without touching the
    // payload, then only the requested span is read — a scrub must not pull
    // a 10 MB song into memory (let alone copy it a second time).
    let total = match tokio::fs::metadata(&path).await {
        Ok(meta) => meta.len() as usize,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                format!("stat {}: {e}", path.display()),
            )
                .into_response()
        }
    };
    let is_mp3 = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp3"));

    let (status, start, end) =
        match slice_range(headers.get("range").and_then(|v| v.to_str().ok()), total) {
            Ok(bound) => bound,
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("content-range", format!("bytes */{total}"))
                    .body(Body::empty())
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
        };

    let span = if total == 0 { 0 } else { end - start + 1 };
    let mut slice = vec![0u8; span];
    if span > 0 {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                return (
                    StatusCode::NOT_FOUND,
                    format!("open {}: {e}", path.display()),
                )
                    .into_response()
            }
        };
        if let Err(e) = file.seek(std::io::SeekFrom::Start(start as u64)).await {
            return (
                StatusCode::NOT_FOUND,
                format!("seek {}: {e}", path.display()),
            )
                .into_response();
        }
        if let Err(e) = file.read_exact(&mut slice).await {
            return (
                StatusCode::NOT_FOUND,
                format!("read {}: {e}", path.display()),
            )
                .into_response();
        }
    }

    let mut builder = Response::builder()
        .status(status)
        .header(
            "content-type",
            if is_mp3 { "audio/mpeg" } else { "audio/mp4" },
        )
        .header("content-length", slice.len())
        .header("accept-ranges", "bytes");
    if status == 206 {
        builder = builder.header("content-range", format!("bytes {start}-{end}/{total}"));
    }
    builder
        .body(Body::from(slice))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Parse `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` into inclusive offsets
/// into a `total`-byte file. Answers 206 whenever the client asked for a
/// range, 200 when it did not.
fn slice_range(header: Option<&str>, total: usize) -> Result<(u16, usize, usize), ()> {
    if total == 0 {
        return Ok((200, 0, 0));
    }
    let spec = match header.and_then(|h| h.strip_prefix("bytes=")) {
        Some(spec) => spec.trim(),
        None => return Ok((200, 0, total - 1)),
    };
    let (raw_start, raw_end) = spec.split_once('-').ok_or(())?;
    let start = if raw_start.trim().is_empty() {
        // Suffix form: the last N bytes.
        let n: usize = raw_end.trim().parse().map_err(|_| ())?;
        total.saturating_sub(n.max(1))
    } else {
        raw_start.trim().parse().map_err(|_| ())?
    };
    if start >= total {
        return Err(());
    }
    let end = if raw_end.trim().is_empty() {
        total - 1
    } else {
        raw_end
            .trim()
            .parse::<usize>()
            .map_err(|_| ())?
            .min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((206, start, end))
}

fn bad_request(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, msg.into()).into_response()
}

/// Resolve `?u=<cdn url>` or `?id=<song id>` into a validated CDN url.
// Response carries full headers + body type, so it is large for an Err
// variant; boxing every early-return would cost more than it saves here.
#[allow(clippy::result_large_err)]
async fn resolve_target(
    state: &AppState,
    params: &HashMap<String, String>,
) -> Result<String, Response> {
    if let Some(u) = params.get("u") {
        return validate_media_url(u).map_err(bad_request);
    }
    if let Some(id) = params.get("id") {
        check_id(id).map_err(bad_request)?;
        return state.cached_url(id).await.map_err(|e| {
            (StatusCode::BAD_GATEWAY, format!("resolve failed: {e}")).into_response()
        });
    }
    Err(bad_request("missing ?u= or ?id="))
}

async fn stream(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let target = match resolve_target(&state, &params).await {
        Ok(url) => url,
        Err(resp) => return resp,
    };

    let mut req = state.media.get(&target);
    if let Some(range) = headers.get("range").and_then(|v| v.to_str().ok()) {
        // Forward the browser's Range header verbatim.
        req = req.header(reqwest::header::RANGE, range);
    }

    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream failed: {e}")).into_response()
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    let mut out = HeaderMap::new();
    for name in RELAYED_HEADERS {
        if let Some(value) = upstream.headers().get(*name) {
            if let (Ok(k), Ok(v)) = (
                axum::http::HeaderName::from_bytes(name.as_bytes()),
                value.to_str(),
            ) {
                if let Ok(hv) = axum::http::HeaderValue::from_str(v) {
                    out.insert(k, hv);
                }
            }
        }
    }

    let body =
        Body::from_stream(futures::StreamExt::map(
            upstream.bytes_stream(),
            |chunk| match chunk {
                Ok(bytes) => Ok::<_, std::io::Error>(bytes),
                Err(e) => Err(std::io::Error::other(e)),
            },
        ));

    let mut builder = Response::builder().status(status);
    for (name, value) in out.iter() {
        builder = builder.header(name, value);
    }

    builder
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Convenience used by the Tauri command layer to assemble the DTO.
pub fn proxy_url_for(port: u16, direct_url: &str) -> String {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("u", direct_url)
        .finish();
    format!("http://127.0.0.1:{port}/stream?{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jiosaavn::{api_client, search_songs};

    /// Boot the real router on an ephemeral port, return base URL + state.
    async fn boot() -> (String, Arc<AppState>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let state = Arc::new(AppState::new(
            port,
            std::env::temp_dir().join(format!("trance-vault-{port}")),
        ));
        let app = router(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://127.0.0.1:{port}"), state)
    }

    /// A known-good song id, discovered live so the test never depends on a
    /// hard-coded id that might be rotated away.
    async fn live_song_id() -> String {
        let tracks = search_songs(&api_client(), "tum hi ho", 1, 1)
            .await
            .expect("live search")
            .tracks;
        tracks[0].id.clone()
    }

    #[tokio::test]
    async fn bounded_range_returns_206_with_64_bytes_and_ftyp() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let (base, _state) = boot().await;
        let id = live_song_id().await;
        let resp = reqwest::Client::new()
            .get(format!("{base}/stream"))
            .query(&[("id", id.as_str())])
            .header("Range", "bytes=0-63")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 206);
        let body = resp.bytes().await.unwrap();
        assert_eq!(body.len(), 64, "bounded probe must be exactly 64 bytes");
        assert_eq!(&body[4..8], b"ftyp", "body must be an ISO-BMFF file");
    }

    #[tokio::test]
    async fn mid_file_range_returns_exactly_65536_bytes() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let (base, _state) = boot().await;
        let id = live_song_id().await;
        let resp = reqwest::Client::new()
            .get(format!("{base}/stream"))
            .query(&[("id", id.as_str())])
            .header("Range", "bytes=2000000-2065535")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 206);
        let body = resp.bytes().await.unwrap();
        assert_eq!(body.len(), 65_536, "mid-file window must not be truncated");
    }

    #[tokio::test]
    async fn stream_delivers_the_entire_body() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let (base, _state) = boot().await;
        let id = live_song_id().await;
        let resp = reqwest::Client::new()
            .get(format!("{base}/stream"))
            .query(&[("id", id.as_str())])
            .header("Range", "bytes=0-")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 206);
        let declared: usize = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse().ok())
            .expect("content-range total");
        let mut stream = resp.bytes_stream();
        let mut received: usize = 0;
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            received += chunk.unwrap().len();
        }
        assert_eq!(
            received, declared,
            "the proxy must never silently guillotine a song"
        );
    }

    #[tokio::test]
    async fn allow_list_rejects_non_media_hosts() {
        let (base, _state) = boot().await;
        let client = reqwest::Client::new();

        let resp = client
            .get(format!("{base}/stream"))
            .query(&[("u", "https://example.com/x.mp4")])
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400);

        let resp = client
            .get(format!("{base}/stream"))
            .query(&[("u", "http://aac.saavncdn.com/x.mp4")])
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400, "http must be rejected");
    }

    #[tokio::test]
    async fn missing_params_return_400() {
        let (base, _state) = boot().await;
        let resp = reqwest::Client::new()
            .get(format!("{base}/stream"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400);
    }

    /// Byte-count regression for the offline save path: what lands on disk
    /// must be exactly as long as the CDN declared, or not be kept at all.
    #[tokio::test]
    async fn download_writes_exactly_the_declared_bytes() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let (_base, state) = boot().await;
        let id = live_song_id().await;
        let song = state.cached_song(&id).await.expect("resolve");
        let chosen = crate::jiosaavn::best_quality(&song.qualities, "12kbps").unwrap();
        let dest = std::env::temp_dir().join("trance-download-test.mp4");
        let _ = std::fs::remove_file(&dest);

        let mut reports = 0u32;
        let (path, written) = state
            .download_to(&chosen.url, &dest, |_, _| reports += 1)
            .await
            .expect("download");
        let on_disk = std::fs::metadata(&path).expect("file must exist").len();
        assert_eq!(on_disk, written, "file size must match the byte counter");
        assert!(
            written > 100_000,
            "even the smallest rendition is a real file"
        );
        assert!(reports >= 2, "progress must fire at start and at end");
        assert!(
            !dest.with_extension("part").exists(),
            "a verified download is committed, never left as .part"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A saved song plays back through the relay byte-for-byte, with the
    /// range support an <audio> element needs to scrub.
    #[tokio::test]
    async fn vault_file_serves_saved_bytes_and_ranges() {
        let (base, state) = boot().await;
        std::fs::create_dir_all(&state.vault).expect("vault dir");
        let path = state.vault.join("slice.m4a");
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).expect("write file");
        let id = "vaultTest01".to_string();
        state
            .record(DownloadEntry {
                id: id.clone(),
                title: "T".into(),
                artist: "A".into(),
                album: "B".into(),
                image: String::new(),
                duration_secs: 1,
                quality: "320kbps".into(),
                path: path.display().to_string(),
                bytes: payload.len() as u64,
                at: 0,
            })
            .expect("record");

        let client = reqwest::Client::new();
        let full = client
            .get(format!("{base}/file?id={id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(full.status().as_u16(), 200);
        assert_eq!(full.bytes().await.unwrap().as_ref(), payload.as_slice());

        let part = client
            .get(format!("{base}/file?id={id}"))
            .header("Range", "bytes=100-199")
            .send()
            .await
            .unwrap();
        assert_eq!(part.status().as_u16(), 206);
        assert_eq!(
            part.headers().get("content-range").unwrap(),
            "bytes 100-199/4096"
        );
        assert_eq!(part.bytes().await.unwrap().as_ref(), &payload[100..200]);

        // well-formed id that was never recorded: no such file
        let missing = client
            .get(format!("{base}/file?id=zzzzzzzzzzz"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status().as_u16(), 404);
        let _ = std::fs::remove_file(&path);
    }

    /// The vault keeps its own ledger: what it recorded, it can list, and
    /// only what it recorded can be deleted through it.
    #[test]
    fn vault_records_lists_and_removes_only_its_own_files() {
        let dir = std::env::temp_dir().join(format!("trance-vault-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = AppState::new(0, dir.clone());

        let file = dir.join("Trance - Anthem.m4a");
        std::fs::write(&file, b"abc").expect("write file");
        state
            .record(DownloadEntry {
                id: "x1".into(),
                title: "Anthem".into(),
                artist: "Trance".into(),
                album: "Album".into(),
                image: String::new(),
                duration_secs: 180,
                quality: "320kbps".into(),
                path: file.display().to_string(),
                bytes: 3,
                at: 0,
            })
            .expect("record");

        // re-recording the same song replaces rather than duplicates
        state
            .record(DownloadEntry {
                bytes: 4,
                ..state.vault().entries.first().cloned().expect("entry")
            })
            .expect("re-record");
        let vault = state.vault();
        assert_eq!(vault.entries.len(), 1, "one song stays one row");
        assert_eq!(vault.entries[0].bytes, 4);
        assert_eq!(vault.entries[0].title, "Anthem");

        // a path we never wrote is refused outright
        assert!(state.remove("/etc/passwd").is_err());

        state.remove(&file.display().to_string()).expect("remove");
        assert!(state.vault().entries.is_empty(), "the row is gone");
        assert!(!file.exists(), "and so is the file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A full cache evicts instead of growing forever: every search query
    /// is a unique key, so the maps need a hard ceiling.
    #[test]
    fn caches_evict_once_full() {
        let mut map = HashMap::new();
        for i in 0..5 {
            put_capped(&mut map, 3, format!("k{i}"), i);
        }
        assert_eq!(map.len(), 3, "cache stays at its ceiling");
        assert_eq!(map.get("k4"), Some(&4), "the newest key survives");
    }

    /// A corrupted index.json must not orphan the audio files: the rows are
    /// rebuilt from disk, the manifest is healed atomically, and the
    /// recovered id passes the same validator every id goes through.
    #[test]
    fn corrupt_manifest_is_rebuilt_from_disk() {
        let dir = std::env::temp_dir().join(format!("trance-rebuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let file = dir.join("Arctic Monkeys - Do I Wanna Know.m4a");
        std::fs::write(&file, b"0123456789").expect("write file");
        std::fs::write(dir.join("index.json"), b"{ this is not json").expect("corrupt manifest");

        let manifest = dir.join("index.json");
        let entries = read_manifest(&manifest);
        assert_eq!(entries.len(), 1, "the file on disk keeps its row");
        let entry = &entries[0];
        assert_eq!(entry.artist, "Arctic Monkeys");
        assert_eq!(entry.title, "Do I Wanna Know");
        assert_eq!(entry.bytes, 10);
        assert!(
            check_id(&entry.id).is_ok(),
            "recovered id must pass validation"
        );

        let healed = std::fs::read(&manifest).expect("healed manifest");
        assert!(
            serde_json::from_slice::<Vec<DownloadEntry>>(&healed).is_ok(),
            "recovery persists a readable manifest"
        );
        assert!(
            !manifest.with_extension("json.part").exists(),
            "the atomic write leaves no .part behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Boot sweeps crash leftovers but keeps real files.
    #[test]
    fn boot_sweeps_partials_only() {
        let dir = std::env::temp_dir().join(format!("trance-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let stale = dir.join("Half Song.part");
        let kept = dir.join("Full Song.m4a");
        std::fs::write(&stale, b"garbage").expect("stale part");
        std::fs::write(&kept, b"song").expect("song");

        let _ = AppState::new(0, dir.clone());

        assert!(!stale.exists(), "crash leftovers are swept");
        assert!(kept.exists(), "real files are untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Manifest writes are serialized: N downloads finishing at the same
    /// moment must all keep their row (previously last-write-wins).
    #[test]
    fn concurrent_records_keep_every_row() {
        let dir = std::env::temp_dir().join(format!("trance-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = Arc::new(AppState::new(0, dir.clone()));

        let handles: Vec<_> = (0..4u64)
            .map(|i| {
                let state = state.clone();
                let file = dir.join(format!("Song {i}.m4a"));
                std::fs::write(&file, b"x").expect("write file");
                std::thread::spawn(move || {
                    state
                        .record(DownloadEntry {
                            id: format!("raceid{i}"),
                            title: format!("Song {i}"),
                            artist: "A".into(),
                            album: String::new(),
                            image: String::new(),
                            duration_secs: 1,
                            quality: "unknown".into(),
                            path: file.display().to_string(),
                            bytes: 1,
                            at: i,
                        })
                        .expect("record");
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread");
        }
        assert_eq!(
            read_manifest(&state.manifest()).len(),
            4,
            "every concurrent download keeps its row"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
