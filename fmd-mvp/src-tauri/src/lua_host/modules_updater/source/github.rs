//! GitHub repository source — the FMD2 Lua tree (`dazedcat19/FMD2`, path `lua`).
//!
//! Request budget is the design constraint: the unauthenticated API allows 60
//! calls per hour, and the tree has ~670 files. A full cycle costs two API
//! calls (probe + tree) plus one archive download, because `raw` and `codeload`
//! do not draw on the API quota.

use super::{BulkHint, Probe, RemoteEntry, RemoteMeta, Source};
use crate::lua_host::modules_updater::archive;
use crate::lua_host::modules_updater::state::{git_blob_sha, safe_rel_path, SourceCursor};
use crate::settings_keys;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const CODELOAD: &str = "https://codeload.github.com/";
const DEFAULT_DOWNLOAD: &str = "https://raw.githubusercontent.com/";
/// Below this many changed files the archive is not worth ~8 MB of traffic.
const BULK_MIN_FILES: usize = 40;

#[derive(Debug, Clone)]
pub struct GithubConfig {
    pub api_url: String,
    pub download_url: String,
    pub owner: String,
    pub name: String,
    pub ref_name: String,
    pub path: String,
}

impl Default for GithubConfig {
    fn default() -> Self {
        Self {
            api_url: "https://api.github.com/".into(),
            download_url: DEFAULT_DOWNLOAD.into(),
            owner: "dazedcat19".into(),
            name: "FMD2".into(),
            ref_name: "master".into(),
            path: "lua".into(),
        }
    }
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

fn load_config() -> GithubConfig {
    let mut cfg = GithubConfig::default();
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
        let Some(g) = parsed.github else { continue };
        let set = |dst: &mut String, src: String| {
            if !src.trim().is_empty() {
                *dst = src;
            }
        };
        set(&mut cfg.api_url, g.api_url);
        set(&mut cfg.download_url, g.download_url);
        set(&mut cfg.owner, g.owner);
        set(&mut cfg.name, g.name);
        set(&mut cfg.ref_name, g.ref_name);
        set(&mut cfg.path, g.path);
        break;
    }
    if !cfg.api_url.ends_with('/') {
        cfg.api_url.push('/');
    }
    if !cfg.download_url.ends_with('/') {
        cfg.download_url.push('/');
    }
    if cfg.ref_name.trim().is_empty() {
        cfg.ref_name = "master".into();
    }
    cfg
}

pub struct GithubSource {
    cfg: GithubConfig,
    client: reqwest::blocking::Client,
    rate: Mutex<(Option<i64>, Option<i64>)>,
}

impl GithubSource {
    pub fn from_config() -> Self {
        Self::new(load_config())
    }

    pub fn new(cfg: GithubConfig) -> Self {
        let client = reqwest::blocking::Client::builder()
            .user_agent("FMD3-modules-updater")
            .timeout(std::time::Duration::from_secs(
                settings_keys::http_timeout_secs().max(30),
            ))
            .build()
            .unwrap_or_default();
        Self {
            cfg,
            client,
            rate: Mutex::new((None, None)),
        }
    }

    fn note_rate(&self, headers: &reqwest::header::HeaderMap) {
        let read = |k: &str| {
            headers
                .get(k)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok())
        };
        let remaining = read("x-ratelimit-remaining");
        let reset = read("x-ratelimit-reset");
        if remaining.is_some() || reset.is_some() {
            *self.rate.lock() = (remaining, reset);
        }
    }

    /// Turn a GitHub failure into something a user can act on. A 403 with an
    /// exhausted quota is the common one and used to cost a preflight call.
    fn api_error(&self, what: &str, status: reqwest::StatusCode) -> String {
        let (remaining, reset) = *self.rate.lock();
        if status.as_u16() == 403 && remaining == Some(0) {
            let when = reset
                .map(|t| {
                    let mins = (t - crate::lua_host::modules_updater::state::now_unix()).max(0) / 60;
                    format!(" Vuelve a intentarlo en ~{} min.", mins + 1)
                })
                .unwrap_or_default();
            return format!("Límite de la API de GitHub agotado.{when}");
        }
        format!("GitHub {what}: HTTP {status}")
    }

    fn raw_url(&self, revision: &str, rel: &str) -> String {
        let mut prefix = self.cfg.path.clone();
        if !prefix.is_empty() && !prefix.ends_with('/') {
            prefix.push('/');
        }
        format!(
            "{}{}/{}/{}/{}{}",
            self.cfg.download_url, self.cfg.owner, self.cfg.name, revision, prefix, rel
        )
    }
}

impl Source for GithubSource {
    fn id(&self) -> String {
        format!(
            "github:{}/{}@{}:{}",
            self.cfg.owner, self.cfg.name, self.cfg.ref_name, self.cfg.path
        )
    }

    fn label(&self) -> String {
        format!(
            "GitHub {}/{} ({}/{})",
            self.cfg.owner, self.cfg.name, self.cfg.ref_name, self.cfg.path
        )
    }

    fn probe(&self, cursor: &mut SourceCursor) -> Result<Probe, String> {
        let mut url = format!(
            "{}repos/{}/{}/commits?sha={}&per_page=1",
            self.cfg.api_url, self.cfg.owner, self.cfg.name, self.cfg.ref_name
        );
        if !self.cfg.path.is_empty() {
            url.push_str("&path=");
            url.push_str(&self.cfg.path);
        }
        let mut req = self.client.get(&url);
        if !cursor.etag.is_empty() && !cursor.revision.is_empty() {
            req = req.header("If-None-Match", cursor.etag.trim());
        }
        let resp = req.send().map_err(|e| format!("GitHub commits: {e}"))?;
        self.note_rate(resp.headers());
        let etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        if resp.status().as_u16() == 304 && !cursor.revision.is_empty() {
            cursor.checked_at = crate::lua_host::modules_updater::state::now_unix();
            return Ok(Probe::Unchanged);
        }
        if !resp.status().is_success() {
            return Err(self.api_error("commits", resp.status()));
        }
        let arr: Vec<serde_json::Value> = resp.json().map_err(|e| format!("GitHub commits: {e}"))?;
        let sha = arr
            .first()
            .and_then(|o| o.get("sha"))
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
        if sha.is_empty() {
            return Err("GitHub commits: respuesta vacía".into());
        }
        // The ETag is only recorded together with the revision it describes, so a
        // 304 can never be paired with a stale or missing revision.
        cursor.revision = sha.clone();
        cursor.etag = etag.unwrap_or_default();
        cursor.checked_at = crate::lua_host::modules_updater::state::now_unix();
        Ok(Probe::Changed { revision: sha })
    }

    fn list(&self, revision: &str) -> Result<Vec<RemoteEntry>, String> {
        let rev = if revision.is_empty() {
            self.cfg.ref_name.as_str()
        } else {
            revision
        };
        let url = format!(
            "{}repos/{}/{}/git/trees/{}:{}?recursive=1",
            self.cfg.api_url, self.cfg.owner, self.cfg.name, rev, self.cfg.path
        );
        let resp = self
            .client
            .get(&url)
            .send()
            .map_err(|e| format!("GitHub tree: {e}"))?;
        self.note_rate(resp.headers());
        if !resp.status().is_success() {
            return Err(self.api_error("tree", resp.status()));
        }
        let v: serde_json::Value = resp.json().map_err(|e| format!("GitHub tree: {e}"))?;
        // A truncated listing is not just incomplete, it is dangerous: every
        // file GitHub left out would read as "deleted upstream" and get removed.
        if v.get("truncated").and_then(|t| t.as_bool()) == Some(true) {
            return Err(
                "GitHub devolvió el árbol truncado; el repositorio es demasiado grande para sincronizar de una vez"
                    .into(),
            );
        }
        let Some(arr) = v.get("tree").and_then(|t| t.as_array()) else {
            return Err("GitHub tree: sin campo «tree»".into());
        };
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) != Some("blob") {
                continue;
            }
            let path = item
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            let sha = item
                .get("sha")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            if path.is_empty() || sha.is_empty() {
                continue;
            }
            if let Err(e) = safe_rel_path(&path) {
                eprintln!("modules_updater: {e}");
                continue;
            }
            out.push(RemoteEntry {
                path,
                content_id: sha,
                size: item.get("size").and_then(|s| s.as_u64()),
            });
        }
        if out.is_empty() {
            return Err("GitHub tree: vacío".into());
        }
        Ok(out)
    }

    fn content_id(&self, bytes: &[u8]) -> String {
        git_blob_sha(bytes)
    }

    fn fetch_one(&self, revision: &str, path: &str) -> Result<Vec<u8>, String> {
        let url = self.raw_url(revision, path);
        let resp = self.client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    }

    fn bulk_hint(&self) -> BulkHint {
        // A mirror may not expose a codeload-compatible archive.
        if self.cfg.download_url != DEFAULT_DOWNLOAD {
            return BulkHint::None;
        }
        BulkHint::Archive {
            min_files: BULK_MIN_FILES,
        }
    }

    fn fetch_bulk(
        &self,
        revision: &str,
        wanted: &HashSet<String>,
        on_bytes: &mut dyn FnMut(u64, u64),
        cancel: &dyn Fn() -> bool,
    ) -> Result<HashMap<String, Vec<u8>>, String> {
        if revision.is_empty() {
            return Err("revisión vacía".into());
        }
        let url = format!(
            "{}{}/{}/zip/{}",
            CODELOAD, self.cfg.owner, self.cfg.name, revision
        );
        // Archive entries look like `FMD2-<sha>/lua/modules/Foo.lua`: drop the
        // repo-and-revision wrapper, then keep only what lives under our path.
        let prefix = if self.cfg.path.is_empty() {
            String::new()
        } else {
            format!("{}/", self.cfg.path.trim_end_matches('/'))
        };
        let strip = move |name: &str| -> Option<String> {
            let rest = name.split_once('/')?.1;
            if prefix.is_empty() {
                return Some(rest.to_string());
            }
            rest.strip_prefix(&prefix).map(|s| s.to_string())
        };
        archive::download_and_extract(&self.client, &url, wanted, &strip, on_bytes, cancel)
    }

    /// GitHub has no endpoint that maps many files to their last commit in one
    /// call (the commit list omits `files`), so this is one request per file and
    /// therefore capped hard. Above the cap the caller falls back to disk mtime.
    fn metadata(
        &self,
        _revision: &str,
        paths: &[String],
    ) -> Result<HashMap<String, RemoteMeta>, String> {
        let cap = settings_keys::usize_setting(settings_keys::MODULES_METADATA_MAX_FILES, 10);
        if cap == 0 || paths.len() > cap {
            return Ok(HashMap::new());
        }
        let mut out = HashMap::new();
        for rel in paths {
            let mut url = format!(
                "{}repos/{}/{}/commits?per_page=1",
                self.cfg.api_url, self.cfg.owner, self.cfg.name
            );
            url.push_str("&path=");
            if !self.cfg.path.is_empty() {
                url.push_str(&self.cfg.path);
                url.push('/');
            }
            url.push_str(rel);
            let Ok(resp) = self.client.get(&url).send() else {
                continue;
            };
            self.note_rate(resp.headers());
            if !resp.status().is_success() {
                // A quota wall here is cosmetic; stop asking and keep the sync going.
                break;
            }
            let Ok(arr) = resp.json::<Vec<serde_json::Value>>() else {
                continue;
            };
            let Some(first) = arr.first() else { continue };
            let message = first
                .pointer("/commit/message")
                .and_then(|m| m.as_str())
                .unwrap_or_default()
                .lines()
                .next()
                .unwrap_or_default()
                .to_string();
            let updated_at = first
                .pointer("/commit/committer/date")
                .and_then(|d| d.as_str())
                .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
                .map(|d| d.timestamp());
            let author = first
                .pointer("/commit/author/name")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string());
            out.insert(
                rel.clone(),
                RemoteMeta {
                    updated_at,
                    message,
                    author,
                    version: None,
                },
            );
        }
        Ok(out)
    }

    fn max_parallel(&self) -> usize {
        8
    }

    fn rate_status(&self) -> (Option<i64>, Option<i64>) {
        *self.rate.lock()
    }
}
