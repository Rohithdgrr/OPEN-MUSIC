// artresolve.test.mjs — the catalog artist-art resolver (2026-10-24).
// Pure module: matchArtist discipline, hydrateArtistArt cache + upstream
// behavior, and the binders wiring contract for both paint sites.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const { cachedArtistArt } = await import("../src/mobile/artresolve.js");

// A quiet localStorage for the cache tests (node has none).
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
};

test("matchArtist answers only with the real artist entity", async () => {
  const { matchArtist } = await import("../src/mobile/artresolve.js");
  const items = [
    { title: "Somebody Else", image: "b.png", token: "tok-b" },
    { title: "Pritam", image: "p.png", token: "tok-p" },
    { title: "Pritam Chakraborty", image: "g.png", token: "tok-g" },
  ];
  const hit = matchArtist("Pritam", items);
  assert.equal(hit.token, "tok-p", "exact match wins");
  // "Pritam" also answers the fuller-name entity when the exact one is gone.
  assert.equal(matchArtist("Pritam", [items[2]]).token, "tok-g", "name-prefix fallback");
  // Never items[0] blind — that is the wrong-face bug.
  assert.equal(matchArtist("Arijit Singh", items), null);
  // No image → useless as artist art.
  assert.equal(matchArtist("Pritam", [{ title: "Pritam", token: "t" }]), null);
  // No token/id → not navigable, not a real entity row.
  assert.equal(matchArtist("Pritam", [{ title: "Pritam", image: "x.png" }]), null);
  assert.equal(matchArtist("", items), null);
  assert.equal(matchArtist("Pritam", null), null);
});

test("hydrateArtistArt skips follows, resolves mined covers, and caches", async () => {
  const { hydrateArtistArt } = await import("../src/mobile/artresolve.js");
  const calls = [];
  const doInvoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args.query === "Arijit Singh") {
      return { items: [{ title: "Rahat Fateh Ali Khan", image: "raf.png", token: "tok-raf" }, { title: "Arijit Singh", image: "arijit.png", token: "tok-arijit" }] };
    }
    if (args.query === "Shreya Ghoshal") return { items: [] };
    throw new Error("upstream down");
  };
  const list = [
    { name: "Arijit Singh", image: "w.png", art: "track" },
    { name: "Shreya Ghoshal", image: "", art: "" },
    { name: "Ghost Follow", image: "g.png", art: "artist", token: "tok-g" },
    { name: "Broken Net", image: "b.png", art: "track" },
  ];
  const seen = [];
  const landed = await hydrateArtistArt(list, doInvoke, (a) => seen.push(a.name));
  assert.equal(landed, 1, "only Arijit landed an image: exact-match miss + network fail keep old art");
  assert.equal(list[0].image, "arijit.png");
  assert.equal(list[0].token, "tok-arijit");
  assert.equal(list[0].art, "artist");
  assert.equal(list[1].image, "", "empty answer stays empty — no invented art");
  assert.equal(list[1].art, "");
  assert.equal(list[2].image, "g.png", "follow untouched");
  assert.equal(list[3].image, "b.png", "upstream fail keeps the old art");
  // Command args discipline.
  const call = calls.find(([, a]) => a.query === "Arijit Singh");
  assert.equal(call[0], "search_entities");
  assert.deepEqual(call[1], { query: "Arijit Singh", kind: "artist", limit: 4, page: 1 });
  // Follows never spark an upstream call.
  assert.ok(!calls.some(([, a]) => a.query === "Ghost Follow"), calls.map(([, a]) => a.query));
  assert.equal(seen.length, 1, "onEach only for resolved cards");
});

test("hydrateArtistArt serves the cache and never re-resolves ", async () => {
  const { hydrateArtistArt } = await import("../src/mobile/artresolve.js");
  backing.set("tm-artist-art-v1", JSON.stringify({ v: "v1", map: { "cached singer": { image: "c.png", token: "tok-c", at: 7 } } }));
  const calls = [];
  const doInvoke = async (cmd, args) => {
    calls.push(args);
    return { items: [] };
  };
  const list = [{ name: "Cached Singer", image: "", art: "track" }];
  await hydrateArtistArt(list, doInvoke, () => {});
  assert.equal(calls.length, 0, "cached hit is zero upstream calls");
  assert.equal(list[0].image, "c.png");
  assert.equal(list[0].token, "tok-c");
  assert.equal(cachedArtistArt("cached singer").token, "tok-c", "cache reads case-insensitive");
  assert.equal(cachedArtistArt("Nobody"), null);
  backing.clear();
});

test("dotted initials match the catalog's spaced spelling", async () => {
  const { matchArtist } = await import("../src/mobile/artresolve.js");
  // Live catalog shape (2026-10-24): query "M.M. Keeravani" mines the name
  // without internal spaces; the entity rows spell it "M. M. Keeravani".
  const hit = matchArtist(
    "M.M. Keeravani",
    [{ title: "M. M. Keeravani", image: "k.png", token: "tok-k" }],
  );
  assert.equal(hit.token, "tok-k", "M.M. ≈ M. M. after dot-folding");
  // A lookup cache key folds the same way, so the hit is stable across
  // the module's whole path (match → remember → cachedArtistArt).
});

test("placeholder artist icons are never a match", async () => {
  const { matchArtist } = await import("../src/mobile/artresolve.js");
  const got = matchArtist(
    "Abel Tesfaye",
    [{ title: "Abel Tesfaye", image: "https://www.jiosaavn.com/_i/3.0/artist-default-music.png", token: "tok-a" }],
  );
  assert.equal(got, null, "generic icon would replace a song cover — worse than no match");
  const okRow = [];
  assert.equal(
    matchArtist("Pritam", [
      { title: "Pritam", image: "https://www.jiosaavn.com/_i/3.0/artist-default-film.png", token: "t1" },
      { title: "Pritam", image: "https://c.saavncdn.com/artists/Pritam.jpg", token: "t2" },
    ]).token,
    "t2",
    "the real-image row answers",
  );
});

test("a cached placeholder entry is treated as a miss and retried", async () => {
  const { hydrateArtistArt } = await import("../src/mobile/artresolve.js");
  backing.set(
    "tm-artist-art-v1",
    JSON.stringify({
      v: "v1",
      map: { "old singer": { image: "https://www.jiosaavn.com/_i/3.0/artist-default-music.png", token: "tok-old", at: 7 } },
    }),
  );
  const calls = [];
  const doInvoke = async (_c, args) => {
    calls.push(args);
    return { items: [{ title: args.query, image: "real.png", token: "tok-new" }] };
  };
  const list = [{ name: "Old Singer", image: "w.png", art: "track" }];
  await hydrateArtistArt(list, doInvoke, () => {});
  assert.equal(calls.length, 1, "placeholder cache does not count as a hit");
  assert.equal(list[0].image, "real.png");
  assert.equal(list[0].art, "artist");
  const store = JSON.parse(backing.get("tm-artist-art-v1"));
  assert.equal((store.map["old singer"] || {}).image, "real.png", "placeholder purged, real art cached");
  backing.clear();
});

test("binders paints mined tiles, then hydrates both surfaces", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/mobile/binders.js"), "utf8");
  assert.ok(src.includes('import { hydrateArtistArt } from "./artresolve.js";'), "resolver imported");
  assert.ok(src.split("withArtistArt(").length === 4, "two sites + definition + doc comment");
  assert.ok(src.includes('withArtistArt(mined, m,'), "Top-Artists rail hydrated");
  assert.ok(src.includes("withArtistArt(") && src.includes("200, // up to ~110 tiles stream in"), "artists browser hydrated (throttled)");
  assert.ok(src.includes('a.art !== "artist"') === false, "provenance filter lives in artresolve.js, not binders");
});
