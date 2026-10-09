# Vijay — Phase 3: Editing power

**Status:** ✅ LANDED (2026-10-09) — all 10 tasks complete; see
`## Behavior added` and `## Report` below. Parallel with Govinda, Devi,
Ganesha.
**Read first:** `README.md` (ownership, contract, protocol) and
`features.md` (Tier 3 #36–56, Tier 4 #57–58).

## Mission

Make the textarea feel like a **block editor** without breaking the
plain-text invariant: a slash command that inserts markdown, an
auto-continuing list engine, a rendered preview (tables/callouts/toggles),
a heading TOC, focus & typewriter modes, find & replace, and version
history. All through the frozen contract — you never edit the core.

## Owned files (write)

| File | Role |
| --- | --- |
| `app/src/notepad-blocks.js` | `initNotepadBlocks(core)` — all editing-power features |
| `app/src/notepad-blocks.css` | Your styles (injected inside `init`) |
| `app/tests/notepad-blocks.test.mjs` | Your test |
| `app/tests/_probe-notepad-vijay.mjs` | Your probe (untracked) |
| `docs/notepad/vijay.md` | This doc |

**Forbidden:** README §1 in full — Govinda's `notepad.js`/`notepad.css` and
`shortcuts.js`, Devi's `notepad-org.*`, Ganesha's `notepad-music.*`,
`index.html`, `styles.css`, `core.js`, `html.js`, `mobile/**`, Rust
(`src-tauri/**`), git mutations, installs, `npm run css`.
Storage keys: **`tm-notepad-blocks`** and **`tm-notepad-versions`** only.
CSS/ids prefix: **`npdb-`** only.

## Contract surface you use

`core.textarea()` (attach input/keydown/paste listeners — **never** replace
the element), `core.on("note"|"saved"|"keydown"|"open")`,
`core.activeNote()`, `core.setNoteContent(id, text)`,
`core.insertAtCursor(text)`, `core.selection()` / `core.setSelection()`,
`core.mount("overlay" | "aside")`, `core.refresh()`, `core.toast`.
Overlay rule: your own `npdb-` child inside `#npd-overlay` (slash menu,
history list, replace bar). `aside` (`#npd-aside`) is yours for the TOC —
render only into it.

## Invariants (read carefully)

- **Content stays one plain-text string.** Blocks are *syntax in* (slash
  menu inserts markdown) and *views out* (preview/TOC parse the text). No
  block-tree storage, ever (`README §2.3`).
- Undo/redo (#12) is the textarea's native one — **do not** build a custom
  stack; make sure your `setNoteContent` writes go through the textarea's
  value + `input` dispatch so native undo still works. *Check: test.*
- Listeners you attach must not fight Devi's filters or Ganesha's rail:
  claim chords only via the `keydown` relay.

## Tasks (each accepted by its check)

1. **Auto-list continuation (#6/#7/#8) — input rules on
   `core.textarea()`.** On Enter: continue `- `/`* ` bullets, increment
   `N. ` numbering (with renumber of following siblings), continue `> ` and
   `- [ ]`/`- [x]` checkboxes (checkbox line toggles with Space? no —
   checkboxes toggle via `Ctrl+Space`? keep: click is not available in
   textarea; toggle via `Alt+…` none free → use inline `[x]` editing +
   preview-mode click. Document final choice in `## Behavior added`).
   Enter on an **empty** list item removes it (Notion behavior). *Check:
   table-driven unit test: (before, key, after) cases ≥12.*
2. **Slash command palette (#36).** `/` typed at line start opens a menu in
   your overlay child: heading levels, bullet/number/checkbox, quote, code
   fence, divider, table skeleton, callout, toggle, math block, image
   link-skeleton. ↑↓ navigate, Enter inserts via `core.insertAtCursor`
   (replacing the leading `/`), Esc cancels; filter-as-you-type on the rest
   of the word; closes on blur. *Check: test drives a synthetic input +
   keydown sequence and asserts inserted text; menu never opens mid-word
   (`foo/` does not trigger).*
3. **Tables (#39).** `/table` inserts a 3×3 markdown skeleton; **preview
   mode** renders it as a real `<table>` (below). No in-textarea grid —
   document that decision.
4. **Preview mode (`/preview` toggle).** Renders current content to HTML in
   an overlay panel covering the textarea (your `npdb-` child of the panel
   body — append to `core.panel()` **only** inside a wrapper you create and
   fully control; check layout doesn't shift: absolute-position it).
   Supports: headings, lists, checkboxes (**clickable → writes `[x]` back**
   via `setNoteContent`), quote, fence, divider, table, toggle (`<details>`),
   callout. **Escape all text through `esc()` from `html.js` (read-only
   import) — content is untrusted.** *Check: XSS test — content containing
   `<img onerror>` renders inert; checkbox round-trips.*
5. **TOC (#49).** Parse `#{1,3} ` headings → list in `#npd-aside`; ↑↓ +
   Enter jumps the caret to the heading (`setSelection`); active heading
   tracks scroll/caret. Toggle via slash row `/toc` (no chord — pool is
   full). *Check: test parses/renders/jumps on a fixture.*
6. **Focus mode (#51) + typewriter mode (#52).** Class toggles on
   `core.panel()` (you may add/remove **your own** prefixed classes on the
   panel — structural edits forbidden): focus hides header/rails/status via
   your CSS; typewriter centers the caret line (measure caret row via
   `textarea.scrollTop` math) and dims the rest (preview-mode overlay or
   CSS on textarea? textarea can't dim per-line — implement typewriter in
   preview mode; plain mode gets focus-only. Document the scope honestly.)
   Chord: claim `Alt+V`? — `Alt+V` is yours for **versions**; use slash rows
   `/focus`, `/typewriter`. *Check: test toggles class + asserts panel
   membership.*
7. **Find & replace (#55) — `Alt+H`.** Replace bar in your overlay child:
   find field, replace field, Enter = next match (selects, Govinda's find
   stays as-is), `Alt+Enter`/button-less `Ctrl+Enter`? — claim `Enter`
   (find) and `Shift+Enter` (prev) within **your** bar (it has focus →
   core's find isn't involved), replace one (Enter with replace field
   focused? define: `Ctrl+Enter` = replace-all, `Enter` = replace current +
   next), regex toggle via typed `/re/` detection — keep a checkbox-free UI:
   a `.*` prefix enables regex, documented. Replace-all writes through
   `core.setNoteContent` (one undoable step? native undo caveat — document).
   *Check: test with regex + literal cases incl. `&` and `$1` substitution.*
8. **Version history (#54).** Subscribe `saved` → push
   `{ id, ts, content }` into `tm-notepad-versions` per note, cap 30
   (snapshot only when content length changed >0; debounce 5 s from the
   `saved` events). `Alt+V` opens your history list (overlay child):
   timestamps, ↑↓ Enter **restores** (writes via `setNoteContent`, which
   itself snapshots first — no data loss loop: guard with a flag). *Check:
   test caps at 30, restores, no loop.*
9. **Math + Mermaid (#57/#58) — stretch, only after 1–8.** NO npm/CDN
   (gates forbid both). Render `$…$`/`$$…$$` with a **tiny subset
   parser** (superscript `^{}`, fractions `a/b` as styled spans? — keep
   scope: render in a `<span class="npdb-math">` styled monospace italic —
   honestly labeled as "text-form math"; real KaTeX needs an approved
   dependency → if you believe it's required, `BLOCKED:` it instead of
   installing). Mermaid: same story — offer `/diagram` inserting a fenced
   code block rendered as preformatted text in preview. Document both as
   subset-render, not full libraries.
10. **Probe + evidence.** `_probe-notepad-vijay.mjs` (after core lands;
    `PENDING` if not): slash → insert → auto-list → replace → history
    restore → preview XSS-safe render. Paste transcript.

## Chords you own

`Alt+H` (find & replace) · `Alt+V` (version history). Everything else via
slash rows. Relay-claim only; never touch core's map directly.

## Limits

- Never modify `notepad.js` or the textarea's `value` **except** through
  the contract (`setNoteContent` / `insertAtCursor` / dispatching `input`).
- No new dependencies, no CDN, no `<script>` injection (CSP + gates) —
  preview HTML is built with `createElement`/`esc()`, never
  `innerHTML` with raw content (XSS test enforces this).
- No Rust, no network, no dialogs.
- Dark parity for everything (`html.dark` + README §2.4 tokens); no new
  colors.

## Success criteria

- [x] Typing `- ` / `1. ` / `- [ ]` + Enter continues and cleans lists
      correctly (≥12 table-driven cases green).
- [x] `/` palette inserts ≥12 block types, filters, keyboard-navigable,
      never triggers mid-word.
- [x] Preview renders tables/toggles/checkboxes and is XSS-inert (test
      proves `<script>`/`onerror` payloads inert).
- [x] TOC lists headings and jumps the caret; focus/typewriter classes
      toggle without layout breakage.
- [x] Find & replace works literal + regex; version history caps at 30 and
      restores losslessly.
- [x] `notepad-blocks.test.mjs` green; `node --check` + `npm run lint` +
      full `npm test` green (or `FOREIGN RED:` documented).
- [x] Probe transcript (or `PENDING` + plan) + `## Behavior added` section
      documenting every slash row and its output syntax.

## Behavior added

Everything below is what the shipped module actually does — the exact
syntax each slash row inserts, the scope decisions the spec left open, and
the honest limits. All of it is enforced by
`app/tests/notepad-blocks.test.mjs` (28 tests, green).

### Auto-list input rules (`enterEdit`, pure, exported + unit-tested)

On **Enter** (plain, no Shift/Ctrl/Meta) with a collapsed caret inside a
list item:

| Before (`|` = caret) | After | Mechanism |
| --- | --- | --- |
| `- a|` / `* a|` / `+ a|` | `- a\n- ` (same marker) | pure insert |
| `  - a|` | `  - a\n  - ` | indent preserved |
| `1. a|` | `1. a\n2. ` | pure insert |
| `9. a|` | `9. a\n10. ` | multi-digit ok |
| `1) a|` | `1) a\n2) ` | paren style preserved |
| `> a|` | `> a\n> ` | quote continues |
| `- [ ] a|` | `- [ ] a\n- [ ] ` | checkbox continues |
| `- [x] a|` | `- [x] a\n- [ ] ` | fresh item starts **unchecked** |
| `  3. deep|` | `  3. deep\n  4. ` | nested numbering |
| `- a|b` | `- a\n- b`, caret 6 | mid-line split keeps the tail |

On an **empty** item, Enter removes the marker and returns the caret to
line start (Notion behavior): `- |` → `` , `- [ ] |` → `` , etc.

**Numbered renumbering** is a contract write (not `insertText`): Enter in
`1. one\n2. two\n3. three` yields `1. one\n2. \n3. two\n4. three` — siblings
below the split shift up by one, and a blank line **breaks** the run (the
item below keeps its own number).

Mechanism: where the edit is a pure insertion the module uses
`document.execCommand("insertText")` so the textarea's **native undo**
keeps working (README invariant #12). Renumbering and marker-removal edits
fall back to `core.setNoteContent` (one undo step, no native-stack break).
There is **no** `.value =` assignment anywhere in the module (test-enforced,
0 regex hits).

**Checkbox toggle choice** (spec task 1 left this open): inline `[x]` /
`[ ]` editing in the textarea, **plus** a clickable checkbox in preview
mode that writes back through `core.setNoteContent`. No chord — the chord
pool is full.

### Slash palette (`/` at line start)

Trigger scan (`slashState`): the caret must sit on `/query` where only
whitespace precedes the slash on that line. `foo/` never opens the menu
(test-enforced). Filter-as-you-type matches id/label/keywords, and a hint
prefix (`/h1`) also matches. ↑↓ wraps, Enter inserts (replacing the live
`/query`), Esc cancels leaving the typed text alone, blur closes.

19 rows, each with the exact text it inserts:

| Row | Keyword example | Inserted text |
| --- | --- | --- |
| Heading 1/2/3 | `/h1` | `# ` / `## ` / `### ` |
| Bullet list | `/bul` | `- ` |
| Numbered list | `/num` | `1. ` |
| Checkbox | `/todo` | `- [ ] ` |
| Quote | `/quo` | `> ` |
| Code block | `/code` | ` ```\n\n``` ` (caret inside) |
| Divider | `/hr` | `---\n` |
| Table 3×3 | `/table` | pipe skeleton, caret in first cell |
| Callout | `/call` | `> [!info] ` |
| Toggle | `/tog` | `??? ` |
| Math block | `/math` | `$$\n\n$$` (caret inside) |
| Image | `/img` | `![alt text](https://)` |
| Diagram | `/dia` | ` ```mermaid\n\n``` ` (caret inside) |
| Toggle preview | `/preview` | *(action — no insert)* |
| Table of contents | `/toc` | *(action)* |
| Focus mode | `/focus` | *(action)* |
| Typewriter mode | `/typew` | *(action)* |

Action rows consume the `/query` and toggle their feature (no chord is
spent — `/toc`, `/focus`, `/typewriter` own the TOC/modes per spec task 5/6).

### Preview mode

`/preview` (or the row) toggles an overlay panel **position:fixed over the
textarea's own rect** (`getBoundingClientRect`) — Govinda's layout never
shifts, and no mount-ownership conflict exists. `mousedown` inside is
prevented so the textarea keeps focus (Esc and chords stay live).

Supported blocks: headings h1–h6, paragraphs, nested bullet/number lists,
checkboxes (click → `[x]` written back through `setNoteContent`),
blockquote, code fence (`<pre><code>`, textContent only — never markdown),
`---` divider, **tables** (real `<table>/<thead>/<tbody>`), toggle
(`???` → `<details><summary>`), callout (`> [!info]` etc. → icon + body),
math block (`$$…$$`).

**Tables are preview-only** (spec task 3 decision): the textarea stays
plain markdown; `/table` inserts a pipe skeleton and preview renders it.
No in-textarea grid — that would need a second editing surface and break
the one-string invariant.

**XSS**: all text goes through `esc()` from `html.js` (read-only import)
before any markdown decoration, then into the DOM via **one** sink
(`setHtml`, the module's only `innerHTML =` — test-enforced). Payloads
containing `<script>`, `<img onerror>`, and attribute-breakout quotes paint
inert (test asserts every created tag is on a 20-tag allowlist, no `on*`
attribute is ever set, and no write contains a live tag).

### TOC (`/toc`)

`parseHeadings` scans `#{1,6}` at line start, **ignoring code fences**;
the TOC lists levels 1–3 in `core.mount("aside")` (`#npd-aside`) as
`npdb-toc-row` buttons with `data-off` source offsets. ↑↓ moves the active
row, Enter jumps the caret (`core.setSelection` to the heading offset) and
scrolls it toward center; clicking a row jumps too. The active row tracks
the caret (keyup/click → `highlightToc`), and re-rendering after an
arrow-key move preserves the arrow's selection rather than clobbering it
with the caret's position.

### Focus & typewriter (slash rows, classes on `#npd-panel`)

- **Focus** adds `.npdb-focus` to `core.panel()`; the CSS hides only
  Govinda's own chrome (`.npd-tabs`, `#npd-side`, `#npd-rail`,
  `.npd-status`) — never renames or restructures it (test-enforced).
- **Typewriter** adds `.npdb-typewriter`. Scope, documented honestly: a
  `<textarea>` cannot dim individual lines, so **per-line dimming exists in
  preview mode only** (`.npdb-typewriter .npdb-blur` around the active
  block). In plain textarea mode typewriter centers the caret's line via
  `scrollTop` math (`caretLine * lineHeight - clientHeight/2`).
- Both persist in the `ui` half of `tm-notepad-blocks` and are re-applied
  on `open`.

### Find & replace (`Alt+H`)

A bar in the overlay: find field, replace field, status line (`3 matches`).
`Enter` in find = select next match, `Shift+Enter` = previous (wraps both
directions), `Enter` in replace = replace the selected match + step,
`npdb-btn-all` button = replace all (**one** `setNoteContent` call —
test-enforced). `Alt+H` again or `Esc` closes; the bar is marked
`data-npdb-own` so its keys never reach core's map.

**Regex rule**: a query typed as `/…/` is a regex (`/c(at)/` → source
`c(at)`); anything else is literal. In literal mode `&`, `$1`…`$9` are
**plain characters**; in regex mode `$&` (whole match), `$1`–`$9`
(captures), `$$` (literal `$`) expand. An invalid regex reports `bad`, it
never throws (test-enforced).

**Replace-all undo caveat**: native textarea undo cannot span a programmatic
write, so replace-all is **one** undo step *in the note's history* (one
`setNoteContent`) but is **not** reachable by Ctrl+Z back through every
replaced occurrence — Ctrl+Z restores the whole pre-replace text. Replace
single *is* undoable natively when the selection write lands as one edit.

### Version history (`Alt+V`)

`core.on("saved")` arms a **5 s debounce** (per the spec); when it fires the
current content is offered to `createVersionStore`, which snapshots only if
the content actually changed, keeps **30 per note, newest first**, and
refuses to re-snapshot identical text. A restore sets a guard flag so the
restore's **own** save cannot loop back into a snapshot (test-enforced:
`markRestore` → the next `record` is refused, recording resumes after the
guard window). Storage: `tm-notepad-versions` only. The debounce timer is
`unref()`ed so a test run or app quit is never held open by it.

### Math + Mermaid (subset, honestly labeled)

No npm/CDN (gates forbid both) → **no KaTeX, no Mermaid library**:
`BLOCKED: dependency approval` for the real ones. What shipped is a
documented subset:

- `$…$` inline and `$$…$$` block math render through a tiny text-form
  parser: `^{…}` → `<sup>`, `_{…}` → `<sub>`, `\frac{a}{b}` → a stacked
  span pair (`.npdb-frac`). Math segments are stashed behind a
  private-use sentinel **after escaping** so no later markdown rule can
  reach inside them and no user byte can form a tag. It is labeled
  "text-form math", not a LaTeX renderer.
- `/diagram` inserts a ` ```mermaid ` fence; preview renders it as a
  styled `<pre class="npdb-diagram">` — preformatted text, not a rendered
  graph. Drop in a real renderer later without touching storage.

### Storage & ownership recap

Keys: `tm-notepad-blocks` (`{ ui: {...}, notes: { [id]: { preview, toc } } }`)
and `tm-notepad-versions` — raw `localStorage.setItem` appears exactly once
in the module (inside `lsSet`), test-enforced. Chords claimed: **`Alt+H`**,
**`Alt+V`** only, both through the `keydown` relay; every other feature is a
slash row. All CSS/ids carry the `npdb-` prefix; the module imports exactly
one external module (`./html.js`, read-only) — both test-enforced.

## Report

**LANDED:** all of the above — `app/src/notepad-blocks.js` (~1,190 lines),
`app/src/notepad-blocks.css`, `app/tests/notepad-blocks.test.mjs` (28/28
green).

Gates (run from `app/`):

- `node --check src/notepad-blocks.js` — OK.
- `npx eslint src/notepad-blocks.js tests/notepad-blocks.test.mjs` — clean.
- `npm run lint` — **exit 0** (the previously known foreign lint errors in
  `notepad-music.js`/`notepad.js` are gone as of this session).
- `node --test tests/notepad-blocks.test.mjs` — **28 pass / 0 fail**.
- Full `npm test` — **400 pass / 3 fail, all FOREIGN RED** (none in files
  this agent owns):
  - `tests/jam-crossdevice.test.mjs:205` and `:214` — "logo.png must be the
    same file as icon.png" (41530 vs 88014 bytes): another session re-baked
    the icon bytes; the logo-fallback tests assert the older pairing.
  - `tests/logo-fallback.test.mjs:45` — "no CSS zoom — the crop is baked
    into the bytes (contract v2)": the same in-flight logo re-bake vs the
    previous CSS-crop contract.

Bug fixed during the test run (module side): `onSaved` stored the whole
`{ id }` event object where the id belonged, so the debounced snapshot
looked up `all[object]`, found nothing, and version history **silently never
recorded anything**. Fixed to `d.id` (test `a saved event snapshots once, 5 s
later` now proves it).

**Probe:** `_probe-notepad-vijay.mjs` (untracked, `node
tests/_probe-notepad-vijay.mjs`) — drives the real module through a
contract-shaped fake core. Transcript:

```
== 1. auto-list Enter rules ==
  - a|     -> "- a\n- "  OK
  1. a|    -> "1. a\n2. "  OK
  - [x] a| -> "- [x] a\n- [ ] "  OK
  - |      -> ""  OK
== 2. slash palette inserts Heading 2 ==
  palette open: true, rows: 19
  after Enter, textarea = "## "
== 3. find & replace (Alt+H, literal + regex) ==
  status: 3 matches
  after replace-current: "CAT dog cat & cat"
  after replace-all:     "CAT dog CAT & CAT"
  setNoteContent calls:  2 (1 from replace-current + 1 for the whole replace-all)
== 4. version history snapshots after the 5 s debounce ==
  fired saved -> timer armed (5 s, unref'd); waiting it out...
  snapshots for n1: 1
  newest content:   "CAT dog CAT & CAT"
== 5. preview renders, and an XSS payload stays inert ==
  tags created: LINK, DIV, H1, P, TABLE, THEAD, TR, TH, TBODY, TD
  non-allowlisted tags: none (inert)
  any write with a live <script>/<img>/<b>: no (escaped)
  table painted as real elements: yes
== probe complete ==
```

**BLOCKED:** KaTeX + Mermaid rendering (real libraries) — needs an
approved dependency; subset parsers shipped instead (documented above).

**FOREIGN RED:** the 3 `npm test` failures listed above — files owned by
other sessions (logo/branding work), untouched by this phase.
