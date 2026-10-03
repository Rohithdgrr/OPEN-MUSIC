# Builds the signed Windows release (MSI + NSIS) with updater artifacts.
# Run from the app folder:  powershell -File build-windows.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Updater signing key (matches plugins.updater.pubkey in tauri.conf.json).
$keyPath = Join-Path $env:USERPROFILE '.tauri\open-music.pem'
if (Test-Path $keyPath) {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw)
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

# Optional: bake Google Drive support into the build.
if ($env:TRANCE_MUSIC_GOOGLE_CLIENT_ID) { "Google client id: baked in" }
else { "Google client id: not set (Drive UI is parked in this build anyway)" }

npm run css
npx tauri build --bundles msi,nsis
"EXITCODE=$LASTEXITCODE"