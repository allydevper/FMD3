use crate::catalog::{self, CatalogAdvFilter, CatalogEntry, CatalogStats, MangaCacheRow, MangaCacheUpsert};
use crate::db::{self, Favorite, NewQueueItem, QueueItem};
use crate::lua_host::{
    get_info, modules_list, modules_match_url, modules_refresh, update_list, ChapterInfo,
    MangaInfoResult, ModuleMeta, UpdateListProgress, UpdateListStats,
};
use crate::queue::{self, QueueState};
use crate::rename_patterns::RenameOpts;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn get_manga_info(
    url: String,
    module_id: Option<String>,
) -> Result<MangaInfoResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL vacía".into());
    }
    let module_id = module_id.filter(|s| !s.is_empty());
    if let Some(id) = module_id.as_deref() {
        if crate::settings_keys::module_disabled(id) {
            return Err(
                "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
            );
        }
    }
    tauri::async_runtime::spawn_blocking(move || get_info(&url, module_id.as_deref()))
        .await
        .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[tauri::command]
pub async fn modules_list_cmd() -> Result<Vec<ModuleMeta>, String> {
    tauri::async_runtime::spawn_blocking(modules_list)
        .await
        .map_err(|e| format!("tarea cancelada: {e}"))
}

#[tauri::command]
pub async fn modules_refresh_cmd() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(modules_refresh)
        .await
        .map_err(|e| format!("tarea cancelada: {e}"))
}

#[tauri::command]
pub fn modules_match_url_cmd(url: String) -> Result<Vec<ModuleMeta>, String> {
    Ok(modules_match_url(&url))
}

#[tauri::command]
pub fn catalog_stats(module_id: String) -> Result<CatalogStats, String> {
    catalog::stats(&module_id)
}

#[tauri::command]
pub fn catalog_search(
    module_id: String,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<CatalogEntry>, String> {
    if crate::settings_keys::module_disabled(&module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    catalog::search(&module_id, &query, limit.unwrap_or(100), offset.unwrap_or(0))
}

#[tauri::command]
pub fn catalog_count(module_id: String, query: String) -> Result<i64, String> {
    if crate::settings_keys::module_disabled(&module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    catalog::count(&module_id, &query)
}

#[tauri::command]
pub fn catalog_search_all(
    module_ids: Vec<String>,
    query: String,
    filter: Option<CatalogAdvFilter>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<CatalogEntry>, String> {
    let ids: Vec<String> = module_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && !crate::settings_keys::module_disabled(id))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let filter = filter.unwrap_or_default();
    catalog::search_all(
        &ids,
        &query,
        &filter,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
pub fn catalog_count_all(
    module_ids: Vec<String>,
    query: String,
    filter: Option<CatalogAdvFilter>,
) -> Result<i64, String> {
    let ids: Vec<String> = module_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty() && !crate::settings_keys::module_disabled(id))
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }
    let filter = filter.unwrap_or_default();
    catalog::count_all(&ids, &query, &filter)
}

#[tauri::command]
pub fn catalog_import(module_id: String, path: String) -> Result<CatalogStats, String> {
    catalog::import_file(&module_id, std::path::Path::new(&path))
}

#[tauri::command]
pub fn manga_cache_upsert(
    module_id: String,
    link: String,
    title: String,
    alt_titles: String,
    authors: String,
    artists: String,
    genres: String,
    status: String,
    summary: String,
    numchapter: i64,
    cover: String,
) -> Result<(), String> {
    catalog::manga_cache_upsert(
        &module_id,
        &link,
        &MangaCacheUpsert {
            title,
            alt_titles,
            authors,
            artists,
            genres,
            status,
            summary,
            numchapter,
            cover,
        },
    )
}

#[tauri::command]
pub fn manga_cache_get(module_id: String, link: String) -> Result<Option<MangaCacheRow>, String> {
    catalog::manga_cache_get(&module_id, &link)
}

#[tauri::command]
pub fn cache_clear() -> Result<String, String> {
    catalog::cache_clear()
}

#[tauri::command]
pub fn cover_local_path(module_id: String, link: String) -> Result<Option<String>, String> {
    Ok(crate::cover_cache::local_data_url(&module_id, &link))
}

#[tauri::command]
pub async fn cover_ensure(
    module_id: String,
    link: String,
    cover_url: String,
    referer: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::cover_cache::ensure(
            &module_id,
            &link,
            &cover_url,
            referer.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[tauri::command]
pub async fn catalog_update(
    app: AppHandle,
    module_id: String,
) -> Result<UpdateListStats, String> {
    if crate::settings_keys::module_disabled(&module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    let id = module_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        update_list(
            &id,
            Some(Box::new(move |p: UpdateListProgress| {
                let _ = app2.emit("catalog-progress", &p);
            })),
        )
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[tauri::command]
pub fn catalog_job_cancel() -> Result<(), String> {
    crate::catalog_job::request_cancel();
    Ok(())
}

#[tauri::command]
pub fn catalog_job_begin() -> Result<(), String> {
    crate::catalog_job::reset_cancel();
    Ok(())
}

#[tauri::command]
pub async fn catalog_fetch_from_server(
    app: AppHandle,
    module_id: String,
) -> Result<crate::catalog::CatalogStats, String> {
    if crate::settings_keys::module_disabled(&module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    let id = module_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let mut progress = |p: crate::catalog_job::CatalogFetchProgress| {
            let _ = app2.emit("catalog-fetch-progress", &p);
        };
        crate::catalog_job::fetch_from_server(&id, Some(&mut progress))
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[derive(Debug, Deserialize, Clone)]
pub struct DownloadChapterInput {
    pub index: usize,
    pub name: String,
    pub link: String,
    /// When set (e.g. undo), use instead of resolving with current settings.
    #[serde(default)]
    pub manga_path: Option<String>,
    #[serde(default)]
    pub chapter_path: Option<String>,
    /// Pack format frozen at enqueue / undo (`none`/`pdf`/…).
    #[serde(default)]
    pub pack_format: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QueueAddRequest {
    pub manga_title: String,
    pub root_url: String,
    #[serde(default)]
    pub manga_url: String,
    pub module_id: String,
    pub output_dir: String,
    pub chapters: Vec<DownloadChapterInput>,
    /// If false, enqueue as pending without starting the worker ("tarea detenida").
    #[serde(default = "default_true")]
    pub start: bool,
    /// Split-download batch; empty = normal enqueue.
    #[serde(default)]
    pub batch_id: String,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub fn settings_get(state: State<QueueState>, key: String) -> Result<Option<String>, String> {
    db::settings_get(&state.db, &key)
}

#[tauri::command]
pub fn settings_set(state: State<QueueState>, key: String, value: String) -> Result<(), String> {
    db::settings_set(&state.db, &key, &value)
}

/// Default "Guardar en" path = folder of the running executable.
#[tauri::command]
pub fn default_save_dir() -> Result<String, String> {
    Ok(db::exe_dir().to_string_lossy().into_owned())
}

/// Ruta de ejemplo para la vista previa de Ajustes, construida con los valores
/// del formulario (aún sin guardar) por el mismo código que nombra las descargas.
#[tauri::command]
pub fn rename_preview(opts: RenameOpts, output_dir: String, pack_ext: String) -> String {
    crate::rename_patterns::build_preview(&opts, &output_dir, &pack_ext)
}

#[tauri::command]
pub fn favorites_list(state: State<QueueState>) -> Result<Vec<Favorite>, String> {
    db::favorites_list(&state.favorites)
}

#[derive(Debug, Deserialize)]
pub struct FavoriteAddRequest {
    pub module_id: String,
    pub module_name: String,
    pub root_url: String,
    pub manga_url: String,
    pub title: String,
    pub chapters: Vec<DownloadChapterInput>,
}

#[tauri::command]
pub fn favorites_add(
    state: State<QueueState>,
    req: FavoriteAddRequest,
) -> Result<Favorite, String> {
    if crate::settings_keys::module_disabled(&req.module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    let (last_link, last_name, count) = if let Some(last) = req.chapters.last() {
        (last.link.clone(), last.name.clone(), req.chapters.len() as i64)
    } else {
        (String::new(), String::new(), 0)
    };
    db::favorites_add(
        &state.favorites,
        &req.module_id,
        &req.module_name,
        &req.root_url,
        &req.manga_url,
        &req.title,
        &last_link,
        &last_name,
        count,
    )
}

#[tauri::command]
pub fn favorites_remove(state: State<QueueState>, id: i64) -> Result<(), String> {
    db::favorites_remove(&state.favorites, id)
}

#[tauri::command]
pub fn favorites_set_enabled(
    state: State<QueueState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    db::favorites_set_enabled(&state.favorites, id, enabled)
}

#[derive(Debug, Serialize)]
pub struct FavoriteCheckResult {
    pub favorite: Favorite,
    pub new_chapters: Vec<ChapterInfo>,
    pub enqueued: usize,
}

fn chapters_from_info(info: &MangaInfoResult) -> Vec<ChapterInfo> {
    info.chapters.clone()
}

fn find_new_chapters(fav: &Favorite, chapters: &[ChapterInfo]) -> (Vec<ChapterInfo>, bool) {
    if fav.last_chapter_link.is_empty() {
        return (vec![], true);
    }
    if let Some(pos) = chapters
        .iter()
        .position(|c| c.link == fav.last_chapter_link)
    {
        (chapters[pos + 1..].to_vec(), true)
    } else {
        (vec![], false)
    }
}

#[tauri::command]
pub async fn favorites_check(
    app: AppHandle,
    state: State<'_, QueueState>,
    id: i64,
    enqueue: bool,
) -> Result<FavoriteCheckResult, String> {
    check_favorite_inner(&app, state.inner(), id, enqueue).await
}

#[tauri::command]
pub async fn favorites_check_all(
    app: AppHandle,
    state: State<'_, QueueState>,
    enqueue: bool,
) -> Result<Vec<FavoriteCheckResult>, String> {
    let ids: Vec<i64> = db::favorites_list(&state.favorites)?
        .into_iter()
        .filter(|f| f.enabled)
        .map(|f| f.id)
        .collect();
    drop(state);

    let limit = crate::settings_keys::favorite_threads();
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(limit));
    let mut handles = Vec::with_capacity(ids.len());

    for id in ids {
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("semaphore: {e}"))?;
        let app_c = app.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let st = app_c.state::<QueueState>();
            let result = check_favorite_inner(&app_c, &st, id, enqueue).await;
            (id, result)
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        match h.await {
            Ok((_, Ok(r))) => out.push(r),
            Ok((id, Err(e))) => eprintln!("favorites_check {id}: {e}"),
            Err(e) => eprintln!("favorites_check join: {e}"),
        }
    }
    Ok(out)
}

async fn check_favorite_inner(
    app: &AppHandle,
    state: &QueueState,
    id: i64,
    enqueue: bool,
) -> Result<FavoriteCheckResult, String> {
    let main = state.db.clone();
    let fav_db = state.favorites.clone();
    let fav = db::favorites_get(&fav_db, id)?;
    if !fav.enabled {
        let _ = db::favorites_touch_checked(&fav_db, id);
        let favorite = db::favorites_get(&fav_db, id)?;
        return Ok(FavoriteCheckResult {
            favorite,
            new_chapters: vec![],
            enqueued: 0,
        });
    }
    let manga_url = fav.manga_url.clone();
    let module_id = fav.module_id.clone();
    /* Store one absolute form so the mark key matches what InfoView enqueues. */
    let manga_url_for_queue =
        crate::lua_host::maybe_fill_host(&fav.root_url, &fav.manga_url);

    let info = tauri::async_runtime::spawn_blocking(move || {
        get_info(&manga_url, Some(module_id.as_str()))
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))??;

    let chapters = chapters_from_info(&info);
    let (new_chapters, matched) = find_new_chapters(&fav, &chapters);

    let mut enqueued = 0usize;
    if enqueue && matched && !new_chapters.is_empty() {
        let output = db::resolve_output_dir(&main)?;
        if output.trim().is_empty() {
            return Err("No se pudo resolver la carpeta de salida".into());
        }
        let items: Vec<NewQueueItem> = new_chapters
            .iter()
            .map(|c| {
                let base = std::path::Path::new(&output);
                let (manga_path, chapter_path) = crate::lua_host::resolve_queue_item_paths(
                    base,
                    &info.title,
                    c.index as usize,
                    &c.name,
                    &info.module_id,
                    &manga_url_for_queue,
                );
                NewQueueItem {
                    manga_title: info.title.clone(),
                    root_url: info.root_url.clone(),
                    manga_url: manga_url_for_queue.clone(),
                    module_id: info.module_id.clone(),
                    chapter_index: c.index as i64,
                    chapter_name: c.name.clone(),
                    chapter_link: c.link.clone(),
                    output_dir: output.clone(),
                    manga_path: manga_path.display().to_string(),
                    chapter_path: chapter_path.display().to_string(),
                    batch_id: String::new(),
                    pack_format: crate::settings_keys::pack_format(),
                }
            })
            .collect();
        let ids = db::queue_add_many(&main, &items)?;
        enqueued = ids.len();
        queue::ensure_started(app);
    }

    let (last_link, last_name) = if let Some(last) = chapters.last() {
        (last.link.as_str(), last.name.as_str())
    } else {
        ("", "")
    };
    db::favorites_update_progress(&fav_db, id, last_link, last_name, chapters.len() as i64)?;
    let _ = db::favorites_touch_checked(&fav_db, id);
    let favorite = db::favorites_get(&fav_db, id)?;
    Ok(FavoriteCheckResult {
        favorite,
        new_chapters,
        enqueued,
    })
}

#[tauri::command]
pub fn queue_list(state: State<QueueState>) -> Result<Vec<QueueItem>, String> {
    db::queue_list(&state.db)
}

#[tauri::command]
pub fn queue_add(
    app: AppHandle,
    state: State<QueueState>,
    req: QueueAddRequest,
) -> Result<usize, String> {
    if req.chapters.is_empty() {
        return Err("No hay capítulos".into());
    }
    if req.output_dir.trim().is_empty() {
        return Err("Carpeta de salida vacía".into());
    }
    if crate::settings_keys::module_disabled(&req.module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
    }
    let _ = db::settings_set(&state.db, "default_output_dir", &req.output_dir);
    let batch_id = req.batch_id.trim().to_string();
    /* Store one absolute form regardless of caller, so every row for a work agrees
    on the mark key (catalog "download all" passes absolute, other paths may not). */
    let manga_url = crate::lua_host::maybe_fill_host(&req.root_url, &req.manga_url);
    let items: Vec<NewQueueItem> = req
        .chapters
        .iter()
        .map(|c| {
            let base = std::path::Path::new(req.output_dir.trim());
            let frozen_manga = c
                .manga_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let frozen_chapter = c
                .chapter_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let (manga_path, chapter_path) = match (frozen_manga, frozen_chapter) {
                (Some(mp), Some(cp)) => (mp.to_string(), cp.to_string()),
                _ => {
                    let (m, ch) = crate::lua_host::resolve_queue_item_paths(
                        base,
                        &req.manga_title,
                        c.index as usize,
                        &c.name,
                        &req.module_id,
                        &manga_url,
                    );
                    (
                        frozen_manga
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| m.display().to_string()),
                        frozen_chapter
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| ch.display().to_string()),
                    )
                }
            };
            NewQueueItem {
                manga_title: req.manga_title.clone(),
                root_url: req.root_url.clone(),
                manga_url: manga_url.clone(),
                module_id: req.module_id.clone(),
                chapter_index: c.index as i64,
                chapter_name: c.name.clone(),
                chapter_link: c.link.clone(),
                output_dir: req.output_dir.clone(),
                manga_path,
                chapter_path,
                batch_id: batch_id.clone(),
                pack_format: {
                    let frozen = c
                        .pack_format
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    frozen
                        .map(|s| s.to_string())
                        .unwrap_or_else(crate::settings_keys::pack_format)
                },
            }
        })
        .collect();
    let ids = db::queue_add_many(&state.db, &items)?;
    if crate::settings_keys::sort_on_add() {
        let _ = db::queue_sort_by_title(&state.db);
    }
    let _ = app.emit("queue-changed", ());
    if req.start {
        queue::ensure_started(&app);
    }
    Ok(ids.len())
}

#[tauri::command]
pub fn queue_reorder(state: State<QueueState>, ids: Vec<i64>) -> Result<(), String> {
    db::queue_reorder(&state.db, &ids)
}

#[tauri::command]
pub fn queue_start(app: AppHandle) -> Result<(), String> {
    queue::start_worker(app);
    Ok(())
}

#[tauri::command]
pub fn queue_cancel(state: State<QueueState>, id: i64) -> Result<(), String> {
    let item = db::queue_get(&state.db, id)?;
    if item.status == "running" {
        queue::request_cancel(&state, id);
    }
    db::queue_cancel(&state.db, id)
}

#[tauri::command]
pub fn queue_retry(app: AppHandle, state: State<QueueState>, id: i64) -> Result<(), String> {
    db::queue_retry(&state.db, id)?;
    queue::start_worker(app);
    Ok(())
}

/// Wipe chapter files and re-queue a completed item so it downloads from scratch.
/// Keeps the frozen pack format; for legacy rows without one, freezes it from disk first.
#[tauri::command]
pub fn queue_redownload(app: AppHandle, state: State<QueueState>, id: i64) -> Result<(), String> {
    let item = db::queue_get(&state.db, id)?;
    if item.status != "done" {
        return Err("solo se puede redescargar ítems completados".into());
    }
    if item.pack_format.trim().is_empty() {
        if let Ok((_manga, chapter_path)) = resolve_item_open_paths(&item) {
            if let Some(fmt) = chapter_content_format(&chapter_path) {
                let pack = if fmt == "folder" { "none" } else { fmt };
                db::queue_set_pack_format(&state.db, id, pack)?;
            }
        }
    }
    let item = db::queue_get(&state.db, id)?;
    let _ = delete_chapter_files_for_item(&item, None)?;
    db::queue_redownload(&state.db, id)?;
    queue::start_worker(app);
    Ok(())
}

#[tauri::command]
pub fn queue_remove(state: State<QueueState>, id: i64) -> Result<(), String> {
    db::queue_remove(&state.db, id)
}

/// Delete the on-disk chapter folder and/or packed archive for a queue item
/// (safe paths under output_dir). Does not remove the queue row — call `queue_remove` after.
#[tauri::command]
pub fn queue_delete_chapter_files(
    state: State<QueueState>,
    id: i64,
    website: Option<String>,
) -> Result<String, String> {
    let item = db::queue_get(&state.db, id)?;
    delete_chapter_files_for_item(&item, website)
}

fn delete_chapter_files_for_item(
    item: &QueueItem,
    website: Option<String>,
) -> Result<String, String> {
    let base = std::path::PathBuf::from(item.output_dir.trim());
    if item.output_dir.trim().is_empty() {
        return Err("carpeta de salida vacía".into());
    }
    let chapter_dir = if !item.chapter_path.trim().is_empty() {
        std::path::PathBuf::from(item.chapter_path.trim())
    } else {
        let site = website
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                if item.module_id.trim().is_empty() {
                    None
                } else {
                    crate::lua_host::find_by_id(&item.module_id).map(|m| m.name)
                }
            })
            .unwrap_or_default();
        let (authors, artists) = if !item.module_id.trim().is_empty()
            && !item.manga_url.trim().is_empty()
        {
            crate::catalog::manga_cache_get(&item.module_id, &item.manga_url)
                .ok()
                .flatten()
                .map(|row| (row.authors, row.artists))
                .unwrap_or_default()
        } else {
            (String::new(), String::new())
        };
        crate::lua_host::chapter_output_dir(
            &base,
            &item.manga_title,
            item.chapter_index as usize,
            &item.chapter_name,
            &site,
            &authors,
            &artists,
        )
    };
    let base_fs = crate::paths::fs_path(&base);
    let base_canon = base_fs
        .canonicalize()
        .map(|p| crate::paths::strip_long_prefix(&p))
        .unwrap_or_else(|_| crate::paths::strip_long_prefix(&base));

    fn path_under_base(
        candidate: &std::path::Path,
        base_canon: &std::path::Path,
        base_root: &std::path::Path,
    ) -> Result<std::path::PathBuf, String> {
        let fs = crate::paths::fs_path(candidate);
        if !fs.exists() {
            return Ok(crate::paths::strip_long_prefix(candidate));
        }
        let canon = fs
            .canonicalize()
            .map_err(|e| format!("ruta inválida {}: {e}", candidate.display()))?;
        let cmp = crate::paths::strip_long_prefix(&canon);
        if !cmp.starts_with(base_canon) {
            return Err(format!(
                "ruta fuera de la carpeta de salida: {}",
                cmp.display()
            ));
        }
        if cmp == *base_canon || cmp == crate::paths::strip_long_prefix(base_root) {
            return Err("no se borra la carpeta raíz de descargas".into());
        }
        Ok(cmp)
    }

    let mut deleted: Vec<String> = Vec::new();
    let chapter_fs = crate::paths::fs_path(&chapter_dir);

    // Packed archive next to the chapter folder (…/cap.zip when folder was …/cap).
    for ext in ["zip", "cbz", "pdf", "epub"] {
        let archive = chapter_dir.with_extension(ext);
        let archive_fs = crate::paths::fs_path(&archive);
        if !archive_fs.is_file() {
            continue;
        }
        let cmp = path_under_base(&archive, &base_canon, &base)?;
        std::fs::remove_file(&archive_fs)
            .map_err(|e| format!("no se pudo borrar {}: {e}", cmp.display()))?;
        deleted.push(cmp.display().to_string());
    }
    // Leftover atomic-write temps (…/cap.zip.partial).
    for ext in ["zip", "cbz", "pdf", "epub"] {
        let partial = std::path::PathBuf::from(format!(
            "{}.partial",
            chapter_dir.with_extension(ext).display()
        ));
        let partial_fs = crate::paths::fs_path(&partial);
        if !partial_fs.is_file() {
            continue;
        }
        if let Ok(cmp) = path_under_base(&partial, &base_canon, &base) {
            let _ = std::fs::remove_file(&partial_fs);
            deleted.push(cmp.display().to_string());
        }
    }

    if chapter_fs.is_dir() {
        let chap_cmp = path_under_base(&chapter_dir, &base_canon, &base)?;
        let chap_canon = chapter_fs
            .canonicalize()
            .map_err(|e| format!("ruta inválida {}: {e}", chapter_dir.display()))?;
        std::fs::remove_dir_all(&chap_canon)
            .map_err(|e| format!("no se pudo borrar {}: {e}", chap_cmp.display()))?;
        deleted.push(chap_cmp.display().to_string());
    }

    /* The "already downloaded" mark is deliberately NOT touched here. Marks record
    that a chapter was downloaded once; queue rows are separate bookkeeping, so
    removing a finished task — with or without its files — leaves the mark alone. */

    if deleted.is_empty() {
        Ok(chapter_dir.display().to_string())
    } else {
        Ok(deleted.join("; "))
    }
}

#[tauri::command]
pub fn queue_clear_finished(state: State<QueueState>) -> Result<usize, String> {
    db::queue_clear_finished(&state.db)
}

/// Open folder for a queue item.
/// When `prefer_chapter` is true: chapter dir if present, else packed archive parent,
/// else manga folder. When false/omitted: always manga folder (group list).
#[tauri::command]
pub fn queue_open_item_folder(
    state: State<QueueState>,
    id: i64,
    prefer_chapter: Option<bool>,
) -> Result<String, String> {
    let item = db::queue_get(&state.db, id)?;
    let (manga_path, chapter_path) = resolve_item_open_paths(&item)?;

    let open_path = if prefer_chapter.unwrap_or(false) {
        pick_open_folder(&manga_path, &chapter_path)
    } else {
        manga_path.clone()
    };
    if !crate::paths::fs_path(&open_path).exists() {
        std::fs::create_dir_all(crate::paths::fs_path(&open_path))
            .map_err(|e| format!("no se pudo crear {}: {e}", open_path.display()))?;
    }
    let path_str = crate::paths::strip_long_prefix(&open_path)
        .display()
        .to_string();
    shell_open_external(path_str.clone(), None)?;
    Ok(path_str)
}

/// Open chapter content: packed archive (pdf/cbz/…) if present, else chapter folder.
/// Does not create missing paths.
#[tauri::command]
pub fn queue_open_item_content(state: State<QueueState>, id: i64) -> Result<String, String> {
    let item = db::queue_get(&state.db, id)?;
    let (_manga_path, chapter_path) = resolve_item_open_paths(&item)?;
    let open_path = resolve_chapter_content_path(&chapter_path).ok_or_else(|| {
        format!(
            "no hay archivo ni carpeta para «{}»",
            if item.chapter_name.trim().is_empty() {
                format!("capítulo {}", item.chapter_index + 1)
            } else {
                item.chapter_name.trim().to_string()
            }
        )
    })?;
    let path_str = crate::paths::strip_long_prefix(&open_path)
        .display()
        .to_string();
    shell_open_external(path_str.clone(), None)?;
    Ok(path_str)
}

/// Prefer packed archive next to `chapter_path`, else the chapter directory itself.
fn resolve_chapter_content_path(chapter_path: &std::path::Path) -> Option<std::path::PathBuf> {
    for ext in ["pdf", "cbz", "zip", "epub"] {
        let archive = chapter_path.with_extension(ext);
        if crate::paths::fs_path(&archive).is_file() {
            return Some(archive);
        }
    }
    if crate::paths::fs_path(chapter_path).is_dir() {
        return Some(chapter_path.to_path_buf());
    }
    None
}

fn chapter_content_format(chapter_path: &std::path::Path) -> Option<&'static str> {
    let path = resolve_chapter_content_path(chapter_path)?;
    if crate::paths::fs_path(&path).is_dir() {
        return Some("folder");
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("pdf") => Some("pdf"),
        Some("cbz") => Some("cbz"),
        Some("zip") => Some("zip"),
        Some("epub") => Some("epub"),
        _ => Some("folder"),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueContentFormat {
    pub id: i64,
    pub format: String,
}

/// Probe on-disk content format for queue items (pdf/cbz/zip/epub/folder).
#[tauri::command]
pub fn queue_items_content_format(
    state: State<QueueState>,
    ids: Vec<i64>,
) -> Result<Vec<QueueContentFormat>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Ok(item) = db::queue_get(&state.db, id) else {
            continue;
        };
        let Ok((_manga, chapter_path)) = resolve_item_open_paths(&item) else {
            continue;
        };
        if let Some(fmt) = chapter_content_format(&chapter_path) {
            out.push(QueueContentFormat {
                id,
                format: fmt.to_string(),
            });
        }
    }
    Ok(out)
}

fn resolve_item_open_paths(
    item: &crate::db::QueueItem,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let manga_path = if !item.manga_path.trim().is_empty() {
        std::path::PathBuf::from(item.manga_path.trim())
    } else {
        let base = item.output_dir.trim();
        let title = item.manga_title.trim();
        if base.is_empty() {
            return Err("carpeta de salida vacía".into());
        }
        if title.is_empty() {
            return Err("título vacío".into());
        }
        let site = if item.module_id.trim().is_empty() {
            String::new()
        } else {
            crate::lua_host::find_by_id(&item.module_id)
                .map(|m| m.name)
                .unwrap_or_default()
        };
        let (authors, artists) = if !item.module_id.trim().is_empty()
            && !item.manga_url.trim().is_empty()
        {
            crate::catalog::manga_cache_get(&item.module_id, &item.manga_url)
                .ok()
                .flatten()
                .map(|row| (row.authors, row.artists))
                .unwrap_or_default()
        } else {
            (String::new(), String::new())
        };
        crate::lua_host::manga_output_dir(
            std::path::Path::new(base),
            title,
            &site,
            &authors,
            &artists,
        )
    };

    let chapter_path = if !item.chapter_path.trim().is_empty() {
        std::path::PathBuf::from(item.chapter_path.trim())
    } else if !item.output_dir.trim().is_empty() {
        let site = if item.module_id.trim().is_empty() {
            String::new()
        } else {
            crate::lua_host::find_by_id(&item.module_id)
                .map(|m| m.name)
                .unwrap_or_default()
        };
        let (authors, artists) = if !item.module_id.trim().is_empty()
            && !item.manga_url.trim().is_empty()
        {
            crate::catalog::manga_cache_get(&item.module_id, &item.manga_url)
                .ok()
                .flatten()
                .map(|row| (row.authors, row.artists))
                .unwrap_or_default()
        } else {
            (String::new(), String::new())
        };
        crate::lua_host::chapter_output_dir(
            std::path::Path::new(item.output_dir.trim()),
            &item.manga_title,
            item.chapter_index as usize,
            &item.chapter_name,
            &site,
            &authors,
            &artists,
        )
    } else {
        manga_path.clone()
    };

    Ok((manga_path, chapter_path))
}

/// Prefer chapter folder; if packed (pdf/cbz/…) and folder gone, open parent so the archive is visible.
fn pick_open_folder(
    manga_path: &std::path::Path,
    chapter_path: &std::path::Path,
) -> std::path::PathBuf {
    if crate::paths::fs_path(chapter_path).is_dir() {
        return chapter_path.to_path_buf();
    }
    for ext in ["pdf", "cbz", "zip", "epub"] {
        let archive = chapter_path.with_extension(ext);
        if crate::paths::fs_path(&archive).is_file() {
            return archive
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| manga_path.to_path_buf());
        }
    }
    // Chapter folder never created / not downloaded yet → manga (or create manga).
    if manga_path.as_os_str().is_empty() {
        chapter_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| chapter_path.to_path_buf())
    } else {
        manga_path.to_path_buf()
    }
}

/// Resolve and open the manga work folder (base + manga pattern), not just `output_dir`.
/// Prefer [`queue_open_item_folder`] when a queue id is available (uses frozen path).
#[tauri::command]
pub fn queue_open_manga_folder(
    output_dir: String,
    manga_title: String,
    website: String,
    manga_url: Option<String>,
    module_id: Option<String>,
) -> Result<String, String> {
    let base = output_dir.trim();
    let title = manga_title.trim();
    if base.is_empty() {
        return Err("carpeta de salida vacía".into());
    }
    if title.is_empty() {
        return Err("título vacío".into());
    }
    let site = website.trim();
    let (authors, artists) = match (
        module_id.as_deref().filter(|s| !s.trim().is_empty()),
        manga_url.as_deref().filter(|s| !s.trim().is_empty()),
    ) {
        (Some(mid), Some(mu)) => crate::catalog::manga_cache_get(mid, mu)
            .ok()
            .flatten()
            .map(|row| (row.authors, row.artists))
            .unwrap_or_default(),
        _ => (String::new(), String::new()),
    };
    let path = crate::lua_host::manga_output_dir(
        std::path::Path::new(base),
        title,
        site,
        &authors,
        &artists,
    );
    if !crate::paths::fs_path(&path).exists() {
        std::fs::create_dir_all(crate::paths::fs_path(&path))
            .map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
    }
    let path_str = crate::paths::strip_long_prefix(&path)
        .display()
        .to_string();
    shell_open_external(path_str.clone(), None)?;
    Ok(path_str)
}

/// Atajo: encola y arranca (misma ruta que la cola).
#[tauri::command]
pub fn download_chapters(
    app: AppHandle,
    state: State<QueueState>,
    req: QueueAddRequest,
) -> Result<usize, String> {
    queue_add(app, state, req)
}

#[derive(Debug, Deserialize)]
struct FavoriteImportItem {
    module_id: String,
    module_name: String,
    root_url: String,
    manga_url: String,
    title: String,
}

#[tauri::command]
pub fn favorites_import_list(
    state: State<QueueState>,
    json: String,
) -> Result<usize, String> {
    let items: Vec<FavoriteImportItem> =
        serde_json::from_str(&json).map_err(|e| format!("JSON inválido: {e}"))?;
    let mut n = 0usize;
    for item in items {
        match db::favorites_add(
            &state.favorites,
            &item.module_id,
            &item.module_name,
            &item.root_url,
            &item.manga_url,
            &item.title,
            "",
            "",
            0,
        ) {
            Ok(_) => n += 1,
            Err(e) => eprintln!("favorites_import skip {}: {e}", item.manga_url),
        }
    }
    Ok(n)
}

#[tauri::command]
pub fn downloaded_chapters_list(
    state: State<QueueState>,
    module_id: String,
    manga_url: String,
) -> Result<Vec<String>, String> {
    db::downloaded_chapters_list(&state.downloaded, &module_id, &manga_url)
}

#[tauri::command]
pub fn queue_active_chapter_links(
    state: State<QueueState>,
    module_id: String,
    manga_url: String,
) -> Result<Vec<String>, String> {
    db::queue_active_chapter_links(&state.db, &module_id, &manga_url)
}

/// Canonical mark keys for the given links, in the same order.
///
/// The UI calls this once per loaded manga so it can match rows against
/// `downloaded_chapters_list` / `queue_active_chapter_links` without carrying its
/// own copy of the key rules (which is how the two definitions drifted apart).
#[tauri::command]
pub fn chapter_mark_keys(links: Vec<String>) -> Vec<String> {
    db::mark_keys(&links)
}

fn log_file_path(db: &db::Db) -> Result<std::path::PathBuf, String> {
    let name = db::settings_get(db, crate::settings_keys::LOG_FILE)?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "fmd-mvp.log".into());
    let name = name.trim().trim_start_matches(['/', '\\']);
    if name.is_empty() || name.contains("..") {
        return Err("nombre de log inválido".into());
    }
    Ok(db::db_path().join(name))
}

#[tauri::command]
pub fn shell_open_external(path: String, args: Option<String>) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("ruta vacía".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = if let Some(a) = args.as_ref().filter(|s| !s.trim().is_empty()) {
            let mut c = std::process::Command::new(path);
            for part in a.split_whitespace() {
                c.arg(part);
            }
            c
        } else {
            // Open path with the default associated application.
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", "", path]);
            c
        };
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("no se pudo abrir '{path}': {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let mut cmd = if let Some(a) = args.as_ref().filter(|s| !s.trim().is_empty()) {
            let mut c = std::process::Command::new(path);
            for part in a.split_whitespace() {
                c.arg(part);
            }
            c
        } else {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(path);
            c
        };
        cmd.spawn()
            .map_err(|e| format!("no se pudo abrir '{path}': {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub fn log_open(state: State<QueueState>) -> Result<(), String> {
    let path = log_file_path(&state.db)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !path.exists() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    shell_open_external(path.display().to_string(), None)
}

#[tauri::command]
pub fn log_clear(state: State<QueueState>) -> Result<(), String> {
    let path = log_file_path(&state.db)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, "").map_err(|e| format!("no se pudo limpiar log: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_vacuum(state: State<QueueState>) -> Result<(), String> {
    db::db_vacuum_app(&state.db, &state.favorites)
}

#[tauri::command]
pub async fn app_check_update() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = reqwest::blocking::Client::builder()
            .user_agent("FMD-MVP/0.1")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let urls = [
            "https://api.github.com/repos/allydevper/FMD3/releases/latest",
            "https://api.github.com/repos/dazedcat19/FMD2/releases/latest",
        ];
        let mut last_err = String::from("sin respuesta");
        for url in urls {
            match client
                .get(url)
                .header("Accept", "application/vnd.github+json")
                .send()
            {
                Ok(resp) if resp.status().is_success() => {
                    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
                    if let Some(tag) = v.get("tag_name").and_then(|t| t.as_str()) {
                        return Ok(format!("Última versión: {tag}"));
                    }
                    last_err = "respuesta sin tag_name".into();
                }
                Ok(resp) => {
                    last_err = format!("HTTP {}", resp.status());
                }
                Err(e) => {
                    last_err = e.to_string();
                }
            }
        }
        Err(format!("No se pudo comprobar actualizaciones: {last_err}"))
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[tauri::command]
pub async fn modules_update_github() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(modules_refresh)
        .await
        .map_err(|e| format!("tarea cancelada: {e}"))
}

#[tauri::command]
pub async fn catalog_download_fmd2db(url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL vacía".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(
                crate::db::settings_get_direct(crate::settings_keys::HTTP_USER_AGENT)
                    .ok()
                    .flatten()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "FMD-MVP/0.1".into()),
            )
            .timeout(std::time::Duration::from_secs(
                crate::settings_keys::http_timeout_secs().max(1),
            ))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        let fname = url
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty() && s.contains('.'))
            .unwrap_or("catalog.fmd2db");
        let fname = sanitize_filename::sanitize(fname);
        let dest = std::env::temp_dir().join(format!(
            "fmd2db-{}-{fname}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}
