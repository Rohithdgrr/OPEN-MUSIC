# PRD — TRANCE MUSIC

**An open-source, logged-out, lightweight music streaming player for Windows, Linux, macOS and Android (Tauri)**

| Field | Value |
|---|---|
| Document | `PRD.md` (product requirements) |
| Companion docs | `architecture.md` · `ui.md` · `task.md` · `feature-list.md` · `future-scope.md` |
| Date | 2026-09-28 (UTC) · **last reviewed 2026-10-04** |
| Status | **v0.3.0 shipped** — Windows/Linux/macOS releases + Android shell + iOS CI |
| Workspace | `C:\Users\rohit\Music\OPEN MUSIC` |
| App root | `app/` (`app/src` = desktop front end, `app/src/mobile` = mobile shell, `app/src-tauri` = Rust core) |
| Languages in shipped code | **HTML, CSS, JavaScript, Rust** (hard project constraint — no Python/Node/Go sidecars at runtime). Carve-out: the app may *talk to* a user-installed localhost service (e.g. metroserver on `127.0.0.1`, see `docs/sidecar.md`) but never bundles, spawns or vendors it — the shipped runtime stays HTML/CSS/JS/Rust |
| Target platform | Windows 10/11, Linux, macOS 13+, Android (WebView2 / WebKitGTK / system WebView) |

---

## 1. Problem Statement

Building a small, honest, open-source music player is hard for two separate reasons, and most open-source projects fail on the *second* one:

1. **Finding the audio.** Streaming services do not publish a public "give me the file" API. Community projects therefore reverse-engineer internal endpoints. That part is solvable and well documented.

2. **Getting the whole file.** A URL that *resolves* is not a URL that *plays to the last second*. Several sources hand logged-out clients a stream that is server-capped: only the first ~1 MB is fetchable, and every subsequent `Range` request returns `403`. The player appears to work, buffers for 30–60 seconds, then silently stalls. Users blame the app; the app blames the network; nobody measures anything.

**The previous incarnation of this project** (a YouTube Music backend) was destroyed entirely by problem #2. Search worked, streams resolved, byte ranges loaded — but a server-side range gate capped nearly every track near 1 MB, and the only known bypass (Botguard / PO tokens) proved unreliable, brittle against player-JS updates, and impossible to keep correct. That path has been **completely removed from the codebase**; only the reusable infrastructure (localhost range-relay proxy, honest range qualification, queue/history UI) survived the rewrite.

3. **Weight.** The existing open-source alternatives are Electron-based (hundreds of MB RAM and disk), require accounts, require downloads, or require DRM.

**Plain restatement:** build a small, honest, open-source Windows music player that searches a real catalog and plays *full* songs while logged out, with no account, no downloads, no DRM, and never lying to the user about what it can play.

---

## 2. Aim

1. Ship a Tauri 2 desktop app whose entire runtime codebase is HTML/CSS/JS/Rust.
2. Search a real, large music catalog and play **complete songs** logged-out — no account, no token dance, no client-side cryptography.
3. **Honesty as a feature.** Qualify every resolved URL (bounded, open-ended, and mid-file probes) and show `FULL SONG` / `PREVIEW ONLY` / `UNREACHABLE` instead of failing silently.
4. Prove every claim with wire-level evidence (status codes, byte counts, container structure) rather than "it seemed to work".
5. Stay small and fast versus Electron: native `<audio>`, no ffmpeg/mpv sidecar, no Chromium bundle.

### 2.1 Success criteria (definition of done)

| # | Criterion | Evidence required |
|---|---|---|
| S1 | Search returns usable results with metadata and artwork | Live API response, parsed by `cargo test` |
| S2 | A track resolves to a direct CDN URL | `downloadUrl` entries present, HTTPS, `aac.saavncdn.com` |
| S3 | Bounded, open-ended **and** mid-file ranges all return `206` | Proxy integration tests |
| S4 | The complete file body is delivered (no truncation) | Byte count == `Content-Length`, e.g. 10,527,454 / 10,527,454 |
| S5 | The bytes are a real, complete audio container | ISO-BMFF box walk: `ftyp → moov → free → mdat` |
| S6 | The app boots, binds its proxy, and serves through the same URL the `<audio>` element uses | Live process + port probe |
| S7 | Failures emit actionable diagnostics | Diagnostics panel: step, id, quality, host, range status |

**Current verdict:** S1, S2, S3, S5, S7 ✅ · S4 ✅ in automated tests, ⚠️ one clean end-to-end re-run through the freshly built binary still pending · S6 ✅.

---

## 3. Scope

### In scope (shipped or in progress)

- Catalog search (songs, albums, artists, playlists) with unlimited paging
- Track resolution to per-quality direct stream URLs
- Range-qualification of every stream before promising playback
- Localhost byte-range relay into the WebView
- Native `<audio>` playback: play, pause, seek, volume, queue, shuffle, repeat
- Offline vault with SQLite ledger, SHA-256 verification, quality promotion
- Synced lyrics (LRCLIB → JioSaavn → LRCLIB), karaoke on mobile
- Library, playlists, history, charts, endless radio
- Desktop widget, tray, global Hyper shortcuts, system media keys
- Mobile shell: 13 screens, lock-screen transport, hardware back
- Windows / Linux / macOS packaging (signed installers) and Android APK/AAB
- Self-updater on desktop (check, install, rollback); store-driven on mobile
- Honest failure reporting

### Out of scope

- Accounts, login, subscriptions, personalization
- DRM content
- Real DSP / EQ, gapless playback (see [`future-scope.md`](future-scope.md);
  crossfade *is* implemented on desktop)
- Lyrics translation (toggle exists, not wired)
- Light theme
- Cross-device sync, scrobbling, social features
- Legal/ToS clearance — **explicitly the integrator's responsibility** (see §17 Risk Factors)

Per-platform coverage of everything above is tabulated in
[`feature-list.md`](feature-list.md).

---

## 4. Users & Personas

| Persona | Need | What this app gives them |
|---|---|---|
| **The listener** | Play a song now, full length, no account | Search box → click → plays |
| **The tinkerer** | Understand *why* something plays or doesn't | Diagnostics + `RangeStatus` badges + wire-level tests |
| **The downstream developer** | A small, forkable, framework-free codebase | Vanilla JS + plain Rust, no build step, 4 source files per side |
| **The packager** | Ship it somewhere | Tauri bundler config already present |

---

## 5. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Shell | **Tauri 2** (`@tauri-apps/cli` 2.x, tauri-cli 2.11.2) | Native window + Rust backend, tiny binary, WebView2 on Windows |
| Language | **Rust 1.98.1** (MSVC, edition 2021) | Concurrency without GC, memory-safe networking |
| HTTP server | **axum 0.8** + **tokio** | Localhost range-relay proxy |
| HTTP client | **reqwest 0.12** (`json`, `stream`) | Catalog calls, range probes, byte-range relay |
| Serialization | **serde / serde_json / url** | Wire payloads, query encoding |
| Frontend | **Vanilla HTML/CSS/JS (ES modules)** | Project constraint; no framework, no bundler, no node_modules at runtime |
| Web runtime | **WebView2 Runtime** (Chromium) | Native media stack for `audio/mp4` |
| Catalog source | **`www.jiosaavn.com/api.php`** — JioSaavn's own first-party endpoint (primary); community mirrors of `sumitkolhe/jiosaavn-api` (MIT) as fallback | No community quota, real pagination; mirrors only reached if the primary call fails |
| Media CDN | **`aac.saavncdn.com`** (audio), **`c.saavncdn.com`** (artwork) | Static files, full-range `206`, ISO-BMFF/MP4 |
| Mobile web runtime | Android system WebView / iOS WKWebView | Same Rust core, `rustls-tls` on Android |
| Tests | `cargo test` — **138 tests**, 13 live-network ones gated behind `OP_OFFLINE=1` | Regression net across parsing, resolution, qualification, vault, lyrics, cache |

**Release profile:** `lto = true`, `codegen-units = 1`, `opt-level = 3`, `panic = "abort"`, `strip = true`.

---

## 6. Feature List

### 6.1 Core features (shipped or in progress)

| ID | Feature | Status |
|---|---|---|
| F01 | Full-text catalog search, 20 results per page, **paged without limit** (`page` 1..n) | ✅ |
| F02 | Result rows: artwork, title, artist, album, duration, 320 kbps flag | ✅ |
| F03 | Click-to-play → resolve → stream | ✅ |
| F04 | Per-quality resolution (12/48/96/160/320 kbps), default 320 | ✅ |
| F05 | Localhost range-relay proxy (ephemeral port, bound before window load) | ✅ |
| F06 | Honest `RangeStatus` badge: `FULL SONG` / `PREVIEW ONLY` / `UNREACHABLE` | ✅ |
| F07 | Queue with click-to-jump, `playing…/played/failed` states | ✅ |
| F08 | **Play all** — enqueue an entire result page | ✅ |
| F09 | Auto-advance on `ended` / on error | ✅ |
| F10 | Search history chips (localStorage, last 8, dedup) | ✅ |
| F11 | Diagnostics log: timestamped steps, ok/bad, capped at 40 entries | ✅ |
| F12 | Live telemetry: `readyState`, position/duration, quality, host, media error code | ✅ |
| F13 | Range-qualification with per-URL memoisation | ✅ |
| F14 | Memoised song→URL resolution (repeat seeks skip the mirror) | ✅ |
| F15 | Full-body integrity regression test (guards against mid-song truncation) | ✅ |
| F16 | Filter chips that act: `All` / `Lossless Only` (320 kbps) / `Studio Masters` (5 min+) filter the table; genre chips run a real search | ✅ |
| F17 | Sort cycling: bitrate → popularity → longest → A–Z, label follows state | ✅ |
| F18 | Featured releases carousel: real search results, working prev/next, play and download per card | ✅ |
| F19 | **Download a full song** to the OS Downloads folder (`download_song`), byte-count checked before the file is kept | ✅ |
| F20 | **Load more** paging + **Retry** button on any search failure (429 included) | ✅ |

### 6.2 Novel features

These are the differentiators — things the mainstream open-source clones do not do.

| ID | Novel feature | Why it matters |
|---|---|---|
| N01 | **Honesty as a product feature.** Every stream is probed (head + mid-file + open-ended) *before* playback and the result is shown as a badge, not guessed. | Turns the #1 silent failure of music clones into a visible, diagnosable state. |
| N02 | **Container-level liveness check.** A 64-byte probe must return `206` *and* an ISO-BMFF `ftyp` box — an HTML error page can never be mistaken for audio. | Catches expired/rotated CDN URLs instantly instead of throwing a opaque media error. |
| N03 | **Deterministic truncation detection.** The proxy asserts `received == Content-Length` in CI, so a client-level timeout can never silently guillotine a song again. | This exact bug was found and fixed this way (see §14.1). |
| N04 | **Two-client HTTP policy.** A short-timeout client for JSON/probes, a no-total-timeout client for media bodies. | Subtle but fatal: reqwest's `timeout` covers body reads too. |
| N05 | **Ephemeral proxy port bound before the window loads** — no hardcoded port, no collision, no race. | Makes parallel instances and CI runs safe. |
| N06 | **Zero-build frontend.** ES modules loaded straight from disk. | Fork-and-run; no npm install step for contributors. |
| N07 | **Source-agnostic backend seam.** `jiosaavn.rs` exposes `search_songs / fetch_song / qualify_url`; `proxy.rs` only knows "media host". | Adding a second catalog source is an adapter, not a rewrite. |
| N08 | **Diagnostics panel as a first-class UI surface** (not console-only). | Non-developers can paste a log that actually identifies the failing hop. |

---

## 7. Working of the Project

### 7.1 Runtime flow (what happens when you press Play)

```
[User types query]
      │
      ▼
index.html ──invoke("search_songs")──► lib.rs ──► jiosaavn.rs
                                                      │
                                    GET https://saavn.sumit.co/api/search/songs?q=…
                                                      │
                                    ◄── JSON: id, name, artists, album, duration,
                                        image[], downloadUrl[5]  (already decrypted)
      │                                                 │
      ▼                                                 │
render result rows (artwork + meta)                     │
      │                                                 │
[User clicks a row]                                     │
      │                                                 │
      ▼                                                 │
lib.rs: resolve_song(id, "320kbps") ─────────────────────┘
      │  1. fetch_song(id)        → full detail + qualities
      │  2. best_quality(...)     → https://aac.saavncdn.com/…_320.mp4
      │  3. cached_qualify(url)   → probes: bytes=0-63 (ftyp!)
      │                             bytes=2000000-2065535  (past 1 MB)
      │                             bytes=0-               (open-ended)
      │  4. build proxy_url       → http://127.0.0.1:<ephemeral>/stream?u=…
      ▼
{ direct_url, proxy_url, qualities, chosen_quality,
  content_length, host, range_status }  ──► badge set to FULL SONG
      │
      ▼
audio.src = proxy_url  ──►  axum /stream  ──►  reqwest media client
                                                     │  forwards browser
                                                     │  Range verbatim
                                                     ▼
                                          https://aac.saavncdn.com/…_320.mp4
                                                     │
                                                     ▼  206 Partial Content
                                          status + Content-Range + body stream
      │
      ▼
WebView2 native media pipeline decodes AAC/MP4 → sound
```

### 7.2 Why a proxy instead of pointing `<audio>` at the CDN

| Concern | Direct CDN | Localhost proxy |
|---|---|---|
| Origin | third-party `https://aac.saavncdn.com` | same-origin `http://127.0.0.1` |
| CORS/CSP negotiation | depends on remote headers | none |
| Range transparency | implicit | **explicit and testable** |
| Host allow-listing | impossible | enforced in Rust (https + `*.saavncdn.com` only) |
| Retry/refresh policy | frontend | backend |
| Observable in tests | only against upstream | testable as a unit |

The proxy is **not** a bypass: it relays upstream status codes verbatim, including failures.

---

## 8. API

### 8.1 External catalog API

#### 8.1.1 Primary — JioSaavn first-party API (no rate limit, paginated)

Base: `https://www.jiosaavn.com/api.php` — the endpoint JioSaavn's own web player calls. Verified live on 2026-09-28.

| Method | Route | Purpose | Verified |
|---|---|---|---|
| GET | `?__call=search.getResults&q=&n=&p=&_format=json&_marker=0` | Song search with real paging (`total` / `start` / `results[]`; `n` ≤ 40) | ✅ |
| GET | `?__call=song.getDetails&pids=&api_version=4&_format=json&_marker=0&ctx=web6dot0` | Song detail + `more_info.encrypted_media_url` | ✅ |

**Media url decryption (verified):** `encrypted_media_url` is `base64(DES-ECB(padded url))` with the 8-byte key `38346591`. Decrypting yields the CDN asset of the 96 kbps rendition (`…_96.mp4`); the other four renditions are the same path with `_12` / `_48` / `_160` / `_320` substituted. Implemented in `official.rs::decrypt_media_url` and pinned by the unit test `decrypts_media_url_to_a_cdn_asset`.

**Measured on `_320.mp4`:** `206` for `bytes=0-63`, `bytes=2000000-2065535` (exactly 65,536 bytes) and `bytes=0-`, total 10,527,454 bytes, `audio/mp4` — the complete song, on the same `aac.saavncdn.com` host the allow-list already trusts.

Why primary: it has no community-mirror quota, so a `429` on search cannot come from it, and `p` gives unlimited result pages.

#### 8.1.2 Fallback — community mirror

Base: `https://saavn.sumit.co` — community deployment of [`sumitkolhe/jiosaavn-api`](https://github.com/sumitkolhe/jiosaavn-api) (TypeScript, Hono, MIT). Used **only** when the first-party call fails outright.

| Method | Route | Purpose | Verified |
|---|---|---|---|
| GET | `/api/search/songs?query=&limit=&page=` | Song search | ✅ |
| GET | `/api/search/albums?query=` | Album search | ✅ |
| GET | `/api/search/artists?query=` | Artist search | ✅ |
| GET | `/api/search/playlists?query=` | Playlist search | ✅ |
| GET | `/api/search?query=` | Multi-type "top query" search | ✅ |
| GET | `/api/songs/{id}` | Track detail **+ decrypted `downloadUrl[]`** | ✅ |
| GET | `/api/albums?id=` | Album detail + `songs[]` | ✅ |
| GET | `/api/artists/{id}` | Artist detail | ✅ |
| GET | `/api/artists/{id}/songs?limit=&page=` | Artist catalog | ✅ |
| GET | `/api/artists/{id}/albums?limit=&page=` | Artist albums | ✅ |
| GET | `/api/playlists?id=` | Playlist detail + `songs[]` | ✅ |
| GET | `/api/songs/{id}/suggestions` | Similar tracks | ❌ returns `500` upstream |
| GET | `/api/albums/{id}` | — | ❌ `404` (must use `?id=`) |

**Envelope:** `{ "success": true, "data": … }` — `data` is an **array** for `/api/songs/{id}`, an **object** for albums/artists/playlists, and `{ total, start, results[] }` for searches.

**Song object (essential fields):**

```jsonc
{
  "id": "aRZbUYD7",
  "name": "Tum Hi Ho",
  "duration": 262,                       // seconds
  "url": "https://www.jiosaavn.com/song/…",
  "album":  { "id": "1139549", "name": "Aashiqui 2", "url": "…" },
  "artists": { "primary": [{ "name": "Mithoon", … }], "featured": [], "all": [] },
  "image": [
    { "quality": "50x50",   "url": "https://c.saavncdn.com/…" },
    { "quality": "150x150", "url": "https://c.saavncdn.com/…" },
    { "quality": "500x500", "url": "https://c.saavncdn.com/…" }
  ],
  "downloadUrl": [                       // ← already decrypted, no client crypto
    { "quality": "12kbps",   "url": "https://aac.saavncdn.com/…_12.mp4" },
    { "quality": "48kbps",   "url": "https://aac.saavncdn.com/…_48.mp4" },
    { "quality": "96kbps",   "url": "https://aac.saavncdn.com/…_96.mp4" },
    { "quality": "160kbps",  "url": "https://aac.saavncdn.com/…_160.mp4" },
    { "quality": "320kbps",  "url": "https://aac.saavncdn.com/…_320.mp4" }
  ]
}
```

**Media properties (measured):**

| Property | Value |
|---|---|
| Host | `aac.saavncdn.com` (also `c.saavncdn.com` for artwork) |
| Content-Type | `audio/mp4` |
| `Accept-Ranges` | `bytes` |
| Sample file | 10,527,454 bytes |
| Container | ISO-BMFF: `ftyp(28) → moov(45922) → free(8) → mdat(10481496)` — faststart (moov first) |
| `bytes=0-63` | `206`, `ftyp` at offset 4 |
| `bytes=0-` | `206`, full length |
| `bytes=2000000-2065535` | `206`, exactly 65,536 bytes |
| No `Range` | `200`, full length |
| Observed throughput | ~300–325 KB/s (≈8× the 320 kbps bitrate) |

### 8.2 Internal Tauri IPC commands

**48 commands** are registered (`app/src-tauri/src/lib.rs:1353`); 4 are
`#[cfg(desktop)]`-only. The authoritative per-platform table — including which
commands return explicit errors on mobile — is
[`feature-list.md`](feature-list.md). The four original commands that every
stream path goes through:

| Command | Args | Returns | Notes |
|---|---|---|---|
| `search_songs` | `query: String, limit?: u32, page?: u32` | `Track[]` | clamps limit to 1–50, default 20; real upstream paging |
| `resolve_song` | `id: String, quality?: String` | `PlayableAudio` | runs the qualification probe |
| `qualify_url` | `url: String` | `RangeStatus` | https + media-host validated first |
| `proxy_base` | — | `String` | `http://127.0.0.1:<port>` |
| `api_version` | — | `u32` (= `1`) | checked once at boot by both shells |

**DTOs (serde, `snake_case` on the wire):**

```ts
type Track = { id, title, artist, album, duration_secs, duration, image, page_url }
type QualityUrl = { quality: string, url: string }
type PlayableAudio = {
  id, title, artist,
  direct_url, proxy_url,
  qualities: QualityUrl[], chosen_quality,
  content_length: number | null,
  host: string,
  range_status: "unrestricted" | "restricted_first_mb" | "dead"
}
```

### 8.3 Localhost proxy

| Route | Params | Behaviour |
|---|---|---|
| `GET /stream` | `u=<https cdn url>` | validate → forward `Range` verbatim → relay status/headers/body stream |
| `GET /stream` | `id=<song id>` | memoised resolve, then same as above |
| — | neither | `400 missing ?u= or ?id=` |
| — | non-https or non-`saavncdn.com` | `400 media host not allowed` |

Relayed headers: `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Cache-Control`.

---

## 9. System Design Techniques Used

| Technique | Where it appears |
|---|---|
| **Layered architecture** (UI → IPC → domain → transport) | `index.html/main.js` → `lib.rs` → `jiosaavn.rs` → `proxy.rs` |
| **Adapter / ports-and-adapters** | `jiosaavn.rs` hides the mirror's wire format behind `Track`/`Song`/`PlayableAudio`; swapping sources touches one file |
| **Facade** | `lib.rs` exposes 4 commands; nothing else reaches into modules |
| **Single-responsibility** | media relay, catalog protocol, and IPC registration are three files |
| **Memoisation / request coalescing** | `resolved` (song id → URL) and `qualified` (URL → `Probe`) maps |
| **Ephemeral resource allocation** | `TcpListener::bind("127.0.0.1:0")` then read `local_addr()` — no port config, no race |
| **Fail-fast for metadata, fail-safe for media** | 25 s total timeout on JSON/probes; **no** total timeout on media bodies |
| **Allow-listing over deny-listing** | media host + scheme checks before any outbound request |
| **Input hardening** | song ids validated (`[A-Za-z0-9_]`, ≤32) before becoming a URL path |
| **Honest degradation** | `RangeStatus` propagates to the UI rather than being swallowed |
| **Observability as a feature** | timestamped diagnostics + live telemetry, capped ring buffer |
| **Contract tests** | `cargo test` asserts against the *live* catalog and CDN, not fixtures |

---

## 10. Design

Full detail lives in `architecture.md`. Summary of decisions:

- **Proxy in front of media, direct-to-mirror for JSON.** JSON calls are made from Rust (no CORS surface at all); only media crosses the localhost hop.
- **State held in one managed `Arc<AppState>`.** Shared by both the Tauri commands and the axum router — one cache, two consumers, no duplication.
- **No global mutable config.** Mirror list is a `const`; ports are ephemeral; everything else derives from responses.
- **Trust boundary:** user-supplied strings may only reach (a) an encoded query parameter, or (b) a validated song id, or (c) an allow-listed https media URL.

---

## 11. UI / UX

Full specification in `ui.md`. Summary:

- Single-column dark layout, 640 px max width, system font stack.
- Zones: header → search → history chips → results → sticky player → queue → diagnostics.
- Player is `position: sticky; bottom` so controls never scroll away.
- **Badge is the primary truth surface** — colour-coded, worded in absolutes.
- Every async action has an explicit state: `resolving…`, `playing…`, `played`, `failed`, plus an error banner for hard failures.
- Keyboard: the search field is the entry point; `Enter` submits; results are buttons in disguise (click targets ≥ 44 px).

---

## 12. Workflow

### 12.1 Development workflow

```
1. Edit code (app/src/*.js, app/src-tauri/src/*.rs)
2. cargo build          → compile Rust, catch type errors
3. cargo test           → 12 contract tests against live catalog + CDN
4. npm run tauri dev    → boot window + proxy
5. Manual check         → search, click, verify badge + telemetry
6. Repeat
```

### 12.2 Contributor workflow

```
fork → clone → (no npm install needed) → npm run tauri dev
                                       → cargo test
                                       → open PR
```

### 12.3 Release workflow

```
cargo test → npm run tauri build → NSIS/MSI in src-tauri/target/release/bundle/
```

---

## 13. Setup & Process

### Prerequisites

| Tool | Verified version |
|---|---|
| Windows | 10/11 x64 |
| Rust | 1.98.1 (`x86_64-pc-windows-msvc`) |
| MSVC toolchain | VS Build Tools, MSVC 14.50 `link.exe` |
| Windows SDK | 10.0.26100 |
| Node.js | v24.11.0 (npm 11.6.1) — **CLI only**, not a runtime dependency |
| WebView2 Runtime | evergreen, preinstalled on Win11 |
| `cargo install tauri-cli` | optional; `@tauri-apps/cli` is already in `app/package.json` |

### Commands

```powershell
# 1. enter the app
cd C:\Users\rohit\Downloads\test\app

# 2. install the Tauri CLI (only dev dependency)
npm install

# 3. compile the backend
cd src-tauri ; cargo build ; cargo test

# 4. run
cd .. ; npm run tauri dev

# 5. package
npm run tauri build
```

### Process rules

1. **No new runtime language.** HTML/CSS/JS/Rust only.
2. **No new framework.** Vanilla ES modules.
3. **Every new stream path must have a test that asserts byte counts.**
4. **Never promise playback without a `RangeStatus`.**
5. **Two HTTP clients, always** — metadata vs media.

---

## 14. Problematic Areas

### 14.1 FIXED — Media body truncated at exactly 25.0 s

- **Symptom:** a full open-ended fetch through the proxy returned 5,447,362 of 10,527,454 bytes, terminating at 25.02 s.
- **Root cause:** `reqwest::Client::builder().timeout(25s)` applies to the *entire* request **including reading the body**. On a ~300 KB/s link, a 10 MB song needs ~35 s → the body stream errored mid-song → `<audio>` would stall halfway.
- **Fix:** two clients. `api_client()` keeps the 25 s total timeout (JSON + probes); `media_client()` has `connect_timeout(15s)` + `read_timeout(30s)` (per-read, not per-request) and **no total timeout**.
- **Guard:** `proxy::tests::stream_delivers_the_entire_body` streams the whole file and asserts `received == Content-Length`.

### 14.2 OPEN — End-to-end re-run against a freshly built binary

- One manual run returned a transient `502` on first contact (cold mirror), then served `206` normally. Automated tests pass consistently; one clean full-body run through the packaged binary remains to be recorded.

### 14.3 OPEN — Upstream route gaps

- `/api/songs/{id}/suggestions` returns `500`.
- `/api/albums/{id}` returns `404`; must use `/api/albums?id=`.
- Workaround implemented: suggestions are simply not used yet.

### 14.4 FIXED — Mirror `429` breaking search (2026-09-28)

- **Symptom:** `Search failed: https://saavn.sumit.co/api/search/songs?query=…&limit=20 -> HTTP 429 Too Many Requests` — every mirror in `MIRRORS` answered `404` or `429`, so search was dead.
- **Root cause:** the whole catalog depended on third-party mirrors with their own quotas, and a `429` was retried against the *same* mirror before failing over.
- **Fix:**
  1. `official.rs` — first-party `www.jiosaavn.com` source becomes primary for both search and resolve (no mirror quota, real pagination);
  2. a `429` now costs exactly **one** request and immediately moves to the next mirror (no retry storm), with the failing URL quoted in the error;
  3. the UI surfaces a **Retry** button on any search failure and the search cache is keyed per query+limit+page.
- **Guard:** `official::tests::live_search_page2_advances_beyond_page1`, `official::tests::live_resolve_yields_all_renditions_of_the_full_file`, plus the 30-assertion headless UI self-test covering every search-screen control.

### 14.5 LATENT — Throughput ceiling

- Measured ~300–325 KB/s from the CDN in this environment. That is ~8× the 320 kbps bitrate, so playback is safe, but on a slower link (or a congested CDN edge) the browser could buffer. Mitigation: default quality is selectable; a `160kbps` fallback halves the required throughput.

### 14.6 LATENT — `restricted_first_mb` is still possible

- The qualification probe exists precisely because some catalogs/CDNs *do* cap. The UI must never hard-code "everything is full" — the badge logic branches on the real probe result.

---

## 15. Risk Factors

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Mirror instance goes offline or changes routes | Medium | High | Multi-mirror const + contract tests that fail loudly |
| R2 | CDN starts gating ranges (the YouTube failure mode) | Low–Med | Critical | `RangeStatus` probe + honest badge; tests assert `206` past 1 MB |
| R3 | CDN URLs rotate/expire | Medium | Medium | Resolve fresh on play; memoise only within a session; `ftyp` probe detects dead URLs |
| R4 | Legal / ToS exposure from third-party content | **High** | **High** | Integrator responsibility; see §15.1 |
| R5 | Mirror returns malformed JSON | Low | Medium | `serde_json` decode errors surfaced as messages, not panics |
| R6 | reqwest/axum/Tauri major upgrades break behaviour | Low | Medium | Pinned major versions; full test suite as the safety net |
| R7 | WebView2 codec support differs across machines | Low | Medium | MP4/AAC is baseline; `ftyp`/`moov` verified before promising playback |
| R8 | Open proxy misuse (localhost) | Low | Medium | https + host allow-list; no POST, no arbitrary hosts |
| R9 | Contributor adds a framework/sidecar | Medium | Medium | Documented hard constraint in this PRD + `task.md` DoD |
| R10 | Throughput too low on some networks | Medium | Medium | Quality fallback ladder (320→160→96) |

### 15.1 Legal note (read this)

This project integrates a **third-party community API** with a service the API does not officially expose. Nothing in this repository grants rights to any recorded music. Before distributing binaries publicly, the integrator **must** obtain their own legal clearance, consider jurisdiction-specific private-copying rules, and decide whether to ship the mirror URL at all (self-hosting the MIT-licensed reference server is the cleanest option). This document is engineering documentation, **not** legal advice.

---

## 16. Advantages

| Advantage | Detail |
|---|---|
| Tiny footprint | Tauri + WebView2: tens of MB vs hundreds for Electron |
| Low RAM | Native media pipeline, no bundled Chromium renderer per window |
| Instant-on | No bundler, no node_modules at runtime, ~4 source files per side |
| No account | Logged-out by design |
| No crypto dance | No PO tokens, no BotGuard VM, no player-JS cipher to break monthly |
| Full-length playback | Verified `206` on bounded, open-ended **and** mid-file ranges |
| Honest | Badges reflect measured state, not hope |
| Forkable | Vanilla JS + plain Rust, MIT-referenced upstream, no lock-in |
| Debuggable | Diagnostics panel + `cargo test` contract suite |
| Extensible | Adapter seam for a second catalog source |

---

## 17. Performance

| Metric | Target | Measured |
|---|---|---|
| Cold start → window | < 2 s | (to be recorded in Phase 4) |
| Search latency | < 800 ms | ~200–500 ms (live probe) |
| Resolve + qualify | < 1.5 s | 3 probes, ~150–400 ms typical |
| Time to first audio byte | < 1 s after click | proxy `206` immediately |
| Sustained throughput | ≥ 4× selected bitrate | ~300–325 KB/s vs 40 KB/s needed (320 kbps) |
| Binary size (release) | < 15 MB | debug `app.exe` ≈ 19 MB; release strips + LTO |
| Memory idle | < 150 MB | WebView2 baseline |
| Test suite | < 60 s | ~48 s (dominated by the full-body guard) |

**Levers available:** quality selection, `moov`-first containers (already the case), memoised resolve/qualify, `Cache-Control` relayed to the browser, single in-process cache shared by IPC and proxy.

---

## 18. Security

| Area | Control |
|---|---|
| Proxy exposure | Bound to `127.0.0.1` only, ephemeral port |
| Room server exposure (Listen Together) | Bound to `0.0.0.0` **only while a room is open**, default port 8787, stopped on `room_close`/exit; opt-in, never started at launch |
| Room trust model | No TLS/auth by design — LAN-trust; 8-symbol code (~140 bits) as bearer; crosses only display name, chat text, track id/title/artist/position. See `docs/listen-together.md` §7 |
| Open-relay risk | `https` + `*.saavncdn.com` allow-list enforced in Rust |
| Path traversal | Song ids validated: `[A-Za-z0-9_]`, length ≤ 32 |
| Query injection | Query strings percent-encoded via `url::form_urlencoded` |
| Header hygiene | Only a fixed set of response headers is copied back; `Host`/`Origin` never forwarded blindly |
| CSP | Currently `null` (dev convenience). **Release hardening:** set a real CSP with `default-src 'self'`, `media-src 'self' https://*.saavncdn.com http://127.0.0.1:*`, `img-src 'self' https://c.saavncdn.com data:` |
| Secrets | None — no API keys, no tokens, nothing to leak |
| Supply chain | Single `package.json` dev dependency (`@tauri-apps/cli`); Cargo deps pinned by `Cargo.lock` |
| Panics | `panic = "abort"` in release; all fallible paths return `Result` |
| Untrusted input | Mirror JSON parsed defensively with `serde_json::Value` + field lookups, never `unwrap` on remote data |

---

## 19. Deployment

| Target | Mechanism | Status |
|---|---|---|
| Dev | `npm run tauri dev` | ✅ |
| Windows installer | `npm run tauri build` → NSIS `.exe` / MSI | ✅ signed, attached to releases |
| Linux / macOS | `release.yml` matrix → deb, AppImage, DMG | ✅ |
| Android | `npx tauri android build` → APK/AAB (per ABI) | ✅ build locally; **no workflow yet** |
| iOS | `ios.yml` on macOS runners → signed `.ipa` or unsigned simulator `.app` | ✅ |
| CI | `.github/workflows/ci.yml` | ✅ `cargo fmt --check`, `clippy -D warnings`, `OP_OFFLINE=1 cargo test`, `cargo audit`, ESLint, syntax check |
| Release | `.github/workflows/release.yml` | ✅ builds, uploads, **verifies updater manifest URLs**, then publishes |
| Self-hosted catalog | deploy `sumitkolhe/jiosaavn-api` to Vercel/Cloudflare Workers, add its URL to `MIRRORS` | documented, one line |

**CI caveat:** the contract tests hit the live internet. `OP_OFFLINE=1` skips
the 13 `live_*` tests (125 of 138 still run), so CI without egress validates
parsing, resolution, the proxy and the vault.

---

## 20. Scaling for a Large Sector (many users, big catalog)

The app is a **client**; scale concerns split into three planes.

### 20.1 Client plane (this repo)

- **Caching:** add a bounded LRU of resolved URLs + an on-disk artwork cache (`app-data` dir) so repeat plays are instant.
- **Quality auto-selection:** pick 160 kbps when `navigator.connection.downlink` is low or when the probe shows slow first-byte time.
- **Concurrency:** resolve the *next* queue item while the current one plays (speculative prefetch of `resolve_song`, never of bytes).
- **Memory:** stream the diagnostics log to a rotating file instead of DOM nodes above 40 entries.
- **Batching:** for album/playlist views, resolve lazily on scroll, not for the whole page.

### 20.2 Catalog/mirror plane (self-hosted)

- Deploy the MIT reference server on edge runtimes (Cloudflare Workers / Vercel) in **multiple regions**; add them all to `MIRRORS` and let failover pick the healthy one.
- Put a thin **read-through cache** in front (search results are immutable for minutes): `Cache-Control` on `/api/search/*` for 300 s, `/api/songs/*` for 3600 s.
- Rate-limit per client, add `ETag`, and compress JSON (`gzip`/`br`) — search responses are the biggest payload.
- Shard by locale: Hindi/Tamil/Telugu/Punjabi indexes served regionally.
- If user counts grow past hobby scale, **the right answer is a licensed API contract**, not more reverse engineering.

### 20.3 Media plane

- CDN does the heavy lifting; the client only needs a healthy edge. Multi-CDN would be a server-side concern if we ever proxy bytes centrally (we deliberately do **not**).
- Never build a central media relay: it concentrates copyright exposure and bandwidth cost in one place. The current design keeps every byte flowing CDN → end-user.

### 20.4 Horizontal summary

```
        ┌──────────────┐   JSON    ┌────────────────────────┐
        │ TRANCE MUSIC │──────────►│ Mirror A (region 1)   │
        │  (Tauri)     │           ├────────────────────────┤
        │              │           │ Mirror B (region 2)   │
        │  /stream ────┼──────────►└────────────────────────┘
        └──────┬───────┘
               │ bytes (Range)
               ▼
     ┌──────────────────────┐
     │ saavncdn CDN edge    │  ← scales independently, multi-CDN
     └──────────────────────┘
```

---

## 21. Working Efficiently on All Devices

| Device class | Strategy |
|---|---|
| **Windows desktop (primary)** | WebView2 evergreen; MP4/AAC baseline; already the target |
| **Low-end Windows** | Default to 160 kbps; lazy artwork loading (`loading="lazy"` already); cap diagnostics DOM nodes; release build with LTO/strip |
| **High-DPI** | `object-fit: cover` artwork, rem-free px sizing that scales with system font size; add `@media (prefers-color-scheme: light)` tokens |
| **Small window / laptop** | Single 640 px column, sticky player; test at 800×600 (current window size) |
| **Large monitor** | Raise `max-width` and switch to two-column (results + queue) via a media query |
| **Touch** | ≥44 px hit targets, `cursor: pointer` already; add `:active` states |
| **macOS / Linux** | Pure Tauri — the only OS-specific work is bundler icons, `CFG` gates, and a CI matrix. No code changes expected |
| **Android / iOS (future)** | Tauri mobile supports the same commands; replace the sticky player with a bottom sheet + media session API |
| **Keyboard-only** | Tab order: search → results → player → queue; `Space` toggles play; `↑/↓` move the queue cursor |
| **Screen readers** | `aria-live="polite"` on badge + telemetry, `alt` on artwork, real `<button>` semantics for rows |
| **Slow networks** | Quality ladder + prefetch-next; show `Content-Length` in the badge so the cost is visible *before* streaming |
| **Offline** | Detect `navigator.onLine` and show a cached-history-only state rather than a spinner that never resolves |

**Portability rules:** no Windows-only APIs outside the bundler config; no hardcoded paths (use Tauri `app_data_dir`); no absolute URLs in the frontend except the images returned by the API.

---

## 22. Maintenance

| Activity | Cadence | Trigger/Tool |
|---|---|---|
| Run contract tests | every commit | `cargo test` (fails if mirror or CDN shape changes) |
| Re-verify route table | monthly | scripted probe of all 13 routes in §8.1 |
| Check mirror health | weekly | ping `/api/search/songs?query=test` |
| Dependency audit | monthly | `cargo outdated`, `npm audit` |
| WebView2/codec check | per release | manual: confirm `ftyp` + play |
| CSP tightening | before first public release | see §18 |
| Add offline test gate | Phase 5 | `OP_OFFLINE=1` env var |
| Documentation sync | per feature | `task.md` status table + this PRD |

**Code health targets:** ≤ 6 source files per side, no file > 600 lines, no dead code (the YouTube removal deleted `innertube.rs`, `minter.rs`, `ytclient.js`, `minter.js`, `vendor/` rather than leaving them dormant).

---

## 23. Alternatives & Fallback Options

### 23.1 Catalog sources

| Source | Access | Full-track playback | Account | Notes / fallback value |
|---|---|---|---|---|
| **JioSaavn (current)** | Community mirror, MIT reference server | ✅ decrypted URLs, full ranges | No | **Primary.** Large Indian catalog, 320 kbps, no client crypto |
| YouTube Music | InnerTube / rustypipe / youtubei.js | ⚠️ range-gated, PO-token fragile | No | **Abandoned** — full rationale in the removed spike docs (recycle bin) |
| Audius | Public HTTP API | ✅ | Optional | Decentralized, fully legal, weaker Indian catalog — **best legal fallback** |
| Internet Archive / Live Music Archive | Direct HTTPS | ✅ | No | 100% legal, niche catalog |
| Jamendo / Free Music Archive | Public API | ✅ | Optional | Creative-Commons catalog, good for a "free music" mode |
| SoundCloud (unofficial) | Community APIs | ⚠️ inconsistent | No | Fragile |
| Deezer | Official API | ❌ no stream without partner deal | Yes | Search/metadata only |
| Spotify Web API | Official | ❌ 30 s previews only | Yes | Metadata/playlists only — useful as an *enrichment* source |
| Gaana / Wynk / Apple Music | — | ❌ DRM or no public API | Yes | Excluded |

### 23.2 Fallback strategy inside the app

1. **Mirror failover:** try each entry in `MIRRORS` in order; record which hop failed in diagnostics.
2. **Quality failover:** 320 → 160 → 96 kbps if a URL fails the `ftyp` probe or playback errors.
3. **Status honesty:** if every candidate is `restricted_first_mb`, show `PREVIEW ONLY` rather than pretending.
4. **Source failover (future):** `search_songs` is the only catalog entry point — a second adapter can be tried in order without touching the UI.
5. **Playback failover:** on `audio.error`, mark the queue item `failed` and auto-advance rather than dead-ending.

### 23.3 Shell alternatives considered

| Shell | Verdict |
|---|---|
| **Tauri 2** ✅ | Smallest, Rust backend in-process, WebView2 evergreen |
| Electron | Rejected: ~150–300 MB per app, bundles Chromium |
| Neutralino.js | Rejected: weaker media/WebView2 story on Windows |
| Pure WebView2 C++/WinUI | Rejected: no cross-platform path, higher build cost |
| Flutter | Rejected: media/webview plugin churn, not HTML/CSS/JS |

---

## 24. Reference Projects & Links

| Link | Type / License | Stars | Short description |
|---|---|---|---|
| [sumitkolhe/jiosaavn-api](https://github.com/sumitkolhe/jiosaavn-api) | TypeScript · **MIT** · active (2026-06) | ★490 | **Primary reference.** Unofficial JioSaavn API; Hono + OpenAPI; powers the `saavn.sumit.co` mirror; returns decrypted `downloadUrl` per quality. Self-hostable on Vercel/Cloudflare. |
| [cyberboysumanjay/JioSaavnAPI](https://github.com/cyberboysumanjay/JioSaavnAPI) | Python · MIT | ★458 | Python reverse-engineering of the same endpoints. Useful as a second implementation to cross-check wire formats; **not shippable here** (language constraint). |
| [anxkhn/jiosaavn-api](https://github.com/anxkhn/jiosaavn-api) | Python · GPL-3.0 · active (2026-06) | ★70 | FastAPI, high-performance, DRM-free emphasis. Good reading for edge cases; GPL makes it a poor fit as a dependency. |
| [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | Rust · Apache-2.0 | ★111k | The application shell itself. |
| [Rishisharmacoder/Tall_Music_APP](https://github.com/Rishisharmacoder/Tall_Music_APP) | TypeScript · MIT | ★1 | React Native consumer of the same API — evidence the route shape is stable across clients. |
| [tauri-docs — HTTP plugin / fetch](https://tauri.app/plugin/http/) | Docs | — | Reference for Tauri's own HTTP capabilities (we use reqwest in Rust instead, for range control). |
| [Hono](https://hono.dev) / [Scalar](https://github.com/scalar/scalar) | MIT | — | What the mirror is built on; its `/swagger` doc is how §8.1 was enumerated. |
| [ISO/IEC 14496-12 (ISO-BMFF)](https://www.iso.org/standard/79110.html) | Spec | — | The `ftyp/moov/mdat` structure the liveness probe validates. |
| [MDN — HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range) | Docs | — | Semantics the relay implements verbatim. |
| [MDN — Using the audio element](https://developer.mozilla.org/en-US/docs/Web/API/HTMLAudioElement) | Docs | — | Native playback path, no sidecar. |
| [Electron](https://www.electronjs.org) | MIT | — | Rejected shell (see §23.3). |
| [Audius](https://audiusproject.github.io/api-docs/) | Public API | — | Best *legal* alternative catalog (see §23.1). |

**Historical (removed):** the YouTube verification spike (`rustypipe`, `rustypipe-botguard`, `youtubei.js`, `bgutils-js`) was fully deleted from the workspace; its conclusions survive only as the risk notes in §14/§15.

---

## 25. Future Scope

The roadmap now lives in **[`future-scope.md`](future-scope.md)** — one
cross-platform file, tiered near / mid / far / out-of-scope, with the mobile
items alongside the desktop ones.

Items from the original version of this section and their status:

| Item | Status |
|---|---|
| Album / artist / playlist browsing | ✅ shipped |
| Album-art cache on disk | ✅ shipped |
| `OP_OFFLINE=1` test gate + CI workflow | ✅ shipped |
| Media Session API (lock-screen controls) | ✅ shipped (mobile) |
| Global hotkeys, tray icon | ✅ shipped (desktop) |
| Lyrics | ✅ shipped (LRCLIB → JioSaavn → LRCLIB) |
| Cross-platform packaging (macOS/Linux/mobile) | ✅ shipped |
| Quality picker in the player UI | ⬜ open — see [`future-scope.md`](future-scope.md) 🔜 |
| Seek bar with buffered-ranges display | ⬜ open |
| Multiple source adapters behind one `Catalog` trait | ⬜ open — 🔭 far |
| On-disk library of "recently played" | ⬜ open — 📅 mid |
| Plugin system, self-hosted catalog mode | ⬜ open — 🔭 far |
| Scrobbling, equalizer, gapless | ⬜ open — 📅 mid |
| DRM, account-gated streaming, telemetry | ⛔ never |

---

## 26. Phasewise Plan

Detailed task breakdown, acceptance criteria and live status live in **`task.md`**. Summary:

| Phase | Name | Status |
|---|---|---|
| 0 | Requirement & source verification spike | ✅ done |
| 1 | Erase YouTube completely | ✅ done |
| 2 | JioSaavn Rust backend + contract tests | ✅ done (138 tests) |
| 3 | Minimal functional UI (search → play) | ✅ done |
| 4 | End-to-end playback verification | ✅ done (byte-count tests in CI) |
| 5 | Browsing (albums/artists/playlists) | ✅ done · quality picker ⬜ |
| 6 | UX polish, accessibility, keyboard, theming | 🟡 shortcuts/widget done; light theme + a11y open |
| 7 | Hardening: CSP, offline test gate, CI | ✅ done |
| 8 | Packaging, cross-platform | ✅ Windows/Linux/macOS |
| 9 | Android shell | ✅ done · Android CI ⬜ |
| 10 | iOS shell + CI | ✅ done (macOS runners) |

---

## 27. Open Questions

1. Ship the default mirror URL, or require users to configure one (cleaner legally)?
2. Should `restricted_first_mb` results auto-downgrade quality and retry, or surface the choice to the user?
3. Do we add an Audius/Creative-Commons adapter as a *legal default* alongside the main catalog?
4. Which comes first: Android CI, or the quality picker? (Both are small — see [`task.md`](task.md) §5.)

---

## 28. Related Documents

- **[`architecture.md`](architecture.md)** — components, data flows, module contracts, concurrency, trust boundaries.
- **[`ui.md`](ui.md)** — screens, components, states, tokens, accessibility, responsive behaviour.
- **[`task.md`](task.md)** — phase-by-phase task list with acceptance criteria and live status.
- **[`feature-list.md`](feature-list.md)** — what exists on desktop vs mobile, and what is absent from each.
- **[`future-scope.md`](future-scope.md)** — tiered roadmap plus what is explicitly out of scope.
