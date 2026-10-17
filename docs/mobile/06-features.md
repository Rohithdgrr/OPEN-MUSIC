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

### Home mix rows: full carousel, not one card (2026-10-11)

`renderMadeForYou` (`mobile/binders.js`) registered the whole shelf via
`setList` but painted a single mix card into the `overflow-x-auto` rail —
every shelf (Daily/Monthly/On Repeat/Downloaded/Recently Played/…)
showed one tile. Contract: paint one `homeTrackCardHTML` per shelf track
(the existing `[data-list][data-idx]` delegation already plays through,
so no new path), keep the shelf header (title + tag + why-line). Shelf
`limit` stays 10 (recommend.js default 20) — "all songs" means the full
shelf list, not a longer query.

### Logo / icon / splash (earlier pass — superseded for Android, see branding guide 2026-10-11)

No replacement asset shipped with the request (the only attachment is the
miniplayer screenshot), so brand files are untouched this pass:
`logo.png` stays the mark crop (contract v2, `logo-fallback.test.mjs`
green), launcher icons stay generated from `icons/icon.png`, and there is no
splash screen configured in this app to swap. Send the mark and all three
get cut from it in one pass.

### Borderless input bays: Downloads search, queue-append, room chat (2026-10-15)

Scope: **mobile only** (`mobile/index.html` theme engine, `mobile/binders.js`
Downloads toolbar, `screens/nowplaying.html` sheet). Desktop untouched.

Root cause (same class as the 2026-10-06 search-pill fix): the global
`input[type="text"]` rules in **both** theme engines paint a bordered inset
box with `!important`, and only `#search-input` is exempt — so the Downloads
search (`data-dl-search`), the queue-append row (`jamAppendInput`) and the
room-chat row (`jamChatInput`) each drew a sharp inner rectangle inside their
own container (double border).

Contract: all three inputs carry a shared `bay-input` marker class, exempted
next to `#search-input` in both themes (input itself chromeless); each
**container** owns the chrome as a borderless rich rectangle
(`border-0`, solid surface bg, `rounded-2xl`, subtle shadow,
`focus-within` ring keeps the focus indicator). The chat pill
(`rounded-full`) becomes a rectangle and the send button grows from the
`w-7` icon dot to a `w-10 h-10 rounded-2xl` target. No id, placeholder,
disabled-state or delegation change — `jam.js` and the live probes address
these elements by id only.

### Lyrics full-view repair + karaoke stage, Gemini model swap, eyebrow removal (2026-10-15)

Scope: **mobile Now Playing only** (`screens/nowplaying.html`,
`screens/nowplaying.js`, `mobile/lyrics.js` untouched, `mobile/binders.js`
full-view toggle, `mobile/index.html` stage CSS, `mobile/ai-lyrics.js`
model). Desktop untouched (it makes no Gemini calls).

- **Gemini key "not working": the model was shut down, not the key.**
  `ai-lyrics.js` defaulted to `gemini-2.0-flash`, which Google shut down on
  2026-06-01 (deprecation notice 2026-02-18) — every AI-lyrics call 404'd no
  matter what key was pasted. Default is now the stable `gemini-2.5-flash`,
  and a 404 now throws "no such model — update the app" instead of a raw
  HTTP error so the next retirement reads clearly. Key storage is unchanged
  (Settings `change` → `tm-gemini-key` → toast; cache `tm-ai-lyrics`, 100
  tracks; AI lines always labeled, never overwrite real synced lyrics).
- **Full View did nothing.** The toggle seeks
  `closest("div.rounded-2xl, div.rounded-xl")`, but the sheet card has been
  `rounded-3xl` since the 2026-10-10 mockup redesign — `closest` returned
  null and the handler returned early. The selector now includes
  `div.rounded-3xl`, promoting the sheet card to the fixed
  `.tm-lyrics-full` stage (tab bar stays reachable; the button flips to
  Close). Trap closed: switching to any other tab exits the stage and resets
  the label (`switchTab` in `screens/nowplaying.js`), because the Close
  button lives in the lyrics view and a fullscreen sheet without it would
  strand the reader.
- **Word-by-word highlight: no new engine — the wipe already exists and is
  now reachable.** `lyrics.js` splits enhanced-LRC word tags, otherwise
  spreads each line's words evenly across the gap to the next line, and
  drives every word's fill through `--progress` on a ~15 Hz rAF clock (both
  themes carry the wipe gradient). Polish for the stage: the active line in
  full view gets a thicker bar + rounder pad so the current line reads at a
  glance at 28px. Honest limit, unchanged: plain/AI lyrics carry no stamps,
  so they render as static lines — karaoke needs synced lines.
- **NOW PLAYING eyebrow removed** from `screens/nowplaying.html` (dot +
  tracking-widest label row); the artwork section keeps `pt-3` rhythm. No
  contract id was inside the row. `jam-ui.test.mjs` pins no copy here.

### Artists home: mined Top Artists + full column browser (2026-10-15)

Scope: **mobile only** (`mobile/recommend.js` insight, new
`screens/artists.html`, `mobile/binders.js` shelf + mount, `router.js`
route). Desktop untouched. No new backend calls, no new permissions.

- **The mining already existed** — `buildProfile` weighs plays (log-scaled,
  14-day half-life decay) + likes (+3) + downloads (+2.5) + library (+2) per
  artist. New pure `artistInsights(profile, { follows })` projects that into
  per-artist cards: `{ name, weight, plays, liked, downloaded, following,
  token, image }`, ordered weight → plays → name. Art resolves from the
  artist's own most-played track image (real local rows); follows match by
  title/id and contribute their token + art. Tabs: All / Liked / Downloaded /
  Following (`filterArtists`). Unit-tested in `recommend.test.mjs`.
- **Artists chip opens the browser.** `data-home-cat="artists"` used to only
  filter shelves down to the 10-circle rail; now it goes to `#/artists` (new
  route, Library tab). The screen is a 3-column circle grid with an evidence
  line per tile ("12 plays", "3 liked · 5 downloaded", "Following").
- **Taps stay honest.** Tiles with a follow token navigate direct; every
  other tile reuses the global `[data-entity-name]` delegation
  (`resolveEntity` → `search_entities` → artist detail, offline toast when
  offline). No invented artist pages.
- **The home shelf shows YOUR artists.** The Top Artists rail repaints from
  the mined top 10 (same circles, plus a restored See-all → `#/artists`);
  the generic `feed.artists` rail remains the fresh-install fallback, and
  the empty browser states the recipe (play / like / download) instead of
  demo rows.
- **Same pattern for albums, playlists, charts — each ordered its own way.**
  Albums (`#/albums`) mine listening TIME (`duration × plays`) separately
  from frequency: tabs Top / Most time / Most played / Liked / Downloaded,
  tiles show art + `2h 14m · 34 plays`, taps resolve via the existing
  album search. Playlists (`#/playlists`) split by provenance, not taste —
  Yours (created/saved, newest first, offline marks) / Featured (feed order)
  / Downloaded; every row navigates or plays through the existing paths.
  Charts (`#/charts`) keep editorial rank untouched (re-ranking a chart by
  local logs would destroy what a chart is): full ranked list with numerals,
  counts and play bubbles. The home chips for all four now navigate instead
  of filtering shelves.
- **Latent data fix:** the `feat.` splitter dropped the abbreviation period
  and minted ". Guest" artists in the weights (and every mix downstream).
  One shared `leadArtists()` now splits `feat./ft.` with the period, used by
  the profile, the affinity scorer and the browsers.

### Home chips: restored strip + working selected state (2026-10-15b)

Scope: **mobile only** (`screens/home.html` markup, `mobile/binders.js`
wiring, `mobile/index.html` theme CSS). Desktop untouched.

Home keeps its original **flat seven-chip strip** (All, Charts, Playlists,
Albums, Artists, Genres, Heavy Rotation) with two verbs on the one strip:

- **Browse chips** (Charts / Playlists / Albums / Artists) open their mined
  browsers — `if (cat === "artists") return go("artists")`-style early
  returns in the chip handler (see "Mined collection browsers" above).
- **Shelf lenses** (All / Genres / Heavy Rotation) filter the shelves below
  in place.

History of the design, kept so nobody re-derives it: a same-day trial
replaced the four destination chips with a labeled 2×2 browse-tile grid
(invert squircle icons, live mined counts, chevron). It shipped and was
verified live, then **reverted on user call** — the flat strip is the
preferred look. The counts machinery (`paintBrowseCount`/`BROWSE_NOUNS`)
and `.browse-tile-icon` CSS were removed with it.

**The one change that survives is the selected-state fix.** The old active
toggle keyed `bg-on-surface`, but the theme CSS inverts on `.bg-primary`, so
in light theme the CSS `!important` override repainted the active chip white
too — the selected filter was invisible (measured on device 2026-10-15:
`All` = `linear-gradient(255,255,255 → 245,245,247)`, `color: rgb(71,70,75)`,
identical to every inactive chip). The handler now toggles `.bg-primary` (the
class the CSS was written for): obsidian pill + white text in light, white
pill + black text in dark.

- Contract gate: `app/tests/home-browse.test.mjs` pins the strip (7 chips in
  the old order, a navigate branch per browse chip, `.bg-primary` on the
  active pill, zero tile-grid leftovers in markup/handler/shell CSS).

### Now Playing artwork: frameless + glass coating (2026-10-15f)

Scope: **mobile only** (`screens/nowplaying.html` card classes,
`mobile/index.html` theme CSS). Desktop `.np-art-card` (`styles.css`) untouched.

The large artwork on Now Playing carried a visible dark frame from **two
sources**: (1) the markup asked for `border border-outline-variant/30` and
both theme blocks restated it — light drew a 1px border whose color blended
over the card's own near-black backing (`#1b1b1e`), plus a second 1px ring
(`0 0 0 1px rgba(0,0,0,.12)`); dark drew a `rgba(255,255,255,.1)` ring; and
(2) the shared "Image and Artwork Depth" rule
(`html:not(.dark) .aspect-square img`) put its own 1px
`rgba(0,0,0,.06)` border on the img — over the near-black backing that
composited to a dark ring too, and survived the card-level cleanup until the
pixel probe caught it.

Now:

- **No frame** — the card border classes and both ring restatements are gone,
  and the artwork img is excluded from the shared image border
  (`:not(#np-art)`); the tile is defined by its artwork alone.
- **Blended corners** — the hard 1px ring is replaced by a soft, large
  diffuse shadow (`0 24px 48px -20px` light / `-18px` dark), so the
  `rounded-3xl` corners melt into the page instead of sitting in a frame.
- **Thin glass coating** — `#np-art-card::after` paints a diagonal light
  sweep from the top-left (`rgba(255,255,255,.2)` → 0 by 38 %) plus a 1px
  specular line along the top edge (`inset 0 1px 0 rgba(255,255,255,.22)`).
  It is `pointer-events: none` (never intercepts touches), rides above the
  img, and applies in both themes so dark artwork also catches the light.

Contracts unchanged: `#np-art-card` remains the first/img-owning card (the
`binders.js` paint-by-position contract) and the overlay is a pure
pseudo-element — no DOM contract moves.

Verified in headless Chrome @412 px, both themes (screenshots
`np5-light.png` / `np5-dark.png` beside this session's probe notes): computed
card **and** img border `0 px`; the screenshot pixel scan shows artwork
reaching every edge — left/right/bottom strip minima luma 155-158 = art with
no dark pixel, corner-box minimum 156 = art (the pre-fix probe found the
1 px dark ring at luma 59-85); the sheen measures +18 luma at the top-left
over the bottom-left art, and the top-edge specular line reads 180 against
160 for the art below it.
