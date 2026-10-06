# Listen Together — two-device rooms (the receiver side)

Status: **Milestone 1 landed on both surfaces** (§13): the desktop Jam pane and
the mobile Now Playing screen are wired to the Rust room commands. Milestone 2
(the two-PC field test, §10) is a runbook that needs two machines; milestone 3
was pulled forward and is done — see §12/§13.

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
| `room_info` | `—` → current role/status snapshot: `{role, port, code, urls}` (`urls` empty unless this device is hosting; recomputed live, so a re-attached UI can re-offer the same invite) |

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
| M1 | Rust room server + guest client + UI wiring + chat + sync + tests + this doc | **landed 2026-10-06 — desktop + mobile, §13** |
| M2 | Two-PC field test via §10, fixes from findings, optional approval/kick | next (needs two machines) |
| M3 | `app/src/mobile` as a receiver (same protocol, JS-driven client) | **landed — `app/src/mobile/jam.js`, §12/§13** |

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
Generated `nowplaying.js` keeps only `switchTab` and its `.tab-btn` listener
binding (+ its tailwind header); the tab buttons must NOT go back to inline
`onclick` — the mobile CSP hashes never covered them (mobile 09 P24). The demo
mode/transport scripts are dropped — `jam.js` (room + mode chrome)
and `binders.js` (local paint/transport) own all behavior.

**Truthfulness (§8) applies verbatim to the mobile UI**: no fake member
counts, no placeholder pings, no "Synchronized" until a real `playback` frame
has been received and applied.

## 13. M1 as shipped — who calls what

Both surfaces are glue over the same pieces: the Rust commands of §6, the pure
reducer of §6a, and the sync math of §4. **Neither surface opens a socket** —
every byte goes through `room_*` IPC and comes back as a `room://msg` frame.

### 13.1 Desktop — `app/src/social.js`

| Trigger | Call / effect | Honest fallback |
|---|---|---|
| entering Social | `room_info` → adopt or reset the room (a reload can leave a stale server) | idle → Solo-style placeholder text, nothing enabled |
| **Open room** (jam pane) | `room_open {port?, name}` → `{port, code, urls, members}` | error string shown verbatim in the join note; slots stay `NO ROOM` |
| **Join room** (C-4 form) | `room_join {addr, code, name}`; the outcome arrives as frames | `bad_code`/`connect_failed` etc. verbatim; the button re-enables |
| `play`/`pause`/`seeked`/track change **+ 1 s tick while playing** (host) | `room_playback {playing, trackId, title, artist, positionMs}` | a guest never calls it — the transport is disabled with a stated reason |
| chat send | `room_chat {text}`; the line is drawn **only** from the echoed `chat` frame | no room → the local echo of §3a, unchanged |
| each 1 s tick (guest) | `room_report {driftMs}` from `syncDecision()` (§13.3) | no `playback` frame yet → no report, `#jam-sync-value` stays `—` |
| **Leave Room** | `room_close` → `bye{left}` → Solo | — |

Slots the desktop paints (all from `room.js` state, never from a literal):
`#soc-room-code` / `#qr-room-code` / `#jam-room-id` (the §3b-i `ROOM_SLOTS`
table), `#jam-sidecar` (room-server state: `Not in a room` / `Listening on
:<port>` / `Joined`), `#jam-sidecar-note` (which side of the room this window
is on), `#jam-members` (cloned member rows from `presence`), `#jam-members-note`
(count + who owns the transport), `#jam-session-mode`, `#jam-sync-value`
(measured drift, §4.4), `#room-join-note` (join status), plus the member
counts of §3a.

`#jam-ua` was **removed** in this milestone. It existed to paste this app's
User-Agent into metroserver's `ua_policy.json`; the in-app room server has no
UA policy, so the line could only tell a user to edit a file that nothing
reads (the §6b "dead chrome" rule). `metroproto.js`/`sidecar.js` stay in the
repo and in `npm test` as the dormant interop path — nothing in the UI drives
them, and `social.js` no longer imports them.

### 13.2 Mobile — `app/src/mobile/jam.js`

One module owns the mobile social layer. It is an ES module (imported by
`app.js`) because `screens/*.js` are **classic** scripts re-appended by the
router and cannot `import`. It hooks `smount` (dir `nowplaying`) for the fresh
DOM and `onPaint` (from `player.js`) for repaints.

| Trigger | Call / effect |
|---|---|
| `modeToggleBtn` in Solo | choice sheet: Start a Jam / Join a Jam / Cancel (§12) |
| Start | `room_open` → host state; `jamSessionBanner`, role badge and invite fill in |
| Join | sheet accepting a pasted invite line (`ws://ip:port · CODE`) or addr + code → `room_join` |
| host transport | enabled; broadcasts on play/pause/seek/track change + 1 s tick (§4, C-5) |
| guest transport | disabled with a stated reason; applies incoming `playback` (§12 guest resolution) and reports `driftMs` per tick |
| chat | `room_chat` → `history`/`chat` frames; rendered from frames only |
| `jamLeaveBtn` / `jamEndBtn` | `room_close` → `bye` → Solo |

The desktop's `#btn-leave-room` leaves the **mode** as well as the room (its own
tooltip says "return to Solo"), while the mobile sheet has separate Leave/End
actions that do the same thing. A host that is left with no room can still open
one again — `room_open` is refused with a stated reason, never silently.

Slot ids: the C-6 set (`jamBannerCode`, `jamBannerCount`, `jamBannerDrift`,
`jamBannerMembers`, `jamMemberValue`, `jamQueueList`, `jamAppendInput`,
`jamAppendBtn`, `jamChatList`, `jamChatInput`, `jamChatSend`, `jamRoleBadge`,
`jamRoomTitle`, `jamInviteUri`, `jamInviteCopy`, `jamDriftValue`,
`jamMemberRow`, `jamLeaveBtn`, `jamEndBtn`) plus the social chrome
(`modeToggleBtn`, `headerSubtitle`, `headerTitle`, `headerModeDot`,
`jamSessionBanner`, `copyUriBtn`, `artworkCollabTag`, `skipVoteBadge`, `tabBar`,
`view-*`, `queueTabLabel`, `queueSyncBadge`, `queueHeaderLabel`) and the
**legacy** transport ids `binders.js` paints (`master-play-pause`,
`play-pause-icon`, `scrubber-container`, `scrubber-bar`, `scrubber-needle`,
`elapsed-time`, `remaining-time`, `favorite-btn`, `favorite-icon`,
`shuffle-btn`, `repeat-btn`, plus the `aria-label="Next"/"Previous"` buttons).

Ids added beyond C-6 by this milestone (all documented here because a gate
asserts them): `jamMembersList` (the member rows' host), `jamChatState`,
`jamAppendNote`, `jamTransportNote` (the guest-lock reason), and the local paint
hooks `np-art` / `np-title` / `np-artist` / `np-album` — `binders.js` now
decides by id first and falls back to its old class probes for the older
screens.

`jamAppendInput`/`jamAppendBtn` ship **disabled** with the reason in their own
placeholder: M1 has no append frame, so nothing may imply the room heard an add.

**Fabrications removed at generation time** (they were design-mock values, and
§8 forbids showing them): the banner's `#OM-904` / `4` / `<14ms` trio, the
member avatar stack, the four demo queue tracks, the two demo chat messages and
"4 Listeners Active", the `Jam Room #OM-904` title, and the whole telemetry
grid (bitrate, jitter, buffer %, loss, RTT, `DEMOCRATIC NTP`, 5 s resync,
15 ms jitter, `2 / 4 votes`) together with the two permission switches no
protocol backs. `jamRoleBadge` shows the real role; `jamDriftValue` shows the
**measured** drift; empty states say so.

### 13.3 Shared sync math — `app/src/room.js`

`driftMs` is only honest if both surfaces compute it the same way, so the math
lives in the reducer module next to the frames (pure, DOM-free, `node --test`):

- `expectedPositionMs(playback, nowMs)` — `positionMs` advanced by the local
  time since the frame **arrived** (`arrivedAt`), which is why no wall-clock
  sync between two PCs is needed (§4.1).
- `syncDecision(state, audioPosSec, nowMs)` → `{driftMs, seekToSec}`: the
  measured difference, and a seek target **only** past the ±400 ms tolerance
  (`DRIFT_TOLERANCE_MS`) so playback never stutters for sub-tolerance noise.
  `driftMs` is `null` — not `0` — before the first `playback` frame.

### 13.4 What was actually verified (and what was not)

| Claim | Evidence |
|---|---|
| Room server: join/refuse, presence, chat relay + rate limit, host-only playback, cached playback for late joiners, drift relay, room-full, close, history cap | `cargo test room::` — **10/10 pass** on this machine |
| The whole Rust suite still passes with the manifest fix | `cargo test` — **174 pass, 0 fail** |
| Desktop Jam pane drives the room: mode entry, `room_open` → code in all three slots + port + share line, `room_chat` + single-render echo, `presence` → member list + worst drift, `joined` → guest lock on transport and seek surface, leave → `room_close` → Solo | headless Chrome against `app/src/index.html` with a scripted `invoke`/`listen` stub: **39/39 checks** (`room_*` calls, painted values, lock state) |
| Mobile Now Playing drives the room: Solo default, mode sheet, `room_open` → banner/code/count/invite, chat round trip, `presence` → count/drift/member rows, host ignores incoming playback, guest names an unresolvable track and stays unlocked-from-sync, leave → `room_close` | headless Chrome against `app/src/mobile/index.html` + the real router/binders/screen fragment with the same stub: **31/31 checks** |
| The two clients speak one protocol | both suites drive the same seven commands and the same `room://msg` frames through `app/src/room.js` |
| **Desktop — real app window + a second real socket client** | `node tests/live-desktop.mjs` against a self-contained `cargo build` binary (WebView2 remote debugging on `:9222`): **32 pass / 0 fail** — room opened from the UI, code in all three slots, `ws://10.227.158.104:8787` advertised, handshake `joined,history,presence`, chat echo in **31 ms**, guest `playback` refused `not_host`, `presence` → 2 members + `±0.25s`, guest leave → 1 online + `—`, Leave → `NO ROOM` + Solo |
| **Android — real debug APK on the `Pixel6_API36` emulator + a second real socket client** | `node tests/live-android-emulator.mjs`: **28 pass / 0 fail** — the device's Rust server opened `#6TH5BLFR`, invite `ws://10.0.2.16:8787 · 6TH5BLFR`, chat echo in **31 ms** through the adb forward, `presence` → 2 members + `±0.25s`, second guest line rendered, leave → Solo |
| **Two real devices over a physical LAN** | **still NOT DONE** — each run proves one real app speaking to a real socket, but on the same machine (desktop) and emulator host (Android). A packet crossing a real LAN between two PCs is the §10 runbook and remains untested. |
| **A `gen/android` debug APK is a dev client, not a shippable build** | The checked-in `app-x86_64-debug.apk` had been produced by `tauri android dev`, so it baked in `devUrl` (`http://<pc-ip>:1430/mobile/index.html`). On the emulator it rendered a load-failure page (DOM with **0** ids, `Failed to request http://…:1430/…` in `adb logcat`). Only `tauri android build --debug` embeds the frontend; the standalone APK is what the run above used. |

Two defects surfaced only because these two harnesses were run against a real
app for the first time:

1. **`room_info` hid the invite.** It returned `{role, port, code}` while
   `room_open` returned the `ws://` list, so a re-attached window could not
   re-offer the address it was serving on. `room_info` now returns the same
   `urls` (§6).
2. **The `room://msg` listener was attached only on entering Social.**
   `#btn-open-room` lives in the social-only pane, but `openRoom()` did not
   require the mode — a room could be opened with nobody listening, freezing
   the host UI at `1 online` forever. The listener is now attached once at
   boot (`startRoomListener`), and it no longer latches itself off when
   `__TAURI__` is not yet present.

`live-desktop.mjs` also had to enter Social before touching the Jam pane: those
controls are `display:none` in Solo, so clicking them from boot was proving a
state a user cannot reach.

The probes were temporary scaffolding (stub + driver files beside the shell,
deleted after the run) because the repo has no browser-test dependency and no
network install is allowed for the gate. They are described here so the numbers
above can be reproduced or contradicted, not taken on faith.

### 13.5 The `cargo test` harness (P0, fixed here)

The room suite could not run at all before this milestone: the test executable
carries no application manifest, so the loader bound comctl32 v5.82 and died
with `0xC0000139` before `main` (`rfd` → `TaskDialogIndirect`, ROOM.md §3C
L-3). `build.rs` now declares the comctl v6 dependency on the link line
(`rustc-link-arg`; `rustc-link-arg-tests` is rejected because this package has
no `[[test]]` target, and the app binary already carries Tauri's own manifest).

The moment the harness loaded, one test failed — proof the block was hiding a
real defect rather than protecting a green suite:
`drift_report_paints_presence_for_the_host_tile` read the **join-time** presence
frame (which must carry no `driftMs`) and asserted 420 against it. The test now
drains that frame, asserts the absence explicitly, and then reads the report's
presence.
