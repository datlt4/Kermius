use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tunnel {
    /// Display name (empty: "host:port" is shown).
    pub label: String,
    pub bind_host: String,
    pub source_port: u16,
    pub endpoint_host: String,
    pub endpoint_port: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub private_key: String,
    pub key_passphrase: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub tunnels: Vec<Tunnel>,
    /// Keychain references; host fields take precedence when set.
    pub identity_id: String,
    pub key_id: String,
    /// "ssh" (or empty), "mosh", "telnet", "serial" (address = device path) or "vnc".
    pub protocol: String,
    /// Serial only; 0 = 115200.
    pub baud: u32,
    /// SSH: reach the host through this other vault host (a bastion / jump host).
    /// Jump hosts in connection order (first hop first); replaces `jump_host_id` when set.
    pub jump_chain: Vec<String>,
    pub jump_host_id: String,
    /// SSH: `socks5://[user:pass@]host:port` or `http://[user:pass@]host:port`.
    pub proxy: String,
    /// SSH: forward the local ssh-agent to the host.
    pub agent_forward: bool,
    /// SSH: environment variables sent before the shell starts, one `NAME=value` per line.
    pub env: String,
    /// SSH: snippet typed into the shell once it opens.
    pub startup_snippet_id: String,
    /// Position within its group (drag & drop); ties sort by name.
    pub order: f64,
    /// Also reach this address with Nearby Share (LocalSend protocol), e.g. across a VPN.
    pub nearby: bool,
    /// VNC only: watch without sending mouse/keyboard input.
    pub view_only: bool,
    /// VNC only: do not sync the clipboard with the remote desktop.
    pub no_clipboard: bool,
    pub updated_at: i64,
    /// Tombstone so deletions propagate through sync.
    pub deleted: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KnownHost {
    /// "address:port"
    pub id: String,
    pub fingerprint: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub script: String,
    pub updated_at: i64,
    pub deleted: bool,
}

/// A machine to wake up with a magic packet (Wake on LAN).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WolDevice {
    pub id: String,
    pub name: String,
    pub mac: String,
    /// Broadcast address of the target's network; empty = 255.255.255.255.
    pub broadcast: String,
    /// UDP port; 0 = 9.
    pub port: u16,
    /// SSH host that sends the packet on the same LAN (for VPN access); empty = this computer.
    pub relay: String,
    pub updated_at: i64,
    pub deleted: bool,
}

/// Keychain: an SSH private key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Key {
    pub id: String,
    pub label: String,
    pub private_key: String,
    pub passphrase: String,
    pub public_key: String,
    pub updated_at: i64,
    pub deleted: bool,
}

/// Keychain: reusable credentials (username + password and/or key).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    pub id: String,
    pub label: String,
    pub username: String,
    pub password: String,
    pub key_id: String,
    pub updated_at: i64,
    pub deleted: bool,
}

/// Everything that gets synced (end-to-end encrypted).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vault {
    pub hosts: Vec<Host>,
    pub known_hosts: Vec<KnownHost>,
    pub snippets: Vec<Snippet>,
    pub keys: Vec<Key>,
    pub identities: Vec<Identity>,
    pub wol: Vec<WolDevice>,
    /// Collections from newer app versions, kept and merged so syncing never drops them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    pub url: String,
    pub token: String,
    pub passphrase: String,
    pub last_sync: i64,
}

/// Device-local state: the vault plus settings that never leave this device.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalState {
    pub vault: Vault,
    pub sync: SyncSettings,
    /// Folder Sync jobs (paths are device-specific, so never synced).
    pub folder_syncs: Vec<crate::foldersync::Job>,
    /// This computer's password for the local terminal's "Type password" (never synced).
    pub local_password: String,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-item last-writer-wins merge keyed by id.
fn merge_items<T: Clone + Serialize>(a: &[T], b: &[T], id: fn(&T) -> &str, ts: fn(&T) -> i64) -> Vec<T> {
    // Equal timestamps with different content (e.g. a field an older version dropped): pick the
    // same copy on every device, so they converge instead of overwriting each other.
    let tie_wins = |new: &T, old: &T| serde_json::to_string(new).ok() > serde_json::to_string(old).ok();
    let mut out: Vec<T> = a.to_vec();
    for item in b {
        match out.iter_mut().find(|x| id(x) == id(item)) {
            Some(x) if ts(item) > ts(x) || (ts(item) == ts(x) && tie_wins(item, x)) => *x = item.clone(),
            Some(_) => {}
            None => out.push(item.clone()),
        }
    }
    out
}

/// Merge unknown collections: arrays of `{id, updatedAt}` objects by id, anything else prefers `a`.
fn merge_extra(
    a: &serde_json::Map<String, serde_json::Value>,
    b: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let id = |v: &Value| v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let ts = |v: &Value| v.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
    let mut out = a.clone();
    for (k, bv) in b {
        match (out.get(k), bv) {
            (Some(Value::Array(av)), Value::Array(bv)) => {
                let mut merged = av.clone();
                for item in bv {
                    match merged.iter_mut().find(|x| id(x) == id(item)) {
                        Some(x) if ts(item) > ts(x) => *x = item.clone(),
                        Some(_) => {}
                        None => merged.push(item.clone()),
                    }
                }
                out.insert(k.clone(), Value::Array(merged));
            }
            (Some(_), _) => {}
            (None, _) => {
                out.insert(k.clone(), bv.clone());
            }
        }
    }
    out
}

impl Vault {
    /// Fill empty credentials of `host` from its identity and key.
    pub fn resolve(&self, mut host: Host) -> Host {
        let identity = self.identities.iter().find(|i| !i.deleted && !i.id.is_empty() && i.id == host.identity_id);
        if let Some(i) = identity {
            if host.username.is_empty() {
                host.username = i.username.clone();
            }
            if host.password.is_empty() {
                host.password = i.password.clone();
            }
        }
        let key_id = Some(host.key_id.as_str()).filter(|k| !k.is_empty()).or(identity.map(|i| i.key_id.as_str()));
        if let Some(k) = key_id.and_then(|id| self.keys.iter().find(|k| !k.deleted && k.id == id)) {
            if host.private_key.trim().is_empty() {
                host.private_key = k.private_key.clone();
                host.key_passphrase = k.passphrase.clone();
            }
        }
        host
    }
}

pub fn merge(a: &Vault, b: &Vault) -> Vault {
    Vault {
        hosts: merge_items(&a.hosts, &b.hosts, |h| &h.id, |h| h.updated_at),
        known_hosts: merge_items(&a.known_hosts, &b.known_hosts, |k| &k.id, |k| k.updated_at),
        snippets: merge_items(&a.snippets, &b.snippets, |s| &s.id, |s| s.updated_at),
        keys: merge_items(&a.keys, &b.keys, |k| &k.id, |k| k.updated_at),
        identities: merge_items(&a.identities, &b.identities, |i| &i.id, |i| i.updated_at),
        wol: merge_items(&a.wol, &b.wol, |w| &w.id, |w| w.updated_at),
        extra: merge_extra(&a.extra, &b.extra),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str, name: &str, ts: i64) -> Host {
        Host { id: id.into(), name: name.into(), updated_at: ts, ..Default::default() }
    }

    #[test]
    fn merge_keeps_newest_and_union() {
        let a = Vault { hosts: vec![host("1", "old", 1), host("2", "a-only", 1)], ..Default::default() };
        let b = Vault { hosts: vec![host("1", "new", 2), host("3", "b-only", 1)], ..Default::default() };
        let m = merge(&a, &b);
        let names: Vec<_> = m.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["new", "a-only", "b-only"]);
        assert_eq!(merge(&b, &a).hosts.len(), 3);
    }

    #[test]
    fn merge_ties_converge() {
        // Same updatedAt, different content (a device updated from a version without `order`):
        // both directions must pick the same copy, or devices overwrite each other forever.
        let ordered = Vault { hosts: vec![Host { order: 3.0, ..host("1", "x", 5) }], ..Default::default() };
        let plain = Vault { hosts: vec![host("1", "x", 5)], ..Default::default() };
        assert_eq!(merge(&ordered, &plain).hosts[0].order, 3.0);
        assert_eq!(merge(&plain, &ordered).hosts[0].order, 3.0);
    }

    #[test]
    fn resolve_uses_identity_and_key() {
        let v = Vault {
            keys: vec![Key { id: "k".into(), private_key: "PRIV".into(), ..Default::default() }],
            identities: vec![Identity { id: "i".into(), username: "u".into(), password: "p".into(), key_id: "k".into(), ..Default::default() }],
            ..Default::default()
        };
        let h = v.resolve(Host { identity_id: "i".into(), ..Default::default() });
        assert_eq!((h.username.as_str(), h.password.as_str(), h.private_key.as_str()), ("u", "p", "PRIV"));
        let own = v.resolve(Host { identity_id: "i".into(), username: "me".into(), ..Default::default() });
        assert_eq!(own.username, "me");
    }

    #[test]
    fn unknown_collections_survive_and_merge() {
        let a: Vault = serde_json::from_str(r#"{"hosts":[],"future":[{"id":"x","updatedAt":1,"v":"old"}]}"#).unwrap();
        let b: Vault = serde_json::from_str(r#"{"future":[{"id":"x","updatedAt":2,"v":"new"},{"id":"y","updatedAt":1}]}"#).unwrap();
        let m = serde_json::to_value(merge(&a, &b)).unwrap();
        assert_eq!(m["future"][0]["v"], "new");
        assert_eq!(m["future"].as_array().unwrap().len(), 2);
    }
}
