# Recommendations on Android (Made For You)

Status: **implemented**. §§1–6 are the spec as written before wiring (kept so
later readers can see what was decided and why); §7 records the wiring and how
it was verified.

## 1. Problem

The hybrid recommender already exists and is unit-tested, but it is **dead
code on every surface**:

| Piece | State | Evidence |
|---|---|---|
| `app/src/mobile/recommend.js` | full hybrid engine — profile, 10 mixes, `shelfPlan` | 479 lines, exported |
| `app/tests/recommend.test.mjs` | 30+ assertions over it | `npm test` |
| Runtime import of `shelfPlan` / `buildProfile` | **none** | repo-wide grep: only `recommend.js` + its test mention them |
| What Android Home actually renders | 3 naive shelves: On Repeat / Recently Played / "Daily Mix" | `binders.js:497-521` calling `shared.js:829/836/852` |

So Home's "Daily Mix" is `count*2 + recency rank` — a play counter. It never
sees likes, downloads, country, language, time-of-day, or the calendar
rotation the test suite already specifies. Every signal the request lists
(analytics, history, liked songs, most-listened, country, language,
downloads) is collected by the app, and none of it reaches the shelf.

## 2. Signals → inputs

`buildProfile({ plays, favs, downloads, library, extra, country, now })`:

| Signal asked for | Storage key | Feeds |
|---|---|---|
| Analytics / history / most listened | `tm-plays` (`PLAYS_KEY`) | play counts, decay (14-day half-life), hour-of-day + weekday histograms |
| Liked songs | `tm-favorites` (`FAVS_KEY`) | +3 track weight, +4 artist/language affinity |
| Downloads | `list_downloads` → vault `DownloadEntry[]` | +2.5 ("intent to own"), the offline shelf |
| Saved / library + Spotify CSV imports | `tm-library` (`LIBRARY_KEY`) local playlist `tracks` | +2, imported playlists reach the profile |
| User-selected country | `tm-country` (`COUNTRY_KEY`) | `countryMix` via `REGION_LANGS` (`query.js:38`) |
| User-selected language | `tm-lang` (`LANG_KEY`) | `languageMix` — explicit pick overrides observed top language (new `language` option) |

`DownloadEntry` (`proxy.rs:115`) carries `id, title, artist, album, image,
duration_secs, at` — `at` maps to `ts`; it has no `language`/`year`, so
vault rows contribute identity + weight, never a language vote.

## 3. Shelves rendered (from `shelfPlan`, empty ones auto-dropped)

Daily Mix · Monthly Mix · daypart (Morning/Afternoon/Evening/Late Night) ·
`${lang} Picks` · Top in Your Region · On Repeat · Rediscover · Your
Favorites · Downloaded · Recently Played.

Daily seeds by local calendar day, monthly by `year*12+month`
(`hashSeed`/`mulberry32`), so a mix is stable inside its period and rotates
afterwards instead of reshuffling per repaint.

## 4. Design decisions

1. **One engine, one call site.** Home now calls `renderMadeForYou` and
   nothing else does. The three `shared.js` play-counter heuristics
   (`onRepeatMix`/`recentlyPlayed`/`dailyMix`) had **no other importer** once
   Home stopped calling them — verified by grep across `app/` — so they were
   deleted rather than left as a second, weaker answer to the same question.
2. **Render before the feed guard.** `mountHome` bails at `binders.js:303`
   when `home_feed` fails and no snapshot exists. Made-for-you is built from
   local logs only, so it runs *before* that return: personal mixes survive
   an offline cold boot.
3. **Reconcile, don't stack.** Sections are keyed `tm-shelf-mfy-<id>`; a
   remount deletes any `tm-shelf-mfy-*` section the new plan no longer has,
   so a shrunken profile can't leave a stale shelf behind.
4. **Every shelf owns a `setList` entry** (`data-list` = shelf key), so row
   taps, the heart, the download button and the overflow menu keep working
   through the existing global delegation.
5. **Downloads are best-effort.** `list_downloads` is awaited inside
   `try/catch`; in a browser preview (no IPC) the profile simply loses that
   signal instead of failing the shelf.
6. **Chip filter untouched.** New keys only match the `all` branch of the
   category-chip logic (`binders.js:446-465`), exactly like the three
   shelves they replace.

## 5. Out of scope (deliberate)

- **Spotify Web API / audio features (valence, tempo, energy).** There is no
  Spotify OAuth in this app; "Spotify data" today means the CSV importer
  (`app/src/importer.js`), whose playlists already reach the profile via
  `LIBRARY_KEY`. Live Spotify recommendations would be a separate feature
  needing credentials.
- **Collaborative filtering across users** — no server, single-device logs.
- **Rust-side changes.** None: everything is local JS over existing commands.

## 6. Gates

`npm test` · `npm run lint` · `npm run css` (no markup class added, but
re-run after any HTML change). `cargo` untouched.

## 7. Wiring (landed)

- `binders.js:renderMadeForYou` builds the profile and renders `shelfPlan`
  before the feed guard; sections are keyed `tm-shelf-mfy-<id>` and reconciled
  on remount.
- Inputs: `tm-plays` + `tm-favorites` + `tm-library` (local tracks) +
  `list_downloads` (vault) + `tm-country` + `tm-lang`, **plus** the `store.db`
  ledger (`getMostPlayed` / `getRecent` / `getStoredFavs`) as `extra`. The
  ledger is the analytics layer: counters survive restarts and outlive the
  100-row localStorage log. `recommend.js:normTrack` accepts the SQLite row
  shape (`play_count` / `last_played`) as well as the local `count` / `ts`, so
  both feed one profile.
- Verified: `tests/recommend.test.mjs` (25 tests, all green) covers the engine
  including the ledger shape; a throwaway headless-Chrome harness drove the
  real `MOUNT.home()` against stubbed IPC and rendered **9 shelves**
  (daily · monthly · daypart · language · country=IN · onrepeat · favorites ·
  downloads · recent) with 40/40 DOM assertions, including that a store-only
  `play_count` reached On Repeat. Harness deleted after the run; **not** yet
  exercised on a physical Android device.
