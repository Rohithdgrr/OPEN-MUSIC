// videobackdrop.js — the Now Playing ambient video (mobile DOM glue).
//
// Spec: docs/song-video.md §9/§12 and §17 (as-built). This module owns the
// <video> element's lifecycle only:
//   plan (videoplan.js) → transport (video_search / video_player / video_relay)
//   → paint, then play/pause in step with the catalog audio.
//
// It never decides which video is right (videomatch.js does) and never talks
// to the CDN (Rust's /video relay does). Off by default, skipped on metered
// data, and skipped when the OS asks for reduced motion.

import { buildSearchQuery } from "../videomatch.js";
import { VIDEO_PREF_KEY, chooseCandidate, chooseRendition, videoGate } from "../videoplan.js";
import { dataSaver, invoke, onCellular } from "./shared.js";

/// A negative row is honest for 24 h (§4). A transport failure retries in 5 min.
const NEGATIVE_TTL_S = 24 * 60 * 60;
const RETRY_MS = 5 * 60 * 1000;
/// Ambient cap; "full video" is not exposed on mobile (§7).
const MAX_HEIGHT = 720;

/// L0: last plan per track for this session (bounded, oldest out).
const plans = new Map();
/// track id → epoch ms before which we must not retry.
const misses = new Map();
const PLAN_MEMORY = 24;

let activeId = "";
let activeSrc = "";
let pendingFor = "";
let seq = 0;
let el = null;
let bound = false;
let reduceMotion = false;

try {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduceMotion = !!mq.matches;
  if (mq.addEventListener) {
    mq.addEventListener("change", (e) => {
      reduceMotion = !!e.matches;
    });
  }
} catch {}

function prefOn() {
  try {
    return localStorage.getItem(VIDEO_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(trackId, plan) {
  plans.set(trackId, plan);
  if (plans.size > PLAN_MEMORY) {
    const oldest = plans.keys().next().value;
    if (oldest !== undefined) plans.delete(oldest);
  }
}

function missFor(trackId) {
  const until = misses.get(trackId) || 0;
  return until > Date.now();
}

/// Pause, detach the source and drop the live class. Called on screen exit,
/// on track change and when the switch is turned off (`src = ""` releases the
/// decoder — §9).
export function stopVideoBackdrop() {
  activeId = "";
  activeSrc = "";
  pendingFor = "";
  if (!el) return;
  try {
    el.pause();
    el.classList.remove("is-live");
    el.removeAttribute("src");
    el.load();
  } catch {}
}

/// Which track the visible <video> belongs to ("" when idle).
export function videoBackdropTrack() {
  return activeId;
}

function bind(elx) {
  el = elx;
  if (bound) return;
  bound = true;
  // Transport sync must be immediate, not "next paint": media events do not
  // bubble, so listen in the capture phase on the document.
  document.addEventListener(
    "pause",
    (e) => {
      if (el && e.target && e.target.id === "audio") {
        try {
          el.pause();
        } catch {}
      }
    },
    true,
  );
  document.addEventListener(
    "play",
    (e) => {
      if (el && e.target && e.target.id === "audio" && el.classList.contains("is-live")) {
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      }
    },
    true,
  );
  // A backgrounded app must not decode video behind a locked screen.
  document.addEventListener("visibilitychange", () => {
    if (!el) return;
    if (document.hidden) {
      try {
        el.pause();
      } catch {}
    } else if (activeId) {
      const playing = el.dataset.playing === "1";
      if (playing) el.play().catch(() => {});
    }
  });
}

function applyPlan(track, plan) {
  if (!el || !track || plan.state !== "ready" || !plan.relayUrl) {
    misses.set(track.id, Date.now() + RETRY_MS);
    return;
  }
  activeId = track.id;
  el.muted = true;
  el.loop = true;
  el.playsInline = true;
  el.dataset.playing = "0";
  if (activeSrc !== plan.relayUrl) {
    activeSrc = plan.relayUrl;
    el.src = plan.relayUrl;
    el.load();
  }
  const show = () => {
    if (!el || activeId !== track.id) return;
    el.classList.add("is-live");
    // Start on a decoded frame, never on paint (§9): a slow 1080p stream must
    // not flash black over the artwork.
    el.play().catch(() => {});
  };
  if (el.readyState >= 2) show();
  else el.addEventListener("loadeddata", show, { once: true });
}

async function prepare(track, forEl) {
  const mine = ++seq;
  pendingFor = track.id;
  const stale = () => mine !== seq || !forEl.isConnected;
  try {
    // L2: a persisted match skips the search entirely; a persisted *negative*
    // row skips everything (that is the whole point of caching misses).
    let videoId = "";
    let stored = null;
    try {
      stored = await invoke("video_load", { id: track.id });
    } catch {}
    if (stale()) return;
    if (stored) {
      const expired = stored.expires_at && stored.expires_at * 1000 < Date.now();
      if (!expired && !stored.video_id) {
        // Honour the persisted 24 h quiet period, not just this session's.
        misses.set(track.id, Math.max(Date.now() + RETRY_MS, stored.expires_at * 1000));
        return;
      }
      if (!expired) videoId = stored.video_id;
    }

    let candidates = [];
    if (!videoId) {
      const { query } = buildSearchQuery(track);
      candidates = await invoke("video_search", { query });
      if (stale()) return;
      const best = chooseCandidate(track, candidates);
      if (!best) {
        // A wrong backdrop is worse than none: this is a 24 h answer, and it
        // is persisted so a fresh session does not search again (§4).
        remember(track.id, { state: "none" });
        misses.set(track.id, Date.now() + NEGATIVE_TTL_S * 1000);
        void storeRow(track, null);
        return;
      }
      videoId = best.candidate.videoId;
      candidates = [best.candidate];
    }

    const info = await invoke("video_player", { videoId });
    if (stale()) return;
    if (!info || !info.playability || info.playability.status !== "OK") {
      // Gated / unplayable: quiet for 24 h (§8.3) — never a retry loop.
      misses.set(track.id, Date.now() + NEGATIVE_TTL_S * 1000);
      void storeRow(track, null);
      return;
    }
    const rendition = chooseRendition(info.formats, MAX_HEIGHT);
    if (!rendition) {
      // No progressive rendition is a durable fact about this video.
      remember(track.id, { state: "none" });
      misses.set(track.id, Date.now() + NEGATIVE_TTL_S * 1000);
      void storeRow(track, null);
      return;
    }
    const relay = await invoke("video_relay", {
      trackId: track.id,
      videoId,
      itag: rendition.itag,
      url: rendition.url,
    });
    if (stale()) return;
    if (!relay || !relay.url) {
      misses.set(track.id, Date.now() + RETRY_MS);
      return;
    }
    const plan = { state: "ready", videoId, itag: rendition.itag, relayUrl: relay.url };
    remember(track.id, plan);
    if (candidates.length) {
      const best = candidates[0];
      void storeRow(track, {
        videoId,
        title: best.title || "",
        channel: best.channel || "",
        duration: best.durationSecs || 0,
        confidence: 0,
      });
    }
    if (track.id === currentTrackId()) applyPlan(track, plan);
  } catch {
    misses.set(track.id, Date.now() + RETRY_MS);
  } finally {
    if (mine === seq) pendingFor = "";
  }
}

async function storeRow(track, match) {
  try {
    const now = Math.floor(Date.now() / 1000);
    await invoke("video_store", {
      row: {
        track_id: track.id,
        provider: "youtube",
        video_id: match ? match.videoId : "",
        kind: match ? "unknown" : "none",
        title: match ? match.title : "",
        channel: match ? match.channel : "",
        duration_s: match ? match.duration : 0,
        confidence: match ? Number(match.confidence) || 0 : 0,
        matched_at: now,
        expires_at: now + (match ? 6 * 60 * 60 : NEGATIVE_TTL_S),
      },
    });
  } catch {}
}

/// The track the player is on right now, published by the binder below so an
/// in-flight resolve can tell whether it is still wanted.
let currentId = "";
export function noteCurrentTrack(track) {
  currentId = (track && track.id) || "";
}
function currentTrackId() {
  return currentId;
}

/// Called from `paintNowplaying` (~4×/s). Cheap on the steady path: when the
/// video already belongs to this track it only mirrors play/pause.
export function syncVideoBackdrop(track, st) {
  const forEl = document.getElementById("np-video");
  if (!forEl) {
    if (el) stopVideoBackdrop();
    return;
  }
  if (forEl !== el) {
    el = null;
    bound = false;
    bind(forEl);
  }
  noteCurrentTrack(track);
  if (!track || !track.id) {
    stopVideoBackdrop();
    return;
  }
  if (!prefOn()) {
    if (activeId) stopVideoBackdrop();
    return;
  }

  if (activeId === track.id) {
    el.dataset.playing = st && st.paused ? "0" : "1";
    if (st && st.paused) {
      try {
        el.pause();
      } catch {}
    } else if (el.classList.contains("is-live")) {
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    }
    return;
  }

  const gate = videoGate({
    enabled: true,
    hasInvoke: !!invoke,
    cellular: onCellular(),
    saveData: dataSaver(),
    reducedMotion: reduceMotion,
  });
  if (!gate.ok) {
    if (activeId) stopVideoBackdrop();
    return;
  }
  if (missFor(track.id)) return;

  const known = plans.get(track.id);
  if (known) {
    applyPlan(track, known);
    return;
  }
  if (pendingFor === track.id) return;
  void prepare(track, el);
}

/// Test/diagnostic seam: drop the session memory (never touches playback).
export function resetVideoBackdropMemory() {
  plans.clear();
  misses.clear();
  seq += 1;
  stopVideoBackdrop();
}
