// transport.js — transport controls, modes, volume, queue extras, share/credits
// Split from main.js (Phase 4 M1).
import { emitState } from "./bridge.js";
import { diag, openCredits, showError, showView, toast } from "./core.js"; // esc, invoke: Bluetooth parked
import { $, audio, bar } from "./dom.js";
import { loadPlays } from "./home.js";
import { createLocalPl, openPicker } from "./library.js";
import { playQueueItem } from "./playback.js";
import { current, pickNextIndex, queue, queueIndex, renderQueue, repeatMode, setQueueIndex, setQueueTab, setRepeatMode, setShuffleMode, shuffleMode } from "./queue.js";
import { arm as armSleep } from "./sleep.js";

// --------------------------------------------------------------- transport -
export async function togglePlay() {
  if (!audio.src) {
    // Fresh open: either a restored queue (no autoplay) or the last played
    // track as a one-track seed.
    if (queue.length) {
      playQueueItem(queueIndex >= 0 && queueIndex < queue.length ? queueIndex : 0);
      return;
    }
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

export function step(dir) {
  const next =
    dir > 0 ? pickNextIndex() : queueIndex - 1 >= 0 ? queueIndex - 1 : -1;
  if (next >= 0) playQueueItem(next);
}
bar.prev.addEventListener("click", () => step(-1));
bar.next.addEventListener("click", () => step(1));

export function paintModes() {
  for (const el of [bar.shuffle]) {
    if (el) el.style.opacity = shuffleMode ? "1" : "";
  }
  const glyph = repeatMode === "one" ? "repeat_one" : "repeat";
  for (const el of [bar.repeat]) {
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
bar.repeat.addEventListener("click", toggleRepeat);

export function seekFromEvent(track, e) {
  const r = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
}
bar.progress.addEventListener("click", (e) => seekFromEvent(bar.progress, e));

export function paintVolume() {
  bar.volFill.style.width = `${(audio.volume * 100).toFixed(0)}%`;
  emitState();
}
export function volFromEvent(track, e) {
  const r = track.getBoundingClientRect();
  audio.volume = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  audio.muted = false;
  paintVolume();
}

bar.volTrack.addEventListener("click", (e) => volFromEvent(bar.volTrack, e));

bar.queue.addEventListener("click", () => {
  setQueueTab("next");
  renderQueue();
  showView("now-playing");
});

// -------------------------------------------------------------- bluetooth -
// Parked on request: the mini player Bluetooth button + panel are hidden in
// index.html (<!-- BT -->) and the Rust commands (bluetooth_devices,
// open_bluetooth_settings) are unregistered. Uncomment both to restore.
// WebView2 has no Web Bluetooth, so this only listed what Windows already had
// paired and handed pairing to Settings anyway.
//
// const btPanel = $("#bt-panel");
// const btList = $("#bt-list");
//
// function paintBtList(devices) {
//   if (!btList) return;
//   if (!devices.length) {
//     btList.innerHTML =
//       '<p class="text-[12px] text-on-surface-variant px-1 py-2">No paired Bluetooth devices found.</p>';
//     return;
//   }
//   btList.innerHTML = devices
//     .map(
//       (d) => `
//     <div class="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-container-low transition-colors">
//       <span class="flex items-center gap-2 min-w-0">
//         <span class="material-symbols-outlined text-[16px] text-on-surface-variant">speaker</span>
//         <span class="truncate">${esc(d.name)}</span>
//       </span>
//       <span class="font-label-mono text-[10px] text-on-surface-variant shrink-0">${esc(d.address)}</span>
//     </div>`,
//     )
//     .join("");
// }
//
// async function loadBtDevices() {
//   if (!btList) return;
//   btList.innerHTML =
//     '<p class="text-[12px] text-on-surface-variant px-1 py-2">Reading paired devices&hellip;</p>';
//   try {
//     paintBtList(await invoke("bluetooth_devices"));
//   } catch (e) {
//     if (btList) {
//       btList.innerHTML = `<p class="text-[12px] text-red-600 px-1 py-2">Could not read devices: ${esc(String(e))}</p>`;
//     }
//     diag("bluetooth", false, String(e));
//   }
// }
//
// function setBtPanel(open) {
//   if (!btPanel) return;
//   btPanel.classList.toggle("hidden", !open);
//   bar.bt?.setAttribute("aria-expanded", String(open));
//   if (open) loadBtDevices();
// }
//
// bar.bt?.addEventListener("click", (e) => {
//   e.stopPropagation();
//   setBtPanel(btPanel?.classList.contains("hidden") ?? true);
// });
// $("#bt-close")?.addEventListener("click", () => setBtPanel(false));
// $("#bt-settings")?.addEventListener("click", () => {
//   invoke("open_bluetooth_settings").catch((err) => diag("bluetooth", false, String(err)));
// });
// // Click-away / Escape, the same contract every popover in the app follows.
// document.addEventListener("click", (e) => {
//   if (!btPanel || btPanel.classList.contains("hidden")) return;
//   if (btPanel.contains(e.target) || bar.bt?.contains(e.target)) return;
//   setBtPanel(false);
// });

// ------------------------------------------------------------ queue extras -
/// Recency-weighted, artist-aware shuffle: never the same artist within 3
/// slots when the queue allows it, and tracks played recently sink toward
/// the back. Replaces the plain Fisher-Yates in the shuffle-queue button.
export function smartShuffleQueue() {
  if (queue.length < 2) return;
  const recent = new Set(loadPlays().slice(0, 15).map((t) => t.id));
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
      const artist = String(it.track.artist || "").toLowerCase();
      let score = Math.random() * 0.9;
      if (recent.has(it.track.id)) score += 100;
      for (let w = 1; w <= 3 && w <= placed.length; w++) {
        if (String(placed[placed.length - w].track.artist || "").toLowerCase() === artist) {
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
  setQueueIndex(-1);
  renderQueue();
  diag("queue", null, "shuffled (artist-aware)");
}
$("#btn-shuffle-queue")?.addEventListener("click", smartShuffleQueue);
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
  if (!queue.length) {
    toast("The queue is empty.", "info");
    return;
  }
  const suggestion = `Queue ${new Date().toLocaleDateString()}`;
  const answer = window.prompt("Save queue as playlist", suggestion);
  if (answer === null) return;
  const pl = createLocalPl(answer.trim() || suggestion, queue.map((q) => q.track));
  if (!pl) return;
  toast(`Saved ${queue.length} tracks to "${pl.title}".`);
  diag("playlist", true, `${queue.length} tracks -> ${pl.title}`);
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
      toast("Link copied to clipboard.", "success", 2500);
      diag("share", true, "link copied to clipboard");
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
    diag("share", false, String(e).slice(0, 80));
  }
});
// Now Playing "Add to playlist" (bookmark icon next to download).
$("#np-add-btn")?.addEventListener("click", () => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    toast("Nothing is playing yet — start a track first.", "info");
    return;
  }
  openPicker(t);
});
export const creditsBtn = document.querySelector('[title="Track Credits & Lineage"]');
creditsBtn?.addEventListener("click", () => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    diag("credits", false, "no track loaded");
    return;
  }
  const quality = current?.chosen_quality || "unknown";
  diag("credits", true, `${t.title} · ${quality}`);
  openCredits(t, quality);
});

// --------------------------------------------------- sleep timer + speed -
// Sleep: one-shot pause after N minutes, fading out over the last 15s (sleep.js
// is shared with the mobile shell). Re-picking replaces the timer; "Off"
// cancels. Speed mirrors Settings → Playback (same tm-play-speed key).
const sleepSel = $("#np-sleep");
if (sleepSel) {
  sleepSel.addEventListener("change", () => {
    const mins = Number(sleepSel.value);
    const total = armSleep(mins, audio, ({ done }) => {
      paintVolume(); // follow the fade
      if (!done) return;
      toast("Sleep timer — playback stopped.", "info", 4000);
      diag("sleep", true, "stopped");
      if (sleepSel.isConnected) sleepSel.value = "0";
    });
    if (!total) {
      toast("Sleep timer off.", "info", 2500);
      return;
    }
    toast(`Sleep timer: stops in ${mins} min.`, "info", 3000);
    diag("sleep", null, `${mins}m armed`);
  });
}
const speedSel = $("#np-speed");
if (speedSel) {
  try {
    const cur = localStorage.getItem("tm-play-speed") || "1";
    if ([...speedSel.options].some((o) => o.value === cur)) speedSel.value = cur;
  } catch {}
  speedSel.addEventListener("change", () => {
    try {
      localStorage.setItem("tm-play-speed", speedSel.value);
    } catch {}
    const v = Number(speedSel.value) || 1;
    for (const a of [audio, document.getElementById("audio2")].filter(Boolean)) {
      try {
        a.playbackRate = v;
        a.preservesPitch = true;
      } catch {}
    }
    toast(`Playback speed ${v}x.`, "info", 2500);
  });
}

