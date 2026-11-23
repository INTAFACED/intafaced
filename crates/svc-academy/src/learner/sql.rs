//! How the learner slice speaks to Postgres, as postgres.js does for the TypeScript: one statement at a time on the
//! pool or inside one transaction, its failure a refusal carrying its SQLSTATE.
//!
//! A time is read as a JavaScript `Date` holds it, epoch milliseconds (`floor(extract(epoch ...) * 1000)`), and written
//! back from them as ISO text (`$n::text::timestamptz`), so a stored time round-trips as the TypeScript's does. A uuid
//! is sent as text and cast where the column needs it; `count(*)::int` is read as an `int4`, as the TypeScript reads it.

use postgres::types::{FromSql, ToSql};
use postgres::{GenericClient, IsolationLevel, Row, Transaction};

use service_kit::time::Instant;

use crate::db::{self, SERIALIZATION_FAILURE};

/// The door's store: a pool, or a store that cannot serve, which refuses at the first statement (as postgres.js fails
/// at its first query, after every check the TypeScript makes before it).
pub type Pool = crate::db::Store;
use crate::errors::Refusal;

/// One query parameter.
pub type P<'a> = &'a (dyn ToSql + Sync);

/// `deadlock_detected`: `transaction` from `@intafaced/db` tries it again, as a serialization failure.
pub const DEADLOCK_DETECTED: &str = "40P01";

/// A timestamp column as epoch milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// A time as a parameter (`Date#toISOString`).
pub fn iso(at: i64) -> String {
    Instant(at).iso()
}

/// Every row of one statement.
pub fn q(c: &mut impl GenericClient, sql: &str, params: &[P<'_>]) -> Result<Vec<Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

/// The first row of one statement, if any.
pub fn first(
    c: &mut impl GenericClient,
    sql: &str,
    params: &[P<'_>],
) -> Result<Option<Row>, Refusal> {
    Ok(q(c, sql, params)?.into_iter().next())
}

/// One statement whose rows are not read.
pub fn exec(c: &mut impl GenericClient, sql: &str, params: &[P<'_>]) -> Result<u64, Refusal> {
    c.execute(sql, params).map_err(|e| db::refusal(&e))
}

/// Column `i` of a row.
pub fn cell<'a, T: FromSql<'a>>(row: &'a Row, i: usize) -> Result<T, Refusal> {
    row.try_get(i).map_err(|e| db::refusal(&e))
}

/// The first column of every row.
pub fn column<T: for<'a> FromSql<'a>>(rows: &[Row]) -> Result<Vec<T>, Refusal> {
    rows.iter().map(|r| cell(r, 0)).collect()
}

/// One statement on a connection of the pool (`sql\`...\`` outside a transaction).
pub fn on_pool<T>(
    pool: &Pool,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    db::with_client(pool.pool()?, f)
}

/// `sql.begin(fn)`: one transaction at the server's default isolation (read committed), never tried again.
pub fn begin<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    db::transaction(pool.pool()?, IsolationLevel::ReadCommitted, f)
}

/// `sql.begin('isolation level repeatable read read only', fn)`.
pub fn begin_repeatable_read_only<T>(
    pool: &Pool,
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

/// Whether a refusal is a failure `transaction` tries again.
fn retried(r: &Refusal) -> bool {
    matches!(r, Refusal::Internal { code: Some(code), .. } if code == SERIALIZATION_FAILURE || code == DEADLOCK_DETECTED)
}

/// `transaction(sql, fn)` from `@intafaced/db`: serializable, tried again up to five times (full-jitter backoff) on a
/// serialization failure or a deadlock.
pub fn serializable<T>(
    pool: &Pool,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let pool = pool.pool()?;
    let mut attempt: u32 = 1;
    loop {
        match db::transaction(pool, IsolationLevel::Serializable, &mut f) {
            Err(r) if retried(&r) && attempt < 5 => {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u64::from(d.subsec_nanos()));
                let ceiling = (5u64 << attempt).max(1);
                std::thread::sleep(std::time::Duration::from_millis(nanos % ceiling));
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// Whether a refusal is a failure with this SQLSTATE (`(err as { code }).code === '23505'`).
pub fn has_code(r: &Refusal, sqlstate: &str) -> bool {
    matches!(r, Refusal::Internal { code: Some(code), .. } if code == sqlstate)
}
