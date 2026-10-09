// notepad.js — desktop scratchpad core (Phase 1 · docs/notepad/govinda.md).
//
// Activation contract (docs/notepad/features.md): the panel opens ONLY from
// the global `shortcut:notepad` event (Ctrl+Alt+P / Caps+P, registered in
// shortcuts.rs) via toggleNotepad(). There is deliberately no button, menu
// item, tray entry or route that can open it. Tabs behave like Windows
// Notepad: every note is a tab, the strip switches between them, the open
// session survives restarts, and everything auto-saves — no dialogs, so no
// buttons anywhere.
//
// Module rules (frozen contract: docs/notepad/README.md §2):
//  * No top-level DOM / localStorage / core.js access — node --test imports
//    this file directly for its pure state logic (the html.js lesson).
//  * toast/diag resolve core.js lazily (the qrview.js lesson: a static
//    import would drag the whole app graph into the test runner).
//  * Content model is a plain-text string forever (README §2.3). The three
//    peer modules are dynamic-imported with .catch so a file that does not
//    exist yet can never break the panel — that is what makes the four
//    phases parallel-safe.
//
// Keydown pipeline (order is the contract, README §2.2):
//   input-local handler → stopPropagation (panel isolation) →
//   peer relay (cancelable) → core's own map.

// ------------------------------------------------------------------ state -
const LS_KEY = "tm-notepad";
const SAVE_DEBOUNCE_MS = 400;

let notes = {}; // id -> { name, content, updated }  (plain text forever)
let tabs = []; // open tab ids, in strip order
let active = null; // id of the active tab
let loaded = false;
let saveTimer = 0;
let lastSaved = ""; // "hh:mm:ss" for the status bar
const dirty = new Set(); // ids edited since the last flush

// Storage degrades to memory when localStorage is absent or full, so the
// module stays importable in Node and a quota error never eats a session.
const mem = new Map();
const store = {
  get(k) {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem(k);
        if (v !== null) return v;
      }
    } catch {}
    return mem.get(k) ?? null;
  },
  set(k, v) {
    mem.set(k, v);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
    } catch {} // quota: mem keeps this session alive; next flush retries
  },
};

/// Heal anything the world throws at stored JSON: wrong types, stale tab
/// ids, duplicate tabs. Garbage in → a valid state, never a throw.
export function sanitizeState(parsed) {
  const out = { notes: {}, tabs: [], active: null };
  if (!parsed || typeof parsed !== "object") return out;
  if (parsed.notes && typeof parsed.notes === "object") {
    for (const [id, v] of Object.entries(parsed.notes)) {
      if (!v || typeof v !== "object") continue;
      out.notes[id] = {
        name: typeof v.name === "string" && v.name.trim() ? v.name : "Untitled",
        content: typeof v.content === "string" ? v.content : "",
        updated: Number.isFinite(v.updated) ? v.updated : 0,
      };
    }
  }
  if (Array.isArray(parsed.tabs)) {
    const seen = new Set();
    for (const id of parsed.tabs) {
      if (typeof id === "string" && out.notes[id] && !seen.has(id)) {
        seen.add(id);
        out.tabs.push(id);
      }
    }
  }
  if (typeof parsed.active === "string" && out.notes[parsed.active]) out.active = parsed.active;
  else out.active = out.tabs[0] ?? null;
  return out;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  let raw;
  try {
    raw = JSON.parse(store.get(LS_KEY) || "null");
  } catch {
    raw = null;
  }
  const s = sanitizeState(raw);
  notes = s.notes;
  tabs = s.tabs;
  active = s.active;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// -------------------------------------------------------------- DOM refs -
// Set only after build(); every renderer no-ops while null, which is what
// lets the pure state functions run headlessly in node --test.
let panel = null;
let tabsEl, pad, hint, statusText, findEl, findInput, findCount, switchEl, switchInput, switchList;

const MOUNTS = {
  side: "#npd-side",
  tabmeta: "#npd-tabmeta",
  rail: "#npd-rail",
  statusExtra: "#npd-status-extra",
  overlay: "#npd-overlay",
  aside: "#npd-aside",
};

// --------------------------------------------------------------- events -
const subs = { open: [], close: [], note: [], saved: [], keydown: [] };

/// Subscribe to a panel event; returns an unsubscribe fn.
///   "open" | "close"  → fn()
///   "note"            → fn({ id, note })   tab switched / panel reopened
///   "saved"           → fn({ id })         after a flush, once per edited id
///   "keydown"         → fn(ev)             RAW event, cancelable — call
///                                           ev.preventDefault() to claim a
///                                           chord before core's own map
export function on(type, fn) {
  (subs[type] || (subs[type] = [])).push(fn);
  return () => {
    subs[type] = (subs[type] || []).filter((f) => f !== fn);
  };
}

function fire(type, detail) {
  for (const fn of [...(subs[type] || [])]) {
    try {
      fn(detail);
    } catch (err) {
      log("notepad:" + type, false, String(err));
    }
  }
}

// Lazy core.js (browser-only; keeps this module free of the app graph).
function notify(msg, kind = "info", ms = 4500) {
  if (!panel) return;
  import("./core.js")
    .then((m) => m.toast(msg, kind, ms))
    .catch(() => {});
}
function log(step, ok, detail) {
  if (!panel) return;
  import("./core.js")
    .then((m) => m.diag(step, ok, detail))
    .catch(() => {});
}

// ---------------------------------------------------------------- saves -
function scheduleSave() {
  if (!panel) return; // headless: state stays in memory for the test
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

/// Flush to storage NOW (debounce fired, Ctrl+S, close, pagehide). Writes
/// notes and session in ONE key, so a crash can never desynchronise the
/// tab list from the notes it points at.
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  ensureLoaded();
  store.set(LS_KEY, JSON.stringify({ notes, tabs, active }));
  lastSaved = new Date().toLocaleTimeString();
  renderStatus();
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) fire("saved", { id });
}

// -------------------------------------------------------- pure helpers -
export function wordCount(v) {
  const t = String(v || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

/// All case-insensitive match starts (shared by find navigation + counting).
export function matchIndices(value, query) {
  const q = String(query || "");
  if (!q) return [];
  const lc = String(value || "").toLowerCase();
  const nq = q.toLowerCase();
  const out = [];
  let i = 0;
  while ((i = lc.indexOf(nq, i)) !== -1) {
    out.push(i);
    i += nq.length;
  }
  return out;
}

/// Next match index: forward = first at/after `from` (wrap → first match);
/// backward = last strictly before `from` (wrap → last match). -1 = none.
export function findNextIndex(value, query, from, dir) {
  const m = matchIndices(value, query);
  if (!m.length) return -1;
  const f = from || 0;
  if (dir >= 0) {
    for (const i of m) if (i >= f) return i;
    return m[0]; // wrap to the top
  }
  for (let j = m.length - 1; j >= 0; j--) if (m[j] < f) return m[j];
  return m[m.length - 1]; // wrap to the bottom
}

function countMatches(value, query) {
  return matchIndices(value, query).length;
}

/// Default switcher ranking: substring on the name, else keep recency
/// order. Replaced wholesale when a peer registers a filter (README §2.2).
export function rankRows(rows, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => String(r.name).toLowerCase().includes(s));
}

const filters = [];
export function addSwitcherFilter(fn) {
  if (typeof fn === "function") filters.push(fn);
  return () => {
    const i = filters.indexOf(fn);
    if (i >= 0) filters.splice(i, 1);
  };
}

function allRowEntries() {
  return Object.entries(notes)
    .map(([id, n]) => ({ id, name: n.name || "Untitled", updated: n.updated || 0 }))
    .sort((a, b) => b.updated - a.updated);
}

function switchRows(query) {
  let rows = allRowEntries();
  const q = String(query || "").trim();
  if (filters.length) {
    // Contributors own the result completely — chain order = registration
    // order; each may return [] or the full set.
    for (const f of filters) {
      try {
        rows = f(q, rows) || rows;
      } catch (err) {
        log("notepad:filter", false, String(err));
      }
    }
  } else {
    rows = rankRows(rows, q);
  }
  // README §2.2: pinned rows float first regardless of contributor order
  // (Array#sort is stable, so recency survives inside each group).
  return [...rows].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

// ---------------------------------------------- state ops (exported for tests) -
export function getSnapshot() {
  ensureLoaded();
  return { notes: JSON.parse(JSON.stringify(notes)), tabs: [...tabs], active };
}
export function activeNote() {
  ensureLoaded();
  return active && notes[active] ? { id: active, ...notes[active] } : null;
}
export function allNotes() {
  ensureLoaded();
  return { ...notes };
}

function activate(id) {
  if (!notes[id]) return;
  active = id;
  if (pad) pad.value = notes[id].content;
  renderTabs();
  syncEditor();
  renderStatus();
  scheduleSave();
  if (panel && !panel.hidden) fire("note", { id, note: notes[id] });
}

/// Create + open a new note (also the contract's core.newNote).
export function newTab(name, content) {
  ensureLoaded();
  const id = uid();
  notes[id] = {
    name: typeof name === "string" && name.trim() ? name.trim() : "Untitled",
    content: typeof content === "string" ? content : "",
    updated: Date.now(),
  };
  tabs.push(id);
  activate(id);
  return id;
}

/// Close a tab — the note itself survives in storage (Windows-Notepad
/// semantics: closing the tab is not deleting the file).
export function closeTab(id) {
  ensureLoaded();
  const i = tabs.indexOf(id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (active === id) {
    active = tabs[Math.min(i, tabs.length - 1)] ?? null;
    if (active) {
      if (pad) pad.value = notes[active].content;
      fire("note", { id: active, note: notes[active] });
    }
  }
  renderTabs();
  syncEditor();
  renderStatus();
  scheduleSave();
}

export function openNoteById(id) {
  ensureLoaded();
  if (!notes[id]) {
    // Pseudo ids are how peers' switcher actions activate: Devi's action
    // rows carry `npdo-dup` / `npdo-tpl:<name>` (no such note exists), and
    // her `on("note")` handler intercepts the id BEFORE touching d.note.
    // Subscribers therefore must guard `d.note` — an unknown id is an
    // "open attempted" signal, not a tab switch (README §2.2).
    if (id) fire("note", { id, note: null });
    return;
  }
  if (!tabs.includes(id)) tabs.push(id);
  activate(id);
}

export function renameNote(id, name) {
  ensureLoaded();
  if (!notes[id]) return;
  const v = String(name || "").trim();
  notes[id].name = v || "Untitled";
  notes[id].updated = Date.now();
  dirty.add(id);
  renderTabs();
  scheduleSave();
}

export function deleteNote(id) {
  ensureLoaded();
  if (!notes[id]) return;
  delete notes[id];
  if (tabs.includes(id)) closeTab(id);
  dirty.delete(id); // gone: no point announcing a save for it
  scheduleSave();
}

export function cycleTab(dir) {
  ensureLoaded();
  if (!tabs.length) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i < 0 ? 0 : i + dir + tabs.length) % tabs.length]);
}

export function setNoteContent(id, text) {
  ensureLoaded();
  if (!notes[id]) return;
  notes[id].content = String(text ?? "");
  notes[id].updated = Date.now();
  dirty.add(id);
  if (id === active && pad) pad.value = notes[id].content;
  renderStatus();
  scheduleSave();
}

function onInput() {
  if (active == null || !notes[active] || !pad) return;
  notes[active].content = pad.value;
  notes[active].updated = Date.now();
  dirty.add(active);
  scheduleSave();
  renderStatus();
}

// ------------------------------------------------------------- rendering -
function renderTabs() {
  if (!tabsEl) return;
  tabsEl.textContent = "";
  for (const id of tabs) {
    const n = notes[id];
    if (!n) continue;
    const t = document.createElement("div");
    t.className = "npd-tab" + (id === active ? " npd-active" : "");
    t.dataset.id = id;
    t.setAttribute("role", "tab");
    t.setAttribute("aria-selected", String(id === active));
    t.setAttribute("aria-controls", "npd-pad");
    t.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "npd-tab-label";
    label.textContent = n.name || "Untitled";
    t.appendChild(label);
    const closeBtn = document.createElement("span");
    closeBtn.className = "npd-tab-close";
    closeBtn.setAttribute("role", "button");
    closeBtn.setAttribute("aria-label", `Close ${n.name || "Untitled"}`);
    closeBtn.innerHTML =
      '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // closing must not activate the tab first
      closeTab(id);
    });
    closeBtn.addEventListener("dblclick", (e) => e.stopPropagation());
    t.appendChild(closeBtn);
    t.addEventListener("click", () => activate(id));
    t.addEventListener("dblclick", () => startRename(id, t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(id);
      }
    });
    tabsEl.appendChild(t);
    if (id === active) t.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

/// Pad <-> empty-hint swap. The panel stays open with zero tabs (the hint
/// offers Ctrl+T / Ctrl+P) — closing the last tab is not a shutdown.
function syncEditor() {
  if (!pad) return;
  const has = active != null && !!notes[active];
  pad.hidden = !has;
  hint.hidden = has;
  if (has) {
    pad.value = notes[active].content;
    pad.setAttribute("aria-label", notes[active].name || "Untitled");
  } else {
    pad.value = "";
    pad.setAttribute("aria-label", "No open tabs");
  }
}

function caretPos() {
  if (!pad) return { line: 1, col: 1 };
  const upto = pad.value.slice(0, pad.selectionStart ?? 0);
  return { line: upto.split("\n").length, col: upto.length - upto.lastIndexOf("\n") };
}

function renderStatus() {
  if (!statusText) return;
  const { line, col } = caretPos();
  const words = wordCount(pad ? pad.value : "");
  let s = `Ln ${line}, Col ${col} · ${words} word${words === 1 ? "" : "s"}`;
  if (active == null || !notes[active]) s = "No open tabs";
  else if (lastSaved) s += ` · saved ${lastSaved}`;
  statusText.textContent = s;
}

// ---------------------------------------------------------------- find -
function openFind() {
  if (!findEl) return;
  closeSwitch();
  findEl.hidden = false;
  findInput.value = "";
  findCount.textContent = "";
  findInput.focus();
  findInput.select();
}

function closeFind() {
  if (!findEl || findEl.hidden) return;
  findEl.hidden = true;
  pad?.focus();
}

function doFind(dir) {
  if (!pad || active == null) return;
  const q = findInput.value;
  if (!q) return;
  const from = dir > 0 ? (pad.selectionEnd ?? 0) : (pad.selectionStart ?? 0);
  const i = findNextIndex(pad.value, q, from, dir);
  if (i < 0) {
    findCount.textContent = "no matches";
    return;
  }
  pad.focus(); // selection renders in the doc (find bar stays open)
  pad.setSelectionRange(i, i + q.length);
  const total = countMatches(pad.value, q);
  findCount.textContent = `${i + 1} of ${total}`;
  renderStatus();
}

// ------------------------------------------------------------- switcher -
let switchRowsCache = [];
let switchSel = 0;

function openSwitch() {
  if (!switchEl) return;
  closeFind();
  switchEl.hidden = false;
  switchInput.value = "";
  switchSel = 0;
  renderSwitch("");
  if (motionOk()) {
    // translateX(-50%) is part of the switcher's centring — carry it
    // through the keyframes or WAAPI's transform overrides it mid-flight.
    anim(
      switchEl,
      [
        { opacity: 0, transform: "translateX(-50%) translateY(6px)" },
        { opacity: 1, transform: "translateX(-50%) translateY(0)" },
      ],
      140,
      EASE_OUT
    );
  }
  switchInput.focus();
}

function closeSwitch() {
  if (!switchEl || switchEl.hidden) return;
  switchEl.hidden = true;
  pad?.focus();
}

function renderSwitch(query) {
  if (!switchList) return;
  switchRowsCache = switchRows(query);
  if (switchSel >= switchRowsCache.length) switchSel = 0;
  switchList.textContent = "";
  const q = String(query || "").trim();
  if (!switchRowsCache.length) {
    const row = document.createElement("div");
    row.className = "npd-row npd-row-hint";
    row.textContent = q ? `No note matches — Enter creates “${q}”` : "No notes yet — type a name";
    switchList.appendChild(row);
    return;
  }
  switchRowsCache.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "npd-row" + (i === switchSel ? " npd-sel" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === switchSel));
    const name = document.createElement("span");
    name.className = "npd-row-name";
    name.textContent = r.name;
    row.appendChild(name);
    if (r.hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "npd-row-hint";
      hintEl.textContent = r.hint;
      row.appendChild(hintEl);
    }
    // mousedown before blur: keep the input focused so blur-close can't race
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => pickSwitchRow(i));
    switchList.appendChild(row);
  });
}

function moveSwitch(delta) {
  if (!switchRowsCache.length) return;
  switchSel = (switchSel + delta + switchRowsCache.length) % switchRowsCache.length;
  renderSwitch(switchInput.value);
  switchList.children[switchSel]?.scrollIntoView({ block: "nearest" });
}

function pickSwitchRow(i) {
  const r = switchRowsCache[i];
  if (!r) return;
  closeSwitch();
  openNoteById(r.id);
}

function commitSwitch() {
  const q = switchInput.value.trim();
  if (switchRowsCache.length) {
    pickSwitchRow(switchSel);
  } else if (q) {
    closeSwitch();
    newTab(q, "");
  }
}

// --------------------------------------------------------------- rename -
function startRename(id, tabEl) {
  const n = notes[id];
  if (!n || !tabEl) return;
  const label = tabEl.querySelector(".npd-tab-label");
  if (!label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "npd-rename";
  input.value = n.name;
  input.setAttribute("aria-label", "Rename note");
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== n.name) renameNote(id, v);
    else renderTabs(); // restore the original label
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function renameActive() {
  if (!tabsEl || active == null) return;
  const t = tabsEl.querySelector(`.npd-tab[data-id="${active}"]`);
  startRename(active, t);
}

// -------------------------------------------------------- keydown core -
function relayKeydown(ev) {
  for (const fn of [...(subs.keydown || [])]) {
    try {
      fn(ev);
    } catch (err) {
      log("notepad:keydown", false, String(err));
    }
    if (ev.defaultPrevented) return;
  }
}

/// Innermost-first: find → switcher → panel (govinda.md task 8).
function escapeLayer() {
  if (findEl && !findEl.hidden) {
    closeFind();
    return true;
  }
  if (switchEl && !switchEl.hidden) {
    closeSwitch();
    return true;
  }
  return false;
}

function insertTabChar() {
  pad.focus();
  let ok = false;
  try {
    ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, "\t");
  } catch {}
  if (!ok) {
    const s = pad.selectionStart ?? pad.value.length;
    const e = pad.selectionEnd ?? s;
    pad.value = pad.value.slice(0, s) + "\t" + pad.value.slice(e);
    pad.selectionStart = pad.selectionEnd = s + 1;
    onInput();
  }
}

function coreMap(ev) {
  const k = ev.key;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const alt = ev.altKey;
  const lc = k.toLowerCase();

  // Esc closes the innermost layer, else the panel itself.
  if (k === "Escape") {
    if (escapeLayer()) ev.preventDefault();
    else closePanel();
    ev.preventDefault();
    return;
  }

  // Delete inside the switcher: hard delete (Devi's trash claims this key
  // first through the relay when her module is loaded — README §2.5).
  if (k === "Delete" && ev.target === switchInput && switchRowsCache.length) {
    ev.preventDefault();
    const r = switchRowsCache[switchSel];
    if (r) {
      deleteNote(r.id);
      renderSwitch(switchInput.value);
      notify("Note deleted", "info", 2500);
    }
    return;
  }

  if (ctrl && !alt) {
    if (lc === "t") {
      ev.preventDefault();
      newTab();
      return;
    }
    if (lc === "w") {
      ev.preventDefault();
      if (active) closeTab(active);
      return;
    }
    if (lc === "s") {
      ev.preventDefault();
      saveNow();
      notify("Saved", "success", 1600);
      return;
    }
    if (lc === "f") {
      ev.preventDefault();
      openFind();
      return;
    }
    if (lc === "p") {
      ev.preventDefault();
      openSwitch();
      return;
    }
    if (k === "Tab") {
      ev.preventDefault();
      cycleTab(ev.shiftKey ? -1 : 1);
      return;
    }
    if (/^[1-9]$/.test(k)) {
      ev.preventDefault();
      const id = tabs[Number(k) - 1];
      if (id) openNoteById(id);
      return;
    }
    return; // Ctrl+Z/Y/A/C/X/V etc. stay native to the textarea
  }

  if (k === "F2") {
    ev.preventDefault();
    renameActive();
    return;
  }

  // Alt fallbacks — only chords the CDP probe proved deliverable in
  // WebView2 (browser-reserved Chromium chords like Ctrl+Tab may never
  // reach the page; see the Report in govinda.md).
  if (alt && !ctrl) {
    if (lc === "t") {
      ev.preventDefault();
      newTab();
      return;
    }
    if (lc === "w") {
      ev.preventDefault();
      if (active) closeTab(active);
      return;
    }
    if (k === "ArrowRight") {
      ev.preventDefault();
      cycleTab(1);
      return;
    }
    if (k === "ArrowLeft") {
      ev.preventDefault();
      cycleTab(-1);
      return;
    }
    return;
  }

  // Plain Tab in the editor inserts a tab character, like Notepad —
  // everywhere else Tab keeps its focus behaviour.
  if (k === "Tab" && ev.target === pad && !ctrl && !alt) {
    ev.preventDefault();
    insertTabChar();
  }
}

function onKeydown(ev) {
  ev.stopPropagation(); // the panel is a scope of its own: app-level
  // handlers (Space plays, Ctrl+K focuses search, Ctrl+D downloads) never
  // see a key typed inside the panel — they live on window and would
  // otherwise fire under the editor.
  if (ev.defaultPrevented) return; // an input-local handler claimed it
  relayKeydown(ev);
  if (ev.defaultPrevented) return; // a peer claimed it (README §2.2)
  coreMap(ev);
}

// ------------------------------------------------------ peers (parallel) -
let peersLoaded = false;
async function loadPeers() {
  if (peersLoaded) return;
  peersLoaded = true;
  const c = core;
  // Each import is independent: a module that does not exist yet (another
  // phase still in flight) rejects and is skipped without touching the
  // others — this is the whole basis of the four-agent parallel build.
  await Promise.allSettled([
    import("./notepad-org.js")
      .then((m) => m.initNotepadOrg(c))
      .catch(() => {}),
    import("./notepad-blocks.js")
      .then((m) => m.initNotepadBlocks(c))
      .catch(() => {}),
    import("./notepad-music.js")
      .then((m) => m.initNotepadMusic(c))
      .catch(() => {}),
  ]);
}

// ------------------------------------------------------------ build/DOM -
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content.firstElementChild;
}

function build() {
  // Stylesheet injected here (not index.html — that file is off-limits to
  // every phase, README §1), stamped per launch like styles.css.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "notepad.css?v=" + Date.now();
  document.head.appendChild(link);

  panel = el(`
    <div id="npd-panel" class="npd-panel" hidden>
      <div class="npd-backdrop"></div>
      <div class="npd-card" role="dialog" aria-label="Notepad" aria-modal="true">
        <div id="npd-find" class="npd-find" hidden>
          <input class="npd-find-input" placeholder="Find in note… (Enter next, Shift+Enter previous)" aria-label="Find in note">
          <span class="npd-find-count"></span>
          <button type="button" class="npd-find-btn" data-npd-find="-1" aria-label="Previous match"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M8.5 2.5 4.5 6l4 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="npd-find-btn" data-npd-find="1" aria-label="Next match"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3.5 2.5 7.5 6l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
        <div id="npd-tabs" class="npd-tabs" role="tablist" aria-label="Open notes"></div>
        <div class="npd-body">
          <div id="npd-side" class="npd-mount npd-side" data-npd-mount="side"></div>
          <div class="npd-main">
            <div id="npd-tabmeta" class="npd-mount npd-tabmeta" data-npd-mount="tabmeta"></div>
            <textarea id="npd-pad" class="npd-pad" spellcheck="false" aria-label="Note text"></textarea>
            <div id="npd-hint" class="npd-hint" hidden><p>No open tabs — press <kbd class="npd-kbd">Ctrl</kbd><kbd class="npd-kbd">T</kbd> for a new note or <kbd class="npd-kbd">Ctrl</kbd><kbd class="npd-kbd">P</kbd> to jump to one.</p></div>
            <div id="npd-rail" class="npd-mount npd-rail" data-npd-mount="rail"></div>
            <div class="npd-status">
              <span id="npd-status-text" class="npd-status-text"></span>
              <span class="npd-legend" aria-hidden="true"><kbd class="npd-kbd">^T</kbd> new · <kbd class="npd-kbd">^W</kbd> close · <kbd class="npd-kbd">^P</kbd> jump · <kbd class="npd-kbd">^F</kbd> find · <kbd class="npd-kbd">^S</kbd> save · <kbd class="npd-kbd">F2</kbd> rename</span>
              <span id="npd-status-extra" class="npd-mount npd-status-extra" data-npd-mount="statusExtra"></span>
            </div>
          </div>
          <div id="npd-aside" class="npd-mount npd-aside" data-npd-mount="aside"></div>
        </div>
        <div id="npd-switch" class="npd-switch" data-npd-switcher hidden>
          <input class="npd-switch-input" placeholder="Jump to a note… (Enter opens, creates when no match)" aria-label="Note switcher">
          <div id="npd-switch-list" class="npd-switch-list" role="listbox"></div>
        </div>
        <div id="npd-overlay" class="npd-mount npd-overlay" data-npd-mount="overlay"></div>
      </div>
    </div>`);
  document.body.appendChild(panel);

  tabsEl = panel.querySelector("#npd-tabs");
  pad = panel.querySelector("#npd-pad");
  hint = panel.querySelector("#npd-hint");
  statusText = panel.querySelector("#npd-status-text");
  findEl = panel.querySelector("#npd-find");
  findInput = panel.querySelector(".npd-find-input");
  findCount = panel.querySelector(".npd-find-count");
  switchEl = panel.querySelector("#npd-switch");
  switchInput = panel.querySelector(".npd-switch-input");
  switchList = panel.querySelector("#npd-switch-list");

  // Panel isolation: one keydown entry point (README §2.2 pipeline).
  panel.addEventListener("keydown", onKeydown);

  // Backdrop = Esc, layer for layer.
  panel.querySelector(".npd-backdrop").addEventListener("click", () => {
    if (!escapeLayer()) closePanel();
  });

  pad.addEventListener("input", onInput);
  for (const evt of ["keyup", "click", "select"]) pad.addEventListener(evt, renderStatus);

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doFind(e.shiftKey ? -1 : 1);
    }
  });
  findInput.addEventListener("input", () => {
    if (!findInput.value || active == null || !pad) {
      findCount.textContent = "";
      return;
    }
    const n = countMatches(pad.value, findInput.value);
    findCount.textContent = n === 0 ? "No matches" : `${n} matches`;
  });

  // Mouse path for find (Enter / Shift+Enter stay the keyboard path).
  for (const btn of panel.querySelectorAll("[data-npd-find]")) {
    btn.addEventListener("click", () => doFind(Number(btn.dataset.npdFind) || 1));
  }

  switchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSwitch(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSwitch(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitSwitch();
    }
    // Esc and Delete bubble to the panel pipeline (coreMap / relay).
  });
  switchInput.addEventListener("input", () => {
    switchSel = 0;
    renderSwitch(switchInput.value);
  });
  switchInput.addEventListener("blur", () => {
    // Click-away closes the switcher (rows use mousedown-preventDefault so
    // a click on a row wins over this).
    setTimeout(() => {
      if (switchEl && !switchEl.hidden && !switchEl.contains(document.activeElement)) closeSwitch();
    }, 120);
  });

  // Flush on the ways out — no session loses an unsaved debounce.
  window.addEventListener("pagehide", saveNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
  });
}

// ------------------------------------------------------------- open/close -
// One authored motion moment (docs/notepad/ui-polish.md P3): the panel
// rises/fades in and out via WAAPI. Gated three ways so nothing else
// changes behaviour: the Node mini-DOM test harness has no `.animate`
// (keeps today's synchronous hidden-toggle), reduced-motion users get
// none, and a rapid reopen invalidates a pending exit via closeSeq.
let lastFocus = null;
let closeSeq = 0;

function motionOk() {
  try {
    return typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function anim(el, frames, ms, easing) {
  try {
    if (!el || typeof el.animate !== "function") return null;
    return el.animate(frames, { duration: ms, easing, fill: "none" });
  } catch {
    return null;
  }
}

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

async function openPanel() {
  ensureLoaded();
  if (!panel) build();
  closeSeq++; // cancel any pending exit hide
  try {
    const a = document.activeElement;
    if (a && a !== document.body && !panel.contains(a)) lastFocus = a;
  } catch {
    lastFocus = null;
  }
  // Session-restore policy: reopen the most recently edited note when the
  // strip is empty but notes exist; first-ever run gets one blank tab.
  if (!tabs.length) {
    const newest = Object.entries(notes).sort((a, b) => b[1].updated - a[1].updated)[0];
    if (newest) {
      tabs.push(newest[0]);
      active = newest[0];
    } else {
      newTab();
    }
  }
  if (active == null || !notes[active]) active = tabs[0] ?? null;
  panel.hidden = false;
  if (motionOk()) {
    anim(panel.querySelector(".npd-backdrop"), [{ opacity: 0 }, { opacity: 1 }], 200, EASE_OUT);
    anim(panel.querySelector(".npd-card"), [{ opacity: 0, transform: "translateY(10px) scale(0.985)" }, { opacity: 1, transform: "none" }], 200, EASE_OUT);
  }
  renderTabs();
  syncEditor();
  renderStatus();
  await loadPeers(); // peers register filters/listeners BEFORE the events
  if (panel.hidden) return; // closed while loading — stay quiet
  fire("open");
  if (active && notes[active]) fire("note", { id: active, note: notes[active] });
  pad?.focus();
}

function closePanel() {
  if (!panel || panel.hidden) return;
  saveNow();
  closeFind();
  closeSwitch();
  const seq = ++closeSeq;
  const out = motionOk()
    ? anim(panel.querySelector(".npd-card"), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px) scale(0.99)" }], 130, EASE_IN)
    : null;
  const finish = () => {
    if (seq !== closeSeq) return; // reopened mid-exit — stay visible
    panel.hidden = true;
    const t = lastFocus;
    lastFocus = null;
    try {
      if (t && typeof t.focus === "function" && t.isConnected !== false && document.contains(t)) t.focus();
    } catch {}
  };
  if (out && typeof out.finished?.then === "function") out.finished.then(finish, finish);
  else finish();
  fire("close");
}

/// The single public entry: wired to the `shortcut:notepad` event only
/// (shortcuts.js) — there is no other caller anywhere in the app.
export function toggleNotepad() {
  if (panel && !panel.hidden) closePanel();
  else openPanel();
}

// ------------------------------------------------------- contract (README §2.2) -
function insertAtCursor(text) {
  if (!pad || active == null) return;
  pad.focus();
  let ok = false;
  try {
    ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, String(text));
  } catch {}
  if (!ok) {
    const s = pad.selectionStart ?? pad.value.length;
    const e = pad.selectionEnd ?? s;
    pad.value = pad.value.slice(0, s) + text + pad.value.slice(e);
    pad.selectionStart = pad.selectionEnd = s + String(text).length;
    onInput();
  }
}

const core = {
  on,
  mount(name) {
    return panel && MOUNTS[name] ? panel.querySelector(MOUNTS[name]) : null;
  },
  panel: () => panel,
  textarea: () => pad,
  addSwitcherFilter,
  activeNote,
  allNotes,
  setNoteContent,
  insertAtCursor,
  selection: () => ({
    start: pad?.selectionStart ?? 0,
    end: pad?.selectionEnd ?? 0,
    value: pad?.value ?? "",
  }),
  setSelection(start, end) {
    if (!pad) return;
    pad.focus();
    pad.setSelectionRange(start, end);
  },
  openNote: openNoteById,
  closeNote: closeTab,
  newNote: newTab,
  refresh: () => {
    renderTabs();
    renderStatus();
  },
  toast: notify,
  diag: log,
};
