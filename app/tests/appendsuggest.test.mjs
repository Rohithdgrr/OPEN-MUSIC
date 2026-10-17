// appendsuggest.test.mjs — the queue tab's append browser, pure half.
// docs/mobile/06-features.md "Queue append search browser": pickSongs shapes
// the search_songs page into capped, deduped, playable rows; appendRowHTML
// renders them with the three queue actions where the search screen shows a
// type label. The module stays import-free so the suite needs no window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPEND_CAP, appendRowHTML, pickSongs } from "../src/mobile/appendsuggest.js";

const PAGE = {
  tracks: [
    { id: "a1", title: "Saiyaara", artist: "Mohit Chauhan", image: "https://x/a.jpg" },
    { id: "a2", title: "Saiyaara" }, // dup by title → dropped
    { id: "a3", title: "Sameer", artist: "Arijit Singh", image: "https://x/b.jpg" },
    { title: "No id row" }, // unusable → dropped
    { id: "", title: "Empty id" }, // unusable → dropped
    { id: "a4", title: "Saiyan", artist: "Sohail Sen" },
    { id: "a5", title: "Saath", artist: "Arijit Singh" },
    { id: "a6", title: "Saibo", artist: "Shreya Ghoshal" },
    { id: "a7", title: "Over the cap" }, // beyond APPEND_CAP
  ],
};

test("pickSongs keeps shaped song rows in upstream order, deduped by title", () => {
  const got = pickSongs(PAGE);
  assert.deepEqual(
    got.map((t) => t.id),
    ["a1", "a3", "a4", "a5", "a6"],
  );
  assert.equal(got[0].title, "Saiyaara");
  assert.equal(got[0].artist, "Mohit Chauhan");
  assert.equal(got[0].image, "https://x/a.jpg");
  assert.equal(got[1].artist, "Arijit Singh");
});

test("pickSongs caps at APPEND_CAP and is null/junk-safe", () => {
  assert.equal(APPEND_CAP, 5);
  const many = { tracks: Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, title: `T${i}` })) };
  assert.equal(pickSongs(many).length, APPEND_CAP);
  assert.deepEqual(pickSongs({ tracks: [] }), []);
  assert.deepEqual(pickSongs({}), []);
  assert.deepEqual(pickSongs(null), []);
  assert.deepEqual(pickSongs(42), []);
});

test("appendRowHTML renders one row with the three actions as small buttons", () => {
  const row = appendRowHTML(PAGE.tracks[0], 2);
  const off = (needle) => row.indexOf(needle);
  // three verbs, in the user's order: play now → play next → add to queue
  const now = off('data-append-action="now"');
  const next = off('data-append-action="next"');
  const queue = off('data-append-action="queue"');
  assert.ok(now >= 0, "missing the Play now button");
  assert.ok(next > now, "Play next must follow Play now");
  assert.ok(queue > next, "Add to queue must follow Play next");
  for (const label of ["Play now", "Play next", "Add to queue"]) {
    assert.ok(row.includes(`title="${label}"`), `the ${label} button needs its title/aria`);
  }
  assert.ok(row.includes('data-append-row="2"'), "the buttons must carry the row index");
  // icon-grammar matches the search row feel
  for (const icon of ["play_arrow", "playlist_play", "playlist_add"]) {
    assert.ok(row.includes(icon), `missing icon ${icon}`);
  }
  // the row body: art + title + artist (no right-side type label — the
  // buttons replace the SONG slot)
  assert.ok(row.includes(">Saiyaara<"), "row title");
  assert.ok(row.includes("Mohit Chauhan"), "row artist");
});

test("appendRowHTML escapes hostile text and falls back when the art resolver is empty", () => {
  const row = appendRowHTML(
    { id: "h1", title: '<img src=x onerror=alert(1)>', artist: "Michał & \"Sons'" },
    0,
  );
  assert.ok(!row.includes("<img src=x onerror"), "raw markup must not survive in the title");
  assert.ok(row.includes("&lt;img src=x"), "title is escaped");
  assert.ok(row.includes("Michał &amp; &quot;Sons&#39;"), "artist escapes &, quotes");
  const artless = appendRowHTML({ id: "h2", title: "No art" }, 0);
  assert.ok(artless.includes("music_note"), "no image → the glyph, never an empty img");
  const arted = appendRowHTML({ id: "h3", title: "T", image: "https://cdn/x.jpg" }, 0);
  assert.ok(arted.includes('src="https://cdn/x.jpg"'), "the art resolver's src is used");
});
