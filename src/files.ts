import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, Channel, type FileEntry, type Host, type TransferEvent } from "./api";
import { confirmDialog, contextMenu, esc, fuzzyScore, icon, promptDialog, toast } from "./ui";

type Side = "local" | "remote";
type SortKey = "name" | "size" | "mtime";

interface Pane {
  side: Side;
  path: string;
  /** Sorted by `sort`; `shown()` applies the filter. */
  entries: FileEntry[];
  selected: Set<string>;
  anchor: string;
  el: HTMLElement;
  sort: { key: SortKey; desc: boolean };
  filter: string;
}

/** Folders first, then by the chosen column. */
function sortEntries(list: FileEntry[], s: Pane["sort"]) {
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const by = s.key === "name" ? byName : s.key === "size" ? (a: FileEntry, b: FileEntry) => a.size - b.size : (a: FileEntry, b: FileEntry) => a.mtime - b.mtime;
  return list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (s.desc ? -1 : 1) * by(a, b) || byName(a, b));
}

/** Show dot-files; one setting for both panes, kept across tabs. */
let showHidden = localStorage.getItem("kermius.files.hidden") === "1";

/** Rows to show: all entries, or the fuzzy matches best first. */
function shown(p: Pane) {
  const q = p.filter.toLowerCase();
  const list = showHidden ? p.entries : p.entries.filter((e) => !e.name.startsWith("."));
  if (!q) return list;
  return list
    .map((e) => [e, fuzzyScore(q, e.name)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);
}

interface Transfer {
  tid: string;
  label: string;
  upload: boolean;
  done: number;
  total: number;
  /** Smoothed bytes/s and the last sample it was measured from. */
  rate: number;
  at: number;
  atDone: number;
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
/** " · 12 MB/s · 3m 10s left · done ~14:05" once the speed is known. */
function eta(t: Transfer) {
  if (!t.rate) return "";
  const speed = ` · ${fmtSize(t.rate)}/s`;
  if (!t.total || t.done >= t.total) return speed;
  const s = Math.round((t.total - t.done) / t.rate);
  const left = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const end = new Date(Date.now() + s * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${speed} · ${left} left · done ~${end}`;
}
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
                <input class="ffilter" placeholder="Filter" spellcheck="false" title="Fuzzy filter this folder (or just start typing in the list)" />
                <button class="icon-btn" data-f="hidden" title="Show hidden files">${icon("eye-off", 15)}</button>
                <button class="icon-btn" data-f="delete" title="Delete selected (Del)">${icon("trash", 15)}</button>
                <button class="icon-btn" data-f="refresh" title="Refresh">${icon("sync", 15)}</button>
                <button class="icon-btn" data-f="mkdir" title="New folder">${icon("plus", 15)}</button>
              </div>
              <div class="flist-head"><button data-sort="name">Name</button><button data-sort="size">Size</button><button data-sort="mtime">Modified</button></div>
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
    const pane = (side: Side): Pane => ({
      side,
      path: "",
      entries: [],
      selected: new Set(),
      anchor: "",
      el: this.el.querySelector(`.fpane[data-side="${side}"]`)!,
      sort: { key: "name", desc: false },
      filter: "",
    });
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
      p.entries = sortEntries(await this.ls(p, path), p.sort);
      if (path !== p.path) {
        p.filter = "";
        (p.el.querySelector(".ffilter") as HTMLInputElement).value = "";
      }
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
    const hid = p.el.querySelector<HTMLElement>('[data-f="hidden"]')!;
    hid.innerHTML = icon(showHidden ? "eye" : "eye-off", 15);
    hid.title = showHidden ? "Hide hidden files" : "Show hidden files";
    p.el.querySelectorAll<HTMLElement>(".flist-head [data-sort]").forEach((b) => {
      const on = b.dataset.sort === p.sort.key;
      b.classList.toggle("on", on);
      b.dataset.arrow = on ? (p.sort.desc ? "▼" : "▲") : "";
    });
    p.el.querySelector(".flist")!.innerHTML =
      shown(p)
        .map(
          (e) => `<div class="frow ${p.selected.has(e.path) ? "sel" : ""}" draggable="true" data-path="${esc(e.path)}">
            <span class="fname">${icon(e.isDir ? "folder" : "file", 15)}<span>${esc(e.name)}${e.isLink ? " ↪" : ""}</span></span>
            <span class="fsize">${e.isDir ? "" : fmtSize(e.size)}</span><span class="fdate">${fmtDate(e.mtime)}</span></div>`,
        )
        .join("") || `<div class="fempty">${p.filter ? "No matches" : "Empty folder"}</div>`;
  }

  /** Update row highlighting without re-rendering (keeps double click working). */
  private markSelection(p: Pane) {
    p.el.querySelectorAll<HTMLElement>(".frow").forEach((r) => r.classList.toggle("sel", p.selected.has(r.dataset.path!)));
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
    // Files' sizes are known from the listing; rsync's own total is an estimate that drifts.
    const items = paths.map((x) => this.panes[from].entries.find((e) => e.path === x));
    const known = items.every((e) => e && !e.isDir) ? items.reduce((n, e) => n + e!.size, 0) : 0;
    const t: Transfer = {
      tid: "",
      label: paths.length === 1 ? paths[0].split(/[\\/]/).pop()! : `${paths.length} items`,
      upload,
      done: 0,
      total: 0,
      rate: 0,
      at: 0,
      atDone: 0,
      status: "running",
      message: "",
    };
    this.transfers.unshift(t);
    const ch = new Channel<TransferEvent>();
    ch.onmessage = (ev) => {
      if (ev.type === "progress") {
        const now = performance.now();
        if (!t.at || ev.done < t.atDone) Object.assign(t, { at: now, atDone: ev.done });
        else if (now - t.at > 500) {
          const r = ((ev.done - t.atDone) / (now - t.at)) * 1000;
          t.rate = t.rate ? t.rate * 0.7 + r * 0.3 : r;
          Object.assign(t, { at: now, atDone: ev.done });
        }
        t.done = ev.done;
        // Unknown size (folders): keep the estimate unless it moves by more than 2%.
        t.total = known || (t.total && Math.abs(ev.total - t.total) <= t.total * 0.02 ? t.total : ev.total);
      }
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
        else if (f === "delete") this.remove(p, this.selection(p));
        else if (f === "hidden") {
          showHidden = !showHidden;
          localStorage.setItem("kermius.files.hidden", showHidden ? "1" : "0");
          Object.values(this.panes).forEach((x) => this.renderPane(x));
        }
      });
      p.el.querySelector(".flist-head")!.addEventListener("click", (e) => {
        const key = (e.target as HTMLElement).closest<HTMLElement>("[data-sort]")?.dataset.sort as SortKey | undefined;
        if (!key) return;
        // Same column flips the order; a new one starts A→Z, or largest / newest first.
        p.sort = key === p.sort.key ? { key, desc: !p.sort.desc } : { key, desc: key !== "name" };
        sortEntries(p.entries, p.sort);
        this.renderPane(p);
      });
      const filter = p.el.querySelector<HTMLInputElement>(".ffilter")!;
      filter.addEventListener("input", () => {
        p.filter = filter.value.trim();
        this.renderPane(p);
      });
      filter.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          filter.value = p.filter = "";
          this.renderPane(p);
          list.focus();
        } else if (e.key === "ArrowDown" || e.key === "Enter") {
          e.preventDefault();
          const first = shown(p)[0];
          if (first) {
            p.selected = new Set([first.path]);
            p.anchor = first.path;
            this.markSelection(p);
          }
          list.focus();
        }
      });
      p.el.querySelector(".fpath")!.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") this.cd(p, (e.target as HTMLInputElement).value.trim());
      });
      const rowOf = (e: Event) => {
        const r = (e.target as HTMLElement).closest<HTMLElement>(".frow");
        return r ? p.entries.find((x) => x.path === r.dataset.path) : undefined;
      };
      let lastClick = { path: "", t: 0 };
      const open = (entry: FileEntry) => (entry.isDir ? this.cd(p, entry.path) : this.transfer(p.side, [entry.path]));
      list.addEventListener("click", (ev) => {
        const e = ev as MouseEvent;
        const entry = rowOf(e);
        // Second plain click on the same row within 400 ms = open (independent of the dblclick event).
        const now = performance.now();
        if (entry && !e.shiftKey && !e.ctrlKey && !e.metaKey && lastClick.path === entry.path && now - lastClick.t < 400) {
          lastClick = { path: "", t: 0 };
          return open(entry);
        }
        lastClick = { path: entry?.path ?? "", t: now };
        if (!entry) {
          p.selected.clear();
        } else if (e.shiftKey && p.anchor) {
          const rows = shown(p);
          const a = rows.findIndex((x) => x.path === p.anchor);
          const b = rows.indexOf(entry);
          p.selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path));
        } else if (e.ctrlKey || e.metaKey) {
          p.selected.has(entry.path) ? p.selected.delete(entry.path) : p.selected.add(entry.path);
          p.anchor = entry.path;
        } else {
          p.selected = new Set([entry.path]);
          p.anchor = entry.path;
        }
        this.markSelection(p);
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
          p.selected = new Set(shown(p).map((x) => x.path));
          this.markSelection(p);
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
          // Typing in the list starts the filter.
          e.preventDefault();
          filter.value += e.key;
          filter.dispatchEvent(new Event("input"));
          filter.focus();
        }
      });
      list.addEventListener("contextmenu", (ev) => {
        const e = ev as MouseEvent;
        e.preventDefault();
        const entry = rowOf(e);
        if (entry && !p.selected.has(entry.path)) {
          p.selected = new Set([entry.path]);
          this.markSelection(p);
        }
        const sel = this.selection(p);
        const verb = p.side === "local" ? `Upload to ${this.host.name}` : "Download to this computer";
        contextMenu(e.clientX, e.clientY, [
          ...(sel.length ? [{ label: verb, icon: p.side === "local" ? "upload" : "import", action: () => this.transfer(p.side, sel.map((x) => x.path)) }] : []),
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
          <span class="ft-info">${t.status === "error" ? esc(t.message) : t.status === "done" ? "Done" : `${pct}% · ${fmtSize(t.done)}${t.total ? ` / ${fmtSize(t.total)}` : ""}${eta(t)}`}</span>
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
