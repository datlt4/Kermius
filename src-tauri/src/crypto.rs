use anyhow::{anyhow, bail, Result};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

pub const NONCE_LEN: usize = 24;

/// nonce || ciphertext
pub fn seal(key: &[u8; 32], plain: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(cipher.encrypt(&nonce, plain).expect("encryption cannot fail"));
    out
}

pub fn open(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < NONCE_LEN {
        bail!("ciphertext too short");
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| anyhow!("decryption failed (wrong key or passphrase?)"))
}

pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    // v1 params (KMS1 blobs, kept so old vaults stay readable).
    let mut out = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(out)
}

/// v2 params (KMS2 blobs): m=64 MiB, t=3, p=1. Stronger against GPU guessing;
/// old KMS1 blobs still decode via [`derive_key`].
pub fn derive_key_v2(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = argon2::Params::new(64 * 1024, 3, 1, Some(32))
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    let mut out = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(out)
}

pub fn random<const N: usize>() -> [u8; N] {
    use rand::RngCore;
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_key() {
        let k = random::<32>();
        let ct = seal(&k, b"hello");
        assert_eq!(open(&k, &ct).unwrap(), b"hello");
        assert!(open(&random::<32>(), &ct).is_err());
    }
}
