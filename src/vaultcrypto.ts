// Browser/Node port of the Rust vault format (src-tauri/src/{crypto,sync,model}.rs).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "hash-wasm";
import type { Host } from "./api";

export interface KnownHost {
  id: string;
  fingerprint: string;
  updatedAt: number;
}

export interface Vault {
  hosts: Host[];
  knownHosts: KnownHost[];
}

const MAGIC = new TextEncoder().encode("KMS1");
const SALT_LEN = 16;
const NONCE_LEN = 24;

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Argon2id with the Rust `argon2` crate defaults (m=19 MiB, t=2, p=1). */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({ password: passphrase, salt, parallelism: 1, iterations: 2, memorySize: 19 * 1024, hashLength: 32, outputType: "binary" });
}

export async function encodeVault(passphrase: string, salt: Uint8Array, vault: Vault): Promise<Uint8Array> {
  const key = await deriveKey(passphrase, salt);
  const nonce = random(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(vault)));
  const out = new Uint8Array(MAGIC.length + SALT_LEN + NONCE_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  out.set(nonce, 4 + SALT_LEN);
  out.set(ct, 4 + SALT_LEN + NONCE_LEN);
  return out;
}

export async function decodeVault(passphrase: string, blob: Uint8Array): Promise<{ salt: Uint8Array; vault: Vault }> {
  if (blob.length < 4 + SALT_LEN + NONCE_LEN || MAGIC.some((b, i) => blob[i] !== b)) throw new Error("Unrecognized vault format");
  const salt = blob.slice(4, 4 + SALT_LEN);
  const key = await deriveKey(passphrase, salt);
  const nonce = blob.slice(4 + SALT_LEN, 4 + SALT_LEN + NONCE_LEN);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce).decrypt(blob.slice(4 + SALT_LEN + NONCE_LEN));
  } catch {
    throw new Error("Wrong passphrase");
  }
  const v = JSON.parse(new TextDecoder().decode(plain));
  return { salt, vault: { hosts: v.hosts ?? [], knownHosts: v.knownHosts ?? [] } };
}

export const newSalt = () => random(SALT_LEN);

function mergeItems<T extends { id: string; updatedAt: number }>(a: T[], b: T[]): T[] {
  const out = a.map((x) => ({ ...x }));
  for (const item of b) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i < 0) out.push(item);
    else if (item.updatedAt > out[i].updatedAt) out[i] = item;
  }
  return out;
}

/** Per-item last-writer-wins, same as `model::merge`. */
export const mergeVaults = (a: Vault, b: Vault): Vault => ({
  hosts: mergeItems(a.hosts, b.hosts),
  knownHosts: mergeItems(a.knownHosts, b.knownHosts),
});

/** base64("url|token|passphrase"); passphrase may contain "|". */
export function parseSyncConfig(text: string): { url: string; token: string; passphrase: string } | null {
  let s = text.trim();
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  } catch {
    /* plain form */
  }
  const [url, token, ...pass] = s.split("|");
  if (!url || token === undefined || !pass.length) return null;
  return { url, token, passphrase: pass.join("|") };
}
