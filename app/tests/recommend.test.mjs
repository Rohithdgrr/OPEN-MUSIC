// recommend.test.mjs — the pure taste engine behind Home's "Made for you"
// shelves. Deterministic fixtures: every mix is seeded, so these assertions are
// exact rather than statistical.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS,
  buildProfile,
  countryMix,
  countryLangs,
  dailyMix,
  dayIndex,
  daypart,
  daypartTitle,
  downloadsMix,
  explain,
  favoritesMix,
  hashSeed,
  languageMix,
  mergeTracks,
  monthIndex,
  monthlyMix,
  mulberry32,
  normTrack,
  onRepeatMix,
  recentlyPlayedMix,
  rediscoverMix,
  shelfPlan,
  shuffleSeeded,
  timeOfDayMix,
  topLanguage,
  trackLangs,
} from "../src/mobile/recommend.js";

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0); // Oct 7 2026, 14:00 UTC
const daysAgo = (n) => NOW - n * DAY_MS;

const track = (id, extra = {}) => ({
  id,
  title: extra.title || `Song ${id}`,
  artist: extra.artist || "Artist A",
  album: extra.album || "Album",
  image: "",
  duration: "3:00",
  duration_secs: 180,
  hq: true,
  plays: 0,
  year: extra.year || "2020",
  language: extra.language || "hindi",
  ts: extra.ts || 0,
  count: extra.count || 0,
  ...extra,
});

/// A log of `n` tracks by one artist, most of them played recently.
const log = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => track(`p${i}`, { artist: "Artist A", ts: daysAgo(i % 5), count: n - i, ...extra }));

test("seeds are stable and the PRNG is deterministic", () => {
  assert.equal(hashSeed("abc"), hashSeed("abc"));
  assert.notEqual(hashSeed("abc"), hashSeed("abd"));
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const seq = Array.from({ length: 5 }, mulberry32(7));
  assert.ok(seq.every((x) => x >= 0 && x < 1));
});

test("seeded shuffle is a permutation and repeatable", () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = shuffleSeeded(src, mulberry32(3));
  const b = shuffleSeeded(src, mulberry32(3));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), src, "same members");
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6, 7, 8], "input untouched");
});

test("day and month indices follow the calendar", () => {
  assert.equal(dayIndex(NOW), dayIndex(NOW + 3600e3), "same local day");
  assert.equal(dayIndex(NOW) + 1, dayIndex(NOW + DAY_MS));
  assert.equal(monthIndex(NOW), monthIndex(NOW + 3 * DAY_MS), "same month");
  assert.equal(monthIndex(NOW) + 1, monthIndex(NOW + 40 * DAY_MS), "rolls into November");
});

test("normalization rejects junk and keeps the useful fields", () => {
  assert.equal(normTrack(null), null);
  assert.equal(normTrack({ title: "no id" }), null);
  assert.equal(normTrack({ id: "x" }), null, "no title");
  const t = normTrack({ id: " x ", title: " Song ", artist: null, duration_secs: "180" });
  assert.equal(t.id, "x");
  assert.equal(t.title, "Song");
  assert.equal(t.artist, "");
  assert.equal(t.duration_secs, 180);
});

test("SQLite ledger rows (play_count / last_played) feed the same profile", () => {
  // store.rs hands back SongRow: snake_case counters beside the metadata.
  const rows = [
    { id: "s1", title: "Ledger One", artist: "Alpha", play_count: 12, last_played: daysAgo(2) },
    { id: "s2", title: "Ledger Two", artist: "Beta", play_count: 3, last_played: daysAgo(30) },
  ];
  const p = buildProfile({ extra: rows, now: NOW });
  assert.equal(p.tracks.length, 2, "ledger rows become profile tracks");
  assert.equal(p.byId.get("s1").plays, 12, "play_count is the play counter");
  assert.equal(p.byId.get("s1").lastPlayed, daysAgo(2), "last_played is the timestamp");
  assert.deepEqual(onRepeatMix(p, { n: 2 }).map((t) => t.id), ["s1", "s2"]);
  assert.equal(p.recent[0].id, "s1", "recent view reads the ledger clock");
});

test("mergeTracks is first-wins but backfills missing fields", () => {
  const out = mergeTracks([
    [{ id: "a", title: "A", ts: 100 }],
    [{ id: "a", title: "A", artist: "Late", count: 5 }, { id: "b", title: "B" }],
  ]);
  assert.equal(out.length, 2);
  const a = out.find((x) => x.id === "a");
  assert.equal(a.artist, "Late", "missing artist filled in");
  assert.equal(a.ts, 100, "first occurrence keeps the timestamp");
  assert.equal(a.count, 5);
});

test("language and decade helpers read the catalogue shape", () => {
  assert.deepEqual(trackLangs({ language: "Hindi, Punjabi" }), ["hindi", "punjabi"]);
  assert.deepEqual(trackLangs({}), []);
});

test("profile weights artists, languages and plays the way the log says", () => {
  const plays = [
    track("a", { artist: "Alpha", count: 10, ts: daysAgo(1), language: "hindi" }),
    track("b", { artist: "Beta", count: 1, ts: daysAgo(1), language: "hindi" }),
    track("c", { artist: "Gamma", count: 1, ts: daysAgo(60), language: "english" }),
  ];
  const favs = [track("b", { artist: "Beta" })];
  const downloads = [track("d", { artist: "Delta", title: "D", ts: 0 })];
  const p = buildProfile({ plays, favs, downloads, country: "in", now: NOW });
  assert.equal(p.country, "IN", "country normalized");
  assert.equal(p.favourites.has("b"), true);
  assert.equal(p.downloaded.has("d"), true);
  assert.equal(p.tracks.length, 4, "union of plays + favs + vault");
  // Explicit feedback is a stronger statement than raw streams: the one
  // hearted track (Beta) outweighs Alpha's ten plays.
  assert.equal(p.topArtists[0].artist, "Beta", "the hearted artist leads");
  assert.ok(p.artistWeight.get("Beta") > p.artistWeight.get("Alpha"), "a like outweighs play count");
  // An explicit like outweighs a stale single play.
  assert.ok(p.artistWeight.get("Beta") > p.artistWeight.get("Gamma"));
  assert.equal(p.topLanguages[0].language, "hindi");
  assert.equal(p.recent[0].id, "a", "most recent play first");
});

test("the hour histogram is a real listening pattern", () => {
  // buildProfile buckets by local hour, so the fixtures must be local too.
  const at = (h) => new Date(2026, 9, 6, h, 0, 0).getTime();
  const plays = [track("m", { ts: at(8) }), track("e", { ts: at(20) }), track("e2", { ts: at(21) })];
  const p = buildProfile({ plays, now: NOW });
  assert.equal(p.hours[8], 1);
  assert.equal(p.hours[20], 1);
  assert.equal(p.hours[21], 1);
  assert.equal(p.hours.reduce((s, x) => s + x, 0), 3);
});

test("daypart buckets the clock the way the mixes name it", () => {
  assert.equal(daypart(6), "morning");
  assert.equal(daypart(14), "afternoon");
  assert.equal(daypart(19), "evening");
  assert.equal(daypart(2), "night");
  assert.equal(daypartTitle(6), "Morning Mix");
  assert.equal(daypartTitle(23), "Late Night Mix");
});

test("Daily Mix is stable within a day and rotates on the next", () => {
  const p = buildProfile({ plays: log(20), now: NOW });
  const a = dailyMix(p, { n: 10, now: NOW });
  const b = dailyMix(p, { n: 10, now: NOW + 3600e3 });
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id), "same day, same order");
  const tomorrow = dailyMix(p, { n: 10, now: NOW + DAY_MS });
  assert.notDeepEqual(a.map((t) => t.id), tomorrow.map((t) => t.id), "the day seed rotates it");
  assert.equal(a.length, 10);
  assert.equal(new Set(a.map((t) => t.id)).size, 10, "no repeats");
});

test("Daily Mix demotes what was just played, Monthly Mix keeps it", () => {
  const plays = [
    track("hot", { artist: "Alpha", ts: NOW - 10 * 60e3, count: 9 }), // 10 minutes ago
    track("rest", { artist: "Beta", ts: daysAgo(3), count: 9 }),
  ];
  const p = buildProfile({ plays, now: NOW });
  const daily = dailyMix(p, { n: 2, now: NOW }).map((t) => t.id);
  assert.deepEqual(daily, ["rest", "hot"], "the track heard minutes ago sinks");
  const month = monthlyMix(p, { n: 2, now: NOW }).map((t) => t.id);
  assert.equal(month.length, 2);
  assert.ok(month.includes("hot"), "the month view still knows it");
});

test("Monthly Mix prefers tracks played inside the month", () => {
  const plays = [
    ...Array.from({ length: 8 }, (_, i) => track(`new${i}`, { artist: "Alpha", ts: daysAgo(i + 1), count: 5 })),
    track("old", { artist: "Alpha", ts: daysAgo(120), count: 50 }),
  ];
  const p = buildProfile({ plays, now: NOW });
  const ids = monthlyMix(p, { n: 20, now: NOW }).map((t) => t.id);
  assert.equal(ids.length, 8, "only the tracks that actually played this month");
  assert.ok(!ids.includes("old"), "a four-month-old play is not this month's rotation");
});

test("On Repeat is strictly the play counter", () => {
  const p = buildProfile({ plays: [track("a", { count: 3 }), track("b", { count: 30 }), track("c", { count: 9 })] , now: NOW });
  assert.deepEqual(onRepeatMix(p, { n: 2 }).map((t) => t.id), ["b", "c"]);
});

test("Recently Played keeps one row per track, newest first", () => {
  const plays = [
    track("a", { ts: daysAgo(1) }),
    track("b", { ts: daysAgo(0) }),
    track("a", { ts: daysAgo(2) }),
  ];
  const p = buildProfile({ plays, now: NOW });
  assert.deepEqual(recentlyPlayedMix(p, { n: 5 }).map((t) => t.id), ["b", "a"]);
});

test("Rediscover finds the beloved-but-forgotten, not the current session", () => {
  const p = buildProfile({
    plays: [
      track("fresh", { count: 20, ts: daysAgo(1) }),
      track("dusty", { count: 12, ts: daysAgo(90) }),
      track("faint", { count: 1, ts: daysAgo(200) }),
    ],
    now: NOW,
  });
  const ids = rediscoverMix(p, { n: 5, now: NOW }).map((t) => t.id);
  assert.deepEqual(ids, ["dusty", "faint"], "loud and long-forgotten leads faint");
});

test("Favorites and Downloads shelves come straight from their stores", () => {
  const p = buildProfile({
    plays: [track("a", { ts: daysAgo(1) }), track("b", { ts: daysAgo(2) })],
    favs: [track("b")],
    downloads: [track("z", { title: "Zed" })],
    now: NOW,
  });
  assert.deepEqual(favoritesMix(p, { n: 5 }).map((t) => t.id), ["b"]);
  assert.deepEqual(downloadsMix(p, { n: 5 }).map((t) => t.id), ["z"]);
});

test("language mix uses the dominant language and can be asked for one", () => {
  const plays = [
    ...Array.from({ length: 6 }, (_, i) => track(`h${i}`, { language: "hindi", ts: daysAgo(i) })),
    track("e0", { language: "english", ts: daysAgo(1) }),
  ];
  const p = buildProfile({ plays, now: NOW });
  assert.equal(topLanguage(p), "hindi");
  const ids = languageMix(p, { n: 10, now: NOW }).map((t) => t.id);
  assert.equal(ids.length, 6);
  assert.ok(ids.every((id) => id.startsWith("h")));
  assert.deepEqual(languageMix(p, { n: 10, language: "klingon" }), [], "unknown language yields nothing");
});

test("language mix stays silent when no language dominates", () => {
  const plays = [
    track("h", { language: "hindi", ts: daysAgo(1) }),
    track("e", { language: "english", ts: daysAgo(1) }),
  ];
  const p = buildProfile({ plays, now: NOW });
  assert.equal(topLanguage(p), "hindi", "an even split still has a leader");
  assert.equal(topLanguage(p, { minShare: 0.6 }), "", "but not a dominant one");
  const mixed = buildProfile({
    plays: [
      ...Array.from({ length: 3 }, (_, i) => track(`h${i}`, { language: "hindi", ts: daysAgo(i + 1) })),
      track("e", { language: "english", ts: daysAgo(1) }),
    ],
    now: NOW,
  });
  assert.equal(topLanguage(mixed), "hindi", "a 75% share is a preference");
});

test("country mix maps the preference onto the catalogue's languages", () => {
  assert.deepEqual(countryLangs("IN").slice(0, 2), ["hindi", "punjabi"]);
  assert.deepEqual(countryLangs("ZZ"), []);
  const plays = Array.from({ length: 6 }, (_, i) => track(`i${i}`, { language: "hindi", ts: daysAgo(i) }));
  const p = buildProfile({ plays, country: "IN", now: NOW });
  assert.equal(countryMix(p, { n: 10, now: NOW }).length, 6);
  const noCountry = buildProfile({ plays, now: NOW });
  assert.deepEqual(countryMix(noCountry, { n: 10, now: NOW }), [], "no country, no shelf");
});

test("time-of-day mix only draws from tracks played in the same slice", () => {
  const morning = Date.UTC(2026, 9, 6, 8, 0, 0); // 08:00 UTC
  const evening = Date.UTC(2026, 9, 6, 20, 0, 0);
  const plays = [
    ...Array.from({ length: 5 }, (_, i) => track(`am${i}`, { ts: morning - i * DAY_MS })),
    ...Array.from({ length: 5 }, (_, i) => track(`pm${i}`, { ts: evening - i * DAY_MS })),
  ];
  const p = buildProfile({ plays, now: NOW });
  const inMorning = timeOfDayMix(p, { n: 10, now: morning + DAY_MS }).map((t) => t.id);
  assert.equal(inMorning.length, 5);
  assert.ok(inMorning.every((id) => id.startsWith("am")), inMorning.join(","));
});

test("every mix survives an empty profile", () => {
  const p = buildProfile({});
  assert.deepEqual(dailyMix(p), []);
  assert.deepEqual(monthlyMix(p), []);
  assert.deepEqual(onRepeatMix(p), []);
  assert.deepEqual(recentlyPlayedMix(p), []);
  assert.deepEqual(rediscoverMix(p), []);
  assert.deepEqual(favoritesMix(p), []);
  assert.deepEqual(downloadsMix(p), []);
  assert.deepEqual(languageMix(p), []);
  assert.deepEqual(countryMix(p), []);
  assert.deepEqual(timeOfDayMix(p), []);
  assert.deepEqual(shelfPlan(p), []);
  assert.deepEqual(dailyMix(null), []);
  assert.deepEqual(shelfPlan(null), []);
});

test("shelfPlan orders flagship shelves first and drops the empty ones", () => {
  const plays = [
    ...Array.from({ length: 10 }, (_, i) => track(`k${i}`, { artist: "Alpha", language: "hindi", ts: daysAgo(i % 4), count: 10 - i })),
  ];
  const p = buildProfile({ plays, country: "IN", now: NOW });
  const plan = shelfPlan(p, { now: NOW, limit: 6 });
  const ids = plan.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 2), ["daily", "monthly"], "flagship mixes lead");
  assert.ok(ids.includes("onrepeat"));
  assert.ok(!ids.includes("downloads"), "no vault, no shelf");
  for (const s of plan) {
    assert.ok(s.tracks.length > 0, `${s.id} is non-empty`);
    assert.ok(s.tracks.length <= 6, `${s.id} respects the limit`);
    assert.ok(s.title && s.tag, `${s.id} is labelled`);
  }
  const only = shelfPlan(p, { now: NOW, include: ["onrepeat"] });
  assert.deepEqual(only.map((s) => s.id), ["onrepeat"]);
});

test("shelfPlan's explicit language pick outranks the log", () => {
  const plays = [
    ...Array.from({ length: 6 }, (_, i) => track(`h${i}`, { language: "hindi", ts: daysAgo(i) })),
    ...Array.from({ length: 4 }, (_, i) => track(`t${i}`, { language: "tamil", ts: daysAgo(i) })),
  ];
  const p = buildProfile({ plays, now: NOW });
  const observed = shelfPlan(p, { now: NOW, include: ["language"] });
  assert.equal(observed[0].title, "Hindi Picks", "no pick: the log decides");
  const picked = shelfPlan(p, { now: NOW, include: ["language"], language: "tamil" });
  assert.equal(picked[0].title, "Tamil Picks", "a Settings pick wins");
  assert.ok(
    picked[0].tracks.every((t) => String(t.language).toLowerCase().includes("tamil")),
    "and the shelf only holds that language",
  );
  assert.deepEqual(
    shelfPlan(p, { now: NOW, include: ["language"], language: "klingon" }),
    [],
    "a pick the catalogue cannot fill falls away rather than inventing rows",
  );
});

test("explain names the signals a mix was built from", () => {
  const plays = Array.from({ length: 8 }, (_, i) => track(`x${i}`, { artist: "Alpha", language: "hindi", ts: daysAgo(i) }));
  const p = buildProfile({ plays, country: "IN", now: NOW });
  const daily = shelfPlan(p, { now: NOW, limit: 5 }).find((s) => s.id === "daily");
  const why = explain(p, daily);
  assert.match(why, /Alpha/);
  assert.match(why, /Hindi/);
  assert.match(why, /IN/);
  assert.equal(explain(p, { id: "downloads" }), "");
});
