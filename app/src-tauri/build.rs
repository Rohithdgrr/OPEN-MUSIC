fn main() {
    tauri_build::build();

    // `cargo test` links a test executable that ships **no** application
    // manifest, so the Windows loader binds comctl32 v5.82 and the process
    // dies with 0xC0000139 (STATUS_ENTRYPOINT_NOT_FOUND) *before* `main`:
    // `rfd` (pulled in by tauri-plugin-dialog) statically imports
    // `TaskDialogIndirect`, which only exists in comctl32 v6. The shipped app
    // is unaffected because Tauri embeds a manifest into it — the test target
    // is not. Declaring the v6 dependency on **test** link lines only fixes
    // the harness (see ROOM.md §3C L-3).
    //
    // `rustc-link-arg-tests` is the precise flag, but Cargo rejects it here:
    // this package has no `[[test]]` target, and the lib's own unit-test
    // binary does not count as one. So the dependency goes on `link-arg`,
    // which the app binary already satisfies via Tauri's own manifest — the
    // entry is declared twice, which the loader merges.
    //
    // Gate on the **target** OS, not on `cfg(windows)`: a build script is
    // compiled for the host, so `cfg(windows)` is true even when we are
    // cross-compiling, and the flag then reaches the Android linker as
    // `clang: error: no such file or directory: '/MANIFESTDEPENDENCY:...'`.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

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

    // Same deal for Spotify: shell env wins, `.spotify-client-id` (gitignored)
    // is the fallback so a plain `tauri dev` picks it up.
    println!("cargo:rerun-if-env-changed=TRANCE_MUSIC_SPOTIFY_CLIENT_ID");
    println!("cargo:rerun-if-changed=.spotify-client-id");
    let spotify = std::env::var("TRANCE_MUSIC_SPOTIFY_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(".spotify-client-id")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    if let Some(spotify) = spotify {
        println!("cargo:rustc-env=TRANCE_MUSIC_SPOTIFY_CLIENT_ID={spotify}");
    }
}
