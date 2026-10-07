// albumgroup.test.mjs — language-variant album grouping + junk-track rule.
// Pure DOM-free helpers in ../src/albumgroup.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  baseAlbumTitle,
  groupLangAlbums,
  isJunkTrack,
  variantsFor,
} from "../src/albumgroup.js";

const album = (id, title, language, token) => ({
  id,
  title,
  subtitle: "Artist",
  image: "",
  kind: "album",
  token: token || id,
  language: language || "",
});

test("base title strips a trailing language suffix", () => {
  assert.equal(baseAlbumTitle("Baahubali - The Beginning (Telugu)"), "baahubali - the beginning");
  assert.equal(baseAlbumTitle("Baahubali - The Beginning"), "baahubali - the beginning");
  assert.equal(baseAlbumTitle("Hits - Tamil"), "hits");
});

test("same title + same language stays two cards", () => {
  const out = groupLangAlbums([album("a", "X", "hindi"), album("b", "X", "hindi")]);
  assert.equal(out.length, 2, "same-language editions never merge");
  assert.equal(variantsFor("a"), null);
});

test("same movie in three languages becomes one card", () => {
  const list = [
    album("h", "Baahubali - The Beginning", "hindi"),
    album("te", "Baahubali - The Beginning (Telugu)", "telugu"),
    album("m", "Baahubali - The Beginning", "malayalam"),
  ];
  const out = groupLangAlbums(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].langCount, 3);
  const v = variantsFor(out[0].token);
  assert.equal(v.length, 3, "every variant token is kept for the merged fetch");
  assert.deepEqual(
    v.map((x) => x.language).sort(),
    ["hindi", "malayalam", "telugu"],
  );
});

test("language-less rows and non-albums pass through", () => {
  const rows = [
    { id: "1", title: "X", language: "" },
    { id: "2", title: "X", language: "" },
    { id: "3", title: "Y", kind: "playlist", language: "hindi" },
  ];
  assert.equal(groupLangAlbums(rows).length, 3);
});

test("junk needs a junk title AND a missing artist", () => {
  assert.equal(isJunkTrack({ title: "This is a sample trailer - testing", artist: "NULL" }), true);
  assert.equal(isJunkTrack({ title: "This is a sample trailer - testing", artist: "Thaman S" }), true);
  assert.equal(isJunkTrack({ title: "Trailer Music", artist: "Real Artist" }), false);
  assert.equal(isJunkTrack({ title: "Real Song", artist: "Real Artist" }), false);
});
