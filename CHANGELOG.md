# Changelog

All notable changes to OPEN MUSIC are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The first release, **v0.1.0**, was cut on 2026-09-30: signed MSI and NSIS
installers are attached to the GitHub release. **v0.3.0** is the first
mobile-capable tree; there is no v0.2.0 (the number was skipped, not lost).
Work landing after the latest tag sits in `Unreleased`.

---

## [Unreleased]

### Added · Jam upgrade (sub-project A of `docs/jam-upgrade.md`)
- **Unified invite link:** one canonical string
  `trancemusic://join?host=…&port=…&code=…` is now the invite the invite row,
  the Copy button and both QR surfaces all show — UI, clipboard and backend
  agree on a single artifact. `room_open`/`room_info` gain an additive
  `invite` field (`urls`/`code` unchanged).
- New **`room_join_uri {uri, name}`** command: Rust validates the pasted link
  (canonical *or* legacy `ws://ip:port · CODE`) before any mode change;
  `room_join {addr, code, name}` remains as a thin legacy wrapper. Both join
  sheets collapse to a single paste field.

### Changed · Jam upgrade (sub-project B spike of `docs/jam-upgrade.md`)
- **Android `CAMERA` permission** is injected by `app/build.sh
  inject_android_permissions` (CAMERA-aware idempotence — an INTERNET-only
  manifest now upgrades instead of early-returning; dispatcher is sourceable
  for standalone runs). Camera verified live in the Tauri WebView (stream +
  frames); `BarcodeDetector` proved non-functional there despite its API
  surface — scanner verdict + the vendored-decoder decision: **P38** in
  `docs/mobile/09-problems-solutions.md`.

### Changed · Brand → **OPEN MUSIC** (user-facing strings only)
- The platform now reads **OPEN MUSIC** on both surfaces (`TRANCE MUSIC` on
  desktop, `REON` on mobile): window/installer/launcher `productName`, both
  window titles, in-app wordmarks, About & Legal copy, widget, tray tooltip,
  file-picker filter, Linux desktop entry, OAuth success pages, share sheets and
  share-card badges, the diagnostics line and the updater release note. Full
  file+line inventory: `docs/branding/open-music-string-rename.md`.
- Deliberately **unchanged**: app id `com.openmusic.trancemusic`, the backup
  format id `trance-music-backup`, the vault folder `<data>/TRANCE MUSIC` and
  its legacy `Downloads/TRANCE MUSIC` source, the keyring service names, the
  `TRANCE-SHARE:` codec, the `TRANCE_MUSIC_*_CLIENT_ID` build env vars, the
  `trance-music` binary name and the Windows autostart registry value. Renaming
  any of those would reject existing backups, orphan saved logins or strand the
  user's offline library.
- CI moved with `productName`: `macos.yml` bundle paths (6 sites),
  `release.yml` artifact name and the smoke test's fallback install paths.
- Known residuals: the icon art still carries the old wordmark
  (`app/src/logo.png`, `app/src-tauri/icons/*`), the Authenticode publisher is
  still `CN=TRANCE MUSIC`, and the Android launcher label only refreshes when
  `gen/android` is re-inited.

### Social · Listen Together (desktop **and** mobile)
- Both surfaces now drive the in-app Rust room server — `room_open`, `room_join`,
  `room_chat`, `room_playback`, `room_report`, `room_close`, `room_info` — and
  reduce the `room://msg` frames through one shared reducer (`app/src/room.js`).
  Desktop lives in `app/src/social.js`, mobile in the new `app/src/mobile/jam.js`.
- **Host** broadcasts its playhead on play/pause/seek/track change and once a
  second; **guest** follows it, seeks only past ±0.4 s and reports the measured
  drift. A guest's transport is disabled with a stated reason — the host's
  playhead is the only source of truth.
- Removed the sidecar-era `#jam-ua` line and the retired metroserver controls
  from the Jam pane (`metroproto.js`/`sidecar.js` stay as a dormant interop
  path). Room codes, member counts and drift are only ever server values.
- Mobile Now Playing regenerated: the design export's mock room code, listener
  count, ping, telemetry grid and demo tracks/chat are gone, replaced by honest
  empty states and real slots; the legacy transport ids `binders.js` paints are
  restored.

### Removed
- **Desktop Now Playing transport card** (`.np-transport-card` in
  `app/src/index.html`, `docs/social-nowplaying.md §4–5`): the precision
  timeline, the `DEMOCRATIC SYNC CLOCK` label, the pause grace-period pill,
  the majority-vote skip button, and the inline volume block are deleted.
  Full playback and volume control now live only in the bottom mini-player
  (`#bar-*`). The skip-vote and grace surfaces left with the card; the Jam
  `#jam-vote-ratio` tile still paints the (now inert) tally. Desktop only —
  the mobile Now Playing screen is unchanged.

### Fixed
- **Mobile played tracks silently — playhead advanced, no sound** (P36):
  the v0.4.0 EQ chain routes the transport element through a
  `MediaElementAudioSourceNode`, but the relay's stream/file responses
  carried no `Access-Control-Allow-Origin`, so the cross-origin load was
  not CORS-clean and WebAudio output silence while the element kept
  "playing". The relay now reflects the validated app origin from the auth
  middleware (failures included), and the mobile transport elements load
  with `crossOrigin="anonymous"`. Verified with an in-graph output meter:
  max frequency bin 0 → 222 on the rebuilt release APK.
- **Windows `cargo test` harness** (`0xC0000139`, `rfd` → `TaskDialogIndirect`):
  `build.rs` now declares the comctl v6 manifest dependency on the link line.
  The room suite runs again — and immediately exposed a test that had been
  asserting against the wrong `presence` frame.
- Two latent clippy warnings in `room.rs`.
- **Opening a room could leave the host deaf to its own server.** The
  `room://msg` listener was attached only when the Social mode was entered,
  but `#btn-open-room` is wired independently — so a room could be live with
  nobody listening and the host UI stuck at `1 online`. The listener is now
  attached once at boot, and no longer latches itself off when `__TAURI__` is
  not yet present.
- **`room_info` hid the room's invite.** It returned `{role, port, code}`
  while `room_open` returned the `ws://` list, so a window re-attaching to an
  open room could not re-offer the address it was serving on. `room_info` now
  returns `urls` too.
- **Guest track resolution (D1) + role-gated crossfade/shortcuts**
  (`6f2f302`): a guest whose device lacks the host's track now falls back to
  the catalog (`resolve_song`) instead of stalling at `NOT ON THIS DEVICE`;
  crossfade is disabled while a room is live, and every transport shortcut
  checks the room role first — no guest-driven desync.
- **D5 — after the host ended the jam, the guest could never join another
  room** (`d1752ef`, `room.rs` `guest_pump`): the pump treated the server's
  `bye` like any frame and kept waiting, but after `room_close` the server
  only *drains* — so the pump never ended, the mode stayed `Mode::Guest`,
  and the next join was refused verbatim
  `Leave the current room before joining another.` while every surface read
  Solo (same toast as P32, different trigger). The pump now ends on a server
  `bye`, reverts the mode **before** the frame reaches the UI (D2's ordering
  rule), forwards the server's own reason (one toast, no synthetic second),
  and closes the socket so the host's drain completes. Covered by three
  duplex-socket unit tests (the bye case failed RED at a 2.01s timeout
  before the fix) plus the live LAN-rejoin and reverse-pair probes.

### Added
- **Standing two-device gate** — `docs/listen-together.md` §10 now lists the
  exact Task 6/7 commands with pass counts and known traps (P28 CLI skew,
  CDP env var, PowerShell pitfalls), including two new hand-run probes:
  `app/tests/live-lan-join.mjs` (real-LAN guest join with all adb tunnels
  removed + the D5 rejoin regression) and `app/tests/live-reverse-pair.mjs`
  (Android host ↔ desktop guest: chat both ways, playback follow, D4 pause
  broadcast, D5 desktop revert).
- **Apple field runbook** — `docs/jam-apple-field-runbook.md`: standalone
  macOS + iPhone steps with the iOS unknowns (ATS on the relay, Local Network
  permission, invite IP, backgrounding) as check-first items and a results
  table. iOS stays *build-verified only* until that table is filled.
- **Jam audit findings** — `docs/jam-audit-findings.md`: audit A
  (bind/invite derivation, listener reconnect, platform `cfg`), audit B
  (Android cleartext map, iOS/ATS unknowns), and the live-verification
  defect D5 with its TDD record.

### CI
- `ios.yml` runs `npm test` (frontend suites incl. the jam ones) before the
  iOS build. **Effect pending push** — workflow changes only take effect on
  GitHub, and nothing is pushed per repo rule 1.

### Verified live (this run, real apps — not stubs)
- **Desktop, 32/32**: `node app/tests/live-desktop.mjs` against a real
  `cargo build` window — room opened from the UI, address advertised, real
  second socket joined, chat echo 31 ms, `presence` → 2 members + `±0.25s`,
  guest `playback` refused, Leave → Solo.
- **Android emulator, 28/28**: `node app/tests/live-android-emulator.mjs` —
  debug APK on AVD `Pixel6_API36` running its own Rust server, chat echo 31 ms
  through the adb bridge, drift `±0.25s`, leave → Solo.
- Note for future runs: a `gen/android` debug APK produced by `tauri android
  dev` is a *dev client* bound to the dev-server URL — it renders a
  load-failure page on a device. Use `tauri android build --debug`.

---

## [0.4.0] - 2026-10-05

### Cross-Platform Support: MACOS, LINUX, WINDOWS, IOS & ANDROID
- Full production compilation, testing, and distribution pipelines across **MACOS**, **LINUX**, **WINDOWS**, and **IOS** (alongside Android).
- Comprehensive multi-platform matrix CI workflow verifying Rust cores, Node unit tests, lint checks, stylesheet builds, and iOS compilation.

### UI & UX Improvements
- **Elevated Now Playing Screen Lyrics**: Fixed light theme lyrics formatting with transparent background, clean typography, subtle border markers, and smooth karaoke sweep.
- **Master Audio Specs**: Removed Master Audio Specs deck panel from Now Playing screen for a cleaner, modern stage interface.
- **Search Screen Hover Effect Parity**: Unified subtle elevation, smooth hover translations, drop shadows, and thumbnail zoom across Playlist, Album, Library, and History screens.
- **Desktop Mini Widget Redesign**: Curved corners with acrylic obsidian glass styling, isolated transparent header, crisp contrast, and refined transport controls.
- **Mobile Experience Upgrade**: Modernized mobile header, notification toast anchors, settings tiles matching desktop aesthetics, and full-screen synchronized lyrics.

## [Unreleased]

### Fixed

- **Spotify sign-in now persists.** `keyring = "3"` was pulled in with no
  credential-store feature, so every build silently fell back to keyring's
  in-memory mock store — sign-in reported success and the token was never
  written anywhere, leaving the status stuck on "Not signed in" (and Drive sync
  broken the same way). Now enables `windows-native` / `apple-native` /
  `linux-native`, plus a regression test that saves via one `Entry` and reads
  back through a fresh one.
- **Spotify Settings panel** — the Sign in / Sign out / Choose CSV / Import
  controls interpolated the `setBtn` *function* into their `class` attribute,
  so its source text rendered on screen; CSV import also read `files[0]` on
  `click` (always empty) instead of on `change`.
- **Spotify top-tracks import** — the invoke sent `time_range`; Tauri 2 expects
  the camelCase key `timeRange`.
- **Mobile offline queue rows** — `isVaulted` was used but never imported, so
  the offline "not downloaded" path threw a `ReferenceError`.
- **Desktop search box double border** — global `input[type="text"]`
  `!important` rules painted a second box (black on focus) inside the search
  pill, which owns its own container. `#search-input` is now exempt in both
  themes; the pill's `focus-within` glow stays the focus indicator.
- **Search failure wall** — a dead backend used to dump every page/mirror URL
  into the error box. The backend now logs that detail server-side and
  returns one line; the UI shows a short classified sentence (offline vs
  down) with Retry, full text in diagnostics only.
- **Junk catalog rows on album pages** — `This is a sample trailer -
  testing` survived because the filter required a missing artist, but album
  listings inherit a real artist bill. Two or more junk words in the title
  now drop the row regardless of artist (both Rust `is_junk` and the
  `isJunkTrack` mirror); single-word titles still need a missing artist.
- **Desktop widget shape + transport** — card radius 26 → 32 px, side buttons
  32 → 28 px, volume slider shortened, both transport sides centred: play is
  pixel-centred with clear air to prev/next instead of crowding Next.

### Added

- **Mobile parity with desktop** — fuzzy/typo-tolerant search ranking
  (`mobile/rank.js`, same `fuzzy.js` score the desktop uses), a "did you mean"
  toast action off `search_suggestions`, a `↕` sort chip cycling
  quality/popular/length/A–Z, a `Verify` button for the vault on the Downloads
  screen (re-hash report), a `Settings → Diagnostics` sheet fed by a 40-entry
  ring buffer (`net.js` had been logging into a no-op), and catalog-plays /
  lyrics / explicit rows on the track details sheet.
- **Sleep timer** — `app/src/sleep.js`, shared by both shells: 15/30/60/90 min
  with a 15 s volume ramp before the pause. Desktop keeps the Now Playing
  select; mobile cycles presets from a new `bedtime` button.
- **Mobile mini-player upgrades** (`mobile/app.js`) — shuffle toggle,
  vault ⬇ badge, buffered-progress fill, offline/error/resolving states on
  the artist line, 40–44 px touch targets, and swipe gestures (left/right =
  next/prev, up = open NowPlaying).
- **Mobile library without native dialogs** (`mobile/menus.js`,
  `mobile/binders.js`) — playlist create/rename/delete moved into the shared
  bottom-sheet (`openInputSheet`/`createPlaylistSheet`/`deleteLocalPlaylist`;
  `prompt()`/`confirm()` never open in an Android WebView) and library removal
  matches by `id` instead of title.
- **Mobile downloads that report honestly** (`mobile/shared.js`,
  `mobile/binders.js`) — the In-Transit section renders live progress with
  per-track cancel (best-effort: the file landing after a cancel is deleted),
  Pause/Resume for batches, a persisted Wi-Fi-only gate, and wired filter
  (All / HQ 320 / Standard), sort (Recent / Name / Size) and search controls.
- **SQLite app store** (`store.rs` → `store.db`, 14 `store_*` commands) —
  `songs` metadata cache with play/fav counters, small `kv` prefs, and a
  6 h / 200-row `search_cache`. Both shells mirror plays, favs and search
  pages into it via `src/store_db.js`; localStorage remains the fallback, so
  a missing store degrades instead of breaking. Audio bytes are never stored
  in SQLite — only track JSON.
- **Download pause / resume (desktop)** — new `pause_download` command keeps
  the `.part` prefix; the next `download_song` for the id continues it with
  an HTTP `Range` request (clean restart when the server ignores ranges,
  one retry on 416). Per-row pause/resume on the Downloads in-transit cards,
  Pause-all / Resume-remainder controls in the section header; batch Stop
  keeps its discard semantics. Non-breaking additive command — no
  `api_version` bump.
- **Smart playlists (desktop)** — two auto-generated cards beside Liked
  Songs: `Top 50 · Last 30 Days` (play counts in window, newest breaks ties)
  and `Favourited, Not Downloaded` (hearts minus vault ids). Pure rules in
  `app/src/smart.js` with unit tests; cards recompute on every Playlists
  visit and open inline like the other synthetic lists.

---

## [0.3.0]

First mobile-capable release (tag `v0.3.0`). Desktop installers plus an
Android shell and an iOS workflow.

### Added

**Android & iOS**

- **Mobile shell** — `app/src/mobile/`: a hash-router app with 13 screens
  (home, search, library, liked-songs, album, artist, playlist, nowplaying,
  download, history, notification, analytics, settings), its own `<audio>`
  player, `navigator.mediaSession` lock-screen transport, karaoke lyrics, and a
  persistent widget-style mini player. See
  [`docs/mobile/README.md`](docs/mobile/README.md).
- **Config overlays** — `tauri.android.conf.json` + `tauri.ios.conf.json`
  carry only what differs from the base config; desktop plugins are confined to
  `cfg(not(android/ios))` so the mobile targets link.
- **iOS CI** (`.github/workflows/ios.yml`) — signed `.ipa` or unsigned simulator
  `.app`, with the build log posted to an issue on failure.
- Mobile-accurate stubs: `open_external`, `autostart_set`,
  `open_bluetooth_settings` and the Drive commands return an explicit
  `Err("…not supported on Android yet")` rather than failing oddly.
- Android builds link `reqwest` with `rustls-tls` (no system OpenSSL to link
  against).

**Vault, cache & sync**

- **Vault relocated** to the app's own data folder
  (`%LOCALAPPDATA%` / `~/.local/share` / `~/Library/Application Support` →
  `TRANCE MUSIC`); a legacy `Downloads/TRANCE MUSIC` vault is migrated once on
  first launch (`lib.rs::migrate_vault`).
- **SQLite download ledger** — `downloads.db` replaces the JSON manifest;
  concurrent downloads serialise their writes so no row is lost. SHA-256 is
  recorded per track (`sha256.rs`).
- **Cache tree** in the app cache dir, with `cache_stats` / `cache_set_budget`
  (100 MB – 5 GB) / `cache_clear`. Clearing cache never touches the vault.
- **moka caches** for resolved songs, range probes, search and lyrics — bounded
  capacity with TTL, replacing unbounded `HashMap`s.
- **Backup / CSV / M3U export**, import manifest, and Google Drive sync
  scaffolding (`gdrive.rs`).
- `promote_song` — re-download a vault track at a higher quality.

**Desktop**

- **Caps Lock Hyper shortcuts** with `Ctrl+Alt` fallbacks, detected at startup
  (`shortcuts.rs`, `docs/shortcuts.md`).
- **System tray** with Play/Pause/Next/Previous and a settings entry.
- **Widget pin**, click-through toggle, and drag repositioning.
- **Fuzzy search** (`fuzzy.js`) and filters merged into the sort menu.
- **Network status** — online / degraded / offline state machine with a
  reachability probe (`net_ping`).

**Quality**

- **CI** (`.github/workflows/ci.yml`): `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `OP_OFFLINE=1 cargo test`,
  `cargo audit`, ESLint and the 58 frontend tests.
- **Release pipeline** — installers upload, the updater manifest URLs are
  verified after upload (GitHub stores asset names with spaces as dots), then
  the release publishes.
- Front-end **module split**: `main.js` is now a 159-line entry point importing
  28 feature modules.
- **CSP hardening**: `default-src 'self'`, `frame-src 'none'`,
  `object-src 'none'`; script hashes for the two inline boot scripts only.

### Fixed

- Metadata `NULL` handling in the catalog parser (shared core — mobile inherits).
- iOS target compile: dialog commands gated to `#[cfg(desktop)]`; the workflow
  uses the official `--no-sign --target aarch64-apple-ios-sim` flags instead of
  pbxproj hacks.
- Updater manifest URLs broken by GitHub rewriting asset names (spaces → dots).
- Review-driven hardening across parsing, path containment and error paths
  (see [`review.md`](review.md)).

---

## [0.1.0] - 2026-09-30

First packaged release. `npm run tauri build` emits an MSI and an NSIS
installer, both Authenticode-signed (self-signed `CN=TRANCE MUSIC`
certificate, SHA-256, RFC 3161 timestamped).

### Added

**Windows installers, code-signed**

- `bundle.targets` is `["msi", "nsis"]`; the build produces
  `TRANCE MUSIC_0.1.0_x64_en-US.msi` (2.98 MB) and
  `TRANCE MUSIC_0.1.0_x64-setup.exe` (2.05 MB) under
  `src-tauri/target/release/bundle/`.
- `bundle.windows` in `tauri.conf.json` carries `certificateThumbprint`,
  `digestAlgorithm: "sha256"` and a DigiCert RFC 3161 `timestampUrl`, so the
  exe, the WiX/NSIS payload DLLs and both installers are signed during the
  build itself.
- The certificate is self-signed and lives in the local user's `My` store:
  installs work, but other machines show an unknown-publisher / SmartScreen
  prompt. Reputation arrives only with a CA-issued code-signing certificate.
- Release profile was already fully optimised (`lto = true`,
  `codegen-units = 1`, `opt-level = 3`, `strip = true`, `panic = "abort"`);
  a cold release build takes about five minutes.

**Settings — General tab**

- Profile name: greets the Home heading by name (`#home-name`), persisted in
  `localStorage` (`tm-name`).
- Open at startup: `autostart_set` writes or deletes the HKCU `Run` value with
  `reg` directly — no elevation, no scheduled task, no plugin.
- Language + region: `content_prefs_set` pushes the choices to Rust once at
  boot; `official.rs` appends `lang`/`country` to every catalog call.
  `filterLang()` then filters search, load-more and Home rankings to that
  language, falling back to the unfiltered list when the source has no hits —
  so a Telugu preference cannot blank an English query.

**Endless playback (radio) — backend only, not yet reachable from the UI**

- `recommend_songs` Tauri command (`app/src-tauri/src/lib.rs`).
- `official.rs`: `RadioPage` DTO, `create_station` (`webradio.createEntityStation`)
  and `station_songs` (`webradio.getSong`) with a 10-song batch.
- `parse_song` now falls back to `more_info` for the artist credit, because
  radio batches carry it only there.
- `call()` now tolerates a bare-string `error` body, which the radio endpoint
  returns (`"No new song found for current radio."`).

> **Not wired up.** Nothing in `main.js` invokes `recommend_songs` yet, so this
> code is unreachable from the running app. It is landed and tested so the
> feature can be switched on without touching the backend again. It is also the
> only part of the working tree not written this cycle — do not commit it blind.

**Settings dialog**

- `openSettings()` in `main.js`: a native `<dialog>` with exactly three
  entries — Open-Source Licences, About the Project, Terms & Conditions. The
  body swaps between the menu and one section, so no nested dialog is needed.
- Licence data is read off `Cargo.lock` and the registry manifests, not
  invented: 10 direct Rust deps with versions and SPDX ids, plus
  `@tauri-apps/cli` as dev-only. The full 469-crate tree is named in the copy
  and left in the lock file.
- Terms: 7 clauses, with a non-affiliation disclaimer and a
  "not legal advice" footer. **Drafted by the assistant, not reviewed by a
  lawyer** — get clauses 1, 2 and 4 checked before publishing.
- The back button swaps its whole `class` string. Toggling `hidden` against
  `flex` does not work: Tailwind emits `.hidden` after `.flex`, so the element
  would stay hidden. Same trap that broke the nav tabs.

**Desktop widget**

- New floating player surface built from `design/screens/widget design`: the
  obsidian glass card (32px radius, hairline border, 28px backdrop blur,
  blurred cover art behind the panel, 7-bar CSS spectrum, up-next card,
  telemetry footer). Toggled from a `widgets` button in the header, anchored
  above the miniplayer, closes on Escape.
- **It is a view, not a second player.** Every control calls the existing
  handler (`togglePlay`, `step`, `toggleShuffle`, `seekFromEvent`,
  `volFromEvent`, `playQueueItem`) and every widget painter is *called from* the
  existing bar/now-playing painters, so the three surfaces cannot disagree.
  The paint hooks added are in `timeupdate`, the audio event loop,
  `playQueueItem`, `setBadge`, `renderQueue` and `paintVolume`.
- Seek and volume take real pointer-capture drags plus arrow/Home/End keys, and
  expose `role="slider"` with live `aria-valuenow`.
- Palette lives in `styles.css`, not as utility classes — the app's Tailwind
  config has no `zinc` scale and `index.html`'s config is one minified line.
  Visibility uses `.is-open` for the same `hidden`/`flex` reason as above.

**Notifications**

- Toasts restyled into the widget's card language: same obsidian glass, hairline
  and glow, 16px radius, glowing status dots, tabular figures. A notification
  and the widget now read as one system.
- The stack lifts clear of the widget while it is open. The offset is applied
  when the stack is *created*, not only when the widget toggles — otherwise
  the first toast of a session would land under an already-open widget.

**Track credits dialog**

- `openCredits()` in `main.js` replaces the native `alert()` behind the info
  icon. Built on a native `<dialog>` (so focus trap, Esc and the inert
  background come from the platform) and styled with the app's own tokens.
- `#tm-dialog` rules in `styles.css` for the scrim — `::backdrop` cannot be
  expressed as a utility class.
- Clicking the backdrop closes it.

**Navigation from the miniplayer**

- Clicking the miniplayer's cover, title or artist opens Now Playing, via the
  existing `data-path-jump` delegate. No new JS was needed.

### Fixed

- **Tab switches resumed at the previous view's scroll position.** WebView2
  restores scroll on a session resume (`history.scrollRestoration`) and
  swapping views changes the document height, so the first `scrollTo({top: 0})`
  could be clamped away by the old layout. `scrollRestoration` is now
  `"manual"` before first paint (set in `index.html`), and `toTop()` scrolls
  again on the next animation frame, once layout has settled.
- **Active nav tab rendered dark-on-dark.** Inactive tabs carry
  `text-on-surface-variant`, which Tailwind emits *after* `text-on-primary`, so
  the white text added by JS lost the cascade and every tab except Home
  (whose markup has no competing class) showed black text on a black pill.
  `showView()` now removes the inactive classes instead of only adding the
  active ones. Also stops the active pill turning dark on hover.
- **Playlist clicks no longer hijack the Playlists tab.** Opening a playlist
  from Home (carousel, hero banner) or Library (saved playlists) switched the
  whole app to the Playlists screen. These now open on the shared `detail`
  view, and `Back` returns to where you were.
- **Library playlist cards printed `[object Object]`.** `plCard` joined an array
  of objects instead of their names.
- **"Full 100 Charts" played one chart instead of listing them.** The handler
  called `playList(chart_id)`; it now opens the Playlists tab with the Charts
  filter selected. The home chart row was also hard-sliced to 3 entries.
- **Two "view all" links were dead.** `View All Releases` and `All 64 Artists`
  were `<a href="#">` with no handler. Both now list the full feed via the
  search grid (`browseCards`).
- **"Full Playback History" did nothing.** No handler at all; now jumps to the
  History view.
- Home playlist cards are clickable across their whole surface, not just the
  small hover play button.
- The hero banner is now clickable and keyboard-operable; its own buttons keep
  their own behaviour.

### Changed

- **Artwork is uniformly 96px in every list row.** Search, History, Downloads,
  Library favourites and the Home chart were all inconsistent (36 / 40 / 56 /
  64px). Row padding moved from `py-2.5`/`p-3` to `p-4` to match.
- Album/artist detail hero image: 160px → 256px.
- Lyrics panel header rebuilt: wordy `SYNCHRONIZED SCORE & SCRIPT` and the
  `LIVE` chip replaced by an icon + "Lyrics" + a theme-token `Live` dot, with
  three uniform 32px controls. `whitespace-nowrap` stops the labels wrapping
  onto two lines.

### Removed

Decorative copy and controls that asserted things the app does not measure:

- `CoreAudio Bit-Perfect` pill from the top nav bar.
- The Now Playing DAC strip: `ACTIVE DAC SESSION`, `SRC: … [Bit-Perfect]`,
  `JITTER < 0.05 ps`, and the Flat EQ / XFADE / Share buttons. (`XFADE` and
  Flat EQ had no logic behind them; the crossfade label was cosmetic.)
- The `SPECTRAL FLUID VELOCITY` panel and its `+14.2 LUFS PEAK` meter.
- `Bit-Perfect Buffer 1.2ms • 32 Master Streams Today` from the Home greeting.
- The Search screen's `Lossless Index • 82,410 Studio Captures` badge and the
  `QUICK QUERY ⌘K` hint. **The ⌘K/Ctrl+K shortcut still works** — only the
  visual hint was removed.

### Housekeeping

- Repository restructured: product docs to `docs/`, Stitch exports to
  `design/screens/` and `design/reference/`, binary downloads to `archives/`
  (git-ignored).
- Added `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`,
  `.editorconfig`; rewrote `.gitignore` for the new layout and to exclude
  agent/editor config and OS cruft.
- Doc references in `jiosaavn.rs` and `lib.rs` updated to `docs/architecture.md`.

---

## Known gaps

Not fixed, listed so they are not mistaken for oversights:

- **No front-end tests.** `main.js` is ~3,900 lines of imperative DOM wiring and
  `package.json` has no test runner. All UI changes above were verified by
  running the app. Adding a runner is the highest-value next step.
- **`recommend_songs` is unreachable** from the UI (see above).
- **Volume is app-local.** The miniplayer and Now Playing sliders set
  `audio.volume`, which does not move the Windows system volume. Replacing this
  with `IAudioEndpointVolume` is designed but not implemented — `windows` 0.62
  is already in the lockfile, so it needs only Cargo features.
- Tailwind and the icon font are fetched from a CDN at runtime.
- Sections of the UI remain Stitch placeholders (telemetry figures, "master
  stream" copy) rather than live data.
