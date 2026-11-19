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
