// OpenMusic pure vanilla JS controller: DOM mounting, event delegation, live visualizer & QR canvas
import { audioEngine } from './audio.js';
import { formatTime } from './data.js';
import {
  renderDesktopDock,
  renderMobileChrome,
  renderModal,
  renderRouteSkeleton,
  renderScreen,
  renderSidebar,
  renderToast,
} from './screens.js';
import { store } from './store.js';

const elApp = document.getElementById('app');
const elRouteProgress = document.getElementById('route-progress');
const elSidebar = document.getElementById('sidebar');
const elScreenRoot = document.getElementById('screen-root');
const elDesktopDock = document.getElementById('desktop-dock');
const elMobileChrome = document.getElementById('mobile-chrome');
const elModalRoot = document.getElementById('modal-root');
const elToastRoot = document.getElementById('toast-root');

let visualizerRaf = null;
const freqBuffer = new Uint8Array(64);
let progressResetTimer = null;
let lastRouteKey = '';
let lastWasSkeleton = false;
let lastTrackSeq = 0;
let lastNpLyrics = false;
let lastNpTab = '';
let lastChartsTab = '';
let lastArtistTab = '';
let lastHomeCat = '';

/* ============================================================================
 * CANVAS VISUALIZER & DETERMINISTIC JAM QR RENDERER
 * ========================================================================== */

function stopVisualizer() {
  if (visualizerRaf !== null) {
    window.cancelAnimationFrame(visualizerRaf);
    visualizerRaf = null;
  }
}

function startVisualizerIfPresent() {
  stopVisualizer();
  const canvas = document.getElementById('np-visualizer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bars = 42;
  let phase = 0;

  const draw = () => {
    const activeCanvas = document.getElementById('np-visualizer');
    if (!activeCanvas) {
      visualizerRaf = null;
      return;
    }

    const w = activeCanvas.width;
    const h = activeCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const hasSignal = audioEngine.getFrequencyData(freqBuffer);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';

    const gap = 3;
    const barW = Math.max(2, (w - gap * (bars - 1)) / bars);
    phase += store.isPlaying ? 0.08 : 0.015;

    for (let i = 0; i < bars; i++) {
      let amp;
      if (hasSignal) {
        const bin = Math.min(freqBuffer.length - 1, Math.floor((i / bars) * 44));
        amp = Math.max(0.1, freqBuffer[bin] / 255);
      } else if (store.isPlaying) {
        amp = 0.22 + 0.52 * Math.abs(Math.sin(phase + i * 0.34) * Math.cos(phase * 0.6 + i * 0.12));
      } else {
        amp = 0.1 + 0.08 * Math.abs(Math.sin(phase + i * 0.25));
      }

      const barH = Math.max(3, Math.round(amp * (h - 4)));
      const x = i * (barW + gap);
      const y = h - barH;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 2) : ctx.fillRect(x, y, barW, barH);
      ctx.fill();
    }

    visualizerRaf = window.requestAnimationFrame(draw);
  };

  visualizerRaf = window.requestAnimationFrame(draw);
}

function drawJamQrIfPresent() {
  const canvas = document.getElementById('jam-qr');
  if (!canvas) return;
  const code = canvas.getAttribute('data-qr-code') || 'OM-LIVE';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const size = 21;
  const pad = 10;
  const cell = Math.floor((canvas.width - pad * 2) / size);
  const offset = Math.floor((canvas.width - cell * size) / 2);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Deterministic PRNG seeded by room code
  let seed = 2166136261;
  for (let i = 0; i < code.length; i++) {
    seed ^= code.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const nextBit = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 24) & 1;
  };

  const drawFinder = (gx, gy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const border = x === 0 || y === 0 || x === 6 || y === 6;
        const inner = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (border || inner) {
          ctx.fillRect(offset + (gx + x) * cell, offset + (gy + y) * cell, cell, cell);
        }
      }
    }
  };

  ctx.fillStyle = '#111214';
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inTL = x < 8 && y < 8;
      const inTR = x >= size - 8 && y < 8;
      const inBL = x < 8 && y >= size - 8;
      if (inTL || inTR || inBL) continue;
      if (nextBit()) {
        ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell);
      }
    }
  }
}

/* ============================================================================
 * SURGICAL PLAYBACK DOM UPDATES (ON 250ms TICK — ZERO FULL RE-RENDER)
 * ========================================================================== */

function updatePlaybackDom() {
  const track = store.getCurrentTrack();
  if (!track) return;
  const pct = track.duration > 0 ? Math.min(100, (store.currentTime / track.duration) * 100) : 0;
  const remaining = Math.max(0, track.duration - store.currentTime);

  document.querySelectorAll('[data-bind-progress]').forEach((el) => {
    el.style.width = `${pct.toFixed(2)}%`;
  });
  document.querySelectorAll('[data-bind-thumb]').forEach((el) => {
    el.style.left = `${pct.toFixed(2)}%`;
  });
  document.querySelectorAll('[data-bind-bubble]').forEach((el) => {
    el.style.left = `${pct.toFixed(2)}%`;
    el.textContent = formatTime(store.currentTime);
  });
  document.querySelectorAll('[data-bind-mini-progress]').forEach((el) => {
    el.style.width = `${pct.toFixed(2)}%`;
  });
  document.querySelectorAll('[data-bind-range]').forEach((el) => {
    if (document.activeElement !== el) {
      el.value = String(Math.floor(store.currentTime));
    }
  });
  document.querySelectorAll('[data-bind-elapsed]').forEach((el) => {
    el.textContent = formatTime(store.currentTime);
  });
  document.querySelectorAll('[data-bind-remaining]').forEach((el) => {
    el.textContent = `-${formatTime(remaining)}`;
  });

  // Update active synced lyric line + word-by-word progress & auto-scroll
  syncWordLyricsFrame({ forceScroll: false });

  // Update Jam drift telemetry if visible
  if (store.jam.active) {
    document.querySelectorAll('[data-bind-drift]').forEach((el) => {
      el.textContent = `${store.jam.listeners.length} listening together · ${store.jam.code} · ±${store.jam.driftMs}ms`;
    });
    document.querySelectorAll('[data-bind-drift-val]').forEach((el) => {
      el.textContent = `±${store.jam.driftMs} ms`;
    });
  }

  // Update EQ band numeric labels smoothly when dragging EQ sliders
  document.querySelectorAll('[data-bind-eq-val]').forEach((el) => {
    const idx = Number(el.getAttribute('data-bind-eq-val'));
    const val = store.eq.bands[idx];
    if (typeof val === 'number') {
      el.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)}dB`;
    }
  });

  // Update Settings volume % and crossfade labels smoothly on drag
  document.querySelectorAll('[data-bind-volume-pct]').forEach((el) => {
    el.textContent = `${Math.round(store.volume * 100)}%`;
  });
  document.querySelectorAll('[data-bind-crossfade]').forEach((el) => {
    const sec = Number(store.settings.crossfadeSec ?? 0);
    el.textContent = sec === 0 ? 'OFF' : `${sec.toFixed(1)}s`;
  });
}

/* ============================================================================
 * FULL SHELL RENDER (PRESERVES FOCUSED INPUT CARET WHEN TYPING IN FILTERS)
 * ========================================================================== */

function triggerRouteProgress(phase) {
  if (!elRouteProgress) return;
  if (progressResetTimer) {
    window.clearTimeout(progressResetTimer);
    progressResetTimer = null;
  }
  if (phase === 'start') {
    elRouteProgress.classList.remove('is-done');
    // Force reflow so bar restarts cleanly from 0
    void elRouteProgress.offsetWidth;
    elRouteProgress.classList.add('is-loading');
  } else if (phase === 'finish') {
    elRouteProgress.classList.remove('is-loading');
    elRouteProgress.classList.add('is-done');
    progressResetTimer = window.setTimeout(() => {
      elRouteProgress.classList.remove('is-done');
      progressResetTimer = null;
    }, 360);
  }
}

function markArtworkLoaded(img) {
  img.classList.add('is-loaded');
  img.closest('.artwork')?.classList.add('img-ready');
}

function markArtworkFailed(img) {
  img.style.display = 'none';
  img.closest('.artwork')?.classList.add('img-ready');
}

/**
 * Every render replaces the DOM, so each new <img> starts at opacity 0 until it
 * carries .is-loaded. A cached image can finish loading while the innerHTML
 * fragment is still detached, where a window-level capture listener never sees
 * the event, and the tile keeps painting its fallback sleeve over loaded
 * artwork. Check `complete` first, then wire the element itself for anything
 * still in flight.
 */
function hydrateArtworkLoadStates() {
  document.querySelectorAll('.artwork img').forEach((img) => {
    if (img.complete) {
      // An image that already finished while detached never reports again:
      // classify it now, including the failed case (a 404/dead URL answers
      // `complete` with naturalWidth 0). Leaving it unclassified kept the
      // browser's broken-image icon on the tile instead of our sleeve.
      if (img.naturalWidth > 0) markArtworkLoaded(img);
      else markArtworkFailed(img);
      return;
    }
    if (img.dataset.artWired === '1') return;
    img.dataset.artWired = '1';
    img.addEventListener('load', () => markArtworkLoaded(img), { once: true });
    img.addEventListener('error', () => markArtworkFailed(img), { once: true });
  });
}

function applyKineticEffects({ routeChanged, hydratedFromSkeleton, trackChanged, lyricsToggled, npTabChanged, chartsTabChanged, artistTabChanged, homeCatChanged }) {
  // 1. Directional Page Transition
  elScreenRoot.classList.remove('anim-forward', 'anim-back', 'anim-up', 'anim-down', 'anim-hydrate');
  if (hydratedFromSkeleton) {
    void elScreenRoot.offsetWidth;
    elScreenRoot.classList.add('anim-hydrate');
  } else if (routeChanged && !store.routeLoading) {
    const dir = store.navDirection;
    const cls =
      dir === 'up'
        ? 'anim-up'
        : dir === 'down'
          ? 'anim-down'
          : dir === 'back'
            ? 'anim-back'
            : dir === 'forward'
              ? 'anim-forward'
              : '';
    if (cls) {
      void elScreenRoot.offsetWidth;
      elScreenRoot.classList.add(cls);
    }
  }

  // 2. Track-Change Morph Effects (Artwork + Title + Mini-Player + Dock)
  if (trackChanged) {
    const morphCls =
      store.trackTransition === 'next'
        ? 'morph-next'
        : store.trackTransition === 'prev'
          ? 'morph-prev'
          : 'morph-switch';
    const targets = [
      document.querySelector('.np-art-frame'),
      document.querySelector('.np-title-row'),
      document.querySelector('.dock-left'),
      document.querySelector('.mini-body'),
    ];
    targets.forEach((el) => {
      if (!el) return;
      el.classList.remove('morph-next', 'morph-prev', 'morph-switch');
      void el.offsetWidth;
      el.classList.add(morphCls);
    });
  }

  // 3. Cover <-> Transparent Lyrics Stage Reveal
  if (lyricsToggled) {
    const stage = document.querySelector('.np-art-frame');
    if (stage) {
      stage.classList.remove('np-stage-enter');
      void stage.offsetWidth;
      stage.classList.add('np-stage-enter');
    }
  }

  // 4. Smooth In-Screen Tab Swaps
  if (npTabChanged) {
    const sheet = document.querySelector('.np-sheet-elevated');
    if (sheet) {
      sheet.classList.remove('anim-tab');
      void sheet.offsetWidth;
      sheet.classList.add('anim-tab');
    }
  }
  if (chartsTabChanged) {
    const panel = document.querySelector('[data-tab-panel="charts-view"]');
    if (panel) {
      panel.classList.remove('anim-tab');
      void panel.offsetWidth;
      panel.classList.add('anim-tab');
    }
  }
  if (artistTabChanged) {
    const panel = document.querySelector('[data-tab-panel="artist-discog"]');
    if (panel) {
      panel.classList.remove('anim-tab');
      void panel.offsetWidth;
      panel.classList.add('anim-tab');
    }
  }
  if (homeCatChanged) {
    const panel = document.querySelector('[data-tab-panel="home-cat"]');
    if (panel) {
      panel.classList.remove('anim-tab');
      void panel.offsetWidth;
      panel.classList.add('anim-tab');
    }
  }
}

function renderAll(isSkeletonPass = false) {
  const active = document.activeElement;
  let focusSnapshot = null;
  if (active && active.id && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    focusSnapshot = {
      id: active.id,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  const route = store.getRoute();
  const routeKey = `${route.name}:${route.id || ''}`;
  const isNowPlaying = route.name === 'nowplaying';
  const routeChanged = routeKey !== lastRouteKey;
  const hydratedFromSkeleton = lastWasSkeleton && !isSkeletonPass;
  const trackChanged = !isSkeletonPass && store.trackChangeSeq !== lastTrackSeq;
  const lyricsToggled = !isSkeletonPass && isNowPlaying && store.ui.npShowLyrics !== lastNpLyrics;
  const npTabChanged = !isSkeletonPass && isNowPlaying && !routeChanged && store.ui.npActiveTab !== lastNpTab;
  const chartsTabChanged = !isSkeletonPass && route.name === 'charts' && !routeChanged && store.ui.chartsTab !== lastChartsTab;
  const artistTabChanged = !isSkeletonPass && route.name === 'artist' && !routeChanged && store.ui.artistDiscogTab !== lastArtistTab;
  const homeCatChanged = !isSkeletonPass && route.name === 'home' && !routeChanged && store.ui.homeCategory !== lastHomeCat;

  elScreenRoot.classList.toggle('is-nowplaying', isNowPlaying);
  elDesktopDock.classList.toggle('hidden', isNowPlaying);

  elSidebar.innerHTML = renderSidebar(store);
  elScreenRoot.innerHTML = isSkeletonPass ? renderRouteSkeleton(store) : renderScreen(store);
  elDesktopDock.innerHTML = isNowPlaying ? '' : renderDesktopDock(store);
  elMobileChrome.innerHTML = renderMobileChrome(store);
  elModalRoot.innerHTML = renderModal(store);
  elToastRoot.innerHTML = renderToast(store);

  if (focusSnapshot) {
    const restored = document.getElementById(focusSnapshot.id);
    if (restored) {
      restored.focus({ preventScroll: true });
      if (typeof focusSnapshot.start === 'number' && restored.setSelectionRange) {
        try {
          restored.setSelectionRange(focusSnapshot.start, focusSnapshot.end);
        } catch {
          // Ignore for non-text inputs
        }
      }
    }
  }

  hydrateArtworkLoadStates();

  if (isSkeletonPass) {
    triggerRouteProgress('start');
  } else {
    if (lastWasSkeleton || routeChanged) {
      triggerRouteProgress('finish');
    }
    applyKineticEffects({
      routeChanged,
      hydratedFromSkeleton,
      trackChanged,
      lyricsToggled,
      npTabChanged,
      chartsTabChanged,
      artistTabChanged,
      homeCatChanged,
    });
    startVisualizerIfPresent();
    startLyricsSyncIfPresent();
    drawJamQrIfPresent();
  }

  lastRouteKey = routeKey;
  lastWasSkeleton = isSkeletonPass;
  lastTrackSeq = store.trackChangeSeq;
  lastNpLyrics = store.ui.npShowLyrics;
  lastNpTab = store.ui.npActiveTab;
  lastChartsTab = store.ui.chartsTab;
  lastArtistTab = store.ui.artistDiscogTab;
  lastHomeCat = store.ui.homeCategory;
}

/* ============================================================================
 * 60FPS WORD-BY-WORD LYRIC HIGHLIGHT & AUTO-CENTER SCROLL ENGINE
 * ========================================================================== */

let lyricsRaf = null;
const lastScrolledLineByScroller = new WeakMap();

function scrollLyricToCenter(scroller, lineEl, instant = false) {
  if (!scroller || !lineEl) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();
  const currentScroll = scroller.scrollTop;
  const delta = lineRect.top - scrollerRect.top - scroller.clientHeight / 2 + lineRect.height / 2;
  const targetTop = Math.max(0, currentScroll + delta);
  scroller.scrollTo({
    top: targetTop,
    behavior: instant ? 'instant' : 'smooth',
  });
}

function syncWordLyricsFrame({ forceScroll = false, instant = false } = {}) {
  const scrollers = document.querySelectorAll('[data-lyrics-scroller]');
  if (scrollers.length === 0) return false;

  const track = store.getCurrentTrack();
  if (!track || !track.lyrics || track.lyrics.length === 0) return false;

  const smoothSec = store.getSmoothCurrentTime();
  const adjustedSec = smoothSec + store.ui.npLyricOffsetMs / 1000;
  const activeIdx = store.getActiveLyricIndex(track, smoothSec);

  scrollers.forEach((scroller) => {
    const lines = scroller.querySelectorAll('[data-lyric-idx]');
    let activeLineEl = null;

    lines.forEach((lineEl) => {
      const idx = Number(lineEl.getAttribute('data-lyric-idx'));
      const isActive = idx === activeIdx;
      const isPast = idx < activeIdx;

      if (lineEl.classList.contains('active') !== isActive) {
        lineEl.classList.toggle('active', isActive);
      }
      if (lineEl.classList.contains('is-past') !== isPast) {
        lineEl.classList.toggle('is-past', isPast);
      }

      if (isActive) {
        activeLineEl = lineEl;
        const words = lineEl.querySelectorAll('.lyric-word');
        words.forEach((wEl) => {
          const wStart = Number(wEl.getAttribute('data-w-start'));
          const wEnd = Number(wEl.getAttribute('data-w-end'));
          if (adjustedSec >= wEnd) {
            wEl.classList.add('is-sung');
            wEl.classList.remove('is-speaking');
            wEl.style.removeProperty('--w-pct');
          } else if (adjustedSec > wStart) {
            const pct = Math.max(0, Math.min(100, ((adjustedSec - wStart) / Math.max(0.05, wEnd - wStart)) * 100));
            wEl.classList.remove('is-sung');
            wEl.classList.add('is-speaking');
            wEl.style.setProperty('--w-pct', `${pct.toFixed(1)}%`);
          } else {
            wEl.classList.remove('is-sung', 'is-speaking');
            wEl.style.removeProperty('--w-pct');
          }
        });
      } else {
        // Clear any stale speaking highlight from non-active lines
        const dirtyWords = lineEl.querySelectorAll('.lyric-word.is-speaking, .lyric-word.is-sung');
        if (dirtyWords.length > 0) {
          dirtyWords.forEach((wEl) => {
            wEl.classList.remove('is-sung', 'is-speaking');
            wEl.style.removeProperty('--w-pct');
          });
        }
      }
    });

    const scrollKey = `${track.id}:${activeIdx}`;
    const prevKey = lastScrolledLineByScroller.get(scroller);
    if (activeLineEl && (forceScroll || prevKey !== scrollKey)) {
      lastScrolledLineByScroller.set(scroller, scrollKey);
      scrollLyricToCenter(scroller, activeLineEl, instant);
    }
  });

  return true;
}

function startLyricsSyncIfPresent() {
  if (lyricsRaf) {
    window.cancelAnimationFrame(lyricsRaf);
    lyricsRaf = null;
  }
  const hasLyrics = syncWordLyricsFrame({ forceScroll: true, instant: true });
  if (!hasLyrics) return;

  const tick = () => {
    if (!document.querySelector('[data-lyrics-scroller]')) {
      lyricsRaf = null;
      return;
    }
    syncWordLyricsFrame({ forceScroll: false, instant: false });
    lyricsRaf = window.requestAnimationFrame(tick);
  };

  lyricsRaf = window.requestAnimationFrame(tick);
}

/* ============================================================================
 * CSP-COMPLIANT IMAGE LOAD & ERROR HANDLING
 * ========================================================================== */

window.addEventListener(
  'load',
  (event) => {
    const el = event.target;
    if (el && el.tagName === 'IMG') markArtworkLoaded(el);
  },
  true
);

window.addEventListener(
  'error',
  (event) => {
    const el = event.target;
    if (el && el.tagName === 'IMG') markArtworkFailed(el);
  },
  true
);

/* ============================================================================
 * EVENT DELEGATION
 * ========================================================================== */

elApp.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.getAttribute('data-action');

  // Backdrop click only closes if user clicked directly on the backdrop
  if (action === 'backdrop-close') {
    if (event.target === target) {
      store.closeModals();
    }
    return;
  }

  switch (action) {
    case 'nav': {
      const route = target.getAttribute('data-route');
      const id = target.getAttribute('data-id') || undefined;
      const query = target.getAttribute('data-query');
      store.navigate(route, { ...(id ? { id } : {}), ...(query !== null ? { query } : {}) });
      break;
    }
    case 'nav-from-modal': {
      const route = target.getAttribute('data-route');
      const id = target.getAttribute('data-id') || undefined;
      store.closeModals();
      store.navigate(route, id ? { id } : {});
      break;
    }
    case 'back':
      store.goBack();
      break;
    case 'set-ui': {
      const key = target.getAttribute('data-key');
      const value = target.getAttribute('data-value');
      if (key === 'settingsTab') {
        store.setUi({ settingsTab: value, settingsSearch: '' });
      } else if (key) {
        store.setUi({ [key]: value });
      }
      break;
    }
    case 'toggle-ui-bool': {
      const key = target.getAttribute('data-key');
      if (key) store.setUi({ [key]: !store.ui[key] });
      break;
    }
    case 'play-track': {
      const trackId = target.getAttribute('data-track-id');
      const queueStr = target.getAttribute('data-queue');
      const queue = queueStr ? queueStr.split(',').filter(Boolean) : null;
      store.playTrack(trackId, queue);
      break;
    }
    case 'play-queue': {
      const queueStr = target.getAttribute('data-queue') || '';
      const ids = queueStr.split(',').filter(Boolean);
      store.playQueue(ids, { shuffle: false });
      break;
    }
    case 'shuffle-queue': {
      const queueStr = target.getAttribute('data-queue') || '';
      const ids = queueStr.split(',').filter(Boolean);
      store.playQueue(ids, { shuffle: true });
      break;
    }
    case 'play-queue-index': {
      const idx = Number(target.getAttribute('data-index'));
      if (Number.isFinite(idx) && store.queue[idx]) {
        store.queueIndex = idx;
        store.playTrack(store.queue[idx], store.queue);
      }
      break;
    }
    case 'remove-queue-index': {
      const idx = Number(target.getAttribute('data-index'));
      store.removeFromQueue(idx);
      break;
    }
    case 'play-playlist':
      // Curated shelves load their tracks lazily on first play.
      store.playPlaylist(target.getAttribute('data-id'), { shuffle: false });
      break;
    case 'shuffle-playlist':
      store.playPlaylist(target.getAttribute('data-id'), { shuffle: true });
      break;
    case 'play-artist-radio':
      store.playArtistRadio(target.getAttribute('data-id'));
      break;
    case 'toggle-play':
      store.togglePlay();
      break;
    case 'prev-track':
      store.prevTrack();
      break;
    case 'next-track':
      store.nextTrack(false);
      break;
    case 'toggle-shuffle':
      store.toggleShuffle();
      break;
    case 'cycle-repeat':
      store.cycleRepeat();
      break;
    case 'toggle-mute':
      store.toggleMute();
      break;
    case 'seek-to': {
      const t = Number(target.getAttribute('data-time'));
      store.seekTo(t);
      break;
    }
    case 'toggle-like':
      store.toggleLike(target.getAttribute('data-track-id'));
      break;
    case 'toggle-follow':
      store.toggleFollowArtist(target.getAttribute('data-id'));
      break;
    case 'open-track-menu':
      store.openTrackMenu(target.getAttribute('data-track-id'));
      break;
    case 'track-menu-pick-playlist':
      store.ui.trackMenuPickPlaylist = true;
      store.emit('state');
      break;
    case 'track-menu-back':
      store.ui.trackMenuPickPlaylist = false;
      store.emit('state');
      break;
    case 'add-track-to-playlist':
      store.addTrackToPlaylist(
        target.getAttribute('data-playlist-id'),
        target.getAttribute('data-track-id')
      );
      break;
    case 'remove-from-playlist':
      store.removeTrackFromPlaylist(
        target.getAttribute('data-playlist-id'),
        target.getAttribute('data-track-id')
      );
      break;
    case 'open-create-playlist':
      store.openCreatePlaylist();
      break;
    case 'delete-playlist':
      store.deletePlaylist(target.getAttribute('data-id'));
      break;
    case 'open-eq':
      store.openEqModal();
      break;
    case 'toggle-eq':
      store.toggleEqEnabled();
      break;
    case 'set-eq-preset':
      store.setEqPreset(target.getAttribute('data-preset'));
      break;
    case 'open-np-tab': {
      const tab = target.getAttribute('data-tab') || 'queue';
      if (tab === 'lyrics') {
        store.ui.npShowLyrics = true;
      } else {
        store.ui.npActiveTab = tab;
      }
      store.navigate('nowplaying');
      break;
    }
    case 'open-jam':
      store.ui.npSocialMode = true;
      store.ui.npActiveTab = 'jam';
      store.navigate('nowplaying');
      break;
    case 'set-np-mode': {
      const mode = target.getAttribute('data-mode');
      if (mode === 'social') {
        store.setUi({ npSocialMode: true, npActiveTab: 'jam' });
      } else {
        store.setUi({ npSocialMode: false, npActiveTab: 'queue' });
      }
      break;
    }
    case 'create-jam':
      store.createJamRoom();
      break;
    case 'leave-jam':
      store.leaveJamRoom();
      break;
    case 'send-quick-chat':
      store.sendJamChat(target.getAttribute('data-text'));
      break;
    case 'append-emoji': {
      const emoji = target.getAttribute('data-emoji') || '';
      if (emoji.length > 3) {
        store.sendJamChat(emoji);
        store.setUi({ npEmojiOpen: false });
      } else {
        const next = store.ui.npChatDraft ? `${store.ui.npChatDraft} ${emoji}` : emoji;
        store.setUi({ npChatDraft: next, npEmojiOpen: false });
        const inp = document.getElementById('np-chat-input');
        if (inp) inp.focus();
      }
      break;
    }
    case 'lyric-offset': {
      const delta = Number(target.getAttribute('data-delta')) || 0;
      store.setUi({ npLyricOffsetMs: store.ui.npLyricOffsetMs + delta });
      break;
    }
    case 'play-next':
      store.playNext(target.getAttribute('data-track-id'));
      store.closeModals();
      break;
    case 'add-to-queue':
      store.addToQueue(target.getAttribute('data-track-id'));
      if (store.ui.modalTrackId) store.closeModals();
      break;
    case 'queue-download':
      store.queueDownload(target.getAttribute('data-track-id'));
      store.closeModals();
      break;
    case 'download-bulk': {
      const queueStr = target.getAttribute('data-queue') || '';
      const ids = queueStr.split(',').filter(Boolean);
      const label = target.getAttribute('data-label') || 'tracks';
      store.queueBulkDownloads(ids, label);
      break;
    }
    case 'remove-download':
      store.removeDownload(target.getAttribute('data-track-id'));
      if (store.ui.modalTrackId) store.closeModals();
      break;
    case 'toggle-pause-all-downloads':
      store.togglePauseAllDownloads();
      break;
    case 'toggle-download-pause':
      store.toggleSingleDownloadPause(target.getAttribute('data-track-id'));
      break;
    case 'refresh-downloads':
      store.refreshDownloads();
      break;
    case 'cycle-downloads-sort': {
      const order = ['recent', 'alpha', 'size'];
      const next = order[(order.indexOf(store.ui.downloadsSort) + 1) % order.length];
      store.setUi({ downloadsSort: next });
      break;
    }
    case 'clear-search':
      store.setUi({ searchQuery: '' });
      break;
    case 'apply-search': {
      // Commit the query through the store so the real search actually runs.
      store.applySearch(target.getAttribute('data-query') || '');
      break;
    }
    case 'remove-recent-search':
      store.removeRecentSearch(target.getAttribute('data-query'));
      break;
    case 'clear-recent-searches':
      store.clearRecentSearches();
      break;
    case 'toggle-library-sort':
      store.setUi({ librarySort: store.ui.librarySort === 'recent' ? 'alpha' : 'recent' });
      break;
    case 'toggle-library-view':
      store.setUi({ libraryView: store.ui.libraryView === 'list' ? 'grid' : 'list' });
      break;
    case 'cycle-album-sort': {
      const order = ['track', 'alpha', 'duration'];
      const next = order[(order.indexOf(store.ui.albumSort) + 1) % order.length];
      store.setUi({ albumSort: next });
      break;
    }
    case 'clear-history':
      store.clearHistory();
      break;
    case 'export-telemetry':
      store.exportBackupJson('openmusic-telemetry.json');
      break;
    case 'mark-notification-read':
      store.markNotificationRead(target.getAttribute('data-id'));
      break;
    case 'mark-all-read':
      store.markAllNotificationsRead();
      break;
    case 'clear-notifications':
      store.clearNotifications();
      break;
    case 'toggle-setting': {
      const key = target.getAttribute('data-key');
      if (key) store.updateSettings({ [key]: !store.settings[key] });
      break;
    }
    case 'set-theme': {
      const darkMode = target.getAttribute('data-mode') === 'dark';
      if (store.settings.darkMode !== darkMode) {
        store.updateSettings({ darkMode });
        store.showToast(darkMode ? 'Switched to Obsidian Studio Dark' : 'Switched to Nordic Paper Light');
      }
      break;
    }
    case 'set-quality': {
      const quality = target.getAttribute('data-quality');
      if (quality) {
        store.updateSettings({ downloadQuality: quality });
        store.showToast(`Codec set to ${quality}`);
      }
      break;
    }
    case 'confirm-reset-settings':
      store.setUi({ confirmResetSettings: true });
      break;
    case 'cancel-reset-settings':
      store.setUi({ confirmResetSettings: false });
      break;
    case 'reset-settings':
      store.resetSettingsToDefaults();
      break;
    case 'toggle-language':
      store.toggleLanguage(target.getAttribute('data-lang'));
      break;
    case 'export-backup':
      store.exportBackupJson('openmusic-backup.json');
      break;
    case 'check-updates':
      store.checkUpdates();
      break;
    case 'open-info':
      store.openInfoModal(target.getAttribute('data-type'));
      break;
    case 'share-link':
      store.shareLink(target.getAttribute('data-label') || 'OpenMusic');
      if (store.ui.modalTrackId) store.closeModals();
      break;
    case 'close-modals':
      store.closeModals();
      break;
    default:
      break;
  }
});

// Draft inputs that do NOT need live DOM re-render on every keystroke
const SILENT_UI_INPUTS = new Set([
  'npChatDraft',
  'npJoinCode',
  'createPlaylistName',
  'createPlaylistDesc',
]);

let liveSearchDebounceTimer = null;

elApp.addEventListener('input', (event) => {
  const el = event.target;

  const uiKey = el.getAttribute('data-input-ui');
  if (uiKey) {
    if (SILENT_UI_INPUTS.has(uiKey)) {
      store.ui[uiKey] = el.value;
    } else {
      store.setUi({ [uiKey]: el.value });
      if (uiKey === 'searchQuery') {
        if (liveSearchDebounceTimer) window.clearTimeout(liveSearchDebounceTimer);
        liveSearchDebounceTimer = window.setTimeout(() => {
          store.searchLive(el.value);
        }, 260);
      }
    }
    return;
  }

  const settingKey = el.getAttribute('data-setting-input');
  if (settingKey) {
    store.settings[settingKey] = el.value;
    store.persist();
    return;
  }

  const action = el.getAttribute('data-action');
  if (action === 'seek') {
    store.seekTo(Number(el.value));
  } else if (action === 'volume') {
    store.setVolume(Number(el.value));
  } else if (action === 'eq-band') {
    const idx = Number(el.getAttribute('data-band'));
    store.setEqBand(idx, Number(el.value));
  } else if (action === 'settings-crossfade') {
    store.settings.crossfadeSec = Number(el.value);
    store.persist();
    store.emit('tick');
  }
});

elApp.addEventListener('change', (event) => {
  const el = event.target;

  const selectKey = el.getAttribute('data-setting-select');
  if (selectKey) {
    store.updateSettings({ [selectKey]: el.value });
    return;
  }

  if (el.getAttribute('data-setting-input') === 'displayName') {
    store.updateSettings({ displayName: el.value.trim() || 'Listener' });
    return;
  }

  if (el.getAttribute('data-action') === 'import-backup' && el.files && el.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        store.importBackupJson(reader.result);
      }
    };
    reader.readAsText(el.files[0]);
    el.value = '';
  }
});

elApp.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-submit]');
  if (!form) return;
  event.preventDefault();

  const kind = form.getAttribute('data-submit');
  if (kind === 'jam-chat') {
    store.sendJamChat(store.ui.npChatDraft);
  } else if (kind === 'join-jam') {
    store.joinJamRoom(store.ui.npJoinCode);
  } else if (kind === 'create-playlist') {
    store.createPlaylist(
      store.ui.createPlaylistName,
      store.ui.createPlaylistDesc,
      store.ui.createPlaylistPrivate
    );
  } else if (kind === 'save-display-name') {
    const clean = (store.settings.displayName || '').trim() || 'Listener';
    store.updateSettings({ displayName: clean });
    store.showToast(`Profile updated for ${clean}`);
  }
});

// Keyboard shortcuts: Space for Play/Pause (when not typing), Escape to close modals
window.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (event.key === 'Escape') {
    if (
      store.ui.modalTrackId ||
      store.ui.modal === 'playlist-create' ||
      store.ui.modal === 'eq' ||
      store.ui.modalInfoType ||
      store.ui.npLyricsFullView
    ) {
      store.closeModals();
    }
    return;
  }

  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    store.togglePlay();
  } else if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    store.navigate('search');
    window.setTimeout(() => {
      document.getElementById('search-input')?.focus();
    }, 60);
  }
});

/* ============================================================================
 * SUBSCRIBE & BOOT
 * ========================================================================== */

store.subscribe((type) => {
  if (type === 'tick') {
    updatePlaybackDom();
  } else if (type === 'toast') {
    elToastRoot.innerHTML = renderToast(store);
  } else if (type === 'route-load') {
    renderAll(true);
  } else {
    renderAll(false);
  }
});

/* ============================================================================
 * ANDROID MEDIASESSION (LOCKSCREEN, SYSTEM NOTIFICATION, CAR AUDIO)
 * ========================================================================== */

if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => store.togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => store.togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => store.prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => store.nextTrack());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) store.seekTo(details.seekTime);
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skip = details.seekOffset || 10;
      store.seekTo(Math.max(0, store.currentTime - skip));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skip = details.seekOffset || 10;
      const dur = store.getCurrentTrack()?.duration || 300;
      store.seekTo(Math.min(dur, store.currentTime + skip));
    });
  } catch (err) {
    console.warn('mediaSession action handler error:', err);
  }
}

renderAll(false);
