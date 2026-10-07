# Android universal release APK (v0.4.1-plan)

## Goal

One signed `app-universal-release.apk` (arm64-v8a + armeabi-v7a + x86_64)
that installs on every real phone (ARM) and the x86_64 emulator, optimized
for size, built from this checkout via `build.sh android-universal`.

## Key decision: fresh release key (2026-10-07)

- v0.4.0 APK on GitHub **is** signed (release notes say "unsigned" — wrong):
  `CN=TRANCE MUSIC, OU=Dev, O=OpenMusic`, SHA-256
  `073c4960554e323a390f394032cbec74ebc41c088a3bfa3c1f547558a4c7edf1`,
  20,280,439 B, `.so` files already deflated (41–51%).
- No release keystore exists on this machine (only `debug.keystore` +
  gradle caches). User chose **generate new key** over blocking on the lost
  key — consequence: Android rejects over-install (different cert), users
  must **uninstall v0.4.0 first (vault backup needed)**, then install fresh.
- New key reuses the same DN (`CN=TRANCE MUSIC, OU=Dev, O=OpenMusic,
  L=Local, ST=Local, C=IN`) for recognizability; fingerprint will differ
  and is recorded in the build report. Keystore + `keystore.properties`
  live under `app/src-tauri/gen/android/` (gitignored, never committed).

## Changes (safe-only, no runtime behaviour)

1. `gen/android/app/build.gradle.kts` (gitignored, re-apply after
   `tauri android init`):
   - `signingConfigs.release` from `keystore.properties` (Tauri docs shape),
     wired into `buildTypes.release`.
   - `packaging.jniLibs.useLegacyPackaging = true` so the Rust `.so`
     deflates (~15.5 MB stored → ~6.4 MB per ABI; old APK proves 41–51%).
   - Keeps `optimization.enable = true` + proguard files; Cargo
     `[profile.release]` untouched (`lto`, `codegen-units = 1`, `opt-level
     = 3`, `strip = true`).
2. Build: `npm run css` then
   `npm run tauri -- android build --target aarch64 armv7 x86_64 --apk --ci`
   (`build.sh android-universal` — equivalent).
   **Run it through `npm run tauri` (root) or from `app/`; never `npx
   tauri android ...` from the repo root.** npx resolves the *global* CLI
   (2.11.2 on this machine) while gradle's rustBuild children spawn the
   *app-local* 2.12.0 — the two disagree on where the options-server file
   lives (2.11.2: old temp dir; 2.12.0: `gen/android/.tauri/
   cli-options-server.json`), so every `rustBuild*` task fails with
   `failed to read cli-options-server.json`. Root cause + evidence: P28.

## Verify

- `apksigner verify --print-certs` → new SHA-256 recorded, `CN=TRANCE MUSIC`.
- Size + `python zip` breakdown: every `lib/*/*.so` deflated (~40–55%).
- `adb install` on `emulator-5554`, app boots to mobile home (no
  `devUrl` load-failure — release embeds the frontend).

## Streaming fix (2026-10-07): cleartext block on the relay

The first install booted but **did not stream**: `<audio>` stuck at
`readyState 0` → `MEDIA_ELEMENT_ERROR: Format error`, album art dead too.

- **Root cause (CDP-proven):** `Network.loadingFailed` reported
  `net::ERR_CLEARTEXT_NOT_PERMITTED` on every `http://127.0.0.1:<port>/stream`
  (type `Media`) and `/art` (type `Image`). Release sets
  `usesCleartextTraffic=false`, and Android treats the whole playback
  pipeline as plain-HTTP loopback traffic. Debug builds set `true` — which
  is why every streaming verification before now ran on a **debug** APK.
- **Fix:** scoped `network_security_config.xml`, not a global cleartext
  flip — `src/release` permits loopback only, `src/debug` keeps global
  cleartext for `tauri android dev`'s LAN `devUrl`; referenced via
  `android:networkSecurityConfig` in the (gitignored) manifest. A present
  `networkSecurityConfig` makes Android ignore `usesCleartextTraffic`.
- **Full record:** `docs/mobile/09-problems-solutions.md` P23.
- Also gitignored → re-apply after `tauri android init`, same class as the
  signing config above.

## Build + verification report (2026-10-07 — streaming fix confirmed live)

**Build.** Third attempt after two failures whose root cause was a Tauri CLI
version skew (repo-root `npx tauri` = global **2.11.2**, gradle-spawned
children = app-local **2.12.0** — different options-server file locations;
full record in P28). The working invocation runs the *local* CLI as parent:

```
npm run tauri -- android build --target aarch64 armv7 x86_64 --apk --ci
→ BUILD_EXIT=0
```

**Artifact.** `app-universal-release.apk` — 17,997,660 B, 679 entries,
`apksigner verify` exit 0, signer `CN=TRANCE MUSIC`, SHA-256
`8ad4da6fc72a7e75bcf8188ee89f3c1f6e0261b6ca80f044283f6b804d8cadfb`
(unchanged new key). `.so` per ABI: arm64-v8a 13.9 MB, armeabi-v7a 10.0 MB,
x86_64 14.9 MB (deflated).

**Fix packaging proof (static).**
- `aapt dump xmltree AndroidManifest.xml` → `android:networkSecurityConfig=
  @0x7f120001` present (and `usesCleartextTraffic=0x0`, as expected — the
  config is the authority).
- `aapt dump resources` → `0x7f120001 com.openmusic.trancemusic:
  xml/network_security_config` defined. The file itself sits under an
  **obfuscated** `res/XX.xml` entry name (AGP resource-name obfuscation is
  part of Tauri's `optimization.enable`), which is why a
  `res/xml/network_security_config.zip`-style listing finds nothing;
  entry count went 678 → 679 with the new resource.

**Emulator run (Pixel6_API36, release APK).** Note: qemu hung mid-session
(`adb shell` + console port accepted TCP but never responded) — killed pid
and cold-booted with `-no-window -no-audio -no-boot-anim -no-snapshot`;
`sys.boot_completed=1` in ~54 s; `adb install -r` → Success.

| Probe | Result |
|---|---|
| `probe7-net` (CDP `Network`) | **Zero `ERR_CLEARTEXT_NOT_PERMITTED`.** Only failure: `ERR_CONNECTION_REFUSED` on the probe's deliberately fake port 33737 — i.e. the cleartext request was *attempted* (policy allows) instead of blocked. `/art` images: many `200 image/jpeg` over `http://127.0.0.1:40497/art` |
| `probe8-debug` | Direct `invoke("search_songs")` → 1 track (`Let It Happen`) in 1132 ms; UI Enter commits `#/search?q=…`, renders `81 songs` / 6 rows; **0 console exceptions** |
| `probe5` | **STREAMING_OK** — row click → `#/nowplaying`, `<audio>` src = `http://127.0.0.1:40497/stream…`, `readyState` 0→**4**, `paused:false`, `currentTime` 0 → 0.82 → 1.91 → **3.27**, `error:null` |
| `probe6` | `audio state {rs:4, no error}`; `resolve_song` keys = `id,title,artist,direct_url,proxy_url,qualities,chosen_quality,content_length,host,range_status` (no `.url`) |

**Gates after the fix (2026-10-07).** `cargo fmt --check` exit 0 ·
`cargo clippy --all-targets -- -D warnings` exit 0 ·
`OP_OFFLINE=1 cargo test --lib` → **174 passed / 0 failed** (6.03 s) — all
run with `.cargo/config.toml` (`linker = "rust-lld"`) active, so this is also
the real-project smoke test of the lld config (full host rebuild in 5m33s,
no link failures). JS gates were red at that moment from a *parallel work
session's* in-flight edits (`app/src/mobile/binders.js` duplicate `fmtBytes`
parse error; `qrview.js` edit vs `app/tests/social-ui.test.mjs:110`) — no JS
in this change is covered by eslint or `npm test`; the docs-only diff cannot
affect them.

**Known-non-issue (documented so it is not re-diagnosed):** a page-side
`fetch(audio.src)` returns `TypeError: Failed to fetch` — the relay serves
**no CORS headers** (grep of `app/src-tauri/src`: zero `Access-Control`/
`OPTIONS` matches), so a *cors-mode* cross-origin `fetch()` can never
succeed. It never could, on any build. The real consumers — `<audio>` and
`<img>` — are no-cors and are proven working above; the app itself never
`fetch()`es `/stream` from the page, it hands the URL to `<audio>`.

## BUILD 6 (2026-10-07) — rebuild after a parallel-session `jniLibs` race

A server restart cancelled BUILD 5's first attempt; the relaunch used the same
proven invocation (local CLI 2.12.0 parent): `npm run tauri -- android build
--target aarch64 armv7 x86_64 --apk --ci` → `BUILD_EXIT=0`.

**Incident — cross-session `jniLibs` symlink race (P29).** The first build to
finish that morning produced an **83.2 MB** APK instead of ~18 MB: a parallel
session's `--target x86_64` **debug** build (writes `target/…/debug/
libapp_lib.so` = 297,911,240 B with DWARF, mtime 10:45:31) re-pointed the
*shared* `gen/android/app/src/main/jniLibs/x86_64/libapp_lib.so` symlink at
`debug\` while my release build was still compiling; gradle packaged at 11:00
and followed the swapped link. The arm64/armv7 links still aimed at
`release\`, so only the x86_64 ABI was contaminated — visible in the zip
entry listing (297,911,240 vs 15,283,128 B uncompressed) and in
`Get-Item … -Force` (`LinkType=SymbolicLink`, `Target=…\debug\…`).
Fix: delete the offending link (tauri re-creates all per-target links during
the next build — its own `Info symlink at …` step) and rebuild → BUILD 6.

**Artifact (BUILD 6).**

- `app-universal-release.apk` **18,285,395 B** (11:41:24) — lightweight class
  restored. Libs: arm64 14,236,040 / armv7 10,196,536 / x86_64 15,283,128, all
  symlinks → `release\`, stripped (`llvm-readelf -S`: no `.debug_*` sections).
- Manifest: `android:networkSecurityConfig=@0x7f120002`,
  `usesCleartextTraffic=0x0` (the scoped XML is the authority).
- `apksigner verify` exit **0**; signer `CN=TRANCE MUSIC`, SHA-256
  `8ad4da6fc72a7e75bcf8188ee89f3c1f6e0261b6ca80f044283f6b804d8cadfb`.

**Install (Pixel6_API36).** The emulator had died during the first build;
cold-booted again (`-no-window -no-audio -no-boot-anim -no-snapshot`,
`sys.boot_completed=1` in ~60 s). The installed package was now a *parallel
session's debug-signed build*, so `adb install -r` failed with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signature mismatch cannot be bypassed)
→ `adb uninstall` + `adb install` → **Success** (pid 2050, `MainActivity`
focused).

**Probes (fresh install; onboarding dismissed via the real *Start
listening* button):**

| Probe | Result |
|---|---|
| `probe9` | UI search `80 songs` / **6 rows**; direct `<audio>` play of the `resolve_song` relay URL → **STREAMING_OK** (`rs:4`, `t` 1.53 → 2.55, `err:null`); **CLEARTEXT_BLOCKED=0**. Benign: 3× `runCallback` exceptions + 2 `[TAURI] Couldn't find callback id` warnings — pending invokes orphaned by earlier probe disconnects |
| `probe5` | Full UI path: row click → `#/nowplaying`, `<audio>` src = relay, `t=42.77`, `err:null` → **STREAMING_OK**. The first attempt right after cold start showed 0 rows (search backend warming); passed on retry |
| `probe7` | Loopback control: `ERR_CONNECTION_REFUSED` on the fake port 33737 (by design — the request was *attempted*, not blocked); **no CLEARTEXT** |
| `probe10` | `<img>`: **7/7 loaded**, all through `http://127.0.0.1:38777/art?…saavncdn…` |

**Why page-level `https` `fetch()` throws (expected, not a defect).**
`tauri.conf.json` `app.security.csp.connect-src` = `'self' ipc:
http://ipc.localhost http://tauri.localhost http://127.0.0.1:* ws://127.0.0.1:*`
— no external origins, so the probes' `fetch("https://…", {mode:"no-cors"})`
baselines always throw `TypeError: Failed to fetch`. All external traffic
routes through the Rust relay; the arts loading (7/7) proves Rust-side
networking works. Same category as the no-CORS finding above.


## BUILD 7 (2026-10-07, evening) — x86_64-only release for emulator verify

9-minute budget: single `--target x86_64` release (emulator ABI only),
same full `[profile.release]` (cache intact — no thin-LTO switch, which
would invalidate deps), signing + `src/release` loopback netconfig
verified intact pre-build, `lib.rs` touched so the dirty frontend
(mobile `index.html`/`jam.js`, `tailwind.css` newer than the 15:05 APK)
re-embeds. Install on `Pixel6_API36` + CDP stream/UI check below.

**Result (BUILD 7, verified live).** Rust 8m58s + gradle, `BUILD_EXIT=0`.
Artifact `app-universal-release.apk` **7,617,235 B**, 678 entries,
`lib/x86_64` 15,288,328 B deflated, `apksigner verify` exit 0, signer
`CN=TRANCE MUSIC` SHA-256 `8ad4da6f…cadfb` (same new key).
`adb install -r` → Success (no signature clash — release over release).
CDP probe (`%TEMP%\opencode\verify7.mjs`, kept outside the repo):
`search_songs` → **27 tracks**, `resolve_song` 320 → relay URL,
`<audio>` `rs:4`, `ct` 0 → 1.82, `err:null` → **STREAMING_OK**,
`CLEARTEXT_BLOCKED=0`, `NET_FAILS=0`. Screenshots: home greeting card
+ open track sheet, nowplaying (320KBPS/SOLO badges, transport on
pause-glyph = playing, queue, "saved to vault" toast) — UI/UX confirmed.
Caveat: the probe drove `<audio>` directly, bypassing `player.js`, and
the app's own controller paused it ~2 s in (`paused:true`, `ct` frozen
at 1.82 — decode + advance already proven, so pipeline OK, not a
streaming defect). Full UI row-click path last proven on BUILD 6 probe5;
re-run it when budget allows.

## Fast universal release build (2026-10-07)

The checked-in `[profile.release]` (fat `lto = true`, `codegen-units = 1`,
`opt-level = "s"`, `strip`) links `app_lib` **single-threaded, once per
ABI** — on this 8-core box the aarch64 `app_lib` step alone ran past 6 min,
times three targets. For an iterate-and-verify build, override the two slow
knobs **for that build only** (env vars; `Cargo.toml` untouched):

```powershell
$env:CARGO_PROFILE_RELEASE_LTO="thin"; $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS="16"
npm run tauri -- android build --target aarch64 armv7 x86_64 --apk --ci
```

- Still a **release**, **signed** (keystore.properties), stripped,
  `opt-level "s"`, compressed jniLibs (`useLegacyPackaging`) universal APK.
- Cost: thin LTO + 16 CGUs gives up some cross-crate size optimisation —
  compare the APK size against BUILD 6 (18,285,395 B) and record it below.
- First run after switching profiles recompiles every dependency (profile
  change invalidates the cache); later fast builds are incremental.
- Shipping build for a public release: drop the two env vars (max size
  reduction), or keep them if the measured delta is negligible.
- Frontend assets are embedded when `app_lib` compiles (no tauri-build
  `codegen` feature here): after a JS/HTML edit made *during* a running
  build, touch `src-tauri/src/lib.rs` and rebuild, or the APK can ship the
  old frontend for ABIs that already linked.


## BUILD 8 + BUILD 9 (2026-10-08, after wipe) � fresh x86_64, then universal fix

User asked to delete all old APK/AAB artifacts and factory-reset the AVD.
All 5 APK/AAB files under `gen/android/app/build` deleted, `emulator -avd
Pixel6_API36 -wipe-data` cold-booted (fresh onboarding confirmed via
screenshot), `npm run css` rebuilt first.

- **BUILD 8** � single `--target x86_64` release (7,629,167 B, `BUILD_EXIT=0`).
  Installed on the wiped emulator; search + play verified (ct 86 ? 89.7,
  rs:4, err:null). **But** it failed sideload to the user's physical phone:
  Android checks `lib/` against the device ABI and the APK shipped only
  `lib/x86_64` ? *"App not installed as app isn't compatible with your phone."*
  (arm64 device, no matching native lib � not a signing or minSdk issue.)
- **BUILD 9 (the fix)** � `npm run tauri -- android build --target aarch64
  armv7 x86_64 --apk --ci`, full fat-LTO profile (no fast-build env vars;
  7m55s + 6m14s + 20m37s per-ABI Rust + gradle), `BUILD_EXIT=0`.
  **Artifact: `app-universal-release.apk` 17,5xx,xxx B (17.5 MB),
  08-10-2026 00:47:09.** Verified: `zipfile` lists all three ABIs
  (`arm64-v8a`, `armeabi-v7a`, `x86_64`, 1 lib each); apksigner exit 0,
  `Signer #1 certificate DN: CN=TRANCE MUSIC�`, SHA-256 `8ad4da6f�cadfb`
  (same signer as BUILD 6/7). Reinstalled on the emulator (`Success`,
  `lastUpdateTime 2026-10-08 00:48:53`, app launched pid 5968).

**Rule for sideloading:** the emulator is x86_64, phones are arm64 � any
APK that leaves this machine for a real device must be built with all three
`--target`s (or omit `--target` for all installed targets). A `--target
x86_64`-only build installs on the emulator and nowhere else.
