// bridge.js — desktop-card state bridge (playerSnapshot, emitState)
// Split from main.js (Phase 4 M1).
import { audio, np } from "./dom.js";
import { isFav, toggleFavTrack } from "./library.js";
import { current, queue, queueIndex, repeatMode, restoredTrack, shuffleMode } from "./queue.js";
import { paintVolume, step, togglePlay, toggleRepeat, toggleShuffle } from "./transport.js";
import { downloadTrack } from "./vault.js";

// Stamp of the last state pushed to the desktop card (see emitState below).
export let stateEmitAt = 0;
// Trailing-emit timer for emitState()'s throttle (see emitState below).
export let stateEmitTimer = 0;
// -------------------------------------------------- desktop card bridge ----
// The desktop card is a second webview: no <audio>, no queue, no history - it
// is a pure view. This window owns the truth, pushes a snapshot on every
// meaningful change, and answers the transport commands the card sends back.
// Everything rides Tauri events, so no extra capability entry is required.
export function playerSnapshot() {
  const entry = queue[queueIndex];
  const live = entry ? entry.track : null;
  const t = live || restoredTrack;
  const nxt = queue[queueIndex + 1] || queue.find((q) => q.state === null);
  return {
    hasTrack: !!t,
    live: !!live,
    id: t ? t.id : "",
    title: t ? t.title : "",
    artist: t ? t.artist : "",
    album: t ? t.album : "",
    image: t ? t.image : "",
    hq: !!(t && t.hq),
    quality: live && current ? current.chosen_quality || "" : "",
    paused: audio.paused,
    position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    queueLen: queue.length,
    shuffle: shuffleMode,
    repeat: repeatMode,
    volume: audio.volume,
    muted: audio.muted,
    fav: t ? isFav(t.id) : false,
    next: nxt
      ? {
          title: nxt.track.title,
          sub: [nxt.track.artist, nxt.track.duration].filter(Boolean).join(" - "),
          image: nxt.track.image || "",
        }
      : null,
  };
}

/// Throttled by default so `timeupdate` (several times a second) cannot spam
/// the card's webview; pass `true` for changes that must land right now - a
/// play/pause, a track change, a seek, or a control the card itself pressed.
/// A throttled change is never lost: the last one inside the window fires as
/// a trailing emit, so the widget never settles on stale state.
export function emitState(force = false) {
  const now = Date.now();
  if (force) {
    if (stateEmitTimer) {
      clearTimeout(stateEmitTimer);
      stateEmitTimer = 0;
    }
    emitStateNow();
    return;
  }
  if (now - stateEmitAt < 900) {
    if (!stateEmitTimer) {
      stateEmitTimer = setTimeout(() => {
        stateEmitTimer = 0;
        emitState();
      }, 900 - (now - stateEmitAt));
    }
    return;
  }
  emitStateNow();
}

export function emitStateNow() {
  stateEmitAt = Date.now();
  try {
    window.__TAURI__?.event?.emit("player:state", playerSnapshot());
  } catch {
    /* nothing listening yet - the next change pushes again */
  }
}

export function wireDesktopCard() {
  // Sent once by the card as it finishes painting its first frame.
  window.__TAURI__?.event?.listen("widget:ready", () => emitState(true));
  window.__TAURI__?.event?.listen("player:cmd", ({ payload }) => {
    const cmd = payload || {};
    switch (cmd.type) {
      case "play":
        togglePlay();
        break;
      case "prev":
        step(-1);
        break;
      case "next":
        step(1);
        break;
      case "shuffle":
        toggleShuffle();
        break;
      case "download":
        downloadTrack(queue[queueIndex] ? queue[queueIndex].track : restoredTrack, null);
        break;
      case "repeat":
        toggleRepeat();
        break;
      case "mute":
        audio.muted = !audio.muted;
        if (np.volIcon) np.volIcon.textContent = audio.muted ? "volume_off" : "volume_up";
        paintVolume();
        break;
      case "fav":
        toggleFavTrack(queue[queueIndex] ? queue[queueIndex].track : restoredTrack);
        break;
      case "seek":
        if (Number.isFinite(cmd.value) && Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.min(1, Math.max(0, cmd.value)) * audio.duration;
        }
        break;
      case "volume":
        if (Number.isFinite(cmd.value)) {
          audio.volume = Math.min(1, Math.max(0, cmd.value));
          audio.muted = false;
          if (np.volIcon) np.volIcon.textContent = "volume_up";
          paintVolume();
        }
        break;
    }
    emitState(true);
  });
}

