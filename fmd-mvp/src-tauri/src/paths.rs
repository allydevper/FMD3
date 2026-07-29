//! Windows long-path helpers (FMD2 parity).
//!
//! - When `paths.long_paths` is on: prefix absolute paths with `\\?\` / `\\?\UNC\` for I/O.
//! - When off: truncate download folder paths so they stay under `MAX_PATHDIR` (247).

use std::path::{Path, PathBuf};

/// FMD2 `MAX_PATHDIR` — leave room under Win32 `MAX_PATH` (260) for a filename.
pub const MAX_PATHDIR: usize = 247;

fn long_paths_enabled() -> bool {
    #[cfg(windows)]
    {
        crate::settings_keys::bool_setting(crate::settings_keys::LONG_PATHS, false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Strip a `\\?\` / `\\?\UNC\` prefix for display or Explorer.
pub fn strip_long_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Path to use with `std::fs` when long paths are enabled (Windows).
pub fn fs_path(path: &Path) -> PathBuf {
    fs_path_with(path, long_paths_enabled())
}

pub fn fs_path_with(path: &Path, long_paths: bool) -> PathBuf {
    #[cfg(windows)]
    {
        if !long_paths {
            return path.to_path_buf();
        }
        let abs = if path.as_os_str().is_empty() {
            return path.to_path_buf();
        } else if path.is_absolute() {
            path.to_path_buf()
        } else {
            match std::env::current_dir() {
                Ok(cwd) => cwd.join(path),
                Err(_) => path.to_path_buf(),
            }
        };
        let s = abs.to_string_lossy();
        if s.starts_with(r"\\?\") {
            return abs;
        }
        if let Some(rest) = s.strip_prefix(r"\\") {
            // \\server\share\... → \\?\UNC\server\share\...
            return PathBuf::from(format!(r"\\?\UNC\{rest}"));
        }
        PathBuf::from(format!(r"\\?\{s}"))
    }
    #[cfg(not(windows))]
    {
        let _ = long_paths;
        path.to_path_buf()
    }
}

/// When long paths are **off**, shorten folder components so the path fits in `MAX_PATHDIR`.
/// When on (or non-Windows), returns `path` unchanged.
pub fn fit_download_path(path: &Path) -> PathBuf {
    fit_download_path_with(path, long_paths_enabled())
}

pub fn fit_download_path_with(path: &Path, long_paths: bool) -> PathBuf {
    #[cfg(not(windows))]
    {
        let _ = long_paths;
        return path.to_path_buf();
    }
    #[cfg(windows)]
    {
        if long_paths {
            return path.to_path_buf();
        }
        let s = path.to_string_lossy();
        if s.chars().count() <= MAX_PATHDIR {
            return path.to_path_buf();
        }
        truncate_path_components(path, MAX_PATHDIR)
    }
}

fn trim_component(name: &str) -> String {
    let mut s = name.trim_end_matches([' ', '.']).to_string();
    if s.is_empty() {
        s.push('_');
    }
    s
}

/// Truncate leaf folder names until the full path string is ≤ `max_chars`.
fn truncate_path_components(path: &Path, max_chars: usize) -> PathBuf {
    let s = path.to_string_lossy().replace('/', "\\");
    if s.chars().count() <= max_chars {
        return PathBuf::from(&s);
    }

    // `C:\Manga\title` → ["C:", "Manga", "title"]
    // `\\NAS\share\a` → ["", "", "NAS", "share", "a"] (UNC)
    let mut parts: Vec<String> = s.split('\\').map(|p| p.to_string()).collect();
    if parts.is_empty() {
        return path.to_path_buf();
    }

    // First mutable index: skip drive (`C:`) or UNC leading empties + server/share.
    let first_mutable = if parts[0].ends_with(':') {
        1
    } else if parts.len() >= 4 && parts[0].is_empty() && parts[1].is_empty() {
        4 // \\server\share\...
    } else {
        0
    };

    loop {
        let joined = join_split_parts(&parts);
        if joined.chars().count() <= max_chars {
            return PathBuf::from(joined);
        }
        let mut shortened = false;
        for i in (first_mutable..parts.len()).rev() {
            if parts[i].is_empty() {
                continue;
            }
            let cur = &parts[i];
            if cur.chars().count() <= 1 {
                continue;
            }
            let keep = cur.chars().count().saturating_sub(8).max(1);
            let mut next: String = cur.chars().take(keep).collect();
            next = trim_component(&next);
            if next != *cur {
                parts[i] = next;
                shortened = true;
                break;
            }
        }
        if !shortened {
            let mut hard: String = join_split_parts(&parts).chars().take(max_chars).collect();
            while hard.ends_with(['\\', ' ', '.']) {
                hard.pop();
            }
            return PathBuf::from(trim_component(&hard));
        }
    }
}

fn join_split_parts(parts: &[String]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    // Preserve UNC `\\server\...` (leading empty + empty).
    if parts.len() >= 2 && parts[0].is_empty() && parts[1].is_empty() {
        return format!("\\\\{}", parts[2..].join("\\"));
    }
    parts.join("\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_prefix_drive() {
        let p = PathBuf::from(r"\\?\C:\Manga\Title");
        assert_eq!(strip_long_prefix(&p), PathBuf::from(r"C:\Manga\Title"));
    }

    #[test]
    fn strip_prefix_unc() {
        let p = PathBuf::from(r"\\?\UNC\NAS\share\Manga");
        assert_eq!(
            strip_long_prefix(&p),
            PathBuf::from(r"\\NAS\share\Manga")
        );
    }

    #[test]
    fn fs_path_short_unchanged_when_off() {
        let p = Path::new(r"C:\Manga\A\1");
        assert_eq!(fs_path_with(p, false), p.to_path_buf());
    }

    #[test]
    fn fs_path_adds_prefix_when_on() {
        let p = Path::new(r"C:\Manga\A\1");
        let out = fs_path_with(p, true);
        assert_eq!(out, PathBuf::from(r"\\?\C:\Manga\A\1"));
    }

    #[test]
    fn fs_path_no_duplicate_prefix() {
        let p = Path::new(r"\\?\C:\Manga\A");
        assert_eq!(fs_path_with(p, true), p.to_path_buf());
    }

    #[test]
    fn fs_path_unc() {
        let p = Path::new(r"\\NAS\share\Manga");
        assert_eq!(
            fs_path_with(p, true),
            PathBuf::from(r"\\?\UNC\NAS\share\Manga")
        );
    }

    #[test]
    fn fit_noop_when_long_paths_on() {
        let long = format!(r"C:\Manga\{}", "T".repeat(300));
        let p = PathBuf::from(&long);
        assert_eq!(fit_download_path_with(&p, true), p);
    }

    #[test]
    fn fit_short_unchanged() {
        let p = Path::new(r"C:\Manga\Short\Ch1");
        assert_eq!(fit_download_path_with(p, false), p.to_path_buf());
    }

    #[test]
    fn fit_truncates_under_max() {
        let title = "T".repeat(200);
        let chap = "C".repeat(200);
        let p = PathBuf::from(format!(r"C:\Manga\{title}\{chap}"));
        assert!(p.to_string_lossy().chars().count() > MAX_PATHDIR);
        let fitted = fit_download_path_with(&p, false);
        let n = fitted.to_string_lossy().chars().count();
        assert!(
            n <= MAX_PATHDIR,
            "fitted len {n} > MAX_PATHDIR ({MAX_PATHDIR}): {}",
            fitted.display()
        );
        assert!(fitted.to_string_lossy().starts_with(r"C:\Manga\"));
    }
}
