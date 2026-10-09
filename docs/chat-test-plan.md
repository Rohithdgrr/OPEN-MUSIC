# Social chat — full-condition test plan & defect ledger

Spec of record for the 2026-10-08 "test chat in all ways, all conditions, all
platforms" campaign. Written **before** the fixes, per standing rule 3
(docs-first). Evidence is appended per stage as it lands; nothing here is
claimed until its gate is green.

Related: `docs/listen-together.md` (protocol + §5 chat), `ROOM.MD` (frozen
frame contract §3D), `docs/mobile/09-problems-solutions.md` (P24/P25/P31–P37).

---

## 1. Scope

Chat is one shared pipeline on every surface:

```
UI input → sendChat()/sendChatText() → invoke("room_chat") → room.rs
  → RoomCore::chat (trim/empty → too_long → rate limit → stamp → broadcast)
  → {"t":"chat",from,text,ts} → room://msg → room.js reducer → render
```

- Desktop: `app/src/index.html` chat pane + `app/src/social.js`
- Mobile (Android **and** iOS): `mobile/index.html` chat tab +
  `app/src/mobile/jam.js`
- Server: `app/src-tauri/src/room.rs` (`RoomCore::chat` room.rs:345-391,
  `room_chat` command room.rs:929-946)
- Reducer: `app/src/room.js` (pure, shared by both surfaces)

### Platform matrix (what "all platforms" honestly means here)

| Surface | How it is tested | Boundary |
|---|---|---|
| Windows desktop (WebView2) | live app + CDP `:9222` + real WS client | — |
| Android | live APK on emulator + CDP over adb | — |
| Cross-pair both directions | `live-lan-join.mjs` (real LAN), `live-reverse-pair.mjs` (Android host ↔ desktop guest) | — |
| iOS | same `mobile/index.html`/`jam.js`/7 commands + `ios.yml` CI | **No Apple hardware on this machine** — iOS is code-shared coverage, never claimed as a device run (environment wall, AGENTS.md) |
| Pure logic | `cargo test room::`, `room.test.mjs`, `social-ui.test.mjs`, `jam-ui.test.mjs` | no device needed |

---

## 2. Condition matrix (every row gets an assertion somewhere)

### A. Server conditions (`cargo test room::`)

| # | Condition | Expected (verbatim where quoted) | Gate |
|---|---|---|---|
| A1 | whitespace-only text | `empty` → "Message is empty." | `chat_rejects_empty_and_too_long_verbatim_at_the_500_boundary` |
| A2 | missing `text` field / non-string `text` | coerced to "" → `empty`, no panic | same test |
| A3 | exactly 500 scalar chars | **accepted**, broadcast | same test |
| A4 | 501 scalar chars | `too_long` → "Message too long (max 500 characters)." | same test |
| A5 | 501 astral emoji (4-byte UTF-8) | counted as scalars, not bytes → `too_long` | `astral_emoji_count_as_one_character_each` |
| A6 | rejections consume no rate budget | 5 × too_long then a valid send still passes | A3 test |
| A7 | wire `from` spoofing | ignored; server stamps member id/name | `sender_identity_is_stamped_by_the_server_not_the_wire` |
| A8 | malformed JSON frame | dropped **silently**, connection survives | `malformed_and_unknown_frames_do_not_kill_the_connection` |
| A9 | unknown frame type | `unknown_message_type`, connection survives | same test |
| A10 | rate limit 5/10 s per member | 6th → `rate_limited` verbatim (pre-existing) | `two_guests_presence_chat_and_rate_limit` |
| A11 | history cap 50, replay on join | pre-existing | `history_replays_to_late_joiners_and_caps` |
| A12 | host command path returns A1/A2/A4 synchronously | `Err` straight from `room_chat` | `host_command_path_surfaces_validation_errors_synchronously` |

### B. Reducer + static conditions (`npm test`)

| # | Condition | Gate |
|---|---|---|
| B1 | error frames verbatim byte-for-byte | `room.test.mjs` (pre-existing) |
| B2 | validation refusals (`empty`/`too_long`/`rate_limited`) surface verbatim with code | `room.test.mjs` "server chat-validation errors arrive verbatim with their code" |
| B3 | `mine` flag from `selfId`, history replaces, bye clears | `room.test.mjs` (pre-existing) |
| B4 | rendering is `textContent`-only (XSS safety), no sockets on either surface, id contracts | `social-ui.test.mjs`, `jam-ui.test.mjs` (pre-existing) |
| B5 | mobile module graph boots incl. `jam.js` | `mobile-boot.test.mjs` (pre-existing) |

### C. Desktop live conditions (real app, CDP + real socket)

| # | Condition | Expected |
|---|---|---|
| C1 | baseline relay both directions, paint-once, input cleared, RTT <250 ms | `live-desktop.mjs` 32 checks |
| C2 | empty/whitespace send from UI | no IPC, input untouched, no bubble |
| C3 | 500-char UI send | accepted, painted once |
| C4 | 501-char UI send (host path, sync error) | verbatim toast **and text restored to input** |
| C5 | XSS payload (`<img onerror>`) | literal text, no element execution |
| C6 | emoji/RTL/newlines | render intact, no layout escape |
| C7 | 6 rapid UI sends | 6th refused verbatim; first five painted exactly once each |
| C8 | late joiner | `history` replay (≤50) matches what was sent |
| C9 | no-room local echo | bubble on device only, no IPC |
| C10 | leave/`bye` | chat wiped, empty state returns |
| C11 | Enter key + send button + quote-lyric | all three paths send/quote |
| C12 | guest→host line | painted exactly once (covered in C1) |

### D. Android live conditions (real APK)

| # | Condition |
|---|---|
| D1 | baseline relay both directions, paint-once, `jamChatState` count — `live-android-emulator.mjs` 28 checks |
| D2 | quick-reaction emoji buttons (🔥 ❤️ 🎵 👏 ⚡) send + echo |
| D3 | Enter-key send |
| D4 | send failure → toast **and typed text retained** (parity with desktop C4) |
| D5 | chat tab hidden in Solo (P25 regression) |
| D6 | no-room → local echo + toast "Not in a room — the message stayed on this device" |
| D7 | XSS payload renders as text on mobile |
| D8 | late joiner history on device |

### E. Cross-pair conditions

| # | Direction | Gate |
|---|---|---|
| E1 | desktop host ↔ LAN guest (real LAN IP, no tunnels) | `live-lan-join.mjs` chat both ways |
| E2 | Android host ↔ desktop guest | `live-reverse-pair.mjs` chat both ways (D4/D5 regressions ride along) |

### F. Implemented this campaign — system join line

User decision 2026-10-08: **implement**, don't reword the doc
(`listen-together.md:226` promises "a system line in chat says who joined").

| # | Condition | Expected |
|---|---|---|
| F1 | guest joins | every member (host + existing guests + joiner) sees one system line: *"<name> joined"* — **once**, not duplicated by presence |
| F2 | guest leaves / disconnects | one system line: *"<name> left"* |
| F3 | history replay | system lines are ordinary history entries — a late joiner sees the ones it missed (within the 50-frame cap) |
| F4 | not a user message | system lines carry no sender stamp, never count toward any rate budget, cannot be sent by any client frame (server-origin only) |
| F5 | hostile name | the name inside a system line went through `sanitize_name` (24 chars, control chars stripped) |
| F6 | reducer purity | system entries reduce like any chat entry — no reducer mutation, `mine` is false |
| F7 | both surfaces render it | desktop + mobile style it as a system/centered line (not a user bubble); `textContent`-only |
| F8 | host's own room-open | no self-"joined" line for the host opening the room (the host was always there); first line appears when the first guest joins |

**Design constraints** (server is the only place a system line may originate):
- Emitted from `RoomCore` join/remove paths only — never parsed from wire text.
- Frames are `{t:"chat", system:true, text:"…", ts}` — reuses the existing
  reducer branch (B6: reducer stores it, `mine:false` because `from` is absent)
  so neither surface needs a new frame type; renderers key on `system`.
- `HISTORY_CAP` still applies; system lines share the 50-frame budget (documented
  trade-off: a chatty room may evict older user lines first — acceptable).
- Rate limit untouched: `RoomCore::chat` is for members; system lines bypass it
  by construction (they don't call it).

### G. Known-defect fixes riding this campaign

| # | Defect | Evidence | Fix |
|---|---|---|---|
| G1 | Desktop chat header claims **"LOCAL ONLY"** + empty state "local until the sidecar connects" **while a real room is relaying** | `index.html:1633`, `index.html:1638`; copy predates the room relay (sidecar era) | live-relay copy; `social-ui.test.mjs` asserts these ids exist, text change must keep them green |
| G2 | Mobile **loses the typed message** on send failure; desktop restores it | `jam.js:842` clears before `invoke`, `.catch` only toasts (jam.js:833-835) vs `social.js:762` restores | restore text in mobile `.catch`, same as desktop |
| G3 | No `maxlength` on either input — 501 chars only fails after the round trip | `index.html:1646`, `nowplaying.html:292` (no attribute) | `maxlength="500"` on both; server stays authoritative (A3/A4 still tested) |
| G4 | System join line missing (F above) | `listen-together.md:226` vs grep-negative | implement per §F |
| G5 | Device-local echo (sent while no room) **survives into a new room** — host sees a line the server never relayed; guests don't | sweep 2026-10-08: `count("device local line")==1` after `btn-open-room`; reducer `hosted` case never touches `chat` (`room.js`), desktop `openRoom` applies `hosted` on top of the local-echo state | clear `chat` (and repaint) when a room opens — the server's history starts empty, so the local echo was never part of it |
| G6 | Desktop **empty-state node is destroyed by the first render** — `renderChat` does `list.replaceChildren()` (`social.js:253`) while `#chat-empty`/`#chat-typing` are *children of that list* (`index.html:1638-1639`); the toggle at `social.js:254` then finds null and can never fire → no empty state after any render, incl. after leave | sweep 2026-10-08: `G6: empty-state node survives renderChat :: DESTROYED`; live DOM probe `{"empty":false,"typing":false}`; mobile rebuilds its empty state each paint (`jam.js:572-579`) so desktop-only | keep empty/typing outside the replace (re-insert or render them as part of the list build), then `C10: empty state visible` turns green |

Anything C/D/E turns up gets a new row here **before** its fix.

### H. Test-side defects found by the 2026-10-09 full re-run

Neither is a product defect — both were proven by driving the real app (row
"H proof"). They exist because the F system line landed *after* these tests
were written, and because a broadcast fan-out was never drained.

| # | Defect | Proof it is the test, not the product | Fix decision |
|---|---|---|---|
| H1 | `live-harness.mjs` `guest.await(t)` is `frames.find(f => f.t === t)` — it scans from frame **0**, so the F1 *system join line* (`{t:"chat", … "Node Guest joined"}`) received during the handshake shadows the echo the probe just asked for. `live-desktop.mjs:76` and `live-android-emulator.mjs:220` therefore fail deterministically (3/3 runs on desktop, 1/1 on Android) with `echo in 32ms` while the message itself round-trips fine; the companion `rtt < 250` check passes **vacuously** off the stale frame | both probes still assert `chat pane painted the guest line exactly once` / `host painted the guest line exactly once` and pass; `live-scale` delivers chat to 4/4·8/8·16/16; the handshake `kinds` string already lists `chat` **before** the send | **FIXED (working tree):** both probes now poll for *their own text* (`f.t==="chat" && /node guest/i.test(text) && !f.system`) inside a 3 s window, so `rtt` measures the real echo. Landed by a concurrent session editing the same files 2026-10-09; this session's duplicate helper was reverted rather than stacked on top |
| H2 | `room.rs::system_lines_never_touch_the_rate_budget_and_cannot_be_spoofed:1677` reads Bob's *first unread* `chat` frame, but Bob never drained Ann's 5 rate-budget broadcasts — it always gets `"m0"` instead of the spoof (3/3 deterministic, `left: "m0" right: "fake system"`), so the last three F4 assertions never run | live F4 probe (raw socket against the real app): spoofed `system:true` relayed as an ordinary message `{from:{id:"g1",name:"Spoof Probe"}}` with **no** `system` key, wire `from` ignored, malformed + unknown frames survive, exactly one server-origin own-join line — **9 pass / 0 fail** | **FIXED (working tree):** `recv_matching(…, |v| v["text"] == "fake system")` — select by text, not type. Same concurrent session, same approach as planned here |
| H3 | `live-chat-conditions.mjs` ran **34 pass / 13 fail** once, chained after `live-desktop.mjs` while the emulator was cold-booting; the same chain re-run later gave **47/47** twice | first divergence was `G5: device-local echo … :: 1`, and `501 chars: text restored … :: 545` = the 501-char payload **plus the 44-char lyric quote** — an async `btn-chat-quote` handler landing late under load, then cascading | no code change; **known flake**. Treat a red sweep as red only after a re-run on an idle machine |

### Stage 7 — fix decisions (written before the first edit)

| Row | Decision |
|---|---|
| G1 | `index.html:1633` chip keeps `LOCAL ONLY` as its idle/boot value, but `paintRoom()` now repaints it per role: idle → `LOCAL ONLY` (title: no room open — messages stay on this device), host/guest → `5 / 10s` (title: room chat, max 500 chars, 5 messages every 10 seconds). `index.html:1638` empty copy → idle default *"No messages yet — open or join a room to chat."*; `renderChat()` sets it per role (in-room: *"No messages yet. Say something."*) — byte-identical to mobile `jam.js:575-577` |
| G2 | mobile `sendChat()` passes the original text into `sendChatText(text, restore)`; the `.catch` restores `jamChatInput.value` before toasting (desktop `social.js:768-771` parity). Reaction buttons call without a restore arg — their text never came from the input |
| G3 | `maxlength="500"` on `#chat-input` (`index.html:1646`) and `#jamChatInput` (`nowplaying.html:292`). Server stays authoritative — the attribute only skips pointless round trips; probes set `.value` programmatically (maxlength does **not** truncate that), so the 501-char server-path tests still exercise A3/A4 |
| G4/F | server-origin only: `RoomCore::join` / `RoomCore::remove` construct `{"t":"chat","system":true,"text":"<name> joined|left","ts":…}` directly — never through `chat()` (no rate stamps, no `from`), pushed to history (F3) and broadcast (F1/F2). Join order: welcome → member push → **join line** → presence → refresh (existing tests that skip frames still land on `presence` where they expect it). `serve_conn`'s chat arm reads only `text`, so a client's `system:true` never reaches the wire (F4). Host open emits nothing (F8). Name = stored `sanitize_name` output (F5). Reducer passes `system` through; renderers draw a centred `.soc-chat-system` / `.chat-system` line, textContent-only (F7) |
| G5 | reducer `hosted` case returns `chat: []` (the server's history starts empty — a device-local echo was never part of it). Desktop `applyRoomFrame` gains `renderChat()` in the hosted/joined arm so the clear reaches the DOM; mobile already repaints via `paintJam() → paintChat()`. `joined` needs no clear: the `history` frame that follows replaces the list wholesale |
| G6 | `renderChat()` captures `#chat-empty`/`#chat-typing` before `replaceChildren()` and re-inserts them first, then appends messages — markup/CSS untouched. Probe C10's `chatCount()` therefore changes to count `.soc-chat-msg` rows only (empty+typing now legitimately survive) |

The desktop probe also gains F1/F2/F7/F8 rows (mobile already carries F1/F2/F7);
F3/F4/F5 get Rust tests in `room.rs`.

---

## 3. Execution order

1. ✅ Stage 0 — build lock free (other session's cargo gone)
2. ✅ Stage 1 — A1–A12: `cargo test room::` **18 pass / 0 fail**
3. ✅ Stage 2 — B1–B5: `npm test` **250→251 pass / 0 fail** (B2 added);
   `cargo fmt --check` clean
4. ✅ Stage 3 — C1–C12 desktop live: `live-desktop.mjs` **32/0** (C1) +
   `live-chat-conditions.mjs` **41 pass / 6 fail** (C2–C11) — 6 fails all
   mapped to ledger rows G1/G3/G5/G6; no unmapped condition failures. Probe
   bugs fixed mid-sweep: Phase-0 leave order (Leave also flips to Solo), stale
   toast drain before C2, substring history matching, non-vacuous G1 copy check
5. ✅ Stage 4 — D1–D8 Android live: `live-android-emulator.mjs` **28/0** (D1,
   after harness invite fix) + `live-chat-conditions-android.mjs`
   **29 pass / 7 fail** (D2–D8) — fails all ledger-mapped: G3 maxlength
   (mobile too), G5 echo survives (shared reducer), **G2 typed text lost on
   failure (mobile-only, desktop restores)**, F1/F2/F7 = G4 not yet
   implemented. G6 confirmed **desktop-only** (mobile rebuilds its empty
   state each paint — empty-after-leave passes on device)
6. ✅ Stage 5 — E1–E2 cross-pair: `live-lan-join.mjs` **14/0** (real LAN,
   no tunnels — chat both ways, playback follow ±0.14s, rejoin-after-bye OK) ·
   `live-reverse-pair.mjs` **19/0** on re-run (chat both ways, D4 pause/resume
   broadcast, D5 revert+rejoin). First E2 run was 17/2 — D4 pause flaked
   once with a remember-position track (host resumed at t≈31.9s, guest
   t≈35.1s kept playing); passed with a fresh track (t≈0.6s). Watch item:
   playback-follow pause + `tm-remember-pos` interplay — not a chat defect
7. ✅ Stage 6 — iOS: code-shared coverage only (same `mobile/` shell +
   `jam.js` + 7 Rust commands; `ios.yml` CI builds) — **no Apple hardware on
   this machine**, never claimed as a device run (platform matrix above)
8. Stage 7 — G1–G6 fixes (docs-first done: this file), then **re-run every
   gate the fix touches**
9. Stage 8 — final sweep: `npm test` · `eslint` · `cargo fmt --check` ·
   `cargo clippy --all-targets -- -D warnings` · `OP_OFFLINE=1 cargo test --lib`
   · re-run touched live harnesses · evidence appended below · AGENTS.md entry

## 4. Evidence log

*(appended as stages complete — each row: date, gate, result, how measured)*

| Date | Gate | Result |
|---|---|---|
| 2026-10-08 | `cargo test room::` (18 tests, +8 new this campaign) | **18 pass / 0 fail** |
| 2026-10-08 | `npm test` (+1 new reducer test) | **251 pass / 0 fail** |
| 2026-10-08 | `cargo fmt --check` | clean |
| 2026-10-08 | `live-desktop.mjs` (C1 baseline, running app + real socket) | **32 pass / 0 fail** — chat echo 29 ms |
| 2026-10-08 | `live-chat-conditions.mjs` (C2–C11 sweep, real app + real socket) | **41 pass / 6 fail** — PASS: whitespace no-op, idle local echo, quote button, 500/501 boundary + verbatim toast + restore, XSS literal, unicode verbatim, Enter send, 5-per-10s burst + 6th verbatim rate-limit, history replay (order + cap + rejects absent), guest→host paint-once, 2-online, leave wipes list. FAIL (all ledger): G3 maxlength `-1`, G5 stale local echo (×2), G6 empty node DESTROYED (×2), G1 `LOCAL ONLY` chip in live room |
| 2026-10-08 | `live-android-emulator.mjs` (D1 baseline, real APK + adb-forwarded guest) | **28 pass / 0 fail** — handshake joined+history+presence, chat echo 30 ms LAN-grade, host UI 2 members, guest refused verbatim, invite **canonical `trancemusic://join?…`** (harness updated post-`c994fae` to accept canonical + legacy, extracts `port=`) |
| 2026-10-08 | `live-chat-conditions-android.mjs` (D2–D8, new probe, real APK) | **29 pass / 7 fail** — PASS: D5 chat tab hidden Solo + after leave, D6 local echo + honest toast, 5 reactions painted once, D3 Enter send, D7 XSS literal (no element, handler never ran), D4 verbatim too_long toast, D8 late-joiner history (order, cap, rejects + device-local lines absent), guest→device paint-once, room closed + chat wiped + empty state visible. FAIL (all ledger): G3 maxlength `-1`, G5 echo survives (shared reducer — mobile too), D4/G2 typed text lost (`len=0`; mobile-only defect — desktop restores), F1 join line ×2 + F2 leave line + F7 system styling (G4 not implemented) |
| 2026-10-08 | `live-lan-join.mjs` (E1, desktop host ↔ emulator guest, **real LAN**, no adb tunnels) | **14 pass / 0 fail** — room advertises `ws://10.96.197.104:8787`, device `nc` RC=0, join sheet → host sees 2 online, chat both ways rendered, playback follow drift ±0.14s, host bye → guest idle chrome + **rejoin to a fresh room works** |
| 2026-10-08 | `live-reverse-pair.mjs` (E2, Android host ↔ desktop guest) | **19 pass / 0 fail** (re-run) — chat both ways, D4 pause/resume broadcast, D5 backend revert + rejoin. First run 17/2: D4 pause flaked with a remember-position track (host `t≈31.9` resumed, guest `t=35.1` kept playing); isolated repro with correct transport (adb forward + `127.0.0.1` join) showed clean pause in <800ms, drift ±0.00s — flake, watch item, not a chat defect |
| 2026-10-09 | Stage 8 full re-run — `npm test` (all unit/static) | **275 pass / 0 fail** |
| 2026-10-09 | Stage 8 — `OP_OFFLINE=1 cargo test --lib` | **199 pass / 1 fail** — the one fail is **H2** (`system_lines_never_touch_…`, test reads an undrained broadcast); product F4 proven by the live probe below |
| 2026-10-09 | Stage 8 — `live-chat-conditions.mjs` (C2–C11, clean app process) | **47 pass / 0 fail** — every G row now green (G1 chip `5 / 10s`, G3 `maxlength=500`, G5 echo wiped + empty state visible, G6 empty node present), plus 500/501 boundary, XSS literal, unicode, Enter, 5-per-10s burst, history order + rejects absent, leave wipes |
| 2026-10-09 | Stage 8 — `live-chat-conditions-android.mjs` (D2–D8 + F rows, rebuilt APK) | **36 pass / 0 fail** — supersedes the 29/7 pre-fix row: G3, G5, D4/G2 all green, and F1 join line (×2 assertions), F2 leave line, F7 system styling now pass |
| 2026-10-09 | Stage 8 — `live-scale.mjs` | **18 pass / 0 fail** — fan-out N=4/8/16 all green (chat + playback), 17th guest `room_full` verbatim, drop/rejoin, close/reopen |
| 2026-10-09 | Stage 8 — F4 live probe (raw socket → real desktop app) | **9 pass / 0 fail** — see H2 proof |
| 2026-10-09 | Stage 8 — `live-lan-join.mjs` (E1, real LAN) | **14 pass / 0 fail** |
| 2026-10-09 | Stage 8 — `live-reverse-pair.mjs` (E2) | **19 pass / 0 fail** |
| 2026-10-09 | Stage 8 — `live-desktop.mjs` / `live-android-emulator.mjs` | **31/32** and **27/28** — the single fail in each is **H1** (harness reads the stale system join line), reproduced 2/2 on desktop and 1/1 on Android; every other check passes on both surfaces |
| 2026-10-09 | post-fix full re-run (Stage 7/8 — G1–G6 were already in-tree; this session's edits were all TEST-side, see below) | **all green**: `npm test` 275/0 · `eslint` clean · `cargo fmt --check` clean · `cargo clippy --all-targets -D warnings` clean · `cargo test --lib` **200/0** (`room::` 28/0) · `live-desktop.mjs` **32/32** · `live-chat-conditions.mjs` **50/50** (C2–C12 + new F1/F2/F8 + G1/G3/G5/G6) · `live-scale.mjs` **18/18** (N=16 fan-out, 17th refused `room_full`, drop/rejoin, close→reopen) · `live-android-emulator.mjs` **28/28** · `live-chat-conditions-android.mjs` **36/36** (D2–D8 + F1/F2/F7 + G2/G3/G5) · `live-lan-join.mjs` exit 0 (real LAN, chat both ways, follow ±0.03s, bye→rejoin) · `live-reverse-pair.mjs` exit 0 (19 checks, D4 pause/resume + D5 revert/rejoin) |
| 2026-10-09 | test-side fixes this session (no product code touched) | `room.rs` F4 test: `b` never drained `a`'s 6 `m0..m5` broadcasts, so `recv_t(b,"chat")` returned stale `m0` — now `recv_matching` on the spoof text (server path `room.rs:643` reads only `text`, verified correct) · `live-desktop.mjs` + `live-android-emulator.mjs`: first `chat` frame on a fresh join is now the F1 system line — match our text instead of the first frame · `live-chat-conditions.mjs` Phase 0: engage Social BEFORE leaving (Jam pane incl. Leave is not in the Solo DOM — old order clicked a null button, silently reused the stale room and poisoned G5 + history order + device-local leak); added plan-mandated F1/F2/F8 rows (desktop probe never had them) |
| 2026-10-09 | jam hardening session (lifecycle + follow gate + badge + shared queue — fresh release exe + fresh debug APK) | **all green**: `npm test` 277/277 · `eslint`/`fmt`/`clippy -D warnings` clean · `cargo test --lib` 201/201 (`room::` 29/29, incl. queue cap/replay/refusal test) · `live-desktop` 32/32 · `live-chat-conditions` **53/53** (C/F/G + 3 new unread rows) · `live-scale` 18/18 · `live-android-emulator` 28/28 · `live-chat-conditions-android` **39/39** (D/F/G + 3 new unread rows) · `live-lan-join` exit 0 (real LAN + 3 new shared-queue rows: header, rows, update-on-next, now-playing excluded) · `live-reverse-pair` exit 0 · screenshots: desktop `Live Chat ● 2` pill + 💬 toast, device `HOST'S QUEUE · READ-ONLY` with host rows |
| 2026-10-09 | **independent verification of `85529db`** (second session, fresh x86_64 debug APK 14:25 installed on `Pixel6_API36` + debug exe 14:04 with CDP) | **all green**: `npm test` 277/277 · `eslint` clean · `cargo test --lib` 201/0 · `live-chat-conditions` 53/53 · `live-desktop` 32/32 · `live-scale` 18/18 · `live-android-emulator` 28/28 · `live-chat-conditions-android` 39/39 · `live-lan-join` exit 0 (host-bye → rejoin OK) · `live-reverse-pair` exit 0 (D5 revert + rejoin both directions) — reproduces the row above on independent hardware/time; watch item: one transient `live-desktop` 18 pass / 14 fail immediately after a rebuild under load, not reproduced in 3 clean runs |
| 2026-10-09 | queue wire probe (temp, raw guest socket → real desktop app; `85529db` shared queue) | **9 pass / 0 fail** — late joiner gets cached replay (3), live guest sees update (5), entries carry id/title/artist, guest `queue` frame refused `not_host` verbatim + snapshot unchanged, server caps at 10 (both 15-track and 11-track pushes land ≤10 on the wire) |

## 5. What this plan deliberately does NOT claim

- **No iOS device run** — no Apple hardware here; iOS coverage is the shared
  mobile shell + `ios.yml`. Stated in every report.
- **No NAT-traversal / relay chat** — rooms are LAN-only (§7 of
  `listen-together.md`); "works offline" means the documented local echo.
- **No typing indicators** — `#chat-typing` is decorative-hidden by contract
  (`social-ui.test.mjs`), no typing protocol exists.
- **No message persistence** — history lives in room RAM; a closed room loses
  it. Reload during a guest session drops chat (documented, not a defect).
