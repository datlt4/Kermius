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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, Channel, emptyHost, type Host, type Status } from "./api";
import { notify } from "./notify";
import { contextMenu, esc, hue, icon, promptDialog, toast } from "./ui";

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

/** Single-quote for POSIX shells. */
const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

export type SessionState = "connecting" | "connected" | "closed" | "error";

const coarse = matchMedia("(pointer: coarse)").matches;

/** SSH and mosh (which logs in over SSH) share keys, passwords and SFTP. */
export const isSsh = (h: Host) => !h.protocol || h.protocol === "ssh" || h.protocol === "mosh";

export const protocolLabel = (h: Host) => ({ mosh: "Mosh", telnet: "Telnet", serial: "Serial", vnc: "VNC" })[h.protocol] ?? "SSH";

export function describeTarget(h: Host) {
  if (h.protocol === "serial") return `${h.address} · ${h.baud || 115200} baud`;
  const user = h.username ? `${h.username}@` : "";
  if (h.protocol === "telnet") return `telnet ${h.address}:${h.port || 23}`;
  if (h.protocol === "mosh") return `mosh ${user}${h.address}`;
  return `${user}${h.address}:${h.port}`;
}

/** A command embedded in a setup error as `...`, for the "Copy command" button. */
export const fixCommand = (message: string) => /`([^`]+)`/.exec(message)?.[1] ?? "";

/** Installs mosh-server on common Linux distributions (paste on the remote host). */
export const MOSH_SERVER_SETUP =
  "if command -v apt-get >/dev/null; then sudo apt-get install -y mosh; elif command -v dnf >/dev/null; then sudo dnf install -y mosh; elif command -v pacman >/dev/null; then sudo pacman -S --needed mosh; elif command -v apk >/dev/null; then sudo apk add mosh; elif command -v brew >/dev/null; then brew install mosh; fi";

export class Session {
  readonly id = crypto.randomUUID();
  readonly el = document.createElement("div");
  readonly kind = "terminal";
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
    this.el.innerHTML = `<div class="term"></div><div class="sess-tools">${
      host && isSsh(host)
        ? `${host.protocol === "mosh" ? "" : `<button data-t="files" title="Open SFTP file manager">${icon("folder", 15)}</button>`}
        <button data-t="snippets" title="Run a snippet">${icon("code", 15)}</button>
        ${host.protocol === "mosh" ? "" : `<button data-t="upload" title="Upload a file to the host">${icon("image", 15)}</button>
        <button data-t="paste-img" title="Paste image from clipboard">${icon("paste", 15)}</button>`}
        <button data-t="password" title="Type password (e.g. for sudo)" disabled>${icon("key", 15)}</button>`
        : host
        ? `<button data-t="snippets" title="Run a snippet">${icon("code", 15)}</button>
        <button data-t="password" title="Type password" disabled>${icon("key", 15)}</button>`
        : `<button data-t="snippets" title="Run a snippet">${icon("code", 15)}</button>
        <button data-t="insert-path" title="Insert a file path">${icon("file", 15)}</button>
        <button data-t="paste-img" title="Paste image from clipboard (saved to a temp file)">${icon("paste", 15)}</button>
        <button data-t="password" title="Type this computer's password (e.g. for sudo)">${icon("key", 15)}</button>`
    }<div class="up-prog" hidden><div class="bar"><i></i></div><span></span></div></div><div class="overlay"></div>${
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
    // Keys xterm already sent from keydown; without an IME WebKit also fires `input` for some (space).
    let lastKey = { d: "", t: 0 };
    t.onData((d) => {
      lastKey = { d, t: performance.now() };
      this.send(d);
    });
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
        if (d === lastKey.d && performance.now() - lastKey.t < 50) return;
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
      // preventDefault: WebKitGTK would otherwise also paste natively into xterm's textarea (pasting twice).
      if (e.code === "KeyC") return e.preventDefault(), this.copySelection(), false;
      if (e.code === "KeyV") return e.preventDefault(), this.paste(), false;
      return !["KeyK", "KeyT", "KeyW", "KeyF"].includes(e.code);
    });
    this.el.querySelector(".term")!.addEventListener("contextmenu", (e) => {
      const ev = e as MouseEvent;
      ev.preventDefault();
      contextMenu(ev.clientX, ev.clientY, [
        { label: "Copy", icon: "copy", action: () => this.copySelection() },
        { label: "Paste", icon: "import", action: () => this.paste() },
        { label: "Paste image", icon: "image", action: () => this.pasteImage() },
        { label: "Type password", icon: "key", action: () => this.sendPassword() },
        ...(this.local
          ? [{ label: "Change local password", icon: "key", action: () => this.askLocalPassword().then((ok) => ok && this.term.focus()) }]
          : [{ label: "Copy password", icon: "key", action: () => this.copyPassword() }]),
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
      if (a === "files") this.el.dispatchEvent(new CustomEvent("kermius-files", { bubbles: true, detail: { host: this.host } }));
      else if (a === "snippets") {
        const r = (e.target as HTMLElement).closest("button")!.getBoundingClientRect();
        this.el.dispatchEvent(new CustomEvent("kermius-snippets", { bubbles: true, detail: { session: this, x: r.left, y: r.bottom + 4 } }));
      } else if (a === "upload") this.pickAndUpload();
      else if (a === "paste-img") this.pasteImage();
      else if (a === "password") this.sendPassword();
      else if (a === "insert-path") this.insertPath();
    });
    this.overlay.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("button")?.dataset.a;
      if (a === "retry") this.connect();
      else if (a === "logs") {
        localStorage.setItem("kermius.showLogs", localStorage.getItem("kermius.showLogs") === "1" ? "" : "1");
        this.setState(this.state);
      }
      else if (a === "trust") api.trustNewHostKey(this.host.id).then(() => this.connect());
      else if (a === "copy-fix") api.clipboardWrite(fixCommand(this.error)).then(() => toast("Command copied; paste it into a terminal on this computer", "ok"));
      else if (a === "mosh-server") api.clipboardWrite(MOSH_SERVER_SETUP).then(() => toast(`Command copied; run it on ${this.host.name}`, "ok"));
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
    // Ack rendered bytes in ~256 KB batches so the backend keeps reading (flow control).
    let pendingAck = 0;
    const ack = (n: number) => {
      pendingAck += n;
      if (pendingAck >= 256 * 1024 && this.sid && gen === this.gen) {
        api.termAck(this.sid, pendingAck).catch(() => {});
        pendingAck = 0;
      }
    };
    onData.onmessage = (d) => {
      if (gen !== this.gen) return;
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as unknown as number[]);
      this.term.write(bytes, () => ack(bytes.length));
    };
    const onStatus = new Channel<Status>();
    onStatus.onmessage = (s) => {
      if (gen !== this.gen) return;
      if (s.type === "log") return this.addLog(s.message);
      if (s.type === "upload") return this.showProgress(s.progress);
      if (s.type === "connected") {
        this.retryStep = 0;
        this.refreshPasswordButton();
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
    // A dropped live session is worth a notification (the tab may be in the background).
    if (this.state === "connected" && !this.local) notify("warn", `${protocolLabel(this.host)} · ${this.host.name}`, message, "");
    this.error = message;
    this.addLog(`Error: ${message}`);
    // Host key changes need a decision from the user; never retry those automatically.
    // Same for setup problems with a fix command (missing mosh, serial permissions): retrying cannot help.
    if (!this.local && !message.startsWith("HOSTKEY_MISMATCH") && !fixCommand(message)) {
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
    const target = esc(describeTarget(h));
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
        ${fixCommand(this.error) ? `<button class="btn" data-a="copy-fix">Copy command</button>` : ""}
        <button class="btn primary" data-a="retry">Retry</button><button class="btn ghost" data-a="close">Close</button></div>
        ${this.local ? "" : this.logsHtml()}</div>`;
      this.renderCountdown();
    } else if (s === "closed") {
      // mosh exits right away when the server lacks mosh-server: offer the install command.
      const mosh = h.protocol === "mosh" ? `<button class="btn sm" data-a="mosh-server" title="${esc(MOSH_SERVER_SETUP)}">Copy mosh-server install command</button>` : "";
      this.overlay.innerHTML = `<div class="ov-bar"><span>Connection closed</span>${mosh}<button class="btn primary sm" data-a="retry">Reconnect</button><button class="btn ghost sm" data-a="close">Close tab</button></div>`;
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
    else this.pasteImage();
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

  /** Send a snippet: lines are typed as-is, with a final Enter. */
  runText(script: string) {
    if (!this.sid || this.state !== "connected") return toast("Not connected", "err");
    const text = script.replace(/\r?\n/g, "\r");
    api.sshWrite(this.sid, text.endsWith("\r") ? text : `${text}\r`);
    this.term.focus();
  }

  pasteImage() {
    if (this.local) {
      return api.saveClipboardImage().then(
        (path) => this.insertText(quote(path)),
        (e) => toast(String(e), "err"),
      );
    }
    return this.upload((sid) => api.sshPasteImage(sid));
  }

  private insertText(text: string) {
    this.term.paste(text);
    this.term.focus();
  }

  private async insertPath() {
    const picked = await openDialog({ multiple: true }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) this.insertText(paths.map(quote).join(" "));
  }

  /** Enable the password button only when the host (or its identity) has one. */
  private async refreshPasswordButton() {
    const b = this.el.querySelector<HTMLButtonElement>('[data-t="password"]');
    if (b && !this.local) b.disabled = !(await api.hostHasPassword(this.host.id).catch(() => false));
  }

  /** Ask for this computer's password and save it (encrypted, this device only). */
  private async askLocalPassword() {
    const pw = await promptDialog("Local password", "Password of this computer (saved encrypted on this device only, never synced)", "", true);
    if (!pw) return false;
    await api.localSetPassword(pw).catch((e) => toast(String(e), "err"));
    return true;
  }

  async sendPassword() {
    if (!this.sid || this.state !== "connected") return toast("Not connected", "err");
    if (this.local) {
      if (!(await api.localHasPassword()) && !(await this.askLocalPassword())) return this.term.focus();
      return api.localSendPassword(this.sid).then(
        () => this.term.focus(),
        (e) => toast(String(e), "err"),
      );
    }
    api.sshSendPassword(this.sid, this.host.id).then(
      () => this.term.focus(),
      (e) => toast(String(e), "err"),
    );
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
