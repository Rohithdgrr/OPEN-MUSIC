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
3. **Install Node.js** - Version 20 via `actions/setup-node@v4`
4. **Install system dependencies**:
   - `openssl@3` via Homebrew
5. **Cache cargo** - Registry, index, and build artifacts
6. **Install frontend dependencies** - `npm ci`
7. **Build CSS** - `npm run css`
8. **Run Rust tests** - `cargo test --release`
9. **Run Node.js tests** - `npm test`
10. **Build Tauri app** - `cargo tauri build`
11. **Verify build artifacts** - Checks for .app and .dmg
12. **Upload artifacts** - 7-day retention
13. **Smoke test** - Verify app bundle structure and binary
14. **Create build summary** - GitHub Actions summary with artifact info

**Artifacts:**
- `macos-build-artifacts`
  - `*.dmg` - macOS disk image
  - `*.app` - macOS application bundle

**Secrets (optional for code signing):**
- `TAURI_PRIVATE_KEY` - Tauri signing key
- `TAURI_KEY_PASSWORD` - Tauri key password
- `APPLE_SIGNING_IDENTITY` - Apple developer identity
- `APPLE_CERTIFICATE` - Code signing certificate (base64)
- `APPLE_CERTIFICATE_PASSWORD` - Certificate password
- `APPLE_PROVISIONING_PROFILE` - Provisioning profile

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
