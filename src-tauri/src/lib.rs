mod catalog;
mod catalog_job;
mod commands;
mod cover_cache;
mod db;
mod db_import;
mod download;
mod image_integrity;
pub mod lua_host;
mod log_file;
mod pack;
mod paths;
mod queue;
mod rename_patterns;
mod settings_keys;
mod xpath;

use queue::QueueState;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// Keeps the tray icon alive for the process lifetime (dropping it removes the icon).
struct AppTray {
    icon: Mutex<Option<TrayIcon>>,
}

fn hide_tray(app: &AppHandle) {
    let state = app.state::<AppTray>();
    let guard = state.icon.lock();
    if let Some(tray) = guard.as_ref() {
        let _ = tray.set_visible(false);
    }
}

fn show_tray(app: &AppHandle) -> bool {
    if !ensure_tray(app) {
        return false;
    }
    let state = app.state::<AppTray>();
    let guard = state.icon.lock();
    if let Some(tray) = guard.as_ref() {
        let _ = tray.set_visible(true);
        return true;
    }
    false
}

fn restore_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(false);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    hide_tray(app);
}

fn build_tray_icon(app: &AppHandle) -> Result<TrayIcon, String> {
    let show_i = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i]).map_err(|e| e.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no hay icono de ventana para la bandeja".to_string())?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("FMD3")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => restore_main_window(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())
}

/// Create the tray once (initially hidden) and keep it in managed state.
fn ensure_tray(app: &AppHandle) -> bool {
    let state = app.state::<AppTray>();
    let mut guard = state.icon.lock();
    if guard.is_some() {
        return true;
    }
    match build_tray_icon(app) {
        Ok(tray) => {
            let _ = tray.set_visible(false);
            *guard = Some(tray);
            true
        }
        Err(e) => {
            eprintln!("[tray] no se pudo crear el icono de bandeja: {e}");
            false
        }
    }
}

/// Set once the user has confirmed the exit dialog, so the follow-up
/// `window.close()` call doesn't re-trigger the confirmation prompt.
static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// Avoid stacking multiple in-app exit prompts if the user keeps clicking X.
static EXIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

pub fn mark_exit_confirmed() {
    EXIT_CONFIRMED.store(true, Ordering::SeqCst);
    EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
}

pub fn clear_exit_prompt() {
    EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
}

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
        Default::default(),
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
    let (main, _, _) = db::open_app_dbs()?;
    Ok(main)
}

pub fn open_app_dbs_for_test() -> Result<(db::Db, db::Db, db::Db), String> {
    db::open_app_dbs()
}

pub fn db_path_for_test() -> std::path::PathBuf {
    db::db_path()
}

pub fn default_download_dir_for_test() -> std::path::PathBuf {
    db::default_download_dir()
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
    let (db, favorites, downloaded) =
        db::open_app_dbs().expect("no se pudo abrir la base de datos");
    let _ = db::queue_reset_running_to_pending(&db);
    let queue_state = QueueState::new(db, favorites, downloaded);

    tauri::Builder::default()
        // Remember window size / position / maximized across restarts.
        //
        // VISIBLE is deliberately excluded: this app hides to the tray, so closing
        // while minimized would persist "invisible" and the next launch would start
        // with no window at all. Startup visibility is owned by TRAY_START_MINIMIZED.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_main_window(app);
        }))
        .manage(queue_state)
        .manage(AppTray {
            icon: Mutex::new(None),
        })
        .setup(|app| {
            crate::lua_host::set_lua_log_app(app.handle().clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::lua_host::ensure_loaded();
                let _ = handle;
            });
            queue::ensure_started(&app.handle());

            // Solo crear/mostrar bandeja al arrancar si inicia minimizado.
            if crate::settings_keys::bool_setting(
                crate::settings_keys::TRAY_START_MINIMIZED,
                false,
            ) {
                if show_tray(app.handle()) {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_skip_taskbar(true);
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // FMD2 parity: minimize → tray (not close → tray).
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let to_tray = crate::settings_keys::bool_setting(
                    crate::settings_keys::TRAY_MINIMIZE,
                    false,
                );
                if to_tray && window.is_minimized().unwrap_or(false) {
                    if show_tray(window.app_handle()) {
                        let _ = window.set_skip_taskbar(true);
                        let _ = window.hide();
                    }
                }
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let confirm = crate::settings_keys::bool_setting(
                    crate::settings_keys::CONFIRM_EXIT,
                    true,
                );
                if confirm && !EXIT_CONFIRMED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    // Frontend shows the same in-app confirm modal as other dialogs.
                    if EXIT_PROMPT_OPEN
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        let _ = window.emit("ask-exit-confirm", ());
                    }
                    return;
                }
                if crate::settings_keys::bool_setting(crate::settings_keys::VACUUM_ON_EXIT, false) {
                    let state = window.app_handle().state::<QueueState>();
                    let _ = crate::db::db_vacuum_app(&state.db, &state.favorites);
                }
                if crate::settings_keys::bool_setting(
                    crate::settings_keys::CLEAR_DONE_ON_EXIT,
                    false,
                ) {
                    let state = window.app_handle().state::<QueueState>();
                    let _ = crate::db::queue_clear_finished(&state.db);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_manga_info,
            commands::rename_preview,
            commands::modules_list_cmd,
            commands::modules_refresh_cmd,
            commands::modules_match_url_cmd,
            commands::catalog_stats,
            commands::catalog_search,
            commands::catalog_count,
            commands::catalog_search_all,
            commands::catalog_count_all,
            commands::catalog_import,
            commands::catalog_hide,
            commands::catalog_unhide,
            commands::catalog_hidden_list,
            commands::catalog_hidden_count,
            commands::catalog_unhide_links,
            commands::catalog_unhide_all,
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
            commands::default_save_dir,
            commands::favorites_list,
            commands::favorites_add,
            commands::favorites_remove,
            commands::favorites_set_enabled,
            commands::favorites_check,
            commands::favorites_check_all,
            commands::favorites_enqueue_pending,
            commands::favorites_download_all,
            commands::favorites_import_db,
            commands::favorites_export_db,
            commands::queue_list,
            commands::queue_add,
            commands::queue_reorder,
            commands::queue_start,
            commands::queue_cancel,
            commands::queue_retry,
            commands::queue_redownload,
            commands::queue_remove,
            commands::queue_delete_chapter_files,
            commands::queue_clear_finished,
            commands::queue_open_item_folder,
            commands::queue_open_item_content,
            commands::queue_items_content_format,
            commands::queue_open_manga_folder,
            commands::downloaded_chapters_list,
            commands::queue_active_chapter_links,
            commands::chapter_mark_keys,
            commands::shell_open_external,
            commands::log_open,
            commands::log_clear,
            commands::db_vacuum,
            commands::modules_repo_list_cmd,
            commands::modules_needs_first_sync_cmd,
            commands::modules_update_check_cmd,
            commands::modules_update_apply_cmd,
            commands::modules_update_dismiss_cmd,
            commands::modules_update_begin,
            commands::modules_update_cancel,
            commands::modules_undo_cmd,
            commands::modules_history_cmd,
            commands::modules_revert_cmd,
            commands::modules_generations_cmd,
            commands::modules_reset_cursor_cmd,
            commands::modules_pin_cmd,
            commands::modules_unpin_cmd,
            commands::modules_backup_size_cmd,
            commands::modules_backup_clear_cmd,
            commands::catalog_download_fmd2db,
            commands::app_confirm_exit,
            commands::app_cancel_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
