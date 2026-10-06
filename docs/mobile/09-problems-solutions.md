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
| P20 | `tauri android build` fails immediately, or `gen/android` is missing | The Android scaffold has **never been initialised** on this machine | `cd app && npx tauri android init` once. Everything it needs is already installed (see the readiness table below) |
| P21 | On a device the sidecar (`127.0.0.1`) and the LAN room server (`0.0.0.0:8787`) are both dead | **Tauri v2's Android manifest template declares no permissions at all** — `tauri-2.11.5/mobile/android/src/main/AndroidManifest.xml` is a bare `<manifest>` with zero `<uses-permission>`. INTERNET is therefore *not* granted | After init, add `<uses-permission android:name="android.permission.INTERNET"/>` to `src-tauri/gen/android/app/src/main/AndroidManifest.xml`. There is **no** `tauri.conf.json` key that can express this — it is not configurable, so it must live in the manifest |
| P22 | The INTERNET permission works locally but is gone on a fresh clone or on CI | `app/src-tauri/gen/` is **gitignored** (it will hold `release.keystore`), so the manifest edit cannot be committed — yet the `.gitignore` comment claims the scaffolds "regenerate from `tauri.conf.json`", which is false for permissions | Automate the injection in `app/build.sh` right after `android init` (keeps the keystore untracked *and* makes the permission reproducible), or un-ignore exactly `gen/android/app/src/main/AndroidManifest.xml` |
| P23 | Sidecar still unreachable on Android **even after** INTERNET is granted | Plain-HTTP loopback (`http://127.0.0.1:<port>/health`) from the WebView. Since API 28 cleartext is off by default and Tauri's manifest sets no `android:usesCleartextTraffic`, the request is expected to be refused | **Unverified — check on a device first.** If refused, add a `network_security_config.xml` permitting cleartext to `127.0.0.1` only, rather than switching cleartext on globally. Note the room server is unaffected: it is a native Rust socket, not WebView traffic (see 3C L-7) |

## Android readiness (verified on this machine, 2026-10-06)

| Requirement | State |
| --- | --- |
| Rust android targets | **all 4 installed** — `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` |
| `ANDROID_HOME` | set to `C:\Users\rohit\AppData\Local\Android\Sdk` |
| `JAVA_HOME` | `C:\Program Files\Java\jdk-17` (present) |
| SDK platforms | `android-34`, `android-36`, `android-36.1`, `android-37.0` |
| build-tools | `34.0.0`, `36.0.0` |
| NDK | `27.2.12479018` |
| cmdline-tools / emulator | `latest` / present (`adb` on PATH) |
| `src-tauri/gen/android` | **absent** — never initialised (see P20) |

`build.sh android` is a wrapper over the same CLI, not an alternative to it:

| | command |
| --- | --- |
| `./build.sh android` | `tauri android build --target aarch64 x86_64 --split-per-abi --apk --ci` |
| `./build.sh android-universal` | `tauri android build --target aarch64 armv7 x86_64 --apk --ci` |

It adds real value on WSL: it drives the **Windows** `node` for Android steps
(`tauri_android()`), because the SDK/NDK live on the Windows side, and it
redirects `CARGO_TARGET_DIR` into the Linux filesystem to avoid the 2-3x
`/mnt/c` cargo slowdown. Use `build.sh` rather than raw `npx tauri android
build` when on WSL.

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
| P24 | NowPlaying's Queue / Chat / Jam Data / Lyrics tabs do nothing **on a device** (they work in a browser) | The regenerated screen (`97b0db8`) added `onclick="switchTab(...)"` **after** the overlay CSP hash list was last written; with `'unsafe-hashes'` an unhashed inline handler is silently refused by the WebView | Bind screen controls with listeners: `screens/nowplaying.js` wires `.tab-btn` via `addEventListener` and keeps `switchTab` global for `jam.js`. If you must add an inline handler, recompute its `sha256` into **both** `tauri.android.conf.json` and `tauri.ios.conf.json` (P7) |
| P25 | Solo shows the Chat / Jam Data tabs after tapping any tab | `switchTab` rewrote `btn.className` wholesale, clearing the `hidden` class `jam.js` puts on room-only buttons | `switchTab` re-applies `hidden` whenever the button carried it; visibility stays owned by `paintJam`'s `show(…, social, "flex")` |

## Pipelines / releases

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| P17 | Tag pushed, no iOS artifact | Tag didn't match `v*`/`V*`, or job failed silently | Check Actions → iOS; on failure read the tail in the `iOS build log` issue (`ios.yml` reporter) + `app/ios-build.log` |
| P18 | iOS artifact missing `.ipa` (only `.app`) | No Apple secrets configured | Expected: unsigned simulator build. Add the 4 secrets for a signed `.ipa`. |
| P19 | Mobile change broke nothing locally but CI failed | `src/mobile/**` used to be outside every test glob, so a mobile-only parse error reached release unnoticed | **Closed** — `app/tests/mobile-syntax.test.mjs` now `node --check`s all 33 files inside `npm test`, and fails if the directory goes missing so it cannot pass vacuously. Manual fallback: `for f in src/mobile/*.js src/mobile/screens/*.js; do node --check "$f"; done` |
