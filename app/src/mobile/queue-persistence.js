// queue-persistence.js — pure helpers for saving/restoring the mobile queue.
// No browser globals on purpose: player.js wires the real localStorage/store.db.

export const QUEUE_KEY = "tm-queue";
export const QUEUE_CAP = 200;

/// The exact shape persistQueue writes (mirror of desktop queue.js).
export function queueSnapshot(queue, index, shuffle = false, repeat = 0) {
  const list = (queue || []).filter((t) => t && t.id);
  return {
    i: Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0,
    shuffle: shuffle === true,
    repeat: repeat === 1 || repeat === "all" ? "all" : repeat === 2 || repeat === "one" ? "one" : "off",
    q: list.slice(0, QUEUE_CAP),
  };
}

/// Read a stored snapshot back into `{ q, i, shuffle, repeat }`.
/// Returns null when the payload is missing, malformed or empty.
export function parseQueueSnapshot(raw) {
  let saved;
  try {
    saved = raw == null || typeof raw !== "string" ? raw : JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved || !Array.isArray(saved.q)) return null;
  const q = saved.q.filter((t) => t && typeof t.id === "string" && t.id);
  if (!q.length) return null;
  return {
    q,
    i: Math.min(Math.max(Number(saved.i) || 0, 0), q.length - 1),
    shuffle: saved.shuffle === true,
    repeat: saved.repeat === "one" ? "one" : saved.repeat === "all" ? "all" : "off",
  };
}

/// true iff the value is a snapshot worth seeding at boot.
export function hasRestorableQueue(raw) {
  return parseQueueSnapshot(raw) !== null;
}
