#!/usr/bin/env node
// video-probe.mjs — end-to-end proof for the song-video plane.
//
// Runs the exact production code path against the real upstream, with no app
// and no Rust: build query → InnerTube search → rank → accept/reject →
// InnerTube player → pick a rendition → byte-range GET on the chosen CDN URL.
// Every decision it makes comes from src/videomatch.js, so a green run is
// evidence about the module and the protocol together, not about a script's
// private copy of the logic.
//
// Usage (docs/song-video.md §14):
//   npm run video:probe -- "Kesariya Brahmastra Arijit Singh"
//   npm run video:probe -- --track "Kesariya|Arijit Singh|Brahmastra|269"
//   npm run video:probe -- "zzzz qqqq xxxx"        # must report state: none
//   npm run video:probe -- --json "..."            # machine-readable
//
// Exit 0 for both a good match and an honest miss; non-zero only when the
// transport itself failed (network, HTTP, malformed body).

import {
  INNERTUBE,
  buildSearchQuery,
  parseSearchRows,
  rankCandidates,
  pickPlaybackPlan,
  playerFormats,
  playability,
  mergeMetadata,
  searchRequest,
  playerRequest,
} from "../src/videomatch.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const maxHeightArg = args.indexOf("--max-height");
const maxHeight = maxHeightArg >= 0 ? Number(args[maxHeightArg + 1]) || 720 : 720;
const trackArg = args.indexOf("--track");
const trackFlag = trackArg >= 0 ? args[trackArg + 1] : "";
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--track", "--max-height"].includes(args[i - 1])));

/// `title|artist|album|seconds` for an exact track, else free text = a title.
function parseInput() {
  if (trackFlag) {
    const [title, artist, album, secs] = trackFlag.split("|").map((s) => (s || "").trim());
    return { title: title || "", artist: artist || "", album: album || "", durationSecs: Number(secs) || 0 };
  }
  const text = positional.join(" ").trim();
  return { title: text, artist: "", album: "", durationSecs: 0 };
}

function log(...parts) {
  if (!json) console.log(...parts);
}

async function postJson(url, key, body, userAgent) {
  const res = await fetch(`${url}?key=${encodeURIComponent(key)}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "en",
      "user-agent": userAgent || INNERTUBE.ios.userAgent,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 180)}`);
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`non-JSON answer from ${url}: ${text.slice(0, 180)}`);
  }
}

function round(n, d = 3) {
  return Number(Number(n).toFixed(d));
}

async function main() {
  const track = parseInput();
  if (!track.title) {
    console.error('usage: npm run video:probe -- "<title> [artist] [album]" | --track "title|artist|album|seconds"');
    process.exitCode = 2;
    return;
  }

  const started = Date.now();
  const built = buildSearchQuery(track);
  log(`query        ${JSON.stringify(built.query)}`);

  const t0 = Date.now();
  const search = await postJson(INNERTUBE.searchUrl, INNERTUBE.webRemix.key, searchRequest(built.query), null);
  const candidates = parseSearchRows(search.body);
  log(`search       HTTP ${search.status} in ${Date.now() - t0} ms — ${candidates.length} candidates`);
  if (!candidates.length) throw new Error("search returned no candidates (layout change or empty answer)");

  const ranked = rankCandidates(track, candidates);
  for (const r of ranked.slice(0, 3)) {
    log(
      `  ${r.candidate.videoId}  ${round(r.parts.score).toFixed(3)}  ` +
        `t=${round(r.parts.titleSim, 2)} a=${round(r.parts.artistSim, 2)} ` +
        `d=${r.parts.durF == null ? "—" : round(r.parts.durF, 2)} pen=${round(r.parts.penalty, 2)}  ` +
        `${r.candidate.title}`,
    );
  }
  if (ranked.length > 3) log(`  … ${ranked.length - 3} more`);

  // Search-only plan first: proves the accept/reject decision independently of
  // whether the player answers (that is what the UI shows while resolving).
  const searchOnly = pickPlaybackPlan({ track, candidates, formats: [] });
  if (searchOnly.state !== "ready") {
    const result = { state: "none", reason: searchOnly.reason, confidence: searchOnly.confidence, topVideoId: searchOnly.topVideoId, candidates: candidates.length };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`state        none (${searchOnly.reason}, best ${round(searchOnly.confidence)})`);
    console.log(`RESULT ${JSON.stringify(result)}`);
    return; // an honest miss is a pass
  }

  const chosen = candidates.find((c) => c.videoId === searchOnly.videoId);
  log(`accepted     ${chosen.videoId}  confidence=${round(searchOnly.confidence)}  kind=${searchOnly.kind}`);

  const t1 = Date.now();
  const player = await postJson(INNERTUBE.playerUrl, INNERTUBE.ios.key, playerRequest(chosen.videoId), INNERTUBE.ios.userAgent);
  const play = playability(player.body);
  const formats = playerFormats(player.body);
  log(
    `player       HTTP ${player.status} in ${Date.now() - t1} ms — status=${play.status} ` +
      `formats=${formats.length} (${formats.filter((f) => /^video\//.test(f.mimeType)).length} video) videoLen=${play.lengthSeconds}s`,
  );
  if (play.status !== "OK") {
    const result = { state: "none", reason: `playability ${play.status}`, videoId: chosen.videoId, detail: play.reason };
    if (json) console.log(JSON.stringify(result, null, 2));
    console.log(`RESULT ${JSON.stringify(result)}`);
    return;
  }

  const plan = pickPlaybackPlan({ track, candidates, formats, maxHeight });
  if (plan.state !== "ready") {
    const result = { state: "none", reason: plan.reason, confidence: plan.confidence };
    if (json) console.log(JSON.stringify(result, null, 2));
    console.log(`RESULT ${JSON.stringify(result)}`);
    return;
  }
  log(`rendition    itag=${plan.itag} ${plan.width}x${plan.height} ${plan.mimeType} ${(plan.sizeBytes / 1048576).toFixed(1)} MB`);

  // The relay contract: a Range request must answer 206 with video bytes. This
  // is the exact behaviour proxy.rs re-serves to the WebView.
  const t2 = Date.now();
  const range = await fetch(plan.url, {
    headers: { range: "bytes=0-1023", "user-agent": INNERTUBE.ios.userAgent },
  });
  const bytes = new Uint8Array(await range.arrayBuffer());
  const contentType = range.headers.get("content-type") || "";
  const contentRange = range.headers.get("content-range") || "";
  log(`range        HTTP ${range.status} in ${Date.now() - t2} ms — ${contentType} ${bytes.length} B ${contentRange}`);

  const ok = range.status === 206 && bytes.length === 1024 && /^video\//i.test(contentType);

  const result = {
    state: ok ? "ready" : "degraded",
    videoId: plan.videoId,
    kind: plan.kind,
    confidence: plan.confidence,
    itag: plan.itag,
    width: plan.width,
    height: plan.height,
    mimeType: plan.mimeType,
    videoLengthSeconds: play.lengthSeconds,
    bytes: bytes.length,
    rangeStatus: range.status,
    contentRange,
    metadata: mergeMetadata({ ...track, title: track.title, artist: track.artist, album: track.album }, chosen),
    elapsedMs: Date.now() - started,
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  console.log(`RESULT ${JSON.stringify(result)}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`PROBE FAILED: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
