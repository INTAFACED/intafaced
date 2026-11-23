//! svc-agents' database: the `agents` schema in Postgres, through one bounded pool (`service_kit::pg`) made once in the
//! binary and passed to every slice (`docs/agents/shape.md` rule 5).
//!
//! Every connection is opened as `index.ts` opens its `postgres(...)` pool: `search_path` `agents,public` and the
//! service's `application_name`, at most `DATABASE_POOL_MAX` connections. [`transaction`] runs a closure in one
//! transaction at an isolation level; [`with_client`] runs one outside a transaction.

use postgres::{Client, IsolationLevel, Transaction};

use service_kit::pg::{DbError, Pool, db_message};

/// A database failure: the driver's message and, when the server sent one, its SQLSTATE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub message: String,
    pub code: Option<String>,
}

impl StoreError {
    pub fn new(message: impl Into<String>, code: Option<&str>) -> StoreError {
        StoreError {
            message: message.into(),
            code: code.map(str::to_owned),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(f, "{} [{code}]", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl From<&postgres::Error> for StoreError {
    fn from(e: &postgres::Error) -> StoreError {
        StoreError {
            message: db_message(e),
            code: e.code().map(|c| c.code().to_owned()),
        }
    }
}

impl From<postgres::Error> for StoreError {
    fn from(e: postgres::Error) -> StoreError {
        StoreError::from(&e)
    }
}

impl From<DbError> for StoreError {
    fn from(e: DbError) -> StoreError {
        StoreError {
            message: e.0,
            code: None,
        }
    }
}

/// Where the agents' tables live.
pub enum Store {
    /// The real database.
    Pool(Pool),
    /// A database that refuses every query with this message (a door built without one, as the replay builds it).
    Down(String),
}

impl Store {
    /// The pool, or the refusal a store that cannot serve answers with.
    pub fn pool(&self) -> Result<&Pool, StoreError> {
        match self {
            Store::Pool(p) => Ok(p),
            Store::Down(message) => Err(StoreError::new(message.clone(), None)),
        }
    }

    /// `sql.end()`.
    pub fn end(&self) {
        if let Store::Pool(p) = self {
            p.end();
        }
    }
}

/// `DATABASE_URL` with the session settings `index.ts` gives every connection.
pub fn connection_url(database_url: &str, service_name: &str) -> Result<String, String> {
    let mut url = url::Url::parse(database_url).map_err(|e| format!("DATABASE_URL: {e}"))?;
    // The driver decodes `%XX` but not form encoding's `+`, so each value is percent-encoded in full.
    let enc = |v: &str| {
        url::form_urlencoded::byte_serialize(v.as_bytes())
            .collect::<String>()
            .replace('+', "%20")
    };
    let ours = format!(
        "application_name={}&options={}",
        enc(service_name),
        enc("-c search_path=agents,public")
    );
    let query = match url.query().filter(|q| !q.is_empty()) {
        Some(q) => format!("{q}&{ours}"),
        None => ours,
    };
    url.set_query(Some(&query));
    Ok(url.into())
}

/// The pool `index.ts` opens: `DATABASE_POOL_MAX` connections at most, each with the agents' session settings.
/// `DATABASE_SSL=true` (`ssl: 'require'`) is refused: the kit's pool speaks plain TCP only, and a service that silently
/// dropped TLS would be worse than one that does not start.
pub fn open(
    database_url: &str,
    service_name: &str,
    pool_max: usize,
    ssl: bool,
) -> Result<Store, String> {
    if ssl {
        return Err(
            "DATABASE_SSL=true: svc-agents' Rust port has no TLS client yet; it refuses to connect without it"
                .to_owned(),
        );
    }
    Ok(Store::Pool(Pool::new(
        &connection_url(database_url, service_name)?,
        pool_max.max(1),
    )))
}

/// One transaction at `isolation`: committed when `f` succeeds, rolled back when it fails.
pub fn transaction<T>(
    pool: &Pool,
    isolation: IsolationLevel,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut conn = pool.get()?;
    let client: &mut Client = conn.client()?;
    let mut tx = client
        .build_transaction()
        .isolation_level(isolation)
        .start()?;
    let out = f(&mut tx)?;
    tx.commit()?;
    Ok(out)
}

/// A transaction body's error that may carry a database failure, so a serialization failure or a deadlock can be
/// told apart from the body's own refusal.
pub trait Retryable {
    fn store(&self) -> Option<&StoreError>;
}

impl Retryable for StoreError {
    fn store(&self) -> Option<&StoreError> {
        Some(self)
    }
}

/// `transaction(sql, fn, { isolation, maxAttempts })` (`@intafaced/db`): `f` in one transaction, run again from the
/// start on a serialization failure (40001) or a deadlock (40P01), at most `attempts` times; any other failure, and
/// the body's own refusals, end it at once. Rolled back whenever `f` fails.
pub fn transaction_retrying<T, E: Retryable + From<StoreError>>(
    pool: &Pool,
    isolation: IsolationLevel,
    attempts: u32,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, E>,
) -> Result<T, E> {
    let mut attempt = 1;
    loop {
        let out: Result<T, E> = (|| {
            let mut conn = pool.get().map_err(StoreError::from)?;
            let client: &mut Client = conn.client().map_err(StoreError::from)?;
            let mut tx = client
                .build_transaction()
                .isolation_level(isolation)
                .start()
                .map_err(StoreError::from)?;
            let out = f(&mut tx)?;
            tx.commit().map_err(StoreError::from)?;
            Ok(out)
        })();
        match out {
            Err(e)
                if attempt < attempts
                    && e.store()
                        .and_then(|s| s.code.as_deref())
                        .is_some_and(|c| c == "40001" || c == "40P01") =>
            {
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// One statement or query outside a transaction.
pub fn with_client<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Client) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut conn = pool.get()?;
    let client = conn.client()?;
    f(client)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn every_connection_carries_the_agents_session_settings() {
        let url = connection_url(
            "postgres://u:p@db:5432/intafaced?sslmode=disable",
            "svc-agents",
        )
        .unwrap();
        let config: postgres::Config = url.parse().unwrap();
        assert_eq!(config.get_application_name(), Some("svc-agents"));
        assert_eq!(config.get_options(), Some("-c search_path=agents,public"));
        assert_eq!(config.get_dbname(), Some("intafaced"));
        assert_eq!(config.get_user(), Some("u"));
    }

    #[test]
    fn a_tls_database_is_refused_rather_than_reached_in_the_clear() {
        assert!(open("postgres://u:p@db/x", "svc-agents", 1, true).is_err());
    }

    #[test]
    fn a_down_store_refuses_with_its_message() {
        let store = Store::Down("no database".to_owned());
        assert_eq!(store.pool().err().unwrap().message, "no database");
    }
}
