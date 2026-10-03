# 07 — Mobile Changelog

Follows Keep a Changelog + SemVer (same as root `CHANGELOG.md`).
Desktop history stays in the root file; this file tracks **mobile-surface**
changes only.

## [Unreleased]

- _Nothing yet — add new mobile entries here._

## [0.3.0]

First mobile-capable tree (tag `v0.3.0`).

### Added

- **Android shell**: `app/src/mobile/` — `index.html` (hash-router entry, `#screen`
  + `<audio>`), `router.js` (fragment cache, canonical bottom nav, `__tmBack`),
  `app.js` (boot + delegation + mini-player paint), `shared.js` (invoke/`Channel`
  shim, storage keys, art ladder, toasts), `player.js` (queue + `mediaSession`),
  `binders.js` / `menus.js` / `radio.js` / `lyrics.js` / `legal.js`,
  13 `screens/*.html+*.js` (home, search, library, liked, album, artist,
  playlist, nowplaying, download, history, notification, analytics, settings).
- **Overlays**: `tauri.android.conf.json` + `tauri.ios.conf.json`
  (`mobile/index.html`, fullscreen, own CSP hash lists).
- **Mobile Rust gates**: desktop plugins confined to
  `cfg(not(android/ios))` (`Cargo.toml:38-50`); `reqwest` rustls on Android
  (`Cargo.toml:58-59`); mobile stubs for shortcuts / drag / unminimize and
  explicit mobile errors for `open_external`, `autostart_set`,
  `open_bluetooth_settings`, `export_file` (`lib.rs`).
- **iOS CI** (`.github/workflows/ios.yml`): signed `.ipa` or unsigned
  simulator `.app`, failure log posted to the `iOS build log` issue, `ios-build`
  artifact (14 days).
- Backup/CSV/M3U export, Drive sync scaffolding, better lyrics source,
  metadata NULL fix (shared core, mobile inherits).

### Fixed

- iOS target compile: dialog commands gated to `#[cfg(desktop)]`; iOS build
  uses official `--no-sign --target aarch64-apple-ios-sim` flags (no `--simulator`
  flag, no `pbxproj` hacks).

## [0.1.0] — 2026-09-30

No mobile surface. Desktop-only signed MSI + NSIS (self-signed cert).
Recorded here so the "when did mobile start?" question has one answer: **0.3.0**.
