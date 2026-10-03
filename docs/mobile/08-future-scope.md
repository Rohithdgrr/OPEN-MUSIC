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
