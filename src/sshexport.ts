// Export hosts to ~/.ssh/config: pick groups/hosts in a tree, preview, copy or save.
import { api, type Host } from "./api";
import { esc, icon, toast } from "./ui";

export function sshExportDialog(hosts: Host[]) {
  const groups = new Map<string, Host[]>();
  for (const h of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = groups.get(h.folder) ?? [];
    g.push(h);
    groups.set(h.folder, g);
  }
  const names = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const picked = new Set(hosts.map((h) => h.id));
  const open = new Set<string>();
  let withKeys = true;
  let withPasswords = false;
  let filter = "";

  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<div class="modal sx-modal">
    <div class="sx-head"><h3>Export to ~/.ssh/config</h3><div class="grow"></div><button class="icon-btn" data-x="close">${icon("x", 16)}</button></div>
    <div class="sx-body">
      <div class="sx-left">
        <input class="sx-search" placeholder="Filter hosts…" spellcheck="false" />
        <label class="sx-all"><input type="checkbox" data-x="all" /> <b>All hosts</b> <span class="muted sx-count"></span></label>
        <div class="sx-tree"></div>
        <label class="sx-opt"><input type="checkbox" data-x="keys" checked /> Export private keys to <code>~/.ssh/kermius/</code></label>
        <label class="sx-opt"><input type="checkbox" data-x="pw" /> Add passwords as comments (plain text, easy to copy)</label>
      </div>
      <div class="sx-right"><div class="muted sx-note">Saved as a marked block in <code>~/.ssh/config</code>; exporting again replaces only that block. Passwords are only added as comments when you tick that option.</div>
        <pre class="sx-preview"></pre></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-x="close">Cancel</button><button class="btn" data-x="copy">${icon("copy", 14)} Copy</button>
      <button class="btn primary" data-x="save">Save to ~/.ssh/config</button></div></div>`;
  document.body.append(el);
  const close = () => el.remove();

  const visible = (h: Host) => !filter || `${h.name} ${h.address} ${h.username} ${h.folder}`.toLowerCase().includes(filter);
  const ids = () => hosts.filter((h) => picked.has(h.id)).map((h) => h.id);
  const setBox = (box: HTMLInputElement, list: Host[]) => {
    const n = list.filter((h) => picked.has(h.id)).length;
    box.checked = n > 0 && n === list.length;
    box.indeterminate = n > 0 && n < list.length;
  };

  let seq = 0;
  const preview = async () => {
    const mine = ++seq;
    const text = ids().length ? await api.sshConfigPreview(ids(), withKeys, withPasswords).catch((e) => `# ${e}`) : "# Nothing selected";
    if (mine === seq) el.querySelector(".sx-preview")!.textContent = text.trim();
  };

  const render = () => {
    el.querySelector(".sx-tree")!.innerHTML = names
      .map((g) => {
        const list = groups.get(g)!.filter(visible);
        if (!list.length) return "";
        const expanded = open.has(g) || !!filter;
        return `<div class="sx-group">
          <div class="sx-row"><button class="sx-caret ${expanded ? "on" : ""}" data-x="toggle" data-g="${esc(g)}">${icon("chevron", 13)}</button>
            <label><input type="checkbox" data-x="group" data-g="${esc(g)}" /><span class="sx-dot" style="background:hsl(${(g.length * 47) % 360} 60% 55%)"></span>
            <b>${esc(g || "No group")}</b> <span class="muted">${list.length}</span></label></div>
          ${expanded ? list.map((h) => `<label class="sx-host"><input type="checkbox" data-x="host" data-id="${h.id}" ${picked.has(h.id) ? "checked" : ""} />
            <span>${esc(h.name)}</span><span class="muted">${esc(h.username ? `${h.username}@` : "")}${esc(h.address)}</span></label>`).join("") : ""}
        </div>`;
      })
      .join("");
    el.querySelectorAll<HTMLInputElement>('[data-x="group"]').forEach((b) => setBox(b, groups.get(b.dataset.g!)!.filter(visible)));
    setBox(el.querySelector<HTMLInputElement>('[data-x="all"]')!, hosts);
    el.querySelector(".sx-count")!.textContent = `${picked.size} of ${hosts.length}`;
    preview();
  };

  el.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains("sx-search")) {
      filter = t.value.trim().toLowerCase();
      return render();
    }
    const x = t.dataset.x;
    if (x === "keys") withKeys = t.checked;
    else if (x === "pw") withPasswords = t.checked;
    else if (x === "all") hosts.forEach((h) => (t.checked ? picked.add(h.id) : picked.delete(h.id)));
    else if (x === "group") groups.get(t.dataset.g!)!.filter(visible).forEach((h) => (t.checked ? picked.add(h.id) : picked.delete(h.id)));
    else if (x === "host") t.checked ? picked.add(t.dataset.id!) : picked.delete(t.dataset.id!);
    render();
  });
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === el) return close();
    const b = t.closest<HTMLElement>("[data-x]");
    const x = b?.dataset.x;
    if (x === "close") return close();
    if (x === "toggle") {
      const g = b!.dataset.g!;
      open.has(g) ? open.delete(g) : open.add(g);
      return render();
    }
    if (x === "copy") return api.clipboardWrite(el.querySelector(".sx-preview")!.textContent ?? "").then(() => toast("Copied", "ok"));
    if (x === "save") {
      if (!ids().length) return toast("Select at least one host", "info");
      try {
        const path = await api.sshConfigExport(ids(), withKeys, withPasswords);
        toast(`Exported ${ids().length} host${ids().length > 1 ? "s" : ""} to ${path}`, "ok");
        close();
      } catch (err) {
        toast(String(err), "err");
      }
    }
  });
  el.addEventListener("keydown", (e) => e.key === "Escape" && close());
  render();
}
