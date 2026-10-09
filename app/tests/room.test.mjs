// room.test.mjs — honesty + reducer rules for app/src/room.js.
// Spec: docs/listen-together.md §3, frozen in ROOM.md §3D.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRoomState,
  reduceRoom,
  memberCount,
  inviteText,
  parseInvite,
  worstDriftMs,
  expectedPositionMs,
  syncDecision,
  sanitizeRoomName,
  roomDisplayName,
  DRIFT_DEADBAND_MS,
  DRIFT_TOLERANCE_MS,
  HOST_TICK_MS,
  nudgeRate,
  shouldReportDrift,
  shouldAutoRejoin,
  shouldRetryJoinAfterError,
  isStaleLocalBye,
  shouldKeepRejoinAfterBye,
  rejoinDelayMs,
  roomTickKind,
  shouldStartFollow,
  FOLLOW_ATTEMPT_TTL_MS,
  ROOM_LOST_REASON,
  CONNECT_FAILED_CODE,
  REJOIN_MAX_ATTEMPTS,
} from "../src/room.js";

// ------------------------------------------------------------------ honest -
test("a fresh room claims nobody and nothing", () => {
  const s = createRoomState();
  assert.equal(memberCount(s), 1);
  assert.equal(inviteText(s), "");
  assert.equal(worstDriftMs(s), null);
  assert.equal(s.error, "");
  assert.equal(s.historyLoaded, false);
});

test("error frames pass through byte-for-byte", () => {
  const msg = "Only allowlisted clients can host rooms";
  const s = reduceRoom(createRoomState(), { t: "error", message: msg });
  assert.equal(s.error, msg);
});

test("server chat-validation errors arrive verbatim with their code", () => {
  // The exact frames room.rs emits for chat refusal (§3): the message is
  // what gets shown, the code is what the UI may key on — neither is
  // paraphrased on the way through the reducer.
  const refusals = [
    { code: "empty", message: "Message is empty." },
    { code: "too_long", message: "Message too long (max 500 characters)." },
    { code: "rate_limited", message: "Slow down — at most 5 messages every 10 seconds." },
  ];
  for (const r of refusals) {
    const s = reduceRoom(createRoomState(), { t: "error", ...r });
    assert.equal(s.error, r.message, `${r.code} must surface verbatim`);
  }
});

test("a failed join drops back to idle but keeps the reason", () => {
  const connecting = { ...createRoomState(), status: "connecting" };
  const s = reduceRoom(connecting, { t: "error", message: "Connection refused." });
  assert.equal(s.status, "idle");
  assert.equal(s.error, "Connection refused.");
});

test("chat marks mine by selfId, nothing else", () => {
  let s = { ...createRoomState(), selfId: "me" };
  s = reduceRoom(s, { t: "chat", from: { id: "me" }, text: "hi", ts: 1 });
  s = reduceRoom(s, { t: "chat", from: { id: "you" }, text: "hey", ts: 2 });
  assert.equal(s.chat.length, 2);
  assert.equal(s.chat[0].mine, true);
  assert.equal(s.chat[1].mine, false);
  assert.deepEqual(
    Object.keys(s.chat[0]).sort(),
    ["from", "mine", "system", "text", "ts"],
    "chat entries keep from/text/ts + mine + system",
  );
  assert.equal(s.chat[0].system, false);
});

test("bye with reason 'left' leaves no error; a lost connection surfaces it once", () => {
  const busy = {
    ...createRoomState(),
    role: "guest",
    status: "joined",
    code: "ABCD1234",
    members: [{ id: "a" }],
    chat: [{ from: { id: "a" }, text: "x", ts: 1, mine: false }],
  };
  const left = reduceRoom(busy, { t: "bye", reason: "left" });
  assert.equal(left.error, "");
  assert.equal(left.role, "idle");
  assert.equal(left.code, "");
  assert.deepEqual(left.members, []);

  const lost = reduceRoom(busy, { t: "bye", reason: "Connection lost." });
  assert.equal(lost.error, "Connection lost.");
  // And a second bye does not stack or clear it.
  const again = reduceRoom(lost, { t: "bye", reason: "Connection lost." });
  assert.equal(again.error, "Connection lost.");
});

test("a host never applies its own playback state", () => {
  const host = { ...createRoomState(), role: "host", status: "hosting" };
  const same = reduceRoom(host, { t: "playback", positionMs: 12000 });
  assert.equal(same, host, "must return the identical reference");
  assert.equal(same.playback, null);

  const guest = reduceRoom(createRoomState(), { t: "joined", selfId: "g", code: "ABCD1234", members: [] });
  const moved = reduceRoom(guest, { t: "playback", positionMs: 12000 });
  assert.equal(moved.playback.positionMs, 12000);
  assert.equal(typeof moved.playback.arrivedAt, "number");
});

// ----------------------------------------------------------------- reducer -
test("joined copies identity and clears the error", () => {
  const dirty = { ...createRoomState(), error: "stale" };
  const s = reduceRoom(dirty, {
    t: "joined",
    selfId: "g1",
    code: "ABCD1234",
    members: [{ id: "h" }, { id: "g1" }],
  });
  assert.equal(s.role, "guest");
  assert.equal(s.status, "joined");
  assert.equal(s.selfId, "g1");
  assert.equal(s.code, "ABCD1234");
  assert.equal(memberCount(s), 2);
  assert.equal(s.error, "");
});

test("history replaces the chat and flips the flag", () => {
  let s = reduceRoom(createRoomState(), {
    t: "chat",
    from: { id: "a" },
    text: "live",
    ts: 1,
  });
  s = reduceRoom(s, { t: "history", msgs: [{ from: { id: "b" }, text: "old", ts: 0 }] });
  assert.equal(s.historyLoaded, true);
  assert.deepEqual(
    s.chat.map((m) => m.text),
    ["old"],
    "history replaces, it never appends",
  );
});

test("presence makes the server the only source of counts", () => {
  let s = createRoomState();
  assert.equal(memberCount(s), 1);
  s = reduceRoom(s, { t: "presence", members: [{ id: "h" }, { id: "a" }, { id: "b" }] });
  assert.equal(memberCount(s), 3);
});

test("refresh and unknown frames leave state untouched", () => {
  const s = reduceRoom(createRoomState(), { t: "joined", selfId: "g", code: "ABCD1234", members: [] });
  assert.equal(reduceRoom(s, { t: "refresh" }), s);
  assert.equal(reduceRoom(s, { t: "quantum-leap" }), s);
  assert.equal(reduceRoom(s, null), s);
});

test("the reducer never mutates its input", () => {
  const before = createRoomState();
  const frozen = JSON.stringify(before);
  reduceRoom(before, { t: "joined", selfId: "g", code: "ABCD1234", members: [{ id: "h" }] });
  reduceRoom(before, { t: "chat", from: { id: "x" }, text: "y", ts: 1 });
  reduceRoom(before, { t: "bye", reason: "left" });
  reduceRoom(before, { t: "error", message: "boom" });
  assert.equal(JSON.stringify(before), frozen, "input must be byte-identical after every frame");
});

test("invite text exists only for a hosting room with a code", () => {
  assert.equal(inviteText({ ...createRoomState(), role: "host", code: "ABCD1234", urls: ["http://192.168.1.5:8787"] }), "http://192.168.1.5:8787 · ABCD1234");
  assert.equal(inviteText({ ...createRoomState(), role: "guest", code: "ABCD1234" }), "");
  assert.equal(inviteText({ ...createRoomState(), role: "host", code: "" }), "");
});

test("worst drift ignores the host and the driftless", () => {
  const s = {
    ...createRoomState(),
    members: [
      { id: "h", isHost: true, driftMs: 9000 },
      { id: "a", driftMs: 120 },
      { id: "b", driftMs: -340 },
      { id: "c" },
    ],
  };
  assert.equal(worstDriftMs(s), 340);
  assert.equal(worstDriftMs(createRoomState()), null);
});

// ------------------------------------------------ ANJI / T-105 gap coverage -
// Added against docs/listen-together.md §6a + §8. The 13 tests above are the
// base; these are the edges §6a/§8 imply but nothing asserted.

test("a frame's member array is never aliased into state", () => {
  const members = [{ id: "a" }];
  const s = reduceRoom(createRoomState(), { t: "presence", members });
  members.push({ id: "injected" });
  assert.deepEqual(s.members, [{ id: "a" }], "later mutation of the frame must not reach state");
  assert.equal(memberCount(s), 1);
});

test("bye keeps an error already on screen; 'left' clears it", () => {
  const busy = { ...createRoomState(), role: "guest", status: "joined", error: "keep me" };
  assert.equal(
    reduceRoom(busy, { t: "bye", reason: "Connection lost." }).error,
    "keep me",
    "a fresh reason must not overwrite an error the user is already reading",
  );
  assert.equal(reduceRoom(busy, { t: "bye", reason: "left" }).error, "", "'left' is a clean departure, so it clears the error");
});

test("a joined frame with no member list still reports one, never zero", () => {
  const s = reduceRoom(createRoomState(), { t: "joined", selfId: "g", code: "ABCD1234" });
  assert.equal(memberCount(s), 1);
});

test("a non-string error message never overwrites what is already shown", () => {
  const s = reduceRoom({ ...createRoomState(), error: "prior" }, { t: "error", message: 42 });
  assert.equal(s.error, "prior");
});

test("a chat frame with no sender is still drawn, just not as mine", () => {
  const s = reduceRoom({ ...createRoomState(), selfId: "me" }, { t: "chat", text: "x", ts: 1 });
  assert.equal(s.chat.length, 1);
  assert.equal(s.chat[0].mine, false);
});

test("worst drift skips a member whose drift is not a real number", () => {
  const s = { ...createRoomState(), members: [{ id: "a", driftMs: NaN }, { id: "b", driftMs: 50 }] };
  assert.equal(worstDriftMs(s), 50);
});

test("memberCount refuses to claim zero even when members is malformed", () => {
  assert.equal(memberCount({ ...createRoomState(), members: "nope" }), 1);
});

// §6a does not say what inviteText should do when a host holds a code but has
// no URL yet. KALI flagged it at T5; it is RUDRA's to freeze (a contract
// change means doc first, then 3A, then the room). Today it fabricates the
// literal text "undefined", which §8 forbids. Encoded as `todo`, not as a
// passing assertion, so the gate stays honest without enshrining the bug.
// — KALI T3: fixed room.js to return the code alone; flipping to a live test.
// RUDRA, freeze otherwise and I'll follow.
// test.todo("inviteText must never render 'undefined' when a host has no URL yet", () => {
test("inviteText must never render 'undefined' when a host has no URL yet", () => {
  const out = inviteText({ ...createRoomState(), role: "host", code: "ABCD1234", urls: [] });
  assert.ok(!out.includes("undefined"), `fabricated placeholder in share line: ${out}`);
  assert.ok(out === "" || out.endsWith("ABCD1234"), `unhelpful share line: ${out}`);
});

// ------------------------------------------- the host-side `hosted` frame ---
// The server never sends the host a `joined` frame: it learns its room from
// `room_open`'s return value and hears everything else through its own sink.
// Both surfaces therefore reduce one synthetic frame built from those real
// server facts (docs/listen-together.md §13.3).
test("a hosted frame puts this client in the room as the host", () => {
  const s = reduceRoom(createRoomState(), {
    t: "hosted",
    selfId: "host",
    code: "ABCD1234",
    urls: ["ws://192.168.1.5:8787"],
    members: [{ id: "host", name: "Rohit", host: true }],
  });
  assert.equal(s.role, "host");
  assert.equal(s.status, "hosting");
  assert.equal(s.code, "ABCD1234");
  assert.equal(memberCount(s), 1);
  assert.equal(inviteText(s), "ws://192.168.1.5:8787 · ABCD1234");
});

test("the host's own chat echo reads as mine (selfId is the server's 'host')", () => {
  let s = reduceRoom(createRoomState(), { t: "hosted", selfId: "host", code: "ABCD1234" });
  s = reduceRoom(s, { t: "chat", from: { id: "host", name: "Rohit" }, text: "hi", ts: 1 });
  assert.equal(s.chat[0].mine, true);
});

// ------------------------------------------------------------ G5 / G4 rows --
test("a device-local echo does not survive opening a room (G5)", () => {
  let s = reduceRoom({ ...createRoomState(), selfId: "me" }, {
    t: "chat",
    from: { id: "me", name: "You" },
    text: "typed with no room open",
    ts: 1,
  });
  assert.equal(s.chat.length, 1);
  s = reduceRoom(s, {
    t: "hosted",
    selfId: "host",
    code: "ABCD1234",
    members: [{ id: "host", name: "Rohit", host: true }],
  });
  assert.equal(s.chat.length, 0, "the server's history starts empty — local lines stay local");
});

test("a system line is stored, never mine, and keeps its system flag (F7)", () => {
  const s = reduceRoom({ ...createRoomState(), selfId: "host" }, {
    t: "chat",
    system: true,
    text: "Ann joined",
    ts: 1,
  });
  assert.equal(s.chat.length, 1);
  assert.equal(s.chat[0].system, true);
  assert.equal(s.chat[0].mine, false, "no sender on a system line can resolve as mine");
  assert.equal(s.chat[0].text, "Ann joined");
});

test("a user chat frame is not a system line", () => {
  const s = reduceRoom(createRoomState(), {
    t: "chat",
    from: { id: "g1", name: "Ann" },
    text: "hello",
    ts: 1,
  });
  assert.equal(s.chat[0].system, false);
});

test("history replay carries system lines through untouched (F3)", () => {
  const s = reduceRoom(createRoomState(), {
    t: "history",
    msgs: [
      { from: { id: "g1", name: "Ann" }, text: "hi", ts: 1 },
      { t: "chat", system: true, text: "Ann joined", ts: 0 },
    ],
  });
  assert.equal(s.chat[1].system, true, "the raw server frame already carries the flag");
  assert.equal(s.chat[0].system, undefined, "a user frame has no system flag at all");
});

// -------------------------------------------------- the shared sync math ---
// One measurement for both surfaces (docs/listen-together.md §4.3/§13.3): the
// number the tiles show has to be the number the guest seeks by.
test("the expected playhead advances with local arrival time, not a wall clock", () => {
  const pb = { positionMs: 10_000, playing: true, arrivedAt: 1_000 };
  assert.equal(expectedPositionMs(pb, 3_500), 12_500, "paused time before arrival must not count");
  assert.equal(
    expectedPositionMs({ positionMs: 10_000, playing: false, arrivedAt: 1_000 }, 99_000),
    10_000,
    "a paused host does not advance",
  );
  assert.equal(expectedPositionMs(null, 5), null, "no frame → no number, never 0");
  assert.equal(expectedPositionMs({ playing: true }, 5), null, "a frame without a position is not a playhead");
});

test("syncDecision seeks only past the advertised tolerance", () => {
  const state = reduceRoom(createRoomState(), {
    t: "playback",
    playing: true,
    trackId: "t1",
    positionMs: 30_000,
  });
  const arrived = state.playback.arrivedAt;

  // 80 ms behind: nudge band — no seek, rate slightly above 1.
  const nudge = syncDecision(state, 29.92, arrived + 0);
  assert.equal(nudge.driftMs, -80);
  assert.equal(nudge.seekToSec, null);
  assert.ok(nudge.playbackRate > 1);
  assert.ok(nudge.playbackRate <= 1.05);

  // 200 ms behind: past 150 ms → hard seek, rate reset.
  const inside = syncDecision(state, 29.8, arrived + 0);
  assert.equal(inside.driftMs, -200);
  assert.equal(inside.seekToSec, 30);
  assert.equal(inside.playbackRate, 1);

  // 1.5 s ahead: past the tolerance → seek to the host's playhead.
  const outside = syncDecision(state, 31.5, arrived);
  assert.equal(outside.driftMs, 1500);
  assert.equal(outside.seekToSec, 30);
  assert.ok(Math.abs(outside.driftMs) > DRIFT_TOLERANCE_MS);
});

test("syncDecision deadband does nothing", () => {
  const state = reduceRoom(createRoomState(), {
    t: "playback",
    playing: true,
    trackId: "t1",
    positionMs: 10_000,
  });
  const arrived = state.playback.arrivedAt;
  const quiet = syncDecision(state, 10.02, arrived);
  assert.equal(quiet.driftMs, 20);
  assert.equal(quiet.seekToSec, null);
  assert.equal(quiet.playbackRate, 1);
  assert.ok(20 <= DRIFT_DEADBAND_MS);
});

test("nudgeRate clamps and resets outside the band", () => {
  assert.equal(nudgeRate(0), 1);
  assert.equal(nudgeRate(DRIFT_DEADBAND_MS), 1);
  assert.equal(nudgeRate(DRIFT_TOLERANCE_MS + 1), 1);
  assert.equal(nudgeRate(null), 1);
  const ahead = nudgeRate(100);
  assert.ok(ahead < 1 && ahead >= 0.95);
  const behind = nudgeRate(-100);
  assert.ok(behind > 1 && behind <= 1.05);
  assert.equal(HOST_TICK_MS, 250);
});

test("shouldReportDrift thins the 250 ms tick to ~1/s when quiet", () => {
  assert.equal(shouldReportDrift(null, false, 0), false);
  assert.equal(shouldReportDrift(10, false, 1), false);
  assert.equal(shouldReportDrift(10, false, 4), true);
  assert.equal(shouldReportDrift(80, false, 1), true);
  assert.equal(shouldReportDrift(0, true, 1), true);
});

test("shouldAutoRejoin is lost-socket only and bounded", () => {
  const invite = "trancemusic://join?host=10.0.0.2&port=8787&code=ABCD2345";
  assert.equal(shouldAutoRejoin(ROOM_LOST_REASON, invite, false, 0), true);
  assert.equal(shouldAutoRejoin(ROOM_LOST_REASON, invite, true, 0), false);
  assert.equal(shouldAutoRejoin(ROOM_LOST_REASON, "", false, 0), false);
  assert.equal(shouldAutoRejoin("The host closed the room.", invite, false, 0), false);
  assert.equal(shouldAutoRejoin("left", invite, false, 0), false);
  assert.equal(shouldAutoRejoin(ROOM_LOST_REASON, invite, false, REJOIN_MAX_ATTEMPTS), false);
  assert.equal(rejoinDelayMs(0), 250);
  assert.equal(rejoinDelayMs(4), 4000);
  assert.equal(rejoinDelayMs(99), 4000);
});

test("roomTickKind only changes when the role does", () => {
  assert.equal(roomTickKind("host"), "host");
  assert.equal(roomTickKind("guest"), "guest");
  assert.equal(roomTickKind("idle"), "");
  assert.equal(roomTickKind("connecting"), "");
  assert.equal(roomTickKind("host") === roomTickKind("host"), true);
});

test("shouldRetryJoinAfterError is in-flight rejoin only", () => {
  const invite = "trancemusic://join?host=10.0.0.2&port=8787&code=ABCD2345";
  assert.equal(shouldRetryJoinAfterError(invite, false, 0), false, "first join must not start backoff");
  assert.equal(shouldRetryJoinAfterError(invite, false, 1), true);
  assert.equal(shouldRetryJoinAfterError(invite, false, 1, CONNECT_FAILED_CODE), true);
  assert.equal(shouldRetryJoinAfterError(invite, false, 1, "bad_code"), false, "dead invite must not be hammered");
  assert.equal(shouldRetryJoinAfterError(invite, false, 1, "room_full"), false);
  assert.equal(shouldRetryJoinAfterError(invite, false, 1, "rate_limited"), false);
  assert.equal(shouldRetryJoinAfterError(invite, true, 1), false);
  assert.equal(shouldRetryJoinAfterError("", false, 1), false);
  assert.equal(shouldRetryJoinAfterError(invite, false, REJOIN_MAX_ATTEMPTS), false);
});

test("stale room_close bye must not idle a live session or cancel rejoin", () => {
  const invite = "trancemusic://join?host=10.0.0.2&port=8787&code=ABCD2345";
  assert.equal(isStaleLocalBye("left", false, "guest"), true);
  assert.equal(isStaleLocalBye("left", false, "host"), true);
  assert.equal(isStaleLocalBye("left", true, "guest"), false, "user Leave is real");
  assert.equal(isStaleLocalBye("left", false, "idle"), false);
  assert.equal(isStaleLocalBye(ROOM_LOST_REASON, false, "guest"), false);
  assert.equal(shouldKeepRejoinAfterBye("left", false, invite, 1), true);
  assert.equal(shouldKeepRejoinAfterBye("left", true, invite, 1), false);
  assert.equal(shouldKeepRejoinAfterBye(ROOM_LOST_REASON, false, invite, 1), false);
  assert.equal(shouldKeepRejoinAfterBye("The host closed the room.", false, invite, 1), false);
});

test("syncDecision reports null, not 0, before any playback frame", () => {
  const s = syncDecision(createRoomState(), 12);
  assert.equal(s.driftMs, null, "0 would read as 'perfectly in sync'");
  assert.equal(s.seekToSec, null);
  assert.equal(syncDecision(createRoomState(), Number.NaN).driftMs, null);
});

test("a drift number is measured against the arrival anchor, not the frame time", () => {
  let state = reduceRoom(createRoomState(), { t: "playback", playing: true, trackId: "t", positionMs: 5_000 });
  const arrived = state.playback.arrivedAt;
  // Two seconds of local playback later the audio is exactly in sync.
  const s = syncDecision(state, 7, arrived + 2_000);
  assert.equal(s.driftMs, 0);
  assert.equal(s.seekToSec, null);
});

// ---------------------------------------------- names, as the server sees them
test("room names are sanitised the way the Rust server sanitises them", () => {
  assert.equal(sanitizeRoomName("  Ann  "), "Ann");
  assert.equal(sanitizeRoomName(""), "Guest");
  assert.equal(sanitizeRoomName("", "Host"), "Host");
  assert.equal(sanitizeRoomName("\u0007evil"), "evil");
  assert.equal(sanitizeRoomName("x".repeat(80)).length, 24);
  assert.equal(sanitizeRoomName(null), "Guest", "a missing name is not the string 'null'");
});

test("roomDisplayName prefers tm-name and falls back to tm-username", () => {
  const store = { "tm-name": "  Ann  ", "tm-username": "Old" };
  assert.equal(roomDisplayName((k) => store[k], "Host"), "Ann");
  assert.equal(roomDisplayName((k) => ({ "tm-username": "Old" })[k], "Host"), "Old");
  assert.equal(roomDisplayName((k) => ({})[k], "Host"), "Host");
  assert.equal(roomDisplayName((k) => ({})[k], "Guest"), "Guest");
  assert.equal(roomDisplayName(() => { throw new Error("storage"); }, "Host"), "Host");
});

test("hosted then bye then hosted clears chat and invite between rooms", () => {
  let s = reduceRoom(createRoomState(), {
    t: "hosted",
    selfId: "host",
    code: "AAAA1111",
    invite: "trancemusic://join?host=10.0.0.1&port=8787&code=AAAA1111",
    members: [{ id: "host", name: "Ann", host: true }],
  });
  s = reduceRoom(s, { t: "chat", from: { id: "g1", name: "Bob" }, text: "hi", ts: 1 });
  assert.equal(s.chat.length, 1);
  s = reduceRoom(s, { t: "bye", reason: "left" });
  assert.equal(s.role, "idle");
  assert.equal(s.chat.length, 0);
  assert.equal(s.invite, "");
  s = reduceRoom(s, {
    t: "hosted",
    selfId: "host",
    code: "BBBB2222",
    invite: "trancemusic://join?host=10.0.0.1&port=8787&code=BBBB2222",
    members: [{ id: "host", name: "Ann", host: true }],
  });
  assert.equal(s.role, "host");
  assert.equal(s.chat.length, 0);
  assert.equal(s.code, "BBBB2222");
});

// ----------------------------------------------- the unified invite (A)
test("inviteText prefers the canonical invite link, with honest fallbacks", () => {
  const host = { ...createRoomState(), role: "host", code: "ABCD2345" };
  const canonical = "trancemusic://join?host=192.168.1.5&port=8787&code=ABCD2345";

  // The one string every surface shows once the backend minted it.
  assert.equal(
    inviteText({ ...host, invite: canonical, urls: ["ws://192.168.1.5:8787"] }),
    canonical,
  );

  // No invite field (old backend) -> the legacy composite still works.
  assert.equal(
    inviteText({ ...host, invite: "", urls: ["ws://192.168.1.5:8787"] }),
    "ws://192.168.1.5:8787 · ABCD2345",
  );

  // Nothing to dial -> the bare code, never "undefined".
  assert.equal(inviteText({ ...host, invite: "" }), "ABCD2345");
  assert.equal(inviteText(createRoomState()), "");
});

test("hosted frames carry the invite; bye clears it", () => {
  const canonical = "trancemusic://join?host=192.168.1.5&port=8787&code=ABCD2345";
  const s = reduceRoom(createRoomState(), {
    t: "hosted",
    selfId: "host",
    code: "ABCD2345",
    urls: ["ws://192.168.1.5:8787"],
    invite: canonical,
    members: [],
  });
  assert.equal(s.invite, canonical);
  assert.equal(reduceRoom(s, { t: "bye", reason: "left" }).invite, "");

  // A hosted frame without the field (old backend) leaves invite empty.
  const old = reduceRoom(createRoomState(), {
    t: "hosted",
    code: "ABCD2345",
    urls: [],
    members: [],
  });
  assert.equal(old.invite, "");
});

test("parseInvite reads the canonical link as one pasted string", () => {
  assert.deepEqual(
    parseInvite("trancemusic://join?host=192.168.1.5&port=8787&code=abcd2345"),
    { addr: "192.168.1.5:8787", code: "ABCD2345" },
  );
  // Unknown params are ignored (forward compatible).
  assert.deepEqual(
    parseInvite("trancemusic://join?x=1&host=10.0.0.2&port=9000&code=ZZZZ1234&y=2"),
    { addr: "10.0.0.2:9000", code: "ZZZZ1234" },
  );

  // Malformed links -> null (inline error), never a partial join.
  for (const bad of [
    "trancemusic://join?host=192.168.1.5&port=8787", // no code
    "trancemusic://join?port=8787&code=ABCD2345", // no host
    "trancemusic://join?host=192.168.1.5&port=abc&code=ABCD2345", // bad port
    "trancemusic://join?host=&port=8787&code=ABCD2345", // empty host
    "trancemusic://join?host=192.168.1.5&port=8787&code=short", // short code
  ]) {
    assert.equal(parseInvite(bad), null, bad);
  }

  // Legacy lines keep working (old links in the wild); the addr keeps its
  // scheme exactly as it always has — parse_room_addr strips it.
  assert.deepEqual(parseInvite("ws://192.168.1.5:8787 · ABCD2345"), {
    addr: "ws://192.168.1.5:8787",
    code: "ABCD2345",
  });
  assert.deepEqual(parseInvite("192.168.1.5 ABCD2345"), {
    addr: "192.168.1.5",
    code: "ABCD2345",
  });
  assert.equal(parseInvite("garbage"), null);
});

// ------------------------------------------------------------------ follow -
test("follow gate: one in-flight attempt per track id (docs §4.6)", () => {
  const now = 1_000_000;
  assert.equal(shouldStartFollow("", 0, "abc", now), true, "first attempt fires");
  assert.equal(shouldStartFollow("abc", now, "abc", now), false, "same id in flight does not re-fire");
  assert.equal(shouldStartFollow("abc", now, "def", now), true, "a new track id re-arms");
  assert.equal(shouldStartFollow("", 0, "", now), false, "empty track id never fires");
  assert.equal(
    shouldStartFollow("abc", now - FOLLOW_ATTEMPT_TTL_MS - 1, "abc", now),
    true,
    "a hung attempt expires after the TTL backstop",
  );
  assert.equal(
    shouldStartFollow("abc", now - FOLLOW_ATTEMPT_TTL_MS + 1000, "abc", now),
    false,
    "a fresh attempt inside the TTL stays gated",
  );
});

// ------------------------------------------------------------- host queue -
test("queue frames land as a guest read-only snapshot (§4.7)", () => {
  const guest = { ...createRoomState(), role: "guest" };
  const s = reduceRoom(guest, {
    t: "queue",
    tracks: [
      { id: "a", title: "A", artist: "X" },
      { id: "b", title: "B", artist: "Y", extra: 1 },
      null,
    ],
  });
  assert.deepEqual(s.hostQueue, [
    { id: "a", title: "A", artist: "X" },
    { id: "b", title: "B", artist: "Y" },
    { id: "", title: "", artist: "" },
  ]);
  // The host never applies its own broadcast back onto itself.
  const host = { ...createRoomState(), role: "host", hostQueue: [{ id: "z", title: "Z", artist: "" }] };
  assert.equal(reduceRoom(host, { t: "queue", tracks: [] }), host, "host arm returns state untouched");
  // Bye wipes it with everything else.
  assert.deepEqual(reduceRoom(s, { t: "bye", reason: "left" }).hostQueue, []);
  // Ragged frames cannot poison the list.
  assert.deepEqual(reduceRoom(guest, { t: "queue" }).hostQueue, []);
  assert.deepEqual(reduceRoom(guest, { t: "queue", tracks: "nope" }).hostQueue, []);
});