// media.js — OS media overlay (Windows SMTC / Now Playing) integration.
// The WebView shows "Unknown app" with a dead control row unless the page
// drives navigator.mediaSession: this sets the track metadata (title,
// artist, album, artwork) and wires the flyout's play/pause/skip buttons.
import { hqArt } from "./art.js";
import { audio } from "./dom.js";

let handlers = { onPlay: null, onPause: null, onNext: null, onPrev: null };

export function initMediaSession(h) {
  if (!("mediaSession" in navigator)) return;
  handlers = { ...handlers, ...h };
  const bind = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn ? () => fn() : null);
    } catch {}
  };
  bind("play", () => handlers.onPlay?.());
  bind("pause", () => handlers.onPause?.());
  bind("nexttrack", () => handlers.onNext?.());
  bind("previoustrack", () => handlers.onPrev?.());
  bind("seekto", (d) => {
    if (typeof d.seekTime === "number" && Number.isFinite(audio.duration))
      audio.currentTime = d.seekTime;
  });
  audio.addEventListener("play", updateMediaSessionState);
  audio.addEventListener("pause", updateMediaSessionState);
  audio.addEventListener("ended", updateMediaSessionState);
}

// Windows' flyout shows a single artwork image, so to keep BOTH the track
// thumbnail and the platform logo visible they are composited into one
// square: the cover fills the frame, the logo sits as a small badge in the
// corner. Falls back to the plain image if anything blocks the canvas.
async function brandedArtwork(trackArt) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  try {
    const [cover, logo] = await Promise.all([load(trackArt), load("logo.png")]);
    const size = 500;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(cover, 0, 0, size, size);
    const badge = Math.round(size * 0.22);
    const pad = Math.round(size * 0.05);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(size - badge - pad * 2, size - badge - pad * 2, badge + pad * 2, badge + pad * 2, pad);
    ctx.fill();
    ctx.drawImage(logo, size - badge - pad, size - badge - pad, badge, badge);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return trackArt;
  }
}

export async function setMediaSessionTrack(track) {
  if (!("mediaSession" in navigator) || !track) return;
  const art = track.image ? hqArt(track.image, "500x500") : "";
  const primary = art ? await brandedArtwork(art) : "logo.png";
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "TRANCE MUSIC",
      artist: track.artist || "",
      album: track.album || "",
      artwork: [
        { src: primary, sizes: "500x500", type: primary.startsWith("data:") ? "image/jpeg" : "image/png" },
        // The platform logo stays a separate entry too, and is the only
        // artwork when the track has no cover.
        { src: "logo.png", sizes: "192x192", type: "image/png" },
      ],
    });
  } catch {}
  updateMediaSessionState();
}

export function updateMediaSessionState() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
    if ("setPositionState" in navigator.mediaSession && Number.isFinite(audio.duration)) {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime, audio.duration),
      });
    }
  } catch {}
}
