# 05 — Mobile Versions

## Current version: 0.3.0

Single source of truth, kept in sync in three places:

| File | Field | Value |
| --- | --- | --- |
| `app/src-tauri/Cargo.toml:3` | `package.version` | `0.3.0` |
| `app/src-tauri/tauri.conf.json:4` | `version` | `0.3.0` |
| `app/package.json:4` | `version` | `0.3.0` |

App identifier (all platforms): `com.openmusic.trancemusic`
(`tauri.conf.json:5`). Product name: `TRANCE MUSIC`.

## History

| Version | Date | Mobile relevance |
| --- | --- | --- |
| `v0.1.0` | 2026-09-30 | Desktop-only. Signed MSI + NSIS (self-signed `CN=TRANCE MUSIC`). No mobile targets. See root `CHANGELOG.md`. |
| `v0.3.0` | (tag `v0.3.0` exists) | **First mobile-capable tree**: Android shell + `tauri.android.conf.json` / `tauri.ios.conf.json`, desktop plugins gated out of mobile targets, iOS CI, backup/CSV/M3U export, Drive sync scaffolding. Details in [Changelog](07-changelog.md). |

## IPC contract version

`api_version() -> 1` (`app/src-tauri/src/lib.rs:288-291`). The frontend checks
it once at boot; a renamed/missing command surfaces as a loud mismatch instead
of a silent `invoke` failure. **Bump it on any breaking command/parameter
change** and update both shells the same commit.

## Config / schema versions

- `"$schema": "https://schema.tauri.app/config/2"` — all three `tauri.*.conf.json`.
- Mobile overlays carry only what differs (`app.windows`, `security.csp`,
  `bundle.targets`); everything else inherits the base config at `--config`
  merge time.
- Capability schema: `gen/schemas/desktop-schema.json` referenced by
  `capabilities/default.json` and `widget.json`.

## Rust / toolchain pins

- `rust-version = "1.77"` (`Cargo.toml:6`); Tauri `2` (`Cargo.toml:14,16`).
- Android `reqwest` uses `rustls-tls` instead of default TLS
  (`Cargo.toml:58-59`) — required, Android has no system OpenSSL to link.
- iOS Rust targets: `aarch64-apple-ios`, `aarch64-apple-ios-sim`,
  `x86_64-apple-ios` (`ios.yml:65`).

## How to cut a mobile version

1. Bump all three version fields above + `CHANGELOG`/mobile changelog entry.
2. Push tag `vX.Y.Z` → `release.yml` builds desktop installers,
   `ios.yml` builds iOS on the same tag.
3. Android: build locally (`npx tauri android build --config
   tauri.android.conf.json`) and attach the APK/AAB to the release manually
   until an Android workflow exists.
4. If any Tauri command signature changed, bump `api_version()` too.
