# Spotify on Android + Spotify Canvas — Design Spec

| | |
|---|---|
| Date | 2026-10-07 (implementation log 2026-10-15, §9/§10) |
| Status | **approved design** — §3A/§3B backend built; §3C UI + §3B renderer shipped... then **PARKED** (§18, 2026-10-24): the renderer and its Settings UI are unwired on Android |
| Scope | (A) Spotify sign-in on Android, (B) Canvas on the mobile Now Playing screen (§18: parked), (C) mobile Settings UI |
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
| **Canvas mobile renderer (§3B)** | **built (2026-10-15; full-bleed §15 2026-10-19)** | `mobile/canvas.js` owns a body-level `#np-canvas-layer` (the fragment keeps only the art fallback), CSP `canvaz.scdn.co` in `tauri.android.conf.json`, `tm-canvas`/`tm-canvas-cellular` gating |
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

---

## 13. OAuth-route probe — can the app's own sign-in serve Canvas? (2026-10-17)

**Question.** §12 left the Canvas gate uncharacterised: is the `sp_dc` cookie
strictly required, or would *any* logged-in session do? Two live probes on
2026-10-17 (throwaway Node drivers in `%TEMP%\opencode\`; no repo files
touched) settled the negative half:

1. **Anonymous tokens get nothing.** A web-player token minted with *no
   cookie at all* (TOTP handshake from the public
   [spot-secrets](https://github.com/xyloflake/spot-secrets-go) dictionary,
   `open.spotify.com/api/token?reason=transport|init`, both answered
   `isAnonymous: true`) runs the Pathfinder v2 `canvas` query fine and always
   answers `{"data":{"trackUnion":{"canvas":null}}}` — including for Doja Cat
   — Woman (`6Uj1ctrBOjOas8xZXGqKk4`), whose Canvas is provably live (the
   public `spotify-canva.vercel.app` API serves its `canvaz.scdn.co` mp4;
   that service holds its own `sp_dc` server-side — "no end-user auth" ≠ "no
   credential"). So "no account, no cookie" is settled: Spotify withholds
   Canvas from anonymous sessions by data policy, not by query shape.
2. **The one cookie-free candidate left** is the **OAuth user token the app
   already holds** (`spotify_signin`) — a real logged-in session, a different
   trust class from the anonymous token. This probe tests exactly that.

**Probe design.** Temporary Tauri command `canvas_probe_oauth(trackId)`
(`canvas.rs`, clearly marked, **removed after the verdict**):

1. OAuth access token through the exact production path
   (`spotify::authed_for_probe` → `authed`).
2. `GET /v1/me` — proves it is a live *user* token before anything is read
   into the Canvas answer.
3. `POST clienttoken.spotify.com/v1/clienttoken` — the anonymous web
   `client-token` (needs no auth; verified live).
4. `POST api-partner.spotify.com/pathfinder/v2/query` — the `canvas` persisted
   query (`trackUri`, hash
   `575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f`),
   `client-token` attached — the exact contract the anonymous probes ran.

Returns raw statuses + bodies. **Acceptance:** a non-null
`data.trackUnion.canvas` for Woman on a signed-in build.

**Interpretation matrix.**

| Observation | Verdict |
|---|---|
| canvas non-null | OAuth route works — the rework drops the cookie; Canvas rides the existing Spotify sign-in |
| `canvas:null` with `/me` 200 | the gate is web-session-specific — the `sp_dc` paste stays mandatory |
| `/me` non-200 | token/allowlist problem (§12 dev-mode 403); Canvas question stays open until sign-in works |

**Result (2026-10-17): dead end — third row of the matrix, with a structural
reason.** Emulator probes on the signed-in build (two runs, the second after a
cold restart) returned `oauthTokenChars: 280` (a live user token), `meStatus:
403` — `"Check settings on https://developer.spotify.com/dashboard, the user
may not be registered."` — and `pathfinderStatus: 403`. The Node variant
matrix on the same token went further: refresh 200; `GET /v1/me` 403 (the
Dev-mode allowlist message); `clienttoken.spotify.com` **200 for the web
player's own client id** but **400 for the app's own client id** — the endpoint
refuses to mint a client-token for third-party clients outright; Pathfinder
answered **403 `"Client/request not allowed"` for bearer+web-client-token and
for bearer alone**. So this is not a pairing problem or an allowlist problem
alone: the app's OAuth session is rejected at the *client* level, and the
client-token the query would need cannot even be minted for our client id.
Canvas stays cookie-gated for good — the working credential class is a
logged-in **web session** (`sp_dc`), which is what every third-party
implementation uses (§14).

## 14. Reference study — SimpMusic's Canvas stack and the cookie-free route (2026-10-17)

*Reference: `maxrave-dev/SimpMusic` — read-only clone kept in `%TEMP%`,
nothing copied into this repo. Production logic: two independent Canvas
sources behind their own switches, tried in order:*

| # | Source | Credential | Reference code |
|---|---|---|---|
| 1 | **Apple Music animated artwork** (tried first) | **none** — scrapes the public web-player JWT out of `music.apple.com`'s own JS bundle | `core/service/lyricsService/.../am/AMTokenManager.kt`, `SimpMusicLyrics.searchAMAlbum` / `searchAMSongsWithAlbums` |
| 2 | Spotify Canvas | `sp_dc` cookie (paste, same as every other tool) | `core/service/spotify/.../SpotifyClient.kt`, `auth/SpotifyAuth.kt` |

### 14.1 Their Spotify contract (our R2 target — cookie route)

- Token mint from `sp_dc`: primary is the **TOTP handshake** (`GET
  open.spotify.com/api/token?reason=transport&productType=mobile-web-player&
  totp=…&totpServer=…&totpVer=…`, secret bytes from the rotating
  `xyloflake/spot-secrets-go` dictionary, transform `b ^ ((i % 33) + 9)`);
  `get_access_token?reason=transport&productType=web_player` exists as the
  standard variant. An expired cookie answers **HTTP 200 with
  `isAnonymous: true`** — expiry is a *value*, never a status code.
- Track-ID resolution via Pathfinder **`searchTracks`** (title + artist), then
  `POST spclient.wg.spotify.com/canvaz-cache/v0/canvases` — **not** the
  Pathfinder `canvas` op — protobuf `CanvasBody{tracks:[{track_uri}]}`, iOS
  client UA, personal token + `client-token` headers; response
  `canvases[]{canvas_url}`.
- Verdict for us: implement R2 on this contract once the cookie question is
  settled — §13 showed OAuth cannot serve Canvas, and this is the credential
  class that works.

### 14.2 The cookie-free route — live-verified from this machine

Chain, every step re-probed 2026-10-17 from this workstation:

1. `GET https://music.apple.com` → the JS bundle path (`/assets/index~<hash>.js`)
   → the bundle yields three JWT candidates; the one whose payload
   `iss == "AMPWebPlay"` is the web-player bearer (the scraped token had ~66
   days left and needed no login).
2. `GET amp-api-edge.music.apple.com/v1/catalog/us/search` with `types=albums`
   (fallback: `types=songs&include[songs]=albums`), `extend=editorialVideo`,
   `format[resources]=map`, `platform=web`, bearer →
   `attributes.editorialVideo.{motionDetailSquare|motionSquareVideo1x1|
   motionDetailTall|motionTallVideo3x4}` → HLS master `.m3u8`.
3. Variant playlists are **single-file byte-range fMP4**: `EXT-X-MAP` URI +
   `EXT-X-BYTERANGE` windows into one `…-.mp4`. Structural check of a real
   file (`After Hours`, 486x486): `ftyp(28) moov(869) moof(460) mdat(…)`,
   ranges covering the whole file — **the complete file is a standalone
   progressive fragmented MP4 that any Chromium `<video>` plays directly.**
   No hls.js, no MSE. 486x486 ≈ 1.9 MB; 360x360 ≈ 0.65 MB; ~20 s loop.

**Coverage measured** (US and IN storefronts identical): Western/global
albums high — Coldplay 5/5, Ed Sheeran's ‹÷›, The Weeknd's After Hours all
carry it; Indian film catalog low — a few new singles have it (`Tum Kya
Mile`, `What Jhumka`), most do not (`Kesariya`, `Chaleya`, `Apna Bana Le`,
`Jawan`, `Animal`, `Aashiqui 2`: none). Honest read: this route is a
no-account *bonus*, not a full replacement for Spotify Canvas on an
Indian catalog — which is exactly why SimpMusic keeps both sources.

### 14.3 As-built — R1, the cookie-free route (this pass)

`fetch_canvas` (name and signature kept; `album` added as an optional hint)
now serves the Apple route:

1. token scrape (memoised; cleared and re-scraped once on a 401) → album
   search (name match with artist agreement and artwork required) → fallback
   songs search resolved to the **parent album** the matched track belongs
   to → square-first rendition pick → smallest AVC rendition ≥ 460 px →
   `EXT-X-MAP` file → download (~1–2 MB) → disk cache;
2. the renderer receives `http://127.0.0.1:<port>/canvas?id=<id>&token=<t>`;
   the relay's new `/canvas` route serves the file with `Range` support
   straight off the disk cache (`<cache>/canvas/<id>.mp4`, inside the
   budget-managed cache tree), so the WebView CSP needs **nothing new**
   (loopback media was already allowed) and `canvas.js` keeps its contract;
3. lookups are cached per `title|artist|album` for 6 h — misses included
   (`Ok(None)`), but never errors: a transient failure retries on the next
   paint;
4. the stale Spotify internals (Pathfinder v1 query, ISRC hop, cookie token
   exchange) are **deleted** — §13 proved that contract dead; R2 will bring
   the §14.1 contract back under the cookie;
5. the temporary `canvas_probe_oauth` command and its `spotify.rs` hook are
   removed.

Defaults unchanged: off until the `tm-canvas` toggle, Wi-Fi gate as before.
No new dependency (`reqwest`, `serde`, `base64`, `url` were all present).

### 14.4 Verification record — live on the Android emulator (2026-10-17)

Debug APK (32,961,309 B, `BUILD_EXIT=0`) installed on `Pixel6_API36`; driver
`app/tests/live-canvas.mjs` (kept in-repo; copy run from
`%TEMP%\opencode\canvas-live-probe.mjs`) over CDP — `adb forward tcp:9223
localabstract:webview_devtools_remote_<pid>`. **6/6:**

| # | Check | Result |
| --- | --- | --- |
| M0 | Shell boots; `window.__TAURI__` present (the canvas element mounts with the Now Playing screen, so it is absent at boot by design) | pass |
| M1 | `fetch_canvas("After Hours", "The Weeknd", "After Hours")` → relay URL `http://127.0.0.1:<port>/canvas?id=a8f35d6e0ba75010&token=…` | pass — cold resolve 7.9–9.1 s on first runs, 44 ms RAM-hit after |
| M2 | Relay round trip: GET → 200, `content-type: video/mp4`, `content-length: 1917354`; single-range request → **206**; a fresh muted `<video>` plays it: `currentTime` 10.09 → 11.69, 486×486 frames decoded, duration 30.0 s | pass |
| M3 | Nonexistent track → `{ url: null }` (honest miss) | pass |
| M3b | "Kesariya / Arijit Singh" → null (expected — Indian film coverage is low per §14.2; informational, not asserted) | miss as measured |
| M4 | **E2E through the real UI**: canvas toggle on → search "after hours the weeknd" → **trusted touch tap** (`Input.dispatchTouchEvent`) on the top song card → `#/nowplaying` → the renderer's own `#np-canvas` played the relay URL (486×486, 0.00 → 10.18, title "After Hours"). Screenshot: `%TEMP%\opencode\canvas-e2e.png` | pass |

Cross-origin facts learned by the probe (why it asserts these shapes):

- `accept-ranges` is set by the relay (`proxy.rs`, `serve_media_file`) but is
  **not CORS-safelisted**, so a page `fetch` reads `null`; ranges are proven
  by the **206 status** of a single-range request (`Range: bytes=0-99` is a
  safelisted request-header form). `content-type` / `content-length` are
  readable (safelisted response headers).
- `Page.reload` tears down the page-target websocket on this WebView —
  probes must reconnect, and every CDP send needs a watchdog (an unanswered
  send with no watchdog ends the process as an unsettled top-level await
  with no summary).
- The source-first search merge re-renders the list ~1–2 s after first paint
  (§8.11a lesson applies here too): tap only after the list has settled
  (three consecutive identical snapshots) and verify `#/nowplaying` landed,
  retrying the tap otherwise.

Also in this pass: `transcode::content_type` maps `mp4` / `m4v` →
`video/mp4` (canvas files were served as `audio/mp4`; a `<video>` element
should not have to sniff the container), pinned by the transcode test.

Related gate run: `cargo test --lib` **230 passed / 1 failed** — the failure
is `proxy::tests::capability_grants_only_core_default`, the parallel
deep-link session's un-updated capability allow-list (not this change);
canvas 14/14. `npm test` **498/498**, eslint clean, clippy green.

## 15. Full-bleed presentation — the Spotify-Canvas look (2026-10-19)

User call (with a Spotify Canvas reel reference): *"i want canvas like this
not just that blinking"*. The 2026-10-17 renderer painted the video inside
the ~380 px square art card (`#np-art-card`), which reads as a small tile,
not a Canvas. The canvas is the screen, not decoration inside a card.

### 15.1 Source — tall first

- `master_of` prefers the tall cuts (`motionDetailTall` →
  `motionTallVideo3x4`); square cuts are the fallback when a release ships no
  tall cut. Live check (After Hours, 2026-10-19): the tall master carries
  AVC variants 310×414 … 1078×1438 (3:4); the picked 830×1106 file is
  **7,088,599 B**, a single `ftyp iso5` fMP4.
- Rendition floor 460 → **780 px** (`AM_MIN_WIDTH`): the video now fills a
  1080×2400 screen; 486-wide looked soft. Tall pick = 830×1106 (~2.8 Mbps);
  the 12 MB cap still holds (observed 7.1 MB).

### 15.2 Presentation — a body-level full-bleed layer

- `canvas.js` owns a `#np-canvas-layer` (fixed, inset 0, `object-fit: cover`,
  z-index 0) appended to `<body>` — not inside the screen fragment — so the
  router's 0.26 s screen-transition transform can never trap the fixed layer,
  and navigation cannot orphan a still-playing video.
- The layer paints a top/bottom scrim over the video (header + controls stay
  legible) and stays hidden until the video actually has frames (the
  `playing` event), so the art card is never replaced by a black loading
  screen.
- While live, the app enters a **cinematic dark presentation**: `html.dark`
  is forced (the saved state is restored on exit) and `html.np-canvas-live`
  makes the page / `main` / art card transparent — the art card becomes a
  window onto the video; the header and queue sheet become dark glass.
- **Why `<html>` and not `<body>`:** every screen module (`screens/*.js`
  line 5) rewrites `document.body.className` on mount. A body-scoped mode
  class is therefore wiped by the destination screen *before* `smount` runs
  `stopCanvas`, which made `exitMode`'s class guard skip the theme restore
  (M5 caught `html.dark` stuck on Home, 2026-10-20). The presentation classes
  now live on `<html>` (the screens never touch it) and the lifecycle is an
  internal `modeOn` flag, so the restore runs even if the DOM is rewritten.
- **Cascade note (caught in a 412×915 Chrome harness before the device run):**
  the dark theme inverts the surface utilities with `!important` rules that
  outrank a plain element selector — `html.dark .bg-surface` (0,2,1) kept the
  fragment `main` opaque, and `html.dark .bg-surface/90` (0,2,1) kept the
  header at 0.94 alpha. The overrides therefore carry an id/class pair:
  `html.np-canvas-live main.bg-surface` (0,2,2) and
  `html.np-canvas-live #screen header` (1,1,2). Harness result with the real
  `tailwind.css`: `main`/card `rgba(0,0,0,0)`, header `rgba(9,9,11,0.42)`,
  sheet `rgba(16,16,19,0.55)`, layer 412×915 `fixed`, video edge-to-edge
  (pixel probe: x=1 and x=410 carry video pixels).
- No second decoder: the same `#np-canvas` element the renderer already
  drove is the background.
- Leaving Now Playing (`smount` for any other screen), the settings toggle,
  the cellular gate, a fetch error or a video error all exit the mode and
  restore the user's theme; tracks without a canvas keep the album art
  exactly as before.

### 15.3 Acceptance

- `live-canvas.mjs` M4 (existing) still passes; new **M5**: after
  `#/home`, `np-canvas-live` is absent, the video is paused/cleared, and
  `html.dark` matches its pre-canvas state.
- A device screenshot shows the video edge-to-edge (full viewport width,
  visible behind the header/title/controls), not a tile.
- Canvas OFF → no layer, no theme change.

## 16. Ambient canvas on every screen + an artwork fallback for every song (2026-10-20)

User call after the full-bleed pass: *"still not every song is not showing
canvas. make canvas show for every screen"*. Two gaps were real:

1. **Coverage.** The cookie-free route resolves Apple Music animated artwork;
   it does not exist for most of the Indian film catalog. Those tracks fell
   back to a static art card with no backdrop at all.
2. **Scope.** The layer was torn down on every `smount` for a screen other
   than Now Playing, so the moment the user browsed Home or Search the canvas
   disappeared.

### 16.1 Every song — the album art is the canvas of last resort

- `#np-canvas-layer` now carries `#np-canvas-backdrop`, a full-bleed `<img>`
  painted from the track's own cover (`hqArt(track.image)`; the brand mark
  when the track has no artwork) the moment the track is painted.
- It is not a static tile: a 28 s alternating Ken Burns drift (scale
  1.12 → 1.22, ±1.4 % pan) plus a 3 px blur/saturation lift makes the cover a
  living backdrop. The blur hides the upscale from 500 px on a 1080 px
  screen.
- The Apple video remains the first choice. When it resolves and reaches
  `playing`, `data-mode="video"` fades the backdrop out and the video in;
  the video is paused (last frame stays) when the audio is paused. Every
  miss — no Apple cut, fetch error, video error, metered network without the
  cellular toggle — keeps the backdrop and the cinematic mode. Nothing ever
  exits to a blank page.
- The cellular gate now suppresses **only the video fetch**; the artwork
  backdrop is already on disk/in the relay cache and still shows.

**2026-10-20 follow-up — the fallback itself must move.** The first pass
animated only the full-bleed backdrop; on Now Playing the sharp art card
covered the moving layer, so a track without an Apple cut still read as a
still image (`Hurt You` was the report: *"only after hour … playing properly
but not other songs"*). The fallback now arms `html.np-canvas-motion` from
`showBackdrop()`, and the shell animates the card itself:

- `#np-art` pans/zooms (22 s alternate, scale 1.03 → 1.16, ±1.4 % / ±1.8 %
  translate; `transform-origin: 50% 45%`) inside the card's overflow clip;
- a narrow light band (`#np-art-card::before`) crosses the artwork every 8 s
  — the visible cue even on a dark cover;
- the full-bleed copy gets a little clearer and faster (blur 3 → 2 px,
  28 → 20 s) so the whole screen also moves;
- `showVideo()` removes the class (no two motions stacked), `hideVideo()` /
  `showBackdrop()` restore it, and `exitMode()` removes it unconditionally
  (a stopped canvas must not leave the card animating);
- `prefers-reduced-motion: reduce` disables all three animations.

This is a renderer-level motion treatment of the real cover, not a claim
that Apple has coverage. The coverage facts are recorded in §16.5.

### 16.2 Every screen — a persistent ambient layer

- `canvas.js` registers a global `player.onPaint` hook (the Now Playing
  painter keeps its direct call; the key guard makes the second call a
  string compare). Any track change on any screen paints the backdrop and
  fetches the video.
- The layer is a sibling of `#screen` and survives navigation. `smount` no
  longer stops it; it only updates the presentation:
  - on Now Playing `<html>` gets `np-canvas-focus` and the scrim keeps its
    clear middle (the video is the hero);
  - on every other screen `np-canvas-focus` is absent and
    `#np-canvas-layer.dim` strengthens the scrim (≈0.5 flat) so page text
    and cards stay readable over arbitrary footage. Headers stay dark glass;
    cards keep their own opaque surfaces.
- The cinematic scope (`html.dark` + transparent page/main/`#screen`) is
  app-wide while a backdrop is loaded, so every screen shares one look. The
  user's theme is restored when the canvas stops (toggle off, no track).
- `smount`/`hashchange`/`visibilitychange`: route changes only re-sync focus;
  hiding the app pauses the video and showing it resumes (the backdrop
  animation is paused while the video is up).

### 16.3 Lifecycle truth

| Event | Result |
|---|---|
| track painted with a canvas | backdrop immediately, video when `playing`, `np-canvas-art` opens the art card |
| track painted without a canvas | backdrop only; art card stays sharp/opaque and **moves** (cover drift + light sweep) |
| navigate to Home/Search/etc. | layer + theme stay; `np-canvas-focus` off; `.dim` on |
| navigate back to Now Playing | focus on; `.dim` off |
| pause / play | video pauses on the last frame / resumes (backdrop covers the gap) |
| cellular without the allowance | backdrop only, no fetch |
| canvas toggle off / no track | layer hidden, backdrop cleared, theme restored |

### 16.4 Acceptance

- Static contract (`app/tests/mobile-spotify.test.mjs`): `#np-canvas-backdrop`,
  the global `onPaint` hook, `np-canvas-focus`, `.dim` CSS, no `stopCanvas`
  in the `smount` handler, and the fallback motion contract
  (`np-canvas-motion` armed by `showBackdrop`, removed by `showVideo`;
  `np-cover-drift` / `np-cover-sheen` in the shell; reduced-motion guard).
- Live (`live-canvas.mjs`): M4 (video full-bleed on Now Playing) unchanged;
  **M5** now asserts the ambient layer persists on `#/home` (focus off, dim
  on, video still playing, theme still cinematic); **M6** returns to Now
  Playing and regains focus; **M7** plays a track with no Apple cut
  (Tum Hi Ho) and asserts the artwork backdrop is rendered, the motion class
  is on, and the art card's computed transform **changes over 1.5 s** (not
  just a declared animation); **M8** toggles the canvas off and asserts the
  layer and motion class are gone and the user's theme is back.
- Visual proof: Now Playing (video and fallback) + Home ambient screenshots.

### 16.5 Live record — coverage, fallback motion, and the 10/10 run (2026-10-20)

**Why the report said only one song worked.** A live `fetch_canvas` sweep on
the emulator (`Pixel6_API36`, build 4) measured the cookie-free route:

| Track | Result | Cold time |
|---|---|---|
| After Hours / The Weeknd | **HIT** (`canvas?id=240dcadecd79d508`) | 12 ms (cached) |
| Blinding Lights / The Weeknd | **HIT** | 1,952 ms |
| Hurt You / Gesaffelstein & The Weeknd | miss | 1,981 ms |
| Hurt You / Gesaffelstein, The Weeknd | miss | 1,127 ms |
| Starboy / The Weeknd | miss | 801 ms |
| Double Fantasy / The Weeknd | miss | 768 ms |
| Tum Hi Ho / Arijit Singh | miss | 745 ms |
| Kesariya / Arijit Singh | miss | 35 ms (cached) |
| Gaali Vaaluga / Anirudh Ravichander | miss | 1,119 ms |
| Vaathi Coming / Anirudh Ravichander | miss | 950 ms |

The real `Hurt You` row from search (`The Weeknd, Gesaffelstein` / `My Dear
Melancholy,`) was played through the app and stayed in `data-mode="art"` —
so the screenshot the user sent was the **fallback**, not a failed video.
Apple's motion artwork is editorial; it cannot be promised catalog-wide. The
universal answer is the animated fallback, not a bigger lookup.

**The fallback is now a running canvas.** Build 4's real tracks:

| Track | Mode | Card animation | Transform over 1.5 s | Card pixel change |
|---|---|---|---|---|
| Hurt You | art (no video) | `np-cover-drift` + `np-cover-sheen` | `matrix(1.03, … -5.25163, -6.75209)` → `matrix(1.03115, … -5.16446, -6.64002)` | **17.52 %** (mean abs 4.712, 956×956 crop) |
| Tum Hi Ho | art (no video) | `np-cover-drift` + `np-cover-sheen` | `matrix(1.08654, … -0.720984, -0.92698)` → `matrix(1.10564, … 0.922439, 1.18599)` | **60.30 %** (mean abs 29.494, 956×956 crop) |

The driver (`%TEMP%\opencode\canvas-motion-verify.mjs`, throwaway) searched
and played through the app's own verbs, asserted the motion class, both
animation names, the absence of a video, and two CDP screenshots 1.4 s apart
cropped to the art-card rect (`canvas-diff.py`, PIL). **16/16 checks, exit
0.** Device captures: `motion-hurt-you-device.png`,
`motion-tum-hi-ho-device.png`; CDP pairs `motion-*-a.png` / `motion-*-b.png`.

**Full live suite: 10/10, exit 0** (`app/tests/live-canvas.mjs`, build 4):

- M0 shell boots; M1 After Hours resolves (19 ms warm); M2 relay 200/206,
  `video/mp4`, 7,088,599 B, real `<video>` 830×1106; M3 honest miss;
  M3b Kesariya miss (informational).
- M4 E2E toggle → search → trusted tap → `#np-canvas` playing (After Hours,
  830×1106).
- M5 Home keeps the ambient canvas (focus off, dim on, dark, video playing);
  M6 returns to focus.
- M7 synthetic Apple miss: backdrop 500 px decoded, `np-canvas-motion` on,
  `np-cover-drift` computed, transform `matrix(1.03…) → matrix(1.03115…)`
  after 1.5 s, still ambient on Home.
- M8 drives the **real Settings toggle-off sequence** (write
  `tm-canvas=0` → `stopCanvas()` → repaint current) and asserts the layer,
  motion class and media src are gone, and the user's theme is back
  (`dark=false`).

**A probe bug, not a product bug (recorded because it looked like one).**
The first M8 run failed 9/10: it restored the original pref (`"1"`) *before*
calling `stopCanvas()`, so the next `player.onPaint` (~4×/s) legitimately
repainted the real track and resurrected the canvas. The Settings switch
writes the pref off **first**; the probe now does the same. If a future
renderer change makes `stopCanvas()` sticky while the pref is still on, that
would be a product regression — but this failure was the probe skipping the
first half of the toggle.

**Artifact.** Build 4 debug APK: **20,382,693 B** (19.4 MiB), 15:43:59,
938 zip entries, `lib/x86_64/libapp_lib.so` 51,577,424 B raw / 13,004,301 B
compressed, uncompressed total 67,269,443 B. The previous 33.4 MB artifact
carried stale packaging; a clean rebuild is ~20 MB. `adb install -r` →
**Success**; pid 5936 on `:9223`.

**Gates.** `npm test` **500/500**, `npm run lint` clean, focused
`mobile-spotify` **8/8** + `mobile-boot` **3/3**, `node --check` clean,
`cargo fmt --check` exit 0. Rust `cargo test --lib` / clippy are recorded in
the session memory entry; only JS/shell files changed in this pass.

## 17. Canvas format contract + the every-song canvas (2026-10-23)

User report after build 4: *"only 'the weekend after hours' song is playing
the canvas not other make canvas play for all."* Two separate things were
being judged together:

1. **Format.** The Apple clip was a 3:4 source played whole (`loop=true`,
   ~30 s), not the Spotify Canvas shape (9:16, 3–8 s, 720×1280 minimum).
2. **Coverage.** The same report as §16.5: Apple's editorial artwork exists
   for a minority of the catalog, and the Indian film catalog is close to
   zero. No lookup can conjure a video Apple does not publish.

This section pins both. The official clip is upgraded to the Canvas contract;
every other track keeps a **generated canvas** so the screen is never a
still image.

### 17.1 Coverage is a source fact, not a bug

Measured 2026-10-23 with the public Apple web token (the same 20 queries as
the app, `types=albums,songs`, `extend=editorialVideo`):

| Library slice | Terms with an Apple cut |
|---|---|
| Western/global hits (After Hours, Blinding Lights, Shape of You, Believer, Levitating, Peaches, Stay, Heat Waves, Flowers, Cruel Summer) | **10 / 12** |
| Indian film (Kesariya, Tum Hi Ho, Gaali Vaaluga, Vaathi Coming, Naatu Naatu, Chaiyya Chaiyya, Tera Hone Laga Hoon, Raabta) | **0 / 8** |

Other sources checked the same day:

- **JioSaavn** song payloads carry no video. `vlink`/`vcode` are a JioTune
  **audio** preview on `jiotunepreview.jio.com` (probed on Naatu Naatu,
  Kesariya, Vaathi Coming, Chaiyya Chaiyya, Tum Hi Ho, Gaali Vaaluga).
- **Spotify's public pages** (`/track/<id>`, `/embed/track/<id>`, oembed)
  contain no `canvaz.scdn.co` URL; §13 already proved the OAuth token cannot
  serve Canvas. Only the `sp_dc` web-session route (§14.1, R2) can return
  real Spotify Canvas files, and it is not configured.
- **Apple music videos** are 16:9 previews; a 9:16 crop of a 720p preview
  cannot reach 720×1280 without upscaling, so they are not a format fix.

So "all songs" has exactly one zero-config answer: a **generated canvas**
for tracks without an official cut. The renderer already had a cover drift
(§16.1); this pass makes it a deliberate 6 s loop with a colour wash, and
makes the official path meet the same clock.

### 17.2 Official clip: 9:16 source floor + 6 s loop

**Rendition picker (`canvas.rs`).** `AmVariant` now carries `height` parsed
from `RESOLUTION=WxH`. Every AVC variant gets its centred 9:16 crop:

```
crop_w = min(w, floor(h * 9 / 16))
crop_h = min(h, floor(w * 16 / 9))
```

The picker chooses the **smallest AVC rendition whose crop is ≥720×1280**
(sorted by bandwidth, so the download stays under the 12 MB cap); when no
variant clears the floor it keeps the largest crop area and the renderer
still presents it. Measured tall ladder (After Hours, 2026-10-23):

| Variant | 9:16 crop | Meets 720×1280? |
|---|---|---|
| 310×414 | 232×414 | no |
| 554×738 | 415×738 | no |
| 830×1106 | 622×1106 | no |
| **1078×1438** | **808×1438** | **yes — 9,742,097 B** |
| 1080×1440 | 810×1440 | yes, but 24.9 MB — over the cap |

The 12 MB cap is unchanged. The 1078×1438 pick is the intended result; a
release whose only large cut is 1080×1440 downloads-fails honestly and the
art fallback stays.

**Loop window (`canvasmath.js` + `canvas.js`).** The source is 20 s (the
packaged fMP4 reports 30 s), so the renderer plays a **6 s window** and
crossfades the last 0.6 s into the next window with two muted `<video>`
elements:

- `LOOP_SECONDS = 6`, `LOOP_FADE = 0.6`, `CANVAS_MIN_W = 720`,
  `CANVAS_MIN_H = 1280`.
- `loopPlan(duration, base)` returns `{ start: base + 0.6, seconds: 6,
  fade: 0.6, base }` when the source has a 0.6 s pre-roll + 6 s window + 0.6 s
  tail (any normal Apple clip). **`base` is the first frame the media element
  can actually present, not 0.** Apple's fMP4 carries an edit-list/media
  timeline offset: after `playing`, After Hours sits at **~10.03 s**, and a
  seek to 0 lands in an empty edit. A fixed 0.6 s anchor therefore reads as
  *already past* the 6 s window on every tick and the two videos crossfade
  forever (the first live run did exactly that: 0.4–0.6 s swaps). The renderer
  caches the first `playing` position on both elements and publishes it as
  `layer.dataset.base`; ordinary files start at ~0 and keep the original
  contract.
- The standby starts at **base** (0.6 s before the window start) and plays
  through the fade, so at the swap it is exactly at `base + 0.6` — no skipped
  frames, no jump. After each swap the outgoing element is paused and reset to
  `base` while invisible, so the next fade never races `play()` against a
  seek.
- Two `#np-canvas` / `#np-canvas-alt` elements, both `muted`, `playsInline`,
  `loop=false`. The front is opacity 1; the standby preloads the same relay
  URL and is opacity 0. A rAF ticker starts the standby at `base + 6.0`
  (`start + seconds - fade`), fades over 0.6 s to `base + 6.6`, then swaps
  roles. If the standby is not ready or errors, a hard cut at the window end
  keeps the loop alive.
- `layer.dataset.crop = "808x1438"` (the source's centred 9:16 box),
  `layer.dataset.loop = "6"` and `layer.dataset.base = "10.03"` are published
  on `loadedmetadata` / first play; the presentation still uses
  `object-fit: cover` because the phone viewport is taller than 9:16.
- Pause/visibility pause both elements; resume plays only the front. Leaving
  video mode (`hideVideo`) clears both sources and cancels the ticker.

### 17.3 Generated canvas: every other song, same 6 s clock

Tracks without an Apple cut already keep the full-bleed cover (§16.1). The
fallback is now a deliberate loop rather than a slow ambient drift:

- backdrop drift **6 s** (was 20 s), card drift **6 s** (was 22 s), light
  sweep **6 s** (was 8 s) — the same clock as the official clip;
- a `#np-canvas-wash` colour/light layer over the cover (soft-light radial
  gradients + slow rotation, 6 s) so the motion is visible even on a dark
  cover; it is hidden in `data-mode="video"`;
- the card still opens onto the real video when one resolves; the wash and
  motion class are removed in video mode so the two motions never stack;
- `prefers-reduced-motion: reduce` still disables all of it.

This is a **cover-derived motion canvas**, not a fabricated claim that Apple
or Spotify has a clip for the track. The docs and the final report say so
plainly.

### 17.4 Acceptance

- Rust: `pick_variant` returns 1078×1438 for the measured tall ladder;
  830×1106 and square 768×768 fail the floor; the square ladder falls back to
  its largest crop; `RESOLUTION` parsing is unit-tested.
- JS: `canvasmath.test.mjs` covers `cropBox` (1078×1438 → 808×1438,
  830×1106 → 622×1106, 768×768 → 432×768), `meetsCanvasFloor`,
  `loopPlan(20)` and `loopPlan(5)`, and the constants.
- Static: `mobile-spotify.test.mjs` asserts two video elements,
  `loop=false`, the canvasmath import, the 6 s loop contract, `data-crop` /
  `data-loop`, and the wash/motion CSS.
- Live (`live-canvas.mjs`): M2 source dimensions pass the 9:16 floor; M4
  After Hours publishes `data-crop`/`data-loop`/`data-base`; **M9** waits past
  the loop point and proves the visible front returns to `base + 0.6` (the
  window start; `base ≈ 10.03` for After Hours) while playing; M7 fallback
  asserts 6 s animation durations and the wash element; M8 unchanged.
- Visual: device screenshot of After Hours (video) and a no-cut track
  (generated canvas).

### 17.5 Live record — 2026-10-23

**Build:** debug APK `app-universal-debug.apk`, **33,395,775 B**, installed on
`Pixel6_API36`; `BUILD_EXIT=0`; app pid **3755**; CDP `:9223`.
`node app/tests/live-canvas.mjs` → **11/11 pass, 0 fail**.

| Check | Measured |
|---|---|
| M1 | `fetch_canvas("After Hours")` cold resolve **7,026 ms** → relay URL `http://127.0.0.1:43409/canvas?id=b1b16a4f76e19457&token=…` |
| M2 | source **1078×1438**, centred 9:16 crop **808×1438** (both floor dimensions pass); `video/mp4`; full body 9,742,097 B; single-range request → **206**; real `<video>` `t 10.05 → 11.65` over 1.6 s, duration 30.0 s |
| M3 | nonexistent track → `null` (honest miss) |
| M3b | Kesariya → miss (Indian film coverage is low by source fact, §17.1) |
| M4 | real toggle/search/trusted tap → **After Hours**; `1078×1438 crop=808x1438 loop=6s base=10.067482s`; `t 10.73 → 12.03`; 7 result rows, tap at (206,433), first attempt, `#/nowplaying` |
| M5 | Home keeps the full-bleed canvas: `dim=true, focus=false, dark=true`, video playing |
| M6 | returning to Now Playing: focus true, `After Hours` |
| M9 | **base=10.07 s**, front `np-canvas-alt t=11.60` → `np-canvas t=11.02`, `data-loop=6s` — the front returned to the window start and kept playing |
| M7 | fallback on a track with no Apple cut: full-bleed cover 500 px decoded, card drift `matrix(1.03189…) → matrix(1.06217…)`, persisted on Home (`mode=art`, `dim=true`) |
| M8 | canvas OFF stops the layer, restores the theme (`dark=false`) |

**Why the first dual-video build flickered, and what fixed it.** The first
6 s loop assumed the media timeline started at 0. A DOM-level sampler (no
rebuild, `%TEMP%\opencode\canvas-dom-loop-probe.mjs`) showed the two elements
swapping every **0.4–0.6 s**: the front sat at ~10.5 s, already past the
0-based 6.6 s window, so every rAF tick started another crossfade. A fresh
`<video>` on the same relay reproduced the cause: `loadedmetadata` reports
`currentTime=0`, a seek to 0 while paused also reports 0, but the first
**playing** frame and every later play start at **10.03–10.05 s** — Apple's
fMP4 has an edit-list/media-timeline offset and the 0–10 s range is an empty
edit. The fix is §17.2's base-aware plan: cache the first presented position
(`data-base = 10.067`), start the standby there, pre-seek the outgoing element
while it is invisible, and only then treat `base + 6.0` as the fade trigger.
The final source also waits for `requestVideoFrameCallback` (600 ms cap) before
the first tick, so a `playing` event that lands before the first sample cannot
re-introduce a 0 anchor.

**Screenshots:** `%TEMP%\opencode\canvas-after-hours.png` (official clip) and
`%TEMP%\opencode\canvas-fallback.png` (cover-derived canvas) — device captures
taken after the run; the live probe's M7 motion assertions are the
machine-checkable evidence for the fallback.

---

## 18. Parked — Canvas unwired from the Android UI (2026-10-24)

User call: *"let's keep the canvas aside — comment out canvas related and make
it not visible in the Android app."* Everything stays in the tree, commented
out / unwired, so reviving is a few deletions of comment markers. The Spotify
**account + import** section is NOT part of this — it stays live.

### 18.1 What was parked (this change)

| Piece | Where | How it is parked |
|---|---|---|
| Renderer module reachability | `app/src/mobile/binders.js:93` | the `import ... from "./canvas.js"` line is commented with a `PARKED` note. binders is canvas.js's **only** importer, so the whole renderer never evaluates |
| Per-track hookup | `app/src/mobile/binders.js` (paintNowplaying) | `paintCanvasForTrack(t)` call commented with a `PARKED` note |
| Renderer self-driver | `app/src/mobile/canvas.js` | the `onPaint(...)` subscription at the bottom commented — even an accidental re-import cannot paint the ambient layer |
| Settings rows | `app/src/mobile/binders.js` ensureMobilePrefs | the three rows commented: "Now Playing Canvas" (`sw("m-canvas")`), "Canvas on mobile data" (`sw("m-canvas-cell")`), "Canvas session cookie" (`m-spdc*`) |
| Settings flip wiring | same file, §3C wiring | `paintSpdc`, the `m-spdc-save` handler and both `flipCanvas(...)` calls commented |
| Switch state init | `paintMobilePrefs` | the `["m-canvas", …]` / `["m-canvas-cell", …]` entries removed from the state array (the code line lives above as a comment) |
| Chain syntax | the Spotify `sec(...)` rows | the import-top row now ends the chain (`),`) so the commented rows do not break the expression |

Intentionally **not** touched (invisible from the UI either way; kept so a
revive is one edit): `app/src/mobile/canvas.js` + `canvasmath.js` bodies, the
cinematic CSS block in `app/src/mobile/index.html` (keyed on the
`np-canvas-*` classes which nothing adds any more), the Rust backend
(`canvas.rs` commands + `/canvas` relay route) and the `canvaz.scdn.co` CSP
origin in `tauri.android.conf.json`.

### 18.2 Why commenting code alone is not the gate

Two traps found while reshaping the static gate `app/tests/mobile-spotify.test.mjs`:

1. **Raw `includes()` matches comments.** `assert.ok(binders.includes('sw("m-canvas")'))`
   stayed green after the wiring was commented out — the comment *is* the
   string. A parked feature needs **line-anchored** assertions
   (`/^import\s/…`, `/^\s*flipCanvas\(/…`) that cannot match a `//` comment.
2. **The graph is the real gate.** `app/tests/mobile-boot.test.mjs` executes the
   real module graph; with the import commented, `canvas.js` is out of the
   graph and toplevel module side effects (the old `onPaint` hook) cannot run.

### 18.3 Revive checklist

1. Un-comment the import + per-track call in `binders.js`, the `onPaint`
   subscription in `canvas.js`, the three Settings rows, `paintSpdc` +
   `m-spdc-save` + `flipCanvas` wiring, and re-add the two `paintMobilePrefs`
   entries (they are stored right where they were removed, as a comment).
2. Flip the §18 assertions back in `mobile-spotify.test.mjs` (the parked-state
   assertions are marked `PARKED`).
3. A device-stored pref survives: a user with `tm-canvas=1` gets the canvas
   back with no extra logic — `canvasEnabled()` reads the pref again.
4. `tests/live-canvas.mjs` becomes runnable again (its header carries a
   parked warning).

### 18.4 Avoided dead-end: rewiring the Spotify import UI

The parked rows shared one `sec("tm-m-spotify", …)` block with "Spotify
account" and "Import top tracks". The first cut commented the whole block,
which would have taken Spotify sign-in/imports down with it. The rows were
instead split at the row boundary so only the Canvas part is inert.

