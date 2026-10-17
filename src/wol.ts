// Wake on LAN: computers to wake with a magic packet, and per-OS setup steps.
import { api, type Host, type WolDevice } from "./api";
import { confirmDialog, esc, icon, morphHtml, toast } from "./ui";

export interface WolCtx {
  hosts(): Host[];
  rerender(): void;
  /** Reload the vault and schedule a sync (devices are part of the synced vault). */
  changed(): Promise<void>;
}

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
let devices: WolDevice[] = [];
let loadedAt = 0;
let sending = new Set<string>();
type OsKey = "linux" | "windows" | "mac" | "relay";
let os: OsKey = "linux";

async function load(ctx: WolCtx) {
  devices = await api.wolList().catch(() => []);
  loadedAt = Date.now();
  ctx.rerender();
}

const relayName = (ctx: WolCtx, id: string) => (id ? ctx.hosts().find((h) => h.id === id)?.name ?? "removed host" : "this computer");

function card(ctx: WolCtx, d: WolDevice) {
  const busy = sending.has(d.id);
  return `<div class="card wol-card ${busy ? "sending" : ""}" data-wol-id="${d.id}">
    <button class="wol-power" data-wol="send" title="Wake ${esc(d.name)}">${icon("power", 22)}</button>
    <div class="card-body">
      <div class="card-title">${esc(d.name)}</div>
      <div class="card-sub">${esc(d.mac.toUpperCase())} · ${esc(d.broadcast || "255.255.255.255")}:${d.port || 9}</div>
      <div class="card-sub">Sent from ${esc(relayName(ctx, d.relay))}</div>
    </div>
    <div class="card-actions" style="opacity:1">
      <button class="icon-btn" data-wol="edit" title="Edit">${icon("edit", 16)}</button>
      <button class="icon-btn danger" data-wol="delete" title="Delete">${icon("trash", 16)}</button>
    </div>
  </div>`;
}

const STEPS: Record<OsKey, { title: string; steps: (string | [string, string])[] }> = {
  linux: {
    title: "Ubuntu / Debian",
    steps: [
      "Turn on Wake on LAN in the BIOS/UEFI (often under Power, or “Power on by PCI-E / LAN”).",
      ["Find the wired interface and its MAC address:", "ip -br link"],
      ["Check that the adapter supports it (look for “Wake-on: g”):", "sudo ethtool enp3s0 | grep -i wake"],
      ["Enable it for this boot:", "sudo ethtool -s enp3s0 wol g"],
      ["Keep it after a reboot with NetworkManager (use the connection name from nmcli):", 'nmcli connection modify "Wired connection 1" 802-3-ethernet.wake-on-lan magic'],
      "Replace enp3s0 with your interface name. Wi-Fi adapters rarely support Wake on LAN.",
    ],
  },
  windows: {
    title: "Windows",
    steps: [
      "Turn on Wake on LAN in the BIOS/UEFI (“Power on by PCI-E / LAN”).",
      "Turn off Fast Startup: Control Panel → Power Options → Choose what the power buttons do → Change settings that are currently unavailable → untick “Turn on fast startup”.",
      "Device Manager → Network adapters → your Ethernet adapter → Properties → Power Management: tick “Allow this device to wake the computer” and “Only allow a magic packet to wake the computer”.",
      "Same adapter → Advanced tab → “Wake on Magic Packet” → Enabled.",
      ["Find the MAC address (Physical Address):", "ipconfig /all"],
    ],
  },
  mac: {
    title: "macOS",
    steps: [
      "Desktop Macs (Mac mini, iMac, Mac Studio): System Settings → Energy → turn on “Wake for network access”.",
      "Wake works from sleep, not from a full shutdown. Keep the Mac on Ethernet.",
      ["Find the wired interface's MAC address (look for the Ethernet port, often en0 or en1):", "networksetup -listallhardwareports"],
      ["Then show its address:", "ifconfig en0 | grep ether"],
    ],
  },
  relay: {
    title: "Through another computer (VPN)",
    steps: [
      "Broadcast packets do not cross a VPN. Pick “Send from” an always-on SSH host on the target's LAN (for example a Raspberry Pi or a mini PC).",
      "Kermius connects to that host over the VPN and sends the packet from there. That host needs Perl (preinstalled on Linux and macOS).",
      "Test it: the target should wake within a few seconds of pressing the power button.",
    ],
  },
};

function help() {
  const tab = (k: OsKey) => `<button class="wol-os ${os === k ? "on" : ""}" data-wol="os" data-os="${k}">${STEPS[k].title}</button>`;
  const cur = STEPS[os];
  let n = 0;
  const steps = cur.steps
    .map((s) => {
      n++;
      if (typeof s === "string") return `<li>${esc(s)}</li>`;
      return `<li>${esc(s[0])}<div class="wol-cmd"><code>${esc(s[1])}</code><button class="icon-btn" data-wol="copy" data-cmd="${esc(s[1])}" title="Copy command">${icon("copy", 14)}</button></div></li>`;
    })
    .join("");
  return `<details class="wol-help">
    <summary>How to turn on Wake on LAN</summary>
    <div class="wol-tabs">${(["linux", "windows", "mac", "relay"] as OsKey[]).map(tab).join("")}</div>
    <h5>${esc(cur.title)}</h5>
    <ol class="wol-steps">${steps}</ol>
  </details>`;
}

export function renderWol(root: HTMLElement, ctx: WolCtx) {
  // Devices can change on another computer (sync): refresh when the page is shown again.
  if (Date.now() - loadedAt > 3000) load(ctx);
  const live = devices.filter((d) => !d.deleted);
  const html = `
    <div class="toolbar">
      <h2 class="wol-title">Wake on LAN</h2>
      <div class="grow"></div>
      <button class="btn primary" data-wol="new">${icon("plus", 16)} New device</button>
    </div>
    <div class="content">
      ${live.length
        ? `<div class="grid wol-grid">${live.map((d) => card(ctx, d)).join("")}</div>`
        : `<div class="empty small">${icon("power", 36)}<h3>No devices yet</h3><p>Add a computer's MAC address to wake it from anywhere on your network or VPN.</p>
            </div>`}
      ${help()}
    </div>`;
  if (root.querySelector(".wol-title")) morphHtml(root, html);
  else root.innerHTML = html;
}

/** The magic packet goes out now; the card shows it for a moment. */
async function wake(ctx: WolCtx, d: WolDevice) {
  sending.add(d.id);
  ctx.rerender();
  const minimum = new Promise((r) => setTimeout(r, 1400));
  try {
    await Promise.all([api.wolSend(d.id), minimum]);
    toast(`Magic packet sent to ${d.name}`, "ok");
  } catch (err) {
    await minimum;
    toast(String(err), "err");
  } finally {
    sending.delete(d.id);
    ctx.rerender();
  }
}

function deviceForm(ctx: WolCtx, d: WolDevice | null) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  const hosts = ctx.hosts().filter((h) => !h.protocol || h.protocol === "ssh" || h.protocol === "mosh").sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<form class="modal wol-form"><h3>${d ? "Edit device" : "New device"}</h3>
    <label class="field"><span>Name</span><input name="name" value="${esc(d?.name ?? "")}" placeholder="Office PC" required /></label>
    <label class="field"><span>MAC address</span><input name="mac" value="${esc(d?.mac ?? "")}" placeholder="AA:BB:CC:DD:EE:FF" spellcheck="false" required /></label>
    <div class="field-row">
      <label class="field grow"><span>Broadcast <small class="muted">(optional)</small></span><input name="broadcast" value="${esc(d?.broadcast ?? "")}" placeholder="255.255.255.255" spellcheck="false" /></label>
      <label class="field" style="width:96px"><span>Port</span><input name="port" type="number" value="${d?.port || 9}" /></label>
    </div>
    <label class="field"><span>Send from</span><select name="relay">
      <option value="">This computer (same LAN)</option>
      ${hosts.map((h) => `<option value="${h.id}" ${h.id === d?.relay ? "selected" : ""}>${esc(h.name)} (${esc(h.address)})</option>`).join("")}
    </select></label>
    <p class="muted wol-hint">Only needed when this device is on a VPN. Pick a saved host that sits on the target's LAN; it sends the packet for you.</p>
    <p class="err" hidden></p>
    <div class="modal-actions"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`;
  document.body.append(el);
  const form = el.querySelector("form")!;
  const err = el.querySelector<HTMLElement>(".err")!;
  const done = () => el.remove();
  el.addEventListener("click", (e) => (((e.target as HTMLElement).dataset.r === "0" || e.target === el) && done()));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const mac = String(f.get("mac") ?? "").trim();
    if (!MAC.test(mac)) {
      err.hidden = false;
      err.textContent = "Enter a MAC address like AA:BB:CC:DD:EE:FF";
      return;
    }
    try {
      await api.wolSave({
        id: d?.id ?? "",
        name: String(f.get("name") ?? "").trim(),
        mac,
        broadcast: String(f.get("broadcast") ?? "").trim(),
        port: Number(f.get("port")) || 9,
        relay: String(f.get("relay") ?? ""),
        updatedAt: 0,
        deleted: false,
      });
      done();
      await ctx.changed();
      toast("Saved", "ok");
    } catch (x) {
      err.hidden = false;
      err.textContent = String(x);
    }
  });
  requestAnimationFrame(() => form.querySelector<HTMLInputElement>("input[name=name]")?.focus());
}

/** Clicks on the Wake on LAN page (the page root persists across renders). */
export function bindWol(root: HTMLElement, ctx: WolCtx, active: () => boolean) {
  root.addEventListener("click", async (e) => {
    if (!active()) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-wol]");
    if (!b) return;
    const card = b.closest<HTMLElement>("[data-wol-id]");
    const d = card ? devices.find((x) => x.id === card.dataset.wolId) : undefined;
    switch (b.dataset.wol) {
      case "new":
        return deviceForm(ctx, null);
      case "edit":
        return d && deviceForm(ctx, d);
      case "send":
        return d && wake(ctx, d);
      case "delete":
        if (d && (await confirmDialog(`Delete ${d.name}?`, "It will be removed from all synced devices."))) {
          await api.wolDelete(d.id);
          await ctx.changed();
          await load(ctx);
        }
        return;
      case "os":
        os = b.dataset.os as OsKey;
        return ctx.rerender();
      case "copy":
        return api.clipboardWrite(b.dataset.cmd!).then(() => toast("Command copied", "ok"));
    }
  });
}
