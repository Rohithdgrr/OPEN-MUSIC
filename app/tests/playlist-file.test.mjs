import test from "node:test";
import assert from "node:assert/strict";
import { importPlaylistFile, parsePlaylistFile } from "../src/playlist-file.js";

test("M3U parses display metadata and never treats the media path as a track URL", () => {
  const result = parsePlaylistFile(
    "#EXTM3U\n#EXTINF:205,Artist Name - Song Name\nhttps://private.example/path/song.flac?token=secret\n",
    "m3u",
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tracks, [{ artists: ["Artist Name"], name: "Song Name", duration_ms: 205000 }]);
  assert.equal(JSON.stringify(result).includes("private.example"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("PLS entries are ordered numerically and use title rather than the file path", () => {
  const result = parsePlaylistFile(
    "[playlist]\nFile10=https://example.test/ten.mp3\nTitle10=Artist - Tenth\nLength10=180\nFile2=C:\\\\music\\\\two.mp3\nTitle2=Artist - Second\nLength2=200\nNumberOfEntries=2\nVersion=2",
    "pls",
  );
  assert.deepEqual(result.tracks.map((track) => track.name), ["Second", "Tenth"]);
  assert.deepEqual(result.tracks.map((track) => track.duration_ms), [200000, 180000]);
});

test("unsupported, oversized, empty and path-only inputs fail closed", () => {
  assert.match(parsePlaylistFile("x", "xml").errors[0], /M3U/);
  assert.match(parsePlaylistFile("x".repeat(2 * 1024 * 1024 + 1), "m3u").errors[0], /2 MB/);
  assert.equal(parsePlaylistFile("", "m3u").tracks.length, 0);
  assert.equal(parsePlaylistFile("#EXTM3U\nC:\\\\music\\\\song.mp3", "m3u").tracks[0].name, "song");
});

test("catalog import keeps only honest matches, reports misses, and reports progress", async () => {
  const progress = [];
  const calls = [];
  const invoke = async (_command, { query }) => {
    calls.push(query);
    return {
      tracks: query.includes("Hit")
        ? [{ id: "1", title: "Hit Song", artist: "Artist", album: "Album", duration_secs: 180 }]
        : [],
    };
  };
  const result = await importPlaylistFile(
    "#EXTM3U\n#EXTINF:180,Artist - Hit Song\nhttps://x.test/a.mp3\n#EXTINF:160,Artist - Missing\nhttps://x.test/b.mp3",
    "Imported",
    "m3u",
    invoke,
    (done, total) => progress.push([done, total]),
  );
  assert.equal(result.matched, 1);
  assert.equal(result.missed, 1);
  assert.equal(result.playlist.title, "Imported");
  assert.deepEqual(result.playlist.tracks.map((track) => track.id), ["1"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(progress, [[2, 2]]);
});
