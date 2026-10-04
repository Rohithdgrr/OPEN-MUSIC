// app.js — boot + global click delegation + widget player paint for the mobile shell.
import { invoke, load, save, store, hooks, go, toast, toggleFav, paintFavs, downloadTrack, paintArt, isVaulted, pushDiag, HISTORY_KEY, checkForUpdates, AUTOUPDATE_KEY, pushEvent, refreshVault, haptic, isOnboarded, setOnboarded, saveTaste, LANG_KEY } from "./shared.js";
import { playList, playPlaylist, toggle, onPaint, playerState, prev, next, seek, cycleRepeat, toggleShuffle, repaint, enqueue, audio } from "./player.js";
import { startNet, netMode } from "./net.js";
import { PRESETS, arm as armSleep } from "../sleep.js";
import { MOUNT, openLib, entityNav } from "./binders.js";
import { isMenuTrigger, handleMenuTrigger, trackMenu } from "./menus.js";
import "./native.js"; // Android media surfaces: notification, lockscreen, widget, headset/car
import "./ux.js"; // Spotify-feel gestures: tab swipe, queue drag, mini-art tap, transitions
import "./homeplus.js"; // Personal Home: streaks + new-from-follows
import "./audioplus.js"; // Crossfade UI + per-track EQ sheet
import "./collab.js"; // Shared playlists: export/import without accounts

const onSmount = async (e) => {
  syncWidget(playerState()); // route changed: re-gate the floating bar first
  const fn = MOUNT[e.detail.dir];
  if (!fn) return;
  try {
    await fn(e.detail.query);
  } catch (err) {
    console.error(err);
    toast(String(err).slice(0, 120), 5000, "error");
  }
};
document.addEventListener("smount", onSmount);
// The router can paint the first screen before this deferred module runs —
// that mount was queued, not dispatched (see router.js). Flush it once.
window.__tmAppReady = true;
const pendingSmount = window.__tmPendingSmount;
if (pendingSmount) {
  window.__tmPendingSmount = null;
  onSmount({ detail: pendingSmount });
}

/// Step the sleep timer to its next preset, wrapping back to Off. The button
/// carries the current preset in `data-sleep`, so the state survives a route
/// change without another store.
function sleepNext(current) {
  const i = PRESETS.indexOf(Number(current));
  return PRESETS[(i + 1) % PRESETS.length];
}

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
    try {
      haptic(10);
    } catch {}
    toggle();
    return;
  }
  const miniFav = el("[data-mini-fav]");
  if (miniFav) {
    const tr = playerState().track;
    if (tr) toggleFav(tr);
    return;
  }
  // Sleep timer: one button cycles Off → 15 → 30 → 60 → 90 min. The shared
  // sleep.js does the fade + pause, so only the stepping lives here.
  const sleepBtn = el("[data-sleep]");
  if (sleepBtn) {
    const mins = sleepNext(sleepBtn.dataset.sleep);
    sleepBtn.dataset.sleep = mins;
    const total = armSleep(mins, audio, ({ done }) => {
      if (!done) return;
      sleepBtn.dataset.sleep = "0";
      toast("Sleep timer — playback stopped.", 4000);
    });
    if (!total) toast("Sleep timer off.", 2500);
    else toast(`Sleep timer: stops in ${mins} min.`, 3000);
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
    try {
      haptic(10);
    } catch {}
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
  const wShuffle = el("[data-w-shuffle]");
  if (wShuffle) {
    toggleShuffle();
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

// ------------------------------------------------- row gestures (touch only)
// Long-press (>500ms) on a track row opens its menu; swipe-left enqueues it.
// Both swallow the tap-click that follows so a gesture never starts playback
// via the row-play fallback above. Controls (buttons/links) keep their taps.
let lpTimer = 0;
let lpFired = false;
let swipeFired = false;
let gx0 = 0;
let gy0 = 0;
let gRow = null;

document.addEventListener(
  "touchstart",
  (e) => {
    gRow = null;
    swipeFired = false;
    lpFired = false;
    clearTimeout(lpTimer);
    const t = e.touches && e.touches[0];
    const row = e.target && e.target.closest ? e.target.closest("[data-list][data-idx]") : null;
    if (!t || !row) return;
    if (e.target.closest("button, a, input, textarea")) return;
    gRow = row;
    gx0 = t.clientX;
    gy0 = t.clientY;
    lpTimer = setTimeout(() => {
      if (!gRow) return;
      lpFired = true;
      const list = store[gRow.dataset.list];
      const track = list && list[+gRow.dataset.idx || 0];
      if (track) {
        try {
          haptic(10);
        } catch {}
        trackMenu(track, null);
      }
    }, 500);
  },
  { passive: true },
);

document.addEventListener(
  "touchmove",
  (e) => {
    if (!gRow || lpFired) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    // A scroll or swipe cancels the long-press; the swipe detector owns it.
    if (Math.abs(t.clientX - gx0) > 12 || Math.abs(t.clientY - gy0) > 12) clearTimeout(lpTimer);
  },
  { passive: true },
);

document.addEventListener(
  "touchend",
  (e) => {
    clearTimeout(lpTimer);
    if (!gRow) return;
    const t = e.changedTouches && e.changedTouches[0];
    const row = gRow;
    gRow = null;
    if (!t || lpFired) return;
    const dx = t.clientX - gx0;
    const dy = t.clientY - gy0;
    if (dx < -70 && Math.abs(dx) > Math.abs(dy) * 2) {
      const list = store[row.dataset.list];
      const track = list && list[+row.dataset.idx || 0];
      if (track && track.id) {
        swipeFired = true;
        try {
          haptic(15);
        } catch {}
        enqueue(track);
        toast(`“${track.title || "track"}” added to queue`);
      }
    }
  },
  { passive: true },
);

document.addEventListener(
  "touchcancel",
  () => {
    clearTimeout(lpTimer);
    gRow = null;
  },
  { passive: true },
);

// A gesture is followed by one synthetic click on the row — eat exactly that
// click so a long-press/swipe never starts playback. Capture phase runs before
// the bubble delegation above, so stopPropagation() silences the row fallback.
document.addEventListener(
  "click",
  (e) => {
    const eat = lpFired || swipeFired;
    lpFired = false;
    swipeFired = false;
    if (!eat) return;
    if (e.target && e.target.closest && e.target.closest("[data-list][data-idx]")) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// ---------------------------------------------------------------- widget player
// The desktop floating card (widget.html) rebuilt as an Android always-on
// control: art, title/artist, prev/play/next/shuffle/repeat/fav + a
// click-to-seek rail with buffered fill. The design's per-screen mini-player
// markup is hidden — one player on every screen except NowPlaying, which owns
// the full transport.
function ensureWidget() {
  if (document.getElementById("tm-widget")) return;
  const hide = document.createElement("style");
  hide.textContent = `#screen [class*="fixed bottom-16"]{display:none!important}`;
  document.head.appendChild(hide);
  const host = document.createElement("div");
  host.innerHTML = `<div id="tm-widget" class="fixed bottom-[70px] inset-x-2.5 sm:inset-x-4 z-40 pointer-events-none pb-safe hidden max-w-lg mx-auto">
    <div class="pointer-events-auto bg-surface-container-lowest/95 backdrop-blur-2xl rounded-2xl overflow-hidden shadow-[0_12px_36px_-6px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.04)] border border-surface-container-high/80">
      <div data-w-seek role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" class="relative h-1.5 bg-surface-container-high/70 cursor-pointer touch-none"><div id="tm-w-buf" class="absolute inset-y-0 left-0 bg-surface-container-highest rounded-full transition-all duration-150" style="width:0%"></div><div id="tm-w-fill" class="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-75" style="width:0%"></div></div>
      <div class="flex items-center gap-2 px-2.5 py-1.5">
        <div class="relative w-11 h-11 rounded-xl bg-surface-container-highest flex-shrink-0 overflow-hidden shadow-sm ring-1 ring-black/5" data-w-open><img id="tm-w-art" alt="" class="w-full h-full object-cover"><span id="tm-w-vault" class="hidden absolute bottom-0.5 left-0.5 w-4 h-4 rounded-full bg-emerald-500 text-white items-center justify-center text-[10px] leading-none">⬇</span></div>
        <div class="flex flex-col min-w-0 flex-1 cursor-pointer select-none" data-w-open>
          <span id="tm-w-title" class="font-body-md text-[13px] text-on-surface font-semibold tracking-tight truncate leading-tight">Nothing playing</span>
          <span id="tm-w-artist" class="font-body-sm text-[11px] text-secondary truncate mt-0.5 leading-tight"></span>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0 pr-1">
          <button type="button" data-w-fav aria-label="Favorite" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container/60 active:scale-90 transition-all"><span class="material-symbols-outlined text-[20px]" data-fav-icon></span></button>
          <button type="button" data-w-toggle aria-label="Play" class="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center active:scale-90 transition-transform shadow-sm"><span id="tm-w-playicon" class="material-symbols-outlined text-[23px]" style="font-variation-settings: 'FILL' 1;">play_arrow</span></button>
          <button type="button" data-w-next aria-label="Next" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container/60 active:scale-90 transition-all"><span class="material-symbols-outlined text-[21px]">skip_next</span></button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(host.firstElementChild);
  // Swipe gestures: left = next, right = prev, up = open NowPlaying.
  // Horizontal swipe must not fight the vertical page scroll — only fire on a
  // clear horizontal intent.
  const w = document.getElementById("tm-widget");
  if (w && !w.dataset.swipeWired) {
    w.dataset.swipeWired = "1";
    let x0 = 0;
    let y0 = 0;
    let on = false;
    w.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        on = true;
        x0 = e.touches[0].clientX;
        y0 = e.touches[0].clientY;
      },
      { passive: true },
    );
    w.addEventListener(
      "touchend",
      (e) => {
        if (!on) return;
        on = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - x0;
        const dy = t.clientY - y0;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) {
          // Vertical swipe up opens NowPlaying (down does nothing).
          if (dy < -48 && Math.abs(dy) > Math.abs(dx)) go("nowplaying");
          return;
        }
        if (dx < 0) next();
        else prev();
      },
      { passive: true },
    );
  }
}
ensureWidget();

// ------------------------------------------------------- first-run onboarding
// Language chips + starter artists; persists to LANG_KEY + taste, then gates
// forever via the shared onboard flag. Runs once per install.
(function onboard() {
  let done = true;
  try {
    done = isOnboarded();
  } catch {}
  if (done || document.getElementById("tm-onboard")) return;
  const LANGS = ["All", "Telugu", "Hindi", "Tamil", "English"];
  const STARTERS = [
    "A. R. Rahman",
    "Anirudh Ravichander",
    "Sid Sriram",
    "Shreya Ghoshal",
    "Devi Sri Prasad",
    "Arijit Singh",
  ];
  const langs = new Set(["All"]);
  const picks = new Set();
  const ov = document.createElement("div");
  ov.id = "tm-onboard";
  ov.className = "fixed inset-0 z-[100] bg-surface overflow-y-auto";
  ov.innerHTML = `
    <div class="max-w-lg mx-auto px-5 pt-14 pb-10 flex flex-col gap-6 min-h-full">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-headline-md text-[22px] font-bold tracking-tight text-on-surface">What moves you?</h1>
        <p class="font-body-sm text-[13px] text-secondary">Pick languages and artists — Home tunes itself to your taste.</p>
      </div>
      <div class="flex flex-col gap-2.5">
        <h2 class="font-body-md text-[13px] font-semibold text-on-surface">Languages</h2>
        <div class="flex flex-wrap gap-2" data-ob-langs>
          ${LANGS.map(
            (l) =>
              `<button type="button" data-ob-lang="${l}" class="px-4 py-2 rounded-full font-body-md text-[13px] font-semibold transition-all ${
                l === "All" ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
              }">${l}</button>`,
          ).join("")}
        </div>
      </div>
      <div class="flex flex-col gap-2.5">
        <h2 class="font-body-md text-[13px] font-semibold text-on-surface">Starter artists</h2>
        <div class="grid grid-cols-2 gap-2.5" data-ob-artists>
          ${STARTERS.map(
            (name) =>
              `<button type="button" data-ob-artist="${name}" class="flex items-center gap-3 px-3 py-2.5 rounded-2xl bg-surface-container text-left transition-all">
            <span class="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center shrink-0 font-headline-md text-[15px] font-bold text-secondary">${name.charAt(0)}</span>
            <span class="font-body-md text-[13px] font-semibold text-on-surface truncate">${name}</span>
          </button>`,
          ).join("")}
        </div>
      </div>
      <button type="button" data-ob-start class="w-full py-3.5 rounded-2xl bg-primary text-on-primary font-body-md text-[15px] font-bold active:scale-[0.98] transition-all mt-auto">Start listening</button>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => {
    if (!e.target || !e.target.closest) return;
    const lang = e.target.closest("[data-ob-lang]");
    if (lang) {
      const v = lang.dataset.obLang;
      if (langs.has(v)) langs.delete(v);
      else langs.add(v);
      lang.className = `px-4 py-2 rounded-full font-body-md text-[13px] font-semibold transition-all ${
        langs.has(v) ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
      }`;
      return;
    }
    const art = e.target.closest("[data-ob-artist]");
    if (art) {
      const v = art.dataset.obArtist;
      if (picks.has(v)) picks.delete(v);
      else picks.add(v);
      art.classList.toggle("ring-2", picks.has(v));
      art.classList.toggle("ring-primary", picks.has(v));
      return;
    }
    if (e.target.closest("[data-ob-start]")) {
      try {
        saveTaste([...picks]);
        save(LANG_KEY, [...langs]);
        setOnboarded();
      } catch {}
      ov.remove();
      toast("Welcome — press play", 3000, "success");
    }
  });
})();

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
  if (title && t.title) {
    title.textContent = t.title;
    // Overflowing titles scroll (keyframes live in index.html).
    try {
      title.classList.toggle("tm-marquee", title.scrollWidth > title.clientWidth);
    } catch {}
  }
  const artist = w.querySelector("#tm-w-artist");
  if (artist) {
    // Surface transport problems where the artist line lives: offline misses
    // and resolve errors must read as text, not silence.
    const mode = netMode();
    if (mode === "offline" && !isVaulted(t.id)) artist.textContent = "Offline — not downloaded";
    else if (st.badge === "ERROR") artist.textContent = `${t.artist || ""} · Stream error`.trim();
    else if (st.badge === "RESOLVING" || st.badge === "RETRYING") artist.textContent = `${t.artist || ""} · ${st.badge.toLowerCase()}…`.trim();
    else if (st.badge === "OFFLINE") artist.textContent = "Offline — playing from vault";
    else artist.textContent = t.artist || "";
  }
  const img = w.querySelector("#tm-w-art");
  if (img && t.image) paintArt(img, t.image);
  const vault = w.querySelector("#tm-w-vault");
  if (vault) {
    const saved = isVaulted(t.id);
    vault.classList.toggle("hidden", !saved);
    vault.classList.toggle("flex", !!saved);
  }
  const fill = w.querySelector("#tm-w-fill");
  if (fill) fill.style.width = `${st.dur > 0 ? Math.min(100, (st.pos / st.dur) * 100) : 0}%`;
  const buf = w.querySelector("#tm-w-buf");
  if (buf) buf.style.width = `${Math.round(Math.min(1, st.buf || 0) * 100)}%`;
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
  const sh = w.querySelector("#tm-w-shuffleicon");
  if (sh) {
    sh.style.fontVariationSettings = `'FILL' ${st.shuffle ? 1 : 0}`;
    sh.classList.toggle("text-primary", !!st.shuffle);
    sh.closest("button")?.setAttribute("aria-pressed", String(!!st.shuffle));
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
    diag: pushDiag,
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
