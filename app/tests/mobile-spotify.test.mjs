// mobile-spotify.test.mjs — static contract for the mobile Spotify section
// (docs/spotify-android-canvas.md §3B/§3C): Settings rows and their command
// wiring, the Canvas video layer, the CSP origin it loads from, and the
// ISRC-must-never-be-the-query regression in both importers.
//
// 2026-10-24: the Canvas is PARKED (docs/spotify-android-canvas.md §18) — the
// renderer is unwired and its Settings rows are commented out. The canvas
// gates here therefore use (a) marker presence and (b) line-anchored regexes
// that cannot match a commented line. A raw includes() would stay green
// forever even with the wiring commented — learned on this exact change.
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
const canvasMath = read("src/mobile/canvasmath.js");
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
  for (const id of ["m-spotify-status", "m-spotify-signin", "m-spotify-signout", "m-spotify-top"]) {
    assert.ok(binders.includes(`id="${id}"`), `missing #${id}`);
  }
  // PARKED (§18): the Canvas rows ("Now Playing Canvas", "Canvas on mobile
  // data", "Canvas session cookie") must not be injected on any line that is
  // live code — a commented row is fine and expected.
  assert.ok(!/^\s*row\("smart_display", "Now Playing Canvas"/m.test(binders), "the m-canvas row is live — the Canvas is parked");
  assert.ok(!/^\s*row\("signal_cellular_alt", "Canvas on mobile data"/m.test(binders), "the m-canvas-cell row is live — the Canvas is parked");
  assert.ok(!/^\s*"Canvas session cookie"/m.test(binders), "the m-spdc row is live — the Canvas is parked");
  assert.ok(!/^\s*"Now Playing Canvas"/m.test(binders), "the Now Playing Canvas row label is live — the Canvas is parked");
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
  // Spotify commands are still actively invoked from the shell (§3C kept).
  for (const cmd of ["spotify_signin", "spotify_signout", "spotify_is_signedin", "spotify_import_top"]) {
    assert.ok(binders.includes(`"${cmd}"`), `binders never invokes ${cmd}`);
  }
  // The parked renderer is kept intact as a file (§18) — it must still carry
  // the fetch so a revive is comment-marker surgery only.
  assert.ok(canvasJs.includes('"fetch_canvas"'), "canvas.js never fetches a canvas");
});

test("Canvas: renderer preserved in the parked file; the fragment keeps the art fallback", () => {
  // §15/§16 (PARKED §18): the video is not inside the square art card —
  // canvas.js creates a body-level fixed layer (`#np-canvas-layer`) that the
  // Spotify-Canvas presentation addresses. The layer survives navigation and
  // carries the track cover as the every-song fallback. The file body is kept
  // intact so a revive is marker surgery (§18.3); nothing hot-wires it right now.
  const card = nowplaying.indexOf('id="np-art-card"');
  const art = nowplaying.indexOf('id="np-art"');
  assert.ok(card >= 0 && art > card, "np-art must stay inside np-art-card");
  assert.ok(!nowplaying.includes('id="np-canvas"'), "np-canvas must not live inside the screen fragment");
  assert.ok(canvasJs.includes('LAYER_ID = "np-canvas-layer"'), "canvas.js lost the full-bleed layer id");
  assert.ok(canvasJs.includes('BACKDROP_ID = "np-canvas-backdrop"'), "canvas.js lost the artwork backdrop");
  assert.ok(canvasJs.includes('document.createElement("video")'), "canvas.js no longer creates the video");
  // §17: two muted videos, loop=false; the rAF ticker owns the 6 s window.
  assert.ok(/v\.muted = true/.test(canvasJs) && /v\.loop = false/.test(canvasJs), "canvas videos must be muted and loop=false (the renderer owns the 6 s window)");
  assert.ok(canvasJs.includes('ALT_ID = "np-canvas-alt"'), "canvas.js lost the crossfade standby");
  assert.ok(canvasJs.includes('from "./canvasmath.js"'), "canvas.js does not import the pure canvas policy");
  assert.ok(canvasJs.includes("dataset.crop") && canvasJs.includes("dataset.loop"), "canvas.js does not publish dataset.crop / dataset.loop");
  // 2026-10-23: Apple's fMP4 starts at ~10.03 s (edit-list offset). A fixed
  // 0.6 s anchor made every frame read "past the window" and the two videos
  // crossfaded continuously. The anchor must come from the first `playing`
  // frame and loopPlan must accept it.
  assert.ok(
    canvasJs.includes("v.dataset.base") && canvasJs.includes("plan.base"),
    "canvas.js does not anchor the 6 s window to the first presentable frame",
  );
  assert.ok(canvasJs.includes("dataset.base"), "canvas.js does not publish dataset.base");
  assert.ok(
    canvasJs.includes("requestVideoFrameCallback"),
    "canvas.js does not wait for the first presented frame before anchoring the loop",
  );
  assert.ok(canvasMath.includes("loopPlan(duration, base = 0)"), "canvasmath.js lost the base-aware loopPlan");
  assert.ok(canvasJs.includes("startFade") && canvasJs.includes("finishFade") && canvasJs.includes("hardLoop"), "canvas.js lost the crossfade / hard-loop paths");
  assert.ok(canvasJs.includes("np-canvas-live") && canvasJs.includes("np-canvas-art"), "cinematic mode classes missing");
  assert.ok(canvasJs.includes("np-canvas-focus"), "canvas.js lost the focused/ambient presentation split");
  assert.ok(canvasJs.includes("setBackdrop(track)") && canvasJs.includes("hqArt(raw)"), "no artwork fallback for tracks without an animated cut");
  assert.ok(canvasJs.includes("onPaint(") && canvasJs.includes("playerState()"), "no global player paint hook — the canvas could not follow the track on other screens");
  assert.ok(canvasJs.includes("let modeOn = false"), "canvas lifecycle must be keyed on its own flag, not a body class the screens rewrite");
  assert.ok(canvasJs.includes('"tm-canvas"') && canvasJs.includes('"tm-canvas-cellular"'), "canvas prefs keys missing");
  // 2026-10-20: tracks without Apple motion artwork must still animate. The
  // artwork fallback arms a motion class that the CSS uses for the cover
  // drift + sheen; the video path removes it so the motions never stack.
  assert.ok(canvasJs.includes("np-canvas-motion") && canvasJs.includes("MOTION_CLASS"), "artwork fallback has no motion class — non-Apple tracks would sit still");
  const showBackdrop = canvasJs.slice(canvasJs.indexOf("function showBackdrop"), canvasJs.indexOf("function showVideo"));
  const showVideo = canvasJs.slice(canvasJs.indexOf("function showVideo"), canvasJs.indexOf("function hideVideo"));
  assert.ok(showBackdrop.includes("classList.add(MOTION_CLASS)"), "showBackdrop must start the fallback motion");
  assert.ok(showVideo.includes("classList.remove(MOTION_CLASS)"), "showVideo must stop the fallback motion");
  assert.ok(
    canvasJs.includes('document.addEventListener("smount"'),
    "no smount hook — the focus/dim presentation would not follow navigation",
  );
  // §16: leaving Now Playing must NOT tear the canvas down any more.
  const smount = canvasJs.slice(canvasJs.indexOf('document.addEventListener("smount"'));
  const handler = smount.slice(0, smount.indexOf("});") + 3);
  assert.ok(!handler.includes("stopCanvas"), "smount still stops the canvas — it must persist on every screen");
  assert.ok(handler.includes("syncFocus"), "smount does not re-sync the focused/ambient presentation");
});

test("Canvas is parked: no live wiring anywhere in the mobile shell (§18)", () => {
  // Marker presence is the comment-proof half of the gate: every parked site
  // carries the doc pointer, so removing a comment to revive turns this red.
  const parkedInBinders = [...binders.matchAll(/PARKED 2026-10-24 \(docs\/spotify-android-canvas\.md §18\)/g)];
  assert.ok(
    parkedInBinders.length >= 5,
    `expected the PARKED marker at all 5 sites (import, painter call, settings rows, wiring block, switch-state init), got ${parkedInBinders.length}`,
  );
  assert.ok(canvasJs.includes("PARKED 2026-10-24 (docs/spotify-android-canvas.md §18)"), "canvas.js lost its parked note");

  // Active-code view: drop `//` line comments and the one parked block
  // comment (the flip/spdc wiring). Raw text matching is vacuous here — the
  // parked code IS the strings the old assertions looked for.
  const spdc = binders.indexOf("const paintSpdc");
  const blockOpen = binders.lastIndexOf("/*", spdc);
  const blockClose = binders.indexOf("*/", spdc);
  assert.ok(blockOpen >= 0 && blockClose > blockOpen, "the parked wiring block lost its /* ... */ enclosure");
  const withoutBlock = binders.slice(0, blockOpen) + binders.slice(blockClose + 2);
  const activeCode = withoutBlock
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  for (const bad of [
    'invoke("set_canvas_cookie"',
    'invoke("canvas_configured"',
    "canvasEnabled",
    "canvasCellularAllowed",
    "setCanvasEnabled",
    "setCanvasCellular",
    "stopCanvas",
    "paintCanvasForTrack",
    "flipCanvas",
    '"m-canvas"',
    '"m-canvas-cell"',
    '"m-spdc"',
  ]) {
    assert.ok(!activeCode.includes(bad), `live canvas wiring survived parking: ${bad}`);
  }
});

test("Canvas: the full-bleed cinematic CSS exists in the shell", () => {
  const shell = read("src/mobile/index.html");
  for (const token of [
    "#np-canvas-layer",
    "#np-canvas-backdrop",
    "#np-canvas-wash",
    "np-canvas-drift",
    "np-canvas-wash",
    "html.np-canvas-motion",
    "np-cover-drift",
    "np-cover-sheen",
    "prefers-reduced-motion",
    "html.np-canvas-live,",
    "html.np-canvas-live main.bg-surface",
    "html.np-canvas-focus",
    "#np-canvas-layer.dim::after",
    "html.np-canvas-live.np-canvas-art #np-art-card",
    "object-fit: cover",
    "html.np-canvas-live #np-sheet",
    "html.np-canvas-live #screen header",
  ]) {
    assert.ok(shell.includes(token), `mobile shell lost the canvas presentation rule: ${token}`);
  }
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
