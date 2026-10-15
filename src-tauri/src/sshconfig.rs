//! Export hosts to OpenSSH's `~/.ssh/config`, inside a marked block that re-exports replace;
//! import hosts from it.
use crate::model::{now_ms, Host, Key, Vault};
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

// ---------- import ----------

/// One `Host` entry read from an ssh config.
#[derive(Debug, Default, PartialEq)]
pub struct Entry {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub identity: String,
    pub folder: String,
}

/// `*` and `?` wildcards, for `Include` globs.
fn wild(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => wild(&p[1..], s) || (!s.is_empty() && wild(p, &s[1..])),
        (Some(b'?'), Some(_)) => wild(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => wild(&p[1..], &s[1..]),
        _ => false,
    }
}

fn expand(path: &str, home: &Path, base: &Path) -> std::path::PathBuf {
    let p = path.trim_matches('"').replace("%d", &home.to_string_lossy());
    if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(&p).is_absolute() {
        p.into()
    } else {
        base.join(p)
    }
}

/// Lines of a config with `Include`s inlined (relative includes are under `~/.ssh`).
fn lines(file: &Path, home: &Path, depth: u32, out: &mut Vec<String>) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let ssh_dir = home.join(".ssh");
    for line in text.lines() {
        let t = line.trim();
        let (key, val) = t.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((t, ""));
        if key.eq_ignore_ascii_case("include") && depth < 8 {
            for pat in val.split_whitespace() {
                let pat = expand(pat, home, &ssh_dir);
                let (dir, name) = (pat.parent().unwrap_or(&ssh_dir).to_path_buf(), pat.file_name().unwrap_or_default().to_string_lossy().into_owned());
                let mut files: Vec<_> = std::fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| wild(name.as_bytes(), p.file_name().unwrap_or_default().to_string_lossy().as_bytes()))
                    .collect();
                files.sort();
                for f in files {
                    lines(&f, home, depth + 1, out);
                }
            }
        } else {
            out.push(line.to_string());
        }
    }
}

/// Parse `file` (following `Include`). `Host *` values fill in missing User/Port/IdentityFile;
/// "# ===== Group =====" comments (as written by the export) set the group.
pub fn parse(file: &Path, home: &Path) -> Vec<Entry> {
    let mut all = Vec::new();
    lines(file, home, 0, &mut all);
    let (mut entries, mut defaults, mut folder) = (Vec::<Entry>::new(), Entry::default(), String::new());
    // Where the current block's settings go: an entry, the `Host *` defaults, or nowhere (patterns, Match).
    enum Target { Entry, Defaults, Skip }
    let mut target = Target::Skip;
    for line in all {
        let t = line.trim();
        if let Some(g) = t.strip_prefix("# =====").and_then(|g| g.strip_suffix("=====")) {
            folder = g.trim().to_string();
            if folder == "(no group)" {
                folder.clear();
            }
            continue;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (key, val) = t.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((t, ""));
        let val = val.trim().trim_start_matches('=').trim().trim_matches('"').to_string();
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                let names: Vec<&str> = val.split_whitespace().collect();
                target = if names == ["*"] {
                    Target::Defaults
                } else if let Some(alias) = names.iter().find(|n| !n.contains(['*', '?', '!'])) {
                    entries.push(Entry { alias: alias.to_string(), folder: folder.clone(), ..Default::default() });
                    Target::Entry
                } else {
                    Target::Skip
                };
            }
            "match" => target = Target::Skip,
            k => {
                let e = match target {
                    Target::Entry => entries.last_mut().unwrap(),
                    Target::Defaults => &mut defaults,
                    Target::Skip => continue,
                };
                // First value wins, as in ssh.
                match k {
                    "hostname" if e.hostname.is_empty() => e.hostname = val,
                    "port" if e.port == 0 => e.port = val.parse().unwrap_or(0),
                    "user" if e.user.is_empty() => e.user = val,
                    "identityfile" if e.identity.is_empty() => e.identity = expand(&val, home, home).to_string_lossy().into_owned(),
                    _ => {}
                }
            }
        }
    }
    for e in &mut entries {
        if e.hostname.is_empty() {
            e.hostname = e.alias.clone();
        }
        if e.port == 0 {
            e.port = if defaults.port == 0 { 22 } else { defaults.port };
        }
        if e.user.is_empty() {
            e.user = defaults.user.clone();
        }
        if e.identity.is_empty() {
            e.identity = defaults.identity.clone();
        }
    }
    entries
}

/// Keychain id for an IdentityFile: an existing key with the same content, or a new one named after the file.
fn keychain_key(vault: &mut Vault, path: &str) -> String {
    let Some(text) = std::fs::read_to_string(path).ok().filter(|k| k.contains("PRIVATE KEY")) else { return String::new() };
    if let Some(k) = vault.keys.iter().find(|k| !k.deleted && k.private_key.trim() == text.trim()) {
        return k.id.clone();
    }
    // Encrypted keys cannot be decoded without the passphrase: take the public key from the .pub file.
    let public_key = russh::keys::decode_secret_key(&text, None)
        .ok()
        .and_then(|k| k.public_key().to_openssh().ok())
        .or_else(|| std::fs::read_to_string(format!("{path}.pub")).ok().map(|p| p.trim().to_string()))
        .unwrap_or_default();
    let id = uuid::Uuid::new_v4().to_string();
    vault.keys.push(Key {
        id: id.clone(),
        label: Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "imported key".into()),
        private_key: text,
        public_key,
        updated_at: now_ms(),
        ..Default::default()
    });
    id
}

/// Add the hosts of ssh config entries. A host already in the vault (same address, port and user,
/// whatever its name, e.g. "web 01" exported as "web-01") is skipped, except that one without any
/// credentials gets the entry's key. Several aliases of one machine give one host.
/// IdentityFile keys go into the keychain (synced, shared by the hosts using them).
pub fn import(vault: &mut Vault, entries: Vec<Entry>) -> crate::termix::ImportReport {
    let mut report = crate::termix::ImportReport { added: 0, updated: 0, skipped: 0 };
    for en in entries {
        let found = vault.hosts.iter().position(|h| !h.deleted && h.address == en.hostname && h.port == en.port && h.username == en.user);
        match found {
            Some(i) => {
                let h = &vault.hosts[i];
                let bare = h.password.is_empty() && h.private_key.trim().is_empty() && h.key_id.is_empty() && h.identity_id.is_empty();
                let key_id = if bare && !en.identity.is_empty() { keychain_key(vault, &en.identity) } else { String::new() };
                if key_id.is_empty() {
                    report.skipped += 1;
                } else {
                    let h = &mut vault.hosts[i];
                    h.key_id = key_id;
                    h.updated_at = now_ms();
                    report.updated += 1;
                }
            }
            None => {
                let key_id = if en.identity.is_empty() { String::new() } else { keychain_key(vault, &en.identity) };
                vault.hosts.push(Host {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: en.alias,
                    address: en.hostname,
                    port: en.port,
                    username: en.user,
                    key_id,
                    folder: if en.folder.is_empty() { "SSH config".into() } else { en.folder },
                    updated_at: now_ms(),
                    ..Default::default()
                });
                report.added += 1;
            }
        }
    }
    report
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
        a.tunnels = vec![Tunnel { source_port: 8080, endpoint_host: "localhost".into(), endpoint_port: 80, ..Default::default() }];
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

    #[test]
    fn parses_config_with_includes_defaults_and_groups() {
        let home = std::env::temp_dir().join(format!("kermius-sshimp-{}", uuid::Uuid::new_v4()));
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
        std::fs::write(ssh.join("id_test"), "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n").unwrap();
        std::fs::write(ssh.join("id_test.pub"), "ssh-ed25519 AAAA test\n").unwrap();
        std::fs::write(ssh.join("conf.d/extra.conf"), "Host pi\n  HostName 10.0.0.5\n").unwrap();
        std::fs::write(
            ssh.join("config"),
            "Include conf.d/*.conf\nHost *\n  User koi\n  IdentityFile ~/.ssh/id_test\n\n# ===== Lab =====\nHost orin2 orin2-alias\n  HostName=100.96.1.66\n  Port 2222\n  User aiserver\nHost *.lan\n  User nobody\nHost bare\nHost orin2-wg\n  HostName 100.96.1.66\n  Port 2222\n  User aiserver\n",
        )
        .unwrap();
        let e = parse(&ssh.join("config"), &home);
        let key = ssh.join("id_test").to_string_lossy().into_owned();
        assert_eq!(e.len(), 4, "{e:?}");
        assert_eq!(e[0], Entry { alias: "pi".into(), hostname: "10.0.0.5".into(), port: 22, user: "koi".into(), identity: key.clone(), folder: "".into() });
        assert_eq!(e[1], Entry { alias: "orin2".into(), hostname: "100.96.1.66".into(), port: 2222, user: "aiserver".into(), identity: key.clone(), folder: "Lab".into() });
        assert_eq!((e[2].alias.as_str(), e[2].hostname.as_str(), e[2].user.as_str()), ("bare", "bare", "koi"));

        // "pi" is already there under another name and without credentials: it only gets the key.
        let mut vault = Vault::default();
        vault.hosts.push(Host { id: "old".into(), name: "Raspberry Pi".into(), address: "10.0.0.5".into(), port: 22, username: "koi".into(), ..Default::default() });
        let r = import(&mut vault, parse(&ssh.join("config"), &home));
        // orin2-wg is another alias of orin2: one host.
        assert_eq!((r.added, r.updated, r.skipped), (2, 1, 1));
        assert_eq!(vault.hosts.len(), 3);
        assert_eq!(vault.hosts[0].name, "Raspberry Pi");
        // Everything there already: nothing changes.
        let before = vault.hosts.clone();
        let r = import(&mut vault, parse(&ssh.join("config"), &home));
        assert_eq!((r.added, r.updated, r.skipped), (0, 0, 4));
        assert_eq!(vault.hosts, before);
        // One keychain entry shared by every host using the file, also after re-importing.
        assert_eq!(vault.keys.len(), 1);
        assert_eq!((vault.keys[0].label.as_str(), vault.keys[0].public_key.as_str()), ("id_test", "ssh-ed25519 AAAA test"));
        assert!(vault.hosts.iter().all(|h| h.key_id == vault.keys[0].id && h.private_key.is_empty()));
        // Hosts after a "# ===== Lab =====" line belong to that group.
        assert_eq!((vault.hosts[1].folder.as_str(), vault.hosts[2].folder.as_str()), ("Lab", "Lab"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
