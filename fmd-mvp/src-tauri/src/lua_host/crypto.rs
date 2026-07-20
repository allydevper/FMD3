use base64::{engine::general_purpose::STANDARD, Engine};
use mlua::{Lua, Table};

pub fn register_fmd_crypto(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;

    let crypto = lua.create_table()?;
    crypto.set(
        "DecodeBase64",
        lua.create_function(|_, data: String| {
            let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
            match STANDARD.decode(cleaned.as_bytes()) {
                Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
                Err(_) => Ok(None),
            }
        })?,
    )?;

    loaded.set("fmd.crypto", crypto)?;
    Ok(())
}
