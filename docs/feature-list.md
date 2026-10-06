# Feature List — TRANCE MUSIC

Feature-by-feature comparison of the **desktop** and **mobile** surfaces.

| | |
|---|---|
| Version | `0.4.0` (`app/package.json:4`, `Cargo.toml:3`, `tauri.conf.json:4`) |
| Desktop shell | `app/src/index.html` — 8 views + Settings dialog + widget window |
| Mobile shell | `app/src/mobile/index.html` — 13 screens, hash router + bottom nav |
| Rust core | shared by both (`app/src-tauri/src/*.rs`, 20 files, 3 mods disabled) |
| IPC surface | **82** commands registered on desktop / **78** on mobile (`lib.rs:1647-1742`); **4** are `#[cfg(desktop)]` only (`export_file`, `read_import_file`, `update_install`, `update_rollback`) |
| IPC contract | `api_version() -> u32` (`lib.rs:555`) |
| Port backlog | Desktop features not yet on Android, prioritized → [§10](#10-desktop--mobile-port-backlog-android-improvement) |

**Legend**

- ✅ present and working
- ⚠️ present with a limitation (noted inline)
- ❌ not present (reason inline)
- — not applicable on that platform

---

## 1. Catalog & search

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Song search (`search_songs`) | ✅ | ✅ | First-party `www.jiosaavn.com/api.php`, mirrors as fallback |
| Paged results, unlimited depth | ✅ | ✅ | `page` 1..n, upstream `total` |
| Entity search — albums/artists/playlists (`search_entities`) | ✅ | ✅ | Entity chips on the mobile Search screen |
| Inline suggestions (`search_suggestions`) | ✅ | ✅ | |
| Fuzzy / typo-tolerant matching | ✅ | ✅ | `app/src/fuzzy.js`; mobile ranks with it too (`mobile/rank.js`) |
| Typo recovery ("did you mean") | ✅ | ✅ | Desktop: chips under the results. Mobile: toast action off `search_suggestions` |
| Filter chips (320 kbps, 5 min+, genres) | ✅ | ✅ | Desktop: chips + sort menu |
| Sort cycling (bitrate/popularity/longest/A–Z) | ✅ | ✅ | Desktop `search.js`; mobile cycles from a `↕` chip in the filter row, ordered by `mobile/rank.js` |
| Featured releases carousel | ✅ | ✅ | Desktop hero + shelves (`home.js:342-383`); mobile spotlight hero + shelves (`mobile/binders.js` `mountHome`) |
| Home feed (`home_feed`) | ✅ | ✅ | Curated feed + charts |
| Retry on failure | ✅ | ✅ | Any search failure, 429 included |
| Diagnostics log | ✅ | ✅ | Desktop `#diag` ring buffer (40 entries); mobile `Settings → Diagnostics` sheet off the same 40-entry ring (`shared.js` `pushDiag`) |

## 2. Playback

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Queue with play-next / add-to-queue | ✅ | ✅ | |
| Play / pause / seek / volume | ✅ | ✅ | |
| Shuffle, repeat (all/one/off) | ✅ | ✅ | |
| Smart shuffle (artist-aware, recency-weighted) | ✅ | ✅ | Desktop `transport.js:176-212` (`#btn-shuffle-queue`); mobile `player.js:599` via the queue sheet (`menus.js:41,950`) |
| Save queue as playlist | ✅ | ✅ | Desktop `transport.js:229-239` (`window.prompt` — never opens in a WebView); mobile uses its own sheet (`menus.js:873,958`) |
| Auto-advance on end and on error | ✅ | ✅ | 600 ms delay |
| Crossfade | ✅ | ✅ | Desktop two-`<audio>` volume ramp (`playback.js:284-428`). Ceiling: the fade window is discovered via `timeupdate` (~4/s), not sample-accurate. Mobile dual-element engine (`mobile/player.js:707-950`) + 0–12 s selector (`mobile/audioplus.js:114-131`) |
| Sleep timer (fade out, then pause) | ✅ | ✅ | `sleep.js` — shared by both shells; 15/30/60/90 min with a 15 s volume ramp. Desktop `Now Playing` select; mobile cycles presets from the `bedtime` button |
| Track details / credits sheet | ✅ | ✅ | Same rows (title/artist/album/year/language/label/duration/quality/plays/lyrics/explicit/id): desktop `openCredits` (`core.js:269-313`); mobile `detailsSheet` (`menus.js:314-343`) off the Now Playing badge (`binders.js:3377-3386`) |
| DSP / EQ presets | ❌ | ✅ | Desktop has no `AudioContext` — the "equalizer" glyphs in `index.html` sit next to placeholder copy ("DR14 Lossless Dynamic Range"), not a working control. Mobile has a real WebAudio chain: global 6-preset EQ + per-track override + normalize compressor (`mobile/player.js:441-562`, `mobile/audioplus.js`, `mobile/shared.js:972-1048`) |
| Range qualification badge (`FULL SONG` / `PREVIEW ONLY` / `UNREACHABLE`) | ✅ | ✅ | Three-probe check before playback |
| Bitrate / bit-depth badge | ✅ | ✅ | |
| Local relay playback (`127.0.0.1` byte-range proxy) | ✅ | ✅ | Ephemeral port, bound before window load |
| Speculative prefetch of next track (`prefetch_next`) | ✅ | ✅ | Resolves next ≤4 queue items, never bytes |
| Lock-screen / notification transport (`navigator.mediaSession`) | ✅ | ✅ | Both set metadata, action handlers, `playbackState` and `positionState` (`media.js` / `player.js`); the OS renders it as the desktop taskbar/SMTC overlay vs a phone lock screen |
| Media keys (Play/Pause/Next/Prev) | ✅ | ✅ | Desktop: OS media keys + tray; mobile: media session |
| Global Hyper shortcuts (Caps Lock chord) | ✅ | ❌ | OS-owned on Android; desktop only (`shortcuts.rs`) |
| `Ctrl + K` focus search | ✅ | ❌ | Desktop keyboard only |
| System volume control | ⚠️ | ❌ | `sysvol::system_volume` **parked** (commented out of `generate_handler`, `lib.rs:1684-1687`) |
| Gapless playback | ✅ | ✅ | Desktop `tm-gapless` skips the 600 ms `ended` delay (`queue.js:286-293`, Settings toggle `settings.js:1669-1671`); mobile `tm-gapless` 280 ms butt-join on the same dual-element engine (`mobile/player.js:723-729`, Settings switch `mobile/binders.js:3414`) |
| ReplayGain / loudness normalisation | ❌ | ⚠️ | No true ReplayGain on either shell — see [future-scope](future-scope.md). Mobile has a compressor-based normalize toggle (`tm-normalize`, `mobile/player.js:546-549`); desktop has none |
| Vault byte-prefetch (next track saved to disk while you listen) | ✅ | ❌ | Desktop `prefetchTrack` (`vault.js:472-478`, `tm-prefetch` toggle `vault.js:474,574`, called from `playback.js:275,407`). Mobile only warms resolve + probe metadata (`prefetch_next`), never bytes → **port candidate, backlog [P0-2](#p0--storage--data-safety-android-pain-today)** |
| Audio visualiser | ❌ | ❌ | Widget uses a decorative 7-bar CSS spectrum |

## 3. Browsing & discovery

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Album page (`album_tracks`) | ✅ | ✅ | |
| Artist page + discography (`artist_overview`, `artist_tracks`) | ✅ | ✅ | |
| Playlist page (`playlist_tracks`) | ✅ | ✅ | |
| Local / saved playlists | ✅ | ✅ | Mobile create/rename/delete via bottom-sheet (`menus.js` `openInputSheet`); native `prompt()` never opens in a WebView |
| Playlist remove by id | ✅ | ✅ | Mobile `libraryMenu` matches `id` first (was title-only, could remove the wrong list) |
| Charts | ✅ | ✅ | Platform chart playlists |
| Endless radio (`recommend_songs`) | ✅ | ✅ | `radio.js` on both shells |
| Liked Songs view | ⚠️ | ✅ | Mobile has a dedicated screen; desktop folds it into Library |
| Listening history | ✅ | ✅ | |
| Analytics screen | ❌ | ✅ | Mobile-only screen |
| Notification feed | ❌ | ✅ | Mobile-only; seeded once with a welcome event |

## 4. Offline vault

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Download to vault (`download_song`) | ✅ | ✅ | Byte-count checked before the file is kept; cellular blocked when Wi-Fi-only is on (`tm-wifi-only`, mobile only) |
| Progress reporting | ✅ | ✅ | Both stream over a Tauri `Channel`: desktop live rows (`vault.js:50-59` `renderActive`), mobile live In-Transit section (`shared.js` `getActiveDownloads`) |
| Cancel download (`cancelDownload`) | ✅ | ✅ | Backend `cancel_download` aborts at the next ~256 KB chunk (`lib.rs:699-702`). Desktop batch Stop calls it (`vault.js:116-123` `stopBatch`). Mobile per-row cancel is frontend-only — drops the row now and deletes the finished file on landing, never invokes the backend (`mobile/shared.js:547-561`) |
| Pause / resume batch (`setBatchPaused`) | ❌ | ✅ | Desktop has Stop (abort), not pause/resume. Mobile batch loop stops after the current track; single downloads unaffected |
| Wi-Fi-only gate (`wifiOnly`) | ❌ | ✅ | Blocks `downloadTrack`/`downloadAll` on `navigator.connection.type === cellular` or `saveData`; persisted in localStorage |
| Promote to higher quality (`promote_song`) | ✅ | ✅ | |
| List / remove / verify (`list_downloads`, `remove_download`, `verify_vault`) | ✅ | ✅ | Mobile: `Verify` button in the downloads tools strip — report-only, nothing is deleted |
| Reveal in file manager (`reveal_download`, `reveal_vault`) | ✅ | ❌ | Needs an OS file-manager intent |
| Download all (album/artist/playlist) | ✅ | ✅ | |
| Import manifest (`import_manifest`) | ✅ | ✅ | |
| Atomic writes + `.part` sweep | ✅ | ✅ | `proxy.rs:640` |
| Vault location | ✅ | ✅ | App data dir (`%LOCALAPPDATA%` / `~/.local/share` / sandbox); one-time migration from legacy `Downloads/TRANCE MUSIC` (`lib.rs:1478-1494`) |
| Vault quota + LRU eviction | ✅ | ❌ | Desktop `tm-vault-quota` GB cap + least-recently-played evict (`vault.js:410-467`), applied immediately on change (`settings.js:1761`), selector `index.html:1016`. No `tm-vault-quota` reference exists anywhere under `app/src/mobile/` (grep, 2026-10-07) → **port candidate, backlog [P0-1](#p0--storage--data-safety-android-pain-today)** |
| SQLite download ledger | ✅ | ✅ | `downloads.db`, serialized writes |

## 5. Cache & network

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Bounded caches (moka: resolved / qualified / search / lyrics) | ✅ | ✅ | TTL + capacity, shared core |
| Cache stats / budget / clear (`cache_*`) | ✅ | ✅ | Budget 100 MB – 5 GB; **clear never touches the vault** |
| App store (`store.db`, 18 `store_*` + 3 `outbox_*` commands) | ✅ | ✅ | rusqlite/WAL `songs` + `kv` + `search_cache` tables (`store.rs`); metadata only, never audio bytes. Desktop + mobile mirror plays/favs/search pages into it (`store_db.js`); localStorage stays as fallback |
| Network state machine (online / degraded / offline) | ✅ | ✅ | |
| Reachability probe (`net_ping`) | ✅ | ✅ | |
| Offline queue (undownloaded tracks skipped) | ✅ | ✅ | |
| Adaptive quality on slow links | ❌ | ❌ | See [future-scope](future-scope.md) |

## 6. Lyrics

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Synced lyrics (`get_lyrics`) | ✅ | ✅ | LRCLIB → JioSaavn → LRCLIB search |
| Auto-scroll, manual offset, click-to-seek | ✅ | ⚠️ | Desktop: ±100 ms `−`/`+` buttons + reset, per-track offsets persisted in `tm-lyrics-offsets` (`lyrics.js:65,402-404`, UI `index.html:1470-1474`), click a line to seek. Mobile: click-to-seek + auto-scroll toggle exist, **no offset control** (`tm-lyrics-offsets` has zero hits under `app/src/mobile/`) → **port candidate, backlog [P1-1](#p1--parity-cheap-no-new-dependency)** |
| Karaoke word-level paint | ✅ | ✅ | Desktop `lyrics.js:90-202` (`splitWords` + fallback spread + `--progress` wipe, rAF clock) + `.lyric-*` CSS; mobile `lyrics.js` + `.lyric-*` CSS |
| AI lyrics fallback (Gemini) | ❌ | ✅ | Mobile-only: `mobile/ai-lyrics.js` for tracks the LRCLIB → JioSaavn cascade misses |
| Translation | ❌ | ❌ | UI toggle exists but is not wired — see [future-scope](future-scope.md) |

## 7. UI shell & windows

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| 8 views / 13 screens | ✅ | ✅ | `home · search · library · playlists · detail · now-playing · downloads · history` vs 13 mobile screens |
| Persistent mini-player | ✅ | ✅ | Mobile `#tm-widget`: shuffle toggle, vault ⬇ badge (`isVaulted`), buffered fill, offline/error/resolving artist-line states, 40–44 px targets, swipe left/right = prev/next, swipe up = open NowPlaying (`mobile/app.js`) |
| Full Now Playing screen | ✅ | ✅ | |
| **Desktop widget** (always-on-top window) | ✅ | ❌ | Mobile uses the `nowplaying` screen + media notification instead |
| Widget drag / pin / click-through | ✅ | — | `widget.rs`, `widget_start_drag` |
| Widget ↔ main window state bridge | ✅ | — | `bridge.js`, `withGlobalTauri` |
| System tray with transport menu | ✅ | ❌ | `build_tray`, `#[cfg(desktop)]` (`lib.rs:1435-1469`) |
| Single-instance guard | ✅ | ❌ | `#[cfg(desktop)]` (`lib.rs:1519-1524`) |
| Hardware back button | ❌ | ✅ | `window.__tmBack()` |
| Safe-area insets | ❌ | ✅ | `env(safe-area-inset-*)` |
| Bottom navigation bar | ❌ | ✅ | Canonical mobile nav in `router.js` |
| Light / dark / system theme | ✅ | ✅ | Both boot `tm-theme` before first paint (desktop `index.html:18-21`, mobile `index.html:760-766`). Mobile ships its own light + obsidian theme engine (`index.html:261-758`), density + theme controls `binders.js:3855-3856,3886-3895` |
| Keyboard shortcuts screen | ✅ | ❌ | `Settings → Shortcuts`, `docs/shortcuts.md` |

---

## 8. Settings & system

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Profile name, language + region prefs (`content_prefs_set`) | ✅ | ✅ | |
| Open at startup (`autostart_set`) | ✅ | ❌ | Mobile: `Err("…controlled by Android's system settings")` |
| Open external link (`open_external`) | ✅ | ❌ | Mobile: `Err("…not supported on Android yet")` |
| Export / import file dialogs (`export_file`, `read_import_file`) | ✅ | ❌ | `#[cfg(desktop)]` — `tauri-plugin-dialog` has no mobile build |
| Backup / restore (JSON) | ✅ | ⚠️ | Desktop via native dialogs; mobile via share-sheet + hidden `<input type=file>` (no native picker — future scope) |
| CSV / M3U export | ✅ | ✅ | Same generators both sides: `sync.js:355-410` (`playlistToCsv`/`playlistToM3u`). Desktop saves via `export_file` (`settings.js:1145-1146`); mobile shares the file from the playlist sheet (`mobile/menus.js:47,247`) — no native dialog needed |
| Spotify sign-in + Top-tracks import (`spotify_*`, 4 commands) | ✅ | ❌ | Desktop Settings → Spotify (`settings.js:744-783,1860-1981`) + Exportify CSV import (`importer.js`). Mobile: `Err("Spotify sign-in is not supported on mobile yet")` via keyring stubs (`spotify.rs:118-131`) |
| Google Drive sync (`gdrive_*`, 5 commands) | ⚠️ | ❌ | Desktop engine live (`gsync.js`) but Settings UI **parked** (commented out, `settings.js:735-738`). Mobile: `Err("…not supported on Android yet")` — scaffolding only |
| **Self-updater** — check (`update_check`) | ✅ | ✅ | Mobile only *notifies*; store handles install |
| **Self-updater** — install / rollback (`update_install`, `update_rollback`) | ✅ | ❌ | `#[cfg(desktop)]` |
| Signed installers (MSI / NSIS / deb / AppImage / DMG) | ✅ | ❌ | Mobile ships APK/AAB via the store |
| Bluetooth device picker (`bluetooth_devices`) | ⚠️ | ⚠️ | **Parked** — commented out of `generate_handler` (`lib.rs:1680-1683`) |
| System master volume (`sysvol::*`) | ⚠️ | ❌ | **Parked** — commented out (`lib.rs:1684-1687`) |
| OS media overlay / volume popup | ✅ | ✅ | System-owned on both |

## 9. Platform-only, by design

These are not gaps — they are concepts that only exist on one platform.

| Desktop only | Why |
|---|---|
| Desktop widget window, tray, single-instance | Window-management concepts Android/iOS do not offer |
| Global Hyper shortcuts, `Ctrl+K` | OS owns global key interception on mobile |
| Native file/folder pickers, reveal-in-manager | Android needs SAF / document picker / a folder Intent — see backlog [P2](#p2--needs-a-native-bridge) |
| In-app updater install + rollback | Mobile stores own the install step |
| Autostart write | Android owns autostart + battery policy |
| Spotify sign-in + Top-tracks/CSV import | Mobile keyring has no OS credential store (`spotify.rs:118-131`) |

> **Not platform-only, just not ported yet:** vault quota + LRU eviction and
> byte-prefetch used to sit in this table as "no mobile equivalent" — they are
> ordinary frontend features desktop already proved, so they moved to the
> [port backlog](#10-desktop--mobile-port-backlog-android-improvement) (P0).
> CSV/M3U export left this table too: mobile shares generated files without a
> save dialog (`mobile/menus.js:247`).

| Mobile only | Why |
|---|---|
| Lock-screen / notification transport | `navigator.mediaSession` |
| EQ presets + per-track EQ + normalize compressor | Desktop has no `AudioContext`; mobile WebAudio chain only |
| Hardware back, safe-area insets, bottom nav | Platform chrome |
| Notification feed, Analytics, streaks, AI-lyrics fallback, TRANCE-SHARE codes | Mobile shell extras (`homeplus.js`, `streaks.js`, `ai-lyrics.js`, `sharecode.js`) |

---

## 10. Desktop → Mobile port backlog (Android improvement)

Everything below was verified **absent on Android, present and working on
desktop** (2026-10-07 audit), then landed in order of Android pain. Excludes
§9 platform-only concepts.

### P0 — storage & data safety (Android pain today) — ✅ LANDED 2026-10-07

| # | Feature | Desktop code | What Android got | Acceptance |
|---|---|---|---|---|
| P0-1 | **Vault quota + LRU eviction** ✅ | `vault.js:410-467` (`tm-vault-quota`), selector `index.html:1016` | GB cap in Settings → Storage; least-recently-played evicts when over quota. Pure picker in `mobile/quota.js` (unit-tested); enforced after every download lands | Over-quota download → oldest-played evicted, current track + in-flight downloads never touched; `app/tests/vault-quota.test.mjs` |
| P0-2 | **Vault byte-prefetch (`tm-prefetch`)** ✅ | `prefetchTrack` `vault.js:472-478` | Next queue track downloads to disk while you listen. Switch in Settings → Playback; gated off on cellular + Data Saver so it never burns metered bytes (`mobile/shared.js` `prefetchTrackBytes`) | Wi-Fi: next track is a vault hit at track end; cellular/Data Saver: zero extra bytes |

### P1 — parity, cheap, no new dependency — ✅ LANDED 2026-10-07

| # | Feature | Desktop code | What Android got | Acceptance |
|---|---|---|---|---|
| P1-1 | **Lyrics manual offset** ✅ | `lyrics.js:65,402-404`; controls `index.html:1470-1474` | `−`/`+`/reset in the NowPlaying Lyrics tab; per-track `tm-lyrics-offsets`, clamp ±2 s, same `currentTime + offset/1000` formula as desktop | Offset persists per track id across reloads; karaoke paint shifts with it |
| P1-2 | **Room QR render** ✅ | `qrview.js:16 paintQr`, `social.js:626-668` | Canvas on the Jam Data tab, repainted on room/invite change; `qr::qr_symbol` was already registered on mobile (`lib.rs:1648`). `paintQr` takes an optional invoke fn so mobile reuses the one rasterizer | QR encodes `inviteText(room)`; scans to the same string the Copy button hands out |
| P1-4 | **Exportify CSV import** ✅ | `importer.js:9 parseExportifyCsv` | `Import playlist CSV` row in Settings → Storage (hidden file input, no native picker needed); parser is core.js-free so mobile imports it directly | Parsed CSV becomes a local playlist; bad rows reported, not silent |

### P2 — needs a native bridge (still OPEN)

Coordinate with [`mobile/08-future-scope.md`](mobile/08-future-scope.md) #3/#4 —
these are already written up there; listed here for parity accounting.

| # | Feature | Desktop code | Android route |
|---|---|---|---|
| P1-3 | Reveal vault file in a file manager | `reveal_download`, `reveal_vault` (`lib.rs:1678-1679`) | Android folder Intent — lands with P2-3 |
| P2-1 | Native file import/export (backup/restore JSON, CSV, M3U) | `export_file`, `read_import_file` (`#[cfg(desktop)]` `lib.rs:1688-1691`) | SAF / document picker / share sheet — content generation already works on mobile (`menus.js:247`) |
| P2-2 | Google Drive sync (`gdrive_*`) | Engine live `gsync.js`; UI parked `settings.js:735-738` | Unblock `gdrive.rs` mobile `Err` — needs an OAuth flow that can open a browser tab |
| P2-3 | `open_external` | `lib.rs:1709` | Android `Intent.ACTION_VIEW` (also unblocks P1-3) |
| P2-4 | QR camera **scan** to join | — (desktop has no camera either) | Camera permission + scanner; pairs with P1-2. **New dependency → needs approval before installing a plugin** |

**Deliberately not ported** (stay in §9): tray, single-instance, desktop
widget window, global Hyper/`Ctrl+K` shortcuts, in-app updater install,
autostart write, system volume (`sysvol` is parked on desktop too).

---

## Source of truth

Every ✅/⚠️/❌ above traces to code:

- Command registration and `#[cfg(desktop)]` gates → `app/src-tauri/src/lib.rs:1647-1742` (82 entries, 4 gated)
- Desktop-only plugins → `app/src-tauri/Cargo.toml:49-67`
- Mobile commands that return explicit errors → `lib.rs`, `gdrive.rs`, `spotify.rs`, `proxy.rs`
- Mobile screen inventory → `app/src/mobile/screens/` (13 pairs)
- Mobile feature narrative → [`mobile/06-features.md`](mobile/06-features.md)
- Mobile known limitations → [`mobile/08-future-scope.md`](mobile/08-future-scope.md)
- This document audited against code 2026-10-07 (version, IPC count, theme, CSV/M3U, lyrics offset, credits, QR rows re-verified)

When a feature moves, update this table in the same commit as the code.
