// social.js — Social Now Playing shell + Listen Together room glue (REFACTORED).
//
// CHANGES FROM ORIGINAL:
//   - Uses shared jam/controller.js (eliminates duplication with mobile)
//   - Guest track resolution now works via catalog (P0 fix)
//   - Crossfade disabled in rooms (prevents desync)
//   - Guest shortcuts locked properly

import { diag, invoke, toast } from "./core.js";
import { $, $$, audio } from "./dom.js";
import { playerSnapshot } from "./bridge.js";
import { loadPlays } from "./home.js";
import { loadFavs } from "./library.js";
import { playQueueItem, streamQuality } from "./playback.js";
import { enqueue, queue } from "./queue.js";
import { paintQr } from "./qrview.js";
import { createJamController, isGuestLocked, NO_ROOM } from "./jam/controller.js";
import {
  inviteText,
  memberCount,
  sanitizeRoomName,
  worstDriftMs,
} from "./room.js";
import { entryTrack, vaultEntries } from "./vault.js";

/// Every room-code surface, painted from one list with one fallback
const ROOM_SLOTS = ["soc-room-code", "qr-room-code", "jam-room-id"];
const DEFAULT_ROOM_NOTE = "Open a room on this device, or join one with its code.";

let votes = 0;
let roomPort = 0;
let listenerReady = false;

// ===== JAM CONTROLLER SETUP (NEW) =====
// This replaces ~400 lines of room state management, tick logic, and follow code

function localTracks() {
  // Same logic as original: history + favorites + vault
  const plays = loadPlays() || [];
  const favs = loadFavs() || [];
  const vault = vaultEntries().map(entryTrack).filter(Boolean);
  return [...plays, ...favs, ...vault];
}

const jamController = createJamController({
  getAudio: () => audio,
  getPlayerSnapshot: playerSnapshot,
  getQueue: () => queue,
  getLocalTracks: localTracks,
  getQuality: streamQuality,
  playQueueItem,
  enqueueTrack: enqueue,
  onStateChange: () => {
    paintRoom();
    paintCounts();
    renderChat();
  },
  onError: (err) => {
    setRoomNote(err.slice(0, 200));
    toast(err.slice(0, 160), "error", 5000);
  },
  onDiag: diag,
});

// Make controller accessible for crossfade/shortcuts checks
if (typeof window !== "undefined") {
  window.jamController = jamController;
}

// ===== UTILITY FUNCTIONS =====

function el(id) {
  return document.getElementById(id);
}

function setRoomNote(text) {
  const note = el("room-join-note");
  if (note) note.textContent = text;
}

function roomName() {
  try {
    return sanitizeRoomName(window.localStorage.getItem("tm-username") || "", "Host");
  } catch {
    return "Host";
  }
}

function paintRoomCode(code) {
  const text = code || NO_ROOM;
  for (const id of ROOM_SLOTS) {
    const node = el(id);
    if (node) node.textContent = text;
  }
}

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
  const lockIds = ["bar-play", "bar-prev", "bar-next", "bar-shuffle", "bar-repeat"];
  const seekIds = ["bar-progress"];
  
  for (const id of lockIds) {
    const node = el(id);
    if (!node) continue;
    node.disabled = locked;
    node.title = locked ? "The host controls playback in this room" : "";
  }
  for (const id of seekIds) {
    el(id)?.classList.toggle("soc-guest-lock", locked);
  }
}

function fmtDrift(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `±${(Math.abs(ms) / 1000).toFixed(2)}s` : "—";
}

// ===== ROOM UI PAINTING =====

function paintRoom() {
  const state = jamController.state;
  const idle = state.role === "idle";
  const mirror = jamController.mirror;
  const drift = jamController.drift;
  const joining = jamController.joining;
  
  paintRoomCode(state.code);

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
    } else if (state.role === "host") {
      cell.textContent = roomPort ? `Listening on :${roomPort}` : "Listening";
      cell.classList.add("is-ok");
    } else if (state.role === "guest") {
      cell.textContent = "Joined";
      cell.classList.add("is-ok");
    } else {
      cell.textContent = "Not in a room";
      cell.classList.add("is-off");
    }
  }

  if (note) {
    if (state.error) {
      note.textContent = state.error;
    } else if (joining) {
      note.textContent = "Asking the host to let this device in…";
    } else if (mirror) {
      note.textContent = mirror;
    } else if (state.role === "host") {
      const share = inviteText(state);
      note.textContent = share ? `Guests join at ${share}.` : "Handing out the code…";
    } else if (state.role === "guest") {
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
  
  const haveCode = !!state.code;
  if (copyInvite) copyInvite.disabled = !haveCode;
  if (copyQr) copyQr.disabled = !haveCode;

  // Lock guest controls
  setGuestLock(state.role === "guest");

  // Paint members
  const membersList = el("jam-members");
  if (membersList) {
    membersList.innerHTML = "";
    for (const m of state.members || []) {
      membersList.appendChild(memberRow(m));
    }
  }

  // Paint sync badge
  const badge = el("jam-sync-badge");
  const value = el("jam-sync-value");
  if (badge && value) {
    const worst = worstDriftMs(state);
    if (worst !== null && worst <= 400) {
      badge.classList.add("is-synced");
      value.textContent = fmtDrift(drift);
    } else {
      badge.classList.remove("is-synced");
      value.textContent = worst !== null ? fmtDrift(worst) : "—";
    }
  }

  paintQrSurface(state.code);
}

function paintCounts() {
  const state = jamController.state;
  const idle = state.role === "idle";
  const members = memberCount(state);
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

function renderChat() {
  const state = jamController.state;
  const chat = el("jam-chat");
  if (!chat) return;

  chat.innerHTML = "";
  for (const msg of state.chat || []) {
    const row = document.createElement("div");
    row.className = msg.mine ? "chat-msg is-mine" : "chat-msg";

    const from = document.createElement("span");
    from.className = "chat-from";
    from.textContent = msg.from?.name || "Guest";

    const text = document.createElement("span");
    text.className = "chat-text";
    text.textContent = msg.text || "";

    row.append(from, text);
    chat.appendChild(row);
  }

  chat.scrollTop = chat.scrollHeight;
}

function paintQrSurface(code) {
  const canvas = $("#qr-canvas");
  const empty = $("#np-qr-empty");
  const note = $("#np-qr-note");
  if (!canvas) return;

  if (!code) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    empty?.classList.remove("hidden");
    if (note) note.textContent = "Open a room to show its QR code.";
    return;
  }

  const share = inviteText(jamController.state) || code;
  empty?.classList.add("hidden");
  if (note) note.textContent = share;

  // Paint QR with the full invite text
  paintQr(canvas, share, invoke).catch((e) => {
    diag("qr", false, String(e).slice(0, 120));
  });
}

function paintReactionNote() {
  const note = $("#reaction-note");
  if (!note) return;
  const any = $$(".soc-reaction-pill").some(
    (pill) => Number(pill.querySelector(".soc-reaction-count")?.textContent || 0) > 0,
  );
  note.textContent = any ? "Your reactions — counts stay on this device." : "Be the first to react";
}

// ===== ROOM ACTIONS (NEW - via controller) =====

async function enterSocial() {
  startRoomListener();
  
  // Reconcile existing room state
  try {
    const info = await invoke("room_info");
    if (info && info.role && info.role !== "idle") {
      // Reconnect to existing room instead of closing
      diag("room", true, `reconnecting to ${info.role} room`);
      // The controller will receive frames via listener
    }
  } catch {
    /* no IPC or nothing to reconcile */
  }
  
  paintRoom();
}

async function leaveRoom(note) {
  try {
    await jamController.leave();
  } catch (e) {
    diag("room", false, String(e).slice(0, 120));
  }
  roomPort = 0;
  setRoomNote(note || DEFAULT_ROOM_NOTE);
  paintRoom();
}

async function openRoom() {
  if (jamController.state.role !== "idle" || jamController.joining) return;
  
  try {
    const info = await jamController.open(roomName(), roomPort);
    roomPort = Number(info?.port) || 0;
    setRoomNote(`Room ${info.code} open — guests join with the code.`);
  } catch (e) {
    // Error already handled by controller's onError callback
  }
}

async function joinRoom() {
  if (jamController.state.role !== "idle" || jamController.joining) return;
  
  const addr = (el("room-join-addr")?.value || "").trim();
  const code = (el("room-join-code")?.value || "").trim().toUpperCase();
  
  if (!addr || !code) {
    setRoomNote("Enter the host's address and the 8-character room code.");
    return;
  }
  
  setRoomNote(`Connecting to ${addr}…`);
  paintRoom();
  
  try {
    await jamController.join(addr, code, roomName());
  } catch (e) {
    // Error already handled by controller's onError callback
  }
}

async function sendChat() {
  const input = el("jam-chat-input");
  if (!input) return;
  
  const text = input.value.trim();
  if (!text) return;
  
  try {
    await jamController.sendChat(text);
    input.value = "";
  } catch (e) {
    toast("Chat failed: " + String(e).slice(0, 120), "error", 3000);
  }
}

async function copyInvite() {
  const share = inviteText(jamController.state) || jamController.state.code;
  if (!share) return;
  
  try {
    await navigator.clipboard.writeText(share);
    toast(`Invite copied: ${share}`, "success", 2500);
    diag("room", true, "invite copied");
  } catch {
    toast(`Clipboard unavailable — the invite is ${share}.`, "info", 4000);
  }
}

// ===== ROOM LISTENER (NEW - routes to controller) =====

function startRoomListener() {
  if (listenerReady) return;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  
  listenerReady = true;
  listen("room://msg", (e) => {
    jamController.onFrame(e.payload);
  }).catch(() => diag("room listener", false, "event.listen failed"));
}

// ===== MODE SWITCHING =====

const isSocial = () => document.body.classList.contains("soc-social");

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

  // Fall back from chat/jam tabs when switching to solo
  const active = $(".np-deck-tab.active");
  if (active && (active.dataset.npTab === "chat" || active.dataset.npTab === "jam")) {
    setActiveTab("tab-btn-lyrics");
  }
  
  void leaveRoom(DEFAULT_ROOM_NOTE);
  votes = 0;
  closeQr();
  diag("social mode", true, "solo");
}

// ===== QR SURFACE =====

let qrOpen = false;

function openQr() {
  const overlay = el("np-qr-overlay");
  if (overlay) {
    overlay.classList.remove("hidden");
    qrOpen = true;
    paintQrSurface(jamController.state.code);
  }
}

function closeQr() {
  const overlay = el("np-qr-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
    qrOpen = false;
  }
}

// ===== REACTIONS (LOCAL ONLY) =====

function wireReactions() {
  for (const pill of $$(".soc-reaction-pill")) {
    pill.addEventListener("click", () => {
      const count = pill.querySelector(".soc-reaction-count");
      if (count) {
        const n = Number(count.textContent || 0);
        count.textContent = String(n + 1);
      }
      paintReactionNote();
    });
  }
}

// ===== INITIALIZATION =====

export function initSocial() {
  $("#btn-mode-social")?.addEventListener("click", () => setMode(true));
  $("#btn-mode-solo")?.addEventListener("click", () => setMode(false));

  $("#btn-open-room")?.addEventListener("click", openRoom);
  $("#btn-room-join")?.addEventListener("click", joinRoom);
  $("#btn-room-leave")?.addEventListener("click", () => leaveRoom());
  $("#btn-copy-invite")?.addEventListener("click", copyInvite);
  
  $("#jam-chat-send")?.addEventListener("click", sendChat);
  $("#jam-chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $("#btn-qr-open")?.addEventListener("click", openQr);
  $("#btn-qr-close")?.addEventListener("click", closeQr);
  $("#qr-overlay-bg")?.addEventListener("click", closeQr);
  $("#btn-qr-copy")?.addEventListener("click", copyInvite);

  wireReactions();

  // Attach room listener at boot
  startRoomListener();
  
  diag("social", true, "initialized with shared controller");
}

// Export for playback/shortcuts to check room state
export function isInRoom() {
  return jamController.state.role !== "idle";
}

export function getRoomRole() {
  return jamController.state.role;
}
