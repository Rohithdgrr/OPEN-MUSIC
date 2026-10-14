# Distribution (no paid cert needed)

Microsoft Store is **blocked** without an OV/EV code-signing certificate
(self-signed fails certification). These channels need no cert:

| Channel | Cost | What it buys | Status |
|---|---|---|---|
| GitHub Releases + site download center | free | direct installs, in-app updater | ✅ live (v0.5.1) |
| winget | free | `winget install OpenMusic` discoverability | manifests in `distributors/winget/` (this doc §winget) |
| Scoop bucket | free | dev-heavy audience, one-line installs | manifest in `distributors/scoop/` — **untested**, run the trial install first |
| izzyOnDroid / F-Droid (Android) | free | FOSS store listings | IzzyOnDroid request #727 open; Fastlane tree in-repo (§IzzyOnDroid); F-Droid recipe draft in `distributors/fdroid/` |

SmartScreen impersonation warning stays on all of these until a trusted
cert signs the binaries — expected, not a defect.

## winget

Manifests mirror the winget-pkgs layout so they copy over verbatim:

```
distributors/winget/manifests/r/Rohithdgrr/OpenMusic/0.5.1/
  Rohithdgrr.OpenMusic.yaml
  Rohithdgrr.OpenMusic.installer.yaml
  Rohithdgrr.OpenMusic.locale.en-US.yaml
```

Hashes were taken from the **hosted** release assets (downloaded
2026-10-14, sizes match the release page: MSI 6.75 MiB, EXE 4.83 MiB):

- MSI `EDBA8495AF36FE4B067521D4760256A515C474E3E5670594478110388CF71859`
- EXE `DBB78E6E5A196D4BAE9F64634ABB48B13DD1C578F43901ACCACDB5107D835C04`

Submit (browser, ~10 min — no CLI token on this machine):

1. Fork `microsoft/winget-pkgs`.
2. Copy the `0.5.1/` folder to
   `manifests/r/Rohithdgrr/OpenMusic/0.5.1/` in the fork.
3. Open a PR named `New version: Rohithdgrr.OpenMusic version 0.5.1` —
   the validator bot checks schema + downloads + hash automatically.
4. Watch for bot comments (usually hash/URL nits); fix, push, merge.

Per release: bump `PackageVersion`, the two URLs and both hashes
(download each asset, `Get-FileHash -Algorithm SHA256`). WingetBot
usually opens update PRs on its own once the package exists.

References: [manifest spec](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest),
[submit guide](https://learn.microsoft.com/en-us/windows/package-manager/package/submit),
[wingetcreate](https://github.com/microsoft/winget-create).

## IzzyOnDroid (request #727 — open)

Fastlane tree (minimum + strongly-recommended sets) lives at
`fastlane/metadata/android/en-US/`: `title.txt`, `short_description.txt`
(56/80), `full_description.txt`, `images/icon.png` (512px), 3 cropped
`phoneScreenshots` (1080x2160, ratio 2.0 — raw captures are 1080x2400 and
trip the validator), `changelogs/<versionCode>.txt` (ASCII, <500 B).

Per release: add `changelogs/<newVersionCode>.txt` **before** tagging —
IzzyOnDroid pulls Fastlane from the same tag as the APK. Screenshots are
re-cropped from `docs/screenshots/mobile/` the same way.

Known gap on the filed issue: "What did the tools help with" is empty and
the manual-tests accountability box is unchecked — the owner must fill both
in the browser (see issue #727).

## F-Droid (main repo) — high friction, draft prepared

`distributors/fdroid/com.openmusic.trancemusic.yml` is a best-effort draft:
MIT ✓, tags ✓, no GMS deps ✓, `NonFreeNet` declared (proprietary catalog
APIs) — but two structural risks: (1) our gradle project is *generated*
(`gen/` is gitignored), so the recipe must run `npm ci` + `tauri android
init` on the buildserver, whose Node.js support is weak — no Tauri app is
known to have cleared this yet; (2) F-Droid signs with its own key, so
F-Droid installs can't update our GitHub APKs in place (uninstall first).

Your steps (need a GitLab account — can't do these for you): file an RFP
issue at `gitlab.com/fdroid/rfp`, then fork `fdroiddata`, add the metadata
as `metadata/com.openmusic.trancemusic.yml`, open MR `New app: OpenMusic`,
and answer the packagers (expect pushback on the init chain).

Fast lane, same APK and cert, no server build: **IzzyOnDroid** pulls our
signed GitHub releases directly — say the word and I'll prep that instead.

## Scoop (untested)

`distributors/scoop/openmusic.json` installs the NSIS build with `/S`.
Before pointing anyone at it, trial it locally:

```powershell
scoop bucket add extras  # or your own bucket
scoop install <path-to>\openmusic.json
```

If the installer block misbehaves, Scoop's
[app manifest docs](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests)
cover the `installer.script` shape — adjust and re-trial.
