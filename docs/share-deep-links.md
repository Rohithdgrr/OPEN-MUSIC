# Share deep links + vCard with thumbnail (2026-10-17)

Spec of record for making Share actually work: a track shared from OpenMusic
resolves to OpenMusic on any device — play inside the app when it is installed,
and when it is not, hand the receiver the right download and then play. A
vCard variant additionally embeds the track's artwork thumbnail.

## 1. Canonical URIs

| What | Shape |
|---|---|
| Web link (the thing that gets shared) | `https://rohithdgrr.github.io/OPEN-MUSIC/play.html?t=<trackId>&n=<title>&a=<artist>` |
| App scheme | `openmusic://t/<trackId>` |

- `n`/`a` are display-only hints for the landing page and vCard; **playback is
  driven by `t=<trackId>` alone**, resolved on the receiving device through
  `resolve_song` (catalog ids are stable across devices — same identity the
  Jam room protocol already relies on).
- Implemented in the pure module `app/src/sharelink.js` (zero imports, same
  class as `taste.js` / `appendsuggest.js`):
  - `playUrl({ id, title, artist })` → the https link (or `null` without an id)
  - `deepUri(id)` → `openmusic://t/<id>`
  - `parseDeepUri(uri)` → `{ id, title?, artist? }` from **either** shape
    (scheme, `play.html?t=`, or a Chrome `intent:` URL carrying it) — so a
    full https link pasted into the app also resolves.

## 2. Receiver matrix

| Receiver opens the link | What happens |
|---|---|
| Android with the app | Chrome launches the app via the `openmusic` intent (manifest filter) → parses id → resolves → plays |
| Android without the app | `S.browser_fallback_url` lands back on the page → after ~3.5 s the page shows the **Get OpenMusic** screen → APK install → open the link again (page keeps the Copy button + auto-choice by user agent) |
| Desktop with the app (Windows) | The scheme opens a new process with the URL in argv; single-instance routes it into the running app → resolves → plays |
| Desktop without the app | The page's `openmusic://…` attempt fails; the Get screen offers the Windows NSIS installer |
| Browser on desktop with the app not installed | same as above |

## 3. Landing page (`play.html` at repo root → Pages)

Static, no server. Flow: paint immediately → attempt launch (Android: Chrome
`intent://…#Intent;scheme=openmusic;package=com.openmusic.trancemusic;S.browser_fallback_url=<this page>;end`;
desktop: `openmusic://` via a hidden anchor) → if the window is still visible
after ~3.5 s (page `visibilitychange` + timer), show the Get screen:
platform-detected buttons — **Windows** `OpenMusic_<v>_x64-setup.exe`,
**Android** the release APK, **Linux** deb/AppImage — resolved from
`api.github.com/repos/Rohithdgrr/OPEN-MUSIC/releases/latest` at view time
(same pattern `index.html` already uses), plus Copy-link-again and a plain
"what is this" line. Honest limits stated in §9.

## 4. App handling of the scheme

Plugin: `tauri-plugin-deep-link = "2"` (Rust ≥1.90; this toolchain is 1.98,
CI stable). Behaves platform-differently by design:

| Platform | Mechanism |
|---|---|
| Android | Plugin's JNI `onNewIntent` hook receives the intent for whichever filters exist in `AndroidManifest.xml`. The **manifest intent-filter is injected by `app/build.sh`** (guarded block, same pattern as permissions/portrait lock — survives `tauri android init` wipes; runs on every `android`/`android-universal` build). Filter: `<data android:scheme="openmusic"/>` + VIEW/DEFAULT/BROWSABLE, no host. **Config prerequisite (live-verified 2026-10-17, §10.2 item 2): the plugin stores/forwards nothing until `plugins.deep-link.mobile` lists the custom-scheme domain — `"mobile": [{"scheme": ["openmusic"], "host": "t"}]` in `tauri.conf.json`. The plugin's `isDeepLink` gate (DeepLinkPlugin.kt) checks that list; `desktop.schemes` alone leaves `get_current` empty for good.** `host: "t"` is the URI's authority (scheme form = `openmusic://t/<id>`), no path constraint. |
| Windows | The OS spawns a **new process** with the URL in argv — the plugin emits **no event** on Windows. Two deterministic paths, no forked event name: **cold** start (app not running) — `lib.rs` captures scheme argv into a before-builder state, exposed by the small command `sharelink_launch_url`; **warm** — the already-installed single-instance callback (`lib.rs:1635`) finds `openmusic://` in argv and emits `sharelink://open`. No single-instance `deep-link` feature flag added; the callback hand-off is explicit and double-emit-proof. |
| Windows (installed) | NSIS installer hook (`bundle.windows.nsis.installerHooks` → `src-tauri/windows-deeplink.nsh`) writes `HKCU\Software\Classes\openmusic\shell\open\command`. MSI does **not** register the scheme (§9). |
| Linux | deb/AppImage spawn with argv like Windows: same cold argv capture + warm single-instance path. Scheme registration for launchers is best-effort (§9). |

Frontend — one code path on both surfaces, `app/src/sharelink.js` +
boot-time init in `mobile/app.js` and `main.js`:

1. **Cold**: `invoke("plugin:deep-link|get_current")` (Android/iOS event-stored
   URLs) and on desktop `sharelink_launch_url` → first parse wins.
2. **Warm**: Android listens on the plugin event `deep-link://new-url`;
   desktop listens on `sharelink://open` (our argv hand-off).
3. Parsed id → `resolve_song { id }` → start playback (both shells use their
   existing playing path) + toast `Playing shared track — <title>`.
   Unresolvable id → honest toast (same class as Jam D1: `Couldn't resolve the shared track`).
   A parse is consumed once (set last-parsed) so warm+cold never double-fires.

Capability: `deep-link:allow-get-current` added to `capabilities/default.json`.
The plugin's `register`/`unregister`/`is-registered` stay **not granted** —
registration happens only through the NSIS hook in installed bundles, never at
runtime (a debug exe must not write to the user's registry as a side effect).

## 5. In-app share surface changes

| Site | Before | After |
|---|---|---|
| `mobile/menus.js` Track menu Manage→Share (line ~507) and NowPlaying→Share (~686) | `t.page_url` (upstream catalog page) | **canonical play link** + a second closer **Share as vCard (with artwork)** |
| `mobile/binders.js` queue-row share (~3772) | `t.page_url` | canonical play link |
| Desktop `transport.js` Share Session | `…/#track=<id>` (only resolvable inside one machine's app) | canonical play link |
| Artist/playlist header shares | text-only | unchanged (scopes: tracks only, M1) |
| Track Details upstream page link | kept | unchanged |

`shareThing`'s contract is untouched — callers swap the payload they pass.

## 6. vCard contract

Pure builder in `sharelink.js`: `vcf({ title, artist, photoB64 })` → vCard **3.0**
(4.0's base64 syntax is unevenly parsed on Android contacts):

```
BEGIN:VCARD
VERSION:3.0
N:;<title>;;;
FN:<title> — <artist> (OpenMusic)
ORG:OpenMusic
URL:https://rohithdgrr.github.io/OPEN-MUSIC/play.html?t=<id>&n=<title>
NOTE:Tap the URL to play in OpenMusic. No app yet? The link offers the download.
PHOTO;TYPE=JPEG;ENCODING=BASE64:<base64, folded at 75 columns per RFC 2426>
END:VCARD
```

- **Thumbnail = the small proven variant**: the CDN's own 150×150 render —
  `smallArtUrl()` rewrites the artwork URL `500x500 → 150x150` (same render
  family `hqArt` already trusts) and the bytes are fetched through the local
  relay `GET /art?u=<enc>` (SSRF-guarded in `proxy.rs`, CSP-clean because it is
  loopback). Missing/erroring art → **no PHOTO and no silent lying**: the vCard
  still shares with the link (logo substitute keeps the card recognizable).
- Text values escape `\ ; ,` and fold with CRLF+space per RFC 2426; the base64
  block folds identically so Outlook/Contacts parse it.
- **Mobile delivery**: `File([blob], "<title>.vcf", { type: "text/vcard" })`
  through `navigator.share({ files })` — the exact path the backup |
  playlist-file shares already use (`binders.js`/`menus.js`); `canShare`
  checked, failure message stays honest.
- **Desktop delivery**: saves the `.vcf` next to the session's Downloads via
  the same blob-download anchor path the app uses elsewhere + copies the link.

## 7. Android APK hosting (the download leg)

`release.yml` gains an Android job: ubuntu runner (JDK 17 + preinstalled NDK),
Rust `aarch64-linux-android` target, `npm install` + `npm run css`,
`tauri android init` (fresh `gen/` on runners) → `git checkout -- .` to restore
tracked launcher icons (init deletes them), `build.sh`
`inject_android_permissions` (also injects portrait lock), `tauri android init`'s
default keystore is ephemeral per run → the attached APK is **release-signed
with a run-ephemeral keystore** (flagged in §9), artifact
`OpenMusic_<v>_aarch64-release.apk` attached to the tag's release, landing page
regex matches by extension+abi.

## 8. Gates

1. Unit: `app/tests/sharelink.test.mjs` — url/scheme builders, parse across
   all three shapes, vCard escaping/folding/PHOTO-fold, smallArt variants,
   null-safety.
2. Static: existing mobile-boot graph test still boots with the new imports.
3. `npm test` + eslint + `node --check`; `cargo fmt/clippy/test` (new state +
   commands).
4. Live: emulator probe — `adb shell am start -a android.intent.action.VIEW
   -d "openmusic://t/<id>"` with the app both warm (room-less) and cold
   (force-stopped first); desktop probe by launching the debug exe with
   `openmusic://…` as argv (single-instance warm path) and cold.
5. `play.html` headless asserts: buttons per UA, fallback timing since no
   web player exists.

## 9. Known limits (stated, none silently dropped)

- **App Links verification is absent**: Android taps of the *https* page can
  never skip the browser (assetlinks.json needs a stable cert fingerprint —
  today the CI keystore is ephemeral; a secrets-held keystore is the M2
  unlock, then `.well-known/assetlinks.json` on Pages + verified https).
- **MSI installs do not register the scheme** (WiX scheme tables are its own
  contract); the NSIS installer — our lightweight default — does.
- **Linux launcher registration is best-effort**; unregistered desktops can
  still Copy-link → open inside the app.
- **Per-track unfurl previews are impossible** on a static page (crawlers do
  not run JS); OG metadata carries the brand image. Per-track thumbnails are
  delivered by the vCard, not the link preview.
- **CI APK signatures rotate each run** until the keystore secret lands (§7).

## 10. Live verification record (2026-10-17)

Everything below ran on real surfaces; drivers live in `%TEMP%\opencode`
(throwaway, outside the repo, deleted after the run).

### 10.1 `play.html` (playwright, served copy, attempt bodies suppressed)

| Check | Result |
|---|---|
| `?t=<id>&n=…&a=…` paints title/artist + logo mark | PASS |
| app attempt suppressed → fallback at 3.5 s ("Couldn't open the app — get OpenMusic below…") | PASS |
| `#get` shown; platform-detected label = "Download OpenMusic for Windows"; buttons rewritten with real v0.5.1 `releases/download/…` hrefs (exe/apk/AppImage) | PASS |
| no-`t` variant → immediate "Get OpenMusic to play anything from a shared link." + `#sub` (artist) | PASS (after an `else`-branch fix: the first draft never called `showFallback` on that path) |
| Copy button flips its label to "Link copied ✓" | PASS |

### 10.2 Android (debug APK ×86_64 on `Pixel6_API36`, real `am start` intents)

| Probe | Result |
|---|---|
| **cold**: force-stop → `am start -a VIEW -d "openmusic://t/<id>?n=…"` | PASS — id reaches the handler via `get_current`, `resolve_song` + relay stream start, playhead advances (`paused:false, readyState:4`) |
| **warm**: the same intent while the app is foregrounded | **4/4** — `onNewIntent` → plugin event → track switches, hint title paints, audio playing, toast in the DOM |
| **bad id** (`openmusic://t/zzz_not_real`, cold) | **2/2** — honest toast `Couldn't resolve the shared track`, nothing started |
| scheme registered + routed | PASS — `ActivityTaskManager` logs resolve `cmp=com.openmusic.trancemusic/.MainActivity` for the VIEW intent without package hints |

**Three defects were found live and fixed the same day:**

1. **`parseDeepUri` rejected the scheme form with a query.** The `t/<id>`
   segment anchored with `$`, so `openmusic://t/<id>?n=…` parsed to `null` —
   and intents keep the data string verbatim, hints included. The anchor is
   gone; now the query is also **read**: `?n=`/`?a=` become `title`/`artist`
   on the returned hit (TDD-first: 4 new assertions in the round-trip test).
2. **The Android plugin captured nothing without a `plugins.deep-link.mobile`
   config.** The plugin's `isDeepLink` gate (read in
   `tauri-plugin-deep-link-2.6.2/android/src/main/java/DeepLinkPlugin.kt`)
   requires non-empty `mobile` domains — `desktop.schemes` alone stores
   nothing and emits nothing, so `get_current` returned `null` and cold/warm
   were dead. Confirmed by the config flip alone reviving `get_current`
   (`["openmusic://t/6DN9AmgT?n=Believer"]`).
3. **The success toast lied on an unresolvable id.** Mobile `playList`
   resolves *without throwing* (the paint + resolve ride its own async flow),
   so `await playList(...)` + a success toast fired `Playing «…»` even when
   the resolve failed (live-caught with `zzz_not_real`). Restructured: an
   honest immediate `Opening «title»` info toast, then a +5 s check of the
   transport (`track.id` still this shared id and no `audio.src`) that posts
   the real refusal. Probes then split cleanly: warm toast = `Opening «…»`,
   bad id toast = the refusal, no more false success.

**Stale-packaging trap (P29 class, this session's own):** one build produced
an APK (mtime 19:25:11) older than the lib it was supposed to package
(18:26:02) — gradle zipped the *previous* artifacts while cargo re-linked;
`get_current` was silent until an APK delete + rebuild. Verify freshness by
comparing `app-universal-debug.apk` mtime against
`target/x86_64-linux-android/debug/libapp_lib.so` before blaming the code.

**Probe-lesson:** expectation titles must not be
invented — two "obvious" ids mapped to different songs than assumed
(`6DN9AmgT` = "Admi Jo Kahta Hai", `1aPY9cT-` = "Believer"). Every assertion
keys on the **id** and the hint text; `resolve_song` is the only truth for a
title.

### 10.3 Desktop (debug `cargo build` exe, argv + single-instance)

| Probe | Result |
|---|---|
| **cold** (exe launched with `openmusic://t/<id>?n=…` in argv) | PASS — boot ring: `restore` → `resolve 6DN9AmgT → 320kbps → aac.saavncdn.com → unrestricted` → `play 6DN9AmgT → /stream?id=6DN9AmgT&token=…`; later CDP read confirms the shared id playing (`ready:4`, head advancing) |
| **warm** (second launch while the first runs) | PASS — single-instance forwards and exits (`PROCS=1`); the ring logs the new `resolve <id> → …` and the audio switches to the shared id (`ready:4`, playing) |
| capture commands | `sharelink_launch_url` returns the full argv URI; `plugin:deep-link|get_current` mirrors it on desktop too |
| honest failure contract | desktop `playQueueItem` *throws* on resolution failure, so the same handler keeps its success/error toasts (asymmetry with mobile is documented in §10.2 item 3) |

Ring caveat stated honestly: after the shared play, the app's own session
restore + radio prefetch/queue hygiene repaints and queues other tracks
(195-item queue from earlier flows); the assertions key on **the shared id
being the audio's stream id**, never on queue positions or bar labels.

### 10.4 Gates at the end of the batch

`npm test` **499/499** (sharelink module 11/11, one new test + query-hint
assertions) · eslint clean · `node --check` clean · `cargo fmt --check` 0 ·
`clippy --all-targets -D warnings` and `cargo test --lib` results recorded in
the run log; the `capability_grants_only_core_default` whitelist now carries
`deep-link:allow-get-current` as the documented single extra grant.
