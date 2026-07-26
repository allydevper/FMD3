mod catalog;
mod catalog_job;
mod commands;
mod cover_cache;
mod db;
mod download;
pub mod lua_host;
mod log_file;
mod pack;
mod queue;
mod rename_patterns;
mod settings_keys;
mod xpath;

use queue::QueueState;
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the user has confirmed the exit dialog, so the follow-up
/// `window.close()` call doesn't re-trigger the confirmation prompt.
static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Exposed for smoke binaries / tests.
pub fn download_chapter_for_test(
    chapter_url: &str,
    module_id: Option<&str>,
    manga_url: Option<&str>,
    output_dir: &std::path::Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
) -> Result<download::DownloadResult, String> {
    lua_host::download_chapter(
        chapter_url,
        module_id,
        manga_url,
        output_dir,
        manga_title,
        chapter_index,
        chapter_name,
        None,
        None,
    )
}

pub fn download_pages_for_test(
    output_dir: &std::path::Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
    pages: &[String],
) -> download::DownloadResult {
    download::download_pages(output_dir, manga_title, chapter_index, chapter_name, pages)
}

pub fn download_pages_with_referer_for_test(
    output_dir: &std::path::Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
    pages: &[String],
    referer: Option<&str>,
) -> download::DownloadResult {
    download::download_pages_with_progress(
        output_dir,
        manga_title,
        chapter_index,
        chapter_name,
        pages,
        None,
        referer,
    )
}

pub fn open_db_for_test() -> Result<db::Db, String> {
    db::open_db()
}

pub fn db_path_for_test() -> std::path::PathBuf {
    db::db_path()
}

pub fn favorites_list_for_test(db: &db::Db) -> Result<Vec<db::Favorite>, String> {
    db::favorites_list(db)
}

pub fn queue_list_for_test(db: &db::Db) -> Result<Vec<db::QueueItem>, String> {
    db::queue_list(db)
}

pub fn catalog_update_for_test(module_id: &str) -> Result<lua_host::UpdateListStats, String> {
    lua_host::update_list(module_id, None)
}

pub fn catalog_import_for_test(
    module_id: &str,
    path: &str,
) -> Result<catalog::CatalogStats, String> {
    catalog::import_file(module_id, std::path::Path::new(path))
}

pub fn catalog_search_for_test(
    module_id: &str,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<catalog::CatalogEntry>, String> {
    catalog::search(module_id, query, limit, offset)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = db::open_db().expect("no se pudo abrir la base de datos");
    let _ = db::queue_reset_running_to_pending(&db);
    let queue_state = QueueState::new(db);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
                let _ = w.show();
            }
        }))
        .manage(queue_state)
        .setup(|app| {
            crate::lua_host::set_lua_log_app(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::lua_host::ensure_loaded();
                let _ = handle;
            });
            queue::ensure_started(&app.handle());

            // Optional tray when enabled in settings
            if crate::settings_keys::bool_setting(crate::settings_keys::TRAY_MINIMIZE, false)
                || crate::settings_keys::bool_setting(crate::settings_keys::TRAY_START_MINIMIZED, false)
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                    Manager,
                };
                let show_i = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().cloned().unwrap())
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;

                if crate::settings_keys::bool_setting(crate::settings_keys::TRAY_START_MINIMIZED, false)
                {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let confirm = crate::settings_keys::bool_setting(
                    crate::settings_keys::CONFIRM_EXIT,
                    true,
                );
                let to_tray = crate::settings_keys::bool_setting(
                    crate::settings_keys::TRAY_MINIMIZE,
                    false,
                );
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                if confirm && !EXIT_CONFIRMED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    use tauri::Manager;
                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                    let window = window.clone();
                    let app_handle = window.app_handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let yes = app_handle
                            .dialog()
                            .message("¿Seguro que deseas salir de FMD3?")
                            .title("Confirmar salida")
                            .kind(MessageDialogKind::Warning)
                            .buttons(MessageDialogButtons::OkCancel)
                            .blocking_show();
                        if yes {
                            EXIT_CONFIRMED.store(true, Ordering::SeqCst);
                            let _ = window.close();
                        }
                    });
                    return;
                }
                if crate::settings_keys::bool_setting(crate::settings_keys::VACUUM_ON_EXIT, false) {
                    let _ = crate::db::open_db().and_then(|db| {
                        let conn = db.lock();
                        conn.execute_batch("VACUUM;").map_err(|e| e.to_string())
                    });
                }
                if crate::settings_keys::bool_setting(
                    crate::settings_keys::CLEAR_DONE_ON_EXIT,
                    false,
                ) {
                    if let Ok(db) = crate::db::open_db() {
                        let _ = crate::db::queue_clear_finished(&db);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_manga_info,
            commands::modules_list_cmd,
            commands::modules_refresh_cmd,
            commands::modules_match_url_cmd,
            commands::catalog_stats,
            commands::catalog_search,
            commands::catalog_import,
            commands::manga_cache_upsert,
            commands::manga_cache_get,
            commands::cache_clear,
            commands::cover_local_path,
            commands::cover_ensure,
            commands::catalog_update,
            commands::catalog_job_cancel,
            commands::catalog_job_begin,
            commands::catalog_fetch_from_server,
            commands::download_chapters,
            commands::settings_get,
            commands::settings_set,
            commands::favorites_list,
            commands::favorites_add,
            commands::favorites_remove,
            commands::favorites_set_enabled,
            commands::favorites_check,
            commands::favorites_check_all,
            commands::favorites_import_list,
            commands::queue_list,
            commands::queue_add,
            commands::queue_reorder,
            commands::queue_start,
            commands::queue_cancel,
            commands::queue_retry,
            commands::queue_remove,
            commands::queue_clear_finished,
            commands::shell_open_external,
            commands::log_open,
            commands::log_clear,
            commands::db_vacuum,
            commands::app_check_update,
            commands::modules_update_github,
            commands::catalog_download_fmd2db,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
