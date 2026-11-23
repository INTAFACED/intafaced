//! The order book (`book.ts`): price-time priority, limit, market and stop orders, post-only, maker-or-cancel, IOC and
//! FOK, self-trade prevention, reduce-only, minimum fill size, all-or-none and icebergs, the stop book and its triggers.
//!
//! Pure, as the TypeScript is: no I/O, no clock (time comes in from the journal), no randomness, and nothing that walks
//! an unordered collection where the order reaches the output. Replaying the same inputs gives the same book byte for
//! byte. Every price and quantity is an [`Amount`]; the only plain number is the sequence.
//!
//! Where the TypeScript walks its `index` map in insertion order (the reduce-only sweeps, the expiry sweep), this walks
//! the same order: each resting order keeps the position it was put in at.

use std::collections::{HashMap, HashSet};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::v8_date_parse;

use super::rules::{
    LiveOwned, LiveSession, aon_iceberg_refuse, auction_intent_refuse, bind_peg_relative,
    both_sides_meet_min_qty, can_fill_aon, clip_meets_aon, collar_intent_refuse,
    iceberg_display_refuse, is_self_trade, min_notional_intent_refuse, min_qty_refuse,
    owned_order_ids, peg_intent_refuse, read_aon, read_min_qty, read_session_id, refill_display,
    self_trade_case, session_order_ids, stp_identity_present, stp_identity_refuse,
    visible_remaining, wants_iceberg,
};
use super::types::{
    AmendResult, CancelReason, CancelResult, CancelledRef, EngineAmend, EngineOrder, Fill, Opt,
    OrderType, Priority, Reject, RestKind, RestingRef, Side, SubmitResult, SurveillanceCase, Tif,
    TriggerBy, TriggerFact, TriggerOutcome, TriggerRole, seq_json,
};
use crate::journal::replay::js_sort_cmp;

mod combo;
mod option;
mod spread_book;

pub use combo::{ComboRest, ComboRestLeg, combo_identity, combo_intent_refuse, wants_combo};
pub use option::wants_option;
pub use spread_book::{outright_on_spread_refuse, spread_amend_refuse, spread_order_refuse};

#[derive(Debug, Clone, PartialEq, Eq)]
struct RestingOrder {
    order_id: String,
    account_id: String,
    side: Side,
    price: Amount,
    remaining: Amount,
    /// Acceptance sequence: the "time" in price-time priority.
    sequence: u64,
    /// Instruction version: bumps on amend; the queue sequence need not.
    version: u64,
    oco_sibling_id: Option<String>,
    expire_at: Option<String>,
    session_id: Option<String>,
    reduce_only: bool,
    /// A resting post-only order: a later amend must not take.
    post_only: bool,
    display_peak: Option<Amount>,
    display_remaining: Option<Amount>,
    min_qty: Option<Amount>,
    aon: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PriceLevel {
    price: Amount,
    /// FIFO: the first is the oldest at this price and fills first.
    orders: Vec<RestingOrder>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StopOrder {
    order_id: String,
    account_id: String,
    /// `stop` or `stop_limit`.
    order_type: OrderType,
    side: Side,
    qty: Amount,
    price: Option<Amount>,
    stop_price: Amount,
    tif: Tif,
    sequence: u64,
    version: u64,
    oco_sibling_id: Option<String>,
    expire_at: Option<String>,
    session_id: Option<String>,
    reduce_only: bool,
    trigger_by: TriggerBy,
    trigger_role: TriggerRole,
    min_qty: Option<Amount>,
    aon: bool,
    /// Trail distance; none when the stop does not walk.
    trail: Option<Amount>,
    /// The extreme the trail follows; none when the stop does not walk.
    peak: Option<Amount>,
}

/// What a matched order is, whatever it arrived as.
#[derive(Debug, Clone)]
struct Effective {
    order_id: String,
    account_id: String,
    side: Side,
    qty: Amount,
    price: Option<Amount>,
    tif: Tif,
    oco_sibling_id: Option<String>,
    expire_at: Option<String>,
    session_id: Option<String>,
    reduce_only: bool,
    display_qty: Option<Amount>,
    min_qty: Option<Amount>,
    aon: bool,
}

/// An order whose OCO link a pull may read before the book holds it (`{ orderId, ocoSiblingId, type }`).
#[derive(Debug, Clone, Copy)]
struct Incoming<'a> {
    order_id: &'a str,
    oco_sibling_id: Option<&'a str>,
    stop_limit: bool,
}

/// The print that just happened: cleared once the stops drained. `id` tells two prints at the same prices apart, as
/// the TypeScript's object identity does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LastMove {
    previous: Option<Amount>,
    next: Amount,
    id: u64,
}

/// Where a resting order sits, and when it was put there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Slot {
    side: Side,
    price: Amount,
    put: u64,
}

struct Matched {
    fills: Vec<Fill>,
    remaining: Amount,
    cancellations: Vec<CancelledRef>,
    surveillance: Vec<SurveillanceCase>,
}

struct Executed {
    fills: Vec<Fill>,
    resting: Option<RestingRef>,
    cancellations: Vec<CancelledRef>,
    surveillance: Vec<SurveillanceCase>,
}

/// A reduce-only row on one side of one account.
struct ReduceRow {
    order_id: String,
    qty: Amount,
    price: Option<Amount>,
    sequence: u64,
    kind: RestKind,
}

/// What an amend would patch (`amendTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmendTarget {
    pub kind: RestKind,
    pub side: Side,
    pub price: Option<Amount>,
    pub stop_price: Option<Amount>,
    pub inherited_tif: Tif,
}

/// One order live on the book, as the engine lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveOrder {
    pub order_id: String,
    pub account_id: String,
    pub kind: RestKind,
    pub side: Side,
    /// The limit for a resting order, the trigger for a stop.
    pub price: Amount,
    pub remaining: Amount,
    pub sequence: u64,
    pub version: u64,
    /// The limit a hold was sized at: the level for a rest, the stop's limit (none for a market stop).
    pub funding_price: Option<Amount>,
}

/// A live trailing stop, as [`OrderBook::trailing_stops`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrailingStop {
    pub order_id: String,
    pub side: Side,
    pub trail: Amount,
    pub peak: Amount,
    pub stop_price: Amount,
    pub version: u64,
}

/// One level of the queue: its price and each order's id, remaining and sequence, in queue order.
pub type QueueLevel = (Amount, Vec<QueueOrder>);

/// One order in a queue level: its id, remaining and sequence.
pub type QueueOrder = (String, Amount, u64);

/// L2: each level's price and visible size, best first.
pub type Ladder = Vec<(Amount, Amount)>;

fn add(a: Amount, b: Amount) -> Amount {
    a.saturating_add(b)
}

fn sub(a: Amount, b: Amount) -> Amount {
    a.saturating_sub(b)
}

/// `!!value` for an optional id: an empty string is no link.
fn link(v: Option<&String>) -> Option<&str> {
    v.map(String::as_str).filter(|s| !s.is_empty())
}

fn read_trigger_by(order: &EngineOrder) -> TriggerBy {
    order.trigger_by.unwrap_or(TriggerBy::Last)
}

fn read_trigger_role(order: &EngineOrder) -> TriggerRole {
    order.trigger_role.unwrap_or(TriggerRole::Legacy)
}

#[derive(Debug, Clone, Copy)]
struct StopView {
    side: Side,
    stop_price: Amount,
    trigger_by: TriggerBy,
    trigger_role: TriggerRole,
}

fn stop_view(order: &EngineOrder) -> StopView {
    StopView {
        side: order.side,
        stop_price: order.stop_price.unwrap_or(Amount::ZERO),
        trigger_by: read_trigger_by(order),
        trigger_role: read_trigger_role(order),
    }
}

impl StopOrder {
    fn view(&self) -> StopView {
        StopView {
            side: self.side,
            stop_price: self.stop_price,
            trigger_by: self.trigger_by,
            trigger_role: self.trigger_role,
        }
    }

    fn resting_ref(&self) -> RestingRef {
        RestingRef {
            kind: RestKind::Stop,
            order_id: self.order_id.clone(),
            account_id: self.account_id.clone(),
            side: self.side,
            price: self.stop_price,
            remaining: self.qty,
            sequence: self.sequence,
            version: self.version,
        }
    }
}

impl RestingOrder {
    fn resting_ref(&self) -> RestingRef {
        RestingRef {
            kind: RestKind::Book,
            order_id: self.order_id.clone(),
            account_id: self.account_id.clone(),
            side: self.side,
            price: self.price,
            remaining: self.remaining,
            sequence: self.sequence,
            version: self.version,
        }
    }
}

/// The price a reduce-only arrival ranks at: a stop or a market has none, and outranks no row.
fn incoming_price(order: &EngineOrder) -> Option<Amount> {
    if order.order_type.is_stop() {
        None
    } else {
        order.price
    }
}

fn more_aggressive(side: Side, next: Option<Amount>, prior: Option<Amount>) -> bool {
    match (next, prior) {
        (Some(n), Some(p)) => match side {
            Side::Sell => n < p,
            Side::Buy => n > p,
        },
        _ => false,
    }
}

/// `compareLeastAggressive`, as a sort order.
fn least_aggressive(side: Side, a: &ReduceRow, b: &ReduceRow) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let by_seq = b.sequence.cmp(&a.sequence);
    match (a.price, b.price) {
        (None, None) => by_seq,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) if x == y => by_seq,
        (Some(x), Some(y)) => {
            let first = match side {
                Side::Sell => x > y,
                Side::Buy => x < y,
            };
            if first {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
    }
}

fn moved_through(
    side: Side,
    stop: Amount,
    role: TriggerRole,
    previous: Option<Amount>,
    next: Option<Amount>,
) -> bool {
    let Some(next) = next else { return false };
    if role == TriggerRole::Legacy {
        return match side {
            Side::Buy => next >= stop,
            Side::Sell => next <= stop,
        };
    }
    let take_profit = role == TriggerRole::TakeProfit;
    let Some(previous) = previous else {
        return match (side, take_profit) {
            (Side::Sell, true) => next >= stop,
            (Side::Sell, false) => next <= stop,
            (Side::Buy, true) => next <= stop,
            (Side::Buy, false) => next >= stop,
        };
    };
    if next == previous {
        return false;
    }
    let rising = next > previous;
    let falling = next < previous;
    match (side, take_profit) {
        (Side::Sell, true) => rising && previous <= stop && next >= stop,
        (Side::Sell, false) => falling && previous >= stop && next <= stop,
        (Side::Buy, true) => falling && previous >= stop && next <= stop,
        (Side::Buy, false) => rising && previous <= stop && next >= stop,
    }
}

/// Both or neither: a missing or non-positive trail or mark is not a walk.
fn trail_peak(trail: Option<Amount>, mark: Option<Amount>) -> (Option<Amount>, Option<Amount>) {
    match (
        trail.filter(|t| *t > Amount::ZERO),
        mark.filter(|m| *m > Amount::ZERO),
    ) {
        (Some(t), Some(p)) => (Some(t), Some(p)),
        _ => (None, None),
    }
}

fn crosses_level(side: Side, limit: Amount, level: Amount) -> bool {
    match side {
        Side::Buy => level <= limit,
        Side::Sell => level >= limit,
    }
}

/// Binary search of a side's levels (bids descending, asks ascending): where `price` is, or where it would go.
fn locate(levels: &[PriceLevel], price: Amount, descending: bool) -> (usize, bool) {
    let (mut lo, mut hi) = (0usize, levels.len());
    while lo < hi {
        let mid = usize::midpoint(lo, hi);
        let Some(p) = levels.get(mid).map(|l| l.price) else {
            break;
        };
        if p == price {
            return (mid, true);
        }
        if if descending { p > price } else { p < price } {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    (lo, false)
}

fn trigger_fact(by: TriggerBy, stop_price: Amount, reference: Amount) -> TriggerFact {
    TriggerFact {
        by,
        stop_price,
        reference,
    }
}

fn collect_surveillance(
    from_match: Vec<SurveillanceCase>,
    triggered: &[TriggerOutcome],
) -> Vec<SurveillanceCase> {
    let mut cases = from_match;
    for t in triggered {
        cases.extend(t.surveillance_cases.iter().cloned());
    }
    cases
}

fn to_effective(order: &EngineOrder) -> Effective {
    Effective {
        order_id: order.order_id.clone(),
        account_id: order.account_id.clone(),
        side: order.side,
        qty: order.qty,
        price: if order.order_type.needs_price() {
            order.price
        } else {
            None
        },
        tif: order.tif,
        oco_sibling_id: order.oco_sibling_id.clone(),
        expire_at: order.expire_at.clone(),
        session_id: read_session_id(order.session_id.as_deref()),
        reduce_only: order.reduce_only,
        display_qty: order.display_qty.get(),
        min_qty: read_min_qty(&order.min_qty),
        aon: read_aon(&order.aon),
    }
}

fn cancelled(
    order_id: &str,
    account_id: &str,
    qty: Amount,
    sequence: u64,
    reason: CancelReason,
) -> CancelledRef {
    CancelledRef {
        order_id: order_id.to_owned(),
        account_id: account_id.to_owned(),
        remaining_qty: qty,
        sequence,
        reason,
    }
}

fn would_increase() -> Reject {
    Reject::new(
        "would_increase_position",
        "reduce-only refuses a qty that would increase the position; the engine does not invent a mark",
    )
}

/// `activationOrder`: the order a fired stop becomes, market for a stop and limit for a stop-limit.
fn activation_order(stop: &StopOrder) -> EngineOrder {
    let limit = stop.order_type == OrderType::StopLimit;
    let mut o = EngineOrder::new(
        stop.order_id.clone(),
        stop.account_id.clone(),
        if limit {
            OrderType::Limit
        } else {
            OrderType::Market
        },
        stop.side,
        stop.qty,
        if limit { stop.price } else { None },
        stop.tif,
    );
    o.oco_sibling_id = stop.oco_sibling_id.clone();
    o.reduce_only = stop.reduce_only;
    o.min_qty = stop.min_qty.map_or(Opt::Absent, Opt::Some);
    o.aon = Opt::Some(stop.aon);
    o
}

/// `Date.parse(at) <= now`: a time that is not a date is never due.
fn due(expire_at: Option<&String>, now: i64) -> bool {
    expire_at
        .filter(|s| !s.is_empty())
        .and_then(|s| v8_date_parse(s))
        .is_some_and(|ms| ms <= now)
}

/// One market's book.
#[derive(Debug)]
pub struct OrderBook {
    market_id: String,
    sequence: u64,
    bids: Vec<PriceLevel>,
    asks: Vec<PriceLevel>,
    stops: Vec<StopOrder>,
    index: HashMap<String, Slot>,
    puts: u64,
    /// Accepted ids, filled and cancelled included: a retry must not rest or fill again.
    accepted_ids: HashSet<String>,
    oco_members: HashSet<String>,
    last_trade_price: Option<Amount>,
    /// The print before the last; none until a second print.
    previous_trade_price: Option<Amount>,
    last_move: Option<LastMove>,
    moves: u64,
    mark_price: Option<Amount>,
    index_price: Option<Amount>,
    /// An explicit futures position replaces the fill net for reduce-only; zero is kept.
    futures_positions: HashMap<String, Amount>,
    positions: HashMap<String, Amount>,
    /// Open self-trade cases: evidence only, never a fine and never closed here.
    surveillance_cases: Vec<SurveillanceCase>,
    /// The option layer's rows (`option.ts`): not part of the durable state.
    option: option::OptionState,
    /// The combo layer's resting combos (`combo-book.ts`): not part of the durable state.
    combo: combo::ComboState,
    /// The identity of the spread listing this book trades, once it took a spread order (`spread-book.ts`). Not part of
    /// the durable state: a book restored from it takes no spread order (`spread_book_outright_refused`).
    spread_mark: Option<String>,
    /// What the trigger wrappers remember beside the book and never snapshot (`bracket.ts`'s and
    /// `trailing-stop.ts`'s `WeakMap`s): a restored or rehearsal book starts without it, as the TypeScript's does.
    pub(super) triggers: super::triggers::TriggerState,
}

impl OrderBook {
    pub fn new(market_id: impl Into<String>) -> OrderBook {
        OrderBook {
            market_id: market_id.into(),
            sequence: 0,
            bids: Vec::new(),
            asks: Vec::new(),
            stops: Vec::new(),
            index: HashMap::new(),
            puts: 0,
            accepted_ids: HashSet::new(),
            oco_members: HashSet::new(),
            last_trade_price: None,
            previous_trade_price: None,
            last_move: None,
            moves: 0,
            mark_price: None,
            index_price: None,
            futures_positions: HashMap::new(),
            positions: HashMap::new(),
            surveillance_cases: Vec::new(),
            option: option::OptionState::default(),
            combo: combo::ComboState::default(),
            spread_mark: None,
            triggers: super::triggers::TriggerState::default(),
        }
    }

    pub fn market_id(&self) -> &str {
        &self.market_id
    }

    pub fn current_sequence(&self) -> u64 {
        self.sequence
    }

    pub fn last_price(&self) -> Option<Amount> {
        self.last_trade_price
    }

    pub fn open_surveillance_cases(&self) -> &[SurveillanceCase] {
        &self.surveillance_cases
    }

    /// Never printed and holds nothing: a book the engine drops.
    pub fn is_never_printed_empty(&self) -> bool {
        self.last_trade_price.is_none() && self.index.is_empty() && self.stops.is_empty()
    }

    pub fn best_bid(&self) -> Option<Amount> {
        self.bids.first().map(|l| l.price)
    }

    pub fn best_ask(&self) -> Option<Amount> {
        self.asks.first().map(|l| l.price)
    }

    /// L2 to `limit` levels a side (the caller's published window), each level's visible size.
    pub fn depth(&self, limit: usize) -> (Ladder, Ladder, u64) {
        let fold = |levels: &[PriceLevel]| -> Ladder {
            levels
                .iter()
                .take(limit)
                .map(|level| {
                    let total = level.orders.iter().fold(Amount::ZERO, |t, o| {
                        add(t, visible_remaining(o.remaining, o.display_remaining))
                    });
                    (level.price, total)
                })
                .collect()
        };
        (fold(&self.bids), fold(&self.asks), self.sequence)
    }

    /// The resting orders by level, best first: each level's price and its orders' ids, visible remaining and
    /// sequences, in queue order (`nativeL3FromEngine`'s source).
    pub fn queue(&self, side: Side) -> Vec<QueueLevel> {
        self.levels(side)
            .iter()
            .map(|level| {
                (
                    level.price,
                    level
                        .orders
                        .iter()
                        .map(|o| (o.order_id.clone(), o.remaining, o.sequence))
                        .collect(),
                )
            })
            .collect()
    }

    fn levels(&self, side: Side) -> &Vec<PriceLevel> {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn levels_mut(&mut self, side: Side) -> &mut Vec<PriceLevel> {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    fn level_at(&self, side: Side, price: Amount) -> Option<usize> {
        match locate(self.levels(side), price, side == Side::Buy) {
            (at, true) => Some(at),
            _ => None,
        }
    }

    fn resting(&self, order_id: &str) -> Option<&RestingOrder> {
        let slot = self.index.get(order_id)?;
        let at = self.level_at(slot.side, slot.price)?;
        self.levels(slot.side)
            .get(at)?
            .orders
            .iter()
            .find(|o| o.order_id == order_id)
    }

    fn resting_mut(&mut self, order_id: &str) -> Option<&mut RestingOrder> {
        let slot = *self.index.get(order_id)?;
        let at = self.level_at(slot.side, slot.price)?;
        self.levels_mut(slot.side)
            .get_mut(at)?
            .orders
            .iter_mut()
            .find(|o| o.order_id == order_id)
    }

    /// The resting orders in the order they were put on the book (the TypeScript's `index` map order).
    fn resting_in_put_order(&self) -> Vec<&RestingOrder> {
        let mut ids: Vec<(&String, &Slot)> = self.index.iter().collect();
        ids.sort_by_key(|(_, slot)| slot.put);
        ids.into_iter()
            .filter_map(|(id, _)| self.resting(id))
            .collect()
    }

    fn put_index(&mut self, order: &RestingOrder) {
        self.puts += 1;
        self.index.insert(
            order.order_id.clone(),
            Slot {
                side: order.side,
                price: order.price,
                put: self.puts,
            },
        );
    }

    fn stop_at(&self, order_id: &str) -> Option<usize> {
        self.stops.iter().position(|s| s.order_id == order_id)
    }

    fn next_sequence(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    // ── submit ──────────────────────────────────────────────────────────

    /// The core book's submit (`book.ts`), under the trigger wrappers ([`OrderBook::submit`]). `now` is the engine
    /// clock in milliseconds, when it has one.
    pub(super) fn submit_core(&mut self, incoming: &EngineOrder, now: Option<i64>) -> SubmitResult {
        if let Some(r) = peg_intent_refuse(incoming) {
            return SubmitResult::refused(r);
        }
        let order = bind_peg_relative(incoming);
        if let Some(p) = order.position_qty {
            self.futures_positions.insert(order.account_id.clone(), p);
        }
        if let Some(r) = self.validate(&order, now) {
            return SubmitResult::refused(r);
        }
        let expired = now.map(|n| self.expire_due(n)).unwrap_or_default();

        let is_stop = order.order_type.is_stop();
        let view = stop_view(&order);
        let triggers_now = is_stop && (self.is_triggered(view) || self.already_at_stop(view));
        // A stop already at or through its price goes straight to the book; say so with the last price it met.
        let arrival = match (triggers_now, self.last_trade_price) {
            (true, Some(last)) => Some(trigger_fact(view.trigger_by, view.stop_price, last)),
            _ => None,
        };

        if is_stop && !triggers_now {
            let displaced = self.displace_reduce_only(&order);
            let sequence = self.next_sequence();
            let (trail, peak) = trail_peak(order.trail.get(), order.mark.get());
            let stop = StopOrder {
                order_id: order.order_id.clone(),
                account_id: order.account_id.clone(),
                order_type: order.order_type,
                side: order.side,
                qty: order.qty,
                price: order.price,
                stop_price: view.stop_price,
                tif: order.tif,
                sequence,
                version: 1,
                oco_sibling_id: order.oco_sibling_id.clone(),
                expire_at: order.expire_at.clone(),
                session_id: read_session_id(order.session_id.as_deref()),
                reduce_only: order.reduce_only,
                trigger_by: view.trigger_by,
                trigger_role: view.trigger_role,
                min_qty: read_min_qty(&order.min_qty),
                aon: read_aon(&order.aon),
                trail,
                peak,
            };
            let resting = stop.resting_ref();
            self.stops.push(stop);
            self.accepted_ids.insert(order.order_id.clone());
            self.remember_oco(&order.order_id, order.oco_sibling_id.as_ref());
            self.link_live_sibling(&order.order_id, order.oco_sibling_id.as_deref());
            let mut cancellations = displaced;
            cancellations.extend(expired);
            return SubmitResult {
                accepted: true,
                sequence: Some(sequence),
                resting: Some(resting),
                cancellations,
                ..SubmitResult::default()
            };
        }

        let effective = to_effective(&order);
        if let Some(viability) = self.check_viability(&effective) {
            // A maker-or-cancel that would take is consumed: a retry of the same id must not rest.
            if effective.tif == Tif::Moc && viability.code == "moc_would_take" {
                self.accepted_ids.insert(order.order_id.clone());
            }
            return SubmitResult::refused(viability);
        }

        let displaced = self.displace_reduce_only(&order);
        let sequence = self.next_sequence();
        let outcome = self.execute(&effective, sequence, 1);
        self.record_prints(&outcome.fills);
        self.apply_fills_to_position(&outcome.fills);
        let reduce_cancels = self.cancel_reduce_only_due();
        self.accepted_ids.insert(order.order_id.clone());
        self.remember_oco(&order.order_id, order.oco_sibling_id.as_ref());
        self.link_live_sibling(&order.order_id, order.oco_sibling_id.as_deref());
        let oco_cancels = self.cancel_oco_siblings(
            &outcome.fills,
            Some(Incoming {
                order_id: &order.order_id,
                oco_sibling_id: order.oco_sibling_id.as_deref(),
                stop_limit: order.order_type == OrderType::StopLimit,
            }),
        );
        let drained = self.drain_stops();
        self.last_move = None;
        let surveillance_cases = collect_surveillance(outcome.surveillance, &drained);

        let mut cancellations = displaced;
        cancellations.extend(expired);
        cancellations.extend(outcome.cancellations);
        cancellations.extend(reduce_cancels);
        cancellations.extend(oco_cancels);
        let mut triggered = Vec::with_capacity(drained.len() + 1);
        // The arrival is reported like any other trigger, so every composer carries it to the event.
        if let Some(fact) = arrival {
            triggered.push(TriggerOutcome {
                order_id: order.order_id.clone(),
                trigger: Some(fact),
                sequence,
                fills: Vec::new(),
                resting: None,
                cancellations: Vec::new(),
                rejected: None,
                surveillance_cases: Vec::new(),
            });
        }
        triggered.extend(drained);
        SubmitResult {
            accepted: true,
            sequence: Some(sequence),
            fills: outcome.fills,
            resting: outcome.resting,
            rejected: None,
            cancellations,
            triggered,
            surveillance_cases,
        }
    }

    // ── cancel ──────────────────────────────────────────────────────────

    /// Pull one live order, through the combo and option layers.
    pub fn cancel(&mut self, order_id: &str, reason: CancelReason) -> CancelResult {
        self.combo_cancel(order_id, reason)
    }

    /// The core book's cancel.
    fn cancel_core(&mut self, order_id: &str, reason: CancelReason) -> CancelResult {
        if let Some((account, remaining)) = self
            .resting(order_id)
            .map(|r| (r.account_id.clone(), r.remaining))
        {
            self.remove_resting(order_id);
            self.accepted_ids.remove(order_id);
            let sequence = self.next_sequence();
            return CancelResult {
                cancelled: true,
                order_id: order_id.to_owned(),
                sequence: Some(sequence),
                cancellation: Some(cancelled(order_id, &account, remaining, sequence, reason)),
                rejected: None,
            };
        }
        if let Some(at) = self.stop_at(order_id) {
            let stop = self.stops.remove(at);
            self.accepted_ids.remove(order_id);
            let sequence = self.next_sequence();
            return CancelResult {
                cancelled: true,
                order_id: order_id.to_owned(),
                sequence: Some(sequence),
                cancellation: Some(cancelled(
                    order_id,
                    &stop.account_id,
                    stop.qty,
                    sequence,
                    reason,
                )),
                rejected: None,
            };
        }
        CancelResult::missing(order_id)
    }

    /// Pull this account's live rests and stops, on one side when given. Other accounts stay.
    pub fn cancel_account(&mut self, account_id: &str, side: Option<Side>) -> Vec<CancelledRef> {
        self.owned_order_ids(account_id, side)
            .iter()
            .filter_map(|id| self.cancel(id, CancelReason::Requested).cancellation)
            .collect()
    }

    /// This account's live rests and stops (on one side when given), oldest first: what a mass cancel pulls.
    pub fn owned_order_ids(&self, account_id: &str, side: Option<Side>) -> Vec<String> {
        let resting = self.resting_in_put_order();
        let mut live: Vec<LiveOwned<'_>> = resting
            .iter()
            .map(|o| LiveOwned {
                order_id: &o.order_id,
                account_id: &o.account_id,
                sequence: o.sequence,
                side: o.side,
            })
            .collect();
        live.extend(self.stops.iter().map(|s| LiveOwned {
            order_id: &s.order_id,
            account_id: &s.account_id,
            sequence: s.sequence,
            side: s.side,
        }));
        owned_order_ids(account_id, &live, side)
    }

    /// A live order's account, side and remaining quantity (`restingIdentity`): rests first, then stops.
    pub fn live_identity(&self, order_id: &str) -> Option<(String, Side, Amount)> {
        if let Some(r) = self.resting(order_id) {
            return Some((r.account_id.clone(), r.side, r.remaining));
        }
        self.stops
            .iter()
            .find(|s| s.order_id == order_id)
            .map(|s| (s.account_id.clone(), s.side, s.qty))
    }

    /// Pull the live rests and stops tagged with this session. Untagged ones stay.
    pub fn cancel_session(&mut self, session_id: &str) -> Vec<CancelledRef> {
        let ids = {
            let resting = self.resting_in_put_order();
            let mut live: Vec<LiveSession<'_>> = resting
                .iter()
                .map(|o| LiveSession {
                    order_id: &o.order_id,
                    session_id: o.session_id.as_deref(),
                    sequence: o.sequence,
                })
                .collect();
            live.extend(self.stops.iter().map(|s| LiveSession {
                order_id: &s.order_id,
                session_id: s.session_id.as_deref(),
                sequence: s.sequence,
            }));
            session_order_ids(session_id, &live)
        };
        ids.iter()
            .filter_map(|id| self.cancel(id, CancelReason::SessionDead).cancellation)
            .collect()
    }

    // ── amend ───────────────────────────────────────────────────────────

    /// The core book's amend, under the bracket wrapper ([`OrderBook::amend`]).
    pub(super) fn amend_core(&mut self, cmd: &EngineAmend, now: Option<i64>) -> AmendResult {
        let expired = now.map(|n| self.expire_due(n)).unwrap_or_default();
        let result = if self.resting(&cmd.order_id).is_some() {
            self.amend_resting(cmd)
        } else if let Some(at) = self.stop_at(&cmd.order_id) {
            self.amend_stop(at, cmd)
        } else if expired.iter().any(|row| row.order_id == cmd.order_id) {
            AmendResult::refused(
                &cmd.order_id,
                Reject::new("already_expired", "expireAt is not after the engine clock"),
            )
        } else {
            AmendResult::refused(
                &cmd.order_id,
                Reject::new(
                    "order_not_found",
                    format!("order {} is not live in {}", cmd.order_id, self.market_id),
                ),
            )
        };
        if expired.is_empty() {
            return result;
        }
        let mut cancellations = expired;
        cancellations.extend(result.cancellations);
        AmendResult {
            cancellations,
            ..result
        }
    }

    fn amend_resting(&mut self, cmd: &EngineAmend) -> AmendResult {
        let Some(resting) = self.resting(&cmd.order_id).cloned() else {
            return AmendResult::refused(&cmd.order_id, Reject::new("order_not_found", ""));
        };
        let id = cmd.order_id.as_str();
        if cmd.expected_version != resting.version {
            return AmendResult::refused(
                id,
                Reject::new(
                    "version_mismatch",
                    format!("order {id} is at version {}", resting.version),
                ),
            );
        }
        if cmd.stop_price.is_some() {
            return AmendResult::refused(
                id,
                Reject::new(
                    "unexpected_stop_price",
                    "a resting limit order must not carry a stopPrice",
                ),
            );
        }
        let qty = cmd.qty.unwrap_or(resting.remaining);
        let price = cmd.price.unwrap_or(resting.price);
        if qty <= Amount::ZERO {
            return AmendResult::refused(
                id,
                Reject::new("invalid_qty", "quantity must be strictly positive"),
            );
        }
        if price <= Amount::ZERO {
            return AmendResult::refused(
                id,
                Reject::new("invalid_price", "price must be strictly positive"),
            );
        }
        if resting.reduce_only
            && self.would_increase_position(&resting.account_id, resting.side, qty, Some(id))
        {
            return AmendResult::refused(id, would_increase());
        }

        let tif = cmd
            .tif
            .unwrap_or(if resting.post_only { Tif::Po } else { Tif::Gtc });
        let forces = matches!(tif, Tif::Ioc | Tif::Fok);
        let retain = price == resting.price && !forces && qty <= resting.remaining;

        if retain {
            if let Some(r) = min_qty_refuse(qty, resting.min_qty) {
                return AmendResult::refused(id, r);
            }
            let rest = {
                let Some(r) = self.resting_mut(id) else {
                    return AmendResult::refused(id, Reject::new("order_not_found", ""));
                };
                if let Some(at) = &cmd.expire_at {
                    r.expire_at = Some(at.clone());
                }
                if tif == Tif::Po {
                    r.post_only = true;
                }
                r.remaining = qty;
                r.version += 1;
                r.resting_ref()
            };
            self.next_sequence();
            return AmendResult {
                accepted: true,
                order_id: rest.order_id.clone(),
                sequence: Some(rest.sequence),
                version: Some(rest.version),
                priority: Some(Priority::Retained),
                fills: Vec::new(),
                resting: Some(rest),
                rejected: None,
                cancellations: Vec::new(),
                triggered: Vec::new(),
                surveillance_cases: Vec::new(),
            };
        }

        let effective = Effective {
            order_id: resting.order_id.clone(),
            account_id: resting.account_id.clone(),
            side: resting.side,
            qty,
            price: Some(price),
            tif,
            oco_sibling_id: resting.oco_sibling_id.clone(),
            expire_at: cmd.expire_at.clone().or_else(|| resting.expire_at.clone()),
            session_id: resting.session_id.clone(),
            reduce_only: resting.reduce_only,
            display_qty: resting.display_peak,
            min_qty: resting.min_qty,
            aon: resting.aon,
        };
        if let Some(v) = self.check_viability(&effective) {
            return AmendResult::refused(id, v);
        }

        let next_version = resting.version + 1;
        self.remove_resting(id);
        let sequence = self.next_sequence();
        let outcome = self.execute(&effective, sequence, next_version);
        self.record_prints(&outcome.fills);
        self.apply_fills_to_position(&outcome.fills);
        let reduce_cancels = self.cancel_reduce_only_due();
        let oco_cancels = self.cancel_oco_siblings(
            &outcome.fills,
            Some(Incoming {
                order_id: &resting.order_id,
                oco_sibling_id: resting.oco_sibling_id.as_deref(),
                stop_limit: false,
            }),
        );
        let triggered = self.drain_stops();
        self.last_move = None;
        let surveillance_cases = collect_surveillance(outcome.surveillance, &triggered);
        let mut cancellations = outcome.cancellations;
        cancellations.extend(reduce_cancels);
        cancellations.extend(oco_cancels);
        AmendResult {
            accepted: true,
            order_id: cmd.order_id.clone(),
            sequence: Some(outcome.resting.as_ref().map_or(sequence, |r| r.sequence)),
            version: Some(outcome.resting.as_ref().map_or(next_version, |r| r.version)),
            priority: Some(Priority::Lost),
            fills: outcome.fills,
            resting: outcome.resting,
            rejected: None,
            cancellations,
            triggered,
            surveillance_cases,
        }
    }

    fn amend_stop(&mut self, at: usize, cmd: &EngineAmend) -> AmendResult {
        let Some(stop) = self.stops.get(at).cloned() else {
            return AmendResult::refused(&cmd.order_id, Reject::new("order_not_found", ""));
        };
        let id = cmd.order_id.as_str();
        if cmd.expected_version != stop.version {
            return AmendResult::refused(
                id,
                Reject::new(
                    "version_mismatch",
                    format!("order {id} is at version {}", stop.version),
                ),
            );
        }
        if stop.order_type == OrderType::Stop && cmd.price.is_some() {
            return AmendResult::refused(
                id,
                Reject::new(
                    "unexpected_price",
                    "a stop order must not carry a limit price",
                ),
            );
        }
        let qty = cmd.qty.unwrap_or(stop.qty);
        let price = if cmd.price.is_some() {
            cmd.price
        } else {
            stop.price
        };
        let stop_price = cmd.stop_price.unwrap_or(stop.stop_price);
        let tif = cmd.tif.unwrap_or(stop.tif);
        if qty <= Amount::ZERO {
            return AmendResult::refused(
                id,
                Reject::new("invalid_qty", "quantity must be strictly positive"),
            );
        }
        if stop_price <= Amount::ZERO {
            return AmendResult::refused(
                id,
                Reject::new("invalid_price", "stopPrice must be strictly positive"),
            );
        }
        if stop.order_type == OrderType::StopLimit {
            match price {
                None => {
                    return AmendResult::refused(
                        id,
                        Reject::new("missing_price", "a stop_limit order requires a price"),
                    );
                }
                Some(p) if p <= Amount::ZERO => {
                    return AmendResult::refused(
                        id,
                        Reject::new("invalid_price", "price must be strictly positive"),
                    );
                }
                Some(_) => {}
            }
        }
        if stop.reduce_only
            && self.would_increase_position(&stop.account_id, stop.side, qty, Some(id))
        {
            return AmendResult::refused(id, would_increase());
        }

        let forces = matches!(tif, Tif::Ioc | Tif::Fok);
        let same_limit = price == stop.price;
        let retain = stop_price == stop.stop_price
            && same_limit
            && tif == stop.tif
            && !forces
            && qty <= stop.qty;

        if retain {
            let rest = {
                let Some(s) = self.stops.get_mut(at) else {
                    return AmendResult::refused(id, Reject::new("order_not_found", ""));
                };
                if let Some(e) = &cmd.expire_at {
                    s.expire_at = Some(e.clone());
                }
                s.qty = qty;
                s.version += 1;
                s.resting_ref()
            };
            self.next_sequence();
            return AmendResult {
                accepted: true,
                order_id: rest.order_id.clone(),
                sequence: Some(rest.sequence),
                version: Some(rest.version),
                priority: Some(Priority::Retained),
                fills: Vec::new(),
                resting: Some(rest),
                rejected: None,
                cancellations: Vec::new(),
                triggered: Vec::new(),
                surveillance_cases: Vec::new(),
            };
        }

        let updated = StopOrder {
            qty,
            price,
            stop_price,
            tif,
            version: stop.version + 1,
            ..stop.clone()
        };
        let effective = Effective {
            order_id: updated.order_id.clone(),
            account_id: updated.account_id.clone(),
            side: updated.side,
            qty: updated.qty,
            price: if updated.order_type == OrderType::StopLimit {
                updated.price
            } else {
                None
            },
            tif: updated.tif,
            oco_sibling_id: updated.oco_sibling_id.clone(),
            expire_at: cmd.expire_at.clone().or_else(|| updated.expire_at.clone()),
            session_id: updated.session_id.clone(),
            reduce_only: updated.reduce_only,
            display_qty: None,
            min_qty: updated.min_qty,
            aon: updated.aon,
        };

        if self.armed_through(updated.view()) || self.is_triggered(updated.view()) {
            if let Some(v) = self.check_viability(&effective) {
                return AmendResult::refused(id, v);
            }
            if let Some(i) = self.stop_at(&stop.order_id) {
                self.stops.remove(i);
            }
            let reference = self.last_trade_price.unwrap_or(Amount::ZERO);
            let fired = self.fire(updated.clone(), reference);
            let cascade = self.drain_stops();
            self.last_move = None;
            let surveillance_cases =
                collect_surveillance(fired.surveillance_cases.clone(), &cascade);
            let mut triggered = vec![fired.clone()];
            triggered.extend(cascade);
            return AmendResult {
                accepted: true,
                order_id: cmd.order_id.clone(),
                sequence: Some(
                    fired
                        .resting
                        .as_ref()
                        .map_or(fired.sequence, |r| r.sequence),
                ),
                version: Some(
                    fired
                        .resting
                        .as_ref()
                        .map_or(updated.version, |r| r.version),
                ),
                priority: Some(Priority::Lost),
                fills: fired.fills,
                resting: fired.resting,
                rejected: fired.rejected,
                cancellations: fired.cancellations,
                triggered,
                surveillance_cases,
            };
        }

        if let Some(i) = self.stop_at(&stop.order_id) {
            self.stops.remove(i);
        }
        let sequence = self.next_sequence();
        let lost = StopOrder {
            sequence,
            ..updated
        };
        let rest = lost.resting_ref();
        self.stops.push(lost);
        AmendResult {
            accepted: true,
            order_id: rest.order_id.clone(),
            sequence: Some(rest.sequence),
            version: Some(rest.version),
            priority: Some(Priority::Lost),
            fills: Vec::new(),
            resting: Some(rest),
            rejected: None,
            cancellations: Vec::new(),
            triggered: Vec::new(),
            surveillance_cases: Vec::new(),
        }
    }

    // ── checks ──────────────────────────────────────────────────────────

    fn validate(&self, order: &EngineOrder, now: Option<i64>) -> Option<Reject> {
        if order.instrument.is_some() && order.order_type.is_stop() {
            return Some(Reject::new(
                "option_trigger_unsupported",
                "stop_limit, stop_market, take_limit, take_market, and trailing_stop are not supported on option or option_combo",
            ));
        }
        if let Some(r) = stp_identity_refuse(&order.account_id) {
            return Some(r);
        }
        if order.qty <= Amount::ZERO {
            return Some(Reject::new(
                "invalid_qty",
                "quantity must be strictly positive",
            ));
        }
        if self.accepted_ids.contains(&order.order_id) || self.is_live(&order.order_id) {
            return Some(Reject::new(
                "duplicate_order_id",
                format!(
                    "order {} was already accepted in {}",
                    order.order_id, self.market_id
                ),
            ));
        }
        if let Some(sibling) = &order.oco_sibling_id {
            if *sibling == order.order_id || sibling.is_empty() {
                return Some(Reject::new(
                    "invalid_oco_sibling",
                    "an OCO order cannot name itself as its sibling",
                ));
            }
            if self.is_oco_terminal(sibling) {
                return Some(Reject::new(
                    "oco_sibling_terminal",
                    format!("oco sibling {sibling} is already terminal"),
                ));
            }
        }
        let kind = order.order_type.as_str();
        let needs_price = order.order_type.needs_price();
        if needs_price {
            match order.price {
                None => {
                    return Some(Reject::new(
                        "missing_price",
                        format!("a {kind} order requires a price"),
                    ));
                }
                // A spread price is a weighted leg-price difference and may be zero or negative (`book::spread`).
                Some(p) if p <= Amount::ZERO && order.spread.is_none() => {
                    return Some(Reject::new(
                        "invalid_price",
                        "price must be strictly positive",
                    ));
                }
                Some(_) => {}
            }
        } else if order.price.is_some() {
            return Some(Reject::new(
                "unexpected_price",
                format!("a {kind} order must not carry a limit price"),
            ));
        }
        let needs_stop = order.order_type.is_stop();
        if needs_stop {
            match order.stop_price {
                None => {
                    return Some(Reject::new(
                        "missing_stop_price",
                        format!("a {kind} order requires a stopPrice"),
                    ));
                }
                Some(p) if p <= Amount::ZERO => {
                    return Some(Reject::new(
                        "invalid_price",
                        "stopPrice must be strictly positive",
                    ));
                }
                Some(_) => {}
            }
        } else if order.stop_price.is_some() {
            return Some(Reject::new(
                "unexpected_stop_price",
                format!("a {kind} order must not carry a stopPrice"),
            ));
        }
        if order.trigger_role == Some(TriggerRole::TakeProfit)
            && needs_stop
            && let Some(stop) = order.stop_price
        {
            let Some(last) = self.last_trade_price else {
                return Some(Reject::new(
                    "missing_last_price",
                    "a take-profit needs a last trade; the engine does not invent one",
                ));
            };
            if order.side == Side::Sell && stop <= last {
                return Some(Reject::new(
                    "trigger_wrong_side",
                    "a take-profit sell is valid only above the market",
                ));
            }
            if order.side == Side::Buy && stop >= last {
                return Some(Reject::new(
                    "trigger_wrong_side",
                    "a take-profit buy is valid only below the market",
                ));
            }
        }
        if order.tif == Tif::Po && !needs_price {
            return Some(Reject::new(
                "invalid_tif",
                "post-only requires a limit price",
            ));
        }
        if order.tif == Tif::Moc && !needs_price {
            return Some(Reject::new(
                "invalid_tif",
                "maker-or-cancel requires a limit price",
            ));
        }
        if order.tif.expires() {
            if order.order_type == OrderType::Market {
                return Some(Reject::new(
                    "invalid_tif",
                    "GTD/GTT cannot rest a market order",
                ));
            }
            let expire_at = order.expire_at.as_deref().unwrap_or("");
            if expire_at.is_empty() {
                return Some(Reject::new(
                    "missing_expire_at",
                    "GTD/GTT requires expireAt; the engine does not invent one",
                ));
            }
            let Some(expire_ms) = v8_date_parse(expire_at) else {
                return Some(Reject::new(
                    "missing_expire_at",
                    "expireAt must be an ISO instant; the engine does not invent one",
                ));
            };
            let Some(now) = now else {
                return Some(Reject::new(
                    "engine_clock_missing",
                    "GTD/GTT expires on the engine clock; refuse when that clock is missing",
                ));
            };
            if expire_ms <= now {
                return Some(Reject::new(
                    "already_expired",
                    "expireAt is not after the engine clock",
                ));
            }
        }
        if order.reduce_only && self.incoming_reduce_only_refused(order) {
            return Some(would_increase());
        }
        if wants_iceberg(order) {
            if let Some(r) = iceberg_display_refuse(order.qty, order.display_qty.get()) {
                return Some(r);
            }
            if order.price.is_none() {
                return Some(Reject::new(
                    "missing_price",
                    "an iceberg requires a limit price; the engine does not invent a display",
                ));
            }
        }
        if let Some(r) = min_qty_refuse(order.qty, read_min_qty(&order.min_qty)) {
            return Some(r);
        }
        if let Some(r) = aon_iceberg_refuse(read_aon(&order.aon), wants_iceberg(order)) {
            return Some(r);
        }
        peg_intent_refuse(order)
            .or_else(|| auction_intent_refuse(order))
            .or_else(|| collar_intent_refuse(order))
            .or_else(|| min_notional_intent_refuse(order))
    }

    fn expire_due(&mut self, now: i64) -> Vec<CancelledRef> {
        let mut ids = self.due_expiry(now);
        ids.dedup();
        let mut out = Vec::new();
        for order_id in ids {
            if let Some((account, remaining)) = self
                .resting(&order_id)
                .map(|r| (r.account_id.clone(), r.remaining))
            {
                self.remove_resting(&order_id);
                let sequence = self.next_sequence();
                out.push(cancelled(
                    &order_id,
                    &account,
                    remaining,
                    sequence,
                    CancelReason::Expired,
                ));
                continue;
            }
            if let Some(at) = self.stop_at(&order_id) {
                let stop = self.stops.remove(at);
                let sequence = self.next_sequence();
                out.push(cancelled(
                    &order_id,
                    &stop.account_id,
                    stop.qty,
                    sequence,
                    CancelReason::Expired,
                ));
            }
        }
        out
    }

    fn check_viability(&self, order: &Effective) -> Option<Reject> {
        if let Some(p) = order.price {
            if order.tif == Tif::Po && self.would_cross(order.side, p) {
                return Some(Reject::new(
                    "post_only_would_cross",
                    "post-only order would take liquidity",
                ));
            }
            if order.tif == Tif::Moc && self.would_cross(order.side, p) {
                return Some(Reject::new(
                    "moc_would_take",
                    "maker-or-cancel order would take liquidity",
                ));
            }
        }
        if order.tif == Tif::Fok && self.fillable_qty(order) < order.qty {
            return Some(Reject::new(
                "fok_unfillable",
                "fill-or-kill order cannot be filled in full",
            ));
        }
        None
    }

    fn would_cross(&self, side: Side, price: Amount) -> bool {
        match side {
            Side::Buy => self.best_ask().is_some_and(|ask| price >= ask),
            Side::Sell => self.best_bid().is_some_and(|bid| price <= bid),
        }
    }

    fn fillable_qty(&self, order: &Effective) -> Amount {
        let mut total: Amount = Amount::ZERO;
        let mut remaining = order.qty;
        let taker_min = order.min_qty;
        let mut removed: HashSet<String> = HashSet::new();
        let mut fills: Vec<Fill> = Vec::new();
        let incoming = Incoming {
            order_id: &order.order_id,
            oco_sibling_id: order.oco_sibling_id.as_deref(),
            stop_limit: false,
        };
        let opposite = match order.side {
            Side::Buy => &self.asks,
            Side::Sell => &self.bids,
        };
        for level in opposite {
            if let Some(p) = order.price
                && !crosses_level(order.side, p, level.price)
            {
                break;
            }
            for maker in &level.orders {
                if remaining == Amount::ZERO {
                    return total;
                }
                if removed.contains(&maker.order_id) {
                    continue;
                }
                if !stp_identity_present(&order.account_id)
                    || !stp_identity_present(&maker.account_id)
                {
                    return total;
                }
                // Self-trade prevention expires this rest and goes on: it is not fillable.
                if is_self_trade(&order.account_id, &maker.account_id) {
                    continue;
                }
                let mut clip =
                    remaining.min(visible_remaining(maker.remaining, maker.display_remaining));
                if clip == Amount::ZERO {
                    return total;
                }
                if maker.reduce_only {
                    let open =
                        open_qty(self.net_after_fills(&maker.account_id, &fills), maker.side);
                    if open == Amount::ZERO {
                        continue;
                    }
                    clip = clip.min(open);
                }
                if !clip_meets_aon(clip, maker.remaining, maker.aon) {
                    return total;
                }
                let taker_after = sub(remaining, clip);
                let maker_after = sub(maker.remaining, clip);
                if !both_sides_meet_min_qty(
                    clip,
                    taker_after,
                    taker_min,
                    maker_after,
                    maker.min_qty,
                ) {
                    return total;
                }
                total = add(total, clip);
                remaining = sub(remaining, clip);
                fills.push(Fill {
                    sequence: 0,
                    maker_order_id: maker.order_id.clone(),
                    maker_account_id: maker.account_id.clone(),
                    taker_order_id: order.order_id.clone(),
                    taker_account_id: order.account_id.clone(),
                    taker_side: order.side,
                    price: maker.price,
                    qty: clip,
                    legs: None,
                });
                if let Some(s) = self.sibling_of(&maker.order_id, Some(incoming)) {
                    removed.insert(s);
                }
                if let Some(s) = self.sibling_of(&order.order_id, Some(incoming)) {
                    removed.insert(s);
                }
            }
        }
        total
    }

    fn execute(&mut self, order: &Effective, sequence: u64, version: u64) -> Executed {
        let fills_whole = !order.aon || can_fill_aon(self.fillable_qty(order), order.qty, true);
        let matched = if fills_whole {
            self.match_order(order)
        } else {
            Matched {
                fills: Vec::new(),
                remaining: order.qty,
                cancellations: Vec::new(),
                surveillance: Vec::new(),
            }
        };
        let mut cancellations = matched.cancellations;
        let mut resting = None;
        if matched.remaining > Amount::ZERO {
            if order.price.is_some() && order.tif.can_rest() {
                resting = Some(self.rest(order, matched.remaining, sequence, version));
            } else {
                let seq = self.next_sequence();
                let reason = if order.price.is_none() {
                    CancelReason::MarketRemainder
                } else {
                    CancelReason::IocRemainder
                };
                cancellations.push(cancelled(
                    &order.order_id,
                    &order.account_id,
                    matched.remaining,
                    seq,
                    reason,
                ));
            }
        }
        Executed {
            fills: matched.fills,
            resting,
            cancellations,
            surveillance: matched.surveillance,
        }
    }

    /// The front order of the level at `price` on `side`, as it stands now.
    fn front(&self, side: Side, price: Amount) -> Option<&RestingOrder> {
        let at = self.level_at(side, price)?;
        self.levels(side).get(at)?.orders.first()
    }

    /// Drop the front order of the level at `price`; when the level is left empty, drop the level at `level_index`
    /// (where the TypeScript's loop stands). True when a level was dropped.
    fn shift_front(&mut self, side: Side, price: Amount, level_index: usize) -> bool {
        let Some(at) = self.level_at(side, price) else {
            return false;
        };
        let levels = self.levels_mut(side);
        let Some(level) = levels.get_mut(at) else {
            return false;
        };
        if level.orders.is_empty() {
            return false;
        }
        let front = level.orders.remove(0);
        let empty = level.orders.is_empty();
        self.index.remove(&front.order_id);
        if empty {
            let levels = self.levels_mut(side);
            if level_index < levels.len() {
                levels.remove(level_index);
            }
        }
        empty
    }

    /// Whether the level the loop holds is empty: gone from the side, or holding nothing.
    fn level_empty(&self, side: Side, price: Amount) -> bool {
        self.level_at(side, price)
            .and_then(|at| self.levels(side).get(at))
            .is_none_or(|l| l.orders.is_empty())
    }

    fn match_order(&mut self, order: &Effective) -> Matched {
        let maker_side = match order.side {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        };
        let incoming = Incoming {
            order_id: &order.order_id,
            oco_sibling_id: order.oco_sibling_id.as_deref(),
            stop_limit: false,
        };
        let mut fills: Vec<Fill> = Vec::new();
        let mut cancellations: Vec<CancelledRef> = Vec::new();
        let mut surveillance: Vec<SurveillanceCase> = Vec::new();
        let mut remaining = order.qty;
        let mut sliced: HashSet<String> = HashSet::new();
        let mut oco_fired: HashSet<String> = HashSet::new();
        let mut level_index = 0usize;

        'levels: while remaining > Amount::ZERO {
            let Some(level_price) = self.levels(maker_side).get(level_index).map(|l| l.price)
            else {
                break;
            };
            if let Some(p) = order.price
                && !crosses_level(order.side, p, level_price)
            {
                break;
            }
            let mut level_done = false;
            while remaining > Amount::ZERO {
                let Some(maker) = self.front(maker_side, level_price).cloned() else {
                    break;
                };
                if sliced.contains(&maker.order_id) {
                    level_done = true;
                    break;
                }
                if !stp_identity_present(&order.account_id)
                    || !stp_identity_present(&maker.account_id)
                {
                    break 'levels;
                }
                if is_self_trade(&order.account_id, &maker.account_id) {
                    let sequence = self.next_sequence();
                    cancellations.push(cancelled(
                        &maker.order_id,
                        &maker.account_id,
                        maker.remaining,
                        sequence,
                        CancelReason::SelfTradePrevention,
                    ));
                    if let Some(case) = self_trade_case(&maker.account_id, &self.market_id) {
                        self.surveillance_cases.push(case.clone());
                        surveillance.push(case);
                    }
                    if self.shift_front(maker_side, level_price, level_index) {
                        continue 'levels;
                    }
                    continue;
                }
                let mut qty =
                    remaining.min(visible_remaining(maker.remaining, maker.display_remaining));
                if qty == Amount::ZERO {
                    break;
                }
                if maker.reduce_only {
                    let open =
                        open_qty(self.net_after_fills(&maker.account_id, &fills), maker.side);
                    if open == Amount::ZERO {
                        if self.pull_reduce_only_maker(
                            maker_side,
                            level_price,
                            level_index,
                            &mut cancellations,
                        ) {
                            continue 'levels;
                        }
                        continue;
                    }
                    if qty > open {
                        qty = open;
                    }
                }
                if !clip_meets_aon(qty, maker.remaining, maker.aon) {
                    break 'levels;
                }
                let taker_after = sub(remaining, qty);
                let maker_after = sub(maker.remaining, qty);
                if !both_sides_meet_min_qty(
                    qty,
                    taker_after,
                    order.min_qty,
                    maker_after,
                    maker.min_qty,
                ) {
                    break 'levels;
                }
                let sequence = self.next_sequence();
                fills.push(Fill {
                    sequence,
                    maker_order_id: maker.order_id.clone(),
                    maker_account_id: maker.account_id.clone(),
                    taker_order_id: order.order_id.clone(),
                    taker_account_id: order.account_id.clone(),
                    taker_side: order.side,
                    price: maker.price,
                    qty,
                    legs: None,
                });
                if let Some(m) = self.resting_mut(&maker.order_id) {
                    m.remaining = sub(m.remaining, qty);
                    if let Some(d) = m.display_remaining {
                        m.display_remaining = Some(sub(d, qty));
                    }
                }
                remaining = sub(remaining, qty);

                // The sibling is still on the book: pull it before the sweep reaches it.
                self.pull_oco_link(
                    &maker.order_id,
                    Some(incoming),
                    &mut oco_fired,
                    &mut cancellations,
                );
                self.pull_oco_link(
                    &order.order_id,
                    Some(incoming),
                    &mut oco_fired,
                    &mut cancellations,
                );

                let now = self
                    .front(maker_side, level_price)
                    .filter(|f| f.order_id == maker.order_id)
                    .map(|f| (f.remaining, f.display_remaining, f.display_peak));
                let Some((left, display_left, peak)) = now else {
                    continue;
                };
                if left == Amount::ZERO {
                    // `level.orders.shift()`: the emptied level is dropped after the loop, as the TypeScript does.
                    if let Some(at) = self.level_at(maker_side, level_price)
                        && let Some(level) = self.levels_mut(maker_side).get_mut(at)
                        && !level.orders.is_empty()
                    {
                        level.orders.remove(0);
                    }
                    self.index.remove(&maker.order_id);
                } else if maker.reduce_only
                    && open_qty(self.net_after_fills(&maker.account_id, &fills), maker.side)
                        == Amount::ZERO
                {
                    if self.pull_reduce_only_maker(
                        maker_side,
                        level_price,
                        level_index,
                        &mut cancellations,
                    ) {
                        continue 'levels;
                    }
                } else if display_left == Some(Amount::ZERO)
                    && let Some(peak) = peak
                {
                    if let Some(at) = self.level_at(maker_side, level_price)
                        && let Some(level) = self.levels_mut(maker_side).get_mut(at)
                        && !level.orders.is_empty()
                    {
                        let mut front = level.orders.remove(0);
                        front.display_remaining = Some(refill_display(peak, front.remaining));
                        level.orders.push(front);
                    }
                    sliced.insert(maker.order_id.clone());
                }
            }

            if self.level_empty(maker_side, level_price) {
                let levels = self.levels_mut(maker_side);
                if level_index < levels.len() {
                    levels.remove(level_index);
                }
                continue;
            }
            if level_done {
                level_index += 1;
                continue;
            }
            break;
        }

        Matched {
            fills,
            remaining,
            cancellations,
            surveillance,
        }
    }

    fn rest(
        &mut self,
        order: &Effective,
        remaining: Amount,
        sequence: u64,
        version: u64,
    ) -> RestingRef {
        let Some(price) = order.price else {
            // Only a priced order rests (`execute`).
            return RestingRef {
                kind: RestKind::Book,
                order_id: order.order_id.clone(),
                account_id: order.account_id.clone(),
                side: order.side,
                price: Amount::ZERO,
                remaining,
                sequence,
                version,
            };
        };
        let resting = RestingOrder {
            order_id: order.order_id.clone(),
            account_id: order.account_id.clone(),
            side: order.side,
            price,
            remaining,
            sequence,
            version,
            oco_sibling_id: order.oco_sibling_id.clone(),
            expire_at: order.expire_at.clone(),
            session_id: order.session_id.clone(),
            reduce_only: order.reduce_only,
            post_only: order.tif == Tif::Po,
            display_peak: order.display_qty,
            display_remaining: order.display_qty.map(|d| d.min(remaining)),
            min_qty: order.min_qty,
            aon: order.aon,
        };
        let r = resting.resting_ref();
        self.put_index(&resting);
        let descending = order.side == Side::Buy;
        let levels = self.levels_mut(order.side);
        match locate(levels, price, descending) {
            (at, true) => {
                if let Some(level) = levels.get_mut(at) {
                    level.orders.push(resting);
                }
            }
            (at, false) => levels.insert(
                at,
                PriceLevel {
                    price,
                    orders: vec![resting],
                },
            ),
        }
        r
    }

    fn remove_resting(&mut self, order_id: &str) {
        let Some(slot) = self.index.get(order_id).copied() else {
            return;
        };
        let Some(at) = self.level_at(slot.side, slot.price) else {
            return;
        };
        let levels = self.levels_mut(slot.side);
        if let Some(level) = levels.get_mut(at) {
            if let Some(i) = level.orders.iter().position(|o| o.order_id == order_id) {
                level.orders.remove(i);
            }
            if level.orders.is_empty() {
                levels.remove(at);
            }
        }
        self.index.remove(order_id);
    }

    fn record_prints(&mut self, fills: &[Fill]) {
        let Some(last) = fills.last() else { return };
        let previous = self.last_trade_price;
        self.previous_trade_price = previous;
        self.last_trade_price = Some(last.price);
        self.moves += 1;
        self.last_move = Some(LastMove {
            previous,
            next: last.price,
            id: self.moves,
        });
    }

    // ── stops ───────────────────────────────────────────────────────────

    fn is_triggered(&self, stop: StopView) -> bool {
        if stop.trigger_by != TriggerBy::Last {
            return false;
        }
        self.last_move.is_some_and(|m| {
            moved_through(
                stop.side,
                stop.stop_price,
                stop.trigger_role,
                m.previous,
                Some(m.next),
            )
        })
    }

    fn already_at_stop(&self, stop: StopView) -> bool {
        let Some(last) = self.last_trade_price else {
            return false;
        };
        if stop.trigger_by != TriggerBy::Last || stop.trigger_role == TriggerRole::TakeProfit {
            return false;
        }
        if stop.trigger_role == TriggerRole::Legacy {
            return match stop.side {
                Side::Buy => last >= stop.stop_price,
                Side::Sell => last <= stop.stop_price,
            };
        }
        last == stop.stop_price
    }

    /// Amend still uses the level test: a sell stop at or through last is already live.
    fn armed_through(&self, stop: StopView) -> bool {
        let Some(last) = self.last_trade_price else {
            return false;
        };
        if stop.trigger_by != TriggerBy::Last {
            return false;
        }
        if stop.trigger_role == TriggerRole::TakeProfit {
            return match stop.side {
                Side::Sell => last >= stop.stop_price,
                Side::Buy => last <= stop.stop_price,
            };
        }
        match stop.side {
            Side::Buy => last >= stop.stop_price,
            Side::Sell => last <= stop.stop_price,
        }
    }

    fn legacy_level_triggered(&self, stop: &StopOrder) -> bool {
        if stop.trigger_role != TriggerRole::Legacy || stop.trigger_by != TriggerBy::Last {
            return false;
        }
        self.last_trade_price.is_some_and(|last| match stop.side {
            Side::Buy => last >= stop.stop_price,
            Side::Sell => last <= stop.stop_price,
        })
    }

    /// Legacy stops re-scan from the first after every activation, on the level test.
    fn drain_legacy_stops(&mut self, outcomes: &mut Vec<TriggerOutcome>) {
        while let Some(at) = self
            .stops
            .iter()
            .position(|s| self.legacy_level_triggered(s))
        {
            let stop = self.stops.remove(at);
            let reference = self.last_trade_price.unwrap_or(Amount::ZERO);
            outcomes.push(self.fire(stop, reference));
        }
    }

    fn drain_stops(&mut self) -> Vec<TriggerOutcome> {
        let mut outcomes = Vec::new();
        self.drain_legacy_stops(&mut outcomes);
        while let Some(mv) = self.last_move {
            let mut batch = Vec::new();
            let mut index = self.stops.len();
            while index > 0 {
                index -= 1;
                let Some(stop) = self.stops.get(index) else {
                    continue;
                };
                if stop.trigger_by != TriggerBy::Last || stop.trigger_role == TriggerRole::Legacy {
                    continue;
                }
                if !moved_through(
                    stop.side,
                    stop.stop_price,
                    stop.trigger_role,
                    mv.previous,
                    Some(mv.next),
                ) {
                    continue;
                }
                batch.push(self.stops.remove(index));
            }
            if batch.is_empty() {
                break;
            }
            batch.reverse();
            for stop in batch {
                let fired = self.fire(stop, mv.next);
                outcomes.push(fired);
            }
            if self.last_move == Some(mv) {
                break;
            }
            self.drain_legacy_stops(&mut outcomes);
        }
        outcomes
    }

    fn fire(&mut self, stop: StopOrder, reference: Amount) -> TriggerOutcome {
        let fact = trigger_fact(stop.trigger_by, stop.stop_price, reference);
        TriggerOutcome {
            trigger: Some(fact),
            ..self.activate(&stop)
        }
    }

    fn activate(&mut self, stop: &StopOrder) -> TriggerOutcome {
        if let Some(refused) = self.combo_activation_refuse(stop) {
            return refused;
        }
        let effective = Effective {
            order_id: stop.order_id.clone(),
            account_id: stop.account_id.clone(),
            side: stop.side,
            qty: stop.qty,
            price: if stop.order_type == OrderType::StopLimit {
                stop.price
            } else {
                None
            },
            tif: stop.tif,
            oco_sibling_id: stop.oco_sibling_id.clone(),
            expire_at: stop.expire_at.clone(),
            session_id: stop.session_id.clone(),
            reduce_only: stop.reduce_only,
            display_qty: None,
            min_qty: stop.min_qty,
            aon: stop.aon,
        };
        if let Some(v) = self.check_viability(&effective) {
            let sequence = self.next_sequence();
            return TriggerOutcome {
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
                rejected: Some(v),
                surveillance_cases: Vec::new(),
            };
        }
        if let Some(taken) = self.option_activation_refuse(&activation_order(stop)) {
            let sequence = self.next_sequence();
            return TriggerOutcome {
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
                rejected: Some(taken),
                surveillance_cases: Vec::new(),
            };
        }
        let sequence = self.next_sequence();
        let outcome = self.execute(&effective, sequence, stop.version);
        self.record_prints(&outcome.fills);
        self.apply_fills_to_position(&outcome.fills);
        let reduce_cancels = self.cancel_reduce_only_due();
        let oco_cancels = self.cancel_oco_siblings(
            &outcome.fills,
            Some(Incoming {
                order_id: &stop.order_id,
                oco_sibling_id: stop.oco_sibling_id.as_deref(),
                stop_limit: stop.order_type == OrderType::StopLimit,
            }),
        );
        let mut cancellations = outcome.cancellations;
        cancellations.extend(reduce_cancels);
        cancellations.extend(oco_cancels);
        TriggerOutcome {
            order_id: stop.order_id.clone(),
            trigger: None,
            sequence,
            fills: outcome.fills,
            resting: outcome.resting,
            cancellations,
            rejected: None,
            surveillance_cases: outcome.surveillance,
        }
    }

    // ── ids and OCO links ───────────────────────────────────────────────

    pub fn has_accepted(&self, order_id: &str) -> bool {
        self.accepted_ids.contains(order_id)
    }

    fn is_live(&self, order_id: &str) -> bool {
        self.index.contains_key(order_id) || self.stop_at(order_id).is_some()
    }

    fn is_oco_terminal(&self, order_id: &str) -> bool {
        self.oco_members.contains(order_id) && !self.is_live(order_id)
    }

    fn remember_oco(&mut self, order_id: &str, sibling: Option<&String>) {
        if link(sibling).is_some() {
            self.oco_members.insert(order_id.to_owned());
        }
    }

    fn link_live_sibling(&mut self, order_id: &str, sibling: Option<&str>) {
        let Some(sibling) = sibling.filter(|s| !s.is_empty()) else {
            return;
        };
        if let Some(rest) = self.resting_mut(sibling)
            && rest.oco_sibling_id.is_none()
        {
            rest.oco_sibling_id = Some(order_id.to_owned());
        }
        if let Some(at) = self.stop_at(sibling)
            && let Some(stop) = self.stops.get_mut(at)
            && stop.oco_sibling_id.is_none()
        {
            stop.oco_sibling_id = Some(order_id.to_owned());
        }
        if self.is_live(sibling) {
            self.oco_members.insert(sibling.to_owned());
        }
    }

    fn sibling_of(&self, order_id: &str, incoming: Option<Incoming<'_>>) -> Option<String> {
        if let Some(inc) = incoming
            && inc.order_id == order_id
            && let Some(s) = inc.oco_sibling_id.filter(|s| !s.is_empty())
        {
            return Some(s.to_owned());
        }
        if let Some(s) = self
            .resting(order_id)
            .and_then(|r| link(r.oco_sibling_id.as_ref()))
        {
            return Some(s.to_owned());
        }
        self.stop_at(order_id)
            .and_then(|at| self.stops.get(at))
            .and_then(|s| s.oco_sibling_id.clone())
    }

    fn cancel_oco_siblings(
        &mut self,
        fills: &[Fill],
        incoming: Option<Incoming<'_>>,
    ) -> Vec<CancelledRef> {
        let mut out = Vec::new();
        let mut fired: HashSet<String> = HashSet::new();
        // A stop_limit that triggers and rests has no fill yet: the sibling is still live.
        if fills.is_empty() {
            if let Some(inc) = incoming
                && inc.stop_limit
                && self.index.contains_key(inc.order_id)
            {
                self.pull_oco_link(inc.order_id, incoming, &mut fired, &mut out);
            }
            return out;
        }
        for fill in fills {
            for id in [&fill.maker_order_id, &fill.taker_order_id] {
                self.pull_oco_link(id, incoming, &mut fired, &mut out);
            }
        }
        out
    }

    fn pull_oco_link(
        &mut self,
        order_id: &str,
        incoming: Option<Incoming<'_>>,
        fired: &mut HashSet<String>,
        out: &mut Vec<CancelledRef>,
    ) {
        if !fired.insert(order_id.to_owned()) {
            return;
        }
        let Some(sibling) = self.sibling_of(order_id, incoming) else {
            return;
        };
        if fired.contains(&sibling) {
            return;
        }
        if let Some(pulled) = self.pull_oco_sibling(&sibling) {
            out.push(pulled);
            fired.insert(sibling.clone());
            self.oco_members.insert(sibling);
        }
        if let Some(rest) = self.resting_mut(order_id) {
            rest.oco_sibling_id = None;
        }
        if let Some(at) = self.stop_at(order_id)
            && let Some(stop) = self.stops.get_mut(at)
        {
            stop.oco_sibling_id = None;
        }
    }

    fn pull_oco_sibling(&mut self, order_id: &str) -> Option<CancelledRef> {
        if let Some((account, remaining)) = self
            .resting(order_id)
            .map(|r| (r.account_id.clone(), r.remaining))
        {
            self.remove_resting(order_id);
            let sequence = self.next_sequence();
            return Some(cancelled(
                order_id,
                &account,
                remaining,
                sequence,
                CancelReason::OcoSiblingFilled,
            ));
        }
        let at = self.stop_at(order_id)?;
        let stop = self.stops.remove(at);
        let sequence = self.next_sequence();
        Some(cancelled(
            order_id,
            &stop.account_id,
            stop.qty,
            sequence,
            CancelReason::OcoSiblingFilled,
        ))
    }

    // ── positions and reduce-only ───────────────────────────────────────

    /// The account's signed net fill quantity on this book: positive long, negative short, zero flat.
    pub fn net_position(&self, account_id: &str) -> Amount {
        self.positions
            .get(account_id)
            .copied()
            .unwrap_or(Amount::ZERO)
    }

    /// The net after the fills this match has already taken; the book's own net moves only once the match is done.
    fn net_after_fills(&self, account_id: &str, fills: &[Fill]) -> Amount {
        let mut net = self.net_position(account_id);
        for fill in fills {
            let signed = if fill.taker_side == Side::Buy {
                fill.qty
            } else {
                -fill.qty
            };
            if fill.taker_account_id == account_id {
                net = add(net, signed);
            }
            if fill.maker_account_id == account_id {
                net = sub(net, signed);
            }
        }
        net
    }

    fn reduce_only_rows(
        &self,
        account_id: &str,
        side: Side,
        except: Option<&str>,
    ) -> Vec<ReduceRow> {
        let mut rows: Vec<ReduceRow> = self
            .resting_in_put_order()
            .into_iter()
            .filter(|r| {
                r.reduce_only
                    && r.account_id == account_id
                    && r.side == side
                    && Some(r.order_id.as_str()) != except
            })
            .map(|r| ReduceRow {
                order_id: r.order_id.clone(),
                qty: r.remaining,
                price: Some(r.price),
                sequence: r.sequence,
                kind: RestKind::Book,
            })
            .collect();
        rows.extend(
            self.stops
                .iter()
                .filter(|s| {
                    s.reduce_only
                        && s.account_id == account_id
                        && s.side == side
                        && Some(s.order_id.as_str()) != except
                })
                .map(|s| ReduceRow {
                    order_id: s.order_id.clone(),
                    qty: s.qty,
                    price: Some(s.price.unwrap_or(s.stop_price)),
                    sequence: s.sequence,
                    kind: RestKind::Stop,
                }),
        );
        rows
    }

    fn reserved_reduce_only(&self, account_id: &str, side: Side, except: Option<&str>) -> Amount {
        self.reduce_only_rows(account_id, side, except)
            .iter()
            .fold(Amount::ZERO, |t, r| add(t, r.qty))
    }

    fn signed_position(&self, account_id: &str, explicit: Option<Amount>) -> Amount {
        if let Some(p) = explicit {
            return p;
        }
        if let Some(p) = self.futures_positions.get(account_id) {
            return *p;
        }
        self.net_position(account_id)
    }

    fn reducible_qty(&self, account_id: &str, side: Side, except: Option<&str>) -> Amount {
        let open = open_qty(self.signed_position(account_id, None), side);
        let reserved = self.reserved_reduce_only(account_id, side, except);
        if open > reserved {
            open - reserved
        } else {
            Amount::ZERO
        }
    }

    /// The order's own size must fit the open quantity after the reduce-only rows that stay. An untriggered stop always
    /// blocks; a market, stop or stop-limit has no price, so every same-side row blocks it.
    fn incoming_reduce_only_refused(&self, order: &EngineOrder) -> bool {
        let open = open_qty(
            self.signed_position(&order.account_id, order.position_qty),
            order.side,
        );
        if order.qty > open {
            return true;
        }
        let reserved = self
            .reduce_only_rows(&order.account_id, order.side, Some(&order.order_id))
            .iter()
            .filter(|r| {
                r.kind == RestKind::Stop
                    || !more_aggressive(order.side, incoming_price(order), r.price)
            })
            .fold(Amount::ZERO, |t, r| add(t, r.qty));
        add(order.qty, reserved) > open
    }

    fn displace_reduce_only(&mut self, order: &EngineOrder) -> Vec<CancelledRef> {
        if !order.reduce_only || incoming_price(order).is_none() {
            return Vec::new();
        }
        let open = open_qty(
            self.signed_position(&order.account_id, order.position_qty),
            order.side,
        );
        if order.qty > open {
            return Vec::new();
        }
        let rows = self.reduce_only_rows(&order.account_id, order.side, Some(&order.order_id));
        let mut reserved = rows.iter().fold(Amount::ZERO, |t, r| add(t, r.qty));
        let mut less: Vec<&ReduceRow> = rows
            .iter()
            .filter(|r| {
                r.kind != RestKind::Stop
                    && more_aggressive(order.side, incoming_price(order), r.price)
            })
            .collect();
        less.sort_by(|a, b| least_aggressive(order.side, a, b));
        let mut out = Vec::new();
        for row in less {
            if add(order.qty, reserved) <= open {
                break;
            }
            let Some(pulled) = self.pull_reduce_only_row(row) else {
                continue;
            };
            reserved = sub(reserved, row.qty);
            out.push(pulled);
        }
        out
    }

    fn pull_reduce_only_row(&mut self, row: &ReduceRow) -> Option<CancelledRef> {
        if row.kind == RestKind::Book {
            let (account, remaining) = self
                .resting(&row.order_id)
                .map(|r| (r.account_id.clone(), r.remaining))?;
            self.remove_resting(&row.order_id);
            let sequence = self.next_sequence();
            return Some(cancelled(
                &row.order_id,
                &account,
                remaining,
                sequence,
                CancelReason::ReduceOnlyDisplaced,
            ));
        }
        let at = self.stop_at(&row.order_id)?;
        let stop = self.stops.remove(at);
        let sequence = self.next_sequence();
        Some(cancelled(
            &stop.order_id,
            &stop.account_id,
            stop.qty,
            sequence,
            CancelReason::ReduceOnlyDisplaced,
        ))
    }

    fn would_increase_position(
        &self,
        account_id: &str,
        side: Side,
        qty: Amount,
        except: Option<&str>,
    ) -> bool {
        qty > self.reducible_qty(account_id, side, except)
    }

    /// True when this quantity on this side would open a flat position or grow the net (`wouldOpenOrIncrease`).
    pub fn would_open_or_increase(
        &self,
        account_id: &str,
        side: Side,
        qty: Amount,
        except: Option<&str>,
    ) -> bool {
        self.would_increase_position(account_id, side, qty, except)
    }

    /// Drop a reduce-only maker that no longer reduces. True when its level is gone.
    fn pull_reduce_only_maker(
        &mut self,
        side: Side,
        price: Amount,
        level_index: usize,
        out: &mut Vec<CancelledRef>,
    ) -> bool {
        let sequence = self.next_sequence();
        if let Some(m) = self.front(side, price) {
            out.push(cancelled(
                &m.order_id,
                &m.account_id,
                m.remaining,
                sequence,
                CancelReason::WouldIncreasePosition,
            ));
        }
        self.shift_front(side, price, level_index)
    }

    fn add_position(&mut self, account_id: &str, delta: Amount) {
        let next = add(self.net_position(account_id), delta);
        if next == Amount::ZERO {
            self.positions.remove(account_id);
        } else {
            self.positions.insert(account_id.to_owned(), next);
        }
    }

    fn apply_fills_to_position(&mut self, fills: &[Fill]) {
        for fill in fills {
            let signed = if fill.taker_side == Side::Buy {
                fill.qty
            } else {
                -fill.qty
            };
            self.add_position(&fill.taker_account_id, signed);
            self.add_position(&fill.maker_account_id, -signed);
        }
    }

    fn cancel_reduce_only_due(&mut self) -> Vec<CancelledRef> {
        let mut due: Vec<String> = self
            .resting_in_put_order()
            .into_iter()
            .filter(|o| {
                o.reduce_only
                    && self.would_increase_position(
                        &o.account_id,
                        o.side,
                        o.remaining,
                        Some(&o.order_id),
                    )
            })
            .map(|o| o.order_id.clone())
            .collect();
        due.extend(
            self.stops
                .iter()
                .filter(|s| {
                    s.reduce_only
                        && self.would_increase_position(
                            &s.account_id,
                            s.side,
                            s.qty,
                            Some(&s.order_id),
                        )
                })
                .map(|s| s.order_id.clone()),
        );
        let mut out = Vec::new();
        for id in due {
            if let Some((account, remaining)) = self
                .resting(&id)
                .map(|r| (r.account_id.clone(), r.remaining))
            {
                self.remove_resting(&id);
                let sequence = self.next_sequence();
                out.push(cancelled(
                    &id,
                    &account,
                    remaining,
                    sequence,
                    CancelReason::WouldIncreasePosition,
                ));
                continue;
            }
            if let Some(at) = self.stop_at(&id) {
                let stop = self.stops.remove(at);
                let sequence = self.next_sequence();
                out.push(cancelled(
                    &id,
                    &stop.account_id,
                    stop.qty,
                    sequence,
                    CancelReason::WouldIncreasePosition,
                ));
            }
        }
        out
    }

    // ── reads the later slices use ──────────────────────────────────────

    /// The live order an amend would patch, without changing it.
    pub fn amend_target(&self, order_id: &str) -> Option<AmendTarget> {
        if let Some(r) = self.resting(order_id) {
            return Some(AmendTarget {
                kind: RestKind::Book,
                side: r.side,
                price: Some(r.price),
                stop_price: None,
                inherited_tif: if r.post_only { Tif::Po } else { Tif::Gtc },
            });
        }
        let s = self.stops.get(self.stop_at(order_id)?)?;
        Some(AmendTarget {
            kind: RestKind::Stop,
            side: s.side,
            price: s.price,
            stop_price: Some(s.stop_price),
            inherited_tif: s.tif,
        })
    }

    /// True when a limit at this side and price would take the opposite top.
    pub fn would_cross_limit(&self, side: Side, price: Amount) -> bool {
        self.would_cross(side, price)
    }

    /// True when a stop at this side and price would activate now.
    pub fn stop_would_trigger(&self, side: Side, stop_price: Amount) -> bool {
        self.last_trade_price.is_some_and(|last| match side {
            Side::Buy => last >= stop_price,
            Side::Sell => last <= stop_price,
        })
    }

    /// Note a futures position for reduce-only; zero is flat. The fill net does not move.
    pub fn note_futures_position(&mut self, account_id: &str, qty: Amount) {
        self.futures_positions.insert(account_id.to_owned(), qty);
    }

    /// The same structural refusal as a submit, without resting, filling or recording a position.
    pub fn preview(&self, incoming: &EngineOrder) -> SubmitResult {
        if let Some(r) = peg_intent_refuse(incoming) {
            return SubmitResult::refused(r);
        }
        let order = bind_peg_relative(incoming);
        if let Some(r) = self.validate(&order, None) {
            return SubmitResult::refused(r);
        }
        SubmitResult {
            accepted: true,
            ..SubmitResult::default()
        }
    }

    /// A mark or index price. None, or not positive, is a feed that is down: no stop fires and last is not copied in.
    pub fn apply_trigger_reference(
        &mut self,
        source: TriggerBy,
        price: Option<Amount>,
    ) -> Vec<TriggerOutcome> {
        let previous = match source {
            TriggerBy::Index => self.index_price,
            _ => self.mark_price,
        };
        let price = price.filter(|p| *p > Amount::ZERO);
        match source {
            TriggerBy::Index => self.index_price = price,
            _ => self.mark_price = price,
        }
        let Some(price) = price else {
            return Vec::new();
        };
        let mut outcomes = Vec::new();
        while let Some(at) = self.stops.iter().position(|s| {
            s.trigger_by == source
                && moved_through(s.side, s.stop_price, s.trigger_role, previous, Some(price))
        }) {
            let stop = self.stops.remove(at);
            outcomes.push(self.fire(stop, price));
        }
        outcomes
    }

    /// The GTD and GTT orders already due, rests then stops, sorted. Does not cancel them.
    pub fn due_expiry(&self, now: i64) -> Vec<String> {
        let mut ids: Vec<String> = self
            .resting_in_put_order()
            .into_iter()
            .filter(|o| due(o.expire_at.as_ref(), now))
            .map(|o| o.order_id.clone())
            .collect();
        ids.extend(
            self.stops
                .iter()
                .filter(|s| due(s.expire_at.as_ref(), now))
                .map(|s| s.order_id.clone()),
        );
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids
    }

    /// Remember the extreme a trailing stop follows. Nothing for a stop that does not trail or a peak not positive.
    pub fn note_stop_peak(&mut self, order_id: &str, peak: Amount) -> bool {
        if peak <= Amount::ZERO {
            return false;
        }
        let Some(at) = self.stop_at(order_id) else {
            return false;
        };
        match self.stops.get_mut(at) {
            Some(stop) if stop.trail.is_some_and(|t| t > Amount::ZERO) => {
                stop.peak = Some(peak);
                true
            }
            _ => false,
        }
    }

    /// The OCO sibling a live order stores, when it stores one.
    pub fn live_sibling(&self, order_id: &str) -> Option<String> {
        self.resting(order_id)
            .and_then(|r| r.oco_sibling_id.clone())
            .or_else(|| {
                self.stop_at(order_id)
                    .and_then(|at| self.stops.get(at))
                    .and_then(|s| s.oco_sibling_id.clone())
            })
            .filter(|s| !s.is_empty())
    }

    /// Each live stop that walks (a positive trail and peak), in acceptance order: its id, side, trail, peak, trigger
    /// and version.
    pub fn trailing_stops(&self) -> Vec<TrailingStop> {
        self.stops
            .iter()
            .filter_map(|s| match (s.trail, s.peak) {
                (Some(trail), Some(peak)) if trail > Amount::ZERO && peak > Amount::ZERO => {
                    Some(TrailingStop {
                        order_id: s.order_id.clone(),
                        side: s.side,
                        trail,
                        peak,
                        stop_price: s.stop_price,
                        version: s.version,
                    })
                }
                _ => None,
            })
            .collect()
    }

    /// Every live order: resting by side and level (bids, then asks), then the stops in acceptance order.
    pub fn live_orders(&self) -> Vec<LiveOrder> {
        let mut out = Vec::new();
        for (side, levels) in [(Side::Buy, &self.bids), (Side::Sell, &self.asks)] {
            for level in levels {
                for o in &level.orders {
                    out.push(LiveOrder {
                        order_id: o.order_id.clone(),
                        account_id: o.account_id.clone(),
                        kind: RestKind::Book,
                        side,
                        price: level.price,
                        remaining: o.remaining,
                        sequence: o.sequence,
                        version: o.version,
                        funding_price: Some(level.price),
                    });
                }
            }
        }
        for s in &self.stops {
            out.push(LiveOrder {
                order_id: s.order_id.clone(),
                account_id: s.account_id.clone(),
                kind: RestKind::Stop,
                side: s.side,
                price: s.stop_price,
                remaining: s.qty,
                sequence: s.sequence,
                version: s.version,
                funding_price: s.price,
            });
        }
        out
    }

    // ── state ───────────────────────────────────────────────────────────

    fn oco_terminal_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .oco_members
            .iter()
            .filter(|id| !self.is_live(id))
            .cloned()
            .collect();
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids
    }

    fn terminal_accepted_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .accepted_ids
            .iter()
            .filter(|id| !self.is_live(id))
            .cloned()
            .collect();
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids
    }

    fn sorted_positions(map: &HashMap<String, Amount>, keep_zero: bool) -> Vec<Json> {
        let mut rows: Vec<(&String, &Amount)> = map
            .iter()
            .filter(|(_, q)| keep_zero || **q != Amount::ZERO)
            .collect();
        rows.sort_by(|a, b| js_sort_cmp(a.0, b.0));
        rows.into_iter()
            .map(|(account, qty)| {
                Json::obj([
                    ("accountId", Json::str(account.clone())),
                    ("qty", Json::str(format_amount(*qty))),
                ])
            })
            .collect()
    }

    /// The durable form of the book (`toState`): every value a decimal string, and absent parts left out, so a book
    /// that never used one serialises identically.
    pub fn to_state(&self) -> Json {
        let fold = |levels: &[PriceLevel]| -> Json {
            Json::Array(
                levels
                    .iter()
                    .map(|level| {
                        let orders = level
                            .orders
                            .iter()
                            .map(|o| {
                                let mut f: Vec<(String, Json)> = vec![
                                    ("orderId".into(), Json::str(o.order_id.clone())),
                                    ("accountId".into(), Json::str(o.account_id.clone())),
                                    ("remaining".into(), Json::str(format_amount(o.remaining))),
                                    ("sequence".into(), seq_json(o.sequence)),
                                    ("version".into(), seq_json(o.version)),
                                ];
                                if let Some(s) = link(o.oco_sibling_id.as_ref()) {
                                    f.push(("ocoSiblingId".into(), Json::str(s)));
                                }
                                if let Some(s) = link(o.expire_at.as_ref()) {
                                    f.push(("expireAt".into(), Json::str(s)));
                                }
                                if let Some(s) = link(o.session_id.as_ref()) {
                                    f.push(("sessionId".into(), Json::str(s)));
                                }
                                if o.reduce_only {
                                    f.push(("reduceOnly".into(), Json::Bool(true)));
                                }
                                if o.post_only {
                                    f.push(("postOnly".into(), Json::Bool(true)));
                                }
                                if let Some(peak) = o.display_peak {
                                    f.push(("displayQty".into(), Json::str(format_amount(peak))));
                                    f.push((
                                        "displayRemaining".into(),
                                        Json::str(format_amount(
                                            o.display_remaining.unwrap_or(Amount::ZERO),
                                        )),
                                    ));
                                }
                                if let Some(m) = o.min_qty {
                                    f.push(("minQty".into(), Json::str(format_amount(m))));
                                }
                                if o.aon {
                                    f.push(("aon".into(), Json::Bool(true)));
                                }
                                Json::Object(f)
                            })
                            .collect();
                        Json::obj([
                            ("price", Json::str(format_amount(level.price))),
                            ("orders", Json::Array(orders)),
                        ])
                    })
                    .collect(),
            )
        };
        let stops = self
            .stops
            .iter()
            .map(|s| {
                let mut f: Vec<(String, Json)> = vec![
                    ("orderId".into(), Json::str(s.order_id.clone())),
                    ("accountId".into(), Json::str(s.account_id.clone())),
                    ("type".into(), Json::str(s.order_type.as_str())),
                    ("side".into(), Json::str(s.side.as_str())),
                    ("qty".into(), Json::str(format_amount(s.qty))),
                    (
                        "price".into(),
                        s.price.map_or(Json::Null, |p| Json::str(format_amount(p))),
                    ),
                    ("stopPrice".into(), Json::str(format_amount(s.stop_price))),
                    ("tif".into(), Json::str(s.tif.as_str())),
                    ("sequence".into(), seq_json(s.sequence)),
                    ("version".into(), seq_json(s.version)),
                ];
                if let Some(v) = link(s.oco_sibling_id.as_ref()) {
                    f.push(("ocoSiblingId".into(), Json::str(v)));
                }
                if let Some(v) = link(s.expire_at.as_ref()) {
                    f.push(("expireAt".into(), Json::str(v)));
                }
                if let Some(v) = link(s.session_id.as_ref()) {
                    f.push(("sessionId".into(), Json::str(v)));
                }
                if s.reduce_only {
                    f.push(("reduceOnly".into(), Json::Bool(true)));
                }
                if s.trigger_role != TriggerRole::Legacy {
                    f.push(("triggerRole".into(), Json::str(s.trigger_role.as_str())));
                }
                if s.trigger_by != TriggerBy::Last {
                    f.push(("triggerBy".into(), Json::str(s.trigger_by.as_str())));
                }
                if let Some(m) = s.min_qty {
                    f.push(("minQty".into(), Json::str(format_amount(m))));
                }
                if s.aon {
                    f.push(("aon".into(), Json::Bool(true)));
                }
                if let (Some(t), Some(p)) = (s.trail, s.peak) {
                    f.push(("trail".into(), Json::str(format_amount(t))));
                    f.push(("peak".into(), Json::str(format_amount(p))));
                }
                Json::Object(f)
            })
            .collect();
        let mut out: Vec<(String, Json)> = vec![
            ("marketId".into(), Json::str(self.market_id.clone())),
            ("sequence".into(), seq_json(self.sequence)),
            (
                "lastTradePrice".into(),
                self.last_trade_price
                    .map_or(Json::Null, |p| Json::str(format_amount(p))),
            ),
            ("bids".into(), fold(&self.bids)),
            ("asks".into(), fold(&self.asks)),
            ("stops".into(), Json::Array(stops)),
        ];
        let strings = |ids: Vec<String>| Json::Array(ids.into_iter().map(Json::String).collect());
        let oco = self.oco_terminal_ids();
        if !oco.is_empty() {
            out.push(("ocoTerminal".into(), strings(oco)));
        }
        let accepted = self.terminal_accepted_ids();
        if !accepted.is_empty() {
            out.push(("acceptedOrderIds".into(), strings(accepted)));
        }
        let positions = Self::sorted_positions(&self.positions, false);
        if !positions.is_empty() {
            out.push(("positions".into(), Json::Array(positions)));
        }
        let futures = Self::sorted_positions(&self.futures_positions, true);
        if !futures.is_empty() {
            out.push(("futuresPositions".into(), Json::Array(futures)));
        }
        if !self.surveillance_cases.is_empty() {
            out.push((
                "surveillanceCases".into(),
                Json::Array(
                    self.surveillance_cases
                        .iter()
                        .map(SurveillanceCase::to_json)
                        .collect(),
                ),
            ));
        }
        Json::Object(out)
    }

    /// `JSON.stringify(toState())`.
    pub fn serialize(&self) -> String {
        self.to_state().compact()
    }

    /// An independent copy to rehearse on (`clone`): the durable form, plus the previous print and the mark and index
    /// prices it leaves out.
    pub fn rehearsal_copy(&self) -> Result<OrderBook, StateError> {
        let mut copy = OrderBook::from_state(&self.to_state())?;
        copy.previous_trade_price = self.previous_trade_price;
        copy.mark_price = self.mark_price;
        copy.index_price = self.index_price;
        Ok(copy)
    }

    /// The book a snapshot holds (`fromState`).
    pub fn from_state(state: &Json) -> Result<OrderBook, StateError> {
        let r = Reader(state);
        let mut book = OrderBook::new(r.text("marketId")?);
        book.sequence = r.count("sequence")?;
        book.last_trade_price = r.amount_or_null("lastTradePrice")?;

        for (side, key) in [(Side::Buy, "bids"), (Side::Sell, "asks")] {
            for level in r.list(key)? {
                let lr = Reader(level);
                let price = lr.amount("price")?;
                let mut orders = Vec::new();
                for o in lr.list("orders")? {
                    let or = Reader(o);
                    orders.push(RestingOrder {
                        order_id: or.text("orderId")?,
                        account_id: or.text("accountId")?,
                        side,
                        price,
                        remaining: or.amount("remaining")?,
                        sequence: or.count("sequence")?,
                        version: or.version(),
                        oco_sibling_id: or.opt_text("ocoSiblingId"),
                        expire_at: or.opt_text("expireAt"),
                        session_id: or.opt_text("sessionId"),
                        reduce_only: or.flag("reduceOnly"),
                        post_only: or.flag("postOnly"),
                        display_peak: or.opt_amount("displayQty")?,
                        display_remaining: or.opt_amount("displayRemaining")?,
                        min_qty: or.opt_amount("minQty")?,
                        aon: or.flag("aon"),
                    });
                }
                for o in &orders {
                    book.put_index(o);
                }
                book.levels_mut(side).push(PriceLevel { price, orders });
            }
        }

        for s in r.list("stops")? {
            let sr = Reader(s);
            let order_type = OrderType::parse(&sr.text("type")?).unwrap_or(OrderType::Stop);
            let order_type = if order_type == OrderType::StopLimit {
                OrderType::StopLimit
            } else {
                OrderType::Stop
            };
            let (trail, peak) = match (sr.opt_amount("trail")?, sr.opt_amount("peak")?) {
                (Some(t), Some(p)) if t > Amount::ZERO && p > Amount::ZERO => (Some(t), Some(p)),
                _ => (None, None),
            };
            let stop = StopOrder {
                order_id: sr.text("orderId")?,
                account_id: sr.text("accountId")?,
                order_type,
                side: Side::parse(&sr.text("side")?)
                    .ok_or_else(|| StateError("stop side".into()))?,
                qty: sr.amount("qty")?,
                price: sr.amount_or_null("price")?,
                stop_price: sr.amount("stopPrice")?,
                tif: Tif::parse(&sr.text("tif")?).ok_or_else(|| StateError("stop tif".into()))?,
                sequence: sr.count("sequence")?,
                version: sr.version(),
                oco_sibling_id: sr.opt_text("ocoSiblingId"),
                expire_at: sr.opt_text("expireAt"),
                session_id: sr.opt_text("sessionId"),
                reduce_only: sr.flag("reduceOnly"),
                trigger_by: match sr.opt_text("triggerBy").as_deref() {
                    Some("mark") => TriggerBy::Mark,
                    Some("index") => TriggerBy::Index,
                    _ => TriggerBy::Last,
                },
                trigger_role: match sr.opt_text("triggerRole").as_deref() {
                    Some("take_profit") => TriggerRole::TakeProfit,
                    Some("stop_loss") => TriggerRole::StopLoss,
                    _ => TriggerRole::Legacy,
                },
                min_qty: sr.opt_amount("minQty")?,
                aon: sr.flag("aon"),
                trail,
                peak,
            };
            if link(stop.oco_sibling_id.as_ref()).is_some() {
                book.oco_members.insert(stop.order_id.clone());
            }
            book.stops.push(stop);
        }

        for level in book.bids.iter().chain(book.asks.iter()) {
            for o in &level.orders {
                if link(o.oco_sibling_id.as_ref()).is_some() {
                    book.oco_members.insert(o.order_id.clone());
                }
            }
        }
        for id in r.opt_strings("ocoTerminal")? {
            book.oco_members.insert(id);
        }
        for id in r.opt_strings("acceptedOrderIds")? {
            book.accepted_ids.insert(id);
        }
        let live: Vec<String> = book
            .index
            .keys()
            .cloned()
            .chain(book.stops.iter().map(|s| s.order_id.clone()))
            .collect();
        book.accepted_ids.extend(live);

        for row in r.opt_list("positions")? {
            let rr = Reader(row);
            let qty = rr.amount("qty")?;
            if qty != Amount::ZERO {
                book.positions.insert(rr.text("accountId")?, qty);
            }
        }
        for row in r.opt_list("futuresPositions")? {
            let rr = Reader(row);
            book.futures_positions
                .insert(rr.text("accountId")?, rr.amount("qty")?);
        }
        for row in r.opt_list("surveillanceCases")? {
            let rr = Reader(row);
            book.surveillance_cases.push(SurveillanceCase {
                account_id: rr.text("accountId")?,
                market_id: rr.text("marketId")?,
                reason: rr.text("reason")?,
            });
        }
        Ok(book)
    }
}

/// `openQty`: how much of the position a fill on this side closes.
fn open_qty(net: Amount, side: Side) -> Amount {
    match side {
        Side::Sell => net.max(Amount::ZERO),
        Side::Buy => {
            if net < Amount::ZERO {
                -net
            } else {
                Amount::ZERO
            }
        }
    }
}

/// A snapshot that does not read as a book: a field missing or of the wrong kind, or an amount that does not parse
/// (where the TypeScript's `parseAmount` throws).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateError(pub String);

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "book state: {}", self.0)
    }
}

impl std::error::Error for StateError {}

struct Reader<'a>(&'a Json);

impl<'a> Reader<'a> {
    fn get(&self, key: &str) -> Option<&'a Json> {
        self.0.get(key)
    }

    fn text(&self, key: &str) -> Result<String, StateError> {
        match self.get(key) {
            Some(Json::String(s)) => Ok(s.clone()),
            _ => Err(StateError(format!("{key} is not text"))),
        }
    }

    /// `value ?? null` for text; an empty string is kept, as the TypeScript keeps it.
    fn opt_text(&self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        }
    }

    fn count(&self, key: &str) -> Result<u64, StateError> {
        match self.get(key) {
            Some(Json::Number(n)) => crate::journal::record::whole(&Json::Number(*n))
                .and_then(|n| u64::try_from(n).ok())
                .ok_or_else(|| StateError(format!("{key} is not a count"))),
            _ => Err(StateError(format!("{key} is not a count"))),
        }
    }

    /// `version && version > 0 ? version : 1`.
    fn version(&self) -> u64 {
        self.count("version").ok().filter(|v| *v > 0).unwrap_or(1)
    }

    fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Json::Bool(true)))
    }

    fn amount(&self, key: &str) -> Result<Amount, StateError> {
        match self.get(key) {
            Some(Json::String(s)) => parse_amount(s).map_err(StateError),
            _ => Err(StateError(format!("{key} is not an amount"))),
        }
    }

    fn amount_or_null(&self, key: &str) -> Result<Option<Amount>, StateError> {
        match self.get(key) {
            Some(Json::Null) => Ok(None),
            _ => self.amount(key).map(Some),
        }
    }

    /// `value == null ? null : parseAmount(value)`.
    fn opt_amount(&self, key: &str) -> Result<Option<Amount>, StateError> {
        match self.get(key) {
            None | Some(Json::Null) => Ok(None),
            _ => self.amount(key).map(Some),
        }
    }

    fn list(&self, key: &str) -> Result<&'a [Json], StateError> {
        match self.get(key) {
            Some(Json::Array(items)) => Ok(items),
            _ => Err(StateError(format!("{key} is not a list"))),
        }
    }

    fn opt_list(&self, key: &str) -> Result<&'a [Json], StateError> {
        match self.get(key) {
            None | Some(Json::Null) => Ok(&[]),
            _ => self.list(key),
        }
    }

    fn opt_strings(&self, key: &str) -> Result<Vec<String>, StateError> {
        self.opt_list(key)?
            .iter()
            .map(|v| match v {
                Json::String(s) => Ok(s.clone()),
                _ => Err(StateError(format!("{key} holds a value that is not text"))),
            })
            .collect()
    }
}
