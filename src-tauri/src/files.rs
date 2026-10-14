//! SFTP browsing and file transfers (SFTP or rsync over a Kermius SSH bridge).
use crate::model::Host;
use crate::ssh::{self, Client};
use crate::store::Store;
use parking_lot::Mutex;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Seconds since epoch.
    pub mtime: u64,
}

fn sort(mut v: Vec<Entry>) -> Vec<Entry> {
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    v
}

pub struct Remote {
    _handle: Handle<Client>,
    sftp: SftpSession,
    host: Host,
}

#[derive(Default)]
pub struct Files {
    remotes: Mutex<HashMap<String, Arc<Remote>>>,
    transfers: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

impl Files {
    fn get(&self, id: &str) -> Result<Arc<Remote>, String> {
        self.remotes.lock().get(id).cloned().ok_or_else(|| "SFTP session closed".into())
    }

    pub async fn open(&self, store: Arc<Store>, host: Host) -> Result<String, String> {
        let handle = ssh::connect(store, &host, ssh::no_log()).await?;
        let mut ch = handle.channel_open_session().await.map_err(e)?;
        ch.request_subsystem(true, "sftp").await.map_err(e)?;
        loop {
            match ch.wait().await {
                Some(russh::ChannelMsg::Success) => break,
                Some(russh::ChannelMsg::Failure) | None => return Err("SFTP is not enabled on this server".into()),
                _ => {}
            }
        }
        let sftp = SftpSession::new(ch.into_stream()).await.map_err(|err| format!("SFTP: {err}"))?;
        let id = uuid::Uuid::new_v4().to_string();
        self.remotes.lock().insert(id.clone(), Arc::new(Remote { _handle: handle, sftp, host }));
        Ok(id)
    }

    pub fn close(&self, id: &str) {
        self.remotes.lock().remove(id);
    }

    pub async fn home(&self, id: &str) -> Result<String, String> {
        self.get(id)?.sftp.canonicalize(".").await.map_err(e)
    }

    pub async fn list(&self, id: &str, path: &str) -> Result<Vec<Entry>, String> {
        let r = self.get(id)?;
        let dir = r.sftp.read_dir(path).await.map_err(e)?;
        let mut out = Vec::new();
        for d in dir {
            let name = d.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let m = d.metadata();
            let mut is_dir = m.is_dir();
            let is_link = m.is_symlink();
            let full = join(path, &name);
            if is_link {
                // Follow links so linked directories can be opened.
                if let Ok(t) = r.sftp.metadata(full.clone()).await {
                    is_dir = t.is_dir();
                }
            }
            out.push(Entry { name, path: full, is_dir, is_link, size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as u64 });
        }
        Ok(sort(out))
    }

    pub async fn mkdir(&self, id: &str, path: &str) -> Result<(), String> {
        self.get(id)?.sftp.create_dir(path).await.map_err(e)
    }

    pub async fn rename(&self, id: &str, from: &str, to: &str) -> Result<(), String> {
        self.get(id)?.sftp.rename(from, to).await.map_err(e)
    }

    pub async fn remove(&self, id: &str, path: &str) -> Result<(), String> {
        let r = self.get(id)?;
        remove_remote(&r.sftp, path.to_string()).await
    }
}

/// Recursive delete (does not follow symlinks).
fn remove_remote(sftp: &SftpSession, path: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(path.clone()).await.map_err(e)?;
        if meta.is_dir() {
            for d in sftp.read_dir(path.clone()).await.map_err(e)? {
                let name = d.file_name();
                if name != "." && name != ".." {
                    remove_remote(sftp, join(&path, &name)).await?;
                }
            }
            sftp.remove_dir(path).await.map_err(e)
        } else {
            sftp.remove_file(path).await.map_err(e)
        }
    })
}

// ---------- local filesystem ----------

pub fn local_home() -> String {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).to_string_lossy().into_owned()
}

pub fn local_list(path: &str) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for d in std::fs::read_dir(path).map_err(e)? {
        let d = d.map_err(e)?;
        let p = d.path();
        let link = d.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let meta = std::fs::metadata(&p).or_else(|_| d.metadata());
        let (is_dir, size, mtime) = match meta {
            Ok(m) => (
                m.is_dir(),
                m.len(),
                m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
            ),
            Err(_) => (false, 0, 0),
        };
        out.push(Entry { name: d.file_name().to_string_lossy().into_owned(), path: p.to_string_lossy().into_owned(), is_dir, is_link: link, size, mtime });
    }
    Ok(sort(out))
}

pub fn local_mkdir(path: &str) -> Result<(), String> {
    std::fs::create_dir(path).map_err(e)
}

pub fn local_rename(from: &str, to: &str) -> Result<(), String> {
    std::fs::rename(from, to).map_err(e)
}

pub fn local_remove(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_dir() && !p.is_symlink() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(e)
}

// ---------- transfers ----------

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Sftp,
    Rsync,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Progress { done: u64, total: u64, file: String },
    Done,
    Error { message: String },
}

pub fn rsync_available() -> bool {
    !cfg!(windows) && std::process::Command::new("rsync").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

impl Files {
    #[allow(clippy::too_many_arguments)]
    pub fn transfer(
        self: &Arc<Self>,
        id: &str,
        dir: Direction,
        mode: Mode,
        sources: Vec<String>,
        dest: String,
        events: Channel<Event>,
    ) -> Result<String, String> {
        let r = self.get(id)?;
        let tid = uuid::Uuid::new_v4().to_string();
        let (me, key) = (self.clone(), tid.clone());
        let task = tauri::async_runtime::spawn(async move {
            let result = match mode {
                Mode::Sftp => sftp_copy(&r.sftp, dir, &sources, &dest, &events).await,
                Mode::Rsync => rsync_copy(&r.host, dir, &sources, &dest, &events).await,
            };
            let _ = events.send(match result {
                Ok(()) => Event::Done,
                Err(message) => Event::Error { message },
            });
            me.transfers.lock().remove(&key);
        });
        self.transfers.lock().insert(tid.clone(), task);
        Ok(tid)
    }

    pub fn cancel(&self, tid: &str) {
        if let Some(t) = self.transfers.lock().remove(tid) {
            t.abort();
        }
    }
}

/// (source, destination, size) for every file; directories are created up front.
async fn plan_upload(sftp: &SftpSession, sources: &[String], dest: &str) -> Result<Vec<(String, String, u64)>, String> {
    let mut files = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = sources.iter().map(|s| {
        let p = PathBuf::from(s);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        (p, join(dest, &name))
    }).collect();
    while let Some((local, remote)) = stack.pop() {
        let meta = std::fs::metadata(&local).map_err(e)?;
        if meta.is_dir() {
            if !sftp.try_exists(remote.clone()).await.unwrap_or(false) {
                sftp.create_dir(remote.clone()).await.map_err(e)?;
            }
            for d in std::fs::read_dir(&local).map_err(e)? {
                let d = d.map_err(e)?;
                stack.push((d.path(), join(&remote, &d.file_name().to_string_lossy())));
            }
        } else {
            files.push((local.to_string_lossy().into_owned(), remote, meta.len()));
        }
    }
    Ok(files)
}

fn plan_download<'a>(
    sftp: &'a SftpSession,
    remote: String,
    local: PathBuf,
    out: &'a mut Vec<(String, String, u64)>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.metadata(remote.clone()).await.map_err(e)?;
        if meta.is_dir() {
            std::fs::create_dir_all(&local).map_err(e)?;
            for d in sftp.read_dir(remote.clone()).await.map_err(e)? {
                let name = d.file_name();
                if name != "." && name != ".." {
                    plan_download(sftp, join(&remote, &name), local.join(&name), out).await?;
                }
            }
        } else {
            out.push((remote, local.to_string_lossy().into_owned(), meta.size.unwrap_or(0)));
        }
        Ok(())
    })
}

async fn sftp_copy(sftp: &SftpSession, dir: Direction, sources: &[String], dest: &str, events: &Channel<Event>) -> Result<(), String> {
    let files = match dir {
        Direction::Upload => plan_upload(sftp, sources, dest).await?,
        Direction::Download => {
            let mut out = Vec::new();
            for s in sources {
                let name = s.trim_end_matches('/').rsplit('/').next().unwrap_or("file").to_string();
                plan_download(sftp, s.clone(), Path::new(dest).join(name), &mut out).await?;
            }
            out
        }
    };
    let total: u64 = files.iter().map(|f| f.2).sum();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    for (src, dst, _) in &files {
        let name = src.rsplit(['/', '\\']).next().unwrap_or(src).to_string();
        let _ = events.send(Event::Progress { done, total, file: name.clone() });
        match dir {
            Direction::Upload => {
                let mut input = tokio::fs::File::open(src).await.map_err(e)?;
                let mut output = sftp.create(dst.clone()).await.map_err(e)?;
                loop {
                    let n = input.read(&mut buf).await.map_err(e)?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buf[..n]).await.map_err(e)?;
                    done += n as u64;
                    if last.elapsed().as_millis() > 150 {
                        last = std::time::Instant::now();
                        let _ = events.send(Event::Progress { done, total, file: name.clone() });
                    }
                }
                output.shutdown().await.map_err(e)?;
            }
            Direction::Download => {
                let mut input = sftp.open(src.clone()).await.map_err(e)?;
                let mut output = tokio::fs::File::create(dst).await.map_err(e)?;
                loop {
                    let n = input.read(&mut buf).await.map_err(e)?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buf[..n]).await.map_err(e)?;
                    done += n as u64;
                    if last.elapsed().as_millis() > 150 {
                        last = std::time::Instant::now();
                        let _ = events.send(Event::Progress { done, total, file: name.clone() });
                    }
                }
                output.flush().await.map_err(e)?;
            }
        }
    }
    let _ = events.send(Event::Progress { done: total, total, file: String::new() });
    Ok(())
}

/// rsync with `-e "<kermius> --ssh-bridge <host id>"`, so it reuses the vault's credentials.
async fn rsync_copy(host: &Host, dir: Direction, sources: &[String], dest: &str, events: &Channel<Event>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(e)?;
    let shell = format!("'{}' --ssh-bridge {}", exe.to_string_lossy().replace('\'', r"'\''"), host.id);
    let mut cmd = tokio::process::Command::new("rsync");
    cmd.args(["-a", "-s", "--partial", "--info=progress2", "--no-inc-recursive", "-e", &shell]);
    match dir {
        Direction::Upload => {
            cmd.args(sources);
            cmd.arg(format!("kermius:{}/", dest.trim_end_matches('/')));
        }
        Direction::Download => {
            for s in sources {
                cmd.arg(format!("kermius:{}", s.trim_end_matches('/')));
            }
            cmd.arg(format!("{}/", dest.trim_end_matches('/')));
        }
    }
    // C locale: progress numbers use "," separators regardless of the user's locale.
    cmd.env("LC_ALL", "C").stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|err| format!("rsync: {err}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    // progress2 lines: "  12,345,678  42%   10.5MB/s    0:00:03 ..." separated by \r
    let mut pending = String::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stdout.read(&mut chunk).await.map_err(e)?;
        if n == 0 {
            break;
        }
        pending.push_str(&String::from_utf8_lossy(&chunk[..n]));
        while let Some(i) = pending.find(['\r', '\n']) {
            let line: String = pending.drain(..=i).collect();
            let mut parts = line.split_whitespace();
            if let (Some(bytes), Some(pct)) = (parts.next(), parts.next()) {
                if let (Ok(b), Some(p)) = (bytes.replace(',', "").parse::<u64>(), pct.strip_suffix('%').and_then(|p| p.parse::<u64>().ok())) {
                    let total = if p > 0 { b * 100 / p } else { 0 };
                    let _ = events.send(Event::Progress { done: b, total: total.max(b), file: String::new() });
                }
            }
        }
    }
    let status = child.wait().await.map_err(e)?;
    let errors = err_task.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(errors.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("rsync failed").to_string())
    }
}

/// `kermius --ssh-bridge <host id> <ignored host> <command...>`: act as rsync's remote shell.
pub async fn ssh_bridge(store: Arc<Store>, host: Host, command: String) -> Result<u32, String> {
    use russh::ChannelMsg;
    let handle = ssh::connect(store, &host, ssh::no_log()).await?;
    let ch = handle.channel_open_session().await.map_err(e)?;
    ch.exec(true, command).await.map_err(e)?;
    let (mut read, write) = ch.split();
    let input = tokio::spawn(async move {
        let _ = write.data(tokio::io::stdin()).await;
        let _ = write.eof().await;
    });
    let mut out = tokio::io::stdout();
    let mut err = tokio::io::stderr();
    let mut code = 0;
    while let Some(msg) = read.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                out.write_all(&data).await.map_err(e)?;
                out.flush().await.map_err(e)?;
            }
            ChannelMsg::ExtendedData { data, .. } => {
                let _ = err.write_all(&data).await;
            }
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            ChannelMsg::Eof | ChannelMsg::Close => {}
            _ => {}
        }
    }
    input.abort();
    Ok(code)
}

/// Against a real sshd: `KERMIUS_TEST_SSH="port|user|/path/to/private_key" cargo test files_e2e`
#[cfg(test)]
mod e2e {
    use super::*;

    #[tokio::test]
    async fn files_e2e() {
        let Ok(cfg) = std::env::var("KERMIUS_TEST_SSH") else { return };
        let [port, user, key] = cfg.split('|').collect::<Vec<_>>()[..] else { panic!("bad KERMIUS_TEST_SSH") };
        let tmp = std::env::temp_dir().join(format!("kermius-files-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let host = Host {
            address: "127.0.0.1".into(),
            port: port.parse().unwrap(),
            username: user.into(),
            private_key: std::fs::read_to_string(key).unwrap(),
            ..Default::default()
        };
        let files = Arc::new(Files::default());
        let id = files.open(store, host).await.unwrap();
        assert!(files.home(&id).await.unwrap().starts_with('/'));

        // Local tree: src/a.txt, src/sub/b.bin
        let src = tmp.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        let big: Vec<u8> = (0..1_000_000u32).map(|i| (i % 253) as u8).collect();
        std::fs::write(src.join("sub/b.bin"), &big).unwrap();
        let remote = tmp.join("remote"); // sshd is local, so this path is also the "remote" side
        files.mkdir(&id, remote.to_str().unwrap()).await.unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let ch: Channel<Event> = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(j) = body {
                let _ = tx.send(j);
            }
            Ok(())
        });
        let wait = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>| {
            let mut last = String::new();
            while let Ok(m) = rx.try_recv() {
                last = m;
            }
            last
        };
        files.transfer(&id, Direction::Upload, Mode::Sftp, vec![src.to_string_lossy().into()], remote.to_string_lossy().into(), ch.clone()).unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        assert!(wait(&mut rx).contains("done"));
        assert_eq!(std::fs::read(remote.join("src/sub/b.bin")).unwrap(), big);

        let listed = files.list(&id, &remote.join("src").to_string_lossy()).await.unwrap();
        assert_eq!(listed.iter().map(|e| (e.name.as_str(), e.is_dir)).collect::<Vec<_>>(), [("sub", true), ("a.txt", false)]);

        let back = tmp.join("back");
        std::fs::create_dir_all(&back).unwrap();
        files.transfer(&id, Direction::Download, Mode::Sftp, vec![remote.join("src").to_string_lossy().into()], back.to_string_lossy().into(), ch).unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        assert!(wait(&mut rx).contains("done"));
        assert_eq!(std::fs::read(back.join("src/a.txt")).unwrap(), b"hello");

        files.rename(&id, &remote.join("src/a.txt").to_string_lossy(), &remote.join("src/c.txt").to_string_lossy()).await.unwrap();
        files.remove(&id, &remote.join("src").to_string_lossy()).await.unwrap();
        assert!(!remote.join("src").exists());
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
