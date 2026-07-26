use crate::catalog::{self, CatalogEntry, CatalogStats, MangaCacheRow, MangaCacheUpsert};
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
        let mut progress = |p: UpdateListProgress| {
            let _ = app2.emit("catalog-progress", &p);
        };
        update_list(&id, Some(&mut progress))
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

#[tauri::command]
pub fn favorites_set_enabled(
    state: State<QueueState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    db::favorites_set_enabled(&state.db, id, enabled)
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
        .filter(|f| f.enabled)
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
    if !fav.enabled {
        let _ = db::favorites_touch_checked(&db, id);
        let favorite = db::favorites_get(&db, id)?;
        return Ok(FavoriteCheckResult {
            favorite,
            new_chapters: vec![],
            enqueued: 0,
        });
    }
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
        let output = db::resolve_output_dir(&db)?;
        if output.trim().is_empty() {
            return Err("No se pudo resolver la carpeta de salida".into());
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
    let _ = db::favorites_touch_checked(&db, id);
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
    if crate::settings_keys::module_disabled(&req.module_id) {
        return Err(
            "Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into(),
        );
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
    if crate::settings_keys::sort_on_add() {
        let _ = db::queue_sort_by_title(&state.db);
    }
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
        queue::request_cancel_current(&state);
    }
    db::queue_cancel(&state.db, id)
}

#[tauri::command]
pub fn queue_retry(app: AppHandle, state: State<QueueState>, id: i64) -> Result<(), String> {
    db::queue_retry(&state.db, id)?;
    queue::start_worker(app);
    Ok(())
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
            &state.db,
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

/// Sustituye tokens `%PATH%` y `%CHAPTER%` en la plantilla de argumentos del
/// visor externo (misma convención que FMD2).
fn build_viewer_args(args_template: &str, target: &std::path::Path, chapter_name: &str) -> String {
    args_template
        .replace("%PATH%", &target.display().to_string())
        .replace("%CHAPTER%", chapter_name)
}

/// Abre `target` (carpeta del capítulo o archivo empaquetado) con el visor
/// externo configurado en Ajustes, si `external.viewer_on` está activo.
/// Llamado justo después de que un ítem de la cola termina en "done".
pub fn open_external_viewer(target: &std::path::Path, chapter_name: &str) {
    if !crate::settings_keys::bool_setting(crate::settings_keys::EXTERNAL_VIEWER_ON, false) {
        return;
    }
    if !target.exists() {
        return;
    }
    let viewer_path = crate::db::settings_get_direct(crate::settings_keys::EXTERNAL_VIEWER_PATH)
        .ok()
        .flatten()
        .unwrap_or_default();
    let viewer_path = viewer_path.trim();
    let target_str = target.display().to_string();
    if viewer_path.is_empty() {
        // Sin visor configurado: abre con la aplicación asociada del sistema.
        let _ = shell_open_external(target_str, None);
        return;
    }
    let args_template = crate::db::settings_get_direct(crate::settings_keys::EXTERNAL_VIEWER_ARGS)
        .ok()
        .flatten()
        .unwrap_or_default();
    let args = if args_template.trim().is_empty() {
        target_str
    } else {
        build_viewer_args(&args_template, target, chapter_name)
    };
    let _ = shell_open_external(viewer_path.to_string(), Some(args));
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
    db::db_vacuum(&state.db)
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
