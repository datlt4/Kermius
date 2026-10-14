import { listen } from "@tauri-apps/api/event";
import { api, type FsEndpoint, type FsEvent, type FsJob, type FsPlan, type Host } from "./api";
import { conflictsDialog } from "./conflicts";
import { notify } from "./notify";
import { pickFolder } from "./folderpicker";
import { confirmDialog, contextMenu, esc, icon, morphHtml, toast } from "./ui";

export interface FolderSyncCtx {
  hosts(): Host[];
  /** Re-render the page if it is showing. */
  rerender(): void;
  /** Activity changed (sidebar indicator). */
  activity(): void;
}

/** "copying" beats "scanning": drives the sidebar indicator (red / yellow). */
export function syncActivity(): "copying" | "scanning" | null {
  const phases = [...live.values()].map((l) => l.phase);
  if (phases.includes("syncing")) return "copying";
  return phases.length ? "scanning" : null;
}

interface Live {
  phase: string;
  message: string;
  pct: number;
  rate: number;
  dir: string;
  /** Bytes already counted into the session totals for the current rsync step. */
  counted: number;
  /** Scan progress per side and when the run started. */
  scan: Partial<Record<"a" | "b", { files: number; dirs: number; bytes: number }>>;
  started: number;
}

const newLive = (): Live => ({ phase: "connecting", message: "", pct: 0, rate: 0, dir: "", counted: 0, scan: {}, started: Date.now() });

const elapsed = (since: number) => {
  const s = Math.floor((Date.now() - since) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** Bytes moved this session (up = to remotes, down = from remotes). */
const totals = { up: 0, down: 0, local: 0 };

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
};
const fmtNum = (n: number) => n.toLocaleString();
const statsLine = (s: { files: number; dirs: number; bytes: number }) =>
  `${icon("file", 12)} ${fmtNum(s.files)} ${icon("folder", 12)} ${fmtNum(s.dirs)} · ${fmtBytes(s.bytes)}`;

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

const COMMON_EXCLUDES = ["$RECYCLE.BIN", "System Volume Information", ".Trash-*", ".stfolder", ".stversions", ".DS_Store", "Thumbs.db", "desktop.ini"];

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
  initial: "a_to_b",
  excludes: [],
  keepPerms: false,
  keepOwner: false,
  keepSpecials: false,
  followLinks: false,
  intervalMin: 0,
  watch: true,
  lastRun: 0,
  lastAttempt: 0,
  lastResult: "",
  conflicts: 0,
  paused: false,
  statsA: { files: 0, dirs: 0, bytes: 0 },
  statsB: { files: 0, dirs: 0, bytes: 0 },
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
  if (l) {
    const t = elapsed(l.started);
    if (l.phase === "syncing") return { cls: "busy", text: `Syncing ${l.pct}% · ${t}` };
    if (l.phase === "scanning") {
      const sides = (["a", "b"] as const)
        .filter((k) => l.scan[k])
        .map((k) => `${k.toUpperCase()}: ${fmtNum(l.scan[k]!.files)} files, ${fmtNum(l.scan[k]!.dirs)} folders, ${fmtBytes(l.scan[k]!.bytes)}`);
      return { cls: "busy", text: `Scanning ${l.message} · ${t}${sides.length ? ` · ${sides.join(" | ")}` : ""}` };
    }
    return { cls: "busy", text: `${l.phase[0].toUpperCase()}${l.phase.slice(1)}… ${l.message} · ${t}` };
  }
  if (!job.lastResult) return { cls: "", text: "Never synced" };
  if (job.lastResult.startsWith(OFFLINE)) return { cls: "off", text: `Offline · ${job.lastResult.slice(OFFLINE.length)}` };
  if (job.lastResult === "Stopped") return { cls: "", text: `Stopped · ${job.paused ? "paused" : "will resume on the next run"}` };
  const ok = /^Up to date$|copied|deleted|conflicts kept/.test(job.lastResult);
  if (ok) return { cls: "ok", text: `${job.lastResult} · ${ago(job.lastRun)}` };
  // A few files failed (rsync 23/24): the rest synced, so warn rather than fail.
  return { cls: isPartial(job.lastResult) ? "warn" : "err", text: job.lastResult.split("\n")[0] };
}

const isPartial = (msg: string) => /^\d+ items? failed/.test(msg);

/** Background run outcome → notification center (no toasts for automatic runs). */
function noteResult(id: string, ok: boolean, summary: string) {
  const job = jobs.find((j) => j.id === id);
  const name = `Folder Sync · ${job?.name || "Untitled"}`;
  if (ok) return;
  if (summary === "Stopped" || summary === "Already running") return;
  if (summary.startsWith(OFFLINE)) notify("warn", name, `Offline: ${summary.slice(OFFLINE.length)}`, "foldersync");
  else notify(isPartial(summary) ? "warn" : "error", name, summary, "foldersync");
}

export async function loadJobs() {
  jobs = await api.fsyncList().catch(() => []);
  rsyncLocal ??= await api.rsyncAvailable().catch(() => false);
}

/** Worst watcher state across both sides of a job. */
function watchStatus(job: FsJob) {
  if (job.paused) return { cls: "paused", text: "Paused", limitHost: "" };
  if (!job.watch) return null;
  const sides = ["a", "b"].map((s) => watching.get(`${job.id}:${s}`)).filter(Boolean) as { state: string; message: string }[];
  const pick = (st: string) => sides.find((x) => x.state === st);
  const w = pick("offline") ?? pick("limit") ?? pick("polling") ?? pick("watching");
  if (!w) return { cls: "", text: "Starting watcher…", limitHost: "" };
  if (w.state === "offline") return { cls: "off", text: `Offline · ${w.message}`, limitHost: "" };
  if (w.state === "limit") {
    // Remote limits carry "<text>|<host id>"; local ones have no host.
    const [text, host] = w.message.split("|");
    return { cls: "limit", text: `${text}; checking every minute instead`, limitHost: host ?? "local" };
  }
  if (w.state === "polling") return { cls: "poll", text: `Checking every minute · ${w.message}`, limitHost: "" };
  return { cls: "ok", text: `Watching for changes${sides.map((x) => x.message).filter(Boolean).map((m) => ` · ${m}`).join("")}`, limitHost: "" };
}

/** Listen for run progress and watcher state from the backend (manual and automatic runs alike). */
export async function listenFolderSync(ctx: FolderSyncCtx) {
  // Keep elapsed times ticking while something runs.
  setInterval(() => live.size && ctx.rerender(), 1000);
  for (const [k, [state, message]] of Object.entries(await api.fsyncWatchStates().catch(() => ({})))) watching.set(k, { state, message });
  await listen<FsEvent>("fsync", async ({ payload: ev }) => {
    if (ev.type === "watch") {
      const prev = watching.get(`${ev.id}:${ev.side}`)?.state;
      watching.set(`${ev.id}:${ev.side}`, { state: ev.state, message: ev.message });
      if (ev.state === "limit" && prev !== "limit") {
        const job = jobs.find((j) => j.id === ev.id);
        notify("warn", `Folder Sync · ${job?.name || "Untitled"}`, ev.message.split("|")[0], "foldersync");
      }
    }
    else if (ev.type === "finished") {
      live.delete(ev.id);
      const before = jobs.find((j) => j.id === ev.id)?.conflicts ?? 0;
      await loadJobs();
      noteResult(ev.id, ev.ok, ev.summary);
      const job = jobs.find((j) => j.id === ev.id);
      if (job && job.conflicts > before)
        notify("warn", `Folder Sync · ${job.name || "Untitled"}`, `${job.conflicts} unresolved conflict${job.conflicts > 1 ? "s" : ""}`, "foldersync");
    } else {
      // Only a phase event starts a run; stray progress from a stopped run must not revive it.
      if (!live.has(ev.id) && ev.type !== "phase") return;
      const l = live.get(ev.id) ?? newLive();
      if (ev.type === "scan") l.scan[ev.side] = { files: ev.files, dirs: ev.dirs, bytes: ev.bytes };
      else if (ev.type === "phase") Object.assign(l, { phase: ev.phase, message: ev.message, rate: 0, counted: 0 });
      else {
        if (ev.done < l.counted) l.counted = 0; // next rsync step started
        totals[ev.dir] += ev.done - l.counted;
        Object.assign(l, { pct: ev.total ? Math.min(100, Math.round((ev.done / ev.total) * 100)) : 0, rate: ev.rate, dir: ev.dir, counted: ev.done });
      }
      live.set(ev.id, l);
    }
    ctx.rerender();
    ctx.activity();
  });
}

/** Remote machines across jobs, keyed by their route list, with the best-known connection state. */
function remoteDevices(ctx: FolderSyncCtx) {
  const devices = new Map<string, { name: string; state: string; text: string }>();
  for (const j of jobs) {
    for (const side of ["a", "b"] as const) {
      const ep = j[side];
      if (ep.kind !== "remote") continue;
      const key = ep.hosts.join(",");
      const name = ep.hosts.map((id) => ctx.hosts().find((h) => h.id === id)?.name ?? "?").join(" / ");
      const w = watching.get(`${j.id}:${side}`);
      const state = j.paused ? "paused" : (w?.state ?? (j.lastResult.startsWith(OFFLINE) ? "offline" : "unknown"));
      const text =
        state === "offline" ? "Disconnected" : state === "paused" ? "Paused" : state === "unknown" ? "Not watched" : `Connected ${(w?.message ?? "").split("|")[0].split(";")[0]}`;
      const prev = devices.get(key);
      if (!prev || prev.state === "unknown" || prev.state === "paused") devices.set(key, { name, state, text });
    }
  }
  return [...devices.values()];
}

export function renderFolderSync(root: HTMLElement, ctx: FolderSyncCtx) {
  const mac = /Mac/.test(navigator.userAgent);
  const rateUp = [...live.values()].filter((l) => l.dir === "up").reduce((n, l) => n + l.rate, 0);
  const rateDown = [...live.values()].filter((l) => l.dir === "down").reduce((n, l) => n + l.rate, 0);
  const local = jobs.reduce(
    (t, j) => {
      for (const side of ["a", "b"] as const) {
        if (j[side].kind !== "local") continue;
        const s = side === "a" ? j.statsA : j.statsB;
        t.files += s.files;
        t.dirs += s.dirs;
        t.bytes += s.bytes;
      }
      return t;
    },
    { files: 0, dirs: 0, bytes: 0 },
  );
  const watched = jobs.filter((j) => j.watch && !j.paused).length;
  const devices = remoteDevices(ctx);
  const allPaused = jobs.length > 0 && jobs.every((j) => j.paused);
  const html = `
    <div class="toolbar fs-toolbar"><div class="grow"></div>
      ${jobs.length ? `<button class="btn sm" data-fs="${allPaused ? "resume-all" : "pause-all"}">${icon(allPaused ? "play" : "stop", 14)} ${allPaused ? "Resume all" : "Pause all"}</button>
        <button class="btn sm" data-fs="rescan-all">${icon("sync", 14)} Rescan all</button>` : ""}
      <button class="btn primary" data-fs="new">${icon("plus", 16)}<span>New Sync</span></button></div>
    <div class="content">
      ${
        rsyncLocal === false
          ? `<div class="fs-warn"><b>rsync is not installed on this computer.</b> Folder Sync needs rsync 3.1 or newer.
              ${installList(mac ? [["macOS (Homebrew)", "brew install rsync"]] : INSTALL)}</div>`
          : ""
      }
      ${
        jobs.length
          ? `<div class="fs-overview">
              <div class="panel fs-device"><h5>This device</h5>
                <div class="fs-kv"><span>${icon("import", 13)} Download rate</span><b>${fmtBytes(rateDown)}/s <small class="muted">(${fmtBytes(totals.down)})</small></b></div>
                <div class="fs-kv"><span>${icon("import", 13)} Upload rate</span><b>${fmtBytes(rateUp)}/s <small class="muted">(${fmtBytes(totals.up)})</small></b></div>
                <div class="fs-kv"><span>${icon("terminal", 13)} Local state (total)</span><b>${statsLine(local)}</b></div>
                <div class="fs-kv"><span>${icon("eye", 13)} Watching</span><b>${watched}/${jobs.length} jobs</b></div>
              </div>
              <div class="panel fs-device"><h5>Remote devices (${devices.length})</h5>
                ${devices.map((d) => `<div class="fs-kv"><span>${icon("server", 13)} ${esc(d.name)}</span><b class="dev-${d.state}">${esc(d.text)}</b></div>`).join("") || `<p class="muted">No remote folders yet.</p>`}
              </div></div>
            <div class="fs-list">${jobs
              .map((j) => {
                const st = status(j);
                const w = watchStatus(j);
                const l = live.get(j.id);
                return `<div class="card fs-card ${j.paused ? "paused" : ""}" data-job="${j.id}">
                  <div class="fs-main">
                    <div class="fs-title"><b>${esc(j.name || "Untitled")}</b><span class="badge">${j.mode === "mirror" ? "Mirror" : "Two-way"}</span>
                      ${j.intervalMin ? `<span class="muted fs-sched">${icon("sync", 12)} ${INTERVALS.find((i) => i[0] === j.intervalMin)?.[1] ?? `${j.intervalMin} min`}</span>` : ""}</div>
                    <div class="fs-path">${sideLabel(j.a, ctx)}<span class="fs-arrow">${j.mode === "mirror" ? "→" : "⇄"}</span>${sideLabel(j.b, ctx)}</div>
                    ${j.lastRun ? `<div class="fs-stats"><span><b class="fs-side-tag">A</b>${statsLine(j.statsA)}</span><span><b class="fs-side-tag">B</b>${statsLine(j.statsB)}</span></div>` : ""}
                    <div class="fs-status ${st.cls}"><span class="dot-st"></span>${esc(st.text)}
                      ${l?.phase === "syncing" && l.rate ? `<span class="fs-rate">${l.dir === "down" ? "↓" : l.dir === "up" ? "↑" : "⇢"} ${fmtBytes(l.rate)}/s</span>` : ""}
                      ${st.cls === "err" ? `<button class="fs-conflicts" data-fs="details">Details</button>` : ""}
                      ${j.conflicts ? `<button class="fs-conflicts" data-fs="conflicts">⚠ ${j.conflicts} conflict${j.conflicts > 1 ? "s" : ""}</button>` : ""}</div>
                    ${
                      w
                        ? `<div class="fs-status ${w.cls}">${icon("eye", 13)}${esc(w.text)}
                            ${w.limitHost ? `<button class="fs-conflicts" data-fs="raise" data-host="${esc(w.limitHost)}">Raise limit</button>` : ""}</div>`
                        : ""
                    }
                    ${l?.phase === "syncing" ? `<div class="bar"><i style="width:${l.pct}%"></i></div>` : ""}
                  </div>
                  <div class="fs-actions">
                    <button class="icon-btn" data-fs="${j.paused ? "resume" : "pause"}" title="${j.paused ? "Resume" : "Pause"}">${icon(j.paused ? "play" : "stop", 15)}</button>
                    <button class="btn sm" data-fs="preview" ${l ? `disabled title="Busy: wait for the current sync or stop it"` : `title="List what would be copied or deleted, without changing anything"`}>${icon("eye", 14)} Preview</button>
                    ${
                      l
                        ? `<button class="btn danger sm" data-fs="stop" title="Stop now; the next run resumes partial files">${icon("stop", 14)} Stop</button>`
                        : `<button class="btn primary sm" data-fs="run">${icon("sync", 14)} Sync now</button>`
                    }
                    <button class="icon-btn" data-fs="edit" title="Edit">${icon("edit", 15)}</button>
                  </div></div>`;
              })
              .join("")}</div>`
          : `<div class="empty">${icon("sync", 40)}<h3>No folder syncs</h3>
              <p>Keep two folders in sync: two disks on this machine, or this machine and a server over SSH.</p>
              <button class="btn primary" data-fs="new">New Sync</button></div>`
      }
    </div>`;
  // Live updates arrive several times a second: patch in place so hover and scroll survive.
  if (root.querySelector(":scope > .fs-toolbar")) morphHtml(root, html);
  else root.innerHTML = html;
}

/** Run or preview; progress arrives through `listenFolderSync`. */
export async function runJob(id: string, ctx: FolderSyncCtx, dryRun = false, quiet = false) {
  if (live.has(id)) return;
  live.set(id, newLive());
  ctx.rerender();
  ctx.activity();
  try {
    const r = await api.fsyncRun(id, dryRun);
    if (dryRun) previewDialog(jobs.find((j) => j.id === id)!, r.summary, r.plan);
    else if (!quiet) toast(r.summary, "ok");
  } catch (e) {
    // Automatic runs stay silent here: the outcome goes to the notification center.
    const msg = String(e);
    if (!quiet) toast(msg.split("\n")[0].replace(OFFLINE, "Offline: "), msg.startsWith(OFFLINE) ? "info" : isPartial(msg) ? "info" : "err");
  } finally {
    live.delete(id);
    await loadJobs();
    ctx.rerender();
  }
}

/** Run jobs whose interval has elapsed (called every minute and at startup, so missed runs catch up). */
export function runDueJobs(ctx: FolderSyncCtx) {
  for (const j of jobs) {
    // Based on the last attempt, so a failing job waits a full interval instead of retrying every minute.
    if (!j.paused && j.intervalMin > 0 && Date.now() - Math.max(j.lastRun, j.lastAttempt ?? 0) >= j.intervalMin * 60_000) runJob(j.id, ctx, false, true);
  }
}

export function bindFolderSync(root: HTMLElement, ctx: FolderSyncCtx, active: () => boolean) {
  root.addEventListener("click", async (e) => {
    if (!active()) return;
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-fs]")?.dataset.fs;
    const id = t.closest<HTMLElement>("[data-job]")?.dataset.job;
    const job = jobs.find((j) => j.id === id);
    const cp = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
    if (cp) return api.clipboardWrite(cp).then(() => toast("Command copied", "ok"));
    if (act === "new") return jobDialog(emptyJob(), ctx);
    const pause = async (ids: string[], paused: boolean) => {
      await api.fsyncPause(ids, paused).catch((x) => toast(String(x), "err"));
      await loadJobs();
      ctx.rerender();
    };
    if (act === "pause-all" || act === "resume-all") return pause(jobs.map((j) => j.id), act === "pause-all");
    if (act === "rescan-all") return jobs.filter((j) => !j.paused).forEach((j) => runJob(j.id, ctx, false, true));
    if (!job) return;
    if (act === "pause" || act === "resume") return pause([job.id], act === "pause");
    if (act === "stop") {
      await api.fsyncStop(job.id).catch(() => {});
      // If nothing was running in the backend, clear the stale entry ourselves.
      setTimeout(() => {
        if (live.delete(job.id)) {
          ctx.rerender();
          ctx.activity();
        }
      }, 1500);
      return;
    }
    if (act === "raise") {
      const host = t.closest<HTMLElement>("[data-host]")!.dataset.host!;
      toast(host === "local" ? "Asking for the admin password…" : "Raising the limit on the remote…", "info");
      return (host === "local" ? api.fsyncRaiseInotify() : api.fsyncRaiseInotifyRemote(host)).then(
        () => toast("inotify limit raised; watching again", "ok"),
        (x) => toast(String(x), "err"),
      );
    }
    if (act === "run") return runJob(job.id, ctx);
    if (act === "preview") return runJob(job.id, ctx, true);
    if (act === "edit") return jobDialog(job, ctx);
    if (act === "details") return detailsDialog(job);
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

/** Full error text of the last run (rsync lists every failed item). */
function detailsDialog(job: FsJob) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  const lines = job.lastResult.split("\n");
  el.innerHTML = `<div class="modal form-modal"><h3>Last run: ${esc(job.name || "Untitled")}</h3>
    <p class="err">${esc(lines[0])}</p>
    ${lines.length > 1 ? `<div class="fs-plan">${lines.slice(1).map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
    <p class="muted">Files that failed are retried on the next run; files already copied are skipped.</p>
    <div class="modal-actions"><button class="btn ghost" data-m="copy">Copy</button><button class="btn primary" data-m="close">Close</button></div></div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.m === "copy") api.clipboardWrite(job.lastResult).then(() => toast("Copied", "ok"));
    else if (t === el || t.dataset.m === "close") el.remove();
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
      <button type="button" class="btn sm" data-browse="${key}">Browse…</button></div>
    ${
      ep.kind === "remote"
        ? `<small class="muted">Tick the hosts that reach this machine; they are tried top to bottom (e.g. wired, Wi-Fi, VPN).</small>
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
    draft.keepPerms = (f.elements.namedItem("keepPerms") as HTMLInputElement).checked;
    draft.keepOwner = (f.elements.namedItem("keepOwner") as HTMLInputElement).checked;
    draft.keepSpecials = (f.elements.namedItem("keepSpecials") as HTMLInputElement).checked;
    draft.followLinks = (el.querySelector('input[name="links"]:checked') as HTMLInputElement | null)?.value === "follow";
    const initial = f.elements.namedItem("initial") as HTMLSelectElement | null;
    if (initial) draft.initial = initial.value as FsJob["initial"];
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
      ${
        draft.mode === "twoway" && !draft.lastRun
          ? `<label class="field"><span>First sync</span><select name="initial">
              <option value="a_to_b" ${draft.initial === "a_to_b" ? "selected" : ""}>A → B: make B identical to A (overwrite, delete files only in B)</option>
              <option value="b_to_a" ${draft.initial === "b_to_a" ? "selected" : ""}>B → A: make A identical to B (overwrite, delete files only in A)</option>
              <option value="merge" ${draft.initial === "merge" || !draft.initial ? "selected" : ""}>Merge both (copy what is missing, delete nothing)</option></select>
              <small class="fs-initial-note">After the first sync, changes flow both ways. Identical files are never copied again. Use <b>Preview</b> to check what will be overwritten or deleted.</small></label>`
          : ""
      }
      <label class="check"><input type="checkbox" name="watch" ${draft.watch ? "checked" : ""} /> Watch for changes and sync automatically
        <small class="muted">(remote side: instant with <code>inotify-tools</code>, otherwise checked every minute)</small></label>
      <details class="fs-req" ${rsyncLocal === false || draft.a.kind === "remote" || draft.b.kind === "remote" ? "open" : ""}>
        <summary>How to install rsync and inotify-tools</summary>
        <p class="muted">Run on <b>this computer</b> and on <b>each remote host</b>. rsync 3.1+ is required
          (this computer: ${rsyncLocal === false ? `<span class="err">not found</span>` : rsyncLocal ? "installed ✓" : "unknown"});
          inotify-tools makes remote changes sync instantly.</p>
        ${installList([...INSTALL, ["macOS (this computer only)", "brew install rsync"]])}
      </details>
      <div class="field-row"><label class="field grow"><span>Run automatically (while Kermius is open)</span><select name="interval">${INTERVALS.map(
        ([m, l]) => `<option value="${m}" ${m === draft.intervalMin ? "selected" : ""}>${l}</option>`,
      ).join("")}</select></label></div>
      <div class="field"><span>Symlinks and attributes</span>
        <div class="fs-opts">
          <label class="check"><input type="radio" name="links" value="keep" ${draft.followLinks ? "" : "checked"} /> Copy symlinks as links</label>
          <label class="check"><input type="radio" name="links" value="follow" ${draft.followLinks ? "checked" : ""} /> Copy the files links point to</label>
          <label class="check"><input type="checkbox" name="keepPerms" ${draft.keepPerms ? "checked" : ""} /> Keep permissions (rwx)</label>
          <label class="check"><input type="checkbox" name="keepOwner" ${draft.keepOwner ? "checked" : ""} /> Keep owner and group <small class="muted">(owner needs root on the destination)</small></label>
          <label class="check"><input type="checkbox" name="keepSpecials" ${draft.keepSpecials ? "checked" : ""} /> Keep devices, sockets, FIFOs <small class="muted">(needs root)</small></label>
        </div>
        <small class="muted">Modification times are always kept. Leave permissions/owner off for NTFS, exFAT or FAT disks — they cannot store them and rsync would report errors.</small></div>
      <label class="field"><span>Exclude (one pattern per line, e.g. node_modules, *.tmp, .cache)</span><textarea name="excludes" rows="4">${esc(draft.excludes.join("\n"))}</textarea></label>
      <div class="row fs-exc-btns"><button type="button" class="btn sm" data-exc="common">${icon("plus", 13)} Add common excludes</button>
        <button type="button" class="btn sm" data-exc="stignore">${icon("import", 13)} Import .stignore</button></div>
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
    const exc = t.closest<HTMLElement>("[data-exc]")?.dataset.exc;
    if (exc) {
      read();
      let add: string[] = COMMON_EXCLUDES;
      if (exc === "stignore") {
        const local = [draft.a, draft.b].find((x) => x.kind === "local" && x.path);
        if (!local) return toast("Pick a local folder first", "err");
        try {
          const [patterns, skipped] = await api.fsyncImportStignore(local.path);
          add = patterns;
          toast(`Imported ${patterns.length} patterns${skipped ? `, skipped ${skipped} (! negations / #include are not supported)` : ""}`, "ok");
        } catch (x) {
          return toast(String(x), "err");
        }
      }
      draft.excludes = [...new Set([...draft.excludes, ...add])];
      (el.querySelector('[name="excludes"]') as HTMLTextAreaElement).value = draft.excludes.join("\n");
      return;
    }
    const browse = t.closest<HTMLElement>("[data-browse]")?.dataset.browse as "a" | "b" | undefined;
    if (browse) {
      read();
      const ep = draft[browse];
      const host = ep.kind === "remote" ? ctx.hosts().find((h) => h.id === ep.hosts[0]) : undefined;
      if (ep.kind === "remote" && !host) return toast("Tick a host first", "err");
      const dir = await pickFolder({ hostId: host?.id, hostName: host?.name, start: ep.path });
      if (dir) (el.querySelector(`[name="${browse}-path"]`) as HTMLInputElement).value = dir;
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
