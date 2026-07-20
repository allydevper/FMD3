use reqwest::blocking::Client;
use sanitize_filename::sanitize;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    pub chapter_index: usize,
    pub chapter_name: String,
    pub files: Vec<String>,
    pub errors: Vec<String>,
}

fn extension_from_url(url: &str) -> &str {
    let path = url.split('?').next().unwrap_or(url);
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "png",
        Some("webp") => "webp",
        Some("gif") => "gif",
        Some("avif") => "avif",
        _ => "jpg",
    }
}

pub fn download_pages(
    output_dir: &Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
    pages: &[String],
) -> DownloadResult {
    download_pages_with_progress(
        output_dir,
        manga_title,
        chapter_index,
        chapter_name,
        pages,
        None,
        None,
    )
}

pub fn download_pages_with_progress(
    output_dir: &Path,
    manga_title: &str,
    chapter_index: usize,
    chapter_name: &str,
    pages: &[String],
    mut on_progress: Option<&mut dyn FnMut(usize, usize)>,
    referer: Option<&str>,
) -> DownloadResult {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) FMD-MVP/0.1")
        .build()
        .ok();

    let manga_dir = output_dir.join(sanitize(manga_title));
    let chapter_dir = manga_dir.join(format!(
        "{:03}_{}",
        chapter_index + 1,
        sanitize(chapter_name)
    ));
    let mut files = Vec::new();
    let mut errors = Vec::new();

    if let Err(e) = fs::create_dir_all(&chapter_dir) {
        errors.push(format!("No se pudo crear {}: {e}", chapter_dir.display()));
        return DownloadResult {
            chapter_index,
            chapter_name: chapter_name.to_string(),
            files,
            errors,
        };
    }

    let Some(client) = client else {
        errors.push("No se pudo crear el cliente HTTP".into());
        return DownloadResult {
            chapter_index,
            chapter_name: chapter_name.to_string(),
            files,
            errors,
        };
    };

    let total = pages.len();
    for (i, page_url) in pages.iter().enumerate() {
        if let Some(cb) = on_progress.as_mut() {
            cb(i, total);
        }
        let ext = extension_from_url(page_url);
        let file_path: PathBuf = chapter_dir.join(format!("{:03}.{}", i + 1, ext));
        let mut req = client.get(page_url);
        if let Some(r) = referer.filter(|s| !s.is_empty()) {
            req = req.header("Referer", r);
        }
        match req.send() {
            Ok(resp) if resp.status().is_success() => match resp.bytes() {
                Ok(bytes) => {
                    if let Err(e) = fs::write(&file_path, &bytes) {
                        errors.push(format!("Página {}: write error: {e}", i + 1));
                    } else {
                        files.push(file_path.display().to_string());
                    }
                }
                Err(e) => errors.push(format!("Página {}: body error: {e}", i + 1)),
            },
            Ok(resp) => errors.push(format!(
                "Página {}: HTTP {}",
                i + 1,
                resp.status()
            )),
            Err(e) => errors.push(format!("Página {}: {e}", i + 1)),
        }
        if let Some(cb) = on_progress.as_mut() {
            cb(i + 1, total);
        }
    }

    DownloadResult {
        chapter_index,
        chapter_name: chapter_name.to_string(),
        files,
        errors,
    }
}
