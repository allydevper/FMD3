//! `require 'fmd.env'` — matches FMD2 LuaFMD.pas (SelectedLanguage, paths).

use mlua::{Lua, Table};

pub fn register_fmd_env(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;
    let env = lua.create_table()?;
    // FMD2 SimpleTranslator.LastSelected — UI language code
    env.set("SelectedLanguage", "en")?;
    env.set("Directory", "")?;
    env.set("ExeName", "fmd-mvp")?;
    env.set("Version", "0.1.0")?;
    env.set("Revision", "0")?;
    env.set(
        "LuaDirectory",
        super::paths::lua_root().to_string_lossy().as_ref(),
    )?;
    loaded.set("fmd.env", env)?;
    Ok(())
}
