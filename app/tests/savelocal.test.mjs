// savelocal.test.mjs — "Save to local" (2026-10-24): the file lands on the
// device itself via MediaStore, distinct from "Download" (vault). Pure pieces
// + the full flow with fake deps, + the menus wiring contract.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { localFileName, bridgeResult, saveTrackLocal, SAVED_DIR } from "../src/mobile/savelocal.js";

test("localFileName builds the MediaStore display name", () => {
  assert.equal(
    localFileName({ title: "Believer", artist: "Imagine Dragons", path: "/vault/a.m4a" }),
    "Imagine Dragons - Believer.m4a",
  );
  assert.equal(localFileName({ title: "Nijam", artist: "Thaman S", path: "/x.opus" }), "Thaman S - Nijam.opus");
assert.equal(
  localFileName({ title: "Believer", artist: "Dan Reynolds, Wayne Sermon, Ben Mckee" }),
  "Dan Reynolds - Believer.m4a", // lead artist only — not the full married string
);
  // Hostile characters (Windows-flavored separators + quotes) never reach the
  // name; each strip becomes one space and runs collapse.
  assert.equal(localFileName({ title: 'AC/DC: "Boom"', artist: "Big //*|band", path: "no.ext" }), "Big band - AC DC Boom.m4a");
  // Control characters collapse to spaces, double spaces collapse.
  assert.equal(localFileName({ title: "a\tb\nc", artist: "X", path: "p.m4a" }), "X - a b c.m4a");
  // Long titles cut at 80, no trailing dash remnant.
  const long = localFileName({ title: "T".repeat(120) + " -", artist: "A", path: "x.m4a" });
  assert.ok(long.length <= 80 + " - .m4a".length + 2, long.length);
  assert.ok(!/[ -]+\.m4a$/.test(long), long);
  // Empty stem falls back to "song".
  assert.equal(localFileName({ title: "", artist: "", path: "x.m4a" }), "song.m4a");
});

test("bridgeResult parses the TmBridge line protocol", () => {
  assert.deepEqual(bridgeResult("ok Imagine Dragons - Believer.m4a"), { status: "ok", name: "Imagine Dragons - Believer.m4a" });
  assert.deepEqual(bridgeResult("same X - Y.opus"), { status: "same", name: "X - Y.opus" });
  assert.deepEqual(bridgeResult("same"), { status: "same", name: "" });
  assert.deepEqual(bridgeResult("err: save to local needs Android 10 or newer"), { status: "err", message: "save to local needs Android 10 or newer" });
  assert.deepEqual(bridgeResult(""), { status: "err", message: "unknown bridge response" });
});

function fakeDeps({ entries = [], downloaded = null, bridgeRes = "ok SAVED.m4a" } = {}) {
  const bridgeCalls = [];
  const downloadCalls = [];
  return {
    deps: {
      invoke: async (cmd) => {
        if (cmd === "list_downloads") return { entries };
        throw new Error(`unexpected invoke ${cmd}`);
      },
      downloadTrack: async (track) => {
        downloadCalls.push(track.id);
        return downloaded;
      },
      bridge: {
        saveLocal: async (json) => {
          bridgeCalls.push(JSON.parse(json));
          return bridgeRes;
        },
      },
    },
    bridgeCalls,
    downloadCalls,
  };
}

test("saveTrackLocal hands the vaulted file to the bridge (no re-download)", async () => {
  const entries = [{ id: "t1", title: "Believer", artist: "Imagine Dragons", album: "Evolve", duration_secs: 204, path: "/vault/t1.m4a", bytes: 5 }];
  const { deps, bridgeCalls } = fakeDeps({
    entries,
    bridgeRes: "ok Imagine Dragons - Believer.m4a",
  });
  const r = await saveTrackLocal({ id: "t1", title: "Believer" }, deps);
  assert.deepEqual(bridgeCalls[0], { path: "/vault/t1.m4a", display: "Imagine Dragons - Believer.m4a", title: "Believer", artist: "Imagine Dragons", album: "Evolve" });
  assert.deepEqual(r, { status: "ok", name: "Imagine Dragons - Believer.m4a", dir: SAVED_DIR });
});

test("saveTrackLocal downloads first, then exports", async () => {
  const { deps, bridgeCalls, downloadCalls } = fakeDeps({
    entries: [],
    downloaded: { path: "/vault/new.m4a" },
  });
  const r = await saveTrackLocal({ id: "t2", title: "Nijam", artist: "Thaman S", album: "A" }, deps);
  assert.deepEqual(downloadCalls, ["t2"], "download ran exactly once");
  assert.deepEqual(bridgeCalls[0], { path: "/vault/new.m4a", display: "Thaman S - Nijam.m4a", title: "Nijam", artist: "Thaman S", album: "A" });
  assert.equal(r.status, "ok");
});

test("saveTrackLocal surfaces the idempotent 'same' and honest failures", async () => {
  const same = fakeDeps({ entries: [{ id: "t", title: "T", artist: "A", path: "/v/x.opus" }], bridgeRes: "same A - T.opus" });
  const r = await saveTrackLocal({ id: "t" }, same.deps);
  assert.equal(r.status, "same");

  const err = fakeDeps({ entries: [{ id: "t", title: "T", artist: "A", path: "/v/x.m4a" }], bridgeRes: "err: save to local needs Android 10 or newer" });
  await assert.rejects(
    saveTrackLocal({ id: "t" }, err.deps),
    /needs Android 10/,
  );

  const failDl = fakeDeps({ entries: [], downloaded: null });
  await assert.rejects(saveTrackLocal({ id: "q" }, failDl.deps), /Download failed/);

  const noBridge = fakeDeps({ entries: [{ id: "t", path: "/v/x.m4a" }] });
  delete noBridge.deps.bridge;
  await assert.rejects(saveTrackLocal({ id: "t" }, noBridge.deps), /Android app/);

  await assert.rejects(saveTrackLocal(null, fakeDeps().deps), /Pick a track/);
});

test("menus carries 'Save to local' right under 'Download' on both menus", async () => {
  const src = await readFile(join(import.meta.dirname, "../src/mobile/menus.js"), "utf8");
  // The track menu push + the library spread row.
  assert.equal(src.split('label: "Save to local"').length, 3, "two menu sites + docs mention");
  assert.ok(src.includes('if (saveLocalBridge()) {'), "track menu gated on the bridge");
  assert.ok(src.includes('...(saveLocalBridge() ? [{ icon: "save"'), "library menu included");
  // Order contract: save-to-local ships directly after Download, before Share.
  const dlIdx = src.indexOf('label: "Download",');
  const saveIdx = src.indexOf('label: "Save to local"');
  const shareIdx = src.indexOf('label: "Share Track",');
  assert.ok(saveIdx > dlIdx && saveIdx < shareIdx, "item order in trackMenu");
  // One glue fn, wired from both menus.
  assert.ok(src.includes("async function runSaveLocal(track) {"), "glue present");
  assert.ok(src.includes("Saved to ${SAVED_DIR}/${r.name}"), "success toast names the folder");
});

test("Kotlin bridge dedupes on the display name, not the bytes", async () => {
  // A re-downloaded vault copy can differ byte-for-byte while being the same
  // song; a size-joined query missed it and MediaProvider renamed the second
  // insert to " <n>.m4a" (observed live: "(1).m4a" duplicates).
  const src = await readFile(join(import.meta.dirname, "../src-tauri/android-overlay/kotlin/MediaHub.kt"), "utf8");
  const i = src.indexOf("${MediaStore.MediaColumns.DISPLAY_NAME} = ?\",");
  assert.ok(i > -1, "name-only dedupe selection");
  const seg = src.slice(Math.max(0, i - 400), i + 400);
  assert.ok(!seg.includes("AND ${MediaStore.MediaColumns.SIZE} = ?"), "no size join in dedupe");
  assert.ok(src.includes("MediaProvider can rename on a display-name race"), "rename readback documented");
  assert.ok(src.includes('query(\n            uri,'), "post-insert name readback");
});
