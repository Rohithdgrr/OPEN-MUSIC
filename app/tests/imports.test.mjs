// imports.test.mjs — static cross-module import/export check for the
// mobile shell. node --check only parses files in isolation, so a typo'd
// named import (e.g. `esc` from shared.js instead of html.js) sails through
// lint + syntax and then kills the whole app.js module graph on device.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const files = [];
for (const dir of ["../src/mobile", "../src"]) {
  const abs = path.join(root, dir);
  for (const f of fs.readdirSync(abs)) {
    if (f.endsWith(".js")) files.push(path.join(abs, f));
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function exportsOf(src) {
  const clean = stripComments(src);
  const out = new Set();
  for (const m of clean.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of clean.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

function importsOf(src) {
  // static named imports from relative paths only (bare/absolute = external)
  const clean = stripComments(src);
  const out = [];
  for (const m of clean.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!m[2].startsWith(".")) continue;
    // `arm as armSleep` imports the ORIGINAL name — check that one.
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).shift().trim()).filter(Boolean);
    out.push({ from: m[2], names });
  }
  return out;
}

test("every relative named import resolves to a real export", () => {
  const cache = new Map();
  const exp = (file) => {
    if (!cache.has(file)) cache.set(file, exportsOf(fs.readFileSync(file, "utf8")));
    return cache.get(file);
  };
  const missing = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const imp of importsOf(src)) {
      let target;
      try {
        target = path.normalize(path.join(path.dirname(file), imp.from));
        if (!target.endsWith(".js")) target += ".js";
        if (!fs.existsSync(target)) continue; // screen companion, ignore
      } catch {
        continue;
      }
      const have = exp(target);
      for (const n of imp.names) {
        if (!have.has(n)) missing.push(`${path.basename(file)} imports {${n}} from ${imp.from} — not exported`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});
