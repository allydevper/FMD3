//! GitHub Lua modules updater (FMD2 `frmLuaModulesUpdater` / `GitHubRepoV3` parity).
//!
//! Source: `dazedcat19/FMD2` path `lua` (see `dist/config.json`).
//! State: `userdata/lua.json` + `userdata/lua_repo.json`.

use super::paths::lua_root;
use crate::db;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FLAG_NONE: &str = "none";
const FLAG_NEW: &str = "new";
const FLAG_UPDATE: &str = "update";
const FLAG_DELETE: &str = "delete";
const FLAG_DELETED: &str = "deleted";
const FLAG_FAILED: &str = "failed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LuaRepoEntry {
    pub name: String,
    pub sha: String,
    #[serde(default)]
    pub last_modified: Option<i64>,
    #[serde(default)]
    pub last_message: String,
    #[serde(default = "default_flag")]
    pub flag: String,
}

fn default_flag() -> String {
    FLAG_NONE.into()
}

#[derive(Debug, Clone, Serialize)]
pub struct ModulesUpdateReport {
    pub found_updates: bool,
    pub applied: bool,
    pub awaiting_confirm: bool,
    pub refreshed_count: usize,
    pub status_lines: Vec<String>,
    pub new_count: usize,
    pub update_count: usize,
    pub delete_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct DistConfigFile {
    #[serde(rename = "GitHub")]
    github: Option<GithubConfigJson>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubConfigJson {
    #[serde(default)]
    api_url: String,
    #[serde(default)]
    download_url: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    #[serde(rename = "ref")]
    ref_name: String,
    #[serde(default)]
    path: String,
}

#[derive(Debug, Clone)]
struct GithubConfig {
    api_url: String,
    download_url: String,
    owner: String,
    name: String,
    ref_name: String,
    path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RepoWorkState {
    #[serde(default)]
    last_commit_sha: String,
    #[serde(default)]
    last_commit_etag: String,
}

static UPDATE_LOCK: Mutex<()> = Mutex::new(());

fn userdata_dir() -> PathBuf {
    db::userdata_path()
}

fn lua_json_path() -> PathBuf {
    userdata_dir().join("lua.json")
}

fn lua_repo_work_path() -> PathBuf {
    userdata_dir().join("lua_repo.json")
}

fn default_github_config() -> GithubConfig {
    GithubConfig {
        api_url: "https://api.github.com/".into(),
        download_url: "https://raw.githubusercontent.com/".into(),
        owner: "dazedcat19".into(),
        name: "FMD2".into(),
        ref_name: "master".into(),
        path: "lua".into(),
    }
}

fn load_github_config() -> GithubConfig {
    let mut cfg = default_github_config();
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("config.json")))
            .unwrap_or_default(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/config.json"),
        std::env::current_dir()
            .map(|d| d.join("config.json"))
            .unwrap_or_default(),
        std::env::current_dir()
            .map(|d| d.join("../dist/config.json"))
            .unwrap_or_default(),
        std::env::current_dir()
            .map(|d| d.join("../../dist/config.json"))
            .unwrap_or_default(),
    ];
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<DistConfigFile>(&raw) else {
            continue;
        };
        if let Some(g) = parsed.github {
            if !g.api_url.trim().is_empty() {
                cfg.api_url = g.api_url;
            }
            if !g.download_url.trim().is_empty() {
                cfg.download_url = g.download_url;
            }
            if !g.owner.trim().is_empty() {
                cfg.owner = g.owner;
            }
            if !g.name.trim().is_empty() {
                cfg.name = g.name;
            }
            if !g.ref_name.trim().is_empty() {
                cfg.ref_name = g.ref_name;
            }
            if !g.path.trim().is_empty() {
                cfg.path = g.path;
            }
            break;
        }
    }
    if !cfg.api_url.ends_with('/') {
        cfg.api_url.push('/');
    }
    if !cfg.download_url.ends_with('/') {
        cfg.download_url.push('/');
    }
    if cfg.ref_name.is_empty() {
        cfg.ref_name = "master".into();
    }
    cfg
}

fn ensure_userdata() -> Result<(), String> {
    fs::create_dir_all(userdata_dir()).map_err(|e| format!("userdata: {e}"))
}

pub fn load_repo_entries() -> Vec<LuaRepoEntry> {
    let path = lua_json_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<LuaRepoEntry>>(&raw).unwrap_or_default()
}

fn save_repo_entries(entries: &[LuaRepoEntry]) -> Result<(), String> {
    ensure_userdata()?;
    let path = lua_json_path();
    let raw = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("guardar lua.json: {e}"))
}

fn load_work_state() -> RepoWorkState {
    let path = lua_repo_work_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return RepoWorkState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_work_state(state: &RepoWorkState) -> Result<(), String> {
    ensure_userdata()?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(lua_repo_work_path(), raw).map_err(|e| format!("guardar lua_repo.json: {e}"))
}

fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn local_file_path(rel: &str) -> PathBuf {
    lua_root().join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("FMD3-modules-updater")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn check_rate_limited(client: &reqwest::blocking::Client, cfg: &GithubConfig) -> Result<(), String> {
    let url = format!("{}rate_limit", cfg.api_url);
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(());
    }
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let remaining = v
        .pointer("/resources/core/remaining")
        .and_then(|x| x.as_i64())
        .unwrap_or(1);
    if remaining <= 0 {
        return Err("GitHub API rate limit agotado. Intenta más tarde.".into());
    }
    Ok(())
}

fn fetch_last_commit(
    client: &reqwest::blocking::Client,
    cfg: &GithubConfig,
    work: &mut RepoWorkState,
) -> Result<String, String> {
    let mut url = format!(
        "{}repos/{}/{}/commits?sha={}&per_page=1",
        cfg.api_url, cfg.owner, cfg.name, cfg.ref_name
    );
    if !cfg.path.is_empty() {
        url.push_str("&path=");
        url.push_str(&cfg.path);
    }
    let mut req = client.get(&url);
    if !work.last_commit_etag.is_empty() {
        req = req.header("If-None-Match", work.last_commit_etag.trim());
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    if let Some(etag) = resp.headers().get("etag") {
        if let Ok(s) = etag.to_str() {
            work.last_commit_etag = s.to_string();
        }
    }
    if resp.status().as_u16() == 304 {
        return Ok(work.last_commit_sha.clone());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub commits: HTTP {}", resp.status()));
    }
    let arr: Vec<serde_json::Value> = resp.json().map_err(|e| e.to_string())?;
    let sha = arr
        .first()
        .and_then(|o| o.get("sha"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    if sha.is_empty() {
        return Err("GitHub commits: respuesta vacía".into());
    }
    work.last_commit_sha = sha.clone();
    Ok(sha)
}

fn fetch_tree(
    client: &reqwest::blocking::Client,
    cfg: &GithubConfig,
    commit_sha: &str,
) -> Result<Vec<(String, String)>, String> {
    let sha = if commit_sha.is_empty() {
        cfg.ref_name.as_str()
    } else {
        commit_sha
    };
    let url = format!(
        "{}repos/{}/{}/git/trees/{}:{}?recursive=1",
        cfg.api_url, cfg.owner, cfg.name, sha, cfg.path
    );
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub tree: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let Some(arr) = v.get("tree").and_then(|t| t.as_array()) else {
        return Err("GitHub tree: sin campo tree".into());
    };
    let mut out = Vec::new();
    for item in arr {
        let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == "tree" {
            continue;
        }
        let path = item
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        let sha = item
            .get("sha")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if !path.is_empty() && !sha.is_empty() {
            out.push((path, sha));
        }
    }
    if out.is_empty() {
        return Err("GitHub tree: vacío".into());
    }
    Ok(out)
}

fn fetch_commit_message(
    client: &reqwest::blocking::Client,
    cfg: &GithubConfig,
    rel_path: &str,
) -> String {
    let mut url = format!(
        "{}repos/{}/{}/commits?per_page=1",
        cfg.api_url, cfg.owner, cfg.name
    );
    if !cfg.path.is_empty() {
        url.push_str("&path=");
        url.push_str(&cfg.path);
        url.push('/');
        url.push_str(rel_path);
    }
    let Ok(resp) = client.get(&url).send() else {
        return String::new();
    };
    if !resp.status().is_success() {
        return String::new();
    }
    let Ok(arr) = resp.json::<Vec<serde_json::Value>>() else {
        return String::new();
    };
    arr.first()
        .and_then(|o| o.pointer("/commit/message"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

fn download_url(cfg: &GithubConfig, rel: &str) -> String {
    let mut base = cfg.download_url.clone();
    if !base.ends_with('/') {
        base.push('/');
    }
    let mut path_prefix = cfg.path.clone();
    if !path_prefix.is_empty() && !path_prefix.ends_with('/') {
        path_prefix.push('/');
    }
    format!(
        "{}{}/{}/{}/{}{}",
        base, cfg.owner, cfg.name, cfg.ref_name, path_prefix, rel
    )
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sync_repos(local: &mut Vec<LuaRepoEntry>, remote: &[(String, String)]) -> bool {
    let remote_map: HashMap<&str, &str> = remote
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    let mut found = false;

    for entry in local.iter_mut() {
        match remote_map.get(entry.name.as_str()) {
            Some(sha) => {
                if entry.sha != *sha {
                    entry.sha = (*sha).to_string();
                    entry.flag = FLAG_UPDATE.into();
                    entry.last_modified = Some(now_unix());
                    found = true;
                } else if entry.flag != FLAG_FAILED {
                    entry.flag = FLAG_NONE.into();
                }
            }
            None => {
                entry.flag = FLAG_DELETE.into();
                found = true;
            }
        }
    }

    let local_names: HashMap<String, ()> =
        local.iter().map(|e| (e.name.clone(), ())).collect();
    for (path, sha) in remote {
        if local_names.contains_key(path) {
            continue;
        }
        let disk = local_file_path(path);
        if disk.is_file() {
            if let Ok(bytes) = fs::read(&disk) {
                if git_blob_sha(&bytes) == *sha {
                    // Already present with matching content — seed without re-download.
                    local.push(LuaRepoEntry {
                        name: path.clone(),
                        sha: sha.clone(),
                        last_modified: file_mtime_unix(&disk),
                        last_message: String::new(),
                        flag: FLAG_NONE.into(),
                    });
                    continue;
                }
            }
        }
        local.push(LuaRepoEntry {
            name: path.clone(),
            sha: sha.clone(),
            last_modified: Some(now_unix()),
            last_message: String::new(),
            flag: FLAG_NEW.into(),
        });
        found = true;
    }

    local.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn file_mtime_unix(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

fn mark_missing_as_failed(entries: &mut [LuaRepoEntry], status: &mut Vec<String>) -> bool {
    let mut found = false;
    for entry in entries.iter_mut() {
        if entry.flag == FLAG_NEW || entry.flag == FLAG_UPDATE || entry.flag == FLAG_DELETE {
            continue;
        }
        let disk = local_file_path(&entry.name);
        if !disk.is_file() {
            entry.flag = FLAG_FAILED.into();
            found = true;
            status.push(format!("{} FAILED*", entry.name));
        }
    }
    found
}

fn collect_status(entries: &[LuaRepoEntry]) -> (Vec<String>, usize, usize, usize, usize) {
    let mut lines = Vec::new();
    let mut new_c = 0;
    let mut upd_c = 0;
    let mut del_c = 0;
    let mut fail_c = 0;
    for e in entries {
        match e.flag.as_str() {
            FLAG_NEW => {
                new_c += 1;
                lines.push(format!("{} NEW*", e.name));
            }
            FLAG_UPDATE => {
                upd_c += 1;
                lines.push(format!("{} UPDATE*", e.name));
            }
            FLAG_DELETE => {
                del_c += 1;
                lines.push(format!("{} DELETE*", e.name));
            }
            FLAG_FAILED => {
                fail_c += 1;
                if !lines.iter().any(|l| l.starts_with(&e.name)) {
                    lines.push(format!("{} FAILED*", e.name));
                }
            }
            _ => {}
        }
    }
    (lines, new_c, upd_c, del_c, fail_c)
}

fn apply_downloads(
    client: &reqwest::blocking::Client,
    cfg: &GithubConfig,
    entries: &mut [LuaRepoEntry],
) -> Result<usize, String> {
    let root = lua_root();
    fs::create_dir_all(&root).map_err(|e| format!("lua root: {e}"))?;
    let mut done = 0usize;

    // Deletes first
    for entry in entries.iter_mut() {
        if entry.flag != FLAG_DELETE {
            continue;
        }
        let disk = local_file_path(&entry.name);
        if disk.is_file() {
            let _ = fs::remove_file(&disk);
        }
        entry.flag = FLAG_DELETED.into();
        done += 1;
    }

    for entry in entries.iter_mut() {
        if entry.flag != FLAG_NEW && entry.flag != FLAG_UPDATE && entry.flag != FLAG_FAILED {
            continue;
        }
        let msg = fetch_commit_message(client, cfg, &entry.name);
        if !msg.is_empty() {
            entry.last_message = msg;
        }
        let url = download_url(cfg, &entry.name);
        match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().map_err(|e| e.to_string())?;
                let disk = local_file_path(&entry.name);
                if let Some(parent) = disk.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
                }
                fs::write(&disk, &bytes).map_err(|e| format!("write {}: {e}", disk.display()))?;
                entry.last_modified = Some(now_unix());
                entry.flag = FLAG_NONE.into();
                done += 1;
            }
            Ok(resp) => {
                entry.flag = FLAG_FAILED.into();
                eprintln!("modules_updater: download {} → HTTP {}", entry.name, resp.status());
            }
            Err(e) => {
                entry.flag = FLAG_FAILED.into();
                eprintln!("modules_updater: download {}: {e}", entry.name);
            }
        }
    }

    // Drop deleted entries; reset leftover new/update that somehow remain to failed
    Ok(done)
}

fn finalize_entries(entries: &mut Vec<LuaRepoEntry>) {
    entries.retain(|e| e.flag != FLAG_DELETED);
    for e in entries.iter_mut() {
        if e.flag == FLAG_NEW || e.flag == FLAG_UPDATE {
            e.flag = FLAG_FAILED.into();
        } else if e.flag != FLAG_FAILED {
            e.flag = FLAG_NONE.into();
        }
    }
}

/// List repo state for the Modules UI. Falls back to local `modules/*.lua` if empty.
pub fn list_for_ui() -> Vec<LuaRepoEntry> {
    let mut entries = load_repo_entries();
    if !entries.is_empty() {
        // Refresh flags for display: highlight new/update still pending or recent
        return entries;
    }
    // Fallback: scan modules dir so the tab isn't empty before first sync.
    let dir = lua_root().join("modules");
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lua") {
            continue;
        }
        let name = format!(
            "modules/{}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown.lua")
        );
        entries.push(LuaRepoEntry {
            name,
            sha: String::new(),
            last_modified: file_mtime_unix(&path),
            last_message: String::new(),
            flag: FLAG_NONE.into(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// Check / apply GitHub module updates.
///
/// - `proceed = None`: check; if updates and show-warning setting → `awaiting_confirm`.
/// - `proceed = Some(false)`: abort without applying (still saves work state / flags).
/// - `proceed = Some(true)`: apply downloads/deletes.
/// - `force_apply`: skip warning gate (used when warning setting is off, or auto with proceed).
pub fn update_from_github(proceed: Option<bool>) -> Result<ModulesUpdateReport, String> {
    let _guard = UPDATE_LOCK
        .try_lock()
        .ok_or_else(|| "Ya hay una revisión de módulos en curso".to_string())?;

    let show_warning = crate::settings_keys::bool_setting(
        crate::settings_keys::MODULES_UPDATER_SHOW_WARNING,
        true,
    );

    let cfg = load_github_config();
    let client = http_client()?;
    check_rate_limited(&client, &cfg)?;

    let mut work = load_work_state();
    let old_sha = work.last_commit_sha.clone();
    let new_sha = fetch_last_commit(&client, &cfg, &mut work)?;
    let tree_changed = new_sha != old_sha || old_sha.is_empty();

    let mut entries = load_repo_entries();
    let mut remote_tree: Option<Vec<(String, String)>> = None;

    if tree_changed {
        remote_tree = Some(fetch_tree(&client, &cfg, &new_sha)?);
        let _ = save_work_state(&work);
    }

    let mut found = false;
    if let Some(ref tree) = remote_tree {
        found = sync_repos(&mut entries, tree);
    } else if entries.is_empty() {
        // First run / empty lua.json but commit unchanged: still need a tree.
        let tree = fetch_tree(&client, &cfg, &new_sha)?;
        found = sync_repos(&mut entries, &tree);
        let _ = save_work_state(&work);
    }

    // Pending flags from a prior check (awaiting_confirm → proceed).
    if entries.iter().any(|e| {
        matches!(
            e.flag.as_str(),
            FLAG_NEW | FLAG_UPDATE | FLAG_DELETE | FLAG_FAILED
        )
    }) {
        found = true;
    }

    let mut status = Vec::new();
    if mark_missing_as_failed(&mut entries, &mut status) {
        found = true;
    }

    let (mut status_lines, new_c, upd_c, del_c, fail_c) = collect_status(&entries);
    status_lines.splice(0..0, status);

    let empty_report = |applied: bool, awaiting: bool, refreshed: usize| ModulesUpdateReport {
        found_updates: found,
        applied,
        awaiting_confirm: awaiting,
        refreshed_count: refreshed,
        status_lines: status_lines.clone(),
        new_count: new_c,
        update_count: upd_c,
        delete_count: del_c,
        failed_count: fail_c,
    };

    if !found {
        // Persist seeded none-flags from blob match
        let _ = save_repo_entries(&entries);
        return Ok(empty_report(false, false, 0));
    }

    // Need user confirmation?
    if show_warning && proceed != Some(true) {
        let _ = save_repo_entries(&entries);
        if proceed == Some(false) {
            return Ok(empty_report(false, false, 0));
        }
        return Ok(empty_report(false, true, 0));
    }

    if proceed == Some(false) {
        let _ = save_repo_entries(&entries);
        return Ok(empty_report(false, false, 0));
    }

    // Apply
    apply_downloads(&client, &cfg, &mut entries)?;
    finalize_entries(&mut entries);
    save_repo_entries(&entries)?;
    let refreshed = super::registry::refresh();

    Ok(ModulesUpdateReport {
        found_updates: true,
        applied: true,
        awaiting_confirm: false,
        refreshed_count: refreshed,
        status_lines,
        new_count: new_c,
        update_count: upd_c,
        delete_count: del_c,
        failed_count: fail_c,
    })
}
