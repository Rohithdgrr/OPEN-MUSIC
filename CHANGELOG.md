# Changelog

Notable changes to OPEN MUSIC. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [SemVer](https://semver.org/spec/v2.0.0.html).

Platforms shipped: **Windows** (MSI + NSIS), **Linux** (deb + AppImage), **Android** (APK). macOS and iOS are not released as of v0.5.0.

## [Unreleased]

### Added & Fixed (Studio mobile UX — search, downloads, analytics, dark theme, nav)
- **Search UX**: live completion suggestions while typing (Enter commits), recent searches recorded for played songs *and* entity-result taps, stale suggestions cleared with the query.
- **Downloads fixed on Android**: `download_song` was invoked with both `onProgress` and `on_progress` for one Channel parameter — now sends a single `onProgress` channel (verified end-to-end on emulator: "Vaulted" + file in vault). Failures stay visible as `FAILED` rows with the backend error, Retry and Dismiss; pause/resume/cancel now hit `pause_download`/`cancel_download` for real; bulk parallel sync unchanged.
- **Library mock data**: Playlists "Yours" tab no longer falls back to curated feed cards; shows an empty state instead.
- **Drag reorder**: added to Liked Songs (id-based `reorderLiked`), joining queue and user-playlist rows.
- **Analytics on real telemetry**: exposure, plays, unique tracks, HI-RES ratio, rhythm chart, top artists, signature genre and peak window all computed from `store.history` — no more multipliers or hardcoded bars.
- **Dark theme**: Home and Now Playing were hard-forced to `#FFFFFF`; both are now scoped to light mode only, so dark mode renders the token palette (verified `rgb(14,15,17)` on device).
- **Toast & nav**: toasts moved to the bottom above the chrome; top bar 56→48px, bottom tabs 64→52px.
- **Music Languages** settings chips now offer the six catalog languages (English, Telugu, Hindi, Tamil, Malayalam, Bhojpuri).

### Added & Fixed (Branded icon, lockscreen/homescreen widget controls & seekbar, share drawer, downloads status)
- **Branded launcher & notification icon**: `sync-android-icons.mjs` runs on every build, syncing branded OpenMusic mipmaps into the Android resource root instead of falling back to default Tauri glyphs. Notification uses `R.drawable.tm_notif_icon` (monochrome vector) and fallback large icon uses `@mipmap/ic_launcher`.
- **Lockscreen & notification seekbar**: `MediaMetadata` now sets `METADATA_KEY_DURATION` so Android's lockscreen scrubber and system notification progress bars know the track duration and position. Seeking via lockscreen controls calls `deliver("SEEK_TO")` which dispatches instantly to the player.
- **Homescreen widget controls & layout**: Connected Studio to the native `TMNative` bridge via `window.__tmRemote` (`play`, `pause`, `toggle`, `next`, `prev`, `seekTo`, `stop`). All three transport buttons and tap-to-open now work reliably with responsive state updates. The progress bar renders horizontally across the widget bottom with live ticker progress.
- **Clean album, playlist, and artist headers**: Removed clutter description paragraphs, mock liner notes, and stats metadata (`LISTENERS`, `CATALOG`, `monthlyListeners`) from album, playlist, and artist screens.
- **Share drawer modal**: Tapping Share on any screen (album, playlist, artist, track menu) opens a dedicated bottom drawer with direct sharing options (WhatsApp, Telegram, X / Twitter, Email, SMS, System Share Sheet chooser, and Copy Link).
- **Downloads status**: Downloads screen now displays a verified download status summary bar (`X Songs Downloaded · Y MB · OFFLINE READY`) and tags each song with its download status (`DOWNLOADED`, `Saved offline`).

### Fixed (Android studio shell — library, Downloads, filter search boxes)
- Library no longer lists the design-mock albums (`Monolith Sessions`, …): hydration drops non-derived albums that are not in the feed, keeping only feed cards and albums derived from a real track row.
- Downloads drops the decorative hero (`VAULT 02 · LOCAL LOSSLESS STORAGE`, "Downloaded Songs", the cached-locally sentence, `0 masters · 0.0 MB stored`) and the three live-total stat cards, which always read zero on a fresh install. The top bar, filters and track list remain.
- The Liked Songs, playlist and album filter fields now look and behave like the Search screen: the same `search-box` chrome with a clear button, and the legacy shell no longer paints its own border/background into those inputs (that produced the divider and square left edge).

### Fixed (Android studio shell — playlist, album and chart track lists)
- Playlist and album detail no longer open on "No matching tracks": both in-page filter inputs defaulted to the literal `"all"`, which the screens used as a title/artist substring filter and dropped almost every real song. They now start empty, so a freshly opened list shows its full track set.
- Charts now lists the whole chart (50 tracks for the current global chart) instead of Home's five countdown rows: the shell remembers `home_feed.chart_id`, loads that playlist through `playlist_tracks` once, and ranks by its order. A failed load still falls back to the five `chartRank` rows.
- The Charts tab state defaults to a real tab (`Global Top 10`) rather than the unused `global` key.

### Fixed (Android studio shell — search bay, mini-player seek bar, artist artwork)
- Artist browser: one card per artist — a track id and a catalog id for the same person used to produce two tiles; cards now merge by folded name, keeping the richer one (real portrait, catalog token), repointing tracks/follows, and resolving the dropped id through an alias.
- The studio search field no longer draws a second rectangle inside its pill: the legacy shell rule that forces a border on every text input now exempts `#search-main-input` and `#library-search-input`, leaving the pill's own border and focus ring as the only chrome (light and dark).
- The mini-player's seek bar sits on the card's top edge instead of under the track row, so progress is readable at a glance without shrinking the row.
- Artist thumbnails: sources a browser cannot fetch (seeded design-mock ids) no longer paint the broken-image icon; an image that failed while it was still detached is now classified as failed and shows the sleeve instead of the glyph; and artist cards derived from a track resolve the catalogue's real portrait instead of reusing the track's cover (film posters and album art were used as faces). Portraits are cached by name and resolved in small background batches after hydration and when a listing opens.

### Fixed (Android studio shell — real catalog + real streaming)
- The studio shell hydrates from the backend instead of its demo catalog: `home_feed` fills Home/Charts, curated playlists load `playlist_tracks` on first open or Play, album/artist detail resolves the perma-url token and loads the real catalogue, and the Offline Vault reads `list_downloads.entries` (it is an object, not an array).
- Search runs the three entity searches with the required `kind` argument and renders its own result state, so results are exactly what upstream returned rather than a filtered dump of the whole catalog; typing and genre/recent-search chips both commit a real query (stale answers are discarded).
- Every track resolves through `resolve_song` at the selected tier and streams from the loopback relay. A failed resolve now stops honestly instead of starting the demo synthesizer, and lyrics read the backend's `synced` pairs (the command also requires `album` and `duration`).
- Artwork now paints on every tile: a cached image could finish loading while a re-render still held it in a detached fragment, where the window `load` listener never saw it, so the tile kept showing its placeholder sleeve over a fully downloaded cover. Each image is now checked for `complete` and wired individually. Artist rows no longer request JioSaavn's stock `artist-default` avatar (blocked by the Android CSP) and show the app's own sleeve instead.
- Likes and plays persist to the SQLite store (`store_fav` / `store_play`), so Liked Songs and Listening History survive a restart.

### Added (song video — decision plane, recogniser, live probe)
- **Track → video matching core** (`app/src/videomatch.js`, pure and DOM-free): builds the InnerTube query from a catalog track, parses search rows, scores candidates with a version penalty (karaoke/cover/sped-up/remix), classifies the artefact (official/lyric/visualizer/live), picks one progressive H.264 rendition under a height cap, and returns a cache policy plus provenance-carrying metadata. Nothing renders it yet; the transport and UI are specified in `docs/song-video.md`.
- **Local audio recogniser** (`app/src/fingerprint.js`): Shazam-style landmark hashing over an in-module FFT, with offset-aware matching. Measured at 1.5 ms of CPU per second of 8 kHz audio and ~6 k hashes per 30 s.
- **`npm run video:probe`**: runs the real decision path against the live upstream — search, rank, player, then a byte-range fetch of the chosen rendition — and exits 0 for an honest "no match" too. Verified `ready` for *Kesariya* (itag 136, `206`, 1024 B) and *Believer*, and `none` for a nonsense query.

### Added (song video — transport, relay, Android backdrop)
- **Rust InnerTube transport** (`app/src-tauri/src/video.rs`): the two P0-verified POSTs (WEB_REMIX song search, iOS player), mechanical response parsing that matches `videomatch.js`, a 30-minute resolved-URL cache, and a 6-hour learned video id so an expired link self-heals. Decisions (which video, which itag, whether to cache) stay in the JS matcher — the transport only forwards what upstream returned.
- **Loopback relay** `GET /video?id&itag&token`: the WebView never sees `googlevideo.com`. Hosts are allow-listed to `*.googlevideo.com` before every fetch and after redirects, `Range` is forwarded verbatim (206/416 pass through), and a 403/410 re-resolves once instead of failing the track.
- **`track_video` SQLite table** with `video_load`/`video_store`: a match costs one search per track, and a track with no video is negative-cached for 24 h — so a miss costs one search, not one per paint. Stream URLs are never persisted.
- **Android Now Playing video backdrop** (Settings → Playback & Audio → "Now Playing video", **off by default**): the video sits behind the artwork inside the existing art card, starts on `loadeddata` (never a black flash), loops muted, pauses with the audio, releases the decoder on screen exit, and is skipped on cellular data, with Data Saver, or when the OS asks for reduced motion. `app/src/videoplan.js` holds the gate + plan (pure), `mobile/videobackdrop.js` the DOM lifecycle.

### Added (Android mobile playlist import)
- Settings → Storage can import M3U, M3U8 and PLS files. Entries are matched against the supported catalog; arbitrary local paths and URLs from playlist files are never opened as media.

### Added (Android mobile playback)
- An opt-in Skip silence control skips sustained quiet audio through the existing analyser and leaves playback unchanged while paused, seeking, or buffering.

### Added (Android mobile Now Playing)
- A five-band equalizer with labeled, accessible sliders, persistent settings, and reset-to-flat. It applies to both playback chains without adding Settings toggles or changing desktop playback.

### Improved (Android mobile discovery)
- Search now retries transient first-page failures on a bounded schedule, keeps saved results visible, and recovers when connectivity returns. Endless radio falls back from an exhausted seed artist to Home-feed tracks and charts without reordering JioSaavn results.

### Changed (Android mobile visual system — 2026-11-14)
- The mobile shell now respects zoom and short viewports, aligns its fixed player and navigation to Android safe areas, and keeps content and toasts clear of both. Touch targets and keyboard focus are more legible, the mini-player seek control supports keyboard navigation, and Home shelf filters expose their selected state to assistive technology. Reduced-motion preferences remove tab/lyric movement while preserving color feedback, and the seek rail keeps a full-size hit area without a bulky visual track.
- Home's spotlight now uses accurate playlist wording, hides unsupported codec claims and unknown counts, and stays hidden until a playable playlist is available.

### Added (mobile listening surfaces + Android build hardening)
- **Now Playing visualizer:** a lightweight spectrum canvas reuses the active EQ audio graph and stops outside visible playback; its zero-gain analyser branch does not add an audible output path.
- **Jam room roster:** Home can show the current room's members while hosting or joined, and clears the section in Solo mode.
- **Yearly summary:** Analytics can summarize retained local play events by local calendar year, with coverage and playhead-estimate caveats.
- **Android frontend bundle and style-element CSP:** Android build targets bundle the mobile entry with esbuild, retain source fallback for development, and load extracted local shell CSS. The policy blocks inline style elements but intentionally still permits runtime style attributes.
- **Android share cards use the system image chooser.** The rendered PNG is validated, stored temporarily in app-private cache, and shared through a read-only content URI grant; no public-storage permission is needed. Web Share and text/clipboard fallbacks remain.
- **Smart playlists and track tags are available on mobile.** Create rule-based playlists for likes, play count, tags, or language; they resolve from the local song store when opened. Track menus can add, replace, or clear bounded tags, which survive cache clearing.

### Removed (mobile: Now Playing Canvas — 2026-11-14)
- **The Canvas feature is removed completely.** The renderer (`mobile/canvas.js`, `canvasmath.js`), its three Settings rows and wiring, the cinematic CSS, the `fetch_canvas` / `set_canvas_cookie` / `canvas_configured` commands, the `/canvas` relay route and its cache tier are gone. Now Playing shows album artwork only.

### Fixed (Android build — 2026-11-14)
- **The Android app could not compile.** `TmBridge.kt` carried two identical `saveLocal(json: String)` declarations (both committed), so Kotlin failed with `Conflicting overloads` and Gradle never produced an APK. The duplicate is removed; one declaration remains with the merged documentation (`docs/mobile/09-problems-solutions.md` P59).

### Fixed (mobile: the shell rendered with no connectivity — 2026-11-13)
- **Offline, the app showed raw icon names** (`chevron_right`, `favorite_border`, `more_vert`…) because the Material Symbols font came from a Google Fonts stylesheet that never loaded. The fonts are now **bundled** (`app/src/fonts/`) and loaded same-origin, and the mobile CSP drops the two Google Fonts origins. The shell boots and renders with the radio off.
- **"Share" now opens the real Android share sheet.** The action used `navigator.share`, which the Android WebView does not implement — so a tap silently degraded to "copied to clipboard". A native bridge (`TmBridge.share` → `ACTION_SEND` chooser) opens the system sheet instead.
- **Recent searches can be removed** — each row in the search dropdown carries a remove button, outside the row's own button so clearing never re-runs the query it belongs to.
- **The Now Playing page follows the artwork** (light theme): the cover's own colour becomes a soft page tint, read from the app's own relay image. Greys and near-blacks are skipped so a moody cover cannot wash the page out, and the tint is cleared when the user leaves the screen.

### Added (mobile: "Save to local" — 2026-11-13)
- **Downloaded songs can be handed to the device.** Distinct from **Download** (which fills the app-private vault only OpenMusic can read), **Save to local** writes the file to MediaStore (`Music/OpenMusic/`) so other players see it. It appears in the track menu everywhere — including **every row on the Downloads screen**. A re-save is detected by name, not by bytes, so a re-encoded copy does not create duplicates.

### Changed (mobile: the "CORE V2.4" chip is gone from the top nav — 2026-11-13)
- The version chip beside the branding has been removed from the home header.

### Added (mobile queue persistence + last-session restore — 2026-11-12)
- **The queue now survives an app restart on Android, mirroring desktop.** Every queue mutation funnels through the repaint, so play-now, play-next, add-to-queue, reorder, shuffle, clear and radio top-ups coalesce into one debounced `tm-queue` write (400 ms), guarded by a signature so `timeupdate` paints never rewrite unchanged data. At boot the snapshot is restored **without autoplaying** — the paused bar shows the last session's track, tap Play to resume. Flush on `visibilitychange`/`pagehide` covers process death. Pure helpers in `app/src/mobile/queue-persistence.js` (5 unit tests); boot wiring in `app/src/mobile/wiring.js`.

### Fixed (mobile dark theme: translucent utilities rendered in the light palette — 2026-11-13)
- **The whole dark shell was affected, not one screen.** Tailwind cannot apply an opacity modifier to a plain hex theme colour, so it baked the **light** palette into every `/NN` utility — `bg-surface-container-lowest/95` compiled to `hsla(0,0%,100%,.95)`. The dark engine's plain-class rules never matched those either (the class name carries the `/NN` suffix), so the options sheet was a **white panel**, the Downloads/Favorites headers carried a **light grey band**, and card borders were near white. **39 variants / ~300 uses** were affected; all now have a dark rule with the alpha preserved and borders reduced to hairlines. The rules are generated from the utilities the shell actually uses, and a **coverage gate** in `app/tests/mobile-dark-layout.test.mjs` fails if a new `/NN` utility ships without one.
- **Artist tiles now show the artist.** The mined taste profile only knows the track's artwork, so "Arijit Singh" was drawn with a compilation cover and "Rahul Sipligunj" with a film poster. A shared, cached resolver fetches the artist's own photo from the catalogue entity search (and its token, which makes the tile navigate directly).
- **Action discs are glass, not lamps.** Play bubbles and small round buttons were solid white holes in the dark page; they are now a 14% white fill with a hairline and a backdrop blur.
- **The stray band behind the home shelf titles is gone** — the dark card rule was matching each shelf's header row, not its cards.

### Changed (mobile dark theme polish + grid/list layout — 2026-11-12)
- **The dark theme now reads like a finished product.** The Now Playing **seekbar** was the worst offender: the dark engine painted a translucent white wash across the whole track plus a 10px glow on the filled bar and a 14px glow on the needle — a glowing tube. It is now a flat track, a clean white progress bar and a small knob with a dark drop shadow. The white "lit from behind" glow on primary buttons is gone, and cards gain a **hairline** edge instead of a shadow (Tailwind's shadows are black — invisible on a near-black surface). Spec: `docs/mobile/06-features.md`.
- **Tapping an artist opens that artist.** The resolver used to fall back to the *first* search result when the tapped name did not match byte-for-byte, so artist #2 and #3 both opened artist #1. The match is now normalised and must actually match; a tile that carries an id navigates directly.
- **Bigger artwork + a grid/list switch.** A new **Settings → Appearance & Theme → Layout** option (`Grid` / `List`) drives Artists, Albums, Playlists, Charts, Liked songs and Downloads. Grid mode is two columns of square artwork (artists stay circular); list mode keeps the rows those screens already had.
- **Two smaller defects fixed on the way**: the count pill beside Artists/Albums/Playlists/Charts is filled in again (it lives in the header, which the screen-scoped query never saw), and mined play counters are abbreviated (`375.6M plays` instead of `375623677 plays`).

### Fixed (Android build: the loopback cleartext allowance was silently dropped — 2026-11-12)
- **A release APK could ship with no loopback allowance.** The manifest injector referenced `network_security_config.xml` from inside the branch that adds the INTERNET permission — but the Tauri template now ships INTERNET by default, so that branch was skipped and the attribute was never added. A present-but-unreferenced config changes nothing: Android then applies `usesCleartextTraffic=false` and the media relay is blocked (`ERR_CLEARTEXT_NOT_PERMITTED`). Debug builds were unaffected, which hid it on every emulator run. The reference now has its own guarded block and the config is written per build type. Spec: `docs/mobile/09-problems-solutions.md` P54.

### Fixed (Android debug APK: 13 MB of invisible padding — 2026-11-12)
- **`jniLibs.keepDebugSymbols` made the packager reserve aligned space for an uncompressed copy** of the native library — a 12.9 MB zero-filled dummy entry inside the APK. The library is deflated anyway and `extractNativeLibs=true` means nothing reads symbols from the APK, so the reservation was pure waste. Dropping it shrank the `.so` from 51 MB to 31 MB and the debug APK to **17.1 MiB**. `./build.sh android-debug` now applies every build-loop tweak automatically (the files live in the gitignored `gen/` tree and were wiped by each `tauri android init`). Spec: `docs/dev-loop-speed.md`.
### Fixed (media-seekbar ticks + offline-boot UI + recent-search remove — 2026-10-24)
- **The seek bar now moves in the notification center, on the widget and on the Android status chip.** The JS anchors only refreshed every 2-5 s and stopped entirely once the WebView was backgrounded (Android throttles page timers), the AppWidget had no progress bar at all, and the notification/chip surfaces froze between stale anchors. `MediaHub.kt` now runs a native 1 s ticker while playing — it advances the position locally, re-publishes PlaybackState (paused speed 0 so nothing drifts) and refreshes the widget; the next JS push stays authoritative. The widget layout gained a real seek bar (`tm_w_progress`). All three surfaces read the same PlaybackState, so one fix feeds them all. Spec: `docs/android-media-widget.md` ("Seek bar ticks while playing").
- **The app renders perfectly with zero connectivity.** Both shells pulled Material Symbols (icons) — and on mobile Geist + JetBrains Mono — from fonts.googleapis.com; offline boot left every icon as raw ligature text and reconnecting never retried (CSS font loading is one-shot per document). Real woff2 files now ship in `app/src/fonts/` with inline `@font-face` in both heads, the Google `<link>`s are deleted and the CSPs no longer reference the Google domains. Gate: `fonts-local.test.mjs`.
- **Recent-search rows in the suggest dropdown got a per-row remove button** (the Recent searches chips already had one): the X deletes the query from `tm-history` and repaints the dropdown in place, sitting outside the row button so it never re-runs the query. UAT: `recent-sug.test.mjs` (markup + storage contract).
- **"Save to local" no longer writes a `(1).m4a` duplicate on a second save** — the bridge's idempotency check now matches the display name (bytes can drift between vault re-downloads of the same song), and the toast reports the name the row actually carries after any MediaStore rename. Record: `docs/mobile/09-problems-solutions.md` P58.
- **"Save to local" file names are capped to the lead artist** — a six-way collaboration no longer mints a 100+ char stem.
### Added / Fixed (artist art from the catalog + Save to local — 2026-10-24)
- **Artist tiles show the artist's real thumbnail instead of a song cover.** Mined tiles (Home "Top Artists" rail + the `#/artists` browser) painted the artist's most-played *track's* cover — an album poster, never the artist photo. `artistInsights` now marks image provenance (`art`: track stand-in / real / none) and a pure resolver (`mobile/artresolve.js`) hydrates `search_entities kind:"artist"` results onto the tiles — exact-name match (or name-prefix), never the first result blindly; the resolved token additionally upgrades the tile to the direct `#artist?token=…` hop. Real art caches in `tm-artist-art-v1`, so later mounts paint instantly with zero calls; offline keeps today's art.
- **New "Save to local" menu action right under "Download"** (track menu + library menu): the song file lands in the **device's own storage** (`Music/OpenMusic/` via Android MediaStore) so other players and the Files app see it — "Download" fills only the app-private vault. The vaulted file (downloaded first through the existing progress pipeline when needed) is handed to the overlay bridge (`TmBridge.saveLocal` → `MediaHub`, same per-build injection pattern), which copies it with TITLE/ARTIST/ALBUM metadata, size-dedupe for idempotent taps (`Already saved on this device`), and honest errors (no permission needed on API 29+; "Android 10+" claim below). Spec: `docs/mobile/06-features.md` ("Artist art resolved from the catalog + Save to local"). Gates: npm 518/518, eslint clean; unit tests in `artresolve.test.mjs` + `savelocal.test.mjs` + `recommend.test.mjs`.

### Removed (Now Playing Canvas parked on Android — 2026-10-24)
- **The Canvas feature is parked: nothing Canvas is visible in the Android app any more.** The renderer (`mobile/canvas.js`), its per-track hookup, its self-driving paint hook, the three Settings rows ("Now Playing Canvas", "Canvas on mobile data", "Canvas session cookie") and their switch/flips are all commented out — the ambient layer, the moving-video art card, the dark cinematic pass and the mobile-data toggle are gone from the UI, and no `fetch_canvas` call happens. Spotify **account + top-tracks import keep working** (the shared section header stays live). Everything is left in the tree as-is so reviving is comment-marker surgery: checklist in `docs/spotify-android-canvas.md` §18.3. Backend (`canvas.rs`, `/canvas` relay, CSP origin) is untouched and idle.

### Changed (Now Playing Canvas — 9:16/720×1280 contract + stable 6 s loop — 2026-10-23)
- **The official Canvas cut now meets the Spotify-Canvas format contract.** The Rust picker chooses the smallest Apple rendition whose **centred 9:16 crop** clears **720×1280** (After Hours: 1078×1438 → 808×1438); the renderer publishes `data-source`, `data-crop`, `data-loop` and `data-floor` and plays a **6 s** window with a 0.6 s crossfade between two muted `<video>` elements. A track without an Apple cut gets a cover-derived generated canvas on the same 6 s clock (backdrop drift + colour wash + card drift + light sweep), so the screen is never a still image. Spec: `docs/spotify-android-canvas.md` §17.
- **Fixed the 0.4–0.6 s flicker the first dual-video build produced.** Apple's fMP4 has a ~10.03 s edit-list/media-timeline offset: a seek to 0 lands in an empty edit and the first presented frame is at ~10.05 s, so a fixed 0.6 s anchor read as "past the window" on every tick. The loop now anchors to the first presented frame (`data-base`), starts the standby there, pre-seeks the outgoing element while invisible, and waits for `requestVideoFrameCallback` before the first tick. **Live-verified 11/11 on the Android emulator** (real search/tap, M9 returns to `base + 0.6` while playing; generated-canvas fallback M7).

### Changed (Now Playing Canvas — full-bleed, ambient, and every song — 2026-10-19/20)
- **The canvas now fills the Now Playing screen like a Spotify Canvas instead of a small square tile.** The backend prefers Apple's tall 3:4 cuts (`motionDetailTall` → `motionTallVideo3x4`) with a 780 px rendition floor; the renderer paints the loop on a body-level, fixed full-bleed layer (`object-fit: cover`) with a top/bottom scrim, and enters a cinematic dark presentation while it plays (the art card becomes a window onto the video; header and queue sheet turn to dark glass). Spec: `docs/spotify-android-canvas.md` §15.
- **The canvas is now an app-wide ambient backdrop and every track has one.** It survives navigation — Home, Search, Library and Settings keep the current track's full-bleed artwork behind dimmed glass (`np-canvas-focus` on Now Playing, `.dim` elsewhere). Tracks with no Apple animated cut (most of the Indian film catalog) get a slow Ken Burns drift of their own cover both full-bleed **and inside the art card** (plus an 8 s light sweep) instead of a static card, so every song visibly moves; the Apple video removes the fallback motion when it plays. The muted loop pauses with the transport and when the app is backgrounded; the cellular gate now blocks only the video fetch, never the artwork. Toggling off or clearing the track restores the user's theme. Spec: `docs/spotify-android-canvas.md` §16.

### Added (share deep links + vCard — 2026-10-17)
- **Sharing a track now hands out a canonical `play.html?t=<id>&n=<title>&a=<artist>` link.** Receivers with OpenMusic installed land straight in playback (Android intent-filter + desktop argv/single-instance, both click the same `openmusic://` scheme); everyone else sees a branded download page with platform-detected buttons and real release URLs. A "Share as vCard" action shares the track identity with the artwork thumbnail embedded (relay `/art` bytes, honest omission when unavailable). Spec + live record: `docs/share-deep-links.md`; landing page `play.html` at repo root (Pages).
- **Scheme capture is explicit on both surfaces**: Android rides the `deep-link` plugin (`plugins.deep-link.mobile` domain config required — the plugin ignores everything without it) with the manifest intent-filter injected by `build.sh`; Windows uses a cold-start argv capture (`sharelink_launch_url`) plus the single-instance warm hand-off (`sharelink://open`). An unresolvable id announces itself honestly (`Opening «title»` toast, then a verified refusal) instead of a false success.

### Added (Now Playing Canvas — animated artwork without any account — 2026-10-17)
- **"Now Playing Canvas" now lights up with no sign-in and no cookie.** The toggle resolves a short looping video for the current track through **Apple Music's public web player** animated-artwork route: the player's own bearer is scraped from its JS bundle (memoised; re-scraped once on a 401), the album (or the matched song's parent album) must agree on the artist and carry artwork, the tall AVC rendition (3:4 first, 780 px floor since §15) is downloaded once (~2–7 MB fMP4) into the budget-managed cache, and the loopback relay serves it (`/canvas?id=…`, `video/mp4` with Range) so the WebView CSP and the renderer are untouched. Misses are cached 6 h; transient failures retry on the next paint; a miss simply keeps the album art. Spotify's own Canvas stays cookie-gated (the OAuth route is proven impossible — `docs/spotify-android-canvas.md` §13) and its `sp_dc` field remains as the future hook. Spec + acceptance: `docs/spotify-android-canvas.md` §14. **Live-verified on the Android emulator 6/6** (§14.4): command → relay (200/206, `video/mp4`) → real `<video>` playback → honest miss → full UI path (search → trusted touch → `#np-canvas` playing).

### Added (audio quality & immersive spatial engine — 2026-10-18)
- **Playback is now fully automated, hands-free** (spec: `docs/audio-quality.md` §6): a shared Studio audio chain (`app/src/dsp.js`, all desktop tracks and mobile) runs transparent-EQ → loudness slot → limiter → **"Immersive room"** (mid/side widening + a synthesized deterministic-IR binaural room, auto-bypassed in Jam rooms since a reverb tail is a delay line the drift measure must not see). Loudness matching (BS.1770 K-weighting approximation) measures LUFS `(±12 dB, limiter-protected, cached per track and tier)` and level-corrects every track automatically, so no more jarring jumps between masters. The system ships with its built-in behavior: **flat EQ, hall room, always-armed normalization — no settings toggles** (the toggle-era rows, per-track EQ sheet and their sync keys are removed; stale keys are wiped at boot).
- **Desktop elements load CORS-clean** (`crossOrigin="anonymous"` before any stream load): the relay is a different origin than the app page, spec-mandated silence without it (the 2026-10-08 mobile P36 failure class), now verified live by metering the chain output. Gains: `stream/vault bytes`, `chunked: no`.
- **Source-fidelity gates** (`app/tests/audio-quality.test.mjs`, 8 tests): desktop `streamQuality()` and mobile `effectiveStreamQuality()` pinned to 320 kbps on every default branch (Data Saver's 64 kbps and a cellular 96 kbps pick stay explicit opt-ins; the Rust ladder takes the best available tier and reports it, shown by the Now Playing badge).
- Verified: `npm test` **498/498** (incl. dsp/loudness unit tests + the automation gates), eslint clean on touched files, `node --check` on all touched files. Live CDP metering of the real chain (audible output, routing, loudness gain): `docs/audio-quality.md` §5 status table.

### Added (mobile Now Playing queue append browser — 2026-10-17e)
- **The queue tab's append search now works like the search screen**: typing shows a few matching songs directly under the input, each with **Play now / Play next / Add to queue** buttons where the search rows show their type label. The row shipped disabled with zero wiring before (a dead affordance). `Enter`/`+ Append` commits the top result to the queue; host edits republish the room queue to guests immediately, and guest additions stay local (§4.7/§12). Spec: `docs/mobile/06-features.md` ("Queue append search browser").

### Changed (Now Playing mobile cleanup — 2026-10-17)
- **Mobile Now Playing drops the `320kbps` tier chip and the time bubble riding the scrubber needle** — the elapsed/remaining readout under the track is the single time source, so the floating bubble (which duplicated it) and the pill under the artist are gone. Spec: `docs/mobile/06-features.md` ("quality chip + seek position bubble removed").

### Added / Changed (source-first search + branding scrub — 2026-10-17)
- **Search results now lead with the matched song's own source**: search a film song and its movie's tracks — fetched from the catalog and folded in after the anchor — come first; for singer-driven rows (English and other non-film catalogs) the anchor's artist's own tracks lead instead. Query-intrinsic grouping, no taste and no history; after the first paint, so the page never waits on it. The film is read from the title's own `(From "Movie")` tag first (compilations hide it in the album field) and that provenance no longer blinds the exact-title bonus — the 374M-play original leads instead of a bare-titled cover. Spec: `docs/recommendations.md` §8.11.
- **No upstream provider or CDN name is shown anywhere in the UI**: About/Terms copy, the Spotify-import note and the Now Playing source line are scrubbed on both shells — desktop `#np-format` and the mobile tier chip show the tier only (`local vault` for on-disk copies); the stream's origin host stays internal. Contract: `docs/branding/trance-music-guide.md`, "Upstream attribution".

### Changed (JioSaavn-first recommendations — 2026-10-16g/h)
- **The endless radio prefers the JioSaavn recommendations**: a station batch queues in the order JioSaavn returned it — the local taste engine no longer re-ranks it (filters only: queued, last-15-heard, just-skipped; the last-resort fallback pools keep upstream order too). Supersedes the radio half of the 2026-10-16e reranking. Spec: `docs/recommendations.md` §8.8.
- **Search keeps JioSaavn's own ranking**: the relevance pass no longer adds personal boosts (played / liked / artist-play counts) — rows come back in JioSaavn's order (stable ties), carrying only the query's own filters and the Settings region. Spec: `docs/recommendations.md` §8.9.

### Added / Changed (official-stream upgrade — 2026-10-16f)
- **A dead top rendition no longer skips the track**: playback now walks a bitrate ladder (320 → 160 → 96 → 48 → 12 kbps, never above the requested tier) and plays the best playable rendition — the first unrestricted tier, else the highest preview-capped one (the PREVIEW tag stays honest), else the old skip-on-dead behaviour. Both the resolve and the relay share the one walk, so the badge and the stream can never disagree. Spec: `docs/architecture.md` §5.5.
- **Quality settings now genuinely drive the bytes**: the relay url carries the resolve's requested tier (`/stream?id=…&q=96kbps`), and the relay serves that rendition — previously the setting only affected the resolve probe/badge while the relay always served its own 320 pick. A missing or malformed `q` keeps the 320 default.
- **Official-origin hardening**: the relay's by-id resolve re-validates the URL it returns against the CDN allow-list (plus the ladder validates every candidate before probing) — a poisoned resolution is refused before any request leaves the process.
- **Visible tier proof on Now Playing**: desktop shows `320kbps` in the metadata tile; mobile shows a tier chip under the artist (`local vault` for on-disk copies). (Origin host removed later — see "source-first search + branding scrub".)
- **Search, artist/album pages and radio prefer the original recording**: cover / tribute / instrumental / karaoke / lofi re-uploads of a song on the same page sink below the original (stable, never filtered — the row stays selectable; `remix`/`live`/`acoustic` are label releases and are not demoted). Spec: `docs/recommendations.md` §8.7.

### Added / Changed (recommendation upgrade — 2026-10-16e)
- **The endless radio now ranks with real taste signals instead of artist counts**: a bounded play-event log (`play_events`, 3000-row cap) records every finished or abandoned play — natural end → `complete`, early abandonment → `skip`, the rest → `partial` — and one shared, pure engine (`app/src/taste.js`) turns it into decayed artist/album/night-hour weights, skip demotion (a skip within 3 hours hard-drops the track from radio batches), item-item co-occurrence and MMR-diversified reranking. Both surfaces' radios rerank their station batches through it (`scoreReco` now delegates), with an ε-slot exploration pick.
- **"Because you played X" shelf** (mobile Home): a co-listening rail over the same log — the most recent play with at least 6 co-occurring neighbours renders as cards using the log's own metadata; the shelf hides itself when the log is too thin.
- **The taste engine is measurable**: `replayHitRate` (session k-NN replay metric) runs in the suite — 0.98 on a synthetic chain vs ≤0.18 shuffled, mirroring the radio's own "heard" window so the metric matches what the radio can serve.
- Spec + as-built record with live evidence: `docs/recommendations.md` §8.

### Fixed (search resilience — 2026-10-16)
- **A transient search failure no longer sticks as "Search is down right now"**: a failed desktop search now re-runs itself on a bounded auto-retry ladder (1.5 s → 4 s → 15 s → 45 s) and instantly when connectivity returns — the card only stays when upstream really is down, and a valid empty answer ("No tracks found") is never auto-retried. Spec: `docs/search-resilience.md`.
- **The primary catalog source got one calm retry** — a transport error, a 5xx or a short 429 earns a single jittered backoff before failing the search (4xx and business answers stay final). The fallback mirror list is honest again: four of five listed hosts were dead (404 / connection-refused); only the verified `saavn.sumit.co` remains.
- **Desktop diagnostics survive without the panel**: the 40-line diag ring (raw errors included) is readable via `__tmDiag()` — it had been silently dropped since the panel's removal.

### Fixed / Added (Spotify)
- **The sign-in button (and every Spotify/Canvas command) failed before doing anything**: all seven command params took `State<'_, AppState>` while the builder manages `Arc<AppState>` — Tauri resolves state by exact type, so each call died with *"state not managed"*. Sign-in had never been reachable on desktop or Android; the panel could only ever paint its error branch. Fixed to the managed `Arc<AppState>` type, and a static gate now rejects the bare form anywhere in the crate.
- **Imports matched the wrong songs**: both importers queried JioSaavn by **ISRC first**, but the catalog has no ISRC index — a valid ISRC returned dozens of unrelated tracks and the old code took the top hit, so imports silently filled with garbage or missed. Now both query `name + first artist`, fetch 8 candidates and score them (`app/src/spotmatch.js`: title/credit/duration blend with a tribute-cover guard); honest misses are counted in the toast. Probed live against the real catalog: the old query returned "Mat Aazma Re" for Believer, the new one returns the exact track.
- **Android: Spotify sign-in, top-tracks import and Canvas** (Settings → Spotify): Sign in/out through the system browser (PKCE loopback — the same client id as desktop), "Import top tracks" builds a local playlist via the same matcher, and the Canvas controls (video on the Now Playing artwork, Wi-Fi-only by default) light up once your browser's `sp_dc` cookie is pasted — the album art is the guaranteed fallback, and Canvas is an unofficial Spotify surface, so any miss just leaves the art untouched.

### Fixed (audit pass — desktop + Rust)
- **A failed vault rewrite no longer loses the entry**: re-downloads forget the old row before writing; a failure (network, Stop, encode, hash) now restores it via a drop guard — only while the old file is still on disk — and promoting a favorite no longer deletes the file it just recorded on a same-stem rewrite.
- **`open_external` can no longer be aimed at shell syntax**: the Windows `cmd /C start` spawn is replaced with `tauri-plugin-opener` (single-argument ShellExecuteW / xdg-open), so `&`, `^` and `%VAR%` in a URL stay data.
- **Redirect hops are re-validated**: `/art` re-runs the SSRF guard on the URL actually fetched, and `/stream` does the same for redirect hops (direct fetches untouched) — a public host cannot bounce the relay into the LAN.
- **Art downloads are bounded while streaming** (was: buffer the whole body, then check the cap) — a hostile mirror can no longer balloon memory with a chunked response.
- **Jam room hardening**: closed rooms refuse later joins verbatim, a poisoned lock no longer bricks the room, WebSocket frames cap at 64 KiB, guest `report` frames get a 500 ms budget, and a dead serve loop reverts the host mode before saying so. Deferred items are listed in `docs/listen-together.md` §14.
- **Retry jitter is real**: the mirror backoff arithmetic was deterministic (every retry woke on the same tick); it now spreads ±25 % via `getrandom`.
- **Lyrics duration tolerance is a single named source** (`DURATION_TOLERANCE_SECS` = 3 s); the module doc no longer claims ~2 s.

### Fixed (audit pass — mobile)
- **Vault quota notice, crossfade handoff, New-releases cache**: the over-quota eviction toast never appeared (the kind landed in the `ms` argument slot); a crossfade/gapless handoff promoted the standby `<audio>` without the shell's event list (frozen transport glyphs, resume position no longer saved); an empty shelf response was cached as a hit for 24 h.
- **Android edits, version badge, analytics pills, router fetch**: "Edit description/cover" used `window.prompt`, which is dead in the Android WebView — now the bottom-sheet input; the Settings footer printed a hardcoded `0.4.0`; the Analytics Week/Month/Year pills threw `ReferenceError` (the generated screen keeps `setPeriod` inside an IIFE — a `window.setPeriod` shim now publishes it); a failed screen fetch was silent (stale screen stayed, no toast).
- **Probe single-flight, download channel leak, share-code failure**: online/offline events could start duplicate network-probe chains and strand a timer; cancelled or failed downloads leaked their progress channel; "Copy share code" could fail with no feedback. Table: `docs/mobile/09-problems-solutions.md` P44–P53.

### Removed (audit pass — dead code)
- **Four abandoned files** (~1.8k lines): `app/src/survey.js` (a survey flow no code imports) and the long-disabled `catalog.rs` / `jiosaavn_catalog.rs` / `audius.rs` trio (their `mod` lines had been commented out). All recoverable from git history.
- **Dead exports and branches**: mobile `isFav` / `isActiveDownload` / `storageBreakdown`, desktop `prefLang` / `lyricsSizePx`, and the mobile widget click handler's branches for buttons that no longer exist (`data-w-prev` / `-repeat` / `-shuffle`).

### Fixed (mobile Now Playing)
- **Gemini API key works again**: the AI-lyrics default model `gemini-2.0-flash` was shut down by Google on 2026-06-01, so every call 404'd regardless of key — default is now the stable `gemini-2.5-flash`, and a retired model id reports "update the app" instead of a raw HTTP error.
- **Lyrics Full View opens again**: the toggle searched `closest("div.rounded-2xl, div.rounded-xl")` but the sheet card has been `rounded-3xl` since the mockup redesign, so the button silently did nothing. Switching tabs exits the fullscreen stage (the Close button lives in the lyrics view).
- **Word-by-word karaoke in full view**: the active line gets a thicker bar + pad at 28px over the existing per-word `--progress` wipe (both themes); plain/AI lyrics stay static lines (no timestamps to sync to).
- **NOW PLAYING eyebrow removed** from the Now Playing screen.
- **Home category chips** (mobile): the flat seven-chip strip keeps its original design, and the selected pill finally renders as selected — the old toggle keyed a class the theme CSS no longer styled (`bg-on-surface`), so the active chip rendered white-on-white in light mode; it now keys on `bg-primary`, the class the theme inverts (obsidian pill in light, white pill in dark).
- **Mined collection browsers** (mobile): the home Artists/Albums/Playlists/Charts chips open full browsers — artists by listening weight with Liked/Downloaded/Following tabs, albums with separate Most-time vs Most-played orders, playlists split Yours/Featured/Downloaded, charts in untouched editorial rank. Home Top Artists rail shows your artists + See-all.
- **`feat.` artists no longer fragment** into ". Guest" entries in the taste weights.

## [0.5.1] — 2026-10-11

### Changed
- **Visible name is now OpenMusic** (was `OPEN MUSIC` on desktop; Android already showed `OpenMusic`): installer names, window titles, header wordmark, About/Legal copy, share badges, OAuth pages, tray tooltip, Linux desktop entry, updater release notes. Identifiers, binary name, vault/keyring data, backup format, and signing keys are untouched, so updates and saved data carry over.
- **Marketing site updated**: root `index.html` (the GitHub Pages source) carries the OpenMusic brand, Windows/Linux/Android-only platform claims, and a v0.5.1 offline fallback; the unshipped macOS tab is removed and a `.nojekyll` bypasses the previously failing Jekyll build.

## [0.5.0] — 2026-10-11

### Added
- **Listen Together (Jam)** on desktop and mobile: open a room, share one invite link (`trancemusic://join?…`) or QR, guests follow the host's playhead with drift correction; transport is host-only. Room chat with unread badges, shared up-next queue, up to 16 guests.
- **Jam resilience**: multi-address invites with try-every-candidate dialing (a dead first address — VPN, emulator NAT, dock NIC — no longer fails the join), guest auto-rejoin, host tick 250 ms.
- **Download pause/resume** (desktop): paused downloads keep their `.part` file and resume with an HTTP Range request.
- **Smart playlists** (desktop): `Top 50 · Last 30 Days` and `Favourited, Not Downloaded` auto-cards.
- **Lyrics offset adjust** (mobile): ±100 ms per-track correction with reset.
- **Exportify CSV import** (mobile Settings) and quota/LRU eviction for the offline vault.

### Fixed
- **Mobile played silently** (P36): CORS-tainted WebAudio graph — the audio relay now reflects the app origin and mobile loads media with `crossOrigin="anonymous"`.
- **Room chat tab showed nothing** (P41): a missing `</div>` nested the chat view inside a hidden panel.
- **Guest could never rejoin after a host closed a room** (D5): the guest pump now ends on the server's `bye` and reverts mode before the UI reacts.
- **Guests couldn't play tracks missing from their device**: catalog fallback via `resolve_song` instead of stalling.
- **Jam joins survive dead addresses both ways** (D6): verified live emulator-host→desktop-guest (518 ms) and the reverse (524 ms).
- Home mix rows show every track (was: one card per shelf).
- Android launcher icon is the TRANCE MUSIC mark, edge-to-edge on black.
- Desktop Now Playing metadata card is transparent (blur removed); eyebrow/quality chrome removed.
- Search box double border; search failure shows one classified line instead of a URL dump; junk catalog rows dropped on album pages.
- Desktop widget: corners, transport centering, volume slider; Spotify sign-in persists (keyring feature was missing).
- Debug APK under 50 MiB (dev-profile strip + legacy jniLibs packaging).

### Changed
- Brand is **OPEN MUSIC** across both surfaces (user-facing strings only; data-format ids intentionally unchanged to protect backups and saved logins).
- Now Playing (mobile) shows clean full-bleed artwork; miniplayer truncates long titles.
- Download size: Windows installers ~4.85 MiB (release profile: LTO, `opt-level="s"`, stripped).

### CI/CD
- Tag-driven release pipeline builds Windows (MSI+NSIS) and Linux (deb+AppImage), verifies updater-manifest URLs, and publishes the GitHub release with assets.
- macOS and iOS workflows removed from the release and test matrices.

## [0.4.0] — 2026-10-05

- Cross-platform pipelines (Windows, Linux, macOS, iOS, Android).
- UI: cleaner Now Playing lyrics, redesigned desktop mini-widget, unified hover states, mobile header/settings polish.
- Full detail in git history (`CHANGELOG.md` at tag `v0.4.0`).

## [0.3.0] — 2026-10-0x

First mobile-capable release: mobile shell (13 screens), Android APK + iOS CI workflow, vault relocation with legacy migration, SQLite download ledger, cache budget controls, backup/CSV/M3U export, Caps Lock Hyper shortcuts, system tray, widget pinning, fuzzy search, network status machine, CSP hardening.

## [0.1.0] — 2026-09-30

First packaged release: signed MSI + NSIS installers, Settings (profile, autostart, language/region), desktop widget, notifications, track-credits dialog, honest-UI cleanup pass (decorative telemetry removed). A `V0.2.0` tag exists in git but never had a changelog section.
