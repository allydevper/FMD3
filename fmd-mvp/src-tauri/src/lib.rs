mod catalog;
mod commands;
mod db;
mod download;
pub mod lua_host;
mod pack;
mod queue;
mod rename_patterns;
mod settings_keys;
mod xpath;

use queue::QueueState;

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
        .manage(queue_state)
        .setup(|app| {
            crate::lua_host::set_lua_log_app(app.handle().clone());
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
            commands::catalog_stats,
            commands::catalog_search,
            commands::catalog_import,
            commands::catalog_update,
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
            commands::queue_retry,
            commands::queue_remove,
            commands::queue_clear_finished,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
