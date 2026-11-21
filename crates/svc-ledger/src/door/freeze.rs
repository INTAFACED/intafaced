//! The `freeze` slice's operator doors (`operator-http.ts`): `GET` and `POST /operator/freeze`, `POST
//! /operator/unfreeze` and `GET /operator/integrity/clock`. They run past `guarded`'s token and `admin:treasury`
//! check and the door's first input check; a failure here is `guarded`'s catch:
//! - a refused thaw (`DualControlError`) or approval (`ActionApprovalConsumeError`): 400 with its message and code;
//! - `ledger.freeze_attributed`: 409, the first reason stands;
//! - anything else: 400 `ledger.operator_request_failed` with the thrown message. A thrown freeze never looks like a
//!   succeeded one.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::LedgerDoor;
use crate::approval::{Refused, consume_ledger_approval};
use crate::clock::{self, SKEW_BOUND_UNSET, WRITES_BLOCKED_CLOCK_SKEW};
use crate::db::{StoreError, with_client};
use crate::errors;
use crate::freeze::{self, Command, FREEZE_ATTRIBUTED, FreezeRelay, MISSING_OPERATOR};
use crate::status::{FreezeState, read_freeze};

/// What `guarded` answers for a failure past the door.
fn failed(e: Failure) -> Response {
    let (status, body) = match e {
        Failure::Store(e) => match e.code.as_deref() {
            Some(FREEZE_ATTRIBUTED) => errors::operator_coded(409, &e.message, FREEZE_ATTRIBUTED),
            Some(MISSING_OPERATOR) => errors::operator_coded(400, &e.message, MISSING_OPERATOR),
            _ => errors::operator_failed(&e.message),
        },
        Failure::Approval(Refused::Coded { message, code }) => {
            errors::operator_coded(400, &message, &code)
        }
        Failure::Approval(Refused::Thrown(message)) => errors::operator_failed(&message),
    };
    Response {
        status,
        body: body.compact(),
    }
}

enum Failure {
    Store(StoreError),
    Approval(Refused),
}

impl From<StoreError> for Failure {
    fn from(e: StoreError) -> Failure {
        Failure::Store(e)
    }
}

impl From<Refused> for Failure {
    fn from(e: Refused) -> Failure {
        Failure::Approval(e)
    }
}

/// `shape(state)`: the switch as the console reads it; `version` is the row's own timestamp text the approvals bind to.
fn shape(s: &FreezeState) -> Vec<(String, Json)> {
    let mut o = vec![
        ("frozen".to_owned(), Json::Bool(s.frozen)),
        (
            "reason".to_owned(),
            s.reason.clone().map_or(Json::Null, Json::String),
        ),
        (
            "actor".to_owned(),
            s.actor.clone().map_or(Json::Null, Json::String),
        ),
        ("changedAt".to_owned(), Json::str(s.changed_at.clone())),
    ];
    if !s.changed_at_precise.is_empty() {
        o.push((
            "version".to_owned(),
            Json::str(s.changed_at_precise.clone()),
        ));
    }
    o
}

fn ok(status: u16, body: Json) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

/// A string field of the parsed input (the schema has already required it).
fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    match input.get(key) {
        Value::String(s) => s,
        _ => "",
    }
}

impl LedgerDoor {
    fn relay(&self) -> FreezeRelay<'_> {
        FreezeRelay {
            bus: &*self.cfg.bus,
            producer: self.cfg.service_name.clone(),
            now_ms: self.cfg.now_ms,
        }
    }

    fn freeze_state(&self) -> Result<FreezeState, StoreError> {
        with_client(self.cfg.store.pool()?, read_freeze)
    }

    /// One freeze door, past its guard and its first input check (`input` is what that check returned).
    pub(super) fn freeze_door(
        &self,
        method: &str,
        path: &str,
        operator: &Principal,
        input: &Value,
    ) -> Response {
        let out = match (method, path) {
            ("POST", "/operator/freeze") => self.freeze(operator, input),
            ("POST", "/operator/unfreeze") => self.unfreeze(operator, input),
            ("GET" | "HEAD", "/operator/integrity/clock") => self.clock(),
            _ => self
                .freeze_state()
                .map(|s| ok(200, Json::Object(shape(&s))))
                .map_err(Failure::from),
        };
        out.unwrap_or_else(failed)
    }

    /// `POST /operator/freeze`: the approval for this reason at the version read, then the switch under the caller's
    /// name. The confirming operator is the approval's approver (or its requester), never a typed-in name.
    fn freeze(&self, operator: &Principal, input: &Value) -> Result<Response, Failure> {
        let reason = text(input, "reason");
        let prior = self.freeze_state()?;
        let consumed = consume_ledger_approval(
            &*self.cfg.approvals,
            text(input, "approvalId"),
            text(input, "operationId"),
            "ledger.freeze",
            "posting_freeze",
            &prior.changed_at_precise,
            &[("reason", reason)],
        )?;
        let confirm = consumed.approver_id.unwrap_or(consumed.requester_id);
        self.cfg.log.warn(
            vec![
                ("actor", Json::str(operator.user_id.clone())),
                ("confirmOperatorId", Json::str(confirm.clone())),
                ("reason", Json::str(reason)),
            ],
            "LEDGER FREEZE requested by operator — all value movement will stop",
        );
        let state = freeze::switch(
            &self.cfg.store,
            &self.relay(),
            Command::Freeze {
                reason,
                actor: &operator.user_id,
            },
        )?;
        let mut body = shape(&state);
        body.push(("confirmOperatorId".to_owned(), Json::str(confirm)));
        Ok(ok(200, Json::Object(body)))
    }

    /// `POST /operator/unfreeze`: a founder pair's approval at the version read, then the thaw naming the caller and
    /// the approval's other person. One actor string leaves the freeze where it is.
    fn unfreeze(&self, operator: &Principal, input: &Value) -> Result<Response, Failure> {
        let prior = self.freeze_state()?;
        let consumed = consume_ledger_approval(
            &*self.cfg.approvals,
            text(input, "approvalId"),
            text(input, "operationId"),
            "ledger.unfreeze",
            "posting_unfreeze",
            &prior.changed_at_precise,
            &[],
        )?;
        let confirm = consumed.approver_id.unwrap_or(consumed.requester_id);
        self.cfg.log.warn(
            vec![
                ("actor", Json::str(operator.user_id.clone())),
                ("confirmOperatorId", Json::str(confirm.clone())),
            ],
            "LEDGER THAW requested by operator — value movement resumes",
        );
        let state = freeze::switch(
            &self.cfg.store,
            &self.relay(),
            Command::Thaw {
                actor: &operator.user_id,
                confirm_operator_id: Some(&confirm),
            },
        )?;
        let mut body = shape(&state);
        body.push(("confirmOperatorId".to_owned(), Json::str(confirm)));
        Ok(ok(200, Json::Object(body)))
    }

    /// `GET /operator/integrity/clock`: 412 without a bound, 503 past it, 200 within it.
    fn clock(&self) -> Result<Response, Failure> {
        let view = clock::clock_skew(
            &self.cfg.store,
            self.cfg.clock_skew_bound_ms,
            self.cfg.now_ms,
        )?;
        let status = match view.code {
            Some(SKEW_BOUND_UNSET) => 412,
            Some(WRITES_BLOCKED_CLOCK_SKEW) => 503,
            _ => 200,
        };
        Ok(ok(status, view.json()))
    }
}
