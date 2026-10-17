// taste.test.mjs — the shared, pure similarity engine (docs/recommendations.md
// §8). Deterministic fixtures only: no DOM, no IPC, no network. The replay
// metric is the integration proof: it must recover a synthetic play chain —
// and a shuffled version of the same events must NOT.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoOccurrence,
  buildSignals,
  classifyPlay,
  eligibleBatch,
  leadArtists,
  mmrRerank,
  negativeWeights,
  neighborScores,
  pickBatch,
  replayHitRate,
  rerankBatch,
  scoreCandidate,
  sessionize,
  similarShelf,
} from "../src/taste.js";

const HOUR = 3600000;
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // Oct 16 2026, 12:00 UTC

const ev = (id, ts, extra = {}) => ({
  id,
  ts,
  outcome: "complete",
  ms_played: 180000,
  duration_secs: 200,
  title: `Song ${id}`,
  artist: "Artist A",
  image: "",
  ...extra,
});

const track = (id, extra = {}) => ({
  id,
  title: `Song ${id}`,
  artist: "Artist A",
  album: "",
  image: "",
  duration_secs: 200,
  language: "",
  year: "",
  ...extra,
});

test("classifyPlay: natural end wins, dwell fraction decides otherwise", () => {
  assert.equal(classifyPlay({ msPlayed: 1000, durationSecs: 200, naturalEnd: true }), "complete");
  assert.equal(classifyPlay({ msPlayed: 20000, durationSecs: 200 }), "skip"); // 10 %
  assert.equal(classifyPlay({ msPlayed: 100000, durationSecs: 200 }), "partial"); // 50 %
  assert.equal(classifyPlay({ msPlayed: 170000, durationSecs: 200 }), "complete"); // 85 %
  assert.equal(classifyPlay({ msPlayed: 5000, durationSecs: 0 }), "partial"); // unknown length
  assert.equal(classifyPlay({}), "partial");
});

test("leadArtists: feat/ft/with and separators split to lead names", () => {
  assert.deepEqual(leadArtists("A feat. B"), ["A", "B"]);
  assert.deepEqual(leadArtists("A & B"), ["A", "B"]);
  assert.deepEqual(leadArtists("Solo"), ["Solo"]);
  assert.deepEqual(leadArtists(""), []);
});

test("sessionize: plays join while gaps stay under the window", () => {
  const events = [
    ev("c", NOW - 3 * HOUR + 120000),
    ev("a", NOW - 3 * HOUR),
    ev("b", NOW - 3 * HOUR + 60000),
    ev("d", NOW - 40 * HOUR),
  ];
  const s = sessionize(events);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].map((e) => e.id), ["d"]);
  assert.deepEqual(s[1].map((e) => e.id), ["a", "b", "c"]);
});

test("buildCoOccurrence: pairs decay with age, catalog keeps event metadata", () => {
  const events = [
    ev("a", NOW - 2000, { title: "Alpha", artist: "P" }),
    ev("b", NOW - 1000, { title: "Beta", artist: "Q" }),
    ev("x", NOW - 14 * DAY, { title: "Xi" }),
    ev("y", NOW - 14 * DAY + 1000, { title: "Why" }),
  ];
  const { tracks, catalog } = buildCoOccurrence(events, { now: NOW });
  const ab = tracks.get("a").get("b");
  const xy = tracks.get("x").get("y");
  assert.ok(ab > 0 && ab <= 1.01, `fresh pair ~1, got ${ab}`);
  assert.ok(Math.abs(ab / xy - 2) < 0.05, `14-day pair weighs half, ratio ${ab / xy}`);
  assert.equal(tracks.get("b").get("a"), ab); // symmetric
  assert.equal(catalog.get("a").title, "Alpha");
  assert.equal(catalog.get("y").artist, "Artist A");
});

test("neighborScores: recent seeds outweigh older ones", () => {
  const graph = new Map([
    ["a", new Map([["n", 1]])],
    ["b", new Map([["n", 1]])],
  ]);
  const s = neighborScores(graph, ["a", "b"]);
  assert.ok(Math.abs(s.get("n") - 1.75) < 1e-9, `1 + 0.75, got ${s.get("n")}`);
});

test("negativeWeights: only skips count, recency decayed, last skip kept", () => {
  const w = negativeWeights(
    [
      ev("s1", NOW - 1000, { outcome: "skip" }),
      ev("ok", NOW - 1000),
      ev("s2", NOW - 7 * DAY, { outcome: "skip" }),
    ],
    { now: NOW }, // fixtures are anchored to NOW — never the wall clock
  );
  assert.ok(w.ids.get("s1") > 0.99);
  assert.ok(Math.abs((w.ids.get("s2") || 0) - 0.5) < 0.01); // one half-life
  assert.equal(w.ids.get("ok"), undefined);
  assert.equal(w.ts.get("s1"), NOW - 1000);
});

test("buildSignals + scoreCandidate: decayed plays, fav boost, kNN lift", () => {
  const sig = buildSignals({
    plays: [
      { id: "p1", artist: "A", album: "Al", language: "hindi", year: "2024", count: 9, ts: NOW - HOUR },
      { id: "p2", artist: "B", album: "Bl", language: "hindi", year: "1994", count: 1, ts: NOW - 30 * DAY },
    ],
    favs: [track("f1", { artist: "C" })],
    events: [ev("p1", NOW - HOUR), ev("k1", NOW - HOUR + 60000)],
    now: NOW,
  });
  const warm = scoreCandidate(sig, track("new1", { artist: "A" }));
  const cold = scoreCandidate(sig, track("new2", { artist: "Z" }));
  assert.ok(warm > cold, "played artist must outrank a stranger");
  const fresh = scoreCandidate(sig, track("new3", { artist: "A" }));
  const old = scoreCandidate(sig, track("new4", { artist: "B" }));
  assert.ok(fresh > old, "a hot play outweighs a stale one");
  const fav = scoreCandidate(sig, track("f1", { artist: "C" }));
  assert.ok(fav >= 4, `fav bonus applies, got ${fav}`);
  const knnBoost = scoreCandidate(sig, track("k1", { artist: "Q" }));
  assert.ok(knnBoost > 0, `co-played neighbour gets a lift, got ${knnBoost}`);
});

test("mmrRerank: per-artist cap keeps the rail diverse, thin supply still fills", () => {
  const items = [
    track("a1", { artist: "A" }),
    track("a2", { artist: "A" }),
    track("a3", { artist: "A" }),
    track("b1", { artist: "B" }),
  ];
  const scores = { a1: 10, a2: 9, a3: 8, b1: 1 };
  const out = mmrRerank(items, { limit: 3, scoreOf: (t) => scores[t.id] });
  assert.deepEqual(out.map((t) => t.id), ["a1", "a2", "b1"]); // a3 capped out
  const all = mmrRerank(items, { limit: 4, scoreOf: (t) => scores[t.id] });
  assert.equal(all.length, 4); // all-one-artist supply still fills a rail
});

test("rerankBatch: drops queued, heard (unless allowed) and just-skipped", () => {
  const cands = [track("q1"), track("h1"), track("s1"), track("s2"), track("n1")];
  const sig = buildSignals({
    plays: [{ id: "h1", artist: "Artist A", count: 3, ts: NOW - 2 * HOUR }],
    events: [
      ev("h1", NOW - 2 * HOUR),
      ev("s1", NOW - 1 * HOUR, { outcome: "skip" }),
      ev("s2", NOW - 2 * DAY, { outcome: "skip" }),
    ],
    queuedIds: ["q1"],
    heardIds: ["h1"],
    now: NOW,
  });
  const ids = rerankBatch(cands, sig, { limit: 10, eps: 0 }).map((t) => t.id);
  assert.ok(!ids.includes("q1"), "queued is never rerun");
  assert.ok(!ids.includes("h1"), "heard inside the window is skipped");
  assert.ok(!ids.includes("s1"), "a skip within 3 h hard-drops");
  assert.ok(ids.includes("s2"), "an older skip only demotes");
  const retry = rerankBatch(cands, sig, { limit: 10, eps: 0, allowHeard: true }).map((t) => t.id);
  assert.ok(retry.includes("h1"), "endless-mode retry may replay the heard tail");
});

test("rerankBatch: fresh plays are demoted, ε keeps an exploration seat", () => {
  const cands = [track("x", { artist: "A" }), track("y", { artist: "B" })];
  const sig = buildSignals({
    plays: [
      { id: "x", artist: "A", count: 5, ts: NOW - HOUR },
      { id: "y", artist: "B", count: 5, ts: NOW - 10 * DAY },
    ],
    now: NOW,
  });
  assert.deepEqual(
    rerankBatch(cands, sig, { limit: 2, eps: 0 }).map((t) => t.id),
    ["y", "x"],
    "a track played an hour ago sinks below its older sibling",
  );
  const rng = () => 0; // deterministic: first leftover, seat index 1
  const wild = rerankBatch([...cands, track("z"), track("w")], sig, { limit: 3, eps: 1, rng });
  assert.equal(wild.length, 3);
  assert.ok(wild.map((t) => t.id).includes("x"), "the ε-slot surfaces a leftover");
});

test("eligibleBatch: upstream order kept, queued/heard/just-skipped gated", () => {
  const cands = [track("n1"), track("q1"), track("h1"), track("s1"), track("s2"), track("n1")];
  const sig = buildSignals({
    plays: [{ id: "h1", artist: "Artist A", count: 3, ts: NOW - 2 * HOUR }],
    events: [
      ev("h1", NOW - 2 * HOUR),
      ev("s1", NOW - 1 * HOUR, { outcome: "skip" }),
      ev("s2", NOW - 2 * DAY, { outcome: "skip" }),
    ],
    queuedIds: ["q1"],
    heardIds: ["h1"],
    now: NOW,
  });
  assert.deepEqual(
    eligibleBatch(cands, sig).map((t) => t.id),
    ["n1", "s2"],
    "order kept; duplicate, queued, heard and fresh-skip all gated",
  );
  assert.deepEqual(
    eligibleBatch(cands, sig, { allowHeard: true }).map((t) => t.id),
    ["n1", "h1", "s2"],
    "the endless retry lifts only the heard gate",
  );
});

test("pickBatch: JioSaavn's order wins over local affinity; endless retry only when empty", () => {
  // The hottest artist locally sits LAST upstream — the order must not move
  // (docs/recommendations.md §8.8).
  const cands = [track("z", { artist: "Z" }), track("a", { artist: "A" }), track("m", { artist: "M" })];
  const sig = buildSignals({
    plays: [{ id: "a", artist: "A", count: 50, ts: NOW - HOUR }],
    favs: [{ id: "m", artist: "M" }],
    now: NOW,
  });
  assert.deepEqual(pickBatch(cands, sig).map((t) => t.id), ["z", "a", "m"]);
  assert.deepEqual(pickBatch(cands, sig, { limit: 2 }).map((t) => t.id), ["z", "a"]);
  const allHeard = buildSignals({ heardIds: ["z", "a", "m"], now: NOW });
  assert.deepEqual(pickBatch(cands, allHeard).map((t) => t.id), ["z", "a", "m"], "endless retry refills");
  const allQueued = buildSignals({ queuedIds: ["z", "a", "m"], now: NOW });
  assert.deepEqual(pickBatch(cands, allQueued), [], "queued never returns");
});

test("replayHitRate: kNN recovers a play chain, shuffled ids do not", () => {
  // Ring chain s0→s1→…→s11→s0 as two-track sessions (a pair is its own
  // session, so co-occurrence encodes transitions only), six rounds. The
  // metric ranks eligible candidates — the just-played tail is excluded,
  // exactly like the radio's heard filter — and the true next track must
  // land top-2: measured 0.98 vs a 0.18 shuffled baseline.
  const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const events = [];
  let t = NOW - 40 * DAY;
  for (let round = 0; round < 6; round++) {
    for (let k = 0; k < ids.length; k++) {
      events.push(ev(ids[k], t));
      t += 60 * 1000;
      events.push(ev(ids[(k + 1) % ids.length], t));
      t += 2 * HOUR;
    }
  }
  const good = replayHitRate(events, { k: 2, warmup: 12, heardWindow: 4 });
  assert.ok(good.total > 45, `enough test points, got ${good.total}`);
  assert.ok(good.rate >= 0.8, `the chain should be predictable, got ${good.rate}`);
  // Same timestamps, ids independently shuffled: structure gone, guesswork.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuffled = events.map((e) => ({ ...e, id: ids[Math.floor(rnd() * ids.length)] }));
  const bad = replayHitRate(shuffled, { k: 2, warmup: 12, heardWindow: 4 });
  assert.ok(bad.rate < 0.5, `shuffled ids are guesswork, got ${bad.rate}`);
  assert.ok(bad.rate < good.rate, `shuffled ${bad.rate} must trail chained ${good.rate}`);
});

test("similarShelf: newest anchor with a real neighbour row wins", () => {
  const session = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) =>
    ev(id, NOW - 3 * HOUR + i * 60000),
  );
  const later = ev("g2", NOW - HOUR); // newest, but alone → no row
  const shelf = similarShelf([...session, later], { now: NOW, n: 10, minNeighbors: 6 });
  assert.ok(shelf, "a shelf was found");
  assert.equal(shelf.anchor.id, "g");
  assert.equal(shelf.tracks.length, 6); // a..f
  assert.ok(shelf.tracks.every((t) => t.id !== "g"));
  assert.equal(similarShelf([later], { now: NOW }), null);
});
