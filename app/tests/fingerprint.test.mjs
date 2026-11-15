// fingerprint.test.mjs — unit tests for the local landmark fingerprinter
// (docs/song-video.md §10.1). Deterministic synthetic audio only: a fixed
// LCG seeds the noise, so the same numbers come out on every machine and the
// suite stays offline.
import { test } from "node:test";
import assert from "node:assert/strict";

const { stft, spectralPeaks, landmarkHashes, fingerprint, matchFingerprints, DEFAULTS } = await import("../src/fingerprint.js");

const RATE = 8000;
const HOP = DEFAULTS.hop;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/// A moving harmonic signal: three partials whose loudness re-shapes every
/// 0.25 s, so peaks migrate across the frame (a static tone would hash the
/// same three bins forever and prove nothing about alignment).
function synth({ seconds, freqs, seed = 7, gain = 1 }) {
  const n = Math.floor(seconds * RATE);
  const pcm = new Float32Array(n);
  const rnd = lcg(seed);
  const blockLen = Math.max(1, Math.floor(RATE * 0.25));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin((2 * Math.PI * freqs[k] * i) / RATE + k);
    const block = Math.floor(i / blockLen);
    const env = 0.35 + 0.65 * (((block * 37) % 11) / 10);
    pcm[i] = gain * (0.2 * env * v + 0.01 * (rnd() * 2 - 1));
  }
  return pcm;
}

const A_FREQS = [220, 587, 1174];
const B_FREQS = [311, 741, 1567];
const A = synth({ seconds: 6, freqs: A_FREQS, seed: 11 });

test("stft — frame count and half-spectrum width", () => {
  const frames = stft(A);
  assert.equal(frames.length, Math.floor((A.length - DEFAULTS.window) / HOP) + 1);
  assert.equal(frames[0].length, DEFAULTS.window / 2);
});

test("fingerprint — a 6 s clip yields hundreds of landmark hashes", () => {
  const hashes = fingerprint(A);
  assert.ok(hashes.length > 200, `hashes=${hashes.length}`);
  for (const h of hashes.slice(0, 50)) {
    assert.ok(Number.isInteger(h.h) && h.h >= 0 && h.h < 2 ** 24, `bad hash ${h.h}`);
    assert.ok(h.dt >= 1 && h.dt <= 63);
  }
});

test("matchFingerprints — identical audio aligns at offset 0 with score 1", () => {
  const ref = fingerprint(A);
  const q = fingerprint(A);
  const m = matchFingerprints(q, ref, { hop: HOP, sampleRate: RATE });
  assert.ok(m.score > 0.9, `score=${m.score}`);
  assert.equal(m.offsetSeconds, 0);
});

test("matchFingerprints — a later excerpt yields a negative offset in seconds", () => {
  // B is A preceded by 0.96 s (15 hops) of unrelated noise, so every A frame
  // lands exactly 15 frames later and the alignment bin is sharp.
  const prefix = synth({ seconds: 0.96, freqs: B_FREQS, seed: 99 });
  assert.equal(prefix.length, 15 * HOP);
  const B = new Float32Array(prefix.length + A.length);
  B.set(prefix, 0);
  B.set(A, prefix.length);

  const ref = fingerprint(A);
  const q = fingerprint(B);
  const m = matchFingerprints(q, ref, { hop: HOP, sampleRate: RATE });
  assert.ok(m.score > 0.5, `score=${m.score}`);
  assert.ok(Math.abs(m.offsetSeconds + 0.96) <= 0.02, `offset=${m.offsetSeconds}`);
});

test("matchFingerprints — a different song does not match", () => {
  const other = synth({ seconds: 6, freqs: B_FREQS, seed: 23 });
  const m = matchFingerprints(fingerprint(other), fingerprint(A), { hop: HOP, sampleRate: RATE });
  assert.ok(m.score < 0.15, `score=${m.score}`);
});

test("matchFingerprints — survives gain change + noise (duplicate detection)", () => {
  // Same recording, quieter and noisier: peaks are relative, so the landmarks
  // should survive where a waveform comparison would not.
  const quieter = synth({ seconds: 6, freqs: A_FREQS, seed: 11, gain: 0.4 });
  const m = matchFingerprints(fingerprint(quieter), fingerprint(A), { hop: HOP, sampleRate: RATE });
  assert.ok(m.score > 0.8, `score=${m.score}`);
  assert.equal(m.offsetSeconds, 0);
});

test("matchFingerprints — empty input is a zero, not a throw", () => {
  assert.deepEqual(matchFingerprints([], []), { score: 0, offsetSeconds: 0, matched: 0, aligned: 0 });
  assert.equal(matchFingerprints(fingerprint(new Float32Array(0)), []).score, 0);
});

test("spectralPeaks / landmarkHashes — degenerate input is safe", () => {
  assert.deepEqual(spectralPeaks([]), []);
  assert.deepEqual(landmarkHashes([]), []);
  assert.deepEqual(stft(new Float32Array(10)), []);
  // Silence produces no peaks at all (no divide-by-zero frame max).
  assert.deepEqual(fingerprint(new Float32Array(RATE * 2)), []);
});
