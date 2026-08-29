mod crypto;
mod duktape_js;
mod fmd_env;
mod http;
mod image_puzzle;
mod json_xpath;
mod lua_log;
mod mangafox_watermark;
mod modules_updater;
mod paths;
mod registry;
mod registry_cache;
mod runtime;
mod strings;
mod website_bypass_host;

pub use lua_log::set_app_handle as set_lua_log_app;
pub use modules_updater::{
    apply as modules_update_apply, check as modules_update_check,
    dismiss as modules_update_dismiss, generations as modules_generations,
    history as modules_history, list_for_ui as modules_repo_list,
    request_cancel as modules_update_request_cancel, reset_cancel as modules_update_reset_cancel,
    backup_clear as modules_backup_clear, backup_size as modules_backup_size,
    pin_file as modules_pin_file, pin_keep_local as modules_pin_keep_local,
    reset_cursor as modules_reset_cursor,
    unpin_file as modules_unpin_file,
    revert_file as modules_revert_file, undo_generation as modules_undo_generation, CheckReport,
    FileVersion, Generation, LuaRepoEntry, ModulesUpdateProgress, ModulesUpdateReport, UndoReport,
};
pub use paths::needs_first_sync as modules_needs_first_sync;
pub use registry::{
    ensure_loaded, find_by_id, list as modules_list, match_url as modules_match_url,
    refresh as modules_refresh, ModuleMeta,
};
pub use runtime::{
    chapter_output_dir, download_chapter, get_info, get_page_links, get_page_links_warmed,
    manga_output_dir, resolve_queue_item_paths, update_list, ChapterInfo, FrozenNaming,
    MangaInfoResult, PageLinksResult, UpdateListProgress, UpdateListStats, DOWNLOAD_CANCELLED,
};
pub use strings::{maybe_fill_host, remove_host_from_url};
