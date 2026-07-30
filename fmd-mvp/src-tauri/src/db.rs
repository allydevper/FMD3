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
    /// Split-download batch id (empty = group by manga only).
    #[serde(default)]
    pub batch_id: String,
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
    pub batch_id: String,
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
        status: r.get(12)?,
        error: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        retry_count: r.get(16)?,
        position: r.get(17)?,
    })
}

const FAVORITE_SELECT: &str = "SELECT id, module_id, module_name, root_url, manga_url, title,
        last_chapter_link, last_chapter_name, chapter_count, updated_at,
        COALESCE(enabled, 1), COALESCE(last_checked_at, '')
 FROM favorites";

const QUEUE_SELECT: &str = "SELECT id, manga_title, root_url, COALESCE(manga_url,''), COALESCE(module_id,''),
        chapter_index, chapter_name, chapter_link,
        output_dir, COALESCE(manga_path,''), COALESCE(chapter_path,''), COALESCE(batch_id,''),
        status, error, created_at, updated_at,
        COALESCE(retry_count, 0), COALESCE(position, 0)
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
    last_checked_at TEXT NOT NULL DEFAULT ''
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
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            position INTEGER NOT NULL DEFAULT 0
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
        "#,
    )
    .map_err(|e| e.to_string())?;
    // Migrations for older DBs
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
            fconn
                .execute(
                    "INSERT INTO favorites(
                        id, module_id, module_name, root_url, manga_url, title,
                        last_chapter_link, last_chapter_name, chapter_count, updated_at,
                        enabled, last_checked_at
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
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
) -> Result<Favorite, String> {
    let ts = now();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO favorites(
            module_id, module_name, root_url, manga_url, title,
            last_chapter_link, last_chapter_name, chapter_count, updated_at,
            enabled, last_checked_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,'')
         ON CONFLICT(manga_url) DO UPDATE SET
            module_id=excluded.module_id,
            module_name=excluded.module_name,
            root_url=excluded.root_url,
            title=excluded.title,
            last_chapter_link=excluded.last_chapter_link,
            last_chapter_name=excluded.last_chapter_name,
            chapter_count=excluded.chapter_count,
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
            ts
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

pub fn favorites_update_progress(
    db: &Db,
    id: i64,
    last_chapter_link: &str,
    last_chapter_name: &str,
    chapter_count: i64,
) -> Result<(), String> {
    let ts = now();
    let conn = db.lock();
    conn.execute(
        "UPDATE favorites SET last_chapter_link=?1, last_chapter_name=?2,
         chapter_count=?3, updated_at=?4, last_checked_at=?4 WHERE id=?5",
        params![last_chapter_link, last_chapter_name, chapter_count, ts, id],
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

/// Look up a favorite by its manga URL (used by `favorites.remove_completed`).
pub fn favorites_find_by_manga_url(db: &Db, manga_url: &str) -> Result<Option<Favorite>, String> {
    if manga_url.trim().is_empty() {
        return Ok(None);
    }
    let conn = db.lock();
    conn.query_row(
        &format!("{FAVORITE_SELECT} WHERE manga_url = ?1"),
        params![manga_url],
        map_favorite,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Count queue items still pending/running for a given manga URL (used to know
/// whether a favorite's chapters have all finished downloading).
pub fn queue_count_pending_for_manga(db: &Db, manga_url: &str) -> Result<i64, String> {
    let conn = db.lock();
    conn.query_row(
        "SELECT COUNT(*) FROM queue_items
         WHERE manga_url = ?1 AND status IN ('pending','running')",
        params![manga_url],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
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
                output_dir, manga_path, chapter_path, batch_id, status, error, created_at, updated_at, retry_count, position
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending','',?12,?12,0,?13)",
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
                item.batch_id,
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
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                retry_count INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0
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
}

