// Web build backend: talks to the sync server on the same origin; vault lives only in memory.
import type { Api, Host, SyncSettings } from "./api";
import { decodeVault, encodeVault, mergeVaults, newSalt, type Vault } from "./vaultcrypto";

let session: { token: string; passphrase: string } | null = null;
let vault: Vault = { hosts: [], knownHosts: [] };
let lastSync = 0;

const unsupported = () => Promise.reject(new Error("Not available on the web"));

function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function copyText(text: string) {
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
  // Plain-HTTP fallback.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** Pull, merge, push (retry on version conflict). Mirrors src-tauri/src/sync.rs. */
async function sync(): Promise<boolean> {
  if (!session) throw new Error("Locked");
  const auth = { Authorization: `Bearer ${session.token}` };
  for (let i = 0; i < 5; i++) {
    const res = await fetch("/v1/vault", { headers: auth, cache: "no-store" });
    let version = 0;
    let salt: Uint8Array = newSalt();
    let remote: Vault = { hosts: [], knownHosts: [] };
    if (res.status === 200) {
      version = Number(res.headers.get("x-version"));
      ({ salt, vault: remote } = await decodeVault(session.passphrase, new Uint8Array(await res.arrayBuffer())));
    } else if (res.status === 401) throw new Error("Wrong access token");
    else if (res.status !== 404) throw new Error(`Sync server error: HTTP ${res.status}`);
    const merged = mergeVaults(vault, remote);
    const pushed = JSON.stringify(merged) !== JSON.stringify(remote);
    if (pushed) {
      const put = await fetch("/v1/vault", {
        method: "PUT",
        headers: { ...auth, "x-base-version": String(version) },
        body: (await encodeVault(session.passphrase, salt, merged)) as Uint8Array<ArrayBuffer>,
      });
      if (put.status === 409) continue;
      if (!put.ok) throw new Error(`Sync push failed: HTTP ${put.status}`);
    }
    vault = mergeVaults(vault, merged);
    lastSync = Date.now();
    return pushed;
  }
  throw new Error("Sync kept conflicting, try again");
}

/** Unlock with the sync config; throws on wrong token/passphrase. */
export async function webLogin(token: string, passphrase: string) {
  session = { token, passphrase };
  vault = { hosts: [], knownHosts: [] };
  try {
    await sync();
  } catch (e) {
    session = null;
    throw e;
  }
}

const live = () => vault.hosts.filter((h) => !h.deleted);

export const webApi: Api = {
  listHosts: async () => live(),
  saveHost: async (host: Host) => {
    const h = { ...host, id: host.id || uuid(), updatedAt: Date.now(), deleted: false };
    const i = vault.hosts.findIndex((x) => x.id === h.id);
    i < 0 ? vault.hosts.push(h) : (vault.hosts[i] = h);
    await sync();
    return h;
  },
  deleteHost: async (id: string) => {
    const i = vault.hosts.findIndex((x) => x.id === id);
    if (i >= 0) vault.hosts[i] = { ...vault.hosts[i], password: "", privateKey: "", keyPassphrase: "", notes: "", tunnels: [], deleted: true, updatedAt: Date.now() };
    await sync();
  },
  importTermix: unsupported,
  copyPassword: async (id: string) => {
    const h = live().find((x) => x.id === id);
    if (!h?.password) throw new Error("This host has no password");
    await copyText(h.password);
  },
  clipboardWrite: copyText,
  clipboardRead: async () => (navigator.clipboard && isSecureContext ? navigator.clipboard.readText() : unsupported()),
  sshConnect: unsupported,
  localOpen: unsupported,
  listFonts: async () => [],
  sshUpload: unsupported,
  sshPasteImage: unsupported,
  sshWrite: unsupported,
  sshResize: unsupported,
  sshClose: unsupported,
  trustNewHostKey: unsupported,
  tunnelStart: unsupported,
  tunnelStop: unsupported,
  tunnelList: async () => [],
  getSyncSettings: async (): Promise<SyncSettings> => ({ url: location.origin, token: session?.token ?? "", passphrase: session?.passphrase ?? "", lastSync }),
  setSyncSettings: async (s: SyncSettings) => {
    await webLogin(s.token, s.passphrase);
  },
  syncNow: async () => {
    const pushed = await sync();
    return { hosts: live().length, pushed, lastSync };
  },
};
