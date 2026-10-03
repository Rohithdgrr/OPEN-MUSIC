# 09 — Mobile Problems & Solutions

> Symptom → cause → fix. Check here before opening an issue.

## Build / toolchain

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| P1 | Android build pulls `openssl-sys` / fails linking OpenSSL | Default `reqwest` TLS = native-tls | Keep Android on `rustls-tls` (`Cargo.toml:58-59`); never move desktop plugins into shared `[dependencies]` |
| P2 | iOS/mobile build fails on `tauri-plugin-dialog / updater / global-shortcut / single-instance` | Those plugins have no mobile implementation | Keep them under `cfg(not(android/ios))` (`Cargo.toml:38-50`) and gate the commands with `#[cfg(desktop)]` (`lib.rs`) |
| P3 | `npx tauri ios build` fails: "No Team Found" / signing errors in CI | No signing identity on the runner | Unsigned path is the default without secrets: `--ci --no-sign --target aarch64-apple-ios-sim` (`ios.yml:106`). Signed `.ipa` needs all 4 Apple secrets. |
| P4 | `tauri ios build --simulator` → "unexpected argument" | No such flag | Use `--target aarch64-apple-ios-sim` (see `ios.yml:99-106`) |
| P5 | iOS workflow edited but YAML silently ignored | Indentation drift (happened before: `9c06dc1`) | Validate with `python -c "import yaml"` or `yamllint` before pushing |
| P6 | Android Studio / Gradle complains after editing `gen/android` | Generated project was hand-patched | Revert `gen/`; fix the overlay config, `Cargo.toml` gates, or Rust `cfg()`s instead; re-run `tauri android init` |

## Runtime / WebView

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| P7 | Blank screen / `invoke is not defined`, "Tauri IPC unavailable" | Page loaded outside Tauri (plain browser) or CSP blocked `script-src` | Serve via `tauri android/ios dev`; if you touched inline handlers, recompute the `sha256-*` entries in the mobile overlay CSPs |
| P8 | Search field hidden under the header on notched devices | Fixed header carries `.pt-safe` but `<main>` offset missed the inset | Keep the `main.pt-14/pt-16 { padding-top: calc(... + env(safe-area-inset-top)) }` rule in `mobile/index.html` |
| P9 | Dead placeholder tiles / broken art | Static exports ship raw `<img>` with dead URLs | `router.js:stampImages()` puts them on the art ladder — don't strip `data-art-orig` / lazy / async attrs |
| P10 | Tapping artist/album name starts playback | Entity tap fell through to the row-play fallback | `app.js` handles `[data-entity-name]` **before** `[data-list][data-idx]` — keep that order |
| P11 | Kebab tap starts playback | Menu trigger resolved after row-play | Keep the `isMenuTrigger` check before the row-play fallback (`app.js`) |
| P12 | Android back button exits the app from a deep screen | Hash history not stepped | `window.__tmBack()` (`router.js`) returns `true` after `history.back()`; the Activity must call it and only `finish()` on `false` |
| P13 | Stale widget/mini-player (track changed, card didn't) | Paint hooks missed a path | Every control must call the existing handlers and every painter must be called **from** the bar/now-playing painters (same rule as the desktop widget) |
| P14 | First toast lands under an open panel | Offset applied only on toggle | Apply the stack offset when the stack is **created**, not only on toggle |
| P15 | Fonts/icons missing offline | Google Fonts / Material Symbols are CDN-only | Expected: falls back to system font / ligature text; layout unaffected because Tailwind ships in `tailwind.css` |
| P16 | `export_file` / Save dialog does nothing on mobile | Command is `#[cfg(desktop)]` | Expected — use share/export-via-intent workarounds until the SAF/picker work lands (Future Scope) |

## Pipelines / releases

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| P17 | Tag pushed, no iOS artifact | Tag didn't match `v*`/`V*`, or job failed silently | Check Actions → iOS; on failure read the tail in the `iOS build log` issue (`ios.yml` reporter) + `app/ios-build.log` |
| P18 | iOS artifact missing `.ipa` (only `.app`) | No Apple secrets configured | Expected: unsigned simulator build. Add the 4 secrets for a signed `.ipa`. |
| P19 | Mobile change broke nothing locally but CI failed | CI doesn't syntax-check `src/mobile/**` | Run `for f in src/mobile/*.js src/mobile/screens/*.js; do node --check "$f"; done` before pushing |
