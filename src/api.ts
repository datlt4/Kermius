import { invoke, Channel } from "@tauri-apps/api/core";
import { webApi } from "./webapi";

/** Running in a plain browser (served by the sync server) instead of the Tauri app. */
export const isWeb = !("__TAURI_INTERNALS__" in window);

export interface Tunnel {
  bindHost: string;
  sourcePort: number;
  endpointHost: string;
  endpointPort: number;
}

export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  keyPassphrase: string;
  folder: string;
  tags: string[];
  notes: string;
  tunnels: Tunnel[];
  identityId: string;
  keyId: string;
  updatedAt: number;
  deleted: boolean;
}

export interface Key {
  id: string;
  label: string;
  privateKey: string;
  passphrase: string;
  publicKey: string;
  updatedAt: number;
  deleted: boolean;
}

export interface Identity {
  id: string;
  label: string;
  username: string;
  password: string;
  keyId: string;
  updatedAt: number;
  deleted: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  script: string;
  updatedAt: number;
  deleted: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number;
}

export type TransferEvent =
  | { type: "progress"; done: number; total: number; file: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface SyncSettings {
  url: string;
  token: string;
  passphrase: string;
  lastSync: number;
}

export type Status =
  | { type: "connected" }
  | { type: "closed" }
  | { type: "error"; message: string }
  | { type: "log"; message: string }
  | { type: "upload"; progress: number };

export const emptyHost = (): Host => ({
  id: "", name: "", address: "", port: 22, username: "", password: "", privateKey: "",
  keyPassphrase: "", folder: "", tags: [], notes: "", tunnels: [], identityId: "", keyId: "", updatedAt: 0, deleted: false,
});

const tauriApi = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  saveSnippet: (snippet: Snippet) => invoke<Snippet>("save_snippet", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),
  listKeys: () => invoke<Key[]>("list_keys"),
  saveKey: (key: Key) => invoke<Key>("save_key", { key }),
  deleteKey: (id: string) => invoke<void>("delete_key", { id }),
  listIdentities: () => invoke<Identity[]>("list_identities"),
  saveIdentity: (identity: Identity) => invoke<Identity>("save_identity", { identity }),
  deleteIdentity: (id: string) => invoke<void>("delete_identity", { id }),
  keyInfo: (privateKey: string, passphrase: string) =>
    invoke<{ publicKey: string; fingerprint: string; algorithm: string }>("key_info", { privateKey, passphrase }),
  generateKey: (comment: string) => invoke<string>("generate_key", { comment }),
  sftpOpen: (hostId: string) => invoke<string>("sftp_open", { hostId }),
  sftpClose: (id: string) => invoke<void>("sftp_close", { id }),
  sftpHome: (id: string) => invoke<string>("sftp_home", { id }),
  sftpList: (id: string, path: string) => invoke<FileEntry[]>("sftp_list", { id, path }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpRemove: (id: string, path: string) => invoke<void>("sftp_remove", { id, path }),
  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<FileEntry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),
  localRemove: (path: string) => invoke<void>("local_remove", { path }),
  rsyncAvailable: () => invoke<boolean>("rsync_available"),
  transferStart: (id: string, direction: "upload" | "download", mode: "sftp" | "rsync", sources: string[], dest: string, onEvent: Channel<TransferEvent>) =>
    invoke<string>("transfer_start", { id, direction, mode, sources, dest, onEvent }),
  transferCancel: (tid: string) => invoke<void>("transfer_cancel", { tid }),
  importTermix: (path: string) => invoke<{ added: number; updated: number }>("import_termix", { path }),
  copyPassword: (id: string) => invoke<void>("copy_password", { id }),
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  clipboardRead: () => invoke<string>("clipboard_read"),
  sshConnect: (hostId: string, cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) =>
    invoke<string>("ssh_connect", { hostId, cols, rows, onData, onStatus }),
  localOpen: (cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) =>
    invoke<string>("local_open", { cols, rows, onData, onStatus }),
  listFonts: () => invoke<string[]>("list_fonts"),
  sshUpload: (sid: string, ext: string, bytes: Uint8Array) => invoke<string>("ssh_upload", bytes, { headers: { sid, ext } }),
  saveClipboardImage: () => invoke<string>("save_clipboard_image"),
  sshPasteImage: (sid: string) => invoke<string>("ssh_paste_image", { sid }),
  sshWrite: (sid: string, data: string) => invoke<void>("ssh_write", { sid, data }),
  hostHasPassword: (hostId: string) => invoke<boolean>("host_has_password", { hostId }),
  sshSendPassword: (sid: string, hostId: string) => invoke<void>("ssh_send_password", { sid, hostId }),
  sshResize: (sid: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sid, cols, rows }),
  sshClose: (sid: string) => invoke<void>("ssh_close", { sid }),
  trustNewHostKey: (hostId: string) => invoke<void>("trust_new_host_key", { hostId }),
  tunnelStart: (hostId: string, index: number) => invoke<void>("tunnel_start", { hostId, index }),
  tunnelStop: (hostId: string, index: number) => invoke<void>("tunnel_stop", { hostId, index }),
  tunnelList: () => invoke<string[]>("tunnel_list"),
  getSyncSettings: () => invoke<SyncSettings>("get_sync_settings"),
  setSyncSettings: (settings: SyncSettings) => invoke<void>("set_sync_settings", { settings }),
  syncNow: () => invoke<{ hosts: number; pushed: boolean; lastSync: number }>("sync_now"),
};

export type Api = typeof tauriApi;
export const api: Api = isWeb ? webApi : tauriApi;

export { Channel };
