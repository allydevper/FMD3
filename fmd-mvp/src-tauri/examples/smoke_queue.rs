//! Smoke: open DB, enqueue noop-check of list APIs
fn main() {
    let (main, favorites) = fmd_mvp_lib::open_app_dbs_for_test().expect("db");
    println!("db ok at {:?}", fmd_mvp_lib::db_path_for_test());
    let favs = fmd_mvp_lib::favorites_list_for_test(&favorites).expect("favs");
    let queue = fmd_mvp_lib::queue_list_for_test(&main).expect("queue");
    println!("favorites: {} · queue: {}", favs.len(), queue.len());
}
