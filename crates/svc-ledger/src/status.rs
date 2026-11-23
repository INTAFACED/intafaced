//! `GET /health` and `GET /ready` (`services/svc-ledger/src/status-http.ts`), and the reads under them: the posting
//! freeze as the database holds it (`ledger/freeze.ts` `readFreeze`, every time, no cached copy) and when the book was
//! last proved consistent (`ledger/reconcile.ts` `readLastVerified`).
//!
//! `/health` stays 200 while frozen (the process is alive) and names why (`frozenCause`). `/ready` answers 503 while
//! frozen, so a frozen replica leaves the load balancer's rotation. A failed freeze read is Fastify's 500; a failed
//! last-verified read leaves both fields null and never takes liveness down.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::server::Response;

use crate::db::{Store, StoreError, with_client};

/// `RECONCILE_ACTOR`: who the automatic freeze names.
pub const RECONCILE_ACTOR: &str = "reconciliation";
/// `RECONCILE_UNPROVEN_REASON`: the freeze after too many proofs in a row never reached a verdict.
pub const RECONCILE_UNPROVEN_REASON: &str = "reconcile_unproven";
/// `MISSING` (`freeze.ts`): the posting freeze row is not there.
pub const FREEZE_MISSING: &str = "posting_freeze row is missing — run migrations (0002_durable_freeze) before starting svc-ledger";

/// The freeze row (`FreezeState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreezeState {
    pub frozen: bool,
    /// Why it is frozen. Null exactly when `frozen` is false.
    pub reason: Option<String>,
    /// Who last moved the switch, in either direction.
    pub actor: Option<String>,
    /// `changedAt.toISOString()`: the instant at millisecond precision, UTC.
    pub changed_at: String,
    /// `changed_at::text`: the column's own text, every microsecond kept.
    pub changed_at_precise: String,
}

/// The columns every freeze read selects, in [`FreezeState`]'s order.
pub const FREEZE_COLUMNS: &str = "frozen, reason, actor, \
     to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS changed_at_iso, \
     changed_at::text AS changed_at_precise";

/// One freeze row as [`FREEZE_COLUMNS`] selects it.
pub fn freeze_row(row: &postgres::Row) -> Result<FreezeState, StoreError> {
    Ok(FreezeState {
        frozen: row.try_get(0)?,
        reason: row.try_get(1)?,
        actor: row.try_get(2)?,
        changed_at: row.try_get(3)?,
        changed_at_precise: row.try_get(4)?,
    })
}

/// `readFreeze(sql)`.
pub fn read_freeze(c: &mut impl GenericClient) -> Result<FreezeState, StoreError> {
    let rows = c.query(
        &format!("SELECT {FREEZE_COLUMNS} FROM ledger.posting_freeze WHERE id = true"),
        &[],
    )?;
    match rows.first() {
        Some(row) => freeze_row(row),
        None => Err(StoreError::new(
            FREEZE_MISSING,
            Some("ledger.uninitialised"),
        )),
    }
}

/// `LedgerService.status()`: what the database says the switch is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub posting_enabled: bool,
    pub frozen_reason: Option<String>,
    pub frozen_by: Option<String>,
}

pub fn status(store: &Store) -> Result<Status, StoreError> {
    let state = with_client(store.pool()?, read_freeze)?;
    Ok(Status {
        posting_enabled: !state.frozen,
        frozen_reason: state.reason,
        frozen_by: state.actor,
    })
}

/// `freezeCause`: why the freeze is on, in the few words a reader of `/health` sorts by; none while posting runs.
pub fn freeze_cause(s: &Status) -> Option<&'static str> {
    if s.posting_enabled {
        return None;
    }
    if s.frozen_by.as_deref() == Some(RECONCILE_ACTOR) {
        return Some(
            if s.frozen_reason.as_deref() == Some(RECONCILE_UNPROVEN_REASON) {
                "unfinished_proofs"
            } else {
                "mismatch"
            },
        );
    }
    if s.frozen_by
        .as_deref()
        .is_some_and(|a| a.starts_with("env:"))
    {
        return Some("startup_setting");
    }
    Some("person")
}

/// `readLastVerified(sql)`'s `at` and `seq`: the latest `ok` reconciliation run, or none on file.
pub fn last_verified(store: &Store) -> Result<Option<(String, String)>, StoreError> {
    with_client(store.pool()?, |c| {
        let rows = c.query(
            "SELECT to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), through_seq::text
               FROM ledger.reconcile_runs
              WHERE outcome = 'ok'
              ORDER BY reconcile_runs.through_seq DESC, id DESC
              LIMIT 1",
            &[],
        )?;
        rows.first()
            .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
            .transpose()
    })
}

/// Fastify's answer to a handler that threw: 500 with `{ statusCode, code?, error, message }`.
pub fn internal_error(e: &StoreError) -> Response {
    let mut body = vec![("statusCode".to_owned(), Json::int(500))];
    if let Some(code) = &e.code {
        body.push(("code".to_owned(), Json::str(code.clone())));
    }
    body.push(("error".to_owned(), Json::str("Internal Server Error")));
    body.push(("message".to_owned(), Json::str(e.message.clone())));
    Response {
        status: 500,
        body: Json::Object(body).compact(),
    }
}

fn text(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// `GET /health`.
pub fn health(store: &Store, service_name: &str) -> Response {
    let s = match status(store) {
        Ok(s) => s,
        Err(e) => return internal_error(&e),
    };
    let (at, seq) = match last_verified(store) {
        Ok(Some((at, seq))) => (Json::str(at), Json::str(seq)),
        Ok(None) | Err(_) => (Json::Null, Json::Null),
    };
    let body = Json::Object(vec![
        ("ok".to_owned(), Json::Bool(true)),
        ("service".to_owned(), Json::str(service_name)),
        ("postingEnabled".to_owned(), Json::Bool(s.posting_enabled)),
        ("frozenReason".to_owned(), text(s.frozen_reason.as_deref())),
        ("frozenBy".to_owned(), text(s.frozen_by.as_deref())),
        ("frozenCause".to_owned(), text(freeze_cause(&s))),
        ("lastVerifiedAt".to_owned(), at),
        ("lastVerifiedSeq".to_owned(), seq),
    ]);
    Response {
        status: 200,
        body: body.compact(),
    }
}

/// `GET /ready`.
pub fn ready(store: &Store) -> Response {
    match status(store) {
        Err(e) => internal_error(&e),
        Ok(s) if !s.posting_enabled => Response {
            status: 503,
            body: Json::Object(vec![
                ("ready".to_owned(), Json::Bool(false)),
                ("reason".to_owned(), text(s.frozen_reason.as_deref())),
            ])
            .compact(),
        },
        Ok(_) => Response {
            status: 200,
            body: Json::Object(vec![("ready".to_owned(), Json::Bool(true))]).compact(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frozen(reason: &str, by: &str) -> Status {
        Status {
            posting_enabled: false,
            frozen_reason: Some(reason.to_owned()),
            frozen_by: Some(by.to_owned()),
        }
    }

    /// `status-http.test.ts`: each freeze svc-ledger makes sorts into its cause; none while posting is enabled.
    #[test]
    fn each_freeze_sorts_into_its_cause() {
        let open = Status {
            posting_enabled: true,
            frozen_reason: None,
            frozen_by: Some("op-1".to_owned()),
        };
        assert_eq!(freeze_cause(&open), None);
        assert_eq!(
            freeze_cause(&frozen("operator halt for USDT recon", "op-1")),
            Some("person")
        );
        assert_eq!(
            freeze_cause(&frozen("reconciliation mismatch", RECONCILE_ACTOR)),
            Some("mismatch")
        );
        assert_eq!(
            freeze_cause(&frozen(RECONCILE_UNPROVEN_REASON, RECONCILE_ACTOR)),
            Some("unfinished_proofs")
        );
        assert_eq!(
            freeze_cause(&frozen(
                "LEDGER_POSTING_ENABLED=false at startup",
                "env:LEDGER_POSTING_ENABLED"
            )),
            Some("startup_setting")
        );
    }

    #[test]
    fn a_store_that_cannot_answer_is_fastifys_500_on_both_doors() {
        let down = Store::Down("replay stub: sql".to_owned());
        let want =
            r#"{"statusCode":500,"error":"Internal Server Error","message":"replay stub: sql"}"#;
        assert_eq!(health(&down, "svc-ledger").body, want);
        assert_eq!(ready(&down).body, want);
        assert_eq!(ready(&down).status, 500);
    }
}
