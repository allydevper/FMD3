use std::path::PathBuf;

/// Root of the Lua tree (`…/lua` containing `modules/` and `templates/`).
pub fn lua_root() -> PathBuf {
    if let Ok(p) = std::env::var("FMD_LUA_ROOT") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return p;
        }
    }

    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lua"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("lua")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../lua")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../../../lua")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("resources/lua")))
            .unwrap_or_default(),
        // NSIS / portable: lua next to exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("lua")))
            .unwrap_or_default(),
        // Tauri 2 resource folder on Windows often under `_up_` or beside exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("_up_/lua")))
            .unwrap_or_default(),
        std::env::current_dir()
            .map(|d| d.join("../lua"))
            .unwrap_or_default(),
        std::env::current_dir()
            .map(|d| d.join("../../lua"))
            .unwrap_or_default(),
    ];

    for c in candidates {
        if c.join("modules").is_dir() {
            return c;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lua")
}

pub fn modules_dir() -> PathBuf {
    lua_root().join("modules")
}

pub fn templates_dir() -> PathBuf {
    lua_root().join("templates")
}

/// `package.path` entries so `require 'templates.NiAdd'` and `require 'fmd.crypto'` resolve.
pub fn package_path() -> String {
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
