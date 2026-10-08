# Jam Stabilization & Cross-Platform Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the pending Jam work, make every Jam doc true, audit the cross-platform risks, and prove the feature stable via `npm run tauri dev` + Android emulator live runs, with CI/runbook coverage for platforms this machine can't host.

**Architecture:** Four-phase stabilize-only effort (adopt → truth-up → audit → verify). No new Jam features. All verification is evidence-first: local gate suites, two live harnesses, a written Apple runbook. Findings live in a new audit doc; docs are written before any fix (docs-first rule).

**Tech Stack:** Tauri 2 (Rust `room.rs` room server/client) + zero-build vanilla JS (`app/src/social.js`, `app/src/mobile/jam.js`, shared reducer `app/src/room.js`); Node test runner (`node --test`); GitHub Actions (ci/linux/macos/ios); Android emulator via adb.

**Spec:** `docs/jam-stabilization-spec.md` (approved 2026-10-08). Read it first — this plan argues from it.

## Global Constraints

- **No push to GitHub without explicit go-ahead** (rule 1). CI changes are committed locally; their green run is marked "pending push".
- **Git identity:** `Rohithdgrr <rohit93dgrr@gmail.com>` — verify `git config user.email` before the first commit (rule 2).
- **Docs-first:** any fix gets a `docs/*.md` entry **before** the code change (rule 3).
- **Never stage-check and push in one command;** never let a commit ride along another session's WIP — read `git diff --cached --stat` before every commit (rule 8, precedent `99f245b`).
- **Gates (spec §6):** `npm test` · `npm run lint` · `cargo fmt --check` · `cargo clippy --all-targets -- -D warnings` · `$env:OP_OFFLINE="1"; cargo test --lib` (PowerShell — bare `OP_OFFLINE=1 …` does not work here).
- **No new Jam features** (spec §1). Audit fixes are capped to defects breaking documented behavior (spec §4 Phase C).
- Tree carries other sessions' WIP (~20 dirty tracked files): commit file-scoped; use the `git apply --cached` hunk-split technique only if a single file mixes both sessions' work (precedent 2026-10-07).
- `git push` exit-1 via stderr is spurious in PowerShell — trust `main -> main` line + empty `origin/main..HEAD` (but see rule 1: no push anyway).

## Review Focus

Spec-implied failure modes no single gate exercises; each is pinned to the task that owns it.

1. **Android guest joining over real LAN (`ws://<pc-ip>:8787`), never adb-tunnels** — every prior live test used `adb reverse`/`forward` loopback; release cleartext config scopes to `127.0.0.1` (P23), so a LAN join may be the one untested path that breaks. → Task 7 "join via LAN IP" step.
2. **`npm run tauri dev` cannot be CDP-driven** — AGENTS.md proved `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` doesn't reach WebView2 through `tauri dev` → `cargo run`. A verifier who tries to run `live-desktop.mjs` against dev will get "port never listens" and misread it as a Jam defect. → Task 6 splits interactive dev smoke from the cargo-build harness.
3. **Commit contamination** — staging a batch that silently includes another session's dirty files publishes their WIP (violated 2026-10-06). → every Commit step requires reading `git diff --cached --stat` first.
4. **iOS ATS may block cleartext `ws://` room joins** — unobservable from Windows; `gen/apple` doesn't exist locally and `ios.yml` only builds. → Task 4 records it as a finding; Task 8 pins it into the Apple runbook as the first thing a hardware owner checks.
5. **Reconnect/sleep/network-switch defects are invisible to unit suites** — `room.test.mjs` (28 tests) pins the reducer, not socket rebind. → Task 3 audits the rebind path and records fix-or-limitation; Task 6 adds a manual blip check.

---

### Task 1: Adopt the uncommitted Jam WIP (gates green → logical commits)

**Files:**
- Modify (already dirty): `app/src/social.js`, `app/src/mobile/jam.js`, `app/src/room.js`, `app/src/playback.js`, `app/src/shortcuts.js`, `app/src/mobile/player.js`, `app/src/jam/follow.js`, `app/src-tauri/src/lib.rs`, `app/tests/jam-follow.test.mjs`
- Delete: `app/src/social-refactored.js`, `app/src/jam/controller.js`, `app/src/jam/qr-scanner.js`, `app/src/playback-crossfade-patch.js`, `app/src/shortcuts-guest-lock-patch.js`, `app/tests/jam-controller.test.mjs`

**Interfaces:**
- Consumes: D1 catalog-fallback implementation + role gates written by earlier sessions (spec §3 inventory).
- Produces: green `main` at HEAD with the WIP landed; later tasks assume `git status` shows no Jam-related dirt. `room.js` exports `setLocalRole(role)` / `localRole()` — crossfade/shortcut gates depend on them.

- [ ] **Step 1: Run the JS gates**

```powershell
npm test
npm run lint
```
Expected: `npm test` **0 fail** (baseline 237 pass; the 3 known fails come from the old static `follow.js → core.js → dom.js` import that the DI refactor removes — if they persist, that's red to fix in Step 4). `npm run lint` clean.

- [ ] **Step 2: Run the Rust gates**

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
$env:OP_OFFLINE="1"; cargo test --lib
```
Expected (run in `app\src-tauri`): all three clean; `cargo test --lib` **174 pass / 0 fail**. Re-check `$LASTEXITCODE` if PowerShell reports exit 1 with pass output (NativeCommandError trap).

- [ ] **Step 3: Fix any red within Jam scope**

If `jam-follow.test.mjs` fails, the fix direction is the DI refactor already in the tree (resolver receives `invoke` — no static `core.js` import). Unrelated red: report, don't fix.

- [ ] **Step 4: Re-run any gate you touched code under**

Same commands as Steps 1–2. Expected: clean.

- [ ] **Step 5: Commit the WIP as three file-scoped commits**

Each commit: stage listed files only → **read** `git diff --cached --stat` → verify the list matches → `git commit` (separate command, never chained with anything else).

```powershell
git add app/src/social.js app/src/mobile/jam.js app/src/room.js app/src/playback.js app/src/shortcuts.js app/src/mobile/player.js app/src/jam/follow.js app/src-tauri/src/lib.rs app/tests/jam-follow.test.mjs
git commit -m "feat(jam): catalog fallback for guest track resolution + room-role gates for crossfade/shortcuts"

git add -A app/src/social-refactored.js app/src/jam/controller.js app/src/jam/qr-scanner.js app/src/playback-crossfade-patch.js app/src/shortcuts-guest-lock-patch.js app/tests/jam-controller.test.mjs
git commit -m "chore(jam): remove never-integrated refactor leftovers"

git add app/src-tauri/src/lib.rs   # only if TM_MULTI_INSTANCE hunk not already in commit 1; otherwise skip
git commit -m "feat(desktop): TM_MULTI_INSTANCE=1 opt-out for two-instance jam testing"
```
Note: `lib.rs` may carry both the multi-instance and other changes — if `git diff --cached --stat` shows more than the Jam files, hunk-split per Global Constraints. Commit 3 exists only if Step 5's first commit didn't include it (one commit is fine if the diff is single-purpose).

- [ ] **Step 6: Verify final state**

```powershell
git status --short
git log --oneline -4
```
Expected: no Jam files dirty; 1–3 new commits on top of `a27943e`.

---

### Task 2: Doc truth-up — make every Jam doc match D1–D4 reality

**Files:**
- Modify: `docs/listen-together.md:280,327` (D1/D4 "not yet fixed" markers), `incomplete-jam.md:29-30,79-103` ("none fixed yet"), `docs/jam-p0-fixes.md` + `docs/JAM-INTEGRATION-COMPLETE.md` (status headers claiming pending/complete work for files deleted in Task 1), `docs/jam-defects-d1-d4.md:228` (stale TODO)

**Interfaces:**
- Consumes: Task 1's landed state (defects D1–D4 fixed; dead files gone).
- Produces: docs consistent enough that Task 9's final grep passes; no other task edits these files again.

- [ ] **Step 1: Read each stale location and rewrite the marker to the true state**

For `jam-p0-fixes.md` / `JAM-INTEGRATION-COMPLETE.md`: prepend a status note — controller.js / qr-scanner.js / social-refactored.js were never integrated and have been deleted; the shipped fixes are the in-place changes to `social.js`, `playback.js`, `shortcuts.js`, `mobile/jam.js` (cite `docs/jam-defects-d1-d4.md`). For `listen-together.md` / `incomplete-jam.md`: flip D1/D4 markers to FIXED with date 2026-10-07/08 and cite the fix files.

- [ ] **Step 2: Grep for any remaining stale claims**

```powershell
git grep -n -i "not yet fixed\|NOT fixed yet\|none fixed\|none of the four" -- docs incomplete-jam.md
```
Expected: 0 hits (if a hit is legitimately about a *different* open item, leave it and note why).

- [ ] **Step 3: Commit**

```powershell
git add docs/listen-together.md incomplete-jam.md docs/jam-p0-fixes.md docs/JAM-INTEGRATION-COMPLETE.md docs/jam-defects-d1-d4.md
```
Read `git diff --cached --stat`, then `git commit -m "docs(jam): truth-up D1-D4 status and retire dead-file integration claims"`.

---

### Task 3: Audit A — room bind/invite derivation, reconnect paths, platform cfg (spec §4C items 1, 5, 6)

**Files:**
- Create: `docs/jam-audit-findings.md`
- Read: `app/src-tauri/src/room.rs` (bind + `urls` derivation + `revert_failed_guest`), `app/src/lib.rs:1676-1682` (command registration), `app/src/social.js` room listener, `app/src/mobile/jam.js` boot listener
- Modify (only if a defect is proven): fix files + their tests, docs-first

**Interfaces:**
- Consumes: Task 1 landed code.
- Produces: `docs/jam-audit-findings.md` with one section per spec §4C item (1, 5, 6) — each entry: evidence (file:line), verdict (DEFECT / OK / KNOWN-LIMITATION), and fix reference if any. Task 9 greps this file exists and is non-empty.

- [ ] **Step 1: Trace invite URL derivation and write the finding**

How does the host advertise its address (`urls` from `room_open`/`room_info`)? On a multi-homed machine (Wi-Fi + Ethernet + VPN), which IP wins? Is IPv6 offered? Record verdict with file:line. DEFECT → fix in Step 4.

- [ ] **Step 2: Trace listener rebind / reconnect paths and write the finding**

What happens when the guest's network drops and returns, or the host sleeps? Does the room listener re-arm (the 07d defect class: listener coupled to mode entry — verify the boot-attach fix from 07b is still present)? Unit suites can't see this — read the code paths and record DEFECT / OK / KNOWN-LIMITATION.

- [ ] **Step 3: Confirm platform-cfg claim and write the finding**

Zero `cfg(...)` in `room.rs` outside tests, room commands registered unconditionally (`lib.rs:1676-1682`). Verify still true; confirm `cargo check` passes (it does if Task 1's clippy ran over all targets). Record.

- [ ] **Step 4: Fix proven defects (TDD, docs-first)**

Only for DEFECT verdicts that break documented behavior (spec §4 scope cap): write the failing test first (Rust: in `room.rs` `#[cfg(test)]`; JS: `app/tests/room.test.mjs`), run to see it fail, implement, run to pass, `cargo fmt --check` + clippy again. Document the fix in `docs/jam-audit-findings.md` **before** the code edit. Larger-than-expected fix → stop, record as KNOWN-LIMITATION, continue.

- [ ] **Step 5: Commit**

```powershell
git add docs/jam-audit-findings.md
# + any fix files from Step 4
```
Read `git diff --cached --stat`, then `git commit -m "docs(jam): audit A findings — bind/invite, reconnect, platform cfg"` (+ separate fix commit if Step 4 fired).

---

### Task 4: Audit B — Android cleartext + iOS readiness (spec §4C items 2, 3)

**Files:**
- Modify: `docs/jam-audit-findings.md` (append sections)
- Read: `app/src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml` (and `src/release`/`src/debug` source sets), `app/build.sh:101`, `.github/workflows/ios.yml`, `app/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: `docs/jam-audit-findings.md` from Task 3.
- Produces: two new sections — "Android cleartext" and "iOS readiness" — each with verdict + evidence. The Android section's verdict feeds Task 7's LAN-join expectation; the iOS section feeds Task 8's runbook.

- [ ] **Step 1: Determine whether Jam traffic ever crosses the WebView**

Room WS = native Rust socket (`room.rs`) — P23 already states cleartext config doesn't govern native sockets. Streaming relay = `http://127.0.0.1:{port}` — loopback, permitted by the release config (P23). List every Jam-related URL and its transport (native vs WebView); if any WebView cleartext URL exists (e.g., LAN `devUrl` in debug — expected), note it. Verdict: likely OK — but cite file:line for each row.

- [ ] **Step 2: Audit iOS**

From `ios.yml` + `tauri.conf.json`: what does CI actually prove (build only)? Does any generated Info.plist / capability step address ATS for `ws://`? `gen/apple` doesn't exist locally (never inited on this machine) — record that as an explicit UNKNOWN to be checked first on real hardware. Verdict: OK / UNKNOWN / DEFECT.

- [ ] **Step 3: Commit**

```powershell
git add docs/jam-audit-findings.md
```
Read `git diff --cached --stat`, then `git commit -m "docs(jam): audit B findings — Android cleartext transport map, iOS ATS unknowns"`.

---

### Task 5: CI coverage — add `npm test` to `ios.yml`, verify the others (spec §4C item 4, §4D.2)

**Files:**
- Modify: `.github/workflows/ios.yml` (insert after `npm ci` block ~line 57, before `npm run css`)

**Interfaces:**
- Consumes: nothing (independent).
- Produces: every workflow runs the Jam suites where runnable: `ci.yml` (lint+test, verified), `linux.yml` (test @79, verified), `macos.yml` (test @74, verified), `ios.yml` (**test missing — this task adds it**).

- [ ] **Step 1: Write the failing check — parse `ios.yml` and assert a `run: npm test` step exists**

```powershell
node -e "const fs=require('fs');const y=fs.readFileSync('.github/workflows/ios.yml','utf8');if(!/run: npm test/.test(y)){console.error('MISSING npm test step');process.exit(1)};console.log('ok')"
```
Expected: FAIL (`MISSING npm test step`).

- [ ] **Step 2: Insert the test step into `ios.yml`**

Mirror `ci.yml`'s shape: after `Install frontend dependencies` (`npm ci`), add:

```yaml
      - name: Run frontend unit tests (Node test runner)
        working-directory: app
        run: npm test
```

- [ ] **Step 3: Re-run the check**

Same command as Step 1. Expected: `ok`.

- [ ] **Step 4: Structural YAML validation**

No YAML parser is guaranteed in this repo, so validate by reading: display the insertion with context and confirm indentation matches the sibling steps (6 spaces for `- name:`, 8 for `working-directory`/`run` — same as `ci.yml`):

```powershell
Select-String -Path .github/workflows/ios.yml -Pattern "npm test|npm ci|npm run css" -Context 2,1
```
Expected: the new `npm test` step sits between `npm ci` and `npm run css`, indented identically to its neighbors. (Real YAML validity is proven when the workflow runs — pending push per rule 1.)

- [ ] **Step 5: Commit (CI green is PENDING PUSH per rule 1)**

```powershell
git add .github/workflows/ios.yml
```
Read `git diff --cached --stat`, then `git commit -m "ci(ios): run frontend unit tests incl. jam suites"`. Note in the final report: this workflow's first green run needs a push — mark "pending push".

---

### Task 6: Live verification (Windows) — `npm run tauri dev` smoke + harness gate

**Files:**
- Create: temporary probes outside the repo or in `%TEMP%\opencode` (precedent) — repo stays clean
- Modify: `docs/listen-together.md` §10 runbook (findings only, in Task 8 — but record evidence here)

**Interfaces:**
- Consumes: Tasks 1–5 landed.
- Produces: evidence block (commands, pass counts, timestamps) for the final report; defect reports feed Task 3/4 docs if new defects appear.

- [ ] **Step 1: Interactive smoke via `npm run tauri dev` (user-mandated method)**

```powershell
npm run tauri dev
```
In the running app: Social → open a room → confirm invite code + `ws://` URL render, chat sends, mode banner shows HOST, leave returns to Solo. This is a **human/eyeball check** — CDP cannot attach through `tauri dev` (AGENTS.md environment finding), so do not try `live-desktop.mjs` against it. Expected: no console errors, room opens.

- [ ] **Step 2: Automated harness against a cargo-built binary**

```powershell
cargo build
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
.\target\debug\trance-music.exe
node tests\live-desktop.mjs
```
Expected: **32 pass / 0 fail** (baseline from 2026-10-07b; if the baseline drifted, record the new number — 0 fail is the bar).

- [ ] **Step 3: Manual socket-blip check (Review Focus 5)**

While the harness room (or a dev-mode room) is open with a second participant: disable/enable the network adapter briefly, or pause the host process ~10s. Observe: guest shows a clear error/unavailable state, and after restore the guest can rejoin or the host recovers — no silent frozen "1 online". Record the observed behavior as OK / KNOWN-LIMITATION in your evidence block (fix only if it matches a documented behavior break → Task 3 Step 4 pattern).

- [ ] **Step 4: Record evidence**

Pass counts, timestamps, what was eyeballed vs asserted. Nothing committed yet (evidence lands in AGENTS.md/CHANGELOG in Task 9).

---

### Task 7: Live verification (Android emulator) — real APK two-device gate + LAN join

**Files:**
- Modify: none expected; fixes (if any) follow Task 3 Step 4 pattern
- Evidence: same evidence block as Task 6

**Interfaces:**
- Consumes: Task 4's cleartext verdict (expected: room WS native → OK).
- Produces: emulator pass counts + LAN-join verdict for the final report.

- [ ] **Step 1: Build + install the debug APK**

```powershell
npm run css
npx tauri android build --debug --target x86_64
adb install -r "gen\android\app\build\outputs\apk\x86_64\debug\app-x86_64-debug.apk"
```
Expected: Success. (Check the actual APK path under `gen/android/app/build/outputs/apk/` — universal vs per-ABI varies by invocation; AGENTS.md notes a universal APK at `apk/universal/debug/`.)

- [ ] **Step 2: Run the emulator harness**

```powershell
node tests\live-android-emulator.mjs
```
Expected: **28 pass / 0 fail** (2026-10-07b baseline; 0 fail is the bar). This harness historically uses adb-forward loopback — note which transport it actually exercised (read its setup lines first).

- [ ] **Step 3: Join via real LAN IP (Review Focus 1 — the untested path)**

Host a room on Windows (`tauri dev` or the harness binary), get the PC's LAN IP (e.g. `192.168.x.x`), and have the emulator guest join `ws://<pc-ip>:8787` **without** `adb reverse`. Emulator reaches the host via its NAT (10.0.2.2 or the LAN IP both work). Drive it the same way the harness does (CDP via `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`), or extend a copy of the harness in `%TEMP%`. Expected: join succeeds, chat echoes, host playback change reaches the guest. If it fails with a cleartext/refused error → that's Review Focus 1 confirmed → fix per Task 4 verdict + docs-first.

- [ ] **Step 4: Reverse direction — Android host, Windows guest**

The 07e baseline covered this; re-run it after any Task 3/4/7 Step 3 changes touched `room.rs` or `jam.js`. Expected: chat both ways, playback follow, **pause broadcast** (D4 regression check).

- [ ] **Step 5: Record evidence**

Per-step pass/fail + which transport each test used (loopback vs LAN).

---

### Task 8: Repeatable gates — runbook updates + Apple field runbook

**Files:**
- Modify: `docs/listen-together.md` §10 runbook (add the exact Task 6/7 command blocks as the standing two-device gate)
- Create: `docs/jam-apple-field-runbook.md`

**Interfaces:**
- Consumes: Task 6/7 evidence (exact commands that worked).
- Produces: `docs/jam-apple-field-runbook.md` — standalone steps for a hardware owner: prerequisites (macOS + iPhone/Xcode), build (`npx tauri build` / `tauri ios init` + `tauri ios build`), first checks (**ATS/cleartext `ws://` — Task 4's UNKNOWN**, invite URL correctness on Apple hardware), room open/join, chat, playback follow, pause broadcast, transport lock, drift badge, expected values (drift ±0.4s or better per §10), and a results table to fill in.

- [ ] **Step 1: Write the desktop↔Android gate commands into `listen-together.md` §10**

Copy the verified command sequences from Tasks 6–7 (dev smoke, harness, emulator, LAN join), each with expected pass counts and the known traps (tauri dev vs CDP, PowerShell `$env:`, no-chained-push).

- [ ] **Step 2: Write `docs/jam-apple-field-runbook.md`**

Per the Produces block — ordered steps an outsider can follow with zero context, marking every unverified-live claim with ⚠️. Include Task 4's iOS unknowns as "check before anything else".

- [ ] **Step 3: Commit**

```powershell
git add docs/listen-together.md docs/jam-apple-field-runbook.md
```
Read `git diff --cached --stat`, then `git commit -m "docs(jam): standing two-device gate in runbook + Apple field runbook"`.

---

### Task 9: Final gates, CHANGELOG, AGENTS.md entry, report

**Files:**
- Modify: `CHANGELOG.md` (Unreleased), `AGENTS.md` (append session entry — evidence required per header), `docs/jam-audit-findings.md` (close out any TODOs)

**Interfaces:**
- Consumes: everything Tasks 1–8 produced.
- Produces: the final verified/unverified matrix; working tree with only other-session WIP left dirty.

- [ ] **Step 1: Full gate re-run**

```powershell
npm test
npm run lint
cargo fmt --check
cargo clippy --all-targets -- -D warnings
$env:OP_OFFLINE="1"; cargo test --lib
git grep -n -i "not yet fixed\|NOT fixed yet\|none fixed" -- docs incomplete-jam.md
```
Expected: all clean; grep 0 hits.

- [ ] **Step 2: CHANGELOG + AGENTS.md**

CHANGELOG Unreleased: Fixed (D1 catalog fallback + role gates landed), Added (Apple runbook, audit findings doc, ios.yml tests), CI (ios.yml npm test — pending push). AGENTS.md: append dated entry — what was adopted, audit verdicts, live evidence (both harness counts, LAN-join result), files touched, "committed locally, not pushed (rule 1)".

- [ ] **Step 3: Commit**

```powershell
git add CHANGELOG.md AGENTS.md
```
Read `git diff --cached --stat`, then `git commit -m "docs: changelog + agent memory for jam stabilization pass"`.

- [ ] **Step 4: Produce the final report (no push)**

```powershell
git log --oneline origin/main..HEAD
```
Report: per-platform verification matrix with real evidence (Windows live ✅/❌ + counts, Android live ✅/❌ + counts, Linux/macOS CI = last known green + tests confirmed in workflow, iOS = workflow built + runbook written + pending push), every commit listed, explicit "nothing pushed" statement.
