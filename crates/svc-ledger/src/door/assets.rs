//! The `assets` slice's doors: the service reads `assetsList` and `assetsGet` (`s2s-http.ts`), past `authenticate`,
//! answered through `httpError`; and the operator doors `GET /operator/assets` and `POST /operator/assets/apply-edit`
//! (`operator-http.ts`), past `guarded`'s token and `admin:treasury` check, whose catch answers:
//! - a refused approval (`ActionApprovalConsumeError`): 400 with its message and code;
//! - `ledger.asset_edit_stale` and `ledger.asset_operation_conflict`: 409, nothing changed;
//! - the registry's refusals (`REGISTRY_REFUSALS`): 400 with the code;
//! - anything else: 400 `ledger.operator_request_failed` with the thrown message.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::LedgerDoor;
use crate::approval::Refused;
use crate::assets::{self, EDIT_STALE, OPERATION_CONFLICT, Refusal};
use crate::errors::{self, Failure, REGISTRY_REFUSALS};

fn reply((status, body): (u16, Json)) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

/// `httpError(err)` for a registry read.
fn service_failed(e: Refusal) -> Response {
    reply(errors::http_error(&match e {
        Refusal::Coded { code, message } => Failure::Ledger { code, message },
        Refusal::Zod(message) => Failure::Zod(message),
        // Only the operator write spends an approval; a database failure is the ledger's own fault.
        Refusal::Approval(_) | Refusal::Store(_) => Failure::Fault,
    }))
}

/// `guarded`'s catch for a registry door.
fn operator_failed(e: Refusal) -> Response {
    reply(match e {
        Refusal::Approval(Refused::Coded { message, code }) => {
            errors::operator_coded(400, &message, &code)
        }
        Refusal::Approval(Refused::Thrown(message)) | Refusal::Zod(message) => {
            errors::operator_failed(&message)
        }
        Refusal::Coded { code, message } => coded(&code, &message),
        Refusal::Store(e) => match e.code.as_deref() {
            Some(code) if code.starts_with("ledger.") => coded(code, &e.message),
            _ => errors::operator_failed(&e.message),
        },
    })
}

fn coded(code: &str, message: &str) -> (u16, Json) {
    if code == EDIT_STALE || code == OPERATION_CONFLICT {
        errors::operator_coded(409, message, code)
    } else if REGISTRY_REFUSALS.contains(&code) {
        errors::operator_coded(400, message, code)
    } else {
        errors::operator_failed(message)
    }
}

fn ok(body: Json) -> Response {
    reply((200, body))
}

impl LedgerDoor {
    /// A registry read past `authenticate`. `assetsList` reads `body ?? {}`; `assetsGet` reads the body as sent.
    pub(super) fn assets_service(&self, door: &str, body: Value) -> Response {
        let out = match door {
            "assetsList" => {
                let input = match body {
                    Value::Undefined | Value::Null => Value::Object(Vec::new()),
                    other => other,
                };
                assets::list(&self.cfg.store, input)
                    .map(|rows| Json::Object(vec![("assets".to_owned(), Json::Array(rows))]))
            }
            _ => assets::get(&self.cfg.store, body),
        };
        out.map_or_else(service_failed, ok)
    }

    /// A registry operator door past `guarded`'s check; `body` is the request's, as the handler receives it.
    pub(super) fn assets_operator(
        &self,
        path: &str,
        operator: &Principal,
        body: &Value,
    ) -> Response {
        if path == "/operator/assets" {
            return assets::operator_list(&self.cfg.store)
                .map(|rows| Json::Object(vec![("assets".to_owned(), Json::Array(rows))]))
                .map_err(Refusal::Store)
                .map_or_else(operator_failed, ok);
        }
        match assets::apply_edit(
            &self.cfg.store,
            &*self.cfg.approvals,
            &operator.user_id,
            body,
        ) {
            Ok(asset) => {
                self.cfg.log.warn(
                    vec![
                        ("actor", Json::str(operator.user_id.clone())),
                        ("assetId", asset.get("id").cloned().unwrap_or(Json::Null)),
                        (
                            "revision",
                            asset.get("revision").cloned().unwrap_or(Json::Null),
                        ),
                    ],
                    "LEDGER ASSET EDIT applied",
                );
                ok(asset)
            }
            Err(e) => operator_failed(e),
        }
    }
}
