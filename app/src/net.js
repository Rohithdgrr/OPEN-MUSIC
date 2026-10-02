// net.js — connection status: online / slow / reconnecting / lost, and the
// routing mode derived from them: online / degraded / offline.
// The browser's `online` flag alone misses captive portals and half-dead
// Wi-Fi, so reachability is proven with a real round-trip: one HEAD to the
// artwork CDN through the backend (`net_ping`), timed. navigator only
// supplies the fast offline signal and Chromium's own rtt estimate.
// No imports: core helpers are injected by startNet, so the state machine
// stays testable in plain node.

const PROBE_OK_MS = 1200; // a round trip past this feels slow
const SLOW_RTT_MS = 300; // the browser's rtt estimate for a sluggish link
const FAILS_TO_LOST = 2; // one failed probe is a hiccup, two means down
const OKS_TO_ONLINE = 3; // hysteresis: three clean probes before we claim recovery
const MIN_SWITCH_MS = 10000; // no mode flap faster than this
const RETRY_DOWN_MS = 2000;
const RETRY_OK_MS = 5000;

export const NET_MODE_KEY = "tm-net-mode"; // auto | online | offline

/// Pure classifier — the whole state machine without a webview around it.
/// `oks` seeds healthy: boot starts optimistic and the first failed probe
/// breaks the streak, so recovery needs three fresh round trips.
export function classify({
  onLine = true,
  ok = true,
  fails = 0,
  oks = OKS_TO_ONLINE,
  ms = 0,
  rtt = 0,
  saveData = false,
} = {}) {
  if (!onLine || fails >= FAILS_TO_LOST) return "lost";
  if (!ok || oks < OKS_TO_ONLINE) return "reconnecting";
  if (ms > PROBE_OK_MS || (rtt > 0 && rtt >= SLOW_RTT_MS) || saveData) return "slow";
  return "online";
}

/// The 4 banner states collapse onto 3 routing modes; `reconnecting` is a
/// transient flavour of degraded (prefer the vault, keep the current track).
const MODES = { online: "online", slow: "degraded", reconnecting: "degraded", lost: "offline" };
export const mode = (s) => MODES[s] || "degraded";

const COPY = {
  lost: { icon: "wifi_off", msg: "No internet connection — retrying…", kind: "error" },
  reconnecting: { icon: "sync", msg: "Reconnecting…", kind: "info" },
  slow: { icon: "network_check", msg: "Slow internet — streams may buffer", kind: "info" },
  online: { icon: "", msg: "", kind: "" },
};

/// Toast copy per mode change (the banner keeps its per-state text above).
const MODE_COPY = {
  online: { msg: "Back online — streaming at full quality", kind: "success" },
  degraded: { msg: "Network is slow — preferring downloaded songs", kind: "info" },
  offline: { msg: "Switched to offline mode — playing from your downloads", kind: "error" },
};

const BADGE = {
  online: ["#22c55e", "Online"],
  degraded: ["#eab308", "Slow"],
  offline: ["#ef4444", "Offline"],
};

let state = "online";
let fails = 0;
let oks = OKS_TO_ONLINE;
let lastMode = "online";
let lastChange = Date.now() - MIN_SWITCH_MS; // the first change is never delayed
let force = null; // "online" | "offline" | null (auto) — read from tm-net-mode
let timer = 0;
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

/// The mode playback, the queue and the badge route by: forced modes win
/// over whatever the probes say — that is the point of forcing them.
export function netMode() {
  return force || mode(state);
}

function paintBadge() {
  if (typeof document === "undefined") return; // plain-node tests
  const el = document.getElementById("net-badge");
  if (!el) return;
  const [color, label] = BADGE[netMode()];
  el.style.color = color;
  const dot = el.querySelector("[data-net-dot]");
  if (dot) dot.style.background = color;
  const txt = el.querySelector("[data-net-label]");
  if (txt) txt.textContent = label;
}

/// Mode transitions notify once — toast + queue refresh. Entering degraded
/// from *offline* is silent: the banner says "Reconnecting…" and the real
/// news is the "Back online" toast that follows.
function modeChanged(m) {
  if (m === lastMode) return;
  const prev = lastMode;
  lastMode = m;
  if (!(m === "degraded" && prev === "offline")) toast(MODE_COPY[m].msg, MODE_COPY[m].kind);
  onMode?.(m);
}

/// Persistent banner + transition notifications. The banner tracks every raw
/// probe state; toasts and onMode fire only when the *mode* changes, so a
/// flapping link never spams the toast stack.
function paint(next) {
  if (next === state || !banner) return;
  // ponytail ceiling: a change arriving inside the floor is dropped, not
  // queued — the next probe re-evaluates the same inputs, so it lands one
  // probe interval after the floor expires instead of exactly at it.
  if (Date.now() - lastChange < MIN_SWITCH_MS) return;
  const prev = state;
  state = next;
  lastChange = Date.now();
  const copy = COPY[next];
  if (next === "online") {
    banner.classList.add("hidden");
    diag("net", true, `recovered from ${prev}`);
  } else {
    banner.className = bannerBase(next);
    banner.innerHTML = `<span class="material-symbols-outlined text-[18px]">${copy.icon}</span><span>${copy.msg}</span>`;
    banner.classList.remove("hidden");
    diag("net", next === "lost" ? false : null, `${copy.msg} (was ${prev})`);
  }
  paintBadge();
  modeChanged(netMode());
}

const bannerBase = (next) =>
  `fixed left-1/2 -translate-x-1/2 top-20 z-[60] flex items-center gap-2 px-4 py-2 rounded-full shadow-lg border font-label-md text-label-md ${
    next === "lost"
      ? "bg-error-container text-on-error-container border-error-container"
      : "bg-inverse-surface text-inverse-on-surface border-inverse-surface"
  }`;

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

/// Settings hook: persist the pref first (settings.js does), then re-route.
export function setModePref(v) {
  force = v === "online" || v === "offline" ? v : null;
  paintBadge();
  modeChanged(netMode());
}

export function startNet({ invoke: inv, diag: dg, toast: tt, onMode: om } = {}) {
  invoke = inv;
  if (dg) diag = dg;
  if (tt) toast = tt;
  if (om) onMode = om;
  force = prefForce();
  lastMode = netMode(); // a forced pref announces nothing at boot
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
  paintBadge();
  probe();
}
