// sidecar.js — state machine against a scripted fake socket.
// The app cannot run metroserver on this machine (no Go toolchain, see
// docs/sidecar.md §7), so what is verified here is everything upstream of a
// real network: which frames go out, which frames are believed, and that no
// status is shown before the message that proves it arrives.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeEnvelope,
  decodeRoomCreated,
  decodeServerCapabilities,
  encodeClientCapabilities,
  encodeCreateRoom,
  encodeEnvelope,
} from "../src/metroproto.js";
import { createSidecar, healthUrl, readPort, socketUrl, STATUS, DEFAULT_PORT } from "../src/sidecar.js";

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

class FakeSocket {
  constructor() {
    this.url = "";
    this.binaryType = "";
    this.readyState = 0;
    this.sent = [];
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen && this.onopen();
  }
  /// deliver a frame exactly as the browser would: an ArrayBuffer in the event
  deliver(bytes) {
    this.onmessage && this.onmessage({ data: bytes.buffer.slice(0) });
  }
  /// every envelope this sidecar has sent, decoded
  frames() {
    return this.sent.map(decodeEnvelope);
  }
}

function boot(overrides = {}) {
  const changes = [];
  const sockets = [];
  const fetchImpl =
    overrides.fetchImpl ||
    (async () => ({ ok: overrides.healthy !== false, status: 200 }));
  const sidecar = createSidecar({
    port: overrides.port || DEFAULT_PORT,
    onChange: (s) => changes.push(s),
    fetchImpl,
    socketFactory: (url) => {
      const s = new FakeSocket();
      s.url = url;
      sockets.push(s);
      return s;
    },
    timeouts: { probe: 50, handshake: 200, ping: overrides.ping ?? 100000 },
  });
  return { sidecar, changes, sockets, last: () => sidecar.state };
}

const SERVER_CAPS = Uint8Array.from([0x08, 0x01, 0x1a, 0x01, 0x31]); // protobuf, "1"

function roomCreatedFrame() {
  const payload = Uint8Array.from([
    0x0a, 8, ...ascii("ABCD1234"),
    0x12, 2, ...ascii("u1"),
    0x1a, 3, ...ascii("tok"),
  ]);
  return encodeEnvelope("room_created", payload);
}

function errorFrame(code, message) {
  const payload = Uint8Array.from([
    0x0a, code.length, ...ascii(code),
    0x12, message.length, ...ascii(message),
  ]);
  return encodeEnvelope("error", payload);
}

async function connectAndHandshake(booted) {
  const { sidecar, sockets } = booted;
  sidecar.connect();
  const sock = sockets[0];
  sock.open();
  sock.deliver(encodeEnvelope("server_capabilities", SERVER_CAPS));
  return sock;
}

// ---------------------------------------------------------------------- tests -

test("addresses are loopback only", () => {
  assert.equal(healthUrl(8080), "http://127.0.0.1:8080/health");
  assert.equal(socketUrl(8080), "ws://127.0.0.1:8080/ws");
  assert.equal(readPort({ getItem: () => "9000" }), 9000);
  assert.equal(readPort({ getItem: () => "not-a-port" }), DEFAULT_PORT);
  assert.equal(readPort({ getItem: () => "70000" }), DEFAULT_PORT);
  assert.equal(readPort(null), DEFAULT_PORT);
});

test("probe reports the sidecar's real answer", async () => {
  const up = boot();
  assert.equal(await up.sidecar.probe(), true);
  assert.equal(up.last().status, STATUS.PROBING); // nothing is "connected" yet
  assert.match(up.last().message, /127\.0\.0\.1:8080/);

  const down = boot({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(await down.sidecar.probe(), false);
  assert.equal(down.last().status, STATUS.OFFLINE);
  assert.match(down.last().message, /No sidecar at 127\.0\.0\.1:8080/);

  const unhealthy = boot({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(await unhealthy.sidecar.probe(), false);
  assert.equal(unhealthy.last().status, STATUS.OFFLINE);
});

test("handshake: capabilities first, connected only after server_capabilities", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  sidecar.connect();
  const sock = booted.sockets[0];
  assert.equal(sock.url, "ws://127.0.0.1:8080/ws");
  assert.equal(last().status, STATUS.CONNECTING);

  sock.open();
  const [caps] = sock.frames();
  assert.equal(caps.type, "client_capabilities");
  // ClientCapabilities and ServerCapabilities share field numbers, so the
  // server's decoder can read ours — and so can this assertion.
  const decoded = decodeServerCapabilities(caps.payload);
  assert.equal(decoded.supportsProtobuf, true);
  assert.equal(decoded.supportsCompression, false, "we never negotiate gzip");
  assert.equal(decoded.serverVersion, "openmusic/0.4.0");
  assert.equal(new TextDecoder().decode(caps.payload), new TextDecoder().decode(encodeClientCapabilities("openmusic/0.4.0")));
  assert.equal(last().status, STATUS.HANDSHAKING, "not connected before the reply");

  sock.deliver(encodeEnvelope("server_capabilities", SERVER_CAPS));
  assert.equal(last().status, STATUS.CONNECTED);
  assert.equal(last().serverVersion, "1");
  sidecar.stop();
});

test("the server can refuse the handshake, and the refusal is shown verbatim", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  sidecar.connect();
  const sock = booted.sockets[0];
  sock.open();
  sock.deliver(errorFrame("unsupported_client", "Protobuf support is required"));
  assert.equal(last().status, STATUS.ERROR);
  assert.equal(last().errorCode, "unsupported_client");
  assert.equal(last().message, "Protobuf support is required");
  assert.equal(last().roomCode, "");
});

test("room codes appear only after room_created, never before", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  const sock = await connectAndHandshake(booted);

  assert.deepEqual(sidecar.createRoom("You"), { ok: true, reason: "" });
  assert.equal(last().status, STATUS.CONNECTED, "waiting, not in a room");
  assert.equal(last().roomCode, "", "no code may be shown while waiting");

  const created = sock.frames().at(-1);
  assert.equal(created.type, "create_room");
  assert.deepEqual([...created.payload], [...encodeCreateRoom("You")], "username travels verbatim");

  sock.deliver(roomCreatedFrame());
  assert.equal(last().status, STATUS.ROOM);
  assert.equal(last().roomCode, "ABCD1234");
  assert.equal(last().userId, "u1");
  assert.equal(last().members, 1, "counted from the server's own reply");
  sidecar.stop();
});

test("host_not_allowed keeps the connection and shows the server's words", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  const sock = await connectAndHandshake(booted);
  sidecar.createRoom("You");
  sock.deliver(errorFrame("host_not_allowed", "Only allowlisted clients can host rooms"));

  assert.equal(last().status, STATUS.CONNECTED, "the socket is still healthy");
  assert.equal(last().errorCode, "host_not_allowed");
  assert.equal(last().message, "Only allowlisted clients can host rooms");
  assert.equal(last().roomCode, "", "a refused room must not invent a code");
});

test("room creation is refused while disconnected", async () => {
  const { sidecar, last } = boot();
  assert.deepEqual(sidecar.createRoom("You"), { ok: false, reason: "not-connected" });
  assert.equal(last().roomCode, "");
  assert.equal(last().status, STATUS.IDLE);
});

test("leaving tears everything down and clears the code", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  const sock = await connectAndHandshake(booted);
  sock.deliver(roomCreatedFrame());
  assert.equal(last().roomCode, "ABCD1234");

  sidecar.leave();
  const types = sock.frames().map((f) => f.type);
  assert.ok(types.includes("leave_room"), "server must be told we left");
  assert.equal(last().status, STATUS.IDLE);
  assert.equal(last().roomCode, "", "code slots reset with the connection");
  assert.equal(last().members, 0);
});

test("an undecodable frame fails closed instead of guessing", async () => {
  const booted = boot();
  const { sidecar, last } = booted;
  sidecar.connect();
  const sock = booted.sockets[0];
  sock.open();
  sock.deliver(Uint8Array.from([0xff, 0xff]));
  await new Promise((resolve) => setImmediate(resolve)); // let the rejection land
  assert.equal(last().status, STATUS.ERROR);
  assert.match(last().message, /Undecodable frame/);
  assert.equal(last().roomCode, "");
});

test("probe hits a real socket on 127.0.0.1, not just a stub", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const up = createSidecar({ port, onChange: () => {} });
  assert.equal(await up.probe(), true, "real /health must be reachable");
  assert.match(up.state.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
  up.stop();

  await new Promise((resolve) => server.close(resolve));

  const down = createSidecar({ port, onChange: () => {} });
  assert.equal(await down.probe(), false, "a closed port must read as offline");
  assert.equal(down.state.status, STATUS.OFFLINE);
});

test("keepalive: a ping goes out once the handshake completed", async () => {
  const booted = boot({ ping: 10 });
  const { sidecar, last } = booted;
  const sock = await connectAndHandshake(booted);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const pings = sock.frames().filter((f) => f.type === "ping");
  assert.ok(pings.length >= 1, "expected at least one keepalive ping");
  assert.equal(last().status, STATUS.CONNECTED);
  sidecar.stop();
  assert.equal(last().status, STATUS.IDLE);
});
