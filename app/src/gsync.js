// gsync.js — Phase 3: automatic Drive sync.
//
// The manual Sync now button (settings) and every automatic trigger share
// one engine: boot (delayed, so the UI settles first), network coming back,
// the tab becoming visible, and debounced local edits. Auto runs are silent
// (diag only) — toasts stay on the manual button.
//
// Local edits reach the engine with zero coupling: the save funnels
// (saveFavs, saveLocalPls, savePref, saveLangs) dispatch a
// `tm:local-change` DOM event, and the engine debounces that into a round.
import { diag, invoke } from "./core.js";
import {
  loadFavs,
  loadLocalPls,
  paintFavHearts,
  renderFavs,
  renderLibrary,
  saveFavs,
  saveLocalPls,
} from "./library.js";
import {
  BACKUP_APP,
  LAST_SYNC_KEY,
  SYNC_VERSION,
  applyBackup,
  autoSyncDue,
  buildBackup,
  mergeDocs,
  parseDocEnvelope,
  readSettings,
  splitBackupDoc,
  writeSettings,
} from "./sync.js";

export const LOCAL_CHANGE_EVENT = "tm:local-change";
const PUSH_DEBOUNCE_MS = 5000;
const BOOT_DELAY_MS = 8000;

let syncing = false;
let debounceTimer = 0;
let wired = false;

export function isSyncing() {
  return syncing;
}

function lastOk() {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

function stampOk() {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {}
}

/// Signed in, configured, and online — the only gate before any round.
async function eligible() {
  try {
    if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return false;
  } catch {}
  try {
    const s = await invoke("gdrive_status");
    return !!(s && s.configured && s.signed_in);
  } catch {
    return false;
  }
}

/// One pull-merge-push round shared by the button and the triggers:
/// push this machine's snapshot, pull whatever is newer elsewhere, merge
/// newest-wins, apply locally, push the converged result. Throws on the
/// first failure so callers can report it plainly.
export async function syncRound() {
  const docs = ["favorites", "playlists", "settings"];
  const snap = buildBackup(
    { favorites: loadFavs(), playlists: loadLocalPls(), settings: readSettings() },
    Date.now(),
  );
  for (const name of docs) {
    await invoke("gdrive_push", { doc: name, json: JSON.stringify(splitBackupDoc(snap)[name]) });
    diag("gdrive", true, `pushed ${name}`);
  }
  const remote = { app: BACKUP_APP, version: SYNC_VERSION, exportedAt: Date.now() };
  for (const name of docs) {
    const text = await invoke("gdrive_pull", { doc: name });
    if (text == null) {
      remote[name] = name === "settings" ? { records: {}, tombstones: [] } : { records: [], tombstones: [] };
      continue;
    }
    const env = parseDocEnvelope(text, name);
    remote[name] = { records: env.records, tombstones: env.tombstones || [] };
  }
  const merged = mergeDocs(snap, remote);
  const applied = applyBackup(merged);
  saveFavs(applied.favorites);
  saveLocalPls(applied.playlists);
  writeSettings(applied.settings);
  paintFavHearts();
  renderFavs();
  renderLibrary();
  const mergedParts = splitBackupDoc(merged);
  for (const name of docs) {
    await invoke("gdrive_push", { doc: name, json: JSON.stringify(mergedParts[name]) });
  }
  stampOk();
  return applied.counts;
}

async function autoRound(reason) {
  if (syncing) return;
  if (!(await eligible())) return;
  syncing = true;
  try {
    const counts = await syncRound();
    diag("gdrive", true, `auto-sync (${reason}): ${counts.favorites} favorites, ${counts.playlists} playlists`);
  } catch (err) {
    // Silent by design: a sleeping laptop with expired tokens must not
    // wake up to an error toast. The diag line + settings panel tell it.
    diag("gdrive", false, `auto-sync (${reason}): ${err}`);
  } finally {
    syncing = false;
  }
}

/// Idempotent: safe to call from boot and from tests of the wiring.
export function wireAutoSync() {
  if (wired) return;
  wired = true;
  window.addEventListener("online", () => {
    autoRound("online");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!autoSyncDue("visible", lastOk(), Date.now())) return;
    autoRound("visible");
  });
  window.addEventListener(LOCAL_CHANGE_EVENT, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      autoRound("edit");
    }, PUSH_DEBOUNCE_MS);
  });
}

/// Called once from main.js boot: wires the triggers, then syncs after
/// the UI has settled instead of racing first paint.
export function autoSyncBoot() {
  wireAutoSync();
  setTimeout(() => {
    autoRound("boot");
  }, BOOT_DELAY_MS);
}
