//! On-disk cache of the module registry.
//!
//! Scanning `lua/modules` means spinning up one Lua VM per file (~600 of them),
//! which is the bulk of the app's cold start. The scan result is deterministic
//! for a given set of Lua files, so we persist it and reuse it whenever a
//! fingerprint of the Lua tree still matches.

use super::paths::{lua_root, modules_dir, templates_dir, utils_dir, websitebypass_dir};
use super::registry::ModuleMeta;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Bump when the shape of `ModuleMeta` or the meaning of the scan changes in a
/// way that existing cache files would no longer describe correctly.
const CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    /// App version: invalidates the cache on every release, covering changes to
    /// the Lua helpers or interpreter that alter scan results without touching
    /// any `.lua` file.
    app: String,
    fingerprint: String,
    modules: Vec<ModuleMeta>,
}

fn cache_path() -> PathBuf {
    crate::db::db_path().join("modules_cache.json")
}

/// Feeds `name \0 len \0 mtime` of every `.lua` under `dir` into the hasher.
/// Entries are sorted so the digest does not depend on directory order.
fn hash_dir(hasher: &mut Sha256, label: &str, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        hasher.update(format!("{label}\0missing\n"));
        return;
    };
    let mut rows: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("lua"))
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (len, mtime) = e
                .metadata()
                .map(|m| {
                    let mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    (m.len(), mtime)
                })
                .unwrap_or((0, 0));
            format!("{label}/{name}\0{len}\0{mtime}\n")
        })
        .collect();
    rows.sort();
    for row in rows {
        hasher.update(row);
    }
}

/// Fingerprint of the whole Lua tree. `templates` and `utils` matter because
/// most modules `require` them, so a template edit can change what `Init()`
/// registers without any file in `modules/` being touched.
pub fn fingerprint() -> String {
    let mut hasher = Sha256::new();
    // `ModuleMeta.file_path` is absolute, so a cache written for one install
    // location must not be reused after the app (or a portable copy) moves:
    // file names, sizes and mtimes all survive a move, the root path does not.
    hasher.update(format!("root\0{}\n", lua_root().to_string_lossy()));
    hash_dir(&mut hasher, "modules", &modules_dir());
    hash_dir(&mut hasher, "templates", &templates_dir());
    hash_dir(&mut hasher, "utils", &utils_dir());
    hash_dir(&mut hasher, "websitebypass", &websitebypass_dir());
    format!("{:x}", hasher.finalize())
}

/// Returns the cached module list if it matches `fingerprint`, else `None`.
/// Any IO or parse failure is treated as a cache miss.
pub fn load(fingerprint: &str) -> Option<Vec<ModuleMeta>> {
    let raw = std::fs::read_to_string(cache_path()).ok()?;
    let cached: CacheFile = serde_json::from_str(&raw).ok()?;
    if cached.version != CACHE_VERSION
        || cached.app != env!("CARGO_PKG_VERSION")
        || cached.fingerprint != fingerprint
    {
        return None;
    }
    if cached.modules.is_empty() {
        return None;
    }
    Some(cached.modules)
}

/// Writes the cache atomically (tmp + rename). Failures are logged and ignored:
/// a broken cache must never break startup.
pub fn store(fingerprint: &str, modules: &[ModuleMeta]) {
    if modules.is_empty() {
        return;
    }
    let path = cache_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("registry cache: no se pudo crear {}: {e}", parent.display());
            return;
        }
    }
    let payload = CacheFile {
        version: CACHE_VERSION,
        app: env!("CARGO_PKG_VERSION").to_string(),
        fingerprint: fingerprint.to_string(),
        modules: modules.to_vec(),
    };
    let Ok(json) = serde_json::to_string(&payload) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, json) {
        eprintln!("registry cache: no se pudo escribir {}: {e}", tmp.display());
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        eprintln!(
            "registry cache: no se pudo renombrar a {}: {e}",
            path.display()
        );
        let _ = std::fs::remove_file(&tmp);
    }
}
