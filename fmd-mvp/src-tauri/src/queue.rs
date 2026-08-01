use crate::db::{self, Db, QueueItem};
use crate::lua_host::{self, download_chapter};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone)]
pub struct QueueState {
    pub db: Db,
    pub favorites: Db,
    /// `userdata/downloaded.db` — the "already downloaded" marks, append-only.
    pub downloaded: Db,
    running: Arc<AtomicBool>,
    /// Per-item cancel flags for in-flight `process_item` jobs.
    cancels: Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>,
    /// Number of items currently being processed (for parallel workers).
    active: Arc<AtomicUsize>,
    /// Wake the worker to refill slots (e.g. after queue_add while already running).
    wake_tx: Arc<Mutex<Option<UnboundedSender<()>>>>,
}

impl QueueState {
    pub fn new(db: Db, favorites: Db, downloaded: Db) -> Self {
        Self {
            db,
            favorites,
            downloaded,
            running: Arc::new(AtomicBool::new(false)),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            active: Arc::new(AtomicUsize::new(0)),
            wake_tx: Arc::new(Mutex::new(None)),
        }
    }

    fn register_cancel(&self, id: i64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(id, flag.clone());
        }
        flag
    }

    fn unregister_cancel(&self, id: i64) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(&id);
        }
    }

    fn wake(&self) {
        if let Ok(guard) = self.wake_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }
}

#[derive(Clone, Serialize)]
pub struct QueueProgressEvent {
    pub item_id: i64,
    pub manga_title: String,
    pub chapter_name: String,
    pub message: String,
    pub pending_left: i64,
    pub page_current: u32,
    pub page_total: u32,
    /// "download" mientras se bajan páginas, "processing" durante el empaquetado.
    pub phase: String,
    #[serde(default)]
    pub bytes_per_sec: u64,
    #[serde(default)]
    pub bytes_current: u64,
}

fn chapter_url(root_url: &str, link: &str) -> String {
    if link.starts_with("http://") || link.starts_with("https://") {
        link.to_string()
    } else {
        let root = root_url.trim_end_matches('/');
        if link.starts_with('/') {
            format!("{root}{link}")
        } else {
            format!("{root}/{link}")
        }
    }
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("queue-changed", ());
}

fn pending_count(db: &Db) -> i64 {
    db::queue_list(db)
        .map(|items| {
            items
                .iter()
                .filter(|i| i.status == "pending" || i.status == "running")
                .count() as i64
        })
        .unwrap_or(0)
}

fn progress_event(
    item: &QueueItem,
    message: String,
    pending_left: i64,
    page_current: u32,
    page_total: u32,
    phase: &str,
) -> QueueProgressEvent {
    QueueProgressEvent {
        item_id: item.id,
        manga_title: item.manga_title.clone(),
        chapter_name: item.chapter_name.clone(),
        message,
        pending_left,
        page_current,
        page_total,
        phase: phase.to_string(),
        bytes_per_sec: 0,
        bytes_current: 0,
    }
}

/// Start the queue worker. Spawns up to `DOWNLOAD_PARALLEL_TASKS` concurrent
/// `process_item` jobs (clamped 1–32). Page downloads inside a chapter still use
/// `settings_keys::max_threads()` for parallel page GETs.
///
/// If already running, wakes the loop so newly enqueued items (e.g. second split
/// batch) can fill free slots without waiting for a job to finish.
pub fn start_worker(app: AppHandle) {
    let state = app.state::<QueueState>();
    if state.running.swap(true, Ordering::SeqCst) {
        state.wake();
        return;
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        {
            let state = app2.state::<QueueState>();
            let wake_slot = state.wake_tx.clone();
            if let Ok(mut slot) = wake_slot.lock() {
                // Same channel: job-done and "new work enqueued" both wake the fill loop.
                *slot = Some(done_tx.clone());
            };
        }

        loop {
            // Re-read each iteration so Options changes apply without restart.
            let parallel = crate::settings_keys::parallel_tasks();
            let state = app2.state::<QueueState>();
            let active = state.active.clone();
            let db = state.db.clone();

            // Fill worker slots up to parallel
            while active.load(Ordering::SeqCst) < parallel {
                let next = match tauri::async_runtime::spawn_blocking({
                    let db = db.clone();
                    move || db::queue_take_next_pending(&db)
                })
                .await
                {
                    Ok(Ok(v)) => v,
                    Ok(Err(e)) => {
                        eprintln!("queue take error: {e}");
                        break;
                    }
                    Err(e) => {
                        eprintln!("queue join error: {e}");
                        break;
                    }
                };

                let Some(item) = next else {
                    break;
                };

                let cancel_flag = state.register_cancel(item.id);

                emit_changed(&app2);
                let _ = app2.emit(
                    "queue-progress",
                    progress_event(
                        &item,
                        format!("Obteniendo páginas: {}", item.chapter_name),
                        pending_count(&db),
                        0,
                        0,
                        "download",
                    ),
                );

                // Stop raced after take: DB cancelled and/or per-item flag set.
                let already_cancelled = cancel_flag.load(Ordering::SeqCst)
                    || db::queue_get(&db, item.id)
                        .map(|i| i.status == "cancelled")
                        .unwrap_or(false);
                if already_cancelled {
                    let _ = db::queue_mark_cancelled_if_running(&db, item.id, "cancelado");
                    state.unregister_cancel(item.id);
                    emit_changed(&app2);
                    continue;
                }

                active.fetch_add(1, Ordering::SeqCst);
                let app_item = app2.clone();
                let cancel_item = cancel_flag.clone();
                let db_item = db.clone();
                let active_item = active.clone();
                let done_tx = done_tx.clone();
                let item_id = item.id;
                let cancels = state.cancels.clone();

                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking({
                        let item = item.clone();
                        let cancel = cancel_item.clone();
                        let app = app_item.clone();
                        move || process_item(app, item, cancel)
                    })
                    .await;

                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            let max = crate::settings_keys::task_retries();
                            crate::log_file::append(&format!("ERR {}: {e}", item.chapter_name));
                            let _ = db::queue_fail_or_retry(&db_item, item_id, &e, max);
                            maybe_notify_group_done(&app_item, &item);
                        }
                        Err(e) => {
                            let max = crate::settings_keys::task_retries();
                            let msg = format!("tarea cancelada: {e}");
                            crate::log_file::append(&format!("ERR {}: {msg}", item.chapter_name));
                            let _ = db::queue_fail_or_retry(&db_item, item_id, &msg, max);
                            maybe_notify_group_done(&app_item, &item);
                        }
                    }
                    if let Ok(mut map) = cancels.lock() {
                        map.remove(&item_id);
                    }
                    emit_changed(&app_item);
                    active_item.fetch_sub(1, Ordering::SeqCst);
                    let _ = done_tx.send(());
                });
            }

            // Idle: no active work and nothing pending
            if active.load(Ordering::SeqCst) == 0 {
                if !db::queue_has_pending(&db).unwrap_or(false) {
                    break;
                }
                // Pending exists but take returned None (race) — brief wait
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }

            // Job finished or wake from ensure_started / queue_add (e.g. split batch 2)
            let _ = done_rx.recv().await;
        }

        {
            let state = app2.state::<QueueState>();
            let wake_slot = state.wake_tx.clone();
            if let Ok(mut slot) = wake_slot.lock() {
                *slot = None;
            };
            state.running.store(false, Ordering::SeqCst);
        }
        emit_changed(&app2);

        // If new pending arrived while finishing, restart
        let state = app2.state::<QueueState>();
        if db::queue_has_pending(&state.db).unwrap_or(false) {
            start_worker(app2);
        }
        // FMD2 LetFMDDo — UI ocultada; no salir/apagar/hibernar hasta reactivar la opción.
        // else if crate::settings_keys::after_finish_exit() {
        //     app2.exit(0);
        // }
        // else if after_finish_shutdown() { /* countdown then power off */ }
        // else if after_finish_hibernate() { /* countdown then hibernate */ }
    });
}

fn process_item(
    app: AppHandle,
    item: QueueItem,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    // Re-check cancel / cancelled in DB
    let fresh = db::queue_get(&app.state::<QueueState>().db, item.id)?;
    if fresh.status == "cancelled" {
        return Ok(());
    }

    let url = chapter_url(&item.root_url, &item.chapter_link);
    let module_id = if item.module_id.is_empty() {
        None
    } else {
        Some(item.module_id.as_str())
    };
    let warm = if !item.manga_url.trim().is_empty() {
        Some(item.manga_url.as_str())
    } else if !item.root_url.trim().is_empty() {
        Some(item.root_url.as_str())
    } else {
        None
    };

    if cancel.load(Ordering::SeqCst) {
        let _ = db::queue_mark_cancelled_if_running(
            &app.state::<QueueState>().db,
            item.id,
            "",
        );
        return Ok(());
    }

    let _ = app.emit(
        "queue-progress",
        progress_event(
            &item,
            format!("Downloading {}", item.chapter_name),
            pending_count(&app.state::<QueueState>().db),
            0,
            0,
            "download",
        ),
    );

    let output = PathBuf::from(&item.output_dir);
    let chapter_override = {
        let p = item.chapter_path.trim();
        if p.is_empty() {
            None
        } else {
            Some(PathBuf::from(p))
        }
    };
    let display_override = {
        let d = item.chapter_display.trim();
        if d.is_empty() {
            None
        } else {
            Some(d)
        }
    };
    let item_id = item.id;
    let manga_title = item.manga_title.clone();
    let chapter_name = item.chapter_name.clone();
    let app_progress = app.clone();
    let started_at = std::time::Instant::now();
    let mut on_progress = |cur: usize, total: usize, bytes_total: u64| {
        let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
        let bytes_per_sec = (bytes_total as f64 / elapsed).round() as u64;
        let _ = app_progress.emit(
            "queue-progress",
            QueueProgressEvent {
                item_id,
                manga_title: manga_title.clone(),
                chapter_name: chapter_name.clone(),
                message: format!("[{cur}/{total}] {chapter_name}"),
                pending_left: pending_count(&app_progress.state::<QueueState>().db),
                page_current: cur as u32,
                page_total: total as u32,
                phase: "download".to_string(),
                bytes_per_sec,
                bytes_current: bytes_total,
            },
        );
    };

    let result = match download_chapter(
        &url,
        module_id,
        warm,
        &output,
        &item.manga_title,
        item.chapter_index as usize,
        &item.chapter_name,
        lua_host::FrozenNaming {
            dir: chapter_override.as_deref(),
            chapter_display: display_override,
        },
        Some(&mut on_progress),
        Some(&cancel),
    ) {
        Err(e) if e == lua_host::DOWNLOAD_CANCELLED || cancel.load(Ordering::SeqCst) => {
            let _ = db::queue_mark_cancelled_if_running(
                &app.state::<QueueState>().db,
                item.id,
                "",
            );
            return Ok(());
        }
        Err(e) => return Err(e),
        Ok(r) => r,
    };

    if cancel.load(Ordering::SeqCst) {
        let _ = db::queue_mark_cancelled_if_running(
            &app.state::<QueueState>().db,
            item.id,
            "",
        );
        return Ok(());
    }

    if !result.errors.is_empty() && result.files.is_empty() {
        return Err(result.errors.join("; "));
    }

    let mut err = if result.errors.is_empty() {
        String::new()
    } else {
        result.errors.join("; ")
    };

    let pack_fmt = {
        let frozen = item.pack_format.trim();
        if frozen.is_empty() {
            crate::settings_keys::pack_format()
        } else {
            frozen.to_string()
        }
    };
    if matches!(pack_fmt.as_str(), "cbz" | "zip" | "pdf" | "epub") && !result.files.is_empty() {
        let Some(first) = result.files.first() else {
            return Err("pack: sin archivos".into());
        };
        let Some(dir) = std::path::Path::new(first).parent() else {
            return Err("pack: carpeta de capítulo inválida".into());
        };
        if cancel.load(Ordering::SeqCst) {
            let _ = db::queue_mark_cancelled_if_running(
                &app.state::<QueueState>().db,
                item.id,
                "",
            );
            return Ok(());
        }

        // Fase de empaquetado. La barra se queda al 100% (la descarga sí acabó);
        // el conteso de páginas es lo que da señal de vida mientras se empaqueta.
        // `pending_left` se calcula una sola vez: se emite un evento por página y
        // no vale una consulta a la BD cada vez.
        let pending_left = pending_count(&app.state::<QueueState>().db);
        // Embebiendo, una página se empaqueta en milisegundos: sin este freno un
        // capítulo largo inundaría la UI. El último informe pasa siempre.
        let last_emit = std::sync::Mutex::new(
            std::time::Instant::now() - std::time::Duration::from_secs(1),
        );
        let emit_pack = |done: u32, total: u32| {
            if done < total {
                let Ok(mut last) = last_emit.lock() else { return };
                if last.elapsed() < std::time::Duration::from_millis(100) {
                    return;
                }
                *last = std::time::Instant::now();
            }
            let _ = app.emit(
                "queue-progress",
                progress_event(
                    &item,
                    format!("Empaquetando {}", item.chapter_name),
                    pending_left,
                    done,
                    total,
                    "processing",
                ),
            );
        };
        emit_pack(0, result.files.len() as u32);

        let outcome = match crate::pack::pack_chapter_dir(
            dir,
            &pack_fmt,
            Some(&cancel),
            Some(&emit_pack),
        ) {
            Ok(p) => p,
            Err(e) if e == crate::pack::PACK_CANCELLED || cancel.load(Ordering::SeqCst) => {
                let _ = db::queue_mark_cancelled_if_running(
                    &app.state::<QueueState>().db,
                    item.id,
                    "",
                );
                return Ok(());
            }
            Err(e) => return Err(format!("pack failed: {e}")),
        };
        let archive = outcome.archive;

        // Cancel requested while packing finished: do not count as success.
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(crate::paths::fs_path(&archive));
            let _ = db::queue_mark_cancelled_if_running(
                &app.state::<QueueState>().db,
                item.id,
                "",
            );
            return Ok(());
        }

        if !crate::paths::fs_path(&archive).is_file() {
            return Err(format!(
                "pack failed: archive ausente ({})",
                archive.display()
            ));
        }

        // Si al archivo le faltan páginas, NO se borran los originales: son la
        // única copia y borrarlos volvería la pérdida irrecuperable.
        if outcome.skipped.is_empty() {
            if crate::settings_keys::pack_delete_folder() {
                let _ = std::fs::remove_dir_all(crate::paths::fs_path(dir));
            }
        } else if crate::settings_keys::pack_delete_folder() {
            eprintln!(
                "pack: se conserva {} — al archivo le faltan {} página(s)",
                dir.display(),
                outcome.skipped.len()
            );
        }

        if !err.is_empty() {
            err.push_str("; ");
        }
        err.push_str(&format!("packed {}", archive.display()));

        if !outcome.skipped.is_empty() {
            // Unos pocos nombres bastan para orientar; la razón de cada uno ya
            // está en el log.
            const SHOWN: usize = 5;
            let names: Vec<&str> = outcome
                .skipped
                .iter()
                .take(SHOWN)
                .map(|(p, _)| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                })
                .collect();
            let more = outcome.skipped.len().saturating_sub(names.len());
            let listed = if more > 0 {
                format!("{} y {more} más", names.join(", "))
            } else {
                names.join(", ")
            };
            err.push_str(&format!(
                "; AVISO: faltan {} página(s) ({listed}); se conserva la carpeta de imágenes",
                outcome.skipped.len()
            ));
        }
    }

    if cancel.load(Ordering::SeqCst) {
        let _ = db::queue_mark_cancelled_if_running(
            &app.state::<QueueState>().db,
            item.id,
            "",
        );
        return Ok(());
    }

    db::queue_set_status(&app.state::<QueueState>().db, item.id, "done", &err)?;
    let _ = db::downloaded_chapters_mark(
        &app.state::<QueueState>().downloaded,
        &item.module_id,
        &item.manga_url,
        &item.chapter_link,
    );
    let _ = app.emit(
        "queue-progress",
        progress_event(
            &item,
            format!("Completed ({} files)", result.files.len()),
            pending_count(&app.state::<QueueState>().db),
            result.files.len() as u32,
            result.files.len() as u32,
            "download",
        ),
    );
    crate::log_file::append(&format!(
        "OK  {} - {} ({} archivos)",
        item.manga_title,
        item.chapter_name,
        result.files.len()
    ));
    maybe_notify_group_done(&app, &item);
    Ok(())
}

/// FMD2-style balloon: one notification when the whole download group finishes
/// (all chapters of a manga, or all chapters of a split `batch_id`), not per chapter.
fn maybe_notify_group_done(app: &AppHandle, item: &QueueItem) {
    if !crate::settings_keys::bool_setting(crate::settings_keys::NOTIFY_ON_DONE, true) {
        return;
    }
    let db = &app.state::<QueueState>().db;
    // Serialize count+notify so parallel chapter finishes of the same group
    // don't each show a balloon.
    static GATE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let gate = GATE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = {
        let batch = item.batch_id.trim();
        if !batch.is_empty() {
            format!("b:{batch}")
        } else {
            format!("m:{}", item.manga_url.trim())
        }
    };
    if key == "m:" {
        return;
    }
    let Ok(mut recent) = gate.lock() else {
        return;
    };
    let remaining = db::queue_count_pending_for_group(db, item).unwrap_or(1);
    if remaining > 0 {
        return;
    }
    let now = Instant::now();
    recent.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
    if recent.contains_key(&key) {
        return;
    }
    recent.insert(key, now);
    drop(recent);

    let failed = db::queue_group_has_failed(db, item).unwrap_or(false);
    let title = item.manga_title.trim();
    let title = if title.is_empty() { "Manga" } else { title };
    let body = if failed {
        format!("\"{title}\" — Falló")
    } else {
        format!("\"{title}\" — Finalizado")
    };
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title("FMD3").body(body).show();
}

/// Signal cancel for a single in-flight item. Other parallel workers keep going.
pub fn request_cancel(state: &QueueState, id: i64) {
    if let Ok(map) = state.cancels.lock() {
        if let Some(flag) = map.get(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

pub fn ensure_started(app: &AppHandle) {
    let state: State<QueueState> = app.state();
    if db::queue_has_pending(&state.db).unwrap_or(false) {
        start_worker(app.clone());
    }
}
