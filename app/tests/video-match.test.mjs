// video-match.test.mjs — unit tests for the song-video decision plane
// (docs/song-video.md §6–§7, §10.2). Pure + offline: no network, no DOM.
// The fixtures are the *observed* InnerTube shapes recorded in §13.2, so the
// dance-mix-at-row-2 trap is reproduced rather than imagined.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const {
  ACCEPT_THRESHOLD,
  NEGATIVE_TTL_S,
  URL_TTL_S,
  INNERTUBE,
  buildSearchQuery,
  fromClause,
  creditParts,
  parseDuration,
  parsePlayCount,
  titleVariants,
  durationFactor,
  versionPenalty,
  parseSearchRows,
  playerFormats,
  playability,
  rankCandidates,
  pickBestCandidate,
  classifyKind,
  pickRendition,
  pickPlaybackPlan,
  videoCachePolicy,
  stateForFailure,
  mergeMetadata,
  searchRequest,
  playerRequest,
} = await import("../src/videomatch.js");

// ── fixtures ───────────────────────────────────────────────────────────────

/// One `musicResponsiveListItemRenderer` in the real column shape.
const row = ({ videoId, title, detail }) => ({
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: detail }] } } },
  ],
  playlistItemData: { videoId },
});

const searchJson = (rows) => ({
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [{ musicShelfRenderer: { contents: rows.map((r) => ({ musicResponsiveListItemRenderer: row(r) })) } }],
              },
            },
          },
        },
      ],
    },
  },
});

// The three measured rows for a Kesariya query (§13.2), verbatim.
const KESARIYA_ROWS = [
  { videoId: "NJAv_7lHUIU", title: 'Kesariya (From "Brahmastra")', detail: 'Arijit Singh • Kesariya (From "Brahmastra") • 4:29 • 973M plays' },
  { videoId: "ZczAI-GNFbk", title: 'Kesariya (From "Brahmastra") (Dance Mix)', detail: "Pritam, Shashwat Singh, Antara Mitra & Arijit Singh • 3:18 • 100M plays" },
  { videoId: "yvJUED4ulPU", title: "Rasiya Reprise", detail: "Pritam & Arijit Singh • Brahmastra (OST) • 4:45 • 17M plays" },
];

const kesariya = { id: "catalog-1", title: 'Kesariya (From "Brahmastra")', artist: "Arijit Singh, Pritam, Amitabh Bhattacharya", album: "", duration_secs: 269 };

const fmt = (itag, mimeType, width, height, contentLength, extra = {}) => ({
  itag,
  mimeType,
  width,
  height,
  contentLength: String(contentLength),
  fps: 30,
  qualityLabel: `${height}p`,
  url: "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1",
  ...extra,
});

const FORMATS = playerFormats({
  streamingData: {
    adaptiveFormats: [
      fmt(137, 'video/mp4; codecs="avc1.640028"', 1920, 1080, 116495956),
      fmt(399, 'video/mp4; codecs="av01.0.08M.08"', 1920, 1080, 64641076),
      fmt(136, 'video/mp4; codecs="avc1.64001F"', 1280, 720, 41931014),
      fmt(247, 'video/webm; codecs="vp9"', 1280, 720, 51188490),
      fmt(135, 'video/mp4; codecs="avc1.4d401f"', 854, 480, 28414767),
      fmt(134, 'video/mp4; codecs="avc1.4d401e"', 640, 360, 18220768),
      fmt(160, 'video/mp4; codecs="avc1.4d400c"', 256, 144, 3565916),
      { itag: 999, mimeType: 'video/mp4; codecs="avc1"', width: 1280, height: 720, contentLength: "1", signatureCipher: "s=abc" },
      fmt(140, 'audio/mp4; codecs="mp4a.40.2"', 0, 0, 4633058),
      fmt(251, 'audio/webm; codecs="opus"', 0, 0, 4614789),
    ],
  },
});

// ── query building (§5) ────────────────────────────────────────────────────

test("buildSearchQuery — lifts the film out of the title into the query", () => {
  const q = buildSearchQuery(kesariya);
  assert.equal(q.title, "Kesariya");
  assert.equal(q.artist, "Arijit Singh");
  assert.equal(q.album, "Brahmastra");
  assert.equal(q.query, "Kesariya Arijit Singh Brahmastra");
  assert.equal(q.fromClause, "Brahmastra");
});

test("buildSearchQuery — prefers the real album when the title has no provenance", () => {
  const q = buildSearchQuery({ title: "Believer", artists: ["Imagine Dragons"], album: "Evolve", durationSecs: 204 });
  assert.equal(q.query, "Believer Imagine Dragons Evolve");
});

test("normalization helpers", () => {
  assert.equal(fromClause("Tum Hi Ho (From \"Aashiqui 2\")"), "Aashiqui 2");
  assert.equal(fromClause("Believer"), "");
  assert.deepEqual(creditParts("Pritam, Shashwat Singh & Antara Mitra"), ["Pritam", "Shashwat Singh", "Antara Mitra"]);
  assert.deepEqual(creditParts(["Arijit Singh"]), ["Arijit Singh"]);
  assert.equal(parseDuration("4:29"), 269);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("n/a"), 0);
  assert.equal(parsePlayCount("973M plays"), 973000000);
  assert.equal(parsePlayCount("1.2B"), 1200000000);
  assert.equal(parsePlayCount("1,234"), 1234);
  assert.equal(parsePlayCount("—"), 0);
  assert.ok(titleVariants('Kesariya (From "Brahmastra")').includes("kesariya"));
});

// ── parsing (§2.2) ─────────────────────────────────────────────────────────

test("parseSearchRows — reads videoId, duration and plays off the measured shape", () => {
  const cands = parseSearchRows(searchJson(KESARIYA_ROWS));
  assert.equal(cands.length, 3);
  assert.equal(cands[0].videoId, "NJAv_7lHUIU");
  assert.equal(cands[0].durationSecs, 269);
  assert.equal(cands[0].plays, 973000000);
  assert.ok(cands[0].parts.includes("Arijit Singh"), JSON.stringify(cands[0].parts));
  assert.equal(cands[1].durationSecs, 198);
});

test("parseSearchRows — a layout shuffle still yields rows (no fixed path)", () => {
  // Row rendered under an unexpected wrapper: a pinned path would return [].
  const json = { odd: { wrapper: [searchJson([KESARIYA_ROWS[0]])] } };
  assert.equal(parseSearchRows(json).length, 1);
});

test("parseSearchRows — rows without a video id are dropped, duplicates collapsed", () => {
  const json = searchJson([KESARIYA_ROWS[0], KESARIYA_ROWS[0]]);
  assert.equal(parseSearchRows(json).length, 1);
});

test("playability — maps a gated answer instead of throwing", () => {
  const p = playability({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" } });
  assert.equal(p.status, "LOGIN_REQUIRED");
  assert.ok(p.reason.length > 0);
});

// ── scoring (§6.1) ─────────────────────────────────────────────────────────

test("pickBestCandidate — the studio track beats the row-2 Dance Mix", () => {
  const cands = parseSearchRows(searchJson(KESARIYA_ROWS));
  const ranked = rankCandidates(kesariya, cands);
  assert.equal(ranked[0].candidate.videoId, "NJAv_7lHUIU", JSON.stringify(ranked.map((r) => [r.candidate.videoId, r.parts.score])));
  const best = pickBestCandidate(kesariya, cands);
  assert.equal(best.candidate.videoId, "NJAv_7lHUIU");
  assert.ok(best.score >= ACCEPT_THRESHOLD);
  // The dance mix must be demoted by more than its duration mismatch alone.
  const danceMix = ranked.find((r) => r.candidate.videoId === "ZczAI-GNFbk");
  assert.ok(danceMix.parts.penalty >= 0.25, `penalty=${danceMix.parts.penalty}`);
  assert.ok(danceMix.parts.score < ACCEPT_THRESHOLD, `score=${danceMix.parts.score}`);
});

test("pickBestCandidate — honest miss when nothing is close", () => {
  const cands = parseSearchRows(
    searchJson([
      { videoId: "junk1", title: "Mat Aazma Re", detail: "Pritam, KK • Murder 3 • 4:11" },
      { videoId: "junk2", title: "Wonderwall", detail: "Oasis • (What's the Story) Morning Glory? • 4:18" },
    ]),
  );
  assert.equal(pickBestCandidate(kesariya, cands), null);
});

test("pickBestCandidate — the measured false positive: same artist, same length, different song", () => {
  // Taken from the live probe run (docs/song-video.md §13.5): a Kesariya query
  // ranked "Khairiyat" at score 0.750 on perfect artist + duration agreement
  // with titleSim 0.56. The elevated title gate is what refuses it.
  const cands = parseSearchRows(
    searchJson([{ videoId: "q3HNo5a3ol4", title: "Khairiyat (Bonus Track)", detail: "Arijit Singh • 4:29 • 973M plays" }]),
  );
  const ranked = rankCandidates(kesariya, cands);
  assert.ok(ranked[0].parts.score >= ACCEPT_THRESHOLD, `score=${ranked[0].parts.score} — the score bar alone would pass`);
  assert.ok(ranked[0].parts.titleSim < 0.7, `titleSim=${ranked[0].parts.titleSim}`);
  assert.equal(pickBestCandidate(kesariya, cands), null, "a weak title must not be carried by artist + duration");
});

test("pickBestCandidate — title gate blocks a right-artist right-length wrong song", () => {
  const cands = parseSearchRows(
    searchJson([{ videoId: "wrong", title: "Tera Hua", detail: "Arijit Singh • 4:29" }]),
  );
  assert.equal(pickBestCandidate({ title: "Kesariya", artist: "Arijit Singh", duration_secs: 269 }, cands), null);
});

test("pickBestCandidate — title-only wants are not capped by weights for absent evidence", () => {
  // A probe/UI that knows only a title must still be able to accept a match.
  const cands = parseSearchRows(searchJson([KESARIYA_ROWS[0]]));
  const best = pickBestCandidate({ title: 'Kesariya (From "Brahmastra")' }, cands);
  assert.ok(best, "title-only scoring must not fall under the bar");
  assert.ok(best.score > 0.85, `score=${best.score}`);
});

test("versionPenalty — karaoke/cover/sped-up demoted, remix kept when asked for", () => {
  assert.ok(versionPenalty("Kesariya", "Kesariya (Karaoke Version)") >= 0.45);
  assert.ok(versionPenalty("Kesariya", "Kesariya (Cover)") >= 0.45);
  assert.ok(versionPenalty("Kesariya", "Kesariya (Sped Up)") >= 0.45);
  assert.equal(versionPenalty("Kesariya remix", "Kesariya (Remix)"), 0);
  assert.equal(versionPenalty("Kesariya", "Undercover Lover"), 0, "word-boundary match only");
});

test("durationFactor — documented windows", () => {
  assert.equal(durationFactor(269, 269), 1);
  assert.equal(durationFactor(269, 262), 1);
  assert.equal(durationFactor(269, 250), 0.5);
  assert.equal(durationFactor(269, 120), 0.15);
  assert.equal(durationFactor(0, 269), 0.7);
});

test("classifyKind — lyric / live / official", () => {
  const lyric = parseSearchRows(searchJson([{ videoId: "l", title: "Kesariya (Lyrics)", detail: "Arijit Singh • 4:29" }]))[0];
  assert.equal(classifyKind(kesariya, lyric), "lyric");

  const live = parseSearchRows(searchJson([{ videoId: "v", title: "Kesariya (Live)", detail: "Arijit Singh • 6:12" }]))[0];
  assert.equal(classifyKind(kesariya, live), "live");

  const official = parseSearchRows(searchJson([KESARIYA_ROWS[0]]))[0];
  assert.equal(classifyKind(kesariya, official), "official");
});

// ── rendition (§7) ─────────────────────────────────────────────────────────

test("playerFormats — keeps video + audio, marks ciphered formats unusable", () => {
  assert.ok(FORMATS.length >= 8);
  const cipher = FORMATS.find((f) => f.itag === 999);
  assert.equal(cipher.hasCipher, true);
  assert.equal(cipher.url, "");
});

test("pickRendition — 720p cap picks H.264 itag 136, never audio, never ciphered", () => {
  const r = pickRendition(FORMATS, { maxHeight: 720 });
  assert.equal(r.itag, 136);
  assert.equal(r.height, 720);
  assert.match(r.mimeType, /avc1/);
  assert.equal(r.codec, 0);
});

test("pickRendition — the cap is honoured; 1080p only on request", () => {
  assert.equal(pickRendition(FORMATS, { maxHeight: 480 }).itag, 135);
  assert.equal(pickRendition(FORMATS, { maxHeight: 1080 }).itag, 137);
  assert.equal(pickRendition(FORMATS, { maxHeight: 1080 }).height, 1080);
});

test("pickRendition — AV1 beats VP9 when no H.264 exists, but the cap still wins", () => {
  const noH264 = FORMATS.filter((f) => !/avc1/.test(f.mimeType));
  // The only AV1 row is 1080p, so a 720p cap legitimately leaves VP9.
  assert.match(pickRendition(noH264, { maxHeight: 1080 }).mimeType, /av01/);
  assert.match(pickRendition(noH264, { maxHeight: 720 }).mimeType, /vp9/);
});

test("pickRendition — no usable format is null, not a throw", () => {
  assert.equal(pickRendition([]), null);
  assert.equal(pickRendition(FORMATS.filter((f) => !f.url || f.hasCipher), { maxHeight: 720 }), null);
});

// ── plan (§3.2) ────────────────────────────────────────────────────────────

test("pickPlaybackPlan — ready plan carries the whole contract", () => {
  const cands = parseSearchRows(searchJson(KESARIYA_ROWS));
  const plan = pickPlaybackPlan({ track: { ...kesariya, duration_secs: 269 }, candidates: cands, formats: FORMATS, maxHeight: 720 });
  assert.equal(plan.state, "ready");
  assert.equal(plan.videoId, "NJAv_7lHUIU");
  assert.equal(plan.kind, "official");
  assert.equal(plan.itag, 136);
  assert.ok(plan.confidence >= ACCEPT_THRESHOLD);
  assert.match(plan.url, /googlevideo\.com/);
});

test("pickPlaybackPlan — a miss is an answer, with a reason and the top score", () => {
  const cands = parseSearchRows(searchJson([{ videoId: "junk1", title: "Mat Aazma Re", detail: "Pritam, KK • Murder 3 • 4:11" }]));
  const plan = pickPlaybackPlan({ track: kesariya, candidates: cands, formats: FORMATS });
  assert.equal(plan.state, "none");
  assert.equal(plan.reason, "below threshold");
  assert.ok(plan.confidence < ACCEPT_THRESHOLD);
  assert.equal(plan.videoId, undefined, "a miss must not leak a playable id");
});

test("pickPlaybackPlan — matched but nothing playable is still none", () => {
  const cands = parseSearchRows(searchJson(KESARIYA_ROWS));
  const plan = pickPlaybackPlan({ track: kesariya, candidates: cands, formats: FORMATS.filter((f) => f.hasCipher) });
  assert.equal(plan.state, "none");
  assert.equal(plan.reason, "no usable rendition");
});

test("videoCachePolicy — READY caches the URL for 30 min; a miss caches for 24 h", () => {
  assert.deepEqual(videoCachePolicy({ state: "ready" }), {
    persistMatch: true,
    persistUrl: true,
    matchTtl: 21600,
    urlTtl: URL_TTL_S,
    retryAfter: 0,
  });
  const miss = videoCachePolicy({ state: "none" });
  assert.equal(miss.persistMatch, false);
  assert.equal(miss.negativeTtl, NEGATIVE_TTL_S);
  assert.equal(videoCachePolicy({ state: "unavailable" }).retryAfter, 300);
  assert.equal(videoCachePolicy({ state: "expired" }).persistUrl, false);
});

test("stateForFailure — 403 ages out, gate is quiet, 5xx retries", () => {
  assert.equal(stateForFailure(403), "expired");
  assert.equal(stateForFailure(410), "expired");
  assert.equal(stateForFailure(200, "LOGIN_REQUIRED"), "none");
  assert.equal(stateForFailure(200, "OK"), "unavailable");
  assert.equal(stateForFailure(500), "unavailable");
  assert.equal(stateForFailure(0), "unavailable");
});

// ── metadata (§10.2) ──────────────────────────────────────────────────────

test("mergeMetadata — catalog wins, the video row only fills gaps", () => {
  const cand = parseSearchRows(searchJson([KESARIYA_ROWS[2]]))[0];
  const merged = mergeMetadata({ title: "Rasiya Reprise", artist: "Pritam", album: "", duration_secs: 0 }, cand);
  assert.equal(merged.title, "Rasiya Reprise");
  assert.equal(merged.artist, "Pritam");
  assert.equal(merged.album, "Brahmastra (OST)");
  assert.equal(merged.provenance.album, "video");
  assert.equal(merged.durationSecs, 285);
  assert.equal(merged.provenance.duration, "video");
  assert.equal(merged.provenance.title, "catalog");
});

test("mergeMetadata — a title echoed into the album slot is never invented as an album", () => {
  const cand = parseSearchRows(searchJson([KESARIYA_ROWS[0]]))[0];
  assert.equal(cand.album, "", 'the album slot held the song name, not an album');
  const merged = mergeMetadata({ title: "Kesariya", artist: "Arijit Singh", album: "Brahmastra", duration_secs: 269 }, cand);
  assert.equal(merged.album, "Brahmastra", "catalog album must not be replaced");
  assert.equal(merged.provenance.album, "catalog");
});

// ── contract guards ───────────────────────────────────────────────────────

test("the decision plane stays pure — no DOM, no network, no clock", () => {
  // The whole point of this module is that the same code runs in the desktop
  // shell, the mobile shell, node --test and the probe. A `fetch(` or a
  // `document.` here would break at least two of those, silently.
  for (const file of ["../src/videomatch.js", "../src/fingerprint.js"]) {
    const src = fs.readFileSync(path.join(here, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const banned of ["fetch(", "XMLHttpRequest", "document.", "window.", "localStorage", "new Date(", "Date.now("]) {
      assert.ok(!code.includes(banned), `${file} must not use ${banned}`);
    }
  }
});

// ── request shapes (§2.1–2.2) ─────────────────────────────────────────────

test("requests — iOS player, WEB_REMIX search, no ciphered client", () => {
  const p = playerRequest("kJQP7kiw5Fk");
  assert.equal(p.context.client.clientName, "IOS");
  assert.equal(p.videoId, "kJQP7kiw5Fk");
  assert.equal(p.context.client.osName, "iPhone");

  const s = searchRequest("Kesariya Arijit Singh Brahmastra");
  assert.equal(s.context.client.clientName, "WEB_REMIX");
  assert.equal(s.query, "Kesariya Arijit Singh Brahmastra");
  assert.equal(s.params, INNERTUBE.songsFilterParams);
  assert.equal(searchRequest("x", { params: null }).params, undefined);
});
