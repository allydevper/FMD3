//! Smoke test: GetPageNumber (+ GetImageURL) + download first N images
//! Usage:
//!   cargo run --example smoke_pages -- [--module <id|name>] <chapter_url> [outdir]

use std::path::PathBuf;

fn parse_args() -> (Option<String>, String, PathBuf) {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut module: Option<String> = None;
    if args.first().map(|s| s.as_str()) == Some("--module") && args.len() >= 2 {
        module = Some(args[1].clone());
        args.drain(0..2);
    }
    let chapter = args.first().cloned().unwrap_or_else(|| {
        "https://www.leercapitulo.co/leer/f8nq66m5nm/one-piece/1/".to_string()
    });
    let out = PathBuf::from(
        args.get(1)
            .cloned()
            .unwrap_or_else(|| "smoke_out".to_string()),
    );
    (module, chapter, out)
}

fn resolve_module_id(spec: &str) -> Option<String> {
    if let Some(m) = fmd_mvp_lib::lua_host::find_by_id(spec) {
        return Some(m.id);
    }
    fmd_mvp_lib::lua_host::modules_list()
        .into_iter()
        .find(|m| m.name.eq_ignore_ascii_case(spec))
        .map(|m| m.id)
}

fn main() {
    let (module_spec, chapter, out) = parse_args();
    let module_id = module_spec.as_deref().and_then(resolve_module_id);
    if let Some(ref spec) = module_spec {
        if module_id.is_none() {
            eprintln!("ERROR: módulo no encontrado: {spec}");
            std::process::exit(1);
        }
        println!("module: {} ({})", spec, module_id.as_deref().unwrap());
    } else {
        println!("module: Auto");
    }
    println!("GetPageNumber: {chapter}");
    match fmd_mvp_lib::lua_host::get_page_links(&chapter, module_id.as_deref()) {
        Ok(result) => {
            println!("module_id: {}", result.module_id);
            println!("referer: {}", result.referer);
            println!("pages: {}", result.pages.len());
            for (i, p) in result.pages.iter().take(3).enumerate() {
                println!("  [{i}] {p}");
            }
            if result.pages.is_empty() {
                eprintln!("WARN: sin páginas");
                std::process::exit(2);
            }
            let referer = result.referer.clone();
            let take: Vec<String> = result.pages.into_iter().take(2).collect();
            let dl = fmd_mvp_lib::download_pages_with_referer_for_test(
                &out,
                "Smoke",
                0,
                "Cap 1",
                &take,
                Some(referer.as_str()),
            );
            println!("saved: {}", dl.files.len());
            for f in &dl.files {
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
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}
