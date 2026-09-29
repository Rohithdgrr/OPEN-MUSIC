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
// Tailwind emits text-on-surface-variant after text-on-primary, so the active
// colour only sticks if the inactive ones are actually removed.
const ACTIVE = ["bg-primary", "text-on-primary"];
const INACTIVE = ["text-on-surface-variant", "hover:text-on-surface"];

function showView(name) {
  for (const v of views) v.classList.toggle("hidden", v.dataset.view !== name);
  for (const a of navLinks) {
    const on = a.dataset.path === name;
    a.classList.remove(...ACTIVE, ...INACTIVE);
    a.classList.add(...(on ? ACTIVE : INACTIVE));
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  diag("view", null, name);
  if (name === "downloads") refreshVault();
  if (name === "library") {
    renderLibrary();
    renderFavs();
  }
  if (name === "playlists") {
    renderPlaylists();
    // Entering cold: paint the hero and its table like the design shows them.
    if (!pdCurrentId && plFeatured) openPlaylist(plFeatured.p, { scroll: false });
  }
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

// ------------------------------------------------------------------ toasts -
// Background results (downloads especially) must be visible from every view,
// so they render into a stack rooted at <body>, not inside one view.
function toast(msg, kind = "info", ms = 4500) {
  let stack = $("#toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = "tm-toast";
  el.dataset.kind = kind;
  const dot = document.createElement("span");
  dot.className = "tm-dot";
  const text = document.createElement("span");
  text.textContent = msg;
  el.append(dot, text);
  const dismiss = () => {
    el.classList.add("tm-out");
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener("click", dismiss);
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstChild.remove();
  setTimeout(() => {
    if (el.isConnected) dismiss();
  }, ms);
  return dismiss;
}

// The #error banner ships inside the search view, which hid failures for
// downloads triggered from Now Playing / queue / home. Hoist it to <body>
// once so showError/showErrorRetry are visible from every view.
if (errorEl && !errorEl.dataset.hoisted) {
  errorEl.dataset.hoisted = "1";
  errorEl.classList.add("tm-global");
  document.body.appendChild(errorEl);
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
  for (const q of [...new Set(loadHistory())]) {
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
/// Entity cards for the active search chip (artists / albums / playlists).
let lastCards = [];
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

// --------------------------------------------------------------- artwork ---
// The API only ships 150px thumbs (`…-150x150.jpg`, often over plain http),
// which smear as soon as a card renders them at 300px+. Ask the same CDN for
// the 500px master instead — the size token lives in the filename.
const ART_RENDS = [
  ["-50x50x100", "-500x500"],
  ["-150x150x100", "-500x500"],
  ["-50x50", "-500x500"],
  ["-150x150", "-500x500"],
  ["50x50", "500x500"],
  ["150x150", "500x500"],
];

function hqArt(url) {
  if (typeof url !== "string" || !url) return "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (host !== "saavncdn.com" && !host.endsWith(".saavncdn.com")) return url;
  let out = url;
  for (const [small, big] of ART_RENDS) out = out.split(small).join(big);
  return out.startsWith("http://") ? "https://" + out.slice(7) : out;
}

// `src` + provenance + error hook for every <img> written into a template.
// The original URL is kept so a missing master can fall back instead of
// blanking the card.
function art(url) {
  const raw = typeof url === "string" ? url : "";
  return `src="${esc(hqArt(raw))}" data-art-orig="${esc(raw)}" onerror="window.artFail(this)"`;
}

// Programmatic counterpart for the hero, player covers and detail headers.
function paintArt(img, url) {
  if (!img || !url) return;
  img.setAttribute("data-art-orig", url);
  img.removeAttribute("data-art-tried");
  img.classList.remove("hidden");
  img.style.display = "";
  img.onerror = () => window.artFail(img);
  img.src = hqArt(url);
}

// Tries the original URL once; hides the image only when that fails too.
// Returns true once the image is finished (hidden).
window.artFail = function (img) {
  const orig = img.getAttribute("data-art-orig");
  if (orig && img.getAttribute("src") !== orig && !img.hasAttribute("data-art-tried")) {
    img.setAttribute("data-art-tried", "");
    img.setAttribute("src", orig);
    return false;
  }
  img.classList.add("hidden");
  return true;
};

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
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image)} />
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
}

function paintQueueTabs() {
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

function enqueue(track) {
  const existing = queue.findIndex((q) => q.track.id === track.id);
  if (existing >= 0) return existing;
  // A different-id copy of the same recording must not stack up either.
  const dup = findDuplicate(contentIndex(queue.map((q) => q.track)), track);
  if (dup >= 0) return dup;
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
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
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
/// Bumped on every track change so a slow fetch never paints over a newer one.
let lyricToken = 0;

/// Class strings the static demo markup uses — rendered lines must match them
/// so the sync highlight, hover and cursor styles keep working.
const LYRIC_LINE_CLASS =
  "lyric-line group flex items-start gap-3 p-2.5 rounded-lg hover:bg-surface-container-low/70 transition-all duration-200 cursor-pointer text-neutral-400 select-none";
const LYRIC_TEXT_CLASS =
  "lyric-text text-[15px] font-normal leading-relaxed transition-all duration-300";

/// The static markup ships demo lyrics; they are replaced on every track so
/// the stage never shows words that do not belong to the song.
function setLyricsPlaceholder(msg = "Lyrics for this track are not loaded.") {
  const box = $("#lyrics-scroll-box");
  if (!box) return;
  const p = document.createElement("div");
  p.className = "py-8 text-center text-sm text-on-surface-variant font-mono";
  p.textContent = msg;
  box.replaceChildren(p);
  lyricLines = [];
}

function renderLyrics(data) {
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

async function loadLyrics(track) {
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

function syncLyrics() {
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

// --------------------------------------------------------------- transport -
async function togglePlay() {
  if (!audio.src) {
    // Fresh open: the bar shows the last played track but nothing is loaded.
    const last = loadPlays()[0];
    if (last) {
      queue.length = 0;
      queue.push({ track: last, state: null });
      queueIndex = -1;
      renderQueue();
      playQueueItem(0);
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
  if (np.favIcon) np.favIcon.dataset.favIcon = track.id;
  paintFavHearts();
  loadLyrics(track);
  const setCover = (img, fallback) => {
    if (!img) return;
    if (track.image) {
      img.setAttribute("data-art-orig", track.image);
      img.removeAttribute("data-art-tried");
      img.classList.remove("hidden");
      img.style.display = "";
      img.onerror = () => {
        // One retry of the original URL, then fall back to the icon.
        if (window.artFail(img)) {
          img.classList.add("hidden");
          fallback?.classList.remove("hidden");
        }
      };
      img.src = hqArt(track.image);
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

/// Shared "add this track to one of my local playlists" button. The whole
/// track rides in data attributes so one delegated listener can serve every
/// row builder on every screen.
function addBtn(t) {
  return `<button type="button" data-add-id="${esc(t.id || "")}" data-add-title="${esc(t.title || "")}" data-add-artist="${esc(t.artist || "")}" data-add-album="${esc(t.album || "")}" data-add-image="${esc(t.image || "")}" data-add-dur="${esc(t.duration || "")}" title="Add to playlist" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors"><span class="material-symbols-outlined text-[17px] text-on-surface-variant hover:text-on-surface">playlist_add</span></button>`;
}

// `variant = "search"` keeps the format/size columns of the catalog table;
// `"list"` swaps them for the album column the playlist table shows.
function trackRow(t, i, isCurrent, variant = "search") {
  const list = variant === "list";
  const cells = list
    ? `<div class="col-span-3 min-w-0"><span class="text-[13px] text-on-surface-variant truncate block">${esc(t.album || "—")}</span></div>
    <div class="col-span-1 text-right text-[12px] font-mono text-on-surface">${esc(t.duration)}</div>`
    : `<div class="col-span-2 flex items-center gap-2">
      <span class="px-2 py-0.5 rounded bg-surface-container text-[11px] font-mono text-on-surface font-medium">${t.hq ? "320 kbps" : "Standard"}</span>
    </div>
    <div class="col-span-1 text-right text-[11px] font-mono text-on-surface-variant">—</div>
    <div class="col-span-1 text-right text-[12px] font-mono text-on-surface">${esc(t.duration)}</div>`;
  return `
  <div class="group grid grid-cols-12 gap-4 items-center px-4 py-4 rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-all cursor-pointer border border-surface-container-high" data-track-id="${esc(t.id)}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
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
    <div class="${list ? "col-span-5" : "col-span-6"} flex items-center gap-4 min-w-0">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 shadow-sm bg-surface-container">
        <img loading="lazy" alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform" ${art(t.image)} />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-[15px] font-medium text-on-surface truncate">${esc(t.title)}</span>
        <span class="text-[13px] text-on-surface-variant truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</span>
      </div>
    </div>
    ${cells}
    <div class="${list ? "col-span-2" : "col-span-1"} flex items-center justify-end gap-1">
      <button type="button" data-row-action="fav" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
      </button>
      <button type="button" data-row-action="download" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface">download</span>
      </button>
      ${addBtn(t)}
    </div>
  </div>`;
}

function renderResults(tracks) {
  paintResultsMode();
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
      if (action === "fav") {
        e.stopPropagation();
        toggleFavTrack(t);
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
/// Singular backend kind + card label per non-track chip.
const KIND_SPEC = {
  artists: { kind: "artist", one: "artist", many: "artists" },
  albums: { kind: "album", one: "album", many: "albums and movies" },
  playlists: { kind: "playlist", one: "playlist", many: "playlists" },
};
const SORTS = [
  { key: "bitrate", label: "Bitrate: Descending" },
  { key: "popular", label: "Popularity: Descending" },
  { key: "longest", label: "Duration: Longest" },
  { key: "title", label: "Title: A–Z" },
];
/// Which chip is active: "tracks" (the table) or a key of KIND_SPEC.
let activeFilter = "tracks";
let sortIndex = 0;
let searchPage = 1;
let searchQuery = "";
let loadingMore = false;
let searchExhausted = false;
let featuredPage = 0;

const isTracks = () => activeFilter === "tracks";
/// Rows behind the active chip — the table and the card grid both page these.
const currentItems = () => (isTracks() ? lastResults : lastCards);

/// The tracks the table and the featured cards show right now.
function currentView() {
  const list = lastResults.slice();
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
  if (!isTracks()) return; // a chip switch raced this repaint
  const list = currentView();
  renderResults(list);
  if (!lastResults.length) {
    resultsSub.textContent = searchQuery
      ? `No track results for "${searchQuery}".`
      : "Search the catalog - results appear here.";
    return;
  }
  resultsSub.textContent = `Showing ${list.length} results for "${searchQuery}"`;
}

/// Table chrome only means anything for songs; chips swap it for a card grid.
function paintResultsMode() {
  const cards = !isTracks();
  $("#results-head")?.classList.toggle("hidden", cards);
  $("#play-all")?.classList.toggle("hidden", cards);
  $("#sort-wrap")?.classList.toggle("hidden", cards);
  resultsEl.className = cards ? "grid grid-cols-2 sm:grid-cols-4 gap-4" : "flex flex-col gap-2";
}

/// The card grid behind the Artists / Albums / Playlists chips.
function renderCards() {
  if (isTracks()) return; // a chip switch raced this repaint
  paintResultsMode();
  const spec = KIND_SPEC[activeFilter];
  resultsEl.innerHTML = lastCards.map(cardHtml).join("");
  updateLoadMore();
  if (!searchQuery) {
    resultsSub.textContent = `Search for ${spec.many}, then tap one to hear it.`;
  } else if (!lastCards.length) {
    resultsSub.textContent = `No ${spec.many} for "${searchQuery}".`;
  } else {
    resultsSub.textContent = `Showing ${lastCards.length} ${spec.many} for "${searchQuery}"`;
  }
}

/// One card in the grid: playlists open by id, albums/artists by token.
function cardHtml(item) {
  return activeFilter === "playlists" ? plCard(item) : ddCard(KIND_SPEC[activeFilter].kind, item);
}

function paintChips() {
  for (const chip of $$(".filter-chip")) {
    const on = (chip.dataset.chip || "tracks") === activeFilter;
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
  // `searchExhausted` is set from the backend's page_full flag — the deduped
  // list can be shorter than PAGE_SIZE while more pages still exist.
  const have = currentItems().length;
  btn.classList.toggle("hidden", !(have > 0 && !searchExhausted));
  const label = $("#load-more-label");
  if (label) {
    label.textContent = loadingMore ? "Loading…" : `Load more results (${have} so far)`;
  }
}

// ---------------------------------------------------------------- featured -
function featuredCard(t, index) {
  return `
  <div class="group relative bg-surface-container-lowest rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between overflow-hidden" data-featured-index="${index}">
    <div class="flex flex-col gap-3.5">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-primary-container">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(t.image)} />
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
      <button type="button" data-action="fav" class="flex items-center justify-center w-7 h-7 rounded bg-surface-container-lowest hover:bg-primary hover:text-on-primary text-on-surface transition-colors shadow-xs" title="Favorite this track">
        <span class="material-symbols-outlined text-[15px]" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
      </button>
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
  if (activeDownloads.has(track.id)) {
    toast(`"${track.title}" is already downloading.`, "info");
    return;
  }
  const icon = btn ? btn.querySelector(".material-symbols-outlined") : null;
  const original = icon ? icon.textContent : "";
  if (icon) icon.textContent = "progress_activity";
  if (btn) btn.disabled = true;
  diag(`download ${track.id}`, null, track.title);
  activeDownloads.set(track.id, {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    image: track.image,
    quality: track.hq ? "320 kbps" : "Standard",
    received: 0,
    total: null,
    done: false,
  });
  renderActive();
  try {
    const path = await invoke("download_song", { id: track.id });
    diag(`download ${track.id}`, true, path);
    activeDownloads.delete(track.id);
    renderActive();
    refreshVault();
    if (icon) icon.textContent = "check";
    toast(`Saved "${track.title}" to the offline vault.`, "success");
    const previous = resultsSub.textContent;
    resultsSub.textContent = `Saved to ${path}`;
    setTimeout(() => {
      if (icon) icon.textContent = original;
      if (btn) btn.disabled = false;
      if (resultsSub.textContent.startsWith("Saved to")) resultsSub.textContent = previous;
    }, 5000);
  } catch (err) {
    activeDownloads.delete(track.id);
    renderActive();
    if (icon) icon.textContent = original;
    if (btn) btn.disabled = false;
    diag(`download ${track.id}`, false, String(err));
    showError(`Download failed: ${err}`);
    toast(`Download failed: ${String(err).slice(0, 140)}`, "error", 6000);
  }
}

// --------------------------------------------------------------- downloads -
// Live rows, keyed by song id, fed by the backend `download-progress` events.
const activeDownloads = new Map();
let vaultEntries = [];
let vaultQuality = "all";
let vaultQuery = "";

function entryTrack(e) {
  return {
    id: e.id,
    title: e.title,
    artist: e.artist,
    album: e.album,
    image: e.image,
    duration: fmtTime(e.duration_secs || 0),
    duration_secs: e.duration_secs || 0,
    hq: e.quality === "320kbps",
  };
}

function relTime(unix) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - (unix || 0));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function activeCard(p) {
  const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : 0;
  return `
  <article class="p-4 rounded-xl bg-surface-container-lowest shadow-sm flex flex-col gap-4 hover:shadow-md transition-shadow">
    <div class="flex items-start gap-4">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 bg-surface-container">
        <img class="w-full h-full object-cover" ${art(p.image)} alt="" />
        <div class="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-primary/80 backdrop-blur-md text-on-primary font-label-mono text-[9px] uppercase tracking-wider">${esc(p.quality)}</div>
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <div class="truncate">
            <h3 class="font-headline-md text-body-lg font-medium text-on-surface truncate">${esc(p.title)}</h3>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([p.artist, p.album].filter(Boolean).join(" • "))}</p>
          </div>
          <span class="font-label-mono text-label-mono px-2 py-0.5 rounded bg-surface-container-high text-on-surface shrink-0">${Math.round(pct)}%</span>
        </div>
        <div class="mt-2.5 grid grid-cols-2 gap-2 font-label-mono text-label-mono text-on-surface-variant">
          <div>
            <span class="block text-[9px] uppercase text-outline">Payload</span>
            <span class="text-on-surface">${fmtBytes(p.received)} / ${p.total ? fmtBytes(p.total) : "?"}</span>
          </div>
          <div>
            <span class="block text-[9px] uppercase text-outline">Destination</span>
            <span class="text-on-surface">Offline vault</span>
          </div>
        </div>
      </div>
    </div>
    <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden flex">
      <div class="h-full bg-primary rounded-full transition-all duration-300" style="width: ${pct}%"></div>
    </div>
  </article>`;
}

function renderActive() {
  const section = $("#dl-active-section");
  const grid = $("#dl-active");
  if (!section || !grid) return;
  const list = [...activeDownloads.values()];
  section.classList.toggle("hidden", list.length === 0);
  const label = $("#dl-active-label");
  if (label) {
    label.textContent = list.length
      ? `${list.length} stream${list.length === 1 ? "" : "s"} in transit`
      : "Vault idle";
  }
  const dot = $("#dl-pipeline-dot");
  if (dot) {
    dot.classList.toggle("bg-primary", list.length > 0);
    dot.classList.toggle("animate-pulse", list.length > 0);
    dot.classList.toggle("bg-surface-container-highest", list.length === 0);
  }
  const count = $("#dl-active-count");
  if (count) count.textContent = `${list.length} active`;
  grid.innerHTML = list.map(activeCard).join("");
}

function visibleVault() {
  return vaultEntries.filter((e) => {
    if (vaultQuality === "320kbps" && e.quality !== "320kbps") return false;
    if (vaultQuality === "other" && e.quality === "320kbps") return false;
    if (!vaultQuery) return true;
    return [e.title, e.artist, e.album].join(" ").toLowerCase().includes(vaultQuery);
  });
}

function vaultRow(e) {
  return `
  <div class="vault-row flex items-center justify-between p-4 rounded-lg bg-surface-container-lowest hover:bg-surface-container-low transition-colors shadow-sm group" data-dl-path="${esc(e.path)}">
    <div class="flex items-center gap-4 min-w-0">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 bg-surface-container shadow-sm">
        <img class="w-full h-full object-cover" ${art(e.image)} alt="" />
        <button type="button" data-dl="play" title="Play now" class="absolute inset-0 bg-primary/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-on-primary">
          <span class="material-symbols-outlined text-[20px]">play_arrow</span>
        </button>
      </div>
      <div class="flex flex-col min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-headline-md text-body-lg font-medium text-on-surface truncate">${esc(e.title)}</span>
          <span class="font-label-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface shrink-0">${esc(e.quality)}</span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([e.artist, e.album].filter(Boolean).join(" • "))}</p>
      </div>
    </div>
    <div class="flex items-center gap-4 shrink-0">
      <div class="hidden sm:flex flex-col items-end font-label-mono text-label-mono">
        <span class="text-on-surface font-medium">${fmtBytes(e.bytes)}</span>
        <span class="text-on-surface-variant text-[10px]">${fmtTime(e.duration_secs || 0)}</span>
      </div>
      <span class="hidden md:inline font-label-mono text-label-mono text-on-surface-variant">${relTime(e.at)}</span>
      <div class="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
        <button type="button" data-dl="play" title="Play now" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
        <button type="button" data-dl="folder" title="Show in folder" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">folder_open</span>
        </button>
        <button type="button" data-dl="delete" title="Delete from disk" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    </div>
  </div>`;
}

function renderStorage() {
  const total = vaultEntries.reduce((n, e) => n + (e.bytes || 0), 0);
  const count = $("#dl-count");
  if (count) count.textContent = `${vaultEntries.length} track${vaultEntries.length === 1 ? "" : "s"}`;
  const alloc = $("#dl-alloc");
  if (alloc) alloc.textContent = `${total ? fmtBytes(total) : "0 B"} vaulted`;
  const bar = $("#dl-bar");
  if (bar) {
    // ponytail: 100 GB ceiling is a display constant, not an enforced quota
    const pct = Math.min(100, (total / (100 * 1024 * 1024 * 1024)) * 100);
    bar.style.width = `${Math.max(total ? 1 : 0, pct)}%`;
  }
}

function renderVault() {
  const list = $("#dl-vault");
  if (!list) return;
  const shown = visibleVault();
  const summary = $("#dl-summary");
  if (summary) {
    summary.textContent = !vaultEntries.length
      ? "Nothing saved yet — hit the download icon on any track."
      : shown.length === vaultEntries.length
        ? `${vaultEntries.length} song${vaultEntries.length === 1 ? "" : "s"} on disk, ready to play offline.`
        : `${shown.length} of ${vaultEntries.length} songs match.`;
  }
  list.innerHTML = shown.length
    ? shown.map(vaultRow).join("")
    : `<p class="font-body-sm text-body-sm text-on-surface-variant p-4 rounded-lg bg-surface-container-lowest shadow-sm">${vaultEntries.length ? "No songs match this filter." : "The vault is empty."}</p>`;
  renderStorage();
}

async function refreshVault() {
  try {
    const vault = await invoke("list_downloads");
    // Id collision = same song recorded twice (legacy manifests); show one.
    vaultEntries = uniqById((vault && vault.entries) || []);
    const dir = $("#dl-dir");
    if (dir) dir.textContent = (vault && vault.dir) || "—";
    renderVault();
    diag("vault", true, `${vaultEntries.length} saved`);
  } catch (err) {
    diag("vault", false, String(err));
    showError(`Could not read the downloads vault: ${err}`);
  }
}

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event
    .listen("download-progress", (event) => {
      const p = event.payload;
      if (p.done) {
        activeDownloads.delete(p.id);
        refreshVault();
      } else {
        activeDownloads.set(p.id, { ...activeDownloads.get(p.id), ...p });
      }
      renderActive();
    })
    .catch((err) => diag("download-progress", false, String(err)));
}

$("#dl-vault")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-dl]");
  if (!btn) return;
  const row = btn.closest("[data-dl-path]");
  const entry = vaultEntries.find((x) => x.path === row?.dataset.dlPath);
  if (!entry) return;
  const action = btn.dataset.dl;

  if (action === "play") {
    playTrack(entryTrack(entry));
    return;
  }
  if (action === "folder") {
    try {
      await invoke("reveal_download", { path: entry.path });
      diag("vault", true, "revealed in folder");
    } catch (err) {
      showError(String(err));
    }
    return;
  }
  if (action === "delete") {
    // Two clicks instead of a modal: nothing is removed by the first one.
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.title = "Click again to delete";
      btn.classList.add("text-error");
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.title = "Delete from disk";
        btn.classList.remove("text-error");
      }, 3000);
      return;
    }
    try {
      await invoke("remove_download", { path: entry.path });
      diag("vault", true, `deleted ${entry.title}`);
      refreshVault();
    } catch (err) {
      showError(String(err));
    }
  }
});

$("#dl-filter")?.addEventListener("click", (e) => {
  const pill = e.target.closest(".dl-pill");
  if (!pill) return;
  vaultQuality = pill.dataset.quality;
  for (const p of $$(".dl-pill")) {
    const on = p === pill;
    p.classList.toggle("bg-surface-container-lowest", on);
    p.classList.toggle("text-on-surface", on);
    p.classList.toggle("shadow-sm", on);
    p.classList.toggle("text-on-surface-variant", !on);
  }
  renderVault();
});

$("#dl-search")?.addEventListener("input", () => {
  vaultQuery = $("#dl-search").value.trim().toLowerCase();
  renderVault();
});

$("#dl-refresh")?.addEventListener("click", refreshVault);

$("#dl-open-vault")?.addEventListener("click", async () => {
  try {
    await invoke("reveal_vault");
  } catch (err) {
    showError(String(err));
  }
});

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

// ------------------------------------------------------- duplicate guard -
// Mirrors the backend `dedup_tracks` collapse (original vs remaster vs
// re-billed copies under different ids): candidates bucket by normalized
// title, then merge when the artist bills agree (order-insensitive, extra
// credits tolerated) and durations are within ±3s — keeping the 320 kbps
// copy, then most plays.
const DEDUP_DURATION_TOL = 3;
const DEDUP_KEEP_WORDS = new Set([
  "live", "remix", "remixed", "acoustic", "unplugged", "edit", "mix",
  "version", "cover", "karaoke", "instrumental", "demo", "reimagined",
  "rework", "slowed", "reverb", "sped", "nightcore", "extended", "club",
  "radio",
]);

function normKeyText(s) {
  const lower = String(s || "").toLowerCase();
  // Bracketed groups are version tags ("(Remastered 2024)") and are
  // dropped — unless they mark a different recording ("(Live)").
  let kept = "";
  let depth = 0;
  let inner = "";
  for (const c of lower) {
    if (c === "(" || c === "[") {
      if (depth === 0) inner = "";
      depth += 1;
      if (depth > 1) inner += c;
    } else if (c === ")" || c === "]") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        if (inner.split(/[^\p{L}\p{N}]+/u).some((w) => DEDUP_KEEP_WORDS.has(w))) kept += " " + inner;
        inner = "";
      } else {
        inner += c;
      }
    } else if (depth === 0) {
      kept += c;
    } else {
      inner += c;
    }
  }
  if (depth > 0) kept += " " + inner;
  return kept
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !["remaster", "remastered", "remastering"].includes(w) && !/^\d{4}$/.test(w))
    .join(" ");
}

/// Split a credit string into comparable artist names (mirror of the
/// backend `credit_names`): lowercase, split on `, ; & /` and the
/// `feat`/`ft`/`featuring` markers; hyphenated billing stays one name.
function artistNames(s) {
  const names = new Set();
  let cur = [];
  const flush = () => {
    if (cur.length) {
      names.add(cur.join(" "));
      cur = [];
    }
  };
  for (const segment of String(s || "").toLowerCase().split(/[,;&/]/)) {
    for (const raw of segment.split(/\s+/)) {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!w) continue;
      if (w === "feat" || w === "ft" || w === "featuring") flush();
      else cur.push(w);
    }
    flush();
  }
  return names;
}

/// True when two credit lists plausibly bill the same artist set: at least
/// half of the smaller list matches (order never matters; empty is no
/// evidence, so it never merges).
function creditsOverlap(a, b) {
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const name of a) if (b.has(name)) common += 1;
  return common * 2 >= Math.min(a.size, b.size);
}

/// title -> [{ i, dur, artists }] so duplicate lookups over a list are a
/// map hit instead of an O(n²) scan.
function contentIndex(list) {
  const idx = new Map();
  list.forEach((t, i) => {
    if (!t.id || !(t.duration_secs > 0)) return;
    const key = normKeyText(t.title);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ i, dur: t.duration_secs, artists: artistNames(t.artist) });
  });
  return idx;
}

/// Index of the kept track that `t` duplicates, else -1. Fingerprint-less
/// tracks (no id or no duration) only ever match themselves, like backend.
function findDuplicate(index, t) {
  if (!t.id || !(t.duration_secs > 0)) return -1;
  const cands = index.get(normKeyText(t.title));
  if (!cands) return -1;
  const artists = artistNames(t.artist);
  const hit = cands.find(
    (c) =>
      Math.abs(c.dur - t.duration_secs) <= DEDUP_DURATION_TOL &&
      creditsOverlap(c.artists, artists),
  );
  return hit ? hit.i : -1;
}

/// Refresh the index entry for position `i` after its track was replaced
/// with a better copy (duration/credits may differ).
function reindexEntry(index, t, i) {
  const bucket = index.get(normKeyText(t.title));
  if (!bucket) return;
  const at = bucket.findIndex((c) => c.i === i);
  const entry = { i, dur: t.duration_secs, artists: artistNames(t.artist) };
  if (at >= 0) bucket[at] = entry;
  else bucket.push(entry);
}

function betterCopy(a, b) {
  if (!!a.hq !== !!b.hq) return !!a.hq;
  if ((a.plays || 0) !== (b.plays || 0)) return (a.plays || 0) > (b.plays || 0);
  if (String(a.title).length !== String(b.title).length) {
    return String(a.title).length < String(b.title).length;
  }
  return false;
}

/// Collapse same-id repeats and same-recording/different-id copies.
/// Returns `{ list, removed }` so callers can report the cleanup.
function dedupeTracks(tracks) {
  const seenIds = new Set();
  const index = new Map();
  const out = [];
  let removed = 0;
  for (const t of tracks) {
    if (t.id && seenIds.has(t.id)) {
      removed += 1;
      continue;
    }
    if (t.id) seenIds.add(t.id);
    const at = findDuplicate(index, t);
    if (at >= 0) {
      removed += 1;
      if (betterCopy(t, out[at])) {
        out[at] = t;
        reindexEntry(index, t, at);
      }
      continue;
    }
    if (t.id && t.duration_secs > 0) {
      const key = normKeyText(t.title);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({
        i: out.length,
        dur: t.duration_secs,
        artists: artistNames(t.artist),
      });
    }
    out.push(t);
  }
  return { list: out, removed };
}

/// First copy of each id wins — card/row level insurance, mirrors the
/// backend `dedup_feed`. Id-less entries pass through (nothing to collide).
function uniqById(list) {
  const seen = new Set();
  return (list || []).filter((x) => {
    if (!x) return false;
    if (!x.id) return true;
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

async function doSearch(opts = {}) {
  const append = !!opts.append;
  const silent = !!opts.silent;
  const q = String(opts.query ?? $("#search-input").value).trim();
  hideSuggest();
  if (!q) {
    resultsSub.textContent = "Type a query, then press Search.";
    return;
  }
  if (append && (loadingMore || searchExhausted || !currentItems().length)) return;

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

  // Capture the scope before awaiting: a chip click mid-flight must not
  // route entity rows into the track table (or vice versa).
  const cards = !isTracks();
  const kind = cards ? KIND_SPEC[activeFilter].kind : null;
  let payload = null;
  try {
    payload = cards
      ? await invoke("search_entities", { query: q, kind, limit: PAGE_SIZE, page: append ? searchPage + 1 : 1 })
      : await invoke("search_songs", { query: q, limit: PAGE_SIZE, page: append ? searchPage + 1 : 1 });
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
  // Both commands answer with `page_full`, measured BEFORE dedup shrank the
  // page, so it — never the list length — decides whether more exist upstream.
  const pageFull = !!(payload && payload.page_full);
  if (cards) return applyEntityPage(payload, append, q, pageFull, KIND_SPEC[activeFilter]);

  const tracks = (payload && payload.tracks) || [];

  if (!append) {
    searchPage = 1;
    // Backend collapses upstream repeats, but a stale page can still hand
    // us dupes — dedupe defensively before first paint.
    const clean = dedupeTracks(tracks);
    lastResults = clean.list;
    searchExhausted = !pageFull;
    if (!lastResults.length) {
      resultsEl.innerHTML = "";
      paintResultsMode();
      renderFeatured();
      updateLoadMore();
      resultsSub.textContent = `No tracks found for "${q}".`;
      showErrorRetry(`No tracks found for "${q}".`, () => doSearch({ query: q }));
      return;
    }
    diag(
      `search "${q}"`,
      true,
      `${lastResults.length} tracks${clean.removed ? ` (${clean.removed} dupes removed)` : ""}`,
    );
    refreshResults();
    return;
  }

  // Append: drop anything already shown (by id or by content) and collapse
  // repeats inside the new page itself.
  const known = new Set(lastResults.map((t) => t.id));
  const index = contentIndex(lastResults);
  const base = lastResults.length;
  const fresh = [];
  for (const t of tracks) {
    if (t.id && known.has(t.id)) continue;
    const at = findDuplicate(index, t);
    if (at >= 0) {
      const stored = at >= base ? fresh[at - base] : lastResults[at];
      if (stored && betterCopy(t, stored)) {
        if (at >= base) fresh[at - base] = t;
        else lastResults[at] = t;
        reindexEntry(index, t, at);
      }
      continue;
    }
    if (t.id) known.add(t.id);
    if (t.id && t.duration_secs > 0) {
      const key = normKeyText(t.title);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({
        i: base + fresh.length,
        dur: t.duration_secs,
        artists: artistNames(t.artist),
      });
    }
    fresh.push(t);
  }
  searchPage += 1;
  if (!pageFull || !fresh.length) searchExhausted = true;
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

/// Fold one entity page into `lastCards` and repaint the card grid.
/// `spec` is the chip that issued the request, not whatever is active now.
function applyEntityPage(payload, append, q, pageFull, spec) {
  const items = (payload && payload.items) || [];
  if (!append) {
    searchPage = 1;
    lastCards = uniqById(items);
    searchExhausted = !pageFull;
    diag(`search "${q}" ${activeFilter}`, true, `${lastCards.length} cards`);
    if (!lastCards.length) {
      renderCards();
      showErrorRetry(`No ${spec.many} found for "${q}".`, () => doSearch({ query: q }));
      return;
    }
    renderCards();
    return;
  }
  const known = new Set(lastCards.map((c) => c.id));
  const fresh = items.filter((c) => !known.has(c.id));
  searchPage += 1;
  if (!pageFull || !fresh.length) searchExhausted = true;
  if (!fresh.length) {
    diag(`search "${q}" ${activeFilter}`, true, "no further pages");
    updateLoadMore();
    resultsSub.textContent = `End of results — ${lastCards.length} ${spec.many} for "${q}".`;
    return;
  }
  lastCards = lastCards.concat(fresh);
  diag(`search "${q}" ${activeFilter} page ${searchPage}`, true, `+${fresh.length} cards`);
  renderCards();
}

// ---------------------------------------------------- inline suggestions -
const suggestEl = $("#search-suggest");
let suggestTimer = 0;
let suggestSeq = 0;

function hideSuggest() {
  suggestEl?.classList.add("hidden");
}

const sugLabel = (label) =>
  `<div class="px-4 pt-2.5 pb-1 font-label-mono text-label-mono text-on-surface-variant">${esc(label)}</div>`;

/// One dropdown row: thumb, title, credit — carrying everything the click
/// handler needs to act without a lookup.
function suggestRow(it, kind) {
  const icon =
    { song: "music_note", album: "album", artist: "person", playlist: "queue_music" }[kind] ||
    "music_note";
  const thumb = it.image
    ? `<img alt="" loading="lazy" class="w-9 h-9 rounded object-cover shrink-0" ${art(it.image)} />`
    : `<span class="w-9 h-9 rounded bg-surface-container-high flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">${icon}</span></span>`;
  return `<button type="button" data-sug-kind="${esc(kind)}" data-sug-id="${esc(it.id)}" data-sug-token="${esc(it.token || "")}" data-sug-title="${esc(it.title)}" data-sug-sub="${esc(it.subtitle || "")}" data-sug-img="${esc(it.image || "")}" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container-low transition-colors text-left">
    ${thumb}
    <span class="min-w-0 flex-1">
      <span class="block font-body-md text-body-md font-medium text-on-surface truncate">${esc(it.title)}</span>
      <span class="block font-body-sm text-body-sm text-on-surface-variant truncate">${esc(it.subtitle || kind)}</span>
    </span>
    <span class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant shrink-0">${esc(kind)}</span>
  </button>`;
}

function suggestHtml(s) {
  const parts = [];
  if (s.top) parts.push(sugLabel("Top result"), suggestRow(s.top, s.top_kind || "song"));
  for (const [key, label] of [
    ["songs", "Songs"],
    ["albums", "Albums"],
    ["artists", "Artists"],
    ["playlists", "Playlists"],
  ]) {
    const items = s[key] || [];
    if (!items.length) continue;
    const kind = key.slice(0, -1);
    parts.push(sugLabel(label), items.map((it) => suggestRow(it, kind)).join(""));
  }
  return parts.length
    ? parts.join("")
    : `<div class="px-4 py-3 font-body-sm text-body-sm text-on-surface-variant">No suggestions.</div>`;
}

/// Empty box → the last searched queries, one tap from re-running them.
function renderRecentSuggest() {
  if (!suggestEl) return;
  const recent = [...new Set(loadHistory())].slice(0, 6);
  if (!recent.length) {
    hideSuggest();
    return;
  }
  suggestEl.innerHTML =
    sugLabel("Recent searches") +
    recent
      .map(
        (q) =>
          `<button type="button" data-sug-q="${esc(q)}" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container-low transition-colors text-left">
            <span class="w-9 h-9 rounded bg-surface-container-high flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">history</span></span>
            <span class="font-body-md text-body-md text-on-surface truncate">${esc(q)}</span>
          </button>`,
      )
      .join("");
  suggestEl.classList.remove("hidden");
}

async function fetchSuggest(q) {
  const seq = ++suggestSeq;
  try {
    const s = await invoke("search_suggestions", { query: q });
    if (seq !== suggestSeq) return; // a newer keystroke already superseded this
    suggestEl.innerHTML = suggestHtml(s);
    suggestEl.classList.remove("hidden");
    diag(
      "suggest",
      true,
      `${(s.top ? 1 : 0) + s.songs.length + s.albums.length + s.artists.length + s.playlists.length} rows`,
    );
  } catch (err) {
    diag("suggest", false, String(err).slice(0, 90));
  }
}

$("#search-input").addEventListener("input", () => {
  const q = $("#search-input").value.trim();
  clearTimeout(suggestTimer);
  if (q.length >= 2) suggestTimer = setTimeout(() => fetchSuggest(q), 250);
  else if (!q) renderRecentSuggest();
  else hideSuggest();
});
$("#search-input")?.addEventListener("focus", () => {
  const q = $("#search-input").value.trim();
  if (!q) renderRecentSuggest();
  else if (q.length >= 2) fetchSuggest(q);
});

suggestEl?.addEventListener("click", (e) => {
  const qbtn = e.target.closest("[data-sug-q]");
  if (qbtn) {
    $("#search-input").value = qbtn.dataset.sugQ;
    hideSuggest();
    doSearch();
    return;
  }
  const btn = e.target.closest("[data-sug-kind]");
  if (!btn) return;
  const kind = btn.dataset.sugKind;
  const item = {
    id: btn.dataset.sugId,
    token: btn.dataset.sugToken,
    title: btn.dataset.sugTitle,
    subtitle: btn.dataset.sugSub,
    image: btn.dataset.sugImg,
  };
  hideSuggest();
  if (kind === "song") playTracksAt([{ ...item, artist: item.subtitle, album: "", duration: 0 }], 0);
  else if (kind === "playlist") openPlaylist(item);
  else openDetail(kind, item);
  diag("suggest pick", null, `${kind}: ${item.title}`);
});

// Clicking away closes the dropdown (inputs/buttons inside it stay live).
document.addEventListener("click", (e) => {
  if (!suggestEl || suggestEl.classList.contains("hidden")) return;
  if (e.target.closest("#search-suggest") || e.target.closest("#search-input")) return;
  hideSuggest();
});

// --------------------------------------------------------- control wiring -
for (const chip of $$(".filter-chip")) {
  chip.addEventListener("click", () => {
    const next = chip.dataset.chip || "tracks";
    if (next === activeFilter) return;
    activeFilter = next;
    featuredPage = 0;
    paintChips();
    const q = $("#search-input").value.trim();
    if (q) doSearch({ query: q });
    else if (isTracks()) refreshResults();
    else renderCards();
    diag("search scope", null, next);
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
  if (label) label.textContent = hidden ? "Show Types" : "Hide Types";
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
  else if (btn.dataset.action === "fav") toggleFavTrack(track);
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
  if (e.key === "Escape") {
    $("#search-input").value = "";
    hideSuggest();
  }
});
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  $("#search-input").focus();
});
$("#play-all").addEventListener("click", () => {
  const list = currentView();
  if (!list.length) {
    showError("Nothing to play — run a search first.");
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
    tracks = dedupeTracks(await invoke("playlist_tracks", { id })).list;
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
  if (img && spot.image) paintArt(img, spot.image);
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
    <div data-playlist-id="${esc(p.id)}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div>
        <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(p.image)} />
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
  // Already deduped in loadHome — render the same array the click handlers
  // index into, or a removed dupe would shift every row's data-top-* id.
  const tracks = homeFeed.top_tracks;
  if (!tracks.length) {
    list.innerHTML =
      '<p class="py-4 font-body-sm text-body-sm text-on-surface-variant">Rankings are unavailable right now.</p>';
    return;
  }
  list.innerHTML = tracks
    .map(
      (t, i) => `
    <div class="flex items-center justify-between p-4 rounded-lg hover:bg-surface-container-low transition-colors group cursor-pointer" data-top-index="${i}">
      <div class="flex items-center gap-4 min-w-0">
        <span class="font-headline-md font-semibold ${i === 0 ? "text-primary" : "text-on-surface-variant"} w-6 text-center">${String(i + 1).padStart(2, "0")}</span>
        <div class="w-24 h-24 rounded-lg bg-surface-container-high overflow-hidden flex items-center justify-center text-on-surface-variant shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image)} />
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
        <button type="button" data-top-fav="${i}" title="Favorite this track" class="w-8 h-8 rounded-full bg-surface-container-high hover:bg-primary hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
        </button>
        <button type="button" data-top-dl="${i}" title="Download this track" class="w-8 h-8 rounded-full bg-surface-container-high hover:bg-primary hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]">download</span>
        </button>
        ${addBtn(t)}
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
  // Normalize once so every card grid, carousel and click handler on Home
  // (and the Playlists screen fed from the same feed) sees each item once.
  homeFeed.playlists = uniqById(homeFeed.playlists);
  homeFeed.charts = uniqById(homeFeed.charts);
  homeFeed.albums = uniqById(homeFeed.albums);
  homeFeed.artists = uniqById(homeFeed.artists);
  homeFeed.top_tracks = dedupeTracks(homeFeed.top_tracks || []).list;
  diag(
    "home",
    true,
    `${homeFeed.playlists.length} playlists · ${homeFeed.charts.length} charts · ${homeFeed.top_tracks.length} top tracks`,
  );
  renderHero();
  renderHomePlaylists();
  renderHomeTop();
  renderPlaylists();
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
  if (btn) openDetail("playlist", plItemById(btn.dataset.playlistId));
});
$("#home-top-list")?.addEventListener("click", (e) => {
  const fav = e.target.closest("[data-top-fav]");
  if (fav && homeFeed) {
    const track = homeFeed.top_tracks[Number(fav.dataset.topFav)];
    if (track) toggleFavTrack(track);
    return;
  }
  const dl = e.target.closest("[data-top-dl]");
  if (dl && homeFeed) {
    const track = homeFeed.top_tracks[Number(dl.dataset.topDl)];
    if (track) downloadTrack(track, dl);
    return;
  }
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
// Genre pills anywhere on Home run a real track search — never inherit
// whatever entity chip was left active on the Search screen.
$('[data-view="home"]')?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-query]");
  if (!chip) return;
  if (!isTracks()) {
    activeFilter = "tracks";
    paintChips();
  }
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

// ------------------------------------------------- local playlists (mine) -
// They live in the same library array as saved items, flagged `local`, so the
// Library grid, `plItemById` and the Saved chip all pick them up unchanged.
function loadLocalPls() {
  return loadLibrary().filter((p) => p.local);
}
function saveLocalPls(list) {
  try {
    const rest = loadLibrary().filter((p) => !p.local);
    localStorage.setItem(LIBRARY_KEY, JSON.stringify([...rest, ...list].slice(0, 50)));
  } catch {}
}
function createLocalPl(name, tracks = []) {
  const title = String(name || "").trim();
  if (!title) return null;
  const pl = { id: `local-${Date.now()}`, title, local: true, tracks };
  saveLocalPls([...loadLocalPls(), pl]);
  renderLibrary();
  return pl;
}
function addToLocalPl(id, track) {
  const list = loadLocalPls();
  const pl = list.find((p) => p.id === id);
  if (!pl) return false;
  pl.tracks = pl.tracks || [];
  if (!track.id || !pl.tracks.some((t) => t.id === track.id)) pl.tracks.push(track);
  saveLocalPls(list);
  renderLibrary();
  return true;
}
function removeLocalPl(id) {
  saveLocalPls(loadLocalPls().filter((p) => p.id !== id));
  renderLibrary();
}

// The picker: one modal, one capture-phase listener, so no row builder needs
// its own handler — clicking Add anywhere stops the row's play click first.
let pickTrack = null;

function renderPickerList() {
  const box = $("#pl-picker-list");
  if (!box) return;
  const list = loadLocalPls();
  box.innerHTML = list.length
    ? list
        .map(
          (p) => `<button type="button" data-pick-id="${esc(p.id)}" class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-surface-container-low text-left transition-colors">
      <span class="font-body-md text-body-md text-on-surface truncate">${esc(p.title)}</span>
      <span class="font-label-mono text-label-mono text-secondary shrink-0">${(p.tracks || []).length} tracks</span>
    </button>`,
        )
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant px-1 py-2">No local playlists yet — name one below.</p>';
}
function openPicker(t) {
  pickTrack = t;
  npText("pl-picker-track", [t.artist, t.title].filter(Boolean).join(" — "));
  renderPickerList();
  $("#pl-picker")?.classList.remove("hidden");
  $("#pl-picker-name")?.focus();
}
function closePicker() {
  $("#pl-picker")?.classList.add("hidden");
  pickTrack = null;
}
/// If the list being edited is the one open on screen, repaint it.
function syncOpenLocal(id) {
  if (pdCurrentId !== id || !pdLocal) return;
  const fresh = loadLibrary().find((x) => x.id === id);
  if (!fresh) return;
  pdTracks = fresh.tracks || [];
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPd();
}
function pickerCreate() {
  const name = $("#pl-picker-name");
  const pl = createLocalPl(name?.value);
  if (!pl) return;
  if (name) name.value = "";
  if (pickTrack && addToLocalPl(pl.id, pickTrack)) {
    toast(`Added to ${pl.title}`, "success", 2600);
    closePicker();
  } else {
    toast(`Created ${pl.title}`, "success", 2600);
    renderPickerList();
  }
}

document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest?.("[data-add-id]");
    if (!btn) return;
    // Capture phase: kill the row's own play/fav handlers for this click.
    e.stopPropagation();
    openPicker({
      id: btn.dataset.addId,
      title: btn.dataset.addTitle,
      artist: btn.dataset.addArtist,
      album: btn.dataset.addAlbum,
      image: btn.dataset.addImage,
      duration: btn.dataset.addDur,
      duration_secs: 0,
    });
  },
  true,
);
$("#pl-picker-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick-id]");
  if (!btn || !pickTrack) return;
  const name = loadLocalPls().find((p) => p.id === btn.dataset.pickId)?.title || "playlist";
  addToLocalPl(btn.dataset.pickId, pickTrack);
  syncOpenLocal(btn.dataset.pickId);
  toast(`Added to ${name}`, "success", 2600);
  closePicker();
});
$("#pl-picker-create")?.addEventListener("click", pickerCreate);
$("#pl-picker-name")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    pickerCreate();
  }
});
$("#pl-picker")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-pl-picker-close]")) closePicker();
});

/// One listening session, recorded where playback actually starts.
function pushPlay(track) {
  try {
    const next = [{ ...track, ts: Date.now() }, ...loadPlays().filter((x) => x.id !== track.id)].slice(0, 100);
    localStorage.setItem(PLAYS_KEY, JSON.stringify(next));
    renderPlays();
  } catch {}
}

// ---------------------------------------------------------------- favorites -
const FAVS_KEY = "tm-favorites";

function loadFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveFavs(list) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {}
}
function isFav(id) {
  return loadFavs().some((x) => x.id === id);
}
/// Inline style snippet so freshly rendered hearts match persisted state.
function favFill(id) {
  return isFav(id) ? ` style="font-variation-settings: 'FILL' 1;"` : "";
}
/// Repaint every heart on screen after a toggle (rows re-render rarely).
function paintFavHearts() {
  for (const icon of $$("[data-fav-icon]")) {
    icon.style.fontVariationSettings = isFav(icon.dataset.favIcon) ? "'FILL' 1" : "'FILL' 0";
  }
}

function toggleFavTrack(track) {
  if (!track || !track.id) return false;
  const favs = loadFavs();
  const at = favs.findIndex((x) => x.id === track.id);
  let on;
  if (at >= 0) {
    favs.splice(at, 1);
    on = false;
  } else {
    favs.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      image: track.image,
      duration: track.duration || fmtTime(track.duration_secs || 0),
      duration_secs: track.duration_secs || 0,
      hq: !!track.hq,
      plays: track.plays || 0,
    });
    on = true;
  }
  saveFavs(favs);
  paintFavHearts();
  renderFavs();
  toast(
    on ? `Added "${track.title}" to favorites.` : `Removed "${track.title}" from favorites.`,
    on ? "success" : "info",
  );
  diag("favorite", on, track.title);
  return on;
}

/// Library "Favorite Masters" section: play on row click, download + remove.
function renderFavs() {
  const box = $("#library-favs");
  if (!box) return;
  const favs = uniqById(loadFavs());
  const count = $("#library-favs-count");
  if (count) count.textContent = `${favs.length} track${favs.length === 1 ? "" : "s"}`;
  if (!favs.length) {
    box.innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Nothing favorited yet — tap the heart on any track.</p>';
    return;
  }
  box.innerHTML = "";
  favs.forEach((t, i) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-fav-dl="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        <button type="button" data-fav-del="${i}" title="Remove from favorites" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" style="font-variation-settings: 'FILL' 1;">favorite</span>
        </button>
      </div>`;
    row.addEventListener("click", (e) => {
      const del = e.target.closest("[data-fav-del]");
      if (del) {
        e.stopPropagation();
        toggleFavTrack(favs[Number(del.dataset.favDel)]);
        return;
      }
      const dl = e.target.closest("[data-fav-dl]");
      if (dl) {
        e.stopPropagation();
        downloadTrack(favs[Number(dl.dataset.favDl)], dl);
        return;
      }
      playTracksAt(favs, i);
    });
    box.appendChild(row);
  });
}

function playTracksAt(list, index) {
  // One choke point for "play this whole list": collapse repeats first, but
  // keep playing the row the user actually clicked.
  const tracks = dedupeTracks(list).list;
  const at = tracks.indexOf(list[index]);
  queue.length = 0;
  for (const t of tracks) queue.push({ track: t, state: null });
  queueTab = "next";
  queueIndex = -1;
  renderQueue();
  playQueueItem(at >= 0 ? at : 0);
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
/// `limit` paints only the first rows (the artist screen's "load more" walks
/// the rest) while every handler still indexes into the full list.
function trackRows(list, box, emptyMsg, limit) {
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${emptyMsg || "Nothing here yet."}</p>`;
    return;
  }
  const shown = Number.isFinite(limit) && limit < list.length ? list.slice(0, limit) : list;
  box.innerHTML = "";
  shown.forEach((t, i) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <span class="font-label-mono text-[11px] text-on-surface-variant w-5 text-right shrink-0">${i + 1}</span>
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${esc(t.artist || "")}</div>
        </div>
      </div>
      <div class="flex items-center gap-3 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-fav-idx="${i}" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" data-fav-icon="${esc(t.id || "")}"${favFill(t.id || "")}>favorite</span>
        </button>
        <button type="button" data-dl-idx="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        ${addBtn(t)}
        <span class="material-symbols-outlined text-[18px] opacity-0 group-hover:opacity-100">play_arrow</span>
      </div>`;
    row.addEventListener("click", (e) => {
      const fav = e.target.closest("[data-fav-idx]");
      if (fav) {
        e.stopPropagation();
        toggleFavTrack(list[Number(fav.dataset.favIdx)]);
        return;
      }
      const dl = e.target.closest("[data-dl-idx]");
      if (dl) {
        e.stopPropagation();
        downloadTrack(list[Number(dl.dataset.dlIdx)], dl);
        return;
      }
      playTracksAt(list, i);
    });
    box.appendChild(row);
  });
}

let pdTracks = [];
// Playlists screen: `pdVisible` is how much of the table is painted,
// `pdCurrentId`/`pdLocal` say which playlist owns it, `pdSeq` drops stale
// fetches. The hero (`plFeatured`) always shows the same playlist.
let pdVisible = 0;
let pdLocal = false;
let pdCurrentId = "";
let pdSeq = 0;
const PD_FIRST = 30;
let plFeatured = null;
/// Entries rendered by the last `renderPlaylists()` — card, tag and label.
let plItems = [];
let plFilter = "all";
let plQuery = "";
let ddTracks = [];
// Artist screen paging: `ddPage` is the last page fetched, `ddMore` says the
// catalogue still continues behind it, `ddVisible` is what the list paints.
let ddToken = "";
let ddPage = 0;
let ddMore = false;
let ddVisible = 0;
let ddReleases = 0;
let ddSubExtra = "";
let ddUnit = "tracks";
/// Discography rows (each tagged album/single) and the chip filtering them.
let ddReleaseList = [];
let ddFilter = "all";
const FILTER_ON =
  "px-3 py-1 rounded-full bg-surface-container-lowest text-on-surface shadow-sm font-label-md text-label-md font-medium";
const FILTER_OFF =
  "px-3 py-1 rounded-full text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors";
const DD_FIRST = 50; // rows painted the moment the screen opens
/// Detail screens opened from inside another one — Back walks out of them.
const ddStack = [];
let ddCurrent = null;
/// The view Back lands on when the stack is empty (Home, Search, …).
let ddReturnView = "home";
/// Bumped by every open so a stale response never paints over a newer screen.
let ddSeq = 0;

function plItemById(id) {
  const pools = homeFeed
    ? [...lastCards, ...homeFeed.playlists, ...homeFeed.charts, homeFeed.spotlight].filter(Boolean)
    : lastCards;
  return (
    pools.find((p) => p.id === id) ||
    loadLibrary().find((p) => p.id === id) ||
    { id, title: "Playlist" }
  );
}

/// How a playlist should be tagged wherever it is opened from.
function plEntryById(id) {
  const hit = plItems.find((e) => e.p.id === id);
  if (hit) return hit;
  const item = plItemById(id);
  const saved = loadLibrary().some((x) => x.id === id);
  return { p: item, tag: saved ? "SAVED" : "CURATED", label: saved ? "In Library" : "JioSaavn" };
}

/// Playlists screen: the hero, the meta line and the track table always show
/// the same playlist, exactly like the design's featured card + table.
async function openPlaylist(item, { scroll = true } = {}) {
  // Claim the id before `showView` so its playlists hook cannot re-enter us.
  const entry = plEntryById(item.id);
  plFeatured = entry;
  pdCurrentId = item.id;
  pdLocal = Array.isArray(item.tracks);
  pdTracks = pdLocal ? (item.tracks || []).slice() : [];
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  showView("playlists");
  paintFeatured();
  const detail = $("#playlist-detail");
  detail?.classList.remove("hidden");
  npText("pd-title", item.title || "Playlist");
  npText("pd-title-copy", item.title ? `• ${item.title}` : "");
  npText("pd-subtitle", item.subtitle || (pdLocal ? "Local playlist" : "Loading tracks…"));
  $("#pd-delete")?.classList.toggle("hidden", !item.local);
  const img = $("#pd-image");
  if (img) {
    if (item.image) {
      paintArt(img, item.image);
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#pd-tracks");
  if (box && !pdLocal) {
    box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';
  }
  if (scroll) detail?.scrollIntoView({ behavior: "smooth", block: "start" });
  paintPd();
  if (pdLocal) {
    diag("playlist", true, `${pdTracks.length} tracks (local)`);
    return;
  }
  const seq = ++pdSeq;
  try {
    const list = dedupeTracks(await invoke("playlist_tracks", { id: item.id })).list;
    if (seq !== pdSeq) return;
    pdTracks = list;
    pdVisible = Math.min(PD_FIRST, pdTracks.length);
  } catch (err) {
    if (seq !== pdSeq) return;
    diag("playlist", false, String(err));
    npText("pd-subtitle", `Could not load: ${String(err).slice(0, 90)}`);
    pdTracks = [];
    paintPd();
    return;
  }
  paintPd();
  diag("playlist", true, `${pdTracks.length} tracks`);
}

/// Counts, subtitle and the table/footer for whatever `pdTracks` holds now.
function paintPd() {
  const n = pdTracks.length;
  const item = plFeatured?.p || {};
  npText("pd-total", n ? `${n} TRACKS TOTAL` : "");
  npText("pd-subtitle", [item.subtitle, `${n} tracks`].filter(Boolean).join(" · "));
  paintPdRows();
  paintFeaturedMeta();
}

function paintPdRows() {
  const box = $("#pd-tracks");
  if (!box) return;
  box.innerHTML = "";
  if (!pdTracks.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${
      pdLocal ? "No tracks yet — open any track elsewhere and hit the add button." : "That playlist has no tracks."
    }</p>`;
    $("#pd-foot")?.classList.add("hidden");
    return;
  }
  const shown = pdTracks.slice(0, pdVisible);
  shown.forEach((t, i) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = trackRow(t, i, i === queueIndex && queue[queueIndex]?.track.id === t.id, "list");
    const row = wrap.firstElementChild;
    row.addEventListener("click", (e) => {
      const action = e.target.closest("[data-row-action]")?.dataset.rowAction;
      if (action === "download") {
        e.stopPropagation();
        downloadTrack(t, e.target.closest("button"));
        return;
      }
      if (action === "fav") {
        e.stopPropagation();
        toggleFavTrack(t);
        return;
      }
      playTracksAt(pdTracks, i);
    });
    box.appendChild(row);
  });
  const left = pdTracks.length - shown.length;
  $("#pd-foot")?.classList.toggle("hidden", !pdTracks.length);
  $("#pd-more")?.classList.toggle("hidden", !left);
  npText("pd-showing", `Showing ${shown.length} of ${pdTracks.length} tracks in playlist`);
  npText("pd-more-label", `Load all ${pdTracks.length} tracks`);
}

/// Subtitle = whatever the card said + how much of the work is loaded.
function paintDdSubtitle() {
  const loaded = ddTracks.length ? `${ddTracks.length} ${ddUnit}` : "";
  npText("dd-subtitle", [ddSubExtra, loaded].filter(Boolean).join(" · "));
}

/// The track list plus its "show/load more" bar, kept in step with each other.
function renderDd(emptyMsg) {
  trackRows(ddTracks, $("#dd-tracks"), emptyMsg, ddVisible);
  npText("dd-list-count", ddTracks.length ? `${ddTracks.length} loaded` : "");
  const wrap = $("#dd-more-wrap");
  if (!wrap) return;
  const left = Math.max(0, ddTracks.length - ddVisible);
  if (!left && !ddMore) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const btn = $("#dd-more");
  if (btn) btn.disabled = false;
  npText("dd-more-label", left ? `Show ${left} more song${left === 1 ? "" : "s"}` : "Load more songs");
}

/// Artist header furniture: verification, listeners, bio, discography.
function paintArtistHeader(ov) {
  if (!ov) return;
  if (ov.name) npText("dd-title", ov.name);
  if (ov.image) paintArt($("#dd-image"), ov.image);
  if (ov.listeners) {
    const chip = $("#dd-listeners");
    if (chip) {
      chip.textContent = `${Number(ov.listeners).toLocaleString("en-US")} Listeners`;
      chip.classList.remove("hidden");
    }
  }
  if (ov.verified) $("#dd-verified")?.classList.remove("hidden");
  if (ov.bio) {
    const bio = $("#dd-bio");
    if (bio) {
      bio.textContent = ov.bio;
      bio.classList.remove("hidden");
    }
  }
  ddReleaseList = ov.releases || [];
  ddReleases = ddReleaseList.length;
  renderReleases();
}

/// The release grid plus its All / Albums / Singles chips.
function renderReleases() {
  const grid = $("#dd-releases");
  if (!grid) return;
  const counts = { all: ddReleaseList.length, album: 0, single: 0 };
  for (const r of ddReleaseList) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const shown = ddReleaseList.filter((r) => ddFilter === "all" || r.kind === ddFilter);
  grid.innerHTML = shown.map(releaseCard).join("");
  $("#dd-discography")?.classList.toggle("hidden", !ddReleaseList.length);
  npText(
    "dd-release-count",
    `${ddReleases} release${ddReleases === 1 ? "" : "s"}`,
  );
  const chips = $("#dd-release-filters");
  if (!chips) return;
  // Nothing to split when every release sits on the same shelf.
  chips.classList.toggle("hidden", !counts.album || !counts.single);
  for (const btn of $$("[data-dd-filter]", chips)) {
    const kind = btn.dataset.ddFilter;
    btn.className = kind === ddFilter ? FILTER_ON : FILTER_OFF;
    btn.textContent = `${btn.dataset.ddLabel} (${counts[kind] || 0})`;
  }
}

/// One discography card — same tokens the album cards take, so a click opens
/// the release itself.
function releaseCard(a) {
  const meta = [a.year, a.count ? `${a.count} track${a.count === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `
    <div data-dd-kind="album" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col cursor-pointer">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-surface-container-high mb-2.5">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(a.image || "")} />
        ${a.year ? `<span class="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-surface-container-lowest/90 backdrop-blur-md font-label-mono text-[9px] text-on-surface">${esc(a.year)}</span>` : ""}
        <div class="absolute inset-0 bg-primary/20 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span class="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-lg"><span class="material-symbols-outlined text-[20px]" style="font-variation-settings: 'FILL' 1;">play_arrow</span></span>
        </div>
      </div>
      <span class="font-label-md text-label-md text-on-surface font-medium truncate">${esc(a.title || "")}</span>
      <span class="font-label-mono text-[10px] text-on-surface-variant truncate mt-0.5">${esc(meta || a.subtitle || "")}</span>
    </div>`;
}

/// Append one upstream page to the loaded catalogue. "Still full" *and* "brought
/// something new" both have to hold before the works are called unfinished.
function mergeArtistPage(next) {
  ddPage += 1;
  const before = ddTracks.length;
  ddTracks = dedupeTracks([...ddTracks, ...((next && next.tracks) || [])]).list;
  ddMore = !!(next && next.page_full) && ddTracks.length > before;
  ddVisible = ddTracks.length;
}

/// Walk every remaining page so Play/Shuffle means *all* the works, painting
/// each page as it lands. Stops on its own if the catalogue stops growing.
async function loadAllArtistSongs() {
  let pages = 0;
  while (ddMore && ddToken && pages < 40) {
    const seq = ddSeq;
    let next;
    try {
      next = await invoke("artist_tracks", { token: ddToken, page: ddPage + 1 });
    } catch (err) {
      diag("artist page", false, String(err));
      toast(`Stopped after ${ddTracks.length} songs: ${String(err).slice(0, 70)}`, "error");
      break;
    }
    if (seq !== ddSeq) return false;
    mergeArtistPage(next);
    pages += 1;
    paintDdSubtitle();
    renderDd();
  }
  return true;
}

/// Album / artist screen (the `detail` view) — token comes from the card.
/// Artists load in two streams: the songs (paged, so the whole catalogue is
/// walkable) and the header/discography (one call).
async function openDetail(kind, item, opts = {}) {
  const isArtist = kind === "artist";
  if (opts.push && ddCurrent) ddStack.push(ddCurrent);
  else ddStack.length = 0;
  ddCurrent = { kind, item };
  // Captured before the view switch: where Back lands once the stack is dry.
  const here = views.find((v) => !v.classList.contains("hidden"));
  if (!opts.push && here && here.dataset.view !== "detail") ddReturnView = here.dataset.view;
  // A second open while the first is in flight must not paint over it.
  const seq = ++ddSeq;
  showView("detail");
  npText("dd-kind", kind.toUpperCase());
  npText("dd-title", item.title || "—");
  npText("dd-subtitle", "Loading tracks…");
  for (const sel of ["#dd-verified", "#dd-listeners", "#dd-bio", "#dd-discography", "#dd-more-wrap", "#dd-list-head"])
    $(sel)?.classList.add("hidden");
  ddTracks = [];
  ddToken = item.token || "";
  ddPage = 0;
  ddMore = false;
  ddVisible = 0;
  ddReleases = 0;
  ddReleaseList = [];
  ddFilter = "all";
  ddSubExtra = item.subtitle || "";
  ddUnit = isArtist ? "songs" : "tracks";
  if (isArtist) $("#dd-list-head")?.classList.remove("hidden");
  const img = $("#dd-image");
  if (img) {
    if (item.image) {
      paintArt(img, item.image);
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#dd-tracks");
  if (box) box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';

  if (!isArtist) {
    try {
      const raw =
        kind === "playlist"
          ? await invoke("playlist_tracks", { id: item.id })
          : await invoke("album_tracks", { token: item.token });
      ddTracks = dedupeTracks(raw).list;
    } catch (err) {
      diag(kind, false, String(err));
      npText("dd-subtitle", `Could not load ${kind}: ${String(err).slice(0, 80)}`);
      if (box) box.innerHTML = "";
      $("#dd-list-head")?.classList.add("hidden");
      return;
    }
    if (seq !== ddSeq) return;
    ddVisible = ddTracks.length;
    paintDdSubtitle();
    renderDd(`No tracks found for this ${kind}.`);
    diag(kind, true, `${ddTracks.length} tracks`);
    return;
  }

  // Songs first: a slow header must not hold up the first page of the works.
  const [page, overview] = await Promise.allSettled([
    invoke("artist_tracks", { token: item.token, page: 0 }),
    invoke("artist_overview", { token: item.token }),
  ]);
  if (seq !== ddSeq) return;
  if (page.status === "rejected") {
    diag("artist", false, String(page.reason));
    npText("dd-subtitle", `Could not load artist: ${String(page.reason).slice(0, 80)}`);
    if (box) box.innerHTML = "";
    $("#dd-list-head")?.classList.add("hidden");
    return;
  }
  const first = page.value || {};
  ddTracks = dedupeTracks(first.tracks || []).list;
  ddMore = !!first.page_full;
  ddVisible = Math.min(DD_FIRST, ddTracks.length);
  if (overview.status === "fulfilled") paintArtistHeader(overview.value);
  ddSubExtra = ddReleases ? `${ddReleases} releases` : ddSubExtra;
  paintDdSubtitle();
  renderDd("No songs found for this artist.");
  diag("artist", true, `${ddTracks.length} songs · ${ddReleases} releases`);
}

/// One playlist card: corner tag, cover, blurb, tracks + source label.
/// `tag`/`label` are passed by the caller so the same card renders in the
/// Playlists grid and in Library without sniffing where it came from.
function plCard(p, tag = "CURATED", label = "JioSaavn") {
  const n = p.count || (p.tracks || []).length || 0;
  const blurb = p.blurb || p.subtitle || (p.local ? "Your own playlist." : "Curated on JioSaavn.");
  const cover = p.image
    ? `<img alt="" loading="lazy" class="w-full h-full object-cover" ${art(p.image)} />`
    : `<div class="w-full h-full bg-surface flex flex-col items-center justify-center gap-1.5 text-on-surface-variant">
          <span class="material-symbols-outlined text-[40px]">${esc(p.icon || "playlist_play")}</span>
          ${p.synthetic ? '<span class="font-label-mono text-[9px] uppercase tracking-wider">Auto-generated</span>' : ""}
        </div>`;
  return `
    <div data-pl-id="${esc(p.id)}"${p.synthetic ? ` data-pl-synthetic="${esc(p.synthetic)}"` : ""} class="rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col cursor-pointer overflow-hidden">
      <div class="relative aspect-square overflow-hidden bg-surface-container-high">
        ${cover}
        <span class="absolute top-2.5 left-2.5 px-2 py-1 rounded bg-black/70 text-white font-label-mono text-[9px] uppercase tracking-wider">${esc(tag)}</span>
        <button type="button" title="Open playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
      </div>
      <div class="p-3.5 flex flex-col gap-1.5 min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(p.title || "")}</p>
        <p class="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">${esc(blurb)}</p>
        <div class="flex items-center justify-between gap-2 pt-0.5">
          <span class="font-label-mono text-label-mono text-secondary truncate">${n ? `${n} Tracks` : ""}</span>
          <span class="font-label-mono text-label-mono text-secondary shrink-0">${esc(label)}</span>
        </div>
      </div>
    </div>`;
}

function ddCard(kind, a) {
  return `
    <div data-dd-kind="${kind}" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
        <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(a.image || "")} />
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

/// Hours + minutes for a whole playlist: "2h 42m".
function fmtSpan(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

/// The two cards that only exist on this machine: what you hearted and
/// whatever is queued right now.
function plSyntheticEntries() {
  const liked = loadFavs();
  const queued = queue.map((q) => q.track).filter(Boolean);
  return [
    {
      p: {
        id: "pl-liked",
        synthetic: "liked",
        title: "Liked Songs",
        blurb: "All tracks you've marked with a heart across your library.",
        count: liked.length,
        icon: "favorite",
        tracks: liked,
      },
      tag: "Auto-generated",
      label: "Quick Access",
    },
    {
      p: {
        id: "pl-queue",
        synthetic: "queue",
        title: "Current Queue & Session Stash",
        blurb: "On-the-fly tracks queued during your current listening session.",
        count: queued.length,
        icon: "queue_music",
        tracks: queued,
      },
      tag: "Temporary Queue",
      label: "Active Session",
    },
  ];
}

function plBuckets() {
  const feed = homeFeed || { playlists: [], charts: [] };
  return {
    synthetic: plSyntheticEntries(),
    curated: (feed.playlists || []).map((p) => ({ p, tag: "Curated", label: "JioSaavn" })),
    charts: (feed.charts || []).map((p) => ({ p, tag: "Chart", label: "Chart" })),
    saved: loadLibrary().map((p) => ({ p, tag: p.local ? "Local" : "Saved", label: p.local ? "Local" : "In Library" })),
  };
}

function plDedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.p.id) ? false : (seen.add(e.p.id), true)));
}

/// Chips, cards and the featured hero — one pass over the real sources.
function renderPlaylists() {
  const box = $("#playlists-grid");
  if (!box) return;
  const b = plBuckets();
  const all = plDedupe([...b.synthetic, ...b.curated, ...b.charts, ...b.saved]);
  const counts = {
    all: all.length,
    curated: b.curated.length,
    charts: b.charts.length,
    saved: b.saved.length,
  };
  const list = plFilter === "all" ? all : plFilter === "curated" ? b.curated : plFilter === "charts" ? b.charts : b.saved;
  const q = plQuery.trim().toLowerCase();
  const shown = q ? list.filter((e) => (e.p.title || "").toLowerCase().includes(q)) : list;
  // Entries stay resolvable from any chip, so a card opened later still tags right.
  plItems = plDedupe([...all, ...list]);
  box.innerHTML = shown.length
    ? shown.map((e) => plCard(e.p, e.tag, e.label)).join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">No playlists match that.</p>';
  npText("pl-visible", `${shown.length} playlist${shown.length === 1 ? "" : "s"}`);
  npText("pl-count", `(${list.length} collection${list.length === 1 ? "" : "s"})`);
  for (const btn of $$("[data-pl-filter]")) {
    const on = btn.dataset.plFilter === plFilter;
    btn.className = on ? FILTER_ON : FILTER_OFF;
    btn.textContent = `${btn.dataset.plLabel} (${counts[btn.dataset.plFilter] || 0})`;
  }
  // The hero shows a real playlist (like the design's featured card); the
  // auto-generated ones stay in the grid. Nothing open yet → first in view.
  if (!pdCurrentId && shown.length) {
    plFeatured = shown.find((e) => !e.p.synthetic) || shown[0];
    paintFeatured();
  }
}

function featuredMetaText() {
  const p = plFeatured?.p || {};
  const open = pdCurrentId === p.id;
  const n = open ? pdTracks.length : p.count || (p.tracks || []).length || 0;
  const total = open ? fmtSpan(pdTracks.reduce((s, t) => s + (t.duration_secs || 0), 0)) : "";
  // Followers already sit in the blurb, so keep this to tracks + running time.
  return [n ? `${n} tracks` : "", total].filter(Boolean).join(" · ");
}

function paintFeaturedMeta() {
  if (plFeatured) npText("plf-meta", featuredMetaText());
}

function paintFeatured() {
  const box = $("#pl-featured");
  if (!plFeatured) {
    box?.classList.add("hidden");
    return;
  }
  box?.classList.remove("hidden");
  const p = plFeatured.p;
  const img = $("#plf-image");
  if (img && p.image) paintArt(img, p.image);
  npText("plf-title", p.title || "Playlist");
  npText("plf-eyebrow", plFeatured.label || "Playlist");
  npText("plf-desc", p.blurb || p.subtitle || (p.local ? "Your own playlist." : "Curated on JioSaavn."));
  npText("plf-meta", featuredMetaText());
  // Synthetic cards are not storable, so there is nothing to toggle.
  $("#plf-save")?.classList.toggle("hidden", !!p.synthetic);
  const inLib = loadLibrary().some((x) => x.id === p.id);
  npText("plf-save-label", inLib ? "Saved" : "Save");
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
  const lib = uniqById(loadLibrary());
  box.innerHTML = lib.length
    ? lib
        .map((p) => plCard(p, p.local ? "Local" : "Saved", p.local ? "Local" : "In Library"))
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet — hit “Save to Library” on Home.</p>';
}
function renderPlays() {
  const plays = uniqById(loadPlays());
  const count = $("#history-count");
  if (count) count.textContent = `${plays.length} session${plays.length === 1 ? "" : "s"}`;
  trackRows(plays, $("#history-plays"), "Nothing played yet.");
  trackRows(plays.slice(0, 5), $("#library-recent"), "No plays yet.");
}

// Click wiring — one delegated listener per grid.
function wirePlGrid(sel) {
  $(sel)?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-pl-id]");
    if (!card) return;
    // Liked Songs / Current Queue only exist in memory, so they come from the
    // last render instead of the id pools.
    const syn = card.dataset.plSynthetic;
    if (syn) {
      const hit = plItems.find((x) => x.p.synthetic === syn);
      if (hit) openPlaylist(hit.p);
      return;
    }
    openPlaylist(plItemById(card.dataset.plId));
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
// The search grid holds whichever card type the active chip selected.
wireDdGrid("#results");
wirePlGrid("#results");

// ------------------------------------------------------- playlists screen -
$("#pd-play")?.addEventListener("click", () => pdTracks.length && playTracksAt(pdTracks, 0));
$("#pd-shuffle")?.addEventListener("click", () => {
  if (!pdTracks.length) return;
  pdTracks = shuffled(pdTracks);
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPdRows();
  shuffleMode = true;
  paintModes();
  playTracksAt(pdTracks, 0);
});
$("#pd-back")?.addEventListener("click", () => $("#playlist-detail")?.classList.add("hidden"));
$("#pd-more")?.addEventListener("click", () => {
  pdVisible = pdTracks.length;
  paintPdRows();
});
$("#pd-delete")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const name = plFeatured?.p.title;
  if (!pdCurrentId || !name) return;
  // Two clicks instead of a native confirm() — webviews do not all have one.
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.title = "Click again to delete";
    btn.classList.add("text-error", "bg-error-container");
    setTimeout(() => {
      btn.dataset.armed = "";
      btn.title = "Delete this local playlist";
      btn.classList.remove("text-error", "bg-error-container");
    }, 3000);
    return;
  }
  removeLocalPl(pdCurrentId);
  $("#playlist-detail")?.classList.add("hidden");
  pdCurrentId = "";
  plFeatured = null;
  paintFeatured();
  renderPlaylists();
  toast(`Deleted ${name}`, "success", 2600);
});
$("#pl-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pl-filter]");
  if (!btn) return;
  plFilter = btn.dataset.plFilter;
  renderPlaylists();
});
$("#pl-search")?.addEventListener("input", (e) => {
  plQuery = e.target.value;
  renderPlaylists();
});
$("#pl-viewall")?.addEventListener("click", () => {
  plFilter = "all";
  plQuery = "";
  const input = $("#pl-search");
  if (input) input.value = "";
  renderPlaylists();
  $("#playlists-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#pl-refresh")?.addEventListener("click", async () => {
  const icon = $("#pl-refresh")?.firstElementChild;
  icon?.classList.add("animate-spin");
  await loadHome();
  icon?.classList.remove("animate-spin");
  renderPlaylists();
  toast("Playlists refreshed", "success", 2200);
});
$("#pl-back")?.addEventListener("click", () => showView("library"));

/// Hero buttons act on the very playlist the table below shows.
async function featuredLoaded() {
  if (!plFeatured) return false;
  if (pdCurrentId !== plFeatured.p.id || !pdTracks.length) {
    await openPlaylist(plFeatured.p, { scroll: false });
  }
  return pdTracks.length > 0;
}
$("#plf-play")?.addEventListener("click", async () => {
  if (await featuredLoaded()) playTracksAt(pdTracks, 0);
});
$("#plf-shuffle")?.addEventListener("click", async () => {
  if (!(await featuredLoaded())) return;
  pdTracks = shuffled(pdTracks);
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPdRows();
  shuffleMode = true;
  paintModes();
  playTracksAt(pdTracks, 0);
});
$("#plf-save")?.addEventListener("click", () => {
  const p = plFeatured?.p;
  if (!p || p.synthetic) return;
  let lib = [];
  try {
    lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {}
  const at = lib.findIndex((x) => x.id === p.id);
  if (at >= 0) {
    lib.splice(at, 1);
    npText("plf-save-label", "Save");
    toast("Removed from Library", "info", 2200);
  } else {
    lib.push({ id: p.id, title: p.title, subtitle: p.subtitle, image: p.image, count: p.count });
    npText("plf-save-label", "Saved");
    toast("Saved to Library", "success", 2200);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 50)));
  } catch {}
  renderLibrary();
  renderPlaylists();
});
$("#lib-new-pl")?.addEventListener("click", () => {
  // Same modal the + button uses, just opened to create: no native prompt().
  pickTrack = null;
  npText("pl-picker-track", "Name your new playlist");
  renderPickerList();
  $("#pl-picker")?.classList.remove("hidden");
  $("#pl-picker-name")?.focus();
});
// Discography cards sit inside the artist screen: the artist stays on the
// stack so Back returns to it instead of dropping to Home.
$("#dd-release-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-dd-filter]");
  if (!btn) return;
  ddFilter = btn.dataset.ddFilter;
  renderReleases();
});
$("#dd-releases")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-dd-token]");
  if (!card) return;
  const item = {
    token: card.dataset.ddToken,
    title: card.dataset.ddTitle,
    subtitle: card.dataset.ddSub,
    image: card.dataset.ddImg,
  };
  if (!item.token) {
    doSearch({ query: item.title || "" });
    return;
  }
  openDetail(card.dataset.ddKind || "album", item, { push: true });
});

$("#dd-play")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  playTracksAt(ddTracks, 0);
});
$("#dd-shuffle")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  ddTracks = shuffled(ddTracks);
  ddVisible = ddTracks.length;
  renderDd();
  shuffleMode = true;
  paintModes();
  playTracksAt(ddTracks, 0);
});
// Rest of the loaded songs first, then the next page of the catalogue.
$("#dd-more")?.addEventListener("click", async () => {
  if (ddVisible < ddTracks.length) {
    ddVisible = ddTracks.length;
    renderDd();
    return;
  }
  if (!ddMore || !ddToken) return;
  const seq = ddSeq;
  const btn = $("#dd-more");
  if (btn) btn.disabled = true;
  npText("dd-more-label", "Loading…");
  try {
    const next = await invoke("artist_tracks", { token: ddToken, page: ddPage + 1 });
    if (seq !== ddSeq) return;
    mergeArtistPage(next);
    paintDdSubtitle();
    renderDd();
    diag("artist", true, `${ddTracks.length} songs loaded`);
  } catch (err) {
    diag("artist page", false, String(err));
    toast(`Could not load more songs: ${String(err).slice(0, 90)}`, "error");
    renderDd();
  }
});
$("#dd-back")?.addEventListener("click", () => {
  const prev = ddStack.pop();
  if (prev) openDetail(prev.kind, prev.item);
  else showView(ddReturnView || "home");
});
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

// Seed the catalog so every control has real data on first paint:
// the box opens on the last query that was searched, not a blank slot.
const seedInput = $("#search-input");
if (seedInput && !seedInput.value.trim()) {
  seedInput.value = [...new Set(loadHistory())][0] || "trance";
}
// The bar (and Now Playing) open on the last track that actually played.
const lastPlayed = loadPlays()[0];
if (lastPlayed) {
  bar.title.textContent = lastPlayed.title;
  bar.artist.textContent = [lastPlayed.artist, lastPlayed.album].filter(Boolean).join(" · ");
  if (lastPlayed.image) {
    paintArt(bar.cover, lastPlayed.image);
    bar.coverFallback?.classList.add("hidden");
    paintArt(np.cover, lastPlayed.image);
  }
  if (np.title) np.title.textContent = lastPlayed.title;
  if (np.artist) np.artist.textContent = [lastPlayed.artist, lastPlayed.album].filter(Boolean).join(" · ");
  npText("np-album", lastPlayed.album || "—");
  npText("np-artist-tile", lastPlayed.artist || "—");
  npText("np-length", lastPlayed.duration || "—");
  diag("restore", true, `last played: ${lastPlayed.title}`);
}
renderFavs();
doSearch({ silent: true });
loadHome();
