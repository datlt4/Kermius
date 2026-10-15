// VNC tab: noVNC rendering, with the RFB byte stream carried over Tauri IPC instead of a WebSocket.
import { Channel } from "@tauri-apps/api/core";
import { api, type Host, type Status } from "./api";
import { esc, toast } from "./ui";

const coarse = matchMedia("(pointer: coarse)").matches;

/** WebSocket-shaped channel noVNC can attach to (it checks these properties exist). */
class IpcChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = "connecting";
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  private sid = "";
  /** Bytes received, and the latest TCP round-trip time (µs, 0 = unknown). */
  received = 0;
  sent = 0;
  rtt = 0;
  /** Called with the first bytes from the server (its protocol greeting). */
  onFirstData: ((d: ArrayBuffer) => void) | null = null;

  /** Data that arrived before noVNC attached (servers greet immediately). */
  private early: ArrayBuffer[] = [];
  private handler: ((e: MessageEvent) => void) | null = null;

  get onmessage() {
    return this.handler;
  }

  set onmessage(f: ((e: MessageEvent) => void) | null) {
    this.handler = f;
    if (!f || !this.early.length) return;
    // After noVNC finishes attaching (it opens the protocol state right after setting the handler);
    // data arriving meanwhile is queued behind, keeping the order.
    setTimeout(() => {
      const queued = this.early;
      this.early = [];
      queued.forEach((d) => this.handler?.(new MessageEvent("message", { data: d })));
    });
  }

  async open(hostId: string, onEnd: (message: string) => void) {
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (d) => {
      if (!this.received) this.onFirstData?.(d);
      this.received += d.byteLength;
      if (this.handler && !this.early.length) this.handler(new MessageEvent("message", { data: d }));
      else this.early.push(d);
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
    this.sent += d.byteLength;
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
  _fbName?: string;
  _rfbInitState?: string;
};

/** RFB encoding numbers → names (data rectangles only). */
const ENCODINGS: Record<number, string> = { 0: "Raw", 1: "CopyRect", 2: "RRE", 5: "Hextile", 6: "Zlib", 7: "Tight", 16: "ZRLE", 21: "JPEG", 50: "H.264", [-260]: "TightPNG" };

/** noVNC internals used for touch input and zoom (pinned noVNC 1.7). */
type RfbTouch = {
  _canvas: HTMLCanvasElement;
  _screen: HTMLElement;
  _gestures?: { detach(): void };
  _sendMouse(x: number, y: number, mask: number): void;
  _updateScale(): void;
  clipViewport: boolean;
  _display: {
    scale: number;
    width: number;
    height: number;
    _viewportLoc: { x: number; y: number; w: number; h: number };
    absX(x: number): number;
    absY(y: number): number;
    viewportChangeSize(w: number, h: number): void;
    viewportChangePos(dx: number, dy: number): void;
  };
};

const LEFT = 1;
const RIGHT = 4;
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;

/**
 * Touch input for VNC (replaces noVNC's tap-to-click gestures):
 * one finger moves the pointer, double tap = left click, double tap + hold + drag = left drag,
 * long press (0.7 s) = right click, pinch = zoom, two fingers = pan when zoomed (scroll otherwise),
 * and a finger near an edge pans the zoomed view that way. Returns { fit, dispose }.
 */
function touchInput(rfb: RfbTouch) {
  rfb._gestures?.detach();
  rfb.clipViewport = true;
  const d = rfb._display;
  const screen = rfb._screen;
  let zoom = 1;

  const screenRect = () => screen.getBoundingClientRect();
  const applyZoom = () => {
    const r = screenRect();
    if (!d.width || !r.width) return;
    const s = Math.min(r.width / d.width, r.height / d.height) * zoom;
    d.scale = s;
    d.viewportChangeSize(r.width / s, r.height / s);
    d.viewportChangePos(0, 0);
  };
  // noVNC resets the scale on every resize; put the zoom back afterwards.
  const updateScale = rfb._updateScale.bind(rfb);
  rfb._updateScale = () => {
    updateScale();
    applyZoom();
  };
  applyZoom();

  const local = (cx: number, cy: number) => {
    const r = rfb._canvas.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };
  let mask = 0;
  let pointer = { x: 0, y: 0 }; // last finger position (client coordinates)
  const move = (cx: number, cy: number, m = mask) => {
    pointer = { x: cx, y: cy };
    const p = local(cx, cy);
    rfb._sendMouse(p.x, p.y, m);
  };
  const click = (cx: number, cy: number, button: number) => {
    move(cx, cy, 0);
    move(cx, cy, button);
    move(cx, cy, 0);
  };

  // Edge pan: while a finger rests near an edge of the zoomed view, scroll that way.
  let edgeRaf = 0;
  const edgeStep = () => {
    edgeRaf = 0;
    if (zoom <= 1) return;
    const r = screenRect();
    const zone = 44;
    const speed = (dist: number) => (dist < zone ? ((zone - dist) / zone) * 18 : 0);
    const dx = speed(pointer.x - r.left) ? -speed(pointer.x - r.left) : speed(r.right - pointer.x);
    const dy = speed(pointer.y - r.top) ? -speed(pointer.y - r.top) : speed(r.bottom - pointer.y);
    if (!dx && !dy) return;
    d.viewportChangePos(dx / d.scale, dy / d.scale);
    move(pointer.x, pointer.y); // the pointer (and a drag) follows the moving view
    edgeRaf = requestAnimationFrame(edgeStep);
  };
  const edgeWatch = () => {
    if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeStep);
  };
  const edgeStop = () => {
    cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
  };

  let start = { x: 0, y: 0, t: 0 };
  let lastTap = { x: -999, y: -999, t: 0 };
  let moved = false;
  let longPress = 0;
  let longDone = false;
  let pinch: { dist: number; zoom: number; fbx: number; fby: number; mx: number; my: number } | null = null;
  let scrollAcc = 0;

  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  const onStart = (e: TouchEvent) => {
    e.preventDefault(); // no emulated mouse events (they would click)
    clearTimeout(longPress);
    if (e.touches.length === 2) {
      if (mask) move(pointer.x, pointer.y, (mask = 0));
      const m = mid(e.touches);
      const p = local(m.x, m.y);
      pinch = { dist: dist(e.touches), zoom, fbx: p.x / d.scale + d._viewportLoc.x, fby: p.y / d.scale + d._viewportLoc.y, mx: m.x, my: m.y };
      scrollAcc = 0;
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, t: Date.now() };
    moved = false;
    longDone = false;
    if (Date.now() - lastTap.t < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
      // Second tap: press now; releasing makes a click, moving first makes a drag.
      lastTap.t = 0;
      move(t.clientX, t.clientY, 0);
      move(t.clientX, t.clientY, (mask = LEFT));
      return;
    }
    longPress = window.setTimeout(() => {
      longDone = true;
      click(start.x, start.y, RIGHT);
    }, 700);
  };

  const onMove = (e: TouchEvent) => {
    e.preventDefault();
    if (pinch && e.touches.length === 2) {
      const m = mid(e.touches);
      const z = Math.min(6, Math.max(1, (pinch.zoom * dist(e.touches)) / pinch.dist));
      if (z === 1 && pinch.zoom === 1) {
        // Not zoomed: two fingers scroll the remote screen.
        scrollAcc += m.y - pinch.my;
        pinch.my = m.y;
        while (Math.abs(scrollAcc) >= 30) {
          const b = scrollAcc > 0 ? WHEEL_UP : WHEEL_DOWN;
          click(m.x, m.y, b);
          scrollAcc -= Math.sign(scrollAcc) * 30;
        }
        return;
      }
      zoom = z;
      applyZoom();
      // Keep the remote point that was under the fingers' midpoint under it.
      const r = rfb._canvas.getBoundingClientRect();
      d.viewportChangePos(pinch.fbx - (m.x - r.left) / d.scale - d._viewportLoc.x, pinch.fby - (m.y - r.top) / d.scale - d._viewportLoc.y);
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!moved && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) {
      moved = true;
      clearTimeout(longPress);
    }
    if (!moved || longDone) return;
    move(t.clientX, t.clientY);
    edgeWatch();
  };

  const onEnd = (e: TouchEvent) => {
    e.preventDefault();
    clearTimeout(longPress);
    if (e.touches.length) return;
    edgeStop();
    if (pinch) {
      pinch = null;
      return;
    }
    if (mask) {
      move(pointer.x, pointer.y, (mask = 0)); // ends the click or the drag
      return;
    }
    if (!moved && !longDone && Date.now() - start.t < 300) lastTap = { x: start.x, y: start.y, t: Date.now() };
  };

  const opts = { passive: false } as const;
  screen.addEventListener("touchstart", onStart, opts);
  screen.addEventListener("touchmove", onMove, opts);
  screen.addEventListener("touchend", onEnd, opts);
  screen.addEventListener("touchcancel", onEnd, opts);
  return {
    fit() {
      zoom = 1;
      applyZoom();
    },
    dispose() {
      edgeStop();
      clearTimeout(longPress);
    },
  };
}

const fmtRate = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${(b / 1024).toFixed(0)} KB/s`);

type Rfb = {
  viewOnly: boolean;
  clipboardPasteFrom(text: string): void;
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
        <button data-v="control" class="${host.viewOnly ? "" : "on"}" title="Send mouse and keyboard to the remote (off = view only)">Control</button>
        <button data-v="scale" class="on" title="Fit the remote screen to the window">Fit</button>
        <button data-v="stats" class="${localStorage.getItem("kermius.vncStats") === "0" ? "" : "on"}" title="Frame rate, latency and encoding">Stats</button></div>
      <div class="overlay"></div>`;
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const v = t.closest<HTMLElement>("[data-v]")?.dataset.v;
      if (v === "cad") this.rfb?.sendCtrlAltDel();
      else if (v === "control" && this.rfb) {
        this.rfb.viewOnly = !this.rfb.viewOnly;
        t.closest("button")!.classList.toggle("on", !this.rfb.viewOnly);
      } else if (v === "stats") {
        const box = this.el.querySelector<HTMLElement>(".vnc-stats")!;
        box.hidden = !box.hidden;
        t.closest("button")!.classList.toggle("on", !box.hidden);
        localStorage.setItem("kermius.vncStats", box.hidden ? "0" : "1");
      } else if (v === "scale" && this.touch) this.touch.fit();
      else if (v === "scale" && this.rfb) {
        this.rfb.scaleViewport = !this.rfb.scaleViewport;
        t.closest("button")!.classList.toggle("on", this.rfb.scaleViewport);
      }
      const o = t.closest<HTMLElement>("[data-o]")?.dataset.o;
      if (o === "retry") this.connect();
      else if (o === "logs") {
        localStorage.setItem("kermius.showLogs", localStorage.getItem("kermius.showLogs") === "1" ? "" : "1");
        this.setState(this.state, this.el.querySelector(".ov-card .err")?.textContent ?? "");
      }
      else if (o === "close") this.onClose(this);
    });
  }

  mount(parent: HTMLElement) {
    parent.append(this.el);
    addEventListener("focus", this.onFocus);
    this.connect();
  }

  async connect() {
    this.rfb?.disconnect();
    this.channel?.close();
    clearInterval(this.stepTimer);
    this.logs = [];
    this.setState("connecting");
    this.addLog(`Connecting to ${this.host.address}:${this.host.port || 5900}`);
    const screen = this.el.querySelector<HTMLElement>(".vnc-screen")!;
    screen.innerHTML = "";
    try {
      // Loaded on first use: noVNC is only needed for VNC tabs.
      const { default: RFB } = await import("@novnc/novnc");
      const channel = new IpcChannel();
      this.channel = channel;
      channel.onFirstData = (d) => {
        const head = new TextDecoder().decode(new Uint8Array(d.slice(0, 12))).trim();
        this.addLog(head.startsWith("RFB") ? `Server greeting: ${head}` : `Server sent ${d.byteLength} bytes that are not a VNC greeting`);
      };
      await channel.open(this.host.id, (msg) => {
        this.addLog(msg ? `Connection error: ${msg}` : "Server closed the connection");
        if (msg) this.setState("error", msg);
      });
      this.addLog("TCP connection open");
      const rfb = new RFB(screen, channel) as unknown as Rfb;
      this.rfb = rfb;
      this.watchSteps(rfb as unknown as RfbInternals, channel);
      this.touch?.dispose();
      this.touch = null;
      if (coarse) this.touch = touchInput(rfb as unknown as RfbTouch);
      else rfb.scaleViewport = this.el.querySelector('[data-v="scale"]')!.classList.contains("on");
      rfb.background = "#0b0d12";
      rfb.viewOnly = !this.el.querySelector('[data-v="control"]')!.classList.contains("on");
      if (!this.host.noClipboard) {
        // Remote copy → local clipboard; local clipboard → remote when this tab gets focus.
        rfb.addEventListener("clipboard", (e) => {
          const text = String(e.detail?.text ?? "");
          this.lastClip = text;
          if (text) api.clipboardWrite(text);
        });
      }
      this.watchStats(rfb as unknown as RfbInternals, channel);
      rfb.addEventListener("connect", () => {
        const r = rfb as unknown as RfbInternals;
        this.addLog(`Connected: ${r._fbWidth}×${r._fbHeight}${r._fbName ? ` "${r._fbName}"` : ""}`);
        this.setState("connected");
        rfb.focus();
        this.sendClipboard();
      });
      rfb.addEventListener("disconnect", (e) => {
        if (this.rfb !== rfb) return;
        this.addLog(e.detail?.clean ? "Disconnected" : "Connection lost");
        if (e.detail?.clean) this.setState("closed");
        else if (this.state !== "error") this.setState("error", "Connection lost");
      });
      rfb.addEventListener("credentialsrequired", async (e) => {
        const types: string[] = e.detail?.types ?? ["password"];
        this.addLog(`Server asks for: ${types.join(", ")}`);
        const password = await api.vncPassword(this.host.id).catch(() => "");
        if (!password) return this.setState("error", "This VNC server needs a password: set it in the host's settings");
        rfb.sendCredentials({ password, ...(types.includes("username") ? { username: this.host.username } : {}) });
      });
      rfb.addEventListener("securityfailure", (e) => {
        this.addLog(`Security failure${e.detail?.reason ? `: ${e.detail.reason}` : ""}`);
        this.setState("error", `Authentication failed${e.detail?.reason ? `: ${e.detail.reason}` : ""}`);
      });
    } catch (e) {
      this.addLog(`Error: ${e}`);
      this.setState("error", String(e));
    }
  }

  private statsTimer = 0;
  private touch: ReturnType<typeof touchInput> | null = null;
  private stepTimer = 0;
  private logs: string[] = [];

  private addLog(line: string) {
    const t = new Date().toLocaleTimeString();
    this.logs.push(`${t}  ${line}`);
    const list = this.el.querySelector(".logs");
    if (list) {
      list.insertAdjacentHTML("beforeend", `<div>${esc(this.logs[this.logs.length - 1])}</div>`);
      list.scrollTop = list.scrollHeight;
    }
  }

  private logsHtml() {
    const open = localStorage.getItem("kermius.showLogs") === "1";
    return `<button class="btn ghost sm" data-o="logs">${open ? "Hide logs" : "Show logs"}</button>
      ${open ? `<div class="logs">${this.logs.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}`;
  }

  /** Log handshake steps (noVNC 1.7 internal state) and, while stuck, the byte counts. */
  private watchSteps(rfb: RfbInternals, channel: IpcChannel) {
    const names: Record<string, string> = {
      ProtocolVersion: "Exchanging protocol versions",
      Security: "Choosing a security type",
      Authentication: "Authenticating",
      SecurityResult: "Waiting for the authentication result",
      SecurityReason: "Server refused the connection",
      ClientInitialisation: "Sending client settings",
      ServerInitialisation: "Waiting for the desktop size and name",
    };
    let last = "";
    let since = Date.now();
    clearInterval(this.stepTimer);
    this.stepTimer = window.setInterval(() => {
      if (this.state !== "connecting") return clearInterval(this.stepTimer);
      const step = rfb._rfbInitState ?? "";
      if (step && step !== last) {
        last = step;
        since = Date.now();
        this.addLog(names[step] ?? step);
      } else if (Date.now() - since > 5000) {
        since = Date.now();
        this.addLog(`Still waiting (${names[last] ?? "starting"}): received ${channel.received} B, sent ${channel.sent} B`);
      }
    }, 200);
  }
  private lastClip = "";

  /** Push the local clipboard to the remote if it changed since we last saw it. */
  private sendClipboard() {
    // noVNC drops clipboard messages until the session is up.
    if (this.host.noClipboard || !this.rfb || this.state !== "connected") return;
    api.clipboardRead().then((text) => {
      if (text && text !== this.lastClip && this.rfb) {
        this.lastClip = text;
        this.rfb.clipboardPasteFrom(text);
      }
    }, () => {});
  }

  private onFocus = () => !this.el.hidden && this.sendClipboard();

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
    // Not the terminal's "closed" bar: a centred card that takes clicks.
    ov.className = `overlay ${s === "connected" ? "" : s === "connecting" ? "connecting" : "error"}`;
    this.el.classList.toggle("live", s === "connected");
    const port = this.host.port || 5900;
    ov.innerHTML =
      s === "connecting"
        ? `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="muted">VNC · ${esc(this.host.address)}:${port}</p><div class="progress"><i></i></div>
            ${this.logsHtml()}</div>`
        : s === "connected"
          ? ""
          : `<div class="ov-card"><h3>${esc(this.host.name)}</h3><p class="${s === "error" ? "err" : "muted"}">${esc(message || "Disconnected")}</p>
             <div class="row"><button class="btn primary" data-o="retry">Reconnect</button><button class="btn ghost" data-o="close">Close</button></div>
             ${this.logsHtml()}</div>`;
    this.onChange();
  }

  show() {
    this.el.hidden = false;
    this.rfb?.focus();
    this.sendClipboard();
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
    this.touch?.dispose();
    clearInterval(this.statsTimer);
    clearInterval(this.stepTimer);
    removeEventListener("focus", this.onFocus);
    const rfb = this.rfb;
    this.rfb = null;
    rfb?.disconnect();
    this.channel?.close();
    this.el.remove();
  }
}
