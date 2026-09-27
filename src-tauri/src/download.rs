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
    /// Pages the chapter advertised. `0` when the caller did not count them.
    #[serde(default)]
    pub page_count: usize,
    /// Stopped after the visual sample. The rest of the chapter is still pending.
    #[serde(default)]
    pub awaiting_review: bool,
}

/// `Some(cap)` when a chapter longer than `configured` should pause after `cap` pages.
///
/// `passed` is the queue flag set once the user has looked at the sample.
/// `configured == 0` turns the pause off.
pub fn preview_page_limit(page_count: usize, passed: bool, configured: usize) -> Option<usize> {
    if passed || configured == 0 || page_count <= configured {
        None
    } else {
        Some(configured)
    }
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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FMD3/1.0".into()
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
            page_count: pages.len(),
            awaiting_review: false,
        };
    }

    let Some(client) = client else {
        errors.push("No se pudo crear el cliente HTTP".into());
        return DownloadResult {
            chapter_index,
            chapter_name: chapter_name.to_string(),
            files,
            errors,
            page_count: pages.len(),
            awaiting_review: false,
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
        page_count: pages.len(),
        awaiting_review: false,
    }
}

#[cfg(test)]
mod tests {
    use super::preview_page_limit;

    #[test]
    fn preview_limit_only_when_the_chapter_is_longer_than_the_sample() {
        assert_eq!(preview_page_limit(20, false, 5), Some(5));
        assert_eq!(preview_page_limit(5, false, 5), None);
        assert_eq!(preview_page_limit(3, false, 5), None);
        assert_eq!(preview_page_limit(20, true, 5), None);
        assert_eq!(preview_page_limit(20, false, 0), None);
    }
}
