//! The `spreads` slice's doors, past the caller and input checks (`router.ts`, "Spreads"): the listings and a spread's
//! book are public reads; a listing spends a two-person approval bound to its exact definition; a spread order runs the
//! normal submit with the listing stamped on it.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::book::{
    amount, failed, flags_fields, ladder, limit_of, nullish_amount, ok, proof, text,
};
use super::{Outcome, Route};
use crate::approval::{self, Approvals as Consumer, Denied, Spend};
use crate::book::spread::{
    SpreadLegInput, SpreadListingInput, read_spread_listing, spread_identity,
};
use crate::book::types::{Reject, Side, Tif, reject_or_null, seq_json};
use crate::book::wire::spread_json;
use crate::engine::{MatchingEngine, SpreadOrderInput};
use crate::errors;

/// What the listing door spends its approval with: the venue's consumer and its operator list.
pub struct Approvals<'a> {
    pub consumer: &'a dyn Consumer,
    pub operator_ids: &'a [String],
}

fn opt_text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn text_or_null(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

fn amount_text(a: Option<service_kit::money::Amount>) -> Json {
    a.map_or(Json::Null, |a| {
        Json::str(service_kit::money::format_amount(a))
    })
}

/// `{ ...parsed.data, spreadId }` as `readSpreadListing` reads it.
fn listing_input(body: &Value, spread_id: &str) -> SpreadListingInput {
    SpreadListingInput {
        spread_id: Some(spread_id.to_owned()),
        kind: opt_text(body.get("kind")),
        legs: match body.get("legs") {
            Value::Array(legs) => Some(
                legs.iter()
                    .map(|l| SpreadLegInput {
                        symbol: opt_text(l.get("symbol")),
                        side: opt_text(l.get("side")),
                        ratio: opt_text(l.get("ratio")),
                    })
                    .collect(),
            ),
            _ => None,
        },
        tick: opt_text(body.get("tick")),
        lot: opt_text(body.get("lot")),
    }
}

fn list_refused(
    spread_id: &str,
    code: &str,
    message: &str,
    operator_id: Option<&str>,
    confirm_operator_id: Option<&str>,
) -> Outcome {
    ok(Json::obj([
        ("accepted", Json::Bool(false)),
        ("spreadId", Json::str(spread_id)),
        ("instrument", Json::Null),
        ("alreadyListed", Json::Bool(false)),
        ("operatorId", text_or_null(operator_id)),
        ("confirmOperatorId", text_or_null(confirm_operator_id)),
        ("rejected", Reject::new(code, message).to_json()),
    ]))
}

/// One of the slice's doors, its caller and input already let in.
pub fn serve(
    route: &Route,
    req: &Request<'_>,
    param: &dyn Fn(&str) -> String,
    body: &Value,
    engine: &mut MatchingEngine,
    approvals: &Approvals<'_>,
) -> Outcome {
    match (route.method, route.path) {
        ("GET", "/spreads") => ok(Json::obj([(
            "instruments",
            Json::Array(
                engine
                    .spread_instruments()
                    .into_iter()
                    .map(spread_json)
                    .collect(),
            ),
        )])),
        ("GET", "/spreads/:spreadId/book") => {
            let spread_id = param("spreadId");
            let Some(view) = engine.spread_book(&spread_id, limit_of(req)) else {
                return Outcome::Answer(errors::plain(
                    404,
                    "spread_unlisted",
                    &errors::user_copy("matching.spread_unlisted"),
                ));
            };
            let mut fields: Vec<(String, Json)> = vec![
                ("spreadId".into(), Json::str(spread_id.clone())),
                ("instrument".into(), spread_json(&view.instrument)),
                ("bids".into(), ladder(&view.bids)),
                ("asks".into(), ladder(&view.asks)),
                ("sequence".into(), seq_json(view.sequence)),
                ("bestBid".into(), amount_text(view.best_bid)),
                ("bestAsk".into(), amount_text(view.best_ask)),
                ("lastPrice".into(), amount_text(view.last_price)),
            ];
            fields.extend(flags_fields(engine.flags(&spread_id)));
            ok(Json::Object(fields))
        }
        ("POST", "/spreads/:spreadId/list") => list(param("spreadId"), body, engine, approvals),
        ("POST", "/spreads/:spreadId/orders") => {
            let spread_id = param("spreadId");
            let input = (|| -> Result<SpreadOrderInput, String> {
                Ok(SpreadOrderInput {
                    order_id: text(body.get("orderId")),
                    account_id: text(body.get("accountId")),
                    side: Side::parse(&text(body.get("side"))).ok_or("side")?,
                    qty: amount(body.get("qty"))?,
                    price: amount(body.get("price"))?,
                    tif: Tif::parse(&text(body.get("tif"))).ok_or("tif")?,
                    anchor_reference: nullish_amount(body.get("anchorReference"))?,
                    client_order_id: opt_text(body.get("clientOrderId")),
                    environment: opt_text(body.get("environment")),
                    session_id: opt_text(body.get("sessionId")),
                })
            })();
            let input = match input {
                Ok(i) => i,
                Err(e) => return Outcome::Answer(errors::thrown(&e)),
            };
            match engine.submit_spread(&spread_id, &input, proof(body).as_ref()) {
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        _ => Outcome::Answer(Response {
            status: 500,
            body: String::new(),
        }),
    }
}

/// `POST /spreads/:spreadId/list`: read the definition before the approval is spent, so a blank owner field refuses
/// and the approval stays unused; the approval binds the exact definition.
fn list(
    spread_id: String,
    body: &Value,
    engine: &mut MatchingEngine,
    approvals: &Approvals<'_>,
) -> Outcome {
    let typed_operator = body.get("operatorId").as_str();
    let typed_confirm = body.get("confirmOperatorId").as_str();
    let instrument = match read_spread_listing(&listing_input(body, &spread_id)) {
        Ok(i) => i,
        Err(r) => {
            return list_refused(
                &spread_id,
                &r.code,
                &r.message,
                typed_operator,
                typed_confirm,
            );
        }
    };
    let definition = spread_identity(&instrument);
    let target = format!("spread_list:{}", instrument.spread_id);
    let authz = approval::spend(
        approvals.consumer,
        approvals.operator_ids,
        &Spend {
            operator_id: typed_operator,
            confirm_typed: typed_confirm,
            approval_id: body.get("approvalId").as_str(),
            operation_id: body.get("operationId").as_str(),
            action_type: "matching.spread_list",
            fields: &[
                ("spreadId", instrument.spread_id.as_str()),
                ("definition", definition.as_str()),
            ],
            target_id: &target,
        },
    );
    let (operator, confirm) = match authz {
        Ok(a) => (a.operator_id, a.confirm_operator_id),
        Err(Denied::Bad { code, message }) => {
            return Outcome::Answer(errors::plain(400, &code, &message));
        }
        Err(Denied::Thrown(message)) => return Outcome::Answer(errors::thrown(&message)),
        Err(Denied::Refused {
            operator_id,
            confirm_operator_id,
            rejected,
        }) => {
            return list_refused(
                &spread_id,
                &rejected.code,
                &rejected.message,
                operator_id.as_deref(),
                confirm_operator_id.as_deref(),
            );
        }
    };
    let result = match engine.list_spread(
        &listing_input(body, &spread_id),
        Some(&operator),
        Some(&confirm),
    ) {
        Ok(r) => r,
        Err(e) => return failed(&e),
    };
    ok(Json::obj([
        ("accepted", Json::Bool(result.accepted)),
        ("spreadId", Json::str(result.spread_id)),
        (
            "instrument",
            result.instrument.as_ref().map_or(Json::Null, spread_json),
        ),
        ("alreadyListed", Json::Bool(result.already_listed)),
        ("operatorId", Json::str(operator)),
        ("confirmOperatorId", Json::str(confirm)),
        ("rejected", reject_or_null(result.rejected.as_ref())),
    ]))
}
