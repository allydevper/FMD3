//! Duktape ExecJS — same role as FMD2 `fmd.duktape` / Duktape.pas.

use mlua::{Lua, Table};
use std::os::raw::{c_char, c_void};
use std::ffi::CStr;

extern "C" {
    fn fmd_duk_execjs(
        src: *const c_char,
        len: usize,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut c_char;
    fn fmd_duk_free(p: *mut c_char);
}

/// Evaluate JavaScript; returns the string result (empty if undefined).
pub fn exec_js(script: &str) -> Result<String, String> {
    let mut err = vec![0u8; 512];
    unsafe {
        let ptr = fmd_duk_execjs(
            script.as_ptr() as *const c_char,
            script.len(),
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        );
        if ptr.is_null() {
            let msg = CStr::from_ptr(err.as_ptr() as *const c_char)
                .to_string_lossy()
                .into_owned();
            return Err(if msg.is_empty() {
                "Duktape ExecJS failed".into()
            } else {
                msg
            });
        }
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        fmd_duk_free(ptr as *mut c_char);
        // silence unused warning if c_void imported for future
        let _ = std::ptr::null::<c_void>();
        Ok(s)
    }
}

pub fn register_fmd_duktape(lua: &Lua) -> mlua::Result<()> {
    let package: Table = lua.globals().get("package")?;
    let loaded: Table = package.get("loaded")?;
    let duk = lua.create_table()?;
    duk.set(
        "ExecJS",
        lua.create_function(|_, script: String| match exec_js(&script) {
            Ok(s) => Ok(s),
            Err(e) => Err(mlua::Error::external(e)),
        })?,
    )?;
    loaded.set("fmd.duktape", duk)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_js_add() {
        let s = exec_js("1+2").unwrap();
        assert_eq!(s.trim(), "3");
    }
}
