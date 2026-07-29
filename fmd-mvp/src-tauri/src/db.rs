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
        status: r.get(9)?,
        error: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        retry_count: r.get(13)?,
        position: r.get(14)?,
    })
}

const FAVORITE_SELECT: &str = "SELECT id, module_id, module_name, root_url, manga_url, title,
        last_chapter_link, last_chapter_name, chapter_count, updated_at,
        COALESCE(enabled, 1), COALESCE(last_checked_at, '')
 FROM favorites";

const QUEUE_SELECT: &str = "SELECT id, manga_title, root_url, COALESCE(manga_url,''), COALESCE(module_id,''),
        chapter_index, chapter_name, chapter_link,
        output_dir, status, error, created_at, updated_at,
        COALESCE(retry_count, 0), COALESCE(position, 0)
 FROM queue_items";

pub fn db_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fmd-mvp")
}

pub fn open_db() -> Result<Db, String> {
    let dir = db_path();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("fmd-mvp.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
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
        "ALTER TABLE favorites ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE favorites ADD COLUMN last_checked_at TEXT NOT NULL DEFAULT ''",
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
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN title TEXT", []);
    let _ = conn.execute("ALTER TABLE manga_cache ADD COLUMN alt_titles TEXT", []);
    Ok(Arc::new(Mutex::new(conn)))
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
                output_dir, status, error, created_at, updated_at, retry_count, position
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending','',?9,?9,0,?10)",
            params![
                item.manga_title,
                item.root_url,
                item.manga_url,
                item.module_id,
                item.chapter_index,
                item.chapter_name,
                item.chapter_link,
                item.output_dir,
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

pub fn queue_take_next_pending(db: &Db) -> Result<Option<QueueItem>, String> {
    let conn = db.lock();
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM queue_items WHERE status = 'pending'
             ORDER BY position ASC, id ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
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

pub fn queue_clear_finished(db: &Db) -> Result<usize, String> {
    let conn = db.lock();
    let n = conn
        .execute(
            "DELETE FROM queue_items WHERE status IN ('done','failed','cancelled')",
            [],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
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
