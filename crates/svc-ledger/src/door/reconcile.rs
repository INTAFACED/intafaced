//! The `reconcile` slice's operator door (`operator-http.ts`): `POST /operator/reconcile`, past `guarded`'s token and
//! `admin:treasury` check and `reconcileSchema`. It spends an identity approval bound to the freeze row's version, then
//! runs the same snapshot proof as the hourly job. `guarded`'s catch:
//! - a refused approval: 400 with its message and code;
//! - `ledger.reconcile_in_progress` (another run holds the lock): 409, nothing ran;
//! - `ledger.reconcile_incomplete` (no verdict): 503, the book neither frozen nor verified;
//! - anything else: 400 `ledger.operator_request_failed` with the thrown message.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::LedgerDoor;
use crate::approval::{Refused, consume_ledger_approval};
use crate::db::{StoreError, with_client};
use crate::errors;
use crate::reconcile::{RECONCILE_IN_PROGRESS, RECONCILE_INCOMPLETE};
use crate::reconciler::Reconciler;
use crate::status::read_freeze;

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    match input.get(key) {
        Value::String(s) => s,
        _ => "",
    }
}

fn respond(status: u16, body: &Json) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

fn store_failed(e: &StoreError) -> Response {
    let (status, body) = match e.code.as_deref() {
        Some(code @ RECONCILE_IN_PROGRESS) => errors::operator_coded(409, &e.message, code),
        Some(code @ RECONCILE_INCOMPLETE) => errors::operator_coded(503, &e.message, code),
        _ => errors::operator_failed(&e.message),
    };
    respond(status, &body)
}

impl LedgerDoor {
    /// The ledger's reconciliation, on the door's book, bus and settings: the operator door's and the timer's.
    pub fn reconciler(&self) -> Reconciler<'_> {
        Reconciler {
            store: &self.cfg.store,
            relay: self.relay(),
            custody: self.cfg.custody,
            statement_timeout_ms: self.cfg.reconcile_statement_timeout_ms,
            now_ms: self.cfg.now_ms,
        }
    }

    /// `POST /operator/reconcile`, past its guard and its first input check.
    pub(super) fn reconcile_door(&self, operator: &Principal, input: &Value) -> Response {
        let prior = match self
            .cfg
            .store
            .pool()
            .and_then(|p| with_client(p, read_freeze))
        {
            Ok(s) => s,
            Err(e) => return store_failed(&e),
        };
        let consumed = match consume_ledger_approval(
            &*self.cfg.approvals,
            (text(input, "approvalId"), text(input, "operationId")),
            "ledger.reconcile",
            "posting_reconcile",
            &prior.changed_at_precise,
            &[],
            None,
        ) {
            Ok(c) => c,
            Err(Refused::Coded { message, code }) => {
                return respond(400, &errors::operator_coded(400, &message, &code).1);
            }
            Err(Refused::Thrown(message)) => {
                return respond(400, &errors::operator_failed(&message).1);
            }
        };
        let confirm = consumed.approver_id.unwrap_or(consumed.requester_id);
        self.cfg.log.info(
            vec![
                ("actor", Json::str(operator.user_id.clone())),
                ("confirmOperatorId", Json::str(confirm.clone())),
            ],
            "LEDGER RECONCILE requested by operator",
        );
        let report = match self.reconciler().reconcile() {
            Ok(r) => r,
            Err(e) => return store_failed(&e),
        };
        // `ReconcileSnapshot`: the length so far on a break, never an invented green zero.
        let mut snapshot = vec![
            ("ok".to_owned(), Json::Bool(report.ok)),
            (
                "accountsChecked".to_owned(),
                Json::int(report.balances.accounts_checked),
            ),
            ("chainLength".to_owned(), Json::int(report.chain.length())),
            (
                "unbalancedAssets".to_owned(),
                Json::Array(
                    report
                        .unbalanced_assets
                        .iter()
                        .map(|a| Json::str(a.clone()))
                        .collect(),
                ),
            ),
            ("result".to_owned(), Json::str(report.result.as_str())),
            (
                "customerBalancesOpen".to_owned(),
                report.open_customer_balances().map_or(Json::Null, |n| {
                    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
                }),
            ),
            (
                "ranAt".to_owned(),
                Json::str(Instant(report.ran_at_ms).iso()),
            ),
            ("confirmOperatorId".to_owned(), Json::str(confirm.clone())),
        ];
        if let Some(at) = report.chain.broken_at() {
            snapshot.push(("chainBrokenAt".to_owned(), Json::str(at)));
        }
        let snapshot = Json::Object(snapshot);
        if !report.ok {
            self.cfg.log.log(
                "fatal",
                vec![
                    ("actor", Json::str(operator.user_id.clone())),
                    ("confirmOperatorId", Json::str(confirm)),
                    ("report", snapshot.clone()),
                ],
                "LEDGER RECONCILIATION FAILED via operator request — posting frozen",
            );
        }
        respond(200, &snapshot)
    }
}
