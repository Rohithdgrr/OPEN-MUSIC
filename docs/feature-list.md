# Feature List — TRANCE MUSIC

Feature-by-feature comparison of the **desktop** and **mobile** surfaces.

| | |
|---|---|
| Version | `0.3.0` (`app/package.json:4`, `Cargo.toml:3`, `tauri.conf.json:4`) |
| Desktop shell | `app/src/index.html` — 8 views + Settings dialog + widget window |
| Mobile shell | `app/src/mobile/index.html` — 13 screens, hash router + bottom nav |
| Rust core | shared by both (`app/src-tauri/src/*.rs`, 15 files) |
| IPC surface | **48** commands registered (`lib.rs:1353`); **4** are `#[cfg(desktop)]` only |
| IPC contract | `api_version() -> 1` (`lib.rs:290`) |

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
| Fuzzy / typo-tolerant matching | ✅ | ✅ | `app/src/fuzzy.js` (desktop only) |
| Filter chips (320 kbps, 5 min+, genres) | ✅ | ✅ | Desktop: chips + sort menu |
| Sort cycling (bitrate/popularity/longest/A–Z) | ✅ | ✅ | |
| Featured releases carousel | ✅ | ❌ | Desktop `home.js` only |
| Home feed (`home_feed`) | ✅ | ✅ | Curated feed + charts |
| Retry on failure | ✅ | ✅ | Any search failure, 429 included |
| Diagnostics panel | ✅ | ❌ | Desktop `#diag` ring buffer (40 entries); mobile has an unused `diag` callback in `net.js` but no panel |

## 2. Playback

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Queue with play-next / add-to-queue | ✅ | ✅ | |
| Play / pause / seek / volume | ✅ | ✅ | |
| Shuffle, repeat (all/one/off) | ✅ | ✅ | |
| Auto-advance on end and on error | ✅ | ✅ | 600 ms delay |
| Crossfade | ✅ | ❌ | Real two-`<audio>` volume ramp (`playback.js:256`). Ceiling: the fade window is discovered via `timeupdate` (~4/s), not sample-accurate. Mobile has no second audio element. |
| DSP / EQ presets | ❌ | ❌ | No `AudioContext` anywhere. The "equalizer" glyphs in `index.html` sit next to placeholder copy ("DR14 Lossless Dynamic Range"), not a working control. |
| Range qualification badge (`FULL SONG` / `PREVIEW ONLY` / `UNREACHABLE`) | ✅ | ✅ | Three-probe check before playback |
| Bitrate / bit-depth badge | ✅ | ✅ | |
| Local relay playback (`127.0.0.1` byte-range proxy) | ✅ | ✅ | Ephemeral port, bound before window load |
| Speculative prefetch of next track (`prefetch_next`) | ✅ | ✅ | Resolves next ≤4 queue items, never bytes |
| Lock-screen / notification transport (`navigator.mediaSession`) | ✅ | ✅ | Both set metadata, action handlers, `playbackState` and `positionState` (`media.js` / `player.js`); the OS renders it as the desktop taskbar/SMTC overlay vs a phone lock screen |
| Media keys (Play/Pause/Next/Prev) | ✅ | ✅ | Desktop: OS media keys + tray; mobile: media session |
| Global Hyper shortcuts (Caps Lock chord) | ✅ | ❌ | OS-owned on Android; desktop only (`shortcuts.rs`) |
| `Ctrl + K` focus search | ✅ | ❌ | Desktop keyboard only |
| System volume control | ⚠️ | ❌ | `sysvol::system_volume` **parked** (commented out of `generate_handler`, `lib.rs:1383`) |
| Gapless playback | ❌ | ❌ | See [future-scope](future-scope.md) |
| ReplayGain / loudness normalisation | ❌ | ❌ | See [future-scope](future-scope.md) |
| Audio visualiser | ❌ | ❌ | Widget uses a decorative 7-bar CSS spectrum |

## 3. Browsing & discovery

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Album page (`album_tracks`) | ✅ | ✅ | |
| Artist page + discography (`artist_overview`, `artist_tracks`) | ✅ | ✅ | |
| Playlist page (`playlist_tracks`) | ✅ | ✅ | |
| Local / saved playlists | ✅ | ✅ | |
| Charts | ✅ | ✅ | Platform chart playlists |
| Endless radio (`recommend_songs`) | ✅ | ✅ | `radio.js` on both shells |
| Liked Songs view | ⚠️ | ✅ | Mobile has a dedicated screen; desktop folds it into Library |
| Listening history | ✅ | ✅ | |
| Analytics screen | ❌ | ✅ | Mobile-only screen |
| Notification feed | ❌ | ✅ | Mobile-only; seeded once with a welcome event |

## 4. Offline vault

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Download to vault (`download_song`) | ✅ | ✅ | Byte-count checked before the file is kept |
| Progress reporting | ⚠️ | ✅ | Mobile streams progress over a Tauri `Channel` |
| Promote to higher quality (`promote_song`) | ✅ | ✅ | |
| List / remove / verify (`list_downloads`, `remove_download`, `verify_vault`) | ✅ | ✅ | |
| Reveal in file manager (`reveal_download`, `reveal_vault`) | ✅ | ❌ | Needs an OS file-manager intent |
| Download all (album/artist/playlist) | ✅ | ✅ | |
| Import manifest (`import_manifest`) | ✅ | ✅ | |
| Atomic writes + `.part` sweep | ✅ | ✅ | `proxy.rs:640` |
| Vault location | ✅ | ✅ | App data dir (`%LOCALAPPDATA%` / `~/.local/share` / sandbox); one-time migration from legacy `Downloads/TRANCE MUSIC` (`lib.rs:1292`) |
| SQLite download ledger | ✅ | ✅ | `downloads.db`, serialized writes |

## 5. Cache & network

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Bounded caches (moka: resolved / qualified / search / lyrics) | ✅ | ✅ | TTL + capacity, shared core |
| Cache stats / budget / clear (`cache_*`) | ✅ | ✅ | Budget 100 MB – 5 GB; **clear never touches the vault** |
| Network state machine (online / degraded / offline) | ✅ | ✅ | |
| Reachability probe (`net_ping`) | ✅ | ✅ | |
| Offline queue (undownloaded tracks skipped) | ✅ | ✅ | |
| Adaptive quality on slow links | ❌ | ❌ | See [future-scope](future-scope.md) |

## 6. Lyrics

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Synced lyrics (`get_lyrics`) | ✅ | ✅ | LRCLIB → JioSaavn → LRCLIB search |
| Auto-scroll, manual offset, click-to-seek | ✅ | ✅ | |
| Karaoke word-level paint | ⚠️ | ✅ | Mobile `lyrics.js` + `.lyric-*` CSS |
| Translation | ❌ | ❌ | UI toggle exists but is not wired — see [future-scope](future-scope.md) |

## 7. UI shell & windows

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| 8 views / 13 screens | ✅ | ✅ | `home · search · library · playlists · detail · now-playing · downloads · history` vs 13 mobile screens |
| Persistent mini-player | ✅ | ✅ | |
| Full Now Playing screen | ✅ | ✅ | |
| **Desktop widget** (always-on-top window) | ✅ | ❌ | Mobile uses the `nowplaying` screen + media notification instead |
| Widget drag / pin / click-through | ✅ | — | `widget.rs`, `widget_start_drag` |
| Widget ↔ main window state bridge | ✅ | — | `bridge.js`, `withGlobalTauri` |
| System tray with transport menu | ✅ | ❌ | `build_tray`, `#[cfg(desktop)]` (`lib.rs:1184`) |
| Single-instance guard | ✅ | ❌ | `#[cfg(desktop)]` (`lib.rs:1268`) |
| Hardware back button | ❌ | ✅ | `window.__tmBack()` |
| Safe-area insets | ❌ | ✅ | `env(safe-area-inset-*)` |
| Bottom navigation bar | ❌ | ✅ | Canonical mobile nav in `router.js` |
| Light theme | ❌ | ❌ | Dark only — see [future-scope](future-scope.md) |
| Keyboard shortcuts screen | ✅ | ❌ | `Settings → Shortcuts`, `docs/shortcuts.md` |

## 8. Settings & system

| Feature | Desktop | Mobile | Notes |
|---|---|---|---|
| Profile name, language + region prefs (`content_prefs_set`) | ✅ | ✅ | |
| Open at startup (`autostart_set`) | ✅ | ❌ | Mobile: `Err("…controlled by Android's system settings")` |
| Open external link (`open_external`) | ✅ | ❌ | Mobile: `Err("…not supported on Android yet")` |
| Export / import file dialogs (`export_file`, `read_import_file`) | ✅ | ❌ | `#[cfg(desktop)]` — `tauri-plugin-dialog` has no mobile build |
| Backup / restore (JSON) | ✅ | ⚠️ | Commands exist; mobile needs a document picker (future scope) |
| CSV / M3U export | ✅ | ⚠️ | Same gate as above |
| Google Drive sync (`gdrive_*`, 5 commands) | ✅ | ❌ | Mobile: `Err("…not supported on Android yet")` — scaffolding only |
| **Self-updater** — check (`update_check`) | ✅ | ✅ | Mobile only *notifies*; store handles install |
| **Self-updater** — install / rollback (`update_install`, `update_rollback`) | ✅ | ❌ | `#[cfg(desktop)]` |
| Signed installers (MSI / NSIS / deb / AppImage / DMG) | ✅ | ❌ | Mobile ships APK/AAB via the store |
| Bluetooth device picker (`bluetooth_devices`) | ⚠️ | ⚠️ | **Parked** — commented out of `generate_handler` (`lib.rs:1379`) |
| System master volume (`sysvol::*`) | ⚠️ | ❌ | **Parked** — commented out (`lib.rs:1383`) |
| OS media overlay / volume popup | ✅ | ✅ | System-owned on both |

## 9. Platform-only, by design

These are not gaps — they are concepts that only exist on one platform.

| Desktop only | Why |
|---|---|
| Desktop widget window, tray, single-instance | Window-management concepts Android/iOS do not offer |
| Global Hyper shortcuts, `Ctrl+K` | OS owns global key interception on mobile |
| Native file/folder pickers, reveal-in-manager | Mobile needs SAF / document picker / share sheet (future scope) |
| In-app updater install + rollback | Mobile stores own the install step |
| Autostart write | Android owns autostart + battery policy |

| Mobile only | Why |
|---|---|
| Lock-screen / notification transport | `navigator.mediaSession` |
| Hardware back, safe-area insets, bottom nav | Platform chrome |
| Notification feed, Analytics screens | Mobile shell extras |

---

## Source of truth

Every ✅/⚠️/❌ above traces to code:

- Command registration and `#[cfg(desktop)]` gates → `app/src-tauri/src/lib.rs:1353`
- Desktop-only plugins → `app/src-tauri/Cargo.toml:38-50`
- Mobile commands that return explicit errors → `lib.rs`, `gdrive.rs`
- Mobile screen inventory → `app/src/mobile/screens/` (13 pairs)
- Mobile feature narrative → [`mobile/06-features.md`](mobile/06-features.md)
- Mobile known limitations → [`mobile/08-future-scope.md`](mobile/08-future-scope.md)

When a feature moves, update this table in the same commit as the code.
