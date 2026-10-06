// vault-quota.test.mjs — LRU eviction ordering for the Android vault quota.
// Spec: docs/feature-list.md §10 P0-1 (ported from desktop vault.js:410-467).
// quota.js is pure (no window/localStorage/invoke) so this runs in plain node;
// the plays-ledger → map building lives in shared.js and is covered by the
// desktop parity of its input order (newest-first, first entry wins).
import { test } from "node:test";
import assert from "node:assert/strict";

import { quotaBytesFromGb, pickEvictVictims } from "../src/mobile/quota.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

test("quotaBytesFromGb: GB in, bytes out; unset/negative/junk = unlimited", () => {
  assert.equal(quotaBytesFromGb("5"), 5 * GB);
  assert.equal(quotaBytesFromGb("2.5"), 2.5 * GB);
  assert.equal(quotaBytesFromGb(""), 0);
  assert.equal(quotaBytesFromGb(null), 0);
  assert.equal(quotaBytesFromGb("-1"), 0);
  assert.equal(quotaBytesFromGb("abc"), 0);
});

test("unlimited cap or already under quota evicts nothing", () => {
  const entries = [
    { id: "a", bytes: 10 * MB, at: 1, path: "/a" },
    { id: "b", bytes: 10 * MB, at: 2, path: "/b" },
  ];
  assert.deepEqual(pickEvictVictims(entries, new Map(), 0, "a", []), []);
  assert.deepEqual(pickEvictVictims(entries, new Map(), 1 * GB, "a", []), []);
  assert.deepEqual(pickEvictVictims([], new Map(), 1 * MB, null, []), []);
});

test("over quota → least-recently played first, stops once under", () => {
  const entries = [
    { id: "old", bytes: 60 * MB, at: 10, path: "/old" },
    { id: "mid", bytes: 60 * MB, at: 20, path: "/mid" },
    { id: "new", bytes: 60 * MB, at: 30, path: "/new" },
  ];
  // Plays ledger (per id): old < new < mid — order comes from the map, not `at`.
  const played = new Map([
    ["old", 100],
    ["new", 200],
    ["mid", 300],
  ]);
  // 180 MB total vs 130 MB cap: evicting `old` (60) lands at 120 ≤ 130 → one victim.
  const victims = pickEvictVictims(entries, played, 130 * MB, null, []);
  assert.deepEqual(victims.map((e) => e.id), ["old"]);
});

test("never evicts the playing track or an in-flight download", () => {
  const entries = [
    { id: "playing", bytes: 100 * MB, at: 1, path: "/p" },
    { id: "active", bytes: 100 * MB, at: 2, path: "/a" },
    { id: "lru1", bytes: 100 * MB, at: 3, path: "/1" },
    { id: "lru2", bytes: 100 * MB, at: 4, path: "/2" },
  ];
  const played = new Map([
    ["playing", 999],
    ["active", 998],
    ["lru1", 10],
    ["lru2", 20],
  ]);
  // 400 MB vs 150 MB cap; protected entries stay no matter what, so the
  // result is every evictable entry in LRU order (cap is unreachable by design).
  const victims = pickEvictVictims(entries, played, 150 * MB, "playing", ["active"]);
  assert.deepEqual(victims.map((e) => e.id), ["lru1", "lru2"]);
});

test("unplayed entries tie-break on oldest added (`at`)", () => {
  const entries = [
    { id: "x", bytes: 100 * MB, at: 5, path: "/x" },
    { id: "y", bytes: 100 * MB, at: 1, path: "/y" },
  ];
  // No ledger entries → fallback order is `at`; y is older → evicted first.
  const victims = pickEvictVictims(entries, new Map(), 150 * MB, null, []);
  assert.deepEqual(victims.map((e) => e.id), ["y"]);
});

test("byte-less and malformed entries cannot crash the picker", () => {
  const entries = [
    { id: "nobytes", at: 1, path: "/n" },
    null,
    { id: "ok", bytes: 50 * MB, at: 2, path: "/o" },
  ];
  const victims = pickEvictVictims(entries, new Map(), 25 * MB, null, []);
  assert.ok(Array.isArray(victims));
  assert.ok(victims.every((e) => e && e.id));
});
