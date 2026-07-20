use super::crypto::register_fmd_crypto;
use super::http::HttpClient;
use super::strings::{register_helpers, LuaStringList};
use crate::xpath::{DomNode, TxQuery};
use mlua::{Lua, UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct ChapterInfo {
    pub index: usize,
    pub name: String,
    pub link: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MangaInfoResult {
    pub title: String,
    pub cover: String,
    pub authors: String,
    pub status: String,
    pub summary: String,
    pub chapters: Vec<ChapterInfo>,
    pub module_id: String,
    pub module_name: String,
    pub root_url: String,
}

#[derive(Clone, Default)]
struct ModuleState {
    id: String,
    name: String,
    root_url: String,
    category: String,
    on_get_info: String,
    on_get_page_number: String,
    on_get_name_and_link: String,
    total_directory: i64,
    current_directory_index: i64,
}

#[derive(Clone, Default)]
struct ModuleHandle {
    inner: Arc<Mutex<ModuleState>>,
}

impl UserData for ModuleHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            let s = this.inner.lock();
            let val = match key.as_str() {
                "ID" => Value::String(lua.create_string(&s.id)?),
                "Name" => Value::String(lua.create_string(&s.name)?),
                "RootURL" => Value::String(lua.create_string(&s.root_url)?),
                "Category" => Value::String(lua.create_string(&s.category)?),
                "OnGetInfo" => Value::String(lua.create_string(&s.on_get_info)?),
                "OnGetPageNumber" => Value::String(lua.create_string(&s.on_get_page_number)?),
                "OnGetNameAndLink" => Value::String(lua.create_string(&s.on_get_name_and_link)?),
                "TotalDirectory" => Value::Integer(s.total_directory),
                "CurrentDirectoryIndex" => Value::Integer(s.current_directory_index),
                _ => Value::Nil,
            };
            Ok(val)
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let mut s = this.inner.lock();
                match key.as_str() {
                    "ID" => s.id = value_to_string(value),
                    "Name" => s.name = value_to_string(value),
                    "RootURL" => s.root_url = value_to_string(value),
                    "Category" => s.category = value_to_string(value),
                    "OnGetInfo" => s.on_get_info = value_to_string(value),
                    "OnGetPageNumber" => s.on_get_page_number = value_to_string(value),
                    "OnGetNameAndLink" => s.on_get_name_and_link = value_to_string(value),
                    "TotalDirectory" => {
                        s.total_directory = match value {
                            Value::Integer(i) => i,
                            Value::Number(n) => n as i64,
                            _ => 0,
                        }
                    }
                    "CurrentDirectoryIndex" => {
                        s.current_directory_index = match value {
                            Value::Integer(i) => i,
                            Value::Number(n) => n as i64,
                            _ => 0,
                        }
                    }
                    _ => {}
                }
                Ok(())
            },
        );
    }
}

fn value_to_string(value: Value) -> String {
    match value {
        Value::String(s) => s.to_string_lossy(),
        Value::Integer(i) => i.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Boolean(b) => b.to_string(),
        _ => String::new(),
    }
}

#[derive(Clone)]
struct MangaInfoHandle {
    title: Arc<Mutex<String>>,
    alt_titles: Arc<Mutex<String>>,
    cover: Arc<Mutex<String>>,
    authors: Arc<Mutex<String>>,
    artists: Arc<Mutex<String>>,
    genres: Arc<Mutex<String>>,
    status: Arc<Mutex<String>>,
    summary: Arc<Mutex<String>>,
    chapter_links: LuaStringList,
    chapter_names: LuaStringList,
}

impl MangaInfoHandle {
    fn new() -> Self {
        Self {
            title: Arc::new(Mutex::new(String::new())),
            alt_titles: Arc::new(Mutex::new(String::new())),
            cover: Arc::new(Mutex::new(String::new())),
            authors: Arc::new(Mutex::new(String::new())),
            artists: Arc::new(Mutex::new(String::new())),
            genres: Arc::new(Mutex::new(String::new())),
            status: Arc::new(Mutex::new(String::new())),
            summary: Arc::new(Mutex::new(String::new())),
            chapter_links: LuaStringList::new(),
            chapter_names: LuaStringList::new(),
        }
    }
}

impl UserData for MangaInfoHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            let val = match key.as_str() {
                "Title" => Value::String(lua.create_string(this.title.lock().as_str())?),
                "AltTitles" => Value::String(lua.create_string(this.alt_titles.lock().as_str())?),
                "CoverLink" => Value::String(lua.create_string(this.cover.lock().as_str())?),
                "Authors" => Value::String(lua.create_string(this.authors.lock().as_str())?),
                "Artists" => Value::String(lua.create_string(this.artists.lock().as_str())?),
                "Genres" => Value::String(lua.create_string(this.genres.lock().as_str())?),
                "Status" => Value::String(lua.create_string(this.status.lock().as_str())?),
                "Summary" => Value::String(lua.create_string(this.summary.lock().as_str())?),
                "ChapterLinks" => {
                    Value::UserData(lua.create_userdata(this.chapter_links.clone())?)
                }
                "ChapterNames" => {
                    Value::UserData(lua.create_userdata(this.chapter_names.clone())?)
                }
                _ => Value::Nil,
            };
            Ok(val)
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                let s = value_to_string(value);
                match key.as_str() {
                    "Title" => *this.title.lock() = s,
                    "AltTitles" => *this.alt_titles.lock() = s,
                    "CoverLink" => *this.cover.lock() = s,
                    "Authors" => *this.authors.lock() = s,
                    "Artists" => *this.artists.lock() = s,
                    "Genres" => *this.genres.lock() = s,
                    "Status" => *this.status.lock() = s,
                    "Summary" => *this.summary.lock() = s,
                    _ => {}
                }
                Ok(())
            },
        );
    }
}

#[derive(Clone)]
struct TaskHandle {
    page_links: LuaStringList,
}

impl TaskHandle {
    fn new() -> Self {
        Self {
            page_links: LuaStringList::new(),
        }
    }
}

impl UserData for TaskHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            if key == "PageLinks" {
                Ok(Value::UserData(
                    lua.create_userdata(this.page_links.clone())?,
                ))
            } else {
                Ok(Value::Nil)
            }
        });
    }
}

#[derive(Clone)]
struct TxQueryHandle {
    inner: Arc<TxQuery>,
}

impl UserData for TxQueryHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "XPathString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, expr: String| {
                        Ok(this.inner.xpath_string(&expr))
                    })?;
                    Ok(Value::Function(f))
                }
                "XPathStringAll" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, expr: String| {
                        Ok(this.inner.xpath_string_all(&expr))
                    })?;
                    Ok(Value::Function(f))
                }
                "XPath" => {
                    let this = this.clone();
                    let f = lua.create_function(move |lua, expr: String| {
                        let nodes = this.inner.xpath_nodes(&expr);
                        let result = XPathResult {
                            nodes: Arc::new(nodes),
                        };
                        Ok(lua.create_userdata(result)?)
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
    }
}

#[derive(Clone)]
struct XPathResult {
    nodes: Arc<Vec<DomNode>>,
}

impl UserData for XPathResult {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            if key == "Get" {
                let nodes = this.nodes.clone();
                let f = lua.create_function(move |lua, ()| {
                    let nodes = nodes.clone();
                    let mut idx = 0usize;
                    let iter = lua.create_function_mut(move |lua, ()| {
                        if idx >= nodes.len() {
                            return Ok(Value::Nil);
                        }
                        let node = nodes[idx].clone();
                        idx += 1;
                        Ok(Value::UserData(
                            lua.create_userdata(XPathNode { node })?,
                        ))
                    })?;
                    Ok(Value::Function(iter))
                })?;
                Ok(Value::Function(f))
            } else {
                Ok(Value::Nil)
            }
        });
    }
}

#[derive(Clone)]
struct XPathNode {
    node: DomNode,
}

impl UserData for XPathNode {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "GetAttribute" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, name: String| {
                        Ok(this.node.attr(&name).unwrap_or("").to_string())
                    })?;
                    Ok(Value::Function(f))
                }
                "InnerText" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| Ok(this.node.all_text()))?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
    }
}

fn lua_modules_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FMD_LUA_ROOT") {
        return PathBuf::from(p).join("modules");
    }

    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lua/modules"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../../../lua/modules")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("lua/modules")))
            .unwrap_or_default(),
        std::env::current_dir()
            .map(|d| d.join("../lua/modules"))
            .unwrap_or_default(),
    ];

    for c in candidates {
        if c.is_dir() {
            return c;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lua/modules")
}

fn module_path(name: &str) -> PathBuf {
    let mut p = lua_modules_dir().join(name);
    if p.extension().is_none() {
        p.set_extension("lua");
    }
    p
}

fn relative_url(root: &str, full: &str) -> String {
    let full = full.trim();
    let root = root.trim_end_matches('/');
    if let Some(rest) = full.strip_prefix(root) {
        if rest.is_empty() {
            return "/".into();
        }
        return rest.to_string();
    }
    // try without www
    full.to_string()
}

fn prepare_lua(module_file: &Path) -> mlua::Result<(Lua, ModuleHandle, MangaInfoHandle, TaskHandle, HttpClient)> {
    let lua = Lua::new();
    register_helpers(&lua)?;
    register_fmd_crypto(&lua)?;

    let http = HttpClient::new()?;
    let module = ModuleHandle::default();
    let mangainfo = MangaInfoHandle::new();
    let task = TaskHandle::new();

    let globals = lua.globals();
    globals.set("HTTP", http.clone())?;
    globals.set("MODULE", module.clone())?;
    globals.set("MANGAINFO", mangainfo.clone())?;
    globals.set("TASK", task.clone())?;
    globals.set("URL", "")?;

    {
        let module_slot = Arc::new(Mutex::new(ModuleHandle::default()));
        let module_slot2 = module_slot.clone();
        globals.set(
            "NewWebsiteModule",
            lua.create_function(move |_, ()| {
                let m = ModuleHandle::default();
                *module_slot.lock() = m.clone();
                Ok(m)
            })?,
        )?;

        let source = std::fs::read_to_string(module_file).map_err(mlua::Error::external)?;
        lua.load(&source)
            .set_name(module_file.to_string_lossy())
            .exec()?;

        // Init() creates module via NewWebsiteModule and sets fields on local `m`,
        // but LeerCapitulo assigns to `m` without returning / storing globally.
        // FMD's NewWebsiteModule registers into a container. We capture last created.
        let init: mlua::Function = globals.get("Init")?;
        init.call::<()>(())?;

        let created = module_slot2.lock().clone();
        // Copy into our MODULE global handle
        {
            let src = created.inner.lock().clone();
            *module.inner.lock() = src;
        }
        // Also ensure MODULE global points to same data — re-set
        globals.set("MODULE", module.clone())?;
        let _ = module_slot2;
    }

    // CreateTXQuery
    globals.set(
        "CreateTXQuery",
        lua.create_function(|lua, doc: Value| {
            let html = match doc {
                Value::String(s) => s.to_string_lossy(),
                Value::UserData(ud) => {
                    // allow passing HTTP-like; fallback empty
                    if let Ok(s) = ud.borrow::<HttpClient>() {
                        s.document()
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            };
            let q = TxQueryHandle {
                inner: Arc::new(TxQuery::parse(&html)),
            };
            Ok(lua.create_userdata(q)?)
        })?,
    )?;

    Ok((lua, module, mangainfo, task, http))
}

pub fn get_info(manga_url: &str) -> Result<MangaInfoResult, String> {
    let path = module_path("LeerCapitulo.lua");
    if !path.exists() {
        return Err(format!(
            "No se encontró el módulo Lua en {}. Define FMD_LUA_ROOT si hace falta.",
            path.display()
        ));
    }

    let (lua, module, mangainfo, _task, _http) =
        prepare_lua(&path).map_err(|e| e.to_string())?;

    let root = module.inner.lock().root_url.clone();
    let rel = relative_url(&root, manga_url);
    let globals = lua.globals();
    globals.set("URL", rel).map_err(|e| e.to_string())?;

    let on_get_info = module.inner.lock().on_get_info.clone();
    let fn_name = if on_get_info.is_empty() {
        "GetInfo".to_string()
    } else {
        on_get_info
    };
    let get_info: mlua::Function = globals.get(fn_name.as_str()).map_err(|e| e.to_string())?;
    let status: i64 = get_info.call(()).map_err(|e| e.to_string())?;
    if status != 0 {
        return Err(format!(
            "GetInfo devolvió código {status} (1=net_problem). ¿URL válida / sitio accesible?"
        ));
    }

    let links = mangainfo.chapter_links.values();
    let names = mangainfo.chapter_names.values();
    let mut chapters = Vec::new();
    for (i, link) in links.iter().enumerate() {
        chapters.push(ChapterInfo {
            index: i,
            name: names.get(i).cloned().unwrap_or_else(|| format!("Chapter {}", i + 1)),
            link: link.clone(),
        });
    }

    let mod_state = module.inner.lock().clone();
    let title = mangainfo.title.lock().clone();
    let cover = mangainfo.cover.lock().clone();
    let authors = mangainfo.authors.lock().clone();
    let status = mangainfo.status.lock().clone();
    let summary = mangainfo.summary.lock().clone();
    Ok(MangaInfoResult {
        title,
        cover,
        authors,
        status,
        summary,
        chapters,
        module_id: mod_state.id,
        module_name: mod_state.name,
        root_url: mod_state.root_url,
    })
}

pub fn get_page_links(chapter_url: &str) -> Result<Vec<String>, String> {
    let path = module_path("LeerCapitulo.lua");
    let (lua, module, _mangainfo, task, _http) =
        prepare_lua(&path).map_err(|e| e.to_string())?;

    let root = module.inner.lock().root_url.clone();
    let rel = relative_url(&root, chapter_url);
    let globals = lua.globals();
    globals.set("URL", rel).map_err(|e| e.to_string())?;

    let on_page = module.inner.lock().on_get_page_number.clone();
    let fn_name = if on_page.is_empty() {
        "GetPageNumber".to_string()
    } else {
        on_page
    };
    let get_pages: mlua::Function = globals.get(fn_name.as_str()).map_err(|e| e.to_string())?;
    let ok: bool = get_pages.call(()).map_err(|e| e.to_string())?;
    if !ok {
        return Err("GetPageNumber falló (red o parseo)".into());
    }
    Ok(task.page_links.values())
}
