# Spotify on Android + Spotify Canvas — Design Spec

| | |
|---|---|
| Date | 2026-10-07 |
| Status | **approved design**, awaiting spec review → implementation plan |
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
- **Canvas:** `sp_dc` paste field → `spotify_set_spdc`/`spotify_get_spdc`, plus the two toggles.

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
