//! TRANCE MUSIC — application shell.
//!
//! Owns: IPC command surface, DTO shaping, app lifecycle (window + proxy
//! port binding). Nothing here talks HTTP directly — that is `jiosaavn.rs`
//! (catalog) and `proxy.rs` (media relay) territory.

mod jiosaavn;
mod official;
mod proxy;

use std::sync::Arc;

use tauri::Manager;
use tauri::State;

use jiosaavn::{best_quality, check_id, PlayableAudio, RangeStatus, Track};
use proxy::{proxy_url_for, AppState};

/// Search the catalog. `limit` is clamped to 1..=40 (default 20) upstream,
/// `page` is 1-based so the UI can keep pulling results indefinitely.
/// Results are memoised per query+limit+page to reduce upstream pressure.
#[tauri::command]
async fn search_songs(
    query: String,
    limit: Option<u32>,
    page: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Track>, String> {
    state
        .cached_search(&query, limit.unwrap_or(20), page.unwrap_or(1))
        .await
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

/// Save a complete song to the user's Downloads folder.
///
/// Returns the path of the finished file. The relay's byte-count discipline
/// applies: a truncated body is deleted and reported, never handed back.
#[tauri::command]
async fn download_song(
    app: tauri::AppHandle,
    id: String,
    quality: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    check_id(&id)?;
    let prefer = quality.unwrap_or_else(|| "320kbps".to_string());
    let song = state.cached_song(&id).await?;
    let chosen = best_quality(&song.qualities, &prefer)
        .ok_or_else(|| "no stream qualities".to_string())?;

    let dir = match app.path().download_dir() {
        Ok(dir) => dir,
        Err(_) => std::env::temp_dir(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let file_name = format!(
        "{} - {}.m4a",
        safe_file_name(&song.track.artist),
        safe_file_name(&song.track.title)
    );
    let (path, written) = state.download_to(&chosen.url, &dir.join(file_name)).await?;
    eprintln!("[TRANCE MUSIC] saved {written} bytes to {}", path.display());
    Ok(path.display().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Ephemeral port, bound BEFORE the window loads: no hardcoded
            // port, no collision, no race (architecture.md §6).
            // NOTE: `setup` runs outside the Tokio runtime, so the std ->
            // tokio listener conversion happens inside the spawned task.
            let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            std_listener.set_nonblocking(true)?;
            let port = std_listener.local_addr()?.port();

            let state = Arc::new(AppState::new(port));
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
            resolve_song,
            qualify_url,
            proxy_base,
            download_song,
            home_feed,
            playlist_tracks
        ])
        .run(tauri::generate_context!())
        .expect("error while running TRANCE MUSIC");
}
