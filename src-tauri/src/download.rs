use reqwest::blocking::Client;
use sanitize_filename::sanitize;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

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

fn build_client() -> Result<Client, String> {
    use crate::settings_keys::{HTTP_PROXY, HTTP_USER_AGENT};
    let ua = crate::db::settings_get_direct(HTTP_USER_AGENT)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FMD-MVP/0.1".into()
        });
    let timeout = Duration::from_secs(crate::settings_keys::http_timeout_secs().max(5));
    let mut builder = Client::builder().user_agent(ua).timeout(timeout);
    if let Ok(Some(proxy)) = crate::db::settings_get_direct(HTTP_PROXY) {
        let proxy = proxy.trim();
        if !proxy.is_empty() {
            if let Ok(p) = reqwest::Proxy::all(proxy) {
                builder = builder.proxy(p);
            }
        }
    }
    builder.build().map_err(|e| e.to_string())
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
    let client = build_client().ok();

    let manga_dir = output_dir.join(sanitize(manga_title));
    let chapter_dir = crate::paths::fit_download_path(&manga_dir.join(format!(
        "{:03}_{}",
        chapter_index + 1,
        sanitize(chapter_name)
    )));
    let mut files = Vec::new();
    let mut errors = Vec::new();

    if let Err(e) = fs::create_dir_all(crate::paths::fs_path(&chapter_dir)) {
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
    let retries = crate::settings_keys::http_retries();
    for (i, page_url) in pages.iter().enumerate() {
        if let Some(cb) = on_progress.as_mut() {
            cb(i, total);
        }
        let ext = extension_from_url(page_url);
        let file_path: PathBuf = chapter_dir.join(format!("{:03}.{}", i + 1, ext));
        let mut last_err = None;
        for attempt in 0..=retries {
            let mut req = client.get(page_url);
            if let Some(r) = referer.filter(|s| !s.is_empty()) {
                req = req.header("Referer", r);
            }
            match req.send() {
                Ok(resp) if resp.status().is_success() => match resp.bytes() {
                    Ok(bytes) => {
                        if let Err(e) = fs::write(crate::paths::fs_path(&file_path), &bytes) {
                            last_err = Some(format!("Página {}: write error: {e}", i + 1));
                        } else {
                            files.push(file_path.display().to_string());
                            last_err = None;
                            break;
                        }
                    }
                    Err(e) => last_err = Some(format!("Página {}: body error: {e}", i + 1)),
                },
                Ok(resp) => {
                    last_err = Some(format!("Página {}: HTTP {}", i + 1, resp.status()));
                }
                Err(e) => last_err = Some(format!("Página {}: {e}", i + 1)),
            }
            if attempt < retries {
                std::thread::sleep(Duration::from_millis(200 * (attempt as u64 + 1)));
            }
        }
        if let Some(e) = last_err {
            errors.push(e);
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
