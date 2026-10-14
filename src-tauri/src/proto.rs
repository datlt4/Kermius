//! Non-SSH sessions: Telnet and serial terminals, and raw TCP streams (VNC through noVNC).
use crate::model::Host;
use crate::ssh::{Cmd, Flow, Status};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

async fn tcp(host: &Host, default_port: u16) -> Result<TcpStream, String> {
    let port = if host.port == 0 { default_port } else { host.port };
    let addr = format!("{}:{port}", host.address);
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            Ok(s)
        }
        Ok(Err(err)) => Err(format!("{addr}: {err}")),
        Err(_) => Err(format!("{addr}: timed out")),
    }
}

// ---------- telnet ----------

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

#[derive(Default, PartialEq)]
enum St {
    #[default]
    Data,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
}

/// Telnet option negotiation (RFC 854/855) for an xterm-like client.
#[derive(Default)]
pub struct Telnet {
    st: St,
    sub: Vec<u8>,
    /// Options we agreed to do (WILL) / asked the server to do (DO), to answer each request once.
    will: HashSet<u8>,
    doing: HashSet<u8>,
    pub naws: bool,
}

impl Telnet {
    /// Split server bytes into terminal output and replies to send back.
    pub fn input(&mut self, data: &[u8], size: (u32, u32), out: &mut Vec<u8>, reply: &mut Vec<u8>) {
        for &b in data {
            self.st = match std::mem::take(&mut self.st) {
                St::Data if b == IAC => St::Iac,
                St::Data => {
                    out.push(b);
                    St::Data
                }
                St::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        St::Data
                    }
                    DO | DONT | WILL | WONT => St::Verb(b),
                    SB => {
                        self.sub.clear();
                        St::Sub
                    }
                    _ => St::Data,
                },
                St::Verb(v) => {
                    self.negotiate(v, b, size, reply);
                    St::Data
                }
                St::Sub if b == IAC => St::SubIac,
                St::Sub => {
                    self.sub.push(b);
                    St::Sub
                }
                St::SubIac if b == SE => {
                    // TTYPE SEND -> IS "XTERM-256COLOR"
                    if self.sub == [TTYPE, 1] {
                        reply.extend_from_slice(&[IAC, SB, TTYPE, 0]);
                        reply.extend_from_slice(b"XTERM-256COLOR");
                        reply.extend_from_slice(&[IAC, SE]);
                    }
                    St::Data
                }
                St::SubIac => {
                    self.sub.push(b);
                    St::Sub
                }
            };
        }
    }

    fn negotiate(&mut self, verb: u8, opt: u8, size: (u32, u32), reply: &mut Vec<u8>) {
        match verb {
            DO if [NAWS, TTYPE, SGA].contains(&opt) => {
                if self.will.insert(opt) {
                    reply.extend_from_slice(&[IAC, WILL, opt]);
                }
                if opt == NAWS {
                    self.naws = true;
                    reply.extend(naws(size.0, size.1));
                }
            }
            DO => reply.extend_from_slice(&[IAC, WONT, opt]),
            DONT => {
                if self.will.remove(&opt) {
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                }
                if opt == NAWS {
                    self.naws = false;
                }
            }
            WILL if [ECHO, SGA].contains(&opt) => {
                if self.doing.insert(opt) {
                    reply.extend_from_slice(&[IAC, DO, opt]);
                }
            }
            WILL => reply.extend_from_slice(&[IAC, DONT, opt]),
            WONT => {
                if self.doing.remove(&opt) {
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            _ => {}
        }
    }
}

/// Window size subnegotiation (IAC bytes in the values are doubled).
pub fn naws(cols: u32, rows: u32) -> Vec<u8> {
    let mut v = vec![IAC, SB, NAWS];
    for x in [(cols as u16).to_be_bytes(), (rows as u16).to_be_bytes()].concat() {
        v.push(x);
        if x == IAC {
            v.push(IAC);
        }
    }
    v.extend_from_slice(&[IAC, SE]);
    v
}

/// Keyboard bytes to the wire: double IAC, and a lone CR becomes CR NUL (NVT newline rules).
pub fn escape(data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 4);
    for (i, &b) in data.iter().enumerate() {
        v.push(b);
        if b == IAC {
            v.push(IAC);
        } else if b == b'\r' && data.get(i + 1) != Some(&b'\n') {
            v.push(0);
        }
    }
    v
}

/// Answers "login:" and "Password:" prompts once with the host's stored credentials.
struct AutoLogin {
    user: Option<String>,
    password: Option<String>,
    tail: String,
}

impl AutoLogin {
    fn feed(&mut self, out: &[u8]) -> Option<String> {
        self.tail.push_str(&String::from_utf8_lossy(out).to_lowercase());
        if self.tail.len() > 200 {
            self.tail = self.tail[self.tail.len() - 100..].to_string();
        }
        let t = self.tail.trim_end();
        let answer = if (t.ends_with("login:") || t.ends_with("username:")) && self.user.is_some() {
            self.user.take()
        } else if t.ends_with("password:") && self.password.is_some() {
            self.user = None;
            self.password.take()
        } else {
            None
        };
        if answer.is_some() {
            self.tail.clear();
        }
        answer.map(|a| format!("{a}\r"))
    }
}

pub fn spawn_telnet(
    host: Host,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
) -> mpsc::UnboundedSender<Cmd> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        let log = |m: String| {
            let _ = on_status.send(Status::Log { message: m });
        };
        log(format!("Connecting to {}:{} (telnet)", host.address, if host.port == 0 { 23 } else { host.port }));
        let stream = match tcp(&host, 23).await {
            Ok(s) => s,
            Err(err) => {
                let _ = on_status.send(Status::Error { message: err });
                return;
            }
        };
        let (mut rd, mut wr) = stream.into_split();
        let _ = on_status.send(Status::Connected);
        let mut telnet = Telnet::default();
        let mut login = AutoLogin {
            user: Some(host.username.clone()).filter(|u| !u.is_empty()),
            password: Some(host.password.clone()).filter(|p| !p.is_empty()),
            tail: String::new(),
        };
        let started = std::time::Instant::now();
        let mut size = (cols, rows);
        let mut buf = vec![0u8; 64 * 1024];
        let result: Result<(), std::io::Error> = async {
            loop {
                tokio::select! {
                    _ = flow.drained(), if flow.blocked() => {}
                    n = rd.read(&mut buf), if !flow.blocked() => {
                        let n = n?;
                        if n == 0 { return Ok(()); }
                        let (mut out, mut reply) = (Vec::new(), Vec::new());
                        telnet.input(&buf[..n], size, &mut out, &mut reply);
                        if !reply.is_empty() { wr.write_all(&reply).await?; }
                        // Only right after connecting, so later "password:" text is never answered.
                        if started.elapsed() < Duration::from_secs(60) {
                            if let Some(a) = login.feed(&out) { wr.write_all(&escape(a.as_bytes())).await?; }
                        }
                        if !out.is_empty() {
                            flow.sent(out.len());
                            let _ = on_data.send(InvokeResponseBody::Raw(out));
                        }
                    }
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Data(d)) => wr.write_all(&escape(&d)).await?,
                        Some(Cmd::Resize(c, r)) => {
                            size = (c, r);
                            if telnet.naws { wr.write_all(&naws(c, r)).await?; }
                        }
                        Some(Cmd::Upload { reply, .. }) => { let _ = reply.send(Err("Not available for Telnet".into())); }
                        Some(Cmd::Close) | None => return Ok(()),
                    },
                }
            }
        }
        .await;
        let _ = on_status.send(match result {
            Ok(()) => Status::Closed,
            Err(err) => Status::Error { message: format!("Connection lost: {err}") },
        });
    });
    tx
}

// ---------- serial ----------

/// Command that lets the current user open serial ports (Linux: the dialout group).
pub const SERIAL_SETUP: &str = "sudo usermod -aG dialout $USER";

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn serial_ports() -> Vec<String> {
    serialport::available_ports().map(|v| v.into_iter().map(|p| p.port_name).collect()).unwrap_or_default()
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn spawn_serial(
    host: Host,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
) -> mpsc::UnboundedSender<Cmd> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let baud = if host.baud == 0 { 115_200 } else { host.baud };
    let _ = on_status.send(Status::Log { message: format!("Opening {} at {baud} baud", host.address) });
    let port = serialport::new(&host.address, baud).timeout(Duration::from_millis(100)).open();
    let (mut reader, mut writer) = match port.and_then(|p| Ok((p.try_clone()?, p))) {
        Ok(p) => p,
        Err(err) => {
            let denied = matches!(err.kind, serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied)) || err.to_string().contains("ermission");
            let message = if denied && cfg!(target_os = "linux") {
                format!("{}: permission denied. Allow serial ports: `{SERIAL_SETUP}`, then log out and back in.", host.address)
            } else {
                format!("{}: {err}", host.address)
            };
            let _ = on_status.send(Status::Error { message });
            return tx;
        }
    };
    let _ = on_status.send(Status::Connected);
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = closed.clone();
    let status = on_status.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = vec![0u8; 16 * 1024];
        let message = loop {
            if stop.load(std::sync::atomic::Ordering::Relaxed) {
                break None;
            }
            if flow.blocked() {
                flow.wait_drained();
            }
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    flow.sent(n);
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break None;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::TimedOut => {}
                Err(err) => break Some(format!("Port closed: {err}")),
            }
        };
        let _ = status.send(match message {
            Some(message) => Status::Error { message },
            None => Status::Closed,
        });
    });
    tauri::async_runtime::spawn(async move {
        use std::io::Write;
        while let Some(cmd) = rx.recv().await {
            match cmd {
                Cmd::Data(d) => {
                    if writer.write_all(&d).is_err() {
                        break;
                    }
                }
                Cmd::Upload { reply, .. } => {
                    let _ = reply.send(Err("Not available for serial ports".into()));
                }
                Cmd::Resize(..) => {}
                Cmd::Close => break,
            }
        }
        closed.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    tx
}

// ---------- raw TCP (VNC) ----------

/// Connect to the host and stream raw bytes both ways (noVNC speaks RFB over it). Resolves once connected.
pub async fn open_tcp(host: Host, default_port: u16, on_data: Channel<InvokeResponseBody>, on_status: Channel<Status>) -> Result<mpsc::UnboundedSender<Cmd>, String> {
    let (mut rd, mut wr) = tcp(&host, default_port).await?.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 256 * 1024];
        let result: Result<(), std::io::Error> = async {
            loop {
                tokio::select! {
                    n = rd.read(&mut buf) => {
                        let n = n?;
                        if n == 0 { return Ok(()); }
                        let _ = on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                    }
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Data(d)) => wr.write_all(&d).await?,
                        Some(Cmd::Close) | None => return Ok(()),
                        _ => {}
                    },
                }
            }
        }
        .await;
        let _ = on_status.send(match result {
            Ok(()) => Status::Closed,
            Err(err) => Status::Error { message: err.to_string() },
        });
    });
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_negotiation_and_escaping() {
        let mut t = Telnet::default();
        let (mut out, mut reply) = (Vec::new(), Vec::new());
        // "hi", DO NAWS, WILL ECHO, DO LINEMODE(34), TTYPE SEND, escaped 0xFF
        let input = [b'h', b'i', IAC, DO, NAWS, IAC, WILL, ECHO, IAC, DO, 34, IAC, SB, TTYPE, 1, IAC, SE, IAC, IAC];
        // Split mid-sequence: the parser keeps state between reads.
        t.input(&input[..4], (80, 24), &mut out, &mut reply);
        t.input(&input[4..], (80, 24), &mut out, &mut reply);
        assert_eq!(out, [b'h', b'i', IAC]);
        let mut want = vec![IAC, WILL, NAWS, IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE, IAC, DO, ECHO, IAC, WONT, 34, IAC, SB, TTYPE, 0];
        want.extend_from_slice(b"XTERM-256COLOR");
        want.extend_from_slice(&[IAC, SE]);
        assert_eq!(reply, want);
        assert!(t.naws);
        // Asked again: no duplicate WILL.
        reply.clear();
        t.input(&[IAC, DO, NAWS], (100, 30), &mut out, &mut reply);
        assert_eq!(&reply[..3], &[IAC, SB, NAWS]);
        assert_eq!(escape(&[b'a', b'\r', IAC, b'\r', b'\n']), [b'a', b'\r', 0, IAC, IAC, b'\r', b'\n']);
        assert_eq!(naws(255, 24), [IAC, SB, NAWS, 0, 255, 255, 0, 24, IAC, SE]);
    }

    #[test]
    fn auto_login_answers_once() {
        let mut a = AutoLogin { user: Some("pi".into()), password: Some("pw".into()), tail: String::new() };
        assert_eq!(a.feed(b"Welcome\r\nraspberrypi login: "), Some("pi\r".into()));
        assert_eq!(a.feed(b"pi\r\nPass"), None);
        assert_eq!(a.feed(b"word: "), Some("pw\r".into()));
        assert_eq!(a.feed(b"\r\nLogin incorrect\r\nlogin: "), None);
    }
}
