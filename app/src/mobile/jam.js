// jam.js — mobile Listen Together layer: Solo ↔ Social Jam mode, room chrome,
// chat and the host/guest transport rules.
//
// Spec: docs/listen-together.md §12 (mobile surface) + §13.2 (as shipped).
// This module is the mobile twin of the desktop `app/src/social.js` glue: it
// calls the same seven `room_*` Tauri commands, reduces the same `room://msg`
// frames through the same pure reducer (`app/src/room.js`), and opens no socket
// of its own — both sockets live in Rust (app/src-tauri/src/room.rs).
//
// Why a module and not a screen script: `screens/*.js` are **classic** scripts
// the router re-appends on every navigation, so they cannot `import`. This one
// is loaded once by app.js and rebinds to the fresh DOM on each `smount`
// (listen-together.md §13.2, ROOM.md D-8).
//
// Truthfulness (§8) is enforced by construction: every value painted below
// comes from a `room_*` return value, a `room://msg` frame, or the local player
// — never from the design export's placeholders.
/* global switchTab */
// switchTab is defined by the generated `screens/nowplaying.js`, which the
// router loads as a classic script — it is the tab switcher the tab buttons
// call, so this module moves the deck with the same function.
import { FAVS_KEY, invoke, load, PLAYS_KEY, toast } from "./shared.js";
import { paintQr } from "../qrview.js";
import { onPaint, playerState, playList, queueHistory, queueUpNext, repaint, seek, toggle } from "./player.js";
import {
  createRoomState,
  inviteText,
  memberCount,
  parseInvite,
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
  shouldStartFollow,
  HOST_TICK_MS,
  ROOM_LOST_REASON,
  worstDriftMs,
} from "../room.js";
import { resolveFromCatalog } from "../jam/follow.js";
import { startScanner } from "./scanner.js";

let room = createRoomState();
let joining = false;
let listenerReady = false;
let tickTimer = 0;
let appliedFrames = 0; // real `playback` frames applied this session
let lastDrift = null; // this device's own measured drift, ms
let mirrorNote = ""; // the host's track is not on this device (§4.5)
let chatUnread = 0; // chat lines arrived while the chat view was hidden (§5)
let followBusyFor = ""; // track id with a follow attempt in flight (§4.6)
let followBusyAt = 0; // when that attempt started (30 s expiry backstop)
let hostKey = "";
let guestTickCount = 0;
let lastJoinUri = "";
let userLeft = false;
let rejoinTimer = 0;
let rejoinAttempts = 0;
let armedTick = "";

const el = (id) => document.getElementById(id);

// Social chrome = the room tabs/banner are on screen. It stays true while a
// room is being started or joined, so the tabs never flicker mid-handshake.
let socialChrome = false;

// ------------------------------------------------------------------- sheets -
/// One small bottom sheet. Rows are real actions only — there are no
/// decorative options here, and every callback closes the sheet first.
function sheet(title, rows) {
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 z-[70] flex items-end justify-center";

  const scrim = document.createElement("div");
  scrim.className = "absolute inset-0 bg-black/40 backdrop-blur-sm";
  scrim.addEventListener("click", () => wrap.remove());

  const card = document.createElement("div");
  card.className = "relative w-full max-w-md mx-auto bg-surface-container-lowest border-t border-outline-variant/30 rounded-t-2xl p-4 flex flex-col gap-2 pb-safe shadow-xl";

  const head = document.createElement("div");
  head.className = "font-headline-sm text-[15px] font-semibold text-on-surface px-0.5 pb-1";
  head.textContent = title;
  card.append(head);

  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = row.primary
      ? "w-full py-2.5 rounded-xl bg-primary text-on-primary font-label-md text-[12px] font-semibold active:scale-[0.98] transition-transform"
      : "w-full py-2.5 rounded-xl bg-surface-container-low border border-outline-variant/30 text-on-surface font-label-md text-[12px] font-semibold active:scale-[0.98] transition-transform";
    btn.textContent = row.label;
    btn.addEventListener("click", () => {
      wrap.remove();
      row.run();
    });
    card.append(btn);
  }

  wrap.append(scrim, card);
  document.body.append(wrap);
  return wrap;
}

/// Ask for the host's invite link — one pasted string: the canonical
/// `trancemusic://join?…` or a legacy `ws://ip:port · CODE` line (§12, A).
function promptJoin() {
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 z-[70] flex items-end justify-center";
  const scrim = document.createElement("div");
  scrim.className = "absolute inset-0 bg-black/40 backdrop-blur-sm";
  scrim.addEventListener("click", () => wrap.remove());

  const card = document.createElement("div");
  card.className = "relative w-full max-w-md mx-auto bg-surface-container-lowest border-t border-outline-variant/30 rounded-t-2xl p-4 flex flex-col gap-3 pb-safe shadow-xl";
  card.innerHTML =
    '<div class="font-headline-sm text-[15px] font-semibold text-on-surface px-0.5">Join a Jam</div>' +
    '<div class="flex flex-col gap-2">' +
    '<input id="jam-join-invite" type="text" autocomplete="off" spellcheck="false" placeholder="Paste the invite — trancemusic://join?…" class="w-full px-3 py-2 rounded-xl bg-surface-container-low border border-outline-variant/30 font-body-sm text-[12px] text-on-surface placeholder:text-secondary focus:outline-none" />' +
    '<button type="button" id="jam-scan-btn" class="w-full py-2 rounded-xl bg-surface-container-low border border-outline-variant/30 text-on-surface font-label-md text-[12px] font-semibold">Scan QR — point at the host\u2019s code</button>' +
    '<p class="text-[10px] font-label-sm text-secondary px-0.5" id="jam-join-note">Same Wi-Fi as the host. Their invite link is on the Jam Data tab — an old address · code line still works.</p>' +
    "</div>" +
    '<div class="flex items-center gap-2">' +
    '<button type="button" id="jam-join-cancel" class="flex-1 py-2.5 rounded-xl bg-surface-container-low border border-outline-variant/30 text-on-surface font-label-md text-[12px] font-semibold">Cancel</button>' +
    '<button type="button" id="jam-join-go" class="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-label-md text-[12px] font-semibold">Join</button>' +
    "</div>";
  wrap.append(scrim, card);
  document.body.append(wrap);

  const invite = card.querySelector("#jam-join-invite");
  const note = card.querySelector("#jam-join-note");
  card.querySelector("#jam-join-cancel").addEventListener("click", () => wrap.remove());

  // Live pre-validation for the inline message only — Rust is the authority
  // and rejects the same string again (docs/jam-upgrade.md §3.3).
  invite.addEventListener("input", () => {
    const value = invite.value.trim();
    note.textContent = !value
      ? "Same Wi-Fi as the host. Paste their invite link."
      : parseInvite(value)
        ? "Invite read — tap Join."
        : "That doesn't look like an invite link.";
  });

  card.querySelector("#jam-scan-btn").addEventListener("click", () => openScanner(wrap, invite));

  card.querySelector("#jam-join-go").addEventListener("click", () => {
    const uri = invite.value.trim();
    if (!parseInvite(uri)) {
      note.textContent = "That doesn't look like an invite link.";
      return;
    }
    wrap.remove();
    void joinRoom(uri);
  });
}

/// B-T2: camera sheet layered over the join sheet. A decoded invite fills
/// the paste field and joins through the exact same `room_join_uri` path a
/// paste uses; every camera failure (permission denied, no camera, missing
/// decoder) drops back to the paste field — never a dead end (§4.1).
function openScanner(joinWrap, inviteInput) {
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 z-[80] flex items-center justify-center";
  wrap.innerHTML =
    '<div class="absolute inset-0 bg-black/70" id="jam-scan-scrim"></div>' +
    '<div class="relative w-[86vw] max-w-sm flex flex-col gap-3 items-center px-4">' +
    '<div class="w-full aspect-[3/4] rounded-2xl overflow-hidden bg-black border border-outline-variant/30">' +
    '<video id="jam-scanner-video" class="w-full h-full object-cover" playsinline muted></video>' +
    "</div>" +
    '<p id="jam-scanner-status" class="min-h-[16px] text-[11px] font-body-sm text-secondary text-center">Starting camera…</p>' +
    '<button type="button" id="jam-scanner-cancel" class="w-full py-2.5 rounded-xl bg-surface-container-low border border-outline-variant/30 text-on-surface font-label-md text-[12px] font-semibold">Cancel</button>' +
    "</div>";
  const canvas = document.createElement("canvas"); // frame grab — never in the DOM
  document.body.append(wrap);

  const video = wrap.querySelector("#jam-scanner-video");
  const statusEl = wrap.querySelector("#jam-scanner-status");
  const setNote = (text) => {
    if (statusEl.isConnected) statusEl.textContent = text;
  };
  // `handle` is assigned AFTER startScanner returns, but `decoder-missing`
  // fires synchronously inside it — so close() must not assume the real
  // handle exists yet (the initial no-op stop is correct for that path).
  let handle = { stop: () => {} };
  const close = () => {
    handle.stop();
    wrap.remove();
  };

  handle = startScanner({
    video,
    canvas,
    onStatus: (s) => {
      if (s.type === "starting") setNote("Starting camera…");
      else if (s.type === "live") setNote("Point at the host's invite QR.");
      else if (s.type === "decoded") setNote("Invite found.");
      else if (s.type === "denied") {
        toast("Camera permission denied — paste the invite instead.", 4000, "error");
        close();
      } else if (s.type === "nocamera") {
        toast("No camera available — paste the invite instead.", 4000, "error");
        close();
      } else if (s.type === "decoder-missing") {
        toast("Scanner unavailable — paste the invite instead.", 4000, "error");
        close();
      } else {
        toast(String(s.detail || "Camera failed — paste the invite instead.").slice(0, 160), 4000, "error");
        close();
      }
    },
    onScan: ({ uri }) => {
      inviteInput.value = uri;
      wrap.remove();
      joinWrap.remove();
      void joinRoom(uri);
    },
  });

  wrap.querySelector("#jam-scan-scrim").addEventListener("click", close);
  wrap.querySelector("#jam-scanner-cancel").addEventListener("click", close);
}

// -------------------------------------------------------------------- mode --
function roomName(fallback = "Guest") {
  try {
    return roomDisplayName((k) => localStorage.getItem(k), fallback);
  } catch {
    return fallback;
  }
}

export function setSocial(on) {
  socialChrome = on;
  paintJam();
  if (!on) void leaveRoom();
}

function openModeSheet() {
  if (room.role !== "idle") {
    sheet(`Jam room ${room.code}`, [
      { label: "Copy invite", run: () => void copyInvite() },
      { label: "Leave the Jam", run: () => void leaveRoom(true), primary: true },
    ]);
    return;
  }
  sheet(socialChrome ? "Jam session" : "Listen together", [
    { label: "Start a Jam (host this device)", run: () => void startRoom(), primary: true },
    { label: "Join a Jam with a code", run: () => promptJoin() },
    { label: socialChrome ? "Back to Solo" : "Stay Solo", run: () => setSocial(false) },
  ]);
}

async function startRoom() {
  if (room.role !== "idle" || joining) return;
  userLeft = false;
  lastJoinUri = "";
  cancelRejoin();
  socialChrome = true;
  paintJam();
  const name = roomName("Host");
  try {
    const info = await invoke("room_open", { name });
    applyFrame({
      t: "hosted",
      selfId: "host", // the server's own member row is always id "host"
      code: (info && info.code) || "",
      urls: Array.isArray(info && info.urls) ? info.urls : [],
      invite: (info && info.invite) || "",
      members: [{ id: "host", name, host: true }],
    });
    toast(`Room ${room.code} open — share the code with someone on this network.`, 5000, "success");
    broadcastQueue(); // share the up-next list with whoever joins (§4.7)
  } catch (e) {
    socialChrome = false;
    toast(String(e).slice(0, 160), 5000, "error");
    paintJam();
  }
}

async function joinRoom(uri) {
  if (room.role !== "idle" || joining) return;
  userLeft = false;
  lastJoinUri = uri;
  rejoinAttempts = 0;
  socialChrome = true;
  joining = true;
  paintJam();
  try {
    // The outcome arrives as frames (`joined` / `error`), not as a return value.
    await invoke("room_join_uri", { uri, name: roomName() });
  } catch (e) {
    joining = false;
    lastJoinUri = "";
    socialChrome = false;
    toast(String(e).slice(0, 160), 5000, "error");
    paintJam();
  }
}

async function leaveRoom(announce) {
  userLeft = true;
  cancelRejoin();
  lastJoinUri = "";
  stopTick();
  resetGuestRate();
  try {
    await invoke("room_close");
  } catch {
    /* nothing was open */
  }
  room = createRoomState();
  setLocalRole("");
  socialChrome = false;
  joining = false;
  appliedFrames = 0;
  lastDrift = null;
  guestTickCount = 0;
  mirrorNote = "";
  followBusyFor = "";
  followBusyAt = 0;
  hostKey = "";
  clearChatUnread();
  paintSharedQueue();
  if (announce) toast("Left the Jam — back to Solo", 3000);
  paintJam();
}

async function copyInvite() {
  const share = inviteText(room) || room.code;
  if (!share) {
    toast("No room to invite anyone to", 3000, "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(share);
    toast(`Invite copied: ${share}`, 3500, "success");
  } catch {
    toast(`Clipboard unavailable — the invite is ${share}`, 5000, "error");
  }
}

// ------------------------------------------------------------------ frames --
function applyFrame(frame) {
  if (!frame || typeof frame.t !== "string") return;
  if (frame.t === "bye" && isStaleLocalBye(frame.reason, userLeft, room.role)) return;
  room = reduceRoom(room, frame);
  setLocalRole(room.role);

  switch (frame.t) {
    case "refresh":
      // The host is asked for a fresh playhead the moment someone joins, so a
      // newcomer never waits a full tick (§4.1).
      broadcastPlayback();
      broadcastQueue();
      return;
    case "hosted":
    case "joined":
      joining = false;
      socialChrome = true;
      rejoinAttempts = 0;
      cancelRejoin();
      clearChatUnread();
      paintSharedQueue();
      if (room.role === "guest") toast(`Joined room ${room.code}`, 3500, "success");
      break;
    case "playback":
      // The count that drives "Synchronized" is incremented inside guestApply,
      // and only for a frame this guest could actually follow: a host's own
      // echo (ignored by the reducer) or a track this device does not have are
      // not sync (docs/listen-together.md §12).
      guestApply();
      break;
    case "chat":
    case "history":
      noteChatArrived(frame);
      paintChat();
      break;
    case "queue":
      paintSharedQueue();
      paintJam();
      break;
    case "presence":
      paintJam();
      return;
    case "error": {
      const wasJoining = joining;
      joining = false;
      // Verbatim (§8): the server's own words are the diagnosis.
      toast(frame.message || String(frame.code || "Room error"), 5000, "error");
      if (room.role === "idle") socialChrome = false;
      if (wasJoining && shouldRetryJoinAfterError(lastJoinUri, userLeft, rejoinAttempts, frame.code)) {
        socialChrome = true;
        scheduleRejoin();
      } else if (wasJoining) {
        lastJoinUri = "";
        cancelRejoin();
        invoke("room_close").catch(() => {});
      }
      break;
    }
    case "bye":
      joining = false;
      resetGuestRate();
      if (frame.reason && frame.reason !== "left") toast(String(frame.reason), 4000);
      if (room.role === "idle") socialChrome = false;
      appliedFrames = 0;
      followBusyFor = "";
      followBusyAt = 0;
      guestTickCount = 0;
      clearChatUnread();
      paintSharedQueue();
      stopTick();
      if (shouldKeepRejoinAfterBye(frame.reason, userLeft, lastJoinUri, rejoinAttempts)) {
        socialChrome = true;
        break;
      }
      if (shouldAutoRejoin(frame.reason, lastJoinUri, userLeft, rejoinAttempts)) {
        socialChrome = true;
        scheduleRejoin();
      } else {
        lastJoinUri = "";
        cancelRejoin();
      }
      break;
    default:
      return;
  }

  syncRoomTick();
  paintJam();
}

// ------------------------------------------------------------------- ticks --
function startTick(fn) {
  if (tickTimer) clearInterval(tickTimer);
  fn();
  tickTimer = setInterval(fn, HOST_TICK_MS);
}

function syncRoomTick() {
  const next = roomTickKind(room.role);
  if (next === armedTick) return;
  if (next === "host") startTick(hostTick);
  else if (next === "guest") startTick(guestTick);
  else stopTick();
  armedTick = next;
}

function resetGuestRate() {
  const audio = el("audio");
  try {
    if (audio) audio.playbackRate = 1;
  } catch {
    /* element gone */
  }
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
    socialChrome = true;
    paintJam();
    invoke("room_join_uri", { uri: lastJoinUri, name: roomName() }).catch((e) => {
      joining = false;
      toast(String(e).slice(0, 160), 5000, "error");
      scheduleRejoin();
    });
  }, delay);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = 0;
  armedTick = "";
}

function broadcastPlayback() {
  if (room.role !== "host") return;
  const st = playerState();
  const t = st.track;
  if (!t || !t.id) return;
  hostKey = `${t.id}|${st.paused ? "paused" : "playing"}`;
  invoke("room_playback", {
    playing: !st.paused,
    trackId: t.id,
    title: t.title || "",
    artist: t.artist || "",
    positionMs: Math.max(0, Math.round((st.pos || 0) * 1000)),
  }).catch(() => {});
}

/// Host heartbeat every HOST_TICK_MS, including while paused (N9). D4's
/// play/pause/seeked listeners still fire immediately; this is the belt
/// so a missed pause cannot leave guests playing.
function hostTick() {
  if (room.role !== "host") return;
  broadcastPlayback();
}

function guestTick() {
  if (room.role !== "guest" || !room.playback) return;
  guestApply();
}

function guestApply() {
  if (room.role !== "guest" || !room.playback) return;
  const pb = room.playback;
  const st = playerState();
  const currentId = st.track ? st.track.id : "";

  if (pb.trackId && pb.trackId !== currentId) {
    // §4.6: one in-flight attempt per track id — `at` changes every tick
    // while a resolve takes seconds, so keying on the frame re-fired every
    // 250 ms and stacked concurrent resolves.
    if (shouldStartFollow(followBusyFor, followBusyAt, pb.trackId)) {
      followBusyFor = pb.trackId;
      followBusyAt = Date.now();
      void followGuest(pb);
    }
    return;
  }
  followBusyFor = ""; // on the host's track — re-arm for the next one
  followBusyAt = 0;

  // We are on the host's track, so "not on this device" is false — §8 says the
  // note must go even though the resolve that would have cleared it (D3) never
  // runs on this path.
  mirrorNote = "";

  if (pb.playing && st.paused) toggle();
  else if (!pb.playing && !st.paused) toggle();

  // This frame is being applied to the one local playhead — that is what the
  // "Synchronized" badge claims, and the only thing that may set it.
  appliedFrames += 1;

  guestTickCount += 1;
  const { driftMs, seekToSec, playbackRate } = syncDecision(room, st.pos || 0);
  let seekApplied = false;
  if (seekToSec !== null) {
    seek(seekToSec);
    seekApplied = true;
  }
  const audio = el("audio");
  try {
    if (audio) audio.playbackRate = pb.playing ? playbackRate : 1;
  } catch {
    /* rate not writable */
  }
  if (shouldReportDrift(driftMs, seekApplied, guestTickCount) && driftMs !== null) {
    lastDrift = driftMs;
    invoke("room_report", { driftMs }).catch(() => {});
  } else if (driftMs !== null) {
    lastDrift = driftMs;
  }
  paintJam();
}

/// Guest track resolution (§12 M1, D1): the host's id is matched against the
/// live queue first (history, current, up-next), then against the same extra
/// sources the desktop `social.js:328 findLocalTrack()` falls back to — play
/// history, favourites and the offline vault. Only a genuine miss mirrors the
/// metadata and says so; never claim to be playing it (§4.5).
///
/// The vault is asked for over IPC rather than read from `tm-vault-ids`,
/// because that key stores **ids only** while the Rust ledger's rows carry the
/// real `id/title/artist/image/duration_secs` a queue entry needs.
/// `t.id && t.title` is the desktop's own filter, so id-only rows can never be
/// handed to `playList`.
async function followGuest(pb) {
  const st = playerState();
  const list = [
    ...queueHistory(),
    ...(st.track ? [st.track] : []),
    ...queueUpNext(),
  ];
  let idx = list.findIndex((t) => t && t.id && String(t.id) === String(pb.trackId));
  if (idx < 0) {
    const extras = [...load(PLAYS_KEY, []), ...load(FAVS_KEY, [])];
    try {
      if (invoke) {
        const vault = await invoke("list_downloads");
        extras.push(...((vault && vault.entries) || []));
      }
    } catch {
      /* offline or no vault: the other two sources still count */
    }
    const hit = extras.find((t) => t && t.id && t.title && String(t.id) === String(pb.trackId));
    if (hit) {
      list.push(hit);
      idx = list.length - 1;
    }
  }
  if (idx < 0) {
    // Catalog fallback: this phone's own backend resolves the host's id even
    // for a track the device has never queued, played, liked or downloaded.
    let cat;
    try {
      cat = await resolveFromCatalog(pb, { invoke });
    } catch {
      cat = null;
    }
    // The host may have moved on while the resolve ran — play only if this
    // frame is still the room's latest.
    const latest = room.playback;
    if (latest && String(latest.trackId) !== String(pb.trackId)) cat = null;
    if (cat && cat.track) {
      list.push(cat.track);
      idx = list.length - 1;
    }
  }
  if (idx < 0) {
    mirrorNote = `Host is on “${pb.title || pb.trackId}” — not on this device`;
    // D3: the sync this badge claims is over in the same frame it stops — the
    // last drift described a playhead we are no longer following.
    appliedFrames = 0;
    lastDrift = null;
    paintJam();
    return;
  }
  mirrorNote = "";
  playList(list, idx);
  paintJam();
}

// -------------------------------------------------------------------- paint -
function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase() || "??";
}

function fmtDrift(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `±${(Math.abs(ms) / 1000).toFixed(2)}s` : "—";
}

function setText(id, text) {
  const node = el(id);
  if (node && node.textContent !== text) node.textContent = text;
}

/// Show/hide with an explicit display class. Tailwind's `.hidden` and `.flex`
/// are both `display` declarations, so which one wins depends on the order the
/// CLI emitted them — toggling both is the only unambiguous way.
function show(node, on, display) {
  if (!node) return;
  node.classList.toggle("hidden", !on);
  if (display) node.classList.toggle(display, on);
}

/// The mobile controls a guest may not use: the host's playhead is the only
/// source of truth, and one page cannot have two.
const GUEST_LOCK = ["master-play-pause", "shuffle-btn", "repeat-btn"];

function applyGuestLock(locked) {
  for (const id of GUEST_LOCK) {
    const node = el(id);
    if (node) node.disabled = locked;
  }
  // The lock note lives under the transport row (docs/listen-together.md §12).
  document.querySelectorAll('[aria-label="Previous"], [aria-label="Next"]').forEach((node) => {
    node.disabled = locked;
  });
  const sc = el("scrubber-container");
  if (sc) {
    sc.style.pointerEvents = locked ? "none" : "";
    sc.style.opacity = locked ? "0.55" : "";
  }
  show(el("jamTransportNote"), locked);

}

function paintMembers() {
  const list = el("jamMembersList");
  const tpl = el("jamMemberRow");
  const avatars = el("jamBannerMembers");
  const members = room.members.length ? room.members : [{ id: "self", name: "You", host: true }];

  if (list && tpl) {
    list.replaceChildren();
    for (const m of members) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      const avatar = row.children[0];
      const nameWrap = row.children[1];
      const badge = row.children[2];
      if (avatar) avatar.textContent = m.host ? "YOU" : initialsOf(m.name);
      if (nameWrap && nameWrap.children[0]) nameWrap.children[0].textContent = m.name || "Guest";
      if (nameWrap && nameWrap.children[1]) {
        nameWrap.children[1].textContent = typeof m.driftMs === "number" ? fmtDrift(m.driftMs) : "—";
      }
      if (badge) badge.textContent = m.host ? "HOST" : "GUEST";
      list.append(row);
    }
  }

  if (avatars) {
    avatars.replaceChildren();
    for (const m of members.slice(0, 3)) {
      const dot = document.createElement("div");
      dot.className = "w-4 h-4 rounded-full bg-primary flex items-center justify-center ring-1 ring-surface shadow-xs";
      const span = document.createElement("span");
      span.className = "font-label-sm text-[7px] text-on-primary font-medium";
      span.textContent = m.host ? "YOU" : initialsOf(m.name);
      dot.append(span);
      avatars.append(dot);
    }
  }
}

/// §5 visibility: the Chat tab is not the default tab, so a line arriving
/// while the user looks elsewhere must surface — count it on the tab pill
/// and teach the way with one toast. Own echoes, history replay, and lines
/// arriving while the view is open never count.
function paintUnread() {
  const pill = el("jamChatUnread");
  if (!pill) return;
  pill.textContent = chatUnread > 0 ? String(chatUnread) : "";
  pill.hidden = chatUnread === 0;
}

function clearChatUnread() {
  if (chatUnread === 0) return;
  chatUnread = 0;
  paintUnread();
}

function noteChatArrived(frame) {
  if (!frame || frame.t !== "chat") return;
  if (frame.from && frame.from.id && frame.from.id === room.selfId) return;
  if (!el("view-chat")?.classList.contains("hidden")) return;
  chatUnread += 1;
  paintUnread();
  const text = String(frame.text || "").slice(0, 80);
  const who = frame.system ? "" : `${frame.from?.name || "Guest"}: `;
  toast(`💬 ${who}${text}`, 4000);
}

function paintChat() {
  paintUnread();
  const list = el("jamChatList");
  if (!list) return;
  list.replaceChildren();
  if (room.chat.length === 0) {
    const empty = document.createElement("p");
    empty.className = "text-[11px] font-body-sm text-secondary text-center py-2";
    empty.textContent = room.role === "idle"
      ? "No messages yet — open or join a room to chat."
      : "No messages yet. Say something.";
    list.append(empty);
    return;
  }
  for (const entry of room.chat) {
    // F7: server-origin system line ("X joined" / "X left") — a centred
    // line, not a bubble. The `chat-system` class is also the probe's hook.
    if (entry.system) {
      const line = document.createElement("div");
      line.className =
        "chat-system text-[10px] font-mono text-secondary text-center py-1";
      line.textContent = entry.text; // textContent, never innerHTML
      list.append(line);
      continue;
    }
    const row = document.createElement("div");
    row.className = entry.mine ? "flex items-end gap-2 flex-row-reverse" : "flex items-end gap-2";

    const avatar = document.createElement("div");
    avatar.className = entry.mine
      ? "w-6 h-6 rounded-full bg-primary text-on-primary text-[9px] font-mono font-bold flex items-center justify-center shadow-xs shrink-0 mb-0.5"
      : "w-6 h-6 rounded-full bg-surface-container-high border border-outline-variant/30 text-on-surface text-[9px] font-mono font-bold flex items-center justify-center shrink-0 mb-0.5";
    avatar.textContent = entry.mine ? "YOU" : initialsOf(entry.from && entry.from.name);

    const bubble = document.createElement("div");
    bubble.className = entry.mine
      ? "flex flex-col bg-primary text-on-primary px-3 py-1.5 rounded-2xl rounded-br-xs max-w-[85%] shadow-xs"
      : "flex flex-col bg-surface-container-low dark:bg-surface-container border border-outline-variant/30 px-3 py-1.5 rounded-2xl rounded-bl-xs max-w-[85%] shadow-xs";

    const who = document.createElement("span");
    who.className = entry.mine ? "font-label-sm text-[8px] text-white/70 font-medium" : "font-label-sm text-[8px] text-secondary font-medium";
    who.textContent = entry.mine ? "You" : (entry.from && entry.from.name) || "Guest";

    const text = document.createElement("span");
    text.className = entry.mine
      ? "font-body-sm text-[12px] text-white leading-relaxed whitespace-pre-wrap break-words"
      : "font-body-sm text-[12px] text-on-surface leading-relaxed whitespace-pre-wrap break-words";
    text.textContent = entry.text; // textContent, never innerHTML

    bubble.append(who, text);
    row.append(avatar, bubble);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

/// The room QR (feature-list §10 P1-2): the identical invite string the
/// Copy button hands out, rasterised by the shared qrview.js (one Rust
/// encoder, one rasterizer — `paintQr` takes this shell's invoke so core.js
/// never loads here). paintJam runs on every frame, so repaint only when the
/// invite actually changes; a failed paint clears the tag to retry.
let qrPainted = "";
let qrCanvas = null;
function paintQrSurface(share) {
  try {
    const canvas = el("jamQr");
    if (!canvas) return;
    const note = el("jamQrNote");
    if (!share) {
      if (note) note.textContent = "Start a room — a guest can scan the invite here.";
      if (qrPainted !== "") {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        qrPainted = "";
        qrCanvas = null;
      }
      return;
    }
    // Repaint when the invite changes OR the canvas is a fresh element (the
    // router rebuilds the screen from its template on remount).
    if (share === qrPainted && qrCanvas === canvas) return;
    qrPainted = share;
    qrCanvas = canvas;
    if (note) note.textContent = "Scan to join — the same invite the Copy button shares.";
    void paintQr(canvas, share, invoke).catch(() => {
      qrPainted = "";
      qrCanvas = null;
    });
  } catch {}
}

/// Paint everything the mobile screen shows. Null-safe: a room can stay open
/// while the user is on another screen, and then there is nothing to paint.
function paintJam() {
  const st = playerState();
  const inRoom = room.role !== "idle";
  const social = inRoom || socialChrome;

  // Header: the mode toggle is the only entry point to the jam sheet.
  setText("headerSubtitle", social ? "PLAYING FROM JAM" : "PLAYING FROM PLAYLIST");
  setText("headerTitle", st.track && st.track.title ? st.track.title : "Not playing");
  const dot = el("headerModeDot");
  if (dot) {
    dot.className = social
      ? "w-1.5 h-1.5 rounded-full bg-on-tertiary-container animate-pulse shrink-0 inline-block"
      : "w-1.5 h-1.5 rounded-full bg-secondary shrink-0 hidden";
  }
  const soloTab = el("modeSoloTab");
  const socialTab = el("modeSocialTab");
  if (soloTab && socialTab) {
    if (social) {
      soloTab.className = "px-3.5 py-1 rounded-full font-label-md text-[11px] font-semibold transition-all duration-200 text-secondary hover:text-on-surface active:scale-95";
      soloTab.setAttribute("aria-selected", "false");
      socialTab.className = "px-3.5 py-1 rounded-full font-label-md text-[11px] font-semibold transition-all duration-200 bg-primary text-on-primary shadow-xs active:scale-95 flex items-center gap-1.5";
      socialTab.setAttribute("aria-selected", "true");
    } else {
      soloTab.className = "px-3.5 py-1 rounded-full font-label-md text-[11px] font-semibold transition-all duration-200 bg-primary text-on-primary shadow-xs active:scale-95";
      soloTab.setAttribute("aria-selected", "true");
      socialTab.className = "px-3.5 py-1 rounded-full font-label-md text-[11px] font-semibold transition-all duration-200 text-secondary hover:text-on-surface active:scale-95 flex items-center gap-1.5";
      socialTab.setAttribute("aria-selected", "false");
    }
  }

  show(el("jamSessionBanner"), social, "flex");
  setText("jamBannerCode", inRoom ? `#${room.code}` : "NO ROOM");
  setText("jamBannerCount", String(memberCount(room)));
  setText(
    "jamBannerDrift",
    fmtDrift(room.role === "host" ? worstDriftMs(room) : lastDrift),
  );

  setText("artworkCollabTag", !social
    ? "SOLO"
    : mirrorNote
      ? "NOT ON THIS DEVICE"
      : room.role === "host"
        ? "ROOM QUEUE"
        : "FOLLOWING HOST");

  // The queue tab is local — except for a guest with the host's snapshot,
  // which answers "what plays next" with the room's truth (§4.7).
  const shared = room.role === "guest" && room.hostQueue.length > 0;
  setText("queueTabLabel", !social ? "Queue" : room.role === "guest" ? (shared ? "Host Queue" : "Local Queue") : "Room Queue");
  setText("queueHeaderLabel", !social ? "Queue" : room.role === "guest" ? (shared ? "HOST'S QUEUE · READ-ONLY" : "PERSONAL QUEUE") : "ROOM QUEUE");
  // "Synchronized" only after a real playback frame was received and applied.
  show(el("queueSyncBadge"), appliedFrames > 0, "flex");

  // Chat and Jam Data are social-only; a Solo deck must not offer them.
  show(el("chatTabBtn"), social, "flex");
  show(el("jamDataTabBtn"), social, "flex");
  setText("jamChatState", inRoom ? `${memberCount(room)} in room` : "No room");
  if (!social) {
    const active = document.querySelector(".tab-btn.bg-primary");
    if (active && (active.getAttribute("data-tab") === "chat" || active.getAttribute("data-tab") === "jam-data")) {
      switchTab("queue");
    }
  }

  // Jam Data: real role, real code, real invite, measured drift, real members.
  setText("jamRoomTitle", inRoom ? `Jam Room #${room.code}` : "No room");
  setText("jamRoleBadge", room.role === "host" ? "HOST" : room.role === "guest" ? "GUEST" : "SOLO");
  const invite = inviteText(room);
  setText("jamInviteUri", invite || (inRoom ? "Invite unavailable — code only" : "Not in a room"));
  const inviteCopy = el("jamInviteCopy");
  if (inviteCopy) inviteCopy.disabled = !inRoom;
  paintQrSurface(invite || (inRoom ? room.code : ""));
  setText("jamMemberValue", inRoom ? `${memberCount(room)} in room` : "1 (you)");
  // Artwork telemetry ROOM cell (desktop `.np-art-info-item` parity): the
  // count comes from the reducer, "1 (you)" is the honest Solo value.
  setText("np-room-members", inRoom ? `${memberCount(room)} (you)` : "1 (you)");
  setText("jamDriftValue", fmtDrift(room.role === "host" ? worstDriftMs(room) : lastDrift));

  applyGuestLock(room.role === "guest");
  paintMembers();
  paintChat();
}

// --------------------------------------------------------------------- wire -
function wireControls() {
  const toggleBtn = el("modeToggleBtn");
  if (toggleBtn && !toggleBtn.dataset.jamWired) {
    toggleBtn.dataset.jamWired = "1";
    toggleBtn.addEventListener("click", (e) => {
      // If clicking directly on modeToggleBtn container rather than buttons:
      if (e.target === toggleBtn) openModeSheet();
    });
  }

  const soloTab = el("modeSoloTab");
  if (soloTab && !soloTab.dataset.jamWired) {
    soloTab.dataset.jamWired = "1";
    soloTab.addEventListener("click", (e) => {
      e.stopPropagation();
      setSocial(false);
    });
  }

  const socialTab = el("modeSocialTab");
  if (socialTab && !socialTab.dataset.jamWired) {
    socialTab.dataset.jamWired = "1";
    socialTab.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!socialChrome && room.role === "idle") {
        setSocial(true);
        if (typeof switchTab === "function") switchTab("jam-data");
      } else if (room.role !== "idle") {
        if (typeof switchTab === "function") switchTab("jam-data");
      } else {
        openModeSheet();
      }
    });
  }

  for (const id of ["copyUriBtn", "jamInviteCopy"]) {
    const btn = el(id);
    if (btn && !btn.dataset.jamWired) {
      btn.dataset.jamWired = "1";
      btn.addEventListener("click", () => void copyInvite());
    }
  }

  const leave = el("jamLeaveBtn");
  if (leave && !leave.dataset.jamWired) {
    leave.dataset.jamWired = "1";
    leave.addEventListener("click", () => void leaveRoom(true));
  }
  const end = el("jamEndBtn");
  if (end && !end.dataset.jamWired) {
    end.dataset.jamWired = "1";
    end.addEventListener("click", () => void leaveRoom(true));
  }

  const send = el("jamChatSend");
  if (send && !send.dataset.jamWired) {
    send.dataset.jamWired = "1";
    send.addEventListener("click", sendChat);
  }
  // Opening the Chat tab means the count served its purpose — clear it. A
  // second listener alongside the screen's tab switcher is fine; both run.
  const chatTab = el("chatTabBtn");
  if (chatTab && !chatTab.dataset.jamUnreadWired) {
    chatTab.dataset.jamUnreadWired = "1";
    chatTab.addEventListener("click", clearChatUnread);
  }
  const input = el("jamChatInput");
  if (input && !input.dataset.jamWired) {
    input.dataset.jamWired = "1";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendChat();
      }
    });
  }

  // Quick reaction buttons in room chat
  const reactBtns = document.querySelectorAll("#jamChatReactions .chat-react-btn");
  reactBtns.forEach((btn) => {
    if (!btn.dataset.jamWired) {
      btn.dataset.jamWired = "1";
      btn.addEventListener("click", () => {
        const text = btn.dataset.react || btn.textContent.trim();
        sendChatText(text);
      });
    }
  });
}

function sendChatText(text, restore) {
  text = (text || "").trim();
  if (!text) return;
  if (joining || rejoinTimer) {
    if (restore) {
      const input = el("jamChatInput");
      if (input) input.value = restore;
    }
    toast("Still connecting — wait to chat.", 2500);
    return;
  }
  if (room.role === "idle") {
    room = reduceRoom({ ...room, selfId: "me" }, {
      t: "chat",
      from: { id: "me", name: "You" },
      text,
      ts: Date.now(),
    });
    paintChat();
    toast("Not in a room — the message stayed on this device", 3500);
    return;
  }
  invoke("room_chat", { text }).catch((e) => {
    // G2: desktop gives the text back on a refusal (social.js:768-771) —
    // the typed line must not vanish because the server said no. Reaction
    // buttons pass no restore: their text never came from the input.
    if (restore) {
      const input = el("jamChatInput");
      if (input) input.value = restore;
    }
    toast(String(e).slice(0, 160), 5000, "error");
  });
}

function sendChat() {
  const input = el("jamChatInput");
  const text = (input && input.value ? input.value : "").trim();
  if (!text) return;
  clearChatUnread(); // sending means looking — the count is stale now
  if (input) input.value = "";
  sendChatText(text, text);
}

/// §4.7: the host's up-next snapshot (current track excluded — `playback`
/// already carries it). The mobile queue has no edit UI in a room (the
/// append row ships disabled), so track changes + open + refresh cover it.
function broadcastQueue() {
  if (room.role !== "host") return;
  const tracks = queueUpNext()
    .slice(0, 10)
    .map((t) => ({ id: t?.id || "", title: t?.title || "", artist: t?.artist || "" }))
    .filter((t) => t.id);
  invoke("room_queue", { tracks }).catch(() => {});
}

/// Push the shared queue into the up-next painter's view. The painter lives
/// in binders.js (concurrently edited) — this window slot is the seam, so
/// neither module imports the other. Guests see the host's list; everyone
/// else sees their own (empty slot = local view).
function paintSharedQueue() {
  try {
    window.__hostQueueView = room.role === "guest" ? room.hostQueue : [];
  } catch {
    /* node test graph — no window */
  }
}

/// D4: the desktop host's `play`/`pause`/`seeked` listeners
/// (`social.js:702-706`) ported to the shell `<audio>`. The reordered tick
/// already reaches guests within 1 s; these make it immediate and, unlike the
/// tick, they also carry a **seek made while paused** — a paused playhead does
/// not move, so no drift check can ever notice that one.
/// Wired once: the element belongs to the shell (`#audio`), not to the screen
/// template the router rebuilds.
function wireHostAudio() {
  const audio = el("audio");
  if (!audio || audio.dataset.jamHostWired) return;
  audio.dataset.jamHostWired = "1";
  for (const ev of ["play", "pause", "seeked", "ended"]) {
    audio.addEventListener(ev, () => {
      if (room.role === "host") broadcastPlayback();
    });
  }
}

function mountJam() {
  wireControls();
  wireHostAudio();
  paintJam();
  repaint();
}

/// Called once by app.js. Everything else is event-driven: `smount` for the
/// fresh screen DOM, `onPaint` for player state, `room://msg` for the room.
export function initJam() {
  document.addEventListener("smount", (e) => {
    if (e.detail && e.detail.dir === "nowplaying") mountJam();
  });
  onPaint(() => {
    paintJam();
    if (room.role === "host") {
      const st = playerState();
      const t = st.track;
      const key = t && t.id ? `${t.id}|${st.paused ? "paused" : "playing"}` : "";
      if (key && key !== hostKey) {
        broadcastPlayback();
        broadcastQueue(); // the track changed, so did up-next (§4.7)
      }
    }
  });

  // The NowPlaying screen may already be up (deep link): bind to that DOM now,
  // and to every later mount through the `smount` handler above.
  if (!listenerReady) {
    listenerReady = true;
    if (el("modeToggleBtn")) mountJam();
  }

  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  if (typeof listen === "function") {
    listen("room://msg", (e) => applyFrame(e.payload)).catch(() => {});
    // A room can outlive the window: adopt what this device already has rather
    // than offering to open a second one.
    invoke("room_info")
      .then((info) => {
        if (!info || !info.role || info.role === "idle") return;
        if (info.role === "guest") {
          // A guest socket does not survive a reload, so nothing to adopt.
          return invoke("room_close");
        }
        applyFrame({
          t: "hosted",
          selfId: "host",
          code: info.code || "",
          urls: Array.isArray(info.urls) ? info.urls : [],
          invite: info.invite || "",
          members: [{ id: "host", name: roomName("Host"), host: true }],
        });
        toast(`Room ${room.code} is running on this device`, 4000, "success");
      })
      .catch(() => {});
  }

  paintJam();
}

// Exported for the gate: the tick cadence is the number the docs promise
// (C-5: a state frame on every change + 250 ms while playing).
export const JAM_TICK_MS = HOST_TICK_MS;
