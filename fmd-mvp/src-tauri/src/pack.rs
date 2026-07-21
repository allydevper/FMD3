//! Pack a chapter directory into ZIP/CBZ.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub fn pack_chapter_dir(dir: &Path, format: &str) -> Result<PathBuf, String> {
    let ext = match format {
        "cbz" => "cbz",
        "zip" => "zip",
        _ => return Err(format!("formato de pack desconocido: {format}")),
    };
    let out = dir.with_extension(ext);
    if out.exists() {
        std::fs::remove_file(&out).map_err(|e| e.to_string())?;
    }
    let file = File::create(&out).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    entries.sort();

    for path in entries {
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
    zip.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn packs_cbz() {
        let dir = std::env::temp_dir().join(format!("fmd_pack_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("001.jpg"))
            .unwrap()
            .write_all(b"fake")
            .unwrap();
        let out = pack_chapter_dir(&dir, "cbz").unwrap();
        assert!(out.exists());
        assert_eq!(out.extension().unwrap(), "cbz");
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
