# Changelog

Notable changes to OPEN MUSIC. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [SemVer](https://semver.org/spec/v2.0.0.html).

Platforms shipped: **Windows** (MSI + NSIS), **Linux** (deb + AppImage), **Android** (APK). macOS and iOS are not released as of v0.5.0.

## [Unreleased]

### Added (Now Playing Canvas — animated artwork without any account — 2026-10-17)
- **"Now Playing Canvas" now lights up with no sign-in and no cookie.** The toggle resolves a short looping video for the current track through **Apple Music's public web player** animated-artwork route: the player's own bearer is scraped from its JS bundle (memoised; re-scraped once on a 401), the album (or the matched song's parent album) must agree on the artist and carry artwork, the square AVC rendition (smallest ≥ 460 px) is downloaded once (~1–2 MB fMP4) into the budget-managed cache, and the loopback relay serves it (`/canvas?id=…`, `video/mp4` with Range) so the WebView CSP and the renderer are untouched. Misses are cached 6 h; transient failures retry on the next paint; a miss simply keeps the album art. Spotify's own Canvas stays cookie-gated (the OAuth route is proven impossible — `docs/spotify-android-canvas.md` §13) and its `sp_dc` field remains as the future hook. Spec + acceptance: `docs/spotify-android-canvas.md` §14.

### Added (audio quality & immersive spatial engine — 2026-10-18)
- **Playback is now fully automated, hands-free** (spec: `docs/audio-quality.md` §6): a shared Studio audio chain (`app/src/dsp.js`, all desktop tracks and mobile) runs transparent-EQ → loudness slot → limiter → **"Immersive room"** (mid/side widening + a synthesized deterministic-IR binaural room, auto-bypassed in Jam rooms since a reverb tail is a delay line the drift measure must not see). Loudness matching (BS.1770 K-weighting approximation) measures LUFS `(±12 dB, limiter-protected, cached per track and tier)` and level-corrects every track automatically, so no more jarring jumps between masters. The system ships with its built-in behavior: **flat EQ, hall room, always-armed normalization — no settings toggles** (the toggle-era rows, per-track EQ sheet and their sync keys are removed; stale keys are wiped at boot).
- **Desktop elements load CORS-clean** (`crossOrigin="anonymous"` before any stream load): the relay is a different origin than the app page, spec-mandated silence without it (the 2026-10-08 mobile P36 failure class), now verified live by metering the chain output. Gains: `stream/vault bytes`, `chunked: no`.
- **Source-fidelity gates** (`app/tests/audio-quality.test.mjs`, 8 tests): desktop `streamQuality()` and mobile `effectiveStreamQuality()` pinned to 320 kbps on every default branch (Data Saver's 64 kbps and a cellular 96 kbps pick stay explicit opt-ins; the Rust ladder takes the best available tier and reports it, shown by the Now Playing badge).
- Verified: `npm test` **498/498** (incl. dsp/loudness unit tests + the automation gates), eslint clean on touched files, `node --check` on all touched files. Live CDP metering of the real chain (audible output, routing, loudness gain): `docs/audio-quality.md` §5 status table.

### Added (mobile Now Playing queue append browser — 2026-10-17e)
- **The queue tab's append search now works like the search screen**: typing shows a few matching songs directly under the input, each with **Play now / Play next / Add to queue** buttons where the search rows show their type label. The row shipped disabled with zero wiring before (a dead affordance). `Enter`/`+ Append` commits the top result to the queue; host edits republish the room queue to guests immediately, and guest additions stay local (§4.7/§12). Spec: `docs/mobile/06-features.md` ("Queue append search browser").

### Changed (Now Playing mobile cleanup — 2026-10-17)
- **Mobile Now Playing drops the `320kbps` tier chip and the time bubble riding the scrubber needle** — the elapsed/remaining readout under the track is the single time source, so the floating bubble (which duplicated it) and the pill under the artist are gone. Spec: `docs/mobile/06-features.md` ("quality chip + seek position bubble removed").

### Added / Changed (source-first search + branding scrub — 2026-10-17)
- **Search results now lead with the matched song's own source**: search a film song and its movie's tracks — fetched from the catalog and folded in after the anchor — come first; for singer-driven rows (English and other non-film catalogs) the anchor's artist's own tracks lead instead. Query-intrinsic grouping, no taste and no history; after the first paint, so the page never waits on it. The film is read from the title's own `(From "Movie")` tag first (compilations hide it in the album field) and that provenance no longer blinds the exact-title bonus — the 374M-play original leads instead of a bare-titled cover. Spec: `docs/recommendations.md` §8.11.
- **No upstream provider or CDN name is shown anywhere in the UI**: About/Terms copy, the Spotify-import note and the Now Playing source line are scrubbed on both shells — desktop `#np-format` and the mobile tier chip show the tier only (`local vault` for on-disk copies); the stream's origin host stays internal. Contract: `docs/branding/trance-music-guide.md`, "Upstream attribution".

### Changed (JioSaavn-first recommendations — 2026-10-16g/h)
- **The endless radio prefers the JioSaavn recommendations**: a station batch queues in the order JioSaavn returned it — the local taste engine no longer re-ranks it (filters only: queued, last-15-heard, just-skipped; the last-resort fallback pools keep upstream order too). Supersedes the radio half of the 2026-10-16e reranking. Spec: `docs/recommendations.md` §8.8.
- **Search keeps JioSaavn's own ranking**: the relevance pass no longer adds personal boosts (played / liked / artist-play counts) — rows come back in JioSaavn's order (stable ties), carrying only the query's own filters and the Settings region. Spec: `docs/recommendations.md` §8.9.

### Added / Changed (official-stream upgrade — 2026-10-16f)
- **A dead top rendition no longer skips the track**: playback now walks a bitrate ladder (320 → 160 → 96 → 48 → 12 kbps, never above the requested tier) and plays the best playable rendition — the first unrestricted tier, else the highest preview-capped one (the PREVIEW tag stays honest), else the old skip-on-dead behaviour. Both the resolve and the relay share the one walk, so the badge and the stream can never disagree. Spec: `docs/architecture.md` §5.5.
- **Quality settings now genuinely drive the bytes**: the relay url carries the resolve's requested tier (`/stream?id=…&q=96kbps`), and the relay serves that rendition — previously the setting only affected the resolve probe/badge while the relay always served its own 320 pick. A missing or malformed `q` keeps the 320 default.
- **Official-origin hardening**: the relay's by-id resolve re-validates the URL it returns against the CDN allow-list (plus the ladder validates every candidate before probing) — a poisoned resolution is refused before any request leaves the process.
- **Visible tier proof on Now Playing**: desktop shows `320kbps` in the metadata tile; mobile shows a tier chip under the artist (`local vault` for on-disk copies). (Origin host removed later — see "source-first search + branding scrub".)
- **Search, artist/album pages and radio prefer the original recording**: cover / tribute / instrumental / karaoke / lofi re-uploads of a song on the same page sink below the original (stable, never filtered — the row stays selectable; `remix`/`live`/`acoustic` are label releases and are not demoted). Spec: `docs/recommendations.md` §8.7.

### Added / Changed (recommendation upgrade — 2026-10-16e)
- **The endless radio now ranks with real taste signals instead of artist counts**: a bounded play-event log (`play_events`, 3000-row cap) records every finished or abandoned play — natural end → `complete`, early abandonment → `skip`, the rest → `partial` — and one shared, pure engine (`app/src/taste.js`) turns it into decayed artist/album/night-hour weights, skip demotion (a skip within 3 hours hard-drops the track from radio batches), item-item co-occurrence and MMR-diversified reranking. Both surfaces' radios rerank their station batches through it (`scoreReco` now delegates), with an ε-slot exploration pick.
- **"Because you played X" shelf** (mobile Home): a co-listening rail over the same log — the most recent play with at least 6 co-occurring neighbours renders as cards using the log's own metadata; the shelf hides itself when the log is too thin.
- **The taste engine is measurable**: `replayHitRate` (session k-NN replay metric) runs in the suite — 0.98 on a synthetic chain vs ≤0.18 shuffled, mirroring the radio's own "heard" window so the metric matches what the radio can serve.
- Spec + as-built record with live evidence: `docs/recommendations.md` §8.

### Fixed (search resilience — 2026-10-16)
- **A transient search failure no longer sticks as "Search is down right now"**: a failed desktop search now re-runs itself on a bounded auto-retry ladder (1.5 s → 4 s → 15 s → 45 s) and instantly when connectivity returns — the card only stays when upstream really is down, and a valid empty answer ("No tracks found") is never auto-retried. Spec: `docs/search-resilience.md`.
- **The primary catalog source got one calm retry** — a transport error, a 5xx or a short 429 earns a single jittered backoff before failing the search (4xx and business answers stay final). The fallback mirror list is honest again: four of five listed hosts were dead (404 / connection-refused); only the verified `saavn.sumit.co` remains.
- **Desktop diagnostics survive without the panel**: the 40-line diag ring (raw errors included) is readable via `__tmDiag()` — it had been silently dropped since the panel's removal.

### Fixed / Added (Spotify)
- **The sign-in button (and every Spotify/Canvas command) failed before doing anything**: all seven command params took `State<'_, AppState>` while the builder manages `Arc<AppState>` — Tauri resolves state by exact type, so each call died with *"state not managed"*. Sign-in had never been reachable on desktop or Android; the panel could only ever paint its error branch. Fixed to the managed `Arc<AppState>` type, and a static gate now rejects the bare form anywhere in the crate.
- **Imports matched the wrong songs**: both importers queried JioSaavn by **ISRC first**, but the catalog has no ISRC index — a valid ISRC returned dozens of unrelated tracks and the old code took the top hit, so imports silently filled with garbage or missed. Now both query `name + first artist`, fetch 8 candidates and score them (`app/src/spotmatch.js`: title/credit/duration blend with a tribute-cover guard); honest misses are counted in the toast. Probed live against the real catalog: the old query returned "Mat Aazma Re" for Believer, the new one returns the exact track.
- **Android: Spotify sign-in, top-tracks import and Canvas** (Settings → Spotify): Sign in/out through the system browser (PKCE loopback — the same client id as desktop), "Import top tracks" builds a local playlist via the same matcher, and the Canvas controls (video on the Now Playing artwork, Wi-Fi-only by default) light up once your browser's `sp_dc` cookie is pasted — the album art is the guaranteed fallback, and Canvas is an unofficial Spotify surface, so any miss just leaves the art untouched.

### Fixed (audit pass — desktop + Rust)
- **A failed vault rewrite no longer loses the entry**: re-downloads forget the old row before writing; a failure (network, Stop, encode, hash) now restores it via a drop guard — only while the old file is still on disk — and promoting a favorite no longer deletes the file it just recorded on a same-stem rewrite.
- **`open_external` can no longer be aimed at shell syntax**: the Windows `cmd /C start` spawn is replaced with `tauri-plugin-opener` (single-argument ShellExecuteW / xdg-open), so `&`, `^` and `%VAR%` in a URL stay data.
- **Redirect hops are re-validated**: `/art` re-runs the SSRF guard on the URL actually fetched, and `/stream` does the same for redirect hops (direct fetches untouched) — a public host cannot bounce the relay into the LAN.
- **Art downloads are bounded while streaming** (was: buffer the whole body, then check the cap) — a hostile mirror can no longer balloon memory with a chunked response.
- **Jam room hardening**: closed rooms refuse later joins verbatim, a poisoned lock no longer bricks the room, WebSocket frames cap at 64 KiB, guest `report` frames get a 500 ms budget, and a dead serve loop reverts the host mode before saying so. Deferred items are listed in `docs/listen-together.md` §14.
- **Retry jitter is real**: the mirror backoff arithmetic was deterministic (every retry woke on the same tick); it now spreads ±25 % via `getrandom`.
- **Lyrics duration tolerance is a single named source** (`DURATION_TOLERANCE_SECS` = 3 s); the module doc no longer claims ~2 s.

### Fixed (audit pass — mobile)
- **Vault quota notice, crossfade handoff, New-releases cache**: the over-quota eviction toast never appeared (the kind landed in the `ms` argument slot); a crossfade/gapless handoff promoted the standby `<audio>` without the shell's event list (frozen transport glyphs, resume position no longer saved); an empty shelf response was cached as a hit for 24 h.
- **Android edits, version badge, analytics pills, router fetch**: "Edit description/cover" used `window.prompt`, which is dead in the Android WebView — now the bottom-sheet input; the Settings footer printed a hardcoded `0.4.0`; the Analytics Week/Month/Year pills threw `ReferenceError` (the generated screen keeps `setPeriod` inside an IIFE — a `window.setPeriod` shim now publishes it); a failed screen fetch was silent (stale screen stayed, no toast).
- **Probe single-flight, download channel leak, share-code failure**: online/offline events could start duplicate network-probe chains and strand a timer; cancelled or failed downloads leaked their progress channel; "Copy share code" could fail with no feedback. Table: `docs/mobile/09-problems-solutions.md` P44–P53.

### Removed (audit pass — dead code)
- **Four abandoned files** (~1.8k lines): `app/src/survey.js` (a survey flow no code imports) and the long-disabled `catalog.rs` / `jiosaavn_catalog.rs` / `audius.rs` trio (their `mod` lines had been commented out). All recoverable from git history.
- **Dead exports and branches**: mobile `isFav` / `isActiveDownload` / `storageBreakdown`, desktop `prefLang` / `lyricsSizePx`, and the mobile widget click handler's branches for buttons that no longer exist (`data-w-prev` / `-repeat` / `-shuffle`).

### Fixed (mobile Now Playing)
- **Gemini API key works again**: the AI-lyrics default model `gemini-2.0-flash` was shut down by Google on 2026-06-01, so every call 404'd regardless of key — default is now the stable `gemini-2.5-flash`, and a retired model id reports "update the app" instead of a raw HTTP error.
- **Lyrics Full View opens again**: the toggle searched `closest("div.rounded-2xl, div.rounded-xl")` but the sheet card has been `rounded-3xl` since the mockup redesign, so the button silently did nothing. Switching tabs exits the fullscreen stage (the Close button lives in the lyrics view).
- **Word-by-word karaoke in full view**: the active line gets a thicker bar + pad at 28px over the existing per-word `--progress` wipe (both themes); plain/AI lyrics stay static lines (no timestamps to sync to).
- **NOW PLAYING eyebrow removed** from the Now Playing screen.
- **Home category chips** (mobile): the flat seven-chip strip keeps its original design, and the selected pill finally renders as selected — the old toggle keyed a class the theme CSS no longer styled (`bg-on-surface`), so the active chip rendered white-on-white in light mode; it now keys on `bg-primary`, the class the theme inverts (obsidian pill in light, white pill in dark).
- **Mined collection browsers** (mobile): the home Artists/Albums/Playlists/Charts chips open full browsers — artists by listening weight with Liked/Downloaded/Following tabs, albums with separate Most-time vs Most-played orders, playlists split Yours/Featured/Downloaded, charts in untouched editorial rank. Home Top Artists rail shows your artists + See-all.
- **`feat.` artists no longer fragment** into ". Guest" entries in the taste weights.

## [0.5.1] — 2026-10-11

### Changed
- **Visible name is now OpenMusic** (was `OPEN MUSIC` on desktop; Android already showed `OpenMusic`): installer names, window titles, header wordmark, About/Legal copy, share badges, OAuth pages, tray tooltip, Linux desktop entry, updater release notes. Identifiers, binary name, vault/keyring data, backup format, and signing keys are untouched, so updates and saved data carry over.
- **Marketing site updated**: root `index.html` (the GitHub Pages source) carries the OpenMusic brand, Windows/Linux/Android-only platform claims, and a v0.5.1 offline fallback; the unshipped macOS tab is removed and a `.nojekyll` bypasses the previously failing Jekyll build.

## [0.5.0] — 2026-10-11

### Added
- **Listen Together (Jam)** on desktop and mobile: open a room, share one invite link (`trancemusic://join?…`) or QR, guests follow the host's playhead with drift correction; transport is host-only. Room chat with unread badges, shared up-next queue, up to 16 guests.
- **Jam resilience**: multi-address invites with try-every-candidate dialing (a dead first address — VPN, emulator NAT, dock NIC — no longer fails the join), guest auto-rejoin, host tick 250 ms.
- **Download pause/resume** (desktop): paused downloads keep their `.part` file and resume with an HTTP Range request.
- **Smart playlists** (desktop): `Top 50 · Last 30 Days` and `Favourited, Not Downloaded` auto-cards.
- **Lyrics offset adjust** (mobile): ±100 ms per-track correction with reset.
- **Exportify CSV import** (mobile Settings) and quota/LRU eviction for the offline vault.

### Fixed
- **Mobile played silently** (P36): CORS-tainted WebAudio graph — the audio relay now reflects the app origin and mobile loads media with `crossOrigin="anonymous"`.
- **Room chat tab showed nothing** (P41): a missing `</div>` nested the chat view inside a hidden panel.
- **Guest could never rejoin after a host closed a room** (D5): the guest pump now ends on the server's `bye` and reverts mode before the UI reacts.
- **Guests couldn't play tracks missing from their device**: catalog fallback via `resolve_song` instead of stalling.
- **Jam joins survive dead addresses both ways** (D6): verified live emulator-host→desktop-guest (518 ms) and the reverse (524 ms).
- Home mix rows show every track (was: one card per shelf).
- Android launcher icon is the TRANCE MUSIC mark, edge-to-edge on black.
- Desktop Now Playing metadata card is transparent (blur removed); eyebrow/quality chrome removed.
- Search box double border; search failure shows one classified line instead of a URL dump; junk catalog rows dropped on album pages.
- Desktop widget: corners, transport centering, volume slider; Spotify sign-in persists (keyring feature was missing).
- Debug APK under 50 MiB (dev-profile strip + legacy jniLibs packaging).

### Changed
- Brand is **OPEN MUSIC** across both surfaces (user-facing strings only; data-format ids intentionally unchanged to protect backups and saved logins).
- Now Playing (mobile) shows clean full-bleed artwork; miniplayer truncates long titles.
- Download size: Windows installers ~4.85 MiB (release profile: LTO, `opt-level="s"`, stripped).

### CI/CD
- Tag-driven release pipeline builds Windows (MSI+NSIS) and Linux (deb+AppImage), verifies updater-manifest URLs, and publishes the GitHub release with assets.
- macOS and iOS workflows removed from the release and test matrices.

## [0.4.0] — 2026-10-05

- Cross-platform pipelines (Windows, Linux, macOS, iOS, Android).
- UI: cleaner Now Playing lyrics, redesigned desktop mini-widget, unified hover states, mobile header/settings polish.
- Full detail in git history (`CHANGELOG.md` at tag `v0.4.0`).

## [0.3.0] — 2026-10-0x

First mobile-capable release: mobile shell (13 screens), Android APK + iOS CI workflow, vault relocation with legacy migration, SQLite download ledger, cache budget controls, backup/CSV/M3U export, Caps Lock Hyper shortcuts, system tray, widget pinning, fuzzy search, network status machine, CSP hardening.

## [0.1.0] — 2026-09-30

First packaged release: signed MSI + NSIS installers, Settings (profile, autostart, language/region), desktop widget, notifications, track-credits dialog, honest-UI cleanup pass (decorative telemetry removed). A `V0.2.0` tag exists in git but never had a changelog section.
