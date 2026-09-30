// queue.js — queue state, queue rendering, enqueue/advance
// Split from main.js (Phase 4 M1).
import { art } from "./art.js";
import { emitState } from "./bridge.js";
import { esc, toast } from "./core.js";
import { $ } from "./dom.js";
import { favFill, toggleFavTrack } from "./library.js";
import { playQueueItem } from "./playback.js";
import { ensureReco } from "./radio.js";
import { addBtn, contentIndex, findDuplicate } from "./search.js";
import { metaLinks } from "./util.js";
import { downloadTrack } from "./vault.js";

// -------------------------------------------------------------------- queue -
export const queue = []; // { track, state: null | "done" | "failed" }
export let queueIndex = -1;
export let advancing = false;
export let current = null; // PlayableAudio
/// What the bar restored at boot, so the desktop card can show it before
/// anything plays. A live queue entry always wins over it.
export let restoredTrack = null;
export let shuffleMode = false;
export let repeatMode = "off"; // off | all | one
export const queueListEl = $("#queue-tracks-list");
export const queueCountEl = $("#queue-count-badge");
export let queueTab = "next";

// Rebuilding the queue is O(rows) DOM work, and state changes arrive in
// bursts (download progress, markQueue, radio top-ups) — coalesce them into
// one paint per frame instead of one per call.
export let renderQueueFrame = 0;
export function renderQueue() {
  if (renderQueueFrame) return;
  renderQueueFrame = requestAnimationFrame(() => {
    renderQueueFrame = 0;
    renderQueueNow();
  });
}

export function renderQueueNow() {
  queueListEl.innerHTML = "";
  const visible = queue
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) =>
      queueTab === "history" ? item.state === "done" : i >= Math.max(queueIndex, 0),
    );
  for (const { item, i } of visible) {
    const t = item.track;
    const div = document.createElement("div");
    div.className =
      "queue-item group relative flex items-center justify-between p-2.5 rounded-xl hover:bg-surface-container-low border border-transparent hover:border-black/[0.04] transition-all cursor-pointer" +
      (i === queueIndex ? " bg-surface-container-low" : "");
    div.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative w-12 h-12 rounded-lg bg-surface-container overflow-hidden flex-shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image)} />
        </div>
        <div class="flex flex-col min-w-0">
          <span class="text-[13px] text-on-surface font-semibold truncate">${esc(t.title)}</span>
          <span class="text-xs text-on-surface-variant truncate">${metaLinks(t)}</span>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="font-mono text-[10px] text-on-surface-variant">${i === queueIndex ? (item.state === "done" ? "played" : item.state === "failed" ? "failed" : "playingâ€¦") : item.state === "done" ? "played" : item.state === "failed" ? "failed" : item.reco ? "recommended" : ""}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button type="button" data-q-fav="${i}" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container-low flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[16px]" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
        </button>
        <button type="button" data-q-dl="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-low flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[16px]">download</span>
        </button>
        ${addBtn(t)}
        <span class="font-mono text-[10px] text-on-surface-variant">${esc(t.duration)}</span>
      </div>`;
    div.addEventListener("click", () => playQueueItem(i));
    queueListEl.appendChild(div);
  }
  if (queueCountEl) queueCountEl.textContent = String(queue.length);
    const barCount = $("#queue-count-badge-bar");
    if (barCount) barCount.textContent = String(queue.length);
    paintQueueTabs();
    emitState();
  }

export function paintQueueTabs() {
  const next = $("#queue-tab-next");
  const hist = $("#queue-tab-history");
  const active = "px-3 py-1 rounded-md bg-primary text-on-primary text-xs font-medium shadow-sm transition-all";
  const inactive = "px-3 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface transition-all";
  if (next) next.className = queueTab === "next" ? active : inactive;
  if (hist) hist.className = queueTab === "history" ? active : inactive;
}

// Queue rows re-render on every state change, so download clicks are
// intercepted on the persistent list. Capture phase is required: each row
// also listens for clicks (to start playback) and would fire first.
queueListEl.addEventListener(
  "click",
  (e) => {
    const fav = e.target.closest("[data-q-fav]");
    if (fav) {
      e.stopPropagation();
      e.preventDefault();
      const item = queue[Number(fav.dataset.qFav)];
      if (item) toggleFavTrack(item.track);
      return;
    }
    const btn = e.target.closest("[data-q-dl]");
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    const item = queue[Number(btn.dataset.qDl)];
    if (item) downloadTrack(item.track, btn);
  },
  true,
);

export function enqueue(track) {
  const existing = queue.findIndex((q) => q.track.id === track.id);
  if (existing >= 0) return existing;
  // A different-id copy of the same recording must not stack up either.
  const dup = findDuplicate(contentIndex(queue.map((q) => q.track)), track);
  if (dup >= 0) return dup;
  queue.push({ track, state: null });
  renderQueue();
  return queue.length - 1;
}

export function markQueue(state) {
  if (queueIndex >= 0 && queue[queueIndex]) {
    queue[queueIndex].state = state;
    renderQueue();
  }
}

export function pickNextIndex() {
  if (shuffleMode && queue.length > 1) {
    let n = queueIndex;
    while (n === queueIndex) n = Math.floor(Math.random() * queue.length);
    return n;
  }
  if (queueIndex + 1 < queue.length) return queueIndex + 1;
  if (repeatMode === "all" && queue.length) return 0;
  return -1;
}

export async function advanceQueue() {
  if (advancing) return;
  let next = pickNextIndex();
  // Out of queue with repeat off: never dead air â€” let the radio feed it.
  if (next < 0 && repeatMode === "off" && queue.length) {
    await ensureReco();
    next = pickNextIndex();
    if (next < 0) {
      toast("No more recommendations.", "info");
      return;
    }
  }
  if (next < 0) return;
  advancing = true;
  setTimeout(() => {
    advancing = false;
    playQueueItem(next);
  }, 600);
}


// Setters for state rebound from other modules (ESM imports are read-only).
export function setQueueIndex(v) { queueIndex = v; }
export function setShuffleMode(v) { shuffleMode = v; }
export function setRepeatMode(v) { repeatMode = v; }
export function setQueueTab(v) { queueTab = v; }
export function setCurrent(v) { current = v; }
export function setRestoredTrack(v) { restoredTrack = v; }
