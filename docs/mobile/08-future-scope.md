# 08 — Mobile Future Scope

## Planned (next)

1. **Android CI workflow** — mirror `ios.yml`: `android dev` smoke + release
   APK/AAB build on tags, upload as artifact, attach to release. (Today Android
   is local-only.)
2. **CI covers mobile JS** — extend `ci.yml` syntax check from `src/*.js` to
   `src/mobile/**/*.js`; add `node --check` + ESLint for the shell.
3. **File export/import on mobile** — Storage Access Framework (Android) /
   document picker (iOS) or `tauri-plugin-opener`-based share sheet to replace
   the desktop-only dialog commands.
4. **`open_external` on mobile** — Intent (Android) / `UIApplication.open`
   (iOS) or opener plugin; remove the mobile `Err` in `lib.rs`.
5. **Signed Android releases** — keystore + `tauri.android.conf.json` signing
   config, Play-track guidance (internal → closed → production).
6. **App-store metadata** — icons/splash per size, privacy policy URL, data
   safety form (network + storage usage), content-rating questionnaire.

## Later

- **Spotify Canvas on the Now Playing screen** — looping artist video behind
  the album art. Deferred, not desktop-first: Canvas has no official API (the
  internal Pathfinder GraphQL needs a `sp_dc` cookie harvested from a browser
  session — not our OAuth flow, and unofficial/ToS + rate-limit risk), and every
  play needs a JioSaavn → Spotify track match first. When built, keep it
  backend-shaped and lazy:
  1. `spotify_import_top` already returns ISRCs — key the cache on ISRC, skip
     the URI-match step where possible.
  2. One Tauri command `fetch_canvas(isrc)`; `sp_dc` lives in the OS keyring
     (`keyring` crate), requests go through Rust, never the webview.
  3. Cache `isrc → mp4` in the existing `moka` TTL cache (URLs are expiring
     CDN links; short TTL, no invalidation system).
  4. Render in the mobile `nowplaying` screen as
     `<video loop muted autoplay playsinline>`; **album art stays the
     fallback** on miss, error, or rate-limit.
  5. Mobile-specific: gate the loop behind a Settings toggle (default off on
     metered data — video costs battery + bytes), restart it only on track
     change, no new crate until the query hash churns.
- Background playback hardening (audio focus, headset buttons, phone-call ducking).
- Download manager UX: pause/resume, Wi-Fi-only, per-track quality.
- Offline-first search/history when the catalog is unreachable.
- Push-free update nudge: version check → store link (never side-load).
- Crash + ANR reporting (opt-in), vitals dashboard.

## Explicitly out of scope

- Tauri in-app updater on mobile (store handles it; updater plugin stays
  desktop-only).
- Global shortcuts, tray, single-instance, autostart writes, desktop widget
  reparenting — desktop/OS-owned concepts; mobile uses notifications, intents,
  and system settings instead.
- Hand-editing `src-tauri/gen/android` or the generated Xcode project —
  fix the overlay config / `Cargo.toml` gates / Rust `cfg()`s instead.
