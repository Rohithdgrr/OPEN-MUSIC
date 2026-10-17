// search-resilience.test.mjs — the search auto-retry ladder (DOM-free).
// Live wiring (timers, `online` recovery, IPC fault injection) is verified in
// docs/search-resilience.md §6; this file pins the policy itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SEARCH_RETRY_MS, nextRetryDelay } from "../src/searchretry.js";

test("ladder is bounded, grows, and ends", () => {
  assert.ok(SEARCH_RETRY_MS.length >= 2, "at least one retry must be possible");
  for (let i = 1; i < SEARCH_RETRY_MS.length; i++) {
    assert.ok(
      SEARCH_RETRY_MS[i] > SEARCH_RETRY_MS[i - 1],
      "each wait must grow — this heals blips, it is not a poller",
    );
  }
  assert.ok(SEARCH_RETRY_MS[0] <= 2500, "first retry must feel instant");
  assert.equal(nextRetryDelay(SEARCH_RETRY_MS.length), null, "exhausted");
  assert.equal(nextRetryDelay(999), null);
});

test("failure #1 gets the first wait; attempts map 1:1", () => {
  assert.equal(nextRetryDelay(0), SEARCH_RETRY_MS[0]);
  assert.equal(nextRetryDelay(1), SEARCH_RETRY_MS[1]);
  assert.equal(nextRetryDelay(SEARCH_RETRY_MS.length - 1), SEARCH_RETRY_MS.at(-1));
});

test("offline never schedules timers (the `online` event re-runs instead)", () => {
  assert.equal(nextRetryDelay(0, { offline: true }), null);
  assert.equal(nextRetryDelay(3, { offline: true }), null);
});

test("bad input cannot start a timer", () => {
  for (const bad of [-1, 0.5, NaN, "x", undefined, {}]) {
    assert.equal(nextRetryDelay(bad), null, `retry=${String(bad)}`);
  }
});

test("search.js wires the ladder into the failure path (policy is not dead code)", async () => {
  const src = await readFile(new URL("../src/search.js", import.meta.url), "utf8");
  assert.match(src, /nextRetryDelay\(retry, \{ offline \}\)/, "F1: catch schedules the ladder");
  assert.match(src, /searchRetryTimer = setTimeout/, "F1: the scheduled attempt exists");
  assert.match(src, /addEventListener\("online"/, "F2: recovery without a click");
});
