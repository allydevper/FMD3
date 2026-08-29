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

fn prefix(path: &Path, n: usize) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(crate::paths::fs_path(path)).ok()?;
    let mut buf = vec![0u8; n];
    let got = f.read(&mut buf).ok()?;
    buf.truncate(got);
    Some(buf)
}

fn bytes_tail_contains(bytes: &[u8], needle: &[u8]) -> bool {
    let start = bytes.len().saturating_sub(TAIL_BYTES as usize);
    bytes[start..].windows(needle.len()).any(|w| w == needle)
}

/// RIFF size (offset 4) covers everything after the first 8 bytes. The first
/// payload chunk after `WEBP` must be a VP8 bitstream, not another `RIFF`.
fn webp_container_ok(head: &[u8], len: u64) -> bool {
    if head.len() < 16 || len < 16 {
        return false;
    }
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WEBP" {
        return false;
    }
    let size = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as u64;
    if size.saturating_add(8) > len {
        return false;
    }
    matches!(&head[12..16], b"VP8 " | b"VP8L" | b"VP8X")
}

/// The JPEG entropy-coded scan must be terminated by an EOI marker.
pub fn jpeg_scan_is_terminated(path: &Path, len: u64) -> bool {
    tail_contains(path, len, &[0xFF, 0xD9])
}

/// Same checks as [`looks_complete`], for bytes still in memory (before write).
pub fn bytes_look_complete(bytes: &[u8], ext: &str) -> bool {
    if bytes.is_empty() {
        return false;
    }
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => bytes_tail_contains(bytes, &[0xFF, 0xD9]),
        "png" => bytes_tail_contains(bytes, b"IEND"),
        "webp" => webp_container_ok(bytes, bytes.len() as u64),
        _ => true,
    }
}

/// Whether the file looks like a complete image of its own format.
///
/// Only a cheap header/tail check: truncation is the dominant corruption mode.
/// JPEG needs EOI, PNG needs IEND, WebP needs a RIFF/WEBP container whose
/// declared size fits and whose first chunk is VP8/VP8L/VP8X. AVIF/GIF still
/// only require a non-empty file.
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
        Some("webp") => prefix(path, 16).is_some_and(|h| webp_container_ok(&h, len)),
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

    fn webp_bytes() -> Vec<u8> {
        use image::{ImageEncoder, Rgb, RgbImage};
        let img = RgbImage::from_pixel(8, 8, Rgb([1u8, 2, 3]));
        let mut cur = std::io::Cursor::new(Vec::new());
        image::codecs::webp::WebPEncoder::new_lossless(&mut cur)
            .write_image(img.as_raw(), 8, 8, image::ExtendedColorType::Rgb8)
            .unwrap();
        cur.into_inner()
    }

    #[test]
    fn webp_accepts_real_container_and_rejects_riff_junk() {
        let d = dir("webp");
        let good_bytes = webp_bytes();
        let good = d.join("a.webp");
        std::fs::write(&good, &good_bytes).unwrap();
        assert!(looks_complete(&good));
        assert!(bytes_look_complete(&good_bytes, "webp"));

        let cut = d.join("b.webp");
        std::fs::write(&cut, &good_bytes[..good_bytes.len() / 2]).unwrap();
        assert!(!looks_complete(&cut), "truncated WebP size field overruns");

        // RIFF....WEBP + another RIFF as the first chunk (the 88/89 failure).
        let mut riff_chunk = b"RIFF".to_vec();
        riff_chunk.extend_from_slice(&8u32.to_le_bytes());
        riff_chunk.extend_from_slice(b"WEBPRIFF");
        let junk = d.join("c.webp");
        std::fs::write(&junk, &riff_chunk).unwrap();
        assert!(!looks_complete(&junk));
        assert!(!bytes_look_complete(&riff_chunk, "webp"));

        let garbage = d.join("d.webp");
        std::fs::write(&garbage, b"not really a webp but non-empty").unwrap();
        assert!(!looks_complete(&garbage));

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
