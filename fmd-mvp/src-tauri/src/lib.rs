mod commands;
mod download;
pub mod lua_host;
mod xpath;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_manga_info,
            commands::download_chapters
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
