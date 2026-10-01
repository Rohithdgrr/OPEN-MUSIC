// main.js — entry: boot sequence
// Split from main.js (Phase 4 M1).
import { paintArt } from "./art.js";
import { wireDesktopCard } from "./bridge.js";
import { diag, invoke, showView, toast, toTop } from "./core.js";
import { $, bar, np } from "./dom.js";
import { loadHistory } from "./history.js";
import { loadHome, loadPlays } from "./home.js";
import { renderFavs } from "./library.js";
import { setRestoredTrack } from "./queue.js";
import { startNet } from "./net.js";
import { doSearch } from "./search.js";
import { wireShortcuts } from "./shortcuts.js";
import { applySysPrefs, applyWidget, paintGreeting } from "./settings.js";
import { paintModes, paintVolume } from "./transport.js";
import { npText, stampEntity } from "./util.js";

paintModes();
paintVolume();
startNet({ invoke, diag, toast });
// ------------------------------------------------------------------- boot -
try {
  const base = await invoke("proxy_base");
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
// The bar (and Now Playing) open on the last track that actually played.
const lastPlayed = loadPlays()[0];
setRestoredTrack(lastPlayed || null);
if (lastPlayed) {
  bar.title.textContent = lastPlayed.title;
  bar.artist.textContent = [lastPlayed.artist, lastPlayed.album].filter(Boolean).join(" · ");
  stampEntity(bar.artist, "artist", lastPlayed.artist);
  if (lastPlayed.image) {
    paintArt(bar.cover, lastPlayed.image);
    bar.coverFallback?.classList.add("hidden");
    paintArt(np.cover, lastPlayed.image, "1500x1500");
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
showView("search"); // open on the Search tab
doSearch({ silent: true });
loadHome();

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

