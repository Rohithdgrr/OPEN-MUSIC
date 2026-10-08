// core.js — invoke, $ helpers, views, diagnostics, errors, toasts, esc
// Split from main.js (Phase 4 M1).
import { $, errorEl, navLinks, views } from "./dom.js";
import { esc } from "./html.js";
import { openPlaylist, pdCurrentId, plFeatured, renderFavs, renderLibrary, renderPlaylists } from "./library.js";
import { fmtTime } from "./util.js";
import { refreshVault } from "./vault.js";

/* OPEN MUSIC — frontend controller (vanilla ES module, no build step).
 *
 * Wires the three Stitch views (home / search / now-playing) to the Rust
 * backend: search_songs -> results, resolve_song -> badge -> <audio>,
 * plus queue, history, lyrics sync and diagnostics.
 */

// Surface any uncaught error in the UI instead of dying silently.
window.addEventListener("error", (e) => {
  const banner = document.getElementById("error");
  if (banner) {
    banner.textContent = "JS error: " + (e.message || "unknown");
    banner.classList.remove("hidden");
  }
  console.error("[OPEN MUSIC]", e.error || e.message);
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
export const invoke =
  window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
if (!invoke) {
  const banner = document.getElementById("error");
  if (banner) {
    banner.textContent =
      "Tauri IPC unavailable (window.__TAURI_INTERNALS__ missing). Backend commands will not work.";
    banner.classList.remove("hidden");
  }
}

// Scoped streaming IPC (review 4.4). Vendored from @tauri-apps/api@2.12.0
// core.js (MIT OR Apache-2.0) — this app runs unbundled ES modules with no
// npm api package. Wire format: toJSON() -> "__CHANNEL__:<id>"; Rust pushes
// {message, index} envelopes ({end, index} on close), and out-of-order
// indexes buffer here until the gap fills, so handlers see send() order.
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


// ---------------------------------------------------------------- views ---
// WebView2 restores the old scroll position after a repaint; a tab switch has
// to land at the top of the page instead of resuming the last view's place.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
// Tailwind emits text-on-surface-variant after text-on-primary, so the active
// colour only sticks if the inactive ones are actually removed.
export const ACTIVE = ["bg-primary", "text-on-primary"];
export const INACTIVE = ["text-on-surface-variant", "hover:text-on-surface"];

/// Every tab opens at the top of its own long page: the swap below changes the
/// document height, so the first scroll can be clamped away - scroll again on
/// the next frame, once the layout has settled.
export function toTop() {
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

/// Back navigation: the view the user came from, plus where they had scrolled
/// it, so Back resumes in place instead of dumping them at the page top.
let prevView = null;
const scrollPos = new Map();

export function showView(name) {
  const cur = views.find((v) => !v.classList.contains("hidden"));
  if (cur && cur.dataset.view !== name) {
    scrollPos.set(cur.dataset.view, window.scrollY);
    prevView = cur.dataset.view;
  }
  for (const v of views) v.classList.toggle("hidden", v.dataset.view !== name);
  for (const a of navLinks) {
    const on = a.dataset.path === name;
    a.classList.remove(...ACTIVE, ...INACTIVE);
    a.classList.add(...(on ? ACTIVE : INACTIVE));
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  diag("view", null, name);
  toTop();
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

/// One step back: previous view at the scroll position it was left at.
export function backView(fallback = "home") {
  const to = prevView || fallback;
  showView(to);
  const y = scrollPos.get(to) || 0;
  const settle = () => window.scrollTo({ top: y });
  requestAnimationFrame(() => {
    settle();
    requestAnimationFrame(settle);
  });
}

// ------------------------------------------------------- floating back -
// Detail pages (playlist, artist, album, Now Playing's queue) scroll far
// enough that the Back link at the top of the content leaves the screen.
// This pill slides in under the fixed header once the page is deep enough
// for Back to be off-screen, and returns one step — restoring the scroll
// the previous view was left at. It doubles as "top" when there is no
// history yet (backView falls back to the current view and toTop()).
const floatBack = document.createElement("button");
floatBack.type = "button";
floatBack.id = "float-back";
floatBack.title = "Back";
floatBack.setAttribute("aria-label", "Back");
floatBack.className =
  "fixed top-20 left-6 z-40 w-8 h-8 grid place-items-center rounded-full " +
  "bg-surface/90 backdrop-blur-xl border border-surface-container-high/60 " +
  "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low " +
  "shadow-[0_1px_8px_rgba(0,0,0,0.04)] " +
  "opacity-0 -translate-y-2 pointer-events-none transition-all duration-200";
floatBack.innerHTML = '<span class="material-symbols-outlined text-[18px]">arrow_back</span>';
document.body.appendChild(floatBack);
floatBack.addEventListener("click", () => backView());

const BACK_APPEARS_AT = 240;
function paintFloatBack() {
  const show = window.scrollY > BACK_APPEARS_AT;
  floatBack.classList.toggle("opacity-0", !show);
  floatBack.classList.toggle("-translate-y-2", !show);
  floatBack.classList.toggle("pointer-events-none", !show);
  floatBack.setAttribute("aria-hidden", show ? "false" : "true");
}
window.addEventListener("scroll", paintFloatBack, { passive: true });
paintFloatBack();
for (const a of navLinks) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    showView(a.dataset.path);
  });
}

// ------------------------------------------------------------- diagnostics -
export const diagEl = $("#diag");
export function diag(step, ok, detail) {
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
export function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}
export function clearError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

// ------------------------------------------------------------------ toasts -
// Phase 3 auto-sync: the save funnels (saveFavs, saveLocalPls, savePref)
// announce local edits through this event; the sync engine debounces it
// into a round. A DOM event keeps the funnels dependency-free (no cycles).
export function notifyLocalChange() {
  try {
    window.dispatchEvent(new Event("tm:local-change"));
  } catch {}
}

// Background results (downloads especially) must be visible from every view,
// so they render into a stack rooted at <body>, not inside one view.
export function toast(msg, kind = "info", ms = 4500) {
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
  // Only one toast at a time — replace whatever is showing.
  while (stack.firstChild) stack.firstChild.remove();
  stack.appendChild(el);
  setTimeout(() => {
    if (el.isConnected) dismiss();
  }, ms);
  return dismiss;
}

/// Track credits in a native <dialog> so the focus trap, Esc and the backdrop
/// come from the platform instead of hand-rolled key handling. Created lazily
/// like #toast-stack; the box reuses the app's own design tokens.
export function openCredits(t, quality) {
  let dlg = $("#tm-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "tm-dialog";
    dlg.innerHTML = `
    <form method="dialog" class="w-[min(30rem,calc(100vw-2rem))] rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-xl overflow-hidden text-left">
      <div class="flex items-center gap-2 px-5 py-3.5 border-b border-surface-container-high">
        <span class="material-symbols-outlined text-[18px] text-on-surface">info</span>
        <span class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant">Track Credits &amp; Lineage</span>
      </div>
      <dl id="tm-dialog-body" class="px-5 py-4 flex flex-col gap-3"></dl>
      <div class="flex justify-end px-5 pb-4">
        <button type="submit" class="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-inverse-surface transition-colors shadow-sm">Close</button>
      </div>
    </form>`;
    dlg.addEventListener("click", (e) => {
      // Backdrop click closes; the catalog's own page link was removed from
      // this dialog on purpose — nothing in here opens the browser now.
      if (e.target === dlg) return dlg.close();
    });
    document.body.appendChild(dlg);
  }
  // Everything the catalog said about this track, minus the rows it left
  // blank — `duration` reaches the front end as "m:ss", so it is shown as-is
  // and only the numeric form goes through the clock formatter.
  const dur = String(t.duration || "");
  const rows = [
    ["Title", t.title],
    ["Artist", t.artist || "Unknown"],
    ["Album", t.album || "Unknown"],
    ["Duration", /^\d{1,2}:\d{2}(:\d{2})?$/.test(dur) ? dur : fmtTime(Number(t.duration_secs) || 0)],
    ["Year", t.year],
    ["Language", t.language],
    ["Label", t.label],
    ["Quality", quality],
    ["Catalog plays", t.plays ? Number(t.plays).toLocaleString("en") : ""],
    ["Lyrics", t.has_lyrics ? "Available" : ""],
    ["Explicit", t.explicit ? "Yes" : ""],
    ["ID", t.id],
  ].filter(([, v]) => v !== "" && v != null);
  $("#tm-dialog-body", dlg).innerHTML = rows
    .map(
      ([k, v]) => `
      <div class="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-4">
        <dt class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant sm:w-24 shrink-0">${esc(k)}</dt>
        <dd class="text-sm text-on-surface break-words min-w-0">${esc(String(v))}</dd>
      </div>`,
    )
    .join("");
  if (dlg.open) return; // showModal() throws on an already-open dialog
  dlg.showModal();
}

// Escaping lives in html.js (DOM-free, unit-tested by `npm test`) and is
// re-exported here so the existing `import { esc } from "./core.js"` call
// sites keep working.
export { esc };

