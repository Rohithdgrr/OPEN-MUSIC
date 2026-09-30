// playback.js — playQueueItem and stream error handling
// Split from main.js (Phase 4 M1).
import { hqArt } from "./art.js";
import { emitState } from "./bridge.js";
import { clearError, diag, invoke, showError } from "./core.js";
import { audio, bar, np } from "./dom.js";
import { paintFavHearts, pushPlay } from "./library.js";
import { loadLyrics } from "./lyrics.js";
import { setBadge, setPlayIcon } from "./player.js";
import { advanceQueue, markQueue, queue, renderQueue, repeatMode, setCurrent, setQueueIndex } from "./queue.js";
import { ensureReco } from "./radio.js";
import { npText, stampEntity } from "./util.js";

// ---------------------------------------------------------------- playback -
export let lastEndedAt = 0;
audio.addEventListener("ended", () => {
  // Some engines fire `ended` twice in quick succession; ignore the repeat
  // so a double event can never skip the next track.
  const now = Date.now();
  if (now - lastEndedAt < 600) return;
  lastEndedAt = now;
  if (repeatMode === "one" && audio.src) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  markQueue("done");
  advanceQueue();
});

// One retry for transient network blips: a momentary drop must not skip the
// song. The budget resets on every new track (see playQueueItem).
export let streamRetries = 0;
audio.addEventListener("error", () => {
  if (!audio.error) return;
  if (audio.src && streamRetries < 1) {
    streamRetries += 1;
    const src = audio.src;
    diag("stream", false, `media error ${audio.error.code} - retrying once in 2s`);
    setTimeout(() => {
      if (audio.src !== src) return; // the user already moved on
      audio.load();
      audio.play().then(() => setPlayIcon(true)).catch(() => {});
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

export async function playQueueItem(index) {
  const item = queue[index];
  if (!item) return;
  setQueueIndex(index);
  renderQueue();
  // Keep the endless radio one step ahead once the queue runs low.
  // Repeat all/one never needs it â€” those modes never run out.
  if (repeatMode === "off" && queue.length - index <= 3) ensureReco();
  const track = item.track;
  clearError();
  setCurrent(null);
  bar.title.textContent = track.title;
  bar.artist.textContent = [track.artist, track.album].filter(Boolean).join(" Â· ");
  stampEntity(bar.artist, "artist", track.artist);
  if (np.title) np.title.textContent = track.title;
  if (np.artist) np.artist.textContent = [track.artist, track.album].filter(Boolean).join(" Â· ");
  stampEntity(np.artist, "artist", track.artist);
  npText("np-album", track.album || "â€”");
  stampEntity(document.getElementById("np-album"), "album", track.album);
  npText("np-artist-tile", track.artist || "â€”");
  stampEntity(document.getElementById("np-artist-tile"), "artist", track.artist);
  npText("np-length", track.duration || "â€”");
  npText("np-trackline", `TRACK ${String(index + 1).padStart(2, "0")} â€¢ STEREO DIRECT`);
  if (np.favIcon) np.favIcon.dataset.favIcon = track.id;
  paintFavHearts();
  emitState(true);
  loadLyrics(track);
  const setCover = (img, fallback) => {
    if (!img) return;
    if (track.image) {
      img.setAttribute("data-art-orig", track.image);
      img.removeAttribute("data-art-tried");
      img.classList.remove("hidden");
      img.style.display = "";
      img.onerror = () => {
        // One retry of the original URL, then fall back to the icon.
        if (window.artFail(img)) {
          img.classList.add("hidden");
          fallback?.classList.remove("hidden");
        }
      };
      img.src = hqArt(track.image);
      if (fallback) fallback.classList.add("hidden");
    } else {
      img.classList.add("hidden");
      fallback?.classList.remove("hidden");
    }
  };
  setCover(bar.cover, bar.coverFallback);
  setCover(np.cover, null);
  bar.badge.textContent = "RESOLVING";
  if (np.badge) np.badge.textContent = "RESOLVINGâ€¦";

  let info;
  try {
    diag(`resolve ${track.id}`, null, track.title);
    info = await invoke("resolve_song", { id: track.id });
    diag(
      `resolve ${track.id}`,
      info.range_status === "unrestricted",
      `${info.chosen_quality} Â· ${info.host} Â· ${info.range_status}`,
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
  try {
    await audio.play();
    setPlayIcon(true);
  } catch (e) {
    diag(`play ${track.id}`, false, String(e).slice(0, 120));
    showError(`Browser refused to start playback: ${e}`);
  }
}

