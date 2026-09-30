// home.js — home feed, hero, library/plays loading
// Split from main.js (Phase 4 M1).
import { art, paintArt } from "./art.js";
import { diag, esc, invoke, showError, showView } from "./core.js";
import { $ } from "./dom.js";
import { favFill, openDetail, openPlaylistElsewhere, plItemById, renderHomeAlbums, renderHomeArtists, renderHomeStations, renderLibrary, renderPlaylists, renderPlays, setPlFilter, setPlQuery, toggleFavTrack } from "./library.js";
import { playQueueItem } from "./playback.js";
import { queue, renderQueue, setQueueIndex, setQueueTab, setShuffleMode } from "./queue.js";
import { addBtn, browseCards, dedupeTracks, doSearch, isTracks, paintChips, playTrack, setActiveFilter, uniqById } from "./search.js";
import { filterLang } from "./settings.js";
import { paintModes } from "./transport.js";
import { npText } from "./util.js";
import { downloadTrack } from "./vault.js";

// -------------------------------------------------------------------- home -
export let homeFeed = null;
export let homePlaylistPage = 0;
export const PLAYLISTS_PER_PAGE = 5;
export const LIBRARY_KEY = "tm-library";

/// Load a playlist/chart into the queue and start it.
export async function playList(id, { shuffle = false } = {}) {
  diag("playlist", null, id);
  let tracks;
  try {
    tracks = dedupeTracks(await invoke("playlist_tracks", { id })).list;
  } catch (err) {
    diag("playlist", false, String(err));
    showError(`Could not load that playlist: ${err}`);
    return;
  }
  if (!tracks.length) {
    showError("That playlist has no playable tracks.");
    return;
  }
  queue.length = 0;
  for (const t of tracks) queue.push({ track: t, state: null });
  if (shuffle) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    setShuffleMode(true);
    paintModes();
  }
  setQueueIndex(-1);
  setQueueTab("next");
  renderQueue();
  diag("playlist", true, `${tracks.length} tracks`);
  playQueueItem(0);
}

export function renderHero() {
  const spot = homeFeed && homeFeed.spotlight;
  if (!spot) return;
  const img = $("#hero-image");
  if (img && spot.image) paintArt(img, spot.image);
  npText("hero-title", spot.title);
  npText("hero-artist", spot.subtitle || "Curated collection");
  npText("hero-meta", spot.count ? `${spot.count} Tracks` : "Curated playlist");
}

export function renderHomePlaylists() {
  const grid = $("#home-playlists");
  if (!grid || !homeFeed) return;
  const items = homeFeed.playlists;
  const pages = Math.max(1, Math.ceil(items.length / PLAYLISTS_PER_PAGE));
  homePlaylistPage = Math.min(Math.max(homePlaylistPage, 0), pages - 1);
  const start = homePlaylistPage * PLAYLISTS_PER_PAGE;
  grid.innerHTML = items
    .slice(start, start + PLAYLISTS_PER_PAGE)
    .map(
      (p) => `
    <div data-playlist-id="${esc(p.id)}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div>
        <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(p.image)} />
          <div class="absolute inset-0 bg-gradient-to-t from-primary/90 to-primary/30 flex flex-col justify-end p-3">
            <span class="font-label-mono text-[9px] uppercase tracking-wider text-on-primary/80">${p.count || "â€”"} tracks</span>
            <span class="font-headline-md text-on-primary font-semibold text-[16px] leading-tight">${esc(p.title)}</span>
          </div>
          <button type="button" data-playlist-id="${esc(p.id)}" title="Play this playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-secondary line-clamp-2">${esc(p.subtitle)}</p>
      </div>
      <div class="mt-3 pt-2 border-t border-surface-container-high flex items-center justify-between text-on-surface-variant font-label-mono text-[10px]">
        <span>${p.count || 0} Tracks</span>
      </div>
    </div>`,
    )
    .join("");
}

export function renderHomeTop() {
  const list = $("#home-top-list");
  if (!list || !homeFeed) return;
  // Already deduped in loadHome â€” render the same array the click handlers
  // index into, or a removed dupe would shift every row's data-top-* id.
  const tracks = homeFeed.top_tracks;
  if (!tracks.length) {
    list.innerHTML =
      '<p class="py-4 font-body-sm text-body-sm text-on-surface-variant">Rankings are unavailable right now.</p>';
    return;
  }
  list.innerHTML = tracks
    .map(
      (t, i) => `
    <div class="flex items-center justify-between p-4 rounded-lg hover:bg-surface-container-low transition-colors group cursor-pointer" data-top-index="${i}">
      <div class="flex items-center gap-4 min-w-0">
        <span class="font-headline-md font-semibold ${i === 0 ? "text-primary" : "text-on-surface-variant"} w-6 text-center">${String(i + 1).padStart(2, "0")}</span>
        <div class="w-24 h-24 rounded-lg bg-surface-container-high overflow-hidden flex items-center justify-center text-on-surface-variant shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image)} />
        </div>
        <div class="truncate">
          <span class="font-body-md font-semibold text-on-surface block truncate">${esc(t.title)}</span>
          <span class="font-body-sm text-secondary truncate"><span class="hover:underline cursor-pointer" data-entity-kind="artist" data-entity-name="${esc(t.artist)}">${esc(t.artist)}</span></span>
        </div>
      </div>
      <div class="flex items-center gap-6 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-medium text-[10px]">${t.hq ? "320 kbps" : "Standard"}</span>
        <span class="hidden sm:inline">${esc(t.plays ? `${t.plays.toLocaleString()} plays` : "â€”")}</span>
        <span>${esc(t.duration)}</span>
        <button type="button" data-top-fav="${i}" title="Favorite this track" class="w-8 h-8 rounded-full bg-surface-container-high hover:bg-primary hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
        </button>
        <button type="button" data-top-dl="${i}" title="Download this track" class="w-8 h-8 rounded-full bg-surface-container-high hover:bg-primary hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]">download</span>
        </button>
        ${addBtn(t)}
        <button type="button" data-top-index="${i}" title="Play this track" class="w-8 h-8 rounded-full bg-surface-container-high group-hover:bg-primary group-hover:text-on-primary flex items-center justify-center transition-colors">
          <span class="material-symbols-outlined text-[16px]">play_arrow</span>
        </button>
      </div>
    </div>`,
    )
    .join("");
}

export async function loadHome() {
  try {
    homeFeed = await invoke("home_feed");
  } catch (err) {
    diag("home", false, String(err));
    npText("hero-title", "Home feed unavailable");
    npText("hero-artist", String(err).slice(0, 120));
    for (const sel of ["#home-albums", "#home-artists", "#home-stations", "#playlists-grid"]) {
      const el = $(sel);
      if (el) el.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">Unavailable right now.</p>';
    }
    return;
  }
  // Normalize once so every card grid, carousel and click handler on Home
  // (and the Playlists screen fed from the same feed) sees each item once.
  homeFeed.playlists = uniqById(homeFeed.playlists);
  homeFeed.charts = uniqById(homeFeed.charts);
  homeFeed.albums = uniqById(homeFeed.albums);
  homeFeed.artists = uniqById(homeFeed.artists);
  homeFeed.top_tracks = filterLang(dedupeTracks(homeFeed.top_tracks || []).list);
  diag(
    "home",
    true,
    `${homeFeed.playlists.length} playlists Â· ${homeFeed.charts.length} charts Â· ${homeFeed.top_tracks.length} top tracks`,
  );
  renderHero();
  renderHomePlaylists();
  renderHomeTop();
  renderPlaylists();
  renderHomeAlbums();
  renderHomeArtists();
  renderHomeStations();
  renderLibrary();
  renderPlays();
}

$("#home-playlists-prev")?.addEventListener("click", () => {
  homePlaylistPage -= 1;
  renderHomePlaylists();
});
$("#home-playlists-next")?.addEventListener("click", () => {
  homePlaylistPage += 1;
  renderHomePlaylists();
});
$("#home-playlists")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-playlist-id]");
  if (btn) openDetail("playlist", plItemById(btn.dataset.playlistId));
});
$("#home-top-list")?.addEventListener("click", (e) => {
  const fav = e.target.closest("[data-top-fav]");
  if (fav && homeFeed) {
    const track = homeFeed.top_tracks[Number(fav.dataset.topFav)];
    if (track) toggleFavTrack(track);
    return;
  }
  const dl = e.target.closest("[data-top-dl]");
  if (dl && homeFeed) {
    const track = homeFeed.top_tracks[Number(dl.dataset.topDl)];
    if (track) downloadTrack(track, dl);
    return;
  }
  const hit = e.target.closest("[data-top-index]");
  const track = hit && homeFeed ? homeFeed.top_tracks[Number(hit.dataset.topIndex)] : null;
  if (track) playTrack(track);
});
// Every chart in the feed, not just the countdown's playlist.
$("#home-charts-link")?.addEventListener("click", () => {
  setPlFilter("charts");
  setPlQuery("");
  const input = $("#pl-search");
  if (input) input.value = "";
  showView("playlists"); // re-renders with the charts chip already selected
});
$("#hero-play")?.addEventListener("click", () => {
  if (homeFeed && homeFeed.spotlight) playList(homeFeed.spotlight.id);
});
// The banner itself opens its playlist; its own buttons keep their own jobs.
$("#hero")?.addEventListener("click", (e) => {
  if (e.target.closest("button, a")) return;
  const spot = homeFeed && homeFeed.spotlight;
  if (spot) openPlaylistElsewhere(spot);
});
$("#hero-art")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.currentTarget.click();
});
$("#hero-shuffle")?.addEventListener("click", () => {
  if (homeFeed && homeFeed.spotlight) playList(homeFeed.spotlight.id, { shuffle: true });
});
$("#hero-save")?.addEventListener("click", () => {
  const spot = homeFeed && homeFeed.spotlight;
  if (!spot) return;
  let lib = [];
  try {
    lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {}
  const at = lib.findIndex((x) => x.id === spot.id);
  const label = $("#hero-save span:last-child");
  if (at >= 0) {
    lib.splice(at, 1);
    if (label) label.textContent = "Save to Library";
    diag("library", null, `removed ${spot.title}`);
  } else {
    lib.push({ id: spot.id, title: spot.title });
    if (label) label.textContent = "Saved âœ“";
    diag("library", true, spot.title);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 50)));
  } catch {}
});
$("#home-releases-all")?.addEventListener("click", () => {
  browseCards("albums", homeFeed && homeFeed.albums, "Releases");
});
$("#home-artists-all")?.addEventListener("click", () => {
  browseCards("artists", homeFeed && homeFeed.artists, "Artists");
});
// Genre pills anywhere on Home run a real track search â€” never inherit
// whatever entity chip was left active on the Search screen.
$('[data-view="home"]')?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-query]");
  if (!chip) return;
  if (!isTracks()) {
    setActiveFilter("tracks");
    paintChips();
  }
  $("#search-input").value = chip.dataset.query;
  doSearch({ query: chip.dataset.query });
});

// ------------------------------------------------------- detail screens -
export const PLAYS_KEY = "tm-plays";

export function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {
    return [];
  }
}
export function loadPlays() {
  try {
    return JSON.parse(localStorage.getItem(PLAYS_KEY) || "[]");
  } catch {
    return [];
  }
}

