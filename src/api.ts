import { invoke, Channel } from "@tauri-apps/api/core";
import { webApi } from "./webapi";

/** Running in a plain browser (served by the sync server) instead of the Tauri app. */
export const isWeb = !("__TAURI_INTERNALS__" in window);

export interface Tunnel {
  label?: string;
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
  /** "ssh" (or ""), "mosh", "telnet", "serial" or "vnc". */
  protocol: string;
  baud: number;
  viewOnly?: boolean;
  noClipboard?: boolean;
  /** SSH: id of the host to hop through (older single-hop setting). */
  jumpHostId?: string;
  /** SSH: jump hosts in connection order, first hop first. */
  jumpChain?: string[];
  /** SSH: socks5://[user:pass@]host:port or http://… */
  proxy?: string;
  agentForward?: boolean;
  /** SSH: NAME=value per line. */
  env?: string;
  startupSnippetId?: string;
  /** Position within its group (drag & drop); ties sort by name. */
  order?: number;
  /** Also reach this address with Nearby Share (e.g. across a VPN, where discovery cannot). */
  nearby?: boolean;
  updatedAt: number;
  deleted: boolean;
}

export interface NearbyDevice {
  fingerprint: string;
  alias: string;
  deviceModel: string;
  /** mobile | desktop | web | headless | server */
  deviceType: string;
  ip: string;
  port: number;
  https: boolean;
}

export interface NearbyStatus {
  running: boolean;
  alias: string;
  port: number;
  dir: string;
  devices: NearbyDevice[];
  error: string;
  /** Devices could not connect here: a firewall blocks the port. */
  blocked: boolean;
  /** Command opening the port in this computer's firewall ("" = unknown firewall). */
  firewall: string;
  /** This device's addresses and host names. */
  own: string[];
}

export interface NearbyTransfer {
  id: string;
  peer: string;
  incoming: boolean;
  files: number;
  total: number;
  done: number;
  state: "waiting" | "active" | "done" | "declined" | "failed" | "cancelled";
  error: string;
  dir: string;
  /** Unix ms of the last change. */
  at: number;
}

export type NearbyEvent =
  | { kind: "devices"; devices: NearbyDevice[] }
  /** `files`: the first 50 names; `count`/`total`: all of them. */
  | { kind: "request"; id: string; alias: string; files: [string, number][]; count: number; total: number }
  | { kind: "message"; alias: string; text: string }
  | { kind: "requestGone"; id: string }
  | ({ kind: "transfer" } & NearbyTransfer);

export interface WolDevice {
  id: string;
  name: string;
  mac: string;
  /** Broadcast address of the target's network; "" = 255.255.255.255. */
  broadcast: string;
  /** UDP port; 0 = 9. */
  port: number;
  /** SSH host on the target's LAN that sends the packet; "" = this computer. */
  relay: string;
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

/** Integration API (desktop): `kermius --new-terminal [--cwd DIR]`, `kermius --share PATH...`, `kermius://terminal?cwd=DIR`. */
export type Launch = { kind: "terminal"; cwd: string } | { kind: "share"; files: string[]; dirs: string[] };

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

export interface FsEndpoint {
  kind: "local" | "remote";
  path: string;
  hosts: string[];
}

export interface FsJob {
  id: string;
  name: string;
  mode: "twoway" | "mirror";
  a: FsEndpoint;
  b: FsEndpoint;
  delete: boolean;
  initial: "merge" | "a_to_b" | "b_to_a" | "";
  excludes: string[];
  keepPerms: boolean;
  keepOwner: boolean;
  keepSpecials: boolean;
  followLinks: boolean;
  intervalMin: number;
  watch: boolean;
  lastRun: number;
  lastAttempt: number;
  lastResult: string;
  conflicts: number;
  paused: boolean;
  statsA: FsStats;
  statsB: FsStats;
}

export interface FsStats {
  files: number;
  dirs: number;
  bytes: number;
}

export interface FsConflict {
  path: string;
  original: string;
  originalExists: boolean;
  size: number;
  mtime: number;
}

export type FsEvent = { id: string } & (
  | { type: "phase"; phase: string; message: string }
  | { type: "progress"; done: number; total: number; rate: number; dir: "up" | "down" | "local" }
  | { type: "finished"; ok: boolean; summary: string }
  | { type: "scan"; side: "a" | "b"; files: number; dirs: number; bytes: number }
  | { type: "log"; line: string }
  | { type: "watch"; side: "a" | "b"; state: "watching" | "polling" | "offline" | "limit"; message: string }
);

export interface FsPlan {
  copyAb: string[];
  copyBa: string[];
  deleteA: string[];
  deleteB: string[];
  conflicts: [string, string][];
}

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
  | { type: "upload"; progress: number }
  | { type: "rtt"; micros: number };

export interface UpdateInfo {
  version: string;
  notes: string;
  /** "install" (desktop), "download" (Android APK) or "none" (iOS). */
  action: string;
  url: string;
}

export const emptyHost = (): Host => ({
  id: "", name: "", address: "", port: 22, username: "", password: "", privateKey: "",
  keyPassphrase: "", folder: "", tags: [], notes: "", tunnels: [], identityId: "", keyId: "", protocol: "ssh", baud: 0, updatedAt: 0, deleted: false,
});

const tauriApi = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  wolList: () => invoke<WolDevice[]>("wol_list"),
  wolSave: (device: WolDevice) => invoke<WolDevice>("wol_save", { device }),
  wolDelete: (id: string) => invoke<void>("wol_delete", { id }),
  wolSend: (id: string) => invoke<void>("wol_send", { id }),
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
  fsyncList: () => invoke<FsJob[]>("fsync_list"),
  fsyncSave: (job: FsJob) => invoke<FsJob>("fsync_save", { job }),
  fsyncDelete: (id: string) => invoke<void>("fsync_delete", { id }),
  fsyncRun: (id: string, dryRun: boolean) => invoke<{ summary: string; plan: FsPlan }>("fsync_run", { id, dryRun }),
  fsyncConflicts: (id: string) => invoke<FsConflict[]>("fsync_conflicts", { id }),
  fsyncRead: (id: string, path: string) => invoke<string>("fsync_read", { id, path }),
  fsyncResolve: (id: string, path: string, action: "current" | "conflict" | "both" | "merged", merged?: string) =>
    invoke<void>("fsync_resolve", { id, path, action, merged }),
  fsyncStop: (id: string) => invoke<void>("fsync_stop", { id }),
  fsyncPause: (ids: string[], paused: boolean) => invoke<void>("fsync_pause", { ids, paused }),
  fsyncRaiseInotify: () => invoke<void>("fsync_raise_inotify"),
  fsyncRaiseInotifyRemote: (hostId: string) => invoke<void>("fsync_raise_inotify_remote", { hostId }),
  fsyncImportStignore: (dir: string) => invoke<[string[], number]>("fsync_import_stignore", { dir }),
  fsyncWatchStates: () => invoke<Record<string, [string, string]>>("fsync_watch_states"),
  importTermix: (path: string) => invoke<{ added: number; updated: number }>("import_termix", { path }),
  copyPassword: (id: string) => invoke<void>("copy_password", { id }),
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  sshTest: (host: Host) => invoke<string[]>("ssh_test", { host }),
  nearbyStatus: () => invoke<NearbyStatus>("nearby_status"),
  nearbyStart: () => invoke<NearbyStatus>("nearby_start"),
  nearbyStop: () => invoke<void>("nearby_stop"),
  nearbyRefresh: () => invoke<void>("nearby_refresh"),
  nearbyProbe: (addresses: string[]) => invoke<NearbyDevice[]>("nearby_probe", { addresses }),
  nearbySend: (fingerprint: string, paths: string[], texts: string[]) => invoke<string>("nearby_send", { fingerprint, paths, texts }),
  nearbyRespond: (id: string, accept: boolean) => invoke<void>("nearby_respond", { id, accept }),
  nearbyCancel: (id: string) => invoke<void>("nearby_cancel", { id }),
  nearbyOpenFolder: () => invoke<void>("nearby_open_folder"),
  /** "" = the Downloads folder. */
  nearbySetDir: (dir: string) => invoke<NearbyStatus>("nearby_set_dir", { dir }),
  /** "" = the device's host name. */
  nearbySetAlias: (alias: string) => invoke<NearbyStatus>("nearby_set_alias", { alias }),
  sshConfigImport: () => invoke<{ added: number; updated: number; skipped: number }>("ssh_config_import"),
  sshConfigPreview: (hostIds: string[], withKeys: boolean, withPasswords: boolean) =>
    invoke<string>("ssh_config_preview", { hostIds, withKeys, withPasswords }),
  sshConfigExport: (hostIds: string[], withKeys: boolean, withPasswords: boolean) =>
    invoke<string>("ssh_config_export", { hostIds, withKeys, withPasswords }),
  fsyncInotifyCommand: () => invoke<string>("fsync_inotify_command"),
  clipboardRead: () => invoke<string>("clipboard_read"),
  sshConnect: (hostId: string, cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) =>
    invoke<string>("ssh_connect", { hostId, cols, rows, onData, onStatus }),
  localOpen: (cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>, cwd = "") =>
    invoke<string>("local_open", { cols, rows, onData, onStatus, cwd: cwd || null }),
  /** Integration API requests that arrived before the UI listened for `kermius-launch`. */
  launchReady: () => invoke<Launch[]>("launch_ready"),
  listFonts: () => invoke<string[]>("list_fonts"),
  sshUpload: (sid: string, ext: string, bytes: Uint8Array) => invoke<string>("ssh_upload", bytes, { headers: { sid, ext } }),
  saveClipboardImage: () => invoke<string>("save_clipboard_image"),
  sshPasteImage: (sid: string) => invoke<string>("ssh_paste_image", { sid }),
  sshWrite: (sid: string, data: string) => invoke<void>("ssh_write", { sid, data }),
  hostHasPassword: (hostId: string) => invoke<boolean>("host_has_password", { hostId }),
  sshSendPassword: (sid: string, hostId: string) => invoke<void>("ssh_send_password", { sid, hostId }),
  localHasPassword: () => invoke<boolean>("local_has_password"),
  localSetPassword: (password: string) => invoke<void>("local_set_password", { password }),
  localSendPassword: (sid: string) => invoke<void>("local_send_password", { sid }),
  termAck: (sid: string, bytes: number) => invoke<void>("term_ack", { sid, bytes }),
  sshResize: (sid: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sid, cols, rows }),
  sshClose: (sid: string) => invoke<void>("ssh_close", { sid }),
  vncOpen: (hostId: string, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) => invoke<string>("vnc_open", { hostId, onData, onStatus }),
  vncPassword: (hostId: string) => invoke<string>("vnc_password", { hostId }),
  // Plain JSON arguments: Android's IPC bridge drops raw bodies' headers.
  sessionWrite: (sid: string, bytes: Uint8Array) => invoke<void>("session_write", { sid, data: Array.from(bytes) }),
  serialPorts: () => invoke<string[]>("serial_ports"),
  autostartGet: () => invoke<boolean>("autostart_get"),
  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  updateInstall: (onProgress: Channel<[number, number]>) => invoke<void>("update_install", { onProgress }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  autostartSet: (enabled: boolean) => invoke<void>("autostart_set", { enabled }),
  serialSetupCommand: () => invoke<string>("serial_setup_command"),
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
