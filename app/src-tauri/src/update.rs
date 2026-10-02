// update.rs — Settings / Updates: signed in-app updates plus release rollback.
//
// Forward updates read the signed `latest.json` manifest attached to the
// newest GitHub release (endpoint in tauri.conf.json); "revert" points the
// same updater at a tagged release's `update.json`. Every package is
// verified against the updater pubkey before a byte is installed — a
// tampered asset simply fails signature check and nothing runs.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::proxy::AppState;

/// The repository whose releases this updater follows.
const REPO: &str = "Rohithdgrr/OPEN-MUSIC";

#[derive(Serialize)]
pub struct LatestRelease {
    version: String,
    notes: String,
    published: String,
    /// False when the release predates the signed manifest: the notice can
    /// still be shown, but installing happens through the releases page.
    installable: bool,
}

#[derive(Serialize)]
pub struct ReleaseRow {
    tag: String,
    name: String,
    published: String,
    /// The row matching the running build — the one that cannot be reverted
    /// to, because it already is this app.
    current: bool,
}

#[derive(Serialize)]
pub struct UpdateCheck {
    current: String,
    latest: Option<LatestRelease>,
    releases: Vec<ReleaseRow>,
    page: String,
}

/// The fields this screen reads off GitHub's release objects.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
}

/// "V0.1.0" / "v1.2" / "0.1.0" → "0.1.0" — release tags carry an optional v.
pub(crate) fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).to_string()
}

/// Numeric dot-compare: is `candidate` strictly newer than `current`?
/// Missing parts count as 0, pre-release suffixes are ignored.
pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
    let part = |v: &str, i: usize| -> u64 {
        v.split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .nth(i)
            .unwrap_or("")
            .trim()
            .parse()
            .unwrap_or(0)
    };
    for i in 0..4 {
        let (a, b) = (part(candidate, i), part(current, i));
        if a != b {
            return a > b;
        }
    }
    false
}

/// Tags travel straight into a download URL, so only the boring characters
/// get through — no slashes, no dots-only names, no surprises.
fn safe_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() < 100
        && tag != "."
        && tag != ".."
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

async fn gh_get<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, String> {
    client
        .get(url)
        .header(reqwest::header::USER_AGENT, "trance-music-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<T>()
        .await
        .map_err(|e| e.to_string())
}

/// Settings / Updates: the signed manifest is authoritative when it exists;
/// plain GitHub metadata is the fallback while releases predate in-app
/// updates. The rollback list degrades to empty (offline, rate limit)
/// rather than failing the whole check.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let mut endpoint_err: Option<String> = None;
    let mut latest: Option<LatestRelease> = None;

    match app.updater().map_err(|e| e.to_string())?.check().await {
        Ok(Some(u)) => {
            let notes = u.body.clone().unwrap_or_default();
            let published = u
                .raw_json
                .get("pub_date")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            latest = Some(LatestRelease {
                version: u.version.clone(),
                notes,
                published,
                installable: true,
            });
        }
        Ok(None) => {} // manifest answered: the running build is current
        Err(e) => endpoint_err = Some(e.to_string()),
    }

    if latest.is_none() && endpoint_err.is_some() {
        // The newest release has no manifest (published before this feature
        // shipped) — say the version exists, just not installable in-app.
        let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
        if let Ok(rel) = gh_get::<GhRelease>(&state.client, &url).await {
            let v = normalize_version(&rel.tag_name);
            if is_newer(&v, &current) {
                latest = Some(LatestRelease {
                    version: v,
                    notes: rel.body.unwrap_or_default(),
                    published: rel.published_at.unwrap_or_default(),
                    installable: false,
                });
            }
        } else if let Some(e) = endpoint_err {
            return Err(e); // both sources down (offline / rate-limited)
        }
    }

    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=15");
    let mut releases = Vec::new();
    if let Ok(rows) = gh_get::<Vec<GhRelease>>(&state.client, &url).await {
        for r in rows
            .into_iter()
            .filter(|r| !r.draft && !r.prerelease)
            .take(8)
        {
            let v = normalize_version(&r.tag_name);
            releases.push(ReleaseRow {
                current: v == current,
                tag: r.tag_name,
                name: r.name.unwrap_or_default(),
                published: r.published_at.unwrap_or_default(),
            });
        }
    }

    Ok(UpdateCheck {
        current,
        latest,
        releases,
        page: format!("https://github.com/{REPO}/releases"),
    })
}

/// Install button: re-checks the manifest (fresh signature, fresh URL) and
/// hands the package to the platform installer. On Windows the app exits
/// into the passive installer, which relaunches the new build.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    install_now(&app, update).await
}

/// Revert button: install any *other* published build by tag. The endpoint
/// is the tag's own signed `update.json`, so stepping back is verified the
/// same way a forward update is. `!=` accepts older and newer builds alike;
/// the running version is rejected as a no-op.
#[tauri::command]
pub async fn update_rollback(app: AppHandle, tag: String) -> Result<(), String> {
    if !safe_tag(&tag) {
        return Err("unsupported release tag".to_string());
    }
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/update.json");
    let endpoint = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .version_comparator(|current, remote| remote.version != current)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("release {tag} is already running or has no update package"))?;
    install_now(&app, update).await
}

/// Shared download + install, streaming progress to the Settings panel as
/// `update:progress`. The verify phase is the signature check — a failure
/// there aborts before anything is executed.
async fn install_now(app: &AppHandle, update: Update) -> Result<(), String> {
    let mut got = 0usize;
    let sink = app.clone();
    let finish = app.clone();
    update
        .download_and_install(
            move |delta, total| {
                got += delta;
                let _ = sink.emit(
                    "update:progress",
                    serde_json::json!({ "phase": "download", "received": got, "total": total }),
                );
            },
            move || {
                let _ = finish.emit("update:progress", serde_json::json!({ "phase": "verify" }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("update:progress", serde_json::json!({ "phase": "done" }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_the_tag_prefix() {
        assert_eq!(normalize_version("V0.1.0"), "0.1.0");
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("0.1.0"), "0.1.0");
        assert_eq!(normalize_version("  V0.1.0 "), "0.1.0");
    }

    #[test]
    fn newer_compares_numeric_parts_not_strings() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.10.0", "0.9.0")); // "0.10" < "0.9" as text
        assert!(is_newer("0.1.1", "0.1"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn newer_rejects_equal_and_older() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("1.0.0-rc1", "1.0.0")); // pre-release suffix ignored
        assert!(!is_newer("", "0.1.0"));
    }

    #[test]
    fn tag_guard_accepts_release_tags_only() {
        assert!(safe_tag("V0.1.0"));
        assert!(safe_tag("v0.2.0-beta.1"));
        assert!(!safe_tag(""));
        assert!(!safe_tag("."));
        assert!(!safe_tag(".."));
        assert!(!safe_tag("a/b"));
        assert!(!safe_tag("a b"));
        assert!(!safe_tag(&"x".repeat(100)));
    }
}
