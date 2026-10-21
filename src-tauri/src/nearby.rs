//! Nearby file sharing over the LocalSend v2 protocol (works with the LocalSend apps).
//! Discovery: JSON over UDP multicast 224.0.0.167:53317; transfer: REST over HTTP.

use axum::{
    body::Body,
    extract::{ConnectInfo, Query, State as AxState},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const PORT: u16 = 53317;
const GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const API: &str = "/api/localsend/v2";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub alias: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default)]
    pub download: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announce: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub fingerprint: String,
    pub alias: String,
    pub device_model: String,
    pub device_type: String,
    pub ip: String,
    pub port: u16,
    pub https: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    session_id: String,
    files: HashMap<String, String>,
}

type Progress = Arc<Mutex<(Instant, Transfer)>>;

/// What a sent file is read from.
enum Source {
    Path(PathBuf),
    /// A text message (LocalSend shows it instead of saving a file).
    Text(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    id: String,
    file_name: String,
    size: u64,
    #[serde(default)]
    file_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub alias: String,
    pub port: u16,
    pub dir: String,
    pub devices: Vec<Device>,
    pub error: String,
    /// Other devices answered our announcement by UDP because they could not connect here
    /// (and none ever did): a firewall blocks the port.
    pub blocked: bool,
    /// Command opening the port in this computer's firewall ("" = unknown firewall).
    pub firewall: String,
    /// This device's addresses and host names: saved hosts pointing here are not shown.
    pub own: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub peer: String,
    pub incoming: bool,
    pub files: usize,
    pub total: u64,
    pub done: u64,
    /// waiting | active | done | declined | failed | cancelled
    pub state: String,
    pub error: String,
    /// Incoming: the folder the files were saved to.
    pub dir: String,
    /// Unix ms of the last change (set on every emit; for a received transfer, when it finished).
    pub at: i64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Event {
    Devices { devices: Vec<Device> },
    Request { id: String, alias: String, files: Vec<(String, u64)>, count: usize, total: u64 },
    Message { alias: String, text: String },
    RequestGone { id: String },
    Transfer(Transfer),
}

struct Session {
    id: String,
    dir: PathBuf,
    ip: IpAddr,
    files: HashMap<String, (String, FileMeta)>,
    received: usize,
    transfer: Transfer,
    done: Arc<AtomicU64>,
    last_emit: Instant,
}

pub struct Nearby {
    app: AppHandle,
    client: reqwest::Client,
    fingerprint: String,
    /// Name shown to other devices (default: the host name).
    alias: Mutex<String>,
    port: Mutex<u16>,
    running: Mutex<Option<CancellationToken>>,
    firewall: Mutex<String>,
    /// A device on the network connected to our HTTP server.
    inbound: std::sync::atomic::AtomicBool,
    /// UDP answers to our announcement: sent by devices that could not connect to us.
    udp_replies: std::sync::atomic::AtomicUsize,
    /// Devices that tried to connect back to us and failed: "ip:port" → when.
    reach_blocked: Mutex<HashMap<String, Instant>>,
    /// Last time we asked a device to try connecting back to us: "ip:port" → when.
    reach_checked: Mutex<HashMap<String, Instant>>,
    /// Where received files go; None = the Downloads folder.
    save_dir: Mutex<Option<PathBuf>>,
    udp: Mutex<Option<Arc<tokio::net::UdpSocket>>>,
    error: Mutex<String>,
    devices: Mutex<HashMap<String, Device>>,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    session: Mutex<Option<Session>>,
    sends: Mutex<HashMap<String, CancellationToken>>,
}

fn hostname() -> String {
    // Android's hostname is always "localhost": use the phone's make and model.
    #[cfg(target_os = "android")]
    {
        let prop = |k: &str| {
            std::process::Command::new("getprop").arg(k).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|v| !v.is_empty())
        };
        if let Some(model) = prop("ro.product.model") {
            let make = prop("ro.product.manufacturer").unwrap_or_default();
            if make.is_empty() || model.to_lowercase().starts_with(&make.to_lowercase()) {
                return model;
            }
            let mut c = make.chars();
            return format!("{}{} {model}", c.next().map(|f| f.to_uppercase().to_string()).unwrap_or_default(), c.as_str());
        }
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            if let Ok(s) = std::str::from_utf8(&buf[..end]) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    // iOS also reports "localhost".
    if cfg!(target_os = "ios") {
        return "iPhone".into();
    }
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Kermius".into())
}

/// Linux firewalls (ufw, firewalld) drop incoming connections unless the port is opened;
/// discovery still works outward, so the other side sees us but cannot connect.
fn firewall_hint(port: u16) -> String {
    let active = |unit: &str| {
        std::process::Command::new("systemctl").args(["is-active", "--quiet", unit]).status().is_ok_and(|s| s.success())
    };
    if cfg!(target_os = "windows") {
        // Run in PowerShell as administrator.
        return format!("New-NetFirewallRule -DisplayName 'Kermius Nearby Share' -Direction Inbound -Protocol TCP -LocalPort {port} -Action Allow");
    }
    if cfg!(target_os = "macos") {
        // The macOS firewall allows apps, not ports: allow the Kermius app itself.
        let app = std::env::current_exe().ok().and_then(|exe| exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf()));
        return match app {
            Some(app) => {
                let fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
                let app = app.display();
                format!("sudo {fw} --add '{app}' && sudo {fw} --unblockapp '{app}'")
            }
            None => String::new(),
        };
    }
    if !cfg!(target_os = "linux") {
        String::new()
    } else if std::fs::read_to_string("/etc/ufw/ufw.conf").is_ok_and(|c| c.lines().any(|l| l.trim() == "ENABLED=yes")) {
        // Not `systemctl is-active ufw`: that unit stays "active" while ufw is disabled.
        format!("sudo ufw allow {port} comment 'Kermius Nearby Share'")
    } else if active("firewalld") {
        format!("sudo firewall-cmd --permanent --add-port={port}/tcp --add-port={port}/udp && sudo firewall-cmd --reload")
    } else {
        String::new()
    }
}

fn download_dir() -> PathBuf {
    // iOS: the app's Documents folder, shown in the Files app (UIFileSharingEnabled).
    if cfg!(target_os = "ios") {
        let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents");
        let _ = std::fs::create_dir_all(&dir);
        return dir;
    }
    // Android 11+ lets apps create files in the shared Download folder; Android 10 and older
    // need the storage permission (asked at start), else the app's own folder is used.
    if cfg!(target_os = "android") {
        // Remember success only: the permission may be granted after the first check.
        static SHARED_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let shared = PathBuf::from("/storage/emulated/0/Download");
        if SHARED_OK.load(Ordering::Relaxed) {
            return shared;
        }
        let probe = shared.join(format!(".kermius-{}", uuid::Uuid::new_v4()));
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            SHARED_OK.store(true, Ordering::Relaxed);
            return shared;
        }
        let own = PathBuf::from("/storage/emulated/0/Android/data/com.koi.kermius/files/Download");
        let _ = std::fs::create_dir_all(&own);
        return own;
    }
    dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir)
}

/// File name from the sender, kept inside `dir` (folders allowed, no `..` or absolute paths);
/// an existing file gets a " (n)" suffix.
fn target_path(dir: &Path, name: &str) -> PathBuf {
    let parts: Vec<&str> = name.split(['/', '\\']).filter(|p| !p.is_empty() && *p != "." && *p != "..").collect();
    let rel: PathBuf = if parts.is_empty() { PathBuf::from("file") } else { parts.iter().collect() };
    let path = dir.join(rel);
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..)
        .map(|n| path.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// IPv4 addresses of the up, non-loopback interfaces (multicast is joined/sent on each).
fn local_ipv4() -> Vec<Ipv4Addr> {
    let mut out = vec![];
    #[cfg(unix)]
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) == 0 {
            let mut p = ifap;
            while !p.is_null() {
                let ifa = &*p;
                if !ifa.ifa_addr.is_null()
                    && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET
                    && ifa.ifa_flags & libc::IFF_UP as u32 != 0
                    && ifa.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
                {
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    out.push(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)));
                }
                p = ifa.ifa_next;
            }
            libc::freeifaddrs(ifap);
        }
    }
    out.dedup();
    out
}

fn udp_socket() -> std::io::Result<tokio::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // LocalSend itself may already listen on this port.
    s.set_reuse_address(true)?;
    #[cfg(all(unix, not(any(target_os = "solaris", target_os = "illumos"))))]
    s.set_reuse_port(true)?;
    s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT).into())?;
    let ifaces = local_ipv4();
    if ifaces.is_empty() {
        s.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED)?;
    }
    for ip in ifaces {
        let _ = s.join_multicast_v4(&GROUP, &ip);
    }
    s.set_multicast_loop_v4(true)?;
    s.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(s.into())
}

/// "error sending request" alone hides the cause (refused, TLS, timeout…).
fn err_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(c) = src {
        out = format!("{out}: {c}");
        src = c.source();
    }
    out
}

/// Self-signed certificate: LocalSend's HTTPS servers require a client certificate,
/// and its SHA-256 is the device fingerprint.
fn http_client() -> (reqwest::Client, String) {
    use sha2::Digest;
    let ck = rcgen::generate_simple_self_signed(vec!["LocalSend User".into()]).expect("certificate");
    let fingerprint = sha2::Sha256::digest(ck.cert.der()).iter().map(|b| format!("{b:02x}")).collect();
    let pem = format!("{}{}", ck.signing_key.serialize_pem(), ck.cert.pem());
    let client = reqwest::Client::builder()
        // Peers use self-signed certificates.
        .danger_accept_invalid_certs(true)
        .identity(reqwest::Identity::from_pem(pem.as_bytes()).expect("identity"))
        .build()
        .unwrap();
    (client, fingerprint)
}

fn base_url(d: &Device) -> String {
    let host = if d.ip.contains(':') { format!("[{}]", d.ip) } else { d.ip.clone() };
    format!("{}://{}:{}{API}", if d.https { "https" } else { "http" }, host, d.port)
}

impl Nearby {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let (client, fingerprint) = http_client();
        Arc::new(Self {
            app,
            client,
            fingerprint,
            alias: Mutex::new(hostname()),
            port: Mutex::new(PORT),
            running: Mutex::new(None),
            firewall: Mutex::new(String::new()),
            inbound: Default::default(),
            udp_replies: Default::default(),
            reach_blocked: Default::default(),
            reach_checked: Default::default(),
            save_dir: Mutex::new(None),
            udp: Mutex::new(None),
            error: Mutex::new(String::new()),
            devices: Default::default(),
            pending: Default::default(),
            session: Default::default(),
            sends: Default::default(),
        })
    }

    fn info(&self, announce: Option<bool>) -> Info {
        let mobile = cfg!(any(target_os = "android", target_os = "ios"));
        let model = match std::env::consts::OS {
            "linux" => "Linux",
            "windows" => "Windows",
            "macos" => "macOS",
            "android" => "Android",
            "ios" => "iOS",
            o => o,
        };
        Info {
            alias: self.alias.lock().clone(),
            version: "2.1".into(),
            device_model: Some(model.into()),
            device_type: Some(if mobile { "mobile" } else { "desktop" }.into()),
            fingerprint: self.fingerprint.clone(),
            port: Some(*self.port.lock()),
            protocol: Some("http".into()),
            download: false,
            announce,
        }
    }

    fn emit(&self, mut e: Event) {
        if let Event::Transfer(t) = &mut e {
            t.at = crate::model::now_ms();
        }
        let _ = self.app.emit("nearby", e);
    }

    /// "" = back to the host name; announced again so others see the new name.
    pub fn set_alias(self: &Arc<Self>, alias: &str) {
        let alias = alias.trim();
        *self.alias.lock() = if alias.is_empty() { hostname() } else { alias.chars().take(64).collect() };
        if let Some(sock) = self.udp.lock().clone() {
            self.announce_with(sock);
        }
    }

    pub fn save_dir(&self) -> PathBuf {
        self.save_dir.lock().clone().unwrap_or_else(download_dir)
    }

    /// "" = back to the Downloads folder.
    pub fn set_save_dir(&self, dir: &str) -> Result<(), String> {
        let dir = Some(PathBuf::from(dir)).filter(|d| !d.as_os_str().is_empty());
        if let Some(d) = &dir {
            std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        *self.save_dir.lock() = dir;
        Ok(())
    }

    pub fn status(&self) -> Status {
        let mut devices: Vec<Device> = self.devices.lock().values().cloned().collect();
        devices.sort_by(|a, b| a.alias.cmp(&b.alias));
        Status {
            running: self.running.lock().is_some(),
            alias: self.alias.lock().clone(),
            port: *self.port.lock(),
            dir: self.save_dir().to_string_lossy().into_owned(),
            devices,
            error: self.error.lock().clone(),
            blocked: !self.inbound.load(Ordering::Relaxed)
                && (self.udp_replies.load(Ordering::Relaxed) > 0 || self.reach_blocked.lock().values().any(|t| t.elapsed() < Duration::from_secs(900))),
            firewall: self.firewall.lock().clone(),
            own: local_ipv4()
                .iter()
                .map(|ip| ip.to_string())
                .chain(["127.0.0.1".into(), "localhost".into(), "::1".into(), hostname(), format!("{}.local", hostname())])
                .collect(),
        }
    }

    fn add_device(&self, ip: IpAddr, info: &Info) {
        self.add_device_at(&ip.to_string(), info);
    }

    /// `ip` may also be a host name (saved hosts).
    fn add_device_at(&self, ip: &str, info: &Info) {
        if info.fingerprint == self.fingerprint {
            return;
        }
        let d = Device {
            fingerprint: info.fingerprint.clone(),
            alias: info.alias.clone(),
            device_model: info.device_model.clone().unwrap_or_default(),
            device_type: info.device_type.clone().unwrap_or_else(|| "desktop".into()),
            ip: ip.to_string(),
            port: info.port.unwrap_or(PORT),
            https: info.protocol.as_deref() != Some("http"),
        };
        let changed = {
            let mut devs = self.devices.lock();
            // HTTP-mode apps get a new fingerprint on every start: drop the old entry of a restarted app.
            devs.retain(|k, v| *k == d.fingerprint || !(v.ip == d.ip && (v.port == d.port || v.alias == d.alias)));
            let old = devs.insert(d.fingerprint.clone(), d.clone());
            old.is_none_or(|o| o.alias != d.alias || o.ip != d.ip || o.port != d.port)
        };
        if changed {
            self.emit(Event::Devices { devices: self.status().devices });
        }
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        if self.running.lock().is_some() {
            return Ok(());
        }
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await {
            Ok(l) => l,
            // Port taken (e.g. LocalSend runs here too): any port works, it is announced.
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| e.to_string())?,
        };
        *self.port.lock() = listener.local_addr().map_err(|e| e.to_string())?.port();
        *self.firewall.lock() = firewall_hint(*self.port.lock());
        self.inbound.store(false, Ordering::Relaxed);
        self.udp_replies.store(0, Ordering::Relaxed);
        // iOS blocks multicast without an Apple entitlement: then only saved addresses are reached.
        let udp = udp_socket().map(Arc::new);
        let token = CancellationToken::new();
        *self.running.lock() = Some(token.clone());
        *self.udp.lock() = udp.as_ref().ok().cloned();
        *self.error.lock() = udp.as_ref().err().map(|e| format!("Discovery unavailable: {e}")).unwrap_or_default();

        let app = Router::new()
            .route(&format!("{API}/register"), post(register))
            .route(&format!("{API}/info"), get(info))
            .route("/api/kermius/v1/reach", post(reach))
            // The file list of a big folder is far over the 2 MB default.
            .route(&format!("{API}/prepare-upload"), post(prepare_upload).layer(axum::extract::DefaultBodyLimit::max(512 << 20)))
            .route(&format!("{API}/upload"), post(upload))
            .route(&format!("{API}/cancel"), post(cancel))
            .with_state(self.clone());
        let stop = token.clone();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(stop.cancelled_owned());
            if let Err(e) = serve.await {
                *me.error.lock() = e.to_string();
            }
        });

        if let Ok(udp) = udp {
            let me = self.clone();
            let stop = token.clone();
            let sock = udp.clone();
            tauri::async_runtime::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let (n, from) = tokio::select! {
                        _ = stop.cancelled() => break,
                        r = sock.recv_from(&mut buf) => match r { Ok(r) => r, Err(_) => continue },
                    };
                    let Ok(info) = serde_json::from_slice::<Info>(&buf[..n]) else { continue };
                    if info.fingerprint == me.fingerprint {
                        continue;
                    }
                    me.add_device(from.ip(), &info);
                    if info.announce == Some(false) && me.udp_replies.fetch_add(1, Ordering::Relaxed) == 0 {
                        me.emit(Event::Devices { devices: me.status().devices });
                    }
                    if info.announce == Some(true) {
                        let me = me.clone();
                        let sock = sock.clone();
                        tauri::async_runtime::spawn(async move { me.answer(&sock, from.ip(), &info).await });
                    }
                }
            });
            self.announce_with(udp);
        }
        Ok(())
    }

    /// Another device reached our HTTP server, so the port is open.
    fn note_inbound(&self, ip: IpAddr) {
        if !ip.is_loopback() && !self.inbound.swap(true, Ordering::Relaxed) {
            self.emit(Event::Devices { devices: self.status().devices });
        }
    }

    /// Reply to an announcement: HTTP register, or a UDP multicast reply when that fails.
    async fn answer(&self, sock: &tokio::net::UdpSocket, ip: IpAddr, info: &Info) {
        let d = Device {
            fingerprint: info.fingerprint.clone(),
            alias: info.alias.clone(),
            device_model: String::new(),
            device_type: String::new(),
            ip: ip.to_string(),
            port: info.port.unwrap_or(PORT),
            https: info.protocol.as_deref() != Some("http"),
        };
        let ok = self.client
            .clone()
            .post(format!("{}/register", base_url(&d)))
            .timeout(Duration::from_secs(3))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&self.info(None)).unwrap())
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if ok {
            self.check_reach(&d).await;
        } else {
            self.multicast(sock, &self.info(Some(false))).await;
        }
    }

    async fn multicast(&self, sock: &tokio::net::UdpSocket, info: &Info) {
        let msg = serde_json::to_vec(info).unwrap();
        let to = SocketAddrV4::new(GROUP, PORT);
        let ifaces = local_ipv4();
        if ifaces.is_empty() {
            let _ = sock.send_to(&msg, to).await;
        }
        // Send out of every interface; the default route alone misses other LANs.
        let sref = socket2::SockRef::from(sock);
        for ip in ifaces {
            if sref.set_multicast_if_v4(&ip).is_ok() {
                let _ = sock.send_to(&msg, to).await;
            }
        }
    }

    fn announce_with(self: &Arc<Self>, sock: Arc<tokio::net::UdpSocket>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            for wait in [100, 400, 1500] {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                me.multicast(&sock, &me.info(Some(true))).await;
            }
        });
    }

    /// Forget known devices and ask everyone to answer again.
    pub fn refresh(self: &Arc<Self>) -> Result<(), String> {
        let sock = self.udp.lock().clone().ok_or("Nearby sharing is off")?;
        self.udp_replies.store(0, Ordering::Relaxed);
        self.devices.lock().clear();
        self.emit(Event::Devices { devices: vec![] });
        self.announce_with(sock);
        Ok(())
    }

    /// Reach saved addresses directly (multicast does not cross VPNs or routers): register
    /// with each, so both sides learn each other. Returns the devices that answered.
    pub async fn probe(&self, addresses: Vec<String>) -> Vec<Device> {
        let found: Vec<Device> = futures_util::future::join_all(addresses.into_iter().map(|a| self.probe_one(a))).await.into_iter().flatten().collect();
        futures_util::future::join_all(found.iter().map(|d| self.check_reach(d))).await;
        found
    }

    /// "Can you see me?": the device tries to connect back to us. If it cannot, a firewall here
    /// blocks the port, and the status says so. Asked at most every five minutes per device.
    async fn check_reach(&self, d: &Device) {
        let key = format!("{}:{}", d.ip, d.port);
        if self.reach_checked.lock().get(&key).is_some_and(|t| t.elapsed() < Duration::from_secs(300)) {
            return;
        }
        self.reach_checked.lock().insert(key.clone(), Instant::now());
        #[derive(Deserialize)]
        struct Reach {
            reachable: bool,
        }
        let root = base_url(d).trim_end_matches(API).to_string();
        let port = *self.port.lock();
        let Ok(r) = self
            .client
            .post(format!("{root}/api/kermius/v1/reach"))
            .timeout(Duration::from_secs(8))
            .header("content-type", "application/json")
            .body(format!("{{\"port\":{port}}}"))
            .send()
            .await
        else {
            return;
        };
        let Ok(res) = serde_json::from_str::<Reach>(&r.text().await.unwrap_or_default()) else { return };
        let before = self.reach_blocked.lock().contains_key(&key);
        if res.reachable {
            self.reach_blocked.lock().remove(&key);
        } else {
            self.reach_blocked.lock().insert(key.clone(), Instant::now());
        }
        if before == res.reachable {
            // Nothing new for the user, but the status (blocked) may have changed.
            self.emit(Event::Devices { devices: self.status().devices });
        }
    }

    async fn probe_one(&self, address: String) -> Option<Device> {
        let body = serde_json::to_vec(&self.info(None)).unwrap();
        // Kermius serves HTTP, LocalSend HTTPS by default.
        for https in [false, true] {
            let d = Device { fingerprint: String::new(), alias: String::new(), device_model: String::new(), device_type: String::new(), ip: address.clone(), port: PORT, https };
            let Ok(r) = self
                .client
                .post(format!("{}/register", base_url(&d)))
                .timeout(Duration::from_secs(3))
                .header("content-type", "application/json")
                .body(body.clone())
                .send()
                .await
            else {
                continue;
            };
            let Ok(mut info) = serde_json::from_str::<Info>(&r.text().await.unwrap_or_default()) else { continue };
            // The answer describes the peer; the protocol that worked is the one to use.
            info.port = Some(PORT);
            info.protocol = Some(if https { "https" } else { "http" }.into());
            if info.fingerprint == self.fingerprint {
                return None;
            }
            self.add_device_at(&address, &info);
            return self.devices.lock().get(&info.fingerprint).cloned();
        }
        None
    }

    pub fn stop(&self) {
        if let Some(t) = self.running.lock().take() {
            t.cancel();
        }
        self.udp.lock().take();
        self.devices.lock().clear();
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(false);
        }
    }

    pub fn respond(&self, id: &str, accept: bool) {
        if let Some(tx) = self.pending.lock().remove(id) {
            let _ = tx.send(accept);
        }
    }

    pub fn send(self: &Arc<Self>, fingerprint: &str, paths: Vec<String>, texts: Vec<String>) -> Result<String, String> {
        let dev = self.devices.lock().get(fingerprint).cloned().ok_or("Device is gone; refresh the list")?;
        let mut files = self.collect(&paths)?;
        for text in texts.into_iter().filter(|t| !t.is_empty()) {
            let id = uuid::Uuid::new_v4().to_string();
            let meta = FileMeta { file_name: format!("{id}.txt"), id, size: text.len() as u64, file_type: "text/plain".into(), sha256: None, preview: Some(text.clone()) };
            files.push((Source::Text(text), meta));
        }
        if files.is_empty() {
            return Err("Nothing to send".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.sends.lock().insert(id.clone(), token.clone());
        let me = self.clone();
        let tid = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut t = Transfer {
                id: tid.clone(),
                peer: dev.alias.clone(),
                incoming: false,
                files: files.len(),
                total: files.iter().map(|f| f.1.size).sum(),
                done: 0,
                state: "waiting".into(),
                error: String::new(),
                dir: String::new(),
                at: 0,
            };
            me.emit(Event::Transfer(t.clone()));
            let session = Arc::new(Mutex::new(None::<String>));
            let result = tokio::select! {
                r = me.send_files(&dev, &files, &mut t, session.clone()) => r,
                _ = token.cancelled() => {
                    if let Some(sid) = session.lock().clone() {
                        let url = format!("{}/cancel?sessionId={sid}", base_url(&dev));
                        let c = me.client.clone();
                        tauri::async_runtime::spawn(async move { let _ = c.post(url).timeout(Duration::from_secs(3)).send().await; });
                    }
                    Err("cancelled".into())
                }
            };
            match result {
                Ok(state) => t.state = state,
                Err(e) if e == "cancelled" => t.state = e,
                Err(e) => {
                    t.state = "failed".into();
                    t.error = e;
                }
            }
            me.sends.lock().remove(&tid);
            me.emit(Event::Transfer(t));
        });
        Ok(id)
    }

    async fn send_files(&self, dev: &Device, files: &[(Source, FileMeta)], t: &mut Transfer, session: Arc<Mutex<Option<String>>>) -> Result<String, String> {
        let base = base_url(dev);
        let body = serde_json::json!({
            "info": self.info(None),
            "files": files.iter().map(|(_, m)| (m.id.clone(), m.clone())).collect::<HashMap<_, _>>(),
        });
        // No timeout: the receiver may take a while to accept.
        let r = self.client
            .clone()
            .post(format!("{base}/prepare-upload"))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| err_chain(&e))?;
        match r.status().as_u16() {
            200 => {}
            204 => return Ok("done".into()),
            403 => return Ok("declined".into()),
            409 => return Err("The device is busy with another transfer".into()),
            401 => return Err("The device requires a PIN (not supported yet)".into()),
            s => return Err(format!("The device answered HTTP {s}")),
        }
        let p: Prepared = serde_json::from_str(&r.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        *session.lock() = Some(p.session_id.clone());
        t.state = "active".into();
        self.emit(Event::Transfer(t.clone()));
        let done = Arc::new(AtomicU64::new(0));
        // Shared by the parallel uploads: progress is emitted at most every 200 ms.
        let progress = Arc::new(Mutex::new((Instant::now(), t.clone())));
        // A few files at once: many small files are otherwise bound by request latency.
        let mut uploads = futures_util::stream::iter(0..files.len())
            .map(|i| self.upload_one(&base, &p, &files[i].0, &files[i].1, &done, &progress))
            .buffer_unordered(4);
        while let Some(r) = uploads.next().await {
            r?;
        }
        t.done = t.total;
        Ok("done".into())
    }

    async fn upload_one(&self, base: &str, p: &Prepared, src: &Source, meta: &FileMeta, done: &Arc<AtomicU64>, progress: &Progress) -> Result<(), String> {
        let Some(token) = p.files.get(&meta.id) else {
            // Receiver already has this file.
            done.fetch_add(meta.size, Ordering::Relaxed);
            return Ok(());
        };
        let url = format!("{base}/upload?sessionId={}&fileId={}&token={}", p.session_id, meta.id, token);
        let body = match src {
            Source::Text(text) => reqwest::Body::from(text.clone()),
            Source::Path(path) => {
                let file = tokio::fs::File::from_std(self.open_source(path).map_err(|e| format!("{}: {e}", meta.file_name))?);
                let (app, counter, progress) = (self.app.clone(), done.clone(), progress.clone());
                reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).inspect(move |chunk| {
                    if let Ok(c) = chunk {
                        let now = counter.fetch_add(c.len() as u64, Ordering::Relaxed) + c.len() as u64;
                        let mut p = progress.lock();
                        if p.0.elapsed() > Duration::from_millis(200) {
                            p.0 = Instant::now();
                            p.1.done = now;
                            let _ = app.emit("nearby", Event::Transfer(p.1.clone()));
                        }
                    }
                }))
            }
        };
        let r = self.client.post(url).header("content-length", meta.size).body(body).send().await.map_err(|e| err_chain(&e))?;
        if !r.status().is_success() {
            let code = r.status().as_u16();
            let why = r.text().await.unwrap_or_default();
            return Err(format!("{}: HTTP {code}{}", meta.file_name, if why.is_empty() { String::new() } else { format!(" ({})", why.trim()) }));
        }
        if matches!(src, Source::Text(_)) {
            done.fetch_add(meta.size, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) {
        if let Some(t) = self.sends.lock().get(id) {
            t.cancel();
        }
        let mut s = self.session.lock();
        if s.as_ref().is_some_and(|s| s.transfer.id == id) {
            let mut sess = s.take().unwrap();
            sess.transfer.state = "cancelled".into();
            self.emit(Event::Transfer(sess.transfer));
        }
    }
}

impl Nearby {
    /// Phone file pickers return URIs (Android content://, iOS file://) instead of paths.
    fn collect(&self, paths: &[String]) -> Result<Vec<(Source, FileMeta)>, String> {
        #[cfg(mobile)]
        if paths.iter().any(|p| p.starts_with("content://") || p.starts_with("file://")) {
            return paths
                .iter()
                .map(|uri| {
                    use std::os::fd::AsRawFd;
                    let mut f = self.open_source(Path::new(uri)).map_err(|e| format!("{uri}: {e}"))?;
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    // The descriptor of a picked file usually links to its real path, which has the name.
                    let mut name = std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd()))
                        .ok()
                        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                        .unwrap_or_else(|| uri_name(uri));
                    // Photo pickers may only give a numeric id: add the extension of the actual content.
                    if Path::new(&name).extension().is_none() {
                        let mut head = [0u8; 12];
                        if std::io::Read::read_exact(&mut f, &mut head).is_ok() {
                            if let Some(ext) = sniff_ext(&head) {
                                name = format!("{name}.{ext}");
                            }
                        }
                    }
                    let meta = FileMeta { id: uuid::Uuid::new_v4().to_string(), file_type: mime(Path::new(&name)).into(), file_name: name, size, sha256: None, preview: None };
                    Ok((Source::Path(PathBuf::from(uri)), meta))
                })
                .collect();
        }
        collect_files(paths)
    }

    fn open_source(&self, path: &Path) -> std::io::Result<std::fs::File> {
        #[cfg(mobile)]
        if let Some(uri) = path.to_str().filter(|p| p.starts_with("content://") || p.starts_with("file://")) {
            use tauri_plugin_fs::FsExt;
            let url = tauri::Url::parse(uri).map_err(std::io::Error::other)?;
            return self.app.fs().open(tauri_plugin_fs::FilePath::Url(url), tauri_plugin_fs::OpenOptions::new().read(true).clone());
        }
        std::fs::File::open(path)
    }
}

/// File extension from the first bytes of common photo / video formats.
#[cfg_attr(desktop, allow(dead_code))]
fn sniff_ext(h: &[u8; 12]) -> Option<&'static str> {
    Some(match h {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [0x89, b'P', b'N', b'G', ..] => "png",
        [b'G', b'I', b'F', b'8', ..] => "gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P'] => "webp",
        [_, _, _, _, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c' | b'x'] => "heic",
        [_, _, _, _, b'f', b't', b'y', b'p', b'q', b't', ..] => "mov",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "mp4",
        _ => return None,
    })
}

/// Last segment of a content:// or file:// URI, decoded ("primary:Download/a.txt" → "a.txt").
#[cfg_attr(desktop, allow(dead_code))]
fn uri_name(uri: &str) -> String {
    let last = uri.rsplit('/').next().unwrap_or(uri);
    let mut bytes = vec![];
    let mut it = last.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let hex: String = it.by_ref().take(2).map(char::from).collect();
            bytes.push(u8::from_str_radix(&hex, 16).unwrap_or(b'?'));
        } else {
            bytes.push(b);
        }
    }
    let s = String::from_utf8_lossy(&bytes).into_owned();
    s.rsplit(['/', ':']).next().filter(|n| !n.is_empty()).unwrap_or("file").to_string()
}

/// Files to send; a folder is sent with its relative paths ("dir/sub/file").
fn collect_files(paths: &[String]) -> Result<Vec<(Source, FileMeta)>, String> {
    fn walk(path: &Path, rel: String, out: &mut Vec<(Source, FileMeta)>) -> std::io::Result<()> {
        let md = std::fs::metadata(path)?;
        if md.is_dir() {
            for e in std::fs::read_dir(path)?.flatten() {
                // Symlinked folders can loop (e.g. ~/Templates → .); unreadable entries are skipped.
                if e.file_type().is_ok_and(|t| t.is_symlink()) && e.path().is_dir() {
                    continue;
                }
                let _ = walk(&e.path(), format!("{rel}/{}", e.file_name().to_string_lossy()), out);
            }
        } else if md.is_file() {
            out.push((
                Source::Path(path.to_path_buf()),
                FileMeta { id: uuid::Uuid::new_v4().to_string(), file_name: rel, size: md.len(), file_type: mime(path).into(), sha256: None, preview: None },
            ));
        }
        Ok(())
    }
    let mut out = vec![];
    for p in paths {
        let path = Path::new(p);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        walk(path, name, &mut out).map_err(|e| format!("{p}: {e}"))?;
    }
    Ok(out)
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("pdf") => "application/pdf",
        Some("txt" | "md" | "log") => "text/plain",
        Some("zip") => "application/zip",
        Some("apk") => "application/vnd.android.package-archive",
        _ => "application/octet-stream",
    }
}

type Svc = AxState<Arc<Nearby>>;

async fn register(AxState(me): Svc, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(info): Json<Info>) -> Json<Info> {
    me.note_inbound(addr.ip());
    me.add_device(addr.ip(), &info);
    Json(me.info(None))
}

async fn info(AxState(me): Svc, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Json<Info> {
    me.note_inbound(addr.ip());
    Json(me.info(None))
}

#[derive(Deserialize)]
struct ReachReq {
    port: u16,
}

#[derive(Serialize)]
struct ReachRes {
    reachable: bool,
}

/// Another device asks whether we can be reached: connect back to it at the address it came from.
async fn reach(AxState(me): Svc, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(req): Json<ReachReq>) -> Json<ReachRes> {
    let back = format!("http://{}{API}/info", SocketAddr::new(addr.ip(), req.port));
    let reachable = req.port != 0 && me.client.get(back).timeout(Duration::from_secs(3)).send().await.is_ok_and(|r| r.status().is_success());
    Json(ReachRes { reachable })
}

#[derive(Deserialize)]
struct PrepareReq {
    info: Info,
    files: HashMap<String, FileMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRes {
    session_id: String,
    files: HashMap<String, String>,
}

async fn prepare_upload(AxState(me): Svc, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(req): Json<PrepareReq>) -> Result<Json<PrepareRes>, StatusCode> {
    me.note_inbound(addr.ip());
    if req.files.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Text messages carry their content in the preview: show it, nothing to download.
    if req.files.values().all(|f| f.file_type.starts_with("text/") && f.preview.is_some()) {
        me.add_device(addr.ip(), &req.info);
        let text = req.files.values().filter_map(|f| f.preview.clone()).collect::<Vec<_>>().join("\n\n");
        me.emit(Event::Message { alias: req.info.alias.clone(), text });
        return Err(StatusCode::NO_CONTENT);
    }
    if me.session.lock().is_some() {
        return Err(StatusCode::CONFLICT);
    }
    me.add_device(addr.ip(), &req.info);
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    me.pending.lock().insert(id.clone(), tx);
    // Only the first names: a folder can hold millions of files.
    let mut files: Vec<(String, u64)> = req.files.values().take(50).map(|f| (f.file_name.clone(), f.size)).collect();
    files.sort();
    let (count, total) = (req.files.len(), req.files.values().map(|f| f.size).sum());
    me.emit(Event::Request { id: id.clone(), alias: req.info.alias.clone(), files, count, total });
    let accepted = tokio::time::timeout(Duration::from_secs(120), rx).await;
    me.pending.lock().remove(&id);
    if !matches!(accepted, Ok(Ok(true))) {
        me.emit(Event::RequestGone { id });
        return Err(StatusCode::FORBIDDEN);
    }
    let mut s = me.session.lock();
    if s.is_some() {
        return Err(StatusCode::CONFLICT);
    }
    let tokens: HashMap<String, (String, FileMeta)> = req.files.into_iter().map(|(k, f)| (k, (uuid::Uuid::new_v4().to_string(), f))).collect();
    let transfer = Transfer {
        id,
        peer: req.info.alias,
        incoming: true,
        files: tokens.len(),
        total: tokens.values().map(|(_, f)| f.size).sum(),
        done: 0,
        state: "active".into(),
        error: String::new(),
        dir: me.save_dir().to_string_lossy().into_owned(),
        at: 0,
    };
    me.emit(Event::Transfer(transfer.clone()));
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        dir: me.save_dir(),
        ip: addr.ip(),
        files: tokens,
        received: 0,
        transfer,
        done: Arc::new(AtomicU64::new(0)),
        last_emit: Instant::now(),
    };
    let res = PrepareRes { session_id: session.id.clone(), files: session.files.iter().map(|(k, (t, _))| (k.clone(), t.clone())).collect() };
    *s = Some(session);
    Ok(Json(res))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQuery {
    session_id: String,
    file_id: String,
    token: String,
}

async fn upload(AxState(me): Svc, ConnectInfo(addr): ConnectInfo<SocketAddr>, Query(q): Query<UploadQuery>, body: Body) -> (StatusCode, String) {
    let (meta, done, dir) = {
        let s = me.session.lock();
        let Some(s) = s.as_ref().filter(|s| s.id == q.session_id && s.ip == addr.ip()) else { return (StatusCode::FORBIDDEN, String::new()) };
        match s.files.get(&q.file_id) {
            Some((t, m)) if *t == q.token => (m.clone(), s.done.clone(), s.dir.clone()),
            _ => return (StatusCode::FORBIDDEN, String::new()),
        }
    };
    let path = target_path(&dir, &meta.file_name);
    let result: Result<(), String> = async {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let mut f = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            f.write_all(&chunk).await.map_err(|e| e.to_string())?;
            let now = done.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
            let mut s = me.session.lock();
            let Some(s) = s.as_mut().filter(|s| s.id == q.session_id) else { return Err("cancelled".into()) };
            if s.last_emit.elapsed() > Duration::from_millis(200) {
                s.last_emit = Instant::now();
                s.transfer.done = now;
                me.emit(Event::Transfer(s.transfer.clone()));
            }
        }
        f.flush().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&path).await;
        // The sender shows this text (e.g. a folder the phone does not let us write to).
        let msg = format!("{}: {e}", path.display());
        let mut s = me.session.lock();
        if let Some(mut sess) = s.take_if(|s| s.id == q.session_id) {
            sess.transfer.state = "failed".into();
            sess.transfer.error = msg.clone();
            me.emit(Event::Transfer(sess.transfer));
        }
        return (StatusCode::INTERNAL_SERVER_ERROR, msg);
    }
    #[cfg(target_os = "ios")]
    {
        let p = path.clone();
        let _ = me.app.run_on_main_thread(move || crate::ios_photos::save(&p));
    }
    let mut s = me.session.lock();
    if let Some(sess) = s.as_mut().filter(|s| s.id == q.session_id) {
        sess.received += 1;
        sess.transfer.done = sess.done.load(Ordering::Relaxed);
        if sess.received == sess.files.len() {
            let mut sess = s.take().unwrap();
            sess.transfer.state = "done".into();
            me.emit(Event::Transfer(sess.transfer));
        } else {
            me.emit(Event::Transfer(sess.transfer.clone()));
        }
    }
    (StatusCode::OK, String::new())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelQuery {
    session_id: String,
}

async fn cancel(AxState(me): Svc, Query(q): Query<CancelQuery>) -> StatusCode {
    let mut s = me.session.lock();
    if let Some(mut sess) = s.take_if(|s| s.id == q.session_id) {
        sess.transfer.state = "cancelled".into();
        me.emit(Event::Transfer(sess.transfer));
    }
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_path_stays_inside() {
        let dir = std::env::temp_dir().join(format!("kermius-nearby-{}", uuid::Uuid::new_v4()));
        assert_eq!(target_path(&dir, "../../etc/passwd"), dir.join("etc/passwd"));
        assert_eq!(target_path(&dir, "/abs/a.txt"), dir.join("abs/a.txt"));
        assert_eq!(target_path(&dir, "..\\x.txt"), dir.join("x.txt"));
        assert_eq!(target_path(&dir, ".."), dir.join("file"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "").unwrap();
        assert_eq!(target_path(&dir, "a.txt"), dir.join("a (1).txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sniffs_media_types() {
        let mut h = [0u8; 12];
        h[..4].copy_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0]);
        assert_eq!(sniff_ext(&h), Some("jpg"));
        h.copy_from_slice(b"\0\0\0\x18ftypheic");
        assert_eq!(sniff_ext(&h), Some("heic"));
        h.copy_from_slice(b"\0\0\0\x18ftypisom");
        assert_eq!(sniff_ext(&h), Some("mp4"));
        h.copy_from_slice(b"\0\0\0\x14ftypqt  ");
        assert_eq!(sniff_ext(&h), Some("mov"));
        assert_eq!(sniff_ext(&[0u8; 12]), None);
    }

    #[test]
    fn content_uri_names() {
        assert_eq!(uri_name("content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fa%20b.pdf"), "a b.pdf");
        assert_eq!(uri_name("content://com.android.externalstorage.documents/document/primary%3ADownload%2Fx.txt"), "x.txt");
    }

    #[test]
    fn parses_localsend_announcement() {
        let raw = r#"{"alias":"Nice Orange","version":"2.0","deviceModel":"Samsung","deviceType":"mobile","fingerprint":"abc","port":53317,"protocol":"https","download":true,"announce":true}"#;
        let i: Info = serde_json::from_str(raw).unwrap();
        assert_eq!((i.alias.as_str(), i.port, i.announce), ("Nice Orange", Some(53317), Some(true)));
    }
}
