# Jam unified invite URI — design spec (sub-project A)

**Status:** FOLDED IN — superseded by `docs/jam-upgrade.md` §3 (single master
doc for all seven requests, 2026-10-08). Kept for history; the master doc
governs. · **Date:** 2026-10-08
**Series:** this is sub-project **A** of the Jam upgrade series (A unified link →
B scan-to-join → C sync upgrade → D parity + profile names → E logo → F
multi-device scale), decomposed from the user's 2026-10-08 request.

**User request (verbatim, relevant part):** *"IN BOTH MOBILE AND DESKTOP
APPLICATION JUST PROVIDE SINGLE LINK TO JOIN NOT LIKE LINK SEPARATE , CODE
SEPARATE IT SHOULD BE UNIFIED IN BOTH UI AND BACKEND."*

## 1. Problem

Today the invite is an informal composite — `ws://192.168.1.5:8787 · CODE` —
displayed as link-and-code, parsed by ad-hoc JS (`room.js:parseInvite`), and
**consumed by the backend as two separate values** (`room_join { addr, code }`,
`room.rs`). The desktop join sheet exposes two input fields; mobile has one.
There is no single canonical artifact that UI, clipboard, QR, and backend all
agree on.

## 2. Decisions locked (Q&A)

| Question | Decision |
|---|---|
| How far does the link go? | **Copy-paste + in-app scan only.** No OS integration (no Android intent-filter, no desktop protocol registration, no deep-link plugin). Tap-to-open is a possible later follow-up that requires **no string migration**. |
| Canonical format? | **A1 custom scheme:** `trancemusic://join?host=<host>&port=<port>&code=<CODE>` |

## 3. Design

### 3.1 Contract

- Canonical invite string: `trancemusic://join?host=192.168.1.5&port=8787&code=ABCD2345`
  - `host` — an IPv4 literal as detected by `lan_urls()` (parser tolerates
    hostnames for future-proofing).
  - `port` — u16, decimal.
  - `code` — the existing room code, normalized to upper case.
- Rust owns both directions; the frontend never string-builds an invite:
  - `invite_uri(host, port, code) -> String`
  - `parse_invite(raw) -> Result<(String, u16, String), InviteError>` accepts
    **the canonical URI** and **the legacy line** `ws://ip:port · CODE`.
- Unknown query parameters are ignored (forward compatibility). Missing/empty
  `code` or unparseable `port` is an error, never a guess.

### 3.2 Backend (`app/src-tauri/src/room.rs`)

- `room_open` and `room_info` gain an additive **`invite`** field carrying the
  canonical string. `urls` and `code` are **not** removed or repurposed
  (D-12 in ROOM.MD and §6 in `listen-together.md` stay truthful; `invite`
  becomes the primary, the others remain low-level data).
- New command **`room_join_uri { uri, name }`**: `parse_invite` → the existing
  join core → identical handshake/frames as today.
- `room_join { addr, code, name }` remains as a **legacy wrapper**: it
  constructs the canonical URI and delegates to the same core (one code path).
  Documented as legacy; existing callers (probes, old links) keep working.
- The host-side invite list continues to come from `lan_urls(port)`; the URI is
  built from its first entry (or any entry that parses — implementation picks
  the first, matching what the UI displays today).

### 3.3 Frontend (shared + both surfaces)

- `room.js` helpers become backend-fed:
  - `inviteText(state)` returns `state.invite` when present, else falls back to
    the legacy composite string (defensive parity for stale snapshots).
  - `parseInvite(raw)` accepts the canonical URI first, legacy line second;
    returns `null` otherwise.
- **Desktop (`social.js` + `index.html`):** the join card collapses to the
  mobile design — one input `#room-join-invite` ("Paste the invite link"),
  Enter-to-join, status line `#room-join-note` unchanged. `#room-join-addr` and
  `#room-join-code` are removed (DOM, wiring at `social.js:564-565, 896`).
  Join path: `parseInvite` → `invoke("room_join_uri", { uri, name })`.
- **Mobile (`jam.js`):** existing single-field sheet switches its join call to
  `room_join_uri` and its placeholder to the canonical example. Mode unchanged.
- **Display surfaces** (desktop invite row, mobile Jam Data `jamInviteUri`,
  Copy button, QR via `paintQrSurface`) all carry the identical canonical
  string — the QR repaint guard already keys on invite change.
- The room **code** stays visible in Jam Data as server truth/fallback, but is
  no longer a second artifact to copy.

### 3.4 Errors

- Unrecognized paste → inline `That doesn't look like an invite link` (no
  silent retry, no partial fill).
- Wrong code / full room / unreachable host → unchanged server-reason paths.

### 3.5 Non-goals (explicit)

- OS tap-to-open (intent filter / protocol registration / deep-link plugin).
- The camera scanner (sub-project B) — it will consume this URI, but this
  sub-project only delivers the string contract.
- HTTPS short links (needs a server; app is LAN-only).
- Raising `MAX_GUESTS`, sync changes, profile names (C/D), logo (E), scale (F).

## 4. Testing

| Layer | Cases |
|---|---|
| Rust unit | `parse_invite(invite_uri(...))` round-trip; legacy line parse; rejects (bad scheme, missing code, non-numeric port, empty host); `room_join_uri` happy path via existing duplex harness |
| JS unit | `parseInvite` canonical / legacy / garbage; `inviteText` prefers `state.invite`, falls back |
| Live | all 4 probes updated to join **via the canonical link** (public contract): `live-desktop` 32/0, `live-android-emulator` 28/0, `live-reverse-pair` 19/0, `live-lan-join` all-pass |
| Gates | `npm test`, `npm run lint`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `OP_OFFLINE=1 cargo test --lib` |

## 5. Docs-first order

1. This spec (committed before any code).
2. Implementation plan (separate document).
3. `docs/listen-together.md` §6 command reference (`room_join_uri`, `invite`
   field) + §12 invite note; `ROOM.MD` D-12 note (additive field).
4. `CHANGELOG.md` Unreleased entry.
5. Code.

## 6. Acceptance criteria

1. `room_open`/`room_info` JSON contains `invite` = canonical URI; `urls`/`code`
   unchanged.
2. Rust round-trip + legacy + reject tests green.
3. `room_join_uri` joins from one pasted string; `room_join` still works.
4. Desktop join sheet has exactly one input field; mobile matches.
5. Displayed text, clipboard content, and QR payload are byte-identical on both
   surfaces and equal the backend `invite`.
6. All four live probes green using the canonical link.
7. Full gates green; docs updated first.

## 7. Risks / traps

- **Probe contract churn:** the four live probes call `room_join {addr, code}`.
  They are updated to `room_join_uri` so they exercise the public contract;
  the legacy path stays covered by Rust unit tests.
- **Additive-only backend change:** do not rename/remove `urls`/`code` —
  external docs and `live-desktop.mjs` read them today.
- **No manifest work:** this sub-project must not touch `gen/` or Android
  config (that belongs to B/E scope decisions later).
