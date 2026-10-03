fn main() {
    tauri_build::build();

    // The Drive client id is baked in via option_env!. Shell env can be
    // unset between terminals, so build.rs also reads a project-local
    // `.google-client-id` file (gitignored) as a fallback. First match wins:
    // real environment -> file. Whatever is set is emitted as cargo:rustc-env,
    // which is what option_env! sees at compile time.
    println!("cargo:rerun-if-env-changed=TRANCE_MUSIC_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-changed=.google-client-id");
    let id = std::env::var("TRANCE_MUSIC_GOOGLE_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(".google-client-id")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    if let Some(id) = id {
        println!("cargo:rustc-env=TRANCE_MUSIC_GOOGLE_CLIENT_ID={id}");
    }
}
