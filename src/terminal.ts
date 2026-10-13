import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, type Host, type Status } from "./api";
import { contextMenu, esc, hue, icon, toast } from "./ui";

export const termTheme = {
  background: "#14161d",
  foreground: "#e3e6ee",
  cursor: "#5b8cff",
  cursorAccent: "#14161d",
  selectionBackground: "#5b8cff88",
  selectionInactiveBackground: "#5b8cff55",
  black: "#1f232d", red: "#ff5c72", green: "#4ade80", yellow: "#f5c84c",
  blue: "#5b8cff", magenta: "#c084fc", cyan: "#2dd4bf", white: "#d4d7e0",
  brightBlack: "#5c6375", brightRed: "#ff8094", brightGreen: "#7ee8a6", brightYellow: "#ffdc7a",
  brightBlue: "#86a8ff", brightMagenta: "#d6a8ff", brightCyan: "#6ee7d6", brightWhite: "#ffffff",
};

export interface TermPrefs {
  fontFamily: string;
  fontSize: number;
}

export function loadPrefs(): TermPrefs {
  const d: TermPrefs = { fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace', fontSize: 14 };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem("kermius.term") || "{}") };
  } catch {
    return d;
  }
}

export type SessionState = "connecting" | "connected" | "closed" | "error";

const coarse = matchMedia("(pointer: coarse)").matches;

export class Session {
  readonly id = crypto.randomUUID();
  readonly el = document.createElement("div");
  state: SessionState = "connecting";
  private sid: string | null = null;
  private term: Terminal;
  private fit = new FitAddon();
  private overlay: HTMLElement;
  private error = "";
  private ctrl = false;
  private resizeTimer = 0;

  constructor(public host: Host, private onChange: () => void, private onClose: (s: Session) => void) {
    const prefs = loadPrefs();
    this.term = new Terminal({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: termTheme,
    });
    this.el.className = "session";
    this.el.innerHTML = `<div class="term"></div><div class="overlay"></div>${
      coarse ? `<div class="keybar">${["Esc", "Tab", "Ctrl", "↑", "↓", "←", "→", "|", "/", "-", "~"].map((k) => `<button data-k="${k}">${k}</button>`).join("")}</div>` : ""
    }`;
    this.overlay = this.el.querySelector(".overlay")!;
  }

  mount(parent: HTMLElement) {
    parent.append(this.el);
    const t = this.term;
    t.loadAddon(this.fit);
    t.loadAddon(new WebLinksAddon());
    t.open(this.el.querySelector(".term")!);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      t.loadAddon(gl);
    } catch {
      /* falls back to DOM renderer */
    }
    // WebKitGTK + IBus/Fcitx (e.g. Vietnamese Telex) delivers a committed IME word twice:
    // once via the input event and once via xterm's compositionend handler. Drop the repeat.
    let commit = "";
    let commitSent = false;
    let commitUntil = 0;
    let last = { d: "", t: 0 };
    t.textarea!.addEventListener("compositionend", (e) => {
      commit = e.data;
      commitUntil = performance.now() + 150;
      commitSent = last.d === commit && performance.now() - last.t < 150;
    });
    t.onData((d) => {
      const now = performance.now();
      if (commit && d === commit && now < commitUntil) {
        if (commitSent) return void (commit = "");
        commitSent = true;
      }
      last = { d, t: now };
      this.send(d);
    });
    t.onBinary((d) => this.send(d));
    t.onResize(({ cols, rows }) => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.sid && api.sshResize(this.sid, cols, rows), 60);
    });
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      // App shortcuts (handled globally) must not reach the shell.
      if (e.key === "Tab" || (!e.shiftKey && /^Digit[1-9]$/.test(e.code))) return false;
      if (!e.shiftKey) return true;
      if (e.code === "KeyC") return this.copySelection(), false;
      if (e.code === "KeyV") return this.paste(), false;
      return !["KeyK", "KeyT", "KeyW", "KeyF"].includes(e.code);
    });
    this.el.querySelector(".term")!.addEventListener("contextmenu", (e) => {
      const ev = e as MouseEvent;
      ev.preventDefault();
      contextMenu(ev.clientX, ev.clientY, [
        { label: "Copy", icon: "copy", action: () => this.copySelection() },
        { label: "Paste", icon: "import", action: () => this.paste() },
        { label: "Copy password", icon: "key", action: () => this.copyPassword() },
        "-",
        { label: "Clear", icon: "x", action: () => t.clear() },
      ]);
    });
    this.el.querySelector(".keybar")?.addEventListener("click", (e) => {
      const k = (e.target as HTMLElement).dataset.k;
      if (!k) return;
      const map: Record<string, string> = { Esc: "\x1b", Tab: "\t", "↑": "\x1b[A", "↓": "\x1b[B", "→": "\x1b[C", "←": "\x1b[D" };
      if (k === "Ctrl") {
        this.ctrl = !this.ctrl;
        (e.target as HTMLElement).classList.toggle("on", this.ctrl);
      } else this.send(map[k] ?? k);
      t.focus();
    });
    this.overlay.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("button")?.dataset.a;
      if (a === "retry") this.connect();
      else if (a === "trust") api.trustNewHostKey(this.host.id).then(() => this.connect());
      else if (a === "close") this.onClose(this);
    });
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.el.offsetParent && this.fit.fit());
    }).observe(this.el);
    this.fit.fit();
    this.connect();
  }

  private send(d: string) {
    if (!this.sid || this.state !== "connected") return;
    if (this.ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c & 31);
      this.ctrl = false;
      this.el.querySelector('.keybar [data-k="Ctrl"]')?.classList.remove("on");
    }
    api.sshWrite(this.sid, d);
  }

  async connect() {
    if (this.sid) api.sshClose(this.sid);
    this.sid = null;
    this.setState("connecting");
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (d) => this.term.write(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as unknown as number[]));
    const onStatus = new Channel<Status>();
    onStatus.onmessage = (s) => {
      if (s.type === "connected") {
        this.setState("connected");
        this.term.focus();
      } else if (s.type === "closed") this.setState("closed");
      else {
        this.error = s.message;
        this.setState("error");
      }
    };
    try {
      this.sid = await api.sshConnect(this.host.id, this.term.cols, this.term.rows, onData, onStatus);
    } catch (e) {
      this.error = String(e);
      this.setState("error");
    }
  }

  private setState(s: SessionState) {
    this.state = s;
    const h = this.host;
    const avatar = `<div class="avatar lg" style="--h:${hue(h.folder || h.name)}">${icon("server", 26)}</div>`;
    const target = `${esc(h.username)}@${esc(h.address)}:${h.port}`;
    this.overlay.className = `overlay ${s}`;
    if (s === "connecting") {
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3><p class="muted">${target}</p><div class="progress"><i></i></div></div>`;
    } else if (s === "error") {
      const mismatch = this.error.startsWith("HOSTKEY_MISMATCH");
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3><p class="muted">${target}</p>
        <p class="err">${esc(this.error.replace(/^HOSTKEY_MISMATCH: /, "⚠ "))}</p>
        <div class="row">${mismatch ? `<button class="btn danger" data-a="trust">Trust new key</button>` : ""}
        <button class="btn primary" data-a="retry">Retry</button><button class="btn ghost" data-a="close">Close</button></div></div>`;
    } else if (s === "closed") {
      this.overlay.innerHTML = `<div class="ov-bar"><span>Connection closed</span><button class="btn primary sm" data-a="retry">Reconnect</button><button class="btn ghost sm" data-a="close">Close tab</button></div>`;
    } else this.overlay.innerHTML = "";
    this.onChange();
  }

  private copySelection() {
    const s = this.term.getSelection();
    if (s) api.clipboardWrite(s).then(() => toast("Copied", "ok"));
  }

  private async paste() {
    const text = await api.clipboardRead().catch(() => "");
    if (text) this.term.paste(text);
  }

  copyPassword() {
    api.copyPassword(this.host.id).then(
      () => toast("Password copied", "ok"),
      (e) => toast(String(e), "err"),
    );
  }

  show() {
    this.el.hidden = false;
    requestAnimationFrame(() => {
      this.fit.fit();
      this.term.focus();
    });
  }

  hide() {
    this.el.hidden = true;
  }

  applyPrefs(p: TermPrefs) {
    this.term.options.fontFamily = p.fontFamily;
    this.term.options.fontSize = p.fontSize;
    if (!this.el.hidden) this.fit.fit();
  }

  dispose() {
    if (this.sid) api.sshClose(this.sid);
    this.term.dispose();
    this.el.remove();
  }
}
