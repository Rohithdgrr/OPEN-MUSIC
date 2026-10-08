# incomplete-jam.md — handoff for the Listen Together / playback work

Written 2026-10-06 (session "T12", agent BUFFY). This is a **working memory +
continuation plan**, not a spec. The spec of record is
[`docs/listen-together.md`](docs/listen-together.md); agent-coordination state
lives in [`ROOM.MD`](ROOM.MD) and [`AGENTS.md`](AGENTS.md).

Read this file first if you are resuming. It records what is proven, what is
**not** proven, why, and the exact next actions.

**Related documents** (do not duplicate them here):

| Doc | What it holds |
|---|---|
| [`docs/listen-together.md`](docs/listen-together.md) | The **spec of record** — protocol §3, sync §4, contracts §6/§6a, runbook §10, mobile §12, shipped-state §13 |
| [`docs/social-nowplaying.md`](docs/social-nowplaying.md) | Desktop Jam/QR/chat UI contract — class inventory, id contract, truthfulness rules, QR §6c |
| [`docs/future-scope.md`](docs/future-scope.md) · [`docs/mobile/08-future-scope.md`](docs/mobile/08-future-scope.md) | The repo's standing future-scope lists (product-level and mobile) |
| [`ROOM.MD`](ROOM.MD) | Agent board, frozen contracts C-1…C-6, decisions D-1…D-13, learnings |
| [`AGENTS.md`](AGENTS.md) | Standing user rules + verified environment facts |

---

## 0. Status in one screen

| Area | State |
|---|---|
| Social / room / QR / join / leave (desktop) | **DONE — verified live, 32/32** |
| Social / room / chat / presence / leave (Android emulator) | **DONE — verified live, 28/28** |
| **Desktop host ↔ Android guest in one real room** | **DONE 2026-10-07 — §1.2.** Chat/presence/drift/follow proven against two real apps; **3 defects found, all since fixed (D2/D3 committed, D1 in `6f2f302`)** |
| **Android host ↔ desktop guest (the reverse pairing)** | **DONE 2026-10-07 — §1.2.** Join/chat/follow/`±0.05s` drift/resume all proven; **1 new defect found (D4, phone host never broadcast a pause) — fixed 2026-10-07** |
| Static gates (`npm test`, lint, fmt, clippy, `cargo test`) | **GREEN** |
| **"Run a single song" — desktop** | **PARTIAL** — playback proven, *stable assertion not yet written* |
| **"Run a single song" — Android emulator** | **NOT STARTED** |
| Two real PCs over a LAN (§10 runbook) | NOT STARTED — needs a second machine |

The one unfinished user request is **"run a single song in both emulator and
desktop"**. §2 is the recipe; §6 is the ordered plan.

---

## 1. What this session finished and PROVED

All of these ran against **real apps with real sockets**, not stubs.

| Claim | Evidence |
|---|---|
| Desktop surface end-to-end | `node app/tests/live-desktop.mjs` → **32 pass / 0 fail**, run **twice back-to-back** on the same window |
| Android surface end-to-end | `node app/tests/live-android-emulator.mjs` → **28 pass / 0 fail** (AVD `Pixel6_API36`) |
| Room QR carries the invite | temporary live probe → **7/7**; `qr_symbol` returned `size=29 v3`, canvas painted 34470 dark px |
| Frontend gate | `cd app && npm test` → **174 pass / 0 fail** |
| Lint | `cd app && npm run lint` → clean |
| Rust gates | `cargo fmt --check` clean; `cargo clippy --all-targets -- -D warnings` clean; `cargo test --lib` → **174/174** |

Proven behaviours (desktop run, verbatim): room opened from the UI, code in all
three slots, `ws://10.227.158.104:8787` advertised, real second socket got
`joined,history,presence`, chat echo in **31 ms**, guest `playback` refused
`not_host`, `presence` → 2 members + `±0.25s` drift, guest leave → `1 online` +
`—`, Leave → `NO ROOM` + Session `Local room`.

### 1.1 Defects found and fixed this session (4)

1. **`room_info` hid the invite** — returned `{role,port,code}` while
   `room_open` returned `urls`. `live-desktop.mjs` aborted on a field that never
   existed, which proves that test **had never actually been run**. Fixed
   (`app/src-tauri/src/room.rs`): `RoomInfo` now carries `urls`.
2. **Room listener was coupled to mode entry** — `startRoomListener()` was only
   called by `enterSocial()`, but `#btn-open-room` → `openRoom()` is wired
   independently. A room could be live with **nobody listening**, freezing the
   host UI at `1 online`. Fixed (`app/src/social.js`): attached once at boot; the
   no-IPC early-return no longer latches `listenerReady` off.
3. **QR encoded only the code** — a guest who scanned it still had to find the
   host's address by hand. Now encodes the invite line
   (`ws://<host>:<port> · <CODE>`). Still **not** a `trancemusic://` deep link —
   no such scheme exists (D-13 supersedes D-K3's payload only).
4. **`live-desktop.mjs` was not re-runnable** — a top-level `const i` inside
   `Runtime.evaluate` persists in the page, so a second run died with
   `Identifier 'i' has already been declared`. Wrapped in an IIFE.

### 1.2 Defects found 2026-10-07 — both room directions (all FIXED — D2/D3/D4 committed, D1 in `6f2f302` 2026-10-08)

**Issue + solution write-up for D1–D4: `docs/jam-defects-d1-d4.md`** (the
spec the fixes were implemented against; fix notes now also inline in
`docs/listen-together.md` §12).

A later session ran the missing combination: **real desktop app as host, real
Android app as guest**, same room, driven only through the UI over CDP. The
user report under test was *"the guest doesn't follow the host's music, the
controls are locked, nothing responds — only chat works."* Verdicts and full
evidence: **`docs/listen-together.md` §13.6**; short forms in
**`docs/mobile/09-problems-solutions.md` P31-P33**.

D4 came from the **reverse pairing** (real Android host, real desktop guest,
rooms `#MPXYBD5L` / `#5VV6PGF8`): everything the first run proved held in the
other direction too — join, chat both ways, host broadcast, follow-and-play at
`±0.08s` → `±0.05s`, resume re-sync, and the same §4.5 mirror line on a track
the desktop lacked — and one thing broke that only the phone-as-host path can
break. Evidence: **`docs/listen-together.md` §13.7**, mobile 09 **P34**.

| # | Defect | Where | One line |
|---|---|---|---|
| D1 | Mobile guest resolve list is narrower than desktop's → host's track declared `NOT ON THIS DEVICE`, transport locked, guest keeps playing its own audio. **H1 confirmed, H2/H3 disproven.** | `app/src/mobile/jam.js:398` (`followGuest`) vs `app/src/social.js:328` (`findLocalTrack`) | add plays/favourites/vault to the mobile search, or state the queue-only limit in the UI |
| D2 | A refused/timed-out join leaves `Mode::Guest` latched → every later join answers *"Leave the current room before joining another."* while the UI says Solo; only an app restart recovers | `app/src-tauri/src/room.rs:808` (set) vs `:589` `guest_run` (never reset) | revert to `Mode::Idle` in the failure paths; `room_close` from the UI when `error` arrives while joining |
| D3 | `NOT ON THIS DEVICE` shows while the badge claims `Synchronized ±0.04s`, and the badge outlives a lost sync | `jam.js:411` (only clear) / `:369` (fast path skips it); `appliedFrames`/`lastDrift` never reset | clear the note on the fast path; reset the sync counters when a frame cannot be applied |
| D4 | **Reverse run (Android host ↔ desktop guest): the host pauses and the guests keep playing.** Anything the phone host does while paused (next track, seek) is withheld until it resumes; resume itself self-heals | `mobile/jam.js:346` returns on `st.paused` before the drift/key check, and mobile has no `play`/`pause`/`seeked` listeners or title observer — `broadcastPlayback()` has 2 call sites (`:263`, `:354`) vs desktop's 5 (`social.js:317`, `:401`, `:696`, `:704`, wired at boot `:884`). Live: host t=136 paused, desktop guest t=141 still playing at `±0.06s` | wire `play`/`pause`/`seeked` (and title) listeners on the mobile host like the desktop, or drop the `st.paused` guard so the 1 s tick emits `playing:false`. Full evidence: `docs/listen-together.md` §13.7, mobile 09 **P34** |

**That session changed nothing in the code** — it was documentation-only by
instruction. The fixes have since landed (D2/D3/D4 committed, D1 catalog
fallback in `6f2f302` — fix notes in `docs/listen-together.md` §12).
Reproduce the setup with §5 of this file plus the harness notes at
the end of §13.6 (note: a device-side guest needs **`adb reverse`**, not
`adb forward`).

---

## 2. THE UNFINISHED TASK — run a single song on both surfaces

### 2.1 Desktop — playback IS working, the *measurement* is not

**Proven (real audio, real bytes from the app's own relay):**

- `#audio` playing `http://127.0.0.1:<port>/stream?id=…&token=…`
- Track **Kesariya** — search row said `5:56` → `audio.duration = 356.5 s`
  (they agree, so the right track resolved)
- Another run: `duration = 515.38 s` (`8:35`), bar clock `00:24 / 08:35`
- `readyState = 4` (HAVE_ENOUGH_DATA), `audio.error = null`, bar badge `320kbps`,
  progress fill painted (`0.6%`), `paused = false`

**Not yet proven:** a clean, repeatable *"the playhead advanced ≥2.5 s over 4 s"*
assertion. Three attempts, three different races — see §2.3. Do not report the
desktop task as done until this line passes on a fresh run.

### 2.2 Android — not started

Everything needed is known; nothing has been executed for playback yet.

```bash
# 1. boot the emulator (it is NOT running by default; it died between sessions)
"$ANDROID_HOME/emulator/emulator" -avd Pixel6_API36 -no-snapshot-save -no-boot-anim   # BACKGROUND
adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

# 2. APK must be a real build, never a `tauri android dev` client (see §5.3)
cd app && npm run tauri android build -- --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# 3. drive it: copy the coldStart + adb forward pattern from
#    app/tests/live-android-emulator.mjs  (it already does socket discovery)
```

**Mobile playback facts discovered (so you don't re-grep):**

- The Android app loads **`mobile/index.html`** (via `tauri.android.conf.json`
  `windows[0].url`), served from `http://tauri.localhost/mobile/index.html`.
- There is exactly **one** media element: `mobile/index.html:749`
  `<audio id="audio" preload="metadata">`. `mobile/player.js:16` holds
  `let audio = document.getElementById("audio")`. (Desktop uses **two** —
  `#audio` + `#audio2` — for crossfade; mobile does not.)
- **Drive search through the hash router, not the keyboard.**
  `mobile/binders.js:547 mountSearch()` commits via `go("search?q=…")`, so:
  ```js
  location.hash = "#/search?q=kesariya";   // mounts the search screen with results
  ```
- Result rows are `[data-list][data-idx]` (the shell's generic row contract —
  matched at `mobile/app.js:208`/`:215`, rendered with `data-list`/`data-idx` at
  `mobile/binders.js:318`/`:1091`/`:1577`/`:2472`). Click
  `document.querySelector("[data-list][data-idx]").click()`.
  **Caution:** `mobile/binders.js:1146` is a *different* attribute
  (`[data-follow-idx]`) — do not use it as the row selector.
- Then `location.hash = "#/nowplaying"` and read the mobile `#audio`.

**Watch out:** the mobile shell is a hash router with 13 screens; the screen
fragment is re-appended per navigation, so element handles must be re-queried
after every route change (`player.js` re-fetches at line 16).

### 2.3 The races that broke my three desktop attempts (solution for each)

| Attempt | Symptom | Cause | Fix applied / to apply |
|---|---|---|---|
| 1 | `t 29.36 → 0.00`, `duration NaN` | sampled exactly while the new source was swapping in | wait for `duration` finite **before** sampling |
| 2 | `t 71.52 → 2.05` | the "is playing" wait passed instantly because a **previous track was already playing** | anchor the wait to `audio.src` **changing**, then to settle |
| 3 | `t 0.73`, `paused=true`, src unchanged | clicking a row whose track is **already loaded** did not (re)start playback | use a **fresh query**, or click `#bar-play` after the row |

Root reason attempts 1–3 existed at all: **the app restores the previous
session at boot**, so `#audio` is often already playing before you click
anything. Always capture pre-click state.

### 2.4 Working scaffold (already on disk, temporary)

- `app/tests/_runsong.mjs` — desktop driver. Already contains the search-by-Enter
  path, the source-swap anchor, the settle wait and the playhead measurement.
  **Extend it, then rename it to a permanent test or delete it** (see §6).
- `app/tests/_probe.mjs` — dumps both desktop audio elements
  (`src/duration/currentTime/paused/readyState/networkState/error`), the bar
  badge/clock, net mode and toasts. Use it first when playback misbehaves.

Both are `_`-prefixed so `npm test` (glob `tests/**/*.test.mjs`) ignores them.

---

## 3. Files — what changed, what is new

**Modified this session (8):**
`app/src-tauri/src/room.rs` (room_info urls) · `app/src/social.js` (listener at
boot + QR invite payload) · `app/tests/live-desktop.mjs` (IIFE + enter Social
first) · `docs/listen-together.md` (§6 + §13.4 rewritten with the live results) ·
`docs/social-nowplaying.md` (§6c QR payload) · `CHANGELOG.md` · `ROOM.MD`
(D-12, D-13, learnings 14–15) · `AGENTS.md` (verified findings, corrected stale
Android claims).

**Untracked, carried over from the previous session:**
`app/src/mobile/jam.js` · `app/tests/jam-ui.test.mjs` ·
`app/tests/live-harness.mjs` · `app/tests/live-desktop.mjs` ·
`app/tests/live-android-emulator.mjs`.

**Temporary (resolve before finishing):** `app/tests/_runsong.mjs`,
`app/tests/_probe.mjs`.

**Nothing was committed.** The tree mixes this session's work with a large
pre-existing uncommitted body of work; staging was deliberately left to the
user. See §9.

---

## 4. Command cookbook (copy-paste)

```bash
# ---- desktop: build a SELF-CONTAINED binary, then run it with CDP ----
cd app/src-tauri && cargo build
taskkill //F //IM trance-music.exe 2>/dev/null            # must stop it BEFORE rebuilding
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  ./target/debug/trance-music.exe                        # run as a BACKGROUND process
curl -s http://127.0.0.1:9222/json | grep -oE '"url": "[^"]*"'   # expect http://tauri.localhost/

# ---- desktop live suites ----
cd app && node tests/live-desktop.mjs

# ---- android ----
"$ANDROID_HOME/emulator/emulator" -avd Pixel6_API36 -no-snapshot-save -no-boot-anim
cd app && npm run tauri android build -- --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
node tests/live-android-emulator.mjs

# ---- gates ----
cd app && npm test && npm run lint
cd app/src-tauri && cargo fmt --check
cd app/src-tauri && cargo clippy --all-targets -- -D warnings
cd app/src-tauri && OP_OFFLINE=1 cargo test --lib          # 174 pass in ~6 s
```

---

## 5. Problems faced → solutions (the expensive knowledge)

### 5.1 `npm run tauri dev` does not give you a debuggable app
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` **never
reached WebView2** through `npm run tauri dev` → `cargo run` (port 9222 never
listened). Fix: run `cargo build` and launch `target/debug/trance-music.exe`
directly with the env var set on the exe.

### 5.2 `tauri dev`'s asset server dies with the app
With `tauri dev` the page is served from `http://127.0.0.1:1430/`; kill the app
and the page becomes `chrome-error://chromewebdata/` ("Hmm… can't reach this
page") with a 318 KB error DOM. A plain `cargo build` **embeds** the frontend and
serves it from `http://tauri.localhost/` — no dev server, deterministic.

### 5.3 A `gen/android` debug APK is a DEV CLIENT, not a shippable build
The pre-existing `app-x86_64-debug.apk` came from `tauri android dev`, so it
baked in `devUrl` = `http://<pc-ip>:1430/mobile/index.html`. On the emulator the
app rendered a load-failure page: CDP DOM had **0** ids, and `adb logcat` showed
`Failed to request http://<ip>:1430/mobile/index.html`. It looked like a broken
frontend; the frontend was fine. Only `tauri android build --debug` embeds the
assets. **Check `adb logcat` for `Failed to request` before blaming the UI.**

```bash
adb logcat -d | grep -iE "chromium|CONSOLE|Failed to request" | tail -40
```

### 5.4 CDP attaches before the webview has navigated
The devtools target appears first. Evaluating immediately returns
`about:blank` / `document.readyState=complete` with **0 ids**. Always poll:
`!!window.__TAURI__?.core` (the live tests' `waitFor`).

### 5.5 `Runtime.evaluate` runs at global scope
A top-level `const`/`let` **persists in the page**, so the same expression run
twice throws `Identifier 'x' has already been declared`. Wrap multi-statement
snippets in an IIFE: `(()=>{ … })()`. This is what made `live-desktop.mjs`
fail on its second run.

### 5.6 Android port forwarding collides with the desktop room
The desktop room server binds `0.0.0.0:8787`, and the Android test does
`adb forward tcp:8787 tcp:8787`. **Run the two live suites sequentially, never
concurrently.**

### 5.7 Never background a process with `&` inside a SYNC command
`… trance-music.exe >/dev/null 2>&1 & ; sleep 9; node …` hung and timed out at
240 s even though the app started correctly. Use the tool's **BACKGROUND**
process type for long-running apps, and a separate call for the test.

### 5.8 The emulator does not survive a session break
`adb devices` returned an empty list mid-task. Always re-check
`adb devices` + `getprop sys.boot_completed` before assuming it is up.

### 5.9 `code_search` is broken in this environment
`uv_spawn 'C:\Users\rohit\.config\manicode\rg.exe' ENOENT`. Fall back to bash
`grep -rn` / `find`. (Verified repeatedly this session.)

### 5.10 Two `cargo test` tests are network-flaky
One online run: `172 passed; 2 failed`; the next: `174 passed`. Both live in the
network paths (`jiosaunv.rs`/`lyrics.rs` guard on `OP_OFFLINE`). Use
`OP_OFFLINE=1` for a deterministic local gate (174 pass in **5.9 s** vs 84–107 s
online). Do not "fix" this by deleting the tests.

### 5.11 The network badge reads `degraded` while everything works
`#net-badge[data-net-mode]` said `degraded` in a session where search returned 38
rows and a stream played at `readyState=4`. It reflects *mirror* health, not
usability. **Report it, do not assert on it.**

### 5.12 Manual APK builds are slow and large
`tauri android build --debug --target x86_64` ≈ 1 min incremental Rust + gradle,
and it still emits a **universal** APK (~586 MB debug) at
`gen/android/app/build/outputs/apk/universal/debug/`. Installing takes ~30 s.
Budget for it; do not rebuild for frontend-only changes on desktop.

---

## 6. Next targets — ordered

1. **Finish the desktop playback assertion (do this first, it is 90% there).**
   Use `app/tests/_runsong.mjs` with a *fresh* query (e.g. `"tum hi ho"`) so the
   clicked track is not the one already loaded. Sequence: capture pre-click
   `audio.src` → click row → wait for `src` to change → wait for
   `duration>30 && currentTime>1 && !paused` → sample `currentTime`, wait 4 s,
   sample again → assert `Δ > 2.5 s`. Fall back to clicking `#bar-play` if the
   row click leaves it paused.
   **Definition of done:** `PASS playhead advanced over 4 s :: X → Y` on a fresh
   app, reproducibly twice.
2. **Do the same on the Android emulator** using §2.2's recipe and the mobile
   selectors. Verify the *device's* `#audio.currentTime` advances, and that the
   mobile nowplaying screen shows a real title/duration (no `—`).
   **Definition of done:** a printed `Δ` from the device, plus the mobile
   nowplaying screen showing the real track.
3. **Decide the fate of the two `_` files.** Either promote them into
   `app/tests/live-playback-desktop.mjs` + `…-android.mjs` (following
   `live-harness.mjs`'s `reporter()`/`waitFor()` helpers, which already exist and
   should be reused), or delete them. A permanent test is preferred — this
   session's whole lesson is that **an unrun live harness is not a test**.
4. **Only then** consider the two-PC LAN runbook (`docs/listen-together.md` §10)
   — it is the last unproven claim for the Jam feature.
5. Optional, user-decision only: mobile has **no QR surface**
   (`copyUriBtn` copies the invite instead). Adding one is a design decision, not
   a fix.

---

## 7. Tips and tricks

- **The app restores the last session on boot.** Never assume a fresh app is
  silent; capture state before acting. This single fact caused three failed
  measurement attempts.
- **Wait on the thing you need, never `sleep(guess)`.** Every live test here
  polls with `waitFor`. The whole class of races in §2.3 was fixed by waiting for
  a *specific* state change (`src` changed), not a duration.
- **Anchor identity by source, not by "is playing".** `audio.src` is the only
  reliable signal that the click took effect.
- **Dump, don't infer.** `_probe.mjs` answers "is it playing?" in one call
  (`readyState`, `error.code`, `duration`). Read `adb logcat` for the Android
  equivalent.
- **Cross-check duration against the UI.** The search row said `5:56` and the
  element reported `356.5 s` — that is what proves the *right* track resolved,
  not just *a* track.
- **Run the two live suites sequentially** (§5.6).
- **`taskkill` before rebuilding on Windows** — the exe is locked while running.
- **Rebuild the desktop binary after touching `app/src/*.js`**: `cargo build`
  embeds the frontend, so a JS edit needs a rebuild (≈30 s incremental).
- **Android ignores `app/src/social.js`** — the mobile shell never loads it
  (confirmed: the only reference in `app/src/mobile/` is a comment in `jam.js`).
  A desktop-only JS change does **not** invalidate the Android evidence.
- **Read the exit status, not the tail.** Pipe through `grep` freely, but check
  `$?`/`PIPESTATUS` — see `AGENTS.md` on the `| tee` false-green bug.

---

## 8. Open questions for the user

1. Should the playback checks become **permanent tests** in `app/tests/`
   (recommended), or one-off verification to be deleted?
2. Should the **QR encode the invite** stay? It now carries
   `ws://host:port · CODE`. It is a change to a previously frozen decision
   (D-K3) and is recorded as D-13 — reverse it if the code-alone payload was
   wanted for a reason not captured in the docs.
3. **No "friends" feature exists, and none was added.** The room code + invite +
   QR *is* the add-a-friend mechanism. Say so if a real contacts system is
   wanted; that is a new feature, not a fix (deliberate YAGNI call).
4. Nothing was committed. Confirm whether to commit this session's work.

---

## 9. Housekeeping — rules that still apply

- **NEVER push without an explicit go-ahead** (`AGENTS.md` rule 1). Commit
  locally, report, wait.
- **Check `git log --oneline origin/main..HEAD` and the author of every commit
  before any push** (rule 8 — a guard printed in the *same* command as the push
  is not a guard).
- Git identity must be `Rohithdgrr <rohit93dgrr@gmail.com>` (already configured).
- **Never rewrite pushed history** to fix identity.
- Docs-first for any behaviour change; contract changes need a doc edit + a
  `ROOM.MD` decision row. This session added **D-12** (`room_info.urls`) and
  **D-13** (QR payload), plus `ROOM.MD` learnings **14** (dev-client APK) and
  **15** (an unrun live test is not a test).
- `gen/` is gitignored, so a fresh clone must run `tauri android init` before
  any Android build. Note: this checkout's
  `gen/android/app/src/main/AndroidManifest.xml` **already has**
  `android.permission.INTERNET`, so the old P20/P21 "INTERNET not granted"
  finding is **stale here** (corrected in `AGENTS.md`).
