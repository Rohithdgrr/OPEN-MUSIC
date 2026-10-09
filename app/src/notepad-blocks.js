// notepad-blocks.js — Vijay (phase 3): editing power for the notepad.
// Spec: docs/notepad/vijay.md · contract: docs/notepad/README.md §2.
//
// Two invariants shape every line of this file:
//   1. Content is ONE plain-text string forever. Everything here is either
//      syntax IN (slash rows insert markdown) or a view OUT (preview, TOC,
//      find parse the text). There is no block tree in storage, ever.
//   2. Undo/redo stays the textarea's native stack, so this module never
//      assigns to a textarea directly: writes go through the contract
//      (core.setNoteContent / core.insertAtCursor) or, for a pure caret
//      insertion, through document.execCommand("insertText"). The static
//      test greps for a direct value assignment and must find none.
//
// Rendering: DOM is built from an element allowlist (PAINT_TAGS) via
// createElement, and text enters only through renderInlineHtml()/esc() —
// never through innerHTML with raw content. The XSS test enforces this.
//
// Everything is testable without Govinda's core: the engine below is pure
// and exported; initNotepadBlocks(core) is a thin wiring layer.

import { esc } from "./html.js";

// --------------------------------------------------------------- storage -
// The only two keys this module may touch (README §2.3).
export const LS_BLOCKS = "tm-notepad-blocks";
export const LS_VERS = "tm-notepad-versions";

function lsGet(key, fallback) {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback; // corrupt storage must never break the panel
  }
}

function lsSet(key, value) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ===================================================== 1. list input rules =
// Enter rules on core.textarea(): continue bullets / numbering / quotes /
// checkboxes, renumber numbered siblings, and drop the marker of an empty
// item (Notion behaviour). Pure: (value, caret) -> edit | {handled:false}.

const RE_CHECK = /^(\s*)([-*+])(\s+)\[[ xX]\](\s+)(.*)$/;
const RE_NUM = /^(\s*)(\d+)([.)])(\s+)(.*)$/;
const RE_BULLET = /^(\s*)([-*+])(\s+)(.*)$/;
const RE_QUOTE = /^(\s*)(>\s?)(.*)$/;

function matchMarker(left) {
  let m = left.match(RE_CHECK);
  if (m) return { kind: "check", indent: m[1], sym: m[2], gap: m[4], body: m[5] };
  m = left.match(RE_NUM);
  if (m) return { kind: "num", indent: m[1], num: m[2], sep: m[3], gap: m[4], body: m[5] };
  m = left.match(RE_BULLET);
  if (m) return { kind: "bullet", indent: m[1], sym: m[2], gap: m[3], body: m[4] };
  m = left.match(RE_QUOTE);
  if (m) return { kind: "quote", indent: m[1], sym: m[2], gap: "", body: m[3] };
  return null;
}

/// The marker a continued line gets — numbered lines increment.
function markerFor(m) {
  if (m.kind === "num") return m.indent + (Number(m.num) + 1) + m.sep + m.gap;
  if (m.kind === "check") return m.indent + m.sym + " [ ]" + m.gap;
  return m.indent + m.sym + m.gap;
}

/// (value, caret) -> { handled, next, caret, inserted }.
/// `inserted` is non-null only when the edit is a pure insertion at the
/// caret — the one shape execCommand("insertText") can apply as a single
/// native-undo step. Anything else (marker removal, renumbering) falls back
/// to core.setNoteContent.
export function enterEdit(value, pos) {
  const text = String(value ?? "");
  if (typeof pos !== "number" || pos < 0 || pos > text.length) return { handled: false };
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const col = pos - lineStart;
  const left = line.slice(0, col);
  const right = line.slice(col);

  const m = matchMarker(left);
  if (!m) return { handled: false };

  // Enter on an EMPTY item deletes the marker instead of adding a line.
  if (m.body === "" && right === "") {
    return { handled: true, next: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart, inserted: null };
  }

  const inserted = "\n" + markerFor(m);
  let next = text.slice(0, pos) + inserted + text.slice(pos);
  const caret = pos + inserted.length;

  // Numbered items renumber every following sibling until the run breaks.
  if (m.kind === "num") {
    const lines = next.split("\n");
    const lineStartNew = next.lastIndexOf("\n", caret - 1) + 1;
    const lineIdx = next.slice(0, lineStartNew).split("\n").length - 1;
    let n = Number(m.num) + 1;
    for (let i = lineIdx + 1; i < lines.length; i++) {
      const s = lines[i].match(/^(\s*)(\d+)([.)])(\s)/);
      if (!s) break;
      n += 1;
      lines[i] = s[1] + n + s[3] + s[4] + lines[i].slice(s[0].length);
    }
    next = lines.join("\n"); // edits stay after the caret: `caret` still holds
  }

  const pure = text.slice(0, pos) + inserted + text.slice(pos) === next;
  return { handled: true, next, caret, inserted: pure ? inserted : null };
}

// ====================================================== 2. slash commands =
// `/` at line start (only whitespace before it) opens the palette. `foo/`
// never triggers: the trigger regex admits whitespace only before the slash.

export const TABLE_SKELETON = ["| Col 1 | Col 2 | Col 3 |", "| --- | --- | --- |", "|  |  |  |", "|  |  |  |"].join("\n");

/// Every palette row. `insert` is markdown syntax IN (empty when the row
/// only runs an action); `car` is the caret offset inside the insert.
export const SLASH_ITEMS = [
  { id: "h1", label: "Heading 1", hint: "#", kw: "h1 heading big title", insert: "# " },
  { id: "h2", label: "Heading 2", hint: "##", kw: "h2 heading medium", insert: "## " },
  { id: "h3", label: "Heading 3", hint: "###", kw: "h3 heading small", insert: "### " },
  { id: "bullet", label: "Bullet list", hint: "- ", kw: "ul list bullet unordered", insert: "- " },
  { id: "number", label: "Numbered list", hint: "1.", kw: "ol list number ordered", insert: "1. " },
  { id: "checkbox", label: "Checkbox", hint: "- [ ]", kw: "todo task checkbox check", insert: "- [ ] " },
  { id: "quote", label: "Quote", hint: ">", kw: "blockquote quote cite", insert: "> " },
  { id: "code", label: "Code block", hint: "```", kw: "code fence monospace pre", insert: "```\n\n```", car: 4 },
  { id: "divider", label: "Divider", hint: "---", kw: "hr rule separator line", insert: "---\n" },
  {
    id: "table",
    label: "Table 3×3",
    hint: "| |",
    kw: "table grid cells columns rows",
    insert: TABLE_SKELETON,
    car: TABLE_SKELETON.indexOf("|  |") + 2,
  },
  { id: "callout", label: "Callout", hint: "> [!]", kw: "callout note info tip warn", insert: "> [!info] " },
  { id: "toggle", label: "Toggle", hint: "???", kw: "toggle collapse details fold", insert: "??? " },
  { id: "math", label: "Math block", hint: "$$", kw: "math equation formula latex", insert: "$$\n\n$$", car: 3 },
  { id: "image", label: "Image link", hint: "![]()", kw: "image picture photo url", insert: "![alt text](https://)" },
  { id: "diagram", label: "Diagram", hint: "mermaid", kw: "diagram mermaid flow chart", insert: "```mermaid\n\n```", car: 11 },
  { id: "preview", label: "Toggle preview", hint: "view", kw: "preview render read", run: "preview" },
  { id: "toc", label: "Table of contents", hint: "outline", kw: "toc outline headings", run: "toc" },
  { id: "focus", label: "Focus mode", hint: "distraction-free", kw: "focus zen", run: "focus" },
  { id: "typewriter", label: "Typewriter mode", hint: "caret centred", kw: "typewriter scroll", run: "typewriter" },
];

/// Trigger scan: null when the caret is not sitting on a live `/query`.
export function slashState(value, pos) {
  const text = String(value ?? "");
  if (typeof pos !== "number" || pos < 0 || pos > text.length) return null;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const m = before.match(/^(\s*)\/([^\s]*)$/);
  if (!m) return null;
  return { start: lineStart + m[1].length, query: m[2], caret: pos };
}

export function slashMatches(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return SLASH_ITEMS.slice();
  return SLASH_ITEMS.filter((it) => {
    const hay = `${it.id} ${it.label} ${it.kw}`.toLowerCase();
    if (hay.includes(q)) return true;
    return String(it.hint || "").toLowerCase().startsWith(q);
  });
}

// =========================================================== 3. text parse =
// Blocks carry source offsets: preview checkboxes write `[x]` back through
// them, the TOC jumps through them, typewriter mode highlights through them.

export function parseHeadings(text) {
  const out = [];
  let off = 0;
  let inCode = false;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    else if (!inCode) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) out.push({ level: m[1].length, text: m[2].trim(), offset: off });
    }
    off += line.length + 1;
  }
  return out;
}

function isListItem(line) {
  return RE_CHECK.test(line) || RE_NUM.test(line) || RE_BULLET.test(line);
}

function isTableSep(line) {
  return /^\s*\|?[\s:|-]+$/.test(line) && line.includes("-");
}

function isBlockStart(line) {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\?\?\?\s*/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*\$\$\s*$/.test(line) ||
    isListItem(line)
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseListItem(line) {
  let m = line.match(RE_CHECK);
  if (m) return { indent: m[1].length, ordered: false, checked: /\[[xX]\]/.test(m[0]), text: m[5] };
  m = line.match(RE_NUM);
  if (m) return { indent: m[1].length, ordered: true, checked: null, text: m[5] };
  m = line.match(RE_BULLET);
  if (m) return { indent: m[1].length, ordered: false, checked: null, text: m[4] };
  return null;
}

/// Tokenise the plain text into preview blocks (offsets are absolute).
export function parseBlocks(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const starts = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const endOf = (i) => starts[i] + lines[i].length;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```/.test(lines[j])) j++;
      out.push({
        type: "code",
        lang: fence[1] || "",
        text: lines.slice(i + 1, j).join("\n"),
        srcStart: starts[i],
        srcEnd: j < lines.length ? endOf(j) : src.length,
      });
      i = j + 1;
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      out.push({ type: "heading", level: head[1].length, text: head[2], srcStart: starts[i], srcEnd: endOf(i) });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: "hr", srcStart: starts[i], srcEnd: endOf(i) });
      i++;
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push({ type: "table", header, rows, srcStart: starts[i], srcEnd: endOf(j - 1) });
      i = j;
      continue;
    }

    const callout = line.match(/^>\s*\[!([A-Za-z]+)\]\s*(.*)$/);
    if (callout) {
      const body = [callout[2]];
      let j = i + 1;
      while (j < lines.length && /^\s*>/.test(lines[j]) && !/^\s*>\s*\[!/.test(lines[j])) {
        body.push(lines[j].replace(/^\s*>\s?/, ""));
        j++;
      }
      out.push({ type: "callout", kind: callout[1].toLowerCase(), text: body.join("\n"), srcStart: starts[i], srcEnd: endOf(j - 1) });
      i = j;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        body.push(lines[j].replace(/^\s*>\s?/, ""));
        j++;
      }
      out.push({ type: "quote", text: body.join("\n"), srcStart: starts[i], srcEnd: endOf(j - 1) });
      i = j;
      continue;
    }

    const tog = line.match(/^\s*\?\?\?\s*(.*)$/);
    if (tog) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && !isBlockStart(lines[j])) j++;
      out.push({ type: "toggle", title: tog[1], text: lines.slice(i + 1, j).join("\n"), srcStart: starts[i], srcEnd: endOf(j - 1) });
      i = j;
      continue;
    }

    if (/^\s*\$\$\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j])) j++;
      out.push({ type: "math", text: lines.slice(i + 1, j).join("\n"), srcStart: starts[i], srcEnd: j < lines.length ? endOf(j) : src.length });
      i = j + 1;
      continue;
    }

    if (isListItem(line)) {
      const items = [];
      let j = i;
      while (j < lines.length) {
        const it = parseListItem(lines[j]);
        if (!it) break;
        it.srcStart = starts[j];
        items.push(it);
        j++;
      }
      out.push({ type: "list", items, srcStart: starts[i], srcEnd: endOf(j - 1) });
      i = j;
      continue;
    }

    // paragraph — stops at a blank line or the next block starter
    const body = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !isBlockStart(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    out.push({ type: "p", text: body.join("\n"), srcStart: starts[i], srcEnd: endOf(j - 1) });
    i = j;
  }
  return out;
}

// ============================================================== 4. render =
// The ONLY element tags this module may ever create (XSS allowlist).
export const PAINT_TAGS = Object.freeze([
  "DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "STRONG", "EM", "DEL",
  "SPAN", "SUP", "SUB", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
  "HR", "DETAILS", "SUMMARY",
]);

/// The single HTML sink: the ONLY place in this file that assigns innerHTML.
/// Every argument is built by an esc()-based helper (renderInlineHtml, or
/// mathBodyHtml(esc(...))) — the static test enforces one assignment.
function setHtml(el, html) {
  el.innerHTML = html;
}

/// Markdown-in: user text enters the DOM here, already escaped.
function inlineInto(el, text) {
  setHtml(el, renderInlineHtml(text));
}

/// Text-form math: `^{}`/`_{}` become sup/sub and `\frac{a}{b}` a stacked
/// span. NOT KaTeX (no dependencies allowed) — documented as a subset.
export function mathBodyHtml(escaped) {
  return String(escaped ?? "")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '<span class="npdb-frac"><span class="npdb-frac-n">$1</span><span class="npdb-frac-d">$2</span></span>')
    .replace(/\^\{([^{}]*)\}/g, "<sup>$1</sup>")
    .replace(/_\{([^{}]*)\}/g, "<sub>$1</sub>");
}

/// Escape first, then apply markdown. Math segments are stashed so no later
/// rule can reach inside them, and no user byte can form a tag.
export function renderInlineHtml(src) {
  // Private-use sentinel (not a control char — eslint no-control-regex, and
  // no user byte can form a tag): math segments are stashed behind it so no
  // later markdown rule can reach inside them.
  const SEP = "\uE000";
  let s = esc(String(src ?? "")).split(SEP).join("");
  const stash = [];
  s = s.replace(/\$([^$\n]+)\$/g, (m, p) => {
    stash.push(p);
    return SEP + (stash.length - 1) + SEP;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code class="npdb-code">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\uE000(\d+)\uE000/g, (m, i) => `<span class="npdb-math">${mathBodyHtml(stash[Number(i)])}</span>`);
  return s;
}

const CALLOUT_ICON = { info: "ℹ", note: "✎", tip: "✦", warn: "⚠", warning: "⚠", important: "❗" };

function mk(doc, tag, cls) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

function paintListAt(doc, items, i, indent) {
  const list = mk(doc, items[i].ordered ? "ol" : "ul", "npdb-list");
  let lastLi = null;
  while (i < items.length && items[i].indent >= indent) {
    const it = items[i];
    if (it.indent > indent && lastLi) {
      const sub = paintListAt(doc, items, i, it.indent);
      lastLi.appendChild(sub.node);
      i = sub.next;
      continue;
    }
    const li = mk(doc, "li", "npdb-li");
    li.setAttribute("data-off", String(it.srcStart));
    if (it.checked !== null) {
      const cb = mk(doc, "span", it.checked ? "npdb-cb npdb-cb-on" : "npdb-cb");
      cb.setAttribute("data-off", String(it.srcStart));
      cb.textContent = it.checked ? "☑" : "☐";
      li.appendChild(cb);
    }
    inlineInto(li, it.text);
    list.appendChild(li);
    lastLi = li;
    i++;
  }
  return { node: list, next: i };
}

function paintBlock(doc, b) {
  const tagged = (el) => {
    el.setAttribute("data-off", String(b.srcStart));
    return el;
  };
  switch (b.type) {
    case "heading": {
      const el = mk(doc, "h" + Math.min(6, Math.max(1, b.level)), "npdb-h");
      inlineInto(el, b.text);
      return tagged(el);
    }
    case "p": {
      const el = mk(doc, "p", "npdb-p");
      inlineInto(el, b.text);
      return tagged(el);
    }
    case "quote": {
      const el = mk(doc, "blockquote", "npdb-quote");
      setHtml(el, b.text.split("\n").map(renderInlineHtml).join("<br>"));
      return tagged(el);
    }
    case "hr":
      return tagged(mk(doc, "hr", "npdb-hr"));
    case "code": {
      const pre = mk(doc, "pre", b.lang === "mermaid" ? "npdb-diagram" : "npdb-pre");
      const code = mk(doc, "code", "npdb-code");
      code.textContent = b.text; // code is text, never markdown
      pre.appendChild(code);
      return tagged(pre);
    }
    case "math": {
      const el = mk(doc, "div", "npdb-mathblock");
      setHtml(el, mathBodyHtml(esc(b.text)));
      return tagged(el);
    }
    case "callout": {
      const el = mk(doc, "div", "npdb-callout");
      const icon = mk(doc, "span", "npdb-callout-icon");
      icon.textContent = CALLOUT_ICON[b.kind] || CALLOUT_ICON.info;
      const body = mk(doc, "div", "npdb-callout-body");
      setHtml(body, b.text.split("\n").map(renderInlineHtml).join("<br>"));
      el.appendChild(icon);
      el.appendChild(body);
      return tagged(el);
    }
    case "toggle": {
      const el = mk(doc, "details", "npdb-toggle");
      const sum = mk(doc, "summary", "npdb-summary");
      inlineInto(sum, b.title || "Toggle");
      el.appendChild(sum);
      for (const line of b.text.split("\n")) {
        if (line.trim() === "") continue;
        const p = mk(doc, "p", "npdb-p");
        inlineInto(p, line);
        el.appendChild(p);
      }
      return tagged(el);
    }
    case "table": {
      const wrap = mk(doc, "div", "npdb-table-wrap");
      const table = mk(doc, "table", "npdb-table");
      const thead = mk(doc, "thead");
      const trh = mk(doc, "tr");
      for (const c of b.header) {
        const th = mk(doc, "th");
        inlineInto(th, c);
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = mk(doc, "tbody");
      for (const row of b.rows) {
        const tr = mk(doc, "tr");
        for (const c of row) {
          const td = mk(doc, "td");
          inlineInto(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return tagged(wrap);
    }
    case "list":
      return tagged(paintListAt(doc, b.items, 0, b.items[0].indent).node);
    default:
      return null;
  }
}

/// Build preview nodes for a parsed document. Nodes only — no insertion.
export function paintBlocks(blocks, doc) {
  const out = [];
  for (const b of blocks) {
    const node = paintBlock(doc, b);
    if (node) out.push(node);
  }
  return out;
}

/// Flip the checkbox that starts at `lineStart` (preview click → `[x]`).
export function toggleCheckboxAt(text, lineStart) {
  const src = String(text ?? "");
  if (lineStart < 0 || lineStart >= src.length) return src;
  const nl = src.indexOf("\n", lineStart);
  const end = nl === -1 ? src.length : nl;
  const line = src.slice(lineStart, end);
  const m = line.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
  if (!m) return src;
  const next = m[2] === " " ? "x" : " ";
  return src.slice(0, lineStart) + m[1] + next + m[3] + line.slice(m[0].length) + src.slice(end);
}

// ======================================================== 5. find & replace =
// Regex on: wrap the query in slashes (`/colou?r/`) — the `/re/` detection
// from vijay.md task 7, no checkbox UI. Literal mode treats `&` and `$1` as
// plain characters; regex mode expands `$&`, `$1..$9` and `$$`.

export function parseQuery(q) {
  const s = String(q ?? "");
  const m = s.match(/^\/([\s\S]*)\/$/);
  if (m && m[1]) return { re: true, source: m[1] };
  return { re: false, source: s };
}

/// [{start, end, groups?}] — or null when the regex does not compile.
export function findMatches(text, q, re) {
  const src = String(text ?? "");
  if (!q) return [];
  if (!re) {
    const out = [];
    let i = 0;
    while ((i = src.indexOf(q, i)) !== -1) {
      out.push({ start: i, end: i + q.length });
      i += q.length;
    }
    return out;
  }
  let rx;
  try {
    rx = new RegExp(q, "g");
  } catch {
    return null;
  }
  const out = [];
  let m;
  let guard = 0;
  while ((m = rx.exec(src))) {
    if (m[0] === "") {
      rx.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, groups: [...m] });
    if (++guard > 100000) break;
  }
  return out;
}

export function expandRepl(repl, groups) {
  return String(repl ?? "").replace(/\$(\$|&|\d)/g, (m, k) => {
    if (k === "$") return "$";
    if (k === "&") return groups && groups[0] != null ? groups[0] : "";
    const g = groups ? groups[Number(k)] : undefined;
    return g === undefined || g === null ? "" : g;
  });
}

export function applyRepl(match, repl, re) {
  return re ? expandRepl(repl, match.groups) : String(repl ?? "");
}

export function replaceAllText(text, q, repl, re) {
  const src = String(text ?? "");
  const ms = findMatches(src, q, re);
  if (ms === null) return { text: src, count: 0, bad: true };
  if (!ms.length) return { text: src, count: 0 };
  let out = "";
  let last = 0;
  for (const m of ms) {
    out += src.slice(last, m.start) + applyRepl(m, repl, re);
    last = m.end;
  }
  return { text: out + src.slice(last), count: ms.length };
}

/// Index of the match at/after (dir ≥ 0) or before (dir < 0) the caret,
/// wrapping to the other end. -1 = no match at all.
export function matchIndexAt(ms, from, dir) {
  if (!ms || !ms.length) return -1;
  if (dir >= 0) {
    for (let i = 0; i < ms.length; i++) if (ms[i].start >= from) return i;
    return 0;
  }
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].end <= from) return i;
  return ms.length - 1;
}

// ====================================================== 6. version history =
// `saved` events are debounced 5 s; a snapshot is taken only when the text
// actually changed; per-note cap 30; a restore suppresses the snapshot its
// own save would otherwise trigger (no loop).

export const VERSION_CAP = 30;
export const RESTORE_GUARD_MS = 5500;

export function createVersionStore(opts = {}) {
  const cap = opts.cap ?? VERSION_CAP;
  const now = opts.now ?? (() => Date.now());
  const load = opts.load ?? (() => lsGet(LS_VERS, {}));
  const save = opts.save ?? ((v) => lsSet(LS_VERS, v));
  const guardMs = opts.guardMs ?? RESTORE_GUARD_MS;
  let suppressUntil = 0;

  const readAll = () => {
    const s = load();
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  };

  return {
    markRestore() {
      suppressUntil = now() + guardMs;
    },
    record(id, content) {
      if (!id || typeof content !== "string") return false;
      if (now() < suppressUntil) return false; // right after a restore
      const all = readAll();
      const list = Array.isArray(all[id]) ? all[id] : [];
      if (list[0] && list[0].content === content) return false; // nothing new
      list.unshift({ id, ts: now(), content });
      all[id] = list.slice(0, cap);
      save(all);
      return true;
    },
    list(id) {
      const all = readAll();
      return Array.isArray(all[id]) ? all[id] : [];
    },
  };
}

// ============================================================ 7. module UI =
let inited = false;

export function resetForTests() {
  inited = false;
}

function mountOf(core, name) {
  const fallback = { overlay: "npd-overlay", aside: "npd-aside" };
  try {
    const el = core.mount && core.mount(name);
    if (el) return el;
  } catch {}
  if (typeof document !== "undefined" && fallback[name]) {
    try {
      return document.getElementById(fallback[name]);
    } catch {
      return null;
    }
  }
  return null;
}

function viewport() {
  if (typeof window !== "undefined" && window.innerHeight) return window.innerHeight;
  return 800;
}

function rectOf(el) {
  try {
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r && (r.width || r.height || r.top || r.left)) return r;
    }
  } catch {}
  return null;
}

function caretLine(ta) {
  try {
    return (ta.value.slice(0, ta.selectionStart ?? 0).match(/\n/g) || []).length;
  } catch {
    return 0;
  }
}

function lineHeight(ta) {
  try {
    if (typeof getComputedStyle === "function") {
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      if (lh > 4) return lh;
    }
  } catch {}
  return 20;
}

export function initNotepadBlocks(core) {
  if (inited || !core) return null;
  inited = true;

  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) {
    inited = false; // headless: allow a later, real-DOM init
    return null;
  }

  // Own stylesheet, injected inside init (README §2.1).
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = "notepad-blocks.css?v=" + Date.now();
  link.setAttribute("data-npdb", "1");
  (doc.head || doc.documentElement).appendChild(link);

  const versions = createVersionStore();
  const ui = {
    layer: null,
    menu: null,
    menuRows: [],
    menuSel: 0,
    menuQuery: null,
    history: null,
    histRows: [],
    histSel: 0,
    find: null,
    findInput: null,
    replInput: null,
    findStatus: null,
    preview: null,
    toc: null,
    tocRows: [],
    tocSel: 0,
  };
  let pendingSnapshot = null;
  let snapshotTimer = 0;

  const textarea = () => {
    try {
      return core.textarea ? core.textarea() : null;
    } catch {
      return null;
    }
  };
  const activeId = () => {
    try {
      const n = core.activeNote ? core.activeNote() : null;
      return n ? n.id : null;
    } catch {
      return null;
    }
  };
  const currentText = () => {
    const ta = textarea();
    if (ta && typeof ta.value === "string") return ta.value;
    try {
      const n = core.activeNote ? core.activeNote() : null;
      return n ? String(n.content ?? "") : "";
    } catch {
      return "";
    }
  };
  const selection = () => {
    try {
      return core.selection();
    } catch {
      return { start: 0, end: 0, value: "" };
    }
  };

  // ---- per-note sidecar state (tm-notepad-blocks) ----
  function readBlocks() {
    const s = lsGet(LS_BLOCKS, {});
    if (!s || typeof s !== "object") return { ui: {}, notes: {} };
    return { ui: s.ui && typeof s.ui === "object" ? s.ui : {}, notes: s.notes && typeof s.notes === "object" ? s.notes : {} };
  }
  function noteState(id) {
    return readBlocks().notes[id] || {};
  }
  function writeNoteState(id, patch) {
    if (!id) return;
    const all = readBlocks();
    all.notes[id] = Object.assign({}, all.notes[id] || {}, patch);
    lsSet(LS_BLOCKS, all);
  }
  function writeUiState(patch) {
    const all = readBlocks();
    all.ui = Object.assign({}, all.ui, patch);
    lsSet(LS_BLOCKS, all);
  }

  // ---- element helpers (everything prefixed npdb-) ----
  function layer() {
    if (ui.layer) return ui.layer;
    const host = mountOf(core, "overlay");
    if (!host) return null;
    const el = doc.createElement("div");
    el.id = "npdb-layer";
    el.className = "npdb-layer";
    host.appendChild(el);
    ui.layer = el;
    return el;
  }
  function popup(id, cls) {
    const host = layer();
    if (!host) return null;
    const el = doc.createElement("div");
    el.id = id;
    el.className = cls;
    el.hidden = true;
    host.appendChild(el);
    return el;
  }

  // ------------------------------------------------------ slash palette --
  function menu() {
    if (ui.menu) return ui.menu;
    ui.menu = popup("npdb-menu", "npdb-menu");
    if (!ui.menu) return null;
    ui.menu.setAttribute("role", "listbox");
    // keep the textarea focused: a mousedown in the menu must not steal it
    ui.menu.addEventListener("mousedown", (ev) => ev.preventDefault());
    return ui.menu;
  }

  function closeSlash() {
    ui.menuQuery = null;
    ui.menuRows = [];
    ui.menuSel = 0;
    if (ui.menu) ui.menu.hidden = true;
  }

  function placeMenu(ta) {
    if (!ui.menu || !ta) return;
    const r = rectOf(ta);
    if (!r) return;
    const top = r.top + (caretLine(ta) + 1) * lineHeight(ta) - (ta.scrollTop || 0) + 6;
    ui.menu.style.left = Math.round(r.left + 8) + "px";
    ui.menu.style.top = Math.round(Math.max(4, Math.min(top, viewport() - 40))) + "px";
  }

  function renderMenu(items, sel) {
    const m = menu();
    if (!m) return;
    m.textContent = "";
    ui.menuRows = [];
    if (!items.length) {
      const e = doc.createElement("div");
      e.className = "npdb-menu-empty";
      e.textContent = "No matching blocks";
      m.appendChild(e);
      m.hidden = false;
      return;
    }
    items.forEach((it, idx) => {
      const row = doc.createElement("div");
      row.className = "npdb-menu-row" + (idx === sel ? " is-active" : "");
      row.setAttribute("role", "option");
      const label = doc.createElement("span");
      label.className = "npdb-menu-label";
      label.textContent = it.label;
      const hint = doc.createElement("span");
      hint.className = "npdb-menu-hint";
      hint.textContent = it.hint || "";
      row.appendChild(label);
      row.appendChild(hint);
      row.addEventListener("mousedown", (ev) => ev.preventDefault());
      row.addEventListener("click", () => {
        ui.menuSel = idx;
        commitSlash();
      });
      m.appendChild(row);
      ui.menuRows.push(row);
    });
    m.hidden = false;
  }

  function updateSlash() {
    const ta = textarea();
    if (!ta) return closeSlash();
    const st = slashState(ta.value, ta.selectionStart ?? ta.value.length);
    if (!st) return closeSlash();
    if (ui.menuQuery === null) ui.menuSel = 0;
    ui.menuQuery = st.query;
    const items = slashMatches(st.query);
    if (ui.menuSel >= items.length) ui.menuSel = 0;
    renderMenu(items, ui.menuSel);
    placeMenu(ta);
  }

  function runAction(name) {
    if (name === "preview") togglePreview();
    else if (name === "toc") toggleToc();
    else if (name === "focus") togglePanelClass("npdb-focus");
    else if (name === "typewriter") togglePanelClass("npdb-typewriter");
  }

  /// Replace the live `/query` with the row's syntax (contract write path).
  function commitSlash() {
    const ta = textarea();
    const before = currentText();
    const st = slashState(before, ta ? ta.selectionStart ?? 0 : 0);
    if (!st) return closeSlash();
    const items = slashMatches(st.query);
    const item = items[ui.menuSel];
    closeSlash();
    if (!item) return;

    const text = item.insert || "";
    const expected = before.slice(0, st.start) + text + before.slice(st.caret);
    core.setSelection(st.start, st.caret);
    if (text) {
      core.insertAtCursor(text); // replaces the live selection
    } else if (typeof doc.execCommand === "function") {
      try {
        doc.execCommand("delete");
      } catch {}
    }
    // Defensive: if core's insert did NOT replace the range, heal through
    // the contract rather than touching the textarea ourselves.
    if (currentText() !== expected && activeId()) core.setNoteContent(activeId(), expected);
    const caret = st.start + (item.car != null ? item.car : text.length);
    core.setSelection(caret, caret);
    if (item.run) runAction(item.run);
    afterWrite();
  }

  // ---------------------------------------------------------- preview ----
  function ensurePreview() {
    if (ui.preview) return ui.preview;
    const host = layer();
    if (!host) return null;
    const el = doc.createElement("div");
    el.id = "npdb-preview";
    el.className = "npdb-preview";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Note preview");
    el.hidden = true;
    // Preview is a view: clicks must not move focus out of the textarea or
    // the panel's keydown pipeline (Esc, chords) would go dead.
    el.addEventListener("mousedown", (ev) => ev.preventDefault());
    el.addEventListener("click", onPreviewClick);
    host.appendChild(el);
    ui.preview = el;
    return el;
  }

  function positionPreview() {
    const el = ui.preview;
    if (!el || el.hidden) return;
    const r = rectOf(textarea());
    if (!r) return;
    // Fixed over the editor's own rect: no dependency on Govinda's layout,
    // and nothing else in the panel shifts.
    el.style.position = "fixed";
    el.style.left = Math.round(r.left) + "px";
    el.style.top = Math.round(r.top) + "px";
    el.style.width = Math.round(r.width) + "px";
    el.style.height = Math.round(r.height) + "px";
  }

  function onPreviewClick(ev) {
    let node = ev.target;
    let off = null;
    // walk up to the nearest data-off holder (the checkbox span)
    for (let hops = 0; node && hops < 6; hops++) {
      if (node.getAttribute) {
        const v = node.getAttribute("data-off");
        if (v !== null && node.className && String(node.className).includes("npdb-cb")) {
          off = Number(v);
          break;
        }
      }
      node = node.parentNode;
    }
    if (off === null || Number.isNaN(off)) return;
    const id = activeId();
    if (!id) return;
    const next = toggleCheckboxAt(currentText(), off);
    if (next === currentText()) return;
    core.setNoteContent(id, next); // writes back `[x]` / `[ ]`
    afterWrite();
  }

  function renderPreview() {
    const el = ensurePreview();
    if (!el || el.hidden) return;
    positionPreview();
    const blocks = parseBlocks(currentText());
    const nodes = paintBlocks(blocks, doc);
    el.textContent = "";
    for (const n of nodes) el.appendChild(n);
    markTypewriterPreview(blocks, nodes);
  }

  function togglePreview(force) {
    const el = ensurePreview();
    if (!el) return false;
    const on = force != null ? !!force : el.hidden;
    el.hidden = !on;
    const id = activeId();
    if (id) writeNoteState(id, { preview: on });
    if (on) renderPreview();
    else {
      const ta = textarea();
      if (ta) ta.focus && ta.focus();
    }
    afterWrite();
    return on;
  }

  // -------------------------------------------------------------- TOC ----
  function ensureToc() {
    if (ui.toc) return ui.toc;
    const host = mountOf(core, "aside");
    if (!host) return null;
    const el = doc.createElement("div");
    el.id = "npdb-toc";
    el.className = "npdb-toc";
    el.hidden = true;
    el.setAttribute("role", "navigation");
    el.setAttribute("aria-label", "Table of contents");
    host.appendChild(el);
    ui.toc = el;
    return el;
  }

  function tocHeadings() {
    return parseHeadings(currentText()).filter((h) => h.level <= 3);
  }

  function renderToc() {
    const el = ensureToc();
    if (!el || el.hidden) return;
    const hs = tocHeadings();
    el.textContent = "";
    ui.tocRows = [];
    const title = doc.createElement("div");
    title.className = "npdb-toc-title";
    title.textContent = "On this page";
    el.appendChild(title);
    if (!hs.length) {
      const e = doc.createElement("div");
      e.className = "npdb-toc-empty";
      e.textContent = "No headings yet — type # to add one.";
      el.appendChild(e);
      return;
    }
    if (ui.tocSel >= hs.length) ui.tocSel = 0;
    hs.forEach((h, idx) => {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "npdb-toc-row level-" + h.level + (idx === ui.tocSel ? " is-active" : "");
      row.setAttribute("data-npdb-own", "1");
      row.setAttribute("data-off", String(h.offset));
      row.textContent = h.text;
      row.addEventListener("mousedown", (ev) => ev.preventDefault());
      row.addEventListener("click", () => {
        ui.tocSel = idx;
        jumpTo(h.offset);
      });
      el.appendChild(row);
      ui.tocRows.push(row);
    });
    // NOTE: no highlightToc() here — renderToc() must paint ui.tocSel as-is,
    // or an arrow-key selection would be clobbered by the caret's position
    // (found by tests/notepad-blocks.test.mjs). Callers that open the TOC
    // call highlightToc() themselves to sync it to the caret.
  }

  function jumpTo(offset) {
    const ta = textarea();
    core.setSelection(offset, offset);
    if (ta) {
      const line = caretLine(ta);
      const target = line * lineHeight(ta) - (ta.clientHeight || 400) / 2;
      if (target > 0 || (ta.scrollTop || 0) > 0) ta.scrollTop = Math.max(0, target);
      ta.focus && ta.focus();
    }
    highlightToc();
    if (ui.preview && !ui.preview.hidden) renderPreview();
  }

  function highlightToc() {
    if (!ui.toc || ui.toc.hidden || !ui.tocRows.length) return;
    const pos = selection().start;
    const hs = tocHeadings();
    let active = 0;
    for (let i = 0; i < hs.length; i++) if (hs[i].offset <= pos) active = i;
    ui.tocSel = active;
    ui.tocRows.forEach((r, i) => {
      if (i === active) r.classList.add("is-active");
      else r.classList.remove("is-active");
    });
  }

  function toggleToc(force) {
    const el = ensureToc();
    if (!el) return false;
    const on = force != null ? !!force : el.hidden;
    el.hidden = !on;
    const id = activeId();
    if (id) writeNoteState(id, { toc: on });
    if (on) {
      renderToc();
      highlightToc(); // opening syncs the active row to the caret
    }
    return on;
  }

  // ------------------------------------------------- focus / typewriter --
  function panelEl() {
    try {
      if (typeof core.panel === "function") {
        const p = core.panel();
        if (p) return p;
      }
    } catch {}
    return null;
  }

  function togglePanelClass(cls) {
    const p = panelEl();
    if (!p) return false;
    const on = !p.classList.contains(cls);
    if (on) p.classList.add(cls);
    else p.classList.remove(cls);
    if (cls === "npdb-typewriter") applyTypewriterPlain();
    writeUiState({ [cls === "npdb-focus" ? "focus" : "typewriter"]: on });
    return on;
  }

  /// Plain mode: centre the caret's line in the textarea. A textarea cannot
  /// dim individual lines, so per-line dimming lives in preview mode only
  /// (documented scope in docs/notepad/vijay.md).
  function applyTypewriterPlain() {
    const p = panelEl();
    const ta = textarea();
    if (!p || !ta || !p.classList.contains("npdb-typewriter")) return;
    if (ui.preview && !ui.preview.hidden) return;
    const lh = lineHeight(ta);
    const target = caretLine(ta) * lh - (ta.clientHeight || 400) / 2 + lh / 2;
    ta.scrollTop = Math.max(0, target);
  }

  function markTypewriterPreview(blocks, nodes) {
    const p = panelEl();
    if (!p || !p.classList.contains("npdb-typewriter")) return;
    const pos = selection().start;
    let active = 0;
    for (let i = 0; i < blocks.length; i++) if (blocks[i].srcStart <= pos) active = i;
    nodes.forEach((n, i) => {
      if (i === active) {
        n.classList.add("npdb-type-active");
        n.classList.remove("npdb-type-dim");
        try {
          n.scrollIntoView({ block: "center" });
        } catch {}
      } else {
        n.classList.add("npdb-type-dim");
        n.classList.remove("npdb-type-active");
      }
    });
  }

  // ---------------------------------------------------- find & replace ---
  function ensureFind() {
    if (ui.find) return ui.find;
    const host = layer();
    if (!host) return null;
    const bar = doc.createElement("div");
    bar.id = "npdb-replace";
    bar.className = "npdb-replace";
    bar.hidden = true;

    const find = doc.createElement("input");
    find.type = "text";
    find.className = "npdb-find";
    find.placeholder = "Find — /re/ for regex";
    find.setAttribute("aria-label", "Find in note");
    find.setAttribute("data-npdb-own", "1");

    const repl = doc.createElement("input");
    repl.type = "text";
    repl.className = "npdb-repl";
    repl.placeholder = "Replace with";
    repl.setAttribute("aria-label", "Replace with");
    repl.setAttribute("data-npdb-own", "1");

    const status = doc.createElement("span");
    status.className = "npdb-replace-status";

    const mkBtn = (txt, cls, fn) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "npdb-btn " + cls;
      b.textContent = txt;
      b.setAttribute("data-npdb-own", "1");
      b.addEventListener("click", fn);
      return b;
    };

    bar.appendChild(find);
    bar.appendChild(repl);
    bar.appendChild(status);
    bar.appendChild(mkBtn("Replace", "npdb-btn-replace", () => replaceOne()));
    bar.appendChild(mkBtn("All", "npdb-btn-all", () => replaceAll()));
    bar.appendChild(mkBtn("×", "npdb-btn-close", () => closeFind()));
    host.appendChild(bar);

    find.addEventListener("input", updateFindStatus);
    find.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        step(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeFind();
      }
    });
    repl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeFind();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) replaceAll();
        else if (ev.shiftKey) step(-1);
        else replaceOne();
      }
    });
    ui.find = bar;
    ui.findInput = find;
    ui.replInput = repl;
    ui.findStatus = status;
    return bar;
  }

  function query() {
    return parseQuery(ui.findInput.value);
  }

  function matches() {
    const p = query();
    return findMatches(currentText(), p.source, p.re);
  }

  function updateFindStatus() {
    if (!ui.findStatus) return;
    if (!ui.findInput.value) {
      ui.findStatus.textContent = "";
      return;
    }
    const ms = matches();
    if (ms === null) {
      ui.findStatus.textContent = "bad regex";
      return;
    }
    ui.findStatus.textContent = `${ms.length} match${ms.length === 1 ? "" : "es"}${query().re ? " · regex" : ""}`;
  }

  function positionFind() {
    const r = rectOf(textarea());
    if (!r || !ui.find) return;
    ui.find.style.left = Math.round(r.left) + "px";
    ui.find.style.width = Math.round(r.width) + "px";
    ui.find.style.bottom = Math.max(4, Math.round(viewport() - r.bottom)) + "px";
  }

  function step(dir) {
    const ms = matches();
    if (ms === null) return updateFindStatus();
    if (!ms.length) {
      updateFindStatus();
      if (core.toast) core.toast("No matches", "info", 1800);
      return;
    }
    const sel = selection();
    const idx = Math.max(0, matchIndexAt(ms, dir >= 0 ? sel.end : sel.start, dir));
    const m = ms[idx];
    core.setSelection(m.start, m.end);
    ui.findStatus.textContent = `${idx + 1} / ${ms.length}${query().re ? " · regex" : ""}`;
    if (ui.findInput.focus) ui.findInput.focus();
  }

  function replaceOne() {
    const ms = matches();
    if (ms === null || !ms.length) return updateFindStatus();
    const p = query();
    const sel = selection();
    let idx = ms.findIndex((m) => m.start === sel.start && m.end === sel.end);
    if (idx < 0) {
      // First press on a fresh query selects the match; the next replaces it.
      const i = Math.max(0, matchIndexAt(ms, sel.start, 1));
      core.setSelection(ms[i].start, ms[i].end);
      updateFindStatus();
      return;
    }
    const m = ms[idx];
    const src = currentText();
    const next = src.slice(0, m.start) + applyRepl(m, ui.replInput.value, p.re) + src.slice(m.end);
    const id = activeId();
    if (id) core.setNoteContent(id, next);
    afterWrite();
    const after = matches();
    if (after && after.length) {
      const nIdx = Math.min(idx, after.length - 1);
      core.setSelection(after[nIdx].start, after[nIdx].end);
    }
    updateFindStatus();
  }

  function replaceAll() {
    const p = query();
    const res = replaceAllText(currentText(), p.source, ui.replInput.value, p.re);
    if (res.bad) {
      updateFindStatus();
      if (core.toast) core.toast("Bad regex", "error", 2200);
      return;
    }
    if (!res.count) {
      if (core.toast) core.toast("No matches", "info", 1800);
      return;
    }
    // ONE contract write. Native undo after a programmatic value write is
    // core's call — documented in docs/notepad/vijay.md "Behavior added".
    const id = activeId();
    if (id) core.setNoteContent(id, res.text);
    afterWrite();
    updateFindStatus();
    if (core.toast) core.toast(`Replaced ${res.count}`, "success", 1800);
  }

  function openFind() {
    const bar = ensureFind();
    if (!bar) return false;
    positionFind();
    bar.hidden = false;
    if (ui.findInput.focus) ui.findInput.focus();
    if (ui.findInput.select) ui.findInput.select();
    updateFindStatus();
    return true;
  }

  function closeFind() {
    if (!ui.find || ui.find.hidden) return false;
    ui.find.hidden = true;
    const ta = textarea();
    if (ta) ta.focus && ta.focus();
    return true;
  }

  const findIsOpen = () => !!(ui.find && !ui.find.hidden);
  const slashIsOpen = () => !!(ui.menu && !ui.menu.hidden);
  const historyIsOpen = () => !!(ui.history && !ui.history.hidden);
  const tocIsOpen = () => !!(ui.toc && !ui.toc.hidden);
  const previewIsOpen = () => !!(ui.preview && !ui.preview.hidden);

  // -------------------------------------------------- version history ----
  function ensureHistory() {
    if (ui.history) return ui.history;
    const host = layer();
    if (!host) return null;
    const el = doc.createElement("div");
    el.id = "npdb-history";
    el.className = "npdb-history";
    el.hidden = true;
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-label", "Version history");
    host.appendChild(el);
    ui.history = el;
    return el;
  }

  function positionHistory() {
    const el = ui.history;
    if (!el || el.hidden) return;
    const r = rectOf(textarea());
    if (!r) return;
    el.style.position = "fixed";
    el.style.top = Math.round(r.top) + "px";
    el.style.height = Math.round(r.height) + "px";
    el.style.left = Math.round(Math.max(4, r.right - 320)) + "px";
    el.style.width = "316px";
  }

  function renderHistory() {
    const el = ensureHistory();
    if (!el || el.hidden) return;
    const id = activeId();
    const list = id ? versions.list(id) : [];
    el.textContent = "";
    ui.histRows = [];
    const title = doc.createElement("div");
    title.className = "npdb-hist-title";
    title.textContent = "Version history";
    el.appendChild(title);
    if (!list.length) {
      const e = doc.createElement("div");
      e.className = "npdb-hist-empty";
      e.textContent = "No earlier versions yet — a snapshot is taken 5 s after a save.";
      el.appendChild(e);
      return;
    }
    if (ui.histSel >= list.length) ui.histSel = 0;
    list.forEach((v, idx) => {
      const row = doc.createElement("div");
      row.className = "npdb-hist-row" + (idx === ui.histSel ? " is-active" : "");
      row.setAttribute("role", "option");
      const time = doc.createElement("span");
      time.className = "npdb-hist-time";
      try {
        time.textContent = new Date(v.ts).toLocaleString();
      } catch {
        time.textContent = String(v.ts);
      }
      const snip = doc.createElement("span");
      snip.className = "npdb-hist-snip";
      snip.textContent = String(v.content || "").split("\n").slice(0, 2).join(" ").slice(0, 80) || "(empty)";
      row.appendChild(time);
      row.appendChild(snip);
      row.addEventListener("mousedown", (ev) => ev.preventDefault());
      row.addEventListener("click", () => {
        ui.histSel = idx;
        restoreSelected();
      });
      el.appendChild(row);
      ui.histRows.push(row);
    });
  }

  function restoreSelected() {
    const id = activeId();
    const list = id ? versions.list(id) : [];
    const v = list[ui.histSel];
    if (!id || !v) return;
    versions.markRestore(); // the save this triggers must not snapshot back
    core.setNoteContent(id, v.content);
    afterWrite();
    renderHistory();
    if (core.toast) core.toast("Version restored", "success", 1800);
  }

  function openHistory() {
    const el = ensureHistory();
    if (!el) return false;
    if (!el.hidden) {
      el.hidden = true;
      return false;
    }
    ui.histSel = 0;
    el.hidden = false;
    positionHistory();
    renderHistory();
    return true;
  }

  function closeHistory() {
    if (!ui.history || ui.history.hidden) return false;
    ui.history.hidden = true;
    return true;
  }

  function historyKey(ev) {
    const rows = ui.histRows;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeHistory();
      return true;
    }
    if (!rows.length) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      ui.histSel = (ui.histSel + (ev.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      renderHistory();
      return true;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      restoreSelected();
      return true;
    }
    return false;
  }

  function tocKey(ev) {
    const rows = ui.tocRows;
    if (ev.key === "Escape") {
      ev.preventDefault();
      toggleToc(false);
      return true;
    }
    if (!rows.length) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      ui.tocSel = (ui.tocSel + (ev.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      renderToc();
      return true;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const hs = tocHeadings();
      if (hs[ui.tocSel]) jumpTo(hs[ui.tocSel].offset);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ writes ---
  /// Apply an Enter-rule edit: execCommand first (native undo survives),
  /// contract write otherwise. NEVER a direct value assignment.
  function applyEnter(ev, edit) {
    const ta = textarea();
    let ok = false;
    if (edit.inserted != null && ta && typeof doc.execCommand === "function") {
      try {
        if (ta.focus) ta.focus();
        ok = doc.execCommand("insertText", false, edit.inserted);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      const id = activeId();
      if (id) core.setNoteContent(id, edit.next);
    }
    core.setSelection(edit.caret, edit.caret);
    if (ev) ev.preventDefault();
    afterWrite();
  }

  /// setNoteContent does not fire an `input` event (core writes the value
  /// directly), so every contract write is followed by an explicit refresh.
  function afterWrite() {
    updateSlash();
    refreshViews();
    applyTypewriterPlain();
    if (historyIsOpen()) renderHistory();
  }

  function refreshViews() {
    if (previewIsOpen()) renderPreview();
    if (tocIsOpen()) {
      renderToc();
      highlightToc();
    }
  }

  // ---------------------------------------------------------- listeners --
  function onInput() {
    afterWrite();
  }

  function onCaretMove() {
    highlightToc();
    applyTypewriterPlain();
    // A full preview re-render would collapse open <details>, so only the
    // typewriter view (which needs the active block) re-renders here.
    if (previewIsOpen() && panelEl() && panelEl().classList.contains("npdb-typewriter")) renderPreview();
  }

  function onKeydown(ev) {
    if (ev.defaultPrevented) return;
    const t = ev.target;
    const own = !!(t && t.dataset && t.dataset.npdbOwn);
    const ta = textarea();
    const inEditor = !!ta && t === ta;

    // Chords I own (README §2.5): claimed through the relay only.
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      const k = String(ev.key || "").toLowerCase();
      if (k === "h") {
        ev.preventDefault();
        if (findIsOpen()) closeFind();
        else openFind();
        return;
      }
      if (k === "v") {
        ev.preventDefault();
        if (historyIsOpen()) closeHistory();
        else openHistory();
        return;
      }
    }

    // Widgets keep focus in the textarea, so they are driven from here.
    if (slashIsOpen() && inEditor) {
      const items = slashMatches(ui.menuQuery || "");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (items.length) {
          ui.menuSel = (ui.menuSel + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
          renderMenu(items, ui.menuSel);
        }
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        commitSlash();
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeSlash();
        return;
      }
    }
    if (historyIsOpen() && (inEditor || own) && historyKey(ev)) return;
    if (tocIsOpen() && (inEditor || own) && tocKey(ev)) return;
    if (findIsOpen() && ev.key === "Escape" && (inEditor || own)) {
      ev.preventDefault();
      closeFind();
      return;
    }
    if (own) return; // my inputs handled their own keys already

    if (previewIsOpen() && ev.key === "Escape" && inEditor) {
      ev.preventDefault();
      togglePreview(false);
      return;
    }

    // Auto-list continuation — a plain Enter in the editor only.
    if (ev.key === "Enter" && inEditor && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      const sel = selection();
      if (sel.start !== sel.end) return;
      const edit = enterEdit(ta.value, sel.start);
      if (edit.handled) applyEnter(ev, edit);
    }
  }

  function onSaved(d) {
    const id = d && d.id ? d.id : activeId();
    if (!id) return;
    pendingSnapshot = id;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = 0;
      const want = pendingSnapshot;
      pendingSnapshot = null;
      if (!want) return;
      let content = null;
      try {
        const all = core.allNotes ? core.allNotes() : {};
        if (all[want]) content = String(all[want].content ?? "");
      } catch {}
      if (content === null) return;
      versions.record(want, content);
    }, 5000);
    // never hold a test process (or a quit) open on this timer
    if (snapshotTimer && typeof snapshotTimer === "object" && snapshotTimer.unref) snapshotTimer.unref();
  }

  function onNote() {
    closeSlash();
    ui.tocSel = 0;
    ui.histSel = 0;
    const id = activeId();
    const st = id ? noteState(id) : {};
    if (ui.preview) ui.preview.hidden = !st.preview;
    if (ui.toc) ui.toc.hidden = !st.toc;
    if (historyIsOpen()) renderHistory();
    refreshViews();
  }

  function onOpen() {
    const st = readBlocks().ui;
    const p = panelEl();
    if (p) {
      if (st.focus) p.classList.add("npdb-focus");
      if (st.typewriter) p.classList.add("npdb-typewriter");
    }
    refreshViews();
    applyTypewriterPlain();
  }

  // Keydown relay (README §2.2): core runs its own map only when no peer
  // preventDefaulted first, so claiming a chord here is enough.
  try {
    core.on("keydown", onKeydown);
    core.on("note", onNote);
    core.on("saved", onSaved);
    core.on("open", onOpen);
  } catch {}

  const ta0 = textarea();
  if (ta0 && ta0.addEventListener) {
    ta0.addEventListener("input", onInput);
    ta0.addEventListener("click", onCaretMove);
    ta0.addEventListener("keyup", onCaretMove);
    ta0.addEventListener("blur", () => closeSlash());
    ta0.addEventListener("scroll", () => {
      positionPreview();
      applyTypewriterPlain();
    });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", () => {
      positionPreview();
      positionHistory();
      if (findIsOpen()) positionFind();
      if (slashIsOpen()) {
        const ta = textarea();
        if (ta) placeMenu(ta);
      }
    });
  }

  // Peers load BEFORE core fires "open"/"note" (notepad.js loadPeers), so
  // this catches the already-active note either way.
  onNote();

  return {
    enterEdit,
    slashState,
    slashMatches,
    commitSlash,
    togglePreview,
    toggleToc,
    togglePanelClass,
    openFind,
    closeFind,
    openHistory,
    closeHistory,
    runAction,
    refreshViews,
    renderPreview,
    renderToc,
    renderHistory,
    versions,
    ui,
  };
}
