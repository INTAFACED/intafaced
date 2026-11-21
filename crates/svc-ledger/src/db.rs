//! The ledger's database: the `ledger` schema in Postgres, through one bounded pool (`service_kit::pg`) made once in
//! the binary and passed to every slice (`docs/agents/shape.md` rule 5).
//!
//! Every connection is opened as `ledgerPostgresOptions` (`services/svc-ledger/src/db/connection-options.ts`) opens
//! one: `search_path` `ledger,public`, the service's `application_name`, a 15 s `statement_timeout` and a 60 s
//! `idle_in_transaction_session_timeout` (a stalled post must release the `chain_tip` lock, never hold it), and a
//! 10 s connect timeout. [`transaction`] runs a closure in one transaction at an isolation level.

use postgres::{Client, IsolationLevel, Transaction};

use service_kit::pg::{DbError, Pool, db_message};

/// `LEDGER_STATEMENT_TIMEOUT_MS`.
pub const STATEMENT_TIMEOUT_MS: u32 = 15_000;
/// `LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS`.
pub const IDLE_IN_TRANSACTION_TIMEOUT_MS: u32 = 60_000;
/// `LEDGER_CONNECT_TIMEOUT_S`.
pub const CONNECT_TIMEOUT_S: u32 = 10;

/// A database failure: the message the TypeScript service surfaced and, when the server sent one, its SQLSTATE (the
/// `code` Fastify puts in a 500's body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub message: String,
    pub code: Option<String>,
    /// The server never answered: the connection was refused, dropped or timed out (the TypeScript driver's socket
    /// codes, `ECONNREFUSED` and the like). A write that fails so is blocked, not faulty (`write-block.ts`).
    pub socket: bool,
}

impl StoreError {
    pub fn new(message: impl Into<String>, code: Option<&str>) -> StoreError {
        StoreError {
            message: message.into(),
            code: code.map(str::to_owned),
            socket: false,
        }
    }
}

impl From<&postgres::Error> for StoreError {
    fn from(e: &postgres::Error) -> StoreError {
        StoreError {
            message: db_message(e),
            code: e.code().map(|c| c.code().to_owned()),
            socket: e.as_db_error().is_none() && (e.is_closed() || io_error(e)),
        }
    }
}

/// An error that came from the socket itself.
fn io_error(e: &postgres::Error) -> bool {
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        if s.is::<std::io::Error>() {
            return true;
        }
        source = s.source();
    }
    false
}

impl From<postgres::Error> for StoreError {
    fn from(e: postgres::Error) -> StoreError {
        StoreError::from(&e)
    }
}

impl From<DbError> for StoreError {
    fn from(e: DbError) -> StoreError {
        // The pool fails only to connect, or when it or its connection has ended.
        StoreError {
            message: e.0,
            code: None,
            socket: true,
        }
    }
}

/// Where the book lives.
pub enum Store {
    /// The real database.
    Pool(Pool),
    /// A database that refuses every query with this message (the replay's stubbed `sql`).
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

/// `DATABASE_URL` with the session settings `ledgerPostgresOptions` gives every connection.
pub fn connection_url(database_url: &str, service_name: &str) -> Result<String, String> {
    let mut url = url::Url::parse(database_url).map_err(|e| format!("DATABASE_URL: {e}"))?;
    // The driver decodes `%XX` but not form encoding's `+`, so each value is percent-encoded in full.
    let enc = |v: &str| {
        url::form_urlencoded::byte_serialize(v.as_bytes())
            .collect::<String>()
            .replace('+', "%20")
    };
    let options = format!(
        "-c search_path=ledger,public -c statement_timeout={STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout={IDLE_IN_TRANSACTION_TIMEOUT_MS}"
    );
    let ours = format!(
        "application_name={}&connect_timeout={CONNECT_TIMEOUT_S}&options={}",
        enc(service_name),
        enc(&options)
    );
    let query = match url.query().filter(|q| !q.is_empty()) {
        Some(q) => format!("{q}&{ours}"),
        None => ours,
    };
    url.set_query(Some(&query));
    Ok(url.into())
}

/// The pool `index.ts` opens: `DATABASE_POOL_MAX` connections at most, each with the ledger's session settings.
/// `DATABASE_SSL=true` (`ssl: 'require'`) is refused: the kit's pool speaks plain TCP only, and a ledger that silently
/// dropped TLS would be worse than one that does not start.
pub fn open(
    database_url: &str,
    service_name: &str,
    pool_max: usize,
    ssl: bool,
) -> Result<Store, String> {
    if ssl {
        return Err(
            "DATABASE_SSL=true: svc-ledger's Rust port has no TLS client yet; it refuses to connect without it"
                .to_owned(),
        );
    }
    Ok(Store::Pool(Pool::new(
        &connection_url(database_url, service_name)?,
        pool_max,
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
    fn every_connection_carries_the_ledgers_session_settings() {
        let url = connection_url("postgres://u:p@db:5432/intafaced", "svc-ledger").unwrap();
        let config: postgres::Config = url.parse().unwrap();
        assert_eq!(config.get_application_name(), Some("svc-ledger"));
        assert_eq!(
            config.get_connect_timeout(),
            Some(&std::time::Duration::from_secs(10))
        );
        assert_eq!(
            config.get_options(),
            Some(
                "-c search_path=ledger,public -c statement_timeout=15000 -c idle_in_transaction_session_timeout=60000"
            )
        );
        assert_eq!(config.get_dbname(), Some("intafaced"));
    }

    #[test]
    fn a_tls_database_is_refused_rather_than_reached_in_the_clear() {
        assert!(open("postgres://u:p@db/x", "svc-ledger", 1, true).is_err());
    }
}
