// app.js — boot + global click delegation + widget player paint for the mobile shell.
import { invoke, load, save, store, hooks, go, toast, toggleFav, paintFavs, downloadTrack, paintArt, HISTORY_KEY, checkForUpdates, AUTOUPDATE_KEY, pushEvent, refreshVault } from "./shared.js";
import { playList, playPlaylist, toggle, onPaint, playerState, prev, next, seek, cycleRepeat, repaint } from "./player.js";
import { startNet, netMode } from "./net.js";
import { MOUNT, openLib, entityNav } from "./binders.js";
import { isMenuTrigger, handleMenuTrigger } from "./menus.js";

document.addEventListener("smount", async (e) => {
  syncWidget(playerState()); // route changed: re-gate the floating bar first
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
    if (netMode() === "offline") return toast("You're offline — that lookup needs a network", 4000, "error");
    toast(`Could not look up that ${kind}`, 4000, "error");
  }
}

async function removeDownload(path) {
  if (!invoke || !path) return;
  try {
    await invoke("remove_download", { path });
    refreshVault(); // an evicted file must leave the offline gate immediately
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
  // ---- persistent widget player (the desktop card, ported to Android) ----
  const wToggle = el("[data-w-toggle]");
  if (wToggle) {
    toggle();
    return;
  }
  const wPrev = el("[data-w-prev]");
  if (wPrev) {
    prev();
    return;
  }
  const wNext = el("[data-w-next]");
  if (wNext) {
    next();
    return;
  }
  const wRepeat = el("[data-w-repeat]");
  if (wRepeat) {
    cycleRepeat();
    return;
  }
  const wFav = el("[data-w-fav]");
  if (wFav) {
    const tr = playerState().track;
    if (tr) toggleFav(tr);
    return;
  }
  const wSeek = el("[data-w-seek]");
  if (wSeek) {
    const st = playerState();
    if (st.dur > 0) {
      const r = wSeek.getBoundingClientRect();
      if (r.width > 0) seek(((e.clientX - r.left) / r.width) * st.dur);
    }
    return;
  }
  const wOpen = el("[data-w-open]");
  if (wOpen) {
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

// ---------------------------------------------------------------- widget player
// The desktop floating card (widget.html) rebuilt as an Android always-on
// control: art, title/artist, prev/play/next/repeat/fav + a click-to-seek
// rail. The design's per-screen mini-player markup is hidden — one player on
// every screen except NowPlaying, which owns the full transport.
function ensureWidget() {
  if (document.getElementById("tm-widget")) return;
  const hide = document.createElement("style");
  hide.textContent = `#screen [class*="fixed bottom-16"]{display:none!important}`;
  document.head.appendChild(hide);
  const host = document.createElement("div");
  host.innerHTML = `<div id="tm-widget" class="fixed bottom-16 inset-x-0 z-40 px-gutter pointer-events-none pb-safe hidden">
    <div class="pointer-events-auto bg-surface-container-lowest/95 backdrop-blur-xl rounded-xl overflow-hidden shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
      <div data-w-seek role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" class="h-1 bg-surface-container-high cursor-pointer"><div id="tm-w-fill" class="h-full bg-primary rounded-full" style="width:0%"></div></div>
      <div class="flex items-center gap-space-sm p-space-sm">
        <div class="w-11 h-11 rounded-lg bg-surface-container-highest flex-shrink-0 overflow-hidden"><img id="tm-w-art" alt="" class="w-full h-full object-cover"></div>
        <div class="flex flex-col min-w-0 flex-1 cursor-pointer" data-w-open>
          <span id="tm-w-title" class="font-label-md text-label-md text-on-surface font-medium truncate">Nothing playing</span>
          <span id="tm-w-artist" class="font-label-sm text-label-sm text-secondary truncate"></span>
        </div>
        <div class="flex items-center flex-shrink-0">
          <button type="button" data-w-fav aria-label="Favorite" class="w-9 h-9 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]" data-fav-icon></span></button>
          <button type="button" data-w-prev aria-label="Previous" class="w-9 h-9 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[20px]">skip_previous</span></button>
          <button type="button" data-w-toggle aria-label="Play" class="w-11 h-11 rounded-full bg-primary text-on-primary flex items-center justify-center active:scale-95 transition-transform"><span id="tm-w-playicon" class="material-symbols-outlined text-[22px]">play_arrow</span></button>
          <button type="button" data-w-next aria-label="Next" class="w-9 h-9 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[20px]">skip_next</span></button>
          <button type="button" data-w-repeat aria-label="Repeat" class="w-9 h-9 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span id="tm-w-repeaticon" class="material-symbols-outlined text-[18px]">repeat</span></button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(host.firstElementChild);
}
ensureWidget();

/// NowPlaying owns the full transport, so the floating bar must not paint
/// over it. Keyed off the hash (same normalization as router.js) rather than
/// the smount event, so a navigation that never repaints still gates correctly.
function onNowPlaying() {
  var raw = location.hash.replace(/^#\/?/, "");
  var qi = raw.indexOf("?");
  return (qi >= 0 ? raw.slice(0, qi) : raw).toLowerCase() === "nowplaying";
}

function syncWidget(st) {
  const w = document.getElementById("tm-widget");
  if (!w) return null;
  w.classList.toggle("hidden", !st || !st.track || onNowPlaying());
  return w;
}

onPaint((st) => {
  const w = syncWidget(st);
  if (!w) return;
  if (!st.track || onNowPlaying()) return;
  const t = st.track;
  const title = w.querySelector("#tm-w-title");
  if (title && t.title) title.textContent = t.title;
  const artist = w.querySelector("#tm-w-artist");
  if (artist) artist.textContent = t.artist || "";
  const img = w.querySelector("#tm-w-art");
  if (img && t.image) paintArt(img, t.image);
  const fill = w.querySelector("#tm-w-fill");
  if (fill) fill.style.width = `${st.dur > 0 ? Math.min(100, (st.pos / st.dur) * 100) : 0}%`;
  const seekEl = w.querySelector("[data-w-seek]");
  if (seekEl) seekEl.setAttribute("aria-valuenow", String(st.dur > 0 ? Math.round((st.pos / st.dur) * 100) : 0));
  const icon = w.querySelector("#tm-w-playicon");
  if (icon) icon.textContent = st.paused ? "play_arrow" : "pause";
  const btn = w.querySelector("[data-w-toggle]");
  if (btn) btn.setAttribute("aria-label", st.paused ? "Play" : "Pause");
  const rep = w.querySelector("#tm-w-repeaticon");
  if (rep) {
    rep.textContent = st.repeat === 2 ? "repeat_one" : "repeat";
    rep.style.fontVariationSettings = `'FILL' ${st.repeat ? 1 : 0}`;
    rep.classList.toggle("text-primary", !!st.repeat);
  }
  const fav = w.querySelector("[data-w-fav] .material-symbols-outlined");
  if (fav) fav.dataset.favIcon = t.id || "";
  paintFavs();
});

if (invoke) {
  invoke("proxy_base")
    .then((base) => {
      window.__tmBase = typeof base === "string" ? base : "";
    })
    .catch(() => {});
  // Warm the vault ledger for the offline gate (cached ids answer instantly
  // on a no-network boot; this refreshes them from the local SQLite file).
  refreshVault();
  // Connection state machine: probes via net_ping, drives the banner, the
  // offline skip-gate and the "Back online" toasts.
  startNet({
    invoke,
    toast,
    onMode: () => repaint(),
  });
} else {
  console.warn("Tauri IPC unavailable — mobile backend disabled");
}

if (invoke && String(load(AUTOUPDATE_KEY, "1")) === "1") {
  // Fire-and-forget on boot: daily cadence lives inside checkForUpdates, and a
  // failed check must never hold up first paint.
  checkForUpdates(true).catch(() => {});
}

// Seed the Notifications feed once so it is not an empty box on first run.
if (!load("tm-welcomed", 0)) {
  save("tm-welcomed", 1);
  pushEvent("system", "Welcome to REON", "Download results, update notices and backup events appear in Notifications.");
}
