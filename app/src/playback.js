// playback.js — playQueueItem and stream error handling
// Split from main.js (Phase 4 M1).
import { hqArt, LOGO, paintSharpCover } from "./art.js";
import { emitState } from "./bridge.js";
import { clearError, diag, invoke, showError, toast } from "./core.js";
import { $, audio, audio2, bar, np } from "./dom.js";
import { paintFavHearts, pushPlay } from "./library.js";
import { loadLyrics, prefetchLyrics } from "./lyrics.js";
import { setMediaSessionTrack } from "./media.js";
import { setBadge, setPlayIcon } from "./player.js";
import { localRole } from "./room.js";
import { advanceQueue, markQueue, pickNextIndex, queue, queueIndex, renderQueue, repeatMode, setCurrent, setQueueIndex } from "./queue.js";
import { ensureReco } from "./radio.js";
import { prefetchNext, prefetchTrack, isDownloaded } from "./vault.js";
import { netMode } from "./net.js";
import { npText, stampEntity } from "./util.js";

// ---------------------------------------------------------------- playback -
export let lastEndedAt = 0;
audio.addEventListener("ended", () => {
  // Some engines fire `ended` twice in quick succession; ignore the repeat
  // so a double event can never skip the next track.
  const now = Date.now();
  if (now - lastEndedAt < 600) return;
  lastEndedAt = now;
  cancelFade(); // a fade that never got to hand over must not strand audio2
  if (repeatMode === "one" && audio.src) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  // Finished songs start over next time; nothing to resume.
  try {
    localStorage.removeItem("tm-pos");
  } catch {}
  markQueue("done");
  advanceQueue();
});

// One retry for transient network blips: a momentary drop must not skip the
// song, and it must not restart it either — `audio.load()` throws the playhead
// away, so the position is captured here and put back once the new source
// knows its length. The budget resets on every new track (see playQueueItem).
export let streamRetries = 0;
audio.addEventListener("error", () => {
  if (!audio.error) return;
  if (audio.src && streamRetries < 1) {
    streamRetries += 1;
    const src = audio.src;
    const at = audio.currentTime;
    diag("stream", false, `media error ${audio.error.code} - retrying once in 2s`);
    setTimeout(() => {
      if (audio.src !== src) return; // the user already moved on
      audio.addEventListener("loadedmetadata", () => seekTo(at), { once: true });
      audio.load();
      // Safety net: a source that never reports metadata must not leave the
      // player paused forever.
      setTimeout(() => {
        if (audio.paused) audio.play().then(() => setPlayIcon(true)).catch(() => {});
      }, 4000);
    }, 2000);
    return;
  }
  streamRetries = 0;
  showError(
    `Playback failed (media error ${audio.error.code}). ` +
      "The stream URL was refused by the browser media stack.",
  );
  markQueue("failed");
  advanceQueue();
});

// ------------------------------------------------------------ resume position -
// Where the playhead was, so a reload, a crash, a shutdown or a plain reopen
// picks the song up where it stopped instead of at 0:00. One key, written on
// a timer and again on the way out, so even a hard kill costs a couple of
// seconds. ponytail: no sessionStorage/IndexedDB — localStorage is already
// what every other piece of app state uses.
const POS_KEY = "tm-pos";
let pendingResume = null; // { id, t } — applied once, to the next play of that id

/// Seed the position at boot (main.js). Only the song the app is about to
/// offer is worth carrying over.
export function setResume(id, t) {
  if (!rememberPosOn()) return;
  if (id && t > 1) pendingResume = { id, t };
}

function seekTo(t) {
  try {
    if (!(t > 0)) return;
    const end = Number.isFinite(audio.duration) ? audio.duration - 1 : t;
    audio.currentTime = Math.min(t, Math.max(0, end));
  } catch {}
}

function rememberPosOn() {
  try {
    return localStorage.getItem("tm-remember-pos") !== "0";
  } catch {
    return true;
  }
}

function streamQuality() {
  try {
    return localStorage.getItem("tm-stream-quality") || "320kbps";
  } catch {
    return "320kbps";
  }
}

function applySpeed() {
  try {
    const v = Number(localStorage.getItem("tm-play-speed") || "1");
    const ok = [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(v) ? v : 1;
    audio.playbackRate = ok;
    audio.preservesPitch = true;
  } catch {}
}

function rememberPosition() {
  if (!rememberPosOn()) return;
  const track = queue[queueIndex]?.track;
  if (!track) return;
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ id: track.id, t: audio.currentTime || 0 }));
  } catch {}
}

/// Restore this track's playhead if it is the one we were interrupted on.
function resumeHere(track) {
  if (!pendingResume || pendingResume.id !== track.id) return;
  const at = pendingResume.t;
  pendingResume = null;
  audio.addEventListener("loadedmetadata", () => seekTo(at), { once: true });
}

let lastSavedAt = 0;
audio.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (now - lastSavedAt < 2000) return;
  lastSavedAt = now;
  rememberPosition();
});
audio.addEventListener("pause", rememberPosition);
// Closing the window is the one moment the position really matters.
addEventListener("pagehide", rememberPosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberPosition();
});

/// The track-facing half of playQueueItem: index binding, bar/now-playing
/// text, hearts, lyrics kick-off and cover art. Split out so the crossfade
/// handover can repaint for the next track without re-resolving it.
function paintTrackUI(index, resolving = true) {
  const item = queue[index];
  if (!item) return null;
  setQueueIndex(index);
  renderQueue();
  // Keep the endless radio one step ahead once the queue runs low.
  // Repeat all/one never needs it — those modes never run out.
  if (repeatMode === "off" && queue.length - index <= 3) ensureReco();
  const track = item.track;
  clearError();
  setCurrent(null);
  bar.title.textContent = track.title;
  bar.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
  stampEntity(bar.artist, "artist", track.artist);
  if (np.title) np.title.textContent = track.title;
  if (np.artist) np.artist.textContent = [track.artist, track.album].filter(Boolean).join(" · ");
  stampEntity(np.artist, "artist", track.artist);
  npText("np-album", track.album || "—");
  stampEntity(document.getElementById("np-album"), "album", track.album);
  npText("np-artist-tile", track.artist || "—");
  stampEntity(document.getElementById("np-artist-tile"), "artist", track.artist);
  npText("np-length", track.duration || "—");
  npText("np-trackline", `TRACK ${String(index + 1).padStart(2, "0")} • STEREO DIRECT`);
  if (np.favIcon) np.favIcon.dataset.favIcon = track.id;
  paintFavHearts();
  emitState(true);
  loadLyrics(track);
  setMediaSessionTrack(track);
  const next = queue[index + 1];
  if (next) prefetchLyrics(next.track);
  const setCover = (img, fallback, target) => {
    if (!img) return;
    if (track.image) {
      // Plain rung (the bar's 56px thumb); the big Now Playing stage goes
      // through paintSharpCover instead — see art.js for the upscale.
      img.setAttribute("data-art-orig", track.image);
      img.removeAttribute("data-art-step");
      img.classList.remove("hidden");
      img.style.display = "";
      img.onerror = () => {
        // Every rung failed: artFail lands on the platform logo.
        if (window.artFail(img)) fallback?.classList.add("hidden");
      };
      img.src = hqArt(track.image, target);
      if (fallback) fallback.classList.add("hidden");
    } else {
      // No artwork on the track: the platform logo, not the album icon.
      img.setAttribute("src", LOGO);
      img.classList.remove("hidden");
      img.style.display = "";
      fallback?.classList.add("hidden");
    }
  };
  setCover(bar.cover, bar.coverFallback);
  paintSharpCover(np.cover, track.image);
  if (resolving) {
    bar.badge.textContent = "RESOLVING";
    if (np.badge) np.badge.textContent = "RESOLVING…";
  }
  return track;
}

export async function playQueueItem(index) {
  cancelFade(); // a manual pick kills any crossfade in flight
  const track = paintTrackUI(index, true);
  if (!track) return;

  // Offline fast path: resolve_song only fails after the CDN's 15-25s of
  // timeouts, so a track that is not in the vault is skipped up front. It
  // stays queued (markQueue never removes) for when the network returns.
  if (netMode() === "offline" && !isDownloaded(track.id)) {
    diag(`resolve ${track.id}`, false, "offline — not in vault");
    toast("Skipped — not downloaded", "info");
    bar.badge.textContent = "OFFLINE";
    if (np.badge) np.badge.textContent = "OFFLINE";
    markQueue("failed");
    advanceQueue();
    return;
  }

  let info;
  try {
    diag(`resolve ${track.id}`, null, track.title);
    info = await invoke("resolve_song", { id: track.id, quality: streamQuality() });
    diag(
      `resolve ${track.id}`,
      info.range_status === "unrestricted",
      `${info.chosen_quality} · ${info.host} · ${info.range_status}`,
    );
  } catch (err) {
    diag(`resolve ${track.id}`, false, String(err));
    showError(`Could not resolve "${track.title}": ${err}`);
    bar.badge.textContent = "UNRESOLVED";
    if (np.badge) np.badge.textContent = "UNRESOLVED";
    markQueue("failed");
    advanceQueue();
    return;
  }

  // A stream that already failed its range probes will only make the media
  // element error — skip it up front instead of pretending to play it.
  if (info.range_status === "dead") {
    setBadge(info.range_status, info);
    showError(`"${track.title}" is unreachable - skipping.`);
    markQueue("failed");
    advanceQueue();
    return;
  }
  setCurrent(info);
  pushPlay(track);
  setBadge(info.range_status, info);
  renderQueue();
  diag(`play ${track.id}`, true, info.proxy_url.slice(0, 70) + "…");
  streamRetries = 0;
  audio.src = info.proxy_url;
  applySpeed();
  resumeHere(track);
  try {
    await audio.play();
    setPlayIcon(true);
    prefetchTrack(queue[index + 1] && queue[index + 1].track);
    prefetchNext(queue.slice(index + 1, index + 3).map((q) => q.track));
  } catch (e) {
    diag(`play ${track.id}`, false, String(e).slice(0, 120));
    showError(`Browser refused to start playback: ${e}`);
  }
}


// -------------------------------------------------------------- crossfade -
// Spec 3.2: optional crossfade. A second <audio> (dom.js audio2) starts the
// next resolved track under the current one; both ramp over N seconds, then
// the aux stream is handed back to the main element mid-play (aux bridges
// the reload gap). One active fade at a time; every interruption path calls
// cancelFade(). ponytail ceiling: fade starts when remaining <= N, so the
// window is discovered via timeupdate (~4/s), not sample-accurate.
let fade = null; // { timer, nextIndex, item, info, userVol }

export function cancelFade() {
  if (!fade) return;
  if (fade.timer) clearInterval(fade.timer);
  const vol = fade.userVol;
  fade = null;
  if (vol != null) audio.volume = vol;
  audio2.pause();
  audio2.volume = 0;
  if (audio2.src) audio2.removeAttribute("src");
}

audio.addEventListener("pause", cancelFade);
audio.addEventListener("seeked", cancelFade);
audio2.addEventListener("error", () => cancelFade());

async function startFade(nextIndex, xf, remain) {
  const item = queue[nextIndex];
  if (!item) return;
  // Offline: a CDN resolve can only hang for the backend's timeouts — skip
  // the attempt and let the ended path (which has the fast-path gate) pick
  // up; a vaulted track still resolves and crossfades from disk.
  if (netMode() === "offline" && !isDownloaded(item.track.id)) {
    cancelFade();
    return;
  }
  const f = { timer: 0, nextIndex, item, info: null, userVol: audio.volume };
  fade = f;
  let info;
  try {
    diag(`xfade ${item.track.id}`, null, `resolve for ${xf}s fade`);
    info = await invoke("resolve_song", { id: item.track.id, quality: streamQuality() });
  } catch (err) {
    diag(`xfade ${item.track.id}`, false, String(err).slice(0, 120));
    cancelFade();
    return;
  }
  // State moved on while resolving (pause, seek, row click, DnD): bail out
  // and let the normal ended path take over.
  if (fade !== f || queue[f.nextIndex] !== item || audio.paused || info.range_status === "dead" || !info.proxy_url) {
    cancelFade();
    return;
  }
  f.info = info;
  audio2.src = info.proxy_url;
  audio2.volume = 0;
  try {
    await audio2.play();
  } catch {
    cancelFade();
    return;
  }
  if (fade !== f || audio.paused) {
    cancelFade();
    return;
  }
  const span = Math.max(400, Math.min(remain, xf) * 1000);
  const t0 = performance.now();
  f.timer = setInterval(() => {
    if (fade !== f) return;
    if (audio.paused) {
      cancelFade();
      return;
    }
    const k = Math.min(1, (performance.now() - t0) / span);
    audio.volume = f.userVol * (1 - k);
    audio2.volume = k;
    if (k >= 1) {
      clearInterval(f.timer);
      finishFade(f);
    }
  }, 80);
}

async function finishFade(f) {
  if (fade !== f) return;
  if (queue[f.nextIndex] !== f.item) {
    // Queue mutated in the last tick — cancel so the ended path re-picks.
    cancelFade();
    return;
  }
  fade = null; // from here audio.pause() cannot re-enter cancelFade
  const info = f.info;
  const old = queueIndex;
  audio.pause();
  audio.volume = f.userVol;
  if (old >= 0 && old !== f.nextIndex && queue[old]) queue[old].state = "done";
  const track = paintTrackUI(f.nextIndex, false); // badge straight to setBadge below
  if (!track) {
    cancelFade();
    return;
  }
  setCurrent(info);
  pushPlay(track);
  setBadge(info.range_status, info);
  diag(`play ${track.id}`, true, `crossfade handover — ${info.range_status}`);
  streamRetries = 0;
  const pos = audio2.currentTime;
  audio.src = info.proxy_url;
  try {
    const v = Number(localStorage.getItem("tm-play-speed") || "1");
    audio.playbackRate = [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(v) ? v : 1;
  } catch {}
  audio.addEventListener(
    "loadedmetadata",
    () => {
      try {
        if (Number.isFinite(pos) && pos > 0) audio.currentTime = pos;
      } catch {}
    },
    { once: true },
  );
  try {
    await audio.play();
    setPlayIcon(true);
    prefetchTrack(queue[f.nextIndex + 1] && queue[f.nextIndex + 1].track);
    prefetchNext(queue.slice(f.nextIndex + 1, f.nextIndex + 3).map((q) => q.track));
  } catch (e) {
    diag(`play ${track.id}`, false, String(e).slice(0, 120));
    showError(`Browser refused to start playback: ${e}`);
  }
  audio2.pause();
  audio2.volume = 0;
  audio2.removeAttribute("src");
}

audio.addEventListener("timeupdate", () => {
  if (fade) return;
  // In a Jam room the host owns the timeline (§4): a crossfade runs two
  // tracks at once and swaps elements mid-room, which the incoming playback
  // frames and the drift measure cannot follow. Single timeline only.
  if (localRole()) return;
  const xf = Number(localStorage.getItem("tm-xfade") || 0);
  if (!(xf > 0) || audio.paused || repeatMode === "one") return;
  if (!Number.isFinite(audio.duration) || audio.duration <= xf + 2) return;
  const remain = audio.duration - audio.currentTime;
  if (remain <= 0 || remain > xf) return;
  const next = pickNextIndex(); // shuffle/repeat aware, same pick as ended path
  if (next < 0 || !queue[next]) return;
  startFade(next, xf, remain);
});

// Queue-panel selector wiring (owned here: this module owns the fade).
const xfSel = $("#set-xfade");
if (xfSel) {
  xfSel.value = localStorage.getItem("tm-xfade") || "0";
  xfSel.addEventListener("change", () => {
    localStorage.setItem("tm-xfade", xfSel.value);
    toast(xfSel.value === "0" ? "Crossfade off." : `Crossfade set to ${xfSel.value}s.`, "info", 2500);
  });
}
