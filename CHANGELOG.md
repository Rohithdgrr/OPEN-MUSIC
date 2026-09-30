# Changelog

All notable changes to TRANCE MUSIC are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The first release, **v0.1.0**, was cut on 2026-09-30: signed MSI and NSIS
installers are attached to the GitHub release. Work landing after that tag
sits in `Unreleased`.

---

## [Unreleased]

No unreleased changes — everything below shipped in 0.1.0.

---

## [0.1.0] - 2026-09-30

First packaged release. `npm run tauri build` emits an MSI and an NSIS
installer, both Authenticode-signed (self-signed `CN=TRANCE MUSIC`
certificate, SHA-256, RFC 3161 timestamped).

### Added

**Windows installers, code-signed**

- `bundle.targets` is `["msi", "nsis"]`; the build produces
  `TRANCE MUSIC_0.1.0_x64_en-US.msi` (2.98 MB) and
  `TRANCE MUSIC_0.1.0_x64-setup.exe` (2.05 MB) under
  `src-tauri/target/release/bundle/`.
- `bundle.windows` in `tauri.conf.json` carries `certificateThumbprint`,
  `digestAlgorithm: "sha256"` and a DigiCert RFC 3161 `timestampUrl`, so the
  exe, the WiX/NSIS payload DLLs and both installers are signed during the
  build itself.
- The certificate is self-signed and lives in the local user's `My` store:
  installs work, but other machines show an unknown-publisher / SmartScreen
  prompt. Reputation arrives only with a CA-issued code-signing certificate.
- Release profile was already fully optimised (`lto = true`,
  `codegen-units = 1`, `opt-level = 3`, `strip = true`, `panic = "abort"`);
  a cold release build takes about five minutes.

**Settings — General tab**

- Profile name: greets the Home heading by name (`#home-name`), persisted in
  `localStorage` (`tm-name`).
- Open at startup: `autostart_set` writes or deletes the HKCU `Run` value with
  `reg` directly — no elevation, no scheduled task, no plugin.
- Language + region: `content_prefs_set` pushes the choices to Rust once at
  boot; `official.rs` appends `lang`/`country` to every catalog call.
  `filterLang()` then filters search, load-more and Home rankings to that
  language, falling back to the unfiltered list when the source has no hits —
  so a Telugu preference cannot blank an English query.

**Endless playback (radio) — backend only, not yet reachable from the UI**

- `recommend_songs` Tauri command (`app/src-tauri/src/lib.rs`).
- `official.rs`: `RadioPage` DTO, `create_station` (`webradio.createEntityStation`)
  and `station_songs` (`webradio.getSong`) with a 10-song batch.
- `parse_song` now falls back to `more_info` for the artist credit, because
  radio batches carry it only there.
- `call()` now tolerates a bare-string `error` body, which the radio endpoint
  returns (`"No new song found for current radio."`).

> **Not wired up.** Nothing in `main.js` invokes `recommend_songs` yet, so this
> code is unreachable from the running app. It is landed and tested so the
> feature can be switched on without touching the backend again. It is also the
> only part of the working tree not written this cycle — do not commit it blind.

**Settings dialog**

- `openSettings()` in `main.js`: a native `<dialog>` with exactly three
  entries — Open-Source Licences, About the Project, Terms & Conditions. The
  body swaps between the menu and one section, so no nested dialog is needed.
- Licence data is read off `Cargo.lock` and the registry manifests, not
  invented: 10 direct Rust deps with versions and SPDX ids, plus
  `@tauri-apps/cli` as dev-only. The full 469-crate tree is named in the copy
  and left in the lock file.
- Terms: 7 clauses, with a non-affiliation disclaimer and a
  "not legal advice" footer. **Drafted by the assistant, not reviewed by a
  lawyer** — get clauses 1, 2 and 4 checked before publishing.
- The back button swaps its whole `class` string. Toggling `hidden` against
  `flex` does not work: Tailwind emits `.hidden` after `.flex`, so the element
  would stay hidden. Same trap that broke the nav tabs.

**Desktop widget**

- New floating player surface built from `design/screens/widget design`: the
  obsidian glass card (32px radius, hairline border, 28px backdrop blur,
  blurred cover art behind the panel, 7-bar CSS spectrum, up-next card,
  telemetry footer). Toggled from a `widgets` button in the header, anchored
  above the miniplayer, closes on Escape.
- **It is a view, not a second player.** Every control calls the existing
  handler (`togglePlay`, `step`, `toggleShuffle`, `seekFromEvent`,
  `volFromEvent`, `playQueueItem`) and every widget painter is *called from* the
  existing bar/now-playing painters, so the three surfaces cannot disagree.
  The paint hooks added are in `timeupdate`, the audio event loop,
  `playQueueItem`, `setBadge`, `renderQueue` and `paintVolume`.
- Seek and volume take real pointer-capture drags plus arrow/Home/End keys, and
  expose `role="slider"` with live `aria-valuenow`.
- Palette lives in `styles.css`, not as utility classes — the app's Tailwind
  config has no `zinc` scale and `index.html`'s config is one minified line.
  Visibility uses `.is-open` for the same `hidden`/`flex` reason as above.

**Notifications**

- Toasts restyled into the widget's card language: same obsidian glass, hairline
  and glow, 16px radius, glowing status dots, tabular figures. A notification
  and the widget now read as one system.
- The stack lifts clear of the widget while it is open. The offset is applied
  when the stack is *created*, not only when the widget toggles — otherwise
  the first toast of a session would land under an already-open widget.

**Track credits dialog**

- `openCredits()` in `main.js` replaces the native `alert()` behind the info
  icon. Built on a native `<dialog>` (so focus trap, Esc and the inert
  background come from the platform) and styled with the app's own tokens.
- `#tm-dialog` rules in `styles.css` for the scrim — `::backdrop` cannot be
  expressed as a utility class.
- Clicking the backdrop closes it.

**Navigation from the miniplayer**

- Clicking the miniplayer's cover, title or artist opens Now Playing, via the
  existing `data-path-jump` delegate. No new JS was needed.

### Fixed

- **Tab switches resumed at the previous view's scroll position.** WebView2
  restores scroll on a session resume (`history.scrollRestoration`) and
  swapping views changes the document height, so the first `scrollTo({top: 0})`
  could be clamped away by the old layout. `scrollRestoration` is now
  `"manual"` before first paint (set in `index.html`), and `toTop()` scrolls
  again on the next animation frame, once layout has settled.
- **Active nav tab rendered dark-on-dark.** Inactive tabs carry
  `text-on-surface-variant`, which Tailwind emits *after* `text-on-primary`, so
  the white text added by JS lost the cascade and every tab except Home
  (whose markup has no competing class) showed black text on a black pill.
  `showView()` now removes the inactive classes instead of only adding the
  active ones. Also stops the active pill turning dark on hover.
- **Playlist clicks no longer hijack the Playlists tab.** Opening a playlist
  from Home (carousel, hero banner) or Library (saved playlists) switched the
  whole app to the Playlists screen. These now open on the shared `detail`
  view, and `Back` returns to where you were.
- **Library playlist cards printed `[object Object]`.** `plCard` joined an array
  of objects instead of their names.
- **"Full 100 Charts" played one chart instead of listing them.** The handler
  called `playList(chart_id)`; it now opens the Playlists tab with the Charts
  filter selected. The home chart row was also hard-sliced to 3 entries.
- **Two "view all" links were dead.** `View All Releases` and `All 64 Artists`
  were `<a href="#">` with no handler. Both now list the full feed via the
  search grid (`browseCards`).
- **"Full Playback History" did nothing.** No handler at all; now jumps to the
  History view.
- Home playlist cards are clickable across their whole surface, not just the
  small hover play button.
- The hero banner is now clickable and keyboard-operable; its own buttons keep
  their own behaviour.

### Changed

- **Artwork is uniformly 96px in every list row.** Search, History, Downloads,
  Library favourites and the Home chart were all inconsistent (36 / 40 / 56 /
  64px). Row padding moved from `py-2.5`/`p-3` to `p-4` to match.
- Album/artist detail hero image: 160px → 256px.
- Lyrics panel header rebuilt: wordy `SYNCHRONIZED SCORE & SCRIPT` and the
  `LIVE` chip replaced by an icon + "Lyrics" + a theme-token `Live` dot, with
  three uniform 32px controls. `whitespace-nowrap` stops the labels wrapping
  onto two lines.

### Removed

Decorative copy and controls that asserted things the app does not measure:

- `CoreAudio Bit-Perfect` pill from the top nav bar.
- The Now Playing DAC strip: `ACTIVE DAC SESSION`, `SRC: … [Bit-Perfect]`,
  `JITTER < 0.05 ps`, and the Flat EQ / XFADE / Share buttons. (`XFADE` and
  Flat EQ had no logic behind them; the crossfade label was cosmetic.)
- The `SPECTRAL FLUID VELOCITY` panel and its `+14.2 LUFS PEAK` meter.
- `Bit-Perfect Buffer 1.2ms • 32 Master Streams Today` from the Home greeting.
- The Search screen's `Lossless Index • 82,410 Studio Captures` badge and the
  `QUICK QUERY ⌘K` hint. **The ⌘K/Ctrl+K shortcut still works** — only the
  visual hint was removed.

### Housekeeping

- Repository restructured: product docs to `docs/`, Stitch exports to
  `design/screens/` and `design/reference/`, binary downloads to `archives/`
  (git-ignored).
- Added `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`,
  `.editorconfig`; rewrote `.gitignore` for the new layout and to exclude
  agent/editor config and OS cruft.
- Doc references in `jiosaavn.rs` and `lib.rs` updated to `docs/architecture.md`.

---

## Known gaps

Not fixed, listed so they are not mistaken for oversights:

- **No front-end tests.** `main.js` is ~3,900 lines of imperative DOM wiring and
  `package.json` has no test runner. All UI changes above were verified by
  running the app. Adding a runner is the highest-value next step.
- **`recommend_songs` is unreachable** from the UI (see above).
- **Volume is app-local.** The miniplayer and Now Playing sliders set
  `audio.volume`, which does not move the Windows system volume. Replacing this
  with `IAudioEndpointVolume` is designed but not implemented — `windows` 0.62
  is already in the lockfile, so it needs only Cargo features.
- Tailwind and the icon font are fetched from a CDN at runtime.
- Sections of the UI remain Stitch placeholders (telemetry figures, "master
  stream" copy) rather than live data.
