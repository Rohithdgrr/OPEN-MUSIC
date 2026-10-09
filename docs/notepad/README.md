# Notepad build — master coordination (4 parallel agents)

**Folder:** `docs/notepad/` — every notepad document lives here and nowhere
else. `docs/notepad.md` was moved to `docs/notepad/features.md` (2026-10-10).

The notepad is a large feature (85 listed capabilities, `features.md`). It is
built by **four agents working simultaneously** — phases by *ownership*, not
by time: they run in parallel, each on disjoint files, against the frozen
contract below. Nothing one agent does can disturb another.

| Phase | Agent | Mission | Doc |
| --- | --- | --- | --- |
| 1 | **Govinda** | Core shell: panel, tabs, editor, autosave, find, switcher, contract implementation, hotkey (Rust) | `govinda.md` |
| 2 | **Devi** | Organization & comfort: search/sort/pin/trash, tags, notebooks, favorites, export/import, templates | `devi.md` |
| 3 | **Vijay** | Editing power: slash commands, tables, TOC, focus/typewriter, find & replace, version history, math/mermaid render | `vijay.md` |
| 4 | **Ganesha** | Music moat: track chips, timestamp links, review/lyric/session templates, playlist notes, listening journal | `ganesha.md` |

---

## 0. Current repo state (2026-10-10, setup session)

- **Landed (uncommitted):** `app/src-tauri/src/shortcuts.rs` — the `notepad`
  `Action { key: KeyP, event: "shortcut:notepad", focus: true }` is already in
  `ACTIONS`. **Do not re-add it.** Govinda verifies it with the Rust gates.
- **Landed:** this folder (`docs/notepad/features.md` moved from
  `docs/notepad.md`).
- **Not started:** everything else — no `notepad.js`, no panel, no wiring.
- **Tree carries other sessions' WIP** (`proxy.rs`, `mobile/*`, icons,
  `CHANGELOG.md`, jam tests, …). It is not ours: never stage, commit, revert
  or "clean up" anything outside the ownership matrix below.

## 1. Ownership matrix (the only files an agent may WRITE)

| File | Owner |
| --- | --- |
| `docs/notepad/govinda.md` … `ganesha.md` | that agent (its own doc only) |
| `app/src/notepad.js`, `app/src/notepad.css` | Govinda |
| `app/src/shortcuts.js`, `app/src/settings.js` | Govinda |
| `app/src-tauri/src/shortcuts.rs` | Govinda (verify only — edit already landed) |
| `docs/shortcuts.md` | Govinda |
| `app/src/notepad-org.js`, `notepad-org.css` | Devi |
| `app/src/notepad-blocks.js`, `notepad-blocks.css` | Vijay |
| `app/src/notepad-music.js`, `notepad-music.css` | Ganesha |
| `app/tests/notepad-{core,org,blocks,music}.test.mjs` | matching agent |
| `app/tests/_probe-notepad-<name>.mjs` (untracked probes) | matching agent |

**Forbidden to everyone (no exceptions):** `app/src/index.html`,
`main.js`, `core.js`, `dom.js`, `html.js`, `styles.css`, `player.js`,
`playback.js`, `transport.js`, `library.js`, `home.js`, `search.js`,
`queue.js`, `vault.js`, `settings.js` *(except Govinda's one row)*,
`tailwind.css`, `tailwind.input.css`, `tailwind.config.cjs`, anything under
`app/src/mobile/`, `app/src-tauri/src/**` *(except Govinda's verify)*, all
`docs/**` except your own doc, `AGENTS.md`, `CHANGELOG.md`, `.github/**`,
test configs (`eslint.config.mjs`, `app/package.json`).

Read-only imports of forbidden files are fine (e.g. Ganesha may `import { … }
from "./transport.js"`); writing them is not.

## 2. The contract (frozen — Govinda implements exactly this)

### 2.1 Core module and loading

`app/src/notepad.js` (Govinda) builds the panel lazily on first
`toggleNotepad()`. On first open it dynamic-imports the three agent modules:

```js
import("./notepad-org.js").then((m) => m.initNotepadOrg(core)).catch(() => {});
import("./notepad-blocks.js").then((m) => m.initNotepadBlocks(core)).catch(() => {});
import("./notepad-music.js").then((m) => m.initNotepadMusic(core)).catch(() => {});
```

A not-yet-written file rejects and is silently skipped — that is what makes
parallel development safe. Each module is initialized **once**, idempotently
(guard inside `init*`), and injects **its own** stylesheet link inside `init`
(`<link rel="stylesheet" href="notepad-<area>.css?v=<ts>">`). No agent edits
`index.html` for CSS or scripts.

### 2.2 `core` object (passed to every `init*`)

```js
core = {
  // subscribe; returns an unsubscribe fn. Types:
  //   "open" | "close"            panel shown / hidden
  //   "note"    (d) => …          tab switched / note opened   d = { id, note }
  //                               d.note is null when the id is a peer
  //                               action row (pseudo id like `npdo-dup`)
  //                               — guard `d.note` before use; that is how
  //                               peers activate their switcher actions
  //   "saved"   (d) => …          after an autosave flush      d = { id }
  //   "keydown" (ev) => …         RAW KeyboardEvent, CANCELABLE: call
  //                               ev.preventDefault() to claim the chord —
  //                               core then skips its own binding for it
  on(type, fn),

  // Mount points Govinda creates in the panel (empty divs, always present
  // while the panel exists). Render YOUR content inside; never rename them:
  //   #npd-side      left rail       (Devi: notebooks)
  //   #npd-tabmeta   strip beside the active tab name (badges)
  //   #npd-rail      attachments rail above the status bar (chips)
  //   #npd-status-extra  span appended to the status bar text
  //   #npd-overlay   top layer for your menus / popups
  // "side" (left rail, Devi) | "tabmeta" | "rail" (Ganesha) |
  // "statusExtra" | "overlay" (top layer) | "aside" (right panel, Vijay)
  // Overlay rule: each consumer creates its OWN child container inside
  // #npd-overlay (your prefix) so two popups never clobber each other.
  mount(name),
  panel(),                     // the #npd-panel root element — layout-safe:
                               // your own prefixed classes/children only, no
                               // inline styles on core's children (Devi's
                               // fold widths, Vijay's focus mode use this)
  textarea(),                  // the live <textarea> (attach listeners only —
                               // never replace it; used by Vijay for input rules)

  // Switcher extension: contributors run in registration order, each
  // (query, rows) -> rows. rows = [{ id, name, updated, pinned?, hint? }];
  // core renders `name` + a small `hint` line, pinned first. Devi filters
  // (search/sort/trash/recents), others may decorate later.
  addSwitcherFilter(fn),

  activeNote(),                // { id, name, content, updated } | null
  allNotes(),                  // { [id]: { name, content, updated } }
  setNoteContent(id, text),    // write + debounced save (Vijay's rewrites)
  insertAtCursor(text),        // into the active textarea at the caret
  selection(),                 // { start, end, value }
  setSelection(start, end),
  openNote(id),                // switch to tab (opens it if not in tabs)
  closeNote(id),               // remove tab (note survives in allNotes)
  newNote(name, content),      // create + open → returns id
  refresh(),                   // re-render tabs + status after external change
  toast, diag,                 // re-exports of core.js helpers (same signature)
}
```

**Switcher visibility probe:** the switcher container is
`#npd-switch` + `.npd-switch` + `data-npd-switcher` (hidden attribute off =
open). A keydown claim that depends on the switcher being open (Devi's
soft-Delete) should test `[data-npd-switcher]` visibility rather than any
private core state — that is the sanctioned hook.

### 2.3 Data & storage rules

- **Content model is a plain-text string forever** (v1 invariant):
  `notes[id] = { name, content, updated }` under localStorage key
  `tm-notepad`, owned by Govinda. Blocks, chips, tags are *layers over* the
  text (syntax) or *sidecar data* — never a schema change to this object.
- **One storage key per agent** — never write another agent's key:
  Govinda `tm-notepad` · Devi `tm-notepad-org` · Vijay
  `tm-notepad-blocks` (history: `tm-notepad-versions`) · Ganesha
  `tm-notepad-music`. Sidecar shape is yours: store per note id.
- Reads of your own key are `JSON.parse` in try/catch with a fallback —
  corrupt storage must never break the panel.

### 2.4 Namespace rules (no collisions, ever)

| | Govinda | Devi | Vijay | Ganesha |
| --- | --- | --- | --- | --- |
| CSS classes / ids | `npd-` | `npdo-` | `npdb-` | `npdm-` |
| module init export | — (is core) | `initNotepadOrg` | `initNotepadBlocks` | `initNotepadMusic` |
| test file | `notepad-core.test.mjs` | `notepad-org.test.mjs` | `notepad-blocks.test.mjs` | `notepad-music.test.mjs` |
| probe (untracked) | `_probe-notepad-govinda.mjs` | `_probe-notepad-devi.mjs` | `_probe-notepad-vijay.mjs` | `_probe-notepad-ganesha.mjs` |

`.np-*` is taken by Now Playing — never use it. No new colors anywhere: use
the app's tokens only (light: surface `#f9f9fb`/`#f3f3f5`/`#e8e8ea`/`#e2e2e4`,
ink `#1a1c1d`, muted `#71717a`; dark via `html.dark`: bg `#09090b`, surfaces
`#101013`/`#141416`/`#1a1a1e`/`#242429`, text `#f4f4f5`, muted `#a1a1aa`,
border `rgba(255,255,255,.08)`).

### 2.5 Chord registry (claim via `keydown` relay only)

Core owns: `Esc`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab`,
`Ctrl+1..9`, `F2`, `Ctrl+S`, `Ctrl+F`, `Ctrl+P`.
App-wide (never claim): `Ctrl+K` (search), `Ctrl+D` (download),
`Ctrl+←/→` (queue), all `Ctrl+Alt+*` (global hotkeys).
**Assigned free pool** (Alt+<letter>, deliverable in WebView2 — re-verify
with your probe before advertising): Devi `Alt+E`, `Alt+I`, `Alt+R` ·
Vijay `Alt+H`, `Alt+V` · Ganesha `Alt+M`. List the chords you actually
implemented in your own doc.

## 3. Parallel protocol ("no other work disturbs")

1. **Write only your owned files.** If you believe you need a forbidden
   file, stop and put it in your doc's `## Report` as `BLOCKED:` — do not
   touch it.
2. **No git mutations at all**: no `add`, `commit`, `push`, `checkout`,
   `stash`, `reset`. Leave changes in the working tree; the main session
   handles commits (rule: never push without an explicit go-ahead).
3. **Gates:** run `node --check` + `npm run lint` + your own test file
   early and often. Run the full `npm test` before you report. If a red
   test belongs to **another** agent's WIP file, do not fix it — record it
   in your Report as `FOREIGN RED: <file>`.
4. **Cargo is Govinda-only** (his Rust gates). Cargo politely blocks on a
   lock held by another build — wait, never kill a process you do not own.
5. **No installs, no new dependencies, no CDN scripts, no `npm run css`**
   (the tailwind output is shared WIP — regenerating it would stampede
   other sessions).
6. **Tests:** follow the static-contract pattern of
   `app/tests/social-ui.test.mjs` (read source files, assert markup↔CSS↔JS
   contracts) plus DOM-stub unit tests of your module against a **fake
   `core`** object — your module must be fully testable without Govinda's
   core existing. E2E probes (real panel) run only after core lands; if it
   hasn't, mark the probe `PENDING` in your Report and finish it last.
7. **Docs-first inside your lane:** behavior you add must be documented in
   **your** doc (`## Behavior added`) before you consider a task done.
8. **Report:** append to your own doc's `## Report` section only: what
   landed, gate outputs (one line each), probe evidence, `BLOCKED`/`FOREIGN
   RED` items. The main session aggregates these into `AGENTS.md`.

## 4. Shared definition of done (the feature ships when)

- [ ] `toggleNotepad()` opens one panel; **no button/menu/route** anywhere
      else can open it — the only activation is `Ctrl+Alt+P` (Hyper:
      `Caps+P`), per `docs/shortcuts.md`.
- [ ] Tabs create / close / switch / rename / persist across restart.
- [ ] Auto-save 400 ms debounce, flush on close/`pagehide`; no dialogs.
- [ ] `npm test` green (all four test files), `npm run lint` clean,
      `node --check` clean on every new file.
- [ ] Govinda's Rust gates green (`cargo fmt --check`, `clippy -D warnings`,
      `cargo test --lib` with `OP_OFFLINE=1`).
- [ ] Real-app CDP evidence for the hotkey + tab switching + at least one
      feature per agent (probe output pasted in the agent's Report).
- [ ] Dark mode verified for every panel surface; no new colors introduced.

## 5. Doc map

- `features.md` — the complete 85-feature list + v1 spec (spec of record)
- `govinda.md` · `devi.md` · `vijay.md` · `ganesha.md` — phase docs
- `README.md` — this file (contract + protocol)
