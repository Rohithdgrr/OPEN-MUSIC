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
import { mobileEqBands, resetMobileEq, setMobileEqBand } from "./player.js";
import { MOBILE_EQ_LABELS } from "./eqstate.js";

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

function eqDialogHTML() {
  const controls = MOBILE_EQ_LABELS.map(
    (label, index) => `<label class="mobile-eq-band">
      <span class="font-label-sm text-on-surface">${label}</span>
      <input type="range" min="-12" max="12" step="1" value="0" data-eq-band="${index}" aria-label="${label} gain">
      <output data-eq-value="${index}" class="font-label-mono text-[11px] text-secondary text-right">0 dB</output>
    </label>`,
  ).join("");
  return `<dialog class="mobile-eq-dialog" data-mobile-eq aria-labelledby="mobile-eq-title" aria-describedby="mobile-eq-help">
    <div class="mobile-eq-content">
      <header class="flex items-center justify-between gap-3">
        <div>
          <h2 id="mobile-eq-title" class="font-headline-sm text-[18px] font-bold text-on-surface">Equalizer</h2>
          <p id="mobile-eq-help" class="font-body-sm text-[12px] text-secondary">Five-band tone control · −12 to +12 dB</p>
        </div>
        <button type="button" data-eq-close class="min-h-[44px] min-w-[44px] rounded-full text-on-surface" aria-label="Close equalizer">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>
      <div class="mobile-eq-bands">${controls}</div>
      <footer class="flex items-center justify-between gap-3">
        <button type="button" data-eq-reset class="min-h-[44px] rounded-full border border-outline-variant px-4 font-label-md text-on-surface">Reset to flat</button>
        <button type="button" data-eq-close class="min-h-[44px] rounded-full bg-primary px-5 font-label-md text-on-primary">Done</button>
      </footer>
    </div>
  </dialog>`;
}

function paintEqDialog(dialog) {
  const gains = mobileEqBands();
  for (let index = 0; index < MOBILE_EQ_LABELS.length; index++) {
    const slider = dialog.querySelector(`[data-eq-band="${index}"]`);
    const value = dialog.querySelector(`[data-eq-value="${index}"]`);
    if (slider) slider.value = String(gains[index]);
    if (value) value.textContent = `${gains[index]} dB`;
  }
}

function enhanceEqualizer(m) {
  const trigger = m && m.querySelector("#np-action-eq");
  if (!trigger) return;

  let dialog = document.querySelector("dialog[data-mobile-eq]");
  if (!dialog) {
    document.body.insertAdjacentHTML("beforeend", eqDialogHTML());
    dialog = document.querySelector("dialog[data-mobile-eq]");
  }
  if (!dialog) return;

  if (!dialog.dataset.wired) {
    dialog.dataset.wired = "1";
    dialog.addEventListener("input", (event) => {
      const slider = event.target.closest("[data-eq-band]");
      if (!slider) return;
      const index = Number(slider.dataset.eqBand);
      const gains = setMobileEqBand(index, slider.value);
      const value = dialog.querySelector(`[data-eq-value="${index}"]`);
      if (value) value.textContent = `${gains[index]} dB`;
    });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-eq-close]")) dialog.close();
      if (event.target.closest("[data-eq-reset]")) {
        resetMobileEq();
        paintEqDialog(dialog);
      }
    });
    dialog.addEventListener("close", () => {
      document.querySelector("#np-action-eq")?.focus();
    });
  }

  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", "mobile-eq-dialog");
  trigger.addEventListener("click", () => {
    paintEqDialog(dialog);
    if (!dialog.open) dialog.showModal();
  });
}

document.addEventListener("smount", (e) => {
  try {
    if (e && e.detail && (e.detail.key === "settings" || e.detail.dir === "settings")) {
      enhanceSettingsSoon();
    }
    if (e && e.detail && e.detail.dir === "nowplaying") {
      enhanceEqualizer(document.getElementById("screen"));
    }
  } catch {}
});
