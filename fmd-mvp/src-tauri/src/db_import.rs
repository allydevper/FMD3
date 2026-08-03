//! Import favorites and downloaded-chapter marks from a **FMD2** install or from
//! another **FMD3** install's `userdata`.
//!
//! FMD2 keeps `favorites.db` + `downloadedchapters.db`; FMD3 keeps `favorites.db` +
//! `downloaded.db`. The favorites file has the *same name* in both, so the flavor is
//! decided by the schema, never by the filename. Module IDs are one namespace
//! (`m.ID` from the shared Lua modules), so rows map across either way.
//!
//! Source files are copied to a temp dir before opening: the other app may be
//! running and holding a WAL, and the user's original data must never be touched.

use crate::db;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

const FMD2_FAVORITES_FILE: &str = "favorites.db";
const FMD2_DOWNLOADED_FILE: &str = "downloadedchapters.db";
const FMD3_DOWNLOADED_FILE: &str = "downloaded.db";
/// FMD2 row ids are `moduleid` (a 32-char GUID, no dashes) concatenated with the link.
const MODULE_ID_LEN: usize = 32;
/// Rows per bulk transaction — a full install expands to hundreds of thousands.
const MARK_BATCH: usize = 5_000;

#[derive(Debug, Default, Serialize)]
pub struct DbImportReport {
    pub favorites_added: usize,
    pub favorites_skipped: usize,
    pub marks_added: usize,
    /// Module IDs referenced by favorites we could not place (no module installed
    /// and no `root_url` carried by the source).
    pub unknown_modules: Vec<String>,
    /// What was actually read, e.g. `favorites.db (FMD2)` — shown back to the user.
    pub sources: Vec<String>,
    pub warnings: Vec<String>,
}

/// Which app wrote the file we are reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Fmd2,
    Fmd3,
}

impl Flavor {
    fn label(self) -> &'static str {
        match self {
            Flavor::Fmd2 => "FMD2",
            Flavor::Fmd3 => "FMD3",
        }
    }
}

/* ---------------------------------------------------------------- source files */

/// A favorites or marks DB found on disk, with its flavor already decided.
struct Source {
    path: PathBuf,
    flavor: Flavor,
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        rusqlite::params![name],
        |_| Ok(()),
    )
    .is_ok()
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    // Collect before returning: the iterator borrows `stmt`, which dies with this fn.
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) else {
        return false;
    };
    let names: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    names.iter().any(|c| c.eq_ignore_ascii_case(column))
}

/// Classify a `.db` by what is inside it. Returns `(favorites_flavor, marks_flavor)`;
/// a file is normally one or the other, never both.
fn classify(path: &Path) -> (Option<Flavor>, Option<Flavor>) {
    let Ok(conn) = Connection::open(path) else {
        return (None, None);
    };
    let favorites = if has_table(&conn, "favorites") {
        // FMD3 named the columns `module_id` / `manga_url`; FMD2 used `moduleid` / `link`.
        Some(if has_column(&conn, "favorites", "module_id") {
            Flavor::Fmd3
        } else {
            Flavor::Fmd2
        })
    } else {
        None
    };
    let marks = if has_table(&conn, "downloaded_chapters") {
        Some(Flavor::Fmd3)
    } else if has_table(&conn, "downloadedchapters") {
        Some(Flavor::Fmd2)
    } else {
        None
    };
    (favorites, marks)
}

/// Locate the DBs from whatever the user picked: a `userdata` folder (either app's)
/// or a single `.db` file.
fn resolve_sources(path: &Path) -> Result<(Option<Source>, Option<Source>), String> {
    if !path.exists() {
        return Err(format!("No existe: {}", path.display()));
    }

    if path.is_file() {
        let (fav, marks) = classify(path);
        return match (fav, marks) {
            (Some(flavor), _) => Ok((
                Some(Source {
                    path: path.to_path_buf(),
                    flavor,
                }),
                None,
            )),
            (None, Some(flavor)) => Ok((
                None,
                Some(Source {
                    path: path.to_path_buf(),
                    flavor,
                }),
            )),
            (None, None) => Err(
                "El .db no tiene tabla de favoritos ni de capítulos descargados (¿es de FMD2 o FMD3?)"
                    .into(),
            ),
        };
    }

    // Folder: probe the known filenames of both apps. `favorites.db` is shared, so
    // its flavor comes from `classify`, not from the name.
    let mut favorites: Option<Source> = None;
    let mut marks: Option<Source> = None;
    for name in [
        FMD2_FAVORITES_FILE,
        FMD2_DOWNLOADED_FILE,
        FMD3_DOWNLOADED_FILE,
    ] {
        let Some(file) = find_file(path, name) else {
            continue;
        };
        let (fav, mk) = classify(&file);
        if let (Some(flavor), None) = (fav, &favorites) {
            favorites = Some(Source {
                path: file.clone(),
                flavor,
            });
        }
        if let (Some(flavor), None) = (mk, &marks) {
            marks = Some(Source { path: file, flavor });
        }
    }

    if favorites.is_none() && marks.is_none() {
        return Err(format!(
            "La carpeta no contiene bases de datos de FMD2 ni de FMD3: {}",
            path.display()
        ));
    }
    Ok((favorites, marks))
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    // Case-insensitive fallback: the dialog may hand back a differently-cased name.
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
}

/// A temp copy of a source DB, deleted when dropped.
struct TempCopy {
    dir: PathBuf,
    file: PathBuf,
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Copy `src` (plus its `-wal` / `-shm` sidecars) to a temp dir and open it there.
/// Never opens the source file directly — that could recover/checkpoint a WAL
/// underneath a running FMD2/FMD3.
fn open_copy(src: &Path) -> Result<(Connection, TempCopy), String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("import.db")
        .to_string();
    let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("fmd3-db-import-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let guard = TempCopy {
        dir: dir.clone(),
        file: dir.join(&name),
    };

    std::fs::copy(src, &guard.file)
        .map_err(|e| format!("No se pudo leer {}: {e}", src.display()))?;
    let src_s = src.to_string_lossy().to_string();
    let dst_s = guard.file.to_string_lossy().to_string();
    for ext in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{src_s}{ext}"));
        if from.is_file() {
            let _ = std::fs::copy(&from, format!("{dst_s}{ext}"));
        }
    }

    let conn = Connection::open(&guard.file).map_err(|e| e.to_string())?;
    Ok((conn, guard))
}

/* ------------------------------------------------------------------- mapping */

/// FMD2 writes `2026-07-28 22:33:25.429`; FMD3 stores RFC3339. Unparseable input
/// becomes `""`, which every `favorites_*` timestamp setter treats as "leave alone".
fn to_rfc3339(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.to_rfc3339();
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return naive.and_utc().to_rfc3339();
        }
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        if let Some(naive) = date.and_hms_opt(0, 0, 0) {
            return naive.and_utc().to_rfc3339();
        }
    }
    String::new()
}

/// FMD2 multiline link lists terminate lines with `\r\r\n` (a doubled CR), so a
/// plain `.lines()` leaves stray `\r` behind. Split on both and drop empties.
fn split_links(text: &str) -> Vec<String> {
    text.split(['\r', '\n'])
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

fn is_module_id(s: &str) -> bool {
    s.len() == MODULE_ID_LEN && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/* ------------------------------------------------------------------ favorites */

/// One favorite normalized out of either schema, before it is written.
struct Incoming {
    module_id: String,
    /// Empty for FMD2 (it stores neither) — then the installed module supplies them.
    module_name: String,
    root_url: String,
    /// Absolute or site-relative; absolutized against `root_url`.
    manga_url: String,
    title: String,
    last_chapter_link: String,
    last_chapter_name: String,
    chapter_count: i64,
    seen: String,
    enabled: bool,
    status: String,
    date_added: String,
    last_checked_at: String,
    last_updated_at: String,
}

/// Writes normalized favorites, carrying the cross-row state (dedupe index, the
/// module IDs it had to give up on) that the per-row mapping needs.
struct FavoriteWriter<'a> {
    db: &'a db::Db,
    existing: std::collections::HashMap<(String, String), String>,
    unknown: std::collections::BTreeSet<String>,
    disabled: std::collections::BTreeSet<String>,
}

impl<'a> FavoriteWriter<'a> {
    fn new(db: &'a db::Db) -> Result<Self, String> {
        Ok(Self {
            db,
            existing: db::favorites_path_key_index(db)?,
            unknown: Default::default(),
            disabled: Default::default(),
        })
    }

    fn write(&mut self, inc: Incoming) -> bool {
        let module_id = inc.module_id.trim().to_ascii_lowercase();
        if module_id.is_empty() || inc.manga_url.trim().is_empty() {
            return false;
        }

        // Prefer the installed module's metadata (names and root URLs drift over
        // time); fall back to whatever the source carried, which is how an FMD3
        // backup still restores for a module the user has not installed yet. FMD2
        // carries neither, so there it is the module or nothing.
        let meta = crate::lua_host::find_by_id(&module_id);
        let (module_name, root_url) = match &meta {
            Some(m) => (m.name.clone(), m.root_url.clone()),
            None if !inc.root_url.trim().is_empty() => {
                (inc.module_name.clone(), inc.root_url.clone())
            }
            None => {
                self.unknown.insert(module_id);
                return false;
            }
        };
        if meta.is_some() && crate::settings_keys::module_disabled(&module_id) {
            self.disabled.insert(module_name.clone());
        }

        let built = crate::lua_host::maybe_fill_host(&root_url, inc.manga_url.trim());
        let key = db::mark_key(&built);
        // Reuse the URL form already stored for this manga, if any: `manga_url` is
        // UNIQUE, so a trailing-slash variant would insert a second row instead of
        // updating the one the user already has.
        let manga_url = self
            .existing
            .get(&(module_id.clone(), key.clone()))
            .cloned()
            .unwrap_or(built);

        let fav = match db::favorites_add(
            self.db,
            &module_id,
            &module_name,
            &root_url,
            &manga_url,
            inc.title.trim(),
            &inc.last_chapter_link,
            &inc.last_chapter_name,
            inc.chapter_count,
            &inc.seen,
        ) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("db_import: se omite {manga_url}: {e}");
                return false;
            }
        };

        let _ = db::favorites_restore_timestamps(
            self.db,
            &manga_url,
            &inc.date_added,
            &inc.last_checked_at,
        );
        let _ = db::favorites_restore_meta(self.db, &manga_url, &inc.last_updated_at, &inc.status);
        if !inc.enabled {
            let _ = db::favorites_set_enabled(self.db, fav.id, false);
        }

        if !key.is_empty() {
            self.existing.insert((module_id, key), manga_url);
        }
        true
    }

    fn finish(self, report: &mut DbImportReport) {
        report.unknown_modules = self.unknown.into_iter().collect();
        if !self.disabled.is_empty() {
            report.warnings.push(format!(
                "Módulos desactivados (actívalos en Ajustes → Sitios Web para revisarlos): {}",
                self.disabled.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }
}

fn import_favorites(
    favorites: &db::Db,
    conn: &Connection,
    flavor: Flavor,
    report: &mut DbImportReport,
) -> Result<(), String> {
    let mut writer = FavoriteWriter::new(favorites)?;

    // Both SELECTs project the same 14 columns in the same order, so one row mapper
    // serves both schemas. FMD2 has no module name / root URL / tip cursor, and
    // supplies `''` for those.
    //
    // Leaving FMD2's `last_chapter_link` empty is deliberate: it has no tip cursor,
    // and seeding one from the seen list would mark a single chapter as read while
    // every other one resurfaces as new on the first check.
    let sql = match flavor {
        Flavor::Fmd2 => {
            "SELECT COALESCE(moduleid,''), '', '', COALESCE(link,''), COALESCE(title,''),
                    '', '', COALESCE(currentchapter,''),
                    COALESCE(downloadedchapterlist,''), COALESCE(enabled,1),
                    COALESCE(status,''), COALESCE(dateadded,''),
                    COALESCE(datelastchecked,''), COALESCE(datelastupdated,'')
             FROM favorites"
        }
        Flavor::Fmd3 => {
            "SELECT COALESCE(module_id,''), COALESCE(module_name,''), COALESCE(root_url,''),
                    COALESCE(manga_url,''), COALESCE(title,''),
                    COALESCE(last_chapter_link,''), COALESCE(last_chapter_name,''),
                    COALESCE(chapter_count,0), COALESCE(seen_chapter_links,''),
                    COALESCE(enabled,1), COALESCE(status,''), COALESCE(date_added,''),
                    COALESCE(last_checked_at,''), COALESCE(last_updated_at,'')
             FROM favorites"
        }
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            // FMD2 stores the chapter count as text (`currentchapter`), FMD3 as an
            // integer, so accept either shape.
            let count = match r.get::<_, rusqlite::types::Value>(7)? {
                rusqlite::types::Value::Integer(i) => i,
                rusqlite::types::Value::Text(t) => t.trim().parse::<i64>().unwrap_or(0),
                _ => 0,
            };
            Ok(Incoming {
                module_id: r.get(0)?,
                module_name: r.get(1)?,
                root_url: r.get(2)?,
                manga_url: r.get(3)?,
                title: r.get(4)?,
                last_chapter_link: r.get(5)?,
                last_chapter_name: r.get(6)?,
                chapter_count: count,
                seen: db::join_chapter_links(&split_links(&r.get::<_, String>(8)?)),
                enabled: r.get::<_, i64>(9)? != 0,
                status: r.get(10)?,
                date_added: to_rfc3339(&r.get::<_, String>(11)?),
                last_checked_at: to_rfc3339(&r.get::<_, String>(12)?),
                last_updated_at: to_rfc3339(&r.get::<_, String>(13)?),
            })
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        match row {
            Ok(inc) => {
                if writer.write(inc) {
                    report.favorites_added += 1;
                } else {
                    report.favorites_skipped += 1;
                }
            }
            Err(e) => {
                eprintln!("db_import: fila de favorites ilegible: {e}");
                report.favorites_skipped += 1;
            }
        }
    }

    writer.finish(report);
    Ok(())
}

/* ------------------------------------------------------------ downloaded marks */

fn import_downloaded(
    downloaded: &db::Db,
    conn: &Connection,
    flavor: Flavor,
    report: &mut DbImportReport,
) -> Result<(), String> {
    let mut batch: Vec<(String, String, String, String)> = Vec::with_capacity(MARK_BATCH);
    let mut malformed = 0usize;
    let flush = |batch: &mut Vec<_>, report: &mut DbImportReport| -> Result<(), String> {
        if !batch.is_empty() {
            report.marks_added += db::downloaded_chapters_import_bulk(downloaded, batch)?;
            batch.clear();
        }
        Ok(())
    };

    match flavor {
        // One row per manga, chapters in a multiline blob, id = moduleid + link.
        Flavor::Fmd2 => {
            let mut stmt = conn
                .prepare("SELECT COALESCE(id,''), COALESCE(chapters,'') FROM downloadedchapters")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let Ok((id, chapters)) = row else {
                    malformed += 1;
                    continue;
                };
                if id.len() <= MODULE_ID_LEN || !is_module_id(&id[..MODULE_ID_LEN]) {
                    malformed += 1;
                    continue;
                }
                let module_id = id[..MODULE_ID_LEN].to_ascii_lowercase();
                let manga_key = db::mark_key(&id[MODULE_ID_LEN..]);
                if manga_key.is_empty() {
                    malformed += 1;
                    continue;
                }
                // The Lua module needn't be installed: marks are inert data and the
                // user may add the module later.
                for link in split_links(&chapters) {
                    let chapter_key = db::mark_key(&link);
                    if chapter_key.is_empty() {
                        continue;
                    }
                    // FMD2 records no timestamp; the bulk insert stamps import time.
                    batch.push((
                        module_id.clone(),
                        manga_key.clone(),
                        chapter_key,
                        String::new(),
                    ));
                }
                if batch.len() >= MARK_BATCH {
                    flush(&mut batch, report)?;
                }
            }
        }
        // Already one row per chapter, with a `downloaded_at` worth preserving.
        Flavor::Fmd3 => {
            let mut stmt = conn
                .prepare(
                    "SELECT COALESCE(module_id,''), COALESCE(manga_url,''),
                            COALESCE(chapter_link,''), COALESCE(downloaded_at,'')
                     FROM downloaded_chapters",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let Ok((module_id, manga_url, chapter_link, at)) = row else {
                    malformed += 1;
                    continue;
                };
                // Re-canonicalize rather than trust the source: an older FMD3 may
                // have written keys under a previous normalization.
                let module_id = module_id.trim().to_ascii_lowercase();
                let manga_key = db::mark_key(&manga_url);
                let chapter_key = db::mark_key(&chapter_link);
                if module_id.is_empty() || manga_key.is_empty() || chapter_key.is_empty() {
                    malformed += 1;
                    continue;
                }
                batch.push((module_id, manga_key, chapter_key, to_rfc3339(&at)));
                if batch.len() >= MARK_BATCH {
                    flush(&mut batch, report)?;
                }
            }
        }
    }

    flush(&mut batch, report)?;
    if malformed > 0 {
        report
            .warnings
            .push(format!("{malformed} filas de marcas ilegibles (omitidas)"));
    }
    Ok(())
}

/* ---------------------------------------------------------------------- entry */

/// Import from a picked `userdata` folder or `.db` file, of either FMD2 or FMD3.
/// Idempotent: favorites upsert on `manga_url` without downgrading progress, and
/// marks are `INSERT OR IGNORE`.
pub fn run(favorites: &db::Db, downloaded: &db::Db, path: &Path) -> Result<DbImportReport, String> {
    let (fav_src, dl_src) = resolve_sources(path)?;
    let mut report = DbImportReport::default();
    // Picking a single `.db` imports only that half by design, so the missing half
    // is not worth warning about. A folder that yields only one is a real surprise.
    let warn_missing = path.is_dir();

    if let Some(src) = &fav_src {
        let (conn, _guard) = open_copy(&src.path)?;
        import_favorites(favorites, &conn, src.flavor, &mut report)?;
        report
            .sources
            .push(format!("{} ({})", file_label(&src.path), src.flavor.label()));
    } else if warn_missing {
        report
            .warnings
            .push("No se encontró base de datos de favoritos".into());
    }

    if let Some(src) = &dl_src {
        let (conn, _guard) = open_copy(&src.path)?;
        import_downloaded(downloaded, &conn, src.flavor, &mut report)?;
        report
            .sources
            .push(format!("{} ({})", file_label(&src.path), src.flavor.label()));
    } else if warn_missing {
        report
            .warnings
            .push("No se encontró base de datos de capítulos descargados".into());
    }

    Ok(report)
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_datetime_shapes() {
        let out = to_rfc3339("2026-07-28 22:33:25.429");
        assert!(out.starts_with("2026-07-28T22:33:25.429"), "{out}");
        assert!(chrono::DateTime::parse_from_rfc3339(&out).is_ok());
        assert_eq!(to_rfc3339(""), "");
        assert_eq!(to_rfc3339("Listo."), "");
        // FMD3's own RFC3339 round-trips instead of being dropped.
        assert!(to_rfc3339("2026-08-01T07:49:54.048641+00:00").starts_with("2026-08-01T07:49:54"));
    }

    #[test]
    fn splits_links_with_doubled_cr() {
        let raw = "/a/1/\r\r\n/a/2/\r\r\n/a/3/\r\r\n/a/4/\r\r\n\r\n";
        assert_eq!(split_links(raw), vec!["/a/1/", "/a/2/", "/a/3/", "/a/4/"]);
        assert!(split_links("  \r\n \r\n").is_empty());
    }

    #[test]
    fn recognizes_module_id_prefix() {
        let id = "5aa6794ceeea4192a63de8296344da3c/manhwa/x/";
        assert!(is_module_id(&id[..MODULE_ID_LEN]));
        assert_eq!(&id[MODULE_ID_LEN..], "/manhwa/x/");
        assert!(!is_module_id("short"));
        assert!(!is_module_id("zzz6794ceeea4192a63de8296344da3c"));
    }

    const FMD2_FAV_DDL: &str = "CREATE TABLE favorites (id TEXT PRIMARY KEY, \"order\" INTEGER,
        enabled BOOLEAN, moduleid TEXT, link TEXT, title TEXT, status TEXT,
        currentchapter TEXT, downloadedchapterlist TEXT, saveto TEXT,
        dateadded DATETIME, datelastchecked DATETIME, datelastupdated DATETIME);";
    const FMD3_FAV_DDL: &str = "CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL, module_name TEXT NOT NULL, root_url TEXT NOT NULL,
        manga_url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, last_chapter_link TEXT,
        last_chapter_name TEXT, chapter_count INTEGER, updated_at TEXT NOT NULL,
        enabled INTEGER, last_checked_at TEXT, seen_chapter_links TEXT,
        pending_new_links TEXT, date_added TEXT, status TEXT, last_updated_at TEXT);";
    const FMD2_MARKS_DDL: &str =
        "CREATE TABLE downloadedchapters (id TEXT PRIMARY KEY, chapters TEXT);";
    const FMD3_MARKS_DDL: &str = "CREATE TABLE downloaded_chapters (module_id TEXT NOT NULL,
        manga_url TEXT NOT NULL, chapter_link TEXT NOT NULL, downloaded_at TEXT NOT NULL,
        PRIMARY KEY (module_id, manga_url, chapter_link));";

    fn scratch_dir(tag: &str) -> PathBuf {
        let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
        let d = std::env::temp_dir().join(format!("fmd3-import-test-{tag}-{stamp}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_db(dir: &Path, name: &str, ddl: &str) -> PathBuf {
        let p = dir.join(name);
        Connection::open(&p).unwrap().execute_batch(ddl).unwrap();
        p
    }

    #[test]
    fn favorites_flavor_comes_from_columns_not_filename() {
        // Both apps name this file `favorites.db`, so only the schema tells them apart.
        let dir = scratch_dir("flavor");
        assert_eq!(
            classify(&write_db(&dir, "favorites.db", FMD2_FAV_DDL)).0,
            Some(Flavor::Fmd2)
        );
        assert_eq!(
            classify(&write_db(&dir, "fmd3-favorites.db", FMD3_FAV_DDL)).0,
            Some(Flavor::Fmd3)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marks_flavor_comes_from_table_name() {
        let dir = scratch_dir("marks");
        assert_eq!(
            classify(&write_db(&dir, "downloadedchapters.db", FMD2_MARKS_DDL)).1,
            Some(Flavor::Fmd2)
        );
        assert_eq!(
            classify(&write_db(&dir, "downloaded.db", FMD3_MARKS_DDL)).1,
            Some(Flavor::Fmd3)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_an_fmd3_userdata_folder() {
        let dir = scratch_dir("fmd3dir");
        write_db(&dir, "favorites.db", FMD3_FAV_DDL);
        write_db(&dir, "downloaded.db", FMD3_MARKS_DDL);

        let (fav, marks) = resolve_sources(&dir).unwrap();
        assert_eq!(fav.map(|s| s.flavor), Some(Flavor::Fmd3));
        assert_eq!(marks.map(|s| s.flavor), Some(Flavor::Fmd3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_an_fmd2_userdata_folder() {
        let dir = scratch_dir("fmd2dir");
        write_db(&dir, "favorites.db", FMD2_FAV_DDL);
        write_db(&dir, "downloadedchapters.db", FMD2_MARKS_DDL);

        let (fav, marks) = resolve_sources(&dir).unwrap();
        assert_eq!(fav.map(|s| s.flavor), Some(Flavor::Fmd2));
        assert_eq!(marks.map(|s| s.flavor), Some(Flavor::Fmd2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_picked_file_is_classified_on_its_own() {
        let dir = scratch_dir("single");
        let p = write_db(&dir, "downloaded.db", FMD3_MARKS_DDL);
        let (fav, marks) = resolve_sources(&p).unwrap();
        assert!(fav.is_none());
        assert_eq!(marks.map(|s| s.flavor), Some(Flavor::Fmd3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unrelated_db_is_rejected() {
        let dir = scratch_dir("junk");
        let p = write_db(&dir, "other.db", "CREATE TABLE masterlist (link TEXT);");
        assert!(resolve_sources(&p).is_err());
        assert!(resolve_sources(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
