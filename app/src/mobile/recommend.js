// recommend.js — the taste engine behind Home's "Made for you" shelves.
//
// Pure: local logs in, shelf plans out. No DOM, no network, no storage, so
// `node --test` covers it and the same functions can drive the desktop Home.
//
// The model is a small hybrid recommender rather than a single heuristic:
//   * implicit feedback  — play counts, decayed by how long ago they happened
//   * explicit feedback  — likes (heavy), downloads (intent to own), library saves
//   * content affinity   — artist / album / language / decade co-occurrence
//   * context            — the listener's country, their hour-of-day pattern,
//                          and how recently a track was already heard
// Every mix is a windowed projection of that profile, and the flagship mixes
// are seeded by the calendar day/month so they rotate like Spotify's do
// instead of reshuffling on every repaint.

import { REGION_LANGS } from "../query.js";

export const DAY_MS = 86400000;
const HOUR = 3600000;
/// Recency half-life: a play from two weeks ago counts half of today's.
const HALF_LIFE_DAYS = 14;
/// A track heard inside this window is "fresh in the ear" and is pushed down
/// the Daily/Monthly mixes so they do not just replay the current session.
const REPEAT_WINDOW = 2 * HOUR;

// -------------------------------------------------------------------- seeds -
/// FNV-1a over a string — stable across runs, which is what makes a "daily"
/// seed actually daily.
export function hashSeed(input) {
  let h = 0x811c9dc5;
  const s = String(input == null ? "" : input);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/// Small deterministic PRNG. Same seed → same sequence, so a mix built twice in
/// one day is identical.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Local calendar-day number (not UTC): the mix rolls over at local midnight.
export function dayIndex(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

export function monthIndex(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  return d.getFullYear() * 12 + d.getMonth();
}

/// Fisher–Yates with an injected PRNG.
export function shuffleSeeded(list, rand) {
  const a = Array.isArray(list) ? list.slice() : [];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// -------------------------------------------------------------- normalizing -
const str = (v) => String(v == null ? "" : v).trim();

/// One track shape for every source (plays log, favourites, vault entries,
/// SQLite rows), so the mix builders never need to know where a row came from.
export function normTrack(t) {
  if (!t || typeof t !== "object") return null;
  const id = str(t.id);
  const title = str(t.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    artist: str(t.artist),
    album: str(t.album),
    image: str(t.image),
    duration: str(t.duration),
    duration_secs: Number(t.duration_secs) || 0,
    hq: !!t.hq,
    plays: Number(t.plays) || 0,
    year: str(t.year),
    language: str(t.language),
    // `ts`/`count` are the local shapes; `last_played`/`play_count` are what the
    // SQLite ledger (store.rs SongRow) speaks — accept both so the log from
    // either source feeds the same profile.
    ts: Number(t.ts != null ? t.ts : t.last_played) || 0,
    count: Number(t.count != null ? t.count : t.play_count) || 0,
  };
}

/// First occurrence wins; later copies only fill in fields the first one was
/// missing (a vault row has quality metadata, a play row has the timestamp).
export function mergeTracks(lists) {
  const byId = new Map();
  for (const list of lists || []) {
    for (const raw of list || []) {
      const t = normTrack(raw);
      if (!t) continue;
      const prev = byId.get(t.id);
      if (!prev) {
        byId.set(t.id, { ...t });
        continue;
      }
      for (const k of ["artist", "album", "image", "duration", "year", "language", "hq"]) {
        if (!prev[k] && t[k]) prev[k] = t[k];
      }
      prev.duration_secs = prev.duration_secs || t.duration_secs;
      prev.plays = Math.max(prev.plays, t.plays);
      prev.ts = Math.max(prev.ts, t.ts);
      prev.count = Math.max(prev.count, t.count);
    }
  }
  return [...byId.values()];
}

/// Slugs a track speaks, lowercased ("Hindi, Punjabi" → ["hindi","punjabi"]).
export function trackLangs(t) {
  return str(t && t.language)
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/// Decade a track belongs to (1990 / 2010 / 0 when unknown).
export function decadeOf(t) {
  const y = parseInt(str(t && t.year).slice(0, 4), 10);
  return Number.isFinite(y) && y > 1900 ? Math.floor(y / 10) * 10 : 0;
}

// ------------------------------------------------------------------ profile -
/// Build the taste profile every mix reads. All inputs are optional; an empty
/// profile simply yields no shelves.
export function buildProfile({ plays, favs, downloads, library, extra, country, now } = {}) {
  const at = Number(now) || Date.now();
  const all = mergeTracks([plays, favs, downloads, library, extra]);
  const favIds = new Set((favs || []).map((f) => str(f && f.id)).filter(Boolean));
  const dlIds = new Set((downloads || []).map((d) => str(d && d.id)).filter(Boolean));
  const libIds = new Set((library || []).map((l) => str(l && l.id)).filter(Boolean));

  // Per-track aggregate: latest play + total plays (the log itself only keeps
  // one row per track, but `extra` from SQLite carries a real counter).
  const byId = new Map();
  for (const t of all) {
    byId.set(t.id, { ...t, lastPlayed: t.ts || 0, plays: Math.max(t.count, t.plays, 0) });
  }
  for (const p of plays || []) {
    const id = str(p && p.id);
    const row = id && byId.get(id);
    if (!row) continue;
    row.lastPlayed = Math.max(row.lastPlayed, Number(p.ts) || 0);
    row.plays = Math.max(row.plays, Number(p.count) || 0);
  }

  const decay = (ts) => {
    if (!ts) return 0.15; // known but never timestamped: weak evidence
    const ageDays = Math.max(0, (at - ts) / DAY_MS);
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  };

  // Explicit feedback is worth far more than a single stream — a heart or a
  // download is a deliberate statement, a play could be a skip.
  const artistWeight = new Map();
  const languageWeight = new Map();
  const decadeWeight = new Map();
  const albumWeight = new Map();
  const bump = (map, key, by) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + by);
  };
  for (const t of byId.values()) {
    let w = 1 + Math.log10(t.plays + 1) * 2; // popularity term, log-scaled
    w *= 0.35 + 0.65 * decay(t.lastPlayed); // freshness term
    if (favIds.has(t.id)) w += 3;
    if (dlIds.has(t.id)) w += 2.5;
    if (libIds.has(t.id)) w += 2;
    for (const lang of trackLangs(t)) bump(languageWeight, lang, w);
    bump(decadeWeight, decadeOf(t), w);
    bump(albumWeight, t.album.toLowerCase(), w);
    // A "feat." credit should not outweigh the lead artist.
    const leads = t.artist.split(/[,;&]|\bfeat\b|\bft\b|\bwith\b/i).map(str).filter(Boolean);
    leads.forEach((name, i) => bump(artistWeight, name, w * (i === 0 ? 1 : 0.35)));
  }

  // Listening patterns: when this listener actually listens. Used for the
  // time-of-day mix and for the "your evenings" style subtitles.
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  for (const p of plays || []) {
    const ts = Number(p && p.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const d = new Date(ts);
    hours[d.getHours()] += 1;
    weekdays[d.getDay()] += 1;
  }

  const tracks = [...byId.values()];
  const topArtists = [...artistWeight.entries()]
    .map(([artist, weight]) => ({ artist, weight }))
    .sort((a, b) => b.weight - a.weight);
  const topLanguages = [...languageWeight.entries()]
    .map(([language, weight]) => ({ language, weight }))
    .sort((a, b) => b.weight - a.weight);

  const sad = new Set();
  for (const raw of favs || []) {
    const t = normTrack(raw);
    if (t) sad.add(t.id);
  }

  return {
    now: at,
    country: str(country).toUpperCase(),
    tracks,
    byId,
    favourites: sad,
    downloaded: dlIds,
    saved: libIds,
    artistWeight,
    languageWeight,
    decadeWeight,
    albumWeight,
    topArtists,
    topLanguages,
    hours,
    weekdays,
    /// Tracks in the log with a timestamp, most recent first.
    recent: tracks.filter((t) => t.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed),
    /// The vault as it was handed in (kept in the vault's own order).
    vault: mergeTracks([downloads]),
  };
}

/// Which slice of the day a listener is in — the axis the time-of-day mix and
/// its copy both use.
export function daypart(hour) {
  const h = Number(hour);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

const DAYPART_COPY = {
  morning: { title: "Morning Mix", tag: "AM" },
  afternoon: { title: "Afternoon Mix", tag: "PM" },
  evening: { title: "Evening Mix", tag: "PM" },
  night: { title: "Late Night Mix", tag: "NIGHT" },
};

/// Hour buckets that belong to the same slice, so "morning" is 5–11, etc.
function daypartHours(part) {
  if (part === "morning") return [5, 6, 7, 8, 9, 10, 11];
  if (part === "afternoon") return [12, 13, 14, 15, 16];
  if (part === "evening") return [17, 18, 19, 20, 21];
  return [22, 23, 0, 1, 2, 3, 4];
}

/// Languages this listener's country leans towards (query.js owns the table).
export function countryLangs(country) {
  return REGION_LANGS[str(country).toUpperCase()] || [];
}

// ------------------------------------------------------------------- scoring -
function affinity(profile, t) {
  let s = 0;
  for (const name of t.artist.split(/[,;&]|\bfeat\b|\bft\b|\bwith\b/i).map(str).filter(Boolean)) {
    s += profile.artistWeight.get(name) || 0;
  }
  for (const lang of trackLangs(t)) s += (profile.languageWeight.get(lang) || 0) * 0.6;
  s += (profile.decadeWeight.get(decadeOf(t)) || 0) * 0.25;
  s += (profile.albumWeight.get(t.album.toLowerCase()) || 0) * 0.2;
  if (profile.favourites.has(t.id)) s += 4;
  if (profile.downloaded.has(t.id)) s += 3;
  if (profile.saved.has(t.id)) s += 2;
  return s;
}

/// Negative freshness term: what was on repeat minutes ago should not open the
/// Daily Mix again.
function freshness(profile, t, now) {
  if (!t.lastPlayed) return 0;
  const age = now - t.lastPlayed;
  if (age < 0) return 0;
  if (age < REPEAT_WINDOW) return 6;
  if (age < DAY_MS) return 2.5;
  return 0;
}

/// Rank the whole known pool for one listener, then take a window.
function rankPool(profile, { now, taste = 1, freshnessWeight = 1, pool } = {}) {
  const at = Number(now) || profile.now || Date.now();
  const list = pool || profile.tracks;
  return list
    .map((t) => ({ t, s: affinity(profile, t) * taste - freshness(profile, t, at) * freshnessWeight }))
    .sort((a, b) => b.s - a.s || (b.t.plays || 0) - (a.t.plays || 0) || b.t.lastPlayed - a.t.lastPlayed || String(a.t.title).localeCompare(String(b.t.title)))
    .map((x) => x.t);
}

/// Seeded rotation: affinity picks the window, the day/month seed decides the
/// order inside it, so the mix is stable within its period but not frozen. The
/// window is wider than `n` so consecutive periods genuinely differ.
function rotate(ranked, { n, seed, spread = 2.2 }) {
  const window = Math.max(n, Math.min(ranked.length, Math.ceil(n * spread)));
  const rand = mulberry32(seed);
  return shuffleSeeded(ranked.slice(0, window), rand).concat(ranked.slice(window)).slice(0, n);
}

// ----------------------------------------------------------------- mixes ----
/// Daily Mix — the signature shelf: rotated once per local day.
export function dailyMix(profile, { n = 25, now, slot = 1 } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const seed = hashSeed(`daily:${dayIndex(at)}:${slot}:${profile.topArtists[0] ? profile.topArtists[0].artist : ""}`);
  return rotate(rankPool(profile, { now: at }), { n, seed, spread: 2.6 });
}

/// Monthly Mix — this month's rotation, weighted towards tracks actually
/// played inside the month window.
export function monthlyMix(profile, { n = 40, now } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const since = at - 31 * DAY_MS;
  const inMonth = profile.tracks.filter((t) => t.lastPlayed >= since);
  const pool = inMonth.length >= Math.min(n, 8) ? inMonth : profile.tracks;
  const seed = hashSeed(`month:${monthIndex(at)}:${profile.topLanguages[0] ? profile.topLanguages[0].language : ""}`);
  return rotate(rankPool(profile, { now: at, pool, freshnessWeight: 0.5 }), { n, seed, spread: 1.8 });
}

/// On Repeat — strictly the play counter, no novelty.
export function onRepeatMix(profile, { n = 20 } = {}) {
  if (!profile) return [];
  return profile.tracks
    .filter((t) => t.plays > 0)
    .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed)
    .slice(0, n);
}

/// Recently played, one row per track.
export function recentlyPlayedMix(profile, { n = 20 } = {}) {
  if (!profile) return [];
  return profile.recent.slice(0, n);
}

/// Rediscover — genuinely liked, but untouched for a while. How much it used
/// to be played and how long it has been away both matter, and they multiply:
/// a one-play track from two years ago must not out-rank a twelve-play track
/// the listener simply stopped playing last season.
export function rediscoverMix(profile, { n = 20, now, staleDays = 21 } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const cutoff = at - staleDays * DAY_MS;
  return profile.tracks
    .filter((t) => t.lastPlayed && t.lastPlayed < cutoff)
    .map((t) => {
      const loudness = Math.log10(t.plays + 1) * (1 + affinity(profile, t) / 10);
      const absence = 1 + Math.max(0, at - t.lastPlayed) / DAY_MS / 45;
      return { t, s: loudness * absence };
    })
    .sort((a, b) => b.s - a.s || b.t.plays - a.t.plays)
    .slice(0, n)
    .map((x) => x.t);
}

/// Liked songs — the explicit list, newest like first.
export function favoritesMix(profile, { n = 30 } = {}) {
  if (!profile) return [];
  const liked = profile.tracks.filter((t) => profile.favourites.has(t.id));
  return liked.sort((a, b) => b.lastPlayed - a.lastPlayed || String(a.title).localeCompare(String(b.title))).slice(0, n);
}

/// Everything already on disk — the offline shelf.
export function downloadsMix(profile, { n = 30 } = {}) {
  if (!profile) return [];
  return profile.vault.slice(0, n);
}

/// The listener's dominant language, if the log really is dominated by one.
/// `minShare` is the weighted share the leader must hold; below it the
/// listening is genuinely mixed and no language shelf should be invented.
export function topLanguage(profile, { minShare = 0.4 } = {}) {
  if (!profile || !profile.topLanguages.length) return "";
  const total = profile.topLanguages.reduce((s, x) => s + x.weight, 0);
  if (!total) return "";
  const top = profile.topLanguages[0];
  return top.weight / total >= minShare && top.weight > 0 ? top.language : "";
}

export function languageMix(profile, { n = 25, now, language = "" } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const lang = language || topLanguage(profile);
  if (!lang) return [];
  const pool = profile.tracks.filter((t) => trackLangs(t).includes(lang));
  if (pool.length < 4) return [];
  const seed = hashSeed(`lang:${lang.toLowerCase()}:${profile.topArtists[0] ? profile.topArtists[0].artist : ""}`);
  return rotate(rankPool(profile, { now: at, pool }), { n, seed, spread: 2 });
}

/// Region mix — what the listener's own country tends to listen to. Requires
/// a country preference, and falls back to nothing (better an absent shelf
/// than an invented one).
export function countryMix(profile, { n = 25, now } = {}) {
  if (!profile || !profile.country || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const langs = countryLangs(profile.country);
  if (!langs.length) return [];
  const pool = profile.tracks.filter((t) => trackLangs(t).some((l) => langs.includes(l)));
  if (pool.length < 4) return [];
  const seed = hashSeed(`country:${profile.country}:${dayIndex(at)}`);
  return rotate(rankPool(profile, { now: at, pool }), { n, seed, spread: 2.2 });
}

/// Time-of-day mix built from this listener's own hour histogram.
export function timeOfDayMix(profile, { n = 25, now } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const hour = new Date(at).getHours();
  const part = daypart(hour);
  const buckets = daypartHours(part);
  // Tracks this listener has played in the same slice of the day before.
  const matched = new Set();
  for (const t of profile.tracks) {
    if (t.lastPlayed && buckets.includes(new Date(t.lastPlayed).getHours())) matched.add(t.id);
  }
  const pool = profile.tracks.filter((t) => matched.has(t.id));
  if (pool.length < 4) return [];
  return rankPool(profile, { now: at, pool, freshnessWeight: 0.5 }).slice(0, n);
}

export function daypartTitle(hour) {
  return DAYPART_COPY[daypart(hour)].title;
}

export function daypartTag(hour) {
  return DAYPART_COPY[daypart(hour)].tag;
}

// ----------------------------------------------------------------- shelves --
/// The shelf plan Home renders: an ordered list of `{ id, title, tag, tracks }`
/// with empty shelves dropped, so Home never shows a card with nothing behind
/// it. `limit` caps each shelf.
export function shelfPlan(profile, { now, limit = 20, include = null, language = "" } = {}) {
  if (!profile || !profile.tracks.length) return [];
  const at = Number(now) || profile.now;
  const want = (id) => !include || include.includes(id);
  // An explicit language pick (Settings → Music language) outranks what the
  // log merely leans towards; both still fall back to the observed one.
  const lang = language || topLanguage(profile);
  const hour = new Date(at).getHours();
  const plan = [
    { id: "daily", title: "Daily Mix", tag: "MADE FOR YOU", tracks: want("daily") ? dailyMix(profile, { n: limit, now: at }) : [] },
    { id: "monthly", title: "Monthly Mix", tag: "THIS MONTH", tracks: want("monthly") ? monthlyMix(profile, { n: limit, now: at }) : [] },
    { id: "daypart", title: daypartTitle(hour), tag: daypartTag(hour), tracks: want("daypart") ? timeOfDayMix(profile, { n: limit, now: at }) : [] },
    { id: "language", title: lang ? `${lang[0].toUpperCase()}${lang.slice(1)} Picks` : "Language Picks", tag: "YOUR LANGUAGE", tracks: want("language") ? languageMix(profile, { n: limit, now: at, language: lang }) : [] },
    { id: "country", title: "Top in Your Region", tag: profile.country || "REGION", tracks: want("country") ? countryMix(profile, { n: limit, now: at }) : [] },
    { id: "onrepeat", title: "On Repeat", tag: "HEAVY ROTATION", tracks: want("onrepeat") ? onRepeatMix(profile, { n: limit }) : [] },
    { id: "rediscover", title: "Rediscover", tag: "THROWBACK", tracks: want("rediscover") ? rediscoverMix(profile, { n: limit, now: at }) : [] },
    { id: "favorites", title: "Your Favorites", tag: "LIKED", tracks: want("favorites") ? favoritesMix(profile, { n: limit }) : [] },
    { id: "downloads", title: "Downloaded", tag: "OFFLINE", tracks: want("downloads") ? downloadsMix(profile, { n: limit }) : [] },
    { id: "recent", title: "Recently Played", tag: "HISTORY", tracks: want("recent") ? recentlyPlayedMix(profile, { n: limit }) : [] },
  ];
  return plan.filter((s) => s.tracks.length);
}

/// One-line "why" for the mix, used as the shelf subtitle.
export function explain(profile, shelf) {
  if (!shelf) return "";
  const top = profile && profile.topArtists[0];
  const bits = [];
  if (shelf.id === "daily" || shelf.id === "monthly") {
    if (top) bits.push(top.artist);
    const langs = (profile.topLanguages || []).slice(0, 2).map((l) => l.language[0].toUpperCase() + l.language.slice(1));
    if (langs.length) bits.push(langs.join(" / "));
    if (profile.country) bits.push(profile.country);
  } else if (shelf.id === "language") {
    if (top) bits.push(top.artist);
  }
  return bits.join(" · ");
}
