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
- Stream quality: `effectiveStreamQuality()` (`mobile/shared.js`) — Data
  Saver 64 kbps, Wi-Fi 320 kbps, **cellular Auto = 320 kbps** (was 96;
  changed 2026-10-07 so default mobile-data playback isn't audibly
  degraded — economy is an explicit picker or Data Saver).
- Resume position (`tm-remember-pos`, Settings → Playback): the playhead
  of the playing track is persisted (`tm-pos`, `{id, t}`) on
  timeupdate/pause/visibility-hidden and re-applied on the next start of
  the *same* track (`mobile/player.js`). Off switch honours the same key
  desktop reads.
- Smart downloads (`tm-smart-dl`): a played track is auto-saved to the
  vault in the background — Wi-Fi only, never on cellular, quiet, deduped
  (`mobile/shared.js pushPlay`). The switch was storage-only before
  2026-10-07; it now has a consumer.
- Byte-prefetch (`tm-prefetch`, Settings → Playback): while a track
  plays, the next queue track is downloaded to disk
  (`prefetchTrackBytes`), gated off on cellular and Data Saver so it
  never burns metered bytes. Distinct from `prefetch_next`, which only
  warms resolve metadata.
- Lyrics: `get_lyrics` (LRCLIB synced → JioSaavn text → LRCLIB search),
  karaoke paint in `mobile/lyrics.js` + `.lyric-*` CSS in `mobile/index.html`.
  Per-track manual offset (±100 ms buttons in the Lyrics tab, clamp
  ±2 s, `tm-lyrics-offsets`, same `currentTime + offset/1000` formula
  as desktop `lyrics.js:313`).
- NowPlaying (`mobile/screens/nowplaying.*`): the artwork card mirrors the
  desktop overlay's metadata — eyebrow track line (`#np-trackline`),
  title/artist with favorite / download / add / share actions, and an
  ALBUM · LENGTH · ROOM telemetry strip (`binders.js:paintNowplaying` paints it
  from the player state, `jam.js:paintJam` fills the room count). The
  Queue / Chat / Jam Data / Lyrics tabs are bound with `addEventListener` in
  the screen script — inline `onclick` is refused by the mobile CSP
  (09-problems-solutions P24). The Jam Data tab renders the room QR
  (`qrview.js paintQr` with the mobile `invoke`; encodes the same
  invite string the Copy button hands out — `qr::qr_symbol` was already
  registered on mobile, `lib.rs:1648`). There is **no in-app volume slider** (removed
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
- Vault quota + LRU eviction (`tm-vault-quota`, GB; Settings → Storage):
  after a download lands, over-quota vaults evict least-recently-played
  tracks (play order from `tm-plays`, oldest-added tie-break), never the
  playing track or an in-flight download. Picker is the pure
  `mobile/quota.js` (unit-tested, mirrors desktop `vault.js:410-467`).
- Cache controls (`cache_stats`, `cache_set_budget` 100 MB–5 GB,
  `cache_clear` — never touches the vault) now have a **Settings →
  Storage** section on mobile: usage line, budget select, Clear button;
  `net_ping` reachability probe unchanged.
- Exportify CSV import (`importer.js:parseExportifyCsv`, core.js-free):
  `Import playlist CSV` row in Settings → Storage behind a hidden file
  input; parsed rows become a local playlist, bad rows are reported.
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

## Android UI parity batch (2026-10-07) — spec + todo

Scope: **mobile shell only** (`app/src/mobile/**`); desktop is the visual
reference, untouched. Requested by the user with three screenshots.

### Root causes found before editing

1. **Three-dots menu "only has 3 options"** — the options sheet clips its
   list: content `max-h-[40vh]` and list `max-h-[calc(40vh-240px)]`
   (`menus.js ensureSheet`) leave ~110px ≈ 3 rows. The other options
   (View Album, Go to Artist, Share, Details, EQ) exist but sit below the
   fold with no visible scroll cue.
2. **Stale/blank thumbnails** — `paintArt` already maps empty art to the
   brand mark, but two callers guard it away: widget `if (img &&
   t.image)` (`app.js syncWidget paint`) and NowPlaying `if (artImg &&
   t.image)` (`binders.js` onPaint) — a track without art keeps the
   *previous* track's cover. `homeplus.js` also wrote `src=""` for
   artless items (the browser then requests the page URL as an image →
   broken tile).
3. **Track menu missing Download** — `trackMenu` (row + NowPlaying
   three-dots) had no Download; the library recent-plays branch already
   did (`menus.js libraryMenu`).

### Work list

- [x] Sheet height: `40vh` → `75vh` (content + list) so the full menu
      is visible on phone screens. *(done — `menus.js ensureSheet`)*
- [x] `trackMenu` items in the user's order: Track Details · Go to Artist
      · View Album (movie albums are albums) · Play Next · Add to Queue ·
      Add to Playlist · **Download (new)** · Share Track · Share Card ·
      EQ · context removals. *(done — `menus.js trackMenu`)*
- [x] Stale-art guards fixed (widget + NowPlaying always call `paintArt`,
      empty → brand mark) and `homeplus.js` uses the shared `art()`
      helper. *(done — `app.js`, `binders.js`, `homeplus.js`)*
- [x] NowPlaying metadata parity with desktop: eyebrow `TRACK nn / n •
      STEREO DIRECT` (desktop `np-trackline` wording) + a real quality
      chip painted from `st.badge` (the resolve's `chosen_quality`) +
      a QUALITY cell in the telemetry strip (ALBUM · LENGTH · QUALITY ·
      ROOM). *(done — `screens/nowplaying.html` + `binders.js` onPaint)*
- [x] "Songs not streaming" report triaged → **not reproducible** (cold +
      warm probes stream on the installed release; audio unmuted). Root
      causes recorded as P30 in `09-problems-solutions.md`; the blank white
      widget tile was the stale-paint guard fixed above.
- [x] Build **universal release** APK (lightweight: release profile + size
      packaging per `docs/android-universal-release.md` / `APK-SIZE.md`),
      install on `Pixel6_API36`, verify: thumbnails loaded, metadata
      visible, full menu on screen, streaming still OK. *(done — BUILD 6,
      18,285,395 B; see P29/P30)*

## Now Playing: artwork and metadata are separate cards (2026-10-07)

User report: *"separate the meta data and thumbnail in nowplaying screen like
old and make that proper visible"* — with a screenshot of the metadata card
rendering as an **empty white box** over the album art.

### Root cause (verified on the device, not inferred)

The `97b0db8` regeneration moved the track header **into the artwork** as a dark
glass overlay (`bg-black/60 backdrop-blur-md border border-white/10
rounded-xl`), copying the desktop `.np-art-overlay`. The mobile light theme has
a blanket card rule:

```css
html:not(.dark) .rounded-2xl.border,
html:not(.dark) .rounded-xl.border { background: linear-gradient(180deg,#fff,#fbfbfd) !important; }
```

`!important` beats Tailwind's utility, so the overlay computed to
`background-image: linear-gradient(rgb(255,255,255) 0%, …)` while every child
kept `text-white` — white text on a white card, i.e. invisible metadata plus a
white rectangle over the cover. DOM dump from the running app
(`#np-art` section): overlay box `41,318,331,138`, computed
`bg rgba(0,0,0,0)` / `bgi linear-gradient(rgb(255,255,255) 0%, …)`.
The dark theme has the same rule with `#151518` (would have been readable) — so
this only ever broke in light mode, which is the default.

### Shipped layout ("like old" = the `6e724b4` composition)

1. **Artwork card** (`#np-art-card`) — the square cover, the `[data-badge]`
   quality chip (top-left) and the `#artworkCollabTag` SOLO/room chip
   (top-right) only. Explicitly exempted from the blanket card rule in both
themes (it is a media frame, not a list card) so `bg-black/60` chips and the
   art shadow stay as designed.
2. **Metadata card** (`#np-meta`), directly **below** the art, on the screen
   surface: eyebrow `#np-trackline` + `#np-qchip`, title `#np-title`, artist
   `#np-artist`, the four actions (`favorite-btn`, `download-btn`,
   `playlist-add-btn`, `share-utility-btn`), and the telemetry strip
   (ALBUM · LENGTH · QUALITY · ROOM = `np-album`, `np-length`, `np-quality`,
   `np-room-members`).
3. **Tokens only** — the card is `bg-surface-container-lowest border
   border-outline-variant/30 rounded-2xl` with `text-on-surface` /
   `text-secondary`; the actions are `bg-surface-container-high text-on-surface`.
   The blanket card rule is *wanted* here, and both themes invert the tokens,
   so one markup works in light and dark. No `text-white` outside the art.

### Acceptance criteria

- Every id `jam.js`/`binders.js` paints still exists, exactly once, unchanged
  (`jam-ui.test.mjs` C-6/ADDED/LEGACY lists).
- No metadata element overlaps the artwork: `#np-title`'s box is **below**
  `#np-art`'s box.
- Light and dark: title/artist/telemetry read against the card (contrast is
  the theme's own `on-surface` on `surface-container-lowest`).
- The art card's own chips still compute `rgba(0,0,0,0.6)`.
- Streaming is untouched: this is markup/CSS only.
