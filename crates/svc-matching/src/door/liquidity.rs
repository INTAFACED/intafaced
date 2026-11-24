//! The `liquidity` slice's door, past the caller and input checks (`router.ts`): `POST /markets/:marketId/mass-quote`.
//! The schema and the proof's market and action were checked before this; here the checked body becomes the engine's
//! quote set, and the engine's answer is written as `presentMassQuote` writes it.

use service_kit::money::parse_amount;
use service_kit::schema::Value;

use super::book::{amount, failed, is_true, nullish_amount, ok, proof, text};
use super::{Outcome, Route};
use crate::book::types::{EngineOrder, MmpIntent, OrderType, Side, Tif};
use crate::engine::MatchingEngine;
use crate::engine::liquidity::MassQuote;
use crate::errors;

const MAGNITUDES: [&str; 5] = [
    "mmpMaxQuote",
    "mmpMaxPosition",
    "mmpMaxLoss",
    "mmpMaxDelta",
    "mmpMaxVega",
];

/// `readMmpMagnitude`: absent or null is none; blank is present; anything else is parsed, and a failed parse throws.
fn magnitude_present(v: &Value) -> Result<bool, String> {
    match v {
        Value::Undefined | Value::Null => Ok(false),
        Value::String(s) if s.is_empty() => Ok(true),
        _ => amount(v).map(|_| true),
    }
}

/// `mmpOrderFields`: a flag on the set or the side; each magnitude from the side when the side names it (even as
/// null), else from the set.
fn mmp_of(set: &Value, side: &Value) -> Result<MmpIntent, String> {
    let either = |k: &str| is_true(set.get(k)) || is_true(side.get(k));
    let mut magnitude = false;
    for k in MAGNITUDES {
        let v = match side.get(k) {
            Value::Undefined => set.get(k),
            v => v,
        };
        magnitude |= magnitude_present(v)?;
    }
    Ok(MmpIntent {
        flag: either("mmp"),
        magnitude,
        vendor: either("mmpVendor"),
        sidecar: either("sidecar"),
    })
}

/// `toQuoteSideOrder`: the set's account, the side's terms, no stop, and the time in force as sent.
fn side_order(set: &Value, side: Side, body: &Value) -> Result<EngineOrder, String> {
    let mut order = EngineOrder::new(
        text(body.get("orderId")),
        text(set.get("accountId")),
        OrderType::parse(&text(body.get("type"))).ok_or("type")?,
        side,
        parse_amount(body.get("qty").as_str().unwrap_or(""))?,
        nullish_amount(body.get("price"))?,
        Tif::parse(&text(body.get("tif"))).ok_or("tif")?,
    );
    order.mmp = mmp_of(set, body)?;
    Ok(order)
}

/// `parsed.data.bid ? toQuoteSideOrder(...) : null`.
fn quote_side(set: &Value, key: &str, side: Side) -> Result<Option<EngineOrder>, String> {
    match set.get(key) {
        Value::Undefined | Value::Null => Ok(None),
        body => side_order(set, side, body).map(Some),
    }
}

/// The slice's door, its caller and input already let in.
pub fn serve(
    route: &Route,
    param: &dyn Fn(&str) -> String,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    match (route.method, route.path) {
        ("POST", "/markets/:marketId/mass-quote") => {
            let sides = quote_side(body, "bid", Side::Buy)
                .and_then(|bid| quote_side(body, "ask", Side::Sell).map(|ask| (bid, ask)));
            let (bid, ask) = match sides {
                Ok(s) => s,
                Err(e) => return Outcome::Answer(errors::thrown(&e)),
            };
            let cmd = MassQuote {
                set_id: text(body.get("setId")),
                market_id: param("marketId"),
                account_id: text(body.get("accountId")),
                one_sided: is_true(body.get("oneSided")),
                bid,
                ask,
                lifecycle_proof: proof(body),
            };
            match engine.mass_quote(&cmd) {
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        _ => Outcome::Owed(route.slice),
    }
}
