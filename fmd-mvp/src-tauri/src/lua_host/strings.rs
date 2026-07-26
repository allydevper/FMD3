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

/// FMD2 `RemoveHostFromURL` / `SplitURL(..., path)` — strip scheme+host, keep path/query/fragment.
pub fn remove_host_from_url(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = url::Url::parse(url) {
        if parsed.has_host() {
            let mut out = String::new();
            out.push_str(parsed.path());
            if let Some(q) = parsed.query() {
                out.push('?');
                out.push_str(q);
            }
            if let Some(f) = parsed.fragment() {
                out.push('#');
                out.push_str(f);
            }
            if out.is_empty() {
                return "/".into();
            }
            return out;
        }
    }
    // Already relative or unparseable as absolute URL
    if url.starts_with('/') {
        url.to_string()
    } else if !url.contains("://") {
        format!("/{url}")
    } else {
        // Fallback: strip up to first path slash after host
        if let Some(rest) = url.find("://").and_then(|i| {
            let after = &url[i + 3..];
            after.find('/').map(|j| after[j..].to_string())
        }) {
            rest
        } else {
            url.to_string()
        }
    }
}

/// FMD2 `RemoveHostFromURLsPair` — strip hosts; drop empty links and matching names.
pub fn remove_host_from_urls_pair(links: &mut Vec<String>, names: &mut Vec<String>) {
    let mut i = 0;
    while i < links.len() {
        links[i] = remove_host_from_url(&links[i]);
        if links[i].is_empty() {
            links.remove(i);
            if i < names.len() {
                names.remove(i);
            }
        } else {
            i += 1;
        }
    }
}

/// Align chapter link/name lists like FMD2 uData post-GetInfo (trim, pad, dedupe, strip host).
pub fn normalize_chapter_lists(links: &mut Vec<String>, names: &mut Vec<String>) {
    while names.len() < links.len() {
        names.push(String::new());
    }
    while links.len() < names.len() {
        names.pop();
    }
    for l in links.iter_mut() {
        *l = l.trim().to_string();
    }
    for n in names.iter_mut() {
        *n = n.trim().to_string();
    }
    // Deduplicate by link (case-insensitive), keep first — FMD2 uData.pas
    let mut i = 0;
    while i + 1 < links.len() {
        let mut del = false;
        for k in (i + 1)..links.len() {
            if links[i].eq_ignore_ascii_case(&links[k]) {
                links.remove(i);
                if i < names.len() {
                    names.remove(i);
                }
                del = true;
                break;
            }
        }
        if !del {
            i += 1;
        }
    }
    remove_host_from_urls_pair(links, names);
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Light cleanup mirroring uData title/authors/summary trim (not full CommonStringFilter).
pub fn cleanup_manga_fields(
    title: &mut String,
    authors: &mut String,
    summary: &mut String,
) {
    *title = collapse_ws(title.trim());
    *authors = collapse_ws(authors.trim()).trim_matches(',').trim().to_string();
    *summary = summary.trim().to_string();
    if title.is_empty() {
        *title = "N/A".into();
    }
    if authors == "-" || authors == ":" {
        authors.clear();
    }
    if summary == "-" || summary == ":" {
        summary.clear();
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
        // FMD2 returns RS_InfoStatus_Unknown ("Unknown") when nothing matches.
        "Unknown".into()
    }
}

/// Apply FMD2 Pascal default args when Lua omits them:
/// `ongoing` / `complete` / `hiatus` / `cancel`.
pub fn manga_info_status_if_pos_args(args: &[String]) -> String {
    let search = args.first().map(|s| s.as_str()).unwrap_or("");
    let ongoing = args.get(1).map(|s| s.as_str()).unwrap_or("ongoing");
    let completed = args.get(2).map(|s| s.as_str()).unwrap_or("complete");
    let hiatus = args.get(3).map(|s| s.as_str()).unwrap_or("hiatus");
    let cancelled = args.get(4).map(|s| s.as_str()).unwrap_or("cancel");
    manga_info_status_if_pos(search, ongoing, completed, hiatus, cancelled)
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

/// FMD2 synautil.GetBetween — text between PairBegin and PairEnd (nested-aware).
pub fn get_between(pair_begin: &str, pair_end: &str, value: &str) -> String {
    if value == format!("{pair_begin}{pair_end}") {
        return String::new();
    }
    if value.len() < pair_begin.len() + pair_end.len() {
        return value.to_string();
    }
    let Some(after) = value.find(pair_begin).map(|i| &value[i + pair_begin.len()..]) else {
        return value.to_string();
    };
    if !after.contains(pair_end) {
        return value.to_string();
    }
    let mut depth = 1i32;
    let mut out = String::new();
    let mut i = 0usize;
    while i < after.len() {
        if after[i..].starts_with(pair_end) {
            depth -= 1;
            if depth <= 0 {
                break;
            }
        }
        if after[i..].starts_with(pair_begin) {
            depth += 1;
        }
        let ch = after[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn register_helpers(lua: &Lua) -> mlua::Result<()> {
    super::lua_log::install_print(lua)?;
    let globals = lua.globals();
    globals.set(
        "MaybeFillHost",
        lua.create_function(|_, (host, url): (String, String)| Ok(maybe_fill_host(&host, &url)))?,
    )?;
    globals.set(
        "GetBetween",
        lua.create_function(|_, (a, b, v): (String, String, String)| Ok(get_between(&a, &b, &v)))?,
    )?;
    // FMD allows 1–5 args; omitted args use Pascal defaults (ongoing/complete/hiatus/cancel).
    globals.set(
        "MangaInfoStatusIfPos",
        lua.create_function(|_, args: mlua::Variadic<Value>| {
            let mut owned = Vec::new();
            for i in 0..args.len() {
                owned.push(opt_str(args.get(i).cloned()));
            }
            Ok(manga_info_status_if_pos_args(&owned))
        })?,
    )?;
    globals.set(
        "Trim",
        lua.create_function(|_, s: String| Ok(s.trim().to_string()))?,
    )?;
    globals.set(
        "sleep",
        lua.create_function(|_, ms: u64| {
            std::thread::sleep(std::time::Duration::from_millis(ms.min(60_000)));
            Ok(())
        })?,
    )?;
    globals.set("no_error", 0)?;
    globals.set("net_problem", 1)?;
    globals.set("information_not_found", 2)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_host_ninemanga_to_path() {
        assert_eq!(
            remove_host_from_url("https://es.ninemanga.com/chapter/foo/123/"),
            "/chapter/foo/123/"
        );
    }

    #[test]
    fn remove_host_keeps_relative() {
        assert_eq!(remove_host_from_url("/chapter/foo/"), "/chapter/foo/");
    }

    #[test]
    fn normalize_strips_and_dedupes() {
        let mut links = vec![
            "https://es.ninemanga.com/chapter/a/1/".into(),
            "https://es.ninemanga.com/chapter/a/1/".into(),
            "https://es.niadd.com/chapter/b/2/".into(),
        ];
        let mut names = vec!["A".into(), "A2".into(), "B".into()];
        normalize_chapter_lists(&mut links, &mut names);
        // FMD2 deletes the earlier duplicate when a later match exists
        assert_eq!(links, vec!["/chapter/a/1/", "/chapter/b/2/"]);
        assert_eq!(names, vec!["A2", "B"]);
    }

    #[test]
    fn get_between_simple() {
        assert_eq!(
            get_between("var x=", ";", "prefix var x=hello; suffix"),
            "hello"
        );
        assert_eq!(get_between("(", ")", "()"), "");
        assert_eq!(get_between("<a>", "</a>", "nope"), "nope");
    }

    #[test]
    fn status_if_pos_defaults_like_fmd2() {
        assert_eq!(manga_info_status_if_pos_args(&["Ongoing".into()]), "1");
        assert_eq!(manga_info_status_if_pos_args(&["Completed".into()]), "0");
        assert_eq!(manga_info_status_if_pos_args(&["Hiatus".into()]), "2");
        assert_eq!(manga_info_status_if_pos_args(&["Cancelled".into()]), "3");
        assert_eq!(
            manga_info_status_if_pos_args(&[
                "Finalizado".into(),
                "En desarrollo".into(),
                "Finalizado".into(),
            ]),
            "0"
        );
        assert_eq!(manga_info_status_if_pos_args(&["#123".into()]), "Unknown");
    }
}
