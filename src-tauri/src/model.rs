use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tunnel {
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

/// Everything that gets synced (end-to-end encrypted).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vault {
    pub hosts: Vec<Host>,
    pub known_hosts: Vec<KnownHost>,
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
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-item last-writer-wins merge keyed by id.
fn merge_items<T: Clone>(a: &[T], b: &[T], id: fn(&T) -> &str, ts: fn(&T) -> i64) -> Vec<T> {
    let mut out: Vec<T> = a.to_vec();
    for item in b {
        match out.iter_mut().find(|x| id(x) == id(item)) {
            Some(x) if ts(item) > ts(x) => *x = item.clone(),
            Some(_) => {}
            None => out.push(item.clone()),
        }
    }
    out
}

pub fn merge(a: &Vault, b: &Vault) -> Vault {
    Vault {
        hosts: merge_items(&a.hosts, &b.hosts, |h| &h.id, |h| h.updated_at),
        known_hosts: merge_items(&a.known_hosts, &b.known_hosts, |k| &k.id, |k| k.updated_at),
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
}
