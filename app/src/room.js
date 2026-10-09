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
    invite: "",
    members: [],
    chat: [],
    historyLoaded: false,
    playback: null,
    hostQueue: [], // host's up-next snapshot (§4.7); guests render read-only
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
        // A previous room's shared queue must not leak in — the welcome
        // `queue` frame (if the host shares one) replaces it (§4.7).
        hostQueue: [],
        error: "",
      };

    // Host-side counterpart of `joined`. The server never sends the host a
    // `joined` frame (it learns its room from `room_open`'s return value and
    // hears everything through its own sink), so the host surface reduces this
    // frame built from those real server facts. `selfId` is the id the server
    // gave its own member row — always the literal "host" — which is what makes
    // the host's own chat echo resolve as `mine` (docs/listen-together.md §13.3).
    case "hosted":
      return {
        ...state,
        role: "host",
        status: "hosting",
        selfId: typeof frame.selfId === "string" ? frame.selfId : state.selfId,
        code: typeof frame.code === "string" ? frame.code : state.code,
        urls: copyList(frame.urls),
        // The canonical link `room_open` minted (A). An old backend that
        // omits it leaves the fallbacks in inviteText() to do their job.
        invite: typeof frame.invite === "string" ? frame.invite : state.invite,
        members: copyList(frame.members),
        // G5: a device-local echo (sent while no room was open) was never
        // relayed to anyone — the server's history starts empty, so opening a
        // room must not carry the local line across with it. Same for a
        // previous room's shared queue (§4.7).
        chat: [],
        hostQueue: [],
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
        // Server-origin system lines ("X joined" / "X left") — no sender, so
        // `mine` is false above; renderers key on this flag (F7).
        system: frame.system === true,
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

    case "queue": {
      // §4.7: the host's up-next snapshot — guests render it read-only, the
      // host ignores its own broadcast. Entries are coerced to strings so a
      // ragged frame cannot poison the list; the server already caps at 10.
      if (state.role === "host") return state;
      const tracks = Array.isArray(frame.tracks) ? frame.tracks.slice(0, 10) : [];
      return {
        ...state,
        hostQueue: tracks.map((t) => ({
          id: String(t?.id ?? ""),
          title: String(t?.title ?? ""),
          artist: String(t?.artist ?? ""),
        })),
      };
    }

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
        invite: "",
        members: [],
        chat: [],
        historyLoaded: false,
        playback: null,
        hostQueue: [],
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
/// Prefers the canonical `trancemusic://join?…` link the backend minted (the
/// one string display, clipboard and QR all carry), then the legacy
/// `ws://ip:port · CODE` composite, then the bare code — never a missing
/// index, which would render the literal "undefined" (was
/// app/tests/room.test.mjs `todo`, now a live assertion).
export function inviteText(state) {
  if (state.role !== "host" || !state.code) return "";
  if (state.invite) return state.invite;
  const urls = Array.isArray(state.urls) ? state.urls : [];
  if (!urls[0]) return state.code;
  return `${urls[0]} · ${state.code}`;
}

/// Where the host's playhead is *now*: the frame's own position advanced by
/// the time this device has held the frame since it arrived. That local anchor
/// is why two PCs need no wall-clock sync — the error is one LAN hop plus the
/// local audio clock (docs/listen-together.md §4.1). `null` (never `0`) until a
/// `playback` frame exists.
export function expectedPositionMs(playback, nowMs = Date.now()) {
  if (!playback || typeof playback.positionMs !== "number") return null;
  if (!playback.playing) return playback.positionMs;
  const arrived = typeof playback.arrivedAt === "number" ? playback.arrivedAt : nowMs;
  return playback.positionMs + Math.max(0, nowMs - arrived);
}

/// Host (and guest) tick cadence — one export so desktop/mobile cannot drift
/// apart (docs/jam-upgrade.md §C). 250 ms is the v1 staleness bound; 0 ms is
/// not achievable on a LAN.
export const HOST_TICK_MS = 250;

/// Below this, leave the playhead alone (measurement noise).
export const DRIFT_DEADBAND_MS = 40;

/// Past this the guest hard-seeks; between deadband and here it rate-nudges
/// so a 100 ms miss is inaudible instead of a click (docs §4.3).
export const DRIFT_TOLERANCE_MS = 150;

export const ROOM_LOST_REASON = "Connection to the room was lost.";
export const CONNECT_FAILED_CODE = "connect_failed";
const REJOIN_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
export const REJOIN_MAX_ATTEMPTS = 5;

/// Rate nudge in the 40–150 ms band: ahead → slow down, behind → speed up.
/// Outside the band the caller seeks (or does nothing) and this returns 1.
export function nudgeRate(driftMs) {
  if (typeof driftMs !== "number" || !Number.isFinite(driftMs)) return 1;
  const abs = Math.abs(driftMs);
  if (abs <= DRIFT_DEADBAND_MS || abs > DRIFT_TOLERANCE_MS) return 1;
  const rate = 1 - driftMs / 2000;
  return Math.min(1.05, Math.max(0.95, rate));
}

/// Thin `room_report`: always on a seek or a real miss, else ~1/s (every 4th
/// 250 ms tick) so the host tile still moves without 4 reports/s on the wire.
export function shouldReportDrift(driftMs, seekApplied, tickIndex) {
  if (typeof driftMs !== "number" || !Number.isFinite(driftMs)) return false;
  if (seekApplied || Math.abs(driftMs) > DRIFT_DEADBAND_MS) return true;
  return tickIndex % 4 === 0;
}

/// Lost-socket only. Leave / host-close / empty invite / exhausted retries
/// stay idle so a dead room is not hammered (docs/jam-upgrade.md §5.4).
export function shouldAutoRejoin(reason, lastInvite, userLeft, attempts) {
  if (userLeft || !lastInvite || attempts >= REJOIN_MAX_ATTEMPTS) return false;
  return reason === ROOM_LOST_REASON;
}

export function rejoinDelayMs(attempt) {
  const i = Math.min(Math.max(0, attempt), REJOIN_BACKOFF_MS.length - 1);
  return REJOIN_BACKOFF_MS[i];
}

/// Which interval the surface should be running. Chat/presence must not
/// re-arm a running tick — resetting it adds up to HOST_TICK_MS of extra
/// playhead staleness (docs/jam-professional-grade.md N8).
export function roomTickKind(role) {
  return role === "host" || role === "guest" ? role : "";
}

/// A follow attempt (resolve + play) takes seconds while `at`/`positionMs`
/// change on every 250 ms tick. Firing per tick stacks concurrent attempts
/// that each enqueue+play — queue pollution, audio restarts, "the guest is
/// not following". Gate on the track id: one in-flight attempt per id. The
/// timestamp expires it after 30 s so a hung resolve can never wedge the
/// guest forever (docs/listen-together.md §4.6).
export const FOLLOW_ATTEMPT_TTL_MS = 30_000;

export function shouldStartFollow(inFlightId, inFlightAtMs, trackId, nowMs = Date.now()) {
  if (!trackId) return false;
  if (!inFlightId || inFlightId !== trackId) return true;
  return nowMs - (inFlightAtMs || 0) > FOLLOW_ATTEMPT_TTL_MS;
}

/// After an `error` frame during a join: retry only if a lost-socket rejoin
/// is already in flight (`attempts > 0`) **and** the failure is a dial
/// (`connect_failed`). `bad_code` / `room_full` / chat refusals must not
/// hammer a dead invite (N13). A first-join refusal must not start backoff
/// (N10).
export function shouldRetryJoinAfterError(lastInvite, userLeft, attempts, errorCode) {
  if (errorCode && errorCode !== CONNECT_FAILED_CODE) return false;
  return attempts > 0 && shouldAutoRejoin(ROOM_LOST_REASON, lastInvite, userLeft, attempts);
}

/// `room_close` on a half-open guest emits `bye{reason:"left"}`. If this
/// window already reduced a `joined`/`hosted` frame, that bye is stale
/// cleanup — reducing it would idle a live room (N12).
export function isStaleLocalBye(reason, userLeft, role) {
  return reason === "left" && !userLeft && (role === "host" || role === "guest");
}

/// Same cleanup bye, but we are still idle waiting to redial. Must not
/// clear `lastJoinUri` or cancel the timer (N12).
export function shouldKeepRejoinAfterBye(reason, userLeft, lastInvite, attempts) {
  return reason === "left" && !userLeft && shouldAutoRejoin(ROOM_LOST_REASON, lastInvite, userLeft, attempts);
}

/// The one place drift is measured, shared by both surfaces so neither can
/// report a different number for the same audio (docs/listen-together.md §8):
/// `driftMs` is the measured difference (positive = this device is ahead),
/// `seekToSec` is a target **only** past the tolerance, else `null`, and
/// `playbackRate` is 1 outside the nudge band.
export function syncDecision(state, audioPosSec, nowMs = Date.now()) {
  const expected = expectedPositionMs(state && state.playback, nowMs);
  if (expected === null || typeof audioPosSec !== "number" || !Number.isFinite(audioPosSec)) {
    return { driftMs: null, seekToSec: null, playbackRate: 1 };
  }
  const driftMs = Math.round(audioPosSec * 1000 - expected);
  const abs = Math.abs(driftMs);
  const seekToSec = abs > DRIFT_TOLERANCE_MS ? expected / 1000 : null;
  return {
    driftMs,
    seekToSec,
    playbackRate: seekToSec !== null ? 1 : nudgeRate(driftMs),
  };
}

/// Read a pasted invite back into its two halves. Two shapes are accepted:
/// the canonical `trancemusic://join?host=…&port=…&code=…` link (A) and the
/// legacy `ws://ip:port · CODE` line — plus the human variants
/// `ip:port CODE` / `ip CODE`. Anything without both halves returns `null`
/// (an address with no code is not joinable), so the caller can show its own
/// honest error instead of joining a room that cannot exist. This parser is
/// **pre-validation for the inline message only — Rust's `parse_invite` is
/// the authority** (docs/jam-upgrade.md §3.3).
export function parseInvite(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return null;

  if (text.startsWith("trancemusic://join?")) {
    const params = new URLSearchParams(text.slice("trancemusic://join?".length));
    const host = (params.get("host") || "").trim();
    const port = (params.get("port") || "").trim();
    const code = (params.get("code") || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    // Deliberately loose on the host (the LAN gate lives in Rust); strict on
    // the two halves that make a room addressable.
    if (!host || !/^\d+$/.test(port) || code.length !== 8) return null;
    return { addr: `${host}:${port}`, code };
  }

  const parts = text
    .replace(/[·|,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const code = parts[parts.length - 1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const addr = parts.slice(0, -1).join("");
  if (code.length !== 8 || !addr) return null;
  return { addr, code };
}

/// Mirrors the server's own `sanitize_name` (trim, drop control characters,
/// cap 24, empty → Guest) so the name a surface *shows* before any presence
/// frame matches the name the room will actually hold.
/// The one deviation is the empty case: the host calls itself "Host".
export function sanitizeRoomName(raw, fallback = "Guest") {
  const clean = String(raw == null ? "" : raw)
    .trim()
    .split("")
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n >= 32 && n !== 127;
    })
    .join("")
    .slice(0, 24);
  return clean || fallback;
}

/// Settings writes `tm-name`; an older key `tm-username` is read as fallback
/// so a value set before the rename still appears on the roster. `read` is
/// injected (no `localStorage` here) so node:test can drive it.
export function roomDisplayName(read, fallback = "Guest") {
  let raw;
  try {
    raw = (typeof read === "function" && (read("tm-name") || read("tm-username"))) || "";
  } catch {
    raw = "";
  }
  return sanitizeRoomName(raw, fallback);
}

/// Largest |driftMs| across non-host members, or null when there is nothing
/// measured yet — never 0, which would read as "perfectly in sync".
/// to sync against. Non-host = not flagged `isHost` by the server.
export function worstDriftMs(state) {
  let worst = null;
  for (const m of state.members || []) {
    // The server's field is `host` (§3); `isHost` is tolerated so a state
    // built by hand in a caller still excludes the host's own row.
    if (!m || m.isHost || m.host) continue;
    if (typeof m.driftMs !== "number" || Number.isNaN(m.driftMs)) continue;
    const abs = Math.abs(m.driftMs);
    if (worst === null || abs > worst) worst = abs;
  }
  return worst;
}

// ------------------------------------------------------------ local role ---
// Which side of a room THIS window is on right now. The surfaces (social.js /
// jam.js) set it whenever their room state changes; playback owners that are
// not part of the room glue read it to hand the timeline to the host — a
// guest's transport and seek surface must not fight the incoming frames, and
// crossfade/gapless element swaps must not happen mid-room on either side
// (§4: the host owns the playhead; a fade is two timelines).
let currentLocalRole = "";

export function setLocalRole(role) {
  currentLocalRole = role === "host" || role === "guest" ? role : "";
}

export function localRole() {
  return currentLocalRole;
}
