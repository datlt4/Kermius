import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type FsEndpoint, type FsEvent, type FsJob, type FsPlan, type Host } from "./api";
import { conflictsDialog } from "./conflicts";
import { confirmDialog, contextMenu, esc, icon, toast } from "./ui";

export interface FolderSyncCtx {
  hosts(): Host[];
  /** Re-render the page if it is showing. */
  rerender(): void;
}

interface Live {
  phase: string;
  message: string;
  pct: number;
}

const OFFLINE = "OFFLINE: ";
const INTERVALS: [number, string][] = [
  [0, "Manual"],
  [5, "Every 5 minutes"],
  [15, "Every 15 minutes"],
  [60, "Every hour"],
  [360, "Every 6 hours"],
  [1440, "Every day"],
];

/** Install commands per distro (remote needs rsync + GNU find; inotify-tools for instant sync). */
const INSTALL: [string, string][] = [
  ["Debian / Ubuntu / Raspberry Pi OS", "sudo apt install -y rsync inotify-tools"],
  ["Fedora / RHEL / Rocky", "sudo dnf install -y rsync inotify-tools"],
  ["Arch / Manjaro", "sudo pacman -S --needed rsync inotify-tools"],
  ["Alpine", "sudo apk add rsync inotify-tools findutils"],
  ["openSUSE", "sudo zypper install -y rsync inotify-tools"],
];

const installList = (rows: [string, string][]) =>
  rows
    .map(([os, cmd]) => `<div class="fs-cmd"><span class="muted">${esc(os)}</span><code>${esc(cmd)}</code>
      <button type="button" class="icon-btn" data-copy="${esc(cmd)}" title="Copy">${icon("copy", 13)}</button></div>`)
    .join("");

let rsyncLocal: boolean | null = null;

let jobs: FsJob[] = [];
const live = new Map<string, Live>();
/** Watcher state per "<job id>:<side>". */
const watching = new Map<string, { state: string; message: string }>();

const emptyJob = (): FsJob => ({
  id: "",
  name: "",
  mode: "twoway",
  a: { kind: "local", path: "", hosts: [] },
  b: { kind: "local", path: "", hosts: [] },
  delete: false,
  excludes: [],
  intervalMin: 0,
  watch: true,
  lastRun: 0,
  lastResult: "",
  conflicts: 0,
});

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function sideLabel(ep: FsEndpoint, ctx: FolderSyncCtx) {
  if (ep.kind === "local") return `<span class="fs-ep" title="${esc(ep.path)}">${icon("terminal", 13)}<span>${esc(ep.path)}</span></span>`;
  const names = ep.hosts.map((id) => ctx.hosts().find((h) => h.id === id)?.name ?? "?").join(" / ");
  return `<span class="fs-ep" title="${esc(names)}:${esc(ep.path)}">${icon("server", 13)}<span><b>${esc(names)}</b>:${esc(ep.path)}</span></span>`;
}

function status(job: FsJob) {
  const l = live.get(job.id);
  if (l) return { cls: "busy", text: l.phase === "syncing" ? `Syncing ${l.pct}%` : `${l.phase[0].toUpperCase()}${l.phase.slice(1)}… ${l.message}` };
  if (!job.lastResult) return { cls: "", text: "Never synced" };
  if (job.lastResult.startsWith(OFFLINE)) return { cls: "off", text: `Offline · ${job.lastResult.slice(OFFLINE.length)}` };
  const ok = /^Up to date$|copied|deleted|conflicts kept/.test(job.lastResult);
  return ok ? { cls: "ok", text: `${job.lastResult} · ${ago(job.lastRun)}` } : { cls: "err", text: job.lastResult };
}

export async function loadJobs() {
  jobs = await api.fsyncList().catch(() => []);
  rsyncLocal ??= await api.rsyncAvailable().catch(() => false);
}

/** Worst watcher state across both sides of a job. */
function watchStatus(job: FsJob) {
  if (!job.watch) return null;
  const sides = ["a", "b"].map((s) => watching.get(`${job.id}:${s}`)).filter(Boolean) as { state: string; message: string }[];
  const pick = (st: string) => sides.find((x) => x.state === st);
  const w = pick("offline") ?? pick("polling") ?? pick("watching");
  if (!w) return { cls: "", text: "Starting watcher…" };
  if (w.state === "offline") return { cls: "off", text: `Offline · ${w.message}` };
  if (w.state === "polling") return { cls: "poll", text: `Checking every minute · ${w.message}` };
  return { cls: "ok", text: `Watching for changes${sides.map((x) => x.message).filter(Boolean).map((m) => ` · ${m}`).join("")}` };
}

/** Listen for run progress and watcher state from the backend (manual and automatic runs alike). */
export async function listenFolderSync(ctx: FolderSyncCtx) {
  for (const [k, [state, message]] of Object.entries(await api.fsyncWatchStates().catch(() => ({})))) watching.set(k, { state, message });
  await listen<FsEvent>("fsync", async ({ payload: ev }) => {
    if (ev.type === "watch") watching.set(`${ev.id}:${ev.side}`, { state: ev.state, message: ev.message });
    else if (ev.type === "finished") {
      live.delete(ev.id);
      await loadJobs();
    } else {
      const l = live.get(ev.id) ?? { phase: "connecting", message: "", pct: 0 };
      if (ev.type === "phase") Object.assign(l, { phase: ev.phase, message: ev.message });
      else l.pct = ev.total ? Math.min(100, Math.round((ev.done / ev.total) * 100)) : 0;
      live.set(ev.id, l);
    }
    ctx.rerender();
  });
}

export function renderFolderSync(root: HTMLElement, ctx: FolderSyncCtx) {
  const mac = /Mac/.test(navigator.userAgent);
  root.innerHTML = `
    <div class="toolbar"><div class="grow"></div>
      <button class="btn primary" data-fs="new">${icon("plus", 16)}<span>New Sync</span></button></div>
    <div class="content">
      ${
        rsyncLocal === false
          ? `<div class="fs-warn"><b>rsync is not installed on this computer.</b> Folder Sync needs rsync 3.1 or newer.
              ${installList(mac ? [["macOS (Homebrew)", "brew install rsync"]] : INSTALL.map(([os, cmd]) => [os, cmd.replace(" inotify-tools", "").replace(" findutils", "")]))}</div>`
          : ""
      }
      ${
        jobs.length
          ? `<div class="fs-list">${jobs
              .map((j) => {
                const st = status(j);
                const w = watchStatus(j);
                const l = live.get(j.id);
                return `<div class="card fs-card" data-job="${j.id}">
                  <div class="fs-main">
                    <div class="fs-title"><b>${esc(j.name || "Untitled")}</b><span class="badge">${j.mode === "mirror" ? "Mirror" : "Two-way"}</span>
                      ${j.intervalMin ? `<span class="muted fs-sched">${icon("sync", 12)} ${INTERVALS.find((i) => i[0] === j.intervalMin)?.[1] ?? `${j.intervalMin} min`}</span>` : ""}</div>
                    <div class="fs-path">${sideLabel(j.a, ctx)}<span class="fs-arrow">${j.mode === "mirror" ? "→" : "⇄"}</span>${sideLabel(j.b, ctx)}</div>
                    <div class="fs-status ${st.cls}"><span class="dot-st"></span>${esc(st.text)}
                      ${j.conflicts ? `<button class="fs-conflicts" data-fs="conflicts">⚠ ${j.conflicts} conflict${j.conflicts > 1 ? "s" : ""}</button>` : ""}</div>
                    ${w ? `<div class="fs-status ${w.cls}">${icon("eye", 13)}${esc(w.text)}</div>` : ""}
                    ${l?.phase === "syncing" ? `<div class="bar"><i style="width:${l.pct}%"></i></div>` : ""}
                  </div>
                  <div class="fs-actions">
                    <button class="btn sm" data-fs="preview" ${l ? "disabled" : ""}>${icon("eye", 14)} Preview</button>
                    <button class="btn primary sm" data-fs="run" ${l ? "disabled" : ""}>${icon("play", 14)} Sync now</button>
                    <button class="icon-btn" data-fs="edit" title="Edit">${icon("edit", 15)}</button>
                  </div></div>`;
              })
              .join("")}</div>`
          : `<div class="empty">${icon("sync", 40)}<h3>No folder syncs</h3>
              <p>Keep two folders in sync: two disks on this machine, or this machine and a server over SSH.</p>
              <button class="btn primary" data-fs="new">New Sync</button></div>`
      }
    </div>`;
}

/** Run or preview; progress arrives through `listenFolderSync`. */
export async function runJob(id: string, ctx: FolderSyncCtx, dryRun = false, quiet = false) {
  if (live.has(id)) return;
  live.set(id, { phase: "connecting", message: "", pct: 0 });
  ctx.rerender();
  try {
    const r = await api.fsyncRun(id, dryRun);
    if (dryRun) previewDialog(jobs.find((j) => j.id === id)!, r.summary, r.plan);
    else if (!quiet) toast(r.summary, "ok");
  } catch (e) {
    const msg = String(e);
    if (!quiet || !msg.startsWith(OFFLINE)) toast(msg.replace(OFFLINE, "Offline: "), msg.startsWith(OFFLINE) ? "info" : "err");
  } finally {
    live.delete(id);
    await loadJobs();
    ctx.rerender();
  }
}

/** Run jobs whose interval has elapsed (called every minute and at startup, so missed runs catch up). */
export function runDueJobs(ctx: FolderSyncCtx) {
  for (const j of jobs) {
    if (j.intervalMin > 0 && Date.now() - j.lastRun >= j.intervalMin * 60_000) runJob(j.id, ctx, false, true);
  }
}

export function bindFolderSync(root: HTMLElement, ctx: FolderSyncCtx, active: () => boolean) {
  root.addEventListener("click", (e) => {
    if (!active()) return;
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-fs]")?.dataset.fs;
    const id = t.closest<HTMLElement>("[data-job]")?.dataset.job;
    const job = jobs.find((j) => j.id === id);
    const cp = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
    if (cp) return api.clipboardWrite(cp).then(() => toast("Command copied", "ok"));
    if (act === "new") return jobDialog(emptyJob(), ctx);
    if (!job) return;
    if (act === "run") return runJob(job.id, ctx);
    if (act === "preview") return runJob(job.id, ctx, true);
    if (act === "edit") return jobDialog(job, ctx);
    if (act === "conflicts") return conflictsDialog(job, () => loadJobs().then(ctx.rerender));
  });
  root.addEventListener("contextmenu", (e) => {
    if (!active()) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-job]")?.dataset.job;
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: "Sync now", icon: "play", action: () => runJob(job.id, ctx) },
      { label: "Preview", icon: "eye", action: () => runJob(job.id, ctx, true) },
      { label: "Edit", icon: "edit", action: () => jobDialog(job, ctx) },
      ...(job.mode === "twoway" ? [{ label: "Resolve conflicts", icon: "eye", action: () => conflictsDialog(job, () => loadJobs().then(ctx.rerender)) }] : []),
      "-" as const,
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        action: async () => {
          if (!(await confirmDialog(`Delete ${job.name}?`, "Only the sync job is removed; files in both folders stay as they are."))) return;
          await api.fsyncDelete(job.id);
          await loadJobs();
          ctx.rerender();
        },
      },
    ]);
  });
}

function previewDialog(job: FsJob, summary: string, plan: FsPlan) {
  const a = job.mode === "mirror" ? "source" : "A";
  const b = job.mode === "mirror" ? "destination" : "B";
  const section = (title: string, items: string[]) =>
    items.length
      ? `<details open><summary>${esc(title)} <b>${items.length}</b></summary><div class="fs-plan">${items
          .slice(0, 300)
          .map((x) => `<div>${esc(x)}</div>`)
          .join("")}${items.length > 300 ? `<div class="muted">… ${items.length - 300} more</div>` : ""}</div></details>`
      : "";
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<div class="modal form-modal"><h3>Preview: ${esc(job.name)}</h3><p class="muted">${esc(summary)}</p>
    ${section(`Copy ${a} → ${b}`, plan.copyAb)}${section(`Copy ${b} → ${a}`, plan.copyBa)}
    ${section(`Delete in ${a}`, plan.deleteA)}${section(`Delete in ${b}`, plan.deleteB)}
    ${section("Conflicts (newest wins, other kept as .sync-conflict copy)", plan.conflicts.map(([p, w]) => `${p}  (${w.toUpperCase()} wins)`))}
    <div class="modal-actions"><button class="btn ghost" data-m="close">Close</button></div></div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === el || t.dataset.m === "close") el.remove();
  });
}

function sideFields(key: "a" | "b", ep: FsEndpoint, ctx: FolderSyncCtx) {
  const hosts = [...ctx.hosts()].sort((x, y) => x.name.localeCompare(y.name));
  const order = [...ep.hosts, ...hosts.map((h) => h.id).filter((id) => !ep.hosts.includes(id))];
  return `<div class="fs-side" data-side="${key}">
    <div class="seg fs-kind"><button type="button" data-kind="local" class="${ep.kind === "local" ? "on" : ""}">This computer</button>
      <button type="button" data-kind="remote" class="${ep.kind === "remote" ? "on" : ""}">Remote (SSH)</button></div>
    <div class="input-group"><input name="${key}-path" value="${esc(ep.path)}" placeholder="${ep.kind === "local" ? "/media/you/Backup2TB/Photos" : "/home/user/Photos"}" spellcheck="false" />
      ${ep.kind === "local" ? `<button type="button" class="btn sm" data-browse="${key}">Browse…</button>` : ""}</div>
    ${
      ep.kind === "remote"
        ? `<details class="fs-req"><summary>Requirements on the remote</summary>
            <p class="muted"><b>rsync</b> and GNU <b>find</b> are required (Linux). <b>inotify-tools</b> makes remote changes sync instantly;
              without it Kermius checks every minute. Run on the remote:</p>${installList(INSTALL)}</details>
          <small class="muted">Tick the hosts that reach this machine; they are tried top to bottom (e.g. wired, Wi-Fi, VPN).</small>
          <input class="fs-route-filter" placeholder="Filter by name, IP, group or tag…" spellcheck="false" />
          <div class="fs-routes">
            ${order
              .map((id) => {
                const h = hosts.find((x) => x.id === id);
                return h
                  ? `<label class="fs-route" data-id="${id}" data-search="${esc([h.name, h.username, h.address, h.folder, ...h.tags].join(" ").toLowerCase())}">
                      <input type="checkbox" ${ep.hosts.includes(id) ? "checked" : ""} />
                      <span>${esc(h.name)} <small class="muted">${esc(h.username)}@${esc(h.address)}</small>
                        ${h.tags.map((t) => `<small class="mini-tag">${esc(t)}</small>`).join("")}</span>
                      <button type="button" class="icon-btn" data-move="up">↑</button><button type="button" class="icon-btn" data-move="down">↓</button></label>`
                  : "";
              })
              .join("")}</div>`
        : ""
    }</div>`;
}

function jobDialog(job: FsJob, ctx: FolderSyncCtx) {
  const draft: FsJob = structuredClone(job);
  const el = document.createElement("div");
  el.className = "modal-wrap";
  document.body.append(el);
  const read = () => {
    const f = el.querySelector("form")!;
    const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
    draft.name = v("name").trim();
    draft.mode = v("mode") as FsJob["mode"];
    draft.intervalMin = +v("interval");
    draft.delete = (f.elements.namedItem("delete") as HTMLInputElement | null)?.checked ?? false;
    draft.watch = (f.elements.namedItem("watch") as HTMLInputElement | null)?.checked ?? false;
    draft.excludes = v("excludes").split("\n").map((x) => x.trim()).filter(Boolean);
    for (const k of ["a", "b"] as const) {
      draft[k].path = v(`${k}-path`).trim();
      if (draft[k].kind === "remote") {
        draft[k].hosts = [...el.querySelectorAll<HTMLElement>(`.fs-side[data-side="${k}"] .fs-route`)]
          .filter((r) => r.querySelector("input")!.checked)
          .map((r) => r.dataset.id!);
      }
    }
  };
  const render = () => {
    el.innerHTML = `<form class="modal form-modal fs-modal"><h3>${job.id ? "Edit sync" : "New sync"}</h3>
      <div class="field-row"><label class="field grow"><span>Name</span><input name="name" value="${esc(draft.name)}" placeholder="Photos backup" /></label>
        <label class="field"><span>Mode</span><select name="mode"><option value="twoway" ${draft.mode === "twoway" ? "selected" : ""}>Two-way sync</option>
          <option value="mirror" ${draft.mode === "mirror" ? "selected" : ""}>Mirror (A → B)</option></select></label></div>
      <div class="field"><span>Folder A${draft.mode === "mirror" ? " (source)" : ""}</span>${sideFields("a", draft.a, ctx)}</div>
      <div class="field"><span>Folder B${draft.mode === "mirror" ? " (destination)" : ""}</span>${sideFields("b", draft.b, ctx)}</div>
      ${draft.mode === "mirror" ? `<label class="check"><input type="checkbox" name="delete" ${draft.delete ? "checked" : ""} /> Delete files in B that were removed from A</label>` : ""}
      <label class="check"><input type="checkbox" name="watch" ${draft.watch ? "checked" : ""} /> Watch for changes and sync automatically
        <small class="muted">(remote side: instant with <code>inotify-tools</code>, otherwise checked every minute)</small></label>
      <div class="field-row"><label class="field grow"><span>Run automatically (while Kermius is open)</span><select name="interval">${INTERVALS.map(
        ([m, l]) => `<option value="${m}" ${m === draft.intervalMin ? "selected" : ""}>${l}</option>`,
      ).join("")}</select></label></div>
      <label class="field"><span>Exclude (one pattern per line, e.g. node_modules, *.tmp, .cache)</span><textarea name="excludes" rows="3">${esc(draft.excludes.join("\n"))}</textarea></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`;
  };
  render();
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === el || t.dataset.m === "cancel") return el.remove();
    const kindBtn = t.closest<HTMLElement>("[data-kind]");
    if (kindBtn) {
      read();
      const k = kindBtn.closest<HTMLElement>(".fs-side")!.dataset.side as "a" | "b";
      draft[k].kind = kindBtn.dataset.kind as FsEndpoint["kind"];
      return render();
    }
    const cp = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
    if (cp) return api.clipboardWrite(cp).then(() => toast("Command copied", "ok"));
    const browse = t.closest<HTMLElement>("[data-browse]")?.dataset.browse;
    if (browse) {
      const dir = await openDialog({ directory: true }).catch(() => null);
      if (typeof dir === "string") (el.querySelector(`[name="${browse}-path"]`) as HTMLInputElement).value = dir;
      return;
    }
    const move = t.closest<HTMLElement>("[data-move]")?.dataset.move;
    if (move) {
      const row = t.closest<HTMLElement>(".fs-route")!;
      const sib = move === "up" ? row.previousElementSibling : row.nextElementSibling;
      if (sib?.classList.contains("fs-route")) move === "up" ? sib.before(row) : sib.after(row);
    }
  });
  el.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains("fs-route-filter")) return;
    const q = t.value.trim().toLowerCase();
    t.closest(".fs-side")!.querySelectorAll<HTMLElement>(".fs-route").forEach((r) => {
      r.hidden = !!q && !q.split(/\s+/).every((w) => r.dataset.search!.includes(w)) && !r.querySelector("input")!.checked;
    });
  });
  el.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).getAttribute("name") === "mode") {
      read();
      render();
    }
  });
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    read();
    try {
      await api.fsyncSave(draft);
      el.remove();
      await loadJobs();
      ctx.rerender();
      toast("Saved. Use Preview to check what will happen before the first sync.", "ok");
    } catch (err) {
      toast(String(err), "err");
    }
  });
  el.addEventListener("keydown", (e) => e.key === "Escape" && el.remove());
}
