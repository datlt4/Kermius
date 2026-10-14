import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, emptyHost, isWeb, type Host, type Identity, type Key, type Snippet, type SyncSettings, type Tunnel } from "./api";
import { bindKeychain, bindKeychainMenu, credentialPickers, readPickers, renderKeychain, type KeychainCtx } from "./keychain";
import { FilesTab } from "./files";
import { bellButton, onNotesChange, toggleNotesPanel } from "./notify";
import { VncTab } from "./vnc";
import { sshExportDialog } from "./sshexport";
import { bindFolderSync, listenFolderSync, loadJobs, renderFolderSync, runDueJobs, syncActivity, type FolderSyncCtx } from "./foldersync";
import { BUILTIN_FONTS, MOSH_SERVER_SETUP, Session, describeTarget, fontStack, isSsh, loadFont, loadPrefs, protocolLabel, type TermPrefs } from "./terminal";
import { webLogin } from "./webapi";
import { parseSyncConfig } from "./vaultcrypto";
import { $, confirmDialog, contextMenu, esc, hue, icon, toast } from "./ui";

/** Open tabs: terminals (SSH / local) and SFTP file managers. */
type Tab = Session | FilesTab | VncTab;

type View = "hosts" | "keychain" | "forwarding" | "foldersync" | "snippets" | "settings";

const state = {
  hosts: [] as Host[],
  snippets: [] as Snippet[],
  keys: [] as Key[],
  identities: [] as Identity[],
  /** Last focused terminal tab: where snippets run from the Snippets page. */
  lastSession: "",
  view: "hosts" as View,
  folder: null as string | null,
  tag: null as string | null,
  query: "",
  layout: (localStorage.getItem("kermius.layout") as "grid" | "list") || "grid",
  /** Root view: folder cards, or every host in collapsible per-group sections. */
  mode: (localStorage.getItem("kermius.mode") as "groups" | "sections") || "groups",
  collapsed: new Set<string>(JSON.parse(localStorage.getItem("kermius.collapsed") || "[]")),
  sessions: [] as Tab[],
  active: "home" as string,
  editing: null as Host | null,
  tunnels: new Set<string>(),
  sync: null as SyncSettings | null,
  syncing: false,
  syncError: "",
  fonts: null as string[] | null,
  version: "",
};

const app = $("#app");
app.innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand" data-tauri-drag-region><div class="logo">${icon("terminal", 18)}</div><span class="grow">Kermius</span>
      <button class="icon-btn collapse-btn" data-act="collapse" title="Collapse sidebar">${icon("sidebar", 16)}</button></div>
    <nav class="nav"></nav>
    <div class="side-scroll"></div>
    <div class="side-foot"></div>
  </aside>
  <div class="scrim"></div>
  <main class="main">
    <div class="tabbar"></div>
    <div class="stage">
      <section class="page"></section>
      <div class="terms"></div>
    </div>
  </main>
  <aside class="drawer"></aside>
</div>`;

const els = {
  shell: $(".shell"),
  nav: $(".nav"),
  side: $(".side-scroll"),
  foot: $(".side-foot"),
  tabs: $(".tabbar"),
  page: $(".page"),
  terms: $(".terms"),
  drawer: $(".drawer"),
};

// ---------- derived data ----------

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function folders() {
  const m = new Map<string, number>();
  for (const h of state.hosts) if (h.folder) m.set(h.folder, (m.get(h.folder) ?? 0) + 1);
  return [...m].sort((a, b) => byName(a[0], b[0]));
}

function tags() {
  const m = new Map<string, number>();
  for (const h of state.hosts) for (const t of h.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => byName(a[0], b[0]));
}

function matches(h: Host, q: string) {
  return [h.name, h.address, h.username, h.folder, ...h.tags].some((s) => s.toLowerCase().includes(q));
}

function visibleHosts() {
  const q = state.query.trim().toLowerCase();
  let list = state.hosts;
  if (q) list = list.filter((h) => matches(h, q));
  else if (state.tag) list = list.filter((h) => h.tags.includes(state.tag!));
  else list = list.filter((h) => h.folder === (state.folder ?? ""));
  if (state.tag && q) list = list.filter((h) => h.tags.includes(state.tag!));
  return [...list].sort((a, b) => byName(a.name, b.name));
}

// ---------- sidebar ----------

function renderSidebar() {
  const nav: [View, string, string][] = [
    ["hosts", "server", "Hosts"],
    ["keychain", "key", "Keychain"],
    ["forwarding", "forward", "Port Forwarding"],
    ...(desktop ? [["foldersync", "folders", "Folder Sync"] as [View, string, string]] : []),
    ["snippets", "code", "Snippets"],
    ["settings", "settings", "Settings"],
  ];
  els.nav.innerHTML = nav
    .map(([v, ic, label]) => {
      // Folder Sync indicator: yellow while scanning, red while copying.
      const act = v === "foldersync" ? (syncActivity() ?? "") : null;
      const dot = act === null ? "" : `<i class="nav-dot ${act}" data-act="${act}" title="${act ? `Folder Sync: ${act}` : ""}"></i>`;
      return `<button class="nav-item ${state.view === v && state.active === "home" ? "on" : ""}" data-view="${v}" title="${label}">${icon(ic)}${dot}<span>${label}</span></button>`;
    })
    .join("");

  const fs = folders();
  const ts = tags();
  els.side.innerHTML = `
    <div class="side-title">Groups</div>
    ${fs.map(([f, n]) => `<button class="side-item ${state.folder === f && !state.tag ? "on" : ""}" data-folder="${esc(f)}">
        <span class="dot" style="--h:${hue(f)}"></span><span class="grow">${esc(f)}</span><span class="count">${n}</span></button>`).join("")}
    <div class="side-title">Tags</div>
    <div class="tag-cloud">${ts.map(([t, n]) => `<button class="chip ${state.tag === t ? "on" : ""}" data-tag="${esc(t)}">${esc(t)} <b>${n}</b></button>`).join("")}</div>`;
  renderSyncFoot();
}

function renderSyncFoot() {
  const s = state.sync;
  let text = "Sync off";
  let cls = "off";
  if (s?.url) {
    if (state.syncing) (text = "Syncing…"), (cls = "busy");
    else if (state.syncError) (text = "Sync failed"), (cls = "err");
    else if (s.lastSync) (text = `Synced ${ago(s.lastSync)}`), (cls = "ok");
    else text = "Not synced yet";
  }
  els.foot.innerHTML = `<button class="sync-pill ${cls}" title="${esc(state.syncError)}">${icon("sync", 14)}<span class="grow">${text}</span><span class="ver">v${state.version}</span></button>`;
}

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

els.nav.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
  if (!b) return;
  state.view = b.dataset.view as View;
  state.folder = null;
  state.tag = null;
  goHome();
});

els.side.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const f = t.closest<HTMLElement>("[data-folder]");
  const tg = t.closest<HTMLElement>("[data-tag]");
  if (f) {
    state.folder = state.folder === f.dataset.folder && !state.tag ? null : f.dataset.folder!;
    state.tag = null;
  } else if (tg) {
    state.tag = state.tag === tg.dataset.tag ? null : tg.dataset.tag!;
    state.folder = null;
  } else return;
  state.view = "hosts";
  state.query = "";
  goHome();
});

els.foot.addEventListener("click", () => {
  if (state.sync?.url) runSync(true);
  else {
    state.view = "settings";
    goHome();
  }
});

$(".scrim").addEventListener("click", () => els.shell.classList.remove("side-open"));

els.shell.classList.toggle("side-collapsed", localStorage.getItem("kermius.sideCollapsed") === "1");
$(".collapse-btn").addEventListener("click", () => {
  const on = els.shell.classList.toggle("side-collapsed");
  localStorage.setItem("kermius.sideCollapsed", on ? "1" : "");
});

// ---------- tabs ----------

function renderTabs() {
  els.tabs.innerHTML = `
    <button class="icon-btn menu-btn" data-act="menu">${icon("menu")}</button>
    <button class="tab home ${state.active === "home" ? "on" : ""}" data-tab="home">${icon("lock", 15)}<span>Vault</span></button>
    ${state.sessions
      .map(
        (s) => `<div class="tab ${state.active === s.id ? "on" : ""}" data-tab="${s.id}" title="${esc(s.host.username)}@${esc(s.host.address)}">
          ${s.kind === "files" ? icon("folder", 13) : s.kind === "vnc" ? icon("monitor", 13) : ""}<span class="st ${s.state}"></span><span class="tab-name">${esc(s.host.name)}${s.kind === "files" ? " · SFTP" : s.kind === "vnc" ? " · VNC" : ""}</span>
          <button class="tab-x" data-close="${s.id}">${icon("x", 13)}</button></div>`,
      )
      .join("")}
    ${isWeb ? "" : `<button class="icon-btn" data-act="local" title="New local terminal">${icon("plus", 16)}</button>`}
    <div class="grow" data-tauri-drag-region></div>
    ${state.sessions.some((s) => s.id === state.active && !s.local) ? `<button class="icon-btn" data-act="copy-pass" title="Copy password">${icon("key", 16)}</button>` : ""}
    ${bellButton()}
    ${desktop ? `<div class="win-ctl">
      <button data-win="min" title="Minimize">${icon("min", 15)}</button>
      <button data-win="max" title="Maximize">${icon("max", 13)}</button>
      <button data-win="close" class="close" title="Close">${icon("x", 15)}</button></div>` : ""}`;
}

// Custom title bar: window controls live in the tab bar (desktop only).
const desktop = !isWeb && !/Android|iPhone|iPad/i.test(navigator.userAgent);
els.tabs.setAttribute("data-tauri-drag-region", "");

els.tabs.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const win = t.closest<HTMLElement>("[data-win]")?.dataset.win;
  if (win) {
    const w = getCurrentWindow();
    return void (win === "min" ? w.minimize() : win === "max" ? w.toggleMaximize() : w.close());
  }
  const close = t.closest<HTMLElement>("[data-close]");
  if (close) return closeSession(close.dataset.close!);
  const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "menu") return els.shell.classList.toggle("side-open");
  if (act === "local") return openSession(null);
  if (act === "notes")
    return toggleNotesPanel(t.closest<HTMLElement>("[data-act]")!, (v) => {
      state.view = v as View;
      goHome();
    });
  if (act === "copy-pass") return state.sessions.find((s) => s.id === state.active)?.copyPassword();
  const tab = t.closest<HTMLElement>("[data-tab]");
  if (tab?.dataset.tab === "home") {
    // Vault always lands on the host list.
    state.view = "hosts";
    return goHome();
  }
  if (tab) activate(tab.dataset.tab!);
});

els.tabs.addEventListener("contextmenu", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    ...(s.local ? [] : [{ label: "Retry", icon: "sync", action: () => s.connect() }]),
    { label: "Duplicate", icon: "plus", action: () => (s.kind === "files" ? openFiles(s.host) : openSession(s.local ? null : s.host)) },
    ...(s.local || s.kind === "files" || !isSsh(s.host) ? [] : [{ label: "Open SFTP", icon: "folder", action: () => openFiles(s.host) }]),
    ...(s.local ? [] : [{ label: "Copy password", icon: "key", action: () => s.copyPassword() }]),
    "-" as const,
    { label: "Close others", icon: "x", action: () => state.sessions.filter((x) => x !== s).forEach((x) => closeSession(x.id)) },
    { label: "Close", icon: "x", danger: true, action: () => closeSession(s.id) },
  ]);
});

els.tabs.addEventListener("auxclick", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
  if (e.button === 1 && tab && tab.dataset.tab !== "home") closeSession(tab.dataset.tab!);
});

function activate(id: string) {
  state.active = id;
  if (id !== "home") state.lastSession = id;
  for (const s of state.sessions) s.id === id ? s.show() : s.hide();
  els.page.hidden = id !== "home";
  els.terms.hidden = id === "home";
  renderTabs();
  renderSidebar();
  if (id === "home") $<HTMLInputElement>(".search input", els.page)?.focus({ preventScroll: true });
}

function goHome() {
  els.shell.classList.remove("side-open");
  renderPage();
  activate("home");
}

function openSession(h: Host | null) {
  if (h?.protocol === "vnc") return openVnc(h);
  const s = new Session(h, renderTabs, (x) => closeSession(x.id));
  state.sessions.push(s);
  s.mount(els.terms);
  els.shell.classList.remove("side-open");
  activate(s.id);
}

function openVnc(h: Host) {
  const t = new VncTab(h, renderTabs, (x) => closeSession(x.id));
  state.sessions.push(t);
  t.mount(els.terms);
  els.shell.classList.remove("side-open");
  activate(t.id);
}

function openFiles(h: Host) {
  const t = new FilesTab(h, renderTabs, (x) => closeSession(x.id));
  state.sessions.push(t);
  t.mount(els.terms);
  activate(t.id);
}

els.terms.addEventListener("kermius-files", (e) => openFiles((e as CustomEvent).detail.host as Host));

function closeSession(id: string) {
  const i = state.sessions.findIndex((s) => s.id === id);
  if (i < 0) return;
  state.sessions[i].dispose();
  state.sessions.splice(i, 1);
  if (state.active === id) activate(state.sessions[Math.min(i, state.sessions.length - 1)]?.id ?? "home");
  else renderTabs();
}

onNotesChange(renderTabs);

// ---------- pages ----------

function renderPage() {
  if (state.view === "hosts") renderHosts();
  else if (state.view === "forwarding") renderForwarding();
  else if (state.view === "snippets") renderSnippets();
  else if (state.view === "keychain") renderKeychain(els.page, keychain);
  else if (state.view === "foldersync") renderFolderSync(els.page, folderSync);
  else renderSettings();
}

function hostCard(h: Host) {
  const shown = h.tags.slice(0, 3);
  return `<div class="card host" data-host="${h.id}" tabindex="0">
    <div class="avatar" style="--h:${hue(h.folder || h.name)}">${icon(hostIcon(h), 20)}</div>
    <div class="card-body">
      <div class="card-title">${esc(h.name || h.address)}</div>
      <div class="card-sub">${esc(protocolLabel(h).toLowerCase())}${h.protocol === "serial" ? `, ${h.baud || 115200} baud` : `, ${esc(h.username || "—")}`}${state.layout === "list" ? ` · ${esc(describeTarget(h))}` : ""}</div>
      ${shown.length ? `<div class="card-tags">${shown.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("")}${h.tags.length > 3 ? `<span class="mini-tag">+${h.tags.length - 3}</span>` : ""}</div>` : ""}
    </div>
    <div class="card-actions">
      ${h.password ? `<button class="icon-btn" data-act="pass" title="Copy password">${icon("key", 16)}</button>` : ""}
      <button class="icon-btn" data-act="edit" title="Edit">${icon("edit", 16)}</button>
    </div>
  </div>`;
}

function renderHosts() {
  const q = state.query.trim();
  const list = visibleHosts();
  const showGroups = !q && !state.folder && !state.tag;
  const groups = showGroups ? folders() : [];
  const crumb = state.folder
    ? `<button class="crumb" data-crumb>All hosts</button>${icon("chevron", 14)}<span>${esc(state.folder)}</span>`
    : state.tag
      ? `<button class="crumb" data-crumb>All hosts</button>${icon("chevron", 14)}<span>#${esc(state.tag)}</span>`
      : "";

  els.page.innerHTML = `
    <div class="toolbar">
      <label class="search">${icon("search")}<input placeholder="Search hosts, IPs, users, tags…  (Ctrl+K)" value="${esc(state.query)}" spellcheck="false" autocomplete="off" /></label>
      ${isWeb ? "" : `<button class="btn" data-act="local">${icon("terminal", 16)}<span>Terminal</span></button>`}
      <button class="btn primary" data-act="new">${icon("plus", 16)}<span>New Host</span></button>
      <div class="seg">
        <button class="${state.mode === "groups" ? "on" : ""}" data-mode="groups" title="Group cards">${icon("folder", 16)}</button>
        <button class="${state.mode === "sections" ? "on" : ""}" data-mode="sections" title="All hosts by group">${icon("layers", 16)}</button>
      </div>
      <div class="seg">
        <button class="${state.layout === "grid" ? "on" : ""}" data-layout="grid" title="Grid">${icon("grid", 16)}</button>
        <button class="${state.layout === "list" ? "on" : ""}" data-layout="list" title="List">${icon("list", 16)}</button>
      </div>
    </div>
    <div class="content">
      ${crumb ? `<div class="crumbs">${crumb}</div>` : ""}
      <div class="results">${resultsHtml(groups, list, showGroups)}</div>
    </div>`;
}

function sectionsHtml() {
  const byFolder = new Map<string, Host[]>();
  for (const h of [...state.hosts].sort((a, b) => byName(a.name, b.name))) {
    byFolder.set(h.folder, [...(byFolder.get(h.folder) ?? []), h]);
  }
  const names = [...byFolder.keys()].filter(Boolean).sort(byName);
  if (byFolder.has("")) names.push("");
  return names
    .map((f) => {
      const hosts = byFolder.get(f)!;
      const shut = state.collapsed.has(f);
      return `<div class="sec ${shut ? "shut" : ""}">
        <button class="sec-head" data-sec="${esc(f)}">${icon("chevron", 14)}<span class="dot" style="--h:${hue(f)}"></span>
          <b>${esc(f || "No group")}</b><span class="count">${hosts.length}</span></button>
        ${shut ? "" : `<div class="grid ${state.layout}">${hosts.map(hostCard).join("")}</div>`}</div>`;
    })
    .join("");
}

function resultsHtml(groups: [string, number][], list: Host[], showGroups: boolean) {
  if (showGroups && state.mode === "sections" && state.hosts.length) return sectionsHtml();
  const empty = !state.hosts.length
    ? `<div class="empty">${icon("server", 40)}<h3>No hosts yet</h3><p>Create a host or import your Termix export from Settings.</p>
        <div class="row"><button class="btn primary" data-act="new">New Host</button><button class="btn ghost" data-act="goto-settings">Import</button></div></div>`
    : `<div class="empty small"><p>No hosts match.</p></div>`;
  return `
    ${groups.length ? `<h4 class="section">Groups</h4><div class="grid groups">${groups
      .map(([f, n]) => `<div class="card group" data-open-folder="${esc(f)}" tabindex="0">
        <div class="avatar folder" style="--h:${hue(f)}">${icon("folder", 20)}</div>
        <div class="card-body"><div class="card-title">${esc(f)}</div><div class="card-sub">${n} host${n === 1 ? "" : "s"}</div></div></div>`)
      .join("")}</div>` : ""}
    ${list.length ? `<h4 class="section">${showGroups ? "Hosts" : `${list.length} host${list.length === 1 ? "" : "s"}`}</h4>
      <div class="grid ${state.layout}">${list.map(hostCard).join("")}</div>` : groups.length ? "" : empty}`;
}

/** Update only the results when typing so the input keeps focus and stays snappy. */
function refreshResults() {
  const q = state.query.trim();
  const showGroups = !q && !state.folder && !state.tag;
  const r = $(".results", els.page);
  if (r) r.innerHTML = resultsHtml(showGroups ? folders() : [], visibleHosts(), showGroups);
}

els.page.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.closest(".search")) {
    state.query = t.value;
    refreshResults();
  } else if (t.closest(".fwd-search")) {
    state.query = t.value;
    renderForwardList();
  }
});

els.page.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".search") && e.key === "Enter") {
    const first = visibleHosts()[0];
    if (first) isWeb ? openEditor(first) : openSession(first);
  } else if (e.key === "Enter" && t.classList.contains("card")) t.click();
});

els.page.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
  const card = t.closest<HTMLElement>("[data-host]");
  const host = card && state.hosts.find((h) => h.id === card.dataset.host);
  if (act === "new") return openEditor({ ...emptyHost(), folder: state.folder ?? "", tags: state.tag ? [state.tag] : [] });
  if (act === "local") return openSession(null);
  if (act === "goto-settings") return (state.view = "settings"), goHome();
  if (host && act === "pass") return copyPassword(host);
  if (host && act === "edit") return openEditor(host);
  if (host) return isWeb ? openEditor(host) : openSession(host);
  const mode = t.closest<HTMLElement>("[data-mode]");
  if (mode) {
    state.mode = mode.dataset.mode as "groups" | "sections";
    localStorage.setItem("kermius.mode", state.mode);
    return renderHosts();
  }
  const sec = t.closest<HTMLElement>("[data-sec]");
  if (sec) {
    const f = sec.dataset.sec!;
    state.collapsed.has(f) ? state.collapsed.delete(f) : state.collapsed.add(f);
    localStorage.setItem("kermius.collapsed", JSON.stringify([...state.collapsed]));
    return refreshResults();
  }
  const lay = t.closest<HTMLElement>("[data-layout]");
  if (lay) {
    state.layout = lay.dataset.layout as "grid" | "list";
    localStorage.setItem("kermius.layout", state.layout);
    return renderHosts();
  }
  const f = t.closest<HTMLElement>("[data-open-folder]");
  if (f) return (state.folder = f.dataset.openFolder!), (state.query = ""), goHome();
  if (t.closest("[data-crumb]")) return (state.folder = null), (state.tag = null), goHome();
});

els.page.addEventListener("contextmenu", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>("[data-host]");
  const h = card && state.hosts.find((x) => x.id === card.dataset.host);
  if (!h) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    ...(isWeb ? [] : [{ label: "Connect", icon: "terminal", action: () => openSession(h) }]),
    { label: "Copy password", icon: "key", action: () => copyPassword(h) },
    { label: "Copy address", icon: "copy", action: () => api.clipboardWrite(h.address).then(() => toast("Address copied", "ok")) },
    ...(isWeb ? [] : [{ label: "Open SFTP", icon: "folder", action: () => openFiles(h) }]),
    { label: "Copy ssh command", icon: "copy", action: () => api.clipboardWrite(`ssh ${h.username ? h.username + "@" : ""}${h.address}${h.port !== 22 ? ` -p ${h.port}` : ""}`).then(() => toast("Command copied", "ok")) },
    "-",
    { label: "Edit", icon: "edit", action: () => openEditor(h) },
    { label: "Duplicate", icon: "plus", action: () => openEditor({ ...h, id: "", name: `${h.name} copy`, tunnels: h.tunnels.map((t) => ({ ...t })) }) },
    { label: "Delete", icon: "trash", danger: true, action: () => deleteHost(h) },
  ]);
});

function copyPassword(h: Host) {
  api.copyPassword(h.id).then(
    () => toast(`Password for ${h.name} copied`, "ok"),
    (e) => toast(String(e), "err"),
  );
}

// ---------- port forwarding ----------

function renderForwarding() {
  els.page.innerHTML = `
    <div class="toolbar">
      <label class="search fwd-search">${icon("search")}<input placeholder="Filter port forwarding rules…" value="${esc(state.query)}" spellcheck="false" /></label>
    </div>
    <div class="content"><div class="fwd-list"></div></div>`;
  api.tunnelList().then((l) => {
    state.tunnels = new Set(l);
    renderForwardList();
  });
}

function renderForwardList() {
  const q = state.query.trim().toLowerCase();
  const rows = state.hosts
    .filter((h) => h.tunnels.length && (!q || matches(h, q) || h.tunnels.some((t) => String(t.sourcePort).includes(q))))
    .sort((a, b) => byName(a.name, b.name));
  const el = $(".fwd-list", els.page);
  if (!el) return;
  el.innerHTML = rows.length
    ? rows
        .map(
          (h) => `<div class="fwd-host"><div class="fwd-head"><div class="avatar sm" style="--h:${hue(h.folder || h.name)}">${icon("server", 14)}</div>
            <b>${esc(h.name)}</b><span class="muted">${esc(h.username)}@${esc(h.address)}</span></div>
            ${h.tunnels
              .map((t, i) => {
                const on = state.tunnels.has(`${h.id}:${i}`);
                return `<div class="fwd-row ${on ? "on" : ""}">
                  <span class="badge">Local</span>
                  <code>${esc(t.bindHost || "127.0.0.1")}:${t.sourcePort}</code>${icon("chevron", 14)}<code>${esc(t.endpointHost || "localhost")}:${t.endpointPort}</code>
                  <div class="grow"></div>
                  ${on ? `<button class="icon-btn" data-open-url="http://localhost:${t.sourcePort}" title="Copy URL">${icon("copy", 15)}</button>` : ""}
                  ${isWeb ? "" : `<button class="switch ${on ? "on" : ""}" data-tunnel="${h.id}:${i}" aria-label="toggle"><i></i></button>`}
                  <button class="icon-btn danger" data-del-tunnel="${h.id}:${i}" title="Delete rule">${icon("trash", 15)}</button></div>`;
              })
              .join("")}</div>`,
        )
        .join("")
    : `<div class="empty">${icon("forward", 40)}<h3>No port forwarding rules</h3><p>Add rules in a host's editor.</p></div>`;
}

els.page.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const url = t.closest<HTMLElement>("[data-open-url]")?.dataset.openUrl;
  if (url) return api.clipboardWrite(url).then(() => toast(`${url} copied`, "ok"));
  const del = t.closest<HTMLElement>("[data-del-tunnel]")?.dataset.delTunnel;
  if (del) {
    const [id, idx] = [del.slice(0, del.lastIndexOf(":")), +del.slice(del.lastIndexOf(":") + 1)];
    // Indices of running tunnels would shift, so require them stopped first.
    if ([...state.tunnels].some((k) => k.startsWith(`${id}:`))) return toast("Stop this host's tunnels first", "err");
    const h = state.hosts.find((x) => x.id === id);
    if (!h) return;
    await api.saveHost({ ...h, tunnels: h.tunnels.filter((_, i) => i !== idx) });
    await reload();
    scheduleSync();
    return toast("Rule deleted", "ok");
  }
  const sw = t.closest<HTMLElement>("[data-tunnel]");
  if (!sw) return;
  const key = sw.dataset.tunnel!;
  const [id, idx] = [key.slice(0, key.lastIndexOf(":")), +key.slice(key.lastIndexOf(":") + 1)];
  if (state.tunnels.has(key)) {
    await api.tunnelStop(id, idx);
    state.tunnels.delete(key);
  } else {
    sw.classList.add("busy");
    try {
      await api.tunnelStart(id, idx);
      state.tunnels.add(key);
      toast("Tunnel started", "ok");
    } catch (err) {
      toast(String(err), "err");
    }
  }
  renderForwardList();
});

// ---------- keychain ----------

const keychain: KeychainCtx = {
  keys: () => state.keys,
  identities: () => state.identities,
  changed: async () => {
    await reload();
    scheduleSync();
  },
};
const onKeychain = () => state.view === "keychain" && state.active === "home";
bindKeychain(els.page, keychain, onKeychain);
bindKeychainMenu(els.page, keychain, onKeychain);

// ---------- folder sync ----------

const onFolderSync = () => state.view === "foldersync" && state.active === "home";
const folderSync: FolderSyncCtx = {
  hosts: () => state.hosts,
  rerender: () => onFolderSync() && renderFolderSync(els.page, folderSync),
  activity: () => {
    const act = syncActivity();
    const dot = els.nav.querySelector<HTMLElement>('[data-view="foldersync"] .nav-dot');
    if (dot && dot.dataset.act !== (act ?? "")) renderSidebar();
  },
};
bindFolderSync(els.page, folderSync, onFolderSync);

// ---------- snippets ----------

function renderSnippets() {
  els.page.innerHTML = `
    <div class="toolbar">
      <label class="search snip-search">${icon("search")}<input placeholder="Search snippets…" value="${esc(state.query)}" spellcheck="false" /></label>
      <button class="btn primary" data-snip="new">${icon("plus", 16)}<span>New Snippet</span></button>
    </div>
    <div class="content"><div class="snip-list"></div></div>`;
  renderSnippetList();
}

function renderSnippetList() {
  const q = state.query.trim().toLowerCase();
  const list = state.snippets
    .filter((x) => !q || x.name.toLowerCase().includes(q) || x.script.toLowerCase().includes(q))
    .sort((a, b) => byName(a.name, b.name));
  const canRun = !isWeb && state.sessions.length > 0;
  $(".snip-list", els.page).innerHTML = list.length
    ? `<div class="grid">${list
        .map(
          (x) => `<div class="card snip" data-snip-id="${x.id}" tabindex="0">
            <div class="avatar snip-ic">${icon("code", 18)}</div>
            <div class="card-body"><div class="card-title">${esc(x.name || "Untitled")}</div>
              <div class="card-sub mono">${esc(x.script.split("\n")[0])}</div></div>
            <div class="card-actions">
              ${canRun ? `<button class="icon-btn" data-snip="run" title="Run in the last terminal">${icon("play", 15)}</button>` : ""}
              <button class="icon-btn" data-snip="copy" title="Copy">${icon("copy", 15)}</button>
            </div></div>`,
        )
        .join("")}</div>`
    : `<div class="empty">${icon("code", 40)}<h3>No snippets</h3><p>Save commands you run often and send them to any terminal.</p>
        <button class="btn primary" data-snip="new">New Snippet</button></div>`;
}

function runSnippet(sn: Snippet, session: Tab | undefined = state.sessions.find((s) => s.id === state.lastSession) ?? state.sessions[state.sessions.length - 1]) {
  if (!session) return toast("Open a terminal first", "err");
  activate(session.id);
  session.runText(sn.script);
}

function snippetDialog(sn: Snippet) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<form class="modal snip-modal">
    <h3>${sn.id ? "Edit snippet" : "New snippet"}</h3>
    <label class="field"><span>Name</span><input name="name" value="${esc(sn.name)}" placeholder="Restart docker stack" /></label>
    <label class="field"><span>Script</span><textarea name="script" rows="8" spellcheck="false" placeholder="cd ~/app && docker compose up -d">${esc(sn.script)}</textarea></label>
    <div class="modal-actions">${sn.id ? `<button type="button" class="btn danger" data-m="delete">Delete</button><div class="grow"></div>` : ""}
      <button type="button" class="btn ghost" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`;
  document.body.append(el);
  const form = el.querySelector("form")!;
  const close = () => el.remove();
  (form.elements.namedItem(sn.id ? "script" : "name") as HTMLElement).focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    const script = (form.elements.namedItem("script") as HTMLTextAreaElement).value;
    if (!script.trim()) return toast("Script is empty", "err");
    try {
      await api.saveSnippet({ ...sn, name: name || script.split("\n")[0].slice(0, 40), script });
      close();
      await reload();
      scheduleSync();
    } catch (err) {
      toast(String(err), "err");
    }
  });
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>("[data-m]")?.dataset.m;
    if (m === "cancel" || t === el) return close();
    if (m === "delete" && (await confirmDialog(`Delete ${sn.name || "snippet"}?`, "It will be removed from all synced devices."))) {
      await api.deleteSnippet(sn.id);
      close();
      await reload();
      scheduleSync();
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") form.requestSubmit();
  });
}

els.page.addEventListener("click", (e) => {
  if (state.view !== "snippets") return;
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>("[data-snip]")?.dataset.snip;
  const card = t.closest<HTMLElement>("[data-snip-id]");
  const sn = card && state.snippets.find((x) => x.id === card.dataset.snipId);
  if (act === "new") return snippetDialog({ id: "", name: "", script: "", updatedAt: 0, deleted: false });
  if (sn && act === "run") return runSnippet(sn);
  if (sn && act === "copy") return api.clipboardWrite(sn.script).then(() => toast("Copied", "ok"));
  if (sn) snippetDialog(sn);
});

els.page.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.closest(".snip-search")) {
    state.query = t.value;
    renderSnippetList();
  }
});

// Snippet picker from a terminal's toolbar.
els.terms.addEventListener("kermius-snippets", (e) => {
  const { session, x, y } = (e as CustomEvent).detail as { session: Tab; x: number; y: number };
  if (!state.snippets.length) return toast("No snippets yet: add them in Snippets", "info");
  contextMenu(
    x,
    y,
    [...state.snippets].sort((a, b) => byName(a.name, b.name)).map((sn) => ({ label: sn.name || sn.script.slice(0, 40), icon: "code", action: () => runSnippet(sn, session) })),
  );
});

// ---------- settings ----------

function renderSettings() {
  const s = state.sync ?? { url: "", token: "", passphrase: "", lastSync: 0 };
  const p = loadPrefs();
  els.page.innerHTML = `
    <div class="content settings">
      <h2>Settings</h2>
      <div class="panel">
        <div class="panel-head">${icon("sync")}<div class="grow"><h3>Sync</h3><p class="muted">End-to-end encrypted. Data is encrypted on this device with your passphrase; the server only stores ciphertext.</p></div>
          <button class="icon-btn" data-set="sync-paste" title="Paste sync config (base64)">${icon("paste", 17)}</button>
          <button class="icon-btn" data-set="sync-copy" title="Copy sync config (base64)">${icon("copy", 17)}</button></div>
        <label class="field"><span>Server URL</span><input id="s-url" placeholder="https://sync.example.com" value="${esc(s.url)}" ${isWeb ? "readonly" : ""} /></label>
        <label class="field"><span>Access token</span><div class="input-group"><input id="s-token" type="password" value="${esc(s.token)}" />
          <button class="icon-btn" data-set="show" data-target="s-token" title="Show">${icon("eye", 16)}</button></div></label>
        <label class="field"><span>Encryption passphrase</span><div class="input-group"><input id="s-pass" type="password" value="${esc(s.passphrase)}" />
          <button class="icon-btn" data-set="show" data-target="s-pass" title="Show">${icon("eye", 16)}</button></div>
          <small>Use the same passphrase on every device. If you lose it, synced data cannot be recovered.</small></label>
        <div class="row"><button class="btn primary" data-set="sync-save">Save &amp; sync</button>${isWeb ? `<button class="btn ghost" data-set="lock">${icon("lock", 15)} Lock</button>` : ""}
          <span class="muted">${s.lastSync ? `Last sync ${ago(s.lastSync)}` : ""}${state.syncError ? ` · <span class="err">${esc(state.syncError)}</span>` : ""}</span></div>
      </div>
      ${isWeb ? "" : `<div class="panel">
        <div class="panel-head">${icon("import")}<div><h3>Import from Termix</h3><p class="muted">Termix → Host Manager → Export (JSON). Existing hosts are updated, not duplicated.</p></div></div>
        <label class="field"><span>Export file path</span><input id="imp-path" placeholder="/home/you/termix-hosts.json" /></label>
        <div class="row"><button class="btn" data-set="import">Import</button></div>
      </div>
      <div class="panel">
        <div class="panel-head">${icon("terminal")}<div><h3>Export to ~/.ssh/config</h3><p class="muted">Pick groups and hosts to use with the regular <code>ssh</code> command, scp, VS Code Remote…</p></div></div>
        <div class="row"><button class="btn" data-set="ssh-export">Choose hosts…</button></div>
      </div>
      <div class="panel">
        <div class="panel-head">${icon("terminal")}<div><h3>Terminal</h3></div></div>
        <div class="font-row">
          <div class="font-pick">
            <button class="font-current" data-set="font-open" style="font-family:${esc(fontStack(p.fontFamily))}">${esc(p.fontFamily)}${icon("chevron", 14)}</button>
            <div class="font-menu" hidden><input class="font-search" placeholder="Search fonts…" spellcheck="false" /><div class="font-list"></div></div>
          </div>
          <div class="stepper">
            <button data-set="size-dec">${icon("min", 14)}</button><span>${p.fontSize}</span><button data-set="size-inc">${icon("plus", 14)}</button>
          </div>
        </div>
        <pre class="font-preview" style="font-family:${esc(fontStack(p.fontFamily))};font-size:${p.fontSize}px"><span class="pv-host">server</span>:<span class="pv-path">~</span> <span class="pv-ok">➜</span> ls -lht
drwxr-xr-x 2 user user 4.0K Oct 12 08:56 <span class="pv-dir">models</span>
-rwxrwxr-x 1 user user  772 Oct 12 08:57 <span class="pv-ok">build.sh</span>
echo "Tiếng Việt có dấu" 0O 1lI {}[]() =&gt; != &lt;=</pre>
      </div>`}
      <p class="muted center">Kermius ${state.version} · ${state.hosts.length} hosts</p>
    </div>`;
}

els.page.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-set]")?.dataset.set;
  if (!a) return;
  const v = (id: string) => $<HTMLInputElement>(`#${id}`).value;
  if (a === "lock") return location.reload();
  if (a === "show") {
    const i = $<HTMLInputElement>(`#${(e.target as HTMLElement).closest<HTMLElement>("[data-target]")!.dataset.target}`);
    i.type = i.type === "password" ? "text" : "password";
  } else if (a === "sync-copy") {
    const raw = new TextEncoder().encode([v("s-url").trim(), v("s-token"), v("s-pass")].join("|"));
    await api.clipboardWrite(btoa(String.fromCharCode(...raw)));
    toast("Sync config copied", "ok");
  } else if (a === "sync-paste") {
    let text = (await api.clipboardRead().catch(() => "")).trim();
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    } catch {
      /* not base64: accept plain url|token|passphrase */
    }
    // Passphrase may itself contain "|": everything after the 2nd separator belongs to it.
    const [url, token, ...pass] = text.split("|");
    if (!url || token === undefined || !pass.length) return toast("Clipboard is not url|token|passphrase", "err");
    $<HTMLInputElement>("#s-url").value = url;
    $<HTMLInputElement>("#s-token").value = token;
    $<HTMLInputElement>("#s-pass").value = pass.join("|");
    toast("Pasted. Press Save & sync to apply", "ok");
  } else if (a === "sync-save") {
    const settings = { url: v("s-url").trim(), token: v("s-token"), passphrase: v("s-pass"), lastSync: state.sync?.lastSync ?? 0 };
    await api.setSyncSettings(settings);
    state.sync = settings;
    if (settings.url) await runSync(true);
    renderSettings();
  } else if (a === "ssh-export") {
    sshExportDialog(state.hosts.filter(isSsh));
  } else if (a === "import") {
    try {
      const r = await api.importTermix(v("imp-path").trim());
      toast(`Imported: ${r.added} added, ${r.updated} updated`, "ok");
      await reload();
      scheduleSync();
    } catch (err) {
      toast(String(err), "err");
    }
  } else if (a === "font-open") {
    const menu = $(".font-menu", els.page);
    menu.hidden = !menu.hidden;
    if (menu.hidden) return;
    state.fonts ??= await api.listFonts().catch(() => []);
    renderFontList("");
    $<HTMLInputElement>(".font-search", els.page).focus();
  } else if (a === "size-dec" || a === "size-inc") {
    const p = loadPrefs();
    setPrefs({ ...p, fontSize: Math.max(8, Math.min(32, p.fontSize + (a === "size-inc" ? 1 : -1))) });
  }
});

function renderFontList(q: string) {
  const cur = loadPrefs().fontFamily;
  const system = (state.fonts ?? []).filter((f) => !BUILTIN_FONTS.includes(f));
  const item = (f: string) =>
    `<button class="font-item ${f === cur ? "on" : ""}" data-font="${esc(f)}" style="font-family:${esc(fontStack(f))}">${esc(f)}</button>`;
  const match = (f: string) => f.toLowerCase().includes(q.toLowerCase());
  const b = BUILTIN_FONTS.filter(match);
  const sys = system.filter(match);
  $(".font-list", els.page).innerHTML =
    (b.length ? `<div class="font-sec">Built-in</div>${b.map(item).join("")}` : "") +
    (sys.length ? `<div class="font-sec">System</div>${sys.map(item).join("")}` : "");
}

async function setPrefs(p: TermPrefs) {
  localStorage.setItem("kermius.term", JSON.stringify(p));
  await loadFont(p);
  for (const s of state.sessions) s.applyPrefs(p);
  renderSettings();
}

els.page.addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-font]")?.dataset.font;
  if (f) setPrefs({ ...loadPrefs(), fontFamily: f });
});

els.page.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.classList.contains("font-search")) renderFontList(t.value);
});

addEventListener("pointerdown", (e) => {
  const menu = document.querySelector<HTMLElement>(".font-menu");
  if (menu && !menu.hidden && !(e.target as HTMLElement).closest(".font-pick")) menu.hidden = true;
});

// ---------- editor drawer ----------

function openEditor(h: Host) {
  state.editing = structuredClone(h);
  renderEditor();
  els.shell.classList.add("drawer-open");
  requestAnimationFrame(() => $<HTMLInputElement>("#e-address", els.drawer)?.focus());
}

function closeEditor() {
  els.shell.classList.remove("drawer-open");
  state.editing = null;
}

function tunnelRow(t: Tunnel, i: number) {
  return `<div class="tun-row" data-i="${i}">
    <input data-f="bindHost" value="${esc(t.bindHost)}" placeholder="127.0.0.1" />
    <input data-f="sourcePort" type="number" value="${t.sourcePort || ""}" placeholder="8080" />
    ${icon("chevron", 14)}
    <input data-f="endpointHost" value="${esc(t.endpointHost)}" placeholder="localhost" />
    <input data-f="endpointPort" type="number" value="${t.endpointPort || ""}" placeholder="80" />
    <button class="icon-btn" data-ed="rm-tun" data-i="${i}">${icon("x", 14)}</button></div>`;
}

const hostIcon = (h: Host) => (h.protocol === "vnc" ? "monitor" : h.protocol === "serial" ? "plug" : "server");

const PROTOCOLS = [
  ["ssh", "SSH"],
  ["mosh", "Mosh"],
  ["telnet", "Telnet"],
  ["serial", "Serial"],
  ["vnc", "VNC"],
] as const;
const DEFAULT_PORT: Record<string, number> = { ssh: 22, mosh: 22, telnet: 23, serial: 0, vnc: 5900 };
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** Setup hints per protocol, with copyable commands. */
function protoNote(proto: string) {
  if (proto === "mosh")
    return `<div class="proto-note">Mosh signs in over SSH (the credentials below), then switches to UDP ports 60000–61000.
      The host needs <code>mosh-server</code>: <button class="btn ghost sm" data-ed="copy-cmd" data-cmd="${esc(MOSH_SERVER_SETUP)}">Copy install command</button></div>`;
  if (proto === "serial")
    return `<div class="proto-note serial-note" hidden>Opening serial ports needs the <code>dialout</code> group:
      <button class="btn ghost sm" data-ed="copy-serial">Copy command</button> then log out and back in.</div>`;
  if (proto === "vnc") return `<div class="proto-note">Opens the remote desktop in a tab (port 5900 + display number, e.g. :1 = 5901).</div>`;
  return "";
}

/** Fill the serial port suggestions and the setup hint (async, desktop only). */
function loadSerialHints() {
  if (isWeb || state.editing?.protocol !== "serial") return;
  api.serialPorts().then((ports) => {
    const dl = els.drawer.querySelector("#dl-ports");
    if (dl) dl.innerHTML = ports.map((p) => `<option value="${esc(p)}">`).join("");
  });
  api.serialSetupCommand().then((cmd) => {
    const note = els.drawer.querySelector<HTMLElement>(".serial-note");
    if (note && cmd) {
      note.hidden = false;
      note.dataset.cmd = cmd;
    }
  });
}

function renderEditor() {
  const h = state.editing!;
  const proto = h.protocol || "ssh";
  els.drawer.innerHTML = `
    <div class="drawer-head">
      <button class="icon-btn" data-ed="close">${icon("back")}</button>
      <h3>${h.id ? "Edit host" : "New host"}</h3>
      <div class="grow"></div>
      ${h.id ? `<button class="icon-btn danger" data-ed="delete" title="Delete">${icon("trash", 16)}</button>` : ""}
    </div>
    <div class="drawer-body">
      <div class="seg proto-seg">${PROTOCOLS.filter(([p]) => isWeb || desktop || !["mosh", "serial"].includes(p))
        .map(([p, label]) => `<button data-ed="proto" data-p="${p}" class="${proto === p ? "on" : ""}">${label}</button>`).join("")}</div>
      <div class="hero">
        <div class="avatar lg" style="--h:${hue(h.folder || h.name || "x")}">${icon(hostIcon(h), 26)}</div>
        <label class="field grow"><span>${proto === "serial" ? "Serial port" : "Address"}</span><input id="e-address" value="${esc(h.address)}"
          placeholder="${proto === "serial" ? "/dev/ttyUSB0 or COM3" : "IP or hostname"}" spellcheck="false" ${proto === "serial" ? 'list="dl-ports"' : ""} /></label>
        <datalist id="dl-ports"></datalist>
      </div>
      ${protoNote(proto)}
      <div class="panel">
        <h5>General</h5>
        <label class="field"><span>Label</span><input id="e-name" value="${esc(h.name)}" placeholder="My server" /></label>
        <label class="field"><span>Group</span><input id="e-folder" list="dl-folders" value="${esc(h.folder)}" placeholder="No group" /></label>
        <datalist id="dl-folders">${folders().map(([f]) => `<option value="${esc(f)}">`).join("")}</datalist>
        <div class="field"><span>Tags</span>
          <div class="tag-input">${h.tags.map((t, i) => `<span class="chip on">${esc(t)}<button data-ed="rm-tag" data-i="${i}">${icon("x", 11)}</button></span>`).join("")}
            <input id="e-tag" list="dl-tags" placeholder="Add tag…" /></div>
          <datalist id="dl-tags">${tags().filter(([t]) => !h.tags.includes(t)).map(([t]) => `<option value="${esc(t)}">`).join("")}</datalist>
        </div>
      </div>
      <div class="panel">
        <h5>${PROTOCOLS.find(([p]) => p === proto)![1]}</h5>
        <label class="field" ${proto === "serial" ? "" : "hidden"}><span>Baud rate</span><select id="e-baud">${BAUDS.map((b) => `<option ${b === (h.baud || 115200) ? "selected" : ""}>${b}</option>`).join("")}</select></label>
        <div class="field-row" ${proto === "serial" ? "hidden" : ""}>
          <label class="field grow"><span>Username${proto === "vnc" ? " (if the server asks)" : proto === "telnet" ? " (typed at the login prompt)" : ""}</span><input id="e-user" value="${esc(h.username)}" spellcheck="false" /></label>
          <label class="field" style="width:96px"><span>${proto === "mosh" ? "SSH port" : "Port"}</span><input id="e-port" type="number" value="${h.port}" /></label>
        </div>
        <div ${isSsh(h) ? "" : "hidden"}>${credentialPickers(h.identityId, h.keyId, keychain)}</div>
        <label class="field" ${proto === "serial" ? "hidden" : ""}><span>${proto === "vnc" ? "VNC password" : "Password"}</span>
          <div class="input-group"><input id="e-pass" type="password" value="${esc(h.password)}" autocomplete="off" />
            <button class="icon-btn" data-ed="toggle-pass" title="Show">${icon("eye", 16)}</button>
            <button class="icon-btn" data-ed="copy-pass" title="Copy">${icon("copy", 16)}</button></div></label>
        <details ${h.privateKey ? "open" : ""} ${isSsh(h) ? "" : "hidden"}><summary>Private key</summary>
          <label class="field"><textarea id="e-key" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false">${esc(h.privateKey)}</textarea></label>
          <label class="field"><span>Key passphrase</span><input id="e-keypass" type="password" value="${esc(h.keyPassphrase)}" /></label>
        </details>
      </div>
      <div class="panel" ${proto === "ssh" ? "" : "hidden"}>
        <h5>Port forwarding <small class="muted">local → remote</small></h5>
        <div class="tuns">${h.tunnels.map(tunnelRow).join("")}</div>
        <button class="btn ghost sm" data-ed="add-tun">${icon("plus", 14)} Add rule</button>
      </div>
      <div class="panel">
        <h5>Notes</h5>
        <textarea id="e-notes" rows="3">${esc(h.notes)}</textarea>
      </div>
    </div>
    <div class="drawer-foot">
      ${h.id && !isWeb ? `<button class="btn ghost" data-ed="connect">${icon("terminal", 16)} Connect</button>` : ""}
      <div class="grow"></div>
      <button class="btn primary" data-ed="save">Save</button>
    </div>`;
  loadSerialHints();
}

/** Pull form values into state.editing. */
function readEditor() {
  const h = state.editing!;
  const v = (id: string) => $<HTMLInputElement>(`#${id}`, els.drawer).value;
  h.address = v("e-address").trim();
  h.name = v("e-name").trim();
  h.folder = v("e-folder").trim();
  h.username = v("e-user").trim();
  h.port = +v("e-port") || DEFAULT_PORT[h.protocol || "ssh"];
  h.baud = +v("e-baud") || 115200;
  h.password = v("e-pass");
  h.privateKey = v("e-key");
  h.keyPassphrase = v("e-keypass");
  Object.assign(h, readPickers(els.drawer));
  h.notes = v("e-notes");
  h.tunnels = [...els.drawer.querySelectorAll<HTMLElement>(".tun-row")].map((r) => {
    const f = (k: string) => $<HTMLInputElement>(`[data-f="${k}"]`, r).value.trim();
    return { bindHost: f("bindHost") || "127.0.0.1", sourcePort: +f("sourcePort") || 0, endpointHost: f("endpointHost"), endpointPort: +f("endpointPort") || 0 };
  });
  const pending = v("e-tag").trim();
  if (pending && !h.tags.includes(pending)) h.tags.push(pending);
}

els.drawer.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ed]");
  if (!b) return;
  const h = state.editing!;
  switch (b.dataset.ed) {
    case "close":
      return closeEditor();
    case "toggle-pass": {
      const i = $<HTMLInputElement>("#e-pass", els.drawer);
      i.type = i.type === "password" ? "text" : "password";
      return;
    }
    case "proto": {
      readEditor();
      const next = b.dataset.p!;
      // Follow the new protocol's default port unless a custom one was set.
      if (h.port === DEFAULT_PORT[h.protocol || "ssh"]) h.port = DEFAULT_PORT[next];
      h.protocol = next;
      return renderEditor();
    }
    case "copy-cmd":
      return api.clipboardWrite(b.dataset.cmd!).then(() => toast("Command copied; run it on the host", "ok"));
    case "copy-serial":
      return api.clipboardWrite(b.closest<HTMLElement>(".serial-note")!.dataset.cmd!).then(() => toast("Command copied; paste it into a terminal on this computer", "ok"));
    case "copy-pass":
      return api.clipboardWrite($<HTMLInputElement>("#e-pass", els.drawer).value).then(() => toast("Password copied", "ok"));
    case "rm-tag":
      readEditor();
      h.tags.splice(+b.dataset.i!, 1);
      return renderEditor();
    case "add-tun":
      readEditor();
      h.tunnels.push({ bindHost: "127.0.0.1", sourcePort: 0, endpointHost: "", endpointPort: 0 });
      return renderEditor();
    case "rm-tun":
      readEditor();
      h.tunnels.splice(+b.dataset.i!, 1);
      return renderEditor();
    case "delete":
      return deleteHost(h);
    case "connect":
      readEditor();
      await saveEditor();
      return openSession(state.hosts.find((x) => x.id === h.id)!);
    case "save":
      readEditor();
      if (await saveEditor()) closeEditor();
  }
});

els.drawer.addEventListener("keydown", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "e-tag" && (e.key === "Enter" || e.key === ",")) {
    e.preventDefault();
    readEditor();
    renderEditor();
    $<HTMLInputElement>("#e-tag", els.drawer).focus();
  } else if (t.id === "e-tag" && e.key === "Backspace" && !t.value && state.editing!.tags.length) {
    readEditor();
    state.editing!.tags.pop();
    renderEditor();
    $<HTMLInputElement>("#e-tag", els.drawer).focus();
  }
});

async function saveEditor() {
  const h = state.editing!;
  if (!h.address) {
    toast("Address is required", "err");
    return false;
  }
  if (!h.name) h.name = h.address;
  try {
    const saved = await api.saveHost(h);
    state.editing = saved;
    await reload();
    scheduleSync();
    toast("Saved", "ok");
    return true;
  } catch (err) {
    toast(String(err), "err");
    return false;
  }
}

async function deleteHost(h: Host) {
  if (!(await confirmDialog(`Delete ${h.name}?`, "This host will be removed from all synced devices."))) return;
  await api.deleteHost(h.id);
  if (state.editing?.id === h.id) closeEditor();
  await reload();
  scheduleSync();
  toast("Host deleted", "ok");
}

// ---------- sync ----------

let syncTimer = 0;
function scheduleSync() {
  if (!state.sync?.url) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => runSync(false), 1500);
}

async function runSync(manual: boolean) {
  if (state.syncing || !state.sync?.url) return;
  state.syncing = true;
  renderSyncFoot();
  try {
    const r = await api.syncNow();
    state.sync.lastSync = r.lastSync;
    state.syncError = "";
    await reload();
    if (manual) toast(`Synced · ${r.hosts} hosts`, "ok");
  } catch (e) {
    state.syncError = String(e);
    if (manual) toast(state.syncError, "err");
  } finally {
    state.syncing = false;
    renderSyncFoot();
  }
}

// ---------- global ----------

async function reload() {
  [state.hosts, state.snippets, state.keys, state.identities] = await Promise.all([
    api.listHosts(),
    api.listSnippets(),
    api.listKeys(),
    api.listIdentities(),
  ]);
  renderSidebar();
  if (state.active === "home" && state.view !== "settings") {
    if (state.view === "hosts" && $(".results", els.page)) refreshResults();
    else renderPage();
  }
}

addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape" && state.editing) return closeEditor();
  if (mod && e.key.toLowerCase() === "s" && state.editing) {
    e.preventDefault();
    readEditor();
    saveEditor().then((ok) => ok && closeEditor());
    return;
  }
  if (!mod) return;
  const k = e.key.toLowerCase();
  // Inside a terminal, plain Ctrl+K/T/F belong to the shell; use Ctrl+Shift instead.
  if (state.active !== "home" && !e.shiftKey && "ktf".includes(k)) return;
  if (k === "k" || (k === "f" && state.active === "home")) {
    e.preventDefault();
    state.view = "hosts";
    if (state.active !== "home" || !$(".search input", els.page)) goHome();
    $<HTMLInputElement>(".search input", els.page)?.select();
  } else if (k === "t") {
    e.preventDefault();
    goHome();
  } else if (k === "w" && state.active !== "home" && e.shiftKey) {
    e.preventDefault();
    closeSession(state.active);
  } else if (k === "tab") {
    e.preventDefault();
    const ids = ["home", ...state.sessions.map((s) => s.id)];
    const i = ids.indexOf(state.active);
    activate(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  } else if (/^[1-9]$/.test(k) && e.altKey === false && !e.shiftKey) {
    const ids = ["home", ...state.sessions.map((s) => s.id)];
    if (ids[+k - 1]) {
      e.preventDefault();
      activate(ids[+k - 1]);
    }
  }
});

// Disable the webview's default context menu outside our own.
addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
});

/** Web: unlock with the base64 sync config; a real form so Chrome offers to save it. */
function webUnlock(): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "login";
    const insecure = location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname);
    el.innerHTML = `<form class="login-card" method="post" action="#">
      <div class="logo lg">${icon("terminal", 26)}</div>
      <h2>Kermius</h2>
      <p class="muted">Paste the sync config from the app (Settings → Sync → copy).</p>
      <input class="login-user" name="username" autocomplete="username" value="${esc(`kermius@${location.host}`)}" aria-label="Name" />
      <input name="password" type="password" autocomplete="current-password" placeholder="Sync config (base64)" required autofocus />
      ${insecure ? `<p class="warn">Not HTTPS: the access token and this page can be intercepted. Serve Kermius behind HTTPS.</p>` : ""}
      <button class="btn primary" type="submit">${icon("lock", 15)} Unlock</button>
      <p class="err"></p></form>`;
    document.body.append(el);
    const form = el.querySelector("form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = (form.elements.namedItem("username") as HTMLInputElement).value;
      const secret = (form.elements.namedItem("password") as HTMLInputElement).value;
      const cfg = parseSyncConfig(secret);
      const err = el.querySelector(".err")!;
      if (!cfg) return void (err.textContent = "Not a Kermius sync config");
      err.textContent = "Unlocking…";
      try {
        await webLogin(cfg.token, cfg.passphrase);
      } catch (x) {
        return void (err.textContent = String(x instanceof Error ? x.message : x));
      }
      const PC = (window as any).PasswordCredential;
      if (PC && isSecureContext) await navigator.credentials.store(new PC({ id: user, password: secret, name: "Kermius" })).catch(() => {});
      el.remove();
      resolve();
    });
  });
}

(async () => {
  if (isWeb) await webUnlock();
  else await loadFont(loadPrefs());
  state.version = __APP_VERSION__;
  state.sync = await api.getSyncSettings();
  await reload();
  renderPage();
  activate("home");
  runSync(false);
  setInterval(() => runSync(false), 60_000);
  if (desktop) {
    await loadJobs();
    await listenFolderSync(folderSync);
    runDueJobs(folderSync);
    setInterval(() => runDueJobs(folderSync), 60_000);
  }
  setInterval(renderSyncFoot, 30_000);
})();
