// smart.js — DOM-free auto-playlist rules: rank recent plays, diff hearts
// against the vault. Zero imports on purpose (fuzzy.js / quota.js pattern):
// node tests import this directly, and library.js builds its synthetic cards
// on top without a cycle.

/// Lookback for "Top played": plays older than this never rank.
export const SMART_WINDOW_MS = 30 * 24 * 3600 * 1000;
/// Card size cap — the plays log itself is capped at 100 (library.js).
export const SMART_TOP_N = 50;

/// Most-played inside the window, most starts first, newest breaks ties.
/// `plays` rows carry `{ id, count, ts }` (see pushPlay in library.js).
/// Never mutates the input.
export function topPlayedTracks(
  plays,
  nowMs = Date.now(),
  windowMs = SMART_WINDOW_MS,
  n = SMART_TOP_N,
) {
  const from = nowMs - windowMs;
  return (plays || [])
    .filter((t) => t && t.id && Number(t.ts || 0) >= from)
    .sort(
      (a, b) =>
        Number(b.count || 0) - Number(a.count || 0) ||
        Number(b.ts || 0) - Number(a.ts || 0),
    )
    .slice(0, Math.max(0, n));
}

/// Hearts with no vault copy yet. `savedIds` is any iterable of vaulted ids.
export function favsNotSaved(favs, savedIds) {
  const saved = savedIds instanceof Set ? savedIds : new Set(savedIds || []);
  return (favs || []).filter((t) => t && t.id && !saved.has(t.id));
}
