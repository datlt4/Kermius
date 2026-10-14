// VNC tab: noVNC rendering, with the RFB byte stream carried over Tauri IPC instead of a WebSocket.
import { Channel } from "@tauri-apps/api/core";
import { api, type Host, type Status } from "./api";
import { esc, toast } from "./ui";

/** WebSocket-shaped channel noVNC can attach to (it checks these properties exist). */
class IpcChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = "connecting";
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  private sid = "";

  async open(hostId: string, onEnd: (message: string) => void) {
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (d) => this.onmessage?.(new MessageEvent("message", { data: d }));
    const status = new Channel<Status>();
    status.onmessage = (s) => {
      if (s.type !== "closed" && s.type !== "error") return;
      this.end(s.type === "error" ? s.message : "");
      onEnd(s.type === "error" ? s.message : "");
    };
    this.sid = await api.vncOpen(hostId, data, status);
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  send(d: ArrayBuffer | Uint8Array) {
    // Copy: noVNC reuses its send buffer.
    if (this.sid) api.sessionWrite(this.sid, new Uint8Array(d instanceof Uint8Array ? d : new Uint8Array(d)));
  }

  close() {
    if (this.sid) api.sshClose(this.sid);
    this.end("");
  }

  private end(reason: string) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.(new CloseEvent("close", { code: 1000, reason, wasClean: !reason }));
  }
}

type Rfb = {
  scaleViewport: boolean;
  background: string;
  resizeSession: boolean;
  disconnect(): void;
  sendCredentials(c: { password?: string; username?: string }): void;
  sendCtrlAltDel(): void;
  focus(): void;
  addEventListener(t: string, f: (e: CustomEvent) => void): void;
};

export class VncTab {
  readonly id = crypto.randomUUID();
  readonly el = document.createElement("div");
  readonly kind = "vnc";
  readonly local = false;
  state = "connecting";
  private rfb: Rfb | null = null;
  private channel: IpcChannel | null = null;

  constructor(public host: Host, private onChange: () => void, private onClose: (t: VncTab) => void) {
    this.el.className = "session vnc";
    this.el.innerHTML = `<div class="vnc-screen"></div>
      <div class="sess-tools"><button data-v="cad" title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button>
        <button data-v="scale" class="on" title="Fit the remote screen to the window">Fit</button></div>
      <div class="overlay"></div>`;
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const v = t.closest<HTMLElement>("[data-v]")?.dataset.v;
      if (v === "cad") this.rfb?.sendCtrlAltDel();
      else if (v === "scale" && this.rfb) {
        this.rfb.scaleViewport = !this.rfb.scaleViewport;
        t.closest("button")!.classList.toggle("on", this.rfb.scaleViewport);
      }
      const o = t.closest<HTMLElement>("[data-o]")?.dataset.o;
      if (o === "retry") this.connect();
      else if (o === "close") this.onClose(this);
    });
  }

  mount(parent: HTMLElement) {
    parent.append(this.el);
    this.connect();
  }

  async connect() {
    this.rfb?.disconnect();
    this.channel?.close();
    this.setState("connecting");
    const screen = this.el.querySelector<HTMLElement>(".vnc-screen")!;
    screen.innerHTML = "";
    try {
      // Loaded on first use: noVNC is only needed for VNC tabs.
      const { default: RFB } = await import("@novnc/novnc");
      const channel = new IpcChannel();
      this.channel = channel;
      await channel.open(this.host.id, (msg) => msg && this.setState("error", msg));
      const rfb = new RFB(screen, channel) as unknown as Rfb;
      this.rfb = rfb;
      rfb.scaleViewport = this.el.querySelector('[data-v="scale"]')!.classList.contains("on");
      rfb.background = "#0b0d12";
      rfb.addEventListener("connect", () => {
        this.setState("connected");
        rfb.focus();
      });
      rfb.addEventListener("disconnect", (e) => {
        if (this.rfb !== rfb) return;
        if (e.detail?.clean) this.setState("closed");
        else if (this.state !== "error") this.setState("error", "Connection lost");
      });
      rfb.addEventListener("credentialsrequired", async (e) => {
        const types: string[] = e.detail?.types ?? ["password"];
        const password = await api.vncPassword(this.host.id).catch(() => "");
        if (!password) return this.setState("error", "This VNC server needs a password: set it in the host's settings");
        rfb.sendCredentials({ password, ...(types.includes("username") ? { username: this.host.username } : {}) });
      });
      rfb.addEventListener("securityfailure", (e) => this.setState("error", `Authentication failed${e.detail?.reason ? `: ${e.detail.reason}` : ""}`));
    } catch (e) {
      this.setState("error", String(e));
    }
  }

  private setState(s: string, message = "") {
    this.state = s;
    const ov = this.el.querySelector<HTMLElement>(".overlay")!;
    ov.className = `overlay ${s === "connected" ? "" : s}`;
    const port = this.host.port || 5900;
    ov.innerHTML =
      s === "connecting"
        ? `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="muted">VNC · ${esc(this.host.address)}:${port}</p><div class="progress"><i></i></div></div>`
        : s === "connected"
          ? ""
          : `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="${s === "error" ? "err" : "muted"}">${esc(message || "Disconnected")}</p>
             <div class="row"><button class="btn primary" data-o="retry">Reconnect</button><button class="btn ghost" data-o="close">Close</button></div></div>`;
    this.onChange();
  }

  show() {
    this.el.hidden = false;
    this.rfb?.focus();
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
    const rfb = this.rfb;
    this.rfb = null;
    rfb?.disconnect();
    this.channel?.close();
    this.el.remove();
  }
}
