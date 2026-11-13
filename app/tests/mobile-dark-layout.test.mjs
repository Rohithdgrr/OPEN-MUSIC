// Static gate for the 2026-11-12 dark-theme + layout pass.
// The shell has no DOM in node, so these assert the shipped source contracts
// (the same style as the other mobile static gates).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src/mobile");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const shell = read("index.html");
const app = read("app.js");
const binders = read("binders.js");

// Dark engine starts at the "GLOBAL MOBILE DARK THEME ENGINE" marker.
const darkStart = shell.indexOf("GLOBAL MOBILE DARK THEME ENGINE");
assert.ok(darkStart > 0, "dark theme engine marker missing");
const dark = shell.slice(darkStart);

test("dark engine has no white glow shadows", () => {
  // A white glow is `0 0 <blur>px` — three numbers, no spread. The hairline
  // (`inset 0 0 0 1px`) and the focus ring (`0 0 0 2px`) have FOUR numbers
  // (x, y, spread, blur) and are deliberate, so they must not be flagged.
  const glows = [];
  for (const m of dark.matchAll(/box-shadow:\s*([^;]+);/g)) {
    const v = m[1];
    if (!/rgba\(255,\s*255,\s*255/.test(v)) continue;
    const nums = v.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length === 3 && Number(nums[2]) > 0) glows.push(v.trim());
  }
  assert.deepEqual(glows, [], `white glow shadows survived: ${glows.join(" | ")}`);
});

test("scrubber is transparent in dark mode (no white wash on the container)", () => {
  const block = dark.slice(dark.indexOf("Scrubber in Dark Mode"), dark.indexOf("Scrubber in Dark Mode") + 900);
  assert.match(block, /#scrubber-container[\s\S]*background:\s*transparent/, "scrubber container must be transparent in dark");
  assert.doesNotMatch(block, /rgba\(255,\s*255,\s*255,\s*0\.16\)/, "the white wash on the scrubber container is back");
});

test("dark elevation is a hairline, not a black shadow only", () => {
  assert.match(dark, /inset 0 0 0 1px rgba\(255,\s*255,\s*255/, "dark cards need a hairline ring");
});

test("resolveEntity never falls back to the first search result", () => {
  const fn = app.slice(app.indexOf("async function resolveEntity"), app.indexOf("async function resolveEntity") + 1400);
  // Strip line comments: the source explains the old bug in prose, and the
  // prose quotes the pattern the gate is looking for.
  const code = fn.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /\|\|\s*items\[0\]/, "the || items[0] fallback opens the wrong artist");
  assert.match(code, /fold/, "resolveEntity must fold titles before matching");
});

test("entity taps read the name from data-entity-title", () => {
  assert.match(app, /ent\.dataset\.entityTitle/, "the click handler must prefer data-entity-title");
});

test("tm-layout is read, written and offered in Settings", () => {
  assert.match(binders, /tm-layout/, "the layout preference is not used");
  assert.match(binders, /mGet\("tm-layout",\s*"grid"\)/, "tm-layout must default to grid");
  assert.match(binders, /mSet\("tm-layout"/, "tm-layout must be persisted");
  assert.match(binders, /sel\("m-layout"/, "Settings must offer the Layout control");
  assert.match(binders, /\["grid",\s*"Grid"\].*\["list",\s*"List"\]/, "Layout needs a Grid and a List option");
});

test("every collection screen honours the layout preference", () => {
  for (const fn of ["mountArtists", "mountAlbums", "mountPlaylists", "mountCharts", "mountLiked", "mountDownload"]) {
    const start = binders.indexOf(`function ${fn}`);
    assert.ok(start > 0, `${fn} not found`);
    // The function body runs to the next top-level definition.
    const rest = binders.slice(start + 10);
    const next = rest.search(/\n(?:async )?function \w+/);
    const body = rest.slice(0, next > 0 ? next : 6000);
    assert.match(body, /layoutMode\(\)/, `${fn} ignores the layout preference`);
  }
});

test("grid mode uses two columns of square artwork", () => {
  assert.match(binders, /layoutGridClass = "grid grid-cols-2/, "the grid must be two columns");
  assert.match(binders, /aspect-square/, "grid tiles must be square artwork");
});

// The systematic dark-mode bug: Tailwind bakes the LIGHT palette into every
// "/NN" opacity variant, and the plain class rules never match them. Every
// variant the shell uses must have a dark rule, or it renders near-white.
test("every opacity-modified theme colour has a dark rule", () => {
  const files = [
    ...fs.readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => path.join(SRC, f)),
    ...fs.readdirSync(path.join(SRC, "screens"))
      .filter((f) => f.endsWith(".html"))
      .map((f) => path.join(SRC, "screens", f)),
  ];
  const used = new Set();
  const pat = /\b(bg|border|text|ring|divide)-(surface-container-highest|surface-container-high|surface-container-lowest|surface-container-low|surface-container|surface|primary|secondary|on-surface-variant|on-surface)\/(\d+)\b/g;
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(pat)) used.add(`${m[1]}-${m[2]}/${m[3]}`);
  }
  // CSS escapes the slash in a class name (`.bg-surface\/85`); unescape the
  // backslash-slash PAIR, or it becomes a double slash and matches nothing.
  const darkText = dark.replace(/\\\//g, "/");
  const covered = new Set();
  for (const m of darkText.matchAll(/\.(bg|border|text|ring|divide)-([a-z-]+)\/(\d+)/g)) {
    covered.add(`${m[1]}-${m[2]}/${m[3]}`);
  }
  const missing = [...used].filter((v) => !covered.has(v)).sort();
  assert.deepEqual(missing, [], `translucent theme colours without a dark rule: ${missing.join(", ")}`);
});

test("the shelf header band rule is gone from the dark engine", () => {
  assert.doesNotMatch(dark, /\[data-shelf\]\s*>\s*div/, "the shelf header row must not get a card gradient");
});

test("action discs are glass, not solid white discs", () => {
  assert.match(dark, /bg-on-surface\.text-surface[\s\S]{0,200}rgba\(255, 255, 255, 0\.14\)/, "play bubbles need the glass treatment");
  // The shelf-card bubble is a LITERAL white disc (bg-white text-black).
  assert.match(dark, /bg-white\.text-black[\s\S]{0,200}rgba\(255, 255, 255, 0\.16\)/, "the card play bubble needs the glass treatment");
});

test("artist tiles use the artist's own photo, not the track's album cover", () => {
  assert.match(binders, /async function artistArt\(/, "the artist artwork resolver is missing");
  assert.match(binders, /resolveArtistArt\(/, "the artist screen must resolve real artist artwork");
  assert.match(binders, /artistArtCache\.get\(a\.name\)/, "the artist tile must prefer the resolved photo");
});
