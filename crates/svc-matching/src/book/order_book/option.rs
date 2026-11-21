//! Options through matching (`option.ts`). An option rests as a limit on the public book and is taken only by an
//! option with the same strike and expiry. A plain, stop or market order that would print a resting option refuses
//! before the book moves; a stop that would do so when it fires refuses at activation. A long option exercises at its
//! strike, assigning the earliest short fill first under that fill's order id; a short assigned that way covers. A
//! resting option leaves the book at its expiry, and one already due on arrival expires before it prints.
//!
//! The engine never invents a strike, an expiry or a mark: each missing one refuses with its own code.
//!
//! What the TypeScript keeps in a `WeakMap` beside each book is the book's own [`OptionState`] here. Like the
//! TypeScript's, it is not part of the book's durable state: a copy made from that state has none.

use service_kit::money::{Amount, format_amount};
use service_kit::time::v8_date_parse;

use super::{OrderBook, due};
use crate::book::rules::{bind_peg_relative, is_self_trade, peg_intent_refuse};
use crate::book::types::{
    AmendResult, CancelReason, CancelledRef, EngineAmend, EngineOrder, Fill, Opt, OrderType,
    Reject, RestKind, Side, SubmitResult,
};
use crate::journal::replay::js_sort_cmp;

pub const STRIKE_MISSING: &str = "missing_strike";
pub const EXPIRY_MISSING: &str = "missing_expiry";
pub const PRICE_MISSING: &str = "missing_price";
pub const STRIKE_DISAGREES: &str = "strike_disagrees";
pub const EXPIRY_DISAGREES: &str = "expiry_disagrees";

/// One signed lot of an account's option position, under the fill's order id that opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Lot {
    qty: Amount,
    order_id: String,
    sequence: u64,
}

/// Each account's lots on one contract, in the order the accounts first traded it (a JavaScript `Map`).
type Lots = Vec<(String, Vec<Lot>)>;

/// Each contract (`strike|expiry`) and its accounts' lots.
type Contracts = Vec<(String, Lots)>;

/// A book's option rows: each resting option's strike and expiry, the open positions, and the assigned shorts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OptionState {
    rest: Vec<(String, (Amount, String))>,
    open: Contracts,
    assigned: Contracts,
}

impl OptionState {
    fn rest_of(&self, order_id: &str) -> Option<&(Amount, String)> {
        self.rest
            .iter()
            .find(|(id, _)| id == order_id)
            .map(|(_, r)| r)
    }

    fn forget(&mut self, order_id: &str) {
        self.rest.retain(|(id, _)| id != order_id);
    }

    fn remember(&mut self, order_id: &str, strike: Amount, expiry: &str) {
        match self.rest.iter_mut().find(|(id, _)| id == order_id) {
            Some((_, r)) => *r = (strike, expiry.to_owned()),
            None => self
                .rest
                .push((order_id.to_owned(), (strike, expiry.to_owned()))),
        }
    }
}

fn lots_of<'a>(contracts: &'a Contracts, key: &str) -> Option<&'a Lots> {
    contracts.iter().find(|(k, _)| k == key).map(|(_, l)| l)
}

fn account_lots<'a>(lots: Option<&'a Lots>, account: &str) -> Option<&'a [Lot]> {
    lots?
        .iter()
        .find(|(a, _)| a == account)
        .map(|(_, l)| l.as_slice())
}

fn contract_key(strike: Amount, expiry: &str) -> String {
    format!("{}|{expiry}", format_amount(strike))
}

/// Apply one signed fill. A short open appends that fill's order id and does not rewrite an earlier short; a reduction
/// consumes the earliest lot and leaves that lot's order id on any remainder.
fn bump(
    contracts: &mut Contracts,
    key: &str,
    account: &str,
    order_id: &str,
    delta: Amount,
    sequence: u64,
) {
    if delta == 0 {
        return;
    }
    if !contracts.iter().any(|(k, _)| k == key) {
        contracts.push((key.to_owned(), Vec::new()));
    }
    let Some(lots) = contracts.iter_mut().find(|(k, _)| k == key).map(|(_, l)| l) else {
        return;
    };
    let prev: Vec<Lot> = lots
        .iter()
        .find(|(a, _)| a == account)
        .map(|(_, l)| l.clone())
        .unwrap_or_default();
    let mut next: Vec<Lot> = Vec::new();
    // The quantity left to place, and whether it opens long (+) or short (-).
    let opening_short = delta < 0;
    let mut left = delta.saturating_abs();
    for lot in prev {
        let against = if opening_short {
            lot.qty > 0
        } else {
            lot.qty < 0
        };
        if left == 0 || !against {
            next.push(lot);
            continue;
        }
        let avail = lot.qty.saturating_abs();
        if avail > left {
            let qty = if opening_short {
                lot.qty - left
            } else {
                lot.qty + left
            };
            next.push(Lot { qty, ..lot });
            left = 0;
        } else {
            left -= avail;
        }
    }
    if left > 0 {
        next.push(Lot {
            qty: if opening_short { -left } else { left },
            order_id: order_id.to_owned(),
            sequence,
        });
    }
    match lots.iter_mut().find(|(a, _)| a == account) {
        Some((_, l)) => *l = next,
        None => lots.push((account.to_owned(), next)),
    }
    lots.retain(|(_, l)| !l.is_empty());
    contracts.retain(|(_, l)| !l.is_empty());
}

fn apply_fills(contracts: &mut Contracts, fills: &[Fill], strike: Amount, expiry: &str) {
    let key = contract_key(strike, expiry);
    for fill in fills {
        let signed = if fill.taker_side == Side::Buy {
            fill.qty
        } else {
            -fill.qty
        };
        bump(
            contracts,
            &key,
            &fill.taker_account_id,
            &fill.taker_order_id,
            signed,
            fill.sequence,
        );
        bump(
            contracts,
            &key,
            &fill.maker_account_id,
            &fill.maker_order_id,
            -signed,
            fill.sequence,
        );
    }
}

/// Caller strike: null or not positive is missing, never invented from last, mid, best or mark.
fn read_strike(strike: &Opt<Amount>) -> Option<Amount> {
    strike.get().filter(|s| *s > 0)
}

/// Caller expiry: null or blank is missing, never invented.
fn read_expiry(expiry: &Opt<String>) -> Option<String> {
    expiry
        .value()
        .map(|e| service_kit::schema::js_trim(e).to_owned())
        .filter(|e| !e.is_empty())
}

fn strike_refuse() -> Reject {
    Reject::new(
        STRIKE_MISSING,
        "an option requires a strike; the engine does not invent a strike",
    )
}

fn expiry_refuse() -> Reject {
    Reject::new(
        EXPIRY_MISSING,
        "an option requires an expiry; the engine does not invent an expiry",
    )
}

/// `wantsOption`: an option names a strike or an expiry, even a null one.
pub fn wants_option(order: &EngineOrder) -> bool {
    order.strike.present() || order.expiry.present()
}

fn crosses_level(side: Side, limit: Amount, level: Amount) -> bool {
    match side {
        Side::Buy => level <= limit,
        Side::Sell => level >= limit,
    }
}

/// `dueAt`: the expiry is a date at or before now.
fn due_at(expiry: &str, now: i64) -> bool {
    v8_date_parse(expiry).is_some_and(|ms| ms <= now)
}

fn refused(code: &str, message: &str) -> SubmitResult {
    SubmitResult::refused(Reject::new(code, message))
}

fn amend_refused(order_id: &str, code: &str, message: &str) -> Box<AmendResult> {
    Box::new(AmendResult::refused(order_id, Reject::new(code, message)))
}

/// The expired rows go before the result's own cancellations.
fn with_expired(mut result: SubmitResult, expired: Vec<CancelledRef>) -> SubmitResult {
    if expired.is_empty() {
        return result;
    }
    let mut cancellations = expired;
    cancellations.append(&mut result.cancellations);
    result.cancellations = cancellations;
    result
}

/// What a non-option would match now: none when it does not enter the book, `Some(None)` for a market.
type CrossingLimit = Option<Option<Amount>>;

/// One fill a sweep would print, as far as reduce-only needs it.
struct SweepFill {
    taker: String,
    maker: String,
    taker_side: Side,
    qty: Amount,
}

/// Qty a reduce-only maker can print: a sell reduces a long, a buy a short.
fn open_qty(net: Amount, side: Side) -> Amount {
    match side {
        Side::Sell => net.max(0),
        Side::Buy => (-net).max(0),
    }
}

impl OrderBook {
    /// The option layer's submit (`installOption`'s `submit`), over the core book.
    pub(crate) fn option_submit(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        if let Some(r) = super::combo::combo_intent_refuse(order) {
            return SubmitResult::refused(r);
        }
        if order.cover {
            return self.option_cover(order, now);
        }
        if order.exercise {
            return self.option_exercise(order, now);
        }
        if order.exits.cancel {
            return self.option_cancel_order(order);
        }
        if !wants_option(order) {
            let expired = self.expire_due_options(now);
            if let Some(crossed) = self.non_option_take_refuse(order, now) {
                let mut expired = expired;
                expired.extend(self.pull_clock_due(now));
                return with_expired(SubmitResult::refused(crossed), expired);
            }
            let result = self.submit_core(order, now);
            return with_expired(result, expired);
        }
        let Some(strike) = read_strike(&order.strike) else {
            return SubmitResult::refused(strike_refuse());
        };
        let Some(expiry) = read_expiry(&order.expiry) else {
            return SubmitResult::refused(expiry_refuse());
        };
        let price = match order.price {
            Some(p) if p > 0 => p,
            _ => {
                return refused(
                    "invalid_price",
                    "an option rests as a limit; the engine does not invent a mark",
                );
            }
        };
        if let Some(n) = now
            && order.qty > 0
            && due_at(&expiry, n)
        {
            return self.expire_incoming_due(order, n);
        }
        let expired = self.expire_due_options(now);
        if let Some(d) = self.take_disagrees(order.side, price, strike, &expiry) {
            return with_expired(SubmitResult::refused(d), expired);
        }
        let mut limit = order.clone();
        limit.order_type = OrderType::Limit;
        limit.price = Some(price);
        limit.strike = Opt::Some(strike);
        limit.expiry = Opt::Some(expiry.clone());
        let result = self.submit_core(&limit, now);
        if result.accepted {
            apply_fills(&mut self.option.open, &result.fills, strike, &expiry);
            if result.resting.is_some() {
                self.option.remember(&order.order_id, strike, &expiry);
            }
        }
        with_expired(result, expired)
    }

    fn option_terms(order: &EngineOrder) -> Result<(Amount, String), Reject> {
        let strike = read_strike(&order.strike).ok_or_else(strike_refuse)?;
        let expiry = read_expiry(&order.expiry).ok_or_else(expiry_refuse)?;
        Ok((strike, expiry))
    }

    /// Cover a short option after assignment: buy it back at its strike, against its own assigned lots.
    fn option_cover(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        let (strike, expiry) = match Self::option_terms(order) {
            Ok(t) => t,
            Err(r) => return SubmitResult::refused(r),
        };
        if order.qty <= 0 {
            return refused(
                "invalid_qty",
                "an option cover requires a qty; the engine does not invent a mark",
            );
        }
        let key = contract_key(strike, &expiry);
        let clips = clip_positive(
            &order.account_id,
            account_lots(lots_of(&self.option.assigned, &key), &order.account_id),
            order.qty,
        );
        let Some(clips) = clips else {
            return refused(
                "position_flat",
                "cover is a short option after assignment; the engine does not invent a mark",
            );
        };
        let expired = self.expire_due_options(now);
        let sequence = self.next_sequence();
        let mut fills = Vec::new();
        for clip in clips {
            fills.push(Fill {
                sequence,
                maker_order_id: clip.order_id.clone(),
                maker_account_id: order.account_id.clone(),
                taker_order_id: order.order_id.clone(),
                taker_account_id: order.account_id.clone(),
                taker_side: Side::Buy,
                price: strike,
                qty: clip.qty,
                legs: None,
            });
            bump(
                &mut self.option.assigned,
                &key,
                &order.account_id,
                &clip.order_id,
                -clip.qty,
                0,
            );
        }
        with_expired(
            SubmitResult {
                accepted: true,
                sequence: Some(sequence),
                fills,
                ..SubmitResult::default()
            },
            expired,
        )
    }

    /// Exercise a long option at its strike, assigning the earliest short fills of other accounts.
    fn option_exercise(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        let (strike, expiry) = match Self::option_terms(order) {
            Ok(t) => t,
            Err(r) => return SubmitResult::refused(r),
        };
        if order.qty <= 0 {
            return refused(
                "invalid_qty",
                "an option exercise requires a qty; the engine does not invent a mark",
            );
        }
        let key = contract_key(strike, &expiry);
        let lots = lots_of(&self.option.open, &key);
        let long: Amount = account_lots(lots, &order.account_id)
            .map_or(0, |l| l.iter().fold(0, |t, lot| t + lot.qty));
        if long <= 0 || long < order.qty {
            return refused(
                "position_flat",
                "exercise is a long option; the engine does not invent a mark",
            );
        }
        let Some(clips) = assign_shorts(lots, &order.account_id, order.qty) else {
            return refused(
                "position_flat",
                "exercise assigns a short option; the engine does not invent a mark",
            );
        };
        let expired = self.expire_due_options(now);
        let sequence = self.next_sequence();
        let mut fills = Vec::new();
        for clip in clips {
            fills.push(Fill {
                sequence,
                maker_order_id: clip.order_id.clone(),
                maker_account_id: clip.account_id.clone(),
                taker_order_id: order.order_id.clone(),
                taker_account_id: order.account_id.clone(),
                taker_side: Side::Sell,
                price: strike,
                qty: clip.qty,
                legs: None,
            });
            self.add_position(&clip.account_id, clip.qty);
            bump(
                &mut self.option.open,
                &key,
                &clip.account_id,
                &clip.order_id,
                clip.qty,
                0,
            );
            bump(
                &mut self.option.assigned,
                &key,
                &clip.account_id,
                &clip.order_id,
                clip.qty,
                0,
            );
        }
        self.add_position(&order.account_id, -order.qty);
        bump(
            &mut self.option.open,
            &key,
            &order.account_id,
            &order.order_id,
            -order.qty,
            0,
        );
        with_expired(
            SubmitResult {
                accepted: true,
                sequence: Some(sequence),
                fills,
                ..SubmitResult::default()
            },
            expired,
        )
    }

    /// Pull a resting option by its own strike and expiry.
    fn option_cancel_order(&mut self, order: &EngineOrder) -> SubmitResult {
        let (strike, expiry) = match Self::option_terms(order) {
            Ok(t) => t,
            Err(r) => return SubmitResult::refused(r),
        };
        let Some((s, e)) = self.option.rest_of(&order.order_id).cloned() else {
            return refused(
                "order_not_found",
                "cancel is a resting option; the engine does not invent a mark",
            );
        };
        if s != strike {
            return refused(
                STRIKE_DISAGREES,
                "cancel is a resting option with the same strike; the engine does not invent a mark",
            );
        }
        if e != expiry {
            return refused(
                EXPIRY_DISAGREES,
                "cancel is a resting option with the same expiry; the engine does not invent a mark",
            );
        }
        let pulled = self.cancel_core(&order.order_id, CancelReason::Requested);
        self.option.forget(&order.order_id);
        let Some(c) = pulled.cancellation else {
            return refused(
                "order_not_found",
                "cancel is a resting option; the engine does not invent a mark",
            );
        };
        SubmitResult {
            accepted: true,
            sequence: Some(c.sequence),
            cancellations: vec![c],
            ..SubmitResult::default()
        }
    }

    /// The option layer's cancel: a pulled option forgets its strike and expiry.
    pub(super) fn option_cancel(
        &mut self,
        order_id: &str,
        reason: CancelReason,
    ) -> super::CancelResult {
        let result = self.cancel_core(order_id, reason);
        if result.cancellation.is_some() {
            self.option.forget(order_id);
        }
        result
    }

    /// The option layer's amend.
    pub(crate) fn option_amend(&mut self, cmd: &EngineAmend, now: Option<i64>) -> AmendResult {
        if let Some(rec) = self.option.rest_of(&cmd.order_id).cloned() {
            let patch = match option_amend_patch(cmd, &rec) {
                Ok(p) => p,
                Err(r) => return *r,
            };
            if let Some((side, quote)) = self.resting_quote(&cmd.order_id) {
                let price = cmd.price.unwrap_or(quote);
                if price > 0
                    && let Some(d) = self.take_disagrees(side, price, rec.0, &rec.1)
                {
                    return AmendResult::refused(&cmd.order_id, d);
                }
            }
            let result = self.amend_core(&patch, now);
            if result.accepted {
                apply_fills(&mut self.option.open, &result.fills, rec.0, &rec.1);
            }
            return result;
        }
        if let Some(crossed) = self.non_option_amend_refuse(cmd, now) {
            let due = self.pull_clock_due(now);
            return AmendResult {
                cancellations: due,
                ..AmendResult::refused(&cmd.order_id, crossed)
            };
        }
        self.amend_core(cmd, now)
    }

    /// The guard a firing stop meets after its viability (`registerOptionActivationGuard`): it may not take an option.
    pub(super) fn option_activation_refuse(&self, order: &EngineOrder) -> Option<Reject> {
        self.non_option_take_refuse(order, None)
    }

    /// The live rest's side and level price; none when the id is not resting.
    fn resting_quote(&self, order_id: &str) -> Option<(Side, Amount)> {
        for side in [Side::Buy, Side::Sell] {
            for level in self.levels(side) {
                if level.orders.iter().any(|o| o.order_id == order_id) {
                    return Some((side, level.price));
                }
            }
        }
        None
    }

    /// A rest a take would print that is not an option with this strike and expiry.
    fn take_disagrees(
        &self,
        side: Side,
        price: Amount,
        strike: Amount,
        expiry: &str,
    ) -> Option<Reject> {
        let opposite = self.levels(side.opposite());
        for level in opposite {
            if !crosses_level(side, price, level.price) {
                break;
            }
            for rest in &level.orders {
                match self.option.rest_of(&rest.order_id) {
                    Some((s, _)) if *s != strike => return Some(strike_disagrees_take()),
                    None => return Some(strike_disagrees_take()),
                    Some((_, e)) if e != expiry => {
                        return Some(Reject::new(
                            EXPIRY_DISAGREES,
                            "an option takes a resting option with the same expiry; the engine does not invent a match",
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        None
    }

    /// `crossingLimit`: the limit a non-option would match at now.
    fn crossing_limit(&self, order: &EngineOrder) -> CrossingLimit {
        if order.qty <= 0 {
            return None;
        }
        match order.order_type {
            OrderType::Limit => match (order.price, order.stop_price) {
                (Some(p), None) if p > 0 => Some(Some(p)),
                _ => None,
            },
            OrderType::Market => match (order.price, order.stop_price) {
                (None, None) => Some(None),
                _ => None,
            },
            OrderType::Stop | OrderType::StopLimit => {
                let stop = order.stop_price.filter(|s| *s > 0)?;
                if order.order_type == OrderType::Stop && order.price.is_some() {
                    return None;
                }
                if order.order_type == OrderType::StopLimit && !order.price.is_some_and(|p| p > 0) {
                    return None;
                }
                let last = self.last_trade_price?;
                let fires = match order.side {
                    Side::Buy => last >= stop,
                    Side::Sell => last <= stop,
                };
                if !fires {
                    return None;
                }
                Some(if order.order_type == OrderType::Stop {
                    None
                } else {
                    order.price
                })
            }
        }
    }

    /// True when this non-option would print a resting option. Only what the sweep would print counts as in front:
    /// an OCO sibling pulled before it is reached prints nothing, a reduce-only maker prints its clip, a rest already
    /// due on this clock prints nothing, and a self-trade of the option refuses so the option stays.
    fn would_take_resting_option(
        &self,
        order: &EngineOrder,
        limit: Option<Amount>,
        now: Option<i64>,
    ) -> bool {
        if self.option.rest.is_empty() {
            return false;
        }
        let maker_side = order.side.opposite();
        let mut need = order.qty;
        let mut pulled: Vec<String> = Vec::new();
        let mut sweep: Vec<SweepFill> = Vec::new();
        for level in self.levels(maker_side) {
            if need <= 0 {
                return false;
            }
            if let Some(l) = limit
                && !crosses_level(order.side, l, level.price)
            {
                break;
            }
            for rest in &level.orders {
                if need <= 0 {
                    return false;
                }
                if pulled.contains(&rest.order_id) {
                    continue;
                }
                if now.is_some_and(|n| due(rest.expire_at.as_ref(), n)) {
                    continue;
                }
                let visible = rest.display_remaining.unwrap_or(rest.remaining);
                if visible <= 0 {
                    continue;
                }
                let is_option = self.option.rest_of(&rest.order_id).is_some();
                if is_self_trade(&order.account_id, &rest.account_id) {
                    if is_option {
                        return true;
                    }
                    continue;
                }
                let mut print = need.min(visible);
                if rest.reduce_only {
                    let net = self.net_after_sweep(&sweep, &rest.account_id);
                    let open = open_qty(net, maker_side);
                    if open <= 0 {
                        continue;
                    }
                    print = print.min(open);
                }
                if print <= 0 {
                    continue;
                }
                if is_option {
                    return true;
                }
                need = if need > print { need - print } else { 0 };
                sweep.push(SweepFill {
                    taker: order.account_id.clone(),
                    maker: rest.account_id.clone(),
                    taker_side: order.side,
                    qty: print,
                });
                if let Some(s) = rest.oco_sibling_id.as_ref().filter(|s| !s.is_empty()) {
                    pulled.push(s.clone());
                }
                if let Some(s) = order.oco_sibling_id.as_ref().filter(|s| !s.is_empty()) {
                    pulled.push(s.clone());
                }
            }
        }
        false
    }

    /// The account's fill net after the fills this sweep already counted.
    fn net_after_sweep(&self, sweep: &[SweepFill], account: &str) -> Amount {
        let mut net = self.positions.get(account).copied().unwrap_or(0);
        for f in sweep {
            let signed = if f.taker_side == Side::Buy {
                f.qty
            } else {
                -f.qty
            };
            if f.taker == account {
                net += signed;
            }
            if f.maker == account {
                net -= signed;
            }
        }
        net
    }

    fn non_option_take_refuse(&self, order: &EngineOrder, now: Option<i64>) -> Option<Reject> {
        if peg_intent_refuse(order).is_some() {
            return None;
        }
        let bound = bind_peg_relative(order);
        let limit = self.crossing_limit(&bound)?;
        if !self.would_take_resting_option(&bound, limit, now) {
            return None;
        }
        Some(Reject::new(
            STRIKE_DISAGREES,
            "a non-option order cannot take a resting option; the engine does not invent a strike",
        ))
    }

    /// A plain amend that would reprice into a resting option.
    fn non_option_amend_refuse(&self, cmd: &EngineAmend, now: Option<i64>) -> Option<Reject> {
        let target = self.amend_target(&cmd.order_id)?;
        if target.kind != RestKind::Book {
            return None;
        }
        let target_price = target.price?;
        let found = self
            .levels(target.side)
            .iter()
            .flat_map(|l| l.orders.iter())
            .find(|o| o.order_id == cmd.order_id)?;
        if now.is_some_and(|n| due(found.expire_at.as_ref(), n)) {
            return None;
        }
        let mut order = EngineOrder::new(
            cmd.order_id.clone(),
            found.account_id.clone(),
            OrderType::Limit,
            target.side,
            cmd.qty.unwrap_or(found.remaining),
            Some(cmd.price.unwrap_or(target_price)),
            cmd.tif.unwrap_or(target.inherited_tif),
        );
        order.oco_sibling_id = found.oco_sibling_id.clone().filter(|s| !s.is_empty());
        order.reduce_only = found.reduce_only;
        if let Some(m) = found.min_qty {
            order.min_qty = Opt::Some(m);
        }
        if found.aon {
            order.aon = Opt::Some(true);
        }
        self.non_option_take_refuse(&order, now)
    }

    /// Pull the rests and stops this sweep would expire first. The option they sat in front of stays.
    fn pull_clock_due(&mut self, now: Option<i64>) -> Vec<CancelledRef> {
        let Some(n) = now else {
            return Vec::new();
        };
        let mut ids: Vec<String> = self
            .bids
            .iter()
            .chain(self.asks.iter())
            .flat_map(|l| l.orders.iter())
            .filter(|o| due(o.expire_at.as_ref(), n))
            .map(|o| o.order_id.clone())
            .collect();
        ids.extend(
            self.stops
                .iter()
                .filter(|s| due(s.expire_at.as_ref(), n))
                .map(|s| s.order_id.clone()),
        );
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids.iter()
            .filter_map(|id| self.cancel(id, CancelReason::Expired).cancellation)
            .collect()
    }

    /// Pull the resting options whose expiry has come. Their remainder leaves the book.
    fn expire_due_options(&mut self, now: Option<i64>) -> Vec<CancelledRef> {
        let Some(n) = now else {
            return Vec::new();
        };
        let mut ids: Vec<String> = self
            .option
            .rest
            .iter()
            .filter(|(_, (_, e))| due_at(e, n))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        let mut out = Vec::new();
        for id in ids {
            if let Some(c) = self.cancel(&id, CancelReason::Expired).cancellation {
                out.push(c);
                self.option.forget(&id);
            }
        }
        out
    }

    /// An option already due on arrival: pull the other due rests, then expire it before it prints.
    fn expire_incoming_due(&mut self, order: &EngineOrder, now: i64) -> SubmitResult {
        let mut cancellations = self.expire_due_options(Some(now));
        cancellations.extend(self.pull_clock_due(Some(now)));
        let sequence = self.next_sequence();
        self.accepted_ids.insert(order.order_id.clone());
        cancellations.push(CancelledRef {
            order_id: order.order_id.clone(),
            account_id: order.account_id.clone(),
            remaining_qty: order.qty,
            sequence,
            reason: CancelReason::Expired,
        });
        SubmitResult {
            accepted: true,
            sequence: Some(sequence),
            cancellations,
            ..SubmitResult::default()
        }
    }

    /// Whether this book holds a resting option under this id.
    pub fn option_rest_seen(&self, order_id: &str) -> bool {
        self.option.rest_of(order_id).is_some()
    }

    /// The account's net option position on one contract, from its lots.
    pub fn option_position(&self, account_id: &str, strike: Amount, expiry: &str) -> Amount {
        account_lots(
            lots_of(&self.option.open, &contract_key(strike, expiry)),
            account_id,
        )
        .map_or(0, |l| l.iter().fold(0, |t, lot| t + lot.qty))
    }
}

fn strike_disagrees_take() -> Reject {
    Reject::new(
        STRIKE_DISAGREES,
        "an option takes a resting option with the same strike; the engine does not invent a match",
    )
}

/// `optionAmendDecision` for an order this book holds as an option: the patch to apply, or the refusal.
fn option_amend_patch(
    cmd: &EngineAmend,
    rec: &(Amount, String),
) -> Result<EngineAmend, Box<AmendResult>> {
    let id = cmd.order_id.as_str();
    let Some(strike) = read_strike(&cmd.strike) else {
        let r = strike_refuse();
        return Err(amend_refused(id, &r.code, &r.message));
    };
    let Some(expiry) = read_expiry(&cmd.expiry) else {
        let r = expiry_refuse();
        return Err(amend_refused(id, &r.code, &r.message));
    };
    if cmd.price.is_some_and(|p| p <= 0) {
        return Err(amend_refused(
            id,
            PRICE_MISSING,
            "an option amend requires a price; the engine does not invent a mark",
        ));
    }
    let qty_bad = match (cmd.price, cmd.qty) {
        (None, None) => true,
        (_, Some(q)) => q <= 0,
        (Some(_), None) => false,
    };
    if qty_bad {
        return Err(amend_refused(
            id,
            "invalid_qty",
            "an option amend requires a qty; the engine does not invent a mark",
        ));
    }
    if rec.0 != strike {
        return Err(amend_refused(
            id,
            STRIKE_DISAGREES,
            "amend is a resting option with the same strike; the engine does not invent a mark",
        ));
    }
    if rec.1 != expiry {
        return Err(amend_refused(
            id,
            EXPIRY_DISAGREES,
            "amend is a resting option with the same expiry; the engine does not invent a mark",
        ));
    }
    Ok(EngineAmend {
        order_id: cmd.order_id.clone(),
        expected_version: cmd.expected_version,
        qty: cmd.qty,
        price: cmd.price,
        stop_price: None,
        tif: cmd.tif,
        expire_at: cmd.expire_at.clone(),
        strike: Opt::Absent,
        expiry: Opt::Absent,
    })
}

/// One assignment or cover clip: whose lot, under which order id, and how much.
struct Clip {
    account_id: String,
    order_id: String,
    qty: Amount,
}

/// Positive lots, earliest first; none when there is not enough, never an invented order id.
fn clip_positive(account: &str, lots: Option<&[Lot]>, qty: Amount) -> Option<Vec<Clip>> {
    let lots = lots?;
    if qty <= 0 {
        return None;
    }
    let mut need = qty;
    let mut clips = Vec::new();
    for lot in lots.iter().filter(|l| l.qty > 0) {
        let clip = lot.qty.min(need);
        clips.push(Clip {
            account_id: account.to_owned(),
            order_id: lot.order_id.clone(),
            qty: clip,
        });
        need -= clip;
        if need == 0 {
            return Some(clips);
        }
    }
    None
}

/// Earliest short fill first, each clip under that fill's order id; none when there is not enough short.
fn assign_shorts(lots: Option<&Lots>, holder: &str, qty: Amount) -> Option<Vec<Clip>> {
    let lots = lots?;
    if qty <= 0 {
        return None;
    }
    let mut shorts: Vec<(&str, &Lot)> = lots
        .iter()
        .filter(|(a, _)| a != holder)
        .flat_map(|(a, l)| {
            l.iter()
                .filter(|lot| lot.qty < 0)
                .map(move |lot| (a.as_str(), lot))
        })
        .collect();
    shorts.sort_by_key(|(_, lot)| lot.sequence);
    let mut need = qty;
    let mut clips = Vec::new();
    for (account, lot) in shorts {
        let clip = (-lot.qty).min(need);
        clips.push(Clip {
            account_id: account.to_owned(),
            order_id: lot.order_id.clone(),
            qty: clip,
        });
        need -= clip;
        if need == 0 {
            return Some(clips);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reduction_consumes_the_earliest_lot_and_a_flip_opens_under_the_new_id() {
        let mut c: Contracts = Vec::new();
        bump(&mut c, "k", "a", "o1", -5, 1);
        bump(&mut c, "k", "a", "o2", -3, 2);
        bump(&mut c, "k", "a", "o3", 6, 3);
        let lots = account_lots(lots_of(&c, "k"), "a").unwrap();
        assert_eq!(lots.len(), 1);
        assert_eq!((lots[0].qty, lots[0].order_id.as_str()), (-2, "o2"));
        bump(&mut c, "k", "a", "o4", 5, 4);
        let lots = account_lots(lots_of(&c, "k"), "a").unwrap();
        assert_eq!((lots[0].qty, lots[0].order_id.as_str()), (3, "o4"));
        bump(&mut c, "k", "a", "o5", -3, 5);
        assert!(lots_of(&c, "k").is_none());
    }
}
