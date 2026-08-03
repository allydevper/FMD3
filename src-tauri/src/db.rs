use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

pub type Db = Arc<Mutex<Connection>>;

/// Directory containing the running executable (portable default for "Guardar en").
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Saved `default_output_dir`, or exe directory when unset.
pub fn resolve_output_dir(db: &Db) -> Result<String, String> {
    let saved = settings_get(db, "default_output_dir")?.unwrap_or_default();
    let t = saved.trim();
    if !t.is_empty() {
        return Ok(t.to_string());
    }
    Ok(exe_dir().to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Favorite {
    pub id: i64,
    pub module_id: String,
    pub module_name: String,
    pub root_url: String,
    pub manga_url: String,
    pub title: String,
    pub last_chapter_link: String,
    pub last_chapter_name: String,
    pub chapter_count: i64,
    pub updated_at: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_checked_at: String,
    /// Multiline chapter links already acknowledged (FMD2 DownloadedChapterList).
    #[serde(default)]
    pub seen_chapter_links: String,
    /// Multiline chapter links from the last check-only pass, awaiting enqueue.
    #[serde(default)]
    pub pending_new_links: String,
    #[serde(default)]
    pub date_added: String,
    /// Series status from last GetInfo (ongoing / completed / …).
    #[serde(default)]
    pub status: String,
    /// Last time new chapters were accepted (enqueued / download-after).
    #[serde(default)]
    pub last_updated_at: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItem {
    pub id: i64,
    pub manga_title: String,
    pub root_url: String,
    pub manga_url: String,
    pub module_id: String,
    pub chapter_index: i64,
    pub chapter_name: String,
    pub chapter_link: String,
    pub output_dir: String,
    /// Manga folder resolved at enqueue time (empty = legacy, resolve live).
    #[serde(default)]
    pub manga_path: String,
    /// Chapter folder resolved at enqueue time (empty = legacy, resolve live).
    #[serde(default)]
    pub chapter_path: String,
    /// Chapter title after strip + pad, frozen at enqueue so the filenames match
    /// the folder even if the rename settings change meanwhile.
    /// Empty = legacy, resolve live.
    #[serde(default)]
    pub chapter_display: String,
    /// Split-download batch id (empty = group by manga only).
    #[serde(default)]
    pub batch_id: String,
    /// Pack format frozen at enqueue (`none`/`pdf`/`cbz`/…). Empty = legacy (use current setting).
    #[serde(default)]
    pub pack_format: String,
    pub status: String,
    pub error: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub retry_count: i64,
    #[serde(default)]
    pub position: i64,
}

#[derive(Debug, Clone)]
pub struct NewQueueItem {
    pub manga_title: String,
    pub root_url: String,
    pub manga_url: String,
    pub module_id: String,
    pub chapter_index: i64,
    pub chapter_name: String,
    pub chapter_link: String,
    pub output_dir: String,
    pub manga_path: String,
    pub chapter_path: String,
    pub chapter_display: String,
    pub batch_id: String,
    pub pack_format: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn map_favorite(r: &rusqlite::Row<'_>) -> rusqlite::Result<Favorite> {
    Ok(Favorite {
        id: r.get(0)?,
        module_id: r.get(1)?,
        module_name: r.get(2)?,
        root_url: r.get(3)?,
        manga_url: r.get(4)?,
        title: r.get(5)?,
        last_chapter_link: r.get(6)?,
        last_chapter_name: r.get(7)?,
        chapter_count: r.get(8)?,
        updated_at: r.get(9)?,
        enabled: r.get::<_, i64>(10)? != 0,
        last_checked_at: r.get(11)?,
        seen_chapter_links: r.get(12)?,
        pending_new_links: r.get(13)?,
        date_added: r.get(14)?,
        status: r.get(15)?,
        last_updated_at: r.get(16)?,
    })
}

fn map_queue_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<QueueItem> {
    Ok(QueueItem {
        id: r.get(0)?,
        manga_title: r.get(1)?,
        root_url: r.get(2)?,
        manga_url: r.get(3)?,
        module_id: r.get(4)?,
        chapter_index: r.get(5)?,
        chapter_name: r.get(6)?,
        chapter_link: r.get(7)?,
        output_dir: r.get(8)?,
        manga_path: r.get(9)?,
        chapter_path: r.get(10)?,
        batch_id: r.get(11)?,
        pack_format: r.get(12)?,
        status: r.get(13)?,
        error: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        retry_count: r.get(17)?,
        position: r.get(18)?,
        chapter_display: r.get(19)?,
    })
}

const FAVORITE_SELECT: &str = "SELECT id, module_id, module_name, root_url, manga_url, title,
        last_chapter_link, last_chapter_name, chapter_count, updated_at,
        COALESCE(enabled, 1), COALESCE(last_checked_at, ''),
        COALESCE(seen_chapter_links, ''), COALESCE(pending_new_links, ''),
        COALESCE(date_added, ''), COALESCE(status, ''), COALESCE(last_updated_at, '')
 FROM favorites";

const QUEUE_SELECT: &str = "SELECT id, manga_title, root_url, COALESCE(manga_url,''), COALESCE(module_id,''),
        chapter_index, chapter_name, chapter_link,
        output_dir, COALESCE(manga_path,''), COALESCE(chapter_path,''), COALESCE(batch_id,''),
        COALESCE(pack_format,''),
        status, error, created_at, updated_at,
        COALESCE(retry_count, 0), COALESCE(position, 0),
        COALESCE(chapter_display,'')
 FROM queue_items";

pub fn db_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fmd-mvp")
}

pub fn userdata_path() -> PathBuf {
    db_path().join("userdata")
}

pub fn favorites_db_path() -> PathBuf {
    userdata_path().join("favorites.db")
}

pub fn downloaded_db_path() -> PathBuf {
    userdata_path().join("downloaded.db")
}

const USERDATA_SPLIT_KEY: &str = "db.userdata_split";
const SEEN_BACKFILL_KEY: &str = "db.favorites_seen_backfilled";

const DOWNLOADED_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS downloaded_chapters (
    module_id TEXT NOT NULL,
    manga_url TEXT NOT NULL,
    chapter_link TEXT NOT NULL,
    downloaded_at TEXT NOT NULL,
    PRIMARY KEY (module_id, manga_url, chapter_link)
);
CREATE INDEX IF NOT EXISTS idx_downloaded_chapters_manga
    ON downloaded_chapters(module_id, manga_url);
"#;

const FAVORITES_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    root_url TEXT NOT NULL,
    manga_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    last_chapter_link TEXT NOT NULL DEFAULT '',
    last_chapter_name TEXT NOT NULL DEFAULT '',
    chapter_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT NOT NULL DEFAULT '',
    seen_chapter_links TEXT NOT NULL DEFAULT '',
    pending_new_links TEXT NOT NULL DEFAULT '',
    date_added TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    last_updated_at TEXT NOT NULL DEFAULT ''
);
"#;

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        PRAGMA synchronous=NORMAL;
        "#,
    )
    .map_err(|e| e.to_string())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Open main app DB (`fmd-mvp.db`): settings, queue, manga_cache. Favorites and
/// downloaded marks live in their own files under `userdata/`.
pub fn open_db() -> Result<Db, String> {
    let dir = db_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("fmd-mvp.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    configure_connection(&conn)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS queue_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            manga_title TEXT NOT NULL,
            root_url TEXT NOT NULL,
            manga_url TEXT NOT NULL DEFAULT '',
            module_id TEXT NOT NULL DEFAULT '',
            chapter_index INTEGER NOT NULL,
            chapter_name TEXT NOT NULL,
            chapter_link TEXT NOT NULL,
            output_dir TEXT NOT NULL,
            manga_path TEXT NOT NULL DEFAULT '',
            chapter_path TEXT NOT NULL DEFAULT '',
            batch_id TEXT NOT NULL DEFAULT '',
            pack_format TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL DEFAULT 0,
            chapter_display TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status);
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
        CREATE TABLE IF NOT EXISTS catalog_hidden (
            module_id TEXT NOT NULL,
            link TEXT NOT NULL,
            hidden_at TEXT NOT NULL,
            snapshot TEXT,
            PRIMARY KEY (module_id, link)
        );
        "#,
    )
    .map_err(|e| e.to_string())?;
    // Migrations for older DBs
    let _ = conn.execute("ALTER TABLE catalog_hidden ADD COLUMN snapshot TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN module_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN manga_url TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN manga_path TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN chapter_path TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN pack_format TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE queue_items ADD COLUMN chapter_display TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN title TEXT", []);
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN alt_titles TEXT", []);
    Ok(Arc::new(Mutex::new(conn)))
}

/// Open portable downloaded-marks DB (`userdata/downloaded.db`).
pub fn open_downloaded_db() -> Result<Db, String> {
    let dir = userdata_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(downloaded_db_path()).map_err(|e| e.to_string())?;
    configure_connection(&conn)?;
    conn.execute_batch(DOWNLOADED_DDL)
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// Open portable favorites DB (`userdata/favorites.db`).
pub fn open_favorites_db() -> Result<Db, String> {
    let dir = userdata_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = favorites_db_path();
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    configure_connection(&conn)?;
    conn.execute_batch(FAVORITES_DDL)
        .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN last_checked_at TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN seen_chapter_links TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN pending_new_links TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN date_added TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN status TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN last_updated_at TEXT NOT NULL DEFAULT ''",
        [],
    );
    // NOTE: `last_chapter_link` is a tip cursor ("newest chapter the site had at
    // the last check"), not a seen list. Seeding it into `seen_chapter_links`
    // would make the set-based detection report every other chapter as new, and
    // would mark a tip the user never downloaded as seen. The real seen list is
    // backfilled from `downloaded_chapters` in `backfill_seen_from_downloaded`.
    let _ = conn.execute_batch(
        r#"
        UPDATE favorites
        SET date_added = updated_at
        WHERE TRIM(COALESCE(date_added, '')) = ''
          AND TRIM(COALESCE(updated_at, '')) != '';
        "#,
    );
    Ok(Arc::new(Mutex::new(conn)))
}

/// One-shot: copy `favorites` from main DB into userdata, then drop the old table.
fn migrate_favorites_from_main(main: &Db, favorites: &Db) -> Result<(), String> {
    if settings_get(main, USERDATA_SPLIT_KEY)?
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
    {
        return Ok(());
    }

    let main_has = {
        let conn = main.lock();
        table_exists(&conn, "favorites")?
    };

    if !main_has {
        settings_set(main, USERDATA_SPLIT_KEY, "1")?;
        return Ok(());
    }

    let fav_count = {
        let fconn = favorites.lock();
        fconn
            .query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
    };

    let main_rows = favorites_list(main)?;
    if !main_rows.is_empty() && fav_count == 0 {
        let fconn = favorites.lock();
        for fav in &main_rows {
            let seen = if fav.seen_chapter_links.trim().is_empty() {
                fav.last_chapter_link.as_str()
            } else {
                fav.seen_chapter_links.as_str()
            };
            let date_added = if fav.date_added.trim().is_empty() {
                fav.updated_at.as_str()
            } else {
                fav.date_added.as_str()
            };
            fconn
                .execute(
                    "INSERT INTO favorites(
                        id, module_id, module_name, root_url, manga_url, title,
                        last_chapter_link, last_chapter_name, chapter_count, updated_at,
                        enabled, last_checked_at, seen_chapter_links, pending_new_links,
                        date_added, status, last_updated_at
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                    params![
                        fav.id,
                        fav.module_id,
                        fav.module_name,
                        fav.root_url,
                        fav.manga_url,
                        fav.title,
                        fav.last_chapter_link,
                        fav.last_chapter_name,
                        fav.chapter_count,
                        fav.updated_at,
                        if fav.enabled { 1 } else { 0 },
                        fav.last_checked_at,
                        seen,
                        fav.pending_new_links,
                        date_added,
                        fav.status,
                        fav.last_updated_at,
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
    }

    {
        let conn = main.lock();
        conn.execute_batch("DROP TABLE IF EXISTS favorites;")
            .map_err(|e| e.to_string())?;
    }

    settings_set(main, USERDATA_SPLIT_KEY, "1")?;
    Ok(())
}

/// True when `seen` still holds a legacy tip cursor rather than a real seen list:
/// either empty, or a single line equal to `last_chapter_link`.
fn seen_is_legacy_cursor(fav: &Favorite) -> bool {
    let lines: Vec<&str> = fav
        .seen_chapter_links
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    match lines.len() {
        0 => true,
        1 => {
            let tip = link_mark_key(&fav.last_chapter_link);
            !tip.is_empty() && link_mark_key(lines[0]) == tip
        }
        _ => false,
    }
}

/// One-shot: rebuild `seen_chapter_links` from `downloaded_chapters`, the real
/// equivalent of FMD2's DownloadedChapterList.
///
/// Pre-split installs only stored `last_chapter_link`, a tip cursor. Under the
/// set-based detection that single link would make every *other* chapter look
/// new, so we drop it and use what was actually downloaded. Favorites with a
/// genuine multi-line list are left alone; ones with nothing downloaded end up
/// with an empty `seen`, so the next check reports the whole series as new.
fn backfill_seen_from_downloaded(main: &Db, favorites: &Db, downloaded: &Db) -> Result<(), String> {
    if settings_get(main, SEEN_BACKFILL_KEY)?
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
    {
        return Ok(());
    }

    for fav in favorites_list(favorites)? {
        if !seen_is_legacy_cursor(&fav) {
            continue;
        }
        let links = downloaded_chapters_list(downloaded, &fav.module_id, &fav.manga_url)?;
        let seen = join_chapter_links(&links);
        // Pending was computed against the bogus cursor; drop it so the badge
        // reflects the next real check instead of stale counts.
        let conn = favorites.lock();
        conn.execute(
            "UPDATE favorites SET seen_chapter_links=?1, pending_new_links='' WHERE id=?2",
            params![seen, fav.id],
        )
        .map_err(|e| e.to_string())?;
    }

    settings_set(main, SEEN_BACKFILL_KEY, "1")?;
    Ok(())
}

/// Open main + favorites + downloaded-marks DBs.
///
/// `userdata/downloaded.db` starts empty on existing installs: there is no migration
/// from the old main-DB table, so previously downloaded chapters show as unmarked
/// until they are downloaded again.
pub fn open_app_dbs() -> Result<(Db, Db, Db), String> {
    let main = open_db()?;
    let favorites = open_favorites_db()?;
    migrate_favorites_from_main(&main, &favorites)?;
    let downloaded = open_downloaded_db()?;
    backfill_seen_from_downloaded(&main, &favorites, &downloaded)?;
    Ok((main, favorites, downloaded))
}

pub fn settings_get(db: &Db, key: &str) -> Result<Option<String>, String> {
    let conn = db.lock();
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Read a setting without holding QueueState (used by HttpClient / FlareSolverr).
pub fn settings_get_direct(key: &str) -> Result<Option<String>, String> {
    let dir = db_path();
    let path = dir.join("fmd-mvp.db");
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Write a setting without QueueState (cookie/UA persistence from HttpClient).
pub fn settings_set_direct(key: &str, value: &str) -> Result<(), String> {
    let dir = db_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("fmd-mvp.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn settings_set(db: &Db, key: &str, value: &str) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn favorites_list(db: &Db) -> Result<Vec<Favorite>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(&format!("{FAVORITE_SELECT} ORDER BY updated_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_favorite)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Join chapter links into a multiline list (FMD2-style), deduped by mark key.
pub fn join_chapter_links(links: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for link in links {
        let key = link_mark_key(link);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(link.trim().to_string());
    }
    out.join("\n")
}

/// Parse a multiline link list into canonical mark keys.
pub fn parse_seen_keys(text: &str) -> std::collections::HashSet<String> {
    text.lines()
        .map(|l| link_mark_key(l))
        .filter(|k| !k.is_empty())
        .collect()
}

/// Merge new links into an existing multiline seen list (case-insensitive by key).
pub fn merge_chapter_links(existing: &str, new_links: &[String]) -> String {
    let mut keys = parse_seen_keys(existing);
    let mut out: Vec<String> = existing
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    for link in new_links {
        let key = link_mark_key(link);
        if key.is_empty() || !keys.insert(key) {
            continue;
        }
        out.push(link.trim().to_string());
    }
    out.join("\n")
}

#[cfg(test)]
pub fn count_link_lines(text: &str) -> usize {
    text.lines().filter(|l| !l.trim().is_empty()).count()
}

pub fn favorites_add(
    db: &Db,
    module_id: &str,
    module_name: &str,
    root_url: &str,
    manga_url: &str,
    title: &str,
    last_chapter_link: &str,
    last_chapter_name: &str,
    chapter_count: i64,
    seen_chapter_links: &str,
) -> Result<Favorite, String> {
    let ts = now();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO favorites(
            module_id, module_name, root_url, manga_url, title,
            last_chapter_link, last_chapter_name, chapter_count, updated_at,
            enabled, last_checked_at, seen_chapter_links, pending_new_links,
            date_added, status, last_updated_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,'',?10,'',?9,'','')
         ON CONFLICT(manga_url) DO UPDATE SET
            module_id=excluded.module_id,
            module_name=excluded.module_name,
            root_url=excluded.root_url,
            title=excluded.title,
            -- Never downgrade progress with an empty payload: an import that
            -- carries no chapter data must not wipe what the user already has.
            last_chapter_link=CASE WHEN TRIM(excluded.last_chapter_link) != ''
                THEN excluded.last_chapter_link ELSE favorites.last_chapter_link END,
            last_chapter_name=CASE WHEN TRIM(excluded.last_chapter_link) != ''
                THEN excluded.last_chapter_name ELSE favorites.last_chapter_name END,
            chapter_count=CASE WHEN excluded.chapter_count > 0
                THEN excluded.chapter_count ELSE favorites.chapter_count END,
            seen_chapter_links=CASE WHEN TRIM(excluded.seen_chapter_links) != ''
                THEN excluded.seen_chapter_links ELSE favorites.seen_chapter_links END,
            pending_new_links=CASE WHEN TRIM(excluded.seen_chapter_links) != ''
                THEN '' ELSE favorites.pending_new_links END,
            updated_at=excluded.updated_at",
        params![
            module_id,
            module_name,
            root_url,
            manga_url,
            title,
            last_chapter_link,
            last_chapter_name,
            chapter_count,
            ts,
            seen_chapter_links,
        ],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        &format!("{FAVORITE_SELECT} WHERE manga_url = ?1"),
        params![manga_url],
        map_favorite,
    )
    .map_err(|e| e.to_string())
}

/// Restore timestamps carried by an export. Empty values are ignored so a
/// partial JSON never resets the dates already stored.
pub fn favorites_restore_timestamps(
    db: &Db,
    manga_url: &str,
    date_added: &str,
    last_checked_at: &str,
) -> Result<(), String> {
    let date_added = date_added.trim();
    let last_checked_at = last_checked_at.trim();
    if date_added.is_empty() && last_checked_at.is_empty() {
        return Ok(());
    }
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET
            date_added = CASE WHEN ?2 != '' THEN ?2 ELSE date_added END,
            last_checked_at = CASE WHEN ?3 != '' THEN ?3 ELSE last_checked_at END
         WHERE manga_url = ?1",
        params![manga_url, date_added, last_checked_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore `last_updated_at` / `status` from an import. Kept separate from
/// `favorites_restore_timestamps` so that signature and its tests stay put.
/// Empty values are ignored, so a partial source never clears what is stored.
pub fn favorites_restore_meta(
    db: &Db,
    manga_url: &str,
    last_updated_at: &str,
    status: &str,
) -> Result<(), String> {
    let ts = last_updated_at.trim();
    let status = status.trim();
    if ts.is_empty() && status.is_empty() {
        return Ok(());
    }
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET
            last_updated_at = CASE WHEN ?2 != '' THEN ?2 ELSE last_updated_at END,
            status = CASE WHEN ?3 != '' THEN ?3 ELSE status END
         WHERE manga_url = ?1",
        params![manga_url, ts, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy a live DB file to `dest`, WAL included.
///
/// The lock is held across checkpoint *and* copy: the running app writes through a
/// WAL, so copying the bare file would silently drop everything not yet merged, and
/// a writer slipping in between the two steps would tear the copy.
pub fn export_copy(db: &Db, src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let conn = db.lock();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .map_err(|e| format!("no se pudo consolidar el WAL: {e}"))?;
    std::fs::copy(src, dest)
        .map(|_| ())
        .map_err(|e| format!("no se pudo escribir {}: {e}", dest.display()))
}

pub fn downloaded_chapters_count(db: &Db) -> Result<i64, String> {
    let conn = db.lock();
    conn.query_row("SELECT COUNT(*) FROM downloaded_chapters", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// `(module_id, canonical path key) -> stored manga_url`, so an importer can reuse
/// the URL form already in the table instead of inserting a near-duplicate row
/// (`manga_url` is UNIQUE, and trailing-slash / host variants would slip past it).
pub fn favorites_path_key_index(
    db: &Db,
) -> Result<std::collections::HashMap<(String, String), String>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare("SELECT module_id, manga_url FROM favorites")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::HashMap::new();
    for row in rows {
        let (module_id, manga_url) = row.map_err(|e| e.to_string())?;
        let key = link_mark_key(&manga_url);
        if key.is_empty() {
            continue;
        }
        out.insert((module_id, key), manga_url);
    }
    Ok(out)
}

pub fn favorites_get(db: &Db, id: i64) -> Result<Favorite, String> {
    let conn = db.lock();
    conn.query_row(
        &format!("{FAVORITE_SELECT} WHERE id = ?1"),
        params![id],
        map_favorite,
    )
    .map_err(|e| e.to_string())
}

pub fn favorites_set_enabled(db: &Db, id: i64, enabled: bool) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET enabled=?1, updated_at=?2 WHERE id=?3",
        params![if enabled { 1 } else { 0 }, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn favorites_touch_checked(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET last_checked_at=?1 WHERE id=?2",
        params![now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// After a check-only pass: refresh UI fields + pending list; do NOT touch seen.
pub fn favorites_update_after_check(
    db: &Db,
    id: i64,
    last_chapter_link: &str,
    last_chapter_name: &str,
    chapter_count: i64,
    status: &str,
    pending_new_links: &str,
) -> Result<(), String> {
    let ts = now();
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET last_chapter_link=?1, last_chapter_name=?2,
         chapter_count=?3, status=?4, pending_new_links=?5,
         last_checked_at=?6 WHERE id=?7",
        params![
            last_chapter_link,
            last_chapter_name,
            chapter_count,
            status,
            pending_new_links,
            ts,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// After enqueueing new chapters: merge into seen, clear pending, bump last_updated_at.
pub fn favorites_acknowledge_chapters(
    db: &Db,
    id: i64,
    seen_chapter_links: &str,
    last_chapter_link: &str,
    last_chapter_name: &str,
    chapter_count: i64,
    status: &str,
) -> Result<(), String> {
    let ts = now();
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET seen_chapter_links=?1, pending_new_links='',
         last_chapter_link=?2, last_chapter_name=?3, chapter_count=?4, status=?5,
         last_updated_at=?6, last_checked_at=?6, updated_at=?6 WHERE id=?7",
        params![
            seen_chapter_links,
            last_chapter_link,
            last_chapter_name,
            chapter_count,
            status,
            ts,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn favorites_remove(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    conn.execute("DELETE FROM favorites WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remaining pending/running work in the same download group as `item`.
/// Split batches (`batch_id` set) are grouped by batch; otherwise by `manga_url`
/// among items with empty `batch_id` (FMD2-style "task finished").
pub fn queue_count_pending_for_group(db: &Db, item: &QueueItem) -> Result<i64, String> {
    let conn = db.lock();
    let batch = item.batch_id.trim();
    if !batch.is_empty() {
        return conn
            .query_row(
                "SELECT COUNT(*) FROM queue_items
                 WHERE COALESCE(batch_id, '') = ?1
                   AND status IN ('pending','running')",
                params![batch],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string());
    }
    let manga = item.manga_url.trim();
    if manga.is_empty() {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COUNT(*) FROM queue_items
         WHERE manga_url = ?1
           AND TRIM(COALESCE(batch_id, '')) = ''
           AND status IN ('pending','running')",
        params![manga],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Whether any sibling in the same group ended as `failed`.
pub fn queue_group_has_failed(db: &Db, item: &QueueItem) -> Result<bool, String> {
    let conn = db.lock();
    let batch = item.batch_id.trim();
    let count: i64 = if !batch.is_empty() {
        conn.query_row(
            "SELECT COUNT(*) FROM queue_items
             WHERE COALESCE(batch_id, '') = ?1 AND status = 'failed'",
            params![batch],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        let manga = item.manga_url.trim();
        if manga.is_empty() {
            return Ok(false);
        }
        conn.query_row(
            "SELECT COUNT(*) FROM queue_items
             WHERE manga_url = ?1
               AND TRIM(COALESCE(batch_id, '')) = ''
               AND status = 'failed'",
            params![manga],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    Ok(count > 0)
}

pub fn queue_list(db: &Db) -> Result<Vec<QueueItem>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(&format!(
            "{QUEUE_SELECT}
             ORDER BY
               CASE status
                 WHEN 'running' THEN 0
                 WHEN 'pending' THEN 1
                 WHEN 'failed' THEN 2
                 ELSE 3
               END,
               position ASC,
               id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_queue_item)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn queue_add_many(db: &Db, items: &[NewQueueItem]) -> Result<Vec<i64>, String> {
    let conn = db.lock();
    let ts = now();
    let mut max_pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), 0) FROM queue_items",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let mut ids = Vec::new();
    for item in items {
        // Skip exact duplicate pending/running
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM queue_items
                 WHERE chapter_link = ?1 AND status IN ('pending','running')
                 LIMIT 1",
                params![item.chapter_link],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            continue;
        }
        max_pos += 1;
        conn.execute(
            "INSERT INTO queue_items(
                manga_title, root_url, manga_url, module_id, chapter_index, chapter_name, chapter_link,
                output_dir, manga_path, chapter_path, chapter_display, batch_id, pack_format, status, error, created_at, updated_at, retry_count, position
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'pending','',?14,?14,0,?15)",
            params![
                item.manga_title,
                item.root_url,
                item.manga_url,
                item.module_id,
                item.chapter_index,
                item.chapter_name,
                item.chapter_link,
                item.output_dir,
                item.manga_path,
                item.chapter_path,
                item.chapter_display,
                item.batch_id,
                item.pack_format,
                ts,
                max_pos
            ],
        )
        .map_err(|e| e.to_string())?;
        ids.push(conn.last_insert_rowid());
    }
    Ok(ids)
}

/// Reorder the whole queue by (manga_title, chapter_index), keeping the
/// existing status-based priority from [`queue_list`] intact (position only
/// tie-breaks within the same status).
pub fn queue_sort_by_title(db: &Db) -> Result<(), String> {
    let mut items = queue_list(db)?;
    items.sort_by(|a, b| {
        a.manga_title
            .to_lowercase()
            .cmp(&b.manga_title.to_lowercase())
            .then(a.chapter_index.cmp(&b.chapter_index))
    });
    let ids: Vec<i64> = items.iter().map(|i| i.id).collect();
    queue_reorder(db, &ids)
}

pub fn queue_reorder(db: &Db, ids: &[i64]) -> Result<(), String> {
    let conn = db.lock();
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE queue_items SET position=?1, updated_at=?2 WHERE id=?3",
            params![i as i64, now(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pick the next pending job.
///
/// Always: at most one `running` item per non-empty `batch_id` (FMD2-style split
/// tasks — so lote 1/2 cannot fill all parallel slots while 2/2 waits).
///
/// If `one_chapter_per_manga`: also block another pending of the same manga when
/// a running item shares the same `batch_id` (including empty = normal download).
pub fn queue_take_next_pending(db: &Db) -> Result<Option<QueueItem>, String> {
    let one_per_manga = crate::settings_keys::one_chapter_per_manga();
    let conn = db.lock();
    let id: Option<i64> = if one_per_manga {
        conn.query_row(
            "SELECT q.id FROM queue_items q
             WHERE q.status = 'pending'
             AND NOT (
               TRIM(COALESCE(q.batch_id, '')) != ''
               AND EXISTS (
                 SELECT 1 FROM queue_items r
                 WHERE r.status = 'running'
                   AND COALESCE(r.batch_id, '') = COALESCE(q.batch_id, '')
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM queue_items r
               WHERE r.status = 'running'
                 AND COALESCE(r.module_id, '') = COALESCE(q.module_id, '')
                 AND COALESCE(r.batch_id, '') = COALESCE(q.batch_id, '')
                 AND (
                   (TRIM(COALESCE(q.manga_url, '')) != ''
                    AND TRIM(COALESCE(r.manga_url, '')) = TRIM(COALESCE(q.manga_url, '')))
                   OR (TRIM(COALESCE(q.manga_url, '')) = ''
                    AND r.manga_title = q.manga_title)
                 )
             )
             ORDER BY q.position ASC, q.id ASC
             LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    } else {
        // Split batches: still at most one running chapter per batch_id.
        conn.query_row(
            "SELECT q.id FROM queue_items q
             WHERE q.status = 'pending'
             AND NOT (
               TRIM(COALESCE(q.batch_id, '')) != ''
               AND EXISTS (
                 SELECT 1 FROM queue_items r
                 WHERE r.status = 'running'
                   AND COALESCE(r.batch_id, '') = COALESCE(q.batch_id, '')
               )
             )
             ORDER BY q.position ASC, q.id ASC
             LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let Some(id) = id else {
        return Ok(None);
    };
    let ts = now();
    conn.execute(
        "UPDATE queue_items SET status='running', error='', updated_at=?1 WHERE id=?2",
        params![ts, id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    queue_get(db, id).map(Some)
}

pub fn queue_get(db: &Db, id: i64) -> Result<QueueItem, String> {
    let conn = db.lock();
    conn.query_row(
        &format!("{QUEUE_SELECT} WHERE id = ?1"),
        params![id],
        map_queue_item,
    )
    .map_err(|e| e.to_string())
}

pub fn queue_set_status(db: &Db, id: i64, status: &str, error: &str) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE queue_items SET status=?1, error=?2, updated_at=?3 WHERE id=?4",
        params![status, error, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark cancelled only if still `running`. Avoids clobbering a concurrent
/// `queue_retry` that already moved the row back to `pending`.
pub fn queue_mark_cancelled_if_running(db: &Db, id: i64, error: &str) -> Result<bool, String> {
    let conn = db.lock();
    let n = conn
        .execute(
            "UPDATE queue_items SET status='cancelled', error=?1, updated_at=?2
             WHERE id=?3 AND status='running'",
            params![error, now(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Increment retry_count and set status back to pending.
pub fn queue_inc_retry(db: &Db, id: i64, error: &str) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE queue_items SET status='pending', error=?1, retry_count=retry_count+1, updated_at=?2
         WHERE id=?3",
        params![error, now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// On failure: if retry_count < max_retries, increment and set pending; else failed.
pub fn queue_fail_or_retry(db: &Db, id: i64, error: &str, max_retries: usize) -> Result<(), String> {
    let item = queue_get(db, id)?;
    if (item.retry_count as usize) < max_retries {
        queue_inc_retry(db, id, error)
    } else {
        queue_set_status(db, id, "failed", error)
    }
}

pub fn db_vacuum(db: &Db) -> Result<(), String> {
    let conn = db.lock();
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())
}

/// Vacuum main + favorites (same open connections).
pub fn db_vacuum_app(main: &Db, favorites: &Db) -> Result<(), String> {
    db_vacuum(favorites)?;
    db_vacuum(main)?;
    Ok(())
}

pub fn queue_cancel(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE queue_items SET status='cancelled', updated_at=?1
         WHERE id=?2 AND status IN ('pending','running')",
        params![now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-queue a cancelled/failed item so the worker can resume (skip existing files).
pub fn queue_retry(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    let n = conn
        .execute(
            "UPDATE queue_items SET status='pending', error='', retry_count=0, updated_at=?1
             WHERE id=?2 AND status IN ('cancelled','failed')",
            params![now(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("solo se puede reintentar ítems cancelled o failed".into());
    }
    Ok(())
}

/// Re-queue a completed item after files were wiped (force re-download).
pub fn queue_redownload(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    let n = conn
        .execute(
            "UPDATE queue_items SET status='pending', error='', retry_count=0, updated_at=?1
             WHERE id=?2 AND status='done'",
            params![now(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("solo se puede redescargar ítems completados".into());
    }
    Ok(())
}

/// Persist pack format on a queue row (e.g. freeze from disk before redownload).
pub fn queue_set_pack_format(db: &Db, id: i64, pack_format: &str) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE queue_items SET pack_format=?1, updated_at=?2 WHERE id=?3",
        params![pack_format.trim(), now(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn queue_remove(db: &Db, id: i64) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM queue_items WHERE id=?1 AND status NOT IN ('running')",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove successfully completed tasks only (FMD2 `RemoveAllFinishedTasks` parity).
/// Leaves `failed` / `cancelled` / pending / running in the queue.
pub fn queue_clear_finished(db: &Db) -> Result<usize, String> {
    let conn = db.lock();
    let n = conn
        .execute("DELETE FROM queue_items WHERE status = 'done'", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// Canonical mark key: path only (host/query/fragment dropped), lowercased, no
/// trailing slash. Absolute vs relative URLs of the same work map to one key.
///
/// This is the *single* definition of the key. The frontend must never compute
/// it — it asks for canonical keys via the `chapter_mark_keys` command instead.
fn link_mark_key(url: &str) -> String {
    let s = url.trim();
    if s.is_empty() {
        return String::new();
    }
    let path = if let Ok(u) = url::Url::parse(s) {
        u.path().to_string()
    } else if let Some(rest) = s.strip_prefix("//") {
        if let Ok(u) = url::Url::parse(&format!("https://{rest}")) {
            u.path().to_string()
        } else {
            s.split(['?', '#']).next().unwrap_or(s).to_string()
        }
    } else {
        s.split(['?', '#']).next().unwrap_or(s).to_string()
    };
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    let with_slash = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    with_slash.trim_end_matches('/').to_ascii_lowercase()
}

/// Canonical keys for a batch of links, so the UI can match rows against
/// `downloaded_chapters_list` without reimplementing `link_mark_key`.
pub fn mark_keys(links: &[String]) -> Vec<String> {
    links.iter().map(|l| link_mark_key(l)).collect()
}

/// Canonical key for a single link, for importers that build rows in bulk.
/// Thin wrapper so `link_mark_key` stays the one definition.
pub fn mark_key(link: &str) -> String {
    link_mark_key(link)
}

/// Bulk-insert already-canonical `(module_id, manga_url, chapter_link, downloaded_at)`
/// marks in one transaction. An empty `downloaded_at` is stamped with import time —
/// FMD2 records none, while an FMD3 source carries the original worth preserving.
/// Returns how many rows were actually new.
///
/// Deliberately *not* `downloaded_chapters_mark` in a loop: that one scans every
/// row of the module on each call to drop legacy non-canonical variants, which is
/// O(n²) and unusable for the hundreds of thousands of rows an import carries.
/// Callers must pass keys from `mark_key`, so there is nothing legacy to clean.
pub fn downloaded_chapters_import_bulk(
    db: &Db,
    rows: &[(String, String, String, String)],
) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let fallback = now();
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut inserted = 0usize;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO downloaded_chapters(module_id, manga_url, chapter_link, downloaded_at)
                 VALUES(?1,?2,?3,?4)",
            )
            .map_err(|e| e.to_string())?;
        for (mid, mu, link, at) in rows {
            if mid.is_empty() || mu.is_empty() || link.is_empty() {
                continue;
            }
            let at = if at.trim().is_empty() { &fallback } else { at };
            inserted += stmt
                .execute(params![mid, mu, link, at])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// Record a chapter as downloaded. Write-once: a chapter that is already marked
/// is left untouched (re-downloading must not move `downloaded_at`).
pub fn downloaded_chapters_mark(
    db: &Db,
    module_id: &str,
    manga_url: &str,
    chapter_link: &str,
) -> Result<(), String> {
    let mid = module_id.trim();
    let mu = link_mark_key(manga_url);
    let link = link_mark_key(chapter_link);
    if mid.is_empty() || mu.is_empty() || link.is_empty() {
        return Ok(());
    }
    let conn = db.lock();
    // Drop legacy rows for the same chapter under non-canonical manga_url variants.
    {
        let mut stmt = conn
            .prepare(
                "SELECT manga_url, chapter_link FROM downloaded_chapters WHERE module_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![mid], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|(row_mu, row_ch)| {
                link_mark_key(row_mu) == mu
                    && link_mark_key(row_ch) == link
                    && (row_mu != &mu || row_ch != &link)
            })
            .collect();
        drop(stmt);
        for (row_mu, row_ch) in rows {
            let _ = conn.execute(
                "DELETE FROM downloaded_chapters
                 WHERE module_id=?1 AND manga_url=?2 AND chapter_link=?3",
                params![mid, row_mu, row_ch],
            );
        }
    }
    conn.execute(
        "INSERT OR IGNORE INTO downloaded_chapters(module_id, manga_url, chapter_link, downloaded_at)
         VALUES(?1,?2,?3,?4)",
        params![mid, mu, link, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* No unmark: `downloaded_chapters` is append-only. A mark records that a chapter
was downloaded once, and nothing after that revokes it — not removing the queue
task, not deleting the files from disk. Only `downloaded_chapters_mark` writes. */

/// Chapter links marked downloaded for a manga (canonical path keys).
///
/// `downloaded_chapters` is the sole source of truth: the queue is never consulted
/// here. That keeps the two tables independent — removing finished queue tasks, with
/// or without their files, must not change what shows as downloaded.
pub fn downloaded_chapters_list(
    db: &Db,
    module_id: &str,
    manga_url: &str,
) -> Result<Vec<String>, String> {
    let mid = module_id.trim();
    let mu_key = link_mark_key(manga_url);
    if mid.is_empty() || mu_key.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT manga_url, chapter_link FROM downloaded_chapters
             WHERE module_id=?1
             ORDER BY downloaded_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![mid], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (row_mu, row_ch) = row.map_err(|e| e.to_string())?;
        if link_mark_key(&row_mu) != mu_key {
            continue;
        }
        let ch = link_mark_key(&row_ch);
        if ch.is_empty() || !seen.insert(ch.clone()) {
            continue;
        }
        out.push(ch);
    }
    Ok(out)
}

/// Chapter links currently pending/running in the queue for a manga.
pub fn queue_active_chapter_links(
    db: &Db,
    module_id: &str,
    manga_url: &str,
) -> Result<Vec<String>, String> {
    let mid = module_id.trim();
    let mu_key = link_mark_key(manga_url);
    if mid.is_empty() || mu_key.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT manga_url, chapter_link FROM queue_items
             WHERE module_id=?1 AND status IN ('pending','running')",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![mid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (row_mu, row_ch) = row.map_err(|e| e.to_string())?;
        if link_mark_key(&row_mu) != mu_key {
            continue;
        }
        let ch = link_mark_key(&row_ch);
        if ch.is_empty() || !seen.insert(ch.clone()) {
            continue;
        }
        out.push(ch);
    }
    Ok(out)
}

pub fn queue_reset_running_to_pending(db: &Db) -> Result<usize, String> {
    let conn = db.lock();
    let n = conn
        .execute(
            "UPDATE queue_items SET status='pending', error='', updated_at=?1 WHERE status='running'",
            params![now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

pub fn queue_has_pending(db: &Db) -> Result<bool, String> {
    let conn = db.lock();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM queue_items WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory stand-in for `userdata/downloaded.db` (marks only).
    fn test_db() -> Db {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(DOWNLOADED_DDL).expect("downloaded ddl");
        Arc::new(Mutex::new(conn))
    }

    /// In-memory stand-in for the main DB: settings + queue, no marks table (the
    /// split moved it out).
    fn test_main_db() -> Db {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
            CREATE TABLE queue_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                manga_title TEXT NOT NULL DEFAULT '',
                root_url TEXT NOT NULL DEFAULT '',
                manga_url TEXT NOT NULL DEFAULT '',
                module_id TEXT NOT NULL DEFAULT '',
                chapter_index INTEGER NOT NULL DEFAULT 0,
                chapter_name TEXT NOT NULL DEFAULT '',
                chapter_link TEXT NOT NULL DEFAULT '',
                output_dir TEXT NOT NULL DEFAULT '',
                manga_path TEXT NOT NULL DEFAULT '',
                chapter_path TEXT NOT NULL DEFAULT '',
                batch_id TEXT NOT NULL DEFAULT '',
                pack_format TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                retry_count INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0,
                chapter_display TEXT NOT NULL DEFAULT ''
            );
            "#,
        )
        .expect("schema");
        Arc::new(Mutex::new(conn))
    }

    fn add_done(db: &Db, mid: &str, mu: &str, ch: &str) {
        db.lock()
            .execute(
                "INSERT INTO queue_items(module_id, manga_url, chapter_link, status, updated_at)
                 VALUES(?1,?2,?3,'done','2020-01-01T00:00:00Z')",
                params![mid, mu, ch],
            )
            .expect("insert done row");
    }

    #[test]
    fn link_mark_key_is_path_only() {
        let cases = [
            /* Absolute vs relative vs protocol-relative collapse to one key. */
            ("https://site.com/manga/foo", "/manga/foo"),
            ("http://other.com/manga/foo", "/manga/foo"),
            ("//site.com/manga/foo", "/manga/foo"),
            ("/manga/foo", "/manga/foo"),
            ("manga/foo", "/manga/foo"),
            /* Trailing slash, case, and surrounding space are not significant. */
            ("https://site.com/manga/foo/", "/manga/foo"),
            ("/manga/foo///", "/manga/foo"),
            ("https://site.com/Manga/Foo", "/manga/foo"),
            ("  /manga/foo  ", "/manga/foo"),
            /* Query and fragment are dropped. */
            ("https://site.com/manga/foo?page=2", "/manga/foo"),
            ("https://site.com/manga/foo#top", "/manga/foo"),
            ("/manga/foo?a=1#b", "/manga/foo"),
            /* Percent escapes are kept verbatim — no decoding on either side. */
            ("https://site.com/manga/a%20b", "/manga/a%20b"),
            ("/manga/a%zz", "/manga/a%zz"),
            /* Empty / degenerate input yields an empty key (callers skip it). */
            ("", ""),
            ("   ", ""),
            ("https://site.com", ""),
            ("https://site.com/", ""),
        ];
        for (input, want) in cases {
            assert_eq!(link_mark_key(input), want, "link_mark_key({input:?})");
        }
    }

    #[test]
    fn link_mark_key_keeps_distinct_chapters_distinct() {
        assert_ne!(link_mark_key("/manga/a/c-1"), link_mark_key("/manga/a/c-2"));
        /* Suffix overlap must NOT collapse: c-1 is a suffix of c-11 as a string. */
        assert_ne!(link_mark_key("/manga/a/c-1"), link_mark_key("/manga/a/c-11"));
        /* Same chapter path under a different manga is a different key. */
        assert_ne!(link_mark_key("/manga/a/c-1"), link_mark_key("/manga/b/c-1"));
    }

    #[test]
    fn mark_keys_maps_the_batch() {
        let links = vec![
            "https://site.com/Manga/A/".to_string(),
            "/manga/b?x=1".to_string(),
            "".to_string(),
        ];
        assert_eq!(mark_keys(&links), vec!["/manga/a", "/manga/b", ""]);
    }

    const MID: &str = "mod1";
    const MU: &str = "https://site.com/manga/foo";

    #[test]
    fn list_matches_across_url_variants_and_survives_requeue() {
        let db = test_db();
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        /* Same work, different URL form: relative manga_url, trailing slash, case. */
        downloaded_chapters_mark(&db, MID, "/manga/foo/", "https://site.com/manga/foo/C-2/")
            .unwrap();

        let mut got = downloaded_chapters_list(&db, MID, MU).unwrap();
        got.sort();
        assert_eq!(got, vec!["/manga/foo/c-1", "/manga/foo/c-2"]);

        /* Re-downloading ch-1 must not disturb ch-2 (the original bug). */
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        let mut after = downloaded_chapters_list(&db, MID, "/manga/foo").unwrap();
        after.sort();
        assert_eq!(after, vec!["/manga/foo/c-1", "/manga/foo/c-2"]);
    }

    #[test]
    fn marks_survive_clearing_finished_queue_rows() {
        let main = test_main_db();
        let db = test_db();
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        add_done(&main, MID, MU, "/manga/foo/c-1");

        queue_clear_finished(&main).unwrap();
        assert_eq!(
            downloaded_chapters_list(&db, MID, MU).unwrap(),
            vec!["/manga/foo/c-1"]
        );
    }

    /// The reported "the mark disappears" sequence, now with the intended outcome:
    /// removing the finished queue tasks (even with "delete files") leaves both marks
    /// standing, because a completed download is a fact that task bookkeeping cannot
    /// revoke.
    #[test]
    fn marks_survive_removing_finished_tasks_and_their_files() {
        let main = test_main_db();
        let db = test_db();
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-2").unwrap();
        add_done(&main, MID, MU, "/manga/foo/c-1");
        add_done(&main, MID, MU, "/manga/foo/c-2");

        /* "Quitar de la cola" + "borrar también los archivos": queue rows go, files
        go, marks stay — they now live in a different file entirely. */
        queue_clear_finished(&main).unwrap();

        let mut got = downloaded_chapters_list(&db, MID, MU).unwrap();
        got.sort();
        assert_eq!(got, vec!["/manga/foo/c-1", "/manga/foo/c-2"]);

        /* Re-downloading c-1 changes nothing for c-2. */
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        let mut after = downloaded_chapters_list(&db, MID, MU).unwrap();
        after.sort();
        assert_eq!(after, vec!["/manga/foo/c-1", "/manga/foo/c-2"]);
    }

    #[test]
    fn list_ignores_other_mangas_and_modules() {
        let db = test_db();
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/c-1").unwrap();
        downloaded_chapters_mark(&db, MID, "https://site.com/manga/bar", "/manga/bar/c-1")
            .unwrap();
        downloaded_chapters_mark(&db, "mod2", MU, "/manga/foo/c-9").unwrap();

        assert_eq!(
            downloaded_chapters_list(&db, MID, MU).unwrap(),
            vec!["/manga/foo/c-1"]
        );
    }

    fn test_favorites_db() -> Db {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(FAVORITES_DDL).expect("fav ddl");
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn import_bulk_is_idempotent_and_matches_mark() {
        let db = test_db();
        let rows: Vec<(String, String, String, String)> = ["/manga/foo/c-1", "/manga/foo/c-2"]
            .iter()
            .map(|c| (MID.to_string(), mark_key(MU), mark_key(c), String::new()))
            .collect();

        assert_eq!(downloaded_chapters_import_bulk(&db, &rows).unwrap(), 2);
        // Second pass inserts nothing and must not duplicate.
        assert_eq!(downloaded_chapters_import_bulk(&db, &rows).unwrap(), 0);
        assert_eq!(
            downloaded_chapters_list(&db, MID, MU).unwrap(),
            vec!["/manga/foo/c-1", "/manga/foo/c-2"]
        );

        // A later single mark of an already-imported chapter is a no-op too.
        downloaded_chapters_mark(&db, MID, MU, "/manga/foo/C-1/").unwrap();
        assert_eq!(downloaded_chapters_list(&db, MID, MU).unwrap().len(), 2);
    }

    #[test]
    fn import_bulk_skips_empty_tuples() {
        let db = test_db();
        let rows = vec![
            (String::new(), mark_key(MU), mark_key("/manga/foo/c-1"), String::new()),
            (MID.to_string(), String::new(), mark_key("/manga/foo/c-2"), String::new()),
            (MID.to_string(), mark_key(MU), String::new(), String::new()),
        ];
        assert_eq!(downloaded_chapters_import_bulk(&db, &rows).unwrap(), 0);
        assert!(downloaded_chapters_list(&db, MID, MU).unwrap().is_empty());
    }

    #[test]
    fn export_copy_carries_rows_still_living_in_the_wal() {
        // The whole point of the checkpoint: with journal_mode=WAL the recent writes
        // sit in `-wal`, so a bare file copy would hand back a stale DB.
        let dir = std::env::temp_dir().join(format!("fmd3-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("downloaded.db");

        let conn = Connection::open(&src).unwrap();
        configure_connection(&conn).unwrap(); // sets journal_mode=WAL
        conn.execute_batch(DOWNLOADED_DDL).unwrap();
        let db: Db = Arc::new(Mutex::new(conn));
        let rows: Vec<(String, String, String, String)> = (1..=3)
            .map(|i| {
                (
                    MID.to_string(),
                    mark_key(MU),
                    mark_key(&format!("/manga/foo/c-{i}")),
                    String::new(),
                )
            })
            .collect();
        downloaded_chapters_import_bulk(&db, &rows).unwrap();

        // Negative control: a bare copy right now misses the rows, which is exactly
        // the bug the checkpoint exists to prevent.
        let naive = dir.join("naive.db");
        std::fs::copy(&src, &naive).unwrap();
        // Not even the schema has landed yet, so this errors rather than returning 0.
        let stale: i64 = Connection::open(&naive)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM downloaded_chapters", [], |r| r.get(0))
            .unwrap_or(0);
        assert_eq!(stale, 0, "el WAL ya estaba consolidado; el test no prueba nada");

        let dest = dir.join("copy.db");
        export_copy(&db, &src, &dest).unwrap();

        // Open the copy standalone — no `-wal` alongside it — and expect all 3 rows.
        let copy = Connection::open(&dest).unwrap();
        let n: i64 = copy
            .query_row("SELECT COUNT(*) FROM downloaded_chapters", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3, "la copia perdió filas que estaban en el WAL");

        drop(copy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_bulk_preserves_a_supplied_timestamp() {
        let db = test_db();
        let at = "2026-01-02T03:04:05+00:00";
        let rows = vec![(
            MID.to_string(),
            mark_key(MU),
            mark_key("/manga/foo/c-1"),
            at.to_string(),
        )];
        downloaded_chapters_import_bulk(&db, &rows).unwrap();

        let stored: String = db
            .lock()
            .query_row(
                "SELECT downloaded_at FROM downloaded_chapters",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, at);
    }

    #[test]
    fn path_key_index_maps_url_variants_to_the_stored_form() {
        let favs = test_favorites_db();
        favorites_add(
            &favs,
            MID,
            "Mod",
            "https://site.com",
            "https://site.com/manga/foo/",
            "Foo",
            "",
            "",
            0,
            "",
        )
        .unwrap();

        let idx = favorites_path_key_index(&favs).unwrap();
        // A relative FMD2 link canonicalizes onto the stored absolute URL, so an
        // import reuses that row instead of inserting a near-duplicate.
        let key = (MID.to_string(), mark_key("/manga/foo/"));
        assert_eq!(idx.get(&key).map(String::as_str), Some("https://site.com/manga/foo/"));
        assert!(idx.get(&(MID.to_string(), mark_key("/manga/bar"))).is_none());
    }

    #[test]
    fn restore_meta_ignores_empty_values() {
        let favs = test_favorites_db();
        let url = "https://site.com/manga/foo";
        favorites_add(&favs, MID, "Mod", "https://site.com", url, "Foo", "", "", 0, "").unwrap();

        favorites_restore_meta(&favs, url, "2026-07-28T22:33:25.429+00:00", "1").unwrap();
        let fav = &favorites_list(&favs).unwrap()[0];
        assert_eq!(fav.last_updated_at, "2026-07-28T22:33:25.429+00:00");
        assert_eq!(fav.status, "1");

        favorites_restore_meta(&favs, url, "", "").unwrap();
        let fav = &favorites_list(&favs).unwrap()[0];
        assert_eq!(fav.last_updated_at, "2026-07-28T22:33:25.429+00:00");
        assert_eq!(fav.status, "1");
    }

    #[test]
    fn backfill_replaces_legacy_tip_cursor_with_downloaded_list() {
        let main = test_main_db();
        let favs = test_favorites_db();
        let dl = test_db();
        // Pre-split shape: seen holds only the tip cursor the old logic stored.
        let fav = favorites_add(
            &favs, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/ch-12", "Ch 12", 12, "/manga/foo/ch-12",
        )
        .unwrap();
        favorites_update_after_check(
            &favs, fav.id, "/manga/foo/ch-12", "Ch 12", 12, "ongoing",
            &(1..12).map(|n| format!("/manga/foo/ch-{n}")).collect::<Vec<_>>().join("\n"),
        )
        .unwrap();
        for n in 1..=8 {
            downloaded_chapters_mark(&dl, MID, MU, &format!("/manga/foo/ch-{n}")).unwrap();
        }

        backfill_seen_from_downloaded(&main, &favs, &dl).unwrap();

        let after = favorites_get(&favs, fav.id).unwrap();
        let keys = parse_seen_keys(&after.seen_chapter_links);
        assert_eq!(keys.len(), 8, "seen debe venir de downloaded_chapters");
        assert!(keys.contains("/manga/foo/ch-1"));
        assert!(keys.contains("/manga/foo/ch-8"));
        // The tip was never downloaded, so it must not count as seen.
        assert!(!keys.contains("/manga/foo/ch-12"));
        assert!(after.pending_new_links.trim().is_empty());
    }

    #[test]
    fn backfill_leaves_real_seen_lists_alone_and_runs_once() {
        let main = test_main_db();
        let favs = test_favorites_db();
        let dl = test_db();
        let real = join_chapter_links(&["/manga/foo/ch-1".into(), "/manga/foo/ch-2".into()]);
        let fav = favorites_add(
            &favs, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/ch-2", "Ch 2", 2, &real,
        )
        .unwrap();
        downloaded_chapters_mark(&dl, MID, MU, "/manga/foo/ch-9").unwrap();

        backfill_seen_from_downloaded(&main, &favs, &dl).unwrap();
        let after = favorites_get(&favs, fav.id).unwrap();
        assert_eq!(parse_seen_keys(&after.seen_chapter_links), parse_seen_keys(&real));

        // Second run is a no-op even for rows that would now qualify.
        let bare = favorites_add(
            &favs, MID, "Site", "https://site.com", "https://site.com/manga/bar", "Bar",
            "", "", 0, "",
        )
        .unwrap();
        downloaded_chapters_mark(&dl, MID, "https://site.com/manga/bar", "/manga/bar/ch-1")
            .unwrap();
        backfill_seen_from_downloaded(&main, &favs, &dl).unwrap();
        assert!(favorites_get(&favs, bare.id)
            .unwrap()
            .seen_chapter_links
            .trim()
            .is_empty());
    }

    #[test]
    fn backfill_clears_cursor_when_nothing_was_downloaded() {
        let main = test_main_db();
        let favs = test_favorites_db();
        let dl = test_db();
        let fav = favorites_add(
            &favs, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/ch-5", "Ch 5", 5, "/manga/foo/ch-5",
        )
        .unwrap();
        backfill_seen_from_downloaded(&main, &favs, &dl).unwrap();
        assert!(favorites_get(&favs, fav.id)
            .unwrap()
            .seen_chapter_links
            .trim()
            .is_empty());
    }

    #[test]
    fn reimport_without_chapter_data_keeps_existing_progress() {
        let db = test_favorites_db();
        let seen = join_chapter_links(&["/manga/foo/c-1".into(), "/manga/foo/c-2".into()]);
        favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/c-2", "Ch 2", 2, &seen,
        )
        .unwrap();
        favorites_update_after_check(
            &db, 1, "/manga/foo/c-3", "Ch 3", 3, "ongoing", "/manga/foo/c-3",
        )
        .unwrap();
        // A bare import row (no seen, no chapter data) must not reset anything.
        let fav = favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo Renamed", "", "", 0, "",
        )
        .unwrap();
        assert_eq!(fav.title, "Foo Renamed");
        assert_eq!(parse_seen_keys(&fav.seen_chapter_links), parse_seen_keys(&seen));
        assert_eq!(fav.last_chapter_link, "/manga/foo/c-3");
        assert_eq!(fav.chapter_count, 3);
        assert_eq!(count_link_lines(&fav.pending_new_links), 1);
    }

    #[test]
    fn reimport_with_seen_replaces_it_and_clears_pending() {
        let db = test_favorites_db();
        favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/c-1", "Ch 1", 1, "/manga/foo/c-1",
        )
        .unwrap();
        favorites_update_after_check(
            &db, 1, "/manga/foo/c-2", "Ch 2", 2, "ongoing", "/manga/foo/c-2",
        )
        .unwrap();
        let fav = favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/c-2", "Ch 2", 2, "/manga/foo/c-1\n/manga/foo/c-2",
        )
        .unwrap();
        assert_eq!(parse_seen_keys(&fav.seen_chapter_links).len(), 2);
        assert!(fav.pending_new_links.trim().is_empty());
    }

    #[test]
    fn restore_timestamps_ignores_empty_values() {
        let db = test_favorites_db();
        let fav = favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo", "", "", 0, "",
        )
        .unwrap();
        let original_added = fav.date_added.clone();
        favorites_restore_timestamps(&db, MU, "", "").unwrap();
        assert_eq!(favorites_get(&db, fav.id).unwrap().date_added, original_added);
        favorites_restore_timestamps(&db, MU, "2020-01-01T00:00:00Z", "").unwrap();
        let after = favorites_get(&db, fav.id).unwrap();
        assert_eq!(after.date_added, "2020-01-01T00:00:00Z");
        assert!(after.last_checked_at.is_empty());
    }

    #[test]
    fn favorites_add_seeds_seen_from_links() {
        let db = test_favorites_db();
        let seen = join_chapter_links(&[
            "https://site.com/manga/foo/c-1".into(),
            "https://site.com/manga/foo/c-2".into(),
        ]);
        let fav = favorites_add(
            &db,
            MID,
            "Site",
            "https://site.com",
            MU,
            "Foo",
            "https://site.com/manga/foo/c-2",
            "Ch 2",
            2,
            &seen,
        )
        .unwrap();
        assert!(!fav.date_added.is_empty());
        let keys = parse_seen_keys(&fav.seen_chapter_links);
        assert!(keys.contains("/manga/foo/c-1"));
        assert!(keys.contains("/manga/foo/c-2"));
    }

    #[test]
    fn favorites_check_only_does_not_mutate_seen() {
        let db = test_favorites_db();
        let seen = join_chapter_links(&["/manga/foo/c-1".into()]);
        let fav = favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/c-1", "Ch 1", 1, &seen,
        )
        .unwrap();
        favorites_update_after_check(
            &db,
            fav.id,
            "/manga/foo/c-3",
            "Ch 3",
            3,
            "ongoing",
            "/manga/foo/c-2\n/manga/foo/c-3",
        )
        .unwrap();
        let after = favorites_get(&db, fav.id).unwrap();
        assert_eq!(
            parse_seen_keys(&after.seen_chapter_links),
            parse_seen_keys(&seen)
        );
        assert_eq!(count_link_lines(&after.pending_new_links), 2);
        assert_eq!(after.chapter_count, 3);
        assert_eq!(after.status, "ongoing");
        assert_eq!(after.last_chapter_link, "/manga/foo/c-3");
    }

    #[test]
    fn favorites_acknowledge_merges_seen_and_clears_pending() {
        let db = test_favorites_db();
        let seen = join_chapter_links(&["/manga/foo/c-1".into()]);
        let fav = favorites_add(
            &db, MID, "Site", "https://site.com", MU, "Foo",
            "/manga/foo/c-1", "Ch 1", 1, &seen,
        )
        .unwrap();
        favorites_update_after_check(
            &db, fav.id, "/manga/foo/c-2", "Ch 2", 2, "ongoing", "/manga/foo/c-2",
        )
        .unwrap();
        let merged = merge_chapter_links(&seen, &["/manga/foo/c-2".into()]);
        favorites_acknowledge_chapters(
            &db, fav.id, &merged, "/manga/foo/c-2", "Ch 2", 2, "ongoing",
        )
        .unwrap();
        let after = favorites_get(&db, fav.id).unwrap();
        assert!(after.pending_new_links.trim().is_empty());
        assert!(parse_seen_keys(&after.seen_chapter_links).contains("/manga/foo/c-2"));
        assert!(!after.last_updated_at.is_empty());
    }

    #[test]
    fn empty_seen_means_all_remote_are_new() {
        let seen = parse_seen_keys("");
        let remote = ["/manga/foo/c-1", "/manga/foo/c-2"];
        let news: Vec<_> = remote
            .iter()
            .filter(|link| {
                let key = link_mark_key(link);
                !key.is_empty() && !seen.contains(&key)
            })
            .collect();
        assert_eq!(news.len(), 2);
    }

    #[test]
    fn merge_chapter_links_dedupes_by_key() {
        let base = "/manga/foo/c-1\nhttps://site.com/manga/foo/c-2";
        let merged = merge_chapter_links(base, &[
            "https://other.com/manga/foo/c-2/".into(),
            "/manga/foo/c-3".into(),
        ]);
        let keys = parse_seen_keys(&merged);
        assert_eq!(keys.len(), 3);
        assert!(keys.contains("/manga/foo/c-3"));
    }
}

