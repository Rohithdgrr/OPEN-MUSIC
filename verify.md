# Verify — mobile mini-player, library, downloads + SQLite store

What this covers: the uncommitted work in `app/src/mobile/*`,
`app/src/store_db.js`, `app/src-tauri/src/store.rs|lib.rs|proxy.rs`
(see [CHANGELOG](CHANGELOG.md) `Unreleased/Added` and
`docs/feature-list.md` §§3–5, 7). Nothing here is committed yet.

> Build from a **native Windows terminal** (PowerShell), not WSL. The WSL
> cross-FS (`/mnt/c`) makes cargo 2–3× slower, and WSL's node is v18 while
> Windows has node v24 (ESLint's stylish formatter crashes on node 18).
> Verified present on this machine: node v24.11.0, Java 17.0.12,
> `ANDROID_HOME=C:\Users\rohit\AppData\Local\Android\Sdk`, NDK 27.2.12479018,
> build-tools 34/36, AVD `Pixel6_API36`, Windows cargo 1.98.1 with
> `aarch64/armv7/i686/x86_64-linux-android` targets, adb 37.0.1.

## 0. Batch status — 2026-10-04 (search, filters, playlist naming, buttons)

### Done — code complete, in the x86_64 release APK on the emulator

- **Search result volume (Rust)** — `jiosaavn.rs`: `search_songs` now merges
  `UPSTREAM_SPAN = 4` upstream pages per app page (`upstream_pages()` +
  `fetch_search_page()`, official first, mirror fallback) because upstream
  page 1 for common queries came back degenerate (28/30 identical rows →
  dedup collapsed 30 → 2 songs). `page_full` measured pre-dedup so load-more
  is honest. Unit tests added.
- **Search screen crash fix** — `mountSearch` read `entityKinds` in the
  sort-chip guard *before* its `const` declaration (TDZ): every search mount
  threw `ReferenceError: Cannot access 'entityKinds' before initialization`
  and rendered nothing (caught by `onSmount` → red toast). Declaration moved
  above the chip wiring (`binders.js`).
- **Loading skeletons** — `#sm-results` is created before the fetch and
  seeded with `.tm-skeleton` rows (or a 6-cell grid for entity categories);
  the mock "Top result" section is hidden while the query is in flight.
- **Auto-load on scroll** — `IntersectionObserver` (`smMoreIO`,
  rootMargin 300px) on the "Load more results" button; the button stays as
  the manual fallback.
- **In-screen filters** — album `#detail-filter`, playlist "Filter tracks…"
  input (new in `playlist.html`), liked `#liked-filter`, all via
  `wireRowFilter()`; shows a "No matches" line when nothing survives;
  `window.filterLibraryList` shim silences the fragment's inline `oninput`.
- **Playlist naming** — `+` and Rename open the themed bottom-sheet input
  (`openInputSheet`/`createPlaylistSheet`/`renameLocalPlaylist` in
  `menus.js`); native `prompt()` is broken in the Android WebView.
  `window.promptCreatePlaylist` delegates to `window.__tmCreatePlaylist`.
- **Search entity cards** — the "Results" label was the empty first grid
  cell and shelf-sized cards overlapped; label moved above the grid, cards
  fill their cell.
- **Bugs found by on-device verification, all fixed in `binders.js`** —
  `mountSearch` TDZ crash on `entityKinds` (every search mount threw);
  top-result wiring landed on the art thumbnail instead of the card (dead
  top Play/Favorite); sort chip called `go()` with an unchanged hash so no
  remount happened (sort now rides in the URL as `&s=`); Pause All
  label/icon only refreshed while a batch was active (moved out of the
  active-only branch).
- Gates: `npx eslint src` clean, `npm test` 66/66, `cargo test --lib`
  search/dedup/live tests pass.

### Verified on device (Pixel6_API36, CDP)

- [x] Search skeleton: 18 `.tm-skeleton` rows paint during load, mock Top
      hidden while loading, 0 skeletons after, no error toast.
- [x] Search volume: 52 song rows on page 1 for "love" (span-4 merge);
      "Load more results" present; scroll auto-load grew 52 → 125 rows.
- [x] Search chips: Albums chip → `#/search?q=love&cat=albums`, 30 grid
      cards; ✕ clear empties the field; recent-search pill re-runs its query
      (81 rows); live suggestions show (13 rows) and a song tap plays.
- [x] Top-result card: Play navigates to NowPlaying and starts the exact
      track (widget title match); Favorite toggles FILL 0 → 1.
- [x] Album detail: header Play is wired (`data-list=detail/idx=0`),
      navigates to NowPlaying; Shuffle starts a different track.
- [x] Mini-player: visible with art/title/artist; all 6 buttons ≥ 40 px;
      next/prev change track; fav toggles; repeat cycles
      repeat → repeat_one → off; tap opens NowPlaying; hidden on NowPlaying;
      shuffle toggle persists to the NowPlaying `shuffle-btn`.
- [x] Playlist create: `+` opens the bottom-sheet input (white, 33.9 vh),
      creates the named list; duplicate name rejected with
      "already have a playlist with that name" (count stays 1).
- [x] Playlist rename: kebab → sheet → Rename prefills the current name,
      saves, old name gone, detail header shows the new name.
- [x] Playlist delete: confirm sheet → record gone.
- [x] Remove-from-library: kebab on a saved entity offers
      "Remove from library"; removes by `id`, the other same-titled record
      survives, rest of library intact.
- [x] In-screen filters: album (7 → 0 rows + "No matches" + restore),
      liked (2 → 0 + "No matches" + restore); library search filters live.
- [x] Three-dots sheet: themed white (`bg-surface-container-lowest/95`),
      height ≤ 40 vh.
- [x] Downloads: single track → In-Transit card with % + MB + Cancel;
      Cancel drops the backend entry, toasts "Cancelled …", and the
      In-Transit block vanishes (rows also cleared from the DOM);
      Pause All flips Pause → Resume → Pause with matching toasts even with
      zero active rows; storage line real (`7 tracks · 84.6 MB vaulted`);
      pills All/HQ/Standard filter; sort cycles RECENT → NAME → SIZE;
      search filters without losing the list; Wi-Fi toggle persists across
      remounts.
- [x] SQLite: `store.db` + WAL present on device and growing; deleting it →
      recreated on relaunch, vault intact, Home renders Recent + Most Played
      with zero errors; airplane-mode relaunch serves saved Home + snapshot
      search results with an offline banner.
- [x] `npx eslint src` clean, `npm test` 66/66.

### Final gate — build #6 (installed 2026-10-04 ~22:2x, x86_64 release)

- [x] Sort chip: RELEVANCE → QUALITY, `#/search?q=love&s=bitrate`.
- [x] Cancel: 1 active row → 0 rows, In-Transit block hidden.
- [x] Pause All: Pause All → Resume All → Pause All, correct toasts, wired
      on a fresh mount with zero active rows.
- [x] Final screenshots (search: top-result card + 52 result rows, all
      controls aligned; downloads: `9 tracks · 98.8 MB vaulted`, pills,
      sort, search, rows with delete/kebab/play) — reviewed, then deleted
      per the no-test-screenshots rule.
- [x] `npx eslint src` clean, `npm test` 66/66.

## 1. Frontend checks (fast, Windows PowerShell)

```powershell
cd "C:\Users\rohit\Music\OPEN MUSIC\app"
npm run css
npx eslint src/store_db.js src/library.js src/search.js src/mobile/shared.js src/mobile/binders.js src/mobile/app.js src/mobile/menus.js
```

Expected: no output = clean. (`npm run lint` over all of `src/` also works
on node 24; on WSL node 18 the formatter itself crashes, ignore that.)

## 2. Rust checks (no full build)

```powershell
cd "C:\Users\rohit\Music\OPEN MUSIC\app\src-tauri"
cargo fmt --check -- src/store.rs   # store.rs must be clean (rest of tree isn't)
cargo test store::                  # AppStore unit tests: put/get, plays, favs, kv, search TTL
```

## 3. Build the debug APK (x86_64 = emulator arch)

```powershell
cd "C:\Users\rohit\Music\OPEN MUSIC\app"
node node_modules/@tauri-apps/cli/tauri.js android build --target x86_64 --apk --debug
```

Expected: `BUILD_EXITCODE=0` equivalent (exit 0), APK at
`src-tauri\gen\android\app\build\outputs\apk\x86_64\debug\app-x86_64-debug.apk`.
Release (slower, what CI ships): replace the last line with
`node node_modules/@tauri-apps/cli/tauri.js android build --target aarch64 x86_64 --split-per-abi --apk --ci`.

## 4. Emulator: boot, install, launch

```powershell
$sdk = "C:\Users\rohit\AppData\Local\Android\Sdk"
& "$sdk/emulator/emulator.exe" -avd Pixel6_API36
# new terminal:
& "$sdk/platform-tools/adb.exe" wait-for-device
& "$sdk/platform-tools/adb.exe" shell "getprop sys.boot_completed"  # repeat until 1
& "$sdk/platform-tools/adb.exe" install -r "C:\Users\rohit\Music\OPEN MUSIC\app\src-tauri\gen\android\app\build\outputs\apk\x86_64\debug\app-x86_64-debug.apk"
& "$sdk/platform-tools/adb.exe" shell am start -n com.openmusic.trancemusic/.MainActivity
```

Smoke log (filter backend + WebView errors):

```powershell
& "$sdk/platform-tools/adb.exe" logcat -c
& "$sdk/platform-tools/adb.exe" logcat | Select-String "TRANCE|chromium|Console|FATAL"
```

## 5. Functional checklist (on the emulator)

### Mini-player (`mobile/app.js` `#tm-widget`, every screen except NowPlaying)
- [ ] Play something → bar appears with art/title/artist; hidden on NowPlaying.
- [ ] Shuffle button toggles blue + persists to NowPlaying `shuffle-btn`.
- [ ] Download the track → green ⬇ badge appears on the widget art.
- [ ] Buffering shows a lighter fill behind the dark progress fill.
- [ ] Airplane mode + undownloaded queue → artist line reads
      "Offline — not downloaded"; vaulted track → plays, line reads
      "Offline — playing from vault".
- [ ] All buttons ≥40 px, no overlap at 360 px width.
- [ ] Swipe left/right on bar = next/prev; swipe up = opens NowPlaying.

### Library (`main-library` screen + `menus.js` sheet)
- [ ] `+` opens the bottom-sheet input (NOT a native prompt), creates list.
- [ ] Duplicate name → "already have a playlist with that name", no dup.
- [ ] Kebab on a local playlist → Rename (sheet, updates header via callback)
      and Delete (confirm sheet → removes list, tracks stay in Library).
- [ ] Kebab on a saved (non-local) entity → "Remove from library" removes by
      `id`, other same-titled items survive.

### Downloads (`download` screen)
- [ ] Start a download → In-Transit card appears with % + MB + Cancel.
- [ ] Cancel → row vanishes; when the backend lands the file it is deleted
      (best-effort: no backend abort channel — note the limitation).
- [ ] `Pause All` → batch stops after current track, label flips to Resume.
- [ ] Wi-Fi toggle persists across remounts; ON + cellular → downloads refuse
      with "Wi-Fi only" toast.
- [ ] Pills filter All / HQ 320 / Standard; sort cycles RECENT/NAME/SIZE;
      search filters without losing focus during progress ticks.
- [ ] Storage line shows real `N tracks · X MB`.

### SQLite store (`store.db`, both shells)
- [ ] Play a track, fav/unfav it, run a search → no error toasts (all
      store writes are fire-and-forget).
- [ ] On-device DB exists and grows (needs one run first):
      `adb shell run-as com.openmusic.trancemusic ls -l files/TRANCE\ MUSIC/..`
      → `store.db` present next to the vault dir; `databases/` equivalent.
- [ ] Airplane-mode relaunch → Recent/Most-played still served from
      `store_recent`/`store_most_played` (localStorage fallback covers the
      rest — a missing store must never block playback).
- [ ] `store.db` deleted manually → app recreates it on next launch, zero
      user files lost (audio lives in the vault, not SQLite).

## 6. Known limitations (do not file as regressions)

- Cancel is UI-best-effort: `download_song` has no abort channel; bytes keep
  flowing and the finished file is removed after landing.
- Debug APK only for the emulator; release is `--target aarch64 x86_64
  --split-per-abi --apk --ci`.
- `app/tests/sleep.test.mjs` (2 cases) fails on WSL node 18
  (`MockTimers.enable` arg-type) — pre-existing, unrelated to this work.
- `cargo fmt --check` is dirty tree-wide (pre-existing); only `store.rs`
  is held to clean.
