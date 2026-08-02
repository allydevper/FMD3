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
    list_for_ui as modules_repo_list, update_from_github as modules_update_from_github,
    LuaRepoEntry, ModulesUpdateReport,
};
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
