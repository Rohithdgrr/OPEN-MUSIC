// lyrics.js — karaoke lyrics for the mobile NowPlaying card.
//
// Port of the desktop's lyrics.js: synced lines, per-word wipe driven by
// --progress, rAF clock, tap-to-seek. The offset/fullscreen/auto-scroll tools
// stay desktop-only; the mobile card is a preview, not a stage.
import { audio } from "./player.js";

// Enhanced LRC carries per-word stamps: `[00:12.34]<00:12.34>Kesariya <00:12.89>tera`.
// Rust's LRC parser keeps the text after the line stamp, tags included, so the
// words are split out here and each span's fill is driven by --progress.
const WORD_TAG = /<(\d{1,2}):(\d{2}(?:\.\d+)?)>/;
const LINE_CLASS = "lyric-line px-2 py-1 rounded-lg cursor-pointer select-none";
const TEXT_CLASS = "lyric-text text-[13px] leading-relaxed transition-all duration-300";

let box = null;
let lines = [];
let scrollTarget = null;
let raf = null;

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

// Line-level LRC has no per-word stamps, so words are spread evenly across the
// gap until the next line — that is what makes the karaoke wipe work for every
// source, not just enhanced LRC.
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

const wordsOf = (line) => (Array.isArray(line._words) ? line._words : []);

function addLine(seconds, text, endSeconds) {
  const line = document.createElement("div");
  line.className = LINE_CLASS;
  if (seconds != null) line.dataset.seconds = String(seconds);
  const p = document.createElement("p");
  p.className = TEXT_CLASS;
  const tagged = typeof text === "string" ? splitWords(text) : null;
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
}

/// Replace the card's contents with `data` ({ source, plain, synced, copyright }).
export function renderLyrics(target, data) {
  box = target;
  lines = [];
  scrollTarget = null;
  const synced = Array.isArray(data && data.synced) ? data.synced : [];
  const plain = data && typeof data.plain === "string" ? data.plain : "";
  if (!synced.length && !plain.trim()) {
    box.innerHTML = '<span class="font-body-sm text-secondary italic">No lyrics found</span>';
    stop();
    return;
  }
  box.replaceChildren();
  if (synced.length) {
    synced.forEach(([seconds, text], i) => {
      const nextT = i + 1 < synced.length ? synced[i + 1][0] : seconds + 4;
      addLine(seconds, text, nextT);
    });
  } else {
    for (const t of plain.split("\n")) if (t.trim()) addLine(null, t.trim(), null);
  }
  if (data && data.copyright) {
    const cr = document.createElement("div");
    cr.className = "pt-1 text-[10px] text-neutral-400 font-mono";
    cr.textContent = data.copyright;
    box.appendChild(cr);
  }
  lines = [...box.querySelectorAll(".lyric-line")];
  syncLyrics();
  if (!audio.paused) start();
}

/// Drop the current lyrics and stop the clock — called when NowPlaying unmounts
/// so the rAF loop never scrolls a detached tree.
export function resetLyrics() {
  stop();
  box = null;
  lines = [];
  scrollTarget = null;
}

export function syncLyrics() {
  if (!lines.length || !box || !box.isConnected) return;
  const t = audio.currentTime;
  let active = null;
  for (const line of lines) {
    const raw = line.dataset.seconds;
    if (raw == null) continue;
    if (parseFloat(raw) <= t) active = line;
  }
  for (const line of lines) {
    const on = line === active;
    const past = line.dataset.seconds != null && parseFloat(line.dataset.seconds) < t && !on;
    line.classList.toggle("lyric-active", on);
    line.classList.toggle("lyric-past", past);
    for (const w of wordsOf(line)) {
      const p = on ? Math.max(0, Math.min(1, (t - w.start) / Math.max(0.05, w.end - w.start))) : past ? 1 : 0;
      if (w.el) w.el.style.setProperty("--progress", `${Math.round(p * 100)}%`);
    }
  }
  if (active) {
    // Pin the active line near the top of the visible card. Measured against
    // the box's own rect so it works regardless of offset-parent chains.
    const top = Math.max(0, box.scrollTop + (active.getBoundingClientRect().top - box.getBoundingClientRect().top) - 8);
    if (scrollTarget !== top) {
      scrollTarget = top;
      box.scrollTo({ top, behavior: "smooth" });
    }
  }
}

// `timeupdate` fires ~4 times a second, which makes the karaoke wipe stutter.
// While the audio is playing, drive the highlight from rAF.
function tick() {
  syncLyrics();
  raf = requestAnimationFrame(tick);
}

function start() {
  if (raf == null) raf = requestAnimationFrame(tick);
}

function stop() {
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
}

audio.addEventListener("play", () => {
  if (lines.length) start();
});
audio.addEventListener("pause", () => {
  stop();
  syncLyrics();
});
audio.addEventListener("ended", () => {
  stop();
});

/// Tap any line to seek there.
document.addEventListener("click", (e) => {
  const line = e.target && e.target.closest ? e.target.closest(".lyric-line") : null;
  const seconds = line && line.dataset.seconds;
  if (seconds == null || !box || !box.contains(line) || !audio.src) return;
  audio.currentTime = parseFloat(seconds);
  if (audio.paused) audio.play().catch(() => {});
  syncLyrics();
});
