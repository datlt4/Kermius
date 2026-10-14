use crate::crypto;
use crate::model::LocalState;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::path::PathBuf;

/// Local encrypted store: `vault.bin` sealed with a random device key in `local.key`.
pub struct Store {
    dir: PathBuf,
    key: [u8; 32],
    pub state: Mutex<LocalState>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        let key_path = dir.join("local.key");
        let key: [u8; 32] = match std::fs::read(&key_path) {
            Ok(b) => b.try_into().map_err(|_| anyhow::anyhow!("corrupt local.key"))?,
            Err(_) => {
                let k = crypto::random::<32>();
                write_private(&key_path, &k)?;
                k
            }
        };
        let vault_path = dir.join("vault.bin");
        let state = match std::fs::read(&vault_path) {
            Ok(b) => serde_json::from_slice(&crypto::open(&key, &b)?)?,
            Err(_) => LocalState::default(),
        };
        Ok(Self { dir, key, state: Mutex::new(state) })
    }

    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    pub fn save(&self) -> Result<()> {
        let json = serde_json::to_vec(&*self.state.lock())?;
        let tmp = self.dir.join("vault.bin.tmp");
        write_private(&tmp, &crypto::seal(&self.key, &json))?;
        std::fs::rename(&tmp, self.dir.join("vault.bin"))?;
        Ok(())
    }
}

fn write_private(path: &std::path::Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(data)?;
    Ok(())
}
