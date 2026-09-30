// player.js — play/pause badge, audio event listeners
// Split from main.js (Phase 4 M1).
import { emitState } from "./bridge.js";
import { audio, bar, np } from "./dom.js";
import { syncLyrics } from "./lyrics.js";
import { fmtBytes, fmtTime, npText } from "./util.js";


export function setPlayIcon(playing) {
  const glyph = playing ? "pause" : "play_arrow";
  bar.playIcon.textContent = glyph;
  if (np.playIcon) np.playIcon.textContent = glyph;
  if (np.vinyl) np.vinyl.style.animationPlayState = playing ? "running" : "paused";
}

export function setBadge(status, info) {
  const full = status === "unrestricted";
  const preview = status === "restricted_first_mb";
  const badgeText = full
    ? `FULL SONG Â· ${info.chosen_quality} Â· ${fmtBytes(info.content_length)}`
    : preview
      ? "PREVIEW ONLY â€” stream capped near ~1 MB"
      : "UNREACHABLE â€” stream failed range checks";
  bar.badge.textContent = full ? `${info.chosen_quality}` : preview ? "PREVIEW" : "UNREACHABLE";
  bar.badge.classList.remove("hidden");
  if (np.badge) np.badge.textContent = badgeText;
  if (np.format) np.format.textContent = info.chosen_quality;
  npText("np-quality", info.chosen_quality);
  emitState(true);
  document.title = full
    ? "â–¶ " + bar.title.textContent
    : preview
      ? "â— preview â€” " + bar.title.textContent
      : "âœ– unreachable";
}

for (const ev of ["playing", "pause", "waiting", "ended"]) {
  audio.addEventListener(ev, () => {
    if (ev === "playing" || ev === "pause") setPlayIcon(ev === "playing");
    emitState(true);
  });
}

audio.addEventListener("timeupdate", () => {
  const d = audio.duration;
  const ratio = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
  bar.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  bar.cur.textContent = fmtTime(audio.currentTime);
  bar.total.textContent = fmtTime(d);
  if (np.progress) np.progress.style.width = `${(ratio * 100).toFixed(1)}%`;
  if (np.thumb) np.thumb.style.left = `${(ratio * 100).toFixed(1)}%`;
  if (np.cur) np.cur.textContent = fmtTime(audio.currentTime);
  if (np.total) np.total.textContent = fmtTime(d);
  emitState();
  npText("lyric-live-time", fmtTime(audio.currentTime));
  syncLyrics();
});

audio.addEventListener("progress", () => {
  try {
    if (np.buffered && audio.buffered.length && Number.isFinite(audio.duration)) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      np.buffered.style.width = `${((end / audio.duration) * 100).toFixed(1)}%`;
    }
  } catch {}
});

