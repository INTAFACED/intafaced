//! The Academy's database: the `academy` schema in Postgres, through the kit's bounded pool (`service_kit::pg`).
//!
//! A slice reaches it through [`crate::door::Ctx::service`], which gives the pool or the refusal a store that cannot
//! serve answers with. [`transaction`] runs a closure in one transaction at an isolation level (`sql.begin('isolation
//! level serializable', ...)`); [`sqlstate`] reads a failure's SQLSTATE, the code a TypeScript handler matched on
//! (`23505` a unique violation, `40001` a serialization failure).

use postgres::{Client, IsolationLevel, Transaction};

use service_kit::pg::{DbError, Pool, db_message};

use crate::errors::Refusal;

/// `unique_violation`.
pub const UNIQUE_VIOLATION: &str = "23505";
/// `foreign_key_violation`.
pub const FOREIGN_KEY_VIOLATION: &str = "23503";
/// `serialization_failure`.
pub const SERIALIZATION_FAILURE: &str = "40001";

/// Where the service's state lives.
pub enum Store {
    /// The real database.
    Pool(Pool),
    /// A database that refuses every query with this message (the replay's store-down mode).
    Down(String),
    /// Every call that reaches the service throws this refusal (the replay's refusing service).
    Refuses(Refusal),
}

impl Store {
    /// The pool, or what a store that cannot serve refuses with.
    pub fn pool(&self) -> Result<&Pool, Refusal> {
        match self {
            Store::Pool(p) => Ok(p),
            Store::Down(message) => Err(Refusal::db(message.clone(), None)),
            Store::Refuses(r) => Err(r.clone()),
        }
    }

    /// `sql.end()`.
    pub fn end(&self) {
        if let Store::Pool(p) = self {
            p.end();
        }
    }
}

/// A failure's SQLSTATE, when the server sent one.
pub fn sqlstate(e: &postgres::Error) -> Option<String> {
    e.code().map(|c| c.code().to_owned())
}

/// A database failure as a refusal: its message and SQLSTATE.
pub fn refusal(e: &postgres::Error) -> Refusal {
    Refusal::db(db_message(e), sqlstate(e))
}

/// A pool failure (no connection) as a refusal.
pub fn pool_refusal(e: DbError) -> Refusal {
    Refusal::db(e.0, None)
}

/// One transaction at `isolation`: committed when `f` succeeds, rolled back when it refuses.
pub fn transaction<T>(
    pool: &Pool,
    isolation: IsolationLevel,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.get().map_err(pool_refusal)?;
    let client: &mut Client = conn.client().map_err(pool_refusal)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(isolation)
        .start()
        .map_err(|e| refusal(&e))?;
    let out = f(&mut tx)?;
    tx.commit().map_err(|e| refusal(&e))?;
    Ok(out)
}

/// One statement or query outside a transaction.
pub fn with_client<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.get().map_err(pool_refusal)?;
    let client = conn.client().map_err(pool_refusal)?;
    f(client)
}

/// `isSerializationFailure` (`packages/db`): `serialization_failure` or `deadlock_detected`.
pub fn is_serialization_failure(r: &Refusal) -> bool {
    matches!(r, Refusal::Internal { code: Some(c), .. } if c == SERIALIZATION_FAILURE || c == "40P01")
}

/// `transaction(sql, fn, { isolation })` from `@intafaced/db`: one transaction at `isolation`, run again (up to five
/// attempts, full-jitter backoff) when it fails with a serialization failure or a deadlock; any other refusal stands.
pub fn transaction_retrying<T>(
    pool: &Pool,
    isolation: IsolationLevel,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    const MAX_ATTEMPTS: u32 = 5;
    let mut attempt = 1;
    loop {
        match transaction(pool, isolation, &mut f) {
            Err(e) if is_serialization_failure(&e) && attempt < MAX_ATTEMPTS => {
                // `Math.random() * 2 ** attempt * 5` milliseconds.
                let ceiling = (1u64 << attempt) * 5;
                let mut b = [0u8; 8];
                let jitter =
                    getrandom::fill(&mut b).map_or(0, |()| u64::from_le_bytes(b) % ceiling);
                std::thread::sleep(std::time::Duration::from_millis(jitter));
                attempt += 1;
            }
            out => return out,
        }
    }
}
