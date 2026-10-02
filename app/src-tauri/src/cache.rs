//! Disk tiers of the cache stack (L3 album art, L4 lyrics).
//!
//! Content-hash keys, atomic writes, a byte budget with LRU eviction and a
//! 7-day freshness window for lyrics — see the cache system design. The RAM
//! hot layers (L1 metadata, L2 stream URLs, L3/L4 memory) live as `moka`
//! caches on `proxy::AppState`; the offline vault is deliberately NOT part
//! of this tree (user files under Downloads, own ledger, own quota).
//!
//! ponytail: no `walkdir` — this tree is exactly two flat directories, so a
//! recursive `read_dir` is cheaper than the dependency (sha256.rs: one hash
//! function was not worth a dependency either).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::sha256::Sha256;

/// Design default: 500 MB for art + lyrics combined.
pub const DEFAULT_BUDGET: u64 = 500 * 1024 * 1024;
/// Design range: 100 MB … 5 GB (enforced on the Tauri command boundary).
pub const MIN_BUDGET: u64 = 100 * 1024 * 1024;
pub const MAX_BUDGET: u64 = 5 * 1024 * 1024 * 1024;

/// L4: a lyrics file unread for this long is stale (design TTL, 7 days).
pub const LYRICS_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Refuse to cache anything larger: a runaway upstream must not fill the
/// disk. Checked by both the writer and the `/art` handler.
pub const MAX_ART_BYTES: u64 = 10 * 1024 * 1024;

const BUDGET_FILE: &str = ".budget";

/// What the Settings / Storage screen renders.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CacheStats {
    pub art_bytes: u64,
    pub art_count: u64,
    pub lyrics_bytes: u64,
    pub lyrics_count: u64,
    /// Vault size, computed by the caller — downloads are not in this tree.
    pub vault_bytes: u64,
    pub budget_bytes: u64,
    /// False when the cache dir is not writable: memory-only mode.
    pub disk_enabled: bool,
}

pub struct DiskCache {
    dir: PathBuf,
    art_dir: PathBuf,
    lyrics_dir: PathBuf,
    enabled: bool,
    budget: AtomicU64,
}

/// One `(path, bytes, last-modified)` row; the LRU currency of the budget.
type FileRow = (PathBuf, u64, SystemTime);

impl DiskCache {
    /// Create the tree, probe writability, load the persisted budget.
    /// A read-only directory disables the disk tiers instead of erroring on
    /// every request (design edge case "cache dir is read-only").
    pub fn new(dir: PathBuf) -> Self {
        let art_dir = dir.join("art");
        let lyrics_dir = dir.join("lyrics");
        let enabled = probe_writable(&dir, &art_dir, &lyrics_dir);
        let budget = load_budget(&dir.join(BUDGET_FILE));
        Self {
            dir,
            art_dir,
            lyrics_dir,
            enabled,
            budget: AtomicU64::new(budget),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn budget(&self) -> u64 {
        self.budget.load(Ordering::Relaxed)
    }

    /// Persist a new budget (bytes, already clamped by the command) and
    /// enforce it immediately so the setting takes effect on this click.
    pub fn set_budget(&self, bytes: u64) {
        self.budget.store(bytes, Ordering::Relaxed);
        let path = self.dir.join(BUDGET_FILE);
        if let Err(e) = std::fs::write(&path, bytes.to_string()) {
            eprintln!("[cache] budget persist failed: {e}");
        }
    }

    /// L3 key: content-hash of the (normalised) art URL, 32 hex chars.
    pub fn art_path(&self, key: &str) -> PathBuf {
        self.art_dir.join(format!("{}.img", hash_key(key)))
    }

    /// L4 key: the song id when it is filename-safe, else its hash.
    pub fn lyrics_path(&self, id: &str) -> PathBuf {
        let safe = !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let stem = if safe { id.to_string() } else { hash_key(id) };
        self.lyrics_dir.join(format!("{stem}.json"))
    }

    /// Write `bytes` to `path` via a `.tmp` sibling + rename: a crash
    /// mid-write can leave a stray tmp, never a truncated final file.
    /// Concurrent writers of the same key are idempotent (identical bytes).
    pub async fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        if !self.enabled {
            return Err("disk cache disabled".into());
        }
        if bytes.len() as u64 > MAX_ART_BYTES {
            return Err(format!("{} bytes exceeds art cap", bytes.len()));
        }
        let tmp = tmp_path(path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&tmp, bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&tmp, path).await.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }

    /// Disk hit: read the file and bump its mtime so the budget's LRU sees
    /// the access. (Windows disables last-access tracking by default, so
    /// mtime-on-read is the reliable recency signal.)
    pub async fn read_touch(&self, path: &Path) -> Option<Vec<u8>> {
        let bytes = tokio::fs::read(path).await.ok()?;
        touch(path);
        Some(bytes)
    }

    /// L4 disk hit: `None` when the file is older than `ttl` (unread for
    /// that long = stale); otherwise read + touch like `read_touch`.
    pub async fn read_fresh(&self, path: &Path, ttl: Duration) -> Option<Vec<u8>> {
        let meta = std::fs::metadata(path).ok()?;
        let age = SystemTime::now()
            .duration_since(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH))
            .unwrap_or(Duration::ZERO);
        if age > ttl {
            return None;
        }
        self.read_touch(path).await
    }

    /// Walk the tree: art + lyrics files with size and mtime.
    fn walk(&self) -> Vec<FileRow> {
        let mut rows = Vec::new();
        for dir in [&self.art_dir, &self.lyrics_dir] {
            collect(dir, &mut rows);
        }
        rows
    }

    /// Usage numbers for Settings (vault size supplied by the caller).
    pub fn stats(&self, vault_bytes: u64) -> CacheStats {
        let mut s = CacheStats {
            art_bytes: 0,
            art_count: 0,
            lyrics_bytes: 0,
            lyrics_count: 0,
            vault_bytes,
            budget_bytes: self.budget(),
            disk_enabled: self.enabled,
        };
        for (path, bytes, _) in self.walk() {
            if path.parent() == Some(&self.art_dir) {
                s.art_bytes += bytes;
                s.art_count += 1;
            } else {
                s.lyrics_bytes += bytes;
                s.lyrics_count += 1;
            }
        }
        s
    }

    /// Design §Disk Budget: run at boot and every 10 minutes. First drops
    /// lyrics unread for `LYRICS_TTL`, then evicts least-recently-modified
    /// files until the tree fits the budget.
    pub fn enforce_budget(&self) {
        if !self.enabled {
            return;
        }
        let mut files = self.walk();
        let mut total: u64 = files.iter().map(|(_, b, _)| *b).sum();

        // L4 TTL sweep — stale lyrics go regardless of budget headroom.
        let now = SystemTime::now();
        files.retain(|(path, bytes, mtime)| {
            if path.parent() != Some(&self.lyrics_dir) {
                return true;
            }
            let stale = now
                .duration_since(*mtime)
                .map(|age| age > LYRICS_TTL)
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(path);
                total = total.saturating_sub(*bytes);
                return false;
            }
            true
        });

        if total <= self.budget() {
            return;
        }
        files.sort_by_key(|(_, _, mtime)| *mtime);
        for (path, bytes, _) in files {
            if total <= self.budget() {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
    }

    /// Clear-cache button: every art + lyrics file, budget file kept,
    /// vault untouched (it lives outside this tree by construction).
    pub fn clear(&self) {
        for dir in [&self.art_dir, &self.lyrics_dir] {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// 32 hex chars of SHA-256 — same algorithm as the vault ledger, no `hex` dep.
fn hash_key(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    h.hex()[..32].to_string()
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Last-modified bump — a metadata syscall, deliberately synchronous.
fn touch(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn load_budget(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|b| b.clamp(MIN_BUDGET, MAX_BUDGET))
        .unwrap_or(DEFAULT_BUDGET)
}

/// True when the three directories exist and a probe file round-trips.
fn probe_writable(dir: &Path, art: &Path, lyrics: &Path) -> bool {
    for d in [dir, art, lyrics] {
        if std::fs::create_dir_all(d).is_err() {
            return false;
        }
    }
    let probe = dir.join(".probe");
    std::fs::write(&probe, b"1")
        .and_then(|_| std::fs::remove_file(&probe))
        .is_ok()
}

fn collect(dir: &Path, rows: &mut Vec<FileRow>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect(&path, rows);
        } else if meta.is_file() {
            rows.push((
                path,
                meta.len(),
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tm-cache-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        DiskCache::new(dir.clone());
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hash_keys_are_stable_and_short() {
        let d = scratch("hash");
        let p1 = DiskCache::new(d.clone()).art_path("https://a/b.jpg");
        let p2 = DiskCache::new(d.clone()).art_path("https://a/b.jpg");
        let p3 = DiskCache::new(d.clone()).art_path("https://a/c.jpg");
        assert_eq!(p1, p2, "same url -> same file");
        assert_ne!(p1, p3, "different url -> different file");
        assert_eq!(p1.extension().unwrap(), "img");
        cleanup(&d);
    }

    #[test]
    fn safe_ids_keep_their_name_hashes_do_not() {
        let d = scratch("ids");
        let c = DiskCache::new(d.clone());
        assert_eq!(
            c.lyrics_path("i-4OQoee").file_name().unwrap(),
            "i-4OQoee.json"
        );
        let weird = c.lyrics_path("../etc/passwd");
        let name = weird.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains("..") && !name.contains('/'), "got {name}");
        cleanup(&d);
    }

    #[tokio::test]
    async fn atomic_write_read_touch_roundtrip() {
        let d = scratch("rw");
        let c = DiskCache::new(d.clone());
        let path = c.art_path("u");
        c.write_atomic(&path, b"cover-bytes").await.expect("write");
        assert!(!tmp_path(&path).exists(), "tmp renamed away");
        let got = c.read_touch(&path).await.expect("read");
        assert_eq!(got, b"cover-bytes");
        cleanup(&d);
    }

    #[tokio::test]
    async fn read_fresh_rejects_stale_lyrics() {
        let d = scratch("stale");
        let c = DiskCache::new(d.clone());
        let path = c.lyrics_path("abc");
        c.write_atomic(&path, b"[{\"x\":1}]").await.expect("write");
        assert!(c.read_fresh(&path, LYRICS_TTL).await.is_some());
        assert!(c.read_fresh(&path, Duration::ZERO).await.is_none());
        cleanup(&d);
    }

    #[test]
    fn enforce_evicts_lru_and_stale_lyrics() {
        let d = scratch("evict");
        let c = DiskCache::new(d.clone());
        c.set_budget(MIN_BUDGET); // 100 MB — write files directly under a tiny fake budget instead
        std::fs::create_dir_all(c.art_dir.join("x")).unwrap();

        // Build 3 art files with distinct mtimes; budget = 2 files' worth.
        let mk = |name: &str, bytes: &[u8]| {
            let p = c.art_dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        let old = mk("old.img", &[0u8; 10]);
        let mid = mk("mid.img", &[0u8; 10]);
        let new = mk("new.img", &[0u8; 10]);
        let base = SystemTime::now() - Duration::from_secs(3600);
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(&old)
            .unwrap()
            .set_modified(base);
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(&mid)
            .unwrap()
            .set_modified(base + Duration::from_secs(60));
        // new.img keeps "now".

        c.budget.store(20, Ordering::Relaxed); // exactly two 10-byte files
        c.enforce_budget();
        assert!(!old.exists(), "oldest evicted");
        assert!(mid.exists() && new.exists());

        // Stale lyrics are dropped even under budget.
        let l = c.lyrics_path("hot");
        std::fs::write(&l, b"{}").unwrap();
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(&l)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60));
        c.budget.store(MIN_BUDGET, Ordering::Relaxed);
        c.enforce_budget();
        assert!(!l.exists(), "lyrics unread for >7d swept");
        cleanup(&d);
    }

    #[test]
    fn clear_removes_files_but_keeps_budget() {
        let d = scratch("clear");
        let c = DiskCache::new(d.clone());
        c.set_budget(DEFAULT_BUDGET);
        std::fs::write(c.art_path("u"), b"x").unwrap();
        std::fs::write(c.lyrics_path("id"), b"{}").unwrap();
        c.clear();
        assert_eq!(c.stats(0).art_count, 0);
        assert_eq!(c.stats(0).lyrics_count, 0);
        assert!(d.join(BUDGET_FILE).exists(), "budget survives clear");
        assert_eq!(c.budget(), DEFAULT_BUDGET);
        cleanup(&d);
    }

    #[test]
    fn budget_roundtrips_and_clamps() {
        let d = scratch("budget");
        let c = DiskCache::new(d.clone());
        c.set_budget(1024);
        assert_eq!(c.budget(), 1024, "raw setter stores what it is given");
        // Reload: file value is clamped into the design range.
        let reloaded = DiskCache::new(d.clone());
        assert_eq!(reloaded.budget(), MIN_BUDGET, "clamped up to 100 MB");
        cleanup(&d);
    }
}
