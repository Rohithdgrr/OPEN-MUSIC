// sync.js — Phase 1: portable backup/restore + CSV/M3U export.
//
// The same module carries the merge core Phase 3 (Google Drive sync) will
// reuse, so the schema is sync-ready from day one: every record carries an
// `updatedAt`, deletions are tombstones, and newest wins. Nothing here
// touches storage directly — callers pass data in and write the result with
// the existing saveFavs / saveLocalPls / localStorage calls, which keeps
// the local on-disk shape byte-identical to today and keeps this module
// importable from node tests (no window / localStorage at module scope).
export const SYNC_VERSION = 1;
export const BACKUP_APP = "trance-music-backup";
/// Mirrored by the Rust reader: a backup bigger than this is refused.
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/// When the last successful sync happened (written by the sync engine,
/// read by the settings panel and the visible-tab cooldown).
export const LAST_SYNC_KEY = "tm-gdrive-last-sync";
/// A tab that was hidden for less than this does not re-sync on return.
export const VISIBLE_SYNC_COOLDOWN_MS = 60_000;

/// Should an automatic trigger start a round? Pure so the policy is
/// unit-tested: "visible" is cooldown-gated, everything else (boot,
/// online, debounced edit) defers to eligibility + single-flight.
export function autoSyncDue(trigger, lastOkMs, nowMs) {
  if (trigger === "visible") return num(nowMs) - num(lastOkMs) >= VISIBLE_SYNC_COOLDOWN_MS;
  return true;
}

/// Only these localStorage keys travel in a backup. Everything ephemeral
/// (queue, position, plays, history, offsets, snapshots, update stamps)
/// stays on the machine it was made on.
export const SETTINGS_KEYS = [
  "tm-name",
  "tm-autostart",
  "tm-lang",
  "tm-country",
  "tm-net-mode",
  "tm-dl-quality",
  "tm-stream-quality",
  "tm-xfade",
  "tm-gapless",
  "tm-remember-pos",
  "tm-play-speed",
  "tm-theme",
  "tm-density",
  "tm-lyrics-autoscroll",
  "tm-lyrics-gloss",
  "tm-lyrics-size",
  "tm-desk-widget",
  "tm-desk-widget-mode",
  "tm-desk-widget-pos",
  "tm-vault-quota",
  "tm-prefetch",
  "tm-stream-wifi",
  "tm-stream-cell",
  "tm-data-saver",
  "tm-explicit-hide",
  "tm-eq-preset",
  "tm-normalize",
  "tm-smart-dl",
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/// Stamp a record list for a snapshot: existing numeric stamps survive
/// (they are the merge input later), everything else gets `now`.
export function stampRecords(items, now) {
  const t = num(now) || Date.now();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    out.push({ ...it, updatedAt: Number.isFinite(Number(it.updatedAt)) ? Number(it.updatedAt) : t });
  }
  return out;
}

/// Last-write-wins over two record lists plus tombstones, keyed by `id`.
/// A tombstone deletes when its stamp >= the record's; between two live
/// records the strictly-newer stamp wins; exact ties break toward the
/// lexicographically-greater JSON so two devices converge instead of
/// flip-flopping the record back and forth.
export function mergeRecords(localRecs = [], remoteRecs = [], tombstones = []) {
  const tombs = new Map();
  for (const t of Array.isArray(tombstones) ? tombstones : []) {
    if (!t || t.id == null) continue;
    const cur = tombs.get(t.id);
    if (!cur || num(t.updatedAt) > num(cur.updatedAt)) tombs.set(t.id, { id: t.id, updatedAt: num(t.updatedAt) });
  }
  const wins = (a, b) => {
    const d = num(a.updatedAt) - num(b.updatedAt);
    if (d !== 0) return d > 0;
    try {
      return JSON.stringify(a) > JSON.stringify(b);
    } catch {
      return false;
    }
  };
  const best = new Map();
  for (const r of [...(localRecs || []), ...(remoteRecs || [])]) {
    if (!r || typeof r !== "object" || r.id == null) continue;
    const cur = best.get(r.id);
    if (!cur || wins(r, cur)) best.set(r.id, r);
  }
  const out = [];
  for (const [id, rec] of best) {
    const tomb = tombs.get(id);
    if (tomb && tomb.updatedAt >= num(rec.updatedAt)) continue;
    out.push(rec);
  }
  return out;
}

/// Union two tombstone lists, newest stamp per id.
export function mergeTombstones(a = [], b = []) {
  const byId = new Map();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t || t.id == null) continue;
    const cur = byId.get(t.id);
    if (!cur || num(t.updatedAt) > num(cur.updatedAt)) byId.set(t.id, { id: t.id, updatedAt: num(t.updatedAt) });
  }
  return [...byId.values()];
}

function settingsToList(records) {
  return Object.entries(records || {})
    .filter(([k, v]) => typeof k === "string" && v && typeof v === "object")
    .map(([k, v]) => ({ id: k, value: v.value, updatedAt: num(v.updatedAt) }));
}

function settingsFromList(list) {
  const out = {};
  for (const r of list || []) {
    if (r && r.id != null) out[r.id] = { value: r.value, updatedAt: num(r.updatedAt) };
  }
  return out;
}

/// Settings through the same LWW path: keyed records in, keyed records
/// out. Used by the Drive pull-merge (Phase 2) and later auto-sync.
export function mergeSettings(localRecs = {}, remoteRecs = {}, tombstones = []) {
  const merged = mergeRecords(settingsToList(localRecs), settingsToList(remoteRecs), tombstones);
  return { records: settingsFromList(merged), tombstones: mergeTombstones([], tombstones) };
}

// ------------------------------------------------------- Drive envelopes -
// Drive holds one file per doc (`trance-music-{favorites,playlists,
// settings}.json`), each a small envelope around that section of the
// backup schema — so the merge core applies unchanged.
export function sectionEnvelope(docName, section, now) {
  const fallback = docName === "settings" ? {} : [];
  return {
    app: BACKUP_APP,
    version: SYNC_VERSION,
    doc: docName,
    exportedAt: num(now) || Date.now(),
    records: section && section.records !== undefined ? section.records : fallback,
    tombstones: (section && section.tombstones) || [],
  };
}

/// Split a full backup doc into its three pushable envelopes.
export function splitBackupDoc(doc) {
  const t = num(doc && doc.exportedAt) || Date.now();
  return {
    favorites: sectionEnvelope("favorites", doc && doc.favorites, t),
    playlists: sectionEnvelope("playlists", doc && doc.playlists, t),
    settings: sectionEnvelope("settings", doc && doc.settings, t),
  };
}

/// Structural check for one pulled envelope. Null when usable.
export function validateDocEnvelope(env, expectedDoc) {
  if (!env || typeof env !== "object") return "not a JSON object";
  if (env.app !== BACKUP_APP) return "not a TRANCE MUSIC sync doc";
  if (!Number.isInteger(env.version) || env.version < 1 || env.version > SYNC_VERSION)
    return `unsupported sync version ${String(env.version)}`;
  if (env.doc !== expectedDoc) return `expected the ${expectedDoc} doc, got ${String(env.doc)}`;
  const recs = env.records;
  const shaped =
    expectedDoc === "settings"
      ? recs && typeof recs === "object" && !Array.isArray(recs)
      : Array.isArray(recs);
  if (!shaped) return `the ${expectedDoc} records are malformed`;
  if (env.tombstones !== undefined && !Array.isArray(env.tombstones)) return "tombstones are malformed";
  return null;
}

/// Parse + validate one pulled envelope. Throws an Error with the reason.
export function parseDocEnvelope(text, expectedDoc) {
  let env;
  try {
    env = JSON.parse(String(text || ""));
  } catch {
    throw new Error(`the Drive ${expectedDoc} doc is not valid JSON`);
  }
  const problem = validateDocEnvelope(env, expectedDoc);
  if (problem) throw new Error(`the Drive ${expectedDoc} doc is unusable: ${problem}`);
  return env;
}

/// Merge two full backup docs (Phase 3 pull). Settings ride as keyed
/// records through the same LWW path as everything else.
export function mergeDocs(localDoc, remoteDoc) {
  const L = localDoc && typeof localDoc === "object" ? localDoc : {};
  const R = remoteDoc && typeof remoteDoc === "object" ? remoteDoc : {};
  const favT = mergeTombstones(L.favorites?.tombstones, R.favorites?.tombstones);
  const plT = mergeTombstones(L.playlists?.tombstones, R.playlists?.tombstones);
  const setT = mergeTombstones(L.settings?.tombstones, R.settings?.tombstones);
  return {
    app: BACKUP_APP,
    version: SYNC_VERSION,
    exportedAt: Date.now(),
    favorites: {
      records: mergeRecords(L.favorites?.records, R.favorites?.records, favT),
      tombstones: favT,
    },
    playlists: {
      records: mergeRecords(L.playlists?.records, R.playlists?.records, plT),
      tombstones: plT,
    },
    settings: {
      records: settingsFromList(
        mergeRecords(settingsToList(L.settings?.records), settingsToList(R.settings?.records), setT),
      ),
      tombstones: setT,
    },
  };
}

/// Snapshot the three scopes into one portable doc. `settings` is a plain
/// key->raw-value object (already filtered to SETTINGS_KEYS by the caller).
export function buildBackup({ favorites = [], playlists = [], settings = {} } = {}, now) {
  const t = num(now) || Date.now();
  const setRecs = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (typeof k === "string" && v !== undefined) setRecs[k] = { value: v, updatedAt: t };
  }
  return {
    app: BACKUP_APP,
    version: SYNC_VERSION,
    exportedAt: t,
    favorites: { records: stampRecords(favorites, t), tombstones: [] },
    playlists: { records: stampRecords(playlists, t), tombstones: [] },
    settings: { records: setRecs, tombstones: [] },
  };
}

/// Structural check before anything is applied. Returns null when the doc
/// is usable, otherwise a human-readable reason.
export function validateBackup(doc) {
  if (!doc || typeof doc !== "object") return "not a JSON object";
  if (doc.app !== BACKUP_APP) return `not a ${BACKUP_APP} file`;
  if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > SYNC_VERSION)
    return `unsupported backup version ${String(doc.version)}`;
  for (const section of ["favorites", "playlists"]) {
    const s = doc[section];
    if (!s || typeof s !== "object" || !Array.isArray(s.records)) return `backup section "${section}" is malformed`;
    for (const r of s.records) {
      if (!r || typeof r !== "object" || r.id == null) return `backup section "${section}" has a record without an id`;
    }
  }
  const st = doc.settings;
  if (!st || typeof st !== "object" || !st.records || typeof st.records !== "object")
    return 'backup section "settings" is malformed';
  return null;
}

/// Parse + validate backup file text. Throws an Error with the reason.
export function parseBackupFile(text) {
  let doc;
  try {
    doc = JSON.parse(String(text || ""));
  } catch {
    throw new Error("that file is not valid JSON");
  }
  const problem = validateBackup(doc);
  if (problem) throw new Error(`not a usable backup: ${problem}`);
  return doc;
}

function stripRecord(r) {
  const rest = { ...(r || {}) };
  delete rest.updatedAt;
  return rest;
}

/// Restore semantics: the file wins outright. Returns the plain local
/// shapes (sync metadata stripped, so on-disk storage is unchanged from
/// today) plus counts for the confirmation toast.
export function applyBackup(doc) {
  const favorites = (doc.favorites?.records || []).map(stripRecord);
  const playlists = (doc.playlists?.records || []).map(stripRecord);
  const settings = {};
  for (const [k, v] of Object.entries(doc.settings?.records || {})) {
    if (SETTINGS_KEYS.includes(k)) settings[k] = v && typeof v === "object" ? v.value : v;
  }
  return { favorites, playlists, settings, counts: { favorites: favorites.length, playlists: playlists.length } };
}

/// In-memory storage stand-in for tests; mirrors the localStorage surface
/// the settings glue uses.
export function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function defaultStore() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch {}
  return memStore();
}

/// Read the settings scope out of a storage. Values pass through untouched
/// (callers stored strings; JSON stays a string until its own loader).
export function readSettings(store = defaultStore()) {
  const out = {};
  for (const k of SETTINGS_KEYS) {
    let v = null;
    try {
      v = store.getItem(k);
    } catch {}
    if (v != null) out[k] = v;
  }
  return out;
}

/// Write a settings scope back. Returns the keys actually written.
export function writeSettings(settings, store = defaultStore()) {
  const written = [];
  for (const [k, v] of Object.entries(settings || {})) {
    if (!SETTINGS_KEYS.includes(k) || v === undefined) continue;
    try {
      store.setItem(k, String(v));
      written.push(k);
    } catch {}
  }
  return written;
}

// ------------------------------------------------------------ CSV export -
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/// One row per track, playlist name first — opens straight into Sheets /
/// Excel. Duration is whole seconds (trackSecs), empty when unknown.
export function playlistToCsv(pl) {
  const name = pl && pl.title != null ? String(pl.title) : "playlist";
  const lines = ["playlist_name,track_title,artist,album,duration_seconds"];
  for (const t of (pl && pl.tracks) || []) {
    if (!t || typeof t !== "object") continue;
    const secs = trackSecs(t);
    lines.push(
      [name, t.title || "", t.artist || "", t.album || "", secs >= 0 ? String(secs) : ""]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------ M3U export -
/// Seconds for one track: the numeric field first, then "m:ss" / "h:mm:ss"
/// text, else -1 (unknown — the M3U convention).
export function trackSecs(t) {
  const n = Number(t && t.duration_secs);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(String((t && t.duration) || "").trim());
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return -1;
}

/// #EXTM3U with one #EXTINF per track — VLC / foobar / Poweramp import it.
export function playlistToM3u(pl) {
  const lines = ["#EXTM3U"];
  for (const t of (pl && pl.tracks) || []) {
    if (!t || typeof t !== "object") continue;
    const artist = t.artist ? String(t.artist) : "Unknown";
    const title = t.title ? String(t.title) : "Unknown";
    lines.push(`#EXTINF:${trackSecs(t)},${artist} - ${title}`);
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ names -
/// `Monsoon Drive` -> `Monsoon Drive`; strips what filesystems refuse and
/// caps the length so the save dialog gets a sane suggestion.
export function playlistFilename(title, ext) {
  const clean = String(title || "playlist")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${clean || "playlist"}.${ext}`;
}

/// `trance-music-backup-20261003-143022.json` (local time, sortable).
export function backupFilename(now) {
  const d = new Date(num(now) || Date.now());
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `trance-music-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
