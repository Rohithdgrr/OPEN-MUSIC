//! TRANCE MUSIC — application shell.
//!
//! Owns: IPC command surface, DTO shaping, app lifecycle (window + proxy
//! port binding). Nothing here talks HTTP directly — that is `jiosaavn.rs`
//! (catalog) and `proxy.rs` (media relay) territory.

mod cache;
mod db;
mod gdrive;
mod jiosaavn;
mod lyrics;
mod official;
mod proxy;
mod sha256;
#[allow(dead_code)] // parked with its commands (see generate_handler)
mod sysvol;
mod transcode;
#[cfg(desktop)]
mod update;
mod widget;

// Global shortcuts are a desktop concept: the plugin's Rust API does not
// exist on mobile, so Android gets a no-op stand-in with the same surface.
#[cfg(desktop)]
mod shortcuts;

#[cfg(mobile)]
mod shortcuts {
    pub fn register(_app: &tauri::AppHandle) {}
    #[tauri::command]
    pub fn get_shortcut_mode() -> String {
        "default".to_string()
    }
}

use std::sync::Arc;

use serde::Serialize;
#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use jiosaavn::{best_quality, check_id, PlayableAudio, RangeStatus, SearchPage, Track};
use proxy::{proxy_url_for, AppState, DownloadEntry, Vault};

/// Payload of each `download_song` progress message, streamed over the
/// caller's scoped channel while a song is saved.
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DownloadProgress {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub image: String,
    pub quality: String,
    pub received: u64,
    pub total: Option<u64>,
    pub done: bool,
}

/// What `download_song` hands back: the saved path + its SHA-256, and — when
/// the identical bytes were already in the vault — which entry holds them
/// (the fresh copy is dropped, nothing is recorded twice).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DownloadOutcome {
    pub path: String,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

/// Free-text queries end up as cache keys and upstream params — cap them so a
/// pathological paste can't bloat the caches (review S4). Clamped on a char
/// boundary; short queries pass through untouched.
fn clamp_query(query: String) -> String {
    if query.chars().count() <= 200 {
        return query;
    }
    query.chars().take(200).collect()
}

/// Search the catalog. `limit` is clamped to 1..=40 (default 20) upstream,
/// `page` is 1-based so the UI can keep pulling results indefinitely.
/// Results are memoised per query+limit+page to reduce upstream pressure.
/// `page_full` says whether upstream had more to give *before* duplicates
/// were collapsed — the UI hangs "Load more" off it, not off `tracks.len()`.
#[tauri::command]
async fn search_songs(
    query: String,
    limit: Option<u32>,
    page: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> Result<SearchPage, String> {
    state
        .cached_search(&clamp_query(query), limit.unwrap_or(20), page.unwrap_or(1))
        .await
}

/// One page of album / artist / playlist search results (the search screen's
/// entity chips). `page_full` is measured from upstream's `total`/`start`, so
/// the UI never loses "load more" to dedup shrinking a page.
#[tauri::command]
async fn search_entities(
    query: String,
    kind: String,
    limit: Option<u32>,
    page: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> Result<official::EntityPage, String> {
    let query = clamp_query(query);
    state
        .cached_entities(&query, &kind, limit.unwrap_or(20), page.unwrap_or(1))
        .await
}

/// Inline suggestions for the search box: the top match plus a few songs,
/// albums, artists and playlists, all from one `autocomplete.get` round-trip.
#[tauri::command]
async fn search_suggestions(
    query: String,
    state: State<'_, Arc<AppState>>,
) -> Result<official::Suggestions, String> {
    state.cached_suggestions(&clamp_query(query)).await
}

/// Endless playback's feed: continue a JioSaavn radio station, or seed a new
/// one from `song` when `station` is empty/absent. Each call advances the
/// station, so the UI keeps invoking it as the queue runs low.
#[tauri::command]
async fn recommend_songs(
    song: Option<String>,
    station: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<official::RadioPage, String> {
    official::recommend(&state.client, song.as_deref(), station.as_deref()).await
}

/// Resolve a song id to a playable, range-qualified stream.
///
/// Runs the honesty probe before any promise of playback is made.
#[tauri::command]
async fn resolve_song(
    id: String,
    quality: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<PlayableAudio, String> {
    check_id(&id)?;
    let prefer = quality.unwrap_or_else(|| "320kbps".to_string());

    // Already on disk? Play the saved copy — no CDN round trip, works offline.
    // ponytail: a re-download of a newer master is deliberately not considered.
    if let Some(entry) = state.vault().entries.into_iter().find(|e| e.id == id) {
        return Ok(PlayableAudio {
            title: entry.title,
            artist: entry.artist,
            direct_url: entry.path,
            proxy_url: format!("http://127.0.0.1:{}/file?id={}", state.port, entry.id),
            qualities: Vec::new(),
            chosen_quality: entry.quality,
            content_length: Some(entry.bytes),
            host: "vault".into(),
            range_status: RangeStatus::Unrestricted,
            id,
        });
    }

    let song = state.cached_song(&id).await?;
    let chosen =
        best_quality(&song.qualities, &prefer).ok_or_else(|| "no stream qualities".to_string())?;

    let probe = state.cached_qualify(&chosen.url).await?;

    let host = url::Url::parse(&chosen.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();

    // Id-keyed so the relay can purge + re-resolve when the CDN retires the
    // link (design L2); computed before the DTO moves `id`.
    let proxy_url = proxy_url_for(state.port, &id);
    Ok(PlayableAudio {
        id,
        title: song.track.title,
        artist: song.track.artist,
        direct_url: chosen.url.clone(),
        proxy_url,
        qualities: song.qualities,
        chosen_quality: chosen.quality,
        content_length: probe.content_length,
        host,
        range_status: probe.range_status,
    })
}

/// Qualify an explicit stream url (validated: https + media-host allow-list).
#[tauri::command]
async fn qualify_url(url: String, state: State<'_, Arc<AppState>>) -> Result<RangeStatus, String> {
    let probe = state.cached_qualify(&url).await?;
    Ok(probe.range_status)
}

/// Base URL of the localhost range relay, e.g. `http://127.0.0.1:49213`.
#[tauri::command]
fn proxy_base(state: State<'_, Arc<AppState>>) -> String {
    format!("http://127.0.0.1:{}", state.port)
}

/// Bytes currently in the vault (its own ledger, not the cache tree).
fn vault_used(state: &AppState) -> u64 {
    state.vault().entries.iter().map(|e| e.bytes).sum()
}

/// Settings / Storage: usage for every tier plus the active budget.
#[tauri::command]
async fn cache_stats(state: State<'_, Arc<AppState>>) -> Result<cache::CacheStats, String> {
    Ok(state.disk.stats(vault_used(&state)))
}

/// Settings / Storage: cache size knob (design range 100 MB … 5 GB).
/// Enforced immediately so the number on screen matches reality.
#[tauri::command]
async fn cache_set_budget(
    mb: u64,
    state: State<'_, Arc<AppState>>,
) -> Result<cache::CacheStats, String> {
    let bytes = mb
        .saturating_mul(1024 * 1024)
        .clamp(cache::MIN_BUDGET, cache::MAX_BUDGET);
    state.disk.set_budget(bytes);
    state.disk.enforce_budget();
    Ok(state.disk.stats(vault_used(&state)))
}

/// Clear-cache button: drops L1/L2/L4-RAM and the L3/L4 disk trees. The
/// vault lives under Downloads with its own ledger, so it is never touched.
#[tauri::command]
async fn cache_clear(state: State<'_, Arc<AppState>>) -> Result<cache::CacheStats, String> {
    state.resolved.invalidate_all();
    state.qualified.invalidate_all();
    state.search_cache.invalidate_all();
    state.lyrics_cache.invalidate_all();
    state.entity_cache.invalidate_all();
    state.suggest_cache.invalidate_all();
    state.tracks_cache.invalidate_all();
    state.artist_pages.invalidate_all();
    state.overview_cache.invalidate_all();
    state.art_memory.invalidate_all();
    state.disk.clear();
    Ok(state.disk.stats(vault_used(&state)))
}

/// L5 prefetch: warm the resolve + qualification for the next few tracks so
/// `next()` starts from a cache hit instead of a mirror round trip (design
/// §Audio Buffer — the vault prefetch in `vault.js` already covers the
/// "already downloaded" case on its own). Failures are ignored: the play
/// path resolves again on demand and errors are never cached.
#[tauri::command]
async fn prefetch_next(ids: Vec<String>, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let st = state.inner().clone();
    let jobs = ids
        .into_iter()
        .filter(|id| check_id(id).is_ok())
        .take(4)
        .map(|id| {
            let st = st.clone();
            async move {
                // Vaulted tracks play from disk — nothing to warm.
                if st.vault().entries.iter().any(|e| e.id == id) {
                    return;
                }
                if let Ok(song) = st.cached_song(&id).await {
                    if let Some(q) = best_quality(&song.qualities, "320kbps") {
                        let _ = st.cached_qualify(&q.url).await;
                    }
                }
            }
        });
    futures::future::join_all(jobs).await;
    Ok(())
}

/// IPC contract version. The frontend checks it once at boot, so a renamed
/// or missing command shows up as a loud mismatch instead of a silent
/// `invoke` failure. Bump on any breaking command/parameter change.
#[tauri::command]
fn api_version() -> u32 {
    1
}

/// Reachability probe for the network banner: one HEAD at the artwork CDN,
/// answered with the elapsed milliseconds. Any HTTP response (even 403/404)
/// proves the connection works — only a transport error or the 5s timeout
/// means the network is actually down.
#[tauri::command]
async fn net_ping(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    let start = std::time::Instant::now();
    state
        .client
        .head("https://c.saavncdn.com/")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis() as u64)
}

/// Home screen feed: hero playlist, curated playlists, charts, top-5 tracks.
#[tauri::command]
async fn home_feed(state: State<'_, Arc<AppState>>) -> Result<official::HomeFeed, String> {
    official::home(&state.client).await
}

/// Every song of a playlist or chart, in order (Home "play this list").
#[tauri::command]
async fn playlist_tracks(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Track>, String> {
    state.cached_playlist(&id).await
}

/// Every track of an album (album token = last segment of its page url).
#[tauri::command]
async fn album_tracks(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Track>, String> {
    state.cached_album(&token).await
}

/// One page of an artist's catalogue (artist token = last segment of its page
/// url). Page 0 is the popular set; later pages walk the rest of the works.
#[tauri::command]
async fn artist_tracks(
    token: String,
    page: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> Result<official::ArtistSongPage, String> {
    state.cached_artist_page(&token, page.unwrap_or(0)).await
}

/// Artist header + the complete discography the artist screen renders under
/// the tracks (name, listeners, bio, every album/single/EP).
#[tauri::command]
async fn artist_overview(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<official::ArtistOverview, String> {
    state.cached_overview(&token).await
}

/// Best lyrics for a track: LRCLIB time-coded, else JioSaavn text, else
/// LRCLIB plain. Memoised per song id (content only).
#[tauri::command]
async fn get_lyrics(
    id: String,
    title: String,
    artist: String,
    album: String,
    duration: u32,
    state: State<'_, Arc<AppState>>,
) -> Result<lyrics::Lyrics, String> {
    state
        .cached_lyrics(&id, &title, &artist, &album, duration)
        .await
}

/// Windows device names that are invalid as a file stem even with an
/// extension (`CON.mp3` cannot be created); each component we build is
/// checked so the guarantee is compositional.
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Strip characters that are illegal in file names on any desktop OS.
fn safe_file_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    let trimmed = trimmed
        .chars()
        .take(120)
        .collect::<String>()
        .trim()
        .to_string();
    if trimmed.is_empty() {
        return "track".to_string();
    }
    // `CON`, `CON.mp3`, `con` … all resolve to the reserved device; anything
    // else keeps its name.
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        format!("_{trimmed}")
    } else {
        trimmed
    }
}

/// Vault filename stem: `{id} - {artist} - {title}`.
///
/// The id leads because it is the only guaranteed-unique part; the rest keeps
/// the file readable in Explorer. `rebuild_from_dir` parses this shape back.
fn vault_stem(id: &str, artist: &str, title: &str) -> String {
    format!(
        "{} - {} - {}",
        safe_file_name(id),
        safe_file_name(artist),
        safe_file_name(title)
    )
}

/// Encoded bitrate for a quality preference. Understands the stored labels
/// (`"96kbps"`, `"opus96"`) and bare numbers; unknown values land on 96, the
/// size/quality sweet spot.
fn target_kbps(quality: Option<&str>) -> u32 {
    let digits: String = quality
        .unwrap_or("96")
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    match digits.parse::<u32>() {
        Ok(0) | Err(_) => 96,
        Ok(kbps) => kbps,
    }
}

/// Save a complete song to the user's offline vault.
///
/// With ffmpeg present the best source rendition is downloaded and encoded to
/// Opus at the requested bitrate, normalized to -16 LUFS (EBU R128); the
/// source is kept as-is when no encoder exists. Progress streams over the
/// caller's scoped `on_progress` channel (review 4.4), and the file is recorded
/// only once its byte count matches what the CDN declared. Returns the path,
/// the SHA-256, and a `duplicate_of` id when the same bytes were already saved
/// under another entry (spec 3.3 dedupe).
#[tauri::command]
async fn download_song(
    id: String,
    quality: Option<String>,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
    state: State<'_, Arc<AppState>>,
) -> Result<DownloadOutcome, String> {
    save_to_vault(
        &state,
        &id,
        target_kbps(quality.as_deref()),
        Some(&on_progress),
    )
    .await
}

/// The two-tier vault: a saved song the user favorites is re-saved at the
/// premium bitrate. Returns whether anything was upgraded — a song that is not
/// in the vault, is already at (or above) the premium bitrate, or has no
/// encoder to work with is left exactly as it is.
#[tauri::command]
async fn promote_song(id: String, state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    check_id(&id)?;
    const PREMIUM_KBPS: u32 = 128;
    let Some(entry) = state.vault().entries.into_iter().find(|e| e.id == id) else {
        return Ok(false);
    };
    // Native renditions are already the source of truth: without an encoder
    // there is nothing to re-encode, and re-encoding 64k into 128k would only
    // invent detail that is not there.
    if !transcode::available() || stored_kbps(&entry.quality) >= PREMIUM_KBPS {
        return Ok(false);
    }
    // The old copy has to go before the rewrite so it cannot resolve as the
    // playable vault file while its bytes are being replaced.
    let previous = entry.path.clone();
    match save_to_vault(&state, &id, PREMIUM_KBPS, None).await {
        Ok(_) => {
            if !previous.is_empty() {
                let _ = std::fs::remove_file(previous);
            }
            Ok(true)
        }
        Err(e) => {
            eprintln!("[TRANCE MUSIC] promote {id} failed: {e}");
            // Put the old row back so the vault keeps playing what it had.
            let _ = state.record(entry);
            Err(e)
        }
    }
}

/// Bitrate a stored quality label represents: `opus128` and `128kbps` are
/// both 128. Unparseable labels (`unknown`, empty) fall back to 96, which
/// still reads as "below premium" and so stays promotable.
fn stored_kbps(quality: &str) -> u32 {
    target_kbps(Some(quality.trim_start_matches("opus")))
}

/// Download, encode, dedupe and record one song — the whole vault write path,
/// shared by `download_song` and `promote_song`.
async fn save_to_vault(
    state: &AppState,
    id: &str,
    target: u32,
    progress: Option<&tauri::ipc::Channel<DownloadProgress>>,
) -> Result<DownloadOutcome, String> {
    check_id(id)?;
    let encode = transcode::available();
    let prefer = transcode::source_rendition(target, encode).to_string();
    let song = state.cached_song(id).await?;
    let chosen =
        best_quality(&song.qualities, &prefer).ok_or_else(|| "no stream qualities".to_string())?;

    // Stop the old copy resolving while its file is being rewritten.
    state.forget(id)?;

    std::fs::create_dir_all(&state.vault)
        .map_err(|e| format!("create {}: {e}", state.vault.display()))?;
    // The song id leads the name: it is the only part guaranteed unique, so two
    // songs sharing an artist and title no longer overwrite each other.
    let stem = vault_stem(id, &song.track.artist, &song.track.title);
    let dest = state.vault.join(format!("{stem}.m4a"));

    let note = DownloadProgress {
        id: id.to_string(),
        title: song.track.title.clone(),
        artist: song.track.artist.clone(),
        album: song.track.album.clone(),
        image: song.track.image.clone(),
        quality: chosen.quality.clone(),
        received: 0,
        total: None,
        done: false,
    };
    let (path, written, sha) = state
        .download_to(&chosen.url, &dest, |received, total| {
            if let Some(channel) = progress {
                let mut msg = note.clone();
                msg.received = received;
                msg.total = total;
                let _ = channel.send(msg);
            }
        })
        .await?;

    // Encode to Opus when an encoder is around. The source is only deleted
    // once the encode lands, so a failure keeps a playable copy instead of
    // losing the download.
    let (path, written, sha, quality) = if encode {
        if let Some(channel) = progress {
            let msg = DownloadProgress {
                quality: "ENCODING".into(),
                received: written,
                ..note.clone()
            };
            let _ = channel.send(msg);
        }
        let opus = path.with_extension("opus");
        match transcode::encode_opus(&path, &opus, target).await {
            Ok(bytes) => {
                let sha = crate::sha256::hash_file(&opus).map_err(|e| e.to_string())?;
                let _ = tokio::fs::remove_file(&path).await;
                (opus, bytes, sha, format!("opus{target}"))
            }
            Err(e) => {
                eprintln!("[TRANCE MUSIC] keeping the source rendition: {e}");
                (path, written, sha, chosen.quality.clone())
            }
        }
    } else {
        (path, written, sha, chosen.quality.clone())
    };

    // Content dedupe (spec 3.3): identical bytes already recorded under a
    // different entry. Drop the redundant copy (unless it IS the recorded
    // file — same stem rewritten in place), keep the existing row, and tell
    // the UI which entry holds the song.
    if let Some(dup) = state.entry_by_sha(&sha)? {
        if !dup.path.eq_ignore_ascii_case(&path.display().to_string()) {
            let _ = std::fs::remove_file(&path);
        }
        let mut msg = note;
        msg.received = written;
        msg.done = true;
        if let Some(channel) = progress {
            let _ = channel.send(msg);
        }
        eprintln!("[TRANCE MUSIC] {id} dedupes to vault entry {}", dup.id);
        return Ok(DownloadOutcome {
            path: dup.path,
            sha256: sha,
            duplicate_of: Some(dup.id),
        });
    }

    state.record(DownloadEntry {
        id: id.to_string(),
        title: song.track.title.clone(),
        artist: song.track.artist.clone(),
        album: song.track.album.clone(),
        image: song.track.image.clone(),
        duration_secs: song.track.duration_secs,
        quality: quality.clone(),
        path: path.display().to_string(),
        bytes: written,
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        sha256: sha.clone(),
    })?;

    let mut msg = note;
    msg.received = written;
    msg.done = true;
    // The card ends on what is actually in the vault, not on the rendition the
    // encode started from.
    msg.quality = quality;
    if let Some(channel) = progress {
        let _ = channel.send(msg);
    }

    eprintln!("[TRANCE MUSIC] saved {written} bytes to {}", path.display());
    Ok(DownloadOutcome {
        path: path.display().to_string(),
        sha256: sha,
        duplicate_of: None,
    })
}

/// Re-hash every vault file against its recorded SHA-256 (Verify button).
/// Runs on a worker thread: hashing a multi-GB vault must not stall IPC.
#[tauri::command]
async fn verify_vault(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::proxy::VerifyReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<crate::proxy::VerifyReport, String> {
        Ok(state.verify())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import a manifest exported elsewhere: each entry must resolve to a file
/// already inside the vault; missing files are reported, never fetched.
#[tauri::command]
async fn import_manifest(
    entries: Vec<DownloadEntry>,
    state: State<'_, Arc<AppState>>,
) -> Result<crate::proxy::ImportReport, String> {
    state.import_entries(&entries)
}

/// Everything currently in the offline vault, newest first.
#[tauri::command]
fn list_downloads(state: State<'_, Arc<AppState>>) -> Vault {
    state.vault()
}

/// Delete one downloaded file (by the path we recorded for it).
#[tauri::command]
fn remove_download(path: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.remove(&path)
}

/// Reveal one downloaded file in the system file manager.
#[tauri::command]
fn reveal_download(path: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.reveal(&path)
}

/// Reveal the vault folder itself (no path is taken from the frontend).
#[tauri::command]
fn reveal_vault(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.reveal_vault()
}

/// One paired Bluetooth device, as the shell knows it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // parked with the mini player button
struct BluetoothDevice {
    name: String,
    address: String,
    /// False for devices Windows still lists but has never connected.
    connected: bool,
}

/// Paired Bluetooth devices, read from the Bluetooth service's own key.
///
/// WebView2 has no Web Bluetooth, so pairing itself is Windows' job: this
/// command only reports what is already paired, and `open_bluetooth_settings`
/// hands the user over to the Settings page for new pairings. Reading the
/// registry needs no extra crate and no elevated rights.
#[allow(dead_code)] // parked with the mini player button
#[tauri::command]
async fn bluetooth_devices() -> Result<Vec<BluetoothDevice>, String> {
    #[cfg(not(windows))]
    {
        let _ = Vec::<BluetoothDevice>::new();
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        const KEY: &str = r"HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices";
        // `reg query` writes to stdout; a missing key (no Bluetooth radio)
        // is an empty list, not an error the panel should shout about.
        let out = std::process::Command::new("reg")
            .args(["query", KEY, "/s"])
            .output()
            .map_err(|e| format!("bluetooth registry read failed: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut devices = Vec::new();
        // One `Name` REG_BINARY per device key; the key path carries the MAC.
        let mut address = String::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\") {
                address = rest.split('\\').next().unwrap_or("").trim().to_string();
                continue;
            }
            let Some((name, rest)) = trimmed.split_once("Name") else {
                continue;
            };
            if !name.trim().is_empty() {
                continue;
            }
            let Some((_, hex)) = rest.split_once("REG_BINARY") else {
                continue;
            };
            // REG_BINARY holds the device name as UTF-16LE, one hex pair per byte.
            let bytes: Vec<u8> = hex
                .split_whitespace()
                .flat_map(|chunk| {
                    (0..chunk.len())
                        .step_by(2)
                        .filter_map(|i| u8::from_str_radix(&chunk[i..i + 2], 16).ok())
                        .collect::<Vec<u8>>()
                })
                .collect();
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|u| *u != 0)
                .collect();
            let name = String::from_utf16_lossy(&units).trim().to_string();
            if name.is_empty() || address.is_empty() {
                continue;
            }
            devices.push(BluetoothDevice {
                name,
                address: address.clone(),
                connected: false,
            });
        }
        devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(devices)
    }
}

/// Open the Windows Bluetooth settings page — the only place pairing can
/// actually happen. `cmd /C start` avoids a shell-quoting dependency.
#[allow(dead_code)] // parked with the mini player button
#[tauri::command]
fn open_bluetooth_settings() -> Result<(), String> {
    if cfg!(mobile) {
        return Err("bluetooth settings are not available on Android".to_string());
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", "ms-settings:bluetooth"]);
        crate::hide_console(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("could not open bluetooth settings: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("bluetooth settings are only wired up on Windows".to_string())
    }
}

/// Phase 1 backup/restore: write text through the native Save dialog.
/// Cancellation is an Err the frontend treats as silent; the Ok holds the
/// path that was written, for the confirmation toast.
///
/// Desktop-only: the dialog plugin has no mobile build, so the command itself
/// is compiled out for Android/iOS rather than only its handler entry.
#[cfg(desktop)]
#[tauri::command]
fn export_file(
    app: tauri::AppHandle,
    content: String,
    suggested_name: String,
    filter_label: String,
    extensions: Vec<String>,
) -> Result<String, String> {
    // Android would need the Storage Access Framework; a desktop save
    // dialog has no meaning there, so say so instead of failing oddly.
    if cfg!(mobile) {
        return Err("file export is not supported on Android yet".to_string());
    }
    use tauri_plugin_dialog::DialogExt;
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let picked = app
        .dialog()
        .file()
        .add_filter(filter_label, &exts)
        .set_file_name(suggested_name)
        .blocking_save_file();
    let path = picked
        .as_ref()
        .and_then(|fp| fp.as_path())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "export cancelled".to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Phase 1 restore: read a backup file through the native Open dialog.
/// Files over MAX_IMPORT_BYTES (mirrored in sync.js) are refused before
/// reading; the frontend still validates the parsed shape.
///
/// Desktop-only, like `export_file` — the dialog plugin has no mobile build.
#[cfg(desktop)]
#[tauri::command]
fn read_import_file(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
    let picked = app
        .dialog()
        .file()
        .add_filter("TRANCE MUSIC backup", &["json"])
        .blocking_pick_file();
    let path = picked
        .as_ref()
        .and_then(|fp| fp.as_path())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "import cancelled".to_string())?;
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    if size > MAX_IMPORT_BYTES {
        return Err(format!("backup too large: {size} bytes (max {MAX_IMPORT_BYTES})"));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

// ------------------------------------------------------------- desktop card
// The card is its own webview window (label `widget`). Placement is handled
// here rather than in JS: the capability file only grants the default window
// permissions, and window management is the sort of thing a page should not
// be able to do for itself anyway.

/// Reparent the card into (or out of) the WorkerW layer the shell paints the
/// wallpaper into. Parenting it there is what "sit behind every window" means:
/// that layer is below every application window, so the card is only ever
/// visible on an empty stretch of desktop.
#[cfg(windows)]
pub(crate) fn reparent(win: &tauri::WebviewWindow, embed: bool) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowA, FindWindowExA, GetClassNameA, SendMessageTimeoutA, SetParent,
        SMTO_NORMAL,
    };

    const PROGMAN: &[u8] = b"Progman\0";
    const WORKERW: &[u8] = b"WorkerW\0";
    const DEF_VIEW: &[u8] = b"SHELLDLL_DefView\0";

    /// The WorkerW that owns the desktop icon surface has the wallpaper layer
    /// as its immediate predecessor in Z-order - that sibling is our target.
    unsafe extern "system" fn behind_icons(hwnd: HWND, lparam: LPARAM) -> i32 {
        let slot = &mut *(lparam as *mut HWND);
        let owns_icons = !FindWindowExA(
            hwnd,
            std::ptr::null_mut(),
            DEF_VIEW.as_ptr(),
            std::ptr::null(),
        )
        .is_null();
        if owns_icons {
            let behind = FindWindowExA(
                std::ptr::null_mut(),
                hwnd,
                WORKERW.as_ptr(),
                std::ptr::null(),
            );
            if !behind.is_null() {
                *slot = behind;
                return 0;
            }
        }
        1
    }

    /// Fallback for shells that keep the icon surface on Progman itself: the
    /// bottom-most WorkerW with no icon surface of its own is the wallpaper.
    unsafe extern "system" fn stray_workerw(hwnd: HWND, lparam: LPARAM) -> i32 {
        let slot = &mut *(lparam as *mut HWND);
        let mut class = [0u8; 64];
        let len = GetClassNameA(hwnd, class.as_mut_ptr(), class.len() as i32);
        let is_worker = len as usize == WORKERW.len() - 1 && class[..len as usize] == WORKERW[..7];
        let owns_icons = !FindWindowExA(
            hwnd,
            std::ptr::null_mut(),
            DEF_VIEW.as_ptr(),
            std::ptr::null(),
        )
        .is_null();
        if is_worker && !owns_icons {
            *slot = hwnd;
        }
        1
    }

    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0;
    unsafe {
        if embed {
            // Poke Progman: without this the shell may never have created the
            // wallpaper WorkerW at all.
            let progman = FindWindowA(PROGMAN.as_ptr(), std::ptr::null());
            if !progman.is_null() {
                let mut result: usize = 0;
                SendMessageTimeoutA(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut result);
            }
            let mut layer: HWND = std::ptr::null_mut();
            EnumWindows(Some(behind_icons), &mut layer as *mut HWND as LPARAM);
            if layer.is_null() {
                EnumWindows(Some(stray_workerw), &mut layer as *mut HWND as LPARAM);
            }
            if layer.is_null() {
                return Err("could not reach the desktop wallpaper layer".to_string());
            }
            SetParent(hwnd, layer);
        } else {
            SetParent(hwnd, std::ptr::null_mut());
        }
    }
    // Topmost stops meaning anything once the card is a child of the shell,
    // and is wrong the moment it stops being one - keep the flag in step.
    win.set_always_on_top(!embed).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn reparent(_win: &tauri::WebviewWindow, _embed: bool) -> Result<(), String> {
    Ok(())
}

/// Show or hide the card, placing it either above every window or on the
/// wallpaper as a single operation so the two never disagree.
#[tauri::command]
fn widget_show(app: tauri::AppHandle, show: bool, embed: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("widget")
        .ok_or_else(|| "desktop widget window is missing".to_string())?;
    if !show {
        // Always detach first: hiding a reparented window would leave the
        // shell holding a handle we no longer control.
        reparent(&win, false)?;
        return win.hide().map_err(|e| e.to_string());
    }
    reparent(&win, embed)?;
    win.show().map_err(|e| e.to_string())
}

/// Switch an already visible card between the two placements.
#[tauri::command]
fn widget_embed(app: tauri::AppHandle, embed: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("widget")
        .ok_or_else(|| "desktop widget window is missing".to_string())?;
    reparent(&win, embed)
}

/// Place the card in physical screen coordinates (what the card reports back
/// after a drag, and where "reset position" puts it).
#[tauri::command]
fn widget_set_position(win: tauri::WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Compact ↔ icon size switch for the desktop card. Lives in Rust so the
/// webview needs no window permissions (core:default only).
#[tauri::command]
fn widget_resize(win: tauri::WebviewWindow, w: u32, h: u32) -> Result<(), String> {
    win.set_size(tauri::LogicalSize::new(w as f64, h as f64))
        .map_err(|e| e.to_string())
}

/// Begin an OS drag of the frameless card from its header.
#[tauri::command]
fn widget_start_drag(win: tauri::WebviewWindow) -> Result<(), String> {
    start_drag(&win)
}

/// `start_dragging` is desktop-only; the widget it serves does not exist on
/// mobile, so Android returns success without doing anything.
#[cfg(desktop)]
fn start_drag(win: &tauri::WebviewWindow) -> Result<(), String> {
    win.start_dragging().map_err(|e| e.to_string())
}

#[cfg(mobile)]
fn start_drag(_win: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// `CREATE_NO_WINDOW` on a console child (`reg`, ...). The release build is a
/// GUI process, so without this every helper it spawns would pop its own
/// terminal — `autostart_set` runs on each boot, which is one flash per launch.
#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000)
}

#[cfg(not(windows))]
pub(crate) fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Focus the main window: shortcut actions, tray "Show Window" and the
/// single-instance callback all route through here.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        unminimize(&w);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// `unminimize` does not exist on mobile windows (they are never minimized).
#[cfg(desktop)]
fn unminimize(win: &tauri::WebviewWindow) {
    let _ = win.unminimize();
}

#[cfg_attr(mobile, allow(dead_code))]
#[cfg(mobile)]
fn unminimize(_win: &tauri::WebviewWindow) {}

/// Open a link outside the app (Settings → shortcuts). Scheme-allowlisted so
/// the command cannot be pointed at `file:` or anything else local.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("powertoys://"))
    {
        return Err("unsupported URL scheme".to_string());
    }
    // Android would need an Intent (or tauri-plugin-opener); spawning xdg-open
    // just fails with ENOENT, so say what is missing instead.
    if cfg!(mobile) {
        return Err("opening links outside the app is not supported on Android yet".to_string());
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        });
        c.arg(&url);
        c
    };
    hide_console(&mut cmd).output().map_err(|e| e.to_string())?;
    Ok(())
}

/// Open at startup: the HKCU Run key is Windows' own autostart list - no
/// elevation, no scheduled task, no plugin. `reg delete` exits non-zero when
/// the value is already gone, which is the state we just asked for.
///
/// Elsewhere the desktop's own mechanism does the same job without one:
/// an autostart `.desktop` entry on Linux, a LaunchAgent on macOS.
#[tauri::command]
fn autostart_set(on: bool) -> Result<(), String> {
    // Android owns autostart (battery optimizations / OEM launchers); writing
    // a ~/.config autostart entry here would be a lie the OS never reads.
    if cfg!(mobile) {
        let _ = on;
        return Err("autostart is controlled by Android's system settings".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| format!("locate exe: {e}"))?;

    #[cfg(windows)]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        const NAME: &str = "TRANCE MUSIC";
        let value = format!("\"{}\"", exe.display());
        let mut cmd = std::process::Command::new("reg");
        if on {
            cmd.args(["add", KEY, "/v", NAME, "/d", value.as_str(), "/f"]);
        } else {
            cmd.args(["delete", KEY, "/v", NAME, "/f"]);
        }
        let out = hide_console(&mut cmd)
            .output()
            .map_err(|e| format!("reg: {e}"))?;
        if on && !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        use std::path::PathBuf;
        let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
        #[cfg(target_os = "macos")]
        let (file, body) = (
            PathBuf::from(&home).join("Library/LaunchAgents/com.openmusic.trancemusic.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.openmusic.trancemusic</string>
  <key>ProgramArguments</key><array><string>{}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
"#,
                exe.display()
            ),
        );
        #[cfg(not(target_os = "macos"))]
        let (file, body) = (
            PathBuf::from(&home).join(".config/autostart/trance-music.desktop"),
            format!(
                "[Desktop Entry]\nType=Application\nName=TRANCE MUSIC\nExec={}\n",
                exe.display()
            ),
        );
        if on {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&file, body).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&file).map_err(|e| e.to_string())
        }
    }
}

/// Language + region every catalog request is built with (Settings -> prefs).
#[tauri::command]
fn content_prefs_set(lang: String, country: String) -> Result<(), String> {
    crate::official::set_prefs(&lang, &country);
    Ok(())
}

/// Tray menu: media controls + Show/Quit, so closing to tray is still a
/// reachable app. Built best-effort — no icon, no tray, boot continues.
/// Desktop only: `tauri::tray`/`tauri::menu` do not exist on Android.
#[cfg(desktop)]
fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };
    let play = MenuItem::with_id(app, "play", "Play/Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&play, &next, &prev, &show, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("TRANCE MUSIC")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "play" => {
                let _ = app.emit("media-play-pause", ());
            }
            "next" => {
                let _ = app.emit("media-next", ());
            }
            "prev" => {
                let _ = app.emit("media-prev", ());
            }
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Process entry: the only place a startup failure may be fatal (review 5.6
/// — everything inside `run` returns `Result` instead of panicking).
/// One-time move of a pre-0.2 vault (it lived in the user's Downloads) into
/// the app's own data folder. Rename first — same volume, no copying — then
/// fall back to a recursive copy when the volumes differ. A no-op when the
/// new vault already holds a ledger, when there is no legacy vault, or when
/// the legacy one is empty.
fn migrate_vault(legacy: &std::path::Path, vault: &std::path::Path) {
    let has_ledger = |dir: &std::path::Path| {
        dir.join("downloads.db").exists() || dir.join("index.json").exists()
    };
    if has_ledger(vault) || !has_ledger(legacy) || !legacy.is_dir() || legacy == vault {
        return;
    }
    if let Some(parent) = vault.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::rename(legacy, vault).is_ok() {
        return;
    }
    if let Err(e) = copy_dir(legacy, vault) {
        eprintln!("vault migration failed: {e}");
    }
}

/// Recursive copy, for the cross-volume rename fallback above.
fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dst)?;
        } else {
            std::fs::copy(entry.path(), &dst)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First plugin: a second launch focuses the running instance. Both this
    // and the shortcut plugin are desktop-only — their Rust API does not
    // exist on mobile (Android gets single-task semantics from the OS and
    // has no global shortcuts).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Signed updates: pubkey + manifest endpoint live in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native Save/Open dialogs for backup export/import. Driven from
        // Rust, so no frontend capability entries are needed.
        // Both plugins are desktop-only: neither has a mobile implementation,
        // and compiling them into the iOS target fails the build.
        .plugin(tauri_plugin_dialog::init());
    builder
        .on_window_event(widget::handle_window_event)
        .setup(|app| {
            // Ephemeral port, bound BEFORE the window loads: no hardcoded
            // port, no collision, no race (docs/architecture.md §6).
            // NOTE: `setup` runs outside the Tokio runtime, so the std ->
            // tokio listener conversion happens inside the spawned task.
            let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            std_listener.set_nonblocking(true)?;
            let port = std_listener.local_addr()?.port();

            // Offline vault lives in the app's own data folder — Windows'
            // %LOCALAPPDATA%, ~/.local/share, ~/Library/Application Support —
            // so nothing the app saves lands in the user's downloads. A vault
            // from an older build (it lived in Downloads) is moved across
            // once, on the way in.
            let vault = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("TRANCE MUSIC");
            if let Ok(legacy) = app.path().download_dir() {
                migrate_vault(&legacy.join("TRANCE MUSIC"), &vault);
            }
            let _ = std::fs::create_dir_all(&vault);

            // Cache tree (L3/L4 files) lives in the app's own cache dir —
            // separate from the vault, so "clear cache" can never touch
            // saved songs.
            let cache_dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("trance-cache"));

            let state = Arc::new(AppState::new(port, vault, cache_dir));
            app.manage(state.clone());
            // Optional Google Drive sync (Phase 2): dormant until sign-in.
            app.manage(crate::gdrive::GDriveState::new());

            // Design: enforce the disk budget at boot (first tick fires
            // immediately) and every 10 minutes after that.
            {
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(600));
                    loop {
                        tick.tick().await;
                        state.disk.enforce_budget();
                    }
                });
            }

            let router = proxy::router(state);
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(listener) => {
                        let _ = axum::serve(listener, router).await;
                    }
                    Err(e) => eprintln!("proxy bind failed: {e}"),
                }
            });

            // Shortcuts and tray are log-only: a registration conflict must
            // never abort startup.
            shortcuts::register(app.handle());
            #[cfg(desktop)]
            if let Err(e) = build_tray(app) {
                eprintln!("tray build failed: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_songs,
            search_entities,
            search_suggestions,
            recommend_songs,
            resolve_song,
            qualify_url,
            proxy_base,
            api_version,
            net_ping,
            home_feed,
            playlist_tracks,
            album_tracks,
            artist_tracks,
            artist_overview,
            get_lyrics,
            download_song,
            promote_song,
            list_downloads,
            remove_download,
            verify_vault,
            import_manifest,
            reveal_download,
            reveal_vault,
            // Bluetooth parked on request: the mini player button/panel is commented out
// in index.html and transport.js. Uncomment to restore.
// bluetooth_devices,
// open_bluetooth_settings,
            // System (laptop) master volume parked on request — the app's own audio
// element volume stays as it was. Uncomment to drive Windows' mixer.
// sysvol::system_volume,
// sysvol::set_system_volume,
            #[cfg(desktop)]
            export_file,
            #[cfg(desktop)]
            read_import_file,
            gdrive::gdrive_status,
            gdrive::gdrive_sign_in,
            gdrive::gdrive_sign_out,
            gdrive::gdrive_push,
            gdrive::gdrive_pull,
            widget_show,
            widget_embed,
            widget_set_position,
            widget_resize,
            widget_start_drag,
            widget::toggle_widget,
            widget::set_widget_click_through,
            shortcuts::get_shortcut_mode,
            open_external,
            autostart_set,
            content_prefs_set,
            cache_stats,
            cache_set_budget,
            cache_clear,
            prefetch_next,
            #[cfg(desktop)]
            update::update_check,
            #[cfg(desktop)]
            update::update_install,
            #[cfg(desktop)]
            update::update_rollback
        ])
        .run(tauri::generate_context!())
        .expect("error while running TRANCE MUSIC");
}

#[cfg(test)]
mod tests {
    use super::{clamp_query, safe_file_name, stored_kbps, target_kbps, vault_stem};

    #[test]
    fn queries_over_200_chars_are_clamped_on_a_char_boundary() {
        assert_eq!(clamp_query("a".repeat(500)).len(), 200);
        assert_eq!(clamp_query("short".into()), "short");
        assert_eq!(clamp_query("Ac".repeat(300)).chars().count(), 200);
    }

    /// The vault stem has to round-trip: what `parse_vault_stem` reads back is
    /// the real song id, which is what keeps two same-titled songs apart.
    #[test]
    fn the_vault_stem_leads_with_the_song_id() {
        let stem = vault_stem("4Yc1J3xyzAB", "Arma\u{e9}", "Bang Bang");
        assert_eq!(stem, "4Yc1J3xyzAB - Arma\u{e9} - Bang Bang");
        let (id, artist, title) = crate::proxy::parse_vault_stem(&stem);
        assert_eq!(id, "4Yc1J3xyzAB");
        assert_eq!(artist, "Arma\u{e9}");
        assert_eq!(title, "Bang Bang");
    }

    /// Both the old `320kbps` labels and the new `opus96` ones land on the
    /// number the promotion check compares.
    #[test]
    fn stored_labels_read_back_as_bitrates() {
        assert_eq!(target_kbps(Some("128kbps")), 128);
        assert_eq!(target_kbps(Some("opus128")), 128);
        assert_eq!(target_kbps(Some("96")), 96);
        assert_eq!(target_kbps(None), 96);
        assert_eq!(target_kbps(Some("opus")), 96, "junk falls back");
        assert_eq!(stored_kbps("opus128"), 128);
        assert_eq!(stored_kbps("320kbps"), 320);
        assert_eq!(stored_kbps("unknown"), 96, "junk stays promotable");
        assert!(stored_kbps("unknown") < 128);
    }

    /// Vault filenames must be creatable on every desktop OS (review 5.2):
    /// separators and shell metacharacters are replaced, Windows device
    /// names are prefixed, unicode survives, and nothing runs away with the
    /// 120-char budget.
    #[test]
    fn file_names_are_portable_across_desktop_oses() {
        assert_eq!(safe_file_name("a/b\\c"), "a-b-c");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("con.mp3"), "_con.mp3");
        assert_eq!(safe_file_name("aux"), "_aux");
        assert_eq!(
            safe_file_name("console"),
            "console",
            "lookalikes are not reserved"
        );
        assert_eq!(
            safe_file_name("日本語 🎵"),
            "日本語 🎵",
            "unicode preserved"
        );
        assert_eq!(safe_file_name("   "), "track", "empty falls back");
        assert_eq!(safe_file_name(".hidden"), "hidden", "leading dots stripped");
        assert_eq!(safe_file_name(&"x".repeat(500)).len(), 120, "length capped");

        let traversal = safe_file_name("../../etc/passwd");
        assert!(!traversal.contains('/'));
        assert!(
            !traversal.starts_with('.'),
            "no leading parent hops: {traversal}"
        );

        let nasty = safe_file_name(r#"a<b>c:d"e|f?g*h"#);
        assert!(
            !nasty.contains(['<', '>', ':', '"', '|', '?', '*']),
            "{nasty}"
        );
    }
}
