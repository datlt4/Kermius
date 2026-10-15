import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type Host, type NearbyEvent, type NearbyStatus, type NearbyTransfer } from "./api";
import { notify } from "./notify";
import { esc, icon, morphHtml, toast } from "./ui";

const KEY = "kermius.nearby";
/** Phones cannot open folders or pick a save folder (pickers return content:// URIs). */
const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);
/** This device's folder for received files ("" = Downloads); not synced. */
const DIR_KEY = "kermius.nearbyDir";
const savedDir = () => {
  try {
    return localStorage.getItem(DIR_KEY) ?? "";
  } catch {
    return "";
  }
};

async function setSaveDir(dir: string, rerender: () => void) {
  try {
    status = await api.nearbySetDir(dir);
    try {
      dir ? localStorage.setItem(DIR_KEY, dir) : localStorage.removeItem(DIR_KEY);
    } catch {}
  } catch (e) {
    toast(String(e), "err");
  }
  rerender();
}
/** What the next tap on a device sends. */
type Item = { kind: "path"; path: string; dir?: boolean } | { kind: "text"; text: string };
const selection: Item[] = [];
const CLEAR_KEY = "kermius.nearbyClear";
const clearAfter = () => {
  try {
    return localStorage.getItem(CLEAR_KEY) !== "0";
  } catch {
    return true;
  }
};
/** Per transfer: start time and a smoothed rate (bytes/s). */
const speed = new Map<string, { start: number; t: number; done: number; rate: number }>();
/** Last path segment; Android content:// URIs hold the real path encoded ("raw%3A%2Fstorage%2F…%2Fa.bin"). */
const baseName = (p: string) => {
  let d = p;
  try {
    d = decodeURIComponent(p);
  } catch {}
  return d.split(/[\\/:]/).filter(Boolean).pop() || p;
};

function addPaths(paths: string[], dir = false) {
  for (const path of paths) if (!selection.some((i) => i.kind === "path" && i.path === path)) selection.push({ kind: "path", path, dir });
}

function textDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "modal-wrap";
    el.innerHTML = `<form class="modal"><h3>Send text</h3>
      <label class="field"><textarea name="t" rows="6" placeholder="Message, link, command…" spellcheck="false"></textarea></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="submit" class="btn primary">Add</button></div></form>`;
    document.body.append(el);
    const ta = el.querySelector("textarea")!;
    ta.focus();
    const done = (v: string | null) => (el.remove(), resolve(v));
    el.querySelector("form")!.addEventListener("submit", (e) => (e.preventDefault(), done(ta.value || null)));
    el.addEventListener("click", (e) => ((e.target as HTMLElement).dataset.r === "0" || e.target === el) && done(null));
    el.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
  });
}

/** Clipboard: an image (desktop), copied files (file:// lines) or text. */
async function pasteClipboard() {
  if (!phone) {
    const img = await api.saveClipboardImage().catch(() => "");
    if (img) return addPaths([img]);
  }
  const text = await api.clipboardRead().catch(() => "");
  if (!text) return toast("The clipboard is empty", "err");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.every((l) => l.startsWith("file://"))) addPaths(lines.map((l) => decodeURIComponent(l.slice(7))));
  else selection.push({ kind: "text", text });
}

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
function requestDialog(id: string, alias: string, files: [string, number][], count: number, total: number) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.dataset.request = id;
  el.innerHTML = `<div class="modal"><h3>${esc(alias)} wants to send you ${count.toLocaleString()} file${count === 1 ? "" : "s"}</h3>
    <p class="muted">${fmtSize(total)} · saved to ${esc(status.dir)}</p>
    <div class="nb-req-files">${files.map(([n, s]) => `<div><span>${esc(n)}</span><small>${fmtSize(s)}</small></div>`).join("")}
      ${count > files.length ? `<div class="muted">… and ${(count - files.length).toLocaleString()} more</div>` : ""}</div>
    <div class="modal-actions"><button class="btn ghost" data-r="0">Decline</button><button class="btn primary" data-r="1">Accept</button></div></div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).dataset.r;
    if (r === undefined) return;
    el.remove();
    api.nearbyRespond(id, r === "1");
  });
}

function messageDialog(alias: string, text: string) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<div class="modal"><h3>Message from ${esc(alias)}</h3><pre class="nb-msg">${esc(text)}</pre>
    <div class="modal-actions"><button class="btn ghost" data-r="0">Close</button><button class="btn primary" data-r="1">${icon("copy", 14)} Copy</button></div></div>`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
    if (r === undefined && e.target !== el) return;
    if (r === "1") api.clipboardWrite(text).then(() => toast("Copied", "ok"));
    el.remove();
  });
}

export async function initNearby(rerender: () => void, savedHosts: () => Host[], active: () => boolean) {
  hosts = savedHosts;
  setInterval(() => active() && probeHosts(rerender), 15_000);
  await listen<NearbyEvent>("nearby", ({ payload: ev }) => {
    if (ev.kind === "devices") status.devices = ev.devices;
    else if (ev.kind === "request") {
      // The save folder can change (e.g. storage permission granted on Android 10).
      api.nearbyStatus().then((s) => (status = s)).finally(() => requestDialog(ev.id, ev.alias, ev.files, ev.count, ev.total));
      notify("info", "Nearby Share", `${ev.alias} wants to send ${ev.count} file(s)`, "nearby");
    } else if (ev.kind === "message") {
      messageDialog(ev.alias, ev.text);
      notify("info", "Nearby Share", `Message from ${ev.alias}`, "nearby");
    } else if (ev.kind === "requestGone") document.querySelector(`[data-request="${ev.id}"]`)?.remove();
    else {
      const { kind: _, ...t } = ev;
      const prev = transfers.get(t.id);
      transfers.set(t.id, t);
      const now = performance.now();
      const sp = speed.get(t.id);
      // Timed from the first byte, not from the wait for the receiver to accept.
      if (!sp) t.state === "active" && speed.set(t.id, { start: now, t: now, done: t.done, rate: 0 });
      else if (now - sp.t > 150) {
        const r = ((t.done - sp.done) / (now - sp.t)) * 1000;
        Object.assign(sp, { t: now, done: t.done, rate: sp.rate ? sp.rate * 0.6 + r * 0.4 : r });
      }
      if (t.state !== prev?.state && t.incoming && t.state === "done") notify("info", "Nearby Share", `Received ${t.files} file(s) from ${t.peer}`, "nearby");
      if (t.state !== prev?.state && !t.incoming && t.state === "declined") toast(`${t.peer} declined the files`, "err");
    }
    rerender();
  });
  // Files dropped from the OS onto a device card are sent to it.
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      if (!active()) return;
      const at = (p: { x: number; y: number }) => document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio);
      document.querySelectorAll(".nb-dev.drop, .nb-drop.drop").forEach((c) => c.classList.remove("drop"));
      if (ev.payload.type === "leave") return;
      const card = at(ev.payload.position)?.closest<HTMLElement>("[data-nb-dev]");
      if (ev.payload.type === "over") return void (card ?? document.querySelector(".nb-drop"))?.classList.add("drop");
      if (ev.payload.type !== "drop") return;
      // On a device: send right away; anywhere else on the page: add to the selection.
      if (card) send(card.dataset.nbDev!, ev.payload.paths.map((path) => ({ kind: "path" as const, path })));
      else {
        addPaths(ev.payload.paths);
        rerender();
      }
    })
    .catch(() => {});
  status = await api.nearbyStatus().catch(() => status);
  if (savedDir()) await setSaveDir(savedDir(), rerender);
  if (enabled() && !status.running) await setRunning(true, rerender);
}

function send(fingerprint: string, items: Item[]) {
  const paths = items.flatMap((i) => (i.kind === "path" ? [i.path] : []));
  const texts = items.flatMap((i) => (i.kind === "text" ? [i.text] : []));
  if (!paths.length && !texts.length) return;
  api.nearbySend(fingerprint, paths, texts).catch((e) => toast(String(e), "err"));
}

/** A tap on a device sends the selection. */
function sendSelection(fingerprint: string, rerender: () => void) {
  if (!selection.length) return toast("Add files, a folder or text to the selection first", "info");
  send(fingerprint, [...selection]);
  if (clearAfter()) selection.length = 0;
  rerender();
}

const rateText = (b: number) => `${fmtSize(Math.max(0, Math.round(b)))}/s`;

const devIcon = (t: string) => (t === "mobile" ? "phone" : t === "web" ? "globe" : "monitor");

function transferRow(t: NearbyTransfer) {
  const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : t.state === "done" ? 100 : 0;
  const sp = speed.get(t.id);
  const secs = sp ? (sp.t - sp.start) / 1000 : 0;
  const label: Record<string, string> = {
    waiting: t.incoming ? "Waiting…" : "Waiting for the other device to accept…",
    active: `${pct}% · ${fmtSize(t.done)} / ${fmtSize(t.total)}${sp?.rate ? ` · ${rateText(sp.rate)}` : ""}`,
    done: `Done · ${fmtSize(t.total)}${secs > 0.5 ? ` · avg ${rateText(t.total / secs)}` : ""}`,
    declined: "Declined",
    failed: t.error || "Failed",
    cancelled: "Cancelled",
  };
  const live = t.state === "waiting" || t.state === "active";
  return `<div class="nb-tr ${t.state}">
    <span class="nb-dir" title="${t.incoming ? "Received" : "Sent"}">${t.incoming ? "↓" : "↑"}</span>
    <div class="nb-tr-body"><div><b>${esc(t.peer)}</b> <span class="muted">· ${({ done: t.incoming ? "received" : "sent", failed: "failed:", declined: "declined:", cancelled: "cancelled:" } as Record<string, string>)[t.state] ?? (t.incoming ? "receiving" : "sending")} ${t.files.toLocaleString()} file${t.files === 1 ? "" : "s"}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div><small class="muted">${esc(label[t.state])}</small></div>
    ${live ? `<button class="btn ghost sm" data-nb="cancel" data-id="${t.id}">Cancel</button>`
      : t.incoming && t.state === "done" && !phone ? `<button class="btn ghost sm" data-nb="open">${icon("folder", 14)} Open</button>` : ""}
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
        <div class="card-body"><div class="card-title">${esc(h.name || h.address)}</div><div class="card-sub">${esc(h.address)} · ${esc(state)}</div></div></div>`;
    })
    .join("")}</div>`;
}

function selectionHtml() {
  const chip = (it: Item, i: number) => {
    const [ic, name] = it.kind === "text" ? ["edit", it.text.replace(/\s+/g, " ").slice(0, 40) || "Text"] : [it.dir ? "folder" : "file", baseName(it.path)];
    return `<span class="nb-chip" title="${esc(it.kind === "text" ? it.text.slice(0, 500) : it.path)}">${icon(ic, 13)}<span>${esc(name)}</span>
      <button data-nb="rm" data-i="${i}" title="Remove">${icon("x", 11)}</button></span>`;
  };
  return `<div class="nb-sel">
    <div class="nb-sel-head"><h4 class="section">Selection</h4>
      <label class="nb-clear"><input type="checkbox" class="toggle sm" id="nb-clear" ${clearAfter() ? "checked" : ""} /> Clear after sending</label></div>
    <div class="nb-sel-btns">
      <button class="nb-pick" data-nb="files">${icon("file", 18)}<span>File</span></button>
      ${phone ? "" : `<button class="nb-pick" data-nb="folder">${icon("folder", 18)}<span>Folder</span></button>`}
      <button class="nb-pick" data-nb="text">${icon("edit", 18)}<span>Text</span></button>
      <button class="nb-pick" data-nb="paste">${icon("paste", 18)}<span>Paste</span></button>
    </div>
    <div class="nb-drop ${selection.length ? "" : "empty"}">${selection.length
      ? `${selection.map(chip).join("")}<button class="btn ghost sm" data-nb="clear-sel">Clear</button>`
      : `<span class="muted">${phone ? "Pick files, type text or paste the clipboard." : "Drop files or folders here, or use the buttons."}</span>`}</div>
  </div>`;
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
      ${phone ? "" : `<button class="btn sm" data-nb="open" title="${esc(status.dir)}">${icon("folder", 14)} Received files</button>`}
    </div>
    <div class="content">
      <div class="nb-save">${icon("folder", 14)}<span>Received files go to</span><code title="${esc(status.dir)}">${esc(status.dir)}</code>
        ${phone ? "" : `<button class="btn ghost sm" data-nb="pick-dir">Change…</button>`}
        ${savedDir() && !phone ? `<button class="btn ghost sm" data-nb="reset-dir" title="Back to the Downloads folder">Use Downloads</button>` : ""}</div>
      ${!on
        ? `<div class="empty">${icon("share", 40)}<h3>Nearby Share</h3>
            <p>Send files to phones and computers on the same network, and receive from them.<br/>Works with the LocalSend app (Android, iOS, Windows, macOS, Linux) and other Kermius devices.</p>
            <button class="btn primary" data-nb="on" ${busy ? "disabled" : ""}>Turn on</button></div>`
        : `${selectionHtml()}${hostCards()}<h4 class="section">Nearby devices</h4>
          ${others.length
            ? `<div class="grid">${others.map((d) => `<div class="card nb-dev" data-nb-dev="${esc(d.fingerprint)}">
                <div class="avatar" style="--h:${d.deviceType === "mobile" ? 150 : 215}">${icon(devIcon(d.deviceType), 20)}</div>
                <div class="card-body"><div class="card-title">${esc(d.alias)}</div><div class="card-sub">${esc([d.deviceModel, d.ip].filter(Boolean).join(" · "))}</div></div></div>`).join("")}</div>
              <p class="muted nb-hint">${selection.length ? "Tap a device to send the selection." : "Add something to the selection, then tap a device."}${phone ? "" : " Files dropped on a device are sent right away."}</p>`
            : `<div class="nb-searching muted">${icon("sync", 16)} Looking for devices… Open LocalSend or Kermius on another device in this network.
                Across a VPN, tick “Use this address for Nearby Share” on the host instead.</div>`}
          ${list.length ? `<h4 class="section">Transfers</h4><div class="nb-trs">${list.map(transferRow).join("")}</div>` : ""}`}
    </div>`;
  if (root.querySelector(".nb-toolbar")) morphHtml(root, html);
  else root.innerHTML = html;
}

export function bindNearby(root: HTMLElement, rerender: () => void, active: () => boolean) {
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (!active()) return;
    if (t.id === "nb-on") setRunning(t.checked, rerender);
    else if (t.id === "nb-clear")
      try {
        localStorage.setItem(CLEAR_KEY, t.checked ? "1" : "0");
      } catch {}
  });
  root.addEventListener("click", async (e) => {
    if (!active()) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-nb]");
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-nb-dev]");
    if (!b && card) return sendSelection(card.dataset.nbDev!, rerender);
    if (!b) return;
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
      case "pick-dir": {
        const dir = await openDialog({ directory: true, defaultPath: status.dir });
        if (typeof dir === "string") await setSaveDir(dir, rerender);
        return;
      }
      case "reset-dir":
        return setSaveDir("", rerender);
      case "files":
      case "folder": {
        const dir = b.dataset.nb === "folder";
        const picked = await openDialog({ multiple: true, directory: dir });
        if (picked) addPaths(Array.isArray(picked) ? picked : [picked], dir);
        return rerender();
      }
      case "text": {
        const text = await textDialog();
        if (text) selection.push({ kind: "text", text });
        return rerender();
      }
      case "paste":
        await pasteClipboard();
        return rerender();
      case "rm":
        selection.splice(+b.dataset.i!, 1);
        return rerender();
      case "clear-sel":
        selection.length = 0;
        return rerender();
    }
  });
}
