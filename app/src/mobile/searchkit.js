// searchkit.js — pure search helpers for the mobile shell.
//
// No DOM at module scope, so `node --test` imports it directly the way fuzzy.js
// and query.js are tested. Everything the search screen needs that is *logic*
// (not markup) lives here: a small TTL/LRU cache, match highlighting, query
// understanding + relevance ranking, and the "top result + shelves" layout
// Spotify's search screen is built around.

import { fuzzyScore } from "../fuzzy.js";
import { esc } from "../html.js";
import { MOODS, matchesFilters, parseQuery, rankTracks as relevanceOrder } from "../query.js";
import { rankTracks as sortRows } from "./rank.js";

// ------------------------------------------------------------------- cache -
/// Map-backed LRU with an optional TTL. Reads re-insert the key, so `max`
/// always evicts the least recently *used* entry, and a cached `undefined` is
/// still a hit (values are wrapped, presence is tracked separately).
export function createLru({ max = 50, ttlMs = 0 } = {}) {
  const cap = Math.max(1, Number(max) || 1);
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const map = new Map();
  const fresh = (e) => !!e && (ttl === 0 || Date.now() - e.at < ttl);
  return {
    get size() {
      return map.size;
    },
    has(key) {
      return fresh(map.get(key));
    },
    /// Cached value, or undefined when missing/expired.
    get(key) {
      const e = map.get(key);
      if (!fresh(e)) {
        if (e) map.delete(key); // expired: reclaim the slot now
        return undefined;
      }
      map.delete(key);
      map.set(key, e); // touch → most recently used
      return e.value;
    },
    /// The wrapped entry ({ value, at }) so callers can judge staleness.
    peek(key) {
      const e = map.get(key);
      return fresh(e) ? e : undefined;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, at: Date.now() });
      while (map.size > cap) map.delete(map.keys().next().value);
      return value;
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}

// ------------------------------------------------------------ query parsing -
// parseQuery walks every token of the string; the search screen parses the same
// query on each repaint (ranking, tokens, labels), so the result is memoized.
const PARSE_MEM = createLru({ max: 40 });

/// Parsed query for `raw`, memoized. Never throws on junk input.
export function parseSearch(raw) {
  const key = String(raw == null ? "" : raw);
  const hit = PARSE_MEM.get(key);
  if (hit) return hit;
  return PARSE_MEM.set(key, parseQuery(key));
}

/// Human labels for the filters a query asked for, so the UI can say what it
/// understood instead of silently rewriting the search ("arijit singh hindi
/// 2022" → "Punjabi… Hindi / 2022").
export function understoodLabels(parsed) {
  if (!parsed) return [];
  const out = [];
  if (parsed.languages.length) out.push(parsed.languages.join(" / "));
  if (parsed.year) out.push(String(parsed.year));
  if (parsed.decade) out.push(`${parsed.decade}s`);
  if (parsed.yearRange) out.push(parsed.yearRange.join("–"));
  if (parsed.region) out.push(parsed.region);
  if (parsed.artist) out.push(`@${parsed.artist}`);
  if (parsed.album) out.push(`#${parsed.album}`);
  if (parsed.mood) out.push(`${parsed.mood} mood`);
  return out;
}

// ------------------------------------------------------------- highlighting -
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/// Bold-matched fragment. `bg-transparent` keeps the row's own text color, so
/// this works in both themes without a color token of its own.
const HL = 'class="bg-transparent font-bold"';

/// Tokens worth highlighting: the query text's own words (filters like a year
/// or language already left `parsed.text`), two chars and up, longest first so
/// a longer token wins the regex alternation.
export function queryTokens(parsed) {
  const toks = (parsed && parsed.tokens) || [];
  return [...new Set(toks.map((t) => String(t)).filter((t) => t.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
}

/// Escape `text` and wrap every occurrence of a token in a bold marker.
/// Matching happens on the raw string and escaping on the pieces, so a token
/// can never collide with an HTML entity ("amp" vs "&amp;").
export function highlight(text, tokens) {
  const src = String(text == null ? "" : text);
  const list = [...new Set((tokens || []).map((t) => String(t)).filter((t) => t.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  if (!list.length) return esc(src);
  const re = new RegExp(`(${list.map(escapeRe).join("|")})`, "gi");
  return src
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark ${HL}>${esc(part)}</mark>` : esc(part)))
    .join("");
}

// ---------------------------------------------------------------- ranking -
/// Mood keyword tables live in query.js (shared with the desktop parser); the
/// boost needs the same mapping, so derive it here instead of duplicating it.
export function moodOf(t) {
  const hay = `${(t && t.title) || ""} ${(t && t.album) || ""}`.toLowerCase();
  for (const [mood, words] of Object.entries(MOODS)) {
    if (words.some((w) => hay.includes(w))) return mood;
  }
  return "";
}

/// The text-score function query.js ranks with, bound to one parsed query.
export function textScoreFor(parsed) {
  const text = (parsed && parsed.text) || "";
  return (t) => fuzzyScore(text, t.title, t.artist, t.album);
}

/// Taste signals for the relevance boost, built once per search rather than
/// once per row: what was played, what was hearted, and how often each artist
/// shows up. Mirrors the desktop's tasteContext.
export function tasteContext(plays, favs, region = "") {
  const played = new Set();
  const artistPlays = new Map();
  for (const p of plays || []) {
    if (!p || !p.id) continue;
    played.add(String(p.id));
    if (p.artist) artistPlays.set(p.artist, (artistPlays.get(p.artist) || 0) + 1);
  }
  const liked = new Set();
  for (const f of favs || []) if (f && f.id) liked.add(String(f.id));
  return { played, liked, artistPlays, region, moodOf };
}

/// Order one page for the search screen.
///
/// A named sort (quality / popular / length / A–Z) delegates to rank.js, which
/// is unit-tested. `relevance` uses the desktop's query-aware relevance —
/// text score plus the filters the query asked for, the listener's region and
/// their taste — and falls back to the unfiltered page when the query's own
/// filters reject every row (better to show something than nothing).
export function rankForQuery(list, parsed, sort = "relevance", opts = {}) {
  const tracks = Array.isArray(list) ? list : [];
  if (!tracks.length) return tracks;
  if (sort && sort !== "relevance") return sortRows(parsed && parsed.raw, tracks, sort);
  const scoped = parsed ? tracks.filter((t) => matchesFilters(t, parsed)) : tracks;
  const pool = scoped.length ? scoped : tracks;
  return relevanceOrder(pool, parsed, textScoreFor(parsed), opts);
}

// --------------------------------------------------------- top result picker -
// Text match dominates; the kind weight only settles near-ties (a track named
// exactly like an album leads), popularity nudges the rest.
const KIND_WEIGHT = { song: 1.08, artist: 1.04, album: 1, playlist: 0.94 };
const TOP_POOL = 6;

/// Spotify's "Top result": the single best match across kinds, or null when
/// nothing matches. `tracks/albums/artists/playlists` are the already-fetched
/// pages.
export function pickTop(query, { tracks = [], albums = [], artists = [], playlists = [] } = {}) {
  const q = String(query || "").trim();
  if (!q) return null;
  const norm = q.toLowerCase();
  const cands = [
    ...tracks.slice(0, TOP_POOL).map((item) => ({ kind: "song", item })),
    ...artists.slice(0, TOP_POOL).map((item) => ({ kind: "artist", item })),
    ...albums.slice(0, TOP_POOL).map((item) => ({ kind: "album", item })),
    ...playlists.slice(0, TOP_POOL).map((item) => ({ kind: "playlist", item })),
  ];
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    const it = c.item || {};
    const title = String(it.title || "");
    if (!title) continue;
    let s = fuzzyScore(q, title, it.artist || it.subtitle || "", it.album || "");
    if (!s) continue;
    if (title.toLowerCase().trim() === norm) s += 6; // the title *is* the query
    // `plays` is missing on freshly-mapped cards; Number(undefined) is NaN and
    // a NaN score would silently disqualify every such candidate.
    s += 0.4 * Math.log10((Number(it.plays) || 0) / 10 + 1);
    s *= KIND_WEIGHT[c.kind] || 1;
    if (!best || s > bestScore) {
      best = { kind: c.kind, item: it };
      bestScore = s;
    }
  }
  return best;
}

/// First copy of each id/token wins — the entity grids and shelves both come
/// from pages that can repeat across kinds.
export function uniqueById(list) {
  const seen = new Set();
  const out = [];
  for (const it of list || []) {
    if (!it) continue;
    const id = it.id || it.token || it.title;
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
