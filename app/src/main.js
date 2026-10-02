// main.js — entry: boot sequence
// Split from main.js (Phase 4 M1).
import { paintArt, paintSharpCover, LOGO } from "./art.js";
import { wireDesktopCard } from "./bridge.js";
import { diag, invoke, showView, toast, toTop } from "./core.js";
import { $, bar, np } from "./dom.js";
import { loadHistory } from "./history.js";
import { loadHome, loadPlays } from "./home.js";
import { autoSyncBoot } from "./gsync.js";
import { renderFavs } from "./library.js";
import { initMediaSession, setMediaSessionTrack } from "./media.js";
import { setResume } from "./playback.js";
import { queue, queueIndex, renderQueue, restoreQueue, setRestoredTrack } from "./queue.js";
import { startNet } from "./net.js";
import { doSearch } from "./search.js";
import { wireShortcuts } from "./shortcuts.js";
import { applySysPrefs, applyWidget, paintGreeting } from "./settings.js";
import { step, togglePlay } from "./transport.js";
import { paintModes, paintVolume } from "./transport.js";
import { npText, fmtTime, stampEntity } from "./util.js";
import { refreshVault } from "./vault.js";

initMediaSession({
  onPlay: () => togglePlay(),
  onPause: () => togglePlay(),
  onNext: () => step(1),
  onPrev: () => step(-1),
});
const bootTrack = loadPlays()[0];
if (bootTrack) setMediaSessionTrack(bootTrack);
paintModes();
paintVolume();
// The offline gate and the queue's ⬇ badges read the vault list, so it must
// be warm before anything can play or render a queue row.
await refreshVault();
startNet({ invoke, diag, toast, onMode: renderQueue });
// ------------------------------------------------------------------- boot -
try {
  const base = await invoke("proxy_base");
  // L3: art.js routes every <img> through the relay's /art cache once this
  // is set; until then it falls back to the direct CDN url.
  window.__tmBase = base;
  diag("proxy base", true, base.replace("http://", ""));
} catch (err) {
  diag("proxy base", false, String(err));
}
diag("boot", true, "TRANCE MUSIC ready");

// Seed the catalog so every control has real data on first paint:
// the box opens on the last query that was searched, not a blank slot.
const seedInput = $("#search-input");
if (seedInput && !seedInput.value.trim()) {
  seedInput.value = [...new Set(loadHistory())][0] || "trance";
}
// The bar (and Now Playing) open on whatever this session was last playing:
// the restored queue's current track when there is one, else the last song
// that actually played.
const restored = restoreQueue();
if (restored) renderQueue();
const lastPlayed = (restored && queue[queueIndex]?.track) || loadPlays()[0];
setRestoredTrack(lastPlayed || null);
if (lastPlayed) {
  // …and if the playhead was parked mid-song, hand it to playback.js so the
  // first press of play picks up where it stopped.
  try {
    const saved = JSON.parse(localStorage.getItem("tm-pos") || "null");
    if (saved && saved.id === lastPlayed.id) {
      setResume(saved.id, saved.t);
      diag("restore", true, `resume at ${fmtTime(saved.t)}`);
    }
  } catch {}
  bar.title.textContent = lastPlayed.title;
  bar.artist.textContent = [lastPlayed.artist, lastPlayed.album].filter(Boolean).join(" · ");
  stampEntity(bar.artist, "artist", lastPlayed.artist);
  if (lastPlayed.image) {
    paintArt(bar.cover, lastPlayed.image);
    bar.coverFallback?.classList.add("hidden");
    paintSharpCover(np.cover, lastPlayed.image);
  } else {
    // Saved without artwork: the platform logo in both covers.
    for (const img of [bar.cover, np.cover]) {
      if (!img) continue;
      img.setAttribute("src", LOGO);
      img.classList.remove("hidden");
      img.style.display = "";
    }
    bar.coverFallback?.classList.add("hidden");
  }
  if (np.title) np.title.textContent = lastPlayed.title;
  if (np.artist) np.artist.textContent = [lastPlayed.artist, lastPlayed.album].filter(Boolean).join(" · ");
  stampEntity(np.artist, "artist", lastPlayed.artist);
  npText("np-album", lastPlayed.album || "—");
  stampEntity(document.getElementById("np-album"), "album", lastPlayed.album);
  npText("np-artist-tile", lastPlayed.artist || "—");
  stampEntity(document.getElementById("np-artist-tile"), "artist", lastPlayed.artist);
  npText("np-length", lastPlayed.duration || "—");
  diag("restore", true, `last played: ${lastPlayed.title}`);
}
// The desktop card is a separate window: show it if it was left switched on,
// then push the current snapshot so it paints before the user touches it.
paintGreeting();
applySysPrefs();
toTop();
applyWidget();
wireDesktopCard();
wireShortcuts();
renderFavs();
showView("home"); // open on the Home tab
doSearch({ silent: true });
loadHome();
// Optional Drive sync (Phase 3): wires boot/online/visible/edit triggers.
// Dormant unless signed in — the engine checks before every round.
autoSyncBoot();

// Once a day, quietly ask whether a newer release exists and mention it
// once per version. Offline or rate-limited checks stay silent — the
// Settings / Updates panel is the retry button.
(async () => {
  const day = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem("tm-upd-checked") === day) return;
    localStorage.setItem("tm-upd-checked", day);
  } catch {}
  try {
    const r = await invoke("update_check");
    const v = r?.latest?.version;
    let seen = "";
    try {
      seen = localStorage.getItem("tm-upd-seen") || "";
    } catch {}
    if (v && v !== seen) {
      try {
        localStorage.setItem("tm-upd-seen", v);
      } catch {}
      toast(`v${v} is available — Settings → Updates.`, "info", 6000);
    }
  } catch {}
})();

// The desktop card collapses to an icon while the user is elsewhere, so it
// needs to know whether this window (the app) holds focus.
(() => {
  const api = window.__TAURI__;
  const report = (focused) => {
    try {
      const p = api?.event?.emit("app:focus", focused);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  };
  const main = api?.window?.getCurrentWindow?.();
  main?.onFocusChanged?.((f) => report(f));
  window.addEventListener("focus", () => report(true));
  window.addEventListener("blur", () => report(false));
})();

