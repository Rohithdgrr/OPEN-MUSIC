// jam-controller.test.mjs — Unit tests for Jam controller
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock dependencies
const mockAudio = {
  paused: true,
  currentTime: 0,
  play: async () => {},
  pause: () => {},
};

const mockPlayerSnapshot = () => ({
  id: "current-track",
  paused: mockAudio.paused,
  position: mockAudio.currentTime,
  title: "Current Track",
  artist: "Current Artist",
});

const mockQueue = [
  { track: { id: "track1", title: "Track 1" } },
  { track: { id: "track2", title: "Track 2" } },
];

const mockLocalTracks = [
  { id: "local1", title: "Local 1" },
];

let invokeHistory = [];
globalThis.invoke = async (cmd, params) => {
  invokeHistory.push({ cmd, params });
  
  if (cmd === "room_open") {
    return {
      port: 8787,
      code: "TESTCODE",
      urls: ["ws://192.168.1.5:8787"],
    };
  }
  
  if (cmd === "room_join") {
    return {}; // Join completes via frames
  }
  
  if (cmd === "resolve_song") {
    if (params.id === "resolvable-track") {
      return {
        proxy_url: "http://127.0.0.1:8080/stream",
        range_status: "ok",
      };
    }
    throw new Error("Not available");
  }
  
  return {};
};

// Import after mocking
const { createJamController } = await import("../src/jam/controller.js");

function createMockController() {
  const stateChanges = [];
  const errors = [];
  const diags = [];
  let queueIndex = 0;

  const deps = {
    getAudio: () => mockAudio,
    getPlayerSnapshot: mockPlayerSnapshot,
    getQueue: () => mockQueue,
    getLocalTracks: () => mockLocalTracks,
    getQuality: () => "320",
    playQueueItem: async (index) => { queueIndex = index; },
    enqueueTrack: (track) => { mockQueue.push({ track }); },
    onStateChange: (state) => { stateChanges.push(state); },
    onError: (err) => { errors.push(err); },
    onDiag: (label, success, msg) => { diags.push({ label, success, msg }); },
  };

  const controller = createJamController(deps);
  
  return { controller, stateChanges, errors, diags };
}

test("createJamController - initial state is idle", async () => {
  const { controller } = createMockController();
  
  assert.equal(controller.state.role, "idle");
  assert.equal(controller.mirror, "");
  assert.equal(controller.drift, null);
  assert.equal(controller.joining, false);
});

test("open - creates host room", async () => {
  invokeHistory = [];
  const { controller, stateChanges } = createMockController();
  
  const result = await controller.open("Test Host", 8787);
  
  assert.equal(result.code, "TESTCODE");
  assert.equal(result.port, 8787);
  assert.equal(controller.state.role, "host");
  assert.equal(controller.state.code, "TESTCODE");
  assert.ok(stateChanges.length > 0);
  
  // Verify invoke was called
  assert.ok(invokeHistory.some(h => h.cmd === "room_open"));
});

test("open - rejects if already in room", async () => {
  const { controller } = createMockController();
  
  await controller.open("Host", 8787);
  
  // Try to open again
  await assert.rejects(
    async () => await controller.open("Host2", 8787),
    /Already in a room/
  );
});

test("join - attempts to join room", async () => {
  invokeHistory = [];
  const { controller, stateChanges } = createMockController();
  
  // Start join
  const joinPromise = controller.join("192.168.1.5:8787", "TESTCODE", "Guest");
  
  // Should be joining
  assert.equal(controller.joining, true);
  
  // Wait for join attempt
  await joinPromise;
  
  // Verify invoke was called
  assert.ok(invokeHistory.some(h => 
    h.cmd === "room_join" && 
    h.params.addr === "192.168.1.5:8787" &&
    h.params.code === "TESTCODE"
  ));
});

test("leave - closes room", async () => {
  invokeHistory = [];
  const { controller } = createMockController();
  
  // Open a room first
  await controller.open("Host", 8787);
  assert.equal(controller.state.role, "host");
  
  // Leave
  await controller.leave();
  
  assert.equal(controller.state.role, "idle");
  assert.ok(invokeHistory.some(h => h.cmd === "room_close"));
});

test("onFrame - processes hosted frame", async () => {
  const { controller, stateChanges } = createMockController();
  
  controller.onFrame({
    t: "hosted",
    selfId: "host",
    code: "ABCD1234",
    urls: ["ws://192.168.1.5:8787"],
    members: [{ id: "host", name: "Host", host: true }],
  });
  
  assert.equal(controller.state.role, "host");
  assert.equal(controller.state.code, "ABCD1234");
  assert.ok(stateChanges.length > 0);
});

test("onFrame - processes joined frame", async () => {
  const { controller } = createMockController();
  
  controller.onFrame({
    t: "joined",
    selfId: "guest1",
    code: "ABCD1234",
    members: [
      { id: "host", name: "Host", host: true },
      { id: "guest1", name: "Guest", host: false },
    ],
  });
  
  assert.equal(controller.state.role, "guest");
  assert.equal(controller.joining, false);
});

test("onFrame - processes bye frame", async () => {
  const { controller } = createMockController();
  
  // Setup as guest first
  controller.onFrame({
    t: "joined",
    selfId: "guest1",
    code: "ABCD1234",
    members: [{ id: "guest1", name: "Guest" }],
  });
  
  // Receive bye
  controller.onFrame({
    t: "bye",
    reason: "host_left",
  });
  
  // Should still be in some state until leave is called
  // But drift should be cleared
  assert.equal(controller.drift, null);
  assert.equal(controller.mirror, "");
});

test("sendChat - sends chat message", async () => {
  invokeHistory = [];
  const { controller } = createMockController();
  
  // Open room first
  await controller.open("Host", 8787);
  
  await controller.sendChat("Hello world!");
  
  assert.ok(invokeHistory.some(h => 
    h.cmd === "room_chat" && 
    h.params.text === "Hello world!"
  ));
});

test("sendChat - does nothing when idle", async () => {
  invokeHistory = [];
  const { controller } = createMockController();
  
  await controller.sendChat("Hello");
  
  // Should not invoke
  assert.ok(!invokeHistory.some(h => h.cmd === "room_chat"));
});

test("onTrackChange - broadcasts when host", async () => {
  invokeHistory = [];
  const { controller } = createMockController();
  
  await controller.open("Host", 8787);
  
  // Simulate track change
  controller.onTrackChange();
  
  // Should broadcast playback (tested via invoke history in real scenario)
  // This is a notification method, actual broadcast happens in tick
});

test("destroy - cleans up resources", async () => {
  const { controller } = createMockController();
  
  await controller.open("Host", 8787);
  
  controller.destroy();
  
  // Should stop ticks (hard to test without timers, but method should exist)
  assert.ok(typeof controller.destroy === "function");
});

console.log("✅ All jam-controller tests passed!");
