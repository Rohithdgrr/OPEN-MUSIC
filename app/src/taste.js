// taste.js — shared, pure taste & similarity helpers for both shells.
//
// One job: turn the local logs (plays, likes, downloads, saved library, the
// `play_events` taste log) into signals, rank candidate tracks when a consumer
// opts in, and mine "played around" neighbours. Pure on purpose — no DOM, no
// storage, no network — so `node --test` covers the math. The radios no longer
// rank: they queue JioSaavn's own order and only use the eligibility gate
// (`pickBatch`); see docs/recommendations.md §8.8.
//
// Techniques (deliberately dependency-free; each is a few dozen lines):
//   * item-item co-occurrence over listening sessions, time-decayed
//   * session k-NN (SB-KNN): score a candidate by the neighbours of the last
//     few played keys
//   * negative weights from early skips (dwell < 35 % of the track)
//   * MMR diversity rerank (per-artist cap + adjacency nudge)
//   * an ε-slot exploration seat for rankers that opt in

export const DAY_MS = 86400000;
/// Sessions break when the gap between two plays exceeds this.
export const SESSION_GAP_MS = 30 * 60 * 1000;
/// Co-occurrence half-life: a pair from two weeks ago counts half.
export const CO_HALF_LIFE_MS = 14 * DAY_MS;
/// Negative (skip) half-life.
export const SKIP_HALF_LIFE_MS = 7 * DAY_MS;
/// A skip this recent hard-drops the track from radio picks entirely.
export const HARD_SKIP_MS = 3 * 3600000;
/// Outcome thresholds, as a fraction of the track heard.
export const SKIP_FRACTION = 0.35;
export const COMPLETE_FRACTION = 0.8;
/// Freshness demotion windows, mirroring the Home engine (recommend.js).
export const REPEAT_WINDOW_MS = 6 * 3600000;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const norm = (v) => str(v).toLowerCase();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const decay = (age, halfLife) => Math.pow(0.5, Math.max(0, num(age)) / halfLife);

/// "feat." / "ft." / "with" / separators carry the leading artists. Same
/// splitter as recommend.js leadArtists — the trailing `\.?` belongs to the
/// token, so a bare `\bfeat\b` would leave a ". Guest" fragment behind.
const LEAD_SPLIT = /[,;&]|\bfeat\b\.?|\bft\b\.?|\bwith\b/i;
export function leadArtists(name) {
  return str(name).split(LEAD_SPLIT).map(str).filter(Boolean);
}

/// complete | skip | partial — the one classification both players use.
/// Natural end always wins; otherwise the dwell fraction decides.
export function classifyPlay({ msPlayed = 0, durationSecs = 0, naturalEnd = false } = {}) {
  if (naturalEnd) return "complete";
  const dur = num(durationSecs);
  if (dur <= 0) return "partial";
  const frac = num(msPlayed) / (dur * 1000);
  if (frac < SKIP_FRACTION) return "skip";
  if (frac >= COMPLETE_FRACTION) return "complete";
  return "partial";
}

/// Valid, chronologically sorted events. Rows that never started (no id or
/// no ts) are dropped instead of poisoning the sessions.
export function cleanEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && str(e.id) && num(e.ts) > 0)
    .sort((a, b) => num(a.ts) - num(b.ts));
}

/// Split a play log into listening sessions: consecutive plays join while the
/// gap stays under `gapMs`. Returns arrays of events, chronological.
export function sessionize(events, gapMs = SESSION_GAP_MS) {
  const list = cleanEvents(events);
  const sessions = [];
  let cur = [];
  for (const e of list) {
    if (cur.length && num(e.ts) - num(cur[cur.length - 1].ts) > gapMs) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

/// Item-item co-occurrence over sessions, decayed from `now`. Track rows and
/// artist rows are built in one pass; `catalog` keeps the last metadata each
/// event carried, so shelves can render ids the song cache has never seen
/// (station plays are usually never cached).
export function buildCoOccurrence(
  events,
  { now = Date.now(), halfLifeMs = CO_HALF_LIFE_MS, maxNeighbors = 60 } = {},
) {
  const tracks = new Map();
  const artists = new Map();
  const catalog = new Map();
  const bump = (graph, a, b, w) => {
    if (!a || !b || a === b) return;
    let row = graph.get(a);
    if (!row) graph.set(a, (row = new Map()));
    row.set(b, (row.get(b) || 0) + w);
  };
  for (const session of sessionize(events)) {
    for (const e of session) {
      const id = str(e.id);
      if (!id) continue;
      const c = catalog.get(id) || { id, title: "", artist: "", image: "" };
      if (!c.title && str(e.title)) c.title = str(e.title);
      if (!c.artist && str(e.artist)) c.artist = str(e.artist);
      if (!c.image && str(e.image)) c.image = str(e.image);
      catalog.set(id, c);
    }
    for (let i = 0; i < session.length; i++) {
      for (let j = i + 1; j < session.length; j++) {
        const a = session[i];
        const b = session[j];
        const w = decay(now - num(b.ts), halfLifeMs);
        bump(tracks, str(a.id), str(b.id), w);
        bump(tracks, str(b.id), str(a.id), w);
        const aa = norm(a.artist);
        const ba = norm(b.artist);
        bump(artists, aa, ba, w);
        bump(artists, ba, aa, w);
      }
    }
  }
  const prune = (graph) => {
    for (const [k, row] of graph) {
      if (row.size <= maxNeighbors) continue;
      const top = [...row.entries()].sort((x, y) => y[1] - x[1]).slice(0, maxNeighbors);
      graph.set(k, new Map(top));
    }
  };
  prune(tracks);
  prune(artists);
  return { tracks, artists, catalog };
}

/// SB-KNN: walk the last `k` keys (most recent first), sum each key's
/// co-occurrence row discounted by recency (step^i). Returns Map key -> score.
export function neighborScores(graph, recentKeys, { k = 8, step = 0.75 } = {}) {
  const out = new Map();
  const seen = new Set();
  let i = 0;
  for (const raw of recentKeys || []) {
    const key = str(raw);
    if (!key || seen.has(key)) continue;
    if (i >= k) break;
    seen.add(key);
    const row = graph.get(key);
    if (row) {
      const w = Math.pow(step, i);
      for (const [nb, weight] of row) out.set(nb, (out.get(nb) || 0) + weight * w);
    }
    i += 1;
  }
  return out;
}

/// Decayed negative weights from skipped plays. `ts` (id -> most recent skip)
/// lets rerankBatch hard-drop a track that was just skipped.
export function negativeWeights(events, { now = Date.now(), halfLifeMs = SKIP_HALF_LIFE_MS } = {}) {
  const ids = new Map();
  const ts = new Map();
  const artists = new Map();
  for (const e of cleanEvents(events)) {
    if (str(e.outcome) !== "skip") continue;
    const id = str(e.id);
    const w = decay(now - num(e.ts), halfLifeMs);
    ids.set(id, (ids.get(id) || 0) + w);
    ts.set(id, Math.max(ts.get(id) || 0, num(e.ts)));
    for (const a of leadArtists(e.artist)) {
      const key = norm(a);
      artists.set(key, (artists.get(key) || 0) + w);
    }
  }
  return { ids, ts, artists };
}

/// Assemble every signal rerankBatch reads. Surfaces only hand raw local
/// lists in; all the mining lives here so both shells rank identically.
///
/// - plays: `[{ id, artist, album, language, year, count, ts }]` (tm-plays /
///   store rows) — counts are log-scaled and decayed from `ts`.
/// - favs / downloads / library: track lists — flat ≈ +4 / +3 / +2 bonuses.
/// - queuedIds / heardIds: ids that must not (or should not) be re-ranked.
export function buildSignals({
  plays = [],
  favs = [],
  downloads = [],
  library = [],
  events = [],
  queuedIds = [],
  heardIds = [],
  current = null,
  now = Date.now(),
} = {}) {
  const artistW = new Map();
  const languageW = new Map();
  const decadeW = new Map();
  const albumW = new Map();
  const playedAt = new Map();
  const add = (m, key, w) => {
    if (key) m.set(key, (m.get(key) || 0) + w);
  };
  const bump = (t, base, timeWeighted) => {
    if (!t) return;
    const w = timeWeighted ? base * decay(now - num(t.ts), CO_HALF_LIFE_MS) : base;
    if (!(w > 0)) return;
    for (const a of leadArtists(t.artist)) add(artistW, norm(a), w);
    const lang = norm(t.language);
    if (lang) add(languageW, lang, w * 0.6);
    const alb = norm(t.album);
    if (alb) add(albumW, alb, w * 0.4);
    const year = parseInt(str(t.year).slice(0, 4), 10);
    if (Number.isFinite(year) && year > 1900) add(decadeW, `${Math.floor(year / 10) * 10}`, w * 0.25);
    const id = str(t.id);
    if (id && timeWeighted && num(t.ts) > 0) {
      playedAt.set(id, Math.max(playedAt.get(id) || 0, num(t.ts)));
    }
  };
  for (const p of plays) {
    if (p && p.id) bump(p, Math.log10((num(p.count) || 0) + 1), true);
  }
  for (const f of favs) bump(f, 3, false);
  for (const d of downloads) bump(d, 2.5, false);
  for (const l of library) bump(l, 2, false);

  const clean = cleanEvents(events);
  const cooc = buildCoOccurrence(clean, { now });
  const negatives = negativeWeights(clean, { now });
  const recentIds = [];
  const recentArtists = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const e = clean[i];
    const id = str(e.id);
    if (id && !recentIds.includes(id) && recentIds.length < 12) recentIds.push(id);
    for (const a of leadArtists(e.artist)) {
      const key = norm(a);
      if (key && !recentArtists.includes(key) && recentArtists.length < 12) recentArtists.push(key);
    }
    if (recentIds.length >= 12 && recentArtists.length >= 12) break;
  }
  return {
    now,
    artistW,
    languageW,
    decadeW,
    albumW,
    playedAt,
    /// Continuity: the track playing right now, so a ranker that opts in can
    /// stay in its album/artist orbit.
    seedAlbum: norm(current && current.album),
    seedArtist: norm(leadArtists(current && current.artist)[0]),
    favs: new Set((favs || []).map((t) => str(t && t.id)).filter(Boolean)),
    downloads: new Set((downloads || []).map((t) => str(t && t.id)).filter(Boolean)),
    library: new Set((library || []).map((t) => str(t && t.id)).filter(Boolean)),
    queued: new Set((queuedIds || []).map((v) => str(v && typeof v === "object" ? v.id : v)).filter(Boolean)),
    heard: new Set((heardIds || []).map((v) => str(v && typeof v === "object" ? v.id : v)).filter(Boolean)),
    cooc,
    negatives,
    knnTracks: neighborScores(cooc.tracks, recentIds),
    knnArtists: neighborScores(cooc.artists, recentArtists),
  };
}

/// Base score for one candidate, before diversity. Cold tracks (no local
/// history) still score on their artist/language/decade similarity — that is
/// the point: radio batches are mostly cold.
export function scoreCandidate(sig, t) {
  if (!sig || !t) return 0;
  let s = 0;
  const leads = leadArtists(t.artist);
  for (const a of leads) s += sig.artistW.get(norm(a)) || 0;
  const lang = norm(t.language);
  if (lang) s += 0.6 * (sig.languageW.get(lang) || 0);
  const alb = norm(t.album);
  if (alb) s += 0.4 * (sig.albumW.get(alb) || 0);
  if (sig.seedAlbum && alb && alb === sig.seedAlbum) s += 1;
  const year = parseInt(str(t.year).slice(0, 4), 10);
  if (Number.isFinite(year) && year > 1900) {
    s += 0.25 * (sig.decadeW.get(`${Math.floor(year / 10) * 10}`) || 0);
  }
  const id = str(t.id);
  if (id) {
    if (sig.favs.has(id)) s += 4;
    if (sig.downloads.has(id)) s += 3;
    if (sig.library.has(id)) s += 2;
    s += 3 * (sig.knnTracks.get(id) || 0);
    const at = sig.playedAt.get(id);
    if (at) {
      const age = sig.now - at;
      if (age >= 0 && age < REPEAT_WINDOW_MS) s -= 6;
      else if (age >= 0 && age < DAY_MS) s -= 2.5;
    }
    s -= 4 * (sig.negatives.ids.get(id) || 0);
  }
  for (const a of leads) s -= 2 * (sig.negatives.artists.get(norm(a)) || 0);
  const lead0 = norm(leads[0]);
  if (lead0) s += 2 * (sig.knnArtists.get(lead0) || 0);
  return s;
}

/// Greedy MMR with a per-artist cap and a small same-artist adjacency nudge.
/// Similarity is a cheap local proxy (same artist 1.0, same album 0.5) — no
/// text embeddings needed at this scale.
export function mmrRerank(
  items,
  {
    limit = 12,
    lambda = 0.7,
    artistCap = 2,
    scoreOf,
    artistOf = (t) => norm(leadArtists(t && t.artist)[0]),
    albumOf = (t) => norm(t && t.album),
  } = {},
) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length || limit <= 0) return [];
  const scored = list
    .map((it) => ({ it, s: Number(scoreOf(it)) || 0 }))
    .sort((a, b) => b.s - a.s);
  const min = scored[scored.length - 1].s;
  const span = scored[0].s - min || 1;
  const sim = (a, b) => {
    const aa = artistOf(a);
    const ba = artistOf(b);
    if (aa && ba && aa === ba) return 1;
    const al = albumOf(a);
    const bl = albumOf(b);
    if (al && bl && al === bl) return 0.5;
    return 0;
  };
  const picked = [];
  const counts = new Map();
  const pool = scored.slice();
  while (pool.length && picked.length < limit) {
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const a = artistOf(cand.it);
      if (a && (counts.get(a) || 0) >= artistCap) continue;
      const rel = (cand.s - min) / span;
      let sMax = 0;
      for (const p of picked) {
        const v = sim(cand.it, p);
        if (v > sMax) sMax = v;
      }
      let v = lambda * rel - (1 - lambda) * sMax;
      if (picked.length) {
        const last = artistOf(picked[picked.length - 1]);
        if (a && last && a === last) v -= 0.05;
      }
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    if (best < 0) break; // every remaining candidate is capped out
    const chosen = pool.splice(best, 1)[0].it;
    picked.push(chosen);
    const a = artistOf(chosen);
    if (a) counts.set(a, (counts.get(a) || 0) + 1);
  }
  // Supply thinner than the cap: fill by pure relevance rather than return
  // a short rail (an all-one-artist station should still play).
  while (pool.length && picked.length < limit) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) if (pool[i].s > pool[best].s) best = i;
    picked.push(pool.splice(best, 1)[0].it);
  }
  return picked;
}

/// The eligibility gate every queue path shares: one row per id, drop queued
/// ids, drop the heard tail (unless allowed), drop tracks hard-skipped within
/// the last 3 h. Input order is preserved — for a JioSaavn station batch that
/// order *is* the recommendation (docs/recommendations.md §8.8).
export function eligibleBatch(candidates, signals, { allowHeard = false } = {}) {
  const sig = signals || {};
  const queued = sig.queued || new Set();
  const heard = sig.heard || new Set();
  const now = sig.now || Date.now();
  const skipTs = (sig.negatives && sig.negatives.ts) || new Map();
  const seen = new Set();
  const pool = [];
  for (const t of Array.isArray(candidates) ? candidates : []) {
    const id = str(t && t.id);
    if (!id || seen.has(id) || queued.has(id)) continue;
    if (!allowHeard && heard.has(id)) continue;
    const at = skipTs.get(id) || 0;
    if (at && now - at < HARD_SKIP_MS) continue;
    seen.add(id);
    pool.push(t);
  }
  return pool;
}

/// One radio batch, JioSaavn-preferred: upstream order kept, local logic only
/// gates eligibility. The endless-mode contract survives — when the gate
/// empties the whole batch, retry once with the heard tail allowed.
export function pickBatch(candidates, signals, { limit = 12 } = {}) {
  const picked = eligibleBatch(candidates, signals);
  if (picked.length) return picked.slice(0, limit);
  return eligibleBatch(candidates, signals, { allowHeard: true }).slice(0, limit);
}

/// Rank one candidate batch for one listener; returns up to `limit` tracks.
/// order: filter (id · queued · heard · just-skipped) → score → MMR → ε-slot.
export function rerankBatch(
  candidates,
  signals,
  { limit = 12, eps = 0.08, rng = Math.random, artistCap = 2, allowHeard = false } = {},
) {
  const sig = signals || {};
  const pool = eligibleBatch(candidates, sig, { allowHeard });
  if (!pool.length) return [];
  let ranked = mmrRerank(pool, { limit, artistCap, scoreOf: (t) => scoreCandidate(sig, t) });
  // ε-slot: keep one exploration seat just past the favourites so the tail
  // never freezes on the same few artists.
  if (eps > 0 && ranked.length >= 3 && rng() < eps) {
    const picked = new Set(ranked.map((t) => str(t.id)));
    const rest = pool.filter((t) => !picked.has(str(t.id)));
    if (rest.length) {
      const pick = rest[Math.floor(rng() * rest.length) % rest.length];
      const at = 1 + Math.floor(rng() * Math.max(1, ranked.length - 1));
      ranked = ranked.slice();
      ranked.splice(Math.min(at, ranked.length - 1), 0, pick);
      ranked = ranked.slice(0, limit);
    }
  }
  return ranked;
}

/// "Because you played X": the most recent play whose co-listening row has
/// enough neighbours with real metadata, plus that row's top tracks. Null
/// when the log is too thin — an invented rail is worse than none.
export function similarShelf(events, { now = Date.now(), n = 12, minNeighbors = 6 } = {}) {
  const cooc = buildCoOccurrence(events, { now });
  const clean = cleanEvents(events);
  for (let i = clean.length - 1; i >= 0; i--) {
    const e = clean[i];
    if (str(e.outcome) === "skip") continue;
    const id = str(e.id);
    const row = cooc.tracks.get(id);
    if (!row || row.size < minNeighbors) continue;
    const anchor = cooc.catalog.get(id) || {
      id,
      title: str(e.title),
      artist: str(e.artist),
      image: str(e.image),
    };
    const tracks = [...row.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([nb]) => cooc.catalog.get(nb))
      .filter((t) => t && t.id && t.id !== id && t.title)
      .slice(0, n);
    if (tracks.length < minNeighbors) continue; // metadata-sparse row: keep looking
    return { anchor, tracks };
  }
  return null;
}

/// Offline metric: walk the log chronologically; after a warm-up, skip test
/// points whose target just played (the radio's `heard` filter would remove
/// it anyway), then rank every other already-seen id by its SB-KNN score from
/// the recent tail and check whether the true next track lands in the top
/// `k`. Cold targets (first-ever play) are unscoreable and skipped. Random
/// order sits near k/|candidates|; the suite pins a synthetic chain far above
/// that and above a shuffled baseline.
export function replayHitRate(events, { k = 2, warmup = 12, heardWindow = 4 } = {}) {
  const list = cleanEvents(events);
  let hits = 0;
  let total = 0;
  for (let i = warmup; i < list.length; i++) {
    const history = list.slice(0, i);
    const target = str(list[i].id);
    const seenIds = [];
    for (const e of history) {
      const id = str(e.id);
      if (id && !seenIds.includes(id)) seenIds.push(id);
    }
    if (!target || !seenIds.includes(target)) continue;
    // What just played is not a prediction problem — the radio filters it.
    const heard = new Set();
    for (let j = history.length - 1; j >= 0 && heard.size < heardWindow; j--) {
      heard.add(str(history[j].id));
    }
    const cands = seenIds.filter((id) => !heard.has(id));
    if (!cands.includes(target)) continue;
    const recent = [];
    for (let j = history.length - 1; j >= 0 && recent.length < 8; j--) {
      const id = str(history[j].id);
      if (id && !recent.includes(id)) recent.push(id);
    }
    const knn = neighborScores(buildCoOccurrence(history, { now: num(list[i].ts) }).tracks, recent);
    const ranked = cands.slice().sort((a, b) => (knn.get(b) || 0) - (knn.get(a) || 0));
    total += 1;
    if (ranked.slice(0, k).includes(target)) hits += 1;
  }
  return { hits, total, rate: total ? hits / total : 0 };
}
