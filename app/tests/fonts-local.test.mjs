// fonts-local.test.mjs — both shells render with zero connectivity:
// fonts are shipped locally, heads reference them, Google font URLs are gone.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8");
const androidRoot = readFileSync(join(appRoot, "src-tauri", "tauri.android.conf.json"), "utf8");

test("font files ship in app/src/fonts", () => {
  for (const f of ["icons.woff2", "geist-latin.woff2", "jetbrains-mono-latin.woff2"]) {
    assert.ok(existsSync(join(root, "fonts", f)), `${f} missing`);
  }
});

test("mobile head: local @font-faces, no Google font links", () => {
  const html = readFileSync(join(root, "mobile", "index.html"), "utf8");
  assert.ok(html.includes('url("/fonts/icons.woff2")'), "icons @font-face");
  assert.ok(html.includes('url("/fonts/geist-latin.woff2")'), "geist @font-face");
  assert.ok(html.includes('url("/fonts/jetbrains-mono-latin.woff2")'), "mono @font-face");
  assert.ok(!html.includes("fonts.googleapis.com"), "googleapis link gone");
  assert.ok(!html.includes("fonts.gstatic.com"), "gstatic link gone");
  // the class definition that only Google's stylesheet carried must stay
  assert.ok(html.includes(".material-symbols-outlined {"), "icon class rule");
  assert.ok(html.includes("-webkit-font-feature-settings: 'liga'"), "liga rule");
});

test("desktop head: local @font-faces, no Google font links", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.ok(html.includes('url("/fonts/icons.woff2")'), "icons @font-face");
  assert.ok(!html.includes("fonts.googleapis.com"), "googleapis link gone");
  assert.ok(!html.includes("fonts.gstatic.com"), "gstatic link gone");
  assert.ok(html.includes(".material-symbols-outlined{"), "icon class rule");
});

test("CSPs no longer allow the Google font domains", () => {
  for (const [i, raw] of [tauriRoot, androidRoot].entries()) {
    const name = i === 0 ? "tauri.conf.json" : "tauri.android.conf.json";
    assert.ok(!raw.includes("fonts.googleapis.com"), `${name} style-src`);
    assert.ok(!raw.includes("fonts.gstatic.com"), `${name} font-src`);
  }
});
