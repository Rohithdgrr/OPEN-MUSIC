# 03 — Mobile Setup

## Prerequisites

| Tool | Required | Notes |
| --- | --- | --- |
| Node.js | 18+ (CI uses 22) | Only runs the Tauri CLI + Tailwind |
| Rust | 1.77+ | `rust-version` in `Cargo.toml`; `rustup` manages mobile targets |
| JDK | 17 | Android builds |
| Android SDK + NDK | API 34, NDK r25+ | Set `ANDROID_HOME` / `ANDROID_NDK_HOME`; `sdkmanager` accepts licences |
| Xcode + iOS SDK | macOS only | iOS cannot build on Windows/Linux — use `ios.yml` |
| WebView2 / adb / simulator | per platform | `adb` for device install; Xcode Simulator for unsigned iOS |

Install the CLI once:

```bash
cd app
npm install
```

## Android — first run

```bash
cd app
npm run css                       # build app/src/tailwind.css (mobile shares it)
npx tauri android init              # one-time: creates src-tauri/gen/android
npx tauri android dev               # hot-reload on emulator / USB device
npx tauri android build \           # release APK/AAB (see outputs below)
  --config tauri.android.conf.json
```

Outputs land under `app/src-tauri/gen/android/app/build/outputs/`
(`apk/` / `bundle/`). Install with `adb install <apk>` or via Android Studio.

The Android overlay (`tauri.android.conf.json`) sets:

- `app.windows[0].url = "mobile/index.html"`, `fullscreen: true`
- its own CSP `script-src` hash list + `bundle.targets = all`

## iOS — first run (macOS only)

```bash
cd app
npm ci && npm run css
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npx tauri ios init --ci
npx tauri ios build --config tauri.ios.conf.json   # signed .ipa when signing secrets exist
# No signing material? unsigned simulator build (what CI does):
npx tauri ios build --ci --verbose --no-sign --target aarch64-apple-ios-sim
```

Signing needs these repo secrets (`ios.yml:32-35`):
`TAURI_APPLE_CERTIFICATE`, `TAURI_APPLE_CERTIFICATE_PASSWORD`,
`APPLE_PROVISIONING_PROFILE`, `APPLE_TEAM_ID`.
Without them you get an unsigned `.app` for the Simulator only.

## Environment variables

| Variable | Used by | Effect |
| --- | --- | --- |
| `OP_OFFLINE=1` | `cargo test` | Skips live-network tests (what CI runs) |
| `TRANCE_MUSIC_GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_ID` | `tauri build` / `release.yml:67` | Bakes Drive sync in; absent = compiles, runs unconfigured |
| `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` | desktop `tauri build` | Signs updater artifacts; mobile ignores |
| `APPLE_*` (4 secrets above) | `ios.yml` | Signed `.ipa` vs unsigned simulator `.app` |

## Verify your setup

```bash
cd app/src-tauri && OP_OFFLINE=1 cargo test   # Rust offline gate
cd app && npm run lint                        # ESLint
cd app && npm test                            # frontend pure-logic tests
for f in src/mobile/*.js src/mobile/screens/*.js; do node --check "$f"; done
```
