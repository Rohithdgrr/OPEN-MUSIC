// smart-playlists.test.mjs — auto-playlist rules (DOM-free, no Tauri needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { favsNotSaved, topPlayedTracks } from "../src/smart.js";

const DAY = 24 * 3600 * 1000;
const NOW = 1_700_000_000_000;

test("topPlayedTracks ranks by count inside the 30d window", () => {
  const plays = [
    { id: "old", count: 99, ts: NOW - 40 * DAY },
    { id: "b", count: 2, ts: NOW - 2 * DAY },
    { id: "a", count: 5, ts: NOW - 1 * DAY },
    { id: "c", count: 5, ts: NOW - 3 * DAY },
  ];
  const out = topPlayedTracks(plays, NOW);
  assert.deepEqual(
    out.map((t) => t.id),
    ["a", "c", "b"],
    "40-day-old giant excluded, ties break newest-first",
  );
});

test("topPlayedTracks caps at n and never mutates the input", () => {
  const plays = Array.from({ length: 60 }, (_, i) => ({
    id: `t${i}`,
    count: 60 - i,
    ts: NOW,
  }));
  const snapshot = JSON.stringify(plays);
  const out = topPlayedTracks(plays, NOW);
  assert.equal(out.length, 50);
  assert.equal(JSON.stringify(plays), snapshot);
});

test("topPlayedTracks drops rows without id or timestamp", () => {
  const out = topPlayedTracks(
    [{ id: "", count: 9, ts: NOW }, { count: 9, ts: NOW }, null],
    NOW,
  );
  assert.deepEqual(out, []);
});

test("favsNotSaved keeps hearts with no vault copy", () => {
  const favs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    favsNotSaved(favs, new Set(["b"])).map((t) => t.id),
    ["a", "c"],
  );
  assert.deepEqual(favsNotSaved(favs, []).length, 3);
  assert.deepEqual(favsNotSaved([], new Set(["a"])), []);
});
