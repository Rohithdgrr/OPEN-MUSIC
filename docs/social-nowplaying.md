# Social Now Playing — Listen Together / Jam Mode (UI)

Status: **Phases 1–5 landed.** §3b below is the retired phase-4a history: the
Jam pane is now driven by the **in-app Rust room server** (`room_*` commands +
`room://msg` frames, spec `docs/listen-together.md` §6/§13), not by a local
metroserver. `app/src/social.js` no longer imports `sidecar.js`; both files stay
committed and tested as the dormant interop path. Source mockup:
`design/screens/social nowplaying screen/` (`DESIGN.md`, `code.html`, `screen.png`).

## 1. Goal

Port the Tailwind-CDN mockup into the desktop Now Playing stage
(`#now-playing-stage`) as hand-written vanilla CSS — the desktop frontend has
**no bundler and no Tailwind build** (`app/tests/tailwind.test.mjs` asserts
`index.html` links only `styles.css`). Both themes must work: light rules
first, then re-stated under paired `.dark …` / `html.dark …` selectors.

Explicitly excluded from the port: **SongDNA** and **Concerts Near You**.

## 2. Scope

| Phase | Work | State |
|---|---|---|
| 0 | this doc + pointer in `docs/ui.md` | done |
| 1 | `styles.css` → `PART 5: SOCIAL NOW PLAYING` (~1,970 lines) | done |
| 2 | `index.html` markup (header switch, artwork overlay, QR, reactions, skip vote, 4-tab deck, chat + jam panes) | done |
| 3 | `app/src/social.js` — local state: mode toggle, tab fallback, reactions, chat echo, skip vote, queue lock/add | done |
| 4a | `metroproto.js` + `sidecar.js` — health probe, WS handshake, create room (`docs/sidecar.md`) | **done, not verified against a live server** (no Go toolchain here) |
| 4b | join by code, approval, presence from `RoomState.users` | next session |

## 3a. Phase 3 behaviors (all local, `app/src/social.js`)

| Control | Behavior | Honest fallback |
|---|---|---|
| `#btn-mode-social` | adds `body.soc-social`, toasts the room size, `diag("social mode")` | toast states the sidecar is not connected |
| `#btn-mode-solo` / `#btn-leave-room` | removes the class; if the deck was on Chat/Jam it clicks back to Lyrics (those tabs are social-only), resets votes, closes QR, hides grace | — |
| `#btn-qr` / `#btn-qr-close` / `Esc` | toggles `#qr-overlay` and paints the symbol from the current room code | shows the empty state; Copy enables only once a real code exists. The trigger is **mode-independent** (no `soc-social-only`): Solo users must see it too, otherwise the button is invisible on first boot and the surface is unreachable |
| `.soc-reaction-pill` | `+1/-1` on your own pill, `active` state, note flips to "Your reactions — counts stay local" | counts reset to `0` on a `#track-title-heading` change (`MutationObserver`) |
| `#btn-skip-vote` | `votes/1`, `is-done`; at a majority it calls `step(1)` after 200 ms and resets | denominator comes from `MEMBERS = 1` |
| pause (social mode) | shows `#soc-grace` counting `3s → 0`, then hides | pill only appears while `body.soc-social` |
| `#btn-chat-send` / `Enter` | appends a `.soc-chat-msg.mine` bubble via `createElement` + **`textContent`**, stamps the real clock, hides `#chat-empty`, scrolls to bottom | no fake peers, no typing indicator shown |
| `#btn-chat-quote` | inserts the active (or first) lyric line as a `“…”` quote | toasts "No lyric line to quote yet" |
| `#btn-lock-queue` | badge `UNLOCKED↔LOCKED` (+ `.is-locked`), icon `lock_open↔lock`, disables the append row | local lock only |
| `#btn-submit-song` / `Enter` | matches the text against **play history, favourites and the vault**, then `enqueue()`; duplicates are reported as already-queued | no match → "No local match … needs the local sidecar" |
| `#btn-undo-crdt` | rendered `disabled` | title: queue history arrives with the sidecar |
| `#btn-copy-invite`, `#btn-qr-copy` | copy the **real** room code to the clipboard | `disabled` until `room_created` supplies one |
| `#auto-level-toggle` | untouched | documented as inert for a room of one |

`MEMBERS = 1` is the single source for `#np-room-members`, `#jam-member-pill`,
`#chat-online-count` and the vote denominator, so no view can drift into
claiming an audience that is not there.

Guard rails: `app/tests/social-ui.test.mjs` asserts `social.js` contains **no
network API** (`fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest`/`sendBeacon`)
and never assigns `innerHTML`.

## 3b. Phase 4a behaviors (`app/src/sidecar.js`) — historic, no longer wired

> Superseded by `docs/listen-together.md` §13. The table below still describes
> what `sidecar.js` does when something drives it (its own tests do), but the
> Jam pane it used to feed — `#jam-sidecar`, `#jam-sidecar-note`, `#btn-open-room`,
> the room-code slots — is now fed by the room server instead. `#jam-ua` was
> removed from the markup with it (see §13.1 of the other doc), the tile is
> labelled **Room server** (it names the component it reports), and its static
> default is `Not in a room` — the exact string `social.js:paintRoom()` writes
> for `role === "idle"`, so the markup never shows a state JS will contradict.

| Trigger | Behavior | Honest fallback |
|---|---|---|
| entering Social | `GET http://127.0.0.1:<port>/health` (1.5 s), then `ws://…/ws` + `client_capabilities` | no answer → `#jam-sidecar` stays `Not connected` |
| `server_capabilities` | `#jam-sidecar` → `Connected (v…)`, keepalive `ping` every 15 s | shown only after a decoded frame; no `server_capabilities` within **5 s** (`handshake: 5000`) → `handshake_timeout` carrying the app's own wording ("No server_capabilities before the timeout."), never a guess |
| `#btn-open-room` (enabled only while connected) | sends `create_room`; `room_created` fills `soc-room-code` + `qr-room-code` + `jam-room-id` with the server's 8-char code, toasts it, and re-paints the QR symbol | refused → the server's `code`/`message` verbatim, all code slots stay `NO ROOM` |
| ~~`#jam-ua`~~ | removed with the sidecar (see the note above §3b and `docs/listen-together.md` §13.1) | — |
| `#btn-copy-invite` / `#btn-qr-copy` | copy the room code | `disabled` until a code exists |
| leaving Social | `leave_room` (if any) + socket close; all slots reset to `NO ROOM` | — |

Guard rail: `app/tests/sidecar.test.mjs` drives the state machine with a
scripted socket and asserts a status never appears before the frame that
proves it.

### 3b-i. The room-code slot table (one source, one fallback)

Every room code the UI can show lives in exactly three slots, and they are
painted from a **single** list in `social.js` (`ROOM_SLOTS`), never
individually:

| slot id | where it shows |
|---|---|
| `soc-room-code` | header room chip |
| `qr-room-code` | QR sheet, under the symbol |
| `jam-room-id` | Jam panel |

Invariants, all non-negotiable:

- the list and the markup must agree — a slot id in `ROOM_SLOTS` with no
  matching `id="…"` in `index.html` is a silent dead write;
- the fallback is the literal string `NO ROOM` (`code || "NO ROOM"`), so a
  refusal, a disconnect or a leave all blank **every** slot together;
- no slot may ever hold a placeholder code, PIN or preview value.

`app/tests/social-ui.test.mjs` asserts the table both ways (list → markup and
markup → starts `NO ROOM`), so renaming a slot or dropping one from the list
fails the gate instead of shipping a dead write.

## 3. Visibility contract (driven by `social.js`)

```css
body:not(.soc-social) .soc-social-only { display: none !important; }
body.soc-social       .soc-solo-only   { display: none !important; }
```

- default is **Solo**; `social.js` adds/removes `body.soc-social`
- `.soc-social-only` = room chrome (chat/jam tabs, reactions, skip vote,
  QR button, lock/undo, append-to-room row, member counts)
- `.soc-solo-only` = solo chrome (`#btn-next` label, the "Activate Social"
  prompt, stereo/bit-perfect center readout)

## 4. Class inventory

| Area | Classes |
|---|---|
| Header | `.soc-header-actions`, `.soc-mode-switch`, `.soc-mode-btn(.active)`, `.soc-live-dot`, `.soc-room-chip`, `.soc-avatar` |
| Artwork overlay | `.np-art-overlay(-top/-meta)`, `.np-art-title`, `.np-art-artist`, `.np-art-actions`, `.np-art-action`, `.np-art-info-row/-group/-item/-label/-value/-sep`, `.np-art-info-item--wide`, `.np-art-select` |

`.np-art-trackline` was the **only** name for the eyebrow row. The markup
shipped it as `class="np-trackline"`, which no rule matched — the flex row
silently never applied. The class in `index.html` was renamed to match the
documented inventory, then the whole row (`.np-art-trackline`,
`.np-art-eyebrow`, `id="np-trackline"`) was removed on request — §6d.
| Room QR | `.np-qr-btn`, `.np-qr-overlay(.hidden)`, `.np-qr-card`, `.np-qr-head(-label)`, `.np-qr-count`, `.np-qr-frame`, `.np-qr-canvas`, `.np-qr-empty(.hidden)`, `.np-qr-code`, `.np-qr-note`, `.np-qr-actions`, `.np-qr-copy`, `.np-qr-close` |
| Reactions | `.soc-reaction-bar`, `.soc-reaction-pill(.active)`, `.soc-reaction-emoji`, `.soc-reaction-count`, `.soc-reaction-note` |
| ~~Transport~~ | Removed 2026-10-06: the whole `.np-transport-card` block (`#timeline-bar`, `#sync-clock-label`, `#soc-grace`, `#btn-skip-vote`, `#volume-track`) is gone from the desktop Now Playing view. Only the bottom mini-player drives playback and volume now. The skip-vote and grace-period surfaces left with the card; `jam-vote-ratio` still paints the (now inert) tally. |
| Collab queue | `.soc-qhead(-left/-actions)`, `.soc-qhead-title`, `.soc-badge(.is-locked)`, `.soc-qbtn(.is-on)`, `.soc-qrow(.is-now)`, `.soc-qindex`, `.soc-drag`, `.soc-qthumb`, `.soc-qtext`, `.soc-qtitle`, `.soc-now-badge`, `.soc-qbio`, `.soc-added-by`, `.soc-qrow-side`, `.soc-qdur`, `.soc-qremove`, `.soc-qappend`, `.soc-qinput`, `.soc-qappend-btn` |
| Chat | `.soc-pane-head(-left/-right)`, `.soc-pane-title`, `.soc-stat-chip(.is-live)`, `.soc-chat-list`, `.soc-chat-msg(.mine)`, `.soc-chat-avatar`, `.soc-chat-bubble`, `.soc-chat-meta`, `.soc-chat-user`, `.soc-tag-host`, `.soc-chat-time`, `.soc-chat-text`, `.soc-chat-reacts`, `.soc-chat-react`, `.soc-typing` (+ `@keyframes soc-blink`), `.soc-chat-compose`, `.soc-emoji-btn`, `.soc-chat-input`, `.soc-chat-send`, `.soc-chat-quote`, `.soc-empty` |
| Jam pane | `.soc-section-label`, `.soc-tiles`, `.soc-tile(-row/-label/-value/-note)`, `.soc-tile-value.is-ok/.is-off`, `.soc-mode-tag`, `.soc-members`, `.soc-member(-avatar/-name/-role)`, `.soc-btn(-solid/-danger)`, `.soc-qappend` |

Removed classes: `.np-qr-*` (whole family), `.np-stream-pill`, `.np-pulse-dot`,
`.soc-solo-prompt(-text)` — see §6b. `@keyframes np-pulse` **stays**: it is not
part of `.np-stream-pill`, and `.soc-live-dot` still animates with it.

`app/tests/social-ui.test.mjs` asserts every `soc-`/`np-art-`/`np-qr-` class
used in `index.html` has a rule in `styles.css` (and vice versa).

## 5. Element id contract (Phase 3 must not rename)

Header: `btn-mode-solo` `btn-mode-social` `soc-room-chip` `soc-room-code`
`soc-avatar`
Artwork overlay: `track-title-heading`
`track-artist-heading` `track-fav-btn` `fav-icon` `np-download-btn`
`np-add-btn` `np-share-btn` `np-album` `np-artist-tile` `np-length`
`np-format` `spinning-vinyl-icon` `np-sleep` `np-speed` `np-room-members`
Room QR: `btn-qr` `qr-overlay` `qr-canvas` `np-qr-empty` `qr-room-code`
`qr-members-count` `btn-qr-copy` `btn-qr-close`
Reactions: `reaction-bar` `reaction-note` (pills are `data-emoji`)
Transport: ~~`sync-clock-label` `soc-grace` `grace-timer` `btn-skip-vote`
`skip-vote-label`~~ — removed 2026-10-06 with the whole transport card
(plus existing `btn-next`, now `.soc-solo-only`)
Deck: `tab-btn-lyrics` `tab-btn-queue` `tab-btn-chat` `tab-btn-jam`
`jam-member-pill`
Queue pane: `queue-lock-badge` `btn-undo-crdt` `btn-lock-queue`
`input-add-song` `btn-submit-song` (plus the pre-existing queue ids)
Chat pane: `chat-messages-container` `chat-empty` `chat-input`
`btn-chat-send` `btn-chat-quote` `chat-typing` `chat-online-count`
`chat-rate-note`
Jam pane: `jam-room-id` `jam-mode-label` `jam-session-mode` `jam-sync-value`
`jam-vote-ratio` `jam-sidecar` `jam-sidecar-note`
(`jam-ua` was removed in this milestone — the Jam pane no longer prints a UA,
because the in-app room server has no allow-list; `docs/listen-together.md` §13.1)
Join form (C-4): `room-join-addr` `room-join-code` `btn-room-join` `room-join-note`
`auto-level-toggle` `jam-members` `jam-members-note` `btn-open-room`
`btn-copy-invite` `btn-leave-room`

Room-code slots (`soc-room-code` `qr-room-code` `jam-room-id`) all read
`NO ROOM` until a `room_created` frame supplies a real one — Phase 4a,
`app/src/sidecar.js` + `docs/sidecar.md` §5.

## 6. Truthfulness rules (non-negotiable)

The app never fakes state (see `docs/ui.md` §16):

- member count starts at **`1 (you)`**, reaction counts at **`0`**
- Jam pane shows **`Not connected`** for the sidecar until a real
  `127.0.0.1` process answers; the invite-copy button stays disabled
- chat is local-only: messages are echoed by this client, never presented
  as someone else's; typing indicator is hidden until a real peer exists
- no SongDNA / concert tiles / fabricated "N listeners" decoration

## 6a. Artwork overlay readability pass

The metadata band sat on the cover as an opaque slab (`rgba(9,9,11,0.72)` +
18px blur). It hid a third of the artwork and forced the telemetry labels to
truncate at ~700px card width. Changes:

| Concern | Rule | Why |
|---|---|---|
| Cover stays visible | the glass is a **vertical gradient** on `.np-art-overlay::before` — opaque at the bottom edge → fully transparent by ~65% of the band height | the band has to be readable at the baseline but the artwork must read as artwork above it |
| Glass on a pseudo-element, not the band | `::before` carries the gradient + `backdrop-filter` + `mask-image`; `.np-art-overlay` itself is `background: transparent` | `backdrop-filter` paints over the element's whole box, so blurring on the band shows a hard top edge even where the gradient is transparent. Masking the band fixes that edge but fades the **eyebrow text** with it. Splitting the layer lets the mask touch only the glass. `z-index: -1` keeps it behind the flex children |
| No hard seam | the gradient reaches `rgba(0,0,0,0)` before the band's top edge; the `border-top` hairline is gone | a hairline across the cover reads as a UI box sitting on a photo |
| Buttons shrink | `.np-art-action` 34px → 28px, icon 20px → 17px, gap 6px → 4px | four 34px squares out-shouted the 22px title |
| Text survives a bright cover | title / artist / eyebrow gained `text-shadow` | the band is transparent now, so a pale cover would otherwise eat the metadata |
| Telemetry stops truncating | `.np-art-info-item` gets `min-width: 0` + `flex: 0 1 auto`; ALBUM/ARTIST carry `.np-art-info-item--wide` (`flex: 1 1 9rem`) so they claim the slack and LENGTH/ROOM/FORMAT keep full glyphs | `ALBUM Pushpa - The Ri…` / `LENGTH 3:…` / `320kb…` were all cut mid-word |
| Selects stop shouting | `.np-art-select` gets an 11px chevron, 6px radius, and drops the global `select` padding/height via `!important` | the universal `select` rule (`padding: .45rem 2.2rem`, 12.5px, opaque white) was overriding the overlay's transparent select |
| Both themes | the `.dark` / `html.dark` re-state targets `.np-art-overlay::before` | a flat `background` on `.np-art-overlay` would paint over the pseudo-element's gradient and re-hide the cover |

Constraints: ids in §5 unchanged, `select` element behaviour untouched (still
native dropdowns, still keyboard-navigable), no Tailwind.

## 6b. Removed artwork + column chrome (on request)

Three floating pieces of chrome were pulled so the album art and the metadata
band are the only things on the Now Playing stage:

| Removed | Was | Why it went |
|---|---|---|
| `#np-badge` + `.np-stream-pill` / `.np-pulse-dot` | the top-left "RESOLVING • 24-BIT / 96kHz" bitstream pill over the artwork | duplicated the footer bar's own `#bar-badge`, which carries the same honest `FULL SONG` / `PREVIEW` / `UNREACHABLE` state from the measured `RangeStatus` (`docs/ui.md` §16) |
| `#solo-prompt` / `#btn-activate-social` | the "Solo session → Activate Social" box at the top of the right column | Social is still one click away in the header `Solo`/`Social` switch, which is the primary control |

The Room QR trigger was removed in the same pass and **restored** in §6c.

Cascade of the removal, all of it removed rather than left dangling:

- `social.js`: the `#btn-activate-social` listener.
- `styles.css`: `.np-stream-pill`, `.np-pulse-dot` and its two dark-theme
  re-states, plus `.soc-solo-prompt*` and its dark re-states.
- `@keyframes np-pulse` was deliberately **kept**: it is not part of the pill,
  and `.soc-live-dot` (mode switch, room chip, jam header) still animates with
  it. `app/tests/social-ui.test.mjs` asserts both halves of that.

`app/tests/social-ui.test.mjs` has a `the removed artwork chrome stays removed`
regression test: restoring any of this has to be a deliberate act, not a stray
block pasted back in.

## 6c. The Room QR is a real symbol (Rust)

The QR surface used to draw a Material Symbols `qr_code_2` glyph. That is a
*picture of* a QR code: nothing could scan it, and the markup carried a comment
admitting it was "not scannable until the sidecar lands". Restored, but
actually scannable.

| Layer | File | Job |
|---|---|---|
| Encode | `app/src-tauri/src/qr.rs` | `qr_symbol` command. Byte mode, EC level **M**, versions 1-10. Returns `{ size, modules, version }`, flat row-major `0/1`. |
| Draw | `app/src/qrview.js` | Rasterises the matrix onto the canvas at device resolution, with the spec's 4-module quiet zone and whole-pixel cell rounding. |
| Wire | `app/src/social.js` | `paintQrSurface(inviteText(room) || room.code)` on open and on every `room_created` — the invite line, so the symbol agrees with `#btn-copy-invite`. |

Why Rust owns the encoding: the symbol is derived from the sidecar's room code,
and every other room fact already comes from Rust. Encoding in the same place
means the invite cannot disagree with the code it encodes, and it puts the
encoder under `cargo test` instead of leaving it to eyeball.

Why not a JS or CDN library: the desktop frontend has no bundler
(`app/tests/tailwind.test.mjs` asserts `index.html` links only `styles.css`),
and the app is offline-first by design — `art.js` keeps `logo.png` local for
exactly this reason. A CDN QR library would be both a supply-chain risk and a
hard network dependency on a localhost-only feature.

**Verification** — `cargo test --lib qr::`, 12 tests:
- structural: square/binary matrix, three finder patterns, timing alternation,
  the mandatory dark module, distinct payloads → distinct symbols
- a room code fits **version 1** (21×21) at level M, which is the easiest
  possible thing for a phone camera to focus on
- **round trip**: the symbol is decoded back with `rqrr` (an independent
  decoder, dev-dependency) and the payload compared — across versions 1-10 and
  for a UTF-8 payload. This is the only check that proves a camera would scan
  it; everything else is only evidence that it looks right.
- oversized input **errors instead of truncating** — a truncated invite would
  encode the wrong room silently.

**Honest empty state.** With no room code there is nothing truthful to encode,
so `#np-qr-empty` covers the plate and `#np-qr-note` says the code comes from
the room server. Rendering a scannable-looking plate with nothing scannable
inside it is the exact lie the glyph told. If encoding itself fails, the note
reports the error rather than leaving a blank white plate.

**What the symbol carries: the invite line, not a deep link.** It encodes
`inviteText(state)` — `ws://<host>:<port> · <CODE>` while hosting, or the bare
code until the address is known. It used to encode the code alone, which left a
guest who scanned it still hunting for the host's address by hand; the invite
line is the same string `#btn-copy-invite` already hands out, so the two
surfaces cannot disagree.

This is deliberately **not** a `trancemusic://join/...` deep link. No such
scheme is registered anywhere, and inventing one would be a fabricated
integration — a scan currently yields text a person can paste, which is exactly
what the address+code pair is good for.

Size check: the longest realistic payload is ~36 bytes
(`ws://255.255.255.255:65535 · XXXXXXXX`), well inside the encoder's version
1–10 range at EC level M.

`app/tests/social-ui.test.mjs` guards the wiring (IPC path, the `!code` branch,
the empty state, no CDN) and `styles.css` carries every `.np-qr-*` class.

## 6d. Metadata card: transparent, no eyebrow row, no quality tag (on request)

Three changes to the artwork overlay, all on request 2026-10-10:

| Change | Was | Now |
|---|---|---|
| Background | `.np-art-overlay::before` — dark gradient + `backdrop-filter: blur(10px) saturate(130%)` + `mask-image` (the §6a glass, re-stated for `.dark`/`html.dark`) | **transparent** — the pseudo-element is deleted in both themes; `.np-art-overlay` itself was already `background: transparent`, so the artwork shows through the metadata card sharply, unblurred |
| Eyebrow row | `#np-trackline` / `.np-art-trackline` / `.np-art-eyebrow` — `TRACK 03 • STEREO DIRECT`, and the `playback.js` fill that composed it | **removed** — markup, both CSS rules, and the `npText` fill |
| Quality tag | `#np-quality` / `.np-art-quality` pill beside the eyebrow | **removed** — markup, the base rule, the `.dark #now-playing-stage` re-state, and the `player.js` `npText` fill are all gone |

The metadata card now starts at the title: artwork → title → artist →
telemetry strip. The telemetry strip keeps `#np-format` (the vinyl icon +
quality), which stays live from the resolve's measured status.

Why it is safe:

- Legibility was never carried by the glass: title / artist already have
  `text-shadow` (§6a), and the telemetry strip keeps its `border-top`
  hairline.
- `npText` (`util.js`) is a no-op on a missing id, but the dead calls
  were removed anyway so nothing writes to a ghost element.
- `index` (the queue position) is still used for prefetch and for the
  `TRACK nn` numbering elsewhere — only the rendered eyebrow is gone.
- The **mobile** Now Playing keeps its own eyebrow (`#np-trackline`,
  `#np-qchip`) — this change is desktop-only.

The §6a table stays as the historical record of why the glass was
split onto a pseudo-element; those rules were deleted, not rewritten.
Regression guard: `app/tests/social-ui.test.mjs` asserts `np-quality`
and `np-trackline` are absent from `index.html` (§6b removed-chrome
test) and that no `.np-art-quality` / `.np-art-eyebrow` rule survives in
`styles.css`.

## 6e. Metadata card legibility: tighter padding + scrim, still no blur (on request)

Follow-up 2026-10-10: with the glass gone, white metadata washed out on
bright covers (white title over a pale poster) and the card's padding
(`1.35rem 1rem 0.9rem`) ate artwork for no reason. Changes, all in
`styles.css`, no markup touched:

| Change | Was | Now |
|---|---|---|
| Padding | `1.35rem 1rem 0.9rem`, `gap: 0.6rem` | `0.75rem 0.75rem 0.6rem`, `gap: 0.45rem` |
| Background | `transparent` (fully — §6d) | bottom-anchored **scrim gradient** on `.np-art-overlay` itself: `rgba(0,0,0,0.85)` at the baseline → transparent by the top edge. **No `backdrop-filter`, no pseudo-element** — the artwork above the text stays perfectly sharp; only the strip behind the text darkens |
| Shadows | title `0 2px 10px / 0.45`, artist `0 1px 6px / 0.5`, telemetry none | title `0 2px 12px / 0.8 + 0 1px 3px / 0.9`, artist `0 1px 8px / 0.85 + 0 1px 3px / 0.9`, `.np-art-info-row` `0 1px 4px / 0.85` |

This does **not** reintroduce the §6a glass: there is no blur, no mask,
no `::before` — a flat gradient painted *under* the text (the element's
own background), so it cannot blur the artwork. If a future request
wants the fully bare look back, delete the `background` on
`.np-art-overlay` and the three `text-shadow` strengthenings; the
removed-chrome guard (§6b test) is unaffected either way.

Regression guard: `app/tests/social-ui.test.mjs` asserts the overlay
rule carries a `linear-gradient` background, carries **no**
`backdrop-filter`, and the padding values above.

## 7. Constraints carried forward

- `docs/PRD.md` forbids shipping Go sidecars inside the app bundle → the
  sidecar stays an **unbundled, opt-in local process**. The PRD row was
  amended with the carve-out (talk to, never bundle) and the license stance
  (app MIT vs GPL-3.0 sidecar, no code copied) is recorded in
  `docs/sidecar.md` §2.
- Network scope: **localhost only** (`127.0.0.1`), no cloud relay.
- Chat/reactions/skip-votes have **no protocol** in metroserver yet — they
  stay local until that lands.

## 8. Verification

```
npm test            # includes tailwind.test.mjs + social-ui.test.mjs
npm run lint
npm run tauri dev   # visual check: Solo vs Social, light + dark
```
