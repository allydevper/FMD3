//! Streamed archive download + selective extraction.
//!
//! One request replaces hundreds: for a large delta the whole tree is cheaper
//! to fetch as a zip than to pull file by file.

use super::state::safe_rel_path;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const CHUNK: usize = 64 * 1024;
/// Refuse absurd archives rather than filling the disk.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_path() -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "fmd3-lua-{}-{}.zip",
        std::process::id(),
        seq
    ))
}

/// Deletes the temp archive even if extraction bails out early.
struct TmpFile(PathBuf);

impl Drop for TmpFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Download `url` to a temp file, then return the bytes of every entry whose
/// stripped name is in `wanted`.
///
/// `strip` maps an archive entry name to a path relative to the Lua root, or
/// `None` to ignore the entry — that is where the archive's own wrapper
/// directory and anything outside the tracked subtree get dropped.
pub fn download_and_extract(
    client: &reqwest::blocking::Client,
    url: &str,
    wanted: &HashSet<String>,
    strip: &dyn Fn(&str) -> Option<String>,
    on_bytes: &mut dyn FnMut(u64, u64),
    cancel: &dyn Fn() -> bool,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let tmp = TmpFile(tmp_path());

    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("descarga del archivo: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("descarga del archivo: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_ARCHIVE_BYTES {
        return Err(format!("archivo demasiado grande ({total} bytes)"));
    }

    {
        let mut out = File::create(&tmp.0).map_err(|e| format!("{}: {e}", tmp.0.display()))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done: u64 = 0;
        loop {
            if cancel() {
                return Err(super::progress::MODULES_CANCELLED.into());
            }
            let n = resp
                .read(&mut buf)
                .map_err(|e| format!("descarga del archivo: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("escribir temporal: {e}"))?;
            done += n as u64;
            if done > MAX_ARCHIVE_BYTES {
                return Err("archivo demasiado grande".into());
            }
            on_bytes(done, total.max(done));
        }
        out.flush().map_err(|e| format!("escribir temporal: {e}"))?;
    }

    let file = File::open(&tmp.0).map_err(|e| format!("{}: {e}", tmp.0.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("abrir archivo zip: {e}"))?;

    let mut out: HashMap<String, Vec<u8>> = HashMap::with_capacity(wanted.len());
    for i in 0..zip.len() {
        if cancel() {
            return Err(super::progress::MODULES_CANCELLED.into());
        }
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("modules_updater: entrada {i} del zip ilegible: {e}");
                continue;
            }
        };
        if !entry.is_file() {
            continue;
        }
        // `name` is attacker-controlled; `enclosed_name` rejects traversal, and
        // `safe_rel_path` below is the second gate before anything is written.
        let Some(raw) = entry.enclosed_name().map(|p| p.to_string_lossy().to_string()) else {
            continue;
        };
        let Some(rel) = strip(&raw.replace('\\', "/")) else {
            continue;
        };
        if !wanted.contains(&rel) {
            continue;
        }
        if safe_rel_path(&rel).is_err() {
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            eprintln!("modules_updater: {rel} excede el tamaño máximo; se omite");
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            eprintln!("modules_updater: {rel} no se pudo extraer: {e}");
            continue;
        }
        out.insert(rel, bytes);
    }

    Ok(out)
}
