// query.js — query understanding: normalize, pull filters out of the typed
// string, and score a result for relevance. Pure text in / plain data out, so
// `node --test` covers it without a DOM (same contract as fuzzy.js).
//
// Why this exists: JioSaavn's search takes one flat string. Sending
// "arijit singh punjabi 2023" verbatim returns nothing, because no title
// contains the words "punjabi 2023". So the filter words are lifted out and
// the rest is what actually goes upstream.

// Slugs the catalog itself uses (see settings.js LANGS). Only these count as
// language tokens — "pop" must not be read as a language, and "sad"/"love"
// are moods, handled further down.
const LANGS = new Set([
  "hindi", "punjabi", "tamil", "telugu", "bengali", "kannada", "malayalam",
  "marathi", "gujarati", "odia", "urdu", "english", "chinese", "german",
  "spanish", "french", "japanese", "korean", "arabic",
]);

// Exported for the mobile shell (searchkit.js derives its mood boost from the
// same table rather than keeping a second copy in sync by hand).
export const MOODS = {
  chill: ["chill", "chilled", "relax", "relaxing", "ambient", "calm", "downtempo", "lofi", "lo-fi", "sleep", "dreamy"],
  party: ["party", "dance", "club", "remix", "edm", "festival", "hype", "bash"],
  energy: ["workout", "gym", "energy", "power", "run", "pump", "beast", "hardcore"],
  focus: ["focus", "study", "concentrate", "instrumental", "piano"],
  romantic: ["love", "romantic", "romance", "pyaar", "ishq", "crush", "heart"],
  sad: ["sad", "heartbreak", "breakup", "blue", "lonely", "dard", "miss you"],
};

// Country codes worth reading as a region. Deliberately short: any longer
// list starts eating real words ("IN", "IT", "NO" are English words too).
const REGIONS = new Set(["IN", "PK", "US", "GB", "AE", "BD", "NP", "LK", "CA", "AU", "SG", "MY", "DE", "FR", "JP", "BR", "ZA", "QA", "SA"]);

// What a language is worth per region, as a small additive boost. Region
// preference is a nudge, never a filter — nothing gets hidden for it.
// Exported for the mobile recommender (recommend.js), which uses the same
// table to build a region shelf.
export const REGION_LANGS = {
  IN: ["hindi", "punjabi", "tamil", "telugu", "bengali", "marathi", "odia", "kannada", "malayalam"],
  PK: ["urdu", "punjabi", "hindi"],
  BD: ["bengali", "hindi"],
  NP: ["nepali", "hindi"],
  LK: ["sinhala", "tamil", "hindi"],
  AE: ["arabic", "hindi", "english"],
  SA: ["arabic", "hindi", "english"],
  US: ["english", "spanish", "hindi"],
  GB: ["english", "hindi", "urdu"],
};

/// Fold a typed query to the form used for matching: lowercase, accents
/// stripped, `&` spelled out, punctuation to spaces. Kept in sync with
/// normalizeToken() below so a match never depends on which side folded.
export function normalize(input) {
  return String(input == null ? "" : input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[-_/\\.,:;!?()[\]{}"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/// One word folded the same way normalize() folds a phrase. Script is left
/// alone on purpose: Devanagari/Tamil titles are matched by code point, which
/// is what levenshtein already counts.
export function normalizeToken(t) {
  return String(t == null ? "" : t)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const FOUR_DIGITS = /^(19|20)\d{2}$/;
/// "90s", "2000s", "1990s" — people type the short form, so accept all three.
/// The shape is the decade's leading digits plus its own "0s" tail.
const DECADE = /^(\d{1,3})0s$/;

/// A decade token in four digits. Leading digits are read the way people mean
/// them: "90s" is 1990, "00s" is 2000, "30s" is 1930.
function decadeOf(token) {
  const m = String(token).match(DECADE);
  if (!m) return 0;
  const g = m[1];
  const core = g.length === 3 ? g : Number(g) >= 3 ? `19${g}` : `20${g}`;
  return Math.floor(Number(`${core}0`) / 10) * 10;
}

/// Pull the filters a user typed out of the query itself.
///
/// `kesariya 2022` -> text "kesariya", year 2022
/// `arijit singh punjabi` -> text "arijit singh", language "punjabi"
/// `@arijit #brahmastra 90s` -> artist "arijit", album "brahmastra", decade 1990
/// `brahmastra album` -> the word "album" is an intent hint, not a filter
///
/// Filters found are *removed* from `text`, because that is what gets sent
/// upstream — the catalog has no idea the user meant 2022.
export function parseQuery(raw) {
  const original = String(raw == null ? "" : raw);
  const out = {
    raw: original,
    text: original,
    tokens: [],
    language: "",
    languages: [],
    year: 0,
    decade: 0,
    yearRange: null,
    region: "",
    artist: "",
    album: "",
    genre: "",
    mood: "",
    exact: false,
    wantsEntity: "",
  };
  let working = original;
  const quoted = [];
  // Quoted phrases first, over the whole string: a phrase is usually several
  // whitespace-separated words, so matching per token would only ever catch
  // the ones that happen to be one word long.
  working = working.replace(/["“]([^"”]+)["”]/g, (_m, inner) => {
    quoted.push(inner.trim());
    return " ";
  });
  if (quoted.length) out.exact = true;
  const kept = working.split(/\s+/).filter(Boolean);

  const rest = [];
  for (const w of kept) {
    if (w.startsWith("@") && w.length > 1) {
      out.artist = w.slice(1);
      continue;
    }
    if (w.startsWith("#") && w.length > 1) {
      out.album = w.slice(1);
      continue;
    }
    const bare = w.replace(/[^\p{L}\p{N}]+$/u, "");
    const low = bare.toLowerCase();
    if (!low) continue;

    if (FOUR_DIGITS.test(low)) {
      out.year = Number(low);
      continue;
    }
    if (DECADE.test(low)) {
      out.decade = decadeOf(low);
      continue;
    }
    const range = low.match(/^(19|20)(\d{2})\s*-\s*(19|20)?(\d{2})$/);
    if (range) {
      const from = Number(`${range[1]}${range[2]}`);
      const to = Number(`${range[3] || "20"}${range[4]}`);
      if (from <= to) {
        out.yearRange = [from, to];
        continue;
      }
    }
    if (REGIONS.has(bare.toUpperCase()) && bare === bare.toUpperCase()) {
      // Uppercase only: "in"/"it"/"no" are ordinary words when lowercase.
      out.region = bare.toUpperCase();
      continue;
    }
    if (LANGS.has(low)) {
      if (!out.languages.includes(low)) out.languages.push(low);
      if (!out.language) out.language = low;
      continue;
    }
    if (["song", "songs", "track", "tracks"].includes(low)) {
      out.wantsEntity = out.wantsEntity || "tracks";
      continue;
    }
    if (["album", "albums"].includes(low)) {
      out.wantsEntity = out.wantsEntity || "albums";
      continue;
    }
    if (["artist", "artists", "singer", "singers"].includes(low)) {
      out.wantsEntity = out.wantsEntity || "artists";
      continue;
    }
    if (["playlist", "playlists", "mix", "mixes", "radio"].includes(low)) {
      out.wantsEntity = out.wantsEntity || "playlists";
      continue;
    }
    for (const [mood, words4] of Object.entries(MOODS)) {
      if (words4.includes(low)) {
        out.mood = out.mood || mood;
        break;
      }
    }
    rest.push(bare);
  }

  out.languages = out.languages.slice(0, 4);
  // A query that is *only* filters ("2023", "hindi") has no text left; what
  // goes upstream is then the entity the user named, and failing even that,
  // the original string. Never an empty query.
  const named = [out.artist && `@${out.artist}`, out.album && `#${out.album}`].filter(Boolean);
  const text = [...quoted, ...rest].join(" ").trim();
  out.text = text || named.join(" ") || original;
  out.tokens = normalize(out.text).split(" ").filter(Boolean);
  for (const tok of [normalizeToken(out.artist), normalizeToken(out.album)]) {
    if (tok && !out.tokens.includes(tok)) out.tokens.push(tok);
  }
  return out;
}

/// Languages a result counts as speaking. The catalog writes them
/// comma-separated ("hindi, punjabi") and in mixed case.
function trackLangs(t) {
  return String((t && t.language) || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/// Year a track was released, or 0 when the source does not say. Accepts the
/// numeric and the "2019-08-24" shape.
function trackYear(t) {
  const y = parseInt(String((t && t.year) || "").slice(0, 4), 10);
  return Number.isFinite(y) ? y : 0;
}

/// Does this track satisfy the filters the query asked for? `null` means no
/// opinion (no filter of that kind), true/false otherwise.
export function matchesFilters(t, q) {
  if (q.language || q.languages.length) {
    const want = q.languages.length ? q.languages : [q.language];
    const have = trackLangs(t);
    if (!have.some((l) => want.includes(l))) return false;
  }
  if (q.year) {
    const y = trackYear(t);
    // A track with no year is not evidence against the filter: it stays, it
    // just does not earn the year boost. Hiding it would be a lie.
    if (y && y !== q.year) return false;
  }
  if (q.decade) {
    const y = trackYear(t);
    if (y && Math.floor(y / 10) * 10 !== q.decade) return false;
  }
  if (q.yearRange) {
    const y = trackYear(t);
    if (y && (y < q.yearRange[0] || y > q.yearRange[1])) return false;
  }
  return true;
}

/// Relevance of one track to a parsed query, roughly 0..1 before the personal
/// boosts. Text match dominates; everything else only reorders rows that were
/// already plausible.
///
/// `textScore` is fuzzy.js's score, injected rather than imported so this
/// module stays free of the ranking call site and tests can feed a stub.
export function relevance(t, q, textScore, opts = {}) {
  const score = typeof textScore === "function" ? textScore(t, q) : 0;
  let s = score;

  // The title *is* the query. fuzzyScore cannot tell "Kesariya" from
  // "Kesariya XYZ" (both contain every token), but a user typing the title
  // wants that exact record first, so it is worth saying out loud.
  const wanted = normalize(q.text);
  if (wanted && normalize(t.title) === wanted) s += 0.25;

  // Language the user asked for, or that their region prefers.
  const have = trackLangs(t);
  if (q.languages.length && q.languages.some((l) => have.includes(l))) s += 0.25;
  const regional = opts.region ? REGION_LANGS[opts.region] : null;
  if (regional && have.some((l) => regional.includes(l))) s += 0.08;

  // Year agreement.
  const y = trackYear(t);
  if (q.year && y === q.year) s += 0.2;
  if (q.decade && y && Math.floor(y / 10) * 10 === q.decade) s += 0.12;
  if (q.yearRange && y && y >= q.yearRange[0] && y <= q.yearRange[1]) s += 0.15;
  if (q.exact) {
    const hay = normalize(`${t.title || ""} ${t.artist || ""}`);
    if (q.tokens.length && q.tokens.every((tok) => hay.includes(tok))) s += 0.3;
  }
  if (q.artist) {
    const a = normalizeToken(q.artist);
    if (a && normalizeToken(t.artist).includes(a)) s += 0.2;
  }
  if (q.album) {
    const a = normalizeToken(q.album);
    if (a && normalizeToken(t.album).includes(a)) s += 0.2;
  }
  if (q.mood && (opts.moodOf ? opts.moodOf(t) : "") === q.mood) s += 0.1;

  // Quality and popularity, log-scaled so a 10M-play track cannot run away
  // with the ranking.
  if (t.hq) s += 0.03;
  if (Number(t.plays) > 0) s += 0.1 * Math.log10(Number(t.plays) / 10 + 1) / 6;

  // Taste: what this listener already played or hearted.
  if (opts.played && opts.played.has(t.id)) s += 0.15;
  if (opts.liked && opts.liked.has(t.id)) s += 0.2;
  if (opts.artistPlays && t.artist) s += 0.05 * Math.min(3, opts.artistPlays.get(t.artist) || 0);

  return s;
}

/// Order a page of tracks for a parsed query. Stable: equal scores keep the
/// order the API sent them in, so paging never reshuffles under the user.
export function rankTracks(list, q, textScore, opts = {}) {
  return (list || [])
    .map((t, i) => ({ t, i, s: relevance(t, q, textScore, opts) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

/// Nearby queries worth offering when a search comes back empty: the
/// listener's own history plus the catalog's suggestions, scored by
/// similarity and above the same 0.55 gate "did you mean" has always used.
export function didYouMean(query, candidates, sim) {
  const q = normalize(query);
  if (!q || typeof sim !== "function") return [];
  const seen = new Set([q]);
  const out = [];
  for (const raw of candidates || []) {
    const title = String((raw && raw.title) || raw || "").trim();
    if (!title) continue;
    const key = normalize(title);
    if (!key || seen.has(key)) continue;
    const score = sim(q, key);
    if (score < 0.55) continue;
    seen.add(key);
    out.push({ title, sim: score });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, 3);
}
