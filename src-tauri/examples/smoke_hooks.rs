//! Smoke: registry hooks + BeforeDownloadImage wiring (TuMangaOnline).
//! Verifica que Init registró OnBeforeDownloadImage y DynamicPageLink defaults.
//!
//! Usage: cargo run --example smoke_hooks

fn main() {
    let _ = fmd_mvp_lib::lua_host::ensure_loaded();
    let tmo = fmd_mvp_lib::lua_host::find_by_id("9185eb6c49324a849c7d7925a41ef3a3")
        .expect("TuMangaOnline en registry");
    assert_eq!(tmo.on_before_download_image, "BeforeDownloadImage");
    assert!(tmo.on_task_start.is_empty());
    assert!(!tmo.dynamic_page_link);
    println!(
        "OK TuMangaOnline Before={} Download={} Dynamic={}",
        tmo.on_before_download_image, tmo.on_download_image, tmo.dynamic_page_link
    );

    let eh = fmd_mvp_lib::lua_host::find_by_id("f7ab487b6d29468e8280e8a3cbebbeb4")
        .expect("E-Hentai en registry");
    assert_eq!(eh.on_download_image, "DownloadImage");
    assert!(eh.dynamic_page_link);
    println!(
        "OK E-Hentai Download={} Dynamic={}",
        eh.on_download_image, eh.dynamic_page_link
    );

    let niadd = fmd_mvp_lib::lua_host::find_by_id("482deba9267346418abf3d381712e87a")
        .expect("NiAddES en registry");
    assert_eq!(niadd.on_get_image_url, "GetImageURL");
    assert!(niadd.on_before_download_image.is_empty());
    println!("OK NiAddES GetImageURL registrado, sin Before (como FMD2)");
}
