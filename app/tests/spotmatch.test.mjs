// spotmatch.test.mjs — unit tests for the Spotify import matcher
// (docs/spotify-android-canvas.md §10). Pure + dependency-injected, so
// plain node runs it. The first test is the regression that locks in the
// 2026-10-15 root cause: JioSaavn's search has no ISRC index, so an ISRC
// must never become the query.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  titleVariants,
  durationFactor,
  matchScore,
  pickBestMatch,
  matchTrackToCatalog,
  MATCH_THRESHOLD,
  SEARCH_LIMIT,
} = await import("../src/spotmatch.js");

// `search_songs` wire shape (snake_case Track).
const cand = (o) => ({
  id: o.id,
  title: o.title,
  artist: o.artist,
  album: o.album || "",
  duration_secs: o.duration_secs || 0,
  duration: "",
  image: "",
});

const believer = cand({ id: "exact", title: "Believer", artist: "Imagine Dragons", duration_secs: 204 });
const believerRemix = cand({ id: "remix", title: "Believer (Kaskade Remix)", artist: "Imagine Dragons, Kaskade", duration_secs: 190 });
const unrelated = cand({ id: "junk", title: "Mat Aazma Re", artist: "Pritam, KK, Sayeed Quadri", duration_secs: 251 });

test("matchTrackToCatalog — ISRC never becomes the search query (regression)", async () => {
  const seen = [];
  const invoke = async (cmd, params) => {
    seen.push({ cmd, params });
    return { tracks: [unrelated, believerRemix, believer] };
  };
  const want = { name: "Believer", artists: ["Imagine Dragons"], duration_ms: 204000, isrc: "USUM71703861" };
  const r = await matchTrackToCatalog(want, invoke);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, "search_songs");
  assert.equal(seen[0].params.query, "Believer Imagine Dragons");
  assert.ok(!/USUM71703861/.test(JSON.stringify(seen[0].params)), "ISRC leaked into the search params");
  assert.equal(seen[0].params.limit, SEARCH_LIMIT);
  assert.equal(r.track.id, "exact", "exact track must beat the remix");
  assert.ok(r.score > 0.9);
});

test("matchTrackToCatalog — honest miss when nothing is close", async () => {
  const invoke = async () => ({ tracks: [unrelated] });
  const want = { name: "Believer", artists: ["Imagine Dragons"], duration_ms: 204000 };
  const r = await matchTrackToCatalog(want, invoke);
  assert.equal(r.track, null);
  assert.equal(r.error, undefined, "a miss is not an error");
  assert.equal(r.query, "Believer Imagine Dragons");
});

test("matchTrackToCatalog — invoke throw is a miss, not a throw", async () => {
  const invoke = async () => {
    throw new Error("search failed — 2 upstream page(s) unreachable");
  };
  const r = await matchTrackToCatalog({ name: "X", artists: ["Y"], duration_ms: 1 }, invoke);
  assert.equal(r.track, null);
  assert.ok(r.error.includes("unreachable"));
});

test("matchTrackToCatalog — no invoke / no name are errors, not throws", async () => {
  const noInvoke = await matchTrackToCatalog({ name: "X", artists: ["Y"] }, undefined);
  assert.ok(noInvoke.error);
  const noName = await matchTrackToCatalog({ name: "", artists: [] }, async () => ({ tracks: [] }));
  assert.ok(noName.error);
});

test("pickBestMatch — title gate blocks a wrong song carried by artist+duration", () => {
  // Same artist, same length, weak title: score alone may clear the bar, the
  // title gate must still refuse it.
  const wrongSong = cand({ id: "wrong", title: "Wonderwall", artist: "Oasis", duration_secs: 258 });
  const want = { name: "Champagne Supernova", artists: ["Oasis"], duration_ms: 258000 };
  const s = matchScore(want, wrongSong);
  const best = pickBestMatch(want, [wrongSong]);
  assert.equal(best, null, `titleSim=${s.titleSim} score=${s.score}`);
});

test("pickBestMatch — prefers the close-duration exact over same-title live take", () => {
  const live = cand({ id: "live", title: "Tum Hi Ho", artist: "Arijit Singh", duration_secs: 300 });
  const exact = cand({ id: "studio", title: "Tum Hi Ho", artist: "Arijit Singh, Mithoon", duration_secs: 262 });
  const want = { name: "Tum Hi Ho", artists: ["Arijit Singh"], duration_ms: 262000 };
  const best = pickBestMatch(want, [live, exact]);
  assert.equal(best.track.id, "studio");
});

test("pickBestMatch — missing durations stay neutral, not disqualifying", () => {
  const c = cand({ id: "nodur", title: "Kesariya", artist: "Arijit Singh", duration_secs: 0 });
  const want = { name: "Kesariya", artists: ["Arijit Singh"] };
  const best = pickBestMatch(want, [c]);
  assert.equal(best.track.id, "nodur");
  assert.ok(best.score >= MATCH_THRESHOLD);
});

test("pickBestMatch — tribute-cover guard: right title, wrong credit, wrong length", () => {
  const cover = cand({
    id: "cover",
    title: "Pasoori (Originally Performed by Shae Gill & Ali Sethi)",
    artist: "Backing Business",
    duration_secs: 218,
  });
  const want = { name: "Pasoori", artists: ["Ali Sethi", "Shae Gill"], duration_ms: 193000 };
  const s = matchScore(want, cover);
  assert.ok(s.score >= MATCH_THRESHOLD, `score=${s.score} — the score bar alone would pass this`);
  assert.equal(pickBestMatch(want, [cover]), null, "credit+duration disagreement must refuse it");
});

test("pickBestMatch — padded catalog credits stay acceptable when the length agrees", () => {
  // JioSaavn credits lyricist+composer+singers ("Irshad Kamil, Arijit Singh,
  // …") where Spotify lists just Arijit Singh — credit similarity is low but
  // the true track must still win on title + exact duration.
  const want = { name: "Gehra Hua", artists: ["Arijit Singh"], duration_ms: 362000 };
  const trueTrack = cand({
    id: "true",
    title: "Gehra Hua (From \"Dhurandhar\")",
    artist: "Irshad Kamil, Arijit Singh, Shashwat Sachdev, Armaan Khan",
    duration_secs: 362,
  });
  const wrongSameArtist = cand({ id: "wrong", title: "Tera Hua", artist: "Arijit Singh, Akull, Riya Duggal", duration_secs: 253 });
  const best = pickBestMatch(want, [wrongSameArtist, trueTrack]);
  assert.equal(best.track.id, "true", "exact duration + true title must beat the same-artist wrong track");
});

test("titleVariants — strips brackets and remaster suffixes", () => {
  assert.deepEqual(titleVariants("Believer (Kaskade Remix)"), ["believer (kaskade remix)", "believer"]);
  assert.deepEqual(titleVariants("Fix You - Remastered 2011"), ["fix you - remastered 2011", "fix you"]);
  assert.deepEqual(titleVariants("Plain Title"), ["plain title"]);
  assert.deepEqual(titleVariants(""), []);
});

test("durationFactor — the documented windows", () => {
  assert.equal(durationFactor(204000, 204), 1);
  assert.equal(durationFactor(204000, 197), 1);
  assert.equal(durationFactor(204000, 190), 0.5);
  assert.equal(durationFactor(204000, 150), 0.15);
  assert.equal(durationFactor(0, 204), 0.7);
  assert.equal(durationFactor(204000, undefined), 0.7);
});

test("matchScore — featurings in either direction do not fake a mismatch", () => {
  const want = { name: "Pasoori", artists: ["Ali Sethi", "Shae Gill"], duration_ms: 193000 };
  const c = cand({ id: "p", title: "Pasoori (feat. Shae Gill)", artist: "Ali Sethi", duration_secs: 193 });
  const s = matchScore(want, c);
  assert.ok(s.score >= MATCH_THRESHOLD && s.score > 0.9, `score=${s.score}`);
});
