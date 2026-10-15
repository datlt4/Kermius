// Update notice and installer: desktop installs and restarts; Android downloads the APK; iOS only shows it.
import { Channel } from "@tauri-apps/api/core";
import { api, type UpdateInfo } from "./api";
import { notify } from "./notify";
import { esc, toast } from "./ui";

let available: UpdateInfo | null = null;
export const pendingUpdate = () => available;

/** Ask GitHub; tells the notification center once per new version. `manual` reports the outcome. */
export async function checkUpdate(manual: boolean, changed: () => void) {
  try {
    const info = await api.updateCheck();
    available = info;
    changed();
    if (!info) return manual && toast("Kermius is up to date", "ok");
    if (localStorage.getItem("kermius.updateNotified") !== info.version) {
      localStorage.setItem("kermius.updateNotified", info.version);
      notify("info", "Update", `Kermius ${info.version} is available`);
    }
    if (manual) updateDialog(info);
  } catch (e) {
    if (manual) toast(`Update check failed: ${e}`, "err");
  }
}

export function updateDialog(info: UpdateInfo) {
  const el = document.createElement("div");
  el.className = "modal-wrap";
  const button =
    info.action === "install"
      ? `<button class="btn primary" data-u="install">Install and restart</button>`
      : info.action === "download"
        ? `<button class="btn primary" data-u="open">Download APK</button>`
        : `<button class="btn primary" data-u="open">Open release page</button>`;
  el.innerHTML = `<div class="modal form-modal upd-modal"><h3>Kermius ${esc(info.version)} is available</h3>
    <p class="muted">You have ${esc(__APP_VERSION__)}.${info.action === "none" ? " On iPhone the Mac installs new releases over Wi-Fi." : ""}</p>
    ${info.notes ? `<pre class="upd-notes">${esc(info.notes)}</pre>` : ""}
    <div class="upd-progress" hidden><div class="bar"><i></i></div><span class="muted"></span></div>
    <div class="modal-actions"><button class="btn ghost" data-u="close">Later</button>${button}</div></div>`;
  document.body.append(el);
  const close = () => el.remove();
  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-u]")?.dataset.u;
    if (t === el || a === "close") return close();
    if (a === "open") return api.openUrl(info.url).then(close, (err) => toast(String(err), "err"));
    if (a !== "install") return;
    el.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));
    const box = el.querySelector<HTMLElement>(".upd-progress")!;
    box.hidden = false;
    const progress = new Channel<[number, number]>();
    progress.onmessage = ([done, total]) => {
      box.querySelector<HTMLElement>("i")!.style.width = total ? `${Math.round((done / total) * 100)}%` : "100%";
      box.querySelector("span")!.textContent = `${(done / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ""} MB`;
    };
    try {
      await api.updateInstall(progress); // restarts the app when done
    } catch (err) {
      toast(`Update failed: ${err}`, "err");
      el.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = false));
    }
  });
}
