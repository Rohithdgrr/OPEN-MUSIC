# Unlimited Music Streaming — How It Was Built

Companion to `PRD.md`, `architecture.md`, `task.md`.
Last verified: **2026-09-28** · `cargo build` clean · `cargo test` **21/21** · headless UI self-test **30/30**.

---

## 1. TL;DR

| | Before | After |
|---|---|---|
| Catalog source | 3rd-party mirror (`saavn.sumit.co`) only | **JioSaavn first-party API** (`www.jiosaavn.com/api.php`), mirrors as fallback |
| Search failure | `HTTP 429 Too Many Requests` — search dead | A `429` costs **one** request, then the next source is tried; the UI shows a **Retry** button |
| Result depth | one page of 20 | **unbounded paging** (`page` 1..n, `total` reported upstream) |
| Stream | mirror's `downloadUrl[]` (mirrors were `404`) | **direct from `aac.saavncdn.com`** — 5 renditions per song, `_320.mp4` = the complete file |
| New dependencies | — | 2 Rust crates: `des`, `base64` (no JS deps at all) |

The whole thing hinges on one piece of reverse engineering: **JioSaavn's media URLs ship
base64-encoded and DES-ECB encrypted inside the search/detail JSON — decrypt them and you
have the CDN asset for every rendition of the full song, with no mirror in the path.**

---

## 2. The failure that started it

```
Search failed: https://saavn.sumit.co/api/search/songs?query=aya+sher&limit=20
               -> HTTP 429 Too Many Requests
```

Probing the configured mirror list showed the problem was systemic, not transient:

| Mirror | Result |
|---|---|
| `jiosaavn-api.vercel.app` | `404` (deployment gone) |
| `saavn-api.vercel.app` | `404` |
| `jiosaavn-api-privatecvc.vercel.app` | `404` |
| `saavn.dev` | `ENOTFOUND` (domain dead) |
| `saavn.sumit.co` | `429` (quota) |

Every mirror was dead or rate-limited, and the old retry loop **retried the same
rate-limited mirror** before failing over — multiplying the 429s. The catalog needed a
source that was not a third-party deployment with someone else's quota.

---

## 3. Research method

1. **Probe the declared contract** — `curl` against each mirror to see what still answers.
2. **Go to the origin** — `www.jiosaavn.com` (the site itself) answers `200` with no quota:
   `?__call=search.getResults&q=…` returned `{"total":5189,"start":1,"results":[…]}`.
3. **Find the song-detail call.** `song.getDetails?pid=…` returned
   `{"status":"failure"}`; `webapi.get` demanded a `token`. So the page's own
   **JS bundles were downloaded and grepped** (45 bundles from
   `staticweb6.jiosaavn.com`), which produced the caller:
   ```js
   { __call: "song.getDetails", pids: e, api_version: 4, _format: "json", _marker: 0, ctx: … }
   ```
   The parameter is **`pids`, not `pid`** — that single character was why every attempt failed.
4. **Find how `encrypted_media_url` is turned into a playable URL.** The player bundle
   never decrypts it client-side, so open-source implementations were read instead.
   `inovachrono/Saavn-Downloader` gave the exact recipe:
   ```python
   return des(b"38346591", ECB, b"\0"*8, pad=None, padmode=PAD_PKCS5)
   dec_url = self.des_cipher.decrypt(base64.b64decode(enc_url)).decode("utf-8")
   dec_url = dec_url.replace("_96.mp4", "_320.mp4")
   ```
5. **Verify before writing any Rust.** `openssl` decrypted a live sample to a real CDN URL,
   then `curl` with `Range` proved all five renditions exist and are range-servable.

---

## 4. The primary source — JioSaavn first-party API

Base: `https://www.jiosaavn.com/api.php` (implemented in `app/src-tauri/src/official.rs`)

| Purpose | Request | Notes |
|---|---|---|
| Search, page *p* | `?__call=search.getResults&q=&n=&p=&_format=json&_marker=0` | `n` capped at **40**, `total`/`start` give real pagination |
| Song detail | `?__call=song.getDetails&pids=&api_version=4&_format=json&_marker=0&ctx=web6dot0` | returns `more_info.encrypted_media_url` |

Measured on `q=arijit`:

| Request | `start` | Returned |
|---|---|---|
| `n=10&p=1` | 1 | 10 |
| `n=10&p=2` | 11 | 10 (disjoint from page 1) |
| `n=50&p=1` | 1 | 40 (server cap) |
| — | — | `total = 5189` |

That `total` is the "unlimited": results keep coming as long as you ask for page *n+1*,
and the frontend's **Load more** button walks the pages until upstream returns fewer than
one full page.

### Field mapping (defensive parsing)

Official payloads use different names than the mirrors, and titles carry HTML entities:

| `Track` field | Official source |
|---|---|
| `title` | `song` (HTML-unescaped: `&quot;` → `"`) |
| `artist` | `primary_artists` → `singers` → `music` → `subtitle` |
| `album` | `album` |
| `duration_secs` | `duration` (string seconds) |
| `image` | `image`, `-150x150` → `-500x500` |
| `page_url` | `perma_url` |
| `hq` | `320kbps == "true"` (drives the "Lossless Only" chip) |
| `plays` | `play_count` (drives popularity sort) |

---

## 5. The core technique — DES-ECB media URL decryption

```
encrypted_media_url  ──base64 decode──►  72-byte ciphertext
                  ──DES-ECB, key "38346591", PKCS#7 unpad──►
   https://aac.saavncdn.com/450/f467e05e2825cec2203546333e0d0550_96.mp4
                  ──suffix swap──►  _12 / _48 / _96 / _160 / _320
```

Implementation (`official.rs::decrypt_media_url`):

```rust
const MEDIA_KEY: &[u8; 8] = b"38346591";          // 8 ASCII bytes = DES key
const RENDITIONS: &[(&str, &str)] = &[             // quality label -> url suffix
    ("12kbps", "_12"), ("48kbps", "_48"), ("96kbps", "_96"),
    ("160kbps", "_160"), ("320kbps", "_320"),
];

let raw = base64::engine::general_purpose::STANDARD.decode(encoded.trim())?;
let cipher = des::Des::new_from_slice(MEDIA_KEY)?;
for block in raw.chunks_exact(8) {                 // ECB: each 8-byte block independent
    let mut b = GenericArray::clone_from_slice(block);
    cipher.decrypt_block(&mut b);
    out.extend_from_slice(&b);
}
// PKCS#7 unpad (block size 8), then String::from_utf8
```

**Verification vector** (pinned by the unit test `decrypts_media_url_to_a_cdn_asset`):

| | |
|---|---|
| Input | `ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDySan+n+AW12BvOaQj7cuGfg8Ed085rYUtqDj8DQY3nIMQdr42ScGdtRw7tS9a8Gtq` |
| Output | `https://aac.saavncdn.com/450/f467e05e2825cec2203546333e0d0550_96.mp4` |

CLI equivalent used during research:

```bash
openssl enc -d -des-ecb -provider legacy -provider default \
  -K 3338333436353931 -in enc.bin     # hex of ASCII "38346591"
```

> DES? Yes — JioSaavn uses legacy DES-ECB here, which is also why the ciphertext is a
> multiple of **8** bytes (96 base64 chars → 72 bytes) rather than 16. That length
> mismatch was the clue that ruled out AES.

### Rendition synthesis (measured, all `206`)

| Rendition | Bytes | `bytes=0-63` |
|---|---|---|
| `_12.mp4` | 439,411 | `206`, `ftyp` at offset 4 |
| `_48.mp4` | 1,618,130 | `206` |
| `_96.mp4` | 3,190,357 | `206` |
| `_160.mp4` | 5,286,686 | `206` |
| `_320.mp4` | **10,527,454** | `206` |
| `_320.mp4` `bytes=2000000-2065535` | — | `206`, exactly **65,536** bytes, `audio/mp4` |

`_320.mp4` is the **complete song**, not a preview — and it lives on `*.saavncdn.com`,
which the existing media allow-list (`MEDIA_HOSTS = ["saavncdn.com"]`) already trusts, so
the localhost range relay needed no changes.

---

## 6. Why the stream can't run out

1. **Unlimited search depth** — real upstream pagination (`total`/`start`/`results[]`),
   `page` threaded through `invoke → lib.rs → proxy cache → official.rs`.
2. **No quota in the hot path** — the source is JioSaavn's own player endpoint; mirrors
   are only reached if that call *fails*.
3. **Full files, all qualities** — five renditions synthesized per song; the resolver
   defaults to `320kbps` and can be re-resolved at any other quality.
4. **Availability failover** — official → 5 mirrors, each with its own budget.
5. **Everything memoised** — `search_cache` (key `query:limit:page`), `resolved`
   (song id → song), `qualified` (CDN url → probe) so repeats never re-hit the network.
6. **Range honesty preserved** — the three-probe qualification (`bytes=0-63` + ftyp,
   mid-file, open-ended) still runs before any promise of playback, so a capped CDN would
   be reported as `PREVIEW ONLY` instead of silently stalling.

### Rate-limit handling (the actual 429 fix)

```rust
if status.as_u16() == 429 {
    // Retrying the same host only extends the penalty: record the failing
    // URL and move to the next mirror — a different host has its own budget.
    last_err = format!("{url} -> HTTP {status}");
    break;                        // ONE request, never MAX_RETRIES of them
}
```

- `429` → **1 request**, fail over immediately.
- `5xx` → up to `MAX_RETRIES` with exponential backoff + ±25 % jitter (`backoff_ms`).
- transport error → same backoff, then next mirror.
- errors quote the **full URL**, so the UI can show exactly which hop failed.
- the frontend turns any failure into `Search failed: …` + a **Retry** button.

---

## 7. Packages & dependencies

### Added to `app/src-tauri/Cargo.toml`

```toml
des     = "0.8"     # RustCrypto DES — block decrypt for encrypted_media_url
base64  = "0.22"    # decode the payload
```

That is the entire new dependency surface. No new runtime language, no framework,
**no new `package.json` dependency** (project rule in `PRD.md §13`).

### Already in use

| Crate | Version | Role here |
|---|---|---|
| `tauri` | 2 | window + IPC command surface |
| `reqwest` | 0.12 | two-client policy: `api_client` (25 s total) / `media_client` (no total timeout) |
| `axum` | 0.8 | localhost range relay (`/stream?u=` / `?id=`) |
| `tokio` | 1 | async runtime + file writes for `download_to` |
| `serde` / `serde_json` | 1 / 1 | defensive JSON parsing |
| `url` | 2 | query encoding, host allow-listing |
| `futures` | 0.3 | streaming body relay |

Frontend stays **vanilla ES modules + prebuilt Tailwind CSS** — no runtime JS build step.

### Research / verification tooling (not shipped)

| Tool | Used for |
|---|---|
| `curl` | mirror status probes, `Range` measurements |
| Python 3.12 + `cryptography` | quick AES/GCM/CTR attempts that **ruled out** AES |
| Python `urllib` | endpoint matrix, JSON field dumps, bundle grepping |
| `openssl enc -des-ecb -provider legacy` | proving the DES key before writing Rust |
| Chrome `--headless=new --dump-dom --virtual-time-budget` | 30-assertion UI self-test |
| `cargo test` | live contract + byte-count regressions |

---

## 8. GitHub projects consulted

| Repository | What it contributed |
|---|---|
| [`sumitkolhe/jiosaavn-api`](https://github.com/sumitkolhe/jiosaavn-api) (MIT) | The mirror contract (`/api/search/songs`, `/api/songs/{id}`, `downloadUrl[]`) the existing `jiosaavn.rs` was built against; deploy instructions used to confirm mirrors are self-hosted instances. |
| [`inovachrono/Saavn-Downloader`](https://github.com/inovachrono/Saavn-Downloader) (★140) | **The decryption recipe** — `des(b"38346591", ECB, …, PAD_PKCS5)` over base64, plus the `_96.mp4 → _320.mp4` swap. Ported to Rust in `official.rs`. |
| [`ODSkyler/jiosaavn-api`](https://github.com/ODSkyler/jiosaavn-api) | Confirmed `encrypted_media_url` is passed through unmodified by every modern adapter. |
| [`shnwazdev/shnwazdev-jiosaavn-api`](https://github.com/shnwazdev/shnwazdev-jiosaavn-api) | Confirmed the detail→`downloadUrl` mapping (`createDownloadLinks(song.more_info.encrypted_media_url)`). |
| [`akadotsh/go-jiosaavn-api`](https://github.com/akadotsh/go-jiosaavn-api) | Confirmed the payload struct `Encrypted_Media_Url` naming across languages. |
| `jiosaavn-api-rho.vercel.app` (`docs.saavn.me`) | Probed as a candidate mirror; different route table, so **not** adopted. |

Method note: candidates came from the GitHub Search API
(`search/repositories?q=jiosaavn+api&sort=updated`), then each repo's tree was fetched and
grepped for `decrypt|AES|encrypted_media_url` — one hit carried the key.

---

## 9. Where the code lives

| Concern | File / symbol |
|---|---|
| First-party search + paging | `official.rs::search` |
| First-party detail + qualities | `official.rs::fetch_song` |
| DES decrypt / rendition synthesis | `official.rs::decrypt_media_url`, `official.rs::renditions` |
| Source failover (official → mirrors) | `jiosaavn.rs::search_songs`, `jiosaavn.rs::fetch_song` |
| Mirror transport + 429 policy | `jiosaavn.rs::get_json`, `jiosaavn.rs::backoff_ms` |
| Entity/number parsing helpers | `jiosaavn.rs::html_unescape`, `jiosaavn.rs::num_any` |
| Page-keyed search cache | `proxy.rs::AppState::cached_search` |
| Byte-checked offline save | `proxy.rs::AppState::download_to`, `lib.rs::download_song` |
| Range relay + allow-list | `proxy.rs::stream`, `jiosaavn.rs::validate_media_url` |
| UI: chips / sort / carousel / load-more / retry | `main.js` (`currentView`, `refreshResults`, `doSearch`) |

---

## 10. Evidence — the tests that prove it

```
$ cargo test
test official::tests::decrypts_media_url_to_a_cdn_asset .............. ok   ← DES vector
test official::tests::renditions_cover_the_five_cdn_bitrates ......... ok   ← 5 qualities
test official::tests::live_search_page2_advances_beyond_page1 ... ok   ← unlimited paging
test official::tests::live_resolve_yields_all_renditions_of_the_full_file ok ← full song
test jiosaavn::tests::live_search_returns_tracks ..................... ok   ← fallback path
test jiosaavn::tests::live_resolve_and_qualify_is_unrestricted ........ ok
test proxy::tests::stream_delivers_the_entire_body ................... ok   ← received == 10,527,454
test proxy::tests::mid_file_range_returns_exactly_65536_bytes ......... ok
test proxy::tests::download_writes_exactly_the_declared_bytes ......... ok   ← offline save
… 21 passed; 0 failed (~4 s)
```

Frontend: a temporary headless harness (Chrome `--headless=new`, stub IPC, deleted after
the run) clicked **every control on the search screen** — search, clear, 6 filter chips,
sort cycling, Refine Filters, header form, Load more to exhaustion, carousel prev/next,
featured play/download, row play/download, Play all, failure→Retry, history chips —
**30/30 assertions green**.

---

## 11. Known limits & notes

- `n` (page size) is capped at **40** upstream; the app asks for 20 per page.
- `webapi.get` (needs a client-side `token`) and DRM-tagged streams were **not** used —
  the plain DES path already yields full non-DRM MP4 audio on the public CDN.
- Mirrors in `MIRRORS` are kept as a fallback chain; most currently answer `404`/`429`,
  which now only costs one request each before the error is surfaced.
- Artwork upgrades to `-500x500` are best-effort; `<img onerror>` hides any miss.
- Artwork/streams are fetched from JioSaavn's public endpoints the same way its own web
  player does. Whether that is acceptable for a **public release** is tracked as an owner
  decision in `task.md` (X.4) — resolve it before shipping.
