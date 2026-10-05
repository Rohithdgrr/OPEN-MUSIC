# Cross-Platform Build & Test Documentation

This document describes the CI/CD pipeline for building and testing TRANCE MUSIC on Linux and macOS.

## Overview

The project uses GitHub Actions to:
- Build release binaries for Linux (deb, AppImage) and macOS (.app, dmg)
- Run automated tests (Rust, Node.js, smoke tests)
- Verify build artifacts are valid
- Upload artifacts for manual inspection

## Workflows

### Linux Build & Test

**File:** `.github/workflows/linux.yml`

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Manual workflow dispatch

**Steps:**

1. **Checkout code** - Uses `actions/checkout@v4`
2. **Install Rust toolchain** - Stable toolchain via `actions-rust-lang/setup-rust-toolchain@v1`
3. **Install Node.js** - Version 20 via `actions/setup-node@v4`
4. **Install system dependencies**:
   - `libwebkit2gtk-4.1-dev` - WebView2 equivalent for Linux
   - `build-essential` - C/C++ build tools
   - `libssl-dev` - OpenSSL for crypto
   - `libayatana-appindicator3-dev` - System tray support
   - `librsvg2-dev` - SVG rendering
5. **Cache cargo** - Registry, index, and build artifacts
6. **Install frontend dependencies** - `npm ci`
7. **Build CSS** - `npm run css`
8. **Run Rust tests** - `cargo test --release`
9. **Run Node.js tests** - `npm test`
10. **Build Tauri app** - `cargo tauri build`
11. **Verify build artifacts** - Checks for .deb and .AppImage
12. **Upload artifacts** - 7-day retention
13. **Smoke test** - Verify binary execution and package validity
14. **Create build summary** - GitHub Actions summary with artifact info

**Artifacts:**
- `linux-build-artifacts`
  - `*.deb` - Debian package
  - `*.AppImage` - Portable Linux application

### macOS Build & Test

**File:** `.github/workflows/macos.yml`

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Manual workflow dispatch

**Steps:**

1. **Checkout code** - Uses `actions/checkout@v4`
2. **Install Rust toolchain** - Stable toolchain via `actions-rust-lang/setup-rust-toolchain@v1`
3. **Install Node.js** - Version 22 via `actions/setup-node@v4` (Node 20's `--test`
   does not expand the `tests/**/*.test.mjs` glob, so `npm test` exits 1)
4. **Install system dependencies**:
   - `openssl@3` via Homebrew
5. **Cache cargo** - Registry, index, and build artifacts
6. **Install frontend dependencies** - `npm ci`
7. **Build CSS** - `npm run css`
8. **Run Rust tests** - `cargo test --release` with `OP_OFFLINE=1`
9. **Run Node.js tests** - `npm test`
10. **Build Tauri app** - `npx tauri build` (`cargo tauri` is not installed;
    `@tauri-apps/cli` is a devDependency, so the same entry `release.yml` uses)
11. **Verify build artifacts** - Checks for .app and .dmg
12. **Upload artifacts** - 7-day retention
13. **Smoke test** - Verify app bundle structure and binary
14. **Create build summary** - GitHub Actions summary with artifact info

**Artifacts:**
- `macos-build-artifacts`
  - `*.dmg` - macOS disk image
  - `*.app` - macOS application bundle

**Secrets (optional for code signing):**
- `TAURI_SIGNING_PRIVATE_KEY` - Tauri updater signing key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - Tauri signing key password
- `APPLE_SIGNING_IDENTITY` - Apple developer identity
- `APPLE_CERTIFICATE` - Code signing certificate (base64)
- `APPLE_CERTIFICATE_PASSWORD` - Certificate password
- `APPLE_PROVISIONING_PROFILE` - Provisioning profile

> **Correct names matter.** `tauri.conf.json` sets `bundle.createUpdaterArtifacts: true`,
> which makes the updater signing key mandatory at build time. Tauri v2 reads only
> `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The older
> `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` names are silently ignored, so the build
> fails while the variables appear to be "set". `release.yml` uses the correct names;
> `macos.yml` and `linux.yml` did not - see Troubleshooting below.

## Smoke Tests

**File:** `tests/smoke-test.mjs`

**Purpose:** Verify that installed builds work correctly on each platform.

**Test Coverage:**

1. **Binary exists** - Checks if the binary/app bundle is present
2. **Binary executable** - Verifies executable permissions (Linux/macOS)
3. **Binary launch** - Attempts to launch the application with a 5-second timeout
4. **Config files** - Verifies `tauri.conf.json` exists
5. **Frontend assets** - Verifies `index.html` and assets are bundled

**Platform-specific paths:**

- **Linux:**
  - AppImage: `app/src-tauri/target/release/bundle/appimage/trance-music.AppImage`
  - System binary: `trance-music`
- **macOS:**
  - Build: `app/src-tauri/target/release/bundle/macos/TRANCE MUSIC.app`
  - Installed: `/Applications/TRANCE MUSIC.app`
- **Windows:**
  - MSI: `app/src-tauri/target/release/bundle/msi/TRANCE MUSIC_*.msi`
  - Installed: `C:\Program Files\TRANCE MUSIC\trance-music.exe`

**Running smoke tests locally:**

```bash
cd app
npm run test:smoke
```

## Local Build Instructions

### Linux

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

# Build
cd app
npm install
npm run css
npm run tauri build

# Run tests
cd src-tauri
cargo test --release
cd ..
npm test
npm run test:smoke
```

### macOS

```bash
# Install dependencies
brew install openssl@3

# Build
cd app
npm install
npm run css
npm run tauri build

# Run tests
cd src-tauri
cargo test --release
cd ..
npm test
npm run test:smoke
```

### Windows

```bash
# Install MSVC build tools via Visual Studio Installer
# Install WebView2 (preinstalled on Windows 11)

# Build
cd app
npm install
npm run css
npm run tauri build

# Run tests
cd src-tauri
cargo test --release
cd ..
npm test
npm run test:smoke
```

## Troubleshooting

### Linux build fails with webkit2gtk error

```bash
sudo apt-get install libwebkit2gtk-4.1-dev
```

### macOS build fails with OpenSSL error

```bash
brew install openssl@3
export PKG_CONFIG_PATH="/opt/homebrew/opt/openssl@3/lib/pkgconfig"
```

### Cargo cache issues

Clear cache and rebuild:

```bash
cargo clean
cargo build --release
```

### Smoke test fails on launch

- Check if the binary is executable: `chmod +x path/to/binary`
- Verify all dependencies are installed
- Check system logs for runtime errors

### macOS/Linux build fails at "Build Tauri app" with updater signing error

**Symptom:** steps 1-9 pass (Rust tests, Node tests, CSS all green), then
`npx tauri build` exits non-zero. Every artifact/verification step is `skipped`.
`macos.yml` and `linux.yml` have failed on *every* run; `release.yml` passes.

**Cause:** `tauri.conf.json` sets `bundle.createUpdaterArtifacts: true`, so the
build needs a private key to sign updater artifacts. Tauri v2 reads
`TAURI_SIGNING_PRIVATE_KEY` (and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
Setting the v1-era `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` instead means the
variables exist but Tauri never sees them.

**Fix:** use the v2 names in the workflow `env:` block, matching `release.yml`.

**Why CI logs do not show it:** job logs on a public repo still require admin
rights (`403 Must have admin rights to Repository`), so the real error text is
unreadable without a token. The step-level conclusion (`Build Tauri app` ->
failure, everything after -> skipped) is public and is what identifies the step.

### DMG/artifact existence check never matches

Any `[ -f ".../bundle/trance-music_*.deb" ]`-style test cannot work: `test -f`
does not glob a quoted pattern, so the literal `*` is tested and the result is
always false. The step then `exit 1` even after a successful build. This bit
both `macos.yml` (DMG check) and `linux.yml` (`.deb` + `.AppImage` checks) —
on Linux it only surfaced *after* the signing-var fix let the build succeed.
Resolve the glob into a variable first and then test it:

```bash
DEB=$(ls app/src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1)
if [ -n "$DEB" ]; then echo "✓ built: $DEB"; else echo "✗ not found"; exit 1; fi
```

### `-f` used on the `.app` bundle (it is a directory)

A macOS `.app` is a **directory** — `TRANCE MUSIC.app/Contents/Info.plist` is
inside it. `[ -f ".../TRANCE MUSIC.app" ]` is therefore always false and the
step `exit 1`s even though the bundle built correctly. Use `-d` (or `-e`).

This hid for 15 runs: `Build Tauri app` always failed first, so the step after
it never executed. Only once the build succeeded did this latent bug surface.
Rule: whenever a previously-unreachable step starts running, re-read its
predicates — "we've never gotten here" means "this was never tested".

`macos.yml` contradicted itself on this exact path: the artifact check used
`-f` while the smoke test ten lines later used `-d` for the same directory.

### Empty-string secrets are "set" and break macOS signing

In GitHub Actions a missing secret expands to `""`. Writing
`APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}` therefore
*exports the variable as present but empty* — Rust's `env::var` returns
`Ok("")`, not `Err`, so Tauri treats signing as configured and fails while
importing a certificate that isn't there. Linux does not hit this because it
never passes `APPLE_*`. Unset any that are empty before invoking the build:

```bash
for v in APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_PROVISIONING_PROFILE; do
  [ -z "${!v:-}" ] && unset "$v"
done
npx tauri build
```

### CI logs are unreadable without admin — surface errors as annotations

On this public repo, job logs still require auth (`403 Must have admin rights`),
and the HTML/JSON log routes return 404. Step names, conclusions, and
**annotations** are public. So when a step's real error matters, capture it and
emit a workflow command — annotations have no auth requirement:

```bash
if ! npx tauri build 2>&1 | tee /tmp/build.log; then
  echo "::error title=tauri build::$(tail -c 1800 /tmp/build.log)"
  exit 1
fi
```

Read them back at
`GET /repos/{owner}/{repo}/check-runs/{job_id}/annotations`. Note the id is
the **job** id, not the run id, and generic `Process completed with exit code 1`
annotations carry meaningless line numbers — always emit your own message.

**Annotate successes and skips, not just failures.** This is the subtle half.
Annotations are the *only* output channel readable from outside the repo, so a
step whose result matters must report every outcome — `::notice` and
`::warning` are just as public as `::error`. Without them a green run is
ambiguous: consider a step that mounts a `.dmg` and sets `FAIL=1` on any
mounting problem, but merely *warns* when no `.dmg` exists. Green then means
either "mounted and it worked" or "there was nothing to check", and nothing
on the outside can tell those apart. Annotating the skip collapses the
ambiguity.

The general form: **a green run only proves what its failure paths cover.**
Any branch that warns-and-continues is a branch green cannot vouch for, so it
needs its own annotation if you intend to claim that check passed.

Consequence for step design: put the diagnostic text *in the annotation*, not
only in the log. When a launch dies, `dyld`/`@rpath` output lands in a temp
file nobody can read — so inline its tail:
`echo "::error title=launch::$(tail -c 800 /tmp/app-launch.log | tr '\n' ' ')"`.

### `if cmd | tee` silently converts failure into success

The most dangerous pattern here, because it produces a **green run that
tested nothing**.

```bash
if npx tauri build 2>&1 | tee /tmp/build.log; then   # ← looks correct
  echo "✓ ok"
else
  echo "::error ..."; exit 1
fi
```

A pipeline's status is the status of its **last** element. `tee` writes the
file and exits `0`, so the `if` takes the success branch no matter what
`npx tauri build` did. The step reports pass; the annotation never fires; the
failure is invisible. This is worse than having no wrapper at all, because
the wrapper *claims* to be reporting.

Confirmed empirically on this repo: the Linux smoke step was wrapped this way
and reported `✓ smoke tests passed` while the script it invoked could not
even be found (`node tests/smoke-test.mjs` with no such file in `app/`). The
step had failed on the previous run and passed on the next one, with the
underlying path unchanged.

**Fix — set `pipefail` explicitly at the top of the block:**

```bash
set -o pipefail
if npx tauri build 2>&1 | tee /tmp/build.log; then
  ...
```

Do not rely on the runner's default shell for this. GitHub's default for
`run:` did **not** include `pipefail` when this was observed, and the failure
proved it: had `pipefail` been active, the earlier run would not have failed
there in the first place.

Two things worth knowing about combining `pipefail` with the runner's `-e`:
1. `-e` does not trigger on an **`if` condition**, so the `else` branch is
   reached and the `::error` annotation still fires. Verified directly.
2. `set -e` does not save you on its own — without `pipefail` the pipeline
   returns `tee`'s 0, which is not an error at all.

Alternative that does not depend on shell options, used by the macOS
`Verify build artifacts` step: run the pipeline, then read
`rc=${PIPESTATUS[0]}` (that is `PIPESTATUS`, not `$?`, and it must be read
immediately). Both forms are correct; `set -o pipefail` is the shorter one.

**Review rule:** any step that pipes into `tee`, `grep`, `head`, or `cat` for
diagnostic capture needs `pipefail` or `PIPESTATUS`. A test step whose output
is captured but whose status is discarded is not a test.

### Smoke test hardcodes a filename Tauri never emits

`tests/smoke-test.mjs` resolved the Linux binary as:

```js
const appimagePath = join(__dirname, '../app/src-tauri/target/release/bundle/appimage/trance-music.AppImage');
if (existsSync(appimagePath)) return appimagePath;
return 'trance-music';        // bare PATH lookup → spawn ENOENT
```

Tauri names bundles from `productName` + `version`, not from the Cargo package
name. This project has `productName: "TRANCE MUSIC"` and `version: "0.4.0"`,
which is how the macOS image came out as `TRANCE MUSIC_0.4.0_aarch64.dmg`.
The Linux image is likewise not `trance-music.AppImage`, so the lookup missed,
fell through to a bare PATH name that does not exist on a runner, and all
three binary tests failed (`spawn trance-music ENOENT`).

The `.AppImage` was present the whole time — `Verify build artifacts` had
already found it with `find -name "*.AppImage"` and passed. **The build was
fine; the assertion was wrong.** Note also that nothing is *installed* on a
CI runner, so every fallback in this file (`'trance-music'`,
`/Applications/TRANCE MUSIC.app`, `C:\Program Files\...`) is a path that only
exists on a user's machine — the file's own header calls these "installed
builds". That is why the smoke step was dropped from `macos.yml`.

**Rule: never hardcode an artifact filename. Glob the extension.**

```js
function firstMatch(dir, ext) {            // readdir + endsWith, no deps
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.name.toLowerCase().endsWith(ext))
      .map(e => join(dir, e.name))[0];
  } catch { return undefined; }
}
const appimage = firstMatch(bundle + '/appimage', '.appimage');
```

Same defect class was present on Windows: the MSI path was pinned to
`TRANCE MUSIC_0.3.0_x64_en-US.msi` while the app is at `0.4.0`, so that
branch silently fell back to an installed-in-`Program Files` path too. Any
version bump would have broken it unnoticed.

Also relevant: this failure was **invisible** until the `pipefail` fix landed.
Runs #16–#18 wrapped this step in `if npm ... | tee` and reported green while
the script was exiting 1. When a previously-masked step starts failing, the
first question is "what was it hiding?", not "what did I just break?".

## macOS runtime verification (does the .dmg actually run?)

Structure checks only prove files exist. To prove the app *runs*, the macOS
workflow mounts and launches the bundle on the runner:

1. **Mount** - `hdiutil attach -nobrowse -readonly` the built `.dmg`, assert
   `TRANCE MUSIC.app` is inside, then `hdiutil detach`. This is the direct
   "does the dmg open" test.
2. **Launch** - start `TRANCE MUSIC.app/Contents/MacOS/trance-music`, assert the
   process is still alive after N seconds, then terminate it. Catches dyld,
   `@rpath` and immediate-crash faults that a file listing cannot.
3. **Codesign (advisory)** - `codesign --verify --deep --strict` and
   `spctl -a -vv`. Reported, never blocking: an unsigned CI build is *expected*
   to fail Gatekeeper, and that is diagnosis, not regression.
4. **Quarantine** - confirm no `com.apple.quarantine` xattr on the bundle.

**Why not a simulator?** There is no macOS equivalent of the iOS Simulator, and
it cannot run on Windows: Apple's SLA restricts macOS to Apple hardware.
Appetize.io types `platform` as `enum:["ios","android"]` only, and BrowserStack
documents that installing desktop applications on its macOS machines "is
unavailable at the moment". CI on `macos-latest` is therefore the only
zero-cost verification path from Windows.

## Continuous Integration Best Practices

1. **Always run tests locally before pushing** - Ensure tests pass on your machine
2. **Use caching** - Cargo and npm caches speed up builds
3. **Parallelize jobs** - Linux and macOS builds run in parallel
4. **Artifact retention** - 7-day retention balances storage cost and debugging needs
5. **Secrets management** - Never commit secrets; use GitHub Secrets
6. **Build summaries** - Provide clear feedback in GitHub Actions UI

## Future Improvements

- [ ] Add Windows CI workflow
- [ ] Add Android CI workflow
- [ ] Add iOS CI workflow (macOS runners only)
- [ ] Implement automated E2E tests
- [ ] Add performance benchmarks
- [ ] Implement dependency scanning (Snyk, Dependabot)
- [ ] Add code coverage reporting
