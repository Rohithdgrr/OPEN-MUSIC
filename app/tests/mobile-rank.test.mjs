// mobile-rank.test.mjs — mobile search ordering (pure module, no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_SORTS, SORT_LABEL, nextSort, rankTracks } from "../src/mobile/rank.js";

const t = (title, extra = {}) => ({ title, artist: "x", album: "y", plays: 0, duration_secs: 100, hq: false, ...extra });

test("the sort cycle wraps back to relevance", () => {
  assert.deepEqual(SEARCH_SORTS, ["relevance", "bitrate", "popular", "longest", "az"]);
  let s = "relevance";
  for (const want of ["bitrate", "popular", "longest", "az", "relevance"]) {
    s = nextSort(s);
    assert.equal(s, want);
  }
  assert.ok(SORT_LABEL[s], "every sort has a label");
});

test("relevance puts the text match first, ties keep catalog order", () => {
  const page = [
    t("Kesariya", { plays: 5 }),
    t("Kesariya (Live)", { plays: 1 }),
    t("Kesariya 2", { plays: 9 }),
    t("Tum Hi Ho", { plays: 100 }),
  ];
  const out = rankTracks("Kesariya", page, "relevance").map((x) => x.title);
  assert.ok(out[0].startsWith("Kesariya"), `a matching title leads: ${out[0]}`);
  assert.equal(out.at(-1), "Tum Hi Ho", "the unrelated track sinks");
  // Equal scores must not reshuffle: popularity is the tie-break, then order.
  const same = [t("A", { plays: 1 }), t("B", { plays: 1 }), t("C", { plays: 1 })];
  assert.deepEqual(rankTracks("zzz", same, "relevance").map((x) => x.title), ["A", "B", "C"]);
  assert.deepEqual(rankTracks("zzz", same, "popular").map((x) => x.title), ["A", "B", "C"]);
  assert.deepEqual(rankTracks("zzz", [t("A", { plays: 1 }), t("B", { plays: 9 })], "popular").map((x) => x.title), ["B", "A"]);
});

test("each sort mode orders the way its name says", () => {
  const page = [
    t("b song", { plays: 1, duration_secs: 100, hq: false }),
    t("a song", { plays: 9, duration_secs: 300, hq: true }),
  ];
  assert.deepEqual(rankTracks("x", page, "az").map((x) => x.title), ["a song", "b song"]);
  assert.deepEqual(rankTracks("x", page, "longest").map((x) => x.title), ["a song", "b song"]);
  assert.deepEqual(rankTracks("x", page, "bitrate").map((x) => x.title), ["a song", "b song"], "hq first, then plays");
  assert.deepEqual(rankTracks("x", [t("a", { plays: 1, hq: true })], "popular").length, 1);
});

test("empty pages and junk fields are survivable", () => {
  assert.deepEqual(rankTracks("q", [], "relevance"), []);
  assert.deepEqual(rankTracks("q", null, "az"), []);
  const junk = [{ title: undefined }, { title: "b" }, { title: "a", plays: "x" }];
  assert.equal(rankTracks("q", junk, "az").length, 3, "no throw on missing fields");
  assert.equal(rankTracks("", junk, "relevance").length, 3, "empty query is allowed");
});