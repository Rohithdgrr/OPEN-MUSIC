// quota.js — vault quota + LRU eviction math for the Android shell.
//
// Port of desktop vault.js:410-467, kept as a pure module (no window, no
// localStorage, no invoke) so the eviction order can be unit-tested in node —
// the same pattern as room.js/rank.js. shared.js supplies the persisted GB
// value, the plays ledger and the `remove_download` calls.

const GB = 1024 * 1024 * 1024;

/// `tm-vault-quota` stores GB as a raw string; 0 / unset / junk = unlimited.
export function quotaBytesFromGb(gb) {
  const n = Number(gb);
  return Number.isFinite(n) && n > 0 ? n * GB : 0;
}

/// Least-recently-played first (plays ledger, most-recent entry per id),
/// oldest-added (`at`) as the tie-break — identical ordering to desktop
/// `vault.js:440-443`. Never evicts the track playing now or a download in
/// flight. Returns the entries to remove, biggest-picture first: keep taking
/// victims until the vault is back under `capBytes`.
export function pickEvictVictims(entries, played, capBytes, currentId, activeIds) {
  if (!capBytes || !Array.isArray(entries) || entries.length === 0) return [];
  let total = entries.reduce((n, e) => n + (Number(e && e.bytes) || 0), 0);
  if (total <= capBytes) return [];
  const active = new Set(activeIds || []);
  const victims = entries
    .filter((e) => e && e.id !== currentId && !active.has(e.id))
    .map((e) => ({ e, t: (played && played.get(e.id)) || Number(e.at) || 0 }))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const { e } of victims) {
    if (total <= capBytes) break;
    out.push(e);
    total -= Number(e.bytes) || 0;
  }
  return out;
}
