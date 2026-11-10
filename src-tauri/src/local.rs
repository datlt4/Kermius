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

/// Largest message the sender builds out of merged reads.
const MERGE_MAX: usize = 256 * 1024;

/// Bash prints its folder as OSC 7 before each prompt (unless the user set their own PROMPT_COMMAND).
const OSC7_HOOK: &str = r#"printf '\033]7;file://%s%s\007' "${HOSTNAME:-}" "$PWD""#;

/// zsh: a ZDOTDIR whose startup files load the user's own (from $KERMIUS_USER_ZDOTDIR or $HOME) and then add a
/// precmd hook printing OSC 7, the way VS Code injects its shell integration. Written once per run.
#[cfg(unix)]
fn zsh_hook_dir() -> Option<std::path::PathBuf> {
    static DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("kermius-zsh-{}", unsafe { libc::getuid() }));
        std::fs::create_dir_all(&dir).ok()?;
        let load = |f: &str| format!("_k_z=$ZDOTDIR; ZDOTDIR=${{KERMIUS_USER_ZDOTDIR:-$HOME}}; [[ -r $ZDOTDIR/{f} ]] && . $ZDOTDIR/{f}; ZDOTDIR=$_k_z\n");
        let hook = "_kermius_osc7() { printf '\\033]7;file://%s%s\\007' \"$HOST\" \"$PWD\"; }; typeset -ga precmd_functions; precmd_functions+=(_kermius_osc7)\n";
        let files = [
            (".zshenv", load(".zshenv")),
            (".zprofile", load(".zprofile")),
            // /etc/zshrc (macOS) put HISTFILE under this folder: keep the user's history file.
            (".zshrc", format!("[[ $HISTFILE == $ZDOTDIR/* ]] && HISTFILE=${{KERMIUS_USER_ZDOTDIR:-$HOME}}/${{HISTFILE:t}}\n{}{hook}", load(".zshrc"))),
            // Last startup file of an interactive shell: from here on ZDOTDIR is the user's again. A `zsh -lc`
            // (session.run) keeps the shim so the shell it execs afterwards gets the hook too.
            (".zlogin", format!("{}[[ -o interactive ]] && {{ ZDOTDIR=${{KERMIUS_USER_ZDOTDIR:-$HOME}}; unset KERMIUS_USER_ZDOTDIR _k_z; }}\n", load(".zlogin"))),
        ];
        for (name, body) in files {
            std::fs::write(dir.join(name), body).ok()?;
        }
        Some(dir)
    })
    .clone()
}

/// When a new shell may take commands: after its first prompt (the OSC 7 hook), or for shells without the
/// hook, once output has been quiet for a moment after a few seconds.
struct Ready {
    start: std::time::Instant,
    prompt: std::sync::atomic::AtomicBool,
    last_output: parking_lot::Mutex<std::time::Instant>,
}

impl Ready {
    fn get(&self) -> bool {
        use std::time::Duration;
        self.prompt.load(std::sync::atomic::Ordering::Relaxed)
            || (self.start.elapsed() > Duration::from_secs(5) && self.last_output.lock().elapsed() > Duration::from_millis(300))
    }
}

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
    // Kermius sets Malloc=1 for its own WebKit (lib.rs): the shell and the programs in it must not inherit it.
    if crate::SET_MALLOC_ENV.load(std::sync::atomic::Ordering::Relaxed) {
        cmd.env_remove("Malloc");
    }
    // Apps started from the macOS Dock get no locale (Terminal.app sets one itself): the shell then
    // reads typed UTF-8 (Vietnamese đ, ệ…) byte by byte. Give it a UTF-8 one when none is set.
    let ctype = ["LC_ALL", "LC_CTYPE", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()));
    if !ctype.is_some_and(|v| v.to_ascii_lowercase().replace('-', "").contains("utf8")) {
        let utf8 = if cfg!(target_os = "macos") { "en_US.UTF-8" } else { "C.UTF-8" };
        cmd.env_remove("LC_ALL");
        cmd.env("LANG", utf8);
        cmd.env("LC_CTYPE", utf8);
    }
    if watch.is_some() {
        if std::env::var_os("PROMPT_COMMAND").is_none() {
            cmd.env("PROMPT_COMMAND", OSC7_HOOK);
        }
        #[cfg(unix)]
        if let Some(dir) = zsh_hook_dir() {
            if let Some(orig) = std::env::var_os("ZDOTDIR") {
                cmd.env("KERMIUS_USER_ZDOTDIR", orig);
            }
            cmd.env("ZDOTDIR", dir);
        }
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
    let now = std::time::Instant::now();
    let ready = Arc::new(Ready { start: now, prompt: false.into(), last_output: parking_lot::Mutex::new(now) });
    let idle: Option<Idle> = on_cwd.as_ref().map(|_| {
        let (m, ready) = (master.clone(), ready.clone());
        // Idle: past its first prompt, and the terminal's foreground process group is the shell's own.
        Arc::new(move || {
            #[cfg(unix)]
            return ready.get() && pid.is_some_and(|p| m.lock().process_group_leader() == Some(p as i32));
            #[cfg(not(unix))]
            ready.get()
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
    // A pty hands over a few KB per read: a busy build would become thousands of IPC messages a second, each an
    // ArrayBuffer the page must allocate and collect. The reader passes chunks on; the sender merges what arrives
    // within a few ms (like the SSH path) into one message.
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
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
                *ready.last_output.lock() = std::time::Instant::now();
                for p in osc7.feed(&buf[..n]) {
                    ready.prompt.store(true, std::sync::atomic::Ordering::Relaxed);
                    cb(p);
                }
            }
            if chunk_tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        while let Ok(mut out) = chunk_rx.recv() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(4);
            while out.len() < MERGE_MAX {
                match chunk_rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
                    Ok(more) => out.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if on_data.send(InvokeResponseBody::Raw(out)).is_err() {
                break;
            }
        }
        // The reader has ended and everything it read was sent: now the tab can say the shell is gone.
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

#[cfg(all(test, unix, not(any(target_os = "ios", target_os = "android"))))]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    /// A flood of output arrives complete and in order after the sender merges the reads.
    #[test]
    fn merged_reads_keep_every_byte() {
        const N: u64 = 200_000;
        let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
        let messages = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (s2, m2) = (seen.clone(), messages.clone());
        let data = Channel::new(move |b| {
            if let InvokeResponseBody::Raw(b) = b {
                s2.lock().extend_from_slice(&b);
                m2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(())
        });
        let status: Channel<Status> = Channel::new(|_| Ok(()));
        let watch = Watch { on_cwd: Box::new(|_| {}), on_exit: Box::new(|| {}) };
        let argv = vec!["seq".to_string(), "1".into(), N.to_string()];
        let (_tx, _idle) = spawn_controlled(120, 30, data, status, Arc::new(Flow::default()), None, Some(argv), Vec::new(), watch).unwrap();
        let marker = b"[exited with status 0]";
        let t0 = std::time::Instant::now();
        while !seen.lock().windows(marker.len()).any(|w| w == marker) {
            assert!(t0.elapsed() < std::time::Duration::from_secs(60), "output never finished");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let text = String::from_utf8_lossy(&seen.lock()).into_owned();
        let numbers: Vec<u64> = text.split("\r\n").filter_map(|l| l.trim().parse().ok()).collect();
        assert_eq!(numbers, (1..=N).collect::<Vec<_>>(), "bytes lost or reordered");
        // Unmerged, a pty read is about 4 KB: this output (~1.3 MB) would be 300+ messages.
        let n = messages.load(std::sync::atomic::Ordering::Relaxed);
        assert!(n < 120, "{n} messages: reads were not merged");
    }
}
