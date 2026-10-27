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
    #[cfg(not(any(windows, target_os = "android")))]
    return CommandBuilder::new_default_prog();
}

fn size(cols: u32, rows: u32) -> PtySize {
    PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 }
}

/// Spawn the user's shell in a local PTY; returns the command sender.
pub fn spawn(
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
    cwd: Option<String>,
) -> Result<mpsc::UnboundedSender<Cmd>, String> {
    spawn_cmd(shell(), cols, rows, on_data, on_status, flow, cwd)
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
    spawn_cmd(cmd, cols, rows, on_data, on_status, flow, None)
}

fn spawn_cmd(
    mut cmd: CommandBuilder,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_status: Channel<Status>,
    flow: Arc<Flow>,
    cwd: Option<String>,
) -> Result<mpsc::UnboundedSender<Cmd>, String> {
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
    // A requested folder (Integration API) if it exists, else home.
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()).map(std::path::PathBuf::from).or_else(dirs::home_dir) {
        cmd.cwd(dir);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(e)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e)?;
    let mut writer = pair.master.take_writer().map_err(e)?;
    let master = pair.master;

    let status = on_status.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            // Stop reading while the UI is behind: the shell's writes then block (backpressure).
            if flow.blocked() {
                flow.wait_drained();
            }
            let Ok(n @ 1..) = reader.read(&mut buf) else { break };
            flow.sent(n);
            if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        let _ = status.send(Status::Closed);
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
                    let _ = master.resize(size(c, r));
                }
                Cmd::Upload { reply, .. } => {
                    let _ = reply.send(Err("Not available for local terminals".into()));
                }
                Cmd::Close => break,
            }
        }
        let _ = child.kill();
    });
    Ok(tx)
}
