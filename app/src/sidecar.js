// sidecar.js — connection manager for the user-installed metroserver
// (docs/sidecar.md). Loopback only: every address this module opens starts
// with 127.0.0.1, and there is no configuration that changes that.
//
// The module is deliberately DOM-free and takes its collaborators (fetch,
// socket factory, listener) as options, which is what makes
// app/tests/sidecar.test.mjs able to drive the whole state machine with a
// scripted fake socket.
//
// Honesty rule for every status this file produces: a value may only be shown
// after the message that proves it was received and decoded — `connected`
// only after `server_capabilities`, `roomCode` only after `room_created`,
// error text only verbatim from an `error` frame.
import {
  decodeEnvelope,
  decodeError,
  decodeRoomCreated,
  decodeServerCapabilities,
  encodeClientCapabilities,
  encodeCreateRoom,
  encodeEnvelope,
  encodeLeaveRoom,
  encodePing,
} from "./metroproto.js";

export const DEFAULT_PORT = 8080;
export const CLIENT_VERSION = "openmusic/0.4.0";

export const STATUS = {
  IDLE: "idle",
  PROBING: "probing",
  OFFLINE: "offline",
  CONNECTING: "connecting",
  HANDSHAKING: "handshaking",
  CONNECTED: "connected",
  ROOM: "room",
  ERROR: "error",
};

const LOOPBACK = "127.0.0.1";

export function healthUrl(port) {
  return `http://${LOOPBACK}:${port}/health`;
}

export function socketUrl(port) {
  return `ws://${LOOPBACK}:${port}/ws`;
}

/// Port override lives in localStorage (`tm-sidecar-port`); no settings UI yet.
export function readPort(storage) {
  try {
    const raw = Number(storage && storage.getItem("tm-sidecar-port"));
    if (Number.isInteger(raw) && raw > 0 && raw <= 65535) return raw;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_PORT;
}

const unref = (timer) => {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
};

export function createSidecar(options = {}) {
  const {
    port = DEFAULT_PORT,
    onChange = () => {},
    fetchImpl = typeof fetch === "function" ? fetch.bind(globalThis) : null,
    socketFactory = (url) => new WebSocket(url),
    timeouts = {},
  } = options;

  const limits = {
    probe: timeouts.probe ?? 1500,
    handshake: timeouts.handshake ?? 5000,
    ping: timeouts.ping ?? 15000,
  };

  const state = {
    status: STATUS.IDLE,
    port,
    roomCode: "",
    userId: "",
    serverVersion: "",
    // Last honest sentence for the UI: server error text verbatim, or an
    // explanation of why there is no connection.
    message: "",
    errorCode: "",
    members: 0,
  };

  let socket = null;
  let handshakeTimer = 0;
  let pingTimer = 0;
  let pingSeq = 0;
  let expectCapabilities = false;
  let closedByUs = false;

  const emit = () => onChange({ ...state });

  const setStatus = (status, message) => {
    state.status = status;
    if (message !== undefined) state.message = message;
    emit();
  };

  const clearTimers = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = 0;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = 0;
  };

  const send = (type, payload) => {
    if (!socket || socket.readyState !== 1 /* OPEN */) return false;
    socket.send(encodeEnvelope(type, payload));
    return true;
  };

  const startPinging = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = unref(
      setInterval(() => {
        pingSeq += 1;
        send("ping", encodePing(Date.now(), pingSeq));
      }, limits.ping),
    );
  };

  const teardown = (message) => {
    clearTimers();
    const s = socket;
    socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try {
        s.close();
      } catch {
        /* already closing */
      }
    }
    expectCapabilities = false;
    state.roomCode = "";
    state.userId = "";
    state.members = 0;
    if (message !== undefined) state.message = message;
  };

  const fail = (code, message) => {
    teardown(message);
    state.errorCode = code;
    setStatus(STATUS.ERROR, message);
  };

  async function handleMessage(data) {
    let bytes = data;
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      bytes = await data.arrayBuffer();
    }
    const envelope = decodeEnvelope(new Uint8Array(bytes));
    if (envelope.compressed) {
      // We advertise supports_compression: false, so this should be
      // unreachable — surface it as an error rather than guessing.
      fail("unexpected_gzip", "Server sent a compressed payload we never negotiated.");
      return;
    }

    switch (envelope.type) {
      case "server_capabilities": {
        const caps = decodeServerCapabilities(envelope.payload);
        if (!caps.supportsProtobuf) {
          fail("no_protobuf", "Server does not support the protobuf protocol.");
          return;
        }
        expectCapabilities = false;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = 0;
        state.serverVersion = caps.serverVersion;
        startPinging();
        setStatus(
          STATUS.CONNECTED,
          `Handshake ok (server ${caps.serverVersion || "?"}). Open a room to get a code.`,
        );
        return;
      }
      case "room_created": {
        const room = decodeRoomCreated(envelope.payload);
        state.roomCode = room.roomCode;
        state.userId = room.userId;
        state.members = 1; // us, counted from the server's own reply
        setStatus(STATUS.ROOM, `Room ${room.roomCode} open — share the code.`);
        return;
      }
      case "error": {
        const err = decodeError(envelope.payload);
        const text = err.message || err.code;
        if (expectCapabilities) {
          // Rejected during the handshake: there is no connection to keep.
          fail(err.code || "handshake_rejected", text);
          return;
        }
        // A rejected room creation (e.g. host_not_allowed) leaves the socket
        // healthy: keep the connection, show the server's words unchanged.
        state.errorCode = err.code;
        setStatus(state.status === STATUS.ROOM ? STATUS.ROOM : STATUS.CONNECTED, text);
        return;
      }
      case "pong":
        return; // keepalive acknowledged; nothing user-visible changes
      default:
        // Phase 4b/5 messages (join, presence, playback) are intentionally
        // ignored rather than mis-parsed.
        return;
    }
  }

  async function probe() {
    if (!fetchImpl) {
      setStatus(STATUS.OFFLINE, "No fetch available to probe the sidecar.");
      return false;
    }
    setStatus(STATUS.PROBING, `Looking for a sidecar on ${LOOPBACK}:${port} …`);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = unref(setTimeout(() => controller?.abort(), limits.probe));
    try {
      const res = await fetchImpl(healthUrl(port), controller ? { signal: controller.signal } : {});
      const ok = !!(res && res.ok);
      if (ok) {
        // Probe passed but nothing is proven yet: keep "probing" on screen
        // until connect() reports a real frame.
        state.message = `Sidecar answered on ${LOOPBACK}:${port} — connecting…`;
        emit();
      } else {
        setStatus(STATUS.OFFLINE, `Nothing healthy at ${LOOPBACK}:${port}.`);
      }
      return ok;
    } catch {
      setStatus(STATUS.OFFLINE, `No sidecar at ${LOOPBACK}:${port} — start metroserver to connect.`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function connect() {
    if (socket) return true;
    closedByUs = false;
    expectCapabilities = true;
    setStatus(STATUS.CONNECTING, `Opening ${socketUrl(port)} …`);
    try {
      socket = socketFactory(socketUrl(port));
    } catch (err) {
      expectCapabilities = false;
      setStatus(STATUS.ERROR, `Socket refused: ${err && err.message ? err.message : err}`);
      return false;
    }
    if (socket && "binaryType" in socket) socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      send("client_capabilities", encodeClientCapabilities(CLIENT_VERSION));
      setStatus(STATUS.HANDSHAKING, "Handshaking with the sidecar…");
      handshakeTimer = unref(
        setTimeout(() => {
          fail("handshake_timeout", "No server_capabilities before the timeout.");
        }, limits.handshake),
      );
    };
    socket.onmessage = (event) => {
      handleMessage(event.data).catch((err) => {
        fail("decode_failed", `Undecodable frame: ${err && err.message ? err.message : err}`);
      });
    };
    socket.onerror = () => {
      if (state.status === STATUS.CONNECTING || state.status === STATUS.HANDSHAKING) {
        setStatus(STATUS.ERROR, `Could not reach ${socketUrl(port)}.`);
      }
    };
    socket.onclose = () => {
      clearTimers();
      socket = null;
      expectCapabilities = false;
      state.roomCode = "";
      state.userId = "";
      state.members = 0;
      if (closedByUs) {
        setStatus(STATUS.IDLE, "");
      } else if (state.status !== STATUS.ERROR) {
        setStatus(STATUS.OFFLINE, "Sidecar closed the connection.");
      }
    };
    return true;
  }

  /// Ask the server for a room. Only `room_created` may put a code on screen;
  /// a `host_not_allowed` verdict is shown verbatim and changes no code slots.
  function createRoom(username) {
    if (!socket || state.status !== STATUS.CONNECTED) {
      return { ok: false, reason: "not-connected" };
    }
    state.errorCode = "";
    const sent = send("create_room", encodeCreateRoom(username || "You"));
    if (!sent) {
      return { ok: false, reason: "socket-closed" };
    }
    emit();
    return { ok: true, reason: "" };
  }

  function leave() {
    closedByUs = true;
    if (socket) send("leave_room", encodeLeaveRoom());
    teardown("");
    setStatus(STATUS.IDLE, "");
  }

  function stop() {
    closedByUs = true;
    teardown("");
    setStatus(STATUS.IDLE, "");
  }

  return {
    get state() {
      return { ...state };
    },
    healthUrl: () => healthUrl(port),
    socketUrl: () => socketUrl(port),
    probe,
    connect,
    createRoom,
    leave,
    stop,
    // exposed for tests: drive a frame through the same path a socket would
    _handleMessage: handleMessage,
  };
}
