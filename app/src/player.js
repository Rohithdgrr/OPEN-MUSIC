// player.js — play/pause badge, audio event listeners
// Split from main.js (Phase 4 M1).
import { emitState } from "./bridge.js";
import { audio, bar, np } from "./dom.js";
import { syncLyrics } from "./lyrics.js";
import { fmtBytes, fmtTime, npText } from "./util.js";


export function setPlayIcon(playing) {
  const glyph = playing ? "pause" : "play_arrow";
  bar.playIcon.textContent = glyph;
  if (np.vinyl) np.vinyl.style.animationPlayState = playing ? "running" : "paused";
}

export function setBadge(status, info) {
  const full = status === "unrestricted";
  const preview = status === "restricted_first_mb";
  const badgeText = full
    ? `FULL SONG · ${info.chosen_quality} · ${fmtBytes(info.content_length)}`
    : preview
      ? "PREVIEW ONLY — stream capped near ~1 MB"
      : "UNREACHABLE — stream failed range checks";
  bar.badge.textContent = full ? `${info.chosen_quality}` : preview ? "PREVIEW" : "UNREACHABLE";
  bar.badge.classList.remove("hidden");
  if (np.badge) np.badge.textContent = badgeText;
  if (np.format) np.format.textContent = info.chosen_quality;
  npText("np-quality", info.chosen_quality);
  emitState(true);
  document.title = full
    ? "▶ " + bar.title.textContent
    : preview
      ? "◐ preview — " + bar.title.textContent
      : "✖ unreachable";
}

for (const ev of ["playing", "pause", "waiting", "ended"]) {
  audio.addEventListener(ev, () => {
    if (ev === "playing" || ev === "pause") setPlayIcon(ev === "playing");
    emitState(true);
  });
}

/// Repaint the playhead everywhere it is shown. Split out of the `timeupdate`
/// listener because a seek (resume after a restart, a lyric tap, a widget
/// scrub) does not always come with a timeupdate tick — without this the bar
/// sits at the old position until playback ticks again.
function paintProgress() {
  const d = audio.duration;
  const ratio = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
  bar.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  bar.cur.textContent = fmtTime(audio.currentTime);
  bar.total.textContent = fmtTime(d);
  emitState();
  npText("lyric-live-time", fmtTime(audio.currentTime));
  syncLyrics();
}

audio.addEventListener("timeupdate", paintProgress);
audio.addEventListener("seeked", paintProgress);
// `loadedmetadata` carries the total time and, right after a resume, the
// position the playhead was put back to.
audio.addEventListener("loadedmetadata", paintProgress);



