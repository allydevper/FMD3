//! Shared settings keys for download / HTTP options.

pub const HTTP_USER_AGENT: &str = "http.user_agent";
pub const HTTP_PROXY: &str = "http.proxy";
pub const DOWNLOAD_MAX_THREADS: &str = "download.max_threads";
pub const DOWNLOAD_PACK_FORMAT: &str = "download.pack_format";
pub const DOWNLOAD_PACK_DELETE_FOLDER: &str = "download.pack_delete_folder";
pub const DOWNLOAD_MANGA_FOLDER_PATTERN: &str = "download.manga_folder_pattern";
pub const DOWNLOAD_CHAPTER_FOLDER_PATTERN: &str = "download.chapter_folder_pattern";
pub const DOWNLOAD_PAGE_NAME_PATTERN: &str = "download.page_name_pattern";
pub const DOWNLOAD_CONVERT_TO: &str = "download.convert_to";

pub fn max_threads() -> usize {
    crate::db::settings_get_direct(DOWNLOAD_MAX_THREADS)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 16)
}

pub fn pack_format() -> String {
    crate::db::settings_get_direct(DOWNLOAD_PACK_FORMAT)
        .ok()
        .flatten()
        .unwrap_or_else(|| "none".into())
}

pub fn pack_delete_folder() -> bool {
    matches!(
        crate::db::settings_get_direct(DOWNLOAD_PACK_DELETE_FOLDER)
            .ok()
            .flatten()
            .as_deref(),
        Some("1") | Some("true") | Some("yes")
    )
}

pub fn convert_to() -> String {
    crate::db::settings_get_direct(DOWNLOAD_CONVERT_TO)
        .ok()
        .flatten()
        .unwrap_or_else(|| "keep".into())
}

pub fn manga_folder_pattern() -> String {
    crate::db::settings_get_direct(DOWNLOAD_MANGA_FOLDER_PATTERN)
        .ok()
        .flatten()
        .unwrap_or_else(|| "%Manga%".into())
}

pub fn chapter_folder_pattern() -> String {
    crate::db::settings_get_direct(DOWNLOAD_CHAPTER_FOLDER_PATTERN)
        .ok()
        .flatten()
        .unwrap_or_else(|| "%ChapterIndex%_%Chapter%".into())
}

pub fn page_name_pattern() -> String {
    crate::db::settings_get_direct(DOWNLOAD_PAGE_NAME_PATTERN)
        .ok()
        .flatten()
        .unwrap_or_else(|| "%Page%".into())
}
