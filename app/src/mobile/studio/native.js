// native.js — Studio bridge to Android native media layer
// (MediaSession, MediaStyle lockscreen notification, homescreen AppWidget).

function bridge() {
  try {
    return typeof window !== 'undefined' && window.TMNative ? window.TMNative : null;
  } catch {
    return null;
  }
}

let lastMetaKey = '';
let lastPlaying = null;
let lastStatePush = 0;

export function pushMeta(track) {
  const b = bridge();
  if (!b || typeof b.pushMeta !== 'function') return;
  const key = track ? `${track.id}|${track.title}|${track.artistName}` : '';
  if (key === lastMetaKey) return;
  lastMetaKey = key;

  try {
    b.pushMeta(
      JSON.stringify({
        title: (track && track.title) || 'OpenMusic',
        artist: (track && track.artistName) || 'Nothing playing',
        album: (track && track.albumTitle) || '',
        art: (track && track.artwork) || '',
      })
    );
  } catch (err) {
    console.warn('[TMNative] pushMeta error:', err);
  }
}

export function pushState(isPlaying, posSec, durSec, force = false) {
  const b = bridge();
  if (!b || typeof b.pushState !== 'function') return;

  const playing = Boolean(isPlaying);
  const now = Date.now();
  if (!force && playing === lastPlaying && now - lastStatePush < 1500) {
    return;
  }
  lastPlaying = playing;
  lastStatePush = now;

  try {
    b.pushState(
      JSON.stringify({
        playing,
        pos: Math.max(0, Math.floor((posSec || 0) * 1000)),
        dur: Math.max(0, Math.floor((durSec || 0) * 1000)),
        rate: 1.0,
      })
    );
  } catch (err) {
    console.warn('[TMNative] pushState error:', err);
  }
}

/// Ask Android to pin the homescreen widget (AppWidgetManager
/// .requestPinAppWidget). Returns 'ok' | 'unsupported' | 'none' | 'err: …'.
export function pinWidget() {
  const b = bridge();
  if (!b || typeof b.pinWidget !== 'function') return 'none';
  try {
    return String(b.pinWidget() || 'err');
  } catch {
    return 'err';
  }
}

export function initNativeBridge(store) {
  if (typeof window === 'undefined') return;

  // 1. Expose window.__tmRemote so notification actions, lockscreen and homescreen
  // widget buttons directly control OpenMusic Studio playback.
  window.__tmRemote = {
    play() {
      if (!store.isPlaying) store.togglePlay();
    },
    pause() {
      if (store.isPlaying) store.togglePlay();
    },
    toggle() {
      store.togglePlay();
    },
    next() {
      store.nextTrack(false);
    },
    prev() {
      store.previousTrack();
    },
    seekTo(ms) {
      store.seek(Math.max(0, Number(ms) || 0) / 1000);
      const cur = store.getCurrentTrack();
      pushState(store.isPlaying, Number(ms) / 1000, cur ? cur.duration : 0, true);
    },
    seekBy(dMs) {
      const nextPos = Math.max(0, (store.currentTime || 0) + Number(dMs) / 1000);
      store.seek(nextPos);
      const cur = store.getCurrentTrack();
      pushState(store.isPlaying, nextPos, cur ? cur.duration : 0, true);
    },
    stop() {
      if (store.isPlaying) store.togglePlay();
      const b = bridge();
      if (b && typeof b.dismissNotification === 'function') {
        try {
          b.dismissNotification();
        } catch {}
      }
    },
  };

  // 2. Cold-start & action drain
  function drainPending() {
    const b = bridge();
    if (!b) return;
    try {
      if (typeof b.consumeAction === 'function') {
        const raw = b.consumeAction();
        if (raw) {
          const [action, seekMs] = String(raw).split('|');
          const R = window.__tmRemote;
          if (/TOGGLE$/.test(action)) R.toggle();
          else if (/NEXT$/.test(action)) R.next();
          else if (/PREV$/.test(action)) R.prev();
          else if (/PLAY$/.test(action)) R.play();
          else if (/PAUSE$/.test(action)) R.pause();
          else if (/SEEK_TO$/.test(action)) R.seekTo(Number(seekMs) || 0);
          else if (/STOP$|DISMISS$/.test(action)) R.stop();
        }
      }
    } catch (err) {
      console.warn('[TMNative] consumeAction error:', err);
    }

    try {
      if (typeof b.consumeRoute === 'function') {
        const route = b.consumeRoute();
        if (route) {
          if (route === 'nowplaying') {
            store.openNowPlaying();
          } else {
            store.navigate(route);
          }
        }
      }
    } catch (err) {
      console.warn('[TMNative] consumeRoute error:', err);
    }
  }

  // 3. Connect store events to native media hub pushes.
  // NOTE: the store API is subscribe(fn) — there is no .on(), and it never
  // emits a 'trackChange' type. The old .on() calls threw at boot, which
  // silently killed every pushMeta/pushState → no notification, no
  // lockscreen controls, no widget updates (docs/mobile/11 §2c).
  const syncToNative = (forceState = false) => {
    const track = store.getCurrentTrack();
    pushMeta(track);
    const dur = track && track.duration > 0 ? track.duration : store.duration || 0;
    pushState(store.isPlaying, store.currentTime, dur, forceState);
  };

  store.subscribe((type) => {
    if (type === 'state') syncToNative(false);
  });

  // Ticker for progress bar updates on homescreen widget & lockscreen
  setInterval(() => {
    if (store.isPlaying) {
      syncToNative(false);
    }
  }, 2000);

  // Poll for bridge ready on boot and drain any pending remote intents
  let tries = 0;
  const timer = setInterval(() => {
    if (bridge() || ++tries > 30) {
      clearInterval(timer);
      drainPending();
      syncToNative(true);
    }
  }, 200);
}
