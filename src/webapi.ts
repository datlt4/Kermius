// Web build backend: talks to the sync server on the same origin; vault lives only in memory.
import type { Api, Host, Identity, Key, Snippet, SyncSettings } from "./api";
import { decodeVault, emptyVault, encodeVault, mergeVaults, newSalt, type Vault } from "./vaultcrypto";

let session: { token: string; passphrase: string } | null = null;
let vault: Vault = emptyVault();
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
    let remote: Vault = emptyVault();
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
  vault = emptyVault();
  try {
    await sync();
  } catch (e) {
    session = null;
    throw e;
  }
}

const live = () => vault.hosts.filter((h) => !h.deleted);

type Synced = { id: string; updatedAt: number; deleted: boolean };
const coll = <T extends Synced>(name: string) => ((vault[name] ??= []) as T[]);

async function upsert<T extends Synced>(name: string, item: T): Promise<T> {
  const list = coll<T>(name);
  const it = { ...item, id: item.id || uuid(), updatedAt: Date.now(), deleted: false };
  const i = list.findIndex((x) => x.id === it.id);
  i < 0 ? list.push(it) : (list[i] = it);
  await sync();
  return it;
}

async function tombstone(name: string, id: string) {
  const list = coll<Synced>(name);
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = { id, updatedAt: Date.now(), deleted: true };
  await sync();
}

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
  listSnippets: async () => vault.snippets.filter((x) => !x.deleted),
  saveSnippet: async (snippet: Snippet) => {
    const sn = { ...snippet, id: snippet.id || uuid(), updatedAt: Date.now(), deleted: false };
    const i = vault.snippets.findIndex((x) => x.id === sn.id);
    i < 0 ? vault.snippets.push(sn) : (vault.snippets[i] = sn);
    await sync();
    return sn;
  },
  deleteSnippet: async (id: string) => {
    const i = vault.snippets.findIndex((x) => x.id === id);
    if (i >= 0) vault.snippets[i] = { ...vault.snippets[i], script: "", deleted: true, updatedAt: Date.now() };
    await sync();
  },
  listKeys: async () => coll<Key>("keys").filter((x) => !x.deleted),
  saveKey: (key: Key) => upsert("keys", key),
  deleteKey: (id: string) => tombstone("keys", id),
  listIdentities: async () => coll<Identity>("identities").filter((x) => !x.deleted),
  saveIdentity: (identity: Identity) => upsert("identities", identity),
  deleteIdentity: (id: string) => tombstone("identities", id),
  keyInfo: unsupported,
  generateKey: unsupported,
  sftpOpen: unsupported,
  sftpClose: unsupported,
  sftpHome: unsupported,
  sftpList: unsupported,
  sftpMkdir: unsupported,
  sftpRename: unsupported,
  sftpRemove: unsupported,
  localHome: unsupported,
  localList: unsupported,
  localMkdir: unsupported,
  localRename: unsupported,
  localRemove: unsupported,
  rsyncAvailable: async () => false,
  transferStart: unsupported,
  transferCancel: unsupported,
  fsyncList: async () => [],
  fsyncSave: unsupported,
  fsyncDelete: unsupported,
  fsyncRun: unsupported,
  fsyncConflicts: unsupported,
  fsyncRead: unsupported,
  fsyncResolve: unsupported,
  fsyncStop: unsupported,
  fsyncPause: unsupported,
  fsyncRaiseInotify: unsupported,
  fsyncInotifyCommand: unsupported,
  sshConfigPreview: unsupported,
  sshConfigExport: unsupported,
  fsyncRaiseInotifyRemote: unsupported,
  fsyncImportStignore: unsupported,
  fsyncWatchStates: async () => ({}),
  importTermix: unsupported,
  copyPassword: async (id: string) => {
    const h = live().find((x) => x.id === id);
    const ident = coll<Identity>("identities").find((i) => !i.deleted && i.id === h?.identityId);
    const password = h?.password || ident?.password;
    if (!password) throw new Error("This host has no password");
    await copyText(password);
  },
  clipboardWrite: copyText,
  clipboardRead: async () => (navigator.clipboard && isSecureContext ? navigator.clipboard.readText() : unsupported()),
  sshConnect: unsupported,
  localOpen: unsupported,
  listFonts: async () => [],
  sshUpload: unsupported,
  saveClipboardImage: unsupported,
  sshPasteImage: unsupported,
  sshWrite: unsupported,
  hostHasPassword: async () => false,
  sshSendPassword: unsupported,
  localHasPassword: async () => false,
  localSetPassword: unsupported,
  localSendPassword: unsupported,
  termAck: unsupported,
  sshResize: unsupported,
  sshClose: unsupported,
  vncOpen: unsupported,
  vncPassword: unsupported,
  sessionWrite: unsupported,
  serialPorts: async () => [] as string[],
  autostartGet: async () => false,
  autostartSet: unsupported,
  serialSetupCommand: async () => "",
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
