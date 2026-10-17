// dsp.js — Studio audio chain shared by desktop (playback.js) and mobile
// (mobile/player.js). Spec: docs/audio-quality.md T1-T3.
//
// Zero imports, on purpose: this module is pulled into both module graphs and
// must never drag desktop files (dom.js et al.) into the mobile shell or vice
// versa — the 2026-10-07 qrview lesson. Everything reads localStorage through
// guards so the module also evaluates (without side effects) under node tests
// and headless probes.
//
// Chain shape per transport element (a MediaElementAudioSourceNode can only
// be created once per element, so chains are never rebuilt, only reconfigured):
//
//   src → band1..5 → comp → preSpatial → loudGain → limiter → out → destination
//
// preSpatial is the slot the T2 spatial stage inserts at; loudGain is the
// slot T3's loudness match writes; the limiter is the last thing audio meets,
// so EQ boosts, spatial widening and loudness matching can never clip.
//
// The storage keys below are duplicated from mobile/shared.js on purpose
// (shared.js is a mobile-graph module and must not be imported from here);
// sync.js syncs both keys across surfaces.

export const EQ_KEY = "tm-eq-preset";
export const TRACK_EQ_KEY = "tm-eq-tracks";
export const NORM_KEY = "tm-normalize";
export const SPATIAL_MODE_KEY = "tm-spatial-mode";
export const SPATIAL_INT_KEY = "tm-spatial-int";

// ------------------------------------------------------------- EQ presets -
// 5-band parametric: lowshelf 60 Hz, peaking 240/1k/3.5k, highshelf 10 kHz.
// dB gains. The six legacy names keep their character (the mobile 3-band
// `bass` [6,1,2] and friends); two studio presets join them. dsp.test.mjs
// pins the shape, so edits here are deliberate.
export const EQ_BANDS = [
  { type: "lowshelf", freq: 60 },
  { type: "peaking", freq: 240, q: 0.8 },
  { type: "peaking", freq: 1000, q: 0.8 },
  { type: "peaking", freq: 3500, q: 0.8 },
  { type: "highshelf", freq: 10000 },
];

export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 3, 0, -1, 1],
  bassboost: [9, 5, 1, -1, 2],
  pop: [1, 2, 2, 3, 2],
  bright: [-2, 0, 1, 3, 5],
  vocal: [-3, -1, 3, 4, 1],
  electronic: [5, 2, -1, 2, 4],
  acoustic: [2, 1, 2, 1, 2],
};

export const EQ_KEYS = Object.keys(EQ_PRESETS);

export const EQ_LABELS = {
  flat: "Flat — neutral",
  bass: "Bass",
  bassboost: "Bass boost",
  pop: "Pop",
  bright: "Bright",
  vocal: "Vocal",
  electronic: "Electronic",
  acoustic: "Acoustic",
};

// Spatial modes (T2). off = bypass; wide = widener only, no reverb.
export const SPATIAL_MODES = ["off", "studio", "hall", "stadium", "wide"];
export const SPATIAL_LABELS = {
  off: "Off",
  studio: "Studio",
  hall: "Hall",
  stadium: "Stadium",
  wide: "Wide",
};

// Per-mode room params (docs/audio-quality.md T2). ir is the impulse length
// in seconds (0 = no convolver, "wide"); width multiplies the side content;
// wetScale caps the reverb at full intensity; itd is the inter-aural delay
// baked into the synthesized IR (the binaural cue). Broadcast feel, not
// accuracy — the honest label is "room feel".
const SPATIAL_PARAMS = {
  studio: { ir: 0.38, decay: 3.4, itd: 0.45, width: 0.25, wetScale: 0.3 },
  hall: { ir: 1.8, decay: 2.6, itd: 0.62, width: 0.4, wetScale: 0.35 },
  stadium: { ir: 3.2, decay: 1.9, itd: 0.8, width: 0.5, wetScale: 0.4 },
  wide: { ir: 0, decay: 0, itd: 0.55, width: 0.55, wetScale: 0 },
};

// Fixed seeds: the same room always synthesizes the same IR, so the sound is
// stable across sessions and the deterministic IR is testable.
const IR_SEED = { studio: 91423, hall: 51773, stadium: 30507, wide: 60761 };

// ------------------------------------------------------------ storage read -
function storeGet(key) {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeGetJSON(key) {
  const raw = storeGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/// Global preset: per-track override stays the caller's decision (it needs
/// the playing track's id), this only validates the stored global pick.
export function eqPresetStored() {
  const v = storeGet(EQ_KEY);
  return EQ_PRESETS[v] ? v : "flat";
}

/// Per-track override wins over the global preset (mobile's "EQ for this
/// track" menu writes this map; both surfaces honor it).
export function trackEqFor(id) {
  if (!id) return "";
  const m = storeGetJSON(TRACK_EQ_KEY);
  if (!m || typeof m !== "object") return "";
  const v = m[String(id)];
  return EQ_PRESETS[v] ? v : "";
}

export function resolveEqPreset(trackId) {
  return trackEqFor(trackId) || eqPresetStored();
}

export function normalizeOnStored() {
  return storeGet(NORM_KEY) === "1";
}

export function spatialModeStored() {
  const v = storeGet(SPATIAL_MODE_KEY);
  return SPATIAL_MODES.includes(v) ? v : "off";
}

export function spatialIntensityStored() {
  // Read the raw string first: `Number(null)` is 0 and would clamp a fresh
  // install to 0 (silent spatial) — the same trap baseVol() guards in the
  // mobile player.
  const raw = storeGet(SPATIAL_INT_KEY);
  if (raw == null || raw === "") return 60;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 60;
  return Math.min(100, Math.max(0, Math.round(v)));
}

// docs/audio-quality.md §6 automation: EQ / spatial / normalize run without
// settings taps, so these keys can only hold stale state from older builds.
// Called once at boot by each surface's player. The stored-* accessors above
// stay as library surface (unit-tested) but no app path reads them.
export function clearToggleKeys() {
  try {
    for (const k of [EQ_KEY, TRACK_EQ_KEY, NORM_KEY, SPATIAL_MODE_KEY, SPATIAL_INT_KEY]) {
      localStorage.removeItem(k);
    }
  } catch {}
}

// ------------------------------------------------------------ chain build -
/// Build the unconnected chain. `wireChain` attaches the (one-time) media
/// source and the destination afterwards.
export function buildStudioChain(ctx) {
  const bands = EQ_BANDS.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    try {
      f.frequency.value = b.freq;
      if (b.q != null) f.Q.value = b.q;
    } catch {}
    return f;
  });
  const comp = ctx.createDynamicsCompressor();
  try {
    comp.threshold.value = 0; // off until "volume normalization" says otherwise
  } catch {}
  const preSpatial = ctx.createGain();
  const loudGain = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  try {
    // Transparent ceiling — catches spatial/boost overshoot only.
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
  } catch {}
  const out = ctx.createGain();
  for (let i = 0; i < bands.length; i++) {
    const from = i === 0 ? null : bands[i - 1];
    if (from) from.connect(bands[i]);
  }
  const last = bands[bands.length - 1];
  last.connect(comp);
  comp.connect(preSpatial);
  preSpatial.connect(loudGain);
  loudGain.connect(limiter);
  limiter.connect(out);
  return { bands, comp, preSpatial, loudGain, limiter, out, spatial: null, source: null, ctx };
}

/// Attach a (one-time) MediaElementAudioSourceNode and the destination.
/// Rebuilding the chain is impossible, so this runs once per element; the
/// caller's Map is what keeps it that way.
export function wireChain(chain, sourceNode, destination) {
  if (!chain || !sourceNode) return chain;
  chain.source = sourceNode;
  sourceNode.connect(chain.bands[0]);
  try {
    chain.out.connect(destination);
  } catch {}
  return chain;
}

/// Write a preset + normalize state onto a chain. Idempotent and cheap —
/// called on every play event.
export function applyStudioChain(chain, preset, normalize) {
  if (!chain) return false;
  const g = EQ_PRESETS[preset] || EQ_PRESETS.flat;
  for (let i = 0; i < chain.bands.length; i++) {
    try {
      chain.bands[i].gain.value = g[i];
    } catch {}
  }
  try {
    chain.comp.threshold.value = normalize ? -24 : 0;
  } catch {}
  return true;
}

// --------------------------------------------------------------- spatial -
// The T2 stage lives between preSpatial and loudGain. The bypass/dry rig is
// part of the topology (a dedicated sDir gain), so switching is pure gain
// automation — no connect/disconnect storms mid-play (a connect storm is a
// click, and a MediaElementSource chain cannot be rebuilt to recover).

function ramp(ctx, param, v) {
  try {
    param.setTargetAtTime(v, ctx.currentTime, 0.05); // 50 ms — clickless
  } catch {
    try {
      param.value = v;
    } catch {}
  }
}

/// Minimal deterministic room IR: per-channel decaying noise with the right
/// channel delayed (ITD) and darker (ILD tilt). Not a measured HRTF — the
/// honest words are "room feel". Seeded, so a room always sounds the same.
function makeSpatialIR(ctx, secs, decay, seed, itdMs) {
  const rate = ctx.sampleRate || 48000;
  const itd = Math.max(1, Math.round((itdMs / 1000) * rate));
  const n = Math.max(Math.floor(rate / 8), Math.floor(secs * rate)); // ≥125 ms
  const buf = ctx.createBuffer(2, n + itd, rate);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const k = Math.log(1000) / n; // −60 dBFS by the tail
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // Right channel smoother (darker) = inter-aural level difference feel.
    const smooth = ch === 0 ? 0.15 : 0.45;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const raw = (rnd() * 2 - 1) * Math.exp(-i * k);
      lp = lp + smooth * (raw - lp);
      data[i + (ch === 1 ? itd : 0)] += ch === 0 ? raw * 0.85 + lp * 0.15 : lp;
    }
  }
  // Normalize the peak so the wet scale is predictable across modes.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const g = 0.5 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return buf;
}

function bassCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(2.2 * x); // saturate the low band → harmonics
  }
  return curve;
}

/// Build the spatial subgraph once per chain and re-route around it. On any
/// failure the direct bypass is re-asserted so audio can never be lost.
export function ensureSpatial(chain) {
  if (!chain || !chain.ctx) return null;
  if (chain.spatial) return chain.spatial;
  const ctx = chain.ctx;
  try {
    const sDir = ctx.createGain();
    try {
      sDir.gain.value = 1;
    } catch {}
    chain.preSpatial.disconnect(chain.loudGain);
    chain.preSpatial.connect(sDir);
    sDir.connect(chain.loudGain);
    const sIn = ctx.createGain();
    try {
      sIn.gain.value = 0; // silent until a mode turns it on
    } catch {}
    chain.preSpatial.connect(sIn);
    const sOut = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const toL = { fromL: ctx.createGain(), fromR: ctx.createGain() };
    const toR = { fromL: ctx.createGain(), fromR: ctx.createGain() };
    splitter.connect(toL.fromL, 0);
    splitter.connect(toL.fromR, 1);
    splitter.connect(toR.fromL, 0);
    splitter.connect(toR.fromR, 1);
    toL.fromL.connect(merger, 0, 0);
    toL.fromR.connect(merger, 0, 0);
    toR.fromL.connect(merger, 0, 1);
    toR.fromR.connect(merger, 0, 1);
    // Widened program flows through the merger; reverb hangs off it.
    const conv = ctx.createConvolver();
    const wet = ctx.createGain();
    try {
      wet.gain.value = 0;
    } catch {}
    merger.connect(conv);
    conv.connect(wet);
    // Bass reconstruction: saturate the low band in parallel (harmonics read
    // as bass on small speakers that cannot move air below ~100 Hz).
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = "lowpass";
    try {
      bassLP.frequency.value = 110;
      bassLP.Q.value = 0.7;
    } catch {}
    const shaper = ctx.createWaveShaper();
    try {
      shaper.curve = bassCurve();
      shaper.oversample = "2x";
    } catch {}
    const bassGain = ctx.createGain();
    try {
      bassGain.gain.value = 0;
    } catch {}
    sIn.connect(splitter);
    sIn.connect(bassLP);
    bassLP.connect(shaper);
    shaper.connect(bassGain);
    merger.connect(sOut);
    wet.connect(sOut);
    bassGain.connect(sOut);
    sOut.connect(chain.loudGain);
    const spatial = { sDir, sIn, sOut, splitter, merger, toL, toR, conv, wet, bassGain, irs: {} };
    chain.spatial = spatial;
    return spatial;
  } catch {
    chain.spatial = null;
    try {
      // The element's output must never be left orphaned by a half-built
      // spatial stage: re-assert the plain direct route.
      chain.preSpatial.disconnect();
      chain.preSpatial.connect(chain.loudGain);
    } catch {}
    return null;
  }
}

/// Route + shape the spatial stage. `bypass` (Jam rooms) forces the render
/// chain to direct — the drift measure rides element playheads and must not
/// look at a room's rendered image. Idempotent: call on every apply.
export function setSpatial(chain, mode, intensity, bypass = false) {
  const sp = chain && chain.spatial ? chain.spatial : ensureSpatial(chain);
  if (!sp || !chain) return false;
  const eff = bypass || mode === "off";
  const i = eff ? 0 : Math.min(1, Math.max(0, (Math.round(Number(intensity) || 0) / 100)));
  const on = !eff && i > 0;
  const p = SPATIAL_PARAMS[mode] || SPATIAL_PARAMS.studio;
  ramp(chain.ctx, sp.sIn.gain, on ? 1 : 0);
  ramp(chain.ctx, sp.sDir.gain, on ? 0 : 1);
  if (!on) return true;
  // Widener: outL = m + w·s, outR = m − w·s via the matrix; identity at w=1.
  const w = 1 + (p.width || 0) * i;
  ramp(chain.ctx, sp.toL.fromL.gain, (1 + w) / 2);
  ramp(chain.ctx, sp.toL.fromR.gain, (1 - w) / 2);
  ramp(chain.ctx, sp.toR.fromL.gain, (1 - w) / 2);
  ramp(chain.ctx, sp.toR.fromR.gain, (1 + w) / 2);
  if (p.ir) {
    try {
      if (!sp.irs[mode]) sp.irs[mode] = makeSpatialIR(chain.ctx, p.ir, p.decay, IR_SEED[mode] || 12345, p.itd);
      sp.conv.buffer = sp.irs[mode];
    } catch {}
    ramp(chain.ctx, sp.wet.gain, (p.wetScale || 0) * i);
  } else {
    try {
      sp.conv.buffer = null; // no room on "wide"
    } catch {}
    ramp(chain.ctx, sp.wet.gain, 0);
  }
  ramp(chain.ctx, sp.bassGain.gain, 0.55 * i);
  return true;
}
