//! Assessment and grading: quizzes and surveys on the items of a course staff made (`curriculum/course-quizzes.ts`),
//! their score trail and analytics, assignments and their hand-ins, peer and self review, staff grading and the bulk
//! grade file, the course gradebook with its late policy, grade reports, and the code-catalogue quizzes on curriculum
//! items (`assessment/`). Each module ports one TypeScript file statement for statement: the same SQL against the same
//! `academy` schema, the same locks and transactions, the same checks in the same order. Each takes the [`Store`] and asks
//! it for the pool only at its first query, so a check the TypeScript makes before its first query answers the same
//! whether or not the database can serve. `slices::assessment` answers
//! the calls.
//!
//! Values cross the database as the TypeScript reads them: a timestamp as epoch milliseconds (a JavaScript `Date`), a
//! `numeric` as its text, `count(*)` cast as the TypeScript casts it, `jsonb` as its text parsed the way `JSON.parse`
//! orders keys. Every parameter is sent as text and cast in the statement, as postgres.js serialises its values.

pub mod analytics;
pub mod assignments;
pub mod csv;
pub mod extensions;
pub mod gradebook;
pub mod grading;
pub mod legacy;
pub mod peer;
pub mod quizzes;
pub mod reads;
pub mod release;
pub mod reports;
pub mod score;
pub mod scrypt;
pub mod storage;
pub mod trail;

use postgres::types::{FromSql, ToSql};
use postgres::{GenericClient, IsolationLevel, Row, Transaction};

use service_kit::json::{self, Json};
use service_kit::time::Instant;

use crate::db::{self, SERIALIZATION_FAILURE, Store};
use crate::errors::{AcademyError, Refusal};

/// A parameter.
pub type P<'a> = &'a (dyn ToSql + Sync);

/// `new AcademyError(message, code)` as a refusal.
pub fn refuse<T>(message: impl Into<String>, code: &str) -> Result<T, Refusal> {
    Err(AcademyError::new(message, code).into())
}

/// A timestamp column as a JavaScript `Date` holds it: epoch milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// A time as text, for a `$n::text::timestamptz` parameter and for `toISOString()`.
pub fn iso(at: i64) -> String {
    Instant(at).iso()
}

/// A nullable time as JSON.
pub fn iso_or_null(at: Option<i64>) -> Json {
    at.map_or(Json::Null, |t| Json::String(iso(t)))
}

pub fn query<C: GenericClient>(
    c: &mut C,
    sql: &str,
    params: &[P<'_>],
) -> Result<Vec<Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

pub fn first<C: GenericClient>(
    c: &mut C,
    sql: &str,
    params: &[P<'_>],
) -> Result<Option<Row>, Refusal> {
    Ok(query(c, sql, params)?.into_iter().next())
}

/// A query that returns one row (an aggregate).
pub fn one<C: GenericClient>(c: &mut C, sql: &str, params: &[P<'_>]) -> Result<Row, Refusal> {
    first(c, sql, params)?.ok_or_else(|| Refusal::db("the query returned no row", None))
}

pub fn exec<C: GenericClient>(c: &mut C, sql: &str, params: &[P<'_>]) -> Result<u64, Refusal> {
    c.execute(sql, params).map_err(|e| db::refusal(&e))
}

/// One column of a row.
pub fn cell<'a, T: FromSql<'a>>(row: &'a Row, name: &str) -> Result<T, Refusal> {
    row.try_get(name).map_err(|e| db::refusal(&e))
}

/// A `jsonb` column read as `::text`, parsed as `JSON.parse` would.
pub fn json_cell(row: &Row, name: &str) -> Result<Option<Json>, Refusal> {
    let text: Option<String> = cell(row, name)?;
    text.map(|t| json::parse(&t).map_err(|e| Refusal::db(format!("{e:?}"), None)))
        .transpose()
}

/// A `jsonb` column that is never null.
pub fn json_of(row: &Row, name: &str) -> Result<Json, Refusal> {
    Ok(json_cell(row, name)?.unwrap_or(Json::Null))
}

/// An integer as JSON.
pub fn int(n: i64) -> Json {
    Json::int(n)
}

pub fn opt_int(n: Option<i64>) -> Json {
    n.map_or(Json::Null, Json::int)
}

pub fn opt_str(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::String)
}

/// A JSON number as the integer it holds (every score and point here is a whole number).
pub fn num(j: &Json) -> Option<i64> {
    match j {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "points and scores are whole numbers far below 2^53"
        )]
        Json::Number(n) => Some(*n as i64),
        _ => None,
    }
}

/// A field of an object.
pub fn field<'a>(j: &'a Json, key: &str) -> Option<&'a Json> {
    j.get(key)
}

pub fn field_str<'a>(j: &'a Json, key: &str) -> Option<&'a str> {
    match j.get(key) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

pub fn field_int(j: &Json, key: &str) -> Option<i64> {
    j.get(key).and_then(num)
}

pub fn field_bool(j: &Json, key: &str) -> Option<bool> {
    match j.get(key) {
        Some(Json::Bool(b)) => Some(*b),
        _ => None,
    }
}

pub fn array(j: Option<&Json>) -> &[Json] {
    match j {
        Some(Json::Array(a)) => a.as_slice(),
        _ => &[],
    }
}

pub fn fields(j: &Json) -> &[(String, Json)] {
    match j {
        Json::Object(f) => f.as_slice(),
        _ => &[],
    }
}

/// `{ ...a, [key]: value }`: a key already there keeps its place.
pub fn with_key(mut fields: Vec<(String, Json)>, key: &str, value: Json) -> Vec<(String, Json)> {
    match fields.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => *v = value,
        None => fields.push((key.to_owned(), value)),
    }
    fields
}

/// `sql.begin(fn)`: one transaction at the server's default, read committed.
pub fn begin<T>(
    pool: &Store,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    db::transaction(pool.pool()?, IsolationLevel::ReadCommitted, f)
}

/// `transaction(sql, fn)` of `@intafaced/db`: serializable, tried again (up to five times, with jittered backoff) on a
/// serialization failure.
pub fn serializable<T>(
    pool: &Store,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let pool = pool.pool()?;
    let mut attempt: u32 = 1;
    loop {
        match db::transaction(pool, IsolationLevel::Serializable, &mut f) {
            Err(Refusal::Internal {
                code: Some(code), ..
            }) if code == SERIALIZATION_FAILURE && attempt < 5 => {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u64::from(d.subsec_nanos()));
                let ceiling = 5u64 << attempt;
                std::thread::sleep(std::time::Duration::from_millis(nanos % ceiling.max(1)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// `sql.begin('isolation level repeatable read read only', fn)`.
pub fn repeatable_read_only<T>(
    pool: &Store,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.pool()?.get().map_err(db::pool_refusal)?;
    let client = conn.client().map_err(db::pool_refusal)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(|e| db::refusal(&e))?;
    let out = f(&mut tx)?;
    tx.commit().map_err(|e| db::refusal(&e))?;
    Ok(out)
}

/// The pool's client for statements outside a transaction.
pub fn with_client<T>(
    pool: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    db::with_client(pool.pool()?, f)
}

/// sha256 of text, hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// `canonical(value)`: a value as one string with object keys sorted (by UTF-16 code units, as `Array#sort` does), to
/// tell whether a save changes it.
pub fn canonical(value: &Json) -> String {
    match value {
        Json::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Json::Object(fs) => {
            let mut keys: Vec<&(String, Json)> = fs.iter().collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|(k, v)| format!("{}:{}", Json::String(k.clone()).compact(), canonical(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.compact(),
    }
}

/// A string's length as JavaScript counts it (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 code units.
pub fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `canonicalPrice` (`curriculum/courses.ts`): a stored numeric's text without trailing zeros.
pub fn canonical_price(price: &str) -> String {
    if price.contains('.') {
        let t = price.trim_end_matches('0');
        t.strip_suffix('.').unwrap_or(t).to_owned()
    } else {
        price.to_owned()
    }
}

/// `dueFor` (`curriculum/course-item-rules.ts`): a learner's later due date moves the brief's, never earlier.
pub fn due_for(brief_due: Option<i64>, extended: Option<i64>) -> Option<i64> {
    match (brief_due, extended) {
        (Some(b), Some(e)) => Some(if e > b { e } else { b }),
        (b, _) => b,
    }
}

/// An owner value from the settings: a whole number, or none when blank.
pub fn setting_int(settings: &crate::settings::Settings, key: &str) -> Option<i64> {
    settings.0.get(key).and_then(num)
}

pub fn setting_str<'a>(settings: &'a crate::settings::Settings, key: &str) -> &'a str {
    match settings.0.get(key) {
        Some(Json::String(s)) => s.as_str(),
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_sorts_keys_and_keeps_arrays() {
        let j = json::parse(r#"{"b":[1,{"z":1,"a":null}],"a":"x"}"#).unwrap_or(Json::Null);
        assert_eq!(canonical(&j), r#"{"a":"x","b":[1,{"a":null,"z":1}]}"#);
    }

    #[test]
    fn canonical_price_drops_trailing_zeros() {
        assert_eq!(canonical_price("10.00"), "10");
        assert_eq!(canonical_price("1.50"), "1.5");
        assert_eq!(canonical_price("100"), "100");
    }
}
