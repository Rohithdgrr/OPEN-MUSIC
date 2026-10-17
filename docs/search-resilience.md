# Search resilience — "Search is down right now" must not persist

Status: implemented 2026-10-16 (desktop shell). Mobile parity is a later slice.
Owners of the behaviour: `app/src/search.js` (+ pure policy `app/src/searchretry.js`),
`app/src-tauri/src/official.rs`, `app/src-tauri/src/jiosaavn.rs`, diagnostics in
`app/src/core.js`.

## 1. The report

A search failed once against a transient upstream window and the UI stayed on
the card *"Search is down right now — retry in a bit."* until a manual click —
even though the very next probe seconds later answered fine. Screenshot
2026-10-16 ~00:33 IST, query "yaanji".

## 2. Evidence (live, 2026-10-16)

| Probe | Result |
|---|---|
| `search_songs "believer"` / `"tum hi ho"` (CDP, running app) | 9 / 85 tracks — upstream healthy |
| shell `api.php` ×16 parallel | all 200, 0.2–0.7 s |
| `search_entities` album / artist / playlist | 20 / 20 / 20 |
| `search_suggestions` | 3 songs |
| Mirror sweep (search + song contract) | `jiosaavn-api.vercel.app` **404** · `saavn-api.vercel.app` **404** · `jiosaavn-api-privatecvc.vercel.app` **404** · `saavn.dev` **connect fail** · `saavn.sumit.co` **200** (`data.results`, `downloadUrl` both verified) |

Conclusion: a transient window (upstream or local network — the app log showed
no captured stderr; a heavy parallel build ran in the same period), **not** a
standing outage. The defect is the recovery design, not the outage.

## 3. Root causes

- **R1 — single-shot primary source.** `official::call` (`official.rs:88`) had
  zero retries while every fallback host got retries + jittered backoff
  (`jiosaavn.rs` `MAX_RETRIES` / `backoff_ms`). One blip on one page doomed the
  whole search before fallback could absorb anything.
- **R2 — the fallback chain was mostly fiction.** 4 of 5 listed mirrors are
  dead (404 / refused). Only `saavn.sumit.co` can absorb a failure today.
- **R3 — the frontend gave up permanently.** One failed attempt → card. No
  timer, no automatic re-run; a network (or upstream) that healed one second
  later was never noticed. Recovery cost a click, every time.
- **R4 — diagnosis died with the panel.** `#diag` no longer exists in desktop
  `index.html` (removed in the 2026-10-09 desktop revert), so `diag()` was a
  no-op and the raw error naming the failed host was discarded. The exact
  trigger of the 00:33 incident is therefore **unrecoverable** (accepted
  limitation; this fix makes the next one diagnosable).

## 4. The fix

### F1 — auto-retry ladder (`search.js` + `searchretry.js`)

After a failed search the app re-runs it silently on a bounded ladder:

| failure # | wait before next attempt |
|---|---|
| 1 | 1.5 s |
| 2 | 4 s |
| 3 | 15 s |
| 4 | 45 s |
| 5+ | stop — the card stays, manual Retry restarts the ladder |

The ladder resets on every new search, every navigation away, and every manual
Retry. While an attempt is pending the card copy gains " Retrying…". Applies to
first page and "Load more" alike. A valid empty answer ("No tracks found") is
an `Ok` — it is never auto-retried. The pure policy lives in
`app/src/searchretry.js` so it is unit-tested like `quota.js` / `spotmatch.js`.

### F2 — recovery without a click (`search.js`)

- The ladder (F1) handles the "upstream hiccup, network never dropped" class —
  the class of the reported incident.
- If the failure happened while offline, no timers are burned; the browser
  `online` event re-runs the failed query as soon as the connection returns.
  Gated on the card's own Retry action (`#error-retry`) so unrelated error
  boxes are left alone.

### F3 — Retry button single-flight (`search.js`)

Click disables the button before the re-run; the re-render replaces it with
fresh state either way. Double-click can no longer double-fetch.

### F4 — one calm retry on the primary source (`official.rs`)

`call()` now makes up to 2 attempts. A transport error, a 5xx, or a 429 with a
short `Retry-After` earns one jittered backoff (`jiosaavn::backoff_ms`, ±25 %)
and one more try. 4xx answers and malformed bodies are final — business
answers are never retried. This is the same policy the mirrors already
followed; official was the only source without it.

### F5 — the mirror list is honest (`jiosaavn.rs`)

Listed hosts must serve `/api/search/songs` (`data.results`) **and**
`/api/songs/{id}` (`downloadUrl`). The 2026-10-16 sweep leaves only
`saavn.sumit.co` alive and shape-verified; the four dead hosts were removed.
Re-run the sweep (below) before adding any host back.

Mirror sweep command (node ≥ 20, no deps):

```js
for (const h of HOSTS) {
  const r = await fetch(`${h}/api/search/songs?query=arijit&limit=5&page=1`);
  const j = r.ok ? await r.json() : null;
  console.log(h, r.status, j ? j.data.results.length : "-");
}
```

### F6 — diagnostics ring (`core.js`)

`diag()` keeps its last 40 lines in memory even with no panel; devtools (or a
CDP probe) reads them with `__tmDiag()`. `docs/feature-list.md` §1 corrected to
match reality.

## 5. Acceptance criteria

1. Transient failure (first N upstream calls fail, then pass): rows appear with
   **zero user actions**, within one ladder step of the upstream healing.
2. Sustained failure: card shown once; ladder stops after the 45 s attempt; no
   unhandled rejections.
3. Empty answer: "No tracks found" card; no auto-retry scheduled.
4. Offline: card without timers; on `online`, the query re-runs by itself.
5. No regression: normal search, "Load more", entity chips, suggestions.
6. Rust: `retryable()` unit-tested; normal search live-verified post-rebuild.

## 6. Verification record

Run 2026-10-16 (desktop debug build `cargo build` + CDP `:9222`). Fault seam:
desktop invokes ride a custom-protocol fetch (`http://ipc.localhost/<cmd>`);
the probe wraps `window.fetch` and answers selected `search_songs` calls with
the exact transport error shape (`Tauri-Response: error` + text body). Every
layer above the transport is shipped code. Driver:
`%TEMP%\opencode\search-retry-verify.mjs` (throwaway, outside the repo).

| Check | Result |
|---|---|
| A — first call fails, next succeeds | card flashes with "Retrying…", heals at **1 503 ms** (the 1.5 s ladder step), zero clicks, 5 rows |
| B — 3 failures (the reported scenario) | card persists at 6.5 s; heals by itself at **~20.5 s** (1.5+4+15 s schedule), 47 rows, zero unhandled rejections |
| C — valid empty answer | "No tracks found" card, **no "Retrying…"**, exactly one upstream call |
| D — `online` event with card up | re-runs the query after **606 ms** (ahead of the 1.5 s ladder) |
| E — regression | normal search 79 rows; "Load more" grew to 108 |
| F — hygiene | `__tmDiag()` kept the raw errors; 0 unhandled rejections |
| Rust | `retryable()` unit test; `cargo test --lib` **214/214**; fmt/clippy clean |
| JS | `npm test` **440/440**; eslint clean on touched files |

**Trap (cost one probe iteration):** `window.__TAURI_INTERNALS__` and every
property on it are **non-writable, non-configurable** — assigning
`internals.invoke = wrapper` fails silently. The wrap-able seam is the
transport below the internals: desktop invokes are `fetch()` calls to
`http://ipc.localhost/<cmd>` (headers `Tauri-Callback`/`Tauri-Error`, response
header `Tauri-Response`), so `window.fetch` interception is the honest
injection point. Backend `official::call` retry is unit-tested plus covered by
the E1 live regression (real upstream through the primary source); a Rust-side
fault was not simulated — stated limitation.

## 7. Non-goals

- Mobile parity — `app/src/mobile/binders.js` has its own single-shot search;
  next slice, same policy.
- Circuit breaker / background prefetch / request coalescing: already scoped in
  `docs/cache-architecture.md` (C3, C6).
