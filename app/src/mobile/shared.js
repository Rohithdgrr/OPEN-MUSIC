// shared.js — invoke, Channel, storage, artwork, row/card templates for the mobile shell.
import { esc } from "../html.js";
import { quotaBytesFromGb, pickEvictVictims } from "./quota.js";

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

// ------------------------------------------------------- diagnostics ring -
// Desktop parity: the desktop `#diag` panel keeps the last 40 backend calls in
// a ring buffer. `pushDiag` is the `diag` hook net.js and the mounts call;
// the Settings → Diagnostics sheet renders it.
const DIAG_MAX = 40;
const diagRing = [];
export function pushDiag(name, ok, msg) {
  diagRing.unshift({ name: String(name), ok: ok === true ? true : ok === false ? false : null, msg: String(msg ?? ""), at: Date.now() });
  while (diagRing.length > DIAG_MAX) diagRing.pop();
}
export function readDiag() {
  return diagRing.slice();
}
export function clearDiag() {
  diagRing.length = 0;
}

// One stacked node per message (max 4), a colored dot per kind, tap to
// dismiss. `ms` stays the second argument so every existing caller holds.
// `action` ({ label, fn }) appends a tappable shortcut — "added to X → Open".
let toastStack = null;
export function toast(msg, ms = 3200, kind = "info", action = null) {
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
  if (action && action.label && typeof action.fn === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tm-toast-action";
    btn.textContent = String(action.label);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
      try {
        action.fn();
      } catch {}
    });
    el.appendChild(btn);
  }
  // Only one toast at a time — replace whatever is showing.
  while (toastStack.firstElementChild) toastStack.firstElementChild.remove();
  toastStack.appendChild(el);
  const timer = setTimeout(dismiss, ms);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add("tm-out");
    setTimeout(() => el.remove(), 250);
  }
  el.addEventListener("click", dismiss);
}

/// Web Share API with a clipboard fallback: one path for every Share entry
/// point (menus, detail headers, NowPlaying, analytics).
export async function shareThing({ title, text, url }) {
  const payload = {};
  if (title) payload.title = title;
  if (text) payload.text = text;
  if (url) payload.url = url;
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user dismissed the sheet
    }
  }
  const line = [title, text, url].filter(Boolean).join(" — ");
  try {
    await navigator.clipboard.writeText(line);
    toast("Share text copied");
  } catch {
    toast("Sharing is unavailable here");
  }
}

/// Favourites are re-read on every media event (paintFavs runs 3× per event
/// cycle), so parse the raw blob only when it actually changed.
let favRaw = "__unset__"; // never equals a real getItem() result
let favIds = null;
function favSet() {
  let raw = null;
  try {
    raw = localStorage.getItem(FAVS_KEY);
  } catch {}
  if (raw !== favRaw) {
    favRaw = raw;
    favIds = new Set();
    try {
      (JSON.parse(raw) || []).forEach((t) => t && t.id && favIds.add(t.id));
    } catch {}
  }
  return favIds;
}

export function isFav(id) {
  return favSet().has(id);
}

export function toggleFav(track) {
  const list = load(FAVS_KEY, []);
  const i = list.findIndex((t) => t.id === track.id);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ ...track });
  save(FAVS_KEY, list);
  favRaw = null; // force a re-read on the next paint
  paintFavs();
  // SQLite mirror (best-effort, never blocks the heart animation).
  try {
    import("../store_db.js").then((m) => m.mirrorFav(track, i < 0).catch(() => {}));
  } catch {}
  return i < 0;
}

export function paintFavs() {
  const on = favSet();
  document.querySelectorAll("[data-fav-icon]").forEach((el) => {
    const lit = on.has(el.dataset.favIcon);
    const want = lit ? "favorite" : "favorite_border";
    if (el.textContent !== want) el.textContent = want;
    el.style.fontVariationSettings = `'FILL' ${lit ? 1 : 0}`;
    el.classList.toggle("text-error", lit);
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
  try {
    import("../store_db.js").then((m) => m.recordPlay(track).catch(() => {}));
  } catch {}
  // Smart downloads: every played track becomes a vault file — Wi-Fi only
  // (never on cellular, independent of the Wi-Fi-only gate), quiet, and
  // deduped by downloadTrack's active/vaulted guards. The switch existed in
  // Settings with no consumer before 2026-10-07.
  try {
    if (invoke && smartDlOn() && track && track.id && !isVaulted(track.id) && !onCellular()) {
      void downloadTrack(track, null, true);
    }
  } catch {}
}

export function pushHistory(q) {
  if (!q) return;
  save(HISTORY_KEY, [q, ...load(HISTORY_KEY, []).filter((x) => x !== q)].slice(0, 20));
}

// ------------------------------------------------------------- offline vault
// Mirror of desktop's vault.js isDownloaded: which ids sit on disk, so the
// offline gate can skip the ones that would never resolve without a network.
// Cached in localStorage so boot-offline knows the answer instantly, then
// re-read from the local SQLite ledger in the background.
export const VAULT_IDS_KEY = "tm-vault-ids";
let vaultIds = null;

export function isVaulted(id) {
  if (!id) return false;
  if (!vaultIds) vaultIds = new Set(load(VAULT_IDS_KEY, []));
  return vaultIds.has(String(id));
}

export async function refreshVault() {
  if (!invoke) return;
  try {
    const r = await invoke("list_downloads");
    const entries = (r && r.entries) || [];
    vaultIds = new Set(entries.map((e) => e && e.id).filter(Boolean).map(String));
    save(VAULT_IDS_KEY, [...vaultIds]);
  } catch {} // offline boot: keep the cached set
}

// ------------------------------------------------------------- vault quota
// Port of desktop vault.js:410-467: over quota → evict least-recently-played
// (oldest added as tie-break), never the track playing or a download in
// flight. The ordering math lives in the pure ./quota.js so it is unit-tested.
const QUOTA_KEY = "tm-vault-quota";

export function vaultQuotaGb() {
  try {
    return localStorage.getItem(QUOTA_KEY) || "";
  } catch {
    return "";
  }
}

/// Raw string storage, same reason as setDlQuality: "" = unlimited.
export function setVaultQuotaGb(gb) {
  try {
    if (gb === "" || gb == null) localStorage.removeItem(QUOTA_KEY);
    else localStorage.setItem(QUOTA_KEY, String(gb));
  } catch {}
}

let enforcing = false;
export async function enforceVaultQuota(currentId) {
  const cap = quotaBytesFromGb(vaultQuotaGb());
  if (!cap || enforcing || !invoke) return;
  enforcing = true;
  try {
    const r = await invoke("list_downloads");
    const entries = (r && r.entries) || [];
    if (!entries.length) return;
    const played = new Map();
    try {
      for (const t of JSON.parse(localStorage.getItem(PLAYS_KEY) || "[]")) {
        if (t && t.id && !played.has(String(t.id))) played.set(String(t.id), Number(t.ts) || 0);
      }
    } catch {}
    const victims = pickEvictVictims(
      entries,
      played,
      cap,
      currentId != null ? String(currentId) : null,
      [...activeDownloads.keys()],
    );
    if (!victims.length) return;
    let evicted = 0;
    for (const e of victims) {
      try {
        await invoke("remove_download", { path: e.path });
        evicted += 1;
      } catch {}
    }
    if (evicted) {
      toast(
        `Vault over quota: evicted ${evicted} least-recently played track${evicted === 1 ? "" : "s"}.`,
        "info",
        4500,
      );
      await refreshVault();
      try {
        hooks.repaintDownload?.();
      } catch {}
    }
  } catch {} finally {
    enforcing = false;
  }
}

// --------------------------------------------------------- byte prefetch -
// Save the NEXT queued track to disk while the current one plays (spec:
// feature-list §10 P0-2). Always off on cellular and under Data Saver —
// prefetch is a convenience, never a reason to burn metered bytes.
const PREFETCH_KEY = "tm-prefetch";

export function prefetchOn() {
  try {
    return localStorage.getItem(PREFETCH_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPrefetchOn(on) {
  try {
    localStorage.setItem(PREFETCH_KEY, on ? "1" : "0");
  } catch {}
}

export async function prefetchTrackBytes(track) {
  if (!invoke || !track || !track.id) return;
  if (!prefetchOn() || dataSaver() || onCellular()) return;
  if (isVaulted(track.id) || activeDownloads.has(String(track.id))) return;
  await downloadTrack(track, null, true);
}

const ART_RENDS = [
  ["-50x50x100", "-500x500"],
  ["-150x150x100", "-500x500"],
  ["-50x50", "-500x500"],
  ["-150x150", "-500x500"],
  ["50x50", "500x500"],
  ["150x150", "500x500"],
];

// `__tmBase` carries the relay session token in its own query string
// (`http://127.0.0.1:PORT?token=…`). A relay path must be spliced in FRONT
// of that query — `…PORT/art?u=…&token=…` — because appending after the base
// would bury `/art` inside the query string (the request path becomes `/`)
// and the relay 404s every cover. Exported for the vault file fallback,
// which builds its URL the same way.
export function relayUrl(base, pathQuery) {
  const qi = base.indexOf("?");
  if (qi < 0) return `${base}${pathQuery}`;
  const origin = base.slice(0, qi);
  const tokenQ = base.slice(qi + 1);
  return pathQuery.includes("?")
    ? `${origin}${pathQuery}&${tokenQ}`
    : `${origin}${pathQuery}?${tokenQ}`;
}

function proxied(url) {
  const base = window.__tmBase;
  if (!base || !url) return url;
  return relayUrl(base, `/art?u=${encodeURIComponent(url)}`);
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

/// Android's default artwork: the REON mark shipped with the mobile shell
/// (desktop keeps its own src/logo.png — this path is mobile-only).
export const LOGO = "logo.png";

export function art(url) {
  const raw = typeof url === "string" ? url : "";
  // No art → the brand mark, never an empty src (that makes the browser
  // request the page URL as an image and blank the tile).
  if (!raw) return `src="${LOGO}"`;
  return `src="${esc(hqArt(raw))}" data-art-orig="${esc(raw)}" loading="lazy"`;
}

export function paintArt(img, url) {
  if (!img) return;
  const raw = typeof url === "string" ? url : "";
  if (!raw) {
    if (img.getAttribute("src") !== LOGO) {
      img.removeAttribute("data-art-orig");
      img.removeAttribute("data-art-step");
      img.setAttribute("src", LOGO);
      img.classList.remove("hidden");
    }
    return;
  }
  const next = hqArt(raw);
  // Media events fire ~10×/s; rewriting src forces a decode of the same file.
  if (img.getAttribute("src") === next && img.getAttribute("data-art-orig") === raw) return;
  img.setAttribute("data-art-orig", raw);
  img.removeAttribute("data-art-step");
  img.classList.remove("hidden");
  img.src = next;
}

function artSteps(raw) {
  let orig = raw || "";
  const base = window.__tmBase;
  // The proxied form is `<origin>/art?u=…&token=…` — match on the origin
  // only, so the token (which rides in the base's query) stays opaque here.
  if (base && orig.startsWith(`${base.split("?")[0]}/art?u=`)) {
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
  // Ladder exhausted → brand mark. Guard against re-setting a src that has
  // already failed (the error event would otherwise loop forever).
  const src = img.getAttribute("src");
  if (src !== LOGO && !(src || "").endsWith("/logo.png")) {
    img.setAttribute("src", LOGO);
  }
  img.classList.remove("hidden");
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

/// `titleHtml` lets the search screen pass an already-escaped, match-highlighted
/// title (searchkit.highlight) without rebuilding the row template; every other
/// caller keeps the plain escaped title.
export function rowHTML(name, i, t, titleHtml) {
  return `<div data-list="${name}" data-idx="${i}" class="group flex items-center justify-between p-2.5 rounded-xl hover:bg-surface-container/60 transition-all cursor-pointer active:scale-[0.99] active:bg-surface-container-high/80 border border-transparent hover:border-surface-container-high/40">
    <div class="flex items-center gap-3 min-w-0 flex-1">
      <div class="relative w-11 h-11 rounded-lg bg-surface-container-highest overflow-hidden flex-shrink-0 shadow-sm ring-1 ring-black/5"><img alt="" class="w-full h-full object-cover" ${art(t.image)}>${(() => {
        try {
          return isVaulted(t.id) ? '<span class="absolute bottom-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 ring-2 ring-surface-container-lowest" title="Downloaded"></span>' : "";
        } catch {
          return "";
        }
      })()}</div>
      <div class="flex flex-col min-w-0">
        <span class="text-body-md font-medium text-on-surface truncate tracking-tight text-[13.5px]">${titleHtml || esc(t.title || "")}</span>
        <span class="text-body-sm text-secondary truncate text-[11.5px] mt-0.5" data-entity-name data-entity-kind="artist">${esc(t.artist || t.subtitle || "")}</span>
      </div>
    </div>
    <div class="flex items-center gap-1 flex-shrink-0">
      <span class="font-label-mono text-label-sm text-secondary text-[11px] mr-1">${esc(t.duration || (t.duration_secs ? fmtTime(t.duration_secs) : ""))}</span>
      <button type="button" data-fav aria-label="Favorite" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[18px]" data-fav-icon="${esc(t.id || "")}">favorite_border</span></button>
      <button type="button" data-dl aria-label="Download" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[18px]">download</span></button>
      <button type="button" data-menu-list="${name}" data-menu-idx="${i}" aria-label="More options" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
    </div>
  </div>`;
}

export function plCardHTML(p, i, nav) {
  return `<div data-nav="${esc(nav)}" data-pl-idx="${i}" class="w-48 flex-shrink-0 bg-surface-container-lowest border border-surface-container-high/70 rounded-2xl p-2.5 shadow-sm hover:shadow-md flex flex-col space-y-2 cursor-pointer active:scale-[0.98] transition-all group">
    <div class="relative w-full aspect-square rounded-xl overflow-hidden bg-surface-container-highest shadow-sm ring-1 ring-black/5"><img alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(p.image)}></div>
    <div class="flex flex-col pt-0.5 min-w-0">
      <span class="font-label-md text-label-md text-on-surface font-semibold truncate tracking-tight text-[13px]">${esc(p.title || "")}</span>
      <span class="font-body-sm text-[11.5px] text-secondary truncate mt-0.5">${esc(p.subtitle || "")}</span>
      <div class="flex items-center gap-1.5 mt-1 text-on-surface-variant">
        <span class="px-1.5 py-0.5 rounded bg-surface-container-low font-label-mono text-[9.5px] font-medium text-secondary uppercase tracking-wider">${p.count ? `${p.count} TRACKS` : p.year || ""}</span>${p.langCount > 1 ? `<span class="px-1.5 py-0.5 rounded bg-black/70 font-label-mono text-[9.5px] font-medium text-white uppercase tracking-wider">${p.langCount} languages</span>` : ""}${(() => {
        try {
          return p && p.id && typeof playlistOffline === "function" && playlistOffline(p.id)
            ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 font-label-mono text-[9.5px] font-medium text-emerald-600 uppercase tracking-wider">Offline</span>'
            : "";
        } catch {
          return "";
        }
      })()}
      </div>
    </div>
  </div>`;
}

export function artistCardHTML(a, i, nav) {
  return `<div data-nav="${esc(nav)}" data-pl-idx="${i}" class="w-56 flex-shrink-0 bg-surface-container-lowest border border-surface-container-high/70 rounded-2xl p-3 shadow-sm hover:shadow-md flex flex-col justify-between space-y-2.5 cursor-pointer active:scale-[0.98] transition-all group">
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-14 h-14 rounded-full overflow-hidden bg-surface-container-highest ring-2 ring-surface-container-high flex-shrink-0 shadow-sm"><img alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(a.image)}></div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-label-md text-label-md font-semibold text-on-surface truncate tracking-tight text-[13px]">${esc(a.title || "")}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(a.subtitle || "")}</span>
        ${a.count ? `<span class="font-label-mono text-[9px] text-on-surface-variant mt-0.5">${a.count} Releases</span>` : ""}
      </div>
    </div>
  </div>`;
}

const activeDownloads = new Map();
let batchRunning = false;
let batchPaused = false;

const errLine = (e) => String(e).split("\n")[0].slice(0, 90);

export const WIFI_ONLY_KEY = "tm-wifi-only";

export function wifiOnly() {
  try {
    return localStorage.getItem(WIFI_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWifiOnly(on) {
  try {
    localStorage.setItem(WIFI_ONLY_KEY, on ? "1" : "0");
  } catch {}
}

function onCellular() {
  try {
    const c = navigator.connection;
    if (!c) return false;
    if (c.saveData) return true;
    const t = String(c.type || "").toLowerCase();
    const et = String(c.effectiveType || "").toLowerCase();
    if (t === "cellular") return true;
    // effectiveType alone can't prove cellular, but saveData + slow 2g/3g
    // on a phone is a strong enough signal to warn, not block — so only
    // block on explicit cellular type or metered saveData.
    void et;
    return false;
  } catch {
    return false;
  }
}

export function wifiBlocked() {
  return wifiOnly() && onCellular();
}

export function isActiveDownload(id) {
  return activeDownloads.has(String(id));
}

export function getActiveDownloads() {
  return [...activeDownloads.values()];
}

export function batchPausedNow() {
  return batchPaused;
}

export function setBatchPaused(on) {
  batchPaused = !!on;
}

/// Best-effort cancel: the Rust `download_song` has no abort channel, so the
/// bytes keep flowing in the background — but the UI drops the row now and
/// deletes the finished file if it lands after the cancel.
export async function cancelDownload(id) {
  const key = String(id);
  const cur = activeDownloads.get(key);
  if (!cur) return false;
  cur.cancelled = true;
  cur.cancelPath = cur.cancelPath || "";
  activeDownloads.delete(key);
  try {
    hooks.repaintDownload?.();
  } catch {}
  toast(`Cancelled ${cur.title || "download"}`, 2500);
  // If the backend finishes after the cancel, remove the file it just wrote.
  cur._cancelCleanup = true;
  return true;
}

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

export const EVENTS_KEY = "tm-events";

/// Append a real event for the Notifications screen (downloads, updates,
/// restores). Newest first, capped, and an identical unread message inside a
/// minute is dropped — the auto update check would otherwise flood the feed.
export function pushEvent(kind, title, body) {
  if (!title) return;
  try {
    const list = load(EVENTS_KEY, []);
    const top = list[0];
    if (top && top.title === title && Date.now() - (Number(top.ts) || 0) < 60e3) return;
    const ev = { id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: kind || "system", title: String(title), body: body ? String(body) : "", ts: Date.now(), read: false };
    save(EVENTS_KEY, [ev, ...list].slice(0, 40));
  } catch {}
}

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
      pushEvent("update", `Update ${latest.version} available`, "A newer build of the app can be installed from the releases page.");
      return r;
    }
    try {
      await invoke("update_install");
      toast(`Updated to ${latest.version} — restart the app`, 6000, "success");
      pushEvent("update", `Updated to ${latest.version}`, "Restart the app to finish switching versions.");
    } catch {
      // Android has no in-place install (and no link opener yet): say so
      // rather than pretending the download went through.
      toast(`Version ${latest.version} is ready — install it from the releases page`, 7000, "info");
      pushEvent("update", `Version ${latest.version} is ready`, "Install the new build from the releases page.");
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
  if (wifiBlocked()) {
    if (!quiet) toast("Wi-Fi only is on — connect to Wi-Fi to download", 4000, "error");
    return null;
  }
  const key = String(track.id);
  if (activeDownloads.has(key)) {
    if (!quiet) toast("Already downloading that track");
    return null;
  }
  const entry = {
    id: key,
    title: track.title || "Track",
    artist: track.artist || "",
    album: track.album || "",
    image: track.image || "",
    quality: dlQuality(),
    received: 0,
    total: null,
    done: false,
    cancelled: false,
  };
  activeDownloads.set(key, entry);
  try {
    hooks.repaintDownload?.();
  } catch {}
  setBusy(btn, true);
  if (!quiet) toast(`Downloading ${track.title || "track"}…`);
  try {
    const progress = new Channel();
    progress.onmessage = (p) => {
      if (!p) return;
      const cur = activeDownloads.get(key);
      if (cur) {
        cur.received = Number(p.received) || cur.received;
        cur.total = p.total != null ? p.total : cur.total;
        if (p.quality) cur.quality = p.quality;
        try {
          hooks.repaintDownload?.();
        } catch {}
      }
      if (p && p.done && !quiet && !cur?.cancelled) toast(`${p.title || "Track"} saved to vault`, 3200, "success");
    };
    const out = await invoke("download_song", { id: track.id, quality: dlQuality(), onProgress: progress });
    // Cancelled while the backend kept writing: remove what just landed.
    if (entry.cancelled || !activeDownloads.has(key)) {
      try {
        const path = out && out.path ? out.path : "";
        if (path && invoke) await invoke("remove_download", { path });
      } catch {}
      try {
        hooks.repaintDownload?.();
      } catch {}
      return null;
    }
    if (out && out.duplicate_of && !quiet) toast("Already in vault");
    refreshVault(); // the offline gate must see the new file immediately
    enforceVaultQuota(track.id).catch(() => {});
    return out;
  } catch (e) {
    console.error(e);
    if (!entry.cancelled) toast(`Download failed: ${errLine(e)}`, 5000, "error");
    return null;
  } finally {
    activeDownloads.delete(key);
    setBusy(btn, false);
    try {
      hooks.repaintDownload?.();
    } catch {}
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
  if (wifiBlocked()) return toast("Wi-Fi only is on — connect to Wi-Fi to download", 4000, "error");
  batchRunning = true;
  batchPaused = false;
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
    const todo = list.filter((t) => !saved.has(String(t.id)) && !activeDownloads.has(String(t.id)));
    skip = list.length - todo.length;
    for (let i = 0; i < todo.length; i++) {
      if (batchPaused) {
        toast(`Paused — saved ${ok} of ${todo.length} ${what}`, 4000, "info");
        break;
      }
      setLabel(btn, `${i + 1}/${todo.length}`);
      if (await downloadTrack(todo[i], null, true)) ok += 1;
      else fail += 1;
    }
    if (batchPaused) {
      // Pause toast already shown above; don't claim success/failure.
    } else if (!todo.length) toast(`All ${list.length} ${what} already saved`, 3200, "success");
    else if (!fail) toast(`Saved ${ok} ${what}${skip ? ` (${skip} already saved)` : ""}`, 4000, "success");
    else if (!ok) toast(`Download failed for all ${fail} ${what}`, 6000, "error");
    else toast(`Saved ${ok} of ${list.length} ${what} — ${fail} failed`, 6000, "error");
    if (ok) pushEvent("downloads", `Saved ${ok} ${what}`, skip ? `${skip} were already in the vault.` : `Downloaded at ${dlQuality()} kbps to the offline vault.`);
  } finally {
    batchRunning = false;
    batchPaused = false;
    setBusy(btn, false);
    clearLabel(btn);
    hooks.repaintDownload?.();
  }
}

// ---------------------------------------------------------- artist follows -
// JSON list like FAVS_KEY; toggle returns the new state (callers toast).
export const FOLLOWS_KEY = "tm-follows";

export function loadFollows() {
  const list = load(FOLLOWS_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveFollows(list) {
  save(FOLLOWS_KEY, Array.isArray(list) ? list : []);
}

export function isFollowing(id) {
  if (!id) return false;
  return loadFollows().some((a) => a && String(a.id) === String(id));
}

export function toggleFollow(entry) {
  if (!entry || !entry.id) return false;
  const list = loadFollows();
  const i = list.findIndex((a) => a && String(a.id) === String(entry.id));
  if (i >= 0) {
    list.splice(i, 1);
    saveFollows(list);
    return false;
  }
  list.unshift({ id: entry.id, title: entry.title || "", image: entry.image || "" });
  saveFollows(list.slice(0, 200));
  return true;
}

// -------------------------------------------------------- stream quality -
// Raw strings for the wifi/cell prefs; data-saver/explicit/normalize/smart
// are raw "1"/"0" flags like WIFI_ONLY_KEY.
export const STREAM_WIFI_KEY = "tm-stream-wifi";
export const STREAM_CELL_KEY = "tm-stream-cell";
export const DATASAVER_KEY = "tm-data-saver";

export function dataSaver() {
  try {
    return localStorage.getItem(DATASAVER_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDataSaver(on) {
  try {
    localStorage.setItem(DATASAVER_KEY, on ? "1" : "0");
  } catch {}
}

export function effStreamWifi() {
  try {
    return localStorage.getItem(STREAM_WIFI_KEY) || "";
  } catch {
    return "";
  }
}

export function setEffStreamWifi(v) {
  try {
    localStorage.setItem(STREAM_WIFI_KEY, String(v));
  } catch {}
}

export function effStreamCell() {
  try {
    return localStorage.getItem(STREAM_CELL_KEY) || "";
  } catch {
    return "";
  }
}

export function setEffStreamCell(v) {
  try {
    localStorage.setItem(STREAM_CELL_KEY, String(v));
  } catch {}
}

// Data saver wins; otherwise cellular (type or saveData) uses the cell pref,
// wifi falls back through the legacy tm-stream-quality key.
export function effectiveStreamQuality() {
  try {
    if (dataSaver()) return "64kbps";
    let cellular = false;
    try {
      const c = navigator.connection;
      if (c) cellular = !!c.saveData || String(c.type || "").toLowerCase() === "cellular";
    } catch {}
    if (cellular) {
      // 2026-10-07: Auto on cellular was 96kbps — audibly worse than every
      // other default. Auto now means "full quality"; economy is an explicit
      // pick below or Data Saver (which still wins above).
      try {
        return localStorage.getItem(STREAM_CELL_KEY) || "320kbps";
      } catch {
        return "320kbps";
      }
    }
    try {
      return localStorage.getItem(STREAM_WIFI_KEY) || localStorage.getItem("tm-stream-quality") || "320kbps";
    } catch {
      return "320kbps";
    }
  } catch {
    return "320kbps";
  }
}

// -------------------------------------------------------------- explicit -
// Raw "1"/"0" flag, default "0" (show everything).
export const EXPLICIT_KEY = "tm-explicit-hide";

export function explicitHidden() {
  try {
    return localStorage.getItem(EXPLICIT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setExplicitHidden(on) {
  try {
    localStorage.setItem(EXPLICIT_KEY, on ? "1" : "0");
  } catch {}
}

export function isExplicitTrack(t) {
  if (!t) return false;
  if (t.explicit === true) return true;
  return /explicit/i.test(String(t.label || ""));
}

// ----------------------------------------------------- eq + normalize -
// Store-only prefs; the audio graph itself lives in player.js.
export const EQ_KEY = "tm-eq-preset";
const EQ_PRESETS = ["flat", "bass", "bassboost", "pop", "bright", "vocal"];

export function eqPreset() {
  try {
    const v = localStorage.getItem(EQ_KEY);
    return EQ_PRESETS.includes(v) ? v : "flat";
  } catch {
    return "flat";
  }
}

export function setEqPreset(v) {
  try {
    localStorage.setItem(EQ_KEY, EQ_PRESETS.includes(String(v)) ? String(v) : "flat");
  } catch {}
}

export const NORM_KEY = "tm-normalize";

// ------------------------------------------------------- per-track EQ -
// Optional per-track preset override ({ trackId: preset }); the global
// preset in EQ_KEY stays the fallback. Surfaced in the track menu ("EQ for
// this track") and listed with clear buttons in Settings.
export const TRACK_EQ_KEY = "tm-eq-tracks";

export function trackEqMap() {
  try {
    const m = load(TRACK_EQ_KEY, {});
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export function trackEqFor(id) {
  if (!id) return "";
  try {
    const v = trackEqMap()[String(id)];
    return EQ_PRESETS.includes(v) ? v : "";
  } catch {
    return "";
  }
}

export function setTrackEq(id, preset) {
  if (!id) return false;
  try {
    const m = trackEqMap();
    if (!preset) delete m[String(id)];
    else {
      if (!EQ_PRESETS.includes(preset)) return false;
      m[String(id)] = preset;
    }
    // Bound the map so it can never grow without limit.
    const keys = Object.keys(m);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete m[k];
    save(TRACK_EQ_KEY, m);
    return true;
  } catch {
    return false;
  }
}

export function normalizeOn() {
  try {
    return localStorage.getItem(NORM_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNormalize(on) {
  try {
    localStorage.setItem(NORM_KEY, on ? "1" : "0");
  } catch {}
}

// ------------------------------------------------------- smart downloads -
// Smart-DL flag plus per-playlist offline pins (dynamic tm-pl-offline-* keys
// stay out of the sync allowlist).
export const SMART_KEY = "tm-smart-dl";

export function smartDlOn() {
  try {
    return localStorage.getItem(SMART_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSmartDl(on) {
  try {
    localStorage.setItem(SMART_KEY, on ? "1" : "0");
  } catch {}
}

export function playlistOffline(id) {
  if (id == null || id === "") return false;
  try {
    return localStorage.getItem(`tm-pl-offline-${id}`) === "1";
  } catch {
    return false;
  }
}

export function setPlaylistOffline(id, on) {
  if (id == null || id === "") return;
  try {
    localStorage.setItem(`tm-pl-offline-${id}`, on ? "1" : "0");
  } catch {}
}

// Bytes grouped by quality bucket (hq = 128k+), plus the entry count.
export function storageBreakdown(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let total = 0;
  let hq = 0;
  let std = 0;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const sz = Number(e.size ?? e.total ?? e.bytes ?? e.received) || 0;
    total += sz;
    if (/320|128|hq|high/i.test(String(e.quality || ""))) hq += sz;
    else std += sz;
  }
  return { total, byQuality: { hq, std }, count: list.filter(Boolean).length };
}

// ------------------------------------------------------- playlist editing -
// Mutations over LIBRARY_KEY local records; persist via save(), bool outcome.
export function movePlaylistTrack(plId, from, to) {
  const all = load(LIBRARY_KEY, []);
  const i = all.findIndex((x) => x && x.id === plId);
  if (i < 0) return false;
  const tracks = Array.isArray(all[i] && all[i].tracks) ? [...all[i].tracks] : null;
  if (!tracks) return false;
  const f = Number(from);
  const t = Number(to);
  if (!Number.isInteger(f) || !Number.isInteger(t)) return false;
  if (f < 0 || f >= tracks.length || t < 0 || t >= tracks.length) return false;
  if (f === t) return true;
  const [moved] = tracks.splice(f, 1);
  tracks.splice(t, 0, moved);
  all[i] = { ...all[i], tracks };
  save(LIBRARY_KEY, all);
  return true;
}

export function removePlaylistTrack(plId, trackId) {
  const all = load(LIBRARY_KEY, []);
  const i = all.findIndex((x) => x && x.id === plId);
  if (i < 0) return false;
  const tracks = Array.isArray(all[i] && all[i].tracks) ? [...all[i].tracks] : null;
  if (!tracks) return false;
  const at = tracks.findIndex((t) => t && String(t.id) === String(trackId));
  if (at < 0) return false;
  tracks.splice(at, 1);
  all[i] = { ...all[i], tracks };
  save(LIBRARY_KEY, all);
  return true;
}

// Title is trimmed + capped at 80 chars; an empty title leaves it untouched.
// desc maps to subtitle, cover maps to image (mirrored onto desc/cover too).
export function updatePlaylistMeta(plId, meta = {}) {
  const all = load(LIBRARY_KEY, []);
  const i = all.findIndex((x) => x && x.id === plId);
  if (i < 0) return false;
  const cur = { ...(all[i] || {}) };
  let changed = false;
  if (meta && meta.title !== undefined) {
    const clean = String(meta.title || "").trim().slice(0, 80);
    if (clean) {
      cur.title = clean;
      changed = true;
    }
  }
  if (meta && meta.desc !== undefined) {
    cur.subtitle = String(meta.desc || "");
    cur.desc = String(meta.desc || "");
    changed = true;
  }
  if (meta && meta.cover !== undefined) {
    cur.image = String(meta.cover || "");
    cur.cover = String(meta.cover || "");
    changed = true;
  }
  if (!changed) return false;
  all[i] = cur;
  save(LIBRARY_KEY, all);
  return true;
}

// ------------------------------------------------------------ share cards -
// Renders a 1080x1350 card and shares the PNG file, else copies text.
// Never throws — every step has a fallback.
export async function shareCard({ title, subtitle, image, badge } = {}) {
  try {
    const t = String(title || "Track");
    const sub = String(subtitle || "");
    const bd = String(badge || "");
    const cv = document.createElement("canvas");
    cv.width = 1080;
    cv.height = 1350;
    const ctx = cv.getContext("2d");
    if (ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, 1350);
      g.addColorStop(0, "#141824");
      g.addColorStop(1, "#05070d");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1080, 1350);
      let drew = false;
      const artUrl = image ? hqArt(image) : "";
      if (artUrl) {
        try {
          const img = await new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = "anonymous";
            im.onload = () => res(im);
            im.onerror = rej;
            im.src = artUrl;
          });
          ctx.drawImage(img, 140, 140, 800, 800);
          drew = true;
        } catch {}
      }
      if (!drew) {
        ctx.fillStyle = "#232a3d";
        ctx.fillRect(140, 140, 800, 800);
      }
      if (bd) {
        ctx.fillStyle = "#7c5cff";
        ctx.font = "bold 36px system-ui, sans-serif";
        ctx.fillText(bd.slice(0, 24), 140, 1020);
      }
      ctx.fillStyle = "#fff";
      ctx.font = "bold 64px system-ui, sans-serif";
      ctx.fillText(t.slice(0, 40), 140, 1090);
      if (sub) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = "40px system-ui, sans-serif";
        ctx.fillText(sub.slice(0, 60), 140, 1150);
      }
      let blob = null;
      try {
        blob = await new Promise((res) => {
          try {
            cv.toBlob((b2) => res(b2), "image/png");
          } catch {
            res(null);
          }
        });
      } catch {}
      if (blob) {
        try {
          const file = new File([blob], "share-card.png", { type: "image/png" });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: t, text: sub });
            return;
          }
          if (navigator.share) {
            try {
              await navigator.share({ title: t, text: [t, sub].filter(Boolean).join(" — ") });
              return;
            } catch (e) {
              if (e && e.name === "AbortError") return;
            }
          }
        } catch {}
      }
    }
    const line = [t, sub].filter(Boolean).join(" — ");
    try {
      await navigator.clipboard.writeText(line);
      toast("Share text copied");
    } catch {
      toast("Sharing is unavailable here");
    }
  } catch {}
}

// ---------------------------------------------------------------- haptic -
// Fire-and-forget vibration; silently ignored where unsupported.
export function haptic(ms = 12) {
  try {
    navigator.vibrate?.(Number(ms) || 12);
  } catch {}
}

// ------------------------------------------------------------- onboarding -
// JSON 1 flag for the first-run gate; taste is a JSON artist-shortlist.
export const ONBOARD_KEY = "tm-onboarded";

export function isOnboarded() {
  return load(ONBOARD_KEY, 0) === 1;
}

export function setOnboarded() {
  save(ONBOARD_KEY, 1);
}

export const TASTE_KEY = "tm-taste";

export function loadTaste() {
  const list = load(TASTE_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveTaste(list) {
  save(TASTE_KEY, Array.isArray(list) ? list : []);
}
