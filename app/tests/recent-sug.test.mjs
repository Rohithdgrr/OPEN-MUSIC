// recent-sug.test.mjs — the suggest dropdown's history rows carry a remove
// button that deletes from real storage and repaints; the bay pills keep
// their own working removal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const binders = readFileSync(join(root, "mobile", "binders.js"), "utf8");
const app = readFileSync(join(root, "mobile", "app.js"), "utf8");

test("sugQueryRow supports the remove button out of the row button", () => {
  assert.ok(binders.includes("data-sug-del="), "del attr painted");
  assert.ok(binders.includes("sugQueryRow(r, toks, \"history\", true)"), "prefix suggest passes del");
  assert.ok(binders.includes("sugQueryRow(s, [], \"history\", true)"), "recents pass del");
  assert.ok(binders.includes('aria-label="Remove recent search"'), "labelled");
  // the X is a SIBLING of the main button (wrapper div), never nested in it
  assert.ok(binders.includes('class="relative">${main}'), "outside the row button");
});

test("clicking it removes from tm-history storage and repaints in place", () => {
  const i = binders.indexOf('closest("[data-sug-del]")');
  assert.ok(i > -1, "delegated branch");
  const seg = binders.slice(i, i + 1100);
  assert.ok(seg.includes("stopPropagation()"), "detached-target bubble stopped");
  assert.ok(seg.includes("HISTORY_KEY"), "storage targeted");
  assert.ok(seg.includes("filter((x) => String(x) !== q)"), "exact removal");
  assert.ok(seg.includes("recentSuggest()") && seg.includes("fetchSuggest(text)"), "same-context repaint");
});

test("keyboard navigation still selects rows, not the remove", () => {
  assert.ok(binders.includes('querySelectorAll("[data-sug-kind],[data-sug-q]")'), "selector excludes data-sug-del");
});

test("the bay's per-pill removal stays intact", () => {
  assert.ok(binders.includes('data-qdel="${i}"'), "bay pill buttons");
  assert.ok(app.includes('el("[data-qdel]")'), "bay wiring");
  assert.ok(app.includes("hist.splice(+qdel.dataset.qdel, 1)"), "bay splice");
});
