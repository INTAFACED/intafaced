//! The `venue` slice's doors, past the caller and input checks (`router.ts`): the market and venue mode switches, each
//! spending one identity approval (`consumeVenueKill`), a dead session, and the surveillance reads and refusals.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::book::limit_of;
use super::{DoorConfig, Outcome, Route, Slice};
use crate::approval::{Denied, Spend, spend};
use crate::book::types::{Reject, reject_or_null};
use crate::engine::venue::{Switch, SwitchCmd};
use crate::engine::{EngineError, MatchingEngine};
use crate::errors;

fn ok(body: Json) -> Outcome {
    Outcome::Answer(Response {
        status: 200,
        body: body.compact(),
    })
}

fn failed(e: &EngineError) -> Outcome {
    Outcome::Answer(errors::thrown(&e.to_string()))
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
    cfg: &DoorConfig,
    route: &Route,
    req: &Request<'_>,
    param: &dyn Fn(&str) -> String,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    if let Some((switch, action_type, verb)) = switch_of(route) {
        return switch_door(
            cfg,
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
    cfg: &DoorConfig,
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
    let text = |k: &str| body.get(k).as_str();
    let spent = spend(
        cfg.approvals.as_ref(),
        &cfg.operator_ids,
        &Spend {
            operator_id: text("operatorId"),
            confirm_typed: text("confirmOperatorId"),
            approval_id: text("approvalId"),
            operation_id: text("operationId"),
            action_type,
            fields: &fields,
            target_id: &target_id,
        },
    );
    let spent = match spent {
        Ok(s) => s,
        Err(Denied::Bad { code, message }) => {
            return Outcome::Answer(errors::plain(400, &code, &message));
        }
        Err(Denied::Thrown(message)) => return Outcome::Answer(errors::thrown(&message)),
        Err(Denied::Refused {
            operator_id,
            confirm_operator_id,
            rejected,
        }) => {
            let state = engine.mode_state(switch, market_id);
            return ok(switch_body(
                switch,
                market_id,
                false,
                state,
                operator_id,
                confirm_operator_id,
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
