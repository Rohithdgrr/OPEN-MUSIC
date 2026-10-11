# Release v0.5.0 — Windows + Linux + Android only (no macOS/iOS)

Spec for cutting v0.5.0. Written before the release work (docs-first rule).

## Scope

| Target | Ships | How |
|---|---|---|
| **Windows** | MSI + NSIS installers | built locally (signing cert on this machine), **and** by CI on tag |
| **Linux** | `.deb` + `.AppImage` | CI on tag only (no Linux box here) |
| **Android** | universal debug/release APK | built locally (`npm run tauri -- android build`); not in CI |
| **macOS / iOS** | **not released** | `macos.yml` / `ios.yml` deleted; macOS job dropped from `release.yml` and `ci.yml` |

## Version bump (three files, must agree)

- `app/src-tauri/tauri.conf.json` → `"version": "0.5.0"` (installer names, updater manifest)
- `app/src-tauri/Cargo.toml` → `version = "0.5.0"` (Cargo.lock updates on next build)
- `app/package.json` → `"version": "0.5.0"`

## Changelog

`CHANGELOG.md` is rewritten concise: one short section per release, only
informative/important items (what a user or maintainer needs to know).
No per-session detail, no file-path dumps — those live in git history and
AGENTS.md.

## Pipeline (tag-driven)

Pushing tag `v0.5.0` triggers `.github/workflows/release.yml`:

1. **build** matrix: `windows-latest` (`msi,nsis`) + `ubuntu-latest`
   (`deb,appimage`) — macOS entry removed.
2. **publish** job assembles `latest.json` (updater manifest), verifies its
   URLs resolve, attaches installers + manifests to the GitHub release.

`macos.yml` and `ios.yml` are deleted so no Apple job can run or report.
`ci.yml` matrix drops `macos-latest` (tests still run on Windows + Ubuntu).

## Release steps (order matters — rule 8)

1. Gates: `npm test`, `npm run lint`, `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.
2. Local installers: `npm run tauri build -- --bundles msi,nsis` with
   `TAURI_SIGNING_PRIVATE_KEY` set (updater artifacts are on, so the key is
   mandatory) — output under `app/src-tauri/target/release/bundle/`.
3. `git log origin/main..HEAD` → confirm intended commits → commit →
   re-verify → `git push origin main` (separate command).
4. `git tag v0.5.0 <sha> && git push origin v0.5.0` (separate command).
5. Watch the Actions run; the release publishes itself.

## Jam re-verification + P43 (2026-10-11, this release)

An external diagnosis claimed the Android host fails because of `127.0.0.1`
binding, cleartext blocks, and a missing `ACCESS_LOCAL_NETWORK`. Checked
against the code: bind is `0.0.0.0` (`room.rs:1086`), the join socket is
Rust-native (not subject to WebView NSC enforcement), and both directions
were already verified live (D6). The one actionable item was
**`ACCESS_LOCAL_NETWORK`** (Android 17 / API 37 runtime permission for
device-to-device traffic; our `targetSdk = 37`, emulator is API 36 so never
exercised): added via `build.sh inject_android_permissions` (own idempotent
guarded block + early-return set) and injected into the live `gen/`
manifest — **P43**. The signaling-server proposal was declined: it
contradicts the LAN-only, no-server security model (`listen-together.md` §7).

Re-verified live on the rebuilt APK (permission confirmed via `aapt dump
permissions`): emulator-host → desktop-guest **538 ms**, desktop-host →
emulator-guest **528 ms**, chat both ways, rooms closed to `idle` after.

## Known caveats (stated, not hidden)

- Windows local build signs with the self-signed `CN=TRANCE MUSIC` cert →
  SmartScreen unknown-publisher on other machines (unchanged since v0.1.0).
- CI build nulls `certificateThumbprint` (no cert on the runner) but keeps
  updater minisign signing if `TAURI_SIGNING_PRIVATE_KEY` secret is set.
- Android APK: attach to the GitHub release manually if wanted — CI does not
  build Android (needs NDK/SDK cache, out of scope for this pipeline).
