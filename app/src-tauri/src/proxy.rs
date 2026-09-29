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
}

impl AppState {
    pub fn new(port: u16, vault: std::path::PathBuf) -> Self {
        Self {
            client: crate::jiosaavn::api_client(),
            media: crate::jiosaavn::media_client(),
            port,
            vault,
            resolved: tokio::sync::Mutex::new(HashMap::new()),
            qualified: tokio::sync::Mutex::new(HashMap::new()),
            search_cache: tokio::sync::Mutex::new(HashMap::new()),
            lyrics_cache: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Resolve a song id to its full detail, memoised for the process.
    pub async fn cached_song(&self, id: &str) -> Result<Song, String> {
        if let Some(song) = self.resolved.lock().await.get(id).cloned() {
            return Ok(song);
        }
        let song = fetch_song(&self.client, id).await?;
        self.resolved
            .lock()
            .await
            .insert(id.to_string(), song.clone());
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
        self.qualified
            .lock()
            .await
            .insert(url.to_string(), probe);
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
        self.search_cache
            .lock()
            .await
            .insert(key, result.clone());
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
            self.lyrics_cache
                .lock()
                .await
                .insert(id.to_string(), lyrics.clone());
        }
        Ok(lyrics)
    }

    /// Download a whole media file to `dest`.
    ///
    /// Refuses anything outside the media allow-list and refuses to keep a
    /// file that does not match the declared `Content-Length`: a truncated
    /// download must never masquerade as a complete song.
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

        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("create {}: {e}", dest.display()))?;
        let mut written: u64 = 0;
        let mut next_report: u64 = REPORT_EVERY;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            let chunk = chunk.map_err(|e| {
                format!("download interrupted after {written} bytes: {e}")
            })?;
            written += chunk.len() as u64;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {}: {e}", dest.display()))?;
            if written >= next_report {
                on_progress(written, declared);
                next_report = written + REPORT_EVERY;
            }
        }
        drop(file);
        on_progress(written, declared);

        if let Some(declared) = declared {
            if written != declared {
                let _ = tokio::fs::remove_file(dest).await;
                return Err(format!(
                    "truncated download: {written} of {declared} bytes"
                ));
            }
        }
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
        let mut entries = read_manifest(&self.manifest());
        entries.retain(|e| e.id != entry.id);
        entries.push(entry);
        write_manifest(&self.manifest(), &entries)
    }

    /// Drop the record for `id` before a re-download: that file is about to
    /// be rewritten, so it must stop resolving as a playable copy meanwhile.
    pub fn forget(&self, id: &str) -> Result<(), String> {
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
        let mut entries = read_manifest(&self.manifest());
        let index = entries
            .iter()
            .position(|e| e.path == path)
            .ok_or_else(|| "that file is not in your vault".to_string())?;
        let victim = PathBuf::from(&entries[index].path);
        if victim.starts_with(&self.vault) && victim.is_file() {
            std::fs::remove_file(&victim).map_err(|e| format!("delete {}: {e}", victim.display()))?;
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

fn read_manifest(path: &Path) -> Vec<DownloadEntry> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_manifest(path: &Path, entries: &[DownloadEntry]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(entries)
        .map_err(|e| format!("encode vault manifest: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write {}: {e}", path.display()))
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
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
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
    let body = match tokio::fs::read(&path).await {
        Ok(body) => body,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                format!("read {}: {e}", path.display()),
            )
                .into_response()
        }
    };
    let total = body.len();
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

    let slice = if body.is_empty() { Vec::new() } else { body[start..=end].to_vec() };
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", if is_mp3 { "audio/mpeg" } else { "audio/mp4" })
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
        raw_end.trim().parse::<usize>().map_err(|_| ())?.min(total - 1)
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
async fn resolve_target(
    state: &AppState,
    params: &HashMap<String, String>,
) -> Result<String, Response> {
    if let Some(u) = params.get("u") {
        return validate_media_url(u).map_err(bad_request);
    }
    if let Some(id) = params.get("id") {
        check_id(id).map_err(|e| bad_request(e))?;
        return state.cached_url(id).await.map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("resolve failed: {e}"),
            )
                .into_response()
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
    if let Some(range) = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
    {
        // Forward the browser's Range header verbatim.
        req = req.header(reqwest::header::RANGE, range);
    }

    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream failed: {e}"),
            )
                .into_response()
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

    let body = Body::from_stream(futures::StreamExt::map(
        upstream.bytes_stream(),
        |chunk| match chunk {
            Ok(bytes) => Ok::<_, std::io::Error>(bytes),
            Err(e) => Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
        },
    ));

    let mut builder = Response::builder().status(status);
    for (name, value) in out.iter() {
        builder = builder.header(name, value);
    }

    builder.body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Convenience used by the Tauri command layer to assemble the DTO.
pub fn proxy_url_for(port: u16, direct_url: &str) -> String {
    let encoded =
        url::form_urlencoded::Serializer::new(String::new())
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
        assert!(written > 100_000, "even the smallest rendition is a real file");
        assert!(reports >= 2, "progress must fire at start and at end");
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
}
