//! Combos through matching (`option-combo.ts`, `combo-book.ts`). A combo names its legs, each with a ratio, a strike and
//! an expiry, and rests and matches as one instrument: one order, one rest, one match. It takes only a resting combo with
//! the same legs, and nothing else takes a resting combo. A combo missing a part refuses; a leg name holding an identity
//! separator (`|` or `;`) refuses, since a plain join would alias another leg set.
//!
//! A combo stop parked in the stop book meets the same rule when it fires.

use service_kit::money::{Amount, format_amount};

use super::{OrderBook, StopOrder, cancelled};
use crate::book::types::{
    CancelReason, ComboLeg, EngineOrder, Opt, OrderType, Reject, Side, SubmitResult, TriggerOutcome,
};
use crate::journal::replay::js_sort_cmp;

pub const COMBO_LEGS_MISSING: &str = "missing_combo_legs";
pub const RATIO_MISSING: &str = "missing_ratio";
pub const STRIKE_MISSING: &str = "missing_strike";
pub const EXPIRY_MISSING: &str = "missing_expiry";
pub const COMBO_DISAGREES: &str = "combo_disagrees";

/// One remembered leg of a resting combo (`ComboRestLeg`): its trimmed name and its ratio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComboRestLeg {
    pub name: String,
    pub ratio: Amount,
}

/// A resting combo (`ComboRest`): its order id, the identity of the leg set it rests as, and its legs as sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComboRest {
    pub order_id: String,
    pub identity: String,
    pub legs: Vec<ComboRestLeg>,
}

/// A book's resting combos, in the order they were remembered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComboState {
    rests: Vec<ComboRest>,
}

impl ComboState {
    fn identity_of(&self, order_id: &str) -> Option<&str> {
        self.rest_of(order_id).map(|r| r.identity.as_str())
    }

    fn rest_of(&self, order_id: &str) -> Option<&ComboRest> {
        self.rests.iter().find(|r| r.order_id == order_id)
    }

    fn forget(&mut self, order_id: &str) {
        self.rests.retain(|r| r.order_id != order_id);
    }

    /// `remember`: a combo only rests complete, so every leg holds a ratio.
    fn remember(&mut self, order_id: &str, legs: &[ComboLeg], identity: String) {
        self.forget(order_id);
        self.rests.push(ComboRest {
            order_id: order_id.to_owned(),
            identity,
            legs: legs
                .iter()
                .filter_map(|leg| {
                    read_ratio(leg).map(|ratio| ComboRestLeg {
                        name: trimmed(leg.name.as_ref()),
                        ratio,
                    })
                })
                .collect(),
        });
    }
}

/// `wantsCombo`: `combo: true`, or legs named at all (even null).
pub fn wants_combo(order: &EngineOrder) -> bool {
    order.combo == Opt::Some(true) || order.legs.present()
}

fn splits_identity(v: &str) -> bool {
    v.contains('|') || v.contains(';')
}

fn trimmed(v: Option<&String>) -> String {
    v.map_or_else(String::new, |s| service_kit::schema::js_trim(s).to_owned())
}

/// Ratio: null or zero is missing, never invented; a negative ratio is a short leg.
fn read_ratio(leg: &ComboLeg) -> Option<Amount> {
    leg.ratio.filter(|r| *r != Amount::ZERO)
}

fn read_strike(leg: &ComboLeg) -> Option<Amount> {
    leg.strike.filter(|s| *s > Amount::ZERO)
}

fn read_expiry(leg: &ComboLeg) -> Option<String> {
    leg.expiry
        .as_ref()
        .map(|e| service_kit::schema::js_trim(e).to_owned())
        .filter(|e| !e.is_empty())
}

fn legs_missing(message: String) -> Reject {
    Reject::new(COMBO_LEGS_MISSING, message)
}

fn unnamed_or_split(index: usize, name: &str) -> Reject {
    legs_missing(if name.is_empty() {
        format!("combo leg {index} is unnamed; the engine does not invent a combo book")
    } else {
        format!(
            "combo leg {index} name contains an identity separator; the engine does not alias a different leg set"
        )
    })
}

fn ratio_refuse() -> Reject {
    Reject::new(
        RATIO_MISSING,
        "a combo leg requires a ratio; the engine does not invent a combo book",
    )
}

fn strike_refuse() -> Reject {
    Reject::new(
        STRIKE_MISSING,
        "a combo leg requires a strike; the engine does not invent a strike",
    )
}

fn expiry_refuse() -> Reject {
    Reject::new(
        EXPIRY_MISSING,
        "a combo leg requires an expiry; the engine does not invent an expiry",
    )
}

pub fn combo_disagrees() -> Reject {
    Reject::new(
        COMBO_DISAGREES,
        "a combo takes a resting combo with the same named legs and ratios; the engine does not invent a match",
    )
}

/// `comboLegsRefuse`: at least two legs, each named once, no name holding a separator.
fn combo_legs_refuse(legs: Option<&[ComboLeg]>) -> Option<Reject> {
    let legs = match legs {
        Some(l) if l.len() >= 2 => l,
        _ => {
            return Some(legs_missing(
                "a combo requires named legs; the engine does not invent a combo book".to_owned(),
            ));
        }
    };
    let mut seen: Vec<String> = Vec::new();
    for (index, leg) in legs.iter().enumerate() {
        let name = trimmed(leg.name.as_ref());
        if name.is_empty() || splits_identity(&name) {
            return Some(unnamed_or_split(index, &name));
        }
        if seen.contains(&name) {
            return Some(legs_missing(format!(
                "combo leg {name} is duplicated; the engine does not silently merge legs"
            )));
        }
        seen.push(name);
    }
    None
}

/// One instrument from the named legs, ratios, strikes and expiries; leg order does not mint a second book.
pub fn combo_identity(legs: &[ComboLeg]) -> Result<String, Reject> {
    let mut parts: Vec<String> = Vec::new();
    for (index, leg) in legs.iter().enumerate() {
        let name = trimmed(leg.name.as_ref());
        if name.is_empty() || splits_identity(&name) {
            return Err(unnamed_or_split(index, &name));
        }
        let ratio = read_ratio(leg).ok_or_else(ratio_refuse)?;
        let strike = read_strike(leg).ok_or_else(strike_refuse)?;
        let expiry = read_expiry(leg).ok_or_else(expiry_refuse)?;
        let (ratio, strike) = (format_amount(ratio), format_amount(strike));
        if splits_identity(&ratio) || splits_identity(&strike) || splits_identity(&expiry) {
            return Err(legs_missing(format!(
                "combo leg {index} contains an identity separator; the engine does not alias a different leg set"
            )));
        }
        parts.push(format!("{name}|{ratio}|{strike}|{expiry}"));
    }
    parts.sort_by(|a, b| js_sort_cmp(a, b));
    Ok(parts.join(";"))
}

/// `comboIntentRefuse`: why a combo is incomplete, or none (and none for an order that is not a combo).
pub fn combo_intent_refuse(order: &EngineOrder) -> Option<Reject> {
    if !wants_combo(order) {
        return None;
    }
    let legs = order.legs.value().map(Vec::as_slice);
    if let Some(r) = combo_legs_refuse(legs) {
        return Some(r);
    }
    let legs = legs.unwrap_or_default();
    for leg in legs {
        if read_ratio(leg).is_none() {
            return Some(ratio_refuse());
        }
        if read_strike(leg).is_none() {
            return Some(strike_refuse());
        }
        if read_expiry(leg).is_none() {
            return Some(expiry_refuse());
        }
    }
    combo_identity(legs).err()
}

fn crosses(side: Side, limit: Option<Amount>, level: Amount) -> bool {
    match (limit, side) {
        (None, _) => true,
        (Some(l), Side::Buy) => level <= l,
        (Some(l), Side::Sell) => level >= l,
    }
}

impl OrderBook {
    /// A rest a take would print that is not a combo with this identity (or, for a plain order, any combo).
    fn take_combo_disagrees(
        &self,
        side: Side,
        price: Option<Amount>,
        incoming: Option<&str>,
    ) -> Option<Reject> {
        for level in self.levels(side.opposite()) {
            if !crosses(side, price, level.price) {
                break;
            }
            for rest in &level.orders {
                let rec = self.combo.identity_of(&rest.order_id);
                match incoming {
                    None if rec.is_some() => return Some(combo_disagrees()),
                    None => {}
                    Some(i) if rec != Some(i) => return Some(combo_disagrees()),
                    Some(_) => {}
                }
            }
        }
        None
    }

    /// The combo layer's submit (`installComboBook`'s `submit`), over the option layer.
    pub(super) fn combo_submit(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        let wants = wants_combo(order);
        // An incomplete combo goes on to the option layer, which refuses it with its own code.
        if wants && combo_intent_refuse(order).is_some() {
            return self.triggers_submit(order, now);
        }
        let identity = if wants {
            match combo_identity(order.legs.value().map_or(&[][..], Vec::as_slice)) {
                Ok(i) => Some(i),
                Err(r) => return SubmitResult::refused(r),
            }
        } else {
            None
        };
        if let Some(d) = self.take_combo_disagrees(order.side, order.price, identity.as_deref()) {
            return SubmitResult::refused(d);
        }
        let result = self.triggers_submit(order, now);
        if !result.accepted {
            return result;
        }
        self.forget_filled_combos(&result);
        if let (Some(identity), Some(resting)) = (identity, &result.resting) {
            let legs = order.legs.value().map_or(&[][..], Vec::as_slice);
            self.combo.remember(&resting.order_id, legs, identity);
        }
        result
    }

    /// A combo whose order filled away leaves the combo rows.
    fn forget_filled_combos(&mut self, result: &SubmitResult) {
        let fills = result
            .fills
            .iter()
            .chain(result.triggered.iter().flat_map(|t| t.fills.iter()));
        let ids: Vec<String> = fills
            .flat_map(|f| [f.maker_order_id.clone(), f.taker_order_id.clone()])
            .collect();
        for id in ids {
            if !self.index.contains_key(&id) {
                self.combo.forget(&id);
            }
        }
    }

    /// The combo layer's cancel, over the option layer's.
    pub(super) fn combo_cancel(
        &mut self,
        order_id: &str,
        reason: CancelReason,
    ) -> super::CancelResult {
        let result = self.option_cancel(order_id, reason);
        if result.cancellation.is_some() {
            self.combo.forget(order_id);
        }
        result
    }

    /// A combo stop firing into a book whose rests it may not take: it leaves the stop book refused, under one
    /// sequence, and prints nothing.
    pub(super) fn combo_activation_refuse(&mut self, stop: &StopOrder) -> Option<TriggerOutcome> {
        let identity = self.combo.identity_of(&stop.order_id)?.to_owned();
        let limit = if stop.order_type == OrderType::StopLimit {
            stop.price
        } else {
            None
        };
        let disagrees = self.take_combo_disagrees(stop.side, limit, Some(&identity))?;
        self.combo.forget(&stop.order_id);
        let sequence = self.next_sequence();
        Some(TriggerOutcome {
            order_id: stop.order_id.clone(),
            trigger: None,
            sequence,
            fills: Vec::new(),
            resting: None,
            cancellations: vec![cancelled(
                &stop.order_id,
                &stop.account_id,
                stop.qty,
                sequence,
                CancelReason::TriggerRejected,
            )],
            rejected: Some(disagrees),
            surveillance_cases: Vec::new(),
        })
    }

    /// Whether this book holds a resting combo (a rest or a parked stop) under this id.
    pub fn combo_rest_seen(&self, order_id: &str) -> bool {
        self.combo.identity_of(order_id).is_some()
    }

    /// `comboRestOf`: the resting combo (a rest or a parked stop) under this id, if this book holds one.
    pub fn combo_rest_of(&self, order_id: &str) -> Option<&ComboRest> {
        self.combo.rest_of(order_id)
    }
}
