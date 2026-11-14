import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableYears,
  PLAY_EVENT_READ_LIMIT,
  PLAY_EVENT_STORE_CAP,
  summarizeYear,
} from "../src/mobile/year-summary.js";

test("year summary uses local calendar boundaries and de-duplicates tracks and lead artists", () => {
  const start = new Date(2024, 0, 1).getTime();
  const nextYear = new Date(2025, 0, 1).getTime();
  const result = summarizeYear(
    [
      { id: "a", ts: start - 1, artist: "Outside", ms_played: 90_000 },
      { id: "a", ts: start, artist: "Artist One, Guest", ms_played: 120_000 },
      { id: "a", ts: nextYear - 1, artist: "artist one, Another", ms_played: 180_000 },
      { id: "b", ts: nextYear, artist: "Next Year", ms_played: 60_000 },
    ],
    2024,
    4,
  );

  assert.equal(result.playCount, 2);
  assert.equal(result.uniqueTracks, 1);
  assert.equal(result.uniqueArtists, 1);
  assert.equal(result.playheadMs, 300_000);
});

test("empty, malformed, and retained-history-limited summaries remain honest", () => {
  const empty = summarizeYear([], 2024, 0);
  assert.deepEqual(
    [empty.playCount, empty.uniqueTracks, empty.uniqueArtists, empty.playheadMs],
    [0, 0, 0, 0],
  );
  assert.equal(empty.truncated, false);

  const partial = summarizeYear(
    [{ id: "x", ts: new Date(2024, 1, 29).getTime(), artist: "A", ms_played: -5 }],
    2024,
    PLAY_EVENT_STORE_CAP,
  );
  assert.equal(partial.playCount, 1);
  assert.equal(partial.playheadMs, 0);
  assert.equal(partial.truncated, true);

  assert.equal(
    summarizeYear(Array.from({ length: PLAY_EVENT_READ_LIMIT }, (_, i) => ({
      id: String(i),
      ts: new Date(2024, 0, 1).getTime(),
      artist: "",
    })), 2024, PLAY_EVENT_READ_LIMIT).truncated,
    true,
  );
});

test("available years include the current year and use local event years", () => {
  const events = [
    { ts: new Date(2023, 11, 31, 23, 59).getTime() },
    { ts: new Date(2024, 0, 1, 0, 1).getTime() },
    { ts: Number.NaN },
  ];
  assert.deepEqual(availableYears(events, 2025), [2025, 2024, 2023]);
});

test("invalid calendar years are rejected", () => {
  assert.throws(() => summarizeYear([], 0), RangeError);
  assert.throws(() => summarizeYear([], 2024.5), RangeError);
});
