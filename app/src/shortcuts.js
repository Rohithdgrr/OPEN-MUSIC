// shortcuts.js — global shortcut events from the Rust side (Caps Lock Hyper
// or the Ctrl+Alt fallback), the media keys and the tray menu buttons.
// Rust emits, this window performs: the same event names work for both.
import { diag, invoke, showView } from "./core.js";
import { $ } from "./dom.js";
import { queue, queueIndex, restoredTrack } from "./queue.js";
import { creditsBtn, step, togglePlay } from "./transport.js";
import { widgetMode } from "./settings.js";
import { downloadTrack } from "./vault.js";

// ponytail: a per-event 300ms cooldown instead of an AbortController —
// the events arrive from Rust with no request to abort; a key-repeat
// flood only needs a latch.
const last = new Map();
function armed(event) {
  const now = Date.now();
  if (now - (last.get(event) || 0) < 300) return false;
  last.set(event, now);
  return true;
}

const ACTIONS = {
  "shortcut:play": () => togglePlay(),
  "shortcut:search": () => {
    showView("search");
    ($("#search-input") || $("#nav-search-input"))?.focus();
  },
  "shortcut:now-playing": () => showView("now-playing"),
  "shortcut:widget": async () => {
    try {
      const on = await invoke("toggle_widget", { embed: widgetMode() === "desktop" });
      // Keep the boot preference in step so the card's new state survives restart.
      try {
        localStorage.setItem("tm-desk-widget", on ? "1" : "0");
      } catch {}
    } catch (err) {
      diag("widget", false, String(err));
    }
  },
  "shortcut:download": () => downloadTrack(queue[queueIndex]?.track ?? restoredTrack, null),
  "shortcut:info": () => creditsBtn?.click(),
  "media-play-pause": () => togglePlay(),
  "media-next": () => step(1),
  "media-prev": () => step(-1),
};

export function wireShortcuts() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  for (const [event, run] of Object.entries(ACTIONS)) {
    listen(event, () => {
      if (!armed(event)) return;
      try {
        const p = run();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (err) {
        diag("shortcut", false, String(err));
      }
    });
  }
  listen("shortcut:conflict", ({ payload }) =>
    diag("shortcut", false, `key already taken by another app: ${payload}`),
  );
}
