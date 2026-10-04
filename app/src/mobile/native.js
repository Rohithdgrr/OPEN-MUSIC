// native.js — JS side of the Android media surfaces (notification center,
// lockscreen, Bluetooth/car/headset via MediaSession, homescreen widget).
//
// The native layer (MediaHub.kt) owns the session + notification + widget.
// This module pushes track metadata + transport state down through the
// `window.TMNative` JavascriptInterface and exposes `window.__tmRemote` so
// remote actions (notification buttons, widget, headset, car) drive the one
// shared <audio> element. Everything is guarded: on desktop browsers and
// before the bridge exists this module is a silent no-op.
import { audio, onPaint, playerState, toggle, next, prev, seek } from "./player.js";
import { hqArt } from "./shared.js";

function bridge() {
  try {
    return typeof window !== "undefined" && window.TMNative ? window.TMNative : null;
  } catch {
    return null;
  }
}

function trackId(t) {
  if (!t) return "";
  return String(t.id ?? t.url ?? t.perma_url ?? t.title ?? "");
}

function artUrl(t) {
  try {
    let raw = t && t.image ? hqArt(t.image, "500x500") : "";
    // Prefer the raw CDN file for the native fetch: hqArt() may return the
    // localhost relay URL (/art?u=<cdn>&token=…), which can outlive its
    // session token. Unwrap it — Kotlin fetches best with the plain URL.
    const m = /[?&]u=([^&]+)/.exec(raw);
    if (m) {
      try {
        raw = decodeURIComponent(m[1]);
      } catch {}
    }
    // Kotlin fetches the bytes itself: only absolute http(s) URLs survive.
    return /^https?:/i.test(raw) ? raw : "";
  } catch {
    return "";
  }
}

let lastMetaId = "";
let lastPlaying = null;
let lastStatePush = 0;

function pushMeta(s) {
  const b = bridge();
  if (!b) return;
  const id = trackId(s.track);
  if (id === lastMetaId) return;
  lastMetaId = id;
  try {
    b.pushMeta(
      JSON.stringify({
        title: (s.track && s.track.title) || "",
        artist: (s.track && (s.track.artist || s.track.subtitle)) || "",
        album: (s.track && s.track.album) || "",
        art: artUrl(s.track),
      }),
    );
  } catch {}
}

function pushState(s, force) {
  const b = bridge();
  if (!b) return;
  const playing = !!s.track && !s.paused;
  const now = Date.now();
  // Transport flips always go through; position heartbeats are throttled so
  // the notification seek bar stays honest without spamming the bridge.
  if (!force && playing === lastPlaying && now - lastStatePush < 2000) return;
  lastPlaying = playing;
  lastStatePush = now;
  try {
    b.pushState(
      JSON.stringify({
        playing,
        pos: Math.max(0, Math.floor((s.pos || 0) * 1000)),
        dur: Math.max(0, Math.floor((s.dur || 0) * 1000)),
        rate: (audio && audio.playbackRate) || 1,
      }),
    );
  } catch {}
}

// Remote entry points for Kotlin (RemoteGate.eval): every method must exist
// or a notification/widget tap silently does nothing.
window.__tmRemote = {
  play() {
    if (audio) audio.play().catch(() => {});
  },
  pause() {
    if (audio) audio.pause();
  },
  toggle() {
    try {
      toggle();
    } catch {}
  },
  next() {
    try {
      next();
    } catch {}
  },
  prev() {
    try {
      prev();
    } catch {}
  },
  seekTo(ms) {
    try {
      seek(Number(ms) / 1000);
    } catch {}
  },
  seekBy(dMs) {
    try {
      seek((audio ? audio.currentTime : 0) + Number(dMs) / 1000);
    } catch {}
  },
  stop() {
    try {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    } catch {}
    const b = bridge();
    try {
      if (b) b.dismissNotification();
    } catch {}
  },
};

function drainPending() {
  const b = bridge();
  if (!b) return;
  // Cold start via widget/notification while the app was dead: replay the
  // queued remote action, then jump to the requested route (widget body).
  try {
    const raw = b.consumeAction();
    if (raw) {
      const [action, seekMs] = String(raw).split("|");
      const R = window.__tmRemote;
      if (/TOGGLE$/.test(action)) R.toggle();
      else if (/NEXT$/.test(action)) R.next();
      else if (/PREV$/.test(action)) R.prev();
      else if (/SEEK_TO$/.test(action)) R.seekTo(Number(seekMs) || 0);
      else if (/STOP$|DISMISS$/.test(action)) R.stop();
    }
  } catch {}
  try {
    const route = b.consumeRoute();
    if (route) location.hash = "#/" + route;
  } catch {}
}

// Self-initializing on import: subscribes to the same paint loop every
// screen already uses, plus a 5s heartbeat so the notification position
// advances while playing.
onPaint((s) => {
  pushMeta(s);
  pushState(s, false);
});
setInterval(() => {
  try {
    const s = playerState();
    if (s.track && !s.paused) pushState(s, true);
  } catch {}
}, 5000);
// The bridge object appears when the WebView is created (before first
// paint), but a cold start can win the race — retry briefly.
let drainTries = 0;
const drainTimer = setInterval(() => {
  if (bridge() || ++drainTries > 40) {
    clearInterval(drainTimer);
    drainPending();
  }
}, 250);
