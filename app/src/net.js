// net.js — connection status: online / slow / reconnecting / lost.
// The browser's `online` flag alone misses captive portals and half-dead
// Wi-Fi, so reachability is proven with a real round-trip: one HEAD to the
// artwork CDN through the backend (`net_ping`), timed. navigator only
// supplies the fast offline signal and Chromium's own rtt estimate.
// No imports: core helpers are injected by startNet, so the state machine
// stays testable in plain node.

const PROBE_OK_MS = 1200; // a round trip past this feels slow
const SLOW_RTT_MS = 300; // the browser's rtt estimate for a sluggish link
const FAILS_TO_LOST = 2; // one failed probe is a hiccup, two means down
const RETRY_DOWN_MS = 2000;
const RETRY_OK_MS = 20000;

/// Pure classifier — the whole state machine without a webview around it.
export function classify({ onLine = true, ok = true, fails = 0, ms = 0, rtt = 0 } = {}) {
  if (!onLine || fails >= FAILS_TO_LOST) return "lost";
  if (!ok) return "reconnecting";
  if (ms > PROBE_OK_MS || (rtt > 0 && rtt >= SLOW_RTT_MS)) return "slow";
  return "online";
}

const COPY = {
  lost: { icon: "wifi_off", msg: "No internet connection — retrying…", kind: "error" },
  reconnecting: { icon: "sync", msg: "Reconnecting…", kind: "info" },
  slow: { icon: "network_check", msg: "Slow internet — streams may buffer", kind: "info" },
  online: { icon: "", msg: "", kind: "" },
};

let state = "online";
let fails = 0;
let timer = 0;
let banner = null;
let invoke = null;
let diag = () => {};
let toast = () => {};

/// Persistent banner + transition notifications. Notifications only fire on
/// a state *change*, so a flapping link never spams the toast stack.
function paint(next) {
  if (next === state || !banner) return;
  const prev = state;
  state = next;
  const copy = COPY[next];
  if (next === "online") {
    banner.classList.add("hidden");
    toast("Back online", "success");
    diag("net", true, `recovered from ${prev}`);
    return;
  }
  banner.className = bannerBase(next);
  banner.innerHTML = `<span class="material-symbols-outlined text-[18px]">${copy.icon}</span><span>${copy.msg}</span>`;
  banner.classList.remove("hidden");
  toast(copy.msg, copy.kind);
  diag("net", next === "lost" ? false : null, `${copy.msg} (was ${prev})`);
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
  let ok = true;
  let ms = 0;
  if (onLine) {
    try {
      ms = (await invoke("net_ping")) || 0;
      fails = 0;
    } catch {
      ok = false;
      fails += 1;
    }
  }
  const next = classify({ onLine, ok, fails, ms, rtt });
  paint(next);
  timer = setTimeout(probe, next === "online" || next === "slow" ? RETRY_OK_MS : RETRY_DOWN_MS);
}

export function startNet({ invoke: inv, diag: dg, toast: tt } = {}) {
  invoke = inv;
  if (dg) diag = dg;
  if (tt) toast = tt;
  banner = document.createElement("div");
  banner.id = "net-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.className = bannerBase("reconnecting") + " hidden";
  document.body.appendChild(banner);

  window.addEventListener("offline", () => {
    fails = FAILS_TO_LOST;
    paint("lost");
    probe();
  });
  window.addEventListener("online", () => {
    fails = 0;
    paint("reconnecting");
    probe();
  });
  navigator.connection?.addEventListener?.("change", () => probe());
  probe();
}
