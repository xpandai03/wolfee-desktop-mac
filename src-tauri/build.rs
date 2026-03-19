fn main() {
    // Inject build timestamp so runtime can log it
    println!(
        "cargo:rustc-env=BUILD_TIMESTAMP={}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    tauri_build::build()
}
