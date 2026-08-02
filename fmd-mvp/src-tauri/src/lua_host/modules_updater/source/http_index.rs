//! HTTP index source — the contract a community Lua portal implements.
//!
//! Unlike GitHub, the portal declares everything the updater needs in one
//! document: content hashes, per-file metadata, an optional bundle, and the
//! version history that makes remote revert possible.
//!
//! ```json
//! {
//!   "schema": 1,
//!   "id": "fmd-community",
//!   "revision": "2026-08-01T12:00:00Z#4213",
//!   "hash_algo": "sha256",
//!   "base_url": "https://portal.example/lua/",
//!   "bulk": { "url": "…/bundle-4213.zip", "strip_prefix": "lua/" },
//!   "files": [
//!     { "path": "modules/Foo.lua", "hash": "9f2c…", "size": 4211,
//!       "version": "1.4.2", "author": "someone", "updated_at": 1749900000,
//!       "message": "fix chapter list", "url": "modules/Foo.lua?v=1.4.2",
//!       "history": [ { "version": "1.4.1", "hash": "3ab0…",
//!                      "updated_at": 1749000000, "url": "archive/Foo-1.4.1.lua" } ] }
//!   ]
//! }
//! ```
//! Only `path`, `hash` and `size` are required per file. Unknown keys are
//! ignored so the portal can grow without breaking older clients.

use super::{BulkHint, Probe, RemoteEntry, RemoteMeta, Source};
use crate::lua_host::modules_updater::archive;
use crate::lua_host::modules_updater::model::FileVersion;
use crate::lua_host::modules_updater::state::{now_unix, safe_rel_path, SourceCursor};
use crate::settings_keys;
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const SUPPORTED_SCHEMA: u32 = 1;
const BULK_MIN_FILES: usize = 20;

#[derive(Debug, Clone, Deserialize)]
struct IndexFile {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    hash_algo: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    bulk: Option<BulkSpec>,
    #[serde(default)]
    files: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct BulkSpec {
    url: String,
    #[serde(default)]
    strip_prefix: String,
}

#[derive(Debug, Clone, Deserialize)]
struct IndexEntry {
    path: String,
    hash: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    updated_at: Option<i64>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    history: Vec<IndexVersion>,
}

#[derive(Debug, Clone, Deserialize)]
struct IndexVersion {
    hash: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    updated_at: Option<i64>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    url: Option<String>,
}

pub struct HttpIndexSource {
    url: String,
    client: reqwest::blocking::Client,
    /// Last parsed index, keyed by its revision. `list` and every fetch reuse it.
    cached: Mutex<Option<IndexFile>>,
}

impl HttpIndexSource {
    pub fn new(url: String) -> Self {
        let client = reqwest::blocking::Client::builder()
            .user_agent("FMD3-modules-updater")
            .timeout(std::time::Duration::from_secs(
                settings_keys::http_timeout_secs().max(30),
            ))
            .build()
            .unwrap_or_default();
        Self {
            url,
            client,
            cached: Mutex::new(None),
        }
    }

    fn fetch_index(&self, etag: Option<&str>) -> Result<(Option<IndexFile>, String), String> {
        let mut req = self.client.get(&self.url);
        if let Some(tag) = etag.filter(|t| !t.is_empty()) {
            req = req.header("If-None-Match", tag);
        }
        let resp = req.send().map_err(|e| format!("índice: {e}"))?;
        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if resp.status().as_u16() == 304 {
            return Ok((None, new_etag));
        }
        if !resp.status().is_success() {
            return Err(format!("índice: HTTP {}", resp.status()));
        }
        let parsed: IndexFile = resp.json().map_err(|e| format!("índice ilegible: {e}"))?;
        if parsed.schema > SUPPORTED_SCHEMA {
            return Err(format!(
                "El índice usa el esquema {} y esta versión soporta hasta {SUPPORTED_SCHEMA}. Actualiza la app.",
                parsed.schema
            ));
        }
        Ok((Some(parsed), new_etag))
    }

    /// The cached index, re-fetching if the revision does not match.
    fn index_for(&self, revision: &str) -> Result<IndexFile, String> {
        if let Some(idx) = self.cached.lock().as_ref() {
            if revision.is_empty() || idx.revision == revision {
                return Ok(idx.clone());
            }
        }
        let (parsed, _) = self.fetch_index(None)?;
        let parsed = parsed.ok_or_else(|| "índice: respuesta 304 inesperada".to_string())?;
        *self.cached.lock() = Some(parsed.clone());
        Ok(parsed)
    }

    fn absolute(&self, base_url: &str, rel: &str) -> String {
        if rel.starts_with("http://") || rel.starts_with("https://") {
            return rel.to_string();
        }
        let mut base = if base_url.trim().is_empty() {
            // Default: siblings of the index document.
            self.url
                .rsplit_once('/')
                .map(|(head, _)| format!("{head}/"))
                .unwrap_or_default()
        } else {
            base_url.to_string()
        };
        if !base.ends_with('/') {
            base.push('/');
        }
        format!("{base}{rel}")
    }

    fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let resp = self.client.get(url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    }
}

impl Source for HttpIndexSource {
    fn id(&self) -> String {
        let idx = self.cached.lock();
        let name = idx
            .as_ref()
            .map(|i| i.id.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.url.clone());
        format!("portal:{name}")
    }

    fn label(&self) -> String {
        format!("Portal {}", self.url)
    }

    fn probe(&self, cursor: &mut SourceCursor) -> Result<Probe, String> {
        let (parsed, etag) = self.fetch_index(Some(&cursor.etag))?;
        let Some(parsed) = parsed else {
            cursor.etag = etag;
            cursor.checked_at = now_unix();
            if cursor.revision.is_empty() {
                // 304 without a known revision would leave us with nothing to pin to.
                let (forced, etag2) = self.fetch_index(None)?;
                let forced = forced.ok_or_else(|| "índice: 304 inesperado".to_string())?;
                let revision = forced.revision.clone();
                *self.cached.lock() = Some(forced);
                cursor.revision = revision.clone();
                cursor.etag = etag2;
                return Ok(Probe::Changed { revision });
            }
            return Ok(Probe::Unchanged);
        };
        let revision = if parsed.revision.is_empty() {
            // No declared revision: hash the document so content changes still show.
            let mut h = Sha256::new();
            h.update(serde_json::to_vec(&parsed.files.len()).unwrap_or_default());
            for f in &parsed.files {
                h.update(f.path.as_bytes());
                h.update(f.hash.as_bytes());
            }
            format!("{:x}", h.finalize())
        } else {
            parsed.revision.clone()
        };
        let unchanged = cursor.revision == revision && !cursor.revision.is_empty();
        *self.cached.lock() = Some(parsed);
        cursor.revision = revision.clone();
        cursor.etag = etag;
        cursor.checked_at = now_unix();
        if unchanged {
            Ok(Probe::Unchanged)
        } else {
            Ok(Probe::Changed { revision })
        }
    }

    fn list(&self, revision: &str) -> Result<Vec<RemoteEntry>, String> {
        let idx = self.index_for(revision)?;
        let mut out = Vec::with_capacity(idx.files.len());
        for f in &idx.files {
            if f.hash.trim().is_empty() {
                continue;
            }
            if let Err(e) = safe_rel_path(&f.path) {
                eprintln!("modules_updater: {e}");
                continue;
            }
            out.push(RemoteEntry {
                path: f.path.clone(),
                content_id: f.hash.clone(),
                size: f.size,
            });
        }
        if out.is_empty() {
            return Err("El índice del portal no lista archivos".into());
        }
        Ok(out)
    }

    fn content_id(&self, bytes: &[u8]) -> String {
        let algo = self
            .cached
            .lock()
            .as_ref()
            .map(|i| i.hash_algo.to_lowercase())
            .unwrap_or_default();
        match algo.as_str() {
            "" | "sha256" => {
                let mut h = Sha256::new();
                h.update(bytes);
                format!("{:x}", h.finalize())
            }
            // A portal may prefer git-compatible ids so mirrors line up.
            "git-blob" | "sha1-git" => {
                crate::lua_host::modules_updater::state::git_blob_sha(bytes)
            }
            other => {
                eprintln!("modules_updater: hash_algo «{other}» desconocido; se asume sha256");
                let mut h = Sha256::new();
                h.update(bytes);
                format!("{:x}", h.finalize())
            }
        }
    }

    fn fetch_one(&self, revision: &str, path: &str) -> Result<Vec<u8>, String> {
        let idx = self.index_for(revision)?;
        let entry = idx
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or_else(|| format!("«{path}» no está en el índice"))?;
        let rel = entry.url.clone().unwrap_or_else(|| entry.path.clone());
        self.get_bytes(&self.absolute(&idx.base_url, &rel))
    }

    fn bulk_hint(&self) -> BulkHint {
        let has_bulk = self
            .cached
            .lock()
            .as_ref()
            .map(|i| i.bulk.is_some())
            .unwrap_or(false);
        if has_bulk {
            BulkHint::Archive {
                min_files: BULK_MIN_FILES,
            }
        } else {
            BulkHint::None
        }
    }

    fn fetch_bulk(
        &self,
        revision: &str,
        wanted: &HashSet<String>,
        on_bytes: &mut dyn FnMut(u64, u64),
        cancel: &dyn Fn() -> bool,
    ) -> Result<HashMap<String, Vec<u8>>, String> {
        let idx = self.index_for(revision)?;
        let bulk = idx
            .bulk
            .clone()
            .ok_or_else(|| "el índice no declara «bulk»".to_string())?;
        let url = self.absolute(&idx.base_url, &bulk.url);
        let prefix = bulk.strip_prefix.trim_matches('/').to_string();
        let strip = move |name: &str| -> Option<String> {
            if prefix.is_empty() {
                return Some(name.to_string());
            }
            name.strip_prefix(&format!("{prefix}/")).map(String::from)
        };
        archive::download_and_extract(&self.client, &url, wanted, &strip, on_bytes, cancel)
    }

    fn metadata(
        &self,
        revision: &str,
        paths: &[String],
    ) -> Result<HashMap<String, RemoteMeta>, String> {
        // Free: the index already carries it, no extra request.
        let idx = self.index_for(revision)?;
        let want: HashSet<&str> = paths.iter().map(|s| s.as_str()).collect();
        let mut out = HashMap::new();
        for f in &idx.files {
            if !want.contains(f.path.as_str()) {
                continue;
            }
            out.insert(
                f.path.clone(),
                RemoteMeta {
                    updated_at: f.updated_at,
                    message: f.message.clone(),
                    author: f.author.clone(),
                    version: f.version.clone(),
                },
            );
        }
        Ok(out)
    }

    fn versions(&self, path: &str) -> Vec<FileVersion> {
        let Some(idx) = self.cached.lock().clone() else {
            return Vec::new();
        };
        let Some(entry) = idx.files.iter().find(|f| f.path == path) else {
            return Vec::new();
        };
        entry
            .history
            .iter()
            .map(|h| FileVersion {
                content_id: h.hash.clone(),
                version: h.version.clone(),
                updated_at: h.updated_at,
                size: h.size,
                message: h.message.clone(),
                origin: "remote".into(),
            })
            .collect()
    }

    fn fetch_version(&self, path: &str, content_id: &str) -> Result<Vec<u8>, String> {
        let idx = self.index_for("")?;
        let entry = idx
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or_else(|| format!("«{path}» no está en el índice"))?;
        if entry.hash == content_id {
            let rel = entry.url.clone().unwrap_or_else(|| entry.path.clone());
            return self.get_bytes(&self.absolute(&idx.base_url, &rel));
        }
        let ver = entry
            .history
            .iter()
            .find(|h| h.hash == content_id)
            .ok_or_else(|| "esa versión ya no está publicada".to_string())?;
        let rel = ver.url.clone().unwrap_or_else(|| entry.path.clone());
        self.get_bytes(&self.absolute(&idx.base_url, &rel))
    }

    fn max_parallel(&self) -> usize {
        6
    }
}
