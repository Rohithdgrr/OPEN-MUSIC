import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../src/mobile/", import.meta.url);
const screen = readFileSync(new URL("screens/nowplaying.html", root), "utf8");
const css = readFileSync(new URL("shell.css", root), "utf8");
const binders = readFileSync(new URL("binders.js", root), "utf8");

test("Now Playing has two decorative artwork layers without changing the track-art id", () => {
  assert.match(screen, /id="np-backdrop"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*id="np-backdrop"/);
  assert.equal((screen.match(/class="np-backdrop-art"/g) || []).length, 2);
  assert.match(screen, /id="np-art"/);
  assert.match(binders, /document\.getElementById\("np-art"\) \|\| m\.querySelector\("img"\)/);
});

test("artwork fades only for motion-enabled users and remains behind the controls", () => {
  assert.match(css, /#np-main\s*\{[^}]*isolation:\s*isolate/s);
  assert.match(css, /#np-backdrop\s*\{[^}]*z-index:\s*0/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[^}]*transition:\s*opacity/s);
  assert.match(css, /@media\s*\(max-height:\s*680px\)/);
  assert.match(binders, /backdrop\.dataset\.artSrc === src/);
});
