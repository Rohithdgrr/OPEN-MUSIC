//! TRANCE MUSIC — application shell.
//!
//! Owns: IPC command surface, DTO shaping, app lifecycle (window + proxy
//! port binding). Nothing here talks HTTP directly — that is `jiosaavn.rs`
//! (catalog) and `proxy.rs` (media relay) territory.

mod jiosaavn;
mod lyrics;
mod official;
mod proxy;

use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use tauri::State;

use jiosaavn::{best_quality, check_id, PlayableAudio, RangeStatus, SearchPage, Track};
use proxy::{proxy_url_for, AppState, DownloadEntry, Vault};

/// Payload of the `download-progress` event, emitted while a song is saved.
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
        .cached_search(&query, limit.unwrap_or(20), page.unwrap_or(1))
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
    official::search_entities(&state.client, &kind, &query, limit.unwrap_or(20), page.unwrap_or(1))
        .await
}

/// Inline suggestions for the search box: the top match plus a few songs,
/// albums, artists and playlists, all from one `autocomplete.get` round-trip.
#[tauri::command]
async fn search_suggestions(
    query: String,
    state: State<'_, Arc<AppState>>,
) -> Result<official::Suggestions, String> {
    official::suggestions(&state.client, &query).await
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
    let chosen = best_quality(&song.qualities, &prefer)
        .ok_or_else(|| "no stream qualities".to_string())?;

    let probe = state.cached_qualify(&chosen.url).await?;

    let host = url::Url::parse(&chosen.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();

    Ok(PlayableAudio {
        id,
        title: song.track.title,
        artist: song.track.artist,
        direct_url: chosen.url.clone(),
        proxy_url: proxy_url_for(state.port, &chosen.url),
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
    official::playlist_tracks(&state.client, &id).await
}

/// Every track of an album (album token = last segment of its page url).
#[tauri::command]
async fn album_tracks(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Track>, String> {
    official::album_tracks(&state.client, &token).await
}

/// One page of an artist's catalogue (artist token = last segment of its page
/// url). Page 0 is the popular set; later pages walk the rest of the works.
#[tauri::command]
async fn artist_tracks(
    token: String,
    page: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> Result<official::ArtistSongPage, String> {
    official::artist_tracks(&state.client, &token, page.unwrap_or(0)).await
}

/// Artist header + the complete discography the artist screen renders under
/// the tracks (name, listeners, bio, every album/single/EP).
#[tauri::command]
async fn artist_overview(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<official::ArtistOverview, String> {
    official::artist_overview(&state.client, &token).await
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
    let trimmed = trimmed.chars().take(120).collect::<String>().trim().to_string();
    if trimmed.is_empty() {
        "track".to_string()
    } else {
        trimmed
    }
}

/// Save a complete song to the user's offline vault.
///
/// Emits `download-progress` while the body streams and records the file in
/// `<vault>/index.json` when the byte count matches what the CDN declared.
/// Returns the path of the finished file.
#[tauri::command]
async fn download_song(
    app: tauri::AppHandle,
    id: String,
    quality: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    use tauri::Emitter;

    check_id(&id)?;
    let prefer = quality.unwrap_or_else(|| "320kbps".to_string());
    let song = state.cached_song(&id).await?;
    let chosen = best_quality(&song.qualities, &prefer)
        .ok_or_else(|| "no stream qualities".to_string())?;

    // Stop the old copy resolving while its file is being rewritten.
    state.forget(&id)?;

    std::fs::create_dir_all(&state.vault)
        .map_err(|e| format!("create {}: {e}", state.vault.display()))?;
    let file_name = format!(
        "{} - {}.m4a",
        safe_file_name(&song.track.artist),
        safe_file_name(&song.track.title)
    );
    let dest = state.vault.join(&file_name);

    let progress = DownloadProgress {
        id: id.clone(),
        title: song.track.title.clone(),
        artist: song.track.artist.clone(),
        album: song.track.album.clone(),
        image: song.track.image.clone(),
        quality: chosen.quality.clone(),
        received: 0,
        total: None,
        done: false,
    };
    let emitter = app.clone();
    let (path, written) = state
        .download_to(&chosen.url, &dest, |received, total| {
            let mut event = progress.clone();
            event.received = received;
            event.total = total;
            let _ = emitter.emit("download-progress", &event);
        })
        .await?;

    state.record(DownloadEntry {
        id,
        title: song.track.title,
        artist: song.track.artist,
        album: song.track.album,
        image: song.track.image,
        duration_secs: song.track.duration_secs,
        quality: chosen.quality,
        path: path.display().to_string(),
        bytes: written,
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })?;

    let mut event = progress;
    event.received = written;
    event.done = true;
    let _ = emitter.emit("download-progress", &event);

    eprintln!("[TRANCE MUSIC] saved {written} bytes to {}", path.display());
    Ok(path.display().to_string())
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
fn reparent(win: &tauri::WebviewWindow, embed: bool) -> Result<(), String> {
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
        let is_worker = len as usize == WORKERW.len() - 1 && &class[..len as usize] == &WORKERW[..7];
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
fn reparent(_win: &tauri::WebviewWindow, _embed: bool) -> Result<(), String> {
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

/// Begin an OS drag of the frameless card from its header.
#[tauri::command]
fn widget_start_drag(win: tauri::WebviewWindow) -> Result<(), String> {
    win.start_dragging().map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Ephemeral port, bound BEFORE the window loads: no hardcoded
            // port, no collision, no race (docs/architecture.md §6).
            // NOTE: `setup` runs outside the Tokio runtime, so the std ->
            // tokio listener conversion happens inside the spawned task.
            let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            std_listener.set_nonblocking(true)?;
            let port = std_listener.local_addr()?.port();

            // Offline vault lives beside the user's other downloads.
            let vault = app
                .path()
                .download_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("TRANCE MUSIC");
            let _ = std::fs::create_dir_all(&vault);

            let state = Arc::new(AppState::new(port, vault));
            app.manage(state.clone());

            let router = proxy::router(state);
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(listener) => {
                        let _ = axum::serve(listener, router).await;
                    }
                    Err(e) => eprintln!("proxy bind failed: {e}"),
                }
            });

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
            home_feed,
            playlist_tracks,
            album_tracks,
            artist_tracks,
            artist_overview,
            get_lyrics,
            download_song,
            list_downloads,
            remove_download,
            reveal_download,
            reveal_vault,
            widget_show,
            widget_embed,
            widget_set_position,
            widget_start_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running TRANCE MUSIC");
}
