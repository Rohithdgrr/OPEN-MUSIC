// OpenMusic Web Audio API synthesizer + HTML5 live streaming audio bridge
// 5-band BiquadFilter EQ + Analyser (vanilla JS)

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10, 12],
  dorian: [0, 2, 3, 5, 7, 9, 10, 12],
  phrygian: [0, 1, 3, 5, 7, 8, 10, 12],
  major: [0, 2, 4, 5, 7, 9, 11, 12],
};

const EQ_FREQS = [60, 230, 910, 3600, 14000];

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class OpenMusicAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.eqFilters = [];
    this.analyser = null;
    this.audioElement = null;
    this.mediaSourceNode = null;
    this.stepTimer = null;
    this.stepIndex = 0;
    this.currentTrack = null;
    this.isPlaying = false;
    this.volume = 0.76;
    this.eqState = {
      enabled: true,
      preset: 'Audiophile',
      bands: [1.5, 0.5, 0, 1.5, 2.5],
    };

    // Callback hooks for sync with reactive store
    this.onEnded = null;
    this.onTimeUpdate = null;
    this.onError = null;
  }

  ensureContext() {
    // 1. Ensure HTML5 Audio Element exists
    if (!this.audioElement && typeof document !== 'undefined') {
      this.audioElement = document.getElementById('audio') || document.querySelector('audio');
      if (!this.audioElement) {
        this.audioElement = document.createElement('audio');
        this.audioElement.id = 'audio';
        this.audioElement.preload = 'metadata';
        document.body.appendChild(this.audioElement);
      }
      this.audioElement.crossOrigin = 'anonymous';

      this.audioElement.addEventListener('ended', () => {
        if (this.onEnded) this.onEnded();
      });

      this.audioElement.addEventListener('timeupdate', () => {
        if (this.onTimeUpdate && this.audioElement && Number.isFinite(this.audioElement.currentTime)) {
          this.onTimeUpdate(this.audioElement.currentTime, this.audioElement.duration);
        }
      });

      this.audioElement.addEventListener('error', (e) => {
        console.warn('Real audio stream error, falling back to synthesizer:', e);
        if (this.onError) this.onError(e);
        if (this.isPlaying && this.currentTrack) {
          this.restartSequencer();
        }
      });
    }

    // 2. Ensure Web Audio Context exists
    if (this.ctx) return;
    const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
    } catch (err) {
      console.warn('AudioContext init error:', err);
      return;
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.82;

    this.eqFilters = EQ_FREQS.map((freq, idx) => {
      const filter = this.ctx.createBiquadFilter();
      filter.type = idx === 0 ? 'lowshelf' : idx === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.1;
      filter.gain.value = this.eqState.enabled ? this.eqState.bands[idx] : 0;
      return filter;
    });

    // Wire synthesizer node: masterGain -> eqFilters -> analyser -> destination
    let node = this.masterGain;
    for (const f of this.eqFilters) {
      node.connect(f);
      node = f;
    }
    node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Wire HTML5 audio element into the same EQ filter chain if possible
    if (this.audioElement && !this.mediaSourceNode) {
      try {
        this.mediaSourceNode = this.ctx.createMediaElementSource(this.audioElement);
        this.mediaSourceNode.connect(this.eqFilters[0]);
      } catch (err) {
        // MediaElementAudioSourceNode can only be created once per element
        console.warn('createMediaElementSource note:', err);
      }
    }
  }

  setTrack(track) {
    this.currentTrack = track;
    this.stepIndex = 0;
    if (this.isPlaying) {
      this.play(track);
    }
  }

  play(track) {
    if (track) this.currentTrack = track;
    if (!this.currentTrack) return;
    this.ensureContext();

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.isPlaying = true;

    // If track has a real stream URL, stream it
    const stream = this.currentTrack.streamUrl;
    if (stream && this.audioElement) {
      if (this.stepTimer !== null) {
        window.clearInterval(this.stepTimer);
        this.stepTimer = null;
      }
      if (this.audioElement.src !== stream) {
        this.audioElement.src = stream;
        this.audioElement.currentTime = 0;
      }
      this.audioElement.volume = this.volume;
      const playPromise = this.audioElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('HTML5 audio play blocked/failed, starting sequencer fallback:', err);
          this.restartSequencer();
        });
      }
    } else {
      // Offline fallback: Web Audio synthesizer
      if (this.audioElement) {
        this.audioElement.pause();
      }
      this.restartSequencer();
    }
  }

  pause() {
    this.isPlaying = false;
    if (this.audioElement) {
      this.audioElement.pause();
    }
    if (this.stepTimer !== null) {
      window.clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
  }

  seek(seconds) {
    if (!this.currentTrack) return;
    if (this.audioElement && this.currentTrack.streamUrl && Number.isFinite(seconds)) {
      try {
        this.audioElement.currentTime = seconds;
      } catch {}
    }
    const bpm = this.currentTrack.bpm || 128;
    const stepMs = (60 / bpm / 2) * 1000;
    this.stepIndex = Math.floor((seconds * 1000) / stepMs);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
    if (this.audioElement) {
      this.audioElement.volume = this.volume;
    }
  }

  setEq(eq) {
    this.eqState = eq;
    if (!this.ctx || this.eqFilters.length === 0) return;
    const now = this.ctx.currentTime;
    this.eqFilters.forEach((f, idx) => {
      f.gain.setTargetAtTime(eq.enabled ? eq.bands[idx] : 0, now, 0.04);
    });
  }

  getFrequencyData(target) {
    if (!this.analyser || !this.isPlaying) {
      target.fill(0);
      return false;
    }
    this.analyser.getByteFrequencyData(target);
    return true;
  }

  getCurrentTime() {
    if (this.audioElement && this.currentTrack && this.currentTrack.streamUrl && Number.isFinite(this.audioElement.currentTime)) {
      return this.audioElement.currentTime;
    }
    if (!this.currentTrack) return 0;
    const bpm = this.currentTrack.bpm || 128;
    const stepMs = (60 / bpm / 2) * 1000;
    return (this.stepIndex * stepMs) / 1000;
  }

  getDuration() {
    if (this.audioElement && this.currentTrack && this.currentTrack.streamUrl && Number.isFinite(this.audioElement.duration) && this.audioElement.duration > 0) {
      return this.audioElement.duration;
    }
    return this.currentTrack ? this.currentTrack.duration : 0;
  }

  restartSequencer() {
    if (this.stepTimer !== null) {
      window.clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
    if (!this.currentTrack || !this.isPlaying) return;
    const bpm = this.currentTrack.bpm || 128;
    const stepMs = Math.max(110, Math.round((60 / bpm / 2) * 1000));
    this.triggerStep();
    this.stepTimer = window.setInterval(() => this.triggerStep(), stepMs);
  }

  triggerStep() {
    if (!this.ctx || !this.masterGain || !this.currentTrack || !this.isPlaying) return;
    if (this.ctx.state !== 'running') return;

    const track = this.currentTrack;
    const now = this.ctx.currentTime;
    const scale = SCALES[track.scale] || SCALES.minor;
    const bar = Math.floor(this.stepIndex / 8) % 4;
    const stepInBar = this.stepIndex % 8;

    const prog = [0, 5, 3, 4];
    const chordDegree = prog[bar];
    const rootMidi = (track.rootMidi || 60) + scale[chordDegree % scale.length];

    // Atmospheric chord pad
    if (stepInBar === 0) {
      [0, 2, 4].forEach((degOffset, i) => {
        const noteIdx = (chordDegree + degOffset) % scale.length;
        const octaveShift = chordDegree + degOffset >= scale.length ? 12 : 0;
        this.playVoice({
          type: 'triangle',
          freq: midiToFreq((track.rootMidi || 60) + scale[noteIdx] + octaveShift),
          detune: (i - 1) * 5,
          attack: 0.28,
          decay: 1.9,
          gain: 0.055,
          cutoff: track.genre === 'Ambient' ? 900 : 1450,
          now,
        });
      });
    }

    // Sub-bass pulse
    const bpm = track.bpm || 128;
    if (stepInBar === 0 || (bpm >= 120 && (stepInBar === 3 || stepInBar === 6))) {
      this.playVoice({
        type: 'sine',
        freq: midiToFreq(rootMidi - 12),
        detune: 0,
        attack: 0.02,
        decay: bpm >= 120 ? 0.34 : 0.85,
        gain: 0.14,
        cutoff: 260,
        now,
      });
    }

    // Arpeggio shimmer
    const arpPattern = [0, 2, 4, 7, 4, 2, 5, 3];
    if (track.genre !== 'Ambient' || stepInBar % 2 === 0) {
      const deg = (chordDegree + arpPattern[stepInBar]) % scale.length;
      this.playVoice({
        type: bpm >= 130 ? 'sawtooth' : 'sine',
        freq: midiToFreq((track.rootMidi || 60) + 12 + scale[deg]),
        detune: stepInBar % 2 === 0 ? -4 : 4,
        attack: 0.015,
        decay: track.genre === 'Ambient' ? 0.65 : 0.24,
        gain: bpm >= 130 ? 0.032 : 0.048,
        cutoff: bpm >= 130 ? 1800 : 1300,
        now,
      });
    }

    // Minimal kick for rhythmic genres
    if (track.genre !== 'Ambient' && stepInBar % 2 === 0) {
      this.playKick(now, bpm >= 130 ? 0.14 : 0.1);
    }

    this.stepIndex += 1;
  }

  playVoice(opts) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.freq, opts.now);
    osc.detune.setValueAtTime(opts.detune, opts.now);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(opts.cutoff, opts.now);
    filter.Q.value = 1.2;

    env.gain.setValueAtTime(0.0001, opts.now);
    env.gain.linearRampToValueAtTime(opts.gain, opts.now + opts.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, opts.now + opts.attack + opts.decay);

    osc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(opts.now);
    osc.stop(opts.now + opts.attack + opts.decay + 0.04);
  }

  playKick(now, level) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.11);

    env.gain.setValueAtTime(level, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.connect(env);
    env.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.18);
  }
}

export const audioEngine = new OpenMusicAudioEngine();
