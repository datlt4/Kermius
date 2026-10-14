//! Export hosts to OpenSSH's `~/.ssh/config`, inside a marked block that re-exports replace.
use crate::model::Vault;
use std::collections::HashSet;
use std::path::Path;

const BEGIN: &str = "# >>> Kermius (generated; re-exporting replaces this block) >>>";
const END: &str = "# <<< Kermius <<<";
/// Private keys go here, one file per host alias.
const KEY_DIR: &str = "kermius";

/// Rendered config plus the key files it refers to (alias, key text).
pub struct Export {
    pub config: String,
    pub keys: Vec<(String, String)>,
}

/// `Host` aliases cannot contain whitespace or pattern characters.
fn alias(name: &str) -> String {
    let a: String = name.trim().chars().map(|c| if c.is_whitespace() || "*?!,#\"'".contains(c) { '-' } else { c }).collect();
    if a.is_empty() { "host".into() } else { a }
}

/// `with_passwords`: add each password as a comment line (plain text) so it is easy to copy.
pub fn render(vault: &Vault, ids: &[String], with_keys: bool, with_passwords: bool) -> Export {
    let wanted: HashSet<&String> = ids.iter().collect();
    // Telnet, serial and VNC hosts have no ssh config equivalent.
    let ssh = |p: &str| matches!(p, "" | "ssh" | "mosh");
    let mut hosts: Vec<_> = vault.hosts.iter().filter(|h| !h.deleted && ssh(&h.protocol) && wanted.contains(&h.id)).map(|h| vault.resolve(h.clone())).collect();
    hosts.sort_by(|a, b| (a.folder.to_lowercase(), a.name.to_lowercase()).cmp(&(b.folder.to_lowercase(), b.name.to_lowercase())));
    let (mut config, mut keys, mut used) = (String::new(), Vec::new(), HashSet::new());
    let mut folder = None;
    for h in hosts {
        if folder != Some(h.folder.clone()) {
            config.push_str(&format!("\n# ===== {} =====\n", if h.folder.is_empty() { "(no group)" } else { &h.folder }));
            folder = Some(h.folder.clone());
        }
        let base = alias(&h.name);
        let mut name = base.clone();
        for n in 2.. {
            if used.insert(name.clone()) {
                break;
            }
            name = format!("{base}-{n}");
        }
        config.push_str(&format!("\nHost {name}\n    HostName {}\n", h.address));
        if h.port != 0 && h.port != 22 {
            config.push_str(&format!("    Port {}\n", h.port));
        }
        if !h.username.is_empty() {
            config.push_str(&format!("    User {}\n", h.username));
        }
        if with_keys && !h.private_key.trim().is_empty() {
            config.push_str(&format!("    IdentityFile ~/.ssh/{KEY_DIR}/{name}\n    IdentitiesOnly yes\n"));
            keys.push((name.clone(), format!("{}\n", h.private_key.trim_end())));
        }
        if with_passwords && !h.password.is_empty() {
            config.push_str(&format!("    # {}\n", h.password.replace(['\n', '\r'], " ")));
        }
        for t in &h.tunnels {
            let bind = if t.bind_host.is_empty() { String::new() } else { format!("{}:", t.bind_host) };
            config.push_str(&format!("    LocalForward {bind}{} {}:{}\n", t.source_port, t.endpoint_host, t.endpoint_port));
        }
    }
    Export { config, keys }
}

/// `existing` with the Kermius block replaced (or appended) by `body`.
fn with_block(existing: &str, body: &str) -> String {
    let block = format!("{BEGIN}\n{}\n{END}\n", body.trim());
    match (existing.find(BEGIN), existing.find(END)) {
        (Some(s), Some(e)) if e > s => format!("{}{block}{}", &existing[..s], existing[e + END.len()..].trim_start_matches('\n')),
        _ if existing.trim().is_empty() => block,
        _ => format!("{}\n\n{block}", existing.trim_end()),
    }
}

/// Write the block into `<ssh_dir>/config` and the keys into `<ssh_dir>/kermius/`. Returns the config path.
pub fn write(ssh_dir: &Path, ex: &Export) -> std::io::Result<String> {
    // ssh refuses keys (and configs) readable by others.
    #[cfg(unix)]
    let set = |p: &Path, mode| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
    };
    #[cfg(not(unix))]
    let set = |_: &Path, _: u32| std::io::Result::Ok(());
    if !ssh_dir.exists() {
        std::fs::create_dir_all(ssh_dir)?;
        set(ssh_dir, 0o700)?;
    }
    // Key folder belongs to Kermius: drop keys of hosts no longer exported.
    let key_dir = ssh_dir.join(KEY_DIR);
    let _ = std::fs::remove_dir_all(&key_dir);
    if !ex.keys.is_empty() {
        std::fs::create_dir_all(&key_dir)?;
        set(&key_dir, 0o700)?;
        for (name, key) in &ex.keys {
            let p = key_dir.join(name);
            std::fs::write(&p, key)?;
            set(&p, 0o600)?;
        }
    }
    let path = ssh_dir.join("config");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let backup = ssh_dir.join("config.before-kermius");
    if !existing.is_empty() && !existing.contains(BEGIN) && !backup.exists() {
        std::fs::write(&backup, &existing)?;
        set(&backup, 0o600)?;
    }
    let tmp = ssh_dir.join("config.kermius-tmp");
    std::fs::write(&tmp, with_block(&existing, &ex.config))?;
    set(&tmp, 0o600)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Host, Key, Tunnel};

    fn host(id: &str, name: &str, folder: &str) -> Host {
        Host { id: id.into(), name: name.into(), address: format!("{id}.lan"), port: 22, username: "me".into(), folder: folder.into(), ..Default::default() }
    }

    #[test]
    fn renders_and_replaces_block() {
        let mut vault = Vault::default();
        let mut a = host("a", "web 01", "Prod");
        a.port = 2222;
        a.key_id = "k".into();
        a.tunnels = vec![Tunnel { bind_host: String::new(), source_port: 8080, endpoint_host: "localhost".into(), endpoint_port: 80 }];
        vault.keys = vec![Key { id: "k".into(), private_key: "-----KEY-----".into(), ..Default::default() }];
        vault.hosts = vec![a, host("b", "web 01", "Prod"), host("c", "nas", ""), host("d", "skipped", "")];
        vault.hosts[1].password = "s3cret/".into();
        let ex = render(&vault, &["a".into(), "b".into(), "c".into()], true, true);
        assert_eq!(
            ex.config,
            "\n# ===== (no group) =====\n\nHost nas\n    HostName c.lan\n    User me\n\n# ===== Prod =====\n\nHost web-01\n    HostName a.lan\n    Port 2222\n    User me\n    IdentityFile ~/.ssh/kermius/web-01\n    IdentitiesOnly yes\n    LocalForward 8080 localhost:80\n\nHost web-01-2\n    HostName b.lan\n    User me\n    # s3cret/\n"
        );
        assert_eq!(ex.keys, [("web-01".to_string(), "-----KEY-----\n".to_string())]);

        let dir = std::env::temp_dir().join(format!("kermius-sshcfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config"), "Host mine\n    HostName mine.lan\n").unwrap();
        write(&dir, &ex).unwrap();
        assert!(!render(&vault, &["b".into()], true, false).config.contains("s3cret"));
        write(&dir, &render(&vault, &["c".into()], true, false)).unwrap();
        let cfg = std::fs::read_to_string(dir.join("config")).unwrap();
        assert!(cfg.starts_with("Host mine\n    HostName mine.lan\n\n# >>> Kermius"), "{cfg}");
        assert_eq!(cfg.matches(BEGIN).count(), 1);
        assert!(cfg.contains("Host nas") && !cfg.contains("web-01"));
        assert!(!dir.join("kermius/web-01").exists(), "keys of hosts no longer exported are removed");
        assert_eq!(std::fs::read_to_string(dir.join("config.before-kermius")).unwrap(), "Host mine\n    HostName mine.lan\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
