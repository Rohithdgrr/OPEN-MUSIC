// streaks + per-track EQ + share-codec tests. Stubs the browser globals the
// mobile modules expect (window/localStorage/document/navigator); modules
// under test only touch them inside functions, never at import time.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};
globalThis.document = {
  addEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => null,
  body: null,
};
try {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
} catch {
  // navigator is non-configurable here — modules under test don't need it.
}

const { streakStats } = await import("../src/mobile/streaks.js");
const shared = await import("../src/mobile/shared.js");

function seedPlays(dayOffsets) {
  const plays = dayOffsets.map((d, i) => {
    const date = new Date();
    date.setDate(date.getDate() - d);
    date.setHours(12, 0, 0, 0);
    return {
      id: `t${i}`,
      title: `t${i}`,
      ts: date.getTime(),
      count: 1,
    };
  });
  mem.set("tm-plays", JSON.stringify(plays));
}

test("streak counts consecutive days ending today", () => {
  seedPlays([0, 1, 2]);
  const s = streakStats();
  assert.equal(s.streak, 3);
  assert.equal(s.today, 1);
});

test("streak survives a missing today when yesterday played", () => {
  seedPlays([1, 2, 3]);
  assert.equal(streakStats().streak, 3);
});

test("a gap resets the streak to the recent run", () => {
  seedPlays([0, 1, 5, 6]);
  assert.equal(streakStats().streak, 2);
});

test("empty log reads zero, never NaN", () => {
  mem.set("tm-plays", JSON.stringify([]));
  const s = streakStats();
  assert.equal(s.streak, 0);
  assert.equal(s.today, 0);
});

test("per-track EQ round-trips and rejects bad presets", () => {
  assert.equal(shared.trackEqFor("abc"), "");
  assert.equal(shared.setTrackEq("abc", "bassboost"), true);
  assert.equal(shared.trackEqFor("abc"), "bassboost");
  assert.equal(shared.setTrackEq("abc", "超重低音"), false);
  assert.equal(shared.trackEqFor("abc"), "bassboost");
  assert.equal(shared.setTrackEq("abc", ""), true);
  assert.equal(shared.trackEqFor("abc"), "");
});

test("global preset accepts the new bassboost value", () => {
  shared.setEqPreset("bassboost");
  assert.equal(shared.eqPreset(), "bassboost");
  shared.setEqPreset("flat");
});

test("share codec round-trips playlists, unicode included", async () => {
  const { encodePlaylist, decodeShared } = await import("../src/mobile/sharecode.js");
  const pl = {
    title: "Road Mix",
    tracks: [
      { id: "a1", title: "Kesariya", artist: "Arijit Singh", album: "Brahmāstra", duration_secs: 240 },
      { id: "b2", title: "Tum Hi Ho", artist: "Arijit Singh" },
      { title: "no id — dropped" },
    ],
  };
  const code = encodePlaylist(pl);
  assert.match(code, /^TRANCE-SHARE:[A-Za-z0-9\-_]+$/);
  const back = decodeShared(`Try this:\n${code}\n`);
  assert.equal(back.name, "Road Mix");
  assert.equal(back.tracks.length, 2);
  assert.equal(back.tracks[0].title, "Kesariya");
  assert.equal(decodeShared("hello world"), null);
  assert.equal(decodeShared("TRANCE-SHARE:!!!not-base64!!!"), null);
  assert.equal(encodePlaylist({ title: "empty", tracks: [] }), "");
});
