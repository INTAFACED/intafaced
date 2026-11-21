//! The journal's one writer (`journal-io.ts`): a sidecar file `<journal>.lock` made with `O_EXCL`, holding the writer's
//! pid and a nonce. Two appending descriptors on one file can tear the book, so a second writer is refused.
//!
//! A lock whose pid is gone is stolen, through a recover gate (`<lock>.recover`, a directory made with `mkdir`) so two
//! recoverers that both saw the dead lock cannot both take it: only the one inside the gate unlinks, and only the inode
//! that still holds the nonce it read. A live pid that is this process with a nonce this process never wrote is a dead
//! container that reused the pid, and is stolen too.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::thread::sleep;
use std::time::{Duration, Instant};

use super::JournalError;

/// The test hook that holds a recoverer after it has judged the lock dead: unset in production. A test creates
/// `release-<pid>` in that directory to let the recoverer go on.
pub const RECOVER_BARRIER_ENV: &str = "MATCHING_JOURNAL_LOCK_RECOVER_BARRIER";

/// Nonces this process wrote into a lock it holds.
static HELD_NONCES: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn held_insert(nonce: &str) {
    let mut held = HELD_NONCES.lock().unwrap_or_else(PoisonError::into_inner);
    held.get_or_insert_with(HashSet::new)
        .insert(nonce.to_owned());
}

fn held_remove(nonce: &str) {
    let mut held = HELD_NONCES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(set) = held.as_mut() {
        set.remove(nonce);
    }
}

fn held_contains(nonce: &str) -> bool {
    let held = HELD_NONCES.lock().unwrap_or_else(PoisonError::into_inner);
    held.as_ref().is_some_and(|set| set.contains(nonce))
}

/// The lock held by this writer.
#[derive(Debug)]
pub struct WriterLock {
    pub path: PathBuf,
    pub nonce: String,
}

/// 8 random bytes as hex (`randomBytes(8).toString('hex')`).
pub fn random_hex() -> io::Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn lock_path(journal: &Path) -> PathBuf {
    let mut path = journal.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

fn gate_path(lock: &Path) -> PathBuf {
    let mut path = lock.as_os_str().to_owned();
    path.push(".recover");
    PathBuf::from(path)
}

/// `Number.parseInt(text.trim(), 10)`: a sign and the leading digits; `None` where JavaScript gives `NaN`, and for a
/// number no pid can be.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, text.get(1..).unwrap_or("")),
        Some(b'+') => (false, text.get(1..).unwrap_or("")),
        _ => (false, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n: i64 = digits.get(..end).filter(|d| !d.is_empty())?.parse().ok()?;
    Some(if negative { -n } else { n })
}

/// What a lock file says: its writer's pid and nonce.
fn parse_lock(raw: &str) -> (Option<i64>, Option<String>) {
    let mut lines = raw.split('\n');
    let pid = parse_int(lines.next().unwrap_or(""));
    let nonce = lines
        .next()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    (pid, nonce)
}

/// `process.kill(pid, 0)` succeeds, or fails with `EPERM` (live, and not ours to signal: still a writer).
fn pid_is_live(pid: i64) -> bool {
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(e) => e == rustix::io::Errno::PERM,
    }
}

fn can_steal(pid: Option<i64>, nonce: Option<&str>) -> bool {
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return false;
    };
    let me = i64::from(std::process::id());
    if pid_is_live(pid) && pid != me {
        return false;
    }
    if pid_is_live(pid) && nonce.is_some_and(held_contains) {
        return false;
    }
    true
}

fn wait_for_recover_barrier() -> io::Result<()> {
    let Some(barrier) = std::env::var_os(RECOVER_BARRIER_ENV).filter(|b| !b.is_empty()) else {
        return Ok(());
    };
    let barrier = PathBuf::from(barrier);
    let pid = std::process::id();
    fs::write(barrier.join(format!("seen-{pid}")), "1")?;
    let release = barrier.join(format!("release-{pid}"));
    let deadline = Instant::now() + Duration::from_secs(8);
    while !release.exists() {
        if Instant::now() > deadline {
            return Err(io::Error::other("journal lock recover barrier timed out"));
        }
        sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn read_head(file: &mut File) -> io::Result<String> {
    let mut buf = [0u8; 256];
    let n = file.read(&mut buf)?;
    Ok(String::from_utf8_lossy(buf.get(..n).unwrap_or(&[])).into_owned())
}

/// Drop the directory entry only while it still names the inode holding this nonce.
fn unlink_if_nonce(path: &Path, expected: Option<&str>) -> io::Result<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) => return Ok(e.kind() == io::ErrorKind::NotFound),
    };
    let head = read_head(&mut file)?;
    if parse_lock(&head).1.as_deref() != expected {
        return Ok(false);
    }
    let held = file.metadata()?;
    let named = match fs::metadata(path) {
        Ok(named) => named,
        Err(e) => return Ok(e.kind() == io::ErrorKind::NotFound),
    };
    if named.ino() != held.ino() || named.dev() != held.dev() {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn create_new(path: &Path, body: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(body.as_bytes())
}

/// Enter the recover gate. `None` when another recoverer is inside, or a stale gate stands: only its holder removes
/// it, because renaming a gate observed dead can race with its replacement and steal a live recoverer's.
fn try_enter_gate(lock: &Path) -> io::Result<Option<String>> {
    let gate = gate_path(lock);
    match fs::create_dir(&gate) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(e) => return Err(e),
    }
    let nonce = random_hex()?;
    if let Err(e) = create_new(
        &gate.join("owner"),
        &format!("{}\n{nonce}\n", std::process::id()),
    ) {
        // Preserve an ownership entry we did not create.
        let _ = fs::remove_dir(&gate);
        return Err(e);
    }
    Ok(Some(nonce))
}

fn leave_gate(lock: &Path, nonce: &str) -> io::Result<()> {
    let gate = gate_path(lock);
    if !unlink_if_nonce(&gate.join("owner"), Some(nonce))? {
        return Ok(());
    }
    match fs::remove_dir(&gate) {
        Ok(()) => Ok(()),
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                || e.kind() == io::ErrorKind::DirectoryNotEmpty =>
        {
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn unlink_observed_dead(lock: &Path, expected: Option<&str>) -> io::Result<bool> {
    let raw = match fs::read(lock) {
        Ok(raw) => String::from_utf8_lossy(&raw).into_owned(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e),
    };
    let (pid, nonce) = parse_lock(&raw);
    if nonce.as_deref() != expected || !can_steal(pid, nonce.as_deref()) {
        return Ok(false);
    }
    unlink_if_nonce(lock, expected)
}

fn steal_dead(lock: &Path) -> io::Result<bool> {
    let raw = match fs::read(lock) {
        Ok(raw) => String::from_utf8_lossy(&raw).into_owned(),
        Err(e) => return Ok(e.kind() == io::ErrorKind::NotFound),
    };
    let (pid, nonce) = parse_lock(&raw);
    if !can_steal(pid, nonce.as_deref()) {
        return Ok(false);
    }
    // Both recoverers have already judged this lock dead. A test holds them here so the slower one goes on only after
    // the winner has put its own lock in place.
    wait_for_recover_barrier()?;
    let Some(gate_nonce) = try_enter_gate(lock)? else {
        return Ok(false);
    };
    let stolen = unlink_observed_dead(lock, nonce.as_deref());
    // `finally`: an error leaving the gate is the one that surfaces.
    leave_gate(lock, &gate_nonce)?;
    stolen
}

/// Take the journal's one writer lock, stealing a dead writer's once.
pub fn acquire(journal: &Path) -> Result<WriterLock, JournalError> {
    let path = lock_path(journal);
    for attempt in 0..2 {
        let nonce = random_hex()?;
        match create_new(&path, &format!("{}\n{nonce}\n", std::process::id())) {
            Ok(()) => {
                held_insert(&nonce);
                return Ok(WriterLock { path, nonce });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if attempt == 0 && steal_dead(&path)? {
                    continue;
                }
                return Err(JournalError::Locked {
                    path: journal.to_path_buf(),
                });
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(JournalError::Locked {
        path: journal.to_path_buf(),
    })
}

/// Give the lock back: unlink it only while it still holds this writer's nonce.
pub fn release(lock: &WriterLock) -> io::Result<()> {
    let unlinked = unlink_if_nonce(&lock.path, Some(&lock.nonce));
    held_remove(&lock.nonce);
    unlinked.map(|_| ())
}
