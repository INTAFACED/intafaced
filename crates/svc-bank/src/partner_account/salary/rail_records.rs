//! LOCAL TEST: a stand-in's own record of what it carried (`cash-out/rail-records.ts`), so the stack's outside source says
//! what a TEST rail holds in the stand-in's words, never by reading the ledger back.
//!
//! The format is the stack's own (`tooling/scripts/local-test-rail-records.mjs` reads it): one append-only JSONL file per
//! rail, each line `{"label":"TEST","rail","key","direction","assetId",["ref"],"amount","at"}`. `key` is the movement's
//! business key: the same key with the same facts writes nothing new, and with other facts refuses before anything is
//! written. A line counts once its newline is written; a torn last line is cut off by the next write. Writers on the
//! stack share the folder's `.lock`.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant as Wall};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, js_date};

const LABEL: &str = "TEST";
const MAX_KEY: usize = 512;

/// One movement (`RailMovement`): `in` to the platform or `out` from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub key: String,
    pub direction: &'static str,
    pub asset_id: String,
    pub amount: Amount,
}

/// `railRecorder(dir, rail)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailRecorder {
    pub dir: PathBuf,
    pub rail: String,
    pub lock_wait_ms: u64,
}

/// `/^[a-z0-9][a-z0-9-]{0,63}$/`.
fn rail_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b.iter()
            .enumerate()
            .all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && *c == b'-'))
}

/// `/^[A-Z0-9][A-Z0-9._-]{0,31}$/`.
fn asset_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b.iter().enumerate().all(|(i, c)| {
            c.is_ascii_uppercase()
                || c.is_ascii_digit()
                || (i > 0 && matches!(c, b'.' | b'_' | b'-'))
        })
}

/// `/^(0|[1-9]\d*)(\.\d{1,18})?$/`, and above zero.
fn amount_ok(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    let whole_ok = whole == "0"
        || (!whole.is_empty()
            && !whole.starts_with('0')
            && whole.bytes().all(|b| b.is_ascii_digit()));
    let frac_ok =
        frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()));
    whole_ok && frac_ok && parse_amount(s).is_ok_and(|a| a > 0)
}

/// `/^TEST-[A-Za-z0-9-]{1,128}$/`.
fn ref_ok(s: &str) -> bool {
    s.strip_prefix("TEST-").is_some_and(|r| {
        (1..=128).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn text<'a>(line: &'a Json, key: &str) -> Option<&'a str> {
    match line.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

/// `check`: the reader's checks, so the writer never leaves a line the stack's reader would refuse.
fn check(line: &Json, at: &str) -> Result<(), String> {
    let key_ok =
        text(line, "key").is_some_and(|k| (1..=MAX_KEY).contains(&k.encode_utf16().count()));
    let ok = text(line, "label") == Some(LABEL)
        && text(line, "rail").is_some_and(rail_ok)
        && key_ok
        && matches!(text(line, "direction"), Some("in" | "out"))
        && text(line, "assetId").is_some_and(asset_ok)
        && text(line, "amount").is_some_and(amount_ok)
        && text(line, "at").is_some_and(|t| js_date(t).is_some())
        && match line.get("ref") {
            None => true,
            Some(Json::String(r)) => ref_ok(r),
            Some(_) => false,
        };
    if ok {
        Ok(())
    } else {
        Err(format!("{at} is not a TEST rail record"))
    }
}

fn facts(line: &Json) -> String {
    let amount = text(line, "amount")
        .and_then(|a| parse_amount(a).ok())
        .map_or_else(String::new, format_amount);
    format!(
        "{} {} {amount}",
        text(line, "direction").unwrap_or_default(),
        text(line, "assetId").unwrap_or_default()
    )
}

fn said(line: &Json) -> String {
    match text(line, "ref") {
        Some(r) => format!("{} {r}", facts(line)),
        None => facts(line),
    }
}

/// `same`: the same facts, and the same reference when both lines carry one.
fn same(a: &Json, b: &Json) -> bool {
    facts(a) == facts(b)
        && match (text(a, "ref"), text(b, "ref")) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        }
}

impl RailRecorder {
    pub fn new(dir: &str, rail: &str) -> RailRecorder {
        RailRecorder {
            dir: PathBuf::from(dir),
            rail: rail.to_owned(),
            lock_wait_ms: 10_000,
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(format!("{}.jsonl", self.rail))
    }

    fn line(&self, m: &Movement, at: Instant) -> Json {
        Json::obj([
            ("label", Json::str(LABEL)),
            ("rail", Json::str(&self.rail)),
            ("key", Json::str(&m.key)),
            ("direction", Json::str(m.direction)),
            ("assetId", Json::str(&m.asset_id)),
            ("amount", Json::str(format_amount(m.amount))),
            ("at", Json::str(at.iso())),
        ])
    }

    /// `record`: one movement, unless the rail already recorded its key with the same facts.
    pub fn record(&self, m: &Movement, now: Instant) -> Result<(), String> {
        if m.amount <= 0 {
            return Err(format!(
                "{} {}: only an amount above zero is a movement",
                self.rail, m.key
            ));
        }
        let at = format!("{} {}", self.rail, m.key);
        check(&self.line(m, now), &at)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .map_err(|e| e.to_string())?;
        self.with_lock(|| {
            let (lines, complete, size) = self.read_complete()?;
            let record = self.line(m, now);
            if let Some(earlier) = lines
                .iter()
                .find(|l| text(l, "key") == Some(m.key.as_str()))
            {
                if !same(earlier, &record) {
                    return Err(format!(
                        "{} {} is already recorded as \"{}\", not \"{}\"",
                        self.rail,
                        m.key,
                        said(earlier),
                        said(&record)
                    ));
                }
                return Ok(());
            }
            let file = self.file();
            if complete < size {
                fs::OpenOptions::new()
                    .write(true)
                    .open(&file)
                    .and_then(|f| f.set_len(complete))
                    .map_err(|e| e.to_string())?;
            }
            let mut f = fs::OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .open(&file)
                .map_err(|e| e.to_string())?;
            f.write_all(format!("{}\n", record.compact()).as_bytes())
                .and_then(|()| f.sync_all())
                .map_err(|e| e.to_string())
        })
    }

    /// `movements`: every complete movement the rail recorded, oldest first, each checked.
    pub fn movements(&self) -> Result<Vec<Movement>, String> {
        let (lines, _, _) = self.read_complete()?;
        Ok(lines
            .iter()
            .map(|l| Movement {
                key: text(l, "key").unwrap_or_default().to_owned(),
                direction: if text(l, "direction") == Some("in") {
                    "in"
                } else {
                    "out"
                },
                asset_id: text(l, "assetId").unwrap_or_default().to_owned(),
                amount: text(l, "amount")
                    .and_then(|a| parse_amount(a).ok())
                    .unwrap_or(0),
            })
            .collect())
    }

    /// `readComplete`: the file's complete lines, each checked, and the bytes they take; a torn last line is left out.
    fn read_complete(&self) -> Result<(Vec<Json>, u64, u64), String> {
        let file = self.file();
        let bytes = match fs::read(&file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0, 0)),
            Err(e) => return Err(e.to_string()),
        };
        let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let body = String::from_utf8_lossy(bytes.get(..complete).unwrap_or_default()).into_owned();
        let mut lines = Vec::new();
        for (at, line) in body.split('\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let where_ = format!("{name}:{}", at + 1);
            let parsed = json::parse(line).map_err(|_| format!("{where_} is not JSON"))?;
            check(&parsed, &where_)?;
            if text(&parsed, "rail") != Some(self.rail.as_str()) {
                return Err(format!(
                    "{where_} names rail {}",
                    text(&parsed, "rail").unwrap_or_default()
                ));
            }
            lines.push(parsed);
        }
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        Ok((lines, u64::try_from(complete).unwrap_or(u64::MAX), size))
    }

    /// `withLock`: one writer at a time across the stack's processes, the folder's `.lock`, waited on, then refused.
    fn with_lock<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let lock = self.dir.join(".lock");
        let deadline = Wall::now() + Duration::from_millis(self.lock_wait_ms);
        loop {
            match fs::create_dir(&lock) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if Wall::now() > deadline {
                        return Err(format!(
                            "{} is held; if no stack command is writing, remove it",
                            lock.display()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let out = f();
        let removed = fs::remove_dir(&lock).map_err(|e| e.to_string());
        let out = out?;
        removed?;
        Ok(out)
    }
}

/// Whether a records folder is a local test path (`path.isAbsolute`).
pub fn is_absolute(dir: &str) -> bool {
    Path::new(dir).is_absolute()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!("rail-records-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn a_key_is_recorded_once_and_other_facts_under_it_refuse_before_anything_is_written() {
        let d = dir();
        let r = RailRecorder::new(d.to_str().unwrap(), "payroll-sim");
        let m = Movement {
            key: "salary:credit:net-1".to_owned(),
            direction: "in",
            asset_id: "USD".to_owned(),
            amount: parse_amount("2000").unwrap(),
        };
        r.record(&m, Instant(0)).unwrap();
        r.record(&m, Instant(5)).unwrap();
        let other = Movement {
            amount: 1,
            ..m.clone()
        };
        assert!(
            r.record(&other, Instant(0))
                .unwrap_err()
                .contains("is already recorded as \"in USD 2000\"")
        );
        assert_eq!(r.movements().unwrap(), vec![m.clone()]);
        let text = fs::read_to_string(d.join("payroll-sim.jsonl")).unwrap();
        assert_eq!(
            text,
            "{\"label\":\"TEST\",\"rail\":\"payroll-sim\",\"key\":\"salary:credit:net-1\",\"direction\":\"in\",\"assetId\":\"USD\",\"amount\":\"2000\",\"at\":\"1970-01-01T00:00:00.000Z\"}\n"
        );
        // A torn last line is cut off by the next write.
        fs::OpenOptions::new()
            .append(true)
            .open(d.join("payroll-sim.jsonl"))
            .unwrap()
            .write_all(b"{\"torn")
            .unwrap();
        let next = Movement {
            key: "salary:reverse:net-1".to_owned(),
            direction: "out",
            ..m
        };
        r.record(&next, Instant(0)).unwrap();
        assert_eq!(r.movements().unwrap().len(), 2);
        fs::remove_dir_all(d).unwrap();
    }
}
