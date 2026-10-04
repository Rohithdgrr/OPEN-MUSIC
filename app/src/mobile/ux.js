// ux.js — Spotify-feel interaction layer for the mobile shell.
//
// Everything here is delegated + self-attaching (imported once by app.js),
// so no screen, router or menu code changes:
//  1. swipe between Home / Search / Library tabs (ignores nested carousels)
//  2. swipe-down to dismiss the queue sheet
//  3. drag-to-reorder inside the queue sheet (uses ov._render from menus.js)
//  4. mini-player artwork tap = play/pause, long-press = track menu
//  5. shared-element zoom when artwork navigates to Now Playing / detail
//  6. screen slide transitions on hash navigation
//  7. offline-dot post-pass on track rows + queue rows (isVaulted)
import { playerState, moveQueue, toggle } from "./player.js";
import { isVaulted, haptic } from "./shared.js";
import { trackMenu } from "./menus.js";

const TABS = ["home", "search", "library"];

function routeKey() {
  try {
    const raw = location.hash.replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    return (qi >= 0 ? raw.slice(0, qi) : raw).toLowerCase() || "home";
  } catch {
    return "home";
  }
}

/* ------------------------------------------------ style (injected once) */
let styled = false;
function ensureStyle() {
  if (styled || !document.head) return;
  styled = true;
  const s = document.createElement("style");
  s.setAttribute("data-tm-ux", "1");
  s.textContent = `
#screen.tm-ux-slide-l{animation:tmUxL .22s ease}
#screen.tm-ux-slide-r{animation:tmUxR .22s ease}
@keyframes tmUxL{from{opacity:.4;transform:translateX(26px)}to{opacity:1;transform:none}}
@keyframes tmUxR{from{opacity:.4;transform:translateX(-26px)}to{opacity:1;transform:none}}
.tm-ux-zoom{position:fixed;z-index:200;pointer-events:none;object-fit:cover;border-radius:12px;transition:all .26s cubic-bezier(.32,.72,.35,1)}
.tm-ux-qdrag{opacity:.92;box-shadow:0 12px 32px rgba(0,0,0,.22);position:relative;z-index:5;background:var(--tm-drag-bg,#fff)}
@media (prefers-reduced-motion:reduce){#screen.tm-ux-slide-l,#screen.tm-ux-slide-r{animation:none}.tm-ux-zoom{transition:none}}
.tm-ux-fs-lyrics{position:fixed!important;inset:0!important;z-index:90!important;max-height:none!important;height:100dvh!important;border-radius:0!important;overflow-y:auto!important;background:var(--tm-sheet-bg,#fff)}`;
  document.head.appendChild(s);
}

/* --------------------------------------- screen slide transitions */
let lastRoute = "";
function armTransitions() {
  try {
    lastRoute = routeKey();
  } catch {}
  window.addEventListener("hashchange", () => {
    try {
      const next = routeKey();
      const a = TABS.indexOf(lastRoute);
      const b = TABS.indexOf(next);
      lastRoute = next;
      const scr = document.getElementById("screen");
      if (!scr) return;
      const cls = a >= 0 && b >= 0 && a !== b ? (b > a ? "tm-ux-slide-l" : "tm-ux-slide-r") : "tm-ux-slide-l";
      scr.classList.remove("tm-ux-slide-l", "tm-ux-slide-r");
      void scr.offsetWidth; // restart the animation
      scr.classList.add(cls);
      setTimeout(() => scr.classList.remove(cls), 260);
    } catch {}
  });
}

/* --------------------------------------------- tab swipe (1) */
function scrollsX(el) {
  let n = el;
  for (let i = 0; i < 6 && n && n !== document.body; i += 1, n = n.parentElement) {
    try {
      if (n.scrollWidth > n.clientWidth + 8) return true;
    } catch {}
  }
  return false;
}

function armTabSwipe() {
  let x0 = 0;
  let y0 = 0;
  let tracking = false;
  const scr = () => document.getElementById("screen");
  document.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches && e.touches[0];
      const s = scr();
      if (!t || !s || !s.contains(e.target)) {
        tracking = false;
        return;
      }
      // Sheets, sliders and the player own their own gestures.
      if (e.target.closest("#tm-queue-sheet, [data-w-seek], input, textarea, [data-lyrics]")) {
        tracking = false;
        return;
      }
      x0 = t.clientX;
      y0 = t.clientY;
      tracking = true;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      if (scrollsX(e.target)) return; // carousel did its own thing
      const i = TABS.indexOf(routeKey());
      if (i < 0) return;
      const n = dx < 0 ? i + 1 : i - 1;
      if (n < 0 || n >= TABS.length) return;
      try {
        haptic(12);
      } catch {}
      location.hash = "#/" + TABS[n];
    },
    { passive: true },
  );
}

/* ------------------------------- queue sheet: swipe-down + drag (2, 3) */
function queueApi() {
  try {
    const st = playerState();
    return { queue: Array.isArray(st.queue) ? st.queue : [], qi: st.qi | 0 };
  } catch {
    return { queue: [], qi: 0 };
  }
}

function armQueueGestures() {
  let drag = null; // {row, abs, y0, active}
  let panelY0 = 0;
  let panelTracking = false;

  document.addEventListener(
    "touchstart",
    (e) => {
      const sheet = e.target && e.target.closest ? e.target.closest("#tm-queue-sheet") : null;
      if (!sheet) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      const panel = sheet.querySelector("[data-q-panel]");
      if (panel && (e.target === panel || e.target.closest("[data-q-tabs], h3"))) {
        panelTracking = true;
        panelY0 = t.clientY;
      }
      const row = e.target.closest ? e.target.closest("[data-q-row]") : null;
      if (row && !e.target.closest("button")) {
        drag = { row, abs: Number(row.dataset.qRow), y0: t.clientY, active: false, moved: 0 };
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (drag && !drag.active) {
        const dy = t.clientY - drag.y0;
        drag.moved = dy;
        if (Math.abs(dy) > 14) {
          drag.active = true;
          drag.row.classList.add("tm-ux-qdrag");
          try {
            haptic(8);
          } catch {}
        }
      }
      if (drag && drag.active) {
        drag.row.style.transform = `translateY(${drag.moved}px)`;
        const rows = [...document.querySelectorAll("#tm-queue-sheet [data-q-row]")];
        for (const r of rows) {
          if (r === drag.row) continue;
          try {
            const rb = r.getBoundingClientRect();
            const db = drag.row.getBoundingClientRect();
            const overlap = db.top < rb.bottom - 8 && db.bottom > rb.top + 8;
            r.style.transform = overlap ? `translateY(${drag.moved > 0 ? -44 : 44}px)` : "";
          } catch {}
        }
      }
    },
    { passive: true },
  );

  document.addEventListener("touchend", (e) => {
    // Sheet swipe-down to dismiss.
    if (panelTracking) {
      panelTracking = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (t && t.clientY - panelY0 > 110) {
        const sheet = document.getElementById("tm-queue-sheet");
        if (sheet) sheet.remove();
        return;
      }
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    const wasDrag = d.active;
    d.row.classList.remove("tm-ux-qdrag");
    d.row.style.transform = "";
    document.querySelectorAll("#tm-queue-sheet [data-q-row]").forEach((r) => {
      r.style.transform = "";
    });
    if (!wasDrag) {
      // Plain tap on the row body = jump to that track (same as its play btn).
      try {
        const btn = d.row.querySelector("[data-q-play]");
        if (btn) btn.click();
      } catch {}
      return;
    }
    // Drop position → absolute queue index.
    try {
      const rows = [...document.querySelectorAll("#tm-queue-sheet [data-q-row]")];
      const { qi } = queueApi();
      const midY = d.row.getBoundingClientRect().top + d.row.getBoundingClientRect().height / 2 + d.moved;
      let target = null;
      for (const r of rows) {
        if (r === d.row) continue;
        const rb = r.getBoundingClientRect();
        if (midY >= rb.top && midY <= rb.bottom) {
          target = Number(r.dataset.qRow);
          break;
        }
      }
      if (target == null) {
        // Dropped past the ends: clamp to the visible edge of Up Next.
        const abs = rows.map((r) => Number(r.dataset.qRow)).filter(Number.isInteger);
        if (abs.length) target = d.moved > 0 ? Math.max(...abs) : Math.min(...abs);
      }
      if (Number.isInteger(target) && target !== d.abs && target > qi) {
        if (moveQueue(d.abs, target)) {
          try {
            haptic(15);
          } catch {}
          const sheet = document.getElementById("tm-queue-sheet");
          if (sheet && typeof sheet._render === "function") sheet._render();
        }
      }
    } catch {}
  });
}

/* ---------------------- mini artwork tap / long-press (4) + zoom (5) */
function currentTrack() {
  try {
    return playerState().track || null;
  } catch {
    return null;
  }
}

function zoomTo(route) {
  // Shared-element feel: clone the tapped artwork, fly it up full-screen,
  // navigate underneath, fade the clone out. Pure overlay — if anything
  // fails the navigation underneath already happened.
  try {
    const img = document.querySelector("#tm-widget #tm-w-art");
    if (!img || !img.src) {
      location.hash = "#/" + route;
      return;
    }
    const r = img.getBoundingClientRect();
    const ghost = img.cloneNode();
    ghost.className = "tm-ux-zoom";
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.left = "0px";
      ghost.style.top = "0px";
      ghost.style.width = "100vw";
      ghost.style.height = "100vh";
      ghost.style.borderRadius = "0";
      ghost.style.opacity = "0.25";
    });
    location.hash = "#/" + route;
    setTimeout(() => ghost.remove(), 300);
  } catch {
    try {
      location.hash = "#/" + route;
    } catch {}
  }
}

function armMiniArt() {
  let press = null; // {x, y, t, timer, fired}
  document.addEventListener(
    "pointerdown",
    (e) => {
      const box = e.target && e.target.closest ? e.target.closest("#tm-widget [data-w-open]") : null;
      if (!box || !box.querySelector("#tm-w-art")) return; // text block keeps app delegation
      press = { x: e.clientX, y: e.clientY, fired: false, box };
      press.timer = setTimeout(() => {
        if (!press) return;
        press.fired = true;
        const tr = currentTrack();
        if (tr) {
          try {
            haptic(15);
          } catch {}
          trackMenu(tr, null);
        }
      }, 480);
    },
    { capture: true },
  );
  const cancel = () => {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
  };
  document.addEventListener("pointermove", (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) cancel();
  });
  document.addEventListener("pointerup", (e) => {
    if (!press) return;
    const wasPress = press;
    cancel();
    if (wasPress.fired) return;
    // Artwork tap = play/pause in place. Mark it so the capture-phase click
    // guard below swallows the click before app delegation opens NowPlaying
    // (suppressing pointerup cannot stop the click event itself).
    if (e.target.closest && e.target.closest("#tm-widget [data-w-open]")) {
      suppressClickUntil = Date.now() + 600;
      try {
        haptic(10);
      } catch {}
      toggle();
    }
  });
  document.addEventListener("pointercancel", cancel);
  // Long-press elsewhere on rows already opens menus (app.js) — untouched.
}

let suppressClickUntil = 0;

/* --------------------------------- offline-dot post-pass (7) */
let badgeQueued = false;
function paintOfflineDots() {
  if (badgeQueued) return;
  badgeQueued = true;
  setTimeout(() => {
    badgeQueued = false;
    try {
      // Track rows: fav icons carry the track id.
      document.querySelectorAll("#screen [data-fav-icon]").forEach((el) => {
        const id = el.dataset.favIcon;
        if (!id || el.parentElement.querySelector(":scope > [data-tm-offdot]")) return;
        let vaulted = false;
        try {
          vaulted = isVaulted(id);
        } catch {}
        if (!vaulted) return;
        const dot = document.createElement("span");
        dot.setAttribute("data-tm-offdot", "1");
        dot.title = "Downloaded";
        dot.className = "w-3.5 h-3.5 rounded-full bg-emerald-500 ring-2 ring-surface-container-lowest flex-shrink-0";
        el.parentElement.appendChild(dot);
      });
      // Queue sheet rows: index into the live queue.
      const { queue } = queueApi();
      document.querySelectorAll("#tm-queue-sheet [data-q-row]").forEach((row) => {
        if (row.querySelector("[data-tm-offdot]")) return;
        const t = queue[Number(row.dataset.qRow)];
        let vaulted = false;
        try {
          vaulted = t && isVaulted(t.id);
        } catch {}
        if (!vaulted) return;
        const cell = row.querySelector("div");
        if (!cell) return;
        const dot = document.createElement("span");
        dot.setAttribute("data-tm-offdot", "1");
        dot.title = "Downloaded";
        dot.className = "w-3 h-3 rounded-full bg-emerald-500 flex-shrink-0 ml-1";
        cell.appendChild(dot);
      });
    } catch {}
  }, 350);
}

function armBadges() {
  document.addEventListener("smount", () => paintOfflineDots());
  try {
    const mo = new MutationObserver(() => paintOfflineDots());
    mo.observe(document.body, { childList: true, subtree: true });
  } catch {}
}

/* ------------------------------------------------------------ boot */
ensureStyle();
armTransitions();
armTabSwipe();
armQueueGestures();
armMiniArt();
armBadges();

// Tap on the mini-player TEXT block zooms into Now Playing (artwork tap
// toggles instead — see armMiniArt). Capture phase beats app delegation.
document.addEventListener(
  "click",
  (e) => {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const box = e.target && e.target.closest ? e.target.closest("#tm-widget [data-w-open]") : null;
    if (!box || box.querySelector("#tm-w-art")) return;
    e.stopPropagation();
    e.preventDefault();
    zoomTo("nowplaying");
  },
  { capture: true },
);
