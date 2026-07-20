use super::paths::{modules_dir, package_path};
use super::runtime::{prepare_lua_scan, ModuleState};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct ModuleMeta {
    pub id: String,
    pub name: String,
    pub root_url: String,
    pub category: String,
    pub file_path: String,
    pub on_get_info: String,
    pub on_get_page_number: String,
    pub on_get_image_url: String,
    pub on_before_download_image: String,
}

#[derive(Default)]
struct RegistryInner {
    by_id: HashMap<String, ModuleMeta>,
    /// host (lowercase, no www) -> modules sorted by root_url length desc
    by_host: HashMap<String, Vec<String>>,
    list: Vec<ModuleMeta>,
}

static REGISTRY: once_cell::sync::Lazy<Mutex<Option<RegistryInner>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

fn host_from_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    parsed.host_str().map(normalize_host)
}

fn meta_from_state(state: &ModuleState, file_path: &PathBuf) -> ModuleMeta {
    ModuleMeta {
        id: state.id.clone(),
        name: state.name.clone(),
        root_url: state.root_url.clone(),
        category: state.category.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        on_get_info: state.on_get_info.clone(),
        on_get_page_number: state.on_get_page_number.clone(),
        on_get_image_url: state.on_get_image_url.clone(),
        on_before_download_image: state.on_before_download_image.clone(),
    }
}

fn scan_file(path: &PathBuf) -> Vec<ModuleMeta> {
    let Ok((_lua, modules)) = prepare_lua_scan(path) else {
        return Vec::new();
    };
    modules
        .into_iter()
        .filter(|m| !m.id.is_empty() && !m.root_url.is_empty())
        .map(|m| meta_from_state(&m, path))
        .collect()
}

fn build_registry() -> RegistryInner {
    let dir = modules_dir();
    let mut inner = RegistryInner::default();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("registry: no se pudo leer {}", dir.display());
        return inner;
    };

    let _ = package_path();

    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("lua"))
        .collect();
    files.sort();

    for path in files {
        for meta in scan_file(&path) {
            if inner.by_id.contains_key(&meta.id) {
                continue;
            }
            if let Some(host) = host_from_url(&meta.root_url) {
                inner
                    .by_host
                    .entry(host)
                    .or_default()
                    .push(meta.id.clone());
            }
            inner.by_id.insert(meta.id.clone(), meta.clone());
            inner.list.push(meta);
        }
    }

    for ids in inner.by_host.values_mut() {
        ids.sort_by(|a, b| {
            let la = inner
                .by_id
                .get(a)
                .map(|m| m.root_url.len())
                .unwrap_or(0);
            let lb = inner
                .by_id
                .get(b)
                .map(|m| m.root_url.len())
                .unwrap_or(0);
            lb.cmp(&la)
        });
    }

    eprintln!(
        "registry: {} módulos desde {}",
        inner.list.len(),
        dir.display()
    );
    inner
}

fn with_registry<R>(f: impl FnOnce(&RegistryInner) -> R) -> R {
    let mut guard = REGISTRY.lock();
    if guard.is_none() {
        *guard = Some(build_registry());
    }
    f(guard.as_ref().unwrap())
}

pub fn refresh() -> usize {
    let mut guard = REGISTRY.lock();
    let inner = build_registry();
    let n = inner.list.len();
    *guard = Some(inner);
    n
}

pub fn list() -> Vec<ModuleMeta> {
    with_registry(|r| r.list.clone())
}

pub fn find_by_id(id: &str) -> Option<ModuleMeta> {
    with_registry(|r| r.by_id.get(id).cloned())
}

/// Match URL host against RootURL hosts. Prefer longer (more specific) RootURL.
pub fn match_url(url: &str) -> Vec<ModuleMeta> {
    let Some(host) = host_from_url(url) else {
        return Vec::new();
    };
    with_registry(|r| {
        let Some(ids) = r.by_host.get(&host) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|id| r.by_id.get(id).cloned())
            .collect()
    })
}

/// Resolve module: explicit id, else unique auto-match, else error/ambiguous.
pub fn resolve_for_url(url: &str, module_id: Option<&str>) -> Result<ModuleMeta, String> {
    if let Some(id) = module_id.filter(|s| !s.is_empty()) {
        return find_by_id(id).ok_or_else(|| format!("Módulo desconocido: {id}"));
    }
    let hits = match_url(url);
    match hits.len() {
        1 => Ok(hits.into_iter().next().unwrap()),
        0 => Err(
            "Ningún módulo coincide con esta URL. Elige un módulo en el selector.".into(),
        ),
        _ => Err(format!(
            "Varios módulos coinciden ({}). Elige uno en el selector.",
            hits.iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn ensure_loaded() {
    let _ = list();
}
