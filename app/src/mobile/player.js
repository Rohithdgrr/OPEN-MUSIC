// player.js — one shared <audio> for every mobile screen: queue, resolve, transport.
import { invoke, pushPlay, toast, hqArt } from "./shared.js";

const audio = document.getElementById("audio");
// Full scale: the media element is a limiter (max 1.0), so anything less only
// quietens playback — loudness belongs to the device/OS volume, not here.
if (audio) audio.volume = 1;

let queue = [];
let qi = -1;
let shuffle = false;
let repeat = 0;
let badge = "IDLE";
let seq = 0;

const painters = [];

export function onPaint(fn) {
  painters.push(fn);
}

// ------------------------------------------------------------- media session
// Lock-screen / notification transport. Android's WebView surfaces these once
// metadata + action handlers exist; position state keeps the seek bar honest.
const msSupported = typeof navigator !== "undefined" && "mediaSession" in navigator;

function mediaMeta(track) {
  if (!msSupported || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "",
      artist: track.artist || track.subtitle || "",
      album: track.album || "",
      artwork: track.image
        ? [
            { src: hqArt(track.image, "500x500"), sizes: "500x500", type: "image/jpeg" },
            { src: hqArt(track.image, "150x150"), sizes: "150x150", type: "image/jpeg" },
          ]
        : [],
    });
  } catch {}
}

function mediaState() {
  if (!msSupported) return;
  try {
    navigator.mediaSession.playbackState = audio && !audio.paused ? "playing" : "paused";
    const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
    const pos = audio ? Math.min(audio.currentTime || 0, dur ?? Number.MAX_SAFE_INTEGER) : 0;
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: pos,
      playbackRate: audio && audio.playbackRate ? audio.playbackRate : 1,
    });
  } catch {}
}

function mediaHandlers() {
  if (!msSupported) return;
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  };
  set("play", () => {
    if (audio) audio.play().catch(() => {});
  });
  set("pause", () => {
    if (audio) audio.pause();
  });
  set("previoustrack", () => prev());
  set("nexttrack", () => next());
  set("seekto", (d) => {
    if (d && typeof d.seekTime === "number") seek(d.seekTime);
  });
}
mediaHandlers();

// Called from MainActivity's ACTION_AUDIO_BECOMING_NOISICAL receiver.
window.__pauseNoisy = () => {
  if (audio && !audio.paused) audio.pause();
};

export function playerState() {
  let buf = 0;
  try {
    const b = audio && audio.buffered;
    const dur = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
    if (b && b.length && dur > 0) buf = Math.min(1, b.end(b.length - 1) / dur);
  } catch {}
  return {
    track: queue[qi] || null,
    paused: !audio || audio.paused,
    pos: audio ? audio.currentTime || 0 : 0,
    dur: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
    buf,
    badge,
    shuffle,
    repeat,
    qi,
    queue,
  };
}

function paint() {
  const s = playerState();
  mediaState();
  for (const f of painters) {
    try {
      f(s);
    } catch (e) {
      console.error(e);
    }
  }
}

// One retry for transient blips: a momentary drop must not skip the song and
// must not restart it either — position is captured before the reload and put
// back once metadata is known (mirrors playback.js on desktop).
let retries = 0;
let lastEndedAt = 0;

function streamError() {
  if (!audio || !audio.error) return;
  if (audio.src && retries < 1) {
    retries += 1;
    const src = audio.src;
    const at = audio.currentTime;
    badge = "RETRYING";
    paint();
    setTimeout(() => {
      if (audio.src !== src) return; // the user already moved on
      audio.addEventListener(
        "loadedmetadata",
        () => {
          try {
            audio.currentTime = at;
          } catch {}
        },
        { once: true },
      );
      audio.load();
      // Safety net: a source that never reports metadata must not stall.
      setTimeout(() => {
        if (audio.paused && audio.src === src) audio.play().catch(() => {});
      }, 4000);
    }, 2000);
    return;
  }
  retries = 0;
  badge = "ERROR";
  toast("Playback failed — skipping");
  paint();
  step(1, true);
}

if (audio) {
  for (const ev of [
    "play",
    "pause",
    "timeupdate",
    "loadedmetadata",
    "durationchange",
    "progress",
    "seeked",
    "playing",
    "waiting",
    "ended",
    "error",
  ]) {
    audio.addEventListener(ev, (e) => {
      if (e.type === "ended") return ended();
      if (e.type === "error") return streamError();
      paint();
    });
  }
}

/// Load a playlist/chart's tracks and start it (Home hero, playlist headers).
/// The id is a playlist id, so it must go through `playlist_tracks` — handing
/// it to `resolve_song` would never resolve to audio.
export async function playPlaylist(id, i = 0) {
  if (!invoke || !id) {
    toast("Backend unavailable");
    return false;
  }
  try {
    const r = await invoke("playlist_tracks", { id });
    const list = Array.isArray(r) ? r : (r && (r.list || r.tracks)) || [];
    if (!list.length) {
      toast("That playlist has no playable tracks");
      return false;
    }
    playList(list, i);
    return true;
  } catch (e) {
    console.error(e);
    toast(String(e).slice(0, 100));
    return false;
  }
}

export function playList(list, i = 0) {
  if (!invoke) {
    toast("Backend unavailable");
    return;
  }
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) {
    toast("Nothing to play");
    return;
  }
  queue = q;
  qi = Math.max(0, Math.min(Number(i) || 0, q.length - 1));
  start();
}

/// Queue `track` behind whatever is playing ("Play next"). An empty queue
/// seeds itself, because there is no queue to insert into yet.
export function insertNext(track) {
  if (!track || !track.id) return false;
  if (!queue.length) {
    playList([track], 0);
    return true;
  }
  queue.splice(qi + 1, 0, track);
  paint();
  return true;
}

/// Append `track` to the end of the queue ("Add to queue").
export function enqueue(track) {
  if (!track || !track.id) return false;
  if (!queue.length) {
    playList([track], 0);
    return true;
  }
  queue.push(track);
  paint();
  return true;
}

/// Bulk variants for entity menus: insert/append a whole tracklist at once.
export function insertNextAll(list) {
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) return 0;
  if (!queue.length) {
    playList(q, 0);
    return q.length;
  }
  queue.splice(qi + 1, 0, ...q);
  paint();
  return q.length;
}

export function enqueueAll(list) {
  const q = (list || []).filter((t) => t && t.id);
  if (!q.length) return 0;
  if (!queue.length) {
    playList(q, 0);
    return q.length;
  }
  queue.push(...q);
  paint();
  return q.length;
}

async function start() {
  const track = queue[qi];
  if (!track) return;
  const mine = ++seq;
  retries = 0; // each new track gets a fresh retry budget
  badge = "RESOLVING";
  mediaMeta(track); // lock screen shows the track while it resolves
  paint();
  try {
    const info = await invoke("resolve_song", { id: track.id });
    if (mine !== seq) return;
    if (!info || info.range_status === "dead" || !info.proxy_url) {
      toast(`Could not resolve ${track.title || "track"}`);
      // `true` = auto: an unadvanceable queue (one dead track, repeat off)
      // stops instead of re-resolving the same id forever.
      return step(1, true);
    }
    audio.src = info.proxy_url;
    badge = info.range_status === "unrestricted" ? "LOSSLESS" : String(info.chosen_quality || info.range_status || "OK").toUpperCase();
    pushPlay(track);
    await audio.play();
    prefetchNext();
  } catch (e) {
    if (mine === seq) {
      badge = "ERROR";
      console.error(e);
      toast(String(e).slice(0, 100));
    }
  }
  if (mine === seq) paint();
}

// Warm the resolve + range probe for the next queued track so advancing is a
// cache hit instead of a network wait. Quiet by design.
function prefetchNext() {
  if (!invoke) return;
  const ids = queue
    .slice(qi + 1, qi + 3)
    .map((t) => t && t.id)
    .filter(Boolean);
  if (!ids.length) return;
  try {
    invoke("prefetch_next", { ids }).catch(() => {});
  } catch {}
}

export function toggle() {
  if (!audio || !audio.src) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function ended() {
  // Some engines fire `ended` twice in quick succession; ignore the repeat so
  // a double event can never skip the next track (mirrors playback.js).
  const now = Date.now();
  if (now - lastEndedAt < 600) return;
  lastEndedAt = now;
  if (repeat === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  step(1, true);
}

function step(dir, auto = false) {
  if (!queue.length) return;
  if (shuffle && dir > 0 && queue.length > 1) {
    let n = qi;
    while (n === qi) n = Math.floor(Math.random() * queue.length);
    qi = n;
  } else {
    qi += dir;
    if (qi >= queue.length) {
      if (repeat === 1) qi = 0;
      else {
        qi = queue.length - 1;
        if (auto) {
          audio.pause();
          audio.currentTime = 0;
          paint();
          return;
        }
      }
    }
    if (qi < 0) qi = queue.length - 1;
  }
  start();
}

export function next() {
  step(1);
}

export function prev() {
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  step(-1);
}

export function seek(sec) {
  if (audio && Number.isFinite(sec)) audio.currentTime = Math.max(0, Math.min(sec, audio.duration || sec));
}

export function setShuffle(v) {
  shuffle = !!v;
  paint();
}

export function toggleShuffle() {
  setShuffle(!shuffle);
}

export function cycleRepeat() {
  repeat = (repeat + 1) % 3;
  paint();
}

export { audio };
