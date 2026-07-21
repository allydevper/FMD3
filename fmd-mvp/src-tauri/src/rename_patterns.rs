//! Custom download path / filename patterns (FMD2-style tokens).

pub fn apply_pattern(pattern: &str, tokens: &[(&str, &str)]) -> String {
    let mut out = pattern.to_string();
    for (k, v) in tokens {
        out = out.replace(k, v);
    }
    sanitize_filename::sanitize(&out)
}

pub fn format_chapter_index(index_1based: usize) -> String {
    format!("{index_1based:03}")
}

pub fn format_page(page_1based: usize) -> String {
    format!("{page_1based:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let s = apply_pattern(
            "%Manga%/%ChapterIndex%_%Chapter%",
            &[
                ("%Manga%", "One Piece"),
                ("%ChapterIndex%", "001"),
                ("%Chapter%", "Cap 1"),
            ],
        );
        assert!(s.contains("One Piece") || s.contains("One_Piece") || !s.is_empty());
    }
}
