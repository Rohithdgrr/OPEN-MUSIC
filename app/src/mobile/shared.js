// shared.js — invoke, Channel, storage, artwork, row/card templates for the mobile shell.
import { esc } from "../html.js";

export const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;

export class Channel {
  #onmessage = () => {};
  #nextIndex = 0;
  #pending = [];
  #endIndex = undefined;
  constructor(onmessage) {
    if (onmessage) this.#onmessage = onmessage;
    this.__TAURI_CHANNEL_MARKER__ = true;
    this.id = window.__TAURI_INTERNALS__.transformCallback((raw) => {
      const index = raw.index;
      if ("end" in raw) {
        if (index == this.#nextIndex) this.cleanup();
        else this.#endIndex = index;
        return;
      }
      if (index == this.#nextIndex) {
        this.#onmessage(raw.message);
        this.#nextIndex = index + 1;
        while (this.#nextIndex in this.#pending) {
          this.#onmessage(this.#pending[this.#nextIndex]);
          delete this.#pending[this.#nextIndex];
          this.#nextIndex += 1;
        }
        if (this.#nextIndex === this.#endIndex) this.cleanup();
      } else {
        this.#pending[index] = raw.message;
      }
    });
  }
  cleanup() {
    window.__TAURI_INTERNALS__.unregisterCallback?.(this.id);
  }
  set onmessage(handler) {
    this.#onmessage = handler;
  }
  get onmessage() {
    return this.#onmessage;
  }
  ["__TAURI_TO_IPC_KEY__"]() {
    return `__CHANNEL__:${this.id}`;
  }
  toJSON() {
    return this["__TAURI_TO_IPC_KEY__"]();
  }
}

export const FAVS_KEY = "tm-favorites";
export const PLAYS_KEY = "tm-plays";
export const HISTORY_KEY = "tm-history";
export const LIBRARY_KEY = "tm-library";
export const DL_QUALITY_KEY = "tm-dl-quality";
export const LANG_KEY = "tm-lang";
export const COUNTRY_KEY = "tm-country";

export function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const store = {};
export const hooks = {};

export function setList(name, list) {
  store[name] = list || [];
  return store[name];
}

export function go(path) {
  location.hash = "#/" + path;
}

export function fmtTime(s) {
  if (!Number.isFinite(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function fmtDur(secs) {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Human label for the player's honesty badge (see player.js). `fallback` is
// the design's idle text so the static markup is only replaced once the
// player actually has something to say.
export function badgeLabel(badge, fallback = "") {
  switch (String(badge || "").toUpperCase()) {
    case "LOSSLESS":
      return "LOSSLESS 24-BIT";
    case "RESOLVING":
      return "RESOLVING…";
    case "RETRYING":
      return "RETRYING…";
    case "ERROR":
      return "STREAM ERROR";
    case "IDLE":
    case "":
      return fallback;
    default:
      return String(badge).toUpperCase();
  }
}

// One stacked node per message (max 4), a colored dot per kind, tap to
// dismiss. `ms` stays the second argument so every existing caller holds.
let toastStack = null;
export function toast(msg, ms = 3200, kind = "info") {
  if (!toastStack) {
    toastStack = document.createElement("div");
    toastStack.id = "tm-toast-stack";
    toastStack.setAttribute("role", "status");
    toastStack.setAttribute("aria-live", "polite");
    document.body.appendChild(toastStack);
  }
  const el = document.createElement("div");
  el.className = "tm-toast";
  el.dataset.kind = kind === "error" || kind === "success" ? kind : "info";
  const dot = document.createElement("span");
  dot.className = "tm-dot";
  const text = document.createElement("span");
  text.textContent = String(msg);
  el.append(dot, text);
  toastStack.appendChild(el);
  while (toastStack.children.length > 4) toastStack.firstElementChild.remove();
  const timer = setTimeout(dismiss, ms);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add("tm-out");
    setTimeout(() => el.remove(), 250);
  }
  el.addEventListener("click", dismiss);
}

export function isFav(id) {
  return load(FAVS_KEY, []).some((t) => t.id === id);
}

export function toggleFav(track) {
  const list = load(FAVS_KEY, []);
  const i = list.findIndex((t) => t.id === track.id);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ ...track });
  save(FAVS_KEY, list);
  paintFavs();
  return i < 0;
}

export function paintFavs() {
  document.querySelectorAll("[data-fav-icon]").forEach((el) => {
    const on = isFav(el.dataset.favIcon);
    el.textContent = on ? "favorite" : "favorite_border";
    el.style.fontVariationSettings = `'FILL' ${on ? 1 : 0}`;
    el.classList.toggle("text-error", on);
  });
}

export function pushPlay(track) {
  try {
    const prev = load(PLAYS_KEY, []);
    const at = prev.find((t) => t.id === track.id);
    save(
      PLAYS_KEY,
      [{ ...track, ts: Date.now(), count: (Number(at?.count) || 0) + 1 }, ...prev.filter((t) => t.id !== track.id)].slice(0, 100),
    );
  } catch {}
}

export function pushHistory(q) {
  if (!q) return;
  save(HISTORY_KEY, [q, ...load(HISTORY_KEY, []).filter((x) => x !== q)].slice(0, 20));
}

const ART_RENDS = [
  ["-50x50x100", "-500x500"],
  ["-150x150x100", "-500x500"],
  ["-50x50", "-500x500"],
  ["-150x150", "-500x500"],
  ["50x50", "500x500"],
  ["150x150", "500x500"],
];

function proxied(url) {
  const base = window.__tmBase;
  if (!base || !url) return url;
  return `${base}/art?u=${encodeURIComponent(url)}`;
}

export function hqArt(url, target = "500x500") {
  if (typeof url !== "string" || !url) return "";
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  let out = url;
  if (host === "saavncdn.com" || host.endsWith(".saavncdn.com")) {
    for (const [small, big] of ART_RENDS) out = out.split(small).join(big);
    if (target !== "500x500") out = out.split("500x500").join(target);
    out = out.startsWith("http://") ? "https://" + out.slice(7) : out;
  }
  return proxied(out);
}

export function art(url) {
  const raw = typeof url === "string" ? url : "";
  return `src="${esc(hqArt(raw))}" data-art-orig="${esc(raw)}" loading="lazy"`;
}

export function paintArt(img, url) {
  if (!img || !url) return;
  img.setAttribute("data-art-orig", url);
  img.src = hqArt(url);
}

function artSteps(raw) {
  let orig = raw || "";
  const base = window.__tmBase;
  if (base && orig.startsWith(`${base}/art?u=`)) {
    try {
      orig = new URL(orig).searchParams.get("u") || orig;
    } catch {}
  }
  if (!orig) return [];
  const list = [];
  for (const step of [null, "150x150", "50x50"]) {
    const u = step ? hqArt(orig, step) : proxied(orig);
    if (u && !list.includes(u)) list.push(u);
  }
  return list;
}

window.artFail = function (img) {
  const steps = artSteps(img.getAttribute("data-art-orig") || "");
  let idx = Number(img.getAttribute("data-art-step") || "0");
  while (idx < steps.length) {
    const next = steps[idx++];
    img.setAttribute("data-art-step", String(idx));
    if (img.getAttribute("src") !== next) {
      img.setAttribute("src", next);
      return false;
    }
  }
  img.removeAttribute("src");
  img.classList.add("hidden");
  return true;
};

document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG" && img.hasAttribute("data-art-orig")) window.artFail(img);
  },
  true,
);

export function rowHTML(name, i, t) {
  return `<div data-list="${name}" data-idx="${i}" class="group flex items-center justify-between p-space-sm rounded-lg hover:bg-surface-container transition-colors cursor-pointer active:bg-surface-container-high">
    <div class="flex items-center gap-space-md min-w-0 flex-1">
      <div class="relative w-10 h-10 rounded bg-surface-container-highest overflow-hidden flex-shrink-0"><img alt="" class="w-full h-full object-cover" ${art(t.image)}></div>
      <div class="flex flex-col min-w-0">
        <span class="text-body-md font-medium text-on-surface truncate">${esc(t.title || "")}</span>
        <span class="text-body-sm text-secondary truncate" data-entity-name data-entity-kind="artist">${esc(t.artist || t.subtitle || "")}</span>
      </div>
    </div>
    <div class="flex items-center gap-space-sm flex-shrink-0">
      <span class="font-label-mono text-label-sm text-secondary">${esc(t.duration || (t.duration_secs ? fmtTime(t.duration_secs) : ""))}</span>
      <button type="button" data-fav aria-label="Favorite" class="w-8 h-8 rounded flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]" data-fav-icon="${esc(t.id || "")}">favorite_border</span></button>
      <button type="button" data-dl aria-label="Download" class="w-8 h-8 rounded flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]">download</span></button>
      <button type="button" data-menu-list="${name}" data-menu-idx="${i}" aria-label="More options" class="w-8 h-8 rounded flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
    </div>
  </div>`;
}

export function plCardHTML(p, i, nav) {
  return `<div data-nav="${esc(nav)}" data-pl-idx="${i}" class="w-52 flex-shrink-0 bg-surface-container-lowest border border-surface-container rounded-lg p-space-sm shadow-sm flex flex-col space-y-2 cursor-pointer active:opacity-80 transition-opacity">
    <div class="relative w-full aspect-square rounded-md overflow-hidden bg-surface-container-highest"><img alt="" class="w-full h-full object-cover" ${art(p.image)}></div>
    <div class="flex flex-col pt-0.5 min-w-0">
      <span class="font-label-md text-label-md text-on-surface font-semibold truncate">${esc(p.title || "")}</span>
      <span class="font-body-sm text-[12px] text-secondary truncate mt-0.5">${esc(p.subtitle || "")}</span>
      <div class="flex items-center gap-1.5 mt-1 text-on-surface-variant">
        <span class="font-label-mono text-[10px]">${p.count ? `${p.count} TRACKS` : p.year || ""}</span>
      </div>
    </div>
  </div>`;
}

export function artistCardHTML(a, i, nav) {
  return `<div data-nav="${esc(nav)}" data-pl-idx="${i}" class="w-60 flex-shrink-0 bg-surface-container-lowest border border-surface-container rounded-xl p-space-md shadow-sm flex flex-col justify-between space-y-3 cursor-pointer active:opacity-80 transition-opacity">
    <div class="flex items-center gap-space-md min-w-0">
      <div class="w-14 h-14 rounded-full overflow-hidden bg-surface-container-highest flex-shrink-0"><img alt="" class="w-full h-full object-cover" ${art(a.image)}></div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-label-md text-label-md font-semibold text-on-surface truncate">${esc(a.title || "")}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(a.subtitle || "")}</span>
        ${a.count ? `<span class="font-label-mono text-[9px] text-on-surface-variant mt-0.5">${a.count} Releases</span>` : ""}
      </div>
    </div>
  </div>`;
}

const activeDownloads = new Set();
let batchRunning = false;

const errLine = (e) => String(e).split("\n")[0].slice(0, 90);

// 128 kbps Opus is the sweet spot the backend itself promotes favourites to
// (lib.rs PREMIUM_KBPS): transparent quality at a third of 320's file size.
export function dlQuality() {
  try {
    return localStorage.getItem(DL_QUALITY_KEY) || "128kbps";
  } catch {
    return "128kbps";
  }
}

/// Raw string storage: `save()` would JSON-quote the value and dlQuality()
/// reads the key directly, so the picker writes it the same way.
export function setDlQuality(value) {
  try {
    localStorage.setItem(DL_QUALITY_KEY, String(value));
  } catch {}
}

export const AUTOUPDATE_KEY = "tm-autoupdate";
const UPDATE_STAMP_KEY = "tm-update-checked";

/// Check for a newer release and install it when the platform allows.
/// `auto` is the boot path: silent, at most once a day, no error toasts.
export async function checkForUpdates(auto = false) {
  if (!invoke) return null;
  if (auto) {
    const last = Number(load(UPDATE_STAMP_KEY, 0)) || 0;
    if (Date.now() - last < 24 * 3600e3) return null;
  }
  try {
    const r = await invoke("update_check");
    save(UPDATE_STAMP_KEY, Date.now());
    const latest = r && r.latest;
    if (!latest) {
      if (!auto) toast("You're on the latest version", 3000, "success");
      return r;
    }
    if (!latest.installable) {
      toast(`Version ${latest.version} is available`, 6000, "info");
      return r;
    }
    try {
      await invoke("update_install");
      toast(`Updated to ${latest.version} — restart the app`, 6000, "success");
    } catch {
      // Android has no in-place install (and no link opener yet): say so
      // rather than pretending the download went through.
      toast(`Version ${latest.version} is ready — install it from the releases page`, 7000, "info");
    }
    return r;
  } catch (e) {
    if (!auto) toast(`Update check failed: ${String(e).split("\n")[0].slice(0, 80)}`, 5000, "error");
    return null;
  }
}

/// Swap a row/header button's glyph to a spinner while its download runs.
function setBusy(btn, on) {
  const span = btn && btn.querySelector(".material-symbols-outlined");
  if (!span) return;
  if (on) {
    if (btn._dlIcon === undefined) btn._dlIcon = span.textContent;
    span.textContent = "progress_activity";
    span.classList.add("animate-spin");
  } else if (btn._dlIcon !== undefined) {
    span.textContent = btn._dlIcon;
    span.classList.remove("animate-spin");
    delete btn._dlIcon;
  }
}

function setLabel(btn, text) {
  const span = btn && btn.querySelector("span.font-label-mono");
  if (!span) return;
  if (btn._dlLabel === undefined) btn._dlLabel = span.textContent;
  span.textContent = text;
}

function clearLabel(btn) {
  const span = btn && btn.querySelector("span.font-label-mono");
  if (span && btn._dlLabel !== undefined) span.textContent = btn._dlLabel;
  if (btn) delete btn._dlLabel;
}

/// Download one track. Returns the backend outcome, or null on failure /
/// skip. `quiet` suppresses the per-track toasts so a batch can summarize.
export async function downloadTrack(track, btn, quiet = false) {
  if (!invoke || !track || !track.id) {
    toast("Backend unavailable", 4000, "error");
    return null;
  }
  if (activeDownloads.has(track.id)) {
    if (!quiet) toast("Already downloading that track");
    return null;
  }
  activeDownloads.add(track.id);
  setBusy(btn, true);
  if (!quiet) toast(`Downloading ${track.title || "track"}…`);
  try {
    const progress = new Channel();
    progress.onmessage = (p) => {
      if (p && p.done && !quiet) toast(`${p.title || "Track"} saved to vault`, 3200, "success");
    };
    const out = await invoke("download_song", { id: track.id, quality: dlQuality(), onProgress: progress });
    if (out && out.duplicate_of && !quiet) toast("Already in vault");
    return out;
  } catch (e) {
    console.error(e);
    toast(`Download failed: ${errLine(e)}`, 5000, "error");
    return null;
  } finally {
    activeDownloads.delete(track.id);
    setBusy(btn, false);
  }
}

/// Download a whole collection (album / playlist / chart / liked songs).
/// Sequential like the desktop's vault.js:downloadAll — one batch at a time,
/// skips what is already in the vault, survives individual failures.
export async function downloadAll(items, what = "tracks", btn = null) {
  const list = (Array.isArray(items) ? items : []).filter((t) => t && t.id);
  if (!list.length) return toast("Nothing to download here");
  if (batchRunning) return toast("A batch download is already running");
  if (!invoke) return toast("Backend unavailable", 4000, "error");
  batchRunning = true;
  setBusy(btn, true);
  let ok = 0;
  let fail = 0;
  let skip;
  try {
    let saved = new Set();
    try {
      const vault = await invoke("list_downloads");
      saved = new Set(((vault && vault.entries) || []).map((e) => e.id));
    } catch {}
    const todo = list.filter((t) => !saved.has(t.id) && !activeDownloads.has(t.id));
    skip = list.length - todo.length;
    for (let i = 0; i < todo.length; i++) {
      setLabel(btn, `${i + 1}/${todo.length}`);
      if (await downloadTrack(todo[i], null, true)) ok += 1;
      else fail += 1;
    }
    if (!todo.length) toast(`All ${list.length} ${what} already saved`, 3200, "success");
    else if (!fail) toast(`Saved ${ok} ${what}${skip ? ` (${skip} already saved)` : ""}`, 4000, "success");
    else if (!ok) toast(`Download failed for all ${fail} ${what}`, 6000, "error");
    else toast(`Saved ${ok} of ${list.length} ${what} — ${fail} failed`, 6000, "error");
  } finally {
    batchRunning = false;
    setBusy(btn, false);
    clearLabel(btn);
    hooks.repaintDownload?.();
  }
}
