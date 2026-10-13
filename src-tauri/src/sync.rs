//! End-to-end encrypted sync. The server only stores an opaque blob:
//! `MAGIC || salt(16) || nonce(24) || ciphertext`, where the key is
//! Argon2id(passphrase, salt). Conflicts are resolved by per-item merge.
use crate::crypto;
use crate::model::{merge, now_ms, Vault};
use crate::store::Store;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;

const MAGIC: &[u8; 4] = b"KMS1";
const SALT_LEN: usize = 16;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub hosts: usize,
    pub pushed: bool,
    pub last_sync: i64,
}

fn encode(passphrase: &str, salt: &[u8; SALT_LEN], vault: &Vault) -> Result<Vec<u8>> {
    let key = crypto::derive_key(passphrase, salt)?;
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(salt);
    out.extend(crypto::seal(&key, &serde_json::to_vec(vault)?));
    Ok(out)
}

fn decode(passphrase: &str, blob: &[u8]) -> Result<([u8; SALT_LEN], Vault)> {
    if blob.len() < 4 + SALT_LEN || &blob[..4] != MAGIC {
        bail!("server returned an unrecognized vault format");
    }
    let salt: [u8; SALT_LEN] = blob[4..4 + SALT_LEN].try_into()?;
    let key = crypto::derive_key(passphrase, &salt)?;
    Ok((salt, serde_json::from_slice(&crypto::open(&key, &blob[4 + SALT_LEN..])?)?))
}

pub async fn sync(store: &Store) -> Result<SyncReport> {
    let cfg = store.state.lock().sync.clone();
    if cfg.url.trim().is_empty() || cfg.passphrase.is_empty() {
        bail!("Sync is not configured");
    }
    let url = format!("{}/v1/vault", cfg.url.trim().trim_end_matches('/'));
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build()?;

    for _ in 0..5 {
        let resp = http.get(&url).bearer_auth(&cfg.token).send().await?;
        let (version, salt, remote) = match resp.status().as_u16() {
            404 => (0u64, crypto::random::<SALT_LEN>(), Vault::default()),
            200 => {
                let version = header_version(&resp)?;
                let (salt, vault) = decode(&cfg.passphrase, &resp.bytes().await?)?;
                (version, salt, vault)
            }
            401 => bail!("Sync server rejected the token"),
            s => bail!("Sync server error: HTTP {s}"),
        };
        let local = store.state.lock().vault.clone();
        let merged = merge(&local, &remote);
        let pushed = merged != remote;
        if pushed {
            let resp = http
                .put(&url)
                .bearer_auth(&cfg.token)
                .header("x-base-version", version.to_string())
                .body(encode(&cfg.passphrase, &salt, &merged)?)
                .send()
                .await?;
            match resp.status().as_u16() {
                409 => continue, // someone pushed in between: pull again
                200..=299 => {}
                s => bail!("Sync push failed: HTTP {s}"),
            }
        }
        let report = {
            let mut st = store.state.lock();
            st.vault = merge(&st.vault, &merged);
            st.sync.last_sync = now_ms();
            SyncReport {
                hosts: st.vault.hosts.iter().filter(|h| !h.deleted).count(),
                pushed,
                last_sync: st.sync.last_sync,
            }
        };
        store.save()?;
        return Ok(report);
    }
    Err(anyhow!("Sync kept conflicting, try again"))
}

fn header_version(resp: &reqwest::Response) -> Result<u64> {
    resp.headers()
        .get("x-version")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| anyhow!("missing x-version header"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip() {
        let v = Vault { hosts: vec![Default::default()], ..Default::default() };
        let salt = crypto::random::<SALT_LEN>();
        let blob = encode("pw", &salt, &v).unwrap();
        assert_eq!(decode("pw", &blob).unwrap().1, v);
        assert!(decode("wrong", &blob).is_err());
    }
}

/// End-to-end test against a running server:
/// `KERMIUS_TEST_URL=http://127.0.0.1:8080 KERMIUS_TEST_TOKEN=... cargo test sync_e2e`
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::model::Host;

    fn store(url: &str, token: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("kermius-test-{}", uuid::Uuid::new_v4()));
        let s = Store::open(dir).unwrap();
        s.state.lock().sync = crate::model::SyncSettings {
            url: url.into(),
            token: token.into(),
            passphrase: "correct horse".into(),
            last_sync: 0,
        };
        s
    }

    #[tokio::test]
    async fn sync_e2e() {
        let (Ok(url), Ok(token)) = (std::env::var("KERMIUS_TEST_URL"), std::env::var("KERMIUS_TEST_TOKEN")) else {
            return;
        };
        let a = store(&url, &token);
        let b = store(&url, &token);
        a.state.lock().vault.hosts = (0..3)
            .map(|i| Host { id: format!("h{i}"), name: format!("host{i}"), updated_at: 1, ..Default::default() })
            .collect();
        sync(&a).await.unwrap();
        assert_eq!(sync(&b).await.unwrap().hosts, 3);

        // Delete on B, edit on A; both changes must survive.
        {
            let mut st = b.state.lock();
            let h = &mut st.vault.hosts[0];
            *h = Host { id: h.id.clone(), deleted: true, updated_at: 5, ..Default::default() };
        }
        a.state.lock().vault.hosts[1].name = "renamed".into();
        a.state.lock().vault.hosts[1].updated_at = 5;
        sync(&b).await.unwrap();
        sync(&a).await.unwrap();
        sync(&b).await.unwrap();
        for s in [&a, &b] {
            let st = s.state.lock();
            assert!(st.vault.hosts[0].deleted);
            assert_eq!(st.vault.hosts[1].name, "renamed");
        }

        // Wrong passphrase cannot read the vault.
        let c = store(&url, &token);
        c.state.lock().sync.passphrase = "wrong".into();
        assert!(sync(&c).await.is_err());
    }
}
