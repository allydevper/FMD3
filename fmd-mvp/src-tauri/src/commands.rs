use crate::catalog::{self, CatalogEntry, CatalogStats};
use crate::db::{self, Favorite, NewQueueItem, QueueItem};
use crate::lua_host::{
    get_info, modules_list, modules_match_url, modules_refresh, update_list, ChapterInfo,
    MangaInfoResult, ModuleMeta, UpdateListProgress, UpdateListStats,
};
use crate::queue::{self, QueueState};
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
    catalog::search(&module_id, &query, limit.unwrap_or(100), offset.unwrap_or(0))
}

#[tauri::command]
pub fn catalog_import(module_id: String, path: String) -> Result<CatalogStats, String> {
    catalog::import_file(&module_id, std::path::Path::new(&path))
}

#[tauri::command]
pub async fn catalog_update(
    app: AppHandle,
    module_id: String,
) -> Result<UpdateListStats, String> {
    let id = module_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app2 = app.clone();
        let mut progress = |p: UpdateListProgress| {
            let _ = app2.emit("catalog-progress", &p);
        };
        update_list(&id, Some(&mut progress))
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}

#[derive(Debug, Deserialize, Clone)]
pub struct DownloadChapterInput {
    pub index: usize,
    pub name: String,
    pub link: String,
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
}

#[tauri::command]
pub fn settings_get(state: State<QueueState>, key: String) -> Result<Option<String>, String> {
    db::settings_get(&state.db, &key)
}

#[tauri::command]
pub fn settings_set(state: State<QueueState>, key: String, value: String) -> Result<(), String> {
    db::settings_set(&state.db, &key, &value)
}

#[tauri::command]
pub fn favorites_list(state: State<QueueState>) -> Result<Vec<Favorite>, String> {
    db::favorites_list(&state.db)
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
    let (last_link, last_name, count) = if let Some(last) = req.chapters.last() {
        (last.link.clone(), last.name.clone(), req.chapters.len() as i64)
    } else {
        (String::new(), String::new(), 0)
    };
    db::favorites_add(
        &state.db,
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
    db::favorites_remove(&state.db, id)
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
    let ids: Vec<i64> = db::favorites_list(&state.db)?
        .into_iter()
        .map(|f| f.id)
        .collect();
    drop(state);
    let mut out = Vec::new();
    for id in ids {
        let st = app.state::<QueueState>();
        match check_favorite_inner(&app, &st, id, enqueue).await {
            Ok(r) => out.push(r),
            Err(e) => eprintln!("favorites_check {id}: {e}"),
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
    let db = state.db.clone();
    let fav = db::favorites_get(&db, id)?;
    let manga_url = fav.manga_url.clone();
    let module_id = fav.module_id.clone();
    let manga_url_for_queue = manga_url.clone();

    let info = tauri::async_runtime::spawn_blocking(move || {
        get_info(&manga_url, Some(module_id.as_str()))
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))??;

    let chapters = chapters_from_info(&info);
    let (new_chapters, matched) = find_new_chapters(&fav, &chapters);

    let mut enqueued = 0usize;
    if enqueue && matched && !new_chapters.is_empty() {
        let output = db::settings_get(&db, "default_output_dir")?.unwrap_or_default();
        if output.trim().is_empty() {
            return Err("Configura carpeta de salida por defecto antes de encolar".into());
        }
        let items: Vec<NewQueueItem> = new_chapters
            .iter()
            .map(|c| NewQueueItem {
                manga_title: info.title.clone(),
                root_url: info.root_url.clone(),
                manga_url: manga_url_for_queue.clone(),
                module_id: info.module_id.clone(),
                chapter_index: c.index as i64,
                chapter_name: c.name.clone(),
                chapter_link: c.link.clone(),
                output_dir: output.clone(),
            })
            .collect();
        let ids = db::queue_add_many(&db, &items)?;
        enqueued = ids.len();
        queue::ensure_started(app);
    }

    let (last_link, last_name) = if let Some(last) = chapters.last() {
        (last.link.as_str(), last.name.as_str())
    } else {
        ("", "")
    };
    db::favorites_update_progress(&db, id, last_link, last_name, chapters.len() as i64)?;
    let favorite = db::favorites_get(&db, id)?;
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
    let _ = db::settings_set(&state.db, "default_output_dir", &req.output_dir);
    let items: Vec<NewQueueItem> = req
        .chapters
        .iter()
        .map(|c| NewQueueItem {
            manga_title: req.manga_title.clone(),
            root_url: req.root_url.clone(),
            manga_url: req.manga_url.clone(),
            module_id: req.module_id.clone(),
            chapter_index: c.index as i64,
            chapter_name: c.name.clone(),
            chapter_link: c.link.clone(),
            output_dir: req.output_dir.clone(),
        })
        .collect();
    let ids = db::queue_add_many(&state.db, &items)?;
    queue::ensure_started(&app);
    Ok(ids.len())
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
        queue::request_cancel_current(&state);
    }
    db::queue_cancel(&state.db, id)
}

#[tauri::command]
pub fn queue_remove(state: State<QueueState>, id: i64) -> Result<(), String> {
    db::queue_remove(&state.db, id)
}

#[tauri::command]
pub fn queue_clear_finished(state: State<QueueState>) -> Result<usize, String> {
    db::queue_clear_finished(&state.db)
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
