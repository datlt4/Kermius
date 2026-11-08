# Release v1.40.0 — Security hardening

Branch: `security/hardening` (9 commits on top of v1.39.6). Full Rust unit suite: **49/49 passed**. `tsc --noEmit` clean, `vite build` clean, `npm audit` clean.

## What changed

**High**
- **CSP enabled** for the Tauri webview (`default-src 'self'` + IPC/asset only, separate `devCsp` for `tauri dev`). No remote content is ever loaded.
- **OSC 52 clipboard capped at ~1 MB** with a per-session warning toast, plus a Settings → Terminal toggle ("Remote clipboard", default on).
- **Plain-HTTP sync warning**: inline red warning + confirm dialog when the sync URL is `http://` to a non-localhost host (token travels in cleartext otherwise).
- **Secrets auto-clear**: host passwords and keychain secrets (private key, identity password) are wiped from the clipboard 30s after copying, and only if still unchanged.

**Medium**
- **Argon2id hardened** (m=64 MiB, t=3) for new sync blobs (`KMS2` magic). Old `KMS1` blobs stay readable (covered by `blob_v1_still_decodes` test). Web client mirrors both formats.
- **Host-key change dialog** now shows old vs new `SHA256:` fingerprints side-by-side, with guidance (reinstall vs DHCP-reassigned IP vs possible attack).
- **Nearby**: stable device identity (cert persisted `0600`, fingerprint survives restarts → TOFU works); only one unanswered transfer request at a time (spam/flood protection); incoming dialog shows the sender **IP** with a spoofing warning.
- **Terminal links** open in the system browser via a new allowlisted `open_external` command (http/https only); `opener` permissions declared in capabilities.
- **VNC clipboard**: editor now warns that focusing the tab sends the local clipboard to the remote.

**Low**
- SOCKS5 proxy rejects over-long user/host credentials instead of truncating bytes.
- `docker-compose`: `cap_drop: [ALL]` + `no-new-privileges`.
- CI: `npm audit --audit-level=high` gate on the sync-server job; fixed the one vite moderate advisory (0 vulnerabilities now).
- `.gitignore`: `.env`, keystores, `server/data/` can no longer be committed by accident.

## Breaking / action needed

- **Update ALL devices + server together.** New vault blobs use `KMS2`; older clients (< 1.40) cannot read them and will report an unrecognized vault format. Old `KMS1` blobs remain readable everywhere, and existing synced data migrates lazily on the next change (no forced re-upload).
- **Nearby fingerprint changes once**: the first 1.40 start generates and persists the stable identity. Peers will see one "new device", then it stays stable.
- **Not done (documented decision, not an oversight): auto-lock vault (old M6).** The desktop vault is sealed with a random device key, not a user passphrase, so a lock screen would be theater — unlocking needs no secret and the key is on the same disk. Real protection stays: OS account isolation + file permissions (0600) + full-disk encryption. A genuine lock would require an optional app passphrase (open item).

## Verify before publishing

1. `cargo test --lib` (49 passed here), `npx tsc --noEmit`, `npx vite build`.
2. Open the app: terminal, SSH connect, host-key mismatch card (shows Was/Now fingerprints), HTTP sync URL warning, clipboard auto-clear, OSC52 toggle.
3. Merge `security/hardening` → `main`, push, tag `v1.40.0` (tag created locally already).
