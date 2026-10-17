// Query-understanding contract: what the parser lifts out of a typed query,
// what it leaves behind for the catalog, and how relevance orders a page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fuzzyScore, querySim } from "../src/fuzzy.js";
import { albumKey, cleanTitle, didYouMean, leadArtists, matchesFilters, normalize, parseQuery, rankTracks, relevance, SOURCE_EXTRA_MAX, sourceMatch, sourceOrder, sourcePlan, sourceRows } from "../src/query.js";

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

test("relevance: provenance doesn't hide an exact title from the original", () => {
  // Identical text score: only the bonuses may decide. Live finding — the
  // catalog files the original under a compilation while a cover carries the
  // bare title, so without cleaning the "(From …)" clause the cover won.
  const q = parseQuery("tum hi ho");
  const score = () => 0.5;
  const original = {
    id: "o",
    title: 'Tum Hi Ho (From "Aashiqui 2")',
    artist: "Arijit Singh, Mithoon",
    album: "Best Of Arijit Singh - Collection Of Romantic Songs",
    language: "hindi",
    plays: 374140216,
  };
  const cover = {
    id: "c",
    title: "Tum Hi Ho",
    artist: "Gurbani Bhatia",
    album: "Heartstrings",
    language: "hindi",
    plays: 315697,
  };
  assert.ok(
    relevance(original, q, score) > relevance(cover, q, score),
    "the 374M original outranks the 315k cover",
  );
});

test("relevance: region still nudges, personal taste no longer does", () => {
  const q = parseQuery("trance");
  const score = (t) => fuzzyScore(q.text, t.title, t.artist, t.album);
  const base = { id: "1", title: "Solaris", artist: "Kaelen" };
  const loved = { ...base, id: "2" };
  const lovedScore = relevance(loved, q, score, { played: new Set(["2"]), liked: new Set(["2"]) });
  assert.equal(lovedScore, relevance(base, q, score), "played/liked must not lift a row (§8.9)");
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

// ---------------------------------------------------- source-first (§8.11) -

test("albumKey folds one movie's naming variants to a single key", () => {
  assert.equal(albumKey('Gaali Vaaluga - Official Remix (From "Agnyaathavaasi")'), "agnyaathavaasi");
  assert.equal(albumKey("Agnyaathavaasi"), "agnyaathavaasi");
  assert.equal(albumKey("Agnyaathavaasi (Original Motion Picture Soundtrack)"), "agnyaathavaasi");
  assert.equal(albumKey("Believer"), "believer");
  assert.equal(albumKey(""), "");
  assert.equal(albumKey(null), "");
});

test("leadArtists splits credits; over-splitting only widens a match", () => {
  assert.deepEqual(leadArtists({ artist: "Anirudh Ravichander" }), ["anirudh ravichander"]);
  assert.deepEqual(leadArtists({ artist: "Imagine Dragons, Kaskade" }), ["imagine dragons", "kaskade"]);
  assert.deepEqual(leadArtists({ artist: "Nakash Aziz & Arjun Chandy feat. X" }), [
    "nakash aziz",
    "arjun chandy",
    "x",
  ]);
  assert.deepEqual(leadArtists({}), []);
});

test('cleanTitle strips the (From "…") provenance but keeps real suffixes', () => {
  assert.equal(cleanTitle('Tum Hi Ho (From "Aashiqui 2")'), "Tum Hi Ho");
  assert.equal(
    cleanTitle('Gaali Vaaluga - Official Remix (From "Agnyaathavaasi")'),
    "Gaali Vaaluga - Official Remix",
  );
  assert.equal(cleanTitle("Kesariya"), "Kesariya");
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle(null), "");
});

test("sourcePlan: film rows lead with the movie, others with the artist", () => {
  const film = {
    title: "Gaali Vaaluga",
    artist: "Anirudh Ravichander",
    album: "Agnyaathavaasi",
    language: "telugu",
  };
  const pf = sourcePlan(film);
  assert.equal(pf.kind, "album");
  assert.equal(pf.key, "agnyaathavaasi");
  assert.equal(pf.query, "Agnyaathavaasi");

  const eng = {
    title: "Believer",
    artist: "Imagine Dragons, Kaskade",
    album: "Believer (Kaskade Remix)",
    language: "english",
  };
  const pe = sourcePlan(eng);
  assert.equal(pe.kind, "artist");
  assert.equal(pe.query, "Imagine Dragons");
  assert.ok(pe.keys.includes("imagine dragons"));

  const quiet = { title: "x", artist: "A", album: "Al", language: "" };
  assert.equal(sourcePlan(quiet).kind, "artist", "no language reads as singer-driven");
  assert.equal(sourcePlan({ title: "x", artist: "", album: "", language: "" }), null);
  assert.equal(sourcePlan(null), null);
});

test("sourcePlan: a compilation album doesn't hide the film named in the title", () => {
  const comp = {
    title: 'Tum Hi Ho (From "Aashiqui 2")',
    artist: "Arijit Singh, Mithoon",
    album: "Best Of Arijit Singh - Collection Of Romantic Songs",
    language: "hindi",
  };
  const p = sourcePlan(comp);
  assert.equal(p.kind, "album");
  assert.equal(p.key, "aashiqui 2");
  assert.equal(p.query, "Aashiqui 2");
});

test("sourceMatch: film songs lifted onto other compilations still belong", () => {
  const plan = { kind: "album", key: "aashiqui 2", query: "Aashiqui 2" };
  assert.ok(
    sourceMatch({ title: 'Sunn Raha Hai (From "Aashiqui 2")', album: "Emraan Hashmi Hits", artist: "X" }, plan),
    "the title's own provenance is enough",
  );
  assert.ok(
    sourceMatch({ title: "Tum Hi Ho", album: "Aashiqui 2", artist: "Arijit Singh" }, plan),
    "a bare album name still matches",
  );
  assert.ok(
    !sourceMatch({ title: "Tum Hi Ho", album: "Heartstrings", artist: "Gurbani Bhatia" }, plan),
    "a cover's own compilation does not",
  );
});

test("sourceOrder: the anchor's source leads, the rest keeps its rank order", () => {
  const t = (id, album, artist, language) => ({ id, title: id, album, artist, language });
  const ranked = [
    t("anchor", "Agnyaathavaasi", "Anirudh Ravichander", "telugu"),
    t("other", "Some Other", "Someone", "telugu"),
    t("mate", "Agnyaathavaasi", "Anirudh Ravichander", "telugu"),
    t("remix", 'Gaali Vaaluga - Official Remix (From "Agnyaathavaasi")', "Anirudh Ravichander", "telugu"),
    t("tail", "Zzz", "Zed", "telugu"),
  ];
  assert.deepEqual(sourceOrder(ranked).map((x) => x.id), ["anchor", "mate", "remix", "other", "tail"]);

  const eng = [
    t("anchor", "Believer", "Imagine Dragons", "english"),
    t("cover", "You Made Me A Believer", "The Cameron Collective", "english"),
    t("official", "Evolve", "Imagine Dragons", "english"),
  ];
  assert.deepEqual(sourceOrder(eng).map((x) => x.id), ["anchor", "official", "cover"]);

  assert.deepEqual(sourceOrder([t("solo", "Single", "A", "english")]).map((x) => x.id), ["solo"]);
  assert.deepEqual(sourceOrder([]), []);
  const noname = [t("a", "", "", ""), t("b", "", "", "")];
  assert.deepEqual(sourceOrder(noname).map((x) => x.id), ["a", "b"], "nothing to name → untouched");
});

test("sourceRows: keeps only the source's own rows, dedupes, caps", () => {
  const plan = { kind: "album", key: "agnyaathavaasi", query: "Agnyaathavaasi" };
  const fetched = [
    { id: "1", title: "Baitikochi Chuste", album: "Agnyaathavaasi", artist: "Anirudh Ravichander" },
    { id: "1", title: "Baitikochi Chuste", album: "Agnyaathavaasi", artist: "Anirudh Ravichander" },
    { id: "2", title: "Kannada One", album: "Agnyathavasi", artist: "X" },
    { id: "3", title: "Swagatham Krishna", album: "Agnyaathavaasi", artist: "Niranjana Ramanan" },
  ];
  const out = sourceRows(fetched, plan, new Set(["3"]));
  assert.deepEqual(out.map((x) => x.id), ["1"], "dupe, alien album and already-shown rows all drop");

  const artistPlan = { kind: "artist", keys: ["imagine dragons"], query: "Imagine Dragons" };
  const covers = [
    { id: "c1", title: "Believer", album: "You Made Me A Believer", artist: "The Cameron Collective" },
    { id: "o1", title: "Thunder", album: "Evolve", artist: "Imagine Dragons" },
  ];
  assert.deepEqual(sourceRows(covers, artistPlan, new Set()).map((x) => x.id), ["o1"]);

  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, album: "Agnyaathavaasi", artist: "A" }));
  assert.equal(sourceRows(many, plan, new Set()).length, SOURCE_EXTRA_MAX);
});
