# OPEN MUSIC — user-facing string rename (2026-10-08)

Scope: **presentation layer only.** The platform is now **OPEN MUSIC** on both
surfaces (it was `TRANCE MUSIC` on desktop and `REON` on mobile). Only strings a
user actually reads change; identifiers, data paths, wire formats and build
config keep their old values on purpose.

`app/src/mobile/screens/home.html:9` already read `OPEN MUSIC` — this doc covers
everything that was left.

## What changes

| Tier | Surfaces | Files |
|---|---|---|
| A · desktop in-app | `<title>`, header wordmark, widget, player-bar fallback, About/Legal, diagnostics line, console prefix, OS media-flyout fallback, share dialog, sync error text | `app/src/index.html` (1, 34, 1769) · `app/src/widget.html` (6, 60) · `app/src/settings.js` (40, 822, 873, 886–888, 1090) · `app/src/main.js` (49) · `app/src/media.js` (71) · `app/src/transport.js` (250) · `app/src/sync.js` (176) · `app/src/core.js` (9, 23) · `app/src/styles.css` (2, 4133 comments) |
| B · mobile in-app | `<title>`, About/Legal, notification greeting, share-card badge, share sheet, share title, curation labels | `app/src/mobile/index.html` (7) · `mobile/legal.js` (8, 99, 111–114) · `mobile/app.js` (620) · `mobile/menus.js` (512, 601, 691, 752) · `mobile/collab.js` (50) · `mobile/binders.js` (4461) · `mobile/screens/album.html` (27) · `mobile/screens/artist.html` (136, 154) · `mobile/screens/settings.html` (About subtitle + "ACOUSTIC ENGINE" footer) |
| C · shell | `productName`, both window titles, Android/iOS titles, file-picker filter, Linux `.desktop` Name, tray tooltip, OAuth success pages, stderr log prefixes, crate description | `tauri.conf.json` (3, 13, 25) · `tauri.android.conf.json` (7) · `tauri.ios.conf.json` (7) · `src/lib.rs` (1, 784, 883, 905, 940, 1154, 1463, 1503, 1775) · `src/gdrive.rs` (225) · `src/spotify.rs` (248) · `src/jiosaavn.rs` (679) · `Cargo.toml` (4) |
| D · CI coupled to `productName` | macOS bundle path (6 sites), release artifact name, smoke-test fallback paths | `.github/workflows/macos.yml` (126, 153, 155, 181, 216, 231–239) · `.github/workflows/release.yml` (101) · `tests/smoke-test.mjs` (39–40, 69, 72, 75, 79) |
| E · public site | page title/meta, brand, hero, download panels | `index.html` root (6, 7, 9, 507, 511, 543, 566, 695, 774, 827, 964–1001, 1084) · `README.md` (5, 7, 30, 34) · `CONTRIBUTING.md` (1) · `app/scripts/make-update-json.mjs` (137) |

**D-site paths are deliberately left alone:** `%LOCALAPPDATA%\TRANCE MUSIC`,
`~/.local/share/TRANCE MUSIC`, `~/Library/Application Support/TRANCE MUSIC`,
`Downloads/TRANCE MUSIC` and the `README.md`/`index.html` lines that quote them
are real on-disk folders, not branding. Same for `CHANGELOG` history.

## What must NOT change

- `tauri.conf.json:5` `com.openmusic.trancemusic` — app id, Android package,
  launch-agent label, every test `PKG` constant.
- `sync.js:11` `BACKUP_APP = "trance-music-backup"` (+ `vault.js:746/758`,
  `app/tests/sync.test.mjs`) — renaming it rejects users' existing backups.
- The vault directory (`lib.rs:1616/1618` `.join("TRANCE MUSIC")`) and the
  legacy `<Downloads>/TRANCE MUSIC` migration source.
- `gdrive.rs:31` / `spotify.rs:27` `KEYRING_SERVICE` — renaming orphans saved
  Google/Spotify logins.
- `sharecode.js` `TRANCE-SHARE:` prefix — playlist-share wire format.
- `TRANCE_MUSIC_GOOGLE_CLIENT_ID` / `TRANCE_MUSIC_SPOTIFY_CLIENT_ID` env names.
- Cargo `[[bin]]` name `trance-music` — `macos.yml:192` and the smoke test look
  for `Contents/MacOS/trance-music`.
- `lib.rs:1423` `const NAME` (Windows autostart registry value) — renaming it
  strands an existing `Run` entry for current users.
- Genre/album text containing "Trance" (`Progressive & Trance`,
  `Nocturne Trance Sessions`) — catalog content, not the platform name.
- `design/`, `docs/` history, `temporary/`.
- `scripts/rebrand-to-trance-music.sh` — a bulk find/replace, the opposite of
  this change. **Do not run it.**

## Vault-path corrections shipped alongside

The "Offline vault" panel on the site (`index.html`, `dlVault`) and two README
passages claimed the vault lives in `%LOCALAPPDATA%\TRANCE MUSIC`,
`~/.local/share/TRANCE MUSIC` and `~/Library/Application Support/TRANCE MUSIC`.
That is not where it lives: Tauri's data dir is **identifier**-based, and
`lib.rs` appends the `TRANCE MUSIC` folder to it. Verified on this machine —
`%LOCALAPPDATA%\com.openmusic.trancemusic\TRANCE MUSIC` is the directory that
holds the downloaded `.m4a` files, while `%LOCALAPPDATA%\TRANCE MUSIC` is the
NSIS **install** folder (`trance-music.exe`, `uninstall.exe`).

Both surfaces now publish the real vault path (the `TRANCE MUSIC` leaf folder is
the one thing in that string that genuinely keeps the old name). The legacy
`Downloads/TRANCE MUSIC` migration source is unchanged and still quoted.

## Known residuals (accepted)

1. **Icon art keeps the old wordmark** — `app/src/logo.png` and
   `app/src-tauri/icons/*` still render "TRANCE MUSIC", so the taskbar /
   Start-menu / DMG / APK launcher icon and the in-app fallback artwork lag the
   strings until the art is regenerated from `design/screens/logo/code.html`.
2. **Signing cert subject is `CN=TRANCE MUSIC`** (thumbprint pinned at
   `tauri.conf.json:51`), so Windows file Properties still names that publisher.
   Changing it needs a new certificate, not a code edit.
3. **Android launcher label** comes from `gen/android/.../values/strings.xml`,
   generated from `productName` at `tauri android init` time. `gen/` is
   gitignored and absent from a fresh clone; on a machine where it exists, edit
   `app_name` there by hand or re-init.

## Gates for this change

`npm test` · `npm run lint` · `cargo fmt --check` ·
`cargo clippy --all-targets -- -D warnings` · `OP_OFFLINE=1 cargo test --lib` ·
a headless-Chrome boot check of both shells (a broken `index.html` edit is
invisible to lint).

`macos.yml` and `tauri.conf.json` `productName` move in the **same** commit — a
workflow that still looks for `TRANCE MUSIC.app` fails the moment the bundle is
renamed.

## Gate record — 2026-10-08

| Gate | Result |
|---|---|
| `npm test` | **250 pass / 0 fail** |
| `npm run lint` | clean (exit 0) |
| `node --check` on every edited `.js` | clean |
| `app/tests/mobile-boot.test.mjs` | **3/3** — the mobile module graph still boots over the edited markup (the `#audio2` lesson) |
| JSON parse of the three `tauri*.conf.json` | clean |
| `cargo fmt --check` | clean |
| `OP_OFFLINE=1 cargo test --lib` | **185 pass / 0 fail** |
| `cargo clippy --lib -- -D warnings` | **clean (exit 0)** |
| `cargo clippy --all-targets -- -D warnings` | 3 errors, **all in another session's uncommitted `room.rs` tests** (1465/1528/1579, `unused_mut`) — none in a file this rename touches |

`tests/smoke-test.mjs` keeps the `trance-music` **binary** name (line 66/107) on
purpose: `Cargo.toml`'s `[[bin]]` name did not change, only `productName`.
