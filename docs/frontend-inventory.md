# Frontend Inventory — OPEN-MUSIC (TRANCE MUSIC)

Surveyed by **KARTHIKEYA (tidy-cobra)** at room turn T2. Every
one-liner below is quoted/adapted from the module's own header
comment — no guesses. Purpose: give RUDRA a map when writing UI
task cards, and give any agent a fast "who owns what" lookup.

## Desktop shell — `app/src/` (zero-build vanilla JS)

| Module | Owns |
|--------|------|
| `main.js` | entry, boot sequence |
| `core.js` | invoke, `$` helpers, views, diagnostics, errors, toasts, esc |
| `dom.js` | shared DOM refs (`$`, `$$`, views, navLinks, errorEl, audio, bar, np) |
| `util.js` | fmt helpers, np text, entity meta links |
| `html.js` | HTML escaping — single choke point for API data into innerHTML (XSS) |
| `search.js` | results rendering, filters/sort/pagination, dedupe, doSearch, suggestions |
| `fuzzy.js` | pure query-text scoring (bounded Levenshtein + tokens), "did you mean" |
| `query.js` | query understanding: normalize, extract filters, relevance score (pure) |
| `home.js` | home feed, hero, library/plays loading |
| `library.js` | favorites, local playlists, playlist/artist/album detail screens |
| `queue.js` | queue state, queue rendering, enqueue/advance |
| `player.js` | play/pause badge, audio event listeners |
| `playback.js` | playQueueItem, stream error handling |
| `transport.js` | transport controls, modes, volume, queue extras, share/credits |
| `lyrics.js` | lyrics fetch, render, sync |
| `radio.js` | endless radio recommendation logic |
| `art.js` | artwork URL helpers and painting |
| `bridge.js` | desktop-card state bridge (`playerSnapshot`, `emitState`) |
| `widget.js` | desktop card — pure view: paints state, forwards taps |
| `jelly.js` | window-drag jelly wobble (listens to `tm:window-moved` from Rust) |
| `media.js` | OS media overlay (Windows SMTC / Now Playing) via `navigator.mediaSession` |
| `shortcuts.js` | global shortcut events from Rust (Caps Lock Hyper / Ctrl+Alt, media keys, tray) |
| `sleep.js` | one-shot sleep timer, volume fade over last `FADE_MS` |
| `settings.js` | settings dialog, widget prefs, user preferences |
| `history.js` | search history storage + chips |
| `importer.js` | Exportify CSV → vault import (Spotify CSV playlists) |
| `sync.js` | portable backup/restore + CSV/M3U export (schema sync-ready) |
| `gsync.js` | automatic Google Drive sync engine |
| `vault.js` | download pipeline, vault/downloads view |
| `store_db.js` | frontend wrapper over Rust AppStore (`store.db`): metadata cache + KV + search cache |
| `net.js` | connection state machine: online/slow/reconnecting/lost → routing mode |
| `room.js` | Listen Together room state — pure reducer, DOM-free (protocol frames), plus the shared sync math (`expectedPositionMs`/`syncDecision`), `parseInvite`, `sanitizeRoomName` |
| `metroproto.js` | metroserver protobuf subset (verbatim from `listentogether.proto`) |
| `sidecar.js` | metroserver connection manager — loopback (127.0.0.1) only |
| `social.js` | Social Now Playing shell; drives the `room_*` commands + `room://msg` frames (open/join/chat/playback/report/close), mirrors `room.js` state into the Jam/QR/header slots |
| `qrview.js` | paints the Rust-encoded room QR symbol onto a canvas |

## Mobile shell — `app/src/mobile/`

| Module | Owns |
|--------|------|
| `app.js` | boot, global click delegation, widget player paint |
| `router.js` | hash router; screens are static fragments in `screens/<dir>.html` |
| `shared.js` | invoke, Channel, storage, artwork, row/card templates |
| `binders.js` | paints real backend data into each static design screen |
| `player.js` | one shared `<audio>` for every screen: queue, resolve, transport |
| `ux.js` | Spotify-feel interaction layer (delegated, self-attaching) |
| `menus.js` | one options sheet behind every three-dot trigger |
| `homeplus.js` | personal Home layer: streak card + "New from artists you follow" shelf |
| `streaks.js` | listening streaks over the plays log |
| `audioplus.js` | crossfade/gapless + per-track EQ user surface (engine in player.js) |
| `lyrics.js` | karaoke lyrics for NowPlaying card (desktop port) |
| `radio.js` | endless radio for mobile (desktop port) |
| `rank.js` | mobile search ordering (pure, unit-tested like fuzzy.js) |
| `jam.js` | Listen Together on mobile: Solo ↔ Social Jam sheets, room banner, chat, Jam Data, host/guest transport rules (imports the shared `../room.js`) |
| `native.js` | Android media surfaces: notification, lockscreen, BT/car/headset, widget |
| `net.js` | mobile port of the connection state machine |
| `collab.js` | collaborative-feel playlists without a server (JSON envelope) |
| `sharecode.js` | TRANCE-SHARE v1 playlist codec (`TRANCE-SHARE:` + base64url) |
| `ai-lyrics.js` | Gemini fallback for unknown songs (DOM-free) |
| `legal.js` | About / Terms / Licences copy (ported from desktop settings) |
| `tailwind-config.js` | no-op kept for reference — Tailwind CLI ships static CSS |

## Mobile screens — `app/src/mobile/screens/`

Static fragment pairs (`.html` + `.js`), one per route: `home`,
`main-library`, `liked-songs`, `history`, `search`, `playlist`,
`album`, `artist`, `nowplaying`, `download`, `notification`,
`analytics`, `settings`.

## Notes for task-card writers

- **Pure/DOM-free modules** (testable with `node --test`):
  `room.js`, `fuzzy.js`, `query.js`, `html.js`, `mobile/rank.js`,
  `mobile/ai-lyrics.js`, `mobile/sharecode.js`.
- **UI work entry points**: `index.html` + `styles.css` +
  `tailwind.css` (desktop); `mobile/index.html` +
  `mobile/tailwind-config.js` (mobile).
- **Room layer, as of 2026-10-06**: the reducer contract is frozen
  (`ROOM.md` §3D C-2, `docs/listen-together.md` §6a) and both surfaces are
  wired — desktop `social.js`, mobile `jam.js`, one shared `room.js`. Nothing
  here is blocked; the remaining steps are the two-PC field test (§10) and the
  Android build (needs `tauri android init`).
