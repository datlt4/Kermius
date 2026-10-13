use crate::model::{now_ms, Host, Tunnel, Vault};
use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub added: usize,
    pub updated: usize,
}

/// Import a Termix host export (`{"hosts": [...]}`). Re-importing updates
/// matching hosts (same name/address/port/username) instead of duplicating.
pub fn import(vault: &mut Vault, json: &str) -> Result<ImportReport> {
    let root: Value = serde_json::from_str(json)?;
    let Some(list) = root.get("hosts").and_then(Value::as_array).or(root.as_array()) else {
        bail!("not a Termix host export (missing \"hosts\" array)");
    };
    let mut report = ImportReport { added: 0, updated: 0 };
    for h in list {
        let s = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let tunnels = h
            .pointer("/pluginSettings/tunnels/tunnelConnections")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|t| t.get("mode").and_then(Value::as_str).unwrap_or("local") == "local")
            .map(|t| {
                let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let n = |k: &str| t.get(k).and_then(Value::as_u64).unwrap_or(0) as u16;
                Tunnel {
                    bind_host: Some(s("bindHost")).filter(|b| !b.is_empty()).unwrap_or("127.0.0.1".into()),
                    source_port: n("sourcePort"),
                    endpoint_host: s("endpointHost"),
                    endpoint_port: n("endpointPort"),
                }
            })
            .collect();
        let new = Host {
            id: String::new(),
            name: s("name"),
            address: s("ip"),
            port: h.get("port").and_then(Value::as_u64).unwrap_or(22) as u16,
            username: s("username"),
            password: s("password"),
            private_key: s("key"),
            key_passphrase: s("keyPassword"),
            folder: s("folder"),
            tags: h
                .get("tags")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect(),
            notes: s("notes"),
            tunnels,
            updated_at: now_ms(),
            deleted: false,
        };
        let existing = vault.hosts.iter_mut().find(|e| {
            !e.deleted
                && e.name == new.name
                && e.address == new.address
                && e.port == new.port
                && e.username == new.username
        });
        match existing {
            Some(e) => {
                *e = Host { id: e.id.clone(), ..new };
                report.updated += 1;
            }
            None => {
                vault.hosts.push(Host { id: uuid::Uuid::new_v4().to_string(), ..new });
                report.added += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"hosts":[{"name":"a","ip":"10.0.0.1","port":2222,"username":"u",
      "password":"p","folder":"F","tags":["x","y"],"notes":"n",
      "pluginSettings":{"tunnels":{"tunnelConnections":[
        {"mode":"local","sourcePort":8080,"endpointHost":"","endpointPort":80,"bindHost":"127.0.0.1"}]}}}]}"#;

    #[test]
    fn imports_and_reimport_updates() {
        let mut v = Vault::default();
        let r = import(&mut v, SAMPLE).unwrap();
        assert_eq!((r.added, r.updated), (1, 0));
        let h = &v.hosts[0];
        assert_eq!((h.port, h.folder.as_str(), h.password.as_str()), (2222, "F", "p"));
        assert_eq!(h.tags, ["x", "y"]);
        assert_eq!(h.tunnels[0].source_port, 8080);
        let id = h.id.clone();
        let r = import(&mut v, SAMPLE).unwrap();
        assert_eq!((r.added, r.updated, v.hosts.len()), (0, 1, 1));
        assert_eq!(v.hosts[0].id, id);
    }
}
