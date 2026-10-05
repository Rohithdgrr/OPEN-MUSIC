// metroproto.js — the subset of metroserver's protobuf protocol this app speaks.
//
// Wire format and field numbers are taken verbatim from the published
// `listentogether.proto` (github.com/metrolistgroup/metroproto @ e7c5e3d).
// Only the messages Phase 4a needs are implemented (docs/sidecar.md §4.4);
// everything else stays unimplemented rather than guessed.
//
// This module is pure: no DOM, no network, no globals beyond TextEncoder /
// TextDecoder — which is why app/tests/metroproto.test.mjs can assert the
// exact bytes it emits.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

// ---------------------------------------------------------------- primitives -
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// proto3 varint: little-endian 7-bit groups, high bit = "more bytes follow".
// Negative int64/uint64 values are two's-complement over 64 bits.
function varint(value) {
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Uint8Array.from(bytes);
}

function key(field, wire) {
  return varint(BigInt(field * 8 + wire));
}

function tagBytes(field, wire, body) {
  return concat([key(field, wire), body]);
}

function writeVarintField(field, value) {
  return tagBytes(field, WIRE_VARINT, varint(value));
}

function writeBoolField(field, value) {
  // proto3 scalars default to zero, so `false` is omitted — the decoder on the
  // other side reads the default. Sending it would still be legal, but
  // keeping the encoder canonical makes the golden-byte tests meaningful.
  return value ? writeVarintField(field, 1) : new Uint8Array(0);
}

function writeBytesField(field, bytes) {
  return tagBytes(field, WIRE_LEN, concat([varint(bytes.length), bytes]));
}

function writeStringField(field, text) {
  return writeBytesField(field, encoder.encode(text));
}

// ------------------------------------------------------------------ decoder -
function readVarint(buf, at) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (at >= buf.length) throw new Error("metroproto: truncated varint");
    const byte = buf[at++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("metroproto: varint longer than 64 bits");
  }
  return [result, at];
}

/// Split a serialized message into `Map<fieldNumber, Array<value>>`, where a
/// value is a bigint (varint), a Uint8Array (length-delimited) or a number
/// (fixed32/fixed64 payload as a plain index — callers only need LEN fields).
function decodeFields(buf) {
  const fields = new Map();
  let at = 0;
  while (at < buf.length) {
    let tag;
    [tag, at] = readVarint(buf, at);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value;
    if (wire === WIRE_VARINT) {
      [value, at] = readVarint(buf, at);
    } else if (wire === WIRE_LEN) {
      let len;
      [len, at] = readVarint(buf, at);
      const end = at + Number(len);
      if (end > buf.length) throw new Error("metroproto: truncated length-delimited field");
      value = buf.subarray(at, end);
      at = end;
    } else if (wire === WIRE_FIXED64) {
      value = buf.subarray(at, at + 8);
      at += 8;
      if (at > buf.length) throw new Error("metroproto: truncated fixed64");
    } else if (wire === WIRE_FIXED32) {
      value = buf.subarray(at, at + 4);
      at += 4;
      if (at > buf.length) throw new Error("metroproto: truncated fixed32");
    } else {
      throw new Error(`metroproto: unsupported wire type ${wire}`);
    }
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}

const fieldStr = (fields, no) => {
  const v = fields.get(no)?.[0];
  return v === undefined ? "" : decoder.decode(v);
};
const fieldBool = (fields, no) => fields.get(no)?.[0] === 1n;
const fieldVarint = (fields, no) => fields.get(no)?.[0] ?? 0n;
const fieldBytes = (fields, no) => fields.get(no)?.[0] ?? new Uint8Array(0);

// ------------------------------------------------------------------ envelope -
// message Envelope { string type = 1; bytes payload = 2; bool compressed = 3; }
export function encodeEnvelope(type, payload) {
  return concat([
    writeStringField(1, type),
    writeBytesField(2, payload || new Uint8Array(0)),
    writeBoolField(3, false), // we never negotiate compression (docs/sidecar.md §4.2)
  ]);
}

export function decodeEnvelope(bytes) {
  const fields = decodeFields(bytes);
  return {
    type: fieldStr(fields, 1),
    payload: fieldBytes(fields, 2),
    compressed: fieldBool(fields, 3),
  };
}

// ------------------------------------------------------- handshake messages -
// message ClientCapabilities { bool supports_protobuf = 1;
//   bool supports_compression = 2; string client_version = 3; }
export function encodeClientCapabilities(clientVersion) {
  return concat([
    writeBoolField(1, true),
    writeBoolField(2, false), // no gzip handling: we never have to decompress
    writeStringField(3, clientVersion || ""),
  ]);
}

// message ServerCapabilities { bool supports_protobuf = 1;
//   bool supports_compression = 2; string server_version = 3; }
export function decodeServerCapabilities(bytes) {
  const fields = decodeFields(bytes);
  return {
    supportsProtobuf: fieldBool(fields, 1),
    supportsCompression: fieldBool(fields, 2),
    serverVersion: fieldStr(fields, 3),
  };
}

// ---------------------------------------------------------- room messages -
// message CreateRoomPayload { string username = 1; }
export function encodeCreateRoom(username) {
  return writeStringField(1, username);
}

// message RoomCreatedPayload { string room_code = 1; string user_id = 2;
//   string session_token = 3; }
export function decodeRoomCreated(bytes) {
  const fields = decodeFields(bytes);
  return {
    roomCode: fieldStr(fields, 1),
    userId: fieldStr(fields, 2),
    sessionToken: fieldStr(fields, 3),
  };
}

// message LeaveRoomPayload {} — an empty message is zero bytes.
export function encodeLeaveRoom() {
  return new Uint8Array(0);
}

// message PingPayload { int64 client_time = 1; uint64 sequence = 2; }
export function encodePing(clientTime, sequence) {
  return concat([writeVarintField(1, clientTime), writeVarintField(2, sequence)]);
}

// message PongPayload { int64 client_time = 1; int64 server_receive_time = 2;
//   int64 server_send_time = 3; uint64 sequence = 4; }
export function decodePong(bytes) {
  const fields = decodeFields(bytes);
  return {
    clientTime: fieldVarint(fields, 1),
    serverReceiveTime: fieldVarint(fields, 2),
    serverSendTime: fieldVarint(fields, 3),
    sequence: fieldVarint(fields, 4),
  };
}

// message ErrorPayload { string code = 1; string message = 2; }
export function decodeError(bytes) {
  const fields = decodeFields(bytes);
  return { code: fieldStr(fields, 1), message: fieldStr(fields, 2) };
}

// message UserInfo { string user_id = 1; string username = 2;
//   bool is_host = 3; bool is_connected = 4; } — used to count real members.
export function decodeUserInfo(bytes) {
  const fields = decodeFields(bytes);
  return {
    userId: fieldStr(fields, 1),
    username: fieldStr(fields, 2),
    isHost: fieldBool(fields, 3),
    isConnected: fieldBool(fields, 4),
  };
}

// message RoomState { string room_code = 1; string host_id = 2;
//   repeated UserInfo users = 3; ... }
export function decodeRoomUsers(bytes) {
  const fields = decodeFields(bytes);
  return (fields.get(3) || []).map(decodeUserInfo);
}

// --------------------------------------------------------------- utilities -
/// gzip payloads only appear if compression was negotiated; we never negotiate
/// it, so hitting one means the server changed the rules. Fail loudly instead
/// of showing a half-decoded room.
export async function decompressPayload(payload) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("metroproto: gzip payload but no DecompressionStream available");
  }
  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
