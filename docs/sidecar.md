# Local sidecar bridge — metroserver / Listen Together

Status: **Phase 4a implemented (connect + handshake + host attempt)**; join,
presence and playback sync are Phase 4b/5. Research source: the published
[metroserver](https://github.com/MetrolistGroup/metroserver) and
[metroproto](https://github.com/metrolistgroup/metroproto) repositories
(`metroproto @ e7c5e3d` submodule), read 2026-10-05.

> **2026-10-06 — demoted to a dormant interop path.** The default transport
> for real two-device rooms is now the **in-app Rust room server**
> (`app/src-tauri/src/room.rs`, spec in `docs/listen-together.md`), because
> (a) metroserver's dispatcher answers `unknown_message_type` to any frame it
> doesn't know — chat is impossible without patching that GPL Go server —
> (b) it ships no prebuilt binaries, so hosting needs Go or Docker, and
> (c) hosting is UA-allowlisted, which refuses our WebView UA by default.
> The code and tests below still work against a user-run metroserver and are
> kept as-is; nothing new is built on them in the meantime.

## 1. What this is

`metroserver` is a Go WebSocket server for Metrolist's "Listen Together"
feature: protobuf messages over binary WebSocket frames, optional gzip. The
desktop app can speak its protocol directly over `127.0.0.1` — no relay, no
cloud, no bundled binary.

## 2. Licensing and PRD stance (decisions, not open questions)

| Question | Decision |
|---|---|
| Is the sidecar bundled with the app? | **No.** `docs/PRD.md` keeps its hard constraint: shipped runtime is HTML/CSS/JS/Rust only. The user runs metroserver themselves (or not at all). |
| Does GPL-3.0 contaminate this MIT app? | **No** — no Go source, no compiled binary and no derived code is copied into this repo. The app is an independent client speaking a network protocol, which is not a derivative work. |
| What if the user never runs it? | The app says `Not connected`. Every social feature that needs a peer degrades to its local-only behavior (see `docs/social-nowplaying.md` §3a/§6). |
| Where does it listen? | `127.0.0.1` only. (This bridge never opens a non-loopback address. The *room server* of `docs/listen-together.md` is a different component — it binds the LAN, opt-in while a room is open.) |

The PRD's shipped-languages row was amended to record this carve-out
("may *talk to* a user-installed localhost service; never bundles, spawns or
vendors it").

## 3. Running it yourself

```
git clone https://github.com/MetrolistGroup/metroserver
cd metroserver
./scripts/generate_proto.sh     # first time only (needs protoc + protoc-gen-go)
go mod download
go build -o metroserver ./cmd/metroserver
./metroserver                   # default port 8080, or PORT=9000 ./metroserver
```

Health check: `GET http://127.0.0.1:8080/health` → `{"status":"ok"}`.
That is exactly the URL the app probes.

## 4. Wire protocol (as published)

### 4.1 Routes

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | `{"status":"ok"}` — the app's liveness probe |
| `/ws` | WebSocket upgrade | the entire protocol |
| `/uas` | GET | optional admin endpoint, only when `UA_ADMIN_TOKEN` is set (not used by this app) |

### 4.2 Framing

Every frame is **binary** and holds one protobuf `Envelope`:

```proto
message Envelope {
  string type    = 1;   // e.g. "create_room"
  bytes  payload = 2;   // protobuf-encoded message for that type
  bool   compressed = 3; // payload is gzip-compressed
}
```

Compression is only applied by the server when it was negotiated **and** the
payload is >100 bytes (`codec.go`). A client that sends
`supports_compression: false` never has to decompress.

### 4.3 Handshake

```
client → server   client_capabilities { supports_protobuf: true,
                                        supports_compression: false,
                                        client_version }
server → client   server_capabilities { supports_protobuf: true,
                                        supports_compression: true,
                                        server_version: "1" }
```

Rules read off the server (`server.go`):

- `supports_protobuf: false` → `error { code: "unsupported_client" }`.
- Capabilities **must** arrive before any room message
  (`capabilities_too_late` otherwise), and only once
  (`capabilities_already_set`).
- Keepalive: `ping { client_time, sequence }` → `pong`.

### 4.4 Messages this app uses (Phase 4a)

| Direction | `type` | Payload |
|---|---|---|
| C→S | `client_capabilities` | `ClientCapabilities` |
| C→S | `create_room` | `CreateRoomPayload { username }` |
| C→S | `leave_room` | `LeaveRoomPayload {}` |
| C→S | `ping` | `PingPayload { client_time, sequence }` |
| S→C | `server_capabilities` | `ServerCapabilities` |
| S→C | `room_created` | `RoomCreatedPayload { room_code, user_id, session_token }` |
| S→C | `error` | `ErrorPayload { code, message }` |
| S→C | `pong` | `PongPayload` |

Room codes are 8 chars from `1234567890QWERTYUPASDFGHJLKZXCVBNM`.

Phase 4b (join/presence): `join_room`, `approve_join`, `reject_join`,
`join_request`, `join_approved`, `join_rejected`, `user_joined`, `user_left`,
`host_changed`, `sync_state`. Phase 5 (playback): `playback_action` with
`play/pause/seek/skip_next/change_track/queue_add/…`.

### 4.5 The hosting gate — read this before wondering why `create_room` fails

The server classifies every connection by `User-Agent` (`uapolicy.go`):

| Tier | Effect |
|---|---|
| `allow` | normal service, **may host rooms** |
| `advert` | usable, but the queue title is rewritten to a Metrolist ad |
| `rickroll` | advert, plus every track rewritten to Rick Astley |
| `block` | one `error { blocked_client }` frame, then hang up |

Default allow-list: UA substrings `okhttp`, `ktor-client`, plus exact matches
`com.metrolist.music`, `com.metrolist.music.debug`, `com.nevar.nzik`,
`com.nevar.nzik.debug`. Anything else is `advert`.

`canHostClient()` requires `uaAllow`, so **on a default-policy server this
app cannot host**: `create_room` answers
`error { code: "host_not_allowed", message: "Only allowlisted clients can host rooms" }`.
Joining is *not* gated.

That is the operator's call to make, not something the app works around —
spoofing another app's User-Agent would be dishonest. To let this app host,
extend the policy the server already ships for exactly this purpose:

```json
{ "allow": ["<substring of your desktop WebView's userAgent>"] }
```

The Jam pane prints this app's actual `navigator.userAgent` so the substring
can be copied verbatim. The app surfaces the server's `error` text unchanged
rather than translating it into a friendlier lie.

## 5. What the app does (Phase 4a)

Files: `app/src/metroproto.js` (wire format), `app/src/sidecar.js`
(connection state machine), UI glue in `app/src/social.js`.

```
body gets .soc-social
  → sidecar.probe()      GET /health  (1.5 s timeout)   → "Not connected" | …
  → if healthy: open ws://127.0.0.1:<port>/ws
  → client_capabilities (supports_compression: false → we never handle gzip)
  → server_capabilities                           → status "Connected"
  → user clicks "Open room" → create_room
       room_filled → status shows the real code everywhere
       error       → status shows the server's code + message verbatim
leaving Social / closing the QR → leave_room (if any) + socket.close()
```

| UI slot | Source |
|---|---|
| `#jam-sidecar` | `Not connected` / `Connected` / `Error: <code>` |
| `#jam-sidecar-note` | last server message, or the run-it-yourself hint |
| `#jam-ua` | this client's `navigator.userAgent` (for the policy file) |
| `#soc-room-chip` (`#soc-room-code`), `#qr-room-code`, `#jam-room-id` | real `room_code` once `room_created` arrives, else `NO ROOM` (the old preview code and PIN were dropped: the protocol has neither) |
| `#btn-open-room` | enabled only while connected |
| `#btn-copy-invite`, `#btn-qr-copy` | enabled only once a real room code exists |

Configuration: port comes from `localStorage["tm-sidecar-port"]` (default
`8080`). No settings UI yet.

CSP: `connect-src` gained `ws://127.0.0.1:*` in `tauri.conf.json` (the
`http://127.0.0.1:*` entry already covered `/health`).

## 6. What deliberately stays local

metroproto has **no** messages for chat, emoji reactions or skip votes. Those
stay client-local (see `docs/social-nowplaying.md` §3a) until a protocol for
them exists — the app will not pretend a peer saw them.

## 7. Verification status — be precise about this

| Claim | Evidence |
|---|---|
| Routes, framing, handshake, message field numbers, UA tiers | read directly from the published Go/`.proto` sources, cited above |
| `metroproto.js` byte format | `app/tests/metroproto.test.mjs`: hand-derived golden bytes + round trips |
| Connection state machine | `app/tests/sidecar.test.mjs` against a scripted fake socket (probe, handshake, refusal, `room_created`, `host_not_allowed`, leave, garbage frame, keepalive) |
| **End-to-end against a live metroserver** | **NOT DONE** — this machine has no Go toolchain (`go` not found, 2026-10-05) and no Docker, so the server cannot be run here. The app therefore never reports success it did not observe: `Connected` is only shown after a decoded `server_capabilities` frame, and `room_created` is the only source of a room code. |

Remaining unknowns, in order of likely pain: whether the Tauri WebView
treats `ws://127.0.0.1` as allowed mixed content (it is not mixed on
`http://tauri.localhost`, but this is untested), and gzip handling (avoided
by never negotiating compression).

## 8. Next phases

- **4b** — join a room by code, host approval flow, member list from
  `RoomState.users`, `user_joined`/`user_left` presence.
- **5** — playback sync (`playback_action`, drift correction against
  `Pong` round-trip), queue merge, suggestions.
- Protocol gaps to design ourselves: chat, reactions, skip votes.
