use super::paths::{modules_dir, package_path};
use super::registry_cache;
use super::runtime::{prepare_lua_scan, scan_profile, ModuleState};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleMeta {
    pub id: String,
    pub name: String,
    pub root_url: String,
    pub category: String,
    pub file_path: String,
    /// Unix seconds; file mtime for modules updater UI.
    pub mtime: Option<i64>,
    pub on_get_info: String,
    pub on_get_page_number: String,
    pub on_get_image_url: String,
    pub on_before_download_image: String,
    pub on_task_start: String,
    pub on_download_image: String,
    pub on_save_image: String,
    pub on_after_image_saved: String,
    pub dynamic_page_link: bool,
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
    let mtime = std::fs::metadata(file_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    ModuleMeta {
        id: state.id.clone(),
        name: state.name.clone(),
        root_url: state.root_url.clone(),
        category: state.category.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        mtime,
        on_get_info: state.on_get_info.clone(),
        on_get_page_number: state.on_get_page_number.clone(),
        on_get_image_url: state.on_get_image_url.clone(),
        on_before_download_image: state.on_before_download_image.clone(),
        on_task_start: state.on_task_start.clone(),
        on_download_image: state.on_download_image.clone(),
        on_save_image: state.on_save_image.clone(),
        on_after_image_saved: state.on_after_image_saved.clone(),
        dynamic_page_link: state.dynamic_page_link,
    }
}

fn scan_file(path: &PathBuf) -> Vec<ModuleMeta> {
    let (_lua, modules) = match prepare_lua_scan(path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("registry: {} — {e}", path.display());
            return Vec::new();
        }
    };
    modules
        .into_iter()
        .filter(|m| !m.id.is_empty() && !m.root_url.is_empty())
        .map(|m| meta_from_state(&m, path))
        .collect()
}

/// Runs every `lua/modules/*.lua` through a Lua VM. This is the expensive path
/// (seconds); prefer `load_or_build`, which reuses the on-disk cache.
fn scan_all() -> Vec<ModuleMeta> {
    let dir = modules_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("registry: no se pudo leer {}", dir.display());
        return Vec::new();
    };

    let _ = package_path();

    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("lua"))
        .collect();
    files.sort();

    let started = std::time::Instant::now();
    let mut out = Vec::new();
    for path in files {
        out.extend(scan_file(&path));
    }
    eprintln!(
        "registry: escaneados {} módulos desde {} en {} ms",
        out.len(),
        dir.display(),
        started.elapsed().as_millis()
    );
    if *scan_profile::ENABLED {
        eprintln!("registry: perfil — {}", scan_profile::take_summary());
    }
    out
}

/// Builds the lookup indexes from a module list. Shared by the scan path and
/// the cache path so both produce an identical registry.
fn hydrate(list: Vec<ModuleMeta>) -> RegistryInner {
    let mut inner = RegistryInner::default();
    for meta in list {
        // First occurrence wins; `scan_all` sorts files by name so this is stable.
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
    inner
}

/// Cache hit → hydrate from disk; miss → full scan, then persist.
fn load_or_build() -> RegistryInner {
    let fp = registry_cache::fingerprint();
    if let Some(cached) = registry_cache::load(&fp) {
        eprintln!("registry: {} módulos desde caché", cached.len());
        return hydrate(cached);
    }
    let list = scan_all();
    registry_cache::store(&fp, &list);
    hydrate(list)
}

fn with_registry<R>(f: impl FnOnce(&RegistryInner) -> R) -> R {
    let mut guard = REGISTRY.lock();
    if guard.is_none() {
        *guard = Some(load_or_build());
    }
    f(guard.as_ref().unwrap())
}

/// Forces a full rescan, ignoring and rewriting the cache. This is the escape
/// hatch behind the "check modules" button in Options.
pub fn refresh() -> usize {
    let mut guard = REGISTRY.lock();
    // Fingerprint before scanning, like `load_or_build`: a file edited mid-scan
    // must leave the cache marked stale, not stored under the post-edit digest.
    let fp = registry_cache::fingerprint();
    let list = scan_all();
    registry_cache::store(&fp, &list);
    let inner = hydrate(list);
    let n = inner.list.len();
    *guard = Some(inner);
    n
}

/// Hide Category=Test modules in release builds (TestCatalog is local-dev only).
fn filter_release_test(list: Vec<ModuleMeta>) -> Vec<ModuleMeta> {
    if cfg!(debug_assertions) {
        list
    } else {
        list.into_iter()
            .filter(|m| !m.category.eq_ignore_ascii_case("Test"))
            .collect()
    }
}

pub fn list() -> Vec<ModuleMeta> {
    filter_release_test(with_registry(|r| r.list.clone()))
}

pub fn find_by_id(id: &str) -> Option<ModuleMeta> {
    let meta = with_registry(|r| r.by_id.get(id).cloned())?;
    if cfg!(not(debug_assertions)) && meta.category.eq_ignore_ascii_case("Test") {
        return None;
    }
    Some(meta)
}

/// Match URL host against RootURL hosts. Prefer longer (more specific) RootURL.
pub fn match_url(url: &str) -> Vec<ModuleMeta> {
    let Some(host) = host_from_url(url) else {
        return Vec::new();
    };
    filter_release_test(with_registry(|r| {
        let Some(ids) = r.by_host.get(&host) else {
            return Vec::new();
        };
        ids.iter()
            .filter_map(|id| r.by_id.get(id).cloned())
            .collect()
    }))
}

/// True when `url` is absolute and its host is not the module's RootURL host.
/// Relative links (`/manga/foo`) never conflict — those belong to the listing.
fn url_host_conflicts(url: &str, root_url: &str) -> bool {
    match (host_from_url(url), host_from_url(root_url)) {
        (Some(url_host), Some(root_host)) => url_host != root_host,
        _ => false,
    }
}

fn pick_unique_host_hit(hits: &[ModuleMeta]) -> Result<ModuleMeta, String> {
    match hits {
        [one] => Ok(one.clone()),
        [] => Err(
            "Ningún módulo coincide con esta URL. Elige un módulo en el selector.".into(),
        ),
        many => Err(format!(
            "Varios módulos coinciden ({}). Elige uno en el selector.",
            many.iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// Pick a module for `url`.
///
/// An explicit `requested` wins only when the URL is relative or shares that
/// module's host (catalog click / favorite). A pasted URL from another site
/// ignores the listing module and uses host matches instead.
pub(crate) fn choose_module_for_url(
    url: &str,
    requested: Option<&ModuleMeta>,
    hits: &[ModuleMeta],
) -> Result<ModuleMeta, String> {
    if let Some(meta) = requested {
        if !url_host_conflicts(url, &meta.root_url) {
            return Ok(meta.clone());
        }
        // Wrong listing (e.g. KuManga selected, manga-oni.com pasted).
        return match hits {
            [one] => Ok(one.clone()),
            [] => Err(
                "Ningún módulo coincide con esta URL. Elige un módulo en el selector.".into(),
            ),
            many => Ok(many[0].clone()),
        };
    }
    pick_unique_host_hit(hits)
}

/// True when `module_id` should stay pinned for this URL (relative or same host).
pub fn requested_module_owns_url(module_id: &str, url: &str) -> bool {
    find_by_id(module_id)
        .is_some_and(|m| !url_host_conflicts(url, &m.root_url))
}

/// Resolve module: explicit id if it owns the URL, else host auto-match.
pub fn resolve_for_url(url: &str, module_id: Option<&str>) -> Result<ModuleMeta, String> {
    let hits = match_url(url);
    if let Some(id) = module_id.filter(|s| !s.is_empty()) {
        let meta = find_by_id(id).ok_or_else(|| format!("Módulo desconocido: {id}"))?;
        return choose_module_for_url(url, Some(&meta), &hits);
    }
    choose_module_for_url(url, None, &hits)
}

pub fn ensure_loaded() {
    let _ = list();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, name: &str, root: &str) -> ModuleMeta {
        ModuleMeta {
            id: id.into(),
            name: name.into(),
            root_url: root.into(),
            category: "Spanish".into(),
            file_path: format!("{id}.lua"),
            mtime: None,
            on_get_info: String::new(),
            on_get_page_number: String::new(),
            on_get_image_url: String::new(),
            on_before_download_image: String::new(),
            on_task_start: String::new(),
            on_download_image: String::new(),
            on_save_image: String::new(),
            on_after_image_saved: String::new(),
            dynamic_page_link: false,
        }
    }

    #[test]
    fn paste_other_host_uses_matched_lua_not_listing() {
        let ku = meta("ku", "KuManga", "https://www.kumanga.com");
        let oni = meta("oni", "MangaOni", "https://manga-oni.com");
        let picked = choose_module_for_url(
            "https://manga-oni.com/manhua/foo/",
            Some(&ku),
            std::slice::from_ref(&oni),
        )
        .expect("rematch");
        assert_eq!(picked.id, "oni");
    }

    #[test]
    fn catalog_relative_link_keeps_listing_module() {
        let ku = meta("ku", "KuManga", "https://www.kumanga.com");
        let picked = choose_module_for_url("/manga/foo/", Some(&ku), &[])
            .expect("relative");
        assert_eq!(picked.id, "ku");
    }

    #[test]
    fn same_host_keeps_requested_even_if_other_hits() {
        let a = meta("a", "A", "https://manga-oni.com");
        let b = meta("b", "B", "https://manga-oni.com/es");
        let picked = choose_module_for_url(
            "https://manga-oni.com/manhua/foo/",
            Some(&a),
            &[b.clone(), a.clone()],
        )
        .expect("same host");
        assert_eq!(picked.id, "a");
    }

    #[test]
    fn www_is_ignored_when_comparing_hosts() {
        let oni = meta("oni", "MangaOni", "https://www.manga-oni.com");
        assert!(!url_host_conflicts(
            "https://manga-oni.com/manhua/foo/",
            &oni.root_url
        ));
        let ku = meta("ku", "KuManga", "https://www.kumanga.com");
        assert!(url_host_conflicts(
            "https://manga-oni.com/manhua/foo/",
            &ku.root_url
        ));
    }

    #[test]
    fn unknown_host_does_not_keep_wrong_listing() {
        let ku = meta("ku", "KuManga", "https://www.kumanga.com");
        let err = choose_module_for_url("https://example.com/manga/foo/", Some(&ku), &[])
            .unwrap_err();
        assert!(err.contains("Ningún módulo coincide"));
    }

    #[test]
    fn no_requested_single_hit() {
        let oni = meta("oni", "MangaOni", "https://manga-oni.com");
        let picked = choose_module_for_url(
            "https://manga-oni.com/manhua/foo/",
            None,
            std::slice::from_ref(&oni),
        )
        .expect("unique");
        assert_eq!(picked.id, "oni");
    }
}
