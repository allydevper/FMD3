//! Merge the FMD2 listing with a second GitHub tree.
//!
//! Files that exist on only one side stay. When the blob sha differs, the
//! overlay wins only if it actually changed that path since it diverged from
//! upstream and its commit is newer. A stale fork does not replace the rest
//! of the FMD2 tree.

use super::source::github::GithubSource;
use super::source::{RemoteEntry, Source};
use std::collections::{HashMap, HashSet};

pub struct MergedListing {
    pub remote: Vec<RemoteEntry>,
    pub wins: HashSet<String>,
}

/// Overlay replaces a shared path only when its commit is strictly newer.
pub fn overlay_is_newer(overlay_ts: Option<i64>, base_ts: Option<i64>) -> bool {
    match (overlay_ts, base_ts) {
        (Some(overlay), Some(base)) => overlay > base,
        (Some(_), None) => true,
        _ => false,
    }
}

pub fn merge(
    base_src: &dyn Source,
    overlay: &GithubSource,
    base: Vec<RemoteEntry>,
    overlay_list: Vec<RemoteEntry>,
    notes: &mut Vec<String>,
) -> MergedListing {
    let mut by_path: HashMap<String, RemoteEntry> =
        base.into_iter().map(|e| (e.path.clone(), e)).collect();
    let mut wins = HashSet::new();

    let changed = match base_src.compare_base() {
        Some(upstream) => match overlay.changed_against(&upstream) {
            Ok(set) => Some(set),
            Err(e) => {
                notes.push(format!(
                    "No se pudo comparar el overlay con FMD2 ({e}). Se mantienen los archivos de FMD2 y se añaden los que solo están en el overlay."
                ));
                None
            }
        },
        None => {
            notes.push(
                "La fuente base no es GitHub; el overlay solo aporta archivos que FMD2 no tiene."
                    .into(),
            );
            None
        }
    };

    let mut budget = crate::settings_keys::usize_setting(
        crate::settings_keys::MODULES_OVERLAY_DATE_CAP,
        20,
    );
    let mut overlay_n = 0usize;
    let mut fmd2_n = 0usize;
    let mut skipped = 0usize;

    for entry in overlay_list {
        let path = entry.path.clone();
        match by_path.get(&path) {
            None => {
                eprintln!("[OVERLAY] {path}");
                wins.insert(path);
                by_path.insert(entry.path.clone(), entry);
                overlay_n += 1;
            }
            Some(existing) if existing.content_id == entry.content_id => {}
            Some(_) => {
                let Some(changed) = changed.as_ref() else {
                    eprintln!("[FMD2] {path}");
                    fmd2_n += 1;
                    continue;
                };
                if !changed.contains(&path) {
                    eprintln!("[FMD2] {path}");
                    fmd2_n += 1;
                    continue;
                }
                if budget == 0 {
                    skipped += 1;
                    eprintln!("[FMD2] {path}");
                    continue;
                }
                budget -= 1;
                let overlay_ts = overlay.file_updated_at(&path);
                let base_ts = base_src.file_updated_at(&path);
                if overlay_is_newer(overlay_ts, base_ts) {
                    eprintln!("[OVERLAY] {path}");
                    wins.insert(path);
                    by_path.insert(entry.path.clone(), entry);
                    overlay_n += 1;
                } else {
                    eprintln!("[FMD2] {path}");
                    fmd2_n += 1;
                }
            }
        }
    }

    if changed.as_ref().is_some_and(|set| set.len() >= 300) {
        notes.push(
            "La comparación con FMD2 llegó al tope de 300 archivos; el resto se queda en FMD2."
                .into(),
        );
    }
    if overlay_n > 0 || fmd2_n > 0 {
        notes.push(format!(
            "Overlay: {overlay_n} archivo(s) más recientes o exclusivos. FMD2 se queda con {fmd2_n} que ya eran más nuevos."
        ));
    }
    if skipped > 0 {
        notes.push(format!(
            "{skipped} archivo(s) se dejaron en FMD2: se alcanzó el tope de consultas de fecha (modules.overlay.date_cap). Vuelve a comprobar más tarde."
        ));
    }

    let mut remote: Vec<RemoteEntry> = by_path.into_values().collect();
    remote.sort_by(|a, b| a.path.cmp(&b.path));
    MergedListing { remote, wins }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_overlay_wins_and_missing_base_date_yields() {
        assert!(overlay_is_newer(Some(20), Some(10)));
        assert!(!overlay_is_newer(Some(10), Some(20)));
        assert!(!overlay_is_newer(Some(10), Some(10)));
        assert!(overlay_is_newer(Some(10), None));
        assert!(!overlay_is_newer(None, Some(10)));
        assert!(!overlay_is_newer(None, None));
    }
}
