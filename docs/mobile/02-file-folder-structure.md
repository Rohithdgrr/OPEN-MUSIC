# 02 — Mobile File & Folder Structure

```
OPEN MUSIC/
├── app/
│   ├── src/                        # frontendDist for desktop = ../src
│   │   ├── index.html / main.js …  # DESKTOP shell (do not import from mobile)
│   │   ├── tailwind.css            # prebuilt utilities (generated, commit it)
│   │   └── mobile/                 # MOBILE shell (frontendDist overlay points here)
│   │       ├── index.html          # mobile entry: #screen + <audio> + router + app.js
│   │       ├── router.js           # hash router, bottom-nav injection, __tmBack
│   │       ├── app.js              # boot, global click delegation, mini-player paint
│   │       ├── shared.js           # invoke/Channel, storage keys, art ladder, toasts
│   │       ├── player.js           # single <audio>: queue, resolve, mediaSession
│   │       ├── binders.js          # MOUNT table: screen dir -> mount fn
│   │       ├── menus.js            # kebab / three-dot menus
│   │       ├── radio.js            # endless playback feed (recommend_songs)
│   │       ├── lyrics.js           # synced-LRC paint
│   │       ├── legal.js            # licences / terms content
│   │       ├── logo.png
│   │       ├── tailwind-config.js  # mobile theme tokens (loaded via <script>)
│   │       └── screens/            # one dir per route: <name>.html + <name>.js
│   │           ├── home.*  search.*  main-library.*  liked-songs.*
│   │           ├── album.*  artist.*  playlist.*  nowplaying.*
│   │           ├── download.*  history.*  notification.*  analytics.*  settings.*
│   ├── src-tauri/
│   │   ├── Cargo.toml              # deps + per-target splits (android/rustls, desktop plugins)
│   │   ├── tauri.conf.json         # DESKTOP: windows, CSP, updater, bundle
│   │   ├── tauri.android.conf.json # ANDROID overlay: url=mobile/index.html, fullscreen
│   │   ├── tauri.ios.conf.json     # iOS overlay: same, fullscreen
│   │   ├── capabilities/
│   │   │   ├── default.json        # windows ["main","widget"], core:default
│   │   │   └── widget.json         # widget window extras (desktop only)
│   │   ├── icons/
│   │   ├── src/
│   │   │   ├── lib.rs              # IPC surface + lifecycle; cfg(desktop)/cfg(mobile) splits
│   │   │   ├── official.rs         # JioSaavn first-party adapter (primary catalog)
│   │   │   ├── jiosaavn.rs         # community mirrors (fallback) + parsing
│   │   │   ├── proxy.rs            # axum range relay on 127.0.0.1 + vault
│   │   │   ├── lyrics.rs           # LRCLIB → JioSaavn → LRCLIB search
│   │   │   ├── cache.rs / db.rs / gdrive.rs / transcode.rs / sha256.rs
│   │   │   ├── sysvol.rs           # parked (system volume, desktop)
│   │   │   ├── shortcuts.rs        # desktop impl; mobile stub lives in lib.rs
│   │   │   ├── update.rs           # desktop updater (cfg(desktop))
│   │   │   └── widget.rs           # desktop card (mobile: commands exist, window absent)
│   │   └── gen/
│   │       ├── android/            # GENERATED Gradle project (tauri android init). Don't hand-edit.
│   │       └── apple/              # GENERATED on macOS (tauri ios init --ci). Git-ignored output.
│   ├── scripts/make-update-json.mjs# builds latest.json/update.json for desktop updater
│   ├── tailwind.config.cjs / tailwind.input.css
│   ├── build-windows.ps1 / build.sh
│   └── tests/                      # frontend pure-logic tests (node --test)
├── docs/
│   ├── architecture.md / PRD.md / ui.md / wireframes.md / …  # desktop + product docs
│   └── mobile/                     # THIS folder — mobile-only docs
├── .github/workflows/
│   ├── ci.yml                      # fmt + clippy + offline tests + eslint + node --check
│   ├── ios.yml                     # macOS-only .ipa / simulator build + artifact upload
│   └── release.yml                 # desktop tag release (msi/nsis, deb/appimage, app/dmg)
└── design/  archives/  CHANGELOG.md  …
```

## Ownership rules

- Only `proxy.rs` knows about the HTTP server; only `official.rs`/`jiosaavn.rs`
  know about catalog endpoints (each file states this in its module docs).
- Desktop shell (`app/src/*.js`) and mobile shell (`app/src/mobile/*.js`) are
  **separate**: mobile reuses `app/src/html.js` (`esc`) but otherwise duplicates
  what it needs. Do not cross-import desktop modules into mobile.
- `tauri.android.conf.json` / `tauri.ios.conf.json` are **overlays** passed with
  `--config`; the base `tauri.conf.json` stays desktop. Keep `productName`,
  `identifier`, `version` in sync across all three.
- `gen/android` is generated code. Fix mobile build issues in `Cargo.toml`
  target splits, `lib.rs` `cfg()` gates, or the overlay configs — never by
  patching `gen/`.
