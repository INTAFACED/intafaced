//! svc-tax's Postgres pool is the kit's (`service_kit::pg`); a database failure reaches a caller as
//! `Failure::Internal` with the message the TypeScript service sent.

pub use service_kit::pg::{Conn, DbError, Pool};

use crate::tax::Failure;

/// A database error as svc-tax surfaces it: the server's own message (`PostgresError#message`), else the client's.
pub fn db_failure(e: &postgres::Error) -> Failure {
    Failure::Internal(service_kit::pg::db_message(e))
}

impl From<DbError> for Failure {
    fn from(e: DbError) -> Failure {
        Failure::Internal(e.0)
    }
}
