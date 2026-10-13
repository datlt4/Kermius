# Kermius

A fast, Termius-style SSH client built with Tauri 2 (Rust + TypeScript), with self-hosted, end-to-end encrypted sync.

![Kermius](docs/screenshot.png)

- Hosts organised by **groups** (folders) and **tags**, instant search (`Ctrl+K`)
- Multi-tab SSH terminals (xterm.js + WebGL), password / private key / keyboard-interactive auth
- **Copy password** from host cards, the right-click menu, the editor, or the terminal toolbar
- Local port forwarding rules per host
- Trust-on-first-use host key checking (synced across devices)
- Local vault encrypted at rest (XChaCha20-Poly1305)
- Sync to your own server; data is encrypted on-device with Argon2id(passphrase) — the server only sees ciphertext

## Develop

```sh
npm install
npx tauri dev
```

## Build

```sh
npx tauri build              # desktop bundles for the current OS
npx tauri android build      # needs Android SDK + NDK
npx tauri ios build          # needs macOS + Xcode
```

`.github/workflows/build.yml` builds Linux (x64 + arm64 / Raspberry Pi), Windows, macOS (universal), Android (APK) and iOS (when `APPLE_DEVELOPMENT_TEAM` is set), plus the sync server image.

## Import from Termix

Export hosts in Termix (JSON), then either use **Settings → Import from Termix**, or:

```sh
kermius --import-termix ~/termix-hosts.json
```

Groups, tags, passwords, keys, notes and local port-forward rules are kept. Re-importing updates hosts instead of duplicating them.

## Sync server

```sh
cd server
cp .env.example .env
sed -i "s/^KERMIUS_TOKEN=.*/KERMIUS_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d   # pulls hienanh/kermius-sync, listens on port 8080 (change KERMIUS_PORT in .env)
```

Put it behind HTTPS (Caddy, Traefik, nginx…). In Kermius → Settings → Sync, enter the server URL, the token and an encryption passphrase. Use the same passphrase on every device; it never leaves the device and lost passphrases cannot be recovered.

API: `GET /v1/vault` → blob + `x-version`; `PUT /v1/vault` with `x-base-version` (409 on conflict; the client re-pulls and merges per host by last update).

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+K` (`Ctrl+Shift+K` in a terminal) | Search hosts |
| `Ctrl+T` (`Ctrl+Shift+T` in a terminal) | Vault tab |
| `Ctrl+Shift+W` | Close terminal tab |
| `Ctrl+Tab` / `Ctrl+1…9` | Switch tabs |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in terminal |
| `Ctrl+S` / `Esc` | Save / close host editor |

## License

[MIT](LICENSE)
