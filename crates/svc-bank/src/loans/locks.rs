//! `withSessionAdvisoryLocks` (`session-lock.ts`): session advisory locks held on one reserved connection while the
//! body runs on others, across replicas. At most half the pool holds such a lock at once, so the bodies can always
//! borrow a connection; a pool of fewer than two refuses, as the body could not borrow one.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};

use crate::db::Store;
use crate::errors::Refusal;
use crate::spaces::space::pg;

struct Gates {
    active: Mutex<HashMap<usize, usize>>,
    freed: Condvar,
}

fn gates() -> &'static Gates {
    static G: OnceLock<Gates> = OnceLock::new();
    G.get_or_init(|| Gates {
        active: Mutex::new(HashMap::new()),
        freed: Condvar::new(),
    })
}

/// `sessionLockCapacity`.
pub fn capacity(pool_max: usize) -> usize {
    (pool_max / 2).max(1)
}

struct Slot(usize);

impl Drop for Slot {
    fn drop(&mut self) {
        let g = gates();
        let mut active = g
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(n) = active.get_mut(&self.0) {
            *n = n.saturating_sub(1);
        }
        drop(active);
        g.freed.notify_all();
    }
}

fn enter(pool_key: usize, cap: usize) -> Slot {
    let g = gates();
    let mut active = g
        .active
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    loop {
        let n = active.entry(pool_key).or_insert(0);
        if *n < cap {
            *n += 1;
            return Slot(pool_key);
        }
        active = g
            .freed
            .wait(active)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

/// `withSessionAdvisoryLocks`: each namespace's lock on `key`, taken in sorted order on one connection, then `body`,
/// then each released in reverse, whatever `body` answered.
pub fn with_locks<T>(
    store: &Store,
    namespaces: &[&str],
    key: &str,
    body: impl FnOnce() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut ordered: Vec<&str> = namespaces.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    if ordered.is_empty() {
        return Err(Refusal::Other(
            "A session advisory lock needs a namespace".to_owned(),
        ));
    }
    let pool = store
        .pool()
        .map_err(|e| Refusal::Other(e.message.clone()))?;
    let max = pool.max();
    if max < 2 {
        return Err(Refusal::Other(format!(
            "A session advisory lock needs DATABASE_POOL_MAX >= 2 (got {max}): the body cannot borrow a connection"
        )));
    }
    let _slot = enter(std::ptr::from_ref(pool) as usize, capacity(max));
    let mut conn = pool.get().map_err(|e| Refusal::Other(e.0))?;
    let client = conn.client().map_err(|e| Refusal::Other(e.0))?;
    let mut held: Vec<&str> = Vec::new();
    let mut taken = Ok(());
    for ns in &ordered {
        match client.execute(
            "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
            &[ns, &key],
        ) {
            Ok(_) => held.push(ns),
            Err(e) => {
                taken = Err(pg(&e));
                break;
            }
        }
    }
    let out = taken.and_then(|()| body());
    for ns in held.iter().rev() {
        let _ = client.execute(
            "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
            &[ns, &key],
        );
    }
    out
}

/// `withSessionAdvisoryLock`: one namespace.
pub fn with_lock<T>(
    store: &Store,
    namespace: &str,
    key: &str,
    body: impl FnOnce() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    with_locks(store, &[namespace], key, body)
}
