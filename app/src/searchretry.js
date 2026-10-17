// searchretry.js — the search auto-retry ladder, DOM-free so it is unit-tested
// like every other pure rule (quota.js / spotmatch.js / smart.js follow the
// same shape). Read by search.js; the why lives in docs/search-resilience.md.
//
// Ladder: the wait after failure 1..4; failure 5+ gives up and leaves the
// card up (manual Retry restarts the ladder). Bounded and polite — this heals
// transient windows, it is not a poller.
export const SEARCH_RETRY_MS = [1500, 4000, 15000, 45000];

/// Delay in ms before the attempt that follows `retry` failures (0 = the
/// first failure), or null when a retry cannot help: ladder exhausted, bad
/// input, or offline — offline recovery is the `online` event's job
/// (search.js) so no timers are burned on a dead link.
export function nextRetryDelay(retry, { offline = false } = {}) {
  if (offline) return null;
  const n = Number(retry);
  if (!Number.isInteger(n) || n < 0 || n >= SEARCH_RETRY_MS.length) return null;
  return SEARCH_RETRY_MS[n];
}
