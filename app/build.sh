#!/usr/bin/env bash
# OPEN MUSIC — one-shot build. Builds whatever this machine can make and
# says plainly what needs another machine or CI.
#
#   ./build.sh            verify + every target available here
#   ./build.sh check      lint + css + tests only
#   ./build.sh android    release APKs, split per ABI (aarch64 + x86_64)
#   ./build.sh android-universal
#                           one signed universal APK (arm64 + armv7 + x86_64)
#   ./build.sh linux      .deb + .AppImage (Linux only)
#   ./build.sh windows    MSI + NSIS (delegates to build-windows.ps1)
#   ./build.sh macos      .app + .dmg (macOS only)
#   ./build.sh ios        iOS build (macOS + Xcode)
#
# macOS/iOS cannot be built from Windows or WSL — push a tag (v*) and
# release.yml builds Windows/Linux/macOS on runners.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

WSL=0; [[ -n "${WSL_DISTRO_NAME:-}" ]] && WSL=1
IS_MAC=0; [[ "$(uname -s)" == "Darwin" ]] && IS_MAC=1
IS_WIN=0; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1;; esac
WIN_NODE="/mnt/c/Program Files/nodejs/node.exe"
WIN_NPM_CLI_W="/mnt/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" # existence check
WIN_NPM_CLI="C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"       # what Windows node sees
# WSL writes land on /mnt/c, which makes cargo 2-3x slower — keep cargo's
# scratch in the Linux filesystem. (Artifacts are located by find, not path.)
[[ $WSL == 1 ]] && export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/tm-target}"

have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "build.sh: $*" >&2; exit 1; }

tauri_cli() {
  have node || die "node is missing (apt install nodejs npm / brew install node)"
  node node_modules/@tauri-apps/cli/tauri.js "$@"
}
# Android lives behind the Windows SDK/NDK: on WSL that means the Windows
# node (and Windows cargo), even after Linux node is installed.
tauri_android() {
  if [[ $WSL == 1 && -f "$WIN_NODE" ]]; then
    "$WIN_NODE" node_modules/@tauri-apps/cli/tauri.js "$@"
  else
    tauri_cli "$@"
  fi
}
# Frontend steps run on whichever node we have; WSL falls back to Windows npm.
npm_run() {
  if have npm; then npm run "$@"
  elif [[ -f "$WIN_NPM_CLI_W" ]]; then "$WIN_NODE" "$WIN_NPM_CLI" run "$@"
  else die "npm is missing (apt install nodejs npm)"; fi
}

linux_deps_ok() {
  have npm && have pkg-config && pkg-config --exists webkit2gtk-4.1 2>/dev/null
}
ensure_linux_deps() {
  have apt-get || die "no apt here — install the webkit2gtk toolchain manually"
  echo "installing Linux build deps (sudo may ask for your password)…"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nodejs npm pkg-config build-essential libssl-dev patchelf \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
}

cmd_check()  { npm_run lint; npm_run css; npm_run test; echo "check: OK"; }

inject_android_permissions() {
  local manifest="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
  if [[ ! -f "$manifest" ]]; then
    echo "AndroidManifest.xml not found - run 'tauri android init' first"
    return 1
  fi
  
  # Check if already injected. CAMERA arrived with the scan-to-join spike
  # (jam-upgrade.md §4.1) — a manifest that already has INTERNET must still
  # gain CAMERA, so both are checked before the early return.
  if grep -q 'android.permission.INTERNET' "$manifest" \
     && grep -q 'android.permission.CAMERA' "$manifest"; then
    echo "✓ Android permissions already present"
    return 0
  fi

  echo "Injecting Android permissions..."
  
  # Create network security config for cleartext loopback (media proxy)
  local nsc="src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml"
  mkdir -p "$(dirname "$nsc")"
  cat > "$nsc" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Allow cleartext for localhost/loopback only (media proxy) -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">::1</domain>
    </domain-config>
</network-security-config>
EOF
  
  # Inject permissions after <manifest> opening tag — each guarded on its own
  # absence so an existing INTERNET-only manifest upgrades to CAMERA without
  # doubling the lines it already has (jam-upgrade.md §4.1).
  if ! grep -q 'android.permission.INTERNET' "$manifest"; then
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.INTERNET"/>\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>' "$manifest"
    # Add network security config reference to <application> tag
    sed -i 's|<application|<application\n        android:networkSecurityConfig="@xml/network_security_config"|' "$manifest"
    echo "✓ Injected INTERNET permission and network security config"
  fi
  if ! grep -q 'android.permission.CAMERA' "$manifest"; then
    # Camera for the scan-to-join QR flow; runtime prompt fires on first
    # getUserMedia (jam-upgrade.md §4.1).
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.CAMERA"/>' "$manifest"
    echo "✓ Injected CAMERA permission"
  fi
  inject_android_label
  return 0
}

# Launcher + activity label is "OpenMusic". productName stays OPEN MUSIC
# (desktop bundles, updater artifacts and CI globs derive from it), so the
# rename is an android-only strings rewrite, same pattern as the permission
# injection above (docs/mobile/06-features.md §Android application name).
# gen/ is regenerated by `tauri android init`, hence per-build, not committed.
inject_android_label() {
  local strings="src-tauri/gen/android/app/src/main/res/values/strings.xml"
  if [[ ! -f "$strings" ]]; then
    echo "strings.xml not found - run 'tauri android init' first"
    return 1
  fi
  sed -i 's|<string name="app_name">.*</string>|<string name="app_name">"OpenMusic"</string>|' "$strings"
  sed -i 's|<string name="main_activity_title">.*</string>|<string name="main_activity_title">"OpenMusic"</string>|' "$strings"
  echo "✓ Android label set to OpenMusic"
}

cmd_android() {
  # Release only, split per ABI: one APK per architecture instead of a fat
  # APK carrying every target's .so.
  inject_android_permissions || die "Failed to inject Android permissions"
  local args=(android build --target aarch64 x86_64 --split-per-abi --apk --ci)
  tauri_android "${args[@]}"
}

cmd_android_universal() {
  # Release, universal: one signed APK carrying arm64-v8a + armeabi-v7a +
  # x86_64 — installs on every real phone (ARM) and the x86_64 emulator,
  # no per-architecture choice at download time.
  inject_android_permissions || die "Failed to inject Android permissions"
  local args=(android build --target aarch64 armv7 x86_64 --apk --ci)
  tauri_android "${args[@]}"
}

cmd_linux() {
  [[ $IS_WIN == 1 || $IS_MAC == 1 ]] && die "Linux build needs Linux — use release.yml (tag v*) instead"
  linux_deps_ok || ensure_linux_deps
  tauri_cli build --bundles deb,appimage --ci
}

cmd_windows() {
  if have powershell.exe; then powershell.exe -NoProfile -ExecutionPolicy Bypass -File build-windows.ps1
  elif have pwsh; then pwsh -File build-windows.ps1
  else die "Windows build runs on Windows (or use release.yml — tag v*)"; fi
}

cmd_macos() {
  [[ $IS_MAC == 1 ]] || die "macOS build needs a Mac — push a tag (v*), release.yml builds it on macos-latest"
  have xcodebuild || die "Xcode CLT missing: xcode-select --install"
  tauri_cli build --bundles app,dmg --ci
}

cmd_ios() {
  [[ $IS_MAC == 1 ]] || die "iOS build needs macOS + Xcode (there is no Windows/WSL path)"
  have xcodebuild || die "Xcode missing: xcode-select --install"
  tauri_cli ios build --debug
  echo "ios: open src-tauri/gen/apple/*.xcodeproj to sign and export the .ipa"
}

show_artifacts() { # $1 = stamp file taken before the build started
  echo
  echo "artifacts built since $(date -r "$1" '+%H:%M'):"
  find src-tauri/target src-tauri/gen/android/app/build/outputs "${CARGO_TARGET_DIR:-/nonexistent}" \
    -type f \( -name '*.apk' -o -name '*.aab' -o -name '*.deb' -o -name '*.AppImage' \
             -o -name '*.msi' -o -name '*.exe' -o -name '*.dmg' \) \
    -newer "$1" 2>/dev/null | sort | sed 's/^/  /' || true
  echo "(tag v* pushes build Windows/Linux/macOS installers in CI)"
}

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

# Dispatcher — guarded so the functions (notably inject_android_permissions)
# can also be sourced standalone: bash -c '. ./build.sh; inject_android_permissions'
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
case "${1:-all}" in
  check)   cmd_check ;;
  android) stamp=$(mktemp); touch "$stamp"; cmd_android; show_artifacts "$stamp" ;;
  android-universal) stamp=$(mktemp); touch "$stamp"; cmd_android_universal; show_artifacts "$stamp" ;;
  linux)   stamp=$(mktemp); touch "$stamp"; cmd_linux;   show_artifacts "$stamp" ;;
  windows) cmd_windows ;;
  macos)   cmd_macos ;;
  ios)     cmd_ios ;;
  all)
    stamp=$(mktemp); touch "$stamp"
    cmd_check
    cmd_android
    if [[ $IS_WIN == 0 && $IS_MAC == 0 ]]; then cmd_linux
    elif [[ $IS_MAC == 1 ]]; then cmd_macos
    fi
    show_artifacts "$stamp"
    ;;
  help|-h|--help) usage ;;
  *) die "unknown target '$1' (see ./build.sh help)" ;;
esac
fi
