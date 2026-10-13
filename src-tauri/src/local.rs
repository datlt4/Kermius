use crate::ssh::{Cmd, Status};
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
) -> Result<mpsc::UnboundedSender<Cmd>, String> {
    let e = |err: anyhow::Error| err.to_string();
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(e)?;
    let mut cmd = shell();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(e)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(e)?;
    let mut writer = pair.master.take_writer().map_err(e)?;
    let master = pair.master;

    let status = on_status.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
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
                Cmd::Close => break,
            }
        }
        let _ = child.kill();
    });
    Ok(tx)
}
