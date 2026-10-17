// dsp.test.mjs — pure-logic tests for app/src/dsp.js (docs/audio-quality.md
// T1). dsp.js is zero-import and side-effect-free, so it evaluates under node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EQ_BANDS,
  EQ_PRESETS,
  EQ_KEYS,
  EQ_LABELS,
  SPATIAL_MODES,
  buildStudioChain,
  wireChain,
  applyStudioChain,
  setSpatial,
  ensureSpatial,
  eqPresetStored,
  trackEqFor,
  resolveEqPreset,
  normalizeOnStored,
  spatialModeStored,
  spatialIntensityStored,
} from "../src/dsp.js";
import { TARGET_LUFS, GAIN_LIMIT_DB, gainForLufs, cachedLufs, rememberLufs, applyLoudnessGain } from "../src/loudness.js";

const maxAbs = (d, a, b) => {
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(d[i]));
  return m;
};

test("EQ presets are five finite dB gains within ±12", () => {
  assert.equal(EQ_KEYS.length, Object.keys(EQ_PRESETS).length);
  for (const k of EQ_KEYS) {
    const g = EQ_PRESETS[k];
    assert.equal(g.length, EQ_BANDS.length, `${k} matches the band count`);
    for (const v of g) {
      assert.ok(Number.isFinite(v), `${k} gain finite`);
      assert.ok(v >= -12 && v <= 12, `${k} gain sane`);
    }
  }
  assert.deepEqual(EQ_PRESETS.flat, [0, 0, 0, 0, 0]);
  assert.deepEqual(EQ_LABELS.flat, "Flat — neutral");
  for (const k of EQ_KEYS) assert.ok(EQ_LABELS[k], `${k} labeled`);
});

test("bands run low → high so the cascade is ordered", () => {
  const freqs = EQ_BANDS.map((b) => b.freq);
  for (let i = 1; i < freqs.length; i++) assert.ok(freqs[i] > freqs[i - 1]);
  assert.equal(EQ_BANDS[0].type, "lowshelf");
  assert.equal(EQ_BANDS[EQ_BANDS.length - 1].type, "highshelf");
});

// node has no WebAudio: the chain builder must degrade, not throw.
test("buildStudioChain degrades without a real AudioContext", () => {
  const fake = { createBiquadFilter: null };
  assert.throws(() => buildStudioChain(fake));
});

test("applyStudioChain survives a null chain and writes gains via a stub ctx", () => {
  assert.equal(applyStudioChain(null, "bass", false), false);
  // Minimal stub node graph: filters + gains + two compressors.
  const node = () => {
    const params = {};
    return {
      type: "",
      frequency: { value: 0 },
      Q: { value: 1 },
      gain: { value: 1 },
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 1 },
      attack: { value: 0 },
      release: { value: 0 },
      connect() {},
      get __params() {
        return params;
      },
    };
  };
  const nodes = [];
  const ctx = {
    createBiquadFilter() {
      const n = node();
      nodes.push(n);
      return n;
    },
    createDynamicsCompressor() {
      const n = node();
      nodes.push(n);
      return n;
    },
    createGain() {
      const n = node();
      nodes.push(n);
      return n;
    },
  };
  const chain = buildStudioChain(ctx);
  assert.equal(chain.bands.length, 5);
  assert.ok(chain.limiter);
  assert.equal(applyStudioChain(chain, "bassboost", true), true);
  assert.deepEqual(chain.bands.map((b) => b.gain.value), EQ_PRESETS.bassboost);
  assert.equal(chain.comp.threshold.value, -24);
  assert.equal(applyStudioChain(chain, "nonsense-preset", false), true);
  assert.deepEqual(chain.bands.map((b) => b.gain.value), EQ_PRESETS.flat);
  assert.equal(chain.comp.threshold.value, 0);
  assert.ok(wireChain(chain, { connect() {} }, { __dest: true }));
  assert.ok(chain.source);
});

// Storage resolution — dsp.js reads guarded localStorage, so a stub is set
// on globalThis and cleaned up.
function withStore(map, fn) {
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem(k, v) {
      map[k] = String(v);
    },
  };
  try {
    fn();
  } finally {
    globalThis.localStorage = prev;
  }
}

test("preset + per-track resolution: override wins, junk coerces to flat", () => {
  withStore({ "tm-eq-preset": "bright", "tm-eq-tracks": JSON.stringify({ t1: "vocal", t2: "nonsense" }) }, () => {
    assert.equal(eqPresetStored(), "bright");
    assert.equal(resolveEqPreset("t1"), "vocal"); // override wins
    assert.equal(resolveEqPreset("t2"), "bright"); // junk override ignored
    assert.equal(resolveEqPreset("t9"), "bright"); // global fallback
    assert.equal(resolveEqPreset(null), "bright");
    assert.equal(trackEqFor(""), "");
  });
  withStore({ "tm-eq-preset": "garbage" }, () => {
    assert.equal(eqPresetStored(), "flat");
  });
  withStore({}, () => {
    assert.equal(resolveEqPreset("x"), "flat");
  });
});

test("normalize + spatial prefs parse and clamp", () => {
  withStore({ "tm-normalize": "1", "tm-spatial-mode": "wide", "tm-spatial-int": "250" }, () => {
    assert.equal(normalizeOnStored(), true);
    assert.equal(spatialModeStored(), "wide");
    assert.equal(spatialIntensityStored(), 100);
  });
  withStore({ "tm-spatial-mode": "nope", "tm-spatial-int": "-5" }, () => {
    assert.equal(spatialModeStored(), "off");
    assert.equal(spatialIntensityStored(), 0);
  });
  withStore({}, () => {
    assert.equal(normalizeOnStored(), false);
    assert.equal(spatialModeStored(), "off");
    assert.equal(spatialIntensityStored(), 60);
  });
});

test("spatial mode list is honest and ordered", () => {
  assert.deepEqual(SPATIAL_MODES, ["off", "studio", "hall", "stadium", "wide"]);
});

// ------------------------------------------------------------- T2 spatial -
// Full param-stub AudioContext: every create* returns the gain/filter node
// stub, splitters/mergers just record connections, createBuffer sizes a real
// Float32Array so makeSpatialIR's math runs for real.
function spatialCtxStub() {
  const mkParam = (init) => {
    const p = { value: init, setTargetAtTime(v) { p.value = v; }, cancelScheduledValues() {}, setValueAtTime(v) { p.value = v; }, linearRampToValueAtTime(v) { p.value = v; } };
    return p;
  };
  const mkNode = (fields) => {
    const n = { connect() {}, disconnect() {}, setTargetAtTime() {} };
    for (const [k, v] of Object.entries(fields)) n[k] = typeof v === "number" ? mkParam(v) : v;
    return n;
  };
  const buffers = [];
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    destination: { __dest: true },
    createBiquadFilter: () => mkNode({ type: "", frequency: 0, Q: 1, gain: 1 }),
    createDynamicsCompressor: () =>
      mkNode({
        threshold: 0,
        knee: 0,
        ratio: 1,
        attack: 0,
        release: 0,
      }),
    createGain: () => mkNode({ gain: 1 }),
    createChannelSplitter: () => ({ connect() {}, disconnect() {} }),
    createChannelMerger: () => ({ connect() {}, disconnect() {} }),
    createConvolver: () => ({ connect() {}, disconnect() {}, buffer: null }),
    createWaveShaper: () => ({ connect() {}, disconnect() {}, curve: null, oversample: "" }),
    createBuffer(channels, length, rate) {
      const chs = [];
      for (let c = 0; c < channels; c++) chs.push(new Float32Array(length));
      const b = {
        getChannelData: (i) => chs[i],
        length,
        sampleRate: rate,
        numberOfChannels: channels,
      };
      buffers.push(b);
      return b;
    },
  };
  return { ctx, buffers };
}

test("spatial: off keeps the direct rig, on routes the branch with matrix + wet + bass", () => {
  const { ctx } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  assert.equal(setSpatial(null, "hall", 80), false); // null chain is a no-op
  // off by default
  assert.equal(setSpatial(chain, "off", 80), true);
  assert.equal(chain.spatial.sIn.gain.value, 0);
  assert.equal(chain.spatial.sDir.gain.value, 1);
  // on: widener matrix identity-breaking, wet + bass scaled by intensity
  assert.equal(setSpatial(chain, "hall", 100), true);
  const sp = chain.spatial;
  assert.equal(sp.sIn.gain.value, 1);
  assert.equal(sp.sDir.gain.value, 0);
  // hall width 0.4 at i=1 → w=1.4 → cross gain ((1−w)/2) = −0.2
  assert.ok(Math.abs(sp.toL.fromR.gain.value - -0.2) < 1e-9);
  assert.ok(Math.abs(sp.toR.fromR.gain.value - (1 + 1.4) / 2) < 1e-9);
  assert.ok(Math.abs(sp.wet.gain.value - 0.35) < 1e-9);
  assert.ok(Math.abs(sp.bassGain.gain.value - 0.55) < 1e-9);
  assert.ok(sp.conv.buffer, "the convolver got an IR");
  assert.equal(sp.conv.buffer.numberOfChannels, 2);
  // the IR is deterministic: same seed → identical tail
  const again = ensureSpatial(chain);
  assert.equal(again, sp, "the spatial stage is built once per chain");
});

test("spatial: bypass (Jam rooms) forces direct regardless of mode", () => {
  const { ctx } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  assert.equal(setSpatial(chain, "stadium", 90, true), true);
  assert.equal(chain.spatial.sIn.gain.value, 0);
  assert.equal(chain.spatial.sDir.gain.value, 1);
});

test("spatial: intensity 0 is sonically off without a mode switch", () => {
  const { ctx } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  assert.equal(setSpatial(chain, "wide", 0), true);
  assert.equal(chain.spatial.sIn.gain.value, 0);
  assert.equal(chain.spatial.sDir.gain.value, 1);
});

test("wide mode carries no convolver room", () => {
  const { ctx } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  setSpatial(chain, "wide", 70);
  assert.equal(chain.spatial.conv.buffer, null);
  assert.equal(chain.spatial.wet.gain.value, 0);
  assert.ok(chain.spatial.bassGain.gain.value > 0, "bass reconstruction still runs on wide");
});

test("the synthesized IR peaks normalize and decay", () => {
  const { ctx, buffers } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  setSpatial(chain, "studio", 100);
  const ir = chain.spatial.irs.studio;
  assert.ok(ir, "studio built an IR");
  let peakL = 0;
  const d = ir.getChannelData(0);
  for (let i = 0; i < d.length; i++) peakL = Math.max(peakL, Math.abs(d[i]));
  assert.ok(
    Math.abs(peakL - 0.5) < 1e-6,
    "IR normalized to 0.5 peak (got " + peakL + ")",
  );
  // decayed by the end (windowed maxima, so a lone noise zero-crossing
  // cannot fake a pass or a fail)
  const early = maxAbs(d, Math.floor(d.length * 0.05), Math.floor(d.length * 0.15));
  const tail = maxAbs(d, Math.floor(d.length * 0.88), Math.floor(d.length * 0.98));
  assert.ok(tail < early * 0.1, "the IR decays (tail " + tail + " « early " + early + ")");
  assert.ok(buffers.length >= 1);
});

// ------------------------------------------------------ T3 loudness utils -
test("gain clamps ±12 dB and never becomes 0", () => {
  assert.equal(TARGET_LUFS, -14, "the target is pinned: streaming-loudness sweet spot");
  assert.equal(gainForLufs(null), 1);
  assert.equal(gainForLufs(Number.NaN), 1);
  assert.ok(Math.abs(gainForLufs(-14) - 1) < 1e-9, "target itself = unity");
  assert.ok(gainForLufs(-26) > 0, "quiet track → boost");
  assert.ok(gainForLufs(-2) < 1, "loud track → cut");
  const loudest = Math.pow(10, GAIN_LIMIT_DB / 20);
  assert.ok(Math.abs(gainForLufs(-100) - loudest) < 1e-9, "floor clamps at +12 dB");
  assert.ok(Math.abs(gainForLufs(30) - Math.pow(10, -GAIN_LIMIT_DB / 20)) < 1e-9, "ceiling clamps at −12 dB");
  assert.equal(gainForLufs(30) > 0, true);
});

test("loudness cache round-trips, prunes and tiers", () => {
  withStore({}, () => {
    assert.equal(cachedLufs("t1"), null);
    assert.equal(rememberLufs("", -14), false, "no id → no store");
    assert.equal(rememberLufs("t1", "320kbps", Number.NaN), false, "no lufs → no store");
    assert.equal(rememberLufs("t1", "320kbps", -18.2, 0.9), true);
    const m = cachedLufs("t1");
    assert.equal(m.t, "320kbps");
    assert.ok(Math.abs(m.l + 18.2) < 1e-9);
    assert.ok(Math.abs(m.p - 0.9) < 1e-9);
    for (let i = 0; i < 600; i++) rememberLufs("k" + i, "320kbps", -14, 1);
    assert.equal(cachedLufs("t1"), null, "LRU pruned the old entry");
    assert.ok(cachedLufs("k599"));
    assert.equal(Object.keys(JSON.parse(globalThis.localStorage.getItem("tm-lufs"))).length, 600, "cap enforced");
  });
});

test("applyLoudnessGain writes unity on junk and ramps real values", () => {
  const { ctx } = spatialCtxStub();
  const chain = buildStudioChain(ctx);
  assert.equal(applyLoudnessGain(null, 2), false);
  assert.equal(applyLoudnessGain(chain, Number.NaN), true); // junk → unity
  assert.ok(Math.abs(chain.loudGain.gain.value - 1) < 1e-9);
  assert.equal(applyLoudnessGain(chain, 2.5), true);
  assert.ok(Math.abs(chain.loudGain.gain.value - 2.5) < 1e-9);
});
