# Implementation Plan: jam session hardening (chat visibility + follow + shared queue + lifecycle)

## Overview

Four user-reported gaps, one root-cause pass: (1) room chat is invisible — it
renders into a non-default tab with no badge/toast on either surface;
(2) guests re-fire track-follow on every 250 ms tick while resolving takes
seconds (resolve storm → queue pollution, audio restarts, "not following");
(3) up-next queues are device-local — guests can't see what's next;
(4) desktop Leave silently no-ops when Social chrome desyncs from room state
(reproduced live: hosting with Solo chrome → `setMode(false)` early-return →
session never ends). Spec: `docs/listen-together.md` §3/§4.6–7/§5/§6/§6b
(written before code, 2026-10-09).

## Architecture Decisions

- Unread badge = counter + pill + toast-if-hidden, cleared on tab open / send /
  room boundary. No auto-switch (yanking the user mid-scroll is worse).
- Follow gate keyed on track id only (not `at`/`positionMs`), shared pure
  helper in `room.js` so both guests obey one rule with one unit test.
- Queue sync = new cached `queue` frame (host-only send, ≤10, read-only
  render), mirroring the `playback` frame's lifecycle exactly (replay on join,
  cleared on bye). No new commands beyond `room_queue`.
- Lifecycle: chrome follows room on `hosted`/`joined`; `setMode(false)`
  tears down open rooms even when already Solo. Mobile already does both —
  desktop-only change.

## Task List

### Phase 1: Lifecycle (enabler — all live verification needs reliable open/close)
- [ ] Task 1: desktop chrome-sync + unconditional Leave
- [ ] Checkpoint: repro-jam cleanup leave works; `npm test` green

### Phase 2: Follow gate
- [ ] Task 2: `shouldStartFollow` in `room.js` + both guests rewire + unit tests
- [ ] Checkpoint: `npm test`, `cargo test --lib` green; live next-follow still ≤2 s

### Phase 3: Chat badge
- [ ] Task 3: desktop pill + toast + reset hooks
- [ ] Task 4: mobile pill + toast + reset hooks
- [ ] Checkpoint: live screenshots show badge; sweeps still green

### Phase 4: Shared queue
- [ ] Task 5: Rust `room_queue` + `queue` frame + replay + unit tests
- [ ] Task 6: reducer `hostQueue` + unit tests
- [ ] Task 7: host emit on queue change (both surfaces) + guest read-only render
- [ ] Checkpoint: full gates + live lan-join queue assertions

### Checkpoint: Complete
- [ ] `npm test` 275+ green, eslint/fmt/clippy clean, `cargo test --lib` green
- [ ] live-desktop / chat-conditions / scale / android-emulator /
  android-conditions / lan-join / reverse-pair all green
- [ ] screenshots prove chat badge + shared queue on both surfaces

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Queue frame races playback (guest shows next before playing it) | Low (cosmetic) | queue excludes current track; order irrelevant |
| Toast spam in busy rooms | Low | only when chat tab hidden; server rate-limit caps at 5/10 s |
| `room_queue` from old clients | Low | unknown-frame guard already drops it; additive, no version bump |

## Open Questions

- None — all four behaviors were reproduced/verified live before speccing.
