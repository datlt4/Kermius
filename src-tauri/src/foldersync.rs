//! Folder Sync: two-way sync or one-way mirror between two folders (local disks or SSH hosts),
//! transferring with rsync. Two-way sync compares both sides with the state of the last sync to
//! tell additions, edits and deletions apart; edits on both sides keep both versions.
use crate::files::{bridge_shell, run_rsync};
use crate::model::{now_ms, Host, Vault};
use crate::ssh::{self, Client};
use crate::store::Store;
use russh::client::Handle;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Endpoint {
    /// "local" or "remote"
    pub kind: String,
    pub path: String,
    /// Remote only: host ids tried in order (e.g. wired, wifi, VPN routes to the same machine).
    pub hosts: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Job {
    pub id: String,
    pub name: String,
    /// "twoway" or "mirror" (a → b)
    pub mode: String,
    pub a: Endpoint,
    pub b: Endpoint,
    /// Mirror: delete files in b that no longer exist in a.
    pub delete: bool,
    /// Two-way, first run only: "a_to_b" / "b_to_a" make the target identical to the source
    /// (overwrite and delete extras); "merge" (or empty) unions both sides without deleting.
    pub initial: String,
    pub excludes: Vec<String>,
    /// Extra attributes to keep (off by default: NTFS/exFAT disks cannot store them).
    pub keep_perms: bool,
    pub keep_owner: bool,
    pub keep_specials: bool,
    /// Copy the files symlinks point to instead of the links themselves.
    pub follow_links: bool,
    /// Minutes between automatic runs while the app is open; 0 = manual.
    pub interval_min: u32,
    /// Sync automatically when files change on either side (while the app is open).
    pub watch: bool,
    pub last_run: i64,
    /// Last run attempt, successful or not (scheduling uses it so failures do not retry every minute).
    pub last_attempt: i64,
    pub last_result: String,
    /// Unresolved `.sync-conflict-` files after the last run (two-way only).
    pub conflicts: u32,
    /// Paused jobs are not watched or scheduled.
    pub paused: bool,
    /// Contents of each side after the last run.
    pub stats_a: Stats,
    pub stats_b: Stats,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
}

fn stats(t: &Tree) -> Stats {
    t.values().fold(Stats::default(), |mut s, m| {
        if m.dir {
            s.dirs += 1
        } else {
            s.files += 1;
            s.bytes += m.size;
        }
        s
    })
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Phase { phase: String, message: String },
    /// `rate` in bytes/s; `dir` is "up" (to a remote), "down" (from a remote) or "local".
    Progress { done: u64, total: u64, rate: u64, dir: String },
    /// Run finished (`ok` false: error or offline, see `summary`).
    Finished { ok: bool, summary: String },
    /// A file rsync is copying or deleting (itemized line), for the live log.
    Log { line: String },
    /// Scan progress for one side ("a"/"b"): entries counted so far.
    Scan { side: String, files: u64, dirs: u64, bytes: u64 },
    /// Change watcher state: "watching", "polling" (remote without inotifywait) or "offline".
    Watch { side: String, state: String, message: String },
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

/// An itemized change line from `-i` ("<f+++++++++ name") or a "*deleting name" line.
fn is_item_line(l: &str) -> bool {
    let b = l.as_bytes();
    (b.len() > 12 && b"<>ch.*".contains(&b[0]) && b[11] == b' ') || l.starts_with("*deleting")
}

fn phase(emit: &Emit, p: &str, m: impl Into<String>) {
    emit(Event::Phase { phase: p.into(), message: m.into() });
}

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Errors that mean "try again later" rather than "something is wrong".
pub const OFFLINE: &str = "OFFLINE: ";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub dir: bool,
    pub size: u64,
    pub mtime: i64,
}

/// Equal enough to skip: same kind, and for files same size and mtime within 2 s (FAT/exFAT).
fn same(a: &Meta, b: &Meta) -> bool {
    a.dir == b.dir && (a.dir || (a.size == b.size && (a.mtime - b.mtime).abs() <= 2))
}

type Tree = BTreeMap<String, Meta>;

// ---------- endpoints ----------

pub(crate) enum Side {
    Local(PathBuf),
    Remote { handle: Arc<Handle<Client>>, host: Host, path: String },
}

impl Side {
    fn rsync_root(&self) -> String {
        match self {
            Side::Local(p) => format!("{}/", p.to_string_lossy().trim_end_matches('/')),
            Side::Remote { path, .. } => format!("kermius:{}/", path.trim_end_matches('/')),
        }
    }

    fn label(&self) -> String {
        match self {
            Side::Local(p) => p.to_string_lossy().into_owned(),
            Side::Remote { host, path, .. } => format!("{}:{path}", host.name),
        }
    }
}

/// Single-quote for a POSIX shell.
pub(crate) fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub(crate) async fn exec(handle: &Handle<Client>, command: &str) -> Result<(Vec<u8>, String, u32), String> {
    let mut ch = handle.channel_open_session().await.map_err(e)?;
    ch.exec(true, command).await.map_err(e)?;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), 0);
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            _ => {}
        }
    }
    Ok((out, String::from_utf8_lossy(&err).trim().to_string(), code))
}

pub(crate) async fn open_side(store: &Arc<Store>, vault: &Vault, ep: &Endpoint, emit: &Emit) -> Result<Side, String> {
    if ep.kind != "remote" {
        let p = PathBuf::from(&ep.path);
        if !p.is_dir() {
            return Err(format!("{OFFLINE}{} not found (disk not mounted?)", ep.path));
        }
        return Ok(Side::Local(p));
    }
    let mut tried = Vec::new();
    for id in &ep.hosts {
        let Some(h) = vault.hosts.iter().find(|h| &h.id == id && !h.deleted) else { continue };
        let host = vault.resolve(h.clone());
        tried.push(host.name.clone());
        // Quick reachability probe before the (slower) SSH handshake.
        let probe = tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect((host.address.as_str(), host.port))).await;
        if !matches!(probe, Ok(Ok(_))) {
            continue;
        }
        phase(emit, "connecting", format!("via {}", host.name));
        match ssh::connect(store.clone(), &host, ssh::no_log()).await {
            Ok(handle) => {
                let handle = Arc::new(handle);
                let (_, err, code) = exec(&handle, &format!("mkdir -p {}", sh(&ep.path))).await?;
                if code != 0 {
                    return Err(format!("{}: {err}", host.name));
                }
                return Ok(Side::Remote { handle, host, path: ep.path.clone() });
            }
            Err(err) if err.starts_with(ssh::HOSTKEY_MISMATCH) => return Err(err),
            Err(_) => continue,
        }
    }
    Err(format!("{OFFLINE}no route to the remote (tried {})", if tried.is_empty() { "nothing".into() } else { tried.join(", ") }))
}

// ---------- scanning ----------

/// Glob with `*` and `?`; patterns without `/` match any path component.
fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && glob(p, &s[1..])),
        (Some(b'?'), Some(_)) => glob(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}

fn excluded(rel: &str, excludes: &[String]) -> bool {
    rel.split('/').any(|c| c == ".rsync-partial")
        || excludes.iter().map(|x| x.trim().trim_matches('/')).filter(|x| !x.is_empty()).any(|x| {
            if x.contains('/') { glob(x.as_bytes(), rel.as_bytes()) } else { rel.split('/').any(|c| glob(x.as_bytes(), c.as_bytes())) }
        })
}

/// Throttled scan-progress reporter (about 4 updates per second).
struct ScanProgress<'a> {
    report: &'a (dyn Fn(Stats) + Send + Sync),
    stats: Stats,
    last: std::time::Instant,
}

impl ScanProgress<'_> {
    fn add(&mut self, m: &Meta) {
        if m.dir {
            self.stats.dirs += 1
        } else {
            self.stats.files += 1;
            self.stats.bytes += m.size;
        }
        if self.last.elapsed() >= Duration::from_millis(250) {
            self.last = std::time::Instant::now();
            (self.report)(self.stats);
        }
    }
}

/// Set when the async side of a scan is dropped (job stopped/paused), so the blocking walk ends too.
#[derive(Clone, Default)]
struct Cancel(Arc<std::sync::atomic::AtomicBool>);

impl Cancel {
    fn is_set(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct CancelOnDrop(Cancel);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0 .0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn scan_local(root: &Path, excludes: &[String], follow: bool, report: &(dyn Fn(Stats) + Send + Sync)) -> Result<Tree, String> {
    scan_local_cancellable(root, excludes, follow, report, &Cancel::default())
}

fn scan_local_cancellable(
    root: &Path,
    excludes: &[String],
    follow: bool,
    report: &(dyn Fn(Stats) + Send + Sync),
    cancel: &Cancel,
) -> Result<Tree, String> {
    walk(root, vec![root.to_path_buf()], excludes, follow, report, cancel)
}

/// Walk `start` folders (inside `root`); keys are relative to `root`, so excludes match the full path.
fn walk(root: &Path, start: Vec<PathBuf>, excludes: &[String], follow: bool, report: &(dyn Fn(Stats) + Send + Sync), cancel: &Cancel) -> Result<Tree, String> {
    let mut tree = Tree::new();
    let mut progress = ScanProgress { report, stats: Stats::default(), last: std::time::Instant::now() };
    let mut stack = start;
    while let Some(dir) = stack.pop() {
        if cancel.is_set() {
            return Err("Stopped".into());
        }
        for d in std::fs::read_dir(&dir).map_err(e)? {
            let d = d.map_err(e)?;
            let p = d.path();
            let rel = p.strip_prefix(root).map_err(e)?.to_string_lossy().replace('\\', "/");
            if excluded(&rel, excludes) {
                continue;
            }
            // Following links: describe the target (what rsync -L copies); broken links are skipped.
            let m = if follow {
                match std::fs::metadata(&p) {
                    Ok(m) => m,
                    Err(_) => continue,
                }
            } else {
                std::fs::symlink_metadata(&p).map_err(e)?
            };
            let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
            let dir_ = m.is_dir();
            let meta = Meta { dir: dir_, size: if dir_ { 0 } else { m.len() }, mtime };
            progress.add(&meta);
            tree.insert(rel, meta);
            if dir_ {
                stack.push(p);
            }
        }
    }
    if cancel.is_set() {
        return Err("Stopped".into());
    }
    (progress.report)(progress.stats);
    Ok(tree)
}

/// Shell command listing `starts` (paths below `path`) as `kind\tsize\tmtime\tpath\0` records:
/// GNU find where available, else Perl (macOS / BSD find has no -printf).
fn find_cmd(path: &str, follow: bool, starts: &str) -> String {
    const PERL: &str = r#"use File::Find; my $l = shift; find({ no_chdir => 1, follow_fast => $l, wanted => sub { return if $_ eq "."; my @s = $l ? stat($_) : lstat($_); return unless @s; my $t = -d _ ? "d" : !$l && -l _ ? "l" : "f"; print "$t\t$s[7]\t$s[9]\t$_\0" } }, @ARGV)"#;
    format!(
        "cd {} && if find --version >/dev/null 2>&1; then find {}{}{} \\( -type f -o -type d -o -type l \\) -printf '%y\\t%s\\t%T@\\t%p\\0'; else LC_ALL=C perl -e {} {} {}; fi",
        sh(path),
        if follow { "-L " } else { "" },
        starts,
        // The root itself is not an entry; explicit start paths are.
        if starts == "." { " -mindepth 1" } else { "" },
        sh(PERL),
        follow as u8,
        starts
    )
}

/// The remote tree streamed over SSH, so progress can be reported while the remote walks it.
async fn scan_remote(handle: &Handle<Client>, path: &str, excludes: &[String], follow: bool, report: &(dyn Fn(Stats) + Send + Sync)) -> Result<Tree, String> {
    remote_find(handle, &find_cmd(path, follow, "."), excludes, report).await
}

/// Run a `find -printf '%y\t%s\t%T@\t<path>\0'` command; paths may start with "./".
async fn remote_find(handle: &Handle<Client>, cmd: &str, excludes: &[String], report: &(dyn Fn(Stats) + Send + Sync)) -> Result<Tree, String> {
    let mut ch = handle.channel_open_session().await.map_err(e)?;
    ch.exec(true, cmd).await.map_err(e)?;
    let mut tree = Tree::new();
    let mut progress = ScanProgress { report, stats: Stats::default(), last: std::time::Instant::now() };
    let (mut pending, mut err, mut code) = (Vec::<u8>::new(), Vec::new(), 0);
    let take = |rec: &[u8], tree: &mut Tree, progress: &mut ScanProgress| {
        let rec = String::from_utf8_lossy(rec);
        let mut f = rec.splitn(4, '\t');
        let (Some(kind), Some(size), Some(mtime), Some(rel)) = (f.next(), f.next(), f.next(), f.next()) else { return };
        let rel = rel.strip_prefix("./").unwrap_or(rel);
        if excluded(rel, excludes) {
            return;
        }
        let dir = kind == "d";
        let mtime = mtime.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let meta = Meta { dir, size: if dir { 0 } else { size.parse().unwrap_or(0) }, mtime };
        progress.add(&meta);
        tree.insert(rel.to_string(), meta);
    };
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                pending.extend_from_slice(&data);
                while let Some(i) = pending.iter().position(|b| *b == 0) {
                    let rec: Vec<u8> = pending.drain(..=i).collect();
                    take(&rec[..rec.len() - 1], &mut tree, &mut progress);
                }
            }
            ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            _ => {}
        }
    }
    if code != 0 {
        return Err(format!("remote scan failed: {}", String::from_utf8_lossy(&err).trim()));
    }
    (progress.report)(progress.stats);
    Ok(tree)
}

async fn scan(side: &Side, job: &Job, label: &str, emit: &Emit) -> Result<Tree, String> {
    let (excludes, follow) = (&job.excludes, job.follow_links);
    let cancel = Cancel::default();
    let _guard = CancelOnDrop(cancel.clone());
    let (em, label, c) = (emit.clone(), label.to_string(), cancel.clone());
    // A stopped scan must not keep reporting numbers for the job.
    let report = move |s: Stats| {
        if !c.is_set() {
            em(Event::Scan { side: label.clone(), files: s.files, dirs: s.dirs, bytes: s.bytes })
        }
    };
    match side {
        Side::Local(p) => {
            let (p, x) = (p.clone(), excludes.to_vec());
            tokio::task::spawn_blocking(move || scan_local_cancellable(&p, &x, follow, &report, &cancel)).await.map_err(e)?
        }
        Side::Remote { handle, path, .. } => scan_remote(handle, path, excludes, follow, &report).await,
    }
}

// ---------- planning ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub copy_ab: Vec<String>,
    pub copy_ba: Vec<String>,
    pub delete_a: Vec<String>,
    pub delete_b: Vec<String>,
    /// (path, winner side "a"/"b"): the loser's file is kept as a `.sync-conflict-…` copy.
    pub conflicts: Vec<(String, String)>,
    /// Folder entries in the lists above (summaries count files only).
    #[serde(skip)]
    pub dirs: BTreeSet<String>,
    /// Conflict copies present after the run.
    #[serde(skip)]
    pub open_conflicts: u32,
    /// Side contents after the run (a, b).
    #[serde(skip)]
    pub stats: Option<(Stats, Stats)>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.copy_ab.is_empty() && self.copy_ba.is_empty() && self.delete_a.is_empty() && self.delete_b.is_empty() && self.conflicts.is_empty()
    }
}

pub fn plan_twoway(a: &Tree, b: &Tree, state: &Tree) -> Plan {
    let mut plan = Plan { dirs: a.iter().chain(b.iter()).filter(|(_, m)| m.dir).map(|(p, _)| p.clone()).collect(), ..Default::default() };
    let changed = |p: &str, m: &Meta| state.get(p).is_none_or(|s| !same(s, m));
    let paths: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    for p in paths {
        match (a.get(p), b.get(p)) {
            (Some(ma), Some(mb)) => {
                if same(ma, mb) || (ma.dir && mb.dir) {
                    continue;
                }
                match (changed(p, ma), changed(p, mb)) {
                    (true, false) => plan.copy_ab.push(p.clone()),
                    (false, true) => plan.copy_ba.push(p.clone()),
                    _ => plan.conflicts.push((p.clone(), if ma.mtime >= mb.mtime { "a" } else { "b" }.into())),
                }
            }
            // Deleted on the other side only if it was synced before and is unchanged here.
            (Some(ma), None) => {
                if state.get(p).is_some_and(|s| same(s, ma)) { plan.delete_a.push(p.clone()) } else { plan.copy_ab.push(p.clone()) }
            }
            (None, Some(mb)) => {
                if state.get(p).is_some_and(|s| same(s, mb)) { plan.delete_b.push(p.clone()) } else { plan.copy_ba.push(p.clone()) }
            }
            (None, None) => {}
        }
    }
    // Never delete a folder that still receives files.
    let keep = |dels: &mut Vec<String>, copies: &[String]| dels.retain(|d| !copies.iter().any(|c| c.starts_with(&format!("{d}/"))));
    keep(&mut plan.delete_a, &plan.copy_ab);
    keep(&mut plan.delete_b, &plan.copy_ba);
    plan
}

/// Make `dst` match `src`: copy what differs, optionally delete what `src` lacks.
fn mirror_plan(src: &Tree, dst: &Tree, delete: bool) -> Plan {
    Plan {
        dirs: src.iter().chain(dst.iter()).filter(|(_, m)| m.dir).map(|(p, _)| p.clone()).collect(),
        copy_ab: src.iter().filter(|(p, m)| dst.get(*p).is_none_or(|n| !same(m, n))).map(|(p, _)| p.clone()).collect(),
        delete_b: if delete { dst.keys().filter(|p| !src.contains_key(*p)).cloned().collect() } else { vec![] },
        ..Default::default()
    }
}

/// The two-way state after a sync: paths present and equal on both sides.
fn common(a: &Tree, b: &Tree) -> Tree {
    a.iter().filter(|(p, m)| b.get(*p).is_some_and(|n| same(m, n))).map(|(p, m)| (p.clone(), *m)).collect()
}

fn conflict_name(rel: &str) -> String {
    let ts = chrono_like_now();
    match rel.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/{}", conflict_file(file, &ts)),
        None => conflict_file(rel, &ts),
    }
}

fn conflict_file(file: &str, ts: &str) -> String {
    match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}.sync-conflict-{ts}.{ext}"),
        _ => format!("{file}.sync-conflict-{ts}"),
    }
}

/// UTC timestamp `YYYYMMDD-HHMMSS` without a date crate.
fn chrono_like_now() -> String {
    let secs = now_ms() / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------- conflict resolution ----------

/// `dir/note.sync-conflict-20261014-093015.md` → `dir/note.md`.
pub fn conflict_original(rel: &str) -> Option<String> {
    let (dir, file) = rel.rsplit_once('/').map_or(("", rel), |(d, f)| (d, f));
    let i = file.find(".sync-conflict-")?;
    let rest = &file[i + ".sync-conflict-".len()..];
    let ts = rest.get(..15)?;
    if !ts.bytes().enumerate().all(|(k, b)| if k == 8 { b == b'-' } else { b.is_ascii_digit() }) {
        return None;
    }
    let name = format!("{}{}", &file[..i], &rest[15..]);
    Some(if dir.is_empty() { name } else { format!("{dir}/{name}") })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub path: String,
    pub original: String,
    pub original_exists: bool,
    pub size: u64,
    pub mtime: i64,
}

/// The job's local folder (conflict copies are synced to both sides, so one is enough).
pub fn local_root(job: &Job) -> Option<PathBuf> {
    [&job.a, &job.b].into_iter().find(|e| e.kind != "remote").map(|e| PathBuf::from(&e.path))
}

pub fn list_conflicts(job: &Job) -> Result<Vec<Conflict>, String> {
    let root = local_root(job).ok_or("No local folder")?;
    if !root.is_dir() {
        return Err(format!("{OFFLINE}{} not found", root.to_string_lossy()));
    }
    let tree = scan_local(&root, &job.excludes, job.follow_links, &|_| {})?;
    Ok(tree
        .iter()
        .filter(|(_, m)| !m.dir)
        .filter_map(|(p, m)| {
            conflict_original(p).map(|o| Conflict { original_exists: tree.contains_key(&o), path: p.clone(), original: o, size: m.size, mtime: m.mtime })
        })
        .collect())
}

/// Syncthing `.stignore` → Kermius exclude patterns (negations and includes are skipped).
pub fn import_stignore(dir: &str) -> Result<(Vec<String>, usize), String> {
    let text = std::fs::read_to_string(Path::new(dir).join(".stignore")).map_err(|err| format!(".stignore: {err}"))?;
    let (mut out, mut skipped) = (Vec::new(), 0);
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let p = line.trim_start_matches("(?d)").trim_start_matches("(?i)");
        if p.starts_with('!') || p.starts_with("#include") {
            skipped += 1;
            continue;
        }
        let p = p.replace("**", "*");
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    Ok((out, skipped))
}

/// Resolve a path inside the job's local folder, refusing `..` escapes.
pub fn local_file(job: &Job, rel: &str) -> Result<PathBuf, String> {
    if rel.split('/').any(|c| c == ".." || c.is_empty()) || rel.starts_with('/') {
        return Err("Invalid path".into());
    }
    Ok(local_root(job).ok_or("No local folder")?.join(rel))
}

/// Text content for the diff view (refuses large or binary files).
pub fn read_text(job: &Job, rel: &str) -> Result<String, String> {
    let p = local_file(job, rel)?;
    let meta = std::fs::metadata(&p).map_err(e)?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("File is too large to compare here".into());
    }
    let bytes = std::fs::read(p).map_err(e)?;
    if bytes.contains(&0) {
        return Err("Binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "Not a UTF-8 text file".into())
}

/// `current`: keep the original, drop the copy. `conflict`: the copy replaces the original.
/// `both`: keep both under a normal name. `merged`: write `merged` to the original, drop the copy.
pub fn resolve(job: &Job, rel: &str, action: &str, merged: Option<String>) -> Result<(), String> {
    let copy = local_file(job, rel)?;
    let original_rel = conflict_original(rel).ok_or("Not a conflict file")?;
    let original = local_file(job, &original_rel)?;
    match action {
        "current" => std::fs::remove_file(&copy).map_err(e),
        "conflict" => std::fs::rename(&copy, &original).map_err(e),
        "both" => {
            let ts = &rel[rel.find(".sync-conflict-").unwrap() + 15..][..15];
            let name = original.file_name().unwrap().to_string_lossy().into_owned();
            let kept = match name.rsplit_once('.') {
                Some((stem, ext)) if !stem.is_empty() => format!("{stem} (conflict {ts}).{ext}"),
                _ => format!("{name} (conflict {ts})"),
            };
            std::fs::rename(&copy, copy.with_file_name(kept)).map_err(e)
        }
        "merged" => {
            std::fs::write(&original, merged.ok_or("Nothing to save")?).map_err(e)?;
            std::fs::remove_file(&copy).map_err(e)
        }
        _ => Err("Unknown action".into()),
    }
}

// ---------- executing ----------

async fn rename(side: &Side, from: &str, to: &str) -> Result<(), String> {
    match side {
        Side::Local(root) => std::fs::rename(root.join(from), root.join(to)).map_err(e),
        Side::Remote { handle, path, .. } => {
            let (_, err, code) = exec(handle, &format!("cd {} && mv -- {} {}", sh(path), sh(from), sh(to))).await?;
            if code == 0 { Ok(()) } else { Err(err) }
        }
    }
}

/// Delete files, then now-empty folders deepest first.
async fn delete(side: &Side, rels: &[String], tree: &Tree) -> Result<(), String> {
    let (mut dirs, files): (Vec<&String>, Vec<&String>) = rels.iter().partition(|r| tree.get(*r).is_some_and(|m| m.dir));
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    match side {
        Side::Local(root) => {
            for f in files {
                let _ = std::fs::remove_file(root.join(f));
            }
            for d in dirs {
                let _ = std::fs::remove_dir(root.join(d));
            }
            Ok(())
        }
        Side::Remote { handle, path, .. } => {
            for chunk in files.chunks(200) {
                let args: Vec<String> = chunk.iter().map(|f| sh(f)).collect();
                exec(handle, &format!("cd {} && rm -f -- {}", sh(path), args.join(" "))).await?;
            }
            for chunk in dirs.chunks(200) {
                let args: Vec<String> = chunk.iter().map(|d| sh(d)).collect();
                exec(handle, &format!("cd {} && rmdir -- {} 2>/dev/null; true", sh(path), args.join(" "))).await?;
            }
            Ok(())
        }
    }
}

/// rsync attribute flags for a job.
/// `-s` keeps remote paths with spaces intact, but old servers (macOS ships rsync 2.6.9) reject
/// it; rsync 3.2.4+ escapes such paths by default, so it is only needed with older clients.
fn protect_args() -> Option<String> {
    static OLD_CLIENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let old = *OLD_CLIENT.get_or_init(|| {
        let out = std::process::Command::new(crate::files::rsync_bin()).arg("--version").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let ver: Vec<u32> = out.split_whitespace().skip_while(|w| *w != "version").nth(1).unwrap_or("0").split('.').filter_map(|n| n.parse().ok()).collect();
        (ver.first().copied().unwrap_or(0), ver.get(1).copied().unwrap_or(0), ver.get(2).copied().unwrap_or(0)) < (3, 2, 4)
    });
    old.then(|| "-s".to_string())
}

fn attr_flags(job: &Job) -> Vec<String> {
    let mut f = vec![if job.follow_links { "-rLt" } else { "-rlt" }.to_string()];
    if job.keep_perms {
        f.push("-p".into());
    }
    if job.keep_owner {
        f.push("-og".into());
    }
    if job.keep_specials {
        f.push("-D".into());
    }
    f
}

async fn copy(from: &Side, to: &Side, rels: &[String], job: &Job, emit: &Emit) -> Result<(), String> {
    if rels.is_empty() {
        return Ok(());
    }
    let list = std::env::temp_dir().join(format!("kermius-sync-{}.list", uuid::Uuid::new_v4()));
    let mut buf = Vec::new();
    for r in rels {
        buf.extend_from_slice(r.as_bytes());
        buf.push(0);
    }
    std::fs::write(&list, buf).map_err(e)?;
    let mut args = attr_flags(job);
    args.extend(protect_args());
    args.extend(["--partial-dir=.rsync-partial", "--info=progress2", "--from0"].map(String::from));
    args.push(format!("--files-from={}", list.to_string_lossy()));
    let remote = [from, to].into_iter().find_map(|s| match s {
        Side::Remote { host, .. } => Some(host.id.clone()),
        Side::Local(_) => None,
    });
    if let Some(id) = remote {
        args.push("-e".into());
        args.push(bridge_shell(&id)?);
    }
    args.push(from.rsync_root());
    args.push(to.rsync_root());
    let dir = match (from, to) {
        (_, Side::Remote { .. }) => "up",
        (Side::Remote { .. }, _) => "down",
        _ => "local",
    };
    let em = emit.clone();
    let started = std::time::Instant::now();
    let result = run_rsync(
        args,
        move |done, total| {
            let secs = started.elapsed().as_secs_f64().max(0.001);
            em(Event::Progress { done, total, rate: (done as f64 / secs) as u64, dir: dir.into() })
        },
        |_| {},
    )
    .await;
    let _ = std::fs::remove_file(list);
    result.map(|_| ())
}

// ---------- jobs ----------

fn state_path(store: &Store, id: &str) -> PathBuf {
    store.dir().join("foldersync").join(format!("{id}.json"))
}

fn load_state(store: &Store, id: &str) -> Tree {
    std::fs::read(state_path(store, id)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(store: &Store, id: &str, tree: &Tree) -> Result<(), String> {
    let p = state_path(store, id);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(e)?;
    std::fs::write(p, serde_json::to_vec(tree).map_err(e)?).map_err(e)
}

pub fn forget_state(store: &Store, id: &str) {
    let _ = std::fs::remove_file(state_path(store, id));
}

/// Refuse to propagate "everything was deleted" when one side looks unmounted or wiped.
fn guard_empty(side: &Side, tree: &Tree, other: &Tree, synced_before: bool) -> Result<(), String> {
    if tree.is_empty() && !other.is_empty() && synced_before {
        return Err(format!("{} is empty although it was synced before; stopped to protect your files (disk not mounted?)", side.label()));
    }
    Ok(())
}

pub fn validate(job: &Job) -> Result<(), String> {
    if job.a.path.trim().is_empty() || job.b.path.trim().is_empty() {
        return Err("Both folders are required".into());
    }
    if job.a.kind == "remote" && job.b.kind == "remote" {
        return Err("At least one side must be a local folder".into());
    }
    for ep in [&job.a, &job.b] {
        if ep.kind == "remote" && ep.hosts.is_empty() {
            return Err("Pick at least one host for the remote folder".into());
        }
    }
    Ok(())
}

/// Run (or preview with `dry_run`) a job. Returns a one-line summary.
pub async fn run(store: Arc<Store>, job: Job, dry_run: bool, emit: Emit) -> Result<(String, Plan), String> {
    validate(&job)?;
    let vault = store.state.lock().vault.clone();
    phase(&emit, "connecting", "");
    let a = open_side(&store, &vault, &job.a, &emit).await?;
    let b = open_side(&store, &vault, &job.b, &emit).await?;
    let via: Vec<String> = [&a, &b]
        .iter()
        .filter_map(|s| match s {
            Side::Remote { host, .. } => Some(host.name.clone()),
            Side::Local(_) => None,
        })
        .collect();
    if job.mode == "mirror" {
        return mirror(&a, &b, &job, dry_run, via.first(), &emit).await;
    }
    phase(&emit, "scanning", via.first().map(|v| format!("via {v}")).unwrap_or_default());
    let ta = scan(&a, &job, "a", &emit).await?;
    let tb = scan(&b, &job, "b", &emit).await?;

    let state = load_state(&store, &job.id);
    // First two-way run with a forced direction: make the target identical, then sync both ways from then on.
    if state.is_empty() && (job.initial == "a_to_b" || job.initial == "b_to_a") {
        let forward = job.initial == "a_to_b";
        let (src, dst, tsrc, tdst) = if forward { (&a, &b, &ta, &tb) } else { (&b, &a, &tb, &ta) };
        if tsrc.is_empty() && !tdst.is_empty() {
            return Err(format!("{} is empty; refusing to wipe {} (disk not mounted?)", src.label(), dst.label()));
        }
        let m = mirror_plan(tsrc, tdst, true);
        let mut plan = if forward { m } else { Plan { copy_ba: m.copy_ab, delete_a: m.delete_b, dirs: m.dirs, ..Default::default() } };
        if !dry_run {
            phase(&emit, "syncing", "first sync");
            let (copies, dels) = if forward { (&plan.copy_ab, &plan.delete_b) } else { (&plan.copy_ba, &plan.delete_a) };
            delete(dst, dels, tdst).await?;
            copy(src, dst, copies, &job, &emit).await?;
            let (na, nb) = (scan(&a, &job, "a", &emit).await?, scan(&b, &job, "b", &emit).await?);
            save_state(&store, &job.id, &common(&na, &nb))?;
            plan.stats = Some((stats(&na), stats(&nb)));
        }
        return Ok((summary(&plan), plan));
    }
    guard_empty(&a, &ta, &tb, !state.is_empty())?;
    guard_empty(&b, &tb, &ta, !state.is_empty())?;
    let mut plan = plan_twoway(&ta, &tb, &state);
    if dry_run {
        plan.stats = Some((stats(&ta), stats(&tb)));
        return Ok((summary(&plan), plan));
    }
    if !plan.is_empty() {
        phase(&emit, "syncing", "");
        execute_twoway(&a, &b, &ta, &tb, &mut plan, &job, &emit).await?;
    }
    let (na, nb) = (scan(&a, &job, "a", &emit).await?, scan(&b, &job, "b", &emit).await?);
    save_state(&store, &job.id, &common(&na, &nb))?;
    let names: BTreeSet<&String> = na.keys().chain(nb.keys()).filter(|p| conflict_original(p).is_some()).collect();
    plan.open_conflicts = names.len() as u32;
    plan.stats = Some((stats(&na), stats(&nb)));
    Ok((summary(&plan), plan))
}

/// Mirror a → b with a single rsync (it compares both sides itself; no separate scan).
async fn mirror(a: &Side, b: &Side, job: &Job, dry_run: bool, via: Option<&String>, emit: &Emit) -> Result<(String, Plan), String> {
    // An unmounted disk looks like an empty folder: never let --delete wipe the backup because of it,
    // not even on the first run (the destination may be an existing backup).
    if job.delete && is_empty_dir(a).await? && !is_empty_dir(b).await.unwrap_or(true) {
        return Err(format!("{} is empty but {} is not; stopped to protect your files (disk not mounted?)", a.label(), b.label()));
    }
    phase(emit, "syncing", via.map(|v| format!("via {v}")).unwrap_or_default());
    let mut args = attr_flags(job);
    args.extend(protect_args());
    // name2 lists unchanged files too (as "." itemized lines), so the live log follows rsync's position.
    args.extend(["-i", "--stats", "--partial-dir=.rsync-partial", "--info=progress2,name2"].map(String::from));
    if dry_run {
        args.push("-n".into());
    }
    if job.delete {
        args.push("--delete".into());
    }
    for x in job.excludes.iter().map(|x| x.trim()).filter(|x| !x.trim_matches('/').is_empty()) {
        // Same meaning as `excluded`: patterns with a slash are anchored at the folder root.
        let x = x.trim_matches('/');
        args.push(format!("--exclude={}{x}", if x.contains('/') { "/" } else { "" }));
    }
    if let Some(id) = [a, b].into_iter().find_map(|s| match s {
        Side::Remote { host, .. } => Some(host.id.clone()),
        Side::Local(_) => None,
    }) {
        args.push("-e".into());
        args.push(bridge_shell(&id)?);
    }
    args.push(a.rsync_root());
    args.push(b.rsync_root());
    let dir = if matches!(b, Side::Remote { .. }) { "up" } else if matches!(a, Side::Remote { .. }) { "down" } else { "local" };
    let em = emit.clone();
    let (log, started) = (emit.clone(), std::time::Instant::now());
    // Itemized lines ("<f+++ name") come as rsync copies each file; throttled so big trees don't flood the UI.
    let last_log = std::sync::Mutex::new(started - std::time::Duration::from_secs(1));
    let out = run_rsync(
        args,
        move |done, total| {
            let secs = started.elapsed().as_secs_f64().max(0.001);
            em(Event::Progress { done, total, rate: (done as f64 / secs) as u64, dir: dir.into() })
        },
        move |line| {
            if !is_item_line(line) {
                return;
            }
            let Ok(mut last) = last_log.lock() else { return };
            if last.elapsed() < std::time::Duration::from_millis(200) {
                return;
            }
            *last = std::time::Instant::now();
            log(Event::Log { line: line.to_string() });
        },
    )
    .await?;
    let mut plan = parse_itemized(&out);
    let sa = parse_stats(&out);
    // B holds everything in A (plus extras when not deleting, which rsync does not count).
    plan.stats = Some((sa, sa));
    Ok((summary(&plan), plan))
}

async fn is_empty_dir(side: &Side) -> Result<bool, String> {
    match side {
        Side::Local(p) => Ok(std::fs::read_dir(p).map_err(|err| format!("{}: {err}", p.display()))?.next().is_none()),
        Side::Remote { handle, path, .. } => {
            let (out, err, code) = exec(handle, &format!("find {} -mindepth 1 -maxdepth 1 -print -quit", sh(path))).await?;
            if code != 0 {
                return Err(format!("{path}: {}", err.trim()));
            }
            Ok(out.is_empty())
        }
    }
}

/// Plan from `rsync -i` lines ("<f+++++++++ path", "cd+++++++++ dir/", "*deleting   path").
fn parse_itemized(out: &str) -> Plan {
    let mut plan = Plan::default();
    for line in out.lines() {
        let (list, path) = if let Some(p) = line.strip_prefix("*deleting ") {
            (&mut plan.delete_b, p.trim_start())
        } else {
            let code = line.as_bytes();
            // Skip attribute-only updates ('.') and anything that is not an itemize line.
            if line.len() < 13 || code[11] != b' ' || !b"<>ch".contains(&code[0]) || !b"fdLDS".contains(&code[1]) {
                continue;
            }
            let p = &line[12..];
            (&mut plan.copy_ab, if code[1] == b'L' { p.split(" -> ").next().unwrap_or(p) } else { p })
        };
        let rel = path.trim_end_matches('/');
        if rel.is_empty() || rel == "." {
            continue;
        }
        if path.ends_with('/') {
            plan.dirs.insert(rel.to_string());
        }
        list.push(rel.to_string());
    }
    plan
}

/// Source contents from `--stats` ("Number of files: 1,234 (reg: 1,000, dir: 200, link: 34)", "Total file size: 5,678 bytes").
fn parse_stats(out: &str) -> Stats {
    let num = |s: &str| s.trim().split(|c: char| !c.is_ascii_digit() && c != ',').next().unwrap_or("").replace(',', "").parse::<u64>().unwrap_or(0);
    let mut st = Stats::default();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("Number of files: ") {
            let total = num(rest);
            let dirs = rest.split_once("dir: ").map_or(0, |(_, d)| num(d));
            // rsync counts the folder itself.
            st.dirs = dirs.saturating_sub(1);
            st.files = total - dirs;
        } else if let Some(rest) = line.strip_prefix("Total file size: ") {
            st.bytes = num(rest);
        }
    }
    st
}

/// Apply a two-way plan: keep conflict losers as `.sync-conflict-` copies, delete, then copy both ways.
async fn execute_twoway(a: &Side, b: &Side, ta: &Tree, tb: &Tree, plan: &mut Plan, job: &Job, emit: &Emit) -> Result<(), String> {
    let conflicts = std::mem::take(&mut plan.conflicts);
    for (p, winner) in &conflicts {
        let (loser, list) = if winner == "a" { (b, &mut plan.copy_ab) } else { (a, &mut plan.copy_ba) };
        let keep = conflict_name(p);
        rename(loser, p, &keep).await?;
        list.push(p.clone());
        // The renamed copy travels to the other side on this run as well.
        if winner == "a" { plan.copy_ba.push(keep) } else { plan.copy_ab.push(keep) }
    }
    plan.conflicts = conflicts;
    delete(a, &plan.delete_a, ta).await?;
    delete(b, &plan.delete_b, tb).await?;
    copy(a, b, &plan.copy_ab, job, emit).await?;
    copy(b, a, &plan.copy_ba, job, emit).await
}

/// Changed paths reduced to their topmost entries ("a/b" covers "a/b/c"); "" stands for everything.
fn collapse(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let set: BTreeSet<String> = paths.into_iter().map(|p| p.trim_matches('/').to_string()).collect();
    let mut out: Vec<String> = Vec::new();
    for p in set {
        if !out.iter().any(|q| q.is_empty() || p == *q || p.starts_with(&format!("{q}/"))) {
            out.push(p);
        }
    }
    out
}

fn under(p: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|x| x.is_empty() || p == x || p.starts_with(&format!("{x}/")))
}

/// Entries at and below `prefixes` on one side (missing paths are simply absent).
async fn scan_paths(side: &Side, job: &Job, prefixes: &[String]) -> Result<Tree, String> {
    let (excludes, follow) = (job.excludes.clone(), job.follow_links);
    match side {
        Side::Local(root) => {
            let (root, prefixes) = (root.clone(), prefixes.to_vec());
            tokio::task::spawn_blocking(move || {
                let (mut tree, mut dirs) = (Tree::new(), Vec::new());
                for p in &prefixes {
                    let full = root.join(p);
                    let m = if follow { std::fs::metadata(&full) } else { std::fs::symlink_metadata(&full) };
                    let Ok(m) = m else { continue };
                    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
                    tree.insert(p.clone(), Meta { dir: m.is_dir(), size: if m.is_dir() { 0 } else { m.len() }, mtime });
                    if m.is_dir() {
                        dirs.push(full);
                    }
                }
                tree.extend(walk(&root, dirs, &excludes, follow, &|_| {}, &Cancel::default())?);
                Ok(tree)
            })
            .await
            .map_err(e)?
        }
        Side::Remote { handle, path, .. } => {
            let mut tree = Tree::new();
            for chunk in prefixes.chunks(200) {
                let args: Vec<String> = chunk.iter().map(|p| sh(&format!("./{p}"))).collect();
                // Missing paths make find exit non-zero; whatever exists is still listed.
                let cmd = format!("{} 2>/dev/null; true", find_cmd(path, follow, &args.join(" ")));
                tree.extend(remote_find(handle, &cmd, &excludes, &|_| {}).await?);
            }
            Ok(tree)
        }
    }
}

/// Sync only what changed below `changed` paths (from the watchers); falls back to a full run when
/// the change set is unclear (the folder root, too many paths, or no two-way state yet).
pub async fn run_paths(store: Arc<Store>, job: Job, changed: Vec<String>, emit: Emit) -> Result<(String, Plan), String> {
    let prefixes = collapse(changed.into_iter().filter(|p| p.is_empty() || !excluded(p, &job.excludes)));
    if prefixes.is_empty() {
        return Ok(("Up to date".into(), Plan::default()));
    }
    let state = if job.mode == "mirror" { Tree::new() } else { load_state(&store, &job.id) };
    if prefixes.len() > MAX_PATHS || prefixes.iter().any(|p| p.is_empty()) || (job.mode != "mirror" && state.is_empty()) {
        return run(store, job, false, emit).await;
    }
    validate(&job)?;
    let vault = store.state.lock().vault.clone();
    phase(&emit, "connecting", "");
    let a = open_side(&store, &vault, &job.a, &emit).await?;
    let b = open_side(&store, &vault, &job.b, &emit).await?;
    // An emptied source means an unmounted disk, not "delete what changed": let the full run's guard decide.
    if job.mode == "mirror" && job.delete && is_empty_dir(&a).await? {
        return run(store, job, false, emit).await;
    }
    phase(&emit, "syncing", format!("{} changed path{}", prefixes.len(), if prefixes.len() == 1 { "" } else { "s" }));
    let (ta, tb) = (scan_paths(&a, &job, &prefixes).await?, scan_paths(&b, &job, &prefixes).await?);
    if job.mode == "mirror" {
        let plan = mirror_plan(&ta, &tb, job.delete);
        delete(&b, &plan.delete_b, &tb).await?;
        copy(&a, &b, &plan.copy_ab, &job, &emit).await?;
        return Ok((summary(&plan), plan));
    }
    let sub: Tree = state.iter().filter(|(p, _)| under(p, &prefixes)).map(|(p, m)| (p.clone(), *m)).collect();
    let mut plan = plan_twoway(&ta, &tb, &sub);
    execute_twoway(&a, &b, &ta, &tb, &mut plan, &job, &emit).await?;
    // Conflict copies sit next to the originals, possibly outside the prefixes: rescan them too.
    let rescan = collapse(prefixes.iter().cloned().chain(plan.copy_ab.iter().cloned()).chain(plan.copy_ba.iter().cloned()));
    let (na, nb) = (scan_paths(&a, &job, &rescan).await?, scan_paths(&b, &job, &rescan).await?);
    let mut next: Tree = state.into_iter().filter(|(p, _)| !under(p, &rescan)).collect();
    next.extend(common(&na, &nb));
    save_state(&store, &job.id, &next)?;
    plan.open_conflicts = job.conflicts + plan.conflicts.len() as u32;
    Ok((summary(&plan), plan))
}

/// Above this many changed paths a full run is cheaper than stat-ing each one.
const MAX_PATHS: usize = 2000;

fn summary(p: &Plan) -> String {
    if p.is_empty() {
        return "Up to date".into();
    }
    let mut parts = Vec::new();
    let files = |v: &Vec<String>| v.iter().filter(|x| !p.dirs.contains(*x)).count();
    let n = files(&p.copy_ab) + files(&p.copy_ba);
    if n > 0 {
        parts.push(format!("{n} copied"));
    }
    let d = files(&p.delete_a) + files(&p.delete_b);
    if d > 0 {
        parts.push(format!("{d} deleted"));
    }
    if !p.conflicts.is_empty() {
        parts.push(format!("{} conflicts kept", p.conflicts.len()));
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_lines_are_recognised() {
        assert!(is_item_line(">f+++++++++ photos/new.jpg"));
        assert!(is_item_line("<fc.T...... docs/a.txt"));
        assert!(is_item_line("*deleting   old/file.bin"));
        assert!(!is_item_line("        1,234,567  42%   10.5MB/s    0:00:03"));
        assert!(is_item_line(".f          same.txt"));
        assert!(!is_item_line("Number of files: 36,749"));
        assert!(!is_item_line(""));
    }

    /// The Perl fallback (macOS remotes) must list the same records as GNU find.
    #[cfg(target_os = "linux")]
    #[test]
    fn perl_find_matches_gnu_find() {
        let dir = std::env::temp_dir().join(format!("kermius-find-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/c.txt"), "hello").unwrap();
        std::fs::write(dir.join("top.bin"), [0u8; 3]).unwrap();
        std::os::unix::fs::symlink("top.bin", dir.join("link")).unwrap();
        let run = |cmd: String| {
            let out = std::process::Command::new("sh").arg("-c").arg(cmd).output().unwrap().stdout;
            let mut recs: Vec<String> = out
                .split(|b| *b == 0)
                .filter(|r| !r.is_empty())
                .map(|r| {
                    let r = String::from_utf8_lossy(r).replace("\t./", "\t");
                    // GNU prints fractional mtimes.
                    let f: Vec<&str> = r.split('\t').collect();
                    format!("{}\t{}\t{}\t{}", f[0], f[1], f[2].split('.').next().unwrap(), f[3])
                })
                .collect();
            recs.sort();
            recs
        };
        for (follow, starts) in [(false, "."), (true, "."), (false, "./a ./top.bin ./missing")] {
            let gnu = find_cmd(dir.to_str().unwrap(), follow, starts) + " 2>/dev/null; true";
            let perl = gnu.replace("find --version", "false");
            let (g, p) = (run(gnu), run(perl));
            assert!(!g.is_empty());
            assert_eq!(g, p, "follow={follow} starts={starts}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn m(size: u64, mtime: i64) -> Meta {
        Meta { dir: false, size, mtime }
    }

    #[test]
    fn plans_edits_deletes_and_conflicts() {
        let state: Tree = [("same", m(1, 10)), ("edit_a", m(1, 10)), ("del_on_b", m(1, 10)), ("both", m(1, 10))]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let a: Tree = [("same", m(1, 10)), ("edit_a", m(2, 20)), ("del_on_b", m(1, 10)), ("both", m(3, 30)), ("new_a", m(1, 5))]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let b: Tree = [("same", m(1, 10)), ("edit_a", m(1, 10)), ("both", m(4, 40)), ("new_b", m(1, 5))]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let p = plan_twoway(&a, &b, &state);
        assert_eq!(p.copy_ab, ["edit_a", "new_a"]);
        assert_eq!(p.copy_ba, ["new_b"]);
        assert_eq!(p.delete_a, ["del_on_b"]);
        assert!(p.delete_b.is_empty());
        assert_eq!(p.conflicts, [("both".to_string(), "b".to_string())]);
    }

    #[test]
    fn first_sync_never_deletes() {
        let a: Tree = [("x".to_string(), m(1, 1))].into();
        let p = plan_twoway(&a, &Tree::new(), &Tree::new());
        assert_eq!(p.copy_ab, ["x"]);
        assert!(p.delete_a.is_empty());
    }

    #[test]
    fn excludes_and_conflict_names() {
        assert!(excluded("a/node_modules/x.js", &["node_modules".into()]));
        assert!(excluded("x.tmp", &["*.tmp".into()]));
        assert!(!excluded("src/main.rs", &["*.tmp".into()]));
        assert!(conflict_name("dir/report.pdf").starts_with("dir/report.sync-conflict-"));
        assert!(conflict_name("dir/report.pdf").ends_with(".pdf"));
        assert_eq!(chrono_like_now().len(), 15);
        assert_eq!(conflict_original("dir/report.sync-conflict-20261014-093015.pdf").as_deref(), Some("dir/report.pdf"));
        assert_eq!(conflict_original("Makefile.sync-conflict-20261014-093015").as_deref(), Some("Makefile"));
        assert_eq!(conflict_original(&conflict_name("a/b.md")).as_deref(), Some("a/b.md"));
        assert!(conflict_original("notes.md").is_none());
        let j = Job { keep_perms: true, follow_links: true, ..Default::default() };
        assert_eq!(attr_flags(&j), ["-rLt", "-p"]);
        assert_eq!(attr_flags(&Job::default()), ["-rlt"]);
    }
}

/// Real folders: `cargo test foldersync_e2e`. With `KERMIUS_TEST_SSH="port|user|key"` and
/// `KERMIUS_BRIDGE_EXE=<kermius binary>` it also syncs against an sshd on 127.0.0.1.
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::model::Host;

    fn emit() -> Emit {
        Arc::new(|_| {})
    }

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    /// Bump mtime so edits within the same second are still seen as changes.
    fn touch_later(p: &Path, secs: u64) {
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(std::time::SystemTime::now() + Duration::from_secs(secs)).unwrap();
    }

    async fn scenario(store: Arc<Store>, mut job: Job, a: PathBuf, b: PathBuf) {
        write(&a.join("docs/one.txt"), "one");
        write(&b.join("photos/two.jpg"), "two");
        let (s, _) = run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(s, "2 copied");
        assert_eq!(std::fs::read_to_string(b.join("docs/one.txt")).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(a.join("photos/two.jpg")).unwrap(), "two");
        job.last_run = 1;

        // Edit on B comes back to A; delete on A propagates to B.
        write(&b.join("docs/one.txt"), "one v2");
        touch_later(&b.join("docs/one.txt"), 10);
        std::fs::remove_file(a.join("photos/two.jpg")).unwrap();
        let (_, plan) = run(store.clone(), job.clone(), true, emit()).await.unwrap();
        assert_eq!((plan.copy_ba.len(), plan.delete_b.len()), (1, 1));
        run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(std::fs::read_to_string(a.join("docs/one.txt")).unwrap(), "one v2");
        assert!(!b.join("photos/two.jpg").exists());

        // Both sides edit: newest wins, the other version is kept as a conflict copy on both sides.
        write(&a.join("docs/one.txt"), "A edit");
        touch_later(&a.join("docs/one.txt"), 20);
        write(&b.join("docs/one.txt"), "B edit!");
        touch_later(&b.join("docs/one.txt"), 30);
        let (s, _) = run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert!(s.contains("1 conflicts kept"), "{s}");
        assert_eq!(std::fs::read_to_string(a.join("docs/one.txt")).unwrap(), "B edit!");
        let conflict = |dir: &Path| std::fs::read_dir(dir.join("docs")).unwrap().filter_map(|d| d.ok()).any(|d| d.file_name().to_string_lossy().contains("sync-conflict"));
        assert!(conflict(&a) && conflict(&b));
        assert_eq!(run(store.clone(), job.clone(), false, emit()).await.unwrap().0, "Up to date");
    }

    #[tokio::test]
    async fn foldersync_e2e_local() {
        let tmp = std::env::temp_dir().join(format!("kermius-fs-{}", uuid::Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let job = Job { id: "j1".into(), mode: "twoway".into(), a: ep(&a), b: ep(&b), ..Default::default() };
        scenario(store.clone(), job.clone(), a.clone(), b.clone()).await;

        // Resolve the conflict with merged text; the next run spreads it and removes the copies.
        let list = list_conflicts(&job).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].original, "docs/one.txt");
        assert_eq!(read_text(&job, &list[0].path).unwrap(), "A edit");
        assert!(local_file(&job, "../etc/passwd").is_err());
        resolve(&job, &list[0].path, "merged", Some("merged text".into())).unwrap();
        let (_, plan) = run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(plan.open_conflicts, 0);
        assert_eq!(std::fs::read_to_string(b.join("docs/one.txt")).unwrap(), "merged text");
        assert!(list_conflicts(&job).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(b.join("docs")).unwrap().count(), 1);

        // A side that is suddenly empty (unmounted disk) must not wipe the other side.
        std::fs::remove_dir_all(&b).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let err = run(store.clone(), job.clone(), false, emit()).await.unwrap_err();
        assert!(err.contains("protect"), "{err}");
        assert!(a.join("docs/one.txt").exists());
        // Missing folder: offline, not an error.
        std::fs::remove_dir_all(&b).unwrap();
        assert!(run(store, job, false, emit()).await.unwrap_err().starts_with(OFFLINE));
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_e2e_initial_force() {
        let tmp = std::env::temp_dir().join(format!("kermius-fsi-{}", uuid::Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        write(&a.join("keep.txt"), "from A");
        write(&a.join("same.txt"), "same");
        write(&b.join("keep.txt"), "old B version");
        write(&b.join("only_b.txt"), "extra");
        std::fs::copy(a.join("same.txt"), b.join("same.txt")).unwrap();
        let t = std::fs::metadata(a.join("same.txt")).unwrap().modified().unwrap();
        std::fs::File::options().write(true).open(b.join("same.txt")).unwrap().set_modified(t).unwrap();
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let job = Job { id: "i1".into(), mode: "twoway".into(), initial: "a_to_b".into(), a: ep(&a), b: ep(&b), ..Default::default() };
        let (_, plan) = run(store.clone(), job.clone(), true, emit()).await.unwrap();
        assert_eq!(plan.copy_ab, ["keep.txt"]); // identical file is not copied again
        assert_eq!(plan.delete_b, ["only_b.txt"]);
        run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(std::fs::read_to_string(b.join("keep.txt")).unwrap(), "from A");
        assert!(!b.join("only_b.txt").exists());
        // Afterwards it is a normal two-way sync: a new file on B comes back to A.
        write(&b.join("later.txt"), "from B");
        run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(std::fs::read_to_string(a.join("later.txt")).unwrap(), "from B");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn foldersync_e2e_attrs() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("kermius-fsa-{}", uuid::Uuid::new_v4()));
        let a = tmp.join("a");
        write(&a.join("script.sh"), "#!/bin/sh");
        std::fs::set_permissions(a.join("script.sh"), std::fs::Permissions::from_mode(0o750)).unwrap();
        std::os::unix::fs::symlink("script.sh", a.join("link.sh")).unwrap();
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        for (name, keep_perms, follow_links) in [("plain", false, false), ("perms", true, false), ("follow", false, true)] {
            let b = tmp.join(name);
            std::fs::create_dir_all(&b).unwrap();
            let job = Job { id: name.into(), mode: "mirror".into(), a: ep(&a), b: ep(&b), keep_perms, follow_links, ..Default::default() };
            run(store.clone(), job.clone(), false, emit()).await.unwrap();
            let link = std::fs::symlink_metadata(b.join("link.sh")).unwrap();
            assert_eq!(link.file_type().is_symlink(), !follow_links, "{name}");
            if keep_perms {
                assert_eq!(mode(&b.join("script.sh")), 0o750);
            }
            // A second run finds nothing to do (no endless re-copy of links).
            assert_eq!(run(store.clone(), job, false, emit()).await.unwrap().0, "Up to date", "{name}");
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_e2e_stop_kills_rsync() {
        let tmp = std::env::temp_dir().join(format!("kermius-fss-{}", uuid::Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        std::fs::create_dir_all(&b).unwrap();
        write(&a.join("seed"), "x");
        for i in 0..3 {
            let f = std::fs::File::create(a.join(format!("big{i}"))).unwrap();
            f.set_len(1_500_000_000).unwrap(); // sparse, but rsync still copies 1.5 GB each
        }
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let job = Job { id: "s1".into(), mode: "mirror".into(), a: ep(&a), b: ep(&b), ..Default::default() };
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let em: Emit = Arc::new(move |ev| {
            if matches!(ev, Event::Progress { .. }) {
                let _ = started_tx.send(());
            }
        });
        let rsyncs = || std::process::Command::new("pgrep").args(["-f", &format!("rsync.*{}", b.to_string_lossy())]).output().unwrap().stdout.len();
        tokio::select! {
            _ = run(store, job, false, em) => panic!("finished before it could be stopped"),
            _ = started_rx.recv() => {} // dropping `run` here = Stop
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(rsyncs(), 0, "rsync still running after stop");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_e2e_mirror_direct() {
        let tmp = std::env::temp_dir().join(format!("kermius-fsx-{}", uuid::Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        write(&a.join("one.txt"), "1");
        write(&a.join("d/two.txt"), "22");
        write(&a.join("skip.log"), "x");
        write(&b.join("old.txt"), "x");
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let mut job = Job { id: "m1".into(), mode: "mirror".into(), a: ep(&a), b: ep(&b), delete: true, excludes: vec!["*.log".into()], ..Default::default() };
        let (_, mut plan) = run(store.clone(), job.clone(), true, emit()).await.unwrap();
        plan.copy_ab.sort();
        assert_eq!(plan.copy_ab, ["d", "d/two.txt", "one.txt"]);
        assert_eq!(plan.delete_b, ["old.txt"]);
        assert!(b.join("old.txt").exists(), "preview must not change anything");
        let (summary, plan) = run(store.clone(), job.clone(), false, emit()).await.unwrap();
        assert_eq!(summary, "2 copied, 1 deleted");
        assert_eq!(plan.stats.unwrap().0, Stats { files: 2, dirs: 1, bytes: 3 });
        assert!(!b.join("old.txt").exists() && !b.join("skip.log").exists());
        job.last_run = 1;
        assert_eq!(run(store.clone(), job.clone(), false, emit()).await.unwrap().0, "Up to date");
        // Source emptied (unmounted disk): refuse instead of wiping the backup, also on a first run.
        std::fs::remove_dir_all(&a).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        assert!(run(store.clone(), job.clone(), false, emit()).await.unwrap_err().contains("empty"));
        job.last_run = 0;
        assert!(run(store.clone(), job.clone(), false, emit()).await.unwrap_err().contains("empty"));
        assert!(b.join("one.txt").exists());
        // Empty source and empty destination: nothing to protect, so it runs.
        std::fs::create_dir_all(tmp.join("fresh")).unwrap();
        job.b = ep(&tmp.join("fresh"));
        assert_eq!(run(store.clone(), job, false, emit()).await.unwrap().0, "Up to date");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_e2e_incremental() {
        let tmp = std::env::temp_dir().join(format!("kermius-fsp-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(tmp.join("store")).unwrap());
        let ep = |p: &Path| Endpoint { kind: "local".into(), path: p.to_string_lossy().into(), hosts: vec![] };
        let paths = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // Mirror: only the named paths are looked at.
        let (a, b) = (tmp.join("ma"), tmp.join("mb"));
        write(&a.join("keep.txt"), "k");
        write(&a.join("gone.txt"), "g");
        let mut job = Job { id: "pm".into(), mode: "mirror".into(), a: ep(&a), b: ep(&b), delete: true, ..Default::default() };
        std::fs::create_dir_all(&b).unwrap();
        run(store.clone(), job.clone(), false, emit()).await.unwrap();
        job.last_run = 1;
        write(&a.join("new/deep/x.txt"), "x"); // new folder: copied with its contents
        write(&a.join("unrelated.txt"), "u"); // not reported: left for the next full run
        std::fs::remove_file(a.join("gone.txt")).unwrap();
        let (s, _) = run_paths(store.clone(), job.clone(), paths(&["new", "gone.txt"]), emit()).await.unwrap();
        assert_eq!(s, "1 copied, 1 deleted");
        assert!(b.join("new/deep/x.txt").exists() && !b.join("gone.txt").exists() && b.join("keep.txt").exists());
        assert!(!b.join("unrelated.txt").exists());
        // The folder root (or too much) means a full run.
        run_paths(store.clone(), job.clone(), paths(&[""]), emit()).await.unwrap();
        assert!(b.join("unrelated.txt").exists());

        // Two-way: edits, deletions and conflicts on the reported paths, state kept for the rest.
        let (a, b) = (tmp.join("ta"), tmp.join("tb"));
        write(&a.join("doc.txt"), "v1");
        write(&a.join("dir/f.txt"), "f");
        std::fs::create_dir_all(&b).unwrap();
        let job = Job { id: "pt".into(), mode: "twoway".into(), a: ep(&a), b: ep(&b), last_run: 1, ..Default::default() };
        run(store.clone(), job.clone(), false, emit()).await.unwrap();
        write(&b.join("doc.txt"), "v2-from-b");
        touch_later(&b.join("doc.txt"), 10);
        std::fs::remove_file(a.join("dir/f.txt")).unwrap();
        let (s, _) = run_paths(store.clone(), job.clone(), paths(&["doc.txt", "dir/f.txt"]), emit()).await.unwrap();
        assert_eq!(s, "1 copied, 1 deleted");
        assert_eq!(std::fs::read_to_string(a.join("doc.txt")).unwrap(), "v2-from-b");
        assert!(!b.join("dir/f.txt").exists());
        // Both sides edited: the older one is kept as a conflict copy on both sides.
        write(&a.join("doc.txt"), "edit-a");
        touch_later(&a.join("doc.txt"), 20);
        write(&b.join("doc.txt"), "edit-b");
        touch_later(&b.join("doc.txt"), 30);
        let (_, plan) = run_paths(store.clone(), job.clone(), paths(&["doc.txt"]), emit()).await.unwrap();
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(std::fs::read_to_string(a.join("doc.txt")).unwrap(), "edit-b");
        let copies = |d: &Path| std::fs::read_dir(d).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("sync-conflict")).count();
        assert_eq!((copies(&a), copies(&b)), (1, 1));
        // Nothing left to do afterwards (state was updated for the touched paths only).
        let (s, _) = run(store.clone(), job, true, emit()).await.unwrap();
        assert_eq!(s, "Up to date");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_scan_stops_when_dropped() {
        let tmp = std::env::temp_dir().join(format!("kermius-fsc-{}", uuid::Uuid::new_v4()));
        for i in 0..3000 {
            write(&tmp.join(format!("d{}/f{i}", i % 300)), "x");
        }
        let side = Side::Local(tmp.clone());
        let job = Job::default();
        let events = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ev = events.clone();
        let em: Emit = Arc::new(move |_| {
            ev.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        // Drop the scan almost immediately, like Pause does.
        let _ = tokio::time::timeout(Duration::from_millis(1), scan(&side, &job, "b", &em)).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        let after_stop = events.load(std::sync::atomic::Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(events.load(std::sync::atomic::Ordering::Relaxed), after_stop, "a stopped scan kept reporting");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[tokio::test]
    async fn foldersync_e2e_remote() {
        let (Ok(cfg), Ok(_)) = (std::env::var("KERMIUS_TEST_SSH"), std::env::var("KERMIUS_BRIDGE_EXE")) else { return };
        let [port, user, key] = cfg.split('|').collect::<Vec<_>>()[..] else { panic!() };
        // The bridge opens the vault from $XDG_DATA_HOME/<identifier>, so the test store lives there.
        let data = PathBuf::from(std::env::var("XDG_DATA_HOME").expect("set XDG_DATA_HOME for this test"));
        let store = Arc::new(Store::open(data.join(crate::IDENTIFIER)).unwrap());
        let host = |id: &str, addr: &str| Host {
            id: id.into(),
            name: id.into(),
            address: addr.into(),
            port: port.parse().unwrap(),
            username: user.into(),
            private_key: std::fs::read_to_string(key).unwrap(),
            ..Default::default()
        };
        // First route is unreachable: the job must fall back to the second one.
        store.state.lock().vault.hosts = vec![host("dead-route", "127.0.0.2"), host("good-route", "127.0.0.1")];
        store.save().unwrap();
        let tmp = data.join("sync");
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        let job = Job {
            id: "r1".into(),
            mode: "twoway".into(),
            a: Endpoint { kind: "local".into(), path: a.to_string_lossy().into(), hosts: vec![] },
            b: Endpoint { kind: "remote".into(), path: b.to_string_lossy().into(), hosts: vec!["dead-route".into(), "good-route".into()] },
            ..Default::default()
        };
        scenario(store.clone(), job.clone(), a, b.clone()).await;
        // Mirror the remote folder down to a local one.
        let m = tmp.join("m");
        std::fs::create_dir_all(&m).unwrap();
        write(&m.join("extra.txt"), "x");
        let mirror = Job { id: "r2".into(), mode: "mirror".into(), a: job.b, b: Endpoint { kind: "local".into(), path: m.to_string_lossy().into(), hosts: vec![] }, delete: true, ..Default::default() };
        let (_, plan) = run(store.clone(), mirror.clone(), false, emit()).await.unwrap();
        assert_eq!(plan.delete_b, ["extra.txt"]);
        let names = |p: &Path| { let mut v: Vec<_> = std::fs::read_dir(p).unwrap().map(|e| e.unwrap().file_name()).collect(); v.sort(); v };
        assert_eq!(names(&m), names(&b));
        // Incremental: only the reported remote paths are listed (find over ssh) and copied.
        write(&b.join("inc/one.txt"), "1");
        write(&b.join("other.txt"), "o");
        let (s, _) = run_paths(store, mirror, vec!["inc".into(), "missing.txt".into()], emit()).await.unwrap();
        assert_eq!(s, "1 copied");
        assert!(m.join("inc/one.txt").exists() && !m.join("other.txt").exists());
    }
}
