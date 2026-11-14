import assert from "node:assert/strict";
import test from "node:test";
import { activeLyricIndex, normalizeSyncedLines } from "../src/mobile/lyric-timeline.js";

test("active line lookup handles before-first, boundaries, and after-last times", () => {
  const times = [2, 5, 9];
  assert.equal(activeLyricIndex(times, 1.99), -1);
  assert.equal(activeLyricIndex(times, 2), 0);
  assert.equal(activeLyricIndex(times, 8.99), 1);
  assert.equal(activeLyricIndex(times, 20), 2);
});

test("active line lookup chooses the last duplicate timestamp like the old scan", () => {
  assert.equal(activeLyricIndex([1, 4, 4, 7], 4), 2);
});

test("active line lookup returns no match for empty or non-finite input", () => {
  assert.equal(activeLyricIndex([], 1), -1);
  assert.equal(activeLyricIndex([1, 2], Number.NaN), -1);
});

test("synced lines are sorted stably and malformed rows are ignored", () => {
  assert.deepEqual(
    normalizeSyncedLines([[5, "later"], [2, "first"], [2, "same time"], ["bad", "invalid"], [null, "null"], ["", "empty"], [8, null]]),
    [[2, "first"], [2, "same time"], [5, "later"]],
  );
});
