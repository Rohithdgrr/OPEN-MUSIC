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
  lost: { msg: "No internet connection — retrying…" },
  reconnecting: { msg: "Reconnecting…" },
  slow: { msg: "Slow internet — streams may buffer" },
  online: { msg: "Online — streaming at full quality" },
};

// The tile itself is the indicator: it fills with the state colour, white
// mark on top (no banner text, no toasts — the user asked notifications
// gone, one glanceable icon instead).
const FILL = {
  online: "#10b981",
  slow: "#f59e0b",
  reconnecting: "#f59e0b",
  lost: "#ef4444",
};

let state = "online";
let fails = 0;
let oks = OKS_TO_ONLINE;
let lastMode = "online";
let lastChange = Date.now() - MIN_SWITCH_MS;
let force = null; // "online" | "offline" | null (auto)
let timer = 0;
let invoke = null;
let diag = () => {};
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

function modeChanged(m) {
  if (m === lastMode) return;
  lastMode = m;
  // No toasts, ever — the avatar fill is the whole notification.
  onMode?.(m);
}

/// The indicator is the existing header profile avatar (the `person` glyph
/// button that navigates to Settings) — its circle fills with the state
/// colour; the glyph stays white on top and the button keeps working.
/// Headers are rebuilt from their fragment on every navigation, so this is
/// called on state changes AND on the router's `smount` event.
function paintAvatar(next) {
  const msg = COPY[next].msg;
  document.querySelectorAll('[data-nav="settings"]').forEach((btn) => {
    const glyph = btn.querySelector(":scope > .material-symbols-outlined");
    if (!glyph || glyph.textContent.trim() !== "person") return;
    const base = btn.dataset.netAria || btn.getAttribute("aria-label") || "Settings";
    btn.dataset.netAria = base;
    // Attribute + var paint, never an inline background: both themes paint
    // this button with an !important gradient that beats inline styles
    // (measured rgba(0,0,0,0) — see the [data-net-state] rules in index.html).
    btn.dataset.netState = next;
    btn.style.setProperty("--tm-net-fill", FILL[next]);
    btn.classList.toggle("net-pulse", next === "reconnecting");
    btn.title = msg;
    btn.setAttribute("aria-label", `${base} — network: ${msg}`);
  });
}

function paint(next) {
  if (next === state) return;
  if (Date.now() - lastChange < MIN_SWITCH_MS) return;
  const prev = state;
  state = next;
  lastChange = Date.now();
  paintAvatar(next);
  diag("net", next === "online" ? true : next === "lost" ? false : null, `${COPY[next].msg} (was ${prev})`);
  modeChanged(netMode());
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

export function startNet({ invoke: inv, diag: dg, onMode: om } = {}) {
  invoke = inv;
  if (!invoke) return; // no Tauri IPC — stay optimistic, nothing to probe
  if (dg) diag = dg;
  if (om) onMode = om;
  force = prefForce();
  lastMode = netMode();
  paintAvatar(state);
  // Every navigation rebuilds the header from its fragment, wiping the
  // inline fill — repaint when a screen mounts.
  document.addEventListener("smount", () => paintAvatar(state), { passive: true });

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
