use crate::model::{now_ms, Host, KnownHost};
use crate::store::Store;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;

pub const HOSTKEY_MISMATCH: &str = "HOSTKEY_MISMATCH";

/// Connection progress log sink (shown under "Show logs").
pub type Logger = Arc<dyn Fn(String) + Send + Sync>;

pub fn no_log() -> Logger {
    Arc::new(|_| {})
}

pub struct Client {
    store: Arc<Store>,
    known_id: String,
    mismatch: Option<String>,
    log: Logger,
    /// The jump host connection this one runs through; kept alive with it.
    _jump: Option<Arc<Handle<Client>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(c) => c.signature_key().fingerprint(HashAlg::Sha256),
        }
        .to_string();
        // Trust on first use; reject if the key changed.
        {
            let mut st = self.store.state.lock();
            let known = &mut st.vault.known_hosts;
            match known.iter().find(|k| k.id == self.known_id) {
                Some(k) if k.fingerprint == fp => {
                    (self.log)(format!("Host key verified: {fp}"));
                    return Ok(true);
                }
                Some(_) => {
                    (self.log)(format!("Host key CHANGED: {fp}"));
                    self.mismatch = Some(fp);
                    return Ok(false);
                }
                None => {
                    (self.log)(format!("New host key trusted: {fp}"));
                    known.push(KnownHost { id: self.known_id.clone(), fingerprint: fp, updated_at: now_ms() })
                }
            }
        }
        let _ = self.store.save();
        Ok(true)
    }

    /// Agent forwarding: pipe the server's agent channel to the local ssh-agent.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        #[cfg(unix)]
        if let Some(sock) = std::env::var_os("SSH_AUTH_SOCK") {
            if let Ok(mut agent) = tokio::net::UnixStream::connect(sock).await {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut ch = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut ch, &mut agent).await;
                });
                return Ok(());
            }
        }
        (self.log)("Agent forwarding requested, but no local ssh-agent is running".into());
        let _ = (channel, reply);
        Ok(())
    }
}

pub fn known_id(host: &Host) -> String {
    format!("{}:{}", host.address, host.port)
}

/// Connect and authenticate (key first, then password, then keyboard-interactive), directly,
/// through the host's proxy, or through its jump host.
pub async fn connect(store: Arc<Store>, host: &Host, log: Logger) -> Result<Handle<Client>, String> {
    connect_depth(store, host.clone(), log, 0).await
}

fn connect_depth(
    store: Arc<Store>,
    host: Host,
    log: Logger,
    depth: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Handle<Client>, String>> + Send>> {
    Box::pin(async move { connect_inner(store, &host, log, depth).await })
}

async fn connect_inner(store: Arc<Store>, host: &Host, log: Logger, depth: u32) -> Result<Handle<Client>, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 5,
        nodelay: true,
        ..Default::default()
    });
    log(format!("Starting a new connection to \"{}\" port {}", host.address, host.port));
    let mut handler = Client { store: store.clone(), known_id: known_id(host), mismatch: None, log: log.clone(), _jump: None };
    let connecting = async {
        if !host.jump_host_id.is_empty() {
            if depth >= 3 {
                return Err("Too many nested jump hosts".to_string());
            }
            let jump = {
                let st = store.state.lock();
                let h = st.vault.hosts.iter().find(|h| h.id == host.jump_host_id && !h.deleted).cloned().ok_or("The jump host no longer exists")?;
                st.vault.resolve(h)
            };
            log(format!("Connecting through jump host \"{}\"", jump.name));
            let jl = log.clone();
            let jlog: Logger = Arc::new(move |m| jl(format!("  [jump] {m}")));
            let jh = connect_depth(store.clone(), jump, jlog, depth + 1).await?;
            log(format!("Opening a tunnel to {}:{} through the jump host", host.address, host.port));
            let ch = jh.channel_open_direct_tcpip(host.address.as_str(), host.port as u32, "127.0.0.1", 0).await.map_err(|e| format!("Jump host could not reach {}:{}: {e}", host.address, host.port))?;
            handler._jump = Some(Arc::new(jh));
            Ok(tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, ch.into_stream(), handler)).await)
        } else if !host.proxy.trim().is_empty() {
            log(format!("Connecting through proxy {}", host.proxy.split('@').next_back().unwrap_or("")));
            let s = crate::proxy::connect(&host.proxy, &host.address, host.port).await?;
            Ok(tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, s, handler)).await)
        } else {
            log(format!("Resolving \"{}\"", host.address));
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.address.as_str(), host.port))
                .await
                .map_err(|e| format!("Address resolution failed: {e}"))?
                .collect();
            let ips: Vec<String> = addrs.iter().map(|a| a.ip().to_string()).collect();
            log(format!("Resolved to {}", ips.join(", ")));
            log(format!("Connecting to {} port {}", ips.first().cloned().unwrap_or_default(), host.port));
            Ok(tokio::time::timeout(Duration::from_secs(15), client::connect(config, &addrs[..], handler)).await)
        }
    };
    let mut handle = match connecting.await? {
        Err(_) => return Err("Connection timed out".into()),
        Ok(Err(russh::Error::UnknownKey)) => {
            return Err(format!("{HOSTKEY_MISMATCH}: the host key of {} has changed", known_id(host)))
        }
        Ok(Err(e)) => return Err(e.to_string()),
        Ok(Ok(h)) => h,
    };
    log("Encrypted channel established".into());
    let user = host.username.clone();
    let err = |e: russh::Error| e.to_string();

    if !host.private_key.trim().is_empty() {
        let pass = Some(host.key_passphrase.as_str()).filter(|p| !p.is_empty());
        log(format!("Authenticating as \"{user}\" with private key"));
        let key = russh::keys::decode_secret_key(&host.private_key, pass).map_err(|e| format!("Private key: {e}"))?;
        let hash = handle.best_supported_rsa_hash().await.map_err(err)?.flatten();
        let res = handle
            .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(err)?;
        if res.success() {
            log("Authenticated with private key".into());
            return Ok(handle);
        }
        log("Private key rejected".into());
    }
    if !host.password.is_empty() {
        log(format!("Authenticating as \"{user}\" with password"));
        if handle.authenticate_password(&user, &host.password).await.map_err(err)?.success() {
            log("Authenticated with password".into());
            return Ok(handle);
        }
        log("Password rejected, trying keyboard-interactive".into());
        let mut res = handle
            .authenticate_keyboard_interactive_start(&user, None::<String>)
            .await
            .map_err(err)?;
        for _ in 0..5 {
            match res {
                KeyboardInteractiveAuthResponse::Success => {
                    log("Authenticated with keyboard-interactive".into());
                    return Ok(handle);
                }
                KeyboardInteractiveAuthResponse::Failure { .. } => break,
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|_| host.password.clone()).collect();
                    res = handle.authenticate_keyboard_interactive_respond(answers).await.map_err(err)?;
                }
            }
        }
    }
    Err("Authentication failed".into())
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Status {
    Connected,
    Closed,
    Error { message: String },
    Log { message: String },
    /// Upload progress 0..1 for image/file uploads.
    Upload { progress: f64 },
    /// Round-trip time of a raw TCP session (VNC), from the kernel's TCP stats.
    Rtt { micros: u32 },
}

/// Terminal output flow control: the UI acks bytes it has rendered; past HIGH unacked bytes
/// we stop reading (the program or SSH server then blocks) until it drains below LOW.
#[derive(Default)]
pub struct Flow {
    unacked: parking_lot::Mutex<u64>,
    cv: parking_lot::Condvar,
    notify: tokio::sync::Notify,
}

impl Flow {
    const HIGH: u64 = 4 << 20;
    const LOW: u64 = 1 << 20;

    pub fn sent(&self, n: usize) {
        *self.unacked.lock() += n as u64;
    }

    pub fn ack(&self, n: u64) {
        let mut u = self.unacked.lock();
        *u = u.saturating_sub(n);
        if *u < Self::LOW {
            self.cv.notify_all();
            self.notify.notify_one();
        }
    }

    pub fn blocked(&self) -> bool {
        *self.unacked.lock() > Self::HIGH
    }

    /// For blocking reader threads: wait (re-checking every second) until drained.
    pub fn wait_drained(&self) {
        let mut u = self.unacked.lock();
        while *u > Self::LOW {
            self.cv.wait_for(&mut u, Duration::from_secs(1));
        }
    }

    pub async fn drained(&self) {
        while *self.unacked.lock() > Self::LOW {
            self.notify.notified().await;
        }
    }
}

pub enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
    /// Upload bytes to /tmp/kermius-images/<uuid>.<ext>; replies with the remote path.
    Upload { ext: String, data: Vec<u8>, reply: tokio::sync::oneshot::Sender<Result<String, String>> },
}

/// Upload over a separate exec channel on the same connection (`cat > file`), reporting progress.
async fn upload(h: &Handle<Client>, ext: &str, data: Vec<u8>, status: &Channel<Status>) -> Result<String, String> {
    let e = |e: russh::Error| e.to_string();
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect::<String>().to_lowercase();
    let path = format!("/tmp/kermius-images/{}.{}", uuid::Uuid::new_v4(), if ext.is_empty() { "bin" } else { &ext });
    let mut ch = h.channel_open_session().await.map_err(e)?;
    ch.exec(true, format!("mkdir -p /tmp/kermius-images && cat > '{path}'")).await.map_err(e)?;
    let total = data.len().max(1);
    let mut sent = 0;
    for chunk in data.chunks(64 * 1024) {
        ch.data_bytes(chunk.to_vec()).await.map_err(e)?;
        sent += chunk.len();
        let _ = status.send(Status::Upload { progress: sent as f64 / total as f64 });
    }
    ch.eof().await.map_err(e)?;
    while let Some(msg) = ch.wait().await {
        if let ChannelMsg::ExitStatus { exit_status } = msg {
            return if exit_status == 0 { Ok(path) } else { Err(format!("Upload failed (exit {exit_status})")) };
        }
    }
    Ok(path)
}

/// Spawn an interactive shell session; returns the command sender.
pub fn spawn_shell(
    store: Arc<Store>,
    host: Host,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
) -> mpsc::UnboundedSender<Cmd> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let status = on_status.clone();
            let log: Logger = Arc::new(move |message| {
                let _ = status.send(Status::Log { message });
            });
            let handle = Arc::new(connect(store.clone(), &host, log.clone()).await?);
            log("Opening session channel".into());
            let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
            log(format!("Requesting PTY {cols}x{rows}"));
            ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(|e| e.to_string())?;
            // Servers only accept variables listed in their AcceptEnv; the rest are ignored.
            for (name, value) in host.env.lines().filter_map(|l| l.trim().split_once('=')) {
                let _ = ch.set_env(false, name.trim(), value.trim()).await;
            }
            if host.agent_forward {
                log("Requesting agent forwarding".into());
                let _ = ch.agent_forward(false).await;
            }
            log("Starting shell".into());
            ch.request_shell(false).await.map_err(|e| e.to_string())?;
            let _ = on_status.send(Status::Connected);
            let snippet = {
                let st = store.state.lock();
                st.vault.snippets.iter().find(|s| !s.deleted && !host.startup_snippet_id.is_empty() && s.id == host.startup_snippet_id).map(|s| s.script.clone())
            };
            if let Some(script) = snippet {
                log("Running the startup snippet".into());
                ch.data_bytes(format!("{}\n", script.trim_end()).into_bytes()).await.map_err(|e| e.to_string())?;
            }

            // Coalesce output into ~4ms frames so heavy output doesn't flood IPC.
            let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
            let flush_every = Duration::from_millis(4);
            let mut deadline = tokio::time::Instant::now();
            // Without an exit status, a closed channel means the connection dropped.
            let mut exited = false;
            loop {
                tokio::select! {
                    // Paused while the UI is behind; the SSH window then fills and the server stops sending.
                    _ = flow.drained(), if flow.blocked() => {}
                    msg = ch.wait(), if !flow.blocked() => match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if buf.is_empty() { deadline = tokio::time::Instant::now() + flush_every; }
                            buf.extend_from_slice(&data);
                            if buf.len() >= 256 * 1024 {
                                { flow.sent(buf.len()); let _ = on_data.send(InvokeResponseBody::Raw(std::mem::take(&mut buf))); }
                            }
                        }
                        Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::ExitSignal { .. }) => exited = true,
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    _ = tokio::time::sleep_until(deadline), if !buf.is_empty() => {
                        { flow.sent(buf.len()); let _ = on_data.send(InvokeResponseBody::Raw(std::mem::take(&mut buf))); }
                    }
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Data(d)) => ch.data_bytes(d).await.map_err(|e| e.to_string())?,
                        Some(Cmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                        Some(Cmd::Upload { ext, data, reply }) => {
                            let (h, status) = (handle.clone(), on_status.clone());
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(upload(&h, &ext, data, &status).await);
                            });
                        }
                        Some(Cmd::Close) | None => { exited = true; break }
                    },
                }
            }
            if !buf.is_empty() {
                flow.sent(buf.len());
                let _ = on_data.send(InvokeResponseBody::Raw(buf));
            }
            if !exited {
                return Err("Connection lost".into());
            }
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            Ok(())
        }
        .await;
        let _ = on_status.send(match result {
            Ok(()) => Status::Closed,
            Err(message) => Status::Error { message },
        });
    });
    tx
}

/// Against a real sshd: `KERMIUS_TEST_SSH="port|user|/path/to/private_key" cargo test ssh_e2e`
#[cfg(test)]
mod e2e {
    use super::*;

    #[tokio::test]
    async fn ssh_e2e() {
        let Ok(cfg) = std::env::var("KERMIUS_TEST_SSH") else { return };
        let [port, user, key] = cfg.split('|').collect::<Vec<_>>()[..] else { panic!("bad KERMIUS_TEST_SSH") };
        let dir = std::env::temp_dir().join(format!("kermius-ssh-test-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(dir).unwrap());
        let host = Host {
            address: "127.0.0.1".into(),
            port: port.parse().unwrap(),
            username: user.into(),
            private_key: std::fs::read_to_string(key).unwrap(),
            ..Default::default()
        };
        let logs = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let l = logs.clone();
        let h = connect(store.clone(), &host, Arc::new(move |m| l.lock().push(m))).await.unwrap();
        println!("{}", logs.lock().join("\n"));
        assert!(logs.lock().iter().any(|m| m.starts_with("New host key trusted")));
        assert_eq!(store.state.lock().vault.known_hosts.len(), 1);

        let progress = Arc::new(parking_lot::Mutex::new(0usize));
        let p = progress.clone();
        let status: Channel<Status> = Channel::new(move |_| {
            *p.lock() += 1;
            Ok(())
        });
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let path = upload(&h, "png", data.clone(), &status).await.unwrap();
        assert!(path.starts_with("/tmp/kermius-images/") && path.ends_with(".png"));
        assert_eq!(std::fs::read(&path).unwrap(), data); // sshd is local, so the file is visible here
        assert!(*progress.lock() >= 3);
        std::fs::remove_file(&path).unwrap();

        // Second connect: key is now known.
        logs.lock().clear();
        let l = logs.clone();
        connect(store, &host, Arc::new(move |m| l.lock().push(m))).await.unwrap();
        assert!(logs.lock().iter().any(|m| m.starts_with("Host key verified")));
    }
}
