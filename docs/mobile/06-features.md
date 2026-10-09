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

## Home greeting & search bay (2026-10-06)

Short version: the greeting card wasn't a greeting (static "Today" eyebrow,
no name, no date) and the search pill painted a double border. Now the hero
card greets by time of day + listener name (`mountHome` keeps painting the
first `h1` and the first `section span.uppercase`), and `#search-input` is
exempt from the global text-input border in both themes.

## Home redesign from mockup (2026-10-09)

Source: repo-root `open_music_mobile_home.html` + the user's screenshot
(light, monochrome, card rails with play bubbles). Scope: **home fragment +
home painters only** (`screens/home.html`, `binders.js` home section);
shared card helpers (`rowHTML`, `plCardHTML`, `artistCardHTML`) and every
other screen are untouched.

- Layout: greeting hero (time-of-day `h1` + date eyebrow + genre chips) →
  Jump Back In → Your Mixes → Featured Playlists → Top Artists → Genres &
  Moods → Favorites → New Releases → chart rows. The hero stays the **2nd**
  `section` (the spotlight painter indexes `sections[1]`); every shelf keeps
  its `data-shelf` key and heading text (`sectionFor`/`afterHead` match on
  those).
- Cards carry a play bubble, and it is honest: on **track** cards the tap
  plays via the existing `[data-list][data-idx]` delegation; on
  **playlist** cards the bubble carries `data-pl-play` (existing
  `playPlaylist` path); on **album/artist** cards the bubble navigates with
  the card (`entityNav`, no fake playback).
- Truthfulness (§8): no listener counts, no bitrates, no durations are
  shown unless the record carries them — counts are real list lengths
  ("N Tracks"), empty shelves hide instead of showing demo rows. The static
  fragment's demo copy is replaced on every paint exactly like before.
- Favorites shelf (new): Liked Songs / Downloads / Recently Played / My
  Playlists tiles with **real** counts, navigating to the existing
  screens. Genre tiles use the mockup's trance terms (each just searches
  the term, same as before).
- Colour (2026-10-10, user call): the mockup is monochrome, but all home
  art renders in full colour — the `grayscale` class is gone from the
  spotlight hero, the home card builders and the artist circles. Rows and
  shared cards were already colour.

## Now Playing redesign from mockup (2026-10-10)

Source: `nowplaying-screen-chatgpt.png`, `nowplaying-screen-jam-chatgpt.png`
(mono player + Up-Next sheet + Jam/Chat sheet) and repo-root
`open_music_now_playing.html`. Scope: **mobile Now Playing only**
(`screens/nowplaying.html`, `screens/nowplaying.js`, small `binders.js`
paints); desktop untouched, `jam.js` untouched.

- Every contract id stays: the whole `jam*` set, the legacy transport ids,
  `view-queue/chat/jam-data/lyrics`, `tabBar` + `data-tab` buttons,
  `switchTab` name/signature, `np-art` as the first `<img>` in `<main>`
  (binders paints it by position), the lyrics offset ids. `switchTab`'s
  active/idle class strings move to the mockup pill style in
  `screens/nowplaying.js`.
- Action row (Like/Lyrics/Queue/Chat/Jam) reuses existing paths, no new
  IPC: Like clicks `#favorite-btn`; Lyrics/Queue/Chat click the matching
  sheet tab (Chat keeps the unread-clear wiring); Jam clicks
  `#modeSocialTab` (in a room → Jam Data; Solo → social chrome + the
  create/join CTA). Queue badge reuses the existing `[data-queue-count]`
  paint.
- Honesty holds: no listener counts, no bitrates beyond the resolve's own
  `chosen_quality`; the sheet count is the real up-next length. Chat
  bubbles keep `jam.js`'s renderer; the Jam view keeps its stacked
  Session Info + members + leave (no fabricated sub-tabs).

## First-run onboarding flow (2026-10-10)

Three steps, one decision each, in `app.js` `onboard()` (runs once per
install, gates on `tm-onboarded`):

1. **Languages** — multi chips (All/Telugu/Hindi/Tamil/English), same
   `LANG_KEY` values as before.
2. **Artists** — only the picked languages' seed names, resolved live via
   `search_entities` + `artist_overview` and **sorted by the backend's own
   monthly-listener count** (missing data sorts last, never invented).
   Offline (or a lookup miss) still shows the name tile, selectable, with
   no image and no count. Picks save to `tm-taste` exactly like before
   (names, so `recommend.js` consumers don't change).
3. **Theme + name** — System/Light/Dark chips write `tm-theme` and apply
   immediately (same rule as the boot engine); the name writes `tm-name`,
   which the home greeting already reads.

## Android application name (2026-10-10)

Launcher + activity label is **OpenMusic**. `productName` stays
`OPEN MUSIC` (desktop bundles, updater artifacts and CI globs all derive
from it), so the rename rides the existing `build.sh` injector instead:
`inject_android_label` rewrites `app_name`/`main_activity_title` in
`gen/.../res/values/strings.xml` (gitignored, regenerated) on every
android build, same pattern as the INTERNET/CAMERA injection. The mobile
home header brand matches; desktop is untouched.

## Network status without notifications (2026-10-10, revised same day)

No banner text, no toasts, **no floating tile** — the state machine,
hysteresis and routing are unchanged; only the display layer and the
mode-change toasts are gone.

Revised after the user's *"i don't asked to create new button … use the
existing profile setting icon"*: the indicator **is** the existing header
profile avatar (the `person` glyph button that navigates to Settings).
`mobile/net.js` finds every `[data-nav="settings"]` button whose glyph is
`person` and fills its circle with the state colour:

| State | Fill |
|---|---|
| online | emerald `#10b981` |
| slow / reconnecting | amber `#f59e0b` (+ `net-pulse` breathing while reconnecting) |
| lost | red `#ef4444` |

The person glyph stays white on top; tapping still opens Settings. The
original `aria-label` is preserved and the state message is appended
(`"Settings — Online, solid connection"`), with the same text in `title`.
Repaint happens on every state change **and** on the router's `smount`
event (each screen rebuilds its header from its fragment, so a paint bound
only to state changes would lose the colour on navigation). The standalone
`#net-banner` element, its plug SVG and its fixed positioning are removed;
only the `net-pulse` keyframes remain (now keyed on the class alone).

Behaviour is unit-covered by the classifier tests; the avatar fill itself
is asserted live, not in `npm test`.

## UI polish batch (2026-10-10) — skeleton, transitions, micro-interactions

### Home loading skeleton

Home's four network shelves (`jump`, `charts`, `curated`, `artists`, `qp`)
render their headers immediately but their rails stay empty while
`home_feed` resolves — the empty-box look. Each rail now carries
`[data-skel]` shimmer blocks (square cards for album rails, circles for
artists, rows for Quick Picks) sized like the real cards. Painters replace
them by `innerHTML` overwrite; the two early-return paths in `mountHome`
(`!invoke`, `!feed`) call `clearSkeletons()` so nothing shimmers forever
offline. Shimmer is a background-position sweep, disabled under
`prefers-reduced-motion`.

### Screen-to-screen transition

`router.js paint()` wraps the fragment in `.screen-anim` and restarts a
`screen-enter` keyframe (opacity 0→1 + 8px rise, 260ms ease-out). The
wrapper is a plain div — `fixed` headers inside it stay viewport-anchored
(paint always runs right after `scrollTo(0,0)`), and the bottom tab bar is
appended *outside* the wrapper so it never moves. Reduced-motion: fade
only.

### Micro-interactions

Global rule on `#screen button` (plus onboarding/sheet surfaces): every
button gets a 140ms transition across transform/background/color/border/
shadow/opacity and `:active { transform: scale(.96) }`. Id-selector
specificity means it layers over — not against — the existing Tailwind
`active:scale-90/95` classes; disabled buttons are excluded.

## Now Playing artwork fidelity (2026-10-10)

Art is already the max JioSaavn rendition: `jiosaavn.rs image_url` picks
the largest entry of the `[{quality,url}]` array, `upgrade_image` rewrites
`150x150` → `500x500`, and mobile `paintArt → hqArt` does the same on the
client (`shared.js ART_RENDS`). The NP card therefore gets 500×500 — the
ceiling the CDN serves. What was missing was *presentation*: `#np-art` now
ships a deeper layered shadow + hairline ring so the cover reads as a
physical card (Spotify-style) instead of a flat image, verified against
`naturalWidth` on the device.

## Chat entry from the action row (2026-10-10)

User report: *"chat and jam ui is missing"*. Root cause: the Chat pill
(`#chatTabBtn`) only exists in Social mode (`jam.js paintJam` unhides it
when `social = inRoom || socialChrome`), but the NP action row's Chat
button clicked it unconditionally — in Solo the click landed on a
`display:none` element and `paintJam` immediately bounced the sheet back to
the queue, so nothing appeared. Fix: the Chat action enters Social first
(same `#modeSocialTab` path the Jam action uses) *before* clicking the
pill. The Jam action was already correct.

## Home rail scroll feel (2026-10-10)

Home shelf rails use `scroll-snap-type: x proximity` so a fling pages
through cards instead of flying past them (`mobile/index.html`). Native
vertical page scroll is untouched.

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

## Now Playing clean art + miniplayer truncation (2026-10-10)

User: *"remove tags on nowplaying screen like 320kbps, room status (solo,
room queue etc), remove that black shade and make it complete HD"* + a
screenshot of the miniplayer with the long title bleeding over the artwork.

### Clean art (mobile Now Playing only, desktop untouched)

- The artwork card (`#np-art-card`) is now **art only**: the gradient scrim
  (`from-black/40 … to-black/60`) is deleted, and with it the two overlay
  pills it existed to carry — the `[data-badge]` quality chip (top-left) and
  the `#artworkCollabTag` SOLO/room chip (top-right).
- The `#np-quality` pill beside the title is deleted too (same number the
  badge showed; the telemetry strip was already hidden utility spans).
- "Complete HD" is presentation, not a new fetch: `paintArt → hqArt` already
  resolves the max 500×500 CDN rendition (`shared.js ART_RENDS`), so the
  cover now renders full-bleed `object-cover` with nothing painted over it.
- Painters are untouched and null-safe (`jam.js setText`, `binders.js
  setTxt` both no-op on a missing node), so if the chips ever return the
  paint resumes. `jam-ui.test.mjs` C-6 drops `artworkCollabTag` with a note.
- Out of scope on purpose: `queueHeaderLabel` ("ROOM QUEUE"/"HOST'S QUEUE")
  is a section label inside the queue tab, not an artwork tag — it stays,
  and the live harnesses still assert it.

### Miniplayer title bleed (root cause, measured from the screenshot)

The widget title (`#tm-w-title`) carries `.tm-marquee` when it overflows:
`display:inline-block + overflow:visible + translateX(-50%)` on the text
element itself, while the text wrapper (`div[data-w-open]`) has no clipping.
The scrolling title therefore paints outside its own box — over the artwork
(the "Ram…nte Pattukora" glyphs starting *under* the cover in the shot).
Fix is clipping, not a new scroller: the wrapper gets `overflow-hidden`
(`app.js ensureWidget`) and `.tm-marquee` drops `overflow:visible` for
`overflow:hidden`, so the loop scrolls *inside* its box. Static titles keep
`truncate` ellipsis.

### Avatar fill, still open from the polish batch (root-caused, fixed here)

The emerald fill never rendered: `paintAvatar` set an inline
`backgroundColor`, but the light theme paints
`html:not(.dark) button.bg-surface-container-low` with
`background: linear-gradient(…) !important` (and the dark theme has the same
rule) — stylesheet `!important` beats an inline non-important style, and the
shorthand also resets `background-color` to transparent, which is exactly the
`rgba(0,0,0,0)` the probe measured. Fix: `net.js` now paints
`data-net-state` + a `--tm-net-fill` var, and `index.html` carries
`html body button[data-nav="settings"][data-net-state]` rules
(`(0,2,3)` beats the themes' `(0,2,2)`, later in the file, `!important`) with
a white glyph on top.

### Logo / icon / splash

No replacement asset shipped with the request (the only attachment is the
miniplayer screenshot), so brand files are untouched this pass:
`logo.png` stays the mark crop (contract v2, `logo-fallback.test.mjs`
green), launcher icons stay generated from `icons/icon.png`, and there is no
splash screen configured in this app to swap. Send the mark and all three
get cut from it in one pass.
