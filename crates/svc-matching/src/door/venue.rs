//! The `venue` slice's doors, past the caller and input checks (`router.ts`): the market and venue mode switches, each
//! spending one identity approval (`consumeVenueKill`), a dead session, and the surveillance reads and refusals.

use std::collections::HashSet;

use service_kit::approvals::{ConsumeInput, founder_verdict, payload_hash};
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::book::limit_of;
use super::{Outcome, Route, Slice};
use crate::approval::{
    Approvals, MISSING, NOT_FOUNDERS, NOT_OPERATOR, OPERATOR_MISMATCH, OPERATORS_UNSET, Refused,
    TARGET_SERVICE, WRONG_ACTION, same_user,
};
use crate::book::types::{Reject, reject_or_null};
use crate::engine::venue::{Switch, SwitchCmd, operator_refuse, read_operator_id};
use crate::engine::{EngineError, MatchingEngine};
use crate::errors;

/// What the venue doors are put together from: who consumes an approval, and who is an operator of this venue.
pub struct VenueConfig {
    /// `IDENTITY_URL`'s consumer, or [`crate::approval::Unwired`] without it.
    pub approvals: Box<dyn Approvals>,
    /// `MATCHING_OPERATOR_IDS`, as [`crate::approval::parse_operator_ids`] reads it.
    pub operator_ids: HashSet<String>,
}

fn ok(body: Json) -> Outcome {
    Outcome::Answer(Response {
        status: 200,
        body: body.compact(),
    })
}

fn failed(e: &EngineError) -> Outcome {
    Outcome::Answer(errors::thrown(&e.to_string()))
}

/// The door's own answer to an approval that was not spent.
enum NotSpent {
    /// No operator named: a 200 the engine's way, and nothing consumed.
    Operator {
        operator_id: Option<String>,
        confirm: Option<String>,
        rejected: Reject,
    },
    /// 400 with a code and its message, or what the client threw.
    Refused(Refused),
}

/// Who the approval names, and the evidence it is.
struct Spent {
    operator_id: String,
    confirm_operator_id: String,
    evidence_refs: Vec<String>,
}

fn optional_text(v: &Value) -> Option<&str> {
    v.as_str()
}

impl VenueConfig {
    fn is_operator(&self, user: &str) -> bool {
        self.operator_ids
            .contains(&service_kit::schema::js_trim(user).to_lowercase())
    }

    /// `consumeVenueKill`: the operator, the approval's ids, the operator list, one consume bound to this action and
    /// target, the two people identity recorded, and the founder attestation where the action needs one.
    fn consume_venue_kill(
        &self,
        body: &Value,
        action_type: &str,
        fields: &[(&str, &str)],
        target_id: &str,
    ) -> Result<Spent, NotSpent> {
        let operator = read_operator_id(optional_text(body.get("operatorId")));
        let confirm_typed = read_operator_id(optional_text(body.get("confirmOperatorId")));
        let Some(operator) = operator else {
            return Err(NotSpent::Operator {
                operator_id: None,
                confirm: confirm_typed,
                rejected: operator_refuse(None)
                    .unwrap_or_else(|| Reject::new("missing_operator", "")),
            });
        };
        let refuse =
            |code: &str, message: &str| Err(NotSpent::Refused(Refused::coded(code, message)));
        let id = |k: &str| {
            optional_text(body.get(k))
                .map(service_kit::schema::js_trim)
                .unwrap_or("")
                .to_owned()
        };
        let (approval_id, operation_id) = (id("approvalId"), id("operationId"));
        if approval_id.is_empty() || operation_id.is_empty() {
            return refuse(
                MISSING,
                "approvalId and operationId are required; a typed-in second name is not approval",
            );
        }
        if self.operator_ids.is_empty() {
            return refuse(
                OPERATORS_UNSET,
                "MATCHING_OPERATOR_IDS is unpublished; matching does not guess who is an operator",
            );
        }
        if !self.is_operator(&operator) {
            return refuse(
                NOT_OPERATOR,
                "the requester is not an operator of this venue",
            );
        }
        let hash = payload_hash(action_type, fields);
        let consumed = self
            .approvals
            .consume(&ConsumeInput {
                approval_id: &approval_id,
                operation_id: &operation_id,
                payload_hash: &hash,
                target_service: TARGET_SERVICE,
                target_id,
                expected_version: "1",
                replay: None,
            })
            .map_err(NotSpent::Refused)?;
        if consumed.action_type != action_type
            || consumed.target_service != TARGET_SERVICE
            || consumed.target_id != target_id
            || consumed.status != "CONSUMED"
        {
            return refuse(
                WRONG_ACTION,
                &format!("the approval is not for {action_type} on {target_id}"),
            );
        }
        if !same_user(&consumed.requester_id, &operator) {
            return refuse(
                OPERATOR_MISMATCH,
                "operatorId is not the person who proposed this approval",
            );
        }
        let approver = match &consumed.approver_id {
            Some(a) if !same_user(a, &consumed.requester_id) => a.clone(),
            _ => return refuse(MISSING, "the approval has no distinct approver"),
        };
        if !self.is_operator(&consumed.requester_id) || !self.is_operator(&approver) {
            return refuse(
                NOT_OPERATOR,
                "both the proposer and the approver must be operators of this venue",
            );
        }
        if let Some(reason) = founder_verdict(&consumed, action_type, TARGET_SERVICE, target_id) {
            return refuse(
                NOT_FOUNDERS,
                if reason == "missing" {
                    "a founder-audience action needs identity to attest that the proposer and the approver are both founders"
                } else {
                    "the founder attestation does not match a distinct founder pair for this action"
                },
            );
        }
        Ok(Spent {
            operator_id: consumed.requester_id.clone(),
            confirm_operator_id: approver,
            evidence_refs: vec![format!("action-approval:{approval_id}")],
        })
    }
}

/// A door's switch, its approval's action type and its target's verb.
fn switch_of(route: &Route) -> Option<(Switch, &'static str, &'static str)> {
    Some(match route.path {
        "/markets/:marketId/halt" => (Switch::Halt, "matching.halt", "halt"),
        "/markets/:marketId/resume" => (Switch::Resume, "matching.resume", "resume"),
        "/halt-all" => (Switch::HaltAll, "matching.halt_all", "halt_all"),
        "/resume-all" => (Switch::ResumeAll, "matching.resume_all", "resume_all"),
        "/markets/:marketId/reduce-only" => {
            (Switch::ReduceOnly, "matching.reduce_only", "reduce_only")
        }
        "/markets/:marketId/reduce-only/resume" => (
            Switch::ResumeReduceOnly,
            "matching.reduce_only_resume",
            "reduce_only_resume",
        ),
        "/markets/:marketId/post-only" => (Switch::PostOnly, "matching.post_only", "post_only"),
        "/markets/:marketId/post-only/resume" => (
            Switch::ResumePostOnly,
            "matching.post_only_resume",
            "post_only_resume",
        ),
        "/markets/:marketId/prelaunch" => (Switch::Prelaunch, "matching.prelaunch", "prelaunch"),
        "/markets/:marketId/open" => (Switch::Open, "matching.open", "open"),
        "/markets/:marketId/expire" => (Switch::Expire, "matching.expire", "expire"),
        "/markets/:marketId/delist" => (Switch::Delist, "matching.delist", "delist"),
        _ => return None,
    })
}

/// The answer's body: `accepted`, the market on a market's door, its mode, the two operators, and the refusal.
fn switch_body(
    switch: Switch,
    market_id: &str,
    accepted: bool,
    state: bool,
    operator_id: Option<String>,
    confirm: Option<String>,
    rejected: Option<&Reject>,
) -> Json {
    let mut o: Vec<(String, Json)> = vec![("accepted".into(), Json::Bool(accepted))];
    if switch.per_market() {
        o.push(("marketId".into(), Json::str(market_id)));
    }
    o.push((switch.field().into(), Json::Bool(state)));
    o.push((
        "operatorId".into(),
        operator_id.map_or(Json::Null, Json::String),
    ));
    o.push((
        "confirmOperatorId".into(),
        confirm.map_or(Json::Null, Json::String),
    ));
    o.push(("rejected".into(), reject_or_null(rejected)));
    Json::Object(o)
}

/// One of the slice's doors, its caller and input already let in.
pub fn serve(
    venue: &VenueConfig,
    route: &Route,
    req: &Request<'_>,
    param: &dyn Fn(&str) -> String,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    if let Some((switch, action_type, verb)) = switch_of(route) {
        return switch_door(
            venue,
            switch,
            action_type,
            verb,
            &param("marketId"),
            body,
            engine,
        );
    }
    match route.path {
        "/session/dead" => {
            let session = body.get("sessionId").as_str();
            match engine.session_dead(session) {
                Ok(r) => ok(Json::obj([
                    ("accepted", Json::Bool(r.accepted)),
                    ("sessionId", r.session_id.map_or(Json::Null, Json::String)),
                    (
                        "cancellations",
                        Json::Array(r.cancellations.iter().map(|c| c.to_json()).collect()),
                    ),
                    ("rejected", reject_or_null(r.rejected.as_ref())),
                ])),
                Err(e) => failed(&e),
            }
        }
        "/surveillance/cases" => {
            let cases = engine.open_surveillance_cases();
            ok(Json::obj([
                (
                    "cases",
                    Json::Array(
                        cases
                            .iter()
                            .take(limit_of(req))
                            .map(|c| c.to_json())
                            .collect(),
                    ),
                ),
                (
                    "detectors",
                    Json::obj([
                        ("spoofing", detector_gap("spoofing")),
                        ("layering", detector_gap("layering")),
                    ]),
                ),
            ]))
        }
        "/surveillance/adjudicate" => ok(Json::obj([
            ("ok", Json::Bool(false)),
            ("code", Json::str("auto_adjudicate_forbidden")),
            (
                "message",
                Json::str("auto-adjudicate is forbidden; named reasons stay open as evidence"),
            ),
            (
                "cases",
                Json::Array(
                    engine
                        .open_surveillance_cases()
                        .iter()
                        .map(|c| c.to_json())
                        .collect(),
                ),
            ),
        ])),
        "/surveillance/fine" => ok(Json::obj([
            ("ok", Json::Bool(false)),
            ("code", Json::str("invented_sanction")),
            (
                "message",
                Json::str(
                    "a fine is an invented sanction; a case is evidence, not a money movement",
                ),
            ),
            ("amount", Json::Null),
        ])),
        _ => Outcome::Owed(Slice::Venue),
    }
}

/// `detectorGap(reason)`: no owner threshold is published, so the detector is off; never a threshold of 0.
fn detector_gap(reason: &str) -> Json {
    Json::obj([
        ("enabled", Json::Bool(false)),
        ("gap", Json::str("detector_gap")),
        ("reason", Json::str(reason)),
        ("threshold", Json::Null),
    ])
}

fn switch_door(
    venue: &VenueConfig,
    switch: Switch,
    action_type: &str,
    verb: &str,
    market_id: &str,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    let (fields, target_id): (Vec<(&str, &str)>, String) = if switch.per_market() {
        (vec![("marketId", market_id)], format!("{verb}:{market_id}"))
    } else {
        (Vec::new(), verb.to_owned())
    };
    let spent = match venue.consume_venue_kill(body, action_type, &fields, &target_id) {
        Ok(s) => s,
        Err(NotSpent::Refused(Refused::Coded { message, code })) => {
            return Outcome::Answer(errors::plain(400, &code, &message));
        }
        Err(NotSpent::Refused(Refused::Thrown(message))) => {
            return Outcome::Answer(errors::thrown(&message));
        }
        Err(NotSpent::Operator {
            operator_id,
            confirm,
            rejected,
        }) => {
            let state = engine.mode_state(switch, market_id);
            return ok(switch_body(
                switch,
                market_id,
                false,
                state,
                operator_id,
                confirm,
                Some(&rejected),
            ));
        }
    };
    // `emergencyCmd(authz)` hands the halts and the expiry the approval as their evidence; the other doors hand the
    // two operators alone, and a delisting names no owner policy.
    let evidence = matches!(
        switch,
        Switch::Halt | Switch::Resume | Switch::HaltAll | Switch::ResumeAll | Switch::Expire
    );
    let cmd = SwitchCmd {
        operator_id: Some(spent.operator_id),
        confirm_operator_id: Some(spent.confirm_operator_id.clone()),
        evidence_refs: if evidence {
            spent.evidence_refs
        } else {
            Vec::new()
        },
        ..SwitchCmd::default()
    };
    match engine.switch(switch, market_id, &cmd) {
        Ok(r) => ok(switch_body(
            switch,
            market_id,
            r.accepted,
            r.state,
            r.operator_id,
            // `result.confirmOperatorId ?? authz.confirmOperatorId`.
            r.confirm_operator_id
                .flatten()
                .or(Some(spent.confirm_operator_id)),
            r.rejected.as_ref(),
        )),
        Err(e) => failed(&e),
    }
}
