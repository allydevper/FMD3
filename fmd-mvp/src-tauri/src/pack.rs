//! Pack a chapter directory into ZIP/CBZ/PDF/EPUB.
//!
//! Archives are written to `*.partial` then renamed into place so a crash/cancel
//! cannot leave a truncated final file. Pack loops honor an optional cancel flag.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

/// Same token as download cancel so the queue worker treats it uniformly.
pub const PACK_CANCELLED: &str = "cancelado";

/// FMD2 threshold: JPG with quality ≥ 75 is embedded as-is (no re-encode).
const PDF_JPEG_EMBED_MIN_QUALITY: u8 = 75;

fn list_image_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = crate::paths::fs_path(dir);
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .as_deref(),
                Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("gif")
            )
        })
        .collect();
    entries.sort();
    Ok(entries)
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|c| c.load(Ordering::SeqCst))
}

fn abort_if_cancelled(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancelled(cancel) {
        Err(PACK_CANCELLED.into())
    } else {
        Ok(())
    }
}

fn remove_if_exists(path: &Path) {
    let p = crate::paths::fs_path(path);
    if p.is_file() {
        let _ = std::fs::remove_file(&p);
    }
}

/// Write bytes to `final_path` via a sibling `*.partial`, then rename.
fn finalize_partial(partial: &Path, final_path: &Path) -> Result<PathBuf, String> {
    let partial_fs = crate::paths::fs_path(partial);
    let final_fs = crate::paths::fs_path(final_path);
    if final_fs.exists() {
        std::fs::remove_file(&final_fs).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&partial_fs, &final_fs).map_err(|e| e.to_string())?;
    if !final_fs.is_file() {
        return Err(format!(
            "archive no encontrado tras empaquetar: {}",
            final_path.display()
        ));
    }
    Ok(crate::paths::strip_long_prefix(&final_fs))
}

fn pack_zip_like(
    dir: &Path,
    ext: &str,
    cancel: Option<&AtomicBool>,
) -> Result<PathBuf, String> {
    abort_if_cancelled(cancel)?;
    let dir = crate::paths::fs_path(dir);
    let out = dir.with_extension(ext);
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    remove_if_exists(&partial);

    let result = (|| {
        abort_if_cancelled(cancel)?;
        let file = File::create(crate::paths::fs_path(&partial)).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        entries.sort();

        for path in entries {
            abort_if_cancelled(cancel)?;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| format!("nombre inválido: {}", path.display()))?;
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            let mut f = File::open(&path).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            zip.write_all(&buf).map_err(|e| e.to_string())?;
        }
        abort_if_cancelled(cancel)?;
        zip.finish().map_err(|e| e.to_string())?;
        finalize_partial(&partial, &out)
    })();

    if result.is_err() {
        remove_if_exists(&partial);
    }
    result
}

fn is_jpeg_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("jpg") | Some("jpeg")
    )
}

fn reencode_as_jpeg(path: &Path, quality: u8) -> Result<(u32, u32, Vec<u8>), String> {
    use image::ImageEncoder;
    let img = image::open(path).map_err(|e| e.to_string())?;
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let mut cursor = std::io::Cursor::new(Vec::new());
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    enc.write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok((w, h, cursor.into_inner()))
}

/// Build one PDF page image: embed JPEG bytes when quality ≥ 75 (FMD2 parity);
/// otherwise decode and re-encode. Non-JPEG always re-encodes to JPEG.
fn jpeg_page_from_path(path: &Path, quality: u8) -> Result<(u32, u32, Vec<u8>), String> {
    if is_jpeg_path(path) && quality >= PDF_JPEG_EMBED_MIN_QUALITY {
        if let (Ok(bytes), Ok((w, h))) = (std::fs::read(path), image::image_dimensions(path)) {
            if w > 0 && h > 0 && !bytes.is_empty() {
                return Ok((w, h, bytes));
            }
        }
        // Corrupt / unreadable header: fall through to re-encode.
    }
    reencode_as_jpeg(path, quality)
}

/// Minimal PDF: one JPEG image per page.
/// JPG with quality ≥ 75 is embedded as-is; other formats / low quality are re-encoded.
fn pack_pdf(dir: &Path, cancel: Option<&AtomicBool>) -> Result<PathBuf, String> {
    abort_if_cancelled(cancel)?;
    let dir = crate::paths::fs_path(dir);
    let images = list_image_files(&dir)?;
    if images.is_empty() {
        return Err("no hay imágenes para PDF".into());
    }

    let out = dir.with_extension("pdf");
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    remove_if_exists(&partial);

    let result = (|| {
        let quality = crate::settings_keys::pdf_quality();
        let mut jpeg_pages: Vec<(u32, u32, Vec<u8>)> = Vec::new();
        for path in &images {
            abort_if_cancelled(cancel)?;
            jpeg_pages.push(jpeg_page_from_path(path, quality)?);
        }

        abort_if_cancelled(cancel)?;

        let mut objects: Vec<Vec<u8>> = Vec::new();
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());

        let n = jpeg_pages.len();
        let mut page_ids = Vec::new();
        let mut next = 3usize;
        for _ in 0..n {
            page_ids.push(next);
            next += 3;
        }

        let kids = page_ids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        objects.push(format!("<< /Type /Pages /Kids [{kids}] /Count {n} >>").into_bytes());

        let mut by_id: std::collections::BTreeMap<usize, Vec<u8>> =
            std::collections::BTreeMap::new();
        by_id.insert(1, objects[0].clone());
        by_id.insert(2, objects[1].clone());

        for (i, (w, h, jpeg)) in jpeg_pages.iter().enumerate() {
            abort_if_cancelled(cancel)?;
            let page_id = page_ids[i];
            let content_id = page_id + 1;
            let image_id = page_id + 2;
            let content = format!("q\n{w} 0 0 {h} 0 0 cm\n/Im0 Do\nQ\n");
            by_id.insert(
                page_id,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] \
                     /Resources << /XObject << /Im0 {image_id} 0 R >> >> \
                     /Contents {content_id} 0 R >>"
                )
                .into_bytes(),
            );
            by_id.insert(
                content_id,
                format!(
                    "<< /Length {} >>\nstream\n{content}endstream",
                    content.len()
                )
                .into_bytes(),
            );
            let mut img_obj = format!(
                "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode \
                 /Length {} >>\nstream\n",
                jpeg.len()
            )
            .into_bytes();
            img_obj.extend_from_slice(jpeg);
            img_obj.extend_from_slice(b"\nendstream");
            by_id.insert(image_id, img_obj);
        }

        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n");
        let mut offsets = vec![0usize; next];
        for (id, body) in &by_id {
            offsets[*id] = pdf.len();
            pdf.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
            pdf.extend_from_slice(body);
            pdf.extend_from_slice(b"\nendobj\n");
        }
        let xref_pos = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {next}\n").as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for id in 1..next {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", offsets[id]).as_bytes());
        }
        pdf.extend_from_slice(
            format!("trailer\n<< /Size {next} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n")
                .as_bytes(),
        );

        abort_if_cancelled(cancel)?;
        std::fs::write(crate::paths::fs_path(&partial), &pdf).map_err(|e| e.to_string())?;
        finalize_partial(&partial, &out)
    })();

    if result.is_err() {
        remove_if_exists(&partial);
    }
    result
}

fn pack_epub(dir: &Path, cancel: Option<&AtomicBool>) -> Result<PathBuf, String> {
    abort_if_cancelled(cancel)?;
    let dir = crate::paths::fs_path(dir);
    let images = list_image_files(&dir)?;
    if images.is_empty() {
        return Err("no hay imágenes para EPUB".into());
    }

    let out = dir.with_extension("epub");
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    remove_if_exists(&partial);

    let title = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Chapter");

    let result = (|| {
        abort_if_cancelled(cancel)?;
        let file = File::create(crate::paths::fs_path(&partial)).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);

        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("mimetype", stored).map_err(|e| e.to_string())?;
        zip.write_all(b"application/epub+zip")
            .map_err(|e| e.to_string())?;

        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        let container = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        zip.start_file("META-INF/container.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(container.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut manifest = String::new();
        let mut spine = String::new();
        let mut nav_points = String::new();

        for (i, path) in images.iter().enumerate() {
            abort_if_cancelled(cancel)?;
            let n = i + 1;
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_ascii_lowercase();
            let media = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => "image/jpeg",
            };
            let img_name = format!("Images/{n:03}.{ext}");
            let page_name = format!("Text/page_{n:03}.xhtml");

            zip.start_file(format!("OEBPS/{img_name}"), deflated)
                .map_err(|e| e.to_string())?;
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;

            let xhtml = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Page {n}</title></head>
<body style="margin:0;padding:0;text-align:center;">
<img src="../{img_name}" alt="page {n}" style="max-width:100%;height:auto;"/>
</body>
</html>"#
            );
            zip.start_file(format!("OEBPS/{page_name}"), deflated)
                .map_err(|e| e.to_string())?;
            zip.write_all(xhtml.as_bytes())
                .map_err(|e| e.to_string())?;

            manifest.push_str(&format!(
                r#"    <item id="img{n}" href="{img_name}" media-type="{media}"/>
    <item id="page{n}" href="{page_name}" media-type="application/xhtml+xml"/>
"#
            ));
            spine.push_str(&format!(r#"    <itemref idref="page{n}"/>"#));
            spine.push('\n');
            nav_points.push_str(&format!(
                r#"    <navPoint id="nav{n}" playOrder="{n}">
      <navLabel><text>Page {n}</text></navLabel>
      <content src="{page_name}"/>
    </navPoint>
"#
            ));
        }

        abort_if_cancelled(cancel)?;

        let opf = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>{title}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">fmd-mvp-{title}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{manifest}  </manifest>
  <spine toc="ncx">
{spine}  </spine>
</package>"#
        );
        zip.start_file("OEBPS/content.opf", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(opf.as_bytes())
            .map_err(|e| e.to_string())?;

        let ncx = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="fmd-mvp-{title}"/>
  </head>
  <docTitle><text>{title}</text></docTitle>
  <navMap>
{nav_points}  </navMap>
</ncx>"#
        );
        zip.start_file("OEBPS/toc.ncx", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(ncx.as_bytes())
            .map_err(|e| e.to_string())?;

        abort_if_cancelled(cancel)?;
        zip.finish().map_err(|e| e.to_string())?;
        finalize_partial(&partial, &out)
    })();

    if result.is_err() {
        remove_if_exists(&partial);
    }
    result
}

pub fn pack_chapter_dir(
    dir: &Path,
    format: &str,
    cancel: Option<&AtomicBool>,
) -> Result<PathBuf, String> {
    match format {
        "cbz" => pack_zip_like(dir, "cbz", cancel),
        "zip" => pack_zip_like(dir, "zip", cancel),
        "pdf" => pack_pdf(dir, cancel),
        "epub" => pack_epub(dir, cancel),
        _ => Err(format!("formato de pack desconocido: {format}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Arc;

    fn write_tiny_jpeg(path: &Path) -> Vec<u8> {
        use image::{ImageBuffer, ImageEncoder, Rgb};
        let img: ImageBuffer<Rgb<u8>, _> =
            ImageBuffer::from_pixel(8, 8, Rgb([200u8, 100, 50]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 90);
        enc.write_image(img.as_raw(), 8, 8, image::ExtendedColorType::Rgb8)
            .unwrap();
        let bytes = cursor.into_inner();
        std::fs::write(path, &bytes).unwrap();
        bytes
    }

    #[test]
    fn packs_cbz() {
        let dir = std::env::temp_dir().join(format!("fmd_pack_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("001.jpg"))
            .unwrap()
            .write_all(b"fake")
            .unwrap();
        let out = pack_chapter_dir(&dir, "cbz", None).unwrap();
        assert!(out.exists());
        assert_eq!(out.extension().unwrap(), "cbz");
        assert!(!PathBuf::from(format!("{}.partial", out.display())).exists());
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_respects_cancel() {
        let dir = std::env::temp_dir().join(format!("fmd_pack_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("001.jpg"))
            .unwrap()
            .write_all(b"fake")
            .unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        let err = pack_chapter_dir(&dir, "zip", Some(flag.as_ref())).unwrap_err();
        assert_eq!(err, PACK_CANCELLED);
        let out = dir.with_extension("zip");
        assert!(!out.exists());
        assert!(!PathBuf::from(format!("{}.partial", out.display())).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_embeds_jpeg_when_quality_high() {
        let dir = std::env::temp_dir().join(format!("fmd_pack_pdf_hi_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jpg_path = dir.join("001.jpg");
        let original = write_tiny_jpeg(&jpg_path);

        let (w, h, bytes) = jpeg_page_from_path(&jpg_path, 85).unwrap();
        assert_eq!((w, h), (8, 8));
        assert_eq!(bytes, original, "quality ≥ 75 must embed JPEG bytes as-is");

        let out = pack_chapter_dir(&dir, "pdf", None).unwrap();
        assert!(out.exists());
        let pdf = std::fs::read(&out).unwrap();
        assert!(
            pdf.windows(original.len()).any(|w| w == original.as_slice()),
            "PDF must contain the original JPEG payload"
        );
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_reencodes_when_quality_low() {
        let dir = std::env::temp_dir().join(format!("fmd_pack_pdf_lo_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jpg_path = dir.join("001.jpg");
        let original = write_tiny_jpeg(&jpg_path);

        let (w, h, bytes) = jpeg_page_from_path(&jpg_path, 50).unwrap();
        assert_eq!((w, h), (8, 8));
        assert_ne!(
            bytes, original,
            "quality < 75 must re-encode (bytes should differ)"
        );
        assert!(
            bytes.starts_with(&[0xFF, 0xD8]),
            "re-encoded output must still be JPEG"
        );

        // Smoke: pack still produces a valid PDF file (uses settings quality, usually ≥ 75).
        let out = pack_chapter_dir(&dir, "pdf", None).unwrap();
        assert!(out.exists());
        assert_eq!(out.extension().unwrap(), "pdf");
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
