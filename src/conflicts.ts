import { api, type FsConflict, type FsJob } from "./api";
import { esc, icon, toast } from "./ui";

type Op = { t: "same" | "del" | "add"; line: string };

/** Line diff via LCS (fine for notes-sized files). */
function diff(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) return [...a.map((line) => ({ t: "del" as const, line })), ...b.map((line) => ({ t: "add" as const, line }))];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: "same", line: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", line: a[i++] });
    else ops.push({ t: "add", line: b[j++] });
  }
  while (i < n) ops.push({ t: "del", line: a[i++] });
  while (j < m) ops.push({ t: "add", line: b[j++] });
  return ops;
}

/** Side-by-side rows: changed blocks are paired line by line. */
function rows(ops: Op[]) {
  const out: Row[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].t === "same") {
      out.push({ l: ops[k].line, r: ops[k].line, kind: "same" });
      k++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].t !== "same") (ops[k].t === "del" ? dels : adds).push(ops[k++].line);
    for (let x = 0; x < Math.max(dels.length, adds.length); x++) out.push({ l: dels[x] ?? null, r: adds[x] ?? null, kind: "chg" });
  }
  return collapse(out);
}

type Row = { l: string | null; r: string | null; kind: string };
const CONTEXT = 3;
const MAX_ROWS = 2000;

/** Big files would freeze the page: show only changes with a little context, and at most MAX_ROWS rows. */
function collapse(all: Row[]): Row[] {
  const near = all.map(() => false);
  all.forEach((r, i) => {
    if (r.kind === "chg") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(all.length - 1, i + CONTEXT); k++) near[k] = true;
  });
  const out: Row[] = [];
  for (let i = 0; i < all.length; ) {
    if (near[i]) {
      out.push(all[i++]);
      continue;
    }
    let n = 0;
    while (i < all.length && !near[i]) n++, i++;
    out.push({ l: null, r: null, kind: `skip:${n} unchanged line${n === 1 ? "" : "s"}` });
  }
  if (out.length <= MAX_ROWS) return out;
  const rest = out.length - MAX_ROWS;
  return [...out.slice(0, MAX_ROWS), { l: null, r: null, kind: `skip:${rest} more rows not shown` }];
}

const tsLabel = (path: string) => {
  const m = path.match(/\.sync-conflict-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString() : "";
};

export async function conflictsDialog(job: FsJob, onDone: () => void) {
  let list: FsConflict[] = [];
  let current = 0;
  const el = document.createElement("div");
  el.className = "modal-wrap";
  el.innerHTML = `<div class="modal cf-modal"><div class="cf-head"><h3>Conflicts · ${esc(job.name)}</h3><div class="grow"></div>
    <button class="icon-btn" data-c="close">${icon("x", 16)}</button></div><div class="cf-body"><div class="cf-list"></div><div class="cf-main"></div></div></div>`;
  document.body.append(el);
  const close = () => {
    el.remove();
    onDone();
  };

  const load = async () => {
    list = await api.fsyncConflicts(job.id).catch((e) => (toast(String(e), "err"), []));
    if (!list.length) {
      toast("No conflicts left", "ok");
      return close();
    }
    current = Math.min(current, list.length - 1);
    renderList();
    await show();
  };

  const renderList = () => {
    el.querySelector(".cf-list")!.innerHTML = list
      .map((c, i) => `<button class="cf-item ${i === current ? "on" : ""}" data-i="${i}"><b>${esc(c.original.split("/").pop()!)}</b>
        <small class="muted">${esc(c.original)}</small><small class="muted">${esc(tsLabel(c.path))}</small></button>`)
      .join("");
  };

  const show = async () => {
    const c = list[current];
    const main = el.querySelector<HTMLElement>(".cf-main")!;
    const [mine, theirs] = await Promise.all([
      c.originalExists ? api.fsyncRead(job.id, c.original).catch((e) => ({ error: String(e) })) : Promise.resolve(""),
      api.fsyncRead(job.id, c.path).catch((e) => ({ error: String(e) })),
    ]);
    const textual = typeof mine === "string" && typeof theirs === "string";
    const table = textual
      ? `<div class="cf-diff">${rows(diff(mine.split("\n"), theirs.split("\n")))
          .map((r) =>
            r.kind.startsWith("skip:")
              ? `<div class="cf-skip">⋯ ${esc(r.kind.slice(5))}</div>`
              : `<div class="cf-row ${r.kind}"><pre class="${r.l === null ? "gap" : r.kind === "chg" ? "del" : ""}">${r.l === null ? "" : esc(r.l) || " "}</pre>
              <pre class="${r.r === null ? "gap" : r.kind === "chg" ? "add" : ""}">${r.r === null ? "" : esc(r.r) || " "}</pre></div>`,
          )
          .join("")}</div>`
      : `<p class="muted">${esc((mine as { error?: string }).error ?? (theirs as { error?: string }).error ?? "")} — compare is not available; pick which version to keep.</p>`;
    main.innerHTML = `
      <div class="cf-cols"><span><b>Current</b> · ${esc(c.original)}</span><span><b>Conflict copy</b> · ${esc(tsLabel(c.path))}</span></div>
      ${table}
      ${textual ? `<details class="cf-merge"><summary>Edit merged version</summary><textarea rows="10" spellcheck="false">${esc(mine as string)}</textarea></details>` : ""}
      <div class="cf-actions">
        <button class="btn" data-c="current" title="Delete the conflict copy">Keep current</button>
        <button class="btn" data-c="conflict" title="Replace the current file with the conflict copy">Keep conflict copy</button>
        <button class="btn ghost" data-c="both" title="Keep both files under normal names">Keep both</button>
        <div class="grow"></div>
        ${textual ? `<button class="btn primary" data-c="merged">Save merged</button>` : ""}
      </div>`;
  };

  el.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === el) return close();
    const item = t.closest<HTMLElement>("[data-i]");
    if (item) {
      current = +item.dataset.i!;
      renderList();
      return show();
    }
    const c = t.closest<HTMLElement>("[data-c]")?.dataset.c;
    if (!c) return;
    if (c === "close") return close();
    const conflict = list[current];
    const merged = c === "merged" ? el.querySelector<HTMLTextAreaElement>(".cf-merge textarea")!.value : undefined;
    if (c === "merged" && !el.querySelector<HTMLDetailsElement>(".cf-merge")!.open) {
      el.querySelector<HTMLDetailsElement>(".cf-merge")!.open = true;
      return toast("Edit the merged text below, then Save merged", "info");
    }
    try {
      await api.fsyncResolve(job.id, conflict.path, c as "current" | "conflict" | "both" | "merged", merged);
      toast("Resolved; syncing…", "ok");
      await load();
    } catch (err) {
      toast(String(err), "err");
    }
  });
  el.addEventListener("keydown", (e) => e.key === "Escape" && close());
  await load();
}
