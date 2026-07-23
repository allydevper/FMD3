//! Per-module manga catalog (`data/<module_id>.db`), FMD2-compatible `masterlist`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub link: String,
    pub title: String,
    pub alttitles: String,
    pub authors: String,
    pub artists: String,
    pub genres: String,
    pub status: String,
    pub summary: String,
    pub numchapter: i64,
    pub jdn: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogStats {
    pub module_id: String,
    pub path: String,
    pub count: i64,
}

fn data_dir() -> PathBuf {
    crate::db::db_path().join("data")
}

pub fn catalog_db_path(module_id: &str) -> PathBuf {
    data_dir().join(format!("{module_id}.db"))
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS masterlist (
            link TEXT NOT NULL PRIMARY KEY,
            title TEXT,
            alttitles TEXT,
            authors TEXT,
            artists TEXT,
            genres TEXT,
            status TEXT,
            summary TEXT,
            numchapter INTEGER,
            jdn INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_masterlist_title ON masterlist(title);
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn open_catalog(module_id: &str) -> Result<Connection, String> {
    if module_id.trim().is_empty() {
        return Err("module_id vacío".into());
    }
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = catalog_db_path(module_id);
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    Ok(conn)
}

pub fn stats(module_id: &str) -> Result<CatalogStats, String> {
    let path = catalog_db_path(module_id);
    if !path.exists() {
        return Ok(CatalogStats {
            module_id: module_id.to_string(),
            path: path.display().to_string(),
            count: 0,
        });
    }
    let conn = open_catalog(module_id)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM masterlist", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(CatalogStats {
        module_id: module_id.to_string(),
        path: path.display().to_string(),
        count,
    })
}

pub fn search(
    module_id: &str,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<CatalogEntry>, String> {
    let path = catalog_db_path(module_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_catalog(module_id)?;
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let q = query.trim();
    let mut out = Vec::new();
    if q.is_empty() {
        let mut stmt = conn
            .prepare(
                r#"SELECT link, COALESCE(title,''), COALESCE(alttitles,''), COALESCE(authors,''),
                          COALESCE(artists,''), COALESCE(genres,''), COALESCE(status,''),
                          COALESCE(summary,''), COALESCE(numchapter,0), COALESCE(jdn,0)
                   FROM masterlist
                   ORDER BY title COLLATE NOCASE
                   LIMIT ?1 OFFSET ?2"#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit, offset], map_entry)
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let like = format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut stmt = conn
            .prepare(
                r#"SELECT link, COALESCE(title,''), COALESCE(alttitles,''), COALESCE(authors,''),
                          COALESCE(artists,''), COALESCE(genres,''), COALESCE(status,''),
                          COALESCE(summary,''), COALESCE(numchapter,0), COALESCE(jdn,0)
                   FROM masterlist
                   WHERE lower(title) LIKE lower(?1) ESCAPE '\'
                      OR lower(alttitles) LIKE lower(?1) ESCAPE '\'
                   ORDER BY title COLLATE NOCASE
                   LIMIT ?2 OFFSET ?3"#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like, limit, offset], map_entry)
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

fn map_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<CatalogEntry> {
    Ok(CatalogEntry {
        link: r.get(0)?,
        title: r.get(1)?,
        alttitles: r.get(2)?,
        authors: r.get(3)?,
        artists: r.get(4)?,
        genres: r.get(5)?,
        status: r.get(6)?,
        summary: r.get(7)?,
        numchapter: r.get(8)?,
        jdn: r.get(9)?,
    })
}

/// Insert title+link rows (FMD UpdateList style). Returns inserted count (ignored duplicates).
pub fn upsert_links(module_id: &str, pairs: &[(String, String)]) -> Result<usize, String> {
    let conn = open_catalog(module_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut inserted = 0usize;
    {
        let mut stmt = tx
            .prepare(
                r#"INSERT OR IGNORE INTO masterlist(link, title, alttitles, authors, artists, genres, status, summary, numchapter, jdn)
                   VALUES(?1, ?2, '', '', '', '', '', '', 0, 0)"#,
            )
            .map_err(|e| e.to_string())?;
        for (link, title) in pairs {
            let link = strip_host(link);
            if link.is_empty() {
                continue;
            }
            let n = stmt
                .execute(params![link, title])
                .map_err(|e| e.to_string())?;
            inserted += n;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// Wipe catalog rows (used by tests / force refresh).
#[allow(dead_code)]
pub fn clear(module_id: &str) -> Result<(), String> {
    let conn = open_catalog(module_id)?;
    conn.execute("DELETE FROM masterlist", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Import an existing FMD2-compatible `.db` into our catalog path for `module_id`.
pub fn import_file(module_id: &str, src: &Path) -> Result<CatalogStats, String> {
    if !src.exists() {
        return Err(format!("No existe: {}", src.display()));
    }
    let dest = catalog_db_path(module_id);
    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;

    // Prefer merge via ATTACH so we don't wipe if source lacks expected table.
    {
        let _ = open_catalog(module_id)?;
    }
    let conn = Connection::open(&dest).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;

    let src_s = src.to_string_lossy().replace('\'', "''");
    conn.execute(
        &format!("ATTACH DATABASE '{src_s}' AS srcdb"),
        [],
    )
    .map_err(|e| format!("ATTACH falló: {e}"))?;

    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM srcdb.sqlite_master WHERE type='table' AND name='masterlist' LIMIT 1",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);

    if !has_table {
        let _ = conn.execute("DETACH DATABASE srcdb", []);
        return Err("El archivo no tiene tabla masterlist (¿es un .db de FMD2?)".into());
    }

    conn.execute(
        r#"INSERT OR IGNORE INTO masterlist(
             link, title, alttitles, authors, artists, genres, status, summary, numchapter, jdn
           )
           SELECT link, title, alttitles, authors, artists, genres, status, summary, numchapter, jdn
           FROM srcdb.masterlist"#,
        [],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute("DETACH DATABASE srcdb", []);
    drop(conn);
    stats(module_id)
}

fn strip_host(url: &str) -> String {
    let url = url.trim();
    if let Ok(u) = url::Url::parse(url) {
        let path = u.path().to_string();
        let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
        if path.is_empty() {
            return "/".into();
        }
        return format!("{path}{query}");
    }
    url.to_string()
}
