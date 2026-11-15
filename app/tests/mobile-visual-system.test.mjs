import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../src/mobile");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const shell = read("shell.css");
const entry = read("index.html");
const router = read("router.js");
const app = read("app.js");
const home = read("screens/home.html");
const binders = read("binders.js");

test("mobile shell respects user zoom and short device viewports", () => {
  assert.match(entry, /name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/);
  assert.doesNotMatch(entry, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.match(shell, /min-height:\s*100dvh/);
  assert.doesNotMatch(shell, /max\(884px,\s*100dvh\)/);
});

test("fixed player, navigation, and screen content share safe-area geometry", () => {
  assert.match(router, /aria-label="Primary navigation"[^>]*om-bottom-nav/);
  assert.match(app, /id="tm-widget" class="om-mini-player fixed bottom-0/);
  assert.match(shell, /#tm-widget\.om-mini-player[\s\S]*bottom:\s*calc\(var\(--om-nav-content-height\)\s*\+\s*max\(0\.5rem,\s*env\(safe-area-inset-bottom/);
  assert.match(shell, /--om-mini-player-clearance:\s*6\.5rem/);
  assert.match(shell, /main\.pb-36:not\(#np-main\)[\s\S]*var\(--om-mini-player-clearance\)/);
  assert.match(shell, /#tm-toast-stack[\s\S]*safe-area-inset-bottom/);
});

test("interactive controls have touch targets and visible keyboard focus", () => {
  assert.match(shell, /--om-touch-target:\s*44px/);
  assert.match(shell, /--om-motion-fast:\s*160ms/);
  assert.match(shell, /@media \(pointer:\s*coarse\)[\s\S]*#screen button[\s\S]*min-height:\s*var\(--om-touch-target\)/);
  assert.match(shell, /#tm-widget \[data-w-seek\][\s\S]*height:\s*var\(--om-touch-target\)/);
  assert.match(shell, /focus-visible[\s\S]*outline:\s*3px solid var\(--om-focus-color\)/);
  assert.match(shell, /html\.dark\s*\{[\s\S]*--om-focus-color:\s*#c4b5fd/);
});

test("mini-player seek slider is keyboard operable and reports its state", () => {
  assert.match(app, /data-w-seek role="slider"[^>]*aria-valuenow="0" aria-disabled="true" tabindex="0"/);
  assert.match(app, /ArrowLeft:\s*-1,[\s\S]*ArrowDown:\s*-1,[\s\S]*ArrowRight:\s*1,[\s\S]*ArrowUp:\s*1/);
  assert.match(app, /PageDown:\s*-10,[\s\S]*PageUp:\s*10,[\s\S]*Home:\s*"min",[\s\S]*End:\s*"max"/);
  assert.match(app, /seek\(\(value \/ 100\) \* st\.dur\)/);
  assert.match(app, /seekEl\.setAttribute\("aria-disabled", String\(st\.dur <= 0\)\)/);
  assert.match(shell, /\[role="slider"\]\):focus-visible/);
});

test("home shelf filters announce the selected state without relying on color", () => {
  assert.match(home, /data-home-cat="all" aria-pressed="true"/);
  assert.match(home, /data-home-cat="genres" aria-pressed="false"/);
  assert.match(home, /data-home-cat="jump" aria-pressed="false"/);
  assert.match(binders, /if \(\["all", "genres", "jump"\]\.includes\(c\.dataset\.homeCat\)\)[\s\S]*c\.setAttribute\("aria-pressed", String\(c === chip\)\)/);
});

test("reduced motion removes movement while retaining lyric color feedback", () => {
  const reduced = shell.slice(shell.indexOf("@media (prefers-reduced-motion: reduce)"), shell.indexOf("@media (prefers-reduced-motion: no-preference)"));
  assert.match(reduced, /\.tab-content\.flex\s*\{\s*animation:\s*none/);
  assert.match(reduced, /\.lyric-line,[\s\S]*transition-property:\s*color,\s*background-color,\s*border-color/);
  assert.match(reduced, /\.lyric-text\s*\{\s*transition:\s*color/);
});

test("spotlight is hidden until a real playable playlist is available", () => {
  assert.match(home, /class="hidden[^"]*"[^>]*data-shelf="spotlight"/);
  assert.match(home, /<span>Play playlist<\/span>/);
  assert.match(home, /data-spot-count hidden/);
  assert.doesNotMatch(home, /FLAC 24-BIT|Lossless|Play Album|Nocturne Sessions Vol\. IV|Solaris &amp; Kaelen/);
  assert.match(binders, /m\.querySelector\('\[data-shelf="spotlight"\]'\)/);
  assert.match(binders, /if \(hero && spot && spot\.id\)/);
  assert.match(binders, /hero\.classList\.add\("hidden"\)/);
  assert.match(binders, /meta\.classList\.remove\("hidden"\)/);
  assert.match(binders, /pb\.dataset\.plPlay = spot\.id/);
});
