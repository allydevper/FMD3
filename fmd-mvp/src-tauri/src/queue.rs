use crate::db::{self, Db, QueueItem};
use crate::lua_host::{self, download_chapter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
pub struct QueueState {
    pub db: Db,
    running: Arc<AtomicBool>,
    cancel_current: Arc<AtomicBool>,
}

impl QueueState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            running: Arc::new(AtomicBool::new(false)),
            cancel_current: Arc::new(AtomicBool::new(false)),
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

pub fn start_worker(app: AppHandle) {
    let state = app.state::<QueueState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    state.cancel_current.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app2.state::<QueueState>();
            let db = state.db.clone();
            let cancel = state.cancel_current.clone();

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

            emit_changed(&app2);
            let _ = app2.emit(
                "queue-progress",
                QueueProgressEvent {
                    item_id: item.id,
                    manga_title: item.manga_title.clone(),
                    chapter_name: item.chapter_name.clone(),
                    message: format!("Obteniendo páginas: {}", item.chapter_name),
                    pending_left: pending_count(&db),
                    page_current: 0,
                    page_total: 0,
                },
            );

            if cancel.load(Ordering::SeqCst) {
                let _ = db::queue_set_status(&db, item.id, "cancelled", "cancelado");
                cancel.store(false, Ordering::SeqCst);
                emit_changed(&app2);
                continue;
            }

            let result = tauri::async_runtime::spawn_blocking({
                let item = item.clone();
                let cancel = cancel.clone();
                let app = app2.clone();
                move || process_item(app, item, cancel)
            })
            .await;

            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    let _ = db::queue_set_status(&db, item.id, "failed", &e);
                }
                Err(e) => {
                    let _ = db::queue_set_status(
                        &db,
                        item.id,
                        "failed",
                        &format!("tarea cancelada: {e}"),
                    );
                }
            }
            emit_changed(&app2);
        }

        app2.state::<QueueState>()
            .running
            .store(false, Ordering::SeqCst);
        emit_changed(&app2);

        // If new pending arrived while finishing, restart
        let state = app2.state::<QueueState>();
        if db::queue_has_pending(&state.db).unwrap_or(false) {
            start_worker(app2);
        }
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
        let _ = db::queue_set_status(&app.state::<QueueState>().db, item.id, "cancelled", "");
        return Ok(());
    }

    let _ = app.emit(
        "queue-progress",
        QueueProgressEvent {
            item_id: item.id,
            manga_title: item.manga_title.clone(),
            chapter_name: item.chapter_name.clone(),
            message: format!("Downloading {}", item.chapter_name),
            pending_left: pending_count(&app.state::<QueueState>().db),
            page_current: 0,
            page_total: 0,
        },
    );

    let output = PathBuf::from(&item.output_dir);
    let item_id = item.id;
    let manga_title = item.manga_title.clone();
    let chapter_name = item.chapter_name.clone();
    let app_progress = app.clone();
    let mut on_progress = |cur: usize, total: usize| {
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
        Some(&mut on_progress),
        Some(&cancel),
    ) {
        Err(e) if e == lua_host::DOWNLOAD_CANCELLED || cancel.load(Ordering::SeqCst) => {
            let _ = db::queue_set_status(&app.state::<QueueState>().db, item.id, "cancelled", "");
            cancel.store(false, Ordering::SeqCst);
            return Ok(());
        }
        Err(e) => return Err(e),
        Ok(r) => r,
    };

    if cancel.load(Ordering::SeqCst) {
        let _ = db::queue_set_status(&app.state::<QueueState>().db, item.id, "cancelled", "");
        cancel.store(false, Ordering::SeqCst);
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

    let pack_fmt = crate::settings_keys::pack_format();
    if matches!(pack_fmt.as_str(), "cbz" | "zip") && !result.files.is_empty() {
        if let Some(first) = result.files.first() {
            if let Some(dir) = std::path::Path::new(first).parent() {
                match crate::pack::pack_chapter_dir(dir, &pack_fmt) {
                    Ok(archive) => {
                        if crate::settings_keys::pack_delete_folder() {
                            let _ = std::fs::remove_dir_all(dir);
                        }
                        if !err.is_empty() {
                            err.push_str("; ");
                        }
                        err.push_str(&format!("packed {}", archive.display()));
                    }
                    Err(e) => {
                        if !err.is_empty() {
                            err.push_str("; ");
                        }
                        err.push_str(&format!("pack failed: {e}"));
                    }
                }
            }
        }
    }

    db::queue_set_status(&app.state::<QueueState>().db, item.id, "done", &err)?;
    let _ = app.emit(
        "queue-progress",
        QueueProgressEvent {
            item_id: item.id,
            manga_title: item.manga_title,
            chapter_name: item.chapter_name,
            message: format!("Completed ({} files)", result.files.len()),
            pending_left: pending_count(&app.state::<QueueState>().db),
            page_current: result.files.len() as u32,
            page_total: result.files.len() as u32,
        },
    );
    Ok(())
}

pub fn request_cancel_current(state: &QueueState) {
    state.cancel_current.store(true, Ordering::SeqCst);
}

pub fn ensure_started(app: &AppHandle) {
    let state: State<QueueState> = app.state();
    if db::queue_has_pending(&state.db).unwrap_or(false) {
        start_worker(app.clone());
    }
}
