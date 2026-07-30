//! Pack a chapter directory into ZIP/CBZ/PDF/EPUB.
//!
//! Archives are written to `*.partial` then renamed into place so a crash/cancel
//! cannot leave a truncated final file. Pack loops honor an optional cancel flag.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

/// Same token as download cancel so the queue worker treats it uniformly.
pub const PACK_CANCELLED: &str = "cancelado";

/// Slack above the requested quality within which the source JPEG is embedded
/// as-is. Re-encoding a source at or below the target only adds generational
/// loss without shrinking it, and just above the target the trade is still bad:
/// measured on 21 HD pages (setting 80, 4 threads), a quality-88 source costs
/// 5.9s of re-encoding to save 14%, while a quality-95 source costs 6.2s to
/// save 41%. 10 skips the former and keeps the latter. It is also wider than
/// the error of [`estimate_jpeg_quality`] on non-IJG tables.
/// Raise for speed, lower for fidelity to the setting.
const PDF_EMBED_QUALITY_SLACK: u8 = 10;

/// Prefix read to probe a JPEG header. SOF/DQT always precede SOS, so this is
/// enough except for pathological files (which fall back to re-encoding).
const JPEG_PROBE_BYTES: u64 = 128 * 1024;

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

/// Annex K luminance quantization table — the base libjpeg scales by quality.
const IJG_LUMA_BASE: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, //
    12, 12, 14, 19, 26, 58, 60, 55, //
    14, 13, 16, 24, 40, 57, 69, 56, //
    14, 17, 22, 29, 51, 87, 80, 62, //
    18, 22, 37, 56, 68, 109, 103, 77, //
    24, 35, 55, 64, 81, 104, 113, 92, //
    49, 64, 78, 87, 103, 121, 120, 101, //
    72, 92, 95, 98, 112, 100, 103, 99,
];

/// What we need from a JPEG header to decide whether it can go into the PDF
/// untouched, and how to declare it.
#[derive(Debug, Clone, Copy)]
struct JpegInfo {
    width: u32,
    height: u32,
    components: u8,
    precision: u8,
    /// The SOF marker byte. Only C0/C1 (sequential Huffman) are safe to hand to
    /// `/DCTDecode` across viewers; progressive and arithmetic are not.
    sof: u8,
    /// Estimated encoding quality, absent when no luma DQT was found.
    quality: Option<u8>,
}

impl JpegInfo {
    fn is_sequential_huffman(&self) -> bool {
        matches!(self.sof, 0xC0 | 0xC1)
    }

    /// PDF color space for the raw component count, or `None` when the layout
    /// cannot be embedded (CMYK/YCCK needs Adobe APP14 handling — we re-encode).
    fn colorspace(&self) -> Option<&'static str> {
        match self.components {
            1 => Some("/DeviceGray"),
            3 => Some("/DeviceRGB"),
            _ => None,
        }
    }
}

/// Invert libjpeg's quality scaling over the luma table. Approximate for
/// non-IJG tables (Adobe, mozjpeg) — hence [`PDF_EMBED_QUALITY_SLACK`].
fn estimate_jpeg_quality(table: &[u16; 64]) -> u8 {
    let mut sum = 0f64;
    let mut n = 0f64;
    for (k, &q) in table.iter().enumerate() {
        // 0 is invalid; 255 means the encoder clamped, so the ratio would read
        // low and inflate the estimate.
        if q == 0 || q >= 255 {
            continue;
        }
        sum += (q as f64) * 100.0 / (IJG_LUMA_BASE[k] as f64);
        n += 1.0;
    }
    if n == 0.0 {
        return 1; // everything saturated: heavily quantized
    }
    let scale = sum / n;
    let q = if scale > 100.0 {
        5000.0 / scale
    } else {
        (200.0 - scale) / 2.0
    };
    q.round().clamp(1.0, 100.0) as u8
}

/// Walk JPEG markers for SOF geometry plus the luma quantization table.
fn probe_jpeg(buf: &[u8]) -> Option<JpegInfo> {
    if buf.len() < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
        return None;
    }
    let mut luma: Option<[u16; 64]> = None;
    let mut sof_info: Option<(u8, u32, u32, u8, u8)> = None;
    let mut i = 2usize;

    while i + 1 < buf.len() {
        if buf[i] != 0xFF {
            return sof_info.map(|s| finish_probe(s, luma));
        }
        let marker = buf[i + 1];
        // Fill bytes and standalone markers carry no length field.
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0x01 || marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        // SOS: scan data starts, nothing left to learn. EOI: done.
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        if i + 3 >= buf.len() {
            break;
        }
        let len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        let start = i + 4;
        let end = start.checked_add(len - 2)?;
        if end > buf.len() {
            break; // segment truncated by the probe prefix
        }
        let seg = &buf[start..end];

        match marker {
            0xDB => {
                // DQT may pack several tables back to back.
                let mut p = 0usize;
                while p < seg.len() {
                    let precision_16 = seg[p] >> 4 == 1;
                    let table_id = seg[p] & 0x0F;
                    p += 1;
                    let n = if precision_16 { 128 } else { 64 };
                    if p + n > seg.len() {
                        break;
                    }
                    if table_id == 0 && luma.is_none() {
                        let mut t = [0u16; 64];
                        for (k, slot) in t.iter_mut().enumerate() {
                            *slot = if precision_16 {
                                u16::from_be_bytes([seg[p + 2 * k], seg[p + 2 * k + 1]])
                            } else {
                                seg[p + k] as u16
                            };
                        }
                        luma = Some(t);
                    }
                    p += n;
                }
            }
            // Every SOF flavour: C4 (DHT), C8 (reserved) and CC (DAC) are not.
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                if seg.len() < 6 {
                    return None;
                }
                let precision = seg[0];
                let height = u16::from_be_bytes([seg[1], seg[2]]) as u32;
                let width = u16::from_be_bytes([seg[3], seg[4]]) as u32;
                let components = seg[5];
                sof_info = Some((precision, width, height, components, marker));
            }
            _ => {}
        }
        i = end;
    }

    sof_info.map(|s| finish_probe(s, luma))
}

fn finish_probe(
    (precision, width, height, components, sof): (u8, u32, u32, u8, u8),
    luma: Option<[u16; 64]>,
) -> JpegInfo {
    JpegInfo {
        width,
        height,
        components,
        precision,
        sof,
        quality: luma.as_ref().map(estimate_jpeg_quality),
    }
}

/// Embed untouched only when the bytes are safe for `/DCTDecode` *and*
/// re-encoding would not actually honor the requested quality.
fn should_embed(info: &JpegInfo, requested: u8) -> bool {
    info.precision == 8
        && info.is_sequential_huffman()
        && info.colorspace().is_some()
        && info
            .quality
            .is_some_and(|q| q <= requested.saturating_add(PDF_EMBED_QUALITY_SLACK))
}

fn read_prefix(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(max).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Flatten transparency onto white. `to_rgb8` alone drops alpha against black,
/// which darkens the edges of pages that have any.
fn flatten_on_white(src: &image::RgbaImage) -> image::RgbImage {
    let mut out = image::RgbImage::new(src.width(), src.height());
    for (x, y, px) in src.enumerate_pixels() {
        let a = px.0[3] as u32;
        let blend = |c: u8| (((c as u32) * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(
            x,
            y,
            image::Rgb([blend(px.0[0]), blend(px.0[1]), blend(px.0[2])]),
        );
    }
    out
}

fn reencode_as_jpeg(path: &Path, quality: u8) -> Result<(u32, u32, Vec<u8>), String> {
    use image::ImageEncoder;
    let img = image::open(path).map_err(|e| e.to_string())?;
    let rgb = if img.color().has_alpha() {
        flatten_on_white(&img.to_rgba8())
    } else {
        img.to_rgb8()
    };
    let (w, h) = (rgb.width(), rgb.height());
    let mut cursor = std::io::Cursor::new(Vec::new());
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    enc.write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok((w, h, cursor.into_inner()))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PageMode {
    /// Copy the file's bytes straight into the PDF; `len` is the `/Length`.
    Embed { len: u64 },
    Reencode,
}

#[derive(Debug, Clone)]
struct PageSource {
    path: PathBuf,
    w: u32,
    h: u32,
    colorspace: &'static str,
    mode: PageMode,
}

/// Decide per image how it will reach the PDF, without holding page bytes.
/// Unreadable images are skipped (and reported) instead of failing the chapter.
fn plan_pdf_pages(
    images: &[PathBuf],
    quality: u8,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<PageSource>, String> {
    let mut pages = Vec::with_capacity(images.len());

    for path in images {
        abort_if_cancelled(cancel)?;

        // JPEG: probe the header, which also gives us the dimensions and so
        // replaces a second read of the file.
        let probed = if is_jpeg_path(path) {
            read_prefix(path, JPEG_PROBE_BYTES)
                .ok()
                .as_deref()
                .and_then(probe_jpeg)
                .filter(|i| i.width > 0 && i.height > 0)
        } else {
            None
        };

        if let Some(info) = probed {
            if should_embed(&info, quality) {
                match std::fs::metadata(path).map(|m| m.len()) {
                    Ok(len) if len > 0 => {
                        pages.push(PageSource {
                            path: path.clone(),
                            w: info.width,
                            h: info.height,
                            colorspace: info.colorspace().unwrap_or("/DeviceRGB"),
                            mode: PageMode::Embed { len },
                        });
                        continue;
                    }
                    _ => {} // fall through to re-encode
                }
            }
            pages.push(PageSource {
                path: path.clone(),
                w: info.width,
                h: info.height,
                colorspace: "/DeviceRGB",
                mode: PageMode::Reencode,
            });
            continue;
        }

        // Non-JPEG, or a JPEG whose header we could not parse.
        match image::image_dimensions(path) {
            Ok((w, h)) if w > 0 && h > 0 => pages.push(PageSource {
                path: path.clone(),
                w,
                h,
                colorspace: "/DeviceRGB",
                mode: PageMode::Reencode,
            }),
            Ok(_) => eprintln!("pack pdf: se omite {} — dimensiones 0", path.display()),
            Err(e) => eprintln!("pack pdf: se omite {} — {e}", path.display()),
        }
    }

    if pages.is_empty() {
        return Err("no hay imágenes válidas para PDF".into());
    }
    Ok(pages)
}

/// How many pages to re-encode at once. Divided by the chapter-level
/// concurrency so several chapters packing at once do not oversubscribe.
fn pdf_worker_threads() -> usize {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 8);
    let chapters = crate::settings_keys::parallel_tasks().max(1);
    (cpus / chapters).max(1)
}

/// A re-encoded page: dimensions plus JPEG bytes, or why it failed.
type EncodedPage = Result<(u32, u32, Vec<u8>), String>;

/// Counts bytes written so xref offsets can be recorded while streaming.
struct CountingWriter<W: Write> {
    inner: W,
    count: u64,
}

impl<W: Write> CountingWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner, count: 0 }
    }

    fn offset(&self) -> u64 {
        self.count
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Minimal PDF: one JPEG image per page, streamed straight to the `.partial`.
/// Sources already at or below the requested quality are embedded byte-for-byte;
/// anything else is re-encoded, in parallel, in chunks.
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
        let pages = plan_pdf_pages(&images, quality, cancel)?;
        abort_if_cancelled(cancel)?;

        let n = pages.len();
        // Object ids: 1 Catalog, 2 Pages, then Page/Contents/XObject per page.
        let page_ids: Vec<usize> = (0..n).map(|i| 3 + i * 3).collect();
        let total_objects = 3 + n * 3;
        let mut offsets = vec![0u64; total_objects];

        let file = File::create(crate::paths::fs_path(&partial)).map_err(|e| e.to_string())?;
        let mut w = CountingWriter::new(BufWriter::new(file));

        w.write_all(b"%PDF-1.4\n").map_err(|e| e.to_string())?;
        // Binary comment so tools treat the file as binary.
        w.write_all(b"%\xE2\xE3\xCF\xD3\n")
            .map_err(|e| e.to_string())?;

        let write_obj = |w: &mut CountingWriter<BufWriter<File>>,
                             offsets: &mut Vec<u64>,
                             id: usize,
                             body: &[u8]|
         -> Result<(), String> {
            offsets[id] = w.offset();
            w.write_all(format!("{id} 0 obj\n").as_bytes())
                .map_err(|e| e.to_string())?;
            w.write_all(body).map_err(|e| e.to_string())?;
            w.write_all(b"\nendobj\n").map_err(|e| e.to_string())?;
            Ok(())
        };

        write_obj(
            &mut w,
            &mut offsets,
            1,
            b"<< /Type /Catalog /Pages 2 0 R >>",
        )?;
        let kids = page_ids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        write_obj(
            &mut w,
            &mut offsets,
            2,
            format!("<< /Type /Pages /Kids [{kids}] /Count {n} >>").as_bytes(),
        )?;

        let threads = pdf_worker_threads();
        let mut index = 0usize;

        for chunk in pages.chunks(threads) {
            abort_if_cancelled(cancel)?;

            // Re-encode this chunk's pages concurrently; embedded pages need
            // nothing here and stay out of RAM entirely.
            let mut encoded: Vec<Option<EncodedPage>> = vec![None; chunk.len()];
            std::thread::scope(|s| {
                let mut handles = Vec::new();
                for (i, page) in chunk.iter().enumerate() {
                    if page.mode == PageMode::Reencode {
                        let path = page.path.as_path();
                        handles.push((i, s.spawn(move || reencode_as_jpeg(path, quality))));
                    }
                }
                for (i, h) in handles {
                    encoded[i] = Some(
                        h.join()
                            .unwrap_or_else(|_| Err("pánico al recomprimir".into())),
                    );
                }
            });

            for (i, page) in chunk.iter().enumerate() {
                abort_if_cancelled(cancel)?;

                let page_id = page_ids[index];
                let content_id = page_id + 1;
                let image_id = page_id + 2;
                index += 1;

                let reencoded = match encoded[i].take() {
                    Some(Ok(v)) => Some(v),
                    Some(Err(e)) => {
                        return Err(format!("recompresión falló en {}: {e}", page.path.display()))
                    }
                    None => None,
                };

                // Dimensions must match what pass 1 recorded, or MediaBox lies.
                let (pw, ph) = match &reencoded {
                    Some((rw, rh, _)) => (*rw, *rh),
                    None => (page.w, page.h),
                };
                if (pw, ph) != (page.w, page.h) {
                    return Err(format!(
                        "dimensiones inconsistentes en {}: {}x{} vs {pw}x{ph}",
                        page.path.display(),
                        page.w,
                        page.h
                    ));
                }

                let content = format!("q\n{pw} 0 0 {ph} 0 0 cm\n/Im0 Do\nQ\n");
                write_obj(
                    &mut w,
                    &mut offsets,
                    page_id,
                    format!(
                        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] \
                         /Resources << /XObject << /Im0 {image_id} 0 R >> >> \
                         /Contents {content_id} 0 R >>"
                    )
                    .as_bytes(),
                )?;
                write_obj(
                    &mut w,
                    &mut offsets,
                    content_id,
                    format!(
                        "<< /Length {} >>\nstream\n{content}endstream",
                        content.len()
                    )
                    .as_bytes(),
                )?;

                // Image object: header, then the payload streamed in.
                let stream_len = match (&reencoded, page.mode) {
                    (Some((_, _, bytes)), _) => bytes.len() as u64,
                    (None, PageMode::Embed { len }) => len,
                    (None, PageMode::Reencode) => {
                        return Err(format!("página sin datos: {}", page.path.display()))
                    }
                };
                offsets[image_id] = w.offset();
                w.write_all(
                    format!(
                        "{image_id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {pw} \
                         /Height {ph} /ColorSpace {} /BitsPerComponent 8 /Filter /DCTDecode \
                         /Length {stream_len} >>\nstream\n",
                        page.colorspace
                    )
                    .as_bytes(),
                )
                .map_err(|e| e.to_string())?;

                match &reencoded {
                    Some((_, _, bytes)) => w.write_all(bytes).map_err(|e| e.to_string())?,
                    None => {
                        let mut f = File::open(&page.path).map_err(|e| e.to_string())?;
                        let copied = std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
                        // The file changed under us; /Length would be wrong.
                        if copied != stream_len {
                            return Err(format!(
                                "{} cambió durante el empaquetado ({copied} != {stream_len})",
                                page.path.display()
                            ));
                        }
                    }
                }
                w.write_all(b"\nendstream\nendobj\n")
                    .map_err(|e| e.to_string())?;
            }
        }

        abort_if_cancelled(cancel)?;

        let xref_pos = w.offset();
        w.write_all(format!("xref\n0 {total_objects}\n").as_bytes())
            .map_err(|e| e.to_string())?;
        w.write_all(b"0000000000 65535 f \n")
            .map_err(|e| e.to_string())?;
        for off in offsets.iter().skip(1) {
            w.write_all(format!("{off:010} 00000 n \n").as_bytes())
                .map_err(|e| e.to_string())?;
        }
        w.write_all(
            format!(
                "trailer\n<< /Size {total_objects} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
            )
            .as_bytes(),
        )
        .map_err(|e| e.to_string())?;

        // Flush and close before the rename.
        w.flush().map_err(|e| e.to_string())?;
        drop(w);

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

    /// A noisy gradient, not a flat fill: flat images quantize to almost
    /// nothing and make re-encode/embed size comparisons meaningless.
    fn write_jpeg(path: &Path, quality: u8) -> Vec<u8> {
        use image::{ImageEncoder, Rgb, RgbImage};
        let (w, h) = (64u32, 64u32);
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([
                (x * 4 % 256) as u8,
                (y * 4 % 256) as u8,
                ((x * y) % 256) as u8,
            ]);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
        enc.write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        let bytes = cursor.into_inner();
        std::fs::write(path, &bytes).unwrap();
        bytes
    }

    fn write_gray_jpeg(path: &Path, quality: u8) -> Vec<u8> {
        use image::{GrayImage, ImageEncoder, Luma};
        let (w, h) = (32u32, 32u32);
        let mut img = GrayImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Luma([((x * 8 + y * 3) % 256) as u8]);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
        enc.write_image(img.as_raw(), w, h, image::ExtendedColorType::L8)
            .unwrap();
        let bytes = cursor.into_inner();
        std::fs::write(path, &bytes).unwrap();
        bytes
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fmd_pack_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rfind_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .rposition(|win| win == needle)
    }

    /// Every xref entry must point at its own `N 0 obj` header. Works on raw
    /// bytes: JPEG payloads are not UTF-8, so lossy decoding shifts offsets.
    fn assert_xref_consistent(pdf: &[u8]) {
        // Follow startxref rather than searching for "xref", which also matches
        // the "startxref" keyword itself.
        let sx = rfind_bytes(pdf, b"startxref\n").expect("startxref") + b"startxref\n".len();
        let tail = std::str::from_utf8(&pdf[sx..]).expect("trailer tail is ascii");
        let xref_at: usize = tail
            .lines()
            .next()
            .unwrap()
            .trim()
            .parse()
            .expect("startxref offset");
        assert!(
            pdf[xref_at..].starts_with(b"xref\n"),
            "startxref must point at the xref table"
        );

        let table = std::str::from_utf8(&pdf[xref_at..]).expect("xref table is ascii");
        let mut lines = table.lines();
        lines.next(); // "xref"
        let header = lines.next().expect("subsection header");
        let total: usize = header.split_whitespace().nth(1).unwrap().parse().unwrap();
        lines.next(); // free entry for object 0
        for id in 1..total {
            let entry = lines.next().unwrap_or_else(|| panic!("entry for {id}"));
            let off: usize = entry.split_whitespace().next().unwrap().parse().unwrap();
            let expect = format!("{id} 0 obj");
            assert!(
                pdf[off..].starts_with(expect.as_bytes()),
                "xref offset {off} for object {id} does not point at `{expect}`"
            );
        }
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
    fn probe_reads_geometry_and_estimates_quality() {
        let dir = temp_dir("probe");
        let path = dir.join("001.jpg");

        for target in [50u8, 75, 90] {
            let bytes = write_jpeg(&path, target);
            let info = probe_jpeg(&bytes).expect("probe");
            assert_eq!((info.width, info.height), (64, 64));
            assert_eq!(info.components, 3);
            assert_eq!(info.precision, 8);
            assert!(info.is_sequential_huffman());
            let est = info.quality.expect("luma DQT");
            assert!(
                est.abs_diff(target) <= 8,
                "estimated {est} too far from {target}"
            );
        }

        let gray = write_gray_jpeg(&path, 80);
        let info = probe_jpeg(&gray).expect("probe gray");
        assert_eq!(info.components, 1);
        assert_eq!(info.colorspace(), Some("/DeviceGray"));

        assert!(probe_jpeg(b"not a jpeg at all").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_embeds_source_at_or_below_requested_quality() {
        let dir = temp_dir("plan_embed");
        let path = dir.join("001.jpg");
        let original = write_jpeg(&path, 60);
        let len = original.len() as u64;

        // Source ~60, asked for 85: re-encoding would only lose quality.
        let pages = plan_pdf_pages(std::slice::from_ref(&path),85, None).unwrap();
        assert_eq!(pages[0].mode, PageMode::Embed { len });
        assert_eq!(pages[0].colorspace, "/DeviceRGB");

        // Source ~60, asked for 40: honor the setting and re-encode.
        let pages = plan_pdf_pages(std::slice::from_ref(&path),40, None).unwrap();
        assert_eq!(pages[0].mode, PageMode::Reencode);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_reencodes_source_above_requested_quality() {
        let dir = temp_dir("plan_reenc");
        let path = dir.join("001.jpg");
        write_jpeg(&path, 95);

        let pages = plan_pdf_pages(std::slice::from_ref(&path),50, None).unwrap();
        assert_eq!(pages[0].mode, PageMode::Reencode);

        // Within the slack, so still embedded rather than pointlessly redone.
        let pages = plan_pdf_pages(std::slice::from_ref(&path),95, None).unwrap();
        assert!(matches!(pages[0].mode, PageMode::Embed { .. }));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_declares_gray_colorspace_for_gray_jpeg() {
        let dir = temp_dir("pdf_gray");
        let gray = write_gray_jpeg(&dir.join("001.jpg"), 40);

        let out = pack_chapter_dir(&dir, "pdf", None).unwrap();
        let pdf = std::fs::read(&out).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(
            pdf.windows(gray.len()).any(|w| w == gray.as_slice()),
            "a low-quality gray JPEG should be embedded untouched"
        );
        assert!(
            text.contains("/ColorSpace /DeviceGray"),
            "1-component JPEG must not be declared /DeviceRGB"
        );
        assert!(!text.contains("/ColorSpace /DeviceRGB"));

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_skips_unreadable_images() {
        let dir = temp_dir("pdf_skip");
        write_jpeg(&dir.join("001.jpg"), 80);
        std::fs::write(dir.join("002.jpg"), b"definitely not a jpeg").unwrap();
        write_jpeg(&dir.join("003.jpg"), 80);

        let out = pack_chapter_dir(&dir, "pdf", None).unwrap();
        let pdf = std::fs::read(&out).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(
            text.contains("/Count 2"),
            "the bad page is skipped, the good ones survive"
        );
        assert_xref_consistent(&pdf);

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_fails_when_no_image_is_readable() {
        let dir = temp_dir("pdf_allbad");
        std::fs::write(dir.join("001.jpg"), b"garbage").unwrap();
        std::fs::write(dir.join("002.png"), b"garbage").unwrap();

        let err = pack_chapter_dir(&dir, "pdf", None).unwrap_err();
        assert_eq!(err, "no hay imágenes válidas para PDF");
        assert!(!dir.with_extension("pdf").exists());
        assert!(!PathBuf::from(format!("{}.pdf.partial", dir.display())).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_writes_consistent_xref_across_chunks() {
        let dir = temp_dir("pdf_xref");
        // More pages than any worker-thread count so several chunks are used,
        // mixing embedded (high quality source) and re-encoded (PNG) pages.
        for i in 0..9 {
            write_jpeg(&dir.join(format!("{i:03}.jpg")), 70);
        }
        let png = image::RgbImage::from_pixel(16, 16, image::Rgb([10u8, 20, 30]));
        png.save(dir.join("100.png")).unwrap();

        let out = pack_chapter_dir(&dir, "pdf", None).unwrap();
        let pdf = std::fs::read(&out).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 10"));
        assert_xref_consistent(&pdf);

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pack_pdf_respects_cancel_mid_chunk() {
        let dir = temp_dir("pdf_cancel");
        for i in 0..6 {
            write_jpeg(&dir.join(format!("{i:03}.jpg")), 95);
        }
        let flag = Arc::new(AtomicBool::new(true));
        let err = pack_chapter_dir(&dir, "pdf", Some(flag.as_ref())).unwrap_err();
        assert_eq!(err, PACK_CANCELLED);
        assert!(!dir.with_extension("pdf").exists());
        assert!(!PathBuf::from(format!("{}.pdf.partial", dir.display())).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
