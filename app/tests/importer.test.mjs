// importer.test.mjs — the CSV → catalog-matching path (docs/spotify-android-
// canvas.md §10). Locks in: query is name+artist (never the ISRC), candidates
// are scored, honest misses are counted, and the playlist keeps Track fields.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseExportifyCsv, importCsvToPlaylist } = await import("../src/importer.js");

const csv = [
  "Track URI,Track Name,Artist URI(s),Artist Name(s),Album URI,Album Name,Track Duration (ms),ISRC",
  "spotify:track:1,Believer,spotify:artist:1,Imagine Dragons,spotify:album:1,Evolve,204000,USUM71703861",
  'spotify:track:2,Pasoori,spotify:artist:2,"Ali Sethi, Shae Gill",spotify:album:2,Pasoori,193000,USQABCD12345',
].join("\n");

const track = (o) => ({
  id: o.id,
  title: o.title,
  artist: o.artist,
  album: o.album || "",
  duration_secs: o.duration_secs || 0,
  duration: o.duration || "",
  image: "",
});

test("importCsvToPlaylist — name+artist queries, scored candidates, honest miss counts", async () => {
  const seen = [];
  const invoke = async (cmd, params) => {
    seen.push(params);
    assert.equal(cmd, "search_songs");
    if (/believer/i.test(params.query)) {
      return {
        tracks: [
          track({ id: "remix", title: "Believer (Kaskade Remix)", artist: "Imagine Dragons, Kaskade", duration_secs: 190 }),
          track({ id: "exact", title: "Believer", artist: "Imagine Dragons", duration_secs: 204 }),
        ],
      };
    }
    return { tracks: [track({ id: "cover", title: "Pasoori (Tribute)", artist: "Backing Business", duration_secs: 218 })] };
  };

  const { playlist, matched, missed, errors } = await importCsvToPlaylist(csv, "My Spotify", invoke);

  assert.equal(errors.length, 0);
  assert.equal(matched, 1, "Believer matches, the Pasoori tribute must not");
  assert.equal(missed, 1);
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.tracks[0].id, "exact");
  assert.equal(playlist.tracks[0].title, "Believer");
  assert.equal(playlist.source, "spotify-csv");

  for (const p of seen) {
    assert.ok(!/USUM71703861|USQABCD12345/.test(JSON.stringify(p)), `ISRC leaked into ${p.query}`);
  }
  assert.ok(seen.some((p) => p.query === "Believer Imagine Dragons"), "query must be name + first artist");
  assert.ok(seen.every((p) => p.limit >= 5), "candidates must be fetched, not limit:1");
});

test("importCsvToPlaylist — empty CSV short-circuits without touching invoke", async () => {
  let called = 0;
  const { matched, missed } = await importCsvToPlaylist("Track Name\n", "x", async () => {
    called++;
    return { tracks: [] };
  });
  assert.equal(matched, 0);
  assert.equal(missed, 0);
  assert.equal(called, 0);
});

test("parseExportifyCsv — quoted commas survive (artists)", () => {
  const { tracks, errors } = parseExportifyCsv(csv);
  assert.equal(errors.length, 0);
  assert.deepEqual(tracks[1].artists, ["Ali Sethi", "Shae Gill"]);
});
