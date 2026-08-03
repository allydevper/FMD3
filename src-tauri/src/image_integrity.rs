//! Cheap completeness checks for image files already on disk.
//!
//! A killed download leaves a truncated file behind. Two places must reject
//! those and neither can afford a full decode: the download resume runs per page
//! before any network I/O, and the packer's whole point is to avoid decoding
//! what it can embed verbatim.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Enough to clear the trailing padding some encoders leave after the end marker.
const TAIL_BYTES: u64 = 64;

fn tail(path: &Path, len: u64) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(crate::paths::fs_path(path)).ok()?;
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn tail_contains(path: &Path, len: u64, needle: &[u8]) -> bool {
    tail(path, len).is_some_and(|b| b.windows(needle.len()).any(|w| w == needle))
}

/// The JPEG entropy-coded scan must be terminated by an EOI marker.
pub fn jpeg_scan_is_terminated(path: &Path, len: u64) -> bool {
    tail_contains(path, len, &[0xFF, 0xD9])
}

/// Whether the file looks like a complete image of its own format.
///
/// Only the end-of-image marker is checked, so this catches truncation — the
/// dominant corruption mode — and not arbitrary bit rot in the middle. WebP and
/// AVIF have no equally cheap marker, so for those a non-empty file is all we
/// assert.
pub fn looks_complete(path: &Path) -> bool {
    let Ok(len) = std::fs::metadata(crate::paths::fs_path(path)).map(|m| m.len()) else {
        return false;
    };
    if len == 0 {
        return false;
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => jpeg_scan_is_terminated(path, len),
        Some("png") => tail_contains(path, len, b"IEND"),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fmd_integrity_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn jpeg_bytes(quality: u8) -> Vec<u8> {
        use image::{ImageEncoder, Rgb, RgbImage};
        let mut img = RgbImage::new(32, 32);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x * 8 % 256) as u8, (y * 8 % 256) as u8, 128]);
        }
        let mut cur = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, quality)
            .write_image(img.as_raw(), 32, 32, image::ExtendedColorType::Rgb8)
            .unwrap();
        cur.into_inner()
    }

    #[test]
    fn accepts_complete_files_and_rejects_truncated_ones() {
        let d = dir("basic");

        let jpg = jpeg_bytes(80);
        let good = d.join("a.jpg");
        std::fs::write(&good, &jpg).unwrap();
        assert!(looks_complete(&good));

        let cut = d.join("b.jpg");
        std::fs::write(&cut, &jpg[..jpg.len() * 2 / 3]).unwrap();
        assert!(!looks_complete(&cut), "a truncated JPEG has no EOI");

        let png = d.join("c.png");
        image::RgbImage::from_pixel(8, 8, image::Rgb([1u8, 2, 3]))
            .save(&png)
            .unwrap();
        assert!(looks_complete(&png));

        let png_bytes = std::fs::read(&png).unwrap();
        let cut_png = d.join("d.png");
        std::fs::write(&cut_png, &png_bytes[..png_bytes.len() / 2]).unwrap();
        assert!(!looks_complete(&cut_png), "a truncated PNG has no IEND");

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_empty_and_missing_files() {
        let d = dir("empty");
        let zero = d.join("a.jpg");
        std::fs::write(&zero, b"").unwrap();
        assert!(!looks_complete(&zero));
        // Zero bytes is invalid whatever the extension.
        let zero_webp = d.join("b.webp");
        std::fs::write(&zero_webp, b"").unwrap();
        assert!(!looks_complete(&zero_webp));

        assert!(!looks_complete(&d.join("does_not_exist.jpg")));

        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn formats_without_a_cheap_marker_only_need_content() {
        let d = dir("nomarker");
        let webp = d.join("a.webp");
        std::fs::write(&webp, b"not really a webp but non-empty").unwrap();
        assert!(
            looks_complete(&webp),
            "we deliberately do not try to validate webp/avif"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tolerates_padding_after_the_end_marker() {
        let d = dir("padding");
        let mut jpg = jpeg_bytes(80);
        jpg.extend_from_slice(&[0u8; 16]);
        let p = d.join("a.jpg");
        std::fs::write(&p, &jpg).unwrap();
        assert!(looks_complete(&p));
        let _ = std::fs::remove_dir_all(&d);
    }
}
