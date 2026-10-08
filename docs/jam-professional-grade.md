# Jam + chat — professional-grade campaign (2026-10-09)

Docs-first record for the request *“make jam and chat work in all conditions …
0 latency … connect/close/reconnect/host↔guest … professional grade.”*
Written **before** the remaining code, per AGENTS.md rule 3.

Related: `docs/jam-upgrade.md` (A–F), `docs/chat-test-plan.md` (G1–G6 + F
system lines), `docs/listen-together.md`, `ROOM.MD` §3D.

**Honest bound on “0 latency”:** a LAN hop is never 0 ms. Chat already
round-trips in ~30 ms when measured live. Playback uses a 250 ms host tick
plus immediate broadcasts on play/pause/seek/track. The professional target
is **immediate on every user action** and **p95 |drift| ≤ 100 ms** in
steady state (`jam-upgrade.md` §C) — not a physics-defying 0.

Ponytail skill: not present on this machine (`~/.config/opencode/skills`
had no `ponytail/SKILL.md`). Work follows that campaign’s usual TDD +
shared-reducer style anyway.

---

## 1. What I found (tree as of 2026-10-09, before this campaign’s edits)

Most of the earlier Jam/chat campaign **already landed in the working tree**.
Do not re-implement it. The remaining defects are the ones below.

### Already done (do not redo)

| Area | Evidence |
|---|---|
| Unified invite URI (A) | `invite_uri` / `room_join_uri`, one paste field both shells |
| Sync v1 (C1–C3) | `HOST_TICK_MS = 250`, `syncDecision` deadband 40 / nudge / seek 150, `shouldReportDrift` |
| Lost-socket auto-rejoin | `shouldAutoRejoin` / `rejoinDelayMs` in `room.js`, wired in `social.js` + `jam.js` |
| Chat G1–G6 + system join/leave lines | reducer `hosted` clears chat; `maxlength=500`; mobile restores text; `RoomCore::system_line` |
| D1–D5 playback defects | catalog follow, failed-dial Idle, mirror-note, mobile pause broadcast, bye pump revert |
| Transport immediacy (desktop) | `play` / `pause` / `seeked` + title observer → `broadcastPlayback` |
| Transport immediacy (mobile) | same audio events + `onPaint` track-key change |

### Real gaps (this campaign)

| # | Gap | Why it hurts | Evidence |
|---|---|---|---|
| **N1** | Display name never reaches Jam | **Landed.** `roomDisplayName` reads `tm-name` then `tm-username`. | `room.js`; both `roomName()` wrappers |
| **N2** | Desktop Social entry **kills** a live host room | **Landed.** `enterSocial()` adopts `role === "host"`; guests still close. | `social.js` |
| **N3** | Room cap still **8** while docs say **16** | **Landed.** `MAX_GUESTS = 16`. | `room.rs:39`; `seventeenth_guest_is_refused` |
| **N4** | No scale / cycle **gate** | **Landed.** `seventeenth_guest_is_refused`, `sixteen_guests_chat_and_playback_fan_out`, `dropped_guest_can_rejoin_same_code`, `guest_leave_rejoin_cycles_keep_the_room`; hand-run `app/tests/live-scale.mjs`. | `room.rs` tests + `live-scale.mjs` |
| **N5** | Mobile host adopt paints `"Host"` | **Landed.** adopt uses `roomName("Host")`. | `jam.js` |
| **N6** | Live chat probe still counts **all** list children | **Landed.** `chatCount` = `.soc-chat-msg, .soc-chat-system`. | `live-chat-conditions.mjs` |
| **N7** | Settings copy still says greeting-only | **Landed.** both shells: “Home greeting and as your name in a Jam.” | `settings.js` / `screens/settings.html` |

### Explicit non-goals (unchanged)

- Host migration when the host leaves (M2 — room ends; the *cycle* is leave → idle → the other device opens).
- NAT traversal / TURN. LAN only.
- Protocol v2 ping/pong (only if live p95 |drift| > 100 ms after this pass).
- iOS device run (no Apple hardware).
- Vendored scanner work beyond what B already decided.
- Committing `temporary/` or pushing (rule 1).

---

## 2. Task

Make Jam and chat **professionally reliable** across:

- general use (open, chat, follow, leave)
- edge cases (failed join, host close, socket drop, role swap, reload)
- network (lost socket auto-rejoin; Leave / host-close stay idle)
- scale (16 guests, 17th refused, one chat + one playback reaches all)
- identity (Settings display name is the roster name on both surfaces)

And keep latency at the documented bound: **action → wire immediately**, tick
250 ms, no claim of 0 ms.

---

## 3. What I want to do

1. One storage key for the human name (`tm-name`, with `tm-username` as a
   one-line fallback so any old value still works).
2. Desktop Social entry **adopts** a live host the same way mobile does;
   guests still close (the guest socket does not survive a reload).
3. Land `MAX_GUESTS = 16` so code matches `listen-together.md`.
4. Server tests: 16 join + 17th `room_full`; chat + playback fan-out to every
   guest; drop + rejoin the same room.
5. JS tests: `roomDisplayName`; reconnect/role-cycle table (already-pure
   helpers).
6. Probe: count real chat rows (`.soc-chat-msg` / `.soc-chat-system`).
7. Settings copy: Home **and** Jam.
8. Efficient live check only if a debug app is already listening on `:9222`;
   do not block the campaign on a 10-minute rebuild.

---

## 4. How to solve (design)

### N1 / N5 / N7 — display name

Add a DOM-free helper in `room.js`:

```
roomDisplayName(read, fallback)
  → sanitizeRoomName(read("tm-name") || read("tm-username") || "", fallback)
```

`read` is injected so `node:test` does not need `localStorage`. Both
`roomName()` functions become one call with `"Host"` / `"Guest"` fallbacks.
Adopt-host member rows use `roomName()`, never the literal `"Host"`.
Settings subtitle updated on both shells. **No second writer** — `tm-name`
stays the settings key.

### N2 — adopt, don’t kill

`enterSocial()`:

- `role === "host"` → `applyRoomFrame({ t: "hosted", … })` from `room_info`
  (urls/invite/code/port) and **return** (do not `room_close`).
- `role === "guest"` → `room_close` (socket is dead after reload) then idle UI.
- `idle` → idle UI as today.

`setMode(true)` when already Social is a no-op, so a live session is not
re-entered. Solo still `leaveRoom()` (user intent).

### N3 / N4 — cap + cycles

`MAX_GUESTS: usize = 16`. Existing `members.len() > MAX_GUESTS` check already
counts the host in `members`, so the 16th *guest* still fits (same arithmetic
as today’s 8). Rename `ninth_guest_is_refused` → `seventeenth_guest_is_refused`.

New Rust tests (same in-process harness, no app):

- 16 guests join; 17th `room_full` verbatim.
- After 16 are in: one `playback` and one user `chat` arrive on every guest
  socket (`recv_t` skip budget raised — 16 leftover frames is too small once
  the room is busy).
- Guest socket drop → later join with the same code succeeds (history +
  cached playback).

JS: cycle table for `shouldAutoRejoin` (already there) plus reducer
`hosted → bye → hosted` clears chat / invite between rooms.

`app/tests/live-scale.mjs`: hand-run, excluded from `npm test` by the
`*.test.mjs` glob. Desktop host + N node WebSocket guests (4 / 8 / 16).
Does **not** claim audio p95 from node clients (they have no playhead).

### N6 — probe honesty

`chatCount` = `.soc-chat-msg, .soc-chat-system` only.

### Latency (no protocol change)

Keep immediate `broadcastPlayback` on transport events. Do **not** drop the
tick below 250 ms in this pass. Do **not** add ping/pong unless a later live
run shows p95 > 100 ms.

### Role swap (product rule)

Host leaving still ends the room. Swap = Leave until `room_info.role ===
"idle"`, then the other device `room_open` / `room_join_uri`. Open/Join stay
disabled while `role !== "idle" || joining`.

---

## 5. How to complete this efficiently

Order chosen so each step is a green gate without a 10-minute Android rebuild:

1. **This doc** (done) + one-line pointer in `jam-upgrade.md` / CHANGELOG.
2. **Pure JS first** (`roomDisplayName` + tests) — milliseconds, TDD.
3. **Wire both `roomName()` + Settings copy + adopt-host** — no Rust compile.
4. **Rust cap + three tests** — `OP_OFFLINE=1 cargo test --lib room::` only,
   not the whole crate clippy until the end.
5. **Probe chatCount + `live-scale.mjs`** — files only; live run if `:9222`
   is already up.
6. **Gates:** `node --test app/tests/room.test.mjs` then `npm test` then
   `OP_OFFLINE=1 cargo test --lib room::` then fmt. Full clippy last.
7. **Live** (`live-desktop` / chat-conditions / reconnect) only if a
   `cargo build` binary is already running. If not, unit + Rust duplex is the
   campaign proof; live is recorded as not-run, not as a fake pass.

Do **not**: re-open D1–D5, rewrite `social.js` / `jam.js`, vendor a decoder,
or wait on the emulator for N1–N4.

---

## 6. Acceptance

| AC | Gate |
|---|---|
| Display name from Settings appears in `room_open` / `room_join_uri` `name` | `room.test.mjs` + static `tm-name` in both glues |
| Desktop Social adopts a live host; does not `room_close` it | static contract in `social-ui.test.mjs` |
| 16 guests in; 17th `room_full` | `cargo test room::` |
| Chat + playback fan-out to all 16 | same |
| Drop + rejoin same code | same |
| Leave / host-close → no auto-rejoin; lost socket → yes | existing JS table |
| Chat probe counts messages, not empty-state nodes | `live-chat-conditions.mjs` |
| `npm test` green, `cargo fmt --check` green, clippy `-D warnings` | end of campaign |

Live reconnect/host↔guest matrix: run when a debug app is up; otherwise the
Rust duplex + reducer tests are the reproducible gate.

---

## 7. Second pass (2026-10-09) — reconnect + tick + pause heartbeat

N1–N7 landed. Audit of connect / close / reconnect / host↔guest found three
**remaining** defects. Written before the code (rule 3).

| # | Gap | Why it hurts |
|---|---|---|
| **N8** | Every `chat` / `history` / `hosted` frame called `startHostTick()` / `startTick()`, which **clears and resets** the 250 ms interval | A chatty room delays the next playhead heartbeat by up to another 250 ms — the opposite of “0 latency” |
| **N9** | Mobile `hostTick` skipped broadcasts while paused (`if (key !== hostKey \|\| !st.paused)`) | If a pause listener is missed, guests keep playing until resume; desktop already heartbeats while paused |
| **N10** | Auto-rejoin only retried when `room_join_uri` **threw**. A spawn-then-dial failure arrives as an `error` frame (`connect_failed`) | First reconnect attempt that times out left the guest idle forever — “reconnect multiple times” was one-shot |
| **N11** | Failed first join left `lastJoinUri` set; mobile host-adopt invented `ws://127.0.0.1` urls | A later lost-socket `bye` could hammer a bad invite; QR fallback after reload was loopback |

### Design

- `roomTickKind(role)` → `"host"` / `"guest"` / `""`. Surfaces arm the interval **only when the kind changes**.
- Mobile `hostTick` = desktop: broadcast every tick while hosting (paused included).
- `error` while `wasJoining` **and** `shouldRetryJoinAfterError` (`attempts > 0`
  plus lost-socket rules): `scheduleRejoin()`. First-join failures (`attempts
  === 0`) clear `lastJoinUri` and stay idle — they must not start backoff.
- Both hosts listen for `ended` as well as play/pause/seeked (auto-advance is immediate).
- Mobile adopt copies `info.urls` like desktop.

Still not claimed: 0 ms RTT. Target remains **action → wire immediately**, tick 250 ms, p95 |drift| ≤ 100 ms.

---

## 8. Third pass (2026-10-09) — reconnect race + first-tick latency + chat-while-joining

N8–N11 landed. A reconnect/host-swap audit of the glue found three more defects
that unit tests of the *helpers* could not see — they live in how `error` /
`bye` / `room_close` compose.

| # | Gap | Why it hurts |
|---|---|---|
| **N12** | Join-error path always `invoke("room_close")`. `room_close` on `Mode::Guest` **emits `bye{reason:"left"}`**. The bye handler treats that as user Leave: clears `lastJoinUri` and **cancels** the rejoin timer. A slow close can also land *after* the next dial and `reduceRoom` a live `joined` session back to idle. | “Reconnect multiple times” dies on the first `connect_failed` or races the second attempt |
| **N13** | `shouldRetryJoinAfterError` ignored the error **code**. `bad_code` / `room_full` / `rate_limited` during a rejoin would hammer a dead invite | Host swapped rooms (new code) and the old guest kept retrying |
| **N14** | `setInterval(tick, 250)` does not fire immediately. Host/guest wait a full tick before the first heartbeat/apply | First playhead after join/open is 250 ms late — the opposite of “0 latency” on the action that just happened |
| **N15** | Chat while `joining` / reconnecting is `role === "idle"` → **device-local echo**. `joined` does not clear `chat`; if `history` is empty the local line rides into the real room (G5 class) | Fake messages in a room the server never saw |

### Design

- `shouldRetryJoinAfterError(..., errorCode)` is **`connect_failed` only**.
  Terminal join errors (`bad_code`, `room_full`, …) clear the invite and close.
- Retryable error: **do not** call `room_close`. `guest_run` already reverted
  to Idle before emitting `connect_failed`. Closing would emit `bye{left}`.
- `isStaleLocalBye(reason, userLeft, role)` — `bye{left}` while this window is
  already `host`/`guest` and the user did not Leave is a late cleanup; **drop
  it before `reduceRoom`**.
- `shouldKeepRejoinAfterBye` — cleanup `left` while a lost-socket rejoin is
  armed must not cancel the timer or wipe `lastJoinUri`.
- Host/guest ticks **run once immediately**, then every 250 ms.
- Chat send while `joining` or a rejoin timer is up: keep the text, toast
  “Still connecting”, no local echo.

Host↔guest swap stays M2: Leave until idle, then the other device opens. The
cycle must survive the N12 race so the second `room_open` is not refused.

Still not claimed: 0 ms RTT. Target: **action → wire on the same turn**, tick
250 ms, p95 |drift| ≤ 100 ms.
