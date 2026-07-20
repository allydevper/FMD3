//! Smoke test: GetInfo via LeerCapitulo.lua
//! Usage: cargo run --bin smoke_info -- <manga_url>

fn main() {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://www.leercapitulo.co/manga/one-piece/".to_string());
    println!("GetInfo: {url}");
    match fmd_mvp_lib::lua_host::get_info(&url) {
        Ok(info) => {
            println!("title: {}", info.title);
            println!("authors: {}", info.authors);
            println!("chapters: {}", info.chapters.len());
            for ch in info.chapters.iter().take(5) {
                println!("  [{}] {} -> {}", ch.index, ch.name, ch.link);
            }
            if info.chapters.len() > 5 {
                println!("  …");
            }
            if info.title.is_empty() && info.chapters.is_empty() {
                eprintln!("WARN: vacío — posible bloqueo del sitio o XPath mismatch");
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}
