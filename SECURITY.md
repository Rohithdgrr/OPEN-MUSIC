# Security

## Surfaces

- **CSP** (`app/src-tauri/tauri.conf.json`): `default-src 'self'`,
  `frame-src 'none'`, `object-src 'none'`; script hashes only for the two
  inline boot scripts; `connect-src` limited to `ipc:` and `127.0.0.1`.
- **IPC**: only the app's own windows (`main`, `widget`) exist, granted
  `core:default`. The Tauri Isolation Pattern is not used — single origin,
  strict CSP; enable it if a remote/untrusted origin is ever added.
- **withGlobalTauri** is required: the desktop widget and the main window
  communicate through `window.__TAURI__` events (`bridge.js`, `widget.js`).

## Known inherited limitations

- **DES-ECB for media URLs.** JioSaavn ships `encrypted_media_url` encrypted
  with DES-ECB; the client must decrypt it exactly as issued. ECB is weak by
  design — this is the upstream API's format, used only to recover a media
  URL, never for any application-level secret. Do not reuse DES for anything
  else in this codebase.
- **Code-signing certificate thumbprint** is pinned in
  `tauri.conf.json` (`bundle.windows.signingCertificate`). A thumbprint is a
  public identifier, not a secret. Rotation: when the signing certificate is
  renewed, replace the thumbprint string with the new cert's SHA-1 thumbprint
  (`Get-FileHash` on the cert, or certmgr.msc → Properties → Details).

## Reporting

Open a GitHub issue at <https://github.com/Rohithdgrr/OPEN-MUSIC/issues>.
