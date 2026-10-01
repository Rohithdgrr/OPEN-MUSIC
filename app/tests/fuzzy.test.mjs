// Fuzzy search scoring contract (review 3.1): bounded Levenshtein,
// similarity and the relevance score that ranks the results table and
// picks "did you mean" candidates. Run with: npm test (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";

import { editSim, fuzzyScore, levenshtein, querySim } from "../src/fuzzy.js";

test("levenshtein basics", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("तुम ही हो", "तुम ही हन"), 1, "devanagari counts by code point");
});

test("levenshtein bails out at max", () => {
  assert.equal(levenshtein("aaaaaaaa", "bbbbbbbb", 2), 3, "returns max + 1 when over");
  assert.equal(levenshtein("short", "a-much-longer-string", 3), 4);
});

test("editSim ranges 0..1", () => {
  assert.equal(editSim("trance", "trance"), 1);
  assert.ok(editSim("trance", "trace") > 0.6 && editSim("trance", "trace") < 1);
  assert.ok(editSim("abc", "xyz") < 0.5);
  assert.equal(editSim("", ""), 1);
});

test("fuzzyScore prefers title hits over artist-only", () => {
  const title = fuzzyScore("tum hi ho", "Tum Hi Ho", "Arijit Singh");
  const artist = fuzzyScore("arijit", "Kun Faya Kun", "Arijit Singh");
  const none = fuzzyScore("tum hi ho", "Bohemian Rhapsody", "Queen");
  assert.ok(title > 0, "title match scores");
  assert.ok(artist > 0, "artist match scores");
  assert.equal(none, 0, "unrelated track scores 0");
});

test("fuzzyScore tolerates a typo", () => {
  const typo = fuzzyScore("tum hi hn", "Tum Hi Ho", "Arijit Singh");
  const exact = fuzzyScore("tum hi ho", "Tum Hi Ho", "Arijit Singh");
  assert.ok(typo > 0, "near-miss token still credits the row");
  assert.ok(exact > typo, "no-typo query scores higher");
});

test("fuzzyScore: one bad token disqualifies", () => {
  assert.equal(fuzzyScore("tum hi zzzz", "Tum Hi Ho", "Arijit Singh"), 0);
});

test("fuzzyScore whole-phrase bonus and empty guards", () => {
  const phrase = fuzzyScore("tum hi aana", "Tum Hi Aana", "Atif Aslam");
  const parts = fuzzyScore("tum aana", "Tum Hi Aana", "Atif Aslam");
  assert.ok(phrase > parts, "full-phrase hit outranks scattered tokens");
  assert.equal(fuzzyScore("", "Tum Hi Aana", "Atif Aslam"), 0, "empty query scores 0");
  assert.equal(fuzzyScore("q", "", ""), 0, "empty track scores 0");
});

test("querySim ranks close corrections above unrelated ones", () => {
  const close = querySim("tum hi hon", "Tum Hi Aana");
  const far = querySim("tum hi hon", "Bohemian Rhapsody");
  assert.ok(close > 0.55, "close correction passes the did-you-mean gate");
  assert.ok(far < close, "unrelated title ranks lower");
  assert.equal(querySim("same", "same"), 1);
});
