# Jam (Listen Together) — defects D1–D4: issue and solution

**Status: FIXED 2026-10-07 — D1, D2, D3, D4 all implemented and verified on a
real desktop ↔ real Android pairing** (see *Implementation* at the bottom of
this file for the diff, the reproduce steps and the measured results).
Evidence that drove the diagnosis lives in `docs/listen-together.md` §13.6
(desktop host ↔ Android guest) and §13.7 (Android host ↔ desktop guest), with
short forms in `docs/mobile/09-problems-solutions.md` P31–P34 and
`incomplete-jam.md` §1.2.

| # | Issue | Severity | Surface |
|---|---|---|---|
| D1 | Mobile guest resolves the host's track from the queue only → `NOT ON THIS DEVICE`, locked transport, guest keeps playing its own audio | **High** — this is the user's reported symptom | `mobile/jam.js` |
| D2 | A failed join latches `Mode::Guest` → every later join refused until app restart | **High** — one bad address bricks the feature | `src-tauri/src/room.rs` |
| D3 | Mirror note and `Synchronized` badge go stale (§8 truthfulness) | Medium — UI claims a sync that stopped | `mobile/jam.js` (+ symmetric risk in `social.js`) |
| D4 | Android host never broadcasts a **pause** → guests keep playing while the host is paused | **High** — inverts "the host controls playback" | `mobile/jam.js` |

---

## D1 — the mobile resolve list is narrower than the desktop's

### Issue

The guest can only follow a track it can find locally. The two surfaces do not
look in the same places:

| | Sources searched |
|---|---|
| Desktop `social.js:328 findLocalTrack()` | live queue first, then `localTracks()` (`social.js:783`) = play history (`loadPlays`), favourites (`loadFavs`), vault entries |
| Mobile `mobile/jam.js:398 followGuest()` | `queueHistory()` + current track + `queueUpNext()` **only** (`:400-404`) |

Any host track that is favourited, downloaded or played before — but not
sitting in the phone's current queue — is declared `Host is on "…" — not on
this device` (`jam.js:407`), `room_report` is never sent, and the transport
stays locked by design (§12). The guest then plays its own audio for the rest
of the room: "controls locked, nothing responds, only chat works."

**Seen (live, room `#5BTQDYZM`):** 0 of 3 host tracks resolved on the phone;
2/2 resolved the moment the id happened to be in queue/history — follow, play
and `±0.04s` drift reporting all worked in that case. The desktop guest in the
reverse run took the same §4.5 mirror path, but its wider list meant it
followed far more often.

### Solution

Broaden `followGuest`'s candidate list to the same three extra sources the
desktop uses, keeping queue order first (queue → plays → favourites → vault):

- plays and favourites are already on mobile: `load(PLAYS_KEY, [])` and
  `load(FAVS_KEY, [])` with keys exported at `mobile/shared.js:54` and `:53`.
- vault rows: `VAULT_IDS_KEY` (`mobile/shared.js:288`) — include a row only if
  it carries both an id and a title, the same filter desktop applies at
  `social.js:802` (`t && t.id && t.title`), so id-only rows cannot be handed to
  `playList`.
- the "not found" branch (`:406-409`) and its §4.5 wording stay exactly as they
  are — after the broadened search they mean "genuinely not on this device".

Deliberately **not** chosen: the smaller alternative (keep queue-only and say so
in the guest UI). Broadening is the smaller behavioural surprise and reuses the
desktop's proven semantics; the UI-text variant remains the fallback if mobile
cannot source full track objects for the vault rows.

**Done when:** with a desktop host playing a track the phone has favourited or
downloaded but not queued, the phone follows — title switches, audio plays,
badge shows drift, `room_report` flows.

---

## D2 — a failed join bricks the backend until restart

### Issue

`room.rs:787 room_join` writes `Mode::Guest { tx }` at line 808 **before** the
socket connects. `guest_run` (`room.rs:589`) then has three early exits that
send an `error` frame and `return` without touching the mode:

| Exit | Line |
|---|---|
| connect timed out (8 s) | `:598-604` |
| connect error | `:605-611` |
| join frame could not be sent | `:615-625` |

`Mode::Idle` is written only by `room_close` (`room.rs:881`) and at init
(`:698`). The UI resets itself to Solo on that `error` frame
(`mobile/jam.js:285-289`, desktop `social.js:423-428`) and never calls
`room_close`, so `room.rs:796` answers every later attempt with *"Leave the
current room before joining another."* — a room the UI says does not exist.
Only an app restart recovers (`initJam`'s boot `room_info` → `room_close`,
`jam.js:736-741`).

**Seen (twice):** `room_info` returned `{role:"guest"}` while the banner read
`SOLO`; an explicit `room_close` made the same join succeed first try. Trigger:
any unreachable address — wrong IP, host app closed, firewall, port not
listening.

### Solution

Two independent layers, both small:

1. **Backend (the root cause).** Give `guest_run` the mode handle it currently
   lacks (the same `Arc<Mutex<Mode>>` that `room_join` locks) and revert to
   `Mode::Idle` in each of its three failure exits, *before* the `error` frame
   is sent, so the state and the frame agree. Because `guest_run` runs as a
   task without `TauriState`, the handle is passed in as an argument at the
   spawn site — no new type, no new channel.
2. **UI (belt and braces).** When an `error` frame arrives while `joining` is
   true, call `invoke("room_close")` before painting Solo on both surfaces.
   This covers server-side refusals (wrong code, room full) that arrive over an
   already-connected socket and therefore never pass through layer 1.

**Done when:** join to a dead address → error toast → a second join to a live
room succeeds immediately, with `room_info` reading `idle` in between; a wrong
room code behaves the same way.

---

## D3 — stale mirror note and stale `Synchronized` badge

### Issue

Truthfulness rule §8 requires the UI to stop claiming what it is not doing.
Two counters outlive the thing they describe (`mobile/jam.js`):

- `mirrorNote` is cleared only on a **successful** resolve (`:411`) or on leave
  (`:233`). The fast path — a frame whose id already equals the local track —
  returns at `:369-377` without clearing it.
- `appliedFrames` (the counter that unlocks the "Synchronized" badge) and
  `lastDrift` are never reset when a frame cannot be applied.

**Seen:** the guest showed `NOT ON THIS DEVICE` **while** the badge read
`Synchronized ±0.04s`; afterwards the badge and `±0.00s` lingered although no
frame was being applied.

Symmetric risk on desktop (static only, not reproduced this run):
`guestMirror` is set at `social.js:340` and cleared at `:344`/`:432`/`:479`/
`:496`, but `guestTick`'s same-track fast path (`:361-384`) does not clear it
either.

### Solution

- In `guestApply`'s fast path (local track already equals `pb.trackId`): clear
  `mirrorNote` — the guest *is* on the host's track, so the note is false.
- In `followGuest`'s not-found branch (`:406-409`): reset `appliedFrames = 0`
  and `lastDrift = null` before painting, so the badge vanishes in the same
  frame that stops the sync.
- Apply the same two lines on desktop (`guestTick` fast path clears
  `guestMirror`; `followHostTrack`'s not-found branch clears `guestApplied` /
  `lastDrift`).

**Done when:** host moves to an unresolvable track → within one frame only the
mirror line is shown and the badge is gone; host returns to a resolvable track
→ the badge reappears only after a frame that was actually applied.

---

## D4 — the Android host never broadcasts a pause

### Issue

`hostTick` (`mobile/jam.js:342`) returns at line 346 on
`if (!t || !t.id || st.paused) return;` — **before** the drift/key checks that
its own comment (`:338-341`) says are there to "catch play, pause, track
changes and seeks". So while the host is paused nothing is ever sent.

Mobile also has no event-driven fallback where the desktop has one:

| | `broadcastPlayback()` call sites |
|---|---|
| Desktop `social.js` | `:317` 1 s tick, `:401` refresh, `:696` title MutationObserver, `:704` `play`/`pause`/`seeked` listeners — all registered at boot by `wireReactions()` (`:884`) |
| Mobile `jam.js` | `:263` refresh, `:354` hostTick — **no audio listeners, no title observer** |

Consequences: (a) guests keep playing while the host is paused; (b) a track
change or seek made **while paused** is withheld until playback resumes;
(c) resume self-heals, because the key/drift mismatch fires on the next tick —
which is why only the pause window is visibly wrong.

**Seen (room `#MPXYBD5L`):** host paused at audio t=136 (icon `play_arrow`)
while the desktop guest kept playing at t=141 and still reported `±0.06s`. The
guest would have paused (`social.js:371-372` applies `playing:false` for the
same track), and the *small* drift is itself the proof the cached frame still
read `playing:true` — a frozen `positionMs` with `playing:false` would have
made `syncDecision`'s expected position stand still and the drift grow.

### Solution

Two changes, both in `mobile/jam.js`:

1. **Reorder `hostTick`** so the key is checked before the pause guard: build
   `` `${t.id}|${paused ? "paused" : "playing"}` `` and compare with `hostKey`
   first; on mismatch call `broadcastPlayback()` and return. Only then apply the
   `st.paused` early-return (there is no playhead to correct while paused), and
   then the existing drift check. This alone fixes pause, resume and
   track-change-while-paused within one tick (`TICK_MS = 1000`, `jam.js:38`).
2. **Wire `play`/`pause`/`seeked` on the shell `<audio>` once in `initJam`**
   (`:718`), each guarded by `room.role === "host"` — desktop parity, so a pause
   reaches guests immediately instead of within ≤1 s, and a seek while paused is
   covered too (the reordered tick cannot see a paused seek).

**Done when:** the phone hosts and a second device joins; the phone pauses →
the guest pauses within one tick; a seek on the paused host moves the guest's
playhead; on resume both sides report drift again.

---

## Regression gate for all four

The fix batch is only done when a permanent assertion covers it — the two
existing live harnesses (`app/tests/live-desktop.mjs`,
`app/tests/live-android-emulator.mjs`) each cover one app plus a *synthetic*
second client, which is exactly how D4 stayed invisible.

New gate: one desktop-host ↔ Android-guest run **and** one Android-host ↔
desktop-guest run, asserting:

1. follow when the guest has the track (badge + drift reported), mirror when it
   does not (D1);
2. **host pause → guest pause**, host resume → drift returns (D4);
3. mirror note and badge agree at all times — no `NOT ON THIS DEVICE` beside a
   `Synchronized` badge (D3);
4. join to a dead address, then a successful join without restarting the app
   (D2).

Plus the standing static gates: `npm test`, `npm run lint`,
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`OP_OFFLINE=1 cargo test --lib`.

**Documentation contract:** this file is the spec. **Fulfilled 2026-10-08:**
the "not yet fixed" markers in `docs/listen-together.md` (§12 D1/D4 notes,
§13.6, §13.7), `docs/mobile/09-problems-solutions.md` (P31–P34) and
`incomplete-jam.md` (§0, §1.2) have been flipped to FIXED pointing here, with
fix notes recorded inline.

## Explicitly out of scope

- Physical LAN between two machines (`docs/listen-together.md` §10).
- M1 protocol additions (a queue frame so guests can append to the room queue).
- Live re-verification of a *desktop* host pausing — its listener path
  (`social.js:702-706`) is static evidence only.

---

## Implementation (2026-10-07)

All four ship together, because D1 and D3 are the same code path (a guest that
cannot resolve) and D2's UI half is the frame handler D4 writes into.

| # | Change | File |
|---|---|---|
| D1 | `followGuest` is now `async` and searches queue → plays → favourites → vault. The vault comes from `invoke("list_downloads")` on the miss path only: `tm-vault-ids` holds ids and nothing else, while the Rust ledger's rows carry `id/title/artist/image/duration_secs`. Same `t.id && t.title` filter desktop `localTracks()` applies, and `String()`-compared ids (the two surfaces can disagree on number vs string) | `app/src/mobile/jam.js` |
| D2 | **Backend:** `guest_run` takes its own `mpsc::UnboundedSender` and, in each of the three failure exits, re-reads `AppHandle::try_state::<RoomState>()` and writes `Mode::Idle` **before** the `error` frame goes out. The revert is guarded by `same_channel(&own_tx)`, so a task that timed out 8 s ago cannot blank a room opened since. **UI:** the `error` branch of `applyFrame` calls `invoke("room_close")` when the frame arrived while `joining` — that covers a refusal delivered over an already-connected socket (wrong code, room full), which never passes through the backend exits | `app/src-tauri/src/room.rs`, `app/src/mobile/jam.js`, `app/src/social.js` |
| D3 | `guestApply`'s same-track fast path clears `mirrorNote`; the not-found branch resets `appliedFrames` and `lastDrift` before painting. Desktop twin: `guestTick`'s fast path clears `guestMirror`, `followHostTrack`'s not-found branch clears `guestApplied`/`lastDrift` | `app/src/mobile/jam.js`, `app/src/social.js` |
| D4 | `hostTick` builds `` `${id}|${paused ? "paused" : "playing"}` `` and compares it with `hostKey` **before** the `st.paused` guard (mismatch → `broadcastPlayback` + return); only then does the pause early-return apply, then the drift check. `initJam` also wires `play`/`pause`/`seeked` on the shell `<audio>` once, each guarded by `room.role === "host"`, so a seek made while paused is not missed by the tick | `app/src/mobile/jam.js` |

### How to reproduce the verification (no mocks)

1. Desktop: `cargo build`, then launch `target/debug/trance-music.exe` with
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
   (plain `cargo build` embeds the assets; a `tauri dev` exe bakes a dead
   `devUrl`). Android: the installed debug/release APK, driven over
   `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`.
2. Direction matters: device **hosts** ⇒ `adb forward tcp:8787 tcp:8787`;
   device **dials** ⇒ `adb reverse tcp:8787 tcp:8787` (§13.6/§13.7 notes).
3. Assertions: (a) host track that the guest has only favourited/downloaded
   still resolves; (b) host pause → guest paused within one tick, host resume →
   drift returns; (c) `NOT ON THIS DEVICE` never coexists with the
   `Synchronized` badge; (d) join a dead address, then a live one, with no app
   restart in between.

### Results

_(filled in by the same-day verification run — see `docs/listen-together.md`
§13.8.)_
