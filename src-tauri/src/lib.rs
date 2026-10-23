mod crypto;
mod files;
#[cfg(desktop)]
mod launch;
#[cfg(target_os = "ios")]
mod ios_photos;
mod foldersync;
mod watch;
#[cfg(not(target_os = "ios"))]
mod local;
mod model;
mod proto;
mod nearby;
mod proxy;
mod ssh;
mod sshconfig;
mod update;
mod wol;
mod store;
mod sync;
mod termix;
mod tunnel;

use foldersync::Plan;
use model::{now_ms, Host, Identity, Key, Snippet, SyncSettings};
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
    sessions: Mutex<HashMap<String, (UnboundedSender<ssh::Cmd>, Arc<ssh::Flow>)>>,
    tunnels: tunnel::Tunnels,
    files: Arc<files::Files>,
    running_syncs: Mutex<std::collections::HashSet<String>>,
    /// Stop signals for running Folder Sync jobs.
    sync_stops: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    watchers: watch::Watchers,
}

type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

impl AppState {
    fn host(&self, id: &str) -> Res<Host> {
        let st = self.store.state.lock();
        let host = st.vault.hosts.iter().find(|h| h.id == id && !h.deleted).cloned().ok_or("Host not found")?;
        Ok(st.vault.resolve(host))
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
fn list_snippets(state: State<AppState>) -> Vec<Snippet> {
    let st = state.store.state.lock();
    st.vault.snippets.iter().filter(|s| !s.deleted).cloned().collect()
}

#[tauri::command]
fn save_snippet(state: State<AppState>, mut snippet: Snippet) -> Res<Snippet> {
    if snippet.id.is_empty() {
        snippet.id = uuid::Uuid::new_v4().to_string();
    }
    snippet.updated_at = now_ms();
    snippet.deleted = false;
    {
        let mut st = state.store.state.lock();
        match st.vault.snippets.iter_mut().find(|s| s.id == snippet.id) {
            Some(s) => *s = snippet.clone(),
            None => st.vault.snippets.push(snippet.clone()),
        }
    }
    state.store.save().map_err(e)?;
    Ok(snippet)
}

#[tauri::command]
fn delete_snippet(state: State<AppState>, id: String) -> Res<()> {
    {
        let mut st = state.store.state.lock();
        if let Some(s) = st.vault.snippets.iter_mut().find(|s| s.id == id) {
            *s = Snippet { id: s.id.clone(), updated_at: now_ms(), deleted: true, ..Default::default() };
        }
    }
    state.store.save().map_err(e)
}

/// Insert or replace by id, stamping a fresh id/timestamp; then persist.
fn upsert<T: Clone>(
    state: &AppState,
    list: impl Fn(&mut model::Vault) -> &mut Vec<T>,
    mut item: T,
    id: impl Fn(&mut T) -> &mut String,
    stamp: impl Fn(&mut T),
) -> Res<T> {
    if id(&mut item).is_empty() {
        *id(&mut item) = uuid::Uuid::new_v4().to_string();
    }
    stamp(&mut item);
    {
        let mut st = state.store.state.lock();
        let key = id(&mut item).clone();
        let v = list(&mut st.vault);
        match v.iter_mut().position(|x| *id(x) == key) {
            Some(i) => v[i] = item.clone(),
            None => v.push(item.clone()),
        }
    }
    state.store.save().map_err(e)?;
    Ok(item)
}

#[tauri::command]
fn list_keys(state: State<AppState>) -> Vec<Key> {
    state.store.state.lock().vault.keys.iter().filter(|k| !k.deleted).cloned().collect()
}

#[tauri::command]
fn save_key(state: State<AppState>, key: Key) -> Res<Key> {
    let public_key = key_info(key.private_key.clone(), key.passphrase.clone())?.public_key;
    upsert(&state, |v| &mut v.keys, Key { public_key, ..key }, |k| &mut k.id, |k| {
        k.updated_at = now_ms();
        k.deleted = false;
    })
}

#[tauri::command]
fn delete_key(state: State<AppState>, id: String) -> Res<()> {
    upsert(&state, |v| &mut v.keys, Key { id, ..Default::default() }, |k| &mut k.id, |k| {
        k.updated_at = now_ms();
        k.deleted = true;
    })
    .map(|_| ())
}

#[tauri::command]
fn list_identities(state: State<AppState>) -> Vec<Identity> {
    state.store.state.lock().vault.identities.iter().filter(|i| !i.deleted).cloned().collect()
}

#[tauri::command]
fn save_identity(state: State<AppState>, identity: Identity) -> Res<Identity> {
    upsert(&state, |v| &mut v.identities, identity, |i| &mut i.id, |i| {
        i.updated_at = now_ms();
        i.deleted = false;
    })
}

#[tauri::command]
fn delete_identity(state: State<AppState>, id: String) -> Res<()> {
    upsert(&state, |v| &mut v.identities, Identity { id, ..Default::default() }, |i| &mut i.id, |i| {
        i.updated_at = now_ms();
        i.deleted = true;
    })
    .map(|_| ())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyInfo {
    public_key: String,
    fingerprint: String,
    algorithm: String,
}

/// Validate a private key (with passphrase) and derive its public key.
#[tauri::command]
fn key_info(private_key: String, passphrase: String) -> Res<KeyInfo> {
    let pass = Some(passphrase.as_str()).filter(|p| !p.is_empty());
    let key = russh::keys::decode_secret_key(&private_key, pass).map_err(|err| format!("Invalid private key: {err}"))?;
    let public = key.public_key();
    Ok(KeyInfo {
        public_key: public.to_openssh().map_err(e)?,
        fingerprint: public.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        algorithm: key.algorithm().to_string(),
    })
}

/// New Ed25519 key in OpenSSH format (unencrypted; the vault itself is encrypted).
#[tauri::command]
fn generate_key(comment: String) -> Res<String> {
    use russh::keys::ssh_key::{private::Ed25519Keypair, LineEnding, PrivateKey};
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&crypto::random::<32>()));
    key.set_comment(comment);
    Ok(key.to_openssh(LineEnding::LF).map_err(e)?.to_string())
}

#[tauri::command]
fn import_termix(state: State<AppState>, path: String) -> Res<termix::ImportReport> {
    let json = std::fs::read_to_string(&path).map_err(e)?;
    let report = termix::import(&mut state.store.state.lock().vault, &json).map_err(e)?;
    state.store.save().map_err(e)?;
    Ok(report)
}

/// Preview of the `~/.ssh/config` entries for these hosts.
#[tauri::command]
fn ssh_config_preview(state: State<AppState>, host_ids: Vec<String>, with_keys: bool, with_passwords: bool) -> String {
    sshconfig::render(&state.store.state.lock().vault, &host_ids, with_keys, with_passwords).config
}

/// Import hosts from `~/.ssh/config` (with its Includes).
#[tauri::command]
fn ssh_config_import(state: State<AppState>) -> Res<termix::ImportReport> {
    let home = dirs::home_dir().ok_or("No home folder")?;
    let file = home.join(".ssh").join("config");
    if !file.exists() {
        return Err(format!("{} not found", file.display()));
    }
    let entries = sshconfig::parse(&file, &home);
    let report = sshconfig::import(&mut state.store.state.lock().vault, entries);
    state.store.save().map_err(e)?;
    Ok(report)
}

/// Write the hosts into `~/.ssh/config` (Kermius block) and their keys into `~/.ssh/kermius/`.
#[tauri::command]
fn ssh_config_export(state: State<AppState>, host_ids: Vec<String>, with_keys: bool, with_passwords: bool) -> Res<String> {
    let ex = sshconfig::render(&state.store.state.lock().vault, &host_ids, with_keys, with_passwords);
    let home = dirs::home_dir().ok_or("No home folder")?;
    sshconfig::write(&home.join(".ssh"), &ex).map_err(e)
}

/// Clipboard access off the UI thread, with a time limit: on X11 a read waits for the selection owner,
/// which can be slow, hung, or our own window (then the UI would freeze).
async fn with_clipboard<T: Send + 'static>(app: tauri::AppHandle, f: impl FnOnce(&tauri::AppHandle) -> Res<T> + Send + 'static) -> Res<T> {
    let job = tauri::async_runtime::spawn_blocking(move || f(&app));
    match tokio::time::timeout(std::time::Duration::from_secs(3), job).await {
        Ok(r) => r.map_err(e)?,
        Err(_) => Err("The clipboard did not respond".into()),
    }
}

#[tauri::command]
async fn copy_password(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Res<()> {
    let host = state.host(&id)?;
    if host.password.is_empty() {
        return Err("This host has no password".into());
    }
    with_clipboard(app, move |a| a.clipboard().write_text(host.password).map_err(e)).await
}

#[tauri::command]
async fn clipboard_write(app: tauri::AppHandle, text: String) -> Res<()> {
    with_clipboard(app, move |a| a.clipboard().write_text(text).map_err(e)).await
}

#[tauri::command]
async fn clipboard_read(app: tauri::AppHandle) -> Res<String> {
    with_clipboard(app, |a| a.clipboard().read_text().map_err(e)).await
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
    let flow = Arc::new(ssh::Flow::default());
    let tx = match host.protocol.as_str() {
        "telnet" => proto::spawn_telnet(host, cols, rows, on_data, on_status, flow.clone()),
        #[cfg(desktop)]
        "serial" => proto::spawn_serial(host, on_data, on_status, flow.clone()),
        #[cfg(desktop)]
        "mosh" => spawn_mosh(&host, cols, rows, on_data, on_status, flow.clone())?,
        "ssh" | "" => ssh::spawn_shell(state.store.clone(), host, cols, rows, on_data, on_status, flow.clone()),
        p => return Err(format!("{p} is not available here")),
    };
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().insert(sid.clone(), (tx, flow));
    Ok(sid)
}

#[tauri::command]
fn wol_list(state: State<AppState>) -> Vec<model::WolDevice> {
    state.store.state.lock().vault.wol.iter().filter(|w| !w.deleted).cloned().collect()
}

#[tauri::command]
fn wol_save(state: State<AppState>, mut device: model::WolDevice) -> Res<model::WolDevice> {
    wol::parse_mac(&device.mac)?;
    if device.id.is_empty() {
        device.id = uuid::Uuid::new_v4().to_string();
    }
    device.updated_at = now_ms();
    device.deleted = false;
    {
        let mut st = state.store.state.lock();
        match st.vault.wol.iter_mut().find(|w| w.id == device.id) {
            Some(w) => *w = device.clone(),
            None => st.vault.wol.push(device.clone()),
        }
    }
    state.store.save().map_err(e)?;
    Ok(device)
}

#[tauri::command]
fn wol_delete(state: State<AppState>, id: String) -> Res<()> {
    {
        let mut st = state.store.state.lock();
        if let Some(w) = st.vault.wol.iter_mut().find(|w| w.id == id) {
            *w = model::WolDevice { id: w.id.clone(), updated_at: now_ms(), deleted: true, ..Default::default() };
        }
    }
    state.store.save().map_err(e)
}

/// Sends the magic packet, from this computer or from the relay host on the target's LAN.
#[tauri::command]
async fn wol_send(state: State<'_, AppState>, id: String) -> Res<()> {
    let dev = state.store.state.lock().vault.wol.iter().find(|w| w.id == id && !w.deleted).cloned().ok_or("Device not found")?;
    if dev.relay.is_empty() {
        wol::send_direct(&dev)
    } else {
        let relay = state.host(&dev.relay)?;
        wol::send_via(state.store.clone(), &relay, &dev).await
    }
}

/// Connect and authenticate an (unsaved) host, then disconnect; returns the connection log.
#[tauri::command]
async fn ssh_test(state: State<'_, AppState>, host: Host) -> Res<Vec<String>> {
    let host = state.store.state.lock().vault.resolve(host);
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let log: ssh::Logger = Arc::new(move |m| sink.lock().push(m));
    let result = ssh::connect(state.store.clone(), &host, log).await;
    let mut lines = std::mem::take(&mut *lines.lock());
    match result {
        Ok(handle) => {
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
            lines.push("Authentication succeeded".into());
            Ok(lines)
        }
        Err(e) => {
            lines.push(e);
            Err(lines.join("\n"))
        }
    }
}

#[tauri::command]
fn nearby_status(nearby: State<Arc<nearby::Nearby>>) -> nearby::Status {
    nearby.status()
}

#[tauri::command]
async fn nearby_start(nearby: State<'_, Arc<nearby::Nearby>>) -> Res<nearby::Status> {
    nearby.start().await?;
    Ok(nearby.status())
}

#[tauri::command]
fn nearby_stop(nearby: State<Arc<nearby::Nearby>>) {
    nearby.stop();
}

#[tauri::command]
fn nearby_refresh(nearby: State<Arc<nearby::Nearby>>) -> Res<()> {
    nearby.refresh()
}

#[tauri::command]
async fn nearby_probe(nearby: State<'_, Arc<nearby::Nearby>>, addresses: Vec<String>) -> Res<Vec<nearby::Device>> {
    Ok(nearby.probe(addresses).await)
}

#[tauri::command]
fn nearby_send(nearby: State<Arc<nearby::Nearby>>, fingerprint: String, paths: Vec<String>, texts: Vec<String>) -> Res<String> {
    nearby.send(&fingerprint, paths, texts)
}

#[tauri::command]
fn nearby_respond(nearby: State<Arc<nearby::Nearby>>, id: String, accept: bool) {
    nearby.respond(&id, accept);
}

/// Open the folder received files are saved to.
#[tauri::command]
fn nearby_open_folder(app: tauri::AppHandle, nearby: State<Arc<nearby::Nearby>>) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(nearby.save_dir().to_string_lossy(), None::<&str>).map_err(e)
}

#[tauri::command]
fn nearby_set_alias(nearby: State<Arc<nearby::Nearby>>, alias: String) -> nearby::Status {
    nearby.set_alias(&alias);
    nearby.status()
}

#[tauri::command]
fn nearby_set_dir(nearby: State<Arc<nearby::Nearby>>, dir: String) -> Res<nearby::Status> {
    nearby.set_save_dir(&dir)?;
    Ok(nearby.status())
}

#[tauri::command]
fn nearby_cancel(nearby: State<Arc<nearby::Nearby>>, id: String) {
    nearby.cancel(&id);
}

/// Whether `name` is an executable on PATH.
#[cfg(desktop)]
fn in_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
}

/// mosh in a local PTY; its ssh bootstrap goes through our bridge, so vault credentials and TOFU apply.
#[cfg(desktop)]
fn spawn_mosh(
    host: &Host,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<ssh::Status>,
    flow: Arc<ssh::Flow>,
) -> Res<tokio::sync::mpsc::UnboundedSender<ssh::Cmd>> {
    if !in_path("mosh") {
        return Err(format!("mosh is not installed on this computer. Install it: `{MOSH_LOCAL_SETUP}`"));
    }
    let target = if host.username.is_empty() { host.address.clone() } else { format!("{}@{}", host.username, host.address) };
    // remote-ip=remote: the server reports its address over the ssh session (no ProxyCommand needed).
    let mut args = vec!["--no-ssh-pty".to_string(), "--experimental-remote-ip=remote".into(), format!("--ssh={}", files::bridge_shell(&host.id)?)];
    if let Ok(server) = std::env::var("KERMIUS_MOSH_SERVER") {
        args.push(format!("--server={server}"));
    }
    args.push(target);
    let _ = on_status.send(ssh::Status::Log { message: format!("Starting mosh {}", args.join(" ")) });
    local::spawn_program("mosh", &args, cols, rows, on_data, on_status, flow)
}

#[cfg(desktop)]
const MOSH_LOCAL_SETUP: &str = if cfg!(target_os = "macos") { "brew install mosh" } else { "sudo apt install mosh" };

#[tauri::command]
fn serial_ports() -> Vec<String> {
    #[cfg(desktop)]
    return proto::serial_ports();
    #[cfg(not(desktop))]
    Vec::new()
}

/// Newest release if it is newer than this app (None when up to date).
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Res<Option<update::UpdateInfo>> {
    update::check(&app).await
}

/// Desktop: download, install and restart.
#[tauri::command]
async fn update_install(app: tauri::AppHandle, on_progress: Channel<(u64, u64)>) -> Res<()> {
    update::install(&app, on_progress).await
}

/// Open a link in the system browser (phones download the APK there).
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://github.com/datlt4/Kermius/") {
        return Err("Only Kermius release links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(e)
}

/// Whether Kermius starts when the user logs in.
#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        return app.autolaunch().is_enabled().unwrap_or(false);
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Res<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let a = app.autolaunch();
        return if enabled { a.enable() } else { a.disable() }.map_err(e);
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Err("Not available on this platform".into())
    }
}

/// Shell command that grants serial port access (empty where none is needed or already done).
#[tauri::command]
fn serial_setup_command() -> String {
    if !cfg!(target_os = "linux") {
        return String::new();
    }
    // Group lists of this process (a fresh login is needed after usermod anyway).
    let groups = std::process::Command::new("id").arg("-nG").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    if groups.split_whitespace().any(|g| g == "dialout" || g == "uucp") { String::new() } else { proto::SERIAL_SETUP.into() }
}

/// Open a raw TCP stream to a VNC host for noVNC; data flows through `on_data` / `session_write`.
#[tauri::command]
async fn vnc_open(state: State<'_, AppState>, host_id: String, on_data: Channel<InvokeResponseBody>, on_status: Channel<ssh::Status>) -> Res<String> {
    let host = state.host(&host_id)?;
    let tx = proto::open_tcp(host, 5900, on_data, on_status).await?;
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().insert(sid.clone(), (tx, Arc::new(ssh::Flow::default())));
    Ok(sid)
}

/// The VNC password for noVNC's authentication (VNC passwords cannot be kept from the client).
#[tauri::command]
fn vnc_password(state: State<AppState>, host_id: String) -> Res<String> {
    Ok(state.host(&host_id)?.password)
}

/// Binary write to a session (VNC client messages: small, so JSON is fine).
#[tauri::command]
fn session_write(state: State<AppState>, sid: String, data: Vec<u8>) {
    send_cmd(&state, &sid, ssh::Cmd::Data(data));
}

/// The UI listens for `kermius-launch` now; returns requests that came before.
#[tauri::command]
fn launch_ready(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    #[cfg(desktop)]
    return launch::ready(&app).into_iter().filter_map(|l| serde_json::to_value(l).ok()).collect();
    #[cfg(not(desktop))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
fn local_open(
    state: State<AppState>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<ssh::Status>,
    cwd: Option<String>,
) -> Res<String> {
    #[cfg(target_os = "ios")]
    return Err("Local terminal is not available on iOS".into());
    #[cfg(not(target_os = "ios"))]
    {
        let flow = Arc::new(ssh::Flow::default());
        let tx = local::spawn(cols, rows, on_data, on_status, flow.clone(), cwd)?;
        let sid = uuid::Uuid::new_v4().to_string();
        state.sessions.lock().insert(sid.clone(), (tx, flow));
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
    if let Some((tx, _)) = state.sessions.lock().get(sid) {
        let _ = tx.send(cmd);
    }
}

#[tauri::command]
fn ssh_write(state: State<AppState>, sid: String, data: String) {
    send_cmd(&state, &sid, ssh::Cmd::Data(data.into_bytes()));
}

async fn upload_to_session(state: &AppState, sid: &str, ext: &str, data: Vec<u8>) -> Res<String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    let tx = state.sessions.lock().get(sid).map(|(tx, _)| tx.clone()).ok_or("Session not found")?;
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

/// Clipboard image encoded as PNG.
#[cfg(desktop)]
fn clipboard_png(app: &tauri::AppHandle) -> Res<Vec<u8>> {
    let img = app.clipboard().read_image().map_err(|_| "No image in the clipboard".to_string())?;
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, img.width(), img.height());
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().and_then(|mut w| w.write_image_data(img.rgba())).map_err(e)?;
    }
    Ok(png_bytes)
}

/// Upload the clipboard image (as PNG) to the session's host.
#[tauri::command]
async fn ssh_paste_image(app: tauri::AppHandle, state: State<'_, AppState>, sid: String) -> Res<String> {
    #[cfg(desktop)]
    return upload_to_session(&state, &sid, "png", with_clipboard(app, clipboard_png).await?).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, sid);
        Err("Not available on mobile".into())
    }
}

/// Save the clipboard image to the local temp dir (for local terminals); returns its path.
#[tauri::command]
async fn save_clipboard_image(app: tauri::AppHandle) -> Res<String> {
    #[cfg(desktop)]
    {
        let png = with_clipboard(app, clipboard_png).await?;
        let dir = std::env::temp_dir().join("kermius-images");
        std::fs::create_dir_all(&dir).map_err(e)?;
        let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, png).map_err(e)?;
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("Not available on mobile".into())
    }
}

/// Whether a host (incl. its identity) has a password to type.
#[tauri::command]
fn host_has_password(state: State<AppState>, host_id: String) -> bool {
    state.host(&host_id).map(|h| !h.password.is_empty()).unwrap_or(false)
}

/// Type the host's password into the session (e.g. at a sudo prompt) without exposing it to the UI.
#[tauri::command]
fn ssh_send_password(state: State<AppState>, sid: String, host_id: String) -> Res<()> {
    let password = state.host(&host_id)?.password;
    if password.is_empty() {
        return Err("This host has no password".into());
    }
    send_cmd(&state, &sid, ssh::Cmd::Data(password.into_bytes()));
    Ok(())
}

#[tauri::command]
fn local_has_password(state: State<AppState>) -> bool {
    !state.store.state.lock().local_password.is_empty()
}

#[tauri::command]
fn local_set_password(state: State<AppState>, password: String) -> Res<()> {
    state.store.state.lock().local_password = password;
    state.store.save().map_err(e)
}

/// Type this computer's saved password into a local terminal (e.g. at a sudo prompt).
#[tauri::command]
fn local_send_password(state: State<AppState>, sid: String) -> Res<()> {
    let password = state.store.state.lock().local_password.clone();
    if password.is_empty() {
        return Err("No local password saved".into());
    }
    send_cmd(&state, &sid, ssh::Cmd::Data(password.into_bytes()));
    Ok(())
}

/// The UI rendered `bytes` of terminal output (flow control).
#[tauri::command]
fn term_ack(state: State<AppState>, sid: String, bytes: u64) {
    if let Some((_, flow)) = state.sessions.lock().get(&sid) {
        flow.ack(bytes);
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

#[tauri::command]
async fn sftp_open(state: State<'_, AppState>, host_id: String) -> Res<String> {
    let host = state.host(&host_id)?;
    state.files.open(state.store.clone(), host).await
}

#[tauri::command]
fn sftp_close(state: State<AppState>, id: String) {
    state.files.close(&id);
}

#[tauri::command]
async fn sftp_home(state: State<'_, AppState>, id: String) -> Res<String> {
    state.files.home(&id).await
}

#[tauri::command]
async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> Res<Vec<files::Entry>> {
    state.files.list(&id, &path).await
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Res<()> {
    state.files.mkdir(&id, &path).await
}

#[tauri::command]
async fn sftp_rename(state: State<'_, AppState>, id: String, from: String, to: String) -> Res<()> {
    state.files.rename(&id, &from, &to).await
}

#[tauri::command]
async fn sftp_remove(state: State<'_, AppState>, id: String, path: String) -> Res<()> {
    state.files.remove(&id, &path).await
}

#[tauri::command]
fn local_home() -> String {
    files::local_home()
}

#[tauri::command]
async fn local_list(path: String) -> Res<Vec<files::Entry>> {
    tauri::async_runtime::spawn_blocking(move || files::local_list(&path)).await.map_err(e)?
}

#[tauri::command]
fn local_mkdir(path: String) -> Res<()> {
    files::local_mkdir(&path)
}

#[tauri::command]
fn local_rename(from: String, to: String) -> Res<()> {
    files::local_rename(&from, &to)
}

#[tauri::command]
fn local_remove(path: String) -> Res<()> {
    files::local_remove(&path)
}

#[tauri::command]
fn rsync_available() -> bool {
    files::rsync_available()
}

#[tauri::command]
fn transfer_start(
    state: State<AppState>,
    id: String,
    direction: files::Direction,
    mode: files::Mode,
    sources: Vec<String>,
    dest: String,
    on_event: Channel<files::Event>,
) -> Res<String> {
    state.files.transfer(&id, direction, mode, sources, dest, on_event)
}

#[tauri::command]
fn transfer_cancel(state: State<AppState>, tid: String) {
    state.files.cancel(&tid);
}

#[tauri::command]
fn fsync_list(state: State<AppState>) -> Vec<foldersync::Job> {
    state.store.state.lock().folder_syncs.clone()
}

#[tauri::command]
fn fsync_save(app: tauri::AppHandle, state: State<AppState>, mut job: foldersync::Job) -> Res<foldersync::Job> {
    foldersync::validate(&job)?;
    if job.id.is_empty() {
        job.id = uuid::Uuid::new_v4().to_string();
    }
    {
        let mut st = state.store.state.lock();
        match st.folder_syncs.iter_mut().find(|j| j.id == job.id) {
            Some(old) => {
                // Different folders or mode: the old two-way state no longer applies.
                // Only a different folder pair or mode invalidates sync state (renaming or reordering routes does not).
                let same_folders = |x: &foldersync::Job, y: &foldersync::Job| {
                    x.mode == y.mode && x.a.kind == y.a.kind && x.a.path == y.a.path && x.b.kind == y.b.kind && x.b.path == y.b.path
                };
                if !same_folders(old, &job) {
                    foldersync::forget_state(&state.store, &job.id);
                    job.last_run = 0;
                }
                *old = job.clone();
            }
            None => st.folder_syncs.push(job.clone()),
        }
    }
    state.store.save().map_err(e)?;
    state.watchers.restart(&app);
    Ok(job)
}

#[tauri::command]
fn fsync_delete(app: tauri::AppHandle, state: State<AppState>, id: String) -> Res<()> {
    state.store.state.lock().folder_syncs.retain(|j| j.id != id);
    foldersync::forget_state(&state.store, &id);
    state.store.save().map_err(e)?;
    state.watchers.restart(&app);
    Ok(())
}

#[derive(serde::Serialize)]
struct SyncOutcome {
    summary: String,
    plan: foldersync::Plan,
}

#[derive(Clone, serde::Serialize)]
struct FsyncEvent {
    id: String,
    #[serde(flatten)]
    event: foldersync::Event,
}

pub(crate) fn emit_fsync(app: &tauri::AppHandle, id: &str, event: foldersync::Event) {
    use tauri::Emitter;
    let _ = app.emit("fsync", FsyncEvent { id: id.to_string(), event });
}

/// Run or preview a Folder Sync job; progress goes out as global `fsync` events.
/// `only`: paths the watchers saw change (relative to the job folders); None = full run.
pub(crate) async fn run_job(app: tauri::AppHandle, id: String, dry_run: bool, only: Option<Vec<String>>) -> Res<SyncOutcome> {
    let state = app.state::<AppState>();
    let job = state.store.state.lock().folder_syncs.iter().find(|j| j.id == id).cloned().ok_or("Job not found")?;
    if !state.running_syncs.lock().insert(id.clone()) {
        return Err("Already running".into());
    }
    let (a, i) = (app.clone(), id.clone());
    let emit: foldersync::Emit = Arc::new(move |ev| emit_fsync(&a, &i, ev));
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    state.sync_stops.lock().insert(id.clone(), stop_tx);
    // Dropping the run future kills rsync; its --partial-dir keeps progress for the next run.
    let result = tokio::select! {
        r = async {
            match only {
                Some(paths) if !dry_run => foldersync::run_paths(state.store.clone(), job, paths, emit).await,
                _ => foldersync::run(state.store.clone(), job, dry_run, emit).await,
            }
        } => r,
        _ = stop_rx => Err("Stopped".to_string()),
    };
    state.sync_stops.lock().remove(&id);
    state.running_syncs.lock().remove(&id);
    if !dry_run {
        {
            let mut st = state.store.state.lock();
            if let Some(j) = st.folder_syncs.iter_mut().find(|j| j.id == id) {
                j.last_attempt = now_ms();
                j.last_result = match &result {
                    Ok((s, _)) => s.clone(),
                    Err(err) => err.clone(),
                };
                if let Ok((_, plan)) = &result {
                    j.last_run = now_ms();
                    j.conflicts = plan.open_conflicts;
                }
                if let Ok((_, Plan { stats: Some((a, b)), .. })) = &result {
                    (j.stats_a, j.stats_b) = (*a, *b);
                }
            }
        }
        state.store.save().map_err(e)?;
    }
    let (ok, summary) = match &result {
        Ok((s, _)) => (true, s.clone()),
        Err(err) => (false, err.clone()),
    };
    emit_fsync(&app, &id, foldersync::Event::Finished { ok, summary });
    result.map(|(summary, plan)| SyncOutcome { summary, plan })
}

#[tauri::command]
async fn fsync_run(app: tauri::AppHandle, id: String, dry_run: bool) -> Res<SyncOutcome> {
    run_job(app, id, dry_run, None).await
}

fn fsync_job(state: &AppState, id: &str) -> Res<foldersync::Job> {
    state.store.state.lock().folder_syncs.iter().find(|j| j.id == id).cloned().ok_or_else(|| "Job not found".into())
}

#[tauri::command]
async fn fsync_conflicts(state: State<'_, AppState>, id: String) -> Res<Vec<foldersync::Conflict>> {
    let job = fsync_job(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || foldersync::list_conflicts(&job)).await.map_err(e)?
}

#[tauri::command]
fn fsync_read(state: State<AppState>, id: String, path: String) -> Res<String> {
    foldersync::read_text(&fsync_job(&state, &id)?, &path)
}

/// Resolve one conflict copy, then sync so the result reaches the other side.
#[tauri::command]
fn fsync_resolve(app: tauri::AppHandle, state: State<AppState>, id: String, path: String, action: String, merged: Option<String>) -> Res<()> {
    foldersync::resolve(&fsync_job(&state, &id)?, &path, &action, merged)?;
    tauri::async_runtime::spawn(async move {
        let _ = run_job(app, id, false, None).await;
    });
    Ok(())
}

/// Stop a running sync (no-op if idle).
#[tauri::command]
fn fsync_stop(state: State<AppState>, id: String) {
    if let Some(tx) = state.sync_stops.lock().remove(&id) {
        let _ = tx.send(());
    }
}

#[tauri::command]
fn fsync_pause(app: tauri::AppHandle, state: State<AppState>, ids: Vec<String>, paused: bool) -> Res<()> {
    for j in state.store.state.lock().folder_syncs.iter_mut().filter(|j| ids.contains(&j.id)) {
        j.paused = paused;
    }
    if paused {
        for id in &ids {
            if let Some(tx) = state.sync_stops.lock().remove(id) {
                let _ = tx.send(());
            }
        }
    }
    state.store.save().map_err(e)?;
    state.watchers.restart(&app);
    Ok(())
}

const INOTIFY_CONF: &str = "fs.inotify.max_user_watches=1048576\nfs.inotify.max_user_instances=1024\n";
/// Sorts after 99-sysctl.conf (= /etc/sysctl.conf), so a lower value there cannot override it at boot.
const INOTIFY_FILE: &str = "/etc/sysctl.d/99-zz-kermius-inotify.conf";

/// Shell that persists and applies higher inotify limits (run as root).
fn inotify_fix_script() -> String {
    // printf gets "\n" escapes so the command stays on one line when pasted.
    let conf = INOTIFY_CONF.replace('\n', "\\n");
    format!("rm -f /etc/sysctl.d/90-kermius-inotify.conf; printf '{conf}' > {INOTIFY_FILE} && sysctl -p {INOTIFY_FILE}")
}

/// The same fix as a command a user can paste into a terminal (sudo asks for the password).
#[tauri::command]
fn fsync_inotify_command() -> String {
    format!("sudo sh -c {}", foldersync::sh(&inotify_fix_script()))
}

/// Raise the local inotify limits (asks for the admin password via polkit), then restart watchers.
#[tauri::command]
async fn fsync_raise_inotify(app: tauri::AppHandle) -> Res<()> {
    let out = tokio::process::Command::new("pkexec").args(["sh", "-c", &inotify_fix_script()]).output().await.map_err(|err| {
        format!("pkexec not available ({err}); run: echo -e '{INOTIFY_CONF}' | sudo tee {INOTIFY_FILE} && sudo sysctl -p {INOTIFY_FILE}")
    })?;
    if !out.status.success() {
        return Err(format!("Not changed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    app.state::<AppState>().watchers.restart(&app);
    Ok(())
}

/// Raise inotify limits on a remote with `sudo` and the host's stored password.
#[tauri::command]
async fn fsync_raise_inotify_remote(app: tauri::AppHandle, state: State<'_, AppState>, host_id: String) -> Res<()> {
    let host = state.host(&host_id)?;
    if host.password.is_empty() {
        return Err(format!("No password stored for {}; run on the remote: sudo sh -c \"{}\"", host.name, inotify_fix_script()));
    }
    let handle = ssh::connect(state.store.clone(), &host, ssh::no_log()).await?;
    let mut ch = handle.channel_open_session().await.map_err(e)?;
    ch.exec(true, format!("sudo -S -p '' sh -c {}", foldersync::sh(&inotify_fix_script()))).await.map_err(e)?;
    ch.data_bytes(format!("{}\n", host.password).into_bytes()).await.map_err(e)?;
    ch.eof().await.map_err(e)?;
    let (mut code, mut err) = (1, Vec::new());
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            russh::ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
            _ => {}
        }
    }
    if code != 0 {
        return Err(format!("sudo failed on {}: {}", host.name, String::from_utf8_lossy(&err).trim()));
    }
    state.watchers.restart(&app);
    Ok(())
}

#[tauri::command]
fn fsync_import_stignore(dir: String) -> Res<(Vec<String>, usize)> {
    foldersync::import_stignore(&dir)
}

/// Current watcher states, for UIs opened after the watchers started.
#[tauri::command]
fn fsync_watch_states(state: State<AppState>) -> HashMap<String, (String, String)> {
    state.watchers.states()
}

fn cli_store() -> anyhow::Result<Store> {
    Store::open(dirs::data_dir().ok_or_else(|| anyhow::anyhow!("no data dir"))?.join(IDENTIFIER))
}

/// `kermius --ssh-bridge <host id> <host> <command...>`: remote shell for rsync. Returns the exit code.
pub fn cli_ssh_bridge(args: &[String]) -> i32 {
    let run = || -> Result<u32, String> {
        // `<ssh> [flags] host [--] command…` as called by rsync or mosh (-n, -tt, -4/-6; -o/-S/-l/-p take a value).
        let [id, rest @ ..] = args else { return Err("usage: --ssh-bridge <host id> <host> <command>".into()) };
        let mut i = 0;
        while i < rest.len() && rest[i].starts_with('-') && rest[i] != "--" {
            i += if ["-o", "-S", "-l", "-p"].contains(&rest[i].as_str()) { 2 } else { 1 };
        }
        let mut command = rest.get(i + 1..).unwrap_or_default();
        if command.first().is_some_and(|c| c == "--") {
            command = &command[1..];
        }
        let store = Arc::new(cli_store().map_err(e)?);
        let host = {
            let st = store.state.lock();
            let h = st.vault.hosts.iter().find(|h| &h.id == id && !h.deleted).cloned().ok_or("Host not found")?;
            st.vault.resolve(h)
        };
        tauri::async_runtime::block_on(files::ssh_bridge(store, host, command.join(" ")))
    };
    match run() {
        Ok(code) => code as i32,
        Err(err) => {
            eprintln!("kermius: {err}");
            255
        }
    }
}

/// `kermius --run-sync <job id>`: run a Folder Sync job headless (also handy for cron).
pub fn cli_run_sync(id: &str) -> i32 {
    let run = || -> Result<String, String> {
        let store = Arc::new(cli_store().map_err(e)?);
        let job = store.state.lock().folder_syncs.iter().find(|j| j.id == id).cloned().ok_or("Job not found")?;
        let emit: foldersync::Emit = Arc::new(|ev| match ev {
            foldersync::Event::Phase { phase, message } => eprintln!("{phase} {message}"),
            foldersync::Event::Scan { side, files, dirs, .. } => eprint!("\rscanning {side}: {files} files, {dirs} folders"),
            foldersync::Event::Progress { done, total, rate, .. } => eprint!("\r{done}/{total} bytes, {rate} B/s"),
            _ => {}
        });
        let (summary, _) = tauri::async_runtime::block_on(foldersync::run(store, job, false, emit))?;
        Ok(summary)
    };
    match run() {
        Ok(s) => {
            println!("{s}");
            0
        }
        Err(err) => {
            eprintln!("kermius: {err}");
            1
        }
    }
}

/// `kermius --import-termix <file>`: import without opening the UI.
pub fn cli_import(path: &str) -> anyhow::Result<String> {
    let store = cli_store()?;
    let json = std::fs::read_to_string(path)?;
    let report = termix::import(&mut store.state.lock().vault, &json)?;
    store.save()?;
    Ok(format!("Imported from {path}: {} added, {} updated", report.added, report.updated))
}

/// iOS: WKWebView's scroll view shrinks the page by the safe areas (CSS already pads them,
/// leaving a gap) and scrolls it up under the status bar when the keyboard opens; the page
/// sizes itself to the visual viewport instead.
#[cfg(target_os = "ios")]
fn ios_fix_webview(webview: tauri::webview::PlatformWebview) {
    use objc2::{msg_send, runtime::AnyObject};
    unsafe {
        let wk = webview.inner() as *mut AnyObject;
        let scroll: *mut AnyObject = msg_send![wk, scrollView];
        // UIScrollViewContentInsetAdjustmentNever
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
        let _: () = msg_send![scroll, setScrollEnabled: false];
        let _: () = msg_send![scroll, setBounces: false];
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First: a second `kermius …` (or a kermius:// link) hands its request to this instance and exits.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            launch::handle(app, launch::from_args(&argv, std::path::Path::new(&cwd)), true);
        }))
        .plugin(tauri_plugin_deep_link::init());
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))?;
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_fs::init())?;
            #[cfg(target_os = "ios")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(ios_fix_webview);
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.manage(launch::Pending::default());
                let args: Vec<String> = std::env::args().collect();
                launch::handle(app.handle(), launch::from_args(&args, &std::env::current_dir().unwrap_or_default()), false);
                // Installed packages register kermius:// themselves; this covers AppImage and portable builds.
                #[cfg(any(target_os = "linux", windows))]
                let _ = app.deep_link().register_all();
                let h = app.handle().clone();
                app.deep_link().on_open_url(move |ev| {
                    launch::handle(&h, ev.urls().iter().filter_map(|u| launch::from_url(u.as_str())).collect(), true);
                });
            }
            app.manage(nearby::Nearby::new(app.handle().clone()));
            let store = Store::open(app.path().app_data_dir()?)?;
            app.manage(AppState {
                store: Arc::new(store),
                sessions: Default::default(),
                tunnels: Default::default(),
                files: Default::default(),
                running_syncs: Default::default(),
                sync_stops: Default::default(),
                watchers: Default::default(),
            });
            app.state::<AppState>().watchers.restart(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts,
            save_host,
            delete_host,
            import_termix,
            ssh_config_preview,
            ssh_test,
            wol_list,
            wol_save,
            wol_delete,
            wol_send,
            nearby_status,
            nearby_start,
            nearby_stop,
            nearby_refresh,
            nearby_send,
            nearby_probe,
            nearby_respond,
            nearby_cancel,
            nearby_open_folder,
            nearby_set_dir,
            nearby_set_alias,
            ssh_config_export,
            ssh_config_import,
            list_snippets,
            save_snippet,
            delete_snippet,
            list_keys,
            save_key,
            delete_key,
            list_identities,
            save_identity,
            delete_identity,
            key_info,
            generate_key,
            copy_password,
            clipboard_write,
            clipboard_read,
            ssh_connect,
            local_open,
            launch_ready,
            list_fonts,
            ssh_write,
            ssh_upload,
            ssh_paste_image,
            save_clipboard_image,
            ssh_resize,
            term_ack,
            host_has_password,
            ssh_send_password,
            local_has_password,
            serial_ports,
            autostart_get,
            update_check,
            update_install,
            open_url,
            autostart_set,
            serial_setup_command,
            vnc_open,
            vnc_password,
            session_write,
            local_set_password,
            local_send_password,
            ssh_close,
            trust_new_host_key,
            tunnel_start,
            tunnel_stop,
            tunnel_list,
            get_sync_settings,
            set_sync_settings,
            sync_now,
            sftp_open,
            sftp_close,
            sftp_home,
            sftp_list,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            local_home,
            local_list,
            local_mkdir,
            local_rename,
            local_remove,
            rsync_available,
            transfer_start,
            transfer_cancel,
            fsync_list,
            fsync_save,
            fsync_delete,
            fsync_run,
            fsync_watch_states,
            fsync_import_stignore,
            fsync_pause,
            fsync_stop,
            fsync_raise_inotify,
            fsync_inotify_command,
            fsync_raise_inotify_remote,
            fsync_conflicts,
            fsync_read,
            fsync_resolve,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kermius");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_roundtrips() {
        let pem = generate_key("me@kermius".into()).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let info = key_info(pem, String::new()).unwrap();
        assert!(info.public_key.starts_with("ssh-ed25519 ") && info.public_key.ends_with("me@kermius"));
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert!(key_info("garbage".into(), String::new()).is_err());
    }
}
