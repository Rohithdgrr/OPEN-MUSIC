// artresolve.js — upstream artist art + token resolution for mined artist
// tiles. Pure module (zero imports, injectable invoke) so it stays
// unit-testable and off the mobile import-graph rules: the caller (binders)
// paints the instant local tiles first, then hydrates them as real catalog
// entities resolve.
//
// Why: `artistInsights` mines the artist's most-played TRACK cover as the
// tile image — an album poster, never the artist photo (user bug report,
// 2026-10-24). The catalog's own artist entity carries the real avatar +
// a token for direct navigation. Exact-match discipline: a blind `items[0]`
// is how an artist tile shows somebody else's face.
//
// Cache: `tm-artist-art-v1` (name → {image, token, at}), LRU-ish capped, so
// after one pass every later mount paints correct art instantly.

const CACHE_KEY = "tm-artist-art-v1";
const CACHE_VERSION = "v1";
const CACHE_LIMIT = 500;
const ENTITY_LIMIT = 4;
const POOL = 4;

/// Case-fold + tolerant comparison: same string the caller uses for names.
/// Dots are folded to spaces so `M.M. Keeravani` matches the catalog's
/// `M. M. Keeravani` — initial-form spacing is how real names drift.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/// Entities without a real avatar ship this generic icon; matching one would
/// REPLACE a song cover with a placeholder — worse than no match.
const PLACEHOLDER_ART = /artist-default/;

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    if (raw && raw.v === CACHE_VERSION && raw.map && typeof raw.map === "object") return raw;
  } catch {}
  return { v: CACHE_VERSION, map: {} };
}

function writeCache(store) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {}
  // Quota errors are ignored: resolution still works this session.
}

export function cachedArtistArt(name) {
  const n = norm(name);
  if (!n) return null;
  const hit = readCache().map[n];
  if (!hit || typeof hit !== "object") return null;
  return { image: String(hit.image || ""), token: String(hit.token || "") };
}

/// Which entity answers for this artist name. Exact (case-folded) first,
/// then a name-prefixed entity ("Pritam" → "Pritam Chakraborty"). Never
/// items[0] blind — that is the "some other thumbnail" bug class.
export function matchArtist(name, items) {
  const n = norm(name);
  if (!n || !Array.isArray(items)) return null;
  const ranked = items
    .filter(Boolean)
    .filter((e) => e.token || e.id)
    .filter((e) => {
      const im = str(e.image);
      return im && !PLACEHOLDER_ART.test(im);
    });
  for (const e of ranked) {
    if (norm(e.title) === n) return e;
  }
  for (const e of ranked) {
    const t = norm(e.title);
    if (t.startsWith(n + " ") || t.startsWith(n + "(") || t.startsWith(n + "-")) return e;
  }
  return null;
}

function str(s) {
  return typeof s === "string" ? s.trim() : "";
}

function remember(name, image, token) {
  const store = readCache();
  const n = norm(name);
  if (!n || (!image && !token)) return;
  store.map[n] = { image: String(image || ""), token: String(token || ""), at: Date.now() };
  // Soft cap: drop the oldest cached entries when the map outgrows itself.
  const keys = Object.keys(store.map);
  if (keys.length > CACHE_LIMIT) {
    const rows = keys
      .map((k) => [k, store.map[k]])
      .sort((x, y) => (Number(x[1] && x[1].at) || 0) - (Number(y[1] && y[1].at) || 0));
    while (keys.length > CACHE_LIMIT && rows.length) {
      const [dead] = rows.shift();
      delete store.map[dead];
    }
  }
  writeCache(store);
}

/// Resolve one artist through the caller's invoke. Resolves to a joined
/// {image, token} or null (miss / no backend / upstream error — never
/// cached as a hit, so a flaky window retries next mount).
async function resolveOne(name, doInvoke) {
  if (!doInvoke || !name) return null;
  try {
    const r = await doInvoke("search_entities", { query: name, kind: "artist", limit: ENTITY_LIMIT, page: 1 });
    const hit = matchArtist(name, (r && r.items) || []);
    if (!hit) return null;
    return { image: str(hit.image), token: String(hit.token || hit.id || "") };
  } catch {
    return null;
  }
}

/// Hydrate a list of mined artist cards in place. Only cards whose provenance
/// is "track" (cover stand-in) or "" (nothing at all) are queried — follows
/// already carry real catalog art. Applies cached hits synchronously, then
/// clears the upstream pool (4 concurrent calls) and resolves when every
/// pending name either landed or honestly missed. The caller re-renders
/// through `onEach` as hits stream in.
/// Returns the number of artists that landed a cache-or-remote image hit.
export async function hydrateArtistArt(list, doInvoke, onEach) {
  const cards = (Array.isArray(list) ? list : []).filter(
    (a) => a && a.name && typeof a === "object" && a.art !== "artist",
  );
  if (!cards.length || !doInvoke) return 0;

  let landed = 0;
  const apply = (a, hit) => {
    if (hit.image) a.image = hit.image;
    if (hit.token && !a.token) a.token = hit.token;
    if (hit.image) a.art = "artist"; // resolved to the real thing
    landed += hit.image ? 1 : 0;
    try {
      onEach && onEach(a);
    } catch {}
  };

  // 1) cache fills first — synchronous, zero upstream calls. A cached
  //    placeholder (pre-placeholder-filter screen? e.g. an old highlight)
  //    is treated as a miss: the upstream path replaces it with real art or
  //    honestly keeps the mined cover.
  const pending = [];
  for (const a of cards) {
    const hit = cachedArtistArt(a.name);
    if (hit && hit.image && PLACEHOLDER_ART.test(hit.image)) {
      // Purge the placeholder so the next paint cannot serve it back.
      try {
        const store = readCache();
        delete store.map[norm(a.name)];
        writeCache(store);
      } catch {}
      pending.push(a);
    } else if (hit && (hit.image || hit.token)) apply(a, hit);
    else pending.push(a);
  }

  // 2) upstream for the rest. A miss keeps today's art and is never cached,
  //    so a flaky window retries on the next mount.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= pending.length) return;
      const card = pending[i];
      const hit = await resolveOne(card.name, doInvoke);
      if (hit) {
        remember(card.name, hit.image, hit.token);
        apply(card, hit);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, pending.length) }, worker));

  return landed;
}
