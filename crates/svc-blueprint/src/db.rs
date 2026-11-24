//! svc-blueprint's database: the `blueprint` schema in Postgres, through one bounded pool (`service_kit::pg`) made once
//! at start-up and passed to the door (`docs/agents/shape.md` rule 5).
//!
//! Every connection is opened as `index.ts` opens its `postgres(...)` pool: `search_path` `blueprint,public` and the
//! service's `application_name`, at most `DATABASE_POOL_MAX` connections.

use service_kit::pg::{DbError, Pool, db_message};

/// A database failure: the driver's message and, when the server sent one, its SQLSTATE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub message: String,
    pub code: Option<String>,
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

/// Where the Blueprint's tables live.
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
            Store::Down(message) => Err(StoreError {
                message: message.clone(),
                code: None,
            }),
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
        enc("-c search_path=blueprint,public")
    );
    let query = match url.query().filter(|q| !q.is_empty()) {
        Some(q) => format!("{q}&{ours}"),
        None => ours,
    };
    url.set_query(Some(&query));
    Ok(url.into())
}

/// The pool `index.ts` opens: `DATABASE_POOL_MAX` connections at most, each with the Blueprint's session settings.
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
            "DATABASE_SSL=true: svc-blueprint's Rust port has no TLS client yet; it refuses to connect without it"
                .to_owned(),
        );
    }
    Ok(Store::Pool(Pool::new(
        &connection_url(database_url, service_name)?,
        pool_max.max(1),
    )))
}

/// `isSerializationFailure` (`packages/db`): `serialization_failure` or `deadlock_detected`.
pub fn is_serialization_failure(r: &crate::errors::Refusal) -> bool {
    matches!(r, crate::errors::Refusal::Other { code: Some(c), .. } if c == "40001" || c == "40P01")
}

/// `transaction(sql, fn)` from `@intafaced/db`: one `serializable` transaction, committed when `f` succeeds and rolled
/// back when it refuses, run again (up to five attempts, full-jitter backoff) when it fails with a serialization
/// failure or a deadlock; any other refusal stands.
pub fn transaction<T>(
    store: &Store,
    mut f: impl FnMut(&mut postgres::Transaction<'_>) -> Result<T, crate::errors::Refusal>,
) -> Result<T, crate::errors::Refusal> {
    const MAX_ATTEMPTS: u32 = 5;
    let pool = store.pool()?;
    let mut attempt = 1;
    loop {
        let mut once = || -> Result<T, crate::errors::Refusal> {
            let mut conn = pool.get().map_err(StoreError::from)?;
            let client = conn.client().map_err(StoreError::from)?;
            let mut tx = client
                .build_transaction()
                .isolation_level(postgres::IsolationLevel::Serializable)
                .start()
                .map_err(StoreError::from)?;
            let out = f(&mut tx)?;
            tx.commit().map_err(StoreError::from)?;
            Ok(out)
        };
        match once() {
            Err(e) if is_serialization_failure(&e) && attempt < MAX_ATTEMPTS => {
                // `Math.random() * 2 ** attempt * 5` milliseconds; the clock's nanoseconds stand in for the randomness.
                let ceiling = (1u64 << attempt) * 5;
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u64::from(d.subsec_nanos()));
                std::thread::sleep(std::time::Duration::from_millis(nanos % ceiling));
                attempt += 1;
            }
            out => return out,
        }
    }
}
