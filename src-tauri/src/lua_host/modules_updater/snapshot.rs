//! Content-addressed backups of every file the updater overwrites or deletes.
//!
//! Two things depend on this: undoing a whole sync that broke something, and
//! reverting one module to an earlier version. Both must work offline, which
//! rules out "re-download the old commit" — and a community portal may not keep
//! old versions at all.
//!
//! ```text
//! userdata/lua_backup/
//!   index.json
//!   blobs/9f/9f2c8ab…
//! ```

use super::model::FileVersion;
use super::state::{ensure_userdata, git_blob_sha, now_unix, safe_rel_path, userdata_dir, write_atomic};
use crate::settings_keys;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const INDEX_SCHEMA: u32 = 1;
static GEN_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn backup_dir() -> PathBuf {
    userdata_dir().join("lua_backup")
}

fn index_path() -> PathBuf {
    backup_dir().join("index.json")
}

fn blob_path(id: &str) -> PathBuf {
    let shard = if id.len() >= 2 { &id[..2] } else { "00" };
    backup_dir().join("blobs").join(shard).join(id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenItem {
    pub path: String,
    /// Content id of the bytes replaced; `None` when the file was created.
    pub prev: Option<String>,
    /// Content id written; `None` when the file was deleted.
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Generation {
    pub id: String,
    pub created_at: i64,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub note: String,
    /// Set when a later generation reverted this one.
    #[serde(default)]
    pub undone_by: Option<String>,
    pub items: Vec<GenItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexFile {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    generations: Vec<Generation>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self {
            schema: INDEX_SCHEMA,
            generations: Vec::new(),
        }
    }
}

/// Serializes index writes; blob writes are content-addressed and need no lock.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn load_index() -> IndexFile {
    fs::read_to_string(index_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<IndexFile>(&raw).ok())
        .unwrap_or_default()
}

fn save_index(index: &IndexFile) -> Result<(), String> {
    ensure_userdata()?;
    let raw = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    write_atomic(&index_path(), &raw).map_err(|e| format!("índice de respaldos: {e}"))
}

pub fn read_blob(content_id: &str) -> Option<Vec<u8>> {
    fs::read(blob_path(content_id)).ok()
}

fn store_blob(bytes: &[u8]) -> Result<String, String> {
    let id = git_blob_sha(bytes);
    let path = blob_path(&id);
    if path.is_file() {
        return Ok(id);
    }
    write_atomic(&path, bytes)?;
    Ok(id)
}

/* ---------------------------------------------------------------------- */
/* Building a generation                                                   */
/* ---------------------------------------------------------------------- */

pub struct GenBuilder {
    id: String,
    source_id: String,
    revision: String,
    note: String,
    items: Mutex<Vec<GenItem>>,
}

pub fn begin(source_id: &str, revision: &str, note: &str) -> GenBuilder {
    let id = format!(
        "g-{}-{:04}",
        now_unix(),
        GEN_SEQ.fetch_add(1, Ordering::SeqCst)
    );
    GenBuilder {
        id,
        source_id: source_id.to_string(),
        revision: revision.to_string(),
        note: note.to_string(),
        items: Mutex::new(Vec::new()),
    }
}

impl GenBuilder {
    /// Copy the current bytes of `rel` into the blob store.
    ///
    /// `Ok(None)` means the file does not exist yet — there is nothing to undo
    /// to, and the caller may proceed. An `Err` means the backup itself failed,
    /// and the caller must leave the file alone: losing a version silently is
    /// worse than skipping one update.
    pub fn backup(&self, rel: &str) -> Result<Option<String>, String> {
        let path = safe_rel_path(rel)?;
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("leer {}: {e}", path.display())),
        };
        store_blob(&bytes).map(Some)
    }

    pub fn record(&self, path: &str, prev: Option<String>, next: Option<String>) {
        self.items.lock().push(GenItem {
            path: path.to_string(),
            prev,
            next,
        });
    }

    /// Persist the generation. A run that changed nothing leaves no trace.
    pub fn commit(self) -> Option<String> {
        let items = self.items.into_inner();
        if items.is_empty() {
            return None;
        }
        let _guard = INDEX_LOCK.lock();
        let mut index = load_index();
        index.schema = INDEX_SCHEMA;
        index.generations.push(Generation {
            id: self.id.clone(),
            created_at: now_unix(),
            source_id: self.source_id,
            revision: self.revision,
            note: self.note,
            undone_by: None,
            items,
        });
        if let Err(e) = save_index(&index) {
            eprintln!("modules_updater: {e}");
            return None;
        }
        drop(_guard);
        prune();
        Some(self.id)
    }
}

/* ---------------------------------------------------------------------- */
/* Listing / history                                                       */
/* ---------------------------------------------------------------------- */

pub fn generations() -> Vec<Generation> {
    let mut list = load_index().generations;
    list.reverse(); // newest first
    list
}

pub fn last_undoable() -> Option<String> {
    load_index()
        .generations
        .iter()
        .rev()
        .find(|g| g.undone_by.is_none())
        .map(|g| g.id.clone())
}

/// Every stored version of `rel`, newest first.
pub fn versions_of(rel: &str) -> Vec<FileVersion> {
    let index = load_index();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for gen in index.generations.iter().rev() {
        for item in &gen.items {
            if item.path != rel {
                continue;
            }
            let Some(prev) = item.prev.as_ref() else {
                continue;
            };
            if !seen.insert(prev.clone()) {
                continue;
            }
            if !blob_path(prev).is_file() {
                continue;
            }
            out.push(FileVersion {
                content_id: prev.clone(),
                version: None,
                updated_at: Some(gen.created_at),
                size: fs::metadata(blob_path(prev)).ok().map(|m| m.len()),
                message: if gen.note.is_empty() {
                    format!("antes de {}", gen.id)
                } else {
                    gen.note.clone()
                },
                origin: "backup".into(),
            });
        }
    }
    out
}

/* ---------------------------------------------------------------------- */
/* Pruning                                                                 */
/* ---------------------------------------------------------------------- */

/// Keep the newest N generations, then trim oldest-first until the blob store
/// fits the size budget. The newest generation is always exempt from the size
/// cap: a bulk first sync can easily exceed it on its own, and that is exactly
/// the one a user is most likely to want to undo.
pub fn prune() {
    let keep_n = settings_keys::usize_setting(settings_keys::MODULES_BACKUP_GENERATIONS, 3).max(1);
    let max_bytes =
        settings_keys::usize_setting(settings_keys::MODULES_BACKUP_MAX_MB, 64) as u64 * 1024 * 1024;

    let _guard = INDEX_LOCK.lock();
    let mut index = load_index();
    if index.generations.is_empty() {
        return;
    }
    if index.generations.len() > keep_n {
        let drop = index.generations.len() - keep_n;
        index.generations.drain(0..drop);
    }

    let size_of = |g: &Generation| -> u64 {
        g.items
            .iter()
            .filter_map(|i| i.prev.as_ref())
            .filter_map(|id| fs::metadata(blob_path(id)).ok())
            .map(|m| m.len())
            .sum()
    };
    while index.generations.len() > 1 {
        let total: u64 = index.generations.iter().map(size_of).sum();
        if total <= max_bytes {
            break;
        }
        index.generations.remove(0);
    }

    if save_index(&index).is_err() {
        return;
    }
    drop(_guard);
    gc_blobs(&index);
}

fn gc_blobs(index: &IndexFile) {
    let live: HashSet<&str> = index
        .generations
        .iter()
        .flat_map(|g| g.items.iter())
        .filter_map(|i| i.prev.as_deref())
        .collect();
    let root = backup_dir().join("blobs");
    let Ok(shards) = fs::read_dir(&root) else {
        return;
    };
    for shard in shards.flatten() {
        let Ok(files) = fs::read_dir(shard.path()) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if !live.contains(name.as_str()) {
                let _ = fs::remove_file(f.path());
            }
        }
    }
}

/// Total bytes held by every stored version, so the UI can show what the
/// budget is actually being spent on.
pub fn store_size() -> u64 {
    fn walk(dir: &std::path::Path) -> u64 {
        let Ok(rd) = fs::read_dir(dir) else { return 0 };
        rd.flatten()
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path()),
                Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => 0,
            })
            .sum()
    }
    walk(&backup_dir().join("blobs"))
}

/// Throw away every stored version. Returns how many restore points went with
/// them, since that is what the user loses.
pub fn clear_all() -> Result<usize, String> {
    let _guard = INDEX_LOCK.lock();
    let removed = load_index().generations.len();
    let blobs = backup_dir().join("blobs");
    if blobs.is_dir() {
        fs::remove_dir_all(&blobs).map_err(|e| format!("borrar copias: {e}"))?;
    }
    let index = index_path();
    if index.is_file() {
        fs::remove_file(&index).map_err(|e| format!("borrar índice de copias: {e}"))?;
    }
    Ok(removed)
}

/* ---------------------------------------------------------------------- */
/* Undo                                                                    */
/* ---------------------------------------------------------------------- */

pub struct UndoOutcome {
    pub restored: usize,
    pub removed: usize,
    pub failed: Vec<String>,
    /// Paths touched, so the caller can fix up `lua.json`.
    pub paths: Vec<(String, Option<String>)>,
    pub inverse_id: Option<String>,
}

/// Restore every file a generation touched to the bytes it had before.
///
/// Recorded as its own generation so the undo is itself undoable and pruning
/// stays uniform.
pub fn undo_generation(id: &str) -> Result<UndoOutcome, String> {
    let index = load_index();
    let gen = index
        .generations
        .iter()
        .find(|g| g.id == id)
        .cloned()
        .ok_or_else(|| format!("No existe el punto de restauración «{id}»"))?;
    if gen.undone_by.is_some() {
        return Err(format!("«{id}» ya fue deshecho"));
    }

    let inverse = begin(&gen.source_id, &gen.revision, &format!("deshacer {id}"));
    let mut out = UndoOutcome {
        restored: 0,
        removed: 0,
        failed: Vec::new(),
        paths: Vec::new(),
        inverse_id: None,
    };

    for item in gen.items.iter().rev() {
        let path = match safe_rel_path(&item.path) {
            Ok(p) => p,
            Err(e) => {
                out.failed.push(e);
                continue;
            }
        };
        let before = match inverse.backup(&item.path) {
            Ok(v) => v,
            Err(e) => {
                out.failed.push(format!("{}: {e}", item.path));
                continue;
            }
        };
        match item.prev.as_ref() {
            None => {
                // The generation created this file; undoing means removing it.
                if path.is_file() {
                    if let Err(e) = fs::remove_file(&path) {
                        out.failed.push(format!("{}: {e}", item.path));
                        continue;
                    }
                }
                out.removed += 1;
                inverse.record(&item.path, before, None);
                out.paths.push((item.path.clone(), None));
            }
            Some(prev) => {
                let Some(bytes) = read_blob(prev) else {
                    out.failed
                        .push(format!("{}: falta el respaldo {prev}", item.path));
                    continue;
                };
                if let Err(e) = write_atomic(&path, &bytes) {
                    out.failed.push(format!("{}: {e}", item.path));
                    continue;
                }
                out.restored += 1;
                inverse.record(&item.path, before, Some(prev.clone()));
                out.paths.push((item.path.clone(), Some(prev.clone())));
            }
        }
    }

    out.inverse_id = inverse.commit();

    if out.restored + out.removed > 0 {
        let _guard = INDEX_LOCK.lock();
        let mut index = load_index();
        if let Some(g) = index.generations.iter_mut().find(|g| g.id == id) {
            g.undone_by = out.inverse_id.clone().or(Some("?".into()));
        }
        let _ = save_index(&index);
    }

    Ok(out)
}

/// Write one file back to a specific stored version.
pub fn restore_file(rel: &str, bytes: &[u8], note: &str, content_id: &str) -> Result<(), String> {
    let path = safe_rel_path(rel)?;
    let gen = begin("", "", note);
    let before = gen.backup(rel)?;
    write_atomic(&path, bytes)?;
    gen.record(rel, before, Some(content_id.to_string()));
    gen.commit();
    Ok(())
}
