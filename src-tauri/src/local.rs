use crate::ssh::{Cmd, Flow, Status};
use std::sync::Arc;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;

fn shell() -> CommandBuilder {
    #[cfg(windows)]
    return CommandBuilder::new("powershell.exe");
    #[cfg(target_os = "android")]
    return CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/system/bin/sh".into()));
    // Linux: each terminal in its own scope (like GNOME Terminal), so a big job started in it is
    // what systemd-oomd kills, not Kermius with every other tab.
    #[cfg(target_os = "linux")]
    {
        let prefix = crate::files::own_scope_prefix("kermius-term");
        if !prefix.is_empty() {
            let mut c = CommandBuilder::new(&prefix[0]);
            c.args(&prefix[1..]);
            c.args([std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), "-l".into()]);
            return c;
        }
    }
    #[cfg(not(any(windows, target_os = "android")))]
    return CommandBuilder::new_default_prog();
}

fn size(cols: u32, rows: u32) -> PtySize {
    PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 }
}

/// Control API hooks for one terminal (see `control.rs`).
pub struct Watch {
    /// The shell's working directory changed (OSC 7, or /proc on Linux).
    pub on_cwd: Box<dyn Fn(String) + Send + Sync>,
    /// The shell (or program) exited.
    pub on_exit: Box<dyn FnOnce() + Send>,
}

/// True while the shell itself owns the terminal (idle at its prompt, not running vim, a build…).
pub type Idle = Arc<dyn Fn() -> bool + Send + Sync>;

/// Spawn the user's shell in a local PTY; returns the command sender.
pub fn spawn(
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
    cwd: Option<String>,
) -> Result<mpsc::UnboundedSender<Cmd>, String> {
    spawn_cmd(shell(), cols, rows, on_data, on_status, flow, cwd, None).map(|(tx, _)| tx)
}

/// Like `spawn`, for the Control API: `argv` (when given) runs through the login shell, which then stays
/// as an interactive shell in the same folder; `env` is added; `watch` reports cwd changes and the exit.
#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
#[allow(clippy::too_many_arguments)]
pub fn spawn_controlled(
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
    cwd: Option<String>,
    argv: Option<Vec<String>>,
    env: Vec<(String, String)>,
    watch: Watch,
) -> Result<(mpsc::UnboundedSender<Cmd>, Idle), String> {
    let mut cmd = shell();
    if let Some(argv) = argv.filter(|a| !a.is_empty()) {
        // The user's profile sets PATH (~/.local/bin…); afterwards the tab keeps a shell with the exit status shown.
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let script = r#""$@"; s=$?; printf '\n\033[2m[exited with status %d]\033[0m\n' "$s"; exec "$SHELL" -l"#;
        let prefix = scope_prefix();
        cmd = CommandBuilder::new(prefix.first().map(String::as_str).unwrap_or(sh.as_str()));
        if !prefix.is_empty() {
            cmd.args(&prefix[1..]);
            cmd.arg(&sh);
        }
        cmd.args(["-lc", script, "_"]);
        cmd.args(&argv);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let (tx, idle) = spawn_cmd(cmd, cols, rows, on_data, on_status, flow, cwd, Some(watch))?;
    Ok((tx, idle.unwrap_or_else(|| Arc::new(|| true))))
}

#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
fn scope_prefix() -> Vec<String> {
    #[cfg(target_os = "linux")]
    return crate::files::own_scope_prefix("kermius-term");
    #[cfg(not(target_os = "linux"))]
    Vec::new()
}

/// Working directory of a process (None once it has exited).
#[cfg(target_os = "linux")]
fn pid_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn pid_cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    let n = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if n != size {
        return None;
    }
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    Some(path.to_string_lossy().into_owned())
}

/// Bash prints its folder as OSC 7 before each prompt (unless the user set their own PROMPT_COMMAND).
const OSC7_HOOK: &str = r#"printf '\033]7;file://%s%s\007' "${HOSTNAME:-}" "$PWD""#;

/// Finds OSC 7 (`ESC ] 7 ; file://host/path` ended by BEL or ST) in a byte stream split into chunks.
#[derive(Default)]
pub struct Osc7 {
    pending: Vec<u8>,
}

impl Osc7 {
    /// Paths reported in this chunk, percent-decoded.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(at) = find(&buf[i..], b"\x1b]7;").map(|p| p + i) {
            let body = at + 4;
            let end = buf[body..].iter().position(|&b| b == 0x07 || b == 0x1b).map(|p| p + body);
            let Some(end) = end else {
                // Unfinished: keep it for the next chunk (bounded, a path is never this long).
                if buf.len() - at < 8192 {
                    self.pending = buf[at..].to_vec();
                }
                return out;
            };
            if let Some(p) = file_url_path(&String::from_utf8_lossy(&buf[body..end])) {
                out.push(p);
            }
            i = end + 1;
        }
        // A sequence may start at the very end of this chunk.
        if let Some(k) = (1..4).find(|&k| buf.len() >= k && b"\x1b]7;".starts_with(&buf[buf.len() - k..])) {
            self.pending = buf[buf.len() - k..].to_vec();
        }
        out
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `file://host/a%20b` → `/a b`.
fn file_url_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&path[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Run `program args` in a local PTY (e.g. mosh).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn spawn_program(
    program: &str,
    args: &[String],
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
) -> Result<mpsc::UnboundedSender<Cmd>, String> {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    spawn_cmd(cmd, cols, rows, on_data, on_status, flow, None, None).map(|(tx, _)| tx)
}

#[allow(clippy::too_many_arguments)]
fn spawn_cmd(
    mut cmd: CommandBuilder,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
    cwd: Option<String>,
    watch: Option<Watch>,
) -> Result<(mpsc::UnboundedSender<Cmd>, Option<Idle>), String> {
    let e = |err: anyhow::Error| err.to_string();
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(e)?;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Apps started from the macOS Dock get no locale (Terminal.app sets one itself): the shell then
    // reads typed UTF-8 (Vietnamese đ, ệ…) byte by byte. Give it a UTF-8 one when none is set.
    let ctype = ["LC_ALL", "LC_CTYPE", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()));
    if !ctype.is_some_and(|v| v.to_ascii_lowercase().replace('-', "").contains("utf8")) {
        let utf8 = if cfg!(target_os = "macos") { "en_US.UTF-8" } else { "C.UTF-8" };
        cmd.env_remove("LC_ALL");
        cmd.env("LANG", utf8);
        cmd.env("LC_CTYPE", utf8);
    }
    if watch.is_some() && std::env::var_os("PROMPT_COMMAND").is_none() {
        cmd.env("PROMPT_COMMAND", OSC7_HOOK);
    }
    // A requested folder (Integration API) if it exists, else home.
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()).map(std::path::PathBuf::from).or_else(dirs::home_dir) {
        cmd.cwd(dir);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(e)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e)?;
    let mut writer = pair.master.take_writer().map_err(e)?;
    let master = Arc::new(parking_lot::Mutex::new(pair.master));
    let pid = child.process_id();

    let (on_cwd, on_exit) = match watch {
        Some(w) => (Some(Arc::new(w.on_cwd)), Some(w.on_exit)),
        None => (None, None),
    };
    let idle: Option<Idle> = on_cwd.as_ref().map(|_| {
        let m = master.clone();
        // The shell is in charge when the terminal's foreground process group is its own.
        Arc::new(move || {
            #[cfg(unix)]
            return pid.is_some_and(|p| m.lock().process_group_leader() == Some(p as i32));
            #[cfg(not(unix))]
            true
        }) as Idle
    });
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if let (Some(cb), Some(p)) = (on_cwd.clone(), pid) {
        // Shells without the OSC 7 hook (own PROMPT_COMMAND, zsh, fish): follow the process's folder.
        std::thread::spawn(move || {
            let mut last = String::new();
            while let Some(dir) = pid_cwd(p) {
                if dir != last {
                    cb(dir.clone());
                    last = dir;
                }
                std::thread::sleep(std::time::Duration::from_millis(700));
            }
        });
    }

    let status = on_status.clone();
    let osc_cb = on_cwd.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut osc7 = Osc7::default();
        loop {
            // Stop reading while the UI is behind: the shell's writes then block (backpressure).
            if flow.blocked() {
                flow.wait_drained();
            }
            let Ok(n @ 1..) = reader.read(&mut buf) else { break };
            flow.sent(n);
            if let Some(cb) = &osc_cb {
                for p in osc7.feed(&buf[..n]) {
                    cb(p);
                }
            }
            if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        let _ = status.send(Status::Closed);
        if let Some(f) = on_exit {
            f();
        }
    });
    let _ = on_status.send(Status::Connected);

    let (tx, mut rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                Cmd::Data(d) => {
                    if writer.write_all(&d).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                Cmd::Resize(c, r) => {
                    let _ = master.lock().resize(size(c, r));
                }
                Cmd::Upload { reply, .. } => {
                    let _ = reply.send(Err("Not available for local terminals".into()));
                }
                Cmd::Close => break,
            }
        }
        let _ = child.kill();
    });
    Ok((tx, idle))
}
