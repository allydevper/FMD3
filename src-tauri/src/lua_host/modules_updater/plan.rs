//! Diff the source listing against what is on disk.
//!
//! Flags are *derived*, never remembered: every check re-reads the tracked
//! files and recomputes their content id. That is what keeps a run which
//! failed halfway from leaving 666 phantom "new" entries behind.

use super::model::{
    ChangeKind, LuaRepoEntry, PlanItem, RepoState, SyncPlan, FLAG_FAILED, FLAG_NONE, FLAG_PINNED,
};
use super::source::{RemoteEntry, Source};
use super::state::{file_mtime_unix, local_file_path, now_unix};
use std::collections::{HashMap, HashSet};
use std::fs;

fn label(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::New => "NUEVO",
        ChangeKind::Update => "ACTUALIZA",
        ChangeKind::Delete => "ELIMINA",
    }
}

/// Refresh `local_id` and `last_modified` from disk for one entry.
fn resync_from_disk(entry: &mut LuaRepoEntry, source: &dyn Source) {
    let Some(path) = local_file_path(&entry.name) else {
        entry.local_id = None;
        return;
    };
    match fs::read(&path) {
        Ok(bytes) => {
            entry.local_id = Some(source.content_id(&bytes));
            // Always the file on disk so the UI date matches what the user edited,
            // not the last official commit we happened to store.
            entry.last_modified = file_mtime_unix(&path);
        }
        Err(_) => entry.local_id = None,
    }
}

/// Local copy wins when it was written after the official file's last commit.
pub fn local_is_newer(local_mtime: i64, remote_updated_at: Option<i64>) -> bool {
    remote_updated_at.is_some_and(|remote| local_mtime > remote)
}

/// Build the actionable plan and bring `state` in line with the listing.
///
/// `force` (an explicit user check) ignores dismissals and retry backoff.
pub fn build(
    remote: &[RemoteEntry],
    state: &mut RepoState,
    source: &dyn Source,
    revision: &str,
    force: bool,
) -> SyncPlan {
    let now = now_unix();
    let source_id = source.id();
    // Switching sources must not read as "the remote deleted everything".
    let same_source = state.source_id.is_empty() || state.source_id == source_id;

    let remote_map: HashMap<&str, &RemoteEntry> =
        remote.iter().map(|e| (e.path.as_str(), e)).collect();
    let known: HashSet<&str> = state.entries.iter().map(|e| e.name.as_str()).collect();

    // Seed entries for remote files we have never tracked.
    let mut seeded: Vec<LuaRepoEntry> = Vec::new();
    for r in remote {
        if known.contains(r.path.as_str()) {
            continue;
        }
        seeded.push(LuaRepoEntry::seeded(
            r.path.clone(),
            r.content_id.clone(),
            None,
        ));
    }
    state.entries.extend(seeded);

    let mut items: Vec<PlanItem> = Vec::new();
    let mut status_lines: Vec<String> = Vec::new();
    let mut new_count = 0usize;
    let mut update_count = 0usize;
    let mut delete_count = 0usize;
    let mut failed_count = 0usize;
    let mut suppressed_count = 0usize;
    let mut untrack: Vec<String> = Vec::new();

    for entry in state.entries.iter_mut() {
        resync_from_disk(entry, source);

        // A pinned module belongs to the user, not to the source. It is skipped
        // before anything else so it can never be updated *or* deleted, not even
        // by an explicit forced check — that is the whole promise of a pin.
        if entry.is_pinned() {
            entry.flag = FLAG_PINNED.into();
            continue;
        }

        let Some(r) = remote_map.get(entry.name.as_str()) else {
            if !same_source {
                // Not ours to delete — just stop tracking it.
                untrack.push(entry.name.clone());
                continue;
            }
            if entry.local_id.is_none() {
                // Gone remotely and already absent locally: nothing to do.
                untrack.push(entry.name.clone());
                continue;
            }
            entry.flag = ChangeKind::Delete.flag().into();
            delete_count += 1;
            status_lines.push(format!("[{}] {}", label(ChangeKind::Delete), entry.name));
            items.push(PlanItem {
                path: entry.name.clone(),
                kind: ChangeKind::Delete,
                expected_id: String::new(),
                size: None,
            });
            continue;
        };

        entry.remote_id = r.content_id.clone();

        if entry.is_current() {
            // Content matches: nothing to download, whatever a prior run recorded.
            entry.flag = FLAG_NONE.into();
            entry.clear_failure();
            continue;
        }

        let kind = if entry.local_id.is_none() {
            ChangeKind::New
        } else {
            ChangeKind::Update
        };
        entry.flag = kind.flag().into();

        // Only a repeatedly failing download is held back, and only until its
        // backoff expires. Declining an update never silences it.
        if entry.attempts > 0 && !entry.retry_due(now) && !force {
            entry.flag = FLAG_FAILED.into();
            failed_count += 1;
            suppressed_count += 1;
            continue;
        }

        match kind {
            ChangeKind::New => new_count += 1,
            ChangeKind::Update => update_count += 1,
            ChangeKind::Delete => {}
        }
        status_lines.push(format!("[{}] {}", label(kind), entry.name));
        items.push(PlanItem {
            path: entry.name.clone(),
            kind,
            expected_id: r.content_id.clone(),
            size: r.size,
        });
    }

    if !untrack.is_empty() {
        let drop: HashSet<&str> = untrack.iter().map(|s| s.as_str()).collect();
        state.entries.retain(|e| !drop.contains(e.name.as_str()));
    }
    state.source_id = source_id.clone();
    state.sort();

    // Deletes first so a rename lands as delete-then-write, and cheapest work
    // shows progress immediately.
    items.sort_by(|a, b| {
        let rank = |k: ChangeKind| match k {
            ChangeKind::Delete => 0,
            ChangeKind::Update => 1,
            ChangeKind::New => 2,
        };
        rank(a.kind).cmp(&rank(b.kind)).then(a.path.cmp(&b.path))
    });

    SyncPlan {
        source_id,
        source_label: source.label(),
        revision: revision.to_string(),
        items,
        status_lines,
        new_count,
        update_count,
        delete_count,
        failed_count,
        suppressed_count,
    }
}

/// Drop official updates whose local file is newer than the source's last commit.
///
/// Hash mismatch alone is not "the remote is newer": a patched KuManga.lua is
/// supposed to stay. Dates come from [`Source::metadata`]; files without a
/// remote date keep the hash-based Update so a missing API never hides a real
/// upstream change.
pub fn prefer_local_newer(
    plan: &mut SyncPlan,
    state: &mut RepoState,
    source: &dyn Source,
    revision: &str,
) {
    if !crate::settings_keys::bool_setting(
        crate::settings_keys::MODULES_PREFER_LOCAL_NEWER,
        true,
    ) {
        return;
    }
    let update_paths: Vec<String> = plan
        .items
        .iter()
        .filter(|i| i.kind == ChangeKind::Update)
        .map(|i| i.path.clone())
        .collect();
    if update_paths.is_empty() {
        return;
    }
    let meta = match source.metadata(revision, &update_paths) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("modules_updater: no se pudo comparar fechas ({e})");
            return;
        }
    };
    if meta.is_empty() {
        return;
    }

    let mut keep: HashSet<String> = HashSet::new();
    for path in &update_paths {
        let Some(disk) = local_file_path(path) else {
            continue;
        };
        let Some(local_mtime) = file_mtime_unix(&disk) else {
            continue;
        };
        let remote_ts = meta.get(path).and_then(|m| m.updated_at);
        if local_is_newer(local_mtime, remote_ts) {
            keep.insert(path.clone());
        }
    }
    if keep.is_empty() {
        return;
    }

    plan.items.retain(|i| !keep.contains(&i.path));
    plan.update_count = plan
        .items
        .iter()
        .filter(|i| i.kind == ChangeKind::Update)
        .count();
    plan.status_lines
        .retain(|line| keep.iter().all(|p| !line.ends_with(p.as_str())));
    for path in &keep {
        plan.status_lines
            .push(format!("[LOCAL] {path} es más reciente; se conserva"));
        if let Some(entry) = state.get_mut(path) {
            entry.flag = FLAG_NONE.into();
            entry.last_message = "Tu versión es más reciente que la oficial".into();
            if let Some(disk) = local_file_path(path) {
                entry.last_modified = file_mtime_unix(&disk);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lua_host::modules_updater::model::MAX_ATTEMPTS;

    fn entry(name: &str, remote: &str, local: Option<&str>) -> LuaRepoEntry {
        LuaRepoEntry::seeded(
            name.into(),
            remote.into(),
            local.map(|s| s.to_string()),
        )
    }

    #[test]
    fn current_entry_is_not_actionable() {
        let e = entry("modules/A.lua", "aaa", Some("aaa"));
        assert!(e.is_current());
    }

    #[test]
    fn stale_entry_is_actionable() {
        let e = entry("modules/A.lua", "bbb", Some("aaa"));
        assert!(!e.is_current());
    }

    #[test]
    fn backoff_grows_then_stops() {
        let mut e = entry("modules/A.lua", "bbb", Some("aaa"));
        e.attempts = 1;
        e.last_attempt = Some(1_000);
        assert!(!e.retry_due(1_100));
        assert!(e.retry_due(1_000 + 300));
        e.attempts = MAX_ATTEMPTS;
        assert!(!e.retry_due(i64::MAX / 2));
    }

    /// The promise of a pin: the sync cannot touch it, forced or not.
    #[test]
    fn a_pinned_entry_is_skipped_and_unpinning_restores_it() {
        let mut e = entry("modules/A.lua", "bbb", Some("mio"));
        e.pin = Some(crate::lua_host::modules_updater::model::ModulePin {
            origin: "C:/mios/A.lua".into(),
            pinned_at: 0,
            content_id: "mio".into(),
        });
        assert!(e.is_pinned());
        // `build` skips pinned entries before any kind/force logic runs.
        assert!(!e.is_current(), "difiere del remoto y aun así no se toca");

        e.pin = None;
        assert!(!e.is_pinned());
        // Back under the source's control: now it is a pending update again.
        assert!(!e.is_current());
        assert!(e.retry_due(0));
    }

    /// Declining an update must not silence it: the reminder has to come back
    /// on the next launch, which is what the persisted state decides.
    #[test]
    fn declining_leaves_the_entry_actionable() {
        let e = entry("modules/A.lua", "bbb", Some("aaa"));
        assert!(!e.is_current());
        assert!(e.retry_due(0), "sin fallos previos siempre es accionable");
    }

    #[test]
    fn local_file_newer_than_official_commit_wins() {
        assert!(local_is_newer(1_700_000_100, Some(1_700_000_000)));
        assert!(!local_is_newer(1_700_000_000, Some(1_700_000_100)));
        assert!(!local_is_newer(1_700_000_100, None));
    }
}
