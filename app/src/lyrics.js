// lyrics.js — lyrics fetch, render, sync
// Split from main.js (Phase 4 M1).
import { diag, invoke, toast } from "./core.js";
import { $, $$, audio, np } from "./dom.js";
import { toggleFavTrack } from "./library.js";
import { queue, queueIndex } from "./queue.js";
import { downloadTrack } from "./vault.js";

export let lyricLines = $$(".lyric-line");
export let autoScrollLyrics = true;
/// Last scrollTop we asked for — syncLyrics runs every rAF frame, so the
/// smooth scroll is only issued when the target line (or its offset) changes.
let scrollTarget = null;
/// Bumped on every track change so a slow fetch never paints over a newer one.
export let lyricToken = 0;

export const LYRIC_LINE_CLASS =
  "lyric-line group flex items-start gap-3 p-2.5 rounded-lg hover:bg-surface-container-low/70 transition-all duration-200 cursor-pointer text-neutral-400 select-none";
export const LYRIC_TEXT_CLASS =
  "lyric-text text-[15px] font-normal leading-relaxed transition-all duration-300";

// ------------------------------------------------------------ offset tool -
// Users can nudge the highlight per track; the choice is kept forever,
// keyed by track id, and clamped to ±2s.
const OFFSETS_KEY = "tm-lyrics-offsets";
export let lyricOffsetMs = 0;
let currentTrackId = null;

function loadOffsets() {
  try {
    return JSON.parse(localStorage.getItem(OFFSETS_KEY) || "{}");
  } catch {
    return {};
  }
}
export function setLyricOffset(ms) {
  lyricOffsetMs = Math.max(-2000, Math.min(2000, Math.round(ms)));
  if (currentTrackId) {
    const all = loadOffsets();
    all[currentTrackId] = lyricOffsetMs;
    try {
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(all));
    } catch {}
  }
  const lbl = $("#lyric-offset-label");
  if (lbl) lbl.textContent = `${lyricOffsetMs > 0 ? "+" : ""}${lyricOffsetMs}ms`;
  syncLyrics();
}

// --------------------------------------------------------- karaoke render -
// Enhanced LRC carries per-word stamps: `[00:12.34]<00:12.34>Kesariya <00:12.89>tera`.
// Rust's LRC parser keeps the text after the line stamp, tags included, so the
// words are split out here and each span's fill is driven by --progress.
const WORD_TAG = /<(\d{1,2}):(\d{2}(?:\.\d+)?)>/;

function splitWords(text) {
  if (!WORD_TAG.test(text)) return null;
  const parts = text.split(WORD_TAG);
  // split keeps the capture groups: [before, mm, ss, text, mm, ss, text...]
  const words = [];
  for (let i = 3; i < parts.length + 1; i += 3) {
    const mm = Number(parts[i - 2]);
    const ss = Number(parts[i - 1]);
    const chunk = (parts[i] || "").trim();
    if (chunk) words.push({ start: mm * 60 + ss, text: chunk });
  }
  for (let i = 0; i < words.length - 1; i++) words[i].end = words[i + 1].start;
  return words.length ? words : null;
}

function lyricWords(line) {
  return Array.isArray(line._words) ? line._words : [];
}

// ------------------------------------------------------------- placeholders -
export function setLyricsPlaceholder(msg = "Lyrics for this track are not loaded.") {
  const box = $("#lyrics-scroll-box");
  if (!box) return;
  const p = document.createElement("div");
  p.className = "py-8 text-center text-sm text-on-surface-variant font-mono";
  p.textContent = msg;
  box.replaceChildren(p);
  lyricLines = [];
  scrollTarget = null;
}

function fallbackWords(text, seconds, endSeconds) {
  if (typeof text !== "string" || seconds == null) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const dur = Math.max(0.8, endSeconds != null ? endSeconds - seconds : 4);
  return parts.map((w, i) => ({
    start: seconds + (i / parts.length) * dur,
    end: seconds + ((i + 1) / parts.length) * dur,
    text: w,
  }));
}

export function renderLyrics(data) {
  const box = $("#lyrics-scroll-box");
  if (!box) return;
  const synced = Array.isArray(data.synced) ? data.synced : [];
  const plain = typeof data.plain === "string" ? data.plain : "";
  if (!synced.length && !plain.trim()) {
    setLyricsPlaceholder();
    return;
  }
  box.replaceChildren();
  const addLine = (seconds, text, endSeconds = null) => {
    const line = document.createElement("div");
    line.className = LYRIC_LINE_CLASS;
    if (seconds != null) line.dataset.seconds = String(seconds);
    const p = document.createElement("p");
    p.className = LYRIC_TEXT_CLASS;
    const tagged = typeof text === "string" ? splitWords(text) : null;
    // Line-level LRC has no per-word stamps, so words are spread evenly
    // across the gap until the next line — that is what makes the karaoke
    // wipe work for every source, not just enhanced LRC.
    const words = tagged || fallbackWords(text, seconds, endSeconds);
    if (words && seconds != null) {
      line._words = words.map(() => null);
      words.forEach((w, i) => {
        const span = document.createElement("span");
        span.className = "lyric-word";
        span.textContent = w.text + " ";
        line._words[i] = {
          el: span,
          start: w.start,
          end: i + 1 < words.length ? words[i + 1].start : endSeconds != null ? endSeconds : (seconds ?? 0) + 4,
        };
        p.appendChild(span);
      });
    } else {
      p.textContent = text;
    }
    line.appendChild(p);
    box.appendChild(line);
  };
  if (synced.length) {
    let prevT = null;
    synced.forEach(([seconds, text], i) => {
      if (prevT != null && seconds - prevT > 6) addBreak();
      const nextT = i + 1 < synced.length ? synced[i + 1][0] : seconds + 4;
      addLine(seconds, text, nextT);
      prevT = seconds;
    });
  } else {
    for (const text of plain.split("\n")) {
      if (text.trim()) addLine(null, text.trim());
    }
  }
  if (data.copyright) {
    const cr = document.createElement("div");
    cr.className = "pt-2 text-[11px] text-neutral-400 font-mono";
    cr.textContent = data.copyright;
    box.appendChild(cr);
  }
  lyricLines = $$(".lyric-line", box);
  scrollTarget = null;
  syncLyrics();
}

function addBreak() {
  const box = $("#lyrics-scroll-box");
  const div = document.createElement("div");
  div.className = "lyric-break flex items-center gap-1.5 py-2 pl-2.5 text-neutral-400 font-mono text-xs";
  div.textContent = "♪ ♪ ♪";
  box.appendChild(div);
}

export async function loadLyrics(track) {
  const token = ++lyricToken;
  currentTrackId = track.id || null;
  const stored = currentTrackId ? Number(loadOffsets()[currentTrackId]) : NaN;
  lyricOffsetMs = Number.isFinite(stored) ? Math.max(-2000, Math.min(2000, stored)) : 0;
  const offLbl = $("#lyric-offset-label");
  if (offLbl) offLbl.textContent = `${lyricOffsetMs > 0 ? "+" : ""}${lyricOffsetMs}ms`;
  const box = $("#lyrics-scroll-box");
  if (box) {
    box.replaceChildren();
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement("div");
      bar.className = "lyric-skeleton h-4 rounded-md animate-pulse bg-surface-container-high";
      bar.style.width = `${72 - i * 13}%`;
      box.appendChild(bar);
    }
    lyricLines = [];
    scrollTarget = null;
  }
  let data = null;
  try {
    data = await invoke("get_lyrics", {
      id: track.id,
      title: track.title,
      artist: track.artist || "",
      album: track.album || "",
      duration: track.duration_secs || 0,
    });
  } catch (e) {
    diag("lyrics", false, String(e).slice(0, 120));
  }
  if (token !== lyricToken) return;
  if (data) {
    renderLyrics(data);
    diag("lyrics", data.source !== "none", data.source);
  } else {
    setLyricsPlaceholder();
  }
}

export function prefetchLyrics(track) {
  if (!track || !track.id) return;
  invoke("get_lyrics", {
    id: track.id,
    title: track.title,
    artist: track.artist || "",
    album: track.album || "",
    duration: track.duration_secs || 0,
  }).catch(() => {});
}

export function syncLyrics() {
  if (!lyricLines.length) return;
  const t = audio.currentTime + lyricOffsetMs / 1000;
  let active = null;
  for (const line of lyricLines) {
    const raw = line.dataset.seconds;
    if (raw == null) continue;
    if (parseFloat(raw) <= t) active = line;
  }
  for (const line of lyricLines) {
    const on = line === active;
    const past = line.dataset.seconds != null && parseFloat(line.dataset.seconds) < t && !on;
    line.classList.toggle("lyric-active", on);
    line.classList.toggle("lyric-past", past);
    line.classList.toggle("text-on-surface", on);
    line.classList.toggle("text-neutral-400", !on);
    for (const w of lyricWords(line)) {
      const p = on
        ? Math.max(0, Math.min(1, (t - w.start) / Math.max(0.05, w.end - w.start)))
        : past
          ? 1
          : 0;
      if (w.el) w.el.style.setProperty("--progress", `${Math.round(p * 100)}%`);
    }
  }
  if (active && autoScrollLyrics) {
    const box = $("#lyrics-scroll-box");
    if (box) {
      // Pin the active line to the TOP of the box (minus the py-4 gap).
      // scrollIntoView "nearest" only nudged it into view — usually leaving
      // it at the bottom edge — so the lyrics appeared to sink as they sang.
      const top = Math.max(0, active.offsetTop - 16);
      if (scrollTarget !== top) {
        scrollTarget = top;
        box.scrollTo({ top, behavior: "smooth" });
      }
    } else {
      active.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
}

// `timeupdate` fires ~4 times a second, which makes the karaoke wipe stutter.
// While the audio is playing, drive the highlight from rAF so it tracks the
// playhead frame by frame; pause/end falls back to the last exact state.
let lyricsRaf = null;
function lyricsTick() {
  syncLyrics();
  lyricsRaf = requestAnimationFrame(lyricsTick);
}
audio.addEventListener("play", () => {
  if (lyricsRaf == null) lyricsRaf = requestAnimationFrame(lyricsTick);
});
audio.addEventListener("pause", () => {
  if (lyricsRaf != null) cancelAnimationFrame(lyricsRaf);
  lyricsRaf = null;
  syncLyrics();
});
audio.addEventListener("ended", () => {
  if (lyricsRaf != null) cancelAnimationFrame(lyricsRaf);
  lyricsRaf = null;
});

/// Click any line to seek there — the footer promises it.
$("#lyrics-scroll-box")?.addEventListener("click", (e) => {
  const line = e.target.closest(".lyric-line");
  const seconds = line?.dataset.seconds;
  if (seconds == null || !audio.src) return;
  audio.currentTime = parseFloat(seconds);
  if (audio.paused) audio.play().catch(() => {});
  syncLyrics();
});

$("#toggle-sync-mode")?.addEventListener("click", () => {
  autoScrollLyrics = !autoScrollLyrics;
  scrollTarget = null;
  const lbl = $("#sync-mode-label");
  if (lbl) lbl.textContent = autoScrollLyrics ? "Auto-scroll on" : "Auto-scroll off";
});
$("#lyric-offset-minus")?.addEventListener("click", () => setLyricOffset(lyricOffsetMs - 100));
$("#lyric-offset-plus")?.addEventListener("click", () => setLyricOffset(lyricOffsetMs + 100));
$("#lyric-offset-reset")?.addEventListener("click", () => setLyricOffset(0));
$("#toggle-translation-btn")?.addEventListener("click", () => {
  for (const sub of $$(".lyric-subtext")) sub.classList.toggle("hidden");
});
$("#btn-fullscreen-lyrics")?.addEventListener("click", () => {
  const card = $("#lyrics-card");
  if (!card) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else card.requestFullscreen?.().catch(() => {});
});
np.fav?.addEventListener("click", () => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    toast("Nothing is playing yet — start a track first.", "info");
    return;
  }
  toggleFavTrack(t);
});
/// Now Playing download: saves whatever is currently loaded in the queue.
$("#np-download-btn")?.addEventListener("click", (e) => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    toast("Nothing is playing yet — start a track first.", "info");
    return;
  }
  downloadTrack(t, e.currentTarget);
});

