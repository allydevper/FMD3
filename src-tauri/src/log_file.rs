//! Best-effort append of runtime log lines to the user-configured log file
//! (`log.enabled` / `log.file` in settings). Failures are swallowed since
//! logging must never break the app flow.

use std::io::Write;
use std::path::PathBuf;

fn log_file_path() -> Option<PathBuf> {
    let name = crate::db::settings_get_direct(crate::settings_keys::LOG_FILE)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "fmd-mvp.log".into());
    let name = name.trim().trim_start_matches(['/', '\\']);
    if name.is_empty() || name.contains("..") {
        return None;
    }
    Some(crate::db::db_path().join(name))
}

/// Append `line` to the configured log file, if `log.enabled` is true.
pub fn append(line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if !crate::settings_keys::bool_setting(crate::settings_keys::LOG_ENABLED, false) {
        return;
    }
    let Some(path) = log_file_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = writeln!(file, "[{ts}] {line}");
}
