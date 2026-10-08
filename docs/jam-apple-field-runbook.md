# Jam Apple field runbook — macOS + iPhone (first execution = the verification)

**Status: never run on Apple hardware.** `ios.yml` proves *build only*
(`workflow_dispatch`, `macos-14`, `tauri ios init --ci` → `tauri ios build`,
archive uploaded — no device run), `gen/apple` does not exist in this
checkout, and there is no tracked `*.plist`. Every ⚠️ below is a claim this
repo has never observed live; fill the results table on first execution and
replace the ⚠️ with the measured value. Context: `docs/jam-audit-findings.md`
§B2 (iOS readiness), §A1 (invite derivation), spec D-b of
`docs/jam-stabilization-plan.md` (this document is the deliverable).

---

## 0. Check before anything else (the standing iOS unknowns)

These are §B2's open questions, ordered by what breaks the first session:

1. ⚠️ **ATS / cleartext — the relay, not the room.** The room WebSocket is a
   *native* tokio socket (§B1: it never crosses WKWebView), so ATS cannot
   block `ws://` join traffic. What ATS **can** break is the WebView's
   `http://127.0.0.1:{port}` loads (stream + art) — the exact P23 failure
   mode Android had. After `tauri ios init`, open
   `gen/apple/Runner/Info.plist` and look for `NSAppTransportSecurity` →
   `NSAllowsArbitraryLoads` (or a loopback exception). **No entry = expect
   silent no-audio.** Record what you find either way.
2. ⚠️ **Local Network permission (iOS 14+).** The first LAN dial prompts
   *"allow TRANCE MUSIC to find and connect to devices on local networks"* —
   deny produces a join timeout indistinguishable from a firewall drop.
   Answer Allow; re-check Settings → Privacy → Local Network if a join
   fails.
3. ⚠️ **Invite URL correctness.** The invite line comes from the
   default-route interface (`room.rs` `lan_urls`); cellular/Wi-Fi/VPN
   multi-homing can advertise a wrong IP (known limitation A1). Compare the
   invite's IP with Settings → Wi-Fi → (i) — the join sheet always accepts a
   manually typed address, so a bad invite line is a wrong hint, not a
   dead end.
4. ⚠️ **CSP stays loopback-only.** `tauri.conf.json` `connect-src` allows
   `ws://127.0.0.1:*` only — a WebView-originated socket could never dial a
   LAN host. Keep the room WS native on iOS (it is today); do not
   "fix" a join failure by adding CSP entries.
5. ⚠️ **Backgrounding.** A backgrounded app suspends the WebView and drops
   the room socket. Expected after the D5 fix: the guest surfaces
   `bye "Connection to the room was lost."`, state reads Solo, and a manual
   rejoin works. Whether that UI recovery is *clean* (no stale banner) is
   untested — exercise it deliberately (step 8).

## 1. Prerequisites

- macOS with Xcode (current stable): `xcodebuild -version` must work.
- Apple ID signed into Xcode (Settings → Accounts) for device deployment.
- Node ≥ 20, Rust stable (`rustup default`), this repo cloned.
- An iPhone on the same Wi-Fi as the machine that will host (or vice versa).
- One-time: `npm install` in the repo root.

## 2. Build (⚠️ CLI form below is the P28-safe one; CI reference is ios.yml)

```powershell
# first time only — creates gen/apple (gitignored; never commit it)
npm run tauri -- ios init

# device build: easiest path is Xcode
#   open gen/apple/App.xcodeproj → select your Team under Signing &
#   Capabilities → pick the iPhone → Run (▶)
#
# or from the CLI (signing config required for a real device):
npm run tauri -- ios build --target aarch64-apple-ios
```

- Do **not** use bare `npx tauri` at the repo root: global/local CLI skew
  breaks it (P28, observed on Windows; same class of failure anywhere).
- CI equivalent: `.github/workflows/ios.yml` (`workflow_dispatch`) — it
  builds `--ipa` when signing secrets are configured, else
  `--no-sign --target aarch64-sim`, and runs `npm test` first. A green run
  there still says *compiles*, never *works*.

## 3. Room open / join

On the iPhone (host): Now Playing → **Social** → **Start a Jam**.
Expected: role badge `HOST`, banner `#XXXXXXXX` (8 chars), invite line
`ws://<ip>:8787 · XXXXXXXX`, member count **1**.

On the other device (guest — the Mac building this, or a Windows PC per
§10): enter address + code → **Join**.
Expected within a couple of seconds: member count **2** on both sides, a
system chat line naming the joiner, guest badge `GUEST`. ⚠️ On failure,
first suspects are checklist items 1–2 above, then the room's own error
text (the UI prints server words verbatim).

## 4. Chat

Type on each side → appears on the other (and exactly once on the sender).
A second line sent immediately → verbatim `rate_limited` rejection.

## 5. Playback follow

Host plays a track. Expected on the guest within ~1 s: same title/artist,
its own `<audio>` running. ⚠️ A **fresh** guest device may take longer —
the D1 catalog fallback (`resolve_song`) engages when the id is not in the
local library; a few seconds is pass, `NOT ON THIS DEVICE` + no audio is
fail.

## 6. Pause broadcast (D4 regression)

Host pauses → guest pauses within ~1 s; host resumes → guest resumes.
(Both directions are covered by `app/tests/live-reverse-pair.mjs` on
Windows↔Android; on Apple this is a first-time observation. ⚠️)

## 7. Transport lock (guest side)

Guest taps play/pause/seek/skip → nothing moves, and the lock message
`The host controls playback in this room.` shows. Any effect = fail
(guest-transport gates were verified on Android/desktop only ⚠️).

## 8. Backgrounding (⚠️ deliberate test, step 0.5)

Lock the iPhone (or app-switch) for ~30 s while joined as guest, return.
Expected after the D5 fix: a clear `bye` (room lost / closed), UI reads
Solo — **not** a room that looks joined but ignores input. Rejoin must
succeed on the first try. Record what actually happens.

## 9. Drift badge

Compare the two progress bars at the same moment and read
`#jam-sync-value` / the banner drift. **Expected: ±0.4 s or better** (§10).
Record the number you saw; drift is only meaningful while both sides are
on the same track and playing.

## 10. Failure reporting

Paste the Jam pane status line and any `error` code verbatim (the UI shows
server words unchanged), plus device + iOS versions and which ⚠️ checks
passed.

---

## Results table (fill on first execution)

| # | Check | Date | Device / iOS | Result (observed value) |
|---|---|---|---|---|
| 0.1 | ATS entry present in generated Info.plist? | | | |
| 0.2 | Local Network permission prompt + Allow | | | |
| 0.3 | Invite IP matches actual Wi-Fi IP | | | |
| 0.4 | Background → return → clean bye + rejoin | | | |
| 3 | Room open + join (2 members both sides) | | | |
| 4 | Chat both ways + rate_limited | | | |
| 5 | Playback follow (time to first audio) | | | |
| 6 | Pause / resume broadcast | | | |
| 7 | Guest transport lock | | | |
| 9 | Drift measured | | | ±____ s |

Sign-off rule (spec D-b): iOS is "verified-live" only when every row above
holds a real observation on hardware — CI green alone is not this table.
