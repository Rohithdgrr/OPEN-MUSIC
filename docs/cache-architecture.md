# Cache architecture — "load once" policy (spec of record)

Status: **slice 1 implemented** (2026-10-15) — see §5 for the evidence log.
Scope: desktop + mobile share one Rust cache core (`proxy.rs`, `cache.rs`,
`store.rs`, `lyrics.rs`) behind both surfaces; this doc governs all of it.

## 1. Goal

Every screen, track, search and lyric resolves from the *closest* tier that
can answer — instantly — and the network is asked at most once per thing per
freshness window. When the network disappears, nothing that was ever seen
turns into an error screen.

### The five "load once" rules

1. RAM hit → never fetch, never show a spinner.
2. Any tier has data (even aged) → paint immediately, refresh behind the
   paint — no skeleton flash.
3. Same key already in flight → join it, never fire a second request.
4. Fetch failed but an aged copy exists → serve the aged copy, keep working.
5. Known-offline → fail fast (today: frontend gates via `net.js`; the
   Rust-side circuit breaker is the next slice).

## 2. Tier inventory (verified 2026-10-15)

| Tier | Content | Where | Freshness |
|---|---|---|---|
| L0 JS mem | search mem-map + snapshot, suggestions, vault ledger | `mobile/binders.js` (`SEARCH_MEM`), `search.js` (`tm-search`) | session / `RESULT_FRESH_MS` |
| L1 Rust RAM (moka, LRU + TTL) | resolved songs, qualifier probes, search pages, entities, suggestions, playlist/album tracks, artist pages, overview, lyrics | `proxy.rs` `AppState` (`L1_TTL` 6 h, `L2_TTL` 30 m, `L4_TTL` 30 d) | TTL |
| L2 disk files | art bytes, lyrics JSON; 500 MB LRU budget, atomic writes | `cache.rs` (`LYRICS_TTL` 30 d unread-sweep) | mtime + budget |
| L2 SQLite (`store.db`) | songs (5000), search pages (200, now 7 d), lyrics KV (1000/30 d), entities (300/24 h), KV, outbox | `store.rs` | per-table TTL |
| L3 network | jiosaavn / official mirrors / LRCLIB / BetterLyrics | `jiosaavn.rs`, `official.rs`, `lyrics.rs` | 15 s connect, 25 s total |

## 3. Policy

Per tier: **fresh** (serve, no network), **revalidate** (serve instantly,
refresh behind — painters always revalidate when online), **evict** (LRU +
budget; TTL is an *unread* window, not a validity deadline).

- **Errors are never stored** — a provider that was down is not an answer.
- **Empty answers never beat content** — a no-content provider result must
  not replace or outrank a stored copy that has content.
- **Immutable content gets long windows** — lyrics/art are written once;
  TTLs bound *cleanup*, not usefulness.
- **Stale-serve never promotes** — serving an aged file must not touch its
  mtime, so the next online open still revalidates.
- Search pages keep one freshness story on both surfaces: a store.db hit is
  always revalidated online (mobile `binders.js runSearch`, desktop
  `search.js doSearch`), so a long TTL only widens offline coverage.

## 4. Slice 1 (this round)

| # | Change | Files |
|---|---|---|
| S1 | **Single-flight**: `memo()` now uses `moka::try_get_with` — concurrent asks for one cold key run the fetch once; errors still never stored | `proxy.rs` |
| S2 | **Lyrics stale-if-error**: RAM → disk (30 d freshness) → providers; on provider failure/empty, an aged disk copy is served with `stale: true`, mtime untouched | `proxy.rs`, `lyrics.rs`, `cache.rs` |
| S3 | **Counters**: `fetches`, `upstream_errors`, `stale_served`, `disk_hits` since launch, exposed as `cache_stats().counters`; reset by `cache_clear` | `proxy.rs`, `cache.rs`, `lib.rs` |
| S4 | **Desktop search cache-first**: `store.db` pages under `d:` keys paint immediately (and offline) for any previously-run query, network supersedes when it lands | `search.js` |
| S5 | **Search TTL 6 h → 7 d** (delete window; both surfaces still revalidate online on every disk hit) | `store.rs` |

Verification: Rust unit tests (`memo_coalesces_concurrent_same_key`,
lyrics stale-serve suite), `OP_OFFLINE=1 cargo test --lib`, `npm test`,
`eslint`, `cargo fmt/clippy`. Live: repeat-search probe counts upstream
calls (deferred to the C9 harness).

## 5. Evidence log

- **2026-10-15, slice 1** — implemented + gated (commands run in
  `app/src-tauri` unless noted):
  - `OP_OFFLINE=1 cargo test --lib` → **210 passed / 0 failed** (was 206;
    +4 new: `memo_coalesces_concurrent_same_key`,
    `lyrics_serves_aged_disk_copy_when_providers_fail`,
    `lyrics_fresh_disk_copy_skips_providers`,
    `empty_answer_never_erases_stale_content`; `memo_fetches_once_per_key`
    extended)
  - `cargo fmt --check` → exit 0 · `cargo clippy --all-targets -- -D warnings`
    → exit 0
  - `npm test` → **413/413** · `eslint src/search.js` clean ·
    `node --check search.js net.js` clean
  - In-flight fix: `cache::tests::enforce_evicts_lru_and_stale_lyrics` aged a
    lyrics file 8 d; past `LYRICS_TTL` (30 d) that is not stale, so the test
    now ages `LYRICS_TTL + 1 h`.
  - **Not yet verified live**: repeat-search counter deltas across two real
    searches — deferred to the C9 harness; unit tests prove the wiring, not
    the live hit ratio.
  - Full session record: `AGENTS.md` 2026-10-15e.

## 6. Roadmap (next slices, in priority order)

- **C2 — persistent metadata breadth**: wire the existing-but-unused
  `entityCacheGet/Put` (24 h, 300 rows) into both surfaces' artist/album/
  playlist screens; store desktop entity pages too.
- **C3 — circuit breaker**: Rust-side consecutive-failure tracker, short
  stale-path timeout, `net_state` event consumed by `net.js`; fast-fail
  with aged data instead of 15–25 s timeouts on flaky networks.
- **C5 — SWR screens**: artist/album/playlist/charts paint-from-cache then
  silent refresh (generalize the `home.js` snapshot + mobile `saveSnap`
  pattern); "showing saved data" badge.
- **C6 — warm-up**: desktop next-track resolve/first-bytes prefetch (mobile
  has `prefetchTrackBytes`); idle art warming for visible rows.
- **C9 — harness**: offline scenarios (emulator airplane mode, desktop net
  cut) with request-count assertions; hit-ratio dashboard.

## 7. Acceptance criteria

1. Repeat same search/artist within freshness: **0 new fetches** (counters).
2. 10 concurrent identical requests → **exactly 1** fetch (unit test).
3. Network cut with a previously-fetched song: lyrics still render
   (`stale: true`), no error screen.
4. Restart offline: home + last search render from disk, no skeleton.
5. Metrics: `cache_stats().counters` proves 1–4.

## 8. Non-goals

No negative/error caching, no service worker, no audio byte cache beyond the
vault, no change to vault or budget semantics, no custom eviction engine.
