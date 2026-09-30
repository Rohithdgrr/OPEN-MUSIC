// transport.js — transport controls, modes, volume, queue extras, share/credits
// Split from main.js (Phase 4 M1).
import { emitState } from "./bridge.js";
import { diag, openCredits, showError, showView, toast } from "./core.js";
import { $, audio, bar, np } from "./dom.js";
import { loadPlays } from "./home.js";
import { playQueueItem } from "./playback.js";
import { current, pickNextIndex, queue, queueIndex, renderQueue, repeatMode, setQueueIndex, setQueueTab, setRepeatMode, setShuffleMode, shuffleMode } from "./queue.js";

// --------------------------------------------------------------- transport -
export async function togglePlay() {
  if (!audio.src) {
    // Fresh open: the bar shows the last played track but nothing is loaded.
    const last = loadPlays()[0];
    if (last) {
      queue.length = 0;
      queue.push({ track: last, state: null });
      setQueueIndex(-1);
      renderQueue();
      playQueueItem(0);
    } else {
      toast("Nothing to play yet — search for a track first.", "info");
    }
    return;
  }
  if (audio.paused) {
    try {
      await audio.play();
    } catch (e) {
      showError(`Browser refused to start playback: ${e}`);
    }
  } else {
    audio.pause();
  }
}
bar.play.addEventListener("click", togglePlay);
np.play?.addEventListener("click", togglePlay);

export function step(dir) {
  const next =
    dir > 0 ? pickNextIndex() : queueIndex - 1 >= 0 ? queueIndex - 1 : -1;
  if (next >= 0) playQueueItem(next);
}
bar.prev.addEventListener("click", () => step(-1));
bar.next.addEventListener("click", () => step(1));
np.prev?.addEventListener("click", () => step(-1));
np.next?.addEventListener("click", () => step(1));

export function paintModes() {
  for (const el of [bar.shuffle, np.shuffle]) {
    if (el) el.style.opacity = shuffleMode ? "1" : "";
  }
  const glyph = repeatMode === "one" ? "repeat_one" : "repeat";
  for (const el of [bar.repeat, np.repeat]) {
    const icon = el?.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = glyph;
    if (el) el.style.opacity = repeatMode === "off" ? "" : "1";
  }
}
export function toggleShuffle() {
  setShuffleMode(!shuffleMode);
  paintModes();
  diag("shuffle", null, shuffleMode ? "on" : "off");
  emitState(true);
}
export function toggleRepeat() {
  setRepeatMode(repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off");
  paintModes();
  diag("repeat", null, repeatMode);
  emitState(true);
}
bar.shuffle.addEventListener("click", toggleShuffle);
np.shuffle?.addEventListener("click", toggleShuffle);
bar.repeat.addEventListener("click", toggleRepeat);
np.repeat?.addEventListener("click", toggleRepeat);

export function seekFromEvent(track, e) {
  const r = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
}
bar.progress.addEventListener("click", (e) => seekFromEvent(bar.progress, e));
np.timeline?.addEventListener("click", (e) => seekFromEvent(np.timeline, e));

export function paintVolume() {
  bar.volFill.style.width = `${(audio.volume * 100).toFixed(0)}%`;
  if (np.volFill) np.volFill.style.width = `${(audio.volume * 100).toFixed(0)}%`;
  const tip = $("#vol-val-tooltip");
  if (tip) tip.textContent = `${Math.round(audio.volume * 100)}%`;
  emitState();
}
export function volFromEvent(track, e) {
  const r = track.getBoundingClientRect();
  audio.volume = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  audio.muted = false;
  paintVolume();
}

bar.volTrack.addEventListener("click", (e) => volFromEvent(bar.volTrack, e));
np.volTrack?.addEventListener("click", (e) => volFromEvent(np.volTrack, e));
np.volMute?.addEventListener("click", () => {
  audio.muted = !audio.muted;
  if (np.volIcon) np.volIcon.textContent = audio.muted ? "volume_off" : "volume_up";
  emitState(true);
});

bar.queue.addEventListener("click", () => {
  setQueueTab("next");
  renderQueue();
  showView("now-playing");
});

// ------------------------------------------------------------ queue extras -
$("#btn-shuffle-queue")?.addEventListener("click", () => {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  setQueueIndex(-1);
  renderQueue();
  diag("queue", null, "shuffled");
});
$("#btn-clear-queue")?.addEventListener("click", () => {
  audio.pause();
  queue.length = 0;
  setQueueIndex(-1);
  renderQueue();
  diag("queue", null, "cleared");
});
$("#queue-tab-next")?.addEventListener("click", () => {
  setQueueTab("next");
  renderQueue();
});
$("#queue-tab-history")?.addEventListener("click", () => {
  setQueueTab("history");
  renderQueue();
});
$("#btn-save-as-playlist")?.addEventListener("click", () => {
  diag("playlist", null, `${queue.length} tracks â€” saved to session only`);
});
$("#dac-menu-toggle")?.addEventListener("click", () => {
  $("#dac-dropdown")?.classList.toggle("hidden");
});

// ------------------------------------------------------------- share + credits -
export const shareBtn = document.querySelector('[title="Share Session"]');
shareBtn?.addEventListener("click", async () => {
  const t = queue[queueIndex]?.track;
  const url = t ? `${location.origin}${location.pathname}#track=${t.id}` : location.href;
  const data = { title: "TRANCE MUSIC", text: t ? `Listening to "${t.title}"` : "TRANCE MUSIC", url };
  try {
    if (navigator.share) {
      await navigator.share(data);
      diag("share", true, "shared");
    } else {
      await navigator.clipboard.writeText(url);
      diag("share", true, "link copied to clipboard");
    }
  } catch (e) {
    diag("share", false, String(e).slice(0, 80));
  }
});
export const creditsBtn = document.querySelector('[title="Track Credits & Lineage"]');
creditsBtn?.addEventListener("click", () => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    diag("credits", false, "no track loaded");
    return;
  }
  const quality = current?.chosen_quality || "unknown";
  diag("credits", true, `${t.title} Â· ${quality}`);
  openCredits(t, quality);
});

