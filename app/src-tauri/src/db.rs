//! SQLite ledger for the offline vault (review 4.5 Storage Layer).
//!
//! Replaces the `index.json` read-modify-write cycle with WAL-mode SQLite:
//! one connection behind a mutex serializes writers, every hot query runs as
//! a prepared statement, and each mutation commits in a single transaction,
//! so a crash can never leave a half-written row behind. Audio files never
//! live in the database — only the rows describing them.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::proxy::DownloadEntry;

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS downloads (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL,
    album         TEXT NOT NULL,
    image         TEXT NOT NULL,
    duration_secs INTEGER NOT NULL,
    quality       TEXT NOT NULL,
    path          TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    at            INTEGER NOT NULL
);
";

const INSERT_SQL: &str = "INSERT INTO downloads \
     (id, title, artist, album, image, duration_secs, quality, path, bytes, at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)";

pub struct VaultDb {
    conn: Mutex<Connection>,
}

impl VaultDb {
    /// Open (creating if needed) `<vault>/downloads.db`.
    ///
    /// * `legacy_json` — the pre-SQLite manifest: imported on the first open
    ///   (parse failure falls back to `rebuild`), then renamed aside.
    /// * `rebuild` — recovery closure that scans the vault directory; used
    ///   when there is no usable manifest, or when the database itself is
    ///   corrupted (rows are rebuilt, files are never touched).
    ///
    /// A directory that cannot be created or written (read-only vault)
    /// yields `Err` — callers surface it and the vault stays disabled
    /// instead of corrupting silently (review 5.3).
    pub fn open(
        dir: &Path,
        legacy_json: &Path,
        rebuild: impl FnOnce() -> Vec<DownloadEntry>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create vault {}: {e}", dir.display()))?;
        let path = dir.join("downloads.db");
        let existed = path.exists();
        let conn = match Self::connect(&path) {
            Ok(conn) => conn,
            Err(first_err) if existed => {
                // Corrupted database: audio files are untouched, so drop the
                // file (and its WAL sidecars) and rebuild rows from disk.
                drop_conn_files(&path);
                let conn = Self::connect(&path).map_err(|e| {
                    format!("vault database unusable ({first_err}); retry failed: {e}")
                })?;
                let db = VaultDb {
                    conn: Mutex::new(conn),
                };
                db.insert_all(&rebuild())?;
                retire_legacy(legacy_json);
                return Ok(db);
            }
            Err(e) => return Err(e),
        };
        let db = VaultDb {
            conn: Mutex::new(conn),
        };
        if !existed {
            let entries = std::fs::read(legacy_json)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Vec<DownloadEntry>>(&bytes).ok())
                .unwrap_or_else(rebuild);
            if !entries.is_empty() {
                db.insert_all(&entries)?;
            }
        }
        retire_legacy(legacy_json);
        Ok(db)
    }

    fn connect(path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        // WAL lets readers proceed during writes; NORMAL sync is the
        // recommended pairing (durable at transaction boundaries).
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
            .map_err(|e| format!("wal mode: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("sync mode: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("schema: {e}"))?;
        // Probe now so a corrupt file fails at boot, not on first use.
        conn.query_row("SELECT count(*) FROM downloads", [], |_| Ok(()))
            .map_err(|e| format!("vault database: {e}"))?;
        Ok(conn)
    }

    /// Insert many rows in one transaction (boot import / disk rebuild).
    fn insert_all(&self, entries: &[DownloadEntry]) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| format!("vault tx: {e}"))?;
        {
            let mut stmt = tx
                .prepare_cached(INSERT_SQL)
                .map_err(|e| format!("vault insert: {e}"))?;
            for entry in entries {
                execute_insert(&mut stmt, entry)?;
            }
        }
        tx.commit().map_err(|e| format!("vault commit: {e}"))
    }

    /// All rows in insertion order — the same order the JSON manifest kept
    /// (re-recording a song moves it to the end, newest last).
    pub fn list(&self) -> Result<Vec<DownloadEntry>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, title, artist, album, image, duration_secs, quality, path, bytes, at \
                 FROM downloads ORDER BY rowid",
            )
            .map_err(|e| format!("vault list: {e}"))?;
        let rows = stmt
            .query_map([], row_to_entry)
            .map_err(|e| format!("vault list: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("vault list: {e}"))
    }

    /// Upsert by song id: delete then insert inside one transaction, which
    /// both replaces the row and moves it to the end (rowid order), exactly
    /// like the old `retain` + `push` manifest update.
    pub fn record(&self, entry: DownloadEntry) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(|e| format!("vault tx: {e}"))?;
        {
            let mut del = tx
                .prepare_cached("DELETE FROM downloads WHERE id = ?1")
                .map_err(|e| format!("vault delete: {e}"))?;
            del.execute(params![entry.id])
                .map_err(|e| format!("vault delete: {e}"))?;
            let mut ins = tx
                .prepare_cached(INSERT_SQL)
                .map_err(|e| format!("vault insert: {e}"))?;
            execute_insert(&mut ins, &entry)?;
        }
        tx.commit().map_err(|e| format!("vault commit: {e}"))
    }

    /// Drop the row for `id` if present (a no-op when absent).
    pub fn forget(&self, id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.prepare_cached("DELETE FROM downloads WHERE id = ?1")
            .and_then(|mut stmt| stmt.execute(params![id]))
            .map_err(|e| format!("vault forget: {e}"))?;
        Ok(())
    }

    /// The recorded entry for `path`, if any — the only paths any file
    /// operation is ever allowed to touch.
    pub fn entry_for_path(&self, path: &str) -> Result<Option<DownloadEntry>, String> {
        let conn = self.lock()?;
        conn.prepare_cached(
            "SELECT id, title, artist, album, image, duration_secs, quality, path, bytes, at \
             FROM downloads WHERE path = ?1",
        )
        .and_then(|mut stmt| stmt.query_row(params![path], row_to_entry).optional())
        .map_err(|e| format!("vault lookup: {e}"))
    }

    /// Remove the row whose path matches (after the file was deleted).
    pub fn delete_path(&self, path: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.prepare_cached("DELETE FROM downloads WHERE path = ?1")
            .and_then(|mut stmt| stmt.execute(params![path]))
            .map_err(|e| format!("vault delete: {e}"))?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        Ok(self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

fn execute_insert(stmt: &mut rusqlite::Statement<'_>, entry: &DownloadEntry) -> Result<(), String> {
    stmt.execute(params![
        entry.id,
        entry.title,
        entry.artist,
        entry.album,
        entry.image,
        entry.duration_secs as i64,
        entry.quality,
        entry.path,
        entry.bytes as i64,
        entry.at as i64,
    ])
    .map(|_| ())
    .map_err(|e| format!("vault insert: {e}"))
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadEntry> {
    Ok(DownloadEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get(3)?,
        image: row.get(4)?,
        duration_secs: row.get::<_, i64>(5)? as u64,
        quality: row.get(6)?,
        path: row.get(7)?,
        bytes: row.get::<_, i64>(8)? as u64,
        at: row.get::<_, i64>(9)? as u64,
    })
}

/// A successful import (or an abandoned one) moves the legacy manifest
/// aside so it can never be re-imported over newer database rows.
fn retire_legacy(legacy_json: &Path) {
    if legacy_json.exists() {
        let _ = std::fs::rename(
            legacy_json,
            legacy_json.with_file_name("index.json.imported"),
        );
    }
}

fn drop_conn_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    let _ = std::fs::remove_file(Path::new(&wal));
    let mut shm = path.as_os_str().to_owned();
    shm.push("-shm");
    let _ = std::fs::remove_file(Path::new(&shm));
}
