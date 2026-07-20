use mlua::{Lua, UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct LuaStringList {
    inner: Arc<Mutex<Vec<String>>>,
}

impl LuaStringList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn values(&self) -> Vec<String> {
        self.inner.lock().clone()
    }
}

impl UserData for LuaStringList {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: Value| {
            match key {
                Value::String(s) => {
                    let key = s.to_string_lossy();
                    match key.as_str() {
                        "Add" => {
                            let this = this.clone();
                            let f = lua.create_function(move |_, value: String| {
                                this.inner.lock().push(value);
                                Ok(())
                            })?;
                            Ok(Value::Function(f))
                        }
                        "Reverse" => {
                            let this = this.clone();
                            let f = lua.create_function(move |_, ()| {
                                this.inner.lock().reverse();
                                Ok(())
                            })?;
                            Ok(Value::Function(f))
                        }
                        "Clear" => {
                            let this = this.clone();
                            let f = lua.create_function(move |_, ()| {
                                this.inner.lock().clear();
                                Ok(())
                            })?;
                            Ok(Value::Function(f))
                        }
                        "Count" => Ok(Value::Integer(this.inner.lock().len() as i64)),
                        _ => Ok(Value::Nil),
                    }
                }
                Value::Integer(i) if i >= 1 => {
                    let list = this.inner.lock();
                    let idx = (i as usize).saturating_sub(1);
                    if let Some(s) = list.get(idx) {
                        Ok(Value::String(lua.create_string(s)?))
                    } else {
                        Ok(Value::Nil)
                    }
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method(mlua::MetaMethod::Len, |_, this, ()| {
            Ok(this.inner.lock().len())
        });
    }
}

pub fn maybe_fill_host(host: &str, url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    let host = host.trim_end_matches('/');
    if url.starts_with('/') {
        format!("{host}{url}")
    } else {
        format!("{host}/{url}")
    }
}

pub fn manga_info_status_if_pos(
    search: &str,
    ongoing: &str,
    completed: &str,
    hiatus: &str,
    cancelled: &str,
) -> String {
    if search.is_empty() {
        return String::new();
    }
    let s = search.to_lowercase();
    let matches = |needle: &str| -> bool {
        if needle.is_empty() {
            return false;
        }
        needle
            .split('|')
            .any(|p| !p.is_empty() && s.contains(&p.to_lowercase()))
    };
    if matches(ongoing) {
        "1".into()
    } else if matches(completed) {
        "0".into()
    } else if matches(hiatus) {
        "2".into()
    } else if matches(cancelled) {
        "3".into()
    } else {
        String::new()
    }
}

pub fn register_helpers(lua: &Lua) -> mlua::Result<()> {
    let globals = lua.globals();
    globals.set(
        "MaybeFillHost",
        lua.create_function(|_, (host, url): (String, String)| Ok(maybe_fill_host(&host, &url)))?,
    )?;
    globals.set(
        "MangaInfoStatusIfPos",
        lua.create_function(
            |_,
             (search, ongoing, completed, hiatus, cancelled): (
                String,
                String,
                String,
                String,
                String,
            )| {
                Ok(manga_info_status_if_pos(
                    &search, &ongoing, &completed, &hiatus, &cancelled,
                ))
            },
        )?,
    )?;
    globals.set("no_error", 0)?;
    globals.set("net_problem", 1)?;
    globals.set("information_not_found", 2)?;
    Ok(())
}
