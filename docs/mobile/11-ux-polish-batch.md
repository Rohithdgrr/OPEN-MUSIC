# 11 — Android UX polish batch (2026-11-22)

User-reported batch against the mobile shell + Android overlay, from two
screenshots (720x1600). Spec first per AGENTS.md rule 3; evidence per item.

## Items and fixes

1. **Pinch-zoom / overflow / dead space.** Viewport gains
   `maximum-scale=1.0, user-scalable=no` (`index.html`). `overscroll-behavior:
   none` on html/body/screen roots kills the WebView pull-stretch. Now
   Playing's bottom sheet is pinned with `margin-top:auto` inside a
   flex-stretched `#np-top`, so short content no longer leaves a dead gap
   above the mini player.
2. **Search.** Input gets `enterkeyhint="search"`, `inputmode="search"`,
   `autocomplete="off"`, `autocapitalize="none"`, `spellcheck="false"` so the
   Android keyboard treats it as a search field; the focus-zoom is gone with
   the viewport fix. "Top result" biases songs: `KIND_WEIGHT.song` 1.08 → 1.5
   in `searchkit.js` (exact-title +6 bonus still lets a literal artist-name
   query surface the artist). Padding tightened in `search.html`.
3. **Toast pooling.** `toast()` dedupes an identical message+kind inside
   1.5 s — the timer resets instead of stacking a second pill
   (`shared.js`).
4. **Up Next diversity.** `radio.js` keeps a persisted served-id set
   (`tm-radio-seen`, cap 400) merged into the eligibility gate so station
   batches cannot recycle tracks the heard-window forgot; batch grows 12 →
   20 and a stable per-artist cap (2/batch) spreads the feed; `player.js`
   tops up when fewer than 6 remain instead of 3.
5. **Share sheet.** `shareThing` sends a JSON payload
   `{title,text,url}` to `TMNative.share`; `MediaHub.share` parses it and
   sets `EXTRA_TITLE`/`EXTRA_SUBJECT`/`EXTRA_TEXT` + a titled chooser —
   plain-text callers still work (JSON parse failure → legacy path).
6. **Followed-artist releases.** New `releasealerts.js`: once per 12 h it
   diffs `artist_overview` latest/singles/albums for up to 6 follows against
   `tm-rel-seen` (first run seeds silently), pushes `kind:"release"` events
   into the Notifications feed and posts an Android alert through a new
   `TMNative.notify` bridge → `MediaHub` channel `tm_alerts`.
7. **Widgets / lockscreen.** Already implemented via `android-overlay`
   (notification = lockscreen surface, AppWidget home+keyguard). Fixes:
   `dismiss()` now `refreshWidgets()` so the widget resets instead of
   keeping dead metadata; `notify` channel added. Portrait lock already
   injected by `build.sh` (`screenOrientation="portrait"`).

## Non-goals / honest limits

- "Responsive to all Android devices" is addressed by the viewport,
  overscroll and safe-area rules already in `shell.css`; no per-device
  breakpoints were added without a reproducing device.
- Artist-release detection reuses `artist_overview` (same source as the
  Home "New from artists you follow" shelf) — it can only see what that
  endpoint returns.

## Studio follow-up (2026-11-22b) — the live shell

`mobile/entry.js` boots `studio/app.js`, NOT the legacy `mobile/*.js`
bundle — so the fixes above that touched `binders.js`/`radio.js`/
`shared.js`/`searchkit.js`/`releasealerts.js` apply to the legacy shell
only. This section covers the same asks against the live Studio SPA.

1. **Search typing (root cause).** Every keystroke ran
   `store.setUi({searchQuery})` → `emit('state')` → `renderAll()` →
   `elScreenRoot.innerHTML = renderScreen(store)`. The whole screen,
   including the focused `<input>`, was destroyed and recreated per
   character; the focus-restore snapshot keeps focus but kills the
   Android IME composition — "the keyboard stops taking input".
   Fix: all non-draft `data-input-ui` keys now write silently and repaint
   once typing pauses (320 ms debounce → `store.emit('state')`); the
   search query additionally keeps its 220 ms `searchLive`/
   `fetchSuggestions` debounce. `/` shortcut now focuses the real id
   (`search-main-input`, was `search-input`). Input gets
   `enterkeyhint`/`inputmode`/`autocapitalize`/`spellcheck` attrs.
2. **Top result = song.** `renderSearchScreen` preferred
   `matchedArtists[0]`; it now prefers `matchedTracks[0]` (track art was
   already rendered via `renderArtwork`).
3. **Widget reachability.** `AppWidgetManager.requestPinAppWidget` is
   exposed as `TMNative.pinWidget()` → `MediaHub.pinWidget()`; Settings →
   Backup & System gains an "Add Widget" row (`data-action="pin-widget"`)
   that toasts the system pin sheet result. Lockscreen: Android 12+
   removed lockscreen app-widgets — the media notification IS the
   lockscreen surface; `buildNotif` now sets
   `CATEGORY_TRANSPORT` so it presents as a transport control there.
4. **Home carousels.** `studio/carousel.js` upgrades `.h-scroll[data-cf]`
   shelves (Daily Mix, Most Played, Jump Back In, Top Charts) into a
   coverflow: native touch scroll + rAF-driven `rotateY/scale/z-index`
   per card — the vanilla-JS equivalent of the 21st.dev cover-flow /
   card-deck effects, no dependencies.

## Studio follow-up 2 (2026-11-22c) — media surfaces + library hygiene

1. **Media notification was dead on Studio.** `native.js` subscribed via
   `store.on('state'|'trackChange')` — the store API is `subscribe(fn)`
   and it never emits a `'trackChange'` type, so `initNativeBridge`
   threw a TypeError at boot and NO `pushMeta`/`pushState` ever reached
   Kotlin: no shade notification, no lockscreen controls, no widget
   updates. Verified live: `MediaService` absent from dumpsys, manual
   `TMNative.pushMeta` started it instantly. Fix: single
   `store.subscribe` reacting to `'state'` (progress ticker + meta dedupe
   already throttle).
2. **Library = user content only.** "Your Library" was listing the whole
   hydrated catalog — every feed album and every artist — which reads as
   mock clutter. Albums now restricted to releases containing a liked or
   downloaded track; Artists to followed artists only; Playlists were
   already `isUserCreated`-gated.
3. **Now Playing mobile compaction.** Measured on emulator: `.np-wrap`
   rendered 1311 px inside a 915 px viewport — the queue sheet started
   below the fold. `@media (max-width:1023px)` now caps art at `33dvh`,
   shrinks transport/actions/scrubber and tightens gaps so player +
   sheet fit one screen.
4. **Language playlist shelves.** Home gains dynamic per-language
   playlist shelves (Telugu/Hindi/Tamil/etc. — whatever the feed
   carries, top 4 languages with ≥2 playlists), each a `data-cf`
   coverflow row. The feed's `FeedItem.language` is empty for every
   playlist row (verified live via `home_feed`), so language resolves
   from title/subtitle keywords ("Hindi Hit Songs", "Tollywood Jukebox")
   after the declared field.
