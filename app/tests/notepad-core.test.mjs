// notepad-core.test.mjs — static contracts + fake-DOM behaviour for
// app/src/notepad.js (Phase 1 · docs/notepad/govinda.md, tasks 2-12).
//
// Layers, in file order:
//  1. Import proof — notepad.js is imported BEFORE any DOM global exists,
//     so a top-level document/localStorage access fails the whole file
//     (govinda.md task 2: "importing the module in Node touches no DOM").
//  2. Static contracts — six mount ids, three catch-guarded peer imports,
//     relay-before-core keydown order, chord listings across four files,
//     CSS token coverage, activation contract (the hotkey is the only door).
//  3. Fake-DOM behaviour — a mini DOM parses the REAL skeleton (tiny HTML
//     parser), keeps a real listener registry and implements the selector
//     subset the core uses, so tests DRIVE tabs / rename / autosave / find
//     wrap / switcher / relay claims / Esc layers instead of merely letting
//     the module evaluate (the mobile-boot lesson: static gates never run
//     the code — only driven events do).
//
// Peer reality: notepad-org.js / notepad-blocks.js / notepad-music.js exist
// and init into the FIRST instance that opens (their `init*` guards are
// per-module, and every extra instance below imports the SAME cached peer
// modules — so later instances get no peer filters/claims at all):
//   np        — peers active: integration surface (presence-based switcher
//               assertions; her filter and relay claims are respected).
//   npPure    — `?govinda=1` : peers early-return => exact row counts,
//               default ranking, hard-Delete, create-on-no-match.
//   npRestore — `?restore=1` : session restore from flushed storage.
//   npCorrupt — `?corrupt=1` : corrupt JSON heals, never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const repoRoot = path.join(here, "..", "..");
const readSrc = (f) => fs.readFileSync(path.join(srcDir, f), "utf8");
const readRepo = (f) => fs.readFileSync(path.join(repoRoot, f), "utf8");

const js = readSrc("notepad.js");
const css = readSrc("notepad.css");

// ------------------------------------------------- layer 1: clean import -
const np = await import(pathToFileURL(path.join(srcDir, "notepad.js")).href);

// --------------------------------------------------- layer 2: static -----
test("static: exports the contract entry points (README §2.2)", () => {
  assert.equal(typeof np.toggleNotepad, "function");
  for (const fn of [
    "on",
    "addSwitcherFilter",
    "activeNote",
    "allNotes",
    "setNoteContent",
    "openNoteById",
    "sanitizeState",
    "findNextIndex",
    "rankRows",
    "wordCount",
  ]) {
    assert.equal(typeof np[fn], "function", `missing export ${fn}`);
  }
});

test("static: all six mount ids exist in the skeleton AND the MOUNTS map", () => {
  const mounts = ["npd-side", "npd-tabmeta", "npd-rail", "npd-status-extra", "npd-overlay", "npd-aside"];
  for (const id of mounts) {
    assert.ok(js.includes(`id="${id}"`), `skeleton missing #${id}`);
    assert.ok(js.includes(`"#${id}"`), `MOUNTS map missing #${id}`);
  }
  assert.ok(js.split('data-npd-mount="').length - 1 >= 6, "every mount needs data-npd-mount");
  // Devi's switcher-open probe (her doc: "provisional until Govinda's core
  // lands") — the sanctioned visibility hook, documented in README §2.2.
  assert.ok(js.includes("data-npd-switcher"), "switcher must carry data-npd-switcher");
});

test("static: three peer imports, each initialised and catch-guarded (task 9)", () => {
  for (const [file, init] of [
    ["notepad-org.js", "initNotepadOrg"],
    ["notepad-blocks.js", "initNotepadBlocks"],
    ["notepad-music.js", "initNotepadMusic"],
  ]) {
    const i = js.indexOf(`import("./${file}")`);
    assert.ok(i >= 0, `missing dynamic import of ${file}`);
    const window = js.slice(i, i + 300);
    assert.ok(window.includes(init), `${file} not initialised via ${init}`);
    assert.ok(window.includes(".catch(() => {})"), `${file} import is not catch-guarded`);
  }
});

test("static: keydown relay runs before core's own map (task 8 order)", () => {
  const m = /function onKeydown\(ev\) \{[\s\S]*?\n\}/.exec(js);
  assert.ok(m, "onKeydown not found");
  const body = m[0];
  const isolate = body.indexOf("stopPropagation");
  const relay = body.indexOf("relayKeydown(ev)");
  const coreMap = body.indexOf("coreMap(ev)");
  assert.ok(isolate >= 0 && relay >= 0 && coreMap >= 0, "all three stages must appear");
  assert.ok(isolate < relay, "panel isolation must come first");
  assert.ok(relay < coreMap, "peer relay must run BEFORE core's map");
});

test("static: chord listings agree across settings/docs/Rust/shortcuts.js (task 12)", () => {
  const settings = readSrc("settings.js");
  const doc = readRepo("docs/shortcuts.md");
  const rs = readRepo("app/src-tauri/src/shortcuts.rs");
  const sc = readSrc("shortcuts.js");
  // 1. Settings table row
  assert.ok(
    settings.includes('["Notepad (open / close)", "Caps + P", "Ctrl + Alt + P"]'),
    "settings.js row missing or chords differ",
  );
  // 2. docs table row + AutoHotkey recipe line
  assert.ok(
    doc.includes("| Notepad (open / close the panel) | `Caps Lock` + `P` | `Ctrl + Alt + P` |"),
    "docs/shortcuts.md table row missing",
  );
  assert.ok(doc.includes('p::Send("^!+#p")'), "docs/shortcuts.md AHK line missing");
  // 3. Rust action
  const a = rs.indexOf('name: "notepad"');
  assert.ok(a >= 0, "shortcuts.rs action missing");
  const action = rs.slice(a, a + 160);
  assert.ok(action.includes("key: Code::KeyP"), "Rust action must be KeyP");
  assert.ok(action.includes('event: "shortcut:notepad"'), "Rust event name must be shortcut:notepad");
  assert.ok(action.includes("focus: true"), "Rust action must focus the window");
  // 4. JS wiring
  assert.ok(sc.includes('import { toggleNotepad } from "./notepad.js"'), "shortcuts.js import missing");
  assert.ok(sc.includes('"shortcut:notepad": () => toggleNotepad()'), "shortcuts.js ACTIONS entry missing");
});

test("static: every npd- class/id used in JS has a rule in notepad.css (task 10)", () => {
  // data-npd-* are attribute names, not classes — strip before scanning.
  const src = js.replaceAll(/data-npd-[a-z-]+/g, "");
  const tokens = [...new Set(src.match(/npd-[a-z-]+/g) || [])];
  assert.ok(tokens.length >= 25, `token scan looks broken (${tokens.length} tokens)`);
  for (const t of tokens) assert.ok(css.includes(t), `notepad.css has no rule for "${t}"`);
  // Now Playing's prefix is forbidden in notepad files (README §2.4).
  assert.ok(!css.includes(".np-"), "'.np-' is Now Playing's prefix — forbidden");
  // Light + dark pair from the app tokens
  assert.ok(css.includes("html.dark .npd-panel"), "dark-mode inversion missing");
});

test("activation: the hotkey is the only door (success criterion)", () => {
  for (const file of ["index.html", "main.js"]) {
    const text = readRepo(`app/src/${file}`).toLowerCase();
    assert.ok(!text.includes("notepad"), `${file} references notepad — activation contract broken`);
  }
  assert.ok(!js.includes("showView"), "the panel must not open through the router");
});

// ------------------------------------------------- layer 3: mini DOM -----
// A tiny but honest DOM: parses the real skeleton with a small HTML parser,
// keeps a real listener registry, and implements the selector subset the
// core uses (#id / .class / compound [data-id="…"]).
const VOID = new Set(["input", "br", "img", "link", "meta", "hr"]);

function selMatch(n, sel) {
  let ok = true;
  const id = /#([\w-]+)/.exec(sel);
  if (id) ok = ok && n.id === id[1];
  const cls = /\.([\w-]+)/.exec(sel);
  if (cls) ok = ok && String(n.className).split(/\s+/).includes(cls[1]);
  const attr = /\[([\w-]+)="([^"]*)"\]/.exec(sel);
  if (attr) {
    const key = attr[1].startsWith("data-")
      ? attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      : attr[1];
    ok = ok && (attr[1] in n.attrs ? n.attrs[attr[1]] === attr[2] : n.dataset[key] === attr[2]);
  }
  return ok;
}

function walk(node, sel) {
  for (const c of node.children || []) {
    if (selMatch(c, sel)) return c;
    const r = walk(c, sel);
    if (r) return r;
  }
  return null;
}

function walkAll(node, sel, out) {
  for (const c of node.children || []) {
    if (selMatch(c, sel)) out.push(c);
    walkAll(c, sel, out);
  }
  return out;
}

function makeNode(tag) {
  const n = {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    hidden: false,
    value: "",
    text: "",
    selectionStart: 0,
    selectionEnd: 0,
    tabIndex: 0,
    scrollLeft: 0,
    isConnected: true,
    listeners: Object.create(null),
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    get offsetWidth() {
      return this.hidden ? 0 : 10;
    },
    get offsetHeight() {
      return this.hidden ? 0 : 10;
    },
    classList: {
      add(...cs) {
        const set = new Set(String(n.className).split(/\s+/).filter(Boolean));
        for (const c of cs) set.add(c);
        n.className = [...set].join(" ");
      },
      remove(...cs) {
        const set = new Set(String(n.className).split(/\s+/).filter(Boolean));
        for (const c of cs) set.delete(c);
        n.className = [...set].join(" ");
      },
      contains(c) {
        return String(n.className).split(/\s+/).includes(c);
      },
      toggle(c, force) {
        const has = this.contains(c);
        const want = force === undefined ? !has : force;
        if (want) this.add(c);
        else this.remove(c);
        return want;
      },
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    appendChild(c) {
      if (c.parentNode && typeof c.remove === "function") c.remove();
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    append(...cs) {
      for (const c of cs) this.appendChild(typeof c === "string" ? { textContent: c } : c);
    },
    remove() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
      this.parentNode = null;
    },
    replaceWith(node) {
      const p = this.parentNode;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i < 0) return;
      p.children[i] = node;
      node.parentNode = p;
      this.parentNode = null;
    },
    focus() {
      document.activeElement = this;
    },
    blur() {
      if (document.activeElement === this) document.activeElement = document.body;
    },
    select() {
      this.selectionStart = 0;
      this.selectionEnd = this.value.length;
    },
    setSelectionRange(s, e) {
      this.selectionStart = s;
      this.selectionEnd = e;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    hasAttribute(k) {
      return k in this.attrs;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    contains(other) {
      for (let p = other; p; p = p.parentNode) if (p === this) return true;
      return false;
    },
    closest() {
      return null;
    },
    matches(sel) {
      return selMatch(this, sel);
    },
    querySelector(sel) {
      return walk(this, sel);
    },
    querySelectorAll(sel) {
      return walkAll(this, sel, []);
    },
    getClientRects() {
      return this.hidden ? [] : [{}];
    },
    scrollIntoView() {},
    getElementsByTagName() {
      return [];
    },
    click() {
      fireNode(this, "click", mkEvent("click", { target: this }));
    },
  };
  Object.defineProperty(n, "textContent", {
    get() {
      return n.text + n.children.map((c) => (typeof c.textContent === "string" ? c.textContent : "")).join("");
    },
    set(v) {
      n.text = String(v);
      n.children = [];
    },
    configurable: true,
  });
  return n;
}

// Minimal HTML parser for the core's fixed skeleton (elements, attrs, void
// tags, text folded into the parent — whitespace-only text dropped).
function parseHTML(html) {
  const frag = { tag: "#frag", children: [], text: "" };
  const stack = [frag];
  const re =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (String(stack[i].tagName || "").toLowerCase() === m[1]) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = makeNode(tag);
      const parent = stack[stack.length - 1];
      node.parentNode = parent === frag ? null : parent;
      parent.children.push(node);
      const attrRe = /([^\s=]+)(?:\s*=\s*"([^"]*)")?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ""))) {
        const k = a[1];
        if (!k) continue;
        const v = a[2] ?? "";
        if (k === "id") node.id = v;
        else if (k === "class") node.className = v;
        else if (k === "hidden") node.hidden = true;
        else if (k.startsWith("data-")) node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        else node.attrs[k] = v;
      }
      if (!VOID.has(tag)) stack.push(node);
      continue;
    }
    if (m[4] !== undefined) {
      const p = stack[stack.length - 1];
      if (p !== frag && m[4].trim()) p.text += m[4];
    }
  }
  return frag.children[0] || null;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

// --------------------------------------------------------- globals -------
const documentStub = {
  _l: {},
  visibilityState: "visible",
  activeElement: null,
  createElement(tag) {
    if (tag === "template") {
      const t = makeNode("template");
      let parsed = null;
      Object.defineProperty(t, "innerHTML", {
        set(v) {
          parsed = parseHTML(String(v));
        },
        get() {
          return "";
        },
        configurable: true,
      });
      t.content = {
        get firstElementChild() {
          return parsed;
        },
        children: [],
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild(c) {
          this.children.push(c);
          return c;
        },
      };
      return t;
    }
    return makeNode(tag);
  },
  createTextNode: (t) => ({ textContent: t }),
  getElementById(id) {
    return document.querySelector(`#${id}`);
  },
  querySelector(sel) {
    return walk(this.body, sel) || walk(this.head, sel);
  },
  querySelectorAll(sel) {
    return walkAll(this.body, sel, walkAll(this.head, sel, []));
  },
  addEventListener(type, fn) {
    (this._l[type] || (this._l[type] = [])).push(fn);
  },
  removeEventListener() {},
  dispatchEvent: () => true,
  body: makeNode("body"),
  head: makeNode("head"),
  documentElement: makeNode("html"),
  fonts: { ready: Promise.resolve(), add() {} },
};
globalThis.document = documentStub;

const windowStub = {
  _l: {},
  addEventListener(type, fn) {
    (this._l[type] || (this._l[type] = [])).push(fn);
  },
  removeEventListener() {},
};
globalThis.window = windowStub;

const ls = makeStorage();
try {
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
} catch {
  globalThis.localStorage = ls;
}

// ----------------------------------------------------------- helpers -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 4000) throw new Error(`timeout waiting for: ${what}`);
    await sleep(25);
  }
}

function fireNode(node, type, ev) {
  for (const fn of (node && node.listeners && node.listeners[type]) || []) fn(ev);
}
function fireWindow(type, ev) {
  for (const fn of windowStub._l[type] || []) fn(ev);
}
function fireDocument(type, ev) {
  for (const fn of documentStub._l[type] || []) fn(ev);
}

function mkEvent(key, opts = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...opts,
  };
}

// Faithful pipeline: target-phase listeners on the focused element first,
// then the panel entry point — exactly what real bubbling would do.
function key(panel, k, opts = {}) {
  const padEl = panel.querySelector("#npd-pad");
  const target = opts.target || padEl || panel;
  const ev = mkEvent(k, { ...opts, target });
  fireNode(target, "keydown", ev);
  if (!ev.propagationStopped && target !== panel) fireNode(panel, "keydown", ev);
  return ev;
}

function typeInto(node, value) {
  node.value = value;
  fireNode(node, "input", mkEvent("input", { target: node }));
}

function inputPad(panel, value) {
  const pad = panel.querySelector("#npd-pad");
  pad.value = value;
  // Real browsers clamp the selection to the new value's end when .value is
  // set — mirror that so find's `from = pad.selectionEnd` is deterministic.
  pad.selectionStart = pad.selectionEnd = value.length;
  fireNode(pad, "input", mkEvent("input", { target: pad }));
}

// Open an instance and hand back ITS panel: build() appends synchronously
// at toggle time, so the panel is the last body child at that moment.
async function openInstance(mod) {
  const before = document.body.children.length;
  mod.toggleNotepad();
  const panel = document.body.children[before];
  assert.ok(panel && panel.id === "npd-panel", "toggle must build the panel synchronously");
  await until(() => !panel.hidden, "panel visible");
  return panel;
}

function rowNames(switchList) {
  return [...switchList.children].map((r) => r.querySelector(".npd-row-name")?.textContent ?? r.textContent);
}

function readSession() {
  const raw = localStorage.getItem("tm-notepad");
  assert.ok(raw, "tm-notepad must exist in storage after a flush");
  return JSON.parse(raw);
}

// ==================================================================== np ==
// Peers active (integration surface). Everything here is presence-based or
// guarded so Devi's filter/relay claims cannot make it vacuously red.
test("np: toggle opens the panel — skeleton, six mounts, stylesheet, first tab", async () => {
  let opens = 0;
  let closes = 0;
  np.on("open", () => opens++);
  np.on("close", () => closes++);

  const panel = await openInstance(np);
  globalThis.__npPanel = panel;

  for (const id of ["npd-side", "npd-tabmeta", "npd-rail", "npd-status-extra", "npd-overlay", "npd-aside", "npd-tabs", "npd-pad", "npd-find", "npd-switch", "npd-hint", "npd-status-text"]) {
    assert.ok(panel.querySelector(`#${id}`), `#${id} missing from built panel`);
  }
  assert.ok(panel.querySelector(".npd-backdrop"), "backdrop missing");
  assert.ok(
    "npdSwitcher" in panel.querySelector("#npd-switch").dataset,
    "data-npd-switcher must be on the switcher",
  );

  const links = document.head.children.filter(
    (c) => c.tagName === "LINK" && String(c.href).startsWith("notepad.css?v="),
  );
  assert.equal(links.length, 1, "notepad.css must be injected with a ?v= stamp");

  const snap = np.getSnapshot();
  assert.equal(snap.tabs.length, 1, "first run opens exactly one tab");
  assert.equal(np.activeNote().name, "Untitled");
  // "open" fires AFTER peers init — await the event, not just visibility.
  await until(() => opens >= 1, "open event after loadPeers");
  assert.equal(opens, 1, "open event must fire exactly once");
  await sleep(30);
  assert.equal(closes, 0);
});

test("np: tabs — create/close/jump/cycle/click/rename/Tab-char/empty state (task 3)", async () => {
  const panel = globalThis.__npPanel;
  const noteEvents = [];
  const off = np.on("note", (d) => noteEvents.push(d));

  key(panel, "t", { ctrlKey: true });
  key(panel, "t", { ctrlKey: true });
  let snap = np.getSnapshot();
  assert.equal(snap.tabs.length, 3, "Ctrl+T creates tabs");

  const ids = snap.tabs;
  key(panel, "3", { ctrlKey: true });
  assert.equal(np.activeNote().id, ids[2], "Ctrl+3 jumps to tab 3");
  key(panel, "1", { ctrlKey: true });
  assert.equal(np.activeNote().id, ids[0], "Ctrl+1 jumps to tab 1");

  key(panel, "Tab", { ctrlKey: true });
  assert.equal(np.activeNote().id, ids[1], "Ctrl+Tab cycles forward");
  key(panel, "Tab", { ctrlKey: true, shiftKey: true });
  assert.equal(np.activeNote().id, ids[0], "Ctrl+Shift+Tab cycles back");

  const tabsEl = panel.querySelector("#npd-tabs");
  assert.equal(tabsEl.children.length, 3, "strip renders every tab");
  fireNode(tabsEl.children[2], "click", mkEvent("click", { target: tabsEl.children[2] }));
  assert.equal(np.activeNote().id, ids[2], "click switches tabs");
  assert.ok(tabsEl.children[2].className.includes("npd-active"), "active tab is marked");

  // F2 inline rename
  key(panel, "F2");
  const activeTab = panel.querySelector(`.npd-tab[data-id="${ids[2]}"]`);
  const renameInput = activeTab && activeTab.querySelector(".npd-rename");
  assert.ok(renameInput, "F2 must swap the label for an inline input");
  renameInput.value = "Groceries";
  fireNode(renameInput, "keydown", mkEvent("Enter", { target: renameInput }));
  assert.equal(np.allNotes()[ids[2]].name, "Groceries", "rename commits");
  assert.equal(
    panel.querySelector("#npd-tabs").children[2].querySelector(".npd-tab-label").textContent,
    "Groceries",
    "strip shows the new name",
  );

  // Plain Tab in the editor inserts a tab character (Notepad parity)
  const pad = panel.querySelector("#npd-pad");
  pad.selectionStart = pad.selectionEnd = 0;
  key(panel, "Tab");
  assert.ok(pad.value.startsWith("\t"), "plain Tab must insert \\t");

  // Close all three -> empty-state hint
  key(panel, "w", { ctrlKey: true });
  key(panel, "w", { ctrlKey: true });
  key(panel, "w", { ctrlKey: true });
  snap = np.getSnapshot();
  assert.equal(snap.tabs.length, 0, "Ctrl+W closes tabs (note survives)");
  assert.ok(Object.keys(np.allNotes()).length >= 3, "closed tabs keep their notes");
  assert.equal(panel.querySelector("#npd-hint").hidden, false, "empty state shows the hint");
  assert.equal(panel.querySelector("#npd-pad").hidden, true, "editor hides with no tabs");

  assert.ok(noteEvents.length >= 3, "note events fired on switches");
  assert.ok(
    noteEvents.every((d) => d && d.note),
    "real note events carry a note (pseudo ids are separate)",
  );
  off();

  key(panel, "t", { ctrlKey: true });
  assert.equal(np.getSnapshot().tabs.length, 1, "recovered a tab for the next test");
});

test("np: autosave round-trip + flush paths + status bar + saved event (tasks 4-5)", async () => {
  const panel = globalThis.__npPanel;
  const activeId = np.activeNote().id;
  const savedIds = [];
  const offSaved = np.on("saved", (d) => savedIds.push(d.id));

  // debounced write (400ms)
  inputPad(panel, "hello world");
  await sleep(550);
  let session = readSession();
  assert.equal(session.notes[activeId].content, "hello world", "debounced save round-trips");
  assert.equal(session.tabs.length, 1, "session carries the tab list");
  assert.equal(session.active, activeId, "session carries the active tab");
  assert.ok(savedIds.includes(activeId), "saved event fired with the edited id");

  // pagehide flush — immediate, no debounce wait
  inputPad(panel, "second edit");
  fireWindow("pagehide", mkEvent("pagehide"));
  assert.equal(readSession().notes[activeId].content, "second edit", "pagehide flushes now");

  // visibilitychange flush
  inputPad(panel, "third edit");
  documentStub.visibilityState = "hidden";
  fireDocument("visibilitychange", mkEvent("visibilitychange"));
  assert.equal(readSession().notes[activeId].content, "third edit", "visibilitychange flushes");
  documentStub.visibilityState = "visible";

  // status bar is live
  const status = panel.querySelector("#npd-status-text").textContent;
  assert.match(status, /Ln \d+, Col \d+/, "caret position in status");
  assert.match(status, /words/, "word count in status");
  assert.match(status, /saved/, "last-save time in status");
  offSaved();
});

test("np: find — open, count, Enter/Shift+Enter, wrap, Esc layering (task 6)", async () => {
  const panel = globalThis.__npPanel;
  inputPad(panel, "abc ABC abc");

  key(panel, "f", { ctrlKey: true });
  const find = panel.querySelector("#npd-find");
  const findInput = panel.querySelector(".npd-find-input");
  const findCount = panel.querySelector(".npd-find-count");
  assert.equal(find.hidden, false, "Ctrl+F opens the find bar");

  typeInto(findInput, "abc");
  assert.match(findCount.textContent, /3 matches/, "live match count");

  const pad = panel.querySelector("#npd-pad");
  // The earlier Tab-insert test left the caret at 1 — start from 0 like a
  // freshly focused editor.
  pad.selectionStart = pad.selectionEnd = 0;
  key(panel, "Enter", { target: findInput });
  assert.deepEqual([pad.selectionStart, pad.selectionEnd], [0, 3], "first match selected");
  key(panel, "Enter", { target: findInput });
  assert.deepEqual([pad.selectionStart, pad.selectionEnd], [4, 7], "next match");
  key(panel, "Enter", { target: findInput });
  assert.deepEqual([pad.selectionStart, pad.selectionEnd], [8, 11], "last match");
  key(panel, "Enter", { target: findInput });
  assert.deepEqual([pad.selectionStart, pad.selectionEnd], [0, 3], "wraps forward");
  key(panel, "Enter", { target: findInput, shiftKey: true });
  assert.deepEqual([pad.selectionStart, pad.selectionEnd], [8, 11], "Shift+Enter wraps backward");
  assert.match(findCount.textContent, /of 3/, "position within total");

  // Esc closes find first, panel stays
  key(panel, "Escape", { target: findInput });
  assert.equal(find.hidden, true, "Esc closes find");
  assert.equal(panel.hidden, false, "panel survives Esc");
});

test("np: switcher — opens with rows, filter chain intercepts, Esc layers (task 7)", async () => {
  const panel = globalThis.__npPanel;
  key(panel, "p", { ctrlKey: true });
  const sw = panel.querySelector("#npd-switch");
  const swInput = panel.querySelector(".npd-switch-input");
  const swList = panel.querySelector("#npd-switch-list");
  assert.equal(sw.hidden, false, "Ctrl+P opens the switcher");

  // Peers active here: rows = her filter's output (notes + her action rows).
  // Presence, not exact counts.
  const names = rowNames(swList);
  assert.ok(names.length >= 1, "switcher lists rows");
  const noteNames = Object.values(np.allNotes()).map((n) => n.name);
  assert.ok(
    names.some((nm) => noteNames.includes(nm)),
    "at least one row is an actual note",
  );

  // Filter chain: my subscriber runs in registration order and owns the result.
  let seen = null;
  const un = np.addSwitcherFilter((q, rows) => {
    seen = [q, rows];
    return [];
  });
  typeInto(swInput, "");
  assert.deepEqual(seen, ["", seen[1]], "filter receives the query");
  assert.ok(Array.isArray(seen[1]) && seen[1].length >= 1, "filter receives rows");
  assert.equal(swList.children.length, 1, "owning the chain means my [] wins");
  assert.ok(swList.children[0].className.includes("npd-row-hint"), "empty result renders the hint row");
  un();

  typeInto(swInput, "");
  assert.ok(rowNames(swList).length >= 1, "rows return after unsubscribe");

  // Esc closes switcher, panel stays
  key(panel, "Escape", { target: swInput });
  assert.equal(sw.hidden, true, "Esc closes the switcher");
  assert.equal(panel.hidden, false, "panel survives");
});

test("np: keydown relay — a peer claim makes core skip its own chord (task 8)", async () => {
  const panel = globalThis.__npPanel;
  const claim = (e) => {
    if (e.key === "t" && e.ctrlKey) e.preventDefault();
  };
  const un = np.on("keydown", claim);

  const before = np.getSnapshot().tabs.length;
  const ev = key(panel, "t", { ctrlKey: true });
  assert.equal(ev.defaultPrevented, true, "relay claim marked the event");
  assert.equal(np.getSnapshot().tabs.length, before, "core skipped Ctrl+T — no tab created");

  key(panel, "w", { ctrlKey: true });
  assert.equal(np.getSnapshot().tabs.length, before - 1, "unclaimed chords still reach core");

  un();
  key(panel, "t", { ctrlKey: true });
  assert.equal(np.getSnapshot().tabs.length, before, "after unsubscribe core handles Ctrl+T again");
});

test("np: Esc layering — find/switcher first, then the panel; close event (task 8)", async () => {
  const panel = globalThis.__npPanel;
  let closes = 0;
  np.on("close", () => closes++);

  // switcher open -> Esc closes only the switcher
  key(panel, "p", { ctrlKey: true });
  assert.equal(panel.querySelector("#npd-switch").hidden, false);
  key(panel, "Escape");
  assert.equal(panel.querySelector("#npd-switch").hidden, true, "innermost layer closes first");
  assert.equal(panel.hidden, false, "panel still open");

  // panel open -> Esc closes the panel (flushes on the way)
  key(panel, "Escape");
  assert.equal(panel.hidden, true, "Esc closes the panel");
  await sleep(30);
  assert.equal(closes, 1, "close event fired exactly once");
});

// ============================================================== npPure ===
// Same storage, fresh core instance; peer inits early-return (`_done` /
// `inited` guards) => exact, deterministic assertions (task 7).
test("npPure: exact rows, ranking, arrows, create, hard-Delete, pseudo ids", async () => {
  const npPure = await import(`${pathToFileURL(path.join(srcDir, "notepad.js")).href}?govinda=1`);
  const panel = await openInstance(npPure);

  const before = npPure.getSnapshot();
  assert.equal(before.tabs.length, 1, "restored the flushed session (one tab)");

  // Exact default ranking: every note, most recently updated first.
  const expected = Object.entries(npPure.allNotes())
    .map(([id, n]) => ({ id, name: n.name, updated: n.updated || 0 }))
    .sort((a, b) => b.updated - a.updated)
    .map((r) => r.name);
  key(panel, "p", { ctrlKey: true });
  const swList = panel.querySelector("#npd-switch-list");
  assert.deepEqual(rowNames(swList), expected, "default ranking = recency, exact count");

  // Arrows move the selection (wraps at both ends)
  const swInput = panel.querySelector(".npd-switch-input");
  if (expected.length >= 2) {
    key(panel, "ArrowDown", { target: swInput });
    assert.ok(swList.children[1].className.includes("npd-sel"), "ArrowDown selects row 1");
    key(panel, "ArrowUp", { target: swInput });
    assert.ok(swList.children[0].className.includes("npd-sel"), "ArrowUp returns to row 0");
    key(panel, "ArrowUp", { target: swInput });
    assert.ok(
      swList.children[swList.children.length - 1].className.includes("npd-sel"),
      "ArrowUp wraps to the last row",
    );

    // Enter opens the selected note and closes the switcher
    key(panel, "ArrowDown", { target: swInput });
    key(panel, "Enter", { target: swInput });
    assert.equal(panel.querySelector("#npd-switch").hidden, true, "Enter closes the switcher");
    assert.equal(npPure.activeNote().name, expected[1], "Enter opened the selected note");
  }

  // Create when nothing matches (rows empty => hint => Enter creates)
  key(panel, "p", { ctrlKey: true });
  typeInto(swInput, "Fresh idea zzz");
  assert.equal(swList.children.length, 1, "no match renders the hint row only");
  assert.ok(swList.children[0].className.includes("npd-row-hint"));
  const tabCount = npPure.getSnapshot().tabs.length;
  key(panel, "Enter", { target: swInput });
  assert.equal(npPure.getSnapshot().tabs.length, tabCount + 1, "Enter creates the missing note");
  assert.equal(npPure.activeNote().name, "Fresh idea zzz");

  // Hard Delete (no peer claims it on this instance — task 7's core path).
  // Row 0 = freshest note; resolve its id from the same ordering the core
  // uses (allRowEntries: updated desc, identical input order => identical sort).
  key(panel, "p", { ctrlKey: true });
  typeInto(swInput, "");
  const freshest = Object.entries(npPure.allNotes())
    .map(([id, n]) => ({ id, name: n.name, updated: n.updated || 0 }))
    .sort((a, b) => b.updated - a.updated)[0];
  assert.equal(rowNames(swList)[0], freshest.name, "row 0 is the freshest note");
  key(panel, "Delete", { target: swInput });
  assert.ok(
    !npPure.allNotes()[freshest.id],
    `hard Delete removed "${freshest.name}" (id ${freshest.id})`,
  );
  key(panel, "Escape", { target: swInput });

  // Pseudo ids: unknown id fires "note" with note:null (Devi's action rows)
  let pseudo = null;
  const off = npPure.on("note", (d) => {
    pseudo = d;
  });
  const tabsBefore = npPure.getSnapshot().tabs.length;
  npPure.openNoteById("npdo-dup");
  assert.deepEqual(pseudo, { id: "npdo-dup", note: null }, "pseudo open announced with note:null");
  assert.equal(npPure.getSnapshot().tabs.length, tabsBefore, "no tab invented for a pseudo id");
  off();

  // Closing flushes the session for the restore test
  npPure.toggleNotepad();
  await sleep(30);
  assert.equal(panel.hidden, true, "toggle closes the panel");
  readSession();
});

test("npRestore: a fresh instance restores tabs + active from storage (task 4)", async () => {
  const flushed = readSession(); // npPure's close flushed its final state
  const npRestore = await import(`${pathToFileURL(path.join(srcDir, "notepad.js")).href}?restore=1`);
  const panel = await openInstance(npRestore);
  const snap = npRestore.getSnapshot();
  assert.deepEqual(snap.tabs, flushed.tabs, "tab list restored byte-for-byte");
  assert.equal(snap.active, flushed.active, "active tab restored");
  for (const id of flushed.tabs) {
    assert.equal(snap.notes[id].name, flushed.notes[id].name, "note name survives restart");
    assert.equal(snap.notes[id].content, flushed.notes[id].content, "note content survives restart");
  }
  assert.ok(Object.keys(flushed.notes).length >= 1, "flushed session has notes");
  npRestore.toggleNotepad();
  await sleep(20);
  assert.equal(panel.hidden, true);
});

test("npCorrupt: corrupt tm-notepad heals into a fresh session, never throws (task 2)", async () => {
  localStorage.setItem("tm-notepad", "{definitely not json");
  const npCorrupt = await import(`${pathToFileURL(path.join(srcDir, "notepad.js")).href}?corrupt=1`);
  const panel = await openInstance(npCorrupt); // must not throw
  const snap = npCorrupt.getSnapshot();
  assert.equal(snap.tabs.length, 1, "healed session opens one fresh tab");
  assert.equal(npCorrupt.activeNote().name, "Untitled");
  npCorrupt.toggleNotepad();
  await sleep(20);
  // storage rewritten as valid JSON
  const healed = JSON.parse(localStorage.getItem("tm-notepad"));
  assert.ok(healed.notes && healed.tabs, "corrupt storage rewritten with a valid session");
  assert.equal(panel.hidden, true);
});

test("sanitizeState: garbage in, valid state out — never a throw", () => {
  const healed = np.sanitizeState({
    notes: { a: { name: 5, content: null, updated: "x" }, bad: "not-an-object" },
    tabs: ["a", "ghost", "a", "bad"],
    active: "ghost",
  });
  assert.equal(healed.notes.a.name, "Untitled", "wrong-typed name heals");
  assert.equal(healed.notes.a.content, "", "wrong-typed content heals");
  assert.equal(healed.notes.a.updated, 0, "wrong-typed updated heals");
  assert.equal(healed.notes.bad, undefined, "non-object note dropped");
  assert.deepEqual(healed.tabs, ["a"], "stale + duplicate tab ids dropped");
  assert.equal(healed.active, "a", "stale active falls back to first tab");
  assert.deepEqual(np.sanitizeState(null), { notes: {}, tabs: [], active: null });
  assert.deepEqual(np.sanitizeState("junk"), { notes: {}, tabs: [], active: null });
});
