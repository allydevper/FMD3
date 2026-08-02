//! Lua modules updater (FMD2 `frmLuaModulesUpdater` parity, rebuilt).
//!
//! Flow: `check` probes the configured [`source`], diffs it against what is on
//! disk and parks the resulting plan under a token; `apply` consumes that token
//! and downloads without touching the network first. State lives in
//! `userdata/lua.json`, change cursors in `userdata/lua_repo.json`, and undo
//! data in `userdata/lua_backup/`.

pub mod apply;
pub mod archive;
pub mod model;
pub mod plan;
pub mod progress;
pub mod session;
pub mod snapshot;
pub mod source;
pub mod state;

pub use model::{
    CheckReport, FileVersion, LuaRepoEntry, ModulesUpdateReport, RepoState, SyncPlan,
};
pub use progress::{request_cancel, reset_cancel, ModulesUpdateProgress, ProgressSink};
pub use snapshot::Generation;

use crate::lua_host::paths::lua_root;
use crate::lua_host::registry;
use model::FLAG_NONE;
use parking_lot::Mutex;
use source::{Probe, RemoteEntry, Source};
use state::{file_mtime_unix, load_cursor, load_state, save_cursor, save_state};
use std::fs;

/// One updater run at a time: `check` and `apply` both mutate `lua.json`.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> Result<parking_lot::MutexGuard<'static, ()>, String> {
    UPDATE_LOCK
        .try_lock()
        .ok_or_else(|| "Ya hay una revisión de módulos en curso".to_string())
}

/// Probe the source and build a plan, spending as little network as possible.
///
/// When the probe says nothing moved we still diff, but against the remote ids
/// already stored — that surfaces work left over from an interrupted apply
/// without asking the source for a listing it already told us is unchanged.
fn build_plan(source: &dyn Source, force: bool) -> Result<(SyncPlan, RepoState), String> {
    let source_id = source.id();
    let mut cursor = load_cursor(&source_id);
    let mut st = load_state();

    let probe = source.probe(&mut cursor)?;
    let (revision, remote) = match probe {
        Probe::Unchanged => {
            let revision = cursor.revision.clone();
            let remote: Vec<RemoteEntry> = st
                .entries
                .iter()
                .map(|e| RemoteEntry {
                    path: e.name.clone(),
                    content_id: e.remote_id.clone(),
                    size: None,
                })
                .collect();
            (revision, remote)
        }
        Probe::Changed { revision } => {
            let listing = source.list(&revision)?;
            (revision, listing)
        }
    };

    let plan = plan::build(&remote, &mut st, source, &revision, force);
    let _ = save_cursor(&source_id, &cursor);
    Ok((plan, st))
}

fn report_from(plan: &SyncPlan, token: Option<String>, source: &dyn Source) -> CheckReport {
    let (rate_remaining, rate_reset) = source.rate_status();
    CheckReport {
        found_updates: !plan.is_empty(),
        token,
        source_label: plan.source_label.clone(),
        revision: plan.revision.clone(),
        status_lines: plan.status_lines.clone(),
        new_count: plan.new_count,
        update_count: plan.update_count,
        delete_count: plan.delete_count,
        failed_count: plan.failed_count,
        suppressed_count: plan.suppressed_count,
        rate_remaining,
        rate_reset,
    }
}

/// Drop the change cursor when the app version moved.
///
/// A new build may ship a different idea of the tree, and the stored ETag would
/// happily answer "nothing changed" over the top of it. Cheap insurance: one
/// full listing on the first check after an upgrade.
fn reset_cursor_on_new_app_version(source_id: &str) {
    const KEY: &str = "modules.updater.app_version";
    let current = env!("CARGO_PKG_VERSION");
    let seen = crate::db::settings_get_direct(KEY).ok().flatten();
    if seen.as_deref() == Some(current) {
        return;
    }
    if seen.is_some() {
        let _ = save_cursor(source_id, &state::SourceCursor::default());
    }
    let _ = crate::db::settings_set_direct(KEY, current);
}

/// Look for changes. `force` (an explicit user action) ignores dismissals and
/// retry backoff so "Revisar actualización" always reports the truth.
pub fn check(force: bool) -> Result<CheckReport, String> {
    let _guard = lock()?;
    let source = source::resolve()?;
    reset_cursor_on_new_app_version(&source.id());
    let (plan, st) = build_plan(source.as_ref(), force)?;
    save_state(&st)?;

    if plan.is_empty() {
        session::clear();
        return Ok(report_from(&plan, None, source.as_ref()));
    }
    let token = session::put(plan.clone());
    Ok(report_from(&plan, Some(token), source.as_ref()))
}

/// Download and write the changes for the plan behind `token`.
///
/// A valid token is mandatory. It is the only proof that a human saw this exact
/// set of changes and agreed to it — if `apply` could build its own plan, any
/// caller (including a background pass that is supposed to be read-only) could
/// overwrite the whole Lua tree without anyone confirming.
pub fn apply(
    token: Option<String>,
    sink: Option<ProgressSink<'_>>,
) -> Result<ModulesUpdateReport, String> {
    let _guard = lock()?;
    // Checked before anything else: a call with no plan must not resolve a
    // source, open the database or touch the network.
    let Some(plan) = session::take(token.as_deref()) else {
        return Err(
            "La actualización caducó o no fue confirmada; vuelve a pulsar «Revisar actualización»."
                .into(),
        );
    };
    progress::reset_cancel();
    let emitter = progress::Emitter::new(sink);
    let source = source::resolve()?;

    emitter.phase("probe", "Preparando actualización…");
    let mut st = load_state();
    session::clear();

    if plan.is_empty() {
        save_state(&st)?;
        emitter.phase("done", "Sin cambios");
        return Ok(ModulesUpdateReport::default());
    }

    let outcome = apply::execute(source.as_ref(), &plan, &mut st, &emitter);

    emitter.phase("registry", "Recargando módulos…");
    let refreshed = registry::refresh();

    let report = ModulesUpdateReport {
        applied: outcome.downloaded + outcome.deleted > 0,
        cancelled: outcome.cancelled,
        transport: outcome.transport,
        downloaded: outcome.downloaded,
        deleted: outcome.deleted,
        failed: outcome.failed,
        refreshed_count: refreshed,
        generation_id: outcome.generation_id,
        status_lines: outcome.status_lines,
    };
    emitter.send(ModulesUpdateProgress {
        phase: "done".into(),
        files_done: report.downloaded,
        files_total: report.downloaded + report.failed,
        failed: report.failed,
        message: if report.cancelled {
            "Actualización cancelada".into()
        } else {
            format!("{} archivos actualizados", report.downloaded)
        },
        ..Default::default()
    });
    Ok(report)
}

/// Silence the pending changes until the source moves on.
pub fn dismiss(token: Option<String>) -> Result<(), String> {
    let _guard = lock()?;
    let Some(plan) = token.as_deref().and_then(session::peek) else {
        session::clear();
        return Ok(());
    };
    let mut st = load_state();
    plan::dismiss(&mut st, &plan);
    save_state(&st)?;
    session::clear();
    Ok(())
}

/// Rows for the Modules tab. Falls back to scanning `modules/` so the tab is
/// not empty before the first sync.
pub fn list_for_ui() -> Vec<LuaRepoEntry> {
    let st = load_state();
    if !st.entries.is_empty() {
        return st.entries;
    }
    let dir = lua_root().join("modules");
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut entries: Vec<LuaRepoEntry> = rd
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("lua"))
        .map(|e| {
            let path = e.path();
            let name = format!(
                "modules/{}",
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("desconocido.lua")
            );
            let mut entry = LuaRepoEntry::seeded(name, String::new(), None);
            entry.last_modified = file_mtime_unix(&path);
            entry.flag = FLAG_NONE.into();
            entry
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/* ---------------------------------------------------------------------- */
/* Undo / revert                                                           */
/* ---------------------------------------------------------------------- */

/// What the row should show given the bytes now on disk.
fn flag_for(entry: &LuaRepoEntry) -> &'static str {
    if entry.remote_id.is_empty() || entry.is_current() {
        FLAG_NONE
    } else if entry.local_id.is_none() {
        model::FLAG_NEW
    } else {
        model::FLAG_UPDATE
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UndoReport {
    pub restored: usize,
    pub removed: usize,
    pub failed: Vec<String>,
    pub refreshed_count: usize,
}

/// Roll a whole apply back. `None` targets the most recent one.
pub fn undo_generation(id: Option<String>) -> Result<UndoReport, String> {
    let _guard = lock()?;
    let id = match id {
        Some(v) => v,
        None => snapshot::last_undoable()
            .ok_or_else(|| "No hay ninguna actualización que deshacer".to_string())?,
    };
    let outcome = snapshot::undo_generation(&id)?;

    // Restored bytes no longer match the remote, so the flag has to say so
    // right away — otherwise the tab reads "al día" until the next check.
    let mut st = load_state();
    for (path, restored_id) in &outcome.paths {
        let Some(entry) = st.get_mut(path) else {
            continue;
        };
        entry.local_id = restored_id.clone();
        entry.flag = flag_for(entry).into();
        entry.clear_failure();
    }
    save_state(&st)?;
    let refreshed = registry::refresh();

    Ok(UndoReport {
        restored: outcome.restored,
        removed: outcome.removed,
        failed: outcome.failed,
        refreshed_count: refreshed,
    })
}

/// Versions of one file that can still be restored: local snapshots first,
/// then anything the source itself keeps.
pub fn history(path: String) -> Vec<FileVersion> {
    let mut out = snapshot::versions_of(&path);
    if let Ok(source) = source::resolve() {
        let known: std::collections::HashSet<String> =
            out.iter().map(|v| v.content_id.clone()).collect();
        for v in source.versions(&path) {
            if !known.contains(&v.content_id) {
                out.push(v);
            }
        }
    }
    out
}

/// Put one file back to a specific version.
pub fn revert_file(path: String, content_id: String) -> Result<UndoReport, String> {
    let _guard = lock()?;
    let bytes = match snapshot::read_blob(&content_id) {
        Some(b) => b,
        None => {
            let source = source::resolve()?;
            source.fetch_version(&path, &content_id)?
        }
    };
    snapshot::restore_file(&path, &bytes, "revertir archivo", &content_id)?;

    let mut st = load_state();
    if let Some(entry) = st.get_mut(&path) {
        entry.local_id = Some(content_id);
        entry.flag = flag_for(entry).into();
        entry.clear_failure();
    }
    save_state(&st)?;
    let refreshed = registry::refresh();

    Ok(UndoReport {
        restored: 1,
        removed: 0,
        failed: Vec::new(),
        refreshed_count: refreshed,
    })
}

pub fn generations() -> Vec<Generation> {
    snapshot::generations()
}

/// Forget the change cursor for the configured source. Needed after switching
/// sources: a portal's sha256 ids mean nothing to a cursor recorded against
/// GitHub blob shas, and the stored ETag would wrongly answer "unchanged".
pub fn reset_cursor() -> Result<(), String> {
    let source = source::resolve()?;
    session::clear();
    save_cursor(&source.id(), &state::SourceCursor::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_plan() -> SyncPlan {
        SyncPlan {
            source_id: "test".into(),
            source_label: "test".into(),
            revision: "r1".into(),
            items: Vec::new(),
            status_lines: Vec::new(),
            new_count: 0,
            update_count: 0,
            delete_count: 0,
            failed_count: 0,
            suppressed_count: 0,
        }
    }

    /// The whole point of the token: without one, `apply` writes nothing. This
    /// is what stops a background pass from overwriting the Lua tree.
    #[test]
    fn apply_refuses_without_a_confirmed_plan() {
        session::clear();
        let err = apply(None, None).unwrap_err();
        assert!(err.contains("caducó"), "mensaje inesperado: {err}");

        let err = apply(Some("no-existe".into()), None).unwrap_err();
        assert!(err.contains("caducó"), "mensaje inesperado: {err}");
    }

    #[test]
    fn a_foreign_token_does_not_consume_the_plan() {
        session::clear();
        let token = session::put(dummy_plan());
        assert!(session::take(Some("otro")).is_none());
        // The rightful owner can still claim it.
        assert!(session::take(Some(&token)).is_some());
        // And only once.
        assert!(session::take(Some(&token)).is_none());
        session::clear();
    }
}
