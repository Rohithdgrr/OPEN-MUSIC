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
export function pushHistory(q) {
  const h = [q, ...loadHistory().filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem("tm-history", JSON.stringify(h));
  } catch {}
  renderHistory();
}
renderHistory();

