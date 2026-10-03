// The desktop card is a pure view: the main window owns the queue, the audio
// element and every control, so this file only paints state and forwards taps.
// import { wireJelly } from "./jelly.js"; // jelly mode off
const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
const emit = (event, payload) => window.__TAURI__?.event?.emit(event, payload);
function listen(event, handler) {
  try {
    const p = window.__TAURI__?.event?.listen(event, handler);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

const POS_KEY = "tm-desk-widget-pos";
const MODE_KEY = "tm-desk-widget-mode";
const OFF_KEY = "tm-desk-widget";

const card = document.getElementById("wg-card");
const win = window.__TAURI__?.window?.getCurrentWindow?.();
// wireJelly(() => card); // jelly mode off

// L3: the same /art cache the main window uses. The widget window doesn't
// run main.js, so it fetches the relay base itself; until it resolves,
// images point straight at the CDN (allowed by the CSP either way).
let artBase = "";
if (invoke) {
  try {
    artBase = await invoke("proxy_base");
  } catch {}
}
function artUrl(url) {
  if (!artBase || !url) return url;
  return `${artBase}/art?u=${encodeURIComponent(url)}`;
}

// Two window sizes: the wide compact card and the icon it becomes while the
// user is in another application.
const FULL = { w: 380, h: 190 };
const MINI = { w: 76, h: 76 };
let isMini = false;

const el = (id) => document.getElementById(id);

function setText(id, text) {
  const node = el(id);
  if (node && node.textContent !== text) node.textContent = text;
}

const LOGO = "logo.png"; // platform logo — a local file, so it works offline

function setImage(id, src) {
  const img = el(id);
  if (!img) return;
  if (src) {
    img.onerror = () => {
      // Artwork 404/offline → platform logo, then stop listening so the
      // logo itself can never loop. The next render retries the real URL.
      img.onerror = null;
      if (!img.src.endsWith(LOGO)) img.src = LOGO;
    };
    if (img.getAttribute("src") !== src) img.src = src;
    img.style.display = "";
  } else if (img.getAttribute("src") !== LOGO) {
    // No artwork: the platform logo instead of a blank slot.
    img.src = LOGO;
    img.style.display = "";
  }
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function paintMode() {
  let mode = "top";
  try {
    mode = localStorage.getItem(MODE_KEY) === "desktop" ? "desktop" : "top";
  } catch {}
  setText("wg-place", mode === "desktop" ? "ON THE WALLPAPER" : "ALWAYS ON TOP");
}

function render(s) {
  const ratio = s.duration > 0 ? Math.min(1, Math.max(0, s.position / s.duration)) : 0;
  card.classList.toggle("is-playing", !!s.hasTrack && !s.paused);

  setText("wg-title", s.hasTrack ? s.title : "Nothing playing");
  setText(
    "wg-artist",
    s.hasTrack
      ? [s.artist, s.album].filter(Boolean).join(" \u00b7 ")
      : "Search the vault and press play",
  );

  const art = el("wg-art");
  const cover = artUrl(s.image);
  if (art) art.style.backgroundImage = cover ? `url("${cover}")` : "";
  setImage("wg-cover", cover);
  const miniBtn = el("wg-mini");
  if (miniBtn) miniBtn.style.backgroundImage = cover ? `url("${cover}")` : "";

  const badge = el("wg-badge");
  if (badge) {
    badge.textContent = s.quality || "HQ";
    badge.style.display = s.quality && s.live ? "" : "none";
  }
  setText("wg-format", s.quality && s.live ? s.quality : s.hasTrack ? "SAVED" : "IDLE");
  setText("wg-vizlabel", !s.hasTrack ? "STANDBY" : s.paused ? "PAUSED" : "PLAYING");

  const fill = el("wg-fill");
  if (fill) fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  setText("wg-cur", fmtTime(s.position));
  setText("wg-total", fmtTime(s.duration));

  setText("wg-playicon", s.paused ? "play_arrow" : "pause");
  setText("wg-volicon", s.muted ? "volume_off" : "volume_up");
  const volfill = el("wg-volfill");
  if (volfill) volfill.style.width = `${(s.muted ? 0 : Math.min(1, s.volume) * 100).toFixed(0)}%`;

  const repeat = el("wg-repeat");
  if (repeat) {
    repeat.classList.toggle("is-on", s.repeat !== "off");
    const icon = repeat.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = s.repeat === "one" ? "repeat_one" : "repeat";
  }

  // Favorite: the main window owns the list, so the card only paints the
  // state it is handed and forwards the tap (bridge.js handles "fav").
  const fav = el("wg-fav");
  const favIcon = el("wg-favicon");
  if (favIcon) favIcon.style.fontVariationSettings = s.fav ? "'FILL' 1" : "'FILL' 0";
  if (fav) {
    fav.classList.toggle("is-on", !!s.fav);
    fav.title = s.fav ? "Remove from favorites" : "Add to favorites";
  }

  const next = s.next;
  setText("wg-nexttitle", next ? next.title : "Nothing queued");
  setText("wg-nextsub", next ? next.sub : "Add songs to the queue");
  setImage("wg-nextcover", next ? artUrl(next.image) : "");
}

function fire(event, payload) {
  try {
    const p = emit(event, payload);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

function cmd(type, value) {
  fire("player:cmd", value === undefined ? { type } : { type, value });
}

function ratioFrom(node, clientX) {
  const r = node.getBoundingClientRect();
  if (!r.width) return 0;
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
}

function readPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y };
  } catch {}
  return null;
}

async function placeDefault() {
  if (!invoke || !win) return;
  try {
    const [mon, size] = await Promise.all([win.currentMonitor(), win.outerSize()]);
    if (!mon) return;
    const w = size?.width || FULL.w;
    const h = size?.height || FULL.h;
    // Bottom right, clear of the taskbar, matching where the app's own chrome
    // leaves room: the card should never be the thing under the cursor first.
    const x = Math.round(mon.position.x + mon.size.width - w - 24);
    const y = Math.round(mon.position.y + mon.size.height - h - 96);
    await invoke("widget_set_position", { x, y });
  } catch {}
}

async function applyPosition() {
  if (!invoke || !win) return;
  const saved = readPos();
  if (!saved) return placeDefault();
  try {
    const [mons, current, size] = await Promise.all([
      win.availableMonitors?.() ?? [],
      win.currentMonitor(),
      win.outerSize(),
    ]);
    // The monitor the card was saved on may be gone (unplugged, resolution
    // change): clamp into the monitor the saved point sits on — else the one
    // the card is on now — instead of parking it off-screen.
    const m =
      mons.find(
        (mon) =>
          saved.x >= mon.position.x &&
          saved.x < mon.position.x + mon.size.width &&
          saved.y >= mon.position.y &&
          saved.y < mon.position.y + mon.size.height,
      ) ||
      current ||
      mons[0];
    let x = Math.round(saved.x);
    let y = Math.round(saved.y);
    if (m) {
      const w = size?.width || FULL.w;
      const h = size?.height || FULL.h;
      const minX = m.position.x;
      const minY = m.position.y;
      const maxX = minX + Math.max(0, m.size.width - w);
      const maxY = minY + Math.max(0, m.size.height - h);
      x = Math.min(Math.max(x, minX), maxX);
      y = Math.min(Math.max(y, minY), maxY);
    }
    await invoke("widget_set_position", { x, y });
  } catch {}
}

async function savePosition() {
  if (!win) return;
  try {
    const p = await win.outerPosition();
    localStorage.setItem(POS_KEY, JSON.stringify({ x: p.x, y: p.y }));
  } catch {}
}

async function setMini(on) {
  if (isMini === on) return;
  isMini = on;
  document.body.classList.toggle("is-mini", on);
  const s = on ? MINI : FULL;
  try {
    if (invoke) await invoke("widget_resize", { w: s.w, h: s.h });
  } catch {}
  // The saved point was made at the other size and may now hang off the
  // screen edge — re-clamp it against the new footprint.
  applyPosition();
}

// Collapse to the icon while the user is in another application; focus on
// this card or on the main window brings the full player back. The settle
// delay keeps a click on the icon from collapsing it as soon as it expands.
let appFocused = true;
let selfFocused = document.hasFocus();
let settle = 0;
function syncMode() {
  clearTimeout(settle);
  settle = setTimeout(() => setMini(!appFocused && !selfFocused), 250);
}
function markSelf(focused) {
  selfFocused = focused;
  syncMode();
}
listen("app:focus", ({ payload }) => {
  appFocused = !!payload;
  // Focus back on the app also releases the pass-through pin: with clicks
  // ignored the pin button itself would be unreachable.
  if (appFocused && pinned) setPinned(false);
  syncMode();
});
win?.onFocusChanged?.((f) => markSelf(f));
window.addEventListener("focus", () => markSelf(true));
window.addEventListener("blur", () => markSelf(false));

// Pin: clicks pass through to whatever is underneath. The card sits above
// every window, so this is how it stops stealing clicks; releasing happens
// in the app:focus handler above (once ignored, the button can't be hit).
let pinned = false;
async function setPinned(on) {
  if (pinned === on) return;
  pinned = on;
  setText("wg-pinicon", on ? "keep" : "keep_off");
  el("wg-pin")?.classList.toggle("is-on", on);
  try {
    if (invoke) await invoke("set_widget_click_through", { enabled: on });
  } catch {}
}

function wireControls() {
  el("wg-play")?.addEventListener("click", () => cmd("play"));
  el("wg-prev")?.addEventListener("click", () => cmd("prev"));
  el("wg-next")?.addEventListener("click", () => cmd("next"));
  el("wg-nextup")?.addEventListener("click", () => cmd("next"));
  el("wg-dl")?.addEventListener("click", () => cmd("download"));
  el("wg-fav")?.addEventListener("click", () => cmd("fav"));
  el("wg-repeat")?.addEventListener("click", () => cmd("repeat"));
  el("wg-mute")?.addEventListener("click", () => cmd("mute"));
  el("wg-pin")?.addEventListener("click", () => setPinned(!pinned));

  el("wg-seek")?.addEventListener("click", (e) =>
    cmd("seek", ratioFrom(e.currentTarget, e.clientX)),
  );
  el("wg-voltrack")?.addEventListener("click", (e) =>
    cmd("volume", ratioFrom(e.currentTarget, e.clientX)),
  );

  el("wg-close")?.addEventListener("click", async () => {
    // The X turns the widget off for good, exactly like the Settings switch.
    try {
      localStorage.setItem(OFF_KEY, "0");
    } catch {}
    try {
      await invoke("widget_show", { show: false, embed: false });
    } catch {}
  });

  // Drag from anywhere that is not a control — the icon included, behind a
  // movement threshold so a plain click still expands it.
  let dragging = false;
  let moved = false;
  let start = null;
  function beginDrag() {
    dragging = true;
    try {
      invoke("widget_start_drag");
    } catch {}
    // The OS drag loop swallows the mouseup, so flush the position a moment
    // after the release as well as on any mouseup that does reach us.
    setTimeout(savePosition, 900);
    setTimeout(savePosition, 2400);
  }
  card.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("#wg-mini")) {
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.target.closest("button, a, .tm-widget__seek, .tm-widget__voltrack")) return;
    beginDrag();
  });
  window.addEventListener("mousemove", (e) => {
    if (!start || dragging) return;
    if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 4) {
      moved = true;
      beginDrag();
    }
  });
  window.addEventListener("mouseup", () => {
    start = null;
    if (!dragging) return;
    dragging = false;
    savePosition();
  });
  el("wg-mini")?.addEventListener("click", () => {
    if (!moved) setMini(false);
  });
}

render({
  hasTrack: false,
  live: false,
  paused: true,
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: "off",
  quality: "",
  image: "",
  next: null,
});
paintMode();
wireControls();
applyPosition();

listen("player:state", ({ payload }) => render(payload || {}));
listen("widget:reset", () => {
  try {
    localStorage.removeItem(POS_KEY);
  } catch {}
  placeDefault();
});

fire("widget:ready", null);
// The main window may still be booting when this one paints; asking twice more
// costs nothing and guarantees the card is never left on its empty state.
setTimeout(() => fire("widget:ready", null), 600);
setTimeout(() => fire("widget:ready", null), 2400);
