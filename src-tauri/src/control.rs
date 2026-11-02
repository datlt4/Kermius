//! Control API (desktop, Unix): other local apps (Kolphin) drive Kermius local terminal tabs over a Unix
//! socket with one JSON object per line. Spec: Kolphin's docs/kermius-control-api.md; summary in the README.
//! Kermius keeps the sessions here; the UI only opens, focuses and closes tabs (`UiMsg`).
use crate::local::{Idle, Watch};
use crate::ssh::Cmd;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{self, UnboundedSender};

pub const API: u32 = 1;

/// What the UI has to do for a request.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiMsg {
    /// Open a local terminal tab bound to `session`; `argv` runs a program instead of the plain shell.
    #[serde(rename_all = "camelCase")]
    Open { session: String, cwd: String, title: String, icon: String, focus: bool, argv: Vec<String>, env: HashMap<String, String> },
    Focus { session: String },
    Close { session: String },
    /// `kermius --share` paths.
    Share { paths: Vec<String> },
}

struct Sess {
    key: Option<String>,
    /// Last known working directory (OSC 7 or /proc), else the spawn folder.
    cwd: String,
    title: String,
    /// Set once the UI has spawned the PTY.
    pty: Option<(UnboundedSender<Cmd>, Idle)>,
}

struct Inner {
    sessions: Mutex<HashMap<String, Sess>>,
    /// Clients that said hello, for events.
    clients: Mutex<Vec<UnboundedSender<String>>>,
    ui: Box<dyn Fn(UiMsg) + Send + Sync>,
    version: String,
}

#[derive(Clone)]
pub struct Control(Arc<Inner>);

type Reply = Result<Value, (&'static str, String)>;

fn bad(msg: impl Into<String>) -> (&'static str, String) {
    ("bad_request", msg.into())
}

/// `$XDG_RUNTIME_DIR/kermius/control.sock`, else `/tmp/kermius-$UID/control.sock`.
pub fn socket_path() -> PathBuf {
    let dir = match std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d).join("kermius"),
        None => PathBuf::from(format!("/tmp/kermius-{}", unsafe { libc::getuid() })),
    };
    dir.join("control.sock")
}

/// ` cd -- '<path>'` + Enter; the leading space keeps it out of history (HISTCONTROL=ignorespace).
fn cd_line(path: &str) -> String {
    format!(" cd -- '{}'\r", path.replace('\'', r"'\''"))
}

impl Control {
    pub fn new(version: &str, ui: impl Fn(UiMsg) + Send + Sync + 'static) -> Self {
        Control(Arc::new(Inner { sessions: Default::default(), clients: Default::default(), ui: Box::new(ui), version: version.into() }))
    }

    /// Listen on `path` until the runtime ends. A socket that still answers belongs to another Kermius.
    pub async fn serve(self, path: PathBuf) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = path.parent().unwrap_or(Path::new("/tmp"));
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        if path.exists() {
            if UnixStream::connect(&path).await.is_ok() {
                return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another Kermius owns the control socket"));
            }
            std::fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        loop {
            let (stream, _) = listener.accept().await?;
            tokio::spawn(self.clone().client(stream));
        }
    }

    async fn client(self, stream: UnixStream) {
        let (read, mut write) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = rx.recv().await {
                line.push('\n');
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let mut lines = BufReader::new(read).lines();
        let mut hello = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let req: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(err) => {
                    let _ = tx.send(json!({"id": null, "error": {"code": "bad_request", "message": err.to_string()}}).to_string());
                    continue;
                }
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let reply = if method == "hello" {
                hello = true;
                self.0.clients.lock().push(tx.clone());
                Ok(json!({"app": "kermius", "version": self.0.version, "api": API, "capabilities": ["session", "share", "cwd_events"]}))
            } else if !hello {
                Err(bad("send hello first"))
            } else {
                self.call(method, &params)
            };
            let msg = match reply {
                Ok(result) => json!({"id": id, "result": result}),
                Err((code, message)) => json!({"id": id, "error": {"code": code, "message": message}}),
            };
            let _ = tx.send(msg.to_string());
        }
        self.0.clients.lock().retain(|c| !c.same_channel(&tx));
    }

    fn event(&self, name: &str, params: Value) {
        let line = json!({"event": name, "params": params}).to_string();
        self.0.clients.lock().retain(|c| c.send(line.clone()).is_ok());
    }

    pub fn call(&self, method: &str, p: &Value) -> Reply {
        let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string);
        let session = || s("session").ok_or_else(|| bad("session is required"));
        let focus = p.get("focus").and_then(Value::as_bool).unwrap_or(true);
        match method {
            "session.open" => {
                let key = s("key").filter(|k| !k.is_empty());
                if let Some(key) = &key {
                    let found = self.0.sessions.lock().iter().find(|(_, v)| v.key.as_deref() == Some(key)).map(|(id, _)| id.clone());
                    if let Some(id) = found {
                        if let Some(cwd) = s("cwd") {
                            // Reusing the tab: follow the folder if the shell is idle, never interrupt it.
                            let _ = self.cd(&id, &cwd);
                        }
                        if focus {
                            (self.0.ui)(UiMsg::Focus { session: id.clone() });
                        }
                        return Ok(json!({"session": id, "reused": true}));
                    }
                }
                Ok(json!({"session": self.open(key, p, Vec::new()), "reused": false}))
            }
            "session.run" => {
                let argv: Vec<String> = p.get("argv").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                if argv.is_empty() {
                    return Err(bad("argv must be a non-empty array of strings"));
                }
                Ok(json!({"session": self.open(None, p, argv)}))
            }
            "session.cd" => {
                let path = s("path").ok_or_else(|| bad("path is required"))?;
                self.cd(&session()?, &path).map(|_| json!({}))
            }
            "session.focus" | "session.close" => {
                let id = session()?;
                if !self.0.sessions.lock().contains_key(&id) {
                    return Err(("not_found", format!("no session {id}")));
                }
                (self.0.ui)(if method == "session.focus" { UiMsg::Focus { session: id } } else { UiMsg::Close { session: id } });
                Ok(json!({}))
            }
            "session.list" => {
                let key = s("key");
                let list: Vec<Value> = self
                    .0
                    .sessions
                    .lock()
                    .iter()
                    .filter(|(_, v)| key.is_none() || v.key == key)
                    .map(|(id, v)| json!({"session": id, "key": v.key, "cwd": v.cwd, "busy": !v.pty.as_ref().is_some_and(|(_, idle)| idle()), "title": v.title}))
                    .collect();
                Ok(json!({"sessions": list}))
            }
            "share" => {
                let paths: Vec<String> = p.get("paths").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                if paths.is_empty() || paths.iter().any(|x| !Path::new(x).is_absolute()) {
                    return Err(bad("paths must be absolute"));
                }
                (self.0.ui)(UiMsg::Share { paths });
                Ok(json!({}))
            }
            _ => Err(("unknown_method", format!("unknown method {method}"))),
        }
    }

    /// Register a session and ask the UI for its tab; the id is returned before the shell runs.
    fn open(&self, key: Option<String>, p: &Value, argv: Vec<String>) -> String {
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let cwd = Some(s("cwd")).filter(|c| Path::new(c).is_absolute() && Path::new(c).is_dir()).or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned())).unwrap_or_default();
        let env = p.get("env").and_then(Value::as_object).map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default();
        let title = s("title");
        self.0.sessions.lock().insert(id.clone(), Sess { key, cwd: cwd.clone(), title: title.clone(), pty: None });
        let focus = p.get("focus").and_then(Value::as_bool).unwrap_or(true);
        (self.0.ui)(UiMsg::Open { session: id.clone(), cwd, title, icon: icon_data_url(&s("icon")), focus, argv, env });
        id
    }

    fn cd(&self, id: &str, path: &str) -> Result<(), (&'static str, String)> {
        if !Path::new(path).is_absolute() {
            return Err(bad("path must be absolute"));
        }
        let sessions = self.0.sessions.lock();
        let sess = sessions.get(id).ok_or_else(|| ("not_found", format!("no session {id}")))?;
        if sess.cwd == path {
            return Ok(());
        }
        let (tx, idle) = sess.pty.as_ref().ok_or(("busy", "the shell is still starting".to_string()))?;
        if !idle() {
            return Err(("busy", "a program is running in this tab".into()));
        }
        tx.send(Cmd::Data(cd_line(path).into_bytes())).map_err(|_| ("not_found", format!("session {id} has ended")))
    }

    /// Hooks for the PTY of `session` (the UI spawns it with `local::spawn_controlled`).
    pub fn watch(&self, session: &str) -> Watch {
        let (a, b, id, id2) = (self.clone(), self.clone(), session.to_string(), session.to_string());
        Watch { on_cwd: Box::new(move |cwd| a.cwd_changed(&id, cwd)), on_exit: Box::new(move || b.ended(&id2)) }
    }

    /// The UI's PTY for `session` is running.
    pub fn bind(&self, session: &str, tx: UnboundedSender<Cmd>, idle: Idle) {
        if let Some(s) = self.0.sessions.lock().get_mut(session) {
            s.pty = Some((tx, idle));
        }
    }

    fn cwd_changed(&self, id: &str, cwd: String) {
        let key = {
            let mut sessions = self.0.sessions.lock();
            let Some(s) = sessions.get_mut(id) else { return };
            if s.cwd == cwd {
                return;
            }
            s.cwd = cwd.clone();
            s.key.clone()
        };
        if key.is_some() {
            self.event("session.cwd", json!({"session": id, "key": key, "cwd": cwd}));
        }
    }

    /// Tab closed or shell exited: the key is free again.
    pub fn ended(&self, id: &str) {
        if let Some(s) = self.0.sessions.lock().remove(id) {
            self.event("session.closed", json!({"session": id, "key": s.key}));
        }
    }
}

/// The tab icon as a data URL (the page cannot read local files); "" when missing or too big.
fn icon_data_url(path: &str) -> String {
    use base64::Engine;
    let mime = match Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => return String::new(),
    };
    match std::fs::read(path) {
        Ok(b) if b.len() <= 512 * 1024 => format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{Flow, Status};
    use tauri::ipc::{Channel, InvokeResponseBody};

    /// A stand-in for the UI: spawns the PTY like the real tab does and records what it was asked.
    fn ui_and_control() -> (Control, Arc<Mutex<Vec<UiMsg>>>, Arc<Mutex<Vec<u8>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let screen = Arc::new(Mutex::new(Vec::new()));
        let slot: Arc<Mutex<Option<Control>>> = Default::default();
        let (seen2, screen2, slot2) = (seen.clone(), screen.clone(), slot.clone());
        let ctl = Control::new("test", move |m| {
            seen2.lock().push(m.clone());
            let ctl = slot2.lock().clone().unwrap();
            match m {
                UiMsg::Open { session, cwd, argv, env, .. } => {
                    let scr = screen2.clone();
                    let data = Channel::new(move |b| {
                        if let InvokeResponseBody::Raw(b) = b {
                            scr.lock().extend_from_slice(&b);
                        }
                        Ok(())
                    });
                    let status: Channel<Status> = Channel::new(|_| Ok(()));
                    let env = env.into_iter().collect();
                    let (tx, idle) = crate::local::spawn_controlled(120, 30, data, status, Arc::new(Flow::default()), Some(cwd), Some(argv), env, ctl.watch(&session)).unwrap();
                    ctl.bind(&session, tx, idle);
                }
                UiMsg::Close { session } => {
                    // The tab closes its PTY; the shell's exit then ends the session.
                    let _ = session;
                }
                _ => {}
            }
        });
        *slot.lock() = Some(ctl.clone());
        (ctl, seen, screen)
    }

    async fn client(path: &Path) -> (tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>, tokio::net::unix::OwnedWriteHalf) {
        let s = UnixStream::connect(path).await.unwrap();
        let (r, w) = s.into_split();
        (BufReader::new(r).lines(), w)
    }

    async fn send(w: &mut tokio::net::unix::OwnedWriteHalf, v: Value) {
        w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }

    /// Next message matching `pred` (responses and events interleave), with a timeout.
    async fn next(r: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>, pred: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let v: Value = serde_json::from_str(&r.next_line().await.unwrap().unwrap()).unwrap();
                if pred(&v) {
                    return v;
                }
            }
        })
        .await
        .expect("timed out")
    }

    fn reply(id: u64) -> impl Fn(&Value) -> bool {
        move |v| v["id"] == id
    }

    async fn wait_until(what: &str, f: impl Fn() -> bool) {
        for _ in 0..150 {
            if f() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("timed out waiting for: {what}");
    }

    #[test]
    fn cd_line_quotes() {
        assert_eq!(cd_line("/a b/it's"), " cd -- '/a b/it'\\''s'\r");
    }

    #[tokio::test]
    async fn control_api_acceptance() {
        // Canonical: the shell reports /private/var/… on macOS, not /var/….
        let tmp = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("kermius-ctl-{}", uuid::Uuid::new_v4()));
        // Unix socket paths are limited to ~104 bytes (macOS temp folders are longer).
        let sock = PathBuf::from(format!("/tmp/kc-{}", &uuid::Uuid::new_v4().to_string()[..8])).join("control.sock");
        let (ctl, seen, screen) = ui_and_control();
        let server = ctl.clone();
        let path = sock.clone();
        tokio::spawn(async move { server.serve(path).await.map_err(|err| eprintln!("serve: {err}")) });
        wait_until("socket", || sock.exists()).await;
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777, 0o600);
        // A second server refuses to take over a live socket.
        assert!(Control::new("x", |_| {}).serve(sock.clone()).await.is_err());

        let (mut r, mut w) = client(&sock).await;
        let (mut r2, mut w2) = client(&sock).await;
        // Nothing before hello.
        send(&mut w, json!({"id": 1, "method": "session.list"})).await;
        assert_eq!(next(&mut r, reply(1)).await["error"]["code"], "bad_request");
        send(&mut w, json!({"id": 2, "method": "hello", "params": {"client": "test"}})).await;
        assert_eq!(next(&mut r, reply(2)).await["result"]["api"], 1);
        send(&mut w2, json!({"id": 1, "method": "hello"})).await;
        next(&mut r2, reply(1)).await;

        // 2. Same key twice → one tab.
        let dir = tmp.join("work dir/it's");
        std::fs::create_dir_all(&dir).unwrap();
        send(&mut w, json!({"id": 3, "method": "session.open", "params": {"key": "t", "cwd": tmp.to_str().unwrap()}})).await;
        let first = next(&mut r, reply(3)).await;
        assert_eq!(first["result"]["reused"], false);
        let sid = first["result"]["session"].as_str().unwrap().to_string();
        wait_until("shell idle", || ctl.0.sessions.lock().get(&sid).is_some_and(|s| s.pty.as_ref().is_some_and(|(_, idle)| idle()))).await;
        send(&mut w, json!({"id": 4, "method": "session.open", "params": {"key": "t", "focus": false}})).await;
        let second = next(&mut r, reply(4)).await;
        assert_eq!((second["result"]["session"].as_str(), &second["result"]["reused"]), (Some(sid.as_str()), &json!(true)));
        assert_eq!(seen.lock().iter().filter(|m| matches!(m, UiMsg::Open { .. })).count(), 1);

        // 3 + 7. cd (path with a space and a quote) → the shell moves there, both clients get session.cwd.
        send(&mut w, json!({"id": 5, "method": "session.cd", "params": {"session": sid, "path": dir.to_str().unwrap()}})).await;
        assert_eq!(next(&mut r, reply(5)).await["result"], json!({}));
        let ev = next(&mut r, |v| v["event"] == "session.cwd" && v["params"]["cwd"] == dir.to_str().unwrap()).await;
        assert_eq!(ev["params"]["key"], "t");
        next(&mut r2, |v| v["event"] == "session.cwd").await;
        // Same folder again: no-op success.
        send(&mut w, json!({"id": 6, "method": "session.cd", "params": {"session": sid, "path": dir.to_str().unwrap()}})).await;
        assert_eq!(next(&mut r, reply(6)).await["result"], json!({}));

        // 4. A program is running → busy, nothing typed.
        let tx = ctl.0.sessions.lock().get(&sid).unwrap().pty.as_ref().unwrap().0.clone();
        tx.send(Cmd::Data(b"sleep 30\r".to_vec())).unwrap();
        wait_until("sleep running", || ctl.0.sessions.lock().get(&sid).is_some_and(|s| !(s.pty.as_ref().unwrap().1)())).await;
        let before = screen.lock().len();
        send(&mut w, json!({"id": 7, "method": "session.cd", "params": {"session": sid, "path": "/"}})).await;
        assert_eq!(next(&mut r, reply(7)).await["error"]["code"], "busy");
        send(&mut w, json!({"id": 8, "method": "session.list", "params": {"key": "t"}})).await;
        let list = next(&mut r, reply(8)).await;
        assert_eq!(list["result"]["sessions"][0]["busy"], true);
        assert_eq!(list["result"]["sessions"][0]["cwd"], dir.to_str().unwrap());
        assert!(!String::from_utf8_lossy(&screen.lock()[before..]).contains("cd --"), "typed into a running program");

        // 5. The shell ends (tab closed) → session.closed; cd → not_found; the key opens a fresh tab.
        tx.send(Cmd::Data(b"\x03exit\r".to_vec())).unwrap();
        next(&mut r, |v| v["event"] == "session.closed" && v["params"]["session"] == sid.as_str()).await;
        next(&mut r2, |v| v["event"] == "session.closed").await;
        send(&mut w, json!({"id": 9, "method": "session.cd", "params": {"session": sid, "path": "/"}})).await;
        assert_eq!(next(&mut r, reply(9)).await["error"]["code"], "not_found");
        send(&mut w, json!({"id": 10, "method": "session.open", "params": {"key": "t"}})).await;
        assert_eq!(next(&mut r, reply(10)).await["result"]["reused"], false);

        // 6. run: output, exit status, then an interactive shell in the same tab.
        let mark = screen.lock().len();
        send(&mut w, json!({"id": 11, "method": "session.run", "params": {"argv": ["bash", "-c", "echo hi; exit 3"], "cwd": "/"}})).await;
        let run = next(&mut r, reply(11)).await["result"]["session"].as_str().unwrap().to_string();
        wait_until("run output", || String::from_utf8_lossy(&screen.lock()[mark..]).contains("[exited with status 3]")).await;
        assert!(String::from_utf8_lossy(&screen.lock()[mark..]).contains("hi"));
        wait_until("run shell idle", || ctl.0.sessions.lock().get(&run).is_some_and(|s| s.pty.as_ref().is_some_and(|(_, idle)| idle()))).await;

        // Errors.
        send(&mut w, json!({"id": 12, "method": "nope"})).await;
        assert_eq!(next(&mut r, reply(12)).await["error"]["code"], "unknown_method");
        send(&mut w, json!({"id": 13, "method": "session.run", "params": {"argv": []}})).await;
        assert_eq!(next(&mut r, reply(13)).await["error"]["code"], "bad_request");
        send(&mut w, json!({"id": 14, "method": "session.focus", "params": {"session": "missing"}})).await;
        assert_eq!(next(&mut r, reply(14)).await["error"]["code"], "not_found");
        let _ = std::fs::remove_dir_all(tmp);
        let _ = std::fs::remove_dir_all(sock.parent().unwrap());
    }

    #[test]
    fn osc7_across_chunks() {
        let mut o = crate::local::Osc7::default();
        assert!(o.feed(b"ls\r\n\x1b]7;file://pc/home/u/a%20b").is_empty());
        assert_eq!(o.feed(b"\x07$ "), ["/home/u/a b"]);
        assert!(o.feed(b"text \x1b]").is_empty());
        assert_eq!(o.feed(b"7;file:///tmp\x1b\\"), ["/tmp"]);
        assert_eq!(o.feed(b"\x1b]0;title\x07"), Vec::<String>::new());
    }
}
