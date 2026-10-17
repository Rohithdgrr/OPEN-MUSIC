# Security posture — controls, warnings register, accepted risks

Written 2026-10-15. This is the register of security decisions so future
sessions can tell "accepted on purpose" apart from "missed".

**Threat model.** Single-user, local-first desktop + Android app. No server,
no accounts, no telemetry. The realistic adversaries are (1) untrusted
metadata/media from the upstream catalogue, (2) a hostile local process on
the user's machine, (3) script injection into the webview.

## Verified controls (audited 2026-10-15)

| Control | Where (evidence) |
|---|---|
| Strict CSP; script-src self + hashed inline; `connect-src` limited to self/ipc/loopback (mobile adds `generativelanguage.googleapis.com` only) | `app/src-tauri/tauri.conf.json` |
| Media URL allowlist — only `https://*.saavncdn.com`; `http:`, `file:`, `ftp:` and metadata IPs rejected (unit-tested) | `jiosaavn.rs:205`, tests `:1557-1565`; enforced at `proxy.rs:472`, `:1310` |
| Loopback relay is authenticated — random 32-byte per-session token, checked in query/header by middleware; Host/Origin validated | `proxy.rs:167-238`, `:996-1076` |
| Downloads are atomic — write `.part`, verify, rename; boot `sweep_partials` deletes stale prefixes; cancel deletes, pause keeps | `proxy.rs:218`, `:447-461` |
| Vault reads stream (no full-file buffering) | `proxy.rs:1208`, `:1418` (`Body::from_stream`) |
| Capabilities least-privilege — `core:default` for main+widget; the widget window additionally gets exactly 5 permissions (drag, always-on-top, ignore-cursor, close, events). No filesystem/shell/http grants | `capabilities/default.json`, `capabilities/widget.json` |
| Updater artifacts minisign-signed; CI signs from `TAURI_SIGNING_PRIVATE_KEY`; pubkey in conf verified byte-identical to `~/.tauri/open-music.pem` (2026-10-07) | `tauri.conf.json`, `docs/windows-release.md` |
| Dependency scanning — Dependabot weekly (npm, cargo, actions) + **blocking** `cargo audit` in `ci.yml` (made blocking 2026-10-15) | `.github/dependabot.yml`, `.github/workflows/ci.yml` |
| `open_external` goes through `tauri-plugin-opener` (single-argument ShellExecuteW / open / xdg-open) — no shell re-parses `&`, `^` or `%VAR%` in the URL (the old Windows `cmd /C start "" {url}` did) | `lib.rs` `open_external`, plugin registered at `lib.rs` builder |
| Relay redirect hops re-validated — `/art` refuses to serve bytes fetched (via redirect) from loopback/private/link-local hosts; `/stream` runs the same check on redirect hops only (a direct fetch is whatever the resolution chain chose, and the 403-purge path stays intact) | `proxy.rs` `art_origin_ok` + both fetch paths; regression test `stream_purges_stale_resolution_on_403` |
| Art bodies capped **while streaming** (was: buffer everything, then check `MAX_ART_BYTES`) — a hostile mirror cannot balloon memory with a chunked body | `proxy.rs` `/art` fetch loop |
| Room WebSocket frames capped at 64 KiB per message/frame — an unauthenticated LAN socket can no longer make axum buffer its 64 MiB default before the JSON parse rejects it | `room.rs` `MAX_WIRE_BYTES`, `ws_handler` |

## Accepted risks (decisions, not oversights)

| Risk | Rationale | Revisit when |
|---|---|---|
| Gemini API key in `localStorage` (`tm-gemini-key`, mobile) | The user's own key, on-device only, never synced or logged; CSP limits exfiltration paths | multi-user or shared-device story appears |
| `withGlobalTauri: true` | Simplest zero-build bridge for a vanilla-JS frontend; script-src is self-only + hashed inline | a plugin/extension ecosystem appears |
| Windows installer self-signed (`CN=TRANCE MUSIC`) | No paid OV/EV cert; SmartScreen warns until then. Not a signing defect — verified 2026-10-07 | an OV/EV cert is purchased |
| AI lyrics desktop button **removed** (2026-10-15) | It invoked an unregistered Rust command and had no key UI; AI lyrics are mobile-only by spec (`docs/feature-list.md:125`). Removed rather than half-built | desktop key parity is requested |

## Allowed `cargo audit` warnings (never fail CI)

| ID | Crate | Why acceptable |
|---|---|---|
| RUSTSEC-2024-0370 | `proc-macro-error 1.0.4` | unmaintained; build-time proc-macro only, never shipped |
| RUSTSEC-2024-0429 | `glib 0.18.5` | unsoundness in `VariantStrIter` iterator impls; pulled by Tauri's Linux GTK stack, we don't call that API; rides the next tauri/gtk bump |
| RUSTSEC-2026-0253 | `lru 0.16.4` | **dev-dependency** (via `rqrr`, tokenizer/QR tests); never in shipped binaries |
| — (yanked) | `yoke-derive 0.8.3` | transitively pinned; re-resolves on the next lock refresh |

Vulnerability findings, by contrast, **do** fail CI. The gate earned this
status on its first local run: it caught four advisories published the day
before (RUSTSEC-2026-0346…0349 against `rustls 0.23.45`), fixed by locking
`rustls 0.23.46` (`cargo update -p rustls`; re-audit clean; `cargo test
--lib` 206/206; `cargo build` exit 0).

## Known limits of the evidence

- CI job logs on this public repo need admin rights (403); step conclusions
  and annotations are the only readable channel (`docs/cross-platform-ci.md`).
- Apple platforms are build-verified only (no Apple hardware here); the
  field runbook is `docs/jam-apple-field-runbook.md`.
