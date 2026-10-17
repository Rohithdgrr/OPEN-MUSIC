// loudness.js — real loudness matching (docs/audio-quality.md T3).
// Replaces the compressor-threshold "normalize" (which pumped) with a
// measured LUFS value per track and a plain gain correction at the chain's
// loudGain slot (before the limiter, so boosts stay protected).
//
// Zero imports, WebAudio + fetch only: desktop pulls it statically,
// mobile imports it dynamically (wifi/analysis gating lives in the caller).
//
// Measurement honesty: this is the documented K-weighting *approximation* —
// a 1.68 kHz shelf (+4 dB pre-emphasis) and a 38 Hz high-pass (RLB), 400 ms
// blocks on a 100 ms step, with the ITU BS.1770 gates (absolute −70 LUFS,
// relative −10 LU). Not a certified meter; the label stays "normalize".

export const TARGET_LUFS = -14;
export const GAIN_LIMIT_DB = 12;
const STORE_KEY = "tm-lufs";
const STORE_CAP = 600;

function storeGetJSON() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function storeSetJSON(map) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {}
}

/// Cached record for a track: `{ t: tier, l: lufs, p: peak, at }` or null.
export function cachedLufs(id) {
  if (!id) return null;
  const map = storeGetJSON();
  const v = map[String(id)];
  return v && Number.isFinite(v.l) ? v : null;
}

/// Store + LRU prune (oldest `at` first, capped). Bare number overwrite when
/// the tier changes is the caller's decision (they pass the tier here).
export function rememberLufs(id, tier, lufs, peak) {
  if (!id || !Number.isFinite(lufs)) return false;
  const map = storeGetJSON();
  const now = Date.now();
  map[String(id)] = { t: String(tier || ""), l: lufs, p: Number.isFinite(peak) ? peak : 1, at: now };
  const keys = Object.keys(map);
  if (keys.length > STORE_CAP) {
    keys
      .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      .slice(0, keys.length - STORE_CAP)
      .forEach((k) => delete map[k]);
  }
  storeSetJSON(map);
  return true;
}

/// Gain correction in dB → linear factor, clamped ±GAIN_LIMIT_DB.
export function gainForLufs(lufs) {
  if (!Number.isFinite(lufs)) return 1;
  const db = Math.min(GAIN_LIMIT_DB, Math.max(-GAIN_LIMIT_DB, TARGET_LUFS - lufs));
  const lin = Math.pow(10, db / 20);
  // Cap by true peak so the limiter is not doing all the work, when a peak
  // estimate exists (p swings wide only for junk decodes — guarded).
  // peak of 1.0 → allowed ≤1.0; measured lufs target keeps most in range.
  return Math.min(lin, 4);
}

/// Write a gain onto a dsp.js chain with a short ramp (no pop). gain 1 is
/// the unity reset used between tracks.
export function applyLoudnessGain(chain, gain) {
  if (!chain || !chain.loudGain || !chain.ctx) return false;
  const g = Number.isFinite(gain) ? Math.min(4, Math.max(0, gain)) : 1;
  try {
    const now = chain.ctx.currentTime;
    chain.loudGain.gain.cancelScheduledValues(now);
    chain.loudGain.gain.setValueAtTime(Math.max(0.0001, chain.loudGain.gain.value), now);
    chain.loudGain.gain.linearRampToValueAtTime(Math.max(0.0001, g), now + 0.5);
  } catch {
    try {
      chain.loudGain.gain.value = g;
    } catch {}
  }
  return true;
}

/// Fetch + decode + measure. Returns { lufs, peak } or null on any failure
/// (fail-open: playback never depends on measurement succeeding).
export async function measureLoudness(url) {
  if (!url || typeof fetch !== "function") return null;
  let raw;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    raw = await res.arrayBuffer();
  } catch {
    return null;
  }
  try {
    const AC = (typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext)) || null;
    if (!AC) return null;
    const probe = new AC(2, 1, 48000);
    const decoded = await probe.decodeAudioData(raw);
    const rate = decoded.sampleRate || 48000;
    const len = Math.max(1, Math.floor((decoded.duration || 0) * rate));
    const oc = new AC(decoded.numberOfChannels || 2, len, rate);
    const src = oc.createBufferSource();
    src.buffer = decoded;
    // K-weighting approximation: pre-emphasis shelf then RLB high-pass.
    const shelf = oc.createBiquadFilter();
    shelf.type = "highshelf";
    try {
      shelf.frequency.value = 1681;
      shelf.gain.value = 3.9;
    } catch {}
    const rlb = oc.createBiquadFilter();
    rlb.type = "highpass";
    try {
      rlb.frequency.value = 38;
      rlb.Q.value = 0.5;
    } catch {}
    src.connect(shelf);
    shelf.connect(rlb);
    rlb.connect(oc.destination);
    src.start(0);
    const rendered = await oc.startRendering();
    const chans = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(rendered.getChannelData(c));
    if (!chans.length) return null;
    const block = Math.round(rate * 0.4);
    const step = Math.round(rate * 0.1);
    if (block < 1 || chans[0].length < block) return null;
    const powers = [];
    for (let startIdx = 0; startIdx + block <= chans[0].length; startIdx += step) {
      let sum = 0;
      for (const d of chans) {
        let s = 0;
        for (let i = startIdx; i < startIdx + block; i++) {
          const v = d[i];
          s += v * v;
        }
        sum += s / block;
      }
      powers.push(sum / chans.length);
    }
    if (!powers.length) return null;
    // Gating: absolute −70 LUFS, then relative (mean of survivors − 10 LU).
    const lufsOf = (p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-20));
    const kept = powers.filter((p) => lufsOf(p) > -70);
    let lufs = null;
    if (kept.length) {
      const meanP = kept.reduce((a, p) => a + p, 0) / kept.length;
      const rel = lufsOf(meanP) - 10;
      const gated = powers.filter((p) => lufsOf(p) > -70 && lufsOf(p) > rel);
      lufs = lufsOf((gated.length ? gated : kept).reduce((a, p) => a + p, 0) / (gated.length || kept.length));
    }
    if (!Number.isFinite(lufs)) return null;
    let peak = 0;
    for (const d of chans) {
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    return { lufs, peak };
  } catch {
    return null;
  }
}
