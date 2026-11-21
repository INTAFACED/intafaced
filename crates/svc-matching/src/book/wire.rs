//! An order and an amend as the journal holds them (`journal-wire.ts`): every amount a decimal string, and each
//! optional part written only when the order carries it, in `toWire`'s key order, so a record reads back as the order it
//! was.
//!
//! A journalled order that names a part only a later slice's module reads (options and combos, spreads, client order
//! ids) does not read here: [`from_wire`] names the slice that owes it, and
//! replay stops rather than rebuild a book without it.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};

use super::types::{EngineAmend, EngineOrder, Opt, OrderType, Side, Tif, TriggerBy, TriggerRole};
use crate::door::Slice;
use crate::journal::record::truthy;

/// A journalled order or amend this slice cannot rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// A part a later slice's module reads: which part, and which slice owes it.
    Owed { field: String, slice: Slice },
    /// Not an order: a field missing or of the wrong kind, or an amount that does not parse.
    Malformed(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Owed { field, slice } => write!(
                f,
                "a journalled {field} needs slice {}, which is not ported",
                slice.name()
            ),
            WireError::Malformed(why) => write!(f, "journalled order: {why}"),
        }
    }
}

impl std::error::Error for WireError {}

/// The parts of a wire order a later slice reads, and the slice.
const OWED: [(&str, Slice); 7] = [
    ("strike", Slice::Spreads),
    ("expiry", Slice::Spreads),
    ("exercise", Slice::Spreads),
    ("combo", Slice::Spreads),
    ("legs", Slice::Spreads),
    ("spread", Slice::Spreads),
    ("clientOrderId", Slice::Spreads),
];

fn amount_json(a: Amount) -> Json {
    Json::str(format_amount(a))
}

fn opt_amount_json(a: Option<Amount>) -> Json {
    a.map_or(Json::Null, amount_json)
}

/// `toWire(order, lifecycleProof)`.
pub fn to_wire(order: &EngineOrder, lifecycle_proof: Option<&Json>) -> Json {
    let mut f: Vec<(String, Json)> = vec![
        ("orderId".into(), Json::str(order.order_id.clone())),
        ("accountId".into(), Json::str(order.account_id.clone())),
        ("type".into(), Json::str(order.order_type.as_str())),
        ("side".into(), Json::str(order.side.as_str())),
        ("qty".into(), amount_json(order.qty)),
        ("price".into(), opt_amount_json(order.price)),
        ("stopPrice".into(), opt_amount_json(order.stop_price)),
        ("tif".into(), Json::str(order.tif.as_str())),
    ];
    if let Some(role) = order.trigger_role.filter(|r| *r != TriggerRole::Legacy) {
        f.push(("triggerRole".into(), Json::str(role.as_str())));
    }
    if let Some(by) = order.trigger_by {
        f.push(("triggerBy".into(), Json::str(by.as_str())));
    }
    if order.option_instrument {
        f.push(("instrument".into(), Json::str("option")));
    }
    if let Some(p) = order.position_qty {
        f.push(("positionQty".into(), amount_json(p)));
    }
    if let Some(s) = order.oco_sibling_id.as_ref().filter(|s| !s.is_empty()) {
        f.push(("ocoSiblingId".into(), Json::str(s.clone())));
    }
    let x = &order.exits;
    if let Some(b) = opt_present(&x.bracket) {
        f.push(("bracket".into(), b.map_or(Json::Null, Json::Bool)));
    }
    if x.oco {
        f.push(("oco".into(), Json::Bool(true)));
    }
    for (key, v) in [
        ("takeProfit", &x.take_profit),
        ("stopLoss", &x.stop_loss),
        ("stopLossLimit", &x.stop_loss_limit),
    ] {
        if v.present() {
            f.push((key.into(), opt_amount_json(v.get())));
        }
    }
    for (key, v) in [
        ("takeProfitOrderId", &x.take_profit_order_id),
        ("stopLossOrderId", &x.stop_loss_order_id),
    ] {
        if v.present() {
            f.push((
                key.into(),
                v.value().map_or(Json::Null, |s| Json::str(s.clone())),
            ));
        }
    }
    if let Some(s) = order.expire_at.as_ref().filter(|s| !s.is_empty()) {
        f.push(("expireAt".into(), Json::str(s.clone())));
    }
    if let Some(s) = order.session_id.as_ref().filter(|s| !s.is_empty()) {
        f.push(("sessionId".into(), Json::str(s.clone())));
    }
    if order.reduce_only {
        f.push(("reduceOnly".into(), Json::Bool(true)));
    }
    if order.iceberg || order.display_qty.present() {
        f.push(("iceberg".into(), Json::Bool(true)));
        f.push((
            "displayQty".into(),
            opt_amount_json(order.display_qty.get()),
        ));
    }
    let amount = |f: &mut Vec<(String, Json)>, key: &str, v: &Opt<Amount>| {
        if v.present() {
            f.push((key.into(), opt_amount_json(v.get())));
        }
    };
    // `persistTrail`: the mark rides only with a trail.
    if order.trail.present() {
        amount(&mut f, "trail", &order.trail);
        amount(&mut f, "mark", &order.mark);
    }
    let flag = |f: &mut Vec<(String, Json)>, key: &str, v: &Opt<bool>| {
        if v.present() {
            f.push((key.into(), Json::Bool(v.get() == Some(true))));
        }
    };
    amount(&mut f, "minQty", &order.min_qty);
    flag(&mut f, "aon", &order.aon);
    flag(&mut f, "peg", &order.peg);
    flag(&mut f, "midpoint", &order.midpoint);
    flag(&mut f, "relative", &order.relative);
    amount(&mut f, "reference", &order.reference);
    amount(&mut f, "offset", &order.offset);
    flag(&mut f, "auction", &order.auction);
    flag(&mut f, "benchmark", &order.benchmark);
    flag(&mut f, "collar", &order.collar);
    amount(&mut f, "min", &order.min);
    amount(&mut f, "max", &order.max);
    amount(&mut f, "minNotional", &order.min_notional);
    if let Some(proof) = lifecycle_proof {
        f.push(("lifecycleProof".into(), proof.clone()));
    }
    Json::Object(f)
}

/// `Some(value)` for a present field (`None` inside for `null`), `None` when absent.
fn opt_present<T: Copy>(v: &Opt<T>) -> Option<Option<T>> {
    v.present().then(|| v.get())
}

fn malformed(why: impl Into<String>) -> WireError {
    WireError::Malformed(why.into())
}

fn text(o: &Json, key: &str) -> Result<String, WireError> {
    match o.get(key) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(malformed(format!("{key} is not text"))),
    }
}

/// `value ? value : absent`: a non-empty string.
fn truthy_text(o: &Json, key: &str) -> Option<String> {
    match o.get(key) {
        Some(Json::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn amount(o: &Json, key: &str) -> Result<Amount, WireError> {
    match o.get(key) {
        Some(Json::String(s)) => parse_amount(s).map_err(|e| malformed(format!("{key}: {e}"))),
        _ => Err(malformed(format!("{key} is not an amount"))),
    }
}

/// `value === null ? null : parseAmount(value)`.
fn amount_or_null(o: &Json, key: &str) -> Result<Option<Amount>, WireError> {
    match o.get(key) {
        Some(Json::Null) => Ok(None),
        _ => amount(o, key).map(Some),
    }
}

/// `value !== undefined ? (value == null ? null : parseAmount(value)) : absent`.
fn opt_amount(o: &Json, key: &str) -> Result<Opt<Amount>, WireError> {
    match o.get(key) {
        None => Ok(Opt::Absent),
        Some(Json::Null) => Ok(Opt::Null),
        Some(_) => amount(o, key).map(Opt::Some),
    }
}

/// An id as sent: text, else `null` (an id that is not text names nothing, as `namedId` reads it).
fn opt_text(o: &Json, key: &str) -> Opt<String> {
    match o.get(key) {
        None => Opt::Absent,
        Some(Json::String(s)) => Opt::Some(s.clone()),
        Some(_) => Opt::Null,
    }
}

/// `value !== undefined ? value === true : absent`.
fn opt_flag(o: &Json, key: &str) -> Opt<bool> {
    match o.get(key) {
        None => Opt::Absent,
        Some(v) => Opt::Some(matches!(v, Json::Bool(true))),
    }
}

/// `fromWire(order)`.
pub fn from_wire(order: &Json) -> Result<EngineOrder, WireError> {
    if !matches!(order, Json::Object(_)) {
        return Err(malformed("not an object"));
    }
    if let Some((field, slice)) = OWED.iter().find(|(key, _)| order.get(key).is_some()) {
        return Err(WireError::Owed {
            field: (*field).to_owned(),
            slice: *slice,
        });
    }
    let order_type = OrderType::parse(&text(order, "type")?)
        .ok_or_else(|| malformed("type is not an order type this slice reads"))?;
    if !matches!(
        order_type,
        OrderType::Limit | OrderType::Market | OrderType::Stop | OrderType::StopLimit
    ) {
        return Err(WireError::Owed {
            field: "type".to_owned(),
            slice: Slice::Spreads,
        });
    }
    let side = Side::parse(&text(order, "side")?).ok_or_else(|| malformed("side"))?;
    let tif = Tif::parse(&text(order, "tif")?).ok_or_else(|| malformed("tif"))?;
    let mut out = EngineOrder::new(
        text(order, "orderId")?,
        text(order, "accountId")?,
        order_type,
        side,
        amount(order, "qty")?,
        amount_or_null(order, "price")?,
        tif,
    );
    out.stop_price = amount_or_null(order, "stopPrice")?;
    out.trigger_role = match order.get("triggerRole") {
        Some(Json::String(s)) if s == "take_profit" => Some(TriggerRole::TakeProfit),
        Some(Json::String(s)) if s == "stop_loss" => Some(TriggerRole::StopLoss),
        _ => None,
    };
    out.trigger_by = match order.get("triggerBy") {
        Some(Json::String(s)) if s == "mark" => Some(TriggerBy::Mark),
        Some(Json::String(s)) if s == "index" => Some(TriggerBy::Index),
        Some(Json::String(s)) if s == "last" => Some(TriggerBy::Last),
        _ => None,
    };
    out.option_instrument = matches!(order.get("instrument"), Some(Json::String(s)) if s == "option" || s == "option_combo");
    out.position_qty = match order.get("positionQty") {
        None => None,
        Some(_) => Some(amount(order, "positionQty")?),
    };
    out.oco_sibling_id = truthy_text(order, "ocoSiblingId");
    out.exits.bracket = opt_flag(order, "bracket");
    out.exits.oco = matches!(order.get("oco"), Some(Json::Bool(true)));
    out.exits.take_profit = opt_amount(order, "takeProfit")?;
    out.exits.stop_loss = opt_amount(order, "stopLoss")?;
    out.exits.stop_loss_limit = opt_amount(order, "stopLossLimit")?;
    out.exits.take_profit_order_id = opt_text(order, "takeProfitOrderId");
    out.exits.stop_loss_order_id = opt_text(order, "stopLossOrderId");
    out.expire_at = truthy_text(order, "expireAt");
    out.session_id = truthy_text(order, "sessionId");
    out.reduce_only = truthy(order.get("reduceOnly"));
    if matches!(order.get("iceberg"), Some(Json::Bool(true))) || order.get("displayQty").is_some() {
        out.iceberg = true;
        out.display_qty = match opt_amount(order, "displayQty")? {
            Opt::Absent => Opt::Null,
            v => v,
        };
    }
    if order.get("trail").is_some() {
        out.trail = opt_amount(order, "trail")?;
        out.mark = opt_amount(order, "mark")?;
    }
    out.min_qty = opt_amount(order, "minQty")?;
    out.aon = opt_flag(order, "aon");
    out.peg = opt_flag(order, "peg");
    out.midpoint = opt_flag(order, "midpoint");
    out.relative = opt_flag(order, "relative");
    out.reference = opt_amount(order, "reference")?;
    out.offset = opt_amount(order, "offset")?;
    out.auction = opt_flag(order, "auction");
    out.benchmark = opt_flag(order, "benchmark");
    out.collar = opt_flag(order, "collar");
    out.min = opt_amount(order, "min")?;
    out.max = opt_amount(order, "max")?;
    out.min_notional = opt_amount(order, "minNotional")?;
    Ok(out)
}

/// `toWireAmend(cmd)`: the patch.
pub fn to_wire_amend(cmd: &EngineAmend) -> Json {
    let mut f: Vec<(String, Json)> = Vec::new();
    if let Some(q) = cmd.qty {
        f.push(("qty".into(), amount_json(q)));
    }
    if let Some(p) = cmd.price {
        f.push(("price".into(), amount_json(p)));
    }
    if let Some(p) = cmd.stop_price {
        f.push(("stopPrice".into(), amount_json(p)));
    }
    if let Some(t) = cmd.tif {
        f.push(("tif".into(), Json::str(t.as_str())));
    }
    if let Some(e) = &cmd.expire_at {
        f.push(("expireAt".into(), Json::str(e.clone())));
    }
    Json::Object(f)
}

/// `fromWireAmend(orderId, expectedVersion, patch)`.
pub fn from_wire_amend(
    order_id: &str,
    expected_version: u64,
    patch: &Json,
) -> Result<EngineAmend, WireError> {
    for (key, slice) in [("strike", Slice::Spreads), ("expiry", Slice::Spreads)] {
        if patch.get(key).is_some() {
            return Err(WireError::Owed {
                field: format!("amend {key}"),
                slice,
            });
        }
    }
    let opt = |key: &str| -> Result<Option<Amount>, WireError> {
        match patch.get(key) {
            None => Ok(None),
            Some(_) => amount(patch, key).map(Some),
        }
    };
    Ok(EngineAmend {
        order_id: order_id.to_owned(),
        expected_version,
        qty: opt("qty")?,
        price: opt("price")?,
        stop_price: opt("stopPrice")?,
        tif: match patch.get("tif") {
            None => None,
            Some(Json::String(t)) => Some(Tif::parse(t).ok_or_else(|| malformed("amend tif"))?),
            Some(_) => return Err(malformed("amend tif")),
        },
        expire_at: match patch.get("expireAt") {
            None => None,
            Some(Json::String(s)) => Some(s.clone()),
            Some(_) => return Err(malformed("amend expireAt")),
        },
    })
}
