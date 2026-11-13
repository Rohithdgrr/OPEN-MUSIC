#!/usr/bin/env bash
# OpenMusic — one-shot build. Builds whatever this machine can make and
# says plainly what needs another machine or CI.
#
#   ./build.sh            verify + every target available here
#   ./build.sh check      lint + css + tests only
#   ./build.sh android    release APKs, split per ABI (aarch64 + x86_64)
#   ./build.sh android-debug
#                           debug APK for the emulator (x86_64 only — one Rust
#                           target, smallest/fastest build; tuned gradle +
#                           legacy packaging, docs/dev-loop-speed.md)
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

tune_android_build() {
  # Build-speed + APK-size levers for the Android project (docs/dev-loop-speed.md
  # §2 and §3). Both files live in the **gitignored** gen/ tree, so they are
  # wiped by every `tauri android init` — that is why they are applied here,
  # not hand-edited once. Every android build path calls this.
  #
  #   1. gradle.properties — parallel execution + task output cache + a
  #      bigger heap. Applies to the NEXT build: gradle reuses the daemon, the
  #      configuration cache and the task cache, and rust-only changes no
  #      longer re-run packaging.
  #   2. useLegacyPackaging on the debug buildType — the x86_64 debug .so is
  #      ~87% of the APK; legacy packaging deflates it instead of storing it
  #      raw (56.4 MB -> 19.9 MiB, measured 2026-10-11, docs/dev-loop-speed.md
  #      BUILD D1). Packaging only, no runtime behaviour change.
  local props="src-tauri/gen/android/gradle.properties"
  if [[ -f "$props" ]]; then
    # NEVER blind-overwrite this file (docs/dev-loop-speed.md §2 INCIDENT
    # 2026-10-07): the Tauri template lines (android.builtInKotlin=false,
    # android.newDsl=false, android.proguard.failOnMissingFiles=false) are
    # load-bearing — dropping them breaks the build at configuration time.
    # Read, merge, keep everything else.
    _set_prop() {
      local key="$1" val="$2"
      if grep -q "^${key}=" "$props"; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$props"
      else
        printf '%s=%s\n' "$key" "$val" >> "$props"
      fi
    }
    _set_prop org.gradle.jvmargs "-Xmx4g -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=512m -XX:+UseParallelGC"
    _set_prop org.gradle.parallel "true"
    _set_prop org.gradle.caching "true"
    echo "✓ Gradle tuned for faster rebuilds (parallel + task cache + 4g heap)"
  else
    echo "⚠ gradle.properties not found - run 'tauri android init' first"
  fi

  local gradle="src-tauri/gen/android/app/build.gradle.kts"
  if [[ -f "$gradle" ]]; then
    # AGP 8+ spells this `packaging { jniLibs { useLegacyPackaging = true } }`.
    # A bare `useLegacyPackaging` directly under `packaging {` is an
    # unresolved reference -> the whole Kotlin script fails to compile
    # (measured 2026-11-12). Drop any wrongly-placed line first.
    sed -i '/^[[:space:]]*useLegacyPackaging[[:space:]]*=[[:space:]]*true[[:space:]]*$/d' "$gradle"
    if grep -q 'useLegacyPackaging' "$gradle"; then
      echo "✓ useLegacyPackaging already set (debug APK stays small)"
    else
      # Insert a jniLibs block into the debug buildType's own packaging block.
      # The range ends at the 8-space "}" that closes getByName("debug") { ... }.
      sed -i '/getByName("debug")/,/^        }/ s|^\( *\)packaging {$|\1packaging {\n\1    jniLibs {\n\1        useLegacyPackaging = true\n\1    }|' "$gradle"
      # keepDebugSymbols on a native lib makes AGP reserve aligned space for
      # an UNCOMPRESSED copy of it, which showed up as ~13 MB of zero padding
      # in the APK (the .so is deflated anyway with useLegacyPackaging). It
      # buys nothing here: extractNativeLibs=true, so the lib is unpacked at
      # install time and no native debugger reads symbols from the APK.
      sed -i '/getByName("debug")/,/^        }/ s|^\( *\)jniLibs\.keepDebugSymbols\.add(.*$||' "$gradle"
      if grep -q 'useLegacyPackaging' "$gradle"; then
        echo "✓ useLegacyPackaging enabled on the debug buildType (smaller APK)"
      else
        echo "⚠ could not set useLegacyPackaging (debug APK will be ~55 MiB)"
      fi
    fi
  else
    echo "⚠ build.gradle.kts not found - run 'tauri android init' first"
  fi
}

inject_android_permissions() {
  local manifest="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
  if [[ ! -f "$manifest" ]]; then
    echo "AndroidManifest.xml not found - run 'tauri android init' first"
    return 1
  fi
  
  # Check if already injected. CAMERA arrived with the scan-to-join spike
  # (jam-upgrade.md §4.1) — a manifest that already has INTERNET must still
  # gain CAMERA, so each is checked before the early return.
  # ACCESS_LOCAL_NETWORK (Android 17 / API 37 targets) gates device-to-device
  # LAN traffic — the Jam room server/guest sockets — so a host or guest on a
  # real Android 17 device is dead without it (P43).
  # The predicate must list EVERY idempotent manifest injection below — the
  # early return otherwise skips them (2026-10-17: the share deep-link filter
  # was dead on warm manifests under the permissions-only predicate).
  if grep -q 'android.permission.INTERNET' "$manifest" \
     && grep -q 'android.permission.CAMERA' "$manifest" \
     && grep -q 'android.permission.ACCESS_LOCAL_NETWORK' "$manifest" \
     && grep -q 'android:screenOrientation="portrait"' "$manifest" \
     && grep -q 'android:scheme="openmusic"' "$manifest" \
     && grep -q 'android:networkSecurityConfig' "$manifest"; then
    echo "✓ Android manifest injections already present"
    return 0
  fi

  echo "Injecting Android permissions..."
  
  # Create network security config for cleartext loopback (media proxy).
  # Written PER BUILD TYPE, because a referenced NSC makes Android ignore the
  # usesCleartextTraffic placeholder: the release build must keep the
  # loopback-only policy, while the debug build declares
  # usesCleartextTraffic=true (tauri android dev's LAN devUrl) and must not
  # be narrowed by the referenced config (2026-11-12, P54).
  local nsc="src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml"
  mkdir -p "$(dirname "$nsc")"
  cat > "$nsc" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Allow cleartext for localhost/loopback only (media proxy) -->
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">::1</domain>
    </domain-config>
</network-security-config>
EOF
  # Debug override: the debug build type sets usesCleartextTraffic=true, and
  # `tauri android dev` serves the frontend from http://<pc-ip>:1430.
  local nsc_debug="src-tauri/gen/android/app/src/debug/res/xml/network_security_config.xml"
  mkdir -p "$(dirname "$nsc_debug")"
  cat > "$nsc_debug" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Debug builds keep global cleartext (tauri android dev LAN devUrl). -->
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
EOF
  
  # Inject permissions after <manifest> opening tag — each guarded on its own
  # absence so an existing INTERNET-only manifest upgrades to CAMERA without
  # doubling the lines it already has (jam-upgrade.md §4.1).
  if ! grep -q 'android.permission.INTERNET' "$manifest"; then
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.INTERNET"/>\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>' "$manifest"
    echo "✓ Injected INTERNET permission"
  fi
  # The network security config reference MUST NOT live in the INTERNET
  # branch: the Tauri template ships INTERNET by default, so that branch is
  # skipped and the attribute was silently dropped — a release build then
  # applied usesCleartextTraffic=false with no loopback allowance and the
  # media relay was blocked (2026-11-12, P54).
  if ! grep -q 'android:networkSecurityConfig' "$manifest"; then
    sed -i 's|<application|<application\n        android:networkSecurityConfig="@xml/network_security_config"|' "$manifest"
    echo "✓ Referenced network security config (loopback cleartext)"
  fi
  if ! grep -q 'android.permission.CAMERA' "$manifest"; then
    # Camera for the scan-to-join QR flow; runtime prompt fires on first
    # getUserMedia (jam-upgrade.md §4.1).
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.CAMERA"/>' "$manifest"
    echo "✓ Injected CAMERA permission"
  fi
  if ! grep -q 'android.permission.ACCESS_LOCAL_NETWORK' "$manifest"; then
    # Android 17 (API 37) runtime permission for device-to-device LAN traffic;
    # harmless no-op on older OSes, mandatory for Jam on real API 37 devices
    # (docs/mobile/09-problems-solutions.md P43).
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.ACCESS_LOCAL_NETWORK"/>' "$manifest"
    echo "✓ Injected ACCESS_LOCAL_NETWORK permission"
  fi
  if ! grep -q 'android:screenOrientation="portrait"' "$manifest"; then
    # Portrait-only (2026-10-15, docs/android-universal-release.md): pin
    # MainActivity so rotation never recreates the WebView; guarded on its
    # own absence like the rest.
    sed -i 's|android:name=".MainActivity"|android:name=".MainActivity"\n            android:screenOrientation="portrait"|' "$manifest"
    echo "✓ Locked Android orientation to portrait"
  fi
  if ! grep -q 'android:scheme="openmusic"' "$manifest"; then
    # Share deep links (docs/share-deep-links.md §4): the `openmusic://`
    # scheme filter on MainActivity. tauri-plugin-deep-link receives the
    # intent through its onNewIntent hook; Chrome's intent:// URLs from
    # play.html land here without App-Links verification. ACTION_VIEW is
    # mandatory — a filter without it matches no browser intent. Guarded +
    # idempotent like every injection above — survives `tauri android init`.
    sed -i 's|</activity>|    <intent-filter>\n        <action android:name="android.intent.action.VIEW" />\n        <category android:name="android.intent.category.DEFAULT" />\n        <category android:name="android.intent.category.BROWSABLE" />\n        <data android:scheme="openmusic" />\n    </intent-filter>\n</activity>|' "$manifest"
    echo "✓ Injected openmusic:// deep-link intent filter"
  fi
  inject_android_label
  return 0
}

# Launcher + activity label is "OpenMusic". productName is now OpenMusic too
# (v0.5.1 visible rename; desktop bundles, updater artifacts and CI globs
# derive from it), so the label rewrite just pins the value explicitly, same
# pattern as the permission injection above (docs/mobile/06-features.md
# §Android application name).
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

# Native media layer (notification + lockscreen + homescreen widget).
# Tracked sources live in src-tauri/android-overlay; gen/ is wiped by
# `tauri android init`, so every build copies them in and patches the
# manifest + MainActivity idempotently (docs/android-media-widget.md).
# Same per-build pattern as inject_android_permissions above.
inject_android_mediahub() {
  local overlay="src-tauri/android-overlay"
  local main="src-tauri/gen/android/app/src/main"
  if [[ ! -d "$overlay/kotlin" ]]; then
    echo "android-overlay missing - nothing to inject"
    return 1
  fi
  if [[ ! -f "$main/AndroidManifest.xml" ]]; then
    echo "AndroidManifest.xml not found - run 'tauri android init' first"
    return 1
  fi

  local pkg="java/com/openmusic/trancemusic"
  mkdir -p "$main/$pkg" "$main/res/xml" "$main/res/layout" "$main/res/values"
  cp "$overlay/kotlin/"*.kt "$main/$pkg/"
  cp "$overlay/res/xml/"*.xml "$main/res/xml/"
  cp "$overlay/res/layout/"*.xml "$main/res/layout/"
  cp "$overlay/res/values/"*.xml "$main/res/values/"
  echo "✓ MediaHub sources + widget resources copied"

  # Permissions, each guarded on its own absence.
  local manifest="$main/AndroidManifest.xml"
  if ! grep -q 'android.permission.FOREGROUND_SERVICE"' "$manifest"; then
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>' "$manifest"
    echo "✓ Injected FOREGROUND_SERVICE permission"
  fi
  if ! grep -q 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK' "$manifest"; then
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>' "$manifest"
    echo "✓ Injected FOREGROUND_SERVICE_MEDIA_PLAYBACK permission"
  fi
  if ! grep -q 'android.permission.POST_NOTIFICATIONS' "$manifest"; then
    sed -i '/<manifest/a\    <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>' "$manifest"
    echo "✓ Injected POST_NOTIFICATIONS permission"
  fi

  # MediaService + widget receiver before </application>, once (TM-MEDIA marker).
  if ! grep -q 'TM-MEDIA' "$manifest"; then
    sed -i 's|^    </application>|        <!-- TM-MEDIA: media notification + widget -->\n        <service android:name=".MediaService" android:exported="false" android:foregroundServiceType="mediaPlayback" />\n        <receiver android:name=".TmWidget" android:exported="false">\n            <intent-filter>\n                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />\n            </intent-filter>\n            <meta-data android:name="android.appwidget.provider" android:resource="@xml/tm_widget_info" />\n        </receiver>\n    </application>|' "$manifest"
    echo "✓ Injected MediaService + widget receiver"
  else
    echo "✓ MediaService + widget receiver already present"
  fi
  return 0
}

cmd_android() {
  # Release only, split per ABI: one APK per architecture instead of a fat
  # APK carrying every target's .so.
  inject_android_permissions || die "Failed to inject Android permissions"
  inject_android_mediahub || die "Failed to inject Android media layer"
  tune_android_build || die "Failed to tune the Android build"
  local args=(android build --target aarch64 x86_64 --split-per-abi --apk --ci)
  tauri_android "${args[@]}"
}

cmd_android_debug() {
  # Debug, single ABI (x86_64) — the artifact used on the Pixel6_API36
  # emulator. One Rust target instead of three is the single biggest build
  # speed lever, and the debug profile keeps the APK small
  # (docs/dev-loop-speed.md BUILD D1: 18.98 MiB with legacy packaging).
  inject_android_permissions || die "Failed to inject Android permissions"
  inject_android_mediahub || die "Failed to inject Android media layer"
  tune_android_build || die "Failed to tune the Android build"
  # AGP's incremental packager leaves a zero-filled alignment placeholder
  # (roughly the size of the COMPRESSED .so) inside the APK on a rebuild —
  # a ~10 MB phantom that only appears on the second build of a tree, and
  # that makes the APK look like it grew for no reason. A clean packaging
  # state avoids it. The Rust artifacts in app/src-tauri/target are NOT
  # touched, so this costs the dex/Kotlin step, not a rebuild.
  rm -rf src-tauri/gen/android/app/build/intermediates \
         src-tauri/gen/android/app/build/outputs \
         src-tauri/gen/android/app/build/tmp
  local args=(android build --target x86_64 --debug --apk --ci)
  tauri_android "${args[@]}"
}

cmd_android_universal() {
  # Release, universal: one signed APK carrying arm64-v8a + armeabi-v7a +
  # x86_64 — installs on every real phone (ARM) and the x86_64 emulator,
  # no per-architecture choice at download time.
  inject_android_permissions || die "Failed to inject Android permissions"
  inject_android_mediahub || die "Failed to inject Android media layer"
  tune_android_build || die "Failed to tune the Android build"
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
  android-debug) stamp=$(mktemp); touch "$stamp"; cmd_android_debug; show_artifacts "$stamp" ;;
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
