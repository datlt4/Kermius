import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, Channel, type FileEntry, type Host, type TransferEvent } from "./api";
import { confirmDialog, contextMenu, esc, icon, promptDialog, toast } from "./ui";

type Side = "local" | "remote";

interface Pane {
  side: Side;
  path: string;
  entries: FileEntry[];
  selected: Set<string>;
  anchor: string;
  el: HTMLElement;
}

interface Transfer {
  tid: string;
  label: string;
  upload: boolean;
  done: number;
  total: number;
  status: "running" | "done" | "error";
  message: string;
}

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (s: number) => (s ? new Date(s * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");
const parent = (p: string) => {
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  const t = p.replace(/[\\/]+$/, "");
  const i = t.lastIndexOf(sep);
  return i <= 0 ? sep : t.slice(0, i);
};
const join = (dir: string, name: string) => {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
};

/** Dual-pane SFTP / rsync file manager tab. */
export class FilesTab {
  readonly id = crypto.randomUUID();
  readonly el = document.createElement("div");
  readonly kind = "files";
  readonly local = false;
  state = "connecting";
  private sid = "";
  private panes: Record<Side, Pane>;
  private transfers: Transfer[] = [];
  private mode: "sftp" | "rsync" = (localStorage.getItem("kermius.transferMode") as "sftp" | "rsync") || "sftp";
  private rsync = false;
  private unlistenDrop: (() => void) | null = null;

  constructor(public host: Host, private onChange: () => void, private onClose: (t: FilesTab) => void) {
    this.el.className = "session files";
    this.el.innerHTML = `
      <div class="fpanes">
        ${(["local", "remote"] as Side[])
          .map(
            (side) => `<div class="fpane" data-side="${side}">
              <div class="fhead">
                <span class="fbadge">${side === "local" ? `${icon("terminal", 13)} Local` : `${icon("server", 13)} ${esc(host.name)}`}</span>
                <button class="icon-btn" data-f="up" title="Up">${icon("back", 15)}</button>
                <button class="icon-btn" data-f="home" title="Home">${icon("server", 15)}</button>
                <input class="fpath" spellcheck="false" />
                <button class="icon-btn" data-f="refresh" title="Refresh">${icon("sync", 15)}</button>
                <button class="icon-btn" data-f="mkdir" title="New folder">${icon("plus", 15)}</button>
              </div>
              <div class="flist-head"><span>Name</span><span>Size</span><span>Modified</span></div>
              <div class="flist" tabindex="0"></div>
            </div>`,
          )
          .join("")}
      </div>
      <div class="ftransfers">
        <div class="ft-head"><b>Transfers</b><div class="grow"></div>
          <div class="seg ft-mode"><button data-mode="sftp">SFTP</button><button data-mode="rsync" title="Only changed parts are sent (rsync must be installed on both sides)">rsync</button></div>
        </div>
        <div class="ft-list"></div>
      </div>
      <div class="overlay"></div>`;
    const pane = (side: Side): Pane => ({ side, path: "", entries: [], selected: new Set(), anchor: "", el: this.el.querySelector(`.fpane[data-side="${side}"]`)! });
    this.panes = { local: pane("local"), remote: pane("remote") };
  }

  mount(parent: HTMLElement) {
    parent.append(this.el);
    this.bind();
    api.rsyncAvailable().then((ok) => {
      this.rsync = ok;
      if (!ok) this.mode = "sftp";
      this.renderMode();
    });
    this.connect();
  }

  async connect() {
    this.setState("connecting");
    if (this.sid) api.sftpClose(this.sid);
    try {
      this.sid = await api.sftpOpen(this.host.id);
      const [home, lhome] = await Promise.all([api.sftpHome(this.sid), api.localHome()]);
      await Promise.all([this.cd(this.panes.remote, this.panes.remote.path || home), this.cd(this.panes.local, this.panes.local.path || lhome)]);
      this.setState("connected");
    } catch (e) {
      this.setState("error", String(e));
    }
  }

  private setState(s: string, message = "") {
    this.state = s;
    const ov = this.el.querySelector<HTMLElement>(".overlay")!;
    ov.className = `overlay ${s === "connected" ? "" : s}`;
    ov.innerHTML =
      s === "connecting"
        ? `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="muted">Opening SFTP…</p><div class="progress"><i></i></div></div>`
        : s === "error"
          ? `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="err">${esc(message)}</p>
             <div class="row"><button class="btn primary" data-o="retry">Retry</button><button class="btn ghost" data-o="close">Close</button></div></div>`
          : "";
    this.onChange();
  }

  // ---------- panes ----------

  private ls(p: Pane, path: string) {
    return p.side === "remote" ? api.sftpList(this.sid, path) : api.localList(path);
  }

  private async cd(p: Pane, path: string) {
    try {
      p.entries = await this.ls(p, path);
      p.path = path;
      p.selected.clear();
      this.renderPane(p);
    } catch (e) {
      toast(String(e), "err");
      this.renderPane(p);
    }
  }

  private refresh(p: Pane) {
    return this.cd(p, p.path);
  }

  private renderPane(p: Pane) {
    (p.el.querySelector(".fpath") as HTMLInputElement).value = p.path;
    p.el.querySelector(".flist")!.innerHTML =
      p.entries
        .map(
          (e) => `<div class="frow ${p.selected.has(e.path) ? "sel" : ""}" draggable="true" data-path="${esc(e.path)}">
            <span class="fname">${icon(e.isDir ? "folder" : "file", 15)}<span>${esc(e.name)}${e.isLink ? " ↪" : ""}</span></span>
            <span class="fsize">${e.isDir ? "" : fmtSize(e.size)}</span><span class="fdate">${fmtDate(e.mtime)}</span></div>`,
        )
        .join("") || `<div class="fempty">Empty folder</div>`;
  }

  private other(p: Pane) {
    return this.panes[p.side === "local" ? "remote" : "local"];
  }

  private selection(p: Pane) {
    return p.entries.filter((e) => p.selected.has(e.path));
  }

  // ---------- operations ----------

  /** Copy `paths` from pane `from` into the other pane's current folder. */
  private transfer(from: Side, paths: string[]) {
    if (!paths.length) return;
    const upload = from === "local";
    const dest = this.panes[upload ? "remote" : "local"];
    const t: Transfer = {
      tid: "",
      label: paths.length === 1 ? paths[0].split(/[\\/]/).pop()! : `${paths.length} items`,
      upload,
      done: 0,
      total: 0,
      status: "running",
      message: "",
    };
    this.transfers.unshift(t);
    const ch = new Channel<TransferEvent>();
    ch.onmessage = (ev) => {
      if (ev.type === "progress") Object.assign(t, { done: ev.done, total: ev.total });
      else if (ev.type === "done") {
        t.status = "done";
        this.refresh(dest);
      } else Object.assign(t, { status: "error", message: ev.message });
      this.renderTransfers();
    };
    api
      .transferStart(this.sid, upload ? "upload" : "download", this.mode, paths, dest.path, ch)
      .then((tid) => (t.tid = tid))
      .catch((e) => Object.assign(t, { status: "error", message: String(e) }))
      .finally(() => this.renderTransfers());
    this.renderTransfers();
  }

  private async mkdir(p: Pane) {
    const name = await promptDialog("New folder", "Folder name");
    if (!name) return;
    const path = join(p.path, name);
    await (p.side === "remote" ? api.sftpMkdir(this.sid, path) : api.localMkdir(path)).catch((e) => toast(String(e), "err"));
    this.refresh(p);
  }

  private async rename(p: Pane, e: FileEntry) {
    const name = await promptDialog("Rename", "New name", e.name);
    if (!name || name === e.name) return;
    const to = join(parent(e.path), name);
    await (p.side === "remote" ? api.sftpRename(this.sid, e.path, to) : api.localRename(e.path, to)).catch((x) => toast(String(x), "err"));
    this.refresh(p);
  }

  private async remove(p: Pane, items: FileEntry[]) {
    if (!items.length) return;
    const what = items.length === 1 ? items[0].name : `${items.length} items`;
    const where = p.side === "remote" ? `from ${this.host.name}` : "from this computer";
    if (!(await confirmDialog(`Delete ${what}?`, `This permanently deletes it ${where}, including folder contents.`))) return;
    for (const e of items) {
      await (p.side === "remote" ? api.sftpRemove(this.sid, e.path) : api.localRemove(e.path)).catch((x) => toast(String(x), "err"));
    }
    this.refresh(p);
  }

  // ---------- events ----------

  private bind() {
    this.el.querySelector(".overlay")!.addEventListener("click", (e) => {
      const o = (e.target as HTMLElement).closest<HTMLElement>("[data-o]")?.dataset.o;
      if (o === "retry") this.connect();
      if (o === "close") this.onClose(this);
    });
    for (const p of Object.values(this.panes)) {
      const list = p.el.querySelector<HTMLElement>(".flist")!;
      p.el.querySelector(".fhead")!.addEventListener("click", (e) => {
        const f = (e.target as HTMLElement).closest<HTMLElement>("[data-f]")?.dataset.f;
        if (f === "up") this.cd(p, parent(p.path));
        else if (f === "home") (p.side === "remote" ? api.sftpHome(this.sid) : api.localHome()).then((h) => this.cd(p, h));
        else if (f === "refresh") this.refresh(p);
        else if (f === "mkdir") this.mkdir(p);
      });
      p.el.querySelector(".fpath")!.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") this.cd(p, (e.target as HTMLInputElement).value.trim());
      });
      const rowOf = (e: Event) => {
        const r = (e.target as HTMLElement).closest<HTMLElement>(".frow");
        return r ? p.entries.find((x) => x.path === r.dataset.path) : undefined;
      };
      list.addEventListener("click", (ev) => {
        const e = ev as MouseEvent;
        const entry = rowOf(e);
        if (!entry) {
          p.selected.clear();
        } else if (e.shiftKey && p.anchor) {
          const a = p.entries.findIndex((x) => x.path === p.anchor);
          const b = p.entries.indexOf(entry);
          p.selected = new Set(p.entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path));
        } else if (e.ctrlKey || e.metaKey) {
          p.selected.has(entry.path) ? p.selected.delete(entry.path) : p.selected.add(entry.path);
          p.anchor = entry.path;
        } else {
          p.selected = new Set([entry.path]);
          p.anchor = entry.path;
        }
        this.renderPane(p);
      });
      list.addEventListener("dblclick", (e) => {
        const entry = rowOf(e);
        if (!entry) return;
        if (entry.isDir) this.cd(p, entry.path);
        else this.transfer(p.side, [entry.path]);
      });
      list.addEventListener("keydown", (ev) => {
        const e = ev as KeyboardEvent;
        const sel = this.selection(p);
        if (e.key === "Delete") this.remove(p, sel);
        else if (e.key === "Backspace") this.cd(p, parent(p.path));
        else if (e.key === "F2" && sel[0]) this.rename(p, sel[0]);
        else if (e.key === "Enter" && sel.length) sel.length === 1 && sel[0].isDir ? this.cd(p, sel[0].path) : this.transfer(p.side, sel.map((x) => x.path));
        else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
          e.preventDefault();
          p.selected = new Set(p.entries.map((x) => x.path));
          this.renderPane(p);
        }
      });
      list.addEventListener("contextmenu", (ev) => {
        const e = ev as MouseEvent;
        e.preventDefault();
        const entry = rowOf(e);
        if (entry && !p.selected.has(entry.path)) {
          p.selected = new Set([entry.path]);
          this.renderPane(p);
        }
        const sel = this.selection(p);
        const verb = p.side === "local" ? `Upload to ${this.host.name}` : "Download to this computer";
        contextMenu(e.clientX, e.clientY, [
          ...(sel.length ? [{ label: verb, icon: p.side === "local" ? "import" : "import", action: () => this.transfer(p.side, sel.map((x) => x.path)) }] : []),
          ...(sel.length === 1 && sel[0].isDir ? [{ label: "Open", icon: "folder", action: () => this.cd(p, sel[0].path) }] : []),
          ...(sel.length === 1 ? [{ label: "Rename", icon: "edit", action: () => this.rename(p, sel[0]) }] : []),
          ...(sel.length ? [{ label: "Copy path", icon: "copy", action: () => api.clipboardWrite(sel.map((x) => x.path).join("\n")).then(() => toast("Copied", "ok")) }] : []),
          { label: "New folder", icon: "plus", action: () => this.mkdir(p) },
          { label: "Refresh", icon: "sync", action: () => this.refresh(p) },
          ...(sel.length ? ["-" as const, { label: "Delete", icon: "trash", danger: true, action: () => this.remove(p, sel) }] : []),
        ]);
      });
      // Drag rows between panes.
      list.addEventListener("dragstart", (ev) => {
        const e = ev as DragEvent;
        const entry = rowOf(e);
        if (!entry) return;
        if (!p.selected.has(entry.path)) p.selected = new Set([entry.path]);
        e.dataTransfer!.setData("application/x-kermius-files", JSON.stringify({ tab: this.id, side: p.side, paths: [...p.selected] }));
        e.dataTransfer!.effectAllowed = "copy";
      });
      list.addEventListener("dragover", (e) => {
        if ((e as DragEvent).dataTransfer?.types.includes("application/x-kermius-files")) {
          e.preventDefault();
          p.el.classList.add("drop");
        }
      });
      list.addEventListener("dragleave", () => p.el.classList.remove("drop"));
      list.addEventListener("drop", (ev) => {
        const e = ev as DragEvent;
        p.el.classList.remove("drop");
        const raw = e.dataTransfer?.getData("application/x-kermius-files");
        if (!raw) return;
        e.preventDefault();
        const d = JSON.parse(raw) as { tab: string; side: Side; paths: string[] };
        if (d.tab === this.id && d.side !== p.side) this.transfer(d.side, d.paths);
      });
    }
    this.el.querySelector(".ft-mode")!.addEventListener("click", (e) => {
      const m = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]")?.dataset.mode as "sftp" | "rsync" | undefined;
      if (!m) return;
      if (m === "rsync" && !this.rsync) return toast("rsync is not installed on this computer", "err");
      this.mode = m;
      localStorage.setItem("kermius.transferMode", m);
      this.renderMode();
    });
    this.el.querySelector(".ft-list")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cancel]");
      if (!b) return;
      const t = this.transfers.find((x) => x.tid === b.dataset.cancel);
      if (t) {
        api.transferCancel(t.tid);
        Object.assign(t, { status: "error", message: "Cancelled" });
        this.renderTransfers();
      }
    });
    // Files dropped from the OS onto the remote pane are uploaded.
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (this.el.hidden || ev.payload.type !== "drop") return;
        const { x, y } = ev.payload.position;
        const at = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio);
        if (at && this.panes.remote.el.contains(at)) this.transfer("local", ev.payload.paths);
      })
      .then((un) => (this.unlistenDrop = un))
      .catch(() => {});
  }

  private renderMode() {
    this.el.querySelectorAll<HTMLButtonElement>(".ft-mode button").forEach((b) => {
      b.classList.toggle("on", b.dataset.mode === this.mode);
      b.disabled = b.dataset.mode === "rsync" && !this.rsync;
    });
  }

  private renderTransfers() {
    const box = this.el.querySelector(".ft-list")!;
    box.innerHTML = this.transfers
      .slice(0, 50)
      .map((t) => {
        const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : t.status === "done" ? 100 : 0;
        return `<div class="ft-row ${t.status}">
          <span class="ft-dir">${t.upload ? "↑" : "↓"}</span><span class="ft-name">${esc(t.label)}</span>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <span class="ft-info">${t.status === "error" ? esc(t.message) : t.status === "done" ? "Done" : `${pct}% · ${fmtSize(t.done)}${t.total ? ` / ${fmtSize(t.total)}` : ""}`}</span>
          ${t.status === "running" && t.tid ? `<button class="icon-btn" data-cancel="${t.tid}" title="Cancel">${icon("x", 13)}</button>` : ""}</div>`;
      })
      .join("");
  }

  // ---------- tab interface ----------

  show() {
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  copyPassword() {
    api.copyPassword(this.host.id).then(
      () => toast("Password copied", "ok"),
      (e) => toast(String(e), "err"),
    );
  }

  runText() {
    toast("Snippets run in terminal tabs", "info");
  }

  applyPrefs() {}

  dispose() {
    this.unlistenDrop?.();
    for (const t of this.transfers) if (t.status === "running" && t.tid) api.transferCancel(t.tid);
    if (this.sid) api.sftpClose(this.sid);
    this.el.remove();
  }
}
