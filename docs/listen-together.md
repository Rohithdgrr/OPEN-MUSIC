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

### Standing two-device gate (automated — verified 2026-10-08)

The sequences below are the exact commands Tasks 6–7 of
`docs/jam-stabilization-plan.md` ran green; each row's count is the pass bar.
They are self-contained (each establishes its own precondition), run from the
repo root in PowerShell, and cover **both directions** plus the D4 pause and D5
bye regression checks. Nothing here pushes (AGENTS rule 1).

| # | Command | Transport exercised | Expected |
|---|---|---|---|
| 1 | `npm run tauri dev` — leave running; CDP needs `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` set **before** launch | — | window up; `Invoke-RestMethod http://127.0.0.1:9222/json/list` lists the page |
| 2 | `node app/tests/live-desktop.mjs` | in-process node guest ↔ desktop server (loopback) | `---- desktop live: 32 pass / 0 fail` |
| 3 | `npm run tauri -- android build --debug --target x86_64`, then `adb install -r app\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk` | — | `BUILD_EXIT=0`, `Success` |
| 4 | `node app/tests/live-android-emulator.mjs` | adb-forward loopback (raw node client vs the device's own server) | `---- 28 pass / 0 fail` |
| 5 | `node app/tests/live-lan-join.mjs` | **real LAN** `ws://<pc-ip>:8787` — removes all adb tunnels first | every check PASS, `LAN-JOIN exit=0` — incl. guest `room_info → idle` + rejoin after host bye (D5) |
| 6 | `node app/tests/live-reverse-pair.mjs` | adb-forward (Android host ↔ desktop guest) | `REVERSE-PAIR exit=0` (19 checks) — incl. D4 pause/resume broadcast and the desktop-side D5 revert + rejoin |

Known traps (each cost real time during Tasks 6–7):
- **CLI skew (P28):** `npx tauri …` from the repo root resolves the *global*
  CLI (2.11.2 here) and dies with `npm.bat CreateProcess error=2`. Always
  `npm run tauri -- …` (local 2.12.0).
- **CDP:** the WebView2 env var must be set before `tauri dev` starts; it *does*
  propagate through `npm run tauri dev` (the old "CDP cannot attach through
  tauri dev" note is stale for this setup — falsified 2026-10-08). A second
  app launch is swallowed by `tauri-plugin-single-instance` and never appears
  in `/json/list`.
- **PowerShell:** `$env:NAME="x"` (no `export`); a `NativeCommandError`
  claiming `exit code 1` can be spurious — re-check `$LASTEXITCODE`. `>`
  re-encodes bytes (UTF-16), so never capture binary output through it.
- **The live probes are hand-run**, not part of `npm test` (its glob only
  picks `tests/**/*.test.mjs`); never chain a stage-check and `git push` in
  one command (AGENTS rule 8).
- **Transport is asserted per row:** rows 2/4 are loopback-only and prove the
  protocol; row 5 is the only *real-LAN* path (Review Focus 1 — cleartext
  config scopes to `127.0.0.1`, so a LAN join is the one untested surface).

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

> **Defect (D4, found 2026-10-07 — FIXED 2026-10-07; original report kept
> below, full evidence §13.7).** The mobile host did **not** actually
> broadcast on pause, so the transport row above was
> aspirational for that one case. `jam.js:342 hostTick()` returns at line 346
> (`if (!t || !t.id || st.paused) return;`) *before* the drift/key checks its
> own comment (lines 338-341) says are there to "catch play, pause, track
> changes and seeks", and mobile wires no `play`/`pause`/`seeked` listener and
> no title observer: `broadcastPlayback()` has exactly two call sites
> (`jam.js:263 refresh`, `:354 hostTick`) against the desktop's five
> (`social.js:317 startHostTick`, `:401 refresh`, `:696` title MutationObserver,
> `:704` `play`/`pause`/`seeked` — registered at boot by `wireReactions()`,
> `:884`). Measured: the host paused at t=136 while the desktop guest kept
> playing at t=141 and still reported `±0.06s`. The guest would have paused
> (`social.js:371-372` applies `playing:false` for the same track), and the
> *small* drift is itself proof the cached frame still read `playing:true`.
> Consequences: guests keep playing while the host is paused (the inverse of
> "the host controls playback"), and a track change or seek made **while
> paused** is not sent until playback resumes. Resume does self-heal — the
> key/drift mismatch fires on the first tick after `play`.
>
> **Fix landed (2026-10-07):** `hostTick` now compares the `id|paused` key
> *before* the paused guard, and `wireHostAudio()` (called from `mountJam`)
> wires `play`/`pause`/`seeked` on the shell `<audio>` — `mobile/jam.js`.
> Design/fix record: `docs/jam-defects-d1-d4.md`.

> **Defect (D5, found 2026-10-08 — fixed 2026-10-08, Task 7; full evidence in
> `docs/jam-audit-findings.md` §C).** When the host closes a room while a
> guest is still connected, the guest UI resets correctly on the server's
> `bye`, but the guest **backend stays `Mode::Guest`** — `room_info` reads
> `{role:"guest"}` and the next join is refused verbatim
> `Leave the current room before joining another.` while every surface reads
> Solo (same toast as P32/D2, different trigger: that one was a failed dial,
> this one is a session the host ended). Cause: `guest_run`'s pump
> (`room.rs:655-680`) forwards the server's `bye` to the UI and keeps
> waiting, but after `room_close` the server only *drains* (axum graceful
> shutdown, `room.rs:579`) and never closes the socket — so the pump never
> ends, the D2 failure-exit reverts never run, and the guest's socket lingers
> (observed open 30 s+ in the Task 6 blip probe). **Fix:** the pump now ends
> on a server `bye` (`guest_pump` → `PumpEnd::ServerBye`), the mode is
> reverted to `Idle` *before* the `bye` reaches the UI (D2's ordering rule),
> the server's own frame is forwarded (no synthetic second toast), and the
> socket is closed so the host's drain completes. Affects desktop and mobile
> guests alike — both run this one Rust path.

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

> **Defect (D1, found 2026-10-07 — FIXED 2026-10-07/08; original report kept
> below, full evidence §13.6).** That search list was
> **narrower than the desktop's**: `social.js:328 findLocalTrack()` resolved the
> host's id against play history, favourites, the vault *and* the live queue,
> while mobile `jam.js:398 followGuest()` saw only queue history + current +
> up-next. On a phone that has a track downloaded or favourited but not sitting
> in the current queue, the host's track was declared "not on this device" and
> the guest silently kept playing its own audio for the rest of the room —
> with its transport locked (below). Measured: 0 of 3 host tracks resolved on
> Android until one happened to be in the queue/history; 2 of 2 resolved once
> the id was in reach (§13.6).
>
> **Fix landed (2026-10-07/08):** mobile `followGuest` now also searches plays,
> favourites and the vault (`mobile/jam.js:440-455`) and falls back to
> `resolveFromCatalog` (`jam/follow.js`, shared by both surfaces —
> `mobile/jam.js:456-473`, `social.js:341-361`). Landed in commit `6f2f302`.

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
| **A real desktop host + a real Android guest in one room (both apps, no synthetic socket)** | **DONE 2026-10-07 — §13.6.** Chat, presence, drift report, follow-and-play and auto-resume all worked against two real apps; three defects found (D1 guest resolve scope, D2 `room_join` state leak lockout, D3 stale mirror note). |
| **The reverse pairing — a real Android host + a real desktop guest** | **DONE 2026-10-07 — §13.7.** Join, chat both ways, host broadcast, follow-and-play (`±0.08s` → `±0.05s`) and resume re-sync all worked; the desktop guest took the same §4.5 mirror path for a track it lacked. One new defect: **D4 — the Android host never broadcasts a pause.** |
| **Two real devices over a physical LAN** | **still NOT DONE** — the run above is two real apps, but the guest is the *emulator on the same PC* (device loopback through `adb reverse`). A packet crossing a real LAN between two PCs is the §10 runbook and remains untested. |
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

### 13.6 Desktop host ↔ Android guest — first real two-client run (2026-10-07)

**Defects D1–D3 from this run, each with its proposed fix: `docs/jam-defects-d1-d4.md`** (design only — no code changed *in that session*; **all three since fixed** — D2/D3 committed before 2026-10-07, D1 in `6f2f302`, see the fix notes in §12/§13).

Every earlier live run used **one real app + one synthetic socket client**. This
run put the real desktop app (host) and the real Android app (guest) in the
same room for the first time, driven only through the UI — the defect report
under test was *"the guest doesn't follow the host's music, the controls are
locked and nothing responds, only chat works."*

**How it was run** (nothing in the repo was modified; all drivers were
throwaway `Runtime.evaluate` scripts in a temp dir):

| Side | Setup |
|---|---|
| Desktop host | plain `cargo build` (self-contained — assets embedded, page is `http://tauri.localhost/`), launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, attached over CDP |
| Android guest | the installed app, CDP over `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`; the guest dialed the host through **`adb reverse tcp:8787 tcp:8787`** (see the harness note below — `adb forward` is the wrong direction and produced the first failure) |
| Traffic | room `#5BTQDYZM` on `:8787`, two real members, host playing from its own queue |

**What both sides did, verbatim:**

| Step | Desktop host | Android guest |
|---|---|---|
| Join | `2 in the room`, member rows `Host` / `Guest` | toast `Joined room 5BTQDYZM`, banner `#5BTQDYZM` · count `2`, role `GUEST` |
| Chat | `ping from guest` rendered from the guest | sent from `#jamChatInput`, echoed back |
| Presence / drift | `jam-sync-value` `±0.09s` → `±0.00s` | `jamBannerDrift` `±0.04s` → `±0.20s`, member row `±0.04s` |
| Host on a track the guest **has** (`AjWUhbq4`, `cKPqYV55`) | — | audio `<src>` switched to the host's id, `artworkCollabTag` `FOLLOWING HOST`, queueSyncBadge visible, `appliedFrames` counted |
| Host on a track the guest **lacks** (`nBqLSLVk`, `NEBgg__6`, `p1O59IIG`) | keeps playing, tile drift frozen at last value | `artworkCollabTag` `NOT ON THIS DEVICE`, **no** `room_report`, drift stays `—` on a fresh session, guest audio keeps playing its **own** queue (observed still on `cKPqYV55` at t=192 while the host was on `p1O59IIG`) |
| Guest paused by hand | — | auto-resumed on the next frame: paused at t=67 → playing t=95 within 4 s, seek-corrected |
| Controls | enabled | `master-play-pause` disabled + `The host controls playback in this room.` (by design, §12) |

**Hypotheses from the plan — verdicts:**

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | guest cannot resolve the host's track | **CONFIRMED — primary cause** | 0 of 3 host tracks resolved until the id was in queue/history; resolution succeeded 2/2 once reachable, with follow + play + drift reporting all working |
| H2 | host never broadcasts `playback` | **DISPROVEN** | the guest switched tracks and reported drift within one tick of the host changing song — frames arrive |
| H3 | autoplay rejection swallowed | **DISPROVEN on Android** | a paused guest resumed and seek-corrected straight from a frame callback (`jam.js:379`), no `NotAllowedError` |

**Three defects, all reproduced at the time (all since fixed — D1 in `6f2f302`, D2/D3 committed before 2026-10-07):**

1. **D1 — the mobile resolve list is too narrow (the reported symptom).**
   `mobile/jam.js:398 followGuest()` searches `queueHistory() + current +
   queueUpNext()` only; desktop `social.js:328 findLocalTrack()` additionally
   searches play history, favourites and the vault. Any host track not sitting
   in the phone's current queue is declared `NOT ON THIS DEVICE` forever, while
   the transport stays locked (§12) — the guest can neither follow nor take
   over, and its own audio keeps playing. That is precisely "nothing works but
   chat". Spec text for this: §12 "Guest track resolution (M1)" (annotated).
2. **D2 — a failed join bricks the backend until the app restarts.**
   `room.rs:787 room_join` sets `Mode::Guest { tx }` at line 808 **before** the
   socket connects; `guest_run` (line 589) sends an `error` frame on a refused
   or timed-out dial and returns **without resetting the mode** — `Mode::Idle`
   is written only by `room_close` (`room.rs:881`) and at init (line 698).
   The UI resets itself to Solo on that `error` frame (`jam.js:285-289`) and
   never calls `room_close`, so the next attempt hits `room.rs:796`
   *"Leave the current room before joining another."* — a room the UI says does
   not exist. Reproduced twice: `room_info` returned `{role:"guest"}` while the
   banner read `SOLO`; after an explicit `room_close` the same join succeeded
   first try. The only in-app recovery is an app restart (`initJam`'s boot
   `room_info` → `room_close`, `jam.js:736-741`). Any unreachable address
   triggers it: wrong IP, host app closed, firewall.
3. **D3 — the collab tag and sync badge go stale (§8 truthfulness).**
   `mirrorNote` is cleared only on a *successful* resolve (`jam.js:411`) or on
   leave (`:233`). If a later frame's id already equals the local track,
   `guestApply` takes the fast path (`jam.js:369`) and never clears it — the
   guest was observed at `NOT ON THIS DEVICE` **while** showing `±0.04s` drift
   and a visible `Synchronized` badge. The mirror image also holds: after the
   host moved to an unresolvable track the badge and `±0.00s` lingered although
   no frame was being applied.

**Harness notes worth keeping:**

* `adb forward tcp:8787 tcp:8787` listens on the **host** (the adb process owns
  `127.0.0.1:8787`), so a *device-side guest* gets `Connection refused` on its
  own loopback. Device → host needs **`adb reverse tcp:8787 tcp:8787`**;
  probe with `adb shell "toybox nc -z -w 2 127.0.0.1 8787"`.
  `live-android-emulator.mjs` uses `forward` legitimately — in that suite the
  room server runs **on the device**.
* The app ships `tauri-plugin-single-instance`: a second launch forwards to the
  first and exits, so it never appears in `:9222/json`.
* A desktop debug exe last built under `tauri dev` bakes the `devUrl`
  (`http://127.0.0.1:1430/`) into itself and shows an error page when started
  standalone — the known Android trap (`incomplete-jam.md` §5.2/§5.3) applies
  to desktop too. Plain `cargo build` embeds the assets.

**Still not proven:** a physical LAN between two machines (§10 runbook) and a
real second phone rather than the emulator. *(The third item — whether D1's
symptom reaches a desktop guest — was answered by §13.7 the same day: yes, the
desktop guest takes the same §4.5 mirror path, but its wider resolve list makes
it follow far more often.)*

### 13.7 Android host ↔ desktop guest — the reverse run (2026-10-07)

The pairing of §13.6 with the roles swapped, because *"also verify for vice
versa"* is a different code path on **both** sides: the host broadcast on mobile
is `jam.js hostTick` (not `social.js wireReactions`), and the guest applying the
frames is `social.js guestTick` (not `jam.js guestApply`). Same two real apps,
driven only through the UI; nothing in the repo was modified.

**Defect D4 from this run, with its proposed fix: `docs/jam-defects-d1-d4.md`** (design only — no code changed *in that session*; **fixed 2026-10-07**, see the D4 fix note in §12).

| Side | Setup |
|---|---|
| Android host | the installed app, CDP over `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`; room opened from the mode sheet (`Start a Jam`) |
| Desktop guest | plain `cargo build` binary + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`; joined through **`adb forward tcp:8787 tcp:8787`** — the mirror image of §13.6: *forward* when the device hosts, *reverse* when it dials |
| Traffic | rooms `#MPXYBD5L` then `#5VV6PGF8` on `:8787`, two real members; a raw second client (`WebSocket` + `join`, no UI) was used as an independent witness of the wire |

**What both sides did, verbatim:**

| Step | Android host | Desktop guest |
|---|---|---|
| Join | banner `#MPXYBD5L` · count `2`, `jamMembersList` YOU + Host rows, role `HOST` | `Joined room MPXYBD5L`, session `Guest — following the host`, `membersNote` `2 in the room · the host controls playback.`, transport locked |
| Chat | `ping from desktop` rendered | `ping from android` rendered (`chat.len` 1 → 2) |
| Host on a track the guest **has** (`6DN9AmgT`) | `PLAYING FROM JAM … Admi Jo Kahta Hai` | title switched, audio **playing** `stream?id=6DN9AmgT`, `jam-sync-value` `±0.08s` → `±0.05s`, member rows `H 0.05s` / `G -0.05s` |
| Host on a track the guest **lacks** | keeps playing | `#jam-sidecar-note`: `Host is on "Aye Dil-E-Nadan - Full Version" — not on this device.` — the §4.5 mirror path, on a **desktop** guest |
| Host **pause** | paused, audio t=136, icon `play_arrow` | **kept playing** (t=141), badge still `±0.06s` → **D4** |
| Host resume | t=137 | re-synced to `±0.05s` within a frame; member drift repainted |
| Host `skip_next` | queue advanced (incl. a resume-at-77 s case) | raw client's cached `playback` updated to the new id (`2HXOzvO_`) |
| Leave / room close | `jamLeaveBtn` → `NO ROOM` | `bye` → idle |

**Hypotheses — verdicts:**

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| V-H1 | the mobile host never broadcasts (`hostTick` never armed) | **DISPROVEN** | the raw client's `joined` welcome carried a cached `playback` written **before any guest existed**, and it saw live `playback` frames afterwards. Arming path: `startRoom()` synthesises a `hosted` frame locally (`jam.js:190-196`) → `applyFrame`'s tail calls `startTick(hostTick)` (`:302`) at room open. Rust sends no `hosted` (only `refresh`, `room.rs:341`), which is what made this look dead on paper |
| V-H2 | the desktop guest receives no `playback` frames | **DISPROVEN — my own reading error** | `paintRoom()` writes `#jam-sidecar-note` (`social.js:147`), while `setRoomNote()` writes `#room-join-note` (`:69`). I was polling the join note, which legitimately still read `Joined room MPXYBD5L.`; the mirror line was in the sidecar note the whole time |
| V-H3 | the host's `room_playback` is refused or not registered on Android | **DISPROVEN** | all seven `room_*` commands are registered unconditionally (`lib.rs:1657-1663`), `room_playback` allows `Mode::Host` (`room.rs:826`), and the cache/wire traffic above is that call's output |
| V-H4 | a host pause reaches the guests like any other state | **CONFIRMED DEFECT — D4** | see below |

**D4 — the Android host never broadcasts a pause** (§12 transport note, mobile
09 **P34**): `jam.js:346` returns while `st.paused`, and mobile has no
`play`/`pause`/`seeked` listeners where desktop does (`social.js:702-706`) and
no title MutationObserver (`:687-697`). Observed live: host paused at t=136,
desktop guest still playing at t=141 with a *small* drift — a frozen
`positionMs` with `playing:true` in the cached frame is exactly what
`syncDecision` would score that way. Any change made while paused (next track,
seek) is withheld too, because the guard returns before the key check; the
resume afterwards self-heals via the drift mismatch.

**Harness notes worth keeping:**

* **Direction matters:** `adb reverse tcp:8787 tcp:8787` when the *device* is
  the guest (§13.6); **`adb forward tcp:8787 tcp:8787`** when the *device*
  hosts — the host machine then dials `127.0.0.1:8787`, which is the adb
  listener, not the desktop app's own room server (the desktop must be idle, or
  the port is taken).
* PowerShell 5 **drops an empty `""` argument**, shifting positional args: a
  probe called as `node p.mjs 20000 "" 5VV6PGF8` received `CHAT="5VV6PGF8"` and
  sent that as a chat — silently contaminating a "chat-free" arming test. Check
  the echo (`sentChat`/`inbound`) before believing a negative result.
* Wrapping `window.__TAURI_INTERNALS__.invoke` at runtime intercepts **nothing**:
  both surfaces capture `window.__TAURI__?.core?.invoke` **by reference at
  module load** (`mobile/shared.js:5`, `core.js:35`). Proven by a probe whose
  own `room_info` call never appeared in its log. Watch the wire instead (raw
  `WebSocket` client), which is also the only witness that cannot be
  mis-read through a UI element.
* Reading the wrong DOM id costs a wrong conclusion: `#room-join-note` is
  write-once (`setRoomNote`), `#jam-sidecar-note` is the live one
  (`paintRoom`).
