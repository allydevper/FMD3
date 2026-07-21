fn main() {
    cc::Build::new()
        .file("vendor/duktape/duktape.c")
        .file("vendor/duktape/fmd_duk_wrap.c")
        .include("vendor/duktape")
        .warnings(false)
        .compile("duktape");

    tauri_build::build();
}
