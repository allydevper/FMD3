//! Per-module manga catalog (`data/<module_id>.db`), FMD2-compatible `masterlist`.
//! MVP metadata/cover live in shared `fmd-mvp.db` table `manga_cache` (never ALTER/UPDATE masterlist).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
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
    /// True when `manga_cache.title = 'N/A'` (GetInfo failed / inaccessible).
    #[serde(default)]
    pub info_failed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MangaCacheRow {
    pub link: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub alt_titles: String,
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
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub alt_titles: String,
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
            title TEXT,
            alt_titles TEXT,
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
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN title TEXT", []);
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN alt_titles TEXT", []);
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
    register_natcmp(&conn)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// FMD2-compatible `NATCMP`: case-insensitive natural order (digits as numbers).
/// Specials (`!`, `"`, …) stay before A–Z, like FMD2 / `StrCmpLogicalW`.
fn register_natcmp(conn: &Connection) -> Result<(), String> {
    conn.create_collation("NATCMP", |a, b| nat_cmp(a, b))
        .map_err(|e| format!("NATCMP collation: {e}"))
}

fn normalize_sort_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{2033}' => '"',
        '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2007}' | '\u{202F}' => ' ',
        _ => c,
    }
}

/// Natural compare like FMD2 `UTF8LogicalCompareText` / Windows `StrCmpLogicalW`.
fn nat_cmp(a: &str, b: &str) -> Ordering {
    let a: Vec<char> = a.chars().map(normalize_sort_char).collect();
    let b: Vec<char> = b.chars().map(normalize_sort_char).collect();
    nat_cmp_slice(&a, &b)
}

fn nat_cmp_slice(a: &[char], b: &[char]) -> Ordering {
    let mut i = 0usize;
    let mut j = 0usize;
    while i < a.len() || j < b.len() {
        if i >= a.len() {
            return Ordering::Less;
        }
        if j >= b.len() {
            return Ordering::Greater;
        }
        let ca = a[i];
        let cb = b[j];
        let dig_a = ca.is_ascii_digit();
        let dig_b = cb.is_ascii_digit();
        if dig_a && dig_b {
            let (num_a, len_a, next_i) = read_u128_digits(a, i);
            let (num_b, len_b, next_j) = read_u128_digits(b, j);
            i = next_i;
            j = next_j;
            match num_a.cmp(&num_b) {
                Ordering::Equal => match len_a.cmp(&len_b) {
                    Ordering::Equal => continue,
                    other => return other,
                },
                other => return other,
            }
        }

        // Category first: punctuation/symbols before digits before letters.
        // Fixes ¿ ¡ « » etc. which would otherwise sort after Z by Unicode codepoint.
        match char_sort_class(ca).cmp(&char_sort_class(cb)) {
            Ordering::Equal => {}
            other => return other,
        }

        // Case-insensitive char compare (handles multi-char lowercase expansions).
        let mut la = ca.to_lowercase();
        let mut lb = cb.to_lowercase();
        loop {
            match (la.next(), lb.next()) {
                (None, None) => break,
                (None, Some(_)) => return Ordering::Less,
                (Some(_), None) => return Ordering::Greater,
                (Some(x), Some(y)) => match x.cmp(&y) {
                    Ordering::Equal => {}
                    other => return other,
                },
            }
        }
        i += 1;
        j += 1;
    }
    Ordering::Equal
}

/// 0 = special (punct/symbol/space/…), 1 = digit, 2 = letter — like FMD2 specials-first.
fn char_sort_class(c: char) -> u8 {
    if c.is_ascii_digit() {
        1
    } else if c.is_alphabetic() {
        2
    } else {
        0
    }
}

fn read_u128_digits(s: &[char], mut i: usize) -> (u128, u32, usize) {
    let mut num: u128 = 0;
    let mut len: u32 = 0;
    while i < s.len() && s[i].is_ascii_digit() {
        num = num
            .saturating_mul(10)
            .saturating_add((s[i] as u8 - b'0') as u128);
        len += 1;
        i += 1;
    }
    (num, len, i)
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
  COALESCE(NULLIF(NULLIF(c.title,''),'N/A'), m.title, ''),
  COALESCE(NULLIF(c.alt_titles,''), m.alttitles, ''),
  COALESCE(NULLIF(c.authors,''), m.authors, ''),
  COALESCE(NULLIF(c.artists,''), m.artists, ''),
  COALESCE(NULLIF(c.genres,''), m.genres, ''),
  COALESCE(NULLIF(c.status,''), m.status, ''),
  COALESCE(NULLIF(c.summary,''), m.summary, ''),
  CASE
    WHEN c.link IS NOT NULL AND IFNULL(c.title,'') = 'N/A' THEN COALESCE(m.numchapter, 0)
    WHEN c.link IS NOT NULL THEN COALESCE(c.numchapter, 0)
    ELSE COALESCE(m.numchapter, 0)
  END,
  COALESCE(m.jdn, 0),
  COALESCE(c.cover, ''),
  CASE WHEN IFNULL(c.title,'') = 'N/A' THEN 1 ELSE 0 END
FROM masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = ?1
"#;

/// Hide FMD2-poisoned rows whose masterlist title was overwritten to empty/N/A.
const MASTERLIST_USABLE: &str =
    "lower(trim(IFNULL(m.title,''))) NOT IN ('', 'n/a')";

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
        let sql = format!(
            "{SEARCH_SELECT} WHERE {MASTERLIST_USABLE} ORDER BY m.title COLLATE NATCMP, m.link LIMIT ?2 OFFSET ?3"
        );
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
             WHERE {MASTERLIST_USABLE}
               AND (
                 lower(m.title) LIKE lower(?2) ESCAPE '\\'
                 OR lower(m.alttitles) LIKE lower(?2) ESCAPE '\\'
               )
             ORDER BY m.title COLLATE NATCMP, m.link
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

/// Count usable masterlist rows matching the same filters as `search` (no cache JOIN).
pub fn count(module_id: &str, query: &str) -> Result<i64, String> {
    let path = catalog_db_path(module_id);
    if !path.exists() {
        return Ok(0);
    }
    let conn = open_catalog(module_id)?;
    let q = query.trim();
    if q.is_empty() {
        let sql = format!("SELECT COUNT(*) FROM masterlist m WHERE {MASTERLIST_USABLE}");
        conn.query_row(&sql, [], |r| r.get(0))
            .map_err(|e| e.to_string())
    } else {
        let like = format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let sql = format!(
            "SELECT COUNT(*) FROM masterlist m
             WHERE {MASTERLIST_USABLE}
               AND (
                 lower(m.title) LIKE lower(?1) ESCAPE '\\'
                 OR lower(m.alttitles) LIKE lower(?1) ESCAPE '\\'
               )"
        );
        conn.query_row(&sql, params![like], |r| r.get(0))
            .map_err(|e| e.to_string())
    }
}

fn map_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<CatalogEntry> {
    let failed_flag: i64 = r.get(11)?;
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
        info_failed: failed_flag != 0,
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
                      COALESCE(title,''), COALESCE(alt_titles,''),
                      COALESCE(authors,''), COALESCE(artists,''), COALESCE(genres,''),
                      COALESCE(status,''), COALESCE(summary,''), COALESCE(numchapter,0),
                      COALESCE(cover,''), COALESCE(updated_at,'')
               FROM manga_cache WHERE module_id = ?1 AND link = ?2"#,
            params![module_id, link],
            |r| {
                Ok(MangaCacheRow {
                    link: r.get(0)?,
                    title: r.get(1)?,
                    alt_titles: r.get(2)?,
                    authors: r.get(3)?,
                    artists: r.get(4)?,
                    genres: r.get(5)?,
                    status: r.get(6)?,
                    summary: r.get(7)?,
                    numchapter: r.get(8)?,
                    cover: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

fn is_cache_fail_title(title: &str) -> bool {
    let t = title.trim();
    t.is_empty() || t.eq_ignore_ascii_case("N/A")
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

    // Empty / N/A title → failure signal only (never touches masterlist).
    if is_cache_fail_title(&data.title) {
        conn.execute(
            r#"INSERT INTO manga_cache(module_id, link, title, alt_titles, authors, artists, genres, status, summary, numchapter, cover, updated_at)
               VALUES(?1, ?2, 'N/A', '', '', '', '', '', '', 0, '', ?3)
               ON CONFLICT(module_id, link) DO UPDATE SET
                 title='N/A',
                 numchapter=0,
                 updated_at=excluded.updated_at"#,
            params![module_id, link, updated_at],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Success: merge non-empty fields; always take numchapter (may be 0).
    conn.execute(
        r#"INSERT INTO manga_cache(module_id, link, title, alt_titles, authors, artists, genres, status, summary, numchapter, cover, updated_at)
           VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT(module_id, link) DO UPDATE SET
             title=COALESCE(NULLIF(excluded.title,''), manga_cache.title),
             alt_titles=COALESCE(NULLIF(excluded.alt_titles,''), manga_cache.alt_titles),
             authors=COALESCE(NULLIF(excluded.authors,''), manga_cache.authors),
             artists=COALESCE(NULLIF(excluded.artists,''), manga_cache.artists),
             genres=COALESCE(NULLIF(excluded.genres,''), manga_cache.genres),
             status=COALESCE(NULLIF(excluded.status,''), manga_cache.status),
             summary=COALESCE(NULLIF(excluded.summary,''), manga_cache.summary),
             numchapter=excluded.numchapter,
             cover=COALESCE(NULLIF(excluded.cover,''), manga_cache.cover),
             updated_at=excluded.updated_at"#,
        params![
            module_id,
            link,
            data.title.trim(),
            data.alt_titles,
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

/// Clear Info metadata cache and on-disk cover images (settings/favorites/queue untouched).
pub fn cache_clear() -> Result<String, String> {
    let conn = open_app_db()?;
    let deleted = conn
        .execute("DELETE FROM manga_cache", [])
        .map_err(|e| e.to_string())?;
    let _ = conn.execute("VACUUM", []);
    let removed_dirs = crate::cover_cache::clear_all()?;
    Ok(format!(
        "Caché limpiada: {deleted} filas de metadata, {removed_dirs} carpetas de portadas"
    ))
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
                title: "Test Title".into(),
                alt_titles: "Alt".into(),
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
        assert_eq!(row.alt_titles, "Alt");
        assert_eq!(row.cover, "https://example.com/c.jpg");

        let hits = search(mid, "", 10, 0).expect("search");
        let e = hits.iter().find(|e| e.link == link).expect("in search");
        assert_eq!(e.numchapter, 7);
        assert_eq!(e.genres, "Action");
        assert!(!e.info_failed);

        // cleanup
        let _ = std::fs::remove_file(path);
        if let Ok(conn) = open_app_db() {
            let _ = conn.execute(
                "DELETE FROM manga_cache WHERE module_id = ?1",
                params![mid],
            );
        }
    }

    #[test]
    fn cache_na_keeps_masterlist_title_and_flags_failed() {
        let mid = "__test_manga_cache_na__";
        let link = "/series/na_title/";
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(mid, &[(link.into(), "Real Master Title".into())]).expect("links");
        manga_cache_upsert(
            mid,
            link,
            &MangaCacheUpsert {
                title: "N/A".into(),
                alt_titles: "".into(),
                authors: "".into(),
                artists: "".into(),
                genres: "".into(),
                status: "".into(),
                summary: "".into(),
                numchapter: 0,
                cover: "".into(),
            },
        )
        .expect("fail upsert");

        let row = manga_cache_get(mid, link).expect("get").expect("row");
        assert_eq!(row.title, "N/A");

        let hits = search(mid, "", 10, 0).expect("search");
        let e = hits.iter().find(|e| e.link == link).expect("in search");
        assert_eq!(e.title, "Real Master Title");
        assert!(e.info_failed);

        let _ = std::fs::remove_file(path);
        if let Ok(conn) = open_app_db() {
            let _ = conn.execute(
                "DELETE FROM manga_cache WHERE module_id = ?1",
                params![mid],
            );
        }
    }

    #[test]
    fn empty_cache_meta_falls_back_to_masterlist() {
        let mid = "__test_cache_empty_meta__";
        let link = "/series/genres_from_master/";
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(mid, &[(link.into(), "Master Genres Title".into())]).expect("links");
        {
            let conn = open_catalog(mid).expect("open");
            conn.execute(
                "UPDATE masterlist SET genres = ?1, authors = ?2, status = ?3 WHERE link = ?4",
                params![
                    "Comedia, Deportes, Escolar",
                    "Author M",
                    "1",
                    normalize_manga_link(link)
                ],
            )
            .expect("seed masterlist meta");
        }
        manga_cache_upsert(
            mid,
            link,
            &MangaCacheUpsert {
                title: "Cached Title".into(),
                alt_titles: "".into(),
                authors: "".into(),
                artists: "".into(),
                genres: "".into(),
                status: "".into(),
                summary: "".into(),
                numchapter: 3,
                cover: "".into(),
            },
        )
        .expect("cache with blank meta");

        let hits = search(mid, "", 10, 0).expect("search");
        let e = hits.iter().find(|e| e.link == normalize_manga_link(link)).expect("in search");
        assert_eq!(e.title, "Cached Title");
        assert_eq!(e.genres, "Comedia, Deportes, Escolar");
        assert_eq!(e.authors, "Author M");
        assert_eq!(e.status, "1");
        assert_eq!(e.numchapter, 3);

        let _ = std::fs::remove_file(path);
        if let Ok(conn) = open_app_db() {
            let _ = conn.execute(
                "DELETE FROM manga_cache WHERE module_id = ?1",
                params![mid],
            );
        }
    }

    #[test]
    fn hides_masterlist_rows_poisoned_to_na() {
        let mid = "__test_masterlist_na_hidden__";
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(
            mid,
            &[
                ("/ok/".into(), "Keep Me".into()),
                ("/na/".into(), "N/A".into()),
                ("/empty/".into(), "".into()),
            ],
        )
        .expect("links");

        let hits = search(mid, "", 20, 0).expect("search");
        let titles: Vec<_> = hits.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["Keep Me"]);
        assert!(hits.iter().all(|e| e.link == "/ok/"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn nat_cmp_orders_like_fm2() {
        assert_eq!(nat_cmp("vol 2", "vol 10"), Ordering::Less);
        assert_eq!(nat_cmp("Vol 10", "vol 2"), Ordering::Greater);
        assert_eq!(nat_cmp("banana", "Apple"), Ordering::Greater);
        assert_eq!(nat_cmp("Apple", "banana"), Ordering::Less);
        // Specials before letters (FMD2), including Unicode ¿ ¡ that sit after Z by codepoint.
        assert_eq!(nat_cmp("!Zeta", "Alpha"), Ordering::Less);
        assert_eq!(nat_cmp("\u{201C}Quoted\u{201D}", "Alpha"), Ordering::Less);
        assert_eq!(nat_cmp("¿Que?", "Alpha"), Ordering::Less);
        assert_eq!(nat_cmp("¡Hola!", "Alpha"), Ordering::Less);
        assert_eq!(nat_cmp("!Zeta", "\u{201C}Quoted\u{201D}"), Ordering::Less);
        assert_eq!(nat_cmp("!Alpha", "Alpha"), Ordering::Less);
        assert_eq!(nat_cmp("¿Que?", "banana"), Ordering::Less);
    }

    #[test]
    fn catalog_search_uses_natcmp_order() {
        let mid = "__test_natcmp_order__";
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(
            mid,
            &[
                ("/z/".into(), "!Zeta".into()),
                ("/q/".into(), "\u{201C}Quoted\u{201D}".into()),
                ("/inv/".into(), "¿Que?".into()),
                ("/a/".into(), "Alpha".into()),
                ("/v2/".into(), "Vol 2".into()),
                ("/v10/".into(), "Vol 10".into()),
                ("/b/".into(), "banana".into()),
            ],
        )
        .expect("upsert");
        let hits = search(mid, "", 20, 0).expect("search");
        let titles: Vec<_> = hits.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "!Zeta",
                "\u{201C}Quoted\u{201D}",
                "¿Que?",
                "Alpha",
                "banana",
                "Vol 2",
                "Vol 10",
            ]
        );
        let _ = std::fs::remove_file(path);
    }
}
