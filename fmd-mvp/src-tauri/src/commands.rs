use crate::download::{download_pages, DownloadResult};
use crate::lua_host::{get_info, get_page_links, MangaInfoResult};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn get_manga_info(url: String) -> Result<MangaInfoResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL vacía".into());
    }
    tauri::async_runtime::spawn_blocking(move || get_info(&url))
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
pub struct DownloadRequest {
    pub manga_title: String,
    pub root_url: String,
    pub output_dir: String,
    pub chapters: Vec<DownloadChapterInput>,
}

#[derive(Clone, serde::Serialize)]
struct DownloadProgressEvent {
    current: usize,
    total: usize,
    chapter_name: String,
    message: String,
}

#[tauri::command]
pub async fn download_chapters(
    app: AppHandle,
    req: DownloadRequest,
) -> Result<Vec<DownloadResult>, String> {
    if req.chapters.is_empty() {
        return Err("No hay capítulos seleccionados".into());
    }
    if req.output_dir.trim().is_empty() {
        return Err("Carpeta de salida vacía".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let output = PathBuf::from(&req.output_dir);
        let total = req.chapters.len();
        let mut results = Vec::new();

        for (i, ch) in req.chapters.iter().enumerate() {
            let _ = app.emit(
                "download-progress",
                DownloadProgressEvent {
                    current: i + 1,
                    total,
                    chapter_name: ch.name.clone(),
                    message: format!("Obteniendo páginas: {}", ch.name),
                },
            );

            let chapter_url = if ch.link.starts_with("http://") || ch.link.starts_with("https://") {
                ch.link.clone()
            } else {
                let root = req.root_url.trim_end_matches('/');
                if ch.link.starts_with('/') {
                    format!("{root}{}", ch.link)
                } else {
                    format!("{root}/{}", ch.link)
                }
            };

            let pages = match get_page_links(&chapter_url) {
                Ok(p) => p,
                Err(e) => {
                    results.push(DownloadResult {
                        chapter_index: ch.index,
                        chapter_name: ch.name.clone(),
                        files: vec![],
                        errors: vec![e],
                    });
                    continue;
                }
            };

            if pages.is_empty() {
                results.push(DownloadResult {
                    chapter_index: ch.index,
                    chapter_name: ch.name.clone(),
                    files: vec![],
                    errors: vec!["GetPageNumber no devolvió imágenes".into()],
                });
                continue;
            }

            let _ = app.emit(
                "download-progress",
                DownloadProgressEvent {
                    current: i + 1,
                    total,
                    chapter_name: ch.name.clone(),
                    message: format!("Descargando {} imgs…", pages.len()),
                },
            );

            let result = download_pages(&output, &req.manga_title, ch.index, &ch.name, &pages);
            results.push(result);
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("tarea cancelada: {e}"))?
}
