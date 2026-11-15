import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { silenceStep } from "../src/mobile/silence-skip.js";

test("skip silence is opt-in in the settings switch and its initial paint", () => {
  const binders = readFileSync(new URL("../src/mobile/binders.js", import.meta.url), "utf8");
  assert.match(binders, /flip\("m-skip-silence", "tm-skip-silence", \(on\) => \(on \? "Skip silence on" : "Skip silence off"\), "0"\);/);
  assert.match(binders, /\["m-skip-silence", "tm-skip-silence", "0"\]/);
});

test("silence must remain below threshold for the full hold interval", () => {
  assert.deepEqual(silenceStep(0.001, 0, 1000), { since: 1000, skip: false });
  assert.deepEqual(silenceStep(0.001, 1000, 2099), { since: 1000, skip: false });
  assert.deepEqual(silenceStep(0.001, 1000, 2100), { since: 1000, skip: true });
});

test("audible samples and invalid readings reset the silence interval", () => {
  assert.deepEqual(silenceStep(0.02, 1000, 3000), { since: 0, skip: false });
  assert.deepEqual(silenceStep(NaN, 1000, 3000), { since: 0, skip: false });
});
