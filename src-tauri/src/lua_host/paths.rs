use once_cell::sync::Lazy;
use std::path::PathBuf;

// Resolved once: `compute_lua_root` probes up to nine candidate directories and
// `setup_package_path` runs per scanned module file (~600 of them).
static LUA_ROOT: Lazy<PathBuf> = Lazy::new(compute_lua_root);
static PACKAGE_PATH: Lazy<String> = Lazy::new(compute_package_path);

/// Root of the Lua tree (`…/lua` containing `modules/` and `templates/`).
pub fn lua_root() -> PathBuf {
    LUA_ROOT.clone()
}

/// `package.path` entries so `require 'templates.NiAdd'` and `require 'fmd.crypto'` resolve.
pub fn package_path() -> String {
    PACKAGE_PATH.clone()
}

/// Where the Lua tree lives.
///
/// In a release build this is **always** `userdata/lua`, never the install
/// directory. The installer used to ship `lua/` as a bundled resource, which
/// meant every app update silently overwrote the modules the user had synced —
/// the installer and the modules updater were writing to the same folder. The
/// tree is no longer packaged: the updater downloads it in one archive, so the
/// only copy that exists is the writable one under `userdata/`.
fn compute_lua_root() -> PathBuf {
    if let Ok(p) = std::env::var("FMD_LUA_ROOT") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return p;
        }
    }

    // Development: the repo's own `lua/` stays the working tree, so `git status`
    // still tells you whether the updater touched anything. Debug builds only —
    // a release binary must behave identically on the build machine and on a
    // user's, and CARGO_MANIFEST_DIR is baked in at compile time.
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lua");
        if has_modules(&repo) {
            return repo;
        }
    }

    let target = user_lua_dir();

    // Installations from before the tree moved keep it next to the exe.
    if !has_modules(&target) {
        for legacy in legacy_roots() {
            if has_modules(&legacy) {
                migrate_tree(&legacy, &target);
                break;
            }
        }
    }

    if let Err(e) = std::fs::create_dir_all(target.join("modules")) {
        eprintln!("lua paths: no se pudo crear {}: {e}", target.display());
    }
    target
}

fn has_modules(dir: &std::path::Path) -> bool {
    dir.join("modules").is_dir()
}

/// `%APPDATA%/FMD3/userdata/lua` — beside `lua.json` and `lua_backup/`,
/// and outside anything the installer writes.
fn user_lua_dir() -> PathBuf {
    crate::db::userdata_path().join("lua")
}

fn legacy_roots() -> Vec<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let Some(dir) = exe_dir else {
        return Vec::new();
    };
    vec![dir.join("lua"), dir.join("resources/lua"), dir.join("_up_/lua")]
}

/// Move a pre-existing tree into `userdata`. Falls back to copying when the
/// rename crosses a volume or the source is read-only; leaving the original in
/// place is harmless because `has_modules(target)` wins from then on.
fn migrate_tree(from: &std::path::Path, to: &PathBuf) {
    if let Some(parent) = to.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("lua paths: no se pudo crear {}: {e}", parent.display());
            return;
        }
    }
    if std::fs::rename(from, to).is_ok() {
        eprintln!("lua paths: árbol movido de {} a {}", from.display(), to.display());
        return;
    }
    if let Err(e) = copy_tree(from, to) {
        eprintln!("lua paths: no se pudo migrar {}: {e}", from.display());
        return;
    }
    eprintln!("lua paths: árbol copiado de {} a {}", from.display(), to.display());
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &dst)?;
        } else {
            std::fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
}

/// True when the tree has no modules yet, i.e. the app has never synced.
/// The UI uses this to run the first sync instead of showing an empty list.
pub fn needs_first_sync() -> bool {
    let Ok(rd) = std::fs::read_dir(modules_dir()) else {
        return true;
    };
    !rd.flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("lua"))
}

pub fn modules_dir() -> PathBuf {
    lua_root().join("modules")
}

pub fn templates_dir() -> PathBuf {
    lua_root().join("templates")
}

fn compute_package_path() -> String {
    let root = lua_root();
    let tpl = templates_dir();
    let root_s = root.to_string_lossy().replace('\\', "/");
    let tpl_s = tpl.to_string_lossy().replace('\\', "/");
    let wb_s = root
        .join("websitebypass")
        .to_string_lossy()
        .replace('\\', "/");
    format!(
        "{root_s}/?.lua;{root_s}/?/init.lua;{tpl_s}/?.lua;{tpl_s}/?/init.lua;{root_s}/templates/?.lua;{wb_s}/?.lua;{root_s}/websitebypass/?.lua;;"
    )
}

pub fn websitebypass_dir() -> PathBuf {
    lua_root().join("websitebypass")
}

pub fn utils_dir() -> PathBuf {
    lua_root().join("utils")
}

/// `lua/extras` — image-hoster helpers and the MangaFox watermark templates.
/// Synced from the remote like everything else, so the registry fingerprint
/// has to see it too.
pub fn extras_dir() -> PathBuf {
    lua_root().join("extras")
}
