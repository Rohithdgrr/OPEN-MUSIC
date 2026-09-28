# Task Plan — Open Player

Companion to `PRD.md`, `architecture.md`, `ui.md`.

**Legend:** ✅ done · 🟡 in progress · ⬜ planned · ❌ blocked/abandoned

---

## 0. Status Snapshot (2026-09-28)

| Phase | Name | Status |
|---|---|---|
| 0 | Source verification spike | ✅ |
| 1 | Erase YouTube completely | ✅ |
| 2 | JioSaavn backend + contract tests | ✅ |
| 2b | First-party JioSaavn source + mirror `429` failover | ✅ 21/21 pass |
| 3 | Minimal functional UI | ✅ |
| 3b | Search screen: every control wired + download + paging | ✅ 30/30 UI assertions |
| 4 | End-to-end playback verification | 🟡 |
| 5 | Browsing + quality picker | ⬜ |
| 6 | UX polish + accessibility | ⬜ |
| 7 | Hardening + CI | ⬜ |
| 8 | Packaging + cross-platform | ⬜ |

**Working tree today**

```
PRD.md  architecture.md  ui.md  task.md
app/
├─ package.json                 (1 devDependency: @tauri-apps/cli)
└─ src/                         ← frontend, no build step
   ├─ index.html      1719 B
   ├─ main.js         8840 B
   └─ styles.css      4543 B
└─ src-tauri/
   ├─ Cargo.toml / Cargo.lock / tauri.conf.json / capabilities/default.json
   └─ src/
      ├─ main.rs          33 B  (entry only)
      ├─ lib.rs         5728 B  (IPC commands + lifecycle + download_song)
      ├─ official.rs   13899 B  (first-party api.php source + DES decrypt)
      ├─ jiosaavn.rs   26137 B  (source failover, models, probes, parsers)
      └─ proxy.rs      14606 B  (localhost range relay, caches, downloads)
```

```
app/src/  (frontend, no build step)
   ├─ index.html   122498 B  (three Stitch views)
   ├─ main.js       39798 B  (controller: search/queue/player/controls)
   └─ styles.css     1662 B
```

**Definition of Done for every phase**

1. `cargo build` clean — zero warnings.
2. `cargo test` green — no skipped network tests.
3. No new runtime language, no new framework, no new `package.json` dependency.
4. Every stream-affecting change has a test asserting **byte counts**, not just status codes.
5. `PRD.md` / `task.md` status tables updated.
6. No dead code left behind.

---

## Phase 0 — Source Verification Spike ✅

Goal: prove a full-song source exists *before* writing an app.

| # | Task | AC | Status |
|---|---|---|---|
| 0.1 | Probe mirror search routes | `/api/search/songs|albums|artists|playlists` → 200 with results | ✅ |
| 0.2 | Probe detail routes | `/api/songs/{id}`, `/api/albums?id=`, `/api/artists/{id}`, `/api/artists/{id}/songs`, `/api/playlists?id=` → 200 | ✅ |
| 0.3 | Confirm decrypted streams | `downloadUrl[]` present with 5 qualities on `aac.saavncdn.com` | ✅ |
| 0.4 | Confirm no range gate | `bytes=0-63`, `bytes=0-`, `bytes=2000000-2065535` all → `206` | ✅ |
| 0.5 | Confirm full file reachable | 10,527,454 / 10,527,454 bytes, `audio/mp4` | ✅ |
| 0.6 | Confirm container validity | box walk `ftyp(28) → moov(45922) → free(8) → mdat(10481496)` (faststart) | ✅ |
| 0.7 | Enumerate route table | 13 routes from the mirror's `/swagger` | ✅ |
| 0.8 | Record known broken routes | `/api/songs/{id}/suggestions` → 500; `/api/albums/{id}` → 404 | ✅ |
| 0.9 | Evaluate reference repos | `sumitkolhe/jiosaavn-api` (MIT) chosen as reference | ✅ |

**Exit:** full-song streaming is achievable with no client-side cryptography.

---

## Phase 1 — Erase YouTube Completely ✅

Goal: no dormant YouTube code, no half-dead paths.

| # | Task | AC | Status |
|---|---|---|---|
| 1.1 | Delete `src-tauri/src/innertube.rs` | file gone; `cargo build` green | ✅ |
| 1.2 | Delete `src-tauri/src/minter.rs` | file gone | ✅ |
| 1.3 | Delete `src/minter.js`, `src/ytclient.js` | files gone | ✅ |
| 1.4 | Delete `src/vendor/` (youtubei.js, bgutils) | directory gone | ✅ |
| 1.5 | Delete `verify-pot/` harness | directory gone | ✅ |
| 1.6 | Remove `/upstream` proxy route + YouTube allow-list | only `/stream` remains | ✅ |
| 1.7 | Remove `resolve_track*`, `get_bg_challenge`, `generate_it`, `range_status_label` commands | handler lists 4 commands | ✅ |
| 1.8 | Keep reusable infrastructure | proxy shell, queue/history/diagnostics UI, `RangeStatus` idea preserved | ✅ |
| 1.9 | Grep for YouTube residue in `app/` | zero matches for `youtube\|innertube\|botguard\|pot\b` | ✅ |

**Exit:** the app contains only JioSaavn code.

---

## Phase 2 — JioSaavn Backend + Contract Tests ✅

Goal: a tested Rust backend that searches, resolves, qualifies and relays.

| # | Task | AC | Status |
|---|---|---|---|
| 2.1 | `jiosaavn.rs`: mirror list + `get_json` with failover | multi-base, errors name the failing URL | ✅ |
| 2.2 | Models `Track` / `QualityUrl` / `Song` / `PlayableAudio` / `RangeStatus` / `Probe` | serde, `snake_case` on the wire | ✅ |
| 2.3 | Defensive parsing helpers | `text`/`number`/`best_image`/`artist_names` tolerate nulls | ✅ |
| 2.4 | `search_songs(query, limit)` | clamps 1–50, percent-encodes, returns `Track[]` | ✅ |
| 2.5 | `fetch_song(id)` | validates id, unwraps array/object envelope, errors if no qualities | ✅ |
| 2.6 | `best_quality(qualities, prefer)` | exact match else highest bitrate | ✅ |
| 2.7 | `qualify_url` three-probe logic | head `ftyp` + mid-file + open-ended | ✅ |
| 2.8 | `proxy.rs`: rewrite for `*.saavncdn.com` | https + host allow-list, `400` otherwise | ✅ |
| 2.9 | `resolved` + `qualified` memoisation | repeat resolves/probes hit cache | ✅ |
| 2.10 | Two-client policy (`api_client` / `media_client`) | no total timeout on media bodies | ✅ |
| 2.11 | `lib.rs` commands: `search_songs`, `resolve_song`, `qualify_url`, `proxy_base` | registered, DTOs shaped | ✅ |
| 2.12 | Ephemeral port bound before window load | `127.0.0.1:0` → `local_addr()` in `setup` | ✅ |
| 2.13 | Unit tests (parse/host/id/duration/quality) | 5 tests | ✅ |
| 2.14 | Live contract tests (search + resolve + qualify) | 2 tests | ✅ |
| 2.15 | Proxy tests (bounded / mid-file / full-body / allow-list / params) | 5 tests | ✅ |

**Total: 12 tests, all green (~48 s, network-backed).**

Key regression guard:

```rust
stream_delivers_the_entire_body  // asserts received == Content-Length (10,527,454)
```

**Exit:** `cargo test` proves the backend can deliver a whole song.

---

## Phase 3 — Minimal Functional UI ✅

Goal: search → click → sound, with honest status.

| # | Task | AC | Status |
|---|---|---|---|
| 3.1 | `index.html` zones | header, search, history, banner, results, player, queue, diagnostics | ✅ |
| 3.2 | Search render with artwork | thumb + title + artist · album · duration | ✅ |
| 3.3 | `playQueueItem` resolve flow | `resolve_song` → badge → `audio.src` → play | ✅ |
| 3.4 | Badge from `RangeStatus` | three states + `document.title` mirror | ✅ |
| 3.5 | Telemetry line | state, `readyState`, position, quality, host, error code | ✅ |
| 3.6 | Queue: add / dedup / jump / play-all / clear | all interactions work | ✅ |
| 3.7 | Auto-advance on `ended` and on error | 600 ms delay, states marked | ✅ |
| 3.8 | History chips (localStorage, 8, dedup) | click resubmits | ✅ |
| 3.9 | Diagnostics ring buffer (40) | timestamped, ok/bad | ✅ |
| 3.10 | Styles: tokens, sticky player, ellipsis, responsive | 640 px column, 800×600 correct | ✅ |
| 3.11 | Wire header source readout | shows `JioSaavn · 127.0.0.1:<port>` | ✅ |

**Exit:** a human can search and start playback in the real window.

---

## Phase 2b / 3b — First-party Source + Search-Screen Controls ✅

Goal: search must never die on a mirror's quota, the catalog must be
unbounded, and every button on the search screen must do something real.

| # | Task | AC | Status |
|---|---|---|---|
| 2b.1 | `official.rs`: `search.getResults` with `n`/`p` paging | page 1 and page 2 are disjoint; `total` = 5189 for one query | ✅ |
| 2b.2 | `official.rs`: `song.getDetails` (`pids`) + DES-ECB decrypt | known vector → `https://aac.saavncdn.com/…_96.mp4` | ✅ |
| 2b.3 | Rendition synthesis `_12/_48/_96/_160/_320` | 5 qualities, `_320` = complete song | ✅ |
| 2b.4 | `jiosaavn.rs`: official-first dispatch, mirrors as fallback | both paths return the same `Track`/`Song` shapes | ✅ |
| 2b.5 | Mirror `429` = one request then fail over | no retry storm; error names the failing URL | ✅ |
| 2b.6 | `search_songs(query, limit, page)` + page-keyed cache | `lib.rs`, `proxy.rs`, tests updated | ✅ |
| 2b.7 | `download_song` command, byte-count checked | `download_writes_exactly_the_declared_bytes` | ✅ |
| 3b.1 | Filter chips (all / 320 kbps / 5 min+ / 3 genres) | filter or search, `aria-pressed`, count announced | ✅ |
| 3b.2 | Sort cycling + Refine Filters toggle | label follows state, table re-orders | ✅ |
| 3b.3 | Featured carousel: prev/next, play, download | real results, not mock cards | ✅ |
| 3b.4 | Load more + Retry on failure | pages to exhaustion, hides at the end | ✅ |
| 3b.5 | Rows are `role="button" tabindex="0"`; per-row download | Enter plays, download does not also play | ✅ |
| 3b.6 | Headless UI self-test (stub IPC) | **30/30 assertions green** | ✅ |
| 3b.7 | `cargo build` zero warnings, `cargo test` green | 21/21 | ✅ |

**Exit:** search works from JioSaavn directly (no mirror quota), results page
without limit, and every search-screen control is wired and verified.

---

## Phase 4 — End-to-End Playback Verification 🟡

Goal: record irrefutable evidence that the shipped binary streams a complete song.

| # | Task | AC | Status |
|---|---|---|---|
| 4.1 | Rebuild `app.exe` after the two-client fix | `target/debug/app.exe` timestamp newer than the fix | ✅ |
| 4.2 | Launch app, discover proxy port | process alive, loopback listener found | ✅ |
| 4.3 | Bounded probe through the running app | `206`, `Content-Length: 64`, `ftyp` | ✅ |
| 4.4 | **Full-body download through the running app** | `received == 10,527,454`, no truncation | 🟡 *(one clean run recorded after the rebuild; a transient cold-mirror `502` was observed once)* |
| 4.5 | Container walk on the downloaded file | `ftyp → moov → free → mdat`, sizes sum correctly | 🟡 |
| 4.6 | Mid-file seek through the running app | `bytes=2000000-2065535` → 206, exactly 65,536 bytes | ⬜ |
| 4.7 | Confirm audio decodes in WebView2 | `readyState=4`, `currentTime` advances to `ended` | ⬜ *(needs human or UI automation)* |
| 4.8 | Measure cold start → window | < 2 s target | ⬜ |
| 4.9 | Measure search + resolve latency | < 800 ms / < 1.5 s | ⬜ |
| 10 | Record evidence in `PRD.md §2.1` | S1–S7 rows updated with numbers | ⬜ |

**Exit criteria:** S4 and S6 signed off with numbers, plus one human confirmation that a track plays to `ended`.

---

## Phase 5 — Browsing, Quality, Caching ⬜

| # | Task | AC |
|---|---|---|
| 5.1 | Album browse (`/api/albums?id=`) | album header + track list plays |
| 5.2 | Artist browse (`/api/artists/{id}` + `/songs`) | paginated list |
| 5.3 | Playlist browse (`/api/playlists?id=`) | full track list |
| 5.4 | Album/artist/playlist search tabs | switcher above results |
| 5.5 | Quality picker in the player | shows `qualities[]`, switching re-resolves |
| 5.6 | Auto quality on slow first-byte | drop 320 → 160 when TTFB exceeds threshold |
| 5.7 | Artwork disk cache | second render is instant, offline-tolerant |
| 5.8 | Search result cache (5 min) | repeat query is instant |
| 5.9 | Speculative resolve of next queue item | no visible latency on advance |
| 5.10 | Extract `Catalog` trait + second adapter (optional Audius/legal CC source) | both sources playable |
| 5.11 | Extract `MEDIA_HOSTS` per adapter | still a single allow-list check |

---

## Phase 6 — UX Polish & Accessibility ⬜

| # | Task | AC |
|---|---|---|
| 6.1 | **Result/queue rows become `<button>`s** | Tab reaches every row, Enter plays |
| 6.2 | `:focus-visible` rings | visible on all interactive elements |
| 6.3 | `aria-live="polite"` on badge + telemetry | screen readers announce state changes |
| 6.4 | Keyboard shortcuts (Space, ↑/↓, Escape, 1–9) | documented in `ui.md §9` |
| 6.5 | Light theme via `prefers-color-scheme` | seven tokens flip; contrast still AA |
| 6.6 | Two-column layout ≥ 1100 px | results + queue side by side |
| 6.7 | `prefers-reduced-motion` guard | smooth scroll disabled |
| 6.8 | Persist diagnostics to disk | survives restart |
| 6.9 | Empty-state copy | no-query / no-results differentiated |
| 6.10 | Media keys / OS integration | play/pause/next via Media Session API |

---

## Phase 7 — Hardening & CI ⬜

| # | Task | AC |
|---|---|---|
| 7.1 | Real CSP in `tauri.conf.json` | app still works; `csp` no longer `null` |
| 7.2 | `OP_OFFLINE=1` gate for network tests | suite passes without egress |
| 7.3 | CI workflow: build + offline tests on push | green badge |
| 7.4 | Nightly job running the full network suite | failures surface mirror/CDN drift |
| 7.5 | Multi-mirror failover + health check | kill primary mirror → app still searches |
| 7.6 | Route-table probe script (all 13 routes) | weekly, reports `200/404/500` |
| 7.7 | `cargo clippy` + `rustfmt --check` | zero warnings |
| 7.8 | Dependency audit | `cargo outdated`, `npm audit` |
| 7.9 | Error message review | no raw `Err` reaches the user unformatted |

---

## Phase 8 — Packaging & Cross-Platform ⬜

| # | Task | AC |
|---|---|---|
| 8.1 | `npm run tauri build` → NSIS installer | installs and runs on a clean VM |
| 8.2 | MSI target | enterprise-friendly |
| 8.3 | Release profile verification | LTO/strip/`panic=abort` effective, binary < 15 MB |
| 8.4 | App icon + metadata | `productName`, icon, `identifier` finalised |
| 8.5 | macOS build (CI matrix) | DMG produced, plays audio |
| 8.6 | Linux build (CI matrix) | AppImage/deb, WebView2→WebKitGTK verified |
| 8.7 | Auto-update channel | Tauri updater configured or explicitly deferred |
| 8.8 | Mobile spike (Tauri Android/iOS) | search + playback on device |

---

## 9. Cross-Cutting Tasks

| # | Task | Phase | Status |
|---|---|---|---|
| X.1 | Keep docs in sync with code | all | 🟡 this document |
| X.2 | Never reintroduce a framework | all | ✅ (rule in `PRD.md §13`) |
| X.3 | Every new stream path needs a byte-count test | all | ✅ |
| X.4 | Legal/ToS decision before public release | 7 | ⬜ owner decision |
| X.5 | Choose final product name (`Open Player` is a placeholder) | 8 | ⬜ |
| X.6 | Decide default mirror policy (ship URL vs user-configured) | 7 | ⬜ |

---

## 10. Risk-Linked Tasks

| Risk | Task that pays it down | Phase |
|---|---|---|
| Single mirror down | 7.5 multi-mirror failover | 7 |
| CDN starts gating ranges | 2.7 probes + 4.6 evidence re-run | 2/4 |
| CDN URLs rotate | 3.3 resolve-on-click + `ftyp` liveness | 3 |
| Silent body truncation | 2.10 two-client + full-body test | 2 ✅ |
| No offline CI | 7.2 `OP_OFFLINE=1` | 7 |
| Keyboard users locked out | 6.1 button semantics | 6 |
| CSP `null` in release | 7.1 real CSP | 7 |
| Throughput too low | 5.6 auto quality | 5 |

---

## 11. Immediate Next Actions

Ordered, smallest first:

1. **4.4/4.5** — one clean full-body download through the freshly built binary; record the byte count and box walk.
2. **4.6** — mid-file range through the running app.
3. **4.7** — human check: search, click, confirm `currentTime` reaches `ended`.
4. **4.8/4.9** — record cold-start and latency numbers into `PRD.md §2.1` and `§17`.
5. **6.1/6.2/6.3** — accessibility trio (highest-value UI debt).
6. **7.1** — CSP before any public release.
7. **Phase 5** — browsing + quality picker (the feature work users actually feel).

---

## 12. Effort Snapshot

| Phase | Est. effort | Confidence |
|---|---|---|
| 0–3 (done) | — | — |
| 4 verification | 0.5 day | High (mechanical) |
| 5 browsing/quality/cache | 2–3 days | High (routes already verified) |
| 6 polish/a11y | 1–2 days | High |
| 7 hardening/CI | 1–2 days | Medium (CI egress config) |
| 8 packaging/cross-platform | 2–4 days | Medium (signing, WebViewKitGTK) |
