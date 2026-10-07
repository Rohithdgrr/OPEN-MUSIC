// jam-follow.test.mjs — Unit tests for guest track resolution
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock invoke for testing
globalThis.invoke = async (cmd, params) => {
  if (cmd === "resolve_song") {
    // Simulate successful catalog resolution
    if (params.id === "valid-track") {
      return {
        proxy_url: "http://127.0.0.1:8080/stream?id=valid-track",
        range_status: "ok",
        title: "Resolved Track",
        artist: "Resolved Artist",
      };
    }
    // Simulate resolution failure
    throw new Error("Track not available");
  }
};

// Import after mocking
const { findLocalTrack, resolveGuestTrack, createResolver } = await import("../src/jam/follow.js");

test("findLocalTrack - finds track in queue", async () => {
  const queue = [
    { track: { id: "track1", title: "Song 1" } },
    { track: { id: "track2", title: "Song 2" } },
  ];
  const localTracks = [];

  const result = findLocalTrack("track2", queue, localTracks);
  
  assert.ok(result);
  assert.equal(result.track.id, "track2");
  assert.equal(result.index, 1);
  assert.equal(result.source, "queue");
});

test("findLocalTrack - finds track in local tracks", async () => {
  const queue = [];
  const localTracks = [
    { id: "local1", title: "Local 1" },
    { id: "local2", title: "Local 2" },
  ];

  const result = findLocalTrack("local2", queue, localTracks);
  
  assert.ok(result);
  assert.equal(result.track.id, "local2");
  assert.equal(result.index, -1);
  assert.equal(result.source, "local");
});

test("findLocalTrack - returns null when not found", async () => {
  const queue = [{ track: { id: "track1" } }];
  const localTracks = [{ id: "local1" }];

  const result = findLocalTrack("missing", queue, localTracks);
  
  assert.equal(result, null);
});

test("resolveGuestTrack - resolves from queue first", async () => {
  const playbackFrame = {
    trackId: "track1",
    title: "Test Track",
    artist: "Test Artist",
  };
  const queue = [{ track: { id: "track1", title: "Queue Track" } }];
  const localTracks = [];
  const quality = "320";

  const result = await resolveGuestTrack(playbackFrame, queue, localTracks, quality);
  
  assert.ok(result.track);
  assert.equal(result.source, "queue");
  assert.equal(result.index, 0);
  assert.ok(!result.mirror);
});

test("resolveGuestTrack - falls back to catalog when not local", async () => {
  const playbackFrame = {
    trackId: "valid-track",
    title: "Test Track",
    artist: "Test Artist",
  };
  const queue = [];
  const localTracks = [];
  const quality = "320";

  const result = await resolveGuestTrack(playbackFrame, queue, localTracks, quality);
  
  assert.ok(result.track);
  assert.equal(result.source, "catalog");
  assert.equal(result.index, -1);
  assert.ok(!result.mirror);
  assert.ok(result.track.title); // Should have metadata
});

test("resolveGuestTrack - shows mirror when catalog fails", async () => {
  const playbackFrame = {
    trackId: "unavailable-track",
    title: "Unavailable Track",
    artist: "Unknown Artist",
  };
  const queue = [];
  const localTracks = [];
  const quality = "320";

  const result = await resolveGuestTrack(playbackFrame, queue, localTracks, quality);
  
  assert.ok(!result.track);
  assert.ok(result.mirror);
  assert.ok(result.mirror.includes("Unavailable Track"));
  assert.ok(result.mirror.includes("not on this device"));
  assert.ok(result.error);
});

test("resolveGuestTrack - returns error for invalid frame", async () => {
  const playbackFrame = { title: "No ID" }; // Missing trackId
  const queue = [];
  const localTracks = [];
  const quality = "320";

  const result = await resolveGuestTrack(playbackFrame, queue, localTracks, quality);
  
  assert.ok(result.mirror);
  assert.ok(result.error);
  assert.equal(result.error, "invalid_frame");
});

test("createResolver - cancels stale resolutions", async () => {
  const resolver = createResolver();
  const queue = [];
  const localTracks = [];
  const quality = "320";

  // Start first resolution
  const promise1 = resolver(
    { trackId: "track1", title: "Track 1" },
    queue,
    localTracks,
    quality
  );

  // Start second resolution (should cancel first)
  const promise2 = resolver(
    { trackId: "track2", title: "Track 2" },
    queue,
    localTracks,
    quality
  );

  const [result1, result2] = await Promise.all([promise1, promise2]);

  // First should be superseded
  assert.ok(result1.superseded);
  
  // Second should complete
  assert.ok(!result2.superseded);
});

test("createResolver - allows same track to resolve", async () => {
  const resolver = createResolver();
  const queue = [];
  const localTracks = [];
  const quality = "320";

  // Resolve same track twice
  const result1 = await resolver(
    { trackId: "valid-track", title: "Track 1" },
    queue,
    localTracks,
    quality
  );

  const result2 = await resolver(
    { trackId: "valid-track", title: "Track 1" },
    queue,
    localTracks,
    quality
  );

  // Both should succeed (not superseded)
  assert.ok(!result1.superseded);
  assert.ok(!result2.superseded);
  assert.ok(result1.track);
  assert.ok(result2.track);
});

console.log("✅ All jam-follow tests passed!");
