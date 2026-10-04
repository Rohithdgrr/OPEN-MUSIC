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
  shareThing,
  shareCard,
  haptic,
  movePlaylistTrack,
  removePlaylistTrack,
  updatePlaylistMeta,
} from "./shared.js";
import {
  playerState,
  insertNext,
  enqueue,
  insertNextAll,
  enqueueAll,
  removeFromQueue,
  playList,
  moveQueue,
  clearQueue,
  smartShuffleQueue,
  queueHistory,
  queueUpNext,
  repaint,
} from "./player.js";
import { entityNav, MOUNT } from "./binders.js";
import { playlistToCsv, playlistToM3u, playlistFilename } from "../sync.js";

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
    <div class="absolute inset-0 bg-black/50 backdrop-blur-md transition-opacity duration-200" data-tm-dismiss></div>
    <div class="relative bg-surface-container-lowest/95 backdrop-blur-2xl border-t border-surface-container-high/80 rounded-t-[28px] max-w-lg mx-auto w-full max-h-[40vh] overflow-hidden px-5 pt-3 pb-8 shadow-[0_-16px_48px_rgba(0,0,0,0.18)] transform transition-transform duration-300 ease-out flex flex-col gap-3 translate-y-full" data-tm-content>
      <div class="w-12 h-1.5 bg-surface-container-highest rounded-full mx-auto mb-1.5 opacity-80"></div>
      <div class="flex items-center gap-3.5 pb-3 border-b border-surface-container-high/60">
        <div class="w-12 h-12 rounded-xl bg-surface-container-high overflow-hidden shrink-0 shadow-sm ring-1 ring-black/5"><img alt="" class="w-full h-full object-cover hidden" data-tm-art></div>
        <div class="flex flex-col min-w-0">
          <h3 class="font-headline-md text-[15px] font-semibold tracking-tight text-on-surface truncate" data-tm-title></h3>
          <p class="font-body-sm text-[12px] text-on-surface-variant truncate mt-0.5" data-tm-sub></p>
        </div>
      </div>
      <div class="flex flex-col gap-0.5 overflow-y-auto max-h-[calc(40vh_-_240px)]" data-tm-list></div>
      <button class="w-full py-3.5 rounded-xl bg-surface-container text-on-surface font-body-md text-[14px] font-semibold hover:bg-surface-container-high active:scale-[0.98] transition-all mt-1" data-tm-dismiss>Close</button>
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

export function openSheet({ title, sub, image, items = [], rows = [] }) {
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
      `<div class="flex items-start justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-surface-container-low/50">
        <span class="font-body-sm text-[12px] text-on-surface-variant shrink-0 font-medium">${esc(r[0])}</span>
        <span class="font-body-md text-[13px] text-on-surface text-right min-w-0 break-words">${esc(r[1] || "—")}</span>
      </div>`,
    );
  }
  for (const it of items) {
    html.push(
      `<button type="button" class="w-full flex items-center gap-3.5 px-3.5 py-3 rounded-xl text-left transition-all active:scale-[0.98] ${
        it.danger ? "text-error hover:bg-error-container/60 active:bg-error-container" : "text-on-surface hover:bg-surface-container/70 active:bg-surface-container-high"
      }" data-tm-item><span class="material-symbols-outlined text-[21px] ${
        it.danger ? "text-error" : "text-on-surface-variant"
      }">${esc(it.icon || "more_horiz")}</span><span class="font-body-md text-[14px] font-medium tracking-tight">${esc(
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

/// Text-input variant of the sheet: native `prompt()` is broken in Android
/// WebViews (no dialog, silent cancel), so playlist create/rename goes here.
/// Calls `onSubmit(cleanName)` and closes; empty names never submit.
function openInputSheet({ title, sub, image, placeholder, value, cta, onSubmit }) {
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
  listEl.innerHTML = `
    <div class="px-1 py-1 flex flex-col gap-2.5">
      <input type="text" maxlength="48" data-tm-input
        placeholder="${esc(placeholder || "Name")}" value="${esc(value || "")}"
        class="w-full bg-surface-container-low border border-surface-container-high rounded-xl px-3.5 py-3 font-body-md text-[14px] text-on-surface placeholder:text-secondary focus:outline-none focus:border-primary/50" />
      <button type="button" data-tm-save
        class="w-full py-3 rounded-xl bg-primary text-on-primary font-body-md text-[14px] font-semibold active:scale-[0.98] transition-all">${esc(cta || "Save")}</button>
    </div>`;
  const input = listEl.querySelector("[data-tm-input]");
  const saveBtn = listEl.querySelector("[data-tm-save]");
  const submit = () => {
    const clean = String(input?.value || "").trim();
    if (!clean) {
      toast("Give it a name first", 3000, "error");
      input?.focus();
      return;
    }
    const fn = onSubmit;
    closeSheet();
    setTimeout(() => {
      try {
        fn && fn(clean);
      } catch (e) {
        console.error(e);
        toast(String(e).split("\n")[0].slice(0, 90), 5000, "error");
      }
    }, 120);
  };
  saveBtn?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  root.classList.remove("pointer-events-none", "opacity-0");
  root.classList.add("pointer-events-auto", "opacity-100");
  content.classList.remove("translate-y-full");
  content.classList.add("translate-y-0");
  setTimeout(() => input?.focus(), 180);
}

export function createPlaylistSheet(tracks = [], initialName = "") {
  openInputSheet({
    title: "New playlist",
    sub: tracks.length ? `${tracks.length} track${tracks.length === 1 ? "" : "s"} will be added` : "Name your new playlist",
    placeholder: "Playlist name",
    value: initialName,
    cta: tracks.length ? "Create & add" : "Create playlist",
    onSubmit: (clean) => {
      const all = load(LIBRARY_KEY, []);
      if (all.some((x) => x && x.local && String(x.title || "").toLowerCase() === clean.toLowerCase())) {
        toast("You already have a playlist with that name", 4000, "error");
        return;
      }
      const pl = {
        id: `local-${Date.now()}`,
        local: true,
        kind: "playlist",
        title: clean,
        subtitle: `${tracks.length} song${tracks.length === 1 ? "" : "s"}`,
        tracks: tracks.map((t) => ({ ...t })),
        image: tracks[0]?.image || "",
        ts: Date.now(),
      };
      all.unshift(pl);
      save(LIBRARY_KEY, all);
      toast(`Created “${clean}”`, 6000, "success", { label: "Open", fn: () => go("library") });
      MOUNT["main-library"]?.();
    },
  });
}

export async function exportLocalPlaylistFile(playlist, format = "csv") {
  if (!playlist) return toast("Playlist not found", 4000, "error");
  const isCsv = format === "csv";
  const content = isCsv ? playlistToCsv(playlist) : playlistToM3u(playlist);
  const name = playlistFilename(playlist.title || "playlist", format);
  const mime = isCsv ? "text/csv" : "audio/x-mpegurl";
  const file = new File([content], name, { type: mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: playlist.title });
      return toast(`Exported "${playlist.title}" as ${format.toUpperCase()}`, 3000, "success");
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(content);
    toast(`${format.toUpperCase()} copied to clipboard`, 4000, "success");
  } catch {
    toast(`Could not export ${format.toUpperCase()}`, 4000, "error");
  }
}

// ------------------------------------------------------------------ actions

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

export function detailsSheet(track) {
  if (!track) return;
  let streamQuality = "";
  try {
    const st = playerState();
    if (st && st.track && (st.track.id === track.id || (!st.track.id && st.track.title === track.title))) {
      streamQuality = st.badge || "";
    }
  } catch {}
  const rows = [
    ["Title", track.title],
    ["Artist", track.artist || track.subtitle],
    ["Album", track.album],
    ["Year", track.year],
    ["Language", track.language],
    ["Label", track.label],
    ["Duration", track.duration || (track.duration_secs ? fmtTime(track.duration_secs) : "")],
    ["Audio Quality", streamQuality || (track.hq ? "Hi-Res" : "")],
    ["Catalog plays", track.plays ? Number(track.plays).toLocaleString("en") : ""],
    ["Lyrics", track.has_lyrics ? "Available" : ""],
    ["Explicit", track.explicit ? "Yes" : ""],
    ["Track ID", track.id],
  ].filter((r) => r[1]);
  openSheet({
    title: "Track Details & Lineage",
    sub: track.artist || "",
    image: track.image,
    rows,
  });
}

// ------------------------------------------------------------------ playlists

/// Local playlists are plain records in LIBRARY_KEY (the same shape
/// promptCreatePlaylist creates). The picker lists them, plus "New playlist",
/// and the confirmation toast carries an Open shortcut to the Library.
function localPlaylists() {
  return load(LIBRARY_KEY, []).filter((p) => p && p.local && p.kind === "playlist");
}

function addToPlaylist(track) {
  if (!track || !track.id) return toast("Nothing to add");
  const put = (plId) => {
    const all = load(LIBRARY_KEY, []);
    const i = all.findIndex((x) => x.id === plId);
    if (i < 0) return toast("Playlist not found", 4000, "error");
    const cur = { ...(all[i] || {}) };
    if ((cur.tracks || []).some((t) => t.id === track.id)) return toast(`Already in “${cur.title}”`);
    cur.tracks = [{ ...track }, ...(cur.tracks || [])];
    cur.subtitle = `${cur.tracks.length} song${cur.tracks.length === 1 ? "" : "s"}`;
    if (!cur.image && track.image) cur.image = track.image;
    cur.ts = Date.now();
    all[i] = cur;
    save(LIBRARY_KEY, all);
    toast(`Added to “${cur.title}”`, 6000, "success", { label: "Open", fn: () => go("library") });
  };
  const lists = localPlaylists();
  const items = lists.map((p) => ({
    icon: (p.tracks || []).some((t) => t.id === track.id) ? "check" : "playlist_play",
    label: `${p.title} · ${(p.tracks || []).length}`,
    action: () => put(p.id),
  }));
  items.push({
    icon: "add",
    label: "New playlist",
    action: () => createPlaylistSheet(track ? [{ ...track }] : [], ""),
  });
  openSheet({ title: "Add to playlist", sub: track.title || "", image: track.image, items });
}

/// Rename a local playlist in place (LIBRARY_KEY record). `id` wins; the
/// library row falls back to its title. Opens the bottom-sheet input (native
/// `prompt()` never shows in the Android WebView) and returns nothing — the
/// rename completes async via `onRenamed`.
function renameLocalPlaylist(id, title, onRenamed) {
  const all = load(LIBRARY_KEY, []);
  const i = all.findIndex((x) => x && x.local && (id ? x.id === id : x.title === title));
  if (i < 0) {
    toast("Playlist not found", 4000, "error");
    return null;
  }
  const current = all[i].title || "";
  openInputSheet({
    title: "Rename playlist",
    sub: current,
    image: all[i].image || "",
    placeholder: "Playlist name",
    value: current,
    cta: "Rename",
    onSubmit: (clean) => {
      const fresh = load(LIBRARY_KEY, []);
      const at = fresh.findIndex((x) => x && x.local && (id ? x.id === id : x.title === current));
      if (at < 0) {
        toast("Playlist not found", 4000, "error");
        return;
      }
      if (fresh.some((x, j) => j !== at && x && x.local && String(x.title || "").toLowerCase() === clean.toLowerCase())) {
        toast("You already have a playlist with that name", 4000, "error");
        return;
      }
      fresh[at].title = clean;
      save(LIBRARY_KEY, fresh);
      toast(`Renamed to "${clean}"`, 3000, "success");
      MOUNT["main-library"]?.();
      try {
        onRenamed && onRenamed(clean);
      } catch {}
    },
  });
  return null;
}

/// Delete a local playlist (LIBRARY_KEY record) with a danger confirm inside
/// the same sheet — two taps, no native confirm().
export function deleteLocalPlaylist(id, title) {
  if (!id) return;
  openSheet({
    title: `Delete “${title || "playlist"}”?`,
    sub: "Tracks stay in your library — only the list is removed.",
    items: [
      {
        icon: "delete",
        label: "Delete playlist",
        danger: true,
        action: () => {
          save(
            LIBRARY_KEY,
            load(LIBRARY_KEY, []).filter((x) => x && x.id !== id),
          );
          toast("Playlist deleted", 3000, "success");
          MOUNT["main-library"]?.();
          if (location.hash.startsWith("#/playlist") && location.hash.includes(id)) history.back();
        },
      },
    ],
  });
}

// ------------------------------------------------------------------- menus

/// The full track menu — the one the design shows on NowPlaying.
/// `ctx` is "history" | "queue" | null; `idx` is the absolute queue index
/// that only the queue context needs (for the removal entry).
export function trackMenu(track, ctx, idx) {
  if (!track) return toast("Nothing selected");
  try {
    haptic(10);
  } catch {}
  const items = [];
  if (track.id) {
    items.push({
      icon: "playlist_add",
      label: "Add to Playlist",
      action: () => addToPlaylist(track),
    });
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
  items.push({
    icon: "image",
    label: "Share Card",
    action: () => shareCard({ title: track.title, subtitle: track.artist, image: track.image, badge: "TRANCE" }),
  });
  items.push({ icon: "info", label: "Track Details", action: () => detailsSheet(track) });
  if (track.id) {
    items.push({
      icon: "tune",
      label: "EQ for this track",
      action: () => {
        try {
          if (typeof window.__tmTrackEq === "function") window.__tmTrackEq(track);
          else toast("EQ panel unavailable", 3000, "error");
        } catch {}
      },
    });
  }
  if (ctx === "queue" && Number.isInteger(idx)) {
    items.push({
      icon: "remove_from_queue",
      label: "Remove from Queue",
      danger: true,
      action: () => {
        removeFromQueue(idx);
        toast(`Removed “${track.title || "track"}” from the queue`);
      },
    });
  }
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
    {
      icon: "image",
      label: "Share Card",
      action: () => shareCard({ title: meta.title || label, subtitle: meta.subtitle || label, image: meta.image, badge: "TRANCE" }),
    },
  ];
  // Local playlists are LIBRARY_KEY records — Rename + Delete for them only.
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const localId = kind === "playlist" ? qs.get("id") || "" : "";
  if (localId.startsWith("local-")) {
    items.push({
      icon: "edit",
      label: "Rename",
      action: () =>
        renameLocalPlaylist(localId, meta.title, (next) => {
          if (!next || next === meta.title) return;
          qs.set("title", next);
          location.hash = `#/playlist?${qs.toString()}`; // repaint the header
        }),
    });
    items.push({
      icon: "file_download",
      label: "Export as CSV",
      action: () => {
        const pl = load(LIBRARY_KEY, []).find((x) => x && x.id === localId) || { title: meta.title, tracks };
        exportLocalPlaylistFile(pl, "csv");
      },
    });
    items.push({
      icon: "playlist_add_check",
      label: "Export as M3U",
      action: () => {
        const pl = load(LIBRARY_KEY, []).find((x) => x && x.id === localId) || { title: meta.title, tracks };
        exportLocalPlaylistFile(pl, "m3u");
      },
    });
    items.push({
      icon: "delete",
      label: "Delete playlist",
      danger: true,
      action: () => deleteLocalPlaylist(localId, meta.title),
    });
  }
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
  items.push({
    icon: "image",
    label: "Share Card",
    action: () => shareCard({ title: item.title, subtitle: item.sub, image: item.image, badge: "TRANCE" }),
  });
  if (item.local) {
    items.push({
      icon: "edit",
      label: "Rename",
      action: () => renameLocalPlaylist(item.id, item.title),
    });
    items.push({
      icon: "description",
      label: "Edit description",
      action: () => {
        const next = window.prompt("Description", item.sub || "");
        if (next === null) return;
        if (updatePlaylistMeta(item.id, { desc: next })) {
          toast("Description updated", 2500, "success");
          try {
            MOUNT["main-library"]?.();
          } catch {}
        } else {
          toast("Playlist not found", 4000, "error");
        }
      },
    });
    items.push({
      icon: "add_photo_alternate",
      label: "Edit cover",
      action: () => {
        const next = window.prompt("Cover image URL", item.image || "");
        if (next === null) return;
        if (updatePlaylistMeta(item.id, { cover: next.trim() })) {
          toast("Cover updated", 2500, "success");
          try {
            MOUNT["main-library"]?.();
          } catch {}
        } else {
          toast("Playlist not found", 4000, "error");
        }
      },
    });
    items.push({
      icon: "file_download",
      label: "Export as CSV",
      action: () => exportLocalPlaylistFile(item, "csv"),
    });
    items.push({
      icon: "playlist_add_check",
      label: "Export as M3U",
      action: () => exportLocalPlaylistFile(item, "m3u"),
    });
    items.push({
      icon: "delete",
      label: "Delete playlist",
      danger: true,
      action: () => deleteLocalPlaylist(item.id, item.title),
    });
  } else if (load(LIBRARY_KEY, []).some((x) => x.id === item.id || x.title === item.title)) {
    items.push({
      icon: "delete",
      label: "Remove from library",
      danger: true,
      action: () => {
        save(
          LIBRARY_KEY,
          load(LIBRARY_KEY, []).filter((x) => (item.id ? x.id !== item.id : x.title !== item.title)),
        );
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

// ------------------------------------------------------------------- queue overlay

/// Full queue overlay (Spotify parity): an 85vh bottom sheet — deliberately NOT
/// the 40vh track sheet — with [Up Next | History] tabs. Play-now jumps through
/// playList() with an absolute index (player.js keeps no playIndex export);
/// every mutation re-renders the overlay content in place.
export async function openQueue() {
  const fullQueue = () => {
    try {
      const st = playerState();
      return Array.isArray(st.queue) ? st.queue : [];
    } catch {
      return [];
    }
  };
  const currentIdx = () => {
    try {
      const n = Number(playerState().qi);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const upNext = () => {
    try {
      const list = queueUpNext();
      if (Array.isArray(list)) return list;
    } catch {}
    return fullQueue().slice(currentIdx() + 1);
  };
  const past = () => {
    try {
      const list = queueHistory();
      if (Array.isArray(list)) return list;
    } catch {}
    return fullQueue().slice(0, Math.max(0, currentIdx()));
  };

  let tab = "next";
  const old = document.getElementById("tm-queue-sheet");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "tm-queue-sheet";
  ov.className = "fixed inset-0 z-[80] flex flex-col justify-end pointer-events-auto";
  ov.innerHTML = `
    <div class="absolute inset-0 bg-black/50 backdrop-blur-md" data-q-close></div>
    <div class="relative bg-surface-container-lowest/95 backdrop-blur-2xl border-t border-surface-container-high/80 rounded-3xl max-w-lg mx-auto w-full max-h-[85vh] overflow-hidden px-5 pt-3 pb-8 shadow-[0_-16px_48px_rgba(0,0,0,0.18)] flex flex-col gap-3 mb-2" data-q-panel>
      <div class="w-12 h-1.5 bg-surface-container-highest rounded-full mx-auto mb-1 opacity-80"></div>
      <div class="flex items-center justify-between">
        <h3 class="font-headline-md text-[15px] font-semibold tracking-tight text-on-surface">Queue</h3>
        <div class="flex items-center gap-1.5">
          <button type="button" data-q-smart-shuffle title="Smart Shuffle (artist-aware)" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all">
            <span class="material-symbols-outlined text-[19px]">shuffle</span>
          </button>
          <button type="button" data-q-save-pl title="Save queue as playlist" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all">
            <span class="material-symbols-outlined text-[19px]">bookmark_add</span>
          </button>
        </div>
      </div>
      <div class="flex gap-2" data-q-tabs>
        <button type="button" data-q-tab="next" class="flex-1 py-2 rounded-xl font-body-md text-[13px] font-semibold transition-all">Up Next</button>
        <button type="button" data-q-tab="history" class="flex-1 py-2 rounded-xl font-body-md text-[13px] font-semibold transition-all">History</button>
      </div>
      <div class="flex flex-col gap-1 overflow-y-auto min-h-[120px]" data-q-list></div>
      <div class="flex gap-2">
        <button type="button" data-q-clear class="flex-1 py-3 rounded-xl bg-surface-container text-on-surface font-body-md text-[14px] font-semibold active:scale-[0.98] transition-all">Clear</button>
        <button type="button" data-q-close class="flex-1 py-3 rounded-xl bg-primary text-on-primary font-body-md text-[14px] font-semibold active:scale-[0.98] transition-all">Close</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const qList = ov.querySelector("[data-q-list]");
  // External drag-reorder (ux.js) needs to repaint after moveQueue: the
  // render closure is not exported, so hang it off the node instead.
  ov._render = null;

  const rowHTML = (t, abs, upDown) => {
    const dur = t.duration || (t.duration_secs ? fmtTime(t.duration_secs) : "");
    return `<div class="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-surface-container/70 transition-colors" data-q-row="${abs}">
      ${
        t.image
          ? `<img src="${esc(hqArt(t.image))}" alt="" loading="lazy" class="w-10 h-10 rounded-lg object-cover shrink-0">`
          : `<span class="w-10 h-10 rounded-lg bg-surface-container-highest shrink-0"></span>`
      }
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-body-md text-[13px] text-on-surface font-semibold truncate">${esc(t.title || "Track")}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(t.artist || "")}${dur ? ` · ${esc(dur)}` : ""}</span>
      </div>
      ${
        upDown
          ? `<button type="button" data-q-up="${abs}" aria-label="Move up" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[20px]">arrow_upward</span></button>
        <button type="button" data-q-down="${abs}" aria-label="Move down" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[20px]">arrow_downward</span></button>`
          : ""
      }
      <button type="button" data-q-play="${abs}" aria-label="Play now" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[20px]">play_arrow</span></button>
    </div>`;
  };

  const render = () => {
    ov.querySelectorAll("[data-q-tab]").forEach((b) => {
      const on = b.dataset.qTab === tab;
      b.className = `flex-1 py-2 rounded-xl font-body-md text-[13px] font-semibold transition-all ${
        on ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
      }`;
    });
    const qi = currentIdx();
    const rows = tab === "next" ? upNext() : past();
    const base = tab === "next" ? qi + 1 : 0;
    if (!rows.length) {
      qList.innerHTML = `<p class="py-8 text-center font-body-sm text-[12px] text-secondary">${
        tab === "next" ? "Nothing up next" : "No history yet"
      }</p>`;
    } else {
      qList.innerHTML = rows.map((t, i) => rowHTML(t || {}, base + i, tab === "next")).join("");
    }
  };
  ov._render = render;

  ov.addEventListener("click", (e) => {
    if (!e.target || !e.target.closest) return;
    const tabBtn = e.target.closest("[data-q-tab]");
    if (tabBtn) {
      tab = tabBtn.dataset.qTab === "history" ? "history" : "next";
      render();
      return;
    }
    if (e.target.closest("[data-q-close]")) {
      ov.remove();
      return;
    }
    if (e.target.closest("[data-q-smart-shuffle]")) {
      try {
        smartShuffleQueue();
        toast("Smart-shuffled queue", 2500, "success");
        render();
      } catch (err) {
        console.error(err);
      }
      return;
    }
    if (e.target.closest("[data-q-save-pl]")) {
      const fq = fullQueue();
      if (!fq.length) {
        toast("The queue is empty", 2500, "info");
        return;
      }
      createPlaylistSheet(fq, `Queue ${new Date().toLocaleDateString()}`);
      return;
    }
    if (e.target.closest("[data-q-clear]")) {
      try {
        clearQueue(true);
      } catch {}
      toast("Queue cleared", 2500, "success");
      try {
        repaint();
      } catch {}
      render();
      return;
    }
    const up = e.target.closest("[data-q-up]");
    if (up) {
      const a = Number(up.dataset.qUp);
      if (Number.isInteger(a) && a > currentIdx() + 1) {
        try {
          moveQueue(a, a - 1);
        } catch {}
      }
      render();
      return;
    }
    const down = e.target.closest("[data-q-down]");
    if (down) {
      const a = Number(down.dataset.qDown);
      if (Number.isInteger(a) && a < fullQueue().length - 1) {
        try {
          moveQueue(a, a + 1);
        } catch {}
      }
      render();
      return;
    }
    const play = e.target.closest("[data-q-play]");
    if (play) {
      const a = Number(play.dataset.qPlay);
      if (Number.isInteger(a)) {
        try {
          playList(fullQueue(), a);
        } catch {}
      }
      ov.remove();
    }
  });
  render();
}

// ----------------------------------------------------------------- triggers

const KEBABS = ["more_vert", "more_horiz"];

export function isMenuTrigger(btn) {
  if (!btn || btn.tagName !== "BUTTON") return false;
  // Local-playlist row steppers/removers own their action — same trigger path.
  if (btn.closest("[data-pl-up],[data-pl-down],[data-pl-rm]")) return true;
  if (btn.id === "more-options-btn") return true;
  // NowPlaying's "+" is a picker, not a menu — same trigger path though.
  if (btn.id === "playlist-add-btn") return true;
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

/// Local-playlist detail rows carry [data-pl-up]/[data-pl-down]/[data-pl-rm]:
/// reorder/remove through the shared LIBRARY_KEY helpers, then remount the
/// current screen through the existing MOUNT import. Returns true when handled.
function playlistRowAction(btn) {
  const act = btn.closest ? btn.closest("[data-pl-up],[data-pl-down],[data-pl-rm]") : null;
  if (!act) return false;
  const row = act.closest("[data-list][data-idx]");
  const idx = Number(row ? row.dataset.idx : act.dataset.idx);
  if (!Number.isInteger(idx) || idx < 0) return true;
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const plId = act.dataset.plId || (row && row.dataset.plId) || qs.get("id") || "";
  if (!plId) {
    toast("Playlist not found", 4000, "error");
    return true;
  }
  let ok = false;
  if (act.hasAttribute("data-pl-up")) ok = movePlaylistTrack(plId, idx, idx - 1);
  else if (act.hasAttribute("data-pl-down")) ok = movePlaylistTrack(plId, idx, idx + 1);
  else {
    const track = row ? store[row.dataset.list]?.[+row.dataset.idx] : null;
    const tid = act.dataset.trackId || track?.id;
    if (tid) ok = removePlaylistTrack(plId, tid);
  }
  toast(ok ? "Playlist updated" : "Couldn't update playlist", ok ? 2500 : 4000, ok ? "success" : "error");
  if (ok) {
    try {
      const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
      (MOUNT[raw] || MOUNT["main-library"])?.();
    } catch {}
  }
  return true;
}

/// Resolve whatever a kebab belongs to and open the matching menu.
export function handleMenuTrigger(btn) {
  if (playlistRowAction(btn)) return;
  if (btn.id === "playlist-add-btn") {
    const current = playerState().track;
    if (!current) return toast("Nothing is playing");
    return addToPlaylist(current);
  }
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
    if (track) {
      // NowPlaying's Up Next rows get the queue context (Remove from Queue);
      // everything else keeps the history check it always had.
      const ctx = row.dataset.list === "npq" ? "queue" : location.hash.startsWith("#/history") ? "history" : null;
      return trackMenu(track, ctx, +row.dataset.idx);
    }
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
window.__tmOpenQueue = openQueue;
window.__tmCreatePlaylist = createPlaylistSheet;
window.__tmRenamePlaylist = renameLocalPlaylist;
window.__tmDeletePlaylist = deleteLocalPlaylist;
