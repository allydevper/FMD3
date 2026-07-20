//! Smoke test: GetPageNumber + download first N images
//! Usage: cargo run --bin smoke_pages -- <chapter_url> [outdir]

use std::path::PathBuf;

fn main() {
    let chapter = std::env::args().nth(1).unwrap_or_else(|| {
        "https://www.leercapitulo.co/leer/f8nq66m5nm/one-piece/1/".to_string()
    });
    let out = PathBuf::from(
        std::env::args()
            .nth(2)
            .unwrap_or_else(|| "smoke_out".to_string()),
    );

    println!("GetPageNumber: {chapter}");
    match fmd_mvp_lib::lua_host::get_page_links(&chapter) {
        Ok(pages) => {
            println!("pages: {}", pages.len());
            for (i, p) in pages.iter().take(3).enumerate() {
                println!("  [{i}] {p}");
            }
            if pages.is_empty() {
                eprintln!("WARN: sin páginas");
                std::process::exit(2);
            }
            // download at most 2 pages
            let take: Vec<String> = pages.into_iter().take(2).collect();
            let result = fmd_mvp_lib::download_pages_for_test(&out, "One Piece", 0, "Cap 1", &take);
            println!("saved: {}", result.files.len());
            for f in &result.files {
                println!("  {f}");
            }
            for e in &result.errors {
                eprintln!("  err: {e}");
            }
            if result.files.is_empty() {
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}
