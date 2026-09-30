// library.js — favorites, local playlists, playlist/artist/album detail screens
// Split from main.js (Phase 4 M1).
import { art, paintArt } from "./art.js";
import { emitState } from "./bridge.js";
import { diag, esc, invoke, showView, toast } from "./core.js";
import { $, $$, views } from "./dom.js";
import { LIBRARY_KEY, PLAYS_KEY, homeFeed, loadHome, loadLibrary, loadPlays } from "./home.js";
import { playQueueItem } from "./playback.js";
import { queue, queueIndex, renderQueue, setQueueIndex, setQueueTab, setShuffleMode } from "./queue.js";
import { setRadioStation } from "./radio.js";
import { addBtn, dedupeTracks, doSearch, lastCards, trackRow, uniqById } from "./search.js";
import { paintModes } from "./transport.js";
import { fmtTime, metaLinks, npText, openEntityByName } from "./util.js";
import { downloadAll, downloadTrack } from "./vault.js";

// ------------------------------------------------- local playlists (mine) -
// They live in the same library array as saved items, flagged `local`, so the
// Library grid, `plItemById` and the Saved chip all pick them up unchanged.
export function loadLocalPls() {
  return loadLibrary().filter((p) => p.local);
}
export function saveLocalPls(list) {
  try {
    const rest = loadLibrary().filter((p) => !p.local);
    localStorage.setItem(LIBRARY_KEY, JSON.stringify([...rest, ...list].slice(0, 50)));
  } catch {}
}
export function createLocalPl(name, tracks = []) {
  const title = String(name || "").trim();
  if (!title) return null;
  const pl = { id: `local-${Date.now()}`, title, local: true, tracks };
  saveLocalPls([...loadLocalPls(), pl]);
  renderLibrary();
  return pl;
}
export function addToLocalPl(id, track) {
  const list = loadLocalPls();
  const pl = list.find((p) => p.id === id);
  if (!pl) return false;
  pl.tracks = pl.tracks || [];
  if (!track.id || !pl.tracks.some((t) => t.id === track.id)) pl.tracks.push(track);
  saveLocalPls(list);
  renderLibrary();
  return true;
}
export function removeLocalPl(id) {
  saveLocalPls(loadLocalPls().filter((p) => p.id !== id));
  renderLibrary();
}

// The picker: one modal, one capture-phase listener, so no row builder needs
// its own handler â€” clicking Add anywhere stops the row's play click first.
export let pickTrack = null;

export function renderPickerList() {
  const box = $("#pl-picker-list");
  if (!box) return;
  const list = loadLocalPls();
  box.innerHTML = list.length
    ? list
        .map(
          (p) => `<button type="button" data-pick-id="${esc(p.id)}" class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-surface-container-low text-left transition-colors">
      <span class="font-body-md text-body-md text-on-surface truncate">${esc(p.title)}</span>
      <span class="font-label-mono text-label-mono text-secondary shrink-0">${(p.tracks || []).length} tracks</span>
    </button>`,
        )
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant px-1 py-2">No local playlists yet â€” name one below.</p>';
}
export function openPicker(t) {
  pickTrack = t;
  npText("pl-picker-track", [t.artist, t.title].filter(Boolean).join(" â€” "));
  renderPickerList();
  $("#pl-picker")?.classList.remove("hidden");
  $("#pl-picker-name")?.focus();
}
export function closePicker() {
  $("#pl-picker")?.classList.add("hidden");
  pickTrack = null;
}
/// If the list being edited is the one open on screen, repaint it.
export function syncOpenLocal(id) {
  if (pdCurrentId !== id || !pdLocal) return;
  const fresh = loadLibrary().find((x) => x.id === id);
  if (!fresh) return;
  pdTracks = fresh.tracks || [];
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPd();
}
export function pickerCreate() {
  const name = $("#pl-picker-name");
  const pl = createLocalPl(name?.value);
  if (!pl) return;
  if (name) name.value = "";
  if (pickTrack && addToLocalPl(pl.id, pickTrack)) {
    toast(`Added to ${pl.title}`, "success", 2600);
    closePicker();
  } else {
    toast(`Created ${pl.title}`, "success", 2600);
    renderPickerList();
  }
}

document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest?.("[data-add-id]");
    if (!btn) return;
    // Capture phase: kill the row's own play/fav handlers for this click.
    e.stopPropagation();
    openPicker({
      id: btn.dataset.addId,
      title: btn.dataset.addTitle,
      artist: btn.dataset.addArtist,
      album: btn.dataset.addAlbum,
      image: btn.dataset.addImage,
      duration: btn.dataset.addDur,
      duration_secs: 0,
    });
  },
  true,
);
/// Capture phase: an artist/album name resolves to its own screen instead of
/// firing the row's play handler (or the bar) underneath the click.
document.addEventListener(
  "click",
  (e) => {
    const hit = e.target.closest?.("[data-entity-name]");
    if (!hit || !hit.dataset.entityName) return;
    e.stopPropagation();
    openEntityByName(hit.dataset.entityKind || "artist", hit.dataset.entityName);
  },
  true,
);
$("#pl-picker-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick-id]");
  if (!btn || !pickTrack) return;
  const name = loadLocalPls().find((p) => p.id === btn.dataset.pickId)?.title || "playlist";
  addToLocalPl(btn.dataset.pickId, pickTrack);
  syncOpenLocal(btn.dataset.pickId);
  toast(`Added to ${name}`, "success", 2600);
  closePicker();
});
$("#pl-picker-create")?.addEventListener("click", pickerCreate);
$("#pl-picker-name")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    pickerCreate();
  }
});
$("#pl-picker")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-pl-picker-close]")) closePicker();
});

/// One listening session, recorded where playback actually starts.
export function pushPlay(track) {
  try {
    const next = [{ ...track, ts: Date.now() }, ...loadPlays().filter((x) => x.id !== track.id)].slice(0, 100);
    localStorage.setItem(PLAYS_KEY, JSON.stringify(next));
    renderPlays();
  } catch {}
}

// ---------------------------------------------------------------- favorites -
export const FAVS_KEY = "tm-favorites";

export function loadFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveFavs(list) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {}
}
export function isFav(id) {
  return loadFavs().some((x) => x.id === id);
}
/// Inline style snippet so freshly rendered hearts match persisted state.
export function favFill(id) {
  return isFav(id) ? ` style="font-variation-settings: 'FILL' 1;"` : "";
}
/// Repaint every heart on screen after a toggle (rows re-render rarely).
export function paintFavHearts() {
  for (const icon of $$("[data-fav-icon]")) {
    icon.style.fontVariationSettings = isFav(icon.dataset.favIcon) ? "'FILL' 1" : "'FILL' 0";
  }
}

export function toggleFavTrack(track) {
  if (!track || !track.id) return false;
  const favs = loadFavs();
  const at = favs.findIndex((x) => x.id === track.id);
  let on;
  if (at >= 0) {
    favs.splice(at, 1);
    on = false;
  } else {
    favs.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      image: track.image,
      duration: track.duration || fmtTime(track.duration_secs || 0),
      duration_secs: track.duration_secs || 0,
      hq: !!track.hq,
      plays: track.plays || 0,
    });
    on = true;
  }
  saveFavs(favs);
  paintFavHearts();
  renderFavs();
  toast(
    on ? `Added "${track.title}" to favorites.` : `Removed "${track.title}" from favorites.`,
    on ? "success" : "info",
  );
  diag("favorite", on, track.title);
  emitState(true);
  return on;
}

/// Library "Favorite Masters" section: play on row click, download + remove.
export function renderFavs() {
  const box = $("#library-favs");
  if (!box) return;
  const favs = uniqById(loadFavs());
  const count = $("#library-favs-count");
  if (count) count.textContent = `${favs.length} track${favs.length === 1 ? "" : "s"}`;
  if (!favs.length) {
    box.innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Nothing favorited yet â€” tap the heart on any track.</p>';
    return;
  }
  box.innerHTML = "";
  favs.forEach((t, i) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${metaLinks(t)}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-fav-dl="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        <button type="button" data-fav-del="${i}" title="Remove from favorites" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" style="font-variation-settings: 'FILL' 1;">favorite</span>
        </button>
      </div>`;
    row.addEventListener("click", (e) => {
      const del = e.target.closest("[data-fav-del]");
      if (del) {
        e.stopPropagation();
        toggleFavTrack(favs[Number(del.dataset.favDel)]);
        return;
      }
      const dl = e.target.closest("[data-fav-dl]");
      if (dl) {
        e.stopPropagation();
        downloadTrack(favs[Number(dl.dataset.favDl)], dl);
        return;
      }
      playTracksAt(favs, i);
    });
    box.appendChild(row);
  });
}

export function playTracksAt(list, index) {
  // One choke point for "play this whole list": collapse repeats first, but
  // keep playing the row the user actually clicked.
  const tracks = dedupeTracks(list).list;
  const at = tracks.indexOf(list[index]);
  queue.length = 0;
  // A fresh context re-seeds the radio: recommendations follow what the
  // user just started, not whatever they played an hour ago.
  setRadioStation("");
  for (const t of tracks) queue.push({ track: t, state: null });
  setQueueTab("next");
  setQueueIndex(-1);
  renderQueue();
  playQueueItem(at >= 0 ? at : 0);
}

export function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/// Shared track rows: click a row to play the whole list from there.
/// `limit` paints only the first rows (the artist screen's "load more" walks
/// the rest) while every handler still indexes into the full list.
export function trackRows(list, box, emptyMsg, limit) {
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${emptyMsg || "Nothing here yet."}</p>`;
    return;
  }
  const shown = Number.isFinite(limit) && limit < list.length ? list.slice(0, limit) : list;
  box.innerHTML = "";
  shown.forEach((t, i) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <span class="font-label-mono text-[11px] text-on-surface-variant w-5 text-right shrink-0">${i + 1}</span>
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate"><span class="hover:underline cursor-pointer" data-entity-kind="artist" data-entity-name="${esc(t.artist || "")}">${esc(t.artist || "")}</span></div>
        </div>
      </div>
      <div class="flex items-center gap-3 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-fav-idx="${i}" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" data-fav-icon="${esc(t.id || "")}"${favFill(t.id || "")}>favorite</span>
        </button>
        <button type="button" data-dl-idx="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        ${addBtn(t)}
        <span class="material-symbols-outlined text-[18px] opacity-0 group-hover:opacity-100">play_arrow</span>
      </div>`;
    row.addEventListener("click", (e) => {
      const fav = e.target.closest("[data-fav-idx]");
      if (fav) {
        e.stopPropagation();
        toggleFavTrack(list[Number(fav.dataset.favIdx)]);
        return;
      }
      const dl = e.target.closest("[data-dl-idx]");
      if (dl) {
        e.stopPropagation();
        downloadTrack(list[Number(dl.dataset.dlIdx)], dl);
        return;
      }
      playTracksAt(list, i);
    });
    box.appendChild(row);
  });
}

export let pdTracks = [];
// Playlists screen: `pdVisible` is how much of the table is painted,
// `pdCurrentId`/`pdLocal` say which playlist owns it, `pdSeq` drops stale
// fetches. The hero (`plFeatured`) always shows the same playlist.
export let pdVisible = 0;
export let pdLocal = false;
export let pdCurrentId = "";
export let pdSeq = 0;
export const PD_FIRST = 30;
export let plFeatured = null;
/// Entries rendered by the last `renderPlaylists()` â€” card, tag and label.
export let plItems = [];
export let plFilter = "all";
export let plQuery = "";
export let ddTracks = [];
// Artist screen paging: `ddPage` is the last page fetched, `ddMore` says the
// catalogue still continues behind it, `ddVisible` is what the list paints.
export let ddToken = "";
export let ddPage = 0;
export let ddMore = false;
export let ddVisible = 0;
export let ddReleases = 0;
export let ddSubExtra = "";
export let ddUnit = "tracks";
/// Discography rows (each tagged album/single) and the chip filtering them.
export let ddReleaseList = [];
export let ddFilter = "all";
export const FILTER_ON =
  "px-3 py-1 rounded-full bg-surface-container-lowest text-on-surface shadow-sm font-label-md text-label-md font-medium";
export const FILTER_OFF =
  "px-3 py-1 rounded-full text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors";
export const DD_FIRST = 50; // rows painted the moment the screen opens
/// Detail screens opened from inside another one â€” Back walks out of them.
export const ddStack = [];
export let ddCurrent = null;
/// The view Back lands on when the stack is empty (Home, Search, â€¦).
export let ddReturnView = "home";
/// Bumped by every open so a stale response never paints over a newer screen.
export let ddSeq = 0;

export function plItemById(id) {
  const pools = homeFeed
    ? [...lastCards, ...homeFeed.playlists, ...homeFeed.charts, homeFeed.spotlight].filter(Boolean)
    : lastCards;
  return (
    pools.find((p) => p.id === id) ||
    loadLibrary().find((p) => p.id === id) ||
    { id, title: "Playlist" }
  );
}

/// How a playlist should be tagged wherever it is opened from.
export function plEntryById(id) {
  const hit = plItems.find((e) => e.p.id === id);
  if (hit) return hit;
  const item = plItemById(id);
  const saved = loadLibrary().some((x) => x.id === id);
  return { p: item, tag: saved ? "SAVED" : "CURATED", label: saved ? "In Library" : "" };
}

/// Playlists screen: the hero, the meta line and the track table always show
/// the same playlist, exactly like the design's featured card + table.
export async function openPlaylist(item, { scroll = true } = {}) {
  // Claim the id before `showView` so its playlists hook cannot re-enter us.
  const entry = plEntryById(item.id);
  plFeatured = entry;
  pdCurrentId = item.id;
  pdLocal = Array.isArray(item.tracks);
  pdTracks = pdLocal ? (item.tracks || []).slice() : [];
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  showView("playlists");
  paintFeatured();
  const detail = $("#playlist-detail");
  detail?.classList.remove("hidden");
  npText("pd-title", item.title || "Playlist");
  npText("pd-title-copy", item.title ? `â€¢ ${item.title}` : "");
  npText("pd-subtitle", item.subtitle || (pdLocal ? "Local playlist" : "Loading tracksâ€¦"));
  $("#pd-delete")?.classList.toggle("hidden", !item.local);
  const img = $("#pd-image");
  if (img) {
    if (item.image) {
      paintArt(img, item.image);
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#pd-tracks");
  if (box && !pdLocal) {
    box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracksâ€¦</p>';
  }
  if (scroll) detail?.scrollIntoView({ behavior: "smooth", block: "start" });
  paintPd();
  if (pdLocal) {
    diag("playlist", true, `${pdTracks.length} tracks (local)`);
    return;
  }
  const seq = ++pdSeq;
  try {
    const list = dedupeTracks(await invoke("playlist_tracks", { id: item.id })).list;
    if (seq !== pdSeq) return;
    pdTracks = list;
    pdVisible = Math.min(PD_FIRST, pdTracks.length);
  } catch (err) {
    if (seq !== pdSeq) return;
    diag("playlist", false, String(err));
    npText("pd-subtitle", `Could not load: ${String(err).slice(0, 90)}`);
    pdTracks = [];
    paintPd();
    return;
  }
  paintPd();
  diag("playlist", true, `${pdTracks.length} tracks`);
}

/// Counts, subtitle and the table/footer for whatever `pdTracks` holds now.
export function paintPd() {
  const n = pdTracks.length;
  const item = plFeatured?.p || {};
  npText("pd-total", n ? `${n} TRACKS TOTAL` : "");
  npText("pd-subtitle", [item.subtitle, `${n} tracks`].filter(Boolean).join(" Â· "));
  paintPdRows();
  paintFeaturedMeta();
}

export function paintPdRows() {
  const box = $("#pd-tracks");
  if (!box) return;
  box.innerHTML = "";
  if (!pdTracks.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${
      pdLocal ? "No tracks yet â€” open any track elsewhere and hit the add button." : "That playlist has no tracks."
    }</p>`;
    $("#pd-foot")?.classList.add("hidden");
    return;
  }
  const shown = pdTracks.slice(0, pdVisible);
  shown.forEach((t, i) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = trackRow(t, i, i === queueIndex && queue[queueIndex]?.track.id === t.id, "list");
    const row = wrap.firstElementChild;
    row.addEventListener("click", (e) => {
      const action = e.target.closest("[data-row-action]")?.dataset.rowAction;
      if (action === "download") {
        e.stopPropagation();
        downloadTrack(t, e.target.closest("button"));
        return;
      }
      if (action === "fav") {
        e.stopPropagation();
        toggleFavTrack(t);
        return;
      }
      playTracksAt(pdTracks, i);
    });
    box.appendChild(row);
  });
  const left = pdTracks.length - shown.length;
  $("#pd-foot")?.classList.toggle("hidden", !pdTracks.length);
  $("#pd-more")?.classList.toggle("hidden", !left);
  npText("pd-showing", `Showing ${shown.length} of ${pdTracks.length} tracks in playlist`);
  npText("pd-more-label", `Load all ${pdTracks.length} tracks`);
}

/// Subtitle = whatever the card said + how much of the work is loaded.
export function paintDdSubtitle() {
  const loaded = ddTracks.length ? `${ddTracks.length} ${ddUnit}` : "";
  npText("dd-subtitle", [ddSubExtra, loaded].filter(Boolean).join(" Â· "));
}

/// The track list plus its "show/load more" bar, kept in step with each other.
export function renderDd(emptyMsg) {
  trackRows(ddTracks, $("#dd-tracks"), emptyMsg, ddVisible);
  npText("dd-list-count", ddTracks.length ? `${ddTracks.length} loaded` : "");
  const wrap = $("#dd-more-wrap");
  if (!wrap) return;
  const left = Math.max(0, ddTracks.length - ddVisible);
  if (!left && !ddMore) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const btn = $("#dd-more");
  if (btn) btn.disabled = false;
  npText("dd-more-label", left ? `Show ${left} more song${left === 1 ? "" : "s"}` : "Load more songs");
}

/// Artist header furniture: verification, listeners, bio, discography.
export function paintArtistHeader(ov) {
  if (!ov) return;
  if (ov.name) npText("dd-title", ov.name);
  if (ov.image) paintArt($("#dd-image"), ov.image);
  if (ov.listeners) {
    const chip = $("#dd-listeners");
    if (chip) {
      chip.textContent = `${Number(ov.listeners).toLocaleString("en-US")} Listeners`;
      chip.classList.remove("hidden");
    }
  }
  if (ov.verified) $("#dd-verified")?.classList.remove("hidden");
  if (ov.bio) {
    const bio = $("#dd-bio");
    if (bio) {
      bio.textContent = ov.bio;
      bio.classList.remove("hidden");
    }
  }
  ddReleaseList = ov.releases || [];
  ddReleases = ddReleaseList.length;
  renderReleases();
}

/// The release grid plus its All / Albums / Singles chips.
export function renderReleases() {
  const grid = $("#dd-releases");
  if (!grid) return;
  const counts = { all: ddReleaseList.length, album: 0, single: 0 };
  for (const r of ddReleaseList) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const shown = ddReleaseList.filter((r) => ddFilter === "all" || r.kind === ddFilter);
  grid.innerHTML = shown.map(releaseCard).join("");
  $("#dd-discography")?.classList.toggle("hidden", !ddReleaseList.length);
  npText(
    "dd-release-count",
    `${ddReleases} release${ddReleases === 1 ? "" : "s"}`,
  );
  const chips = $("#dd-release-filters");
  if (!chips) return;
  // Nothing to split when every release sits on the same shelf.
  chips.classList.toggle("hidden", !counts.album || !counts.single);
  for (const btn of $$("[data-dd-filter]", chips)) {
    const kind = btn.dataset.ddFilter;
    btn.className = kind === ddFilter ? FILTER_ON : FILTER_OFF;
    btn.textContent = `${btn.dataset.ddLabel} (${counts[kind] || 0})`;
  }
}

/// One discography card â€” same tokens the album cards take, so a click opens
/// the release itself.
export function releaseCard(a) {
  const meta = [a.year, a.count ? `${a.count} track${a.count === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" Â· ");
  return `
    <div data-dd-kind="album" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col cursor-pointer">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-surface-container-high mb-2.5">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(a.image || "")} />
        ${a.year ? `<span class="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-surface-container-lowest/90 backdrop-blur-md font-label-mono text-[9px] text-on-surface">${esc(a.year)}</span>` : ""}
        <div class="absolute inset-0 bg-primary/20 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span class="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-lg"><span class="material-symbols-outlined text-[20px]" style="font-variation-settings: 'FILL' 1;">play_arrow</span></span>
        </div>
      </div>
      <span class="font-label-md text-label-md text-on-surface font-medium truncate">${esc(a.title || "")}</span>
      <span class="font-label-mono text-[10px] text-on-surface-variant truncate mt-0.5">${esc(meta || a.subtitle || "")}</span>
    </div>`;
}

/// Append one upstream page to the loaded catalogue. "Still full" *and* "brought
/// something new" both have to hold before the works are called unfinished.
export function mergeArtistPage(next) {
  ddPage += 1;
  const before = ddTracks.length;
  ddTracks = dedupeTracks([...ddTracks, ...((next && next.tracks) || [])]).list;
  ddMore = !!(next && next.page_full) && ddTracks.length > before;
  ddVisible = ddTracks.length;
}

/// Walk every remaining page so Play/Shuffle means *all* the works, painting
/// each page as it lands. Stops on its own if the catalogue stops growing.
export async function loadAllArtistSongs() {
  let pages = 0;
  while (ddMore && ddToken && pages < 40) {
    const seq = ddSeq;
    let next;
    try {
      next = await invoke("artist_tracks", { token: ddToken, page: ddPage + 1 });
    } catch (err) {
      diag("artist page", false, String(err));
      toast(`Stopped after ${ddTracks.length} songs: ${String(err).slice(0, 70)}`, "error");
      break;
    }
    if (seq !== ddSeq) return false;
    mergeArtistPage(next);
    pages += 1;
    paintDdSubtitle();
    renderDd();
  }
  return true;
}

/// Album / artist screen (the `detail` view) â€” token comes from the card.
/// Artists load in two streams: the songs (paged, so the whole catalogue is
/// walkable) and the header/discography (one call).
export async function openDetail(kind, item, opts = {}) {
  const isArtist = kind === "artist";
  if (opts.push && ddCurrent) ddStack.push(ddCurrent);
  else ddStack.length = 0;
  ddCurrent = { kind, item };
  // Captured before the view switch: where Back lands once the stack is dry.
  const here = views.find((v) => !v.classList.contains("hidden"));
  if (!opts.push && here && here.dataset.view !== "detail") ddReturnView = here.dataset.view;
  // A second open while the first is in flight must not paint over it.
  const seq = ++ddSeq;
  showView("detail");
  npText("dd-kind", kind.toUpperCase());
  npText("dd-title", item.title || "â€”");
  npText("dd-subtitle", "Loading tracksâ€¦");
  for (const sel of ["#dd-verified", "#dd-listeners", "#dd-bio", "#dd-discography", "#dd-more-wrap", "#dd-list-head"])
    $(sel)?.classList.add("hidden");
  ddTracks = [];
  ddToken = item.token || "";
  ddPage = 0;
  ddMore = false;
  ddVisible = 0;
  ddReleases = 0;
  ddReleaseList = [];
  ddFilter = "all";
  ddSubExtra = item.subtitle || "";
  ddUnit = isArtist ? "songs" : "tracks";
  if (isArtist) $("#dd-list-head")?.classList.remove("hidden");
  const img = $("#dd-image");
  if (img) {
    if (item.image) {
      paintArt(img, item.image);
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
  }
  const box = $("#dd-tracks");
  if (box) box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracksâ€¦</p>';

  if (!isArtist) {
    try {
      const raw =
        kind === "playlist"
          ? await invoke("playlist_tracks", { id: item.id })
          : await invoke("album_tracks", { token: item.token });
      ddTracks = dedupeTracks(raw).list;
    } catch (err) {
      diag(kind, false, String(err));
      npText("dd-subtitle", `Could not load ${kind}: ${String(err).slice(0, 80)}`);
      if (box) box.innerHTML = "";
      $("#dd-list-head")?.classList.add("hidden");
      return;
    }
    if (seq !== ddSeq) return;
    ddVisible = ddTracks.length;
    paintDdSubtitle();
    renderDd(`No tracks found for this ${kind}.`);
    diag(kind, true, `${ddTracks.length} tracks`);
    return;
  }

  // Songs first: a slow header must not hold up the first page of the works.
  const [page, overview] = await Promise.allSettled([
    invoke("artist_tracks", { token: item.token, page: 0 }),
    invoke("artist_overview", { token: item.token }),
  ]);
  if (seq !== ddSeq) return;
  if (page.status === "rejected") {
    diag("artist", false, String(page.reason));
    npText("dd-subtitle", `Could not load artist: ${String(page.reason).slice(0, 80)}`);
    if (box) box.innerHTML = "";
    $("#dd-list-head")?.classList.add("hidden");
    return;
  }
  const first = page.value || {};
  ddTracks = dedupeTracks(first.tracks || []).list;
  ddMore = !!first.page_full;
  ddVisible = Math.min(DD_FIRST, ddTracks.length);
  if (overview.status === "fulfilled") paintArtistHeader(overview.value);
  ddSubExtra = ddReleases ? `${ddReleases} releases` : ddSubExtra;
  paintDdSubtitle();
  renderDd("No songs found for this artist.");
  diag("artist", true, `${ddTracks.length} songs Â· ${ddReleases} releases`);
}

/// One playlist card: corner tag, cover, blurb, track count + optional source
/// label. `tag`/`label` are passed by the caller so the same card renders in the
/// Playlists grid and in Library without sniffing where it came from.
export function plCard(p, tag = "CURATED", label = "") {
  const n = p.count || (p.tracks || []).length || 0;
  const blurb = p.blurb || p.subtitle || (p.local ? "Your own playlist." : "Curated collection.");
  const cover = p.image
    ? `<img alt="" loading="lazy" class="w-full h-full object-cover" ${art(p.image)} />`
    : `<div class="w-full h-full bg-surface flex flex-col items-center justify-center gap-1.5 text-on-surface-variant">
          <span class="material-symbols-outlined text-[40px]">${esc(p.icon || "playlist_play")}</span>
          ${p.synthetic ? '<span class="font-label-mono text-[9px] uppercase tracking-wider">Auto-generated</span>' : ""}
        </div>`;
  return `
    <div data-pl-id="${esc(p.id)}"${p.synthetic ? ` data-pl-synthetic="${esc(p.synthetic)}"` : ""} class="rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col cursor-pointer overflow-hidden">
      <div class="relative aspect-square overflow-hidden bg-surface-container-high">
        ${cover}
        <span class="absolute top-2.5 left-2.5 px-2 py-1 rounded bg-black/70 text-white font-label-mono text-[9px] uppercase tracking-wider">${esc(tag)}</span>
        <button type="button" title="Open playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
      </div>
      <div class="p-3.5 flex flex-col gap-1.5 min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(p.title || "")}</p>
        <p class="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">${esc(blurb)}</p>
        <div class="flex items-center justify-between gap-2 pt-0.5">
          <span class="font-label-mono text-label-mono text-secondary truncate">${n ? `${n} Tracks` : ""}</span>
          ${label ? `<span class="font-label-mono text-label-mono text-secondary shrink-0">${esc(label)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

export function ddCard(kind, a) {
  return `
    <div data-dd-kind="${esc(kind)}" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
        <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(a.image || "")} />
        <button type="button" title="Open" class="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md hover:scale-105">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
      </div>
      <div class="min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate">${esc(a.title || "")}</p>
        <p class="font-body-sm text-body-sm text-secondary truncate">${esc(a.subtitle || (kind === "album" ? "New album" : "Artist"))}</p>
      </div>
    </div>`;
}

export function stationCard(c, i) {
  return `
    <div data-pl-id="${esc(c.id)}" class="p-5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all flex flex-col justify-between group cursor-pointer">
      <div>
        <div class="flex items-center justify-between mb-3">
          <span class="font-label-mono text-[10px] px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-medium">NODE #0${i + 1}</span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
        </div>
        <h4 class="font-headline-md text-headline-md text-on-surface group-hover:text-primary transition-colors">${esc(c.title || "")}</h4>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${c.count ? `${c.count} tracks` : esc(c.subtitle || "")}</p>
      </div>
      <div class="mt-4 pt-3 border-t border-surface-container-high flex items-center justify-between">
        <span class="font-label-mono text-[10px] text-secondary">Chart</span>
        <span class="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center group-hover:scale-105 transition-transform"><span class="material-symbols-outlined text-[18px]">radio</span></span>
      </div>
    </div>`;
}

export const GRID_EMPTY = '<p class="font-body-sm text-body-sm text-on-surface-variant">Unavailable right now.</p>';

/// Hours + minutes for a whole playlist: "2h 42m".
export function fmtSpan(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

/// The two cards that only exist on this machine: what you hearted and
/// whatever is queued right now.
export function plSyntheticEntries() {
  const liked = loadFavs();
  const queued = queue.map((q) => q.track).filter(Boolean);
  return [
    {
      p: {
        id: "pl-liked",
        synthetic: "liked",
        title: "Liked Songs",
        blurb: "All tracks you've marked with a heart across your library.",
        count: liked.length,
        icon: "favorite",
        tracks: liked,
      },
      tag: "Auto-generated",
      label: "Quick Access",
    },
    {
      p: {
        id: "pl-queue",
        synthetic: "queue",
        title: "Current Queue & Session Stash",
        blurb: "On-the-fly tracks queued during your current listening session.",
        count: queued.length,
        icon: "queue_music",
        tracks: queued,
      },
      tag: "Temporary Queue",
      label: "Active Session",
    },
  ];
}

export function plBuckets() {
  const feed = homeFeed || { playlists: [], charts: [] };
  return {
    synthetic: plSyntheticEntries(),
    curated: (feed.playlists || []).map((p) => ({ p, tag: "Curated", label: "" })),
    charts: (feed.charts || []).map((p) => ({ p, tag: "Chart", label: "Chart" })),
    saved: loadLibrary().map((p) => ({ p, tag: p.local ? "Local" : "Saved", label: p.local ? "Local" : "In Library" })),
  };
}

export function plDedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.p.id) ? false : (seen.add(e.p.id), true)));
}

/// Chips, cards and the featured hero â€” one pass over the real sources.
export function renderPlaylists() {
  const box = $("#playlists-grid");
  if (!box) return;
  const b = plBuckets();
  const all = plDedupe([...b.synthetic, ...b.curated, ...b.charts, ...b.saved]);
  const counts = {
    all: all.length,
    curated: b.curated.length,
    charts: b.charts.length,
    saved: b.saved.length,
  };
  const list = plFilter === "all" ? all : plFilter === "curated" ? b.curated : plFilter === "charts" ? b.charts : b.saved;
  const q = plQuery.trim().toLowerCase();
  const shown = q ? list.filter((e) => (e.p.title || "").toLowerCase().includes(q)) : list;
  // Entries stay resolvable from any chip, so a card opened later still tags right.
  plItems = plDedupe([...all, ...list]);
  box.innerHTML = shown.length
    ? shown.map((e) => plCard(e.p, e.tag, e.label)).join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">No playlists match that.</p>';
  npText("pl-visible", `${shown.length} playlist${shown.length === 1 ? "" : "s"}`);
  npText("pl-count", `(${list.length} collection${list.length === 1 ? "" : "s"})`);
  for (const btn of $$("[data-pl-filter]")) {
    const on = btn.dataset.plFilter === plFilter;
    btn.className = on ? FILTER_ON : FILTER_OFF;
    btn.textContent = `${btn.dataset.plLabel} (${counts[btn.dataset.plFilter] || 0})`;
  }
  // The hero shows a real playlist (like the design's featured card); the
  // auto-generated ones stay in the grid. Nothing open yet â†’ first in view.
  if (!pdCurrentId && shown.length) {
    plFeatured = shown.find((e) => !e.p.synthetic) || shown[0];
    paintFeatured();
  }
}

export function featuredMetaText() {
  const p = plFeatured?.p || {};
  const open = pdCurrentId === p.id;
  const n = open ? pdTracks.length : p.count || (p.tracks || []).length || 0;
  const total = open ? fmtSpan(pdTracks.reduce((s, t) => s + (t.duration_secs || 0), 0)) : "";
  // Followers already sit in the blurb, so keep this to tracks + running time.
  return [n ? `${n} tracks` : "", total].filter(Boolean).join(" Â· ");
}

export function paintFeaturedMeta() {
  if (plFeatured) npText("plf-meta", featuredMetaText());
}

export function paintFeatured() {
  const box = $("#pl-featured");
  if (!plFeatured) {
    box?.classList.add("hidden");
    return;
  }
  box?.classList.remove("hidden");
  const p = plFeatured.p;
  const img = $("#plf-image");
  if (img && p.image) paintArt(img, p.image);
  npText("plf-title", p.title || "Playlist");
  npText("plf-eyebrow", plFeatured.label || "Playlist");
  npText("plf-desc", p.blurb || p.subtitle || (p.local ? "Your own playlist." : "Curated collection."));
  npText("plf-meta", featuredMetaText());
  // Synthetic cards are not storable, so there is nothing to toggle.
  $("#plf-save")?.classList.toggle("hidden", !!p.synthetic);
  const inLib = loadLibrary().some((x) => x.id === p.id);
  npText("plf-save-label", inLib ? "Saved" : "Save");
}
export function renderHomeAlbums() {
  const box = $("#home-albums");
  if (!box || !homeFeed) return;
  box.innerHTML = homeFeed.albums.length ? homeFeed.albums.map((a) => ddCard("album", a)).join("") : GRID_EMPTY;
}
export function renderHomeArtists() {
  const box = $("#home-artists");
  if (!box || !homeFeed) return;
  box.innerHTML = homeFeed.artists.length ? homeFeed.artists.map((a) => ddCard("artist", a)).join("") : GRID_EMPTY;
}
export function renderHomeStations() {
  const box = $("#home-stations");
  if (!box || !homeFeed) return;
  const list = homeFeed.charts.slice(0, 3);
  box.innerHTML = list.length ? list.map(stationCard).join("") : GRID_EMPTY;
}
export function renderLibrary() {
  const box = $("#library-saved");
  if (!box) return;
  const lib = uniqById(loadLibrary());
  box.innerHTML = lib.length
    ? lib
        .map((p) => plCard(p, p.local ? "Local" : "Saved", p.local ? "Local" : "In Library"))
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet â€” hit â€œSave to Libraryâ€ on Home.</p>';
}
export function renderPlays() {
  const plays = uniqById(loadPlays());
  const count = $("#history-count");
  if (count) count.textContent = `${plays.length} session${plays.length === 1 ? "" : "s"}`;
  trackRows(plays, $("#history-plays"), "Nothing played yet.");
  trackRows(plays.slice(0, 5), $("#library-recent"), "No plays yet.");
}

// Click wiring â€” one delegated listener per grid.
// `inline` keeps the Playlists tab's own behaviour (open the panel in place);
// everywhere else the playlist opens on the shared detail screen so the click
// never yanks the user onto the Playlists tab.
export function openPlaylistElsewhere(item) {
  // Local + in-memory playlists have no server id, so the detail view (which
  // loads by id) cannot open them; they keep the inline panel.
  if (item.local || Array.isArray(item.tracks)) return openPlaylist(item);
  openDetail("playlist", item);
}

export function wirePlGrid(sel, { inline = false } = {}) {
  $(sel)?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-pl-id]");
    if (!card) return;
    // Liked Songs / Current Queue only exist in memory, so they come from the
    // last render instead of the id pools.
    const syn = card.dataset.plSynthetic;
    if (syn) {
      const hit = plItems.find((x) => x.p.synthetic === syn);
      if (hit) openPlaylist(hit.p);
      return;
    }
    const item = plItemById(card.dataset.plId);
    if (inline) openPlaylist(item);
    else openPlaylistElsewhere(item);
  });
}
wirePlGrid("#playlists-grid", { inline: true });
wirePlGrid("#home-stations");
wirePlGrid("#library-saved");

export function wireDdGrid(sel) {
  $(sel)?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-dd-token]");
    if (!card) return;
    const item = {
      token: card.dataset.ddToken,
      title: card.dataset.ddTitle,
      subtitle: card.dataset.ddSub,
      image: card.dataset.ddImg,
    };
    // No token (payload oddity) â†’ fall back to a real search instead of dead click.
    if (!item.token) {
      doSearch({ query: item.title || "" });
      return;
    }
    openDetail(card.dataset.ddKind, item);
  });
}
wireDdGrid("#home-albums");
wireDdGrid("#home-artists");
// The search grid holds whichever card type the active chip selected.
wireDdGrid("#results");
wirePlGrid("#results");

// ------------------------------------------------------- playlists screen -
$("#pd-play")?.addEventListener("click", () => pdTracks.length && playTracksAt(pdTracks, 0));
$("#pd-shuffle")?.addEventListener("click", () => {
  if (!pdTracks.length) return;
  pdTracks = shuffled(pdTracks);
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPdRows();
  setShuffleMode(true);
  paintModes();
  playTracksAt(pdTracks, 0);
});
$("#pd-back")?.addEventListener("click", () => $("#playlist-detail")?.classList.add("hidden"));
$("#pd-download")?.addEventListener("click", () => {
  if (!pdTracks.length) return;
  downloadAll(pdTracks, "playlist tracks", $("#pd-download"));
});
$("#pd-more")?.addEventListener("click", () => {
  pdVisible = pdTracks.length;
  paintPdRows();
});
$("#pd-delete")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const name = plFeatured?.p.title;
  if (!pdCurrentId || !name) return;
  // Two clicks instead of a native confirm() â€” webviews do not all have one.
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.title = "Click again to delete";
    btn.classList.add("text-error", "bg-error-container");
    setTimeout(() => {
      btn.dataset.armed = "";
      btn.title = "Delete this local playlist";
      btn.classList.remove("text-error", "bg-error-container");
    }, 3000);
    return;
  }
  removeLocalPl(pdCurrentId);
  $("#playlist-detail")?.classList.add("hidden");
  pdCurrentId = "";
  plFeatured = null;
  paintFeatured();
  renderPlaylists();
  toast(`Deleted ${name}`, "success", 2600);
});
$("#pl-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pl-filter]");
  if (!btn) return;
  plFilter = btn.dataset.plFilter;
  renderPlaylists();
});
$("#pl-search")?.addEventListener("input", (e) => {
  plQuery = e.target.value;
  renderPlaylists();
});
$("#pl-viewall")?.addEventListener("click", () => {
  plFilter = "all";
  plQuery = "";
  const input = $("#pl-search");
  if (input) input.value = "";
  renderPlaylists();
  $("#playlists-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#pl-refresh")?.addEventListener("click", async () => {
  const icon = $("#pl-refresh")?.firstElementChild;
  icon?.classList.add("animate-spin");
  await loadHome();
  icon?.classList.remove("animate-spin");
  renderPlaylists();
  toast("Playlists refreshed", "success", 2200);
});
$("#pl-back")?.addEventListener("click", () => showView("library"));

/// Hero buttons act on the very playlist the table below shows.
export async function featuredLoaded() {
  if (!plFeatured) return false;
  if (pdCurrentId !== plFeatured.p.id || !pdTracks.length) {
    await openPlaylist(plFeatured.p, { scroll: false });
  }
  return pdTracks.length > 0;
}
$("#plf-play")?.addEventListener("click", async () => {
  if (await featuredLoaded()) playTracksAt(pdTracks, 0);
});
$("#plf-shuffle")?.addEventListener("click", async () => {
  if (!(await featuredLoaded())) return;
  pdTracks = shuffled(pdTracks);
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPdRows();
  setShuffleMode(true);
  paintModes();
  playTracksAt(pdTracks, 0);
});
$("#plf-save")?.addEventListener("click", () => {
  const p = plFeatured?.p;
  if (!p || p.synthetic) return;
  let lib = [];
  try {
    lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {}
  const at = lib.findIndex((x) => x.id === p.id);
  if (at >= 0) {
    lib.splice(at, 1);
    npText("plf-save-label", "Save");
    toast("Removed from Library", "info", 2200);
  } else {
    lib.push({ id: p.id, title: p.title, subtitle: p.subtitle, image: p.image, count: p.count });
    npText("plf-save-label", "Saved");
    toast("Saved to Library", "success", 2200);
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 50)));
  } catch {}
  renderLibrary();
  renderPlaylists();
});
$("#lib-new-pl")?.addEventListener("click", () => {
  // Same modal the + button uses, just opened to create: no native prompt().
  pickTrack = null;
  npText("pl-picker-track", "Name your new playlist");
  renderPickerList();
  $("#pl-picker")?.classList.remove("hidden");
  $("#pl-picker-name")?.focus();
});
// Discography cards sit inside the artist screen: the artist stays on the
// stack so Back returns to it instead of dropping to Home.
$("#dd-release-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-dd-filter]");
  if (!btn) return;
  ddFilter = btn.dataset.ddFilter;
  renderReleases();
});
$("#dd-releases")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-dd-token]");
  if (!card) return;
  const item = {
    token: card.dataset.ddToken,
    title: card.dataset.ddTitle,
    subtitle: card.dataset.ddSub,
    image: card.dataset.ddImg,
  };
  if (!item.token) {
    doSearch({ query: item.title || "" });
    return;
  }
  openDetail(card.dataset.ddKind || "album", item, { push: true });
});

$("#dd-play")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  playTracksAt(ddTracks, 0);
});
$("#dd-download")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  const kind = ddCurrent?.kind || "album";
  downloadAll(ddTracks, kind === "artist" ? "artist songs" : `${kind} tracks`, $("#dd-download"));
});
$("#dd-shuffle")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  ddTracks = shuffled(ddTracks);
  ddVisible = ddTracks.length;
  renderDd();
  setShuffleMode(true);
  paintModes();
  playTracksAt(ddTracks, 0);
});
// Rest of the loaded songs first, then the next page of the catalogue.
$("#dd-more")?.addEventListener("click", async () => {
  if (ddVisible < ddTracks.length) {
    ddVisible = ddTracks.length;
    renderDd();
    return;
  }
  if (!ddMore || !ddToken) return;
  const seq = ddSeq;
  const btn = $("#dd-more");
  if (btn) btn.disabled = true;
  npText("dd-more-label", "Loadingâ€¦");
  try {
    const next = await invoke("artist_tracks", { token: ddToken, page: ddPage + 1 });
    if (seq !== ddSeq) return;
    mergeArtistPage(next);
    paintDdSubtitle();
    renderDd();
    diag("artist", true, `${ddTracks.length} songs loaded`);
  } catch (err) {
    diag("artist page", false, String(err));
    toast(`Could not load more songs: ${String(err).slice(0, 90)}`, "error");
    renderDd();
  }
});
$("#dd-back")?.addEventListener("click", () => {
  const prev = ddStack.pop();
  if (prev) openDetail(prev.kind, prev.item);
  else showView(ddReturnView || "home");
});
$("#history-clear")?.addEventListener("click", () => {
  try {
    localStorage.removeItem(PLAYS_KEY);
  } catch {}
  renderPlays();
  diag("history", null, "cleared");
});
document.addEventListener("click", (e) => {
  const jump = e.target.closest("[data-path-jump]");
  if (jump) showView(jump.dataset.pathJump);
});


// Setters for state rebound from other modules (ESM imports are read-only).
export function setPlFilter(v) { plFilter = v; }
export function setPlQuery(v) { plQuery = v; }
