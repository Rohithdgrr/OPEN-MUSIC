//! gdrive.rs — Phase 2: optional Google sign-in + Drive `appDataFolder` CRUD.
//!
//! Desktop OAuth via the installed-app loopback flow (RFC 8252 style):
//! an ephemeral 127.0.0.1 listener, PKCE-S256, no client secret. The
//! refresh token lives in the OS credential store (Windows Credential
//! Manager via `keyring`), never in a file or localStorage. The access
//! token is cached in memory only and refreshed on demand.
//!
//! Scope is the narrow `drive.appdata`: the hidden, app-scoped folder.
//! Three docs live there — `trance-music-{favorites,playlists,settings}.json`
//! — matching the Phase 1 backup schema section by section.
//!
//! The OAuth client id comes from the `TRANCE_MUSIC_GOOGLE_CLIENT_ID`
//! compile-time env (a Google Cloud "Desktop app" credential). Builds
//! without it compile and run fine; every command reports "not
//! configured" instead.

use std::time::{Duration, Instant};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const DRIVE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";

const KEYRING_SERVICE: &str = "TRANCE MUSIC";
const KEYRING_USER: &str = "gdrive-refresh-token";

/// Mirrors sync.js: pushes bigger than this are refused before uploading.
const MAX_PUSH_BYTES: usize = 8 * 1024 * 1024;
/// How long the browser has to finish consent before sign-in gives up.
const SIGNIN_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

fn client_id() -> Result<&'static str, String> {
    match option_env!("TRANCE_MUSIC_GOOGLE_CLIENT_ID") {
        Some(id) if !id.trim().is_empty() => Ok(id),
        _ => Err(
            "Google Drive sync is not configured in this build (missing TRANCE_MUSIC_GOOGLE_CLIENT_ID)."
                .to_string(),
        ),
    }
}

/// One of the three synced docs; anything else is rejected before it can
/// become a filename in the user's Drive.
fn doc_filename(name: &str) -> Result<&'static str, String> {
    match name {
        "favorites" => Ok("trance-music-favorites.json"),
        "playlists" => Ok("trance-music-playlists.json"),
        "settings" => Ok("trance-music-settings.json"),
        _ => Err(format!("unknown sync doc: {name}")),
    }
}

pub struct GDriveState {
    http: reqwest::Client,
    inner: std::sync::Mutex<GDriveInner>,
}

#[derive(Default)]
struct GDriveInner {
    access_token: Option<String>,
    expires_at: Option<Instant>,
}

impl GDriveState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            inner: std::sync::Mutex::new(GDriveInner::default()),
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
        .map_err(|e| format!("could not save Google sign-in: {e}"))
}

#[cfg(not(mobile))]
fn keyring_load() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read Google sign-in: {e}")),
    }
}

#[cfg(not(mobile))]
fn keyring_delete() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not clear Google sign-in: {e}")),
    }
}

#[cfg(mobile)]
fn keyring_save(_refresh: &str) -> Result<(), String> {
    Err("Google sign-in is not supported on Android yet".to_string())
}

#[cfg(mobile)]
fn keyring_load() -> Result<Option<String>, String> {
    Err("Google sign-in is not supported on Android yet".to_string())
}

#[cfg(mobile)]
fn keyring_delete() -> Result<(), String> {
    Err("Google sign-in is not supported on Android yet".to_string())
}

// ------------------------------------------------------------ loopback auth -
/// Decode one query/form value (`%XX` + `+`). Google's codes are URL-safe
/// already; this is belt and braces for the state round-trip.
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
/// Pure, so the callback contract is unit-tested below.
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
                    "Google sign-in was not completed ({})",
                    percent_decode(v)
                ))
            }
            _ => {}
        }
    }
    match (code, state) {
        (Some(c), Some(s)) if !c.is_empty() && !s.is_empty() => Ok((c, s)),
        _ => Err("Google did not return an auth code".to_string()),
    }
}

const SUCCESS_PAGE: &str = "<!doctype html><html><body style=\"font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center\"><div><h2>Signed in to TRANCE MUSIC</h2><p>You can close this tab and return to the app.</p></div></body></html>";

async fn read_head(
    stream: &mut tokio::net::TcpStream,
) -> Result<String, String> {
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

/// Accept loopback connections until the OAuth callback arrives (other
/// paths, e.g. favicon, get a 404 and the wait continues). The listener is
/// passed in already bound: the port is claimed before the browser opens,
/// so nothing can steal it in between.
async fn wait_for_code(std_listener: std::net::TcpListener, want_state: &str) -> Result<String, String> {
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
                // favicon and friends: ignore, keep waiting.
                reply(&mut stream, "404 Not Found", "Not found.").await;
            }
        }
    }
}

/// Open a URL in the user's browser without a shell: the auth URL carries
/// `&` separators that `cmd /C start` would split into separate commands.
#[cfg(windows)]
fn open_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let ret = unsafe { ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if (ret as usize) <= 32 {
        return Err("could not open the browser for Google sign-in".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_browser(url: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(url)
        .spawn()
        .map_err(|e| format!("could not open the browser for Google sign-in: {e}"))?;
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
        return Err(format!("Google refused the auth code ({})", body.chars().take(200).collect::<String>()));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("token exchange returned junk: {e}"))
}

async fn refresh_access(http: &reqwest::Client) -> Result<(String, Instant), String> {
    let cid = client_id()?;
    let refresh = keyring_load()?.ok_or_else(|| "not signed in with Google".to_string())?;
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
        return Err("Google session expired — please sign in again".to_string());
    }
    let tok = resp
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("token refresh returned junk: {e}"))?;
    let skew = tok.expires_in.clamp(0, 3600) - 60;
    Ok((tok.access_token, Instant::now() + Duration::from_secs(skew.max(60) as u64)))
}

/// A usable access token, refreshing when missing, stale, or forced.
async fn authed(
    http: &reqwest::Client,
    state: &tauri::State<'_, GDriveState>,
    force_refresh: bool,
) -> Result<String, String> {
    {
        let inner = state.inner.lock().map_err(|e| format!("sync state poisoned: {e}"))?;
        if !force_refresh {
            if let (Some(tok), Some(exp)) = (inner.access_token.clone(), inner.expires_at) {
                if Instant::now() < exp {
                    return Ok(tok);
                }
            }
        }
    }
    let (tok, exp) = refresh_access(http).await?;
    let mut inner = state.inner.lock().map_err(|e| format!("sync state poisoned: {e}"))?;
    inner.access_token = Some(tok.clone());
    inner.expires_at = Some(exp);
    Ok(tok)
}

fn forget_access(state: &tauri::State<'_, GDriveState>) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.access_token = None;
        inner.expires_at = None;
    }
}

// ------------------------------------------------------------------- Drive -
#[derive(serde::Deserialize)]
struct DriveList {
    files: Vec<DriveFile>,
}

#[derive(serde::Deserialize)]
struct DriveFile {
    id: String,
}

#[derive(serde::Deserialize)]
struct DriveCreateResp {
    id: String,
}

fn drive_error(status: reqwest::StatusCode, body: String) -> String {
    format!(
        "Google Drive request failed ({status}): {}",
        body.chars().take(200).collect::<String>()
    )
}

async fn drive_find(http: &reqwest::Client, token: &str, filename: &str) -> Result<Option<String>, String> {
    let q = format!("name = '{filename}' and 'appDataFolder' in parents and trashed = false");
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", &q)
        .append_pair("spaces", "appDataFolder")
        .append_pair("fields", "files(id)")
        .append_pair("pageSize", "1")
        .finish();
    let resp = http
        .get(format!("{DRIVE_FILES}?{query}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Drive lookup failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("UNAUTHORIZED".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(drive_error(status, body));
    }
    let list = resp
        .json::<DriveList>()
        .await
        .map_err(|e| format!("Drive lookup returned junk: {e}"))?;
    Ok(list.files.into_iter().next().map(|f| f.id))
}

async fn drive_download(http: &reqwest::Client, token: &str, id: &str) -> Result<Vec<u8>, String> {
    let resp = http
        .get(format!("{DRIVE_FILES}/{id}"))
        .query(&[("alt", "media")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Drive download failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("UNAUTHORIZED".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(drive_error(status, body));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Drive download failed: {e}"))
}

async fn drive_upload(
    http: &reqwest::Client,
    token: &str,
    id: Option<&str>,
    filename: &str,
    bytes: &[u8],
) -> Result<String, String> {
    // Two-step upload (metadata, then media bytes) so reqwest needs no
    // multipart feature: create the entry, then PUT the content.
    let file_id = match id {
        Some(existing) => existing.to_string(),
        None => {
            let resp = http
                .post(DRIVE_FILES)
                .bearer_auth(token)
                .json(&serde_json::json!({ "name": filename, "parents": ["appDataFolder"] }))
                .send()
                .await
                .map_err(|e| format!("Drive create failed: {e}"))?;
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err("UNAUTHORIZED".to_string());
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(drive_error(status, body));
            }
            resp.json::<DriveCreateResp>()
                .await
                .map_err(|e| format!("Drive create returned junk: {e}"))?
                .id
        }
    };
    let resp = http
        .patch(format!("{DRIVE_UPLOAD}/{file_id}?uploadType=media"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| format!("Drive upload failed: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("UNAUTHORIZED".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(drive_error(status, body));
    }
    Ok(file_id)
}

/// Run `op` with a token, refreshing once and retrying on a 401.
async fn with_drive<F, Fut, T>(
    http: &reqwest::Client,
    state: &tauri::State<'_, GDriveState>,
    op: F,
) -> Result<T, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let token = authed(http, state, false).await?;
    match op(token).await {
        Err(e) if e == "UNAUTHORIZED" => {
            let token = authed(http, state, true).await?;
            op(token).await
        }
        other => other,
    }
}

// ---------------------------------------------------------------- commands -
#[derive(serde::Serialize)]
pub struct GDriveStatus {
    pub configured: bool,
    pub signed_in: bool,
}

/// Configured = a client id was baked in; signed in = a refresh token is
/// in the OS credential store. Never throws: the settings UI renders both.
#[tauri::command]
pub fn gdrive_status(state: tauri::State<'_, GDriveState>) -> GDriveStatus {
    let _ = &state;
    let configured = client_id().is_ok();
    let signed_in = configured && matches!(keyring_load(), Ok(Some(_)));
    GDriveStatus {
        configured,
        signed_in,
    }
}

/// Full interactive sign-in: opens the browser, waits on loopback for the
/// code, exchanges it, and stores the refresh token in the OS keychain.
/// `prompt=consent` guarantees a refresh token even on re-sign-in.
#[tauri::command]
pub async fn gdrive_sign_in(
    state: tauri::State<'_, GDriveState>,
) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("Google sign-in is not supported on Android yet".to_string());
    }
    let cid = client_id()?;
    let verifier = {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes(32)?)
    };
    let challenge = pkce_challenge(&verifier);
    let oauth_state = random_hex(16)?;
    // Ephemeral port, bound BEFORE the browser opens: no hardcoded port,
    // no collision, no race.
    let std_listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = std_listener.local_addr().map_err(|e| format!("loopback bind failed: {e}"))?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", cid)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", &oauth_state)
        .finish();
    open_browser(&format!("{AUTH_URL}?{query}"))?;
    let code = wait_for_code(std_listener, &oauth_state).await?;
    let tok = exchange_code(&state.http, &code, &verifier, &redirect_uri).await?;
    let refresh = tok
        .refresh_token
        .ok_or_else(|| "Google did not return a refresh token — please try again".to_string())?;
    keyring_save(&refresh)?;
    let skew = tok.expires_in.clamp(0, 3600) - 60;
    let mut inner = state.inner.lock().map_err(|e| format!("sync state poisoned: {e}"))?;
    inner.access_token = Some(tok.access_token);
    inner.expires_at = Some(Instant::now() + Duration::from_secs(skew.max(60) as u64));
    Ok(())
}

/// Sign out: revoke server-side (best effort), drop the keychain entry and
/// the cached access token. Local favorites / playlists / settings stay.
#[tauri::command]
pub async fn gdrive_sign_out(state: tauri::State<'_, GDriveState>) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("Google sign-in is not supported on Android yet".to_string());
    }
    if let Ok(Some(refresh)) = keyring_load() {
        let _ = state
            .http
            .post(REVOKE_URL)
            .form(&[("token", refresh.as_str())])
            .send()
            .await;
    }
    forget_access(&state);
    keyring_delete()
}

/// Upload one sync doc (`favorites` | `playlists` | `settings`). Returns the
/// Drive file id. Creates the file on first push.
#[tauri::command]
pub async fn gdrive_push(
    state: tauri::State<'_, GDriveState>,
    doc: String,
    json: String,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("Google Drive sync is not supported on Android yet".to_string());
    }
    client_id()?;
    let filename = doc_filename(&doc)?;
    if json.len() > MAX_PUSH_BYTES {
        return Err(format!("sync doc too large: {} bytes", json.len()));
    }
    let bytes = json.into_bytes();
    with_drive(&state.http, &state, |token| {
        let http = state.http.clone();
        let bytes = bytes.clone();
        let filename = filename.to_string();
        async move {
            let id = drive_find(&http, &token, &filename).await?;
            drive_upload(&http, &token, id.as_deref(), &filename, &bytes).await
        }
    })
    .await
}

/// Download one sync doc. `Ok(None)` means nothing was ever pushed.
#[tauri::command]
pub async fn gdrive_pull(
    state: tauri::State<'_, GDriveState>,
    doc: String,
) -> Result<Option<String>, String> {
    if cfg!(mobile) {
        return Err("Google Drive sync is not supported on Android yet".to_string());
    }
    client_id()?;
    let filename = doc_filename(doc.as_str())?;
    with_drive(&state.http, &state, |token| {
        let http = state.http.clone();
        let filename = filename.to_string();
        async move {
            match drive_find(&http, &token, &filename).await? {
                None => Ok(None),
                Some(id) => {
                    let bytes = drive_download(&http, &token, &id).await?;
                    String::from_utf8(bytes)
                        .map(Some)
                        .map_err(|_| "Drive returned a file that is not text".to_string())
                }
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{doc_filename, parse_callback_target, percent_decode, pkce_challenge};

    #[test]
    fn pkce_matches_the_rfc_7636_test_vector() {
        // RFC 7636 Appendix B: verifier -> challenge, S256
        // (cross-checked against an independent SHA-256 oracle).
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_parses_code_and_state() {
        let (code, state) =
            parse_callback_target("GET /callback?code=4%2Fabc&state=deadbeef HTTP/1.1\r\nHost: x\r\n\r\n")
                .unwrap();
        assert_eq!(code, "4/abc");
        assert_eq!(state, "deadbeef");
    }

    #[test]
    fn callback_reports_consent_denied_and_missing_parts() {
        assert!(parse_callback_target("GET /callback?error=access_denied&state=s HTTP/1.1").is_err());
        assert!(parse_callback_target("GET /callback?state=s HTTP/1.1").is_err());
        assert!(parse_callback_target("GET /favicon.ico HTTP/1.1").is_err());
        assert!(parse_callback_target("POST /callback?code=a&state=b HTTP/1.1").is_err());
    }

    #[test]
    fn percent_decode_handles_escapes_and_plus() {
        assert_eq!(percent_decode("a%2Fb+c"), "a/b c");
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }

    #[test]
    fn only_the_three_sync_docs_are_addressable() {
        assert!(doc_filename("favorites").is_ok());
        assert!(doc_filename("playlists").is_ok());
        assert!(doc_filename("settings").is_ok());
        assert!(doc_filename("../evil").is_err());
        assert!(doc_filename("").is_err());
    }
}
