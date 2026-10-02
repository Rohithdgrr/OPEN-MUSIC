// vault.js — download pipeline and vault/downloads view
// Split from main.js (Phase 4 M1).
import { art } from "./art.js";
import { Channel, diag, esc, invoke, showError, toast } from "./core.js";
import { $, $$ } from "./dom.js";
import { playTrack, resultsSub, uniqById } from "./search.js";
import { queue, queueIndex } from "./queue.js";
import { fmtBytes, fmtTime } from "./util.js";

// ---------------------------------------------------------------- download -
/// Vault download bitrate. Owned here so vault never imports settings —
/// settings already reaches vault through home, the reverse edge would cycle.
export const DL_QUALITY_KEY = "tm-dl-quality";
export function prefDlQuality() {
  try {
    return localStorage.getItem(DL_QUALITY_KEY) || "96kbps";
  } catch {
    return "96kbps";
  }
}

/// `quiet` batches: no per-track toast/icon dance — the caller owns the button
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
    // Scoped progress stream for this one download (review 4.4): the
    // command gets a Channel instead of broadcasting to every listener.
    const progress = new Channel();
    progress.onmessage = (p) => {
      if (p.done) {
        activeDownloads.delete(p.id);
        refreshVault();
      } else {
        activeDownloads.set(p.id, { ...activeDownloads.get(p.id), ...p });
      }
      renderActive();
    };
    const out = await invoke("download_song", {
      id: track.id,
      quality: prefDlQuality(),
      onProgress: progress,
    });
    const path = out && out.path ? out.path : String(out);
    diag(`download ${track.id}`, true, out && out.duplicate_of ? `identical to ${out.duplicate_of}` : path);
    activeDownloads.delete(track.id);
    renderActive();
    refreshVault();
    if (out && out.duplicate_of) {
      // Content dedupe (SHA-256): an identical file already sits in the vault.
      if (quiet) return path;
      if (icon) icon.textContent = "check";
      toast(`"${track.title}" was already in the vault (identical file).`, "info", 3500);
      setTimeout(() => {
        if (icon) icon.textContent = original;
        if (btn) btn.disabled = false;
      }, 3500);
      return;
    }
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
// Live rows, keyed by song id, fed by each download's scoped progress
// Channel (created in downloadTrack, review 4.4).
export const activeDownloads = new Map();
export let vaultEntries = [];
export let vaultQuality = "all";
export let vaultQuery = "";
/// Fast membership check for the offline gate and the queue's ⬇ badges.
export const isDownloaded = (id) => vaultEntries.some((e) => e.id === id);

/// Bitrate a stored label carries, whatever the codec: `opus128` and
/// `128kbps` both read as 128, `unknown` as 0.
const kbpsOf = (quality) => Number(String(quality || "").replace(/\D/g, "")) || 0;

/// What the badge shows: an encoded file says Opus, a source rendition keeps
/// its own label.
const qualityLabel = (quality) => {
  const q = String(quality || "");
  return /^opus\d/.test(q) ? `Opus ${kbpsOf(q)} kbps` : q;
};

export function entryTrack(e) {
  return {
    id: e.id,
    title: e.title,
    artist: e.artist,
    album: e.album,
    image: e.image,
    duration: fmtTime(e.duration_secs || 0),
    duration_secs: e.duration_secs || 0,
    hq: kbpsOf(e.quality) >= 320,
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
        <div class="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-primary/80 backdrop-blur-md text-on-primary font-label-mono text-[9px] uppercase tracking-wider">${esc(qualityLabel(p.quality))}</div>
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <div class="truncate">
            <h3 class="font-headline-md text-body-lg font-medium text-on-surface truncate" dir="auto">${esc(p.title)}</h3>
            <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([p.artist, p.album].filter(Boolean).join(" • "))}</p>
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
    const full = kbpsOf(e.quality) >= 320;
    if (vaultQuality === "320kbps" && !full) return false;
    if (vaultQuality === "other" && full) return false;
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
          <span class="font-headline-md text-body-lg font-medium text-on-surface truncate" dir="auto">${esc(e.title)}</span>
          <span class="font-label-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface shrink-0">${esc(qualityLabel(e.quality))}</span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant truncate">${esc([e.artist, e.album].filter(Boolean).join(" • "))}</p>
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
    // Bar fills against the enforced quota when one is set, else the display ceiling.
    const cap = vaultQuotaBytes();
    const base = cap || 100 * 1024 * 1024 * 1024;
    const pct = Math.min(100, (total / base) * 100);
    bar.style.width = `${Math.max(total ? 1 : 0, pct)}%`;
    bar.classList.toggle("bg-error", !!cap && total > cap);
  }
}

export function renderVault() {
  const list = $("#dl-vault");
  if (!list) return;
  const shown = visibleVault();
  const summary = $("#dl-summary");
  if (summary) {
    summary.textContent = !vaultEntries.length
      ? "Nothing saved yet — hit the download icon on any track."
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
    if (dir) dir.textContent = (vault && vault.dir) || "—";
    renderVault();
    diag("vault", true, `${vaultEntries.length} saved`);
    await enforceQuota();
  } catch (err) {
    diag("vault", false, String(err));
    showError(`Could not read the downloads vault: ${err}`);
  }
}

// ------------------------------------------------------------ quota & LRU -
export function vaultQuotaBytes() {
  const gb = Number(localStorage.getItem("tm-vault-quota") || 0);
  return gb > 0 ? gb * 1024 * 1024 * 1024 : 0;
}

/// Last-played timestamp per id (most recent first), read straight from the
/// plays ledger so this module stays import-cycle free.
function lastPlayedMap() {
  const map = new Map();
  try {
    for (const t of JSON.parse(localStorage.getItem("tm-plays") || "[]")) {
      if (t && t.id && !map.has(t.id)) map.set(t.id, t.ts || 0);
    }
  } catch {}
  return map;
}

let enforcing = false;
/// Over quota → evict least-recently-played tracks (oldest added as the
/// tie-break) until back under, never touching the track playing now.
async function enforceQuota() {
  const cap = vaultQuotaBytes();
  if (!cap || enforcing || !vaultEntries.length) return;
  let total = vaultEntries.reduce((n, e) => n + (e.bytes || 0), 0);
  if (total <= cap) return;
  enforcing = true;
  try {
    const played = lastPlayedMap();
    const currentId = queue[queueIndex] && queue[queueIndex].track ? queue[queueIndex].track.id : null;
    const victims = vaultEntries
      .filter((e) => e.id !== currentId && !activeDownloads.has(e.id))
      .map((e) => ({ e, t: played.get(e.id) || e.at || 0 }))
      .sort((a, b) => a.t - b.t);
    let evicted = 0;
    for (const { e } of victims) {
      if (total <= cap) break;
      try {
        await invoke("remove_download", { path: e.path });
        total -= e.bytes || 0;
        evicted += 1;
      } catch (err) {
        diag("quota", false, String(err));
      }
    }
    if (evicted) {
      toast(
        `Vault over quota: evicted ${evicted} least-recently played track${evicted === 1 ? "" : "s"}.`,
        "info",
        4500,
      );
      diag("quota", true, `evicted ${evicted} for space`);
      await refreshVault();
    }
  } finally {
    enforcing = false;
  }
}

// ------------------------------------------------------- predictive prefetch -
/// Spec 3.3: start pulling the next queued track while the current one
/// plays. Quiet by design — failures stay invisible.
export function prefetchTrack(track) {
  if (!track || !track.id) return;
  if (localStorage.getItem("tm-prefetch") === "0") return;
  if (vaultEntries.some((e) => e.id === track.id) || activeDownloads.has(track.id)) return;
  diag("prefetch", null, track.title);
  downloadTrack(track, null, true).catch(() => {});
}

/// Design L5: warm the backend's resolve + stream-url probe for the next
/// few queued tracks so play/next starts from a cache hit instead of a
/// mirror round trip. Metadata only — it complements prefetchTrack above
/// (which saves bytes to the vault) and never touches the prefs toggle.
export function prefetchNext(tracks) {
  const ids = (tracks || []).map((t) => t && t.id).filter(Boolean).slice(0, 4);
  if (!ids.length) return;
  invoke("prefetch_next", { ids }).catch((err) => diag("prefetch-next", false, String(err)));
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

// Vault option widgets: quota select + prefetch toggle (spec 3.3).
const quotaSel = $("#dl-quota");
if (quotaSel) {
  quotaSel.value = localStorage.getItem("tm-vault-quota") || "";
  quotaSel.addEventListener("change", () => {
    localStorage.setItem("tm-vault-quota", quotaSel.value);
    toast(
      quotaSel.value
        ? `Vault quota set to ${quotaSel.value} GB — least-recently played tracks evict first.`
        : "Vault quota off.",
      "info",
      3500,
    );
    renderStorage();
    enforceQuota();
  });
}
const prefetchBox = $("#dl-prefetch");
if (prefetchBox) {
  prefetchBox.checked = localStorage.getItem("tm-prefetch") !== "0";
  prefetchBox.addEventListener("change", () => {
    localStorage.setItem("tm-prefetch", prefetchBox.checked ? "1" : "0");
    toast(prefetchBox.checked ? "Prefetch on — the next queued track downloads while you listen." : "Prefetch off.", "info", 3000);
  });
}

// ------------------------------------------- manifest export / import / verify -
/// Spec 3.3: the vault index (with SHA-256 checksums) as portable JSON.
$("#dl-export")?.addEventListener("click", () => {
  if (!vaultEntries.length) {
    toast("The vault is empty — nothing to export.", "info");
    return;
  }
  const manifest = JSON.stringify(
    {
      app: "TRANCE MUSIC",
      kind: "vault-manifest",
      version: 1,
      exported_at: Math.floor(Date.now() / 1000),
      entries: vaultEntries,
    },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([manifest], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "trance-vault-manifest.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Exported ${vaultEntries.length} entries.`, "success");
  diag("manifest", true, `exported ${vaultEntries.length}`);
});

$("#dl-import")?.addEventListener("click", () => $("#dl-import-file")?.click());
$("#dl-import-file")?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const entries = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(entries) || !entries.length) {
      toast("That file has no manifest entries.", "error");
      return;
    }
    const rep = await invoke("import_manifest", { entries });
    await refreshVault();
    toast(
      `Imported ${rep.added} track${rep.added === 1 ? "" : "s"} (${rep.missing} file${rep.missing === 1 ? "" : "s"} missing on disk).`,
      rep.added ? "success" : "info",
      5000,
    );
    diag("manifest", rep.added > 0, `+${rep.added}/${entries.length}`);
  } catch (err) {
    showError(`Import failed: ${String(err).slice(0, 140)}`);
  }
});

/// Spec 3.3: re-hash every file against its recorded SHA-256 checksum.
$("#dl-verify")?.addEventListener("click", async () => {
  if (!vaultEntries.length) {
    toast("The vault is empty.", "info");
    return;
  }
  const btn = $("#dl-verify");
  if (btn) btn.disabled = true;
  try {
    const rep = await invoke("verify_vault");
    diag("verify", !rep.mismatch, `${rep.ok} ok · ${rep.mismatch} bad · ${rep.missing} missing`);
    if (rep.mismatch) {
      toast(
        `${rep.ok} verified · ${rep.mismatch} CHECKSUM MISMATCH · ${rep.missing} missing — delete and re-download the bad ones.`,
        "error",
        7000,
      );
    } else if (rep.missing) {
      toast(`${rep.ok} verified · ${rep.missing} file${rep.missing === 1 ? "" : "s"} missing on disk.`, "info", 5000);
    } else {
      toast(`All ${rep.ok} files verified (SHA-256).`, "success", 3500);
    }
    await refreshVault();
  } catch (err) {
    showError(`Verify failed: ${String(err).slice(0, 140)}`);
  }
  if (btn) btn.disabled = false;
});

$("#dl-open-vault")?.addEventListener("click", async () => {
  try {
    await invoke("reveal_vault");
  } catch (err) {
    showError(String(err));
  }
});

