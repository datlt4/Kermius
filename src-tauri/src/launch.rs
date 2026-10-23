//! Integration API for other apps (desktop only), see README "Integration API":
//! `kermius --new-terminal [--cwd DIR]`, `kermius --share PATH...`.
//! A running Kermius gets them through the single-instance plugin; at start-up they wait until the UI asks.
use parking_lot::Mutex;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launch {
    /// A new local terminal; `cwd` "" = home.
    Terminal { cwd: String },
    /// Files and folders put into the Nearby Share selection (the user picks the device).
    Share { files: Vec<String>, dirs: Vec<String> },
}

#[derive(Default)]
pub struct Pending {
    items: Mutex<Vec<Launch>>,
    ready: AtomicBool,
}

fn absolute(p: &str, cwd: &Path) -> String {
    let p = Path::new(p);
    (if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }).to_string_lossy().into_owned()
}

/// Requests in a command line (program name first); relative paths resolve against `cwd`.
pub fn from_args(args: &[String], cwd: &Path) -> Vec<Launch> {
    let mut out = Vec::new();
    let rest = args.get(1..).unwrap_or_default();
    if let Some(i) = rest.iter().position(|a| a == "--share") {
        let (mut files, mut dirs) = (Vec::new(), Vec::new());
        for p in rest[i + 1..].iter().map(|p| absolute(p, cwd)) {
            if Path::new(&p).is_dir() {
                dirs.push(p);
            } else if Path::new(&p).exists() {
                files.push(p);
            }
        }
        if !files.is_empty() || !dirs.is_empty() {
            out.push(Launch::Share { files, dirs });
        }
        return out;
    }
    if rest.iter().any(|a| a == "--new-terminal") {
        let dir = rest.iter().position(|a| a == "--cwd").and_then(|i| rest.get(i + 1)).map(|d| absolute(d, cwd)).unwrap_or_default();
        out.push(Launch::Terminal { cwd: dir });
    }
    out
}

/// Deliver requests to the UI (or keep them until it is ready); `focus` raises the window.
pub fn handle(app: &AppHandle, items: Vec<Launch>, focus: bool) {
    if focus {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let Some(p) = app.try_state::<Pending>() else { return };
    if p.ready.load(Ordering::Acquire) {
        for l in items {
            let _ = app.emit("kermius-launch", l);
        }
    } else {
        p.items.lock().extend(items);
    }
}

/// The UI is listening: hand over what arrived before it was.
pub fn ready(app: &AppHandle) -> Vec<Launch> {
    let Some(p) = app.try_state::<Pending>() else { return Vec::new() };
    let mut items = p.items.lock();
    p.ready.store(true, Ordering::Release);
    std::mem::take(&mut *items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        std::iter::once("kermius").chain(a.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn parses_terminal_requests() {
        let cwd = Path::new("/home/u");
        assert_eq!(from_args(&args(&["--new-terminal"]), cwd), vec![Launch::Terminal { cwd: String::new() }]);
        assert_eq!(from_args(&args(&["--new-terminal", "--cwd", "src"]), cwd), vec![Launch::Terminal { cwd: "/home/u/src".into() }]);
        assert_eq!(from_args(&args(&[]), cwd), vec![]);
    }

    #[test]
    fn parses_share_requests() {
        let dir = std::env::temp_dir().join(format!("kermius-launch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let got = from_args(&args(&["--share", "a.txt", "folder", "missing"]), &dir);
        let s = |p: &str| dir.join(p).to_string_lossy().into_owned();
        assert_eq!(got, vec![Launch::Share { files: vec![s("a.txt")], dirs: vec![s("folder")] }]);
        assert_eq!(from_args(&args(&["--share", "missing"]), &dir), vec![]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
