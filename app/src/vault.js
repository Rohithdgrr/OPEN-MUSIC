// vault.js — download pipeline and vault/downloads view
// Split from main.js (Phase 4 M1).
import { art } from "./art.js";
import { diag, esc, invoke, showError, toast } from "./core.js";
import { $, $$ } from "./dom.js";
import { playTrack, resultsSub, uniqById } from "./search.js";
import { fmtBytes, fmtTime } from "./util.js";

// ---------------------------------------------------------------- download -
/// `quiet` batches: no per-track toast/icon dance â€” the caller owns the button
/// and reports the summary; failures are rethrown so the batch can count them.
export async function downloadTrack(track, btn, quiet = false) {
  if (!track) return;
  if (activeDownloads.has(track.id)) {
    toast(`"${track.title}" is already downloading.`, "info");
    return;
  }
  const icon = btn ? btn.querySelector(".material-symbols-outlined") : null;
  const original = icon ? icon.textContent : "";
  if (icon) icon.textContent = "progress_activity";
  if (btn) btn.disabled = true;
  diag(`download ${track.id}`, null, track.title);
  activeDownloads.set(track.id, {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    image: track.image,
    quality: track.hq ? "320 kbps" : "Standard",
    received: 0,
    total: null,
    done: false,
  });
  renderActive();
  try {
    const path = await invoke("download_song", { id: track.id });
    diag(`download ${track.id}`, true, path);
    activeDownloads.delete(track.id);
    renderActive();
    refreshVault();
    if (quiet) return path;
    if (icon) icon.textContent = "check";
    toast(`Saved "${track.title}" to the offline vault.`, "success");
    const previous = resultsSub.textContent;
    resultsSub.textContent = `Saved to ${path}`;
    setTimeout(() => {
      if (icon) icon.textContent = original;
      if (btn) btn.disabled = false;
      if (resultsSub.textContent.startsWith("Saved to")) resultsSub.textContent = previous;
    }, 5000);
  } catch (err) {
    activeDownloads.delete(track.id);
    renderActive();
    if (icon) icon.textContent = original;
    if (btn) btn.disabled = false;
    diag(`download ${track.id}`, false, String(err));
    if (quiet) throw err;
    showError(`Download failed: ${err}`);
    toast(`Download failed: ${String(err).slice(0, 140)}`, "error", 6000);
  }
}

/// One click saves the whole album/movie/playlist: walks the list sequentially
/// with n/total on the button, skipping whatever is already in the vault or
/// currently downloading, and survives individual track failures.
export let dlBatch = false;
export async function downloadAll(items, what, btn) {
  const list = (items || []).filter((t) => t && t.id);
  if (!list.length) {
    toast("Nothing to download yet.", "info");
    return;
  }
  if (dlBatch) {
    toast("A batch download is already running.", "info");
    return;
  }
  dlBatch = true;
  const icon = btn?.querySelector(".material-symbols-outlined");
  const labelEl = btn && btn.lastElementChild !== icon ? btn.lastElementChild : null;
  const originalIcon = icon ? icon.textContent : "";
  const originalLabel = labelEl ? labelEl.textContent : "";
  const restore = (mark) => {
    if (icon) {
      icon.textContent = mark;
      setTimeout(() => {
        icon.textContent = originalIcon;
      }, 4000);
    }
    if (labelEl)
      setTimeout(() => {
        labelEl.textContent = originalLabel;
      }, 4000);
    if (btn) btn.disabled = false;
    dlBatch = false;
  };
  if (btn) btn.disabled = true;
  if (icon) icon.textContent = "progress_activity";
  // Fresh vault list: a restart must not re-download what is already saved.
  await refreshVault();
  const saved = new Set(vaultEntries.map((e) => e.id));
  const todo = list.filter((t) => !saved.has(t.id) && !activeDownloads.has(t.id));
  if (!todo.length) {
    restore("check");
    toast(`All ${list.length} ${what} are already in the offline vault.`, "info");
    return;
  }
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < todo.length; i++) {
    if (labelEl) labelEl.textContent = `${i + 1}/${todo.length}`;
    if (icon) icon.textContent = "progress_activity";
    try {
      await downloadTrack(todo[i], null, true);
      ok++;
    } catch {
      fail++;
    }
  }
  restore(fail ? "error" : "check");
  diag("download-all", !fail, `${ok}/${todo.length} ${what}`);
  if (fail) toast(`Saved ${ok} of ${todo.length} ${what} (${fail} failed).`, "error", 6000);
  else toast(`Saved all ${ok} ${what} to the offline vault.`, "success");
}

// --------------------------------------------------------------- downloads -
// Live rows, keyed by song id, fed by the backend `download-progress` events.
export const activeDownloads = new Map();
export let vaultEntries = [];
export let vaultQuality = "all";
export let vaultQuery = "";

export function entryTrack(e) {
  return {
    id: e.id,
    title: e.title,
    artist: e.artist,
    album: e.album,
    image: e.image,
    duration: fmtTime(e.duration_secs || 0),
    duration_secs: e.duration_secs || 0,
    hq: e.quality === "320kbps",
  };
}

export function relTime(unix) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - (unix || 0));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function activeCard(p) {
  const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : 0;
  return `
  <article class="p-4 rounded-xl bg-surface-container-lowest shadow-sm flex flex-col gap-4 hover:shadow-md transition-shadow">
    <div class="flex items-start gap-4">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 bg-surface-container">
        <img class="w-full h-full object-cover" ${art(p.image)} alt="" />
        <div class="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-primary/80 backdrop-blur-md text-on-primary font-label-mono text-[9px] uppercase tracking-wider">${esc(p.quality)}</div>
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <div class="truncate">
            <h3 class="font-headline-md text-body-lg font-medium text-on-surface truncate">${esc(p.title)}</h3>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([p.artist, p.album].filter(Boolean).join(" â€¢ "))}</p>
          </div>
          <span class="font-label-mono text-label-mono px-2 py-0.5 rounded bg-surface-container-high text-on-surface shrink-0">${Math.round(pct)}%</span>
        </div>
        <div class="mt-2.5 grid grid-cols-2 gap-2 font-label-mono text-label-mono text-on-surface-variant">
          <div>
            <span class="block text-[9px] uppercase text-outline">Payload</span>
            <span class="text-on-surface">${fmtBytes(p.received)} / ${p.total ? fmtBytes(p.total) : "?"}</span>
          </div>
          <div>
            <span class="block text-[9px] uppercase text-outline">Destination</span>
            <span class="text-on-surface">Offline vault</span>
          </div>
        </div>
      </div>
    </div>
    <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden flex">
      <div class="h-full bg-primary rounded-full transition-all duration-300" style="width: ${pct}%"></div>
    </div>
  </article>`;
}

export function renderActive() {
  const section = $("#dl-active-section");
  const grid = $("#dl-active");
  if (!section || !grid) return;
  const list = [...activeDownloads.values()];
  section.classList.toggle("hidden", list.length === 0);
  const label = $("#dl-active-label");
  if (label) {
    label.textContent = list.length
      ? `${list.length} stream${list.length === 1 ? "" : "s"} in transit`
      : "Vault idle";
  }
  const dot = $("#dl-pipeline-dot");
  if (dot) {
    dot.classList.toggle("bg-primary", list.length > 0);
    dot.classList.toggle("animate-pulse", list.length > 0);
    dot.classList.toggle("bg-surface-container-highest", list.length === 0);
  }
  const count = $("#dl-active-count");
  if (count) count.textContent = `${list.length} active`;
  grid.innerHTML = list.map(activeCard).join("");
}

export function visibleVault() {
  return vaultEntries.filter((e) => {
    if (vaultQuality === "320kbps" && e.quality !== "320kbps") return false;
    if (vaultQuality === "other" && e.quality === "320kbps") return false;
    if (!vaultQuery) return true;
    return [e.title, e.artist, e.album].join(" ").toLowerCase().includes(vaultQuery);
  });
}

export function vaultRow(e) {
  return `
  <div class="vault-row flex items-center justify-between p-4 rounded-lg bg-surface-container-lowest hover:bg-surface-container-low transition-colors shadow-sm group" data-dl-path="${esc(e.path)}">
    <div class="flex items-center gap-4 min-w-0">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 bg-surface-container shadow-sm">
        <img class="w-full h-full object-cover" ${art(e.image)} alt="" />
        <button type="button" data-dl="play" title="Play now" class="absolute inset-0 bg-primary/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-on-primary">
          <span class="material-symbols-outlined text-[20px]">play_arrow</span>
        </button>
      </div>
      <div class="flex flex-col min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-headline-md text-body-lg font-medium text-on-surface truncate">${esc(e.title)}</span>
          <span class="font-label-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface shrink-0">${esc(e.quality)}</span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([e.artist, e.album].filter(Boolean).join(" â€¢ "))}</p>
      </div>
    </div>
    <div class="flex items-center gap-4 shrink-0">
      <div class="hidden sm:flex flex-col items-end font-label-mono text-label-mono">
        <span class="text-on-surface font-medium">${fmtBytes(e.bytes)}</span>
        <span class="text-on-surface-variant text-[10px]">${fmtTime(e.duration_secs || 0)}</span>
      </div>
      <span class="hidden md:inline font-label-mono text-label-mono text-on-surface-variant">${relTime(e.at)}</span>
      <div class="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
        <button type="button" data-dl="play" title="Play now" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">play_arrow</span>
        </button>
        <button type="button" data-dl="folder" title="Show in folder" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">folder_open</span>
        </button>
        <button type="button" data-dl="delete" title="Delete from disk" class="w-8 h-8 rounded hover:bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    </div>
  </div>`;
}

export function renderStorage() {
  const total = vaultEntries.reduce((n, e) => n + (e.bytes || 0), 0);
  const count = $("#dl-count");
  if (count) count.textContent = `${vaultEntries.length} track${vaultEntries.length === 1 ? "" : "s"}`;
  const alloc = $("#dl-alloc");
  if (alloc) alloc.textContent = `${total ? fmtBytes(total) : "0 B"} vaulted`;
  const bar = $("#dl-bar");
  if (bar) {
    // ponytail: 100 GB ceiling is a display constant, not an enforced quota
    const pct = Math.min(100, (total / (100 * 1024 * 1024 * 1024)) * 100);
    bar.style.width = `${Math.max(total ? 1 : 0, pct)}%`;
  }
}

export function renderVault() {
  const list = $("#dl-vault");
  if (!list) return;
  const shown = visibleVault();
  const summary = $("#dl-summary");
  if (summary) {
    summary.textContent = !vaultEntries.length
      ? "Nothing saved yet â€” hit the download icon on any track."
      : shown.length === vaultEntries.length
        ? `${vaultEntries.length} song${vaultEntries.length === 1 ? "" : "s"} on disk, ready to play offline.`
        : `${shown.length} of ${vaultEntries.length} songs match.`;
  }
  list.innerHTML = shown.length
    ? shown.map(vaultRow).join("")
    : `<p class="font-body-sm text-body-sm text-on-surface-variant p-4 rounded-lg bg-surface-container-lowest shadow-sm">${vaultEntries.length ? "No songs match this filter." : "The vault is empty."}</p>`;
  renderStorage();
}

export async function refreshVault() {
  try {
    const vault = await invoke("list_downloads");
    // Id collision = same song recorded twice (legacy manifests); show one.
    vaultEntries = uniqById((vault && vault.entries) || []);
    const dir = $("#dl-dir");
    if (dir) dir.textContent = (vault && vault.dir) || "â€”";
    renderVault();
    diag("vault", true, `${vaultEntries.length} saved`);
  } catch (err) {
    diag("vault", false, String(err));
    showError(`Could not read the downloads vault: ${err}`);
  }
}

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event
    .listen("download-progress", (event) => {
      const p = event.payload;
      if (p.done) {
        activeDownloads.delete(p.id);
        refreshVault();
      } else {
        activeDownloads.set(p.id, { ...activeDownloads.get(p.id), ...p });
      }
      renderActive();
    })
    .catch((err) => diag("download-progress", false, String(err)));
}

$("#dl-vault")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-dl]");
  if (!btn) return;
  const row = btn.closest("[data-dl-path]");
  const entry = vaultEntries.find((x) => x.path === row?.dataset.dlPath);
  if (!entry) return;
  const action = btn.dataset.dl;

  if (action === "play") {
    playTrack(entryTrack(entry));
    return;
  }
  if (action === "folder") {
    try {
      await invoke("reveal_download", { path: entry.path });
      diag("vault", true, "revealed in folder");
    } catch (err) {
      showError(String(err));
    }
    return;
  }
  if (action === "delete") {
    // Two clicks instead of a modal: nothing is removed by the first one.
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.title = "Click again to delete";
      btn.classList.add("text-error");
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.title = "Delete from disk";
        btn.classList.remove("text-error");
      }, 3000);
      return;
    }
    try {
      await invoke("remove_download", { path: entry.path });
      diag("vault", true, `deleted ${entry.title}`);
      refreshVault();
    } catch (err) {
      showError(String(err));
    }
  }
});

$("#dl-filter")?.addEventListener("click", (e) => {
  const pill = e.target.closest(".dl-pill");
  if (!pill) return;
  vaultQuality = pill.dataset.quality;
  for (const p of $$(".dl-pill")) {
    const on = p === pill;
    p.classList.toggle("bg-surface-container-lowest", on);
    p.classList.toggle("text-on-surface", on);
    p.classList.toggle("shadow-sm", on);
    p.classList.toggle("text-on-surface-variant", !on);
  }
  renderVault();
});

$("#dl-search")?.addEventListener("input", () => {
  vaultQuery = $("#dl-search").value.trim().toLowerCase();
  renderVault();
});

$("#dl-refresh")?.addEventListener("click", refreshVault);

$("#dl-open-vault")?.addEventListener("click", async () => {
  try {
    await invoke("reveal_vault");
  } catch (err) {
    showError(String(err));
  }
});

