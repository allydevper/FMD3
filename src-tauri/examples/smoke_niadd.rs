//! Smoke: NiAddES GetInfo + download_chapter (pipeline FMD2).
//!
//! Tras GetInfo, chapter.link es path relativo (/chapter/...). MaybeFillHost → es.niadd.com.
//!
//! Usage: cargo run --example smoke_niadd -- [manga_url] [output_dir]

use std::path::PathBuf;

fn main() {
    let manga = std::env::args().nth(1).unwrap_or_else(|| {
        "https://es.niadd.com/manga/Imo_Ichirou_s_Twitter_Shorts.html".to_string()
    });
    let out = PathBuf::from(
        std::env::args()
            .nth(2)
            .unwrap_or_else(|| std::env::temp_dir().join("fmd3-niadd").display().to_string()),
    );

    println!("Nota: capítulos sin host (RemoveHostFromURLsPair como FMD2).");

    println!("GetInfo: {manga}");
    let info = match fmd3_lib::lua_host::get_info(&manga, Some("482deba9267346418abf3d381712e87a"))
    {
        Ok(i) => i,
        Err(e) => {
            eprintln!("ERROR GetInfo: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "title={} chapters={} module={}",
        info.title,
        info.chapters.len(),
        info.module_id
    );
    if info.module_id != "482deba9267346418abf3d381712e87a" {
        eprintln!("ERROR: module_id inesperado {}", info.module_id);
        std::process::exit(1);
    }
    let Some(ch) = info.chapters.first() else {
        eprintln!("ERROR: sin capítulos");
        std::process::exit(1);
    };
    println!("chapter[0]: {} -> {}", ch.name, ch.link);
    if ch.link.starts_with("http://") || ch.link.starts_with("https://") {
        eprintln!(
            "ERROR: chapter.link aún tiene host (se esperaba path relativo): {}",
            ch.link
        );
        std::process::exit(1);
    }
    if !ch.link.contains("/chapter/") {
        eprintln!("WARN: chapter.link no parece /chapter/...: {}", ch.link);
    }

    println!("download_chapter → {}", out.display());
    match fmd3_lib::download_chapter_for_test(
        &ch.link,
        Some(info.module_id.as_str()),
        Some(manga.as_str()),
        &out,
        &info.title,
        0,
        &ch.name,
    ) {
        Ok(dl) => {
            println!("saved: {}", dl.files.len());
            for f in dl.files.iter().take(3) {
                println!("  {f}");
            }
            for e in &dl.errors {
                eprintln!("  err: {e}");
            }
            if dl.files.is_empty() {
                eprintln!("ERROR: sin archivos guardados");
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("ERROR download_chapter: {e}");
            std::process::exit(2);
        }
    }
}
