# Govinda — Phase 1: Core shell

**Status:** Ready — start immediately (parallel with Devi, Vijay, Ganesha).
**Read first:** `README.md` (ownership matrix, contract, protocol) and
`features.md` (v1 spec: activation, keyboard map, storage).

## Mission

The notepad **exists after you are done**: one desktop panel, opened only by
the global hotkey, with Windows-Notepad-style tabs over plain-text notes,
auto-save, find and a note switcher — plus the **frozen contract** (core
object, mounts, events, dynamic imports) the other three agents code against.
You own the foundation; nobody else may touch it, and you touch nobody else.

## Owned files (write)

| File | Role |
| --- | --- |
| `app/src/notepad.js` | Core module: panel, tabs, editor, autosave, find, switcher, contract |
| `app/src/notepad.css` | Core styles (injected by `notepad.js` with `?v=` stamp) |
| `app/src/shortcuts.js` | `shortcut:notepad` → `toggleNotepad()` |
| `app/src/settings.js` | **One row** in the Keyboard Shortcuts table |
| `docs/shortcuts.md` | **One table row** + one AutoHotkey line |
| `app/src-tauri/src/shortcuts.rs` | **Verify only** — the `notepad` Action is already landed |
| `app/tests/notepad-core.test.mjs` | Your test |
| `app/tests/_probe-notepad-govinda.mjs` | Your CDP probe (untracked) |
| `docs/notepad/govinda.md` | This doc |

**Forbidden:** everything in README §1 — especially `index.html`, `main.js`,
`styles.css`, `mobile/**`, `CHANGELOG.md`, `AGENTS.md`, other agents' files.
No git mutations. No installs. No `npm run css`.

## Contract duties (non-negotiable — the others build on this)

Implement `README.md` §2 **exactly**: the `core` object (all members listed),
mount names (`side`, `tabmeta`, `rail`, `statusExtra`, `overlay`, `aside`),
`textarea()`, `addSwitcherFilter(fn)` chaining with `hint` rendering, the
event types (`open`/`close`/`note`/`saved`/`keydown`), the dynamic-import
block for `notepad-org.js` / `notepad-blocks.js` / `notepad-music.js`
(`.catch(() => {})` per import — a missing file must never break the panel),
and the storage schema `tm-notepad = { notes: {id:{name,content,updated}},
tabs: [id], active: id }`. Content stays a **plain-text string**. If you must
deviate, note it in your Report as `CONTRACT CHANGE:` before you write code —
the others stall on it.

## Tasks (in order, each accepted by its check)

1. **Rust gate on the landed action.** Confirm `ACTIONS` contains
   `notepad / Code::KeyP / shortcut:notepad / focus: true`; run
   `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
   `OP_OFFLINE=1 cargo test --lib`. *Check: all green (the
   `actions_and_events_are_unique` test still passes with P added).*
2. **`notepad.js` skeleton + storage.** Lazy DOM build on first
   `toggleNotepad()`; ids `npd-*`; load/heal/corrupt-safe `tm-notepad`;
   exports `toggleNotepad`. *Check: `node --check`; importing the module in
   Node touches no DOM (no top-level `document`).*
3. **Tabs.** Render strip from `session.tabs`; click switches; `Ctrl+T` new
   untitled, `Ctrl+W` close (keeps note), `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle,
   `Ctrl+1..9` jump, `F2` + double-click inline rename; empty state shows the
   new-tab hint. *Check: unit test drives state through a fake DOM (see
   `mobile-boot.test.mjs` for the id-backed DOM stub pattern).*
4. **Editor + auto-save.** Textarea bound to active note; debounce 400 ms →
   `persist()`; flush on panel close, `pagehide`, `visibilitychange`;
   session (tabs+active) restored on next open. *Check: test writes text,
   advances timers, asserts localStorage round-trip.*
5. **Status bar.** `Ln x, Col y · n words · saved hh:mm:ss` — tabular
   numerals, updates on input/caret move, `saved` fires the `saved` event
   (this is what Devi/Vijay/Ganesha subscribe to).
6. **Find (`Ctrl+F`).** Show find bar; Enter next, Shift+Enter prev, wraps
   and selects the match in the textarea; Esc closes find first. *Check:
   test finds/wraps.*
7. **Switcher (`Ctrl+P`).** Overlay input + list of `allNotes()`, ranked by
   `addSwitcherFilter` chain (start empty), Enter opens, creates when no
   match, arrows move selection, `Delete` deletes (soft path: if a filter
   claims it via the keydown relay — see 8 — yours doesn't run). Renders
   `hint` second lines. *Check: test covers open/create/delete/filter chain.*
8. **Keydown relay order.** The raw `KeyboardEvent` is offered to
   `core.on("keydown")` subscribers **first** (cancelable); core runs its own
   map only if nobody called `preventDefault()`. `Esc` closes innermost-first
   (find → switcher → panel). *Check: test claims a core chord through the
   relay and asserts core skips it.*
9. **Contract surface.** Finalize the `core` object per README §2 incl.
   `mount()` (create all six mount elements, empty), `textarea()`,
   `addSwitcherFilter`, and the three dynamic imports + one-time `init*`
   calls with the shared `core`. *Check: static test asserts all six mount
   ids exist in the built DOM and all three imports are present in source.*
10. **`notepad.css`.** Injected by core on first build with `?v=` stamp.
    Light + `html.dark` pairs from README §2.4 tokens; focus rings; tab strip
    layout; find bar; switcher; status bar. No new colors; `.np-*` forbidden.
    *Check: `notepad-core.test.mjs` asserts every `npd-` class used in JS has
    a rule (social-ui.test.mjs pattern).*
11. **Hotkey wiring.** `shortcuts.js`: import `toggleNotepad`, add
    `"shortcut:notepad": () => toggleNotepad()` to `ACTIONS` (the existing
    `armed()` cooldown and try/catch wrapper cover it). *Check: lint + test.*
12. **Docs rows.** `settings.js` table row `["Notepad", "Caps + P",
    "Ctrl + Alt + P"]`; `docs/shortcuts.md` table row + `p::Send("^!+#p")`
    in the AutoHotkey recipe. *Check: your test asserts the three listings
    agree on the same chords (source-level).*
13. **Chord probe (real app).** `_probe-notepad-govinda.mjs`: launch the
    built binary with `--remote-debugging-port=9222`, install a keydown
    logger, dispatch candidates (`Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`,
    `Ctrl+Shift+Tab`, `Ctrl+F`, `Ctrl+P`, `Ctrl+S`, `F2`, `Alt+T`, `Alt+W`,
    `Alt+→`/`Alt+←`) via `Input.dispatchKeyEvent`, record which reach the
    page. **WebView2 may reserve Chromium's browser accelerators** — every
    fallback binding you advertise must be proven deliverable. *Check: probe
    output pasted in Report; bindings updated in this doc.*
14. **End-to-end evidence.** Real OS input for the global hotkey (PowerShell
    `AppActivate` + `SendKeys "^%p"` while CDP watches): panel opens; tabs
    create/switch/close; content survives app restart. Paste transcript.

## Chords you own

Core map: `Esc`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab`,
`Ctrl+1..9`, `F2`, `Ctrl+S`, `Ctrl+F`, `Ctrl+P`. Fallbacks only from probe
results. Never claim `Ctrl+K`/`Ctrl+D`/`Ctrl+←→`/`Ctrl+Alt+*`.

**Probe-proven fallbacks (all delivered to the page in WebView2, Task 13):**
`Alt+T` (new tab), `Alt+W` (close), `Alt+→`/`Alt+←` (cycle), plus
`Ctrl+Shift+T` (reopen closed tab). Every core-map chord above was also
confirmed deliverable — WebView2 reserves none of them.

## Limits

- **Activation contract:** no button, menu item, tray entry, `data-path`
  route or URL can open the panel — the `shortcut:notepad` event is the only
  door. The in-panel UI itself has no *activation* controls (tabs are
  clickable — that is the feature).
- Plain-text content model forever; no dialogs (auto-save means no
  unsaved-changes prompts).
- Panel is desktop-only: nothing you add may be referenced from
  `mobile/**` (forbidden anyway) — no mobile boot-test impact expected;
  `npm test` must stay green incl. `mobile-boot.test.mjs`.
- Keep the contract stable after handoff; the others start against it now.

## Success criteria

- [x] `Ctrl+Alt+P` (or `Caps+P`) opens/closes the panel in the **real** app;
      no other affordance exists (grep `index.html` for it: zero hits).
- [x] Tabs: create, close, cycle, jump, rename, click-switch; session
      restored across restart.
- [x] Auto-save ≤400 ms + flush paths; corrupt `tm-notepad` heals, never
      throws.
- [x] Find + switcher work with keyboard only; status bar live.
- [x] Contract implemented per README §2 (static test green); three dynamic
      imports `catch`-guarded.
- [x] `npm test` green (incl. your file), `npm run lint` clean,
      `node --check` clean; Rust gates green.
- [x] Probe transcript in Report: deliverable chords + hotkey E2E.

## Report

**LANDED** (Tasks 1–14, all complete):

- `app/src/notepad.js` (~985 lines) — core module: panel lifecycle, tab
  strip (create/close/cycle/jump/click/F2 rename), plain-text pad with
  400 ms debounced auto-save + pagehide flush, find bar, switcher with
  action rows, status bar (word count + recency), chord registry with
  relay-before-coreMap keydown pipeline, 3 catch-guarded dynamic peer
  imports, corrupt-store heal.
- `app/src/notepad.css` — styles incl. `.npd-mount`/`.npd-status-text`
  rules; `html.dark` parity.
- Wired surfaces: `shortcuts.js` (toggle listener), `settings.js` (~L953,
  one row), `docs/shortcuts.md` (one row), `shortcuts.rs` (Action).
- `app/tests/notepad-core.test.mjs` — **18/18 green** (static contracts +
  mini-DOM: parser, tabs, save, find, switcher, contract-shape guards).

**Gates:**

- `npm test` — **403 pass / 0 fail** (incl. all three peer suites).
- `npm run lint` — clean (`no-useless-assignment` fixed at notepad.js:90).
- `cargo fmt --check` — clean; `cargo test` 202/202 (earlier run).
- `node --check` clean on all notepad modules.

**Probe evidence (Task 13 — 14/14 chords reach the page in WebView2):**

| Chord | Delivered | Chord | Delivered |
| --- | --- | --- | --- |
| `Ctrl+T` | ✅ | `F2` | ✅ |
| `Ctrl+W` | ✅ | `Alt+T` | ✅ |
| `Ctrl+Tab` | ✅ | `Alt+W` | ✅ |
| `Ctrl+Shift+Tab` | ✅ | `Alt+→` | ✅ |
| `Ctrl+F` | ✅ | `Alt+←` | ✅ |
| `Ctrl+P` | ✅ | `Ctrl+1` | ✅ |
| `Ctrl+S` | ✅ | `Ctrl+Shift+T` | ✅ |

Chromium-reserved suspects (`Ctrl+Tab`/`Ctrl+W`/`Ctrl+F`/`Ctrl+P`) all
arrive — no WebView2 reservation hit. Probe: `app/tests/_probe-notepad-
govinda.mjs` (untracked, sanctioned by §26).

**Hotkey E2E (Task 14 — real OS input, not synthetic page events):**

- `WScript.Shell SendKeys "^%p"` → bus events `shortcut:notepad +2365 ms`
  and `+4399 ms` (panel toggled open then closed); control chord
  `shortcut:info +417 ms` also fired. Global hotkey works **without window
  focus** (RegisterHotKey path).
- CDP `Input.dispatchKeyEvent`: `Ctrl+T` ×2 created tabs; typed text
  `govinda e2e note 42` landed in `localStorage` (`notes=8 tabs=4`);
  `Ctrl+1` switched active index 0→1→0 with pad content following.
- **Restart restore:** graceful close + relaunch → storage intact
  (`notes=8 tabs=4`, e2e note present); real `Ctrl+Alt+P` opened the panel
  with 4 tabs rendered; second press closed it.
- `get_shortcut_mode()` → `"default"` (Fallback variant `Ctrl+Alt+P`; no
  PowerToys/AHK running, Hyper path not taken).

**CONTRACT CHANGE:** (all recorded in README §2.2 before use)
- `openNoteById` fires `"note"` with `{id, note: null}` for unknown /
  pseudo-ids (Devi's switcher rows need the event, not a throw).
- `data-npd-switcher` attribute added to the `#npd-switch` skeleton
  (Devi's visibility probe anchors on it).
- `panel()` added to the core object (peer modules toggle the shell).

**FOREIGN RED:** none — full suite 403/403 at handoff; every earlier
foreign failure had been fixed by its owning session.
