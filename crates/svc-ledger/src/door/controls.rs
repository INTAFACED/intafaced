//! The `controls` slice's operator doors (`operator-http.ts`), past `guarded`'s token and authority and each door's
//! input (`{}` when the body is absent): list (treasury or compliance), the runs of one control (the same), define,
//! update and run (treasury, with a second factor). `guarded`'s catch:
//! - a refused control (`ReconciliationControlError`): its own status (`controlHttpStatus`), its code as the message;
//! - a refused approval (`ActionApprovalConsumeError`): 400 with its message and code;
//! - anything else: 400 `ledger.operator_request_failed` with the thrown message.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::{LedgerDoor, Route};
use crate::approval::Refused;
use crate::controls::{self, Actor, ControlError};
use crate::errors;

fn respond((status, body): (u16, Json)) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

fn failed(e: &ControlError) -> Response {
    respond(match e {
        ControlError::Code(code) => errors::operator_coded(controls::http_status(code), code, code),
        ControlError::Approval(Refused::Coded { message, code }) => {
            errors::operator_coded(400, message, code)
        }
        ControlError::Approval(Refused::Thrown(_))
        | ControlError::Store(_)
        | ControlError::Thrown(_) => errors::operator_failed(&controls::message_of(e)),
    })
}

impl LedgerDoor {
    /// One control door past its guard and its input check.
    pub(super) fn controls_door(
        &self,
        route: &Route,
        operator: &Principal,
        input: &Value,
        request_id: &str,
    ) -> Response {
        let store = &self.cfg.store;
        let input = input.to_json().unwrap_or(Json::Null);
        let actor = Actor {
            actor_id: operator.user_id.clone(),
            request_id: Some(request_id.to_owned()).filter(|r| !r.is_empty()),
        };
        let answered = match (route.method, route.path) {
            ("GET", "/operator/reconciliation/controls") => controls::list(store),
            ("POST", "/operator/reconciliation/controls/runs") => {
                controls::list_runs(store, &input)
            }
            ("POST", "/operator/reconciliation/controls") => {
                controls::define(store, &actor, &input)
            }
            ("POST", "/operator/reconciliation/controls/update") => {
                controls::update(store, &actor, &input, &*self.cfg.approvals)
            }
            _ => controls::run(
                store,
                &*self.cfg.approvals,
                &actor,
                &input,
                &*self.cfg.reconciliation_sources,
                None,
            )
            .inspect(|run| {
                self.cfg.log.info(
                    vec![
                        ("actor", Json::str(operator.user_id.clone())),
                        (
                            "controlId",
                            run.get("controlId").cloned().unwrap_or(Json::Null),
                        ),
                        ("status", run.get("status").cloned().unwrap_or(Json::Null)),
                    ],
                    "LEDGER RECONCILIATION CONTROL run",
                );
            }),
        };
        match answered {
            Ok(body) => respond((200, body)),
            Err(e) => failed(&e),
        }
    }
}
