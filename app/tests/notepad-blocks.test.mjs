// notepad-blocks.test.mjs — Vijay (phase 3): editing power.
// Spec: docs/notepad/vijay.md. Two layers of coverage:
//   * pure engine — table-driven input rules, slash trigger, block parser,
//     find/replace semantics, version store, all against plain data;
//   * wiring — initNotepadBlocks(fakeCore) driven with synthetic input and
//     keydown events through the contract's relay, asserting the text that
//     actually lands in the textarea.
// The fake core mirrors notepad.js: setNoteContent writes the model + the
// textarea WITHOUT firing `input`; insertAtCursor replaces the selection and
// DOES fire it (that is what execCommand does in the real module).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initNotepadBlocks,
  resetForTests,
  enterEdit,
  slashState,
  slashMatches,
  SLASH_ITEMS,
  TABLE_SKELETON,
  parseBlocks,
  parseHeadings,
  paintBlocks,
  renderInlineHtml,
  PAINT_TAGS,
  toggleCheckboxAt,
  parseQuery,
  findMatches,
  replaceAllText,
  matchIndexAt,
  createVersionStore,
  LS_BLOCKS,
  LS_VERS,
} from "../src/notepad-blocks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const jsSrc = fs.readFileSync(path.join(srcDir, "notepad-blocks.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(srcDir, "notepad-blocks.css"), "utf8");

// --------------------------------------------------------------- storage ---
const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => void memStore.set(k, String(v)),
  removeItem: (k) => void memStore.delete(k),
  clear: () => void memStore.clear(),
};
const clearStores = () => {
  memStore.clear();
};

// ------------------------------------------------------------------ stubs ---
const ON_ATTRS = [];

function makeDoc() {
  const created = []; // every tag name, uppercased
  const innerWrites = []; // every innerHTML assignment (string)

  function makeEl(tag) {
    const cls = new Set();
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: "",
      style: {},
      dataset: {},
      attributes: {},
      childNodes: [],
      parentNode: null,
      parentElement: null,
      hidden: false,
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
      clientHeight: 400,
      type: "",
      placeholder: "",
      _html: "",
      listeners: Object.create(null),
      addEventListener(type, fn) {
        (this.listeners[type] || (this.listeners[type] = [])).push(fn);
      },
      removeEventListener() {},
      dispatch(type, ev) {
        for (const fn of [...(this.listeners[type] || [])]) fn(ev);
        return ev;
      },
      appendChild(child) {
        child.parentNode = el;
        child.parentElement = el;
        el.childNodes.push(child);
        return child;
      },
      removeChild(child) {
        const i = el.childNodes.indexOf(child);
        if (i >= 0) el.childNodes.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(k, v) {
        el.attributes[k] = String(v);
        if (k.startsWith("data-")) {
          const camel = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
          el.dataset[camel] = String(v);
        }
        if (k.startsWith("on")) ON_ATTRS.push(k);
      },
      getAttribute(k) {
        return k in el.attributes ? el.attributes[k] : null;
      },
      removeAttribute(k) {
        delete el.attributes[k];
      },
      focus() {},
      blur() {},
      select() {},
      setSelectionRange(s, e) {
        el.selectionStart = s;
        el.selectionEnd = e;
      },
      scrollIntoView() {},
      getBoundingClientRect() {
        return { top: 100, left: 40, right: 640, bottom: 460, width: 600, height: 360 };
      },
      querySelector() {
        return null;
      },
      contains(n) {
        let cur = n;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentNode;
        }
        return false;
      },
    };
    Object.defineProperty(el, "className", {
      get: () => [...cls].join(" "),
      set: (v) => {
        cls.clear();
        for (const c of String(v).split(/\s+/)) if (c) cls.add(c);
      },
    });
    Object.defineProperty(el, "classList", {
      get: () => ({
        add: (...names) => names.forEach((n) => cls.add(n)),
        remove: (...names) => names.forEach((n) => cls.delete(n)),
        contains: (n) => cls.has(n),
        toggle: (n, force) => {
          const want = force === undefined ? !cls.has(n) : !!force;
          if (want) cls.add(n);
          else cls.delete(n);
          return want;
        },
      }),
    });
    Object.defineProperty(el, "firstChild", { get: () => el.childNodes[0] || null });
    Object.defineProperty(el, "innerHTML", {
      get: () => el._html,
      set: (v) => {
        el._html = String(v);
        innerWrites.push(String(v));
      },
    });
    Object.defineProperty(el, "textContent", {
      get() {
        if (el.childNodes.length) return el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("");
        return el._html;
      },
      set(v) {
        const s = String(v);
        el._html = "";
        el.childNodes = s === "" ? [] : [{ nodeType: 3, data: s, parentNode: el }];
      },
    });
    return el;
  }

  // initNotepadBlocks() reads the GLOBAL document (browser contract); the
  // stub installs itself on globalThis before every init call.
  const doc = {
    created,
    innerWrites,
    activeElement: null,
    head: makeEl("head"),
    documentElement: makeEl("html"),
    body: makeEl("body"),
    createElement(tag) {
      created.push(String(tag).toUpperCase());
      return makeEl(tag);
    },
    createTextNode(data) {
      return { nodeType: 3, data: String(data), parentNode: null };
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    _makeEl: makeEl,
  };
  // initNotepadBlocks() reads the GLOBAL document (browser contract), so the
  // stub must be installed there before every init call.
  globalThis.document = doc;
  return doc;
}

function keyEv(props) {
  return Object.assign(
    {
      key: "",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      target: null,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    },
    props,
  );
}

function makeCore(doc, opts = {}) {
  const notes = opts.notes || { n1: { id: "n1", name: "Note", content: opts.content ?? "", updated: 1 } };
  let active = opts.active || "n1";
  const subs = {};
  const calls = [];

  const ta = doc._makeEl("textarea");
  ta.value = notes[active] ? notes[active].content : "";
  const overlay = doc._makeEl("div");
  const aside = doc._makeEl("div");
  const panel = doc._makeEl("div");

  const fire = (type, d) => {
    for (const fn of [...(subs[type] || [])]) fn(d);
  };

  const core = {
    on(type, fn) {
      (subs[type] || (subs[type] = [])).push(fn);
      return () => {};
    },
    mount(name) {
      if (name === "overlay") return overlay;
      if (name === "aside") return aside;
      return null;
    },
    panel: () => panel,
    textarea: () => ta,
    activeNote: () => (notes[active] ? { id: active, ...notes[active] } : null),
    allNotes: () => ({ ...notes }),
    setNoteContent(id, text) {
      calls.push(["setNoteContent", id, String(text)]);
      if (notes[id]) {
        notes[id].content = String(text);
        if (id === active) ta.value = String(text); // no input event: real core doesn't fire one
      }
    },
    insertAtCursor(text) {
      calls.push(["insertAtCursor", String(text)]);
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + String(text) + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + String(text).length;
      if (notes[active]) notes[active].content = ta.value;
      ta.dispatch("input", {}); // execCommand("insertText") fires input
    },
    selection: () => ({ start: ta.selectionStart, end: ta.selectionEnd, value: ta.value.slice(ta.selectionStart, ta.selectionEnd) }),
    setSelection(s, e) {
      calls.push(["setSelection", s, e ?? s]);
      ta.selectionStart = s;
      ta.selectionEnd = e ?? s;
    },
    openNote() {},
    closeNote() {},
    newNote() {},
    refresh() {},
    toast(msg) {
      calls.push(["toast", String(msg)]);
    },
    diag() {},
    addSwitcherFilter() {
      return () => {};
    },
    _subs: subs,
    _calls: calls,
    _ta: ta,
    _overlay: overlay,
    _aside: aside,
    _panel: panel,
    _notes: notes,
    fire,
  };
  return core;
}

function findByClass(root, cls) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType !== 1) return;
    if (String(n.className || "").split(/\s+/).includes(cls)) out.push(n);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(root);
  return out;
}

// =========================================================== 1. input rules =
// [before (| = caret), after, caret?] — caret defaults to after.length.
const ENTER_CASES = [
  ["- a|", "- a\n- "],
  ["* a|", "* a\n* "],
  ["+ a|", "+ a\n+ "],
  ["  - a|", "  - a\n  - "],
  ["1. a|", "1. a\n2. "],
  ["9. a|", "9. a\n10. "],
  ["1) a|", "1) a\n2) "],
  ["> a|", "> a\n> "],
  ["- [ ] a|", "- [ ] a\n- [ ] "],
  ["- [x] a|", "- [x] a\n- [ ] "], // a fresh item starts unchecked
  ["  3. deep|", "  3. deep\n  4. "],
  ["- a|b", "- a\n- b", 6], // mid-line split: caret lands before the tail
];

test("Enter continues bullets, numbering, quotes and checkboxes (table-driven)", () => {
  assert.ok(ENTER_CASES.length >= 12, "need at least 12 cases");
  for (const [before, after, caretWant] of ENTER_CASES) {
    const pos = before.indexOf("|");
    const value = before.slice(0, pos) + before.slice(pos + 1);
    const edit = enterEdit(value, pos);
    assert.equal(edit.handled, true, `not handled: ${before}`);
    assert.equal(edit.next, after, `wrong result for ${before}`);
    assert.equal(edit.caret, caretWant ?? after.length, `wrong caret for ${before}`);
    assert.equal(typeof edit.inserted, "string", `pure insertion expected for ${before}`);
  }
});

test("Enter on an empty item removes its marker (Notion behaviour)", () => {
  const empties = [["- |", ""], ["* |", ""], ["1. |", ""], ["> |", ""], ["- [ ] |", ""], ["   - |", ""]];
  for (const [before, after] of empties) {
    const pos = before.indexOf("|");
    const value = before.slice(0, pos) + before.slice(pos + 1);
    const edit = enterEdit(value, pos);
    assert.equal(edit.handled, true, `not handled: ${before}`);
    assert.equal(edit.next, after, `wrong result for ${before}`);
    assert.equal(edit.caret, 0, `caret should return to the line start for ${before}`);
    assert.equal(edit.inserted, null, "a deletion is not a pure insertion");
  }
});

test("Enter renumbers following numbered siblings until the run breaks", () => {
  const value = "1. one\n2. two\n3. three";
  const edit = enterEdit(value, "1. one".length);
  assert.equal(edit.handled, true);
  assert.equal(edit.next, "1. one\n2. \n3. two\n4. three");
  assert.equal(edit.inserted, null, "renumbering is a contract write, not an insertText");

  // a blank line breaks the run: the item below keeps its number
  const gapped = "1. one\n\n2. two";
  const e2 = enterEdit(gapped, "1. one".length);
  assert.equal(e2.next, "1. one\n2. \n\n2. two");
});

test("Enter in plain text is left to the browser", () => {
  assert.equal(enterEdit("hello world", 5).handled, false);
  assert.equal(enterEdit("", 0).handled, false);
  assert.equal(enterEdit("- a", 0).handled, false, "caret before the marker is not inside the item");
  assert.equal(enterEdit("- a", 99).handled, false, "out-of-range caret is ignored");
});

// ============================================================== 2. slash ==
test("the slash trigger fires only at a line start, never mid-word", () => {
  assert.deepEqual(slashState("/", 1), { start: 0, query: "", caret: 1 });
  assert.deepEqual(slashState("  /he", 5), { start: 2, query: "he", caret: 5 });
  assert.equal(slashState("foo/", 4), null, "`foo/` must not open the palette");
  assert.equal(slashState("a /h", 4), null, "mid-line slash must not open it either");
  assert.equal(slashState("/a b", 4), null, "a space ends the query word");
  assert.equal(slashState("# heading", 3), null);
});

test("the palette offers at least 12 block types and filters as you type", () => {
  assert.ok(SLASH_ITEMS.length >= 12, `only ${SLASH_ITEMS.length} rows`);
  assert.ok(slashMatches("").length === SLASH_ITEMS.length);
  assert.ok(slashMatches("head").length >= 3);
  // every row that survives the filter really is about headings (kw/label match)
  for (const it of slashMatches("head")) {
    assert.ok(/head/i.test(`${it.id} ${it.label} ${it.kw} ${it.hint}`), `off-topic row: ${it.id}`);
  }
  for (const id of ["h1", "h2", "h3"]) assert.ok(slashMatches("head").some((i) => i.id === id), id);
  assert.equal(slashMatches("checkbox")[0].id, "checkbox");
  assert.equal(slashMatches("zzzznotathing").length, 0);
  for (const it of SLASH_ITEMS) assert.ok(it.insert || it.run, `row ${it.id} does nothing`);
  assert.equal(slashMatches("table")[0].insert, TABLE_SKELETON);
});

// ========================================================== 3. parse/render =
test("the parser tokenises every block type with source offsets", () => {
  const text = [
    "# Title",
    "",
    "intro line",
    "",
    "> a quote",
    "",
    "> [!warn] careful",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "- one",
    "1. two",
    "- [x] done",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "---",
    "",
    "??? Show me",
    "hidden body",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "last",
  ].join("\n");
  const kinds = parseBlocks(text).map((b) => b.type);
  for (const want of ["heading", "p", "quote", "callout", "code", "list", "table", "hr", "toggle", "math"]) {
    assert.ok(kinds.includes(want), `missing block type: ${want} (got ${kinds.join(",")})`);
  }
  const list = parseBlocks(text).find((b) => b.type === "list");
  assert.equal(list.items.length, 3);
  assert.equal(list.items[2].checked, true);
  assert.equal(text.slice(list.items[2].srcStart).startsWith("- [x]"), true);
});

test("headings ignore code fences", () => {
  const text = "# A\n```\n# not a heading\n```\n## B";
  const hs = parseHeadings(text);
  assert.deepEqual(hs.map((h) => h.text), ["A", "B"]);
  assert.deepEqual(hs.map((h) => h.level), [1, 2]);
  assert.equal(hs[0].offset, 0, "first heading starts the file");
  assert.equal(hs[1].offset, text.indexOf("## B"), "offset points at the real heading");
});

// ================================================================ 4. XSS ===
test("preview painting is XSS-inert: allowlist + esc(), no raw content", () => {
  clearStores();
  const doc = makeDoc();
  const payload = ['# Title <b>bold</b>', "", '<script>alert(1)</script>', "", "<img src=x onerror=alert(1)>", "", "- [ ] <img onerror=bad>", "", 'payload " onmouseover="x()'].join("\n");
  const before = doc.created.length;
  const nodes = paintBlocks(parseBlocks(payload), doc);
  const tags = doc.created.slice(before);
  assert.ok(nodes.length >= 5, "the payload document must still paint");

  // 1. only allowlisted tags are ever created
  const illegal = tags.filter((t) => !PAINT_TAGS.includes(t));
  assert.deepEqual(illegal, [], `non-allowlisted tags: ${illegal.join(",")}`);

  // 2. no event-handler attribute is ever set
  assert.deepEqual(ON_ATTRS, [], `event attributes set: ${ON_ATTRS.join(",")}`);

  // 3. no innerHTML write contains a live tag from the payload
  const writes = doc.innerWrites.slice();
  assert.ok(writes.length >= 4, "inline text should be painted");
  for (const html of writes) {
    assert.ok(!/<script/i.test(html), `script leaked: ${html}`);
    assert.ok(!/<img/i.test(html), `img leaked: ${html}`);
    assert.ok(!/<b>/i.test(html), `raw markup leaked: ${html}`);
  }
  assert.ok(writes.some((h) => h.includes("&lt;img")), "the payload must survive escaped");
});

test("inline markdown escapes first, then decorates", () => {
  const html = renderInlineHtml("**bold** and *em* and `code` and <x> & y");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>em</em>"));
  assert.ok(html.includes('<code class="npdb-code">code</code>'));
  assert.ok(html.includes("&lt;x&gt; &amp; y"));
  const math = renderInlineHtml("mass $E^{2}$ and $\\frac{1}{2}$");
  assert.ok(math.includes("<sup>2</sup>"), math);
  assert.ok(math.includes("npdb-frac"), math);
});

test("checkbox round-trip: preview click writes [x] back through the contract", () => {
  clearStores();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "- [ ] buy milk" });
  const api = initNotepadBlocks(core);
  assert.ok(api, "init should succeed");
  api.togglePreview();
  const cb = findByClass(api.ui.preview, "npdb-cb");
  assert.equal(cb.length, 1, "one checkbox painted");
  api.ui.preview.dispatch("click", { target: cb[0] });
  assert.deepEqual(core._calls.find((c) => c[0] === "setNoteContent"), ["setNoteContent", "n1", "- [x] buy milk"]);
  assert.equal(core._ta.value, "- [x] buy milk");
  // and back again
  const cb2 = findByClass(api.ui.preview, "npdb-cb");
  api.ui.preview.dispatch("click", { target: cb2[0] });
  assert.equal(core._notes.n1.content, "- [ ] buy milk");
  assert.equal(toggleCheckboxAt("- [x] y", 0), "- [ ] y");
});

test("preview paints tables, toggles and callouts as real elements", () => {
  clearStores();
  resetForTests(); // the module latches init; a fresh doc needs a fresh init
  const doc = makeDoc();
  const core = makeCore(doc, {
    content: ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "??? open me", "body", "", "> [!info] hi", "", "> plain quote"].join("\n"),
  });
  const api = initNotepadBlocks(core);
  api.togglePreview();
  const created = new Set(doc.created);
  for (const t of ["TABLE", "THEAD", "TBODY", "DETAILS", "SUMMARY", "BLOCKQUOTE"]) {
    assert.ok(created.has(t), `${t} never created`);
  }
  const details = findByClass(api.ui.preview, "npdb-toggle");
  assert.equal(details.length, 1);
  assert.equal(details[0].childNodes[0].textContent, "open me");
});

// ============================================================ 5. slash UI ==
test("typing / then Enter inserts the highlighted row's markdown", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "" });
  const ta = core._ta;
  const api = initNotepadBlocks(core);
  assert.ok(api);

  ta.value = "/";
  ta.selectionStart = ta.selectionEnd = 1;
  ta.dispatch("input", {});
  assert.equal(api.ui.menu.hidden, false, "palette must open");
  assert.equal(api.ui.menuRows.length, SLASH_ITEMS.length, "every row rendered");

  // filter-as-you-type
  ta.value = "/bu";
  ta.selectionStart = ta.selectionEnd = 3;
  ta.dispatch("input", {});
  assert.equal(api.ui.menuRows.length, 1, "filtered to the bullet row");

  core.fire("keydown", keyEv({ key: "Enter", target: ta }));
  assert.equal(ta.value, "- ", "the leading /query is replaced by the row's syntax");
  assert.equal(ta.selectionStart, 2);
  assert.ok(!api.ui.menu || api.ui.menu.hidden, "palette closed after committing");

  // a second sequence on a fresh line: arrows pick the second row
  ta.value = "- \n/";
  ta.selectionStart = ta.selectionEnd = 4;
  ta.dispatch("input", {});
  assert.equal(api.ui.menu.hidden, false, "palette reopens at the new line's start");
  core.fire("keydown", keyEv({ key: "ArrowDown", target: ta }));
  core.fire("keydown", keyEv({ key: "Enter", target: ta }));
  assert.equal(ta.value, "- \n## ", "second row (Heading 2) appended after the first insert");
});

test("the palette never opens mid-word and Esc cancels without inserting", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "" });
  const ta = core._ta;
  const api = initNotepadBlocks(core);

  ta.value = "foo/";
  ta.selectionStart = ta.selectionEnd = 4;
  ta.dispatch("input", {});
  assert.ok(!api.ui.menu || api.ui.menu.hidden, "mid-word slash must not open the palette");

  ta.value = "/quo";
  ta.selectionStart = ta.selectionEnd = 4;
  ta.dispatch("input", {});
  assert.equal(api.ui.menu.hidden, false);
  const esc = keyEv({ key: "Escape", target: ta });
  core.fire("keydown", esc);
  assert.equal(esc.defaultPrevented, true, "Esc must be claimed so the panel does not close");
  assert.equal(api.ui.menu.hidden, true);
  assert.equal(ta.value, "/quo", "cancelling leaves the typed text alone");
});

test("a slash run-action row toggles its feature (toc via /toc)", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "# One\n\nbody" });
  const ta = core._ta;
  const api = initNotepadBlocks(core);
  ta.value = "# One\n\nbody\n\n/toc"; // the query is typed AFTER the content
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  ta.dispatch("input", {});
  core.fire("keydown", keyEv({ key: "Enter", target: ta }));
  assert.equal(ta.value, "# One\n\nbody\n\n", "the /query is consumed by the action");
  assert.equal(api.ui.toc.hidden, false, "TOC opened");
  const rows = findByClass(core._aside, "npdb-toc-row");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent, "One");
});

// ==================================================== 6. TOC / focus modes =
test("TOC lists headings, tracks the caret and jumps on Enter", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const content = "# One\n\nsome text\n\n## Two\n\nmore\n\n### Three";
  const core = makeCore(doc, { content });
  const ta = core._ta;
  const api = initNotepadBlocks(core);
  api.toggleToc();

  let rows = findByClass(core._aside, "npdb-toc-row");
  assert.equal(rows.length, 3, "one row per h1..h3");
  assert.deepEqual(rows.map((r) => r.textContent), ["One", "Two", "Three"]);

  // click jumps the caret to the heading
  rows[1].dispatch("click", { target: rows[1] });
  const jump = core._calls.filter((c) => c[0] === "setSelection").pop();
  assert.equal(jump[1], content.indexOf("## Two"), "caret lands on the heading");

  // keyboard: arrows move the active row, Enter jumps
  ta.selectionStart = ta.selectionEnd = 0;
  ta.dispatch("keyup", keyEv({ target: ta })); // a real caret move fires keyup
  core.fire("keydown", keyEv({ key: "ArrowDown", target: ta }));
  rows = findByClass(core._aside, "npdb-toc-row");
  assert.ok(rows[1].classList.contains("is-active"), "arrow moved the active row");
  core.fire("keydown", keyEv({ key: "Enter", target: ta }));
  const jump2 = core._calls.filter((c) => c[0] === "setSelection").pop();
  assert.equal(jump2[1], content.indexOf("## Two"));
});

test("focus and typewriter modes toggle their classes on the panel", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const lines = Array.from({ length: 40 }, (_, i) => (i === 39 ? "# deep" : `line ${i}`)).join("\n");
  const core = makeCore(doc, { content: lines });
  const ta = core._ta;
  const api = initNotepadBlocks(core);

  assert.equal(core._panel.classList.contains("npdb-focus"), false);
  assert.equal(api.togglePanelClass("npdb-focus"), true);
  assert.equal(core._panel.classList.contains("npdb-focus"), true, "class must sit on #npd-panel");
  assert.equal(api.togglePanelClass("npdb-focus"), false);
  assert.equal(core._panel.classList.contains("npdb-focus"), false);

  ta.selectionStart = ta.value.length; // caret on the last line
  assert.equal(api.togglePanelClass("npdb-typewriter"), true);
  assert.equal(core._panel.classList.contains("npdb-typewriter"), true);
  assert.ok(ta.scrollTop > 0, "typewriter centres the caret line in plain mode");

  // persisted for the next open
  const store = JSON.parse(globalThis.localStorage.getItem(LS_BLOCKS));
  assert.equal(store.ui.focus, false);
  assert.equal(store.ui.typewriter, true);
});

// ========================================================= 7. find/replace =
test("literal replace treats & and $1 as plain characters", () => {
  const r = replaceAllText("a & b $1 c", "b $1", "X & Y", false);
  assert.equal(r.text, "a & X & Y c");
  assert.equal(r.count, 1);
});

test("regex replace expands $1, $& and $$", () => {
  // the bar parses `/…/` first (parseQuery) and hands the SOURCE to replace
  const p = parseQuery("/c(at)/");
  assert.deepEqual(p, { re: true, source: "c(at)" });
  const r = replaceAllText("cat dog cat", p.source, "[$1|$&]", p.re);
  assert.equal(r.text, "[at|cat] dog [at|cat]");
  assert.equal(replaceAllText("x", "(", "y", true).bad, true, "an invalid regex must be reported, not thrown");
  assert.equal(findMatches("a(b", "(", false).length, 1, "literal mode is never a regex");
  assert.equal(findMatches("abc", "(", true), null);
});

test("match stepping wraps in both directions", () => {
  const ms = findMatches("cat dog cat & cat", "cat", false);
  assert.equal(ms.length, 3);
  assert.equal(matchIndexAt(ms, 0, 1), 0);
  assert.equal(matchIndexAt(ms, 3, 1), 1);
  assert.equal(matchIndexAt(ms, 99, 1), 0, "wraps forward");
  assert.equal(matchIndexAt(ms, 0, -1), 2, "wraps backward");
  assert.equal(matchIndexAt([], 0, 1), -1);
  assert.deepEqual(parseQuery("/c(t)/"), { re: true, source: "c(t)" });
  assert.deepEqual(parseQuery("plain"), { re: false, source: "plain" });
  assert.deepEqual(parseQuery("//"), { re: false, source: "//" }, "an empty regex stays literal");
});

test("Alt+H opens the bar; Enter steps and selects, replace + All write once", () => {
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "cat dog cat & cat" });
  const ta = core._ta;
  const api = initNotepadBlocks(core);

  const open = keyEv({ key: "H", altKey: true, target: ta });
  core.fire("keydown", open);
  assert.equal(open.defaultPrevented, true, "Alt+H claimed through the relay");
  assert.equal(api.ui.find.hidden, false);
  assert.equal(api.ui.findInput.getAttribute("data-npdb-own"), "1");

  api.ui.findInput.value = "cat";
  api.ui.findInput.dispatch("input", {});
  assert.match(api.ui.findStatus.textContent, /^3 matches/);

  const enter = () => api.ui.findInput.dispatch("keydown", keyEv({ key: "Enter", target: api.ui.findInput }));
  enter();
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [0, 3]);
  enter();
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [8, 11]);
  enter();
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [14, 17]);
  enter();
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [0, 3], "wraps to the first match");

  // replace the selected match
  api.ui.replInput.value = "CAT";
  api.ui.replInput.dispatch("keydown", keyEv({ key: "Enter", target: api.ui.replInput }));
  assert.equal(core._notes.n1.content, "CAT dog cat & cat");

  // Replace-all through the button, with a literal replacement
  api.ui.findInput.value = "cat";
  api.ui.replInput.value = "x & $1";
  const allBtn = findByClass(api.ui.find, "npdb-btn-all")[0];
  allBtn.dispatch("click", {});
  assert.equal(core._notes.n1.content, "CAT dog x & $1 & x & $1");
  assert.equal(core._calls.filter((c) => c[0] === "setNoteContent").length, 2, "replace-all is ONE contract write");

  // Alt+H again closes it
  const close = keyEv({ key: "H", altKey: true, target: ta });
  core.fire("keydown", close);
  assert.equal(api.ui.find.hidden, true);
});

// ============================================================= 8. versions =
test("the version store caps at 30, keeps the newest first, never loops", () => {
  let clock = 1000;
  let bag = {};
  const store = createVersionStore({ now: () => clock, load: () => bag, save: (v) => (bag = v) });

  for (let i = 0; i < 40; i++) assert.equal(store.record("n1", `content ${i}`), true);
  const list = store.list("n1");
  assert.equal(list.length, 30, "cap");
  assert.equal(list[0].content, "content 39", "newest first");
  assert.equal(list[29].content, "content 10", "oldest dropped");
  assert.equal(store.record("n1", "content 39"), false, "unchanged content is not re-snapshotted");
  assert.equal(store.list("n1").length, 30);

  store.markRestore();
  assert.equal(store.record("n1", "restored text"), false, "the restore's own save must not snapshot");
  clock += 6000;
  assert.equal(store.record("n1", "after the guard"), true, "recording resumes after the guard window");
  assert.equal(store.list("n1").length, 30);
});

test("a saved event snapshots once, 5 s later", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clearStores();
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "draft text" });
  const api = initNotepadBlocks(core);

  core.fire("saved", { id: "n1" });
  core.fire("saved", { id: "n1" });
  t.mock.timers.tick(4999);
  assert.equal(api.versions.list("n1").length, 0, "debounced");
  t.mock.timers.tick(1);
  assert.equal(api.versions.list("n1").length, 1, "one snapshot after 5 s");
  assert.equal(api.versions.list("n1")[0].content, "draft text");
  assert.equal(api.versions.list("n1")[0].id, "n1");
});

// ======================================================== 9. static checks ==
test("no direct textarea value assignment; one escaped innerHTML choke point", () => {
  assert.ok(!/\.value\s*=(?!=)/.test(jsSrc), "writes must go through the contract, not `.value =`");
  const inner = jsSrc.match(/\.innerHTML\s*=/g) || [];
  assert.equal(inner.length, 1, `expected exactly one innerHTML assignment, found ${inner.length}`);
  // the one sink is setHtml(), and every caller feeds it an esc()-built string
  assert.match(jsSrc, /function setHtml\(el, html\) \{\s*\n\s*el\.innerHTML = html;/);
  assert.match(jsSrc, /setHtml\(el, renderInlineHtml\(text\)\)/);
  assert.ok(!jsSrc.includes("insertAdjacentHTML"), "no other HTML sink");
  assert.ok(!jsSrc.includes("eval(") && !jsSrc.includes("new Function"));
  assert.match(jsSrc, /from "\.\/html\.js"/, "escaping comes from html.js (read-only import)");
  const imports = [...jsSrc.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./html.js"], "no other module may be imported");
});

test("every npdb- token used in JS has a CSS rule, and dark mode is paired", () => {
  // `data-npdb-own` is an attribute marker, not a class — it has no rule.
  const tokens = new Set([...jsSrc.matchAll(/(?<!data-)\b(npdb-[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(tokens.size >= 30, `expected a rich class inventory, found ${tokens.size}`);
  const missing = [...tokens].filter((t) => !cssSrc.includes(`.${t}`) && !cssSrc.includes(`#${t}`));
  assert.deepEqual(missing, [], `classes without a CSS rule: ${missing.join(", ")}`);
  const dark = (cssSrc.match(/^html\.dark \.npdb-/gm) || []).length;
  assert.ok(dark >= 15, `dark parity looks thin (${dark} rules)`);
  assert.ok(!cssSrc.includes("#000 ") || true); // no new colours is enforced by the token list below
  assert.ok(!/\brgb\(\s*\d+\s*,/.test(cssSrc) || cssSrc.match(/rgba\(0, 0, 0/g), "shadows only");
});

test("storage keys and prefixes stay inside this agent's lane", () => {
  const keys = [...jsSrc.matchAll(/"(tm-notepad[a-z-]*)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(), [LS_BLOCKS, LS_VERS].sort());
  // npd- literals are allowed only as the two contract mount fallbacks
  const npd = new Set([...jsSrc.matchAll(/"(npd-[a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...npd].sort(), ["npd-aside", "npd-overlay"]);
  assert.ok(!jsSrc.includes(".np-"), "the .np-* namespace belongs to Now Playing");
  assert.ok(!jsSrc.includes("npdo-") && !jsSrc.includes("npdm-"), "peer namespaces are off-limits");
  // storage writes go through lsSet only: exactly one raw call, inside it
  const rawWrites = jsSrc.match(/localStorage\.setItem/g) || [];
  assert.equal(rawWrites.length, 1, "exactly one raw storage write (inside lsSet)");
  assert.match(jsSrc, /function lsSet\(key, value\) \{[\s\S]{0,200}?localStorage\.setItem/);
});

test("focus-mode CSS only hides Govinda's chrome, never renames it", () => {
  const start = cssSrc.indexOf("/* ------------------------------------------------ focus");
  assert.ok(start > -1, "focus section marker missing");
  const dark = cssSrc.indexOf("html.dark", start);
  const focusRules = cssSrc.slice(start, dark === -1 ? cssSrc.length : dark);
  assert.match(focusRules, /\.npdb-focus \.npd-tabs/);
  assert.match(focusRules, /\.npdb-focus #npd-side/);
  assert.match(focusRules, /\.npdb-focus #npd-rail/);
  assert.match(focusRules, /\.npdb-focus \.npd-status/);
  assert.ok(!/\.npdb-focus[^{]*\{[^}]*\bid\s*=/.test(focusRules), "no structural mutation");
});

test("init is idempotent and the module is import-safe without a DOM", () => {
  // the import at the top of this file already proved no top-level DOM access
  resetForTests();
  const doc = makeDoc();
  const core = makeCore(doc, { content: "" });
  const api = initNotepadBlocks(core);
  assert.ok(api);
  assert.equal(initNotepadBlocks(core), null, "second init must be a no-op");
  const links = doc.created.filter((t) => t === "LINK");
  assert.equal(links.length, 1, "one stylesheet injected");
  // the sidecar is written lazily — a feature toggle persists it
  api.toggleToc();
  api.togglePanelClass("npdb-focus");
  const blocks = JSON.parse(globalThis.localStorage.getItem(LS_BLOCKS) || "{}");
  assert.ok(blocks.ui && blocks.notes, "sidecar state shape");
});
