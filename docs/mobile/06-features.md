# 06 — Mobile Features

Source of truth: `app/src/mobile/` + the shared Rust commands in `lib.rs`.
Desktop-only items are marked — they return an explicit error on mobile
instead of failing oddly.

## Playback

- Single `<audio>` queue with play/pause/next/prev, shuffle, repeat
  (`mobile/player.js`), row-tap-to-play → jumps to `nowplaying`
  (`mobile/app.js`).
- Stream resolution via `resolve_song` → localhost range relay (`proxy.rs`);
  `qualify_url` honesty probe; `prefetch_next` warms the next ≤4 tracks.
- Lock-screen / notification transport via `navigator.mediaSession`
  (metadata + action handlers + position state, `player.js`).
- Offline: vault tracks play from disk (`resolve_song` vault hit);
  network state machine (online / degraded / offline) skips undownloaded
  tracks while offline.
- Lyrics: `get_lyrics` (LRCLIB synced → JioSaavn text → LRCLIB search),
  karaoke paint in `mobile/lyrics.js` + `.lyric-*` CSS in `mobile/index.html`.
- NowPlaying (`mobile/screens/nowplaying.*`): the artwork card mirrors the
  desktop overlay's metadata — eyebrow track line (`#np-trackline`),
  title/artist with favorite / download / add / share actions, and an
  ALBUM · LENGTH · ROOM telemetry strip (`binders.js:paintNowplaying` paints it
  from the player state, `jam.js:paintJam` fills the room count). The
  Queue / Chat / Jam Data / Lyrics tabs are bound with `addEventListener` in
  the screen script — inline `onclick` is refused by the mobile CSP
  (09-problems-solutions P24). There is **no in-app volume slider** (removed
  2026-10-06: system volume keys own it; `tm-mobile-vol` still seeds the level
  in `player.js`).

## Library & discovery

- Routes: `home`, `search` (songs + entity chips + suggestions),
  `main-library` (+ `vault` alias), `liked-songs`, `album`, `artist`,
  `playlist`, `download(s)`, `history`, `notification(s)`, `analytics`,
  `settings` (`mobile/router.js` `SCREENS` table).
- Commands used: `search_songs`, `search_entities`, `search_suggestions`,
  `home_feed`, `playlist_tracks`, `album_tracks`, `artist_tracks`,
  `artist_overview`, `recommend_songs` (endless radio via `mobile/radio.js`).
- Local state: favorites, plays, history, library, download quality, language/
  region prefs (`mobile/shared.js` keys); artist/album name taps resolve via
  `search_entities` (`app.js:resolveEntity`).
- Notifications feed seeded once with a welcome event (`app.js` bottom);
  update checks via `checkForUpdates` (desktop updater; on mobile it only
  notifies — no in-app install).

## Offline vault & data portability

- `download_song` (progress over Tauri `Channel`), `promote_song`,
  `list_downloads`, `remove_download`, `verify_vault`, `import_manifest`;
  vault lives in the app data dir (`TRANCE MUSIC` under
  `%LOCALAPPDATA%` / `~/.local/share` / app sandbox), migrated once from the
  legacy `Downloads/TRANCE MUSIC` folder (`lib.rs:migrate_vault`).
- Cache controls: `cache_stats`, `cache_set_budget` (100 MB–5 GB),
  `cache_clear` (never touches the vault), `net_ping` reachability probe.
- Backup/restore + Drive sync commands exist (`gdrive_*`), but native
  file pickers are desktop-only (see below).

## Connection banner (minimal, delayed)

- `#net-banner` (`mobile/net.js`) sits **below** the screen header
  (`top = safe-area + 3.5rem + 8px`), compact pill (`text-[11px]`,
  `px-3 py-1`, `w-max`, icon `14px`) — never overlapping the app-bar.
- Delayed show: the banner unhides only after `SHOW_AFTER_MS` (8 s) of
  sustained non-online state; transient blips stay invisible. The delay
  matures even without a state change (same-state probes re-check it).
  Routing (`netMode()` → online/degraded/offline) is unaffected — only
  visibility is debounced. Recovery hides immediately and resets the timer.
- Banner vs toast split (mirrors desktop `src/net.js`, which retired its
  pill for the same reason): the banner owns persistent bad-state display,
  so probe-driven transitions are toast-`silent`. The bottom toast fires
  only for recovery (`Back online…` — the banner just vanishes, so the
  toast is the sole confirmation) and for user-initiated `setModePref`
  changes. Action feedback toasts (e.g. offline lookup errors) are
  unaffected — they answer an action, not a state.

## Deliberately unavailable on mobile (explicit errors)

| Command / area | Mobile behaviour | Reason |
| --- | --- | --- |
| `export_file`, `read_import_file` | compiled out (`#[cfg(desktop)]`) | `tauri-plugin-dialog` has no mobile build |
| `open_external` | `Err("…not supported on Android yet")` (`lib.rs`) | needs Intent / opener plugin |
| `autostart_set` | `Err("…controlled by Android's system settings")` | OS owns autostart / battery policy |
| `open_bluetooth_settings` | `Err("…not available on Android")` | parked with the mini-player button |
| Updater plugin, tray, global shortcuts, single-instance | desktop-only (`Cargo.toml`, `lib.rs:builder`) | no mobile implementation / OS-owned concepts |
| Desktop widget window | commands exist, window absent; `start_drag` no-ops | mobile uses the `nowplaying` screen + media notification instead |

## Platform differences (Android vs iOS)

- Android: `rustls-tls` reqwest; hardware back via `window.__tmBack()`;
  safe-area insets (`pt-safe`/`pb-safe`, `env(safe-area-inset-*)`); release =
  locally built APK/AAB.
- iOS: same shell + overlay config; signed `.ipa` only with Apple secrets,
  otherwise unsigned Simulator `.app`; updates via App Store, never the
  Tauri updater.
