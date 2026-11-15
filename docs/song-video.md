# Song video — architecture & proof

**Status:** **P0, P1 and P2 shipped** (2026-11-14). The decision plane, the
Rust transport, the loopback relay, the SQLite match cache and the Android
Now Playing backdrop exist and are gated by **20 Rust tests + 11 JS gates**;
the P0 probe still proves the upstream contract (search → rank → player →
`206` byte range) — evidence in §13.5, as-built map in §16 and §17.
The Settings switch ships **off by default** (§12.2). Desktop has no backdrop
yet: the plan object is ready, the render plane is mobile-only.

**Scope:** give *every* track a moving picture behind the Now Playing artwork,
using the YouTube/InnerTube logic that InnerTune and Metrolist use for playback,
plus the matching / recognition / metadata techniques those clients need to do
it reliably.

**Non-goals:** muxing video with audio, replacing the catalog player, or
shipping a general YouTube client. This is a **visual layer** with a fallback
ladder, not a second player.

---

## 1. What the reference projects actually do

Both are GPL-3.0 Kotlin YouTube-Music clients. They are used here as **protocol
references only** — no source is copied; the app is MIT (§12.1).

| Reference | Relevant mechanism | Where it lives upstream |
|---|---|---|
| InnerTune (`z-huang/InnerTune`) | InnerTube calls against `https://music.youtube.com/youtubei/v1/`; per-client headers `X-YouTube-Client-Name` / `X-YouTube-Client-Version` | `innertube/src/main/java/com/zionhuang/innertube/InnerTube.kt` |
| InnerTune | Client constants: `IOS` (api key `AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc`), `TVHTML5_SIMPLY_EMBEDDED_PLAYER`, `ANDROID_MUSIC` | `…/models/YouTubeClient.kt` |
| InnerTune | Player fallback ladder `ANDROID_MUSIC → IOS → TVHTML5`, then Piped as last resort | `…/YouTube.kt` (`player()`) |
| InnerTune | Music search / browse on `WEB_REMIX` (`AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30`) | `…/models/YouTubeClient.kt`, `…/InnerTube.kt` |
| Metrolist (`MetrolistGroup/Metrolist`) | InnerTubeX + **PO token / SABR** for the web profiles; signature transforms done out-of-process | `docs/innertube.md` §PO tokens, §SABR |
| Metrolist | Shazam-based song recognition: signature + sample duration, 3 attempts, ≥1200 ms request spacing, result cache | `androidApp/…/recognition/ShazamRecognitionClient.kt` |
| Metrolist | Match confirmation by normalized title + artist equality | `androidApp/…/recognition/RecognitionMatch.kt` |

**The load-bearing fact for us:** the iOS client family returns **plain `url`**
fields in `streamingData.adaptiveFormats` — no `signatureCipher`, so no player-JS
deciphering and no PO token. Metrolist's PO-token/SABR machinery exists because
it plays *web* profiles; we deliberately start on the profile that does not need
it, and treat PO/SABR as a Phase 4 capability if iOS closes (§12.3).

---

## 2. Measured upstream contract (this machine, 2026-11-14)

All three probes are reproducible with `node` only (Node 24 global `fetch`).

### 2.1 Player — plain-URL video renditions

Request (exactly what the app will send):

```
POST https://www.youtube.com/youtubei/v1/player?key=<IOS key>&prettyPrint=false
content-type: application/json
user-agent: com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)

{"context":{"client":{"clientName":"IOS","clientVersion":"20.10.4",
 "deviceMake":"Apple","deviceModel":"iPhone16,2","osName":"iPhone",
 "osVersion":"18.3.2.22D82","hl":"en","gl":"US"}},
 "videoId":"kJQP7kiw5Fk","contentCheckOk":true,"racyCheckOk":true}
```

Observed: `200`, `playabilityStatus.status = "OK"`, **25** `adaptiveFormats`,
**0** progressive `formats`, **13** of them `video/mp4`, **all with plain
`url`**, `lengthSeconds = 282`.

| itag | mime | size | resolution |
|---|---|---|---|
| 137 | video/mp4 | 1920×1080 | 116,495,956 |
| 399 | video/mp4 | 1920×1080 | 64,641,076 |
| 136 | video/mp4 | 1280×720 | 41,931,014 |
| 247 | video/webm | 1280×720 | 51,188,490 |
| 398 | video/mp4 | 1280×720 | 38,207,801 |
| 135 | video/mp4 | 854×480 | 28,414,767 |
| 134 | video/mp4 | 640×360 | 18,220,768 |
| 133 | video/mp4 | 426×240 | 7,822,075 |
| 160 | video/mp4 | 256×144 | 3,565,916 |
| 139/140 | audio/mp4 | — | 1.7 MB / 4.6 MB |
| 249/250/251 | audio/webm | — | 1.8 / 2.4 / 4.6 MB |

### 2.2 Search — matchable candidates

```
POST https://music.youtube.com/youtubei/v1/search?key=<WEB_REMIX key>&prettyPrint=false
{"context":{"client":{"clientName":"WEB_REMIX","clientVersion":"1.20250219.01.00",
 "hl":"en","gl":"US"}},
 "query":"Kesariya Brahmastra Arijit Singh",
 "params":"EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"}
```

Observed: `200`, **20** `musicResponsiveListItemRenderer` rows. Each row yields
`videoId`, a title column, an artist/album/duration column, and a plays column:

| videoId | title | column 2 | plays |
|---|---|---|---|
| `NJAv_7lHUIU` | Kesariya (From "Brahmastra") | Arijit Singh • Kesariya (From "Brahmastra") • 4:29 | 973M |
| `ZczAI-GNFbk` | Kesariya (From "Brahmastra") (Dance Mix) | Pritam, Shashwat Singh, Antara Mitra & Arijit Singh • 3:18 | 100M |
| `yvJUED4ulPU` | Rasiya Reprise | Pritam & Arijit Singh • Brahmastra (OST) • 4:45 | 17M |

This is enough for title/artist/duration scoring — and it is why the matcher
must reject remixes/dance mixes rather than trust row order (§6.2).

### 2.3 CDN — byte ranges work

`GET <googlevideo url>` with `Range: bytes=0-1023` →

```
206  content-type: video/mp4  content-length: 1024
content-range: bytes 0-1023/11040778
```

So the existing loopback relay pattern (`serve_media_file` + `slice_range`) is
reusable verbatim: seek, loop and resume all work through it.

---

## 3. Architecture

Three planes, each independently testable. The **decision plane** is pure JS
(shared by desktop + mobile, `node --test`-able); the **transport plane** is
Rust (cookies/CSP/SSRF stay out of the WebView); the **render plane** is markup
that only consumes a plan object.

```
                    ┌──────────────────────────────────────────┐
 track (catalog id, │  DECISION PLANE  (pure JS, both shells)  │
 title, artists,    │  videomatch.js                           │
 album, duration,   │    buildSearchQuery                      │
 isrc)              │    scoreCandidate / rankCandidates       │
        │           │    pickRendition / pickPlaybackPlan      │
        ▼           │    videoCachePolicy / mergeMetadata      │
 ┌──────────────┐   └───────────────────┬──────────────────────┘
 │ video_resolve│                       │ plan
 │  (Rust cmd)  │                       ▼
 │              │            ┌─────────────────────────┐
 │ 1 cache hit? │──yes──────▶│ <video muted loop        │
 │ 2 negative?  │            │  playsinline>             │
 │ 3 search YTM │            │ + art fallback underneath│
 │ 4 rank       │            └─────────────────────────┘
 │ 5 player iOS │
 │ 6 pick itag  │   ┌────────────────────────────────────┐
 │ 7 relay URL  │──▶│ GET /video?id&itag&token (axum)     │
 └──────┬───────┘   │ range passthrough → googlevideo     │
        │           └────────────────────────────────────┘
        ▼
  SQLite track_video  +  moka URL cache (30 min)
```

### 3.1 Why the relay, not the CDN URL directly

* The WebView never sees `googlevideo.com` — upstream host allow-listing,
  redirect re-validation and range handling stay in one place (§8.2).
* CSP stays unchanged: `media-src 'self' http://127.0.0.1:*` already allows the
  loopback origin, so **no CSP edit and no CORS work** is needed. (The Canvas
  removal left `media-src` exactly right for this.)
* Expiry is contained: the relay holds the short-lived URL; the webview holds a
  stable `/video?id=…` URL that outlives it and triggers a re-resolve.

### 3.2 Resolution states

`VideoPlan` is always returned (never an exception for "no video"):

| state | meaning | UI |
|---|---|---|
| `ready` | URL resolved and range-probed | play video |
| `none` | searched, no candidate above threshold | art + motion, negative-cached 24 h |
| `expired` | known match, URL needs a re-resolve | art for ≤1 s, then retry once |
| `unavailable` | provider error / gated / rate-limited | art, retry with backoff |
| `pending` | resolve in flight (single-flight) | art, no spinner |

---

## 4. Data model

Long-term facts only. Stream URLs are **never** persisted — they expire.

```sql
CREATE TABLE IF NOT EXISTS track_video (
  track_id    TEXT PRIMARY KEY,   -- catalog id
  provider    TEXT NOT NULL,      -- 'youtube'
  video_id    TEXT NOT NULL,      -- InnerTube video id
  kind        TEXT NOT NULL,      -- official | lyric | visualizer | live | unknown
  title       TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT '',
  duration_s  INTEGER NOT NULL DEFAULT 0,
  confidence  REAL NOT NULL,      -- 0..1, videomatch score
  matched_at  INTEGER NOT NULL,   -- unix seconds
  expires_at  INTEGER NOT NULL    -- miss rows: matched_at + 24 h
);
CREATE INDEX IF NOT EXISTS idx_track_video_expiry ON track_video(expires_at);
```

Cache tiers (mirrors `docs/cache-architecture.md`, no new machinery):

| Tier | Key | TTL | Holds |
|---|---|---|---|
| L0 JS memory | `track_id` | session | last plan per track, prefetch of next |
| L1 moka (Rust) | `track_id` | 6 h | `VideoPlan` sans URL |
| L1 moka (Rust) | `track_id|itag` | 30 min | resolved CDN URL (matches the L2 audio policy) |
| L2 SQLite | `track_id` | ∞ / 24 h miss | match identity + confidence |
| L3 network | — | — | InnerTube search + player |

Negative cache is the important one: a track with no video must cost **one**
search, not one per paint.

---

## 5. Identity flow

1. The player already knows `id`, `title`, `artist`, `album`, `duration_secs`.
2. `buildSearchQuery()` produces `"<title> <first artist> <album>"`, with the
   `(From "…")` clause stripped from the title and re-attached as album text —
   the same provenance trick as `query.js::cleanTitle`, so
   `Kesariya (From "Brahmastra")` searches as `Kesariya Arijit Singh Brahmastra`.
3. `video_resolve` checks L0→L1→L2; on miss it searches once, ranks, and stores
   either a match or a 24 h negative row.
4. A `video_id` is stable for years; the URL is not. Re-resolve on `expired`.

---

## 6. Matching algorithm (pure, testable)

`app/src/videomatch.js`. No DOM, no network, imports only `fuzzy.js` — the same
contract as `spotmatch.js`, so `node --test` covers it.

### 6.1 Score

```
score = 0.45·title + 0.30·artist + 0.20·duration + 0.05·popularity − versionPenalty
```

* `title` — best `editSim`/`querySim` over title variants (from-clause,
  `feat.`, remaster, `- Single`, bracket suffixes stripped).
* `artist` — primary artist against the row's credit string, plus the joined
  list; catalogs pad credits, so either direction counts.
* `duration` — 1.0 within 7 s, 0.5 within 20 s, 0.15 beyond, **0.7 when unknown**
  (neutral, never evidence).
* `popularity` — log-scaled `plays` column, only as a tiebreaker.
* `versionPenalty` — hard demotions for the rows that are *not* the song:
  `karaoke`, `cover`, `tribute`, `8d`, `slowed`, `reverb`, `sped up`, `nightcore`,
  `instrumental`, `reaction`, `mashup`, plus `remix`/`dance mix` unless the
  query itself says remix. This is what stops row #2 (`Dance Mix`, 3:18) from
  beating row #1.

**Accept threshold 0.62.** Below it the answer is `none` — the ladder already
has a good fallback, and a wrong video is worse than art.

**Title gate 0.70 (measured, not chosen a priori).** The first live probe run
(§13.5) accepted `Khairiyat (Bonus Track)` at **titleSim 0.56 / score 0.750**
against a *Kesariya* query, purely because the artist and the duration agreed
exactly. Weighted scoring alone cannot separate that from a true match, so the
absolute title bar is raised to 0.70. It costs nothing real: correct rows score
**1.00** on title because `titleVariants` already strips brackets, from-clauses
and remaster suffixes. Locked by a regression test named after the case.

**Weights follow the evidence that exists.** If the catalog track has no artist
(or no duration), the weight reserved for that signal folds into title
(80 %) and popularity (20 %) instead of capping every candidate below the bar.
The same applies per candidate when the *row* has no duration. A title-only
probe can therefore accept a match (§13.5, run 4) instead of never reaching
0.62.

### 6.2 Kind classification

`official` (title/channel agreement, duration within 20 s) · `lyric` (title has
lyric/lyrics, duration agrees) · `visualizer` (channel is the artist/topic) ·
`live` (duration disagrees by >20 s or title says live) · `unknown`.

Kind drives rendering: `official`/`lyric` may be shown full-bleed; `live` is
ambient-only; `unknown` is muted backdrop with no crop assumptions.

---

## 7. Rendition policy

`pickRendition(formats, { maxHeight, prefer })`:

1. Keep `video/*` only (audio comes from the catalog — **we never mux**).
2. Drop formats without a plain `url` (a `signatureCipher` format is unusable
   without a decipher implementation; treat as absent, not as an error).
3. Prefer **H.264 mp4** for WebView compatibility: itags `136/135/134/133/160`
   before AV1 (`399/398/397/396/395/394`) and VP9 (`247/244/243/242/278`).
4. Cap by height: **720p** for the ambient backdrop, **1080p** only when the user
   pins "full video".
5. Never pick `hlsManifestUrl`/`dashManifestUrl` — plain progressive only.

**Precedence, as implemented:** the height cap is a hard constraint and the
codec order applies *within* it. If the only AV1 row is 1080p and the cap is
720p, VP9 720p is chosen (a real case in the fixture set). Codec order only
decides between renditions that already fit the cap.

That yields `136` for most tracks (~18–42 MB for 3–5 min) — streamed, not
downloaded, and only when the screen is on.

---

## 8. Transport integration (Rust)

### 8.1 Commands

```rust
video_resolve(track: TrackHint) -> VideoPlan   // never Err for "no video"
video_search(query: String)     -> Vec<Candidate> // curation/debug
video_stats()                   -> VideoStats     // hits, misses, provider errors
```

`TrackHint { id, title, artist, album, duration_secs, isrc }`.

### 8.2 Relay route

`GET /video?id=<track_id>&itag=<n>&token=<session>` — same auth middleware,
same origin checks as `/stream`. Implementation reuses the `/stream` shape:

* host allow-list `*.googlevideo.com` (and nothing else),
* verbatim `Range` forwarding, `206`/`416` passthrough,
* redirect hops re-validated (the 2026-10-15 SSRF rule),
* no cookies, no referer, no visitor data persisted,
* URL cached under `track|itag` for 30 min, then re-resolved by id.

### 8.3 Failure semantics

Provider 403/410 → invalidate URL, re-resolve once, then `unavailable`.
`playabilityStatus` ≠ `OK` (`LOGIN_REQUIRED`, `UNPLAYABLE`, `AGE_*`) → `none`
with a 24 h negative row; never retry-loop (Metrolist's cooldown lesson).

---

## 9. Render plane

```
<video id="np-video" muted loop playsinline preload="none" poster="<art>">
```

* Video sits **under** the existing art card; art stays mounted as the fallback
  and as the poster, so a `none`/`unavailable` plan is visually unchanged.
* Start on `loadeddata`, not on paint: a slow 1080p stream must not flash black.
* Pause with the audio (`play`/`pause` events already exist), release on screen
  exit (`src = ""`) so the decoder does not hold memory.
* Metered data / Data Saver → skip the video entirely (reuse `onCellular()`),
  and prefer 360p if the user opted in.
* `prefers-reduced-motion` → art only.
* **Fallback ladder:** video → art + existing motion → static art. Every rung is
  already implemented; this feature only adds the top one.

No A/V sync: the video is muted and decorative; audio remains the catalog
stream. A "lyric video" mode may later calibrate an offset (§10.3).

---

## 10. Recognition & metadata (the "detection" half)

### 10.1 Audio fingerprint (`app/src/fingerprint.js`, pure JS)

Shazam-style landmark hashing, no external service:

1. PCM (mono float32) → STFT, 1024 window / 512 hop, Hann.
2. Per-frame spectral peaks (local maxima above a relative floor, top-N).
3. Peak **pairs**: each peak to up to 8 later peaks within 1–63 frames.
4. Hash `(f1, f2, Δt)` → list of anchor times.
5. Match: histogram `t_B − t_A`; the tallest bin is the alignment. Score =
   shared hashes / query hashes; the bin index × hop / rate = offset seconds.

Uses, in order of value:

* **Audio-confirmed matching** — fingerprint the catalog stream and the
  candidate video's audio itag; if the offset is stable, confidence jumps and
  remixes/live versions are separable even when metadata is ambiguous.
* **Duplicate detection** — the vault/import path can collapse re-encodes.
* **"What is playing?"** against the local library (mic sample vs stored
  fingerprints; `audio_fp(hash, track_id, offset)` table).

External recognition (Metrolist's Shazam route) is deliberately **not** in this
slice: it needs a signature generator plus a third-party service, both of which
carry rate-limit and ToS cost for a feature the local matcher largely covers.

### 10.2 Metadata enrichment

Sources and precedence (never overwrite a catalog-authoritative field with a
guess):

| Field | Catalog (JioSaavn) | Video row | Local fingerprint | User |
|---|---|---|---|---|
| title | authoritative | fills gaps | — | wins |
| artist | authoritative | fills gaps | — | wins |
| album / year | preferred | fallback | — | wins |
| isrc | authoritative (if present) | — | — | — |
| duration | authoritative | cross-check | measured | wins |
| video kind | — | authoritative | can correct (`live`) | wins |

Every enrichment carries `provenance` so the UI/docs can explain where a value
came from; the same rule as `docs/recommendations.md` §8.11 (no silent
upgrades).

---

## 11. Phased roadmap

| Phase | Deliverable | Gate |
|---|---|---|
| **P0** ✅ | this doc, pure cores, live protocol probe | §13 commands green |
| **P1** ✅ | Rust transport (`video.rs`), SQLite table, `/video` relay, 5 commands; no UI | `cargo test` + relay route test — §17.2 |
| **P2** ✅ mobile | Now Playing backdrop behind a Settings switch (default **off**), metered + reduced-motion guard | device probe — §17.4 |
| P2 desktop | same plan object behind the desktop art card | not started (mobile-only scope) |
| P3 | Audio-confirmed matching + local "what is playing" | fingerprint offset on real files |
| P4 | Provider ladder (Piped/TVHTML5 fallback), PO-token capability if iOS closes, 360p offline pack | survives one provider outage |

P2 is a UI change only: the plan object is already the whole contract.

---

## 12. Risks and limits

### 12.1 Licensing
InnerTune and Metrolist are **GPL-3.0**; this app is **MIT**. This design reuses
**protocol facts** (endpoints, headers, client constants, response shapes) and
reimplements them; no GPL source is copied, and no GPL dependency is added.
If that ever changes, the license of this repo must change first.

### 12.2 Terms of service
Streaming YouTube media outside its player is contrary to YouTube's ToS. The
feature must therefore ship **off by default**, local-only, best-effort, with no
downloading/redistribution path (the relay streams bytes; it never writes a
video to the vault). Documented for the same reason `docs/security-posture.md`
records accepted risks.

### 12.3 Fragility
* The iOS profile returning plain URLs is an *observed* behaviour, not a
  contract; it can close at any time (that is why P4 keeps a provider ladder).
* URLs expire (observed ~6 h); ids do not.
* Region/age gates surface as `playabilityStatus`, not HTTP errors.
* Bandwidth: 720p ≈ 20–40 MB per track; the metered guard is not optional.

### 12.4 What this does **not** give you
No offline video, no cast, no background video, no gapless A/V (audio is not the
video's audio), no lyrics-video sync until §10.3 calibration exists.

---

## 13. Proof — what was run

Environment: Windows, Node v24.11.0, network available. Commands are listed so
anyone can re-run them; outputs are the observed ones.

### 13.1 Player (plain URLs, no cipher)

```
node /tmp/ytprobe.mjs
→ status 200 playability OK
→ adaptiveFormats 25 formats 0
→ 13× video/mp4, all "url:plain", 144p–1080p
→ title "Luis Fonsi - Despacito ft. Daddy Yankee" dur 282
```

**Proves:** the transport assumption — video renditions are directly fetchable,
so no decipherer, no PO token, no JS engine is needed for P1.

### 13.2 Search (matchable rows)

```
node /tmp/ytsearch.mjs
→ status 200 rows 20
→ {"vid":"NJAv_7lHUIU","cols":["Kesariya (From \"Brahmastra\")",
   "Arijit Singh • Kesariya (From \"Brahmastra\") • 4:29","973M plays"]}
→ {"vid":"ZczAI-GNFbk","cols":["Kesariya … (Dance Mix)", …, "3:18"]}
```

**Proves:** candidates carry exactly the signals the scorer needs — and that the
version penalty is required (a dance mix sits at row 2).

### 13.3 CDN range

```
→ cdn status 206 type video/mp4 len 1024
  range bytes 0-1023/11040778 got 1024
```

**Proves:** the existing relay/`slice_range` design transfers unchanged.

### 13.4 Built in P0 vs still specified

| Piece | State | Where |
|---|---|---|
| Decision core (query, scoring, kind, rendition, cache policy, metadata) | **built + tested** | `app/src/videomatch.js` |
| InnerTube request shapes (search + player bodies, client constants) | **built + tested** | same file, `searchRequest` / `playerRequest` / `INNERTUBE` |
| Local audio recogniser (STFT → peaks → landmark hashes → offset) | **built + tested** | `app/src/fingerprint.js` |
| End-to-end probe | **built + run live** | `app/scripts/video-probe.mjs`, `npm run video:probe` |
| Unit suites | **built, 37 pass** | `app/tests/video-match.test.mjs` (29), `app/tests/fingerprint.test.mjs` (8) |
| Rust transport (`video.rs`), SQLite `track_video`, `/video` relay | **specified only** (§8, §15) | — |
| Mobile / desktop backdrop + Settings switch | **specified only** (§9, P2) | — |
| Audio-confirmed matching (fingerprint vs candidate audio) | **module ready, not wired** | P3 |

**Why the transport is not in this cut:** this box cannot link a Rust binary
right now (`link.exe` absent, `rust-lld` missing Windows SDK libs — the same
wall the 2026-11-14f session hit). Writing an uncompilable `video.rs` and
calling it shipped would be a claim, not evidence. The probe proves the *same
traffic* the Rust transport will forward, using the modules that will run in
the WebView, so P1 is a port with a known contract rather than a guess.

### 13.5 Local test results (the evidence)

Environment: Windows, Node v24.11.0, network available, 2026-11-14.

**A. Unit suites — 37/37 pass**

```
cd app
node --test tests/video-match.test.mjs tests/fingerprint.test.mjs tests/imports.test.mjs
ℹ tests 38   ℹ pass 38   ℹ fail 0        # 29 video-match + 8 fingerprint + 1 imports
npm run lint                              # exit 0
```

What the suites pin, beyond the formula:

| Test | Claim |
|---|---|
| studio track beats row-2 Dance Mix | the §6.2 trap, on the measured rows |
| measured false positive (`Khairiyat`, 0.750) | the title gate is what refuses it |
| title-only wants are accepted | absent evidence redistributes weight |
| title echoed into the album slot | metadata is never invented |
| 720p cap + H.264 itag 136 | rendition policy, incl. ciphered formats skipped |
| plan is `none` with a reason and no id | a miss never leaks something playable |
| decision plane has no `fetch`/`document`/`Date.now` | purity contract (§3) |
| fingerprint offset | a 0.96 s-late excerpt matches at **−0.96 s ±0.02** |
| fingerprint survives gain + noise | duplicate detection works off landmarks |

**B. Live probe — `ready`**

```
cd app && npm run video:probe -- --track "Kesariya|Arijit Singh|Brahmastra|269"

query        "Kesariya Arijit Singh Brahmastra"
search       HTTP 200 in 874 ms — 20 candidates
  NJAv_7lHUIU  0.950  t=1 a=1 d=1 pen=0  Kesariya (From "Brahmastra")
  WnyskWEuXYs  0.635  t=0.3 a=1 d=1 pen=0  Love Mania
  zYnpURpOZvw  0.550  t=0.33 a=1 d=0.5 pen=0  Deva Deva (From "Brahmastra")
accepted     NJAv_7lHUIU  confidence=0.95  kind=official
player       HTTP 200 in 248 ms — status=OK formats=23 (18 video) videoLen=268s
rendition    itag=136 720x720 video/mp4; codecs="avc1.4D401F" 1.7 MB
range        HTTP 206 in 139 ms — video/mp4 1024 B bytes 0-1023/1814821
RESULT {"state":"ready","videoId":"NJAv_7lHUIU","kind":"official",
  "confidence":0.95,"itag":136,"width":720,"height":720,"videoLengthSeconds":268,
  "bytes":1024,"rangeStatus":206,"contentRange":"bytes 0-1023/1814821","elapsedMs":1342}
```

**C. Live probe — `ready`, a different catalogue (generality)**

```
npm run video:probe -- --track "Believer|Imagine Dragons|Evolve|204"
  Kx7B-XvmFtE  0.950  t=1 a=1 d=1  Believer
  3uSfERhxvlg  0.950  t=1 a=1 d=1  Believer
  doTaxdlF9Zs  0.850  t=1 a=1 d=0.5  Believer (feat. Lil Wayne)
range        HTTP 206 — video/mp4 1024 B bytes 0-1023/532832
```

**D. Live probe — the negative case is an answer, not an error**

```
npm run video:probe -- "zzzz qqqq xxxx"
search       HTTP 200 in 781 ms — 20 candidates
  YGeno7a3xC0  0.296  t=0.38 a=0 d=— pen=0  Rxxxxx Qxxxxxxxx
state        none (below threshold, best 0.296)
RESULT {"state":"none","reason":"below threshold","confidence":0.2962,"topVideoId":"YGeno7a3xC0","candidates":20}
```

Exit code is **0** for A–D: a correct `none` is a pass. Non-zero is reserved for
transport failure.

Row counts, top candidates and the exact confidence drift between runs because
the catalogue is live (a second nonsense run reported best 0.3386). The verdict
does not drift: a wrong song stays far under the 0.62 bar and under the 0.70
title gate.

**E. Recogniser cost (measured, not estimated)**

```
node -e "…30 s synthetic PCM at 8 kHz…"
{"seconds":30,"sampleRate":8000,"hashes":5944,"fingerprintMs":45,
 "perSecondMs":1.5,"matchMs":16,"selfScore":1}
```

1.5 ms of CPU per second of audio, ~6 k hashes per 30 s, 16 ms to match. A
3–5 min track is ~0.5 s of one core — acceptable off the paint path (P3).

**F. What the live runs actually showed, besides green**

* The catalogue's top row is the right video, and the score separates it by a
  wide margin (0.95 vs 0.64 next).
* The chosen asset is YouTube Music's **square 720×720 "song video"**, 268 s
  long, 1.7 MB total — i.e. mostly-static footage, which is exactly what a
  backdrop wants (cheap to stream, loopable). Full music videos appear as tens
  of MB for the same itag; the relay does not care.
* `content-range` confirms the byte count the relay will re-serve, so seek and
  loop work through `/stream`-style range passthrough unchanged.

**Limits of this evidence:** no Rust compile (see §13.4), no WebView playback,
no device run, and the fingerprint was exercised on synthetic PCM only (no
MP3/AAC decode path exists in this cut).

---

## 14. Re-run cheat sheet

All commands below exist **today**.

```bash
# decision plane + recogniser + import graph
node --test app/tests/video-match.test.mjs app/tests/fingerprint.test.mjs app/tests/imports.test.mjs

# end-to-end upstream proof (search → rank → player → 206 range)
cd app && npm run video:probe -- --track "Kesariya|Arijit Singh|Brahmastra|269"

# free-text form (query and title are the same string)
cd app && npm run video:probe -- "Kesariya Brahmastra Arijit Singh"

# negative case — must report "no match", not a wrong video
cd app && npm run video:probe -- "zzzz qqqq xxxx"

# machine-readable (one JSON object on stdout)
cd app && npm run video:probe -- --json --track "Believer|Imagine Dragons|Evolve|204"

# a different height cap
cd app && npm run video:probe -- --max-height 480 --track "…"
```

Expected: the positive probes print the chosen video id, kind, confidence,
itag, resolution and `rangeStatus: 206` with 1024 bytes; the negative one prints
`state: none`. All exit 0.

---

## 15. Integration map (files to touch in P1/P2)

| Concern | File |
|---|---|
| InnerTube client + ladder | `app/src-tauri/src/video.rs` (new) |
| Commands, state wiring | `app/src-tauri/src/lib.rs` |
| `/video` relay, allow-list | `app/src-tauri/src/proxy.rs` |
| `track_video` table | `app/src-tauri/src/store.rs` |
| Decision core | `app/src/videomatch.js` (new) |
| Recognition core | `app/src/fingerprint.js` (new) |
| Mobile backdrop + switch | `app/src/mobile/screens/nowplaying.html`, `binders.js`, `player.js` |
| Desktop backdrop | `app/src/index.html`, `styles.css`, `playback.js` |
| Probe / dev tool | `app/scripts/video-probe.mjs` (built), `app/package.json` → `video:probe` |
| Tests | `app/tests/video-match.test.mjs`, `app/tests/fingerprint.test.mjs` (built) |
| Docs | this file; `docs/cache-architecture.md` (tier row), `docs/security-posture.md` (ToS row) |

---

## 16. As-built (P0)

### 16.1 Public surface

`app/src/videomatch.js` — pure, no DOM/network/clock (guarded by a test):

| Export | Job |
|---|---|
| `INNERTUBE`, `searchRequest`, `playerRequest` | protocol facts + the two request bodies P1 must send |
| `buildSearchQuery`, `normalizeTrack` | track → query (film lifted out of the title) |
| `parseSearchRows`, `rowFromRenderer`, `playerFormats`, `playability` | mechanical response reading |
| `scoreParts`, `rankCandidates`, `pickBestCandidate` | the decision itself |
| `classifyKind` | official / lyric / visualizer / live / unknown |
| `pickRendition`, `codecRank` | one progressive video rendition under a height cap |
| `pickPlaybackPlan`, `videoCachePolicy`, `stateForFailure` | the state machine + what to persist |
| `mergeMetadata` | gap-filling with per-field provenance |
| `titleVariants`, `creditParts`, `durationFactor`, `versionPenalty`, `popularityFactor`, `parseDuration`, `parsePlayCount`, `fromClause` | building blocks (exported for tests and for P1's parity checks) |

`app/src/fingerprint.js` — `stft`, `spectralPeaks`, `landmarkHashes`,
`fingerprint`, `matchFingerprints`, `DEFAULTS`.

### 16.2 Decisions taken while building (and why)

1. **The Rust side must not re-implement scoring.** §3's diagram reads as if
   `video_resolve` ranks in Rust. That would put the matcher in two languages
   and let them drift. Refinement for P1: Rust exposes two thin transport
   commands — `video_search(track)` returning the *trimmed* candidate array and
   `video_player(videoId)` returning normalized formats + playability — a
   `video_relay_url(track_id, itag)` minting the loopback URL, and a
   `video_store`/`video_load` pair for `track_video`. Every accept/reject stays
   in `videomatch.js`, which already runs in both shells.
2. **Title gate 0.70**, not 0.55 (measured false positive, §6.1).
3. **Weights follow available evidence** so a title-only caller is not capped.
4. **The height cap outranks codec preference** (§7).
5. **A title echoed in the album slot is not an album.** YT Music repeats the
   song name there for singles; treating it as an album would invent metadata
   and violate §10.2. `rowFromRenderer` drops any column that normalises to the
   title and only reports an album when a second distinct column survives.
6. **Response parsing walks for the row renderer** instead of pinning
   `contents.tabbedSearchResultsRenderer.tabs[0]…`. A layout change must not
   turn into `candidates: []`, because zero candidates is indistinguishable
   from "this song has no video" — the one failure mode that would silently
   negative-cache every track for 24 h.

### 16.3 Next slice (P1), in order

1. `video.rs`: the two POSTs (iOS player + WEB_REMIX search), 8 s timeout, one
   calm retry on transport/5xx, no cookies, no visitor data persisted.
2. `store.rs`: the `track_video` table from §4 + `video_load` / `video_store`.
3. `proxy.rs`: `GET /video?id&itag&token`, reusing `serve_media_file`'s range
   handling, with a `*.googlevideo.com` host allow-list and redirect
   re-validation (the 2026-10-15 SSRF rule).
4. Wire `binders.js` (mobile) / `playback.js` (desktop) to the plan object,
   keeping the Settings switch **default off** (§12.2).
5. Gate: `cargo test` for the relay + a two-device probe; the probe script in
   §14 remains the upstream regression check.

### 16.4 Known gaps

* No video decode/render path exists yet — the plan object has no consumer.
* Fingerprinting has no audio-decode step (P3 must feed it PCM from the
  existing audio graph or from the vault files).
* Provider ladder (Piped / TVHTML5 / PO token) is not implemented; if the iOS
  client starts returning `signatureCipher`, `pickRendition` returns `null` and
  the UI falls back to art — degraded, not broken.
* The `searchRequest` filter params and client versions are constants that will
  age; they are centralised in `INNERTUBE` for a one-line update.


---

## 17. As-built — transport, relay and the Android backdrop (P1/P2)

Written after the code, in the order it exists. The design above is unchanged;
this section records the shapes, the guards and what was actually run.

### 17.1 The boundary stayed where §16.2 put it

Rust owns **transport**, JS owns **every decision**:

| Layer | Module | Job |
|---|---|---|
| Decision | `app/src/videomatch.js` (P0) | query, scoring, kind, rendition policy, cache policy |
| Gate + plan | `app/src/videoplan.js` | may it play (pref, metered, reduced motion) and which plan to build |
| Transport | `app/src-tauri/src/video.rs` | the two POSTs, mechanical parsing, URL cache, relay URL minting |
| Relay | `app/src-tauri/src/proxy.rs` `/video` | host allow-list, `Range` passthrough, one re-resolve |
| Persistence | `app/src-tauri/src/store.rs` `track_video` | match identity + 24 h negative rows |
| Render | `app/src/mobile/videobackdrop.js` | the `<video>` lifecycle only |

### 17.2 Commands (§8.1 as built)

| Command | Returns | Notes |
|---|---|---|
| `video_search(query)` | `Candidate[]` (`videoId`, `title`, `credit`, `parts`, `album`, `durationSecs`, `plays`, `channel`) | camelCase so the array feeds `pickBestCandidate` unchanged |
| `video_player(videoId)` | `{ playability: { status, reason, videoId, title, lengthSeconds }, formats: Format[] }` | normalized exactly like `playerFormats` |
| `video_relay(trackId, videoId, itag, url)` | `{ url, itag }` | re-validates `url`, caches `track|itag` → URL, learns `track` → videoId |
| `video_stats()` | `{ searches, players, relayHits, relayResolves, errors, prepared, known }` | diagnostics |
| `video_load(id)` / `video_store(row)` | `TrackVideoRow` / `()` | SQLite `track_video` |

`Format` = `{ itag, mimeType, url, hasCipher, width, height, fps, sizeBytes, quality }`.
A `signatureCipher` row keeps `url: ""` and `hasCipher: true`, so the JS
rendition policy treats it as absent instead of crashing.

Post bodies are the P0-probe shapes (`search_body` / `player_body`), asserted by
tests, with one calm retry on transport failure / 5xx / 429.

### 17.3 Relay (`GET /video?id&itag&token`)

* Same auth middleware, Host/Origin/Referer checks and session token as `/stream`.
* Host allow-list: `googlevideo.com` and `*.googlevideo.com` only — loopback,
  private ranges, `*.local` and IP literals are refused, before the request
  **and** after redirects.
* `Range` is forwarded verbatim; `206`/`416`, `content-range`, `content-length`
  and `accept-ranges` pass through, so the element can seek and loop.
* A success-status body that is not `audio/*` / `video/*` is refused rather than
  relayed as video (the 2026-10-15 rule, reused).
* Cache miss → `409` (JS re-prepares). Cached URL aged out (403/410) → one
  re-resolve from the learned video id, then whatever the CDN says.

### 17.4 Render plane (Android)

* Markup: `<video id="np-video" muted loop playsinline preload="none">` inside
  `#np-art-card`, **after** the artwork `<img>`, so art is the poster and the
  fallback for `none` / `unavailable` / `off`.
* CSS: `#np-video` is `absolute; inset:0; object-fit:cover; opacity:0`, gains
  `.is-live` (opacity 1, 420 ms fade) only on `loadeddata` — no black flash.
  `prefers-reduced-motion` removes the fade.
* Lifecycle: `syncVideoBackdrop(track, st)` from `paintNowplaying`; play/pause
  follows the catalog audio (capture-phase `play`/`pause` on `#audio`); hidden
  document pauses it; leaving the screen, clearing the track or switching the
  feature off calls `stopVideoBackdrop()` (`src = ""` releases the decoder).
* Gate (`videoplan.videoGate`): off unless `tm-np-video === "1"`; refused with
  `no-backend`, `reduced-motion` or `metered` (cellular **or** Data Saver).
* Memory: session `Map` of plans (L0), 5-minute retry after a transport error,
  24 h quiet after a persisted negative row.

### 17.5 Evidence

* Rust: `cargo test --lib video::` — **10/10** (row parsing incl. the measured
  three-column shape, layout-independent walk, dedupe, format normalization +
  cipher flag, playability, request bodies, duration/plays parsing, credit
  splitting, host guard). `proxy::tests::video_route_requires_a_prepared_cdn_rendition`
  — **1/1** (409 before preparation, 502 for a non-CDN host).
* JS: `node --test tests/mobile-video-backdrop.test.mjs` — **11/11** (default
  off, every gate reason, measured rows, rendition cap/codec, plan states,
  purity, markup/CSS/switch wiring, CSP still allows the loopback).
* Bundle + graph: `npm run build:mobile` exit 0; `mobile-boot` + `imports`
  execute the real mobile graph with the new module.
* The P0 probe is unchanged and still the upstream regression check (§14).
