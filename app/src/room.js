// room.js — Listen Together room state (pure reducer, DOM-free).
//
// Reduces the server frames in docs/listen-together.md §3 (contract frozen in
// ROOM.md §3D) into UI state. No sockets, no DOM, no Date except the
// playback-arrival stamp — so it is fully testable with node:test.
//
// Purity contract: reduceRoom NEVER mutates its input. Every branch that
// changes something returns a fresh object with fresh arrays; branches that
// change nothing return the input reference untouched.

export function createRoomState() {
  return {
    role: "idle", // idle | host | guest
    status: "idle", // idle | connecting | hosting | joined
    code: "",
    selfId: "",
    urls: [],
    members: [],
    chat: [],
    historyLoaded: false,
    playback: null,
    driftMs: null,
    error: "",
  };
}

function copyList(list) {
  return Array.isArray(list) ? list.slice() : [];
}

export function reduceRoom(state, frame) {
  if (!frame || typeof frame.t !== "string") return state;

  switch (frame.t) {
    case "joined":
      return {
        ...state,
        role: "guest",
        status: "joined",
        selfId: typeof frame.selfId === "string" ? frame.selfId : state.selfId,
        code: typeof frame.code === "string" ? frame.code : state.code,
        members: copyList(frame.members),
        error: "",
      };

    case "history":
      return {
        ...state,
        chat: copyList(frame.msgs),
        historyLoaded: true,
      };

    case "chat": {
      const entry = {
        from: frame.from,
        text: frame.text,
        ts: frame.ts,
        mine: !!frame.from && frame.from.id === state.selfId,
      };
      return { ...state, chat: [...state.chat, entry] };
    }

    case "presence":
      return { ...state, members: copyList(frame.members) };

    case "playback":
      // The host's playhead is the source of truth; it never applies its own
      // state back onto itself.
      if (state.role === "host") return state;
      return { ...state, playback: { ...frame, arrivedAt: Date.now() } };

    case "error": {
      const next = {
        ...state,
        // Verbatim, never paraphrased — the server's message is the diagnosis.
        error: typeof frame.message === "string" ? frame.message : state.error,
      };
      if (state.status === "connecting") next.status = "idle";
      return next;
    }

    case "bye": {
      const reason = typeof frame.reason === "string" ? frame.reason : "";
      let error = state.error;
      if (reason === "left") {
        error = "";
      } else if (!error && reason) {
        error = reason;
      }
      return {
        ...state,
        role: "idle",
        status: "idle",
        code: "",
        selfId: "",
        urls: [],
        members: [],
        chat: [],
        historyLoaded: false,
        playback: null,
        driftMs: null,
        error,
      };
    }

    // `refresh` is answered by the host JS separately; unknown frames are
    // future protocol, not present errors. Both leave state untouched.
    default:
      return state;
  }
}

/// Never claims zero: a room of one is still a room.
export function memberCount(state) {
  const n = Array.isArray(state.members) ? state.members.length : 0;
  return Math.max(1, n);
}

/// The host's share line. Empty unless hosting with a code in hand.
/// No URL yet: the code alone. Never interpolate a missing index — that
/// renders the literal "undefined", which the truthfulness rules forbid
/// (was app/tests/room.test.mjs `todo`, now a live assertion).
export function inviteText(state) {
  if (state.role !== "host" || !state.code) return "";
  const urls = Array.isArray(state.urls) ? state.urls : [];
  if (!urls[0]) return state.code;
  return `${urls[0]} · ${state.code}`;
}

/// Largest |driftMs| across non-host members, or null when there is nothing
/// to sync against. Non-host = not flagged `isHost` by the server.
export function worstDriftMs(state) {
  let worst = null;
  for (const m of state.members || []) {
    if (!m || m.isHost) continue;
    if (typeof m.driftMs !== "number" || Number.isNaN(m.driftMs)) continue;
    const abs = Math.abs(m.driftMs);
    if (worst === null || abs > worst) worst = abs;
  }
  return worst;
}
