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

## 8. 2026-10-16d — Upgrade spec: signals → similarity → unified ranking

> Written before the code (repo rule 3). Status updates land in §8.6 as they
> prove out.

### 8.1 Why

Audit of the two stacks found: mobile Home runs a real hybrid engine
(`recommend.js`), but the endless radio on **both** surfaces re-ranks its
JioSaavn station batches with a thin heuristic (`scoreReco`: artist counts
without decay, album +1, drop the last 15 heard); the log keeps **aggregates
only** (`tm-plays` = one row per track, count + last ts, capped 100), so
nothing can mine *sequences*; and no negative signal exists anywhere (no
skip, no dwell, no "less like this"). Every cheap strong technique —
item-item co-occurrence, session k-NN, skip demotion, MMR diversity — needs a
play-event log first.

### 8.2 What this slice lands (discussion phases P0–P4)

| # | Piece | Where |
|---|---|---|
| 1 | **Play-event log**: bounded `play_events` table (id, ts, ended_at, ms_played, duration_secs, outcome complete/skip/partial, source, title/artist/image denorm) + `store_play_event` / `store_events` IPC. Captured on both surfaces at track transitions and natural endings. Survives `cache_clear` (user behaviour, not fetched data). Cap 3000 events. | `store.rs`, `lib.rs`, `store_db.js`, `playback.js` (desktop), `mobile/player.js` |
| 2 | **Shared pure module `taste.js`**: `classifyPlay` · `sessionize` (≤30 min gaps) · `buildCoOccurrence` (time-decayed; track + artist graphs; metadata catalog from events) · `neighborScores` (SB-kNN) · `negativeWeights` (skips) · `buildSignals` · `mmrRerank` (λ, per-artist cap, adjacency nudge) · `rerankBatch` (affinity + decay + similarity + negatives + freshness + ε-slot) · `similarShelf` · `replayHitRate`. No DOM, no storage, no network. | `app/src/taste.js` |
| 3 | **Unified radio reranking**: both `radio.js` files replace their local `scoreReco` internals with `taste.rerankBatch` over signals built from plays/favs/library/events; the "all repeats" pass becomes `{allowHeard:true}`. | `src/radio.js`, `mobile/radio.js` |
| 4 | **"Because you played X" shelf (mobile Home)**: anchor = most recent play whose co-listening row meets the neighbour floor; rows resolve from the event log's own denormalised metadata (station tracks are usually never cached). Hidden below the floor; reconciled under `tm-shelf-mfy-similar`. Desktop rail deferred to P7. | `mobile/binders.js` |
| 5 | **Tests**: `app/tests/taste.test.mjs` (classification, sessioning, decay, kNN, negatives, MMR caps, ε, replay metric beats a shuffled baseline) + store.rs unit tests. | both test trees |

### 8.3 Contracts

- `taste.js` stays pure so `node --test` covers it and the mobile boot gate
  still evaluates the whole graph on the phone shell.
- Store writes stay best-effort like every other call: no IPC → no events,
  and the radio falls back to plays-only signals (still decaying + diverse).
- Outcome rule: natural end → `complete`; else `ms_played/duration < 35 %`
  → `skip`; ≥ 80 % → `complete`; otherwise `partial`. Unknown duration →
  `partial`.
- A skip within 3 h hard-drops the track from radio picks; older skips only
  demote (decayed). Freshness demotion mirrors `recommend.js` (6 h / 24 h).

### 8.4 Acceptance

- `npm test` green including the new suite; `OP_OFFLINE=1 cargo test --lib`
  green; fmt/clippy clean.
- Live: a skip on the emulator appears in `store_events` with
  `outcome:"skip"`; the radio batch omits/reorders around replayed tracks;
  the similar shelf renders when the neighbour floor is met.
- `replayHitRate` on a synthetic chain clearly beats the shuffled-baseline
  rate — proves the kNN wiring, not just its shape.

### 8.5 Deferred (from the same discussion)

- P5: shelf-tap logging + Thompson rotation (needs UI feedback wiring first).
- P6: Spotify imports → pseudo-plays; feed `artist_recos` as a candidate pool.
- P7: desktop "Made for you" parity + the desktop similar rail.

### 8.6 As-built (2026-10-16e) — P0–P4 landed, gated, live-verified on both surfaces

All five pieces shipped. Two small additions beyond §8.2, both parity-driven:
`buildSignals` also takes the **current** track (seeds album/artist context)
and `scoreCandidate` gives **+1 for the same album as the current track** —
without them the `scoreReco` swap would have quietly lost the old album
signal.

| Piece | As built |
|---|---|
| **Play-event log** | `store.rs`: `play_events` (+ `idx_play_events_ts`), `PLAY_EVENTS_CAP=3000` pruned on every write, `events()` reading clamp 1..2000 oldest-first, unknown outcome coerced to `partial`; events survive `cache_clear`. 2 unit tests (round-trip order/coercion, prune-to-cap). `lib.rs`: `store_play_event` / `store_events` (limit default 400). `store_db.js`: `playEvent` / `getPlayEvents` best-effort wrappers (dynamic import on mobile — `store_db.js` reads `window` at top level). |
| **`taste.js`** | Pure engine, zero imports: `classifyPlay · leadArtists · cleanEvents · sessionize · buildCoOccurrence · neighborScores · negativeWeights · buildSignals · scoreCandidate · mmrRerank · rerankBatch · similarShelf · replayHitRate`. `leadArtists` duplicates `recommend.js`'s splitter by choice (taste must stay importable from the mobile shell without dragging the recommend graph; the two are independently unit-tested). |
| **Unified radio** | Both `radio.js`: `tasteSignals()` (store events + local logs) → one signal set; `scoreReco(cands, signals)` = `rerankBatch` then a `{allowHeard:true, eps:0}` fallback pass so the "everything is a repeat" case can still fill. Desktop keeps the export name. |
| **Recorder** | Desktop `playback.js`: `beginPlay` before each `pushPlay` (source `radio`/`queue`), flushes at `playQueueItem` top, `ended` (+ repeat-one), `finishFade` handover. Mobile `mobile/player.js`: same shape inside `start()`/`ended()`/`finishXfade`; source always `queue`. Never flushed on pause/pagehide — a paused song is one play (desktop hides to tray). |
| **Similar shelf** | `mobile/binders.js` renders `[data-shelf="tm-shelf-mfy-similar"]` after the mfy plan loop (reconciled: removes itself below the floor; `minNeighbors 6`); metadata comes from the log's own denormalised rows. |

**Sequence metric note.** `replayHitRate` ranks only *eligible* candidates —
the just-played tail (`heardWindow`, default 4 unique ids) drops out first,
mirroring the radio's own `heard` filter. Without that, a symmetric
co-occurrence graph always ranks the *backward* edge above the true next
track (measured 0.15 vs **0.98** with the filter on a synthetic 12-ring,
6 rounds; shuffled-id control ≤0.18). The suite pins ≥0.8 and shuffled <0.5.

**Live evidence (probes stay outside the repo in `%TEMP%\opencode\`):**

| Run | Result | What it proves |
|---|---|---|
| `taste-live-desktop.mjs` (CDP :9222, real `cargo build` binary) | **16/16** | search → trusted click → "Kesariya" plays; manual next → skip event `ms=4214 dur=268 source=queue` with real title; natural end of the next track → complete `ms=192749 dur=193`; auto-advance to a third track (ended listener intact); oldest-first reads; `store_stats.events` 4→7; 0 unhandled rejections |
| `taste-live-mobile.mjs` (CDP :9223, debug APK on Pixel6_API36) | **22/22** | same skip/complete pair on-device (`ms=5175 dur=357`; complete `ms=246387 dur=246`); chain alive after the natural end; **shelf E2E**: synthetic 7-track session → home remount → "Because you played Probe Taste 7" with ≥6 cards (measured 9: 6 injected probe ids + 3 real Kesariya neighbours from the session); 0 uncaught exceptions |

The desktop log also held `source:"radio"` rows from the running app's own
queue refills — radio-sourced items flow through the recorder with the right
label. The endless-radio *trigger* was not deliberately re-driven this round
(untouched code); the reranking itself is unit-covered (`rerankBatch` +
`scoreCandidate` matrices) — an end-of-queue live run is the natural next
gate when the radio path is touched again.

**Known, accepted (recorded so they are not re-discovered as bugs):**

- `ms_played` = **playhead position** at the transition, not accumulated
  listening time. A forward seek lifts it (the probe's seek-to-end reads as a
  full dwell); the product cases — early skip, full play, natural end —
  classify correctly. Accumulating timeupdate deltas was rejected: sparse
  ticks under tab throttling under-count.
- The mobile shelf E2E injected its 7 rows via `store_play_event` — the exact
  command the player uses; reaching the 6-neighbour floor through pure UI
  playback takes hours of listening.
- The ε-slot exists only inside `rerankBatch`; shelf-tap feedback and
  Thompson rotation stay deferred (P5).

### 8.7 Original-release preference (2026-10-16f — "prefer originals")

Search/radio listings must prefer the original recording over cover /
instrumental / karaoke re-uploads of it — without hiding anything.

- `jiosaavn::dedup_tracks` gains a final pass (`demote_version_uploads`): a
  row whose title is version-marked (`cover`, `tribute`, `instrumental`,
  `karaoke`, `lofi`/`lo-fi`, `8d`, `made famous by`, `in the style of`) moves
  to the end of the page **only when** an unmarked row with the same
  normalized title sits on that page. Never a filter — the row stays
  selectable, it just stops outranking the original.
- Keys: `version_key(marked)` = `norm_text` minus the marker words, compared
  against `norm_text(unmarked)` — so "Kesariya Lofi" buckets with "Kesariya"
  even unbracketed, and "Kesariya (Cover)" (whose bracket group `norm_text`
  deliberately keeps) buckets too.
- Deliberately NOT markers: `remix`, `live`, `acoustic`, `slowed`, … — those
  are label releases in their own right, not someone else's upload.
- Ceiling (accepted): a legit title that itself carries a marker word
  ("Cover Me") is demoted only when a same-key unmarked twin exists on the
  page; multi-word markers are substring tests on the raw title.
- Scope: every catalog listing already routes through `dedup_tracks` — search
  (`jiosaavn.rs::search_songs`), official entity pages and the radio pool
  (`official.rs`) — so one pass covers search, artist/album pages and radio.
  No `taste.js` change: the radio pool is deduped before it queues (§8.8 — the
  radio keeps upstream order and only gates eligibility).

### 8.8 Radio: the JioSaavn recommendation only — local engine removed (2026-10-16g)

Product directive (2026-10-16): **prefer the JioSaavn recommendations — do not
use the local taste engine** when the endless radio refills the queue. The
station batch *is* JioSaavn's recommendation for this listener; local affinity
on a thin log can distort it. Same "official source wins" rule the streaming
work follows (`docs/architecture.md` §5.5).

- Station batches, re-seeded batches **and** the last-resort fallback pools
  (artist search / charts) all queue **in the order upstream returned them**.
  `scoreReco` is gone from both `radio.js` files; nothing scores,
  MMR-diversifies or ε-injects in the radio path any more.
- The only local logic left is the **eligibility gate**
  (`taste.eligibleBatch`, lifted out of `rerankBatch`): one row per id, drop
  queued ids, drop the last-15-heard — retried with `allowHeard` when the whole
  batch would be dropped (the endless-mode contract) — drop tracks hard-skipped
  < 3 h ago. Queue hygiene, not ranking.
- `taste.pickBatch` (= gate + heard-retry + `limit`) is the single entry point
  both radios call: `pickBatch(fresh, signals)`.
- Taste-engine status after this: `rerankBatch` / `scoreCandidate` / `mmrRerank`
  stay in the module (unit-tested) but no longer rank radio batches; the mobile
  **"Because you played X"** shelf (`similarShelf`) still reads the same
  engine — flag it if that surface should change too.
- Supersedes the station-batch half of §8.2 P3 / §8.6 "Unified radio".

### 8.9 Search: JioSaavn's own ranking, no personal boosts (2026-10-16h)

Follow-up directive (2026-10-16): *for search also use the JioSaavn
recommendations* — the same "don't use our local taste engine" rule as §8.8.

- The relevance pass no longer adds personal boosts. `query.js::relevance`
  keeps text match, the query's own filters (language / year / artist / album /
  mood), JioSaavn's quality + popularity metadata and the Settings region —
  and drops the taste block (played +0.15 / liked +0.2 / artist-play counts).
  `rankTracks` stays stable: equal scores keep the order the API sent, so the
  list is JioSaavn's own ranking of the query.
- Both shells drop their `tasteContext` helpers (desktop `search.js`, mobile
  `searchkit.js`); the mobile shell passes only `{ region, moodOf }`.
- Unchanged — already JioSaavn or the listener's own history, not our engine:
  the suggestions dropdown (`search_suggestions` → JioSaavn
  `autocomplete.get`), the recent-searches rows, and "did you mean"
  (JioSaavn autocomplete + the listener's own earlier queries).
- The taste engine (`taste.js`) still exists for the radio eligibility gate
  (§8.8) and the mobile "Because you played X" shelf; nothing reads it for
  search any more.

### 8.10 Live verification (2026-10-17)

Both directives were verified on the real UIs, not on the test doubles. The
radio assertion: the queue tail must be an **in-order slice of the batch the
app actually consumed** (the eligibility gate may drop ids, but may not
reorder). Search: the live bundle's `relevance()` must ignore `played`/`liked`
while the region nudge survives. Probe scripts live in
`%TEMP%\opencode\` (outside the repo, per convention).

| Surface | Probe | Result |
|---|---|---|
| Desktop (real `cargo build` binary, CDP :9222) | `radio-order-desktop.mjs` — a `window.fetch` wrap captures each `recommend_songs` response; two `ensureReco()` flights through the live module | **13/13** — flight 1 queued `[43k5J4YX, O4aXuS_L, sIK0DHYF]` from batch `[H0IRhlNT, …, 43k5J4YX, u2flpAk4, fUMvktiR, O4aXuS_L, …]`: the leading ids were gate-filtered, the rest kept batch order; flight 2 identical shape; §8.9 live: warm = cold = 0.5 (taste ignored), region in 0.58 > out 0.5; 0 unhandled rejections |
| Android emulator (fresh debug APK, CDP :9223) | `radio-order-mobile.mjs` — response capture via a **CDP call breakpoint on `__TAURI_INTERNALS__.runCallback`** (see the capture note below); same two `ensureReco()` flights on a fake queue | **11/11** — flight 1 queued exactly the consumed batch in order (`[Hvma-gqd, wJB6BG9f, …, fy8dN2I_]` = batch, zero ids dropped); flight 2 the same; both flights read one station; the two tails continue one listing; §8.9 live identical to desktop; 0 unhandled rejections |

**Mobile capture note — Android does not use `window.fetch` for IPC.** The
WebView posts invoke requests through `__TAURI_INTERNALS__.ipc` (JNI) and
responses arrive by an eval of
`window.__TAURI_INTERNALS__.runCallback(id, data)`. `runCallback`, `ipc`,
`postMessage` and the `__TAURI_INTERNALS__` object itself are all
non-writable/non-configurable, and the CDP `Network` domain never sees the
request — so neither a fetch wrap nor a Proxy swap can capture anything. The
working channel: `Debugger.enable` + `Debugger.setBreakpointOnFunctionCall`
on the `runCallback` function object — each response pauses the page, the
probe reads `data` in the paused frame (`JSON.parse(data)` → the payload with
`station` + `tracks`), resumes, and removes the breakpoint at the end. Use
this in any future mobile probe that needs response payloads.

### 8.11 Source-first search results (2026-10-17)

Directive: *"show majorly from movie songs — if a song like Gaali Vaaluga is
from Agnyaathavaasi, show from this Agnyaathavaasi first; and for songs like
English mostly from singers, take from their official artist content."*

The catalog's own search for a song title returns that song's copies, not the
film's other songs (`"gaali vaaluga"` answers 2 rows) — so the pass has two
parts, both **query-intrinsic** (no taste, no history; §8.9 still holds):

1. **Group.** After `rankTracks`, a pure `sourceOrder` pass reads the anchor
   (rank 1) and re-orders stably — the whole list stays a permutation: rows
   belonging to the anchor's own *source* come first, everything else keeps
   its ranked order. The source is the **movie/album** for film-language hits
   (the catalogue's Indian languages: hindi, telugu, tamil, kannada,
   malayalam, marathi, punjabi, bengali, gujarati, odia, urdu) and the
   **artist** otherwise (english and other singer-driven rows). `albumKey`
   folds the catalog's naming so one movie's variants share a key —
   `'X - Official Remix (From "Movie")'` counts as `Movie` itself, and
   "(Original Motion Picture Soundtrack)"-style tags are dropped.
2. **Fetch.** Once page 1 paints, the shell asks `search_songs` for the
   source's own display name (`"Agnyaathavaasi"`, `"Imagine Dragons"`), keeps
   the rows that really belong to that source (deduped by id, at most 12
   additions), folds them into the stored page and repaints in place. The
   anchor always stays rank 1. Entity chips, named sorts, `hires`, later pages
   and offline mode skip it; any failure silently leaves the ranked page as
   it was.

**Refinement (same day, live finding).** The film's name very often travels in
the row's *title* — `'Tum Hi Ho (From "Aashiqui 2")'` — while its album field
is a compilation (`'Best Of Arijit Singh - Collection Of Romantic Songs'`).
Two consequences, both fixed:

- The source resolver reads provenance title-first: the `(From "…")` in the
  **title**, then the same in the album field, then the bare album name. The
  same resolution drives matching, so a film song lifted onto any compilation
  still matches the film's plan (an `Aashiqui 2` fetch keeps
  `'Tum Hi Ho (From "Aashiqui 2")'` rows whose album is an Emraan Hashmi hits
  collection).
- The exact-title bonus in `relevance` now compares the title with its
  `(From "…")` clause removed. Before, a cover whose bare title was a literal
  string match (`'Tum Hi Ho'` by Gurbani Bhatia, 315 k plays, album
  `Heartstrings`) beat the original (374 M plays) on the bonus alone — and the
  source pass then expanded the cover's own compilation, a wall of unrelated
  `Heartstrings` tracks. With the clause ignored the original's popularity
  decides, and its title names the real film to expand.

Pure helpers live in `query.js` (`albumKey`, `cleanTitle`, `leadArtists`,
`sourcePlan`, `sourceMatch`, `sourceOrder`, `sourceRows`); wiring is
`search.js::currentView` + `maybeMergeSource` on desktop and
`searchkit.js::rankForQuery` + `binders.js::mergeSource` on mobile. Unit
contracts: `tests/query.test.mjs`.

**UI rule:** the feature never names a provider — it shows the anchor's songs,
nothing else (branding guide, "Upstream attribution").

Live verification: §8.11a below.

### 8.11a Live verification (2026-10-17)

Probes are throwaway (`%TEMP%\opencode\`, outside the repo), driving the real
apps over CDP. Both force the tracks view before searching, then read the
rendered ranking back.

**Desktop — 12/12** (`sourcefirst-desktop.mjs`, CDP :9222, real `cargo build`
binary):

- `"gaali vaaluga"` — anchor `Gaali Vaaluga` (Anirudh Ravichander); 8/10 head
  rows from Agnyaathavaasi (Baitikochi Chuste, Swagatham Krishna, AB Yevaro Nee
  Baby, Dhaga Dhagamaney, Kodakaa Koteswar Rao, remix/lofi variants). The raw
  catalog page carried 2 rows for this query.
- `"believer"` — 10/10 head rows by Imagine Dragons (Evolve singles, Thunder,
  Bones, Demons, Bad Liar…); the first Cameron Collective cover sits at #16.
- `"tum hi ho"` — anchor `Tum Hi Ho (From "Aashiqui 2")` (374 M plays); 6/10
  head rows literally on the `Aashiqui 2` album, the rest carrying its
  `(From "Aashiqui 2")` provenance over compilation albums. *Pre-refinement
  the anchor was the 315 k-play cover (`Heartstrings`) and the head was that
  compilation's unrelated tracks.*
- Branding: `innerText` scan `/jiosaavn|saavn/i` clean on the search view,
  Settings → About, Settings → Terms and Now Playing; `#np-format` reads
  `320kbps` (tier only, no host).

**Mobile — 12/12** (`sourcefirst-mobile.mjs`, CDP :9223, debug APK 31.3 MiB on
`Pixel6_API36`, `x86_64`, `&cat=tracks`):

- `"gaali vaaluga"` — head = the remix + Baitikochi Chuste, Swagatham Krishna,
  AB Yevaro Nee Baby, Dhaga Dhagamaney, Kodakaa Koteswar Rao (6/8 head rows
  from the film); the hit itself is the top card. Tap-through played the
  resolved track (`t` advancing).
- `"believer"` — 10/10 head rows by Imagine Dragons (Evolve singles, live
  takes, Thunder, Bones…); the first Cameron Collective cover is at #17.
- `"tum hi ho"` — settled head: the `(From "Aashiqui 2")` takes, the album's
  regional versions, then the fetched soundtrack — Chahun Main Ya Naa, Sunn
  Raha Hai ×2, Hum Mar Jayenge, Milne Hai Mujhse Aayi, Piya Aaye Na, Aasan
  Nahin Yahan, Meri Aashiqui (5/8 head rows are soundtrack extras).
- Branding: scan clean on the search view, Settings → About, Settings → Terms
  and Now Playing; `#np-src` is gone (`getElementById` → null); `#np-qchip`
  reads `320kbps` — tier only.
- Probe trap: the merge lands ~1–2 s **after** the first paint, so a wait that
  accepts the first full row list reads the pre-merge page (the first tum hi
  ho read did — very nearly a false "merge broken on mobile"). The settled
  wait is the correct gate; no code change followed from it.
