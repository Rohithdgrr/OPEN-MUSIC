# Release v0.5.1 — visible rename to OpenMusic (no other changes)

Follow-up to `docs/release-v050.md`. v0.5.0 is published and its updater
manifest is live, so the rename ships as a new patch version, not a
re-tag: same code as v0.5.0 (`75bc7ec`) plus display-string renames.

## Scope: display strings only

`OPEN MUSIC` → `OpenMusic` everywhere a user can see it:

- `tauri.conf.json`: `productName` + both window titles (installer names,
  taskbar, window chrome). Android already shows `OpenMusic` (the
  `inject_android_label` strings rewrite), so this aligns desktop with it.
- Config overlays `tauri.android.conf.json` / `tauri.ios.conf.json` titles.
- HTML titles + header wordmark + miniplayer default + widget brand.
- About/Legal `APP.name`, terms copy, vault label, backup picker label.
- Share badges + share text, MediaSession default, welcome + diag lines.
- Tray tooltip, Linux desktop-entry `Name`, backup picker label (Rust).
- OAuth success pages ("Signed in to …").
- Updater release-note default (`make-update-json.mjs`).
- Smoke-test win32 fallback path (`C:\Program Files\OpenMusic\…`) — the
  glob itself is productName-agnostic; only the fallback and comments.

## Explicitly untouched (update/data continuity)

`identifier com.openmusic.trancemusic`, binary/crate name `trance-music`,
keyring services (`TRANCE MUSIC`), autostart registry value, vault paths +
legacy migration, backup format id, `[OPEN MUSIC]` log prefixes, icon art,
Android `keyAlias`, CI globs (extension-based, productName-agnostic).

## Steps

Version 0.5.0 → 0.5.1 in `tauri.conf.json` + `Cargo.toml` + `package.json`;
gates (`npm test`, eslint, fmt, clippy, `cargo test --lib`); local
MSI+NSIS rebuild with the minisign key; commit → push → tag `v0.5.1` →
push tag → CI builds Windows/Linux and publishes (same pipeline as v0.5.0).
