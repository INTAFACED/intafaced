//! The `rulebook` slice's doors (`router.ts`), past the caller and input checks: the public reads of the published
//! rulebook, and the founder's check and publish of a new version. A publish spends one two-person approval, and only
//! after the draft has been read and checked: a draft that refuses spends nothing.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::{Outcome, Route};
use crate::approval::{self, Approvals, Denied, Spend};
use crate::book::types::Reject;
use crate::engine::{MatchingEngine, Precheck, RulebookPublish};
use crate::errors;
use crate::rulebook::{self, RULEBOOK_PUBLISH_ACTION};

fn ok(body: Json) -> Outcome {
    Outcome::Answer(Response {
        status: 200,
        body: body.compact(),
    })
}

fn refused(version: Option<&str>, rejected: &Reject) -> Outcome {
    let mut fields = vec![("accepted".to_owned(), Json::Bool(false))];
    if let Some(v) = version {
        fields.push(("version".to_owned(), Json::str(v)));
    }
    fields.push(("rejected".to_owned(), rejected.to_json()));
    ok(Json::Object(fields))
}

/// What the publish door needs beside the engine.
pub struct Publisher<'a> {
    /// The founder principal's user id: the operator asking.
    pub user_id: &'a str,
    pub approvals: &'a dyn Approvals,
    pub operator_ids: &'a [String],
}

/// One of the slice's doors, its caller and input already let in.
pub fn serve(
    route: &Route,
    body: &Value,
    publisher: &Publisher<'_>,
    engine: &mut MatchingEngine,
) -> Outcome {
    match (route.method, route.path) {
        ("GET", "/rulebook") => ok(engine.rulebook_view()),
        ("GET", "/rulebook/versions") => ok(engine.rulebook_history()),
        ("POST", "/operator/rulebook/check") => check(body, engine),
        ("POST", "/operator/rulebook/publish") => publish(body, publisher, engine),
        _ => Outcome::Owed(route.slice),
    }
}

/// `POST /operator/rulebook/check`: an accepted draft answers the exact approval target and payload hash the publish
/// recomputes, so the proposal binds this text.
fn check(body: &Value, engine: &MatchingEngine) -> Outcome {
    let draft = match rulebook::read_draft(body) {
        Ok(d) => d,
        Err(r) => return refused(None, &r),
    };
    match engine.rulebook_precheck(&draft) {
        Precheck::Same => refused(None, &rulebook::immutable_refuse(&draft.version)),
        Precheck::Refused(r) => refused(None, &r),
        Precheck::New => ok(Json::obj([
            ("accepted", Json::Bool(true)),
            ("version", Json::str(draft.version.clone())),
            (
                "effectiveAt",
                draft.effective_at.clone().map_or(Json::Null, Json::String),
            ),
            ("digest", Json::str(draft.digest.clone())),
            ("actionType", Json::str(RULEBOOK_PUBLISH_ACTION)),
            (
                "targetId",
                Json::str(rulebook::approval_target(&draft.version)),
            ),
            (
                "payloadHash",
                Json::str(approval::action_payload_hash(
                    RULEBOOK_PUBLISH_ACTION,
                    &rulebook::approval_fields(&draft),
                )),
            ),
            ("rejected", Json::Null),
        ])),
    }
}

/// `POST /operator/rulebook/publish`.
fn publish(body: &Value, p: &Publisher<'_>, engine: &mut MatchingEngine) -> Outcome {
    let draft = match rulebook::read_draft(body) {
        Ok(d) => d,
        Err(r) => {
            return ok(Json::obj([
                ("accepted", Json::Bool(false)),
                ("version", Json::Null),
                ("rejected", r.to_json()),
            ]));
        }
    };
    match engine.rulebook_precheck(&draft) {
        Precheck::Refused(r) => return refused(Some(&draft.version), &r),
        Precheck::Same => {
            return ok(Json::obj([
                ("accepted", Json::Bool(true)),
                ("version", Json::str(draft.version.clone())),
                ("alreadyPublished", Json::Bool(true)),
                ("published", engine.rulebook_history_of(&draft.version)),
                ("rejected", Json::Null),
            ]));
        }
        Precheck::New => {}
    }
    let target = rulebook::approval_target(&draft.version);
    let approval_id = body.get("approvalId").as_str();
    let authz = approval::spend(
        p.approvals,
        p.operator_ids,
        &Spend {
            operator_id: Some(p.user_id),
            confirm_typed: None,
            approval_id,
            operation_id: body.get("operationId").as_str(),
            action_type: RULEBOOK_PUBLISH_ACTION,
            fields: &rulebook::approval_fields(&draft),
            target_id: &target,
        },
    );
    let authz = match authz {
        Ok(a) => a,
        Err(Denied::Bad { code, message }) => {
            return Outcome::Answer(errors::plain(400, &code, &message));
        }
        Err(Denied::Thrown(message)) => return Outcome::Answer(errors::thrown(&message)),
        Err(Denied::Refused { rejected, .. }) => return refused(Some(&draft.version), &rejected),
    };
    let result = engine.publish_rulebook(
        &draft,
        &authz.operator_id,
        &authz.confirm_operator_id,
        approval_id.unwrap_or_default(),
    );
    match result {
        Err(e) => Outcome::Answer(errors::thrown(&e.to_string())),
        Ok(RulebookPublish::Refused(r)) => refused(Some(&draft.version), &r),
        Ok(RulebookPublish::Published { already }) => ok(Json::obj([
            ("accepted", Json::Bool(true)),
            ("version", Json::str(draft.version.clone())),
            ("alreadyPublished", Json::Bool(already)),
            ("published", engine.rulebook_history_of(&draft.version)),
            ("operatorId", Json::str(authz.operator_id.clone())),
            (
                "confirmOperatorId",
                Json::str(authz.confirm_operator_id.clone()),
            ),
            ("rejected", Json::Null),
        ])),
    }
}
