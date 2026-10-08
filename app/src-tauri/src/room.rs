//! room.rs — Listen Together room server + guest client (docs/listen-together.md).
//!
//! Milestone 1 of the two-device feature: this module owns **both** sockets —
//! the LAN server a host opens (`0.0.0.0:8787` while a room exists) and the
//! client a guest dials with — so the WebView CSP never gains a `ws://*`
//! entry and every path below is exercised for real by `cargo test`
//! (a live two-client integration suite at the bottom of this file).
//!
//! Protocol: JSON frames over WebSocket, `v:1`, schema in
//! docs/listen-together.md §3. The frame `t` strings here are the contract —
//! `app/src/room.js` reduces them on the JS side.
//!
//! Security model (docs/listen-together.md §7): plain LAN trust, no TLS, no
//! auth; the 8-symbol room code (~140 bits) is a bearer credential. The
//! server exists only between `room_open` and `room_close`/exit.

use std::collections::{HashMap, VecDeque};
use std::net::{
    IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener, ToSocketAddrs, UdpSocket,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

/// Default listen port for the room server (docs/listen-together.md §2).
pub const DEFAULT_PORT: u16 = 8787;
/// Maximum remote members in one room (the host is not counted against this).
const MAX_GUESTS: usize = 8;
/// Room code: 32 symbols with `0/O/1/I` removed so it survives being read
/// aloud or typed across two desks.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/// Chat: at most this many messages per member inside `CHAT_WINDOW_MS`.
const CHAT_MAX: usize = 5;
const CHAT_WINDOW_MS: u64 = 10_000;
const CHAT_MAX_CHARS: usize = 500;
const HISTORY_CAP: usize = 50;

// ------------------------------------------------------------------ helpers -

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Eight unconfusable symbols. 256 % 32 == 0, so a plain modulo of a random
/// byte is bias-free against this alphabet.
fn gen_code() -> String {
    let mut buf = [0u8; 8];
    if getrandom::getrandom(&mut buf).is_err() {
        // No OS entropy — fall back to time-based bytes rather than panic;
        // the code only needs to be unguessable-ish, the LAN gate is first.
        let t = now_ms().to_le_bytes();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = t[i % t.len()].wrapping_mul(31).wrapping_add(i as u8);
        }
    }
    buf.iter()
        .map(|&b| CODE_ALPHABET[b as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

fn sanitize_name(raw: &str) -> String {
    let clean: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(24)
        .collect();
    if clean.is_empty() {
        "Guest".to_string()
    } else {
        clean
    }
}

/// True for addresses a guest may dial: loopback or RFC1918/link-local
/// IPv4, or `localhost`. Hostnames and public IPs are refused so this app
/// can never be pointed at (or become) a public relay by accident.
fn is_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            if ip.is_loopback() {
                return true;
            }
            let o = octets(&ip);
            // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16.
            o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 169 && o[1] == 254)
        }
        Ok(IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

fn octets(ip: &Ipv4Addr) -> [u8; 4] {
    ip.octets()
}

/// `"192.168.1.5"`, `"192.168.1.5:9000"` or `"ws://192.168.1.5:9000"` →
/// `(host, port)`. Error strings are shown to the user verbatim — they say
/// what to type, never anything about internals.
fn parse_room_addr(raw: &str) -> Result<(String, u16), String> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("ws://") {
        s = rest;
    } else if s.strip_prefix("wss://").is_some() {
        return Err("No TLS on a LAN room — use ws:// (or just the address).".into());
    }
    let s = s.trim_end_matches('/');

    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            let port: u16 = p
                .parse()
                .map_err(|_| "Port must be a number between 1 and 65535.".to_string())?;
            (h, port)
        }
        _ => (s, DEFAULT_PORT),
    };
    let host = host.trim().trim_start_matches('/').to_string();
    if host.is_empty() {
        return Err("Enter the host's LAN address, e.g. 192.168.1.5".into());
    }
    if !is_private_host(&host) {
        return Err("Enter a LAN or loopback address, e.g. 192.168.1.5".into());
    }
    Ok((host, port))
}

/// Best-effort local IPv4s for the invite line. The UDP-connect trick finds
/// the default-route interface without sending a packet; a hostname lookup
/// covers a LAN with no default route. Loopback is always offered last so a
/// same-machine test still works.
fn lan_urls(port: u16) -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();
    {
        let mut push = |ip: Ipv4Addr| {
            let s = ip.to_string();
            if !ip.is_loopback() && !ip.is_unspecified() && !ips.contains(&s) {
                ips.push(s);
            }
        };
        if let Ok(u) = UdpSocket::bind(("0.0.0.0", 0)) {
            for target in [("8.8.8.8", 80u16), ("1.1.1.1", 80)] {
                if u.connect(target).is_ok() {
                    if let Ok(SocketAddr::V4(a)) = u.local_addr() {
                        push(*a.ip());
                    }
                    break;
                }
            }
        }
        let hostname = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default();
        if !hostname.is_empty() {
            if let Ok(addrs) = (hostname.as_str(), 0u16).to_socket_addrs() {
                for addr in addrs {
                    if let SocketAddr::V4(a) = addr {
                        push(*a.ip());
                    }
                }
            }
        }
    }
    let mut out: Vec<String> = ips
        .into_iter()
        .map(|ip| format!("ws://{ip}:{port}"))
        .collect();
    out.push(format!("ws://127.0.0.1:{port}"));
    out
}

// ------------------------------------------------------------------- frames -

fn err_frame(code: &str, message: impl Into<String>) -> Value {
    json!({ "t": "error", "code": code, "message": message.into() })
}

// --------------------------------------------------------------------- core -

/// Where a frame goes: the host window (Tauri event) or a guest's socket
/// writer (channel). `Chan` keeps the core testable without a Tauri app.
#[derive(Clone)]
enum Sink {
    App(AppHandle),
    Chan(mpsc::UnboundedSender<String>),
}

impl Sink {
    fn send(&self, frame: &Value) {
        match self {
            Sink::App(app) => {
                let _ = app.emit("room://msg", frame);
            }
            Sink::Chan(tx) => {
                let _ = tx.send(frame.to_string());
            }
        }
    }
}

#[derive(Clone)]
struct Member {
    id: String,
    name: String,
    host: bool,
    drift_ms: Option<i64>,
}

impl Member {
    fn to_json(&self) -> Value {
        let mut v = json!({ "id": self.id, "name": self.name, "host": self.host });
        if let Some(d) = self.drift_ms {
            v["driftMs"] = json!(d);
        }
        v
    }
}

/// One room, one code. Guarded by a std Mutex: every critical section here
/// is short and non-async (channel sends and an event emit never block), so
/// the guard is never held across an await. All methods assume the caller
/// already holds the lock.
struct RoomCore {
    code: String,
    members: Vec<Member>,         // members[0] is always the host
    host_sink: Sink,              // the host window hears every broadcast
    sinks: HashMap<String, Sink>, // guest id → socket writer
    history: VecDeque<Value>,     // last N chat frames, replayed on join
    playback: Option<Value>,      // last host playback frame, replayed on join
    chat_stamps: HashMap<String, VecDeque<u64>>,
    next_id: u64,
}

impl RoomCore {
    fn new(code: &str, host_name: &str, host_sink: Sink) -> Self {
        RoomCore {
            code: code.to_string(),
            members: vec![Member {
                id: "host".to_string(),
                name: sanitize_name(host_name),
                host: true,
                drift_ms: None,
            }],
            host_sink,
            sinks: HashMap::new(),
            history: VecDeque::new(),
            playback: None,
            chat_stamps: HashMap::new(),
            next_id: 0,
        }
    }

    fn presence_frame(&self) -> Value {
        json!({
            "t": "presence",
            "members": self.members.iter().map(|m| m.to_json()).collect::<Vec<_>>(),
        })
    }

    fn broadcast(&self, frame: &Value) {
        // The host window hears everything too: its own chat echo, guest
        // presence and (for uniformity) playback — the JS reducer ignores
        // playback while it is the host.
        self.host_sink.send(frame);
        for sink in self.sinks.values() {
            sink.send(frame);
        }
    }

    /// Accept a join. Sends the welcome frames (joined → history → cached
    /// playback) to the new member's sink *inside the lock*, then broadcasts
    /// presence and asks the host for a fresh playback state — the ordering
    /// guarantee is why this is not three separate calls.
    fn join(&mut self, code_in: &str, name: &str, sink: Sink) -> Result<String, (String, String)> {
        if !self.code.eq_ignore_ascii_case(code_in.trim()) {
            return Err((
                "bad_code".into(),
                "Wrong room code — check the code shown on the host.".into(),
            ));
        }
        if self.members.len() > MAX_GUESTS {
            return Err((
                "room_full".into(),
                format!("Room is full ({MAX_GUESTS} members maximum)."),
            ));
        }
        self.next_id += 1;
        let id = format!("g{}", self.next_id);

        let welcome = {
            let mut w = vec![
                json!({
                    "t": "joined",
                    "v": 1,
                    "code": self.code,
                    "selfId": id,
                    "youAreHost": false,
                    "members": self.members.iter().map(|m| m.to_json()).collect::<Vec<_>>(),
                }),
                json!({ "t": "history", "msgs": self.history.iter().cloned().collect::<Vec<_>>() }),
            ];
            if let Some(pb) = &self.playback {
                w.push(pb.clone());
            }
            w
        };
        for frame in &welcome {
            sink.send(frame);
        }

        self.members.push(Member {
            id: id.clone(),
            name: sanitize_name(name),
            host: false,
            drift_ms: None,
        });
        self.sinks.insert(id.clone(), sink);

        let presence = self.presence_frame();
        self.broadcast(&presence);
        self.host_sink.send(&json!({ "t": "refresh" }));
        Ok(id)
    }

    fn chat(&mut self, id: &str, raw: &str) -> Result<(), (String, String)> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(("empty".into(), "Message is empty.".into()));
        }
        if text.chars().count() > CHAT_MAX_CHARS {
            return Err((
                "too_long".into(),
                format!("Message too long (max {CHAT_MAX_CHARS} characters)."),
            ));
        }
        let now = now_ms();
        let stamps = self.chat_stamps.entry(id.to_string()).or_default();
        while let Some(&oldest) = stamps.front() {
            if now.saturating_sub(oldest) >= CHAT_WINDOW_MS {
                stamps.pop_front();
            } else {
                break;
            }
        }
        if stamps.len() >= CHAT_MAX {
            return Err((
                "rate_limited".into(),
                "Slow down — at most 5 messages every 10 seconds.".into(),
            ));
        }
        stamps.push_back(now);

        let name = self
            .members
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| "Guest".into());
        let frame = json!({
            "t": "chat",
            "from": { "id": id, "name": name },
            "text": text,
            "ts": now,
        });
        self.history.push_back(frame.clone());
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
        self.broadcast(&frame);
        Ok(())
    }

    /// Host-authoritative playback state. Cached so a late joiner sees the
    /// current song in its welcome, and stamped with server time as the
    /// guest's timeline anchor (`at`, docs/listen-together.md §4).
    fn playback(
        &mut self,
        playing: bool,
        track_id: &str,
        title: &str,
        artist: &str,
        position_ms: u64,
    ) {
        let frame = json!({
            "t": "playback",
            "playing": playing,
            "trackId": track_id,
            "title": title,
            "artist": artist,
            "positionMs": position_ms,
            "at": now_ms(),
        });
        self.playback = Some(frame.clone());
        self.broadcast(&frame);
    }

    fn report(&mut self, id: &str, drift_ms: i64) {
        if let Some(m) = self.members.iter_mut().find(|m| m.id == id) {
            // Clamped so a hostile client cannot paint absurd numbers into
            // the host's sync tile.
            m.drift_ms = Some(drift_ms.clamp(-3_600_000, 3_600_000));
        }
        let presence = self.presence_frame();
        self.broadcast(&presence);
    }

    fn remove(&mut self, id: &str) {
        if self.sinks.remove(id).is_none() {
            return; // never was a member (failed join)
        }
        self.members.retain(|m| m.id != id);
        self.chat_stamps.remove(id);
        let presence = self.presence_frame();
        self.broadcast(&presence);
    }

    fn close(&mut self, reason: &str) {
        let bye = json!({ "t": "bye", "reason": reason });
        self.broadcast(&bye);
        self.sinks.clear();
        self.members.truncate(1);
    }
}

type SharedCore = Arc<Mutex<RoomCore>>;

fn lock(core: &SharedCore) -> Option<std::sync::MutexGuard<'_, RoomCore>> {
    core.lock().ok()
}

// ------------------------------------------------------------------ server --

async fn ws_handler(
    upgrade: WebSocketUpgrade,
    State(core): State<SharedCore>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| serve_conn(socket, core))
}

/// One guest connection: require `join` within 5 s, then relay `chat` /
/// `report` and refuse `playback` (host-only, verbatim `not_host`).
async fn serve_conn(socket: WebSocket, core: SharedCore) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    // Writer task: everything outbound to this guest funnels through the
    // channel, so frame ordering is decided by one FIFO.
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if ws_tx.send(WsMessage::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let first = match tokio::time::timeout(Duration::from_secs(5), ws_rx.next()).await {
        Ok(Some(Ok(WsMessage::Text(t)))) => t.to_string(),
        _ => {
            drop(out_tx);
            return;
        }
    };

    let id = {
        let parsed: Value = match serde_json::from_str(&first) {
            Ok(v) => v,
            Err(_) => {
                let _ = out_tx.send(
                    err_frame("invalid_message", "First frame must be a JSON join.").to_string(),
                );
                return;
            }
        };
        if parsed.get("t").and_then(Value::as_str) != Some("join") {
            let _ = out_tx
                .send(err_frame("invalid_message", "First frame must be a JSON join.").to_string());
            return;
        }
        let code = parsed.get("code").and_then(Value::as_str).unwrap_or("");
        let name = parsed
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Guest");
        let mut guard = match lock(&core) {
            Some(g) => g,
            None => return,
        };
        match guard.join(code, name, Sink::Chan(out_tx.clone())) {
            Ok(id) => id,
            Err((code, message)) => {
                let _ = out_tx.send(err_frame(&code, message).to_string());
                return; // out_tx drop closes the socket after the error frame
            }
        }
    };

    loop {
        match ws_rx.next().await {
            Some(Ok(WsMessage::Text(t))) => {
                let frame: Value = match serde_json::from_str(&t.to_string()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match frame.get("t").and_then(Value::as_str) {
                    Some("chat") => {
                        let text = frame.get("text").and_then(Value::as_str).unwrap_or("");
                        if let Some(mut g) = lock(&core) {
                            if let Err((code, message)) = g.chat(&id, text) {
                                let _ = out_tx.send(err_frame(&code, message).to_string());
                            }
                        }
                    }
                    Some("report") => {
                        let drift = frame.get("driftMs").and_then(Value::as_i64).unwrap_or(0);
                        if let Some(mut g) = lock(&core) {
                            g.report(&id, drift);
                        }
                    }
                    Some("playback") => {
                        let _ = out_tx.send(
                            err_frame("not_host", "Only the host can control playback.")
                                .to_string(),
                        );
                    }
                    Some("leave") => break,
                    _ => {
                        let _ = out_tx.send(
                            err_frame("unknown_message_type", "Unknown message type.").to_string(),
                        );
                    }
                }
            }
            Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => {} // ping/pong/binary: ignored, protocol is text
        }
    }

    if let Some(mut g) = lock(&core) {
        g.remove(&id);
    }
    drop(out_tx);
    let _ = writer.await;
}

fn make_router(core: SharedCore) -> Router {
    Router::new().route("/ws", get(ws_handler)).with_state(core)
}

/// Serve until `shutdown` resolves. Shared by the command and the tests so
/// the tests exercise the exact server the app runs.
async fn serve(
    listener: StdTcpListener,
    core: SharedCore,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(listener, make_router(core))
        .with_graceful_shutdown(shutdown)
        .await
}

// -------------------------------------------------------------- guest task --

/// The guest socket task. `join_frame` goes out first; after that every
/// inbound text frame is forwarded to the window as `room://msg` and every
/// outbound string from `rx` goes to the server. Ends with a `bye` unless
/// the local side closed it deliberately — including the host's own `bye`,
/// which is shown only after this task has reverted the mode (D5).
///
/// Drop the half-open `Mode::Guest` that a failed dial (D2) or a session the
/// host ended (D5) left behind.
///
/// `room_join` writes the mode *before* connecting, so every early return below
/// used to leave the backend convinced it was in a room the UI had already
/// given up on — and `room_join` refuses a second attempt while the mode is not
/// `Idle` ("Leave the current room before joining another.").
///
/// The task owns a clone of its own sender, so `same_channel` makes this both
/// idempotent and safe against a race: a task that timed out seconds ago can
/// never blank a room opened since.
async fn revert_failed_guest(app: &AppHandle, own_tx: &mpsc::UnboundedSender<String>) {
    if let Some(state) = app.try_state::<RoomState>() {
        let mut mode = state.inner.lock().await;
        let same = matches!(&*mode, Mode::Guest { tx } if tx.same_channel(own_tx));
        if same {
            *mode = Mode::Idle;
        }
    }
}

async fn guest_run(
    app: AppHandle,
    url: String,
    join_frame: String,
    mut rx: mpsc::UnboundedReceiver<String>,
    own_tx: mpsc::UnboundedSender<String>,
) {
    // Cloned so the failure exits below can still reach the managed state. The
    // revert runs *before* the `error` frame, so the state the next `room_join`
    // sees and the frame the UI reacts to always agree (D2).
    let out = Sink::App(app.clone());
    let connected = tokio::time::timeout(Duration::from_secs(8), connect(&url)).await;
    let mut ws = match connected {
        Err(_) => {
            revert_failed_guest(&app, &own_tx).await;
            out.send(&err_frame(
                "connect_failed",
                format!("Could not reach {url} — timed out."),
            ));
            return;
        }
        Ok(Err(e)) => {
            revert_failed_guest(&app, &own_tx).await;
            out.send(&err_frame(
                "connect_failed",
                format!("Could not reach {url}: {e}"),
            ));
            return;
        }
        Ok(Ok(ws)) => ws,
    };

    if ws
        .send(ClientMessage::Text(join_frame.into()))
        .await
        .is_err()
    {
        revert_failed_guest(&app, &own_tx).await;
        out.send(&err_frame(
            "connect_failed",
            format!("Could not reach {url}."),
        ));
        return;
    }

    let end = guest_pump(&mut ws, &mut rx, &out).await;
    // Backend state settles before the window sees any bye (D2/D5 ordering):
    // on `LocalClosed` `room_close` already replaced the mode with `Idle`, so
    // this is a guarded no-op; on the other two arms it is what frees this
    // guest to join another room instead of being refused forever.
    revert_failed_guest(&app, &own_tx).await;
    match end {
        PumpEnd::LocalClosed => {}
        PumpEnd::ServerBye(frame) => out.send(&frame),
        PumpEnd::Lost => {
            // Server went away, or it closed us after an error frame — the UI
            // keeps the specific error (if any) and shows this only as fallback.
            out.send(&json!({
                "t": "bye",
                "reason": "Connection to the room was lost."
            }));
        }
    }
}

/// Why `guest_pump` returned.
#[derive(Debug, PartialEq)]
enum PumpEnd {
    /// The local side asked to leave (`room_close` dropped `rx`).
    LocalClosed,
    /// The socket died: EOF, error, or a close frame from the server.
    Lost,
    /// The server said `bye` (host closed the room). The frame is handed
    /// back for the caller to deliver *after* the mode has reverted —
    /// backend state and the frame the UI reacts to must agree (D2/D5).
    ServerBye(Value),
}

/// Drive one connected guest socket: strings from `rx` go to the server,
/// inbound text frames go to the window, until the local side leaves or the
/// socket dies. Split out of `guest_run` so the end conditions are unit
/// testable (`guest_pump_*` tests at the bottom of this file).
async fn guest_pump<S>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
    rx: &mut mpsc::UnboundedReceiver<String>,
    out: &Sink,
) -> PumpEnd
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut local_close = false;
    let mut server_bye: Option<Value> = None;
    loop {
        tokio::select! {
            item = rx.recv() => match item {
                Some(text) => {
                    if ws.send(ClientMessage::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                None => {
                    local_close = true;
                    let _ = ws.close(None).await;
                    break;
                }
            },
            incoming = ws.next() => match incoming {
                Some(Ok(ClientMessage::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(t.as_ref()) {
                        if v.get("t").and_then(Value::as_str) == Some("bye") {
                            // D5: the host said goodbye. After `room_close` the
                            // server only drains (axum graceful shutdown) and
                            // never closes the socket itself — waiting for EOF
                            // would hang this pump forever with the backend
                            // still `Mode::Guest`. Close our end and let the
                            // caller settle state before the frame is shown.
                            let _ = ws.close(None).await;
                            server_bye = Some(v);
                            break;
                        }
                        out.send(&v);
                    }
                }
                Some(Ok(ClientMessage::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
    if let Some(v) = server_bye {
        PumpEnd::ServerBye(v)
    } else if local_close {
        PumpEnd::LocalClosed
    } else {
        PumpEnd::Lost
    }
}

async fn connect(
    url: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    tokio_tungstenite::connect_async(url)
        .await
        .map(|(ws, _)| ws)
        .map_err(|e| e.to_string())
}

// -------------------------------------------------------------------- state -

enum Mode {
    Idle,
    Host {
        core: SharedCore,
        shutdown: Option<oneshot::Sender<()>>,
        port: u16,
        code: String,
    },
    Guest {
        tx: mpsc::UnboundedSender<String>,
    },
}

pub struct RoomState {
    inner: tokio::sync::Mutex<Mode>,
}

impl RoomState {
    pub fn new() -> Self {
        RoomState {
            inner: tokio::sync::Mutex::new(Mode::Idle),
        }
    }
}

impl Default for RoomState {
    fn default() -> Self {
        Self::new()
    }
}

// ----------------------------------------------------------------- commands -

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub port: u16,
    pub code: String,
    pub urls: Vec<String>,
    pub members: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub role: &'static str,
    pub port: u16,
    pub code: String,
    /// Same `ws://` invite list `room_open` returns. Empty unless hosting, so a
    /// re-attached window can re-offer the address it is already serving on.
    pub urls: Vec<String>,
}

/// Open a LAN room: bind `0.0.0.0:<port>` (default 8787, ephemeral
/// fallback), mint a code, start serving. The socket exists only until
/// `room_close` — this is never called at startup.
#[tauri::command]
pub async fn room_open(
    app: AppHandle,
    state: TauriState<'_, RoomState>,
    port: Option<u16>,
    name: Option<String>,
) -> Result<OpenInfo, String> {
    let mut mode = state.inner.lock().await;
    if !matches!(*mode, Mode::Idle) {
        return Err("A room is already open on this device. Leave it first.".into());
    }
    let want = port.filter(|&p| p > 0).unwrap_or(DEFAULT_PORT);
    let listener = StdTcpListener::bind(("0.0.0.0", want))
        .or_else(|_| StdTcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("Could not open a room port: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("Could not read the room port: {e}"))?
        .port();

    let code = gen_code();
    let core: SharedCore = Arc::new(Mutex::new(RoomCore::new(
        &code,
        name.as_deref().unwrap_or("Host"),
        Sink::App(app),
    )));

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let serve_core = core.clone();
    tauri::async_runtime::spawn(async move {
        let _ = serve(listener, serve_core, async {
            let _ = shutdown_rx.await;
        })
        .await;
    });

    *mode = Mode::Host {
        core,
        shutdown: Some(shutdown_tx),
        port: bound,
        code: code.clone(),
    };
    Ok(OpenInfo {
        port: bound,
        code,
        urls: lan_urls(bound),
        members: 1,
    })
}

/// Connect to another device's room. The join result itself arrives as
/// frames (`joined` or `error`) — this only proves the address is dialable.
#[tauri::command]
pub async fn room_join(
    app: AppHandle,
    state: TauriState<'_, RoomState>,
    addr: String,
    code: String,
    name: Option<String>,
) -> Result<(), String> {
    let mut mode = state.inner.lock().await;
    if !matches!(*mode, Mode::Idle) {
        return Err("Leave the current room before joining another.".into());
    }
    let (host, port) = parse_room_addr(&addr)?;
    let url = format!("ws://{host}:{port}/ws");
    let join_frame = json!({
        "t": "join",
        "v": 1,
        "code": code.trim().to_uppercase(),
        "name": sanitize_name(name.as_deref().unwrap_or("Guest")),
    })
    .to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    // The task keeps its own sender so a failed dial can identify *its* mode
    // before reverting it (D2).
    let own_tx = tx.clone();
    *mode = Mode::Guest { tx };
    tokio::spawn(guest_run(app, url, join_frame, rx, own_tx));
    Ok(())
}

/// Host: broadcast authoritative playback state. Guest/idle: refused —
/// the server would reject it too (`not_host`).
#[tauri::command]
pub async fn room_playback(
    state: TauriState<'_, RoomState>,
    playing: bool,
    track_id: String,
    title: String,
    artist: String,
    position_ms: u64,
) -> Result<(), String> {
    let mode = state.inner.lock().await;
    match &*mode {
        Mode::Host { core, .. } => {
            let mut guard = core
                .lock()
                .map_err(|_| "Room state poisoned.".to_string())?;
            guard.playback(playing, &track_id, &title, &artist, position_ms);
            Ok(())
        }
        Mode::Guest { .. } => Err("Only the host can control playback.".into()),
        Mode::Idle => Err("Not in a room.".into()),
    }
}

/// Send a chat line. Host: relayed by the in-process core (the window gets
/// its own echo back, exactly like a guest). Guest: forwarded to the server.
#[tauri::command]
pub async fn room_chat(state: TauriState<'_, RoomState>, text: String) -> Result<(), String> {
    let mode = state.inner.lock().await;
    match &*mode {
        Mode::Host { core, .. } => {
            let mut guard = core
                .lock()
                .map_err(|_| "Room state poisoned.".to_string())?;
            guard.chat("host", &text).map_err(|(_, m)| m)
        }
        Mode::Guest { tx, .. } => {
            let frame = json!({ "t": "chat", "text": text }).to_string();
            tx.send(frame)
                .map_err(|_| "The room connection is closed.".to_string())
        }
        Mode::Idle => Err("Not in a room — messages stay on this device.".into()),
    }
}

/// A guest reports its measured drift; the host's sync tile shows the
/// worst one (docs/listen-together.md §4).
#[tauri::command]
pub async fn room_report(state: TauriState<'_, RoomState>, drift_ms: i64) -> Result<(), String> {
    let mode = state.inner.lock().await;
    match &*mode {
        Mode::Host { .. } => Ok(()), // the host has no drift to report
        Mode::Guest { tx, .. } => {
            let frame = json!({ "t": "report", "driftMs": drift_ms }).to_string();
            tx.send(frame)
                .map_err(|_| "The room connection is closed.".to_string())
        }
        Mode::Idle => Err("Not in a room.".into()),
    }
}

/// Close whatever this device is doing: host → bye to everyone + stop the
/// listener; guest → leave the server and emit a local `bye{left}` so the
/// UI resets through the same frame path it uses for remote closes.
#[tauri::command]
pub async fn room_close(app: AppHandle, state: TauriState<'_, RoomState>) -> Result<(), String> {
    let mut mode = state.inner.lock().await;
    match std::mem::replace(&mut *mode, Mode::Idle) {
        Mode::Idle => Ok(()),
        Mode::Host { core, shutdown, .. } => {
            if let Ok(mut g) = core.lock() {
                g.close("The host closed the room.");
            }
            if let Some(tx) = shutdown {
                let _ = tx.send(());
            }
            Ok(())
        }
        Mode::Guest { tx, .. } => {
            let _ = tx.send(json!({ "t": "leave" }).to_string());
            drop(tx);
            let _ = app.emit("room://msg", &json!({ "t": "bye", "reason": "left" }));
            Ok(())
        }
    }
}

/// Snapshot for page (re)load: a reload while a room exists would leave a
/// server with no live window behind it, so `initSocial` calls this and
/// closes anything stale before starting fresh.
#[tauri::command]
pub async fn room_info(state: TauriState<'_, RoomState>) -> Result<RoomInfo, String> {
    let mode = state.inner.lock().await;
    Ok(match &*mode {
        Mode::Idle => RoomInfo {
            role: "idle",
            port: 0,
            code: String::new(),
            urls: Vec::new(),
        },
        Mode::Host { port, code, .. } => RoomInfo {
            role: "host",
            port: *port,
            code: code.clone(),
            urls: lan_urls(*port),
        },
        Mode::Guest { .. } => RoomInfo {
            role: "guest",
            port: 0,
            code: String::new(),
            urls: Vec::new(),
        },
    })
}

// -------------------------------------------------------------------- tests -

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::WebSocketStream;

    type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    struct Harn {
        core: SharedCore,
        port: u16,
        host_rx: mpsc::UnboundedReceiver<String>,
        // Dropping Harn drops this sender → the serve task shuts down.
        _shutdown: oneshot::Sender<()>,
    }

    async fn start(code: &str) -> Harn {
        let (host_tx, host_rx) = mpsc::unbounded_channel();
        let core: SharedCore =
            Arc::new(Mutex::new(RoomCore::new(code, "Host", Sink::Chan(host_tx))));
        let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let serve_core = core.clone();
        tokio::spawn(async move {
            let _ = serve(listener, serve_core, async {
                let _ = shutdown_rx.await;
            })
            .await;
        });
        Harn {
            core,
            port,
            host_rx,
            _shutdown: shutdown_tx,
        }
    }

    async fn dial(port: u16) -> Client {
        let url = format!("ws://127.0.0.1:{port}/ws");
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        ws
    }

    async fn send(ws: &mut Client, v: &Value) {
        ws.send(ClientMessage::Text(v.to_string().into()))
            .await
            .unwrap();
    }

    async fn recv(ws: &mut Client) -> Value {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("timed out waiting for a frame")
            .expect("socket closed waiting for a frame")
            .expect("socket error waiting for a frame");
        match msg {
            ClientMessage::Text(t) => serde_json::from_str(t.as_ref()).expect("frame is not JSON"),
            other => panic!("expected text frame, got {other:?}"),
        }
    }

    async fn recv_t(ws: &mut Client, t: &str) -> Value {
        for _ in 0..16 {
            let v = recv(ws).await;
            if v.get("t").and_then(Value::as_str) == Some(t) {
                return v;
            }
        }
        panic!("frame type {t} never arrived");
    }

    async fn host_recv(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let s = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("host sink timed out")
            .expect("host sink closed");
        serde_json::from_str(&s).expect("host frame is not JSON")
    }

    async fn host_recv_t(rx: &mut mpsc::UnboundedReceiver<String>, t: &str) -> Value {
        for _ in 0..16 {
            let v = host_recv(rx).await;
            if v.get("t").and_then(Value::as_str) == Some(t) {
                return v;
            }
        }
        panic!("host frame type {t} never arrived");
    }

    fn join_frame(code: &str, name: &str) -> Value {
        json!({ "t": "join", "v": 1, "code": code, "name": name })
    }

    /// Build both halves of an in-memory guest socket pair: the pump runs on
    /// the client end, the test plays the server on the other one. Returns
    /// `(client ws, server ws, guest tx, guest rx, sink tx, sink rx)`.
    async fn duplex_pump() -> (
        tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
        tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedReceiver<String>,
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedReceiver<String>,
    ) {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let ws = WebSocketStream::from_raw_socket(
            client_io,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        let server = WebSocketStream::from_raw_socket(
            server_io,
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let (sink_tx, sink_rx) = mpsc::unbounded_channel::<String>();
        (ws, server, tx, rx, sink_tx, sink_rx)
    }

    /// D5: the host's `bye` must end the pump even though axum's graceful
    /// drain never closes the socket. Before the fix this timed out — the
    /// pump forwarded the bye to the window and waited forever with the
    /// backend mode still `Mode::Guest`, so the next join was refused
    /// "Leave the current room before joining another."
    #[tokio::test]
    async fn guest_pump_ends_promptly_on_server_bye() {
        let (mut ws, mut server, _tx, mut rx, sink_tx, mut sink_rx) = duplex_pump().await;
        let out = Sink::Chan(sink_tx);

        // An ordinary frame first — it must still reach the window.
        server
            .send(ClientMessage::Text(
                json!({ "t": "presence", "members": 1 }).to_string().into(),
            ))
            .await
            .unwrap();
        // The host's goodbye — and then the server just waits: after
        // `room_close` it drains, it never closes the socket itself.
        server
            .send(ClientMessage::Text(
                json!({ "t": "bye", "reason": "The host closed the room." })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();

        let end = tokio::time::timeout(Duration::from_secs(2), guest_pump(&mut ws, &mut rx, &out))
            .await
            .expect("pump must end when the server says bye, drain or not");

        let first = sink_rx.try_recv().expect("presence must be forwarded");
        let first: Value = serde_json::from_str(&first).expect("sink frame is JSON");
        assert_eq!(first["t"], "presence");
        // The bye is *returned* for the caller to deliver after the mode has
        // reverted (D2/D5 ordering) — the pump never sends a bye itself, so
        // the window can never see two toasts for one close.
        assert!(
            sink_rx.try_recv().is_err(),
            "pump must not emit its own bye"
        );
        match end {
            PumpEnd::ServerBye(v) => assert_eq!(v["reason"], "The host closed the room."),
            other => panic!("expected ServerBye, got {other:?}"),
        }
    }

    /// `room_close` drops its sender: the pump must report a deliberate
    /// local close so the caller emits nothing (the command already sent
    /// `bye{left}` and set `Idle`).
    #[tokio::test]
    async fn guest_pump_reports_local_close() {
        let (mut ws, _server, tx, mut rx, sink_tx, _sink_rx) = duplex_pump().await;
        let out = Sink::Chan(sink_tx);
        drop(tx);
        let end = tokio::time::timeout(Duration::from_secs(2), guest_pump(&mut ws, &mut rx, &out))
            .await
            .expect("pump must end when rx closes");
        assert_eq!(end, PumpEnd::LocalClosed);
    }

    /// The network disappearing (EOF/error, no bye frame) is `Lost` — the
    /// caller reverts the mode and sends the fallback bye.
    #[tokio::test]
    async fn guest_pump_reports_lost_socket() {
        let (mut ws, server, _tx, mut rx, sink_tx, _sink_rx) = duplex_pump().await;
        let out = Sink::Chan(sink_tx);
        drop(server);
        let end = tokio::time::timeout(Duration::from_secs(2), guest_pump(&mut ws, &mut rx, &out))
            .await
            .expect("pump must end when the socket dies");
        assert_eq!(end, PumpEnd::Lost);
    }

    #[test]
    fn code_is_eight_unconfusable_symbols() {
        for _ in 0..64 {
            let code = gen_code();
            assert_eq!(code.len(), 8);
            assert!(code.chars().all(|c| CODE_ALPHABET.contains(&(c as u8))));
        }
    }

    #[test]
    fn addr_parsing_accepts_lan_and_refuses_public() {
        assert_eq!(
            parse_room_addr("192.168.1.5").unwrap(),
            ("192.168.1.5".into(), DEFAULT_PORT)
        );
        assert_eq!(
            parse_room_addr("10.0.0.2:9000").unwrap(),
            ("10.0.0.2".into(), 9000)
        );
        assert_eq!(
            parse_room_addr("ws://172.16.0.9:1234/").unwrap(),
            ("172.16.0.9".into(), 1234)
        );
        assert_eq!(
            parse_room_addr("127.0.0.1").unwrap(),
            ("127.0.0.1".into(), DEFAULT_PORT)
        );
        assert_eq!(
            parse_room_addr("localhost").unwrap(),
            ("localhost".into(), DEFAULT_PORT)
        );
        // Public IPs, hostnames and junk are refused with a usable message.
        assert!(parse_room_addr("8.8.8.8").is_err());
        assert!(parse_room_addr("example.com").is_err());
        assert!(parse_room_addr("").is_err());
        assert!(parse_room_addr("wss://192.168.1.5").is_err());
    }

    #[test]
    fn names_are_sanitised() {
        assert_eq!(sanitize_name("  Ann  "), "Ann");
        assert_eq!(sanitize_name(""), "Guest");
        assert_eq!(sanitize_name("\u{7}evil"), "evil");
        assert_eq!(sanitize_name(&"x".repeat(80)).len(), 24);
    }

    #[tokio::test]
    async fn wrong_code_is_refused_verbatim() {
        let h = start("RIGHT1").await;
        let mut ws = dial(h.port).await;
        send(&mut ws, &join_frame("WRONG9", "Mallory")).await;
        let err = recv_t(&mut ws, "error").await;
        assert_eq!(err["code"], "bad_code");
        assert!(err["message"].as_str().unwrap().contains("Wrong room code"));
    }

    #[tokio::test]
    async fn two_guests_presence_chat_and_rate_limit() {
        let mut h = start("ROOMAA").await;

        let mut a = dial(h.port).await;
        send(&mut a, &join_frame("roomaa", "Ann")).await; // case-insensitive code
        let joined = recv_t(&mut a, "joined").await;
        assert_eq!(joined["code"], "ROOMAA");
        assert_eq!(joined["youAreHost"], false);
        let _ = recv_t(&mut a, "history").await;
        let presence = recv_t(&mut a, "presence").await;
        assert_eq!(presence["members"].as_array().unwrap().len(), 2); // host + Ann
                                                                      // The host window is asked for a fresh playback state after a join.
        let refresh = host_recv_t(&mut h.host_rx, "refresh").await;
        assert_eq!(refresh["t"], "refresh");

        let mut b = dial(h.port).await;
        send(&mut b, &join_frame("ROOMAA", "Bob")).await;
        let _ = recv_t(&mut b, "joined").await;
        let _ = recv_t(&mut b, "history").await;
        let presence_b = recv_t(&mut b, "presence").await;
        assert_eq!(presence_b["members"].as_array().unwrap().len(), 3);
        let presence_a = recv_t(&mut a, "presence").await;
        assert_eq!(presence_a["members"].as_array().unwrap().len(), 3);

        // Chat relays to both guests AND the host window (single render path).
        send(&mut a, &json!({ "t": "chat", "text": "hello" })).await;
        let chat_a = recv_t(&mut a, "chat").await;
        let chat_b = recv_t(&mut b, "chat").await;
        let chat_h = host_recv_t(&mut h.host_rx, "chat").await;
        for chat in [chat_a, chat_b, chat_h] {
            assert_eq!(chat["from"]["name"], "Ann");
            assert_eq!(chat["text"], "hello");
        }

        // Rate limit: Bob gets 5 through inside the window, the 6th verbatim.
        for i in 0..5 {
            send(&mut b, &json!({ "t": "chat", "text": format!("m{i}") })).await;
            let _ = recv_t(&mut b, "chat").await;
        }
        send(&mut b, &json!({ "t": "chat", "text": "m6" })).await;
        let err = recv_t(&mut b, "error").await;
        assert_eq!(err["code"], "rate_limited");
        assert!(err["message"].as_str().unwrap().contains("5 messages"));

        drop(a);
        let presence = recv_t(&mut b, "presence").await;
        assert_eq!(presence["members"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn playback_is_host_only_and_cached_for_late_joiners() {
        let mut h = start("PB0001").await;
        let mut a = dial(h.port).await;
        send(&mut a, &join_frame("PB0001", "Ann")).await;
        let _ = recv_t(&mut a, "joined").await;

        // A guest trying to drive playback is refused, verbatim.
        send(
            &mut a,
            &json!({ "t": "playback", "playing": true, "trackId": "x", "positionMs": 0 }),
        )
        .await;
        let err = recv_t(&mut a, "error").await;
        assert_eq!(err["code"], "not_host");

        // The host's state (from the room_playback command path) relays to
        // everyone, stamped with server time.
        {
            let mut g = h.core.lock().unwrap();
            g.playback(true, "song1", "Title", "Artist", 42_000);
        }
        let pb_a = recv_t(&mut a, "playback").await;
        assert_eq!(pb_a["trackId"], "song1");
        assert_eq!(pb_a["positionMs"], 42_000);
        assert!(pb_a["at"].as_u64().unwrap() > 0);
        let _ = host_recv_t(&mut h.host_rx, "playback").await;

        // A late joiner gets the cached state inside its welcome.
        let mut c = dial(h.port).await;
        send(&mut c, &join_frame("PB0001", "Cara")).await;
        let _ = recv_t(&mut c, "joined").await;
        let _ = recv_t(&mut c, "history").await;
        let pb_c = recv_t(&mut c, "playback").await;
        assert_eq!(pb_c["trackId"], "song1");
    }

    #[tokio::test]
    async fn drift_report_paints_presence_for_the_host_tile() {
        let mut h = start("DRFT01").await;
        let mut a = dial(h.port).await;
        send(&mut a, &join_frame("DRFT01", "Ann")).await;
        let _ = recv_t(&mut a, "joined").await;
        let _ = recv_t(&mut a, "history").await;
        // The join itself broadcasts presence — *before* any drift exists, so
        // Ann must not carry a driftMs yet (a fabricated 0 would read as
        // "perfectly in sync" in the host's tile, docs/listen-together.md §8).
        // Drain that frame; the report's presence is the next one.
        let join_presence = recv_t(&mut a, "presence").await;
        let ann_join = join_presence["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "Ann")
            .expect("Ann is in the join-time presence");
        assert_eq!(
            ann_join["driftMs"],
            Value::Null,
            "no report yet → no number"
        );
        let _ = host_recv_t(&mut h.host_rx, "presence").await; // same broadcast

        send(&mut a, &json!({ "t": "report", "driftMs": 420 })).await;
        let presence = recv_t(&mut a, "presence").await;
        let members = presence["members"].as_array().unwrap();
        let ann = members.iter().find(|m| m["name"] == "Ann").unwrap();
        assert_eq!(ann["driftMs"], 420);
        // The host window sees the same numbers (its sync tile).
        let host_presence = host_recv_t(&mut h.host_rx, "presence").await;
        assert!(host_presence["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["driftMs"] == 420));
    }

    #[tokio::test]
    async fn ninth_guest_is_refused() {
        let h = start("FULL01").await;
        let mut sockets = Vec::new();
        for i in 0..MAX_GUESTS {
            let mut ws = dial(h.port).await;
            send(&mut ws, &join_frame("FULL01", &format!("G{i}"))).await;
            let _ = recv_t(&mut ws, "joined").await;
            sockets.push(ws);
        }
        let mut late = dial(h.port).await;
        send(&mut late, &join_frame("FULL01", "Late")).await;
        let err = recv_t(&mut late, "error").await;
        assert_eq!(err["code"], "room_full");
        drop(sockets);
    }

    #[tokio::test]
    async fn close_says_why_and_stops_accepting() {
        let mut h = start("BYE001").await;
        let mut a = dial(h.port).await;
        send(&mut a, &join_frame("BYE001", "Ann")).await;
        let _ = recv_t(&mut a, "joined").await;

        h.core.lock().unwrap().close("The host closed the room.");
        let bye = recv_t(&mut a, "bye").await;
        assert_eq!(bye["reason"], "The host closed the room.");
        let _ = host_recv_t(&mut h.host_rx, "bye").await;
    }

    #[tokio::test]
    async fn history_replays_to_late_joiners_and_caps() {
        let h = start("HIST01").await;
        let mut a = dial(h.port).await;
        send(&mut a, &join_frame("HIST01", "Ann")).await;
        let _ = recv_t(&mut a, "joined").await;

        // HISTORY_CAP + 10 messages with the rate window cleared between
        // sends (the cap is what is under test, not the limiter).
        for i in 0..(HISTORY_CAP + 10) {
            let mut g = h.core.lock().unwrap();
            g.chat_stamps.clear();
            g.chat("host", &format!("msg{i}")).unwrap();
        }
        let mut b = dial(h.port).await;
        send(&mut b, &join_frame("HIST01", "Bob")).await;
        let _ = recv_t(&mut b, "joined").await;
        let history = recv_t(&mut b, "history").await;
        let msgs = history["msgs"].as_array().unwrap();
        assert_eq!(msgs.len(), HISTORY_CAP);
        assert_eq!(msgs[0]["text"], "msg10"); // oldest ten were dropped
        assert_eq!(
            msgs.last().unwrap()["text"],
            format!("msg{}", HISTORY_CAP + 9)
        );
    }
}
