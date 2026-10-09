# Devi — Phase 2: Organization & comfort

**Status:** Ready — start immediately (parallel with Govinda, Vijay,
Ganesha).
**Read first:** `README.md` (ownership, contract, protocol) and
`features.md` (Tier 1 #13–16, Tier 2 #19–35).

## Mission

Turn Govinda's raw tab pile into an **organized notebook**: find any note by
its content, sort/pin/trash it, tag it, shelve it in notebooks, favorite it,
export it, template it. Everything you add hangs off the frozen contract —
you never edit the core.

## Owned files (write)

| File | Role |
| --- | --- |
| `app/src/notepad-org.js` | `initNotepadOrg(core)` — all organization features |
| `app/src/notepad-org.css` | Your styles (injected inside `init`) |
| `app/tests/notepad-org.test.mjs` | Your test |
| `app/tests/_probe-notepad-devi.mjs` | Your probe (untracked) |
| `docs/notepad/devi.md` | This doc |

**Forbidden:** README §1 in full — `notepad.js`/`notepad.css` (Govinda),
`notepad-blocks.*` (Vijay), `notepad-music.*` (Ganesha), `index.html`,
`styles.css`, `core.js`, `library.js`, `CHANGELOG.md`, `AGENTS.md`, git
mutations, installs, `npm run css`.
Storage key: **`tm-notepad-org`** only. CSS/ids prefix: **`npdo-`** only.

## Contract surface you use

`core.on(...)`, `core.mount("side"|"tabmeta"|"overlay")`,
`core.activeNote()`, `core.allNotes()`, `core.newNote(name, content)`,
`core.openNote(id)`, `core.closeNote(id)`, `core.refresh()`,
`core.setNoteContent`, `core.addSwitcherFilter(fn)`,
`core.on("keydown", …)` (cancelable — claim your chords BEFORE core's map),
`core.toast`, `core.diag`. Overlay rule: create your **own** `npdo-` child
inside `#npd-overlay`. Switcher rows you return may carry `hint` (rendered
as a second line — put snippets/tags there).

## Sidecar schema (`tm-notepad-org`, yours alone)

```js
{ tags:    { [noteId]: ["tag", …] },
  notebooks: [{ id, name }], noteBook: { [noteId]: notebookId },
  fav:     { [noteId]: 1 },
  trashed: { [noteId]: deletedAtMs },
  recent:  [noteId, …],          // most-recently-opened first, cap 10
  prefs:   { fontSize: 14|16|18|20, lineHeight: 1.4|1.6|1.8 } }
```

## Tasks (each accepted by its check)

1. **Store + hygiene.** Load/heal/corrupt-safe sidecar; prune ids that no
   longer exist in `core.allNotes()` on open. *Check: test round-trip +
   prune.*
2. **Switcher filter stack** (`features.md` #13/#14/#15/#16/#34):
   - search **content** as well as name (query terms; match → `hint` =
     first matching line, trimmed ~60 chars);
   - sort modes cycled by `Alt+R`: recently-edited (default) → created
     (id prefix/order) → A–Z;
   - pinned first (#15): pin flag in your sidecar; pins float above the sort;
   - trash filter (#16): `trashed` ids excluded from all results;
   - recents (#34): when query empty, a `Recent` group from `recent[]`.
   *Check: test drives filters over a fixture note set (5 notes, tags,
   trash) and asserts order/visibility/hints.*
3. **Trash & delete (#16).** Claim `Delete` via the keydown relay while the
   switcher is open → soft-delete into `trashed` + close tab + toast (no
   dialog). Restore path: `Alt+R`'s last mode = `Trash` (rows show original
   names; Enter restores, `Delete` again = permanent drop). *Check: test
   covers soft-delete → invisible → restore → visible; core's hard-delete
   never runs when your module is loaded.*
4. **Tags (#19).** Parse `#tag` words in the content on save (subscribe
   `saved`); badges render in `#npd-tabmeta`; switcher query `#foo` filters
   by tag; tag rows listed at the bottom of your notebook rail. *Check: test
   parses edge cases (escaped `\#`, inside code fence is skipped — simple
   fence toggle, no full parser) + filter.*
5. **Notebooks (#20).** One-level list in `#npd-side`: All / Unfiled /
   each notebook; keyboard: select with `↑↓` when rail focused, `Enter`
   scopes the switcher to that notebook (closed scope shows in the query
   line as `notebook: X`); create/rename/delete via an inline prompt row in
   your rail (input + Enter/Esc — no native `prompt()`); move active note to
   selected notebook with `Enter` when scope matches? — keep: `Ctrl+←/→` is
   forbidden (queue) → use `Enter`-on-scoped-list + `Delete` on a focused
   notebook only with confirmation-less toast + undo toast? No dialogs:
   `Delete` on notebook files it to Unfiled, does not destroy notes. *Check:
   test covers move/scope/file-on-delete.*
6. **Favorites (#21).** `Alt+…` — no free chord needed: favorite toggles from
   the rail (★ on the active note row) + `fav` notes get a `★` in tabmeta
   and sort above pinned only when query is empty... keep simple: badge +
   switcher `fav:` prefix query. *Check: test.*
7. **Export #22/#23/#24 — `Alt+E`.** Menu in your overlay child: Markdown /
   Text / HTML → Blob + `<a download>` (gesture comes from the keydown).
   Markdown export preserves headings/lists/checkboxes verbatim (content IS
   markdown-ish text); HTML export wraps it with inline CSS using the
   palette tokens; **self-contained, no CDN** (tailwind.test gate). *Check:
   test builds an export string from a fixture and asserts structure +
   absence of `http` in the HTML shell.*
8. **Import #26 — `Alt+I`.** `<input type="file" accept=".md,.txt">`
   (clicked synchronously inside your keydown handler) → FileReader →
   `core.newNote(basename, text)`. Paste path: a `paste` listener on
   `core.textarea()` is **not yours** (Vijay owns input rules) — import via
   file only; note the decision here. *Check: test with a synthetic
   File/Blob.*
9. **Templates #27.** Pseudo-rows contributed through your switcher filter:
   `+ Template: Daily Journal | Album Review | Session Log | Lyric Sheet |
   Blank` — Enter → `core.newNote(title, TEMPLATE)` (content literals in
   your module; the Album Review/Session Log/Lyric Sheet texts you and
   Ganesha both want: **you own the template text**, Ganesha only links to
   them — coordinate by his doc referencing yours). *Check: test.*
10. **Duplicate #35 + recents rail #34.** Pseudo-row `Duplicate this note`
    (copies name `… (copy)` + content into a new note, opens it); recents
    already in filter stack. *Check: test.*
11. **Font size / line height #28/#29.** Small control block at the bottom
    of `#npd-side` (segmented `14 16 18 20` and `1.4 1.6 1.8`, clickable
    labels = allowed in-panel; keyboard `+`/`-` changes size when panel
    focused and no input has focus — relay-claimed). Applies via inline
    style on `core.panel()`, persisted in `prefs`. *Check: test prefs
    round-trip + applied style.*
12. **Probe + evidence.** `_probe-notepad-devi.mjs` (CDP, after core lands):
    create → tag → search by content → pin → trash → restore → export →
    template. Paste transcript; if core hasn't landed, mark `PENDING` and
    finish last (README §3.6).

## Chords you own

`Alt+E` (export) · `Alt+I` (import) · `Alt+R` (sort/trash cycle) · `+`/`-`
(font size, conditional). Claim only through `core.on("keydown")`.

## Limits

- Never write a key other than `tm-notepad-org`; never read-modify-write
  `tm-notepad`.
- No dialogs (`prompt/confirm/alert`), no native file save dialogs (no
  Rust), no network.
- No new colors; dark parity for everything you render (`html.dark` +
  README §2.4 tokens).
- If a task needs `library.js`/`home.js`/`settings.js` or any forbidden
  file → `BLOCKED:` in your Report, don't touch it.

## Behavior added

Everything below is implemented in `app/src/notepad-org.js` (pure, exported
functions + one `initNotepadOrg(core)` wiring layer) and unit-tested in
`app/tests/notepad-org.test.mjs` against a **fake `core`**. Storage key
`tm-notepad-org`; CSS/ids prefix `npdo-`. No core file is read-modify-written;
no dialogs; no network; no new colors (palette tokens + `html.dark` only).

### Sidecar store (`tm-notepad-org`)

- Shape: `{ tags, notebooks, noteBook, fav, trashed, pinned, recent, prefs }`
  — `pinned` added to the schema in devi.md §Sidecar (needed by #15).
- `loadStore(raw)` / `healStore(obj)`: JSON-safe, field-by-field healing.
  Corrupt JSON or wrong types fall back to `defaultStore()`; never throws.
- `pruneStore(store, notes)`: on panel `open`, drops every per-note entry
  (tags / noteBook / fav / pinned / trashed / recent) whose id is no longer a
  key of `core.allNotes()`. `recent` also re-capped to 10.
- `serializeStore` / persist: written only to `tm-notepad-org`.

### Switcher filter stack (`addSwitcherFilter`)

Single engine `filterNotes({ query, rows, notes, store, sortMode,
scopeNotebook })` handles #13/#14/#15/#16/#19/#21/#34 and the notebook scope:

- **Content search (#13):** every whitespace term must match the note name
  *or* body. Ranked: exact name > name-prefix > name-contains > body-contains.
  A body match sets `hint` to the first matching line, trimmed ~60 chars with
  an ellipsis.
- **Sort modes (#14), cycled by `Alt+R`:** `recent` (default, by `updated`
  desc) → `created` (by id ascending, a creation-order proxy — ids are
  opaque; documented here) → `az` (name) → `trash`. `cycleSortMode` wraps.
- **Pinned float (#15):** `store.pinned[id]` rows sort above the active mode's
  order in every non-trash mode.
- **Trash (#16):** non-trash modes exclude `trashed` ids entirely; the `trash`
  mode shows *only* trashed rows, newest-deleted first, hint `Trash — Enter
  restores`.
- **Recents (#34):** query empty + `recent` mode → a `Recent` group floated to
  the top in `store.recent` order (rows carry `group:"Recent"`); re-centred on
  every `note` event.
- **Tags (#19):** `#foo` in the query filters to notes tagged `foo` (all tags
  must match). Rows with tags and no body hint show `#tag …` as the hint.
- **Favorites (#21):** `fav:` query token filters to `store.fav` notes.
- **Notebook scope (#20):** `notebook: X` in the query *or* the rail's
  `scopeNotebook` restricts to that notebook; `Unfiled` = no `noteBook` entry.

### Action pseudo-rows (templates + duplicate)

`filterNotes` prepends action rows when the query is empty (or matches):
`+ Duplicate this note` (`pseudo:"duplicate"`) and one
`+ Template: <Name>` per name in `TEMPLATES` (`pseudo:"template"`). These
ids are `npdo-dup` / `npdo-tpl:<Name>`; when core's switcher opens one (its
"creates if no match" path), the `note` handler intercepts the id, calls
`applyAction` → `core.newNote(...)` for the real note, closes the placeholder
and opens the result. Duplicate copies the last *real* active note's content
and appends `(copy)`; templates seed `core.newNote(title, TEMPLATE)`.

### Trash & delete (#36 — soft)

`Delete` is claimed through the cancelable `keydown` relay **only when focus
is not in the editor** (`typingInEditor()` guard) — so it never steals text
deletion. Claiming calls `preventDefault()`, which is the contract's signal
for core to skip its own hard-delete binding. `softDeleteNote` sets
`trashed[id]=now`, `closeNote`, toasts. Opening a trashed note (from `trash`
mode) restores it via the `note` handler. Permanent drop is core's domain (no
`deleteNote` in the frozen contract) — noted as a contract gap, not hacked
around.

### Notebooks (#20), favorites (#21), tags (#19) — rail + badges

- `listNotebooks` returns `All / Unfiled / <each>`; `createNotebook`,
  `renameNotebook`, `deleteNotebook` (re-files its notes to Unfiled — never
  destroys notes), `fileNote`.
- Side rail (`core.mount("side")`): notebook rows (↑↓ select, Enter scopes the
  switcher, Delete files the notebook to Unfiled + toast), an inline input row
  for create/rename (Enter/Esc, no native `prompt()`), the tag list at the
  bottom, and the font/line control block.
- `#npd-tabmeta` badges: `★` fav, `▲` pinned, `#tag` chips — repainted on
  `saved` / `note`.

### Export (#22/#23/#24) — `Alt+E`

`Alt+E` opens an `npdo-` menu in your overlay child: Markdown / Text / HTML.
`exportMarkdown` / `exportText` return the body verbatim (content *is*
markdown-ish); `exportHtml` wraps it via `renderMdToHtml` (headings, lists,
checkboxes, blockquote, hr, code fence, bold/italic) with an inline `<style>`
built from palette tokens — **self-contained, no CDN, no `http`**. Download is
Blob + `<a download>` (gesture from the keydown).

### Import (#26) — `Alt+I`

`Alt+I` synchronously clicks a hidden `<input type="file" accept=".md,.txt">`;
`FileReader` → `importFileText(core, filename, text)` →
`core.newNote(basename, text)`. **File-only by decision** — a `paste` listener
on `core.textarea()` is Vijay's (input rules); not intercepted here.

### Templates (#27) — owned texts

`TEMPLATES` (in-module literals) = `Daily Journal`, `Album Review`,
`Session Log`, `Lyric Sheet`, `Blank`. **Devi owns these texts**; Ganesha's
Alt+M rows reference them verbatim (see `ganesha.md` task 5).

### Font size / line height (#28/#29)

Control block at the bottom of the rail: segmented `14/16/18/20` and
`1.4/1.6/1.8` labels (clickable). Keyboard `+`/`-` steps `FONT_SIZES` when no
input has focus (relay-claimed). `applyPrefs` writes inline
`font-size`/`line-height` on `core.panel()` (falls back to the textarea);
persisted in `store.prefs` and reapplied on init.

## Success criteria

- [x] Find a note **by its body text** from the keyboard alone, ranked,
      with `hint` snippets.
- [x] Sort cycles (3 modes), pinned float, trash hides/restores, recents
      show — all through the switcher, all unit-tested.
- [x] Tags parse + badge + `#tag` filter; notebooks scope the switcher;
      favorites badge — sidecar only.
- [x] Export produces `.md`/`.txt`/`.html` downloads; import creates notes
      from files; 5 templates create notes; duplicate works.
- [x] Font/line prefs persist and reapply on next open.
- [x] `notepad-org.test.mjs` green, `node --check` + `npm run lint` clean,
      full `npm test` green (or `FOREIGN RED:` documented).
- [ ] Dark-mode spot check + probe transcript (or `PENDING` + plan).

## Report

**LANDED:** `app/src/notepad-org.js` (pure engine + `initNotepadOrg` wiring),
`app/src/notepad-org.css`, `app/tests/notepad-org.test.mjs`. All 11 code tasks
implemented; every behaviour documented above in `## Behavior added`.

**Gates (one-liners):**
- `node --check app/src/notepad-org.js` — clean.
- `node --check app/tests/notepad-org.test.mjs` — clean.
- `npx eslint src/notepad-org.js` — clean (exit 0).
- `node --test app/tests/notepad-org.test.mjs` — **30/30 pass**.
- Full `npm test` — 359 pass / 19 fail; **0 failures in `notepad-org.test.mjs`**.
- `npm run css` — **not run** (forbidden; no `tailwind` classes used — my CSS
  is a standalone `notepad-org.css` injected inside `init`).

**Chords implemented:** `Alt+E` (export menu) · `Alt+I` (import file) ·
`Alt+R` (sort/trash cycle) · `+`/`-` (font size, conditional on no focused
input). All claimed through `core.on("keydown")` with `preventDefault()`.

**Contract gap (not a BLOCKER, behavior chosen + documented):** permanent
delete of a note is core's domain — the frozen contract exposes no
`deleteNote`, so `Delete` in the switcher **soft-deletes** (into `trashed`);
restore is Enter-from-trash-view. Core's hard-delete is claimed-away by my
`preventDefault()` (per devi.md task 3: "core's hard-delete never runs when
your module is loaded"). If Govinda adds a `deleteNote(id)` later, wiring
permanent drop is a 2-line change in `handleKeydown`.

**Another contract note:** `core.panel()` (used by task 11) is not in
README §2.2's frozen `core` object. I feature-detect it (`typeof core.panel ===
"function"`) and fall back to `core.textarea()`, so it works either way.

**FOREIGN RED (other agents' WIP — not touched, per protocol §3.3):**
- `app/src/notepad.js:90` — `no-useless-assignment` on `raw` (Govinda's core,
  blocks `npm run lint` for everyone; one-line fix in her lane).
- `app/tests/notepad-blocks.test.mjs` — 18 failures (Vijay's WIP).
- `app/tests/notepad-music.test.mjs:424` — 1 failure, `npdm-` namespace leak
  of `css`/`selected` selectors (Ganesha's WIP).

**BLOCKED:** none.

**Probe — `PENDING` (README §3.6).** `_probe-notepad-devi.mjs` cannot run yet:
Govinda's `notepad.js` / the panel have not landed, so there is no real
`core`, no switcher DOM and no `Ctrl+P` surface to drive over CDP. My module
is fully unit-tested against a fake `core` in the meantime (30 assertions,
including an init-wiring test that registers the real switcher filter and
calls it). **Plan once core lands:** drive the real panel over CDP
(`--remote-debugging-port=9222`) — create note → tag by typing `#tag` →
search by body text (assert `hint` snippet) → `Alt+R` cycle → pin → `Delete`
(soft) → `Alt+R` to trash → Enter restore → `Alt+E` export `.html` (assert no
network) → `Alt+R` to a template row → Enter creates note — and paste the
transcript here. Dark-mode spot check rides the same probe (`html.dark`
toggle).
