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

pub struct Client {
    store: Arc<Store>,
    known_id: String,
    mismatch: Option<String>,
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
                Some(k) if k.fingerprint == fp => return Ok(true),
                Some(_) => {
                    self.mismatch = Some(fp);
                    return Ok(false);
                }
                None => known.push(KnownHost { id: self.known_id.clone(), fingerprint: fp, updated_at: now_ms() }),
            }
        }
        let _ = self.store.save();
        Ok(true)
    }
}

pub fn known_id(host: &Host) -> String {
    format!("{}:{}", host.address, host.port)
}

/// Connect and authenticate (key first, then password, then keyboard-interactive).
pub async fn connect(store: Arc<Store>, host: &Host) -> Result<Handle<Client>, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 5,
        nodelay: true,
        ..Default::default()
    });
    let handler = Client { store, known_id: known_id(host), mismatch: None };
    let addr = (host.address.as_str(), host.port);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), client::connect(config, addr, handler)).await {
        Err(_) => return Err("Connection timed out".into()),
        Ok(Err(russh::Error::UnknownKey)) => {
            return Err(format!("{HOSTKEY_MISMATCH}: the host key of {} has changed", known_id(host)))
        }
        Ok(Err(e)) => return Err(e.to_string()),
        Ok(Ok(h)) => h,
    };
    let user = host.username.clone();
    let err = |e: russh::Error| e.to_string();

    if !host.private_key.trim().is_empty() {
        let pass = Some(host.key_passphrase.as_str()).filter(|p| !p.is_empty());
        let key = russh::keys::decode_secret_key(&host.private_key, pass).map_err(|e| format!("Private key: {e}"))?;
        let hash = handle.best_supported_rsa_hash().await.map_err(err)?.flatten();
        let res = handle
            .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(err)?;
        if res.success() {
            return Ok(handle);
        }
    }
    if !host.password.is_empty() {
        if handle.authenticate_password(&user, &host.password).await.map_err(err)?.success() {
            return Ok(handle);
        }
        let mut res = handle
            .authenticate_keyboard_interactive_start(&user, None::<String>)
            .await
            .map_err(err)?;
        for _ in 0..5 {
            match res {
                KeyboardInteractiveAuthResponse::Success => return Ok(handle),
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
}

pub enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// Spawn an interactive shell session; returns the command sender.
pub fn spawn_shell(
    store: Arc<Store>,
    host: Host,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
) -> mpsc::UnboundedSender<Cmd> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let handle = connect(store, &host).await?;
            let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
            ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(|e| e.to_string())?;
            ch.request_shell(false).await.map_err(|e| e.to_string())?;
            let _ = on_status.send(Status::Connected);

            // Coalesce output into ~4ms frames so heavy output doesn't flood IPC.
            let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
            let flush_every = Duration::from_millis(4);
            let mut deadline = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    msg = ch.wait() => match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if buf.is_empty() { deadline = tokio::time::Instant::now() + flush_every; }
                            buf.extend_from_slice(&data);
                            if buf.len() >= 256 * 1024 {
                                let _ = on_data.send(InvokeResponseBody::Raw(std::mem::take(&mut buf)));
                            }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    _ = tokio::time::sleep_until(deadline), if !buf.is_empty() => {
                        let _ = on_data.send(InvokeResponseBody::Raw(std::mem::take(&mut buf)));
                    }
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Data(d)) => ch.data_bytes(d).await.map_err(|e| e.to_string())?,
                        Some(Cmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                        Some(Cmd::Close) | None => break,
                    },
                }
            }
            if !buf.is_empty() {
                let _ = on_data.send(InvokeResponseBody::Raw(buf));
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
