//! Manual benchmark / sanity check for the module registry.
//!
//! Ignored by default because it walks the whole `lua/` tree and writes the
//! real on-disk cache. Run it explicitly:
//!
//!     cargo test --test registry_scan -- --ignored --nocapture

use std::time::Instant;

#[test]
#[ignore]
fn scan_and_cache_roundtrip() {
    // First call: cache hit or full scan, depending on current state.
    let t0 = Instant::now();
    let first = fmd_mvp_lib::lua_host::modules_list();
    let first_ms = t0.elapsed().as_millis();
    assert!(!first.is_empty(), "el registry no devolvió módulos");
    println!("primera llamada: {} módulos en {first_ms} ms", first.len());

    // Forced rescan, bypassing the cache entirely.
    let t1 = Instant::now();
    let n = fmd_mvp_lib::lua_host::modules_refresh();
    println!(
        "rescan completo: {n} módulos en {} ms",
        t1.elapsed().as_millis()
    );

    // The cache path and the scan path must agree, in count and in order.
    let after = fmd_mvp_lib::lua_host::modules_list();
    assert_eq!(n, after.len());
    assert_eq!(first.len(), after.len(), "el caché y el escaneo discrepan");
    let ids_first: Vec<&str> = first.iter().map(|m| m.id.as_str()).collect();
    let ids_after: Vec<&str> = after.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids_first, ids_after, "el orden de los módulos cambió");

    // `by_host` is rebuilt on the cache path too: resolving a module by URL
    // must keep working, and `find_by_id` must return the same metadata.
    for meta in first.iter().take(50) {
        let by_id = fmd_mvp_lib::lua_host::find_by_id(&meta.id)
            .unwrap_or_else(|| panic!("find_by_id perdió {}", meta.id));
        assert_eq!(by_id.root_url, meta.root_url);
        assert_eq!(by_id.file_path, meta.file_path);
        assert_eq!(by_id.on_get_info, meta.on_get_info);

        let hits = fmd_mvp_lib::lua_host::modules_match_url(&meta.root_url);
        assert!(
            hits.iter().any(|m| m.id == meta.id),
            "match_url no encontró {} para {}",
            meta.id,
            meta.root_url
        );
    }
}
