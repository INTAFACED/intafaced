//! The `desk` slice's operator doors (`operator-http.ts`), past `guarded`'s token and authority and, for the reads,
//! the lookup's first input check:
//! - the reads (`lookup`): one transaction, a business key's trace, the transaction list, the address search, the
//!   book's counts and an account's metadata. A lookup whose access row cannot be written is 503
//!   `ledger.lookup_unrecorded`; an unknown transaction or account is 404; a book that answers what it cannot account
//!   for is 500; any other failure after the row is 503 `ledger.lookup_unavailable` with a fixed message, never the
//!   driver's text;
//! - the metadata writes (`metadataWrite`): each refusal of `operator-account-metadata.ts` answers its own status;
//!   anything else is `guarded`'s catch (an approval refusal 400 with its code, the rest 400
//!   `ledger.operator_request_failed` with the thrown message).

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::{Body, LedgerDoor, Route};
use crate::approval::Refused;
use crate::db::StoreError;
use crate::desk::{
    self, ACCOUNT_METADATA_APPROVAL_SPENT, ACCOUNT_METADATA_INVALID, ACCOUNT_METADATA_KEY_ABSENT,
    ACCOUNT_METADATA_STALE, ACCOUNT_NOT_FOUND, Actor, BOOKING_RECORD_MISSING, DeleteError, FROZEN,
    LOOKUP_UNRECORDED, ReadError, TRACE_INCONSISTENT, TX_NOT_FOUND,
};
use crate::errors;

/// `LOOKUP_UNAVAILABLE`.
const LOOKUP_UNAVAILABLE: &str = "ledger.lookup_unavailable";

fn respond((status, body): (u16, Json)) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

/// `METADATA_STATUS`: the HTTP status of each account-metadata refusal. Nothing changed in any of them.
fn metadata_status(code: &str) -> Option<u16> {
    match code {
        ACCOUNT_METADATA_INVALID => Some(400),
        ACCOUNT_NOT_FOUND | ACCOUNT_METADATA_KEY_ABSENT => Some(404),
        ACCOUNT_METADATA_STALE | ACCOUNT_METADATA_APPROVAL_SPENT => Some(409),
        FROZEN => Some(412),
        _ => None,
    }
}

/// A string field of the parsed input (the schema has already required it).
fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or_default()
}

impl LedgerDoor {
    /// One desk door, past its guard (and, for a read, its first input check: `input` is what it returned).
    pub(super) fn desk_door(
        &self,
        route: &Route,
        operator: &Principal,
        input: &Value,
        body: &Body,
        params: &[(&str, String)],
        request_id: &str,
    ) -> Response {
        let actor = Actor {
            actor_id: &operator.user_id,
            request_id: Some(request_id),
        };
        let account = || {
            params
                .iter()
                .find(|(n, _)| *n == "accountId")
                .map_or("", |(_, v)| v.as_str())
        };
        let store = &self.cfg.store;
        let read = match route.path {
            "/operator/transactions/:txId" => {
                desk::operator_tx_get(store, actor, text(input, "txId"))
            }
            "/operator/trace" => desk::operator_trace(store, actor, text(input, "businessKey")),
            "/operator/transactions" => desk::operator_tx_list(store, actor, input),
            "/operator/accounts" => desk::operator_account_search(store, actor, input),
            "/operator/stats" => desk::read_stats(store).map_err(ReadError::Read),
            "/operator/accounts/:accountId/metadata" => {
                desk::operator_metadata_read(store, actor, text(input, "accountId"))
            }
            path => {
                let body = match body {
                    Body::Parsed(j) => Some(j),
                    Body::Absent => None,
                };
                return self.metadata_write(path, operator, desk::body_for(body, account()));
            }
        };
        match read {
            Ok(answer) => respond((200, answer)),
            Err(e) => self.lookup_failed(operator, e),
        }
    }

    /// `lookup`'s catch.
    fn lookup_failed(&self, operator: &Principal, e: ReadError) -> Response {
        let actor = || vec![("actor", Json::str(operator.user_id.clone()))];
        let e = match e {
            ReadError::Unrecorded(_) => {
                self.cfg
                    .log
                    .error(actor(), "operator lookup refused: access row not written");
                return respond(errors::operator_coded(
                    503,
                    "The lookup could not be recorded, so it was not read.",
                    LOOKUP_UNRECORDED,
                ));
            }
            ReadError::Read(e) => e,
        };
        match e.code.as_deref() {
            Some(TX_NOT_FOUND) => respond(errors::operator_coded(
                404,
                "No transaction has that id.",
                TX_NOT_FOUND,
            )),
            Some(ACCOUNT_NOT_FOUND) => respond(errors::operator_coded(
                404,
                "No ledger account has that id.",
                ACCOUNT_NOT_FOUND,
            )),
            Some(code @ (TRACE_INCONSISTENT | BOOKING_RECORD_MISSING)) => {
                // The book's own integrity, not the operator's request: a server fault.
                self.cfg.log.error(
                    actor(),
                    "operator lookup: the book answered a transaction it cannot account for",
                );
                let message = if code == TRACE_INCONSISTENT {
                    "The book answered a transaction booked under another key."
                } else {
                    "The book answered a transaction with no row in its log."
                };
                respond(errors::operator_coded(500, message, code))
            }
            _ => {
                self.cfg
                    .log
                    .error(actor(), "operator lookup failed after it was recorded");
                respond(errors::operator_coded(
                    503,
                    "The ledger could not answer this lookup. Try again.",
                    LOOKUP_UNAVAILABLE,
                ))
            }
        }
    }

    /// `POST /operator/accounts/:accountId/metadata/set` and `/delete`, through `metadataWrite`.
    fn metadata_write(&self, path: &str, operator: &Principal, input: Value) -> Response {
        let store = &self.cfg.store;
        let written = if path.ends_with("/delete") {
            desk::delete_account_metadata(store, &*self.cfg.approvals, &operator.user_id, input)
        } else {
            desk::set_account_metadata(store, &operator.user_id, input).map_err(DeleteError::Store)
        };
        match written {
            Ok(answer) => {
                let change = answer.get("change");
                let field = |k: &str| change.and_then(|c| c.get(k)).cloned().unwrap_or(Json::Null);
                let mut fields = vec![
                    ("actor", Json::str(operator.user_id.clone())),
                    (
                        "accountId",
                        answer.get("accountId").cloned().unwrap_or(Json::Null),
                    ),
                    ("key", field("key")),
                ];
                let message = if path.ends_with("/delete") {
                    fields.push(("approver", field("approverId")));
                    "LEDGER ACCOUNT METADATA deleted"
                } else {
                    "LEDGER ACCOUNT METADATA set"
                };
                self.cfg.log.warn(fields, message);
                respond((200, answer))
            }
            Err(DeleteError::Store(StoreError { message, code, .. })) => {
                match code.as_deref().and_then(metadata_status) {
                    Some(status) => respond(errors::operator_coded(
                        status,
                        &message,
                        code.as_deref().unwrap_or_default(),
                    )),
                    None => respond(errors::operator_failed(&message)),
                }
            }
            Err(DeleteError::Approval(Refused::Coded { message, code })) => {
                respond(errors::operator_coded(400, &message, &code))
            }
            Err(DeleteError::Approval(Refused::Thrown(message))) => {
                respond(errors::operator_failed(&message))
            }
        }
    }
}
