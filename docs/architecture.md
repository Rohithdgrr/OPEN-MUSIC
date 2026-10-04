# Architecture — TRANCE MUSIC

Companion to `PRD.md`. This document describes the **structure** of the system: components, contracts, data flows, concurrency, trust boundaries, and the design techniques behind them. Cross-platform feature coverage lives in [`feature-list.md`](feature-list.md).

---

## 1. Style

A **three-layer client architecture** with an **in-process reverse proxy** in front of media, and two front ends over one Rust core:

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRESENTATION                                                        │
│   DESKTOP  app/src/index.html + main.js → 28 ES modules (+ widget)   │
│   MOBILE   app/src/mobile/index.html → hash router, 13 screens       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  Tauri IPC  (window.__TAURI__.core.invoke)
┌───────────────────────────────▼─────────────────────────────────────┐
│  APPLICATION    app/src-tauri/src/lib.rs                            │
│                 48 commands · DTO shaping · lifecycle · cfg gates   │
└──────────────┬───────────────────────────────┬──────────────────────┘
               │                               │
┌──────────────▼──────────────┐  ┌─────────────▼──────────────────────┐
│  DOMAIN / PORT              │  │  TRANSPORT                        │
│  official.rs (primary)      │  │  proxy.rs (axum, 127.0.0.1)       │
│  jiosaavn.rs (mirror)       │  │  /stream · /art · vault reads     │
│  models · probes · quality  │  │  AppState: moka caches + clients  │
└──────────────┬──────────────┘  └─────────────┬──────────────────────┘
               │                               │
               ▼                               ▼
     https://www.jiosaavn.com          https://*.saavncdn.com
      (+ MIRRORS fallback)                 (audio bytes)
```

Chosen for: **small surface, no build step, one process, one state object, testable at every seam.**

---

## 2. Component Inventory

| Component | File | Responsibility | Must NOT do |
|---|---|---|---|
| **Desktop shell** | `index.html` | DOM structure, 8 views, load order | contain logic |
| **Desktop controller** | `app/src/main.js` (159-line entry) + 28 feature modules | render, queue, history, telemetry, IPC calls | know wire formats |
| **Mobile shell** | `app/src/mobile/index.html` + `router.js` | hash routing, 13 screens, hardware back | duplicate desktop logic |
| **Theme** | `styles.css` + `tailwind.css` | tokens, layout, states | hard-code content |
| **Command surface** | `lib.rs` | register commands, assemble DTOs, own app lifecycle, `cfg(desktop)` gates | talk HTTP directly |
| **First-party source** | `official.rs` | `www.jiosaavn.com` search/details, DES media-url decryption, rendition synthesis | know about HTTP servers |
| **Catalog adapter** | `jiosaavn.rs` | source failover (official → mirrors), models, quality selection, range probing | know about HTTP servers |
| **Media relay** | `proxy.rs` | localhost server, Range forwarding, moka caches, vault, SQLite ledger | parse catalog JSON beyond what resolve needs |
| **Entry** | `main.rs` | `app_lib::run()` only | anything else |

### 2.1 `AppState` — the single shared state

```rust
pub struct AppState {
    pub client:   reqwest::Client,   // metadata + probes: 25 s TOTAL timeout
    pub media:    reqwest::Client,   // bodies: connect/read timeouts only
    pub port:     u16,               // ephemeral, known before window load
    pub vault:    PathBuf,           // app data dir / "TRANCE MUSIC"
    pub resolved: moka::Cache<String, Song>,    // id  -> song  (L1, 6 h TTL)
    pub qualified: moka::Cache<String, Probe>,  // url -> probe (L2, expires with url)
    pub search_cache:  moka::Cache<String, Vec<Track>>,
    pub lyrics_cache:  moka::Cache<String, Lyrics>,
}
```

`Arc<AppState>` is registered with `app.manage(...)` **and** given to `axum::serve`. One allocation, two consumers — the Tauri command path and the proxy path share the same caches, so a resolve performed by the UI is instantly visible to the relay and vice versa. Caches are **bounded** (capacity + TTL), so a long session cannot grow memory without limit.

---

## 3. Data Models

### 3.1 Domain types (owned by `jiosaavn.rs`)

```rust
Track {
  id, title, artist, album,
  duration_secs,   // raw seconds from the catalog
  duration,        // "4:22", preformatted for display
  image,           // largest artwork URL
  page_url         // canonical jiosaavn.com link
}

QualityUrl { quality: "320kbps", url: "https://aac.saavncdn.com/…" }

Song     { track: Track, qualities: Vec<QualityUrl> }

PlayableAudio {
  id, title, artist,
  direct_url,      // chosen CDN URL (diagnostics)
  proxy_url,       // http://127.0.0.1:<port>/stream?u=<encoded>
  qualities, chosen_quality,
  content_length,  // from Content-Range total
  host,
  range_status
}

RangeStatus = Unrestricted | RestrictedFirstMb | Dead
             // serialises to "unrestricted" | "restricted_first_mb" | "dead"

Probe { range_status, content_length }   // Copy, memoised
```

### 3.2 Why both `direct_url` and `proxy_url`

The UI plays `proxy_url` (same-origin, allow-listed, observable). `direct_url` stays in the DTO for diagnostics, for an eventual "copy stream URL" action, and for tests. Neither is ever logged wholesale in release builds.

### 3.3 Defensive parsing

Mirror JSON is navigated with `serde_json::Value` + helpers (`text()`, `number()`, `best_image()`, `artist_names()`) rather than rigid structs. Rationale: the mirror's schema has optional/null fields (`releaseDate: null`, `playCount: null`) and adding a field upstream must not break the client. Trade-off: less compile-time safety — compensated by contract tests that assert real responses.

---

## 4. Contracts

### 4.1 IPC commands (frontend ⇄ Rust)

**48 commands** are registered in `generate_handler!` (`lib.rs:1353`). The full
list, including which are `#[cfg(desktop)]` and which return explicit errors on
mobile, is tabulated in [`feature-list.md`](feature-list.md). Core commands:

| Command | Args | Returns | Errors |
|---|---|---|---|
| `search_songs` | `query`, `limit?`, `page?` | `Track[]` | `"empty query"`, source HTTP/decode errors |
| `resolve_song` | `id`, `quality?` | `PlayableAudio` | invalid id, not found, no qualities, source errors |
| `qualify_url` | `url` | `RangeStatus` | non-https, non-allow-listed host |
| `proxy_base` | — | `String` | — |
| `api_version` | — | `u32` (currently `1`) | — |

**Conventions**

- Errors are `Result<T, String>` — human-readable, shown verbatim in the error banner and diagnostics.
- Field names are `snake_case` on the wire (`#[serde(rename_all = "snake_case")]`).
- Optional args are omitted by the caller, not sent as `null`.
- No command accepts a raw URL except `qualify_url`, which validates before use.
- The frontend checks `api_version()` once at boot; a renamed or missing
  command fails loudly instead of silently.

### 4.1b Platform gating

Commands that need a desktop-only plugin are compiled out of mobile builds with
`#[cfg(desktop)]`; the rest exist everywhere but return an honest
`Err("…not supported on Android yet")` where the OS owns the concept. Plugins
themselves are confined to `cfg(not(android/ios))` in `Cargo.toml`.

### 4.2 Proxy routes

| Route | Params | Success | Failure |
|---|---|---|---|
| `GET /stream` | `u` | relay upstream status + range headers + body | `400` bad scheme/host, `502` upstream error |
| `GET /stream` | `id` | resolve (memoised) then relay | `400` missing params, `502` resolve failure |
| `GET /file` | `id` | stream a saved song out of the offline vault, with byte ranges | `400` bad id, `404` not in the vault, `403` path outside it |

Relayed response headers only: `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Cache-Control`. Everything else is dropped deliberately (no upstream cookies, no correlation ids, no server fingerprinting).

### 4.3 Trust boundaries

```
        UNTRUSTED                          TRUSTED
  ┌──────────────────────┐         ┌──────────────────────────┐
  │ user keystrokes      │ ──IPC──►│ validate id / encode q   │
  │ mirror JSON          │ ───────►│ defensive parse          │
  │ CDN bytes            │ ───────►│ ftyp probe before promise│
  │ localhost caller     │ ───────►│ scheme + host allow-list │
  └──────────────────────┘         └──────────────────────────┘
```

Rules:

1. A user string may become only (a) a percent-encoded query parameter, or (b) a validated song id `[A-Za-z0-9_]` ≤ 32 chars.
2. A user string may never become a host, path, or header.
3. The proxy fetches only `https://*.saavncdn.com`.
4. No outbound `POST`, no cookies, no credentials anywhere.
5. Outbound catalog/metadata hosts are fixed in code: `www.jiosaavn.com`, the `MIRRORS` list, and `lrclib.net` (lyrics only). Titles and artist names reach them as percent-encoded query values, never as host or path.
6. The frontend never supplies a filesystem path. Downloads are addressed by song id, and vault reads/deletes/reveals only ever touch paths the app itself wrote into `<Downloads>/TRANCE MUSIC/index.json`, re-checked against the vault root first.

---

## 5. Data Flows

### 5.1 Search

```
user ─input─► app/src (main.js entry)
              │ invoke("search_songs", {query, limit, page})
              ▼
         lib.rs ──► jiosaavn::search_songs(client, query, limit, page)
                         │ 1. official.rs  GET www.jiosaavn.com/api.php
                         │      ?__call=search.getResults&q=…&n=…&p=…
                         │      real pagination (total/start/results[])
                         │ 2. on failure only, fall back to MIRRORS:
                         │      GET {base}/api/search/songs?…   (25 s cap)
                         │      a 429 costs ONE request, then the next
                         │      mirror is tried — never a retry storm
                         ▼
                    results[]  ──parse_song──► Track[]
              ◄────────────────────────────────────
render rows (artwork · title · artist · album · duration · hq · plays)
+ filter chips, sort cycling, "Load more" paging over `page`
```

### 5.2 Resolve + qualify (the honesty path)

```
click row ─► playQueueItem(i)
              │ invoke("resolve_song", {id, quality:"320kbps"})
              ▼
         jiosaavn::fetch_song(id)
              │ validate id
              │ GET /api/songs/{id}      → data[0]
              │ parse qualities from downloadUrl[]
              │ fail fast if qualities empty
              ▼
         best_quality(qualities, prefer)
              │ exact label match, else max(bitrate_of(quality))
              ▼
         AppState::cached_qualify(url)
              │ hit?  → return memoised Probe
              │ miss? → jiosaavn::qualify_url:
              │          GET bytes=0-63         → must be 206
              │                                → body[4..8] == "ftyp"
              │                                → read Content-Range total
              │          GET bytes=2000000-2065535 → 206 ⇒ Unrestricted
              │          else GET bytes=0-          → 206 ⇒ Unrestricted
              │          else                      ⇒ RestrictedFirstMb
              │          non-206 / not media       ⇒ Dead
              │ store Probe
              ▼
         PlayableAudio { proxy_url, range_status, content_length, … }
              ◄────────────────────────────────
         setBadge(range_status)  →  "FULL SONG · 320kbps · 10.0 MB"
         audio.src = proxy_url ; audio.play()
```

### 5.3 Stream relay

```
<audio>  ── Range: bytes=0-  ──►  axum /stream
                                   │ resolve target (u | id→cache)
                                   │ validate https + media host
                                   │ forward Range VERBATIM
                                   ▼
                            reqwest media client  ──►  aac.saavncdn.com
                                   │
                                   ▼
                     206 + Content-Type/Content-Range/Accept-Ranges
                                   │ bytes_stream()  (no total timeout)
                                   ▼
                          Body::from_stream  ──►  WebView2 media pipeline
```

**The relay is a pass-through, not a policy engine.** If upstream returns `403`, the client sees `403`. That is a deliberate design choice: hiding failures is what made the previous generation of this app unshippable.

### 5.4 Failure flow

```
resolve fails ─► diag(bad) ─► error banner ─► markQueue("failed") ─► advanceQueue()
audio error   ─► telemetry(error) ─► error banner ─► markQueue("failed") ─► advanceQueue()
badge dead    ─► visible before play is even attempted
```

---

## 6. Concurrency & Threading

| Concern | Mechanism |
|---|---|
| Async runtime | tokio (Tauri's `async_runtime` for commands; same runtime for `axum::serve`) |
| Shared state | `Arc<AppState>` with `tokio::sync::Mutex` per cache (never held across await *and* used after — locks are scoped in small blocks) |
| Proxy binding | `std::net::TcpListener::bind("127.0.0.1:0")` in `setup`, converted with `from_std` after `set_nonblocking(true)` |
| Port discovery | `local_addr().port()` **before** the window loads — no flash of "proxy unavailable" |
| Command concurrency | Tauri awaits commands concurrently; caches are the merge point |
| Streaming | `resp.bytes_stream().map(...)` → `axum::body::Body::from_stream` — back-pressured, no full-file buffering |

**Lock discipline**

1. Take the lock, read/return, drop — then perform network I/O.
2. Never call `.await` while holding a `std` lock (not applicable: both mutexes are tokio's, and both are released before I/O).
3. Caches are idempotent, so a benign race only duplicates work.

---

## 7. Client Policy (the two-client rule)

| | `api_client()` | `media_client()` |
|---|---|---|
| Used for | JSON, range probes | audio bodies |
| `timeout` (total, incl. body) | **25 s** | **none** |
| `connect_timeout` | 15 s | 15 s |
| `read_timeout` | — | 30 s (per read) |

**Why this split exists:** reqwest's `timeout` is a *total request* timeout that includes reading the body. With a single 25 s client, a 10.5 MB song on a 300 KB/s link (~35 s) was cut off at byte 5,447,362 at exactly 25.02 s, and the browser stalled mid-track. Probes want to fail fast; bodies want to finish. One client cannot do both.

This is guarded by `proxy::tests::stream_delivers_the_entire_body`, which streams the whole file and asserts `received == Content-Length`.

---

## 8. Caching Strategy

| Cache | Key | Value | Lifetime | Rationale |
|---|---|---|---|---|
| `resolved` | song id | full `Song` | moka, 6 h TTL + capacity | CDN URLs are static per quality; avoids a source round-trip on every seek |
| `qualified` | CDN url | `Probe` | moka, expires with the url | Probing costs 2–3 requests; results don't change within a session |
| `search_cache` | `query:limit:page` | `Track[]` | moka, bounded | Searches are repeat-heavy while browsing |
| `lyrics_cache` | track key | `Lyrics` | moka, bounded | Lyrics never change once fetched |
| artwork + L3/L4 files | url | bytes on disk | app cache dir, budgeted (100 MB–5 GB) | Rows re-render constantly; `cache_clear` never touches the vault |

**Explicitly not cached:** the media bytes themselves. The browser's HTTP cache handles that (`Cache-Control` is relayed), and duplicating 10 MB in Rust would be pure waste.

All four in-memory caches are **`moka` with capacity + TTL** — they were
unbounded `HashMap`s once, which let a long session grow memory without limit.
`cache_stats` / `cache_set_budget` / `cache_clear` expose the disk tree to the
Settings screen.

---

## 9. Error Taxonomy

| Class | Example | Surface |
|---|---|---|
| **Input** | `"invalid song id: …"`, `"empty query"` | `Err(String)` → banner + diagnostics |
| **Upstream HTTP** | `https://…/api/… -> HTTP 404` | `Err(String)` naming the URL and status |
| **Upstream decode** | `decode https://…: expected value` | `Err(String)` |
| **Resolution semantic** | `"song not found"`, `"no stream qualities"` | `Err(String)` |
| **Media integrity** | body not ISO-BMFF | `RangeStatus::Dead` (not an error — a *result*) |
| **Relay** | `media host not allowed: example.com` | HTTP `400` |
| **Transport** | `upstream failed: …` | HTTP `502` |
| **Playback** | media error code | `audio.error.code` → telemetry + banner |

Design rule: **catalog problems are `Err`, media problems are `RangeStatus`.** A dead stream is an expected, representable state — it must never be an exception path, or the UI cannot show an honest badge.

---

## 10. System Design Techniques (where each one lives)

| Technique | Location |
|---|---|
| Layered architecture | presentation → application → domain → transport |
| Adapter (ports & adapters) | `jiosaavn.rs` isolates the mirror; a second source is a new adapter behind the same DTOs |
| Facade | `lib.rs` — four commands, nothing else exported |
| Single responsibility | one file per concern: protocol / relay / IPC / entry |
| Memoisation | `resolved`, `qualified` |
| Fail-fast vs fail-safe | 25 s on metadata, no total cap on media |
| Allow-listing | scheme + host checks in `validate_media_url` |
| Input hardening | `check_id()` before any path construction |
| Defensive parsing | `serde_json::Value` + tolerant helpers |
| Ephemeral allocation | port `0` → `local_addr()` |
| Contract testing | `cargo test` against live endpoints, not fixtures |
| Observability as a feature | diagnostics ring buffer + telemetry line |
| Pass-through honesty | relay never rewrites status codes |
| Single-writer state | one `Arc<AppState>`, two readers |

---

## 11. Extensibility

### 11.1 Adding a catalog source

Two adapters sit behind the same façade today — `official.rs` (first party,
primary) and `jiosaavn.rs`'s mirror path (fallback) — and both answer the same
two functions, `search_songs(..)` and `fetch_song(..)`. A third source joins by
returning the same types:

```rust
trait Catalog {
    async fn search(&self, q: &str, limit: u32, page: u32) -> Result<Vec<Track>, String>;
    async fn fetch(&self, id: &str) -> Result<Song, String>;
}
```

Because `Track`, `Song`, `QualityUrl` and `RangeStatus` are source-neutral, **`main.js`, `lib.rs` and `proxy.rs` do not change.** Media hosts are registered in `MEDIA_HOSTS`, and `is_media_host` becomes a union of the adapters' hosts (the official source streams from the same `*.saavncdn.com` CDN, so it is already covered).

### 11.2 Adding a mirror

```rust
const MIRRORS: &[&str] = &["https://saavn.sumit.co", "https://my-self-hosted.example"];
```

Failover order is declaration order; the failing hop is recorded in the error string.

### 11.3 Adding a route

`get_json(client, path)` + one parse function + one test. The route table in `PRD.md §8.1` is the checklist.

### 11.4 Adding a UI surface

Any new panel talks only to the four IPC commands. No new coupling to HTTP.

---

## 12. Performance Architecture

| Decision | Effect |
|---|---|
| Resolve-on-click (not on hover) | one mirror call per play |
| Qualify memoised per URL | 3 probes only the first time |
| `bytes_stream()` back-pressure | constant memory regardless of file size |
| Artwork `loading="lazy"` | no thumbnail storm on 20 rows |
| Single cache shared by IPC + relay | no duplicate resolves |
| Release: LTO + `codegen-units=1` + strip | small, fast binary |
| No framework, no VDOM | minimal main-thread work |

**Bottleneck analysis:** the dominant cost is CDN throughput (~300–325 KB/s measured), which is 8× the 320 kbps need. Client-side CPU is negligible; the WebView decodes AAC natively. If throughput ever becomes the constraint, the mitigation is a lower default quality, not more client machinery.

---

## 13. Security Architecture

```
┌────────────── WebView2 ──────────────┐
│  CSP (release):                      │
│   default-src 'self'                 │
│   img-src   'self' https://c.saavncdn.com data:
│   media-src 'self' http://127.0.0.1:* https://*.saavncdn.com
│   connect-src 'self' http://127.0.0.1:*
│   script-src 'self'
└──────────────────┬───────────────────┘
                   │ invoke()
┌──────────────────▼───────────────────┐
│ lib.rs — validate before use         │
├──────────────────────────────────────┤
│ jiosaavn.rs — id allow-list,         │
│               query encoding         │
│ proxy.rs — https + host allow-list,  │
│            fixed response header set │
└──────────────────┬───────────────────┘
                   │ fixed hosts, all https
      www.jiosaavn.com (+ MIRRORS)   lrclib.net   *.saavncdn.com
```

- **No secrets exist**, so there is no key management, no token storage, no leak surface.
- **No open relay:** localhost-bound, scheme-checked, host-checked.
- **No injection:** ids validated, queries encoded, no string-built headers.
- **No remote code:** the source returns data, never instructions.
- **CSP is live and strict** in `tauri.conf.json`: `default-src 'self'`,
  `frame-src 'none'`, `object-src 'none'`, `form-action 'self'`, and only the
  four inline boot scripts are hashed in. `media-src` is `'self'` plus
  `127.0.0.1:*` — the WebView never talks to a CDN directly.
- **Vault containment:** reads and deletes only touch paths the app itself
  wrote, re-checked against the vault root first.

---

## 14. Deployment Architecture

```
Developer machine                 End user machine
─────────────────                 ────────────────
npm run tauri dev   ──►  dev window + ephemeral proxy
cargo test          ──►  contract suite (needs egress)
npm run tauri build ──►  NSIS/MSI ──► install ──► app.exe
                                                  ├─ WebView2 (OS)
                                                  └─ 127.0.0.1:<port>/stream
```

No server component is deployed. The optional self-hosted catalog is an *independent* deployment of the MIT reference repo, referenced by one line in `MIRRORS`.

---

## 15. Quality Attributes Summary

| Attribute | How the architecture delivers it |
|---|---|
| **Correctness** | Contract tests against live endpoints; container-level `ftyp` probe |
| **Honesty** | `RangeStatus` is a first-class value that reaches the UI |
| **Availability** | Mirror failover list; already-resolved URLs keep streaming if the mirror dies |
| **Performance** | Memoised resolve/qualify, streamed bodies, no framework |
| **Security** | Allow-lists, validated input, no secrets, (planned) CSP |
| **Modifiability** | Adapter seam, four-command facade, ~7 small files |
| **Testability** | Every layer has direct tests; proxy is a real server on a real port |
| **Portability** | No OS-specific code outside the bundler config |
| **Maintainability** | No dead code (YouTube path fully removed), documented contracts |

---

## 16. Known Architectural Debt

| # | Debt | Status |
|---|---|---|
| 1 | CSP was `null` | ✅ paid — strict CSP shipped (`tauri.conf.json:43`) |
| 2 | Single mirror, no circuit breaker | ✅ paid — first-party source primary, one-request `429` failover |
| 3 | Network-only tests, no offline gate | ✅ paid — `OP_OFFLINE=1` in `ci.yml` |
| 4 | `Catalog` trait not extracted | ⬜ paid when source #2 lands |
| 5 | Diagnostics kept only in DOM | ⬜ desktop only; mobile has none |
| 6 | No artwork disk cache | ✅ paid — cache tree + budget |
| 7 | Unbounded in-memory caches | ✅ paid — moka with capacity + TTL |
| 8 | Mobile JS not covered by CI | ⬜ open — `ci.yml` still checks `src/*.js` only |
| 9 | Android builds are local-only | ⬜ open — no Android workflow yet |
| 10 | Front-end `main.js` monolith | ✅ paid — split into 28 modules (entry is 159 lines) |

Anything still ⬜ above is tracked with an owner in
[`task.md`](task.md); the roadmap for new work is
[`future-scope.md`](future-scope.md).
