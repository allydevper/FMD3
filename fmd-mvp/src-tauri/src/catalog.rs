//! Per-module manga catalog (`data/<module_id>.db`), FMD2-compatible `masterlist`.
//! MVP metadata/cover live in shared `fmd-mvp.db` table `manga_cache` (never ALTER/UPDATE masterlist).

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
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
    /// Owning module (filled by `search`; used for all-sites filter).
    #[serde(default)]
    pub module_id: String,
    #[serde(default)]
    pub module_name: String,
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

/// Advanced filter criteria for SQL-side filtering (FMD2 `GenerateSQLFilter` parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogAdvFilter {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub authors: String,
    #[serde(default)]
    pub artists: String,
    #[serde(default)]
    pub summary: String,
    /// 0..3 = status codes; 4 = any.
    #[serde(default = "default_status_any")]
    pub status: i32,
    /// `"all"` = AND include groups; `"one"` = OR.
    #[serde(default = "default_match_all")]
    pub match_mode: String,
    #[serde(default)]
    pub only_new: bool,
    #[serde(default)]
    pub use_regex: bool,
    /// Days window for `only_new` (`jdn > today - new_days`).
    #[serde(default = "default_new_days")]
    pub new_days: i64,
    /// Each group is OR of aliases; groups combined by `match_mode`.
    #[serde(default)]
    pub include_groups: Vec<Vec<String>>,
    #[serde(default)]
    pub exclude_aliases: Vec<String>,
}

impl Default for CatalogAdvFilter {
    fn default() -> Self {
        Self {
            title: String::new(),
            authors: String::new(),
            artists: String::new(),
            summary: String::new(),
            status: 4,
            match_mode: "all".into(),
            only_new: false,
            use_regex: false,
            new_days: 1,
            include_groups: Vec::new(),
            exclude_aliases: Vec::new(),
        }
    }
}

fn default_status_any() -> i32 {
    4
}
fn default_match_all() -> String {
    "all".into()
}
fn default_new_days() -> i64 {
    1
}

const MAX_ATTACH_SITES: usize = 125;

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

/// Civil Julian Day Number — same formula as FMD2 `DateToJDN` (uBaseUnit.pas).
pub fn date_to_jdn(year: i32, month: u32, day: u32) -> i64 {
    let a = (14 - month as i32) / 12;
    let y = year + 4800 - a;
    let m = month as i32 + 12 * a - 3;
    let raw = f64::from(day as i32)
        + f64::from((153 * m + 2) / 5)
        + f64::from(365 * y)
        + f64::from(y / 4)
        - f64::from(y / 100)
        + f64::from(y / 400)
        - 32045.0
        - 0.5;
    raw.round() as i64
}

/// Today's JDN in local calendar date (FMD2 `GetCurrentJDN`).
pub fn today_jdn() -> i64 {
    use chrono::Datelike;
    let d = chrono::Local::now().date_naive();
    date_to_jdn(d.year(), d.month(), d.day())
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
            let mut e = row.map_err(|e| e.to_string())?;
            e.module_id = module_id.to_string();
            out.push(e);
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
            let mut e = row.map_err(|e| e.to_string())?;
            e.module_id = module_id.to_string();
            out.push(e);
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

/// Coalesced display fields (same as SEARCH_SELECT) for SQL-side advanced filter.
const COL_TITLE: &str =
    "COALESCE(NULLIF(NULLIF(c.title,''),'N/A'), m.title, '')";
const COL_ALT: &str = "COALESCE(NULLIF(c.alt_titles,''), m.alttitles, '')";
const COL_AUTHORS: &str = "COALESCE(NULLIF(c.authors,''), m.authors, '')";
const COL_ARTISTS: &str = "COALESCE(NULLIF(c.artists,''), m.artists, '')";
const COL_GENRES: &str = "COALESCE(NULLIF(c.genres,''), m.genres, '')";
const COL_STATUS: &str = "COALESCE(NULLIF(c.status,''), m.status, '')";
const COL_SUMMARY: &str = "COALESCE(NULLIF(c.summary,''), m.summary, '')";

fn sql_quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn sql_quote_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\'', "''");
    format!("'{s}'")
}

fn like_escape(raw: &str) -> String {
    format!(
        "%{}%",
        raw.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn register_regexp(conn: &Connection) -> Result<(), String> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "regexp",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let pattern: String = ctx.get(0)?;
            let text: String = ctx.get(1)?;
            match regex::RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .build()
            {
                Ok(re) => Ok(re.is_match(&text)),
                Err(_) => Ok(false),
            }
        },
    )
    .map_err(|e| format!("REGEXP: {e}"))
}

struct FilterSql {
    /// AND-clauses without leading AND (joined by caller).
    clauses: Vec<String>,
    params: Vec<SqlValue>,
}

impl FilterSql {
    fn new() -> Self {
        Self {
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }

    fn push_param(&mut self, v: impl Into<SqlValue>) {
        self.params.push(v.into());
    }

    fn add_text_field(&mut self, expr: &str, value: &str, use_regex: bool) {
        let v = value.trim();
        if v.is_empty() {
            return;
        }
        if use_regex {
            self.push_param(v.to_string());
            self.clauses
                .push(format!("lower({expr}) REGEXP ?"));
        } else {
            self.push_param(like_escape(v));
            self.clauses
                .push(format!("lower({expr}) LIKE lower(?) ESCAPE '\\'"));
        }
    }

    fn add_paired_title(&mut self, title: &str, use_regex: bool) {
        let v = title.trim();
        if v.is_empty() {
            return;
        }
        if use_regex {
            self.push_param(v.to_string());
            self.push_param(v.to_string());
            self.clauses.push(format!(
                "(lower({COL_TITLE}) REGEXP ? OR lower({COL_ALT}) REGEXP ?)"
            ));
        } else {
            let like = like_escape(v);
            self.push_param(like.clone());
            self.push_param(like);
            self.clauses.push(format!(
                "(lower({COL_TITLE}) LIKE lower(?) ESCAPE '\\' OR lower({COL_ALT}) LIKE lower(?) ESCAPE '\\')"
            ));
        }
    }

    fn add_genre_token(&mut self, aliases: &[String], negate: bool, use_regex: bool) -> Option<String> {
        let aliases: Vec<&str> = aliases
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .collect();
        if aliases.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        for a in aliases {
            if use_regex {
                self.push_param(a.to_string());
                parts.push(format!("lower({COL_GENRES}) REGEXP ?"));
            } else {
                self.push_param(like_escape(a));
                parts.push(format!("lower({COL_GENRES}) LIKE lower(?) ESCAPE '\\'"));
            }
        }
        let inner = parts.join(" OR ");
        if negate {
            Some(format!("NOT ({inner})"))
        } else {
            Some(format!("({inner})"))
        }
    }

    fn from_adv(filter: &CatalogAdvFilter, query: &str) -> Self {
        let mut f = Self::new();
        let use_re = filter.use_regex;

        let q = query.trim();
        if !q.is_empty() {
            if use_re {
                f.push_param(q.to_string());
                f.push_param(q.to_string());
                f.clauses.push(
                    "(lower(m.title) REGEXP ? OR lower(m.alttitles) REGEXP ?)".into(),
                );
            } else {
                let like = like_escape(q);
                f.push_param(like.clone());
                f.push_param(like);
                f.clauses.push(
                    "(lower(m.title) LIKE lower(?) ESCAPE '\\' OR lower(m.alttitles) LIKE lower(?) ESCAPE '\\')".into(),
                );
            }
        }

        f.add_paired_title(&filter.title, use_re);
        f.add_text_field(COL_AUTHORS, &filter.authors, use_re);
        f.add_text_field(COL_ARTISTS, &filter.artists, use_re);
        f.add_text_field(COL_SUMMARY, &filter.summary, use_re);

        if filter.only_new && filter.new_days > 0 {
            let threshold = today_jdn() - filter.new_days;
            f.push_param(threshold);
            f.clauses
                .push("COALESCE(m.jdn, 0) > ? AND COALESCE(m.jdn, 0) > 0".into());
        }

        if filter.status >= 0 && filter.status <= 3 {
            let aliases: &[&str] = match filter.status {
                0 => &[
                    "0",
                    "completed",
                    "completo",
                    "completado",
                    "finalizado",
                    "tamat",
                ],
                1 => &[
                    "1",
                    "ongoing",
                    "en curso",
                    "en desarrollo",
                    "berjalan",
                    "releasing",
                ],
                2 => &["2", "hiatus", "pausado", "on hold"],
                3 => &["3", "cancelled", "canceled", "cancelado"],
                _ => &[],
            };
            let mut parts = Vec::new();
            for a in aliases {
                f.push_param(a.to_string());
                f.push_param(a.to_string());
                parts.push(format!(
                    "(lower(trim({COL_STATUS})) = ? OR lower({COL_STATUS}) LIKE '%' || ? || '%')"
                ));
            }
            if !parts.is_empty() {
                f.clauses.push(format!("({})", parts.join(" OR ")));
            }
        }

        let match_all = filter.match_mode != "one";
        let mut include_parts = Vec::new();
        for group in &filter.include_groups {
            if let Some(c) = f.add_genre_token(group, false, use_re) {
                include_parts.push(c);
            }
        }
        if !include_parts.is_empty() {
            let joiner = if match_all { " AND " } else { " OR " };
            f.clauses
                .push(format!("({})", include_parts.join(joiner)));
        }

        for alias in &filter.exclude_aliases {
            if let Some(c) = f.add_genre_token(&[alias.clone()], true, use_re) {
                f.clauses.push(c);
            }
        }

        f
    }

    fn where_sql(&self) -> String {
        let mut s = format!("WHERE {MASTERLIST_USABLE}");
        for c in &self.clauses {
            s.push_str(" AND ");
            s.push_str(c);
        }
        s
    }
}

fn existing_module_ids(module_ids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for id in module_ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        if catalog_db_path(id).exists() {
            out.push(id.to_string());
        }
        if out.len() >= MAX_ATTACH_SITES {
            break;
        }
    }
    out
}

fn branch_select_sql(table_prefix: &str, module_id: &str, where_sql: &str) -> String {
    let mid_lit = module_id.replace('\'', "''");
    format!(
        r#"SELECT
  m.link AS link,
  {COL_TITLE} AS title,
  {COL_ALT} AS alttitles,
  {COL_AUTHORS} AS authors,
  {COL_ARTISTS} AS artists,
  {COL_GENRES} AS genres,
  {COL_STATUS} AS status,
  {COL_SUMMARY} AS summary,
  CASE
    WHEN c.link IS NOT NULL AND IFNULL(c.title,'') = 'N/A' THEN COALESCE(m.numchapter, 0)
    WHEN c.link IS NOT NULL THEN COALESCE(c.numchapter, 0)
    ELSE COALESCE(m.numchapter, 0)
  END AS numchapter,
  COALESCE(m.jdn, 0) AS jdn,
  COALESCE(c.cover, '') AS cover,
  CASE WHEN IFNULL(c.title,'') = 'N/A' THEN 1 ELSE 0 END AS info_failed,
  '{mid_lit}' AS module_id
FROM {table_prefix}masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = '{mid_lit}'
{where_sql}"#
    )
}

fn branch_count_sql(table_prefix: &str, module_id: &str, where_sql: &str) -> String {
    let mid_lit = module_id.replace('\'', "''");
    format!(
        r#"SELECT m.link
FROM {table_prefix}masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = '{mid_lit}'
{where_sql}"#
    )
}

fn open_multi_catalog(ids: &[String]) -> Result<(Connection, Vec<String>), String> {
    if ids.is_empty() {
        return Err("sin módulos".into());
    }
    let conn = open_catalog(&ids[0])?;
    register_regexp(&conn)?;
    let _ = open_app_db()?;
    let app_path = sql_quote_path(&app_db_path());
    conn.execute(&format!("ATTACH DATABASE {app_path} AS appdb"), [])
        .map_err(|e| format!("ATTACH appdb: {e}"))?;

    let mut attached = vec![ids[0].clone()];
    for id in ids.iter().skip(1) {
        let path = catalog_db_path(id);
        let qpath = sql_quote_path(&path);
        let alias = sql_quote_ident(id);
        match conn.execute(&format!("ATTACH DATABASE {qpath} AS {alias}"), []) {
            Ok(_) => {
                attached.push(id.clone());
            }
            Err(e) => {
                // Stock SQLite often caps ATTACH at 10; fall back to merge path.
                let _ = conn.execute("DETACH DATABASE appdb", []);
                for a in attached.iter().skip(1).rev() {
                    let _ = conn.execute(
                        &format!("DETACH DATABASE {}", sql_quote_ident(a)),
                        [],
                    );
                }
                return Err(format!("ATTACH limit: {e}"));
            }
        }
    }
    Ok((conn, attached))
}

fn map_entry_all(r: &rusqlite::Row<'_>) -> rusqlite::Result<CatalogEntry> {
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
        module_id: r.get(12)?,
        module_name: String::new(),
    })
}

fn search_all_union(
    ids: &[String],
    query: &str,
    filter: &CatalogAdvFilter,
    limit: i64,
    offset: i64,
) -> Result<Vec<CatalogEntry>, String> {
    let (conn, attached) = open_multi_catalog(ids)?;
    let filter_sql = FilterSql::from_adv(filter, query);
    let where_sql = filter_sql.where_sql();

    let mut branches = Vec::new();
    for (i, id) in attached.iter().enumerate() {
        let prefix = if i == 0 {
            String::new()
        } else {
            format!("{}.", sql_quote_ident(id))
        };
        branches.push(branch_select_sql(&prefix, id, &where_sql));
    }
    let union_body = branches.join("\nUNION ALL\n");
    let sql = format!(
        "SELECT * FROM (\n{union_body}\n) ORDER BY title COLLATE NATCMP, link LIMIT ? OFFSET ?"
    );

    // Anonymous `?` per branch — repeat bound values for each UNION arm.
    let mut all_params: Vec<SqlValue> = Vec::new();
    for _ in 0..attached.len() {
        all_params.extend(filter_sql.params.iter().cloned());
    }
    all_params.push(SqlValue::Integer(limit));
    all_params.push(SqlValue::Integer(offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(all_params), map_entry_all)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }

    // Cleanup attaches (conn drop would too, but be explicit for WAL).
    let _ = conn.execute("DETACH DATABASE appdb", []);
    for a in attached.iter().skip(1).rev() {
        let _ = conn.execute(&format!("DETACH DATABASE {}", sql_quote_ident(a)), []);
    }
    Ok(out)
}

fn count_all_union(ids: &[String], query: &str, filter: &CatalogAdvFilter) -> Result<i64, String> {
    let (conn, attached) = open_multi_catalog(ids)?;
    let filter_sql = FilterSql::from_adv(filter, query);
    let where_sql = filter_sql.where_sql();

    let mut branches = Vec::new();
    for (i, id) in attached.iter().enumerate() {
        let prefix = if i == 0 {
            String::new()
        } else {
            format!("{}.", sql_quote_ident(id))
        };
        branches.push(branch_count_sql(&prefix, id, &where_sql));
    }
    let union_body = branches.join("\nUNION ALL\n");
    let sql = format!("SELECT COUNT(*) FROM (\n{union_body}\n)");

    let mut all_params: Vec<SqlValue> = Vec::new();
    for _ in 0..attached.len() {
        all_params.extend(filter_sql.params.iter().cloned());
    }

    let n: i64 = conn
        .query_row(&sql, params_from_iter(all_params), |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let _ = conn.execute("DETACH DATABASE appdb", []);
    for a in attached.iter().skip(1).rev() {
        let _ = conn.execute(&format!("DETACH DATABASE {}", sql_quote_ident(a)), []);
    }
    Ok(n)
}

fn search_all_merge(
    ids: &[String],
    query: &str,
    filter: &CatalogAdvFilter,
    limit: i64,
    offset: i64,
) -> Result<Vec<CatalogEntry>, String> {
    let fetch_n = (offset + limit).max(1);
    let mut streams: Vec<std::collections::VecDeque<CatalogEntry>> = Vec::new();
    for id in ids {
        let rows = search_filtered_module(id, query, filter, fetch_n, 0)?;
        streams.push(rows.into());
    }

    let mut out = Vec::with_capacity(limit as usize);
    let mut skipped = 0i64;
    loop {
        let mut best_i: Option<usize> = None;
        for (i, s) in streams.iter().enumerate() {
            if let Some(front) = s.front() {
                best_i = match best_i {
                    None => Some(i),
                    Some(j) => {
                        let a = &streams[j].front().unwrap().title;
                        let b = &front.title;
                        match nat_cmp(a, b) {
                            Ordering::Greater => Some(i),
                            Ordering::Equal => {
                                let al = &streams[j].front().unwrap().link;
                                if front.link < *al {
                                    Some(i)
                                } else {
                                    Some(j)
                                }
                            }
                            Ordering::Less => Some(j),
                        }
                    }
                };
            }
        }
        let Some(i) = best_i else { break };
        let row = streams[i].pop_front().unwrap();
        if skipped < offset {
            skipped += 1;
            continue;
        }
        out.push(row);
        if out.len() as i64 >= limit {
            break;
        }
    }
    Ok(out)
}

fn search_filtered_module(
    module_id: &str,
    query: &str,
    filter: &CatalogAdvFilter,
    limit: i64,
    offset: i64,
) -> Result<Vec<CatalogEntry>, String> {
    let path = catalog_db_path(module_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_catalog(module_id)?;
    register_regexp(&conn)?;
    let _attach = AppDbAttach::attach(&conn)?;
    let filter_sql = FilterSql::from_adv(filter, query);
    let where_sql = filter_sql.where_sql();
    let mid_lit = module_id.replace('\'', "''");
    let sql = format!(
        r#"SELECT
  m.link,
  {COL_TITLE},
  {COL_ALT},
  {COL_AUTHORS},
  {COL_ARTISTS},
  {COL_GENRES},
  {COL_STATUS},
  {COL_SUMMARY},
  CASE
    WHEN c.link IS NOT NULL AND IFNULL(c.title,'') = 'N/A' THEN COALESCE(m.numchapter, 0)
    WHEN c.link IS NOT NULL THEN COALESCE(c.numchapter, 0)
    ELSE COALESCE(m.numchapter, 0)
  END,
  COALESCE(m.jdn, 0),
  COALESCE(c.cover, ''),
  CASE WHEN IFNULL(c.title,'') = 'N/A' THEN 1 ELSE 0 END,
  '{mid_lit}' AS module_id
FROM masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = '{mid_lit}'
{where_sql}
ORDER BY m.title COLLATE NATCMP, m.link
LIMIT ? OFFSET ?"#,
    );

    let mut all_params = filter_sql.params.clone();
    all_params.push(SqlValue::Integer(limit));
    all_params.push(SqlValue::Integer(offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(all_params), map_entry_all)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn count_filtered_module(
    module_id: &str,
    query: &str,
    filter: &CatalogAdvFilter,
) -> Result<i64, String> {
    let path = catalog_db_path(module_id);
    if !path.exists() {
        return Ok(0);
    }
    let conn = open_catalog(module_id)?;
    register_regexp(&conn)?;
    let _attach = AppDbAttach::attach(&conn)?;
    let filter_sql = FilterSql::from_adv(filter, query);
    let where_sql = filter_sql.where_sql();
    let mid_lit = module_id.replace('\'', "''");
    let sql = format!(
        r#"SELECT COUNT(*)
FROM masterlist m
LEFT JOIN appdb.manga_cache c ON c.link = m.link AND c.module_id = '{mid_lit}'
{where_sql}"#
    );
    conn.query_row(&sql, params_from_iter(filter_sql.params), |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn count_all_merge(ids: &[String], query: &str, filter: &CatalogAdvFilter) -> Result<i64, String> {
    let mut total = 0i64;
    for id in ids {
        total += count_filtered_module(id, query, filter)?;
    }
    Ok(total)
}

/// FMD2 FilterAllSites: search across module DBs with SQL filters + pagination.
pub fn search_all(
    module_ids: &[String],
    query: &str,
    filter: &CatalogAdvFilter,
    limit: i64,
    offset: i64,
) -> Result<Vec<CatalogEntry>, String> {
    let ids = existing_module_ids(module_ids);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    match search_all_union(&ids, query, filter, limit, offset) {
        Ok(v) => Ok(v),
        Err(_e) => search_all_merge(&ids, query, filter, limit, offset),
    }
}

/// Count rows matching `search_all` filters.
pub fn count_all(
    module_ids: &[String],
    query: &str,
    filter: &CatalogAdvFilter,
) -> Result<i64, String> {
    let ids = existing_module_ids(module_ids);
    if ids.is_empty() {
        return Ok(0);
    }
    match count_all_union(&ids, query, filter) {
        Ok(n) => Ok(n),
        Err(_e) => count_all_merge(&ids, query, filter),
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
        module_id: String::new(),
        module_name: String::new(),
    })
}

/// Insert title+link rows (FMD UpdateList “no info” style). Returns inserted count.
/// New rows get `jdn = today` (FMD2); existing rows keep their jdn via INSERT OR IGNORE.
pub fn upsert_links(module_id: &str, pairs: &[(String, String)]) -> Result<usize, String> {
    let conn = open_catalog(module_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let jdn = today_jdn();
    let mut inserted = 0usize;
    {
        let mut stmt = tx
            .prepare(
                r#"INSERT OR IGNORE INTO masterlist(link, title, alttitles, authors, artists, genres, status, summary, numchapter, jdn)
                   VALUES(?1, ?2, '', '', '', '', '', '', 0, ?3)"#,
            )
            .map_err(|e| e.to_string())?;
        for (link, title) in pairs {
            let link = normalize_manga_link(link);
            if link.is_empty() {
                continue;
            }
            let n = stmt
                .execute(params![link, title, jdn])
                .map_err(|e| e.to_string())?;
            inserted += n;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// All normalized links currently in masterlist (for Update List staging).
pub fn masterlist_link_set(module_id: &str) -> Result<std::collections::HashSet<String>, String> {
    let path = catalog_db_path(module_id);
    let mut out = std::collections::HashSet::new();
    if !path.exists() {
        return Ok(out);
    }
    let conn = open_catalog(module_id)?;
    let mut stmt = conn
        .prepare("SELECT link FROM masterlist")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let link = row.map_err(|e| e.to_string())?;
        let n = normalize_manga_link(&link);
        if !n.is_empty() {
            link_set_insert(&mut out, &n);
        }
    }
    Ok(out)
}

/// Full masterlist row insert (GetInfo path). Returns true if a new row was inserted.
pub fn insert_full(
    module_id: &str,
    link: &str,
    title: &str,
    alt_titles: &str,
    authors: &str,
    artists: &str,
    genres: &str,
    status: &str,
    summary: &str,
    numchapter: i64,
) -> Result<bool, String> {
    let link = normalize_manga_link(link);
    if link.is_empty() {
        return Ok(false);
    }
    let conn = open_catalog(module_id)?;
    let jdn = today_jdn();
    let n = conn
        .execute(
            r#"INSERT OR IGNORE INTO masterlist(
                 link, title, alttitles, authors, artists, genres, status, summary, numchapter, jdn
               ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                link,
                title,
                alt_titles,
                authors,
                artists,
                genres,
                status,
                summary,
                numchapter,
                jdn
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
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

pub fn title_is_na(title: &str) -> bool {
    let t = title.trim();
    t.is_empty() || t.eq_ignore_ascii_case("N/A")
}

fn is_cache_fail_title(title: &str) -> bool {
    title_is_na(title)
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

/// Import an existing FMD2-compatible `.db`, **replacing** the local catalog file (FMD2 DBUpdater).
pub fn import_file(module_id: &str, src: &Path) -> Result<CatalogStats, String> {
    if !src.exists() {
        return Err(format!("No existe: {}", src.display()));
    }

    // Validate source has masterlist before wiping local.
    {
        let probe = Connection::open(src).map_err(|e| e.to_string())?;
        let has_table: bool = probe
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='masterlist' LIMIT 1",
                [],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if !has_table {
            return Err("El archivo no tiene tabla masterlist (¿es un .db de FMD2?)".into());
        }
    }

    std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let dest = catalog_db_path(module_id);
    let dest_s = dest.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&dest);
    let _ = std::fs::remove_file(format!("{dest_s}-wal"));
    let _ = std::fs::remove_file(format!("{dest_s}-shm"));
    std::fs::copy(src, &dest).map_err(|e| format!("No se pudo reemplazar el catálogo: {e}"))?;
    // Ensure WAL / indexes our code expects.
    let _ = open_catalog(module_id)?;
    stats(module_id)
}

/// Normalize manga URL/path like FMD2 `RemoveHostFromURL` / `SplitURL`.
/// Result is a path starting with `/` (plus optional `?query`).
pub fn normalize_manga_link(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    let raw = if let Ok(u) = url::Url::parse(url) {
        let path = u.path().to_string();
        let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
        if path.is_empty() {
            format!("/{query}")
        } else {
            format!("{path}{query}")
        }
    } else if let Some(rest) = url.strip_prefix("//") {
        // protocol-relative
        if let Ok(u) = url::Url::parse(&format!("https://{rest}")) {
            let path = u.path().to_string();
            let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            if path.is_empty() {
                format!("/{query}")
            } else {
                format!("{path}{query}")
            }
        } else {
            url.to_string()
        }
    } else {
        url.to_string()
    };
    let raw = raw.trim();
    if raw.is_empty() || raw == "?" {
        return String::new();
    }
    if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    }
}

/// FMD2 compares exact strings; sites sometimes differ only by a trailing `/`.
pub fn link_lookup_keys(norm: &str) -> Vec<String> {
    if norm.is_empty() {
        return Vec::new();
    }
    let mut keys = vec![norm.to_string()];
    if let Some((path, query)) = norm.split_once('?') {
        let alt_path = if path.len() > 1 && path.ends_with('/') {
            path.trim_end_matches('/').to_string()
        } else if path.is_empty() {
            path.to_string()
        } else {
            format!("{path}/")
        };
        let alt = if query.is_empty() {
            alt_path
        } else {
            format!("{alt_path}?{query}")
        };
        if alt != norm {
            keys.push(alt);
        }
    } else if norm.len() > 1 && norm.ends_with('/') {
        keys.push(norm.trim_end_matches('/').to_string());
    } else {
        keys.push(format!("{norm}/"));
    }
    keys
}

pub fn link_set_contains(set: &std::collections::HashSet<String>, norm: &str) -> bool {
    link_lookup_keys(norm).into_iter().any(|k| set.contains(&k))
}

pub fn link_set_insert(set: &mut std::collections::HashSet<String>, norm: &str) {
    for k in link_lookup_keys(norm) {
        set.insert(k);
    }
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
    fn upsert_links_stamps_today_jdn() {
        let mid = "__test_jdn_stamp__";
        let link = "/series/new_today/";
        let path = catalog_db_path(mid);
        let _ = std::fs::remove_file(&path);
        upsert_links(mid, &[(link.into(), "Brand New".into())]).expect("insert");
        let hits = search(mid, "", 10, 0).expect("search");
        let e = hits.iter().find(|e| e.link == normalize_manga_link(link)).expect("row");
        assert_eq!(e.jdn, today_jdn());
        assert_eq!(e.module_id, mid);
        // second insert must not overwrite jdn
        let old = e.jdn;
        std::thread::sleep(std::time::Duration::from_millis(10));
        upsert_links(mid, &[(link.into(), "Brand New".into())]).expect("ignore");
        let hits2 = search(mid, "", 10, 0).expect("search2");
        let e2 = hits2.iter().find(|e| e.link == normalize_manga_link(link)).expect("row2");
        assert_eq!(e2.jdn, old);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn date_to_jdn_matches_known_day() {
        // 2025-03-29 → 2460764 (from FMD2 MangaOni sample)
        assert_eq!(date_to_jdn(2025, 3, 29), 2460764);
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

    #[test]
    fn normalize_manga_link_matches_fmd2_strip_host() {
        assert_eq!(
            normalize_manga_link("https://manga-oni.com/manga/foo/"),
            "/manga/foo/"
        );
        assert_eq!(normalize_manga_link("/manga/foo/"), "/manga/foo/");
        assert_eq!(normalize_manga_link("manga/foo/"), "/manga/foo/");
        let mut set = std::collections::HashSet::new();
        link_set_insert(&mut set, "/manga/foo/");
        assert!(link_set_contains(&set, "/manga/foo"));
        assert!(link_set_contains(&set, "/manga/foo/"));
    }

    #[test]
    fn search_all_merges_modules_and_filters() {
        let a = "testalla000000000000000000000001";
        let b = "testallb000000000000000000000002";
        let _ = std::fs::remove_file(catalog_db_path(a));
        let _ = std::fs::remove_file(catalog_db_path(b));
        upsert_links(
            a,
            &[
                ("/a/same/".into(), "Same Title".into()),
                ("/a/only/".into(), "Alpha Only".into()),
            ],
        )
        .expect("a");
        upsert_links(
            b,
            &[
                ("/b/same/".into(), "Same Title".into()),
                ("/b/only/".into(), "Beta Only".into()),
            ],
        )
        .expect("b");

        assert_eq!(search(a, "", 50, 0).expect("sa").len(), 2);
        assert_eq!(search(b, "", 50, 0).expect("sb").len(), 2);
        assert!(catalog_db_path(a).exists());
        assert!(catalog_db_path(b).exists());

        let filter = CatalogAdvFilter::default();
        let ids = vec![a.to_string(), b.to_string()];
        let n = count_all(&ids, "", &filter).unwrap_or_else(|e| panic!("count_all: {e}"));
        assert_eq!(n, 4, "count_all");
        let all = search_all(&ids, "", &filter, 50, 0).unwrap_or_else(|e| panic!("search_all: {e}"));
        assert_eq!(all.len(), 4);
        let same: Vec<_> = all.iter().filter(|e| e.title == "Same Title").collect();
        assert_eq!(same.len(), 2);
        assert!(same.iter().any(|e| e.module_id == a));
        assert!(same.iter().any(|e| e.module_id == b));

        let q = search_all(&ids, "Alpha", &filter, 50, 0).expect("q");
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].title, "Alpha Only");
        assert_eq!(q[0].module_id, a);

        let _ = std::fs::remove_file(catalog_db_path(a));
        let _ = std::fs::remove_file(catalog_db_path(b));
    }
}
