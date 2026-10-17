# Audio quality & spatial enhancement — spec of record

Written before any code (docs-first). Status of each tier is tracked at the
bottom of its section. The source catalog (JioSaavn) tops out at **320 kbps
AAC stereo** — no lossless tier exists upstream, so "quality" here means:
(1) never silently play below the requested tier, (2) perceptual DSP on top
of the stream, (3) honest labels for what the listener is hearing.

**Trademark note:** this is binaural/spatial *virtualization*, not Dolby
Atmos (object-based multichannel + licensed decoder). The feature is branded
"Immersive"; the word Dolby never appears in the UI.

---

## T0 — Source fidelity lock (no silent downgrades)

Contracts already in the tree, now pinned by a static gate
(`app/tests/audio-quality.test.mjs`):

| Path | Contract | Where |
|---|---|---|
| Desktop stream pick | `tm-stream-quality` defaults to `"320kbps"` | `playback.js streamQuality()` |
| Mobile network pick | `effectiveStreamQuality()` returns 320 kbps on every default branch; Data Saver (64 kbps) and a cellular 96 kbps pick are explicit opt-ins only | `mobile/shared.js` |
| Settings UI | The quality select leads with "320 kbps — max" | `settings.js` |
| Rust ladder | When the requested tier is not declared, `best_quality`/`ranked_tiers` take the **best available** tier (320 → 160 → 96 → 48 → 12) and report it as `chosen_quality` (painted by `#np-format`); never a forced lower tier when the requested one exists | `jiosaavn.rs` (unit-tested there) |
| Vault | Downloads store the chosen tier's raw bytes; no transcode anywhere | `proxy.rs` `/stream` passes bytes through |

Gate style: source-text assertions (same pattern as `mobile-spotify.test.mjs`).

## T1 — Studio chain, desktop + mobile parity

**`app/src/dsp.js`** — new, **zero imports** (it lands in both module graphs;
the 2026-10-07 qrview lesson applies — nothing may pull `dom.js` into the
mobile shell, and nothing may pull mobile files into the desktop shell).

Per transport element one chain (a `MediaElementAudioSourceNode` can be
created once per element, so chains live in a Map keyed by element — the
mobile pattern, now shared):

```
src → band1..5 → comp → preSpatial → loudGain → limiter → out → ctx.destination
```

| Stage | Purpose | Values |
|---|---|---|
| 5 bands | parametric EQ, parked transparent | lowshelf 60 Hz · peaking 240 / 1k / 3.5k (Q 0.8) · highshelf 10 kHz — all at 0 dB (gains 1.0) |
| comp | the loudness slot's safety stage | threshold −24 dB permanently armed; the real loudness match is T3's `loudGain` (the comp only guards sudden overshoots) |
| preSpatial | fixed 1.0 gain — the slot the T2 spatial stage inserts at | — |
| loudGain | fixed 1.0 gain — the slot T3's loudness match writes | — |
| limiter | transparent ceiling that catches spatial overshoot | threshold −1 dBFS, ratio 20, attack 3 ms, release 250 ms |

Preset curves (`flat/bass/bassboost/pop/bright/vocal/electronic/acoustic`)
remain in `dsp.js` as a unit-tested library surface, but nothing in the app
selects them: the players ship `AUTO_EQ = "flat"` so the EQ stages stay
transparent and the chain exists as the pipe for T2/T3 (and future automated
behaviors). There is no per-track or global preset selection in the UI.

**Desktop wiring (`playback.js`):** chain built lazily on the first play
attempt for `audio` **and** `audio2` (the crossfade standby gets its own
chain so a handover never leaves the graph — same reason as mobile). Wiring
+ resume ride the play path because a `MediaElementAudioSourceNode`
permanently captures the element's output; an AudioContext that never
resumes would mean silence, so this is only ever done inside a user-gesture
playback call, with `ctx.resume()` also on the `play` event (the mobile-proven
pattern). Both elements load CORS-clean (`crossOrigin = "anonymous"`, set at
module scope before any `src` assignment — run 3's live fix; the relay
answers ACAO from the 2026-10-08 P36 work, and the loudness `fetch()` already
proved it).

**Mobile refactor (`mobile/player.js`):** `ensureEqChain`/`applyEq` keep
their names and call sites but their bodies delegate to `dsp.js`. Both
surfaces run the same automated constants (flat EQ, hall room at intensity
60, normalization always armed); the mobile measurement keeps its
non-cellular gate, cached gains apply anywhere.

Verification (T1): `dsp.test.mjs` (pure logic: preset shape, resolution
order, storage guards, band ordering) + `audio-quality.test.mjs` (T0 gates)
+ the mobile boot graph test still green + a headless-Chrome probe that
plays real audio through the chain and **measures** the spectrum with the
EQ flat vs `bassboost`/`bright` (the 2026-10-08 lesson: meter the output,
never trust a "no error" probe).

## T2 — "Immersive" spatial engine (the Atmos-feel tier)

A spatial subgraph between `preSpatial` and `loudGain`, built once and
routed in/out by disconnect/connect (the chain itself is never rebuilt —
the media source is one-time):

```
preSpatial ──┬─ (bypass) ───────────────────────────────► loudGain
             └─ widener(mid/side) ─┬─ dry ───────────────► loudGain
                                   └─ convolver(IR) ─ wet ► loudGain
```

| Piece | Implementation | Honest description |
|---|---|---|
| Stereo widening | mid/side matrix: `outL = m + w·s`, `outR = m − w·s` via 4 gains + splitter/merger | width beyond the speaker pair |
| Binaural/room | `ConvolverNode` with a synthesized stereo IR (seeded noise × exp decay, ~0.6 ms inter-aural delay, per-channel tilt) — deterministic, local, no network asset | headphone "space" |
| Bass reconstruction | lowpass 100 Hz → soft-clip WaveShaper → wet gain, parallel dry path | perceived bass on small speakers that cannot move enough air below ~100 Hz |

Modes: **off · studio · hall · stadium · wide** (IR length/decay and width
per mode), one **intensity** scalar (0–100) scaling all of it. Modes:
`studio` short/neutral, `hall` ~1.8 s, `stadium` ~3.2 s slow, `wide`
widener only (no reverb).

Rules:
- **Auto-bypass in Jam rooms** (`localRole()` truthy) — the drift measure
  rides element playheads and must not be allowed to look at a room's
  rendered image; spatial routes direct the moment a room is joined and
  returns automatically when it closes. (EQ stays on in rooms — it is
  linear shaping, not a delay line.)
- The shipped mode is **hall at intensity 60** (`AUTO_SPATIAL` in each
  player); there is no mode select, intensity slider or persisted mode —
  the room is always on and hands-free.
- Latency: convolver render is in-place (no `latencyHint` change); the IR
  tail rings into crossfade handovers — acceptable and verified by the
  existing fade suites.

Verification (T2): L/R separation metric (side-channel energy) and IR-tail
probe in headless Chrome; Jam-room bypass asserted by the room suites; boot
graph still green on mobile.

## T3 — True loudness matching

Replaces the compressor-threshold "normalize" with real analysis:

- `app/src/loudness.js`: `measureLoudness(url)` — fetch the resolved URL
  (relay loopback, CSP-allowed), `decodeAudioData`, K-weighting
  approximation (highshelf ~+4 dB @ 1.5 kHz pre-filter), 400 ms mean-square
  blocks with the ITU BS.1770 gating (absolute −70 LUFS + relative −10 LU),
  true-peak approx from max sample. Result cached per track in one
  localStorage map (`tm-lufs`, LRU-capped ~600 entries, keyed with the
  quality tier so a 96 kbps analysis never answers for 320).
- Gain applied at `loudGain`: `target(−14 LUFS) − measured`, clamped ±12 dB,
  ramped ~0.5 s when applied mid-play (no pop); if a cached value exists it
  is applied before play.
- Cost control: analysis fetches the whole stream once per track — gated
  off on mobile cellular/Data Saver (like byte-prefetch), always on desktop.
- Normalization is always armed (no toggle): an unanalyzed track plays at
  unity through the −24 dB comp until its measured gain lands.

---

## Automation (§6) — fully automated, no settings taps

The quality system ships hand-free (user directive, 2026-10-18): the
shipped behaviors are the product. No EQ, no Immersive room and no
normalize controls exist on either surface.

| Behavior | Shipped default |
|---|---|
| EQ | transparent (`AUTO_EQ = "flat"`, bands at gain 1.0) — the chain is the pipe for T2/T3, never tone-shaping on its own |
| Immersive room | `hall` at intensity 60 (`AUTO_SPATIAL`), auto-bypassed in Jam rooms |
| Loudness matching | always armed — measure, cache, correct; fails open to unity until a measurement lands |
| Stream tier | unchanged: the T0 ladder auto-picks the best rendition and the badge reports what is actually playing |

Contract kept out of the UI:

- The toggle-era keys (`tm-eq-preset`, `tm-eq-tracks`, `tm-normalize`,
  `tm-spatial-mode`, `tm-spatial-int`) are removed from `sync.js`'s
  allowlist and wiped at boot by `clearToggleKeys()` (dsp.js) — both
  players call it at module load. Stale values from older installs or
  probes cannot resurrect any behavior.
- Removed UI (this decision, both surfaces): desktop Settings rows
  "Equalizer" / "Immersive room" / "Immersive intensity", the mobile
  Immersive section + per-track EQ sheet + track-menu entry "EQ for this
  track", the generated mobile Settings rows "EQ preset" and "Normalize
  volume", and the settings→playback `tm-eq-changed` A/B event.
  `mobile/audioplus.js` keeps only the crossfade selector.
- `dsp.js`'s stored-key accessors (`resolveEqPreset`, `normalizeOnStored`,
  `spatialModeStored`, `spatialIntensityStored`) remain as a unit-tested
  library surface for future automated behaviors; no app path reads them.
- Gates: `audio-quality.test.mjs` asserts the absence of every control +
  key + the shipped constants (8 tests), so a settings row cannot silently
  return.

---

## Tier status

All numbers below are live output on the real desktop app (fresh
`cargo build` binary, real UI search → trusted-gesture click → CDP metering
of the actual WebAudio chain via the `applyDesktopEq` diagnostic hook,
`%TEMP%\opencode\audio-quality-live.mjs`, **13/13 PASS** on 2026-10-18;
mobile live pass pending a later emulator round — same shared code path,
unit + boot-graph gated today).

| Tier | Status |
|---|---|
| T0 | **verified live** — badge `320kbps` on the playing track; the movement R ladder picks the best tier (`stream/vault bytes`) and reports it; static gates pin 320 kbps on every default branch |
| T1 | **verified live** — 2 transport chains wired (element + crossfade standby), ctx `running`; EQ transparent (bands `[0,0,0,0,0]` dB); CORS-clean loads (`crossOrigin="anonymous"` at module scope — the run-3 defect: relay loads were CORS-tainted = spec-mandated silence, audible bands `low/mid/high = −3.9/4.3/4.8 dB` after the fix) |
| T2 | **verified live** — auto-routed without any toggle read: `sIn=1/sDir=0`, hall IR loaded; post-chain stereo decorrelation measured (raw taps: source corr 0.68 → chain-out corr 0.46–0.77; side variance > 0 in every run); Jam-room bypass is unit-gated (`localRole()` → direct) |
| T3 | **verified live**, cached-instant path — measured **−8.886 LUFS** → `loudGain 0.555` = expected `10^((−14+8.886)/20) = 0.5554` exactly, applied while (and after) the element paused; fresh-analysis path separately verified earlier at **−7.8 LUFS → 0.4871** (expected 0.49) |

Defects found by the live runs (both fixed):

| # | Defect | Where | Fix |
|---|---|---|---|
| L1 | Desktop relay loads were **CORS-tainted** — WebAudio spec-mandated silence with a non-CORS-clean feed (the 2026-10-08 P36 class on desktop); caught only because the driver *meters* the chain output | `playback.js` | `audio.crossOrigin = "anonymous"` + `audio2.*` at module scope, before any `src` assignment (an impossible fix mid-load: the in-flight fetch ignores it) |
| L2 | Automation would have been **resurrected by stale state**: older installs/probes carried `tm-eq-preset/tm-normalize/tm-spatial-*`, and `sync.js`'s allowlist would re-create them cross-device | `dsp.js`, `sync.js`, both players | `clearToggleKeys()` (dsp.js) wiped once at each player's boot; the two keys dropped from the sync allowlist; static gates forbid the literals again |

Probe lessons recorded for the next driver author (all cost one run to learn):

- A same-page rerun **reuses prior meter taps** — rebuild the analyser/splitter
  every run (run 9 measured run 8's bugged both-LEFT taps as `corr = 1`).
- `AudioNode.connect(dest, outputIndex, inputIndex)` — splitter **output 0 =
  LEFT, 1 = RIGHT**; tapping 0 into both (runs 7–8) gives `corr = 1`
  trivially. Band `BiquadFilterNode.gain` is **dB** — flat = `0`, not `1.0`.
- The **boot session-restore races the driver**: dialogs (QR sheet) open from
  the last session swallow input; the user's last search can re-paint after
  `doSearch`; the **source-first merge repaints rows ~1–2 s after first
  paint**, so a captured row id can be stale — the loudness cache must be
  keyed by the id the *stream URL* carries (S2 extracts it).
- `CDP send()` needs a response timeout: a detached page hangs a driver
  forever (run 7 died silently at P7).
