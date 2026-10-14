# Distribution (no paid cert needed)

Microsoft Store is **blocked** without an OV/EV code-signing certificate
(self-signed fails certification). These channels need no cert:

| Channel | Cost | What it buys | Status |
|---|---|---|---|
| GitHub Releases + site download center | free | direct installs, in-app updater | ✅ live (v0.5.1) |
| winget | free | `winget install OpenMusic` discoverability | manifests in `distributors/winget/` (this doc §winget) |
| Scoop bucket | free | dev-heavy audience, one-line installs | manifest in `distributors/scoop/` — **untested**, run the trial install first |
| izzyOnDroid / F-Droid (Android) | free | FOSS store listings | not started |

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
