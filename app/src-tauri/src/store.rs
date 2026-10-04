//! App database (`store.db`): song metadata cache + important KV + search cache.
//!
//! Why a second SQLite DB instead of reusing the vault ledger (`db.rs`)?
//! * `downloads.db` is the source of truth for user files — clearing a cache
//!   must never risk it.
//! * This store is disposable by construction: drop `store.db` and the app
//!   re-fetches everything from the network. Audio bytes are NEVER stored
//!   here, only track JSON + counters (play count, fav flag, last played).
//!
//! Tables:
//! * `songs` — one row per song id, full frontend track JSON in `data` plus
//!   queryable columns for recent / most-played / favorites.
//! * `kv` — small important prefs that must survive localStorage eviction
//!   (queue backup, last position, onboarding flags). Big blobs stay out.
//! * `search_cache` — persistent L1: query key -> SearchPage JSON, 6h TTL,
//!   capped at 200 rows so offline restarts still show results.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS songs (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    artist        TEXT NOT NULL DEFAULT '',
    album         TEXT NOT NULL DEFAULT '',
    image         TEXT NOT NULL DEFAULT '',
    duration_secs INTEGER NOT NULL DEFAULT 0,
    language      TEXT NOT NULL DEFAULT '',
    year          TEXT NOT NULL DEFAULT '',
    data          TEXT NOT NULL DEFAULT '{}',
    play_count    INTEGER NOT NULL DEFAULT 0,
    last_played   INTEGER NOT NULL DEFAULT 0,
    is_fav        INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS search_cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lyrics_cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entities (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    op         TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_songs_last_played ON songs(last_played DESC);
CREATE INDEX IF NOT EXISTS idx_songs_fav ON songs(is_fav, last_played DESC);
CREATE INDEX IF NOT EXISTS idx_songs_plays ON songs(play_count DESC);
";

/// Search rows older than this are stale (matches L1 metadata TTL, 6h).
pub const SEARCH_TTL_SECS: i64 = 6 * 60 * 60;
/// Hard cap: newest 200 queries survive, older evicted on write.
const SEARCH_CAP: i64 = 200;
/// Lyrics barely change: 30-day TTL, 1000 newest rows.
pub const LYRICS_TTL_SECS: i64 = 30 * 24 * 60 * 60;
const LYRICS_CAP: i64 = 1000;
const LYRICS_MAX_BYTES: usize = 128 * 1024;
/// Detail payloads (album / playlist / artist) refresh daily, 300 rows cap.
pub const ENTITY_TTL_SECS: i64 = 24 * 60 * 60;
const ENTITY_CAP: i64 = 300;
const ENTITY_MAX_BYTES: usize = 512 * 1024;
/// Pending offline ops (Drive-sync requests). FIFO, 500 cap; a cache clear
/// must never drop them — they are user intent, not fetched data.
const OUTBOX_CAP: i64 = 500;
const OUTBOX_OP_MAX: usize = 32;
const OUTBOX_PAYLOAD_MAX: usize = 4 * 1024;
/// Songs table safety valve: prune cold rows past this size.
const SONGS_CAP: i64 = 5000;
/// KV value size guard: prefs, not playlists (those live in localStorage +
/// backup files). 64 KB is generous for a queue snapshot.
pub const KV_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SongRow {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub image: String,
    pub duration_secs: u64,
    pub language: String,
    pub year: String,
    /// The exact track JSON the frontend cached (merged with counters).
    pub data: serde_json::Value,
    pub play_count: u64,
    pub last_played: u64,
    pub is_fav: bool,
    pub updated_at: u64,
}

pub struct AppStore {
    conn: Mutex<Connection>,
    #[allow(dead_code)]
    path: PathBuf,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn u64_field(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as i64)
        .unwrap_or(0)
}

impl AppStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create store dir {}: {e}", parent.display()))?;
        }
        let existed = path.exists();
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
            .map_err(|e| format!("wal mode: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("sync mode: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("schema: {e}"))?;
        conn.query_row("SELECT count(*) FROM songs", [], |_| Ok(()))
            .map_err(|e| format!("store db: {e}"))?;
        let store = Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        };
        if !existed {
            // Fresh file: nothing to migrate.
        }
        Ok(store)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        Ok(self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }

    // ------------------------------------------------------------ songs ---

    /// Cache one song's metadata (upsert, counters preserved). Audio bytes are
    /// never accepted here — `data` is track JSON only.
    pub fn put_song(&self, track: &serde_json::Value) -> Result<(), String> {
        let id = str_field(track, "id");
        if id.is_empty() || id.len() > 64 {
            return Err("song needs an id".into());
        }
        let data_str = serde_json::to_string(track).map_err(|e| e.to_string())?;
        if data_str.len() > 32 * 1024 {
            return Err("track JSON too large for song cache".into());
        }
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached(
            "INSERT INTO songs (id, title, artist, album, image, duration_secs, language, year, data, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, artist=excluded.artist, album=excluded.album,
               image=excluded.image, duration_secs=excluded.duration_secs,
               language=excluded.language, year=excluded.year,
               data=excluded.data, updated_at=excluded.updated_at",
        )
        .and_then(|mut s| {
            s.execute(params![
                id,
                str_field(track, "title"),
                str_field(track, "artist"),
                str_field(track, "album"),
                str_field(track, "image"),
                u64_field(track, "duration_secs"),
                str_field(track, "language"),
                str_field(track, "year"),
                data_str,
                now,
            ])
        })
        .map_err(|e| format!("song put: {e}"))?;
        drop(conn);
        self.prune_songs();
        Ok(())
    }

    pub fn put_songs(&self, tracks: &[serde_json::Value]) -> Result<usize, String> {
        let mut ok = 0;
        for t in tracks.iter().take(500) {
            if self.put_song(t).is_ok() {
                ok += 1;
            }
        }
        Ok(ok)
    }

    /// Record one play: upsert metadata + bump counters. Returns play count.
    pub fn record_play(&self, track: &serde_json::Value) -> Result<u64, String> {
        self.put_song(track)?;
        let id = str_field(track, "id");
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached(
            "UPDATE songs SET play_count = play_count + 1, last_played = ?1, updated_at = ?1 WHERE id = ?2",
        )
        .and_then(|mut s| s.execute(params![now, id]))
        .map_err(|e| format!("play record: {e}"))?;
        let count: i64 = conn
            .query_row(
                "SELECT play_count FROM songs WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(1);
        Ok(count.max(0) as u64)
    }

    pub fn set_fav(&self, track: &serde_json::Value, fav: bool) -> Result<(), String> {
        self.put_song(track)?;
        let id = str_field(track, "id");
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached("UPDATE songs SET is_fav = ?1, updated_at = ?2 WHERE id = ?3")
            .and_then(|mut s| s.execute(params![if fav { 1 } else { 0 }, now, id]))
            .map_err(|e| format!("fav set: {e}"))?;
        Ok(())
    }

    pub fn get_song(&self, id: &str) -> Result<Option<SongRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare_cached("SELECT id, title, artist, album, image, duration_secs, language, year, data, play_count, last_played, is_fav, updated_at FROM songs WHERE id = ?1")
            .map_err(|e| format!("song get: {e}"))?;
        stmt.query_row(params![id], row_to_song)
            .optional()
            .map_err(|e| format!("song get: {e}"))
    }

    fn list_songs(&self, sql: &str, limit: i64) -> Result<Vec<SongRow>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare_cached(sql)
            .map_err(|e| format!("songs list: {e}"))?;
        let rows = stmt
            .query_map(params![limit.max(1).min(200)], row_to_song)
            .map_err(|e| format!("songs list: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("songs list: {e}"))
    }

    pub fn recent(&self, limit: i64) -> Result<Vec<SongRow>, String> {
        self.list_songs(
            "SELECT id, title, artist, album, image, duration_secs, language, year, data, play_count, last_played, is_fav, updated_at FROM songs WHERE last_played > 0 ORDER BY last_played DESC LIMIT ?1",
            limit,
        )
    }

    pub fn favs(&self, limit: i64) -> Result<Vec<SongRow>, String> {
        self.list_songs(
            "SELECT id, title, artist, album, image, duration_secs, language, year, data, play_count, last_played, is_fav, updated_at FROM songs WHERE is_fav = 1 ORDER BY last_played DESC LIMIT ?1",
            limit,
        )
    }

    pub fn most_played(&self, limit: i64) -> Result<Vec<SongRow>, String> {
        self.list_songs(
            "SELECT id, title, artist, album, image, duration_secs, language, year, data, play_count, last_played, is_fav, updated_at FROM songs ORDER BY play_count DESC, last_played DESC LIMIT ?1",
            limit,
        )
    }

    pub fn stats(&self) -> Result<StoreStats, String> {
        let conn = self.lock()?;
        let songs: i64 = conn
            .query_row("SELECT count(*) FROM songs", [], |r| r.get(0))
            .unwrap_or(0);
        let favs: i64 = conn
            .query_row("SELECT count(*) FROM songs WHERE is_fav = 1", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        let plays: i64 = conn
            .query_row("SELECT COALESCE(SUM(play_count),0) FROM songs", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        let searches: i64 = conn
            .query_row("SELECT count(*) FROM search_cache", [], |r| r.get(0))
            .unwrap_or(0);
        let lyrics: i64 = conn
            .query_row("SELECT count(*) FROM lyrics_cache", [], |r| r.get(0))
            .unwrap_or(0);
        let entities: i64 = conn
            .query_row("SELECT count(*) FROM entities", [], |r| r.get(0))
            .unwrap_or(0);
        let outbox: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |r| r.get(0))
            .unwrap_or(0);
        let size: i64 = std::fs::metadata(&self.path)
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        Ok(StoreStats {
            songs,
            favs,
            plays,
            searches,
            lyrics,
            entities,
            outbox,
            db_bytes: size,
        })
    }

    fn prune_songs(&self) {
        let Ok(conn) = self.conn.lock() else { return };
        let count: i64 = conn
            .query_row("SELECT count(*) FROM songs", [], |r| r.get(0))
            .unwrap_or(0);
        if count <= SONGS_CAP {
            return;
        }
        // Keep favorites + anything played; drop coldest metadata first.
        let _ = conn.execute(
            "DELETE FROM songs WHERE id IN (
               SELECT id FROM songs WHERE is_fav = 0 AND play_count = 0
               ORDER BY updated_at ASC LIMIT ?1
             )",
            params![count - SONGS_CAP],
        );
    }

    // ---------------------------------------------------------------- kv ---

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        conn.prepare_cached("SELECT v FROM kv WHERE k = ?1")
            .and_then(|mut s| {
                s.query_row(params![key], |r| r.get::<_, String>(0))
                    .optional()
            })
            .map_err(|e| format!("kv get: {e}"))
    }

    pub fn kv_put(&self, key: &str, value: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > 128 {
            return Err("kv key 1..128 chars".into());
        }
        if value.len() > KV_MAX_BYTES {
            return Err(format!("kv value over {} bytes", KV_MAX_BYTES));
        }
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached(
            "INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
        )
        .and_then(|mut s| s.execute(params![key, value, now]))
        .map(|_| ())
        .map_err(|e| format!("kv put: {e}"))
    }

    // ------------------------------------------------------- search cache ---

    pub fn search_put(&self, key: &str, data: &serde_json::Value) -> Result<(), String> {
        if key.is_empty() || key.len() > 256 {
            return Err("search key 1..256 chars".into());
        }
        let raw = serde_json::to_string(data).map_err(|e| e.to_string())?;
        if raw.len() > 512 * 1024 {
            return Err("search page too large (512 KB cap)".into());
        }
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached(
            "INSERT INTO search_cache (key, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        )
        .and_then(|mut s| s.execute(params![key, raw, now]))
        .map_err(|e| format!("search put: {e}"))?;
        // Cap: keep newest 200.
        let _ = conn.execute(
            "DELETE FROM search_cache WHERE key NOT IN (
               SELECT key FROM search_cache ORDER BY updated_at DESC LIMIT ?1
             )",
            params![SEARCH_CAP],
        );
        Ok(())
    }

    pub fn search_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let conn = self.lock()?;
        let row: Option<(String, i64)> = conn
            .prepare_cached("SELECT data, updated_at FROM search_cache WHERE key = ?1")
            .and_then(|mut s| {
                s.query_row(params![key], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })
                .optional()
            })
            .map_err(|e| format!("search get: {e}"))?;
        let Some((raw, at)) = row else {
            return Ok(None);
        };
        if now_secs() - at > SEARCH_TTL_SECS {
            let _ = conn.execute("DELETE FROM search_cache WHERE key = ?1", params![key]);
            return Ok(None);
        }
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("search decode: {e}"))
    }

    /// Clear-cache button target: songs + search/lyrics/entity rows. KV
    /// (queue backup, onboarding) and the outbox (pending user ops) survive —
    /// both are tiny and explicitly user state, not fetched data.
    pub fn clear_cache(&self) -> Result<Cleared, String> {
        let conn = self.lock()?;
        let songs = conn
            .execute("DELETE FROM songs WHERE is_fav = 0", [])
            .unwrap_or(0);
        let searches = conn.execute("DELETE FROM search_cache", []).unwrap_or(0);
        let lyrics = conn.execute("DELETE FROM lyrics_cache", []).unwrap_or(0);
        let entities = conn.execute("DELETE FROM entities", []).unwrap_or(0);
        Ok(Cleared {
            songs: songs as u64,
            searches: searches as u64,
            lyrics: lyrics as u64,
            entities: entities as u64,
        })
    }

    // ------------------------------------------- blob caches (lyrics etc) ---

    /// Shared put for the keyed JSON blob tables. `table` is always one of
    /// the three internal constants below — never caller input.
    fn blob_put(
        &self,
        table: &str,
        key: &str,
        data: &serde_json::Value,
        max_bytes: usize,
        cap: i64,
    ) -> Result<(), String> {
        if key.is_empty() || key.len() > 160 {
            return Err(format!("{table} key 1..160 chars"));
        }
        let raw = serde_json::to_string(data).map_err(|e| e.to_string())?;
        if raw.len() > max_bytes {
            return Err(format!("{table} row over {max_bytes} bytes"));
        }
        let now = now_secs();
        let conn = self.lock()?;
        let sql = format!(
            "INSERT INTO {table} (key, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
        );
        conn.prepare_cached(&sql)
            .and_then(|mut s| s.execute(params![key, raw, now]))
            .map_err(|e| format!("{table} put: {e}"))?;
        let evict = format!(
            "DELETE FROM {table} WHERE key NOT IN (
               SELECT key FROM {table} ORDER BY updated_at DESC LIMIT ?1
             )"
        );
        let _ = conn.execute(&evict, params![cap]);
        Ok(())
    }

    /// Shared TTL get: stale rows read as a miss and are deleted.
    fn blob_get(
        &self,
        table: &str,
        key: &str,
        ttl_secs: i64,
    ) -> Result<Option<serde_json::Value>, String> {
        let conn = self.lock()?;
        let sql = format!("SELECT data, updated_at FROM {table} WHERE key = ?1");
        let row: Option<(String, i64)> = conn
            .prepare_cached(&sql)
            .and_then(|mut s| {
                s.query_row(params![key], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })
                .optional()
            })
            .map_err(|e| format!("{table} get: {e}"))?;
        let Some((raw, at)) = row else {
            return Ok(None);
        };
        if now_secs() - at > ttl_secs {
            let del = format!("DELETE FROM {table} WHERE key = ?1");
            let _ = conn.execute(&del, params![key]);
            return Ok(None);
        }
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("{table} decode: {e}"))
    }

    /// Cache one lyrics payload (whatever `get_lyrics` returned). Callers
    /// only store positive hits — a `source: "none"` miss is not cached.
    pub fn lyrics_put(&self, key: &str, data: &serde_json::Value) -> Result<(), String> {
        self.blob_put("lyrics_cache", key, data, LYRICS_MAX_BYTES, LYRICS_CAP)
    }

    pub fn lyrics_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        self.blob_get("lyrics_cache", key, LYRICS_TTL_SECS)
    }

    /// Cache one detail payload (`album:<token>`, `playlist:<id>`,
    /// `artist-overview:<token>` …). Callers own the key format.
    pub fn entity_put(&self, key: &str, data: &serde_json::Value) -> Result<(), String> {
        self.blob_put("entities", key, data, ENTITY_MAX_BYTES, ENTITY_CAP)
    }

    pub fn entity_get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        self.blob_get("entities", key, ENTITY_TTL_SECS)
    }

    // ------------------------------------------------------------- outbox ---

    /// Queue one offline op (currently: Drive-sync requests made while
    /// offline). Returns the row id. Oldest rows fall off past the cap.
    pub fn outbox_push(&self, op: &str, payload: &str) -> Result<i64, String> {
        let op = op.trim();
        if op.is_empty()
            || op.len() > OUTBOX_OP_MAX
            || !op
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("outbox op 1..32 chars [a-z0-9_-]".into());
        }
        if payload.len() > OUTBOX_PAYLOAD_MAX {
            return Err(format!("outbox payload over {OUTBOX_PAYLOAD_MAX} bytes"));
        }
        let now = now_secs();
        let conn = self.lock()?;
        conn.prepare_cached("INSERT INTO outbox (op, payload, created_at) VALUES (?1, ?2, ?3)")
            .and_then(|mut s| s.execute(params![op, payload, now]))
            .map_err(|e| format!("outbox push: {e}"))?;
        let id = conn.last_insert_rowid();
        let _ = conn.execute(
            "DELETE FROM outbox WHERE id NOT IN (
               SELECT id FROM outbox ORDER BY id DESC LIMIT ?1
             )",
            params![OUTBOX_CAP],
        );
        Ok(id)
    }

    /// Oldest-first, for drain-then-ack.
    pub fn outbox_list(&self, limit: i64) -> Result<Vec<OutboxEntry>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare_cached("SELECT id, op, payload, created_at FROM outbox ORDER BY id ASC LIMIT ?1")
            .map_err(|e| format!("outbox list: {e}"))?;
        let rows = stmt
            .query_map(params![limit.max(1).min(500)], |r| {
                Ok(OutboxEntry {
                    id: r.get(0)?,
                    op: r.get(1)?,
                    payload: r.get(2)?,
                    created_at: r.get::<_, i64>(3).unwrap_or(0).max(0) as u64,
                })
            })
            .map_err(|e| format!("outbox list: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("outbox list: {e}"))
    }

    /// Delete drained rows by id. Returns the removed count.
    pub fn outbox_ack(&self, ids: &[i64]) -> Result<u64, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        if ids.len() > 500 {
            return Err("ack at most 500 ids".into());
        }
        let conn = self.lock()?;
        // i64 values bind as parameters — no SQL text from the caller.
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM outbox WHERE id IN ({placeholders})");
        let n = conn
            .prepare(&sql)
            .and_then(|mut s| s.execute(rusqlite::params_from_iter(ids.iter())))
            .map_err(|e| format!("outbox ack: {e}"))?;
        Ok(n as u64)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct StoreStats {
    pub songs: i64,
    pub favs: i64,
    pub plays: i64,
    pub searches: i64,
    pub lyrics: i64,
    pub entities: i64,
    pub outbox: i64,
    pub db_bytes: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Cleared {
    pub songs: u64,
    pub searches: u64,
    pub lyrics: u64,
    pub entities: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct OutboxEntry {
    pub id: i64,
    pub op: String,
    pub payload: String,
    pub created_at: u64,
}

fn row_to_song(row: &rusqlite::Row<'_>) -> rusqlite::Result<SongRow> {
    let raw: String = row.get(8)?;
    let data: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    Ok(SongRow {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get(3)?,
        image: row.get(4)?,
        duration_secs: row.get::<_, i64>(5).unwrap_or(0).max(0) as u64,
        language: row.get(6)?,
        year: row.get(7)?,
        data,
        play_count: row.get::<_, i64>(9).unwrap_or(0).max(0) as u64,
        last_played: row.get::<_, i64>(10).unwrap_or(0).max(0) as u64,
        is_fav: row.get::<_, i64>(11).unwrap_or(0) != 0,
        updated_at: row.get::<_, i64>(12).unwrap_or(0).max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> (AppStore, TempfileGuard) {
        let dir = std::env::temp_dir().join(format!(
            "tm-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.db");
        let store = AppStore::open(&path).expect("open");
        (store, TempfileGuard(dir))
    }

    struct TempfileGuard(std::path::PathBuf);
    impl Drop for TempfileGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn track(id: &str) -> serde_json::Value {
        json!({
            "id": id, "title": format!("Title {id}"), "artist": "A",
            "album": "Al", "image": "http://x/y.jpg",
            "duration_secs": 200, "language": "hindi", "year": "2024"
        })
    }

    #[test]
    fn put_get_roundtrip() {
        let (s, _g) = scratch();
        s.put_song(&track("abc123")).unwrap();
        let got = s.get_song("abc123").unwrap().expect("row");
        assert_eq!(got.title, "Title abc123");
        assert_eq!(got.play_count, 0);
    }

    #[test]
    fn play_bumps_count_and_recent() {
        let (s, _g) = scratch();
        s.record_play(&track("a1")).unwrap();
        s.record_play(&track("a1")).unwrap();
        s.record_play(&track("b2")).unwrap();
        let recent = s.recent(10).unwrap();
        assert_eq!(recent.len(), 2);
        let top = s.most_played(1).unwrap();
        assert_eq!(top[0].id, "a1");
        assert_eq!(top[0].play_count, 2);
    }

    #[test]
    fn fav_flag_lists() {
        let (s, _g) = scratch();
        s.set_fav(&track("f1"), true).unwrap();
        assert_eq!(s.favs(10).unwrap().len(), 1);
        s.set_fav(&track("f1"), false).unwrap();
        assert_eq!(s.favs(10).unwrap().len(), 0);
    }

    #[test]
    fn kv_roundtrip_and_size_guard() {
        let (s, _g) = scratch();
        assert!(s.kv_get("q").unwrap().is_none());
        s.kv_put("tm-queue", "{\"i\":0}").unwrap();
        assert_eq!(s.kv_get("tm-queue").unwrap().as_deref(), Some("{\"i\":0}"));
        assert!(s.kv_put("k", &"x".repeat(KV_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn search_ttl_and_cap() {
        let (s, _g) = scratch();
        s.search_put("q:1", &json!({"tracks":[]})).unwrap();
        assert!(s.search_get("q:1").unwrap().is_some());
        // Stale row reads as miss.
        {
            let conn = s.lock().unwrap();
            conn.execute(
                "UPDATE search_cache SET updated_at = ?1 WHERE key = 'q:1'",
                params![now_secs() - SEARCH_TTL_SECS - 1],
            )
            .unwrap();
        }
        assert!(s.search_get("q:1").unwrap().is_none());
    }

    #[test]
    fn rejects_track_without_id() {
        let (s, _g) = scratch();
        assert!(s.put_song(&json!({"title":"No id"})).is_err());
    }

    #[test]
    fn lyrics_roundtrip_ttl_and_guards() {
        let (s, _g) = scratch();
        assert!(s.lyrics_get("lyr:id:abc").unwrap().is_none());
        s.lyrics_put("lyr:id:abc", &json!({"lines": ["la"], "source": "lrclib"}))
            .unwrap();
        let hit = s.lyrics_get("lyr:id:abc").unwrap().expect("row");
        assert_eq!(hit["source"], json!("lrclib"));
        // Overwrite refreshes the payload.
        s.lyrics_put("lyr:id:abc", &json!({"lines": [], "source": "none"}))
            .unwrap();
        assert_eq!(
            s.lyrics_get("lyr:id:abc").unwrap().unwrap()["source"],
            json!("none")
        );
        // Stale row reads as miss (and is deleted).
        {
            let conn = s.lock().unwrap();
            conn.execute(
                "UPDATE lyrics_cache SET updated_at = ?1 WHERE key = 'lyr:id:abc'",
                params![now_secs() - LYRICS_TTL_SECS - 1],
            )
            .unwrap();
        }
        assert!(s.lyrics_get("lyr:id:abc").unwrap().is_none());
        // Guards: empty/oversize key, oversize payload.
        assert!(s.lyrics_put("", &json!({})).is_err());
        assert!(s.lyrics_put(&"k".repeat(161), &json!({})).is_err());
        let big = "x".repeat(LYRICS_MAX_BYTES + 1);
        assert!(s.lyrics_put("lyr:id:big", &json!({"t": big})).is_err());
    }

    #[test]
    fn entity_roundtrip_ttl_and_size_guard() {
        let (s, _g) = scratch();
        s.entity_put("ent:album:tok1", &json!({"tracks": [{"id": "a"}]}))
            .unwrap();
        let hit = s.entity_get("ent:album:tok1").unwrap().expect("row");
        assert_eq!(hit["tracks"][0]["id"], json!("a"));
        {
            let conn = s.lock().unwrap();
            conn.execute(
                "UPDATE entities SET updated_at = ?1 WHERE key = 'ent:album:tok1'",
                params![now_secs() - ENTITY_TTL_SECS - 1],
            )
            .unwrap();
        }
        assert!(s.entity_get("ent:album:tok1").unwrap().is_none());
        let big = "x".repeat(ENTITY_MAX_BYTES + 1);
        assert!(s.entity_put("ent:playlist:p", &json!({"t": big})).is_err());
    }

    #[test]
    fn outbox_fifo_ack_and_cap() {
        let (s, _g) = scratch();
        assert!(s.outbox_list(10).unwrap().is_empty());
        let a = s.outbox_push("sync", "edit").unwrap();
        let b = s.outbox_push("sync", "online").unwrap();
        assert!(b > a);
        let rows = s.outbox_list(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, a);
        assert_eq!(rows[0].op, "sync");
        // Ack one: the other survives.
        assert_eq!(s.outbox_ack(&[a]).unwrap(), 1);
        let rows = s.outbox_list(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, b);
        assert_eq!(s.outbox_ack(&[]).unwrap(), 0);
        assert_eq!(s.outbox_ack(&[b, 999_999]).unwrap(), 1);
        assert!(s.outbox_list(10).unwrap().is_empty());
        // Op/payload validation.
        assert!(s.outbox_push("", "x").is_err());
        assert!(s.outbox_push("has space", "x").is_err());
        assert!(s.outbox_push("sync", &"x".repeat(OUTBOX_PAYLOAD_MAX + 1)).is_err());
        assert!(s.outbox_ack(&[1; 501]).is_err());
    }

    #[test]
    fn outbox_evicts_oldest_past_cap() {
        let (s, _g) = scratch();
        let mut first = 0;
        for i in 0..(OUTBOX_CAP + 5) {
            let id = s.outbox_push("sync", "x").unwrap();
            if i == 0 {
                first = id;
            }
        }
        let rows = s.outbox_list(OUTBOX_CAP + 10).unwrap();
        assert_eq!(rows.len() as i64, OUTBOX_CAP);
        assert!(rows.iter().all(|r| r.id != first));
    }

    #[test]
    fn stats_and_clear_cover_new_tables_not_outbox() {
        let (s, _g) = scratch();
        s.lyrics_put("lyr:id:a", &json!({"s": "x"})).unwrap();
        s.entity_put("ent:album:t", &json!({"t": []})).unwrap();
        s.outbox_push("sync", "edit").unwrap();
        let st = s.stats().unwrap();
        assert_eq!(st.lyrics, 1);
        assert_eq!(st.entities, 1);
        assert_eq!(st.outbox, 1);
        let c = s.clear_cache().unwrap();
        assert_eq!(c.lyrics, 1);
        assert_eq!(c.entities, 1);
        // Pending user ops survive a cache clear.
        assert_eq!(s.stats().unwrap().outbox, 1);
        assert!(s.outbox_list(10).unwrap().len() == 1);
    }
}
