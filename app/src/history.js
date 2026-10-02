// history.js — search history storage + chips
// Split from main.js (Phase 4 M1).
import { $ } from "./dom.js";
import { doSearch } from "./search.js";

// ------------------------------------------------------------------ history -
export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("tm-history") || "[]");
  } catch {
    return [];
  }
}
export const historyEl = $("#history");
export function renderHistory() {
  historyEl.innerHTML = "";
  for (const q of [...new Set(loadHistory())]) {
    const wrap = document.createElement("span");
    wrap.className = "relative inline-flex";
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "px-3 py-1 pr-7 rounded-full text-[12px] font-medium bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("#search-input").value = q;
      doSearch();
    });
    const x = document.createElement("button");
    x.type = "button";
    x.title = `Remove "${q}" from history`;
    x.className =
      "absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors";
    x.innerHTML = '<span class="material-symbols-outlined text-[13px]">close</span>';
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        localStorage.setItem("tm-history", JSON.stringify(loadHistory().filter((v) => v !== q)));
      } catch {}
      wrap.remove();
    });
    wrap.append(b, x);
    historyEl.appendChild(wrap);
  }
  // Home's strip shows the same queries, so one refresh covers both screens.
  renderRecent();
}
/// Home's top strip: the last five searches where the static vibe pills used
/// to sit. They are plain `[data-query]` buttons, so home.js's delegated
/// click handler runs them exactly like the old hardcoded ones.
export function renderRecent() {
  const strip = $("#home-recent");
  if (!strip) return;
  const recent = [...new Set(loadHistory())].slice(0, 5);
  strip.classList.toggle("hidden", !recent.length);
  strip.classList.toggle("flex", recent.length > 0);
  strip.innerHTML = "";
  for (const q of recent) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.query = q;
    b.className =
      "px-space-md py-1.5 rounded bg-surface-container-lowest text-on-surface font-label-md text-label-md shrink-0 shadow-sm hover:bg-surface-container-high transition-colors";
    b.textContent = q;
    strip.appendChild(b);
  }
}
export function pushHistory(q) {
  const h = [q, ...loadHistory().filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem("tm-history", JSON.stringify(h));
  } catch {}
  renderHistory();
}
renderHistory();
