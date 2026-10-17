// canvas.js — Spotify Canvas on the mobile Now Playing screen.
//
// Spec: docs/spotify-android-canvas.md §3B. The backend command
// (`fetch_canvas`) resolves an expiring canvaz.scdn.co mp4 for the current
// track; this module paints it over the album art with the §4 fallback
// contract: on any miss — toggle off, no cookie, metered network without the
// cellular toggle, fetch error, video error — the album art just stays.
// Nothing here ever toasts or throws into the player paint loop.

import { invoke, onCellular } from "./shared.js";

const CANVAS_KEY = "tm-canvas";
const CANVAS_CELL_KEY = "tm-canvas-cellular";

function pref(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function canvasEnabled() {
  return pref(CANVAS_KEY);
}
export function canvasCellularAllowed() {
  return pref(CANVAS_CELL_KEY);
}
export function setCanvasEnabled(on) {
  try {
    localStorage.setItem(CANVAS_KEY, on ? "1" : "0");
  } catch {}
}
export function setCanvasCellular(on) {
  try {
    localStorage.setItem(CANVAS_CELL_KEY, on ? "1" : "0");
  } catch {}
}

// The track key the current video state belongs to. "" = nothing painted.
let lastKey = "";

function videoEl() {
  return document.getElementById("np-canvas");
}

function hide(v) {
  try {
    v.pause();
  } catch {}
  v.classList.add("hidden");
  v.removeAttribute("src");
}

/// Drop any playing canvas (Settings toggle-off, room-leave style resets).
export function stopCanvas() {
  lastKey = "";
  const v = videoEl();
  if (v) hide(v);
}

/// Paint (or clear) the Canvas for `track`. Safe to call on every player
/// paint — after the first call for a track it is a string compare.
export async function paintCanvasForTrack(track) {
  const v = videoEl();
  if (!v) {
    // Screen not mounted (or navigated away): forget, so returning to Now
    // Playing repaints even for the same track.
    lastKey = "";
    return;
  }
  const key = track && track.id ? String(track.id) : "";
  if (!key || key === lastKey) return;
  lastKey = key;
  hide(v); // a previous track's canvas must never linger

  if (!canvasEnabled()) return;
  if (onCellular() && !canvasCellularAllowed()) return;

  let res;
  try {
    res = await invoke("fetch_canvas", {
      isrc: null,
      title: track.title || "",
      artist: track.artist || "",
    });
  } catch {
    // "Canvas not configured" / rate limit / parse failure — keep the art.
    return;
  }
  // The track changed while we were waiting: drop this answer.
  if (lastKey !== key) return;
  if (!res || !res.url) return;

  v.onerror = () => hide(v); // broken/expired URL: art stands
  v.src = res.url;
  v.classList.remove("hidden");
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
}
