// jam-follow.test.mjs — unit tests for the guest resolution pipeline
// (docs/listen-together.md §12/§13): local → catalog → mirror.
// follow.js is pure and dependency-injected, so this runs with plain node.
import { test } from "node:test";
import assert from "node:assert/strict";

const { findLocalTrack, resolveFromCatalog, resolveGuestTrack, createResolver } = await import(
  "../src/jam/follow.js"
);

const invokeOk = async (cmd, params) => {
  if (cmd === "resolve_song") {
    if (params.id === "valid-track") {
      return {
        proxy_url: "http://127.0.0.1:8080/stream?id=valid-track",
        range_status: "ok",
        title: "Catalog Title",
        artist: "Catalog Artist",
      };
    }
    if (params.id === "dead-track") {
      return { range_status: "dead", proxy_url: "" };
    }
    throw new Error("Track not available");
  }
  throw new Error("unexpected command " + cmd);
};

const frame = { trackId: "valid-track", title: "Host Song", artist: "Host Artist" };

test("findLocalTrack - queue hit carries its index", () => {
  const queue = [{ track: { id: "t1", title: "A" } }, { track: { id: "t2", title: "B" } }];
  const hit = findLocalTrack("t2", queue, []);
  assert.equal(hit.index, 1);
  assert.equal(hit.source, "queue");
  assert.equal(hit.track.id, "t2");
});

test("findLocalTrack - extras hit (history/favs/vault) has index -1", () => {
  const hit = findLocalTrack("t9", [], [{ id: "t9", title: "Vaulted" }]);
  assert.equal(hit.index, -1);
  assert.equal(hit.source, "local");
});

test("findLocalTrack - miss and bad ids", () => {
  assert.equal(findLocalTrack("nope", [], []), null);
  assert.equal(findLocalTrack("", [], []), null);
  assert.equal(findLocalTrack(undefined, [], []), null);
});

test("resolveFromCatalog - resolves and prefers frame metadata", async () => {
  const r = await resolveFromCatalog(frame, { invoke: invokeOk });
  assert.equal(r.source, "catalog");
  assert.equal(r.track.id, "valid-track");
  assert.equal(r.track.title, "Host Song");
  assert.equal(r.track.artist, "Host Artist");
});

test("resolveFromCatalog - dead and failing ids are honest errors", async () => {
  const dead = await resolveFromCatalog({ trackId: "dead-track" }, { invoke: invokeOk });
  assert.equal(dead.track, undefined);
  assert.ok(dead.error);
  const boom = await resolveFromCatalog({ trackId: "throws" }, { invoke: invokeOk });
  assert.equal(boom.track, undefined);
  assert.ok(boom.error.includes("Track not available"));
});

test("resolveFromCatalog - no invoke injected is an error, not a throw", async () => {
  const r = await resolveFromCatalog(frame, {});
  assert.equal(r.track, undefined);
  assert.equal(r.error, "no invoke");
});

test("resolveGuestTrack - local beats catalog", async () => {
  const r = await resolveGuestTrack(
    frame,
    [{ track: { id: "valid-track", title: "Queued" } }],
    [],
    { invoke: invokeOk },
  );
  assert.equal(r.source, "queue");
  assert.equal(r.index, 0);
});

test("resolveGuestTrack - catalog path returns index -1", async () => {
  const r = await resolveGuestTrack(frame, [], [], { invoke: invokeOk });
  assert.equal(r.source, "catalog");
  assert.equal(r.index, -1);
  assert.equal(r.track.title, "Host Song");
});

test("resolveGuestTrack - full miss mirrors with §4.5 text", async () => {
  const r = await resolveGuestTrack(
    { trackId: "dead-track", title: "Ghost Song", artist: "Nobody" },
    [],
    [],
    { invoke: invokeOk },
  );
  assert.ok(r.mirror.includes("Ghost Song"));
  assert.ok(r.mirror.includes("not on this device"));
  assert.equal(r.track, undefined);
});

test("resolveGuestTrack - invalid frame mirrors immediately", async () => {
  const r = await resolveGuestTrack({}, [], [], { invoke: invokeOk });
  assert.equal(r.error, "invalid_frame");
});

test("createResolver - stale completions are superseded", async () => {
  const deferreds = [];
  const slow = createResolver({
    invoke: async (cmd) => {
      if (cmd !== "resolve_song") throw new Error("nope");
      await new Promise((res) => deferreds.push(res));
      return { proxy_url: "x", range_status: "ok", title: "S" };
    },
  });
  const first = slow(frame, [], []);
  const second = slow({ trackId: "other", title: "Other" }, [], []);
  // Settle the SECOND resolve (the latest generation) first.
  deferreds[1]();
  const secondResult = await second;
  assert.equal(secondResult.superseded, undefined);
  // Now settle the stale one — it must report superseded, not a track.
  deferreds[0]();
  const firstResult = await first;
  assert.equal(firstResult.superseded, true);
});

test("createResolver - result passes through when not superseded", async () => {
  const resolve = createResolver({ invoke: invokeOk });
  const r = await resolve(frame, [], []);
  assert.equal(r.source, "catalog");
  assert.equal(r.track.id, "valid-track");
});
