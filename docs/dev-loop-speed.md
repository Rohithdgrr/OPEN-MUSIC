# Dev loop speed — desktop preview & APK rebuilds

> Spec + decision record for local development speed. Adopted 2026-10-07 from an
> external workflow-audit proposal; every suggestion was fact-checked against
> this repo before adoption. Rejected items are listed so they are not
> re-proposed later.

## Scope

Two optimizations were approved:

1. **LLD linker for the desktop MSVC target** — faster link step in
   `npm run tauri dev` / `cargo build` loops.
2. **Gradle tuning for Android rebuilds** — parallel/caching/JVM flags for
   `tauri android build`. (Invocation matters too: run it as
   `npm run tauri -- android build ...` or from `app/` — the repo-root
   `npx tauri` resolves the *global* CLI, and a global/local version skew
   breaks the rustBuild tasks outright. See P28.)

Everything else from the proposal was rejected or found redundant (see
**Rejected** below).

## 1. LLD linker (desktop)

**File:** `app/src-tauri/.cargo/config.toml` (tracked)

```toml
[target.x86_64-pc-windows-msvc]
linker = "rust-lld"
```

- `rust-lld.exe ships with the stable MSVC toolchain
  (`lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe`) — no LLVM install,
  no `cargo-binutils` (that crate does not provide a linker).
- We use `linker = "rust-lld"` rather than the proposal's
  `-C link-arg=-fuse-ld=lld`: **`-fuse-ld=lld` is a clang driver flag**; the
  MSVC `link.exe` rejects it, so the proposal's snippet would have failed or
  silently no-op'd.
- Scope: **desktop only**. Android NDK builds already link with `lld` by
  default (NDK ≥ r23); adding a `[target.aarch64-linux-android]` section would
  be a no-op at best.
- Windows-only concern: `rust-lld` produces MSVC-compatible COFF/import
  libs; if `npm run tauri dev` ever fails at link time with LTO/PDB errors,
  delete this file — link.exe fallback is the safety valve.

**Measurement protocol (before keeping the change):**

```powershell
# baseline vs lld — same clean state, both from app/src-tauri
cargo build          # (linker default)
# toggle config.toml on/off, then:
Measure-Command { cargo build }
```

Record the numbers here. If the delta is < ~20% on incremental links, the
config can still stay (zero risk, one line), but the claim must not be
exaggerated in docs.

**Measured 2026-10-07** (script: toggle `.cargo/config.toml` between timed
`cargo build` runs; an incremental round = touch `src/lib.rs` → recompile of
the top crate + relink — compile cost is identical across linkers, so the
round-to-round delta is the linker delta; each step logged separately):

| Round | rust-lld | link.exe |
|---|---|---|
| Incremental (touch + build) | **29.1 s** (uncontended replica run) | *pending* — first attempt contended |
| Full rebuild after config toggle | 354.6 s † | 580.5 s † |

† **Contended — upper bounds only.** A second work session was running cargo
concurrently: 5 of the 6 steps logged `Blocking waiting for file lock`, so
the full-rebuild pair and the first incremental pair (308.6 s lld vs
394.9 s link.exe) are not comparable to each other. The one step with zero
lock waits (replica, 29.1 s) is the only first-grade lld number so far; the
link.exe incremental needs one rerun in a quiet window.

Verified findings (independent of the contention):

- **A config toggle invalidates the entire host tree** — 344 crates rebuilt
  in each direction. Cargo fingerprints the linker, so toggling costs one
  full rebuild per direction. Leave the file alone day-to-day; the
  "safety valve" (delete it) is a deliberate one-time rebuild, not free.
- The full-rebuild gap in the contended pair (580.5 s vs 354.6 s) leans the
  same way as the lld claim, but the waits differ per step — do not quote
  these as speedups.
- The earlier full host rebuild under `clippy` (5m33s, exit 0) was itself
  the first real-project smoke test of `rust-lld`: every link (build
  scripts, proc-macros, final bins) succeeded.

## 2. Gradle tuning (Android)

**File:** `app/src-tauri/gen/android/gradle.properties` — note `gen/` is
**gitignored** (`.gitignore:56`), so this file must be re-created after any
`tauri android init`, exactly like the signing config
(`docs/android-universal-release.md`).

```properties
org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=512m -XX:+UseParallelGC
org.gradle.configuration-cache=true
org.gradle.parallel=true
org.gradle.caching=true
kotlin.code.style=official
android.proguard.failOnMissingFiles=false
android.builtInKotlin=false
android.newDsl=false
```

> **INCIDENT 2026-10-07 — never blind-overwrite this file.** A first draft
> wrote only the three tuning flags, replacing Tauri's generated content.
> Consequence: `android.builtInKotlin=false` vanished, AGP 9 auto-applied
> Kotlin, and the next build died at configuration with
> `Cannot add extension with name 'kotlin', as there is an extension already
> registered with that name.` (`build.gradle.kts:5`). The generated file is
> **not** in git (gitignored `gen/`) and glob-based existence checks can't
> see it — the template lives upstream at
> `crates/tauri-cli/templates/mobile/android/gradle.properties`. Rule: when
> tuning a generated file, read it first and merge; treat the Tauri template
> lines as load-bearing.

- `parallel=true`: parallel project execution (the android project is small,
  benefit is modest but free).
- `caching=true`: task output cache across builds — helps after Rust-only
  changes where gradle tasks are otherwise re-run.
- `jvmargs`: enough heap to avoid GC stalls mid-build; the machine builds the
  universal APK (3 Rust targets + packaging).
- `org.gradle.configuration-cache` **is** enabled by the Tauri template
  (`gradle.properties` ships it), and the build logs
  `Configuration cache entry stored.` on success — so it is kept. (An earlier
  revision of this doc claimed it was "deliberately not enabled"; that was
  wrong — the flag comes from the template, and the 2026-11-12 build proved it
  works with this project's scripts.)
- **Never blind-overwrite** this file (see the INCIDENT box above): the
  tuning is **merged** into the generated file by
  `app/build.sh` → `tune_android_build()`, which rewrites the three keys and
  appends only what is missing. The Tauri template lines stay untouched.

## 3. Debug APK size budget (< 50 MiB)

User requirement (2026-10-10): the debug APK must stay under 50 MiB. The
bloat was DWARF: the x86_64 debug `libapp_lib.so` carried ~300 MB of debug
info (~88 MB APK). Fix lives in `app/src-tauri/Cargo.toml`:

```toml
[profile.dev]
strip = "debuginfo"          # DWARF out of the final link; symbol names stay
                             # so panic backtraces still resolve
[profile.dev.package."*"]
debug = false                # third-party crates: no debug info at all
opt-level = 1                # deps at -O1 — code section shrinks several-fold
```

First-party code keeps full debug semantics (assertions on, opt-level 0,
symbols kept); only third-party crates lose DWARF/get -O1 — dep panics in
tests lose source lines, which never mattered here. Side effect: deps must
be recompiled once per machine after the change, and desktop `tauri dev` /
`cargo test` get *faster* (deps at -O1, no debuginfo emission).

Measure after every profile change:
`Get-Item gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk`
— the single-arch debug APK. (The `universal/` outputs package whatever
jniLibs symlinks exist, including stale release `.so`s — see mobile
09-problems P29 — always read the x86_64 path for an x86_64-only build.)

## Rejected (do not re-add without evidence)

| Proposal | Verdict | Why |
| --- | --- | --- |
| `build.watchExpression` in `tauri.conf.json` | ❌ wrong key | Tauri 2 `build` schema has `additionalWatchFolders`, `beforeDevCommand`, `devUrl`, `frontendDist`, `features`, `runner` — no `watchExpression`. Unknown keys can fail config parsing. Also a non-problem: the watcher only sees `app/src` + `app/src-tauri`; `docs/`, `screenshots/` are never watched |
| `cargo install -f cargo-binutils` for LLD | ❌ wrong tool | cargo-binutils wraps llvm-tools (objdump/readobj); it is not a linker. LLD ships with rustup's stable toolchain |
| `-C link-arg=-fuse-ld=lld` | ❌ wrong syntax | clang-only flag; MSVC `link.exe` rejects it. Correct: `linker = "rust-lld"` |
| `npm run css -- --watch` | ♻️ already exists | `npm run css:watch` (`app/package.json:9`) |
| Shared `CARGO_TARGET_DIR` | ⚠️ skipped | one-time full rebuild; can break Tauri's jniLibs packaging lookup (relies on project `target/` layout) |
| Mold linker for Android targets | ♻️ no-op | NDK ≥ r23 already defaults to `lld` |
| `--target aarch64-linux-android` (full triples) | ⚠️ unproven here | this repo's proven invocation is `--target aarch64 armv7 x86_64` (universal) or a single arch |
| husky pre-commit hook | ⚠️ skipped | new dependency + a git hook that can fight the standing commit/push rules; use explicit `npm test && npm run lint` instead |
| Windows Defender exclusions | 📝 manual | requires admin + user decision; not automatable from the repo |
| `swatinem/rust-cache` in CI | ⏸ deferred | linux/macos workflows already hand-roll `actions/cache@v4`; conversion is a separate CI task |

## BUILD D1 (2026-10-11) — x86_64 debug APK ≤ 50 MiB (planned, then measured)

Plan (written before the build, docs-first): single-ABI
`npm run tauri -- android build --target x86_64 --debug --apk --ci`
(emulator ABI only — smallest possible debug artifact; universal would
triple the native libs). Size gate: single-arch debug APK at
`gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk`
must be < 52,428,800 B (50 MiB) — the `[profile.dev]` strip/DWARF-off
config in `app/src-tauri/Cargo.toml` is what makes this possible (was
~88 MB before). Second lever (same class as the release fix in
APK-SIZE.md): `jniLibs.useLegacyPackaging = true` on the debug
buildType in `gen/android/app/build.gradle.kts` so the 49 MB `.so`
deflates instead of storing raw (~87% of the first-build APK). Emulator: `Pixel6_API36`, `adb uninstall
com.openmusic.trancemusic` (package clean, not a factory reset), fresh
`adb install`, launch via monkey, evidence = APK bytes + zip `.so`
breakdown + `dumpsys` focused app + boot/mediaserver logcat lines.

Result: ✅ PASS (2026-10-11, this session).
- First build (strip only, `.so` STORED raw): 56,397,808 B = 53.8 MiB —
  OVER budget; `lib/x86_64/libapp_lib.so` 49,072,928 B was 87% of the APK.
- Final build (+ `useLegacyPackaging` on debug): **19,905,628 B = 18.98
  MiB** at `gen/android/app/build/outputs/apk/universal/debug/
  app-universal-debug.apk`; `.so` deflated 49.07 → 12.58 MB.
- Install on `Pixel6_API36` after `adb uninstall
  com.openmusic.trancemusic` (Success, verified absent): `adb install` →
  **Success**; monkey launch → `MainActivity` top-resumed + focused (pid
  4404), `versionName=0.4.0`, no FATAL in logcat; screenshot shows fresh
  onboarding ("What moves you?") rendering — expected post-wipe.
- Environment: `gen/` + `target/` + `node_modules/` were all missing, so
  `npm install` (CLI 2.12.0) + `tauri android init` (NDK 28.2) ran first;
  INTERNET already in the fresh template, added ACCESS_NETWORK_STATE +
  CAMERA + loopback `network_security_config.xml` + `OpenMusic` label by
  hand (PowerShell, no bash/CRLF round-trip).

## BUILD D2 (2026-11-12) — one-command lightweight debug APK + a fast next build

User requirement (2026-11-12): *"build lightweight apk. and build in a way so
that next build will take less time, fast, efficient."*

### What changed (all in `app/build.sh`, all re-applied automatically)

| Lever | Where | Effect |
|---|---|---|
| `tune_android_build()` | new function in `app/build.sh` | merges `org.gradle.jvmargs=-Xmx4g …`, `org.gradle.parallel=true`, `org.gradle.caching=true` into `gen/android/gradle.properties`, and sets `useLegacyPackaging` on the **debug** buildType |
| `./build.sh android-debug` | new dispatcher target | the emulator APK in one command: permissions + media layer + tuning + `android build --target x86_64 --debug --apk --ci` |
| every android path calls it | `cmd_android`, `cmd_android_debug`, `cmd_android_universal` | the tuning is never a one-off manual edit |

**Why it has to live in `build.sh`:** `gen/` is **gitignored**
(`.gitignore:56`), so `tauri android init` wipes `gradle.properties` and
`build.gradle.kts` back to the Tauri template. A hand-edited setting is lost
at the worst moment. `tune_android_build()` re-applies both files on every
build, so "the next build is fast + small" is the default, not a chore.

### The two measured size levers

`useLegacyPackaging` decides whether the `.so` is **deflated** or **stored
raw** in the APK. The x86_64 debug `libapp_lib.so` is ~87% of the artifact:

| Build | APK bytes | MiB | `lib/x86_64/libapp_lib.so` | method |
|---|---|---|---|---|
| without legacy packaging | 58,440,387 | **55.73** | 51,098,640 raw | **STORED** |
| with legacy packaging (`./build.sh android-debug`) | **20,264,813** | **19.33** | 51,098,640 raw → 12,921,083 packed | DEFLATE |

**−36.4 MiB (−65%)** for one line of Kotlin DSL. The 19.33 MiB result is
slightly above BUILD D1's 18.98 MiB because this build also carries the
Android media/widget layer (`android-overlay/` → 10 dex files + widget
resources), which BUILD D1 did not inject.

### Result (2026-11-12, this session)

- `./build.sh android-debug` → `REAL_BUILD_EXIT=0` (measured with
  `set -o pipefail`; the earlier run reported a false `BUILD_EXIT=0`).
- Artifact: `app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
  — **20,264,813 B = 19.33 MiB**.
- Packaged manifest (aapt2 dump): `networkSecurityConfig=@0x7f120002`,
  `usesCleartextTraffic=true`, `ACCESS_LOCAL_NETWORK` + `CAMERA` +
  `INTERNET` permissions, `screenOrientation=1` (portrait), the
  `android:scheme="openmusic"` intent filter.
- Install on `Pixel6_API36`: `adb uninstall` (old signature) → `adb install`
  → **Success**; `versionName=0.5.1`, `versionCode=5001`, `targetSdk=37`.
- Live: onboarding 3 steps → Home renders live catalog + artwork → **playback
  works** (Now Playing "Dil Lagana Mana Tha" at 0:07, `AAudioStream` opened
  and started) — the loopback relay needs the P54 cleartext fix, so this also
  proves that fix end-to-end.

### Two API traps measured here (both fail the build, not silently)

1. **`useLegacyPackaging` placement.** AGP 8+ spells it
   `packaging { jniLibs { useLegacyPackaging = true } }`. Written directly
   under `packaging { }` it is an **unresolved reference** and the whole
   Kotlin script fails to compile:
   `e: …/build.gradle.kts:35:17: Unresolved reference 'useLegacyPackaging'.`
   → `BUILD FAILED in 18s`. `tune_android_build()` now deletes any
   wrongly-placed line before inserting the correct `jniLibs { }` block.
2. **`cmd | tail` masks the failure.** The first run printed
   `BUILD_EXIT=0` while gradle had failed — `$?` was `tail`'s status, not the
   build's. Use `set -o pipefail` around any build pipeline (the repo's
   standing CI rule, `docs/cross-platform-ci.md`).

### Fast-next-build checklist

| Step | Effect |
|---|---|
| never `cargo clean` / never delete `app/src-tauri/target` | the 488-crate dependency graph stays compiled (a cold Rust build is ~10 min; a warm one is seconds) |
| `--target x86_64` only | one Rust target instead of three — the single biggest lever |
| `--debug` | the dev profile; `[profile.dev.package."*"]` already builds deps at `-O1` without debuginfo |
| `org.gradle.caching=true` + configuration cache | rust-only changes skip packaging entirely |
| `./build.sh android-debug` | re-applies the tuning, so a fresh `tauri android init` costs nothing |

### The 13 MB of invisible padding (2026-11-12)

A rebuild produced a **31.65 MiB** APK even though the `.so` was deflated
exactly as before. The zip explained it: between `classes9.dex` and
`lib/x86_64/libapp_lib.so` sat **12,921,137 bytes of zero padding** behind a
dummy local file header (empty name, STORED) — the size of the compressed
`.so` itself.

**Two separate causes, both fixed in `tune_android_build()` / `cmd_android_debug`:**

1. **`jniLibs.keepDebugSymbols` kept the symbols in the `.so`.** AGP strips a
   native lib's debug symbols unless a `keepDebugSymbols` pattern claims it —
   and this template claims all four ABIs. The shipped `.so` was therefore
   **51 MB** with DWARF instead of **31 MB**. The tuner now strips those four
   lines from the debug buildType. It buys nothing here: `extractNativeLibs=true`,
   so the library is unpacked at install time and no native debugger reads
   symbols out of the APK.
2. **AGP's incremental packager leaves a stale alignment placeholder.** With
   the symbols gone the `.so` deflated to 10.6 MB, but the APK still carried a
   zero-filled dummy entry of the same size — **on a rebuild only**. A clean
   packaging state does not produce it. `cmd_android_debug` therefore wipes
   `gen/android/app/build/{intermediates,outputs,tmp}` before the APK step
   (the Rust artifacts in `app/src-tauri/target` are untouched, so this costs
   the dex/Kotlin step, not a rebuild).

Result: **17,941,741 B = 17.11 MiB**, `.so` 31 MB → 10.6 MB packed, no
padding.

How to see it: parse the zip's **local** headers (the central directory's
`extra` length is not the local one — using it invents gaps that are not
there). An entry whose data is zeros, right before the `.so`, is the
reservation.

## Related

- Verification gates: `docs/architecture.md`, AGENTS.md (commands section).
- Android signing + universal build: `docs/android-universal-release.md`.
- CI pipefail/annotation patterns: `docs/cross-platform-ci.md`.
