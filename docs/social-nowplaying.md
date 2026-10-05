# Social Now Playing — Listen Together / Jam Mode (UI)

Status: **Phases 1–3 + 4a landed**; chat/reactions/skip votes stay local, join
and playback sync are Phase 4b/5 (`docs/sidecar.md`). Source mockup:
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
| `#btn-mode-social` / `#btn-activate-social` | adds `body.soc-social`, toasts the room size, `diag("social mode")` | toast states the sidecar is not connected |
| `#btn-mode-solo` / `#btn-leave-room` | removes the class; if the deck was on Chat/Jam it clicks back to Lyrics (those tabs are social-only), resets votes, closes QR, hides grace | — |
| `#btn-qr` / `#btn-qr-close` / `Esc` | toggles `#qr-overlay` | Copy invite enables only once a real room code exists |
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

`MEMBERS = 1` is the single source for `#np-room-members`, `#qr-members-count`,
`#jam-member-pill`, `#chat-online-count` and the vote denominator, so no view
can drift into claiming an audience that is not there.

Guard rails: `app/tests/social-ui.test.mjs` asserts `social.js` contains **no
network API** (`fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest`/`sendBeacon`)
and never assigns `innerHTML`.

## 3b. Phase 4a behaviors (`app/src/sidecar.js`, details in `docs/sidecar.md`)

| Trigger | Behavior | Honest fallback |
|---|---|---|
| entering Social | `GET http://127.0.0.1:<port>/health` (1.5 s), then `ws://…/ws` + `client_capabilities` | no answer → `#jam-sidecar` stays `Not connected` |
| `server_capabilities` | `#jam-sidecar` → `Connected (v…)`, keepalive `ping` every 15 s | shown only after a decoded frame |
| `#btn-open-room` (enabled only while connected) | sends `create_room`; `room_created` fills `soc-room-code` + `qr-room-code` + `jam-room-id` with the server's 8-char code, toasts it | refused → the server's `code`/`message` verbatim, all code slots stay `NO ROOM` |
| `#jam-ua` | prints this client's `navigator.userAgent` for the operator's `ua_policy.json` | display only — the app never alters its UA |
| `#btn-copy-invite` / `#btn-qr-copy` | copy the room code | `disabled` until a code exists |
| leaving Social | `leave_room` (if any) + socket close; all slots reset to `NO ROOM` | — |

Guard rail: `app/tests/sidecar.test.mjs` drives the state machine with a
scripted socket and asserts a status never appears before the frame that
proves it.

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
| Artwork overlay | `.np-art-overlay(-top/-meta)`, `.np-art-trackline`, `.np-art-eyebrow`, `.np-art-quality`, `.np-art-title`, `.np-art-artist`, `.np-art-actions`, `.np-art-action`, `.np-art-info-row/-group/-item/-label/-value/-sep`, `.np-art-info-item--wide`, `.np-art-select` |

`.np-art-trackline` is the **only** name for the eyebrow row. The markup
shipped it as `class="np-trackline"`, which no rule matched — the flex row
silently never applied. The class in `index.html` was renamed to match the
documented inventory; `id="np-trackline"` is unchanged (id contract §5).
| Room QR | `.np-qr-btn`, `.np-qr-overlay(.hidden)`, `.np-qr-head(-label)`, `.np-qr-count`, `.np-qr-body`, `.np-qr-plate`, `.np-qr-code`, `.np-qr-pin`, `.np-qr-copy`, `.np-qr-close` |
| Reactions | `.soc-reaction-bar`, `.soc-reaction-pill(.active)`, `.soc-reaction-emoji`, `.soc-reaction-count`, `.soc-reaction-note` |
| Transport | `.soc-sync-clock`, `.soc-skip-vote(.is-done)`, `.soc-vote-ratio(.is-hot)`, `.soc-grace(.hidden)`, `.soc-grace-timer` |
| Collab queue | `.soc-qhead(-left/-actions)`, `.soc-qhead-title`, `.soc-badge(.is-locked)`, `.soc-qbtn(.is-on)`, `.soc-qrow(.is-now)`, `.soc-qindex`, `.soc-drag`, `.soc-qthumb`, `.soc-qtext`, `.soc-qtitle`, `.soc-now-badge`, `.soc-qbio`, `.soc-added-by`, `.soc-qrow-side`, `.soc-qdur`, `.soc-qremove`, `.soc-qappend`, `.soc-qinput`, `.soc-qappend-btn` |
| Chat | `.soc-pane-head(-left/-right)`, `.soc-pane-title`, `.soc-stat-chip(.is-live)`, `.soc-chat-list`, `.soc-chat-msg(.mine)`, `.soc-chat-avatar`, `.soc-chat-bubble`, `.soc-chat-meta`, `.soc-chat-user`, `.soc-tag-host`, `.soc-chat-time`, `.soc-chat-text`, `.soc-chat-reacts`, `.soc-chat-react`, `.soc-typing` (+ `@keyframes soc-blink`), `.soc-chat-compose`, `.soc-emoji-btn`, `.soc-chat-input`, `.soc-chat-send`, `.soc-chat-quote`, `.soc-empty` |
| Jam pane | `.soc-section-label`, `.soc-tiles`, `.soc-tile(-row/-label/-value/-note)`, `.soc-tile-value.is-ok/.is-off`, `.soc-mode-tag`, `.soc-members`, `.soc-member(-avatar/-name/-role)`, `.soc-btn(-solid/-danger)`, `.soc-solo-prompt(-text)` |

`app/tests/social-ui.test.mjs` asserts every `soc-`/`np-art-`/`np-qr-` class
used in `index.html` has a rule in `styles.css` (and vice versa).

## 5. Element id contract (Phase 3 must not rename)

Header: `btn-mode-solo` `btn-mode-social` `soc-room-chip` `soc-room-code`
`soc-avatar`
Artwork overlay: `np-trackline` `np-quality` `track-title-heading`
`track-artist-heading` `track-fav-btn` `fav-icon` `np-download-btn`
`np-add-btn` `np-share-btn` `np-album` `np-artist-tile` `np-length`
`np-format` `spinning-vinyl-icon` `np-sleep` `np-speed` `np-room-members`
QR: `btn-qr` `qr-overlay` `qr-room-code` `qr-members-count`
`btn-qr-copy` `btn-qr-close` (the preview `qr-pin` was dropped in Phase 4a —
the protocol has no PIN, so showing one was a fabrication)
Reactions: `reaction-bar` `reaction-note` (pills are `data-emoji`)
Transport: `sync-clock-label` `soc-grace` `grace-timer` `btn-skip-vote`
`skip-vote-label` (plus existing `btn-next`, now `.soc-solo-only`)
Deck: `tab-btn-lyrics` `tab-btn-queue` `tab-btn-chat` `tab-btn-jam`
`jam-member-pill`
Queue pane: `queue-lock-badge` `btn-undo-crdt` `btn-lock-queue`
`input-add-song` `btn-submit-song` (plus the pre-existing queue ids)
Chat pane: `chat-messages-container` `chat-empty` `chat-input`
`btn-chat-send` `btn-chat-quote` `chat-typing` `chat-online-count`
`chat-rate-note`
Jam pane: `jam-room-id` `jam-mode-label` `jam-session-mode` `jam-sync-value`
`jam-vote-ratio` `jam-sidecar` `jam-sidecar-note` `jam-ua`
`auto-level-toggle` `jam-members` `jam-members-note` `btn-open-room`
`btn-copy-invite` `btn-leave-room` `btn-activate-social`
`solo-prompt`

Room-code slots (`soc-room-code` `qr-room-code` `jam-room-id`) all read
`NO ROOM` until a `room_created` frame supplies a real one — Phase 4a,
`app/src/sidecar.js` + `docs/sidecar.md` §5.

## 6. Truthfulness rules (non-negotiable)

The app never fakes state (see `docs/ui.md` §16):

- member count starts at **`1 (you)`**, reaction counts at **`0`**
- Jam pane shows **`Not connected`** for the sidecar until a real
  `127.0.0.1` process answers; QR copy button stays disabled
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
