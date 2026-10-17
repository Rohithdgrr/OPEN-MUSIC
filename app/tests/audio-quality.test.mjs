// audio-quality.test.mjs — T0 source-fidelity gates (docs/audio-quality.md).
// Static source-text assertions: the defaults that decide what actually
// reaches the listener must stay 320 kbps unless the listener opts down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (rel) => readFileSync(join(root, rel), "utf8");

test("desktop stream pick defaults to 320 kbps", () => {
  const src = read("src/playback.js");
  assert.match(
    src,
    /getItem\("tm-stream-quality"\) \|\| "320kbps"/,
    "playback.js streamQuality() must fall back to 320kbps",
  );
});

test("mobile network pick never defaults below 320 kbps", () => {
  const src = read("src/mobile/shared.js");
  assert.ok(!src.includes('return "96kbps"'), "no 96kbps default return anywhere in shared.js");
  // Every fallback branch of effectiveStreamQuality ends at 320kbps: 3 bare
  // `return "320kbps"` (cellular catch, wifi catch, outer catch) + 2
  // `|| "320kbps"` (cellular pick, wifi pick). Data Saver's 64kbps return is
  // the one explicit opt-in — and the absence of any 96kbps default is
  // asserted above.
  const start = src.indexOf("export function effectiveStreamQuality");
  assert.ok(start >= 0, "effectiveStreamQuality must exist");
  const end = src.indexOf("export ", start + 10);
  const fn = src.slice(start, end);
  assert.ok(
    (fn.match(/320kbps/g) || []).length >= 5,
    "effectiveStreamQuality must bottom out at 320kbps on every default branch",
  );
});

test("desktop quality select offers 320 first and labels it max", () => {
  const src = read("src/settings.js");
  assert.match(src, /\["320kbps", "320 kbps — max"\]/);
});

test("the Rust ladder takes the best tier, never a forced downgrade", () => {
  const src = read("src-tauri/src/jiosaavn.rs");
  assert.ok(src.includes("fn best_quality"), "best_quality must exist");
  assert.ok(src.includes("fn ranked_tiers"), "ranked_tiers must exist");
  assert.match(
    src,
    /chosen_quality/,
    "resolve must report the tier actually chosen (painted by #np-format)",
  );
});

test("the studio chain ships to both surfaces (T1 present)", () => {
  assert.ok(read("src/dsp.js").includes("export function buildStudioChain"));
  const pb = read("src/playback.js");
  assert.match(pb, /from "\.\/dsp\.js"/, "desktop wires the shared chain");
  assert.match(pb, /applyDesktopEq/, "desktop applies the chain on the play path");
  assert.ok(pb.includes('crossOrigin = "anonymous"'),
    "desktop elements load CORS-clean — relay is a different origin, so tainted media is spec-mandated silence (2026-10-08 P36 class)");
  const mp = read("src/mobile/player.js");
  assert.match(mp, /from "\.\.\/dsp\.js"/, "mobile delegates to the shared chain");
  assert.ok(mp.includes('crossOrigin = "anonymous"'), "mobile elements load CORS-clean");
  assert.ok(!mp.includes("const MAP = {"), "the legacy 3-band MAP must be gone");
});

test("dsp.js stays dependency-free (both-graph safety)", () => {
  const src = read("src/dsp.js");
  assert.ok(!/\bimport\b/.test(src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    "dsp.js must not import anything");
  assert.ok(!src.includes("from \""), "no module specifier strings");
});

test("the quality system is fully automated — no settings toggles anywhere", () => {
  // Desktop settings panel: no EQ / Immersive rows, no live-A/B event.
  const st = read("src/settings.js");
  assert.ok(!st.includes('"#set-eq"'.slice(1)) && !/set-eq/.test(st), "no desktop EQ select");
  assert.ok(!/set-spatial/.test(st), "no desktop Immersive / intensity controls");
  assert.ok(!st.includes("tm-eq-changed"), "no settings→playback A/B event");
  // The toggle-era pref keys are gone from the desktop sync allowlist, so a
  // sync can never re-create what the migration cleared.
  const sync = read("src/sync.js");
  for (const k of ["tm-eq-preset", "tm-normalize", "tm-eq-tracks", "tm-spatial-mode", "tm-spatial-int"]) {
    assert.ok(!sync.includes(k), `sync.js must not resurrect ${k}`);
  }
  // Mobile surfaces: no per-track EQ sheet, no menu entry, no settings rows.
  const menus = read("src/mobile/menus.js");
  assert.ok(!menus.includes("EQ for this track"), "no EQ track-menu entry");
  assert.ok(!menus.includes("__tmTrackEq"), "no per-track EQ sheet opener");
  const ap = read("src/mobile/audioplus.js");
  assert.ok(!/tm-eq-sheet|data-eq-|data-spatial/.test(ap), "audioplus keeps only crossfade");
  const binders = read("src/mobile/binders.js");
  assert.ok(!/["'?]m-eq|["'?]m-normalize/.test(binders), "no mobile EQ/normalize settings rows");
});

test("players ship the automated defaults and clear stale toggle keys", () => {
  const pb = read("src/playback.js");
  assert.match(pb, /AUTO_EQ = "flat"/, "desktop ships a transparent EQ");
  assert.match(pb, /AUTO_SPATIAL = \{ mode: "hall", intensity: 60 \}/, "desktop ships the built-in hall room");
  assert.match(pb, /clearToggleKeys/), "desktop clears toggle-era keys at boot";
  const mp = read("src/mobile/player.js");
  assert.match(mp, /clearToggleKeys/, "mobile clears toggle-era keys at boot");
  assert.match(mp, /applyStudioChain\(nodes, "flat", true\)/, "mobile ships a transparent EQ + always-armed normalize");
  assert.ok(!/resolveEqPreset|normalizeOnStored|spatialModeStored|spatialIntensityStored/.test(mp),
    "mobile player must not read toggle-era stored prefs");
  assert.ok(!/resolveEqPreset|normalizeOnStored|spatialModeStored|spatialIntensityStored/.test(pb),
    "desktop player must not read toggle-era stored prefs");
});
