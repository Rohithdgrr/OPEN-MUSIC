# 07 — Mobile Changelog

Follows Keep a Changelog + SemVer (same as root `CHANGELOG.md`).
Desktop history stays in the root file; this file tracks **mobile-surface**
changes only.

## [Unreleased]

### Fixed — UX polish batch (2026-11-22, docs/mobile/11-ux-polish-batch.md)

- **Shell**: pinch-zoom locked (`user-scalable=no`), overscroll stretch
  killed (CSS `overscroll-behavior` + WebView `OVER_SCROLL_NEVER`), Now
  Playing sheet pinned to bottom (no dead space), headline overflow-wrap.
- **Search**: input gets search keyboard hints; "Top result" biases songs
  (`KIND_WEIGHT.song` 1.5); padding tightened.
- **Toasts**: identical toast+kind deduped inside 1.5 s — no repeat stacking.
- **Up Next**: radio keeps a persisted served-id set (`tm-radio-seen`),
  batches grow to 20 with a per-artist cap of 2, top-up buffer deepened —
  steady, non-repeating feed.
- **Share**: `shareThing` sends `{title,text,url}` JSON; `MediaHub.share`
  sets EXTRA_TITLE/SUBJECT + titled chooser (plain text still works).
- **Notifications**: `releasealerts.js` diffs followed artists'
  `artist_overview` every 12 h → `release` events in the feed + Android
  `tm_alerts` notification (`TMNative.notify`); EV_META types aligned to
  the filter pills (Updates/Downloads counted correctly).
- **Android overlay**: `MediaHub.dismiss()` refreshes widgets; `notify()`
  + alert channel added. Portrait lock was already injected by build.sh.

### Fixed — Studio-shell follow-up (2026-11-22b, docs/mobile/11 §Studio)

The live Android UI is `studio/` (`entry.js` boots `studio/app.js`); the
legacy `mobile/*.js` bundle above is not what ships. Same asks, live shell:

- **Search typing**: per-keystroke `innerHTML` re-render destroyed the
  Android IME composition — all `data-input-ui` fields now write
  silently and repaint on a 320 ms pause; search keeps its 220 ms live
  debounce; `/` shortcut focuses the real input id; input gets
  `enterkeyhint`/`inputmode`/`autocapitalize`/`spellcheck`.
- **Top result**: prefers a matching track (with artwork) over artists.
- **Widget**: `TMNative.pinWidget()` → `AppWidgetManager.
  requestPinAppWidget`; Settings → Backup & System "Add Widget" row;
  notification gains `CATEGORY_TRANSPORT` for the lockscreen surface
  (Android 12+ has no lockscreen app-widgets — media notification is it).
- **Home carousels**: `studio/carousel.js` coverflow (native scroll +
  rAF rotateY/scale) on Daily Mix, Most Played, Jump Back In, Top Charts.

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
