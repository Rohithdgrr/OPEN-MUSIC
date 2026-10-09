# Ganesha — Phase 4: Music moat

**Status:** Ready — start immediately (parallel with Govinda, Devi, Vijay).
**Read first:** `README.md` (ownership, contract, protocol) and
`features.md` (Tier 5 #71–85, Tier 4 #60/#64/#68/#70).

## Mission

The only reason this notepad lives **inside a music player**: attach tracks
and timestamps to notes, review/journal/lyric/session templates, playlist
notes, listening journal. Features no generic notes app can ship. You
consume the contract; you never edit the core or the player.

## Owned files (write)

| File | Role |
| --- | --- |
| `app/src/notepad-music.js` | `initNotepadMusic(core)` — every music feature |
| `app/src/notepad-music.css` | Your styles (injected inside `init`) |
| `app/tests/notepad-music.test.mjs` | Your test |
| `app/tests/_probe-notepad-ganesha.mjs` | Your probe (untracked) |
| `docs/notepad/ganesha.md` | This doc |

**Forbidden:** README §1 in full — all other notepad modules, `index.html`,
`styles.css`, `player.js`, `playback.js`, `transport.js`, `queue.js`,
`library.js`, `home.js`, `lyrics.js`, `art.js` (**read-only imports OK**),
`mobile/**`, Rust (`src-tauri/**`), git mutations, installs, `npm run css`.
Storage key: **`tm-notepad-music`** only. CSS/ids prefix: **`npdm-`** only.

## Contract surface you use

`core.mount("rail")` (chips strip — yours), `core.mount("overlay")` (own
`npdm-` child: attach menu), `core.on("note"|"saved"|"keydown"|"open")`,
`core.activeNote()`, `core.newNote(name, content)`, `core.allNotes()`,
`core.setNoteContent`, `core.refresh()`, `core.toast`, `core.diag`.
**Read-only imports allowed** (never edit): `transport.js` (play/seek/step),
`queue.js` (`queue`, `queueIndex`, `restoredTrack`), `home.js`
(`loadPlays` for the journal — verify the export exists first),
`lyrics.js`/`art.js` state getters if exported, `core.js` (`invoke`,
`toast`) for catalog reads (`search_songs` etc.). If a getter you need is
not exported → `BLOCKED:` in your Report; **do not** add the export
yourself (forbidden file).

## Sidecar schema (`tm-notepad-music`, yours alone)

```js
{ tracks:  { [noteId]: [{ id, title, artist, atMs?, kind }] },  // kind: track|stamp
  journal: { "YYYY-MM-DD": { plays, topArtist, note } },         // listening journal
  meta:    { [noteId]: { rating: 0..5, mood, replay, playlistId? } }, // review fields
  playlistNotes: { [playlistId]: noteId } }                      // #81
}
```

Chip rendering rule: the **chips live in `#npd-rail`** (never inside the
textarea — content stays plain text). The note text may additionally carry
inline `[track:<id>@<ms>](<title>)` markers that the rail parser surfaces
(they are just text until you render them).

## Tasks (each accepted by its check)

1. **Store + hygiene.** Load/heal/corrupt-safe; prune entries whose note
   vanished. *Check: test round-trip + prune.*
2. **Attach menu — `Alt+M`** (`#71`). Overlay child rows:
   - `Attach playing track` (from `queue[queueIndex]?.track ?? restoredTrack`,
     read-only import of `queue.js`) — no track playing → toast, no crash;
   - `Attach playing track @ current time` (read current time from the
     transport/audio state via exported getters — verify, else `BLOCKED`);
   - `Attach track by search…` → inline input, `invoke("search_songs", …)`
     (read-only `core.js` import), ↑↓ Enter picks a row. **No network
     beyond the existing backend.** *Check: test with fake queue +
     fake invoke.*
3. **Chips (`#npd-rail`, `#72`).** Render one chip per sidecar track:
   `▶ Title — Artist` + timestamp badge when `atMs`. Click (and `Enter`
   when focused) → seek that track into playback via `transport.js`
   exports (verify exact API names by reading the file first; play the
   note's track). No playback state mutation beyond the public exported
   functions. *Check: test renders chips from fixture sidecar; DOM-level
   activation calls a stubbed transport fn.*
4. **Timestamp links (`#73`).** `atMs` chips seek to position; inline
   `@2:34` text (or `[track:…@154000]`) appears as a second line under the
   chip with the same seek action. Formatting helper `fmtAt(ms)` unit
   tested. *Check: test parses `@2:34`/`@1:02:03` edge forms.*
5. **Templates (`#74`, `#76`) — content ownership.** Alt+M rows `New:
   Album Review` / `New: Session Log` create notes via
   `core.newNote(title, TEMPLATE)` where **your** template text includes
   rating/mood/fav-track/session fields + the marker syntax from task 4.
   (Devi owns the generic template list in the switcher — your templates
   are music-specific and live in your menu; reference her doc only for the
   shared Album Review format so both produce the same skeleton: coordinate
   by adopting **her** Album Review/Session Log/Lyric Sheet texts verbatim
   if `devi.md` already defines them — read it first, don't edit it.) *Check:
   test asserts skeleton fields.*
6. **Review meta (`#74` continuation).** Parse the template's fields on
   `saved`: `Rating: ★★★★☆`-line and `Mood:`/`Replay:` lines → `meta`;
   render a compact summary line into `#npd-status-extra` (`★4 · chill ·
   high replay`). *Check: test parse + status line.*
7. **Listening journal (`#80`).** Alt+M row `Today's journal` → if
   `journal[today]` exists, open it; else create from `loadPlays()` stats
   (plays count, top artist — read-only `home.js` import, verify export;
   absent → derive from `queue.js` history if exported, else `BLOCKED`).
   Auto-append on panel open? No background jobs — **on-demand only**
   (document: journal seeds when you ask for it). *Check: test with fixture
   plays.*
8. **Playlist notes (`#81`).** `meta.playlistId` + `playlistNotes` map.
   Alt+M row `Note for current playlist` — needs the **current playlist
   id**: verify `library.js` exports a getter (read-only); if yes → note
   linked both ways (your sidecar), rail shows `Playlist: <name>` line when
   the note is linked. If no getter → `BLOCKED:` with the exact export you
   need. *Check: test linking/unlinking.*
9. **Artist bio (`#82`) — stretch.** Alt+M `New: Artist bio for playing
   track` seeds from `invoke` catalog data if an artist-bio command exists
   (grep `src-tauri/src` **read-only** for available commands; prefer
   existing `search_songs` artist info). No Rust changes — if nothing
   returns bios, seed with name/discography lines from what exists and say
   so in Behavior added.
10. **Lyric sheet (`#75`) — stretch.** If `lyrics.js` exports parsed
    `[time]` lines, seed a note with `mm:ss text` rows + document that
    editing stays plain text. Verify exports first; `BLOCKED:` if absent.
11. **Chord snippets (`#77`), mood board (`#79`), sample log (`#84`),
    remix notes (`#85`), compare takes (`#83`) — stretch set.** Mostly
    template texts + sidecar rendering (mood board = grid of album-art
    URLs from attached tracks in a `npdm-` child; art URLs via read-only
    `art.js`/relay helper). Do them only after P0 (tasks 1–8) are green.
12. **Probe + evidence.** `_probe-notepad-ganesha.mjs` (after core lands;
    `PENDING` if not): attach → chip render → seek call → review parse →
    journal seed. Paste transcript.

## Chords you own

`Alt+M` only. Everything else is menu rows inside your overlay child.

## Limits

- **Zero writes outside your three files.** Read-only imports must not be
  mutated — if you need an export that doesn't exist, that's `BLOCKED:`,
  not a license to edit the file.
- No Rust changes, no new commands, no network beyond the app's existing
  `invoke` commands, no npm/CDN, no dialogs.
- Never trigger playback from panel *open* — only from explicit chip
  activation (an accidental play on tab switch is a bug: note it in
  Behavior added as an explicit "no autoplay" rule).
- Content model stays plain text: chips are sidecar + rail, markers are
  text. No new colors; dark parity (`html.dark` + README §2.4 tokens).

## Success criteria

- [ ] `Alt+M` attaches the playing track (and at timestamp) to the active
      note; chips render in the rail; activating a chip seeks/plays through
      the public transport API (stubbed call proven in test).
- [ ] `@2:34` / marker timestamps parse and seek (format edge cases green).
- [ ] Album Review + Session Log templates produce the agreed skeleton;
      rating/mood/replay parse back into a status-bar summary.
- [ ] Listening journal seeds from real play history (or `BLOCKED:` with
      evidence); playlist notes link/unlink if a getter exists (or
      `BLOCKED:` naming the exact missing export).
- [ ] `notepad-music.test.mjs` green; `node --check` + `npm run lint` +
      full `npm test` green (or `FOREIGN RED:` documented).
- [ ] Probe transcript (or `PENDING` + plan); `## Behavior added` documents
      every Alt+M row, marker syntax, and the no-autoplay rule.

## Behavior added

`initNotepadMusic(core)` (called by Govinda's `notepad.js`) adds a music
sidecar on top of the plain-text note model. State lives in the single
localStorage key `tm-notepad-music`; every CSS class and DOM id is prefixed
`npdm-`; dark parity is `html.dark`; no new colors (README §2.4).

### Alt+M menu (14 rows, ordered)

`Alt+M` is claimed via the cancelable `core.on("keydown")` relay — no other
module owns it. The overlay menu rows, in order:

1. **Attach playing track** — chip with no timestamp (`▶ Title — Artist`).
2. **Attach playing track @ current time** — chip carries the current
   playhead in ms.
3. **Attach track by search…** — prompts via the injectable `searchTracks`
   dep (catalog `search_songs`), attaches the picked result.
4. **New: Album Review** — template `TEMPLATES.albumReview` (Artist/Album/
   Rating/Mood/Favorite track/Replay skeleton + marker line).
5. **New: Session Log** — template `TEMPLATES.sessionLog`.
6. **Today's journal** — opens or seeds today's entry (`todayKey`,
   `journalSeed`, `journalBody` from real play history via `loadPlays`).
7. **Note for current playlist** — links the active playlist
   (`currentPlaylist` dep, `library.js pdCurrentId`) via
   `noteForPlaylist`/`linkPlaylist`/`unlinkPlaylist`.
8. **New: Lyric sheet for playing track** — seeds `mm:ss text` rows from
   `lyrics` dep (`get_lyrics`; `synced: Vec<(f64,String)>`), one row per
   synced line; editing stays plain text.
9. **New: Artist bio for playing track** — seeds name / listeners / first
   bio paragraph / discography via the `artistBio` dep (`search_entities`
   name→token hop, then `artist_overview`).
10. **Show mood board** — toggles a grid of album-art tiles from the note's
    attached tracks (`moodBoardItems`, `artUrl`/`hqArt`).
11. **New: Chord snippet** — `TEMPLATES.chordSnippet`.
12. **New: Sample log** — `TEMPLATES.sampleLog`.
13. **New: Remix notes** — `TEMPLATES.remixNotes`.
14. **New: Compare takes** — `TEMPLATES.compareTakes`.

### Marker syntax & chips

- Markers in note text: `[track:<id>@<ms>](<title>)` (the `@<ms>` part is
  optional). Parsed by `parseMarkers`/`parseAtToken`, formatted by `fmtAt`.
- The chips rail (`#npdm-rail`, mounted via `core.mount("rail")`) renders one
  chip per marker (`chipLabel` → `▶ Title — Artist`); the timestamp line shows
  the parsed position.
- Review metadata (`Rating`/`Mood`/`Replay`) parses back out of the text
  (`parseReviewMeta`) into a one-line status summary (`metaSummary`) shown via
  `core.mount("statusExtra")`.

### No-autoplay rule

Opening the panel, switching notes, or any render path **never** starts
playback. Audio only starts from an explicit chip activation (click/Enter on a
chip), which seeks/plays through the read-only transport path
(`queue.js enqueue` → `playback.js playQueueItem`/`setResume`), proven as a
stubbed call in the test. `initNotepadMusic` itself triggers zero `calls` on
init (asserted).

### Deps (all lazy, injectable, zero static app imports)

`playingTrack`, `currentTimeMs`, `playTrackAt`, `searchTracks`, `loadPlays`,
`lyrics`, `artistBio`, `artUrl`, `currentPlaylist` — plus `doc`/`storage`
overrides for tests. `queue.js`/`playback.js`/`library.js`/`home.js`/`core.js`/
`dom.js`/`art.js` are reached only through dynamic `import()` inside the dep
bag, so Node tests never execute their DOM side effects (static-contract test
asserts no top-level app import).

## Report

`LANDED:` `app/src/notepad-music.js` + `app/src/notepad-music.css` +
`app/tests/notepad-music.test.mjs`.

- `node --check src/notepad-music.js` clean.
- `npx eslint src/notepad-music.js` exit 0.
- `node --test tests/notepad-music.test.mjs` → **23/23 pass** (pure funcs +
  fake-core/fake-deps full Alt+M drive + static-contract: no static imports,
  every `npdm-` class has a CSS rule, CSS namespace-only + dark parity).
- Full `npm test` → **403 tests / 392 pass / 11 fail — all FOREIGN**, none in
  `notepad-music.test.mjs`: `notepad-blocks.test.mjs` (7, Vijay WIP),
  `jam-crossdevice.test.mjs` (2), `logo-fallback.test.mjs` (2). Recorded per
  README §3.3.

`BLOCKED:` none — `pdCurrentId` (`library.js:559`) and `loadPlays`
(`home.js:587`) both exist; playlist linking and the journal are wired, not
stubbed.

`PENDING:` the headless probe `_probe-notepad-ganesha.mjs` — Govinda's
`app/src/notepad.js` core does not exist yet (glob for `app/src/notepad*.js`
returned none). The probe drives the real core once it lands; until then the
fake-core test is the behavioral gate.

Nothing committed/staged (README §3.2); no edits outside owned files; no Rust,
no new commands, no installs.
