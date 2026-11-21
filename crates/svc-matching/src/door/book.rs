//! The `book` slice's doors, past the caller and input checks (`router.ts`): each turns the checked input into the
//! engine's call and writes the engine's answer as the TypeScript writes it.
//!
//! The `triggers` slice's parts ride the same doors: a stop, a stop-limit, an OCO, a trailing stop and a dated expiry
//! are submits, and `POST /markets/:marketId/mark` walks the trailing stops. The `liquidity` slice's parts (an iceberg,
//! a peg, all-or-none, an auction) are submits too. An order that names a part only a later slice serves (an option or a
//! combo) is that slice's: the door owes it and the engine never sees it.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::{Outcome, Route, Slice, published_limit, query};
use crate::book::QueueLevel;
use crate::book::types::{CancelReason, EngineAmend, EngineOrder, Opt, OrderType, Side, Tif};
use crate::engine::reconcile::{CounterpartOrder, reconcile};
use crate::engine::{EngineError, Flags, MatchingEngine};
use crate::errors;

pub(super) fn ok(body: Json) -> Outcome {
    Outcome::Answer(Response {
        status: 200,
        body: body.compact(),
    })
}

fn not_found(code: &str, copy: &str) -> Outcome {
    Outcome::Answer(errors::plain(404, code, &errors::user_copy(copy)))
}

pub(super) fn failed(e: &EngineError) -> Outcome {
    Outcome::Answer(errors::thrown(&e.to_string()))
}

pub(super) fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_owned()
}

/// A checked decimal string (`parseAmount`); the schema has already refused anything else.
pub(super) fn amount(v: &Value) -> Result<Amount, String> {
    parse_amount(v.as_str().unwrap_or(""))
}

/// `value == null ? null : parseAmount(value)`.
pub(super) fn nullish_amount(v: &Value) -> Result<Option<Amount>, String> {
    match v {
        Value::Undefined | Value::Null => Ok(None),
        _ => amount(v).map(Some),
    }
}

/// `value !== undefined ? (value == null ? null : parseAmount(value)) : absent`.
fn opt_amount(v: &Value) -> Result<Opt<Amount>, String> {
    match v {
        Value::Undefined => Ok(Opt::Absent),
        Value::Null => Ok(Opt::Null),
        _ => amount(v).map(Opt::Some),
    }
}

pub(super) fn is_true(v: &Value) -> bool {
    matches!(v, Value::Bool(true))
}

/// The slice that owes a submit naming one of its parts, or none for an order this slice serves.
pub fn submit_owed_by(body: &Value) -> Option<Slice> {
    let present = |k: &str| !matches!(body.get(k), Value::Undefined);
    if ["strike", "expiry", "combo", "legs"]
        .iter()
        .any(|k| present(k))
    {
        return Some(Slice::Spreads);
    }
    None
}

/// `toEngineOrder` for an order this slice serves.
fn to_engine_order(body: &Value) -> Result<EngineOrder, String> {
    let order_type = OrderType::parse(&text(body.get("type"))).ok_or("type")?;
    let side = Side::parse(&text(body.get("side"))).ok_or("side")?;
    let tif = Tif::parse(&text(body.get("tif"))).ok_or("tif")?;
    // `bindPostOnlyTif`: post-only binds PO unless the order is immediate, which the door refused already.
    let tif = if is_true(body.get("postOnly")) && !matches!(tif, Tif::Ioc | Tif::Fok) {
        Tif::Po
    } else {
        tif
    };
    let mut order = EngineOrder::new(
        text(body.get("orderId")),
        text(body.get("accountId")),
        order_type,
        side,
        amount(body.get("qty"))?,
        nullish_amount(body.get("price"))?,
        tif,
    );
    // `body.stopPx ?? body.stopPrice`.
    order.stop_price = match body.get("stopPx") {
        Value::Undefined | Value::Null => nullish_amount(body.get("stopPrice"))?,
        v => Some(amount(v)?),
    };
    let truthy_text = |k: &str| {
        body.get(k)
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    order.oco_sibling_id = truthy_text("ocoSiblingId");
    order.exits.oco = is_true(body.get("oco"));
    // `body.x != null ? { x: parseAmount(body.x) } : {}`.
    let set_amount = |k: &str| -> Result<Opt<Amount>, String> {
        Ok(nullish_amount(body.get(k))?.map_or(Opt::Absent, Opt::Some))
    };
    order.exits.take_profit = set_amount("takeProfit")?;
    order.exits.stop_loss = set_amount("stopLoss")?;
    order.exits.stop_loss_limit = set_amount("stopLossLimit")?;
    order.expire_at = truthy_text("expireAt");
    order.trail = opt_amount(body.get("trail"))?;
    order.mark = opt_amount(body.get("mark"))?;
    order.session_id = body
        .get("sessionId")
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    order.reduce_only = is_true(body.get("reduceOnly"));
    order.min_qty = opt_amount(body.get("minQty"))?;
    order.collar = match body.get("collar") {
        Value::Undefined => Opt::Absent,
        v => Opt::Some(is_true(v)),
    };
    // The liquidity parts, as `toEngineOrder` copies them: each present one, and an iceberg with or without its display.
    if is_true(body.get("iceberg"))
        || !matches!(body.get("displayQty"), Value::Undefined | Value::Null)
    {
        order.iceberg = true;
        order.display_qty = match nullish_amount(body.get("displayQty"))? {
            None => Opt::Null,
            Some(d) => Opt::Some(d),
        };
    }
    let flag = |k: &str| match body.get(k) {
        Value::Undefined => Opt::Absent,
        v => Opt::Some(is_true(v)),
    };
    order.aon = flag("aon");
    order.peg = flag("peg");
    order.midpoint = flag("midpoint");
    order.relative = flag("relative");
    order.reference = opt_amount(body.get("reference"))?;
    order.offset = opt_amount(body.get("offset"))?;
    order.auction = flag("auction");
    order.benchmark = flag("benchmark");
    order.min = opt_amount(body.get("min"))?;
    order.max = opt_amount(body.get("max"))?;
    order.min_notional = opt_amount(body.get("minNotional"))?;
    Ok(order)
}

pub(super) fn proof(body: &Value) -> Option<Json> {
    body.get("lifecycleProof").to_json()
}

fn flags_fields(f: Flags) -> Vec<(String, Json)> {
    vec![
        ("venueHalted".into(), Json::Bool(f.venue_halted)),
        ("halted".into(), Json::Bool(f.halted)),
        ("prelaunch".into(), Json::Bool(f.prelaunch)),
        ("expired".into(), Json::Bool(f.expired)),
        ("delisted".into(), Json::Bool(f.delisted)),
        ("reduceOnly".into(), Json::Bool(f.reduce_only)),
        ("postOnly".into(), Json::Bool(f.post_only)),
    ]
}

fn ladder(levels: &[(Amount, Amount)]) -> Json {
    Json::Array(
        levels
            .iter()
            .map(|(p, s)| {
                Json::Array(vec![
                    Json::str(format_amount(*p)),
                    Json::str(format_amount(*s)),
                ])
            })
            .collect(),
    )
}

fn queue(levels: &[QueueLevel], limit: usize) -> Json {
    Json::Array(
        levels
            .iter()
            .take(limit)
            .map(|(price, orders)| {
                Json::obj([
                    ("price", Json::str(format_amount(*price))),
                    (
                        "orders",
                        Json::Array(
                            orders
                                .iter()
                                .map(|(id, remaining, sequence)| {
                                    Json::obj([
                                        ("orderId", Json::str(id.clone())),
                                        ("remaining", Json::str(format_amount(*remaining))),
                                        ("sequence", crate::book::types::seq_json(*sequence)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect(),
    )
}

fn refusal(code: &str, message: &str) -> Json {
    Json::obj([("code", Json::str(code)), ("message", Json::str(message))])
}

/// `publicMatchingBoard`.
fn board(engine: &MatchingEngine) -> Json {
    let markets = engine.markets();
    let pick = |f: &dyn Fn(Flags) -> bool| -> Json {
        Json::Array(
            markets
                .iter()
                .filter(|m| f(engine.flags(m)))
                .map(|m| Json::str(m.clone()))
                .collect(),
        )
    };
    let since: Vec<(String, Json)> = markets
        .iter()
        .filter_map(|m| {
            engine
                .halted_since(m)
                .map(|at| (m.clone(), Json::String(at)))
        })
        .collect();
    Json::obj([
        (
            "markets",
            Json::Array(markets.iter().map(|m| Json::str(m.clone())).collect()),
        ),
        ("venueHalted", Json::Bool(engine.flags("").venue_halted)),
        ("halted", pick(&|f| f.halted)),
        ("haltedSince", Json::Object(since)),
        (
            "venueHaltedSince",
            engine.venue_halted_since().map_or(Json::Null, Json::String),
        ),
        ("prelaunch", pick(&|f| f.prelaunch)),
        ("expired", pick(&|f| f.expired)),
        ("delisted", pick(&|f| f.delisted)),
        ("reduceOnly", pick(&|f| f.reduce_only)),
        ("postOnly", pick(&|f| f.post_only)),
    ])
}

fn limit_of(req: &Request<'_>) -> usize {
    query(req.url)
        .iter()
        .find(|(k, _)| k == "limit")
        .and_then(|(_, v)| match v {
            Json::String(raw) => published_limit(raw),
            _ => None,
        })
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(0)
}

fn sbe_unavailable() -> Outcome {
    let body = Json::obj([
        ("code", Json::str("matching.sbe_unavailable")),
        ("reason", Json::str("sbe_unavailable")),
        (
            "message",
            Json::str(errors::user_copy("matching.sbe_unavailable")),
        ),
    ]);
    Outcome::Answer(Response {
        status: 409,
        body: body.compact(),
    })
}

/// One of the slice's doors, its caller and input already let in.
pub fn serve(
    route: &Route,
    req: &Request<'_>,
    param: &dyn Fn(&str) -> String,
    body: &Value,
    engine: &mut MatchingEngine,
) -> Outcome {
    let market = param("marketId");
    match (route.method, route.path) {
        ("POST", "/markets/:marketId/orders") => {
            if let Some(slice) = submit_owed_by(body) {
                return Outcome::Owed(slice);
            }
            let order = match to_engine_order(body) {
                Ok(o) => o,
                Err(e) => return Outcome::Answer(errors::thrown(&e)),
            };
            match engine.submit(&market, &order, proof(body).as_ref()) {
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        ("POST", "/markets/:marketId/mark") => {
            match engine.mark_trailing_stops(&market, &text(body.get("mark"))) {
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        ("POST", "/markets/:marketId/positions/close") => {
            let result = engine.close_position(
                &market,
                &text(body.get("orderId")),
                &text(body.get("accountId")),
                proof(body).as_ref(),
            );
            match result {
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        ("GET", "/markets/:marketId/positions/:accountId") => {
            let account = param("accountId");
            let qty = engine.net_position(&market, &account);
            ok(Json::obj([
                ("marketId", Json::str(market)),
                ("accountId", Json::str(account)),
                ("qty", Json::str(format_amount(qty))),
            ]))
        }
        ("PATCH", "/markets/:marketId/orders/:orderId") => {
            let read = |k: &str| -> Result<Option<Amount>, String> {
                match body.get(k) {
                    Value::Undefined => Ok(None),
                    v => amount(v).map(Some),
                }
            };
            let cmd = (|| -> Result<EngineAmend, String> {
                Ok(EngineAmend {
                    order_id: param("orderId"),
                    expected_version: body
                        .get("expectedVersion")
                        .as_number()
                        .and_then(|n| crate::journal::record::whole(&Json::Number(n)))
                        .and_then(|n| u64::try_from(n).ok())
                        .ok_or("expectedVersion")?,
                    qty: read("qty")?,
                    price: read("price")?,
                    stop_price: read("stopPrice")?,
                    tif: match body.get("tif").as_str() {
                        None => None,
                        Some(t) => Some(Tif::parse(t).ok_or("tif")?),
                    },
                    expire_at: None,
                })
            })();
            let cmd = match cmd {
                Ok(c) => c,
                Err(e) => return Outcome::Answer(errors::thrown(&e)),
            };
            match engine.amend(&market, &cmd, proof(body).as_ref()) {
                Ok(r)
                    if !r.accepted
                        && r.rejected
                            .as_ref()
                            .is_some_and(|x| x.code == "order_not_found") =>
                {
                    not_found("OrderNotFound", "matching.order_not_found")
                }
                Ok(r) => ok(r.to_json()),
                Err(e) => failed(&e),
            }
        }
        ("DELETE", "/markets/:marketId/orders/:orderId") => {
            match engine.cancel(&market, &param("orderId"), CancelReason::Requested) {
                Err(e) => failed(&e),
                Ok(r) => match (&r.rejected, r.cancelled) {
                    (Some(rejected), _) => ok(Json::obj([
                        ("cancelled", Json::Bool(false)),
                        ("orderId", Json::str(r.order_id.clone())),
                        (
                            "sequence",
                            r.sequence.map_or(Json::Null, crate::book::types::seq_json),
                        ),
                        ("cancellation", Json::Null),
                        ("rejected", rejected.to_json()),
                    ])),
                    (None, false) => not_found("OrderNotFound", "matching.order_not_found"),
                    (None, true) => ok(Json::obj([
                        ("cancelled", Json::Bool(true)),
                        ("orderId", Json::str(r.order_id.clone())),
                        (
                            "sequence",
                            r.sequence.map_or(Json::Null, crate::book::types::seq_json),
                        ),
                        (
                            "cancellation",
                            r.cancellation
                                .as_ref()
                                .map_or(Json::Null, crate::book::types::CancelledRef::to_json),
                        ),
                    ])),
                },
            }
        }
        ("POST", "/markets/:marketId/orders/mass-cancel") => {
            let account = text(body.get("accountId"));
            let session = body.get("sessionId").as_str();
            let side = body.get("side").as_str().and_then(Side::parse);
            match engine.mass_cancel(&market, &account, session, side) {
                Err(e) => failed(&e),
                Ok(r) => ok(Json::obj([
                    ("accepted", Json::Bool(r.accepted)),
                    ("accountId", Json::str(r.account_id.clone())),
                    (
                        "cancellations",
                        Json::Array(
                            r.cancellations
                                .iter()
                                .map(crate::book::types::CancelledRef::to_json)
                                .collect(),
                        ),
                    ),
                    (
                        "rejected",
                        r.rejected
                            .as_ref()
                            .map_or(Json::Null, crate::book::types::Reject::to_json),
                    ),
                ])),
            }
        }
        ("GET", "/markets/:marketId/orders") => {
            if !engine.has_market(&market) {
                return not_found("MarketNotFound", "matching.market_not_found");
            }
            let orders: Vec<Json> = engine
                .resting_orders(Some(&market))
                .iter()
                .take(limit_of(req))
                .map(crate::engine::EngineLiveOrder::to_json)
                .collect();
            ok(Json::obj([
                ("marketId", Json::str(market)),
                ("orders", Json::Array(orders)),
            ]))
        }
        ("POST", "/reconcile") => {
            let claims: Vec<CounterpartOrder> = body
                .get("orders")
                .as_array()
                .unwrap_or(&[])
                .iter()
                .map(|c| CounterpartOrder {
                    order_id: text(c.get("orderId")),
                    market_id: text(c.get("marketId")),
                    state: text(c.get("state")),
                    remaining: text(c.get("remaining")),
                    funded: is_true(c.get("funded")),
                    detail: c.get("detail").as_str().map(str::to_owned),
                })
                .collect();
            ok(reconcile(&engine.resting_orders(None), &claims).to_json())
        }
        ("GET", "/markets") => ok(board(engine)),
        ("GET", "/markets/:marketId/depth" | "/markets/:marketId/depth/sbe") => {
            let Some(depth) = engine.depth(&market, limit_of(req)) else {
                return not_found("MarketNotFound", "matching.market_not_found");
            };
            let wants_sbe = route.path.ends_with("/sbe")
                || query(req.url)
                    .iter()
                    .any(|(k, v)| k == "format" && matches!(v, Json::String(f) if f == "sbe"));
            // This port links no SBE encoder: the answer the TypeScript gives without one.
            if wants_sbe {
                return sbe_unavailable();
            }
            let mut fields: Vec<(String, Json)> = vec![
                ("marketId".into(), Json::str(market.clone())),
                ("bids".into(), ladder(&depth.bids)),
                ("asks".into(), ladder(&depth.asks)),
                (
                    "sequence".into(),
                    crate::book::types::seq_json(depth.sequence),
                ),
            ];
            fields.extend(flags_fields(engine.flags(&market)));
            ok(Json::Object(fields))
        }
        ("GET", "/markets/:marketId/depth/l3") => {
            if !engine.has_market(&market) && !engine.is_listed(&market) {
                return not_found("MarketNotFound", "matching.market_not_found");
            }
            let limit = limit_of(req);
            let q = engine.l3_queue(&market);
            let mut fields: Vec<(String, Json)> = vec![
                ("level".into(), Json::str("L3")),
                ("marketId".into(), Json::str(q.market_id.clone())),
                ("sequence".into(), crate::book::types::seq_json(q.sequence)),
                ("bids".into(), queue(&q.bids, limit)),
                ("asks".into(), queue(&q.asks, limit)),
            ];
            fields.extend(flags_fields(engine.flags(&market)));
            fields.push((
                "makerIdentity".into(),
                Json::obj([
                    ("accepted", Json::Bool(false)),
                    ("marketId", Json::str(market.clone())),
                    ("identity", Json::Null),
                    (
                        "rejected",
                        refusal(
                            "maker_identity_unpublished",
                            "public maker identity is unpublished; matching does not produce maker names",
                        ),
                    ),
                ]),
            ));
            fields.push((
                "l4".into(),
                Json::obj([
                    ("accepted", Json::Bool(false)),
                    ("marketId", Json::str(market)),
                    (
                        "rejected",
                        refusal(
                            "l4_unpublished",
                            "L4 is unpublished; matching does not produce L4",
                        ),
                    ),
                ]),
            ));
            ok(Json::Object(fields))
        }
        _ => Outcome::Owed(route.slice),
    }
}
