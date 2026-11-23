//! One session advisory lock, without starving the pool that holds it (`session-lock.ts`): the lock
//! `pg_advisory_lock(hashtext(namespace), hashtext(key))` is taken on one connection of the pool and held for the
//! body's span while the body runs its queries on the pool's other connections; at most half the pool (at least one)
//! holds such a lock at once, so the bodies always find a connection. A caller past that waits holding no connection.

use std::sync::{Condvar, Mutex};

use crate::db::{Store, StoreError};
use crate::errors::Refusal;

/// The slots lock holders may take (`sessionLockCapacity(DATABASE_POOL_MAX)`), and the pool's size.
pub struct Gate {
    pub pool_max: usize,
    active: Mutex<usize>,
    freed: Condvar,
}

impl Gate {
    pub fn new(pool_max: usize) -> Gate {
        Gate {
            pool_max,
            active: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    fn capacity(&self) -> usize {
        (self.pool_max / 2).max(1)
    }

    fn enter(&self) {
        let mut n = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *n >= self.capacity() {
            n = self
                .freed
                .wait(n)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *n += 1;
    }

    fn leave(&self) {
        let mut n = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *n = n.saturating_sub(1);
        drop(n);
        self.freed.notify_one();
    }
}

fn store_err(e: impl Into<StoreError>) -> Refusal {
    Refusal::Other(e.into().message)
}

/// `withSessionAdvisoryLock(sql, namespace, key, body)`: `body` runs while the lock is held, and the lock is let go on
/// the same connection whatever `body` did.
pub fn with_lock<T>(
    store: &Store,
    gate: &Gate,
    namespace: &str,
    key: &str,
    body: impl FnOnce() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let pool = store.pool().map_err(store_err)?;
    if gate.pool_max < 2 {
        return Err(Refusal::Other(format!(
            "A session advisory lock needs DATABASE_POOL_MAX >= 2 (got {}): the body cannot borrow a connection",
            gate.pool_max
        )));
    }
    gate.enter();
    let out = (|| {
        let mut conn = pool.get().map_err(store_err)?;
        let client = conn.client().map_err(store_err)?;
        client
            .execute(
                "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
                &[&namespace, &key],
            )
            .map_err(store_err)?;
        let out = body();
        let freed = client.execute(
            "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
            &[&namespace, &key],
        );
        match (out, freed) {
            (Err(e), _) => Err(e),
            (Ok(_), Err(e)) => Err(store_err(e)),
            (Ok(v), Ok(_)) => Ok(v),
        }
    })();
    gate.leave();
    out
}
