// audioplus.js — the crossfade user surface.
//
// The engine lives in player.js (dual-element transport); this module owns
// only what the user still touches: Settings → crossfade length (tm-xfade,
// 0–12 s) next to the gapless switch.
//
// The audio-quality system (EQ / Immersive room / loudness matching) is
// fully automated per docs/audio-quality.md §6 — it ships with its built-in
// behavior and deliberately has NO settings rows, no selectors and no
// per-track sheets here.
import { haptic, toast } from "./shared.js";

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

/* ------------------------------------------------------- settings UI */
function settingsHost(m) {
  const hosts = [...m.querySelectorAll("div.bg-surface-container-lowest")];
  return hosts.length ? hosts[hosts.length - 1] : null;
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
  </div>`;
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
