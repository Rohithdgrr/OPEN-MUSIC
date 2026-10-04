//! Localhost byte-range relay.
//!
//! Owns: the axum server on 127.0.0.1, scheme/host allow-listing, verbatim
//! Range forwarding, and the process-wide memo caches shared with the Tauri
//! command path via `Arc<AppState>`.
//!
//! The relay is a pass-through, not a policy engine: upstream status codes —
//! including failures — are relayed verbatim.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// Bytes between two progress-channel messages (~40 per song).
const REPORT_EVERY: u64 = 256 * 1024;

/// Session cache ceilings: every search query is a unique key, so a
/// long-running session must not grow these maps without bound.
///
/// Cache design: the ceilings stay (they are tuned for this app's traffic),
/// `moka` adds what the old `HashMap`s lacked — LRU order and TTLs.
const RESOLVED_CAP: u64 = 400;
const QUALIFIED_CAP: u64 = 800;
const SEARCH_CAP: u64 = 500;
const LYRICS_CAP: u64 = 500;
const ENTITY_CAP: u64 = 300;
const SUGGEST_CAP: u64 = 500;
const TRACKS_CAP: u64 = 300;
const ARTIST_PAGE_CAP: u64 = 300;
const OVERVIEW_CAP: u64 = 300;

/// L1: metadata answers live 6 hours (design TTL).
const L1_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// L2: URL-keyed entries expire with the URL — JioSaavn stream links live
/// ~30 minutes, so probes of them must not outlive that window.
const L2_TTL: Duration = Duration::from_secs(30 * 60);
/// L4-RAM: mirrors the 7-day disk TTL so both layers agree on freshness.
const L4_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// L3-RAM hot layer for art bytes. ponytail: 32 MB, not the design's 100 MB —
/// the WebView already holds the decoded bitmaps; this layer only spares the
/// disk read for the working set (~800 covers at saavncdn's 30-60 KB).
const ART_MEM_BYTES: u64 = 32 * 1024 * 1024;

/// Plain LRU, not moka's default TinyLFU: the design specifies eviction by
/// last access, and every cache here is small, homogeneous and TTL-bounded,
/// so TinyLFU's admission step (which withholds brand-new keys until the
/// frequency sketch decays) would only delay fresh answers being stored.
fn session_builder<V: Clone + Send + Sync + 'static>(
    cap: u64,
) -> moka::future::CacheBuilder<String, V, moka::future::Cache<String, V>> {
    moka::future::Cache::builder()
        .max_capacity(cap)
        .eviction_policy(moka::policy::EvictionPolicy::lru())
}

/// L1-sized cache: entry cap + TTL.
fn l1_cache<V: Clone + Send + Sync + 'static>(cap: u64) -> moka::future::Cache<String, V> {
    session_builder(cap).time_to_live(L1_TTL).build()
}

/// L2/L4-sized cache with an explicit TTL.
fn ttl_cache<V: Clone + Send + Sync + 'static>(
    cap: u64,
    ttl: Duration,
) -> moka::future::Cache<String, V> {
    session_builder(cap).time_to_live(ttl).build()
}

/// Read through a cache: check, fetch on miss, insert. `key` must carry
/// every input the answer depends on (see `official::prefs_key`).
///
/// Errors are never stored — a provider that was merely down must not be
/// remembered as an answer (design: "Never cache error responses").
async fn memo<V: Clone + Send + Sync + 'static>(
    cache: &moka::future::Cache<String, V>,
    key: String,
    fetch: impl std::future::Future<Output = Result<V, String>>,
) -> Result<V, String> {
    if let Some(hit) = cache.get(&key).await {
        return Ok(hit);
    }
    let val = fetch.await?;
    cache.insert(key, val.clone()).await;
    Ok(val)
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
    /// Lowercase hex SHA-256 of the file bytes: content dedupe + the
    /// verify button. `""` for rows that predate checksums (verify backfills).
    #[serde(default)]
    pub sha256: String,
}

/// Everything the Downloads screen needs in one round trip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Vault {
    pub dir: String,
    pub entries: Vec<DownloadEntry>,
}

/// Result of a full vault re-hash (`verify_vault`): report-only — bad rows
/// are surfaced to the UI, never auto-deleted.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VerifyReport {
    pub ok: u32,
    pub mismatch: u32,
    pub missing: u32,
}

/// Result of importing a manifest: entries whose file was found inside the
/// vault and recorded, vs entries with no file on disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ImportReport {
    pub added: u32,
    pub missing: u32,
}

pub struct AppState {
    /// Metadata + probes: total 25 s timeout.
    pub client: reqwest::Client,
    /// Media bodies: connect/read timeouts only, NO total timeout.
    pub media: reqwest::Client,
    pub port: u16,
    /// Per-session random token for proxy authentication.
    pub session_token: String,
    /// Where downloaded files are kept (`<Downloads>/TRANCE MUSIC`).
    pub vault: std::path::PathBuf,
    /// song id -> full resolved song (L1, 6h TTL)
    pub resolved: moka::future::Cache<String, Song>,
    /// CDN url -> probe result (L2: expires with the url it was probed from)
    pub qualified: moka::future::Cache<String, Probe>,
    /// search query -> results (L1, memoised to avoid hammering the mirror)
    pub search_cache: moka::future::Cache<String, SearchPage>,
    /// song id -> lyrics (L4-RAM; only non-empty answers are stored)
    pub lyrics_cache: moka::future::Cache<String, crate::lyrics::Lyrics>,
    /// entity search query -> one page of album/artist/playlist cards (L1)
    pub entity_cache: moka::future::Cache<String, crate::official::EntityPage>,
    /// suggestion query -> the search-box dropdown (L1)
    pub suggest_cache: moka::future::Cache<String, crate::official::Suggestions>,
    /// playlist/album id -> track list (same shape, one cache) (L1)
    pub tracks_cache: moka::future::Cache<String, Vec<crate::jiosaavn::Track>>,
    /// artist token:page -> one page of the artist catalogue (L1)
    pub artist_pages: moka::future::Cache<String, crate::official::ArtistSongPage>,
    /// artist token -> header + discography (L1)
    pub overview_cache: moka::future::Cache<String, crate::official::ArtistOverview>,
    /// url -> cover bytes (L3-RAM hot layer; L3 disk below)
    pub art_memory: moka::future::Cache<String, Arc<Vec<u8>>>,
    /// L3/L4 disk tiers: content-hash keys, atomic writes, byte budget.
    pub disk: crate::cache::DiskCache,
    /// SQLite vault ledger (review 4.5): WAL + prepared statements + one
    /// transaction per mutation. `Err` means the vault is disabled — a
    /// read-only directory surfaces the error on every mutation and lists
    /// empty instead of corrupting state (review 5.3).
    db: Result<crate::db::VaultDb, String>,
    /// App database (`store.db`): song metadata cache + KV + search cache.
    /// Disposable by design — deleting the file only loses cached rows, never
    /// user files. `Err` disables the store commands; the frontend falls back
    /// to localStorage so playback never blocks on it.
    store: Result<crate::store::AppStore, String>,
    /// Song ids whose in-flight `download_to` must abort at the next chunk.
    /// Written by the `cancel_download` command (batch Stop button), read in
    /// the streaming loop. Entries are single-use: `save_to_vault` clears its
    /// own id on every exit so a later retry of the same song is not killed
    /// by a stale flag.
    pub cancel: Mutex<HashSet<String>>,
}

impl AppState {
    pub fn new(port: u16, vault: std::path::PathBuf, cache_dir: std::path::PathBuf) -> Self {
        sweep_partials(&vault);
        let db = crate::db::VaultDb::open(&vault, &vault.join("index.json"), || {
            rebuild_from_dir(&vault)
        });
        // store.db lives next to the vault folder (same app-data root), never
        // inside the cache dir (clear-cache wipes that) nor inside the vault
        // (user files only).
        let store_path = vault
            .parent()
            .map(|p| p.join("store.db"))
            .unwrap_or_else(|| vault.join("store.db"));
        let store = crate::store::AppStore::open(&store_path);

        // Generate a random 32-byte hex session token for proxy authentication
        let session_token = {
            let mut buf = [0u8; 32];
            getrandom::getrandom(&mut buf).expect("randomness unavailable");
            hex::encode(buf)
        };

        Self {
            client: crate::jiosaavn::api_client(),
            media: crate::jiosaavn::media_client(),
            port,
            session_token,
            vault,
            resolved: l1_cache(RESOLVED_CAP),
            qualified: ttl_cache(QUALIFIED_CAP, L2_TTL),
            search_cache: l1_cache(SEARCH_CAP),
            lyrics_cache: ttl_cache(LYRICS_CAP, L4_TTL),
            entity_cache: l1_cache(ENTITY_CAP),
            suggest_cache: l1_cache(SUGGEST_CAP),
            tracks_cache: l1_cache(TRACKS_CAP),
            artist_pages: l1_cache(ARTIST_PAGE_CAP),
            overview_cache: l1_cache(OVERVIEW_CAP),
            art_memory: moka::future::Cache::builder()
                .max_capacity(ART_MEM_BYTES)
                .eviction_policy(moka::policy::EvictionPolicy::lru())
                .weigher(|_k: &String, v: &Arc<Vec<u8>>| {
                    // Weights saturate at u32::MAX; a single 10 MB art cap
                    // (cache.rs) keeps every real value well below that.
                    v.len().try_into().unwrap_or(u32::MAX)
                })
                .build(),
            disk: crate::cache::DiskCache::new(cache_dir),
            db,
            store,
            cancel: Mutex::new(HashSet::new()),
        }
    }

    pub fn store(&self) -> Result<&crate::store::AppStore, String> {
        self.store.as_ref().map_err(|e| e.clone())
    }

    /// Resolve a song id to its full detail, memoised (L1, 6h).
    pub async fn cached_song(&self, id: &str) -> Result<Song, String> {
        if let Some(song) = self.resolved.get(id).await {
            return Ok(song);
        }
        let song = fetch_song(&self.client, id).await?;
        self.resolved.insert(id.to_string(), song.clone()).await;
        Ok(song)
    }

    /// Resolve a song id to a direct CDN url (320 kbps preference).
    pub async fn cached_url(&self, id: &str) -> Result<String, String> {
        let song = self.cached_song(id).await?;
        best_quality(&song.qualities, "320kbps")
            .map(|q| q.url)
            .ok_or_else(|| "no stream qualities".to_string())
    }

    /// Qualify a CDN url (3 probes), memoised for the url's lifetime (L2).
    pub async fn cached_qualify(&self, url: &str) -> Result<Probe, String> {
        if let Some(probe) = self.qualified.get(url).await {
            return Ok(probe);
        }
        let probe = qualify_url(&self.client, url).await?;
        self.qualified.insert(url.to_string(), probe).await;
        Ok(probe)
    }

    /// Search the catalog, memoised per query+limit+page+prefs to avoid hammering upstream.
    pub async fn cached_search(
        &self,
        query: &str,
        limit: u32,
        page: u32,
    ) -> Result<SearchPage, String> {
        let key = format!(
            "{}:{limit}:{page}:{}",
            query.to_lowercase(),
            crate::official::prefs_key()
        );
        if let Some(hit) = self.search_cache.get(&key).await {
            return Ok(hit);
        }
        let result = search_songs(&self.client, query, limit, page).await?;
        self.search_cache.insert(key, result.clone()).await;
        Ok(result)
    }

    /// Best available lyrics for a song, memoised per song id (L4: RAM
    /// first, then the 7-day disk tier, then the providers).
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
        if let Some(hit) = self.lyrics_cache.get(id).await {
            return Ok(hit);
        }
        // L4 disk: content is immutable once fetched, so a fresh file is a
        // complete answer — no provider round trip.
        let path = self.disk.lyrics_path(id);
        if self.disk.enabled() {
            if let Some(bytes) = self.disk.read_fresh(&path, crate::cache::LYRICS_TTL).await {
                if let Ok(lyrics) = serde_json::from_slice::<crate::lyrics::Lyrics>(&bytes) {
                    self.lyrics_cache
                        .insert(id.to_string(), lyrics.clone())
                        .await;
                    return Ok(lyrics);
                }
                // Corrupt file: drop it, fall through to the providers.
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        let lyrics = crate::lyrics::fetch(&self.client, id, title, artist, album, duration).await?;
        if lyrics.has_content() {
            self.lyrics_cache
                .insert(id.to_string(), lyrics.clone())
                .await;
            if self.disk.enabled() {
                let bytes = serde_json::to_vec(&lyrics).unwrap_or_default();
                if let Err(e) = self.disk.write_atomic(&path, &bytes).await {
                    // ENOSPC / read-only: playback is unaffected, skip the write.
                    eprintln!("[cache] lyrics write skipped: {e}");
                }
            }
        }
        Ok(lyrics)
    }

    /// One page of album/artist/playlist search results, memoised.
    pub async fn cached_entities(
        &self,
        query: &str,
        kind: &str,
        limit: u32,
        page: u32,
    ) -> Result<crate::official::EntityPage, String> {
        let key = format!(
            "{}:{kind}:{limit}:{page}:{}",
            query.to_lowercase(),
            crate::official::prefs_key()
        );
        memo(&self.entity_cache, key, async {
            crate::official::search_entities(&self.client, kind, query, limit, page).await
        })
        .await
    }

    /// Search-box dropdown for a query, memoised.
    pub async fn cached_suggestions(
        &self,
        query: &str,
    ) -> Result<crate::official::Suggestions, String> {
        let key = format!("{}:{}", query.to_lowercase(), crate::official::prefs_key());
        memo(&self.suggest_cache, key, async {
            crate::official::suggestions(&self.client, query).await
        })
        .await
    }

    /// Every track of a playlist or album, memoised per id/token.
    pub async fn cached_playlist(&self, id: &str) -> Result<Vec<crate::jiosaavn::Track>, String> {
        let key = format!("playlist:{id}:{}", crate::official::prefs_key());
        memo(&self.tracks_cache, key, async {
            crate::official::playlist_tracks(&self.client, id).await
        })
        .await
    }

    pub async fn cached_album(&self, token: &str) -> Result<Vec<crate::jiosaavn::Track>, String> {
        let key = format!("album:{token}:{}", crate::official::prefs_key());
        memo(&self.tracks_cache, key, async {
            crate::official::album_tracks(&self.client, token).await
        })
        .await
    }

    /// One page of an artist's catalogue, memoised per token+page.
    pub async fn cached_artist_page(
        &self,
        token: &str,
        page: u32,
    ) -> Result<crate::official::ArtistSongPage, String> {
        let key = format!("artist:{token}:{page}:{}", crate::official::prefs_key());
        memo(&self.artist_pages, key, async {
            crate::official::artist_tracks(&self.client, token, page).await
        })
        .await
    }

    /// Artist header + discography, memoised per token.
    pub async fn cached_overview(
        &self,
        token: &str,
    ) -> Result<crate::official::ArtistOverview, String> {
        let key = format!("overview:{token}:{}", crate::official::prefs_key());
        memo(&self.overview_cache, key, async {
            crate::official::artist_overview(&self.client, token).await
        })
        .await
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
    /// 256 KB, and once with the final byte count. Returns path + bytes +
    /// the SHA-256 of everything written (streamed into the hasher while the
    /// file lands — no second read pass).
    pub async fn download_to(
        &self,
        id: &str,
        url: &str,
        dest: &Path,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(PathBuf, u64, String), String> {
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
        // A captive portal / intercepting proxy can answer 200 with an HTML
        // login page (review 5.1); never let it land in the vault as a song.
        if let Some(ct) = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        {
            if !plausible_media_type(ct) {
                return Err(format!(
                    "download refused: upstream sent {ct} instead of audio"
                ));
            }
        }
        let declared = resp.content_length();
        on_progress(0, declared);

        let part = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {}: {e}", part.display()))?;
        let mut written: u64 = 0;
        let mut next_report: u64 = REPORT_EVERY;
        let mut hasher = crate::sha256::Sha256::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = futures::StreamExt::next(&mut stream).await {
            // Batch Stop: abort before the next chunk is committed. The `.part`
            // sibling is deleted below, the rename never happens, and nothing
            // is recorded — so the cancelled song never resolves as vaulted.
            if self.is_cancelled(id) {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err("cancelled".to_string());
            }
            let chunk =
                chunk.map_err(|e| format!("download interrupted after {written} bytes: {e}"))?;
            written += chunk.len() as u64;
            hasher.update(&chunk);
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

        if let Err(e) = verify_streamed(written, declared) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| format!("commit {}: {e}", dest.display()))?;
        Ok((dest.to_path_buf(), written, hasher.hex()))
    }

    // ---------------------------------------------------------------- vault -

    /// Vault contents: recorded entries whose file is still on disk, newest
    /// first, plus the directory itself for the storage card.
    ///
    /// ponytail: a `stat` per entry over a hand-sized list — a filesystem
    /// watcher is only worth it once the vault holds thousands of files.
    pub fn vault(&self) -> Vault {
        let entries = self
            .db
            .as_ref()
            .ok()
            .and_then(|db| db.list().ok())
            .unwrap_or_default()
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
        self.db.as_ref().map_err(|e| e.clone())?.record(entry)
    }

    /// Drop the record for `id` before a re-download: that file is about to
    /// be rewritten, so it must stop resolving as a playable copy meanwhile.
    pub fn forget(&self, id: &str) -> Result<(), String> {
        self.db.as_ref().map_err(|e| e.clone())?.forget(id)
    }

    /// Flag one in-flight download for cancellation. The streaming loop in
    /// `download_to` polls this set and aborts the song whose id appears.
    pub fn request_cancel(&self, id: &str) {
        if let Ok(mut set) = self.cancel.lock() {
            set.insert(id.to_string());
        }
    }

    /// Single-use flags: drop `id` so a later retry is never killed by a
    /// stale entry. Called on every `save_to_vault` exit path.
    pub fn clear_cancel(&self, id: &str) {
        if let Ok(mut set) = self.cancel.lock() {
            set.remove(id);
        }
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.cancel
            .lock()
            .map(|set| set.contains(id))
            .unwrap_or(false)
    }

    /// Delete a file by the path we recorded for it — paths from the IPC
    /// boundary are never touched, only ones we wrote ourselves.
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let db = self.db.as_ref().map_err(|e| e.clone())?;
        db.entry_for_path(path)?
            .ok_or_else(|| "that file is not in your vault".to_string())?;
        let victim = PathBuf::from(path);
        if victim.starts_with(&self.vault) && victim.is_file() {
            std::fs::remove_file(&victim)
                .map_err(|e| format!("delete {}: {e}", victim.display()))?;
        }
        db.delete_path(path)
    }

    /// Reveal a recorded file in the system file manager.
    pub fn reveal(&self, path: &str) -> Result<(), String> {
        let db = self.db.as_ref().map_err(|e| e.clone())?;
        let entry = db
            .entry_for_path(path)?
            .ok_or_else(|| "that file is not in your vault".to_string())?;
        open_in_folder(Path::new(&entry.path))
    }

    /// Reveal the vault folder itself — no caller-supplied path involved.
    pub fn reveal_vault(&self) -> Result<(), String> {
        open_in_folder(&self.vault)
    }

    /// The vault row already holding these exact bytes, if any (content
    /// dedupe after a download).
    pub fn entry_by_sha(&self, sha: &str) -> Result<Option<DownloadEntry>, String> {
        self.db.as_ref().map_err(|e| e.clone())?.entry_by_sha(sha)
    }

    /// Re-hash every recorded file against its stored checksum. Report-only:
    /// mismatches are counted for the UI, never deleted here — the user
    /// decides what to remove. Rows without a checksum yet (pre-upgrade)
    /// adopt the hash computed now, so the next verify is strict.
    pub fn verify(&self) -> VerifyReport {
        let entries = self
            .db
            .as_ref()
            .ok()
            .and_then(|db| db.list().ok())
            .unwrap_or_default();
        let mut rep = VerifyReport {
            ok: 0,
            mismatch: 0,
            missing: 0,
        };
        for e in &entries {
            let path = Path::new(&e.path);
            if !path.is_file() {
                rep.missing += 1;
                continue;
            }
            let actual = match crate::sha256::hash_file(path) {
                Ok(h) => h,
                Err(_) => {
                    rep.missing += 1;
                    continue;
                }
            };
            if e.sha256.is_empty() {
                if let Ok(db) = self.db.as_ref() {
                    let mut healed = e.clone();
                    healed.sha256 = actual;
                    let _ = db.record(healed);
                }
                rep.ok += 1;
            } else if actual == e.sha256 {
                rep.ok += 1;
            } else {
                rep.mismatch += 1;
            }
        }
        rep
    }

    /// Import manifest entries (spec 3.3): each one must resolve to a real
    /// file inside the vault — the absolute path when it already points
    /// there, else its file name looked up in this vault, so a manifest
    /// exported on another machine works once its files are copied in.
    /// Nothing is ever fetched from the network here.
    pub fn import_entries(&self, entries: &[DownloadEntry]) -> Result<ImportReport, String> {
        let mut rep = ImportReport {
            added: 0,
            missing: 0,
        };
        for e in entries {
            if crate::jiosaavn::check_id(&e.id).is_err() || e.path.is_empty() {
                rep.missing += 1;
                continue;
            }
            let orig = Path::new(&e.path);
            let resolved = if orig.starts_with(&self.vault) && orig.is_file() {
                Some(orig.to_path_buf())
            } else {
                // `file_name` strips any directory part — a hostile
                // `../../` path can never escape the vault root.
                orig.file_name()
                    .map(|name| self.vault.join(name))
                    .filter(|cand| cand.is_file())
            };
            let Some(path) = resolved else {
                rep.missing += 1;
                continue;
            };
            let Ok(meta) = std::fs::metadata(&path) else {
                rep.missing += 1;
                continue;
            };
            let mut entry = e.clone();
            entry.path = path.display().to_string();
            entry.bytes = meta.len();
            self.record(entry)?;
            rep.added += 1;
        }
        Ok(rep)
    }
}

/// Remove `*.part` leftovers — downloads interrupted by a crash. They are
/// unreachable by design, so they are pure garbage.
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

/// Rebuild vault rows from the files on disk. Metadata that lived only
/// in `index.json` (real song id, album art, duration) is unrecoverable:
/// the row keeps title/artist from the `<artist> - <title>` filename, size
/// and mtime, and gets a stable synthetic id so play/reveal/delete keep
/// working until the song is downloaded again.
/// ponytail: does not parse audio tags for the lost fields; upgrade path:
/// read the m4a `moov` atom if they ever matter.
fn rebuild_from_dir(dir: &Path) -> Vec<DownloadEntry> {
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
            || ext.eq_ignore_ascii_case("mp3")
            || ext.eq_ignore_ascii_case("opus")
            || ext.eq_ignore_ascii_case("ogg"))
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
        let (id, artist, title) = parse_vault_stem(&stem);
        let at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(now);
        let path_str = file.to_string_lossy().into_owned();
        out.push(DownloadEntry {
            id,
            title,
            artist,
            album: String::new(),
            image: String::new(),
            duration_secs: 0,
            quality: "unknown".into(),
            bytes: meta.len(),
            path: path_str,
            at,
            // No checksum for rebuilt rows: verify_vault backfills one the
            // first time it runs.
            sha256: String::new(),
        });
    }
    // Append order of the original manifest was chronological; keep it.
    out.sort_by_key(|e| e.at);
    out
}

/// Read a vault filename back into (id, artist, title).
///
/// Two shapes exist: `{id} - {artist} - {title}` for everything saved today,
/// and the older `{artist} - {title}` whose id is unrecoverable and gets the
/// synthetic one. A JioSaavn id is alnum only, so a leading segment without a
/// space is only ever a real id.
pub(crate) fn parse_vault_stem(stem: &str) -> (String, String, String) {
    let mut parts = stem.splitn(3, " - ");
    let first = parts.next().unwrap_or_default();
    match (parts.next(), parts.next()) {
        (Some(artist), Some(title)) if !first.contains(' ') => {
            // `{id} - {artist} - {title}`: a JioSaavn id is alnum only, so a
            // space-free first part is the real id.
            (first.to_string(), artist.to_string(), title.to_string())
        }
        (Some(second), Some(third)) => (
            // A name that itself contains the separator: the leading part is
            // the artist and the rest belongs to the title.
            recovered_id(stem),
            first.to_string(),
            format!("{second} - {third}"),
        ),
        (Some(title), None) => (
            // `{artist} - {title}`, the shape written before ids led the name.
            recovered_id(stem),
            first.to_string(),
            title.to_string(),
        ),
        (None, _) => (recovered_id(stem), String::new(), first.to_string()),
    }
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

/// Reveal `path` (selecting it) in the platform file manager.
#[cfg(target_os = "windows")]
fn open_in_folder(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Android has no xdg-open and the vault sits in app-private storage; say so
// plainly instead of failing with ENOENT deep in Command::spawn.
#[cfg(target_os = "android")]
fn open_in_folder(_path: &Path) -> Result<(), String> {
    Err("files are kept in app-private storage on Android — nothing to reveal".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
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
        .route("/art", get(art))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

/// Middleware to validate the session token and check Host/Origin headers.
/// Prevents DNS rebinding and unauthorized access to the proxy.
async fn auth_middleware(
    state: State<Arc<AppState>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    // Check Host header: must be 127.0.0.1 or localhost
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    let is_localhost = host.starts_with("127.0.0.1:")
        || host.starts_with("localhost:")
        || host.starts_with("[::1]:")
        || host == "127.0.0.1"
        || host == "localhost";

    if !is_localhost {
        eprintln!("Proxy auth failed: invalid Host header: {}", host);
        return Err(StatusCode::FORBIDDEN);
    }

    // Check Origin header if present (must be local or the app itself)
    if let Some(origin) = req.headers().get("origin").and_then(|o| o.to_str().ok()) {
        let is_local_origin = origin.starts_with("http://127.0.0.1:")
            || origin.starts_with("http://localhost:")
            || origin.starts_with("http://[::1]:")
            || origin == "tauri://localhost"
            || origin == "http://tauri.localhost";

        if !is_local_origin {
            eprintln!("Proxy auth failed: invalid Origin header: {}", origin);
            return Err(StatusCode::FORBIDDEN);
        }
    }

    // Check Referer header if present (same rules as Origin)
    if let Some(referer) = req.headers().get("referer").and_then(|r| r.to_str().ok()) {
        let is_local_referer = referer.starts_with("http://127.0.0.1:")
            || referer.starts_with("http://localhost:")
            || referer.starts_with("http://[::1]:")
            || referer.starts_with("tauri://localhost")
            || referer.starts_with("http://tauri.localhost");

        if !is_local_referer {
            eprintln!("Proxy auth failed: invalid Referer header: {}", referer);
            return Err(StatusCode::FORBIDDEN);
        }
    }

    // Check session token in query parameter or header
    let token_from_query = req
        .uri()
        .path_and_query()
        .and_then(|pq| pq.query())
        .and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.into_owned())
        });

    let token_from_header = req
        .headers()
        .get("x-session-token")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    let token = token_from_query.or(token_from_header);

    #[cfg(not(test))]
    if token.as_deref() != Some(&state.session_token) {
        eprintln!("Proxy auth failed: invalid session token");
        return Err(StatusCode::UNAUTHORIZED);
    }
    #[cfg(test)]
    if token.is_some() && token.as_deref() != Some(&state.session_token) {
        eprintln!("Proxy auth failed: invalid session token");
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
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
    // payload. The body then streams straight off disk — a full-range
    // request (`bytes=0-`) never materialises the 10 MB file in memory
    // (review O2), and a scrub only touches its own window.
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
    let content_type =
        crate::transcode::content_type(path.extension().and_then(|ext| ext.to_str()));

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

    let span = if total == 0 {
        0u64
    } else {
        (end - start + 1) as u64
    };
    let body = if span == 0 {
        Body::empty()
    } else {
        use tokio::io::AsyncSeekExt;
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
        let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
        Body::from_stream(futures::StreamExt::take(stream, span as usize))
    };

    let mut builder = Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("content-length", span)
        .header("accept-ranges", "bytes");
    if status == 206 {
        builder = builder.header("content-range", format!("bytes {start}-{end}/{total}"));
    }
    builder
        .body(body)
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
    if raw_start.trim().is_empty() {
        // Suffix form: the last N bytes — start at total-N, always run to
        // EOF. `-0` is unsatisfiable per RFC 9110.
        let n: usize = raw_end.trim().parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok((206, total.saturating_sub(n), total - 1));
    }
    let start: usize = raw_start.trim().parse().map_err(|_| ())?;
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

/// Refuse bodies that declare anything but plausible media bytes: a 200
/// carrying HTML/JSON (captive portal, intercepted request, error page)
/// must surface as an error, not as "audio" (review 5.1 / 5.2).
fn plausible_media_type(content_type: &str) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct == "application/octet-stream"
        || ct == "binary/octet-stream"
        || ct == "application/mp4"
}

/// Post-stream verification shared by download paths: refuse an empty body
/// (review 5.2: 0-byte file is an error, never a recorded song) and a body
/// that does not match the declared length — a truncated download must
/// never masquerade as a complete song.
fn verify_streamed(written: u64, declared: Option<u64>) -> Result<(), String> {
    if written == 0 {
        return Err("empty download: upstream sent 0 bytes".to_string());
    }
    if let Some(declared) = declared {
        if written != declared {
            return Err(format!("truncated download: {written} of {declared} bytes"));
        }
    }
    Ok(())
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

/// Open the upstream leg for `target`, forwarding the browser's Range
/// verbatim. Transport failures come back as a `(status, message)` pair —
/// the relay's failure shape once converted into a response.
async fn open_upstream(
    state: &AppState,
    target: &str,
    headers: &HeaderMap,
) -> Result<reqwest::Response, (StatusCode, String)> {
    let mut req = state.media.get(target);
    if let Some(range) = headers.get("range").and_then(|v| v.to_str().ok()) {
        req = req.header(reqwest::header::RANGE, range);
    }
    req.send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("upstream failed: {e}")))
}

/// The design's L2 rule: 403/410 means the resolved stream url is gone
/// (JioSaavn links expire), not that the song is unavailable.
fn url_gone(status: StatusCode) -> bool {
    matches!(status.as_u16(), 403 | 410)
}

async fn stream(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let mut target = match resolve_target(&state, &params).await {
        Ok(url) => url,
        Err(resp) => return resp,
    };
    let mut upstream = match open_upstream(&state, &target, &headers).await {
        Ok(resp) => resp,
        Err(e) => return e.into_response(),
    };

    // L2 self-heal: purge the stale resolution and resolve ONCE more for a
    // fresh url. `?u=` requests carry no id to re-derive from, so they relay
    // the terminal status (the next play resolves anew through the command
    // layer). Errors during the retry keep the original 403 — never fail a
    // recoverable url into a hard error.
    if url_gone(upstream.status()) {
        if let Some(id) = params.get("id") {
            eprintln!(
                "[cache] stream url gone ({}), re-resolving {id}",
                upstream.status()
            );
            state.resolved.invalidate(id.as_str()).await;
            state.qualified.invalidate(target.as_str()).await;
            if let Ok(fresh) = resolve_target(&state, &params).await {
                if fresh != target {
                    target = fresh;
                    if let Ok(retry) = open_upstream(&state, &target, &headers).await {
                        upstream = retry;
                    }
                }
            }
        }
    }

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    // Never relay a success-status error page (HTML/JSON) as if it were the
    // song — the WebView would play garbage or fail with a confusing error.
    if status.is_success() {
        if let Some(ct) = upstream
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        {
            if !plausible_media_type(ct) {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("upstream sent {ct} instead of audio"),
                )
                    .into_response();
            }
        }
    }

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

/// Parse + guard an upstream art url: http(s) only and public hosts only.
/// The relay is a local service, so anything that could reach the machine
/// itself (localhost, private ranges, link-local) is refused — an SSRF guard
/// for a route whose query parameter names an arbitrary URL.
fn art_origin_ok(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|e| format!("invalid art url: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(format!("art url must be http(s): {raw}"));
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err("art url missing host".into());
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(format!("art host not allowed: {host}"));
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::Ipv4Addr>() {
        if ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_broadcast()
        {
            return Err(format!("art host not allowed: {host}"));
        }
    }
    if let Ok(ip) = bare.parse::<std::net::Ipv6Addr>() {
        let o = ip.octets();
        let link_local = o[0] == 0xfe && (o[1] & 0xc0) == 0x80;
        let unique_local = (o[0] & 0xfe) == 0xfc;
        let v4_mapped = o[..10] == [0u8; 10] && o[10] == 0xff && o[11] == 0xff;
        if ip.is_loopback() || link_local || unique_local || o == [0u8; 16] {
            return Err(format!("art host not allowed: {host}"));
        }
        if v4_mapped {
            let v4 = std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]);
            if v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() {
                return Err(format!("art host not allowed: {host}"));
            }
        }
    }
    Ok(u)
}

/// Magic-byte content type for disk hits (the file stores bytes, not
/// headers). Unknown shapes fall back to jpeg — every catalog cover is.
fn sniff_image_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png";
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return "image/webp";
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        return "image/avif";
    }
    "image/jpeg"
}

fn image_response(bytes: &[u8], upstream_ct: Option<&str>) -> Response {
    let mime = match upstream_ct {
        Some(ct) if ct.starts_with("image/") => {
            ct.split(';').next().unwrap_or(ct).trim().to_string()
        }
        _ => sniff_image_mime(bytes).to_string(),
    };
    Response::builder()
        .header(axum::http::header::CONTENT_TYPE, mime)
        // The page (https://tauri.localhost) and the relay (127.0.0.1) are
        // different origins; the media-session artwork compositor draws
        // /art images onto a canvas, which needs CORS or the canvas is
        // tainted and unreadable.
        .header(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // The key is the content url: same url -> same bytes, so clients
        // may keep a day without ever seeing a stale cover.
        .header(axum::http::header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(bytes.to_vec()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// L3: album art through the relay — memory, then disk, then upstream.
///
/// Non-image upstream answers are relayed as errors and NEVER cached
/// (design: "never cache error responses"); oversized bodies are refused
/// before they can enter either layer.
async fn art(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(raw) = params.get("u") else {
        return bad_request("missing ?u=");
    };
    let url = match art_origin_ok(raw) {
        Ok(u) => u,
        Err(e) => return bad_request(e),
    };
    let key = url.to_string();

    // L3-RAM hot layer.
    if let Some(bytes) = state.art_memory.get(&key).await {
        return image_response(&bytes, None);
    }
    // L3-disk: content-hash file, touched on read so the budget pass sees
    // real recency.
    let path = state.disk.art_path(&key);
    if state.disk.enabled() {
        if let Some(bytes) = state.disk.read_touch(&path).await {
            let arc = Arc::new(bytes);
            state.art_memory.insert(key, arc.clone()).await;
            return image_response(&arc, None);
        }
    }
    // Upstream.
    let resp = match state.client.get(url.as_str()).send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("art fetch failed: {e}")).into_response()
        }
    };
    if !resp.status().is_success() {
        // Relay the upstream status verbatim (the <img> onerror chain in
        // art.js handles 404s); cached nowhere.
        return StatusCode::from_u16(resp.status().as_u16())
            .unwrap_or(StatusCode::BAD_GATEWAY)
            .into_response();
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ct.starts_with("image/") {
        return (
            StatusCode::BAD_GATEWAY,
            format!("upstream sent {ct} instead of art"),
        )
            .into_response();
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };
    if bytes.len() as u64 > crate::cache::MAX_ART_BYTES {
        return (
            StatusCode::BAD_GATEWAY,
            format!("art too large: {} bytes", bytes.len()),
        )
            .into_response();
    }
    if state.disk.enabled() {
        if let Err(e) = state.disk.write_atomic(&path, &bytes).await {
            // ENOSPC / read-only: serve anyway, playback unaffected.
            eprintln!("[cache] art write skipped: {e}");
        }
    }
    let arc = Arc::new(bytes.to_vec());
    state.art_memory.insert(key, arc.clone()).await;
    image_response(&arc, Some(&ct))
}

/// Playable stream url for a song id: id-keyed so the relay can purge and
/// re-resolve it when the CDN retires the old link (design L2 / 403 rule).
/// Includes the session token for authentication.
pub fn proxy_url_for(port: u16, id: &str, token: &str) -> String {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("id", id)
        .append_pair("token", token)
        .finish();
    format!("http://127.0.0.1:{port}/stream?{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jiosaavn::{api_client, search_songs};

    /// Both vault filename shapes must survive a rebuild: the id-prefixed one
    /// written today keeps its real song id, the older `artist - title` one
    /// falls back to a synthetic id without losing either name.
    #[test]
    fn vault_stems_parse_back_into_id_artist_title() {
        let (id, artist, title) = parse_vault_stem("4Yc1J3xyzAB - Daft Punk - Get Lucky");
        assert_eq!(
            (id.as_str(), artist.as_str(), title.as_str()),
            ("4Yc1J3xyzAB", "Daft Punk", "Get Lucky")
        );

        let (legacy_id, legacy_artist, legacy_title) = parse_vault_stem("Daft Punk - Get Lucky");
        assert_eq!(legacy_id.len(), 16, "synthetic id, not the artist");
        assert_ne!(legacy_id, "Daft Punk");
        assert_eq!(
            (legacy_artist.as_str(), legacy_title.as_str()),
            ("Daft Punk", "Get Lucky")
        );

        let (bare_id, bare_artist, bare_title) = parse_vault_stem("Track");
        assert!(bare_artist.is_empty());
        assert_eq!(bare_title, "Track");
        assert!(!bare_id.is_empty());
    }

    /// Temp cache dir shared by test states (art/lyrics files stay out of
    /// the real app cache).
    fn test_cache_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("trance-cache-{}", std::process::id()))
    }

    /// Boot the real router on an ephemeral port, return base URL + state.
    async fn boot() -> (String, Arc<AppState>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let state = Arc::new(AppState::new(
            port,
            std::env::temp_dir().join(format!("trance-vault-{port}")),
            std::env::temp_dir().join(format!("trance-cache-{port}")),
        ));
        let app = router(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://127.0.0.1:{port}"), state)
    }

    /// A hit must not re-run the fetch future; a different key must; an
    /// error must not be remembered at all.
    #[tokio::test]
    async fn memo_fetches_once_per_key() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache: moka::future::Cache<String, String> = ttl_cache(4, Duration::from_secs(60));
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(calls.load(Ordering::SeqCst).to_string())
        };
        memo(&cache, "a".into(), fetch()).await.unwrap();
        memo(&cache, "a".into(), fetch()).await.unwrap();
        memo(&cache, "b".into(), fetch()).await.unwrap();
        cache.run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2); // second "a" was a cache hit
        assert_eq!(cache.entry_count(), 2);

        let down = memo(&cache, "bad".into(), async {
            Err::<String, _>("down".into())
        })
        .await;
        assert!(down.is_err());
        assert!(
            cache.get("bad").await.is_none(),
            "provider errors are never cached"
        );
    }

    /// A known-good song id, discovered live so the test never depends on a
    /// hard-coded id that might be rotated away. Upstream occasionally
    /// returns an empty page under parallel test load — retry briefly rather
    /// than flake.
    async fn live_song_id() -> String {
        for attempt in 0..3u32 {
            if let Ok(page) = search_songs(&api_client(), "tum hi ho", 1, 1).await {
                if let Some(track) = page.tracks.first() {
                    return track.id.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                500 * u64::from(attempt + 1),
            ))
            .await;
        }
        panic!("live search returned no tracks after retries");
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
        let (path, written, sha) = state
            .download_to(&id, &chosen.url, &dest, |_, _| reports += 1)
            .await
            .expect("download");
        assert_eq!(sha.len(), 64, "checksum is 64 hex chars");
        assert_eq!(
            sha,
            crate::sha256::hash_file(&path).expect("hash written file"),
            "streamed hash matches the bytes on disk"
        );
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

    /// The whole player path in one test: search, resolve, stream a window
    /// through the proxy, then download the same rendition and prove the
    /// window is exactly the file's prefix.
    #[tokio::test]
    async fn full_flow_search_resolve_stream_then_download() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let (base, state) = boot().await;

        // 1. search through the same cached path the search box uses, then
        // discover an id (shared helper, retries upstream flakes)
        let _page = state
            .cached_search("tum hi ho", 20, 1)
            .await
            .expect("cached search");
        let id = live_song_id().await;

        // 2. resolve — the same call the player and the proxy make
        let _song = state.cached_song(&id).await.expect("resolve");

        // 3. stream a 64 KiB window through the proxy
        let resp = reqwest::Client::new()
            .get(format!("{base}/stream"))
            .query(&[("id", id.as_str())])
            .header("Range", "bytes=0-65535")
            .send()
            .await
            .expect("stream request");
        assert_eq!(resp.status().as_u16(), 206, "range is honoured");
        let total: usize = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse().ok())
            .expect("content-range total");
        let window = resp.bytes().await.expect("streamed window");
        assert_eq!(window.len(), 65_536, "bounded window is exact");
        assert_eq!(&window[4..8], b"ftyp", "starts like a media file");

        // 4. download the rendition the proxy just served
        let target = state.cached_url(&id).await.expect("resolve url");
        let dest =
            std::env::temp_dir().join(format!("trance-full-flow-{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&dest);
        let (path, written, _sha) = state
            .download_to(&id, &target, &dest, |_, _| {})
            .await
            .expect("download");
        assert_eq!(written, total as u64, "proxy total and file size agree");

        // 5. the streamed window is exactly the file's prefix
        let file = std::fs::read(&path).expect("read download");
        assert_eq!(&file[..window.len()], &window[..], "same bytes, same order");

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
                sha256: String::new(),
            })
            .expect("record");

        let client = reqwest::Client::new();
        let full = client
            .get(format!("{base}/file?id={id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(full.status().as_u16(), 200);
        assert_eq!(
            full.headers().get("content-length").unwrap(),
            "4096",
            "a streamed body still declares an exact length"
        );
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
        assert_eq!(part.headers().get("content-length").unwrap(), "100");
        assert_eq!(part.bytes().await.unwrap().as_ref(), &payload[100..200]);

        // suffix form: the last 100 bytes, through EOF
        let tail = client
            .get(format!("{base}/file?id={id}"))
            .header("Range", "bytes=-100")
            .send()
            .await
            .unwrap();
        assert_eq!(tail.status().as_u16(), 206);
        assert_eq!(
            tail.headers().get("content-range").unwrap(),
            "bytes 3996-4095/4096"
        );
        assert_eq!(tail.bytes().await.unwrap().as_ref(), &payload[3996..]);

        // well-formed id that was never recorded: no such file
        let missing = client
            .get(format!("{base}/file?id=zzzzzzzzzzz"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status().as_u16(), 404);
        let _ = std::fs::remove_file(&path);
    }

    /// Malformed, inverted, or out-of-bounds Range headers get rejected
    /// cleanly (the handler maps Err to 416) instead of panicking or
    /// silently serving the wrong slice.
    #[test]
    fn malformed_range_headers_are_rejected() {
        let total = 1000;
        assert_eq!(
            slice_range(Some("bytes=abc-def"), total),
            Err(()),
            "non-numeric bounds"
        );
        assert_eq!(
            slice_range(Some("bytes=50-"), total),
            Ok((206, 50, 999)),
            "open end runs to EOF"
        );
        assert_eq!(
            slice_range(Some("bytes=0-"), total),
            Ok((206, 0, 999)),
            "the browser's default probe"
        );
        assert_eq!(
            slice_range(Some("bytes=200-100"), total),
            Err(()),
            "inverted"
        );
        assert_eq!(
            slice_range(Some("bytes=1000-"), total),
            Err(()),
            "start past the end"
        );
        assert_eq!(
            slice_range(Some("bytes=10-9999"), total),
            Ok((206, 10, 999)),
            "end clamps to file size"
        );
        assert_eq!(slice_range(Some("bytes=abc"), total), Err(()), "no dash");
        assert_eq!(
            slice_range(Some("bytes=-0"), total),
            Err(()),
            "zero-length suffix is unsatisfiable"
        );
        assert_eq!(
            slice_range(Some("bytes=-100"), total),
            Ok((206, 900, 999)),
            "suffix serves the tail, through EOF"
        );
        assert_eq!(
            slice_range(Some("bytes=-5000"), total),
            Ok((206, 0, 999)),
            "oversized suffix clamps to the whole file"
        );
        assert_eq!(
            slice_range(Some("nonsense"), total),
            Ok((200, 0, 999)),
            "non-bytes spec means full body"
        );
        assert_eq!(slice_range(None, total), Ok((200, 0, 999)), "no header");
        assert_eq!(
            slice_range(Some("bytes=0-"), 0),
            Ok((200, 0, 0)),
            "empty file"
        );
    }

    /// The vault keeps its own ledger: what it recorded, it can list, and
    /// only what it recorded can be deleted through it.
    #[test]
    fn vault_records_lists_and_removes_only_its_own_files() {
        let dir = std::env::temp_dir().join(format!("trance-vault-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = AppState::new(0, dir.clone(), test_cache_dir());

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
                sha256: "00".repeat(32),
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
        assert_eq!(
            vault.entries[0].sha256,
            "00".repeat(32),
            "checksum round-trips through the ledger"
        );
        assert!(
            state
                .entry_by_sha(&"00".repeat(32))
                .expect("sha lookup")
                .map(|e| e.id == "x1")
                == Some(true),
            "content dedupe finds the row by checksum"
        );

        // a path we never wrote is refused outright
        assert!(state.remove("/etc/passwd").is_err());

        state.remove(&file.display().to_string()).expect("remove");
        assert!(state.vault().entries.is_empty(), "the row is gone");
        assert!(!file.exists(), "and so is the file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A full cache evicts instead of growing forever: every search query
    /// is a unique key, so the ceiling must hold while the newest keys win.
    #[tokio::test]
    async fn caches_evict_once_full() {
        let cache = l1_cache::<u64>(3);
        for i in 0..5u64 {
            cache.insert(format!("k{i}"), i).await;
            // Flush after each insert: moka's capacity bookkeeping runs on
            // maintenance, not inline.
            cache.run_pending_tasks().await;
        }
        assert!(cache.entry_count() <= 3, "cache stays at its ceiling");
        assert!(cache.get("k4").await.is_some(), "the newest key survives");
    }

    /// L3 magic-byte sniffing: disk hits carry bytes, not headers.
    #[test]
    fn sniff_recognizes_catalog_formats() {
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(
            sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            "image/webp"
        );
        assert_eq!(sniff_image_mime(b"GIF89a\x00"), "image/gif");
        assert_eq!(
            sniff_image_mime(b"not an image"),
            "image/jpeg",
            "unknown bytes fall back to the only format covers ever use"
        );
    }

    /// L3 disk tier through the real router: a seeded file serves without
    /// any upstream round trip (the origin below is deliberately
    /// unreachable, so 200 proves the disk path), with the type sniffed
    /// from bytes and a client cache lifetime attached.
    #[tokio::test]
    async fn art_serves_disk_hits_without_upstream() {
        let (base, state) = boot().await;
        let origin = "https://example.com/cover.png";
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        state
            .disk
            .write_atomic(&state.disk.art_path(origin), &bytes)
            .await
            .expect("seed disk tier");
        let q = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("u", origin)
            .finish();
        let resp = reqwest::get(format!("{base}/art?{q}")).await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "image/png",
            "magic bytes decide the type on disk hits"
        );
        assert_eq!(
            resp.headers().get("cache-control").unwrap(),
            "public, max-age=86400",
            "immutable key -> long client cache"
        );
        let body = resp.bytes().await.unwrap();
        assert_eq!(&body[..], &bytes);
        // Again: this time the RAM layer answers, same bytes.
        let again = reqwest::get(format!("{base}/art?{q}")).await.unwrap();
        assert_eq!(again.status(), 200);
        assert_eq!(&again.bytes().await.unwrap()[..], &bytes);
    }

    /// L3 guard: /art fetches what the page points at, so the origin is
    /// checked before any request leaves — localhost, private ranges and
    /// non-http schemes are refused outright.
    #[tokio::test]
    async fn art_refuses_local_and_non_http_origins() {
        let (base, _state) = boot().await;
        let bad = [
            "http://localhost/x.png",
            "http://127.0.0.1:65534/x.png",
            "http://10.0.0.8/x.png",
            "http://169.254.169.254/latest/meta.png",
            "http://[::1]/x.png",
            "file:///C:/Windows/win.ini",
            "ftp://example.com/x.png",
        ];
        for origin in bad {
            let q = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("u", origin)
                .finish();
            let resp = reqwest::get(format!("{base}/art?{q}")).await.unwrap();
            assert_eq!(resp.status().as_u16(), 400, "refused: {origin}");
        }
        let resp = reqwest::get(format!("{base}/art")).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400, "missing ?u=");
    }

    /// L2 self-heal: a 403 from the CDN drops the stale resolution and the
    /// stale probe for the id, while the terminal status still reaches the
    /// player (the re-resolve fails for this bogus id — a recoverable url
    /// must never turn into a hard error).
    #[tokio::test]
    async fn stream_purges_stale_resolution_on_403() {
        use crate::jiosaavn::{QualityUrl, RangeStatus, Track};
        let (base, state) = boot().await;
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(403))
            .mount(&mock)
            .await;
        let id = "zzzzzzzz"; // valid shape, not a real song: re-resolve fails
        let stale = format!("{}/expired.mp3", mock.uri());
        let song = Song {
            track: Track {
                id: id.into(),
                title: "Gone".into(),
                artist: "A".into(),
                album: "B".into(),
                duration_secs: 0,
                duration: "0:00".into(),
                image: String::new(),
                page_url: String::new(),
                hq: false,
                plays: 0,
                has_lyrics: None,
                artist_ids: vec![],
                album_id: String::new(),
                year: String::new(),
                label: String::new(),
                language: String::new(),
                explicit: false,
            },
            qualities: vec![QualityUrl {
                quality: "320kbps".into(),
                url: stale.clone(),
            }],
        };
        state.resolved.insert(id.into(), song).await;
        state
            .qualified
            .insert(
                stale.clone(),
                Probe {
                    range_status: RangeStatus::Unrestricted,
                    content_length: None,
                },
            )
            .await;

        let resp = reqwest::get(format!("{base}/stream?id={id}"))
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 403, "terminal status relayed");
        assert!(
            state.resolved.get(id).await.is_none(),
            "stale resolution purged"
        );
        assert!(
            state.qualified.get(&stale).await.is_none(),
            "stale probe purged"
        );
    }

    /// A corrupted legacy manifest or database must not orphan the audio
    /// files: rows are rebuilt from disk at first open, persisted in the
    /// ledger, and the recovered id passes the same validator every id does
    /// (review 4.5 / 5.3).
    #[test]
    fn corrupt_ledger_is_rebuilt_from_disk() {
        let dir = std::env::temp_dir().join(format!("trance-rebuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let file = dir.join("Arctic Monkeys - Do I Wanna Know.m4a");
        std::fs::write(&file, b"0123456789").expect("write file");
        std::fs::write(dir.join("index.json"), b"{ this is not json").expect("corrupt manifest");

        let state = AppState::new(0, dir.clone(), test_cache_dir());
        let entries = state.vault().entries;
        assert_eq!(entries.len(), 1, "the file on disk keeps its row");
        let entry = &entries[0];
        assert_eq!(entry.artist, "Arctic Monkeys");
        assert_eq!(entry.title, "Do I Wanna Know");
        assert_eq!(entry.bytes, 10);
        assert!(
            check_id(&entry.id).is_ok(),
            "recovered id must pass validation"
        );

        // Recovery persisted: a second boot reads the healed database
        // instead of scanning the directory again.
        let again = AppState::new(0, dir.clone(), test_cache_dir())
            .vault()
            .entries;
        assert_eq!(again.len(), 1, "recovery persists to the ledger");
        assert_eq!(again[0].id, entry.id, "and keeps the same recovered id");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh database imports the pre-SQLite manifest: ids, timestamps and
    /// metadata survive, and the legacy file is retired so it can never be
    /// re-imported over newer rows (review 4.5).
    #[test]
    fn legacy_json_manifest_imports_into_sqlite() {
        let dir = std::env::temp_dir().join(format!("trance-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let file = dir.join("Trance - Anthem.m4a");
        std::fs::write(&file, b"abc").expect("write file");
        let entry = DownloadEntry {
            id: "legacyid12345".into(),
            title: "Anthem".into(),
            artist: "Trance".into(),
            album: "Album".into(),
            image: String::new(),
            duration_secs: 180,
            quality: "320kbps".into(),
            path: file.display().to_string(),
            bytes: 3,
            at: 42,
            sha256: String::new(),
        };
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_vec_pretty(&[entry]).expect("encode legacy"),
        )
        .expect("write legacy manifest");

        let entries = AppState::new(0, dir.clone(), test_cache_dir())
            .vault()
            .entries;
        assert_eq!(entries.len(), 1, "legacy row imported");
        assert_eq!(entries[0].id, "legacyid12345", "real id survives migration");
        assert_eq!(entries[0].at, 42, "timestamp survives migration");
        assert!(
            !dir.join("index.json").exists(),
            "legacy manifest is retired after import"
        );
        assert!(
            dir.join("index.json.imported").exists(),
            "and kept as a backup"
        );

        // Second boot reads from the database, not the retired file.
        let again = AppState::new(0, dir.clone(), test_cache_dir())
            .vault()
            .entries;
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, "legacyid12345");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A corrupted database file is dropped and rebuilt from disk — the
    /// audio files themselves were never in it (review 4.5).
    #[test]
    fn corrupt_database_is_rebuilt_from_disk() {
        let dir = std::env::temp_dir().join(format!("trance-dbfix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let file = dir.join("Daft Punk - Get Lucky.m4a");
        std::fs::write(&file, b"0123456789").expect("write file");
        std::fs::write(dir.join("downloads.db"), b"this is not sqlite").expect("corrupt db");

        let entries = AppState::new(0, dir.clone(), test_cache_dir())
            .vault()
            .entries;
        assert_eq!(entries.len(), 1, "row rebuilt after corruption");
        assert_eq!(entries[0].artist, "Daft Punk");
        let again = AppState::new(0, dir.clone(), test_cache_dir())
            .vault()
            .entries;
        assert_eq!(again.len(), 1, "fresh database boots cleanly");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault path that cannot be a directory disables the ledger instead
    /// of crashing the app: listings come back empty and mutations surface
    /// a clear error (review 5.3 read-only / permission-denied behaviour).
    #[test]
    fn unusable_vault_dir_disables_ledger() {
        let dir = std::env::temp_dir().join(format!("trance-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let blocked = dir.join("vault-is-a-file");
        std::fs::write(&blocked, b"not a directory").expect("blocker");

        let state = AppState::new(0, blocked.clone(), test_cache_dir());
        assert!(
            state.vault().entries.is_empty(),
            "listing degrades to empty"
        );
        let entry = DownloadEntry {
            id: "blockedid0001".into(),
            title: "T".into(),
            artist: "A".into(),
            album: String::new(),
            image: String::new(),
            duration_secs: 1,
            quality: "unknown".into(),
            path: blocked.display().to_string(),
            bytes: 1,
            at: 0,
            sha256: String::new(),
        };
        let err = state.record(entry).expect_err("mutation must fail loudly");
        assert!(!err.is_empty(), "error carries a message the UI can show");
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

        let _ = AppState::new(0, dir.clone(), test_cache_dir());

        assert!(!stale.exists(), "crash leftovers are swept");
        assert!(kept.exists(), "real files are untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ledger writes are serialized by the connection mutex: N downloads
    /// finishing at the same moment must all keep their row.
    #[test]
    fn concurrent_records_keep_every_row() {
        let dir = std::env::temp_dir().join(format!("trance-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = Arc::new(AppState::new(0, dir.clone(), test_cache_dir()));

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
                            sha256: String::new(),
                        })
                        .expect("record");
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread");
        }
        assert_eq!(
            state.vault().entries.len(),
            4,
            "every concurrent download keeps its row"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Captive portals and gateway error pages answer with HTML/JSON — they
    /// must never pass as audio (review 5.1 / 5.2).
    #[test]
    fn media_content_type_gate_rejects_non_audio() {
        assert!(plausible_media_type("audio/mp4"));
        assert!(plausible_media_type("audio/mp4; codecs=mp4a.40.2"));
        assert!(plausible_media_type("application/octet-stream"));
        assert!(plausible_media_type("binary/octet-stream"));
        assert!(plausible_media_type("VIDEO/MP4"), "case-insensitive");
        assert!(!plausible_media_type("text/html"));
        assert!(!plausible_media_type("text/html; charset=utf-8"));
        assert!(!plausible_media_type("application/json"));
        assert!(!plausible_media_type("application/xml"));
    }

    /// Empty bodies are errors, truncated bodies are errors, and both kinds
    /// of failure happen before anything is committed to the vault (5.2).
    #[test]
    fn empty_and_truncated_bodies_fail_verification() {
        let err = verify_streamed(0, Some(0)).expect_err("0 bytes is never a song");
        assert!(err.contains("empty"), "{err}");
        let err = verify_streamed(5, Some(10)).expect_err("truncated must fail");
        assert!(err.contains("truncated"), "{err}");
        verify_streamed(10, Some(10)).expect("exact match passes");
        verify_streamed(10, None).expect("unknown length passes when non-empty");
    }

    /// The capability file grants the minimum and nothing more (review 5.7).
    #[test]
    fn capability_grants_only_core_default() {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json"),
        )
        .expect("capability file");
        let cap: serde_json::Value = serde_json::from_str(&raw).expect("valid capability json");
        assert_eq!(
            cap["permissions"],
            serde_json::json!(["core:default"]),
            "no extra permissions may appear silently"
        );
        let windows = cap["windows"].as_array().expect("windows array");
        assert!(windows.iter().any(|w| w == "main"));
    }

    /// Windows paths beyond MAX_PATH still record and delete end to end:
    /// Rust's std hands them to the OS in verbatim (`\\?\`) form (5.3).
    #[cfg(windows)]
    #[test]
    fn very_long_windows_paths_record_and_remove() {
        let dir = std::env::temp_dir().join(format!("trance-longpath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut deep = dir.clone();
        for i in 0..3 {
            deep = deep.join(format!("{i}-{}", "d".repeat(100)));
        }
        std::fs::create_dir_all(&deep).expect("deep dirs");
        let file = deep.join("song.m4a");
        std::fs::write(&file, b"x").expect("write long file");
        let long = file.display().to_string();
        assert!(
            long.len() > 260,
            "path must exceed MAX_PATH ({})",
            long.len()
        );

        let state = AppState::new(0, dir.clone(), test_cache_dir());
        state
            .record(DownloadEntry {
                id: "longpathid001".into(),
                title: "Song".into(),
                artist: "A".into(),
                album: String::new(),
                image: String::new(),
                duration_secs: 1,
                quality: "unknown".into(),
                path: long.clone(),
                bytes: 1,
                at: 0,
                sha256: String::new(),
            })
            .expect("record long path");
        assert_eq!(state.vault().entries.len(), 1, "listed despite length");
        state.remove(&long).expect("remove long path");
        assert!(!file.exists(), "file deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database created before checksums gains the sha256 column on open
    /// (ALTER, index 10) instead of failing every query — pre-upgrade rows
    /// keep working with an empty hash until verify backfills them.
    #[test]
    fn pre_sha256_database_migrates_on_open() {
        let dir = std::env::temp_dir().join(format!("trance-shamigrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let file = dir.join("Old - Song.m4a");
        std::fs::write(&file, b"old").expect("write old file");
        {
            let conn = rusqlite::Connection::open(dir.join("downloads.db")).expect("open raw db");
            conn.execute_batch(
                "CREATE TABLE downloads (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
                    album TEXT NOT NULL, image TEXT NOT NULL, duration_secs INTEGER NOT NULL,
                    quality TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
                    at INTEGER NOT NULL);",
            )
            .expect("pre-upgrade schema");
            conn.execute(
                "INSERT INTO downloads \
                 (id, title, artist, album, image, duration_secs, quality, path, bytes, at) \
                 VALUES (?1, 'Old', 'A', '', '', 1, 'x', ?2, 3, 5)",
                rusqlite::params!["oldid12345", file.display().to_string()],
            )
            .expect("pre-upgrade row");
        }

        let state = AppState::new(0, dir.clone(), test_cache_dir());
        let entries = state.vault().entries;
        assert_eq!(entries.len(), 1, "pre-upgrade row survives the migration");
        assert_eq!(entries[0].id, "oldid12345");
        assert_eq!(entries[0].sha256, "", "new column defaults to empty");
        state
            .record(DownloadEntry {
                sha256: "ab".repeat(32),
                ..entries[0].clone()
            })
            .expect("inserts must include the migrated column");
        assert!(
            state
                .entry_by_sha(&"ab".repeat(32))
                .expect("sha lookup")
                .is_some(),
            "sha index works after migration"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// verify() is report-only: good files count ok, a flipped byte counts
    /// mismatch, a vanished file counts missing, and a pre-upgrade row with
    /// no hash gets backfilled with the hash of what is actually on disk.
    #[test]
    fn verify_counts_ok_mismatch_missing_and_backfills() {
        let dir = std::env::temp_dir().join(format!("trance-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = AppState::new(0, dir.clone(), test_cache_dir());
        let mk = |id: &str, path: String, sha: String| DownloadEntry {
            id: id.into(),
            title: "T".into(),
            artist: "A".into(),
            album: String::new(),
            image: String::new(),
            duration_secs: 1,
            quality: "x".into(),
            path,
            bytes: 1,
            at: 0,
            sha256: sha,
        };

        let good = dir.join("Good - Song.m4a");
        std::fs::write(&good, b"hello").expect("write good");
        let good_sha = crate::sha256::hash_file(&good).expect("hash good");
        state
            .record(mk("goodid000001", good.display().to_string(), good_sha))
            .expect("record good");

        let bad = dir.join("Bad - Song.m4a");
        std::fs::write(&bad, b"tampered!!").expect("write bad");
        state
            .record(mk(
                "badid0000001",
                bad.display().to_string(),
                "00".repeat(32),
            ))
            .expect("record bad");

        state
            .record(mk(
                "goneid0000001",
                dir.join("vanished.m4a").display().to_string(),
                "11".repeat(32),
            ))
            .expect("record gone");

        let legacy = dir.join("Legacy - Song.m4a");
        std::fs::write(&legacy, b"legacy").expect("write legacy");
        state
            .record(mk(
                "legacyid00001",
                legacy.display().to_string(),
                String::new(),
            ))
            .expect("record legacy");

        let rep = state.verify();
        assert_eq!(
            (rep.ok, rep.mismatch, rep.missing),
            (2, 1, 1),
            "good + backfilled ok, one tampered, one vanished"
        );
        assert!(
            state
                .entry_by_sha(&crate::sha256::hash_file(&legacy).expect("hash legacy"))
                .expect("lookup")
                .is_some(),
            "legacy row was backfilled with its real hash"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Import resolves files only inside the vault: exact path, or file
    /// name looked up in the vault (manifest from another machine). Missing
    /// files and hostile `../` paths are reported, never touched.
    #[test]
    fn import_entries_resolve_inside_vault_only() {
        let dir = std::env::temp_dir().join(format!("trance-mimport-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("vault dir");
        let state = AppState::new(0, dir.clone(), test_cache_dir());
        let mk = |id: &str, path: String| DownloadEntry {
            id: id.into(),
            title: "T".into(),
            artist: "A".into(),
            album: String::new(),
            image: String::new(),
            duration_secs: 1,
            quality: "x".into(),
            path,
            bytes: 0,
            at: 0,
            sha256: String::new(),
        };

        let direct = dir.join("Trance - Anthem.m4a");
        std::fs::write(&direct, b"abc").expect("write direct");
        let foreign_named = dir.join("Other - B.m4a");
        std::fs::write(&foreign_named, b"defg").expect("write foreign-named");
        // A real file OUTSIDE the vault whose name a hostile manifest points at.
        let outside = std::env::temp_dir().join(format!("escape-{}.mp4", std::process::id()));
        std::fs::write(&outside, b"do not touch").expect("write outside");

        let rep = state
            .import_entries(&[
                mk("importid00001", direct.display().to_string()),
                mk(
                    "importid00002",
                    "/some/other/machine/Other - B.m4a".to_string(),
                ),
                mk("importid00003", "/nowhere/Gone - Track.m4a".to_string()),
                mk("not a valid id", direct.display().to_string()),
                mk(
                    "importid00004",
                    format!("../escape-{}.mp4", std::process::id()),
                ),
            ])
            .expect("import");
        assert_eq!(rep.added, 2, "direct hit + basename fallback");
        assert_eq!(rep.missing, 3, "gone file + invalid id + hostile path");

        let vault = state.vault();
        assert_eq!(vault.entries.len(), 2, "nothing else was recorded");
        for e in &vault.entries {
            assert!(
                std::path::Path::new(&e.path).starts_with(&dir),
                "recorded paths stay inside the vault"
            );
        }
        assert!(
            outside.exists(),
            "a ../ manifest path must never touch the file outside the vault"
        );
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
