import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, emptyHost, isWeb, type Host, type Identity, type Key, type Snippet, type SyncSettings, type Tunnel } from "./api";
import { bindKeychain, bindKeychainMenu, credentialPickers, readPickers, renderKeychain, type KeychainCtx } from "./keychain";
import { FilesTab } from "./files";
import { bellButton, initOsNotifications, onNotesChange, toggleNotesPanel } from "./notify";
import { VncTab } from "./vnc";
import { checkUpdate, pendingUpdate, updateDialog } from "./update";
import { sshExportDialog } from "./sshexport";
import { bindNearby, initNearby, renderNearby } from "./nearby";
import { bindWol, renderWol, type WolCtx } from "./wol";
import { bindFolderSync, listenFolderSync, loadJobs, renderFolderSync, runDueJobs, syncActivity, type FolderSyncCtx } from "./foldersync";
import { BUILTIN_FONTS, MOSH_SERVER_SETUP, Session, describeTarget, fontStack, isSsh, loadFont, loadPrefs, protocolLabel, type TermPrefs } from "./terminal";
import { webLogin } from "./webapi";
import { parseSyncConfig } from "./vaultcrypto";
import { $, confirmDialog, contextMenu, esc, hue, icon, toast } from "./ui";

/** Open tabs: terminals (SSH / local) and SFTP file managers. */
type Tab = Session | FilesTab | VncTab;

type View = "hosts" | "keychain" | "forwarding" | "foldersync" | "nearby" | "wol" | "snippets" | "settings";

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
  // Phones default to the list; tablets and desktops to the grid.
  layout: (localStorage.getItem("kermius.layout") as "grid" | "list") || (matchMedia("(max-width: 760px)").matches ? "list" : "grid"),
  /** Root view: folder cards, or every host in collapsible per-group sections. */
  mode: (localStorage.getItem("kermius.mode") as "groups" | "sections") || "groups",
  collapsed: new Set<string>(JSON.parse(localStorage.getItem("kermius.collapsed") || "[]")),
  sessions: [] as Tab[],
  active: "home" as string,
  editing: null as Host | null,
  tunnels: new Set<string>(),
  /** Forwardings being started (spinning border). */
  connecting: new Set<string>(),
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
const byOrder = (a: Host, b: Host) => (a.order ?? 0) - (b.order ?? 0) || byName(a.name, b.name);

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
  return [...list].sort(byOrder);
}

// ---------- sidebar ----------

function renderSidebar() {
  const nav: [View, string, string][] = [
    ["hosts", "server", "Hosts"],
    ["keychain", "key", "Keychain"],
    ["forwarding", "forward", "Port Forwarding"],
    ...(desktop ? [["foldersync", "folders", "Folder Sync"] as [View, string, string]] : []),
    ...(nearbyOn ? [["nearby", "share", "Nearby Share"] as [View, string, string]] : []),
    ...(isWeb ? [] : [["wol", "power", "Wake on LAN"] as [View, string, string]]),
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
  const upd = pendingUpdate();
  els.foot.innerHTML = `${upd ? `<button class="update-pill" data-update title="Kermius ${esc(upd.version)} is available">${icon("import", 14)}<span class="grow">Update to v${esc(upd.version)}</span></button>` : ""}
    <button class="sync-pill ${cls}" title="${esc(state.syncError)}">${icon("sync", 14)}<span class="grow">${text}</span><span class="ver">v${state.version}</span></button>`;
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

els.foot.addEventListener("click", (e) => {
  const upd = pendingUpdate();
  if (upd && (e.target as HTMLElement).closest("[data-update]")) return updateDialog(upd);
  if (state.sync?.url) runSync(true);
  else {
    state.view = "settings";
    goHome();
  }
});

$(".scrim").addEventListener("click", () => els.shell.classList.remove("side-open"));

// Desktop: the collapse button switches to icons-only. Phones: the sidebar is a drawer that is
// either open or closed, so the same button closes it.
const phoneLayout = matchMedia("(max-width: 760px)");
const applySideMode = () => els.shell.classList.toggle("side-collapsed", !phoneLayout.matches && localStorage.getItem("kermius.sideCollapsed") === "1");
applySideMode();
phoneLayout.addEventListener("change", applySideMode);
$(".collapse-btn").addEventListener("click", () => {
  if (phoneLayout.matches) return els.shell.classList.remove("side-open");
  const on = els.shell.classList.toggle("side-collapsed");
  localStorage.setItem("kermius.sideCollapsed", on ? "1" : "");
});

// ---------- tabs ----------

function renderTabs() {
  const prev = els.tabs.querySelector<HTMLElement>(".tabs-scroll")?.scrollLeft ?? 0;
  els.tabs.innerHTML = `
    <button class="icon-btn menu-btn" data-act="menu">${icon("menu")}</button>
    <button class="tab home ${state.active === "home" ? "on" : ""}" data-tab="home">${icon("lock", 15)}<span>Vault</span></button>
    <div class="tabs-scroll">
      ${state.sessions
        .map(
          (s) => `<div class="tab ${state.active === s.id ? "on" : ""}" data-tab="${s.id}" title="${esc(s.host.username)}@${esc(s.host.address)}">
            ${s.kind === "files" ? icon("folder", 13) : s.kind === "vnc" ? icon("monitor", 13) : ""}<span class="st ${s.state}"></span><span class="tab-name">${esc(s.host.name)}${s.kind === "files" ? " · SFTP" : s.kind === "vnc" ? " · VNC" : ""}</span>
            <button class="tab-x" data-close="${s.id}">${icon("x", 13)}</button></div>`,
        )
        .join("")}
      <div class="grow" data-tauri-drag-region></div>
    </div>
    ${isWeb || /iPhone|iPad/i.test(navigator.userAgent) ? "" : `<button class="icon-btn" data-act="local" title="New local terminal">${icon("plus", 16)}</button>`}
    ${state.sessions.some((s) => s.id === state.active && !s.local) ? `<button class="icon-btn" data-act="copy-pass" title="Copy password">${icon("key", 16)}</button>` : ""}
    ${bellButton()}
    ${desktop ? `<div class="win-ctl">
      <button data-win="min" title="Minimize">${icon("min", 15)}</button>
      <button data-win="max" title="Maximize">${icon("max", 13)}</button>
      <button data-win="close" class="close" title="Close">${icon("x", 15)}</button></div>` : ""}`;
  // Keep the open tab in view; the rest of the strip scrolls on its own.
  const sc = els.tabs.querySelector<HTMLElement>(".tabs-scroll")!;
  sc.scrollLeft = prev;
  const on = sc.querySelector<HTMLElement>(".tab.on:not(.home)");
  if (on) {
    if (on.offsetLeft < sc.scrollLeft) sc.scrollLeft = on.offsetLeft - 8;
    else if (on.offsetLeft + on.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = on.offsetLeft + on.offsetWidth - sc.clientWidth + 8;
  }
}

// A mouse wheel scrolls the tab strip sideways.
els.tabs.addEventListener(
  "wheel",
  (e) => {
    const sc = (e.target as HTMLElement).closest<HTMLElement>(".tabs-scroll");
    if (!sc || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    sc.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);

// Custom title bar: window controls live in the tab bar (desktop only).
// Mobile keyboards cover the page without resizing it: size the app to the visual viewport instead.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fitViewport = () => {
    document.documentElement.style.setProperty("--vv-h", `${vv.height}px`);
    document.documentElement.style.setProperty("--vv-top", `${vv.offsetTop}px`);
  };
  vv.addEventListener("resize", fitViewport);
  vv.addEventListener("scroll", fitViewport);
  fitViewport();
}

const desktop = !isWeb && !/Android|iPhone|iPad/i.test(navigator.userAgent);
/** Nearby Share everywhere but the web; iOS has no multicast discovery, only saved addresses. */
const nearbyOn = !isWeb;
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
els.terms.addEventListener("kermius-host-saved", () => reload().then(scheduleSync));
// Edit host from a failed connection: the editor opens over the tab; saving updates the tab's host.
els.terms.addEventListener("kermius-edit-host", (e) => openEditor((e as CustomEvent).detail.host as Host));

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
  else if (state.view === "nearby") renderNearby(els.page);
  else if (state.view === "wol") renderWol(els.page, wolCtx);
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
      ${isWeb || /iPhone|iPad/i.test(navigator.userAgent) ? "" : `<button class="btn" data-act="local">${icon("terminal", 16)}<span>Terminal</span></button>`}
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
  for (const h of [...state.hosts].sort(byOrder)) {
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
        ${shut ? "" : `<div class="grid ${state.layout}" data-drop-folder="${esc(f)}">${hosts.map(hostCard).join("")}</div>`}</div>`;
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
      <div class="grid ${state.layout}" ${!state.query.trim() && !state.tag ? `data-drop-folder="${esc(state.folder ?? "")}"` : ""}>${list.map(hostCard).join("")}</div>` : groups.length ? "" : empty}`;
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

// ---------- drag & drop ordering (desktop) ----------

/** Pointer-based (HTML5 drag & drop clashes with the webview's file drop): drag a host card
 *  before/after another card, into a section, or onto a group card to move it there. */
let dragJustEnded = false;
els.page.addEventListener("pointerdown", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".card.host");
  const grid = card?.closest<HTMLElement>("[data-drop-folder]");
  if (!desktop || !card || !grid || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
  const id = card.dataset.host!;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost: HTMLElement | null = null;
  let drop: { folder: string; before: string | null } | null = null;
  const clear = () => els.page.querySelectorAll(".drop-before,.drop-after,.drop-into").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      const r = card.getBoundingClientRect();
      ghost = card.cloneNode(true) as HTMLElement;
      ghost.classList.add("drag-ghost");
      Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
      ghost.dataset.dx = String(x0 - r.left);
      ghost.dataset.dy = String(y0 - r.top);
      document.body.append(ghost);
      document.body.classList.add("no-select");
      card.classList.add("dragging");
    }
    ghost.style.left = `${ev.clientX - +ghost.dataset.dx!}px`;
    ghost.style.top = `${ev.clientY - +ghost.dataset.dy!}px`;
    clear();
    drop = null;
    const at = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const over = at?.closest<HTMLElement>(".card.host");
    const overGrid = at?.closest<HTMLElement>("[data-drop-folder]");
    const overGroup = at?.closest<HTMLElement>("[data-open-folder]");
    if (over && over !== card && overGrid) {
      const r = over.getBoundingClientRect();
      const after = state.layout === "list" ? ev.clientY > r.top + r.height / 2 : ev.clientX > r.left + r.width / 2;
      const next = after ? (over.nextElementSibling as HTMLElement | null) : over;
      over.classList.add(after ? "drop-after" : "drop-before");
      drop = { folder: overGrid.dataset.dropFolder!, before: next?.dataset.host ?? null };
    } else if (overGroup) {
      overGroup.classList.add("drop-into");
      drop = { folder: overGroup.dataset.openFolder!, before: null };
    } else if (overGrid && !over) {
      overGrid.classList.add("drop-into");
      drop = { folder: overGrid.dataset.dropFolder!, before: null };
    }
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("no-select");
    card.classList.remove("dragging");
    clear();
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false));
    if (drop) moveHost(id, drop.folder, drop.before === id ? null : drop.before);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
// A drag ends with a click on the card under the pointer: do not connect.
els.page.addEventListener("click", (e) => dragJustEnded && (e.stopImmediatePropagation(), e.preventDefault()), true);

/** Put host `id` into `folder` before host `before` (end when null); renumber that group and save what changed. */
async function moveHost(id: string, folder: string, before: string | null) {
  const h = state.hosts.find((x) => x.id === id);
  if (!h) return;
  const from = h.folder;
  const list = state.hosts.filter((x) => x.folder === folder && x.id !== id).sort(byOrder);
  const at = before ? list.findIndex((x) => x.id === before) : -1;
  list.splice(at < 0 ? list.length : at, 0, h);
  const changed = list.filter((x, i) => {
    if (x.order === i + 1 && x.folder === folder) return false;
    x.order = i + 1;
    x.folder = folder;
    return true;
  });
  if (!changed.length) return;
  refreshResults();
  try {
    for (const x of changed) await api.saveHost(x);
    await reload();
    scheduleSync();
    if (from !== folder) toast(`Moved to ${folder || "No group"}`, "ok");
  } catch (err) {
    toast(String(err), "err");
    await reload();
  }
}

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
      <button class="btn primary" data-new-rule>${icon("plus", 16)}<span>New forwarding</span></button>
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
  const cards = rows.flatMap((h) => h.tunnels.map((t, i) => ({ h, t, key: `${h.id}:${i}` })));
  el.innerHTML = cards.length
    ? `<div class="fwd-grid">${cards
        .map(({ h, t, key }) => {
          const st = state.connecting.has(key) ? "connecting" : state.tunnels.has(key) ? "on" : "";
          const title = t.label || `${h.name} · ${t.sourcePort}`;
          return `<div class="fwd-card ${st}" data-tunnel="${key}" title="${isWeb ? "" : st === "on" ? "Click to stop" : "Click to start"}">
            <div class="fwd-avatar">L</div>
            <div class="fwd-text"><b>${esc(title)}</b>
              <span>Local:${t.sourcePort} → ${esc(h.name)} → ${esc(t.endpointHost || "localhost")}:${t.endpointPort}</span></div>
            <button class="icon-btn fwd-edit" data-edit-tunnel="${key}" title="Edit">${icon("edit", 15)}</button></div>`;
        })
        .join("")}</div>`
    : `<div class="empty">${icon("forward", 40)}<h3>No port forwarding rules</h3><p>Forward a local port to a service reachable from one of your SSH hosts.</p>
        <button class="btn primary" data-new-rule>New forwarding</button></div>`;
}

const splitKey = (key: string) => [key.slice(0, key.lastIndexOf(":")), +key.slice(key.lastIndexOf(":") + 1)] as const;

/** New or edit a local forward: the SSH host it goes through (picked like in Folder Sync), then the ports. */
function ruleDialog(key?: string) {
  const hosts = state.hosts.filter((h) => !h.protocol || h.protocol === "ssh").sort((a, b) => byName(a.name, b.name));
  if (!hosts.length) return toast("Add an SSH host first", "info");
  const [hostId, idx] = key ? splitKey(key) : ["", -1];
  const rule = state.hosts.find((h) => h.id === hostId)?.tunnels[idx];
  if (key && state.tunnels.has(key)) return toast("Stop this forwarding before editing it", "info");
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<form class="modal form-modal fwd-modal"><h3>${rule ? "Edit" : "New"} port forwarding</h3>
    <label class="field"><span>Label</span><input name="label" value="${esc(rule?.label ?? "")}" placeholder="e.g. Tensorboard" /></label>
    <div class="field"><span>Through host</span>
      ${rule ? "" : `<input class="fs-route-filter" placeholder="Filter by name, IP, group or tag…" spellcheck="false" />`}
      <div class="fs-routes">${hosts
        .filter((h) => !rule || h.id === hostId)
        .map(
          (h) => `<label class="fs-route" data-search="${esc([h.name, h.username, h.address, h.folder, ...h.tags].join(" ").toLowerCase())}">
            <input type="radio" name="host" value="${h.id}" ${h.id === hostId ? "checked" : ""} ${rule ? "disabled" : ""} required />
            <span>${esc(h.name)} <small class="muted">${esc(h.username ? `${h.username}@` : "")}${esc(h.address)}</small>
              ${h.tags.map((t) => `<small class="mini-tag">${esc(t)}</small>`).join("")}</span></label>`,
        )
        .join("")}</div></div>
    <div class="field-row">
      <label class="field grow"><span>Local address</span><input name="bind" value="${esc(rule?.bindHost || "127.0.0.1")}" spellcheck="false" /></label>
      <label class="field" style="width:110px"><span>Local port</span><input name="sport" type="number" min="1" max="65535" placeholder="8080" value="${rule?.sourcePort || ""}" required /></label>
    </div>
    <div class="field-row">
      <label class="field grow"><span>Destination (as seen from the host)</span><input name="dhost" value="${esc(rule?.endpointHost || "localhost")}" spellcheck="false" /></label>
      <label class="field" style="width:110px"><span>Port</span><input name="dport" type="number" min="1" max="65535" placeholder="80" value="${rule?.endpointPort || ""}" required /></label>
    </div>
    <div class="modal-actions">${rule ? `<button type="button" class="btn danger" data-m="delete">Delete</button><div class="grow"></div>` : ""}
      <button type="button" class="btn ghost" data-m="close">Cancel</button><button class="btn primary">${rule ? "Save" : "Add"}</button></div></form>`;
  document.body.append(el);
  const f = el.querySelector("form")!;
  const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "").trim();
  el.querySelector<HTMLInputElement>(rule ? '[name="label"]' : ".fs-route-filter")!.focus();
  el.querySelector(".fs-route-filter")?.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    el.querySelectorAll<HTMLElement>(".fs-route").forEach((r) => (r.hidden = !!q && !r.dataset.search!.includes(q)));
  });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === el || t.dataset.m === "close") el.remove();
    else if (t.dataset.m === "delete") {
      el.remove();
      deleteRule(key!);
    }
  });
  el.addEventListener("keydown", (e) => e.key === "Escape" && el.remove());
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const h = state.hosts.find((x) => x.id === (rule ? hostId : v("host")));
    if (!h) return toast("Pick a host", "info");
    const next = { label: v("label"), bindHost: v("bind") || "127.0.0.1", sourcePort: +v("sport"), endpointHost: v("dhost") || "localhost", endpointPort: +v("dport") };
    try {
      // New rules are appended, so indices of running tunnels stay valid.
      await api.saveHost({ ...h, tunnels: rule ? h.tunnels.map((t, i) => (i === idx ? next : t)) : [...h.tunnels, next] });
      el.remove();
      await reload();
      scheduleSync();
      toast(rule ? "Saved" : "Forwarding added", "ok");
    } catch (err) {
      toast(String(err), "err");
    }
  });
}

async function deleteRule(key: string) {
  const [id, idx] = splitKey(key);
  // Indices of running tunnels would shift, so require them stopped first.
  if ([...state.tunnels].some((k) => k.startsWith(`${id}:`))) return toast("Stop this host's forwardings first", "err");
  const h = state.hosts.find((x) => x.id === id);
  if (!h) return;
  await api.saveHost({ ...h, tunnels: h.tunnels.filter((_, i) => i !== idx) });
  await reload();
  scheduleSync();
  toast("Forwarding deleted", "ok");
}

async function toggleRule(key: string) {
  if (isWeb || state.connecting.has(key)) return;
  const [id, idx] = splitKey(key);
  if (state.tunnels.has(key)) {
    await api.tunnelStop(id, idx);
    state.tunnels.delete(key);
    return renderForwardList();
  }
  state.connecting.add(key);
  renderForwardList();
  try {
    await api.tunnelStart(id, idx);
    state.tunnels.add(key);
  } catch (err) {
    toast(String(err), "err");
  } finally {
    state.connecting.delete(key);
    renderForwardList();
  }
}

els.page.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-new-rule]")) return ruleDialog();
  const edit = t.closest<HTMLElement>("[data-edit-tunnel]")?.dataset.editTunnel;
  if (edit) return ruleDialog(edit);
  const key = t.closest<HTMLElement>(".fwd-card[data-tunnel]")?.dataset.tunnel;
  if (key) toggleRule(key);
});

els.page.addEventListener("contextmenu", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>(".fwd-card[data-tunnel]")?.dataset.tunnel;
  if (!key) return;
  e.preventDefault();
  const [id, idx] = splitKey(key);
  const port = state.hosts.find((h) => h.id === id)?.tunnels[idx]?.sourcePort;
  const on = state.tunnels.has(key);
  contextMenu(e.clientX, e.clientY, [
    ...(isWeb ? [] : [{ label: on ? "Stop" : "Start", icon: on ? "stop" : "play", action: () => toggleRule(key) }]),
    ...(on ? [{ label: "Copy URL", icon: "copy", action: () => api.clipboardWrite(`http://localhost:${port}`).then(() => toast(`http://localhost:${port} copied`, "ok")) }] : []),
    { label: "Edit", icon: "edit", action: () => ruleDialog(key) },
    "-" as const,
    { label: "Delete", icon: "trash", danger: true, action: () => deleteRule(key) },
  ]);
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

const onNearby = () => state.view === "nearby" && state.active === "home";
const onWol = () => state.view === "wol" && state.active === "home";
const wolCtx: WolCtx = { hosts: () => state.hosts, rerender: () => onWol() && renderWol(els.page, wolCtx), changed: async () => { await reload(); scheduleSync(); } };
bindWol(els.page, wolCtx, onWol);
const rerenderNearby = () => onNearby() && renderNearby(els.page);
bindNearby(els.page, rerenderNearby, onNearby);

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

const RENDERERS = [
  ["", "Automatic"],
  ["canvas", "Canvas (exact grid, drawn box lines)"],
  ["dom", "DOM (sharpest text on Linux)"],
  ["webgl", "WebGL (fastest)"],
];

els.page.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.id === "s-autostart") {
    const on = (t as unknown as HTMLInputElement).checked;
    return api.autostartSet(on).then(
      () => toast(on ? "Kermius will start when you log in" : "Start on login turned off", "ok"),
      (err) => toast(String(err), "err"),
    );
  }
  if (t.id !== "s-renderer") return;
  if (t.value) localStorage.setItem("kermius.renderer", t.value);
  else localStorage.removeItem("kermius.renderer");
  toast("Renderer saved; open a new tab to use it", "ok");
});

function renderSettings() {
  const s = state.sync ?? { url: "", token: "", passphrase: "", lastSync: 0 };
  const p = loadPrefs();
  // Re-renders (font size, sync save…) keep the scroll position.
  const scroll = els.page.querySelector(".content.settings")?.scrollTop ?? 0;
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
      ${desktop ? `<div class="panel">
        <div class="panel-head">${icon("settings")}<div><h3>General</h3></div></div>
        <label class="toggle-row"><span><b>Start Kermius when I log in</b><small class="muted">Folder Sync watchers start with it</small></span>
          <input type="checkbox" class="toggle" id="s-autostart" /></label>
      </div>` : ""}
      ${isWeb ? "" : `<div class="panel">
        <div class="panel-head">${icon("import")}<div><h3>Import from Termix</h3><p class="muted">Termix → Host Manager → Export (JSON). Existing hosts are updated, not duplicated.</p></div></div>
        <label class="field"><span>Export file path</span><input id="imp-path" placeholder="/home/you/termix-hosts.json" /></label>
        <div class="row"><button class="btn" data-set="import">Import</button></div>
      </div>
      <div class="panel">
        <div class="panel-head">${icon("terminal")}<div><h3>~/.ssh/config</h3><p class="muted">Import its hosts (keys from IdentityFile are read; a missing password is asked on the first connect), or export hosts for the regular <code>ssh</code> command, scp, VS Code Remote…</p></div></div>
        <div class="row"><button class="btn" data-set="ssh-import">${icon("import", 15)} Import</button><button class="btn" data-set="ssh-export">Export…</button></div>
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
        <label class="field" style="margin-top:12px"><span>Renderer <small class="muted">(applies to new tabs)</small></span>
          <select id="s-renderer">${RENDERERS.map(([v, l]) => `<option value="${v}" ${(localStorage.getItem("kermius.renderer") ?? "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <small>If tmux/htop borders look broken or columns drift (e.g. with display scaling), try Canvas.</small></label>
      </div>`}
      <p class="muted center">Kermius ${state.version} · ${state.hosts.length} hosts${isWeb ? "" : ` · <button class="link-btn" data-set="check-update">Check for updates</button>`}</p>
    </div>`;
  $(".content.settings", els.page).scrollTop = scroll;
  if (desktop)
    api.autostartGet().then((on) => {
      const c = $<HTMLInputElement>("#s-autostart", els.page);
      if (c) c.checked = on;
    });
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
  } else if (a === "check-update") {
    checkUpdate(true, renderSyncFoot);
  } else if (a === "ssh-import") {
    try {
      const r = await api.sshConfigImport();
      toast(`~/.ssh/config: ${r.added} added, ${r.skipped} already in Kermius (skipped)${r.updated ? `, ${r.updated} got a key` : ""}`, "ok");
      await reload();
      scheduleSync();
    } catch (err) {
      toast(String(err), "err");
    }
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
    setPrefs({ ...p, fontSize: Math.max(4, Math.min(32, p.fontSize + (a === "size-inc" ? 1 : -1))) });
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
  els.drawer.innerHTML = "";
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
  if (proto === "vnc") {
    const h = state.editing!;
    const steps = [
      ["Install x11vnc on the remote", "sudo apt install -y x11vnc"],
      ...(h.password ? [["Save the same VNC password there", "x11vnc -storepasswd ~/.vnc/passwd"]] : []),
      ["Share the desktop (add -clip xinerama0 for the first monitor only)", x11vncCommand(h)],
    ];
    return `<div class="proto-note">Opens the remote desktop in a tab (port 5900 + display number, e.g. :1 = 5901).
      ${steps.map(([t, c]) => `<div class="vnc-step"><span>${esc(t)}</span><div class="input-group"><code>${esc(c)}</code>
        <button type="button" class="btn ghost sm" data-ed="copy-cmd" data-cmd="${esc(c)}">${icon("copy", 13)} Copy</button></div></div>`).join("")}
      ${h.password ? "" : `<small class="muted">Without a password anyone who reaches the port can connect: set one below, or add <code>-localhost</code> and use a port forwarding.</small>`}</div>`;
  }
  return "";
}

/** x11vnc command matching the host settings (port, password, view-only). */
function x11vncCommand(h: Host) {
  return [
    "x11vnc -display :0",
    h.password ? "-rfbauth ~/.vnc/passwd" : "-nopw",
    h.viewOnly ? "-viewonly" : "",
    `-shared -forever -rfbport ${h.port || 5900} -xkb -repeat -bg -nocursorshape -cursor most -fixscreen V=1`,
  ].filter(Boolean).join(" ");
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
  // Re-renders (add a rule, a jump host…) keep the scroll position.
  const scroll = els.drawer.querySelector(".drawer-body")?.scrollTop ?? 0;
  els.drawer.innerHTML = `
    <div class="drawer-head">
      <button class="icon-btn" data-ed="close" title="Close">${icon("chevron")}</button>
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
      <label class="toggle-row nearby-opt" ${proto === "serial" || !nearbyOn ? "hidden" : ""}><span><b>Use this address for Nearby Share</b>
        <small class="muted">Send files to Kermius / LocalSend here, e.g. across a VPN where devices cannot see each other</small></span>
        <input type="checkbox" class="toggle" id="e-nearby" ${h.nearby ? "checked" : ""} /></label>
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
        <div class="vnc-opts" ${proto === "vnc" ? "" : "hidden"}>
          <label class="toggle-row"><span><b>Allow control</b><small class="muted">Mouse and keyboard; off = view only</small></span><input type="checkbox" class="toggle" id="e-vnc-control" ${h.viewOnly ? "" : "checked"} /></label>
          <label class="toggle-row"><span><b>Share clipboard</b><small class="muted">Copy and paste between this device and the remote desktop</small></span><input type="checkbox" class="toggle" id="e-vnc-clip" ${h.noClipboard ? "" : "checked"} /></label>
        </div>
        <label class="field" ${proto === "serial" ? "hidden" : ""}><span>${proto === "vnc" ? "VNC password" : "Password"}</span>
          <div class="input-group"><input id="e-pass" type="password" value="${esc(h.password)}" autocomplete="off" />
            <button class="icon-btn" data-ed="toggle-pass" title="Show">${icon("eye", 16)}</button>
            <button class="icon-btn" data-ed="copy-pass" title="Copy">${icon("copy", 16)}</button></div></label>
        <details ${h.privateKey ? "open" : ""} ${isSsh(h) ? "" : "hidden"}><summary>Private key</summary>
          <label class="field"><textarea id="e-key" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false">${esc(h.privateKey)}</textarea></label>
          <label class="field"><span>Key passphrase</span><input id="e-keypass" type="password" value="${esc(h.keyPassphrase)}" /></label>
        </details>
        <div class="cred-actions" ${isSsh(h) ? "" : "hidden"}>
          <button class="btn ghost sm" data-ed="to-keychain" title="Move these credentials into an identity, shared by other hosts and synced">${icon("key", 14)} Save to Keychain</button>
          ${isWeb ? "" : `<button class="btn ghost sm" data-ed="test">${icon("plug", 14)} Test connection</button>`}
        </div>
        <pre class="test-log" hidden></pre>
      </div>
      <div class="panel" ${isSsh(h) ? "" : "hidden"}>
        <h5>Advanced</h5>
        ${jumpChainHtml(h)}
        <label class="field"><span>Proxy</span><input id="e-proxy" value="${esc(h.proxy ?? "")}" placeholder="socks5://user:pass@host:1080 or http://host:3128" spellcheck="false" /></label>
        <label class="toggle-row adv-toggle"><span><b>Agent forwarding</b><small class="muted">The remote can use the keys in your local ssh-agent</small></span>
          <input type="checkbox" class="toggle" id="e-agent" ${h.agentForward ? "checked" : ""} /></label>
        <label class="field env-field"><span>Environment variables <small class="muted">NAME=value per line; the server must allow them (AcceptEnv)</small></span>
          <textarea id="e-env" rows="2" spellcheck="false" placeholder="LANG=en_US.UTF-8">${esc(h.env ?? "")}</textarea></label>
        <label class="field"><span>Startup snippet</span><select id="e-snippet"><option value="">None</option>${state.snippets
          .map((s) => `<option value="${s.id}" ${s.id === h.startupSnippetId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
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
  els.drawer.querySelector(".drawer-body")!.scrollTop = scroll;
  loadSerialHints();
}

/** Hops in connection order (older hosts have a single jumpHostId). */
const jumpChainOf = (h: Host) => (h.jumpChain?.length ? h.jumpChain : h.jumpHostId ? [h.jumpHostId] : []);

function jumpChainHtml(h: Host) {
  const chain = jumpChainOf(h);
  const opts = (sel: string) =>
    state.hosts
      .filter((x) => x.id !== h.id && isSsh(x))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((x) => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(x.name)} (${esc(x.address)})</option>`)
      .join("");
  return `<div class="field"><span>Jump hosts <small class="muted">${chain.length ? "connected in this order" : "none: connects directly"}</small></span>
    <div class="jump-chain">
      ${chain.length ? `<div class="jc-node">${icon("monitor", 14)} This device</div>` : ""}
      ${chain.map((id, i) => `<div class="jc-arrow">↓</div><div class="jc-row"><span class="jc-n">${i + 1}</span><select data-jc="${i}"><option value="">Pick a host…</option>${opts(id)}</select>
        <button class="icon-btn" data-ed="jc-rm" data-i="${i}" title="Remove">${icon("x", 14)}</button></div>`).join("")}
      ${chain.length ? `<div class="jc-arrow">↓</div><div class="jc-node">${icon("server", 14)} ${esc(h.name || h.address || "This host")}</div>` : ""}
    </div>
    <button class="btn ghost sm" data-ed="jc-add">${icon("plus", 14)} Add jump host</button></div>`;
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
  h.viewOnly = !$<HTMLInputElement>("#e-vnc-control", els.drawer).checked;
  h.noClipboard = !$<HTMLInputElement>("#e-vnc-clip", els.drawer).checked;
  h.password = v("e-pass");
  h.privateKey = v("e-key");
  h.keyPassphrase = v("e-keypass");
  Object.assign(h, readPickers(els.drawer));
  h.nearby = $<HTMLInputElement>("#e-nearby", els.drawer).checked;
  h.jumpChain = [...els.drawer.querySelectorAll<HTMLSelectElement>("[data-jc]")].map((s) => s.value);
  h.jumpHostId = "";
  h.proxy = v("e-proxy").trim();
  h.agentForward = $<HTMLInputElement>("#e-agent", els.drawer).checked;
  h.env = v("e-env").trim();
  h.startupSnippetId = v("e-snippet");
  h.notes = v("e-notes");
  h.tunnels = [...els.drawer.querySelectorAll<HTMLElement>(".tun-row")].map((r) => {
    const f = (k: string) => $<HTMLInputElement>(`[data-f="${k}"]`, r).value.trim();
    return { label: h.tunnels[+r.dataset.i!]?.label ?? "", bindHost: f("bindHost") || "127.0.0.1", sourcePort: +f("sourcePort") || 0, endpointHost: f("endpointHost"), endpointPort: +f("endpointPort") || 0 };
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
    case "jc-add":
      readEditor();
      h.jumpChain = [...jumpChainOf(h), ""];
      return renderEditor();
    case "jc-rm":
      readEditor();
      h.jumpChain = jumpChainOf(h).filter((_, i) => i !== +b.dataset.i!);
      return renderEditor();
    case "to-keychain":
      readEditor();
      return credentialsToKeychain(h);
    case "test": {
      readEditor();
      const out = $<HTMLElement>(".test-log", els.drawer);
      out.hidden = false;
      out.className = "test-log";
      out.textContent = "Connecting…";
      b.setAttribute("disabled", "");
      try {
        out.textContent = (await api.sshTest({ ...h, jumpChain: h.jumpChain?.filter(Boolean) })).join("\n");
        out.classList.add("ok");
      } catch (err) {
        out.textContent = String(err);
        out.classList.add("err");
      } finally {
        b.removeAttribute("disabled");
        out.scrollTop = out.scrollHeight;
      }
      return;
    }
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

// The x11vnc guide follows the control/password settings.
els.drawer.addEventListener("change", (e) => {
  const id = (e.target as HTMLElement).id;
  if (state.editing?.protocol === "vnc" && ["e-vnc-control", "e-pass", "e-port"].includes(id)) {
    readEditor();
    renderEditor();
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
  h.jumpChain = h.jumpChain?.filter(Boolean);
  try {
    const saved = await api.saveHost(h);
    state.editing = saved;
    for (const s of state.sessions) if (s.host.id === saved.id) s.host = saved;
    await reload();
    scheduleSync();
    toast("Saved", "ok");
    return true;
  } catch (err) {
    toast(String(err), "err");
    return false;
  }
}

/** Move the host's own username/password/key into a new identity (and key) and link it. */
async function credentialsToKeychain(h: Host) {
  if (!h.username && !h.password && !h.privateKey.trim()) return toast("Enter a username, password or key first", "err");
  const name = h.name || h.address;
  try {
    let keyId = h.keyId;
    if (h.privateKey.trim()) {
      const key = await api.saveKey({ id: "", label: `${name} key`, privateKey: h.privateKey, passphrase: h.keyPassphrase, publicKey: "", updatedAt: 0, deleted: false });
      keyId = key.id;
    }
    const identity = await api.saveIdentity({ id: "", label: `${h.username || "user"}@${name}`, username: h.username, password: h.password, keyId, updatedAt: 0, deleted: false });
    Object.assign(h, { identityId: identity.id, keyId: "", username: "", password: "", privateKey: "", keyPassphrase: "" });
    await reload();
    scheduleSync();
    renderEditor();
    toast(`Saved to Keychain as ${identity.label}; save the host to keep the link`, "ok");
  } catch (err) {
    toast(String(err), "err");
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
  if (!isWeb) {
    setTimeout(() => checkUpdate(false, renderSyncFoot), 15_000);
    setInterval(() => checkUpdate(false, renderSyncFoot), 6 * 3600_000);
  }
  if (desktop) {
    await loadJobs();
    await listenFolderSync(folderSync);
    runDueJobs(folderSync);
    setInterval(() => runDueJobs(folderSync), 60_000);
  }
  initOsNotifications();
  if (nearbyOn) initNearby(rerenderNearby, () => state.hosts, onNearby).catch((e) => console.error(e));
  setInterval(renderSyncFoot, 30_000);
})();
