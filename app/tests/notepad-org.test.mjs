// notepad-org.test.mjs — Devi's organization layer (docs/notepad/devi.md).
// Every behaviour is exercised through the exported pure functions and a fake
// `core` object, so this runs with plain node (no DOM, no Govinda core).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STORE_KEY,
  SORT_MODES,
  defaultSidecar,
  loadSidecar,
  pruneSidecar,
  parseTags,
  parseQuery,
  filterNotes,
  cycleSortMode,
  actionRows,
  templateRow,
  applyTemplate,
  applyDuplicate,
  duplicateName,
  softDeleteNote,
  restoreNote,
  touchRecent,
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  fileNote,
  nextStep,
  applyPrefs,
  FONT_SIZES,
  LINE_HEIGHTS,
  exportMarkdown,
  exportText,
  exportHtml,
  renderMdToHtml,
  basenameNoExt,
  importFileText,
} from "../src/notepad-org.js";

// ------------------------------------------------------------------ fake core -
function fakeCore(noteMap = {}) {
  const notes = { ...noteMap };
  const handlers = {};
  const filters = [];
  const toasts = [];
  let nextId = 100;
  return {
    notes,
    toasts,
    filters,
    on(type, fn) {
      (handlers[type] ||= []).push(fn);
    },
    fire(type, d) {
      for (const fn of handlers[type] || []) fn(d);
    },
    addSwitcherFilter(fn) {
      filters.push(fn);
    },
    allNotes() {
      return notes;
    },
    activeNote() {
      return null;
    },
    newNote(name, content) {
      const id = "n" + nextId++;
      notes[id] = { name, content, updated: Date.now() };
      return id;
    },
    closeNote() {},
    openNote() {},
    refresh() {},
    toast(msg) {
      toasts.push(msg);
    },
  };
}

// Fixture: 5 notes, tags, trash, notebooks, favs, pins. Ids ordered so
// "created" (id ascending) == creation order.
function fixture() {
  const notes = {
    n1: { name: "Chill mix", content: "lofi beats\n#calm for focus", updated: 300 },
    n2: { name: "Album review", content: "rating ★★★★☆ great replay\n#music", updated: 500 },
    n3: { name: "Gym plan", content: "leg day\n#health", updated: 100 },
    n4: { name: "Lyric draft", content: "verse one about the rain\n#music #draft", updated: 400 },
    n5: { name: "Old note", content: "obsolete\n#archive", updated: 200 },
  };
  const store = defaultSidecar();
  store.tags = { n1: ["calm"], n2: ["music"], n3: ["health"], n4: ["music", "draft"], n5: ["archive"] };
  store.fav = { n2: 1 };
  store.pinned = { n3: 1 };
  store.trashed = { n5: 999 };
  store.notebooks = [{ id: "nb1", name: "Reviews" }];
  store.noteBook = { n2: "nb1" };
  store.recent = ["n4", "n1"];
  store.prefs = { fontSize: 18, lineHeight: 1.8 };
  const rows = Object.entries(notes).map(([id, n]) => ({ id, name: n.name, updated: n.updated }));
  return { notes, store, rows };
}

// ============================================================ task 1: store =
test("sidecar round-trips through JSON and heals corrupt input", () => {
  const sc = defaultSidecar();
  sc.tags.n1 = ["a"];
  sc.prefs.fontSize = 20;
  const raw = JSON.stringify(sc);
  const back = loadSidecar(raw);
  assert.deepEqual(back.tags.n1, ["a"]);
  assert.equal(back.prefs.fontSize, 20);
  // corrupt / hostile input never throws and falls back to defaults
  assert.deepEqual(loadSidecar("{not json"), defaultSidecar());
  assert.deepEqual(loadSidecar("42"), defaultSidecar());
  assert.deepEqual(loadSidecar(null), defaultSidecar());
  // wrong-typed fields are dropped, valid ones kept
  const mixed = loadSidecar(JSON.stringify({ tags: { ok: ["x"], bad: "nope" }, prefs: { fontSize: 99, lineHeight: 1.6 } }));
  assert.deepEqual(mixed.tags, { ok: ["x"] });
  assert.equal(mixed.prefs.fontSize, 16); // 99 not in 14/16/18/20 -> default
  assert.equal(mixed.prefs.lineHeight, 1.6);
});

test("prune drops ids that no longer exist in allNotes()", () => {
  const sc = defaultSidecar();
  sc.tags = { alive: ["x"], dead: ["y"] };
  sc.fav = { dead: 1 };
  sc.pinned = { dead: 1 };
  sc.trashed = { dead: 1 };
  sc.noteBook = { dead: "nb1" };
  sc.recent = ["dead", "alive", "dead"];
  pruneSidecar(sc, ["alive"]);
  assert.deepEqual(sc.tags, { alive: ["x"] });
  assert.equal(sc.fav.dead, undefined);
  assert.equal(sc.pinned.dead, undefined);
  assert.equal(sc.trashed.dead, undefined);
  assert.equal(sc.noteBook.dead, undefined);
  assert.deepEqual(sc.recent, ["alive"]); // de-duped + re-capped to existing
  // notebooks survive a prune (independent of any note)
  sc.notebooks = [{ id: "nb1", name: "Reviews" }];
  pruneSidecar(sc, []);
  assert.equal(sc.notebooks.length, 1);
});

test("storage key is tm-notepad-org and nothing else", () => {
  assert.equal(STORE_KEY, "tm-notepad-org");
});

// ================================================= task 2+3: filter + trash =
test("filter: content search matches body, ranked, with a hint line", () => {
  const { notes, store, rows } = fixture();
  // "rain" appears only in n4's body -> matched, hint = that line
  const out = filterNotes({ query: "rain", rows, notes, store });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "n4");
  assert.match(out[0].hint, /verse one about the rain/);
  // name match outranks body match when both terms present
  const both = filterNotes({ query: "review", rows, notes, store });
  assert.equal(both[0].id, "n2"); // name hit
});

test("filter: hint is trimmed to ~60 chars with an ellipsis", () => {
  const long = "x".repeat(80);
  const notes = { a: { name: "A", content: long, updated: 1 } };
  const out = filterNotes({ query: "xxx", rows: [{ id: "a", name: "A", updated: 1 }], notes, store: defaultSidecar() });
  assert.ok(out[0].hint.length <= 61, `hint too long: ${out[0].hint.length}`);
  assert.ok(out[0].hint.endsWith("…"));
});

test("filter: sort modes cycle recent -> created -> az -> trash", () => {
  assert.deepEqual(SORT_MODES, ["recent", "created", "az", "trash"]);
  assert.equal(cycleSortMode("recent"), "created");
  assert.equal(cycleSortMode("created"), "az");
  assert.equal(cycleSortMode("az"), "trash");
  assert.equal(cycleSortMode("trash"), "recent"); // wraps
  const { notes, store, rows } = fixture();
  // n3 is pinned (floats first); n5 is trashed (excluded). So each non-trash
  // mode leads with n3, then the live remainder in that mode's order.
  const created = filterNotes({ query: "", rows, notes, store, sortMode: "created" });
  assert.deepEqual(created.map((r) => r.id), ["n3", "n1", "n2", "n4"]);
  const az = filterNotes({ query: "", rows, notes, store, sortMode: "az" });
  assert.deepEqual(az.map((r) => r.id), ["n3", "n2", "n1", "n4"]); // pinned, then Album, Chill, Lyric
});

test("filter: pinned floats above the active sort in every non-trash mode", () => {
  const { notes, store, rows } = fixture();
  for (const sortMode of ["recent", "created", "az"]) {
    const out = filterNotes({ query: "", rows, notes, store, sortMode });
    const first = out[0];
    assert.equal(first.id, "n3", `pinned n3 must lead in ${sortMode}`);
    assert.equal(first.pinned, true);
  }
});

test("filter: trash mode hides trashed everywhere and shows only them in trash", () => {
  const { notes, store, rows } = fixture();
  // n5 is trashed -> invisible in normal modes
  for (const sortMode of ["recent", "created", "az"]) {
    const out = filterNotes({ query: "", rows, notes, store, sortMode });
    assert.ok(!out.some((r) => r.id === "n5"), `n5 must be hidden in ${sortMode}`);
  }
  // trash mode shows only trashed, with a restore hint
  const trash = filterNotes({ query: "", rows, notes, store, sortMode: "trash" });
  assert.deepEqual(trash.map((r) => r.id), ["n5"]);
  assert.match(trash[0].hint, /Enter restores/);
});

test("trash lifecycle: soft-delete -> invisible -> restore -> visible", () => {
  const { notes, store, rows } = fixture();
  const core = fakeCore(notes);
  assert.ok(softDeleteNote(core, store, "n1", 1000));
  assert.equal(store.trashed.n1, 1000);
  assert.ok(!filterNotes({ query: "", rows, notes, store }).some((r) => r.id === "n1"));
  assert.ok(restoreNote(core, store, "n1"));
  assert.equal(store.trashed.n1, undefined);
  assert.ok(filterNotes({ query: "", rows, notes, store }).some((r) => r.id === "n1"));
  // toasts fired, no dialogs
  assert.ok(core.toasts.some((t) => /Trash/.test(t)));
  assert.ok(core.toasts.some((t) => /Restored/.test(t)));
});

test("recents float to the top as a Recent group when query is empty", () => {
  const { notes, store, rows } = fixture();
  const out = filterNotes({ query: "", rows, notes, store });
  // pinned n3 outranks ordering, so it leads; then the Recent group n4, n1.
  assert.equal(out[0].id, "n3");
  assert.equal(out[0].pinned, true);
  assert.equal(out[1].id, "n4"); // most recent first
  assert.equal(out[1].group, "Recent");
  assert.equal(out[2].id, "n1");
  assert.equal(out[2].group, "Recent");
  // with a query, no Recent group is injected
  const q = filterNotes({ query: "review", rows, notes, store });
  assert.ok(!q.some((r) => r.group === "Recent"));
});

test("touchRecent de-dupes, caps at 10, most-recent first", () => {
  const sc = defaultSidecar();
  for (let i = 1; i <= 12; i++) touchRecent(sc, "n" + i);
  assert.equal(sc.recent.length, 10);
  assert.equal(sc.recent[0], "n12");
  touchRecent(sc, "n10"); // move existing to front
  assert.equal(sc.recent[0], "n10");
  assert.equal(sc.recent.filter((x) => x === "n10").length, 1);
});

// =========================================================== task 4: tags =
test("parseTags: words, dedupe, lowercase; ignores escaped and fenced", () => {
  assert.deepEqual(parseTags("hello #One and #two #one"), ["one", "two"]);
  // escaped \\# is not a tag
  assert.deepEqual(parseTags("not a \\#tag here"), []);
  // inside a ``` fence is skipped (simple toggle)
  const fenced = "#outside\n```\n#inside\n```\n#after";
  assert.deepEqual(parseTags(fenced), ["outside", "after"]);
  // tags must be word-start (not mid-word)
  assert.deepEqual(parseTags("foo#bar"), []);
});

test("switcher query #foo filters by tag", () => {
  const { notes, store, rows } = fixture();
  const out = filterNotes({ query: "#music", rows, notes, store });
  const ids = out.map((r) => r.id).sort();
  assert.deepEqual(ids, ["n2", "n4"]); // both tagged music
  // tag rows carry a #tag hint when no body hint applies
  const draft = filterNotes({ query: "#draft", rows, notes, store });
  assert.equal(draft.length, 1);
  assert.equal(draft[0].id, "n4");
});

// ======================================================= task 5: notebooks =
test("notebooks: list, create, rename, file-on-delete (never destroy)", () => {
  const sc = defaultSidecar();
  assert.deepEqual(listNotebooks(sc).map((n) => n.name), ["All", "Unfiled"]);
  const id = createNotebook(sc, "Reviews");
  assert.ok(id);
  assert.equal(listNotebooks(sc).length, 3);
  assert.equal(createNotebook(sc, "reviews"), null); // case-insensitive dupe blocked
  assert.ok(renameNotebook(sc, id, "Critiques"));
  fileNote(sc, "n2", id);
  assert.equal(sc.noteBook.n2, id);
  // delete files its notes to Unfiled, keeps the note id alive in noteBook-free
  assert.ok(deleteNotebook(sc, id));
  assert.equal(sc.noteBook.n2, undefined);
  assert.equal(listNotebooks(sc).length, 2);
});

test("notebook scope filters the switcher (query + rail scope)", () => {
  const { notes, store, rows } = fixture(); // n2 filed to nb1, rest unfiled
  // via query "notebook: Reviews"
  const scoped = filterNotes({ query: "notebook: Reviews", rows, notes, store });
  assert.deepEqual(scoped.map((r) => r.id), ["n2"]);
  // via rail scopeNotebook
  const viaRail = filterNotes({ query: "", rows, notes, store, scopeNotebook: "nb1" });
  assert.deepEqual(viaRail.map((r) => r.id), ["n2"]);
  const unfiled = filterNotes({ query: "", rows, notes, store, scopeNotebook: "__unfiled__" });
  assert.ok(unfiled.every((r) => r.id !== "n2"));
  assert.ok(unfiled.some((r) => r.id === "n1"));
});

// ======================================================= task 6: favorites =
test("favorites: fav: query filters to starred notes", () => {
  const { notes, store, rows } = fixture(); // n2 fav'd
  const out = filterNotes({ query: "fav:", rows, notes, store });
  assert.deepEqual(out.map((r) => r.id), ["n2"]);
});

// ========================================================= task 7: export =
test("exportMarkdown/Text pass the body verbatim (content is markdown-ish)", () => {
  const note = { name: "A", content: "# Head\n- item" };
  assert.equal(exportMarkdown(note).text, "# Head\n- item");
  assert.equal(exportMarkdown(note).ext, "md");
  assert.equal(exportText(note).text, "# Head\n- item");
  assert.equal(exportText(note).ext, "txt");
});

test("renderMdToHtml preserves headings, lists, checkboxes, quote, code", () => {
  const html = renderMdToHtml("# H\n\n- a\n- b\n\n1. one\n\n- [x] done\n- [ ] todo\n\n> quote\n\n```\ncode <&>\n```\n");
  assert.match(html, /<h1>H<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<ol>[\s\S]*<li>one<\/li>[\s\S]*<\/ol>/);
  assert.match(html, /☑ done/);
  assert.match(html, /☐ todo/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<pre><code>[\s\S]*code &lt;&amp;&gt;[\s\S]*<\/code><\/pre>/);
});

test("HTML export is self-contained with inline CSS and no http", () => {
  const note = { name: "My Note", content: "# Title\nbody" };
  const res = exportHtml(note);
  assert.equal(res.ext, "html");
  assert.match(res.text, /<!doctype html>/i);
  assert.match(res.text, /<style>/);
  assert.match(res.text, /<h1>Title<\/h1>/);
  // the shell must not reference any external resource (tailwind.test gate)
  assert.ok(!/https?:\/\//i.test(res.text), "HTML export must be self-contained, no remote refs");
  // palette tokens only, dark handled via prefers-color-scheme
  assert.match(res.text, /#09090b/);
  assert.match(res.text, /prefers-color-scheme:dark/);
});

test("HTML export escapes user content (no injection)", () => {
  const note = { name: "x", content: "<script>alert(1)</script>" };
  assert.ok(!exportHtml(note).text.includes("<script>"));
});

// ========================================================= task 8: import =
test("import: basename strips path + extension; creates a note", () => {
  assert.equal(basenameNoExt("C:\\\\Users\\\\a\\\\song.md"), "song");
  assert.equal(basenameNoExt("notes/My Note.txt"), "My Note");
  assert.equal(basenameNoExt("plain"), "plain");
  const core = fakeCore();
  const id = importFileText(core, "My Note.md", "# hi");
  assert.equal(core.notes[id].name, "My Note");
  assert.equal(core.notes[id].content, "# hi");
});

// ======================================================== task 9: templates =
test("templates create notes with the agreed skeleton", () => {
  const core = fakeCore();
  const album = applyTemplate(core, "Album Review", { date: "2026-10-10" });
  const body = core.notes[album].content;
  assert.match(body, /Rating: ☆☆☆☆☆/);
  assert.match(body, /Mood:/);
  assert.match(body, /Replay:/);
  assert.match(body, /Favorite tracks/);
  const journal = applyTemplate(core, "Daily Journal", { date: "2026-10-10" });
  assert.match(core.notes[journal].content, /2026-10-10/); // {{date}} filled
  const blank = applyTemplate(core, "Blank");
  assert.equal(core.notes[blank].content, "");
  assert.equal(applyTemplate(core, "Nope"), null); // unknown template
});

test("template pseudo-rows are offered through the switcher filter", () => {
  const rows = actionRows("");
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("+ Duplicate this note"));
  for (const t of ["Daily Journal", "Album Review", "Session Log", "Lyric Sheet", "Blank"])
    assert.ok(names.includes("+ Template: " + t), `missing template row: ${t}`);
  // non-empty query narrows the pseudo-rows
  const narrowed = actionRows("journal");
  assert.equal(narrowed.length, 1);
  assert.match(narrowed[0].name, /Daily Journal/);
  assert.equal(templateRow("Blank").id, "npdo-tpl:Blank");
});

// ======================================================= task 10: duplicate =
test("duplicate copies name (as … (copy)) + content into a new note", () => {
  assert.equal(duplicateName("Mix"), "Mix (copy)");
  assert.equal(duplicateName("Mix (copy)"), "Mix (copy)"); // no double-copy
  const core = fakeCore({ n1: { name: "Mix", content: "body", updated: 1 } });
  const id = applyDuplicate(core, core.notes.n1);
  assert.equal(core.notes[id].name, "Mix (copy)");
  assert.equal(core.notes[id].content, "body");
  assert.equal(applyDuplicate(core, null), null);
});

// ============================================ task 11: font / line height =
test("prefs: nextStep wraps the segmented lists both directions", () => {
  assert.equal(nextStep(FONT_SIZES, 16, 1), 18);
  assert.equal(nextStep(FONT_SIZES, 16, -1), 14);
  assert.equal(nextStep(FONT_SIZES, 20, 1), 14); // wrap up
  assert.equal(nextStep(FONT_SIZES, 14, -1), 20); // wrap down
  assert.equal(nextStep(LINE_HEIGHTS, 1.8, 1), 1.4);
});

test("applyPrefs writes font-size + line-height as inline style", () => {
  const el = { style: {} };
  const applied = applyPrefs(el, { fontSize: 20, lineHeight: 1.8 });
  assert.equal(el.style.fontSize, "20px");
  assert.equal(el.style.lineHeight, "1.8");
  assert.deepEqual(applied, { fontSize: 20, lineHeight: 1.8 });
  // out-of-range prefs fall back to defaults, never throw
  const bad = { style: {} };
  applyPrefs(bad, { fontSize: 99, lineHeight: 9 });
  assert.equal(bad.style.fontSize, "16px");
  assert.equal(bad.style.lineHeight, "1.6");
  assert.equal(applyPrefs(null, {}), null);
});

test("prefs round-trip through the sidecar store", () => {
  const sc = defaultSidecar();
  sc.prefs = { fontSize: 14, lineHeight: 1.4 };
  const back = loadSidecar(JSON.stringify(sc));
  assert.deepEqual(back.prefs, { fontSize: 14, lineHeight: 1.4 });
});

// ============================================================ init wiring =
test("CSS stays in the npdo- namespace and carries dark parity", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const css = fs.readFileSync(path.join(src, "notepad-org.css"), "utf8");
  // strip comments so narration doesn't read as a selector
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const sels = [...body.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
    .flatMap((m) => m[2].split(",").map((s) => s.trim()))
    .filter(Boolean);
  const leaked = [...new Set(sels)].filter((s) => !/npdo-/.test(s));
  assert.deepEqual(leaked, [], `non-npdo selectors leaked: ${leaked.join(", ")}`);
  // dark parity for every surface we render
  assert.match(css, /html\.dark/, "styles must carry html.dark overrides");
});

test("initNotepadOrg registers a switcher filter over a fake core", async () => {
  // init injects CSS / touches document; we only assert the filter wiring by
  // calling the registered filter. We stub localStorage so init loads a store
  // where n5 is trashed, proving the registered filter hides it.
  const { initNotepadOrg } = await import("../src/notepad-org.js");
  const { store, rows } = fixture();
  const mem = new Map([[STORE_KEY, JSON.stringify(store)]]);
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  const before = initNotepadOrg._done;
  initNotepadOrg._done = false;
  const core = fakeCore({});
  core.mount = () => null;
  core.panel = () => null;
  core.textarea = () => null;
  // allNotes must expose every fixture note so prune keeps them all
  const notes = fixture().notes;
  core.allNotes = () => notes;
  initNotepadOrg(core);
  assert.equal(core.filters.length, 1, "exactly one switcher filter registered");
  const res = core.filters[0]("", rows);
  assert.ok(res.some((r) => r.id === "npdo-dup"));
  assert.ok(res.some((r) => r.id === "n2"));
  assert.ok(!res.some((r) => r.id === "n5"), "trashed n5 must stay hidden");
  initNotepadOrg._done = before; // restore for any sibling test
  globalThis.localStorage = prevLS;
});

test("parseQuery isolates terms / tags / fav / notebook", () => {
  assert.deepEqual(parseQuery("hello #tag fav: notebook:Work"), {
    terms: ["hello"],
    tags: ["tag"],
    favOnly: true,
    notebook: "Work",
  });
  assert.deepEqual(parseQuery(""), { terms: [], tags: [], favOnly: false, notebook: null });
});
