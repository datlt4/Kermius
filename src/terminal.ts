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
    this.overlay.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("button")?.dataset.a;
      if (a === "retry") this.connect();
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
      const { cols, rows } = this.term;
      this.sid = this.local
        ? await api.localOpen(cols, rows, onData, onStatus)
        : await api.sshConnect(this.host.id, cols, rows, onData, onStatus);
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
    if (this.local && s !== "error") {
      this.overlay.className = `overlay ${s === "closed" ? "closed" : ""}`;
      this.overlay.innerHTML =
        s === "closed"
          ? `<div class="ov-bar"><span>Shell exited</span><button class="btn primary sm" data-a="retry">Restart</button><button class="btn ghost sm" data-a="close">Close tab</button></div>`
          : "";
    } else if (s === "connecting") {
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3><p class="muted">${target}</p><div class="progress"><i></i></div></div>`;
    } else if (s === "error") {
      const mismatch = this.error.startsWith("HOSTKEY_MISMATCH");
      this.overlay.innerHTML = `<div class="ov-card">${avatar}<h3>${esc(h.name)}</h3>${this.local ? "" : `<p class="muted">${target}</p>`}
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
    if (this.sid) api.sshClose(this.sid);
    this.term.dispose();
    this.el.remove();
  }
}
