# Notepad — feature coverage report (85/85 verified)

**Date:** 2026-10-10 · **Verified by:** Govinda session, by reading all four
modules (`notepad.js`, `notepad-org.js`, `notepad-blocks.js`,
`notepad-music.js`) feature-by-feature — regex probes confirmed against the
actual lines, false positives removed.

The list itself is `features.md` Part 1 (this is the .md of that list — it
was written when the plan was set up). This file answers: **what actually
runs today, what is partial, what is missing, and what is fastest to add.**

**Tabs (the Windows-Notepad-style "change from one file to another") are
DONE and live-proven today** — not in this table because they are the shell
itself: `Ctrl+T` new, `Ctrl+W` close, `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle,
`Ctrl+1..9` jump, click-switch, `F2` rename, session restore across app
restart (E2E transcript in `govinda.md` §Report).

## Scoreboard

| Status | Count | Meaning |
| --- | --- | --- |
| ✅ implemented | **51** | works, unit-tested (50 + #18, closed by the 2026-10-10 UI polish pass) |
| 🟡 partial | **7** | core works, edge/shortcut/rendering missing |
| ❌ not implemented | **24** | — |
| ⏭ skipped by design | **2** | spec's own skip list (#62, #63) |
| N/A | **1** | mobile-only gesture, notepad is desktop-only (#33) |

## Tier 1 — Essentials (1–18)

| # | Feature | Status | Where / evidence |
|---|---|---|---|
| 1 | Create / delete / rename note | ✅ | core: new-tab chord, switcher Delete, `F2` rename |
| 2 | Auto-save | ✅ | core 400 ms debounce + pagehide flush |
| 3 | Plain text editor | ✅ | `<textarea>` monospace pad |
| 4 | Rich text bold/italic/underline/strike | 🟡 | markdown `**`/`*`/`~~` render in Vijay's preview; **no `Ctrl+B/I/U` shortcut, no underline** |
| 5 | Headings H1–H3 | ✅ | blocks slash rows + preview + TOC |
| 6 | Bulleted list | ✅ | blocks auto-continue |
| 7 | Numbered list | ✅ | blocks auto-continue + renumber |
| 8 | Checkbox list | ✅ | auto-continue `[ ]`/`[x]`, preview click-toggle |
| 9 | Blockquote | ✅ | blocks auto-continue `>` |
| 10 | Code block | ✅ | ``` fence + preview `<pre>` |
| 11 | Divider `---` | ✅ | preview paints `<hr>` |
| 12 | Undo / redo | ✅ | native textarea `Ctrl+Z/Y` (core never breaks it) |
| 13 | Search notes | ✅ | org content search in switcher + core find-in-note |
| 14 | Sort | ✅ | org `SORT_MODES` (`Alt+R`): recent/created/az/trash |
| 15 | Pin | ✅ | org pinned float to top |
| 16 | Trash / restore | 🟡 | trash + untrash work; **no 30-day auto-purge, no empty-trash button** |
| 17 | Word count | ✅ | core status bar |
| 18 | Tabular numerals | ✅ | `notepad.css` `.npd-status`/`.npd-find-count` `tabular-nums` (UI polish pass 2026-10-10) |

## Tier 2 — Comfort (19–35)

| # | Feature | Status | Where / evidence |
|---|---|---|---|
| 19 | Tags | ✅ | org `#tag` + inline extraction |
| 20 | Notebooks (1-level) | ✅ | org store, `Alt+N` scope |
| 21 | Favorites | ✅ | org star + filter |
| 22 | Markdown export | ✅ | org `Alt+E` |
| 23 | Plain text export | ✅ | org |
| 24 | HTML export (self-contained) | ✅ | org, inline CSS |
| 25 | PDF export | ❌ | needs Rust `printpdf` crate → **approval required** |
| 26 | Import | ✅ | org `Alt+I` (.md/.txt files) |
| 27 | Templates | ✅ | org 5 templates (Blank/Journal/Review/Session/Lyric) |
| 28 | Font size 14/16/18/20 | ✅ | org prefs |
| 29 | Line height 1.4/1.6/1.8 | ✅ | org prefs |
| 30 | Dark mode | ✅ | `html.dark` cascade, parity-tested |
| 31 | Color tags (6 muted) | ❌ | org store pattern makes this small |
| 32 | Drag-to-reorder notes | ❌ | — |
| 33 | Swipe actions | N/A | swipe is mobile; notepad is desktop-only by contract |
| 34 | Recently viewed (10) | ✅ | org `recent`, re-capped 10 |
| 35 | Duplicate note | ✅ | org action row |

## Tier 3 — Notion-level blocks (36–56)

| # | Feature | Status | Where / evidence |
|---|---|---|---|
| 36 | Slash command palette | ✅ | blocks 19 rows |
| 37 | Toggle blocks | ✅ | `???` syntax + preview `<details>` |
| 38 | Callout blocks | ✅ | `> [!info]` syntax + preview |
| 39 | Tables | ✅ | preview paints `<table>` |
| 40 | Images | 🟡 | slash row inserts `![](url)` link; **no paste/drop → vault** |
| 41 | File attachments | ❌ | — |
| 42 | Internal links `[[Note]]` | ❌ | — |
| 43 | Backlinks panel | ❌ | — |
| 44 | `@`mentions of library | ❌ | — |
| 45 | Block drag handle | ❌ | — |
| 46 | Block menu (`⋯`) | ❌ | — |
| 47 | Nested pages | ❌ | — |
| 48 | Breadcrumbs | ❌ | — |
| 49 | Table of contents | ✅ | blocks `/toc`, heading walker |
| 50 | Sticky headers | ❌ | — |
| 51 | Focus mode | ✅ | blocks |
| 52 | Typewriter mode | ✅ | blocks, caret-centred |
| 53 | Command palette | 🟡 | **`Ctrl+P` switcher IS a palette** (jump to note + 10 action rows); `Ctrl+K` alias not bound |
| 54 | Version history | ✅ | 30 versions, 5 s debounce, restore (test-proven) |
| 55 | Find & replace (+regex) | ✅ | blocks `Alt+H`, literal + regex |
| 56 | Word goals | ❌ | — |

## Tier 4 — Power (57–70)

| # | Feature | Status | Where / evidence |
|---|---|---|---|
| 57 | Math (KaTeX) | 🟡 | `$$` recognised + slash insert; **rendering BLOCKED** (new dep → approval) |
| 58 | Mermaid | 🟡 | ```mermaid fence recognised + insert; **rendering BLOCKED** (new lib → approval) |
| 59 | Embeds (iframe) | ❌ | CSP change + allowlist + dep |
| 60 | Bookmarks (URL card) | ❌ | — |
| 61 | Comments threads | ❌ | — |
| 62 | Realtime collaboration | ⏭ | spec's own skip list (shared-notes-only, not built) |
| 63 | Presence cursors | ⏭ | ships with #62 |
| 64 | Voice notes (Whisper) | ❌ | dep → approval |
| 65 | Handwriting canvas | ❌ | — |
| 66 | Graph view | ❌ | — |
| 67 | AI assist | ❌ | — |
| 68 | Pomodoro | ❌ | — |
| 69 | Web clipper | ❌ | browser extension — outside this repo |
| 70 | Recurring notes | ❌ | — |

## Tier 5 — Music-specific (71–85)

| # | Feature | Status | Where / evidence |
|---|---|---|---|
| 71 | Attach track to note | ✅ | music `Alt+M` rows 1–3 (playing / @time / search) |
| 72 | Inline track chip | ✅ | chips rail + `@<ms>` markers |
| 73 | Timestamp link `@2:34` | ✅ | marker seek on chip tap |
| 74 | Album review template | ✅ | template + rating/mood/replay parse-back |
| 75 | Lyric sheet | ✅ | `mm:ss` timestamped rows |
| 76 | Session log | ✅ | template + playback-clock timestamps |
| 77 | Chord snippets | 🟡 | monospace template; **no diagram rendering** |
| 78 | Stem annotations | ❌ | no stems feature exists in the app yet |
| 79 | Mood board | ✅ | album-art tile grid from attached tracks |
| 80 | Listening journal | ✅ | seeded from real play history |
| 81 | Playlist notes | ✅ | note ↔ playlist link |
| 82 | Artist bio notes | ✅ | JioSaavn `artist_overview`, editable |
| 83 | Compare takes | ✅ | two-embed template |
| 84 | Sample source log | ✅ | template |
| 85 | Remix notes | ✅ | template (BPM/key fields) |

## Fast wins — priority order for the remaining 32

**FAST** (minutes–hours, pure JS/CSS, zero new files, no approval):

| Order | # | What | Effort |
|---|---|---|---|
| 1 | 18 | ~~`font-variant-numeric: tabular-nums` on status bar~~ **done 2026-10-10** (UI polish pass) | — |
| 2 | 53 | bind `Ctrl+K` to the existing switcher (one keydown line) | minutes |
| 3 | 50 | `position: sticky` on preview headings | ≤1 h |
| 4 | 4 | `Ctrl+B/I/U` = wrap selection in markdown; add `_` underline | 1–2 h |
| 5 | 16 | empty-trash action row + manual purge (30-day check) | 1–2 h |
| 6 | 56 | word-goal marker + ring in footer | 2–3 h |
| 7 | 31 | 6 grayscale swatches on org store | 2–4 h |
| 8 | 48 | breadcrumb "Notepad › notebook › note" in panel header | 2–4 h |
| 9 | 42 | `[[Title]]` resolves via `allNotes()`, click opens | ½ day |
| 10 | 43 | backlinks: grep `[[this]]` across notes + panel line | ½ day |
| 11 | 32 | HTML5 drag-to-reorder on the tab strip / switcher rows | ½ day |
| 12 | 68 | pomodoro timer tied to focus mode | ½ day |
| 13 | 40 | clipboard image → vault → markdown link insert | ½–1 day |

**MEDIUM** (1–3 days): 41 attachments, 44 mentions, 45 drag handle, 46
block menu, 47 nested pages, 60 bookmarks, 65 canvas, 66 graph, 70
recurring, 77 chord diagrams, 16 auto-purge date check.

**LARGE / BLOCKED** (need approval or out of scope): 25 PDF (Rust crate),
57 KaTeX + 58 Mermaid (new deps — approval per README), 59 embeds (CSP),
64 voice (Whisper), 69 clipper (separate repo), 78 stems (no infra),
62/63 collab (skip-list by design).

## How to read this table

- "Verified" = the feature's code was located and read in the module, not
  just claimed by a phase doc. False-positive regex hits (e.g. `handled`
  matching "drag handle", `SUMMARY` tag matching "AI assist") were removed
  by inspection.
- All four modules are unit-green at handoff (`npm test` 403/403) and the
  panel was driven live in WebView2 today (chord probe + hotkey E2E in
  `govinda.md` §Report).
