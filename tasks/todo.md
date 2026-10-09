# Jam session hardening — task list

## Task 1: Desktop chrome-sync + unconditional Leave (S)
**Description:** Engaging Social chrome on `hosted`/`joined`; `setMode(false)`
tears down open rooms even when already Solo.
**Acceptance criteria:**
- [x] Room opened without the mode switch still shows Social chrome
- [x] Leave ends the session from any chrome state (no silent no-op)
- [x] `bye`-without-rejoin clears chrome; rejoin paths keep it
**Verification:** repro-jam cleanup leave works; `npm test` green
**Dependencies:** None
**Files:** `app/src/social.js`

## Task 2: Follow gate (S)
**Description:** `shouldStartFollow` pure helper in `room.js`; both guests gate
on track id (30 s expiry backstop); drop the per-frame keys.
**Acceptance criteria:**
- [x] One in-flight follow per track id on each surface
- [x] Re-arms on land / track change / room end
- [x] Unit tests in `room.test.mjs`
**Verification:** `npm test` green; live next-follow ≤2 s both directions
**Dependencies:** Task 1
**Files:** `app/src/room.js`, `app/src/social.js`, `app/src/mobile/jam.js`, `app/tests/room.test.mjs`

## Task 3: Desktop chat badge (S)
**Description:** Unread pill on `#tab-btn-chat` + toast when hidden; reset on
open/send/boundary.
**Acceptance criteria:**
- [x] Pill counts new lines while chat panel hidden, hidden at 0
- [x] Toast teaches the way on first hidden message
- [x] Static id-contract tests updated
**Verification:** live screenshot; desktop sweeps green
**Dependencies:** Task 1
**Files:** `app/src/index.html`, `app/src/social.js`, `app/src/styles.css`, `app/tests/social-ui.test.mjs`

## Task 4: Mobile chat badge (S)
**Description:** Same for `#chatTabBtn` + `switchTab` reset.
**Acceptance criteria:** same as Task 3 on the device — all verified live + green
**Verification:** live screenshot; android sweeps green
**Dependencies:** Task 1
**Files:** `app/src/mobile/screens/nowplaying.html`, `app/src/mobile/jam.js`, `app/tests/jam-ui.test.mjs`

## Task 5: Rust queue frame (M)
**Description:** `room_queue` command + cached `queue` frame + join replay +
`cargo` unit tests (cap, host-only, replay, clear-on-close).
**Acceptance criteria:**
- [x] Guests refused; late joiner replays; cap 10 enforced server-side
**Verification:** `cargo test room::` green
**Dependencies:** Task 1
**Files:** `app/src-tauri/src/room.rs`

## Task 6: Reducer hostQueue (XS)
**Description:** Store `queue` frames; clear on `bye`; ignore for host role.
**Acceptance criteria:**
- [x] Unit tests in `room.test.mjs`
**Verification:** `npm test` green
**Dependencies:** Task 5
**Files:** `app/src/room.js`, `app/tests/room.test.mjs`

## Task 7: Queue emit + render (M)
**Description:** Host emits snapshot on queue change (both surfaces); guests
render read-only up-next.
**Acceptance criteria:**
- [x] Guest queue view shows host's next tracks, updates on host next
- [x] No guest controls on the shared list
**Verification:** live lan-join assertions; screenshots
**Dependencies:** Tasks 5, 6
**Files:** `app/src/social.js`, `app/src/mobile/jam.js`, `app/src/index.html`, `app/src/mobile/screens/nowplaying.html`, `app/tests/live-lan-join.mjs`
