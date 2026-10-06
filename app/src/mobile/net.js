// net.js — mobile port of the desktop connection state machine.
// online / slow / reconnecting / lost → routing mode online / degraded / offline.
// navigator.onLine misses captive portals and half-dead Wi-Fi, so reachability
// is proven with a timed round-trip through the backend (`net_ping`).
// No imports: helpers are injected by startNet, mobile just wires toast/paint.

const PROBE_OK_MS = 1200;
const SLOW_RTT_MS = 300;
const FAILS_TO_LOST = 2;
const OKS_TO_ONLINE = 3;
const MIN_SWITCH_MS = 10000;
const SHOW_AFTER_MS = 8000; // banner unhides only after 8 s of sustained trouble
const RETRY_DOWN_MS = 2000;
const RETRY_OK_MS = 5000;

export const NET_MODE_KEY = "tm-net-mode"; // auto | online | offline

/// Pure classifier — the whole state machine without a webview around it.
export function classify({ onLine = true, ok = true, fails = 0, oks = OKS_TO_ONLINE, ms = 0, rtt = 0, saveData = false } = {}) {
  if (!onLine || fails >= FAILS_TO_LOST) return "lost";
  if (!ok || oks < OKS_TO_ONLINE) return "reconnecting";
  if (ms > PROBE_OK_MS || (rtt > 0 && rtt >= SLOW_RTT_MS) || saveData) return "slow";
  return "online";
}

const MODES = { online: "online", slow: "degraded", reconnecting: "degraded", lost: "offline" };
export const mode = (s) => MODES[s] || "degraded";

const COPY = {
  lost: { icon: "wifi_off", msg: "No internet connection — retrying…" },
  reconnecting: { icon: "sync", msg: "Reconnecting…" },
  slow: { icon: "network_check", msg: "Slow internet — streams may buffer" },
  online: { icon: "", msg: "" },
};

const MODE_COPY = {
  online: { msg: "Back online — streaming at full quality", kind: "success" },
  degraded: { msg: "Network is slow — preferring downloaded songs", kind: "info" },
  offline: { msg: "Offline — playing from your downloads", kind: "error" },
};

let state = "online";
let fails = 0;
let oks = OKS_TO_ONLINE;
let lastMode = "online";
let lastChange = Date.now() - MIN_SWITCH_MS;
let force = null; // "online" | "offline" | null (auto)
let timer = 0;
let firstBadAt = 0; // when the current non-online stretch started (0 = online)
let banner = null;
let invoke = null;
let diag = () => {};
let toast = () => {};
let onMode = null;

function prefForce() {
  try {
    const v = localStorage.getItem(NET_MODE_KEY);
    return v === "online" || v === "offline" ? v : null;
  } catch {
    return null;
  }
}

/// What playback, the offline gate and screens route by.
export function netMode() {
  return force || mode(state);
}

/// Settings hook: persist the pref first, then re-route.
export function setModePref(v) {
  force = v === "online" || v === "offline" ? v : null;
  modeChanged(netMode());
}

function modeChanged(m, { silent = false } = {}) {
  if (m === lastMode) return;
  lastMode = m;
  if (silent) {
    // Probe-driven: the banner owns bad-state display, so only recovery
    // toasts — the banner just vanishes, leaving the toast as the sole
    // "back online" confirmation.
    if (m === "online") toast(MODE_COPY[m].msg, 4000, MODE_COPY[m].kind);
  } else {
    // User-initiated pref change: always confirm.
    toast(MODE_COPY[m].msg, 4000, MODE_COPY[m].kind);
  }
  onMode?.(m);
}

const bannerBase = (next) =>
  `fixed top-[calc(env(safe-area-inset-top,0px)+3.5rem+8px)] inset-x-0 mx-auto w-max max-w-[90vw] z-[85] flex items-center justify-center gap-1.5 px-3 py-1 rounded-full font-medium text-[11px] shadow-lg backdrop-blur-xl border transition-all duration-300 pointer-events-auto ${
    next === "lost" ? "bg-red-500/95 text-white border-red-400/30 shadow-red-500/25" : "bg-zinc-900/90 text-zinc-100 border-zinc-700/50 shadow-black/30"
  }`;

function showBanner(next) {
  const copy = COPY[next];
  banner.className = bannerBase(next);
  banner.innerHTML = `<span class="material-symbols-outlined text-[14px]">${copy.icon}</span><span>${copy.msg}</span>`;
  banner.classList.remove("hidden");
}

function paint(next) {
  if (!banner) return;
  if (next !== "online") {
    if (!firstBadAt) firstBadAt = Date.now();
    if (next === state) {
      // Same bad stretch, no transition: the delayed show may still mature.
      if (Date.now() - firstBadAt >= SHOW_AFTER_MS) showBanner(next);
      return;
    }
  }
  if (next === state) return;
  if (Date.now() - lastChange < MIN_SWITCH_MS) return;
  const prev = state;
  state = next;
  lastChange = Date.now();
  const copy = COPY[next];
  if (next === "online") {
    firstBadAt = 0;
    banner.classList.add("hidden");
    diag("net", true, `recovered from ${prev}`);
  } else {
    showBanner(next);
    // Delayed show: transient blips (< SHOW_AFTER_MS) never unhide the pill.
    // (className above wipes classes, so re-hide explicitly while waiting.)
    if (Date.now() - firstBadAt >= SHOW_AFTER_MS) banner.classList.remove("hidden");
    else banner.classList.add("hidden");
    diag("net", next === "lost" ? false : null, `${copy.msg} (was ${prev})`);
  }
  modeChanged(netMode(), { silent: true });
}

async function probe() {
  clearTimeout(timer);
  const onLine = navigator.onLine !== false;
  const rtt = navigator.connection?.rtt || 0;
  const saveData = navigator.connection?.saveData === true;
  let ok = true;
  let ms = 0;
  if (onLine) {
    try {
      ms = (await invoke("net_ping")) || 0;
      fails = 0;
      oks = Math.min(oks + 1, OKS_TO_ONLINE);
    } catch {
      ok = false;
      fails += 1;
      oks = 0;
    }
  } else {
    oks = 0;
  }
  const next = classify({ onLine, ok, fails, oks, ms, rtt, saveData });
  paint(next);
  timer = setTimeout(probe, next === "online" || next === "slow" ? RETRY_OK_MS : RETRY_DOWN_MS);
}

export function startNet({ invoke: inv, diag: dg, toast: tt, onMode: om } = {}) {
  invoke = inv;
  if (!invoke) return; // no Tauri IPC — stay optimistic, nothing to probe
  if (dg) diag = dg;
  if (tt) toast = tt;
  if (om) onMode = om;
  force = prefForce();
  lastMode = netMode();
  banner = document.createElement("div");
  banner.id = "net-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.className = bannerBase("reconnecting") + " hidden";
  document.body.appendChild(banner);

  window.addEventListener("offline", () => {
    fails = FAILS_TO_LOST;
    oks = 0;
    paint("lost");
    probe();
  });
  window.addEventListener("online", () => {
    fails = 0;
    oks = 0;
    paint("reconnecting");
    probe();
  });
  navigator.connection?.addEventListener?.("change", () => probe());
  probe();
}
