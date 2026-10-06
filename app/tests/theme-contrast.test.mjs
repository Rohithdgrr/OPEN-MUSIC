// theme-contrast.test.mjs — dark-mode cascade invariant for styles.css.
//
// WHY THIS EXISTS (a real shipped bug, not a hypothetical):
//   `.dark .soc-btn-solid` painted the room buttons white and set `color:#000`,
//   but `.dark .soc-btn` sat LATER in the file at the SAME specificity and set
//   `color:#fff`. Later wins, so "Join room", "Open room" and "Copy invite"
//   rendered as white text on a white pill. Measured in headless Chrome:
//   contrast 1.0, and reported by the user as "not properly visible".
//
//   Note that "the variant declares its own colour" is NECESSARY BUT NOT
//   SUFFICIENT. The variant did declare `color:#000` and still lost. What fails
//   is resolving the cascade: the winning background and the winning colour
//   come from DIFFERENT rules.
//
// So this gate simulates the cascade per real element - highest specificity,
// then latest in the file - and requires the resolved pair to be readable.
// A static check cannot see an image backdrop, so anything layered over
// artwork is skipped here and left to the browser audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const css = fs.readFileSync(path.join(src, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(src, "index.html"), "utf8");

/// Parse top-level rules into { selectors, decls, line }. Handles the grouped
/// multi-line form this file uses heavily:
///   `.dark .soc-btn-solid,`
///   `html.dark .soc-btn-solid {`
function parseRules(text) {
  const rules = [];
  const lines = text.split(/\r?\n/);
  let sels = [];
  let decls = [];
  let startLine = 0;
  const flush = (endLine) => {
    if (!sels.length) return;
    rules.push({ selectors: sels, decls: decls.join(" ").trim(), line: startLine, endLine });
    sels = [];
    decls = [];
    startLine = 0;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("/*") || line.startsWith("*") || line.startsWith("//")) return;
    if (line.endsWith(",")) {
      sels.push(line.slice(0, -1).trim());
      if (!startLine) startLine = i + 1;
      return;
    }
    if (line.includes("{")) {
      const braceAt = line.indexOf("{");
      const pre = line.slice(0, braceAt);
      const post = line.slice(braceAt + 1);
      if (!sels.length) startLine = i + 1;
      for (const s of pre.split(",")) if (s.trim()) sels.push(s.trim());
      if (post.includes("}")) {
        rules.push({ selectors: sels, decls: post.split("}")[0].trim(), line: startLine, endLine: i + 1 });
        sels = [];
        decls = [];
        startLine = 0;
      } else {
        decls.push(post);
      }
      return;
    }
    if (line === "}") {
      flush(i + 1);
      return;
    }
    if (sels.length) decls.push(line);
  });
  flush(lines.length);
  return rules;
}

const RULES = parseRules(css);
assert.ok(
  RULES.length > 500,
  `styles.css must parse into many rules (got ${RULES.length}) - a parser regression would silently pass every check below`,
);

const decl = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:([^;}]+)`, "i"));
  return m ? m[1].trim() : null;
};
const hasDecl = (body, prop) => new RegExp(`(?:^|[;{\\s])${prop}\\s*:`, "i").test(body);
const isDarkRule = (sel) => /(^|[\s,])(?:\.dark|html\.dark)\b/.test(sel);

/// Specificity, approximated to what matters here: id / class+pseudo / element.
/// `:not(.x)` contributes its argument's specificity, per spec.
function specificity(sel) {
  const noNot = sel.replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (noNot.match(/#[\w-]+/g) || []).length;
  const classes = (noNot.match(/\.[\w-]+/g) || []).length;
  const tags = (noNot.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  const pseudo = (noNot.match(/:(?!not\()[a-z-]+/gi) || []).length;
  return ids * 10000 + (classes + pseudo) * 100 + tags;
}

/// Classes a selector requires of the element it targets (its own compound,
/// not its ancestors). A descendant selector like `.dark .card .x` targets an
/// element carrying `.x`; the ancestor classes are not required of it.
function ownClasses(sel) {
  const last = sel.trim().split(/\s+|>/).pop() || "";
  if (last.includes("::")) return [];
  return (last.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1));
}

/// The interaction state a selector targets. Rules for different states never
/// both apply, so they must never be compared against each other.
const stateOf = (sel) => {
  if (/:hover/.test(sel)) return "hover";
  if (/:active/.test(sel)) return "active";
  if (/:focus/.test(sel)) return "focus";
  return "resting";
};

const darkRules = [];
RULES.forEach((r, idx) => {
  r.selectors.forEach((sel) => {
    if (!isDarkRule(sel)) return;
    darkRules.push({
      idx,
      line: r.line,
      sel,
      classes: ownClasses(sel),
      specificity: specificity(sel),
      state: stateOf(sel),
      body: r.decls,
      setsBg: hasDecl(r.decls, "background") || hasDecl(r.decls, "background-color"),
      setsColor: hasDecl(r.decls, "color"),
    });
  });
});

// --- colour maths -----------------------------------------------------------
function parseColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { a: 0 };
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    const exp = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    return {
      r: parseInt(exp.slice(0, 2), 16),
      g: parseInt(exp.slice(2, 4), 16),
      b: parseInt(exp.slice(4, 6), 16),
      a: exp.length >= 8 ? parseInt(exp.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
const luminance = ({ r, g, b }) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/// Real class-sets that appear in the markup, so the check is about elements
/// that exist rather than every selector in the file.
const elementClasses = new Set();
for (const m of html.matchAll(/<[a-z][^>]*\sclass="([^"]*)"/g)) {
  const list = m[1].split(/\s+/).filter(Boolean);
  if (list.length) elementClasses.add(list.join(" "));
  for (const c of list) elementClasses.add(c);
}

function resolvesTo(elementClassSet, prop, state) {
  let winner = null;
  for (const r of darkRules) {
    if (!r.classes.length) continue;
    if (!r.classes.every((c) => elementClassSet.split(" ").includes(c))) continue;
    if (r.state !== state) continue;
    if (prop === "bg" ? !r.setsBg : !r.setsColor) continue;
    const better =
      !winner || r.specificity > winner.specificity || (r.specificity === winner.specificity && r.idx > winner.idx);
    if (better) winner = r;
  }
  return winner;
}

test("the parser and markup extraction are non-trivial (otherwise the checks are vacuous)", () => {
  assert.ok(darkRules.length > 100, `expected a large dark-theme override layer, found ${darkRules.length}`);
  assert.ok(elementClasses.size > 100, `expected many classed elements, found ${elementClasses.size}`);
  // The exact regression must be detectable: before the fix, these resolved to
  // a white background and a white colour.
  const set = "soc-btn soc-btn-solid";
  const bg = resolvesTo(set, "bg", "resting");
  const fg = resolvesTo(set, "color", "resting");
  assert.ok(bg && fg, "both the background and the colour must resolve for .soc-btn.soc-btn-solid");
});

test("every dark-theme element resolves to a readable colour pair", () => {
  // Resolve the cascade the way the browser does and check the pair that wins.
  // Elements over artwork, or whose background is translucent or an image, are
  // skipped: no static reading can judge those, and the browser audit does.
  const failures = [];
  for (const cls of elementClasses) {
    if (!cls.includes(" ")) continue; // single classes still resolved; skip empties
    const bgRule = resolvesTo(cls, "bg", "resting");
    const fgRule = resolvesTo(cls, "color", "resting");
    if (!bgRule || !fgRule) continue;
    const bgRaw = decl(bgRule.body, "background") || decl(bgRule.body, "background-color");
    if (bgRaw && /gradient|url\(/.test(bgRaw)) continue; // layered, not judgeable
    const bg = parseColor(bgRaw);
    const fg = parseColor(decl(fgRule.body, "color"));
    if (!bg || !fg) continue;
    if (bg.a === 0 || bg.a < 0.85 || fg.a < 0.85) continue; // translucent
    const ratio = contrast(fg, bg);
    if (ratio >= 4.5) continue;
    failures.push(
      `.${cls.replace(/\s+/g, ".")}\n      colour ${decl(fgRule.body, "color")} from styles.css:${fgRule.line} ${fgRule.sel}` +
        `\n      background ${bgRaw} from styles.css:${bgRule.line} ${bgRule.sel}\n      = ${ratio.toFixed(2)}:1, needs 4.5:1`,
    );
  }
  assert.deepEqual(failures, [], "unreadable dark-theme elements:\n      " + failures.join("\n      "));
});

test("the reported controls ship with the classes the fix depends on", () => {
  // Ties the invariant to the actual report: if these ids/classes change, the
  // selectors under test stop being about these buttons.
  for (const [id, cls] of [
    ["btn-room-join", "soc-btn-solid"],
    ["btn-open-room", "soc-btn-solid"],
    ["btn-copy-invite", "soc-btn-solid"],
    ["btn-leave-room", "soc-btn-danger"],
  ]) {
    const tag = html.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tag, `#${id} must exist as a <button> in index.html`);
    const m = tag[0].match(/class="([^"]*)"/);
    assert.ok(m, `#${id} must have a class attribute: ${tag[0].slice(0, 120)}`);
    assert.ok(
      m[1].split(/\s+/).includes(cls),
      `#${id} must carry .${cls} - the dark-mode invariant is written against it (found "${m[1]}")`,
    );
  }
});

test("the specific contrast regressions are recorded and stay fixed", () => {
  // Named values, so a future edit that reintroduces any of them fails here
  // rather than in a screenshot. Comments are stripped first: these values are
  // named in the comments documenting the fixes, and matching prose would
  // flag the explanation as the defect.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const lyricRule = code.match(
    /\.dark[^{]*lyric-line:not\(\.lyric-active\):not\(\.lyric-past\)[^{]*\.lyric-text[^{]*\{[^}]*\}/,
  );
  assert.ok(lyricRule, "expected a dark-mode override for upcoming lyric text");
  assert.ok(
    !/#52525b/i.test(lyricRule[0]),
    `upcoming lyric text is back to the light grey (2.38:1 on the dark stage): ${lyricRule[0].slice(0, 120)}`,
  );

  // Scoped to the two surfaces that actually failed. #15803d is still correct
  // on the light cards that carry it (.soc-badge, .soc-stat-chip.is-live),
  // so a blanket ban would be wrong - only these two appear in both themes.
  const netAt = code.indexOf("#net-badge[data-net-mode=\"online\"]");
  assert.ok(netAt > 0, "#net-badge[data-net-mode=online] must still exist");
  assert.ok(
    !/color:\s*#15803d/i.test(code.slice(netAt, netAt + 320)),
    "the online network badge is back to #15803d: 3.97:1 on the dark header, under AA for 10px text",
  );

  const chipAt = code.indexOf(".soc-room-chip .material-symbols-outlined");
  assert.ok(chipAt > 0, "the room chip icon must still exist");
  assert.ok(
    !/color:\s*#15803d/i.test(code.slice(chipAt, chipAt + 200)),
    "the room chip icon is back to #15803d: 4.33:1 on its own chip background, under AA",
  );
});