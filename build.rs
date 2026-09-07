fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    gpui_omarchy_shell::write_javascript(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("app/gpui-omarchy"),
    )
    .expect("write bundled gpui-omarchy JavaScript resources");
}
