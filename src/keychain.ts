import { api, isWeb, type Identity, type Key } from "./api";
import { $, confirmDialog, contextMenu, esc, icon, toast } from "./ui";

export interface KeychainCtx {
  keys(): Key[];
  identities(): Identity[];
  /** Reload data, re-render, schedule sync. */
  changed(): Promise<void>;
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { numeric: true });
const emptyKey = (): Key => ({ id: "", label: "", privateKey: "", passphrase: "", publicKey: "", updatedAt: 0, deleted: false });
const emptyIdentity = (): Identity => ({ id: "", label: "", username: "", password: "", keyId: "", updatedAt: 0, deleted: false });

export function renderKeychain(root: HTMLElement, ctx: KeychainCtx) {
  const keys = [...ctx.keys()].sort(byLabel);
  const ids = [...ctx.identities()].sort(byLabel);
  root.innerHTML = `
    <div class="toolbar">
      <div class="grow"></div>
      ${isWeb ? "" : `<button class="btn" data-kc="gen">${icon("key", 16)}<span>Generate Key</span></button>`}
      <button class="btn" data-kc="new-key">${icon("plus", 16)}<span>Add Key</span></button>
      <button class="btn primary" data-kc="new-id">${icon("plus", 16)}<span>New Identity</span></button>
    </div>
    <div class="content">
      <h4 class="section">Keys</h4>
      ${keys.length ? `<div class="grid">${keys
        .map(
          (k) => `<div class="card" data-key="${k.id}" tabindex="0">
            <div class="avatar key-ic">${icon("key", 18)}</div>
            <div class="card-body"><div class="card-title">${esc(k.label || "Untitled key")}</div>
              <div class="card-sub mono">${esc(k.publicKey.split(" ")[0] || "private key")}</div></div>
            <div class="card-actions">${k.publicKey ? `<button class="icon-btn" data-kc="copy-pub" title="Copy public key">${icon("copy", 15)}</button>` : ""}</div></div>`,
        )
        .join("")}</div>` : `<p class="muted">No keys. Add an existing private key or generate a new one.</p>`}
      <h4 class="section">Identities</h4>
      ${ids.length ? `<div class="grid">${ids
        .map((i) => {
          const key = keys.find((k) => k.id === i.keyId);
          return `<div class="card" data-identity="${i.id}" tabindex="0">
            <div class="avatar id-ic">${icon("user", 18)}</div>
            <div class="card-body"><div class="card-title">${esc(i.label || i.username)}</div>
              <div class="card-sub">${esc(i.username)}${i.password ? " · password" : ""}${key ? ` · ${esc(key.label)}` : ""}</div></div></div>`;
        })
        .join("")}</div>` : `<p class="muted">No identities. An identity is a username with a password and/or key, reusable across hosts.</p>`}
    </div>`;
}

/** Wire clicks once; `active()` says whether the keychain page is showing. */
export function bindKeychain(root: HTMLElement, ctx: KeychainCtx, active: () => boolean) {
  root.addEventListener("click", async (e) => {
    if (!active()) return;
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-kc]")?.dataset.kc;
    const keyEl = t.closest<HTMLElement>("[data-key]");
    const key = keyEl && ctx.keys().find((k) => k.id === keyEl.dataset.key);
    const idEl = t.closest<HTMLElement>("[data-identity]");
    const ident = idEl && ctx.identities().find((i) => i.id === idEl.dataset.identity);
    if (act === "new-key") return keyDialog(emptyKey(), ctx);
    if (act === "new-id") return identityDialog(emptyIdentity(), ctx);
    if (act === "gen") return generateDialog(ctx);
    if (key && act === "copy-pub") return api.clipboardWrite(key.publicKey).then(() => toast("Public key copied", "ok"));
    if (key) return keyDialog(key, ctx);
    if (ident) return identityDialog(ident, ctx);
  });
}

const copy = (text: string, what: string) => api.clipboardWrite(text).then(() => toast(`${what} copied`, "ok"));

async function deleteKey(k: Key, ctx: KeychainCtx) {
  if (!(await confirmDialog(`Delete ${k.label}?`, "Hosts and identities using this key will no longer use it."))) return;
  await api.deleteKey(k.id);
  await ctx.changed();
}

async function deleteIdentity(i: Identity, ctx: KeychainCtx) {
  if (!(await confirmDialog(`Delete ${i.label}?`, "Hosts using this identity will keep only their own credentials."))) return;
  await api.deleteIdentity(i.id);
  await ctx.changed();
}

/** Right-click menus on key and identity cards. */
export function bindKeychainMenu(root: HTMLElement, ctx: KeychainCtx, active: () => boolean) {
  root.addEventListener("contextmenu", (e) => {
    if (!active()) return;
    const t = e.target as HTMLElement;
    const keyEl = t.closest<HTMLElement>("[data-key]");
    const k = keyEl && ctx.keys().find((x) => x.id === keyEl.dataset.key);
    const idEl = t.closest<HTMLElement>("[data-identity]");
    const i = idEl && ctx.identities().find((x) => x.id === idEl.dataset.identity);
    if (!k && !i) return;
    e.preventDefault();
    if (k)
      contextMenu(e.clientX, e.clientY, [
        { label: "Edit", icon: "edit", action: () => keyDialog(k, ctx) },
        ...(k.publicKey ? [{ label: "Copy public key", icon: "copy", action: () => copy(k.publicKey, "Public key") }] : []),
        { label: "Copy private key", icon: "key", action: () => copy(k.privateKey, "Private key") },
        "-" as const,
        { label: "Delete", icon: "trash", danger: true, action: () => deleteKey(k, ctx) },
      ]);
    else if (i)
      contextMenu(e.clientX, e.clientY, [
        { label: "Edit", icon: "edit", action: () => identityDialog(i, ctx) },
        { label: "Copy username", icon: "user", action: () => copy(i.username, "Username") },
        ...(i.password ? [{ label: "Copy password", icon: "key", action: () => copy(i.password, "Password") }] : []),
        "-" as const,
        { label: "Delete", icon: "trash", danger: true, action: () => deleteIdentity(i, ctx) },
      ]);
  });
}

/** Modal form; `onSave` returns false to keep it open. */
function modal(title: string, body: string, onSave: (form: HTMLFormElement) => Promise<boolean>, onDelete?: () => Promise<void>) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<form class="modal form-modal"><h3>${esc(title)}</h3>${body}
    <div class="modal-actions">${onDelete ? `<button type="button" class="btn danger" data-m="delete">Delete</button><div class="grow"></div>` : ""}
      <button type="button" class="btn ghost" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`;
  document.body.append(el);
  const form = el.querySelector("form")!;
  form.querySelector<HTMLElement>("input, textarea")?.focus();
  const close = () => el.remove();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (await onSave(form)) close();
    } catch (err) {
      toast(String(err), "err");
    }
  });
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>("[data-m]")?.dataset.m;
    if (m === "cancel" || t === el) close();
    else if (m === "delete" && onDelete) {
      await onDelete();
      close();
    }
  });
  el.addEventListener("keydown", (e) => e.key === "Escape" && close());
  return form;
}

const val = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;

function keyDialog(k: Key, ctx: KeychainCtx) {
  const form = modal(
    k.id ? "Edit key" : "Add key",
    `<label class="field"><span>Label</span><input name="label" value="${esc(k.label)}" placeholder="Work laptop" /></label>
     <label class="field"><span>Private key</span><textarea name="privateKey" rows="6" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">${esc(k.privateKey)}</textarea></label>
     ${isWeb ? "" : `<button type="button" class="btn ghost sm" data-load>${icon("import", 14)} Load from file</button>`}
     <label class="field"><span>Passphrase</span><input name="passphrase" type="password" value="${esc(k.passphrase)}" autocomplete="off" /></label>
     ${k.publicKey ? `<label class="field"><span>Public key</span><textarea rows="3" readonly class="mono">${esc(k.publicKey)}</textarea></label>` : ""}`,
    async (f) => {
      await api.saveKey({ ...k, label: val(f, "label").trim() || "Key", privateKey: val(f, "privateKey").trim() + "\n", passphrase: val(f, "passphrase") });
      await ctx.changed();
      return true;
    },
    k.id ? () => deleteKey(k, ctx) : undefined,
  );
  form.querySelector("[data-load]")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      (form.elements.namedItem("privateKey") as HTMLTextAreaElement).value = await f.text();
      const label = form.elements.namedItem("label") as HTMLInputElement;
      if (!label.value) label.value = f.name;
    };
    input.click();
  });
}

function generateDialog(ctx: KeychainCtx) {
  modal(
    "Generate Ed25519 key",
    `<label class="field"><span>Label / comment</span><input name="label" placeholder="kermius@laptop" /></label>
     <p class="muted">After saving, copy the public key into the server's <code>~/.ssh/authorized_keys</code>.</p>`,
    async (f) => {
      const label = val(f, "label").trim() || "kermius";
      const saved = await api.saveKey({ ...emptyKey(), label, privateKey: await api.generateKey(label) });
      await api.clipboardWrite(saved.publicKey);
      toast("Key generated; public key copied", "ok");
      await ctx.changed();
      return true;
    },
  );
}

function identityDialog(i: Identity, ctx: KeychainCtx) {
  const keys = [...ctx.keys()].sort(byLabel);
  modal(
    i.id ? "Edit identity" : "New identity",
    `<label class="field"><span>Label</span><input name="label" value="${esc(i.label)}" placeholder="Default login" /></label>
     <label class="field"><span>Username</span><input name="username" value="${esc(i.username)}" spellcheck="false" /></label>
     <label class="field"><span>Password</span><input name="password" type="password" value="${esc(i.password)}" autocomplete="off" /></label>
     <label class="field"><span>Key</span><select name="keyId"><option value="">None</option>${keys
       .map((k) => `<option value="${k.id}" ${k.id === i.keyId ? "selected" : ""}>${esc(k.label)}</option>`)
       .join("")}</select></label>`,
    async (f) => {
      const username = val(f, "username").trim();
      if (!username) {
        toast("Username is required", "err");
        return false;
      }
      await api.saveIdentity({ ...i, label: val(f, "label").trim() || username, username, password: val(f, "password"), keyId: val(f, "keyId") });
      await ctx.changed();
      return true;
    },
    i.id ? () => deleteIdentity(i, ctx) : undefined,
  );
}

/** Host editor fields: identity + key pickers. */
export function credentialPickers(identityId: string, keyId: string, ctx: KeychainCtx) {
  const opt = (id: string, label: string, sel: string) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(label)}</option>`;
  return `<div class="field-row">
    <label class="field grow"><span>Identity</span><select id="e-identity"><option value="">None</option>${[...ctx.identities()]
      .sort(byLabel)
      .map((i) => opt(i.id, `${i.label} (${i.username})`, identityId))
      .join("")}</select></label>
    <label class="field grow"><span>Key</span><select id="e-keyid"><option value="">${identityId ? "From identity" : "None"}</option>${[...ctx.keys()]
      .sort(byLabel)
      .map((k) => opt(k.id, k.label, keyId))
      .join("")}</select></label></div>`;
}

export const readPickers = (root: HTMLElement) => ({
  identityId: $<HTMLSelectElement>("#e-identity", root).value,
  keyId: $<HTMLSelectElement>("#e-keyid", root).value,
});
