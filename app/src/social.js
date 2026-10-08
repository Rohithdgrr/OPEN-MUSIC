// social.js — Social Now Playing shell + Listen Together room glue.
//
// Two layers live here:
//   1. Local state (Phase 3): mode switch, reactions, chat echo, skip vote,
//      queue lock, QR surface — see docs/social-nowplaying.md.
//   2. The room (docs/listen-together.md §6/§13): this module calls the Rust
//      `room_*` commands and reduces the `room://msg` frames through the pure
//      reducer in room.js. It opens **no socket of its own** — both sockets
//      live in Rust (app/src-tauri/src/room.rs), so the WebView CSP stays
//      untouched and every wire path is covered by `cargo test`.
//
// Every count, message and drift number below is either produced by this
// client or decoded from a server frame: see docs/listen-together.md §8
// (truthfulness) and docs/social-nowplaying.md §6.
import { diag, invoke, toast } from "./core.js";
import { $, $$, audio } from "./dom.js";
import { playerSnapshot } from "./bridge.js";
import { loadPlays } from "./home.js";
import { loadFavs } from "./library.js";
import { playQueueItem } from "./playback.js";
import { enqueue, queue } from "./queue.js";
import { paintQr } from "./qrview.js";
import {
  createRoomState,
  inviteText,
  parseInvite,
  memberCount,
  reduceRoom,
  roomDisplayName,
  setLocalRole,
  syncDecision,
  shouldReportDrift,
  shouldAutoRejoin,
  shouldRetryJoinAfterError,
  isStaleLocalBye,
  shouldKeepRejoinAfterBye,
  rejoinDelayMs,
  roomTickKind,
  HOST_TICK_MS,
  ROOM_LOST_REASON,
  worstDriftMs,
} from "./room.js";
import { resolveFromCatalog } from "./jam/follow.js";
import { entryTrack, vaultEntries } from "./vault.js";

/// The host's sync tick (§4.1 / jam-upgrade §C). Cadence lives in room.js.
/// Every room-code surface, painted from one list with one fallback: a
/// refusal, a disconnect or a leave must blank **all** of them together
/// (docs/social-nowplaying.md §3b-i).
const ROOM_SLOTS = ["soc-room-code", "qr-room-code", "jam-room-id"];
const NO_ROOM = "NO ROOM";
const DEFAULT_ROOM_NOTE = "Open a room on this device, or join one with its code.";

/// A guest may not drive the room's transport: the host's playhead is the only
/// source of truth (§4). These are the desktop controls that would otherwise
/// fight it. Out-of-band changes (global hotkeys) are not a hole — they are
/// corrected by the next host frame, within one tick.
const GUEST_LOCK_IDS = [
  "bar-play", "bar-prev", "bar-next", "bar-shuffle", "bar-repeat",
];
const GUEST_SEEK_IDS = ["bar-progress"];

let votes = 0;

// ------------------------------------------------------------------ room ---
let room = createRoomState();
let roomPort = 0;
let joining = false;
let listenerReady = false;
let tickTimer = 0; // HOST_TICK_MS host broadcast / guest apply loop
let lastDrift = null; // this guest's measured drift, ms
let guestMirror = ""; // set when the host's track is not on this device
let guestApplied = ""; // last playback frame key this guest applied
let guestTickCount = 0;
let lastJoinUri = "";
let userLeft = false;
let rejoinTimer = 0;
let rejoinAttempts = 0;
let armedTick = ""; // roomTickKind currently running; chat must not reset it

function el(id) {
  return document.getElementById(id);
}

function setRoomNote(text) {
  const note = el("room-join-note");
  if (note) note.textContent = text;
}

function roomName(fallback = "Host") {
  try {
    return roomDisplayName((k) => window.localStorage.getItem(k), fallback);
  } catch {
    return fallback;
  }
}

function paintRoomCode(code) {
  const text = code || NO_ROOM;
  for (const id of ROOM_SLOTS) {
    const node = el(id);
    if (node) node.textContent = text;
  }
}

/// One row of `#jam-members`, built from a real `presence` member — or, with no
/// room, from the one member this client can prove exists (itself, solo).
function memberRow(member) {
  const row = document.createElement("div");
  row.className = "soc-member";

  const avatar = document.createElement("span");
  avatar.className = member.host ? "soc-member-avatar is-you" : "soc-member-avatar";
  avatar.textContent = member.host ? "YOU" : initialsOf(member.name);

  const name = document.createElement("span");
  name.className = "soc-member-name";
  name.textContent = member.name || "Guest";

  const role = document.createElement("span");
  role.className = "soc-member-role";
  const badge = document.createElement("span");
  badge.className = "soc-badge";
  badge.textContent = member.host ? "HOST" : "GUEST";
  const drift = document.createElement("span");
  drift.textContent =
    typeof member.driftMs === "number" ? `${(member.driftMs / 1000).toFixed(2)}s` : "—";
  role.append(badge, drift);

  row.append(avatar, name, role);
  return row;
}

function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const text = parts.map((p) => p[0]).join("").toUpperCase();
  return text || "??";
}

function setGuestLock(locked) {
  for (const id of GUEST_LOCK_IDS) {
    const node = el(id);
    if (!node) continue;
    node.disabled = locked;
    node.title = locked ? "The host controls playback in this room" : "";
  }
  for (const id of GUEST_SEEK_IDS) {
    el(id)?.classList.toggle("soc-guest-lock", locked);
  }
}

function fmtDrift(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `±${(Math.abs(ms) / 1000).toFixed(2)}s` : "—";
}

/// Paint every room surface from the reducer's state. Nothing here invents a
/// value: no room → placeholders; a room → the frames' own numbers.
function paintRoom() {
  const idle = room.role === "idle";
  paintRoomCode(room.code);

  const cell = el("jam-sidecar");
  const note = el("jam-sidecar-note");
  const open = el("btn-open-room");
  const join = el("btn-room-join");
  const copyInvite = el("btn-copy-invite");
  const copyQr = el("btn-qr-copy");

  if (cell) {
    cell.classList.remove("is-off", "is-ok");
    if (joining) {
      cell.textContent = "Connecting…";
    } else if (room.role === "host") {
      cell.textContent = roomPort ? `Listening on :${roomPort}` : "Listening";
      cell.classList.add("is-ok");
    } else if (room.role === "guest") {
      cell.textContent = "Joined";
      cell.classList.add("is-ok");
    } else {
      cell.textContent = "Not in a room";
      cell.classList.add("is-off");
    }
  }

  if (note) {
    if (room.error) {
      note.textContent = room.error;
    } else if (joining) {
      note.textContent = "Asking the host to let this device in…";
    } else if (guestMirror) {
      note.textContent = guestMirror;
    } else if (room.role === "host") {
      const share = inviteText(room);
      note.textContent = share
        ? `Guests join at ${share}.`
        : "Handing out the code…";
    } else if (room.role === "guest") {
      note.textContent = "Following the host's playhead; audio stays on this device.";
    } else {
      note.textContent = DEFAULT_ROOM_NOTE;
    }
  }

  if (open) {
    const canOpen = idle && !joining;
    open.disabled = !canOpen;
    open.title = canOpen ? "Start a room on this device" : "Leave the current room first";
  }
  if (join) {
    const canJoin = idle && !joining;
    join.disabled = !canJoin;
    join.title = canJoin ? "Join the room at that address" : "Leave the current room first";
  }
  const haveCode = !!room.code;
  if (copyInvite) {
    copyInvite.disabled = !haveCode;
    copyInvite.title = haveCode ? "Copy the invite line" : "Available once a room code exists";
  }
  if (copyQr) copyQr.disabled = !haveCode;

  // G1: the rate chip must tell the truth about the current surface. Idle it
  // IS local (sendChat echoes without IPC); in a room the line relays to
  // everyone, so the sidecar-era "LOCAL ONLY" copy would be a lie.
  const rateNote = el("chat-rate-note");
  if (rateNote) {
    if (idle) {
      rateNote.textContent = "LOCAL ONLY";
      rateNote.title = "No room open — messages stay on this device.";
    } else {
      rateNote.textContent = "5 / 10s";
      rateNote.title = "Room chat: up to 500 characters, 5 messages every 10 seconds.";
    }
  }

  const session = el("jam-session-mode");
  if (session) {
    session.textContent =
      room.role === "host"
        ? `Hosting${roomPort ? ` on port ${roomPort}` : ""}`
        : room.role === "guest"
          ? "Guest — following the host"
          : "Local room";
  }
  const mode = el("jam-mode-label");
  if (mode) mode.textContent = idle ? "Solo" : room.role === "host" ? "Host" : "Guest";

  const sync = el("jam-sync-value");
  if (sync) {
    const measured = room.role === "host" ? worstDriftMs(room) : lastDrift;
    sync.textContent = fmtDrift(measured);
    sync.classList.toggle("is-ok", typeof measured === "number");
    sync.classList.toggle("is-off", typeof measured !== "number");
  }

  const membersHost = el("jam-members");
  if (membersHost) {
    const list =
      room.members.length > 0
        ? room.members
        : [{ id: "self", name: "You", host: true }];
    membersHost.replaceChildren(...list.map(memberRow));
  }
  const membersNote = el("jam-members-note");
  if (membersNote) {
    const n = memberCount(room);
    membersNote.textContent = idle
      ? "1 (you) — no room is open on this device."
      : `${n} in the room${room.role === "guest" ? " · the host controls playback" : ""}.`;
  }

  setGuestLock(room.role === "guest");
  paintCounts();
  paintReactionNote();
}

// ------------------------------------------------------------------ frames -
function renderChat() {
  const list = el("chat-messages-container");
  if (!list) return;
  // G6: #chat-empty / #chat-typing live INSIDE this list — capture them
  // before the wipe and re-insert first, so the toggle below can still find
  // them on every render (they used to be destroyed by the first one).
  const empty = el("chat-empty");
  const typing = el("chat-typing");
  list.replaceChildren(...[empty, typing].filter(Boolean));
  if (empty) {
    // G1: honest copy for the surface's current role — same two strings
    // mobile paints (jam.js:575-577), so the shells cannot drift apart.
    empty.textContent =
      room.role === "idle"
        ? "No messages yet — open or join a room to chat."
        : "No messages yet. Say something.";
    empty.classList.toggle("hidden", room.chat.length > 0);
  }
  if (typing) typing.classList.add("hidden"); // no typing protocol exists
  for (const entry of room.chat) list.append(chatMessage(entry));
  list.scrollTop = list.scrollHeight;
}

/// One chat bubble. `entry` comes from the reducer: a `chat` frame (own echo
/// included) or this client's local echo when no room is open. Built with
/// createElement + textContent — never innerHTML (docs/social-nowplaying.md §3a).
function chatMessage(entry) {
  // F7: server-origin system line ("X joined" / "X left") — a centred line,
  // not a bubble: no avatar, no sender, textContent-only like everything else.
  if (entry.system) {
    const line = document.createElement("div");
    line.className = "soc-chat-system";
    line.textContent = entry.text;
    return line;
  }
  const mine = !!entry.mine;
  const msg = document.createElement("div");
  msg.className = mine ? "soc-chat-msg mine" : "soc-chat-msg";

  const avatar = document.createElement("span");
  avatar.className = "soc-chat-avatar";
  avatar.textContent = mine ? "YOU" : initialsOf(entry.from?.name);

  const bubble = document.createElement("div");
  bubble.className = "soc-chat-bubble";

  const meta = document.createElement("div");
  meta.className = "soc-chat-meta";
  const user = document.createElement("span");
  user.className = "soc-chat-user";
  user.textContent = mine ? "You" : entry.from?.name || "Guest";
  const time = document.createElement("span");
  time.className = "soc-chat-time";
  time.textContent = clockOf(entry.ts);
  meta.append(user, time);

  const body = document.createElement("div");
  body.className = "soc-chat-text";
  body.textContent = entry.text; // textContent, never innerHTML

  bubble.append(meta, body);
  msg.append(avatar, bubble);
  return msg;
}

function clockOf(ts) {
  const d = typeof ts === "number" && Number.isFinite(ts) ? new Date(ts) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/// Host: broadcast the authoritative playhead (§4.1/§6). No track → nothing to
/// say, and a guest never calls this (the command refuses with `not_host`).
function broadcastPlayback() {
  if (room.role !== "host") return;
  const snap = playerSnapshot();
  if (!snap.hasTrack || !snap.id) return;
  invoke("room_playback", {
    playing: !snap.paused,
    trackId: snap.id,
    title: snap.title || "",
    artist: snap.artist || "",
    positionMs: Math.max(0, Math.round((snap.position || 0) * 1000)),
  }).catch((e) => diag("room playback", false, String(e).slice(0, 160)));
}

function resetGuestRate() {
  try {
    if (audio) audio.playbackRate = 1;
  } catch {
    /* element gone */
  }
}

function startHostTick() {
  if (tickTimer) clearInterval(tickTimer);
  // N14: the interval's first fire is HOST_TICK_MS away — run once now so
  // open/join is not a quarter-second late on the wire.
  if (room.role === "host") broadcastPlayback();
  tickTimer = setInterval(() => {
    if (room.role !== "host") return;
    broadcastPlayback();
  }, HOST_TICK_MS);
}

function stopHostTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = 0;
  armedTick = "";
}

function syncRoomTick() {
  const next = roomTickKind(room.role);
  if (next === armedTick) return;
  if (next === "host") startHostTick();
  else if (next === "guest") startGuestTick();
  else stopHostTick();
  armedTick = next;
}

/// Guest: find the host's track in what this device already has. Same sources
/// as the room queue: play history, favourites, vault, plus the live queue.
function findLocalTrack(id) {
  if (!id) return null;
  const idx = queue.findIndex((q) => q.track && q.track.id === id);
  if (idx >= 0) return { track: queue[idx].track, index: idx };
  const hit = localTracks().find((t) => t.id === id);
  return hit ? { track: hit, index: -1 } : null;
}

async function followHostTrack(pb) {
  const found = findLocalTrack(pb.trackId);
  const wantKey = `${pb.at}:${pb.trackId}`;
  if (!found) {
    // Catalog fallback: the guest's own backend resolves the host's id even
    // when this device has never seen the track (fresh install, deep cut).
    // §4.5 still rules when the catalog refuses too: mirror, never pretend.
    let cat;
    try {
      cat = await resolveFromCatalog(pb, { invoke });
    } catch {
      cat = null;
    }
    // The host may have moved on while the resolve ran — apply only if this
    // frame is still the room's latest.
    const latest = room.playback;
    if (latest && `${latest.at}:${latest.trackId}` !== wantKey) return;
    if (cat && cat.track) {
      guestMirror = "";
      enqueue(cat.track);
      await playQueueItem(queue.length - 1);
      paintRoom();
      return;
    }
    // §4.5: mirror the host's metadata, never claim to be playing it.
    guestMirror = `Host is on “${pb.title || pb.trackId}” — not on this device.`;
    // D3: the sync this UI advertises stopped in this frame — drop the applied
    // frame and the drift that described a playhead we are no longer following.
    guestApplied = "";
    lastDrift = null;
    paintRoom();
    return;
  }
  guestMirror = "";
  if (found.index >= 0) {
    const snap = playerSnapshot();
    if (snap.id !== pb.trackId) await playQueueItem(found.index);
  } else {
    enqueue(found.track);
    await playQueueItem(queue.length - 1);
  }
  paintRoom();
}

/// Guest tick: apply the host's playhead, measure the drift, report it.
function guestTick() {
  if (room.role !== "guest" || !room.playback) return;
  const pb = room.playback;
  const snap = playerSnapshot();
  const key = `${pb.at}:${pb.trackId}:${pb.positionMs}:${pb.playing}`;
  if (snap.id !== pb.trackId) {
    // Resolve once per frame; the next tick measures the result.
    const applyKey = `follow:${key}`;
    if (guestApplied !== applyKey) {
      guestApplied = applyKey;
      followHostTrack(pb).catch((e) => diag("room follow", false, String(e).slice(0, 160)));
    }
    return;
  }

  // We are on the host's track, so the mirror note (if any) is false — D3.
  guestMirror = "";

  if (pb.playing && audio.paused) audio.play().catch(() => {});
  if (!pb.playing && !audio.paused) audio.pause();

  guestTickCount += 1;
  const { driftMs, seekToSec, playbackRate } = syncDecision(room, audio.currentTime);
  let seekApplied = false;
  if (seekToSec !== null) {
    audio.currentTime = seekToSec;
    seekApplied = true;
    diag("room sync", true, `seek ${seekToSec.toFixed(2)}s (drift ${driftMs}ms)`);
  }
  try {
    audio.playbackRate = pb.playing ? playbackRate : 1;
  } catch {
    /* rate not writable */
  }
  if (shouldReportDrift(driftMs, seekApplied, guestTickCount) && driftMs !== null) {
    lastDrift = driftMs;
    invoke("room_report", { driftMs }).catch(() => {});
  } else if (driftMs !== null) {
    lastDrift = driftMs;
  }
  paintRoom();
}

function startGuestTick() {
  if (tickTimer) clearInterval(tickTimer);
  guestTick();
  tickTimer = setInterval(guestTick, HOST_TICK_MS);
}

function cancelRejoin() {
  if (rejoinTimer) clearTimeout(rejoinTimer);
  rejoinTimer = 0;
}

function scheduleRejoin() {
  cancelRejoin();
  if (!shouldAutoRejoin(ROOM_LOST_REASON, lastJoinUri, userLeft, rejoinAttempts)) return;
  const delay = rejoinDelayMs(rejoinAttempts);
  rejoinAttempts += 1;
  rejoinTimer = setTimeout(() => {
    if (room.role !== "idle" || userLeft || !lastJoinUri) return;
    joining = true;
    setRoomNote("Reconnecting to the room…");
    paintRoom();
    invoke("room_join_uri", { uri: lastJoinUri, name: roomName("Guest") }).catch((e) => {
      joining = false;
      setRoomNote(String(e).slice(0, 200));
      scheduleRejoin();
    });
  }, delay);
}

/// Reduce one `room://msg` frame and drive the UI from the result. Frame
/// semantics are the frozen contract in docs/listen-together.md §6a.
function applyRoomFrame(frame) {
  if (!frame || typeof frame.t !== "string") return;
  // N12: a D2 `room_close` emits bye{left}. If we already joined (or hosted),
  // reducing that bye would idle a live room.
  if (frame.t === "bye" && isStaleLocalBye(frame.reason, userLeft, room.role)) return;
  room = reduceRoom(room, frame);
  setLocalRole(room.role);

  switch (frame.t) {
    case "refresh":
      // The server asks the host for a fresh playhead the moment someone
      // joins, so the newcomer never waits a full tick.
      broadcastPlayback();
      return;
    case "hosted":
    case "joined":
      joining = false;
      rejoinAttempts = 0;
      cancelRejoin();
      if (room.role === "host") resetGuestRate();
      setRoomNote(
        room.role === "host"
          ? `Room ${room.code} open — guests join with the code.`
          : `Joined room ${room.code}.`,
      );
      diag("room", true, `${room.role} ${room.code}`);
      // G5: `hosted` dropped any device-local echo in the reducer — repaint so
      // the cleared list reaches the DOM (mobile does this via paintJam).
      renderChat();
      break;
    case "history":
    case "chat":
      renderChat();
      break;
    case "playback":
      guestTick();
      break;
    case "presence":
      paintRoom();
      return;
    case "error": {
      const wasJoining = joining;
      joining = false;
      // Verbatim: the server's message is the diagnosis (§8).
      setRoomNote(frame.message || frame.code || "Room error.");
      toast(frame.message || String(frame.code || "Room error."), "error", 5000);
      // N10/N12/N13: dial-fail during an in-flight rejoin — guest_run already
      // reverted to Idle. Do not room_close (that emits bye{left} and cancels
      // the next dial). Terminal refusals still close the half-open guest.
      if (wasJoining && shouldRetryJoinAfterError(lastJoinUri, userLeft, rejoinAttempts, frame.code)) {
        scheduleRejoin();
      } else if (wasJoining) {
        lastJoinUri = "";
        cancelRejoin();
        invoke("room_close").catch(() => {});
      }
      break;
    }
    case "bye": {
      joining = false;
      stopHostTick();
      resetGuestRate();
      guestMirror = "";
      lastDrift = null;
      guestApplied = "";
      guestTickCount = 0;
      roomPort = 0;
      if (frame.reason && frame.reason !== "left") {
        toast(String(frame.reason), "info", 4000);
      }
      renderChat(); // the reducer emptied the room's chat
      if (shouldKeepRejoinAfterBye(frame.reason, userLeft, lastJoinUri, rejoinAttempts)) {
        break;
      }
      if (shouldAutoRejoin(frame.reason, lastJoinUri, userLeft, rejoinAttempts)) {
        scheduleRejoin();
      } else {
        lastJoinUri = "";
        cancelRejoin();
      }
      break;
    }
    default:
      return;
  }

  syncRoomTick();
  paintRoom();
}

function startRoomListener() {
  if (listenerReady) return;
  const listen = window.__TAURI__?.event?.listen;
  // No IPC (plain browser): leave the flag clear so a later call can retry
  // once `__TAURI__` exists. Setting it here would latch the listener off.
  if (typeof listen !== "function") return;
  listenerReady = true;
  listen("room://msg", (e) => applyRoomFrame(e.payload)).catch(() =>
    diag("room listener", false, "event.listen failed"),
  );
}

async function enterSocial() {
  startRoomListener();
  // A host room server can outlive the window (reload). Adopt it — do not
  // `room_close` a live host. A guest socket does not survive a reload.
  try {
    const info = await invoke("room_info");
    if (info && info.role === "host") {
      roomPort = Number(info.port) || 0;
      applyRoomFrame({
        t: "hosted",
        selfId: "host",
        code: info.code || "",
        urls: Array.isArray(info.urls) ? info.urls : [],
        invite: typeof info.invite === "string" ? info.invite : "",
        members: [{ id: "host", name: roomName("Host"), host: true }],
      });
      return;
    }
    if (info && info.role === "guest") await invoke("room_close");
  } catch {
    /* no IPC, or nothing to reconcile */
  }
  room = createRoomState();
  setLocalRole("");
  roomPort = 0;
  joining = false;
  lastDrift = null;
  guestMirror = "";
  guestApplied = "";
  guestTickCount = 0;
  lastJoinUri = "";
  userLeft = false;
  cancelRejoin();
  resetGuestRate();
  stopHostTick();
  paintRoom();
}

async function leaveRoom(note) {
  userLeft = true;
  cancelRejoin();
  lastJoinUri = "";
  stopHostTick();
  resetGuestRate();
  try {
    await invoke("room_close");
  } catch {
    /* nothing was open */
  }
  room = createRoomState();
  setLocalRole("");
  roomPort = 0;
  joining = false;
  lastDrift = null;
  guestMirror = "";
  guestApplied = "";
  guestTickCount = 0;
  setRoomNote(note || DEFAULT_ROOM_NOTE);
  paintRoom();
}

async function openRoom() {
  if (room.role !== "idle" || joining) return;
  userLeft = false;
  lastJoinUri = "";
  cancelRejoin();
  const name = roomName();
  try {
    const info = await invoke("room_open", { name });
    roomPort = Number(info?.port) || 0;
    applyRoomFrame({
      t: "hosted",
      // The server's own member row is always id "host" (room.rs RoomCore::new).
      selfId: "host",
      code: info?.code || "",
      urls: Array.isArray(info?.urls) ? info.urls : [],
      invite: typeof info?.invite === "string" ? info.invite : "",
      members: [{ id: "host", name, host: true }],
    });
  } catch (e) {
    setRoomNote(String(e).slice(0, 200));
    toast(String(e).slice(0, 160), "error", 5000);
  }
}

async function joinRoom() {
  if (room.role !== "idle" || joining) return;
  const uri = (el("room-join-invite")?.value || "").trim();
  if (!uri) {
    setRoomNote("Paste the host's invite link (an old address · code line works too).");
    return;
  }
  const parsed = parseInvite(uri);
  if (!parsed) {
    // Pre-validation for this inline message only — Rust is the authority
    // and will reject the same string again (docs/jam-upgrade.md §3.3).
    setRoomNote("That doesn't look like an invite link.");
    return;
  }
  joining = true;
  userLeft = false;
  lastJoinUri = uri;
  rejoinAttempts = 0;
  setRoomNote(`Connecting to ${parsed.addr}…`);
  paintRoom();
  try {
    // The outcome arrives as frames (`joined` / `error`), not as a return value.
    await invoke("room_join_uri", { uri, name: roomName("Guest") });
  } catch (e) {
    joining = false;
    lastJoinUri = "";
    setRoomNote(String(e).slice(0, 200));
    paintRoom();
  }
}

async function copyInvite() {
  const share = inviteText(room) || room.code;
  if (!share) return;
  try {
    await navigator.clipboard.writeText(share);
    toast(`Invite copied: ${share}`, "success", 2500);
    diag("room", true, "invite copied");
  } catch {
    toast(`Clipboard unavailable — the invite is ${share}.`, "info", 4000);
  }
}

const isSocial = () => document.body.classList.contains("soc-social");

// ------------------------------------------------------------- paint helpers -
function paintCounts() {
  const idle = room.role === "idle";
  const members = memberCount(room);
  const mine = idle ? `${members} (you)` : `${members} in the room`;
  const cells = [
    ["jam-vote-ratio", `${votes} / ${members}`],
    ["np-room-members", mine],
    ["qr-members-count", mine],
    ["jam-member-pill", String(members)],
    ["chat-online-count", `${members} online`],
  ];
  for (const [id, text] of cells) {
    const node = el(id);
    if (node) node.textContent = text;
  }
}

function paintReactionNote() {
  const note = $("#reaction-note");
  if (!note) return;
  const any = $$(".soc-reaction-pill").some(
    (pill) => Number(pill.querySelector(".soc-reaction-count")?.textContent || 0) > 0,
  );
  note.textContent = any ? "Your reactions — counts stay on this device." : "Be the first to react";
}

// ---------------------------------------------------------------------- mode -
function setActiveTab(tabId) {
  document.getElementById(tabId)?.click();
}

function setMode(social) {
  if (social === isSocial()) return;
  document.body.classList.toggle("soc-social", social);
  $("#btn-mode-solo")?.classList.toggle("active", !social);
  $("#btn-mode-social")?.classList.toggle("active", social);

  if (social) {
    diag("social mode", true, "social");
    enterSocial();
    return;
  }

  // The chat/jam tabs are social-only: a deck parked on one would go blank,
  // so fall back to a tab that still exists in Solo.
  const active = $(".np-deck-tab.active");
  if (active && (active.dataset.npTab === "chat" || active.dataset.npTab === "jam")) {
    setActiveTab("tab-btn-lyrics");
  }
  void leaveRoom(DEFAULT_ROOM_NOTE);
  votes = 0;
  closeQr();
  diag("social mode", true, "solo");
}

// ----------------------------------------------------------------- room QR -
// The symbol is encoded by Rust (`qr_symbol` in src-tauri/src/qr.rs) and painted
// by qrview.js. Until a room issues a real code there is nothing honest to
// encode, so the surface shows its empty state instead of a scannable-looking
// plate with nothing scannable in it — the lie this surface used to tell with a
// Material Symbols glyph.
//
// What it encodes is the **invite line the Copy button already hands out**
// (`inviteText`): `ws://<host>:<port> · <CODE>`, or the bare code while the
// address is not known yet. It used to encode the code alone, which left a
// guest who scanned it still hunting for the host's address by hand. This is
// *not* a `trancemusic://join` deep link — no such scheme exists, and inventing
// one would be a fabricated integration; it is the real, dialable string.
function paintQrSurface(code) {
  const canvas = $("#qr-canvas");
  const empty = $("#np-qr-empty");
  const note = $("#np-qr-note");
  if (!canvas) return;

  if (!code) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    empty?.classList.remove("hidden");
    if (note) {
      note.textContent =
        "Start a room from the Jam tab — the room server issues the code.";
    }
    return;
  }

  empty?.classList.add("hidden");
  if (note) {
    note.textContent =
      "Scan for this room's invite — address and code. Or copy it from the Jam tab.";
  }
  paintQr(canvas, code).catch((e) => {
    // Encoding failed: say so rather than leaving a blank white plate that
    // looks like a broken scanner.
    empty?.classList.remove("hidden");
    if (note) note.textContent = `Could not encode the code: ${String(e).slice(0, 120)}`;
    diag("room qr", false, String(e).slice(0, 160));
  });
}

function closeQr() {
  $("#qr-overlay")?.classList.add("hidden");
}

function toggleQr() {
  const overlay = $("#qr-overlay");
  if (!overlay) return;
  const opening = overlay.classList.contains("hidden");
  overlay.classList.toggle("hidden");
  // Repaint on open: the canvas is sized from layout, which is only known once
  // the surface is displayed.
  if (opening) paintQrSurface(inviteText(room) || room.code);
}

// ---------------------------------------------------------------- reactions -
function wireReactions() {
  for (const pill of $$(".soc-reaction-pill")) {
    pill.addEventListener("click", () => {
      const count = pill.querySelector(".soc-reaction-count");
      if (!count) return;
      const mine = pill.classList.toggle("active");
      const n = Math.max(0, Number(count.textContent || "0") + (mine ? 1 : -1));
      count.textContent = String(n);
      paintReactionNote();
    });
  }

  // Reactions belong to one track: a new title clears them rather than
  // carrying someone's 🔥 over to the next song. The same observer is the
  // host's track-change hook for the room (§4.1).
  const title = $("#track-title-heading");
  if (title) {
    new MutationObserver(() => {
      for (const pill of $$(".soc-reaction-pill")) {
        pill.classList.remove("active");
        const count = pill.querySelector(".soc-reaction-count");
        if (count) count.textContent = "0";
      }
      paintReactionNote();
      if (room.role === "host") broadcastPlayback();
    }).observe(title, { childList: true, characterData: true, subtree: true });
  }

  // The host's other two transport changes, straight from the element every
  // other module already listens to.
  for (const ev of ["play", "pause", "seeked", "ended"]) {
    audio.addEventListener(ev, () => {
      if (room.role === "host") broadcastPlayback();
    });
  }
}

// --------------------------------------------------------------------- chat -
function sendChat() {
  const input = $("#chat-input");
  const text = (input?.value || "").trim();
  if (!text) return;
  if (joining || rejoinTimer) {
    toast("Still connecting — wait to chat.", "info", 2500);
    return;
  }
  if (input) input.value = "";

  if (room.role === "host" || room.role === "guest") {
    // In a room the server relays the line and echoes it back, so the message
    // is drawn exactly once — from that frame (§5). A refusal (rate limit)
    // arrives as an `error` frame and is shown verbatim.
    invoke("room_chat", { text }).catch((e) => {
      toast(String(e).slice(0, 160), "error", 4000);
      if (input) input.value = text; // give the text back, don't lose it
    });
    return;
  }

  // Offline fallback, unchanged from Phase 3: this client echoes itself, and
  // the list is only ever painted from room.chat so the two paths cannot double up.
  room = reduceRoom({ ...room, selfId: "me" }, {
    t: "chat",
    from: { id: "me", name: "You" },
    text,
    ts: Date.now(),
  });
  renderChat();
}

function quoteLyric() {
  const input = $("#chat-input");
  const line = $(".lyric-line.active-line .lyric-text") || $(".lyric-line .lyric-text");
  if (!input || !line) {
    toast("No lyric line to quote yet.", "info", 2500);
    return;
  }
  const quote = `“${line.textContent.trim()}”`;
  input.value = input.value.trim() ? `${input.value.trim()} ${quote}` : quote;
  input.focus();
}

// ---------------------------------------------------------------- room queue -
function toggleQueueLock() {
  const btn = $("#btn-lock-queue");
  const badge = $("#queue-lock-badge");
  const input = $("#input-add-song");
  const submit = $("#btn-submit-song");
  const locked = !btn?.classList.contains("is-on");

  btn?.classList.toggle("is-on", locked);
  if (badge) {
    badge.textContent = locked ? "LOCKED" : "UNLOCKED";
    badge.classList.toggle("is-locked", locked);
  }
  if (input) input.disabled = locked;
  if (submit) submit.disabled = locked;
  if (btn) {
    const icon = btn.querySelector(".material-symbols-outlined");
    const label = btn.querySelector("span:last-child");
    if (icon) icon.textContent = locked ? "lock" : "lock_open";
    if (label) label.textContent = locked ? "Unlock" : "Lock";
  }
  toast(
    locked
      ? "Queue locked — nothing new can be added until you unlock it."
      : "Queue unlocked.",
    "info",
    3000,
  );
}

/// Everything this client can legitimately add to the room right now: what it
/// has already played, what it has favourited, what it has downloaded. New
/// tracks would need a server-side search, which the room protocol has not got.
function localTracks() {
  const out = [];
  try {
    out.push(...loadPlays());
  } catch {
    /* no play history yet */
  }
  try {
    out.push(...loadFavs());
  } catch {
    /* no favourites yet */
  }
  for (const entry of vaultEntries || []) {
    try {
      out.push(entryTrack(entry));
    } catch {
      /* skip an unreadable vault row */
    }
  }
  return out.filter((t) => t && t.id && t.title);
}

function addToRoom() {
  const input = $("#input-add-song");
  const query = (input?.value || "").trim();
  if (!query) return;

  const needle = query.toLowerCase();
  const hit = localTracks().find(
    (t) =>
      String(t.title).toLowerCase().includes(needle) ||
      String(t.artist || "").toLowerCase().includes(needle),
  );
  if (!hit) {
    toast(`No local match for "${query}" — finding new tracks needs a catalog search.`, "info", 5000);
    return;
  }

  const already = queue.some((q) => q.track?.id === hit.id);
  enqueue(hit);
  if (input) input.value = "";
  diag("room queue", true, already ? `duplicate ${hit.id}` : `enqueued ${hit.id}`);
  // A guest's queue is local: the room's queue has no protocol frame, so this
  // says "this device" rather than implying the host saw it (§8).
  const scope = room.role === "guest" ? "this device" : "the queue";
  toast(
    already
      ? `"${hit.title}" is already in ${scope}.`
      : `Added "${hit.title}" to ${scope}.`,
    "success",
    3500,
  );
}

// ---------------------------------------------------------------------- init -
export function initSocial() {
  $("#btn-mode-social")?.addEventListener("click", () => setMode(true));
  $("#btn-mode-solo")?.addEventListener("click", () => setMode(false));
  // The button says "Leave the room and return to Solo", so it leaves the mode
  // too: setMode(false) tears the room down through leaveRoom().
  $("#btn-leave-room")?.addEventListener("click", () => {
    setMode(false);
    toast("Left the room — back to Solo.", "info", 3000);
  });

  $("#btn-qr")?.addEventListener("click", toggleQr);
  $("#btn-qr-close")?.addEventListener("click", closeQr);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeQr();
  });

  $("#btn-open-room")?.addEventListener("click", () => void openRoom());
  $("#btn-room-join")?.addEventListener("click", () => void joinRoom());
  el("room-join-invite")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void joinRoom();
    }
  });
  $("#btn-copy-invite")?.addEventListener("click", () => void copyInvite());
  $("#btn-qr-copy")?.addEventListener("click", () => void copyInvite());

  $("#btn-chat-send")?.addEventListener("click", sendChat);
  $("#chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    }
  });
  $("#btn-chat-quote")?.addEventListener("click", quoteLyric);
  $("#btn-lock-queue")?.addEventListener("click", toggleQueueLock);
  $("#btn-submit-song")?.addEventListener("click", addToRoom);
  $("#input-add-song")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addToRoom();
    }
  });

  wireReactions();

  // Attach the room listener at boot, not on entering Social. `open_room` can
  // be reached without the mode switch (a restored session, a programmatic
  // open), and a room whose frames nobody hears is a UI frozen at "1 online".
  startRoomListener();

  // Boot state: no room, no code, nothing enabled that needs one.
  paintRoom();
  renderChat();
  diag("social", true, "boot: solo, no room");
}

// Test hook: the gates read this list to prove the markup and this module
// agree about which controls a guest may not use.
export const __roomLockIds = { disabled: GUEST_LOCK_IDS, seek: GUEST_SEEK_IDS };
