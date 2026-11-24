//! The small rules the book applies, one TypeScript module each: all-or-none (`aon.ts`), minimum fill size
//! (`min-qty.ts`), icebergs (`iceberg.ts`), pegs (`peg.ts`), auction and benchmark intents (`auction.ts`), caller
//! collars (`collar.ts`), minimum notional (`min-notional.ts`), self-trade prevention (`self-trade.ts`,
//! `surveillance-case.ts`) and which orders a mass cancel or a dead session pulls (`mass-cancel.ts`, `session.ts`).
//! Each refuses rather than invents: a missing value is never read as zero.

use service_kit::money::{Amount, Rounding, js_trim, mul_rounded};

use super::types::{EngineOrder, Opt, Reject, Side, SurveillanceCase};

// ── all-or-none ─────────────────────────────────────────────────────────

/// `readAon`: `aon === true`.
pub fn read_aon(aon: &Opt<bool>) -> bool {
    aon.get() == Some(true)
}

/// `aonIcebergRefuse`.
pub fn aon_iceberg_refuse(aon: bool, iceberg: bool) -> Option<Reject> {
    (aon && iceberg).then(|| {
        Reject::new(
            "aon_iceberg",
            "all-or-none cannot hide a stub behind a display; the engine does not invent a fill",
        )
    })
}

/// `clipMeetsAon`.
pub fn clip_meets_aon(clip: Amount, remaining: Amount, aon: bool) -> bool {
    !aon || clip >= remaining
}

/// `canFillAon`.
pub fn can_fill_aon(fillable: Amount, qty: Amount, aon: bool) -> bool {
    !aon || fillable >= qty
}

// ── minimum fill size ───────────────────────────────────────────────────

/// `readMinQty`: missing, null or not positive is not set.
pub fn read_min_qty(min_qty: &Opt<Amount>) -> Option<Amount> {
    min_qty.get().filter(|m| *m > Amount::ZERO)
}

/// `minQtyRefuse`.
pub fn min_qty_refuse(qty: Amount, min_qty: Option<Amount>) -> Option<Reject> {
    match min_qty {
        Some(m) if m > qty => Some(Reject::new(
            "min_qty_exceeds_qty",
            "minQty must not exceed remaining qty; the engine does not invent a fill",
        )),
        _ => None,
    }
}

/// `clipMeetsMinQty`.
pub fn clip_meets_min_qty(clip: Amount, remaining_after: Amount, min_qty: Option<Amount>) -> bool {
    match min_qty {
        Some(m) if m > Amount::ZERO => {
            clip >= m && !(remaining_after > Amount::ZERO && remaining_after < m)
        }
        _ => clip > Amount::ZERO,
    }
}

/// `bothSidesMeetMinQty`.
pub fn both_sides_meet_min_qty(
    clip: Amount,
    taker_after: Amount,
    taker_min: Option<Amount>,
    maker_after: Amount,
    maker_min: Option<Amount>,
) -> bool {
    clip_meets_min_qty(clip, taker_after, taker_min)
        && clip_meets_min_qty(clip, maker_after, maker_min)
}

// ── icebergs ────────────────────────────────────────────────────────────

/// `icebergDisplayRefuse`.
pub fn iceberg_display_refuse(qty: Amount, display: Option<Amount>) -> Option<Reject> {
    match display {
        None => Some(display_missing()),
        Some(d) if d <= Amount::ZERO => Some(display_missing()),
        Some(d) if d >= qty => Some(Reject::new(
            "iceberg_display_not_smaller",
            "iceberg display must be smaller than total; the engine does not invent a display",
        )),
        Some(_) => None,
    }
}

fn display_missing() -> Reject {
    Reject::new(
        "iceberg_display_missing",
        "iceberg requires a display qty; the engine does not invent a display",
    )
}

/// `visibleRemaining`.
pub fn visible_remaining(remaining: Amount, display_remaining: Option<Amount>) -> Amount {
    display_remaining.map_or(remaining, |d| d.min(remaining))
}

/// `refillDisplay`.
pub fn refill_display(peak: Amount, remaining: Amount) -> Amount {
    peak.min(remaining)
}

/// `wantsIceberg`: `iceberg === true || displayQty !== undefined`.
pub fn wants_iceberg(order: &EngineOrder) -> bool {
    order.iceberg || order.display_qty.present()
}

// ── pegs ────────────────────────────────────────────────────────────────

fn read_reference(order: &EngineOrder) -> Option<Amount> {
    order.reference.get().filter(|r| *r > Amount::ZERO)
}

/// `pegIntentRefuse`.
pub fn peg_intent_refuse(order: &EngineOrder) -> Option<Reject> {
    if order.midpoint.get() == Some(true) {
        return Some(Reject::new(
            "midpoint_unsupported",
            "midpoint orders are unsupported; the engine does not invent a mid",
        ));
    }
    if order.peg.get() != Some(true) && order.relative.get() != Some(true) {
        return None;
    }
    if read_reference(order).is_none() {
        return Some(Reject::new(
            "missing_reference",
            "peg/relative requires a reference; the engine does not invent a mid",
        ));
    }
    if order.offset.get().is_none() {
        return Some(Reject::new(
            "missing_offset",
            "peg/relative requires an offset; the engine does not invent a mid",
        ));
    }
    None
}

/// `bindPegRelative`: a peg or relative order with both terms becomes a limit at reference plus offset.
pub fn bind_peg_relative(order: &EngineOrder) -> EngineOrder {
    if order.peg.get() != Some(true) && order.relative.get() != Some(true) {
        return order.clone();
    }
    match (read_reference(order), order.offset.get()) {
        (Some(reference), Some(offset)) => EngineOrder {
            order_type: super::types::OrderType::Limit,
            price: Some(reference.saturating_add(offset)),
            stop_price: None,
            ..order.clone()
        },
        _ => order.clone(),
    }
}

// ── auctions, collars, notional ─────────────────────────────────────────

/// `auctionIntentRefuse`.
pub fn auction_intent_refuse(order: &EngineOrder) -> Option<Reject> {
    if order.auction.get() == Some(true) {
        return Some(Reject::new(
            "auction_unsupported",
            "auction orders are unsupported; the engine does not invent an auction price",
        ));
    }
    if order.benchmark.get() == Some(true) {
        return Some(Reject::new(
            "benchmark_unsupported",
            "benchmark orders are unsupported; the engine does not invent a benchmark price",
        ));
    }
    None
}

/// `collarIntentRefuse`: a requested collar needs both caller bounds, and the price inside them.
pub fn collar_intent_refuse(order: &EngineOrder) -> Option<Reject> {
    if order.collar.get() != Some(true) {
        return None;
    }
    let min = order.min.get().filter(|m| *m > Amount::ZERO);
    let max = order.max.get().filter(|m| *m > Amount::ZERO);
    let (Some(min), Some(max)) = (min, max) else {
        return Some(Reject::new(
            "missing_collar",
            "collar requires caller min and max; the engine does not invent last or mid",
        ));
    };
    match order.price {
        Some(p) if p >= min && p <= max => None,
        _ => Some(Reject::new(
            "outside_collar",
            "submit price is outside the caller collar; the engine does not invent last or mid",
        )),
    }
}

/// `minNotionalIntentRefuse`: the caller's price times qty, floored, against the caller's floor.
pub fn min_notional_intent_refuse(order: &EngineOrder) -> Option<Reject> {
    let floor = order.min_notional.get().filter(|m| *m > Amount::ZERO)?;
    let notional = match order.price {
        Some(p) if p > Amount::ZERO && order.qty > Amount::ZERO => {
            mul_rounded(order.qty, p, Rounding::Floor)
        }
        _ => {
            return Some(Reject::new(
                "missing_notional",
                "minNotional requires a caller notional; the engine does not invent last",
            ));
        }
    };
    (notional < floor).then(|| {
        Reject::new(
            "below_min_notional",
            "submit notional is below caller minNotional; the engine does not invent last",
        )
    })
}

// ── self-trade prevention ───────────────────────────────────────────────

/// `stpIdentityPresent`: an account id that is not blank after a trim.
pub fn stp_identity_present(account_id: &str) -> bool {
    !js_trim(account_id).is_empty()
}

/// `stpIdentityRefuse`.
pub fn stp_identity_refuse(account_id: &str) -> Option<Reject> {
    (!stp_identity_present(account_id)).then(|| {
        Reject::new(
            "self_trade",
            "STP identity missing; the engine does not invent a group",
        )
    })
}

/// `isSelfTrade`.
pub fn is_self_trade(taker: &str, maker: &str) -> bool {
    stp_identity_present(taker) && stp_identity_present(maker) && taker == maker
}

/// `selfTradeSurveillanceCase` (`openSurveillanceCase` with reason `self_trade`): the trimmed account and market, or
/// nothing when either is blank.
pub fn self_trade_case(account_id: &str, market_id: &str) -> Option<SurveillanceCase> {
    let account = js_trim(account_id);
    let market = js_trim(market_id);
    if account.is_empty() || market.is_empty() {
        return None;
    }
    Some(SurveillanceCase {
        account_id: account.to_owned(),
        market_id: market.to_owned(),
        reason: "self_trade".to_owned(),
    })
}

// ── mass cancel and sessions ────────────────────────────────────────────

/// `readSessionId`: a session id that is not blank after a trim, trimmed.
pub fn read_session_id(raw: Option<&str>) -> Option<String> {
    raw.map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `massCancelSessionRefuse`.
pub fn mass_cancel_session_refuse(session_id: Option<&str>) -> Option<Reject> {
    session_id.map(|_| {
        Reject::new(
            "session_unsupported",
            "session mass-cancel is unsupported; the engine does not invent a session",
        )
    })
}

/// `missingSessionRefuse`.
pub fn missing_session_refuse() -> Reject {
    Reject::new(
        "missing_session",
        "session identity is required; the engine does not invent a session",
    )
}

/// One live order a mass cancel may pull.
pub struct LiveOwned<'a> {
    pub order_id: &'a str,
    pub account_id: &'a str,
    pub sequence: u64,
    pub side: Side,
}

/// `ownedOrderIds`: this account's live orders (on one side when given), oldest first.
pub fn owned_order_ids(
    account_id: &str,
    live: &[LiveOwned<'_>],
    side: Option<Side>,
) -> Vec<String> {
    if account_id.is_empty() {
        return Vec::new();
    }
    let mut rows: Vec<&LiveOwned<'_>> = live
        .iter()
        .filter(|r| r.account_id == account_id && side.is_none_or(|s| r.side == s))
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.iter().map(|r| r.order_id.to_owned()).collect()
}

/// One live order a dead session may pull.
pub struct LiveSession<'a> {
    pub order_id: &'a str,
    pub session_id: Option<&'a str>,
    pub sequence: u64,
}

/// `sessionOrderIds`: the orders tagged with this session, oldest first.
pub fn session_order_ids(session_id: &str, live: &[LiveSession<'_>]) -> Vec<String> {
    if session_id.is_empty() {
        return Vec::new();
    }
    let mut rows: Vec<&LiveSession<'_>> = live
        .iter()
        .filter(|r| r.session_id == Some(session_id))
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.iter().map(|r| r.order_id.to_owned()).collect()
}
