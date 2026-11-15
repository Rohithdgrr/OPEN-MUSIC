import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEqBands, MOBILE_EQ_DEFAULT, normalizeEqBands, parseEqBands } from "../src/mobile/eqstate.js";
import { readFile } from "node:fs/promises";

test("mobile EQ accepts five bounded integer dB gains and rejects malformed storage", () => {
  assert.deepEqual(normalizeEqBands([-99, -2.6, "3", 12.6, Infinity]), [-12, -3, 3, 12, 0]);
  assert.deepEqual(normalizeEqBands([1, 2]), MOBILE_EQ_DEFAULT);
  assert.deepEqual(parseEqBands("{"), MOBILE_EQ_DEFAULT);
  assert.deepEqual(parseEqBands('["2", -4, 0, 3, 18]'), [2, -4, 0, 3, 12]);
});

test("EQ updates all five filters and tolerates a filter without automation support", () => {
  const values = [];
  const chain = {
    ctx: { currentTime: 7 },
    bands: Array.from({ length: 5 }, (_, index) => ({
      gain: index === 2 ? {} : { setTargetAtTime: (gain, at, duration) => values.push([index, gain, at, duration]) },
    })),
  };

  assert.equal(applyEqBands(chain, [-2, 0, 3, 8, 15]), true);
  assert.deepEqual(values, [
    [0, -2, 7, 0.03],
    [1, 0, 7, 0.03],
    [3, 8, 7, 0.03],
    [4, 12, 7, 0.03],
  ]);
  assert.equal(applyEqBands({ bands: [] }, []), false);
});

test("player applies persisted EQ after the flat automatic chain and updates every transport chain", async () => {
  const player = await readFile(new URL("../src/mobile/player.js", import.meta.url), "utf8");
  assert.match(player, /applyStudioChain\(nodes, "flat", true\);\s*applyEqBands\(nodes, readMobileEqBands\(\)\)/);
  assert.match(player, /for \(const chain of eqChains\.values\(\)\) applyEqBands\(chain, gains\)/);
});

test("Now Playing exposes an accessible EQ dialog with reset and five labeled bands", async () => {
  const [ui, css] = await Promise.all([
    readFile(new URL("../src/mobile/audioplus.js", import.meta.url), "utf8"),
    readFile(new URL("../src/mobile/shell.css", import.meta.url), "utf8"),
  ]);
  assert.match(ui, /aria-labelledby="mobile-eq-title"/);
  assert.match(ui, /min="-12" max="12" step="1"/);
  assert.match(ui, /data-eq-reset/);
  assert.match(ui, /MOBILE_EQ_LABELS\.map/);
  assert.match(css, /\.mobile-eq-band input[\s\S]*min-height: 44px/);
});
