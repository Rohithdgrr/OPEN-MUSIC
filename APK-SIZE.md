# How the APK was shrunk

Baseline (before): **17,385,920 B (17.39 MB)** — one fat `app-universal-release.apk`
carrying every ABI.

| Contents | Size | How it was stored |
| --- | --- | --- |
| `lib/x86_64/libapp_lib.so` (Rust + embedded frontend) | 15.55 MB (89%) | **stored uncompressed** in the zip |
| dex + res + assets | ~1.7 MB | deflated (normal) |

Two levers, both approved as "safe only" — nothing that changes runtime
behaviour, only how bytes are packaged.

## 1. Split per ABI (`build.sh`)

```diff
-  local args=(android build --target x86_64 --apk --ci)
-  [[ "${DEBUG:-0}" == 1 ]] && args+=(--debug)
+  local args=(android build --target aarch64 x86_64 --split-per-abi --apk --ci)
```

- Tauri CLI flag: `--split-per-abi` → one APK per architecture instead of a
  universal APK that bundles `arm64-v8a` + `x86_64` (and would have bundled
  `armeabi-v7a`/`x86` too when built with `--target` all).
- Shipped artifacts: `app-arm64-v8a-release.apk` (phones) and
  `app-x86_64-release.apk` (emulator/desktop) — each contains only its own
  `.so`.
- The `DEBUG=1` branch was dropped: `./build.sh android` is now always
  release-only, so a debug APK can no longer be published by accident.

## 2. Deflate the native lib (`gen/android/app/build.gradle.kts`)

```kotlin
getByName("release") {
    signingConfig = signingConfigs.findByName("release")
    // Deflate the Rust .so inside the APK instead of storing it
    // uncompressed: ~15.55 MB of native lib becomes ~6.4 MB on disk.
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    ...
}
```

- AGP default (`useLegacyPackaging = false`) stores `.so` files
  **uncompressed** in the APK (they are memory-mapped straight from the zip at
  install; `extractNativeLibs=false`).
- `true` switches back to the legacy packaging: the `.so` is **deflate-
  compressed** inside the zip and extracted on install.
- Measured: deflate of `libapp_lib.so` = **6.36 MB** (vs 15.55 MB stored).
  Trade-off: slightly larger install footprint on device, much smaller APK to
  download/share.

Expected per-ABI APK size after both changes ≈ **8 MB**
(6.4 MB compressed `.so` + ~1.7 MB dex/res).

## What was deliberately NOT changed (safe-only)

- Cargo `[profile.release]` untouched: `lto = true`, `codegen-units = 1`,
  `opt-level = 3`, `strip = true` — the native code already ships stripped and
  LTO'd. Dropping to `opt-level = "z"` or `panic = "abort"` would change
  runtime behaviour/perf, which was out of scope.
- No tokio feature trimming, no dependency swaps.
- AGP's R8 + resource shrinking were already on
  (`optimization { enable = true }`, mapping files present) — kept as is.

## Verification checklist

- [ ] `./build.sh android` produces `app-arm64-v8a-release.apk` +
      `app-x86_64-release.apk`
- [ ] APK size measured (python zip breakdown: `.so` should be deflated)
- [ ] `apksigner verify --print-certs` → unchanged cert
      `SHA-256 073c4960554e323a390f394032cbec74ebc41c088a3bfa3c1f547558a4c7edf1`
      (CN=TRANCE MUSIC)
- [ ] install `app-x86_64-release.apk` on `emulator-5554`, app boots
