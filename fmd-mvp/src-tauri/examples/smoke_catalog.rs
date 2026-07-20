//! Smoke: UpdateList LoliVault → catalog search
//! Usage: cargo run --example smoke_catalog [--import path.db]

fn main() {
    const LOLI: &str = "218b722b1eb34f2aa3863f84538c5b08";
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(|s| s.as_str()) == Some("--import") && args.len() >= 2 {
        let path = &args[1];
        println!("Import {path} → {LOLI}");
        match fmd_mvp_lib::catalog_import_for_test(LOLI, path) {
            Ok(st) => {
                println!("OK count={} path={}", st.count, st.path);
            }
            Err(e) => {
                eprintln!("ERROR import: {e}");
                std::process::exit(1);
            }
        }
        args.drain(0..2);
    } else {
        println!("UpdateList LoliVault ({LOLI})…");
        match fmd_mvp_lib::catalog_update_for_test(LOLI) {
            Ok(st) => {
                println!(
                    "OK inserted={} total_in_db={} pages={}",
                    st.inserted, st.total_in_db, st.pages_fetched
                );
                if st.total_in_db == 0 {
                    eprintln!("WARN: catálogo vacío");
                    std::process::exit(2);
                }
            }
            Err(e) => {
                eprintln!("ERROR update: {e}");
                std::process::exit(1);
            }
        }
    }

    let hits = fmd_mvp_lib::catalog_search_for_test(LOLI, "", 5, 0).unwrap_or_default();
    println!("sample {}:", hits.len());
    for h in &hits {
        println!("  {} -> {}", h.title, h.link);
    }
    if hits.is_empty() {
        eprintln!("WARN: search vacío");
        std::process::exit(2);
    }
}
