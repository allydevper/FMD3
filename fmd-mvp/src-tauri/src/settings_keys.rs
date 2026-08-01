//! Shared settings keys for download / HTTP / UI / favorites options.
#![allow(dead_code)] // keys are public API for UI / future features

pub const HTTP_USER_AGENT: &str = "http.user_agent";
pub const HTTP_PROXY: &str = "http.proxy";
pub const HTTP_TIMEOUT_SECS: &str = "http.timeout_secs";
pub const HTTP_RETRIES: &str = "http.retries";

pub const DOWNLOAD_MAX_THREADS: &str = "download.max_threads";
pub const DOWNLOAD_PACK_FORMAT: &str = "download.pack_format";
pub const DOWNLOAD_PACK_DELETE_FOLDER: &str = "download.pack_delete_folder";
pub const DOWNLOAD_MANGA_FOLDER_PATTERN: &str = "download.manga_folder_pattern";
pub const DOWNLOAD_CHAPTER_FOLDER_PATTERN: &str = "download.chapter_folder_pattern";
pub const DOWNLOAD_PAGE_NAME_PATTERN: &str = "download.page_name_pattern";
pub const DOWNLOAD_CONVERT_TO: &str = "download.convert_to";
pub const DOWNLOAD_PNG_AS_JPEG: &str = "download.png_as_jpeg";
pub const DOWNLOAD_WEBP_AS: &str = "download.webp_as";
pub const DOWNLOAD_PNG_LEVEL: &str = "download.png_level";
pub const DOWNLOAD_JPEG_QUALITY: &str = "download.jpeg_quality";
pub const DOWNLOAD_MANGA_FOLDER_ON: &str = "download.manga_folder_on";
pub const DOWNLOAD_CHAPTER_FOLDER_ON: &str = "download.chapter_folder_on";
pub const DOWNLOAD_ASCII_ON: &str = "download.ascii_on";
pub const DOWNLOAD_ASCII_CHAR: &str = "download.ascii_char";
pub const DOWNLOAD_VOL_PAD: &str = "download.vol_pad";
pub const DOWNLOAD_CHAP_PAD: &str = "download.chap_pad";
pub const DOWNLOAD_VOL_DIGITS: &str = "download.vol_digits";
pub const DOWNLOAD_CHAP_DIGITS: &str = "download.chap_digits";
pub const DOWNLOAD_TASK_RETRIES: &str = "download.task_retries";
pub const DOWNLOAD_PARALLEL_TASKS: &str = "download.parallel_tasks";
pub const DOWNLOAD_ONE_CHAPTER_PER_MANGA: &str = "download.one_chapter_per_manga";
pub const DOWNLOAD_REMOVE_MANGA_FROM_CHAPTER: &str = "download.remove_manga_from_chapter";
pub const DOWNLOAD_PDF_QUALITY: &str = "download.pdf_quality";

/// Max concurrent GetInfo workers during Update List (FMD2 MaxUpdateListThreads).
pub const CONNECTIONS_MAX_UPDATE_LIST_THREADS: &str = "connections.max_update_list_threads";
/// Max concurrent favorite checks (FMD2 MaxFavoriteThreads).
pub const CONNECTIONS_MAX_FAVORITE_THREADS: &str = "connections.max_favorite_threads";

pub const QUEUE_SORT_ON_ADD: &str = "queue.sort_on_add";

pub const MODULES_ENABLED: &str = "modules.enabled";
pub const CATALOG_DB_URL: &str = "catalog.db_url";
pub const CATALOG_UPDATE_NO_INFO: &str = "catalog.update_no_info";
/// When true, Update List ignores module SortedList and scans every directory page.
pub const CATALOG_UPDATE_FULL_SCAN: &str = "catalog.update_full_scan";

pub const FAVORITES_CHECK_INTERVAL_MIN: &str = "favorites.check_interval_min";
pub const FAVORITES_CHECK_INTERVAL_ON: &str = "favorites.check_interval_on";
pub const FAVORITES_CHECK_ON_START: &str = "favorites.check_on_start";
pub const FAVORITES_OPEN_ON_START: &str = "favorites.open_on_start";
pub const FAVORITES_DOWNLOAD_AFTER_CHECK: &str = "favorites.download_after_check";
pub const FAVORITES_REMOVE_COMPLETED: &str = "favorites.remove_completed";

pub const UI_LOAD_COVERS: &str = "ui.load_covers";
pub const UI_LIVE_SEARCH: &str = "ui.live_search";
pub const UI_GOTO_DOWNLOADS_ON_ADD: &str = "ui.goto_downloads_on_add";
pub const UI_GOTO_FAVORITES_ON_ADD: &str = "ui.goto_favorites_on_add";
pub const UI_NEW_DAYS: &str = "ui.new_days";
/// Last selected website/source in the Info «Fuente» combo.
pub const UI_SELECTED_MODULE: &str = "ui.selected_module";

pub const APP_THEME: &str = "app.theme";
pub const AFTER_FINISH: &str = "app.after_finish";

pub const LOG_ENABLED: &str = "log.enabled";
pub const LOG_FILE: &str = "log.file";

pub const CONFIRM_EXIT: &str = "dialogs.confirm_exit";
pub const CONFIRM_DELETE: &str = "dialogs.confirm_delete";

pub const TRAY_MINIMIZE: &str = "shell.tray_minimize";
pub const TRAY_START_MINIMIZED: &str = "shell.tray_start_minimized";
pub const NOTIFY_ON_DONE: &str = "shell.notify_on_done";

pub const VACUUM_ON_EXIT: &str = "db.vacuum_on_exit";
pub const CLEAR_DONE_ON_EXIT: &str = "queue.clear_done_on_exit";
pub const LONG_PATHS: &str = "paths.long_paths";

fn get_direct(key: &str) -> Option<String> {
    crate::db::settings_get_direct(key).ok().flatten()
}

pub fn get_string_opt(key: &str) -> Option<String> {
    get_direct(key)
}

pub fn parse_bool(s: Option<&str>, default: bool) -> bool {
    match s.map(|v| v.trim().to_ascii_lowercase()) {
        None => default,
        Some(ref v) if v.is_empty() => default,
        Some(ref v) => matches!(v.as_str(), "1" | "true" | "yes" | "on"),
    }
}

pub fn bool_setting(key: &str, default: bool) -> bool {
    parse_bool(get_direct(key).as_deref(), default)
}

pub fn parse_usize(s: Option<&str>, default: usize) -> usize {
    s.and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(default)
}

pub fn usize_setting(key: &str, default: usize) -> usize {
    parse_usize(get_direct(key).as_deref(), default)
}

pub fn max_threads() -> usize {
    usize_setting(DOWNLOAD_MAX_THREADS, 1).clamp(1, 32)
}

/// Global Update List GetInfo parallelism (default 1, like FMD2 OptionMaxUpdateListThreads).
pub fn update_list_threads() -> usize {
    usize_setting(CONNECTIONS_MAX_UPDATE_LIST_THREADS, 1).clamp(1, 32)
}

/// Concurrent favorite GetInfo checks (default 1, like FMD2 OptionMaxFavoriteThreads).
pub fn favorite_threads() -> usize {
    usize_setting(CONNECTIONS_MAX_FAVORITE_THREADS, 1).clamp(1, 32)
}

pub fn parallel_tasks() -> usize {
    usize_setting(DOWNLOAD_PARALLEL_TASKS, 1).clamp(1, 32)
}

/// When true, at most one chapter of the same manga may be `running` at a time.
pub fn one_chapter_per_manga() -> bool {
    bool_setting(DOWNLOAD_ONE_CHAPTER_PER_MANGA, false)
}

pub fn task_retries() -> usize {
    usize_setting(DOWNLOAD_TASK_RETRIES, 1)
}

pub fn http_timeout_secs() -> u64 {
    usize_setting(HTTP_TIMEOUT_SECS, 30) as u64
}

pub fn http_retries() -> usize {
    usize_setting(HTTP_RETRIES, 5)
}

pub fn pack_format() -> String {
    get_direct(DOWNLOAD_PACK_FORMAT).unwrap_or_else(|| "none".into())
}

pub fn pack_delete_folder() -> bool {
    bool_setting(DOWNLOAD_PACK_DELETE_FOLDER, true)
}

pub fn convert_to() -> String {
    get_direct(DOWNLOAD_CONVERT_TO).unwrap_or_else(|| "keep".into())
}

/// FMD2 `OptionPNGSaveAsJPEG`.
pub fn png_as_jpeg() -> bool {
    bool_setting(DOWNLOAD_PNG_AS_JPEG, false)
}

/// FMD2 `OptionWebPSaveAs`: 0 = keep WebP, 1 = PNG, 2 = JPEG.
pub fn webp_as() -> u8 {
    get_direct(DOWNLOAD_WEBP_AS)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(1)
        .clamp(0, 2)
}

/// FMD2 `OptionPNGCompressionLevel`: 0 none / 1 fastest / 2 default / 3 max.
pub fn png_level() -> u8 {
    usize_setting(DOWNLOAD_PNG_LEVEL, 1).clamp(0, 3) as u8
}

/// FMD2 `OptionJPEGQuality` (used when converting to JPEG).
pub fn jpeg_quality() -> u8 {
    usize_setting(DOWNLOAD_JPEG_QUALITY, 80).clamp(1, 100) as u8
}

pub fn manga_folder_pattern() -> String {
    get_direct(DOWNLOAD_MANGA_FOLDER_PATTERN).unwrap_or_else(|| "%MANGA%".into())
}

pub fn chapter_folder_pattern() -> String {
    get_direct(DOWNLOAD_CHAPTER_FOLDER_PATTERN).unwrap_or_else(|| "%CHAPTER%".into())
}

pub fn page_name_pattern() -> String {
    get_direct(DOWNLOAD_PAGE_NAME_PATTERN).unwrap_or_else(|| "%FILENAME%".into())
}

pub fn manga_folder_on() -> bool {
    bool_setting(DOWNLOAD_MANGA_FOLDER_ON, true)
}

pub fn chapter_folder_on() -> bool {
    bool_setting(DOWNLOAD_CHAPTER_FOLDER_ON, true)
}

pub fn ascii_on() -> bool {
    bool_setting(DOWNLOAD_ASCII_ON, true)
}

pub fn ascii_char() -> char {
    get_direct(DOWNLOAD_ASCII_CHAR)
        .and_then(|s| s.chars().next())
        .unwrap_or('_')
}

pub fn chap_digits() -> usize {
    usize_setting(DOWNLOAD_CHAP_DIGITS, 3).clamp(1, 8)
}

pub fn vol_digits() -> usize {
    usize_setting(DOWNLOAD_VOL_DIGITS, 2).clamp(1, 8)
}

pub fn vol_pad_on() -> bool {
    bool_setting(DOWNLOAD_VOL_PAD, true)
}

pub fn chap_pad_on() -> bool {
    bool_setting(DOWNLOAD_CHAP_PAD, true)
}

pub fn remove_manga_from_chapter() -> bool {
    bool_setting(DOWNLOAD_REMOVE_MANGA_FROM_CHAPTER, false)
}

pub fn pdf_quality() -> u8 {
    usize_setting(DOWNLOAD_PDF_QUALITY, 85).clamp(1, 100) as u8
}

pub fn sort_on_add() -> bool {
    bool_setting(QUEUE_SORT_ON_ADD, false)
}

pub fn after_finish_exit() -> bool {
    get_direct(AFTER_FINISH)
        .map(|v| v.trim().eq_ignore_ascii_case("exit"))
        .unwrap_or(false)
}

// FMD2 parity — OptionLetFMDDo / DoAfterFMD (not implemented yet):
// - "shutdown" / "hibernate" values in app.after_finish
// - countdown dialog before exit/power (Exit 5s, Hibernate 30s, Shutdown 60s)
// - Windows: fmdPowerOff / fmdHibernate equivalents
// pub fn after_finish_shutdown() -> bool { ... }
// pub fn after_finish_hibernate() -> bool { ... }

/// True if `id` is **not** in the opt-in list [`MODULES_ENABLED`].
/// Missing key or `[]` means nothing is enabled (all disabled).
pub fn module_disabled(id: &str) -> bool {
    if id.trim().is_empty() {
        return true;
    }
    let Some(raw) = get_direct(MODULES_ENABLED) else {
        return true;
    };
    if raw.trim().is_empty() {
        return true;
    }
    let Ok(list) = serde_json::from_str::<Vec<String>>(&raw) else {
        return true;
    };
    !list.iter().any(|x| x == id)
}
