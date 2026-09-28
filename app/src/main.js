/* TRANCE MUSIC — frontend controller (vanilla ES module, no build step).
 *
 * Wires the three Stitch views (home / search / now-playing) to the Rust
 * backend: search_songs -> results, resolve_song -> badge -> <audio>,
 * plus queue, history, lyrics sync, telemetry and diagnostics.
 */

// Surface any uncaught error in the UI instead of dying silently.
window.addEventListener("error", (e) => {
  const banner = document.getElementById("error");
  if (banner) {
    banner.textContent = "JS error: " + (e.message || "unknown");
    banner.classList.remove("hidden");
  }
  console.error("[TRANCE MUSIC]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  const banner = document.getElementById("error");
  if (banner) {
    banner.textContent = "Async error: " + String(e.reason).slice(0, 300);
    banner.classList.remove("hidden");
  }
});

// Tauri 2 exposes the IPC on window.__TAURI_INTERNALS__ (always injected);
// window.__TAURI__ only exists when withGlobalTauri is enabled.
const invoke =
  window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
if (!invoke) {
  const banner = document.getElementById("error");
  if (banner) {
    banner.textContent =
      "Tauri IPC unavailable (window.__TAURI_INTERNALS__ missing). Backend commands will not work.";
    banner.classList.remove("hidden");
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- views ---
const views = $$("[data-view]");
const navLinks = $$("header nav a[data-path]");
const ACTIVE = ["bg-primary", "text-on-primary"];

function showView(name) {
  for (const v of views) v.classList.toggle("hidden", v.dataset.view !== name);
  for (const a of navLinks) {
    const on = a.dataset.path === name;
    a.classList.remove(...ACTIVE);
    if (on) a.classList.add(...ACTIVE);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  diag("view", null, name);
}
for (const a of navLinks) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    showView(a.dataset.path);
  });
}

// ------------------------------------------------------------- diagnostics -
const diagEl = $("#diag");
function diag(step, ok, detail) {
  if (!diagEl) return;
  const li = document.createElement("li");
  li.className =
    "font-mono text-[11px] " +
    (ok === true ? "text-emerald-600" : ok === false ? "text-red-600" : "text-on-surface-variant");
  const t = new Date().toLocaleTimeString();
  li.textContent = detail ? `${t} ${step} — ${detail}` : `${t} ${step}`;
  diagEl.prepend(li);
  while (diagEl.children.length > 40) diagEl.lastChild.remove();
}

// ------------------------------------------------------------------ errors -
const errorEl = $("#error");
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}
function clearError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

// ------------------------------------------------------------------ history -
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("tm-history") || "[]");
  } catch {
    return [];
  }
}
const historyEl = $("#history");
function renderHistory() {
  historyEl.innerHTML = "";
  for (const q of loadHistory()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "px-3 py-1 rounded-full text-[12px] font-medium bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("#search-input").value = q;
      doSearch();
    });
    historyEl.appendChild(b);
  }
}
function pushHistory(q) {
  const h = [q, ...loadHistory().filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem("tm-history", JSON.stringify(h));
  } catch {}
  renderHistory();
}
renderHistory();

// -------------------------------------------------------------------- queue -
const queue = []; // { track, state: null | "done" | "failed" }
let queueIndex = -1;
let advancing = false;
let lastResults = [];
let current = null; // PlayableAudio
let shuffleMode = false;
let repeatMode = "off"; // off | all | one
let dspPreset = 0;
let crossfadeSecs = 4;

const queueListEl = $("#queue-tracks-list");
const queueCountEl = $("#queue-count-badge");
let queueTab = "next";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderQueue() {
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
          <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(t.image)}" onerror="this.style.display='none'" />
        </div>
        <div class="flex flex-col min-w-0">
          <span class="text-[13px] text-on-surface font-semibold truncate">${esc(t.title)}</span>
          <span class="text-xs text-on-surface-variant truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</span>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="font-mono text-[10px] text-on-surface-variant">${i === queueIndex ? (item.state === "done" ? "played" : item.state === "failed" ? "failed" : "playing…") : item.state === "done" ? "played" : item.state === "failed" ? "failed" : ""}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="font-mono text-[10px] text-on-surface-variant">${esc(t.duration)}</span>
      </div>`;
    div.addEventListener("click", () => playQueueItem(i));
    queueListEl.appendChild(div);
  }
  if (queueCountEl) queueCountEl.textContent = String(queue.length);
  const barCount = $("#queue-count-badge-bar");
  if (barCount) barCount.textContent = String(queue.length);
  paintQueueTabs();
}

function paintQueueTabs() {
  const next = $("#queue-tab-next");
  const hist = $("#queue-tab-history");
  const active = "px-3 py-1 rounded-md bg-primary text-on-primary text-xs font-medium shadow-sm transition-all";
  const inactive = "px-3 py-1 rounded-md text-xs font-medium text-on-surface-variant hover:text-on-surface transition-all";
  if (next) next.className = queueTab === "next" ? active : inactive;
  if (hist) hist.className = queueTab === "history" ? active : inactive;
}

function enqueue(track) {
  const existing = queue.findIndex((q) => q.track.id === track.id);
  if (existing >= 0) return existing;
  queue.push({ track, state: null });
  renderQueue();
  return queue.length - 1;
}

function markQueue(state) {
  if (queueIndex >= 0 && queue[queueIndex]) {
    queue[queueIndex].state = state;
    renderQueue();
  }
}

function pickNextIndex() {
  if (shuffleMode && queue.length > 1) {
    let n = queueIndex;
    while (n === queueIndex) n = Math.floor(Math.random() * queue.length);
    return n;
  }
  if (queueIndex + 1 < queue.length) return queueIndex + 1;
  if (repeatMode === "all" && queue.length) return 0;
  return -1;
}

function advanceQueue() {
  if (advancing) return;
  const next = pickNextIndex();
  if (next < 0) return;
  advancing = true;
  setTimeout(() => {
    advancing = false;
    playQueueItem(next);
  }, 600);
}

// ------------------------------------------------------------------ player -
const audio = $("#audio");
audio.volume = 0.75;

const bar = {
  cover: $("#bar-cover"),
  coverFallback: $("#bar-cover-fallback"),
  title: $("#bar-title"),
  artist: $("#bar-artist"),
  badge: $("#bar-badge"),
  play: $("#bar-play"),
  playIcon: $("#bar-play-icon"),
  shuffle: $("#bar-shuffle"),
  prev: $("#bar-prev"),
  next: $("#bar-next"),
  repeat: $("#bar-repeat"),
  progress: $("#bar-progress"),
  fill: $("#bar-progress-fill"),
  cur: $("#bar-time-cur"),
  total: $("#bar-time-total"),
  volTrack: $("#bar-vol-track"),
  volFill: $("#bar-vol-fill"),
  queue: $("#bar-queue"),
  telemetry: $("#bar-telemetry"),
};
const np = {
  badge: $("#np-badge"),
  format: $("#np-format"),
  play: $("#master-play-btn"),
  playIcon: $("#master-play-icon"),
  prev: $("#btn-prev"),
  next: $("#btn-next"),
  shuffle: $("#btn-shuffle"),
  repeat: $("#btn-repeat"),
  timeline: $("#timeline-bar"),
  buffered: $("#buffered-bar"),
  progress: $("#progress-bar"),
  thumb: $("#progress-thumb"),
  cur: $("#track-current"),
  total: $("#track-total"),
  title: $("#track-title-heading"),
  artist: $("#track-artist-heading"),
  cover: $("#master-album-cover"),
  vinyl: $("#spinning-vinyl-icon"),
  volTrack: $("#volume-track"),
  volFill: $("#volume-fill"),
  volMute: $("#vol-mute-btn"),
  volIcon: $("#vol-icon"),
  fav: $("#track-fav-btn"),
  favIcon: $("#fav-icon"),
};

/// One-line text fill for the Now Playing metadata tiles.
function npText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fmtBytes(n) {
  if (!n) return "?";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtTime(s) {
  if (!Number.isFinite(s)) return "00:00";
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function setPlayIcon(playing) {
  const glyph = playing ? "pause" : "play_arrow";
  bar.playIcon.textContent = glyph;
  if (np.playIcon) np.playIcon.textContent = glyph;
  if (np.vinyl) np.vinyl.style.animationPlayState = playing ? "running" : "paused";
}

function setBadge(status, info) {
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
  document.title = full
    ? "▶ " + bar.title.textContent
    : preview
      ? "◐ preview — " + bar.title.textContent
      : "✖ unreachable";
}

function telemetry(snapshot) {
  const err = audio.error ? ` error=${audio.error.code}` : "";
  const extra = current ? ` · ${current.chosen_quality} · ${current.host}` : "";
  const line =
    `${snapshot} readyState=${audio.readyState} ` +
    `t=${audio.currentTime.toFixed(1)}s / ${
      Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : "?"
    }s${extra}${err}`;
  if (bar.telemetry) bar.telemetry.textContent = line;
}

for (const [ev, label] of [
  ["playing", "playing"],
  ["pause", "paused"],
  ["waiting", "buffering"],
  ["ended", "ended"],
]) {
  audio.addEventListener(ev, () => {
    telemetry(label);
    if (ev === "playing" || ev === "pause") setPlayIcon(ev === "playing");
  });
}

audio.addEventListener("timeupdate", () => {
  telemetry(audio.paused ? "paused" : "playing");
  const d = audio.duration;
  const ratio = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
  bar.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  bar.cur.textContent = fmtTime(audio.currentTime);
  bar.total.textContent = fmtTime(d);
  if (np.progress) np.progress.style.width = `${(ratio * 100).toFixed(1)}%`;
  if (np.thumb) np.thumb.style.left = `${(ratio * 100).toFixed(1)}%`;
  if (np.cur) np.cur.textContent = fmtTime(audio.currentTime);
  if (np.total) np.total.textContent = fmtTime(d);
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

// ------------------------------------------------------------------ lyrics -
let lyricLines = $$(".lyric-line");
let autoScrollLyrics = true;

/// The static markup ships demo lyrics; they are replaced on every track so
/// the stage never shows words that do not belong to the song.
function setLyricsPlaceholder() {
  const box = $("#lyrics-scroll-box");
  if (!box) return;
  box.innerHTML =
    '<div class="py-8 text-center text-sm text-on-surface-variant font-mono">Lyrics for this track are not loaded.</div>';
  lyricLines = [];
}
function syncLyrics() {
  if (!lyricLines.length) return;
  const t = audio.currentTime;
  let active = null;
  for (const line of lyricLines) {
    const s = parseFloat(line.dataset.seconds || "0");
    if (s <= t) active = line;
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
  const filled = np.favIcon?.style.fontVariationSettings?.includes("1");
  if (np.favIcon) np.favIcon.style.fontVariationSettings = filled ? "'FILL' 0" : "'FILL' 1";
});

// --------------------------------------------------------------- transport -
async function togglePlay() {
  if (!audio.src) return;
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

function step(dir) {
  const next =
    dir > 0 ? pickNextIndex() : queueIndex - 1 >= 0 ? queueIndex - 1 : -1;
  if (next >= 0) playQueueItem(next);
}
bar.prev.addEventListener("click", () => step(-1));
bar.next.addEventListener("click", () => step(1));
np.prev?.addEventListener("click", () => step(-1));
np.next?.addEventListener("click", () => step(1));

function paintModes() {
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
function toggleShuffle() {
  shuffleMode = !shuffleMode;
  paintModes();
  diag("shuffle", null, shuffleMode ? "on" : "off");
}
function toggleRepeat() {
  repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
  paintModes();
  diag("repeat", null, repeatMode);
}
bar.shuffle.addEventListener("click", toggleShuffle);
np.shuffle?.addEventListener("click", toggleShuffle);
bar.repeat.addEventListener("click", toggleRepeat);
np.repeat?.addEventListener("click", toggleRepeat);
paintModes();

function seekFromEvent(track, e) {
  const r = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
}
bar.progress.addEventListener("click", (e) => seekFromEvent(bar.progress, e));
np.timeline?.addEventListener("click", (e) => seekFromEvent(np.timeline, e));

function paintVolume() {
  bar.volFill.style.width = `${(audio.volume * 100).toFixed(0)}%`;
  if (np.volFill) np.volFill.style.width = `${(audio.volume * 100).toFixed(0)}%`;
  const tip = $("#vol-val-tooltip");
  if (tip) tip.textContent = `${Math.round(audio.volume * 100)}%`;
}
function volFromEvent(track, e) {
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
});
paintVolume();

bar.queue.addEventListener("click", () => {
  queueTab = "next";
  renderQueue();
  showView("now-playing");
});

// ------------------------------------------------------------ queue extras -
$("#btn-shuffle-queue")?.addEventListener("click", () => {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  queueIndex = -1;
  renderQueue();
  diag("queue", null, "shuffled");
});
$("#btn-clear-queue")?.addEventListener("click", () => {
  audio.pause();
  queue.length = 0;
  queueIndex = -1;
  renderQueue();
  diag("queue", null, "cleared");
});
$("#queue-tab-next")?.addEventListener("click", () => {
  queueTab = "next";
  renderQueue();
});
$("#queue-tab-history")?.addEventListener("click", () => {
  queueTab = "history";
  renderQueue();
});
$("#btn-save-as-playlist")?.addEventListener("click", () => {
  diag("playlist", null, `${queue.length} tracks — saved to session only`);
});
$("#dac-menu-toggle")?.addEventListener("click", () => {
  $("#dac-dropdown")?.classList.toggle("hidden");
});

// ------------------------------------------------------------- dsp + crossfade -
const DSP_PRESETS = ["Flat EQ", "Bass Boost", "Vocal", "Treble", "Custom"];
const CROSSFADE_STEPS = [0, 4, 8, 12];
$("#btn-toggle-dsp")?.addEventListener("click", () => {
  dspPreset = (dspPreset + 1) % DSP_PRESETS.length;
  const label = document.querySelector("#btn-toggle-dsp span:last-child");
  if (label) label.textContent = DSP_PRESETS[dspPreset];
  diag("dsp", null, DSP_PRESETS[dspPreset]);
});
$("#btn-crossfade-mode")?.addEventListener("click", () => {
  const i = CROSSFADE_STEPS.indexOf(crossfadeSecs);
  crossfadeSecs = CROSSFADE_STEPS[(i + 1) % CROSSFADE_STEPS.length];
  const pill = $("#crossfade-pill-text");
  if (pill) pill.textContent = crossfadeSecs === 0 ? "XFADE: OFF" : `XFADE: ${crossfadeSecs}s`;
  diag("crossfade", null, `${crossfadeSecs}s`);
});

// ------------------------------------------------------------- share + credits -
const shareBtn = document.querySelector('[title="Share Session"]');
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
const creditsBtn = document.querySelector('[title="Track Credits & Lineage"]');
creditsBtn?.addEventListener("click", () => {
  const t = queue[queueIndex]?.track;
  if (!t) {
    diag("credits", false, "no track loaded");
    return;
  }
  const meta = [
    `Title: ${t.title}`,
    `Artist: ${t.artist || "Unknown"}`,
    `Album: ${t.album || "Unknown"}`,
    `Duration: ${fmtTime(t.duration || 0)}`,
    `Quality: ${current?.chosen_quality || "unknown"}`,
    `ID: ${t.id}`,
  ].join("\n");
  diag("credits", true, t.title);
  alert(meta);
});

// ---------------------------------------------------------------- playback -
audio.addEventListener("ended", () => {
  if (repeatMode === "one" && audio.src) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  markQueue("done");
  advanceQueue();
});

audio.addEventListener("error", () => {
  telemetry("error");
  if (audio.error) {
    showError(
      `Playback failed (media error ${audio.error.code}). ` +
        "The stream URL was refused by the browser media stack.",
    );
  }
  markQueue("failed");
  advanceQueue();
});

async function playQueueItem(index) {
  const item = queue[index];
  if (!item) return;
  queueIndex = index;
  renderQueue();
  const track = item.track;
  clearError();
  current = null;
  bar.title.textContent = track.title;
  bar.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
  if (np.title) np.title.textContent = track.title;
  if (np.artist) np.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
  npText("np-album", track.album || "—");
  npText("np-artist-tile", track.artist || "—");
  npText("np-length", track.duration || "—");
  npText("np-trackline", `TRACK ${String(index + 1).padStart(2, "0")} • STEREO DIRECT`);
  setLyricsPlaceholder();
  const setCover = (img, fallback) => {
    if (!img) return;
    if (track.image) {
      img.classList.remove("hidden");
      img.src = track.image;
      img.onerror = () => {
        img.classList.add("hidden");
        fallback?.classList.remove("hidden");
      };
      if (fallback) fallback.classList.add("hidden");
    } else {
      img.classList.add("hidden");
      fallback?.classList.remove("hidden");
    }
  };
  setCover(bar.cover, bar.coverFallback);
  setCover(np.cover, null);
  bar.badge.textContent = "RESOLVING";
  if (np.badge) np.badge.textContent = "RESOLVING…";

  let info;
  try {
    diag(`resolve ${track.id}`, null, track.title);
    info = await invoke("resolve_song", { id: track.id });
    diag(
      `resolve ${track.id}`,
      info.range_status === "unrestricted",
      `${info.chosen_quality} · ${info.host} · ${info.range_status}`,
    );
  } catch (err) {
    diag(`resolve ${track.id}`, false, String(err));
    showError(`Could not resolve "${track.title}": ${err}`);
    bar.badge.textContent = "UNRESOLVED";
    if (np.badge) np.badge.textContent = "UNRESOLVED";
    markQueue("failed");
    advanceQueue();
    return;
  }

  current = info;
  pushPlay(track);
  setBadge(info.range_status, info);
  renderQueue();
  diag(`play ${track.id}`, true, info.proxy_url.slice(0, 70) + "…");
  audio.src = info.proxy_url;
  try {
    await audio.play();
    setPlayIcon(true);
  } catch (e) {
    diag(`play ${track.id}`, false, String(e).slice(0, 120));
    showError(`Browser refused to start playback: ${e}`);
  }
}

// ------------------------------------------------------------------ search -
const resultsEl = $("#results");
const resultsSub = $("#results-sub");

function trackRow(t, i, isCurrent) {
  return `
  <div class="group grid grid-cols-12 gap-4 items-center px-4 py-3 rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-all cursor-pointer border border-surface-container-high" data-track-id="${esc(t.id)}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
    <div class="col-span-1 flex items-center justify-center">
      ${
        isCurrent
          ? `<div class="flex items-end gap-0.5 h-4 w-4">
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-2"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-4" style="animation-delay: 150ms;"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-3" style="animation-delay: 300ms;"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-1" style="animation-delay: 450ms;"></span>
             </div>`
          : `<span class="text-[12px] font-mono text-on-surface-variant">${String(i + 1).padStart(2, "0")}</span>`
      }
    </div>
    <div class="col-span-6 flex items-center gap-4 min-w-0">
      <div class="relative w-16 h-16 rounded-lg overflow-hidden shrink-0 shadow-sm bg-surface-container">
        <img loading="lazy" alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform" src="${esc(t.image)}" onerror="this.style.display='none'" />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-[15px] font-medium text-on-surface truncate">${esc(t.title)}</span>
        <span class="text-[13px] text-on-surface-variant truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</span>
      </div>
    </div>
    <div class="col-span-2 flex items-center gap-2">
      <span class="px-2 py-0.5 rounded bg-surface-container text-[11px] font-mono text-on-surface font-medium">${t.hq ? "320 kbps" : "Standard"}</span>
    </div>
    <div class="col-span-1 text-right text-[11px] font-mono text-on-surface-variant">—</div>
    <div class="col-span-1 text-right text-[12px] font-mono text-on-surface">${esc(t.duration)}</div>
    <div class="col-span-1 flex items-center justify-end gap-1">
      <button type="button" data-row-action="download" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface">download</span>
      </button>
      <button type="button" data-row-action="play" title="Play this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface">play_arrow</span>
      </button>
    </div>
  </div>`;
}

function renderResults(tracks) {
  resultsEl.innerHTML = "";
  tracks.forEach((t, i) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = trackRow(t, i, i === queueIndex && queue[queueIndex]?.track.id === t.id);
    const row = wrap.firstElementChild;
    row.addEventListener("click", (e) => {
      const action = e.target.closest("[data-row-action]")?.dataset.rowAction;
      if (action === "download") {
        e.stopPropagation();
        downloadTrack(t, e.target.closest("button"));
        return;
      }
      playTrack(t);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        playTrack(t);
      }
    });
    resultsEl.appendChild(row);
  });
  renderFeatured();
  updateLoadMore();
}

// ---------------------------------------------------- filters, order, pages -
const PAGE_SIZE = 20;
const FEATURED_PER_PAGE = 3;
const FILTERS = {
  all: () => true,
  hq: (t) => !!t.hq,
  long: (t) => t.duration_secs >= 300,
};
const SORTS = [
  { key: "bitrate", label: "Bitrate: Descending" },
  { key: "popular", label: "Popularity: Descending" },
  { key: "longest", label: "Duration: Longest" },
  { key: "title", label: "Title: A–Z" },
];
let activeFilter = "all";
let sortIndex = 0;
let searchPage = 1;
let searchQuery = "";
let loadingMore = false;
let searchExhausted = false;
let featuredPage = 0;

/// The tracks the table and the featured cards show right now.
function currentView() {
  const keep = FILTERS[activeFilter] || FILTERS.all;
  const list = lastResults.filter(keep);
  const by = SORTS[sortIndex].key;
  return list.sort((a, b) => {
    if (by === "bitrate") {
      return (b.hq ? 1 : 0) - (a.hq ? 1 : 0) || b.plays - a.plays;
    }
    if (by === "popular") return b.plays - a.plays;
    if (by === "longest") return b.duration_secs - a.duration_secs;
    return a.title.localeCompare(b.title);
  });
}

function refreshResults() {
  const list = currentView();
  renderResults(list);
  if (!lastResults.length) return;
  if (!list.length) {
    resultsSub.textContent = `No results match this filter (of ${lastResults.length} for "${searchQuery}").`;
  } else if (list.length === lastResults.length) {
    resultsSub.textContent = `Showing ${list.length} results for "${searchQuery}"`;
  } else {
    resultsSub.textContent = `Showing ${list.length} of ${lastResults.length} results for "${searchQuery}"`;
  }
}

function paintChips() {
  for (const chip of $$(".filter-chip")) {
    const on = (chip.dataset.chip || "all") === activeFilter;
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("bg-primary", on);
    chip.classList.toggle("text-on-primary", on);
    chip.classList.toggle("shadow-sm", on);
    chip.classList.toggle("bg-surface-container", !on);
    chip.classList.toggle("text-on-surface-variant", !on);
  }
}

function paintSort() {
  const label = $("#sort-label");
  if (label) label.textContent = SORTS[sortIndex].label;
}

function updateLoadMore() {
  const btn = $("#load-more");
  if (!btn) return;
  btn.classList.toggle("hidden", !(lastResults.length >= PAGE_SIZE && !searchExhausted));
  const label = $("#load-more-label");
  if (label) {
    label.textContent = loadingMore
      ? "Loading…"
      : `Load more results (${lastResults.length} so far)`;
  }
}

// ---------------------------------------------------------------- featured -
function featuredCard(t, index) {
  return `
  <div class="group relative bg-surface-container-lowest rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between overflow-hidden" data-featured-index="${index}">
    <div class="flex flex-col gap-3.5">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-primary-container">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" src="${esc(t.image)}" onerror="this.style.display='none'" />
        <div class="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-primary/80 backdrop-blur text-on-primary font-label-mono text-[10px] tracking-wide uppercase">
          ${t.hq ? "320 kbps" : "Master"}
        </div>
        <button type="button" data-action="play" title="Play this track" class="absolute bottom-3 right-3 w-10 h-10 rounded-full bg-on-primary text-primary flex items-center justify-center shadow-lg opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all">
          <span class="material-symbols-outlined text-[20px]" style="font-variation-settings: 'FILL' 1;">play_arrow</span>
        </button>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-headline-md text-headline-md text-on-surface truncate">${esc(t.title)}</h3>
          <span class="font-label-mono text-label-mono text-on-surface-variant shrink-0">${esc(t.duration)}</span>
        </div>
        <p class="font-body-md text-body-md text-on-surface-variant truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</p>
      </div>
    </div>
    <div class="pt-3 mt-3 flex items-center justify-between bg-surface-container-low px-3 py-2 rounded-lg">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="material-symbols-outlined text-[14px] text-on-surface">graphic_eq</span>
        <span class="font-label-mono text-label-mono text-on-surface font-medium truncate">${t.hq ? "320 kbps" : "Standard"}</span>
      </div>
      <button type="button" data-action="download" class="download-action-btn flex items-center justify-center w-7 h-7 rounded bg-surface-container-lowest hover:bg-primary hover:text-on-primary text-on-surface transition-colors shadow-xs" title="Download this track">
        <span class="material-symbols-outlined text-[15px]">download</span>
      </button>
    </div>
  </div>`;
}

function renderFeatured() {
  const grid = $("#featured-grid");
  if (!grid) return;
  const list = currentView();
  const pages = Math.max(1, Math.ceil(list.length / FEATURED_PER_PAGE));
  featuredPage = Math.min(Math.max(featuredPage, 0), pages - 1);
  const start = featuredPage * FEATURED_PER_PAGE;
  grid.innerHTML = list
    .slice(start, start + FEATURED_PER_PAGE)
    .map((t, i) => featuredCard(t, start + i))
    .join("");
  const prev = $("#featured-prev");
  const next = $("#featured-next");
  if (prev) prev.disabled = pages <= 1;
  if (next) next.disabled = pages <= 1;
}

// ---------------------------------------------------------------- download -
async function downloadTrack(track, btn) {
  if (!track) return;
  const icon = btn ? btn.querySelector(".material-symbols-outlined") : null;
  const original = icon ? icon.textContent : "";
  if (icon) icon.textContent = "downloading";
  diag(`download ${track.id}`, null, track.title);
  try {
    const path = await invoke("download_song", { id: track.id });
    diag(`download ${track.id}`, true, path);
    if (icon) icon.textContent = "check";
    const previous = resultsSub.textContent;
    resultsSub.textContent = `Saved to ${path}`;
    setTimeout(() => {
      if (icon) icon.textContent = original;
      if (resultsSub.textContent.startsWith("Saved to")) resultsSub.textContent = previous;
    }, 5000);
  } catch (err) {
    if (icon) icon.textContent = original;
    diag(`download ${track.id}`, false, String(err));
    showError(`Download failed: ${err}`);
  }
}

// ------------------------------------------------------------------ search -
function showErrorRetry(msg, retry) {
  errorEl.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "error-retry";
  btn.className =
    "ml-3 px-2.5 py-1 rounded border border-current font-label-md text-label-md transition-opacity hover:opacity-70";
  btn.textContent = "Retry";
  btn.addEventListener("click", retry);
  errorEl.append(span, btn);
  errorEl.classList.remove("hidden");
}

async function doSearch(opts = {}) {
  const append = !!opts.append;
  const silent = !!opts.silent;
  const q = String(opts.query ?? $("#search-input").value).trim();
  if (!q) {
    resultsSub.textContent = "Type a query, then press Search.";
    return;
  }
  if (append && (loadingMore || searchExhausted || !lastResults.length)) return;

  if (append) loadingMore = true;
  else {
    featuredPage = 0;
    searchExhausted = false;
  }
  clearError();
  updateLoadMore();
  searchQuery = q;
  const navInput = $("#nav-search-input");
  if (navInput) navInput.value = q;
  if (!silent) {
    pushHistory(q);
    showView("search");
  }
  resultsSub.textContent = append
    ? `Loading page ${searchPage + 1} for "${q}"…`
    : `Searching for "${q}"…`;

  let tracks = [];
  try {
    tracks = await invoke("search_songs", {
      query: q,
      limit: PAGE_SIZE,
      page: append ? searchPage + 1 : 1,
    });
  } catch (err) {
    loadingMore = false;
    updateLoadMore();
    diag(`search "${q}"`, false, String(err));
    resultsSub.textContent = append
      ? `Could not load more results for "${q}".`
      : "Search failed.";
    showErrorRetry(`Search failed: ${err}`, () => doSearch({ append, query: q }));
    return;
  }
  loadingMore = false;

  if (!append) {
    searchPage = 1;
    lastResults = tracks;
    searchExhausted = tracks.length < PAGE_SIZE;
    if (!tracks.length) {
      resultsEl.innerHTML = "";
      renderFeatured();
      updateLoadMore();
      resultsSub.textContent = `No tracks found for "${q}".`;
      showErrorRetry(`No tracks found for "${q}".`, () => doSearch({ query: q }));
      return;
    }
    diag(`search "${q}"`, true, `${tracks.length} tracks`);
    refreshResults();
    return;
  }

  const known = new Set(lastResults.map((t) => t.id));
  const fresh = tracks.filter((t) => !known.has(t.id));
  searchPage += 1;
  if (tracks.length < PAGE_SIZE || !fresh.length) searchExhausted = true;
  if (!fresh.length) {
    diag(`search "${q}"`, true, "no further pages");
    updateLoadMore();
    resultsSub.textContent = `End of results — ${lastResults.length} tracks for "${q}".`;
    return;
  }
  lastResults = lastResults.concat(fresh);
  diag(`search "${q}" page ${searchPage}`, true, `+${fresh.length} tracks`);
  refreshResults();
}

// --------------------------------------------------------- control wiring -
for (const chip of $$(".filter-chip")) {
  chip.addEventListener("click", () => {
    const spec = chip.dataset.chip || "all";
    if (spec.startsWith("q:")) {
      const term = spec.slice(2);
      $("#search-input").value = term;
      doSearch({ query: term });
      return;
    }
    activeFilter = spec;
    featuredPage = 0;
    paintChips();
    refreshResults();
    diag("filter", null, spec);
  });
}
paintChips();
paintSort();

$("#sort-btn")?.addEventListener("click", () => {
  sortIndex = (sortIndex + 1) % SORTS.length;
  paintSort();
  refreshResults();
  diag("sort", null, SORTS[sortIndex].label);
});

$("#refine-btn")?.addEventListener("click", () => {
  const bar = $("#filter-bar");
  const btn = $("#refine-btn");
  if (!bar || !btn) return;
  const hidden = bar.classList.toggle("hidden");
  btn.setAttribute("aria-expanded", String(!hidden));
  const label = $("#refine-label");
  if (label) label.textContent = hidden ? "Show Filters" : "Refine Filters";
  if (!hidden) $(".filter-chip")?.focus();
});

$("#featured-prev")?.addEventListener("click", () => {
  featuredPage -= 1;
  renderFeatured();
  diag("featured", null, `page ${featuredPage + 1}`);
});
$("#featured-next")?.addEventListener("click", () => {
  featuredPage += 1;
  renderFeatured();
  diag("featured", null, `page ${featuredPage + 1}`);
});
$("#featured-grid")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const holder = btn.closest("[data-featured-index]");
  const index = Number(holder ? holder.dataset.featuredIndex : -1);
  const track = currentView()[index];
  if (!track) {
    // Static placeholders only exist before the first search resolves.
    const input = $("#search-input");
    if (input && !input.value.trim()) input.value = "trance";
    doSearch({ query: input ? input.value : "" });
    return;
  }
  if (btn.dataset.action === "download") downloadTrack(track, btn);
  else playTrack(track);
});

$("#load-more")?.addEventListener("click", () => doSearch({ append: true }));

function playTrack(track) {
  playQueueItem(enqueue(track));
}

$("#search-btn").addEventListener("click", doSearch);
$("#nav-search-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#nav-search-input").value.trim();
  if (!v) return;
  $("#search-input").value = v;
  doSearch();
});
$("#nav-search-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#nav-search-input").value = "";
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    showView("search");
    $("#nav-search-input")?.focus();
  }
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
  if (e.key === "Escape") $("#search-input").value = "";
});
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  $("#search-input").focus();
});
$("#play-all").addEventListener("click", () => {
  const list = currentView();
  if (!list.length) {
    showError("Nothing to play — run a search or clear the filters first.");
    return;
  }
  queue.length = 0;
  for (const t of list) queue.push({ track: t, state: null });
  queueTab = "next";
  renderQueue();
  playQueueItem(0);
});

// -------------------------------------------------------------------- home -
let homeFeed = null;
let homePlaylistPage = 0;
const PLAYLISTS_PER_PAGE = 5;
const LIBRARY_KEY = "tm-library";

/// Load a playlist/chart into the queue and start it.
async function playList(id, { shuffle = false } = {}) {
  diag("playlist", null, id);
  let tracks;
  try {
    tracks = await invoke("playlist_tracks", { id });
  } catch (err) {
    diag("playlist", false, String(err));
    showError(`Could not load that playlist: ${err}`);
    return;
  }
  if (!tracks.length) {
    showError("That playlist has no playable tracks.");
    return;
  }
  queue.length = 0;
  for (const t of tracks) queue.push({ track: t, state: null });
  if (shuffle) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    shuffleMode = true;
    paintModes();
  }
  queueIndex = -1;
  queueTab = "next";
  renderQueue();
  diag("playlist", true, `${tracks.length} tracks`);
  playQueueItem(0);
}

function renderHero() {
  const spot = homeFeed && homeFeed.spotlight;
  if (!spot) return;
  const img = $("#hero-image");
  if (img && spot.image) img.src = spot.image;
  npText("hero-title", spot.title);
  npText("hero-artist", spot.subtitle || "JioSaavn editorial");
  npText("hero-meta", spot.count ? `${spot.count} Tracks` : "Curated playlist");
}

function renderHomePlaylists() {
  const grid = $("#home-playlists");
  if (!grid || !homeFeed) return;
  const items = homeFeed.playlists;
  const pages = Math.max(1, Math.ceil(items.length / PLAYLISTS_PER_PAGE));
  homePlaylistPage = Math.min(Math.max(homePlaylistPage, 0), pages - 1);
  const start = homePlaylistPage * PLAYLISTS_PER_PAGE;
  grid.innerHTML = items
    .slice(start, start + PLAYLISTS_PER_PAGE)
    .map(
      (p) => `
    <div class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between">
      <div>
        <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
          <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(p.image)}" onerror="this.style.display='none'" />
          <div class="absolute inset-0 bg-gradient-to-t from-primary/90 to-primary/30 flex flex-col justify-end p-3">
            <span class="font-label-mono text-[9px] uppercase tracking-wider text-on-primary/80">${p.count || "—"} tracks</span>
            <span class="font-headline-md text-on-primary font-semibold text-[16px] leading-tight">${esc(p.title)}</span>
          </div>
          <button type="button" data-playlist-id="${esc(p.id)}" title="Play this playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-secondary line-clamp-2">${esc(p.subtitle)}</p>
      </div>
      <div class="mt-3 pt-2 border-t border-surface-container-high flex items-center justify-between text-on-surface-variant font-label-mono text-[10px]">
        <span>${p.count || 0} Tracks</span>
        <span>JioSaavn</span>
      </div>
    </div>`,
    )
    .join("");
}

function renderHomeTop() {
  const list = $("#home-top-list");
  if (!list || !homeFeed) return;
  const tracks = homeFeed.top_tracks;
  if (!tracks.length) {
    list.innerHTML =
      '<p class="py-4 font-body-sm text-body-sm text-on-surface-variant">Rankings are unavailable right now.</p>';
    return;
  }
  list.innerHTML = tracks
    .map(
      (t, i) => `
    <div class="flex items-center justify-between p-3 rounded-lg hover:bg-surface-container-low transition-colors group cursor-pointer" data-top-index="${i}">
      <div class="flex items-center gap-4 min-w-0">
        <span class="font-headline-md font-semibold ${i === 0 ? "text-primary" : "text-on-surface-variant"} w-6 text-center">${String(i + 1).padStart(2, "0")}</span>
        <div class="w-10 h-10 rounded bg-surface-container-high overflow-hidden flex items-center justify-center text-on-surface-variant shrink-0">
          <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(t.image)}" onerror="this.style.display='none'" />
        </div>
        <div class="truncate">
          <span class="font-body-md font-semibold text-on-surface block truncate">${esc(t.title)}</span>
          <span class="font-body-sm text-secondary truncate">${esc(t.artist)}</span>
        </div>
      </div>
      <div class="flex items-center gap-6 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-medium text-[10px]">${t.hq ? "320 kbps" : "Standard"}</span>
        <span class="hidden sm:inline">${t.plays ? `${t.plays.toLocaleString()} plays` : "—"}</span>
        <span>${esc(t.duration)}</span>
        <button type="button" data-top-index="${i}" title="Play this track" class="w-8 h-8 rounded-full bg-surface-container-high group-hover:bg-primary group-hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]">play_arrow</span>
        </button>
      </div>
    </div>`,
    )
    .join("");
}

async function loadHome() {
  try {
    homeFeed = await invoke("home_feed");
  } catch (err) {
    diag("home", false, String(err));
    npText("hero-title", "Home feed unavailable");
    npText("hero-artist", String(err).slice(0, 120));
    for (const sel of ["#home-albums", "#home-artists", "#home-stations", "#playlists-grid"]) {
      const el = $(sel);
      if (el) el.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">Unavailable right now.</p>';
    }
    return;
  }
  diag(
    "home",
    true,
    `${homeFeed.playlists.length} playlists · ${homeFeed.charts.length} charts · ${homeFeed.top_tracks.length} top tracks`,
  );
  renderHero();
  renderHomePlaylists();
  renderHomeTop();
  renderPlaylistsGrid();
  renderHomeAlbums();
  renderHomeArtists();
  renderHomeStations();
  renderLibrary();
  renderPlays();
}

$("#home-playlists-prev")?.addEventListener("click", () => {
  homePlaylistPage -= 1;
  renderHomePlaylists();
});
$("#home-playlists-next")?.addEventListener("click", () => {
  homePlaylistPage += 1;
  renderHomePlaylists();
});
$("#home-playlists")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-playlist-id]");
  if (btn) openPlaylist(plItemById(btn.dataset.playlistId));
});
$("#home-top-list")?.addEventListener("click", (e) => {
  const hit = e.target.closest("[data-top-index]");
  const track = hit && homeFeed ? homeFeed.top_tracks[Number(hit.dataset.topIndex)] : null;
  if (track) playTrack(track);
});
$("#home-charts-link")?.addEventListener("click", () => {
  if (homeFeed && homeFeed.chart_id) playList(homeFeed.chart_id);
});
$("#hero-play")?.addEventListener("click", () => {
  if (homeFeed && homeFeed.spotlight) playList(homeFeed.spotlight.id);
});
$("#hero-shuffle")?.addEventListener("click", () => {
  if (homeFeed && homeFeed.spotlight) playList(homeFeed.spotlight.id, { shuffle: true });
});
$("#hero-save")?.addEventListener("click", () => {
  const spot = homeFeed && homeFeed.spotlight;
  if (!spot) return;
  let lib = [];
  try {
    lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {}
  const at = lib.findIndex((x) => x.id === spot.id);
  const label = $("#hero-save span:last-child");
  if (at >= 0) {
    lib.splice(at, 1);
    if (label) label.textContent = "Save to Library";
    diag("library", null, `removed ${spot.title}`);
  } else {
    lib.push({ id: spot.id, title: spot.title });
    if (label) label.textContent = "Saved ✓";
    diag("library", true, spot.title);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 50)));
  } catch {}
});
// Genre pills anywhere on Home run a real search.
$('[data-view="home"]')?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-query]");
  if (!chip) return;
  $("#search-input").value = chip.dataset.query;
  doSearch({ query: chip.dataset.query });
});

// ------------------------------------------------------- detail screens -
const PLAYS_KEY = "tm-plays";

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {
    return [];
  }
}
function loadPlays() {
  try {
    return JSON.parse(localStorage.getItem(PLAYS_KEY) || "[]");
  } catch {
    return [];
  }
}

/// One listening session, recorded where playback actually starts.
function pushPlay(track) {
  try {
    const next = [{ ...track, ts: Date.now() }, ...loadPlays().filter((x) => x.id !== track.id)].slice(0, 100);
    localStorage.setItem(PLAYS_KEY, JSON.stringify(next));
    renderPlays();
  } catch {}
}

function playTracksAt(list, index) {
  queue.length = 0;
  for (const t of list) queue.push({ track: t, state: null });
  queueTab = "next";
  queueIndex = -1;
  renderQueue();
  playQueueItem(index);
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/// Shared track rows: click a row to play the whole list from there.
function trackRows(list, box, emptyMsg) {
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${emptyMsg || "Nothing here yet."}</p>`;
    return;
  }
  box.innerHTML = "";
  list.forEach((t, i) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between gap-4 px-4 py-2.5 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <span class="font-label-mono text-[11px] text-on-surface-variant w-5 text-right shrink-0">${i + 1}</span>
        <div class="w-9 h-9 rounded overflow-hidden bg-surface-container-high shrink-0">
          <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(t.image || "")}" onerror="this.style.display='none'" />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${esc(t.artist || "")}</div>
        </div>
      </div>
      <div class="flex items-center gap-4 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <span class="material-symbols-outlined text-[18px] opacity-0 group-hover:opacity-100">play_arrow</span>
      </div>`;
    row.addEventListener("click", () => playTracksAt(list, i));
    box.appendChild(row);
  });
}

let pdTracks = [];
let ddTracks = [];

function plItemById(id) {
  const pools = homeFeed
    ? [...homeFeed.playlists, ...homeFeed.charts, homeFeed.spotlight].filter(Boolean)
    : [];
  return (
    pools.find((p) => p.id === id) ||
    loadLibrary().find((p) => p.id === id) ||
    { id, title: "Playlist" }
  );
}

/// Playlists screen: grid opens the detail section in the same view.
async function openPlaylist(item) {
  showView("playlists");
  const detail = $("#playlist-detail");
  detail?.classList.remove("hidden");
  npText("pd-title", item.title || "Playlist");
  npText("pd-subtitle", item.subtitle || "Loading tracks…");
  const img = $("#pd-image");
  if (img) {
    if (item.image) {
      img.src = item.image;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#pd-tracks");
  if (box) box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';
  detail?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    pdTracks = await invoke("playlist_tracks", { id: item.id });
  } catch (err) {
    diag("playlist", false, String(err));
    npText("pd-subtitle", `Could not load: ${String(err).slice(0, 90)}`);
    if (box) box.innerHTML = "";
    return;
  }
  npText("pd-subtitle", [item.subtitle, `${pdTracks.length} tracks`].filter(Boolean).join(" · "));
  trackRows(pdTracks, box, "That playlist has no tracks.");
  diag("playlist", true, `${pdTracks.length} tracks`);
}

/// Album / artist screen (the `detail` view) — token comes from the card.
async function openDetail(kind, item) {
  showView("detail");
  npText("dd-kind", kind.toUpperCase());
  npText("dd-title", item.title || "—");
  npText("dd-subtitle", "Loading tracks…");
  const img = $("#dd-image");
  if (img) {
    if (item.image) {
      img.src = item.image;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#dd-tracks");
  if (box) box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';
  try {
    ddTracks = await invoke(kind === "artist" ? "artist_tracks" : "album_tracks", { token: item.token });
  } catch (err) {
    diag(kind, false, String(err));
    npText("dd-subtitle", `Could not load ${kind}: ${String(err).slice(0, 80)}`);
    if (box) box.innerHTML = "";
    return;
  }
  npText("dd-subtitle", [item.subtitle, `${ddTracks.length} tracks`].filter(Boolean).join(" · "));
  trackRows(ddTracks, box, `No tracks found for this ${kind}.`);
  diag(kind, true, `${ddTracks.length} tracks`);
}

function plCard(p) {
  return `
    <div data-pl-id="${esc(p.id)}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
        <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(p.image || "")}" onerror="this.style.display='none'" />
        <div class="absolute inset-0 bg-gradient-to-t from-primary/85 to-primary/20 flex flex-col justify-end p-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <span class="font-headline-md text-on-primary font-semibold text-[14px] leading-tight line-clamp-2">${esc(p.title || "")}</span>
        </div>
        <button type="button" title="Open playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
      </div>
      <div class="min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(p.title || "")}</p>
        <p class="font-body-sm text-body-sm text-secondary truncate">${esc(p.subtitle || "JioSaavn")}</p>
      </div>
    </div>`;
}

function ddCard(kind, a) {
  return `
    <div data-dd-kind="${kind}" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
        <img alt="" loading="lazy" class="w-full h-full object-cover" src="${esc(a.image || "")}" onerror="this.style.display='none'" />
        <button type="button" title="Open" class="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md hover:scale-105">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
      </div>
      <div class="min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(a.title || "")}</p>
        <p class="font-body-sm text-body-sm text-secondary truncate">${esc(a.subtitle || (kind === "album" ? "New album" : "Artist"))}</p>
      </div>
    </div>`;
}

function stationCard(c, i) {
  return `
    <div data-pl-id="${esc(c.id)}" class="p-5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all flex flex-col justify-between group cursor-pointer">
      <div>
        <div class="flex items-center justify-between mb-3">
          <span class="font-label-mono text-[10px] px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-medium">NODE #0${i + 1}</span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        </div>
        <h4 class="font-headline-md text-headline-md text-on-surface group-hover:text-primary transition-colors">${esc(c.title || "")}</h4>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${c.count ? `${c.count} tracks` : esc(c.subtitle || "")}</p>
      </div>
      <div class="mt-4 pt-3 border-t border-surface-container-high flex items-center justify-between">
        <span class="font-label-mono text-[10px] text-secondary">JioSaavn chart</span>
        <span class="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center group-hover:scale-105 transition-transform"><span class="material-symbols-outlined text-[18px]">radio</span></span>
      </div>
    </div>`;
}

const GRID_EMPTY = '<p class="font-body-sm text-body-sm text-on-surface-variant">Unavailable right now.</p>';

function renderPlaylistsGrid() {
  const box = $("#playlists-grid");
  if (!box || !homeFeed) return;
  box.innerHTML = homeFeed.playlists.length
    ? homeFeed.playlists.map(plCard).join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">No playlists right now.</p>';
}
function renderHomeAlbums() {
  const box = $("#home-albums");
  if (!box || !homeFeed) return;
  box.innerHTML = homeFeed.albums.length ? homeFeed.albums.map((a) => ddCard("album", a)).join("") : GRID_EMPTY;
}
function renderHomeArtists() {
  const box = $("#home-artists");
  if (!box || !homeFeed) return;
  box.innerHTML = homeFeed.artists.length ? homeFeed.artists.map((a) => ddCard("artist", a)).join("") : GRID_EMPTY;
}
function renderHomeStations() {
  const box = $("#home-stations");
  if (!box || !homeFeed) return;
  const list = homeFeed.charts.slice(0, 3);
  box.innerHTML = list.length ? list.map(stationCard).join("") : GRID_EMPTY;
}
function renderLibrary() {
  const box = $("#library-saved");
  if (!box) return;
  const lib = loadLibrary();
  box.innerHTML = lib.length
    ? lib.map(plCard).join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet — hit “Save to Library” on Home.</p>';
}
function renderPlays() {
  const plays = loadPlays();
  const count = $("#history-count");
  if (count) count.textContent = `${plays.length} session${plays.length === 1 ? "" : "s"}`;
  trackRows(plays, $("#history-plays"), "Nothing played yet.");
  trackRows(plays.slice(0, 5), $("#library-recent"), "No plays yet.");
}

// Click wiring — one delegated listener per grid.
function wirePlGrid(sel) {
  $(sel)?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-pl-id]");
    if (card) openPlaylist(plItemById(card.dataset.plId));
  });
}
wirePlGrid("#playlists-grid");
wirePlGrid("#home-stations");
wirePlGrid("#library-saved");

function wireDdGrid(sel) {
  $(sel)?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-dd-token]");
    if (!card) return;
    const item = {
      token: card.dataset.ddToken,
      title: card.dataset.ddTitle,
      subtitle: card.dataset.ddSub,
      image: card.dataset.ddImg,
    };
    // No token (payload oddity) → fall back to a real search instead of dead click.
    if (!item.token) {
      doSearch({ query: item.title || "" });
      return;
    }
    openDetail(card.dataset.ddKind, item);
  });
}
wireDdGrid("#home-albums");
wireDdGrid("#home-artists");

$("#pd-play")?.addEventListener("click", () => pdTracks.length && playTracksAt(pdTracks, 0));
$("#pd-shuffle")?.addEventListener("click", () => {
  if (!pdTracks.length) return;
  pdTracks = shuffled(pdTracks);
  trackRows(pdTracks, $("#pd-tracks"));
  shuffleMode = true;
  paintModes();
  playTracksAt(pdTracks, 0);
});
$("#pd-back")?.addEventListener("click", () => $("#playlist-detail")?.classList.add("hidden"));
$("#dd-play")?.addEventListener("click", () => ddTracks.length && playTracksAt(ddTracks, 0));
$("#dd-shuffle")?.addEventListener("click", () => {
  if (!ddTracks.length) return;
  ddTracks = shuffled(ddTracks);
  trackRows(ddTracks, $("#dd-tracks"));
  shuffleMode = true;
  paintModes();
  playTracksAt(ddTracks, 0);
});
$("#dd-back")?.addEventListener("click", () => showView("home"));
$("#history-clear")?.addEventListener("click", () => {
  try {
    localStorage.removeItem(PLAYS_KEY);
  } catch {}
  renderPlays();
  diag("history", null, "cleared");
});
document.addEventListener("click", (e) => {
  const jump = e.target.closest("[data-path-jump]");
  if (jump) showView(jump.dataset.pathJump);
});

// ------------------------------------------------------------------- boot -
try {
  const base = await invoke("proxy_base");
  diag("proxy base", true, base.replace("http://", ""));
} catch (err) {
  diag("proxy base", false, String(err));
}
telemetry("idle");
diag("boot", true, "TRANCE MUSIC ready");

// Seed the catalog so every control has real data on first paint.
const seedInput = $("#search-input");
if (seedInput && !seedInput.value.trim()) seedInput.value = "trance";
doSearch({ silent: true });
loadHome();
