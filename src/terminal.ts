import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import { api, Channel, emptyHost, type Host, type Status } from "./api";
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

export const BUILTIN_FONTS = ["JetBrains Mono", "Fira Code", "Source Code Pro"];

export function loadPrefs(): TermPrefs {
  const d: TermPrefs = { fontFamily: "JetBrains Mono", fontSize: 14 };
  try {
    const p = { ...d, ...JSON.parse(localStorage.getItem("kermius.term") || "{}") };
    if (p.fontFamily.includes(",")) p.fontFamily = d.fontFamily; // old free-text font list
    return p;
  } catch {
    return d;
  }
}

/** CSS font stack: chosen font, then a bundled one (has Vietnamese glyphs). */
export const fontStack = (family: string) => `"${family}", "JetBrains Mono", monospace`;

export const loadFont = (p: TermPrefs) =>
  Promise.all([400, 700].map((w) => document.fonts.load(`${w} ${p.fontSize}px "${p.fontFamily}"`))).catch(() => {});

// WebKitGTK's WebGL text is grayscale-AA and looks blurry next to native text; use DOM there.
const useWebgl = !/Linux/.test(navigator.userAgent) || /Android/.test(navigator.userAgent);

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
  private logs: string[] = [];
  private gen = 0;
  // Auto-reconnect backoff (seconds); the last value repeats.
  private static readonly DELAYS = [5, 10, 15, 20, 25, 30, 60];
  private retryStep = 0;
  private retryAt = 0;
  private retryTimer = 0;
  private tickTimer = 0;
  private ctrl = false;
  private resizeTimer = 0;

  /** `host === null` opens a local shell. */
  readonly local: boolean;
  host: Host;

  constructor(host: Host | null, private onChange: () => void, private onClose: (s: Session) => void) {
    this.local = !host;
    this.host = host ?? { ...emptyHost(), name: "Local" };
    const prefs = loadPrefs();
    this.term = new Terminal({
      fontFamily: fontStack(prefs.fontFamily),
      fontSize: prefs.fontSize,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: termTheme,
    });
    this.el.className = "session";
    this.el.innerHTML = `<div class="term"></div>${
      host ? `<div class="sess-tools">
        <button data-t="upload" title="Upload a file to the host">${icon("image", 15)}</button>
        <button data-t="paste-img" title="Paste image from clipboard">${icon("paste", 15)}</button>
        <div class="up-prog" hidden><div class="bar"><i></i></div><span></span></div></div>` : ""
    }<div class="overlay"></div>${
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
    if (useWebgl) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        t.loadAddon(gl);
      } catch {
        /* falls back to DOM renderer */
      }
    }
    t.onData((d) => this.send(d));
    // WebKitGTK IME commits arrive via several events and xterm sends on more than one; send each once here.
    const ta = t.textarea!;
    const termEl = this.el.querySelector(".term")!;
    let composing = false;
    let lastCommit = { d: "", t: 0 };
    const commit = (raw: string) => {
      const d = raw.replace(/\u00a0/g, " ");
      if (!d) return;
      lastCommit = { d, t: performance.now() };
      this.send(d);
    };
    // Own preedit overlay at the rendered cursor, styled like terminal text (xterm's view is hidden).
    const pre = document.createElement("div");
    pre.className = "preedit";
    pre.hidden = true;
    this.el.append(pre);
    const showPreedit = (text: string) => {
      pre.hidden = !text;
      if (!text) return;
      pre.textContent = text;
      const cell = (t as any)._core?._renderService?.dimensions?.css?.cell ?? { width: 8, height: 16 };
      const cur = this.el.querySelector(".xterm-cursor");
      const base = this.el.getBoundingClientRect();
      const screen = this.el.querySelector(".xterm-screen")!.getBoundingClientRect();
      const r = cur?.getBoundingClientRect() ?? {
        left: screen.left + t.buffer.active.cursorX * cell.width,
        top: screen.top + t.buffer.active.cursorY * cell.height,
      };
      Object.assign(pre.style, {
        left: `${r.left - base.left}px`,
        top: `${r.top - base.top}px`,
        height: `${cell.height}px`,
        lineHeight: `${cell.height}px`,
        fontFamily: t.options.fontFamily,
        fontSize: `${t.options.fontSize}px`,
      });
    };
    termEl.addEventListener("compositionstart", () => (composing = true), true);
    termEl.addEventListener("compositionupdate", (e) => showPreedit((e as CompositionEvent).data), true);
    termEl.addEventListener(
      "compositionend",
      (e) => {
        e.stopPropagation();
        composing = false;
        pre.hidden = true;
        const ch = (t as any)._core?._compositionHelper;
        if (ch) {
          ch._isComposing = false;
          ch._isSendingComposition = false;
          ch._compositionView?.classList.remove("active");
        }
        commit((e as CompositionEvent).data);
        ta.value = "";
      },
      true,
    );
    termEl.addEventListener(
      "input",
      (e) => {
        e.stopPropagation();
        const ie = e as InputEvent;
        if (composing || ie.isComposing || ie.inputType !== "insertText" || !ie.data) return;
        const d = ie.data.replace(/\u00a0/g, " ");
        if (d === lastCommit.d && performance.now() - lastCommit.t < 100) return; // same commit reported twice
        commit(d);
        ta.value = "";
      },
      true,
    );
    t.onBinary((d) => this.send(d));
    t.onResize(({ cols, rows }) => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.sid && api.sshResize(this.sid, cols, rows), 60);
    });
    t.attachCustomKeyEventHandler((e) => {
      if (e.isComposing || e.keyCode === 229) return false; // IME: text arrives via composition/input above
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
        ...(this.local ? [] : [{ label: "Paste image", icon: "image", action: () => this.pasteImage() }]),
        ...(this.local ? [] : [{ label: "Copy password", icon: "key", action: () => this.copyPassword() }]),
        "-" as const,
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
    this.el.querySelector(".sess-tools")?.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (a === "upload") this.pickAndUpload();
      else if (a === "paste-img") this.pasteImage();
    });
    this.overlay.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("button")?.dataset.a;
      if (a === "retry") this.connect();
      else if (a === "logs") {
        localStorage.setItem("kermius.showLogs", localStorage.getItem("kermius.showLogs") === "1" ? "" : "1");
        this.setState(this.state);
      }
      else if (a === "trust") api.trustNewHostKey(this.host.id).then(() => this.connect());
      else if (a === "close") this.onClose(this);
    });
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.refit());
    }).observe(this.el);
    this.refit();
    this.connect();
  }

  /** Fit to the container and repaint everything (renderers can leave stale rows after resize). */
  private refit() {
    if (!this.el.offsetParent) return;
    this.fit.fit();
    this.term.refresh(0, this.term.rows - 1);
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

  /** Connect now; also used by Retry (keeps the backoff position, so a failure waits for the next step). */
  async connect() {
    this.clearRetry();
    if (this.sid) api.sshClose(this.sid).catch(() => {});
    this.sid = null;
    this.logs = [];
    const gen = ++this.gen;
    this.setState("connecting");
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (d) => {
      if (gen === this.gen) this.term.write(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as unknown as number[]));
    };
    const onStatus = new Channel<Status>();
    onStatus.onmessage = (s) => {
      if (gen !== this.gen) return;
      if (s.type === "log") return this.addLog(s.message);
      if (s.type === "upload") return this.showProgress(s.progress);
      if (s.type === "connected") {
        this.retryStep = 0;
        this.setState("connected");
        this.term.focus();
      } else if (s.type === "closed") this.setState("closed");
      else this.fail(s.message);
    };
    try {
      const { cols, rows } = this.term;
      this.sid = this.local
        ? await api.localOpen(cols, rows, onData, onStatus)
        : await api.sshConnect(this.host.id, cols, rows, onData, onStatus);
    } catch (e) {
      if (gen === this.gen) this.fail(String(e));
    }
  }

  private fail(message: string) {
    this.error = message;
    this.addLog(`Error: ${message}`);
    // Host key changes need a decision from the user; never retry those automatically.
    if (!this.local && !message.startsWith("HOSTKEY_MISMATCH")) {
      const delay = Session.DELAYS[Math.min(this.retryStep, Session.DELAYS.length - 1)];
      this.retryStep++;
      this.retryAt = Date.now() + delay * 1000;
      this.retryTimer = window.setTimeout(() => this.connect(), delay * 1000);
      this.tickTimer = window.setInterval(() => this.renderCountdown(), 1000);
    }
    this.setState("error");
  }

  private clearRetry() {
    clearTimeout(this.retryTimer);
    clearInterval(this.tickTimer);
    this.retryAt = 0;
  }

  private renderCountdown() {
    const el = this.overlay.querySelector(".countdown");
    if (el) el.textContent = this.retryAt ? `Reconnecting in ${Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))}s…` : "";
  }

  private addLog(line: string) {
    this.logs.push(line);
    const list = this.overlay.querySelector(".logs");
    if (list) {
      list.insertAdjacentHTML("beforeend", `<div>${esc(line)}</div>`);
      list.scrollTop = list.scrollHeight;
    }
  }

  private logsHtml() {
    const open = localStorage.getItem("kermius.showLogs") === "1";
    return `<button class="btn ghost sm" data-a="logs">${open ? "Hide logs" : "Show logs"}</button>
      ${open ? `<div class="logs">${this.logs.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}`;
  }

  private setState(s: SessionState) {
    this.state = s;
    const h = this.host;
    const avatar = `<div class="avatar lg" style="--h:${hue(h.folder || h.name)}">${icon("server", 26)}</div>`;
    const target = `${esc(h.username)}@${esc(h.address)}:${h.port}`;
    this.overlay.className = `overlay ${s}`;
    if (this.local && s !== "error") {
      this.overlay.className = `overlay ${s === "closed" ? "closed" : ""}`;
      this.overlay.innerHTML =
        s === "closed"
          ? `<div class="ov-bar"><span>Shell exited</span><button class="btn primary sm" data-a="retry">Restart</button><button class="btn ghost sm" data-a="close">Close tab</button></div>`
          : "";
    } else if (s === "connecting") {
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3><p class="muted">${target}</p><div class="progress"><i></i></div>
        ${this.logsHtml()}</div>`;
    } else if (s === "error") {
      const mismatch = this.error.startsWith("HOSTKEY_MISMATCH");
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3>${this.local ? "" : `<p class="muted">${target}</p>`}
        <p class="err">${esc(this.error.replace(/^HOSTKEY_MISMATCH: /, "⚠ "))}</p>
        <p class="countdown muted"></p>
        <div class="row">${mismatch ? `<button class="btn danger" data-a="trust">Trust new key</button>` : ""}
        <button class="btn primary" data-a="retry">Retry</button><button class="btn ghost" data-a="close">Close</button></div>
        ${this.local ? "" : this.logsHtml()}</div>`;
      this.renderCountdown();
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
    else if (!this.local) this.pasteImage();
  }

  private showProgress(p: number | null) {
    const el = this.el.querySelector<HTMLElement>(".up-prog");
    if (!el) return;
    el.hidden = p === null;
    if (p === null) return;
    el.querySelector("i")!.style.width = `${Math.round(p * 100)}%`;
    el.querySelector("span")!.textContent = `Uploading… ${Math.round(p * 100)}%`;
  }

  /** Upload, then paste the quoted remote path at the prompt (for Claude Code / OpenCode). */
  private async upload(run: (sid: string) => Promise<string>) {
    if (!this.sid || this.state !== "connected") return toast("Not connected", "err");
    this.showProgress(0);
    try {
      const path = await run(this.sid);
      this.term.paste(`'${path}'`);
      this.term.focus();
    } catch (e) {
      toast(String(e), "err");
    } finally {
      this.showProgress(null);
    }
  }

  pasteImage() {
    return this.upload((sid) => api.sshPasteImage(sid));
  }

  private pickAndUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const ext = f.name.includes(".") ? f.name.split(".").pop()! : "";
      this.upload(async (sid) => api.sshUpload(sid, ext, new Uint8Array(await f.arrayBuffer())));
    };
    input.click();
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
      this.refit();
      this.term.focus();
    });
  }

  hide() {
    this.el.hidden = true;
  }

  applyPrefs(p: TermPrefs) {
    this.term.options.fontFamily = fontStack(p.fontFamily);
    this.term.options.fontSize = p.fontSize;
    this.refit();
  }

  dispose() {
    this.clearRetry();
    this.gen++;
    if (this.sid) api.sshClose(this.sid);
    this.term.dispose();
    this.el.remove();
  }
}
