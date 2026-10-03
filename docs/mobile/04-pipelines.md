# 04 — Mobile Pipelines

## Map: which workflow does what

| Workflow | File | Trigger | Runner | Produces |
| --- | --- | --- | --- | --- |
| CI | `.github/workflows/ci.yml` | push to `main`, PRs | `windows-latest` (Rust), `ubuntu-latest` (audit, frontend) | Pass/fail only — no artifacts |
| iOS | `.github/workflows/ios.yml` | manual (`workflow_dispatch`), tags `v*` | `macos-14` | Signed `.ipa` **or** unsigned simulator `.app` + `.xcarchive` (artifact `ios-build`, 14 days) |
| Release (desktop) | `.github/workflows/release.yml` | tags `v*` | windows / ubuntu / macos matrix | MSI+NSIS, deb+AppImage, app+dmg + `latest.json` on the GitHub release |

There is **no Android CI workflow yet** — Android builds are local-only
(`npx tauri android build`). That gap is tracked in Future Scope.

## CI (`ci.yml`) — step by step

1. **Rust — fmt, clippy, tests** (`windows-latest`, wd `app/src-tauri`):
   `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` →
   `cargo test` with `OP_OFFLINE=1`.
2. **Rust — cargo audit** (`ubuntu-latest`): `cargo audit` on the lockfile.
3. **Frontend — ESLint, syntax** (`ubuntu-latest`, wd `app`):
   `npm ci` → `npm run lint` → `node --check` every `src/*.js`.

> Note: the syntax loop covers `src/*.js` only — mobile files
> (`src/mobile/**/*.js`) are **not** syntax-checked in CI today. Run the manual
> `node --check` loop from Setup before pushing mobile changes.

## iOS (`ios.yml`) — step by step

1. Checkout → select newest installed Xcode (`xcode-select`), print versions.
2. `npm ci` → `npm run css` → `rustup target add aarch64-apple-ios
   aarch64-apple-ios-sim x86_64-apple-ios`.
3. If `TAURI_APPLE_CERTIFICATE` is set: create `ios-signing` keychain, import
   `.p12`, decode provisioning profile to `$RUNNER_TEMP/mobile/`.
4. `npx tauri ios init --ci` (regenerates the Xcode project).
5. **Signed path** (cert + profile present): `npx tauri ios build --ipa`.
6. **Unsigned path** (no secrets): `npx tauri ios build --ci --verbose --no-sign
   --target aarch64-apple-ios-sim` — the CLI's official unsigned flags; there is
   no `--simulator` flag.
7. On failure: tails `app/ios-build.log` into the **`iOS build log`** issue via
   raw `curl` + `github.token` (deliberately not `gh`, so a broken CLI can't
   swallow the report).
8. Upload `app/src-tauri/gen/apple/build/**/*.ipa|app|xcarchive` as `ios-build`.

Key facts: iOS **cannot** compile on Windows/Linux (Xcode + iOS SDK are
macOS-only). In-app updates do not apply to iOS — the App Store handles it
(header comment, `ios.yml:1-16`).

## Release (`release.yml`) — desktop only

Tag `v*` → 3-way matrix (`msi,nsis` / `deb,appimage` / `app,dmg`) with
`certificateThumbprint: null` override (skips Authenticode until a CA cert is
on the runner), updater signing from secrets → `publish` job downloads all
bundles, runs `node scripts/make-update-json.mjs <tag> <bundle-dir>` to merge
`latest.json` + `update.json`, attaches everything via
`softprops/action-gh-release`. Mobile artifacts are **not** attached here;
iOS ships via the `ios.yml` artifact on the same tag push.

## Local pipelines

| Command | Where | Result |
| --- | --- | --- |
| `powershell -File build-windows.ps1` | `app/` | Signed MSI+NSIS + updater artifacts (uses `~/.tauri/open-music.pem` if present) |
| `npx tauri build --bundles msi,nsis` | `app/` | Same, manual |
| `npx tauri android dev / build` | `app/` | Emulator/dev or release APK/AAB |
| `npx tauri ios build` | `app/` on macOS | `.ipa` / `.app` as above |

## Secrets checklist

- Desktop updater: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Optional Drive: `GOOGLE_CLIENT_ID`
- iOS signing: `TAURI_APPLE_CERTIFICATE`, `TAURI_APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_PROVISIONING_PROFILE`, `APPLE_TEAM_ID`
