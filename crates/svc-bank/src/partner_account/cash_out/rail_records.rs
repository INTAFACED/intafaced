//! LOCAL TEST: the payout stand-in's own record of what it paid out and took back (`cash-out/rail-records.ts`), so the
//! stack's outside source can say what rail `payout-sim` holds in the stand-in's words. One append-only JSONL file per
//! rail in the stack's folder (`BANK_PAYOUT_SIM_RECORDS_DIR`), a line
//! `{"label":"TEST","rail","key","direction","assetId"[,"ref"],"amount","at"}`; `key` is the movement's business key: the
//! same key with the same facts writes nothing new, and with other facts refuses before anything is written. A line
//! counts once its newline is written; a torn last line is cut off by the next write. Writers share the folder's `.lock`.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant as Clock};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::js_date;

const LABEL: &str = "TEST";
const MAX_KEY: usize = 512;

/// One movement on the rail (`RailMovement`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub key: String,
    /// `in` to the platform, `out` from it.
    pub direction: &'static str,
    pub asset_id: String,
    pub amount: Amount,
    /// The stand-in's own reference, when it gave one (a payout's `TEST-PAYOUT-<cash-out id>`).
    pub reference: Option<String>,
}

/// Why the stand-in could not record a movement; nothing was written. `conflict`: the rail already says otherwise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailRecordError {
    pub message: String,
    pub conflict: bool,
}

fn fail(message: impl Into<String>) -> RailRecordError {
    RailRecordError {
        message: message.into(),
        conflict: false,
    }
}

/// One line as written.
#[derive(Debug, Clone)]
struct Line {
    rail: String,
    key: String,
    direction: String,
    asset_id: String,
    amount: String,
    reference: Option<String>,
}

fn is_rail(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && b.first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn is_asset(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b.first()
            .is_some_and(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && b.iter().all(|c| {
            c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn is_decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let whole_ok = whole == "0"
        || (!whole.is_empty()
            && !whole.starts_with('0')
            && whole.bytes().all(|c| c.is_ascii_digit()));
    whole_ok
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|c| c.is_ascii_digit()))
}

fn is_ref(s: &str) -> bool {
    s.strip_prefix("TEST-").is_some_and(|r| {
        (1..=128).contains(&r.len()) && r.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    })
}

/// The reader's checks, so the writer never leaves a line the stack's reader would refuse.
fn check(j: &Json, where_: &str) -> Result<Line, RailRecordError> {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    };
    let refused = || fail(format!("{where_} is not a TEST rail record"));
    let (
        Some(label),
        Some(rail),
        Some(key),
        Some(direction),
        Some(asset_id),
        Some(amount),
        Some(at),
    ) = (
        s("label"),
        s("rail"),
        s("key"),
        s("direction"),
        s("assetId"),
        s("amount"),
        s("at"),
    )
    else {
        return Err(refused());
    };
    let reference = match j.get("ref") {
        None => None,
        Some(Json::String(r)) if is_ref(r) => Some(r.clone()),
        Some(_) => return Err(refused()),
    };
    let key_len = key.encode_utf16().count();
    let ok = label == LABEL
        && is_rail(&rail)
        && (1..=MAX_KEY).contains(&key_len)
        && (direction == "in" || direction == "out")
        && is_asset(&asset_id)
        && is_decimal(&amount)
        && parse_amount(&amount).is_ok_and(|a| a > 0)
        && js_date(&at).is_some();
    if !ok {
        return Err(refused());
    }
    Ok(Line {
        rail,
        key,
        direction,
        asset_id,
        amount,
        reference,
    })
}

fn facts(l: &Line) -> String {
    let amount = parse_amount(&l.amount).map_or_else(|_| l.amount.clone(), format_amount);
    format!("{} {} {amount}", l.direction, l.asset_id)
}

fn same(a: &Line, b: &Line) -> bool {
    facts(a) == facts(b)
        && match (&a.reference, &b.reference) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        }
}

fn said(l: &Line) -> String {
    match &l.reference {
        Some(r) => format!("{} {r}", facts(l)),
        None => facts(l),
    }
}

fn line_json(l: &Line, at: &str) -> Json {
    let mut fields: Vec<(String, Json)> = vec![
        ("label".into(), Json::str(LABEL)),
        ("rail".into(), Json::str(&l.rail)),
        ("key".into(), Json::str(&l.key)),
        ("direction".into(), Json::str(&l.direction)),
        ("assetId".into(), Json::str(&l.asset_id)),
    ];
    if let Some(r) = &l.reference {
        fields.push(("ref".into(), Json::str(r)));
    }
    fields.push(("amount".into(), Json::str(&l.amount)));
    fields.push(("at".into(), Json::str(at)));
    Json::Object(fields)
}

fn now_iso() -> String {
    crate::door::system_now().iso()
}

/// One rail's records in one folder (`railRecorder`).
#[derive(Debug, Clone)]
pub struct RailRecorder {
    pub dir: PathBuf,
    pub rail: String,
    pub lock_wait: Duration,
}

impl RailRecorder {
    pub fn new(dir: &str, rail: &str) -> RailRecorder {
        RailRecorder {
            dir: PathBuf::from(dir),
            rail: rail.to_owned(),
            lock_wait: Duration::from_millis(10_000),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(format!("{}.jsonl", self.rail))
    }

    /// Records one movement, unless the rail already recorded its key with the same facts.
    pub fn record(&self, m: &Movement) -> Result<(), RailRecordError> {
        if m.amount <= 0 {
            return Err(fail(format!(
                "{} {}: only an amount above zero is a movement",
                self.rail, m.key
            )));
        }
        let mut line = Line {
            rail: self.rail.clone(),
            key: m.key.clone(),
            direction: m.direction.to_owned(),
            asset_id: m.asset_id.clone(),
            amount: format_amount(m.amount),
            reference: m.reference.clone(),
        };
        let where_ = format!("{} {}", self.rail, m.key);
        check(&line_json(&line, &now_iso()), &where_)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .map_err(|e| fail(e.to_string()))?;
        with_lock(&self.dir, self.lock_wait, || {
            let (lines, complete, size) = read_complete(&self.file(), &self.rail)?;
            // Stamped under the lock, so a statement read before this line lands never gains it afterwards.
            let at = now_iso();
            line.rail.clone_from(&self.rail);
            if let Some(earlier) = lines.iter().find(|l| l.key == line.key) {
                if !same(earlier, &line) {
                    return Err(RailRecordError {
                        message: format!(
                            "{} {} is already recorded as \"{}\", not \"{}\"",
                            self.rail,
                            line.key,
                            said(earlier),
                            said(&line)
                        ),
                        conflict: true,
                    });
                }
                return Ok(());
            }
            let path = self.file();
            if complete < size {
                let f = OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .map_err(|e| fail(e.to_string()))?;
                f.set_len(complete as u64)
                    .map_err(|e| fail(e.to_string()))?;
            }
            let mut f = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .open(&path)
                .map_err(|e| fail(e.to_string()))?;
            f.write_all(format!("{}\n", line_json(&line, &at).compact()).as_bytes())
                .and_then(|()| f.sync_all())
                .map_err(|e| fail(e.to_string()))
        })
    }

    /// Whether the rail has a complete record under `key`.
    pub fn has(&self, key: &str) -> Result<bool, RailRecordError> {
        Ok(read_complete(&self.file(), &self.rail)?
            .0
            .iter()
            .any(|l| l.key == key))
    }
}

/// The file's complete lines, each checked, the bytes they take and the file's size; a torn last line is left out.
fn read_complete(file: &Path, rail: &str) -> Result<(Vec<Line>, usize, usize), RailRecordError> {
    let mut bytes = Vec::new();
    match fs::File::open(file) {
        Ok(mut f) => {
            f.read_to_end(&mut bytes).map_err(|e| fail(e.to_string()))?;
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok((Vec::new(), 0, 0)),
        Err(e) => return Err(fail(e.to_string())),
    }
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = String::from_utf8_lossy(bytes.get(..complete).unwrap_or_default()).into_owned();
    let mut lines = Vec::new();
    for (at, t) in text.split('\n').enumerate() {
        if t.is_empty() {
            continue;
        }
        let where_ = format!("{name}:{}", at + 1);
        let j = json::parse(t).map_err(|_| fail(format!("{where_} is not JSON")))?;
        let line = check(&j, &where_)?;
        if line.rail != rail {
            return Err(fail(format!("{where_} names rail {}", line.rail)));
        }
        lines.push(line);
    }
    Ok((lines, complete, bytes.len()))
}

/// One writer at a time across the stack's processes: the folder's `.lock`, waited on, then refused by name.
fn with_lock<T>(
    dir: &Path,
    wait: Duration,
    f: impl FnOnce() -> Result<T, RailRecordError>,
) -> Result<T, RailRecordError> {
    let lock = dir.join(".lock");
    let started = Clock::now();
    loop {
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                if started.elapsed() > wait {
                    return Err(fail(format!(
                        "{} is held; if no stack command is writing, remove it",
                        lock.display()
                    )));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(fail(e.to_string())),
        }
    }
    let out = f();
    let freed = fs::remove_dir(&lock);
    match (out, freed) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), _) => Err(e),
        (Ok(_), Err(e)) => Err(fail(e.to_string())),
    }
}
