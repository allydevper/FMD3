mod commands;
mod db;
mod download;
pub mod lua_host;
mod queue;
mod xpath;

use queue::QueueState;

/// Exposed for smoke binaries / tests.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = db::open_db().expect("no se pudo abrir la base de datos");
    let _ = db::queue_reset_running_to_pending(&db);
    let queue_state = QueueState::new(db);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(queue_state)
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::lua_host::ensure_loaded();
                let _ = handle;
            });
            queue::ensure_started(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_manga_info,
            commands::modules_list_cmd,
            commands::modules_refresh_cmd,
            commands::modules_match_url_cmd,
            commands::download_chapters,
            commands::settings_get,
            commands::settings_set,
            commands::favorites_list,
            commands::favorites_add,
            commands::favorites_remove,
            commands::favorites_check,
            commands::favorites_check_all,
            commands::queue_list,
            commands::queue_add,
            commands::queue_start,
            commands::queue_cancel,
            commands::queue_remove,
            commands::queue_clear_finished,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
