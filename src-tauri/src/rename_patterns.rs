//! Custom download path / filename patterns (FMD2-style tokens).
//!
//! All the naming logic lives here and is **pure**: every knob comes from
//! [`RenameOpts`], never from a global settings read. That lets the Options
//! preview run the exact same code as a real download, with the values the
//! user is still typing.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Every download setting that affects the output path / filename.
///
/// `vol_digits` / `chap_digits` of `0` mean "pad disabled" (FMD2 checkbox off).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOpts {
    pub manga_folder_on: bool,
    pub chapter_folder_on: bool,
    pub pat_manga: String,
    pub pat_chapter: String,
    pub pat_page: String,
    pub ascii_on: bool,
    /// Replacement character for non-ASCII; only the first char is used.
    pub ascii_char: String,
    pub remove_manga_from_chapter: bool,
    pub vol_digits: usize,
    pub chap_digits: usize,
}

impl RenameOpts {
    pub fn from_settings() -> Self {
        use crate::settings_keys as sk;
        Self {
            manga_folder_on: sk::manga_folder_on(),
            chapter_folder_on: sk::chapter_folder_on(),
            pat_manga: sk::manga_folder_pattern(),
            pat_chapter: sk::chapter_folder_pattern(),
            pat_page: sk::page_name_pattern(),
            ascii_on: sk::ascii_on(),
            ascii_char: sk::ascii_char().to_string(),
            remove_manga_from_chapter: sk::remove_manga_from_chapter(),
            vol_digits: if sk::vol_pad_on() {
                sk::vol_digits()
            } else {
                0
            },
            chap_digits: if sk::chap_pad_on() {
                sk::chap_digits()
            } else {
                0
            },
        }
    }

    fn ascii_repl(&self) -> char {
        self.ascii_char.chars().next().unwrap_or('_')
    }

    /// FMD2 `ChangeUnicodeCharacter`: swap every non-ASCII char for the replacement.
    pub fn ascii_replace(&self, s: &str) -> String {
        if !self.ascii_on {
            return s.to_string();
        }
        let repl = self.ascii_repl();
        s.chars()
            .map(|c| if c.is_ascii() { c } else { repl })
            .collect()
    }

    /// Substitute tokens, sanitize as a filename, then apply the ASCII rule.
    pub fn apply_pattern(&self, pattern: &str, tokens: &[(&str, &str)]) -> String {
        let mut out = pattern.to_string();
        for (k, v) in tokens {
            out = out.replace(k, v);
        }
        self.ascii_replace(&sanitize_filename::sanitize(&out))
    }

    /// Apply volume/chapter zero-padding (FMD2 `VolumeChapterPadZero`).
    pub fn pad_chapter_title(&self, title: &str) -> String {
        volume_chapter_pad_zero(title, self.vol_digits, self.chap_digits)
    }

    /// Strip manga title (optional) then pad digits — same order as FMD2 CustomRename.
    pub fn prepare_chapter_display(&self, chapter_name: &str, manga_title: &str) -> String {
        let stripped = if self.remove_manga_from_chapter {
            strip_manga_from_chapter(chapter_name, manga_title)
        } else {
            chapter_name.to_string()
        };
        self.pad_chapter_title(&stripped)
    }

    /// 1-based chapter index, zero-padded when the chapter pad is on.
    pub fn format_chapter_index(&self, index_1based: usize) -> String {
        format_index(index_1based, self.chap_digits)
    }

    pub fn manga_pattern(&self) -> &str {
        non_empty(&self.pat_manga, "%MANGA%")
    }

    pub fn chapter_pattern(&self) -> &str {
        non_empty(&self.pat_chapter, "%CHAPTER%")
    }

    pub fn page_pattern(&self) -> &str {
        non_empty(&self.pat_page, "%FILENAME%")
    }
}

fn non_empty<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.trim().is_empty() {
        fallback
    } else {
        s
    }
}

/// Zero-pad `n` to `digits`; `digits == 0` leaves it unpadded.
pub fn format_index(n: usize, digits: usize) -> String {
    if digits == 0 {
        n.to_string()
    } else {
        format!("{n:0width$}", width = digits)
    }
}

pub fn format_page(page_1based: usize) -> String {
    format!("{page_1based:03}")
}

/// FMD2 `VolumeChapterPadZero`: pad volume/chapter digit runs inside a chapter title.
///
/// `vol_len` / `chap_len` of 0 disable that pad (same as FMD2 when the checkbox is off).
pub fn volume_chapter_pad_zero(s: &str, vol_len: usize, chap_len: usize) -> String {
    if vol_len == 0 && chap_len == 0 {
        return s.to_string();
    }

    let mut chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    if n == 0 {
        return String::new();
    }

    let upper: String = s.to_uppercase();

    let mut vol = false;
    let mut vstart: Option<usize> = None;
    let mut vlength: usize = 0;
    let mut padded_vol = String::new();
    // 0-based index to start the chapter digit search (FMD2 leaves `i` after the volume scan).
    let mut chap_search_from: usize = 0;

    if vol_len > 0 {
        if let Some(vp) = char_index_of(&chars, "VOL") {
            let sep_ok = if vp > 1 {
                matches!(chars[vp - 1], ',' | '.' | '-' | '_' | ' ')
            } else {
                true
            };
            vol = sep_ok && !upper.contains("VOLUME NOT AVAILABLE");

            if vol {
                let (vs, vl, next) = digit_run(&chars, vp);
                if let Some(start) = vs {
                    vstart = Some(start);
                    vlength = vl;
                    chap_search_from = next;
                    padded_vol = pad_left(
                        &chars[start..start + vl].iter().collect::<String>(),
                        vol_len,
                    );
                } else {
                    vol = false;
                }
            }
        }
    }

    let mut cha = false;
    let mut cstart: Option<usize> = None;
    let mut clength: usize = 0;
    let mut padded_chap = String::new();

    if chap_len > 0 {
        let from = if chap_search_from >= n {
            0
        } else {
            chap_search_from
        };
        let (mut cs, mut cl, _) = digit_run(&chars, from);
        if cs.is_none() && from != 0 {
            let retry = digit_run(&chars, 0);
            cs = retry.0;
            cl = retry.1;
        }
        if let Some(start) = cs {
            cha = true;
            cstart = Some(start);
            clength = cl;
            padded_chap = pad_left(
                &chars[start..start + cl].iter().collect::<String>(),
                chap_len,
            );
        }
    }

    // Replace the rightmost span first so the earlier index stays valid (FMD2 order).
    match (cstart.filter(|_| cha), vstart.filter(|_| vol)) {
        (Some(cs), Some(vs)) if vs < cs => {
            replace_span(&mut chars, cs, clength, &padded_chap);
            replace_span(&mut chars, vs, vlength, &padded_vol);
        }
        (Some(cs), Some(vs)) => {
            replace_span(&mut chars, vs, vlength, &padded_vol);
            replace_span(&mut chars, cs, clength, &padded_chap);
        }
        (Some(cs), None) => replace_span(&mut chars, cs, clength, &padded_chap),
        (None, Some(vs)) => replace_span(&mut chars, vs, vlength, &padded_vol),
        (None, None) => {}
    }

    chars.into_iter().collect()
}

/// FMD2 CustomRename: if the chapter pattern has neither `%CHAPTER%` nor `%NUMBERING%`,
/// prepend the numbering before applying the pattern.
pub fn ensure_chapter_pattern_numbering(pattern: &str, numbering: &str) -> String {
    if pattern_has_chapter_token(pattern) {
        pattern.to_string()
    } else {
        format!("{numbering}{pattern}")
    }
}

/// True when the pattern already places the chapter somewhere in the name.
pub fn pattern_has_chapter_token(pattern: &str) -> bool {
    let upper = pattern.to_ascii_uppercase();
    upper.contains("%CHAPTER%") || upper.contains("%NUMBERING%") || upper.contains("%CHAPTERINDEX%")
}

/// Strip a leading manga title (and common separators) from a chapter name,
/// e.g. "One Piece - Chapter 5" + "One Piece" -> "Chapter 5".
pub fn strip_manga_from_chapter(chapter_name: &str, manga_title: &str) -> String {
    let ct = chapter_name.trim();
    let mt = manga_title.trim();
    if mt.is_empty() || ct.len() <= mt.len() {
        return ct.to_string();
    }
    // Compare on `ct`'s own byte range: `get` returns None on a non-char boundary,
    // and case folding never shifts the split point.
    let matches_prefix = ct
        .get(..mt.len())
        .is_some_and(|head| head.to_lowercase() == mt.to_lowercase());
    if matches_prefix {
        let rest = ct[mt.len()..].trim_start_matches([' ', '-', '_', ':', '.']);
        if !rest.is_empty() {
            return rest.to_string();
        }
    }
    ct.to_string()
}

fn pad_left(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        return s.to_string();
    }
    let mut out = "0".repeat(width - len);
    out.push_str(s);
    out
}

fn char_index_of(hay: &[char], needle: &str) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| {
        w.iter()
            .zip(&needle)
            .all(|(a, b)| a.to_ascii_uppercase() == *b)
    })
}

/// First run of ASCII digits at or after `from`.
///
/// Returns `(start, length, resume)` where `resume` is where a following search
/// should continue (FMD2 leaves the cursor on the terminating non-digit).
fn digit_run(chars: &[char], from: usize) -> (Option<usize>, usize, usize) {
    let n = chars.len();
    let start = (from..n).find(|&i| chars[i].is_ascii_digit());
    let Some(start) = start else {
        return (None, 0, n);
    };
    let end = (start..n)
        .find(|&i| !chars[i].is_ascii_digit())
        .unwrap_or(n);
    (Some(start), end - start, end)
}

fn replace_span(chars: &mut Vec<char>, start: usize, len: usize, replacement: &str) {
    if start > chars.len() {
        return;
    }
    let end = (start + len).min(chars.len());
    chars.splice(start..end, replacement.chars());
}

/* ---------------------------------------------------------------------- */
/* Options preview                                                         */
/* ---------------------------------------------------------------------- */

const SAMPLE_MANGA: &str = "One Piece";
const SAMPLE_WEBSITE: &str = "MangaDex";
const SAMPLE_AUTHOR: &str = "Eiichiro Oda";
const SAMPLE_CHAPTER: &str = "Chapter 3";
const SAMPLE_CHAPTER_INDEX: usize = 3;

/// Build the same path a real download would produce, using sample metadata.
///
/// Mirrors `manga_output_dir` → `chapter_output_dir` → `work_basename`, so the
/// preview cannot drift from the download path.
pub fn build_preview(opts: &RenameOpts, output_dir: &str, pack_ext: &str) -> String {
    let root = output_dir.trim().trim_end_matches(['\\', '/']);
    let root = if root.is_empty() { "." } else { root };

    let idx = opts.format_chapter_index(SAMPLE_CHAPTER_INDEX);
    let chapter = opts.prepare_chapter_display(SAMPLE_CHAPTER, SAMPLE_MANGA);
    let tokens = chapter_tokens(
        SAMPLE_MANGA,
        SAMPLE_WEBSITE,
        &chapter,
        &idx,
        SAMPLE_AUTHOR,
        SAMPLE_AUTHOR,
    );

    let mut path = PathBuf::from(root);
    if opts.manga_folder_on {
        path = join_fitted(&path, &opts.apply_pattern(opts.manga_pattern(), &tokens));
    }
    if opts.chapter_folder_on {
        let pat = ensure_chapter_pattern_numbering(opts.chapter_pattern(), &idx);
        path = join_fitted(&path, &opts.apply_pattern(&pat, &tokens));
    }

    if !pack_ext.is_empty() {
        // Al empaquetar, el archivo se nombra con la carpeta que se empaqueta
        // (`pack_chapter_dir` hace `dir.with_extension`); las páginas quedan dentro.
        return format!("{}{pack_ext}", path.display());
    }

    let page = format_page(1);
    let leaf = opts.apply_pattern(
        opts.page_pattern(),
        &page_tokens(&page, SAMPLE_MANGA, &chapter, SAMPLE_WEBSITE),
    );
    path.join(leaf).display().to_string()
}

fn join_fitted(base: &Path, segment: &str) -> PathBuf {
    crate::paths::fit_download_path(&base.join(segment))
}

/// Token table for manga / chapter folder patterns.
pub fn chapter_tokens<'a>(
    manga: &'a str,
    website: &'a str,
    chapter: &'a str,
    numbering: &'a str,
    authors: &'a str,
    artists: &'a str,
) -> [(&'a str, &'a str); 10] {
    [
        ("%MANGA%", manga),
        ("%Manga%", manga),
        ("%WEBSITE%", website),
        ("%Website%", website),
        ("%CHAPTER%", chapter),
        ("%Chapter%", chapter),
        ("%AUTHOR%", authors),
        ("%ARTIST%", artists),
        ("%NUMBERING%", numbering),
        ("%ChapterIndex%", numbering),
    ]
}

/// Token table for the page filename pattern.
pub fn page_tokens<'a>(
    page: &'a str,
    manga: &'a str,
    chapter: &'a str,
    website: &'a str,
) -> [(&'a str, &'a str); 8] {
    [
        ("%FILENAME%", page),
        ("%Page%", page),
        ("%MANGA%", manga),
        ("%Manga%", manga),
        ("%CHAPTER%", chapter),
        ("%Chapter%", chapter),
        ("%WEBSITE%", website),
        ("%Website%", website),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Preview paths are built with `Path::join`, so normalise the separator
    /// to keep the expectations readable on any host.
    fn preview(o: &RenameOpts, root: &str, ext: &str) -> String {
        build_preview(o, root, ext).replace('/', "\\")
    }

    fn opts() -> RenameOpts {
        RenameOpts {
            manga_folder_on: true,
            chapter_folder_on: true,
            pat_manga: "%MANGA%".into(),
            pat_chapter: "%CHAPTER%".into(),
            pat_page: "%FILENAME%".into(),
            ascii_on: false,
            ascii_char: "_".into(),
            remove_manga_from_chapter: false,
            vol_digits: 2,
            chap_digits: 3,
        }
    }

    #[test]
    fn tokens() {
        let s = opts().apply_pattern(
            "%MANGA%_%NUMBERING%_%CHAPTER%",
            &[
                ("%MANGA%", "One Piece"),
                ("%NUMBERING%", "001"),
                ("%CHAPTER%", "Cap 1"),
            ],
        );
        assert_eq!(s, "One Piece_001_Cap 1");
    }

    #[test]
    fn pad_chapter_only() {
        assert_eq!(volume_chapter_pad_zero("Chapter 3", 0, 3), "Chapter 003");
        assert_eq!(volume_chapter_pad_zero("Chapter 3", 2, 3), "Chapter 003");
    }

    #[test]
    fn pad_volume_and_chapter() {
        assert_eq!(volume_chapter_pad_zero("Vol.2 Ch.5", 2, 3), "Vol.02 Ch.005");
    }

    #[test]
    fn pad_flags_off() {
        assert_eq!(volume_chapter_pad_zero("Chapter 3", 0, 0), "Chapter 3");
        assert_eq!(volume_chapter_pad_zero("Vol.2 Ch.5", 0, 0), "Vol.2 Ch.5");
    }

    #[test]
    fn pad_volume_only() {
        assert_eq!(volume_chapter_pad_zero("Vol.2 Ch.5", 2, 0), "Vol.02 Ch.5");
    }

    #[test]
    fn pad_keeps_trailing_punctuation() {
        assert_eq!(volume_chapter_pad_zero("Chapter 3.", 0, 3), "Chapter 003.");
        assert_eq!(volume_chapter_pad_zero("Ch.5)", 0, 3), "Ch.005)");
        assert_eq!(
            volume_chapter_pad_zero("Vol.2 Ch.5!", 2, 3),
            "Vol.02 Ch.005!"
        );
    }

    #[test]
    fn pad_digits_to_end_of_string() {
        assert_eq!(volume_chapter_pad_zero("Ch 12", 0, 4), "Ch 0012");
        assert_eq!(volume_chapter_pad_zero("Vol.2", 3, 0), "Vol.002");
    }

    #[test]
    fn pad_already_long_enough() {
        assert_eq!(
            volume_chapter_pad_zero("Chapter 1234", 0, 3),
            "Chapter 1234"
        );
    }

    #[test]
    fn pad_volume_not_available_is_skipped() {
        assert_eq!(
            volume_chapter_pad_zero("Volume not available Ch.5", 2, 3),
            "Volume not available Ch.005"
        );
    }

    #[test]
    fn ensure_numbering_fallback() {
        assert_eq!(ensure_chapter_pattern_numbering("extra", "003"), "003extra");
        assert_eq!(
            ensure_chapter_pattern_numbering("%CHAPTER%", "003"),
            "%CHAPTER%"
        );
        assert_eq!(
            ensure_chapter_pattern_numbering("%NUMBERING%_%CHAPTER%", "003"),
            "%NUMBERING%_%CHAPTER%"
        );
        assert_eq!(
            ensure_chapter_pattern_numbering("%ChapterIndex%", "003"),
            "%ChapterIndex%"
        );
    }

    #[test]
    fn strip_title() {
        assert_eq!(
            strip_manga_from_chapter("One Piece - Chapter 5", "One Piece"),
            "Chapter 5"
        );
    }

    #[test]
    fn strip_title_non_ascii_does_not_panic() {
        // `to_lowercase()` can change byte length; slicing must stay on `ct`'s boundaries.
        assert_eq!(
            strip_manga_from_chapter("Ölümlü Dünya - Bölüm 3", "Ölümlü Dünya"),
            "Bölüm 3"
        );
        assert_eq!(
            strip_manga_from_chapter("İstanbul Hikaye - Bölüm 3", "istanbul hikaye"),
            "İstanbul Hikaye - Bölüm 3"
        );
        assert_eq!(
            strip_manga_from_chapter("日本語のタイトル 第3話", "日本語"),
            "のタイトル 第3話"
        );
    }

    #[test]
    fn strip_title_no_match_is_kept() {
        assert_eq!(
            strip_manga_from_chapter("Naruto - Chapter 5", "One Piece"),
            "Naruto - Chapter 5"
        );
    }

    #[test]
    fn format_index_respects_digits() {
        assert_eq!(format_index(3, 0), "3");
        assert_eq!(format_index(3, 3), "003");
        assert_eq!(format_index(1234, 3), "1234");
    }

    #[test]
    fn preview_matches_defaults() {
        let out = preview(&opts(), "D:\\Manga", "");
        assert_eq!(out, "D:\\Manga\\One Piece\\Chapter 003\\001");
    }

    #[test]
    fn preview_ascii_leaves_the_root_alone() {
        let mut o = opts();
        o.ascii_on = true;
        o.ascii_char = "_".into();
        let out = preview(&o, "D:\\Descargas Manga\\Añejo", "");
        // Only the generated segments are transliterated; the user's root is untouched.
        assert!(out.starts_with("D:\\Descargas Manga\\Añejo\\"));
    }

    /// Al empaquetar, el resultado es la carpeta del capítulo con extensión —
    /// no una página con extensión: `pack_chapter_dir` hace `dir.with_extension`.
    #[test]
    fn preview_pack_names_the_chapter_folder() {
        let mut o = opts();
        o.remove_manga_from_chapter = true;
        o.pat_chapter = "%NUMBERING%_%CHAPTER%".into();
        let out = preview(&o, "D:\\Manga", ".cbz");
        assert_eq!(out, "D:\\Manga\\One Piece\\003_Chapter 003.cbz");
    }

    #[test]
    fn preview_prepends_numbering_when_pattern_lacks_chapter() {
        let mut o = opts();
        o.pat_chapter = "extra".into();
        let out = preview(&o, "D:\\Manga", "");
        assert_eq!(out, "D:\\Manga\\One Piece\\003extra\\001");
    }

    /// La carpeta del capítulo y el `%CHAPTER%` del nombre de archivo tienen que
    /// salir del mismo `prepare_chapter_display`. Es la invariante que sostiene
    /// el congelado en la cola: si divergieran aquí, divergirían también allí.
    #[test]
    fn chapter_display_is_shared_by_folder_and_filename() {
        let mut o = opts();
        o.remove_manga_from_chapter = true;
        o.pat_page = "%CHAPTER%_%FILENAME%".into();
        let display = o.prepare_chapter_display(SAMPLE_CHAPTER, SAMPLE_MANGA);
        let out = preview(&o, "D:\\Manga", "");
        assert_eq!(display, "Chapter 003");
        assert_eq!(out, format!("D:\\Manga\\One Piece\\{display}\\{display}_001"));
    }

    #[test]
    fn preview_folders_off() {
        let mut o = opts();
        o.manga_folder_on = false;
        o.chapter_folder_on = false;
        o.pat_page = "%MANGA%_%CHAPTER%_%FILENAME%".into();
        let out = preview(&o, "D:\\Manga", "");
        assert_eq!(out, "D:\\Manga\\One Piece_Chapter 003_001");
    }
}
