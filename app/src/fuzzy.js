// fuzzy.js — pure query-text scoring for search (no DOM, node-testable).
// Bounded Levenshtein + token scoring used for relevance ranking and
// "did you mean" candidate picking (review 3.1).

/// Levenshtein distance, bailed out early once it exceeds `max`
/// (returns max + 1 when the true distance is larger).
export function levenshtein(a, b, max = Infinity) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[t.length];
}

/// 1 - normalized edit distance: 1 = identical, 0 = maximally apart.
export function editSim(a, b) {
  const x = String(a);
  const y = String(b);
  if (!x.length && !y.length) return 1;
  const dist = levenshtein(x, y, Math.max(x.length, y.length));
  return 1 - dist / Math.max(x.length, y.length, 1);
}

/// How well `query` matches a track, for ranking. Every query token must
/// land somewhere (title/artist/album substring or a near-miss word for
/// typo tolerance); stronger title hits score higher. 0 = no match signal.
export function fuzzyScore(query, title, artist = "", album = "") {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  const full = `${String(title || "").toLowerCase()} ${String(artist || "").toLowerCase()} ${String(album || "").toLowerCase()}`.trim();
  if (!full) return 0;
  const words = full.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const titleWords = String(title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let score = 0;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (titleWords.some((w) => w === token || w.startsWith(token))) {
      score += 3;
      continue;
    }
    if (full.includes(token)) {
      score += 2;
      continue;
    }
    // Typo tolerance: credit the best near-miss word (≥ 0.5 = at most a
    // couple of edits for typical token lengths).
    let best = 0;
    for (const w of words) {
      if (Math.abs(w.length - token.length) > Math.max(2, token.length * 0.4)) continue;
      const sim = editSim(token, w);
      if (sim > best) best = sim;
    }
    if (best >= 0.5) score += best * 1.5;
    else return 0; // one unmatched token disqualifies the track
  }
  if (q.length > 3 && full.includes(q)) score += 4; // whole-phrase hit
  return score;
}

/// Similarity of two short strings for "did you mean" picking: token
/// overlap blended with edit distance (0..1).
export function querySim(a, b) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xt = new Set(x.split(/\s+/).filter(Boolean));
  const yt = new Set(y.split(/\s+/).filter(Boolean));
  let common = 0;
  for (const t of xt) if (yt.has(t)) common += 1;
  const overlap = common / Math.max(xt.size, yt.size, 1);
  const lev = Math.min(x.length, y.length) > 1 ? editSim(x.slice(0, 60), y.slice(0, 60)) : 0;
  return Math.max(overlap, lev * 0.9);
}
