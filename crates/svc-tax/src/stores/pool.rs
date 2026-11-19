//! A bounded Postgres pool, as `postgres(url, { max })` keeps one: connections opened lazily, at most `max` at once, a
//! caller waiting for one to come back when all are busy. The size is the owner's `DATABASE_POOL_MAX`; nothing here
//! fills one in.

use std::sync::{Condvar, Mutex, MutexGuard};

use postgres::{Client, NoTls};

use crate::tax::Failure;

pub struct Pool {
    url: String,
    max: usize,
    state: Mutex<State>,
    freed: Condvar,
}

struct State {
    idle: Vec<Client>,
    open: usize,
    closed: bool,
}

/// A database error as svc-tax surfaces it: the server's own message (`PostgresError#message`), else the client's.
pub fn db_failure(e: &postgres::Error) -> Failure {
    Failure::Internal(
        e.as_db_error()
            .map_or_else(|| e.to_string(), |d| d.message().to_owned()),
    )
}

/// One borrowed connection; it goes back to the pool when dropped, unless it broke.
pub struct Conn<'a> {
    pool: &'a Pool,
    client: Option<Client>,
}

impl Conn<'_> {
    pub fn client(&mut self) -> Result<&mut Client, Failure> {
        self.client
            .as_mut()
            .ok_or_else(|| Failure::Internal("connection ended".to_owned()))
    }
}

impl Drop for Conn<'_> {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            let mut state = self.pool.lock();
            if client.is_closed() || state.closed {
                state.open = state.open.saturating_sub(1);
            } else {
                state.idle.push(client);
            }
            drop(state);
            self.pool.freed.notify_one();
        }
    }
}

impl Pool {
    /// `max` is at least 1 (the env check refuses anything else).
    pub fn new(url: &str, max: usize) -> Pool {
        Pool {
            url: url.to_owned(),
            max: max.max(1),
            state: Mutex::new(State {
                idle: Vec::new(),
                open: 0,
                closed: false,
            }),
            freed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A connection: an idle one, a new one while under `max`, else the next one returned.
    pub fn get(&self) -> Result<Conn<'_>, Failure> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return Err(Failure::Internal("pool closed".to_owned()));
            }
            if let Some(client) = state.idle.pop() {
                return Ok(Conn {
                    pool: self,
                    client: Some(client),
                });
            }
            if state.open < self.max {
                state.open += 1;
                drop(state);
                return match Client::connect(&self.url, NoTls) {
                    Ok(client) => Ok(Conn {
                        pool: self,
                        client: Some(client),
                    }),
                    Err(e) => {
                        self.lock().open -= 1;
                        self.freed.notify_one();
                        Err(db_failure(&e))
                    }
                };
            }
            state = self
                .freed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// `sql.end()`: closes idle connections and refuses new borrows; busy ones close when returned.
    pub fn end(&self) {
        let mut state = self.lock();
        state.closed = true;
        let idle = std::mem::take(&mut state.idle);
        state.open = state.open.saturating_sub(idle.len());
        drop(state);
        for client in idle {
            let _ = client.close();
        }
        self.freed.notify_all();
    }
}
