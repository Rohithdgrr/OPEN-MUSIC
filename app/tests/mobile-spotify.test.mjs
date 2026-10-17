// mobile-spotify.test.mjs — static contract for the mobile Spotify section
// (docs/spotify-android-canvas.md §3B/§3C): Settings rows and their command
// wiring, the Canvas video layer, the CSP origin it loads from, and the
// ISRC-must-never-be-the-query regression in both importers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const binders = read("src/mobile/binders.js");
const nowplaying = read("src/mobile/screens/nowplaying.html");
const canvasJs = read("src/mobile/canvas.js");
const importer = read("src/importer.js");
const settings = read("src/settings.js");
const spotmatch = read("src/spotmatch.js");
const libRs = read("src-tauri/src/lib.rs");
const androidConf = JSON.parse(read("src-tauri/tauri.android.conf.json"));

test("non-vacuous: all files are real", () => {
  assert.ok(binders.length > 100000, "binders.js unexpectedly small");
  assert.ok(canvasJs.length > 1000, "canvas.js unexpectedly small");
  assert.ok(nowplaying.length > 1000, "nowplaying.html unexpectedly small");
});

test("mobile Settings ships the Spotify section rows", () => {
  // The section div's id is injected by the `sec()` helper, so its literal is
  // the argument form; the rows below are inline markup.
  assert.ok(binders.includes('"tm-m-spotify"'), "missing the tm-m-spotify section");
  for (const id of [
    "m-spotify-status",
    "m-spotify-signin",
    "m-spotify-signout",
    "m-spotify-top",
    "m-spdc",
    "m-spdc-save",
  ]) {
    assert.ok(binders.includes(`id="${id}"`), `missing #${id}`);
  }
  // The canvas toggles' ids are injected by the `sw()` helper (argument form).
  assert.ok(binders.includes('sw("m-canvas")'), "missing the m-canvas switch");
  assert.ok(binders.includes('sw("m-canvas-cell")'), "missing the m-canvas-cell switch");
});

test("every Spotify/Canvas command the mobile shell uses is registered server-side", () => {
  for (const cmd of [
    "spotify_signin",
    "spotify_signout",
    "spotify_is_signedin",
    "spotify_import_top",
    "fetch_canvas",
    "set_canvas_cookie",
    "canvas_configured",
  ]) {
    assert.ok(libRs.includes(`::${cmd}`) || libRs.includes(cmd), `${cmd} not in lib.rs`);
  }
  // …and actually invoked from the shell (canvas.js owns the per-track fetch).
  for (const cmd of ["spotify_signin", "spotify_signout", "spotify_is_signedin", "spotify_import_top", "set_canvas_cookie", "canvas_configured"]) {
    assert.ok(binders.includes(`"${cmd}"`), `binders never invokes ${cmd}`);
  }
  assert.ok(canvasJs.includes('"fetch_canvas"'), "canvas.js never fetches a canvas");
});

test("Canvas: video layer sits above the art inside the art card; paint hook calls it", () => {
  const card = nowplaying.indexOf('id="np-art-card"');
  const art = nowplaying.indexOf('id="np-art"');
  const video = nowplaying.indexOf('id="np-canvas"');
  assert.ok(card >= 0 && art > card && video > art, "np-canvas must follow np-art inside np-art-card");
  assert.ok(nowplaying.includes('muted loop playsinline'), "canvas video must be a muted loop");
  assert.ok(binders.includes("paintCanvasForTrack(t)"), "player paint hook never calls paintCanvasForTrack");
  assert.ok(canvasJs.includes('"tm-canvas"') && canvasJs.includes('"tm-canvas-cellular"'), "canvas prefs keys missing");
});

test("CSP: canvaz.scdn.co is allowed for both media and images", () => {
  const csp = androidConf.app.security.csp;
  assert.ok(csp.includes("media-src 'self' http://127.0.0.1:* https://canvaz.scdn.co;"), "media-src lacks canvaz");
  assert.ok(/img-src [^;]*https:\/\/canvaz\.scdn\.co;/.test(csp), "img-src lacks canvaz");
});

test("import regression: ISRC is never the search query in either importer", () => {
  for (const [name, src] of [["importer.js", importer], ["settings.js", settings]]) {
    assert.ok(src.includes("matchTrackToCatalog"), `${name} does not use the matcher`);
    assert.ok(!/\.isrc\s*\|\|/.test(src), `${name} still falls back to an ISRC query`);
  }
  assert.ok(spotmatch.includes("titleVariants"), "matcher lost its title normalization");
});

test("Rust: proxy state is always the managed Arc<AppState>, never bare AppState", () => {
  // The builder manages `Arc<AppState>` (lib.rs), so a command param typed
  // `State<'_, AppState>` can never resolve — every call fails at runtime with
  // "state not managed for field ...", which is what silently broke Spotify
  // sign-in and every Canvas command until 2026-10-15.
  const bad = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rs")) {
        const src = readFileSync(p, "utf8");
        if (/State<'_,\s*(?:crate::proxy::)?AppState>/.test(src)) bad.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, "src-tauri", "src"));
  assert.deepEqual(bad, [], `bare AppState command params (fails at runtime): ${bad.join(", ")}`);
});
