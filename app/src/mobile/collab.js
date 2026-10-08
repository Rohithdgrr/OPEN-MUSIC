// collab.js — collaborative-feel playlists without a server.
//
// Export: a playlist is serialized to a compact JSON envelope, base64url
// encoded and shared as text (TRANCE-SHARE v1). Anyone with the app pastes
// it back and gets the playlist recreated locally with full track objects,
// so it plays, queues and downloads exactly like their own.
// Import: paste the shared text into the Settings importer (or any prompt
// that hands text here) — decode, validate, createPlaylistSheet().
import { load, LIBRARY_KEY, toast, haptic } from "./shared.js";
import { esc } from "../html.js";
import { createPlaylistSheet } from "./menus.js";
import { encodePlaylist, decodeShared } from "./sharecode.js";
export { encodePlaylist, decodeShared };

export function localPlaylists() {
  try {
    const all = load(LIBRARY_KEY, []);
    return (Array.isArray(all) ? all : []).filter((p) => p && p.local && Array.isArray(p.tracks) && p.tracks.length);
  } catch {
    return [];
  }
}

export function importShared(text) {
  const data = decodeShared(text);
  if (!data) {
    toast("That doesn't look like a shared playlist", 4000, "error");
    return false;
  }
  try {
    haptic(12);
  } catch {}
  createPlaylistSheet(data.tracks, `${data.name}`);
  return true;
}

export function sharePlaylist(pl) {
  const code = encodePlaylist(pl);
  if (!code) {
    toast("Nothing to share yet", 3000, "error");
    return;
  }
  const title = pl.title || "Shared mix";
  try {
    haptic(12);
  } catch {}
  // shareThing lives in shared.js — dynamic import keeps collab.js out of
  // the critical boot path and avoids any import-order surprises.
  import("./shared.js")
    .then((m) => m.shareThing({ title: `${title} — OPEN MUSIC`, text: `${title} · ${pl.tracks.length} tracks. In OPEN MUSIC → Settings → Import shared playlist and paste this:\n\n${code}` }))
    .catch(() => {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast("Share code copied", 3000, "success"));
      } catch {}
    });
}

/* ------------------------------------------------ settings section */
function settingsHost(m) {
  const hosts = [...m.querySelectorAll("div.bg-surface-container-lowest")];
  return hosts.length ? hosts[hosts.length - 1] : null;
}

function sectionHTML(playlists) {
  const opts = playlists
    .map((p) => `<option value="${esc(p.id)}">${esc(p.title || "Playlist")} (${(p.tracks || []).length})</option>`)
    .join("");
  return `<div class="p-4 flex flex-col gap-3" data-collab-sec>
    <div class="flex items-center justify-between gap-4">
      <span class="flex flex-col min-w-0"><span class="font-body-md text-[14px] text-on-surface font-semibold tracking-tight">Shared playlists</span><span class="font-body-sm text-[12px] text-on-surface-variant truncate mt-0.5">Send a playlist to a friend — no account needed</span></span>
      <span class="material-symbols-outlined text-on-surface-variant">group_add</span>
    </div>
    ${
      playlists.length
        ? `<div class="flex gap-2"><select data-collab-pick class="flex-1 min-w-0 bg-surface-container rounded-xl px-3 py-2.5 text-[13px] text-on-surface">${opts}</select><button type="button" data-collab-share class="px-4 py-2.5 rounded-xl bg-primary text-on-primary text-[13px] font-semibold active:scale-[0.98]">Share</button></div>`
        : `<p class="font-body-sm text-[12px] text-secondary">Create a playlist first, then share it here.</p>`
    }
    <div class="flex gap-2"><input data-collab-paste placeholder="Paste a share code…" class="flex-1 min-w-0 bg-surface-container rounded-xl px-3 py-2.5 text-[13px] text-on-surface placeholder:text-secondary"><button type="button" data-collab-import class="px-4 py-2.5 rounded-xl bg-surface-container-high text-on-surface text-[13px] font-semibold active:scale-[0.98]">Import</button></div>
  </div>`;
}

function wireSection(sec) {
  const shareBtn = sec.querySelector("[data-collab-share]");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      const pick = sec.querySelector("[data-collab-pick]");
      const pl = localPlaylists().find((p) => p.id === (pick && pick.value));
      if (pl) sharePlaylist(pl);
      else toast("Pick a playlist first", 3000, "error");
    });
  }
  const importBtn = sec.querySelector("[data-collab-import]");
  if (importBtn) {
    importBtn.addEventListener("click", () => {
      const input = sec.querySelector("[data-collab-paste]");
      const ok = importShared(input && input.value);
      if (ok && input) input.value = "";
    });
  }
}

function enhanceSettings() {
  const m = document.getElementById("screen");
  if (!m || m.querySelector("[data-collab-sec]")) return;
  const host = settingsHost(m);
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = sectionHTML(localPlaylists());
  const sec = wrap.firstElementChild;
  if (!sec) return;
  host.appendChild(sec);
  wireSection(sec);
}

// Same ordering caveat as audioplus: poll for the prefs host instead of
// assuming it exists 150ms after the mount event.
function enhanceSettingsSoon() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try {
      const m = document.getElementById("screen");
      if (m && (m.querySelector("[data-collab-sec]") || settingsHost(m))) {
        clearInterval(timer);
        enhanceSettings();
      } else if (tries >= 10) clearInterval(timer);
    } catch {
      clearInterval(timer);
    }
  }, 400);
}

document.addEventListener("smount", (e) => {
  try {
    if (e && e.detail && (e.detail.key === "settings" || e.detail.dir === "settings")) {
      enhanceSettingsSoon();
    }
  } catch {}
});

// Deep-link import: a pasted code can route straight here.
window.__tmImportPlaylist = importShared;
window.__tmSharePlaylist = sharePlaylist;
