//! Smoke: open DB, enqueue noop-check of list APIs
fn main() {
    let db = fmd_mvp_lib::open_db_for_test().expect("db");
    println!("db ok at {:?}", fmd_mvp_lib::db_path_for_test());
    let favs = fmd_mvp_lib::favorites_list_for_test(&db).expect("favs");
    let queue = fmd_mvp_lib::queue_list_for_test(&db).expect("queue");
    println!("favorites: {} · queue: {}", favs.len(), queue.len());
}
