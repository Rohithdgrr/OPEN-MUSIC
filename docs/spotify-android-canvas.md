# Spotify on Android + Spotify Canvas — Design Spec

| | |
|---|---|
| Date | 2026-10-07 (implementation log 2026-10-15, §9/§10) |
| Status | **approved design** — §3A/§3B backend built; §3C UI + §3B renderer under implementation |
| Scope | (A) Spotify sign-in on Android, (B) Canvas on the mobile Now Playing screen, (C) mobile Settings UI |
| Companion docs | [feature-list](feature-list.md) §8/§9/§10 · [mobile/08-future-scope](mobile/08-future-scope.md) · [future-scope](future-scope.md) §📅 Mid · [mobile/09-problems-solutions](mobile/09-problems-solutions.md) |

---

## 1. Problem (root causes, verified)

Spotify integration is impossible on Android today. Four independent blocks, each
traced to code:

| # | Block | Evidence |
|---|---|---|
| R1 | Credential store hard-stubbed off on mobile | `app/src-tauri/src/spotify.rs:122-135` — `keyring_save/load/delete` under `cfg(mobile)` all return `Err("Spotify sign-in is not supported on mobile yet")`. `keyring` is declared only under `cfg(not(any(android,ios)))` (`Cargo.toml:52-67`), so there is no Android backend to call. |
| R2 | No way to open a browser | `spotify.rs:305-317` `open_browser` shells `xdg-open`/`open` — neither exists on Android (`ENOENT`). `lib.rs:1367` `open_external` returns an explicit `Err` for the same reason. |
| R3 | No mobile Settings UI | `grep` for `spotify_` / `set-spotify` under `app/src/mobile/` → **0 hits**. The whole Spotify panel lives in desktop `settings.js:744-783, 1053-1074, 1848-1981`. |
| R4 | Canvas has no official API | `mobile/08-future-scope.md:22-39`, `future-scope.md:69-72`. Only undocumented Pathfinder GraphQL + `sp_dc`. Also: normal JioSaavn playback returns **no ISRC** — `resolve_song` (`lib.rs:156`) has no `isrc` field; only `spotify_import_top` carries one (`spotify.rs:459`). |

**Not a bug, a configuration fact (user decision):** this build has **no**
Spotify client id — `app/src-tauri/.spotify-client-id` is absent and
`TRANCE_MUSIC_SPOTIFY_CLIENT_ID` is unset (verified this session). So every
Spotify command must degrade to `not configured`, never throw.

## 2. Decisions made (user, 2026-10-07)

1. **Mobile sign-in = full OAuth via Android browser Intent**, reusing the existing loopback listener.
2. **`tauri-plugin-opener` approved** (new dependency — standing rule 7 / feature-list P2-4).
3. **Canvas: build it now**, gated **off** by default, art fallback on any miss.
4. **Build without a client id** — graceful `not configured` until credentials land.

## 3. Design

### A. Mobile OAuth — loopback works as-is, only the opener changes

The existing flow is RFC 8252 *loopback* redirection: `spotify_signin`
(`spotify.rs:466`) binds a `std::net::TcpListener` on `127.0.0.1:4321`
(`spotify.rs:484`) **in Rust**, opens the browser, and reads the `code` off the
socket. That listener runs on the phone's own loopback when the app runs on
Android — so Spotify's redirect to `http://127.0.0.1:4321/callback` lands on our
socket without any deep-link plugin or custom URL scheme.

- **Opener:** `open_browser` (`spotify.rs:283-317`) gains a `cfg(mobile)` branch
  calling `tauri_plugin_opener::open_url` (or the `Opener` ext trait on `AppHandle`).
  Desktop keeps the existing `ShellExecuteW` / `open` / `xdg-open` code untouched.
- **Redirect URI registration:** the Spotify Dashboard app must list
  `http://127.0.0.1:4321/callback` as a redirect URI. Documented as an operator
  step (§6); the code reports Spotify's refusal verbatim if it is missing.
- **Scope** stays `user-top-read user-library-read playlist-read-private` (`spotify.rs:22`).
- **Token exchange / refresh** (`spotify.rs:327-412`) is transport-agnostic — unchanged.

**Credential store (R1):** an internal `store_token(op)` seam in `spotify.rs`:

| Platform | Backing store | Mechanism |
|---|---|---|
| desktop (`cfg(not(mobile))`) | OS credential store | existing `keyring` fns (`spotify.rs:93-120`) |
| mobile (`cfg(mobile)`) | **sandboxed `store.db` kv table** | `store_kv_put/get` already registered (`lib.rs:381,376,1723-1724`) via `state.store().kv_put/kv_get` |

Key `spotify:refresh-token`. `spotify_is_signedin` (`spotify.rs:520`) reads
through the same seam, so desktop behaviour is byte-identical.

> **Tradeoff (accepted):** app-private SQLite, *not* Android Keystore/EncryptedFile.
> It is outside the app sandbox only via root/backup-extraction. Upgrade path:
> migrate the kv value to Keystore-wrapped later; the seam makes it a one-function
> change. Not built now (YAGNI).

**Desktop is unaffected:** `cfg(mobile)` gates only the mobile branch; every
existing desktop path keeps compiling and behaving identically.

### B. Canvas — new `canvas.rs`, keyed on ISRC, works off `sp_dc` alone

Canvas does **not** require the OAuth sign-in: the `sp_dc` cookie is a separate
secret that yields its own access token. So Canvas and §A are independently usable.

New `app/src-tauri/src/canvas.rs`, one command:

```
fetch_canvas(isrc: Option<String>, title: String, artist: String)
  -> Result<Option<String>, String>   // expiring mp4 URL, or None
```

Resolution order:
1. `sp_dc` from kv (`spotify:sp_dc`). Absent → `Err("Canvas not configured")`.
2. ISRC present? use it. Absent → resolve via Spotify search (`/v1/search`, matching
   `title`+`artist`) using the sp_dc-derived token → take `external_ids.isrc`.
3. Pathfinder GraphQL `canvases` query by Spotify track id → `canvaz.scdn.co/*.mp4` URL.
4. Cache `isrc → mp4` in a **`moka` TTL cache** (short TTL — URLs are expiring CDN
   links; reuse `proxy::ttl_cache` shape, ~6 h). Errors are **never cached**
   (matches `proxy.rs:94-99` "never cache error responses").
5. Miss / rate-limit / parse failure → `Ok(None)`, never a hard error.

**Rust HTTP only** — the `sp_dc` cookie and GraphQL payload never enter the WebView.

**Mobile renderer** (`screens/nowplaying.html:54-56`, behind `#np-art`):
`<video loop muted autoplay playsinline>` absolutely positioned under the art.
Album art stays rendered and is restored on any of: toggle off, `fetch_canvas`
miss/error, `video` `error` event, metered network. Painted from the same
`onPaint`/track-change hook that updates `#np-art`, restarted **only on track change**.

**Settings (default OFF):** `tm-canvas` toggle + a `tm-canvas-cellular` toggle
(default off). First gate: do not even call `fetch_canvas` when
`tm-canvas` is off or the network is metered with `tm-canvas-cellular` off.

**CSP:** add `https://canvaz.scdn.co` to `media-src` and `img-src` in
`tauri.android.conf.json:18` (and `tauri.ios.conf.json`). Note the inline-hash
list on that line (P24) must not be disturbed — only the `media-src`/`img-src`
source lists change.

### C. Mobile Settings → Spotify

New `spotify` section in `app/src/mobile/screens/settings.js` mirroring the
desktop panel (`settings.js:744-783`), with **listener-bound** controls (never
inline `onclick` — P24 hash gate):

- Connection status + Sign in / Sign out → `spotify_is_signedin`, `spotify_signin`, `spotify_signout`.
- Import top tracks → `spotify_import_top` (`settings.js:1912-1981` logic ported).
- Import Exportify CSV → `importer.js` parser (already ported per feature-list P1-4).
- **Canvas:** `sp_dc` paste field → `set_canvas_cookie`/`canvas_configured` (the design originally named these `spotify_set_spdc`/`spotify_get_spdc`; the built names are the `canvas::` ones), plus the two toggles.

## 4. Degradation contract (no client id / no sp_dc)

| Condition | Behaviour |
|---|---|
| no client id | every `spotify_*` returns `Err("Spotify integration is not configured in this build …")` — already `client_id()`'s message (`spotify.rs:35-43`). UI shows *Not configured*, not an error toast. |
| no `sp_dc` | `fetch_canvas` → `Err("Canvas not configured")`; renderer keeps art, no toast. |
| Canvas miss / 429 / parse fail | `Ok(None)`; art stays. |
| opener unavailable | sign-in returns the opener's error string; UI shows it inline. |

No unhandled rejections, no silent `catch{}` swallowing real failures — every
failure surfaces a human-readable reason in the Settings row.

## 5. Testing & gates

- **Rust:** unit tests for the GraphQL/JSON parse, the ISRC search fallback, the
  store-seam round-trip, and the "error not cached" rule. `OP_OFFLINE=1 cargo test --lib`.
- **Lint/format:** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`.
- **JS:** `npm test` (174 baseline), `npm run lint`, `node --check` on new/changed mobile files (P19 gate).
- **Build:** `cargo check` for desktop **and** `tauri android build --debug --target x86_64` to prove the `cfg(mobile)` paths compile.
- **Manual (blocked here — say so):** live OAuth needs a client id + Dashboard
  redirect entry; live Canvas needs a real `sp_dc`. Both are §6 operator steps.
  I will report exactly what was and was not executed.

## 6. Operator steps (outside this change)

1. Create a Spotify Dashboard app (type *Native/mobile app*), put its Client ID in
   `app/src-tauri/.spotify-client-id` (gitignored) or `TRANCE_MUSIC_SPOTIFY_CLIENT_ID`.
2. Add redirect URI `http://127.0.0.1:4321/callback`.
3. For Canvas: paste an `sp_dc` cookie (from a logged-in browser session) into Settings → Spotify.

## 7. Risks (cannot be engineered away)

- **Android loopback redirect is unverified on-device.** The design assumes the
  phone browser follows Spotify's 302 to `http://127.0.0.1:4321/callback` and that
  our Rust listener (bound on the device's loopback) receives it — correct per
  RFC 8252, but some mobile browsers/proxies interfere with loopback hops. This is
  the single most likely live-OAuth failure; fallback if it proves unreliable is a
  custom scheme via the same `opener` plugin (needs a Dashboard redirect-URI change).
  Cannot be tested here (no client id) → first thing to verify on a device.
- **Canvas is unofficial / ToS-exposed.** Undocumented endpoint, rate-limit and
  ban risk, expiring URLs. Mitigation: off by default, cached, best-effort `Ok(None)`,
  never blocks playback. Disclosed in Settings copy.
- **Mobile refresh token in app-private SQLite**, not Keystore (§3A tradeoff).
- **5-test-user cap + Premium requirement** (Spotify, eff. 2026-03-09) limits who
  can sign in on an unextended-quota app. External constraint, not code.

## 8. Out of scope

Desktop UI changes; Drive sync (`P2-2`); `open_external` Intent beyond what the
opener gives us for free; Keystore migration; Play-store release/signing.

---

## 9. Implementation status (2026-10-15)

Most of §3A/§3B was already built in the Oct sessions (the R1-R3 stubs are
gone). Verified state before this session's work:

| Piece | State | Evidence |
|---|---|---|
| OAuth PKCE loopback (both surfaces, same code) | built | `spotify.rs:524`, listener `127.0.0.1:4321` |
| Desktop refresh-token store | built | `keyring` seam (`spotify.rs:99-126`) |
| Mobile refresh-token store | built | `store.db` kv seam (`spotify.rs:142-177`) |
| Mobile browser hop | built | `cfg(mobile)` → `tauri-plugin-opener` ACTION_VIEW (`spotify.rs:330-336`), plugin registered `lib.rs:1578` |
| Commands registered | built | `spotify_signin/signout/is_signedin/import_top` `lib.rs:1735-1738` |
| Canvas backend | built | `canvas.rs` (`fetch_canvas`, `set_canvas_cookie`, `canvas_configured`), registered `lib.rs:1739-1741` |
| Desktop Settings → Spotify UI | built | `settings.js:744-783, 1053-1078, 1848-1981` |
| **Mobile Settings UI (§3C)** | **built (2026-10-15)** | `binders.js` Spotify section in `ensureMobilePrefs` (status, Sign in/out, Import top tracks, Canvas toggles, `sp_dc` field) + static gate `tests/mobile-spotify.test.mjs` |
| **Canvas mobile renderer (§3B)** | **built (2026-10-15)** | `mobile/canvas.js` + `#np-canvas` layer in `screens/nowplaying.html`, CSP `canvaz.scdn.co` in `tauri.android.conf.json`, `tm-canvas`/`tm-canvas-cellular` gating |
| Desktop top-tracks + CSV import | built; matching **fixed 2026-10-15** | `spotmatch.js` wired into `importer.js` + `settings.js` (§10); unit + live-catalog probes below |

## 10. Import matching defect + fix (2026-10-15)

**Root cause (verified live, `search.getResults`, 2026-10-15):** JioSaavn's
search has no ISRC index. Both importers queried ISRC-first —
`importer.js:95` and `settings.js:1936`: `t.isrc || "<name> <artist>"`. A live
probe with the valid ISRC `USUM71703861` returned 72 *unrelated* songs
("Mat Aazma Re", "Choolenge Aasma", …), while `believer imagine dragons`
returns the exact track. With `limit: 1` and unconditional top-1 acceptance,
imports silently matched garbage — or missed — for nearly every track.

**Fix contract (implemented by `app/src/spotmatch.js`):**

1. Query is `"<name> <first artist>"`. The ISRC is **never** used as a search
   query; it stays on the track object only (kept for a future tolerant
   matcher, not trusted today).
2. Candidates: `search_songs { limit: 8 }` — one upstream page, scored
   in-process. Reuses `fuzzy.js` (`editSim`/`querySim`) — no new dependency.
3. Score = `0.5*titleSim + 0.3*artistSim + 0.2*durationFactor`, where
   `durationFactor` = 1 within 7 s, 0.5 within 20 s, 0.15 otherwise, 0.7 when
   either duration is unknown. `titleSim` compares raw *and*
   bracket-stripped titles, taking the max.
4. Accept iff `score >= 0.6`, `titleSim >= 0.55`, and the tribute-cover guard
   holds: a title-only agreement (artistSim < 0.3) must ALSO have a
   close-enough length (durationFactor >= 0.5). Calibrated 2026-10-15 against
   live data: padded JioSaavn credits ("lyricist, composer, singers") keep
   `artistSim` near 0 even for the true track, so title+length must carry
   those; a same-title tribute by an unrelated act fails the guard.
5. Per-track invoke failure ⇒ missed (counted), never thrown; the batch keeps
   going.
6. One matcher, two callers: `importer.js` (desktop CSV **and** mobile CSV —
   the mobile shell passes its own invoke) and `settings.js` top-tracks.
7. Tests: `app/tests/spotmatch.test.mjs` (`node --test`), including the ISRC
   regression — the mocked invoke **fails the test if the query equals the
   ISRC** or lacks the title/artist.

## 11. Command-state defect — Spotify + Canvas were unreachable (fixed 2026-10-15)

**Symptom.** The desktop panel painted *"Spotify not configured"* immediately
(never "Not signed in"); the Sign in button failed. A CDP probe of the running
debug build pinned the exact error:

```
state not managed for field `app` on command `spotify_is_signedin`.
You must call `.manage()` before using this command
```

**Root cause.** The builder manages the proxy state as `Arc<AppState>`
(`lib.rs` — `app.manage(state.clone())` with `state: Arc<AppState>`, present
since the initial commit), and every working command in the crate declares
`State<'_, Arc<AppState>>`. But all seven Spotify/Canvas command parameters —
`spotify_signin`, `spotify_signout`, `spotify_is_signedin`,
`spotify_import_top`, `fetch_canvas`, `set_canvas_cookie`,
`canvas_configured` — were typed `State<'_, AppState>` (bare). Tauri resolves
command state **by exact type**, so every one of these failed on first call
before any network, store or keyring access — in the working tree and in the
shipped **v0.5.1 tag** alike (verified: `git show v0.5.1:…/spotify.rs` and
`canvas.rs` both carry the bare form). The v0.5.1 desktop panel could only
ever paint its error branch; the top-tracks import could not start. (The OS
keyring on this machine does hold a working refresh token — written by a
development-side sign-in outside committed history; it refreshes fine and the
fixed build reads it.)

**Fix.** All seven parameters now take
`State<'_, std::sync::Arc<crate::proxy::AppState>>` (`spotify.rs`,
`canvas.rs`). Bodies unchanged — `app.store()` dereferences identically.

**Gate.** `tests/mobile-spotify.test.mjs` walks `src-tauri/src/**/*.rs` and
fails on any bare `State<'_, AppState>` / `State<'_, crate::proxy::AppState>`
occurrence, so the form cannot reappear anywhere in the crate.

**Environment note.** Verifying a new desktop build requires no other app
instance running — `tauri-plugin-single-instance` makes a second launch forward
and exit, so the running release app had to be closed first.

## 12. Verification record — 2026-10-16 (live, both surfaces)

**Environment.** Desktop: debug build with CDP `:9222` (`trance-music.exe`
linked 00:09:24, account **signed in** — the keyring refresh token survives);
Android: emulator `Pixel6_API36`, debug APK 32,735,713 B built 00:14:36, CDP
`:9223` (adb forward). Drivers live in `%TEMP%\opencode\` (`verify-import.mjs`,
`verify-tops-import.mjs`, `verify-mobile-spotify.mjs`, `verify-mobile-csv.mjs`,
`canvas-fake.mjs`, `probe-commands.mjs`).

**Desktop (real UI paths):**

| Check | Result |
|---|---|
| `spotify_is_signedin` / `canvas_configured` / `cache_stats` over CDP | `true` / `false` / OK — state resolution fixed (§11) |
| CSV import — 5-row Exportify fixture (3 matchable + 2 impossible), via the real `<input type=file>` | **IMPORT_OK 3/3**: Believer → Imagine Dragons, Tum Hi Ho → Mithoon/Arijit Singh, Kesariya → Pritam/Arijit; the Polyphonic tribute and a fabricated row honestly missed; zero garbage |
| Top-tracks import (`#set-spotify-top` → `spotify_import_top`, `medium_term`, 20) | Runs end-to-end: token refreshed, real API call made, **Spotify answers 403** — body: *"Check settings on https://developer.spotify.com/dashboard, the user may not be registered."* Development-mode allowlist issue: the signed-in account must be added under the app's **Users Management** on the dashboard. This is the only thing between the user and a fully green top-tracks import; it is not an app defect |

**Android (emulator, 11/11 PASS):** Spotify section renders in Settings;
status resolves to *"Not signed in"* — the state fix, live on mobile
(`spotify_is_signedin` reads `store.db`, empty here); sign-in button offered;
`sp_dc` save → *"configured"* → clear → *"not configured"*
(`set_canvas_cookie` + `canvas_configured` round-trip); canvas + cellular
toggles write `tm-canvas` / `tm-canvas-cellular`; `fetch_canvas` with no
cookie → designed rejection (*"Canvas not configured — paste your Spotify
session cookie in Settings"*); with a **fake** cookie → real upstream attempt
→ clean *"Spotify rejected the Canvas session cookie (400 Bad Request)"* in
1.0 s (first-ever call on a cold emulator once exceeded 120 s — cold DNS/TLS;
the module is fire-and-forget so the art simply stays). Sign-in hop: logcat
captured the full ACTION_VIEW —
`https://accounts.spotify.com/authorize?client_id=2408d6a5…&redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcallback&scope=user-top-read user-library-read playlist-read-private&state=…&code_challenge=…&code_challenge_method=S256` —
Chrome accepted the intent.

**Mobile CSV import (real fixture pushed to `/data/local/tmp/verify-import.csv`,
fed through the hidden `#m-csv-file` via CDP):** **MOBILE_CSV_IMPORT_OK** — the
same 3/3 correct matches as desktop, no garbage.

**Gates (final bytes):** `npm test` **435/435**; `OP_OFFLINE=1 cargo test
--lib` **213/213**; `cargo fmt --check` clean; `cargo clippy --all-targets
-- -D warnings` clean; eslint clean on touched files; desktop debug build and
the Android debug APK both `EXIT=0`.

**Still needs a human:** the dashboard allowlist (above) — after that the
top-tracks import completes on both surfaces with a real account; Canvas live
playback needs a real `sp_dc` cookie pasted in Settings; a full sign-in round
trip (consent) can then be re-run end-to-end.
