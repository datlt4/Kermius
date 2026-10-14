// Notification center: background events land here instead of toasts. Repeats are merged.
import { esc, icon } from "./ui";

export type Kind = "error" | "warn" | "info" | "ok";

export interface Note {
  id: string;
  kind: Kind;
  source: string;
  text: string;
  /** Extra lines shown when expanded. */
  detail: string;
  time: number;
  count: number;
  read: boolean;
  /** Optional navigation target, e.g. "foldersync". */
  view?: string;
}

const KEY = "kermius.notifications";
const MAX = 200;
let notes: Note[] = [];
try {
  notes = JSON.parse(localStorage.getItem(KEY) || "[]");
} catch {
  notes = [];
}
const listeners = new Set<() => void>();

const save = () => {
  localStorage.setItem(KEY, JSON.stringify(notes.slice(0, MAX)));
  listeners.forEach((f) => f());
};

export const onNotesChange = (f: () => void) => listeners.add(f);
export const unreadCount = () => notes.filter((n) => !n.read).length;

/** Add a notification; an identical unread-or-recent one is bumped instead of duplicated. */
export function notify(kind: Kind, source: string, message: string, view?: string) {
  const [text, ...rest] = message.split("\n");
  const same = notes.find((n) => n.source === source && n.text === text && n.kind === kind);
  if (same) {
    same.count++;
    same.time = Date.now();
    same.read = false;
    same.detail = rest.join("\n");
    notes = [same, ...notes.filter((n) => n !== same)];
  } else {
    notes.unshift({ id: crypto.randomUUID(), kind, source, text, detail: rest.join("\n"), time: Date.now(), count: 1, read: false, view });
  }
  save();
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

/** Toggle the panel under `anchor`; `go(view)` navigates for clickable notes. */
export function toggleNotesPanel(anchor: HTMLElement, go: (view: string) => void) {
  const open = document.querySelector(".notes-panel");
  if (open) return open.remove();
  const el = document.createElement("div");
  el.className = "notes-panel";
  const render = () => {
    el.innerHTML = `<div class="notes-head"><b>Notifications</b><div class="grow"></div>
        <button class="btn ghost sm" data-n="read">Mark all read</button><button class="btn ghost sm" data-n="clear">Clear</button></div>
      <div class="notes-list">${
        notes.length
          ? notes
              .map(
                (n) => `<div class="note ${n.kind} ${n.read ? "" : "unread"}" data-id="${n.id}">
                  <span class="note-dot"></span>
                  <div class="note-body"><div class="note-top"><b>${esc(n.source)}</b><span class="muted">${ago(n.time)}${n.count > 1 ? ` · ×${n.count}` : ""}</span></div>
                    <div class="note-text">${esc(n.text)}</div>
                    ${n.detail ? `<details><summary>Details</summary><pre>${esc(n.detail)}</pre></details>` : ""}</div></div>`,
              )
              .join("")
          : `<div class="empty small"><p>No notifications.</p></div>`
      }</div>`;
  };
  render();
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 6}px`;
  el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  document.body.append(el);
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-n]")?.dataset.n;
    if (a === "read") notes.forEach((n) => (n.read = true));
    else if (a === "clear") notes = [];
    else {
      const note = notes.find((n) => n.id === t.closest<HTMLElement>("[data-id]")?.dataset.id);
      if (!note || t.closest("details")) return;
      note.read = true;
      if (note.view) {
        el.remove();
        go(note.view);
      }
    }
    save();
    render();
  });
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
      el.remove();
      removeEventListener("pointerdown", outside, true);
    }
  };
  setTimeout(() => addEventListener("pointerdown", outside, true));
}

export const bellButton = () =>
  `<button class="icon-btn bell" data-act="notes" title="Notifications">${icon("bell", 16)}${
    unreadCount() ? `<span class="bell-badge">${unreadCount() > 99 ? "99+" : unreadCount()}</span>` : ""
  }</button>`;
