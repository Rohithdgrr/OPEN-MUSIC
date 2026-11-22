import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { radioFallback } from "../src/mobile/radiofallback.js";

const track = (id) => ({ id, title: `Track ${id}` });
const selectAll = (rows) => rows;
const ignoreError = () => {};

test("radio fallback prefers fresh seed-artist rows in upstream order", async () => {
  const calls = [];
  const out = await radioFallback(
    { artist: "Artist A" },
    [track("queued")],
    async (command, args) => {
      calls.push([command, args]);
      if (command === "search_songs") {
        return { tracks: [track("queued"), track("a"), track("a"), track("b")] };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    selectAll,
    ignoreError,
  );

  assert.deepEqual(out.map((row) => row.id), ["a", "b"]);
  assert.deepEqual(calls.map(([command]) => command), ["search_songs"]);
});

test("empty artist search falls back to Home chart tracks without reordering", async () => {
  const calls = [];
  const out = await radioFallback(
    { artist: "Artist A" },
    [track("queued"), track("top-1")],
    async (command, args) => {
      calls.push([command, args]);
      if (command === "search_songs") return { tracks: [] };
      if (command === "home_feed") {
        return {
          charts: [{ id: "chart-1" }, { id: "chart-2" }],
          top_tracks: [track("top-1"), track("top-2"), track("top-2")],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    selectAll,
    ignoreError,
  );

  assert.deepEqual(out.map((row) => row.id), ["top-2"]);
  assert.deepEqual(calls.map(([command]) => command), ["search_songs", "home_feed"]);
});

test("radio fallback continues to the next chart after a failed or empty chart", async () => {
  const calls = [];
  const errors = [];
  const out = await radioFallback(
    null,
    [track("queued")],
    async (command, args) => {
      calls.push([command, args]);
      if (command === "home_feed") {
        return { charts: [{ id: "chart-1" }, { id: "chart-2" }, { id: "chart-3" }, { id: "chart-4" }] };
      }
      if (args.id === "chart-1") throw new Error("temporary failure");
      if (args.id === "chart-2") return [track("queued")];
      if (args.id === "chart-3") return [track("third"), track("fourth")];
      throw new Error(`unexpected chart: ${args.id}`);
    },
    (rows) => rows.filter((row) => row.id !== "queued"),
    (command, error) => errors.push([command, String(error)]),
  );

  assert.deepEqual(out.map((row) => row.id), ["third", "fourth"]);
  assert.deepEqual(errors, [["playlist_tracks", "Error: temporary failure"]]);
  assert.deepEqual(
    calls.filter(([command]) => command === "playlist_tracks").map(([, args]) => args.id),
    ["chart-1", "chart-2", "chart-3"],
    "only the first three charts are considered and lookup stops on usable rows",
  );
});

test("ineligible artist results do not prevent an eligible chart fallback", async () => {
  const calls = [];
  const out = await radioFallback(
    { artist: "Artist A" },
    [],
    async (command) => {
      calls.push(command);
      if (command === "search_songs") return { tracks: [track("recent")] };
      if (command === "home_feed") return { charts: [{ id: "chart-1" }], top_tracks: [track("fresh")] };
      throw new Error(`unexpected command: ${command}`);
    },
    (rows) => rows.filter((row) => row.id !== "recent"),
    ignoreError,
  );

  assert.deepEqual(out.map((row) => row.id), ["fresh"]);
  assert.deepEqual(calls, ["search_songs", "home_feed"]);
});

test("the radio applies its existing eligibility gate to each fallback source", async () => {
  const src = await readFile(new URL("../src/mobile/radio.js", import.meta.url), "utf8");
  assert.match(src, /import \{ radioFallback \} from "\.\/radiofallback\.js"/);
  assert.match(src, /radioFallback\(seed, queue, invoke, \(rows\) => pickBatch\(rows, signals/);
});
