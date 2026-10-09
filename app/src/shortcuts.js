// shortcuts.js — global shortcut events from the Rust side (Caps Lock Hyper
// or the Ctrl+Alt fallback), the media keys and the tray menu buttons.
// Rust emits, this window performs: the same event names work for both.
import { diag, invoke, showView, toast } from "./core.js";
import { $ } from "./dom.js";
import { toggleFavTrack } from "./library.js";
import { toggleNotepad } from "./notepad.js";
import { queue, queueIndex, restoredTrack } from "./queue.js";
import { localRole } from "./room.js";
import { creditsBtn, step, togglePlay } from "./transport.js";
import { widgetMode } from "./settings.js";
import { downloadTrack } from "./vault.js";

/// A Jam guest's transport is the host's (§12): the UI locks its buttons, but
/// the global media keys and the Ctrl+Arrow chords would bypass that lock and
/// desync the room — they get the same stated reason instead.
function guestLockNote() {
  if (localRole() !== "guest") return false;
  toast("The host controls playback in this room.", "info", 3000);
  return true;
}

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
  "shortcut:play": () => {
    if (guestLockNote()) return;
    togglePlay();
  },
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
  // The panel's only entry point (docs/notepad/features.md) — toggleNotepad
  // opens or closes it; nothing else in the app can reach the panel.
  "shortcut:notepad": () => toggleNotepad(),
  "media-play-pause": () => {
    if (guestLockNote()) return;
    togglePlay();
  },
  "media-next": () => {
    if (guestLockNote()) return;
    step(1);
  },
  "media-prev": () => {
    if (guestLockNote()) return;
    step(-1);
  },
};

// ---------------------------------------------------- in-app shortcuts -
// The Caps Hyper chords above are global (they fire when another window has
// focus); these five need only this window: Space plays/pauses, Ctrl + arrows
// step the queue, Ctrl + D downloads and L likes the current track. Typing
// is never hijacked — keydowns in fields, editable regions or an open
// <dialog> are left alone, and held keys (auto-repeat) don't re-fire.
function typingTarget(e) {
  const t = e.target;
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")
  );
}

function currentTrack() {
  return queue[queueIndex]?.track ?? restoredTrack;
}

function wireInAppKeys() {
  window.addEventListener("keydown", (e) => {
    // defaultPrevented: scoped handlers (search rows, the hero) already
    // claimed this key — Space would otherwise fire twice.
    if (e.repeat || e.defaultPrevented || document.querySelector("dialog[open]")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (ctrl && !e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      if (typingTarget(e)) return;
      e.preventDefault();
      if (guestLockNote()) return;
      step(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (ctrl && !e.altKey && e.key.toLowerCase() === "d") {
      if (typingTarget(e)) return;
      e.preventDefault();
      const t = currentTrack();
      if (t) downloadTrack(t, null);
      return;
    }
    if (!plain || typingTarget(e)) return;
    if (e.key === " ") {
      // Space on a focused button/link is that element's own activation —
      // only a neutral focus target means "toggle playback".
      if (e.target instanceof HTMLElement && e.target.closest("button, a, summary, label")) return;
      e.preventDefault();
      if (guestLockNote()) return;
      togglePlay();
    } else if (e.key.toLowerCase() === "l") {
      const t = currentTrack();
      if (t) toggleFavTrack(t);
      else toast("Nothing is playing yet — start a track first.", "info");
    }
  });
}

export function wireShortcuts() {
  wireInAppKeys();
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
