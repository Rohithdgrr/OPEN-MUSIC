// canvas.js — ambient mobile Canvas layer (every screen, every song).
//
// PARKED 2026-10-24 (docs/spotify-android-canvas.md §18): NOT wired into the
// Android app. binders.js commented the import and every call site, and the
// onPaint subscription below is off, so no layer is ever created and nothing
// is visible. The renderer is kept intact for the revival checklist (§18.3).
//
//
// Spec: docs/spotify-android-canvas.md §14 (source), §15 (full-bleed),
// §16 (ambient + artwork fallback), §17 (9:16 source floor + 6 s loop).
// The layer is a sibling of #screen, fixed under the UI, and survives
// navigation. Every painted track gets a full-bleed backdrop immediately:
//   - Apple Music's animated cut when the cookie-free route has one;
//   - otherwise a deliberate 6 s generated canvas from the track's own cover
//     (backdrop drift + colour wash + card drift + light sweep), so no song
//     ever reads as a still image.
// The official cut is played as a 6 s window with a 0.6 s crossfade between
// two muted <video> elements; both are loop=false, the rAF ticker owns the
// clock. The cinematic dark presentation belongs to the whole app while a
// track is loaded. Leaving Now Playing only swaps the scrim (focus vs
// ambient); it never tears the canvas down. The user's theme comes back when
// the canvas stops (toggle off / no track). Every miss is silent; nothing
// here throws into the player paint loop.

import { invoke, onCellular, hqArt, LOGO } from "./shared.js";
import { /* onPaint — PARKED §18, back with the hook */ playerState } from "./player.js";
import { LOOP_SECONDS, cropBox, loopPlan, meetsCanvasFloor } from "./canvasmath.js";

const CANVAS_KEY = "tm-canvas";
const CANVAS_CELL_KEY = "tm-canvas-cellular";
const LAYER_ID = "np-canvas-layer";
const BACKDROP_ID = "np-canvas-backdrop";
const VIDEO_ID = "np-canvas";
const ALT_ID = "np-canvas-alt";
const WASH_ID = "np-canvas-wash";
// The artwork fallback is not a still image: the card pans/zooms its cover
// with a light sweep while this class is up (CSS in index.html). Removed the
// moment a real Apple video takes over, so the two motions never stack.
const MOTION_CLASS = "np-canvas-motion";

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

// The track key the current backdrop/video belongs to. "" = nothing painted.
let lastKey = "";
// The theme to hand back when the cinematic mode ends; null = mode is off.
let savedDark = null;
/// Lifecycle truth, independent of the DOM classes. Screen modules rewrite
/// `document.body.className` on every mount (screens/*.js line 5), so a guard
/// keyed on a body class would skip the theme restore after navigation — the
/// exact bug the M5 probe caught (2026-10-20). That is also why the
/// presentation classes live on <html>: the screens never rewrite it.
let modeOn = false;
// The last focused/ambient value applied (the player paints ~4×/s on
// timeupdate, so syncFocus must not touch the DOM unless the route changed).
let lastFocus = null;
// The two-video loop. frontEl is visible and playing; backEl is preloaded at
// opacity 0 and becomes the front at the end of each crossfade.
let frontEl = null;
let backEl = null;
let loopRaf = 0;
// { from, to, started } while the 0.6 s crossfade is running.
let fade = null;
// The first presented frame can arrive after `playing`. The ticker waits for
// rVFC (or 600 ms) so the 6 s anchor is the real first sample time.
let baseToken = 0;
let basePending = false;

function layerEl() {
  return document.getElementById(LAYER_ID);
}

function videoEl() {
  return document.getElementById(VIDEO_ID);
}

function altEl() {
  return document.getElementById(ALT_ID);
}

function backdropEl() {
  return document.getElementById(BACKDROP_ID);
}

function videoEls() {
  return [videoEl(), altEl()].filter(Boolean);
}

function otherVideo(v) {
  return videoEls().find((el) => el !== v) || null;
}

/// One muted canvas video. loop=false on purpose: the renderer owns the 6 s
/// window (§17.2), so the source's own 20–30 s duration never leaks through.
function createVideo(id) {
  const v = document.createElement("video");
  v.id = id;
  v.className = "hidden";
  v.muted = true;
  v.loop = false;
  v.playsInline = true;
  v.preload = "auto";
  v.setAttribute("aria-hidden", "true");
  v.style.opacity = "0";
  v.style.zIndex = "1";
  v.addEventListener("loadedmetadata", () => publishFormat(v));
  return v;
}

/// The source metadata becomes the renderer's public format contract:
/// 808x1438 for Apple's 1078x1438 tall cut, 6 for the loop window. The live
/// probe reads exactly these attributes.
function publishFormat(v) {
  if (!v || !v.videoWidth || !v.videoHeight) return;
  const layer = layerEl();
  if (!layer) return;
  const base = Number(v.dataset.base || 0);
  const box = cropBox(v.videoWidth, v.videoHeight);
  layer.dataset.source = `${v.videoWidth}x${v.videoHeight}`;
  layer.dataset.crop = `${box.w}x${box.h}`;
  layer.dataset.loop = String(loopPlan(v.duration, base).seconds);
  layer.dataset.base = String(base);
  layer.dataset.floor = meetsCanvasFloor(v.videoWidth, v.videoHeight) ? "ok" : "miss";
  v.style.objectPosition = "center";
}

/// The full-bleed layer lives on <body>, outside #screen: the router's
/// screen-enter transform must never trap a fixed child, and navigation
/// replaces the fragment wholesale — the layer (and a still-playing video)
/// has to survive that. The layer carries four children:
///   #np-canvas-backdrop  the track cover, always available
///   #np-canvas-wash      a 6 s colour/light layer for the generated canvas
///   #np-canvas           the front Apple animated cut, when one resolves
///   #np-canvas-alt       the preloaded standby for the crossfade
function ensureLayer() {
  let layer = layerEl();
  if (layer) {
    if (!frontEl) frontEl = videoEl();
    if (!backEl) backEl = altEl();
    return layer;
  }
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.className = "hidden";
  layer.setAttribute("aria-hidden", "true");

  const img = document.createElement("img");
  img.id = BACKDROP_ID;
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  img.setAttribute("aria-hidden", "true");
  // An art URL that 404s must not leave a black hole: fall back to the mark
  // exactly once (the src guard stops an error loop on the logo itself).
  img.addEventListener("error", () => {
    if (img.getAttribute("src") !== LOGO) img.setAttribute("src", LOGO);
  });
  layer.appendChild(img);

  const wash = document.createElement("div");
  wash.id = WASH_ID;
  wash.setAttribute("aria-hidden", "true");
  layer.appendChild(wash);

  const v = createVideo(VIDEO_ID);
  const alt = createVideo(ALT_ID);
  layer.appendChild(v);
  layer.appendChild(alt);

  document.body.appendChild(layer);
  frontEl = v;
  backEl = alt;
  return layer;
}

/// The cover of the current track is the canvas of last resort. hqArt()
/// upgrades the catalog's 500 px URL and routes it through the loopback
/// relay (already cached by the row/art painters).
function setBackdrop(track) {
  const img = backdropEl();
  if (!img) return;
  const raw = track && track.image ? String(track.image) : "";
  const next = raw ? hqArt(raw) : LOGO;
  if (img.getAttribute("src") === next) return;
  img.setAttribute("src", next);
}

/// Cinematic presentation: the page/art card turn transparent (CSS keyed on
/// html.np-canvas-live) and the dark token set is forced so text and controls
/// read over the backdrop. The previous theme comes back on exit.
function enterMode() {
  if (!modeOn) {
    savedDark = document.documentElement.classList.contains("dark");
    modeOn = true;
    lastFocus = null;
    document.documentElement.classList.add("np-canvas-live");
  }
  document.documentElement.classList.add("dark");
}

function exitMode() {
  // Unconditional: hideVideo() may have armed the fallback motion while a
  // previous stop had already left the mode off.
  stopLoop();
  document.documentElement.classList.remove(MOTION_CLASS);
  if (!modeOn) return;
  modeOn = false;
  lastFocus = null;
  document.documentElement.classList.remove("np-canvas-live");
  document.documentElement.classList.remove("np-canvas-art");
  document.documentElement.classList.remove("np-canvas-focus");
  const layer = layerEl();
  if (layer) layer.classList.remove("dim");
  if (savedDark !== null) document.documentElement.classList.toggle("dark", savedDark);
  savedDark = null;
}

/// Now Playing is the focused presentation: the art-card window, no extra
/// dimming. Every other screen is ambient: the same layer under a stronger
/// scrim so page text and cards stay readable over arbitrary footage.
function isNowPlaying() {
  const h = String(location.hash || "");
  if (h.startsWith("#/nowplaying")) return true;
  return !!document.getElementById("np-title");
}

function syncFocus() {
  if (!modeOn) return;
  const focus = isNowPlaying();
  if (focus === lastFocus) return;
  lastFocus = focus;
  document.documentElement.classList.toggle("np-canvas-focus", focus);
  const layer = layerEl();
  if (layer) layer.classList.toggle("dim", !focus);
}

/// The artwork backdrop is up (the video is either absent or still loading).
/// This is the every-song canvas: the cover drifts and catches the light on a
/// 6 s clock, so a track without Apple motion artwork still moves.
function showBackdrop() {
  const layer = layerEl();
  if (!layer) return;
  layer.classList.remove("hidden");
  layer.dataset.mode = "art";
  layer.dataset.crop = "cover";
  layer.dataset.loop = String(LOOP_SECONDS);
  delete layer.dataset.source;
  delete layer.dataset.base;
  delete layer.dataset.floor;
  document.documentElement.classList.add(MOTION_CLASS);
  document.documentElement.classList.remove("np-canvas-art");
  enterMode();
  syncFocus();
}

function showVideo(v) {
  const layer = layerEl();
  if (!layer) return;
  layer.classList.remove("hidden");
  layer.dataset.mode = "video";
  v.classList.remove("hidden");
  const other = otherVideo(v);
  // The first `playing` frame is the anchor, not 0: Apple's fMP4 has a ~10 s
  // edit-list offset, so a 0-based 6 s window would already be over. Cache it
  // on both elements (same source) before the ticker starts.
  const base = Number.isFinite(v.currentTime) && v.currentTime > 0 ? v.currentTime : 0;
  v.dataset.base = String(base);
  if (other) other.dataset.base = String(base);
  // `playing` can fire a frame before the first media sample is presented.
  // rVFC reports the actual mediaTime of that frame; until it lands (or the
  // short timeout passes) the ticker waits, otherwise a 0 anchor can still
  // trigger the "already past the window" crossfade on Apple's fMP4.
  const token = ++baseToken;
  basePending = true;
  const settleBase = (mediaTime) => {
    if (token !== baseToken) return;
    basePending = false;
    if (Number.isFinite(mediaTime) && mediaTime > 0) {
      v.dataset.base = String(mediaTime);
      if (other) other.dataset.base = String(mediaTime);
      publishFormat(v);
    }
  };
  if (typeof v.requestVideoFrameCallback === "function") {
    v.requestVideoFrameCallback((_, meta) => settleBase(meta && meta.mediaTime));
    setTimeout(() => {
      if (token === baseToken) basePending = false;
    }, 600);
  } else {
    basePending = false;
  }
  if (other) {
    other.classList.remove("hidden");
    other.style.opacity = "0";
    other.style.zIndex = "1";
  }
  v.style.opacity = "1";
  v.style.zIndex = "2";
  v.dataset.front = "1";
  if (other) other.dataset.front = "0";
  frontEl = v;
  backEl = other;
  publishFormat(v);
  enterMode();
  // The art card becomes a window onto the video only while the video is
  // actually up; during a lookup (or a fallback) it keeps painting the sharp
  // cover instead of leaving a transparent hole.
  document.documentElement.classList.remove(MOTION_CLASS);
  document.documentElement.classList.add("np-canvas-art");
  syncFocus();
  startLoop();
}

function clearVideo(el) {
  if (!el) return;
  try {
    el.pause();
  } catch {}
  el.onerror = null;
  el.classList.add("hidden");
  el.removeAttribute("src");
  el.style.opacity = "0";
  el.style.zIndex = "1";
  delete el.dataset.front;
  delete el.dataset.base;
  try {
    el.load(); // release the decoder; a lingering buffer can keep a surface alive
  } catch {}
}

function hideVideo() {
  stopLoop();
  for (const el of videoEls()) clearVideo(el);
  frontEl = videoEl();
  backEl = altEl();
  document.documentElement.classList.remove("np-canvas-art");
  // Back on the artwork: restore the fallback motion (stopCanvas()'s
  // exitMode removes it again).
  document.documentElement.classList.add(MOTION_CLASS);
  const layer = layerEl();
  if (layer && layer.dataset.mode === "video") layer.dataset.mode = "art";
}

/// The rAF ticker owns the 6 s window. Normal path: at the window end minus
/// the fade, start the standby 0.6 s before the window start; at the end of
/// the fade the standby is exactly at the window start. If the standby is not
/// ready (or errors), a hard cut keeps the loop alive rather than freezing.
function startLoop() {
  stopLoop();
  if (document.hidden || !frontEl || !frontEl.getAttribute("src")) return;
  loopRaf = requestAnimationFrame(loopTick);
}

function stopLoop() {
  if (loopRaf) {
    cancelAnimationFrame(loopRaf);
    loopRaf = 0;
  }
  fade = null;
}

function loopTick(now) {
  loopRaf = 0;
  if (basePending) {
    loopRaf = requestAnimationFrame(loopTick);
    return;
  }
  const v = frontEl;
  const layer = layerEl();
  if (!v || !v.getAttribute("src") || !layer || layer.dataset.mode !== "video") return;
  const plan = loopPlan(v.duration, Number(v.dataset.base || 0));
  if (fade) {
    const p = plan.fade > 0 ? Math.min(1, (now - fade.started) / (plan.fade * 1000)) : 1;
    fade.from.style.opacity = String(1 - p);
    fade.to.style.opacity = String(p);
    if (p >= 1) finishFade(plan);
  } else if (plan.fade > 0 && v.currentTime >= plan.start + plan.seconds - plan.fade) {
    const standby = backEl;
    if (standby && standby.getAttribute("src") && standby.readyState >= 2) {
      startFade(v, standby, plan, now);
    } else if (v.currentTime >= plan.start + plan.seconds) {
      hardLoop(v, plan);
    }
  } else if (plan.fade === 0 && v.currentTime >= plan.seconds) {
    hardLoop(v, plan);
  }
  const still = layerEl();
  if (!document.hidden && frontEl && still && still.dataset.mode === "video") {
    loopRaf = requestAnimationFrame(loopTick);
  }
}

function startFade(from, to, plan, now) {
  fade = { from, to, started: now };
  const preRoll = Math.max(0, plan.base);
  try {
    to.currentTime = preRoll;
  } catch {}
  to.style.opacity = "0";
  to.style.zIndex = "2";
  from.style.zIndex = "1";
  try {
    to.pause();
  } catch {}
  const p = to.play();
  if (p && p.catch) p.catch(() => {});
}

function finishFade(plan) {
  if (!fade) return;
  const { from, to } = fade;
  from.style.opacity = "0";
  from.style.zIndex = "1";
  to.style.opacity = "1";
  to.style.zIndex = "2";
  from.dataset.front = "0";
  to.dataset.front = "1";
  try {
    from.pause();
  } catch {}
  // Reset the outgoing element while it is invisible: the next crossfade
  // starts it at the first presentable frame. Doing this only inside
  // startFade() races play() against the seek on Apple's edit-list fMP4.
  try {
    from.currentTime = Math.max(0, plan.base);
  } catch {}
  frontEl = to;
  backEl = from;
  fade = null;
  if (to.paused && !document.hidden) {
    // The standby's play() was refused or throttled: put it at the window
    // start before resuming so the next cycle is still 6 s.
    try {
      to.currentTime = plan.start;
    } catch {}
    const p = to.play();
    if (p && p.catch) p.catch(() => {});
  }
  publishFormat(to);
}

/// Pause the transport mid-fade: land on the standby (full opacity) before
/// pausing both, so resuming never shows a half-faded frame.
function settleFade() {
  if (!fade) return;
  finishFade(loopPlan(frontEl ? frontEl.duration : 0, frontEl ? Number(frontEl.dataset.base || 0) : 0));
}

function hardLoop(v, plan) {
  try {
    v.currentTime = plan.start;
  } catch {}
}

/// Tie the muted canvas video to the audio transport: pause freezes the last
/// frame (the backdrop is behind it), play resumes. A video that was fetched
/// while the track was paused starts here on resume.
function syncPlayback(paused) {
  const vids = videoEls();
  if (!vids.length) return;
  if (paused) {
    settleFade();
    for (const el of vids) {
      try {
        el.pause();
      } catch {}
    }
    return;
  }
  if (document.hidden) return;
  const f = frontEl && frontEl.getAttribute("src") ? frontEl : null;
  if (!f) return;
  if (f.paused) {
    const p = f.play();
    if (p && p.catch) p.catch(() => {});
  }
  if (fade && fade.to.paused) {
    const p = fade.to.play();
    if (p && p.catch) p.catch(() => {});
  }
}

/// Drop the ambient canvas (Settings toggle-off, no track).
export function stopCanvas() {
  lastKey = "";
  stopLoop();
  hideVideo();
  const layer = layerEl();
  if (layer) {
    layer.classList.add("hidden");
    delete layer.dataset.mode;
    delete layer.dataset.crop;
    delete layer.dataset.loop;
    delete layer.dataset.source;
    delete layer.dataset.base;
    delete layer.dataset.floor;
  }
  const img = backdropEl();
  if (img) img.removeAttribute("src");
  exitMode();
}

/// Paint (or clear) the Canvas for `track`. Safe to call on every player
/// paint — after the first call for a track it is a string compare.
export async function paintCanvasForTrack(track) {
  const key = track && track.id ? String(track.id) : "";
  if (!key) {
    // No track: nothing to show (and the layer may outlive the screen).
    if (lastKey || modeOn) stopCanvas();
    return;
  }
  if (key === lastKey) {
    // Same track: only the presentation may have changed (route/pause).
    syncFocus();
    return;
  }
  if (!canvasEnabled()) {
    // Remember the key even while disabled: the player paints ~4×/s and this
    // path must not run stopCanvas/hideVideo on every timeupdate.
    stopCanvas();
    lastKey = key;
    return;
  }
  lastKey = key;

  ensureLayer();
  const v = videoEl();
  const alt = altEl();
  // A previous track's video must never linger. The ambient mode stays on
  // across the change: the new cover is already a complete backdrop.
  hideVideo();

  setBackdrop(track);
  showBackdrop();
  syncPlayback(!!playerState().paused);

  // The artwork backdrop uses no extra network. The cellular gate only
  // suppresses the (multi-megabyte) video fetch.
  if (onCellular() && !canvasCellularAllowed()) return;

  let res;
  try {
    res = await invoke("fetch_canvas", {
      isrc: null,
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
    });
  } catch {
    // "Canvas not configured" / rate limit / parse failure — the backdrop
    // already carries the presentation, so there is nothing to undo.
    return;
  }
  // The track changed while we were waiting: drop this answer.
  if (lastKey !== key) return;
  if (!res || !res.url) return;

  const fallback = () => {
    // Keep the ambient mode: the backdrop is still a complete presentation.
    hideVideo();
    showBackdrop();
  };

  // The front is #np-canvas; the standby preloads the same relay URL so the
  // first crossfade at ~6 s never waits for a network round trip.
  if (v) {
    v.onerror = () => {
      if (frontEl === v) fallback();
    };
    // Reveal the video only once the decoder has frames; until then the
    // backdrop is visible, so there is never a black loading screen.
    v.addEventListener(
      "playing",
      () => {
        if (lastKey !== key) return;
        if (!v.getAttribute("src")) return;
        showVideo(v);
      },
      { once: true },
    );
    v.src = res.url;
    v.load();
  }
  if (alt) {
    alt.onerror = () => {
      // The standby failing must not kill a working front; the ticker will
      // hard-cut at the window end instead.
      if (frontEl === alt) fallback();
    };
    alt.src = res.url;
    alt.load();
  }
  if (playerState().paused) return; // starts on the transport's next play
  const p = v ? v.play() : null;
  if (p && p.catch) p.catch(() => {});
}

// Every player paint — on any screen — keeps the ambient layer in step. The
// Now Playing painter also calls paintCanvasForTrack directly; the key guard
// turns the duplicate into a string compare.
// PARKED 2026-10-24 (§18): the subscription is off — this hook is what made
// the layer follow the player on every screen. Without it an (unwired)
// module import can still evaluate but paints nothing.
// onPaint((st) => {
//   paintCanvasForTrack(st.track || null);
//   syncPlayback(!!st.paused);
// });

// The layer is outside #screen, so route changes do not unmount it. `smount`
// only re-syncs the presentation (focused Now Playing vs ambient elsewhere);
// the canvas keeps playing while the user browses.
document.addEventListener("smount", () => {
  syncFocus();
  // The screen's own smount listener (app.js) mounts the fragment; re-read
  // the DOM after it has run so the focus check sees the new screen.
  setTimeout(syncFocus, 0);
});
window.addEventListener("hashchange", syncFocus);

// Backgrounding the app pauses the decoder; coming back resumes it with the
// transport. The artwork backdrop (CSS) stays available either way.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    settleFade();
    for (const el of videoEls()) {
      if (el.getAttribute("src")) {
        try {
          el.pause();
        } catch {}
      }
    }
    return;
  }
  const layer = layerEl();
  if (layer && layer.dataset.mode === "video" && frontEl && frontEl.getAttribute("src")) {
    startLoop();
  }
  syncPlayback(!!playerState().paused);
});

// Live diagnostics: the canvas loop is time-based, so the harness needs the
// actual front/standby/fade state rather than a single currentTime sample.
// Read-only; no behaviour depends on it.
if (typeof window !== "undefined") {
  window.__tmCanvasProbe = () => {
    const snap = (el) =>
      el
        ? {
            id: el.id,
            t: el.currentTime,
            paused: el.paused,
            rs: el.readyState,
            opacity: el.style.opacity,
            dur: el.duration,
            loop: el.loop,
          }
        : null;
    const layer = layerEl();
    return {
      mode: layer ? layer.dataset.mode : null,
      front: snap(frontEl),
      back: snap(backEl),
      fade: fade
        ? { from: fade.from.id, to: fade.to.id, elapsed: (performance.now() - fade.started) / 1000 }
        : null,
      plan: frontEl ? loopPlan(frontEl.duration, Number(frontEl.dataset.base || 0)) : null,
      base: layer ? layer.dataset.base : null,
      crop: layer ? layer.dataset.crop : null,
      loopAttr: layer ? layer.dataset.loop : null,
      frontAttr: frontEl ? frontEl.dataset.front : null,
    };
  };
}
