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
- `org.gradle.configuration-cache` is deliberately **not** enabled: Tauri's
  generated build scripts may not be configuration-cache clean; enabling it
  risks hard failures for little gain.

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

## Related

- Verification gates: `docs/architecture.md`, AGENTS.md (commands section).
- Android signing + universal build: `docs/android-universal-release.md`.
- CI pipefail/annotation patterns: `docs/cross-platform-ci.md`.
