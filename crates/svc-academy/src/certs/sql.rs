//! How the certificate SQL reads and writes the values postgres.js handed the TypeScript: a time as epoch milliseconds
//! (`floor`, as a JavaScript `Date` keeps it) and written back as its ISO text; a `uuid` parameter sent as text and cast,
//! so a malformed one fails in the database as it did; a `count(*)::int` as an `int4`.

use postgres::GenericClient;
use postgres::types::{FromSql, ToSql};

use service_kit::time::Instant;

use crate::db;
use crate::errors::Refusal;

/// The parameters of one statement.
pub type Params<'a> = &'a [&'a (dyn ToSql + Sync)];

/// A timestamp column as a JavaScript `Date` holds it: epoch milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// A time as the query parameter postgres.js sends for a `Date`.
pub fn iso(at: i64) -> String {
    Instant(at).iso()
}

/// The rows of one query.
pub fn q<C: GenericClient>(
    c: &mut C,
    sql: &str,
    params: Params<'_>,
) -> Result<Vec<postgres::Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

/// One statement, its row count.
pub fn exec<C: GenericClient>(c: &mut C, sql: &str, params: Params<'_>) -> Result<u64, Refusal> {
    c.execute(sql, params).map_err(|e| db::refusal(&e))
}

/// Column `i` of a row.
pub fn cell<'a, T: FromSql<'a>>(row: &'a postgres::Row, i: usize) -> Result<T, Refusal> {
    row.try_get(i).map_err(|e| db::refusal(&e))
}

/// `pg_advisory_xact_lock(hashtextextended(key, 0))`.
pub fn lock_extended<C: GenericClient>(c: &mut C, key: &str) -> Result<(), Refusal> {
    q(
        c,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&key],
    )
    .map(|_| ())
}

/// `pg_advisory_xact_lock(hashtext(key))`.
pub fn lock<C: GenericClient>(c: &mut C, key: &str) -> Result<(), Refusal> {
    q(c, "SELECT pg_advisory_xact_lock(hashtext($1))", &[&key]).map(|_| ())
}

/// An integer column (`integer`) as JavaScript's number.
pub fn int(v: i32) -> i64 {
    i64::from(v)
}
