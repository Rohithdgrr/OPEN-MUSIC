# Jam Stabilization & Cross-Platform Verification — Design Spec

- **Date:** 2026-10-08
- **Status:** DRAFT — awaiting partner review (brainstorming architectural path)
- **Assumption flagged:** written against **Approach 1 (land-first → doc truth-up → audit → gates)**.
  The approach was recommended but not explicitly picked; reject or swap it during review and
  this spec gets rewritten before any plan is made.

## 1. Goal (finish line)

Make the Jam / Listen Together feature **stable and verified on Windows, Linux, macOS, Android,
and iOS** — where "verified" is defined per platform as:

- **Windows + Android:** live two-device test passes locally (real app, real socket).
- **Linux:** CI build green + shared JS test suites run on the runner.
- **macOS + iOS:** CI green (build + JS tests where runnable) **plus** a written manual field
  runbook for anyone with the hardware. No live Apple-device test inside this effort.

**Scope decision (locked):** stabilize + verify what exists. **No new features.**

## 2. Locked decisions

| # | Decision | Answer |
|---|---|---|
| D-a | Finish line | Stabilize + verify existing Jam; no new capabilities |
| D-b | macOS/iOS bar | CI green + written runbook; honestly marked "unverified live" in docs |
| D-c | Uncommitted jam WIP in tree | **Adopt** — verify with the full gate suite, fix anything red, then land as local commits (no push, rule 1) |

## 3. Current state (evidence, 2026-10-08)

### Defects D1–D4

| Defect | Status | Where |
|---|---|---|
| D1 mobile/desktop guest resolve too narrow | Local-sources half **committed**; **catalog fallback uncommitted** (desktop `social.js:341`, mobile `mobile/jam.js:456`, via `jam/follow.js`) | working tree |
| D2 `room_join` latches `Mode::Guest` on failed dial | **Fixed, committed** — `room.rs:599 revert_failed_guest` + UI-layer `room_close` | HEAD |
| D3 stale mirror note / badge | **Fixed, committed** — fast-path clear + `appliedFrames/lastDrift` reset | HEAD |
| D4 mobile host never broadcasts pause | **Fixed, committed** — key checked before paused-guard + `wireHostAudio()` | HEAD |

### Uncommitted WIP to adopt (D-c)

- D1 catalog fallback (desktop + mobile) + `jam/follow.js` DI refactor (drops static `core.js`
  import — removes the mobile module-graph hazard)
- Room-role gates: crossfade (`playback.js`, `mobile/player.js`) and guest shortcut lock
  (`shortcuts.js`) keyed off new `room.js setLocalRole/localRole`
- `lib.rs` `TM_MULTI_INSTANCE=1` opt-out (desktop↔desktop jam testing)
- Rewritten `app/tests/jam-follow.test.mjs` (12 tests against the follow.js pipeline)
- Deletion of never-integrated dead files: `social-refactored.js`, `jam/controller.js`,
  `jam/qr-scanner.js`, `playback-crossfade-patch.js`, `shortcuts-guest-lock-patch.js`,
  `jam-controller.test.mjs`

### Known doc contradictions (to fix in Phase B)

- `docs/listen-together.md:280,327` — still say D1/D4 "not yet fixed"
- `incomplete-jam.md:29-30,79-103` — still say none of D1–D4 fixed
- `docs/jam-p0-fixes.md` + `docs/JAM-INTEGRATION-COMPLETE.md` — describe `controller.js` /
  `qr-scanner.js` / `social-refactored.js` as pending/complete; those files were never wired
  in and are being deleted
- `docs/jam-defects-d1-d4.md:228` — TODO to update the stale markers, never done

### Baseline gates (to be re-measured at Phase A start)

`npm test` was 237 pass / 3 fail on **stashed HEAD**; the 3 fails come from untracked jam tests
hitting `follow.js`'s old static `core.js → dom.js` import — **the adopted DI refactor is
expected to clear them**. Measure fresh; record actuals in the final report.

## 4. Approach — four phases

### Phase A — Adopt, verify, land
1. Run full local gate: `npm test`, `npm run lint`, `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `OP_OFFLINE=1 cargo test --lib`.
2. Fix anything red (within jam scope; unrelated red is reported, not silently fixed).
3. Land as a few logical local commits (jam fix / dead-file removal / multi-instance opt-out),
   author `Rohithdgrr <rohit93dgrr@gmail.com>` (rule 2). **No push (rule 1).**

### Phase B — Doc truth-up
Make every jam doc agree with reality: markers in `listen-together.md`, `incomplete-jam.md`,
status headers in `jam-p0-fixes.md` / `JAM-INTEGRATION-COMPLETE.md`, the
`jam-defects-d1-d4.md` TODO. Docs-first rule: any Phase C fix gets written into the relevant
`docs/*.md` **before** the code change, not after.

### Phase C — Cross-platform audit (candidate risks → fix what's proven)
Audit checklist (hypotheses, not findings, until checked):

1. **Room server bind + invite URL derivation** (`room.rs`) — multi-homed hosts, IPv6 vs IPv4,
   LAN IP changes when a device roams networks.
2. **Android cleartext to non-loopback hosts** — probes showed `usesCleartextTraffic=0x0` with a
   network security config; prior live tests used loopback/adb tunnels. A phone joining a PC's
   room **over real LAN** (`ws://192.168.x.x:8787`) may be blocked. HYPOTHESIS — verify.
3. **iOS readiness** — ATS/cleartext for `ws://`, background suspension killing the WebView's
   socket, what `ios.yml` actually proves (build only?).
4. **CI test coverage per workflow** — do `macos.yml`/`ios.yml`/`linux.yml` run the jam JS suites
   (`jam-ui`, `room`, `jam-follow`), or only build?
5. **Reconnect paths** — sleep/wake, network switch, host sleeps with guests attached, room
   listener rebind (the 07d defect class).
6. **Platform branches** — confirm the zero-`cfg` claim in `room.rs` stays safe on all targets
   (commands registered unconditionally).

Scope cap: Phase C fixes are limited to defects that break documented behavior. Anything bigger
becomes a written known-limitation unless the partner approves expansion mid-effort.

### Phase D — Repeatable verification
1. **Windows↔Android live gate:** document exact commands for `tests/live-desktop.mjs` and
   `tests/live-android-emulator.mjs` (they run by hand, outside `npm test`) as the two-device
   regression gate.
2. **CI matrix:** confirm/patch each workflow so jam tests run where runnable
   (`ci.yml` already runs tests; check `linux.yml`, `macos.yml`, `ios.yml`).
3. **Apple field runbook:** `docs/jam-apple-field-runbook.md` — step-by-step macOS↔iOS live test
   for anyone with hardware (per D-b).

## 5. Verification matrix (target end state)

| Platform | Bar | How |
|---|---|---|
| Windows | Live two-device pass | `live-desktop.mjs` + `live-android-emulator.mjs` locally |
| Android | Live two-device pass | same harnesses, real APK on emulator |
| Linux | CI green + jam tests on runner | `linux.yml` |
| macOS | CI green + jam tests on runner + runbook | `macos.yml` + runbook |
| iOS | CI build green + runbook | `ios.yml` + runbook; marked "unverified live" |

## 6. Gates (every phase ends on these)

`npm test` · `npm run lint` · `cargo fmt --check` · `cargo clippy --all-targets -- -D warnings` ·
`OP_OFFLINE=1 cargo test --lib` · jam static gate `app/tests/jam-ui.test.mjs` (in `npm test`) ·
live harnesses by hand where a device is involved.

## 7. Non-goals

- M2 shared queue, host migration, skip voting, NAT/relay (friends outside your LAN)
- New Jam features of any kind
- `release.yml` repair (3 pass / 7 fail) — unrelated to jam unless the audit proves otherwise
- Live testing on real Apple hardware inside this effort (D-b: runbook only)

## 8. Risks & open questions

- **CI can only be proven green after a push (rule 1).** Phase D's CI half prepares and
  validates workflow changes locally/structurally; the actual green run needs an explicit
  go-ahead to push. Until then CI items are marked "pending push".
- **Android real-LAN cleartext (risk 2)** may be a genuine blocker for the headline scenario
  "phone joins PC room over Wi-Fi" that has only ever been tested through adb tunnels. If true,
  it's the single highest-value fix in this effort.
- Tree carries other sessions' WIP — commits must be hunk-split or file-scoped (precedent:
  2026-10-07 `git apply --cached` technique); never stage-check + push in one command (rule 8).
- Parallel sessions may re-dirty jam files mid-effort; re-run gates immediately before each
  commit.

## 9. Deliverables checklist

- [ ] Adopted WIP landed (local commits, no push)
- [ ] All jam docs consistent with D1–D4 reality
- [ ] Audit findings recorded (fix / known-limitation, each with evidence)
- [ ] Live-gate commands documented
- [ ] CI workflows verified/patched (push pending go-ahead)
- [ ] `docs/jam-apple-field-runbook.md` written
- [ ] `CHANGELOG.md` Unreleased updated; `AGENTS.md` session entry appended
- [ ] Final report: what's verified per platform, what's honestly unverified
