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
  /** Bytes received, and the latest TCP round-trip time (µs, 0 = unknown). */
  received = 0;
  rtt = 0;

  async open(hostId: string, onEnd: (message: string) => void) {
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (d) => {
      this.received += d.byteLength;
      this.onmessage?.(new MessageEvent("message", { data: d }));
    };
    const status = new Channel<Status>();
    status.onmessage = (s) => {
      if (s.type === "rtt") this.rtt = s.micros;
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

/** noVNC private fields used for stats (checked before use; noVNC is pinned to 1.7). */
type RfbInternals = {
  _display?: { flip?: (...a: unknown[]) => unknown };
  _handleDataRect?: () => boolean;
  _FBU?: { encoding: number };
  _fbWidth: number;
  _fbHeight: number;
};

/** RFB encoding numbers → names (data rectangles only). */
const ENCODINGS: Record<number, string> = { 0: "Raw", 1: "CopyRect", 2: "RRE", 5: "Hextile", 6: "Zlib", 7: "Tight", 16: "ZRLE", 21: "JPEG", 50: "H.264", [-260]: "TightPNG" };

const fmtRate = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${(b / 1024).toFixed(0)} KB/s`);

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
      <div class="vnc-stats" ${localStorage.getItem("kermius.vncStats") === "0" ? "hidden" : ""}></div>
      <div class="sess-tools"><button data-v="cad" title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button>
        <button data-v="scale" class="on" title="Fit the remote screen to the window">Fit</button>
        <button data-v="stats" class="${localStorage.getItem("kermius.vncStats") === "0" ? "" : "on"}" title="Frame rate, latency and encoding">Stats</button></div>
      <div class="overlay"></div>`;
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const v = t.closest<HTMLElement>("[data-v]")?.dataset.v;
      if (v === "cad") this.rfb?.sendCtrlAltDel();
      else if (v === "stats") {
        const box = this.el.querySelector<HTMLElement>(".vnc-stats")!;
        box.hidden = !box.hidden;
        t.closest("button")!.classList.toggle("on", !box.hidden);
        localStorage.setItem("kermius.vncStats", box.hidden ? "0" : "1");
      } else if (v === "scale" && this.rfb) {
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
      this.watchStats(rfb as unknown as RfbInternals, channel);
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

  private statsTimer = 0;

  /** FPS = completed framebuffer updates per second; encodings = rectangle encodings seen. Uses noVNC 1.7 internals. */
  private watchStats(rfb: RfbInternals, channel: IpcChannel) {
    clearInterval(this.statsTimer);
    let frames = 0;
    const seen = new Map<string, number>();
    const display = rfb._display;
    if (display?.flip) {
      const flip = display.flip.bind(display);
      display.flip = (...a: unknown[]) => {
        frames++;
        return flip(...a);
      };
    }
    if (rfb._handleDataRect) {
      const handle = rfb._handleDataRect.bind(rfb);
      rfb._handleDataRect = () => {
        const name = ENCODINGS[rfb._FBU?.encoding ?? NaN] ?? `#${rfb._FBU?.encoding}`;
        seen.set(name, (seen.get(name) ?? 0) + 1);
        return handle();
      };
    }
    let last = { t: performance.now(), bytes: channel.received };
    let codec = "";
    this.statsTimer = window.setInterval(() => {
      const box = this.el.querySelector<HTMLElement>(".vnc-stats");
      if (!box || this.rfb !== (rfb as unknown as Rfb)) return clearInterval(this.statsTimer);
      const now = performance.now();
      const secs = (now - last.t) / 1000;
      const fps = frames / secs;
      const rate = (channel.received - last.bytes) / secs;
      // Most used encoding over the last second (kept while the screen is idle).
      if (seen.size) codec = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 2).join(" + ");
      frames = 0;
      seen.clear();
      last = { t: now, bytes: channel.received };
      const rtt = channel.rtt ? `${(channel.rtt / 1000).toFixed(channel.rtt < 10_000 ? 1 : 0)} ms` : "n/a";
      box.innerHTML = `<span><b>${fps.toFixed(0)}</b> fps</span><span>RTT <b>${rtt}</b></span><span>${esc(codec || "—")}</span>
        <span>${rfb._fbWidth}×${rfb._fbHeight}</span><span>${fmtRate(rate)}</span>`;
    }, 1000);
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
    clearInterval(this.statsTimer);
    const rfb = this.rfb;
    this.rfb = null;
    rfb?.disconnect();
    this.channel?.close();
    this.el.remove();
  }
}
