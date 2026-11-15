// The mobile Now Playing video backdrop: the pure gate/plan rules plus the
// static wiring gates (markup, CSS, Settings switch, CSP).
// Spec: docs/song-video.md §9, §12.2, §17.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  VIDEO_PREF_KEY,
  chooseCandidate,
  chooseRendition,
  planVideo,
  videoGate,
  videoPrefOn,
} from "../src/videoplan.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const TRACK = {
  id: "tumhiho",
  title: 'Tum Hi Ho (From "Aashiqui 2")',
  artist: "Arijit Singh",
  album: "Aashiqui 2",
  duration_secs: 261,
};

const ROWS = [
  {
    videoId: "NjAv7lHUIU",
    title: "Tum Hi Ho",
    credit: "Arijit Singh",
    parts: ["Arijit Singh"],
    album: "",
    durationSecs: 261,
    plays: 900_000_000,
    channel: "",
  },
  {
    videoId: "ZczAIGNlbk",
    title: "Tum Hi Ho (Dance Mix)",
    credit: "Pritam",
    parts: ["Pritam"],
    album: "",
    durationSecs: 200,
    plays: 10_000_000,
    channel: "",
  },
];

const FORMATS = [
  { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', url: "https://r1.googlevideo.com/a", hasCipher: false, width: 1920, height: 1080, fps: 30, sizeBytes: 9, quality: "1080p" },
  { itag: 136, mimeType: 'video/mp4; codecs="avc1.64002a"', url: "https://r1.googlevideo.com/b", hasCipher: false, width: 1280, height: 720, fps: 30, sizeBytes: 9, quality: "720p" },
  { itag: 399, mimeType: 'video/mp4; codecs="av01.0.08M.08"', url: "https://r1.googlevideo.com/c", hasCipher: false, width: 1280, height: 720, fps: 30, sizeBytes: 9, quality: "720p" },
];

test("the switch is off unless explicitly enabled", () => {
  assert.equal(VIDEO_PREF_KEY, "tm-np-video");
  assert.equal(videoPrefOn(null), false);
  assert.equal(videoPrefOn(""), false);
  assert.equal(videoPrefOn("0"), false);
  assert.equal(videoPrefOn("1"), true);
});

test("the gate names every reason the backdrop can be refused", () => {
  assert.deepEqual(videoGate({ enabled: false }), { ok: false, reason: "off" });
  assert.deepEqual(videoGate({ enabled: true, hasInvoke: false }), { ok: false, reason: "no-backend" });
  assert.deepEqual(videoGate({ enabled: true, hasInvoke: true, reducedMotion: true }), {
    ok: false,
    reason: "reduced-motion",
  });
  assert.deepEqual(videoGate({ enabled: true, hasInvoke: true, cellular: true }), {
    ok: false,
    reason: "metered",
  });
  assert.deepEqual(videoGate({ enabled: true, hasInvoke: true, saveData: true }), {
    ok: false,
    reason: "metered",
  });
  assert.deepEqual(videoGate({ enabled: true, hasInvoke: true }), { ok: true, reason: "" });
});

test("the studio row wins and the version penalty keeps the dance mix out", () => {
  const best = chooseCandidate(TRACK, ROWS);
  assert.ok(best, "the measured top row is accepted");
  assert.equal(best.candidate.videoId, "NjAv7lHUIU");
});

test("a wrong song is refused rather than shown", () => {
  const wrong = [
    {
      videoId: "qqqqqqqqqq",
      title: "Someone Else Entirely",
      credit: "Another Band",
      parts: ["Another Band"],
      album: "",
      durationSecs: 190,
      plays: 5,
      channel: "",
    },
  ];
  assert.equal(chooseCandidate(TRACK, wrong), null);
});

test("rendition respects the 720 cap and prefers H.264 within it", () => {
  const pick = chooseRendition(FORMATS, 720);
  assert.equal(pick.itag, 136, "avc1 720p beats av01 720p and 1080p is capped out");
  assert.equal(chooseRendition([{ ...FORMATS[0], url: "" }], 720), null, "no plain url, no rendition");
});

test("planVideo answers ready or none, never throws", () => {
  const ready = planVideo(TRACK, { candidates: ROWS, formats: FORMATS });
  assert.equal(ready.state, "ready");
  assert.equal(ready.videoId, "NjAv7lHUIU");
  assert.equal(ready.itag, 136);
  assert.match(ready.url, /^https:\/\/r1\.googlevideo\.com/);

  const noMatch = planVideo(TRACK, { candidates: [], formats: FORMATS });
  assert.equal(noMatch.state, "none");
  assert.equal(noMatch.reason, "no-candidate");

  const noRendition = planVideo(TRACK, { candidates: ROWS, formats: [] });
  assert.equal(noRendition.state, "none");
  assert.equal(noRendition.reason, "no-rendition");
});

test("the planner stays pure — no DOM, no network, no clock", () => {
  const src = read("../src/videoplan.js");
  assert.equal(/\bdocument\b|\bwindow\b|\bfetch\(|Date\.now/.test(src), false);
});

test("Now Playing mounts a muted, looping, inline video under the artwork", () => {
  const html = read("../src/mobile/screens/nowplaying.html");
  const video = html.match(/<video[^>]*id="np-video"[^>]*>/);
  assert.ok(video, "#np-video exists");
  for (const attr of ["muted", "loop", "playsinline", "preload=\"none\""]) {
    assert.ok(video[0].includes(attr), `video carries ${attr}`);
  }
  assert.ok(html.indexOf('id="np-art"') < html.indexOf('id="np-video"'), "art is the poster underneath");
});

test("the video layer fades in only when live and honours reduced motion", () => {
  const css = read("../src/mobile/shell.css");
  assert.match(css, /#np-video \{[\s\S]*?opacity: 0;/);
  assert.match(css, /#np-video\.is-live \{\s*opacity: 1;/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,80}#np-video/);
});

test("binders wires the switch (default off) and the paint hook", () => {
  const src = read("../src/mobile/binders.js");
  assert.ok(src.includes('"m-np-video"'), "Settings row + wiring exist");
  assert.ok(src.includes('flip("m-np-video", VIDEO_PREF_KEY'), "the switch persists the pref key");
  assert.ok(src.includes('"m-np-video", VIDEO_PREF_KEY, "0"'), "painted off by default");
  assert.ok(src.includes("syncVideoBackdrop(t, st)"), "the Now Playing paint drives the layer");
  assert.ok(src.includes("stopVideoBackdrop()"), "leaving the screen releases the decoder");
});

test("the mobile shell may load the loopback relay (CSP unchanged)", () => {
  const csp = read("../src-tauri/tauri.android.conf.json");
  assert.ok(csp.includes("media-src 'self' http://127.0.0.1:*"));
});
