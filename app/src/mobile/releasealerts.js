// releasealerts.js — followed-artist release watcher (docs/mobile/11).
//
// Once per 12 h (and on app resume when due) it diffs each followed artist's
// latest/singles/albums — the same `artist_overview` source the Home
// "New from artists you follow" shelf uses — against a persisted seen-set.
// Genuinely new items land twice: as `release` events in the in-app
// Notifications feed (pushEvent → EVENTS_KEY) and as a real Android system
// notification through TMNative.notify → MediaHub's tm_alerts channel.
// The first run only seeds the baseline silently — otherwise every catalog
// item would alert at once.
import { invoke, load, save, loadFollows, pushEvent } from "./shared.js";

const SEEN_KEY = "tm-rel-seen";
const CHECK_KEY = "tm-rel-check";
const CHECK_MS = 12 * 3600e3;
const MAX_FOLLOWS = 6;
const MAX_ALERTS = 3;
const SEEN_MAX = 300;

function loadSeen() {
  const list = load(SEEN_KEY, []);
  return Array.isArray(list) ? list.map(String) : [];
}

async function artistItems(follow) {
  const ov = await invoke("artist_overview", { token: String(follow.id) });
  const out = [];
  const seenKeys = new Set();
  const rows = []
    .concat(ov && ov.latest ? ov.latest : [])
    .concat(ov && ov.singles ? ov.singles : [])
    .concat(ov && ov.top_albums ? ov.top_albums : [])
    .concat(ov && ov.albums ? ov.albums : []);
  for (const it of rows) {
    if (!it) continue;
    const title = String(it.title || it.name || "").trim();
    if (!title) continue;
    const key = `${follow.id}:${it.id || it.album_id || title}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      key,
      title,
      artist: String(follow.title || ""),
      image: it.image || "",
      year: it.year || it.release_year || "",
    });
  }
  return out;
}

async function check() {
  if (!invoke) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const follows = loadFollows().slice(0, MAX_FOLLOWS);
  if (!follows.length) return;
  const seen = new Set(loadSeen());
  const firstRun = seen.size === 0;
  const fresh = [];
  for (const f of follows) {
    try {
      for (const it of await artistItems(f)) {
        if (!seen.has(it.key)) {
          seen.add(it.key);
          fresh.push(it);
        }
      }
    } catch {}
  }
  save(SEEN_KEY, [...seen].slice(-SEEN_MAX));
  if (firstRun || !fresh.length) return;
  const notify = (() => {
    try {
      return window.TMNative && typeof window.TMNative.notify === "function"
        ? window.TMNative.notify.bind(window.TMNative)
        : null;
    } catch {
      return null;
    }
  })();
  for (const it of fresh.slice(0, MAX_ALERTS)) {
    const who = it.artist || "An artist you follow";
    const meta = [it.artist, it.year].filter(Boolean).join(" · ");
    pushEvent("release", `New from ${who}: ${it.title}`, meta || "A followed artist just released this.");
    if (notify) {
      try {
        notify(`New from ${who}`, `${it.title}${meta ? ` — ${meta}` : ""}`);
      } catch {}
    }
  }
}

async function run() {
  const last = Number(load(CHECK_KEY, 0)) || 0;
  if (Date.now() - last < CHECK_MS) return;
  save(CHECK_KEY, Date.now());
  await check();
}

// Boot check once the shell has settled, then re-check whenever the app
// returns to the foreground past the 12 h interval.
setTimeout(() => {
  run().catch(() => {});
}, 20000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") run().catch(() => {});
});
