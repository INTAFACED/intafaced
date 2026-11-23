//! The community slice's service code, ported from the TypeScript: course discussion (`curriculum/discussion.ts`) and
//! its moderation outbox (`curriculum/moderation.ts`), course messages (`curriculum/course-messages.ts`), the course
//! team and roles (`team/course-team.ts`), the learner desk (`learners/learner-desk.ts`), staff enrolment, course
//! email and learner exports (`learners/staff-enrolment.ts`), learner summaries and the report centre
//! (`analytics/`), and the daily activity table (`learning/customer-store.ts` `opsMetrics`, `completionsByItem`).
//!
//! Each module runs the same SQL as its TypeScript file, statement for statement, inside the same transactions:
//! `transaction(sql, fn)` from `@intafaced/db` is [`serializable`] (serializable, retried up to five times on a
//! serialization failure or a deadlock), `sql.begin(fn)` is [`begin`] (read committed, no retry), and a bare
//! `this.sql` statement runs on its own. Values cross as the TypeScript's driver gives them: a uuid as its text, a
//! `timestamptz` as milliseconds (`Date` keeps milliseconds), `int4` as a number. Module functions are written over
//! [`postgres::GenericClient`], so one function serves a transaction and a plain connection, as `Queryable` does.

pub mod analytics;
pub mod discussion;
pub mod learner_desk;
pub mod messages;
pub mod metrics;
pub mod moderation;
pub mod staff_enrolment;
pub mod team;

use postgres::types::{FromSql, ToSql};
use postgres::{GenericClient, IsolationLevel, Row, Transaction};
use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::db;
use crate::errors::{AcademyError, Refusal};
use crate::settings::Settings;

/// A statement's parameters.
pub type Params<'a> = &'a [&'a (dyn ToSql + Sync)];

/// `SELECT` a `timestamptz` the way the driver hands it to the TypeScript: a `Date`, which keeps whole milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// Every row of a query.
pub fn rows<C: GenericClient>(
    db: &mut C,
    sql: &str,
    params: Params<'_>,
) -> Result<Vec<Row>, Refusal> {
    db.query(sql, params).map_err(|e| db::refusal(&e))
}

/// The first row of a query (`const [row] = await sql...`), or none.
pub fn first<C: GenericClient>(
    db: &mut C,
    sql: &str,
    params: Params<'_>,
) -> Result<Option<Row>, Refusal> {
    Ok(rows(db, sql, params)?.into_iter().next())
}

/// A statement's affected row count.
pub fn exec<C: GenericClient>(db: &mut C, sql: &str, params: Params<'_>) -> Result<u64, Refusal> {
    db.execute(sql, params).map_err(|e| db::refusal(&e))
}

/// One column of a row.
pub fn col<'a, T: FromSql<'a>>(row: &'a Row, i: usize) -> Result<T, Refusal> {
    row.try_get(i).map_err(|e| Refusal::Internal {
        message: format!("svc-academy: column {i}: {e}"),
        code: None,
    })
}

/// A timestamp column read as milliseconds.
pub fn at(row: &Row, i: usize) -> Result<Instant, Refusal> {
    col::<i64>(row, i).map(Instant)
}

/// A nullable timestamp column read as milliseconds.
pub fn at_opt(row: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(col::<Option<i64>>(row, i)?.map(Instant))
}

/// `date.toISOString()` as JSON.
pub fn iso(at: Instant) -> Json {
    Json::str(at.iso())
}

/// A nullable date as JSON.
pub fn iso_opt(at: Option<Instant>) -> Json {
    at.map_or(Json::Null, iso)
}

/// A nullable string as JSON.
pub fn str_opt(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::str)
}

/// A list of strings as JSON.
pub fn strs(list: &[String]) -> Json {
    Json::Array(list.iter().map(|s| Json::str(s.clone())).collect())
}

/// An `int4` count as JSON.
pub fn int(n: i32) -> Json {
    Json::int(i64::from(n))
}

/// `new AcademyError(message, code)`.
pub fn academy(code: &str, message: impl Into<String>) -> Refusal {
    Refusal::Academy(AcademyError::new(message, code))
}

/// A `defineRefusals` family's refusal through its `guard`: a `TRPCError` with `<code>: <message>` and the code as its
/// cause, whether or not the router's own guard wraps it.
pub fn family(status: &'static str, code: &str, message: &str) -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        status,
        format!("{code}: {message}"),
        code,
    ))
}

/// `requireSetting(value, family, code)`: a blank owner value refuses `<code>: the owner has not set this value`.
pub fn require_setting(
    value: Option<i64>,
    status: &'static str,
    code: &str,
) -> Result<i64, Refusal> {
    value.ok_or_else(|| {
        family(
            status,
            code,
            &format!("{code}: the owner has not set this value"),
        )
    })
}

/// An owner value from the environment (`AcademyServiceOptions` is built from the same `env`): `None` while blank.
pub fn setting(settings: &Settings, key: &str) -> Option<i64> {
    match settings.0.get(key) {
        Some(Json::Number(n)) => format!("{n}").parse().ok(),
        _ => None,
    }
}

/// A string from the environment.
pub fn setting_str<'a>(settings: &'a Settings, key: &str) -> Option<&'a str> {
    match settings.0.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

/// `createHash('sha256').update(text, 'utf8').digest('hex')`.
pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `String.prototype.trim()`: the JavaScript whitespace set.
pub fn js_trim(s: &str) -> &str {
    service_kit::schema::js_trim(s)
}

/// `a < b` as JavaScript compares strings: by UTF-16 code unit.
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `s.slice(0, n)` in UTF-16 code units, never splitting a character.
pub fn js_slice(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// The system clock: what `new Date()` reads inside a service method that is not handed `now`.
pub fn clock() -> Instant {
    crate::door::system_now()
}

/// `sql.begin(fn)`: one read committed transaction, no retry.
pub fn begin<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    db::transaction(pool, IsolationLevel::ReadCommitted, f)
}

/// The store as a service method sees it: `reach` is the method being called (a refusing service throws here), `get`
/// is its first query (a store that is down fails here). Checks the TypeScript makes before its first query run
/// before `get`, so a down store answers them as the TypeScript did.
#[derive(Clone, Copy)]
pub struct Db<'a>(pub &'a db::Store);

impl<'a> Db<'a> {
    pub fn reach(&self) -> Result<(), Refusal> {
        match self.0 {
            db::Store::Refuses(r) => Err(r.clone()),
            _ => Ok(()),
        }
    }

    pub fn get(&self) -> Result<&'a Pool, Refusal> {
        self.0.pool()
    }
}

/// `transaction(sql, fn)` from `@intafaced/db`: serializable, retried up to five times in all on a serialization
/// failure (`40001`) or a deadlock (`40P01`), with full-jitter backoff between attempts.
pub fn serializable<T>(
    pool: &Pool,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    const MAX_ATTEMPTS: u32 = 5;
    let mut attempt = 1;
    loop {
        match db::transaction(pool, IsolationLevel::Serializable, &mut f) {
            Err(Refusal::Internal {
                code: Some(code), ..
            }) if (code == "40001" || code == "40P01") && attempt < MAX_ATTEMPTS => {
                // `Math.random() * 2 ** attempt * 5` milliseconds.
                let ceiling = 5u64 << attempt;
                std::thread::sleep(std::time::Duration::from_millis(
                    random_u64() % ceiling.max(1),
                ));
                attempt += 1;
            }
            out => return out,
        }
    }
}

fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    if getrandom::fill(&mut b).is_err() {
        return 0;
    }
    u64::from_le_bytes(b)
}

/// `crypto.randomUUID()`: a version 4 UUID.
pub fn random_uuid() -> Result<String, Refusal> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| Refusal::Internal {
        message: format!("svc-academy: no randomness: {e}"),
        code: None,
    })?;
    if let Some(x) = b.get_mut(6) {
        *x = (*x & 0x0f) | 0x40;
    }
    if let Some(x) = b.get_mut(8) {
        *x = (*x & 0x3f) | 0x80;
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let part = |from: usize, to: usize| hex.get(from..to).unwrap_or_default().to_owned();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    ))
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `buffer.toString('base64')`.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk.first().copied().unwrap_or(0);
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        let sym =
            |shift: u32| char::from(*BASE64.get(((n >> shift) & 63) as usize).unwrap_or(&b'A'));
        out.push(sym(18));
        out.push(sym(12));
        out.push(if chunk.len() > 1 { sym(6) } else { '=' });
        out.push(if chunk.len() > 2 { sym(0) } else { '=' });
    }
    out
}

/// `Buffer.from(text, 'base64')` as Node decodes it: the standard and URL-safe alphabets both, every other character
/// skipped, and decoding stops at the first `=`.
pub fn base64_decode_node(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut have = 0;
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        have += 1;
        if have == 4 {
            out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            acc = 0;
            have = 0;
        }
    }
    match have {
        2 => out.push((acc >> 4) as u8),
        3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
        _ => {}
    }
    out
}

/// `csvField` (`curriculum/grade-reports.ts`): a cell a spreadsheet does not run as a formula, quoted when it must be.
pub fn csv_field(value: &str) -> String {
    let lead = value
        .chars()
        .find(|c| !service_kit::money::is_js_whitespace(*c));
    let text = if matches!(lead, Some('=' | '+' | '-' | '@')) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_as_node_does_and_writes_padded() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        assert_eq!(base64_encode(&base64_decode_node(png)), png);
        assert_eq!(base64_decode_node("aGk"), b"hi");
        assert_eq!(base64_decode_node("a G\nk="), b"hi");
        assert_eq!(base64_decode_node("aGk=AAAA"), b"hi");
        assert_eq!(base64_decode_node("-_8"), vec![0xfb, 0xff]);
        assert!(base64_decode_node("").is_empty());
    }

    #[test]
    fn csv_cells_quote_and_defuse_as_the_typescript() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(csv_field("  -1"), "'  -1");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn a_random_uuid_is_version_4() {
        let id = random_uuid().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(id.get(14..15), Some("4"));
        assert!(matches!(id.get(19..20), Some("8" | "9" | "a" | "b")));
    }

    #[test]
    fn strings_compare_and_slice_by_utf16_unit() {
        assert_eq!(js_cmp("\u{ffff}", "\u{10000}"), std::cmp::Ordering::Greater);
        assert_eq!(js_slice("ab\u{1f600}c", 3), "ab");
        assert_eq!(js_slice("abc", 300), "abc");
    }
}
