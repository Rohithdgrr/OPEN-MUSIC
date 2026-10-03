// menus.js — one options sheet behind every three-dot trigger on mobile.
//
// Each screen fragment used to ship its own menu (NowPlaying's sheet, the
// Library action sheet, History's context modal) and only some of the options
// inside them did anything. There is now a single sheet, mounted on
// <body> so no screen re-render can destroy it, and every option runs a real
// handler: queue mutations, entity navigation, sharing, downloads, history
// editing.
import { esc } from "../html.js";
import {
  invoke,
  store,
  load,
  save,
  toast,
  go,
  hqArt,
  fmtTime,
  FAVS_KEY,
  PLAYS_KEY,
  LIBRARY_KEY,
  downloadTrack,
  downloadAll,
} from "./shared.js";
import { playerState, insertNext, enqueue, insertNextAll, enqueueAll } from "./player.js";
import { entityNav, MOUNT } from "./binders.js";

// --------------------------------------------------------------------- sheet

let root = null;
let content = null;
let titleEl = null;
let subEl = null;
let artEl = null;
let listEl = null;

function ensureSheet() {
  if (root && root.isConnected) return;
  root = document.createElement("div");
  root.id = "tm-options-sheet";
  root.className =
    "fixed inset-0 z-[70] transition-opacity duration-200 flex flex-col justify-end pointer-events-none opacity-0";
  root.innerHTML = `
    <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" data-tm-dismiss></div>
    <div class="relative bg-surface-container-lowest border-t border-surface-container-high/80 rounded-t-xl max-w-lg mx-auto w-full px-5 pt-3 pb-8 shadow-xl transform transition-transform duration-200 flex flex-col gap-3 translate-y-full" data-tm-content>
      <div class="w-10 h-1 bg-surface-container-highest rounded-full mx-auto mb-1"></div>
      <div class="flex items-center gap-3 pb-3 border-b border-surface-container-high/60">
        <div class="w-11 h-11 rounded-lg bg-surface-container-high overflow-hidden shrink-0 border border-black/5"><img alt="" class="w-full h-full object-cover hidden" data-tm-art></div>
        <div class="flex flex-col min-w-0">
          <h3 class="font-headline-md text-[14px] font-semibold text-on-surface truncate" data-tm-title></h3>
          <p class="font-body-sm text-[12px] text-on-surface-variant truncate" data-tm-sub></p>
        </div>
      </div>
      <div class="flex flex-col gap-1 overflow-y-auto max-h-[55vh]" data-tm-list></div>
      <button class="w-full py-3 rounded-lg bg-surface-container text-on-surface font-body-md text-[14px] font-medium hover:bg-surface-container-high transition-colors" data-tm-dismiss>Close</button>
    </div>`;
  document.body.appendChild(root);
  content = root.querySelector("[data-tm-content]");
  titleEl = root.querySelector("[data-tm-title]");
  subEl = root.querySelector("[data-tm-sub]");
  artEl = root.querySelector("[data-tm-art]");
  listEl = root.querySelector("[data-tm-list]");
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-tm-dismiss]")) closeSheet();
  });
}

export function closeSheet() {
  if (!root) return;
  root.classList.remove("pointer-events-auto", "opacity-100");
  root.classList.add("pointer-events-none", "opacity-0");
  content.classList.remove("translate-y-0");
  content.classList.add("translate-y-full");
}

function openSheet({ title, sub, image, items = [], rows = [] }) {
  ensureSheet();
  titleEl.textContent = String(title || "");
  subEl.textContent = String(sub || "");
  if (image) {
    artEl.setAttribute("data-art-orig", image);
    artEl.removeAttribute("data-art-step");
    artEl.src = hqArt(image);
    artEl.classList.remove("hidden");
  } else {
    artEl.removeAttribute("src");
    artEl.removeAttribute("data-art-orig");
    artEl.classList.add("hidden");
  }
  const html = [];
  for (const r of rows) {
    html.push(
      `<div class="flex items-start justify-between gap-3 px-3 py-2 rounded-lg">
        <span class="font-body-sm text-[12px] text-on-surface-variant shrink-0">${esc(r[0])}</span>
        <span class="font-body-md text-[13px] text-on-surface text-right min-w-0 break-words">${esc(r[1] || "—")}</span>
      </div>`,
    );
  }
  for (const it of items) {
    html.push(
      `<button type="button" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors active:scale-95 ${
        it.danger ? "text-error hover:bg-error-container" : "text-on-surface hover:bg-surface-container"
      }" data-tm-item><span class="material-symbols-outlined text-[20px] ${
        it.danger ? "text-error" : "text-on-surface-variant"
      }">${esc(it.icon || "more_horiz")}</span><span class="font-body-md text-[14px] font-medium">${esc(
        it.label,
      )}</span></button>`,
    );
  }
  listEl.innerHTML = html.join("");
  const buttons = [...listEl.querySelectorAll("[data-tm-item]")];
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => {
      const run = (items[i] || {}).action;
      closeSheet();
      // Let the sheet animate out before a navigation or a toast.
      setTimeout(() => {
        try {
          run && run();
        } catch (e) {
          console.error(e);
          toast(String(e).split("\n")[0].slice(0, 90), 5000, "error");
        }
      }, 120);
    });
  });
  root.classList.remove("pointer-events-none", "opacity-0");
  root.classList.add("pointer-events-auto", "opacity-100");
  content.classList.remove("translate-y-full");
  content.classList.add("translate-y-0");
}

// ------------------------------------------------------------------ actions

async function shareThing({ title, text, url }) {
  const payload = {};
  if (title) payload.title = title;
  if (text) payload.text = text;
  if (url) payload.url = url;
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user dismissed the sheet
    }
  }
  const line = [title, text, url].filter(Boolean).join(" — ");
  try {
    await navigator.clipboard.writeText(line);
    toast("Share text copied");
  } catch {
    toast("Sharing is unavailable here");
  }
}

async function viewAlbum(track) {
  if (!track.album) return toast("No album information for this track");
  if (!invoke) return toast("Backend unavailable", 4000, "error");
  try {
    const r = await invoke("search_entities", { query: track.album, kind: "album", limit: 10 });
    const items = (r && r.items) || [];
    const want = String(track.album).toLowerCase();
    const hit = items.find((x) => String(x.title || "").toLowerCase() === want) || items[0];
    if (!hit || !hit.token) return toast("Album not found", 4000, "error");
    go(entityNav("album", hit));
  } catch (e) {
    console.error(e);
    toast(String(e).slice(0, 90), 5000, "error");
  }
}

async function goToArtist(track) {
  const token = (track.artist_ids || [])[0];
  if (token) return go(entityNav("artist", { token, title: track.artist, image: track.image }));
  const query = String(track.artist || "").split(",")[0].trim();
  if (!invoke || !query) return toast("No artist information for this track");
  try {
    const r = await invoke("search_entities", { query, kind: "artist", limit: 10 });
    const items = (r && r.items) || [];
    const want = query.toLowerCase();
    const hit = items.find((x) => String(x.title || "").toLowerCase() === want) || items[0];
    if (!hit || !hit.token) return toast("Artist not found", 4000, "error");
    go(entityNav("artist", hit));
  } catch (e) {
    console.error(e);
    toast(String(e).slice(0, 90), 5000, "error");
  }
}

function removeFromHistory(track) {
  const plays = load(PLAYS_KEY, []);
  const next = plays.filter((t) =>
    track.id ? t.id !== track.id : !(t.ts === track.ts && t.title === track.title),
  );
  if (next.length === plays.length) return toast("Not in your history");
  save(PLAYS_KEY, next);
  toast("Removed from history");
  MOUNT.history?.();
}

function detailsSheet(track) {
  const rows = [
    ["Title", track.title],
    ["Artist", track.artist || track.subtitle],
    ["Album", track.album],
    ["Year", track.year],
    ["Language", track.language],
    ["Label", track.label],
    ["Duration", track.duration || (track.duration_secs ? fmtTime(track.duration_secs) : "")],
    ["Quality", track.hq ? "Lossless" : ""],
    ["Track ID", track.id],
  ].filter((r) => r[1]);
  openSheet({
    title: "Track Details",
    sub: track.artist || "",
    image: track.image,
    rows,
  });
}

// ------------------------------------------------------------------- menus

/// The full track menu — the one the design shows on NowPlaying.
export function trackMenu(track, ctx) {
  if (!track) return toast("Nothing selected");
  const items = [];
  if (track.id) {
    items.push({
      icon: "playlist_play",
      label: "Play Next",
      action: () => {
        insertNext(track);
        toast(`Playing “${track.title || "track"}” next`);
      },
    });
    items.push({
      icon: "queue_music",
      label: "Add to Queue",
      action: () => {
        enqueue(track);
        toast(`“${track.title || "track"}” added to queue`);
      },
    });
  }
  if (track.album) {
    items.push({ icon: "album", label: "View Album", action: () => viewAlbum(track) });
  }
  if (track.artist || track.artist_ids?.length) {
    items.push({ icon: "artist", label: "Go to Artist", action: () => goToArtist(track) });
  }
  items.push({
    icon: "ios_share",
    label: "Share Track",
    action: () => shareThing({ title: track.title, text: [track.artist, track.album].filter(Boolean).join(" • "), url: track.page_url }),
  });
  items.push({ icon: "info", label: "Track Details", action: () => detailsSheet(track) });
  if (ctx === "history") {
    items.push({
      icon: "delete",
      label: "Remove from History",
      danger: true,
      action: () => removeFromHistory(track),
    });
  } else if (track.id) {
    items.push({ icon: "download", label: "Download", action: () => downloadTrack(track) });
  }
  openSheet({ title: track.title || "Track", sub: track.artist || track.subtitle || "", image: track.image, items });
}

const KIND_LABEL = { album: "Album", artist: "Artist", playlist: "Playlist", liked: "Liked Songs" };

function metaFromUrl() {
  const raw = location.hash.replace(/^#\/?/, "");
  const qi = raw.indexOf("?");
  const q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
  return { title: q.get("title") || "", subtitle: q.get("subtitle") || "", image: q.get("image") || "" };
}

/// Header overflow menu on album / artist / playlist / liked-songs.
export function entityMenu(kind) {
  const meta = metaFromUrl();
  // Liked-songs fills `favs`; every other detail screen fills `detail`.
  const tracks = (kind === "liked" ? store.favs : store.detail) || [];
  const label = KIND_LABEL[kind] || "Collection";
  const items = [
    {
      icon: "playlist_play",
      label: "Play Next",
      action: () => {
        if (!tracks.length) return toast("Tracklist hasn't loaded yet");
        const n = insertNextAll(tracks);
        toast(`${n} track${n === 1 ? "" : "s"} play next`);
      },
    },
    {
      icon: "queue_music",
      label: "Add to Queue",
      action: () => {
        if (!tracks.length) return toast("Tracklist hasn't loaded yet");
        const n = enqueueAll(tracks);
        toast(`${n} track${n === 1 ? "" : "s"} added to queue`);
      },
    },
    {
      icon: "download",
      label: "Download all",
      action: () => {
        if (!tracks.length) return toast("Tracklist hasn't loaded yet");
        downloadAll(tracks, `${tracks.length} ${label.toLowerCase()}`);
      },
    },
    {
      icon: "ios_share",
      label: "Share",
      action: () => shareThing({ title: meta.title || label, text: meta.subtitle || label }),
    },
  ];
  openSheet({
    title: meta.title || label,
    sub: meta.subtitle || `${label} options`,
    image: meta.image,
    items,
  });
}

/// Library rows: saved entities, local playlists, pinned lists and recent plays.
export async function libraryMenu(item) {
  if (!item) return;
  if (item.track) {
    // Recent plays carry the whole track — the full track menu plus removal.
    const t = item.track;
    return openSheet({
      title: t.title || item.title || "Track",
      sub: t.artist || item.sub || "",
      image: t.image || item.image,
      items: [
        {
          icon: "playlist_play",
          label: "Play Next",
          action: () => {
            insertNext(t);
            toast(`Playing “${t.title}” next`);
          },
        },
        {
          icon: "queue_music",
          label: "Add to Queue",
          action: () => {
            enqueue(t);
            toast(`“${t.title}” added to queue`);
          },
        },
        { icon: "info", label: "Track Details", action: () => detailsSheet(t) },
        { icon: "download", label: "Download", action: () => downloadTrack(t) },
        {
          icon: "ios_share",
          label: "Share",
          action: () => shareThing({ title: t.title, text: t.artist, url: t.page_url }),
        },
        {
          icon: "delete",
          label: "Remove from list",
          danger: true,
          action: () => {
            save(PLAYS_KEY, load(PLAYS_KEY, []).filter((x) => x.id !== t.id));
            toast("Removed from your library");
            MOUNT["main-library"]?.();
          },
        },
      ],
    });
  }

  const resolve = async () => {
    if (item.tracks && item.tracks.length) return item.tracks;
    if (item.nav === "liked") return load(FAVS_KEY, []);
    if (!item.nav || !invoke) return [];
    const q = new URLSearchParams(String(item.nav).split("?")[1] || "");
    try {
      if (item.nav.startsWith("album")) {
        const token = q.get("token") || q.get("id") || "";
        return token ? await invoke("album_tracks", { token }) : [];
      }
      if (item.nav.startsWith("playlist")) {
        const id = q.get("id") || q.get("token") || "";
        return id ? await invoke("playlist_tracks", { id }) : [];
      }
    } catch (e) {
      console.error(e);
    }
    return [];
  };

  const queueAll = (how) => async () => {
    const tracks = await resolve();
    if (!tracks.length) return toast("Nothing to queue here");
    const n = how === "next" ? insertNextAll(tracks) : enqueueAll(tracks);
    toast(`${n} track${n === 1 ? "" : "s"} ${how === "next" ? "play next" : "added to queue"}`);
  };

  const items = [
    { icon: "playlist_play", label: "Play Next", action: queueAll("next") },
    { icon: "queue_music", label: "Add to Queue", action: queueAll("queue") },
  ];
  if (item.nav) {
    items.push({ icon: "open_in_new", label: "Open", action: () => go(item.nav) });
  }
  items.push({
    icon: "ios_share",
    label: "Share",
    action: () => shareThing({ title: item.title, text: item.sub }),
  });
  if (load(LIBRARY_KEY, []).some((x) => x.title === item.title)) {
    items.push({
      icon: "delete",
      label: "Remove from library",
      danger: true,
      action: () => {
        save(LIBRARY_KEY, load(LIBRARY_KEY, []).filter((x) => x.title !== item.title));
        toast("Removed from your library");
        MOUNT["main-library"]?.();
      },
    });
  }
  openSheet({
    title: item.title || "Item",
    sub: item.sub || "Options",
    image: item.image,
    items,
  });
}

// ----------------------------------------------------------------- triggers

const KEBABS = ["more_vert", "more_horiz"];

export function isMenuTrigger(btn) {
  if (!btn || btn.tagName !== "BUTTON") return false;
  if (btn.id === "more-options-btn") return true;
  // Inline handlers (Library's static rows) and data-libmenu own their menu.
  if (btn.hasAttribute("onclick") || btn.hasAttribute("data-libmenu")) return false;
  const label = btn.getAttribute("aria-label") || "";
  if (!/option|action|more/i.test(label)) return false;
  const icon = btn.querySelector(".material-symbols-outlined");
  const glyph = icon ? icon.textContent.trim() : "";
  return !glyph || KEBABS.includes(glyph);
}

function trackFromDom(btn) {
  let el = btn;
  for (let i = 0; i < 5 && el; i += 1, el = el.parentElement) {
    const texts = [...el.querySelectorAll("span, h3")]
      .filter((s) => !s.classList.contains("material-symbols-outlined") && s.textContent.trim())
      .map((s) => s.textContent.trim());
    if (texts.length) return { title: texts[0], artist: texts[1] || "" };
  }
  return null;
}

/// Resolve whatever a kebab belongs to and open the matching menu.
export function handleMenuTrigger(btn) {
  if (btn.dataset.menuEntity) return entityMenu(btn.dataset.menuEntity);
  if (btn.dataset.menuList) {
    const list = store[btn.dataset.menuList];
    const track = list && list[+btn.dataset.menuIdx || 0];
    return trackMenu(track, location.hash.startsWith("#/history") ? "history" : null);
  }
  const row = btn.closest("[data-list][data-idx]");
  if (row) {
    const list = store[row.dataset.list];
    const track = list && list[+row.dataset.idx || 0];
    if (track) return trackMenu(track, location.hash.startsWith("#/history") ? "history" : null);
  }
  if (location.hash.startsWith("#/nowplaying") || btn.id === "more-options-btn") {
    const current = playerState().track;
    if (!current) return toast("Nothing is playing");
    return trackMenu(current, null);
  }
  if (btn.closest("header")) {
    const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
    return entityMenu(raw === "liked" ? "liked" : raw);
  }
  const fallback = trackFromDom(btn);
  if (fallback) return trackMenu(fallback, null);
  toast("Nothing selected");
}

window.__tmLibraryMenu = libraryMenu;
