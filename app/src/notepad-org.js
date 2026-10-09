// notepad-org.js — Devi's organization & comfort layer for the notepad panel.
// docs/notepad/devi.md (Tier 1 #13-16, Tier 2 #19-35). Storage key
// `tm-notepad-org` only; CSS/ids prefix `npdo-` only; palette tokens only.
//
// Structure: every behaviour that can be pure is an exported function taking
// its state explicitly, so app/tests/notepad-org.test.mjs drives them against
// fixture data and a fake `core` with no DOM. `initNotepadOrg(core)` is the
// thin wiring layer (events, keydown relay, rail/badge/menu rendering) that
// Govinda's panel calls once. It is defensive: every core/DOM access is
// feature-detected and guarded, so a missing surface degrades instead of
// throwing.

// ------------------------------------------------------------- constants -
export const STORE_KEY = "tm-notepad-org";
/// Sort modes cycled by Alt+R. `trash` is the terminal "mode" (a filter view).
export const SORT_MODES = ["recent", "created", "az", "trash"];
export const SORT_LABEL = {
  recent: "Recently edited",
  created: "Created",
  az: "A-Z",
  trash: "Trash",
};
export const FONT_SIZES = [14, 16, 18, 20];
export const LINE_HEIGHTS = [1.4, 1.6, 1.8];
export const DEFAULT_PREFS = { fontSize: 16, lineHeight: 1.6 };
/// Recents cap (devi.md schema: most-recently-opened first, cap 10).
export const RECENT_CAP = 10;
export const UNFILED = "__unfiled__";
export const ALL_NOTEBOOKS = "__all__";

/// Templates — Devi owns these texts (ganesha.md task 5 adopts them verbatim).
/// `{{date}}` is filled with today's YYYY-MM-DD by fillTemplate().
export const TEMPLATES = {
  "Daily Journal":
    "# Daily Journal - {{date}}\n\n## Mood\n\n\n## What I listened to\n- \n\n## Notes\n- \n\n## Gratitude\n- \n",
  "Album Review":
    "# Album Review\n\nArtist: \nAlbum: \nYear: \n\n## Rating: ☆☆☆☆☆\n\n## Favorite tracks\n- \n\n## Mood: \n\n## Replay: high\n\n## Verdict\n\n",
  "Session Log":
    "# Session Log - {{date}}\n\n## Host\n\n## Tracks\n- \n\n## Timestamps\n- @0:00 \n\n## Notes\n\n",
  "Lyric Sheet":
    "# Lyric Sheet\n\nTrack: \nArtist: \n\n@0:00 \n@0:05 \n@0:10 \n",
  "Blank": "",
};

// ------------------------------------------------------------- sidecar -
export function defaultSidecar() {
  return {
    tags: {},
    notebooks: [],
    noteBook: {},
    fav: {},
    trashed: {},
    pinned: {},
    recent: [],
    prefs: { ...DEFAULT_PREFS },
  };
}

const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const truthy = (v) => !!v;

function healMap(obj, ok) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) if (ok(v)) out[k] = v;
  return out;
}

function healPrefs(p) {
  const prefs = { ...DEFAULT_PREFS };
  if (!p || typeof p !== "object") return prefs;
  if (FONT_SIZES.includes(p.fontSize)) prefs.fontSize = p.fontSize;
  if (LINE_HEIGHTS.includes(p.lineHeight)) prefs.lineHeight = p.lineHeight;
  return prefs;
}

/// Corrupt-safe load. Bad JSON or wrong-typed fields fall back per-field to
/// defaults; never throws. This is the ONLY reader of `tm-notepad-org`.
export function loadSidecar(raw) {
  const base = defaultSidecar();
  if (!raw) return base;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!obj || typeof obj !== "object") return base;
  return {
    tags: healMap(obj.tags, isStrArr),
    notebooks: Array.isArray(obj.notebooks)
      ? obj.notebooks.filter(
          (n) => n && typeof n.id === "string" && typeof n.name === "string",
        )
      : [],
    noteBook: healMap(obj.noteBook, (v) => typeof v === "string"),
    fav: healMap(obj.fav, truthy),
    trashed: healMap(obj.trashed, (v) => typeof v === "number"),
    pinned: healMap(obj.pinned, truthy),
    recent: isStrArr(obj.recent) ? obj.recent.slice(0, RECENT_CAP) : [],
    prefs: healPrefs(obj.prefs),
  };
}

/// Drop every per-note entry whose id is no longer a key of `notes`
/// (core.allNotes()). Notebooks themselves are kept — they are independent of
/// any single note. Mutates and returns `sc`. Recent is re-capped.
export function pruneSidecar(sc, noteIds) {
  const ids = new Set(noteIds || []);
  const pruneMap = (m) => {
    for (const k of Object.keys(m)) if (!ids.has(k)) delete m[k];
  };
  pruneMap(sc.tags);
  pruneMap(sc.noteBook);
  pruneMap(sc.fav);
  pruneMap(sc.trashed);
  pruneMap(sc.pinned);
  sc.recent = sc.recent.filter((id) => ids.has(id)).slice(0, RECENT_CAP);
  return sc;
}

// ------------------------------------------------------------- tags (#19) -
/// Parse `#tag` words from note content. `\#` is escaped (not a tag); lines
/// inside a ``` fence are skipped via a simple open/close toggle (no full
/// markdown parser). Returns lower-cased, de-duplicated tags in order.
export function parseTags(content, fenceRe = /^```/) {
  const out = [];
  let inFence = false;
  for (const rawLine of String(content || "").split("\n")) {
    const line = rawLine.trim();
    if (fenceRe.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const scrubbed = rawLine.replace(/\\#/g, " ");
    for (const m of scrubbed.matchAll(/(^|\s)#([\w-]+)/g)) {
      const tag = m[2].toLowerCase();
      if (tag && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}

// --------------------------------------------------------- query parsing -
/// Split a switcher query into term / tag / fav / notebook parts.
/// `#foo` -> tag filter; `fav:` -> favorites only; `notebook:X` (or
/// `notebook: X`, quoted for multi-word) -> scope.
export function parseQuery(q) {
  const terms = [];
  const tags = [];
  let favOnly = false;
  let notebook = null;
  let s = String(q || "");
  // notebook: value — quoted multi-word, or a single following token.
  const nb = s.match(/notebook:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (nb) {
    notebook = nb[1] || nb[2] || nb[3] || null;
    s = s.replace(nb[0], " ");
  }
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    const lc = tok.toLowerCase();
    if (lc === "fav:" || lc.startsWith("fav:")) {
      favOnly = true;
      continue;
    }
    if (tok.startsWith("#")) {
      const tag = tok.slice(1).toLowerCase();
      if (tag) tags.push(tag);
      continue;
    }
    terms.push(lc);
  }
  return { terms, tags, favOnly, notebook };
}

// ------------------------------------------------------- filter engine -
function bodyHint(content, term, max = 60) {
  const lines = String(content || "").split("\n");
  const lc = term.toLowerCase();
  let line = (lines.find((l) => l.toLowerCase().includes(lc)) || "").trim();
  if (line.length > max) line = line.slice(0, max - 1).trimEnd() + "…";
  return line;
}

/// Score one row against every term. All terms must match name or body.
/// Ranking: exact name > name-prefix > name-contains > body-contains.
function scoreRow(name, content, terms) {
  const nameLc = String(name || "").toLowerCase();
  const contentLc = String(content || "").toLowerCase();
  let score = 0;
  let hint = null;
  for (const t of terms) {
    if (nameLc === t) {
      score += 100;
      continue;
    }
    if (nameLc.startsWith(t)) {
      score += 80;
      continue;
    }
    if (nameLc.includes(t)) {
      score += 60;
      continue;
    }
    const idx = contentLc.indexOf(t);
    if (idx >= 0) {
      score += 30;
      if (!hint) hint = bodyHint(content, t);
      continue;
    }
    return { matched: false, score: 0, hint: null };
  }
  return { matched: true, score, hint };
}

function comparator(mode) {
  if (mode === "az") return (a, b) => String(a.name).localeCompare(String(b.name));
  if (mode === "created")
    return (a, b) =>
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  // recent (default): most recently edited first.
  return (a, b) => Number(b.updated || 0) - Number(a.updated || 0);
}

function tagHint(store, id) {
  const tags = store.tags[id];
  return tags && tags.length ? tags.map((t) => "#" + t).join(" ") : null;
}

function inNotebook(store, id, scope) {
  if (scope === ALL_NOTEBOOKS || scope == null) return true;
  const home = store.noteBook[id] || null;
  if (scope === UNFILED) return home === null;
  return home === scope;
}

/// Resolve a scope token (notebook id, notebook name, or the ALL/UNFILED
/// sentinels) to a concrete notebook id, or the sentinel unchanged. Unknown
/// names resolve to a sentinel that matches nothing.
function resolveScope(store, token) {
  if (token == null || token === ALL_NOTEBOOKS || token === UNFILED) return token;
  const t = String(token).toLowerCase();
  if (t === "all") return ALL_NOTEBOOKS;
  if (t === "unfiled") return UNFILED;
  const nb = (store.notebooks || []).find(
    (n) => n.id === token || n.name.toLowerCase() === t,
  );
  return nb ? nb.id : "\u0000no-such-notebook";
}

/// The filter engine. `rows` are the switcher rows core hands in
/// ([{ id, name, updated }]); `notes` is core.allNotes() for body search.
/// Returns rows shaped { id, name, updated, pinned, hint?, group? }.
/// Handles #13 content search, #14 sort modes, #15 pinned float, #16 trash
/// exclusion, #19 `#tag` filter, #21 `fav:` filter, #20 notebook scope and
/// #34 recents float. (Template/duplicate pseudo-rows are layered on top by
/// the caller via actionRows(), so this stays a pure note filter.)
export function filterNotes(opts = {}) {
  const {
    query = "",
    rows = [],
    notes = {},
    store = defaultSidecar(),
    sortMode = "recent",
    scopeNotebook = null,
  } = opts;

  const q = String(query || "").trim();
  const parsed = parseQuery(q);

  // Trash view (#16): only trashed rows, newest-deleted first.
  if (sortMode === "trash") {
    return rows
      .filter((r) => r && r.id && store.trashed[r.id] != null)
      .sort((a, b) => store.trashed[b.id] - store.trashed[a.id])
      .map((r) => ({
        id: r.id,
        name: r.name,
        updated: r.updated,
        pinned: false,
        hint: "Trash - Enter restores",
      }));
  }

  // Non-trash modes: trashed ids are excluded everywhere.
  const live = rows.filter((r) => r && r.id && store.trashed[r.id] == null);

  const scope = parsed.notebook != null ? resolveScope(store, parsed.notebook) : scopeNotebook;
  let pool = live;
  if (scope != null && scope !== ALL_NOTEBOOKS) {
    pool = pool.filter((r) => inNotebook(store, r.id, scope));
  }
  if (parsed.favOnly) pool = pool.filter((r) => store.fav[r.id]);
  if (parsed.tags.length) {
    pool = pool.filter((r) => {
      const tags = store.tags[r.id] || [];
      return parsed.tags.every((t) => tags.includes(t));
    });
  }

  // Score / hint pass.
  let items;
  if (parsed.terms.length) {
    items = [];
    for (const r of pool) {
      const note = notes[r.id] || {};
      const name = r.name ?? note.name ?? "";
      const content = note.content ?? "";
      const s = scoreRow(name, content, parsed.terms);
      if (s.matched) items.push({ row: r, name, content, hint: s.hint, score: s.score });
    }
  } else {
    items = pool.map((r) => {
      const note = notes[r.id] || {};
      return {
        row: r,
        name: r.name ?? note.name ?? "",
        content: note.content ?? "",
        hint: null,
        score: 0,
      };
    });
  }

  // Sort with pinned float (#15) above the active mode order.
  const cmp = comparator(sortMode);
  items.sort((a, b) => {
    const pa = store.pinned[a.row.id] ? 0 : 1;
    const pb = store.pinned[b.row.id] ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return cmp(a, b);
  });

  let out = items.map((it) => {
    const r = it.row;
    const hint = it.hint || tagHint(store, r.id);
    const row = {
      id: r.id,
      name: it.name,
      updated: r.updated,
      pinned: !!store.pinned[r.id],
    };
    if (hint) row.hint = hint;
    return row;
  });

  // Recents float (#34): empty query + recent mode -> a Recent group on top,
  // but never above the explicitly pinned rows (pins outrank ordering).
  if (!q && sortMode === "recent") out = floatRecents(out, store.recent);

  return out;
}

function floatRecents(rows, recent) {
  const pinned = rows.filter((r) => r.pinned);
  const unpinned = rows.filter((r) => !r.pinned);
  const order = (recent || []).filter((id) => unpinned.some((r) => r.id === id));
  const recents = order.map((id) => {
    const r = unpinned.find((x) => x.id === id);
    return { ...r, group: "Recent", hint: r.hint ? r.hint : "Recent" };
  });
  const rest = unpinned.filter((r) => !order.includes(r.id));
  return [...pinned, ...recents, ...rest];
}

export function cycleSortMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1) % SORT_MODES.length];
}

// ------------------------------------------------- pseudo-rows (9/10) -
export function duplicateRow() {
  return {
    id: "npdo-dup",
    name: "+ Duplicate this note",
    updated: 0,
    pinned: false,
    hint: "Copy current note",
    pseudo: "duplicate",
  };
}
export function templateRow(name) {
  return {
    id: "npdo-tpl:" + name,
    name: "+ Template: " + name,
    updated: 0,
    pinned: false,
    hint: "Create note",
    pseudo: "template",
    template: name,
  };
}
/// Pseudo action rows: all on empty query; otherwise those whose label
/// contains the query (so "templ", "dup", "journal" surface them).
export function actionRows(query) {
  const q = String(query || "").trim().toLowerCase().replace(/^\+/, "");
  const rows = [duplicateRow(), ...Object.keys(TEMPLATES).map(templateRow)];
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fillTemplate(text, opts) {
  return String(text || "").replaceAll("{{date}}", (opts && opts.date) || todayISO());
}

/// Pure action helpers (testable without a DOM).
export function applyTemplate(core, name, opts) {
  if (!(name in TEMPLATES)) return null;
  return core.newNote(name, fillTemplate(TEMPLATES[name], opts));
}
export function applyDuplicate(core, srcNote) {
  if (!srcNote) return null;
  return core.newNote(duplicateName(srcNote.name || "Untitled"), srcNote.content ?? "");
}

export function duplicateName(name) {
  const base = String(name || "Untitled").trim() || "Untitled";
  return base.replace(/\s*\(copy( \d+)?\)$/i, "") + " (copy)";
}

// --------------------------------------------------- trash / recents -
export function softDeleteNote(core, store, id, now = Date.now()) {
  if (!id) return false;
  store.trashed[id] = now;
  try {
    core.closeNote(id);
  } catch {}
  core.refresh?.();
  core.toast?.("Moved to Trash");
  return true;
}
export function restoreNote(core, store, id) {
  if (store.trashed[id] == null) return false;
  delete store.trashed[id];
  core.refresh?.();
  core.toast?.("Restored");
  return true;
}
export function touchRecent(store, id) {
  if (!id) return;
  store.recent = [id, ...store.recent.filter((x) => x !== id)].slice(0, RECENT_CAP);
}

// -------------------------------------------------- notebooks (#20) -
export function listNotebooks(store) {
  const rows = [
    { id: ALL_NOTEBOOKS, name: "All" },
    { id: UNFILED, name: "Unfiled" },
  ];
  for (const nb of store.notebooks || []) rows.push({ id: nb.id, name: nb.name });
  return rows;
}
export function createNotebook(store, name) {
  const nm = String(name || "").trim();
  if (!nm) return null;
  if ((store.notebooks || []).some((n) => n.name.toLowerCase() === nm.toLowerCase()))
    return null;
  const id = "nb-" + Math.random().toString(36).slice(2, 8);
  store.notebooks.push({ id, name: nm });
  return id;
}
export function renameNotebook(store, id, name) {
  const nm = String(name || "").trim();
  const nb = (store.notebooks || []).find((n) => n.id === id);
  if (!nb || !nm) return false;
  nb.name = nm;
  return true;
}
/// Delete a notebook: its notes are filed back to Unfiled, never destroyed.
export function deleteNotebook(store, id) {
  const before = (store.notebooks || []).length;
  store.notebooks = (store.notebooks || []).filter((n) => n.id !== id);
  if (store.notebooks.length === before) return false;
  for (const k of Object.keys(store.noteBook)) if (store.noteBook[k] === id) delete store.noteBook[k];
  return true;
}
export function fileNote(store, id, nbId) {
  if (nbId == null || nbId === ALL_NOTEBOOKS || nbId === UNFILED) delete store.noteBook[id];
  else store.noteBook[id] = nbId;
}

// --------------------------------------------------- font / line (#28/29) -
export function nextStep(arr, cur, dir) {
  let i = arr.indexOf(cur);
  if (i < 0) i = 0;
  i = (i + (dir > 0 ? 1 : -1) + arr.length) % arr.length;
  return arr[i];
}
/// Apply prefs as inline style on the editor surface. Returns the applied pair.
export function applyPrefs(el, prefs) {
  if (!el || !el.style) return null;
  const fs = FONT_SIZES.includes(prefs?.fontSize) ? prefs.fontSize : DEFAULT_PREFS.fontSize;
  const lh = LINE_HEIGHTS.includes(prefs?.lineHeight) ? prefs.lineHeight : DEFAULT_PREFS.lineHeight;
  el.style.fontSize = fs + "px";
  el.style.lineHeight = String(lh);
  return { fontSize: fs, lineHeight: lh };
}

// ------------------------------------------------------ export (#22-24) -
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return t;
}
/// markdown-ish -> HTML: headings, hr, blockquote, code fence, ul/ol/checkbox,
/// bold/italic. Self-contained; no network, no CDN.
export function renderMdToHtml(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  let inFence = false;
  let listOpen = null;
  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inFence) {
        out.push("</code></pre>");
        inFence = false;
      } else {
        closeList();
        out.push("<pre><code>");
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      out.push(escapeHtml(raw));
      continue;
    }
    const t = raw.trim();
    if (!t) {
      closeList();
      continue;
    }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const l = h[1].length;
      out.push(`<h${l}>${inline(h[2])}</h${l}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    const bq = t.match(/^>\s?(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    const task = t.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      if (listOpen !== "ul") {
        closeList();
        out.push("<ul>");
        listOpen = "ul";
      }
      const box = task[1].toLowerCase() === "x" ? "☑" : "☐";
      out.push(`<li class="npdo-task">${box} ${inline(task[2])}</li>`);
      continue;
    }
    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (listOpen !== "ul") {
        closeList();
        out.push("<ul>");
        listOpen = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (listOpen !== "ol") {
        closeList();
        out.push("<ol>");
        listOpen = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  if (inFence) out.push("</code></pre>");
  closeList();
  return out.join("\n");
}
/// Self-contained HTML shell using palette tokens only — contains no `http`.
export function htmlShell(title, body) {
  const esc = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;background:#f9f9fb;color:#1a1c1d;font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:46rem;margin:0 auto;padding:2rem 1.5rem}
h1,h2,h3{line-height:1.25}
h1{font-size:1.6rem}h2{font-size:1.3rem}h3{font-size:1.1rem}
blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid #e2e2e4;color:#71717a}
pre{background:#f3f3f5;border:1px solid #e8e8ea;border-radius:8px;padding:1rem;overflow:auto}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
ul,ol{padding-left:1.5rem}
li.npdo-task{list-style:none}
hr{border:0;border-top:1px solid #e2e2e4;margin:1.5rem 0}
@media (prefers-color-scheme:dark){
body{background:#09090b;color:#f4f4f5}
blockquote{border-color:#242429;color:#a1a1aa}
pre{background:#101013;border-color:#1a1a1e}
hr{border-top-color:#242429}
}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
export function exportMarkdown(note) {
  return { ext: "md", mime: "text/markdown", text: note?.content ?? "" };
}
export function exportText(note) {
  return { ext: "txt", mime: "text/plain", text: note?.content ?? "" };
}
export function exportHtml(note) {
  const title = note?.name || "Untitled";
  return { ext: "html", mime: "text/html", text: htmlShell(title, renderMdToHtml(note?.content || "")) };
}

// ------------------------------------------------------- import (#26) -
export function basenameNoExt(filename) {
  const base = String(filename || "Untitled").split(/[\\/]/).pop() || "Untitled";
  return base.replace(/\.[^.]+$/, "") || "Untitled";
}
export function importFileText(core, filename, text) {
  return core.newNote(basenameNoExt(filename), String(text ?? ""));
}

// ------------------------------------------------- wiring (DOM / core) -
function readStore() {
  try {
    return globalThis.localStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
}
export function writeStore(store) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
}

function injectCss() {
  if (typeof document === "undefined" || document.querySelector('link[npdo-org]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("npdo-org", "");
  link.href = "notepad-org.css?v=" + Date.now();
  (document.head || document.documentElement).appendChild(link);
}

function typingInEditor() {
  if (typeof document === "undefined") return false;
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || ae.isContentEditable;
}
/// Best-effort switcher-open probe (provisional until Govinda's core lands).
function switcherOpen() {
  if (typeof document === "undefined") return false;
  const cands = document.querySelectorAll(
    '[id*="switcher" i],[class*="switcher" i],[data-npd-switcher]',
  );
  for (const el of cands) {
    if (el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length))
      return true;
  }
  return false;
}
function panelEl(core) {
  if (typeof core.panel === "function") {
    try {
      const p = core.panel();
      if (p) return p;
    } catch {}
  }
  if (typeof core.textarea === "function") {
    try {
      return core.textarea();
    } catch {}
  }
  return null;
}
function refreshSwitcher() {
  // No contract hook to force a re-filter; a live switcher re-queries on the
  // next keystroke. Toast already reports the new mode.
}

function renderTabMeta(core, store) {
  const host = core.mount?.("tabmeta");
  if (!host) return;
  host.textContent = "";
  const note = core.activeNote?.();
  if (!note) return;
  const id = note.id;
  const bits = [];
  if (store.fav[id]) bits.push("★");
  if (store.pinned[id]) bits.push("▲");
  for (const t of store.tags[id] || []) bits.push("#" + t);
  for (const b of bits) {
    const s = document.createElement("span");
    s.className = "npdo-badge";
    s.textContent = b;
    host.appendChild(s);
  }
}

function renderExportMenu(core, store) {
  const overlay = core.mount?.("overlay");
  if (!overlay) return;
  let menu = overlay.querySelector(".npdo-menu");
  if (menu) {
    menu.remove();
    return;
  }
  menu = document.createElement("div");
  menu.className = "npdo-menu";
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.className = "npdo-menu-row";
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    menu.appendChild(b);
  };
  const dl = (res) => {
    const note = core.activeNote?.();
    const name = (note?.name || "note").replace(/[\\/:*?"<>|]/g, "_");
    const url = URL.createObjectURL(new Blob([res.text], { type: res.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${res.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    core.toast?.(`Exported .${res.ext}`);
    menu.remove();
  };
  mk("Markdown (.md)", () => dl(exportMarkdown(core.activeNote?.())));
  mk("Text (.txt)", () => dl(exportText(core.activeNote?.())));
  mk("HTML (.html)", () => dl(exportHtml(core.activeNote?.())));
  const close = document.createElement("button");
  close.className = "npdo-menu-row npdo-menu-cancel";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => menu.remove());
  menu.appendChild(close);
  overlay.appendChild(menu);
}

function triggerImport(core) {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.txt";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const id = importFileText(core, file.name, String(reader.result ?? ""));
      core.toast?.("Imported " + basenameNoExt(file.name));
      if (id) core.openNote?.(id);
    };
    reader.readAsText(file);
  });
  input.click();
}

function renderRail(core, store, state) {
  const host = core.mount?.("side");
  if (!host) return;
  host.textContent = "";
  host.classList.add("npdo-rail");

  const mkRow = (label, active, onClick, right) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "npdo-nb" + (active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    if (right) {
      const r = document.createElement("span");
      r.className = "npdo-nb-right";
      r.textContent = right;
      b.appendChild(r);
    }
    return b;
  };

  const head = document.createElement("div");
  head.className = "npdo-rail-head";
  head.textContent = "Notebooks";
  host.appendChild(head);

  for (const nb of listNotebooks(store)) {
    const active = state.scopeNotebook === nb.id;
    const count =
      nb.id === ALL_NOTEBOOKS
        ? Object.keys(core.allNotes?.() || {}).length
        : nb.id === UNFILED
          ? Object.keys(core.allNotes?.() || {}).filter((id) => !store.noteBook[id]).length
          : Object.keys(store.noteBook).filter((id) => store.noteBook[id] === nb.id).length;
    const row = mkRow(nb.name, active, () => {
      state.scopeNotebook = active ? null : nb.id;
      renderRail(core, store, state);
    }, String(count));
    row.dataset.npdoNb = nb.id;
    if (nb.id !== ALL_NOTEBOOKS && nb.id !== UNFILED) {
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          state.scopeNotebook = nb.id;
          renderRail(core, store, state);
        } else if (e.key === "Delete") {
          e.preventDefault();
          deleteNotebook(store, nb.id);
          writeStore(store);
          core.toast?.(`Deleted notebook (notes moved to Unfiled)`);
          renderRail(core, store, state);
        } else if (e.key === "F2") {
          e.preventDefault();
          editNotebookName(core, store, state, nb.id);
        }
      });
    }
    host.appendChild(row);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "npdo-nb npdo-add";
  add.textContent = "+ New notebook";
  add.addEventListener("click", () => editNotebookName(core, store, state, null));
  host.appendChild(add);

  // Tag list at the bottom of the rail (#19).
  const allTags = new Set();
  for (const arr of Object.values(store.tags)) for (const t of arr) allTags.add(t);
  if (allTags.size) {
    const th = document.createElement("div");
    th.className = "npdo-rail-head";
    th.textContent = "Tags";
    host.appendChild(th);
    const wrap = document.createElement("div");
    wrap.className = "npdo-tags";
    for (const t of [...allTags].sort()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "npdo-tag";
      chip.textContent = "#" + t;
      chip.addEventListener("click", () => core.toast?.(`#${t}`));
      wrap.appendChild(chip);
    }
    host.appendChild(wrap);
  }

  // Font / line control block (#28/#29).
  const prefs = document.createElement("div");
  prefs.className = "npdo-prefs";
  const segRow = (label, values, cur, onPick) => {
    const line = document.createElement("div");
    line.className = "npdo-seg";
    for (const v of values) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "npdo-seg-item" + (v === cur ? " active" : "");
      s.textContent = String(v);
      s.addEventListener("click", () => onPick(v));
      line.appendChild(s);
    }
    const lab = document.createElement("span");
    lab.className = "npdo-seg-label";
    lab.textContent = label;
    line.prepend(lab);
    return line;
  };
  prefs.appendChild(
    segRow("Size", FONT_SIZES, store.prefs.fontSize, (v) => {
      store.prefs.fontSize = v;
      applyPrefs(panelEl(core), store.prefs);
      writeStore(store);
      renderRail(core, store, state);
    }),
  );
  prefs.appendChild(
    segRow("Line", LINE_HEIGHTS, store.prefs.lineHeight, (v) => {
      store.prefs.lineHeight = v;
      applyPrefs(panelEl(core), store.prefs);
      writeStore(store);
      renderRail(core, store, state);
    }),
  );
  host.appendChild(prefs);
}

function editNotebookName(core, store, state, nbId) {
  const host = core.mount?.("side");
  if (!host) return;
  const existing = host.querySelector(".npdo-prompt");
  if (existing) existing.remove();
  const row = document.createElement("div");
  row.className = "npdo-prompt";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "npdo-prompt-input";
  input.placeholder = nbId ? "Rename notebook" : "Notebook name";
  if (nbId) {
    const nb = (store.notebooks || []).find((n) => n.id === nbId);
    input.value = nb ? nb.name : "";
  }
  const commit = () => {
    const val = input.value.trim();
    if (val) {
      if (nbId) renameNotebook(store, nbId, val);
      else createNotebook(store, val);
      writeStore(store);
    }
    renderRail(core, store, state);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renderRail(core, store, state);
    }
  });
  row.appendChild(input);
  host.appendChild(row);
  input.focus();
}

function handlePseudoOpen(core, store, state, id) {
  if (typeof id !== "string") return false;
  if (id === "npdo-dup") {
    const src = state.lastReal ? core.allNotes?.()[state.lastReal] : null;
    const base = src || core.activeNote?.();
    const newId = applyDuplicate(core, base);
    try {
      core.closeNote("npdo-dup");
    } catch {}
    if (newId) core.openNote?.(newId);
    return true;
  }
  if (id.startsWith("npdo-tpl:")) {
    const name = id.slice("npdo-tpl:".length);
    const newId = applyTemplate(core, name);
    try {
      core.closeNote(id);
    } catch {}
    if (newId) core.openNote?.(newId);
    core.toast?.("New note from template");
    return true;
  }
  return false;
}

function handleKeydown(core, store, state, ev) {
  if (!ev) return;
  const k = ev.key;
  const altOnly = ev.altKey && !ev.ctrlKey && !ev.metaKey;

  // Alt+E — export menu (gesture comes from the keydown).
  if (altOnly && (k === "e" || k === "E")) {
    ev.preventDefault();
    renderExportMenu(core, store);
    return;
  }
  // Alt+I — import a .md/.txt file.
  if (altOnly && (k === "i" || k === "I")) {
    ev.preventDefault();
    triggerImport(core);
    return;
  }
  // Alt+R — cycle sort/trash mode.
  if (altOnly && (k === "r" || k === "R")) {
    ev.preventDefault();
    state.sortMode = cycleSortMode(state.sortMode);
    core.toast?.("Sort: " + (SORT_LABEL[state.sortMode] || state.sortMode));
    refreshSwitcher();
    return;
  }
  // + / - — font size (only when no input has focus).
  if ((k === "+" || k === "=" || k === "-" || k === "_") && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
    if (typingInEditor()) return;
    const dir = k === "+" || k === "=" ? 1 : -1;
    store.prefs.fontSize = nextStep(FONT_SIZES, store.prefs.fontSize, dir);
    applyPrefs(panelEl(core), store.prefs);
    writeStore(store);
    ev.preventDefault();
    return;
  }
  // Delete — soft-delete while the switcher is open (#16).
  if (k === "Delete" && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
    if (!switcherOpen()) return;
    const note = core.activeNote?.();
    if (!note) return;
    ev.preventDefault();
    softDeleteNote(core, store, note.id);
    return;
  }
}

/// Entry point Govinda's notepad.js calls once. Idempotent.
export function initNotepadOrg(core) {
  if (!core || initNotepadOrg._done) return;
  initNotepadOrg._done = true;

  const store = loadSidecar(readStore());
  const state = { sortMode: "recent", scopeNotebook: null, lastReal: null };

  injectCss();
  const prune = () => {
    pruneSidecar(store, Object.keys(core.allNotes?.() || {}));
    writeStore(store);
  };
  prune();

  core.addSwitcherFilter?.((query, rows) => {
    const notes = core.allNotes?.() || {};
    const noteRows = filterNotes({
      query,
      rows,
      notes,
      store,
      sortMode: state.sortMode,
      scopeNotebook: state.scopeNotebook,
    });
    const acts = actionRows(query);
    return acts.length ? [...acts, ...noteRows] : noteRows;
  });

  core.on?.("open", () => {
    prune();
    renderRail(core, store, state);
  });
  core.on?.("note", (d) => {
    if (!d || !d.id) return;
    if (handlePseudoOpen(core, store, state, d.id)) return;
    state.lastReal = d.id;
    touchRecent(store, d.id);
    if (store.trashed[d.id] != null) restoreNote(core, store, d.id);
    writeStore(store);
    renderTabMeta(core, store);
    renderRail(core, store, state);
  });
  core.on?.("saved", (d) => {
    if (!d || !d.id) return;
    const note = (core.allNotes?.() || {})[d.id];
    if (!note) return;
    const tags = parseTags(note.content);
    if (tags.length) store.tags[d.id] = tags;
    else delete store.tags[d.id];
    writeStore(store);
    renderTabMeta(core, store);
    renderRail(core, store, state);
  });
  core.on?.("keydown", (ev) => handleKeydown(core, store, state, ev));

  applyPrefs(panelEl(core), store.prefs);
  renderRail(core, store, state);
}
initNotepadOrg._done = false;
