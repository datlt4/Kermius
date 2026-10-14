//! Change watchers for Folder Sync jobs with `watch` on: inotify/FSEvents locally,
//! `inotifywait` over SSH remotely (falling back to a 1-minute poll), each triggering a debounced run.
use crate::foldersync::{self, sh, Endpoint, Event, Job, Side};
use crate::{emit_fsync, run_job, AppState};
use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const DEBOUNCE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Watchers {
    tasks: Mutex<HashMap<String, Vec<JoinHandle<()>>>>,
    states: Arc<Mutex<HashMap<String, (String, String)>>>,
}

impl Watchers {
    pub fn states(&self) -> HashMap<String, (String, String)> {
        self.states.lock().clone()
    }

    /// Stop all watchers and start one set per job that has `watch` on.
    pub fn restart(&self, app: &AppHandle) {
        for (_, tasks) in self.tasks.lock().drain() {
            tasks.iter().for_each(|t| t.abort());
        }
        self.states.lock().clear();
        let jobs: Vec<Job> = app.state::<AppState>().store.state.lock().folder_syncs.iter().filter(|j| j.watch && !j.paused).cloned().collect();
        let mut tasks = self.tasks.lock();
        for job in jobs {
            tasks.insert(job.id.clone(), start(app.clone(), job, self.states.clone()));
        }
    }
}

type States = Arc<Mutex<HashMap<String, (String, String)>>>;

/// Watcher state per job side (`"<id>:a"` / `"<id>:b"`).
fn report(app: &AppHandle, states: &States, id: &str, side: &str, state: &str, message: impl Into<String>) {
    let message = message.into();
    states.lock().insert(format!("{id}:{side}"), (state.to_string(), message.clone()));
    emit_fsync(app, id, Event::Watch { side: side.into(), state: state.into(), message });
}

fn start(app: AppHandle, job: Job, states: States) -> Vec<JoinHandle<()>> {
    let (tx, mut rx) = unbounded_channel::<()>();
    let mut tasks = Vec::new();
    for (side, ep) in [("a", job.a.clone()), ("b", job.b.clone())] {
        let (app, tx, states, id) = (app.clone(), tx.clone(), states.clone(), job.id.clone());
        let w = Who { app, id, side, states };
        tasks.push(tauri::async_runtime::spawn(async move {
            if ep.kind == "remote" { watch_remote(w, ep, tx).await } else { watch_local(w, ep.path, tx).await }
        }));
    }
    // Runner: catch up once, then sync after each burst of changes.
    let id = job.id.clone();
    let _ = tx.send(());
    tasks.push(tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            tokio::time::sleep(DEBOUNCE).await;
            while rx.try_recv().is_ok() {}
            while let Err(err) = run_job(app.clone(), id.clone(), false).await {
                if err != "Already running" {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            // Ignore events caused by our own writes.
            tokio::time::sleep(Duration::from_secs(2)).await;
            while rx.try_recv().is_ok() {}
        }
    }));
    tasks
}

/// Which job side a watcher reports for.
struct Who {
    app: AppHandle,
    id: String,
    side: &'static str,
    states: States,
}

impl Who {
    fn report(&self, state: &str, message: impl Into<String>) {
        report(&self.app, &self.states, &self.id, self.side, state, message);
    }
}

fn ignored(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str() == ".rsync-partial")
}

async fn watch_local(w: Who, path: String, tx: UnboundedSender<()>) {
    let mut was_offline = false;
    loop {
        if !Path::new(&path).is_dir() {
            w.report("offline", format!("{path} not found (disk not mounted?)"));
            was_offline = true;
            tokio::time::sleep(Duration::from_secs(15)).await;
            continue;
        }
        if was_offline {
            // Disk came back: sync what changed meanwhile.
            let _ = tx.send(());
            was_offline = false;
        }
        let (ntx, mut nrx) = unbounded_channel::<()>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if !ev.kind.is_access() && !ev.paths.iter().all(|p| ignored(p)) {
                    let _ = ntx.send(());
                }
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(err) => {
                w.report("offline", format!("watch failed: {err}"));
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
        };
        if let Err(err) = watcher.watch(Path::new(&path), RecursiveMode::Recursive) {
            // Out of inotify watches (huge trees): poll this side until the limit is raised.
            if matches!(err.kind, notify::ErrorKind::MaxFilesWatch) || err.to_string().contains("No space left") {
                w.report("limit", "inotify watch limit reached on this computer");
            } else {
                w.report("polling", format!("{path}: {err}; checking every minute"));
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
            let _ = tx.send(());
            continue;
        }
        w.report("watching", "");
        loop {
            tokio::select! {
                Some(()) = nrx.recv() => { let _ = tx.send(()); }
                _ = tokio::time::sleep(Duration::from_secs(15)) => {
                    if !Path::new(&path).is_dir() { break; }
                }
            }
        }
    }
}

async fn watch_remote(w: Who, ep: Endpoint, tx: UnboundedSender<()>) {
    let store = w.app.state::<AppState>().store.clone();
    let quiet: foldersync::Emit = Arc::new(|_| {});
    let mut backoff = 10;
    loop {
        let vault = store.state.lock().vault.clone();
        let (handle, host, path) = match foldersync::open_side(&store, &vault, &ep, &quiet).await {
            Ok(Side::Remote { handle, host, path }) => (handle, host, path),
            Ok(Side::Local(_)) => return,
            Err(err) => {
                w.report("offline", err.trim_start_matches(foldersync::OFFLINE).to_string());
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(120);
                continue;
            }
        };
        backoff = 10;
        // Reconnected: there may be changes we missed.
        let _ = tx.send(());
        let cmd = format!(
            "command -v inotifywait >/dev/null 2>&1 || exit 127; exec inotifywait -m -r -q -e close_write,create,delete,move,attrib --exclude '/\\.rsync-partial(/|$)' --format x {}",
            sh(&path)
        );
        let mut ch = match handle.channel_open_session().await {
            Ok(ch) => ch,
            Err(_) => continue,
        };
        if ch.exec(true, cmd).await.is_err() {
            continue;
        }
        w.report("watching", format!("via {}", host.name));
        let (mut missing_tool, mut stderr) = (false, Vec::new());
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { .. } => {
                    let _ = tx.send(());
                }
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: 127 } => missing_tool = true,
                _ => {}
            }
        }
        let limit = String::from_utf8_lossy(&stderr).contains("upper limit");
        if missing_tool || limit {
            if limit {
                // The message carries the host id so the UI can offer to raise the limit there.
                w.report("limit", format!("inotify watch limit reached on {}|{}", host.name, host.id));
            } else {
                w.report("polling", format!("via {}; install inotify-tools on the remote for instant sync", host.name));
            }
            let mut ready = false;
            while !handle.is_closed() {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let _ = tx.send(());
                // inotify-tools may have been installed (or the limit raised) meanwhile: switch back to instant watching.
                if missing_tool && foldersync::exec(&handle, "command -v inotifywait").await.is_ok_and(|(_, _, code)| code == 0) {
                    ready = true;
                    break;
                }
            }
            if ready {
                continue;
            }
        }
        w.report("offline", format!("lost connection to {}", host.name));
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
