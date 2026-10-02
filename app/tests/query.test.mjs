// Query-understanding contract: what the parser lifts out of a typed query,
// what it leaves behind for the catalog, and how relevance orders a page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fuzzyScore, querySim } from "../src/fuzzy.js";
import { didYouMean, matchesFilters, normalize, parseQuery, rankTracks, relevance } from "../src/query.js";

test("normalize folds case, accents, ampersands and punctuation", () => {
  assert.equal(normalize("  ARIJIT   SINGH  "), "arijit singh");
  assert.equal(normalize("Brockhäuser"), "brockhauser");
  assert.equal(normalize("Simon & Garfunkel"), "simon and garfunkel");
  assert.equal(normalize("don't stop"), "dont stop");
  assert.equal(normalize("Kesariya (Remix)"), "kesariya remix");
  assert.equal(normalize(null), "");
});

test("parseQuery pulls a year out and leaves the text for upstream", () => {
  const q = parseQuery("kesariya 2022");
  assert.equal(q.year, 2022);
  assert.equal(q.text, "kesariya", "the year is not sent to the catalog");
  assert.deepEqual(q.tokens, ["kesariya"]);
});

test("parseQuery reads language, keeping several", () => {
  const q = parseQuery("arijit singh punjabi");
  assert.equal(q.language, "punjabi");
  assert.equal(q.text, "arijit singh");
  const multi = parseQuery("romantic hindi tamil songs");
  assert.deepEqual(multi.languages, ["hindi", "tamil"]);
  assert.equal(multi.mood, "romantic", "mood is a filter too");
  assert.equal(multi.wantsEntity, "tracks");
  assert.equal(multi.text, "romantic");
});

test("parseQuery reads decades, ranges, @artist, #album and intent words", () => {
  assert.equal(parseQuery("arijit 90s").decade, 1990, "short decade form");
  assert.equal(parseQuery("rock 2000s").decade, 2000);
  assert.equal(parseQuery("pop 1990s").decade, 1990);
  const range = parseQuery("rock 2000-2009");
  assert.deepEqual(range.yearRange, [2000, 2009]);
  assert.equal(range.text, "rock");
  const at = parseQuery("@arijit #brahmastra");
  assert.equal(at.artist, "arijit");
  assert.equal(at.album, "brahmastra");
  assert.equal(at.text, "@arijit #brahmastra", "no free text, so the named entity goes upstream");
  assert.ok(at.tokens.includes("arijit") && at.tokens.includes("brahmastra"));
  assert.equal(parseQuery("brahmastra album").wantsEntity, "albums");
  assert.equal(parseQuery("arijit artist").wantsEntity, "artists");
  assert.equal(parseQuery("workout mix").wantsEntity, "playlists");
});

test("parseQuery only reads a region when it is uppercase", () => {
  assert.equal(parseQuery("trance IN").region, "IN");
  assert.equal(parseQuery("a song in the dark").region, "", "lowercase 'in' is a word");
  assert.equal(parseQuery("no regrets").region, "", "'no' is not Norway here");
  assert.equal(parseQuery("romantic US").region, "US");
});

test("parseQuery protects quoted text and filter-only queries", () => {
  const q = parseQuery('"tum hi ho" 2022');
  assert.equal(q.exact, true);
  assert.equal(q.text, "tum hi ho", "quotes are stripped, contents kept");
  assert.equal(q.year, 2022);
  const only = parseQuery("2023");
  assert.equal(only.year, 2023);
  assert.equal(only.text, "2023", "an all-filter query still reaches the catalog");
});

test("matchesFilters is strict on language and lenient on a missing year", () => {
  const q = parseQuery("kesariya 2022");
  assert.equal(matchesFilters({ language: "hindi", year: "2022" }, q), true);
  assert.equal(matchesFilters({ language: "hindi", year: "2019" }, q), false, "wrong year is out");
  assert.equal(matchesFilters({ language: "tamil" }, parseQuery("kesariya punjabi")), false, "wrong language is out");
  assert.equal(matchesFilters({ language: "punjabi" }, parseQuery("kesariya punjabi")), true);
  assert.equal(matchesFilters({ language: "hindi", year: "2019" }, q), false, "wrong year is out");
  assert.equal(matchesFilters({ language: "hindi" }, q), true, "no year declared is not a mismatch");
  const plain = parseQuery("kesariya");
  assert.equal(matchesFilters({ language: "tamil" }, plain), true, "no language filter, no opinion");
});

test("relevance: text match dominates, filters only reorder", () => {
  const q = parseQuery("tum hi ho");
  const score = (t) => fuzzyScore(q.text, t.title, t.artist, t.album);
  const exact = { id: "1", title: "Tum Hi Ho", artist: "Arijit Singh", language: "hindi" };
  const loose = { id: "2", title: "Totally Different", artist: "Someone", language: "tamil" };
  assert.ok(relevance(exact, q, score) > relevance(loose, q, score));
  // A track the query's language excludes must not outrank a matching one.
  const langQ = parseQuery("punjabi songs");
  const punjabi = { id: "3", title: "Brown Rang", artist: "H-Dhami", language: "punjabi" };
  const other = { id: "4", title: "Brown Rang", artist: "H-Dhami", language: "tamil" };
  assert.ok(relevance(punjabi, langQ, score) > relevance(other, langQ, score));
});

test("relevance: @artist, #album and an exact phrase all score", () => {
  const at = parseQuery("@arijit");
  const score = (t) => fuzzyScore(at.text, t.title, t.artist, t.album);
  const his = { id: "1", title: "Kesariya", artist: "Arijit Singh" };
  const theirs = { id: "2", title: "Kesariya", artist: "Pritam" };
  assert.ok(relevance(his, at, score) > relevance(theirs, at, score));

  const exact = parseQuery('"kesariya"');
  const on = { id: "3", title: "Kesariya", artist: "Arijit Singh" };
  const off = { id: "4", title: "Kesariya XYZ", artist: "Arijit Singh" };
  assert.ok(relevance(on, exact, score) > relevance(off, exact, score));
});

test("relevance: taste and region nudges, without overriding the text", () => {
  const q = parseQuery("trance");
  const score = (t) => fuzzyScore(q.text, t.title, t.artist, t.album);
  const base = { id: "1", title: "Solaris", artist: "Kaelen" };
  const loved = { ...base, id: "2" };
  const lovedScore = relevance(loved, q, score, { played: new Set(["2"]), liked: new Set(["2"]) });
  assert.ok(lovedScore > relevance(base, q, score), "played/liked lifts a row");
  const inRegion = relevance({ ...base, id: "3", language: "hindi" }, q, score, { region: "IN" });
  const outRegion = relevance({ ...base, id: "4", language: "arabic" }, q, score, { region: "IN" });
  assert.ok(inRegion > outRegion, "the listener's region lifts its own languages");
});

test("rankTracks is stable and puts the best match first", () => {
  const q = parseQuery("tum hi ho");
  const score = (t) => fuzzyScore(q.text, t.title, t.artist, t.album);
  const list = [
    { id: "1", title: "Bohemian Rhapsody", artist: "Queen" },
    { id: "2", title: "Tum Hi Ho", artist: "Arijit Singh" },
    { id: "3", title: "Tum Hi Ho", artist: "Arijit Singh" },
  ];
  const ranked = rankTracks(list, q, score);
  assert.equal(ranked[0].id, "2", "the hit leads");
  assert.deepEqual([ranked[1].id, ranked[2].id], ["3", "1"], "the tied pair keeps API order");
});

test("rankTracks on an empty or filter-only query keeps the incoming order", () => {
  const list = [{ id: "1" }, { id: "2" }];
  const q = parseQuery("");
  assert.deepEqual(rankTracks(list, q, () => 0).map((t) => t.id), ["1", "2"]);
  assert.deepEqual(rankTracks([], q, () => 0), []);
});

test("didYouMean offers near misses above the similarity gate", () => {
  const out = didYouMean("tum hi hon", ["Tum Hi Ho", "Tum Hi Ho (Live)", "Bohemian Rhapsody"], querySim);
  assert.ok(out.length >= 1);
  assert.ok(out.every((c) => c.sim >= 0.55));
  assert.ok(!out.some((c) => /Bohemian/.test(c.title)), "unrelated suggestions are dropped");
  assert.deepEqual(didYouMean("", ["x"], querySim), [], "no query, no suggestions");
  assert.deepEqual(didYouMean("abc", null, querySim), [], "no candidates, no crash");
});
