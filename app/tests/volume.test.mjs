// volume.test.mjs — regression guard for silent playback on a fresh install.
//
// Bug: `Number(localStorage.getItem("tm-mobile-vol"))` on a device that has
// never touched the volume slider returns `Number(null)` === 0, and
// `Number.isFinite(0)` === true, so the "is it a real value?" guard passed and
// the <audio> element was clamped to volume 0. Symptom: songs list and resolve
// fine, the transport advances, but nothing is audible.
//
// Every read of a stored volume must therefore go through a raw-string null
// check (baseVol() in mobile/player.js, or an inline `raw != null` guard).
// The other stored prefs are safe: they coalesce with `|| "1"` / `|| "0"`
// before Number() ever sees a null.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function jsFiles() {
  const out = [];
  for (const dir of [root, path.join(root, "mobile")]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".js")) out.push(path.join(dir, f));
    }
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

test("tm-mobile-vol is never parsed with an unguarded Number()", () => {
  const bad = [];
  for (const file of jsFiles()) {
    const clean = stripComments(fs.readFileSync(file, "utf8"));
    // Number(localStorage.getItem("tm-mobile-vol")) with no `|| "..."` default
    // anywhere in that expression: the null -> 0 coercion is the whole bug.
    const re = /Number\(\s*localStorage\.getItem\(\s*"tm-mobile-vol"\s*\)\s*\)/g;
    for (const m of clean.matchAll(re)) {
      bad.push(`${path.relative(root, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], `unmuted-default volume reads:\n${bad.join("\n")}`);
});

test("the volume helper falls back to 1 when the key is absent", () => {
  const src = stripComments(
    fs.readFileSync(path.join(root, "mobile", "player.js"), "utf8")
  );
  const fn = src.match(/function baseVol\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, "baseVol() must exist in mobile/player.js");

  // Evaluate the shipped function against a stub localStorage so the test
  // asserts the real logic, not a paraphrase of it.
  const run = new Function(
    "localStorage",
    `${fn[0]}\nreturn baseVol();`
  );
  const stub = (value) => ({ getItem: () => value });

  assert.equal(run(stub(null)), 1, "missing key must mean full volume, not 0");
  assert.equal(run(stub("")), 1, "empty string must mean full volume");
  assert.equal(run(stub("0.5")), 0.5, "a real stored value is honoured");
  assert.equal(run(stub("0")), 0, "an explicit 0 still means mute");
  assert.equal(run(stub("garbage")), 1, "corrupt value falls back to full");
  assert.equal(run(stub("7")), 1, "out-of-range clamps to the 1.0 ceiling");
});
