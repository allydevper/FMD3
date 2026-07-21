use super::crypto::register_fmd_crypto;
use super::duktape_js::register_fmd_duktape;
use super::fmd_env::register_fmd_env;
use super::http::HttpClient;
use super::json_xpath::{json_collect_strings, json_string_at, parse_json_text, split_json_expr};
use super::paths::{modules_dir, package_path};
use super::registry;
use super::strings::{register_helpers, LuaStringList};
use crate::xpath::{DomNode, TxQuery};
use mlua::{Lua, ObjectLike, UserData, UserDataMethods, Value};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
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

#[derive(Debug, Clone, Serialize)]
pub struct PageLinksResult {
    pub pages: Vec<String>,
    pub referer: String,
    pub module_id: String,
}

#[derive(Clone, Default)]
pub struct ModuleState {
    pub id: String,
    pub name: String,
    pub root_url: String,
    pub category: String,
    pub on_get_info: String,
    pub on_get_page_number: String,
    pub on_get_name_and_link: String,
    pub on_get_directory_page_number: String,
    pub on_get_image_url: String,
    pub on_before_download_image: String,
    pub on_task_start: String,
    pub on_download_image: String,
    pub on_save_image: String,
    pub on_after_image_saved: String,
    pub dynamic_page_link: bool,
    pub total_directory: i64,
    pub current_directory_index: i64,
    /// Module options from AddOption* / GetOption (FMD2).
    pub options: HashMap<String, ModuleOptionValue>,
}

#[derive(Clone, Debug)]
pub enum ModuleOptionValue {
    Bool(bool),
    Int(i64),
    Str(String),
}

impl Default for ModuleOptionValue {
    fn default() -> Self {
        Self::Str(String::new())
    }
}

#[derive(Clone, Default)]
struct ModuleHandle {
    inner: Arc<Mutex<ModuleState>>,
}

impl UserData for ModuleHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "AddOptionCheckBox" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (name, _caption, default): (String, String, bool)| {
                            this.inner
                                .lock()
                                .options
                                .insert(name, ModuleOptionValue::Bool(default));
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "AddOptionComboBox" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (name, _caption, _items, default): (String, String, String, i64)| {
                            this.inner
                                .lock()
                                .options
                                .insert(name, ModuleOptionValue::Int(default));
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "AddOptionEdit" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (name, _caption, default): (String, String, String)| {
                            this.inner
                                .lock()
                                .options
                                .insert(name, ModuleOptionValue::Str(default));
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "AddOptionSpinEdit" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (name, _caption, default): (String, String, i64)| {
                            this.inner
                                .lock()
                                .options
                                .insert(name, ModuleOptionValue::Int(default));
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "GetOption" => {
                    let this = this.clone();
                    let f = lua.create_function(move |lua, name: String| {
                        let opt = this.inner.lock().options.get(&name).cloned();
                        Ok(match opt {
                            Some(ModuleOptionValue::Bool(b)) => Value::Boolean(b),
                            Some(ModuleOptionValue::Int(i)) => Value::Integer(i),
                            Some(ModuleOptionValue::Str(s)) => {
                                Value::String(lua.create_string(&s)?)
                            }
                            None => Value::Nil,
                        })
                    })?;
                    Ok(Value::Function(f))
                }
                _ => {
                    let s = this.inner.lock();
                    let val = match key.as_str() {
                        "ID" => Value::String(lua.create_string(&s.id)?),
                        "Name" => Value::String(lua.create_string(&s.name)?),
                        "RootURL" => Value::String(lua.create_string(&s.root_url)?),
                        "Category" => Value::String(lua.create_string(&s.category)?),
                        "OnGetInfo" => Value::String(lua.create_string(&s.on_get_info)?),
                        "OnGetPageNumber" => {
                            Value::String(lua.create_string(&s.on_get_page_number)?)
                        }
                        "OnGetNameAndLink" => {
                            Value::String(lua.create_string(&s.on_get_name_and_link)?)
                        }
                        "OnGetDirectoryPageNumber" => {
                            Value::String(lua.create_string(&s.on_get_directory_page_number)?)
                        }
                        "OnGetImageURL" => Value::String(lua.create_string(&s.on_get_image_url)?),
                        "OnBeforeDownloadImage" => {
                            Value::String(lua.create_string(&s.on_before_download_image)?)
                        }
                        "OnTaskStart" => Value::String(lua.create_string(&s.on_task_start)?),
                        "OnDownloadImage" => {
                            Value::String(lua.create_string(&s.on_download_image)?)
                        }
                        "OnSaveImage" => Value::String(lua.create_string(&s.on_save_image)?),
                        "OnAfterImageSaved" => {
                            Value::String(lua.create_string(&s.on_after_image_saved)?)
                        }
                        "DynamicPageLink" => Value::Boolean(s.dynamic_page_link),
                        "TotalDirectory" => Value::Integer(s.total_directory),
                        "CurrentDirectoryIndex" => Value::Integer(s.current_directory_index),
                        _ => Value::Nil,
                    };
                    Ok(val)
                }
            }
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
                    "OnGetDirectoryPageNumber" => {
                        s.on_get_directory_page_number = value_to_string(value)
                    }
                    "OnGetImageURL" => s.on_get_image_url = value_to_string(value),
                    "OnBeforeDownloadImage" => s.on_before_download_image = value_to_string(value),
                    "OnTaskStart" => s.on_task_start = value_to_string(value),
                    "OnDownloadImage" => s.on_download_image = value_to_string(value),
                    "OnSaveImage" => s.on_save_image = value_to_string(value),
                    "OnAfterImageSaved" => s.on_after_image_saved = value_to_string(value),
                    "DynamicPageLink" => {
                        s.dynamic_page_link = match value {
                            Value::Boolean(b) => b,
                            Value::Integer(i) => i != 0,
                            _ => false,
                        }
                    }
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
    url: Arc<Mutex<String>>,
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
            url: Arc::new(Mutex::new(String::new())),
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
                "URL" => Value::String(lua.create_string(this.url.lock().as_str())?),
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
                    "URL" => *this.url.lock() = s,
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
    page_container_links: LuaStringList,
    file_names: LuaStringList,
    page_number: Arc<Mutex<i64>>,
}

impl TaskHandle {
    fn new() -> Self {
        Self {
            page_links: LuaStringList::new(),
            page_container_links: LuaStringList::new(),
            file_names: LuaStringList::new(),
            page_number: Arc::new(Mutex::new(0)),
        }
    }
}

impl UserData for TaskHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "PageLinks" => Ok(Value::UserData(
                    lua.create_userdata(this.page_links.clone())?,
                )),
                "PageContainerLinks" => Ok(Value::UserData(
                    lua.create_userdata(this.page_container_links.clone())?,
                )),
                "FileNames" => Ok(Value::UserData(
                    lua.create_userdata(this.file_names.clone())?,
                )),
                "PageNumber" => Ok(Value::Integer(*this.page_number.lock())),
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                if key == "PageNumber" {
                    *this.page_number.lock() = match value {
                        Value::Integer(i) => i,
                        Value::Number(n) => n as i64,
                        _ => 0,
                    };
                }
                Ok(())
            },
        );
    }
}

#[derive(Clone, Default)]
struct UpdateListHandle {
    current_directory_page_number: Arc<Mutex<i64>>,
}

impl UserData for UpdateListHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |_, this, key: String| {
            if key == "CurrentDirectoryPageNumber" {
                Ok(Value::Integer(*this.current_directory_page_number.lock()))
            } else {
                Ok(Value::Nil)
            }
        });
        methods.add_meta_method_mut(
            mlua::MetaMethod::NewIndex,
            |_, this, (key, value): (String, Value)| {
                if key == "CurrentDirectoryPageNumber" {
                    *this.current_directory_page_number.lock() = match value {
                        Value::Integer(i) => i,
                        Value::Number(n) => n as i64,
                        _ => 1,
                    };
                }
                Ok(())
            },
        );
    }
}

#[derive(Clone)]
struct TxQueryHandle {
    inner: Arc<TxQuery>,
}

fn ctx_from_value(ctx: Option<Value>) -> Option<DomNode> {
    let Value::UserData(ud) = ctx? else {
        return None;
    };
    if let Ok(node) = ud.borrow::<XPathNode>() {
        return Some(node.node.clone());
    }
    None
}

fn json_ctx_from_value(ctx: Option<Value>) -> Option<JsonValue> {
    let Value::UserData(ud) = ctx? else {
        return None;
    };
    if let Ok(j) = ud.borrow::<JsonNode>() {
        return Some(j.value.clone());
    }
    // XPathResult with single JSON — not used
    None
}

fn extract_json_from_html(tq: &TxQuery, inner_xpath: &str) -> Option<JsonValue> {
    let nodes = tq.xpath_nodes(inner_xpath);
    for n in &nodes {
        let t = n.raw_text();
        if let Some(j) = parse_json_text(&t) {
            return Some(j);
        }
    }
    // Fallback collapsed text
    let text = tq.xpath_string(inner_xpath);
    parse_json_text(&text)
}

#[derive(Clone)]
struct JsonNode {
    value: JsonValue,
}

impl UserData for JsonNode {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "GetProperty" => {
                    let this = this.clone();
                    let f = lua.create_function(move |lua, name: String| {
                        let child = this.value.get(&name).cloned().unwrap_or(JsonValue::Null);
                        Ok(Value::UserData(
                            lua.create_userdata(JsonNode { value: child })?,
                        ))
                    })?;
                    Ok(Value::Function(f))
                }
                "ToString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| {
                        Ok(match &this.value {
                            JsonValue::String(s) => s.clone(),
                            JsonValue::Number(n) => n.to_string(),
                            JsonValue::Bool(b) => b.to_string(),
                            JsonValue::Null => String::new(),
                            other => other.to_string(),
                        })
                    })?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method(mlua::MetaMethod::ToString, |_, this, ()| {
            Ok(match &this.value {
                JsonValue::String(s) => s.clone(),
                JsonValue::Number(n) => n.to_string(),
                JsonValue::Bool(b) => b.to_string(),
                JsonValue::Null => String::new(),
                other => other.to_string(),
            })
        });
    }
}

impl UserData for TxQueryHandle {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_meta_method(mlua::MetaMethod::Index, |lua, this, key: String| {
            match key.as_str() {
                "XPathString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, args: mlua::Variadic<Value>| {
                        let expr = match args.get(0) {
                            Some(Value::String(s)) => s.to_string_lossy(),
                            _ => return Ok(String::new()),
                        };
                        // JSON context: XPathString('title', jsonNode)
                        if let Some(jv) = json_ctx_from_value(args.get(1).cloned()) {
                            return Ok(json_string_at(&jv, &expr));
                        }
                        // json(xpath).path or json(xpath)
                        if let Some((inner, rest)) = split_json_expr(&expr) {
                            if let Some(jv) = extract_json_from_html(&this.inner, &inner) {
                                if rest.is_empty() {
                                    return Ok(jv.to_string());
                                }
                                return Ok(json_string_at(&jv, &rest));
                            }
                            return Ok(String::new());
                        }
                        if let Some(ctx) = ctx_from_value(args.get(1).cloned()) {
                            Ok(this.inner.xpath_string_ctx(&expr, &ctx))
                        } else {
                            Ok(this.inner.xpath_string(&expr))
                        }
                    })?;
                    Ok(Value::Function(f))
                }
                "XPathStringAll" => {
                    let this = this.clone();
                    let f = lua.create_function(move |lua, args: mlua::Variadic<Value>| {
                        let expr = match args.get(0) {
                            Some(Value::String(s)) => s.to_string_lossy(),
                            _ => return Ok(Value::String(lua.create_string("")?)),
                        };
                        let values = if let Some((inner, rest)) = split_json_expr(&expr) {
                            if let Some(jv) = extract_json_from_html(&this.inner, &inner) {
                                if rest.is_empty() {
                                    json_collect_strings(&jv, "")
                                } else {
                                    json_collect_strings(&jv, &rest)
                                }
                            } else {
                                Vec::new()
                            }
                        } else {
                            this.inner.xpath_string_all_values(&expr)
                        };
                        // Optional 2nd arg: string list to fill (FMD style)
                        if let Some(Value::UserData(ud)) = args.get(1) {
                            if let Ok(list) = ud.borrow::<LuaStringList>() {
                                for v in values {
                                    list.push(v);
                                }
                                return Ok(Value::Nil);
                            }
                        }
                        Ok(Value::String(
                            lua.create_string(&values.join(", "))?,
                        ))
                    })?;
                    Ok(Value::Function(f))
                }
                "XPathHREFAll" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (expr, links, names): (String, Value, Value)| {
                            let pairs = this.inner.xpath_href_all(&expr);
                            if let Value::UserData(ud) = links {
                                if let Ok(list) = ud.borrow::<LuaStringList>() {
                                    for (href, _) in &pairs {
                                        list.push(href.clone());
                                    }
                                }
                            }
                            if let Value::UserData(ud) = names {
                                if let Ok(list) = ud.borrow::<LuaStringList>() {
                                    for (_, name) in &pairs {
                                        list.push(name.clone());
                                    }
                                }
                            }
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "XPathHREFTitleAll" => {
                    let this = this.clone();
                    let f = lua.create_function(
                        move |_, (expr, links, names): (String, Value, Value)| {
                            let pairs = this.inner.xpath_href_title_all(&expr);
                            if let Value::UserData(ud) = links {
                                if let Ok(list) = ud.borrow::<LuaStringList>() {
                                    for (href, _) in &pairs {
                                        list.push(href.clone());
                                    }
                                }
                            }
                            if let Value::UserData(ud) = names {
                                if let Ok(list) = ud.borrow::<LuaStringList>() {
                                    for (_, name) in &pairs {
                                        list.push(name.clone());
                                    }
                                }
                            }
                            Ok(())
                        },
                    )?;
                    Ok(Value::Function(f))
                }
                "XPath" => {
                    let this = this.clone();
                    let f = lua.create_function(move |lua, args: mlua::Variadic<Value>| {
                        let expr = match args.get(0) {
                            Some(Value::String(s)) => s.to_string_lossy(),
                            _ => return Ok(Value::Nil),
                        };
                        // json(//script...) → JsonNode for use as XPathString context
                        if let Some((inner, rest)) = split_json_expr(&expr) {
                            if let Some(mut jv) = extract_json_from_html(&this.inner, &inner) {
                                if !rest.is_empty() {
                                    // Navigate to first collected value's parent path — keep object
                                    // For ComicK, rest is empty on XPath('json(...)')
                                    let collected = json_collect_strings(&jv, &rest);
                                    if let Some(s) = collected.first() {
                                        jv = JsonValue::String(s.clone());
                                    }
                                }
                                return Ok(Value::UserData(
                                    lua.create_userdata(JsonNode { value: jv })?,
                                ));
                            }
                            return Ok(Value::Nil);
                        }
                        let nodes = if let Some(ctx) = ctx_from_value(args.get(1).cloned()) {
                            this.inner.xpath_nodes_ctx(&expr, &ctx)
                        } else {
                            this.inner.xpath_nodes(&expr)
                        };
                        let result = XPathResult {
                            nodes: Arc::new(nodes),
                        };
                        Ok(Value::UserData(lua.create_userdata(result)?))
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
                "InnerText" | "ToString" => {
                    let this = this.clone();
                    let f = lua.create_function(move |_, ()| Ok(this.node.to_string_value()))?;
                    Ok(Value::Function(f))
                }
                _ => Ok(Value::Nil),
            }
        });
        methods.add_meta_method(mlua::MetaMethod::ToString, |_, this, ()| {
            Ok(this.node.to_string_value())
        });
    }
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
    // try without www on either side
    let full_no_www = full.replacen("://www.", "://", 1);
    let root_no_www = root.replacen("://www.", "://", 1);
    if let Some(rest) = full_no_www.strip_prefix(&root_no_www) {
        if rest.is_empty() {
            return "/".into();
        }
        return rest.to_string();
    }
    full.to_string()
}

fn absolute_url(root: &str, url: &str) -> String {
    super::strings::maybe_fill_host(root, url)
}

fn setup_package_path(lua: &Lua) -> mlua::Result<()> {
    let path = package_path();
    let package: mlua::Table = lua.globals().get("package")?;
    package.set("path", path)?;
    Ok(())
}

pub fn register_create_txquery_pub(lua: &Lua) -> mlua::Result<()> {
    register_create_txquery(lua)
}

fn register_create_txquery(lua: &Lua) -> mlua::Result<()> {
    let globals = lua.globals();
    globals.set(
        "CreateTXQuery",
        lua.create_function(|lua, doc: Value| {
            let html = match doc {
                Value::String(s) => s.to_string_lossy(),
                Value::UserData(ud) => {
                    if let Ok(http) = ud.borrow::<HttpClient>() {
                        http.document()
                    } else {
                        // DocumentHandle: try ToString via metamethod by reading as string-like
                        // Fallback: empty — Document is separate userdata in http.rs
                        // We expose document via calling ToString if available
                        let to_string: Result<mlua::Function, _> = ud.get("ToString");
                        if let Ok(f) = to_string {
                            f.call::<String>(()).unwrap_or_default()
                        } else {
                            String::new()
                        }
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
    Ok(())
}

/// Load module file, run Init, return all ModuleStates created via NewWebsiteModule.
pub fn prepare_lua_scan(module_file: &Path) -> mlua::Result<(Lua, Vec<ModuleState>)> {
    let lua = Lua::new();
    register_helpers(&lua)?;
    register_fmd_crypto(&lua)?;
    register_fmd_duktape(&lua)?;
    register_fmd_env(&lua)?;
    setup_package_path(&lua)?;

    let http = HttpClient::new()?;
    let mangainfo = MangaInfoHandle::new();
    let task = TaskHandle::new();
    let globals = lua.globals();
    globals.set("HTTP", http)?;
    globals.set("MANGAINFO", mangainfo)?;
    globals.set("TASK", task)?;
    globals.set("URL", "")?;
    globals.set("WORKID", 0)?;
    globals.set("PAGENUMBER", 1)?;
    // Stub lists for directory scan hooks that some Inits reference indirectly
    globals.set("LINKS", LuaStringList::new())?;
    globals.set("NAMES", LuaStringList::new())?;
    globals.set("UPDATELIST", UpdateListHandle::default())?;

    let created: Arc<Mutex<Vec<ModuleHandle>>> = Arc::new(Mutex::new(Vec::new()));
    let created2 = created.clone();
    globals.set(
        "NewWebsiteModule",
        lua.create_function(move |_, ()| {
            let m = ModuleHandle::default();
            created.lock().push(m.clone());
            Ok(m)
        })?,
    )?;

    register_create_txquery(&lua)?;

    let source = std::fs::read_to_string(module_file).map_err(mlua::Error::external)?;
    lua.load(&source)
        .set_name(module_file.to_string_lossy())
        .exec()?;

    if let Ok(init) = globals.get::<mlua::Function>("Init") {
        let _ = init.call::<()>(());
    }

    let states: Vec<ModuleState> = created2
        .lock()
        .iter()
        .map(|h| h.inner.lock().clone())
        .collect();
    Ok((lua, states))
}

struct Prepared {
    lua: Lua,
    module: ModuleHandle,
    mangainfo: MangaInfoHandle,
    task: TaskHandle,
    http: HttpClient,
}

fn prepare_lua_for_meta(
    file_path: &Path,
    prefer_id: Option<&str>,
) -> Result<Prepared, String> {
    let lua = Lua::new();
    register_helpers(&lua).map_err(|e| e.to_string())?;
    register_fmd_crypto(&lua).map_err(|e| e.to_string())?;
    register_fmd_duktape(&lua).map_err(|e| e.to_string())?;
    register_fmd_env(&lua).map_err(|e| e.to_string())?;
    setup_package_path(&lua).map_err(|e| e.to_string())?;

    let http = HttpClient::new().map_err(|e| e.to_string())?;
    let module = ModuleHandle::default();
    let mangainfo = MangaInfoHandle::new();
    let task = TaskHandle::new();

    let globals = lua.globals();
    globals.set("HTTP", http.clone()).map_err(|e| e.to_string())?;
    globals
        .set("MODULE", module.clone())
        .map_err(|e| e.to_string())?;
    globals
        .set("MANGAINFO", mangainfo.clone())
        .map_err(|e| e.to_string())?;
    globals.set("TASK", task.clone()).map_err(|e| e.to_string())?;
    globals.set("URL", "").map_err(|e| e.to_string())?;
    globals.set("WORKID", 0).map_err(|e| e.to_string())?;
    globals.set("PAGENUMBER", 1).map_err(|e| e.to_string())?;
    globals
        .set("LINKS", LuaStringList::new())
        .map_err(|e| e.to_string())?;
    globals
        .set("NAMES", LuaStringList::new())
        .map_err(|e| e.to_string())?;
    globals
        .set("UPDATELIST", UpdateListHandle::default())
        .map_err(|e| e.to_string())?;

    let created: Arc<Mutex<Vec<ModuleHandle>>> = Arc::new(Mutex::new(Vec::new()));
    let created2 = created.clone();
    globals
        .set(
            "NewWebsiteModule",
            lua.create_function(move |_, ()| {
                let m = ModuleHandle::default();
                created.lock().push(m.clone());
                Ok(m)
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

    register_create_txquery(&lua).map_err(|e| e.to_string())?;

    let source = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    lua.load(&source)
        .set_name(file_path.to_string_lossy())
        .exec()
        .map_err(|e| e.to_string())?;

    let init: mlua::Function = globals.get("Init").map_err(|e| e.to_string())?;
    init.call::<()>(()).map_err(|e| e.to_string())?;

    let handles = created2.lock().clone();
    let chosen = if let Some(id) = prefer_id {
        handles
            .iter()
            .find(|h| h.inner.lock().id == id)
            .cloned()
            .or_else(|| handles.last().cloned())
    } else {
        handles.last().cloned()
    };
    let Some(chosen) = chosen else {
        return Err("Init no creó ningún NewWebsiteModule".into());
    };
    {
        let src = chosen.inner.lock().clone();
        *module.inner.lock() = src;
    }
    globals
        .set("MODULE", module.clone())
        .map_err(|e| e.to_string())?;

    Ok(Prepared {
        lua,
        module,
        mangainfo,
        task,
        http,
    })
}

fn lua_status_ok(v: Value) -> bool {
    match v {
        Value::Boolean(b) => b,
        Value::Integer(i) => i == 0, // no_error
        Value::Number(n) => n == 0.0,
        Value::Nil => false,
        _ => true,
    }
}

pub fn get_info(manga_url: &str, module_id: Option<&str>) -> Result<MangaInfoResult, String> {
    let meta = registry::resolve_for_url(manga_url, module_id)?;
    let path = PathBuf::from(&meta.file_path);
    if !path.exists() {
        // fallback by name in modules dir
        let alt = modules_dir().join(
            Path::new(&meta.file_path)
                .file_name()
                .unwrap_or_default(),
        );
        if !alt.exists() {
            return Err(format!("No se encontró el módulo Lua: {}", meta.file_path));
        }
        return get_info_with_path(manga_url, &alt, Some(&meta.id));
    }
    get_info_with_path(manga_url, &path, Some(&meta.id))
}

fn get_info_with_path(
    manga_url: &str,
    path: &Path,
    prefer_id: Option<&str>,
) -> Result<MangaInfoResult, String> {
    let Prepared {
        lua,
        module,
        mangainfo,
        ..
    } = prepare_lua_for_meta(path, prefer_id)?;

    let root = module.inner.lock().root_url.clone();
    let abs = absolute_url(&root, manga_url);
    let rel = relative_url(&root, &abs);
    let globals = lua.globals();
    globals.set("URL", rel).map_err(|e| e.to_string())?;
    *mangainfo.url.lock() = abs;

    let on_get_info = module.inner.lock().on_get_info.clone();
    let fn_name = if on_get_info.is_empty() {
        "GetInfo".to_string()
    } else {
        on_get_info
    };
    let get_info: mlua::Function = globals.get(fn_name.as_str()).map_err(|e| e.to_string())?;
    let status: Value = get_info.call(()).map_err(|e| e.to_string())?;
    if !lua_status_ok(status.clone()) {
        let code = match status {
            Value::Integer(i) => i.to_string(),
            Value::Boolean(false) => "false".into(),
            _ => "?".into(),
        };
        return Err(format!(
            "GetInfo devolvió código {code} (1=net_problem). ¿URL válida / sitio accesible?"
        ));
    }

    let mut links = mangainfo.chapter_links.values();
    let mut names = mangainfo.chapter_names.values();
    // FMD2 uData: RemoveHostFromURLsPair + trim/dedupe after GetInfo
    super::strings::normalize_chapter_lists(&mut links, &mut names);

    let mut chapters = Vec::new();
    for (i, link) in links.iter().enumerate() {
        chapters.push(ChapterInfo {
            index: i,
            name: names
                .get(i)
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Chapter {}", i + 1)),
            link: link.clone(),
        });
    }

    let mod_state = module.inner.lock().clone();
    let mut title = mangainfo.title.lock().clone();
    let cover = mangainfo.cover.lock().clone();
    let mut authors = mangainfo.authors.lock().clone();
    let status = mangainfo.status.lock().clone();
    let mut summary = mangainfo.summary.lock().clone();
    super::strings::cleanup_manga_fields(&mut title, &mut authors, &mut summary);
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

pub fn get_page_links(
    chapter_url: &str,
    module_id: Option<&str>,
) -> Result<PageLinksResult, String> {
    get_page_links_inner(chapter_url, module_id, None)
}

/// Get page links. `manga_url` is only used to help module resolution when chapter path has no host.
pub fn get_page_links_warmed(
    chapter_url: &str,
    module_id: Option<&str>,
    manga_url: Option<&str>,
) -> Result<PageLinksResult, String> {
    get_page_links_inner(chapter_url, module_id, manga_url)
}

fn get_page_links_inner(
    chapter_url: &str,
    module_id: Option<&str>,
    manga_url: Option<&str>,
) -> Result<PageLinksResult, String> {
    let (meta, path) = resolve_module_path(chapter_url, module_id, manga_url)?;

    let Prepared {
        lua,
        module,
        task,
        http,
        ..
    } = prepare_lua_for_meta(&path, Some(&meta.id))?;

    let root = module.inner.lock().root_url.clone();
    let globals = lua.globals();

    // FMD2: ChapterLinks are host-stripped; DoGetPageNumber passes AURL as-is.
    // Legacy queue rows may still store absolute URLs — strip once.
    let chapter_rel = super::strings::remove_host_from_url(chapter_url);
    if let Some(m) = manga_url.filter(|s| !s.trim().is_empty()) {
        let referer = absolute_url(&root, m);
        http.set_header("Referer", &referer);
    } else {
        http.set_header("Referer", &root);
    }
    globals
        .set("URL", chapter_rel.clone())
        .map_err(|e| e.to_string())?;

    let on_page = module.inner.lock().on_get_page_number.clone();
    let fn_name = if on_page.is_empty() {
        "GetPageNumber".to_string()
    } else {
        on_page
    };
    let get_pages: mlua::Function = globals.get(fn_name.as_str()).map_err(|e| e.to_string())?;
    let status: Value = get_pages.call(()).map_err(|e| e.to_string())?;
    if !lua_status_ok(status) {
        return Err("GetPageNumber falló (red o parseo)".into());
    }

    let mut pages = task.page_links.values();
    let on_image = module.inner.lock().on_get_image_url.clone();
    let dynamic = module.inner.lock().dynamic_page_link;
    let page_number = *task.page_number.lock();
    let containers = task.page_container_links.len();

    // Pad like FMD2 DoGetPageNumber
    if page_number > 0 {
        while task.page_links.len() < page_number as usize {
            task.page_links.push("W".into());
        }
        pages = task.page_links.values();
    }

    if !dynamic && pages.iter().any(|p| p.is_empty() || p == "W") && !on_image.is_empty() {
        let n = if page_number > 0 {
            page_number as usize
        } else if !pages.is_empty() {
            pages.len()
        } else {
            containers
        };
        if n == 0 {
            return Err("GetPageNumber no produjo PageLinks ni PageContainerLinks".into());
        }
        let image_fn: mlua::Function = globals.get(on_image.as_str()).map_err(|e| e.to_string())?;
        for i in 0..n {
            let cur = task.page_links.get(i).unwrap_or_default();
            if cur != "W" && !cur.is_empty() {
                continue;
            }
            // FMD2 DoGetImageURL: URL = chapter link, WORKID = i
            globals
                .set("URL", chapter_rel.clone())
                .map_err(|e| e.to_string())?;
            globals.set("WORKID", i as i64).map_err(|e| e.to_string())?;
            let st: Value = image_fn.call(()).map_err(|e| e.to_string())?;
            if !lua_status_ok(st) {
                return Err(format!("GetImageURL falló en WORKID={i}"));
            }
        }
        pages = task.page_links.values();
    }

    // Drop placeholders for preview API
    pages.retain(|p| !p.is_empty() && p != "W" && p != "G" && p != "D");
    while pages.last().is_some_and(|p| p.is_empty()) {
        pages.pop();
    }
    if pages.is_empty() {
        return Err("No se obtuvieron URLs de imagen".into());
    }

    let referer = http
        .headers_map()
        .get("Referer")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| root.clone());

    let module_id = module.inner.lock().id.clone();
    Ok(PageLinksResult {
        pages,
        referer,
        module_id,
    })
}

fn resolve_module_path(
    chapter_url: &str,
    module_id: Option<&str>,
    manga_url: Option<&str>,
) -> Result<(registry::ModuleMeta, PathBuf), String> {
    let resolve_hint = manga_url
        .filter(|m| !m.trim().is_empty())
        .unwrap_or(chapter_url);
    let meta = registry::resolve_for_url(resolve_hint, module_id)?;
    let meta = if module_id.is_some() {
        meta
    } else if chapter_url.starts_with("http://") || chapter_url.starts_with("https://") {
        registry::resolve_for_url(chapter_url, module_id).unwrap_or(meta)
    } else {
        meta
    };
    let path = PathBuf::from(&meta.file_path);
    let path = if path.exists() {
        path
    } else {
        modules_dir().join(
            Path::new(&meta.file_path)
                .file_name()
                .unwrap_or_default(),
        )
    };
    if !path.exists() {
        return Err(format!("No se encontró el módulo Lua: {}", meta.file_path));
    }
    Ok((meta, path))
}

fn ext_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return "jpg";
    }
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return "png";
    }
    if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return "gif";
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    "jpg"
}

fn ext_from_url(url: &str) -> Option<&'static str> {
    let path = url.split('?').next().unwrap_or(url).split('#').next().unwrap_or(url);
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("png"),
        Some("webp") => Some("webp"),
        Some("gif") => Some("gif"),
        Some("avif") => Some("avif"),
        Some("jpg") | Some("jpeg") => Some("jpg"),
        _ => None,
    }
}

fn find_existing_image(base_no_ext: &Path) -> Option<PathBuf> {
    for ext in ["jpg", "jpeg", "png", "webp", "gif", "avif"] {
        let p = base_no_ext.with_extension(ext);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn chapter_output_dir(output_dir: &Path, manga_title: &str, chapter_index: usize, chapter_name: &str) -> PathBuf {
    output_dir
        .join(sanitize_filename::sanitize(manga_title))
        .join(format!(
            "{:03}_{}",
            chapter_index + 1,
            sanitize_filename::sanitize(chapter_name)
        ))
}

fn work_basename(file_names: &LuaStringList, work_id: usize, page_count: usize) -> String {
    if file_names.len() == page_count {
        if let Some(n) = file_names.get(work_id) {
            let n = n.trim();
            if !n.is_empty() {
                return n.to_string();
            }
        }
    }
    format!("{:03}", work_id + 1)
}

/// Full FMD2 chapter download pipeline in one Lua/HTTP session.
pub fn download_chapter(
    chapter_url: &str,
    module_id: Option<&str>,
    manga_url: Option<&str>,
    output_dir: &Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
    mut on_progress: Option<&mut dyn FnMut(usize, usize)>,
) -> Result<crate::download::DownloadResult, String> {
    let (meta, path) = resolve_module_path(chapter_url, module_id, manga_url)?;
    let Prepared {
        lua,
        module,
        task,
        http,
        ..
    } = prepare_lua_for_meta(&path, Some(&meta.id))?;

    let root = module.inner.lock().root_url.clone();
    let globals = lua.globals();
    let chapter_rel = super::strings::remove_host_from_url(chapter_url);

    if let Some(m) = manga_url.filter(|s| !s.trim().is_empty()) {
        let referer = absolute_url(&root, m);
        http.set_header("Referer", &referer);
    } else {
        http.set_header("Referer", &root);
    }

    let state = module.inner.lock().clone();
    let on_task = state.on_task_start.clone();
    let on_page = state.on_get_page_number.clone();
    let on_image = state.on_get_image_url.clone();
    let on_before = state.on_before_download_image.clone();
    let on_download = state.on_download_image.clone();
    let on_save = state.on_save_image.clone();
    let on_after = state.on_after_image_saved.clone();
    let dynamic = state.dynamic_page_link;

    // OnTaskStart
    if !on_task.is_empty() {
        let f: mlua::Function = globals.get(on_task.as_str()).map_err(|e| e.to_string())?;
        let st: Value = f.call(()).map_err(|e| e.to_string())?;
        if matches!(st, Value::Boolean(false)) {
            return Err("OnTaskStart canceló la descarga".into());
        }
    }

    // OnGetPageNumber
    globals
        .set("URL", chapter_rel.clone())
        .map_err(|e| e.to_string())?;
    let fn_page = if on_page.is_empty() {
        "GetPageNumber".to_string()
    } else {
        on_page
    };
    let get_pages: mlua::Function = globals.get(fn_page.as_str()).map_err(|e| e.to_string())?;
    let status: Value = get_pages.call(()).map_err(|e| e.to_string())?;
    if !lua_status_ok(status) {
        return Err("GetPageNumber falló (red o parseo)".into());
    }

    // Pad PageLinks with 'W' when PageNumber > 0 (FMD2 DoGetPageNumber)
    let mut page_number = *task.page_number.lock();
    if page_number > 0 {
        while task.page_links.len() < page_number as usize {
            task.page_links.push("W".into());
        }
    } else {
        page_number = task.page_links.len() as i64;
        *task.page_number.lock() = page_number;
    }

    if page_number <= 0 && task.page_links.len() == 0 {
        return Err("GetPageNumber no produjo páginas".into());
    }

    // GetImageURL phase (skip if DynamicPageLink)
    if !dynamic && !on_image.is_empty() {
        let n = task.page_links.len().max(page_number as usize);
        let image_fn: mlua::Function = globals.get(on_image.as_str()).map_err(|e| e.to_string())?;
        for i in 0..n {
            let cur = task.page_links.get(i).unwrap_or_default();
            if cur != "W" && !cur.is_empty() && cur != "G" {
                continue;
            }
            globals
                .set("URL", chapter_rel.clone())
                .map_err(|e| e.to_string())?;
            globals.set("WORKID", i as i64).map_err(|e| e.to_string())?;
            let st: Value = image_fn.call(()).map_err(|e| e.to_string())?;
            if !lua_status_ok(st) {
                return Err(format!("GetImageURL falló en WORKID={i}"));
            }
        }
    }

    let page_count = task.page_links.len().max(*task.page_number.lock() as usize);
    if page_count == 0 {
        return Err("No se obtuvieron URLs de imagen".into());
    }
    *task.page_number.lock() = page_count as i64;

    let chapter_dir = chapter_output_dir(output_dir, manga_title, chapter_index, chapter_name);
    let mut files = Vec::new();
    let mut errors = Vec::new();

    if let Err(e) = std::fs::create_dir_all(&chapter_dir) {
        return Ok(crate::download::DownloadResult {
            chapter_index,
            chapter_name: chapter_name.to_string(),
            files,
            errors: vec![format!("No se pudo crear {}: {e}", chapter_dir.display())],
        });
    }

    let use_container_url = !on_download.is_empty()
        && page_count == task.page_container_links.len()
        && task.page_container_links.len() > 0;

    for i in 0..page_count {
        if let Some(cb) = on_progress.as_mut() {
            cb(i, page_count);
        }

        let mut work_url = task.page_links.get(i).unwrap_or_default();
        let trimmed = work_url.trim().to_string();
        if trimmed == "D" {
            let base = chapter_dir.join(work_basename(&task.file_names, i, page_count));
            if let Some(existing) = find_existing_image(&base) {
                files.push(existing.display().to_string());
            }
            continue;
        }
        if trimmed.is_empty() || trimmed == "W" {
            errors.push(format!("Página {}: URL vacía (W)", i + 1));
            continue;
        }

        if use_container_url {
            if let Some(c) = task.page_container_links.get(i) {
                if !c.trim().is_empty() {
                    work_url = c;
                }
            }
        }

        http.reset_http();
        http.accept_image();

        globals
            .set("URL", work_url.clone())
            .map_err(|e| e.to_string())?;
        globals.set("WORKID", i as i64).map_err(|e| e.to_string())?;

        if !on_before.is_empty() {
            if let Ok(f) = globals.get::<mlua::Function>(on_before.as_str()) {
                let _ = f.call::<Value>(());
            }
            // Re-read URL in case module mutated it (docs); FMD2 Pascal rarely does.
            if let Ok(Value::String(s)) = globals.get::<Value>("URL") {
                let u = s.to_string_lossy();
                if !u.is_empty() {
                    work_url = u;
                }
            }
        }

        let ok = if !on_download.is_empty() {
            match globals.get::<mlua::Function>(on_download.as_str()) {
                Ok(f) => lua_status_ok(f.call(()).unwrap_or(Value::Boolean(false))),
                Err(_) => false,
            }
        } else {
            let abs = absolute_url(&root, &work_url);
            http.get_public(&abs)
        };

        if !ok {
            errors.push(format!("Página {}: descarga falló", i + 1));
            continue;
        }

        let base_name = work_basename(&task.file_names, i, page_count);
        let base_path = chapter_dir.join(&base_name);

        if let Some(existing) = find_existing_image(&base_path) {
            files.push(existing.display().to_string());
            task.page_links.set(i, "D".into());
            if !on_after.is_empty() {
                let _ = globals.set("FILENAME", existing.display().to_string());
                if let Ok(f) = globals.get::<mlua::Function>(on_after.as_str()) {
                    let _ = f.call::<Value>(());
                }
            }
            if let Some(cb) = on_progress.as_mut() {
                cb(i + 1, page_count);
            }
            continue;
        }

        let saved = if !on_save.is_empty() {
            let path_str = chapter_dir.display().to_string();
            let _ = globals.set("PATH", path_str);
            let _ = globals.set("FILENAME", base_name.clone());
            match globals.get::<mlua::Function>(on_save.as_str()) {
                Ok(f) => match f.call::<Value>(()) {
                    Ok(Value::String(s)) => {
                        let p = s.to_string_lossy();
                        if !p.is_empty() && Path::new(&p).is_file() {
                            Some(PathBuf::from(p))
                        } else {
                            None
                        }
                    }
                    _ => None,
                },
                Err(_) => None,
            }
        } else {
            let bytes = http.document_bytes();
            if bytes.is_empty() {
                None
            } else {
                let ext = ext_from_url(&work_url).unwrap_or_else(|| ext_from_bytes(&bytes));
                let file_path = if Path::new(&base_name).extension().is_some() {
                    chapter_dir.join(&base_name)
                } else {
                    chapter_dir.join(format!("{base_name}.{ext}"))
                };
                match std::fs::write(&file_path, &bytes) {
                    Ok(()) => Some(file_path),
                    Err(e) => {
                        errors.push(format!("Página {}: write error: {e}", i + 1));
                        None
                    }
                }
            }
        };

        match saved {
            Some(path) => {
                let path_str = path.display().to_string();
                files.push(path_str.clone());
                task.page_links.set(i, "D".into());
                if !on_after.is_empty() {
                    let _ = globals.set("FILENAME", path_str);
                    if let Ok(f) = globals.get::<mlua::Function>(on_after.as_str()) {
                        let _ = f.call::<Value>(());
                    }
                }
            }
            None => {
                if errors.last().map(|e| !e.contains(&format!("Página {}: ", i + 1))).unwrap_or(true) {
                    errors.push(format!("Página {}: no se pudo guardar", i + 1));
                }
            }
        }

        if let Some(cb) = on_progress.as_mut() {
            cb(i + 1, page_count);
        }
    }

    Ok(crate::download::DownloadResult {
        chapter_index,
        chapter_name: chapter_name.to_string(),
        files,
        errors,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateListProgress {
    pub module_id: String,
    pub directory_index: i64,
    pub page: i64,
    pub page_total: i64,
    pub batch_rows: usize,
    pub inserted_total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateListStats {
    pub module_id: String,
    pub inserted: usize,
    pub total_in_db: i64,
    pub pages_fetched: usize,
}

fn read_pagenumber(globals: &mlua::Table) -> i64 {
    match globals.get::<Value>("PAGENUMBER") {
        Ok(Value::Integer(i)) if i > 0 => i,
        Ok(Value::Number(n)) if n > 0.0 => n as i64,
        _ => 1,
    }
}

/// Scrape directory via GetNameAndLink and write `data/<module_id>.db`.
pub fn update_list(
    module_id: &str,
    mut on_progress: Option<&mut dyn FnMut(UpdateListProgress)>,
) -> Result<UpdateListStats, String> {
    let meta = registry::find_by_id(module_id)
        .ok_or_else(|| format!("Módulo desconocido: {module_id}"))?;
    let path = PathBuf::from(&meta.file_path);
    let path = if path.exists() {
        path
    } else {
        modules_dir().join(
            Path::new(&meta.file_path)
                .file_name()
                .unwrap_or_default(),
        )
    };
    if !path.exists() {
        return Err(format!("No se encontró el módulo Lua: {}", meta.file_path));
    }

    let Prepared {
        lua,
        module,
        ..
    } = prepare_lua_for_meta(&path, Some(&meta.id))?;

    let globals = lua.globals();
    let links_ud: mlua::AnyUserData = globals.get("LINKS").map_err(|e| e.to_string())?;
    let names_ud: mlua::AnyUserData = globals.get("NAMES").map_err(|e| e.to_string())?;
    let links = links_ud
        .borrow::<LuaStringList>()
        .map_err(|e| e.to_string())?
        .clone();
    let names = names_ud
        .borrow::<LuaStringList>()
        .map_err(|e| e.to_string())?
        .clone();

    let on_dir = module.inner.lock().on_get_directory_page_number.clone();
    let on_name = module.inner.lock().on_get_name_and_link.clone();
    if on_name.is_empty() {
        return Err("El módulo no define OnGetNameAndLink".into());
    }

    let mut total_dirs = module.inner.lock().total_directory;
    if total_dirs <= 0 {
        total_dirs = 1;
    }

    let mut inserted_total = 0usize;
    let mut pages_fetched = 0usize;

    for dir_idx in 0..total_dirs {
        {
            let mut s = module.inner.lock();
            s.current_directory_index = dir_idx;
        }

        let mut page_total: i64 = 1;
        if !on_dir.is_empty() {
            globals.set("PAGENUMBER", 1).map_err(|e| e.to_string())?;
            globals.set("URL", "").map_err(|e| e.to_string())?;
            let f: mlua::Function = globals.get(on_dir.as_str()).map_err(|e| e.to_string())?;
            let st: Value = f.call(()).map_err(|e| e.to_string())?;
            if !lua_status_ok(st) {
                return Err(format!(
                    "GetDirectoryPageNumber falló (dir={dir_idx})"
                ));
            }
            page_total = read_pagenumber(&globals).max(1);
        }

        let name_fn: mlua::Function = globals.get(on_name.as_str()).map_err(|e| e.to_string())?;

        let mut page: i64 = 0;
        while page < page_total {
            // FMD passes 0-based page index; FoOlSlide uses (URL + 1)
            globals
                .set("URL", page)
                .map_err(|e| e.to_string())?;
            links.clear();
            names.clear();

            let st: Value = name_fn.call(()).map_err(|e| e.to_string())?;
            if !lua_status_ok(st) {
                return Err(format!(
                    "GetNameAndLink falló (dir={dir_idx} page={page})"
                ));
            }

            // LeerCapitulo may raise CurrentDirectoryPageNumber mid-flight
            if let Ok(ud) = globals.get::<mlua::AnyUserData>("UPDATELIST") {
                if let Ok(ul) = ud.borrow::<UpdateListHandle>() {
                    let n = *ul.current_directory_page_number.lock();
                    if n > page_total {
                        page_total = n;
                    }
                }
            }

            let link_vals = links.values();
            let name_vals = names.values();
            let mut pairs = Vec::new();
            for (i, link) in link_vals.iter().enumerate() {
                let title = name_vals
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| link.clone());
                pairs.push((link.clone(), title));
            }
            let batch = pairs.len();
            let n = crate::catalog::upsert_links(&meta.id, &pairs)?;
            inserted_total += n;
            pages_fetched += 1;

            if let Some(cb) = on_progress.as_mut() {
                cb(UpdateListProgress {
                    module_id: meta.id.clone(),
                    directory_index: dir_idx,
                    page,
                    page_total,
                    batch_rows: batch,
                    inserted_total,
                });
            }
            page += 1;
        }
    }

    let st = crate::catalog::stats(&meta.id)?;
    Ok(UpdateListStats {
        module_id: meta.id,
        inserted: inserted_total,
        total_in_db: st.count,
        pages_fetched,
    })
}
