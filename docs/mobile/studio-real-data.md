# Studio shell: real backend data (spec)

Status: implemented and live-verified 2026-11-21b. Owner: this session.

> As-built (2026-11-21b): the plan below is now implemented. Two additions
> beyond the original design, both forced by real payload shapes:
> 1. **Search has its own result state** (`store.searchState`). Merging hits
>    into the whole catalog was not enough: the Search screen filtered the
>    entire catalog locally, so a result page looked like a catalog dump and
>    stale hits never left. Search now renders exactly what the four
>    commands answered (with a stale-answer sequence guard).
> 2. **Derived album/artist cards.** `Track.album_id` / `artist_ids[0]` are
>    numeric ids, while `album_tracks` / `artist_tracks` need the perma-url
>    *token*. Tapping an album or artist from a track therefore resolves the
>    token through `search_entities` (folded-title match) before fetching.
>    Derived cards are created from the track row so a tap can never open a
>    different album/artist (the old `albums[0]`/`artists[0]` fallback did).

## Problem

The visible mobile shell is the **studio** SPA (`app/src/mobile/studio/*`).
It boots from 978 lines of hardcoded demo data (`data.js` → `ARTISTS`,
`ALBUMS`, `TRACKS`, `INITIAL_PLAYLISTS`, `INITIAL_HISTORY`,
`INITIAL_NOTIFICATIONS`), so Home, Library, Charts, Now Playing and the
mini-player show invented content ("Midnight City Lights", "Solaris &
Kaelen", "Alex Mercer"). Only two backend paths existed:

| Path | State before |
|---|---|
| `search_songs` | worked, but results were appended to the demo catalog |
| `resolve_song` | worked once a row was tapped |
| `home_feed` | called, but read `feed.trending`/`feed.songs` — keys that do not exist — and **appended** instead of replacing |
| `list_downloads` | treated as an array; the command returns `{dir, entries}` |
| `search_entities` | called without `kind`, so the backend rejected every call (album/artist/playlist tabs empty) |
| history / liked | never read from the SQLite store (`store_recent`, `store_favs`) |

## Goal

Every catalog surface renders what the backend actually returned, and a tap
plays real audio. No invented content once the backend has answered.

## Contract (verified payload shapes, 2026-11-21)

- `home_feed` → `{spotlight, playlists[], charts[], chart_id, top_tracks[],
  albums[], artists[], daily[]}`; `FeedItem = {id,title,subtitle,image,count,year,token,language}`;
  `top_tracks` = `Track {id,title,artist,album,duration_secs,duration,image,...}`.
- `list_downloads` → `{dir, entries[]}`; entry = `{id,title,artist,album,image,duration_secs,quality,path,bytes,at,sha256}`.
- `store_recent` / `store_favs` → `SongRow {id,title,artist,album,image,duration_secs,data,play_count,is_fav,...}`.
- `playlist_tracks {id}` → `Track[]`; `album_tracks {token}` → `Track[]`;
  `artist_tracks {token,page}` → `{tracks[], page_full}`.
- `search_entities {kind, query, limit, page}` with `kind ∈ album|artist|playlist`.

## Design

Implementation map (2026-11-21b): `data.js` (`mapUpstreamSongToTrack` now keeps
`year`/`label`/`language`/`album_id`/`artist_ids`, `mapFeedAlbum` fills
`releaseType`/`releaseDate`/`description`, plus `foldName`, `qualityTier`,
`toStoreTrack`), `store.js` (`hydrateRealData`, `ensurePlaylistTracks`,
`ensureAlbumTracks`, `ensureArtistTracks`, `searchState`, `playPlaylist`,
`playArtistRadio`), `screens.js` (search renders `searchState`, empty-state
guards), `app.js` (action wiring).

1. **Hydration replaces demo data** (`store.hydrateRealData()`, once at boot):
   - feed `top_tracks` → `store.tracks` (real, `chartRank` 1..n so the Charts
     screen has a real ranking);
   - `spotlight + playlists + daily` → curated playlists (`curated:true`,
     `trackCount` from `count`, `trackIds` empty until opened);
   - `charts` → curated playlists flagged `isChart`;
   - `albums` / `artists` → mapped album/artist cards with `token` kept;
   - `list_downloads.entries` → vault tracks + `downloadedTrackIds`;
   - `store_recent` → `history`; `store_favs` → `likedTrackIds`;
   - demo-only state is cleared: fake recent searches, notifications, Jam
     chat, followed artist ids; user-created playlists are kept.
   - On failure the demo arrays stay (offline first boot) — never a blank
     screen from a transient network error.
2. **Lazy entity loading** when a route/action needs tracks:
   `ensurePlaylistTracks`, `ensureAlbumTracks`, `ensureArtistTracks` call the
   matching command once, merge into the catalog, fill `trackIds`, emit.
   Hooked into `navigate()` (playlist/album/artist) and the
   `play-playlist` / `shuffle-playlist` actions.
3. **Search entities fixed**: one call per kind, merged into the entity tabs.
4. **Screens tolerate real data**: playlist cards show `trackCount` when the
   track list is not loaded yet; Home's spotlight is optional.

## Acceptance

- Home shows real chart/playlist/album/artist names from `home_feed`.
- Tapping a real search row plays audio through the relay (already proven).
- Tapping a curated playlist loads `playlist_tracks` and starts playback.
- Opening an album/artist loads its tracks.
- Search's Albums/Artists/Playlists tabs return results (no `kind` rejection).
- No JS exceptions during boot, navigation, search, playback.

## Detail metadata strips, share chooser, download status (2026-11-21h)

- **Album / artist / playlist metadata strips removed**: the album
  `album-specs-strip` (`MASTERING / IMPRINT / RELEASED / RUNTIME`), the
  artist `artist-stats-bar` (`LISTENERS / IMPRINT / CATALOG`) and the
  playlist's curator eyebrow are gone from the detail heroes. Titles,
  artwork, actions and track lists stay.
- **Share opens the system chooser**: `shareLink()` now posts through
  `window.TMNative.share(text)` (Android `ACTION_SEND` chooser, from
  `TmBridge`); the browser `navigator.share` and clipboard remain as
  fallbacks, so desktop and the no-bridge case still work.
- **Download status per song**: the Downloads list passes `statusTag:
  "DOWNLOADED"` to `renderTrackRow`, which paints the same `tag-mono` pill
  used for `OFFLINE`/`HI-RES`; in-transit rows already carried their
  percentage/paused state.

## Library mock albums, Downloads header, filter search boxes (2026-11-21g)

| Ask | Cause / change |
|---|---|
| Remove mock data from Library | Hydration replaced feed albums but kept every prior album that was not in the feed, so the demo cards (`Monolith Sessions`, …) stayed in the catalog and Library listed them. Only **derived** albums (built from a real track row) are kept now; demo albums are dropped on the first successful `home_feed`. |
| Remove the block shown on Downloads | The `detail-hero` (`VAULT 02 · LOCAL LOSSLESS STORAGE`, `Downloaded Songs`, the cached-locally sentence, the `0 masters · 0.0 MB stored` line) and the three `stat-grid` cards painted live totals (always zero on a fresh install). Both are removed; the top bar, in-transit list, filters and track list stay. |
| Filter search boxes like Search | The Liked/Playlist/Album filters used `search-box-pill` while the legacy shell still paints every `input[type=text]` with its own border/background — the exemption list only carried `#search-main-input` and `#library-search-input`, so those fields drew an inner rectangle (divider + square left edge). Both theme blocks now exempt `#liked-filter-input`, `#playlist-filter-input` and `#album-filter-input`, and the three boxes use the same `search-box` markup as the Search screen, including a clear button. |

## Playlist/album/chart track lists (2026-11-21e)

Three defects made real track lists look empty or truncated. All three were
reproduced on `Pixel6_API36` over CDP before changing anything.

| Surface | Symptom | Cause |
|---|---|---|
| Playlist detail | loaded 56 tracks, painted **2** rows and "No matching tracks" | `ui.playlistFilter` defaulted to the literal `"all"`; the screen uses that value as a **title/artist substring filter**, so every row without "all" in its name was dropped |
| Album detail | same filter behaviour on `ui.albumFilter` (`"all"`) | identical cause |
| Charts | "Full Ranking" listed only **5** rows although the chart declares 50 | hydration keeps only `home_feed.top_tracks` (the five countdown rows) and never fetches the chart playlist itself |

Fixes: both text filters default to `''` (an empty box), and the chart's own
playlist is loaded lazily through the existing `playlist_tracks` path
(`store.ensureChartTracks()`, called by `navigate('charts')`); the Charts
screen ranks `store.chartTrackIds` when the chart is loaded and falls back to
the five `chartRank` rows while it loads or if the fetch fails. The
`chartsTab` default now matches a real tab (`Global Top 10`) instead of the
unused `global` key.

Streaming is unchanged: rows keep their `play-track` action and queue, so a
tap resolves through `resolve_song` exactly as search rows do.

## Latency + resilience pass (2026-11-21d)

Measured on the device before changing anything: a cold tap reached audible
audio in **1.75 s / 1.96 s / 2.82 s** for three tracks, and a list of 52 px
thumbnails pulled **~6–58 KB each** because every tile asked the CDN for the
`-500x500` rendition (Believer: 34 981 B at 500 px vs 6 134 B at 150 px).

### 1. Thumbnails are requested at the size they are painted

`artVariant(url, px)` rewrites JioSaavn's `-<n>x<n>.jpg` suffix and never
upscales. When a call site passes a `size` (rows, avatars, mini player),
`renderArtwork` emits `src` = 150 px plus `srcset="150w, 500w"` with
`sizes="<size>"`, so the browser picks by layout × DPR instead of always
downloading half a megapixel. Editorial art (no size suffix) is untouched.

### 2. Playback: resolve once, prefetch the next

`resolve_song` is the dominating cost of a cold start (it is an upstream
lookup, not a relay call — the relay is loopback). The store now keeps:

- `_streamCache` — `id|tier → { url, quality, at }`, TTL 6 h, capped at 300
  entries, so replays and back-navigation need no backend call.
- `_streamInflight` — single-flight: a double tap resolves once.
- `_prefetchNext()` — 1.2 s after playback starts, the next queue item's
  stream is resolved in the background and stamped on the track, so *Next*
  and auto-advance skip the resolve entirely.
- a **stale guard**: every play bumps `trackChangeSeq`; a resolve that lands
  after the user picked another track is discarded instead of hijacking
  playback.

### 3. Errors are reported, never faked

- A real stream failure no longer falls back to the demo synthesizer (the
  sequencer is only for the no-backend demo). The media element reports
  through `audioEngine.onError`.
- `resolve_song` gets two attempts with a 150 ms backoff; the copy then
  distinguishes *offline* from *track unavailable* instead of a generic
  message, and the player stops honestly.
- A media-element error triggers one forced re-resolve (fresh CDN URL) before
  the toast, because a resolved URL can expire while the app is open.
- Hydration retries once, then reports through a toast rather than a silent
  console warning.

### 4. Observability

`store.perf` counts `resolves`, `cacheHits`, `prefetches`, `failures`; the
verification below reads it, so a regression in the cache shows up as a
number rather than a feeling.

## Artwork loading: the sleeve that never yields to the cover (2026-11-21c)

Two separate defects made tiles look like they had no artwork. Both were
measured on device (CDP), not guessed.

**1 — the `is-loaded` race (the big one).** `.artwork img` starts at
`opacity: 0` and only becomes visible when it carries `.is-loaded`, which was
added by a single `window` **capture** listener for `load` plus a post-render
`hydrateArtworkLoadStates()` check for `complete` images. A re-render builds
the new markup as a detached fragment; a cached image can finish loading
there, where the window listener never sees the event, and if it was still in
flight when the post-render check ran the class was never added again. The
tile then painted its gradient sleeve over fully downloaded artwork — the
search list showed `BE` sleeves for *Believer* while
`naturalWidth === 500, complete === true, opacity === 0`.

Fix: `hydrateArtworkLoadStates()` now marks `complete` images immediately and
wires `load` / `error` **on each element** (once) for anything still in
flight, so the class no longer depends on a global listener that can miss a
detached node. `markArtworkLoaded` / `markArtworkFailed` are shared by both
paths.

**2 — a stock avatar the CSP refuses.** Artists with no photo come back from
the catalogue as `https://www.jiosaavn.com/_i/3.0/artist-default-music.png`.
The Android CSP allows `*.saavncdn.com` only, so every one of those was
blocked (`Refused to load the image … violates … img-src`) and wasted a
request. `renderArtwork` now normalises those placeholder URLs to an empty
source, so the tile shows the app's own branded sleeve instead. The CSP stays
strict (no new image host).

Verification: after the fix the search screen painted the real covers and the
CSP log had no image violations.

## Verification record (2026-11-21b)

Live on `Pixel6_API36` with the real Rust backend (debug APK rebuilt and
installed; CDP probes over `webview_devtools_remote`):

| Check | Result |
|---|---|
| Boot + hydration | 23 real tracks, 0 demo titles left, 42 curated playlists, 43 albums, 48 artists |
| Home shelves | first backend shelf title painted in the DOM |
| Search (typed + chips) | `believer` → 8 tracks / 12 albums / 12 artists; `romantic hits` → 12 playlists; a new query advances `searchState.seq` and discards the previous answer |
| Search row click | plays `Kesariya` from `http://127.0.0.1:<port>/stream?id=…&q=320kbps`, `readyState 4` |
| Audibility (meter, not playhead) | analyser peak 212 with `AudioContext` running while the relay stream is the source |
| Curated playlist | first open loads 98 tracks; its Play button starts them |
| Album detail | derived album resolves token `jIDs9OxbHyE_` and loads 5 real tracks |
| Artist detail | `Arijit Singh` loads 45 real tracks |
| Lyrics | 45 timed lines for *Tum Hi Ho* (`synced` pairs mapped) |
| Every route | home/search/library/charts/albums/artists/playlists/liked/downloads/history/analytics/notifications/settings all render |
| Exceptions | 0 uncaught during the sweeps |

Static gates: `node --check` and `eslint` clean on the four studio files;
`tests/imports.test.mjs` + `tests/mobile-boot.test.mjs` 4/4.

Known limit: once, while an external input was delivered to the emulator, a
stray tap hit the mini-player and paused playback. Instrumenting
`togglePlay`/`pause` showed no self-pause path; an untouched run kept playing
(28 s and advancing).

## Search pill, mini-player seek bar, artist artwork (2026-11-21e)

Three reported defects in the studio shell. All are presentation/data-contract
bugs; none changed the backend.

### 1 — The search bay drew a second rectangle

The legacy shell stylesheet (`app/src/mobile/shell.css`) forces
`border: 1px solid … !important` on every `input[type="text"]` in light and
dark mode. The studio search bay is a pill whose *container* owns the chrome,
so the forced border painted a sharp box inside the rounded field. Both studio
search fields (`#search-main-input`, `#library-search-input`) joined the
existing exemption list (`#search-input`, `.bay-input`), which is the same fix
the 2026-10-06 Downloads bay needed.

### 2 — Mini-player seek bar moved to the card's top edge

The bar is now the first child of `.mini-player` (3 px, top corners matched to
the card radius) instead of sitting under the track row, so progress reads at a
glance and the row keeps its full height.

### 3 — Artist thumbnails, three distinct causes

| Cause | Evidence | Fix |
|---|---|---|
| Seeded demo artists store an opaque id in `avatar`/`banner` (design-mock placeholders, not URLs) | the Artists grid rendered tiles whose `img.currentSrc` was empty and showed the browser's broken-image icon | `isUsableImageSrc()` gates every source inside `normalizeArtworkSrc()`; a value a browser cannot fetch renders the branded sleeve instead of an `<img>`. Seeded artist rows are also dropped once `home_feed` supplies real artists (same rule already used for curated playlists) |
| An image that finishes loading **while still detached** was only classified on success | `hydrateArtworkLoadStates()` tested `complete && naturalWidth > 0` and otherwise wired a listener an already-errored image never fires again | `complete` is now split: loaded → `.is-loaded`, failed (`naturalWidth === 0`) → the sleeve, so a dead URL never leaves the broken-image glyph on a tile |
| Artists derived from a track (`_ensureArtistFor`) used the **track's cover** as the portrait — film posters and album art as faces | e.g. *The Rish* wearing the *Saiyaara* poster, *Mithoon* twice with two different film stills | `store.resolveArtistArtwork()` asks the catalogue for the artist entity by name (`search_entities kind=artist`) and swaps in the real portrait plus its token. Bounded (pool 3, 48 artists per pass), cached by name in `tm-artist-art-v1` via `artresolve.js`, and triggered after hydration and when the Artists/Library listings open. A miss keeps the cover stand-in — honest, not a broken tile |

### Verification (live, `Pixel6_API36`, debug APK rebuilt + installed)

| Check | Result |
|---|---|
| Search bay chrome | input `border: 0px none`, background transparent, `box-shadow: none`; the pill carries the only border (`0.76px solid`, radius 16 px) |
| Mini-player bar | `.mini-progress` is the card's first element child, 3 px tall, sits above `.mini-body`, spans the card width |
| Artist sources | 0 `<img>` with a non-fetchable `src` anywhere in the shell (was 13 seeded rows + any junk upstream value) |
| Artist portraits | 46 of 50 artists paint a real `c.saavncdn.com/artists/…` portrait (was 20); *The Rish*, *Mithoon*, *Vishal Mishra*, *Lata Mangeshkar* previously showed film posters and now show the artist |
| Failed images | 0 broken-image glyphs on screen (dead URLs are classified as failed and fall back to the sleeve) |
| Seeded demo rows | dropped once `home_feed` answers (0 remain; 13 before) |
| Gates | `node --check` + `eslint` clean on the four studio files and `artresolve.js`; `tests/mobile-boot.test.mjs` + `tests/imports.test.mjs` 4/4 |

Limits: two artists are genuine catalogue misses (`needsArt` stays true, the
track cover remains), and portrait resolution is attempted once per artist per
app session, so a transient upstream failure keeps the stand-in until relaunch.

### Duplicate artist cards (2026-11-21f)

The artists grid listed the same person twice, because the two id spaces never
agreed: a track carries the numeric id its row was tagged with
(`artist_ids[0]`), while the catalog's artist card arrives under its own id
(`search_entities` / `home_feed`). Same name, two cards, sometimes two
different portraits.

Fixed in `store.js` with one canonical key and two entry points:

| Piece | Behaviour |
|---|---|
| `_artistNameKey` | lower-cases, folds `&` → `and`, collapses everything non-alphanumeric — so `Pritam`, `PRITAM ` and `Pritam & Co.` compare predictably |
| `_ensureArtistFor` | before minting a derived card, an existing card with the same key is reused and the **track is repointed** to its id — duplicates are no longer created in the first place |
| `_dedupeArtists` | runs after `home_feed` artists and after chart tracks: groups by key, keeps the richer card (`_artistRank`: real catalog card > token > real `/artists/` portrait > bio), fills its gaps from the dropped one (`_absorbArtist`: token, bio, origin, portrait, verified…), rewrites every `track.artistId` and `followedArtistIds` that pointed at the dropped id, and remembers the old id in `_artistAlias` |
| `getArtistById` | resolves through `_artistAlias`, so a deep link or a stale track id still opens the surviving card |
| search artists | reuse by id **or** name and absorb the catalog's token/portrait instead of pushing a second card |

Verified on `Pixel6_API36`: 36 cards, **36 unique names**, 0 broken images,
0 track artist ids without a card. The merge path was proved separately by
pushing a synthetic duplicate (`'PRITAM '` under a new id) and calling
`_dedupeArtists()`: array length unchanged, 1 alias created, the track that
referenced the dropped id repointed to the surviving card, and
`getArtistById('dup-test-id')` resolved to it — then force-stopped and
relaunched to leave the store clean.

Limit: two *different* people who genuinely share an exact name are also
merged into one card (indistinguishable in the UI anyway); an artist whose
catalog spelling differs by more than case/punctuation (a legal-name alias such
as "Abel Tesfaye" ↔ "The Weeknd") is not merged.

#### Artist detail after the merge (live check)

Opening the merged *Pritam* card (`artist-pritam`, 49 → 50 tracks from the
feed): hero shows the real catalogue portrait
(`c.saavncdn.com/artists/Pritam_Chakraborty-…_500x500.jpg`, `naturalWidth > 0`)
in both the avatar and the panoramic banner; the popular list renders one row
per track; **Play** queues the artist's tracks and streams (`Kesariya`,
`readyState 4`, playhead advancing, `paused:false`); **Follow** flips to
`check Following` + primary style and writes the id into
`openmusic_vanilla_v1.followedArtistIds`, flipping back off again. Only one
card exists for the name and every track's `artistId` resolves to it.

Two blank-meta defects the check surfaced, fixed in the same pass: the hero
line rendered a trailing `·` with an empty origin, and the stats bar drew
LISTENERS / IMPRINT cells with empty values (the catalogue publishes neither
for artist entities — `official.rs` notes artists carry no sub-line). Both
cells are now omitted unless they have a value, and the separator is only drawn
between present parts.

## Search UX, library playlists, download integrity (2026-11-21i)

User-reported batch on the Studio shell. Most scaffolding already existed
(`search_suggestions` + dropdown, `recentSearches`, NP drag-down, bulk sync
buttons); this pass closes the gaps that made them feel broken.

| Ask | Change |
|---|---|
| Suggestions while typing | Already wired (`fetchSuggestions` → `search_suggestions`, 220 ms debounce). Fixed the stale case: **Clear search** now also clears `searchSuggestions`, and **Enter** in `#search-main-input` commits via `applySearch` (records the recent search + runs `searchLive`). Tapping an album/artist/playlist result from the Search route records the query in `recentSearches`, same as playing a song already did. |
| Recently searched below the box | Already rendered as the `recent-searches-subbar` + the "Recent Searches" section; persistence via `persist()`. No markup change needed. |
| Now Playing drag-down → miniplayer | Already implemented (`touchstart/move/end` on `.np-wrap`, >65 px dismisses through `store.goBack()` to the previous route, where the mobile chrome miniplayer lives). Verified the gesture surface: draggable areas exclude inputs, buttons, sliders and lyric lines only. |
| Mock playlist data in Library | `renderPlaylistsBrowser` "Yours" tab fell back to `store.playlists` when no user playlist existed — after hydration that list is the curated feed, so demo/curated cards posed as "Yours". Fallback removed; the tab now shows an empty state. Library's Playlists chip already filtered `isUserCreated`. |
| Downloads failing + status + parallel | `queueDownload` sent **both** `onProgress` and `on_progress` for the same Channel — dropped the duplicate; the Channel now comes from `__TAURI__.core.Channel` with a dynamic `../../core.js` fallback (the vendored ordered-buffer implementation), matching desktop `vault.js`. Failures no longer vanish: the row stays in "In Transit" with a `FAILED` tag, the backend's error line, **Retry** and **Dismiss** (`dismissDownload`). `isDownloading` ignores failed rows so retry/bulk re-queue works. Pause/Resume and the in-transit close button are now real: pause → `pause_download` (keeps the `.part` prefix), resume → fresh `download_song` (backend resumes the prefix), cancel → `cancel_download`. Parallel bulk (`queueBulkDownloads`, `downloadAllParallel`, "Parallel Bulk Sync" / "Sync Top 8" / per-list Sync) unchanged — it rides the fixed single-download path. |

## Language facets, liked reorder, toast placement, real analytics, dark NP, slimmer nav (2026-11-21j)

| Ask | Change |
|---|---|
| Genre/language fields = Telugu, Hindi, Tamil, English, Malayalam, Bhojpuri | The Home/Search `GENRE_CARDS` already carry exactly these six "X Songs" queries. The Settings "Music Languages" chip row still offered Swedish/German/Japanese/Instrumental — `allLangs` now lists the six catalog languages and `DEFAULT_SETTINGS.languages` drops `Instrumental`. |
| Drag to reorder at relevant places | Queue rows (NP "UP NEXT") and user-playlist rows already drag (`data-drag-type="queue"/"playlist"`, HTML5 + touch paths in `app.js`). Added the missing user-ordered surface: **Liked Songs** rows are draggable (`data-drag-type="liked"`), reordering `likedTrackIds` via `store.reorderLiked()`; disabled while the filter box is active so visible indices can't mis-map. |
| Toast at bottom | `.toast-root` moves from `top: 66px` to `bottom` above the mobile chrome (miniplayer + tab bar); entrance keyframes flip to rise-from-below. |
| Analytics on real data | `renderAnalyticsScreen` no longer multiplies history by 1/4.2/18.5 or hardcodes `84%` / `Q1–Q4` / "Progressive Trance". Period (Week/Month/Year) filters `store.history` by rolling windows; exposure, plays, unique tracks, HI-RES ratio (listened-sec share of `hiRes` tracks), the rhythm chart (weekday / 4-week / 12-month buckets from `playedAt`+`listenedSec`), top artists (no `240`s fallback), signature genre, and peak listening window are all computed. `analyticsPeriod` default `'30d'` didn't match any segment — now `'Week'`. Empty history renders an honest empty state. |
| Dark theme — Home & Now Playing | The NP screen was hard-forced to `#FFFFFF` for *every* theme (`body[data-screen="nowplaying"] … !important` block). All those overrides are now scoped to `html:not(.dark)` so dark mode falls back to the token palette; a `.dark` NP block restores the intended dark surfaces (backdrop, sheet, queue rows, transport). Home gets matching dark polish on the hero/spotlight card and genre grid. |
| Shorter top & bottom nav | `.topbar-inner` 56→48px; `.mobile-tabs` min-height 64→52px, `.mobile-tab` 50→44px, `.mobile-tab-pill` 56×30→48×26, tighter paddings. |
