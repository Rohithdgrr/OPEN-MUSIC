# OpenAPK submission

Form: <https://www.openapk.net/submitapp/> (no account needed — App Title,
Code Repository, Name, Email).

## Precondition: APK in the release (USER BROWSER ACTION)

OpenAPK requires APK files in the repo's release section, and tracks new
versions through the GitHub API. Our v0.5.1 release currently ships **no
APK**, so first: release page → Edit → attach the verified build
`app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
(22.42 MiB, signed `CN=TRANCE MUSIC` 8ad4da6f…cadfb, versionCode 5001,
not debuggable — verified 2026-10-15 via apksigner/aapt).

Keep this exact filename on every future release so their tracker keeps
matching it.

## Form values

- **App Title:** OpenMusic
- **Code Repository:** https://github.com/Rohithdgrr/OPEN-MUSIC
- **Name / E-mail:** yours (used only to verify app details)
- Category on their side: Multimedia.

After listing, Obtainium picks up new tagged + APK releases automatically.
They also ask for their download banner in our README — optional follow-up.
