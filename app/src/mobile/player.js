// player.js — one shared <audio> for every mobile screen: queue, resolve, transport.
import { invoke, pushPlay, toast, hqArt, LOGO, isVaulted, relayUrl, haptic, prefetchTrackBytes } from "./shared.js";
// Namespace import for forward-compatible helpers (effectiveStreamQuality,
// isExplicitTrack, explicitHidden, eqPreset, normalizeOn) which may not exist
// in shared.js yet. A static named import of a missing export would fail the
// whole module at link time, so access via the namespace object with guarded
// optional calls instead — player never crashes when the export hasn't landed.
import * as sharedHelpers from "./shared.js";
import { netMode } from "./net.js";
import { ensureReco } from "./radio.js";

// Every transport element loads media from the relay (`http://127.0.0.1:port`) —
// a different origin from the page (`http://tauri.localhost`). Before the EQ
// chain routes it through a MediaElementAudioSourceNode the load must be
// CORS-clean, or the graph outputs silence while the element "plays" (P36).
// Set at boot, kept at every swap. (The relay reflects the app origin; both
// sides of that contract live in proxy.rs auth_middleware.)
const transport = document.getElementById("audio");
if (transport) transport.crossOrigin = "anonymous";

// `audio` is a live binding (screens import it): the gapless/crossfade
// engine swaps which element is audible by reassigning it, and every reader
// (playerState, mediaSession handlers, lyrics clock) follows automatically.
// `standby` preloads the next track so the handoff has zero gap.
let audio = document.getElementById("audio");
let standby = null;
// Full scale: the media element is a limiter (max 1.0), so anything less only
// quietens playback — loudness belongs to the device/OS volume, not here.
function baseVol() {
  try {
    // Read the raw string first: `Number(null)` is 0 and `Number.isFinite(0)`
    // is true, so parsing a missing key directly would return 0 and mute a
    // fresh install (songs list fine, playback is silent).
    const raw = localStorage.getItem("tm-mobile-vol");
    if (raw != null && raw !== "") {
      const vol = Number(raw);
      if (Number.isFinite(vol)) return Math.min(1, Math.max(0, vol));
    }
  } catch {}
  return 1;
}
if (audio) audio.volume = baseVol();

let queue = [];
let qi = -1;
let shuffle = false;
let repeat = 0;
let badge = "IDLE";
let seq = 0;

const painters = [];

export function onPaint(fn) {
  painters.push(fn);
}

// ------------------------------------------------------------- media session
// Lock-screen / notification transport. Android's WebView surfaces these once
// metadata + action handlers exist; position state keeps the seek bar honest.
const msSupported = typeof navigator !== "undefined" && "mediaSession" in navigator;

function mediaMeta(track) {
  if (!msSupported || !track) return;
  // No artwork → the brand mark. An empty artwork array leaves Android's
  // media notification showing a grey placeholder instead of anything ours.
  // Lock-screen/notification surfaces need absolute URLs — a relative /art
  // path renders as a broken image in the system media card.
  const abs = (s) => {
    try {
      return new URL(s, document.baseURI).href;
    } catch {
      return s;
    }
  };
  const art = track.image
    ? [
        { src: abs(hqArt(track.image, "500x500")), sizes: "500x500", type: "image/jpeg" },
        { src: abs(hqArt(track.image, "150x150")), sizes: "150x150", type: "image/jpeg" },
      ]
    : [{ src: abs(LOGO), sizes: "512x512", type: "image/png" }];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "",
      artist: track.artist || track.subtitle || "",
      album: track.album || "",
      artwork: art,
    });
  } catch {}
}

function mediaState() {
  if (!msSupported) return;
  try {
    navigator.mediaSession.playbackState = audio && !audio.paused ? "playing" : "paused";
    const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
    const pos = audio ? Math.min(audio.currentTime || 0, dur ?? Number.MAX_SAFE_INTEGER) : 0;
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: pos,
      playbackRate: audio && audio.playbackRate ? audio.playbackRate : 1,
    });
  } catch {}
}

function mediaHandlers() {
  if (!msSupported) return;
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  };
  set("play", () => {
    if (audio) audio.play().catch(() => {});
  });
  set("pause", () => {
    if (audio) audio.pause();
  });
  set("stop", () => {
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {}
    }
  });
  set("previoustrack", () => prev());
  set("nexttrack", () => next());
  set("seekbackward", (d) => seek((audio ? audio.currentTime : 0) - (d && d.seekOffset ? d.seekOffset : 10)));
  set("seekforward", (d) => seek((audio ? audio.currentTime : 0) + (d && d.seekOffset ? d.seekOffset : 10)));
  set("seekto", (d) => {
    if (d && typeof d.seekTime === "number") seek(d.seekTime);
  });
}
mediaHandlers();

// Called from MainActivity's ACTION_AUDIO_BECOMING_NOISICAL receiver.
window.__pauseNoisy = () => {
  if (audio && !audio.paused) audio.pause();
};

export function playerState() {
  let buf = 0;
  try {
    const b = audio && audio.buffered;
    const dur = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
    if (b && b.length && dur > 0) buf = Math.min(1, b.end(b.length - 1) / dur);
  } catch {}
  return {
    track: queue[qi] || null,
    paused: !audio || audio.paused,
    pos: audio ? audio.currentTime || 0 : 0,
    dur: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
    buf,
    badge,
    shuffle,
    repeat,
    qi,
    queue,
  };
}

function paint() {
  const s = playerState();
  mediaState();
  for (const f of painters) {
    try {
      f(s);
    } catch (e) {
      console.error(e);
    }
  }
}

/// For screens that mutate the queue from outside (the Radio toggle refills
/// an exhausted queue on demand).
export function repaint() {
  paint();
}

/// Endless radio: keep the queue fed while repeat is off and it is close to
/// running dry. Repeat modes never run out, so they never top up.
function topUpRadio() {
  if (netMode() === "offline") return; // recommendations need the network
  if (repeat !== 0 || queue.length - qi > 3) return;
  ensureReco(queue, qi)
    .then((added) => {
      if (added) paint();
    })
    .catch(() => {});
}

// One retry for transient blips: a momentary drop must not skip the song and
// must not restart it either — position is captured before the reload and put
// back once metadata is known (mirrors playback.js on desktop).
let retries = 0;
let lastEndedAt = 0;

function streamError() {
  if (!audio || !audio.error) return;
  if (audio.src && retries < 1) {
    retries += 1;
    const src = audio.src;
    const at = audio.currentTime;
    badge = "RETRYING";
    paint();
    setTimeout(() => {
      if (audio.src !== src) return; // the user already moved on
      audio.addEventListener(
        "loadedmetadata",
        () => {
          try {
            audio.currentTime = at;
          } catch {}
        },
        { once: true },
      );
      audio.load();
      // Safety net: a source that never reports metadata must not stall.
      setTimeout(() => {
        if (audio.paused && audio.src === src) audio.play().catch(() => {});
      }, 4000);
    }, 2000);
    return;
  }
  retries = 0;
  badge = "ERROR";
  toast("Playback failed — skipping", 5000, "error");
  paint();
  step(1, true);
}

// ------------------------------------------------------- resume position -
// tm-remember-pos (Settings → Playback): park the playhead every ~2s while
// playing, plus on pause/hide; start() seeks back when the same id returns.
// Same key and shape as desktop playback.js (tm-pos = {id, t}).
function rememberPosOn() {
  try {
    return localStorage.getItem("tm-remember-pos") !== "0";
  } catch {
    return true;
  }
}

let posSaveAt = 0;
function savePos(force = false) {
  if (!rememberPosOn()) return;
  const track = queue[qi];
  if (!track || !track.id) return;
  const now = Date.now();
  if (!force && now - posSaveAt < 2000) return;
  posSaveAt = now;
  try {
    localStorage.setItem("tm-pos", JSON.stringify({ id: track.id, t: audio.currentTime || 0 }));
  } catch {}
}

function onAudioEvent(e) {
  // Both transport elements share this handler; only the audible one drives
  // paint/ended/error. The standby's events are preload noise.
  if (!e || e.target !== audio) return;
  if (e.type === "ended") return ended();
  if (e.type === "error") return streamError();
  if (e.type === "timeupdate") {
    xfadeTick();
    savePos();
  }
  if (e.type === "pause") savePos(true);
  paint();
}

addEventListener("pagehide", () => savePos(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePos(true);
});

if (audio) {
  for (const ev of [
    "play",
    "pause",
    "timeupdate",
    "loadedmetadata",
    "durationchange",
    "progress",
    "seeked",
    "playing",
    "waiting",
    "ended",
    "error",
  ]) {
    audio.addEventListener(ev, onAudioEvent);
  }
  // Re-apply EQ on play (once): resumes a suspended AudioContext after the
  // user gesture and picks up any preset change made while paused.
  audio.addEventListener("play", () => {
    try {
      applyEq();
    } catch {}
  });
}

function ensureStandby() {
  if (standby) return standby;
  try {
    standby = document.createElement("audio");
    standby.preload = "auto";
    standby.volume = 0;
    // Same CORS-clean rule as the shell element (P36): the standby feeds the
    // same EQ chain, so a tainted load would feed silence into the handoff.
    standby.crossOrigin = "anonymous";
    try {
      const v = Number(localStorage.getItem("tm-play-speed") || "1");
      standby.playbackRate = [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(v) ? v : 1;
    } catch {}
    for (const ev of ["timeupdate", "ended", "error", "canplay"]) {
      standby.addEventListener(ev, onAudioEvent);
    }
    try {
      ensureEqChain(standby);
    } catch {}
  } catch {
    standby = null;
  }
  return standby;
}

/// Load a playlist/chart's tracks and start it (Home hero, playlist headers).
/// The id is a playlist id, so it must go through `playlist_tracks` — handing
/// it to `resolve_song` would never resolve to audio.
export async function playPlaylist(id, i = 0) {
  if (!invoke || !id) {
    toast("Backend unavailable", 4000, "error");
    return false;
  }
  try {
    const r = await invoke("playlist_tracks", { id });
    const list = Array.isArray(r) ? r : (r && (r.list || r.tracks)) || [];
    if (!list.length) {
      toast("That playlist has no playable tracks", 5000, "error");
      return false;
    }
    playList(list, i);
    return true;
  } catch (e) {
    console.error(e);
    toast(String(e).slice(0, 100), 5000, "error");
    return false;
  }
}

export function playList(list, i = 0) {
  if (!invoke) {
    toast("Backend unavailable", 4000, "error");
    return;
  }
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) {
    toast("Nothing to play");
    return;
  }
  queue = q;
  qi = Math.max(0, Math.min(Number(i) || 0, q.length - 1));
  abortXfade(true); // new list: drop any preloaded standby buffer
  start();
}

/// Queue `track` behind whatever is playing ("Play next"). An empty queue
/// seeds itself, because there is no queue to insert into yet.
export function insertNext(track) {
  if (!track || !track.id) return false;
  if (!queue.length) {
    playList([track], 0);
    return true;
  }
  queue.splice(qi + 1, 0, track);
  paint();
  return true;
}

/// Append `track` to the end of the queue ("Add to queue").
export function enqueue(track) {
  if (!track || !track.id) return false;
  if (!queue.length) {
    playList([track], 0);
    return true;
  }
  queue.push(track);
  paint();
  return true;
}

/// Bulk variants for entity menus: insert/append a whole tracklist at once.
export function insertNextAll(list) {
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) return 0;
  if (!queue.length) {
    playList(q, 0);
    return q.length;
  }
  queue.splice(qi + 1, 0, ...q);
  paint();
  return q.length;
}

export function enqueueAll(list) {
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) return 0;
  if (!queue.length) {
    playList(q, 0);
    return q.length;
  }
  queue.push(...q);
  paint();
  return q.length;
}

/// Drop one entry by absolute queue index ("Remove from Queue" on a
/// NowPlaying row). The rows only offer entries past the playhead, but the
/// index bookkeeping still guards a removal at/before `qi` so the playing
/// track never shifts out from under the transport.
export function removeFromQueue(idx) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= queue.length) return false;
  queue.splice(i, 1);
  if (!queue.length) qi = 0;
  else if (i < qi) qi -= 1;
  else if (qi >= queue.length) qi = queue.length - 1;
  paint();
  return true;
}

/// Offline gate: with the network down, only vaulted ids can resolve (the
/// backend serves those straight from disk). Skip the rest and advance —
/// but bound the run so a repeat queue of undownloaded tracks can't loop.
let skipRun = 0;

// ------------------------------------------------------- stream quality ---
// effectiveStreamQuality() lives in shared.js once that lands; until then
// fall back to the raw localStorage key so the player never crashes.
export function effectiveQuality() {
  try {
    const fn = sharedHelpers.effectiveStreamQuality;
    if (typeof fn === "function") {
      const v = fn();
      if (v) return v;
    }
  } catch {}
  try {
    return localStorage.getItem("tm-stream-quality") || "320kbps";
  } catch {
    return "320kbps";
  }
}

// ------------------------------------------------------- explicit skip ---
function isExplicitHiddenTrack(track) {
  try {
    const hidFn = sharedHelpers.explicitHidden;
    const isFn = sharedHelpers.isExplicitTrack;
    if (typeof hidFn !== "function" || typeof isFn !== "function") return false;
    return !!hidFn() && !!isFn(track);
  } catch {
    return false;
  }
}

function skipExplicit(track) {
  skipRun += 1;
  if (skipRun >= Math.max(1, queue.length)) {
    skipRun = 0;
    badge = "IDLE";
    try {
      audio.pause();
    } catch {}
    toast("Skipped explicit tracks hidden by setting", 4000, "info");
    paint();
    return;
  }
  badge = "IDLE";
  toast(`Skipped explicit — ${track.title || "track"}`, 3000, "info");
  paint();
  step(1, true);
}

// ------------------------------------------------------- EQ + normalize -
// WebAudio chains, mobile-safe and built lazily (MediaElementSource can only
// be created once per <audio>, so one chain per transport element, shared
// AudioContext). The crossfade standby gets its own chain so the handoff
// never bypasses EQ.
let eqCtx = null;
const eqChains = new Map(); // element -> { low, mid, high, comp, gain }
let eqNodes = null; // legacy alias: the audible element's chain

export function ensureEqChain(el) {
  const target = el || audio;
  if (!target) return null;
  const cached = eqChains.get(target);
  if (cached) {
    if (!el || target === audio) eqNodes = cached;
    return cached;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!eqCtx) eqCtx = new AC();
    let src = null;
    try {
      src = eqCtx.createMediaElementSource(target);
    } catch {
      // Already wired (or unwirable) — don't crash, just skip EQ.
      return eqChains.get(target) || null;
    }
    const low = eqCtx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 120;
    const mid = eqCtx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    const high = eqCtx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 8000;
    const comp = eqCtx.createDynamicsCompressor();
    try {
      comp.threshold.value = 0;
    } catch {}
    const gain = eqCtx.createGain();
    try {
      gain.gain.value = 1;
    } catch {}
    src.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(comp);
    comp.connect(gain);
    gain.connect(eqCtx.destination);
    const nodes = { low, mid, high, comp, gain };
    eqChains.set(target, nodes);
    if (!el || target === audio) eqNodes = nodes;
    return nodes;
  } catch {
    return null;
  }
}

export function applyEq() {
  try {
    let preset = "flat";
    // Per-track override wins (track menu → "EQ for this track"); the
    // global preset stays the fallback for everything else.
    try {
      const cur = queue[qi];
      const mapFn = sharedHelpers.trackEqFor;
      const per = typeof mapFn === "function" && cur ? mapFn(cur.id) : "";
      if (per) preset = per;
      else {
        const fn = sharedHelpers.eqPreset;
        if (typeof fn === "function") preset = fn() || "flat";
        else preset = localStorage.getItem("tm-eq-preset") || "flat";
      }
    } catch {
      try {
        preset = localStorage.getItem("tm-eq-preset") || "flat";
      } catch {
        preset = "flat";
      }
    }
    let norm = false;
    try {
      const fn = sharedHelpers.normalizeOn;
      if (typeof fn === "function") norm = !!fn();
      else norm = localStorage.getItem("tm-normalize") === "1";
    } catch {
      try {
        norm = localStorage.getItem("tm-normalize") === "1";
      } catch {
        norm = false;
      }
    }
    const MAP = {
      flat: [0, 0, 0],
      bass: [6, 1, 2],
      bassboost: [9, 3, 4],
      pop: [2, 3, 4],
      bright: [-1, 1, 5],
      vocal: [-2, 4, 3],
    };
    const g = MAP[preset] || MAP.flat;
    let ok = false;
    for (const el of [audio, standby]) {
      if (!el) continue;
      const nodes = ensureEqChain(el);
      if (!nodes) continue;
      try {
        nodes.low.gain.value = g[0];
        nodes.mid.gain.value = g[1];
        nodes.high.gain.value = g[2];
      } catch {}
      try {
        // Threshold 0dB is effectively off (nothing peaks above it);
        // -24dB gives the normalize compression.
        nodes.comp.threshold.value = norm ? -24 : 0;
      } catch {}
      ok = true;
    }
    try {
      eqNodes = eqChains.get(audio) || eqNodes;
    } catch {}
    try {
      if (eqCtx && eqCtx.state === "suspended") eqCtx.resume().catch(() => {});
    } catch {}
    return ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- queue management
export function moveQueue(from, to) {
  const f = Number(from);
  const t = Number(to);
  if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f >= queue.length || t < 0 || t >= queue.length) return false;
  if (f === t) return true;
  const [item] = queue.splice(f, 1);
  queue.splice(t, 0, item);
  if (f === qi) qi = t;
  else if (f < qi && t >= qi) qi -= 1;
  else if (f > qi && t <= qi) qi += 1;
  paint();
  return true;
}

export function clearQueue(keepCurrent = true) {
  const cur = keepCurrent ? queue[qi] : null;
  // Mutate in place: playerState() hands out the live array reference.
  queue.length = 0;
  if (cur) {
    queue.push(cur);
    qi = 0;
  } else {
    qi = -1;
  }
  paint();
  return true;
}

export function smartShuffleQueue() {
  if (queue.length < 2) return false;
  let recent = new Set();
  try {
    const plays = sharedHelpers.load ? sharedHelpers.load(sharedHelpers.PLAYS_KEY, []) : [];
    recent = new Set((plays || []).slice(0, 15).map((t) => t && t.id).filter(Boolean));
  } catch {}
  const cur = queue[qi];
  const pool = queue.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const placed = [];
  while (pool.length) {
    let best = 0;
    let bestScore = Infinity;
    for (let p = 0; p < pool.length; p++) {
      const it = pool[p];
      const artist = String((it && it.artist) || "").toLowerCase();
      let score = Math.random() * 0.9;
      if (it && it.id && recent.has(it.id)) score += 100;
      for (let w = 1; w <= 3 && w <= placed.length; w++) {
        if (String((placed[placed.length - w] && placed[placed.length - w].artist) || "").toLowerCase() === artist) {
          score += 50;
          break;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    placed.push(...pool.splice(best, 1));
  }
  queue.length = 0;
  queue.push(...placed);
  if (cur) {
    const newIdx = queue.findIndex((t) => t && t.id === cur.id);
    qi = newIdx >= 0 ? newIdx : 0;
  } else {
    qi = 0;
  }
  paint();
  return true;
}

export function queueHistory() {
  if (qi <= 0) return [];
  return queue.slice(0, qi);
}

export function queueUpNext() {
  return queue.slice(qi + 1);
}

function skipOffline(track) {
  skipRun += 1;
  if (skipRun >= Math.max(1, queue.length)) {
    skipRun = 0;
    badge = "OFFLINE";
    audio.pause();
    toast("Nothing in this queue is downloaded — unavailable offline", 5000, "error");
    paint();
    return;
  }
  badge = "OFFLINE";
  toast(`Skipped — ${track.title || "track"} not downloaded`, 3000, "info");
  paint();
  step(1, true);
}

async function start() {
  const track = queue[qi];
  if (!track) return;
  const mine = ++seq;
  retries = 0; // each new track gets a fresh retry budget
  // Offline first: resolve_song would burn 15–25s of CDN timeouts before
  // failing, and the vaulted copy is the only thing that can play anyway.
  if (netMode() === "offline" && !isVaulted(track.id)) {
    if (mine === seq) skipOffline(track);
    return;
  }
  if (isExplicitHiddenTrack(track)) {
    if (mine === seq) skipExplicit(track);
    return;
  }
  skipRun = 0; // a playable track resets the skip budget
  badge = "RESOLVING";
  mediaMeta(track); // lock screen shows the track while it resolves
  paint();
  try {
    const streamQ = effectiveQuality();
    const info = await invoke("resolve_song", { id: track.id, quality: streamQ });
    if (mine !== seq) return;
    if (!info || info.range_status === "dead" || !info.proxy_url) {
      toast(`Could not resolve ${track.title || "track"}`, 5000, "error");
      // `true` = auto: an unadvanceable queue (one dead track, repeat off)
      // stops instead of re-resolving the same id forever.
      return step(1, true);
    }
    audio.src = info.proxy_url;
    try {
      applyEq();
    } catch {}
    try {
      const v = Number(localStorage.getItem("tm-play-speed") || "1");
      audio.playbackRate = [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(v) ? v : 1;
    } catch {}
    // Resume where you stopped: same id → seek back once metadata lands.
    try {
      if (rememberPosOn()) {
        const saved = JSON.parse(localStorage.getItem("tm-pos") || "null");
        if (saved && saved.id === track.id && Number(saved.t) > 0) {
          const t = Number(saved.t) || 0;
          const seekBack = () => {
            try {
              const end = Number.isFinite(audio.duration) ? audio.duration - 1 : t;
              audio.currentTime = Math.min(t, Math.max(0, end));
            } catch {}
          };
          if (audio.readyState >= 1) seekBack();
          else audio.addEventListener("loadedmetadata", seekBack, { once: true });
        }
      }
    } catch {}
    try {
      audio.volume = baseVol();
    } catch {}
    badge = String(info.chosen_quality || info.range_status || "OK").toUpperCase();
    pushPlay(track);
    await audio.play();
    prefetchNext();
    preloadStandby(); // gapless/xfade: resolve + buffer the next track now
    prefetchBytesNext(); // disk: save the next track while this one plays
    topUpRadio();
  } catch (e) {
    if (mine === seq) {
      // The resolve died with the network — if the track is on disk, play
      // that instead; otherwise fall through to the skip logic.
      if (netMode() !== "online" && isVaulted(track.id)) {
        try {
          const base = window.__tmBase;
          if (base) {
            audio.src = relayUrl(base, `/file?id=${encodeURIComponent(track.id)}`);
            try {
              applyEq();
            } catch {}
            badge = "VAULT";
            await audio.play();
            paint();
            return;
          }
        } catch {}
      }
      badge = "ERROR";
      console.error(e);
      toast(String(e).slice(0, 100), 5000, "error");
      if (netMode() === "offline") skipOffline(track);
    }
  }
  if (mine === seq) paint();
}

// Warm the resolve + range probe for the next queued track so advancing is a
// cache hit instead of a network wait. Quiet by design.
function prefetchNext() {
  if (!invoke || netMode() === "offline") return; // no point warming CDN lookups
  const ids = queue
    .slice(qi + 1, qi + 3)
    .map((t) => t && t.id)
    .filter(Boolean);
  if (!ids.length) return;
  try {
    invoke("prefetch_next", { ids }).catch(() => {});
  } catch {}
}

// Byte-prefetch the NEXT queued track to disk while this one plays
// (feature-list §10 P0-2). Gating — off on cellular, under Data Saver, and
// the tm-prefetch switch — lives inside prefetchTrackBytes.
function prefetchBytesNext() {
  try {
    void prefetchTrackBytes(queue[qi + 1]);
  } catch {}
}

// --------------------------------------------- gapless + crossfade -
// Dual-element transport: `standby` preloads the next track while `audio`
// plays. At the handoff the standby fades in (over tm-xfade seconds, or a
// 280ms butt-join when only tm-gapless is on) and the bindings swap —
// `audio` always names the audible element, so every reader follows.
// Shuffle + repeat-one defeat prediction, so those paths keep the classic
// stop-and-resolve handoff.
function xfadeSecs() {
  try {
    const v = Number(localStorage.getItem("tm-xfade") || "0");
    return v >= 0 && v <= 12 ? v : 0;
  } catch {
    return 0;
  }
}

function gaplessOn() {
  try {
    return localStorage.getItem("tm-gapless") === "1";
  } catch {
    return false;
  }
}

function xfadeActive() {
  return xfadeSecs() > 0 || gaplessOn();
}

/// The next queue entry, when it is knowable ahead of time.
function peekNext() {
  if (!queue.length || repeat === 2) return null;
  if (shuffle) return null; // picked at step time — unpredictable
  if (qi + 1 < queue.length) return { track: queue[qi + 1], index: qi + 1 };
  if (repeat === 1 && queue.length) return { track: queue[0], index: 0 };
  return null;
}

function peekId() {
  const p = peekNext();
  return p && p.track ? String(p.track.id || "") : "";
}

/// Same resolution start() performs, without playing: stream URL or the
/// vault relay copy. Null when the track cannot play right now.
async function resolveUrl(track) {
  if (!track || !track.id) return null;
  if (netMode() === "offline") {
    if (!isVaulted(track.id)) return null;
    try {
      const base = window.__tmBase;
      if (!base) return null;
      return { url: relayUrl(base, `/file?id=${encodeURIComponent(track.id)}`) };
    } catch {
      return null;
    }
  }
  if (!invoke) return null;
  try {
    const info = await invoke("resolve_song", { id: track.id, quality: effectiveQuality() });
    if (!info || info.range_status === "dead" || !info.proxy_url) return null;
    return { url: info.proxy_url };
  } catch {
    return null;
  }
}

let standbyForId = "";
let xfading = null;
let xfadeTimer = null;
const swapListeners = new Set();

/// Screens that captured the element at import (lyrics clock) re-attach here.
/// Called immediately with the current element, then on every swap.
export function onAudioSwap(fn) {
  if (typeof fn !== "function") return () => {};
  swapListeners.add(fn);
  try {
    fn(audio);
  } catch {}
  return () => swapListeners.delete(fn);
}

async function preloadStandby() {
  if (!xfadeActive()) return;
  const id = peekId();
  if (!id || id === standbyForId) return;
  standbyForId = id; // claim first — one resolve per track, never a stampede
  try {
    const sb = ensureStandby();
    const target = peekNext();
    if (!sb || !target || String(target.track.id || "") !== id) {
      standbyForId = "";
      return;
    }
    const r = await resolveUrl(target.track);
    if (standbyForId !== id) return; // queue moved on while resolving
    if (r && r.url) {
      try {
        sb.volume = 0;
        sb.src = r.url;
        sb.load();
      } catch {}
    } else {
      standbyForId = "";
    }
  } catch {
    standbyForId = "";
  }
}

function armDrive() {
  if (xfadeTimer) clearInterval(xfadeTimer);
  xfadeTimer = setInterval(() => {
    if (!xfading) {
      clearInterval(xfadeTimer);
      xfadeTimer = null;
      return;
    }
    driveXfade();
  }, 50);
}

function beginXfade() {
  const peek = peekNext();
  const sb = standby;
  if (!peek || !sb || !sb.src || standbyForId !== String(peek.track.id || "")) return;
  if (sb.readyState < 2) return; // HAVE_CURRENT_DATA — not enough to start
  const secs = xfadeSecs();
  xfading = {
    el: sb,
    index: peek.index,
    t0: performance.now(),
    ms: secs > 0 ? secs * 1000 : 280,
    base: baseVol(),
  };
  try {
    sb.currentTime = 0;
    sb.volume = 0;
    sb.play().catch(() => {});
  } catch {}
  armDrive();
}

function driveXfade() {
  const x = xfading;
  if (!x) return;
  const p = Math.min(1, (performance.now() - x.t0) / Math.max(1, x.ms));
  // The standby stalled before making sound: never cut over to silence —
  // bail out and let the normal ended → step path resolve the track.
  if (p >= 0.5 && x.el.paused && x.el.readyState < 2) return abortXfade();
  try {
    if (audio) audio.volume = x.base * (1 - p);
    x.el.volume = x.base * p;
  } catch {}
  if (p >= 1) finishXfade();
}

/// Timeupdate on the audible element: trigger the handoff, or drive a fade.
function xfadeTick() {
  if (xfading) {
    driveXfade();
    return;
  }
  if (!xfadeActive() || !audio || audio.paused) return;
  const sb = standby;
  if (!sb || !sb.src || sb.readyState < 3) return; // HAVE_FUTURE_DATA
  if (standbyForId !== peekId()) {
    preloadStandby();
    return;
  }
  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const secs = xfadeSecs();
  const triggerAt = secs > 0 ? Math.min(secs, dur / 2) : 0.3;
  if (dur - audio.currentTime <= triggerAt) beginXfade();
}

function finishXfade() {
  const x = xfading;
  if (!x) return;
  xfading = null;
  if (xfadeTimer) {
    clearInterval(xfadeTimer);
    xfadeTimer = null;
  }
  const old = audio;
  const sb = x.el;
  try {
    if (sb.paused) sb.play().catch(() => {});
  } catch {}
  qi = x.index;
  skipRun = 0;
  retries = 0;
  badge = "OK";
  audio = sb; // the swap: every reader of the live binding follows
  standby = old;
  // The promoted element keeps a cross-origin src — keep it CORS-clean
  // for the EQ chain after the swap (P36). Setting the property on an
  // element mid-load is a no-op for the in-flight fetch, but the swap is
  // the one point where src is re-assigned next, so this is the hook.
  try { audio.crossOrigin = "anonymous"; } catch {}
  try {
    audio.volume = baseVol();
    standby.volume = 0;
    standby.removeAttribute("src");
    standby.load();
  } catch {}
  standbyForId = "";
  try {
    mediaMeta(queue[qi]);
  } catch {}
  try {
    applyEq();
  } catch {}
  try {
    pushPlay(queue[qi]);
  } catch {}
  for (const fn of [...swapListeners]) {
    try {
      fn(audio);
    } catch {}
  }
  prefetchNext();
  prefetchBytesNext();
  topUpRadio();
  paint();
}

/// User took over mid-fade (seek / next / prev / new list): restore levels,
// release the standby buffer, keep the queue index untouched.
function abortXfade(clearSrc = false) {
  if (xfadeTimer) {
    clearInterval(xfadeTimer);
    xfadeTimer = null;
  }
  if (!xfading && !clearSrc) return;
  xfading = null;
  try {
    if (audio) audio.volume = baseVol();
    if (standby) {
      standby.volume = 0;
      if (clearSrc) {
        standby.pause();
        standby.removeAttribute("src");
        standby.load();
        standbyForId = "";
      }
    }
  } catch {}
}

export function toggle() {
  if (!audio || !audio.src) return;
  try {
    haptic(10);
  } catch {}
  if (audio.paused) audio.play().catch(() => {});
  else {
    abortXfade();
    audio.pause();
  }
}

function ended() {
  // A fade in flight owns the ending: cut over now instead of resolving.
  if (xfading) return finishXfade();
  // Some engines fire `ended` twice in quick succession; ignore the repeat so
  // a double event can never skip the next track (mirrors playback.js).
  const now = Date.now();
  if (now - lastEndedAt < 600) return;
  lastEndedAt = now;
  // A finished track doesn't resume: clear the park so a later replay of the
  // same id starts fresh instead of one second before the end.
  try {
    localStorage.removeItem("tm-pos");
  } catch {}
  if (repeat === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  step(1, true);
}

function step(dir, auto = false) {
  if (!queue.length) return;
  abortXfade(true); // manual/auto advance owns the transport now
  if (shuffle && dir > 0 && queue.length > 1) {
    let n = qi;
    while (n === qi) n = Math.floor(Math.random() * queue.length);
    qi = n;
  } else {
    qi += dir;
    if (qi >= queue.length) {
      if (repeat === 1) qi = 0;
      else {
        qi = queue.length - 1;
        if (auto) {
          audio.pause();
          audio.currentTime = 0;
          paint();
          return;
        }
      }
    }
    if (qi < 0) qi = queue.length - 1;
  }
  start();
}

export function next() {
  try {
    haptic(10);
  } catch {}
  step(1);
}

export function prev() {
  try {
    haptic(10);
  } catch {}
  if (audio && audio.currentTime > 3) {
    abortXfade();
    audio.currentTime = 0;
    return;
  }
  step(-1);
}

export function seek(sec) {
  abortXfade(); // user took the playhead: volumes back, fade cancelled
  if (audio && Number.isFinite(sec)) audio.currentTime = Math.max(0, Math.min(sec, audio.duration || sec));
}

export function setShuffle(v) {
  shuffle = !!v;
  paint();
}

export function toggleShuffle() {
  setShuffle(!shuffle);
}

export function cycleRepeat() {
  repeat = (repeat + 1) % 3;
  paint();
}

export { audio };
