// fingerprint.js — local audio fingerprinting (pure, node-testable).
//
// Why this exists: metadata says a video *should* be the song; only the audio
// can say it *is*. Shazam-style landmark hashing (the technique the reference
// clients use) turns a PCM buffer into `(f1, f2, Δt)` hashes whose time
// difference histogram gives both a similarity score and the offset between
// two recordings. That is what makes remixes, live takes and re-encodes
// separable when titles collide — docs/song-video.md §10.1.
//
// No service, no network, no dependency. Caller supplies mono float32 PCM
// (downsample to ~8 kHz first: the landmarks we keep are well under 4 kHz and
// the STFT cost falls 2× per halving).
//
// Usage:
//   const a = fingerprint(pcmA, { sampleRate: 8000 });
//   const b = fingerprint(pcmB, { sampleRate: 8000 });
//   matchFingerprints(a, b, { hop: 512, sampleRate: 8000 })
//     → { score, offsetSeconds, matched, aligned }

export const DEFAULTS = {
  window: 1024, // STFT window, power of two
  hop: 512, // samples between frames
  sampleRate: 8000,
  maxPeaksPerFrame: 5,
  relFloor: 0.12, // peak must clear this fraction of its frame's max
  fanOut: 6, // hash pairs per anchor peak
  minDt: 1,
  maxDt: 63, // frames (~4 s at 8 kHz / 512 hop)
};

/// In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be a
/// power of two; the caller keeps only the first half of the spectrum.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + half] * cwr - im[i + j + half] * cwi;
        const vi = re[i + j + half] * cwi + im[i + j + half] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + half] = ur - vr;
        im[i + j + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/// Short-time Fourier transform magnitudes. Returns one Float32Array of
/// `window/2` magnitudes per frame.
export function stft(pcm, opts = {}) {
  const window = opts.window || DEFAULTS.window;
  const hop = opts.hop || DEFAULTS.hop;
  const total = pcm && pcm.length ? pcm.length : 0;
  if (!total || total < window) return [];
  const win = opts.win || hann(window);
  const bins = window >> 1;
  const frames = [];
  for (let start = 0; start + window <= total; start += hop) {
    const re = new Float64Array(window);
    const im = new Float64Array(window);
    for (let i = 0; i < window; i++) re[i] = pcm[start + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let i = 0; i < bins; i++) mag[i] = Math.hypot(re[i], im[i]);
    frames.push(mag);
  }
  return frames;
}

/// Per-frame spectral peaks: local maxima in the bin domain, above a relative
/// floor, top-N by magnitude. Peaks are what survive lossy compression and
/// re-encoding, which is why landmarks are built from them and not from the
/// waveform.
export function spectralPeaks(frames, opts = {}) {
  const maxPerFrame = opts.maxPeaksPerFrame || DEFAULTS.maxPeaksPerFrame;
  const relFloor = opts.relFloor != null ? opts.relFloor : DEFAULTS.relFloor;
  const peaks = [];
  for (let f = 0; f < frames.length; f++) {
    const mag = frames[f];
    if (!mag || mag.length < 3) continue;
    let frameMax = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i] > frameMax) frameMax = mag[i];
    if (frameMax <= 0) continue;
    const floor = frameMax * relFloor;
    const cands = [];
    for (let i = 1; i < mag.length - 1; i++) {
      if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1] && mag[i] >= floor) {
        cands.push({ bin: i, mag: mag[i] });
      }
    }
    if (!cands.length) continue;
    cands.sort((a, b) => b.mag - a.mag || a.bin - b.bin);
    const keep = cands.length > maxPerFrame ? cands.slice(0, maxPerFrame) : cands;
    for (const c of keep) peaks.push({ frame: f, bin: c.bin, mag: c.mag });
  }
  return peaks;
}

/// 9 bits per frequency bin (512 bins), 6 bits for Δt → a 24-bit number, which
/// stays a small integer Map key.
function packHash(f1, f2, dt) {
  return ((f1 & 511) << 15) | ((f2 & 511) << 6) | (dt & 63);
}

/// Landmark hashes: each anchor peak pairs with up to `fanOut` later peaks
/// inside a 1–63 frame window. The anchor *time* is kept so a match can be
/// aligned, not just scored.
export function landmarkHashes(peaks, opts = {}) {
  const fanOut = opts.fanOut || DEFAULTS.fanOut;
  const minDt = opts.minDt || DEFAULTS.minDt;
  const maxDt = opts.maxDt || DEFAULTS.maxDt;
  if (!peaks || !peaks.length) return [];
  const sorted = peaks.slice().sort((a, b) => a.frame - b.frame || a.bin - b.bin);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    let paired = 0;
    for (let j = i + 1; j < sorted.length && paired < fanOut; j++) {
      const b = sorted[j];
      const dt = b.frame - a.frame;
      if (dt < minDt) continue;
      if (dt > maxDt) break;
      out.push({ h: packHash(a.bin, b.bin, dt), t: a.frame, f1: a.bin, f2: b.bin, dt });
      paired += 1;
    }
  }
  return out;
}

/// PCM → hashes in one call.
export function fingerprint(pcm, opts = {}) {
  return landmarkHashes(spectralPeaks(stft(pcm, opts), opts), opts);
}

/// Compare two hash lists. The tallest `t_ref − t_query` histogram bin is the
/// alignment; the score is that bin's share of the query's hashes, so a short
/// excerpt matched inside a long recording still scores high while an
/// unrelated track stays near zero.
export function matchFingerprints(query, ref, opts = {}) {
  const hop = opts.hop || DEFAULTS.hop;
  const sampleRate = opts.sampleRate || DEFAULTS.sampleRate;
  const q = query || [];
  const r = ref || [];
  if (!q.length || !r.length) return { score: 0, offsetSeconds: 0, matched: 0, aligned: 0 };

  const index = new Map();
  for (const p of r) {
    const list = index.get(p.h);
    if (list) list.push(p.t);
    else index.set(p.h, [p.t]);
  }

  const hist = new Map();
  let matched = 0;
  for (const p of q) {
    const list = index.get(p.h);
    if (!list) continue;
    matched += 1;
    for (const t of list) {
      const delta = t - p.t;
      hist.set(delta, (hist.get(delta) || 0) + 1);
    }
  }

  let bestDelta = 0;
  let bestCount = 0;
  for (const [delta, count] of hist) {
    if (count > bestCount || (count === bestCount && Math.abs(delta) < Math.abs(bestDelta))) {
      bestDelta = delta;
      bestCount = count;
    }
  }

  return {
    score: bestCount / q.length,
    offsetSeconds: (bestDelta * hop) / sampleRate,
    matched,
    aligned: bestCount,
  };
}
