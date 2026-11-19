//! How the authoring slice talks to Postgres as `postgres.js` did for the TypeScript.
//!
//! Every parameter goes as text and is cast in the statement (`$1::text::uuid`, `$2::text::timestamptz`), the way an
//! untyped postgres.js parameter reaches the server; every column comes back as the TypeScript saw it: a `uuid` as its
//! text, a `numeric` as its text, a `timestamptz` as epoch milliseconds (a JavaScript `Date`), `count(*)::int` as an
//! integer. A transaction is `sql.begin(...)`: a plain `BEGIN` (read committed, the server's default), committed when
//! the closure answers and rolled back when it refuses. [`serializable`] is `@intafaced/db`'s `transaction`: serializable,
//! tried up to five times on a serialization failure or a deadlock.

use postgres::types::{FromSql, ToSql};
use postgres::{GenericClient, Row, Transaction};

use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db;
use crate::errors::Refusal;

/// One statement parameter.
pub type P<'a> = &'a (dyn ToSql + Sync);

/// A `timestamptz` column as a JavaScript `Date` holds it: epoch milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// A time as a statement parameter (`${date}`): its ISO text, cast `::text::timestamptz` in the statement.
pub fn at(ms: i64) -> String {
    Instant(ms).iso()
}

/// `Date#toISOString()`.
pub fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

pub fn query<C: GenericClient>(c: &mut C, sql: &str, params: &[P<'_>]) -> Result<Vec<Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

/// The first row, when there is one (`const [row] = await sql...`).
pub fn first<C: GenericClient>(c: &mut C, sql: &str, params: &[P<'_>]) -> Result<Option<Row>, Refusal> {
    Ok(query(c, sql, params)?.into_iter().next())
}

pub fn exec<C: GenericClient>(c: &mut C, sql: &str, params: &[P<'_>]) -> Result<u64, Refusal> {
    c.execute(sql, params).map_err(|e| db::refusal(&e))
}

/// A column by name.
pub fn get<'a, T: FromSql<'a>>(row: &'a Row, column: &str) -> Result<T, Refusal> {
    row.try_get(column).map_err(|e| db::refusal(&e))
}

/// An `int4` column as the TypeScript's number.
pub fn int(row: &Row, column: &str) -> Result<i64, Refusal> {
    get::<i32>(row, column).map(i64::from)
}

pub fn opt_int(row: &Row, column: &str) -> Result<Option<i64>, Refusal> {
    get::<Option<i32>>(row, column).map(|v| v.map(i64::from))
}

/// A millisecond column as `toISOString()`.
pub fn iso_of(row: &Row, column: &str) -> Result<String, Refusal> {
    get::<i64>(row, column).map(iso)
}

pub fn opt_iso_of(row: &Row, column: &str) -> Result<Option<String>, Refusal> {
    get::<Option<i64>>(row, column).map(|v| v.map(iso))
}

/// `sql.begin(fn)`: one transaction at the server's default isolation.
pub fn begin<T>(pool: &Pool, f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>) -> Result<T, Refusal> {
    db::with_client(pool, |client| {
        let mut tx = client.transaction().map_err(|e| db::refusal(&e))?;
        let out = f(&mut tx)?;
        tx.commit().map_err(|e| db::refusal(&e))?;
        Ok(out)
    })
}

/// `@intafaced/db` `transaction(sql, fn)`: serializable, up to five tries on `40001` or `40P01`, with jittered backoff.
pub fn serializable<T>(pool: &Pool, mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>) -> Result<T, Refusal> {
    let mut attempt: u32 = 1;
    loop {
        match db::transaction(pool, postgres::IsolationLevel::Serializable, &mut f) {
            Err(Refusal::Internal { code: Some(code), .. })
                if (code == db::SERIALIZATION_FAILURE || code == "40P01") && attempt < 5 =>
            {
                let ceiling = 5u64 << attempt;
                std::thread::sleep(std::time::Duration::from_millis(random_u64() % ceiling.max(1)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// One statement or more outside a transaction, on one connection.
pub fn client<T>(pool: &Pool, f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>) -> Result<T, Refusal> {
    db::with_client(pool, f)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], Refusal> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| Refusal::Internal {
        message: format!("no randomness: {e}"),
        code: None,
    })?;
    Ok(b)
}

fn random_u64() -> u64 {
    random_bytes::<8>().map_or(0, u64::from_le_bytes)
}

/// `randomUUID()`: a version 4 UUID in lower-case hex.
pub fn uuid() -> Result<String, Refusal> {
    let mut b = random_bytes::<16>()?;
    if let Some(x) = b.get_mut(6) {
        *x = (*x & 0x0f) | 0x40;
    }
    if let Some(x) = b.get_mut(8) {
        *x = (*x & 0x3f) | 0x80;
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex.get(0..8).unwrap_or_default(),
        hex.get(8..12).unwrap_or_default(),
        hex.get(12..16).unwrap_or_default(),
        hex.get(16..20).unwrap_or_default(),
        hex.get(20..32).unwrap_or_default()
    ))
}

/// `randomBytes(n).toString('hex')`.
pub fn random_hex<const N: usize>() -> Result<String, Refusal> {
    Ok(random_bytes::<N>()?.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uuid_is_version_4() {
        let u = uuid().unwrap_or_default();
        assert_eq!(u.len(), 36);
        assert_eq!(u.get(14..15), Some("4"));
        assert!(matches!(u.get(19..20), Some("8" | "9" | "a" | "b")));
    }
}
