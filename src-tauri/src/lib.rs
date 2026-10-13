mod crypto;
#[cfg(not(target_os = "ios"))]
mod local;
mod model;
mod ssh;
mod store;
mod sync;
mod termix;
mod tunnel;

use model::{now_ms, Host, SyncSettings};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use store::Store;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::mpsc::UnboundedSender;

pub const IDENTIFIER: &str = "com.koi.kermius";

struct AppState {
    store: Arc<Store>,
    sessions: Mutex<HashMap<String, UnboundedSender<ssh::Cmd>>>,
    tunnels: tunnel::Tunnels,
}

type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

impl AppState {
    fn host(&self, id: &str) -> Res<Host> {
        let st = self.store.state.lock();
        st.vault.hosts.iter().find(|h| h.id == id && !h.deleted).cloned().ok_or("Host not found".into())
    }
}

#[tauri::command]
fn list_hosts(state: State<AppState>) -> Vec<Host> {
    let st = state.store.state.lock();
    st.vault.hosts.iter().filter(|h| !h.deleted).cloned().collect()
}

#[tauri::command]
fn save_host(state: State<AppState>, mut host: Host) -> Res<Host> {
    if host.id.is_empty() {
        host.id = uuid::Uuid::new_v4().to_string();
    }
    host.updated_at = now_ms();
    host.deleted = false;
    {
        let mut st = state.store.state.lock();
        match st.vault.hosts.iter_mut().find(|h| h.id == host.id) {
            Some(h) => *h = host.clone(),
            None => st.vault.hosts.push(host.clone()),
        }
    }
    state.store.save().map_err(e)?;
    Ok(host)
}

#[tauri::command]
fn delete_host(state: State<AppState>, id: String) -> Res<()> {
    {
        let mut st = state.store.state.lock();
        if let Some(h) = st.vault.hosts.iter_mut().find(|h| h.id == id) {
            *h = Host { id: h.id.clone(), updated_at: now_ms(), deleted: true, ..Default::default() };
        }
    }
    state.store.save().map_err(e)
}

#[tauri::command]
fn import_termix(state: State<AppState>, path: String) -> Res<termix::ImportReport> {
    let json = std::fs::read_to_string(&path).map_err(e)?;
    let report = termix::import(&mut state.store.state.lock().vault, &json).map_err(e)?;
    state.store.save().map_err(e)?;
    Ok(report)
}

#[tauri::command]
fn copy_password(app: tauri::AppHandle, state: State<AppState>, id: String) -> Res<()> {
    let host = state.host(&id)?;
    if host.password.is_empty() {
        return Err("This host has no password".into());
    }
    app.clipboard().write_text(host.password).map_err(e)
}

#[tauri::command]
fn clipboard_write(app: tauri::AppHandle, text: String) -> Res<()> {
    app.clipboard().write_text(text).map_err(e)
}

#[tauri::command]
fn clipboard_read(app: tauri::AppHandle) -> Res<String> {
    app.clipboard().read_text().map_err(e)
}

#[tauri::command]
fn ssh_connect(
    state: State<AppState>,
    host_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<ssh::Status>,
) -> Res<String> {
    let host = state.host(&host_id)?;
    let tx = ssh::spawn_shell(state.store.clone(), host, cols, rows, on_data, on_status);
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().insert(sid.clone(), tx);
    Ok(sid)
}

#[tauri::command]
fn local_open(
    state: State<AppState>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<ssh::Status>,
) -> Res<String> {
    #[cfg(target_os = "ios")]
    return Err("Local terminal is not available on iOS".into());
    #[cfg(not(target_os = "ios"))]
    {
        let tx = local::spawn(cols, rows, on_data, on_status)?;
        let sid = uuid::Uuid::new_v4().to_string();
        state.sessions.lock().insert(sid.clone(), tx);
        Ok(sid)
    }
}

/// Installed monospace font families (desktop only).
#[tauri::command]
async fn list_fonts() -> Vec<String> {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    return tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut v: Vec<String> = db
            .faces()
            .filter(|f| f.monospaced)
            .filter_map(|f| f.families.first().map(|(n, _)| n.clone()))
            .collect();
        v.sort_by_key(|s| s.to_lowercase());
        v.dedup();
        v
    })
    .await
    .unwrap_or_default();
    #[cfg(any(target_os = "ios", target_os = "android"))]
    Vec::new()
}

fn send_cmd(state: &AppState, sid: &str, cmd: ssh::Cmd) {
    if let Some(tx) = state.sessions.lock().get(sid) {
        let _ = tx.send(cmd);
    }
}

#[tauri::command]
fn ssh_write(state: State<AppState>, sid: String, data: String) {
    send_cmd(&state, &sid, ssh::Cmd::Data(data.into_bytes()));
}

async fn upload_to_session(state: &AppState, sid: &str, ext: &str, data: Vec<u8>) -> Res<String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    let tx = state.sessions.lock().get(sid).cloned().ok_or("Session not found")?;
    tx.send(ssh::Cmd::Upload { ext: ext.into(), data, reply }).map_err(|_| "Session closed")?;
    rx.await.map_err(|_| "Session closed".to_string())?
}

/// Raw body = file bytes; headers `sid`, `ext`.
#[tauri::command]
async fn ssh_upload(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Expected raw file bytes".into());
    };
    upload_to_session(&state, &header("sid"), &header("ext"), data.clone()).await
}

/// Upload the clipboard image (as PNG) to the session's host.
#[tauri::command]
async fn ssh_paste_image(app: tauri::AppHandle, state: State<'_, AppState>, sid: String) -> Res<String> {
    #[cfg(desktop)]
    {
        let img = app.clipboard().read_image().map_err(|_| "No image in the clipboard".to_string())?;
        let mut png_bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png_bytes, img.width(), img.height());
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().and_then(|mut w| w.write_image_data(img.rgba())).map_err(e)?;
        }
        upload_to_session(&state, &sid, "png", png_bytes).await
    }
    #[cfg(mobile)]
    {
        let _ = (app, state, sid);
        Err("Not available on mobile".into())
    }
}

#[tauri::command]
fn ssh_resize(state: State<AppState>, sid: String, cols: u32, rows: u32) {
    send_cmd(&state, &sid, ssh::Cmd::Resize(cols, rows));
}

#[tauri::command]
fn ssh_close(state: State<AppState>, sid: String) {
    send_cmd(&state, &sid, ssh::Cmd::Close);
    state.sessions.lock().remove(&sid);
}

/// Forget the stored host key so the next connection trusts the new one.
#[tauri::command]
fn trust_new_host_key(state: State<AppState>, host_id: String) -> Res<()> {
    let id = ssh::known_id(&state.host(&host_id)?);
    {
        let mut st = state.store.state.lock();
        st.vault.known_hosts.retain(|k| k.id != id);
    }
    state.store.save().map_err(e)
}

#[tauri::command]
async fn tunnel_start(state: State<'_, AppState>, host_id: String, index: usize) -> Res<()> {
    let host = state.host(&host_id)?;
    state.tunnels.start(state.store.clone(), host, index).await
}

#[tauri::command]
fn tunnel_stop(state: State<AppState>, host_id: String, index: usize) {
    state.tunnels.stop(&host_id, index);
}

#[tauri::command]
fn tunnel_list(state: State<AppState>) -> Vec<String> {
    state.tunnels.list()
}

#[tauri::command]
fn get_sync_settings(state: State<AppState>) -> SyncSettings {
    state.store.state.lock().sync.clone()
}

#[tauri::command]
fn set_sync_settings(state: State<AppState>, settings: SyncSettings) -> Res<()> {
    {
        let mut st = state.store.state.lock();
        let last_sync = st.sync.last_sync;
        st.sync = SyncSettings { last_sync, ..settings };
    }
    state.store.save().map_err(e)
}

#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> Res<sync::SyncReport> {
    sync::sync(&state.store).await.map_err(e)
}

/// `kermius --import-termix <file>`: import without opening the UI.
pub fn cli_import(path: &str) -> anyhow::Result<String> {
    let dir = dirs::data_dir().ok_or_else(|| anyhow::anyhow!("no data dir"))?.join(IDENTIFIER);
    let store = Store::open(dir)?;
    let json = std::fs::read_to_string(path)?;
    let report = termix::import(&mut store.state.lock().vault, &json)?;
    store.save()?;
    Ok(format!("Imported from {path}: {} added, {} updated", report.added, report.updated))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let store = Store::open(app.path().app_data_dir()?)?;
            app.manage(AppState {
                store: Arc::new(store),
                sessions: Default::default(),
                tunnels: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts,
            save_host,
            delete_host,
            import_termix,
            copy_password,
            clipboard_write,
            clipboard_read,
            ssh_connect,
            local_open,
            list_fonts,
            ssh_write,
            ssh_upload,
            ssh_paste_image,
            ssh_resize,
            ssh_close,
            trust_new_host_key,
            tunnel_start,
            tunnel_stop,
            tunnel_list,
            get_sync_settings,
            set_sync_settings,
            sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kermius");
}
