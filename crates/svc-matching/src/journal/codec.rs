//! How a record is written to disk (`encode` in `journal-codec.ts`): one line of JSON with a fixed key order, so two
//! equal records are the same bytes, and only the fields the record's kind keeps. A boot rewrites every record it read
//! through this, so it must give the TypeScript's bytes for any record a journal holds, old ones included:
//! `tests/journal_codec.rs` holds it to the TypeScript's own output.
//!
//! Amounts stay the decimal strings they arrived as. Nothing here reads a number as money.

use std::fmt;

use service_kit::json::Json;

use super::record::{JournalRecord, is_str, is_true, js_string, nullish, prop, truthy};

/// The rulebook's sections, in the order `rulebook.ts` (`RULEBOOK_SECTIONS`) writes them.
pub const RULEBOOK_SECTION_IDS: [&str; 7] = [
    "participation",
    "matching",
    "cancellation",
    "settlement",
    "liquidation",
    "fees",
    "market_data",
];

/// The record could not be written, where the TypeScript's `encode` throws: a kind it does not know, or a field it
/// reads through that is missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodeError {
    pub message: String,
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EncodeError {}

/// An object written in the order its fields are put; a field that is `undefined` is left out, as `JSON.stringify`
/// leaves it out.
struct Out(Vec<(String, Json)>);

impl Out {
    fn new() -> Self {
        Out(Vec::new())
    }

    fn put(&mut self, key: &str, value: Option<&Json>) {
        if let Some(value) = value {
            self.0.push((key.to_owned(), value.clone()));
        }
    }

    fn set(&mut self, key: &str, value: Json) {
        self.0.push((key.to_owned(), value));
    }

    fn done(self) -> Json {
        Json::Object(self.0)
    }
}

/// `value == null ? null : value`, for a field that is kept: `null` when absent.
fn or_null(value: Option<&Json>) -> Json {
    value.cloned().unwrap_or(Json::Null)
}

/// `holder.key` where `holder` is read through: `undefined` or `null` there throws in JavaScript.
fn through<'a>(
    holder: Option<&'a Json>,
    key: &str,
    what: &str,
) -> Result<Option<&'a Json>, EncodeError> {
    if nullish(holder) {
        return Err(EncodeError {
            message: format!("journal encode read {key} of a missing {what}"),
        });
    }
    Ok(prop(holder, key))
}

fn need<'a>(holder: Option<&'a Json>, what: &str) -> Result<Option<&'a Json>, EncodeError> {
    if nullish(holder) {
        return Err(EncodeError {
            message: format!("journal encode read a missing {what}"),
        });
    }
    Ok(holder)
}

/// `wireSpreadOrdered`: a spread listing's fields in their fixed order.
fn spread_ordered(instrument: Option<&Json>) -> Result<Json, EncodeError> {
    let instrument = need(instrument, "spread instrument")?;
    let legs = match prop(instrument, "legs") {
        Some(Json::Array(legs)) => legs,
        _ => {
            return Err(EncodeError {
                message: "journal encode read legs that are not a list".to_owned(),
            });
        }
    };
    let mut ordered = Vec::with_capacity(legs.len());
    for leg in legs {
        let leg = need(Some(leg), "spread leg")?;
        let mut out = Out::new();
        out.put("symbol", prop(leg, "symbol"));
        out.put("side", prop(leg, "side"));
        out.put("ratio", prop(leg, "ratio"));
        ordered.push(out.done());
    }
    let mut out = Out::new();
    out.put("spreadId", prop(instrument, "spreadId"));
    out.put("kind", prop(instrument, "kind"));
    out.set("legs", Json::Array(ordered));
    out.put("tick", prop(instrument, "tick"));
    out.put("lot", prop(instrument, "lot"));
    Ok(out.done())
}

/// The fields every record starts with: `seq`, `kind`, and the market and time where its kind has them.
fn head(r: &JournalRecord, market: bool) -> Out {
    let mut out = Out::new();
    out.put("seq", r.field("seq"));
    out.put("kind", r.field("kind"));
    if market {
        out.put("marketId", r.field("marketId"));
    }
    out.put("at", r.field("at"));
    out
}

fn order(o: Option<&Json>) -> Result<Json, EncodeError> {
    let f = |key: &str| through(o, key, "order");
    let mut out = Out::new();
    for key in [
        "orderId",
        "accountId",
        "type",
        "side",
        "qty",
        "price",
        "stopPrice",
        "tif",
    ] {
        out.put(key, f(key)?);
    }
    if truthy(f("ocoSiblingId")?) {
        out.put("ocoSiblingId", f("ocoSiblingId")?);
    }
    out.put("bracket", f("bracket")?);
    if is_true(f("oco")?) {
        out.set("oco", Json::Bool(true));
    }
    for key in [
        "takeProfit",
        "stopLoss",
        "stopLossLimit",
        "takeProfitOrderId",
        "stopLossOrderId",
    ] {
        out.put(key, f(key)?);
    }
    for key in ["expireAt", "sessionId", "clientOrderId", "environment"] {
        if truthy(f(key)?) {
            out.put(key, f(key)?);
        }
    }
    if truthy(f("reduceOnly")?) {
        out.set("reduceOnly", Json::Bool(true));
    }
    for key in ["triggerRole", "triggerBy", "instrument"] {
        if truthy(f(key)?) {
            out.put(key, f(key)?);
        }
    }
    out.put("positionQty", f("positionQty")?);
    // journal-persist.ts: which optional parts a resting order keeps.
    if is_true(f("iceberg")?) || f("displayQty")?.is_some() {
        out.set("iceberg", Json::Bool(true));
        out.set("displayQty", or_null(f("displayQty")?));
    }
    if f("trail")?.is_some() {
        out.set("trail", or_null(f("trail")?));
        out.put("mark", f("mark")?);
    }
    for key in ["strike", "expiry"] {
        if f(key)?.is_some() {
            out.set(key, or_null(f(key)?));
        }
    }
    if is_true(f("exercise")?) {
        out.set("exercise", Json::Bool(true));
    }
    if f("minQty")?.is_some() {
        out.set("minQty", or_null(f("minQty")?));
    }
    for key in ["aon", "peg", "midpoint", "relative"] {
        if f(key)?.is_some() {
            out.set(key, Json::Bool(is_true(f(key)?)));
        }
    }
    for key in ["reference", "offset"] {
        if f(key)?.is_some() {
            out.set(key, or_null(f(key)?));
        }
    }
    if f("collar")?.is_some() {
        out.set("collar", Json::Bool(is_true(f("collar")?)));
    }
    for key in ["min", "max", "minNotional"] {
        if f(key)?.is_some() {
            out.set(key, or_null(f(key)?));
        }
    }
    if f("combo")?.is_some() {
        out.set("combo", Json::Bool(is_true(f("combo")?)));
    }
    if f("legs")?.is_some() {
        // `o.legs ?? null`
        out.set("legs", or_null(f("legs")?));
    }
    if let Some(spread) = f("spread")? {
        let instrument = through(Some(spread), "instrument", "spread")?;
        let mut terms = Out::new();
        terms.set("instrument", spread_ordered(instrument)?);
        terms.put("anchorReference", prop(Some(spread), "anchorReference"));
        out.set("spread", terms.done());
    }
    out.put("lifecycleProof", f("lifecycleProof")?);
    Ok(out.done())
}

fn amend_patch(p: Option<&Json>) -> Result<Json, EncodeError> {
    let mut out = Out::new();
    for key in [
        "qty",
        "price",
        "stopPrice",
        "tif",
        "expireAt",
        "strike",
        "expiry",
    ] {
        out.put(key, through(p, key, "amend patch")?);
    }
    Ok(out.done())
}

/// Operator fields: who asked, and the second person when there was one.
fn operator(out: &mut Out, r: &JournalRecord) {
    out.put("operatorId", r.field("operatorId"));
    if truthy(r.field("confirmOperatorId")) {
        out.put("confirmOperatorId", r.field("confirmOperatorId"));
    }
}

/// `encode(record)`: the record's one line, without its newline.
pub fn encode(r: &JournalRecord) -> Result<String, EncodeError> {
    if nullish(Some(&r.0)) {
        return Err(EncodeError {
            message: "journal encode read the kind of a missing record".to_owned(),
        });
    }
    let kind = r.field("kind");
    let is = |name: &str| is_str(kind, name);
    let json = if is("submit") {
        let mut out = head(r, true);
        out.set("order", order(r.field("order"))?);
        out.done()
    } else if is("amend") {
        let mut out = head(r, true);
        out.put("orderId", r.field("orderId"));
        out.put("expectedVersion", r.field("expectedVersion"));
        out.set("patch", amend_patch(r.field("patch"))?);
        out.put("lifecycleProof", r.field("lifecycleProof"));
        out.done()
    } else if is("mass_cancel") {
        let mut out = head(r, true);
        out.put("accountId", r.field("accountId"));
        if truthy(r.field("side")) {
            out.put("side", r.field("side"));
        }
        out.done()
    } else if is("halt_all") || is("resume_all") {
        let mut out = head(r, false);
        operator(&mut out, r);
        out.done()
    } else if is("split_brain") || is("clear_split_brain") {
        let mut out = head(r, false);
        out.put("operatorId", r.field("operatorId"));
        out.put("confirmOperatorId", r.field("confirmOperatorId"));
        out.done()
    } else if is("spread_list") {
        let mut out = head(r, true);
        operator(&mut out, r);
        out.set("instrument", spread_ordered(r.field("instrument"))?);
        out.done()
    } else if is("rulebook_version") {
        let mut out = head(r, false);
        for key in [
            "operatorId",
            "confirmOperatorId",
            "approvalId",
            "version",
            "effectiveAt",
            "supersedes",
            "digest",
        ] {
            out.put(key, r.field(key));
        }
        let sections = need(r.field("sections"), "rulebook sections")?;
        let mut body = Out::new();
        for id in RULEBOOK_SECTION_IDS {
            body.put(id, prop(sections, id));
        }
        out.set("sections", body.done());
        out.done()
    } else if is("session_dead") {
        let mut out = head(r, false);
        out.put("sessionId", r.field("sessionId"));
        out.done()
    } else if is("in_flight") {
        let mut out = head(r, true);
        out.put("orderId", r.field("orderId"));
        out.put("mutation", r.field("mutation"));
        // ifm.ts: `persistInFlight`, `persistIfmQty`.
        if is_true(r.field("inFlight")) {
            out.set("inFlight", Json::Bool(true));
        }
        if r.field("qty").is_some() {
            out.set("qty", or_null(r.field("qty")));
        }
        out.done()
    } else if is("open_surveillance") {
        let mut out = head(r, true);
        out.put("accountId", r.field("accountId"));
        out.put("reason", r.field("reason"));
        out.done()
    } else if is("mark") {
        let mut out = head(r, true);
        out.put("mark", r.field("mark"));
        out.done()
    } else if [
        "halt",
        "resume",
        "reduce_only",
        "resume_reduce_only",
        "post_only",
        "resume_post_only",
        "prelaunch",
        "open",
        "expire",
        "delist",
        "maintenance",
        "end_maintenance",
    ]
    .into_iter()
    .any(is)
    {
        let mut out = head(r, true);
        operator(&mut out, r);
        out.done()
    } else if is("cancel") {
        let mut out = head(r, true);
        out.put("orderId", r.field("orderId"));
        let reason = r.field("reason");
        if truthy(reason) && !is_str(reason, "requested") {
            out.put("reason", reason);
        }
        out.done()
    } else {
        return Err(EncodeError {
            message: format!("journal encode missed {}", js_string(kind)),
        });
    };
    Ok(json.compact())
}
