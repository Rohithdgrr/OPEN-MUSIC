# Notepad UI polish pass — spec (Govinda core shell)

**Date:** 2026-10-10 · **Scope:** Govinda-owned files only
(`app/src/notepad.js`, `app/src/notepad.css`). Peer modules untouched —
their surfaces are lifted by shared browser-surface theming (selection,
caret, scrollbars, focus rings) that applies inside `.npd-panel` to every
descendant. Refinement, not redesign: the incumbent token world (palette
hexes, 16px card, Windows-Notepad tab merge) is preserved as-is.

Method: impeccable `polish` playbook — triage by priority, one authored
motion moment, batched screenshot verification (light + dark, wide +
narrow), bounded passes.

## Triage

**P1 — functional / accessibility / browser surfaces**
(the craft-floor's "cheapest signal that a page was built rather than
assembled"):

1. **Themed text surfaces** — `::selection` inside the panel is the raw
   browser blue (no app rule covers it); caret is default. Theme both from
   the palette: accent bg / card fg, `caret-color: ink`.
2. **Textarea scrollbar** — the panel's largest scroller wears the browser
   default while side/aside/switch-list are already themed. Extend the
   existing webkit+`scrollbar-width` rules to `.npd-pad`.
3. **Panel inputs own their chrome** — `.npd-find-input`/`.npd-switch-input`
   currently wear the *global* `html:not(.dark) input[type="text"]:not(
   #search-input)` rules (higher specificity wins). Fix at the source:
   drop `type="text"` from the two panel inputs (implicit text, zero
   behaviour change, no peer selector uses `input[type=]`, no test asserts
   the type), then style them fully in notepad.css incl. an explicit
   `:focus-visible` ring.
4. **Tabular numerals** — `Ln/Col · words` jitters; add
   `font-variant-numeric: tabular-nums` (fast-win #18 of the coverage
   report, folded in here).
5. **Focus restore** — closing the panel leaves focus on a detached
   element; a dialog restores focus to the opener when it still exists.
6. **Find prev/next by mouse** — find is keyboard-only today (Enter/
   Shift+Enter); add chevron buttons (authored SVG, 1.5 stroke, one
   family) wired to the existing `doFind(±1)`.

**P2 — missing states:**

7. Switcher rows: hover + `:active` press (today only keyboard-selected).
8. Tab close button: hover/focus-revealed × (authored SVG) on each tab —
   the Windows-Notepad affordance; click closes without activating the
   tab (`stopPropagation`). Always visible on the active tab.
9. Find zero-state copy: `No matches` instead of `0 matches`
   (non-zero format `N matches` unchanged — test asserts it).

**P3 — one authored motion moment:**

10. Panel open: backdrop fades, card rises 10px + scales 0.985→1,
    expo-out `cubic-bezier(0.16, 1, 0.3, 1)` 200ms. Close reverses in
    130ms before `[hidden]`. Implemented via WAAPI (`.animate`) so the
    Node mini-DOM test harness — which has no WAAPI — keeps today's
    synchronous behaviour. `prefers-reduced-motion: reduce` skips both.
11. Switcher open: 140ms rise+fade, same easing (same gates).

**P4 — discoverability / copy:**

12. Empty-state hint upgraded with `<kbd>` chips (real key names, styled
    `.npd-kbd`) — `Ctrl+T` new note · `Ctrl+P` jump · `F2` rename.
13. Status-bar chord legend (`^T new · ^W close · ^P jump · ^F find ·
    ^S save · F2 rename`), mono 10px muted, `aria-hidden`, hidden below
    720px viewport. Teaches the whole keyboard surface at a glance.

**Out of scope (deliberate):** peer-module internals (Devi/Vijay/Ganesha
files), app toasts (shared system — already consistent), ripple (mobile
design language; this is a desktop Operate surface), any new colour.

## Report (applied)

**LANDED** — all of the spec above, in Govinda-owned files only:

- `app/src/notepad.js`: find prev/next buttons (authored SVG chevrons,
  wired to `doFind(±1)`), `No matches` zero-state copy, per-tab close
  button (SVG ×, `stopPropagation`, aria-labelled, revealed on hover /
  focus-within / always on the active tab), `aria-controls` on tabs,
  `<kbd>`-chip empty-state hint + status chord legend in the template,
  WAAPI panel + switcher enter/exit motion (gated: no-WAAPI harness keeps
  sync behaviour, reduced-motion off, rapid-reopen safe via `closeSeq`),
  focus restore to the opener on close.
- `app/src/notepad.css`: panel inputs own their chrome (type="text"
  dropped from the two inputs → global input rules no longer apply;
  explicit borders/bg + `:focus-visible` rings), `::selection` +
  `caret-color` themed from the palette, `.npd-pad` scrollbar themed,
  `tabular-nums` on status + find count, `.npd-kbd` / `.npd-legend` /
  `.npd-find-btn` / `.npd-tab-close` styles, switcher row hover/active,
  tab/close transitions (120 ms), `.npd-tabs:empty` collapse,
  `prefers-reduced-motion` kill-switch.

**Evidence (batched browser verification, then one fix round):**

- Computed-style audit in Chromium: `tabular-nums` ✓, caret `rgb(26,28,29)`
  ✓, `::selection` accent/card ✓, active-tab close `opacity 1` ✓, legend
  `flex` ✓, find input bordered ✓.
- Screenshots of 6 states (default / find / switcher / empty / dark /
  narrow 640px) from the *real* build() template: one defect found —
  orphaned empty tab-strip band in the empty state — fixed with
  `.npd-tabs:empty { display:none }`; confirmation round clean.
- Impeccable detector over both changed files: **`[]`** (zero findings).
- Gates: `node --check` OK · eslint clean · `npm test` **403/403** after
  every edit batch.

**FOREIGN RED:** none. **CONTRACT CHANGE:** none — all existing ids,
classes, mounts, and the keydown pipeline untouched.

## Contract impact

- New JS-introduced classes get CSS rules (static contract test):
  `npd-tab-close`, `npd-kbd`, `npd-legend`, `npd-find-btn`.
- Template edit only inside the build() string; all queried ids
  (`#npd-pad`, `#npd-find`, `#npd-switch`, mounts…) unchanged.
- Find count non-zero format `N matches` kept (test line 704); hint keeps
  `hidden` flag semantics (test line 644).

## Verification plan (bounded)

1. Gates: `node --check`, `npm test` (403/403 must hold), `npm run lint`.
2. Batched screenshots: static harness in `%TEMP%` loading the real
   `notepad.css` + replica markup — states: default light, dark, find
   open, switcher open, empty, long-tab overflow, narrow window. One
   headless-Chrome pass, inspect, one fix round, one confirm round.
3. Real-app drive optional (hotkey E2E already proven; motion check is
   harness-observable).
4. Impeccable detector once at the end over the changed targets.
