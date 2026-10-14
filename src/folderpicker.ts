import { api, type FileEntry } from "./api";
import { esc, icon, promptDialog, toast } from "./ui";

const parent = (p: string) => {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
};
const join = (d: string, n: string) => (d.endsWith("/") ? d + n : `${d}/${n}`);

/** Folder browser (local, or remote over SFTP when `hostId` is set). Resolves to the chosen path or null. */
export function pickFolder(opts: { hostId?: string; hostName?: string; start?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let sid = "";
    let path = "";
    let selected = "";
    let dirs: FileEntry[] = [];
    const remote = !!opts.hostId;
    const el = document.createElement("div");
    el.className = "modal-wrap";
    el.innerHTML = `<div class="modal fp-modal">
      <div class="fhead"><span class="fbadge">${remote ? `${icon("server", 13)} ${esc(opts.hostName ?? "Remote")}` : `${icon("terminal", 13)} This computer`}</span>
        <button class="icon-btn" data-p="up" title="Up">${icon("back", 15)}</button>
        <button class="icon-btn" data-p="home" title="Home">${icon("server", 15)}</button>
        <input class="fpath" spellcheck="false" />
        <button class="icon-btn" data-p="refresh" title="Refresh">${icon("sync", 15)}</button>
        <button class="icon-btn" data-p="mkdir" title="New folder">${icon("plus", 15)}</button></div>
      <div class="flist fp-list"><div class="fempty">${remote ? "Connecting…" : "Loading…"}</div></div>
      <div class="fp-foot"><span class="muted fp-choice"></span><div class="grow"></div>
        <button class="btn ghost" data-p="cancel">Cancel</button><button class="btn primary" data-p="ok">Select folder</button></div></div>`;
    document.body.append(el);
    const finish = (v: string | null) => {
      if (sid) api.sftpClose(sid);
      el.remove();
      resolve(v);
    };
    const choice = () => selected || path;
    const render = () => {
      el.querySelector<HTMLInputElement>(".fpath")!.value = path;
      el.querySelector(".fp-choice")!.textContent = choice();
      el.querySelector(".fp-list")!.innerHTML =
        dirs.map((d) => `<div class="frow ${d.path === selected ? "sel" : ""}" data-path="${esc(d.path)}"><span class="fname">${icon("folder", 15)}<span>${esc(d.name)}</span></span></div>`).join("") ||
        `<div class="fempty">No subfolders</div>`;
    };
    const cd = async (p: string) => {
      try {
        const list = remote ? await api.sftpList(sid, p) : await api.localList(p);
        dirs = list.filter((x) => x.isDir);
        path = p;
        selected = "";
        render();
      } catch (e) {
        toast(String(e), "err");
      }
    };
    let lastClick = { path: "", t: 0 };
    const home = () => (remote ? api.sftpHome(sid) : api.localHome());
    (async () => {
      try {
        if (remote) sid = await api.sftpOpen(opts.hostId!);
        await cd(opts.start?.trim() || (await home()));
        if (!path) await cd(await home());
      } catch (e) {
        toast(String(e), "err");
        finish(null);
      }
    })();
    el.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      if (t === el) return finish(null);
      const row = t.closest<HTMLElement>(".frow");
      if (row) {
        // Second click on the same row within 400 ms opens it (independent of the dblclick event).
        const now = performance.now();
        if (lastClick.path === row.dataset.path && now - lastClick.t < 400) {
          lastClick = { path: "", t: 0 };
          return cd(row.dataset.path!);
        }
        lastClick = { path: row.dataset.path!, t: now };
        // Update in place: re-rendering here would swallow the double click.
        selected = row.dataset.path!;
        el.querySelectorAll(".fp-list .frow").forEach((r) => r.classList.toggle("sel", r === row));
        el.querySelector(".fp-choice")!.textContent = choice();
        return;
      }
      const a = t.closest<HTMLElement>("[data-p]")?.dataset.p;
      if (a === "cancel") finish(null);
      else if (a === "ok") finish(choice());
      else if (a === "up") cd(parent(path));
      else if (a === "home") cd(await home());
      else if (a === "refresh") cd(path);
      else if (a === "mkdir") {
        const name = await promptDialog("New folder", "Folder name");
        if (!name) return;
        const p = join(path, name);
        await (remote ? api.sftpMkdir(sid, p) : api.localMkdir(p)).catch((x) => toast(String(x), "err"));
        await cd(path);
        selected = p;
        render();
      }
    });
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter" && t.classList.contains("fpath")) cd((t as HTMLInputElement).value.trim());
    });
  });
}
