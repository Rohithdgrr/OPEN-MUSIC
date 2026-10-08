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

## Summary

| Item | Verdict | Action |
|---|---|---|
| A1 bind/invite derivation | OK (single-homed) · KNOWN-LIMITATION (multi-homed/VPN, IPv6-only) | none — fix direction recorded above |
| A2 listener attach + drop paths | OK | none |
| A3 platform cfg surface | OK | none |

No DEFECT verdicts in Audit A — nothing in the bind/invite, reconnect, or
platform-cfg surfaces breaks documented behavior at this HEAD. The
known-limitation (invite can show a VPN IP on a multi-homed host; IPv6-only
LANs unsupported) is honest and recoverable: the room server binds every
interface and the join sheet accepts a manually typed address.
