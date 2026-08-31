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

/// Floor for a shortened folder name. Keeps chapter numbering (`006 - Capit`)
/// distinct instead of collapsing every `0xx` leaf to `0`.
const MIN_COMPONENT: usize = 12;
const SHORTEN_STEP: usize = 8;

fn trim_component(name: &str) -> String {
    let mut s = name.trim_end_matches([' ', '.']).to_string();
    if s.is_empty() {
        s.push('_');
    }
    s
}

fn try_shorten_component(cur: &str) -> Option<String> {
    let n = cur.chars().count();
    if n <= MIN_COMPONENT {
        return None;
    }
    let keep = n.saturating_sub(SHORTEN_STEP).max(MIN_COMPONENT);
    let next = trim_component(&cur.chars().take(keep).collect::<String>());
    (next != cur).then_some(next)
}

/// Prefer the longest parent (manga title). Only then shorten the leaf (chapter).
fn index_to_shorten(parts: &[String], first_mutable: usize) -> Option<usize> {
    if first_mutable >= parts.len() {
        return None;
    }
    let last = parts.len() - 1;
    let mut best: Option<(usize, usize)> = None;
    for i in first_mutable..parts.len() {
        // Skip the leaf while a parent can still shrink.
        if i == last && first_mutable < last {
            continue;
        }
        if parts[i].is_empty() {
            continue;
        }
        let n = parts[i].chars().count();
        if n <= MIN_COMPONENT {
            continue;
        }
        if best.map(|(len, _)| n > len).unwrap_or(true) {
            best = Some((n, i));
        }
    }
    if let Some((_, i)) = best {
        return Some(i);
    }
    if !parts[last].is_empty() && parts[last].chars().count() > MIN_COMPONENT {
        Some(last)
    } else {
        None
    }
}

/// Shorten folder names until the full path string is ≤ `max_chars`.
///
/// Parents (title) go first so two chapters that differ at the start stay
/// distinct. No component is cut below [`MIN_COMPONENT`] unless a hard clip
/// of the whole string is the only way to fit.
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
        let Some(i) = index_to_shorten(&parts, first_mutable) else {
            let mut hard: String = joined.chars().take(max_chars).collect();
            while hard.ends_with(['\\', ' ', '.']) {
                hard.pop();
            }
            return PathBuf::from(trim_component(&hard));
        };
        match try_shorten_component(&parts[i]) {
            Some(next) => parts[i] = next,
            None => {
                let mut hard: String = joined.chars().take(max_chars).collect();
                while hard.ends_with(['\\', ' ', '.']) {
                    hard.pop();
                }
                return PathBuf::from(trim_component(&hard));
            }
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

    fn downloads_prefix() -> PathBuf {
        PathBuf::from(
            r"C:\Users\WILMER\Desktop\Proyects\FMD3\src-tauri\target\debug\downloads",
        )
    }

    #[test]
    fn truncate_keeps_chapter_numbering_distinct() {
        let title = "Reencarn_ como un villano menor en mi mundo de juego favorito usando mis conocimientos del juego para vivir libremente, de alguna manera termin_ siendo famoso en todas partes";
        let a = truncate_path_components(
            &downloads_prefix().join(title).join("006 - Capitulo 006"),
            MAX_PATHDIR,
        );
        let b = truncate_path_components(
            &downloads_prefix().join(title).join("011 - Capitulo 011"),
            MAX_PATHDIR,
        );
        assert!(a.to_string_lossy().chars().count() <= MAX_PATHDIR);
        assert!(b.to_string_lossy().chars().count() <= MAX_PATHDIR);
        assert_ne!(a, b, "chapters must not collapse into the same folder");
        assert_ne!(a.file_name().and_then(|n| n.to_str()), Some("0"));
        assert_ne!(b.file_name().and_then(|n| n.to_str()), Some("0"));
        let a_name = a.file_name().unwrap().to_string_lossy();
        let b_name = b.file_name().unwrap().to_string_lossy();
        assert!(a_name.starts_with("006"), "got {a_name}");
        assert!(b_name.starts_with("011"), "got {b_name}");
    }

    #[test]
    fn truncate_long_chapters_stay_distinct() {
        let title = "T".repeat(180);
        let tail = " El regreso del villano con un nombre absurdo que no cabe";
        let a = truncate_path_components(
            &downloads_prefix()
                .join(&title)
                .join(format!("006 - Capitulo 006{tail}")),
            MAX_PATHDIR,
        );
        let b = truncate_path_components(
            &downloads_prefix()
                .join(&title)
                .join(format!("011 - Capitulo 011{tail}")),
            MAX_PATHDIR,
        );
        assert!(a.to_string_lossy().chars().count() <= MAX_PATHDIR);
        assert!(b.to_string_lossy().chars().count() <= MAX_PATHDIR);
        assert_ne!(a, b);
        let a_name = a.file_name().unwrap().to_string_lossy();
        let b_name = b.file_name().unwrap().to_string_lossy();
        assert!(a_name.starts_with("006"), "got {a_name}");
        assert!(b_name.starts_with("011"), "got {b_name}");
    }

    #[test]
    fn truncate_single_huge_component_stays_under_max() {
        let p = PathBuf::from(format!(r"C:\Manga\{}", "X".repeat(400)));
        let fitted = truncate_path_components(&p, MAX_PATHDIR);
        assert!(fitted.to_string_lossy().chars().count() <= MAX_PATHDIR);
    }
}
