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
  updatedAt: number;
  deleted: boolean;
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
  | { type: "error"; message: string };

export const emptyHost = (): Host => ({
  id: "", name: "", address: "", port: 22, username: "", password: "", privateKey: "",
  keyPassphrase: "", folder: "", tags: [], notes: "", tunnels: [], updatedAt: 0, deleted: false,
});

const tauriApi = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  importTermix: (path: string) => invoke<{ added: number; updated: number }>("import_termix", { path }),
  copyPassword: (id: string) => invoke<void>("copy_password", { id }),
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  clipboardRead: () => invoke<string>("clipboard_read"),
  sshConnect: (hostId: string, cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) =>
    invoke<string>("ssh_connect", { hostId, cols, rows, onData, onStatus }),
  localOpen: (cols: number, rows: number, onData: Channel<ArrayBuffer>, onStatus: Channel<Status>) =>
    invoke<string>("local_open", { cols, rows, onData, onStatus }),
  listFonts: () => invoke<string[]>("list_fonts"),
  sshWrite: (sid: string, data: string) => invoke<void>("ssh_write", { sid, data }),
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
