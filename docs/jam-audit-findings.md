# Jam Audit Findings — cross-platform stability pass

Part of the stabilization effort: `docs/jam-stabilization-spec.md` §4 Phase C,
driven by `docs/jam-stabilization-plan.md` Tasks 3–4. Each entry: evidence
(file:line), verdict, and fix reference when a fix landed. Verdicts:

- **DEFECT** — breaks documented behavior; fixed here (docs-first) or referenced.
- **OK** — behavior matches the docs; evidence recorded.
- **KNOWN-LIMITATION** — real edge-case gap, honest as-is; fix direction noted
  for a future effort that wants to expand scope.

Audited state: HEAD after `b668305` (2026-10-08), i.e. D1–D4 all fixed and
committed (`6f2f302` landed the D1 catalog fallback + role gates).

---

## A1 — Room server bind + invite URL derivation

**How the server binds:** `0.0.0.0:<port>` — every interface — with an
ephemeral-port fallback if the default port is taken
(`room.rs:758`, `room.rs:773-774`). All of the host's NICs are reachable;
the room does not care which address a guest uses.

**How the invite address is chosen:** `lan_urls(port)` (`room.rs:152-190`):

1. UDP-connect trick to `8.8.8.8:80` / `1.1.1.1:80` → the **default-route**
   interface's IPv4, without sending a packet (`room.rs:161-170`).
2. `COMPUTERNAME`/`HOSTNAME` lookup → more private IPv4s (`room.rs:171-182`).
3. Loopback appended last so a same-machine test always works
   (`room.rs:188`).
4. **IPv4 only** — the collector takes `Ipv4Addr` / `SocketAddr::V4`
   (`room.rs:155`, `:164`, `:177`); an IPv6 literal is never offered.

`inviteText(state)` (`room.js:141-146`) renders **`urls[0]` only** —
`"ws://<lan-ip>:<port> · CODE"` (`listen-together.md:271`). `room_info`
recomputes `urls` live (`room.rs:948`), so a re-attached UI re-offers a
current invite.

**Verdict: OK (single-homed, the documented case) · KNOWN-LIMITATION
(multi-homed / VPN / IPv6).**

- Single-homed LAN — every live run to date, including Windows↔Android over
  real Wi-Fi — gets the right address: default route *is* the LAN.
- **Multi-homed (VPN up):** the VPN owns the default route, so `urls[0]` can
  be the VPN's virtual-adapter IP; LAN guests can't dial it. The room still
  *works* — the server binds `0.0.0.0` and the join sheet accepts any
  private address + code typed manually — only the advertised line is
  wrong. This is the exact "Multi-NIC wrong IP" item
  `jam-p0-fixes.md:23` listed; its proposed fix ("enumerate ALL interfaces,
  show all candidate URLs in UI", `jam-p0-fixes.md:83-90`) was **planned,
  never implemented** (that doc is retired as historical by commit
  `b668305`).
- **IPv6-only LANs:** unsupported (invite and `is_private_host` IPv6
  acceptance are loopback-only, `room.rs:108`). No documented promise of
  IPv6 exists.

**Fix direction (not taken — scope cap, spec §4C):** enumerate all
non-loopback IPv4s as candidates and show all of them in the invite row on
both surfaces (the `jam-p0-fixes.md` §4 design). Cost: two-surface UI change
+ tests → a future feature-sized effort, not a stability fix.

## A2 — Listener attach + reconnect / drop paths

**Boot attach (the 07b/07d defect class): fixed and still present.**

- Desktop: `startRoomListener()` is called at module init
  (`social.js:926-929`, comment names the defect); the latch
  `listenerReady` stays clear when `__TAURI__` is absent so a later call can
  retry (`social.js:491-501`). Entering Social is *not* a precondition.
- Mobile: listener attached during `jam.js` init (`jam.js:886-888`), before
  any mode entry; boot reconcile closes a stale guest socket or adopts a
  live host room (`jam.js:891-903`).

**Join-failure latch (D2): both layers present** — `revert_failed_guest`
runs before the `error` frame (`room.rs:616-627`, `:631`, `:646`), and the
UI calls `room_close` when an `error` arrives while joining
(`social.js:454-465`).

**Established-session drop:** when the socket dies (host app closed, network
loss, sleep that kills the peer), `guest_run` exits its loop and emits an
honest `bye` — `"Connection to the room was lost."` (`room.rs:681-688`).
The UI resets to Solo, clears mirror/drift state, and toasts the reason
(`social.js:467-478`). No silent frozen state.

**Reconnect: none — and none is documented.** `git grep` over
`docs/listen-together.md` finds no auto-reconnect promise; recovery is
"rejoin from the invite", which D2's fix now permits without an app restart.

**Verdict: OK.** Sleep/wake or network-switch mid-room requires a manual
rejoin — honest, recoverable, documented-by-behavior. Auto-reconnect would
be a new feature (out of scope, spec §7).

## A3 — Platform `cfg` surface

- `room.rs`: the only `cfg(` in the file is `#[cfg(test)]` at `room.rs:961`.
  The server/client code is identical on every target — no platform branch
  to diverge.
- Commands: all seven room commands sit in the **unconditional**
  `invoke_handler` (`lib.rs:1674-1682`); the `#[cfg(desktop)]` at
  `lib.rs:1667` gates only the tray build (`lib.rs:1668-1670`).
- Compile health: `cargo clippy --all-targets -- -D warnings` green in the
  adoption run (Task 1, 45 s incremental). Cross-target proof comes from the
  build matrix: Windows local, Android built locally many times,
  macOS/Linux/iOS via CI workflows (green on last runs — see
  `AGENTS.md` CI table; latest-run confirmation is pending a push per rule 1).

**Verdict: OK.** Room commands exist on every target; mobile targets get
them through the same registration path as desktop.

---

## B1 — Android cleartext: does Jam traffic ever cross the WebView?

Every Jam-related URL and its transport (this is the map Task 7's LAN-join
test runs against):

| # | URL | Transport | Cleartext governed by | Verdict |
|---|---|---|---|---|
| 1 | `ws://<lan-ip>:8787` (room protocol) | **native Rust socket** — tokio-tungstenite in `room.rs:691-701` | nothing WebView-side; needs only `INTERNET` permission (in the manifest, AGENTS.md 07f) | **OK — not affected by cleartext config** |
| 2 | `http://127.0.0.1:{port}/stream`, `/art` (relay) | WebView `<audio>`/img | release `network_security_config.xml`: cleartext permitted for `127.0.0.1`, `localhost`, `[::1]` only; `base-config` false | **OK — loopback is explicitly permitted** |
| 3 | catalog `resolve_song` (D1 fallback) | **native Rust** — Tauri command, Rust does the HTTP | n/a | **OK** |
| 4 | `http://<pc-ip>:1430` (devUrl) | WebView, **debug builds only** | debug config: `cleartextTrafficPermitted="true"` everywhere (`app/src/.../debug/res/xml/network_security_config.xml`) | **OK — expected in dev; never ships** |
| 5 | invite QR / invite text | rendered locally (`qr.rs`, no network) | n/a | **OK** |

Config evidence (both files read this session):

- **Release:** `gen/android/app/src/release/res/xml/network_security_config.xml`
  — loopback-only `<domain-config cleartextTrafficPermitted="true">`,
  `<base-config cleartextTrafficPermitted="false"/>`; its comment states a
  present config makes Android ignore `usesCleartextTraffic` (P23).
- **Debug:** `gen/android/app/src/debug/res/xml/network_security_config.xml`
  — cleartext everywhere, with the devUrl rationale in its comment.
- Injection point: `app/build.sh:101` (sed adds
  `android:networkSecurityConfig`).

**The spec's headline risk (§8: "phone joins PC room over real LAN may be
blocked") dissolves for the room protocol:** `ws://<pc-ip>:8787` from the
phone is a **native Rust socket**, and neither `usesCleartextTraffic` nor
`networkSecurityConfig` governs native sockets — they govern the WebView
(P23 states the same for the relay). What *was* only ever tested through
adb tunnels is the WebView side, and the only WebView cleartext URLs Jam
has are loopback (row 2), explicitly permitted in release.

**Verdict: OK.** Task 7 should still run the LAN-join step — an
evidence-first effort proves the analysis — but the expected result is
success.

## B2 — iOS readiness (what CI proves, ATS unknowns, backgrounding)

**What `ios.yml` proves: build, nothing else.** The workflow is
`workflow_dispatch`-only (`ios.yml:19`), runs `npx tauri ios init --ci`
(`:83`), then `tauri ios build --ipa` signed (`:90`) or
`--no-sign --target aarch64-sim` simulator (`:108`), and uploads the
archive (`:157-166`). **No `npm test` step exists in it** (Task 5 adds one);
no run/test-on-device step at all. A green iOS run therefore says
"compiles for iOS", never "works on iOS".

**ATS (NSAppTransportSecurity): explicit UNKNOWN.** `git grep` for
`NSAppTransportSecurity` over the repo: **no hits**. No `*.plist` /
`*.entitlements` files are tracked. `gen/apple` does not exist on this
machine (`tauri ios init` has never run here), so the generated
`Info.plist` cannot be inspected locally. What this leaves open, in order
of importance for Jam:

1. **The relay loads** — the WebView fetches `http://127.0.0.1:{port}`
   (stream + art). If the generated Info.plist carries no ATS exception
   and ATS applies to loopback HTTP in WKWebView, playback art/stream would
   fail exactly like P23 did on Android. (The room WS is *not* exposed to
   ATS — native socket, row 1 of B1.)
2. **Background suspension** — a backgrounded iOS app suspends the WebView
   and kills idle sockets. Expected behavior per the Audit A reading: the
   guest's WS drops → `guest_run` emits `bye "Connection to the room was
   lost."` (`room.rs:681-688`) on resume-adjacent I/O; whether the UI
   recovers cleanly or shows a stale room until interaction is
   **untested**.
3. **CSP interaction** — `tauri.conf.json:40` allows
   `connect-src ... ws://127.0.0.1:*` (loopback only) — irrelevant to the
   native room socket today, but it means a WebView-originated room socket
   could never dial a LAN host; keep the room WS native on iOS (it is).

**Verdict: UNKNOWN (→ first checklist items for the Apple runbook,
Task 8).** No DEFECT can be declared or denied from this machine; the
runbook must check the generated `Info.plist` for ATS and run the
three Jam flows (open/join, relay playback, background-return) on real
hardware before iOS can be called verified-live (spec D-b: CI + runbook
only).

---

## C - Live verification defect D5 (found 2026-10-08, Task 7)

Audits A/B were code-read at rest; D5 only shows up when a real host leaves a
real room with a guest still connected. Found by the Task 7 LAN-join probe
(emulator guest over real LAN) and confirmed the same evening by the Task 6
blip probe's raw-socket evidence.

**Symptom.** Host closes the room while a guest is connected. The guest UI
resets correctly (Solo / NO ROOM — it applies the server's `bye`), but the
guest **backend stays `Mode::Guest`**: `room_info` → `{role:"guest"}`. The
next join attempt is refused verbatim —
`Leave the current room before joining another.` — while every visible surface
reads Solo, so the guest cannot join *any* room until an app restart (or an
explicit `room_close`, e.g. the mobile sheet's Leave Jam). This is P32's exact
toast with a different trigger: P32/D2 covered the *failed dial*; D5 is the
*successful session ended by the host*.

**Evidence (2026-10-08).**
- Blip probe (Task 6): host `Leave` → raw guest received
  `bye` +29 ms (`The host closed the room.`), listener immediately
  `ECONNREFUSED`, yet the guest socket stayed **open 30 s+** — axum's
  `with_graceful_shutdown` (`room.rs:579`) drains existing connections and
  waits for the *client* to close; a server that already said bye never does.
- LAN probe (Task 7): after the same sequence the mobile guest's backend read
  `{"role":"guest"}` while the banner read `NO ROOM`; rejoining the fresh
  room showed `Leave the current room` in the body for ~4.5 s, the join card
  closed, host stayed `1 online`.

**Root cause.** `guest_run`'s pump loop (`room.rs:655-680`) treats the
server's `bye` text frame like any other inbound frame: it is forwarded to the
UI and the loop keeps waiting — but after a host `close()` the server
broadcasts `bye` (`room.rs:438`) and then only *drains*, so the loop never
exits, the D2 failure-exit reverts (`:623/:631/:646`) never run, and the
socket is never dropped. The desktop guest shares this code path; the phone
was simply where it was observed.

**Fix (this pass).** The pump is extracted into `guest_pump` returning an end
state (`LocalClosed` / `ServerBye(frame)` / `Lost`). On `ServerBye`,
`guest_run` reverts the mode to `Idle` **before** forwarding the `bye` to the
UI (the D2 ordering rule: backend state and the frame the UI reacts to must
agree), sends the server's own frame (no synthetic fallback → one toast), and
closes the socket so the host's drain completes. `Lost` keeps the existing
`Connection to the room was lost.` fallback; `LocalClosed` emits nothing
(`room_close` already sent `bye{left}` and set `Idle` —
`room.rs:911` replaces the mode up front, so the revert there is a guarded
no-op).

**Verification (all 2026-10-08, this pass).** TDD: `cargo test --lib` — the new
`guest_pump_ends_promptly_on_server_bye` failed RED at the 2.01s timeout against
the old loop (the standoff reproduced mechanically) and went green with the fix;
`guest_pump_reports_local_close` and `guest_pump_reports_lost_socket` cover the
other two end states. Full gates: fmt, clippy `-D warnings`, cargo **185/185**,
npm **250/0**, lint. End-to-end on rebuilt surfaces: the LAN probe (emulator
guest, real LAN, no adb tunnels) — after the host left, the guest's `room_info`
read `{"role":"idle"}` (the pre-fix failure mode was `guest`) and the guest
rejoined the fresh room, exit 0; the reverse probe (Android host, desktop guest
over adb forward) — host bye → desktop backend `idle` → rejoined, plus the D4
pause/resume broadcast regression, 19 pass / 0 fail. The mobile harness stayed
28/0.

---

## Summary

| Item | Verdict | Action |
|---|---|---|
| A1 bind/invite derivation | OK (single-homed) · KNOWN-LIMITATION (multi-homed/VPN, IPv6-only) | none — fix direction recorded above |
| A2 listener attach + drop paths | OK | none |
| A3 platform cfg surface | OK | none |
| B1 Android cleartext vs Jam transports | OK — room WS is native, only relay is WebView-cleartext and loopback is permitted | none; Task 7 still runs LAN join as evidence |
| B2 iOS readiness | UNKNOWN — CI proves build only; ATS + backgrounding unchecked (`gen/apple` absent locally) | runbook checklist (Task 8); `npm test` into `ios.yml` (Task 5) |
| D5 guest mode after host bye | **DEFECT (live verification, Task 7)** — fixed this pass (§C) | unit test + live rejoin probe |

No DEFECT verdicts in the code-read audits (A/B) — nothing in the bind/invite,
reconnect, platform-cfg, Android-cleartext or iOS-readiness surfaces can be
shown to break documented behavior at this HEAD. The one DEFECT this effort
found (D5) only appeared under live two-device verification — see §C. Known gaps are recorded
honestly above: invite can show a VPN IP on a multi-homed host; IPv6-only
LANs unsupported; iOS is build-verified only until the Apple runbook is
executed on hardware (spec D-b). Recoverability holds throughout: the room
server binds every interface and the join sheet accepts a manually typed
address.
