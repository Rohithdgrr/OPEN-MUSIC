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

/// The 4 probe states collapse onto 3 routing modes; `reconnecting` is a
/// transient flavour of degraded (prefer the vault, keep the current track).
const MODES = { online: "online", slow: "degraded", reconnecting: "degraded", lost: "offline" };
export const mode = (s) => MODES[s] || "degraded";

const COPY = {
  lost: { icon: "wifi_off", msg: "No internet connection — retrying…", kind: "error" },
  reconnecting: { icon: "sync", msg: "Reconnecting…", kind: "info" },
  slow: { icon: "network_check", msg: "Slow internet — streams may buffer", kind: "info" },
  online: { icon: "", msg: "", kind: "" },
};

/// Toast copy per mode change (per-state text lives in COPY above).
const MODE_COPY = {
  online: { msg: "Back online — streaming at full quality", kind: "success" },
  degraded: { msg: "Network is slow — preferring downloaded songs", kind: "info" },
  offline: { msg: "Switched to offline mode — playing from your downloads", kind: "error" },
};

/// Header badge copy, keyed by raw probe state (not routing mode) so the
/// badge beside the settings icon narrates every phase — including the
/// transient "reconnecting" one the floating banner used to own. Only the
/// text lives here — the hue is CSS's job (`#net-badge[data-net-mode]`
/// against --tm-ok/--tm-warn/--tm-bad), so the badge, its dot and its pulse
/// halo can never disagree with each other.
const BADGE = {
  online: { mode: "online", label: "Online", title: "Online — streaming at full quality" },
  slow: { mode: "degraded", label: "Slow", title: "Slow network — preferring downloaded songs" },
  reconnecting: { mode: "reconnecting", label: "Reconnecting…", title: "Connection dropped — retrying, downloads preferred meanwhile" },
  lost: { mode: "offline", label: "Offline", title: "No internet — playing from your downloads" },
};

let state = "online";
let fails = 0;
let oks = OKS_TO_ONLINE;
let lastMode = "online";
let lastChange = Date.now() - MIN_SWITCH_MS; // the first change is never delayed
let force = null; // "online" | "offline" | null (auto) — read from tm-net-mode
let timer = 0;
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

/// Exported for tests (and only tests): stamp the header badge for a raw probe
/// state without running the prober. Guards a missing document so plain-node
/// imports stay safe.
export function paintBadge(raw) {
  if (typeof document === "undefined") return; // plain-node tests
  const el = document.getElementById("net-badge");
  if (!el) return;
  const b = BADGE[raw || state] || BADGE.slow;
  // Attribute, not inline style: the stylesheet owns every hue the badge
  // shows, so the label, the dot and the pulsing halo move together.
  el.dataset.netMode = b.mode;
  el.title = b.title;
  const txt = el.querySelector("[data-net-label]");
  if (txt) txt.textContent = b.label;
}

/// Mode transitions notify once — badge + queue refresh, and a toast only for
/// a change the user actually made in Settings. Probe-driven transitions pass
/// `silent`: the header badge beside the settings icon already narrates those,
/// so popping a toast on top of it is noise. Entering degraded from *offline*
/// is silent either way — the badge says "Reconnecting…" and the real news is
/// the recovery that follows.
function modeChanged(m, { silent = false } = {}) {
  if (m === lastMode) return;
  const prev = lastMode;
  lastMode = m;
  if (!silent && !(m === "degraded" && prev === "offline")) toast(MODE_COPY[m].msg, MODE_COPY[m].kind);
  onMode?.(m);
}

/// Badge + diagnostics per probe state. The badge tracks every raw state so a
/// flapping link narrates in place; the toast and onMode fire only when the
/// *mode* changes, so a flapping link never spams the toast stack. There is
/// deliberately no floating pill anymore — connection state lives only in the
/// header badge beside the settings icon.
function paint(next) {
  if (next === state) return;
  // ponytail ceiling: a change arriving inside the floor is dropped, not
  // queued — the next probe re-evaluates the same inputs, so it lands one
  // probe interval after the floor expires instead of exactly at it.
  if (Date.now() - lastChange < MIN_SWITCH_MS) return;
  const prev = state;
  state = next;
  lastChange = Date.now();
  const copy = COPY[next];
  diag("net", next === "online" ? true : next === "lost" ? false : null, `${copy.msg} (was ${prev})`);
  paintBadge(next);
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

/// Settings hook: persist the pref first (settings.js does), then re-route.
/// Not silent: this one is a deliberate user action, so it still confirms.
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
