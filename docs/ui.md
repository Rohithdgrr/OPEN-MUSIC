# UI / UX Specification — TRANCE MUSIC

Companion to `PRD.md` and `architecture.md`. Governs `app/src/`:
`index.html`, `main.js` (entry) and its feature modules, `styles.css`.

---

## 1. Product Voice

- **Plain, absolute words.** `FULL SONG`, not "probably fine". `UNREACHABLE`, not "something went wrong".
- **Never blame the user, never blame "the network" generically.** Every error names the hop that failed: search, resolve, or playback.
- **Numbers over adjectives.** Show quality, file size, host, byte position — the user can reason with those.

The UI is a *measurement surface* as much as a player: if something doesn't play, the screen must already contain the answer.

---

## 2. Information Architecture

Single page, top-to-bottom, no routing:

```
┌─────────────────────────────────────────────┐
│ HEADER      TRANCE MUSIC        JioSaavn · 127.0.0.1:64398
├─────────────────────────────────────────────┤
│ SEARCH      [ Search songs, artists… ] [Search]
├─────────────────────────────────────────────┤
│ HISTORY     (chips)  tum hi ho  ×
├─────────────────────────────────────────────┤
│ BANNER      error / warning (hidden by default)
├─────────────────────────────────────────────┤
│ RESULTS     Results                  [Play all]
│             ┌────┬────────────────────┐
│             │art │ Tum Hi Ho          │
│             │    │ Mithoon · 4:22     │
│             └────┴────────────────────┘
├─────────────────────────────────────────────┤
│ PLAYER (sticky bottom)                      │
│   ┌────┐  Tum Hi Ho                         │
│   │art │  Aashiqui 2 · Mithoon              │
│   └────┘  [FULL SONG · 320kbps · 10.0 MB]   │
│   ▶───────────────────────────  ●            │
│   playing readyState=4 t=12.3s / 262.0s     │
├─────────────────────────────────────────────┤
│ QUEUE        Queue                  [Clear] │
│   1. Tum Hi Ho                    playing…  │
│   2. Kesariya                               │
├─────────────────────────────────────────────┤
│ ▸ Diagnostics                               │
│   12:04:31 play aRZbUYD7 — http://127.0.0.1…│
└─────────────────────────────────────────────┘
```

**Rationale:** one column, one task. Everything the user needs to answer *"is this working?"* is on one screen simultaneously — results, badge, telemetry, and diagnostics.

---

## 3. Screens & Components

### 3.1 Design tokens

```css
:root {
  color-scheme: dark;
  --bg:      #141417;   /* page */
  --panel:   #1d1d22;   /* cards, inputs, queue rows */
  --text:    #e8e8ea;
  --muted:   #9a9aa3;   /* metadata, timestamps */
  --accent:  #4da3ff;   /* primary action, focus */
  --ok:      #3fb96c;   /* full song, played */
  --warn:    #d9a13b;   /* preview only */
  --bad:     #e05c5c;   /* unreachable, failed */
}
```

Dark-only for now (`color-scheme: dark` tells the UA to render form controls dark too). Light theme = flipping these seven tokens plus a `prefers-color-scheme` media query.

### 3.2 Component inventory

| Component | Element | Behaviour | States |
|---|---|---|---|
| Header | `.head` | app name + live source/proxy readout | — |
| Search form | `#search-form` | submit on Enter or button | idle, focused |
| History chip | `.chip` | click → fills input + submits | hover, active |
| Error banner | `#error` | text + `.hidden` toggle | hidden, visible |
| Result row | `#results li` | whole row is the click target | default, hover (accent outline) |
| Result thumb | `.thumb` | 44×44, `object-fit: cover`, `loading="lazy"` | loading (dark box), loaded |
| Player | `#player` | sticky bottom, `.hidden` until first resolve | hidden, resolving, playing, error |
| Cover | `#cover` | 64×64 | empty, loaded |
| Badge | `#badge` | **the truth surface** | `.full`, `.preview`, `.dead`, neutral |
| Audio | `#audio` | native controls: play/pause/volume/seek | per media element |
| Telemetry | `#telemetry` | monospace-ish tabular numbers | idle, playing, buffering, error |
| Queue row | `#queue li` | click → jump | default, `.current`, `.done`, `.failed` |
| Diagnostics | `#diag` | `<details>` disclosure, newest first | collapsed, open |

### 3.3 The badge (core UX)

| Condition | Class | Copy |
|---|---|---|
| `unrestricted` | `.full` (green) | `FULL SONG · 320kbps · 10.0 MB` |
| `restricted_first_mb` | `.preview` (amber) | `PREVIEW ONLY — stream capped near ~1 MB` |
| `dead` | `.dead` (red) | `UNREACHABLE — stream failed range checks` |
| during resolve | neutral | `resolving…` |

Rules:

1. The badge is set **before** `audio.src` is assigned, so the promise is visible before playback starts.
2. The badge never says "full song" unless the probe returned `unrestricted`.
3. `document.title` mirrors state (`▶ title`, `◐ preview — title`, `✖ unreachable`) so the OS taskbar tells the truth too.

### 3.4 Telemetry line

```
playing readyState=4 t=12.3s / 262.0s · 320kbps · aac.saavncdn.com
```

Fields: state · `readyState` · position/duration · chosen quality · host · media error code if any. Tabular numerals so it doesn't jitter.

---

## 4. States & Copy

### 4.1 Every async action has three states

| Action | Pending | Success | Failure |
|---|---|---|---|
| Search | (input disabled implicitly by await) | rows render, `search "q" — 20 tracks` in diagnostics | `Search failed: <err>` |
| Resolve | badge `resolving…` | badge + `resolve <id> — 320kbps · host · unrestricted` | `Could not resolve "<title>": <err>` |
| Playback | telemetry `buffering` | telemetry `playing` | `Playback failed (media error N). The stream URL was refused by the browser media stack.` |

### 4.2 Empty states

| Situation | Copy |
|---|---|
| No query | (do nothing — no request, no error) |
| Zero results | `No tracks found for that query.` |
| Queue empty | `#queue` simply renders nothing (`.chips:empty { display:none }` pattern for history) |
| Never searched | Results section is empty but present — no illustration needed in v1 |

### 4.3 Error taxonomy shown in UI

| Source | Surface | Style |
|---|---|---|
| IPC/mirror failure | `#error` banner | red panel + diagnostics `bad` line |
| Resolve failure | banner + badge `UNRESOLVED` | queue row → `failed`, auto-advance |
| Media error | banner + telemetry `error=N` | queue row → `failed`, auto-advance |
| Range degradation | badge amber only (not an error) | playback continues to the cap |

**Auto-advance rule:** a failed queue item never dead-ends the queue; 600 ms later the next item plays.

---

## 5. Interaction Design

### 5.1 Primary flow (three actions to music)

```
type → Enter → click a row  ⇒  sound
```

No confirmation, no login, no modal, no "are you sure".

### 5.2 Queue semantics

| Action | Result |
|---|---|
| Click a result | append to queue (dedup by id) and play it |
| Click a queue row | jump to that index |
| `Play all` | **replace** queue with the current result page, play index 0 |
| `Clear` | stop audio, empty queue, reset index |
| Track `ended` | mark `done`, advance after 600 ms |
| Track failed | mark `failed`, advance after 600 ms |

Dedup returns the existing index, so clicking the same song twice doesn't create duplicates.

### 5.3 History

- `localStorage["op-history"]`, max 8, newest first, duplicates removed.
- Each chip is a `<button>` that writes the value and triggers `form.requestSubmit()` — identical to typing it.

### 5.4 Sticky player

`position: sticky; bottom: 12px; z-index: 5` with a top shadow — the transport stays reachable while the user scrolls results. On first play it also calls `scrollIntoView({behavior:"smooth", block:"nearest"})` so it's never off-screen.

---

## 6. Visual Design

### 6.1 Layout

- Container: `max-width: 640px`, centred, `24px 16px 48px` padding.
- Spacing rhythm: 8 px base (8/12/16/20/24).
- Radii: 8 px (rows, inputs, buttons), 12 px (player card), 999 px (chips/badges), 6–8 px (artwork).
- No borders except hairline `#333` on ghost buttons/chips; hierarchy comes from the `--panel` surface against `--bg`.

### 6.2 Typography

| Use | Style |
|---|---|
| `h1` | 22 px, 600 |
| Player title `h2` | 17 px, 600, ellipsis |
| Section `h3` | 15 px, muted spacing |
| Body / rows | 15 px system-ui |
| Metadata `.meta` | 13 px `--muted` |
| Badge | 13 px, 600 |
| Telemetry | 13 px, `font-variant-numeric: tabular-nums` |

System font stack only (`system-ui, sans-serif`) — zero webfont bytes, native rendering on every Windows machine.

### 6.3 Colour semantics (fixed)

| Colour | Means |
|---|---|
| `--accent` | actionable / focused / current |
| `--ok` | verified full song, completed item |
| `--warn` | degraded but usable (preview) |
| `--bad` | failed or unreachable |
| `--muted` | informational, non-actionable |

Never use `--ok` decoratively — a green thing on screen must have been *measured* green.

### 6.4 Artwork

| Slot | Size | Treatment |
|---|---|---|
| Result thumb | 44×44, radius 6 | `object-fit: cover`, `loading="lazy"`, black placeholder |
| Player cover | 64×64, radius 8 | `object-fit: cover`, black placeholder |

Artwork comes from `c.saavncdn.com` (largest available, `500x500` preferred by the Rust parser).

---

## 7. Responsive Behaviour

Current window is 800×600 — the layout must be correct there first.

| Width | Layout |
|---|---|
| ≥ 680 px | 640 px column, centred |
| 480–680 px | fluid column, 16 px gutters |
| < 480 px | fluid, queue `qstate` allowed to wrap under the label |
| < 360 px | header source string truncates (`.source { text-overflow: ellipsis }`) |

Responsive techniques used: flexbox with `min-width: 0` on text containers (so ellipsis actually works), `flex-wrap` on chips, sticky player, no fixed pixel heights on rows.

**Future two-column mode (large screens):** `@media (min-width: 1100px)` → container `max-width: 1100px`, `grid-template-columns: 1fr 320px` with results left, queue + diagnostics right.

---

## 8. Accessibility

| Requirement | Implementation |
|---|---|
| Real interactive elements | results/queue rows are `<li>` with click handlers → **must be upgraded to `<button>`** (Phase 6) |
| Hit targets | rows ≥ 44 px tall (44 px thumb sets the floor) |
| Focus visible | add `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` (Phase 6) |
| Colour independence | every badge carries **text** (`FULL SONG`), colour is redundant reinforcement |
| Live updates | add `aria-live="polite"` on `#badge` and `#telemetry` (Phase 6) |
| Images | `alt=""` on decorative artwork (the title is adjacent text) |
| Reduced motion | replace `behavior:"smooth"` scroll with `prefers-reduced-motion` guard (Phase 6) |
| Colour scheme | `color-scheme: dark` keeps native controls consistent |
| Contrast | `--text #e8e8ea` on `--bg #141417` ≈ 14:1; `--muted` on `--panel` ≈ 5.6:1 (AA for normal text) |

**Known gap:** rows are click-handled `<li>`s — keyboard users cannot reach them. This is the single highest-priority a11y fix.

---

## 9. Keyboard & Shortcuts

| Key | Context | Action | Status |
|---|---|---|---|
| `Enter` | search field | submit search | ✅ native form |
| `Tab` | page | search → results → player → queue | ⬜ needs button semantics |
| `Space` | player focused | play/pause | ⬜ Phase 6 |
| `↑ / ↓` | queue | move cursor | ⬜ Phase 6 |
| `Enter` | focused row | play that row | ⬜ Phase 6 |
| `Escape` | search field | clear input | ⬜ Phase 6 |
| `1…9` | global | jump to queue index | ⬜ Phase 6 (power user) |

---

## 10. Motion & Feedback

Deliberately minimal — this is a utility, not a showpiece.

| Feedback | Treatment |
|---|---|
| Button hover | `filter: brightness(1.1)` — instant, no transition cost |
| Result hover | 1 px accent outline |
| Resolving | badge text swap (no spinner needed — the text says it) |
| Buffering | telemetry `buffering` |
| Errors | banner appears in place, no shake/flash |
| Scroll on play | `smooth` scroll, nearest block |

If motion is added later: only opacity/transform, ≤ 200 ms, gated by `prefers-reduced-motion`.

---

## 11. Diagnostics Panel UX

```html
<details id="diag-wrap">
  <summary>Diagnostics</summary>
  <ol id="diag"></ol>
</details>
```

- Collapsed by default — zero visual noise for listeners.
- Newest first, hard cap of 40 entries (DOM ring buffer).
- Lines are colour-coded: `.ok` green, `.bad` red, neutral otherwise.
- Format: `HH:MM:SS <step> — <detail>`, e.g. `12:04:31 resolve aRZbUYD7 — 320kbps · aac.saavncdn.com · unrestricted`.
- **Purpose:** a non-developer can screenshot this and it identifies the failing hop.

---

## 12. Performance Budget (frontend)

| Budget | Limit | Current |
|---|---|---|
| Total JS | < 40 KB | ~200 KB across 18 modules (budget pre-dates the split) |
| Total CSS | < 20 KB | ~5 KB |
| DOM nodes (initial) | < 150 | ~40 |
| DOM nodes (20 results + queue) | < 500 | ~100 |
| Layout thrash on `timeupdate` | 1 text node | ✅ single `textContent` write |
| Images | lazy, 44 px | ✅ |
| Fonts | 0 bytes (system stack) | ✅ |
| Build steps | 0 | ✅ |

**Note:** `timeupdate` fires ~4×/s and the current code writes `telemetryEl.textContent` each time — one text node, negligible. If profiling ever shows otherwise, throttle to 250 ms.

---

## 13. Content Rules

1. Durations are preformatted in Rust (`"4:22"`) — no client-side formatting duplication.
2. Missing artist falls back to album; both missing → just the title.
3. Never display raw URLs in the primary UI (only in diagnostics, truncated to 70 chars).
4. Byte sizes always in MB with one decimal (`10.0 MB`).
5. Copy is sentence case, no exclamation marks, no emoji.

---

## 14. Frontend File Contract

| File | Owns | Must not |
|---|---|---|
| `index.html` | structure, ids, script load order | contain inline JS/CSS/logic |
| `main.js` + feature modules | all behaviour, IPC calls, DOM writes | hard-code wire formats beyond the documented DTOs |
| `styles.css` | tokens, layout, component states | hard-code content or measurements of data |

**Element id contract** (referenced by the feature modules):

```
search-form  search-input  results  error  player  now-playing  now-artist
badge  cover  audio  telemetry  history  queue  play-all  clear-queue
diag  diag-wrap  source
```

Renaming any of these requires grepping `app/src/*.js` and updating every
module that uses the id in the same change.

---

## 15. UI Roadmap (phased)

| Phase | UI work |
|---|---|
| 3 ✅ | search → results → sticky player → queue → history → diagnostics |
| 4 | verify badge/telemetry against a real play-through; record cold-start timing |
| 5 | album/artist/playlist browsing, quality picker, artwork caching, infinite scroll |
| 6 | **button semantics + focus rings + `aria-live`**, keyboard shortcuts, light theme, two-column wide layout, persisted diagnostics |
| 7 | offline banner, CSP-compatible markup (no inline handlers), reduced-motion guard |
| 8 | tray/mini-player, media keys, empty-state illustrations |

---

## 16. UI Anti-Patterns (explicitly avoided)

| Anti-pattern | Why avoided here |
|---|---|
| Skeleton loaders that don't resolve | text states (`resolving…`) are truthful |
| Optimistic "playing" before the probe | badge is set from the *measured* `RangeStatus` |
| Toast spam | one banner + a diagnostics log |
| Infinite scroll without bounds | 20-result pages with explicit `Play all` |
| Spinner-only errors | every failure carries a message naming the hop |
| Auto-playing on launch | playback starts only on explicit user action |
| Green "success" decoration | green is reserved for verified states |
