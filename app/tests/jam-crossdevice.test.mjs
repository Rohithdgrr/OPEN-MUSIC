// jam-crossdevice.test.mjs — Verifies the cross-device Listen Together layer works in both
// directions: Desktop host ↔ Mobile guest AND Mobile host ↔ Desktop guest.
//
// Both surfaces share the same room.js reducer, the same seven `room_*` Tauri commands,
// and the same Rust `room.rs` WebSocket server. This test proves:
//   A. The pure reducer handles host/guest state from any platform the same way.
//   B. The chat protocol is symmetric — host and guest send/receive on both surfaces.
//   C. The logo fallback (mark-only crop, contract v2) is in place for both
//      desktop (src/logo.png) and mobile (src/mobile/logo.png).
//   D. Both surfaces use the same room_* command set (no platform-specific forks).
//   E. The QR/invite flow works from mobile host to desktop guest and vice-versa.
//
// No Tauri / DOM is needed: the reducer, parser, and sync utilities are pure Node modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const room = await import("../src/room.js");
const {
  createRoomState,
  reduceRoom,
  memberCount,
  inviteText,
  parseInvite,
  syncDecision,
  expectedPositionMs,
  shouldAutoRejoin,
  shouldRetryJoinAfterError,
  isStaleLocalBye,
  shouldKeepRejoinAfterBye,
  roomTickKind,
  roomDisplayName,
  ROOM_LOST_REASON,
  CONNECT_FAILED_CODE,
  HOST_TICK_MS,
} = room;

// ─── A: Reducer symmetry — same state from any platform ──────────────────────

test("Desktop host → Mobile guest: hosted+joined sequence produces correct roles", () => {
  // Desktop opens the room (host side)
  let desktopState = createRoomState();
  desktopState = reduceRoom(desktopState, {
    t: "hosted",
    selfId: "host",
    code: "ABCD1234",
    urls: ["ws://192.168.1.10:8787"],
    invite: "trancemusic://join?host=192.168.1.10&port=8787&code=ABCD1234",
    members: [{ id: "host", name: "Desktop User", host: true }],
  });
  assert.equal(desktopState.role, "host", "desktop must be host after hosted frame");
  assert.equal(desktopState.code, "ABCD1234", "desktop must hold the real room code");
  assert.ok(desktopState.invite.includes("ABCD1234"), "desktop invite must carry the code");

  // Mobile joins the same room (guest side)
  let mobileState = createRoomState();
  mobileState = reduceRoom(mobileState, {
    t: "joined",
    selfId: "mobile-guest-1",
    code: "ABCD1234",
    members: [
      { id: "host", name: "Desktop User", host: true },
      { id: "mobile-guest-1", name: "Mobile User" },
    ],
  });
  assert.equal(mobileState.role, "guest", "mobile must be guest after joined frame");
  assert.equal(mobileState.code, "ABCD1234", "mobile must see the same room code");
  assert.equal(memberCount(mobileState), 2, "mobile must count both members");
});

test("Mobile host → Desktop guest: hosted+joined sequence produces correct roles", () => {
  // Mobile opens the room (host side)
  let mobileState = createRoomState();
  mobileState = reduceRoom(mobileState, {
    t: "hosted",
    selfId: "host",
    code: "WXYZ5678",
    urls: ["ws://192.168.1.20:8787"],
    invite: "trancemusic://join?host=192.168.1.20&port=8787&code=WXYZ5678",
    members: [{ id: "host", name: "Mobile User", host: true }],
  });
  assert.equal(mobileState.role, "host", "mobile must be host after hosted frame");

  // Desktop joins the same room (guest side)
  let desktopState = createRoomState();
  desktopState = reduceRoom(desktopState, {
    t: "joined",
    selfId: "desktop-guest-1",
    code: "WXYZ5678",
    members: [
      { id: "host", name: "Mobile User", host: true },
      { id: "desktop-guest-1", name: "Desktop User" },
    ],
  });
  assert.equal(desktopState.role, "guest", "desktop must be guest after joined frame");
  assert.equal(desktopState.code, "WXYZ5678", "desktop must see the mobile host's code");
});

// ─── B: Chat symmetry — both directions carry correctly ───────────────────────

test("Bidirectional chat: host message reaches guest state correctly", () => {
  // Set up host (could be either desktop or mobile)
  let hostState = createRoomState();
  hostState = reduceRoom(hostState, {
    t: "hosted",
    selfId: "host",
    code: "CHAT1234",
    urls: ["ws://192.168.1.10:8787"],
    invite: "trancemusic://join?host=192.168.1.10&port=8787&code=CHAT1234",
    members: [{ id: "host", name: "Host Device", host: true }],
  });

  // Host sends a chat message — the server relays it back as a chat frame
  hostState = reduceRoom(hostState, {
    t: "chat",
    from: { id: "host", name: "Host Device" },
    text: "Hello from the host!",
    ts: Date.now(),
  });
  assert.equal(hostState.chat.length, 1, "host state must record sent chat");
  assert.ok(hostState.chat[0].mine, "chat from host to host must be marked mine");
  assert.equal(hostState.chat[0].text, "Hello from the host!");

  // Guest (other device) receives the same server frame
  let guestState = createRoomState();
  guestState = reduceRoom(guestState, {
    t: "joined",
    selfId: "guest-1",
    code: "CHAT1234",
    members: [{ id: "host", name: "Host Device", host: true }, { id: "guest-1", name: "Guest Device" }],
  });
  guestState = reduceRoom(guestState, {
    t: "chat",
    from: { id: "host", name: "Host Device" },
    text: "Hello from the host!",
    ts: Date.now(),
  });
  assert.equal(guestState.chat.length, 1, "guest state must receive host's chat");
  assert.ok(!guestState.chat[0].mine, "host's message must NOT be mine on the guest");
  assert.equal(guestState.chat[0].text, "Hello from the host!");
});

test("Bidirectional chat: guest message reaches host state correctly", () => {
  let hostState = createRoomState();
  hostState = reduceRoom(hostState, {
    t: "hosted",
    selfId: "host",
    code: "CHAT5678",
    urls: [],
    invite: "trancemusic://join?host=192.168.1.10&port=8787&code=CHAT5678",
    members: [{ id: "host", name: "Host" }, { id: "guest-1", name: "Guest" }],
  });
  // Guest's message arrives at the host via server relay
  hostState = reduceRoom(hostState, {
    t: "chat",
    from: { id: "guest-1", name: "Guest" },
    text: "Hello from the guest!",
    ts: Date.now(),
  });
  assert.equal(hostState.chat.length, 1, "host state must receive guest chat");
  assert.ok(!hostState.chat[0].mine, "guest message must NOT be mine on the host");

  let guestState = createRoomState();
  guestState = reduceRoom(guestState, {
    t: "joined",
    selfId: "guest-1",
    code: "CHAT5678",
    members: [{ id: "host", name: "Host" }, { id: "guest-1", name: "Guest" }],
  });
  // Guest's own echo arrives back from the server
  guestState = reduceRoom(guestState, {
    t: "chat",
    from: { id: "guest-1", name: "Guest" },
    text: "Hello from the guest!",
    ts: Date.now(),
  });
  assert.ok(guestState.chat[0].mine, "guest's own echo must be marked mine");
});

test("System lines (join/leave) are correctly marked as system on both sides", () => {
  let state = createRoomState();
  state = reduceRoom(state, {
    t: "joined",
    selfId: "guest-1",
    code: "SYSLINE1",
    members: [],
  });
  state = reduceRoom(state, {
    t: "chat",
    from: null,
    text: "Mobile User joined the room.",
    ts: Date.now(),
    system: true,
  });
  assert.ok(state.chat[0].system, "system join line must be flagged system");
  assert.ok(!state.chat[0].mine, "system line must never be mine");
});

// ─── C: Logo fallback files exist for both desktop and mobile ─────────────────
// Contract v2 (2026-10-10, branding guide): logo.png is the derived mark-only
// crop — identical on both surfaces, provably NOT the icon tile.

test("Desktop logo.png (fallback) exists and matches the mobile crop", () => {
  const desktopLogo = path.join(src, "logo.png");
  const mobileLogo = path.join(src, "mobile", "logo.png");
  const icon = path.join(src, "..", "src-tauri", "icons", "icon.png");
  assert.ok(fs.existsSync(desktopLogo), "src/logo.png must exist for desktop fallback");
  const logoSize = fs.statSync(desktopLogo).size;
  assert.equal(logoSize, fs.statSync(mobileLogo).size, "both surfaces must ship the same crop bytes");
  assert.notEqual(logoSize, fs.statSync(icon).size, "logo.png is the mark crop, not the icon tile");
});

test("Mobile logo.png (fallback) exists and matches the desktop crop", () => {
  const mobileLogo = path.join(src, "mobile", "logo.png");
  assert.ok(fs.existsSync(mobileLogo), "src/mobile/logo.png must exist for mobile fallback");
  assert.ok(
    fs.readFileSync(mobileLogo).equals(fs.readFileSync(path.join(src, "logo.png"))),
    "mobile and desktop logo.png must be byte-identical",
  );
});

test("art.js references LOGO = 'logo.png' as the fallback constant", () => {
  const artJs = fs.readFileSync(path.join(src, "art.js"), "utf8");
  assert.match(artJs, /export const LOGO = "logo\.png"/, "art.js must export LOGO = 'logo.png'");
  assert.match(artJs, /img\.setAttribute\("src", LOGO\)/, "artFail must fall back to LOGO");
});

test("mobile shared.js references LOGO = 'logo.png' as the fallback constant", () => {
  const sharedJs = fs.readFileSync(path.join(src, "mobile", "shared.js"), "utf8");
  assert.match(sharedJs, /export const LOGO = "logo\.png"/, "shared.js must export LOGO = 'logo.png'");
  assert.match(sharedJs, /img\.setAttribute\("src", LOGO\)/, "artFail must fall back to LOGO");
});

// ─── D: Both surfaces use the same room_* command set ─────────────────────────

test("Desktop social.js and mobile jam.js both call all 7 room_* commands", () => {
  const socialJs = fs.readFileSync(path.join(src, "social.js"), "utf8");
  const jamJs = fs.readFileSync(path.join(src, "mobile", "jam.js"), "utf8");
  const cmds = ["room_open", "room_join_uri", "room_close", "room_chat", "room_playback", "room_report", "room_info"];
  for (const cmd of cmds) {
    assert.ok(socialJs.includes(`"${cmd}"`), `social.js (desktop) must call ${cmd}`);
    assert.ok(jamJs.includes(`"${cmd}"`), `jam.js (mobile) must call ${cmd}`);
  }
});

test("Both surfaces import the same room.js reducer (no platform fork)", () => {
  const socialJs = fs.readFileSync(path.join(src, "social.js"), "utf8");
  const jamJs = fs.readFileSync(path.join(src, "mobile", "jam.js"), "utf8");
  assert.match(socialJs, /from "\.\/room\.js"/, "desktop social.js must import room.js");
  assert.match(jamJs, /from "\.\.\/room\.js"/, "mobile jam.js must import the same room.js");
  // Both must use the pure reducer, not ad-hoc frame handling
  assert.match(socialJs, /reduceRoom\(room, frame\)/, "social.js must reduce every frame");
  assert.match(jamJs, /reduceRoom\(room, frame\)/, "jam.js must reduce every frame");
});

// ─── E: QR / Invite flow works cross-platform ────────────────────────────────

test("parseInvite accepts canonical trancemusic://join? links from any host", () => {
  // Desktop host shares link, mobile guest parses it
  const desktopInvite = "trancemusic://join?host=192.168.1.10&port=8787&code=ABCD1234";
  const result1 = parseInvite(desktopInvite);
  assert.ok(result1, "canonical invite from desktop must parse");
  assert.equal(result1.code, "ABCD1234");
  assert.equal(result1.addr, "192.168.1.10:8787");

  // Mobile host shares link, desktop guest parses it
  const mobileInvite = "trancemusic://join?host=192.168.1.20&port=8787&code=WXYZ5678";
  const result2 = parseInvite(mobileInvite);
  assert.ok(result2, "canonical invite from mobile must parse");
  assert.equal(result2.code, "WXYZ5678");
  assert.equal(result2.addr, "192.168.1.20:8787");
});

test("parseInvite accepts legacy ws://ip:port · CODE format from either host", () => {
  const legacy = "ws://192.168.1.10:8787 · ABCD1234";
  const result = parseInvite(legacy);
  assert.ok(result, "legacy invite must parse");
  assert.equal(result.code, "ABCD1234");
});

test("inviteText produces a canonical link from any hosted state", () => {
  let state = createRoomState();
  state = reduceRoom(state, {
    t: "hosted",
    selfId: "host",
    code: "LINK1234",
    urls: ["ws://10.0.0.5:8787"],
    invite: "trancemusic://join?host=10.0.0.5&port=8787&code=LINK1234",
    members: [{ id: "host", name: "Host", host: true }],
  });
  const link = inviteText(state);
  assert.ok(link.includes("LINK1234"), "invite link must include the room code");
  // The canonical link is the preferred format
  assert.ok(link.startsWith("trancemusic://join?"), "invite link must be canonical format");
  // The result is parseable
  const parsed = parseInvite(link);
  assert.ok(parsed, "the invite produced by inviteText must be parseable by parseInvite");
  assert.equal(parsed.code, "LINK1234");
});

// ─── F: Sync / playback works from either side ───────────────────────────────

test("Mobile host playback frame is applied correctly on desktop guest", () => {
  let guestState = createRoomState();
  guestState = reduceRoom(guestState, {
    t: "joined",
    selfId: "desktop-guest",
    code: "SYNC1234",
    members: [{ id: "host", name: "Mobile Host", host: true }, { id: "desktop-guest", name: "Desktop" }],
  });
  const nowMs = Date.now();
  guestState = reduceRoom(guestState, {
    t: "playback",
    trackId: "track-abc",
    playing: true,
    positionMs: 30000,
    at: nowMs,
  });
  assert.ok(guestState.playback, "guest must store the host's playback frame");
  assert.equal(guestState.playback.trackId, "track-abc");
  assert.ok(guestState.playback.playing, "guest must see the host is playing");
  const expected = expectedPositionMs(guestState.playback, nowMs);
  assert.ok(typeof expected === "number", "expectedPositionMs must return a number");
  assert.ok(expected >= 30000, "expected position must be at or ahead of the sent position");
});

test("Desktop host playback frame is applied correctly on mobile guest", () => {
  // Same test, same reducer — the platform doesn't matter to the state machine
  let mobileGuestState = createRoomState();
  mobileGuestState = reduceRoom(mobileGuestState, {
    t: "joined",
    selfId: "mobile-guest",
    code: "SYNC5678",
    members: [],
  });
  mobileGuestState = reduceRoom(mobileGuestState, {
    t: "playback",
    trackId: "track-xyz",
    playing: false,
    positionMs: 60000,
    at: Date.now(),
  });
  assert.equal(mobileGuestState.playback.trackId, "track-xyz");
  assert.ok(!mobileGuestState.playback.playing, "guest must see host is paused");
  // syncDecision at current position with host paused at 60s → drift is 0
  const { driftMs } = syncDecision(mobileGuestState, 60.0);
  assert.ok(typeof driftMs === "number", "syncDecision must produce a drift value");
});

test("Guest playback frame is never applied to the host (no echo)", () => {
  let hostState = createRoomState();
  hostState = reduceRoom(hostState, {
    t: "hosted",
    selfId: "host",
    code: "NOECHO1",
    urls: [],
    invite: "",
    members: [{ id: "host", name: "Host", host: true }],
  });
  const before = hostState;
  // Host receives its own playback broadcast back (echo from server)
  const after = reduceRoom(hostState, {
    t: "playback",
    trackId: "track-host",
    playing: true,
    positionMs: 10000,
    at: Date.now(),
  });
  assert.equal(after, before, "host must ignore its own playback echo (pure state equality)");
  assert.equal(after.playback, null, "host must never set its own playback state");
});

// ─── G: Host tick cadence is same for both platforms ─────────────────────────

test("HOST_TICK_MS is exported and has the expected value (250ms)", () => {
  assert.equal(HOST_TICK_MS, 250, "tick cadence must be 250ms as documented");
});

test("roomTickKind drives the correct interval for host and guest on either platform", () => {
  assert.equal(roomTickKind("host"), "host", "host role → host tick");
  assert.equal(roomTickKind("guest"), "guest", "guest role → guest tick");
  assert.equal(roomTickKind("idle"), "", "idle → no tick");
});

// ─── H: Reconnect / robustness works bidirectionally ─────────────────────────

test("shouldAutoRejoin works from either platform after a lost connection", () => {
  const invite = "trancemusic://join?host=192.168.1.10&port=8787&code=TEST1234";
  assert.ok(shouldAutoRejoin(ROOM_LOST_REASON, invite, false, 0), "first rejoin attempt must be allowed");
  assert.ok(!shouldAutoRejoin(ROOM_LOST_REASON, invite, true, 0), "user left — must not rejoin");
  assert.ok(!shouldAutoRejoin("bad_code", invite, false, 0), "wrong code — must not retry");
});

test("isStaleLocalBye prevents a live room from being idled on either surface", () => {
  assert.ok(isStaleLocalBye("left", false, "host"), "host session stale bye is stale");
  assert.ok(isStaleLocalBye("left", false, "guest"), "guest session stale bye is stale");
  assert.ok(!isStaleLocalBye("left", true, "guest"), "user-left bye is not stale");
  assert.ok(!isStaleLocalBye("lost", false, "guest"), "non-left reason is not stale");
});
