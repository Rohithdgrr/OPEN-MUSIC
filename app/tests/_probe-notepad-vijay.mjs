// _probe-notepad-vijay.mjs — Vijay phase-3 probe (UNTRACKED, delete after run).
// Drives the real notepad-blocks module through a contract-shaped fake core
// and prints a human-readable transcript: slash -> insert -> auto-list ->
// find/replace -> history restore -> preview XSS-safe render.
// Run:  node tests/_probe-notepad-vijay.mjs
import { initNotepadBlocks, resetForTests, enterEdit } from "../src/notepad-blocks.js";

// ---- minimal localStorage + document stubs (headless) ----
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => void mem.clear(),
};

function makeEl(tag) {
  const cls = new Set();
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(), id: "", style: {}, dataset: {}, attributes: {},
    childNodes: [], parentNode: null, parentElement: null, hidden: false, value: "",
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, clientHeight: 400, _html: "",
    listeners: Object.create(null),
    addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { for (const fn of [...(this.listeners[t] || [])]) fn(ev); return ev; },
    appendChild(c) { c.parentNode = el; c.parentElement = el; el.childNodes.push(c); return c; },
    removeChild(c) { const i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { el.attributes[k] = String(v); if (k.startsWith("data-")) el.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v); },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    removeAttribute(k) { delete el.attributes[k]; },
    focus() {}, blur() {}, select() {}, scrollIntoView() {},
    setSelectionRange(s, e) { el.selectionStart = s; el.selectionEnd = e; },
    getBoundingClientRect() { return { top: 100, left: 40, right: 640, bottom: 460, width: 600, height: 360 }; },
    querySelector() { return null; },
    contains(n) { let c = n; while (c) { if (c === el) return true; c = c.parentNode; } return false; },
  };
  Object.defineProperty(el, "className", { get: () => [...cls].join(" "), set: (v) => { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); } });
  Object.defineProperty(el, "classList", { get: () => ({ add: (...n) => n.forEach((x) => cls.add(x)), remove: (...n) => n.forEach((x) => cls.delete(x)), contains: (n) => cls.has(n) }) });
  Object.defineProperty(el, "firstChild", { get: () => el.childNodes[0] || null });
  Object.defineProperty(el, "innerHTML", { get: () => el._html, set: (v) => { el._html = String(v); } });
  Object.defineProperty(el, "textContent", {
    get() { return el.childNodes.length ? el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("") : el._html; },
    set(v) { const s = String(v); el._html = ""; el.childNodes = s === "" ? [] : [{ nodeType: 3, data: s, parentNode: el }]; },
  });
  return el;
}

const doc = {
  head: makeEl("head"), documentElement: makeEl("html"), body: makeEl("body"),
  createElement: (t) => makeEl(t),
  createTextNode: (d) => ({ nodeType: 3, data: String(d), parentNode: null }),
  getElementById: () => null, querySelector: () => null,
};
globalThis.document = doc;

function keyEv(props) {
  return Object.assign({ key: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, props);
}

function makeCore(content) {
  const notes = { n1: { id: "n1", name: "Note", content, updated: 1 } };
  const subs = {}; const calls = [];
  const ta = makeEl("textarea"); ta.value = content;
  const overlay = makeEl("div"); const aside = makeEl("div"); const panel = makeEl("div");
  const core = {
    on(t, fn) { (subs[t] || (subs[t] = [])).push(fn); return () => {}; },
    mount(n) { return n === "overlay" ? overlay : n === "aside" ? aside : null; },
    panel: () => panel, textarea: () => ta,
    activeNote: () => ({ id: "n1", ...notes.n1 }), allNotes: () => ({ ...notes }),
    setNoteContent(id, text) { calls.push(["setNoteContent", id, String(text)]); if (notes[id]) { notes[id].content = String(text); if (id === "n1") ta.value = String(text); } },
    insertAtCursor(text) { const s = ta.selectionStart, e = ta.selectionEnd; ta.value = ta.value.slice(0, s) + String(text) + ta.value.slice(e); ta.selectionStart = ta.selectionEnd = s + String(text).length; if (notes.n1) notes.n1.content = ta.value; ta.dispatch("input", {}); },
    selection: () => ({ start: ta.selectionStart, end: ta.selectionEnd, value: ta.value.slice(ta.selectionStart, ta.selectionEnd) }),
    setSelection(s, e) { ta.selectionStart = s; ta.selectionEnd = e ?? s; },
    openNote() {}, closeNote() {}, newNote() {}, refresh() {}, toast(m) { calls.push(["toast", String(m)]); }, diag() {}, addSwitcherFilter() { return () => {}; },
    _ta: ta, _notes: notes, _calls: calls, _aside: aside, fire: (t, d) => { for (const fn of [...(subs[t] || [])]) fn(d); },
  };
  return core;
}

const log = (...a) => console.log(...a);

// ============================================================== 1. auto-list
log("== 1. auto-list Enter rules ==");
for (const [before, want] of [["- a|", "- a\n- "], ["1. a|", "1. a\n2. "], ["- [x] a|", "- [x] a\n- [ ] "], ["- |", ""]]) {
  const pos = before.indexOf("|");
  const value = before.slice(0, pos) + before.slice(pos + 1);
  const edit = enterEdit(value, pos);
  log(`  ${before.padEnd(8)} -> ${JSON.stringify(edit.next)}  ${edit.next === want ? "OK" : "MISMATCH want " + want}`);
}

// ============================================================== 2. slash row
log("== 2. slash palette inserts Heading 2 ==");
resetForTests();
mem.clear();
const core = makeCore("");
const ta = core._ta;
const api = initNotepadBlocks(core);
ta.value = "/"; ta.selectionStart = ta.selectionEnd = 1; ta.dispatch("input", {});
log(`  palette open: ${api.ui.menu.hidden === false}, rows: ${api.ui.menuRows.length}`);
core.fire("keydown", keyEv({ key: "ArrowDown", target: ta })); // row 2 = Heading 2
core.fire("keydown", keyEv({ key: "Enter", target: ta }));
log(`  after Enter, textarea = ${JSON.stringify(ta.value)}`);

// ======================================================== 3. find & replace
log("== 3. find & replace (Alt+H, literal + regex) ==");
resetForTests(); mem.clear();
const core2 = makeCore("cat dog cat & cat");
const ta2 = core2._ta;
const api2 = initNotepadBlocks(core2);
core2.fire("keydown", keyEv({ key: "H", altKey: true, target: ta2 }));
api2.ui.findInput.value = "cat"; api2.ui.findInput.dispatch("input", {});
log(`  status: ${api2.ui.findStatus.textContent}`);
api2.ui.findInput.dispatch("keydown", keyEv({ key: "Enter", target: api2.ui.findInput })); // step -> selects match 1
api2.ui.replInput.value = "CAT";
api2.ui.replInput.dispatch("keydown", keyEv({ key: "Enter", target: api2.ui.replInput }));
log(`  after replace-current: ${JSON.stringify(core2._notes.n1.content)}`);
const allBtn = [...(function walk(n, out = []) { if (n.nodeType === 1 && String(n.className || "").includes("npdb-btn-all")) out.push(n); for (const c of n.childNodes || []) walk(c, out); return out; })(api2.ui.find)][0];
allBtn.dispatch("click", {});
log(`  after replace-all:     ${JSON.stringify(core2._notes.n1.content)}`);
const setCalls = core2._calls.filter((c) => c[0] === "setNoteContent").length;
log(`  setNoteContent calls:  ${setCalls} (1 from replace-current + 1 for the whole replace-all)`);

// ============================================================ 4. versions
log("== 4. version history snapshots after the 5 s debounce ==");
core2.fire("saved", { id: "n1" });
log(`  fired saved -> timer armed (5 s, unref'd); waiting it out...`);
await new Promise((r) => setTimeout(r, 5200));
const vers = JSON.parse(mem.get("tm-notepad-versions") || "{}");
const n1 = vers.n1 || [];
log(`  snapshots for n1: ${n1.length}`);
log(`  newest content:   ${JSON.stringify(n1[0] && n1[0].content)}`);

// ============================================================= 5. preview
log("== 5. preview renders, and an XSS payload stays inert ==");
resetForTests(); mem.clear();
const XSS = ['# Title <b>bold</b>', "", '<script>alert(1)</script>', "", "<img src=x onerror=alert(1)>", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
const core3 = makeCore(XSS);
const created = [];
const origCreate = doc.createElement;
doc.createElement = (t) => { created.push(String(t).toUpperCase()); return origCreate(t); };
const api3 = initNotepadBlocks(core3);
api3.togglePreview();
doc.createElement = origCreate;
const bad = created.filter((t) => t !== "LINK" && !["H1","H2","H3","H4","H5","H6","P","UL","OL","LI","BLOCKQUOTE","PRE","CODE","HR","TABLE","THEAD","TBODY","TR","TH","TD","DIV","SPAN","STRONG","EM","DEL","DETAILS","SUMMARY","BUTTON"].includes(t)); // LINK = the one stylesheet injection at init, not a paint tag
log(`  tags created: ${[...new Set(created)].join(", ")}`);
log(`  non-allowlisted tags: ${bad.length === 0 ? "none (inert)" : bad.join(",")}`);
const htmlSink = [];
(function walk(n) { if (n._html) htmlSink.push(n._html); for (const c of n.childNodes || []) walk(c); })(api3.ui.preview);
log(`  any write with a live <script>/<img>/<b>: ${htmlSink.some((h) => /<script|<img|<b>/i.test(h)) ? "LEAK" : "no (escaped)"}`);
log(`  table painted as real elements: ${created.includes("TABLE") && created.includes("TBODY") ? "yes" : "no"}`);

log("== probe complete ==");
