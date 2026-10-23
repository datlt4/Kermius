# Kermius — handoff (2026-10-23, cập nhật lần 6)

Repo: `/mnt/ssd_1tb/Downloads-Ubuntu/Miscellaneous/kermius` (Tauri 2, Rust backend in `src-tauri/`, TypeScript UI in `src/`).
Owner's language: Vietnamese. Replies to the owner in Vietnamese.

## 1. Branch, commit and release workflow

- `main` = released code only. `develop` = integration. Work on `feature/<x>` or `fix/<x>` from `develop`.
- Finished change: commit on the topic branch (no AI attribution in commits), then `git merge --no-ff` into `develop`, then `develop` into `main`, then `git tag -a vX.Y.Z`, then push `main develop vX.Y.Z` to **both** remotes `origin` (ssh 24.8.0.2:2222) and `github` (datlt4/Kermius). Delete the topic branch locally and on both remotes.
- Owner rule (2026-10-18): release automatically after every finished fix, without asking. Do not install to phones unless asked.
- Version bump on every release, in three files: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. `src-tauri/Cargo.lock` is stale (still `kermius 1.38.0`); cargo updates it on the next build.
- Tag push triggers `.github/workflows/release.yml` (desktop matrix, `mobile.yml` for APK + unsigned IPA, then a `publish` job builds `latest.json` and un-drafts the release). Check CI with the public API: `https://api.github.com/repos/datlt4/Kermius/actions/runs` (no token needed for reads).
- GitHub Actions đã được owner bật lại (2026-10-20). Release mới nhất: **v1.38.16**.
- Từ v1.38.14 version bump được commit trên `main` sau khi merge; `develop` đã được merge lại từ `main` nên hai nhánh cùng version. Giữ như vậy sau mỗi release (`git checkout develop && git merge main`, push cả hai remote). v1.38.12's release run was **cancelled** (superseded). v1.38.11 is a leftover draft and is not in the published list. v1.38.3, v1.38.9, v1.38.10 are missing from the published list; check on GitHub before assuming they exist.

## 2. Environment facts

- Dev PC: this machine. No `gh` CLI, no adb-connected phone right now. Rust builds and tests run on the Mac.
- **Không build local nữa** (owner yêu cầu dừng build local). Cache build `~/.cache/kermius-target`, `kermius-server-target`, `kermius-android-target`, `kermius-test-target` đã bị xóa (2026-10-19, khoảng 85 GB); lần build sau sẽ biên dịch lại từ đầu. Nếu cần build local, đặt `CARGO_TARGET_DIR` trỏ sang `/mnt/ssd_1tb` (còn trống ~435 GB) thay vì `~/.cache`.
- Disk `/` sau dọn: 322 GB dùng / 557 GB (61%), còn trống 210 GB. Phần chưa rõ: khoảng 140 GB không đọc được không có sudo (thư mục root, 78 chỗ `Permission denied`) hoặc file đã xóa nhưng còn process giữ. Muốn xem phải chạy `sudo du` (owner tự nhập mật khẩu).
- **Mac** (`koi-mabu`, user `mabu`, Intel, macOS 13.7.8, Xcode 15.2): reachable as `mabu-wg` (WireGuard 24.8.0.4), sometimes asleep or unreachable. Key auth from this PC was refused; the owner gave a password for it in chat. **Do not store it in files or commands beyond the single session.** Mac toolchain: `~/.cargo/bin`, checkout `~/kermius-dev` (copy of `src-tauri/src` pushed with tar + scp; run `cargo test` there in the background with `nohup sh -c "...; echo EXIT=\$? >> ~/ct.log"`, pexpect times out at 60 s).
- Helper scripts (outside repo, in scratchpad): `/tmp/claude-1000/mac_ssh.py '<cmd>'` and `/tmp/claude-1000/mac_scp.py <src> <dst>` (pexpect, answer password prompt). Recreate them if `/tmp` was cleared.
- Phones:
  - Android: Samsung SM-G885F, adb serial `486c6a0a`, attached to the **Mac** (adb at `~/Library/Android/sdk/platform-tools/adb`). Installed Kermius package `com.koi.kermius` 1.38.5 (install with `adb -s 486c6a0a install -r file.apk`; updates keep data). The PC has no adb device.
  - iPhone: "Koi's 11prm" (iPhone 11 Pro Max, iOS 17.7.1), CoreDevice id `EA9E9BF7-F309-45F9-94E7-EDD74612DDBD`, attached to the **Mac**. Installed `com.datlt4.kermius` 1.38.4 (1.38.5 not yet on it).
  - iOS install recipe (the CI IPA is unsigned and has bundle id `com.koi.kermius`; the device's installed app and the only profile are `com.datlt4.kermius`): on the Mac unzip the IPA, set `CFBundleIdentifier` to `com.datlt4.kermius`, copy the profile from `~/Library/MobileDevice/Provisioning Profiles/*` to `embedded.mobileprovision`, extract `Entitlements` from the profile with `security cms -D` + `plutil`, `security unlock-keychain` first, `codesign --force --sign D24BC7B1…C44C44 --entitlements ent.plist Kermius.app`, then `xcrun devicectl device install app --device <id> Kermius.app` and `xcrun devicectl device process launch`.
  - Android APK signing: CI signs with a secret keystore if `ANDROID_KEYSTORE_B64` is set, otherwise a throwaway key per run. 1.38.1 and 1.38.2 APKs have **different** signing certificates, so installs over a different-key build fail with "conflicts with existing package". Open item: set the keystore secret on GitHub (needs owner action; not done).

## 3. What shipped in this session (v1.37.0 → v1.38.13)

Grouped by area. Each line is a commit subject; see `git log` for detail.

**Mobile keyboard (v1.38.2):** `--vv-h` uses `min(visualViewport.height, innerHeight)`; `.kb-open` class removes the key-bar bottom padding; ⌨ button state syncs to real keyboard visibility via `visualViewport` resize (terminal.ts, top of file). Verified only by build/tsc — **not verified on a device**.

**Wake on LAN (v1.37.11 → v1.38.5):** devices synced in vault (`wol: Vec<WolDevice>`, `merge_items`); magic packet direct (UDP broadcast) or via SSH host on target LAN (`send_via`, Perl one-liner with `IO::Socket::INET`). v1.38.4 fixed `send at -e line 1` (packed sockaddr bug) — verified locally with a listener. iOS direct send from phone gave `No route to host (os error 65)` with Local Network permission already on; likely a full-tunnel VPN on the phone — not confirmed. Help section stays open across re-renders (v1.38.5). Form spacing and hint text (v1.38.3).

**Folder Sync (v1.37.2 → v1.38.13):**
- macOS remotes: Perl fallback for listing (v1.37.2); `-s` only for rsync < 3.2.4.
- Process-group kill of rsync (v1.37.9).
- Mac local rsync: app ignored Homebrew rsync because GUI PATH lacks `/usr/local/bin`; `rsync_bin()` now checks `/opt/homebrew/bin` and `/usr/local/bin` on macOS (v1.38.6). Verified by `cargo check`, not on the Mac app.
- Intervals now include 3 d, 5 d, week, 2 weeks, 3 weeks, month (v1.38.8).
- "Skip & retry" button for `Permission denied (13)` files: adds relative paths to Exclude and reruns (v1.38.8). While running it only saves; the running sync keeps its old list (v1.38.10).
- Disk full: `No space left on device` → "Destination disk is full…" as an error, not a partial warning (v1.38.8).
- Live log: `-i --info=progress2,name2` (v1.38.11) streams each file as rsync touches it; shows the last line under the progress bar; `is_item_line` in `foldersync.rs`. "building the file list" hint when empty.
- Settle gate: watcher waits until a folder is quiet 45 s, max 10 min (v1.38.12, `watch.rs` `SETTLE`/`MAX_WAIT`). rsync exit 23/24 with only "vanished" / `link_stat … No such file` errors counts as success (`only_vanished` in `files.rs`).
- Dev excludes preset: "Add dev excludes" (v1.38.13), `DEV_EXCLUDES` in `foldersync.ts`.

**Terminal:** OSC 52 handler so remote apps (opencode) can copy to the local clipboard (v1.38.7). Unverified with the real opencode TUI. Mouse-tracking apps need Shift+drag to select text in xterm.js.

**Release/CI:** `apply.sh` + Gradle `pluginManagement` for the Android build (v1.38.0).

**2026-10-20 (v1.38.14 → v1.38.16):**
- v1.38.14: Folder Sync status shows `· via <host>` while connecting/syncing (from the phase message). Nearby Share transfers carry `at` (unix ms, stamped in `Nearby::emit`) and show "5m ago / yesterday / date", full time on hover. Rust compiled by CI (`build develop` green on `b97a76a`).
- v1.38.15: Remote devices panel: "Syncing now" while a job runs; mirror destinations show "Mirror target · synced on schedule" instead of "Not watched" (they are never watched by design).
- v1.38.16: File manager (`src/files.ts`): click Name/Size/Modified to sort (folders first; same column flips order; Size/Modified start descending); fuzzy filter box per pane (typing in the list starts it, Esc clears, ↓/Enter selects the best match); transfer total uses listed file sizes, and for folders keeps rsync's estimate unless it moves >2%.

## 4. Tests and verification status

- `cargo test` on the Mac: 38/38 pass at v1.38.12 (includes `rsync_error`, `vanished_tests`, `item_lines_are_recognised`, `magic_packet_layout`, `wol_devices_sync_like_hosts`, `rsync_kill_tests`).
- `npx tsc --noEmit` passes on each release. `npm run build` passes.
- **Not verified on a real device or screen:** keyboard fix (Android/iOS), WOL help toggle, Folder Sync skip button, live log, dev excludes button, settle gate behaviour over days, OSC 52 copy with opencode, Nearby Share "can you see me" banner, Windows/macOS firewall commands, WOL relay on real hardware.

## 5. Open items / next steps

1. **Delete old GitHub releases** (owner confirmed "xóa luôn đi tôi oke"). Not done: no GitHub token available to the assistant (correctly refused to search for one). Script ready: `scratchpad/delete_old_releases.sh` (dry run by default, `--go` deletes; needs `gh auth login` on the owner's machine). Keep: 1.38.13, 1.37.11, 1.36.1, 1.35.0, 1.34.0, 1.33.0, 1.32.0, 1.30.0, 1.25.0, 1.18.1, 1.4.5. Delete: 1.38.0–1.38.8 (except 1.38.3 which may already be missing), 1.37.0–1.37.10, 1.36.0, 1.4.4. Tags stay.
2. Install latest on phones when the owner asks: Android APK 1.38.13 (check signing-key conflict first); iPhone IPA via the Mac recipe above.
3. Android keystore secret (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`) so APK updates stay signable — owner action on GitHub.
4. Remove the stuck NTFS `.fuse_hidden*` file in `long_dev2` (owner decided reboot or unmount; not done).
5. Keyboard regression check on Android and iOS (owner to test).
5a. Khi owner bật lại GitHub Actions: kiểm tra run `build`/`release` của `v1.38.13` và nhánh `develop` hiện tại có chạy xanh không (commit `ab7644d` là handoff). Nếu cần release mới, làm theo mục 1.
6b. **v1.38.17 (2026-10-21):** Folder Sync notifies each failure once per job (`notified` map in `src/foldersync.ts`; all offline variants count as one), cleared when a run succeeds. Before this, an offline remote produced a notice on every retry (×438).
6d. **v1.38.18 (2026-10-21):** Nearby Share "Clear" on Transfers (finished only, `clear-transfers` in `src/nearby.ts`); Ctrl+Shift+L opens a local terminal (Control on macOS too; not on web/iOS; xterm passes it through); notification panel "Delete after" select (Keep/12h/1d/2d/3d/5d, `kermius.notifications.ttl` in localStorage, pruned on every save and at load).
6h. **v1.38.22 (2026-10-23):** tab bar: `.tabbar` and `.tabs-scroll` carry `data-tauri-drag-region` (empty space moves the window; tabs and buttons stay clickable). Tab context menu adds "Close tabs to the right", "Close all tabs of <host>" (or all local terminals), "Close all tabs". SFTP (`src/files.ts`): eye button toggles dot-files for both panes (`kermius.files.hidden`), trash button deletes the selection, local "Upload to …" uses a new `upload` icon, transfers show speed (EMA from progress samples), time left and finish clock time.
6i. **Mini PC "Kermius was closed" (2026-10-23):** not a crash. `dpkg.log` + polkit show "Install and restart" was approved at 2026-10-22 02:17:25 (1.38.20 → 1.38.21); the app's scope ended at 02:17:29 and `app.restart()` did not bring it back. No coredump, no OOM, no reboot. Earlier updates restarted fine. Cause of the failed relaunch still unknown — watch for it; possible follow-up: verify the relaunch or show a "restart manually" hint.
6k. **v1.38.23 (2026-10-23):** one fuzzy matcher in `src/ui.ts` (`fuzzyScore`, `fuzzyBest`: every query word must match some field) used by host search (results ranked by score, then manual order), port-forwarding filter, route pickers, snippets (name fuzzy, script substring), fonts, ~/.ssh/config export, Folder Sync host picker, SFTP filter. Tabs are `draggable` on desktop; drop before/after reorders `state.sessions`. Settings → "On startup" → "Reopen the tabs from last time" (`kermius.restoreTabs`); open tabs are saved on every `renderTabs` as `kermius.lastTabs` (kind, local, host id, active index) and reopened after the vault loads; hosts that no longer exist are skipped; iOS skips local terminals.
6l. **Git remote change (2026-10-23):** pushing to `origin` (Gitea 24.8.0.2) fails with "Mirror Repository datlt4/kermius is read-only" — it now looks like a pull mirror of GitHub. Releases go to `github` only until the owner says otherwise.
6j. **Requested 2026-10-23, not done yet:** "Share via Kermius" from the OS share menu (macOS/Android/iOS/desktop); an API/CLI for other apps to open a local terminal (plan to be agreed with the owner).
6g. **v1.38.21 (2026-10-22):** iOS Nearby Share: after each received file, images (jpg/png/heic/gif/webp/tiff/bmp) and videos (mov/mp4/m4v/3gp) are also added to Photos via UIKit `UIImageWriteToSavedPhotosAlbum` / `UISaveVideoAtPathToSavedPhotosAlbum` on the main thread (`src-tauri/src/ios_photos.rs`); the original stays in Files › On My iPhone › Kermius. Needs `NSPhotoLibraryAddUsageDescription` (added in `mobile.yml`). Not compiled locally (owner stopped local builds) — the iOS CI job is the first compile; images are re-encoded by UIKit (metadata may be lost; PHPhotoLibrary would keep originals). Request dialog and save row show "Files › On My iPhone › Kermius" instead of the sandbox path; long paths wrap. `.btn.ghost:hover` was missing (ghost buttons never highlighted); fixed globally. Transfers "Clear" button no longer inherits the section heading's faint uppercase style.
6f. **v1.38.20 (2026-10-22):** the auto-delete picker left the notification panel (on phones it pushed "Mark all read"/"Clear" out of the panel) and moved to **Settings → Notifications**, with a toggle "Only delete read notifications" (`kermius.notifications.ttlReadOnly`). Changing either applies the rule at once and toasts how many were deleted (`setNotesTtl` in `src/notify.ts`). The settings-page pointerdown handler now closes any open `.font-menu`, not only the first.
6e. **v1.38.19:** the notification auto-delete picker reuses the font picker dropdown (`.font-pick`/`.font-menu`/`.font-item` classes) instead of a native `<select>`.
6c. **Open bug (update 2026-10-21):** confirmed fzf sometimes gets an extra Enter when it opens: `h` once printed `.-`, which is the first sorted history line, without any choice. `od -c` with 10 Enters on empty lines gave exactly 10 `\n`, so plain Enter is not doubled. Next test asked of owner: in `od -c`, type `h`+Enter 10 times with Unikey on (composition + Enter path). Weird 0-byte files `~/(\x13\r=` and `.lock` (2026-10-05) exist; not deleted.
6c-old. **Open bug: `h` (alias `cat ~/.bash_history -n | cut -c 8- | sort | uniq | fzf`) returns nothing in the Kermius *local* terminal on the owner's PC; works over SSH and in other terminals.** Ruled out: fzf version (0.29 everywhere), PTY setup (controlling tty, size, signals), login-shell config (a Python PTY with real HOME works), Kermius binary (a demo of the same 1.38.14 binary in Xvfb with a temp HOME works, also with ibus + Unikey). `echo test | fzf` prints `test` (exit 0), which would also happen if fzf got a stray Enter at start. Next: owner runs `type h` and `h; echo "exit=$?"` in the local terminal (exit 1 = stray Enter, 130 = Esc/Ctrl-C, 2 = error).
6a. **Waiting for owner decisions:**
   - Folder Sync: remember the host actually used per job side ("Connected via mini-wg · last sync 5m ago"), persisted or live-only? The route list in the panel is the candidates, not the chosen host; nothing records the chosen one today.
   - Speed test like Ookla: plan proposed (Cloudflare `speed.cloudflare.com` endpoints by default, Rust/reqwest, 4–6 parallel streams, ping/jitter/loaded latency, gauge page, history). Open: server choice, history local vs vault, desktop first or mobile too. Ookla's own servers only if their terms allow it.
6. Possible follow-ups the owner asked about but did not confirm: hard-exclude folders detected as churning (currently only waits for them to settle); show "rsync listing N entries" (rsync gives no count during the listing phase).
7. `Cargo.lock` version line out of date (`1.38.0`).
8. Nearby Share: iOS ↔ Android/desktop checks done in earlier sessions; the reach-check banner visual still unchecked.

## 6. Pitfalls seen

- `pkill -f` killed the shell itself several times; kill by PID or exe path.
- Demo instances: never click in the owner's real Kermius window; use a separate Xvfb display or netns for fake peers (a fake device on 127.0.0.2:53317 hit the owner's real app earlier).
- The Simulator and the iPhone share the owner's **real** vault (sync): never add or edit hosts there.
- NTFS disks: `.fuse_hidden` files keep a deleted-but-open file alive; rsync can fail on names with `: ? * " < > |`.
- Mac SSH password prompts: use pexpect; `sshpass` is not installed.
- Don't search the filesystem or environment for tokens or credentials; the auto-mode classifier blocks it, and that is the right call.
