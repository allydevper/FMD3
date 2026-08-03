//! Forward Lua `print` / Logger messages to the UI log panel.

use mlua::{Lua, Value};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn emit_lua_log(msg: &str) {
    let line = msg.trim_end();
    if line.is_empty() {
        return;
    }
    eprintln!("[lua] {line}");
    crate::log_file::append(line);
    if let Some(app) = APP.get() {
        let _ = app.emit("lua-log", line);
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Nil => "nil".into(),
        Value::Boolean(b) => b.to_string(),
        Value::Integer(i) => i.to_string(),
        Value::Number(n) => {
            if *n == (*n as i64) as f64 {
                (*n as i64).to_string()
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.to_string_lossy().to_string(),
        Value::Table(_) => "table".into(),
        Value::Function(_) => "function".into(),
        Value::UserData(_) => "userdata".into(),
        Value::LightUserData(_) => "userdata".into(),
        Value::Thread(_) => "thread".into(),
        Value::Error(e) => e.to_string(),
        _ => "?".into(),
    }
}

/// Override global `print` so modules' `print(...)` reach the UI.
pub fn install_print(lua: &Lua) -> mlua::Result<()> {
    lua.globals().set(
        "print",
        lua.create_function(|_, args: mlua::Variadic<Value>| {
            let parts: Vec<String> = args.iter().map(value_to_string).collect();
            emit_lua_log(&parts.join("\t"));
            Ok(())
        })?,
    )?;
    Ok(())
}
