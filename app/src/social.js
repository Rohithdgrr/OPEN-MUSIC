// social.js — Social Now Playing shell (Phase 3 + 4a glue).
// Local state, plus a thin mirror of sidecar.js into the Jam/QR/header slots:
// this module opens no sockets of its own (the bridge lives in sidecar.js),
// and every count, message and vote it shows is either produced by this
// client or decoded from a server frame — see docs/social-nowplaying.md §6
// (truthfulness rules) and docs/sidecar.md §5.
import { diag, toast } from "./core.js";
import { $, $$, audio } from "./dom.js";
import { loadPlays } from "./home.js";
import { loadFavs } from "./library.js";
import { enqueue, queue } from "./queue.js";
import { createSidecar, readPort, STATUS } from "./sidecar.js";
import { step } from "./transport.js";
import { entryTrack, vaultEntries } from "./vault.js";

// A room of one until the local sidecar connects: the member count, the vote
// denominator and the "online" chip are all derived from this constant, so
// they can never drift into claiming an audience that is not there.
const MEMBERS = 1;
const GRACE_SECS = 3;

let votes = 0;
let graceTimer = 0;

// --------------------------------------------------------------- sidecar glue -
// The connection itself lives in sidecar.js (DOM-free, unit-tested there);
// this section only mirrors its state into the Jam pane, the QR overlay and
// the header room chip. Nothing is enabled or shown before the server's own
// frame has proved it (docs/sidecar.md §5).
const ROOM_SLOTS = ["soc-room-code", "qr-room-code", "jam-room-id"];
const DEFAULT_SIDECAR_NOTE = "Local 127.0.0.1 process; ships unbundled.";

let sidecar = null;
let paintedRoom = "";

function paintRoomCode(code) {
  const text = code || "NO ROOM";
  for (const id of ROOM_SLOTS) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

function paintSidecarState(s) {
  const cell = $("#jam-sidecar");
  const note = $("#jam-sidecar-note");
  const open = $("#btn-open-room");
  const copyInvite = $("#btn-copy-invite");
  const copyQr = $("#btn-qr-copy");

  paintRoomCode(s.roomCode);

  if (note) {
    note.textContent = s.message || DEFAULT_SIDECAR_NOTE;
  }
  if (open) {
    // Offered only while a real handshake is done and no room exists yet.
    open.disabled = s.status !== STATUS.CONNECTED || !!s.roomCode;
    open.title = s.status === STATUS.CONNECTED ? "Ask the sidecar for a room code" : "Connect the local sidecar first";
  }
  const haveCode = !!s.roomCode;
  if (copyInvite) {
    copyInvite.disabled = !haveCode;
    copyInvite.title = haveCode ? "Copy the room code to the clipboard" : "Available once a room code exists";
  }
  if (copyQr) copyQr.disabled = !haveCode;

  if (cell) {
    cell.classList.remove("is-off", "is-ok");
    let text;
    switch (s.status) {
      case STATUS.PROBING:
        text = "Probing…";
        cell.classList.add("is-off");
        break;
      case STATUS.OFFLINE:
      case STATUS.IDLE:
        text = "Not connected";
        cell.classList.add("is-off");
        break;
      case STATUS.CONNECTING:
      case STATUS.HANDSHAKING:
        text = "Connecting…";
        break;
      case STATUS.CONNECTED:
        text = s.serverVersion ? `Connected (v${s.serverVersion})` : "Connected";
        cell.classList.add("is-ok");
        break;
      case STATUS.ROOM:
        text = "Connected";
        cell.classList.add("is-ok");
        break;
      case STATUS.ERROR:
        text = `Error: ${s.errorCode || "failed"}`;
        cell.classList.add("is-off");
        break;
      default:
        text = "Not connected";
        cell.classList.add("is-off");
    }
    cell.textContent = text;
  }

  if (s.roomCode && s.roomCode !== paintedRoom) {
    paintedRoom = s.roomCode;
    toast(`Room ${s.roomCode} open — share the code with someone on this server.`, "success", 5000);
    diag("sidecar", true, `room ${s.roomCode}`);
  } else if (!s.roomCode) {
    paintedRoom = "";
  }
}

async function startSidecar() {
  if (sidecar) return;
  const ua = $("#jam-ua");
  // The server's default policy allow-lists User-Agents, so we print ours
  // verbatim for the operator to paste into ua_policy.json (docs/sidecar.md
  // §4.5). Display only — this app never alters its own UA.
  if (ua) ua.textContent = `This client's UA: ${navigator.userAgent}`;

  sidecar = createSidecar({
    port: readPort(window.localStorage),
    onChange: paintSidecarState,
  });
  paintSidecarState(sidecar.state);
  const up = await sidecar.probe();
  if (up && isSocial()) sidecar.connect();
}

function stopSidecar() {
  if (!sidecar) return;
  sidecar.stop();
  sidecar = null;
  paintSidecarState({
    status: STATUS.IDLE,
    message: DEFAULT_SIDECAR_NOTE,
    roomCode: "",
    errorCode: "",
    serverVersion: "",
  });
}

function openRoom() {
  if (!sidecar) return;
  const name = (() => {
    try {
      return window.localStorage.getItem("tm-username") || "You";
    } catch {
      return "You";
    }
  })();
  const res = sidecar.createRoom(name);
  if (!res.ok) {
    toast("Connect the local sidecar before opening a room.", "info", 3500);
  }
}

async function copyInvite() {
  const code = sidecar && sidecar.state.roomCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Room code ${code} copied.`, "success", 2500);
    diag("sidecar", true, "invite copied");
  } catch {
    toast(`Clipboard unavailable — the room code is ${code}.`, "info", 4000);
  }
}

const isSocial = () => document.body.classList.contains("soc-social");

// ------------------------------------------------------------- paint helpers -
function paintCounts() {
  const cells = [
    ["skip-vote-label", `Skip (${votes}/${MEMBERS})`],
    ["jam-vote-ratio", `${votes} / ${MEMBERS}`],
    ["np-room-members", `${MEMBERS} (you)`],
    ["qr-members-count", `${MEMBERS} (you)`],
    ["jam-member-pill", String(MEMBERS)],
    ["chat-online-count", `${MEMBERS} online`],
  ];
  for (const [id, text] of cells) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

function paintReactionNote() {
  const note = $("#reaction-note");
  if (!note) return;
  const any = $$(".soc-reaction-pill").some(
    (pill) => Number(pill.querySelector(".soc-reaction-count")?.textContent || 0) > 0,
  );
  note.textContent = any
    ? "Your reactions — counts stay local until the sidecar runs."
    : "Be the first to react";
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
    toast(
      `Social mode — local room for ${MEMBERS} (you). Probing the sidecar on 127.0.0.1 …`,
      "info",
    );
    diag("social mode", true, "social");
    startSidecar();
    return;
  }

  // The chat/jam tabs are social-only: a deck parked on one would go blank,
  // so fall back to a tab that still exists in Solo.
  const active = $(".np-deck-tab.active");
  if (active && (active.dataset.npTab === "chat" || active.dataset.npTab === "jam")) {
    setActiveTab("tab-btn-lyrics");
  }
  stopSidecar();
  resetVotes();
  closeQr();
  hideGrace();
  diag("social mode", true, "solo");
}

// ----------------------------------------------------------------- room QR -
function closeQr() {
  $("#qr-overlay")?.classList.add("hidden");
}

function toggleQr() {
  $("#qr-overlay")?.classList.toggle("hidden");
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
  // carrying someone's 🔥 over to the next song.
  const title = $("#track-title-heading");
  if (title) {
    new MutationObserver(() => {
      for (const pill of $$(".soc-reaction-pill")) {
        pill.classList.remove("active");
        const count = pill.querySelector(".soc-reaction-count");
        if (count) count.textContent = "0";
      }
      paintReactionNote();
    }).observe(title, { childList: true, characterData: true, subtree: true });
  }
}

// ---------------------------------------------------------------- skip vote -
function resetVotes() {
  votes = 0;
  $("#btn-skip-vote")?.classList.remove("is-done");
  paintCounts();
}

function castVote() {
  if (votes >= MEMBERS) return;
  votes += 1;
  $("#btn-skip-vote")?.classList.add("is-done");
  paintCounts();
  if (votes >= MEMBERS) {
    // Room of one: your own vote is already a majority, so the track advances
    // and the tally resets for the next song.
    setTimeout(() => {
      step(1);
      resetVotes();
    }, 200);
  }
}

// ------------------------------------------------------------ grace window -
function hideGrace() {
  if (graceTimer) clearInterval(graceTimer);
  graceTimer = 0;
  $("#soc-grace")?.classList.add("hidden");
}

function showGrace() {
  if (!isSocial()) return;
  const pill = $("#soc-grace");
  const timer = $("#grace-timer");
  if (!pill || !timer) return;
  if (graceTimer) clearInterval(graceTimer);
  pill.classList.remove("hidden");
  let left = GRACE_SECS;
  timer.textContent = `${left}s`;
  graceTimer = setInterval(() => {
    left -= 1;
    timer.textContent = left > 0 ? `${left}s` : "—";
    if (left <= 0) hideGrace();
  }, 1000);
}

// --------------------------------------------------------------------- chat -
function chatTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sendChat() {
  const input = $("#chat-input");
  const list = $("#chat-messages-container");
  const text = (input?.value || "").trim();
  if (!text || !list) return;

  $("#chat-empty")?.classList.add("hidden");

  const msg = document.createElement("div");
  msg.className = "soc-chat-msg mine";

  const avatar = document.createElement("span");
  avatar.className = "soc-chat-avatar";
  avatar.textContent = "YOU";

  const bubble = document.createElement("div");
  bubble.className = "soc-chat-bubble";

  const meta = document.createElement("div");
  meta.className = "soc-chat-meta";
  const user = document.createElement("span");
  user.className = "soc-chat-user";
  user.textContent = "You";
  const time = document.createElement("span");
  time.className = "soc-chat-time";
  time.textContent = chatTime();
  meta.append(user, time);

  const body = document.createElement("div");
  body.className = "soc-chat-text";
  body.textContent = text; // textContent, never innerHTML: no markup from the composer

  bubble.append(meta, body);
  msg.append(avatar, bubble);
  list.append(msg);
  list.scrollTop = list.scrollHeight;
  input.value = "";
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
/// tracks would need the sidecar's search, which does not exist yet.
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
    toast(`No local match for "${query}" — finding new tracks needs the local sidecar.`, "info", 5000);
    return;
  }

  const already = queue.some((q) => q.track?.id === hit.id);
  enqueue(hit);
  if (input) input.value = "";
  diag("room queue", true, already ? `duplicate ${hit.id}` : `enqueued ${hit.id}`);
  toast(
    already
      ? `"${hit.title}" is already in the room queue.`
      : `Added "${hit.title}" to the room queue (local).`,
    "success",
    3500,
  );
}

// ---------------------------------------------------------------------- init -
export function initSocial() {
  $("#btn-mode-social")?.addEventListener("click", () => setMode(true));
  $("#btn-mode-solo")?.addEventListener("click", () => setMode(false));
  $("#btn-activate-social")?.addEventListener("click", () => setMode(true));
  $("#btn-leave-room")?.addEventListener("click", () => {
    setMode(false);
    toast("Left the room — back to Solo.", "info", 3000);
  });

  $("#btn-qr")?.addEventListener("click", toggleQr);
  $("#btn-qr-close")?.addEventListener("click", closeQr);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeQr();
  });

  $("#btn-open-room")?.addEventListener("click", openRoom);
  $("#btn-copy-invite")?.addEventListener("click", copyInvite);
  $("#btn-qr-copy")?.addEventListener("click", copyInvite);
  paintSidecarState({
    status: STATUS.IDLE,
    message: DEFAULT_SIDECAR_NOTE,
    roomCode: "",
    errorCode: "",
    serverVersion: "",
  });

  $("#btn-skip-vote")?.addEventListener("click", castVote);
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
  audio.addEventListener("pause", showGrace);
  audio.addEventListener("play", hideGrace);

  paintCounts();
  paintReactionNote();
  diag("social", true, `boot: solo, ${MEMBERS} member`);
}
