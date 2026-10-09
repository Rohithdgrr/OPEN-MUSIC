# OPEN-MUSIC Notepad — feature list & spec

Two parts: **(1)** the full modern-notepad / sticky-notes feature list, and
**(2)** the v1 implementation spec as actually built (desktop only, hotkey-only
activation, Notepad-style tabs).

---

## Part 1 — Complete feature list

### Tier 1 — Essentials (ship first)

| # | Feature | Notes |
|---|---|---|
| 1 | Create / delete / rename note | New-tab chord, switcher delete, F2 rename |
| 2 | Auto-save | Debounced 400 ms after last keystroke |
| 3 | Plain text editor | `<textarea>`, monospace |
| 4 | Rich text | Bold, italic, underline, strikethrough |
| 5 | Headings | H1 / H2 / H3 (Notion-style block sizes) |
| 6 | Bulleted list | `-` at line start |
| 7 | Numbered list | `1.` at line start |
| 8 | Checkbox list | `[ ]` at line start, tap to toggle |
| 9 | Blockquote | `>` at line start |
| 10 | Code block | Triple backtick fence, monospace |
| 11 | Divider | `---` at line start |
| 12 | Undo / redo | Ctrl+Z / Ctrl+Shift+Z, 50-step history |
| 13 | Search notes | Full-text (SQLite FTS5 when backend-backed) |
| 14 | Sort | Recently edited (switcher default), name, created |
| 15 | Pin notes | Pinned float to top of the switcher |
| 16 | Trash / restore | Soft-delete with 30-day retention |
| 17 | Word count | Live in the status bar |
| 18 | Monospace numbers | `font-variant-numeric: tabular-nums` (player style) |

### Tier 2 — Comfort

| # | Feature | Notes |
|---|---|---|
| 19 | Tags / labels | Freeform `#tag` inline, autocomplete |
| 20 | Notebooks / folders | 1-level nesting is enough |
| 21 | Favorites | Star + dedicated filter |
| 22 | Markdown export | `.md`, preserves headings/lists/checkboxes |
| 23 | Plain text export | `.txt` |
| 24 | HTML export | Self-contained `.html` with inline CSS |
| 25 | PDF export | Rust `printpdf` crate |
| 26 | Import | Paste markdown → auto-convert to blocks |
| 27 | Templates | Blank, Daily Journal, Album Review, Session Log, Lyric Sheet |
| 28 | Font size control | 14 / 16 / 18 / 20 px, saved per user |
| 29 | Line height control | 1.4 / 1.6 / 1.8 |
| 30 | Dark mode | Follows the app theme (`html.dark` cascade) |
| 31 | Color tags | App-palette tones only — no new colors |
| 32 | Drag-to-reorder | Tabs / list rows |
| 33 | Swipe actions | Mobile only (notepad is desktop-only in v1) |
| 34 | Recently viewed | Last 10 opened notes, switcher default order |
| 35 | Duplicate note | Clones content + title + tags |

### Tier 3 — Notion-level blocks

| # | Feature | Notes |
|---|---|---|
| 36 | Slash command palette | `/` → heading, list, toggle, table, image, quote, code, divider |
| 37 | Toggle blocks | Collapsible `<details>`-style |
| 38 | Callout blocks | Icon + text in a rounded surface box |
| 39 | Tables | Simple grid, add/remove rows/cols |
| 40 | Images | Drag-drop / paste, stored in the vault |
| 41 | File attachments | Up to 50 MB |
| 42 | Internal links | `[[Note Title]]` → autocomplete + backlink |
| 43 | Backlinks panel | "Linked from 3 notes" |
| 44 | @mentions | Artists, tracks, albums from the library |
| 45 | Block drag handle | 6-dot handle, drag to reorder |
| 46 | Block menu | Per block: duplicate, delete, turn into, move to |
| 47 | Nested pages | A note containing sub-notes |
| 48 | Breadcrumbs | `Notepad › Album Reviews › …` |
| 49 | Table of contents | Auto-generated from headings |
| 50 | Sticky headers | Current heading pinned while scrolling |
| 51 | Focus mode | Hide everything but the note |
| 52 | Typewriter mode | Current line centered, others dimmed |
| 53 | Command palette | Ctrl+K → jump to any note, tag or action |
| 54 | Version history | Keep last 30 saves, restore |
| 55 | Find & replace | In-note search with regex toggle |
| 56 | Word goals | Progress ring in the footer |

### Tier 4 — Power features

| # | Feature | Notes |
|---|---|---|
| 57 | Math equations | KaTeX `$...$` / `$$...$$` |
| 58 | Mermaid diagrams | `` ```mermaid `` fence |
| 59 | Embeds | YouTube / Spotify / SoundCloud iframes (allowlist) |
| 60 | Bookmarks | URL → title + favicon + preview card |
| 61 | Comments | Inline threads on a block |
| 62 | Real-time collaboration | CRDT (Yjs / Automerge) for shared notes |
| 63 | Presence cursors | Collaborator avatars + carets |
| 64 | Voice notes | Record → transcribe (Whisper) |
| 65 | Handwriting canvas | SVG drawing — chord diagrams |
| 66 | Graph view | Visual map of `[[linked]]` notes |
| 67 | AI assist | Summarize / continue / find related — BYO API key |
| 68 | Pomodoro timer | 25/5 cycle, integrates with Focus mode |
| 69 | Web clipper | Browser extension → send article as a note |
| 70 | Recurring notes | Daily/weekly templates auto-created |

### Tier 5 — Music-specific (OPEN-MUSIC moat)

| # | Feature | Notes |
|---|---|---|
| 71 | Attach track to note | Right-click track → "Add to note" |
| 72 | Inline track chip | `▶ Track — Artist` block, plays on tap |
| 73 | Timestamp link | `@2:34` jumps to that position in the track |
| 74 | Album review template | Rating, favorite track, mood, replay value |
| 75 | Lyric sheet | Per-line timestamps, editable |
| 76 | Session log | Jam sessions: date, host, tracks, timestamps |
| 77 | Chord snippets | Monospace block with rendered diagrams |
| 78 | Stem annotations | Note attached to a specific stem |
| 79 | Mood board | Grid of album art + captions |
| 80 | Listening journal | Daily note: "you listened to X, top artist Y" |
| 81 | Playlist notes | Notes tab per playlist: track-by-track commentary |
| 82 | Artist bio notes | Auto-populated from the catalog, editable |
| 83 | Compare takes | Two player embeds + notes on the differences |
| 84 | Sample source log | "This sample came from Track X at 1:12" |
| 85 | Remix notes | Original → your version, BPM, key, changes |

### Deliberately skipped (not music-player material)

Multi-workspace/team spaces · kanban/calendar/gallery database views ·
formulas and rollups · public web publishing · external-user comments ·
enterprise SSO/permissions · multiplayer on every note.

### Build order

1. **Sprint 1 (foundation):** 1, 2, 3, 12, 13, 14, 15, 16, 17, 18
2. **Sprint 2 (comfort):** 19–35 as needed
3. **Sprint 3 (blocks):** 36–56 (budget 3–4 weeks solo)
4. **Sprint 4 (music magic):** 71–75, 81, 82 — the moat; do before Tier 4
5. **Sprint 5 (power):** 42–44, 57–58, 62, 67 only if asked

---

## Part 2 — v1 implementation spec (what this repo ships)

**Scope decision (user, 2026-10-10):** desktop application only; activated
**only** by a Windows shortcut key — no button, nav item, tray entry or route
anywhere else in OPEN-MUSIC; tabs to switch between open files, "just like the
normal Notepad of Windows".

### Activation (the single way in)

| Surface | Binding | Mechanism |
| --- | --- | --- |
| Global (any focused window) | `Ctrl + Alt + P` | Rust `tauri-plugin-global-shortcut`, registered in `src-tauri/src/shortcuts.rs` as action `notepad`, emitted as event `shortcut:notepad` (focus: window brought forward) |
| Hyper (remapped Caps Lock) | `Caps Lock + P` | Same action, Hyper variant when a remap tool runs at boot |

Exactly one variant registers per action (the existing `decide()` machinery),
so the chord can never double-fire. The action table in
`docs/shortcuts.md` and the Settings → Keyboard Shortcuts panel list it.
There is intentionally **no** second way to open the panel: no button, no menu
item, no `data-path` route.

### In-panel keyboard map (tabbed document interface)

| Action | Binding |
| --- | --- |
| Toggle panel | `Ctrl + Alt + P` (global) |
| New tab (new note) | `Ctrl + T` (fallback `Alt + T`) |
| Close tab | `Ctrl + W` (fallback `Alt + W`) |
| Cycle tabs next / previous | `Ctrl + Tab` / `Ctrl + Shift + Tab` (fallback `Alt + →` / `Alt + ←`) |
| Jump to tab 1–9 | `Ctrl + 1..9` |
| Rename tab | `F2` (or double-click the tab) |
| Save now | `Ctrl + S` (auto-save is debounced; this flushes immediately) |
| Find in note | `Ctrl + F` — Enter next, Shift+Enter previous, Esc closes |
| Note switcher | `Ctrl + P` — fuzzy jump, Enter opens, creates if no match |
| Delete note | `Delete` with the switcher open |
| Close panel | `Esc` (find → switcher → panel, innermost first) |

Bindings marked "fallback" exist because WebView2 reserves a few Chromium
chords (browser accelerator keys); the delivered set was probed in the real
WebView2 before shipping and only chords that reach the page are advertised.

### Behavior

- **Tabs = open files.** Every tab is one note; the strip switches between
  them. The session (open tabs + active tab) persists across restarts, like
  Notepad's session restore. Closing the last tab leaves the strip empty and
  the new-tab hint showing.
- **Auto-save.** Debounced 400 ms to `localStorage` (`tm-notepad`), flushed on
  close / `pagehide` / `visibilitychange`. No unsaved-changes dialogs — and
  no dialogs means no buttons.
- **One note model:** `{ notes: {id: {name, content, updated}}, tabs: [id],
  active: id }` in one key; stale session ids are healed on load.
- **Status bar:** `Ln x, Col y · n words · saved hh:mm:ss` (JetBrains Mono,
  tabular numerals — same label style as the player).
- **Theme:** plain CSS under `#npd-*` in `styles.css` with explicit
  `html.dark` overrides mirroring the app's utility inversion section — no new
  colors, existing tokens only.
- **Desktop only.** `notepad.js` is imported from `shortcuts.js`, which only
  the desktop `index.html` loads; the mobile shells have no entry point.

### Files

| File | Change |
| --- | --- |
| `docs/notepad.md` | This spec + feature list (docs-first) |
| `docs/shortcuts.md` | Table row + AutoHotkey recipe line |
| `app/src-tauri/src/shortcuts.rs` | New `Action { name: "notepad", key: KeyP, event: "shortcut:notepad", focus: true }` |
| `app/src/notepad.js` | Panel, tabs, editing, find, switcher (new) |
| `app/src/shortcuts.js` | `shortcut:notepad` → `toggleNotepad()` |
| `app/src/settings.js` | Shortcuts table row |
| `app/src/styles.css` | `#npd-*` styles + dark overrides |

### Verification (evidence, not assertion)

1. `npm test`, `npm run lint`, `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.
2. Real-app probe over CDP (`--remote-debugging-port=9222`):
   chord-deliverability probe decides the advertised bindings (WebView2
   reserves `Ctrl+T/W/Tab` unless proven deliverable), global hotkey tested
   with real OS input, tab create/switch/close/persist exercised end-to-end.

### Post-v1 (from Part 1)

Sprint 1 remainder (search FTS, trash, pin, undo) → Tier 5 track attachment —
each behind its own docs-first spec update here.
