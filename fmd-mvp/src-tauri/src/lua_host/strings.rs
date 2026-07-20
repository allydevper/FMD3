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

    pub fn set(&self, index_0: usize, value: String) {
        let mut list = self.inner.lock();
        if index_0 >= list.len() {
            list.resize(index_0 + 1, String::new());
        }
        list[index_0] = value;
    }

    pub fn get(&self, index_0: usize) -> Option<String> {
        self.inner.lock().get(index_0).cloned()
    }

    pub fn push(&self, value: String) {
        self.inner.lock().push(value);
    }

    pub fn clear(&self) {
        self.inner.lock().clear();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
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
                                this.push(value);
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
                                this.clear();
                                Ok(())
                            })?;
                            Ok(Value::Function(f))
                        }
                        "Count" => Ok(Value::Integer(this.len() as i64)),
                        _ => Ok(Value::Nil),
                    }
                }
                // FMD uses 0-based indexing for PageLinks[WORKID]
                Value::Integer(i) if i >= 0 => {
                    let idx = i as usize;
                    if let Some(s) = this.get(idx) {
                        Ok(Value::String(lua.create_string(&s)?))
                    } else {
                        Ok(Value::Nil)
                    }
                }
                Value::Number(n) if n >= 0.0 && n.fract() == 0.0 => {
                    let idx = n as usize;
                    if let Some(s) = this.get(idx) {
                        Ok(Value::String(lua.create_string(&s)?))
                    } else {
                        Ok(Value::Nil)
                    }
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (Value, Value)| {
                let idx = match key {
                    Value::Integer(i) if i >= 0 => i as usize,
                    Value::Number(n) if n >= 0.0 && n.fract() == 0.0 => n as usize,
                    _ => return Ok(()),
                };
                let s = match value {
                    Value::String(s) => s.to_string_lossy(),
                    Value::Integer(i) => i.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::Boolean(b) => b.to_string(),
                    _ => String::new(),
                };
                this.set(idx, s);
                Ok(())
            },
        );
        methods.add_meta_method(mlua::MetaMethod::Len, |_, this, ()| Ok(this.len()));
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

fn opt_str(v: Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.to_string_lossy(),
        Some(Value::Integer(i)) => i.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Boolean(b)) => b.to_string(),
        _ => String::new(),
    }
}

pub fn register_helpers(lua: &Lua) -> mlua::Result<()> {
    let globals = lua.globals();
    globals.set(
        "MaybeFillHost",
        lua.create_function(|_, (host, url): (String, String)| Ok(maybe_fill_host(&host, &url)))?,
    )?;
    // FMD allows 3–5 args: (search, ongoing, completed[, hiatus[, cancelled]])
    globals.set(
        "MangaInfoStatusIfPos",
        lua.create_function(|_, args: mlua::Variadic<Value>| {
            let search = opt_str(args.get(0).cloned());
            let ongoing = opt_str(args.get(1).cloned());
            let completed = opt_str(args.get(2).cloned());
            let hiatus = opt_str(args.get(3).cloned());
            let cancelled = opt_str(args.get(4).cloned());
            Ok(manga_info_status_if_pos(
                &search, &ongoing, &completed, &hiatus, &cancelled,
            ))
        })?,
    )?;
    globals.set("no_error", 0)?;
    globals.set("net_problem", 1)?;
    globals.set("information_not_found", 2)?;
    Ok(())
}
