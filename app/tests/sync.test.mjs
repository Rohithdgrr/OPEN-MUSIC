// Backup/restore + CSV/M3U contract: schema shape, LWW merge, tombstones,
// validation, replace-apply, and the export golden strings.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_APP,
  SETTINGS_KEYS,
  SYNC_VERSION,
  VISIBLE_SYNC_COOLDOWN_MS,
  applyBackup,
  autoSyncDue,
  backupFilename,
  buildBackup,
  mergeDocs,
  mergeRecords,
  mergeSettings,
  mergeTombstones,
  memStore,
  parseBackupFile,
  parseDocEnvelope,
  playlistFilename,
  playlistToCsv,
  playlistToM3u,
  readSettings,
  sectionEnvelope,
  splitBackupDoc,
  stampRecords,
  trackSecs,
  validateBackup,
  validateDocEnvelope,
  writeSettings,
} from "../src/sync.js";

const fav = (id, title = "T") => ({ id, title, artist: "A", album: "B", image: "u", duration_secs: 200 });
const pl = (id, title = "P", tracks = []) => ({ id, title, local: true, tracks });

test("stampRecords keeps existing numeric stamps and stamps the rest", () => {
  const out = stampRecords([{ id: "a", updatedAt: 5 }, { id: "b" }], 100);
  assert.equal(out.find((r) => r.id === "a").updatedAt, 5);
  assert.equal(out.find((r) => r.id === "b").updatedAt, 100);
  assert.deepEqual(stampRecords(null, 1), []);
});

test("buildBackup snapshots the three scopes with schema tag", () => {
  const doc = buildBackup({ favorites: [fav("f1")], playlists: [pl("p1")], settings: { "tm-lang": '["hindi"]' } }, 1000);
  assert.equal(doc.app, BACKUP_APP);
  assert.equal(doc.version, SYNC_VERSION);
  assert.equal(doc.favorites.records[0].updatedAt, 1000);
  assert.equal(doc.playlists.records[0].updatedAt, 1000);
  assert.deepEqual(doc.settings.records["tm-lang"], { value: '["hindi"]', updatedAt: 1000 });
  assert.deepEqual(doc.playlists.tombstones, []);
});

test("mergeRecords: strictly-newer stamp wins", () => {
  const out = mergeRecords(
    [{ id: "a", v: 1, updatedAt: 10 }],
    [{ id: "a", v: 2, updatedAt: 20 }],
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 2);
});

test("mergeRecords: ties break deterministically (no flip-flop)", () => {
  const x = { id: "a", v: 1, updatedAt: 10 };
  const y = { id: "a", v: 2, updatedAt: 10 };
  const ab = mergeRecords([x], [y], []);
  const ba = mergeRecords([y], [x], []);
  assert.deepEqual(ab, ba);
  assert.equal(ab.length, 1);
});

test("mergeRecords: tombstone deletes when newer-or-equal, loses when older", () => {
  const live = { id: "a", updatedAt: 10 };
  assert.deepEqual(mergeRecords([live], [], [{ id: "a", updatedAt: 10 }]), []);
  assert.deepEqual(mergeRecords([live], [], [{ id: "a", updatedAt: 9 }]).length, 1);
  assert.deepEqual(mergeRecords([], [live], [{ id: "a", updatedAt: 50 }]), []);
});

test("mergeRecords ignores records without ids", () => {
  assert.deepEqual(mergeRecords([null, { v: 1 }], [{ id: "a", updatedAt: 1 }], []), [{ id: "a", updatedAt: 1 }]);
});

test("mergeTombstones unions newest per id", () => {
  const out = mergeTombstones(
    [{ id: "a", updatedAt: 5 }],
    [{ id: "a", updatedAt: 9 }, { id: "b", updatedAt: 1 }],
  );
  assert.equal(out.length, 2);
  assert.equal(out.find((t) => t.id === "a").updatedAt, 9);
});

test("mergeDocs merges all three sections through one path", () => {
  const local = buildBackup(
    { favorites: [fav("f1")], playlists: [{ ...pl("p1"), title: "Old" }], settings: { "tm-lang": "a" } },
    10,
  );
  const remote = buildBackup(
    { favorites: [fav("f2")], playlists: [{ ...pl("p1"), title: "New" }], settings: { "tm-lang": "b" } },
    20,
  );
  const merged = mergeDocs(local, remote);
  assert.equal(merged.favorites.records.length, 2);
  assert.equal(merged.playlists.records[0].title, "New");
  assert.equal(merged.settings.records["tm-lang"].value, "b");
});

test("validateBackup rejects wrong tag, future version, malformed sections", () => {
  assert.match(validateBackup(null) || "", /object/);
  assert.match(validateBackup({ app: "nope", version: 1 }) || "", /not a trance-music-backup/);
  const good = buildBackup({}, 1);
  assert.equal(validateBackup(good), null);
  assert.match(validateBackup({ ...good, version: SYNC_VERSION + 1 }) || "", /unsupported/);
  assert.match(validateBackup({ ...good, favorites: { records: [{ noId: 1 }] } }) || "", /without an id/);
});

test("parseBackupFile throws readable errors for garbage", () => {
  assert.throws(() => parseBackupFile("{nope"), /not valid JSON/);
  assert.throws(() => parseBackupFile('{"app":"x"}'), /not a usable backup/);
  assert.deepEqual(parseBackupFile(JSON.stringify(buildBackup({}, 1))).app, BACKUP_APP);
});

test("applyBackup replaces locally and strips sync metadata", () => {
  const doc = buildBackup(
    { favorites: [fav("f1")], playlists: [pl("p1", "Road", [fav("t1")])], settings: { "tm-lang": "x", "tm-queue": "nope" } },
    42,
  );
  const applied = applyBackup(doc);
  assert.equal(applied.favorites[0].updatedAt, undefined);
  assert.equal(applied.playlists[0].tracks[0].title, "T");
  assert.deepEqual(applied.settings, { "tm-lang": "x" });
  assert.deepEqual(applied.counts, { favorites: 1, playlists: 1 });
});

test("readSettings/writeSettings round-trip only the allowlisted keys", () => {
  const store = memStore();
  store.setItem("tm-lang", "a");
  store.setItem("tm-queue", "q");
  assert.deepEqual(readSettings(store), { "tm-lang": "a" });
  const written = writeSettings({ "tm-country": "IN", "tm-queue": "q", "tm-xfade": "5" }, store);
  assert.deepEqual(written, ["tm-country", "tm-xfade"]);
  assert.equal(store.getItem("tm-country"), "IN");
  assert.ok(SETTINGS_KEYS.includes("tm-desk-widget-pos"));
});

test("trackSecs prefers numeric, parses m:ss, else -1", () => {
  assert.equal(trackSecs({ duration_secs: 200.4 }), 200);
  assert.equal(trackSecs({ duration: "3:54" }), 234);
  assert.equal(trackSecs({ duration: "1:02:03" }), 3723);
  assert.equal(trackSecs({ duration: "n/a" }), -1);
  assert.equal(trackSecs({}), -1);
});

test("playlistToCsv quotes cells with commas and quotes", () => {
  const csv = playlistToCsv(pl("p1", "Road, Trip", [{ title: 'Say "Hi"', artist: "A,B", album: "C", duration_secs: 60 }]));
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "playlist_name,track_title,artist,album,duration_seconds");
  assert.equal(lines[1], '"Road, Trip","Say ""Hi""","A,B",C,60');
});

test("playlistToM3u emits header plus EXTINF lines", () => {
  const m3u = playlistToM3u(pl("p1", "P", [{ title: "T", artist: "A", duration: "3:00" }, { title: "U" }]));
  assert.deepEqual(m3u.trim().split("\n"), ["#EXTM3U", "#EXTINF:180,A - T", "#EXTINF:-1,Unknown - U"]);
});

test("filenames are filesystem-safe and sortable", () => {
  assert.equal(playlistFilename("A/B: C?", "csv"), "AB C.csv");
  assert.equal(playlistFilename("", "m3u"), "playlist.m3u");
  assert.match(backupFilename(0), /^trance-music-backup-\d{8}-\d{6}\.json$/);
});

test("splitBackupDoc produces three tagged envelopes", () => {
  const doc = buildBackup({ favorites: [fav("f1")], playlists: [pl("p1")], settings: { "tm-lang": "x" } }, 7);
  const parts = splitBackupDoc(doc);
  assert.equal(parts.favorites.doc, "favorites");
  assert.equal(parts.favorites.records.length, 1);
  assert.equal(parts.playlists.doc, "playlists");
  assert.equal(parts.settings.doc, "settings");
  assert.deepEqual(parts.settings.records["tm-lang"], { value: "x", updatedAt: 7 });
  assert.equal(parts.favorites.exportedAt, 7);
});

test("validateDocEnvelope rejects wrong doc, version and shapes", () => {
  const env = sectionEnvelope("favorites", { records: [{ id: "a" }], tombstones: [] }, 1);
  assert.equal(validateDocEnvelope(env, "favorites"), null);
  assert.match(validateDocEnvelope(env, "playlists") || "", /expected the playlists doc/);
  assert.match(validateDocEnvelope({ ...env, version: SYNC_VERSION + 1 }, "favorites") || "", /unsupported/);
  assert.match(validateDocEnvelope({ ...env, records: {} }, "favorites") || "", /malformed/);
  const setEnv = sectionEnvelope("settings", { records: { k: { value: "v", updatedAt: 1 } } }, 1);
  assert.equal(validateDocEnvelope(setEnv, "settings"), null);
  assert.match(validateDocEnvelope({ ...setEnv, records: [] }, "settings") || "", /malformed/);
});

test("parseDocEnvelope throws readable errors", () => {
  assert.throws(() => parseDocEnvelope("{nope", "favorites"), /not valid JSON/);
  assert.throws(
    () => parseDocEnvelope(JSON.stringify(sectionEnvelope("playlists", { records: [] }, 1)), "favorites"),
    /expected the favorites doc/,
  );
});

test("mergeSettings picks the newer value per key", () => {
  const merged = mergeSettings(
    { "tm-lang": { value: "a", updatedAt: 10 } },
    { "tm-lang": { value: "b", updatedAt: 20 }, "tm-country": { value: "IN", updatedAt: 5 } },
    [],
  );
  assert.equal(merged.records["tm-lang"].value, "b");
  assert.equal(merged.records["tm-country"].value, "IN");
});

test("autoSyncDue gates only the visible trigger on cooldown", () => {
  assert.equal(autoSyncDue("boot", 0, 1000), true);
  assert.equal(autoSyncDue("online", 999, 1000), true);
  assert.equal(autoSyncDue("edit", 999, 1000), true);
  assert.equal(autoSyncDue("visible", 0, VISIBLE_SYNC_COOLDOWN_MS), true);
  assert.equal(autoSyncDue("visible", 0, VISIBLE_SYNC_COOLDOWN_MS - 1), false);
  assert.equal(autoSyncDue("visible", 500, 500 + VISIBLE_SYNC_COOLDOWN_MS), true);
});
