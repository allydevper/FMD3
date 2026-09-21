//! Host UI language (`en` / `es`). Reads `app.language`; default Spanish.

use std::sync::atomic::{AtomicU8, Ordering};

const UNSET: u8 = 255;
const ES: u8 = 0;
const EN: u8 = 1;

static LANG: AtomicU8 = AtomicU8::new(UNSET);

pub fn refresh() {
    LANG.store(UNSET, Ordering::Relaxed);
}

fn lang() -> u8 {
    let cached = LANG.load(Ordering::Relaxed);
    if cached != UNSET {
        return cached;
    }
    let raw = crate::db::settings_get_direct(crate::settings_keys::APP_LANGUAGE)
        .ok()
        .flatten()
        .unwrap_or_default();
    let v = raw.trim().to_ascii_lowercase();
    let code = if v == "en" || v == "english" || v.starts_with("en-") || v.starts_with("en_") {
        EN
    } else {
        ES
    };
    LANG.store(code, Ordering::Relaxed);
    code
}

pub fn is_en() -> bool {
    lang() == EN
}

pub fn code() -> &'static str {
    if is_en() {
        "en"
    } else {
        "es"
    }
}

pub fn t(es: &'static str, en: &'static str) -> &'static str {
    if is_en() {
        en
    } else {
        es
    }
}
