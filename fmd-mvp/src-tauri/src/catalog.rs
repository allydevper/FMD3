//! Per-module manga catalog (`data/<module_id>.db`), FMD2-compatible `masterlist`.
//! MVP metadata/cover live in shared `fmd-mvp.db` table `manga_cache` (never ALTER/UPDATE masterlist).

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
    #[serde(default)]
    pub cover: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MangaCacheRow {
    pub link: String,
    pub authors: String,
    pub artists: String,
    pub genres: String,
    pub status: String,
    pub summary: String,
    pub numchapter: i64,
    pub cover: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MangaCacheUpsert {
    pub authors: String,
    pub artists: String,
    pub genres: String,
    pub status: String,
    pub summary: String,
    pub numchapter: i64,
    pub cover: String,
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

fn app_db_path() -> PathBuf {
    crate::db::db_path().join("fmd-mvp.db")
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

/// Open shared app DB and ensure `manga_cache` exists (regenerates empty file if deleted).
fn open_app_db() -> Result<Connection, String> {
    let dir = crate::db::db_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(app_db_path()).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS manga_cache (
            module_id TEXT NOT NULL,
            link TEXT NOT NULL,
            authors TEXT,
            artists TEXT,
            genres TEXT,
            status TEXT,
            summary TEXT,
            numchapter INTEGER NOT NULL DEFAULT 0,
            cover TEXT,
            updated_at TEXT,
            PRIMARY KEY (module_id, link)
        );
        CREATE INDEX IF NOT EXISTS idx_manga_cache_module ON manga_cache(module_id);
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// ATTACH shared `fmd-mvp.db` as `appdb`; DETACH on drop.
struct AppDbAttach<'a>(&'a Connection);

impl<'a> AppDbAttach<'a> {
    fn attach(conn: &'a Connection) -> Result<Self, String> {
        let _ = open_app_db()?;
        let path = app_db_path().to_string_lossy().replace('\'', "''");
        conn.execute(&format!("ATTACH DATABASE '{path}' AS appdb"), [])
            .map_err(|e| format!("ATTACH appdb: {e}"))?;
        Ok(Self(conn))
    }
}

impl Drop for AppDbAttach<'_> {
    fn drop(&mut self) {
        let _ = self.0.execute("DETACH DATABASE appdb", []);
    }
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

const SEARCH_SELECT: &str = r#"
SELECT
  m.link,
  COALESCE(m.title,''),
  COALESCE(m.alttitles,''),
  COALESCE(c.authors, m.authors, ''),
  COALESCE(c.artists, m.artists, ''),
  COALESCE(c.genres, m.genres, ''),
  COALESCE(c.status, m.status, ''),
  COALESCE(c.summary, m.summary, ''),
  COALESCE(NULLIF(c.numchapter, 0), m.numchapter, 0),
  COALESCE(m.jdn, 0),
  COALESCE(c.cover, '')
FROM masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = ?1
"#;

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
    let _attach = AppDbAttach::attach(&conn)?;
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let q = query.trim();
    let mut out = Vec::new();
    if q.is_empty() {
        let sql = format!("{SEARCH_SELECT} ORDER BY m.title COLLATE NOCASE LIMIT ?2 OFFSET ?3");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![module_id, limit, offset], map_entry)
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
        let sql = format!(
            "{SEARCH_SELECT}
             WHERE lower(m.title) LIKE lower(?2) ESCAPE '\\'
                OR lower(m.alttitles) LIKE lower(?2) ESCAPE '\\'
             ORDER BY m.title COLLATE NOCASE
             LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![module_id, like, limit, offset], map_entry)
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
        cover: r.get(10)?,
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
            let link = normalize_manga_link(link);
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

pub fn manga_cache_get(module_id: &str, link: &str) -> Result<Option<MangaCacheRow>, String> {
    if module_id.trim().is_empty() {
        return Ok(None);
    }
    let conn = open_app_db()?;
    let link = normalize_manga_link(link);
    let row = conn
        .query_row(
            r#"SELECT link,
                      COALESCE(authors,''), COALESCE(artists,''), COALESCE(genres,''),
                      COALESCE(status,''), COALESCE(summary,''), COALESCE(numchapter,0),
                      COALESCE(cover,''), COALESCE(updated_at,'')
               FROM manga_cache WHERE module_id = ?1 AND link = ?2"#,
            params![module_id, link],
            |r| {
                Ok(MangaCacheRow {
                    link: r.get(0)?,
                    authors: r.get(1)?,
                    artists: r.get(2)?,
                    genres: r.get(3)?,
                    status: r.get(4)?,
                    summary: r.get(5)?,
                    numchapter: r.get(6)?,
                    cover: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn manga_cache_upsert(
    module_id: &str,
    link: &str,
    data: &MangaCacheUpsert,
) -> Result<(), String> {
    if module_id.trim().is_empty() {
        return Err("module_id vacío".into());
    }
    let conn = open_app_db()?;
    let link = normalize_manga_link(link);
    if link.is_empty() {
        return Err("link vacío".into());
    }
    let updated_at = chrono_now();
    conn.execute(
        r#"INSERT INTO manga_cache(module_id, link, authors, artists, genres, status, summary, numchapter, cover, updated_at)
           VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(module_id, link) DO UPDATE SET
             authors=excluded.authors,
             artists=excluded.artists,
             genres=excluded.genres,
             status=excluded.status,
             summary=excluded.summary,
             numchapter=excluded.numchapter,
             cover=excluded.cover,
             updated_at=excluded.updated_at"#,
        params![
            module_id,
            link,
            data.authors,
            data.artists,
            data.genres,
            data.status,
            data.summary,
            data.numchapter.max(0),
            data.cover,
            updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
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

/// Normalize manga URL/path like FMD2 strip-host for catalog keys.
pub fn normalize_manga_link(url: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manga_cache_survives_module_db_replace() {
        let mid = "__test_manga_cache_shared__";
        let link = "/series/test_title/";
        let _ = upsert_links(mid, &[ (link.into(), "Test Title".into()) ]);
        manga_cache_upsert(
            mid,
            link,
            &MangaCacheUpsert {
                authors: "A".into(),
                artists: "".into(),
                genres: "Action".into(),
                status: "Ongoing".into(),
                summary: "hi".into(),
                numchapter: 7,
                cover: "https://example.com/c.jpg".into(),
            },
        )
        .expect("upsert");

        // Replace module catalog file entirely (simulates copying FMD2 .db over).
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(mid, &[(link.into(), "Test Title".into())]).expect("recreate catalog");

        let row = manga_cache_get(mid, link).expect("get").expect("row still there");
        assert_eq!(row.numchapter, 7);
        assert_eq!(row.authors, "A");
        assert_eq!(row.cover, "https://example.com/c.jpg");

        let hits = search(mid, "", 10, 0).expect("search");
        let e = hits.iter().find(|e| e.link == link).expect("in search");
        assert_eq!(e.numchapter, 7);
        assert_eq!(e.genres, "Action");

        // cleanup
        let _ = std::fs::remove_file(path);
        if let Ok(conn) = open_app_db() {
            let _ = conn.execute(
                "DELETE FROM manga_cache WHERE module_id = ?1",
                params![mid],
            );
        }
    }
}
