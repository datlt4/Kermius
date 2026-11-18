// CI gate: fail on high/critical npm advisories, except documented unfixable ones.
// Usage: node .github/scripts/npm-audit-gate.mjs (exit 0 = pass, 1 = blocking).
import { execSync } from "node:child_process";

const IGNORED = new Map([
  // picomatch <=4.0.7 ReDoS (CVE-2026-112366): NO patched version exists upstream.
  // Our vite is build-time only (never ships: dist/ is static, node_modules is not
  // in the app or the sync image) and no attacker-controlled glob ever reaches
  // picomatch, so this is not exploitable in our pipeline. Remove when picomatch
  // publishes a fix (then `npm update picomatch` / vite will resolve it).
  ["GHSA-fc5q-39xc-vjpf", "picomatch ReDoS, no patched version; build-time only"],
]);

let out = "";
try {
  out = execSync("npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (e) {
  out = e.stdout?.toString?.() ?? "";
}
const audit = JSON.parse(out || "{}");
const ids = new Map(); // ghsa id -> package names that pull it in
for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
  if (!["high", "critical"].includes(v.severity)) continue;
  for (const x of v.via ?? []) {
    const m = typeof x === "object" && typeof x.url === "string" ? x.url.match(/GHSA-[a-z0-9-]+/) : null;
    if (!m) continue;
    if (!ids.has(m[0])) ids.set(m[0], new Set());
    ids.get(m[0]).add(name);
  }
}
const unhandled = [...ids.keys()].filter((id) => !IGNORED.has(id));
if (unhandled.length) {
  console.error("Blocking advisories:");
  for (const id of unhandled) console.error(` - ${id} (via ${[...ids.get(id)].join(", ")})`);
  process.exit(1);
}
console.log(`audit gate: pass (ignored: ${[...ids.keys()].join(", ") || "none"}).`);
