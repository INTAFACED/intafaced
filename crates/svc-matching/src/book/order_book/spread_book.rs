//! The spread book (`spread-book.ts`). A spread is one instrument with its own book, keyed by the spread id: spread
//! orders rest and match there as one order at a spread price, and their legs never rest on their own or touch an
//! outright book.
//!
//! Equal or nothing: a spread order is admitted only if every fill it would print prices every leg exactly at the listed
//! ratios. The check rehearses the match on a copy of the book first, so a refusal leaves the book, its sequence and the
//! journal untouched, and no partial leg ever prints. Each accepted fill carries all its legs.
//!
//! GTC limit orders only; any other time in force, or any other part, refuses `spread_order_unsupported`. A spread
//! order does not amend in place. A book that has taken a spread order takes no outright order, and a book that has
//! already moved for outright orders takes no spread order.

use super::OrderBook;
use crate::book::spread::{
    spread_identity, spread_leg_fills, spread_leg_prices, spread_reference_refuse,
};
use crate::book::types::{
    AmendResult, EngineAmend, EngineOrder, Opt, OrderType, Reject, SubmitResult, Tif,
};

fn refuse(code: &str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

/// `outrightOnSpreadRefuse`.
pub fn outright_on_spread_refuse(market_id: &str) -> Reject {
    refuse(
        "spread_book_outright_refused",
        format!("{market_id} is a spread book; it takes spread orders only"),
    )
}

/// `spread_amend_unsupported`.
pub fn spread_amend_refuse() -> Reject {
    refuse(
        "spread_amend_unsupported",
        "a spread order does not amend in place; cancel it and place a new one",
    )
}

/// The first part a spread order may not carry that this one sets, in the order the order names its parts.
fn unsupported_field(o: &EngineOrder) -> Option<&'static str> {
    let set_amount = |v: &Opt<_>| matches!(v, Opt::Some(_));
    let set_flag = |v: &Opt<bool>| *v == Opt::Some(true);
    let parts: [(&'static str, bool); 37] = [
        ("triggerRole", o.trigger_role.is_some()),
        ("triggerBy", o.trigger_by.is_some()),
        ("instrument", o.instrument.is_some()),
        ("positionQty", o.position_qty.is_some()),
        (
            "ocoSiblingId",
            o.oco_sibling_id.as_ref().is_some_and(|s| !s.is_empty()),
        ),
        ("oco", o.exits.oco),
        ("takeProfit", set_amount(&o.exits.take_profit)),
        ("stopLoss", set_amount(&o.exits.stop_loss)),
        ("stopLossLimit", set_amount(&o.exits.stop_loss_limit)),
        (
            "expireAt",
            o.expire_at.as_ref().is_some_and(|s| !s.is_empty()),
        ),
        ("reduceOnly", o.reduce_only),
        ("iceberg", o.iceberg),
        ("displayQty", set_amount(&o.display_qty)),
        ("trail", set_amount(&o.trail)),
        ("mark", set_amount(&o.mark)),
        ("strike", set_amount(&o.strike)),
        ("expiry", matches!(o.expiry, Opt::Some(_))),
        ("exercise", o.exercise),
        ("cover", o.cover),
        ("cancel", o.exits.cancel),
        ("minQty", set_amount(&o.min_qty)),
        ("aon", set_flag(&o.aon)),
        ("peg", set_flag(&o.peg)),
        ("midpoint", set_flag(&o.midpoint)),
        ("relative", set_flag(&o.relative)),
        ("reference", set_amount(&o.reference)),
        ("offset", set_amount(&o.offset)),
        ("auction", set_flag(&o.auction)),
        ("benchmark", set_flag(&o.benchmark)),
        ("collar", set_flag(&o.collar)),
        ("min", set_amount(&o.min)),
        ("max", set_amount(&o.max)),
        ("minNotional", set_amount(&o.min_notional)),
        (
            "combo",
            set_flag(&o.combo) || matches!(o.legs, Opt::Some(_)),
        ),
        ("bracket", set_flag(&o.exits.bracket)),
        (
            "takeProfitOrderId",
            matches!(o.exits.take_profit_order_id, Opt::Some(_)),
        ),
        (
            "stopLossOrderId",
            matches!(o.exits.stop_loss_order_id, Opt::Some(_)),
        ),
    ];
    parts.iter().find(|(_, set)| *set).map(|(k, _)| *k)
}

/// `spreadOrderRefuse`: why this spread order must not be admitted to `book` (none when there is no book yet), or
/// none. It reads the book and rehearses on a copy; the engine asks before journalling and the book asks again, so a
/// replay reaches the same answer.
pub fn spread_order_refuse(
    book: Option<&OrderBook>,
    market_id: &str,
    order: &EngineOrder,
    now: Option<i64>,
) -> Option<Reject> {
    let terms = order.spread.as_ref()?;
    let instrument = &terms.instrument;
    if instrument.spread_id != market_id {
        return Some(refuse(
            "spread_identity_disagrees",
            format!(
                "a {} spread order cannot rest in {market_id}",
                instrument.spread_id
            ),
        ));
    }
    if let Some(book) = book {
        match &book.spread_mark {
            Some(mark) if *mark != spread_identity(instrument) => {
                return Some(refuse(
                    "spread_identity_disagrees",
                    format!("{market_id} trades a different listing of this spread"),
                ));
            }
            None if book.current_sequence() > 0 => {
                return Some(outright_on_spread_refuse(market_id));
            }
            _ => {}
        }
    }
    let Some(price) = order
        .price
        .filter(|_| order.order_type == OrderType::Limit && order.stop_price.is_none())
    else {
        return Some(refuse(
            "spread_order_unsupported",
            "a spread order is a limit order at a spread price",
        ));
    };
    if order.tif != Tif::Gtc {
        return Some(refuse(
            "spread_order_unsupported",
            format!(
                "spread time-in-force {} is not built yet (CB-otc-17); GTC only",
                order.tif.as_str()
            ),
        ));
    }
    if let Some(extra) = unsupported_field(order) {
        return Some(refuse(
            "spread_order_unsupported",
            format!("spread orders do not take {extra}"),
        ));
    }
    // A quantity that is not positive is the core book's `invalid_qty`, not a lot question.
    if order.qty <= 0 {
        return None;
    }
    if order.qty % instrument.lot != 0 {
        return Some(refuse(
            "spread_qty_off_lot",
            "spread qty is not a whole number of lots",
        ));
    }
    if price % instrument.tick != 0 {
        return Some(refuse(
            "spread_price_off_tick",
            "spread price is not on the listed tick",
        ));
    }
    if let Some(missing) = spread_reference_refuse(instrument, terms.anchor_reference) {
        return Some(missing);
    }
    let reference = terms.anchor_reference?;
    // The order's own price must price every leg, or its rest could block every later taker.
    if let Err(r) = spread_leg_prices(instrument, reference, price) {
        return Some(r);
    }
    let book = book?;
    let Ok(mut copy) = book.rehearsal_copy() else {
        return Some(refuse(
            "spread_leg_unfillable",
            "the spread book could not be copied to rehearse this order",
        ));
    };
    let rehearsal = copy.combo_submit(order, now);
    if !rehearsal.accepted {
        return None;
    }
    for fill in &rehearsal.fills {
        if let Err(r) =
            spread_leg_fills(instrument, reference, fill.price, fill.qty, fill.taker_side)
        {
            return Some(r);
        }
    }
    None
}

impl OrderBook {
    /// True when this book has taken a spread order (`isSpreadBook`).
    pub fn is_spread_book(&self) -> bool {
        self.spread_mark.is_some()
    }

    /// The spread layer's submit, outermost.
    pub(crate) fn spread_submit(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        let Some(terms) = &order.spread else {
            if self.spread_mark.is_some() {
                return SubmitResult::refused(outright_on_spread_refuse(&self.market_id));
            }
            return self.combo_submit(order, now);
        };
        // A retry of an accepted id gets the core book's duplicate answer, not a second rehearsal.
        if self.has_accepted(&order.order_id) {
            return self.combo_submit(order, now);
        }
        let market_id = self.market_id.clone();
        if let Some(r) = spread_order_refuse(Some(self), &market_id, order, now) {
            return SubmitResult::refused(r);
        }
        // Handed on with its terms, as the rehearsal ran it: the core book lets a spread price be zero or negative only
        // on an order that carries them.
        let mut result = self.combo_submit(order, now);
        if !result.accepted {
            return result;
        }
        self.spread_mark = Some(spread_identity(&terms.instrument));
        let reference = terms.anchor_reference.unwrap_or(0);
        // The rehearsal priced these exact fills. A fill left without legs means the book moved under it: the engine
        // stops on it (`EngineError::Invariant`) rather than print half a spread.
        for fill in &mut result.fills {
            fill.legs = spread_leg_fills(
                &terms.instrument,
                reference,
                fill.price,
                fill.qty,
                fill.taker_side,
            )
            .ok();
        }
        result
    }

    /// The spread layer's amend: a spread book amends nothing in place.
    pub(crate) fn spread_amend(&mut self, cmd: &EngineAmend, now: Option<i64>) -> AmendResult {
        if self.spread_mark.is_some() {
            return AmendResult::refused(&cmd.order_id, spread_amend_refuse());
        }
        self.bracket_amend(cmd, now)
    }
}
