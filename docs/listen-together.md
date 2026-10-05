# Listen Together — two-device rooms (the receiver side)

Status: **Milestone 1 in progress** (Windows ↔ Windows). Milestone 2 is the
two-PC field test; milestone 3 brings the repo's mobile shell in as a receiver.

This is the doc that specifies the part `docs/sidecar.md` deliberately did not
build: the **guest/join role**, **playback synchronization** ("listen to the
same song at the same second") and **live chat** — across two real machines.

## 1. Why not the metroserver we already speak? (research, 2026-10-06)

Phase 4a built the *host* half of the metroserver protocol. Three findings
killed it as the default transport for this goal:

| Finding | Evidence |
|---|---|
| **Chat is impossible without patching it.** `handleMessage` ends in `default: c.sendError(..., "unknown_message_type", ...)` — unknown envelope types are refused, not relayed. | `metroserver/internal/server/server.go` |
| **No prebuilt binaries.** "There aren't any releases here" → whoever hosts must install **Go or Docker**. | GitHub releases page |
| **Hosting is UA-allowlisted** (`canHostClient` → `uaAllow`); our WebView UA isn't, so `create_room` is refused unless the operator edits `ua_policy.json`. | `uapolicy.go` (see `docs/sidecar.md` §4.5) |

**Decision:** the room server ships **inside this app, written in Rust**
(`app/src-tauri/src/room.rs`). Rust is already in the shipped-runtime list in
`docs/PRD.md`, so no PRD language violation; `metroproto.js`/`sidecar.js`
stay committed and tested as a dormant metroserver interop path.

## 2. Topology (Windows ↔ Windows)

```
PC A (host)                                PC B (guest)
┌───────────────────────────┐              ┌───────────────────────────┐
│ TRANCE MUSIC              │   Wi‑Fi/LAN  │ TRANCE MUSIC              │
│  ├─ room server 0.0.0.0:8787 ◄───────────►  └─ room client ──────────┘
│  ├─ host client (in‑proc) │   WS + JSON  │    joins with addr + code │
│  └─ audio = authoritative │              │    audio follows host     │
└───────────────────────────┘              └───────────────────────────┘
```

- The **host's app is the server**: no second process, no Go, nothing to
  install on either PC. Guests dial `ws://<host-LAN-IP>:8787`.
- Milestone 1 scope is this repo's app on both ends. (Metrolist Android can
  *not* be a receiver: different track catalog → no genuine audio sync, and
  our chat frames would be rejected by its client too.)

### Reachability checklist (the "how do they find each other" part)

1. Host: `ipconfig` → IPv4 address, e.g. `192.168.1.5`.
2. Host: allow the port once —
   `netsh advfirewall firewall add rule name="TRANCE MUSIC room" dir=in action=allow protocol=TCP localport=8787`
3. Guest: Social → Jam → enter `192.168.1.5` + the 8-char room code → Join.
4. Same Wi-Fi/subnet; guest isolation on some routers ("AP/client isolation")
   blocks device-to-device traffic — turn it off if join times out.

Default port **8787**, overridable via `localStorage["tm-room-port"]` (no
settings UI in M1). If the port is busy the server falls back to an ephemeral
port and the UI shows the port it actually got.

## 3. Protocol v1 — JSON over WebSocket, `v:1`

JSON rather than the protobuf Envelope: our server, our schema, debuggable in
a log, no `protoc` on the build machine. Every frame is one JSON object with
a `t` (type) and `v: 1`.

### Client → server

| `t` | Fields | Notes |
|---|---|---|
| `join` | `code`, `name` | must be first frame; wrong code → `error{bad_code}` and close |
| `chat` | `text` (≤500 chars) | rate-limited 5/10s; empty text rejected |
| `playback` | `playing`, `trackId`, `title`, `artist`, `positionMs` | **host only**; server rejects with `not_host` otherwise. Also serves as the 1 s sync tick |
| `report` | `driftMs` | guest's measured drift; relayed in `presence` |
| `leave` | — | polite disconnect |

### Server → client

| `t` | Fields | Notes |
|---|---|---|
| `joined` | `code`, `selfId`, `youAreHost`, `members[]` | sent once per accepted `join` |
| `presence` | `members[] = {id, name, host, driftMs}` | on every join/leave and drift report |
| `chat` | `from{id,name}`, `text`, `ts` | includes the author's own echo, so the UI renders exactly one path |
| `history` | `msgs[]` | last 50 room messages, sent right after `joined` |
| `playback` | `playing`, `trackId`, `title`, `artist`, `positionMs`, `at` | `at` = server receive time (ms), the guest's timeline anchor |
| `error` | `code`, `message` | shown to the user **verbatim** (`bad_code`, `not_host`, `room_full`, `rate_limited`) |
| `bye` | `reason` | room closed / host left |

Room rules (v1): one room per server, max 8 members, code = 8 chars from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0/O/1/I`), host authority = first
creator; if the host disconnects the room closes (`bye{host_left}`) rather
than silently electing a new host.

**No approval queue in v1** — the code *is* the credential on a LAN you
already trust (see §7). Approval/kick is milestone-2 scope if you want it.

## 4. Playback synchronization (the "listen simultaneously" part)

Host-authoritative timeline, guest drift correction:

1. **Host** emits state on every real change — `play`, `pause`, `seeked`,
   track switch — and every **1 s** as a tick: `{playing, trackId, positionMs}`.
   `positionMs` is read at send time; the guest anchors it to its *local
   arrival time*, so no wall-clock sync between PCs is needed. Error is then
   bounded by one LAN one-way hop (sub-5 ms on Wi-Fi) plus ≤1 s of local
   audio-clock drift (≈0.02 % → sub-ms).
2. **Guest** resolves the track by `trackId` through its own pipeline (same
   app → same catalog id → its own local proxy stream), seeks to
   `positionMs`, and follows `playing`.
3. **Correction:** each tick the guest compares `audio.currentTime` against
   the expected position. `|diff| > 0.4 s` (the tolerance the UI already
   advertises) → seek; otherwise leave it alone so playback doesn't stutter.
4. **Measurement is honest:** the diff computed each tick *is* the reported
   `driftMs` (it carries up to one tick of latency bias — stated in the UI
   note). Host shows the worst peer drift in `#jam-sync-value`; a guest shows
   its own. No peer → `—`, never a fake `±0.4s`.
5. **Track the guest cannot resolve** (host-only local file, missing vault
   entry): the guest keeps showing title/artist/progress as a *mirror* and
   says `Not on this device` — it never claims to be playing.

## 5. Chat

Relayed by the server, rendered by everyone from the same `chat` frame
(including the author's own echo → exactly one code path, no local-only
messages once connected). Sender name comes from the `join` name, history
(50 frames) is replayed to late joiners, rate limit 5/10s. **Offline
fallback unchanged:** with no room, chat behaves exactly as Phase 3 (local
echo labelled local).

## 6. App surface (contract for the JS side)

Tauri commands (Rust, `room.rs`):

| Command | Args → returns |
|---|---|
| `room_open` | `{port?}` → `{port, code, urls: ["ws://192.168.1.5:8787", …], members}` |
| `room_join` | `{addr, code, name}` → `{ok}` (errors arrive as events) |
| `room_chat` | `{text}` → `{ok}` |
| `room_playback` | `{playing, trackId, title, artist, positionMs}` → `{ok}` |
| `room_report` | `{driftMs}` → `{ok}` |
| `room_close` | `—` → `{ok}` (host: shuts server down; guest: leaves) |
| `room_info` | `—` → current role/status snapshot |

Event `room://msg` carries one protocol frame per emit
(`joined`/`presence`/`chat`/`history`/`playback`/`error`/`bye`), so
`app/src/room.js` is a pure reducer over synthetic frames — unit-testable in
Node with no sockets, exactly like `sidecar.js`.

**Why Rust owns both sockets:** the WebView CSP stays untouched (no
`connect-src ws://*` relaxation, no mixed-content question), and every socket
path gets tested for real with `cargo test` on this machine.

## 6a. Frontend contract (frozen — `room.js` + join form)

`app/src/room.js` is DOM-free and pure (style: `sidecar.js`), unit-testable
in Node with no sockets. Frozen API:

- `createRoomState()` → `{role: "idle"|"host"|"guest", status: "idle"|"connecting"|"hosting"|"joined", code, selfId, urls, members, chat, historyLoaded, playback, driftMs, error}`
- `reduceRoom(state, frame)` → **new** state; never mutates the input
- `memberCount(state)` → `max(1, members.length)` — honest "1" before any frame
- `inviteText(state)` → `"<url> · <CODE>"` when hosting, `""` otherwise
- `worstDriftMs(state)` → max `|driftMs|` across non-host members, else `null`

Frame semantics (additions to §3; §8 truthfulness rules all apply):

| frame | reducer effect |
|---|---|
| `joined` | `role:"guest"`, `status:"joined"`, copy `selfId`/`code`/`members`, clear `error` |
| `history` | **replaces** `chat` (never appends), `historyLoaded:true` |
| `chat` | appends; each entry gets `mine = from.id === state.selfId` |
| `presence` | `members` replaced wholesale — server is the only count source |
| `playback` | stored with local `arrivedAt`; **ignored entirely while `role:"host"`** |
| `error` | `message` shown verbatim, never paraphrased; if `status:"connecting"` → back to `"idle"` (join failed) |
| `bye` | full reset to idle; keeps an existing `error`; adopts `reason` as `error` only when `reason !== "left"` and no error is shown; `"left"` clears `error` |
| `refresh` / unknown `t` | state unchanged (`refresh` is answered by the host JS, not the reducer) |

**Join form DOM contract** (ids never reused elsewhere): inside
`#np-panel-jam`, immediately *before* `.soc-qappend` — ids `room-join-addr`,
`room-join-code` (maxlength 8), `btn-room-join`, `room-join-note` (status
line); classes `soc-room-join`, `soc-input`, `soc-input-code`. Light rules
first, `.dark` overrides, matching the `#input-add-song` composer.

## 7. Security model (stated plainly, not oversold)

- The server binds `0.0.0.0` **only while a room is open** and stops on
  `room_close`/app exit. No room → no listening socket.
- Trust model = your LAN. Anyone who can reach the port *and* guess/obtain
  the code joins, reads chat and sees track metadata. **No TLS, no auth, no
  encryption** — appropriate for a home LAN, not for a hostile network.
  The code is a bearer token with 32 symbols ≈ 140 bits, so the real gate is
  network reachability.
- Data that crosses: room code, display name, chat text, track
  id/title/artist/position. No file paths, no tokens, no vault contents.
- CSP unchanged; PRD gains a row for this (`docs/PRD.md`, security table).

## 8. Truthfulness rules (extend `docs/ui.md` §16)

- member count = `presence.members.length` — **server-returned**, or `1 (you)`
  with no room; never a guess.
- chat lines in a room come from the server frame; a message is drawn only
  once, from that frame.
- `#jam-sync-value` shows the **measured** drift or `—`.
- a guest that cannot resolve the track shows `Not on this device`, not fake
  playback.
- errors (`bad_code`, `not_host`, `rate_limited`) reach the UI **verbatim**.

## 9. Verification plan (what can be proven where)

| Layer | How | Where |
|---|---|---|
| Room state machine (codes, join/leave, host authority, rate limits) | `cargo test` unit tests | this machine |
| Wire behaviour | **real two-client integration test**: two WS clients against a live in-process server — join, presence, chat relay, host-only playback, bad-code rejection | this machine |
| JS reducer / UI contract | `app/tests/room.test.mjs` — synthetic frames → state assertions (loopback-only, honesty rules) | this machine |
| Lint/format/gates | `npm test`, `npm run lint`, `cargo fmt --check`, `cargo clippy` | this machine |
| **Actual two-PC sync + chat** | §10 runbook on your two Windows PCs — cannot be proven from one machine, so it is a checklist with expected results, and you report back what happened | your desk |

## 10. Runbook — Windows ↔ Windows (milestone 2)

On PC A (host):
1. Build/run: `npm run tauri dev` (or the installed app).
2. Now Playing → **Social** → **Jam Active** → **Open room**. The pane shows
   the address list (`ws://192.168.x.x:8787`) and the 8-char code; copy the
   invite if you like.
3. First time only: allow the firewall rule from §2.

On PC B (guest):
4. Same app, Social → Jam Active → enter host address + code → **Join**.
5. Expected: member chip shows **2**, a system line in chat says who joined,
   and the host's pane shows 2 members within a second.

Playback check:
6. Host plays a track. Expected on guest: same title/artist within ~1 s,
   position within ±0.4 s of the host (compare the two progress bars at the
   same moment; `#jam-sync-value` shows the measured drift).
7. Host pauses/seeks/skips → guest follows within ~1 s.

Chat check:
8. Type on B → appears on A (and on B exactly once); vice versa; the same
   text twice quickly on B → second one rejected with the verbatim
   `rate_limited` message.

Failure reporting: paste what the Jam pane showed (status line text) and any
`error` code — the UI shows server words unchanged, so the code is enough.

## 11. Milestones

| # | Scope | State |
|---|---|---|
| M1 | Rust room server + guest client + UI wiring + chat + sync + tests + this doc | **in progress** |
| M2 | Two-PC field test via §10, fixes from findings, optional approval/kick | next |
| M3 | `app/src/mobile` as a receiver (same protocol, JS-driven client) | **in progress — pulled forward 2026-10-06** |

## 12. Mobile (Android) surface

The mobile shell (`app/src/mobile/`) runs on the **same Rust core**, so all
seven `room_*` commands and the `room://msg` event are available **unchanged**
— they are registered unconditionally in `lib.rs` (no `#[cfg(desktop)]`).
The mobile NowPlaying screen gets the same **Solo ↔ Social Jam** modes as
desktop.

**Design source:** `design/screens/mobile/nowplaying/code.html` (Sona design
system, delivered 2026-10-06 as `SOCIAL NOWPLAYING MOBILE.zip`) regenerates
`app/src/mobile/screens/nowplaying.html` + `nowplaying.js` — same pipeline as
every other mobile screen (router re-appends `screens/<dir>.js` on each
navigation; header comment records the source).

**Screen map — design element → real source of truth:**

| Design element | Wired to |
|---|---|
| `modeToggleBtn` (Solo ↔ Social Jam) | `room.js` state: no room → Solo; `room_open` → Social (host); `room_join` → Social (guest) |
| `jamSessionBanner` code · count · ping | `joined`/`presence` frames — server-derived code, `memberCount(state)`; **no placeholder ping** |
| `copyUriBtn` invite | `inviteText(state)` → `ws://<lan-ip>:<port> · CODE` |
| Queue tab | local queue via `player.js queueUpNext()`. Social mode: host appends normally; **guest append is disabled with a stated reason** (M1 has no queue frame — never imply sync we don't have) |
| Chat tab | `room_chat` → `history`/`chat` frames → shared reducer |
| Jam Data tab | **honest telemetry only**: real role, real code, real member count, measured `driftMs` from §4. The design's placeholder metrics (bitrate, jitter, buffer %, loss, RTT, "DEMOCRATIC NTP") are **not shown** — we don't measure them (§8) |
| `skipVoteBadge` (2/4) | **hidden in M1** — skip is host-only; server answers `not_host` |
| transport controls | **Solo:** local as today. **Social host:** enabled; broadcasts on play/pause/seek/track-switch + 1 s tick (§4, C-5). **Social guest:** disabled with a visible "Host controls playback" note; applies incoming `playback` frames and reports `driftMs` each tick |
| `queueSyncBadge` "Synchronized" | shown only after ≥1 real `playback` frame was received and applied this session |
| Leave Jam / End Jam | `room_close` → `bye` → back to Solo |

**Shared code:** one reducer for both surfaces — `app/src/room.js` (contract
§6a) imported by desktop `social.js` and mobile
`screens/nowplaying.js`/`jam.js`. Mobile sync drives the same `<audio>`
element through `player.js` exports (`toggle`, `seek`, `next`, `prev`,
`playerState`, `onPaint`, `queueUpNext`).

**Android build notes:** `gen/` is gitignored — `tauri android init` must run
before the first build (`app/build.sh android`). Verify the app manifest
grants `INTERNET` (our WS client is a native Rust socket, so WebView
cleartext restrictions do not apply, but the permission itself must exist).
New Tailwind classes require `npm run css` — mobile ships a compiled
`/tailwind.css`, not the CDN.

**Join flow on mobile (M1):** `modeToggleBtn` when Solo opens a choice sheet
(Start a Jam / Join a Jam / Cancel). Start → `room_open` → host state
(`role:"host"`, code/urls from the return value — the host gets no `joined`
frame by design; it hears every broadcast through `host_sink`). Join → an
input sheet accepts a **pasted invite line** (`ws://ip:port · CODE`, smart
split) or address + code typed separately; `room_join` uppercases/trims the
code and refuses non-LAN addresses server-side. Leaving → `room_close` →
`bye` → Solo.

**Guest track resolution (M1):** match `playback.trackId` against the local
current track, then `[...queueHistory(), current, ...queueUpNext()]` — found
→ `playList(full, idx)` + seek; not found → the header shows the host's title
and `artworkCollabTag` reads `NOT ON THIS DEVICE` (§4 rule 5); the
Synchronized badge stays hidden (§8).

**M1 append honesty:** the jam view's append row is disabled for everyone
with a stated reason — the host adds tracks through the regular queue screen
(its queue *is* the room queue); guests can't add at all (`not_host`).
No in-jam search is fabricated.

**Ids T-110 must add (final C-6 set)** — banner: `jamBannerCode`,
`jamBannerCount`, `jamBannerDrift` (replaces the placeholder `<14ms`),
`jamBannerMembers`; metrics: `jamMemberValue`; queue: `jamQueueList`,
`jamAppendInput`, `jamAppendBtn`; chat: `jamChatList`, `jamChatInput`,
`jamChatSend`; jam data: `jamRoleBadge`, `jamRoomTitle` (painted
`Jam Room #CODE` — never left as static demo text), `jamInviteUri`,
`jamInviteCopy` (second copy trigger), `jamDriftValue`, `jamMemberRow`,
`jamLeaveBtn`, `jamEndBtn`. The lyrics panel keeps its `data-lyrics` /
`data-lyrics-full` bindings so `binders.js` still drives it. Jam Data's
placeholder metric cells (bitrate, jitter, buffer %, loss, RTT, DEMOCRATIC
NTP, resync thresholds, skip quorum, guest-append/chat switches) are
**removed at generation time**, not wired — the honest additions are a Sync
Drift cell (`jamDriftValue`) and the real member/role/invite readouts.

**Legacy ids are mandatory on the transport/scrubber/favorite row** —
`binders.js` paints and wires `master-play-pause`, `play-pause-icon`,
`scrubber-container`, `scrubber-bar`, `scrubber-needle`, `elapsed-time`,
`remaining-time`, `favorite-btn`, `favorite-icon`, `shuffle-btn`,
`repeat-btn` (plus `skip_previous`/`skip_next` buttons keyed by their
`aria-label`). Regenerating those elements under the design's
`mainPlayBtn`/`scrubberTrack` names would freeze the screen — C-6 covers the
**social-only** ids (`modeToggleBtn`, header ids, `artworkCollabTag`,
`skipVoteBadge`, `tabBar`/`view-*`/labels, and the `jam*` set above).
Generated `nowplaying.js` keeps only `switchTab` (+ its tailwind header);
the demo mode/transport scripts are dropped — `jam.js` (room + mode chrome)
and `binders.js` (local paint/transport) own all behavior.

**Truthfulness (§8) applies verbatim to the mobile UI**: no fake member
counts, no placeholder pings, no "Synchronized" until a real `playback` frame
has been received and applied.
