# 07 — Mobile Changelog

Follows Keep a Changelog + SemVer (same as root `CHANGELOG.md`).
Desktop history stays in the root file; this file tracks **mobile-surface**
changes only.

## [Unreleased]

### Added — Studio shell on real backend data (`990655f`)

- `mobile/entry.js` now boots `studio/app.js` — the Studio SPA replaces the
  legacy hash-router bundle as the live Android UI. Real catalog via
  `home_feed` / vault / recent / favorites hydration; search, playback,
  library, downloads wired to Rust commands. Spec: `studio-real-data.md`.

### Added & Fixed — Studio UX batches (2026-11-21g/h/i/j)

- **Library**: feed albums + derived albums only — design-mock album cards
  dropped on hydration; Playlists "Yours" tab no longer falls back to
  curated feed cards (empty state instead).
- **Downloads screen**: hero/stat-card clutter removed; status tags
  (`DOWNLOADED`, `Saved offline`); filter boxes share the Search chrome.
- **Detail lists**: playlist/album filter defaults fixed (`"all"` → `""`)
  so full track lists render; Charts loads the real chart playlist via
  `playlist_tracks` (`chartTrackIds`, ~50 rows) instead of 5 countdown rows.
- **Artist merge**: one card per artist name; detail hero shows real
  catalogue art; follow state persists.
- **Search**: live `search_suggestions` dropdown while typing; Enter
  commits; recent searches recorded for played songs and entity-result
  taps; stale suggestions clear with the query.
- **Downloads fixed**: single `onProgress` Channel to `download_song`
  (duplicate `on_progress` arg broke Android downloads — verified live:
  "Vaulted" + vault entry). `FAILED` rows persist with error + Retry /
  Dismiss; pause → `pause_download`, resume → fresh `download_song`,
  cancel → `cancel_download`; parallel bulk sync retained.
- **Drag reorder**: queue rows, user-playlist rows, and now Liked Songs
  (`reorderLiked`, id-based).
- **Analytics**: computed from `store.history` — exposure, plays, unique
  tracks, HI-RES ratio, rhythm buckets, top artists, signature genre,
  peak window; honest empty states.
- **Theming**: Home + Now Playing forced-light blocks scoped to
  `html:not(.dark)` — dark mode renders the token palette (verified
  `rgb(14,15,17)` on device). Toast moved to bottom; top bar 56→48px,
  bottom tabs 64→52px.
- **Music Languages** settings chips: English, Telugu, Hindi, Tamil,
  Malayalam, Bhojpuri.
- **Android platform**: `MediaHub.kt` duration metadata (lockscreen
  scrubber) + `TMNative`/`__tmRemote` bridge for widget transport;
  homescreen widget layout + branded notification/widget drawables;
  `android-signing.mjs` + universal-release runbook.
- **Tests**: `studio-features`, `studio-persist`, `studio-stability`
  static gates; `persist.js` sanitizer on all untrusted state boundaries.
- **Verified on emulator** (`Pixel6_API36`, debug APK): 16/16 live CDP
  checks — suggestions, recent search, toast position, nav heights,
  NP dark/light, downloads screen, real vault download, 0 JS errors.

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
