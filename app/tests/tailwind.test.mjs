// Static Tailwind build: the CSS must ship on disk, never from the CDN.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("no runtime Tailwind CDN references remain", () => {
  const hits = walk(src)
    .filter((f) => /\.(html|js|css)$/.test(f))
    .filter((f) => fs.readFileSync(f, "utf8").includes("cdn.tailwindcss.com"));
  assert.deepEqual(hits, []);
});

test("built tailwind.css and desktop styles.css exist and carry key utilities", () => {
  const mobileCss = fs.readFileSync(path.join(src, "tailwind.css"), "utf8");
  const desktopCss = fs.readFileSync(path.join(src, "styles.css"), "utf8");
  for (const sel of [
    ".bg-surface",
    ".text-on-surface",
    ".hidden",
    ".md\\:flex",
    ".px-gutter",
    ".font-headline-md",
    ".hover\\:bg-surface-container-high",
  ]) {
    assert.ok(mobileCss.includes(sel), `mobile missing ${sel}`);
    assert.ok(desktopCss.includes(sel), `desktop missing ${sel}`);
  }
});

test("shells link the local stylesheet", () => {
  // Desktop is pure vanilla CSS (styles.css) without any Tailwind build dependency.
  const index = fs.readFileSync(path.join(src, "index.html"), "utf8");
  assert.ok(
    index.includes('href="styles.css"') || index.includes('href="/styles.css"'),
    "index.html must link styles.css",
  );
  assert.ok(!index.includes('href="tailwind.css"'), "index.html should not link tailwind.css");
  assert.ok(!index.includes("cdn.tailwindcss.com"), "index.html still references the CDN");

  // Mobile keeps its static local tailwind stylesheet.
  const mobile = fs.readFileSync(path.join(src, "mobile", "index.html"), "utf8");
  assert.ok(mobile.includes('href="/tailwind.css"'), "mobile/index.html must link /tailwind.css");
  assert.ok(!mobile.includes("cdn.tailwindcss.com"), "mobile/index.html still references the CDN");
});
