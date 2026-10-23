//! Integration API for other apps (desktop only), see README "Integration API":
//! `kermius --new-terminal [--cwd DIR]`, `kermius --share PATH...`, `kermius://terminal?cwd=DIR`.
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
    if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }.to_string_lossy().into_owned()
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
    out.extend(rest.iter().filter_map(|a| from_url(a)));
    out
}

/// `kermius://terminal?cwd=/some/dir`. Links can come from web pages, so they may only pick a folder.
pub fn from_url(url: &str) -> Option<Launch> {
    let rest = url.strip_prefix("kermius://")?;
    let (what, query) = rest.split_once('?').unwrap_or((rest, ""));
    if what.trim_end_matches('/') != "terminal" {
        return None;
    }
    let cwd = query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == "cwd").map(|(_, v)| decode(v)).unwrap_or_default();
    Some(Launch::Terminal { cwd })
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                None => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        assert_eq!(from_url("kermius://terminal?cwd=%2Ftmp%2Fa%20b"), Some(Launch::Terminal { cwd: "/tmp/a b".into() }));
        assert_eq!(from_url("kermius://terminal/"), Some(Launch::Terminal { cwd: String::new() }));
        assert_eq!(from_url("kermius://share?path=/etc/passwd"), None);
        assert_eq!(from_url("https://x"), None);
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
