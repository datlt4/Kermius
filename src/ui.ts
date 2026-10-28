const P: Record<string, string> = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  code: '<path d="M8 4C6 4 6 5 6 7v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 0 3 2 3M16 4c2 0 2 1 2 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2 0 3-2 3"/>',
  folders: '<path d="M8 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2"/><rect x="9" y="10" width="12" height="10" rx="2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  forward: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  import: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  upload: '<path d="M12 15V3m0 0-4 4m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  "eye-off": '<path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};

export const icon = (name: string, size = 18) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ""}</svg>`;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Stable pleasant hue per string. */
export const hue = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

let toastHost: HTMLElement | null = null;
export function toast(msg: string, kind: "ok" | "err" | "info" = "info") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    document.body.append(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  }, kind === "err" ? 5000 : 2200);
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  action: () => void;
}

export function contextMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  document.querySelector(".ctx")?.remove();
  const el = document.createElement("div");
  el.className = "ctx";
  el.innerHTML = items
    .map((it, i) =>
      it === "-"
        ? '<div class="ctx-sep"></div>'
        : `<button data-i="${i}" class="${it.danger ? "danger" : ""}">${it.icon ? icon(it.icon, 15) : ""}<span>${esc(it.label)}</span></button>`,
    )
    .join("");
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  el.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const close = () => {
    el.remove();
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", onKey, true);
  };
  const outside = (e: Event) => !el.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    close();
    (items[+b.dataset.i!] as MenuItem).action();
  });
  setTimeout(() => {
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", onKey, true);
  });
}

export function confirmDialog(title: string, body: string, ok = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "modal-wrap";
    el.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(body)}</p>
      <div class="modal-actions"><button class="btn ghost" data-r="0">Cancel</button><button class="btn danger" data-r="1">${esc(ok)}</button></div></div>`;
    document.body.append(el);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const r = t.dataset.r ?? (t === el ? "0" : null);
      if (r === null) return;
      el.remove();
      resolve(r === "1");
    });
  });
}

export function promptDialog(title: string, label: string, value = "", password = false): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "modal-wrap";
    el.innerHTML = `<form class="modal"><h3>${esc(title)}</h3>
      <label class="field"><span>${esc(label)}</span><input name="v" type="${password ? "password" : "text"}" value="${esc(value)}" spellcheck="false" /></label>
      <div class="modal-actions" style="margin-top:16px"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="submit" class="btn primary">OK</button></div></form>`;
    document.body.append(el);
    const input = el.querySelector("input")!;
    input.focus();
    input.select();
    const done = (v: string | null) => {
      el.remove();
      resolve(v);
    };
    el.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    });
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.r === "0" || t === el) done(null);
    });
    el.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
  });
}

/** Patch `target`'s children to match `html`, reusing existing nodes (keeps hover/focus/scroll). */
/** Saved order (ids) for a list, from localStorage. */
export function loadOrder(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

/** `items` sorted by the saved order; items not in it keep their relative order at the end. */
export function byOrder<T>(items: T[], order: string[], id: (x: T) => string): T[] {
  const rank = (x: T) => {
    const i = order.indexOf(id(x));
    return i < 0 ? order.length : i;
  };
  return items.map((x, i) => [x, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([x]) => x);
}

/** Move `id` before `before` (end when null) in `ids` and save it under `key`. */
export function saveOrder(key: string, ids: string[], id: string, before: string | null) {
  const list = ids.filter((x) => x !== id);
  const at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, id);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

/** Pointer-based drag to reorder `item` elements (siblings) inside `root`; `attr` holds each item's id.
 *  `drop(id, before)`: `before` is the id it lands in front of, null = the end. */
export function dragReorder(root: HTMLElement, item: string, attr: string, enabled: () => boolean, drop: (id: string, before: string | null) => void) {
  let justEnded = false;
  root.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(item);
    if (!card || e.button !== 0 || !enabled() || t.closest("button, input, select, textarea, a, label")) return;
    const id = card.getAttribute(attr)!;
    const [x0, y0] = [e.clientX, e.clientY];
    let ghost: HTMLElement | null = null;
    let target: { before: string | null } | null = null;
    const clear = () => root.querySelectorAll(".drop-before,.drop-after,.drop-above,.drop-below").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-above", "drop-below"));
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
      }
      ghost.style.left = `${ev.clientX - +ghost.dataset.dx!}px`;
      ghost.style.top = `${ev.clientY - +ghost.dataset.dy!}px`;
      clear();
      target = null;
      // Live re-renders may reuse elements, so the dragged one is found by id each time.
      root.querySelectorAll<HTMLElement>(item).forEach((el) => el.classList.toggle("dragging", el.getAttribute(attr) === id));
      const over = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(item);
      if (!over || over.getAttribute(attr) === id || !root.contains(over)) return;
      const r = over.getBoundingClientRect();
      // Full-width rows stack vertically; grid cards sit side by side.
      const vertical = r.width > over.parentElement!.clientWidth * 0.6;
      const after = vertical ? ev.clientY > r.top + r.height / 2 : ev.clientX > r.left + r.width / 2;
      over.classList.add(vertical ? (after ? "drop-below" : "drop-above") : after ? "drop-after" : "drop-before");
      const next = after ? (over.nextElementSibling as HTMLElement | null) : over;
      target = { before: next?.matches(item) ? next.getAttribute(attr) : null };
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("no-select");
      root.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
      clear();
      justEnded = true;
      setTimeout(() => (justEnded = false));
      if (target && target.before !== id) drop(id, target.before);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
  // A drag ends with a click on the item under the pointer: swallow it.
  root.addEventListener("click", (e) => justEnded && (e.stopImmediatePropagation(), e.preventDefault()), true);
}

export function morphHtml(target: HTMLElement, html: string) {
  const next = document.createElement("div");
  next.innerHTML = html;
  morphChildren(target, next);
}

function morphChildren(a: Node, b: Node) {
  const ca = [...a.childNodes];
  const cb = [...b.childNodes];
  cb.forEach((n, i) => (i < ca.length ? morphNode(ca[i], n) : a.appendChild(n)));
  for (let i = cb.length; i < ca.length; i++) a.removeChild(ca[i]);
}

function morphNode(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return a.parentNode!.replaceChild(b, a);
  if (a.nodeType !== Node.ELEMENT_NODE) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const ea = a as Element;
  const eb = b as Element;
  for (const at of [...ea.attributes]) if (!eb.hasAttribute(at.name)) ea.removeAttribute(at.name);
  for (const at of [...eb.attributes]) if (ea.getAttribute(at.name) !== at.value) ea.setAttribute(at.name, at.value);
  morphChildren(a, b);
}

/** fzf-style score of `q` as a subsequence of `text`, ignoring case; -1 = no match. Substrings, runs and word starts rank higher. */
export function fuzzyScore(q: string, text: string) {
  const s = text.toLowerCase();
  q = q.toLowerCase();
  let score = s.includes(q) ? 20 : 0;
  let j = 0;
  let prev = -2;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    score += i === prev + 1 ? 5 : 1;
    if (i === 0 || /[\s._\-/@:]/.test(s[i - 1])) score += 3;
    prev = i;
    j++;
  }
  return j === q.length ? score - s.length * 0.01 : -1;
}

/** Score of a query against several fields: every word must match one of them; -1 = no match. */
export function fuzzyBest(q: string, fields: string[]) {
  let total = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const best = Math.max(-1, ...fields.map((f) => fuzzyScore(w, f)));
    if (best < 0) return -1;
    total += best;
  }
  return total;
}
