// core.js — invoke, $ helpers, views, diagnostics, errors, toasts, esc
// Split from main.js (Phase 4 M1).
import { $, errorEl, navLinks, views } from "./dom.js";
import { openPlaylist, pdCurrentId, plFeatured, renderFavs, renderLibrary, renderPlaylists } from "./library.js";
import { fmtTime } from "./util.js";
import { refreshVault } from "./vault.js";

/* TRANCE MUSIC â€” frontend controller (vanilla ES module, no build step).
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

export function showView(name) {
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
  li.textContent = detail ? `${t} ${step} â€” ${detail}` : `${t} ${step}`;
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
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstChild.remove();
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
      if (e.target === dlg) dlg.close();
    });
    document.body.appendChild(dlg);
  }
  const rows = [
    ["Title", t.title],
    ["Artist", t.artist || "Unknown"],
    ["Album", t.album || "Unknown"],
    ["Duration", fmtTime(t.duration || 0)],
    ["Quality", quality],
    ["ID", t.id],
  ];
  $("#tm-dialog-body", dlg).innerHTML = rows
    .map(
      ([k, v]) => `
      <div class="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-4">
        <dt class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant sm:w-24 shrink-0">${esc(k)}</dt>
        <dd class="text-sm text-on-surface break-words min-w-0">${esc(v)}</dd>
      </div>`,
    )
    .join("");
  if (dlg.open) return; // showModal() throws on an already-open dialog
  dlg.showModal();
}

// Every value that ever came from the API must pass through esc() — in text
// position AND inside attributes/URLs. It escapes quotes too, so
// `attr="${esc(x)}"` is injection-safe. Never interpolate raw data.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

