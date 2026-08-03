//! Shared cancel flag + download/import catalog DB from FMD2 server.

use crate::catalog;
use crate::settings_keys;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const CATALOG_CANCELLED: &str = "cancelado";

static CATALOG_CANCEL: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

pub const DEFAULT_DB_URL: &str =
    "https://raw.githubusercontent.com/dazedcat19/FMD2-DB/master/7z/<website>.7z";

pub fn reset_cancel() {
    CATALOG_CANCEL.store(false, Ordering::SeqCst);
}

pub fn request_cancel() {
    CATALOG_CANCEL.store(true, Ordering::SeqCst);
}

pub fn is_cancelled() -> bool {
    CATALOG_CANCEL.load(Ordering::SeqCst)
}

pub fn check_cancel() -> Result<(), String> {
    if is_cancelled() {
        Err(CATALOG_CANCELLED.into())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogFetchProgress {
    pub module_id: String,
    pub phase: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub message: String,
}

fn db_url_template() -> String {
    settings_keys::get_string_opt(settings_keys::CATALOG_DB_URL)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DB_URL.to_string())
}

pub fn resolve_db_url(module_id: &str) -> String {
    db_url_template().replace("<website>", module_id)
}

fn find_db_in_dir(dir: &Path) -> Result<PathBuf, String> {
    let mut found: Option<PathBuf> = None;
    let mut walk = |p: &Path| {
        if p.extension().and_then(|e| e.to_str()) == Some("db") {
            found = Some(p.to_path_buf());
        }
    };
    if dir.is_file() {
        walk(dir);
    } else if let Ok(rd) = std::fs::read_dir(dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_file() {
                walk(&p);
            } else if p.is_dir() {
                if let Ok(inner) = std::fs::read_dir(&p) {
                    for e2 in inner.flatten() {
                        walk(&e2.path());
                    }
                }
            }
        }
    }
    found.ok_or_else(|| "El archivo .7z no contiene un .db".into())
}

/// Download module list DB from FMD server, extract if .7z, import into local catalog.
pub fn fetch_from_server(
    module_id: &str,
    mut on_progress: Option<&mut dyn FnMut(CatalogFetchProgress)>,
) -> Result<catalog::CatalogStats, String> {
    check_cancel()?;
    if settings_keys::module_disabled(module_id) {
        return Err("Módulo no activado. Ve a Ajustes → Sitios Web, márcalo y guarda.".into());
    }

    let url = resolve_db_url(module_id);
    let mut emit = |phase: &str, done: u64, total: u64, message: &str| {
        if let Some(cb) = on_progress.as_mut() {
            cb(CatalogFetchProgress {
                module_id: module_id.to_string(),
                phase: phase.into(),
                bytes_done: done,
                bytes_total: total,
                message: message.into(),
            });
        }
    };

    emit("download", 0, 0, &format!("Descargando {module_id}…"));

    let client = reqwest::blocking::Client::builder()
        .user_agent(
            crate::db::settings_get_direct(crate::settings_keys::HTTP_USER_AGENT)
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "FMD3/0.1".into()),
        )
        .timeout(std::time::Duration::from_secs(
            crate::settings_keys::http_timeout_secs().max(30),
        ))
        .build()
        .map_err(|e| e.to_string())?;

    check_cancel()?;
    let mut resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} · {url}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::new();
    if total > 0 {
        buf.reserve(total as usize);
    }
    let mut tmp = [0u8; 64 * 1024];
    loop {
        check_cancel()?;
        let n = resp.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        emit(
            "download",
            buf.len() as u64,
            total,
            &format!(
                "Descargando {module_id}… {:.1}/{:.1} MB",
                buf.len() as f64 / 1_048_576.0,
                (if total > 0 { total } else { buf.len() as u64 }) as f64 / 1_048_576.0
            ),
        );
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let work = std::env::temp_dir().join(format!("fmd-catalog-{module_id}-{stamp}"));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    let lower = url.to_ascii_lowercase();
    let db_path = if lower.ends_with(".db") || lower.ends_with(".sqlite") || lower.ends_with(".sqlite3")
    {
        let dest = work.join(format!("{module_id}.db"));
        std::fs::write(&dest, &buf).map_err(|e| e.to_string())?;
        dest
    } else {
        // Assume .7z (FMD2 default)
        emit("extract", buf.len() as u64, buf.len() as u64, &format!("Extrayendo {module_id}…"));
        check_cancel()?;
        let archive = work.join(format!("{module_id}.7z"));
        std::fs::write(&archive, &buf).map_err(|e| e.to_string())?;
        let out = work.join("out");
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        sevenz_rust2::decompress_file(&archive, &out).map_err(|e| format!("7z: {e}"))?;
        check_cancel()?;
        find_db_in_dir(&out)?
    };

    emit("import", 0, 0, &format!("Importando {module_id}…"));
    check_cancel()?;
    let st = catalog::import_file(module_id, &db_path)?;
    emit(
        "done",
        0,
        0,
        &format!("OK {module_id}: {} títulos", st.count),
    );

    let _ = std::fs::remove_dir_all(&work);
    Ok(st)
}
