//! Localhost byte-range relay.
//!
//! Owns: the axum server on 127.0.0.1, scheme/host allow-listing, verbatim
//! Range forwarding, and the process-wide memo caches shared with the Tauri
//! command path via `Arc<AppState>`.
//!
//! The relay is a pass-through, not a policy engine: upstream status codes —
//! including failures — are relayed verbatim.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::jiosaavn::{
    best_quality, check_id, fetch_song, qualify_url, search_songs, validate_media_url, Probe,
    Song, Track,
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

pub struct AppState {
    /// Metadata + probes: total 25 s timeout.
    pub client: reqwest::Client,
    /// Media bodies: connect/read timeouts only, NO total timeout.
    pub media: reqwest::Client,
    pub port: u16,
    /// song id -> full resolved song (memoised mirror round-trip)
    pub resolved: tokio::sync::Mutex<HashMap<String, Song>>,
    /// CDN url -> probe result (memoised qualification)
    pub qualified: tokio::sync::Mutex<HashMap<String, Probe>>,
    /// search query -> results (memoised to avoid hammering the mirror)
    pub search_cache: tokio::sync::Mutex<HashMap<String, Vec<Track>>>,
}

impl AppState {
    pub fn new(port: u16) -> Self {
        Self {
            client: crate::jiosaavn::api_client(),
            media: crate::jiosaavn::media_client(),
            port,
            resolved: tokio::sync::Mutex::new(HashMap::new()),
            qualified: tokio::sync::Mutex::new(HashMap::new()),
            search_cache: tokio::sync::Mutex::new(HashMap::new()),
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
    ) -> Result<Vec<Track>, String> {
        let key = format!("{}:{limit}:{page}", query.to_lowercase());
        if let Some(hit) = self.search_cache.lock().await.get(&key).cloned() {
            return Ok(hit);
        }
        let tracks = search_songs(&self.client, query, limit, page).await?;
        self.search_cache
            .lock()
            .await
            .insert(key, tracks.clone());
        Ok(tracks)
    }

    /// Download a whole media file to `dest`.
    ///
    /// Refuses anything outside the media allow-list and refuses to keep a
    /// file that does not match the declared `Content-Length`: a truncated
    /// download must never masquerade as a complete song.
    /// Returns the path and the number of bytes written.
    pub async fn download_to(
        &self,
        url: &str,
        dest: &std::path::Path,
    ) -> Result<(std::path::PathBuf, u64), String> {
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

        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("create {}: {e}", dest.display()))?;
        let mut written: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            let chunk = chunk.map_err(|e| {
                format!("download interrupted after {written} bytes: {e}")
            })?;
            written += chunk.len() as u64;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {}: {e}", dest.display()))?;
        }
        drop(file);

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
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/stream", get(stream))
        .with_state(state)
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
        let state = Arc::new(AppState::new(port));
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
            .expect("live search");
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

        let (path, written) = state
            .download_to(&chosen.url, &dest)
            .await
            .expect("download");
        let on_disk = std::fs::metadata(&path).expect("file must exist").len();
        assert_eq!(on_disk, written, "file size must match the byte counter");
        assert!(written > 100_000, "even the smallest rendition is a real file");
        let _ = std::fs::remove_file(&path);
    }
}
