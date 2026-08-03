//! Executes a [`SyncPlan`]: choose a transport, back up, write, persist.
//!
//! Two rules drive the shape of this file:
//! * a failure on one file must never discard the work done on the others, so
//!   nothing here propagates with `?` once the loop has started;
//! * every write is preceded by a backup, so any apply can be undone.

use super::model::{ChangeKind, PlanItem, RepoState, SyncPlan, FLAG_FAILED, FLAG_NONE};
use super::progress::{is_cancelled, Emitter, ModulesUpdateProgress};
use super::snapshot::{self, GenBuilder};
use super::source::{BulkHint, Source};
use super::state::{now_unix, safe_rel_path, save_state, write_atomic};
use crate::lua_host::paths::lua_root;
use crate::settings_keys;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Persist `lua.json` at least this often so a crash cannot cost more than a
/// handful of downloads.
const SAVE_EVERY: usize = 32;

#[derive(Debug, Default)]
pub struct ApplyOutcome {
    pub downloaded: usize,
    pub deleted: usize,
    pub failed: usize,
    pub transport: String,
    pub cancelled: bool,
    pub generation_id: Option<String>,
    pub status_lines: Vec<String>,
}

enum ItemOutcome {
    Done(String),
    Failed,
}

/// Validate, back up and write one file. The content id is verified against
/// what the plan promised: a mirror serving different bytes than the listing
/// advertised is a failure, not a silently recorded wrong hash.
fn commit_bytes(
    gen: &GenBuilder,
    item: &PlanItem,
    source: &dyn Source,
    bytes: &[u8],
) -> Result<String, String> {
    let path = safe_rel_path(&item.path)?;
    let got = source.content_id(bytes);
    if !item.expected_id.is_empty() && got != item.expected_id {
        return Err("contenido inesperado (el hash no coincide)".into());
    }
    let before = gen.backup(&item.path)?;
    write_atomic(&path, bytes)?;
    gen.record(&item.path, before, Some(got.clone()));
    Ok(got)
}

fn apply_outcome(state: &Mutex<&mut RepoState>, path: &str, outcome: &ItemOutcome) {
    let mut guard = state.lock();
    let Some(entry) = guard.get_mut(path) else {
        return;
    };
    match outcome {
        ItemOutcome::Done(id) => {
            entry.local_id = Some(id.clone());
            entry.remote_id = id.clone();
            entry.flag = FLAG_NONE.into();
            entry.last_modified = Some(now_unix());
            entry.clear_failure();
        }
        ItemOutcome::Failed => {
            entry.flag = FLAG_FAILED.into();
            entry.attempts = entry.attempts.saturating_add(1);
            entry.last_attempt = Some(now_unix());
        }
    }
}

fn maybe_save(state: &Mutex<&mut RepoState>, since: &AtomicUsize) {
    if since.fetch_add(1, Ordering::SeqCst) + 1 < SAVE_EVERY {
        return;
    }
    since.store(0, Ordering::SeqCst);
    let guard = state.lock();
    if let Err(e) = save_state(&guard) {
        eprintln!("modules_updater: {e}");
    }
}

pub fn execute(
    source: &dyn Source,
    plan: &SyncPlan,
    state: &mut RepoState,
    emitter: &Emitter,
) -> ApplyOutcome {
    let mut out = ApplyOutcome::default();
    if let Err(e) = fs::create_dir_all(lua_root()) {
        out.status_lines
            .push(format!("No se pudo crear el árbol lua: {e}"));
        out.failed = plan.items.len();
        return out;
    }

    let gen = snapshot::begin(&plan.source_id, &plan.revision, "actualización de módulos");

    /* ---------------- deletes ---------------- */

    let deletes: Vec<&PlanItem> = plan
        .items
        .iter()
        .filter(|i| i.kind == ChangeKind::Delete)
        .collect();
    if !deletes.is_empty() {
        emitter.phase("delete", &format!("Eliminando {} archivos…", deletes.len()));
    }
    let mut removed_paths: Vec<String> = Vec::new();
    for item in deletes {
        if is_cancelled() {
            out.cancelled = true;
            break;
        }
        let Ok(path) = safe_rel_path(&item.path) else {
            out.failed += 1;
            continue;
        };
        let before = match gen.backup(&item.path) {
            Ok(v) => v,
            Err(e) => {
                // Cannot back it up, so do not remove it.
                out.failed += 1;
                out.status_lines.push(format!("{}: {e}", item.path));
                continue;
            }
        };
        if path.is_file() {
            if let Err(e) = fs::remove_file(&path) {
                out.failed += 1;
                out.status_lines.push(format!("{}: {e}", item.path));
                continue;
            }
        }
        gen.record(&item.path, before, None);
        removed_paths.push(item.path.clone());
        out.deleted += 1;
    }
    if !removed_paths.is_empty() {
        let drop: HashSet<&str> = removed_paths.iter().map(|s| s.as_str()).collect();
        state.entries.retain(|e| !drop.contains(e.name.as_str()));
    }

    /* ---------------- downloads ---------------- */

    let downloads: Vec<&PlanItem> = plan
        .items
        .iter()
        .filter(|i| i.kind != ChangeKind::Delete)
        .collect();
    let total = downloads.len();
    if total == 0 || out.cancelled {
        out.cancelled = out.cancelled || is_cancelled();
        let _ = save_state(state);
        out.generation_id = gen.commit();
        return out;
    }

    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let since_save = AtomicUsize::new(0);
    let shared = Mutex::new(state);
    let mut pending: Vec<&PlanItem> = downloads.clone();

    // Bulk first: for a large delta one archive replaces hundreds of requests.
    let threshold = settings_keys::usize_setting(settings_keys::MODULES_BULK_THRESHOLD, 50);
    let use_bulk = match source.bulk_hint() {
        BulkHint::Archive { min_files } => total >= min_files.max(threshold),
        BulkHint::None => false,
    };

    if use_bulk {
        out.transport = "zip".into();
        emitter.send(ModulesUpdateProgress {
            phase: "archive".into(),
            transport: "zip".into(),
            files_total: total,
            message: format!("Descargando paquete con {total} archivos…"),
            ..Default::default()
        });
        let wanted: HashSet<String> = downloads.iter().map(|i| i.path.clone()).collect();
        let mut on_bytes = |bytes_done: u64, bytes_total: u64| {
            emitter.send(ModulesUpdateProgress {
                phase: "archive".into(),
                transport: "zip".into(),
                files_total: total,
                bytes_done,
                bytes_total,
                message: "Descargando paquete…".into(),
                ..Default::default()
            });
        };
        match source.fetch_bulk(&plan.revision, &wanted, &mut on_bytes, &is_cancelled) {
            Ok(map) => {
                emitter.phase("download", "Escribiendo archivos del paquete…");
                let mut leftovers = Vec::new();
                for item in &downloads {
                    if is_cancelled() {
                        out.cancelled = true;
                        break;
                    }
                    let Some(bytes) = map.get(&item.path) else {
                        // Missing from the archive: fall back to a single fetch.
                        leftovers.push(*item);
                        continue;
                    };
                    let outcome = match commit_bytes(&gen, item, source, bytes) {
                        Ok(id) => ItemOutcome::Done(id),
                        Err(e) => {
                            out.status_lines.push(format!("{}: {e}", item.path));
                            failed.fetch_add(1, Ordering::SeqCst);
                            ItemOutcome::Failed
                        }
                    };
                    apply_outcome(&shared, &item.path, &outcome);
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    maybe_save(&shared, &since_save);
                    emitter.send(ModulesUpdateProgress {
                        phase: "download".into(),
                        transport: "zip".into(),
                        files_done: n,
                        files_total: total,
                        current: item.path.clone(),
                        failed: failed.load(Ordering::SeqCst),
                        ..Default::default()
                    });
                }
                pending = leftovers;
                if !pending.is_empty() {
                    out.transport = "zip+raw".into();
                }
            }
            Err(e) => {
                if e == super::progress::MODULES_CANCELLED {
                    out.cancelled = true;
                    pending.clear();
                } else {
                    eprintln!("modules_updater: paquete no disponible ({e}); descarga individual");
                    out.status_lines
                        .push(format!("Paquete no disponible ({e}); se descarga archivo a archivo"));
                    out.transport = "raw".into();
                }
            }
        }
    } else {
        out.transport = "raw".into();
    }

    /* ---------------- per-file downloads ---------------- */

    if !pending.is_empty() && !out.cancelled {
        let workers = settings_keys::usize_setting(settings_keys::MODULES_THREADS, 4)
            .clamp(1, source.max_parallel().min(8))
            .min(pending.len());
        let next = AtomicUsize::new(0);
        let lines = Mutex::new(Vec::<String>::new());
        let items = &pending;

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    if is_cancelled() {
                        break;
                    }
                    let idx = next.fetch_add(1, Ordering::SeqCst);
                    let Some(item) = items.get(idx) else { break };
                    let outcome = match source.fetch_one(&plan.revision, &item.path) {
                        Ok(bytes) => match commit_bytes(&gen, item, source, &bytes) {
                            Ok(id) => ItemOutcome::Done(id),
                            Err(e) => {
                                lines.lock().push(format!("{}: {e}", item.path));
                                failed.fetch_add(1, Ordering::SeqCst);
                                ItemOutcome::Failed
                            }
                        },
                        Err(e) => {
                            lines.lock().push(format!("{}: {e}", item.path));
                            failed.fetch_add(1, Ordering::SeqCst);
                            ItemOutcome::Failed
                        }
                    };
                    apply_outcome(&shared, &item.path, &outcome);
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    maybe_save(&shared, &since_save);
                    emitter.send(ModulesUpdateProgress {
                        phase: "download".into(),
                        transport: "raw".into(),
                        files_done: n,
                        files_total: total,
                        current: item.path.clone(),
                        failed: failed.load(Ordering::SeqCst),
                        ..Default::default()
                    });
                });
            }
        });

        out.status_lines.extend(lines.into_inner());
    }

    out.cancelled = out.cancelled || is_cancelled();
    out.failed += failed.load(Ordering::SeqCst);
    out.downloaded = done.load(Ordering::SeqCst) - failed.load(Ordering::SeqCst);

    /* ---------------- metadata + persist ---------------- */

    let state = shared.into_inner();
    if !out.cancelled && settings_keys::bool_setting(settings_keys::MODULES_FETCH_METADATA, true) {
        let paths: Vec<String> = downloads.iter().map(|i| i.path.clone()).collect();
        emitter.phase("metadata", "Consultando información de los cambios…");
        match source.metadata(&plan.revision, &paths) {
            Ok(map) if !map.is_empty() => enrich(state, &map),
            Ok(_) => {}
            Err(e) => eprintln!("modules_updater: metadatos no disponibles: {e}"),
        }
    }

    emitter.phase("persist", "Guardando estado…");
    if let Err(e) = save_state(state) {
        out.status_lines.push(e);
    }
    out.generation_id = gen.commit();
    out
}

fn enrich(state: &mut RepoState, meta: &HashMap<String, super::source::RemoteMeta>) {
    for entry in state.entries.iter_mut() {
        let Some(m) = meta.get(&entry.name) else {
            continue;
        };
        if !m.message.is_empty() {
            entry.last_message = m.message.clone();
        }
        if m.updated_at.is_some() {
            entry.last_modified = m.updated_at;
        }
        if m.author.is_some() {
            entry.author = m.author.clone();
        }
        if m.version.is_some() {
            entry.version = m.version.clone();
        }
    }
}
