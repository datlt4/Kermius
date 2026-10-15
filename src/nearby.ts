import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type Host, type NearbyEvent, type NearbyStatus, type NearbyTransfer } from "./api";
import { notify } from "./notify";
import { esc, icon, morphHtml, toast } from "./ui";

const KEY = "kermius.nearby";
let status: NearbyStatus = { running: false, alias: "", port: 0, dir: "", devices: [], error: "" };
const transfers = new Map<string, NearbyTransfer>();
let busy = false;
let hosts: () => Host[] = () => [];
/** Host id → fingerprint of the app answering at its address ("" = offline). */
const probed = new Map<string, string>();
let lastProbe = 0;

/** Saved hosts marked for Nearby Share are asked directly (works across VPNs). */
async function probeHosts(rerender: () => void) {
  const list = hosts().filter((h) => h.nearby && h.address);
  if (!status.running || !list.length) return;
  lastProbe = Date.now();
  const found = await api.nearbyProbe([...new Set(list.map((h) => h.address))]).catch(() => []);
  for (const h of list) probed.set(h.id, found.find((d) => d.ip === h.address)?.fingerprint ?? "");
  rerender();
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

const enabled = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const setEnabled = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
};

async function setRunning(on: boolean, rerender: () => void) {
  busy = true;
  rerender();
  try {
    if (on) {
      status = await api.nearbyStart();
      probeHosts(rerender);
    }
    else {
      await api.nearbyStop();
      status = await api.nearbyStatus();
    }
    setEnabled(on);
  } catch (e) {
    toast(String(e), "err");
  } finally {
    busy = false;
    rerender();
  }
}

/** Incoming request: ask before anything is written. */
function requestDialog(id: string, alias: string, files: [string, number][]) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.dataset.request = id;
  const total = files.reduce((n, [, s]) => n + s, 0);
  el.innerHTML = `<div class="modal"><h3>${esc(alias)} wants to send you ${files.length} file${files.length === 1 ? "" : "s"}</h3>
    <p class="muted">${fmtSize(total)} · saved to ${esc(status.dir)}</p>
    <div class="nb-req-files">${files.slice(0, 50).map(([n, s]) => `<div><span>${esc(n)}</span><small>${fmtSize(s)}</small></div>`).join("")}
      ${files.length > 50 ? `<div class="muted">… and ${files.length - 50} more</div>` : ""}</div>
    <div class="modal-actions"><button class="btn ghost" data-r="0">Decline</button><button class="btn primary" data-r="1">Accept</button></div></div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).dataset.r;
    if (r === undefined) return;
    el.remove();
    api.nearbyRespond(id, r === "1");
  });
}

export async function initNearby(rerender: () => void, savedHosts: () => Host[], active: () => boolean) {
  hosts = savedHosts;
  setInterval(() => active() && probeHosts(rerender), 15_000);
  await listen<NearbyEvent>("nearby", ({ payload: ev }) => {
    if (ev.kind === "devices") status.devices = ev.devices;
    else if (ev.kind === "request") {
      requestDialog(ev.id, ev.alias, ev.files);
      notify("info", "Nearby Share", `${ev.alias} wants to send ${ev.files.length} file(s)`, "nearby");
    } else if (ev.kind === "requestGone") document.querySelector(`[data-request="${ev.id}"]`)?.remove();
    else {
      const { kind: _, ...t } = ev;
      const prev = transfers.get(t.id);
      transfers.set(t.id, t);
      if (t.state !== prev?.state && t.incoming && t.state === "done") notify("info", "Nearby Share", `Received ${t.files} file(s) from ${t.peer}`, "nearby");
      if (t.state !== prev?.state && !t.incoming && t.state === "declined") toast(`${t.peer} declined the files`, "err");
    }
    rerender();
  });
  // Files dropped from the OS onto a device card are sent to it.
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      const over = (p: { x: number; y: number }) =>
        document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio)?.closest<HTMLElement>("[data-nb-dev]");
      document.querySelectorAll(".nb-dev.drop").forEach((c) => c.classList.remove("drop"));
      if (ev.payload.type === "over") over(ev.payload.position)?.classList.add("drop");
      if (ev.payload.type !== "drop") return;
      const card = over(ev.payload.position);
      if (card) send(card.dataset.nbDev!, ev.payload.paths);
    })
    .catch(() => {});
  status = await api.nearbyStatus().catch(() => status);
  if (enabled() && !status.running) await setRunning(true, rerender);
}

function send(fingerprint: string, paths: string[]) {
  if (paths.length) api.nearbySend(fingerprint, paths).catch((e) => toast(String(e), "err"));
}

const devIcon = (t: string) => (t === "mobile" ? "phone" : t === "web" ? "globe" : "monitor");

function transferRow(t: NearbyTransfer) {
  const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : t.state === "done" ? 100 : 0;
  const label: Record<string, string> = {
    waiting: "Waiting for the other device to accept…",
    active: `${pct}% · ${fmtSize(t.done)} / ${fmtSize(t.total)}`,
    done: `Done · ${fmtSize(t.total)}`,
    declined: "Declined",
    failed: t.error || "Failed",
    cancelled: "Cancelled",
  };
  const live = t.state === "waiting" || t.state === "active";
  return `<div class="nb-tr ${t.state}">
    <span class="nb-dir" title="${t.incoming ? "Received" : "Sent"}">${t.incoming ? "↓" : "↑"}</span>
    <div class="nb-tr-body"><div><b>${esc(t.peer)}</b> <span class="muted">· ${t.files} file${t.files === 1 ? "" : "s"}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div><small class="muted">${esc(label[t.state])}</small></div>
    ${live ? `<button class="btn ghost sm" data-nb="cancel" data-id="${t.id}">Cancel</button>`
      : t.incoming && t.state === "done" ? `<button class="btn ghost sm" data-nb="open">${icon("folder", 14)} Open</button>` : ""}
  </div>`;
}

function hostCards() {
  const list = hosts().filter((h) => h.nearby && h.address).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!list.length) return "";
  return `<h4 class="section">Your hosts</h4><div class="grid">${list
    .map((h) => {
      const fp = probed.get(h.id);
      const dev = fp ? status.devices.find((d) => d.fingerprint === fp) : undefined;
      const state = fp === undefined ? "Checking…" : dev ? `${dev.alias} · ${dev.deviceModel || "online"}` : "Offline: Kermius / LocalSend not running";
      return `<div class="card nb-dev ${dev ? "" : "offline"}" ${dev ? `data-nb-dev="${esc(dev.fingerprint)}"` : ""}>
        <div class="avatar" style="--h:${dev ? 150 : 220}">${icon("server", 20)}</div>
        <div class="card-body"><div class="card-title">${esc(h.name || h.address)}</div><div class="card-sub">${esc(h.address)} · ${esc(state)}</div></div>
        <div class="nb-actions"><button class="btn ghost sm" data-nb="files" title="Send files" ${dev ? "" : "disabled"}>${icon("file", 14)}</button>
          <button class="btn ghost sm" data-nb="folder" title="Send a folder" ${dev ? "" : "disabled"}>${icon("folder", 14)}</button></div></div>`;
    })
    .join("")}</div>`;
}

export function renderNearby(root: HTMLElement) {
  const on = status.running;
  if (on && Date.now() - lastProbe > 15_000) probeHosts(() => root.querySelector(".nb-toolbar") && renderNearby(root));
  const mine = new Set(probed.values());
  const others = status.devices.filter((d) => !mine.has(d.fingerprint));
  const list = [...transfers.values()].reverse();
  const html = `
    <div class="toolbar nb-toolbar">
      <label class="toggle-row nb-me"><span><b>Visible as “${esc(status.alias || "this device")}”</b>
        <small class="muted">${on ? `Discoverable on the local network · port ${status.port}` : "Off: not discoverable, cannot send or receive"}</small></span>
        <input type="checkbox" class="toggle" id="nb-on" ${on ? "checked" : ""} ${busy ? "disabled" : ""} /></label>
      <div class="grow"></div>
      ${on ? `<button class="btn sm" data-nb="refresh">${icon("sync", 14)} Refresh</button>` : ""}
      <button class="btn sm" data-nb="open" title="${esc(status.dir)}">${icon("folder", 14)} Received files</button>
    </div>
    <div class="content">
      ${!on
        ? `<div class="empty">${icon("share", 40)}<h3>Nearby Share</h3>
            <p>Send files to phones and computers on the same network, and receive from them.<br/>Works with the LocalSend app (Android, iOS, Windows, macOS, Linux) and other Kermius devices.</p>
            <button class="btn primary" data-nb="on" ${busy ? "disabled" : ""}>Turn on</button></div>`
        : `${hostCards()}<h4 class="section">Nearby devices</h4>
          ${others.length
            ? `<div class="grid">${others.map((d) => `<div class="card nb-dev" data-nb-dev="${esc(d.fingerprint)}">
                <div class="avatar" style="--h:${d.deviceType === "mobile" ? 150 : 215}">${icon(devIcon(d.deviceType), 20)}</div>
                <div class="card-body"><div class="card-title">${esc(d.alias)}</div><div class="card-sub">${esc([d.deviceModel, d.ip].filter(Boolean).join(" · "))}</div></div>
                <div class="nb-actions"><button class="btn ghost sm" data-nb="files" title="Send files">${icon("file", 14)}</button>
                  <button class="btn ghost sm" data-nb="folder" title="Send a folder">${icon("folder", 14)}</button></div></div>`).join("")}</div>
              <p class="muted nb-hint">Drop files on a device, or use its buttons.</p>`
            : `<div class="nb-searching muted">${icon("sync", 16)} Looking for devices… Open LocalSend or Kermius on another device in this network.
                Across a VPN, tick “Use this address for Nearby Share” on the host instead.</div>`}
          ${list.length ? `<h4 class="section">Transfers</h4><div class="nb-trs">${list.map(transferRow).join("")}</div>` : ""}`}
    </div>`;
  if (root.querySelector(".nb-toolbar")) morphHtml(root, html);
  else root.innerHTML = html;
}

export function bindNearby(root: HTMLElement, rerender: () => void, active: () => boolean) {
  root.addEventListener("change", (e) => {
    if (active() && (e.target as HTMLElement).id === "nb-on") setRunning((e.target as HTMLInputElement).checked, rerender);
  });
  root.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-nb]");
    if (!b || !active()) return;
    if (!b) return;
    const dev = b.closest<HTMLElement>("[data-nb-dev]")?.dataset.nbDev;
    switch (b.dataset.nb) {
      case "on":
        return setRunning(true, rerender);
      case "refresh":
        probeHosts(rerender);
        return api.nearbyRefresh().catch((e) => toast(String(e), "err"));
      case "open":
        return api.nearbyOpenFolder().catch((e) => toast(String(e), "err"));
      case "cancel":
        return api.nearbyCancel(b.dataset.id!);
      case "files":
      case "folder": {
        const picked = await openDialog({ multiple: b.dataset.nb === "files", directory: b.dataset.nb === "folder" });
        if (dev && picked) send(dev, Array.isArray(picked) ? picked : [picked]);
      }
    }
  });
}
