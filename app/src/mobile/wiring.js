// wiring.js — boot wiring for queue persistence (visibility + pagehide) +
// last-session restore. Called from app.js at boot; no wiring elsewhere.
// Desktop does the same on a timer (queue.js restoreQueue()); mobile only
// had a localStorage debounce and never restored.
import { restoreQueue, flushQueue } from "./player.js";

let wired = false;
export function wireQueuePersistence() {
  if (wired) return;
  wired = true;
  if (typeof document === "undefined" || !document.addEventListener) return;
  const save = () => {
    try {
      flushQueue();
    } catch {}
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("pagehide", save);
  }
}

/// Bring back the last session's queue without auto-playing it (desktop
/// main.js' restoreQueue()). Silent when nothing was saved.
export function restoreLastSession() {
  try {
    restoreQueue();
  } catch {}
}
