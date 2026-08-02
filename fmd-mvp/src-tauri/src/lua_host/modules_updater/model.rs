//! Pure data for the Lua modules updater. No IO lives here.

use serde::{Deserialize, Serialize};

pub const FLAG_NONE: &str = "none";
pub const FLAG_NEW: &str = "new";
pub const FLAG_UPDATE: &str = "update";
pub const FLAG_DELETE: &str = "delete";
pub const FLAG_FAILED: &str = "failed";

/// Retry schedule for entries whose download failed, saturating at the last step.
pub const BACKOFF_SECS: [i64; 5] = [300, 1_800, 7_200, 43_200, 86_400];
/// Past this many attempts an entry is only retried on an explicit user check.
pub const MAX_ATTEMPTS: u32 = 8;

pub const STATE_SCHEMA: u32 = 2;

/// One tracked file of the Lua tree. Persisted in `userdata/lua.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LuaRepoEntry {
    /// Path relative to the Lua root, forward slashes.
    pub name: String,
    /// Content id last advertised by the source. Opaque: a git blob sha for
    /// GitHub, a sha256 for the portal. `sha` is the v1 wire name.
    #[serde(alias = "sha")]
    pub remote_id: String,
    /// Content id of the bytes actually on disk; `None` when the file is absent.
    #[serde(default)]
    pub local_id: Option<String>,
    #[serde(default)]
    pub last_modified: Option<i64>,
    #[serde(default)]
    pub last_message: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default = "default_flag")]
    pub flag: String,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_attempt: Option<i64>,
}

pub fn default_flag() -> String {
    FLAG_NONE.into()
}

impl LuaRepoEntry {
    pub fn seeded(name: String, remote_id: String, local_id: Option<String>) -> Self {
        Self {
            name,
            remote_id,
            local_id,
            last_modified: None,
            last_message: String::new(),
            author: None,
            version: None,
            flag: default_flag(),
            attempts: 0,
            last_attempt: None,
        }
    }

    /// In sync when the bytes on disk carry the content id the source advertises.
    pub fn is_current(&self) -> bool {
        self.local_id.as_deref() == Some(self.remote_id.as_str())
    }

    /// Failed entries back off, which is what keeps a permanently broken file
    /// from re-announcing itself on every launch. Declining an update is *not*
    /// recorded: a toast that shows up once per launch is a reminder, not a
    /// nag, and silencing it for good only made the app look broken.
    pub fn retry_due(&self, now: i64) -> bool {
        if self.attempts == 0 {
            return true;
        }
        if self.attempts >= MAX_ATTEMPTS {
            return false;
        }
        let idx = (self.attempts as usize - 1).min(BACKOFF_SECS.len() - 1);
        match self.last_attempt {
            Some(t) => now >= t.saturating_add(BACKOFF_SECS[idx]),
            None => true,
        }
    }

    pub fn clear_failure(&mut self) {
        self.attempts = 0;
        self.last_attempt = None;
    }
}

/// Whole persisted state of `userdata/lua.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoState {
    #[serde(default)]
    pub schema: u32,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub entries: Vec<LuaRepoEntry>,
}

impl Default for RepoState {
    fn default() -> Self {
        Self {
            schema: STATE_SCHEMA,
            source_id: String::new(),
            entries: Vec::new(),
        }
    }
}

impl RepoState {
    pub fn get_mut(&mut self, name: &str) -> Option<&mut LuaRepoEntry> {
        self.entries.iter_mut().find(|e| e.name == name)
    }

    pub fn sort(&mut self) {
        self.entries.sort_by(|a, b| a.name.cmp(&b.name));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    New,
    Update,
    Delete,
}

impl ChangeKind {
    pub fn flag(self) -> &'static str {
        match self {
            ChangeKind::New => FLAG_NEW,
            ChangeKind::Update => FLAG_UPDATE,
            ChangeKind::Delete => FLAG_DELETE,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanItem {
    pub path: String,
    pub kind: ChangeKind,
    /// Content id the source promises; empty for deletes.
    pub expected_id: String,
    pub size: Option<u64>,
}

/// An actionable diff pinned to one immutable revision. Cached between
/// `check` and `apply` so confirming costs no extra network round trip.
#[derive(Debug, Clone)]
pub struct SyncPlan {
    pub source_id: String,
    pub source_label: String,
    pub revision: String,
    pub items: Vec<PlanItem>,
    pub status_lines: Vec<String>,
    pub new_count: usize,
    pub update_count: usize,
    pub delete_count: usize,
    pub failed_count: usize,
    /// Changes held back by a dismiss or a retry backoff.
    pub suppressed_count: usize,
}

impl SyncPlan {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn download_count(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.kind != ChangeKind::Delete)
            .count()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckReport {
    pub found_updates: bool,
    /// Handoff token for `apply`; `None` when there is nothing to do.
    pub token: Option<String>,
    pub source_label: String,
    pub revision: String,
    pub status_lines: Vec<String>,
    pub new_count: usize,
    pub update_count: usize,
    pub delete_count: usize,
    pub failed_count: usize,
    pub suppressed_count: usize,
    pub rate_remaining: Option<i64>,
    pub rate_reset: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ModulesUpdateReport {
    pub applied: bool,
    pub cancelled: bool,
    /// "zip" | "raw" | "" when nothing was downloaded.
    pub transport: String,
    pub downloaded: usize,
    pub deleted: usize,
    pub failed: usize,
    pub refreshed_count: usize,
    /// Snapshot generation that can undo this apply.
    pub generation_id: Option<String>,
    pub status_lines: Vec<String>,
}

/// One restorable version of a file, from a local snapshot or the source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileVersion {
    pub content_id: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub message: String,
    /// "backup" (local blob) | "remote" (re-fetchable from the source).
    pub origin: String,
}
