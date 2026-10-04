// audioplus.js — crossfade/gapless + per-track EQ user surface.
//
// The engine lives in player.js (dual-element transport); this module owns
// what the user touches:
//  1. Settings: crossfade length selector (tm-xfade, 0–12s) next to the
//     existing gapless switch, with a one-line explanation of how they stack.
//  2. Track menu → "EQ for this track" (window.__tmTrackEq, wired in
//     menus.js): a bottom sheet with the six presets + "Use global" reset.
//  3. Settings: the list of tracks carrying a custom EQ, with clear buttons.
import { haptic, toast, trackEqMap, setTrackEq, trackEqFor } from "./shared.js";
import { esc } from "../html.js";
import { applyEq, onPaint } from "./player.js";

const PRESETS = [
  ["flat", "Flat"],
  ["bass", "Bass"],
  ["bassboost", "Bass Boost"],
  ["pop", "Pop"],
  ["bright", "Bright"],
  ["vocal", "Vocal"],
];

function xfadeSecs() {
  try {
    const v = Number(localStorage.getItem("tm-xfade") || "0");
    return v >= 0 && v <= 12 ? v : 0;
  } catch {
    return 0;
  }
}

function setXfade(v) {
  try {
    const n = Math.max(0, Math.min(12, Number(v) || 0));
    localStorage.setItem("tm-xfade", String(n));
    return n;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------- per-track EQ sheet */
function closeSheet() {
  const ov = document.getElementById("tm-eq-sheet");
  if (ov) ov.remove();
}

function openTrackEq(track) {
  if (!track || !track.id) return toast("Nothing selected");
  closeSheet();
  const cur = trackEqFor(track.id) || "global";
  const ov = document.createElement("div");
  ov.id = "tm-eq-sheet";
  ov.className = "fixed inset-0 z-[85] flex flex-col justify-end pointer-events-auto";
  ov.innerHTML = `
    <div class="absolute inset-0 bg-black/50 backdrop-blur-md" data-eq-close></div>
    <div class="relative bg-surface-container-lowest/95 backdrop-blur-2xl border-t border-surface-container-high/80 rounded-3xl max-w-lg mx-auto w-full overflow-hidden px-5 pt-3 pb-8 shadow-[0_-16px_48px_rgba(0,0,0,0.18)] flex flex-col gap-2 mb-2">
      <div class="w-12 h-1.5 bg-surface-container-highest rounded-full mx-auto mb-1 opacity-80"></div>
      <h3 class="font-headline-md text-[15px] font-semibold tracking-tight text-on-surface">EQ — ${esc(track.title || "Track")}</h3>
      <p class="font-body-sm text-[12px] text-secondary -mt-1">Applies to this track only. Everything else keeps your global preset.</p>
      <div class="flex flex-col gap-1" data-eq-list>
        ${[["global", `Use global`]].concat(PRESETS).map(([v, l]) => `<button type="button" data-eq-pick="${v}" class="flex items-center justify-between px-3 py-2.5 rounded-xl text-left text-[13.5px] font-medium transition-all active:scale-[0.99] ${v === cur ? "bg-primary text-on-primary font-semibold" : "text-on-surface hover:bg-surface-container/70"}"><span>${esc(l)}</span>${v === cur ? '<span class="material-symbols-outlined text-[18px]">check</span>' : ""}</button>`).join("")}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest("[data-eq-close]")) {
      closeSheet();
      return;
    }
    const pick = e.target.closest("[data-eq-pick]");
    if (!pick) return;
    const v = pick.dataset.eqPick;
    try {
      haptic(12);
    } catch {}
    if (v === "global") setTrackEq(track.id, "");
    else setTrackEq(track.id, v);
    try {
      applyEq(); // live: the playing track changes EQ immediately
    } catch {}
    toast(v === "global" ? "Back to your global EQ" : `EQ for this track: ${v}`, 2500, "success");
    refreshCustomList();
    closeSheet();
  });
}

window.__tmTrackEq = openTrackEq;

/* ------------------------------------------------------- settings UI */
function settingsHost(m) {
  const hosts = [...m.querySelectorAll("div.bg-surface-container-lowest")];
  return hosts.length ? hosts[hosts.length - 1] : null;
}

function customEqRows() {
  const map = trackEqMap();
  const ids = Object.keys(map);
  if (!ids.length) return `<p class="font-body-sm text-[12px] text-secondary" data-eq-empty>Every track uses your global preset.</p>`;
  // Titles are not stored in the map — resolve from plays/favorites history
  // is overkill; show the preset with a short id + clear button.
  return ids
    .slice(-20)
    .map(
      (id) => `<div class="flex items-center justify-between gap-2 py-1.5" data-eq-row="${esc(id)}">
      <span class="font-body-sm text-[12.5px] text-on-surface truncate">…${esc(String(id).slice(-10))} · <span class="text-secondary">${esc(map[id])}</span></span>
      <button type="button" data-eq-clear="${esc(id)}" class="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface text-[12px] font-semibold active:scale-95">Reset</button>
    </div>`,
    )
    .join("");
}

function sectionHTML() {
  const x = xfadeSecs();
  return `<div class="p-4 flex flex-col gap-3" data-xfade-sec>
    <div class="flex items-center justify-between gap-4">
      <span class="flex flex-col min-w-0"><span class="font-body-md text-[14px] text-on-surface font-semibold tracking-tight">Crossfade</span><span class="font-body-sm text-[12px] text-on-surface-variant truncate mt-0.5">Blend into the next track · gapless switch stays separate</span></span>
      <span class="material-symbols-outlined text-on-surface-variant">graphic_eq</span>
    </div>
    <div class="flex gap-2 items-center">
      <select data-xfade-pick class="flex-1 min-w-0 bg-surface-container rounded-xl px-3 py-2.5 text-[13px] text-on-surface">
        ${[0, 2, 4, 6, 8, 12].map((s) => `<option value="${s}"${s === x ? " selected" : ""}>${s === 0 ? "Off" : s + " seconds"}</option>`).join("")}
      </select>
    </div>
    <div class="flex flex-col gap-1 pt-1" data-eq-custom>
      <span class="font-body-md text-[13px] text-on-surface font-semibold">Per-track EQ</span>
      <div data-eq-custom-list>${customEqRows()}</div>
    </div>
  </div>`;
}

export function refreshCustomList() {
  try {
    const host = document.querySelector("[data-eq-custom-list]");
    if (host) host.innerHTML = customEqRows();
  } catch {}
}

function wireSection(sec) {
  const pick = sec.querySelector("[data-xfade-pick]");
  if (pick) {
    pick.addEventListener("change", () => {
      const n = setXfade(pick.value);
      try {
        haptic(10);
      } catch {}
      toast(n === 0 ? "Crossfade off" : `Crossfade: ${n}s`, 2500, "success");
    });
  }
  sec.addEventListener("click", (e) => {
    const clr = e.target && e.target.closest ? e.target.closest("[data-eq-clear]") : null;
    if (!clr) return;
    setTrackEq(clr.dataset.eqClear, "");
    try {
      applyEq();
    } catch {}
    toast("Track back to global EQ", 2500, "success");
    refreshCustomList();
  });
}

function enhanceSettings() {
  const m = document.getElementById("screen");
  if (!m || m.querySelector("[data-xfade-sec]")) return;
  const host = settingsHost(m);
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = sectionHTML();
  const sec = wrap.firstElementChild;
  if (!sec) return;
  host.appendChild(sec);
  wireSection(sec);
}

// app.js's own smount listener (mountSettings, which builds the prefs DOM
// we anchor to) was registered before ours — the host may not exist yet when
// we first run, so poll briefly instead of firing once and giving up.
function enhanceSettingsSoon() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try {
      const m = document.getElementById("screen");
      if (m && (m.querySelector("[data-xfade-sec]") || settingsHost(m))) {
        clearInterval(timer);
        enhanceSettings();
      } else if (tries >= 10) clearInterval(timer);
    } catch {
      clearInterval(timer);
    }
  }, 400);
}

document.addEventListener("smount", (e) => {
  try {
    if (e && e.detail && (e.detail.key === "settings" || e.detail.dir === "settings")) {
      enhanceSettingsSoon();
    }
  } catch {}
});

// Keep the per-track EQ honest: applyEq() already prefers the override,
// but it only runs at resolve/play time — re-run it when the track identity
// flips underneath (auto-advance, queue jump) so the new track's override
// lands even if the user never touches settings.
try {
  let lastId = null;
  onPaint((s) => {
    try {
      const id = s && s.track ? String(s.track.id || "") : "";
      if (id !== lastId) {
        lastId = id;
        applyEq();
      }
    } catch {}
  });
} catch {}
