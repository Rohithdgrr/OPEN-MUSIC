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

let toastEl;
export function toast(msg, ms = 3200) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "fixed top-16 inset-x-0 z-[60] flex justify-center px-4 pointer-events-none";
    toastEl.innerHTML = '<div class="bg-primary text-on-primary px-3 py-1.5 rounded shadow-lg font-label-sm text-label-sm max-w-[92%] truncate"></div>';
    document.body.appendChild(toastEl);
  }
  const box = toastEl.firstElementChild;
  box.textContent = String(msg);
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => {
    box.textContent = "";
  }, ms);
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
        <span class="text-body-sm text-secondary truncate">${esc(t.artist || t.subtitle || "")}</span>
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

export async function downloadTrack(track) {
  if (!invoke || !track || !track.id) {
    toast("Backend unavailable");
    return;
  }
  const quality = (() => {
    try {
      return localStorage.getItem(DL_QUALITY_KEY) || "96kbps";
    } catch {
      return "96kbps";
    }
  })();
  toast(`Downloading ${track.title || "track"}…`);
  try {
    const progress = new Channel();
    progress.onmessage = (p) => {
      if (p && p.done) toast(`${p.title || "Track"} saved to vault`);
    };
    const out = await invoke("download_song", { id: track.id, quality, onProgress: progress });
    if (out && out.duplicate_of) toast("Already in vault");
  } catch (e) {
    console.error(e);
    toast(String(e).slice(0, 100));
  }
}
