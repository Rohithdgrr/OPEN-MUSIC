// mobile-spotify.test.mjs — static contract for the mobile Spotify section:
// Settings rows and their command wiring, plus the ISRC-must-never-be-the-query
// regression in both importers.
//
// The Now Playing Canvas was removed completely on 2026-11-14, so this file now
// also guards the removal: no Canvas row, key, renderer or command may come back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const binders = read("src/mobile/binders.js");
const importer = read("src/importer.js");
const settings = read("src/settings.js");
const spotmatch = read("src/spotmatch.js");
const libRs = read("src-tauri/src/lib.rs");

test("non-vacuous: all files are real", () => {
  assert.ok(binders.length > 100000, "binders.js unexpectedly small");
});

test("mobile Settings ships the Spotify section rows", () => {
  // The section div's id is injected by the `sec()` helper, so its literal is
  // the argument form; the rows below are inline markup.
  assert.ok(binders.includes('"tm-m-spotify"'), "missing the tm-m-spotify section");
  for (const id of ["m-spotify-status", "m-spotify-signin", "m-spotify-signout", "m-spotify-top"]) {
    assert.ok(binders.includes(`id="${id}"`), `missing #${id}`);
  }
  // Canvas was removed on 2026-11-14: its rows and prefs must not return.
  assert.ok(!/m-canvas|m-spdc|Now Playing Canvas/.test(binders), "Canvas UI survived the removal");
});

test("every Spotify command the mobile shell uses is registered server-side", () => {
  for (const cmd of [
    "spotify_signin",
    "spotify_signout",
    "spotify_is_signedin",
    "spotify_import_top",
  ]) {
    assert.ok(libRs.includes(`::${cmd}`) || libRs.includes(cmd), `${cmd} not in lib.rs`);
    assert.ok(binders.includes(`"${cmd}"`), `binders never invokes ${cmd}`);
  }
  // …and the removed Canvas commands are gone from both halves.
  for (const cmd of ["fetch_canvas", "set_canvas_cookie", "canvas_configured"]) {
    assert.ok(!libRs.includes(cmd), `${cmd} is still registered in lib.rs`);
    assert.ok(!binders.includes(cmd), `${cmd} is still invoked from binders.js`);
  }
});

test("import regression: ISRC is never the search query in either importer", () => {
  for (const [name, src] of [
    ["importer.js", importer],
    ["settings.js", settings],
  ]) {
    assert.ok(src.includes("matchTrackToCatalog"), `${name} does not use the matcher`);
    assert.ok(!/\.isrc\s*\|\|/.test(src), `${name} still falls back to an ISRC query`);
  }
  assert.ok(spotmatch.includes("titleVariants"), "matcher lost its title normalization");
});

test("Rust: proxy state is always the managed Arc<AppState>, never bare AppState", () => {
  // The builder manages `Arc<AppState>` (lib.rs), so a command param typed
  // `State<'_, AppState>` can never resolve — every call fails at runtime with
  // "state not managed for field ...", which is what silently broke Spotify
  // sign-in until 2026-10-15.
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
