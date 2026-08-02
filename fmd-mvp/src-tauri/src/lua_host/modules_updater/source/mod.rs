//! Where Lua modules come from.
//!
//! The updater talks only to this trait, so the same sync/apply/snapshot
//! machinery serves the FMD2 GitHub repo today and a community portal or a
//! local folder tomorrow.

pub mod github;
pub mod http_index;
pub mod local_dir;

use super::model::FileVersion;
use super::state::SourceCursor;
use crate::settings_keys;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// One file advertised by a source.
#[derive(Debug, Clone)]
pub struct RemoteEntry {
    /// Relative to the Lua root, forward slashes. Validated by the source.
    pub path: String,
    /// Opaque content id: git blob sha for GitHub, whatever the portal declares.
    pub content_id: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RemoteMeta {
    pub updated_at: Option<i64>,
    pub message: String,
    pub author: Option<String>,
    pub version: Option<String>,
}

pub enum Probe {
    /// The cursor is still valid; no listing needed.
    Unchanged,
    /// An immutable revision token to pin every subsequent fetch to.
    Changed { revision: String },
}

pub enum BulkHint {
    None,
    /// The source can hand over many files in one request.
    Archive { min_files: usize },
}

/// Object-safe by construction: `&self` everywhere, no generics, callbacks as
/// `&mut dyn FnMut`. Errors are `String` to match the rest of the codebase.
pub trait Source: Send + Sync {
    /// Stable identity, e.g. `github:dazedcat19/FMD2@master:lua`. Used to key
    /// cursors and snapshot generations.
    fn id(&self) -> String;

    /// Human label for the UI.
    fn label(&self) -> String;

    /// Cheap "did anything change?" probe. May update the cursor in place.
    fn probe(&self, cursor: &mut SourceCursor) -> Result<Probe, String>;

    /// Full listing at an immutable revision.
    fn list(&self, revision: &str) -> Result<Vec<RemoteEntry>, String>;

    /// Content id of bytes we hold locally. Must agree with what `list` reports.
    fn content_id(&self, bytes: &[u8]) -> String;

    /// One file, pinned to `revision`.
    fn fetch_one(&self, revision: &str, path: &str) -> Result<Vec<u8>, String>;

    /// Whether a bulk transport is worth trying, and from how many files on.
    fn bulk_hint(&self) -> BulkHint {
        BulkHint::None
    }

    /// Fetch many files at once. Returning `Err`, or a map missing some of
    /// `wanted`, is not fatal: the caller falls back to `fetch_one` per gap.
    fn fetch_bulk(
        &self,
        _revision: &str,
        _wanted: &HashSet<String>,
        _on_bytes: &mut dyn FnMut(u64, u64),
        _cancel: &dyn Fn() -> bool,
    ) -> Result<HashMap<String, Vec<u8>>, String> {
        Err("esta fuente no soporta descarga masiva".into())
    }

    /// Optional date/message enrichment. Empty map means "use disk mtime".
    fn metadata(
        &self,
        _revision: &str,
        _paths: &[String],
    ) -> Result<HashMap<String, RemoteMeta>, String> {
        Ok(HashMap::new())
    }

    /// Older versions the source can still serve, for revert.
    fn versions(&self, _path: &str) -> Vec<FileVersion> {
        Vec::new()
    }

    fn fetch_version(&self, _path: &str, _content_id: &str) -> Result<Vec<u8>, String> {
        Err("esta fuente no conserva versiones anteriores".into())
    }

    /// Upper bound on concurrent `fetch_one` calls this source tolerates.
    fn max_parallel(&self) -> usize {
        4
    }

    /// Remaining API budget observed on the last response, if the source has one.
    /// Reported instead of spent: no preflight request just to read a quota.
    fn rate_status(&self) -> (Option<i64>, Option<i64>) {
        (None, None)
    }
}

/// Build the configured source. Empty setting → the hardcoded GitHub default,
/// following the `catalog.db_url` precedent.
pub fn resolve() -> Result<Box<dyn Source>, String> {
    let kind = settings_keys::get_string_opt(settings_keys::MODULES_SOURCE)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "github".into());
    let url = settings_keys::get_string_opt(settings_keys::MODULES_SOURCE_URL)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    match kind.as_str() {
        "github" => Ok(Box::new(github::GithubSource::from_config())),
        "http_index" | "portal" => {
            let url = url.ok_or_else(|| {
                "Configura «modules.source_url» con la URL del índice del portal".to_string()
            })?;
            Ok(Box::new(http_index::HttpIndexSource::new(url)))
        }
        "local_dir" | "local" => {
            let dir = url.ok_or_else(|| {
                "Configura «modules.source_url» con la carpeta de origen".to_string()
            })?;
            Ok(Box::new(local_dir::LocalDirSource::new(dir)))
        }
        other => Err(format!("Fuente de módulos desconocida: «{other}»")),
    }
}
