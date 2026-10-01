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
  // Off-DOM build, one attach: N live appends would reflow N times (4.2).
  const frag = document.createDocumentFragment();
  const visible = queue
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) =>
      queueTab === "history" ? item.state === "done" : i >= Math.max(queueIndex, 0),
    );
  for (const { item, i } of visible) {
    const t = item.track;
    const div = document.createElement("div");
    div.dataset.qI = String(i);
    div.draggable = queueTab === "next" && i > queueIndex;
    div.className =
      "queue-item group relative flex items-center justify-between p-2.5 rounded-xl hover:bg-surface-container-low border border-transparent hover:border-black/[0.04] transition-all " +
      (div.draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer") +
      (i === queueIndex ? " bg-surface-container-low" : "");
    div.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative w-12 h-12 rounded-lg bg-surface-container overflow-hidden flex-shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image)} />
        </div>
        <div class="flex flex-col min-w-0">
          <span class="text-[13px] text-on-surface font-semibold truncate" dir="auto">${esc(t.title)}</span>
          <span class="text-xs text-on-surface-variant truncate">${metaLinks(t)}</span>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="font-mono text-[10px] text-on-surface-variant">${i === queueIndex ? (item.state === "done" ? "played" : item.state === "failed" ? "failed" : "playing…") : item.state === "done" ? "played" : item.state === "failed" ? "failed" : item.reco ? "recommended" : ""}</span>
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
    frag.appendChild(div);
  }
  queueListEl.innerHTML = "";
  queueListEl.appendChild(frag);
    if (queueCountEl) queueCountEl.textContent = String(queue.length);
    const barCount = $("#queue-count-badge-bar");
    if (barCount) barCount.textContent = String(queue.length);
    paintQueueTabs();
    emitState();
    persistQueue();
  }

// ------------------------------------------------------------ persistence -
// The queue is rebuilt from localStorage on boot (main.js) so a restart
// lands you back on the same session. Every mutation funnels through
// renderQueue(), so persisting there covers enqueue, play-next, DnD moves,
// advance, shuffle, clear and the direct rewrites in playTracksAt.
const QUEUE_KEY = "tm-queue";
const QUEUE_CAP = 200;
let persistTimer = 0;
function persistQueue() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify({ i: queueIndex, shuffle: shuffleMode, repeat: repeatMode, q: queue.slice(0, QUEUE_CAP) }),
      );
    } catch {}
  }, 400);
}

/// Restore a saved queue without autoplaying. Returns true when one was
/// loaded, so the boot path can skip the single-track "last played" seed.
export function restoreQueue() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || "null");
  } catch {
    return false;
  }
  if (!saved || !Array.isArray(saved.q)) return false;
  const items = saved.q.filter((it) => it && it.track && typeof it.track.id === "string");
  if (!items.length) return false;
  queue.push(...items);
  queueIndex = Math.min(Math.max(Number(saved.i) || -1, -1), queue.length - 1);
  shuffleMode = saved.shuffle === true;
  repeatMode = saved.repeat === "one" ? "one" : saved.repeat === "all" ? "all" : "off";
  return true;
}

export function paintQueueTabs() {
  const next = $("#queue-tab-next");
  const hist = $("#queue-tab-history");
  const active = "px-3 py-1 rounded-md bg-primary text-on-primary text-xs font-medium shadow-sm transition-all";
  const inactive = "px-3 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface transition-all";
  if (next) next.className = queueTab === "next" ? active : inactive;
  if (hist) hist.className = queueTab === "history" ? active : inactive;
}

// Queue rows re-render on every state change, so every click is handled on
// the persistent list — download/fav intercept first (capture), then a plain
// row click plays (delegation: one listener instead of one per row, review
// 4.2). Capture phase is required: the global document-capture handlers for
// add-to-playlist and entity links stop the click before this list runs.
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
    if (btn) {
      e.stopPropagation();
      e.preventDefault();
      const item = queue[Number(btn.dataset.qDl)];
      if (item) downloadTrack(item.track, btn);
      return;
    }
    const row = e.target.closest("[data-q-i]");
    if (row) playQueueItem(Number(row.dataset.qI));
  },
  true,
);

// ---------------------------------------------------------- drag reorder -
// Only upcoming rows drag (`draggable` is set in renderQueueNow), and the
// current entry's index rides along in moveQueue so a drop never changes
// which track is playing.
let dragFrom = -1;
let dragHl = null;
function setDragHl(row) {
  if (dragHl === row) return;
  dragHl?.classList.remove("bg-surface-container-low");
  dragHl = null;
  if (row && Number(row.dataset.qI) !== queueIndex) {
    row.classList.add("bg-surface-container-low");
    dragHl = row;
  }
}
queueListEl.addEventListener("dragstart", (e) => {
  const row = e.target.closest("[data-q-i]");
  if (!row || e.target.closest("button")) {
    e.preventDefault();
    return;
  }
  dragFrom = Number(row.dataset.qI);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragFrom));
});
queueListEl.addEventListener("dragover", (e) => {
  if (dragFrom < 0) return;
  const row = e.target.closest("[data-q-i]");
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  setDragHl(row);
});
queueListEl.addEventListener("drop", (e) => {
  if (dragFrom < 0) return;
  const row = e.target.closest("[data-q-i]");
  setDragHl(null);
  e.preventDefault();
  if (row) moveQueue(dragFrom, Number(row.dataset.qI));
  dragFrom = -1;
});
queueListEl.addEventListener("dragend", () => {
  setDragHl(null);
  dragFrom = -1;
});

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

/// "Play next": slot the track in right behind whatever is playing.
export function insertNext(track) {
  if (queueIndex < 0 || !queue[queueIndex]) return enqueue(track);
  queue.splice(queueIndex + 1, 0, { track, state: null });
  renderQueue();
  return queueIndex + 1;
}

/// Drag-reorder within the queue: keep the playing entry's index tracking
/// the item it points at so a drop across it never changes what's playing.
export function moveQueue(from, to) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  if (queueIndex === from) queueIndex = to;
  else if (from < queueIndex && to >= queueIndex) queueIndex -= 1;
  else if (from > queueIndex && to <= queueIndex) queueIndex += 1;
  renderQueue();
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
  // Out of queue with repeat off: never dead air — let the radio feed it.
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
