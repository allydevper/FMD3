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
    // Full detail always goes to the file log (itself gated by log.enabled).
    crate::log_file::append(line);
    // stderr + the UI log panel are always on, for every user of the app —
    // strip the local Windows profile path first: io::Error messages from
    // file operations can otherwise leak the username/folder layout there.
    let redacted = redact_local_paths(line);
    eprintln!("[lua] {redacted}");
    if let Some(app) = APP.get() {
        let _ = app.emit("lua-log", redacted.as_ref());
        // External CF helper webview has no Tauri JS; still deliver to the UI.
        let _ = app.emit_to("main", "lua-log", redacted.as_ref());
    }
}

/// Replaces the current user's home directory with a placeholder. Only
/// applied to the always-on stderr/UI broadcast above — `log_file::append`
/// callers that want full detail on disk (gated by `log.enabled`) are
/// unaffected.
fn redact_local_paths(line: &str) -> std::borrow::Cow<'_, str> {
    let Some(home) = dirs::home_dir() else {
        return std::borrow::Cow::Borrowed(line);
    };
    let home = home.to_string_lossy().into_owned();
    if home.is_empty() || !line.contains(home.as_str()) {
        return std::borrow::Cow::Borrowed(line);
    }
    std::borrow::Cow::Owned(line.replace(home.as_str(), "%USERPROFILE%"))
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
