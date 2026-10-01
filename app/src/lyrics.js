// lyrics.js — lyrics fetch, render, sync
// Split from main.js (Phase 4 M1).
import { diag, invoke, toast } from "./core.js";
import { $, $$, audio, np } from "./dom.js";
import { toggleFavTrack } from "./library.js";
import { queue, queueIndex } from "./queue.js";
import { downloadTrack } from "./vault.js";

// ------------------------------------------------------------------ lyrics -
export let lyricLines = $$(".lyric-line");
export let autoScrollLyrics = true;
/// Bumped on every track change so a slow fetch never paints over a newer one.
export let lyricToken = 0;

/// Class strings the static demo markup uses — rendered lines must match them
/// so the sync highlight, hover and cursor styles keep working.
export const LYRIC_LINE_CLASS =
  "lyric-line group flex items-start gap-3 p-2.5 rounded-lg hover:bg-surface-container-low/70 transition-all duration-200 cursor-pointer text-neutral-400 select-none";
export const LYRIC_TEXT_CLASS =
  "lyric-text text-[15px] font-normal leading-relaxed transition-all duration-300";

/// The static markup ships demo lyrics; they are replaced on every track so
/// the stage never shows words that do not belong to the song.
export function setLyricsPlaceholder(msg = "Lyrics for this track are not loaded.") {
  const box = $("#lyrics-scroll-box");
  if (!box) return;
  const p = document.createElement("div");
  p.className = "py-8 text-center text-sm text-on-surface-variant font-mono";
  p.textContent = msg;
  box.replaceChildren(p);
  lyricLines = [];
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
  const addLine = (seconds, text) => {
    const line = document.createElement("div");
    line.className = LYRIC_LINE_CLASS;
    // Untimed lines carry no data-seconds: syncLyrics leaves them alone
    // instead of treating them as the last line of the song.
    if (seconds != null) line.dataset.seconds = String(seconds);
    const p = document.createElement("p");
    p.className = LYRIC_TEXT_CLASS;
    p.textContent = text;
    line.appendChild(p);
    box.appendChild(line);
  };
  if (synced.length) {
    for (const [seconds, text] of synced) addLine(seconds, text);
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
  syncLyrics();
}

export async function loadLyrics(track) {
  const token = ++lyricToken;
  setLyricsPlaceholder("Fetching lyrics…");
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

export function syncLyrics() {
  if (!lyricLines.length) return;
  const t = audio.currentTime;
  let active = null;
  for (const line of lyricLines) {
    const raw = line.dataset.seconds;
    if (raw == null) continue;
    if (parseFloat(raw) <= t) active = line;
  }
  for (const line of lyricLines) {
    const on = line === active;
    line.classList.toggle("text-on-surface", on);
    line.classList.toggle("text-neutral-400", !on);
  }
  if (active && autoScrollLyrics) {
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

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
  const lbl = $("#sync-mode-label");
  if (lbl) lbl.textContent = autoScrollLyrics ? "Auto-scroll on" : "Auto-scroll off";
});
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

