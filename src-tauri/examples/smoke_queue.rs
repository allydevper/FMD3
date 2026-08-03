//! Smoke: open DB, enqueue noop-check of list APIs
fn main() {
    let (main, favorites, _downloaded) = fmd3_lib::open_app_dbs_for_test().expect("db");
    println!("db ok at {:?}", fmd3_lib::db_path_for_test());
    let favs = fmd3_lib::favorites_list_for_test(&favorites).expect("favs");
    let queue = fmd3_lib::queue_list_for_test(&main).expect("queue");
    println!("favorites: {} · queue: {}", favs.len(), queue.len());

    let dl = fmd3_lib::default_download_dir_for_test();
    println!("descargas por defecto: {:?} (existe: {})", dl, dl.is_dir());
}
