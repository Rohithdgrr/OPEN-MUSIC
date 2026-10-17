// spotmatch.js — Spotify track → JioSaavn catalog matching (pure, DOM-free).
//
// Why this exists: JioSaavn's search has no ISRC index (probed live
// 2026-10-15 — a valid ISRC returns dozens of unrelated songs), so the old
// importers' `t.isrc || "name artist"` query with `limit: 1` silently
// matched garbage. This module queries by name + first artist, scores every
// candidate, and only accepts an honest match.
// Contract: docs/spotify-android-canvas.md §10.
//
// No DOM at module scope (fuzzy.js pattern) so `node --test` imports it.

import { editSim, querySim } from "./fuzzy.js";

export const MATCH_THRESHOLD = 0.6;
/// Near-exact-title trust rule: a title-only agreement (credit similarity
/// < 0.3) is believed only when the length also agrees (durF >= 0.5) —
/// otherwise it is a tribute-cover pattern, not the track.
export const CREDIT_MIN = 0.3;
export const TITLE_MIN = 0.55;
export const SEARCH_LIMIT = 8;

/// Title variants to compare: raw plus a bracket-stripped form, so
/// "Song (feat. X)" / "Song - Remastered" family differences do not hide an
/// otherwise exact title. Lowercased, punctuation-collapsed.
export function titleVariants(title) {
  const raw = String(title || "")
    .toLowerCase()
    .trim();
  const stripped = raw
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/\s*[-–]\s*(remaster(ed)?|radio edit|single version|album version|explicit|version)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = [raw];
  if (stripped && stripped !== raw) out.push(stripped);
  return out.filter(Boolean);
}

/// Blended similarity (edit distance + token overlap), 0..1.
function sim(a, b) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  return Math.max(editSim(x, y), querySim(x, y));
}

/// Best title similarity across both sides' variants.
function titleSim(wantName, candTitle) {
  let best = 0;
  for (const w of titleVariants(wantName)) {
    for (const c of titleVariants(candTitle)) {
      const s = sim(w, c);
      if (s > best) best = s;
    }
  }
  return best;
}

/// Artist similarity: full credit string versus the primary artist alone —
/// catalogs pad credits ("A, B, C"); Spotify wants list 1..n.
function artistSim(artists, candArtist) {
  const list = (Array.isArray(artists) ? artists : [artists]).filter(Boolean);
  const full = list.join(" ");
  let best = list.length ? sim(list[0], candArtist) : 0;
  const all = sim(full, candArtist);
  if (all > best) best = all;
  return best;
}

/// Duration agreement: 1 within 7 s, 0.5 within 20 s, 0.15 otherwise.
/// 0.7 when either side is unknown — neutral, not evidence.
export function durationFactor(wantMs, candSecs) {
  const a = Number(wantMs);
  const b = Number(candSecs);
  if (!(a > 0) || !(b > 0)) return 0.7;
  const diff = Math.abs(a / 1000 - b);
  if (diff <= 7) return 1;
  if (diff <= 20) return 0.5;
  return 0.15;
}

/// Score one catalog candidate against the wanted track.
/// Returns { score, titleSim, artistSim, durF } — accept only when
/// score >= MATCH_THRESHOLD, titleSim >= TITLE_MIN, and the near-exact-title
/// trust rule holds (see CREDIT_MIN).
export function matchScore(want, cand) {
  const t = titleSim(want.name, cand.title);
  const a = artistSim(want.artists, cand.artist);
  const d = durationFactor(want.duration_ms, cand.duration_secs);
  return { score: 0.5 * t + 0.3 * a + 0.2 * d, titleSim: t, artistSim: a, durF: d };
}

/// Best candidate above the accept bar, or null. `cands` is the
/// `search_songs` `tracks` array (Track: id/title/artist/album/
/// duration_secs/duration/image …).
export function pickBestMatch(want, cands) {
  let best = null;
  for (const c of cands || []) {
    const s = matchScore(want, c);
    if (!best || s.score > best.score) best = { track: c, score: s.score, parts: s };
  }
  if (!best || best.score < MATCH_THRESHOLD) return null;
  if (best.parts.titleSim < TITLE_MIN) return null;
  // Tribute-cover guard: right title, unrecognizable credit, wrong length.
  if (best.parts.artistSim < CREDIT_MIN && best.parts.durF < 0.5) return null;
  return { track: best.track, score: best.score };
}

/// Search the catalog for one imported track and return the honest pick.
/// `invoke` is injected (desktop core.js / mobile shared.js — importer.js
/// pattern). Failure shapes: `{ track: null, error }` on throw or missing
/// invoke; `{ track: null, query }` (no error) on an honest miss.
export async function matchTrackToCatalog(want, invoke, opts = {}) {
  const query = [want.name, (want.artists || [])[0]].filter(Boolean).join(" ").trim();
  if (!invoke) return { track: null, query, error: "no invoke injected" };
  if (!query) return { track: null, query, error: "track has no name" };
  const limit = opts.limit || SEARCH_LIMIT;
  try {
    const res = await invoke("search_songs", { query, limit });
    const best = pickBestMatch(want, (res && res.tracks) || []);
    return best ? { track: best.track, score: best.score, query } : { track: null, query };
  } catch (err) {
    return { track: null, query, error: String(err) };
  }
}
