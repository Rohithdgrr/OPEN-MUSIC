// mobile-syntax.test.mjs — closes docs/mobile/09-problems-solutions.md P19.
//
// P19 recorded that CI never syntax-checked `src/mobile/**`, so a mobile-only
// parse error could reach a release unnoticed: desktop tests all pass, the
// mobile bundle is never loaded, and the break only shows up on a phone.
// This turns the manual `node --check` loop from P19 into a real gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = path.join(appDir, "src", "mobile");

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every src/mobile JS file parses (P19: CI used to skip this entirely)", () => {
  const files = jsFiles(mobileDir);
  // Guard the guard: if the directory were moved or renamed, "0 failures"
  // would still be green while checking nothing at all.
  assert.ok(files.length >= 30, `expected the mobile bundle to exist, found ${files.length} files`);

  const broken = [];
  for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) {
      const firstLine = (res.stderr || "").split("\n").find((l) => l.trim()) || "parse error";
      broken.push(`${path.relative(mobileDir, file)}: ${firstLine}`);
    }
  }
  assert.deepEqual(broken, [], `mobile files that do not parse:\n  ${broken.join("\n  ")}`);
});

test("the generated mobile screens are present, not just the shell", () => {
  const screens = jsFiles(path.join(mobileDir, "screens"));
  assert.ok(screens.length >= 10, `expected the generated screens, found ${screens.length}`);
});

test("the mobile bundle stays outside the desktop test glob's blind spot", () => {
  // The desktop suite globs app/tests/**; if mobile ever moves into app/tests
  // these files would be run as tests and fail confusingly. Keep them apart.
  for (const file of jsFiles(mobileDir)) {
    assert.ok(
      !file.includes(`${path.sep}tests${path.sep}`),
      `mobile source must not live under a tests/ directory: ${file}`,
    );
  }
});
