mod crypto;
mod files;
mod foldersync;
mod watch;
#[cfg(not(target_os = "ios"))]
mod local;
mod model;
mod ssh;
mod sshconfig;
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

/// Write the hosts into `~/.ssh/config` (Kermius block) and their keys into `~/.ssh/kermius/`.
#[tauri::command]
fn ssh_config_export(state: State<AppState>, host_ids: Vec<String>, with_keys: bool, with_passwords: bool) -> Res<String> {
    let ex = sshconfig::render(&state.store.state.lock().vault, &host_ids, with_keys, with_passwords);
    let home = dirs::home_dir().ok_or("No home folder")?;
    sshconfig::write(&home.join(".ssh"), &ex).map_err(e)
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
    let flow = Arc::new(ssh::Flow::default());
    let tx = ssh::spawn_shell(state.store.clone(), host, cols, rows, on_data, on_status, flow.clone());
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().insert(sid.clone(), (tx, flow));
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
        let flow = Arc::new(ssh::Flow::default());
        let tx = local::spawn(cols, rows, on_data, on_status, flow.clone())?;
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
    return upload_to_session(&state, &sid, "png", clipboard_png(&app)?).await;
    #[cfg(mobile)]
    {
        let _ = (app, state, sid);
        Err("Not available on mobile".into())
    }
}

/// Save the clipboard image to the local temp dir (for local terminals); returns its path.
#[tauri::command]
fn save_clipboard_image(app: tauri::AppHandle) -> Res<String> {
    #[cfg(desktop)]
    {
        let dir = std::env::temp_dir().join("kermius-images");
        std::fs::create_dir_all(&dir).map_err(e)?;
        let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, clipboard_png(&app)?).map_err(e)?;
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
pub(crate) async fn run_job(app: tauri::AppHandle, id: String, dry_run: bool) -> Res<SyncOutcome> {
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
        r = foldersync::run(state.store.clone(), job, dry_run, emit) => r,
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
    run_job(app, id, dry_run).await
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
        let _ = run_job(app, id, false).await;
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
        let [id, _host, command @ ..] = args else { return Err("usage: --ssh-bridge <host id> <host> <command>".into()) };
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            ssh_config_export,
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
