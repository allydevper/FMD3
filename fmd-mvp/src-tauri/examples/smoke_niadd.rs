//! Smoke: NiAddES GetInfo + warmed GetPageNumber (shared cookies/Referer)
//! Usage: cargo run --example smoke_niadd -- [manga_url]

use std::path::PathBuf;

fn main() {
    let manga = std::env::args().nth(1).unwrap_or_else(|| {
        "https://es.niadd.com/manga/One_Piece.html".to_string()
    });
    let out = PathBuf::from(
        std::env::args()
            .nth(2)
            .unwrap_or_else(|| std::env::temp_dir().join("fmd-mvp-niadd").display().to_string()),
    );

    println!("GetInfo: {manga}");
    let info = match fmd_mvp_lib::lua_host::get_info(&manga, Some("482deba9267346418abf3d381712e87a"))
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

    match fmd_mvp_lib::lua_host::get_page_links_warmed(
        &ch.link,
        Some(info.module_id.as_str()),
        Some(manga.as_str()),
    ) {
        Ok(pages) => {
            println!("pages: {}", pages.pages.len());
            for (i, p) in pages.pages.iter().take(3).enumerate() {
                println!("  [{i}] {p}");
            }
            if pages.pages.is_empty() {
                eprintln!("WARN: GetInfo OK pero páginas vacías (CDN/Cloudflare?)");
                std::process::exit(2);
            }
            let take: Vec<_> = pages.pages.into_iter().take(2).collect();
            let dl = fmd_mvp_lib::download_pages_with_referer_for_test(
                &out,
                &info.title,
                0,
                &ch.name,
                &take,
                Some(pages.referer.as_str()),
            );
            println!("saved: {}", dl.files.len());
            for e in &dl.errors {
                eprintln!("  err: {e}");
            }
            if dl.files.is_empty() {
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("ERROR GetPageNumber: {e}");
            eprintln!("(GetInfo OK — el CDN de capítulos puede devolver 403/Cloudflare)");
            std::process::exit(2);
        }
    }
}
