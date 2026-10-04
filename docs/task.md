# Task Plan — TRANCE MUSIC

Companion to [`PRD.md`](PRD.md), [`architecture.md`](architecture.md),
[`feature-list.md`](feature-list.md), [`future-scope.md`](future-scope.md).

**Legend:** ✅ done · 🟡 in progress · ⬜ planned · ⛔ parked

---

## 0. Status Snapshot (2026-10-04)

| Phase | Name | Status |
|---|---|---|
| 0 | Source verification spike | ✅ |
| 1 | Erase YouTube completely | ✅ |
| 2 | JioSaavn backend + contract tests | ✅ 138 tests |
| 2b | First-party source + mirror `429` failover | ✅ |
| 3 | Minimal functional UI (search → play) | ✅ |
| 3b | Search screen: every control wired + paging | ✅ 30/30 UI assertions |
| 4 | End-to-end playback verification | ✅ byte-count tests in CI |
| 5 | Browsing (album/artist/playlist) + charts | ✅ |
| 5b | Quality picker in the player | ⬜ |
| 6 | UX polish + accessibility | 🟡 shortcuts/widget done; light theme, a11y audit open |
| 7 | Hardening + CI | ✅ CSP, offline gate, fmt/clippy/audit/ESLint |
| 8 | Packaging + cross-platform | ✅ Windows/Linux/macOS releases |
| 9 | Android shell | ✅ 13 screens, APK/AAB |
| 9b | Android CI workflow | ⬜ local build only today |
| 10 | iOS shell + CI | ✅ macOS runners, unsigned simulator |
| 11 | Release pipeline hardening | ✅ manifest-verified before publish |

**Version:** `0.3.0` — `app/package.json:4` · `Cargo.toml:3` · `tauri.conf.json:4`
**IPC contract:** `api_version() -> 1` — `app/src-tauri/src/lib.rs:290`

---

## 1. Working tree today

```
app/
├─ package.json                 (5 devDependencies: tauri cli, eslint, tailwind, …)
├─ eslint.config.mjs  tailwind.config.cjs  tailwind.input.css
├─ tests/                       58 frontend tests (6 files)
└─ src/                         ← frontend, no runtime build step
   ├─ index.html                8 views + Settings dialog
   ├─ main.js                   159 B entry → 28 feature modules (~10,000 lines)
   ├─ widget.html / widget.js   always-on-top desktop widget
   ├─ mobile/                   13-screen Android/iOS shell (~5,800 lines)
   │   ├─ index.html  router.js  app.js  player.js  …
   │   └─ screens/    13 × (.html + .js)
   └─ tailwind.css              prebuilt (`npm run css`)
└─ src-tauri/                   15 Rust files, ~11,200 lines, 138 tests
   ├─ Cargo.toml / Cargo.lock / tauri.conf.json
   ├─ tauri.android.conf.json / tauri.ios.conf.json   ← overlays
   ├─ capabilities/  gen/ (android project, schemas)
   └─ src/
      ├─ main.rs        5 B    (entry only)
      ├─ lib.rs      1,494     IPC surface (48 commands) + lifecycle + vault
      ├─ proxy.rs   2,452     axum relay, moka caches, vault, SQLite ledger
      ├─ official.rs 1,874    first-party api.php + DES decrypt
      ├─ jiosaavn.rs 1,760    mirror failover, models, probes, parsers
      ├─ lyrics.rs     587    LRCLIB → JioSaavn → LRCLIB
      ├─ cache.rs      463    bounded disk cache tree
      ├─ update.rs     384    GitHub release checks (desktop + Android)
      ├─ gdrive.rs     800    Google Drive backup/sync
      ├─ db.rs         278    download ledger (SQLite)
      ├─ shortcuts.rs  271    Hyper chords + fallbacks
      ├─ transcode.rs  302    quality promotion
      ├─ sha256.rs     239    vault integrity
      ├─ sysvol.rs     144    Windows master volume ⛔ parked
      └─ widget.rs     162    widget window commands
```

## 2. Definition of Done (every phase)

1. `cargo build` clean — zero warnings.
2. `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` clean.
3. `OP_OFFLINE=1 cargo test` green (what CI gates on); live suite green separately.
4. `npm run lint` + `node --check` on every touched module; `npm test` green.
5. No new runtime language, no new framework, no new `package.json` runtime dep.
6. **Every stream-affecting change has a test asserting byte counts**, not just status codes.
7. `CHANGELOG.md` `[Unreleased]` entry if a user would notice.
8. `docs/feature-list.md` updated in the same commit if a platform's feature set changed.
9. No dead code left behind.

---

## 3. Phase detail (history)

### Phase 0 — Source verification spike ✅

Proved a full-song source exists before writing an app: 13 mirror routes
enumerated, `206` on bounded/open-ended/mid-file ranges, full body reachable
(10,527,454 B), container walk `ftyp → moov → free → mdat`.

### Phase 1 — Erase YouTube completely ✅

`innertube.rs`, `minter.rs`, `ytclient.js`, `minter.js`, `vendor/`, the
`/upstream` proxy route and four commands deleted. Grep for
`youtube|innertube|botguard|pot\b` → zero matches in `app/`.

### Phase 2 — Backend + contract tests ✅ → 138 tests

Mirror failover, models, defensive parsing, `qualify_url` three-probe logic,
host allow-list, two-client policy, ephemeral port bound before window load.

**Key regression guard:** `stream_delivers_the_entire_body` asserts
`received == Content-Length`.

### Phase 2b / 3b — First-party source + search controls ✅

`official.rs` primary (`search.getResults` paging, `song.getDetails` + DES-ECB
decrypt), mirrors as fallback, one-request `429` failover, byte-checked
`download_song`, filter chips / sort / carousel / load-more / retry, 30-assertion
headless UI self-test.

### Phase 4 — End-to-end playback verification ✅

Byte-count and mid-file range tests in CI; full-body guard green offline.

### Phase 5 — Browsing ✅ · 5b Quality picker ⬜

Album, artist, playlist and chart pages shipped
(`album_tracks`, `artist_overview`, `artist_tracks`, `playlist_tracks`).
Quality picker still open: `qualities[]` reaches the DTO but no UI surfaces it.

### Phase 6 — UX polish + accessibility 🟡

| # | Task | Status |
|---|---|---|
| 6.1 | Result/queue rows are real interactive elements | 🟡 verify per screen |
| 6.2 | `:focus-visible` rings everywhere | ⬜ audit |
| 6.3 | `aria-live` on badge + telemetry | ⬜ |
| 6.4 | Keyboard shortcuts | ✅ `docs/shortcuts.md` |
| 6.5 | Light theme via `prefers-color-scheme` | ⬜ |
| 6.6 | Two-column layout ≥ 1100 px | ⬜ |
| 6.7 | `prefers-reduced-motion` guard | ⬜ |
| 6.8 | Media keys / OS integration | ✅ tray + media session |
| 6.9 | Empty-state copy differentiation | 🟡 |

### Phase 7 — Hardening + CI ✅

| # | Task | Status |
|---|---|---|
| 7.1 | Real CSP in `tauri.conf.json` | ✅ `default-src 'self'`, `frame-src 'none'`, hashed boot scripts |
| 7.2 | `OP_OFFLINE=1` gate | ✅ `ci.yml:22` |
| 7.3 | CI workflow | ✅ fmt, clippy, offline tests, `cargo audit`, ESLint, syntax |
| 7.4 | Nightly full network suite | ⬜ |
| 7.5 | Multi-mirror failover | ✅ one request per `429`, then next source |
| 7.6 | Route-table probe script | ⬜ |
| 7.7 | `clippy` + `rustfmt --check` | ✅ in CI |
| 7.8 | Dependency audit | ✅ `cargo audit` in CI |
| 7.9 | Error message review | ✅ review pass landed |

### Phase 8 — Packaging + cross-platform ✅

NSIS/MSI signed at build time; `release.yml` matrix produces Windows, Linux and
macOS bundles with `certificateThumbprint: null` on CI (local signing only),
then verifies updater manifest URLs before publishing.

### Phase 9 / 10 — Mobile ✅ · 9b Android CI ⬜

Android shell + overlays + 13 screens shipped. iOS builds on macOS runners
(`ios.yml`). **Android still builds locally** — no workflow yet.

---

## 4. Cross-cutting tasks

| # | Task | Phase | Status |
|---|---|---|---|
| X.1 | Keep docs in sync with code | all | 🟡 this document + `feature-list.md` |
| X.2 | Never reintroduce a framework | all | ✅ rule in `PRD.md §13` |
| X.3 | Every new stream path needs a byte-count test | all | ✅ |
| X.4 | Legal/ToS decision before public distribution | release | ⛔ owner decision |
| X.5 | Choose final product name (`Open Player` in old docs is a placeholder) | — | ✅ **TRANCE MUSIC** |
| X.6 | Default mirror policy (ship URL vs user-configured) | — | 🟡 ship list, self-host documented |

---

## 5. Immediate next actions

Ordered, smallest first:

1. **9b** — Android CI workflow mirroring `ios.yml` (smoke build + APK/AAB on tag).
2. **CI covers mobile JS** — extend `ci.yml` from `src/*.js` to `src/mobile/**/*.js`.
3. **5b** — quality picker (the backend already answers; it is UI-only work).
4. **6.2 / 6.3** — focus rings + `aria-live` (highest-value a11y debt).
5. **6.5** — light theme (seven tokens + one media query).
6. **7.4 / 7.6** — nightly network suite + route-table probe (drift detection).
7. **Real DSP + crossfade** — the UI already promises them; see
   [`future-scope.md`](future-scope.md).

---

## 6. Risk-linked tasks

| Risk | Pays it down | Phase |
|---|---|---|
| Mirror down or route drift | 7.5 multi-source failover + 7.6 route probe | 7 |
| CDN starts gating ranges | range probes + byte-count tests | 2 ✅ |
| CDN URLs rotate | resolve-on-play + `ftyp` liveness | 3 ✅ |
| Silent body truncation | two-client policy + full-body test | 2 ✅ |
| Keyboard users locked out | 6.1 button semantics | 6 |
| Front-end regression with no runner | 58 `node --test` suites | ✅ |
| Mobile JS untested in CI | CI covers `src/mobile/**` | 9b |
| Android drift (local-only builds) | Android workflow | 9b |

---

## 7. Effort snapshot

| Work | Est. effort | Confidence |
|---|---|---|
| Android CI workflow | 0.5 day | High (mirrors `ios.yml`) |
| Mobile JS in CI | 0.5 hour | High |
| Quality picker (5b) | 0.5 day | High (DTO ready) |
| A11y trio (6.1–6.3) | 1 day | Medium (needs per-screen pass) |
| Light theme (6.5) | 0.5 day | High (tokens exist) |
| Nightly suite + route probe | 1 day | Medium (CI egress) |
| Real DSP + crossfade | 2–3 days | Medium (Web Audio) |
