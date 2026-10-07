// mobile-searchkit.test.mjs — pure helpers behind the mobile search screen:
// the TTL/LRU cache, match highlighting, query understanding + ranking, and
// the top-result picker. No DOM, so this runs in the plain node test suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLru,
  highlight,
  moodOf,
  parseSearch,
  pickTop,
  queryTokens,
  rankForQuery,
  tasteContext,
  understoodLabels,
  uniqueById,
} from "../src/mobile/searchkit.js";

const track = (title, extra = {}) => ({
  id: title,
  title,
  artist: extra.artist || "x",
  album: extra.album || "y",
  plays: extra.plays || 0,
  duration_secs: extra.duration_secs || 100,
  hq: !!extra.hq,
  language: extra.language || "",
  year: extra.year || "",
  ...extra,
});

test("LRU evicts the least recently used key and honors its cap", () => {
  const c = createLru({ max: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a"); // touch a → b is now the coldest
  c.set("d", 4);
  assert.equal(c.get("b"), undefined, "coldest entry is gone");
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("d"), 4);
  assert.equal(c.size, 3);
});

test("cached undefined is still a hit", () => {
  const c = createLru({ max: 2 });
  c.set("k", undefined);
  assert.ok(c.has("k"));
  assert.equal(c.get("k"), undefined);
});

test("TTL expires entries and frees their slot", () => {
  const c = createLru({ max: 4, ttlMs: 10 });
  c.set("k", 1);
  assert.equal(c.get("k"), 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 50;
  try {
    assert.equal(c.get("k"), undefined, "expired entry reads as a miss");
    assert.equal(c.has("k"), false);
    assert.equal(c.size, 0);
  } finally {
    Date.now = realNow;
  }
});

test("peek exposes the entry timestamp without refreshing it", () => {
  const c = createLru({ max: 2 });
  c.set("k", "v");
  const e = c.peek("k");
  assert.equal(e.value, "v");
  assert.ok(typeof e.at === "number");
  assert.equal(c.peek("nope"), undefined);
});

test("query parsing is memoized and stable", () => {
  const a = parseSearch("arijit singh hindi 2022");
  const b = parseSearch("arijit singh hindi 2022");
  assert.equal(a, b, "same object back for the same string");
  assert.equal(a.text, "arijit singh");
  assert.deepEqual(understoodLabels(a), ["hindi", "2022"]);
  assert.deepEqual(understoodLabels(parseSearch("plain")), []);
});

test("query tokens skip short words, dedupe, and order longest first", () => {
  const toks = queryTokens(parseSearch("a solo solo midnight"));
  assert.deepEqual(toks, ["midnight", "solo"]);
});

test("highlight escapes markup and bolds matched runs", () => {
  const html = highlight("Midnight <City> & Lights", ["city", "lights"]);
  assert.ok(!html.includes("<City>"), "no raw tags survive");
  assert.ok(html.startsWith("Midnight &lt;"), "text before the match is escaped");
  assert.ok(html.includes("&amp;"), "ampersand escaped");
  assert.ok(html.includes('<mark class="bg-transparent font-bold">City</mark>'));
  assert.ok(html.includes('<mark class="bg-transparent font-bold">Lights</mark>'));
  // No tokens → plain escaping, no markers.
  assert.equal(highlight("a & b", []), "a &amp; b");
});

test("highlight is case-insensitive and leaves the rest untouched", () => {
  const html = highlight("Kesariya", ["kes"]);
  assert.equal(html, '<mark class="bg-transparent font-bold">Kes</mark>ariya');
});

test("relevance puts the exact title first and drops the unrelated track", () => {
  const parsed = parseSearch("Kesariya");
  const page = [
    track("Tum Hi Ho", { plays: 100 }),
    track("Kesariya (Live)", { plays: 1 }),
    track("Kesariya", { plays: 5, artist: "Arijit Singh" }),
  ];
  const out = rankForQuery(page, parsed, "relevance");
  assert.equal(out[0].title, "Kesariya");
  assert.equal(out.at(-1).title, "Tum Hi Ho");
});

test("the query's own filters narrow the pool, and empty narrowings fall back", () => {
  const parsed = parseSearch("sunshine hindi");
  const page = [
    track("Sunshine", { language: "hindi" }),
    track("Sunshine Again", { language: "english" }),
  ];
  const out = rankForQuery(page, parsed, "relevance");
  assert.deepEqual(out.map((t) => t.title), ["Sunshine"], "english row filtered out");
  // Nothing speaks the asked-for language → show the page rather than nothing.
  const only = [track("Sunshine Again", { language: "english" })];
  assert.equal(rankForQuery(only, parsed, "relevance").length, 1);
});

test("named sorts delegate to the rank.js ordering", () => {
  const parsed = parseSearch("x");
  const page = [
    track("b", { plays: 1, duration_secs: 100 }),
    track("a", { plays: 9, duration_secs: 300, hq: true }),
  ];
  assert.deepEqual(rankForQuery(page, parsed, "az").map((t) => t.title), ["a", "b"]);
  assert.deepEqual(rankForQuery(page, parsed, "popular").map((t) => t.title), ["a", "b"]);
  assert.deepEqual(rankForQuery(page, parsed, "longest").map((t) => t.title), ["a", "b"]);
  assert.deepEqual(rankForQuery([], parsed, "relevance"), []);
});

test("taste boosts the tracks this listener already knows", () => {
  const parsed = parseSearch("midnight");
  const page = [track("Midnight A"), track("Midnight B", { id: "Midnight B" })];
  const cold = rankForQuery(page, parsed, "relevance", {});
  assert.equal(cold[0].id, "Midnight A", "catalog order without signals");
  const opts = tasteContext([{ id: "Midnight B", artist: "x" }], [{ id: "Midnight B" }]);
  const warm = rankForQuery(page, parsed, "relevance", opts);
  assert.equal(warm[0].id, "Midnight B", "liked + played wins the tie");
});

test("mood detection reads title and album only", () => {
  assert.equal(moodOf({ title: "Lofi Beats", album: "" }), "chill");
  assert.equal(moodOf({ title: "Some Song", album: "Workout Power" }), "energy");
  assert.equal(moodOf({ title: "Nothing here" }), "");
});

test("pickTop prefers a track when a track and an album share the exact name", () => {
  const top = pickTop("Kesariya", {
    tracks: [track("Kesariya")],
    albums: [{ id: "al", token: "t", title: "Kesariya", subtitle: "Arijit Singh" }],
  });
  assert.equal(top.kind, "song", "the kind weight settles a text-score tie");
  assert.equal(top.item.title, "Kesariya");
});

test("an exactly-named album outranks a partially matching song", () => {
  const top = pickTop("Kesariya", {
    tracks: [track("Kesariya XYZ", { plays: 9 })],
    albums: [{ id: "al", token: "t", title: "Kesariya" }],
  });
  assert.equal(top.kind, "album");
});

test("pickTop returns the best card when no song matches", () => {
  const top = pickTop("Arijit", {
    tracks: [track("Something")],
    artists: [{ id: "ar", token: "arin", title: "Arijit Singh", subtitle: "Artist" }],
  });
  assert.equal(top.kind, "artist");
  assert.equal(top.item.title, "Arijit Singh");
  assert.equal(pickTop("", { tracks: [track("x")] }), null);
  assert.equal(pickTop("zzzz", { tracks: [track("x")] }), null);
});

test("uniqueById keeps first copies and tolerates junk", () => {
  const out = uniqueById([
    { id: "a", title: "A" },
    { id: "a", title: "A again" },
    null,
    { token: "b", title: "B" },
    { title: "no id" },
  ]);
  assert.deepEqual(out.map((x) => x.title), ["A", "B", "no id"]);
});
