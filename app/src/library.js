// library.js — favorites, local playlists, playlist/artist/album detail screens
// Split from main.js (Phase 4 M1).
import { art, paintArt } from "./art.js";
import { emitState } from "./bridge.js";
import { backView, diag, esc, invoke, notifyLocalChange, showView, toast } from "./core.js";
import { $, $$, views } from "./dom.js";
import { LIBRARY_KEY, PLAYS_KEY, homeFeed, loadHome, loadLibrary, loadPlays, paintTaste } from "./home.js";
import { playQueueItem } from "./playback.js";
import { enqueue, insertNext, queue, queueIndex, renderQueue, setQueueIndex, setQueueTab, setShuffleMode } from "./queue.js";
import { setRadioStation } from "./radio.js";
import { addBtn, dedupeTracks, doSearch, lastCards, trackRow, uniqById } from "./search.js";
import { favsNotSaved, topPlayedTracks } from "./smart.js";
import { groupLangAlbums, variantsFor } from "./albumgroup.js";
import { paintModes } from "./transport.js";
import { artistLinks, fmtTime, metaLinks, npText, openEntityByName } from "./util.js";
import { dlBatch, downloadAll, downloadTrack, refreshVault, stopBatch, vaultEntries } from "./vault.js";

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
    notifyLocalChange();
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
// its own handler — clicking Add anywhere stops the row's play click first.
export let pickTrack = null;

export function renderPickerList() {
  const box = $("#pl-picker-list");
  if (!box) return;
  const list = loadLocalPls();
  box.innerHTML = list.length
    ? list
        .map(
          (p) => `<button type="button" data-pick-id="${esc(p.id)}" class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-surface-container-low text-left transition-colors">
      <span class="font-body-md text-body-md text-on-surface truncate" dir="auto">${esc(p.title)}</span>
      <span class="font-label-mono text-label-mono text-secondary shrink-0">${(p.tracks || []).length} tracks</span>
    </button>`,
        )
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant px-1 py-2">No local playlists yet — name one below.</p>';
}
export function openPicker(t) {
  pickTrack = t;
  npText("pl-picker-track", [t.artist, t.title].filter(Boolean).join(" — "));
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

/// One listening session, recorded where playback actually starts. The entry
/// carries how many times it has been started — Home's "Most Listened" ranks
/// by that, so the count rides along with the row it belongs to.
export function pushPlay(track) {
  try {
    const prev = loadPlays().find((x) => x.id === track.id);
    const count = (Number(prev?.count) || 0) + 1;
    const next = [{ ...track, ts: Date.now(), count }, ...loadPlays().filter((x) => x.id !== track.id)].slice(0, 100);
    localStorage.setItem(PLAYS_KEY, JSON.stringify(next));
    renderPlays();
  } catch {}
  // Home's taste section is built from plays — a new one is new taste, so it
  // repaints here too.
  paintTaste();
  // SQLite song cache (best-effort): play counters survive localStorage
  // eviction and feed offline Recent / Most Played. Never blocks the UI.
  try {
    import("./store_db.js").then((m) => m.recordPlay(track).catch(() => {}));
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
    notifyLocalChange();
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
  // SQLite mirror so favorites survive localStorage eviction / reinstall.
  try {
    import("./store_db.js").then((m) => m.mirrorFav(track, on).catch(() => {}));
  } catch {}
  // Two-tier vault: a favorited song that is already saved gets re-saved at
  // the premium bitrate in the background. Songs that were never downloaded
  // are left alone — a heart must not start a download.
  if (on) promoteVaulted(track);
  return on;
}

/// Ask the backend to upgrade a saved song to the premium tier. Fire and
/// forget: the favorite heart is already saved, and a failed promotion leaves
/// the existing copy exactly as it was.
async function promoteVaulted(track) {
  try {
    const upgraded = await invoke("promote_song", { id: track.id });
    if (!upgraded) return;
    diag("vault", true, `promoted ${track.title} to 128 kbps`);
    toast(`"${track.title}" re-saved at 128 kbps.`, "success");
    refreshVault();
  } catch (err) {
    diag("vault", false, `promote ${track.id}: ${err}`);
  }
}

// ---------------------------------------------------------- entity favorites -
// Albums, artists and playlists heart into the same Library store the hero
// "Save to Library" button uses, tagged with a `kind` so Library can group
// them. Playlists keep their raw id (the tracks endpoint needs it); albums
// and artists key on token, prefixed so ids can never collide across kinds.
export function isEntityFav(kind = "playlist", key) {
  if (!key) return false;
  return loadLibrary().some(
    (x) => (x.kind || "playlist") === kind && (kind === "playlist" ? x.id === key : x.token === key),
  );
}

/// Toggle one entity; returns the new saved state. Metadata only — tracks
/// are fetched when the card is opened, exactly like every other save.
export function toggleEntityFav(ent) {
  const kind = ent.kind || "playlist";
  const key = String(ent.key || "");
  if (!key) return false;
  let lib = [];
  try {
    lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
  } catch {}
  const at = lib.findIndex(
    (x) => (x.kind || "playlist") === kind && (kind === "playlist" ? x.id === key : x.token === key),
  );
  let on;
  if (at >= 0) {
    lib.splice(at, 1);
    on = false;
  } else {
    lib.unshift(
      kind === "playlist"
        ? { id: key, title: ent.title || "Playlist", subtitle: ent.subtitle || "", image: ent.image || "" }
        : {
            kind,
            id: `${kind}:${key}`,
            token: key,
            title: ent.title || "",
            subtitle: ent.subtitle || "",
            image: ent.image || "",
            language: ent.language || "",
          },
    );
    on = true;
  }
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 100)));
  } catch {}
  return on;
}

/// One heart button, self-contained like `addBtn`: the delegated listener
/// below reads everything it needs off the element. Hidden until hover
/// unless already saved, so the state stays visible.
export function entFavBtn(kind, item) {
  const key = kind === "playlist" ? item.id : item.token || item.id;
  // Synthetic cards (Liked/Queue) are in-memory only, and a tokenless album
  // could never be reopened from Library — no heart either.
  if (item.synthetic || !key || (kind !== "playlist" && !item.token)) return "";
  const saved = isEntityFav(kind, key);
  const local = kind === "playlist" && !!item.local;
  const fill = saved ? ` style="font-variation-settings: 'FILL' 1;"` : "";
  return `<button type="button" data-ent-fav="1" data-ent-kind="${esc(kind)}" data-ent-key="${esc(key || "")}" data-ent-title="${esc(item.title || "")}" data-ent-sub="${esc(item.subtitle || "")}" data-ent-img="${esc(item.image || "")}"${item.language ? ` data-ent-lang="${esc(item.language)}"` : ""}${
    local ? ` data-ent-local="1"` : ""
  } title="${local ? "Already in your Library" : saved ? "Remove from Library" : "Save to Library"}" class="w-8 h-8 rounded-full bg-surface-container-lowest/90 backdrop-blur-md text-on-surface flex items-center justify-center shadow-md hover:scale-105 transition-all${
    saved ? "" : " opacity-0 group-hover:opacity-100"
  }"><span class="material-symbols-outlined text-[18px]"${fill}>favorite</span></button>`;
}

/// Capture phase: the heart sits inside a card that opens on click, so the
/// card's own handler must never see this event (same pattern as addBtn).
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest?.("[data-ent-fav]");
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    const kind = btn.dataset.entKind || "playlist";
    const title = btn.dataset.entTitle || "";
    if (btn.dataset.entLocal) {
      toast("This playlist already lives in your Library.", "info", 2200);
      return;
    }
    const on = toggleEntityFav({
      kind,
      key: btn.dataset.entKey,
      title,
      subtitle: btn.dataset.entSub,
      image: btn.dataset.entImg,
      language: btn.dataset.entLang || "",
    });
    const icon = btn.querySelector(".material-symbols-outlined");
    if (icon) icon.style.fontVariationSettings = on ? "'FILL' 1" : "'FILL' 0";
    btn.title = on ? "Remove from Library" : "Save to Library";
    renderLibrary();
    renderPlaylists();
    renderHomeAlbums();
    renderHomeArtists();
    paintFeatured();
    toast(on ? `Added "${title}" to Library.` : `Removed "${title}" from Library.`, on ? "success" : "info", 2200);
    diag("library", on, title);
  },
  true,
);

/// Library "Favorite Masters" section: play on row click, download + remove.
export function renderFavs() {
  const box = $("#library-favs");
  if (!box) return;
  const favs = uniqById(loadFavs());
  const count = $("#library-favs-count");
  if (count) count.textContent = `${favs.length} track${favs.length === 1 ? "" : "s"}`;
  if (!favs.length) {
    box.innerHTML =
      '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Nothing favorited yet — tap the heart on any track.</p>';
    return;
  }
  box.innerHTML = "";
  const favFrag = document.createDocumentFragment();
  favs.forEach((t, i) => {
    const row = document.createElement("div");
    row.dataset.rowI = String(i);
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate" dir="auto">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${metaLinks(t)}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-fav-next="${i}" title="Play next" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">skip_next</span>
        </button>
        <button type="button" data-fav-dl="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        <button type="button" data-fav-del="${i}" title="Remove from favorites" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" style="font-variation-settings: 'FILL' 1;">favorite</span>
        </button>
      </div>`;
    favFrag.appendChild(row);
  });
  box.appendChild(favFrag);
  // One delegated handler per paint instead of per row (review 4.2).
  box.onclick = (e) => {
    const row = e.target.closest("[data-row-i]");
    if (!row) return;
    const i = Number(row.dataset.rowI);
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
    const nx = e.target.closest("[data-fav-next]");
    if (nx) {
      e.stopPropagation();
      const t = favs[Number(nx.dataset.favNext)];
      if (t) {
        insertNext(t);
        toast(`"${t.title}" plays next.`, "success", 2200);
        diag("queue", null, `next: ${t.title}`);
      }
      return;
    }
    playTracksAt(favs, i);
  };
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
  const frag = document.createDocumentFragment();
  shown.forEach((t, i) => {
    const row = document.createElement("div");
    row.dataset.rowI = String(i);
    row.className =
      "flex items-center justify-between gap-4 px-4 py-4 hover:bg-surface-container-low transition-colors cursor-pointer group";
    row.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <span class="font-label-mono text-[11px] text-on-surface-variant w-5 text-right shrink-0">${i + 1}</span>
        <div class="w-24 h-24 rounded-lg overflow-hidden bg-surface-container-high shrink-0 shadow-sm">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(t.image || "")} />
        </div>
        <div class="min-w-0">
          <div class="font-body-md text-body-md font-semibold text-on-surface truncate" dir="auto">${esc(t.title || "")}</div>
          <div class="font-body-sm text-body-sm text-secondary truncate">${artistLinks(t.artist || "")}</div>
        </div>
      </div>
      <div class="flex items-center gap-3 shrink-0 font-label-mono text-label-mono text-secondary">
        <span class="hidden sm:inline">${esc(t.duration || "")}</span>
        <button type="button" data-next-idx="${i}" title="Play next" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">skip_next</span>
        </button>
        <button type="button" data-fav-idx="${i}" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]" data-fav-icon="${esc(t.id || "")}"${favFill(t.id || "")}>favorite</span>
        </button>
        <button type="button" data-dl-idx="${i}" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[17px]">download</span>
        </button>
        ${addBtn(t)}
        <span class="material-symbols-outlined text-[18px] opacity-0 group-hover:opacity-100">play_arrow</span>
      </div>`;
    frag.appendChild(row);
  });
  box.innerHTML = "";
  box.appendChild(frag);
  // One handler per paint (property assignment overwrites the last one)
  // instead of one closure per row — rows are rebuilt constantly, the box
  // is not (review 4.2).
  box.onclick = (e) => {
    const row = e.target.closest("[data-row-i]");
    if (!row) return;
    const i = Number(row.dataset.rowI);
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
    const nx = e.target.closest("[data-next-idx]");
    if (nx) {
      e.stopPropagation();
      const t = list[Number(nx.dataset.nextIdx)];
      if (t) {
        insertNext(t);
        toast(`"${t.title}" plays next.`, "success", 2200);
        diag("queue", null, `next: ${t.title}`);
      }
      return;
    }
    playTracksAt(list, i);
  };
}

export let pdTracks = [];
// Playlists screen: `pdVisible` is how much of the table is painted,
// `pdCurrentId`/`pdLocal` say which playlist owns it, `pdSeq` drops stale
// fetches. The hero (`plFeatured`) always shows the same playlist.
export let pdVisible = 0;
export let pdLocal = false;
export let pdCurrentId = "";
export let pdSeq = 0;
/// In-playlist filter box — "search within this playlist" (review 3.1).
export let pdQuery = "";
export const PD_FIRST = 30;
export let plFeatured = null;
/// Entries rendered by the last `renderPlaylists()` — card, tag and label.
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
/// Detail screens opened from inside another one — Back walks out of them.
export const ddStack = [];
export let ddCurrent = null;
/// The view Back lands on when the stack is empty (Home, Search, …).
export let ddReturnView = "home";
/// Bumped by every open so a stale response never paints over a newer screen.
export let ddSeq = 0;

// ------------------------------------------------- per-view language filter -
// Albums, playlists and charts can carry songs in several languages
// (`Track.language`, comma-separated when a song spans more than one). The
// picker defaults to "" (All) and only renders when the loaded list actually
// spans more than one language — single-language views look untouched.
// NOTE: local `trackLangs`/`langName` instead of settings.js `langLabel`:
// settings already imports this module, so importing it back would cycle.
// The LANGS table there labels every slug by capitalising it, which is
// exactly what `langName` does.
/** Selected language slug for the playlist/chart view ("" = All). */
export let pdLang = "";
/** Selected language slug for the album/artist detail view ("" = All). */
export let ddLang = "";

/// Slugs one track belongs to, lowercased: "Tamil, Hindi" -> ["tamil","hindi"].
export function trackLangs(t) {
  return String((t && t.language) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/// Display label for a slug — "telugu" -> "Telugu".
export function langName(slug) {
  return slug ? slug[0].toUpperCase() + slug.slice(1) : "";
}

/// Distinct slugs across a list, sorted, empty-language tracks ignored.
export function langsOf(list) {
  const set = new Set();
  for (const t of list || []) for (const l of trackLangs(t)) set.add(l);
  return [...set].sort();
}

export const matchLang = (t, lang) => !lang || trackLangs(t).includes(lang);

/// Every track the playlist view currently shows: search query AND language.
export function pdShownTracks() {
  return pdTracks.filter((t) => matchLang(t, pdLang) && matchQuery(t, pdQuery));
}

/// Every track the detail view currently shows: language only (no search box).
export function ddShownTracks() {
  return ddTracks.filter((t) => matchLang(t, ddLang));
}

const matchQuery = (t, q) =>
  !q || `${t.title || ""} ${t.artist || ""} ${t.album || ""}`.toLowerCase().includes(q);

export function setPdLang(lang) {
  pdLang = lang || "";
  pdVisible = PD_FIRST;
  paintPd();
}

export function setDdLang(lang) {
  ddLang = lang || "";
  ddVisible = DD_FIRST;
  renderDd();
}

/// Language chips above a track list. Renders `All (n)` plus one chip per
/// language with its count; hidden unless the list spans 2+ languages. The
/// container is created in place (before the track box) so no markup edit is
/// needed — single-language views never see it.
export function renderLangChips(boxId, buckets, counts, current, onPick) {
  const box = document.getElementById(boxId);
  if (!box || !box.parentElement) return;
  const wrapId = `${boxId}-lang`;
  let wrap = document.getElementById(wrapId);
  if (buckets.length < 2) {
    wrap?.classList.add("hidden");
    return;
  }
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = wrapId;
    wrap.className = "flex items-center gap-2 flex-wrap px-6 pt-4";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Filter by language");
    box.parentElement.insertBefore(wrap, box);
  }
  wrap.classList.remove("hidden");
  const total = counts.all || 0;
  const chip = (value, label, n) =>
    `<button type="button" data-lang-pick="${esc(value)}" title="${value ? `Show only ${esc(label)} songs` : "Show songs in every language"}" class="${value === current ? FILTER_ON : FILTER_OFF}">${esc(label)} (${n})</button>`;
  wrap.innerHTML =
    chip("", "All", total) + buckets.map((l) => chip(l, langName(l), counts[l] || 0)).join("");
  wrap.onclick = (e) => {
    const btn = e.target.closest("[data-lang-pick]");
    if (!btn) return;
    onPick(btn.dataset.langPick || "");
  };
}

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
  pdQuery = "";
  pdLang = "";
  const pdSearch = $("#pd-search");
  if (pdSearch) pdSearch.value = "";
  showView("playlists");
  paintFeatured();
  const detail = $("#playlist-detail");
  detail?.classList.remove("hidden");
  npText("pd-title", item.title || "Playlist");
  npText("pd-title-copy", item.title ? `• ${item.title}` : "");
  npText("pd-subtitle", item.subtitle || (pdLocal ? "Local playlist" : "Loading tracks…"));
  $("#pd-delete")?.classList.toggle("hidden", !item.local);
  // Save heart: remote playlists only — local + synthetic already live here.
  const pdFav = $("#pd-fav");
  pdFav?.classList.toggle("hidden", pdLocal || !!item.synthetic);
  const pdSaved = isEntityFav("playlist", pdCurrentId);
  const pdFavIcon = pdFav?.querySelector(".material-symbols-outlined");
  if (pdFavIcon) pdFavIcon.style.fontVariationSettings = pdSaved ? "'FILL' 1" : "'FILL' 0";
  if (pdFav) pdFav.title = pdSaved ? "Remove from Library" : "Save to Library";
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
    box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';
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
  npText("pd-subtitle", [item.subtitle, `${n} tracks`].filter(Boolean).join(" · "));
  paintPdRows();
  paintFeaturedMeta();
}

export function paintPdRows() {
  const box = $("#pd-tracks");
  if (!box) return;
  box.innerHTML = "";
  if (!pdTracks.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${
      pdLocal ? "No tracks yet — open any track elsewhere and hit the add button." : "That playlist has no tracks."
    }</p>`;
    $("#pd-foot")?.classList.add("hidden");
    return;
  }
  // Filtered view (search within playlist, language picker): show every
  // match; otherwise the incremental `pdVisible` window over the full list.
  const q = pdQuery;
  const lang = pdLang;
  const filtered = q || lang;
  const list = pdShownTracks();
  const buckets = langsOf(pdTracks);
  const counts = { all: pdTracks.length };
  for (const t of pdTracks) for (const l of trackLangs(t)) counts[l] = (counts[l] || 0) + 1;
  renderLangChips("pd-tracks", buckets, counts, lang, setPdLang);
  if (filtered && !list.length) {
    box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">${
      lang && !q
        ? `No ${langName(lang)} tracks in this playlist.`
        : `No tracks match "${esc(q)}".`
    }</p>`;
    $("#pd-foot")?.classList.remove("hidden");
    $("#pd-more")?.classList.add("hidden");
    npText("pd-showing", `0 of ${pdTracks.length} tracks match`);
    return;
  }
  const shown = filtered ? list : list.slice(0, pdVisible);
  const frag = document.createDocumentFragment();
  shown.forEach((t, i) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = trackRow(t, i, i === queueIndex && queue[queueIndex]?.track.id === t.id, "list");
    const row = wrap.firstElementChild;
    row.dataset.ri = String(i);
    frag.appendChild(row);
  });
  box.innerHTML = "";
  box.appendChild(frag);
  // Delegated, one handler per paint (review 4.2) — the visible list owns the rows.
  box.onclick = (e) => {
    const row = e.target.closest("[data-ri]");
    if (!row) return;
    const t = list[Number(row.dataset.ri)];
    if (!t) return;
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
    if (action === "queue" || action === "next") {
      e.stopPropagation();
      const where = action === "next" ? insertNext(t) : enqueue(t);
      toast(
        action === "next"
          ? `"${t.title}" plays next.`
          : `"${t.title}" queued at position ${where + 1}.`,
        "success",
        2200,
      );
      diag("queue", null, `${action}: ${t.title}`);
      return;
    }
    playTracksAt(list, Number(row.dataset.ri));
  };
  const left = filtered ? 0 : pdTracks.length - shown.length;
  $("#pd-foot")?.classList.toggle("hidden", !pdTracks.length);
  $("#pd-more")?.classList.toggle("hidden", !left);
  npText(
    "pd-showing",
    filtered
      ? `${shown.length} of ${pdTracks.length} tracks${lang ? ` in ${langName(lang)}` : ""}${q ? ` match "${q}"` : ""}`
      : `Showing ${shown.length} of ${pdTracks.length} tracks in playlist`,
  );
  npText("pd-more-label", `Load all ${pdTracks.length} tracks`);
}

/// Subtitle = whatever the card said + how much of the work is loaded.
export function paintDdSubtitle() {
  const loaded = ddTracks.length ? `${ddTracks.length} ${ddUnit}` : "";
  npText("dd-subtitle", [ddSubExtra, loaded].filter(Boolean).join(" · "));
}

/// The track list plus its "show/load more" bar, kept in step with each other.
/// A picked language narrows the rows, the counts and everything downstream
/// (play / shuffle / download) — but never the paging window itself, which
/// still walks the full catalogue behind the filter.
export function renderDd(emptyMsg) {
  const list = ddShownTracks();
  const buckets = langsOf(ddTracks);
  const counts = { all: ddTracks.length };
  for (const t of ddTracks) for (const l of trackLangs(t)) counts[l] = (counts[l] || 0) + 1;
  renderLangChips("dd-tracks", buckets, counts, ddLang, setDdLang);
  if (ddLang && !list.length) {
    const box = $("#dd-tracks");
    if (box)
      box.innerHTML = `<p class="font-body-sm text-body-sm text-on-surface-variant p-4">No ${langName(ddLang)} tracks in this ${ddCurrent?.kind || "album"}.</p>`;
  } else {
    trackRows(list, $("#dd-tracks"), emptyMsg, ddVisible);
  }
  npText(
    "dd-list-count",
    ddTracks.length
      ? ddLang
        ? `${list.length} of ${ddTracks.length} in ${langName(ddLang)}`
        : `${ddTracks.length} loaded`
      : "",
  );
  const wrap = $("#dd-more-wrap");
  if (!wrap) return;
  const left = Math.max(0, list.length - ddVisible);
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
  const shown = groupLangAlbums(ddReleaseList.filter((r) => ddFilter === "all" || r.kind === ddFilter));
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

/// One discography card — same tokens the album cards take, so a click opens
/// the release itself.
export function releaseCard(a) {
  const meta = [a.year, a.count ? `${a.count} track${a.count === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `
    <div data-dd-kind="album" data-dd-token="${esc(a.token || "")}" data-dd-title="${esc(a.title || "")}" data-dd-sub="${esc(a.subtitle || "")}" data-dd-img="${esc(a.image || "")}" class="p-3.5 rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col cursor-pointer">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-surface-container-high mb-2.5">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(a.image || "")} />
        <span class="absolute top-2 left-2">${entFavBtn("album", a)}</span>
        ${a.year ? `<span class="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-surface-container-lowest/90 backdrop-blur-md font-label-mono text-[9px] text-on-surface">${esc(a.year)}</span>` : ""}
        ${a.langCount > 1 ? `<span class="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white font-label-mono text-[9px] uppercase tracking-wider">${a.langCount} languages</span>` : ""}
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

/// Album / artist screen (the `detail` view) — token comes from the card.
/// Artists load in two streams: the songs (paged, so the whole catalogue is
/// walkable) and the header/discography (one call).
export async function openDetail(kind, item, opts = {}) {
  // Playlists never use the album/artist detail screen — they open on the
  // full Playlists overview, wherever they were clicked from.
  if (kind === "playlist") return openPlaylist(item);
  const isArtist = kind === "artist";
  if (opts.push && ddCurrent) ddStack.push(ddCurrent);
  else ddStack.length = 0;
  ddCurrent = { kind, item };
  // Save heart: albums + artists only (playlists route to the playlists screen).
  const ddFav = $("#dd-fav");
  ddFav?.classList.toggle("hidden", kind === "playlist");
  const ddSaved = isEntityFav(kind, item.token || item.id);
  const ddFavIcon = ddFav?.querySelector(".material-symbols-outlined");
  if (ddFavIcon) ddFavIcon.style.fontVariationSettings = ddSaved ? "'FILL' 1" : "'FILL' 0";
  if (ddFav) ddFav.title = ddSaved ? "Remove from Library" : "Save to Library";
  // Captured before the view switch: where Back lands once the stack is dry.
  const here = views.find((v) => !v.classList.contains("hidden"));
  if (!opts.push && here && here.dataset.view !== "detail") ddReturnView = here.dataset.view;
  // A second open while the first is in flight must not paint over it.
  const seq = ++ddSeq;
  showView("detail");
  npText("dd-kind", kind.toUpperCase());
  npText("dd-title", item.title || "—");
  npText("dd-subtitle", "Loading tracks…");
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
  ddLang = "";
  document.getElementById("dd-tracks-lang")?.classList.add("hidden");
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
  if (box) box.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant p-4">Loading tracks…</p>';

  if (!isArtist) {
    try {
      let raw;
      if (kind === "playlist") {
        raw = await invoke("playlist_tracks", { id: item.id });
      } else if (item.tokens && item.tokens.length > 1) {
        // Merged language-variant card: every sibling album in parallel
        // (bounded), merged — the language chips then offer each language.
        const tokens = [...new Set([item.token, ...item.tokens])].filter(Boolean).slice(0, 7);
        const pages = await Promise.allSettled(tokens.map((t) => invoke("album_tracks", { token: t })));
        raw = pages.flatMap((p) => (p.status === "fulfilled" ? p.value || [] : []));
        if (!raw.length) raw = await invoke("album_tracks", { token: item.token });
      } else {
        raw = await invoke("album_tracks", { token: item.token });
      }
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
  diag("artist", true, `${ddTracks.length} songs · ${ddReleases} releases`);
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
        <span class="absolute top-2 right-2 flex items-center gap-1.5">
          ${entFavBtn("playlist", p)}
          <button type="button" title="Open playlist" class="w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
        </span>
      </div>
      <div class="p-3.5 flex flex-col gap-1.5 min-w-0">
        <p class="font-body-md text-body-md font-semibold text-on-surface truncate" dir="auto">${esc(p.title || "")}</p>
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
        ${a.langCount > 1 ? `<span class="absolute top-2 left-2 px-2 py-1 rounded bg-black/70 text-white font-label-mono text-[9px] uppercase tracking-wider">${a.langCount} languages</span>` : ""}
        <span class="absolute top-2 right-2">${entFavBtn(kind, a)}</span>
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
        <span class="flex items-center gap-2">
          ${entFavBtn("playlist", c)}
          <span class="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center group-hover:scale-105 transition-transform"><span class="material-symbols-outlined text-[18px]">radio</span></span>
        </span>
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

/// The cards that only exist on this machine: what you hearted, whatever is
/// queued right now, your most-played of the last 30 days, and the hearts
/// with no vault copy yet. Recomputed on every renderPlaylists(), so counts
/// and rows are never stale (showView re-renders on each visit).
export function plSyntheticEntries() {
  const liked = loadFavs();
  const queued = queue.map((q) => q.track).filter(Boolean);
  const top = topPlayedTracks(loadPlays());
  const catchup = favsNotSaved(
    liked,
    (vaultEntries || []).map((e) => e.id),
  );
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
    {
      p: {
        id: "pl-top30",
        synthetic: "top30",
        title: "Top 50 · Last 30 Days",
        blurb: "Your most-played tracks of the last 30 days — rebuilt every visit.",
        count: top.length,
        icon: "trending_up",
        tracks: top,
      },
      tag: "Auto-generated",
      label: "Your Habits",
    },
    {
      p: {
        id: "pl-catchup",
        synthetic: "catchup",
        title: "Favourited, Not Downloaded",
        blurb: "Hearts with no offline copy yet — grab them before you go offline.",
        count: catchup.length,
        icon: "cloud_download",
        tracks: catchup,
      },
      tag: "Auto-generated",
      label: "Catch Up",
    },
  ];
}

export function plBuckets() {
  const feed = homeFeed || { playlists: [], charts: [] };
  // ponytail: created + saved playlists are Library-only (user's call) — the
  // Playlists screen is the JioSaavn feed plus the four auto-generated cards.
  return {
    synthetic: plSyntheticEntries(),
    curated: (feed.playlists || []).map((p) => ({ p, tag: "Curated", label: "" })),
    charts: (feed.charts || []).map((p) => ({ p, tag: "Chart", label: "Chart" })),
  };
}

export function plDedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.p.id) ? false : (seen.add(e.p.id), true)));
}

/// Chips, cards and the featured hero — one pass over the real sources.
export function renderPlaylists() {
  const box = $("#playlists-grid");
  if (!box) return;
  const b = plBuckets();
  const all = plDedupe([...b.synthetic, ...b.curated, ...b.charts]);
  const counts = {
    all: all.length,
    curated: b.curated.length,
    charts: b.charts.length,
  };
  const list = plFilter === "curated" ? b.curated : plFilter === "charts" ? b.charts : all;
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
  // auto-generated ones stay in the grid. Nothing open yet ? first in view.
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
  return [n ? `${n} tracks` : "", total].filter(Boolean).join(" · ");
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
// How many cards each Home shelf has revealed so far. A "More" button
// grows the counter and re-renders the same grid, so the row loads more
// in place instead of jumping to a separate browse screen.
let homeAlbumsShown = 4;
let homeArtistsShown = 3;
let homeChartsShown = 3;

export function resetHomeShelves() {
  homeAlbumsShown = 4;
  homeArtistsShown = 3;
  homeChartsShown = 3;
}

export function moreHomeAlbums() {
  if (!homeFeed) return;
  homeAlbumsShown = Math.min(homeFeed.albums.length, homeAlbumsShown + 4);
  renderHomeAlbums();
}
export function moreHomeArtists() {
  if (!homeFeed) return;
  homeArtistsShown = Math.min(homeFeed.artists.length, homeArtistsShown + 3);
  renderHomeArtists();
}
export function moreHomeCharts() {
  if (!homeFeed) return;
  homeChartsShown = Math.min(homeFeed.charts.length, homeChartsShown + 3);
  renderHomeStations();
}

export function renderHomeAlbums() {
  const box = $("#home-albums");
  if (!box || !homeFeed) return;
  const grouped = groupLangAlbums(homeFeed.albums);
  const shown = grouped.slice(0, homeAlbumsShown);
  box.innerHTML = shown.length ? shown.map((a) => ddCard("album", a)).join("") : GRID_EMPTY;
  const more = $("#home-releases-all");
  if (more) {
    const left = grouped.length - shown.length;
    more.classList.toggle("hidden", left <= 0);
    const lbl = more.querySelector("span");
    if (lbl) lbl.textContent = left > 0 ? `More Releases (${left})` : "View All Releases";
  }
}
export function renderHomeArtists() {
  const box = $("#home-artists");
  if (!box || !homeFeed) return;
  const shown = homeFeed.artists.slice(0, homeArtistsShown);
  box.innerHTML = shown.length ? shown.map((a) => ddCard("artist", a)).join("") : GRID_EMPTY;
  const more = $("#home-artists-all");
  if (more) {
    const left = homeFeed.artists.length - shown.length;
    more.classList.toggle("hidden", left <= 0);
    const lbl = more.querySelector("span");
    if (lbl) lbl.textContent = left > 0 ? `More Artists (${left})` : "View All Artists";
  }
}
export function renderHomeStations() {
  const box = $("#home-stations");
  if (!box || !homeFeed) return;
  const shown = homeFeed.charts.slice(0, homeChartsShown);
  box.innerHTML = shown.length ? shown.map(stationCard).join("") : GRID_EMPTY;
  const more = $("#home-charts-more");
  if (more) {
    const left = homeFeed.charts.length - shown.length;
    more.classList.toggle("hidden", left <= 0);
    const lbl = more.querySelector("span");
    if (lbl) lbl.textContent = left > 0 ? `More Charts (${left})` : "More Charts";
  }
}
export function renderHomeDaily() {
  const box = $("#home-daily");
  if (!box || !homeFeed) return;
  const items = homeFeed.daily || [];
  box.innerHTML = items.length
    ? items
        .map(
          (p, i) => `
    <div data-daily-index="${i}" class="p-3.5 rounded-lg bg-surface-container-lowest border border-surface-container-highest/60 shadow-sm hover:shadow-md transition-all group flex flex-col justify-between cursor-pointer">
      <div>
        <div class="relative aspect-square rounded overflow-hidden bg-surface-container-high mb-3">
          <img alt="" loading="lazy" class="w-full h-full object-cover" ${art(p.image)} />
          <div class="absolute inset-0 bg-gradient-to-t from-primary/90 to-primary/30 flex flex-col justify-end p-3">
            <span class="font-label-mono text-[9px] uppercase tracking-wider text-on-primary/80">Fresh today</span>
            <span class="font-headline-md text-on-primary font-semibold text-[16px] leading-tight" dir="auto">${esc(p.title)}</span>
          </div>
          <button type="button" data-daily-play="${i}" title="Play this playlist" class="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface-container-lowest text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md">
            <span class="material-symbols-outlined text-[18px]">play_arrow</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-secondary line-clamp-2">${esc(p.subtitle)}</p>
      </div>
      <div class="mt-3 pt-2 border-t border-surface-container-high flex items-center justify-between text-on-surface-variant font-label-mono text-[10px]">
        <span>${p.count ? `${p.count} Tracks` : "Daily mix"}</span>
        <span>${p.subtitle ? esc(p.subtitle) : "Daily"}</span>
      </div>
    </div>`,
        )
        .join("")
    : GRID_EMPTY;
}
export function renderLibrary() {
  const box = $("#library-saved");
  if (!box) return;
  const lib = uniqById(loadLibrary());
  // Groups: playlists (created + saved) stay their own section; albums/movies
  // and artists get theirs, each opening its complete detail view on click.
  const pls = lib.filter((p) => !p.kind || p.kind === "playlist");
  const albums = groupLangAlbums(lib.filter((p) => p.kind === "album"));
  const artists = lib.filter((p) => p.kind === "artist");
  box.innerHTML = pls.length
    ? pls
        .map((p) => plCard(p, p.local ? "Local" : "Saved", p.local ? "Local" : "In Library"))
        .join("")
    : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet — hit “Save to Library” on Home.</p>';
  const abox = $("#library-albums");
  if (abox)
    abox.innerHTML = albums.length
      ? albums.map((a) => ddCard("album", a)).join("")
      : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet — tap the heart on any album or movie.</p>';
  const artbox = $("#library-artists");
  if (artbox)
    artbox.innerHTML = artists.length
      ? artists.map((a) => ddCard("artist", a)).join("")
      : '<p class="font-body-sm text-body-sm text-on-surface-variant">Nothing saved yet — tap the heart on any artist.</p>';
  npText("library-albums-count", `${albums.length} saved`);
  npText("library-artists-count", `${artists.length} saved`);
}
export function renderPlays() {
  const plays = uniqById(loadPlays());
  const count = $("#history-count");
  if (count) count.textContent = `${plays.length} session${plays.length === 1 ? "" : "s"}`;
  trackRows(plays, $("#history-plays"), "Nothing played yet.");
  trackRows(plays.slice(0, 5), $("#library-recent"), "No plays yet.");
}

// Click wiring — one delegated listener per grid.
// Every playlist click — local or server — lands on the Playlists overview
// screen (hero + grid + track table), never the generic detail view.
export function openPlaylistElsewhere(item) {
  return openPlaylist(item);
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
    // Merged language-variant card: carry every variant token so the detail
    // loads all languages, not just the first.
    if (card.dataset.ddKind !== "playlist") {
      const v = variantsFor(item.token);
      if (v) item.tokens = v.map((x) => x.token);
    }
    // No token (payload oddity) ? fall back to a real search instead of dead click.
    if (!item.token) {
      doSearch({ query: item.title || "" });
      return;
    }
    openDetail(card.dataset.ddKind, item);
  });
}
wireDdGrid("#home-albums");
wireDdGrid("#home-artists");
// "Most Listened" → the albums this listener already has a relationship with.
wireDdGrid("#home-jump-albums");
// Library groups: albums/movies and artists open their complete detail view.
wireDdGrid("#library-albums");
wireDdGrid("#library-artists");
// The search grid holds whichever card type the active chip selected.
wireDdGrid("#results");
wirePlGrid("#results");

// ------------------------------------------------------- playlists screen -
$("#pd-search")?.addEventListener("input", (e) => {
  pdQuery = e.target.value.toLowerCase().trim();
  paintPdRows();
});
$("#pd-play")?.addEventListener("click", () => {
  const list = pdShownTracks();
  if (list.length) playTracksAt(list, 0);
});
$("#pd-shuffle")?.addEventListener("click", () => {
  if (!pdTracks.length) return;
  pdTracks = shuffled(pdTracks);
  pdVisible = Math.min(PD_FIRST, pdTracks.length);
  paintPdRows();
  setShuffleMode(true);
  paintModes();
  const list = pdShownTracks();
  if (list.length) playTracksAt(list, 0);
});
$("#pd-back")?.addEventListener("click", () => $("#playlist-detail")?.classList.add("hidden"));
$("#pd-download")?.addEventListener("click", () => {
  // Running batches turn this same button into Stop (vault.js keeps it
  // enabled for exactly this). The download honours the language picker, so
  // a Tamil selection fetches only the Tamil tracks.
  if (dlBatch) {
    stopBatch();
    return;
  }
  const list = pdShownTracks();
  if (!list.length) return;
  downloadAll(list, "playlist tracks", $("#pd-download"));
});
$("#pd-more")?.addEventListener("click", () => {
  pdVisible = pdTracks.length;
  paintPdRows();
});
$("#pd-fav")?.addEventListener("click", () => {
  const p = plFeatured?.p;
  if (!p || !p.id || p.synthetic || pdLocal) return;
  const on = toggleEntityFav({ kind: "playlist", key: p.id, title: p.title, subtitle: p.subtitle, image: p.image });
  const icon = $("#pd-fav .material-symbols-outlined");
  if (icon) icon.style.fontVariationSettings = on ? "'FILL' 1" : "'FILL' 0";
  $("#pd-fav").title = on ? "Remove from Library" : "Save to Library";
  renderLibrary();
  renderPlaylists();
  paintFeatured();
  toast(on ? "Saved to Library" : "Removed from Library", on ? "success" : "info", 2200);
  diag("library", on, p.title);
});
$("#pd-delete")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const name = plFeatured?.p.title;
  if (!pdCurrentId || !name) return;
  // Two clicks instead of a native confirm() — webviews do not all have one.
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
$("#pl-back")?.addEventListener("click", () => backView("library"));

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
  const v = variantsFor(item.token);
  if (v) item.tokens = v.map((x) => x.token);
  if (!item.token) {
    doSearch({ query: item.title || "" });
    return;
  }
  openDetail(card.dataset.ddKind || "album", item, { push: true });
});

$("#dd-play")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  const list = ddShownTracks();
  if (list.length) playTracksAt(list, 0);
});
$("#dd-download")?.addEventListener("click", async () => {
  // A running batch turns this same button into Stop (vault.js keeps it
  // enabled for exactly this) — checked before the track load so the halt
  // is instant even on a huge artist catalogue.
  if (dlBatch) {
    stopBatch();
    return;
  }
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  // Paging may have introduced new languages — repaint the chips before the
  // picker is consulted.
  renderDd();
  const kind = ddCurrent?.kind || "album";
  // The download honours the language picker, so a Tamil selection on a
  // multi-language album fetches only the Tamil tracks.
  const list = ddShownTracks();
  if (!list.length) return;
  downloadAll(list, kind === "artist" ? "artist songs" : `${kind} tracks`, $("#dd-download"));
});
$("#dd-fav")?.addEventListener("click", () => {
  const cur = ddCurrent;
  if (!cur || cur.kind === "playlist") return;
  const item = cur.item;
  const on = toggleEntityFav({
    kind: cur.kind,
    key: item.token || item.id,
    title: item.title,
    subtitle: item.subtitle,
    image: item.image,
  });
  const icon = $("#dd-fav .material-symbols-outlined");
  if (icon) icon.style.fontVariationSettings = on ? "'FILL' 1" : "'FILL' 0";
  $("#dd-fav").title = on ? "Remove from Library" : "Save to Library";
  renderLibrary();
  renderHomeAlbums();
  renderHomeArtists();
  toast(on ? `Added "${item.title}" to Library.` : `Removed "${item.title}" from Library.`, on ? "success" : "info", 2200);
  diag("library", on, item.title);
});
$("#dd-shuffle")?.addEventListener("click", async () => {
  if (!ddTracks.length) return;
  if (ddMore && !(await loadAllArtistSongs())) return;
  ddTracks = shuffled(ddTracks);
  ddVisible = ddTracks.length;
  renderDd();
  setShuffleMode(true);
  paintModes();
  const list = ddShownTracks();
  if (list.length) playTracksAt(list, 0);
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
  npText("dd-more-label", "Loading…");
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
  else backView(ddReturnView || "home");
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
