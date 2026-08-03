//! Local directory source — no network.
//!
//! Serves two purposes: developing against a checkout of the Lua tree, and
//! importing a folder of modules someone shared out of band.

use super::{Probe, RemoteEntry, Source};
use crate::lua_host::modules_updater::state::{git_blob_sha, now_unix, safe_rel_path, SourceCursor};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub struct LocalDirSource {
    root: PathBuf,
}

impl LocalDirSource {
    pub fn new(dir: String) -> Self {
        Self {
            root: PathBuf::from(dir),
        }
    }

    fn walk(&self, dir: &Path, prefix: &str, out: &mut Vec<RemoteEntry>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for ent in entries {
            let name = ent.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let path = ent.path();
            if path.is_dir() {
                self.walk(&path, &rel, out);
                continue;
            }
            if safe_rel_path(&rel).is_err() {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            out.push(RemoteEntry {
                content_id: git_blob_sha(&bytes),
                size: Some(bytes.len() as u64),
                path: rel,
            });
        }
    }
}

impl Source for LocalDirSource {
    fn id(&self) -> String {
        format!("local:{}", self.root.to_string_lossy())
    }

    fn label(&self) -> String {
        format!("Carpeta local {}", self.root.display())
    }

    /// No cheap probe exists for a folder, so the listing itself is the probe:
    /// hash the (path, content id) pairs and compare with the stored revision.
    fn probe(&self, cursor: &mut SourceCursor) -> Result<Probe, String> {
        if !self.root.is_dir() {
            return Err(format!("No existe la carpeta {}", self.root.display()));
        }
        let entries = self.list("")?;
        let mut h = Sha256::new();
        for e in &entries {
            h.update(e.path.as_bytes());
            h.update(b"\0");
            h.update(e.content_id.as_bytes());
            h.update(b"\n");
        }
        let revision = format!("{:x}", h.finalize());
        let unchanged = cursor.revision == revision;
        cursor.revision = revision.clone();
        cursor.checked_at = now_unix();
        if unchanged {
            Ok(Probe::Unchanged)
        } else {
            Ok(Probe::Changed { revision })
        }
    }

    fn list(&self, _revision: &str) -> Result<Vec<RemoteEntry>, String> {
        if !self.root.is_dir() {
            return Err(format!("No existe la carpeta {}", self.root.display()));
        }
        let mut out = Vec::new();
        self.walk(&self.root.clone(), "", &mut out);
        if out.is_empty() {
            return Err(format!("{} está vacía", self.root.display()));
        }
        Ok(out)
    }

    fn content_id(&self, bytes: &[u8]) -> String {
        git_blob_sha(bytes)
    }

    fn fetch_one(&self, _revision: &str, path: &str) -> Result<Vec<u8>, String> {
        // The source path is ours to validate too: the same lexical rules keep a
        // crafted listing from reaching outside the configured folder.
        for comp in path.replace('\\', "/").split('/') {
            if comp == ".." || comp.is_empty() || comp == "." {
                return Err(format!("ruta rechazada «{path}»"));
            }
        }
        let full = self.root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !full.starts_with(&self.root) {
            return Err(format!("ruta rechazada «{path}»"));
        }
        fs::read(&full).map_err(|e| format!("{}: {e}", full.display()))
    }

    fn max_parallel(&self) -> usize {
        4
    }
}
