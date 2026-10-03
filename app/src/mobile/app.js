// app.js — boot + global click delegation + mini-player paint for the mobile shell.
import { invoke, load, save, store, hooks, go, toast, toggleFav, paintFavs, downloadTrack, paintArt, badgeLabel, HISTORY_KEY, checkForUpdates, AUTOUPDATE_KEY } from "./shared.js";
import { playList, playPlaylist, toggle, onPaint, playerState } from "./player.js";
import { MOUNT, openLib, entityNav } from "./binders.js";
import { isMenuTrigger, handleMenuTrigger } from "./menus.js";

document.addEventListener("smount", async (e) => {
  const fn = MOUNT[e.detail.dir];
  if (!fn) return;
  try {
    await fn(e.detail.query);
  } catch (err) {
    console.error(err);
    toast(String(err).slice(0, 120), 5000, "error");
  }
});

/// Name -> entity page: the row/NowPlaying artist taps. Mirror of the menus'
/// viewAlbum/goToArtist resolvers, keyed by name instead of a track.
async function resolveEntity(kind, name) {
  if (!invoke || !name) return;
  const query = kind === "artist" ? name.split(",")[0].trim() : name;
  try {
    const r = await invoke("search_entities", { query, kind, limit: 8, page: 1 });
    const items = (r && r.items) || [];
    const want = query.toLowerCase();
    const hit = items.find((x) => String(x.title || "").toLowerCase() === want) || items[0];
    if (!hit || !(hit.token || hit.id)) return toast(`No ${kind} found for “${query}”`, 4000, "error");
    go(entityNav(kind, hit));
  } catch (e) {
    console.error(e);
    toast(`Could not look up that ${kind}`, 4000, "error");
  }
}

async function removeDownload(path) {
  if (!invoke || !path) return;
  try {
    await invoke("remove_download", { path });
    toast("Removed from vault", 3200, "success");
    hooks.repaintDownload?.();
  } catch (e) {
    console.error(e);
    toast(`Could not remove: ${String(e).split("\n")[0].slice(0, 80)}`, 5000, "error");
  }
}

document.addEventListener("click", (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const el = (sel) => t.closest(sel);

  const qdel = el("[data-qdel]");
  if (qdel) {
    const hist = load(HISTORY_KEY, []);
    hist.splice(+qdel.dataset.qdel, 1);
    save(HISTORY_KEY, hist);
    hooks.repaintBay?.();
    return;
  }
  const q = el("[data-q]");
  if (q) {
    go(`search?q=${encodeURIComponent(q.dataset.q)}`);
    return;
  }
  const miniT = el("[data-mini-toggle]");
  if (miniT) {
    toggle();
    return;
  }
  const miniFav = el("[data-mini-fav]");
  if (miniFav) {
    const tr = playerState().track;
    if (tr) toggleFav(tr);
    return;
  }
  const miniO = el("[data-mini-open]");
  if (miniO) {
    go("nowplaying");
    return;
  }
  const nav = el("[data-nav]");
  if (nav) {
    go(nav.dataset.nav);
    return;
  }
  // Artist/album names inside rows and NowPlaying jump to that entity. It
  // must run before the row-play fallback below so a name tap never starts
  // playback (the spans are siblings of fav/dl/kebab, so those stay clear).
  const ent = el("[data-entity-name]");
  if (ent) {
    const name = ent.textContent.trim();
    if (name) {
      resolveEntity(ent.dataset.entityKind || "artist", name);
      return;
    }
  }
  const libi = el("[data-libi]");
  if (libi) {
    openLib(store.lib?.[+libi.dataset.libi]);
    return;
  }
  const rm = el("[data-rm]");
  if (rm) {
    removeDownload(rm.dataset.rm);
    return;
  }
  const fav = el("[data-fav]");
  if (fav) {
    const row = fav.closest("[data-list][data-idx]");
    const track = row && store[row.dataset.list]?.[+row.dataset.idx];
    if (track) toggleFav(track);
    return;
  }
  const dl = el("[data-dl]");
  if (dl) {
    const row = dl.closest("[data-list][data-idx]");
    const track = row && store[row.dataset.list]?.[+row.dataset.idx];
    if (track) downloadTrack(track, dl);
    return;
  }
  const plPlay = el("[data-pl-play]");
  if (plPlay) {
    // A playlist/chart Play control: load its track list before opening
    // NowPlaying, since playList() needs songs, not a playlist id.
    go("nowplaying");
    playPlaylist(plPlay.dataset.plPlay);
    return;
  }
  // Three-dot triggers resolve their own target (row, NowPlaying, header,
  // placeholder row) and must run before the row-play fallback below, so a
  // kebab tap never starts playback.
  const kebab = t.closest("button");
  if (kebab && isMenuTrigger(kebab)) {
    handleMenuTrigger(kebab);
    return;
  }
  const row = el("[data-list][data-idx]");
  if (row) {
    const list = store[row.dataset.list];
    if (list) {
      playList(list, +row.dataset.idx || 0);
      // Tapping a track opens the NowPlaying screen (no-op when already there).
      go("nowplaying");
    }
  }
});

onPaint((st) => {
  const mini = document.querySelector('#screen [class*="fixed bottom-16"]');
  if (!mini) return;
  const t = st.track;
  // The design mini-player titles use font-label-md on some screens and
  // font-headline-md on others; match either.
  const title = mini.querySelector("span.font-label-md, span.font-headline-md");
  if (title && t && t.title) title.textContent = t.title;
  const artist = mini.querySelector("span.font-body-sm");
  if (artist && t && t.artist) artist.textContent = t.artist;
  const img = mini.querySelector("img");
  if (img && t && t.image) paintArt(img, t.image);
  const bd = mini.querySelector("span.font-label-mono");
  if (bd) {
    if (bd.dataset.badgeIdle === undefined) bd.dataset.badgeIdle = bd.textContent;
    bd.textContent = badgeLabel(st.badge, bd.dataset.badgeIdle);
  }
  const btn = mini.querySelector('[aria-label="Pause"], [aria-label="Play"]');
  if (btn) {
    btn.dataset.miniToggle = "1";
    const icon = btn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = st.paused ? "play_arrow" : "pause";
    btn.setAttribute("aria-label", st.paused ? "Play" : "Pause");
  }
  const fav = mini.querySelector('[aria-label="Favorite"]');
  if (fav && t) {
    fav.dataset.miniFav = "1";
    const icon = fav.querySelector(".material-symbols-outlined");
    if (icon) icon.dataset.favIcon = t.id || "";
  }
  const open = mini.querySelector(".cursor-pointer");
  if (open) open.dataset.miniOpen = "1";
  paintFavs();
});

if (invoke) {
  invoke("proxy_base")
    .then((base) => {
      window.__tmBase = typeof base === "string" ? base : "";
    })
    .catch(() => {});
} else {
  console.warn("Tauri IPC unavailable — mobile backend disabled");
}

if (invoke && String(load(AUTOUPDATE_KEY, "1")) === "1") {
  // Fire-and-forget on boot: daily cadence lives inside checkForUpdates, and a
  // failed check must never hold up first paint.
  checkForUpdates(true).catch(() => {});
}
