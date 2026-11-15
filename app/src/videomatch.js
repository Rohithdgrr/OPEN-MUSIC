// videomatch.js — track → YouTube video decision plane (pure, DOM-free).
//
// Why this exists: the Now Playing backdrop needs an honest answer to "which
// video IS this song?". InnerTube search puts the right track at row 1 and a
// "Dance Mix" at row 2 (measured 2026-11-14, docs/song-video.md §13.2), so
// trusting row order ships the wrong picture. Every *decision* lives here —
// query building, scoring, kind, rendition, cache policy, metadata merge.
// *Transport* (the InnerTube POSTs, the loopback relay) stays out of this
// file, so `node --test` covers it with no DOM and no network.
//
// Contract: docs/song-video.md §5–§7, §10.2.
// Same shape as spotmatch.js: pure functions in, plain data out.

import { editSim, querySim } from "./fuzzy.js";
import { cleanTitle } from "./query.js";

// ── Tunables (documented in §6) ────────────────────────────────────────────

/// Below this the answer is "no video" — the art fallback is already good, and
/// a wrong backdrop is worse than a still one.
export const ACCEPT_THRESHOLD = 0.62;
/// A score carried by artist + duration with a weak title is still the wrong
/// song; the title gate is absolute. 0.70 — measured, not guessed: the live
/// probe (docs/song-video.md §13.5) accepted "Khairiyat (Bonus Track)" at
/// titleSim 0.56 / score 0.750 against a Kesariya query, purely on the same
/// artist and the same duration. Right-song rows score ≥0.95 because title
/// variants already strip brackets and suffixes, so 0.70 costs no true match.
export const TITLE_MIN = 0.7;
/// Right title + unrecognizable credit + wrong length = tribute cover.
export const CREDIT_MIN = 0.3;

/// Ambient backdrop height cap. 1080p is opt-in only ("full video").
export const MAX_HEIGHT = 720;
export const FULL_HEIGHT = 1080;

/// Cache tiers (docs/cache-architecture.md, no new machinery).
export const MATCH_TTL_S = 6 * 60 * 60; // L1 moka: plan sans URL
export const URL_TTL_S = 30 * 60; // L1 moka: resolved CDN URL
export const NEGATIVE_TTL_S = 24 * 60 * 60; // L2 SQLite: one search, not one per paint
export const UNAVAILABLE_RETRY_S = 5 * 60; // provider error / gated

// ── InnerTube client constants (protocol facts, no GPL source) ─────────────
//
// Both reference clients are GPL-3.0; this app is MIT. These are *observed
// protocol facts* (§1, §12.1): endpoint, header names, client version, and
// the public web API key. The iOS family is the load-bearing one — it answers
// with plain `url` fields, so no player-JS deciphering and no PO token.

export const INNERTUBE = {
  searchUrl: "https://music.youtube.com/youtubei/v1/search",
  playerUrl: "https://www.youtube.com/youtubei/v1/player",
  webRemix: {
    key: "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30",
    clientName: "WEB_REMIX",
    clientVersion: "1.20250219.01.00",
  },
  ios: {
    key: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
    clientName: "IOS",
    clientVersion: "20.10.4",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  },
  /// Song-only search filter (albums/playlists/artists excluded). "\"EgWKAQIIAWoKEAkQBRAKEAMQBA==\"" url-encoded.
  songsFilterParams: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
};

/// Search body — exactly what the caller POSTs (§2.2). Pure data so the shape
/// is testable and the Rust port has one reference.
export function searchRequest(query, opts = {}) {
  const c = INNERTUBE.webRemix;
  return {
    context: {
      client: { clientName: c.clientName, clientVersion: c.clientVersion, hl: "en", gl: opts.gl || "US" },
    },
    query: String(query || ""),
    params: opts.params === null ? undefined : opts.params || INNERTUBE.songsFilterParams,
  };
}

/// Player body (§2.1). The iOS client is what makes the URL plain.
export function playerRequest(videoId, opts = {}) {
  const c = INNERTUBE.ios;
  return {
    context: {
      client: {
        clientName: c.clientName,
        clientVersion: c.clientVersion,
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.3.2.22D82",
        hl: "en",
        gl: opts.gl || "US",
      },
    },
    videoId: String(videoId || ""),
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

// ── Small text helpers ─────────────────────────────────────────────────────

/// Extra provenance inside a title, e.g. `Kesariya (From "Brahmastra")` → the
/// film name. Same trick as query.js §8.11: the film usually rides in the
/// title, while the *album* field is a compilation.
export function fromClause(title) {
  const m = String(title || "").match(/\(\s*from\s*["“']([^"”']+)["”']\s*\)/i);
  return m ? m[1].trim() : "";
}

/// Credit list from either shape the app sees: an array (Spotify import) or a
/// padded catalog string ("Irshad Kamil, Arijit Singh, Pritam").
export function creditParts(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/\s*(?:,|&|\bfeat\.?|\bft\.)\s*/i);
  const out = [];
  for (const item of raw) {
    const s = String(item || "").trim();
    if (s) out.push(s);
  }
  return out;
}

/// `"4:29"` → 269. `"1:02:03"` → 3723. Anything else → 0.
export function parseDuration(text) {
  const m = String(text || "").trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const [, a, b, c] = m;
  return c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
}

/// `"973M plays"` → 973000000. `"1.2B"` → 1.2e9. `"1,234"` → 1234. Unknown → 0.
export function parsePlayCount(text) {
  const s = String(text || "").toLowerCase().replace(/,/g, "");
  const m = s.match(/([\d.]+)\s*([kmb])?/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = m[2] === "b" ? 1e9 : m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

/// Title variants to compare: raw, from-clause removed, brackets stripped,
/// trailing `- Remastered 2011` family suffix removed. Lowercased.
export function titleVariants(title) {
  const raw = String(title || "").toLowerCase().trim();
  if (!raw) return [];
  const out = [raw];
  const cleaned = cleanTitle(raw);
  if (cleaned && cleaned !== raw) out.push(cleaned);
  for (const base of [raw, cleaned]) {
    const bare = base
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/\s*[-–]\s*(remaster(ed)?|radio edit|single version|album version|explicit|version)\b.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (bare && !out.includes(bare)) out.push(bare);
  }
  return out;
}

function sim(a, b) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return 0;
  return Math.max(editSim(x, y), querySim(x, y));
}

/// Best title similarity across both sides' variants.
export function titleSim(wantTitle, candTitle) {
  let best = 0;
  for (const w of titleVariants(wantTitle)) {
    for (const c of titleVariants(candTitle)) {
      const s = sim(w, c);
      if (s > best) best = s;
    }
  }
  return best;
}

/// Best credit-pair agreement. Catalogs pad credits and video rows can carry
/// the whole list, so this compares every pair and takes the strongest — the
/// singer is often not the first name in a JioSaavn credit string.
export function creditSim(wantParts, candParts) {
  if (!wantParts.length || !candParts.length) return 0;
  let best = 0;
  for (const a of wantParts) {
    for (const b of candParts) {
      const s = sim(a, b);
      if (s > best) best = s;
    }
  }
  return best;
}

/// Duration agreement: 1 within 7 s, 0.5 within 20 s, 0.15 beyond.
/// 0.7 when either side is unknown (kept for callers/tests; scoring treats an
/// unknown side as *no evidence* and redistributes its weight — see scoreParts).
export function durationFactor(wantSecs, candSecs) {
  const a = Number(wantSecs);
  const b = Number(candSecs);
  if (!(a > 0) || !(b > 0)) return 0.7;
  const diff = Math.abs(a - b);
  if (diff <= 7) return 1;
  if (diff <= 20) return 0.5;
  return 0.15;
}

/// Log-scaled plays, used only as a tiebreaker (0.05 weight).
export function popularityFactor(plays) {
  const n = Number(plays) || 0;
  if (n <= 0) return 0;
  return Math.min(1, Math.log10(n + 10) / 10);
}

// Rows that are *not the song*. Word-boundary matched so "Undercover" and
// "Discovery" are safe.
const HARD_VARIANTS = [
  "karaoke", "cover", "tribute", "8d", "slowed", "reverb", "sped up",
  "nightcore", "instrumental", "reaction", "mashup", "parody", "ringtone",
  "ai cover", "fan made",
];
// Different performance of the same song: honest for a "live" or "remix"
// search, wrong for a studio track.
const SOFT_VARIANTS = ["remix", "dance mix", "reprise", "unplugged", "acoustic", "live"];

function hasWord(haystack, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(haystack);
}

/// How much to demote a candidate whose own title says it is a different
/// artefact. `query` is what the user/player asked for: a "remix" search keeps
/// remixes.
export function versionPenalty(query, candText) {
  const q = String(query || "").toLowerCase();
  const c = String(candText || "").toLowerCase();
  let penalty = 0;
  for (const word of HARD_VARIANTS) {
    if (hasWord(c, word) && !hasWord(q, word)) penalty += 0.45;
  }
  for (const word of SOFT_VARIANTS) {
    if (hasWord(c, word) && !hasWord(q, word)) penalty += 0.25;
  }
  return Math.min(1, penalty);
}

// ── Query building (§5) ────────────────────────────────────────────────────

/// The catalog track, normalized to what scoring needs.
export function normalizeTrack(track = {}) {
  const rawTitle = String(track.title || track.name || "");
  const artists = creditParts(track.artists != null ? track.artists : track.artist);
  const from = fromClause(rawTitle);
  const album = String(track.album || from || "").trim();
  const durationSrc = track.durationSecs != null ? track.durationSecs : track.duration_secs != null ? track.duration_secs : track.duration_ms != null ? Number(track.duration_ms) / 1000 : 0;
  return {
    id: String(track.id || ""),
    title: cleanTitle(rawTitle) || rawTitle,
    rawTitle,
    artists,
    album,
    durationSecs: Number(durationSrc) || 0,
    isrc: String(track.isrc || ""),
  };
}

/// `"<title> <first artist> <album>"`, with the `(From "Film")` clause lifted
/// out of the title and re-attached as album text — the query.js::cleanTitle
/// trick, because the film is what disambiguates in a padded catalog.
export function buildSearchQuery(track = {}) {
  const t = normalizeTrack(track);
  const query = [t.title, t.artists[0] || "", t.album && t.album !== t.title ? t.album : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { query, title: t.title, artist: t.artists[0] || "", album: t.album, fromClause: fromClause(t.rawTitle), track: t };
}

// ── Response parsing (mechanical, no judging) ───────────────────────────────

function runsText(text) {
  if (!text) return "";
  if (Array.isArray(text.runs)) return text.runs.map((r) => r.text || "").join("");
  return text.simpleText || "";
}

function findVideoId(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return "";
  if (typeof node.videoId === "string" && node.videoId) return node.videoId;
  for (const key of Object.keys(node)) {
    if (key === "watchEndpoint" || key === "watchPlaylistEndpoint") continue;
    const found = findVideoId(node[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function collectRenderers(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRenderers(item, out);
    return;
  }
  if (node.musicResponsiveListItemRenderer) {
    out.push(node.musicResponsiveListItemRenderer);
    return; // do not descend: its children are the same row
  }
  for (const key of Object.keys(node)) collectRenderers(node[key], out);
}

/// Two columns naming the same thing — YT Music echoes the song name in the
/// album slot for singles, and calling that an album would invent metadata.
function sameName(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const x = norm(a);
  return !!x && x === norm(b);
}

/// One search row → candidate. Column 0 is the title; column 1 is a
/// "•"-separated credit line holding artist(s), album and the duration.
export function rowFromRenderer(row) {
  if (!row) return null;
  const cols = (row.flexColumns || []).map((c) => runsText(c && c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text));
  const title = (cols[0] || "").trim();
  if (!title) return null;
  // YT Music answers with artist/album/duration in column 1 and the play count
  // in column 2 (measured, §13.2); older fixtures put everything in column 1.
  // Joining every column after the title reads both layouts without guessing.
  const detail = cols
    .slice(1)
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" • ");
  const pieces = detail.split("•").map((p) => p.trim()).filter(Boolean);
  let durationSecs = 0;
  let plays = 0;
  const credit = [];
  for (const piece of pieces) {
    if (!durationSecs && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(piece)) {
      durationSecs = parseDuration(piece);
      continue;
    }
    if (!plays && /plays?\b/i.test(piece)) {
      plays = parsePlayCount(piece);
      continue;
    }
    credit.push(piece);
  }
  const videoId = (row.playlistItemData && row.playlistItemData.videoId) || findVideoId(row) || "";
  if (!videoId) return null;
  // Drop a "credit" that merely echoes the title; the last remaining piece is
  // the album when there is more than one.
  const meaningful = credit.filter((p) => !sameName(p, title));
  const creditText = meaningful.join(", ");
  return {
    videoId,
    title,
    credit: creditText,
    parts: creditParts(creditText),
    album: meaningful.length > 1 ? meaningful[meaningful.length - 1] : "",
    durationSecs,
    plays,
    channel: "",
  };
}

/// Full search response → candidates. Walks for the row renderer rather than
/// pinning a fixed path, so a layout shuffle does not silently yield zero
/// candidates (which would read as "song has no video").
export function parseSearchRows(json) {
  const rows = [];
  collectRenderers(json, rows);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const cand = rowFromRenderer(row);
    if (!cand || seen.has(cand.videoId)) continue;
    seen.add(cand.videoId);
    out.push(cand);
  }
  return out;
}

/// Player response → normalized adaptive formats.
export function playerFormats(json) {
  const sd = (json && json.streamingData) || {};
  const list = sd.adaptiveFormats || [];
  return list
    .map((f) => ({
      itag: Number(f.itag) || 0,
      mimeType: String(f.mimeType || ""),
      url: String(f.url || ""),
      hasCipher: !f.url && !!(f.signatureCipher || f.cipher),
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      fps: Number(f.fps) || 0,
      sizeBytes: Number(f.contentLength) || 0,
      quality: String(f.qualityLabel || ""),
    }))
    .filter((f) => f.itag > 0 && f.mimeType);
}

/// Playability + identity from the player response.
export function playability(json) {
  const s = (json && json.playabilityStatus) || {};
  const d = (json && json.videoDetails) || {};
  return {
    status: String(s.status || "UNKNOWN"),
    reason: String(s.reason || ""),
    videoId: String(d.videoId || ""),
    title: String(d.title || ""),
    lengthSeconds: Number(d.lengthSeconds) || 0,
  };
}

// ── Scoring (§6.1) ─────────────────────────────────────────────────────────

/// Weights fold into the title when a signal is *absent on both sides*: a
/// title-only probe or a duration-less catalog row must not be capped below
/// the accept bar by weight reserved for evidence that does not exist.
export function scoreParts(want, cand) {
  const t = titleSim(want.title, cand.title);
  const aKnown = want.artists.length > 0 && cand.parts.length > 0;
  const a = aKnown ? creditSim(want.artists, cand.parts) : 0;
  const dKnown = want.durationSecs > 0 && cand.durationSecs > 0;
  const d = dKnown ? durationFactor(want.durationSecs, cand.durationSecs) : 0;
  const p = popularityFactor(cand.plays);
  const pen = versionPenalty(want.query, `${cand.title} ${cand.credit}`);

  const w = { title: 0.45, artist: 0.3, duration: 0.2, popularity: 0.05 };
  if (!aKnown) {
    w.title += w.artist * 0.8;
    w.popularity += w.artist * 0.2;
    w.artist = 0;
  }
  if (!dKnown) {
    w.title += w.duration * 0.5;
    w.popularity += w.duration * 0.5;
    w.duration = 0;
  }

  const raw = w.title * t + w.artist * a + w.duration * d + w.popularity * p - pen;
  return {
    score: Math.max(0, Math.min(1, raw)),
    titleSim: t,
    artistSim: a,
    durF: dKnown ? d : null,
    popF: p,
    penalty: pen,
  };
}

function wantFor(track) {
  const t = normalizeTrack(track);
  return { ...t, query: buildSearchQuery(track).query };
}

/// All candidates with their parts, strongest first. Ties broken by plays, then
/// by row order (a stable sort keeps upstream's ranking as the last word).
export function rankCandidates(track, candidates) {
  const want = wantFor(track);
  return (candidates || [])
    .map((candidate, index) => ({ candidate, index, parts: scoreParts(want, candidate) }))
    .sort((x, y) => y.parts.score - x.parts.score || y.candidate.plays - x.candidate.plays || x.index - y.index);
}

/// The honest pick: above the bar, title gate passed, no tribute-cover pattern.
export function pickBestCandidate(track, candidates) {
  const ranked = rankCandidates(track, candidates);
  const top = ranked[0];
  if (!top) return null;
  if (top.parts.score < ACCEPT_THRESHOLD) return null;
  if (top.parts.titleSim < TITLE_MIN) return null;
  // Right title, weak credit, wrong length → a cover wearing the song's name.
  if (top.parts.artistSim > 0 && top.parts.artistSim < CREDIT_MIN && top.parts.durF != null && top.parts.durF < 0.5) return null;
  return { candidate: top.candidate, score: top.parts.score, parts: top.parts };
}

// ── Kind (§6.2) ────────────────────────────────────────────────────────────

/// Kind drives rendering: `live` is ambient-only (it is not the studio take),
/// `unknown` gets no crop assumptions.
export function classifyKind(track, candidate) {
  const want = wantFor(track);
  const text = `${candidate.title} ${candidate.credit} ${candidate.channel}`.toLowerCase();
  const durAgrees = !!want.durationSecs && !!candidate.durationSecs && Math.abs(want.durationSecs - candidate.durationSecs) <= 20;
  if (hasWord(text, "lyric") || hasWord(text, "lyrics")) return durAgrees ? "lyric" : "unknown";
  if (hasWord(text, "visualizer") || hasWord(text, "visualiser")) return "visualizer";
  if (hasWord(text, "live") || (!!want.durationSecs && !!candidate.durationSecs && Math.abs(want.durationSecs - candidate.durationSecs) > 20)) return "live";
  const creditIsArtist = want.artists.length > 0 && creditSim(want.artists, candidate.parts) >= 0.6;
  const channelIsArtist = !!candidate.channel && creditSim(want.artists, creditParts(candidate.channel)) >= 0.6;
  if (durAgrees && (creditIsArtist || channelIsArtist || hasWord(text, "official"))) return "official";
  if (creditIsArtist || channelIsArtist) return "visualizer";
  return "unknown";
}

// ── Rendition (§7) ─────────────────────────────────────────────────────────

/// WebView compatibility order: H.264 → AV1 → VP9 → anything else mp4.
export function codecRank(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("avc1")) return 0;
  if (m.includes("av01")) return 1;
  if (m.includes("vp9") || m.includes("vp09")) return 2;
  if (m.startsWith("video/mp4")) return 3;
  return 4;
}

/// Pick one progressive video rendition. Never audio, never HLS/DASH, never a
/// ciphered format (no decipherer exists here — treat those as absent, not as
/// an error).
export function pickRendition(formats, opts = {}) {
  const maxHeight = Number(opts.maxHeight) || MAX_HEIGHT;
  const usable = (formats || []).filter((f) => f && f.url && !f.hasCipher && /^video\//i.test(String(f.mimeType || "")));
  if (!usable.length) return null;

  const palatable = usable.filter((f) => f.height > 0);
  const pool = palatable.length ? palatable : usable;
  const withinCap = pool.filter((f) => f.height <= maxHeight);
  const base = withinCap.length ? withinCap : pool;

  const bestCodec = Math.min(...base.map((f) => codecRank(f.mimeType)));
  const sameCodec = base.filter((f) => codecRank(f.mimeType) === bestCodec);
  const pick = sameCodec
    .slice()
    .sort((a, b) => b.height - a.height || (a.sizeBytes || 0) - (b.sizeBytes || 0))[0] || base.slice().sort((a, b) => b.height - a.height)[0];

  return {
    itag: pick.itag,
    mimeType: pick.mimeType,
    codec: codecRank(pick.mimeType),
    width: pick.width,
    height: pick.height || (pick.width ? Math.round((pick.width * 9) / 16) : 0),
    fps: pick.fps,
    sizeBytes: pick.sizeBytes,
    quality: pick.quality,
    url: pick.url,
  };
}

// ── Playback plan (§3.2) ───────────────────────────────────────────────────

const VIDEO_STATES = {
  ready: "ready",
  none: "none",
  expired: "expired",
  unavailable: "unavailable",
  pending: "pending",
};

/// The whole decision in one object. Always returns — "no video" is an
/// answer, never a throw.
export function pickPlaybackPlan(input = {}) {
  const track = input.track || input.want || {};
  const candidates = input.candidates || [];
  const formats = input.formats || [];
  const ranked = rankCandidates(track, candidates);
  const top = ranked[0] || null;
  const best = pickBestCandidate(track, candidates);

  if (!best) {
    return {
      state: VIDEO_STATES.none,
      reason: top ? "below threshold" : "no candidates",
      confidence: top ? Number(top.parts.score.toFixed(4)) : 0,
      topVideoId: top ? top.candidate.videoId : "",
    };
  }

  const rendition = formats.length ? pickRendition(formats, { maxHeight: input.maxHeight }) : null;
  if (formats.length && !rendition) {
    return {
      state: VIDEO_STATES.none,
      reason: "no usable rendition",
      confidence: Number(best.score.toFixed(4)),
      videoId: best.candidate.videoId,
    };
  }

  return {
    state: VIDEO_STATES.ready,
    reason: "",
    videoId: best.candidate.videoId,
    title: best.candidate.title,
    channel: best.candidate.channel,
    durationSecs: best.candidate.durationSecs,
    kind: classifyKind(track, best.candidate),
    confidence: Number(best.score.toFixed(4)),
    itag: rendition ? rendition.itag : 0,
    height: rendition ? rendition.height : 0,
    width: rendition ? rendition.width : 0,
    mimeType: rendition ? rendition.mimeType : "",
    sizeBytes: rendition ? rendition.sizeBytes : 0,
    url: rendition ? rendition.url : "",
  };
}

/// What the transport should persist for a plan. Stream URLs are never
/// persisted by the frontend and never outlive their TTL.
export function videoCachePolicy(plan = {}) {
  switch (plan.state) {
    case "ready":
      return { persistMatch: true, persistUrl: true, matchTtl: MATCH_TTL_S, urlTtl: URL_TTL_S, retryAfter: 0 };
    case "expired":
      return { persistMatch: true, persistUrl: false, matchTtl: MATCH_TTL_S, urlTtl: 0, retryAfter: 0 };
    case "unavailable":
      return { persistMatch: false, persistUrl: false, matchTtl: 0, urlTtl: 0, retryAfter: UNAVAILABLE_RETRY_S };
    case "pending":
      return { persistMatch: false, persistUrl: false, matchTtl: 0, urlTtl: 0, retryAfter: 0 };
    default:
      return { persistMatch: false, persistUrl: false, matchTtl: 0, urlTtl: 0, retryAfter: 0, negativeTtl: NEGATIVE_TTL_S };
  }
}

/// One-shot classification of a transport error into a state (§8.3). Kept pure
/// so the Rust side and the probe agree on the ladder.
export function stateForFailure(status, playabilityStatus) {
  const ps = String(playabilityStatus || "").toUpperCase();
  if (ps && ps !== "OK") return "none"; // LOGIN_REQUIRED / UNPLAYABLE / AGE_* → one search, then quiet
  const code = Number(status) || 0;
  if (code === 403 || code === 410) return "expired"; // URL aged out: re-resolve once
  if (code === 429 || code >= 500 || code === 0) return "unavailable";
  return "unavailable";
}

// ── Metadata enrichment (§10.2) ────────────────────────────────────────────

/// Fill gaps from the video row, never overwrite catalog-authoritative fields.
/// Every touched field carries its provenance so the UI can explain itself.
export function mergeMetadata(track, candidate) {
  const out = {
    title: String(track.title || ""),
    artist: String(track.artist || ""),
    album: String(track.album || ""),
    durationSecs: Number(track.duration_secs || track.durationSecs || 0) || 0,
    provenance: { title: "catalog", artist: "catalog", album: "catalog", duration: "catalog" },
  };
  if (!out.album && candidate && candidate.album) {
    out.album = cleanTitle(candidate.album);
    out.provenance.album = "video";
  }
  if (!out.durationSecs && candidate && candidate.durationSecs) {
    out.durationSecs = candidate.durationSecs;
    out.provenance.duration = "video";
  }
  if (!out.artist && candidate && candidate.credit) {
    out.artist = candidate.credit;
    out.provenance.artist = "video";
  }
  return out;
}
