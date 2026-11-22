//! svc-bank's database: the `bank` schema in Postgres, through one bounded pool (`service_kit::pg`) made once in the
//! binary and passed to every slice (`docs/agents/shape.md` rule 5).
//!
//! Every connection is opened as `index.ts` opens its `postgres(...)` pool: `search_path` `bank,public` and the
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

/// Where the bank's tables live.
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

/// `DATABASE_URL` with the session settings `index.ts` gives every request-pool connection: the service's
/// `application_name` and `search_path` `bank,public`.
pub fn connection_url(database_url: &str, service_name: &str) -> Result<String, String> {
    with_session(database_url, service_name, Some("bank,public"))
}

/// `DATABASE_URL` with `application_name` and, when given, a `search_path`.
fn with_session(
    database_url: &str,
    application_name: &str,
    search_path: Option<&str>,
) -> Result<String, String> {
    let mut url = url::Url::parse(database_url).map_err(|e| format!("DATABASE_URL: {e}"))?;
    // The driver decodes `%XX` but not form encoding's `+`, so each value is percent-encoded in full.
    let enc = |v: &str| {
        url::form_urlencoded::byte_serialize(v.as_bytes())
            .collect::<String>()
            .replace('+', "%20")
    };
    let mut ours = format!("application_name={}", enc(application_name));
    if let Some(path) = search_path {
        ours.push_str(&format!(
            "&options={}",
            enc(&format!("-c search_path={path}"))
        ));
    }
    let query = match url.query().filter(|q| !q.is_empty()) {
        Some(q) => format!("{q}&{ours}"),
        None => ours,
    };
    url.set_query(Some(&query));
    Ok(url.into())
}

/// What a `DATABASE_SSL=true` start refuses with: the kit's pool speaks plain TCP only, and a service that silently
/// dropped TLS would be worse than one that does not start.
const NO_TLS: &str = "DATABASE_SSL=true: svc-bank's Rust port has no TLS client yet; it refuses to connect without it";

/// The pool `index.ts` opens: `DATABASE_POOL_MAX` connections at most, each with the bank's session settings.
/// `DATABASE_SSL=true` (`ssl: 'require'`) is refused ([`NO_TLS`]).
pub fn open(
    database_url: &str,
    service_name: &str,
    pool_max: usize,
    ssl: bool,
) -> Result<Store, String> {
    if ssl {
        return Err(NO_TLS.to_owned());
    }
    Ok(Store::Pool(Pool::new(
        &connection_url(database_url, service_name)?,
        pool_max.max(1),
    )))
}

/// The recovery jobs' lock connection (`recoveryLock` in `index.ts`): one connection of its own, never a slot of the
/// request pool, named `<SERVICE_NAME>-recovery` and with no `search_path` of its own, as the TypeScript opens it.
pub fn open_lock(database_url: &str, service_name: &str, ssl: bool) -> Result<Pool, String> {
    if ssl {
        return Err(NO_TLS.to_owned());
    }
    Ok(Pool::new(
        &with_session(database_url, &format!("{service_name}-recovery"), None)?,
        1,
    ))
}

/// What `index.ts` throws when the schema is not there.
pub const SCHEMA_MISSING: &str = "bank schema is missing — run migrations before starting svc-bank";

/// `SELECT 1 FROM bank.spaces LIMIT 1`: any failure is the missing schema.
pub fn check_schema(store: &Store) -> Result<(), String> {
    let pool = store.pool().map_err(|_| SCHEMA_MISSING.to_owned())?;
    with_client(pool, |c| {
        c.query("SELECT 1 FROM bank.spaces LIMIT 1", &[])?;
        Ok(())
    })
    .map_err(|_| SCHEMA_MISSING.to_owned())
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
    fn every_connection_carries_the_banks_session_settings() {
        let url = connection_url(
            "postgres://u:p@db:5432/intafaced?sslmode=disable",
            "svc-bank",
        )
        .unwrap();
        let config: postgres::Config = url.parse().unwrap();
        assert_eq!(config.get_application_name(), Some("svc-bank"));
        assert_eq!(config.get_options(), Some("-c search_path=bank,public"));
        assert_eq!(config.get_dbname(), Some("intafaced"));
        assert_eq!(config.get_user(), Some("u"));
    }

    #[test]
    fn the_recovery_lock_connection_is_named_for_it_and_sets_no_search_path() {
        let url = with_session(
            "postgres://u:p@db:5432/intafaced",
            "svc-bank-recovery",
            None,
        )
        .unwrap();
        let config: postgres::Config = url.parse().unwrap();
        assert_eq!(config.get_application_name(), Some("svc-bank-recovery"));
        assert_eq!(config.get_options(), None);
    }

    #[test]
    fn a_tls_database_is_refused_rather_than_reached_in_the_clear() {
        assert!(open("postgres://u:p@db/x", "svc-bank", 1, true).is_err());
        assert!(open_lock("postgres://u:p@db/x", "svc-bank", true).is_err());
    }

    #[test]
    fn a_store_without_a_database_reads_as_the_missing_schema() {
        assert_eq!(
            check_schema(&Store::Down("no database".to_owned())),
            Err(SCHEMA_MISSING.to_owned())
        );
    }

    #[test]
    fn a_down_store_refuses_with_its_message() {
        let store = Store::Down("no database".to_owned());
        assert_eq!(store.pool().err().unwrap().message, "no database");
    }
}
