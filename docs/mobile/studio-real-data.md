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
