//! Update check: desktop installs signed releases with the Tauri updater (then restarts);
//! phones get the newest GitHub release to open (Android APK) or just to show (iOS).
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    /// What "update" does here: "install" (desktop), "download" (Android APK) or "none" (iOS).
    pub action: String,
    /// Android: the APK to download.
    pub url: String,
}

const RELEASES: &str = "https://github.com/datlt4/Kermius/releases";

#[cfg(desktop)]
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body.unwrap_or_default(), action: "install".into(), url: RELEASES.into() }))
}

/// Download, verify and install the update, reporting (bytes so far, total), then restart.
#[cfg(desktop)]
pub async fn install(app: &AppHandle, progress: Channel<(u64, u64)>) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?.ok_or("Already up to date")?;
    let mut done = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = progress.send((done, total.unwrap_or(0)));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Phones: compare with the newest GitHub release.
#[cfg(mobile)]
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    let body = reqwest::Client::new()
        .get("https://api.github.com/repos/datlt4/Kermius/releases/latest")
        .header("User-Agent", "Kermius")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let rel: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let tag = rel["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    if tag.is_empty() || !newer(&tag, &current) {
        return Ok(None);
    }
    let apk = rel["assets"].as_array().into_iter().flatten().find_map(|a| {
        let name = a["name"].as_str()?;
        (name.starts_with("kermius_android") && name.ends_with(".apk")).then(|| a["browser_download_url"].as_str().unwrap_or("").to_string())
    });
    let android = cfg!(target_os = "android");
    Ok(Some(UpdateInfo {
        version: tag,
        notes: rel["body"].as_str().unwrap_or("").to_string(),
        action: if android && apk.is_some() { "download".into() } else { "none".into() },
        url: apk.unwrap_or_else(|| RELEASES.into()),
    }))
}

#[cfg(mobile)]
pub async fn install(_: &AppHandle, _: Channel<(u64, u64)>) -> Result<(), String> {
    Err("Updates are installed from the release page on phones".into())
}

/// `a` is a newer x.y.z version than `b`.
#[cfg_attr(desktop, allow(dead_code))]
fn newer(a: &str, b: &str) -> bool {
    let v = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    v(a) > v(b)
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_order() {
        assert!(super::newer("1.27.1", "1.27.0"));
        assert!(super::newer("1.30.0", "1.4.5"));
        assert!(!super::newer("1.27.0", "1.27.0"));
        assert!(!super::newer("1.9.9", "1.10.0"));
    }
}
