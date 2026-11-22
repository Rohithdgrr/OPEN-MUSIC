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
