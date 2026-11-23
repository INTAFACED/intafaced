//! The `operator` slice's doors (`router.ts`), past the founder principal and `founderBody`'s checks: the founder's
//! read of the live book (`GET /operator/in-flight`, `operator-desk.ts`'s `matchingInFlightRead`) and the four
//! founder brakes (`founderMutate`): `POST /operator/halt`, `/resume`, `/halt-all` and `/resume-all`.
//!
//! A brake spends one two-person approval in the principal's name (`consumeVenueKill`, [`crate::approval::spend`]),
//! never a typed `operatorId`, and keeps its own idempotency keys: a key seen again with the same request answers the
//! first answer and spends nothing; with another request it answers 409. Only an answer the engine gave is kept: a
//! refused approval keeps nothing, so a retry may spend a fresh one.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};
use service_kit::server::Response;
use service_kit::time::Instant;

use super::venue::switch_body;
use super::{DoorConfig, Outcome, Route};
use crate::approval::{Denied, Spend, spend};
use crate::engine::MatchingEngine;
use crate::engine::venue::{Switch, SwitchCmd};
use crate::errors;

/// What a founder brake's key was first used for (`fingerprint`): the action, the market and the approval's ids.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    action_type: &'static str,
    market_id: String,
    approval_id: String,
    operation_id: String,
}

/// `founderIdem`: each idempotency key, trimmed, with the request it was first used for and the answer it got.
#[derive(Debug, Default)]
pub struct FounderKeys(Mutex<HashMap<String, (Fingerprint, Response)>>);

fn ok(body: Json) -> Response {
    Response {
        status: 200,
        body: body.compact(),
    }
}

/// One of the slice's doors, its founder principal (`user_id`) and input already let in.
pub fn serve(
    cfg: &DoorConfig,
    keys: &FounderKeys,
    route: &Route,
    user_id: &str,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    let (switch, action_type) = match route.path {
        "/operator/in-flight" => {
            return Outcome::Answer(ok(in_flight(engine, Instant((cfg.clock)()))));
        }
        "/operator/halt" => (Switch::Halt, "matching.halt"),
        "/operator/resume" => (Switch::Resume, "matching.resume"),
        "/operator/halt-all" => (Switch::HaltAll, "matching.halt_all"),
        "/operator/resume-all" => (Switch::ResumeAll, "matching.resume_all"),
        _ => return Outcome::Owed(route.slice),
    };
    Outcome::Answer(brake(cfg, keys, switch, action_type, user_id, body, engine))
}

/// `matchingInFlightRead(engine, asOf)`: the venue halt, the markets, the halted ones and the resting count. The
/// Rust engine always holds all three, so no `*Code` names an unreadable one.
fn in_flight(engine: &MatchingEngine, as_of: Instant) -> Json {
    let markets = engine.markets();
    let halted: Vec<Json> = markets
        .iter()
        .filter(|m| engine.flags(m).halted)
        .map(|m| Json::str(m.as_str()))
        .collect();
    let resting = i64::try_from(engine.resting_order_count()).unwrap_or(i64::MAX);
    Json::obj([
        ("asOf", Json::str(as_of.iso())),
        ("venueHalted", Json::Bool(engine.flags("").venue_halted)),
        ("venueHaltedCode", Json::Null),
        (
            "markets",
            Json::Array(markets.iter().map(|m| Json::str(m.as_str())).collect()),
        ),
        ("marketsCode", Json::Null),
        ("halted", Json::Array(halted)),
        ("restingOrders", Json::int(resting)),
        ("restingOrdersCode", Json::Null),
    ])
}

/// `founderMutate`: the key, then the approval in the principal's name, then the switch; the answer is kept under its
/// key.
fn brake(
    cfg: &DoorConfig,
    keys: &FounderKeys,
    switch: Switch,
    action_type: &'static str,
    user_id: &str,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Response {
    let text = |k: &str| body.get(k).as_str();
    // The door's input check has let in only a key of 8 to 200 characters after a trim.
    let key = js_trim(text("idempotencyKey").unwrap_or_default()).to_owned();
    let per_market = switch.per_market();
    let market_id = if per_market {
        text("marketId").unwrap_or_default().to_owned()
    } else {
        String::new()
    };
    let fingerprint = Fingerprint {
        action_type,
        // `parsed.data.marketId ?? ''`: the venue brakes fingerprint a market the body names, and ignore it.
        market_id: text("marketId").unwrap_or_default().to_owned(),
        approval_id: text("approvalId").unwrap_or_default().to_owned(),
        operation_id: text("operationId").unwrap_or_default().to_owned(),
    };
    let mut kept = keys.0.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((first, answer)) = kept.get(&key) {
        if *first != fingerprint {
            return errors::plain(
                409,
                "matching.idempotency_conflict",
                "This idempotency key was already used for a different request",
            );
        }
        return answer.clone();
    }
    let (fields, target_id): (Vec<(&str, &str)>, String) = if per_market {
        (
            vec![("marketId", market_id.as_str())],
            format!("{}:{market_id}", switch.kind()),
        )
    } else {
        (Vec::new(), switch.kind().to_owned())
    };
    let spent = spend(
        cfg.approvals.as_ref(),
        &cfg.operator_ids,
        &Spend {
            operator_id: Some(user_id),
            confirm_typed: None,
            approval_id: text("approvalId"),
            operation_id: text("operationId"),
            action_type,
            fields: &fields,
            target_id: &target_id,
        },
    );
    let spent = match spent {
        Ok(s) => s,
        Err(Denied::Bad { code, message }) => return errors::plain(400, &code, &message),
        Err(Denied::Thrown(message)) => return errors::thrown(&message),
        Err(Denied::Refused {
            operator_id,
            confirm_operator_id,
            rejected,
        }) => {
            let mut o: Vec<(String, Json)> = vec![("accepted".into(), Json::Bool(false))];
            if per_market {
                o.push(("marketId".into(), Json::str(market_id.as_str())));
            }
            o.push((
                "operatorId".into(),
                operator_id.map_or(Json::Null, Json::String),
            ));
            o.push((
                "confirmOperatorId".into(),
                confirm_operator_id.map_or(Json::Null, Json::String),
            ));
            o.push(("rejected".into(), rejected.to_json()));
            return ok(Json::Object(o));
        }
    };
    let cmd = SwitchCmd {
        operator_id: Some(spent.operator_id),
        confirm_operator_id: Some(spent.confirm_operator_id.clone()),
        evidence_refs: spent.evidence_refs,
        ..SwitchCmd::default()
    };
    let answer = match engine.switch(switch, &market_id, &cmd) {
        Ok(r) => ok(switch_body(
            switch,
            &market_id,
            r.accepted,
            r.state,
            r.operator_id,
            r.confirm_operator_id
                .flatten()
                .or(Some(spent.confirm_operator_id)),
            r.rejected.as_ref(),
        )),
        Err(e) => return errors::thrown(&e.to_string()),
    };
    kept.insert(key, (fingerprint, answer.clone()));
    answer
}
