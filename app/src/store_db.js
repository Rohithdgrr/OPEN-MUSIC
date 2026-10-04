// store_db.js — frontend wrapper over the Rust AppStore (`store.db`).
// Song metadata cache + small KV + persistent search cache. Works on desktop
// and mobile (import from "../store_db.js" there): it reads Tauri IPC off
// `window` directly so it never drags desktop `core.js` into the mobile shell.
//
// Contract: every call is best-effort. When the backend is missing (browser
// preview, disabled store) reads resolve to null/[] and writes resolve false,
// so callers keep their localStorage path without branching.

const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;

async function call(cmd, args) {
  if (!invoke) return null;
  try {
    return await invoke(cmd, args || {});
  } catch {
    return null;
  }
}

const slim = (t) =>
  t && typeof t === "object"
    ? {
        id: t.id || "",
        title: t.title || "",
        artist: t.artist || "",
        album: t.album || "",
        image: t.image || "",
        duration: t.duration || "",
        duration_secs: t.duration_secs || 0,
        hq: !!t.hq,
        plays: t.plays || 0,
        year: t.year || "",
        language: t.language || "",
        label: t.label || "",
        album_id: t.album_id || "",
        artist_ids: t.artist_ids || [],
        page_url: t.page_url || "",
      }
    : null;

/// Cache one song's metadata. Fire-and-forget from search/playlist paints.
export async function cacheSong(track) {
  const t = slim(track);
  if (!t || !t.id) return false;
  return (await call("store_song", { track: t })) !== null;
}

/// Cache a page of songs (search results, playlist loads). Chunked to 500.
export async function cacheSongs(tracks) {
  const list = (Array.isArray(tracks) ? tracks : []).map(slim).filter((t) => t && t.id);
  if (!list.length) return 0;
  const n = await call("store_songs", { tracks: list.slice(0, 500) });
  return typeof n === "number" ? n : 0;
}

/// Record one play (bumps SQLite counters). Returns the new play count, if any.
export async function recordPlay(track) {
  const t = slim(track);
  if (!t || !t.id) return null;
  const n = await call("store_play", { track: t });
  return typeof n === "number" ? n : null;
}

/// Mirror the favorite flag so offline fav lists survive without localStorage.
export async function mirrorFav(track, fav) {
  const t = slim(track);
  if (!t || !t.id) return false;
  return (await call("store_fav", { track: t, fav: !!fav })) !== null;
}

export async function getRecent(limit = 20) {
  const r = await call("store_recent", { limit });
  return Array.isArray(r) ? r : [];
}

export async function getStoredFavs(limit = 100) {
  const r = await call("store_favs", { limit });
  return Array.isArray(r) ? r : [];
}

export async function getMostPlayed(limit = 20) {
  const r = await call("store_most_played", { limit });
  return Array.isArray(r) ? r : [];
}

/// Small important prefs with a localStorage fallback (queue backup, position).
export async function kvGet(key, fallback = null) {
  const v = await call("store_kv_get", { key });
  if (typeof v === "string") return v;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export async function kvPut(key, value) {
  const ok = (await call("store_kv_put", { key, value: String(value) })) !== null;
  try {
    localStorage.setItem(key, String(value));
  } catch {}
  return ok;
}

export async function searchCacheGet(key) {
  return call("store_search_get", { key });
}

export async function searchCachePut(key, data) {
  return (await call("store_search_put", { key, data })) !== null;
}

// ---- lyrics cache (30d TTL) ----
export async function lyricsCacheGet(key) {
  return call("store_lyrics_get", { key });
}

export async function lyricsCachePut(key, data) {
  return (await call("store_lyrics_put", { key, data })) !== null;
}

// ---- entity cache (24h TTL) ----
export async function entityCacheGet(key) {
  return call("store_entity_get", { key });
}

export async function entityCachePut(key, data) {
  return (await call("store_entity_put", { key, data })) !== null;
}

// ---- offline outbox ----
export async function outboxPush(op, payload) {
  return call("outbox_push", { op, payload });
}

export async function outboxList(limit = 200) {
  return call("outbox_list", { limit });
}

export async function outboxAck(ids) {
  return call("outbox_ack", { ids });
}

export async function storeStats() {
  return call("store_stats", {});
}

export async function clearStoreCache() {
  return call("store_clear_cache", {});
}
