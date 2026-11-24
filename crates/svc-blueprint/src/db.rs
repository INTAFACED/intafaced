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
