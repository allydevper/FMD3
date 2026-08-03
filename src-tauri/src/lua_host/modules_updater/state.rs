//! Persistence for `userdata/lua.json` (tracked files) and `userdata/lua_repo.json`
//! (per-source change cursors), plus the path/hash primitives everything else uses.

use super::model::{
    LuaRepoEntry, RepoState, FLAG_NEW, FLAG_NONE, FLAG_UPDATE, STATE_SCHEMA,
};
use crate::db;
use crate::lua_host::paths::lua_root;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn userdata_dir() -> PathBuf {
    db::userdata_path()
}

pub fn lua_json_path() -> PathBuf {
    userdata_dir().join("lua.json")
}

pub fn cursor_path() -> PathBuf {
    userdata_dir().join("lua_repo.json")
}

pub fn ensure_userdata() -> Result<(), String> {
    fs::create_dir_all(userdata_dir()).map_err(|e| format!("userdata: {e}"))
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn file_mtime_unix(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// `git hash-object` of a blob: SHA-1 over `blob <len>\0<bytes>`.
pub fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/* ---------------------------------------------------------------------- */
/* Path safety                                                             */
/* ---------------------------------------------------------------------- */

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_reserved(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// Resolve a source-supplied relative path under the Lua root, or reject it.
///
/// Purely lexical — the file need not exist, so `canonicalize` is not an option.
/// Every path that reaches the filesystem passes through here: entries from a
/// remote listing, names inside a downloaded archive, and paths read back from
/// `lua.json` or the backup index (a tampered state file must not be able to
/// write outside the tree either).
pub fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    let bad = |why: &str| Err(format!("ruta rechazada «{rel}»: {why}"));
    if rel.trim().is_empty() {
        return bad("vacía");
    }
    if rel.contains('\0') {
        return bad("carácter nulo");
    }
    let norm = rel.replace('\\', "/");
    if norm.starts_with('/') {
        return bad("absoluta");
    }
    for comp in norm.split('/') {
        if comp.is_empty() {
            return bad("componente vacío");
        }
        if comp == "." || comp == ".." {
            return bad("componente relativo");
        }
        if comp.contains(':') {
            return bad("prefijo de unidad");
        }
        if comp.ends_with('.') || comp.ends_with(' ') {
            return bad("componente termina en punto o espacio");
        }
        if is_reserved(comp) {
            return bad("nombre de dispositivo reservado");
        }
    }
    let root = lua_root();
    let full = root.join(norm.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !full.starts_with(&root) {
        return bad("fuera del árbol lua");
    }
    Ok(full)
}

/// Same as [`safe_rel_path`] but never fails; used where a reject just means
/// "treat as absent". Callers that write must use `safe_rel_path`.
pub fn local_file_path(rel: &str) -> Option<PathBuf> {
    safe_rel_path(rel).ok()
}

/* ---------------------------------------------------------------------- */
/* Atomic writes                                                           */
/* ---------------------------------------------------------------------- */

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("renombrar a {}: {e}", path.display()));
    }
    Ok(())
}

/* ---------------------------------------------------------------------- */
/* lua.json                                                                */
/* ---------------------------------------------------------------------- */

/// Read `lua.json`, migrating the v1 shape (a bare array) on the way in.
///
/// v1 recorded only the remote sha, so a run that never applied left every
/// entry flagged `new` even when the file already existed on disk. v2 records
/// `local_id` — the content id of the bytes actually present — which makes the
/// flag derivable instead of remembered.
pub fn load_state() -> RepoState {
    let path = lua_json_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return RepoState::default();
    };
    if let Ok(state) = serde_json::from_str::<RepoState>(&raw) {
        if state.schema >= STATE_SCHEMA {
            return state;
        }
    }
    match serde_json::from_str::<Vec<LuaRepoEntry>>(&raw) {
        Ok(entries) => {
            let migrated = migrate_v1(entries);
            let _ = fs::write(path.with_extension("json.v1.bak"), &raw);
            let _ = save_state(&migrated);
            migrated
        }
        Err(e) => {
            eprintln!("modules_updater: lua.json ilegible ({e}); se reconstruye");
            RepoState::default()
        }
    }
}

/// Recompute every flag from what is on disk, discarding v1's stale ones.
fn migrate_v1(entries: Vec<LuaRepoEntry>) -> RepoState {
    let mut out = Vec::with_capacity(entries.len());
    for mut e in entries {
        let disk = local_file_path(&e.name);
        let bytes = disk.as_ref().and_then(|p| fs::read(p).ok());
        e.local_id = bytes.as_deref().map(git_blob_sha);
        e.last_modified = e
            .last_modified
            .or_else(|| disk.as_deref().and_then(file_mtime_unix));
        e.flag = if e.is_current() {
            FLAG_NONE.into()
        } else if e.local_id.is_none() {
            FLAG_NEW.into()
        } else {
            FLAG_UPDATE.into()
        };
        e.clear_failure();
        out.push(e);
    }
    let mut state = RepoState {
        schema: STATE_SCHEMA,
        source_id: String::new(),
        entries: out,
    };
    state.sort();
    state
}

pub fn save_state(state: &RepoState) -> Result<(), String> {
    ensure_userdata()?;
    let raw = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&lua_json_path(), &raw).map_err(|e| format!("guardar lua.json: {e}"))
}

/* ---------------------------------------------------------------------- */
/* Change cursors                                                          */
/* ---------------------------------------------------------------------- */

/// What a source needs to answer "has anything changed since last time?".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceCursor {
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub checked_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CursorFile {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    cursors: HashMap<String, SourceCursor>,
    // v1 fields, read once and folded into `cursors`.
    #[serde(default)]
    last_commit_sha: String,
    #[serde(default)]
    last_commit_etag: String,
}

fn load_cursor_file() -> CursorFile {
    fs::read_to_string(cursor_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<CursorFile>(&raw).ok())
        .unwrap_or_default()
}

pub fn load_cursor(source_id: &str) -> SourceCursor {
    let file = load_cursor_file();
    if let Some(c) = file.cursors.get(source_id) {
        return c.clone();
    }
    // v1 held a single unnamed GitHub cursor; adopt it for whatever source runs first.
    if file.schema == 0 && !file.last_commit_sha.is_empty() {
        return SourceCursor {
            revision: file.last_commit_sha,
            etag: file.last_commit_etag,
            checked_at: 0,
        };
    }
    SourceCursor::default()
}

pub fn save_cursor(source_id: &str, cursor: &SourceCursor) -> Result<(), String> {
    ensure_userdata()?;
    let mut file = load_cursor_file();
    file.schema = STATE_SCHEMA;
    file.last_commit_sha = String::new();
    file.last_commit_etag = String::new();
    file.cursors.insert(source_id.to_string(), cursor.clone());
    let raw = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    write_atomic(&cursor_path(), &raw).map_err(|e| format!("guardar lua_repo.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_sha_matches_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            git_blob_sha(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        // `git hash-object` of an empty file
        assert_eq!(
            git_blob_sha(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    }

    #[test]
    fn rejects_traversal_and_devices() {
        for bad in [
            "",
            "   ",
            "../x.lua",
            "modules/../../x.lua",
            "/etc/passwd",
            "C:/Windows/x.lua",
            "C:\\Windows\\x.lua",
            "modules/./x.lua",
            "modules//x.lua",
            "modules/CON.lua",
            "modules/nul",
            "modules/x.lua ",
            "modules/x.",
            "..\\x.lua",
        ] {
            assert!(safe_rel_path(bad).is_err(), "debería rechazar: {bad:?}");
        }
    }

    #[test]
    fn accepts_normal_paths() {
        for ok in [
            "modules/Foo.lua",
            "templates/NiAdd.lua",
            "extras/mangafoxtemplate/728-01.png",
            "utils/json.lua",
        ] {
            let p = safe_rel_path(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
            assert!(p.starts_with(lua_root()));
        }
    }

    #[test]
    fn backslashes_are_normalized() {
        let a = safe_rel_path("modules/Foo.lua").unwrap();
        let b = safe_rel_path("modules\\Foo.lua").unwrap();
        assert_eq!(a, b);
    }
}
