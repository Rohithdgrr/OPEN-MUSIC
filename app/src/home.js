// home.js — home feed, hero, library/plays loading
// Split from main.js (Phase 4 M1).
import { art, paintArt } from "./art.js";
import { diag, esc, invoke, showError, showView } from "./core.js";
import { $ } from "./dom.js";
import { ddCard, favFill, loadFavs, moreHomeAlbums, moreHomeArtists, moreHomeCharts, openDetail, openPlaylistElsewhere, plItemById, renderHomeAlbums, renderHomeArtists, renderHomeDaily, renderHomeStations, renderLibrary, renderPlaylists, renderPlays, resetHomeShelves, setPlFilter, setPlQuery, toggleFavTrack } from "./library.js";
import { playQueueItem } from "./playback.js";
import { queue, renderQueue, setQueueIndex, setQueueTab, setShuffleMode } from "./queue.js";
import { addBtn, dedupeTracks, doSearch, isTracks, paintChips, playTrack, setActiveFilter, uniqById } from "./search.js";
import { filterLang, filterLangHome, langLabel, prefLangs } from "./settings.js";
import { paintModes } from "./transport.js";
import { artistLinks, fmtTime, npText } from "./util.js";
import { downloadTrack } from "./vault.js";

// -------------------------------------------------------------------- home -
export let homeFeed = null;
export let homePlaylistPage = 0;
export const PLAYLISTS_PER_PAGE = 5;
export const LIBRARY_KEY = "tm-library";
/// Last launch's feed, so boot can paint Home before the network answers.
const HOME_SNAP_KEY = "tm-home";
// Written by playback.js; read here so Most Listened paints the parked playhead
// from the same storage the rest of the app writes.
const POS_KEY = "tm-pos";

/// Last launch's feed, so boot can paint Home before the network answers.
function homeSnapshot() {
  try {
    const feed = JSON.parse(localStorage.getItem(HOME_SNAP_KEY) || "null");
    return feed && Array.isArray(feed.playlists) ? feed : null;
  } catch {
    return null;
  }
}
function saveHomeSnapshot(feed) {
  try {
    localStorage.setItem(HOME_SNAP_KEY, JSON.stringify(feed));
  } catch {} // quota — the snapshot is a nicety, never an error
}

// ------------------------------------------------- most listened + taste --
// "Most Listened" is built from what *this* listener has done (play counts,
// favourites, saved entities), not from the launch feed — so it is
// repainted by `paintTaste()` whenever any of that changes, not only
// when Home reloads.

/// Where the playhead was parked, as written by playback.js. `tm-pos` is read
/// straight from storage so Home can paint the bar before anything plays.
function parkedPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    // Under 10s in is not worth a "Resume" card; a finished song is cleared.
    return p && p.id && Number(p.t) >= 10 ? p : null;
  } catch {
    return null;
  }
}

/// Seconds for one track. `duration_secs` is the numeric field, but rows that
/// round-tripped through an older build only kept `duration` as "m:ss" — and
/// that has to be summed, not read as its last segment.
function trackSecs(t) {
  const n = Number(t.duration_secs);
  if (Number.isFinite(n) && n > 0) return n;
  const parts = String(t.duration || "")
    .split(":")
    .map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/// The most-played tracks, ranked by how often they were started (ties go to
/// the most recent), each tagged with the fraction the parked playhead was
/// left at when it is the half-heard one.
function jumpBackTracks() {
  const parked = parkedPos();
  return uniqById(loadPlays())
    .map((t) => ({ t, count: Number(t.count) || 1, ts: Number(t.ts) || 0 }))
    .sort((a, b) => b.count - a.count || b.ts - a.ts)
    .slice(0, 4)
    .map(({ t, count }) => {
      const dur = trackSecs(t);
      const at = parked && parked.id === t.id && dur > 0 ? Math.min(0.99, parked.t / dur) : null;
      return { t, at, secs: dur, count };
    });
}

function jumpBackCard({ t, at, secs, count }) {
  const pct = at == null ? 0 : Math.round(at * 100);
  return `
    <div data-jump-id="${esc(t.id || "")}" class="p-space-md rounded-lg bg-surface-container-lowest shadow-sm hover:shadow-md transition-shadow group flex flex-col justify-between cursor-pointer">
      <div class="flex items-start gap-space-md">
        <div class="relative w-16 h-16 rounded overflow-hidden shrink-0 bg-surface-container-high">
          <img alt="" loading="lazy" class="w-full h-full object-cover grayscale" ${art(t.image || "")} />
          <div class="absolute inset-0 bg-primary/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
            <span class="material-symbols-outlined text-on-primary text-[24px]">play_arrow</span>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="font-label-mono text-[10px] uppercase text-on-surface-variant">${at == null ? `${count} play${count === 1 ? "" : "s"}` : `Paused · ${count} play${count === 1 ? "" : "s"}`}</span>
            ${t.year ? `<span class="font-label-mono text-[10px] px-1 rounded bg-surface-container-high text-on-surface-variant">${esc(t.year)}</span>` : ""}
          </div>
          <h4 class="font-body-md text-body-md font-medium text-on-surface truncate mt-1" dir="auto">${esc(t.title || "")}</h4>
          <p class="font-body-sm text-body-sm text-secondary truncate" dir="auto">${esc(t.artist || "")}</p>
        </div>
      </div>
      <div class="mt-4">
        <div class="flex justify-between items-center gap-2 text-on-surface-variant font-label-mono text-[10px] mb-1">
          <span class="truncate">${at == null ? esc(t.album || "") : `${fmtTime(parkedPos()?.t || 0)} / ${fmtTime(secs)}`}</span>
          <span class="shrink-0">${at == null ? esc(t.language || "") : `${pct}%`}</span>
        </div>
        <div class="w-full h-1 bg-surface-container-high rounded-full overflow-hidden">
          <div class="h-full bg-primary rounded-full" style="width: ${pct}%;"></div>
        </div>
      </div>
    </div>`;
}

/// Albums the listener already has a relationship with, newest relationship
/// first: played, hearted as a track, or saved to the Library as an album.
/// Three different record shapes live in three stores, so each is mapped
/// explicitly — `album_id` and an entity `token` both open a real album.
function preferenceAlbums() {
  const seen = new Set();
  const out = [];
  const add = (token, title, subtitle, image, year) => {
    const key = token || title;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ id: token || key, token, title: title || "", subtitle: subtitle || "", image: image || "", count: 0, year: year || "" });
  };
  for (const t of [...loadPlays().slice(0, 40), ...loadFavs()]) {
    add(t.album_id, t.album, t.artist, t.image, t.year);
    if (out.length >= 4) break;
  }
  for (const e of loadLibrary()) {
    if (e.kind !== "album") continue;
    add(e.token || e.id, e.title, e.subtitle, e.image, e.year);
    if (out.length >= 4) break;
  }
  return out.slice(0, 4);
}

export function renderJumpBack() {
  const grid = $("#home-jump");
  if (!grid) return;
  const rows = jumpBackTracks();
  grid.innerHTML = rows.length
    ? rows.map(jumpBackCard).join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant sm:col-span-2 lg:col-span-4">Nothing on repeat yet — every play is counted here, so this fills up as you listen.</p>';
  npText("home-jump-count", rows.length ? `TOP ${rows.length}` : "—");
  const wrap = $("#home-jump-pref");
  const albums = $("#home-jump-albums");
  if (!wrap || !albums) return;
  const pref = preferenceAlbums();
  wrap.classList.toggle("hidden", !pref.length);
  wrap.classList.toggle("flex", pref.length > 0);
  if (pref.length) albums.innerHTML = pref.map((a) => ddCard("album", a)).join("");
}

/// Repaint the taste-driven Home section: used at paint and after a play is
/// recorded.
export function paintTaste() {
  renderJumpBack();
}

/// Normalize once so every card grid, carousel and click handler on Home
/// (and the Playlists screen fed from the same feed) sees each item once.
function paintHome() {
  homeFeed.playlists = uniqById(homeFeed.playlists);
  homeFeed.charts = uniqById(homeFeed.charts);
  homeFeed.albums = uniqById(homeFeed.albums);
  homeFeed.artists = uniqById(homeFeed.artists);
  homeFeed.top_tracks = filterLang(dedupeTracks(homeFeed.top_tracks || []).list);
  diag(
    "home",
    true,
    `${homeFeed.playlists.length} playlists · ${homeFeed.charts.length} charts · ${homeFeed.top_tracks.length} top tracks`,
  );
   paintLangTitles();
  resetHomeShelves();
  renderHero();
  renderHomePlaylists();
  renderHomeTop();
  paintTaste();
  renderPlaylists();
  renderHomeAlbums();
  renderHomeArtists();
  renderHomeStations();
  renderHomeDaily();
  renderLibrary();
  renderPlays();
}

// ---------------------------------------------------------- language home -
// Launch data is the same whatever `lang=` says, so a language preference is
// applied here: every shelf is filtered by the language tags it carries, and
// a shelf that leaves is refilled from the searches the catalog *does*
// answer per language. Bounded by construction — three searches plus one
// lookup per featured artist, all memoised backend-side, so a reload is
// cheap and an offline refill never empties a shelf (the feed copy stays).
const LANG_TITLES = [
  ["home-playlists-title", "Featured Curated Playlists"],
  ["home-daily-title", "Daily Updates"],
  ["home-top-title", "Heavy Rotation • Top 5 Masters Countdown"],
  ["home-albums-title", "New Lossless Masters"],
  ["home-artists-title", "Featured Artists in Residence"],
  ["home-charts-title", "Live Bitstream Streams"],
];

/// Section headings say which languages Home is currently reading for.
function paintLangTitles() {
  const label = prefLangs().map(langLabel).join(", ");
  for (const [id, base] of LANG_TITLES) npText(id, label ? `${base} · ${label}` : base);
}

async function langShelves(feed) {
  const langs = prefLangs();
  if (!langs.length) return feed;
  const label = langLabel(langs[0]);
  const orig = {
    playlists: feed.playlists,
    charts: feed.charts,
    albums: feed.albums,
    artists: feed.artists,
    top_tracks: feed.top_tracks,
  };
  feed.charts = filterLangHome(feed.charts);
  feed.albums = filterLangHome(feed.albums);
  feed.top_tracks = filterLangHome(feed.top_tracks);

  const entities = (kind, query, limit) =>
    invoke("search_entities", { kind, query, limit, page: 1 }).then((p) => p.items || []);
  const jobs = [];
  if (!feed.top_tracks.length)
    jobs.push(
      invoke("search_songs", { query: `${label} top songs`, limit: 20, page: 1 })
        .then((p) => {
          const hits = filterLangHome(p.tracks || []);
          if (hits.length) feed.top_tracks = dedupeTracks(hits).list.slice(0, 5);
        })
        .catch((e) => diag("home lang", false, `songs: ${e}`)),
    );
  if (!feed.albums.length)
    jobs.push(
      entities("album", label, 20)
        .then((items) => {
          const hits = filterLangHome(items);
          if (hits.length) feed.albums = hits;
        })
        .catch((e) => diag("home lang", false, `albums: ${e}`)),
    );
  if (!feed.charts.length)
    jobs.push(
      entities("playlist", `${label} top 50`, 12)
        .then((items) => {
          const hits = filterLangHome(items);
          if (hits.length) feed.charts = hits;
        })
        .catch((e) => diag("home lang", false, `charts: ${e}`)),
    );
  // The curated shelf carries no language at all, so under a preference it
  // leads with playlists the catalog tags with it and keeps the feed's own
  // behind them.
  jobs.push(
    entities("playlist", `${label} hits`, 20)
      .then((items) => {
        const hits = filterLangHome(items);
        if (hits.length) feed.playlists = [...hits, ...feed.playlists];
      })
      .catch((e) => diag("home lang", false, `playlists: ${e}`)),
  );
  await Promise.allSettled(jobs);

  // Artist rows carry no language either — rebuild them from the artists
  // credited on this language's songs, each name resolved once, exact title
  // only (a fuzzy first hit is how every artist used to open the same page).
  const names = [
    ...new Set(
      (feed.top_tracks || [])
        .flatMap((t) => String(t.artist || "").split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 6);
  if (names.length) {
    const resolved = await Promise.allSettled(
      names.map((n) =>
        invoke("search_entities", { kind: "artist", query: n, limit: 8, page: 1 }).then((p) => {
          const want = n.toLowerCase();
          return (p.items || []).find((a) => String(a.title || "").trim().toLowerCase() === want) || null;
        }),
      ),
    );
    const artists = resolved
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value);
    if (artists.length >= 3) feed.artists = artists;
  }

  // Never leave a shelf empty when the feed still has rows to show.
  for (const k of ["playlists", "charts", "albums", "artists", "top_tracks"]) {
    if (!feed[k].length && orig[k].length) feed[k] = orig[k];
  }
  diag("home lang", true, `shelves read for ${langs.map(langLabel).join(", ")}`);
  return feed;
}

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
            <span class="font-label-mono text-[9px] uppercase tracking-wider text-on-primary/80">${p.count || "—"} tracks</span>
            <span class="font-headline-md text-on-primary font-semibold text-[16px] leading-tight" dir="auto">${esc(p.title)}</span>
          </div>
          <button type="button" data-playlist-id="${esc(p.id)}" title="Play this playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-secondary line-clamp-2">${esc(p.subtitle)}</p>
      </div>
      <div class="mt-3 pt-2 border-t border-surface-container-high flex items-center justify-between text-on-surface-variant font-label-mono text-[10px]">
        <span>${p.count ? `${p.count} Tracks` : "Curated"}</span>
      </div>
    </div>`,
    )
    .join("");
}

export function renderHomeTop() {
  const list = $("#home-top-list");
  if (!list || !homeFeed) return;
  // Already deduped in loadHome — render the same array the click handlers
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
          <span class="font-body-md font-semibold text-on-surface block truncate" dir="auto">${esc(t.title)}</span>
          <span class="font-body-sm text-secondary truncate">${artistLinks(t.artist)}</span>
        </div>
      </div>
      <div class="flex items-center gap-6 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-medium text-[10px]">${t.hq ? "320 kbps" : "Standard"}</span>
        <span class="hidden sm:inline">${esc(t.plays ? `${t.plays.toLocaleString()} plays` : "—")}</span>
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
  // First paint of the session: show last launch's feed instantly, then
  // revalidate below. A manual Refresh (homeFeed already set) skips this.
  if (!homeFeed) {
    const snap = homeSnapshot();
    if (snap) {
      homeFeed = snap;
      paintHome();
      diag("home", true, "painted from snapshot");
    }
  }
  let fresh;
  try {
    fresh = await invoke("home_feed");
  } catch (err) {
    diag("home", false, String(err));
    if (homeFeed) return; // snapshot already on screen — keep it, offline boot included
    npText("hero-title", "Home feed unavailable");
    npText("hero-artist", String(err).slice(0, 120));
    for (const sel of ["#home-albums", "#home-artists", "#home-stations", "#playlists-grid"]) {
      const el = $(sel);
      if (el) el.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">Unavailable right now.</p>';
    }
    return;
  }
  homeFeed = await langShelves(fresh);
  paintHome();
  saveHomeSnapshot(homeFeed);
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
    if (label) label.textContent = "Saved ✓";
    diag("library", true, spot.title);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 50)));
  } catch {}
});
$("#home-releases-all")?.addEventListener("click", () => {
  moreHomeAlbums();
});
$("#home-artists-all")?.addEventListener("click", () => {
  moreHomeArtists();
});
$("#home-charts-more")?.addEventListener("click", () => {
  moreHomeCharts();
});
$("#home-daily")?.addEventListener("click", (e) => {
  const play = e.target.closest("[data-daily-play]");
  if (play && homeFeed && homeFeed.daily) {
    const p = homeFeed.daily[Number(play.dataset.dailyPlay)];
    if (p) return playList(p.id);
  }
  const card = e.target.closest("[data-daily-index]");
  if (card && homeFeed && homeFeed.daily) {
    const p = homeFeed.daily[Number(card.dataset.dailyIndex)];
    if (p) openPlaylistElsewhere(p);
  }
});
// Genre pills anywhere on Home run a real track search — never inherit
// whatever entity chip was left active on the Search screen.
$('[data-view="home"]')?.addEventListener("click", (e) => {
  const jump = e.target.closest("[data-jump-id]");
  if (jump) {
    const track = loadPlays().find((p) => p.id === jump.dataset.jumpId);
    if (track) playTrack(track);
    return;
  }
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

