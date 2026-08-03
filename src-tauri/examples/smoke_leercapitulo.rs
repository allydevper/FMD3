//! Smoke: LeerCapitulo download_chapter (pipeline FMD2, sin BeforeDownloadImage).
//!
//! Usage: cargo run --example smoke_leercapitulo -- [manga_url] [output_dir]

use std::path::PathBuf;

const MODULE_ID: &str = "c67d163c51b24bc498e777e2b0d810d2";

fn main() {
    let manga = std::env::args().nth(1).unwrap_or_else(|| {
        "https://www.leercapitulo.co/manga/a1nj60cg/imo-ichirou-s-twitter-shorts/".to_string()
    });
    let out = PathBuf::from(std::env::args().nth(2).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("fmd3-leercapitulo")
            .display()
            .to_string()
    }));

    println!("GetInfo: {manga}");
    let info = match fmd3_lib::lua_host::get_info(&manga, Some(MODULE_ID)) {
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
    let Some(ch) = info.chapters.first() else {
        eprintln!("ERROR: sin capítulos");
        std::process::exit(1);
    };
    println!("chapter[0]: {} -> {}", ch.name, ch.link);

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
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("ERROR download_chapter: {e}");
            std::process::exit(2);
        }
    }
}
