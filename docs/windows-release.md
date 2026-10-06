# Windows release build (signed, optimized, lightweight)

Windows-only release path: one NSIS `*-setup.exe`, Authenticode-signed with
the local `CN=TRANCE MUSIC` cert and updater-signed with the minisign keypair,
built on the size-optimized release profile with minified CSS.

## The two signatures (different things)

1. **Authenticode** (publisher identity on the installer): wired in
   `app/src-tauri/tauri.conf.json` → `bundle.windows.certificateThumbprint`
   (`378383F5680237760FB1A7DDF6EE09EC31554758`, `CN=TRANCE MUSIC`,
   private key present in `Cert:\CurrentUser\My`, expiry 2031-09-30).
   Self-signed cert: installs and runs fine, but SmartScreen on *other*
   machines still warns — silencing that needs a paid OV/EV code-signing
   cert. Nothing to configure; the thumbprint is already in the config.
2. **Updater** (in-app auto-update): `TAURI_SIGNING_PRIVATE_KEY` env must
   hold the contents of `~/.tauri/open-music.pem` at build time. The pubkey
   in `tauri.conf.json` matches `~/.tauri/open-music.pem.pub` (verified
   identical 2026-10-07). Produces `*.nsis.zip` + `*.nsis.zip.sig`, which
   `app/scripts/make-update-json.mjs` assembles into `latest.json`.

## Lightweight choices

- `--bundles nsis` only: one `*-setup.exe`, no MSI (skips the WiX/VBSCRIPT
  dependency entirely).
- `[profile.release]`: `opt-level = "s"` (size over speed; was `3`),
  `lto = true`, `codegen-units = 1`, `strip = true`.
- `npm run css` (minified Tailwind) always runs before the build —
  `dist:windows` chains it.

## Command (from repo root, PowerShell)

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE/.tauri/open-music.pem -Raw
npm run dist:windows
```

`dist:windows` = `npm run css && tauri build --bundles nsis` (see
`app/package.json`). Output lands in
`app/src-tauri/target/release/bundle/nsis/`.

## Verify

- `*-setup.exe` exists; record its size in the build report.
- `(Get-AuthenticodeSignature *-setup.exe).SignerCertificate.Subject`
  is `CN=TRANCE MUSIC` (signing worked). `.Status` reads `UnknownError`
  on any machine that does not trust the self-signed root — expected, not
  a build failure; trust is a client-side store matter, not a signature
  defect. (A paid OV/EV cert chains to a public root and reads `Valid`.)
- `*.nsis.zip` + `*.nsis.zip.sig` present (updater artifacts).
- Install once and launch: home screen, search → play streams.

## CI note

`.github/workflows/release.yml` nulls `certificateThumbprint` (no Windows
cert on the runner), so CI installers are updater-signed only, never
Authenticode-signed. Authenticode signing happens on this machine only.
