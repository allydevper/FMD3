//! Local cover image cache under `AppData/fmd-mvp/cover-cache/<module_id>/`.
//! Served to the UI as `data:` URLs (avoids Tauri asset-protocol path mismatch).

use crate::catalog::normalize_manga_link;
use crate::db;
use crate::settings_keys::{HTTP_PROXY, HTTP_USER_AGENT};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn covers_root() -> PathBuf {
    migrate_legacy_covers_dir();
    crate::db::db_path().join("cover-cache")
}

/// One-shot rename `covers/` → `cover-cache/` if the new folder is missing.
fn migrate_legacy_covers_dir() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let root = crate::db::db_path();
        let legacy = root.join("covers");
        let modern = root.join("cover-cache");
        if legacy.is_dir() && !modern.exists() {
            let _ = fs::rename(&legacy, &modern);
        }
    });
}

/// Delete `cover-cache/` and legacy `covers/` trees. Returns number of top-level dirs removed.
pub fn clear_all() -> Result<usize, String> {
    migrate_legacy_covers_dir();
    let mut n = 0usize;
    for name in ["cover-cache", "covers"] {
        let p = crate::db::db_path().join(name);
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("borrar {name}: {e}"))?;
            n += 1;
        }
    }
    Ok(n)
}

fn hash_link(link: &str) -> String {
    let key = normalize_manga_link(link);
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let dig = hasher.finalize();
    dig.iter().map(|b| format!("{b:02x}")).collect()
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
        Some("jpeg") | Some("jpg") => "jpg",
        _ => "img",
    }
}

fn sniff_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "png";
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return "jpg";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    if bytes.starts_with(b"GIF8") {
        return "gif";
    }
    "jpg"
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "image/jpeg",
    }
}

fn path_to_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 32 {
        return Err("cover local inválida".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    bytes_to_data_url(&bytes, &ext)
}

fn bytes_to_data_url(bytes: &[u8], ext: &str) -> Result<String, String> {
    if bytes.len() < 32 {
        return Err("cover local inválida".into());
    }
    let mime = mime_for_ext(ext);
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

pub fn path_for(module_id: &str, manga_link: &str) -> PathBuf {
    covers_root()
        .join(module_id.trim())
        .join(hash_link(manga_link))
}

/// Returns an existing cover file path if present (any known extension).
pub fn get_local(module_id: &str, manga_link: &str) -> Option<PathBuf> {
    if module_id.trim().is_empty() {
        return None;
    }
    let stem = path_for(module_id, manga_link);
    let parent = stem.parent()?;
    let name = stem.file_name()?.to_str()?;
    if !parent.is_dir() {
        return None;
    }
    for ext in ["jpg", "jpeg", "png", "webp", "gif", "avif", "img"] {
        let p = parent.join(format!("{name}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    let db = db::open_db()?;
    let ua = db::settings_get(&db, HTTP_USER_AGENT)?
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FMD-MVP/0.1".into()
        });
    let proxy = db::settings_get(&db, HTTP_PROXY)?.unwrap_or_default();
    let mut b = reqwest::blocking::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::limited(8));
    let proxy = proxy.trim();
    if !proxy.is_empty() {
        let p = reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?;
        b = b.proxy(p);
    }
    b.build().map_err(|e| e.to_string())
}

/// Ensure cover is on disk; returns a `data:` URL for the UI.
pub fn ensure(
    module_id: &str,
    manga_link: &str,
    cover_url: &str,
    referer: Option<&str>,
) -> Result<String, String> {
    if module_id.trim().is_empty() {
        return Err("module_id vacío".into());
    }
    if let Some(existing) = get_local(module_id, manga_link) {
        return path_to_data_url(&existing);
    }
    let url = cover_url.trim();
    if url.is_empty() {
        return Err("cover URL vacía".into());
    }
    let client = build_client()?;
    let mut req = client.get(url).header("Accept", "image/webp,image/*,*/*");
    if let Some(r) = referer.filter(|s| !s.trim().is_empty()) {
        req = req.header("Referer", r);
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() < 32 {
        return Err("respuesta de cover demasiado pequeña".into());
    }
    let mut ext = extension_from_url(url);
    if ext == "img" {
        ext = sniff_ext(&bytes);
    }
    let dir = covers_root().join(module_id.trim());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}.{}", hash_link(manga_link), ext));
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    bytes_to_data_url(&bytes, ext)
}

/// Local cover as `data:` URL, if cached.
pub fn local_data_url(module_id: &str, manga_link: &str) -> Option<String> {
    let path = get_local(module_id, manga_link)?;
    path_to_data_url(&path).ok()
}
