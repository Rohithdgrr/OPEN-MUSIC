# Jam upgrade — one master doc (spec + plan, all seven requests)

**Status:** design complete, ready to execute · **Date:** 2026-10-08
**Rules:** docs-first (this document precedes all code) · commits local, **no
push without an explicit go-ahead** · recommended options are pre-approved
(AGENTS.md rule 9).

**Source request (verbatim):**
> *"MAKE BOTH PLAY WITH SAME SINK NOT JUST EVEN 1SECOND DELAY OT RELAY . PERFECT
> SINK. ADD QR IN MOBILE , ALSO ADD SCANNER TO SCAN AND JOIN IN ROOM. SET APP
> LOGO (MOBILE APP) .WHILE USING HOST ,GUEST USE THE USERS PROFILE NAME ALSO
> FOR CLARITY.MAKE JAM CONTROLS WORK LIKE IF HOST PAUSED,PREVIOUS SONG , NEXT
> SONG SONG IN GUEST ALSO IT SHOULD BE SAME . ,IN BOTH MOBILE AND DESKTOP
> APPLICATION JUST PROVIDE SINGLE LINK TO JOIN NOT LIKE LINK SEPERATE , CODE
> SEPERATE IT SHOULD BE UNIFIED IN BOTH UI AND BACKEND .TEST JAM WITH MORE
> MULTIPLE CONNECTIONS LIKE MORE EMULATORS AND DESKTOP SO MAKE SURE IT SUPPORT
> LARGE NO.OF DEVICES WITH PERFECT SINK WITHOUT ANY GAP."*

**Locked decisions (Q&A):** order **A→B→C→D→E→F** · link scope =
**copy-paste + in-app scan, no OS tap-to-open** · format =
**`trancemusic://join?host=…&port=…&code=…`** (deep-link-ready later with no
string migration).

**Note:** the earlier per-sub-project file `docs/jam-unified-invite-spec.md`
(sub-project A) is **folded into §A below** — this doc is the single source of
truth from here.

---

## 1. Current state (verified in this repo, 2026-10-08)

| Fact | Evidence |
|---|---|
| Sync = 1 s host tick + apply-absolute-playhead + seek only past ±0.4 s | `social.js:38 HOST_TICK_MS=1000`, `room.js:162 DRIFT_TOLERANCE_MS=400`, `room.js:168 syncDecision` |
| Measured drift today | ±0.25–0.27 s live (guest extrapolates via `expectedPositionMs`, anchored at frame arrival) |
| Invite = link + code composite, backend takes 2 params | `room.js:141 inviteText` → `ws://ip:port · CODE`; `room.rs:873 room_join{addr,code,name}` |
| Join sheets: desktop 2 typed fields; mobile paste + 2 typed fields | `index.html:1724-1725`, `jam.js:114-116` |
| QR already encodes `inviteText` on both surfaces | `social.js:708`, `jam.js:616-643 paintQrSurface` |
| `tm-username` read by both surfaces, **written nowhere** → everyone is "Host"/"Guest" | `social.js:78`, `jam.js:157`; no `setItem("tm-username")` anywhere |
| Pause broadcast: desktop `social.js:736/744`, mobile was missing until D4 fix; track changes reach guests via tick ≤1 s | D4 (P34), `jam.js:364/375` |
| Room cap = 8 guests | `room.rs:39 MAX_GUESTS=8`, test `ninth_guest_is_refused:1400` |
| No scanner; a dead `jam/qr-scanner.js` was deleted in Task 1 (never integrated — do not resurrect blindly) | `0e3744d` |
| Live gates: desktop 32/0 · emulator 28/0 · reverse-pair 19/0 · LAN all-pass | `app/tests/live-*.mjs`, §10 of `listen-together.md` |

---

## 2. Decomposition (six sub-projects, this order)

| # | Sub-project | Depends on | Headline ask |
|---|---|---|---|
| A | Unified invite URI | — | "SINGLE LINK … UNIFIED IN BOTH UI AND BACKEND" |
| B | Scan-to-join camera scanner | A | "ADD QR IN MOBILE, ALSO ADD SCANNER" |
| C | Sync upgrade to ±100 ms | — | "PERFECT SINK … NOT EVEN 1 SECOND DELAY" |
| D | Transport parity + profile names | — | "HOST PAUSED/PREV/NEXT … SAME IN GUEST", "USE THE USERS PROFILE NAME" |
| E | Mobile app logo | — | "SET APP LOGO (MOBILE APP)" |
| F | Multi-device scale | A, C, D | "LARGE NO.OF DEVICES … WITHOUT ANY GAP" |

Each sub-project below = design + tests + acceptance. Tasks in §9 are ordered
TDD-style; every task ends with its own green gate and a local commit.

---

## 3. Sub-project A — unified invite URI (design approved)

### 3.1 Contract
- Canonical string: `trancemusic://join?host=192.168.1.5&port=8787&code=ABCD2345`
- Rust owns both directions, frontend never string-builds:
  - `fn invite_uri(host: &str, port: u16, code: &str) -> String`
  - `fn parse_invite(raw: &str) -> Result<(String, u16, String), String>`
    accepting the canonical URI **and** the legacy `ws://ip:port · CODE` line
    (also bare `ip:port CODE` / `ip CODE`, mirroring today's JS parser).
- Unknown query params ignored (forward-compatible). Missing `code`, bad
  `port`, wrong scheme → error, never a guess.

### 3.2 Backend (`app/src-tauri/src/room.rs`)
- `OpenInfo` and `RoomInfo` gain additive **`invite: String`** (host with a
  detected LAN url → canonical string; nobody else → `""`). `urls`/`code`
  unchanged (D-12 stays truthful).
- New command **`room_join_uri { uri, name }`**: `parse_invite` → shared
  `begin_join` helper (mode-guard + dial + spawn `guest_run`) — the exact
  body `room_join` has today.
- `room_join { addr, code, name }` stays as a thin legacy wrapper (builds URI
  from `addr`/`code` → same helper). One code path, two entry points.

### 3.3 Frontend
- `room.js`: `createRoomState()` + `hosted` case + `bye` reset carry
  `invite`; `inviteText(state)` returns `state.invite` when non-empty, else
  the legacy composite, else code-only (never "undefined"); `parseInvite(raw)`
  gains a canonical branch (returns `{addr, code}` for both — signature
  unchanged so existing tests hold) as **pre-validation for the inline error
  only; Rust is the authority**.
- Desktop: `index.html:1724-1725` collapses to one input
  `#room-join-invite` (placeholder shows the canonical example);
  `social.js:564-575 joinRoom` reads it, `parseInvite`-validates, invokes
  `room_join_uri`; Enter wiring `social.js:896` targets the single id;
  `room-join-addr`/`room-join-code` deleted. `openRoom`'s `hosted` frame
  (`social.js:548`) and the `room_info` re-attach carry `invite`.
- Mobile: sheet template (`jam.js:115-116`) drops `#jam-join-addr`/
  `#jam-join-code`; go-handler (`jam.js:141-151`) sends the raw pasted string
  via `room_join_uri`; both `hosted` builders (`jam.js:190`, `jam.js:900`)
  carry `invite`.
- Display everywhere (invite row, Copy, QR) = `inviteText` → identical
  canonical string on both surfaces.

### 3.4 Errors
Unparseable paste → inline `That doesn't look like an invite link` (from the
Rust rejection, surfaced through the existing note/toast paths). Wrong code /
full room / unreachable host → unchanged server reasons. `room_join_uri` parse
failure must happen **before** any mode mutation (D2 lesson).

### 3.5 A — tests & acceptance
| Layer | Cases |
|---|---|
| Rust unit | round-trip `parse_invite(invite_uri(...))`; legacy line/typed forms; rejects (bad scheme, missing code, non-numeric port, empty host) |
| Rust command | `room_join_uri("garbage")` → Err **and mode stays Idle** (a following `room_open` succeeds); `room_join_uri` while hosting → exact guard "Leave the current room before joining another."; happy path dial |
| JS unit (`room.test.mjs`) | `inviteText` prefers `state.invite`, falls back composite → code-only; `invite: ""` reset on `bye`; `parseInvite` canonical/legacy/garbage |
| Static contract | `social-ui.test.mjs:185` command list swaps `room_join`→`room_join_uri`; `:198` id list swaps to `room-join-invite`; `jam-ui.test.mjs:114` same swap |
| Live | `live-reverse-pair.mjs:92-93` fills `#room-join-invite` with the canonical string; `live-lan-join.mjs:89-93` fills `#jam-join-invite`; expected counts unchanged (19/0, all-pass). `live-desktop`/`live-android-emulator` use node ws guests — unaffected |

**AC:** (1) `room_open`/`room_info` JSON has canonical `invite` and unchanged
`urls`/`code`; (2) all Rust cases green; (3) `room_join_uri` joins from one
string, `room_join` still works; (4) both sheets have exactly one input;
(5) displayed/copied/QR strings byte-identical = backend `invite`; (6) probes
green; (7) full gates green.

**Status 2026-10-08 — A1–A6 COMPLETE, all seven ACs green:**

| AC | Evidence |
|---|---|
| (1) canonical `invite`, `urls`/`code` unchanged | Rust `invite_from` unit + live Android probe `room_info.invite` → `trancemusic://join?host=10.0.2.16&port=8787&code=N6NQ2SLG` with `urls`/`code` intact (D-12 row) |
| (2) Rust cases | `cargo test --lib` 194/194 (`OP_OFFLINE=1`), fmt 0, clippy 0 — commits `9ed94cf` |
| (3) `room_join_uri` from one string | live: garbage → `"That doesn't look like an invite link."`, good URI while hosting → exact guard, failed dial → `room_info` stays `idle` and a following `room_open` works (D2 lesson re-proven on device) |
| (4) one input per sheet | static tests + live Android probe (sheet ids: invite ✓, addr/code absent) |
| (5) UI == backend byte-identical | live Android: `#jamInviteUri` text == `room_info.invite` exactly |
| (6) probes green | `live-desktop` **32/0** · `live-reverse-pair` **exit 0** (D4/D5 included; desktop guest joined **through the canonical link**) · `live-lan-join` **exit 0** (real LAN; Android guest joined through `#jam-join-invite`) · Android spike probe **11/11** |
| (7) full gates | `npm test` 254/254, eslint clean; commits `c994fae` (A3), `d5cdf85` (A4), `33ed7d2` (A5), `779a5ab` (A6 probes) |

---

## 4. Sub-project B — scan-to-join (mobile camera)

### 4.1 Design
- **Spike first (B-T1), camera feasibility in the real Tauri Android
  WebView:** does `navigator.mediaDevices.getUserMedia` + `BarcodeDetector`
  ("qrCode") work there? (Shape Detection API ships in Chrome/WebView ≥83;
  WebView camera needs the Android runtime permission + WebView
  `onPermissionRequest`.) Time-boxed one session; write the verdict into
  `docs/mobile/09-problems-solutions.md` either way.
  - **If yes:** B-T2 builds the scanner.
  - **If no:** B stops honestly — scan-to-join falls back to the user's system
    camera + paste (A already delivers paste everywhere), documented as the
    limitation. **No vendored decoder in v1** (new dependency = needs the user's
    call); re-decide only after the spike result.

  **Spike verdict (B-T1, 2026-10-08, run on `Pixel6_API36` / WebView
  Chrome/133): camera YES, detector NO.** Full record: `docs/mobile/09-
  problems-solutions.md` **P38**.
  - Camera: works after `CAMERA` lands in the manifest through
    `build.sh inject_android_permissions` (injection changed this session:
    CAMERA-aware idempotence + sourceable dispatcher). Live proof: gUM
    delivers a stream, frames render — wry approves the origin.
  - `BarcodeDetector`: surface present (constructs, advertises `qr_code`)
    but `detect()` returns empty on every input shape (DOM canvas,
    ImageBitmap, blob, video) against a visually verified correct QR —
    silent, no console error. `canvas.captureStream` also dead.
  - **Decoder decision (recorded here so the plan stays single-source):**
    the user's request is verbatim *"ADD QR IN MOBILE, ALSO ADD SCANNER"* —
    option (ii), a fallback that ships no scanner, would not deliver it.
    Under standing rule 9 (recommended options are pre-approved) B-T2
    proceeds with option (i): **vendor `jsQR` as one committed file**
    (`app/src/vendor/jsQR.js`, Apache-2.0 (verified from the repo's LICENSE,
    not remembered), pure JS, zero transitive deps, **no npm dependency** —
    `package.json` untouched, keeping the §4.2 AC "no new npm dependency").
    Option (ii) stays the fallback for what still fails live
    (e.g. camera permission denied on a real device → paste remains).
- Scanner UI (success path): full-screen sheet in the Jam join flow
  ("Scan QR" next to the paste field), `<video>` + overlay; frame polling at
  ~5 fps (`video` frame → offscreen canvas → `getImageData` → **`jsQR`**) —
  deliberately **not** `BarcodeDetector` (spike: silent empty results, P38);
  on hit → validate with pure `extractInviteFromScan` (canonical-only) →
  same `room_join_uri` path as paste → camera stopped → dismiss. Decoder
  missing or permission denied → the sheet says so and leaves the paste
  field focused (graceful degradation, never a dead end).
- Permission: Android `CAMERA` injected by the existing `build.sh`
  permission-injection pattern (same as INTERNET, P20/P21 lesson); runtime
  prompt fires on first `getUserMedia`. **No `gen/` edits by hand** — it is
  gitignored; the injection script is the record.
- QR source: the host's Jam Data QR (`paintQrSurface`) already encodes the
  canonical invite from A — the scanner consumes exactly that string.

### 4.2 B — tests & acceptance
- JS unit: a pure `extractInviteFromScan(text)` wrapper (validated via
  `parseInvite`) — canonical-only, garbage → null.
- **Decode round-trip (browser-free, runs in `npm test`):** build an
  RGBA buffer straight from the Rust `qr_symbol` matrix (flat
  `modules[r*size+c]`, quiet zone 4, no canvas needed) and assert `jsQR`
  returns the canonical invite **byte-identically** — the standing proof
  that decoder and renderer agree.
- Static: `jam-ui.test.mjs` asserts the Scan button + sheet ids exist, the
  scan path calls `room_join_uri` (same style as the join-form assertions),
  and the source never references `BarcodeDetector` (P38: it looks available
  and silently decodes nothing — a future "cleanup" must not reintroduce it).
- Live (on emulator): (a) scanner opens — real `getUserMedia` stream,
  frames flowing; (b) the scan pipeline consumes a synthetic frame built
  from `qr_symbol` output and **joins the room** through `room_join_uri`;
  (c) permission denied → toast + paste still works. Count goes into the
  live matrix. **Physical gap:** photons-through-a-lens can only be proven
  on a real phone (desktop shows the room QR → phone app scans it) —
  recorded in the §10 runbook, not claimable from this emulator's virtual
  camera, which cannot be aimed at our QR.
- **AC:** guest joins through the scan pipeline on the emulator (camera live
  + synthetic frame → join), decoder round-trip green in `npm test`, no npm
  dependency added, gates green; physical-camera scan = runbook item.

---

## 5. Sub-project C — "perfect sink" (±100 ms)

### 5.1 Why today is ±0.25–0.27 s
Frames arrive every **1000 ms** and carry the playhead *at send time*;
`expectedPositionMs` extrapolates from arrival, so staleness error is uniform
0–1000 ms (avg ~500) minus the correction the ±400 ms seek band allows —
exactly the observed band. No clock sync exists (and needs none on a LAN:
arrival-anchoring kills the clock offset; what's left is tick granularity +
transit).

### 5.2 Design (v1 — no protocol change, no new frames)
1. **Tick 1000 → 250 ms**, single source: export `HOST_TICK_MS = 250` from
   `room.js`; desktop (`social.js:38,317,418`) and mobile host/guest loops all
   import it. Staleness bound drops to ≤250 ms.
2. **Graduated correction** (pure function in `room.js`, shared by both
   surfaces — extends `syncDecision`):
   - `|drift| ≤ 40 ms` → do nothing (measurement noise),
   - `40 < |drift| ≤ 150 ms` → **rate nudge**: `playbackRate =
     clamp(1 − driftMs/2000, 0.95, 1.05)`, recomputed each tick; the guest
     glides back with zero audible seek,
   - `|drift| > 150 ms` (new `DRIFT_TOLERANCE_MS = 150`, was 400) → hard seek
     to expected, `playbackRate` reset to 1.0.
   - Resets to 1.0 on: seek applied, track change, pause, resume, `bye`.
3. **`room_report` cadence:** every tick where `|drift| > 40` or a seek was
   applied, else every 4th tick (~1/s) — keeps the wire light at 250 ms.
4. **Measurement gate:** after landing, run the live probes and record
   steady-state drift (p95/max over ≥60 s). **Only if p95 > 100 ms** → v2
   (separate task, designed then): `ping`/`pong` frames for one-way transit
   compensation (`ROOM.md §3D` frame contract change — versioned, documented).
   Buffer startup delay is not drift; steady-state only.

### 5.3 C — tests & acceptance
- JS unit: `syncDecision` band table (40/150 edges, sign handling),
  `nudgeRate()` clamp + reset rules; `expectedPositionMs` unchanged behavior.
- Static: surfaces import `HOST_TICK_MS` from `room.js` (no local `= 1000`
  left: grep `social.js|jam.js` for `HOST_TICK_MS = 1000` → 0 hits).
- Live: `live-desktop` (drift fields), `live-reverse-pair`, `live-lan-join`
  re-run; record p95/max drift in the run log + `listen-together.md` §8 table.
- **AC:** live steady-state **p95 |drift| ≤ 100 ms, max ≤ 250 ms** across the
  probes; guests in steady state never seek more than once per 5 s (no
  stutter); gates green. Failure to hit target with the documented evidence →
  v2 ping task, not silent acceptance.

---

## 6. Sub-project D — transport parity + profile names

### 6.1 Profile names
- Add a **Display name** row to desktop Settings and the mobile Settings
  screen: writes `localStorage["tm-username"]` (trimmed, `sanitizeRoomName`
  cap 24, empty allowed → "Host"/"Guest" fallback). Both `roomName()`
  functions already read it — **no join-path change**; presence/member lists
  already render `name`.
- Verify both surfaces actually paint member names (desktop member row,
  `jam.js:550` area) — fix paint if the field is dropped anywhere.

### 6.2 Transport parity
- Matrix: **{pause, resume, prev, next, seek} × {desktop-host→mobile-guest,
  mobile-host→desktop-guest} = 10 cells.**
- Requirement: every action broadcasts **immediately** (not via the tick):
  map the existing points (`social.js:302/319/432/736/744`,
  `jam.js:267/364/375/859`) against each action; add the missing trigger(s)
  where an action rides only the 250 ms tick (suspect: prev/next — they rely
  on the tick today).
- Guest side: apply track change → seek → play state in one frame (existing
  `playback` frame already carries `trackId/title/artist/positionMs/playing`
  — no protocol change expected).

### 6.3 D — tests & acceptance
- JS unit: broadcast-trigger registry test (pure list: action → broadcast fn
  called) if extractable; otherwise static contract test in
  `jam-ui`/`social-ui` asserting each transport handler contains a
  `broadcastPlayback()` call.
- Live: extend `live-reverse-pair.mjs` (already the mobile-host lane) and
  `live-desktop.mjs` (desktop-host lane) with the 5 transport actions; assert
  guest observes each within 1 tick (≤250 ms + margin).
- **AC:** all 10 cells green; Display name set on host + guest appears in both
  rosters (probe reads the painted member rows); gates green.

---

## 7. Sub-project E — mobile app logo

- **Discovery (first step):** `app/src-tauri/icons/` + `docs/branding/trance-music-guide.md`
  — the 07h rebrand may already have a TRANCE-branded `icon.png`.
- Generate the full set with the official tool (`npx tauri icon <source>`)
  — it emits Windows/macOS/Linux **and** Android launcher mipmaps when the
  platform config is present; if v2's `tauri icon` skips Android here, copy
  into the `gen/android` res via the same scripted path as permission
  injection (`gen/` is gitignored — the script, not the files, is the record).
- If **no** branded source exists: the recommended minimal fallback is a
  generated wordmark ("TM" monogram on the brand gradient per the branding
  guide) produced as a 1024×1024 PNG by a one-off script in
  `temporary/` (never committed), then `tauri icon` over it.
- Verify: emulator launcher shows the new icon (screenshot), desktop exe icon
  renders (screenshot), app still builds/installs.
- **AC:** Android launcher icon visibly branded; no hand-edits under `gen/`;
  gates green.

---

## 8. Sub-project F — multi-device scale

### 8.1 Design
- **Raise `MAX_GUESTS` 8 → 16** (`room.rs:39`; `ninth_guest_is_refused`
  auto-adapts — rename to match). Server fan-out at a 250 ms tick × 16 = 64
  frames/s — trivial on LAN; the test proves no loss, not the arithmetic.
- **Rust level:** extend the duplex harness: 15 guests join one core, one
  `playback` + one `chat` broadcast reaches all 15; refusals start at 17.
- **Live level — `app/tests/live-scale.mjs` (new):** desktop host + emulator
  guest (realism) + a ladder of **raw node ws clients (N = 4, 8, 16)**
  (scale — cheap, reproducible on this machine; a second AVD costs ~2 GB disk
  and duplicates what node clients already prove about the server, so the
  recommended mix is 1 emulator + node clients, not a second emulator).
  For each N, run ≥60 s: all join, chat broadcast reaches all, every guest's
  reported drift recorded → print max/p95 per N; host process RSS/CPU noted.
- **AC:** N=16 joins all succeed (17th refused with the capacity message);
  p95 |drift| ≤ 150 ms for every lane at N=16 (slightly looser than C's solo
  target — stated explicitly); zero disconnects in 60 s; report appended to
  `listen-together.md` §10.

---

## 9. Cross-cutting: gates, docs order, task sequence

**Gates (every task, in scope):** `npm test` (≥250+new, 0 fail) ·
`npm run lint` · `cargo fmt --check` · `cargo clippy --all-targets -- -D
warnings` · `OP_OFFLINE=1 cargo test --lib`. Live gates only where the task
says (they need the built app + emulator).

**Docs order (rule 2):** this doc (done) → `listen-together.md` §6 (new
command + `invite` field + 250 ms tick note as they land) / §12 (invite copy)
/ §8 (drift numbers) + `ROOM.MD` contract notes + `CHANGELOG.md` → code.
Each sub-project updates its own doc sections **before** its first code task.

**Task sequence (each = test cycle + local commit):**

- **T0** this master doc ✅ · **T1** protocol docs (§6/§12/ROOM.MD/CHANGELOG)
- **A1** Rust `invite_uri`/`parse_invite` (TDD) → **A2** `invite` fields +
  `room_join_uri` + `begin_join` extraction (TDD) → **A3** `room.js` state/
  `inviteText`/`parseInvite` (TDD) → **A4** desktop sheet + static tests →
  **A5** mobile sheet + static tests → **A6** probe updates + live runs
- **B1** camera spike (verdict → docs) → **B2** scanner UI (or documented
  fallback) + tests + live check
- **C1** move tick/tolerance constants to `room.js` (grep gate) → **C2**
  graduated correction (TDD pure fn) → **C3** wire both surfaces → **C4**
  live drift measurement + §8 record
- **D1** Display-name setting rows (both surfaces) + paint verification →
  **D2** transport matrix audit + missing broadcasts (tests) → **D3** live
  10-cell run
- **E1** icon discovery/generation + regen + screenshots
- **F1** cap 16 + Rust fan-out tests → **F2** `live-scale.mjs` + ladder run +
  §10 record

**Review Focus (inputs most likely to bite):**
1. **Legacy invites in the wild** (old `ws://ip · CODE` lines) — Rust + JS
   legacy-parse tests in A1/A3 keep them green.
2. **Bad URI latching `Mode::Guest`** (D2/P32 lesson) — A2's "Err ⇒ still
   Idle, room_open works after" test.
3. **The D5/P32 guard regressing** in the `begin_join` extraction — A2 pins
   the exact refusal message.
4. **Rate nudge fighting seeks/track changes** — C2 reset-rule tests; a stuck
   `playbackRate ≠ 1` is audible corruption.
5. **Removed DOM ids breaking static tests/probes** — A4/A5/A6 swap the id and
   command lists; a grep gate (`room-join-addr|jam-join-addr` → 0 hits in
   `app/`) closes it.
6. **Camera API absent in WebView** — B1 spike before any UI work; fallback
   documented, never a dead end.
7. **`tm-username` written but never displayed** — D1 verifies painted roster
   rows, not just the storage write.

**Non-goals:** OS tap-to-open (intent filters / deep-link plugin), vendored QR
decoder, HTTPS short links, protocol v2 ping (only after C's measurement
gate), host migration / shared queue (M2, unchanged).
