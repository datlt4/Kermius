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

/// A run waits until the folder has been quiet this long (AI tools and builds write constantly)...
const SETTLE: Duration = Duration::from_secs(45);
/// ...but never longer than this, so a constantly changing folder still syncs.
const MAX_WAIT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct Watchers {
    /// Per job: what its watchers were started for, and their tasks.
    tasks: Mutex<HashMap<String, (Watched, Vec<JoinHandle<()>>)>>,
    states: Arc<Mutex<HashMap<String, (String, String)>>>,
}

/// The job settings a watcher depends on; other edits (name, schedule, results) keep it running.
type Watched = (String, Endpoint, Endpoint);

impl Watchers {
    pub fn states(&self) -> HashMap<String, (String, String)> {
        self.states.lock().clone()
    }

    /// Bring watchers in line with the jobs: start new or changed ones, stop removed or paused ones.
    /// Unchanged jobs keep their watchers (restarting would trigger a catch-up sync).
    pub fn restart(&self, app: &AppHandle) {
        let jobs: Vec<Job> = app.state::<AppState>().store.state.lock().folder_syncs.iter().filter(|j| j.watch && !j.paused).cloned().collect();
        let mut tasks = self.tasks.lock();
        let wanted: HashMap<&String, Watched> = jobs.iter().map(|j| (&j.id, (j.mode.clone(), j.a.clone(), j.b.clone()))).collect();
        tasks.retain(|id, (watched, handles)| {
            let keep = wanted.get(id) == Some(watched);
            if !keep {
                handles.iter().for_each(|t| t.abort());
                self.states.lock().retain(|k, _| !k.starts_with(&format!("{id}:")));
            }
            keep
        });
        for job in jobs {
            if !tasks.contains_key(&job.id) {
                let watched = (job.mode.clone(), job.a.clone(), job.b.clone());
                tasks.insert(job.id.clone(), (watched, start(app.clone(), job, self.states.clone())));
            }
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

/// What a watcher saw: one changed path (relative to the job folder) or "anything may have changed".
enum Change {
    Path(String),
    Full,
}

fn start(app: AppHandle, job: Job, states: States) -> Vec<JoinHandle<()>> {
    let (tx, mut rx) = unbounded_channel::<Change>();
    let mut tasks = Vec::new();
    // A mirror's destination is written only by Kermius: watching it would just walk the whole tree again.
    let sides: Vec<(&'static str, Endpoint)> =
        if job.mode == "mirror" { vec![("a", job.a.clone())] } else { vec![("a", job.a.clone()), ("b", job.b.clone())] };
    for (side, ep) in sides {
        let (app, tx, states, id) = (app.clone(), tx.clone(), states.clone(), job.id.clone());
        let w = Who { app, id, side, states };
        tasks.push(tauri::async_runtime::spawn(async move {
            if ep.kind == "remote" { watch_remote(w, ep, tx).await } else { watch_local(w, ep.path, tx).await }
        }));
    }
    // Runner: a full catch-up when the watcher starts (app start, resume: the other side may have changed
    // meanwhile), then after each burst of changes sync only the changed paths.
    let id = job.id.clone();
    let _ = tx.send(Change::Full);
    tasks.push(tauri::async_runtime::spawn(async move {
        while let Some(first) = rx.recv().await {
            let started = std::time::Instant::now();
            let mut batch = vec![first];
            while started.elapsed() < MAX_WAIT {
                match tokio::time::timeout(SETTLE, rx.recv()).await {
                    Ok(Some(c)) => batch.push(c),
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            let mut paths: Option<Vec<String>> = Some(Vec::new());
            for c in batch {
                match (c, paths.as_mut()) {
                    (Change::Path(p), Some(v)) => v.push(p),
                    (Change::Full, _) => paths = None,
                    _ => {}
                }
            }
            while let Err(err) = run_job(app.clone(), id.clone(), false, paths.clone()).await {
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

async fn watch_local(w: Who, path: String, tx: UnboundedSender<Change>) {
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
            let _ = tx.send(Change::Full);
            was_offline = false;
        }
        let (ntx, mut nrx) = unbounded_channel::<Change>();
        let root = std::path::PathBuf::from(&path);
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else {
                // Lost events (queue overflow): only a full run can tell what changed.
                let _ = ntx.send(Change::Full);
                return;
            };
            if ev.kind.is_access() || ev.need_rescan() {
                if ev.need_rescan() {
                    let _ = ntx.send(Change::Full);
                }
                return;
            }
            for p in ev.paths.iter().filter(|p| !ignored(p)) {
                let _ = ntx.send(match p.strip_prefix(&root) {
                    Ok(rel) => Change::Path(rel.to_string_lossy().replace('\\', "/")),
                    Err(_) => Change::Full,
                });
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
            let _ = tx.send(Change::Full);
            continue;
        }
        w.report("watching", "");
        loop {
            tokio::select! {
                Some(c) = nrx.recv() => { let _ = tx.send(c); }
                _ = tokio::time::sleep(Duration::from_secs(15)) => {
                    if !Path::new(&path).is_dir() { break; }
                }
            }
        }
    }
}

async fn watch_remote(w: Who, ep: Endpoint, tx: UnboundedSender<Change>) {
    let store = w.app.state::<AppState>().store.clone();
    let quiet: foldersync::Emit = Arc::new(|_| {});
    let mut backoff = 10;
    let mut first = true;
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
        // Reconnected (not the first connection, the runner already starts with a full run): changes may be missed.
        if !std::mem::take(&mut first) {
            let _ = tx.send(Change::Full);
        }
        // One changed path per line.
        let cmd = format!(
            "command -v inotifywait >/dev/null 2>&1 || exit 127; exec inotifywait -m -r -q -e close_write,create,delete,move,attrib --exclude '/\\.rsync-partial(/|$)' --format '%w%f' {}",
            sh(&path)
        );
        let root = format!("{}/", path.trim_end_matches('/'));
        let mut pending = Vec::<u8>::new();
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
                ChannelMsg::Data { data } => {
                    pending.extend_from_slice(&data);
                    while let Some(i) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=i).collect();
                        let p = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                        let _ = tx.send(match p.strip_prefix(&root) {
                            Some(rel) => Change::Path(rel.to_string()),
                            None => Change::Full,
                        });
                    }
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
                let _ = tx.send(Change::Full);
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
