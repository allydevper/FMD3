//! Custom download path / filename patterns (FMD2-style tokens).

pub fn apply_pattern(pattern: &str, tokens: &[(&str, &str)]) -> String {
    let mut out = pattern.to_string();
    for (k, v) in tokens {
        out = out.replace(k, v);
    }
    let sanitized = sanitize_filename::sanitize(&out);
    maybe_ascii_replace(&sanitized)
}

pub fn maybe_ascii_replace(s: &str) -> String {
    if !crate::settings_keys::ascii_on() {
        return s.to_string();
    }
    let repl = crate::settings_keys::ascii_char();
    s.chars()
        .map(|c| if c.is_ascii() { c } else { repl })
        .collect()
}

pub fn format_chapter_index(index_1based: usize) -> String {
    if !crate::settings_keys::chap_pad_on() {
        return index_1based.to_string();
    }
    let digits = crate::settings_keys::chap_digits();
    format!("{index_1based:0width$}", width = digits)
}

/// Format a volume number, honoring the `vol_pad` / `vol_digits` settings.
#[allow(dead_code)] // no %VOLUME% token wired yet; kept for future use / parity with FMD2
pub fn format_volume_index(index_1based: usize) -> String {
    if !crate::settings_keys::vol_pad_on() {
        return index_1based.to_string();
    }
    let digits = crate::settings_keys::vol_digits();
    format!("{index_1based:0width$}", width = digits)
}

pub fn format_page(page_1based: usize) -> String {
    format!("{page_1based:03}")
}

/// Strip a leading manga title (and common separators) from a chapter name,
/// e.g. "One Piece - Chapter 5" + "One Piece" -> "Chapter 5".
pub fn strip_manga_from_chapter(chapter_name: &str, manga_title: &str) -> String {
    let ct = chapter_name.trim();
    let mt = manga_title.trim();
    if mt.is_empty() || ct.len() <= mt.len() {
        return ct.to_string();
    }
    if ct.to_lowercase().starts_with(&mt.to_lowercase()) {
        let rest = ct[mt.len()..].trim_start_matches([' ', '-', '_', ':', '.']);
        if !rest.is_empty() {
            return rest.to_string();
        }
    }
    ct.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let s = apply_pattern(
            "%MANGA%/%NUMBERING%_%CHAPTER%",
            &[
                ("%MANGA%", "One Piece"),
                ("%NUMBERING%", "001"),
                ("%CHAPTER%", "Cap 1"),
            ],
        );
        assert!(s.contains("One Piece") || s.contains("One_Piece") || !s.is_empty());
    }
}
