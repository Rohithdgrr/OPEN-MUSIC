//! spotify.rs — Spotify Web API integration with OAuth 2.0 PKCE.
//!
//! Desktop OAuth via the installed-app loopback flow (RFC 8252 style):
//! an ephemeral 127.0.0.1 listener, PKCE-S256, no client secret. The
//! refresh token lives in the OS credential store (Windows Credential
//! Manager via `keyring`), never in a file or localStorage. The access
//! token is cached in memory only and refreshed on demand.
//!
//! Scope: user-top-read, user-library-read, playlist-read-private.
//!
//! The Spotify client id comes from the `TRANCE_MUSIC_SPOTIFY_CLIENT_ID`
//! compile-time env (a Spotify Dashboard "Desktop app" credential). Builds
//! without it compile and run fine; every command reports "not
//! configured" instead.

use std::time::{Duration, Instant};

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API_BASE: &str = "https://api.spotify.com/v1";

const SCOPES: &str = "user-top-read user-library-read playlist-read-private";

// Desktop-only: every reader sits behind `cfg(not(mobile))`, so on iOS and
// Android an ungated const is dead code and `-D warnings` fails the build.
#[cfg(not(mobile))]
const KEYRING_SERVICE: &str = "TRANCE MUSIC";
#[cfg(not(mobile))]
const KEYRING_USER: &str = "spotify-refresh-token";

/// How long the browser has to finish consent before sign-in gives up.
const SIGNIN_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

fn client_id() -> Result<&'static str, String> {
    match option_env!("TRANCE_MUSIC_SPOTIFY_CLIENT_ID") {
        Some(id) if !id.trim().is_empty() => Ok(id),
        _ => Err(
            "Spotify integration is not configured in this build (missing TRANCE_MUSIC_SPOTIFY_CLIENT_ID)."
                .to_string(),
        ),
    }
}

/// Same credential, for sibling modules (`canvas.rs`). The Spotify Dashboard
/// client id is shared: the cookie exchange and the PKCE flow both need it.
pub fn client_id_public() -> Result<&'static str, String> {
    client_id()
}

pub struct SpotifyState {
    http: reqwest::Client,
    inner: std::sync::Mutex<SpotifyInner>,
}

#[derive(Default)]
struct SpotifyInner {
    access_token: Option<String>,
    expires_at: Option<Instant>,
}

impl SpotifyState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            inner: std::sync::Mutex::new(SpotifyInner::default()),
        }
    }
}

// ---------------------------------------------------------- OS randomness -
fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|e| format!("randomness unavailable: {e}"))?;
    Ok(buf)
}

fn random_hex(n_bytes: usize) -> Result<String, String> {
    Ok(random_bytes(n_bytes)?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// PKCE S256 challenge for a verifier (RFC 7636 §4.2).
fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    let mut h = crate::sha256::Sha256::new();
    h.update(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize())
}

// ---------------------------------------------------------------- keychain -
#[cfg(not(mobile))]
fn keyring_save(refresh: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))?
        .set_password(refresh)
        .map_err(|e| format!("could not save Spotify sign-in: {e}"))
}

#[cfg(not(mobile))]
fn keyring_load() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read Spotify sign-in: {e}")),
    }
}

#[cfg(not(mobile))]
fn keyring_delete() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not clear Spotify sign-in: {e}")),
    }
}

// ------------------------------------------------------- token persistence -
// One seam, two backends. Desktop keeps the OS credential store (keyring) —
// byte-identical behaviour to before. Mobile cannot use `keyring` at all (it
// ships no Android/iOS backend, which is why the old mobile stubs returned
// Err), so the refresh token lands in the app's own sandboxed `store.db` kv
// table instead. `store` is ignored on desktop and required on mobile.
//
// Accepted tradeoff (docs/spotify-android-canvas.md §3A): app-private SQLite,
// not Android Keystore. Because every caller goes through these three fns, a
// later Keystore migration is a one-function change.

// Desktop reads/writes these through the OS credential store, so the kv keys
// exist only where the store-backed seam is compiled in. (The Canvas `sp_dc`
// key lives with its own module — see canvas.rs::SPDC_KEY.)
#[cfg(mobile)]
const TOKEN_KEY: &str = "spotify:refresh-token";

#[cfg(not(mobile))]
fn token_save(_store: &crate::store::AppStore, refresh: &str) -> Result<(), String> {
    keyring_save(refresh)
}

#[cfg(not(mobile))]
fn token_load(_store: &crate::store::AppStore) -> Result<Option<String>, String> {
    keyring_load()
}

#[cfg(not(mobile))]
fn token_delete(_store: &crate::store::AppStore) -> Result<(), String> {
    keyring_delete()
}

#[cfg(mobile)]
fn token_save(store: &crate::store::AppStore, refresh: &str) -> Result<(), String> {
    store.kv_put(TOKEN_KEY, refresh)
}

#[cfg(mobile)]
fn token_load(store: &crate::store::AppStore) -> Result<Option<String>, String> {
    // Empty means cleared (see token_delete): a leftover "" must read as
    // signed OUT, not `Some("")`.
    Ok(store.kv_get(TOKEN_KEY)?.filter(|v| !v.is_empty()))
}

#[cfg(mobile)]
fn token_delete(store: &crate::store::AppStore) -> Result<(), String> {
    // kv has no delete through this seam, so clear to "" — token_load filters
    // that out, which is why signout genuinely flips the status row.
    store.kv_put(TOKEN_KEY, "")
}

// ------------------------------------------------------------ loopback auth -
/// Decode one query/form value (`%XX` + `+`).
fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Parse the head of one loopback HTTP request into (code, state).
fn parse_callback_target(head: &str) -> Result<(String, String), String> {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err("unexpected loopback request".to_string());
    }
    let target = parts.next().ok_or("malformed loopback request")?;
    let (path, query) = match target.find('?') {
        Some(i) => (&target[..i], &target[i + 1..]),
        None => (target, ""),
    };
    if path != "/callback" {
        return Err("unexpected loopback path".to_string());
    }
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => continue,
        };
        match k {
            "code" => code = Some(percent_decode(v)),
            "state" => state = Some(percent_decode(v)),
            "error" => {
                return Err(format!(
                    "Spotify sign-in was not completed ({})",
                    percent_decode(v)
                ))
            }
            _ => {}
        }
    }
    match (code, state) {
        (Some(c), Some(s)) if !c.is_empty() && !s.is_empty() => Ok((c, s)),
        _ => Err("Spotify did not return an auth code".to_string()),
    }
}

const SUCCESS_PAGE: &str = "<!doctype html><html><body style=\"font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center\"><div><h2>Signed in to TRANCE MUSIC</h2><p>You can close this tab and return to the app.</p></div></body></html>";

async fn read_head(stream: &mut tokio::net::TcpStream) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 512];
    loop {
        let n = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "browser did not answer".to_string())?
            .map_err(|e| format!("loopback read failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 16 * 1024 {
            return Err("loopback request too large".to_string());
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(buf).map_err(|_| "loopback request was not HTTP".to_string())
}

async fn reply(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    use tokio::io::AsyncWriteExt;
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
}

/// Accept loopback connections until the OAuth callback arrives.
async fn wait_for_code(
    std_listener: std::net::TcpListener,
    want_state: &str,
) -> Result<String, String> {
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("loopback bind failed: {e}"))?;
    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|e| format!("loopback bind failed: {e}"))?;
    let deadline = Instant::now() + SIGNIN_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("sign-in timed out — the browser never came back".to_string());
        }
        let (mut stream, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| "sign-in timed out — the browser never came back".to_string())?
            .map_err(|e| format!("loopback accept failed: {e}"))?;
        let head = read_head(&mut stream).await.unwrap_or_default();
        match parse_callback_target(&head) {
            Ok((code, state)) if state == want_state => {
                reply(&mut stream, "200 OK", SUCCESS_PAGE).await;
                return Ok(code);
            }
            Ok(_) => {
                reply(&mut stream, "400 Bad Request", "Unknown sign-in request.").await;
                return Err("sign-in state mismatch — please try again".to_string());
            }
            Err(e) if head.contains("/callback") => {
                reply(&mut stream, "400 Bad Request", "Sign-in failed.").await;
                return Err(e);
            }
            Err(_) => {
                reply(&mut stream, "404 Not Found", "Not found.").await;
            }
        }
    }
}

/// Open a URL in the user's browser.
///
/// Desktop keeps its own shell-less launchers (Windows `ShellExecuteW`, macOS
/// `open`, Linux `xdg-open`). Mobile cannot spawn any of those, so it goes
/// through `tauri-plugin-opener`, which fires an Android `ACTION_VIEW` Intent —
/// that Intent is what hands the Spotify authorize URL to the system browser.
#[cfg(mobile)]
fn open_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("could not open the browser for Spotify sign-in: {e}"))
}

#[cfg(all(not(mobile), windows))]
fn open_browser(_app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (ret as usize) <= 32 {
        return Err("could not open the browser for Spotify sign-in".to_string());
    }
    Ok(())
}

#[cfg(all(not(mobile), not(windows)))]
fn open_browser(_app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map_err(|e| format!("could not open the browser for Spotify sign-in: {e}"))?;
    Ok(())
}

// ------------------------------------------------------------------ tokens -
#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
}

async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let cid = client_id()?;
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", cid),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify refused the auth code ({})",
            body.chars().take(200).collect::<String>()
        ));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("token exchange returned junk: {e}"))
}

async fn refresh_access(
    http: &reqwest::Client,
    store: &crate::store::AppStore,
) -> Result<(String, Instant), String> {
    let cid = client_id()?;
    let refresh = token_load(store)?.ok_or_else(|| "not signed in with Spotify".to_string())?;
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("refresh_token", refresh.as_str()),
            ("client_id", cid),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;
    if !resp.status().is_success() {
        return Err("Spotify session expired — please sign in again".to_string());
    }
    let tok = resp
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("token refresh returned junk: {e}"))?;
    let skew = tok.expires_in.clamp(0, 3600) - 60;
    Ok((
        tok.access_token,
        Instant::now() + Duration::from_secs(skew.max(60) as u64),
    ))
}

/// A usable access token, refreshing when missing, stale, or forced.
async fn authed(
    http: &reqwest::Client,
    state: &tauri::State<'_, SpotifyState>,
    store: &crate::store::AppStore,
    force_refresh: bool,
) -> Result<String, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|e| format!("Spotify state poisoned: {e}"))?;
        if !force_refresh {
            if let (Some(tok), Some(exp)) = (inner.access_token.clone(), inner.expires_at) {
                if Instant::now() < exp {
                    return Ok(tok);
                }
            }
        }
    }
    let (tok, exp) = refresh_access(http, store).await?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|e| format!("Spotify state poisoned: {e}"))?;
    inner.access_token = Some(tok.clone());
    inner.expires_at = Some(exp);
    Ok(tok)
}

#[allow(dead_code)]
fn forget_access(state: &tauri::State<'_, SpotifyState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.access_token = None;
        inner.expires_at = None;
    }
}

// ----------------------------------------------------------------- Spotify API -
#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct SpotifyTrack {
    id: String,
    name: String,
    artists: Vec<SpotifyArtist>,
    album: SpotifyAlbum,
    external_ids: SpotifyExternalIds,
    duration_ms: u64,
}

#[derive(serde::Deserialize)]
struct SpotifyArtist {
    name: String,
}

#[derive(serde::Deserialize)]
struct SpotifyAlbum {
    name: String,
}

#[derive(serde::Deserialize)]
struct SpotifyExternalIds {
    isrc: Option<String>,
}

#[derive(serde::Deserialize)]
struct TopTracksResponse {
    items: Vec<SpotifyTrack>,
}

#[derive(serde::Serialize)]
pub struct ImportedTrack {
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub isrc: Option<String>,
    pub duration_ms: u64,
}

/// Complete Spotify OAuth sign-in by starting the loopback server and
/// waiting for the callback.
#[tauri::command]
pub async fn spotify_signin(
    app: tauri::State<'_, crate::proxy::AppState>,
    handle: tauri::AppHandle,
) -> Result<bool, String> {
    let cid = client_id()?;
    let store = app.store()?;
    let verifier = random_hex(32)?;
    let challenge = pkce_challenge(&verifier);
    let state = random_hex(16)?;

    let redirect_uri = "http://127.0.0.1:4321/callback";
    let url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        AUTH_URL,
        cid,
        urlencoding::encode(redirect_uri),
        urlencoding::encode(SCOPES),
        urlencoding::encode(&state),
        urlencoding::encode(&challenge)
    );

    // Bind loopback listener before opening browser
    let listener = std::net::TcpListener::bind("127.0.0.1:4321")
        .map_err(|e| format!("could not bind loopback: {e}"))?;

    open_browser(&handle, &url)?;

    let http = reqwest::Client::new();
    let code = wait_for_code(listener, &state).await?;

    let tokens = exchange_code(&http, &code, &verifier, redirect_uri).await?;

    // OAuth omits `refresh_token` on a re-consent where the grant is already
    // live — the stored one still stands. But if NOTHING is stored, Ok(true)
    // here means "signed in" while the keyring stays empty, which is exactly
    // the status row that then never flips. Never claim success unpersisted.
    match tokens.refresh_token {
        Some(refresh) => token_save(store, &refresh)?,
        None if token_load(store)?.is_none() => {
            return Err(
                "Spotify approved the sign-in but sent no refresh token — nothing was saved"
                    .to_string(),
            );
        }
        None => {} // re-consent: the earlier refresh token is already stored
    }

    Ok(true)
}

/// Sign out from Spotify by clearing the stored refresh token.
#[tauri::command]
pub fn spotify_signout(app: tauri::State<'_, crate::proxy::AppState>) -> Result<(), String> {
    token_delete(app.store()?)
}

/// Check if the user is signed in with Spotify.
#[tauri::command]
pub fn spotify_is_signedin(app: tauri::State<'_, crate::proxy::AppState>) -> bool {
    app.store()
        .ok()
        .and_then(|s| token_load(s).ok().flatten())
        .is_some()
}

/// Import the user's top tracks from Spotify.
/// time_range: "short_term" (4 weeks), "medium_term" (6 months), "long_term" (several years)
/// limit: number of tracks to fetch (1-50)
#[tauri::command]
pub async fn spotify_import_top(
    state: tauri::State<'_, SpotifyState>,
    app: tauri::State<'_, crate::proxy::AppState>,
    time_range: String,
    limit: u32,
) -> Result<Vec<ImportedTrack>, String> {
    let store = app.store()?;
    let token = authed(&state.http, &state, store, false).await?;

    let time_range = match time_range.as_str() {
        "short_term" => "short_term",
        "medium_term" => "medium_term",
        "long_term" => "long_term",
        _ => {
            return Err(
                "invalid time_range: must be short_term, medium_term, or long_term".to_string(),
            )
        }
    };

    let limit = limit.clamp(1, 50);

    let resp = state
        .http
        .get(format!("{}/me/top/tracks", API_BASE))
        .bearer_auth(&token)
        .query(&[("time_range", time_range), ("limit", &limit.to_string())])
        .send()
        .await
        .map_err(|e| format!("Spotify API request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Spotify API error ({})",
            body.chars().take(200).collect::<String>()
        ));
    }

    let tracks: TopTracksResponse = resp
        .json()
        .await
        .map_err(|e| format!("Spotify API returned junk: {e}"))?;

    let imported: Vec<ImportedTrack> = tracks
        .items
        .into_iter()
        .map(|t| ImportedTrack {
            name: t.name,
            artists: t.artists.into_iter().map(|a| a.name).collect(),
            album: t.album.name,
            isrc: t.external_ids.isrc,
            duration_ms: t.duration_ms,
        })
        .collect();

    Ok(imported)
}

#[cfg(test)]
mod tests {
    // The only test below that reads it is itself `cfg(not(mobile))`, so the
    // import must be gated too or it dangles on iOS/Android.
    #[cfg(not(mobile))]
    use super::KEYRING_SERVICE;

    /// The load path in production always uses a *fresh* `Entry` (status check
    /// runs in a later IPC call than the save) — so the test must too. This is
    /// the exact assertion that fails when keyring silently falls back to its
    /// no-persistence mock store: the mock keeps data only inside the Entry
    /// that wrote it, and a fresh Entry reads NoEntry.
    #[cfg(not(mobile))]
    #[test]
    fn saved_token_survives_a_fresh_entry() {
        const USER: &str = "spotify-refresh-token-test";
        let entry = keyring::Entry::new(KEYRING_SERVICE, USER).unwrap();
        entry.delete_credential().ok();
        entry.set_password("roundtrip").unwrap();
        drop(entry);

        let fresh = keyring::Entry::new(KEYRING_SERVICE, USER).unwrap();
        assert_eq!(fresh.get_password().unwrap(), "roundtrip");
        fresh.delete_credential().unwrap();
    }
}
