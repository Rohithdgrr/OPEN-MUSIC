// metroproto.js — wire-format contract against the published listentogether
// .proto (github.com/metrolistgroup/metroproto @ e7c5e3d).
// Every "golden" byte string below is derived by hand from the proto3 wire
// format: key = field_number * 8 + wire_type, little-endian 7-bit varints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  decodeEnvelope,
  decodeError,
  decodeRoomCreated,
  decodeRoomUsers,
  decodeServerCapabilities,
  decodeUserInfo,
  encodeClientCapabilities,
  encodeCreateRoom,
  encodeEnvelope,
  encodeLeaveRoom,
  encodePing,
  decompressPayload,
} from "../src/metroproto.js";

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const eq = (actual, expected, what) =>
  assert.deepEqual([...actual], [...expected], `${what} bytes`);

test("CreateRoomPayload { username = 1 } encodes as 0x0A + len + utf8", () => {
  // field 1, wire 2 -> key 1*8+2 = 10 = 0x0A
  eq(encodeCreateRoom("You"), [0x0a, 0x03, 0x59, 0x6f, 0x75], "create_room");
});

test("ClientCapabilities advertises protobuf, never compression", () => {
  // supports_protobuf=true: field 1 wire 0 -> key 8 = 0x08, value 1
  // supports_compression=false is a proto3 default and is omitted
  // client_version: field 3 wire 2 -> key 26 = 0x1A, "openmusic/0.4.0" is 15 bytes
  const bytes = encodeClientCapabilities("openmusic/0.4.0");
  eq(bytes.subarray(0, 2), [0x08, 0x01], "supports_protobuf");
  assert.equal(bytes[2], 0x1a, "client_version key");
  assert.equal(bytes[3], 15, "version length");
  assert.equal(new TextDecoder().decode(bytes.subarray(4)), "openmusic/0.4.0");
  assert.ok(!bytes.includes(0x10), "compression must not be requested");
});

test("Envelope { type=1, payload=2, compressed=3 } round trip", () => {
  const payload = Uint8Array.from([0xab, 0xcd]);
  const bytes = encodeEnvelope("ping", payload);
  eq(bytes, [0x0a, 0x04, 0x70, 0x69, 0x6e, 0x67, 0x12, 0x02, 0xab, 0xcd], "envelope");
  const back = decodeEnvelope(bytes);
  assert.equal(back.type, "ping");
  eq(back.payload, payload, "payload");
  assert.equal(back.compressed, false, "we never set compressed");
});

test("decodeEnvelope reads type, payload and the compressed flag", () => {
  // 0x0A field1/len "hello" · 0x12 field2/len [AB CD] · 0x18 field3 varint 1
  const bytes = Uint8Array.from([
    0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x12, 0x02, 0xab, 0xcd, 0x18, 0x01,
  ]);
  const env = decodeEnvelope(bytes);
  assert.equal(env.type, "hello");
  eq(env.payload, Uint8Array.from([0xab, 0xcd]), "payload");
  assert.equal(env.compressed, true);
});

test("varints are little-endian 7-bit groups (300 = 0xAC 0x02)", () => {
  // 300 = 2*128 + 44 -> low group 44|0x80 = 0xAC, then 0x02
  eq(encodePing(300, 2), [0x08, 0xac, 0x02, 0x10, 0x02], "ping");
});

test("field order does not matter to the decoder", () => {
  // same ErrorPayload, fields emitted in reverse order
  const forwards = Uint8Array.from([0x0a, 0x01, 0x78, 0x12, 0x02, 0x6f, 0x6b]);
  const backwards = Uint8Array.from([0x12, 0x02, 0x6f, 0x6b, 0x0a, 0x01, 0x78]);
  assert.deepEqual(decodeError(forwards), decodeError(backwards));
  assert.deepEqual(decodeError(forwards), { code: "x", message: "ok" });
});

test("ServerCapabilities decodes a hand-built frame", () => {
  // supports_protobuf=1 (0x08 0x01), supports_compression=1 (0x10 0x01),
  // server_version="1" (0x1A 0x01 0x31)
  const caps = decodeServerCapabilities(Uint8Array.from([0x08, 0x01, 0x10, 0x01, 0x1a, 0x01, 0x31]));
  assert.deepEqual(caps, { supportsProtobuf: true, supportsCompression: true, serverVersion: "1" });
});

test("RoomCreatedPayload yields the three strings the app is allowed to show", () => {
  const room = ascii("ABCD1234");
  const user = ascii("u1");
  const token = ascii("tok");
  const payload = new Uint8Array([
    0x0a, 8, ...room,
    0x12, 2, ...user,
    0x1a, 3, ...token,
  ]);
  const back = decodeRoomCreated(payload);
  assert.equal(back.roomCode, "ABCD1234");
  assert.equal(back.userId, "u1");
  assert.equal(back.sessionToken, "tok");
});

test("an empty payload is legal (LeaveRoomPayload has no fields)", () => {
  assert.equal(encodeLeaveRoom().length, 0);
  const env = decodeEnvelope(encodeEnvelope("leave_room", encodeLeaveRoom()));
  assert.equal(env.type, "leave_room");
  assert.equal(env.payload.length, 0);
});

test("full round trip: envelope -> payload -> message", () => {
  const real = decodeEnvelope(
    encodeEnvelope("room_created", Uint8Array.from([0x0a, 0x04, 0x41, 0x42, 0x43, 0x44])),
  );
  assert.equal(real.type, "room_created");
  assert.equal(decodeRoomCreated(real.payload).roomCode, "ABCD");
});

test("RoomState.users decodes to UserInfo entries", () => {
  const user = ascii("host-1");
  const name = ascii("Rohit");
  // field 3 (users), wire 2, containing UserInfo { user_id=1, username=2, is_host=3 }
  const info = Uint8Array.from([
    0x0a, user.length, ...user,
    0x12, name.length, ...name,
    0x18, 0x01, // is_host = true
  ]);
  const state = Uint8Array.from([0x1a, info.length, ...info]);
  const users = decodeRoomUsers(state);
  assert.equal(users.length, 1);
  assert.equal(users[0].userId, "host-1");
  assert.equal(users[0].username, "Rohit");
  assert.equal(users[0].isHost, true);
  assert.equal(users[0].isConnected, false);
  assert.equal(typeof decodeUserInfo(state).userId, "string");
});

test("truncated input fails loudly instead of half-decoding", () => {
  assert.throws(() => decodeEnvelope(Uint8Array.from([0x0a, 0x05, 0x61])), /truncated/);
  assert.throws(() => decodeEnvelope(Uint8Array.from([0x12, 0x04, 0x61])), /truncated/);
});

test("gzip payloads are only readable through decompressPayload", async () => {
  const raw = ascii("hello room");
  const out = await decompressPayload(gzipSync(raw));
  eq(out, raw, "decompressed");
});
