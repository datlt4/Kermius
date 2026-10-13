use crate::model::Host;
use crate::ssh::{self, Client};
use crate::store::Store;
use parking_lot::Mutex;
use russh::client::Handle;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::async_runtime::JoinHandle;

/// Local port forwards, keyed by "hostId:index".
#[derive(Default)]
pub struct Tunnels {
    active: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl Tunnels {
    pub async fn start(&self, store: Arc<Store>, host: Host, index: usize) -> Result<(), String> {
        let key = format!("{}:{index}", host.id);
        if self.active.lock().contains_key(&key) {
            return Ok(());
        }
        let t = host.tunnels.get(index).cloned().ok_or("No such tunnel")?;
        let first = ssh::connect(store.clone(), &host).await?;
        let listener = tokio::net::TcpListener::bind((t.bind_host.as_str(), t.source_port))
            .await
            .map_err(|e| format!("Bind {}:{}: {e}", t.bind_host, t.source_port))?;
        let port = t.endpoint_port as u32;
        let target = Some(t.endpoint_host.clone()).filter(|h| !h.is_empty()).unwrap_or("127.0.0.1".into());
        let conn: Arc<tokio::sync::Mutex<Arc<Handle<Client>>>> = Arc::new(tokio::sync::Mutex::new(Arc::new(first)));
        let task = tauri::async_runtime::spawn(async move {
            while let Ok((mut sock, peer)) = listener.accept().await {
                let (conn, store, host, target) = (conn.clone(), store.clone(), host.clone(), target.clone());
                tauri::async_runtime::spawn(async move {
                    let handle = {
                        let mut guard = conn.lock().await;
                        if guard.is_closed() {
                            match ssh::connect(store, &host).await {
                                Ok(h) => *guard = Arc::new(h),
                                Err(_) => return,
                            }
                        }
                        guard.clone()
                    };
                    let Ok(ch) = handle
                        .channel_open_direct_tcpip(target, port, peer.ip().to_string(), peer.port() as u32)
                        .await
                    else {
                        return;
                    };
                    let mut stream = ch.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                });
            }
        });
        self.active.lock().insert(key, task);
        Ok(())
    }

    pub fn stop(&self, host_id: &str, index: usize) {
        if let Some(task) = self.active.lock().remove(&format!("{host_id}:{index}")) {
            task.abort();
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.active.lock().keys().cloned().collect()
    }
}
