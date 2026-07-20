//! Smoke test: GetInfo via Lua module
//! Usage:
//!   cargo run --example smoke_info -- [--module <id|name>] <manga_url>

fn parse_args() -> (Option<String>, String) {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut module: Option<String> = None;
    if args.first().map(|s| s.as_str()) == Some("--module") && args.len() >= 2 {
        module = Some(args[1].clone());
        args.drain(0..2);
    }
    let url = args.first().cloned().unwrap_or_else(|| {
        "https://www.leercapitulo.co/manga/one-piece/".to_string()
    });
    (module, url)
}

fn resolve_module_id(spec: &str) -> Option<String> {
    if let Some(m) = fmd_mvp_lib::lua_host::find_by_id(spec) {
        return Some(m.id);
    }
    let list = fmd_mvp_lib::lua_host::modules_list();
    list.into_iter()
        .find(|m| m.name.eq_ignore_ascii_case(spec))
        .map(|m| m.id)
}

fn main() {
    let (module_spec, url) = parse_args();
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
    println!("GetInfo: {url}");
    match fmd_mvp_lib::lua_host::get_info(&url, module_id.as_deref()) {
        Ok(info) => {
            println!("module_id: {}", info.module_id);
            println!("module_name: {}", info.module_name);
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
