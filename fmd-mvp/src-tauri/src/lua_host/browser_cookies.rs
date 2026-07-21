//! Best-effort Firefox cookies (same idea as FMD2 cloudflare.py + rookiepy fallback).
//! Chrome is skipped (App-Bound Encryption). Copy cookies.sqlite to temp — Firefox locks it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn firefox_profiles_dir() -> Option<PathBuf> {
    let base = dirs::data_dir()?; // %APPDATA%
    let p = base.join("Mozilla").join("Firefox").join("Profiles");
    p.is_dir().then_some(p)
}

fn find_cookies_db() -> Option<PathBuf> {
    let profiles = firefox_profiles_dir()?;
    let mut candidates: Vec<PathBuf> = fs::read_dir(&profiles)
        .ok()?
        .flatten()
        .map(|e| e.path().join("cookies.sqlite"))
        .filter(|p| p.is_file())
        .collect();
    // Prefer default-release / default
    candidates.sort_by_key(|p| {
        let s = p.to_string_lossy().to_lowercase();
        if s.contains("default-release") {
            0
        } else if s.contains("default") {
            1
        } else {
            2
        }
    });
    candidates.into_iter().next()
}

/// Cookies for `host` (e.g. es.ninemanga.com) and parent domains.
pub fn firefox_cookies_for_host(host: &str) -> HashMap<String, String> {
    let Some(db_path) = find_cookies_db() else {
        return HashMap::new();
    };
    load_from_sqlite(&db_path, host).unwrap_or_default()
}

fn load_from_sqlite(db_path: &Path, host: &str) -> Result<HashMap<String, String>, String> {
    let tmp = std::env::temp_dir().join(format!(
        "fmd-ff-cookies-{}.sqlite",
        std::process::id()
    ));
    fs::copy(db_path, &tmp).map_err(|e| e.to_string())?;
    // WAL sidecar optional
    let wal = PathBuf::from(format!("{}-wal", db_path.display()));
    if wal.is_file() {
        let _ = fs::copy(&wal, PathBuf::from(format!("{}-wal", tmp.display())));
    }

    let conn = rusqlite::Connection::open(&tmp).map_err(|e| e.to_string())?;
    let host_l = host.to_lowercase();
    let mut stmt = conn
        .prepare(
            "SELECT name, value, host FROM moz_cookies
             WHERE host = ?1 OR host = ?2 OR host LIKE ?3",
        )
        .map_err(|e| e.to_string())?;
    let dotted = format!(".{host_l}");
    let like = format!("%.{host_l}");
    let rows = stmt
        .query_map(rusqlite::params![host_l, dotted, like], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for row in rows.flatten() {
        let (name, value, _) = row;
        if !name.is_empty() {
            map.insert(name, value);
        }
    }
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(PathBuf::from(format!("{}-wal", tmp.display())));
    Ok(map)
}

pub fn host_from_url(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
}
