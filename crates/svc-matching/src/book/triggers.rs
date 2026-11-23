//! The `triggers` slice's parts of a book: what `trailing-stop.ts`, `bracket.ts`, `oco-link.ts` and `oco-cancel.ts`
//! wrap between the option layer and the combo and spread layers ([`OrderBook::submit`]). The TypeScript installs each
//! by replacing `OrderBook.prototype.submit` on import; here they are one fixed chain, outermost first, in the order the
//! TypeScript's imports install them:
//!
//! 1. a trailing stop (`trail` present) walks its first trigger from the mark and rests as a stop;
//! 2. a bracket rests its entry and, once the entry trades, its take-profit and stop-loss exits;
//! 3. a linked OCO cancel (`cancel: true`) pulls both siblings;
//! 4. an OCO (`oco`, `takeProfit` or `stopLoss`) rests its stop-loss and take-profit legs, all or neither;
//! 5. the option layer (`option.ts`), then the core book.
//!
//! A mark walks the live trailing stops ([`OrderBook::apply_mark`]). The engine never invents a trigger, a mark or a
//! distance: a missing one refuses.

use service_kit::money::Amount;

use super::order_book::OrderBook;
use super::types::{
    AmendResult, CancelReason, CancelledRef, EngineAmend, EngineOrder, Exits, Fill, Opt, OrderType,
    Reject, RestKind, RestingRef, Side, SubmitResult, Tif,
};
use crate::journal::replay::js_sort_cmp;

/// `missing_stop_price`: an OCO or bracket leg's trigger is missing.
const STOP_PX_MISSING: &str = "missing_stop_price";
const TRAIL_MISSING: &str = "missing_trail";
const MARK_MISSING: &str = "missing_mark";

/// A bracket entry waiting to trade (`bracket.ts`'s `Pending`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingBracket {
    take_profit: Amount,
    stop_loss: Amount,
    tp_id: String,
    sl_id: String,
    side: Side,
    qty: Amount,
    /// Fills already seen while this entry was still live.
    traded: Amount,
    account_id: String,
    tif: Tif,
}

/// What the wrappers remember beside one book, in insertion order (each a JavaScript `Map`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TriggerState {
    /// Bracket entries not yet armed, by entry id.
    pending: Vec<(String, PendingBracket)>,
    /// A take-profit still resting after its exits were armed, with the stop it must pull: `(tp_id, sl_id)`.
    live_exits: Vec<(String, String)>,
    /// The trailing stops this book walks, by id (`trailing-stop.ts`'s rows); each reads its trail and peak from the
    /// stop itself.
    trail_rows: Vec<String>,
}

fn rejected(code: &str, message: &str) -> SubmitResult {
    SubmitResult::refused(Reject::new(code, message))
}

fn positive(v: &Opt<Amount>) -> Option<Amount> {
    v.get().filter(|a| *a > 0)
}

/// `namedId`: a trimmed, non-empty id, else none.
fn named(v: &Opt<String>) -> Option<String> {
    v.value()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn opposite(side: Side) -> Side {
    match side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    }
}

/// `collectFills`: the result's fills, then each triggered stop's.
fn all_fills(result: &SubmitResult) -> Vec<Fill> {
    let mut out = result.fills.clone();
    for t in &result.triggered {
        out.extend(t.fills.iter().cloned());
    }
    out
}

fn touches(fill: &Fill, order_id: &str) -> bool {
    fill.maker_order_id == order_id || fill.taker_order_id == order_id
}

/// `mergeResults`.
fn merge(left: SubmitResult, right: SubmitResult) -> SubmitResult {
    let mut fills = left.fills;
    fills.extend(right.fills);
    let mut cancellations = left.cancellations;
    cancellations.extend(right.cancellations);
    let mut triggered = left.triggered;
    triggered.extend(right.triggered);
    let mut surveillance_cases = left.surveillance_cases;
    surveillance_cases.extend(right.surveillance_cases);
    SubmitResult {
        accepted: left.accepted && right.accepted,
        sequence: right.sequence.or(left.sequence),
        fills,
        resting: right.resting.or(left.resting),
        rejected: right.rejected.or(left.rejected),
        cancellations,
        triggered,
        surveillance_cases,
    }
}

/// IOC and FOK cannot rest: an exit that leaves at once is already terminal, so its sibling would refuse.
fn exit_tif(tif: Tif) -> Tif {
    match tif {
        Tif::Ioc | Tif::Fok => Tif::Gtc,
        t => t,
    }
}

/// `ratchetPeak`: a sell follows the high, a buy the low; a worse mark does not walk the stop back.
pub fn ratchet_peak(side: Side, peak: Option<Amount>, mark: Amount) -> Amount {
    match (side, peak) {
        (_, None) => mark,
        (Side::Sell, Some(p)) => p.max(mark),
        (Side::Buy, Some(p)) => p.min(mark),
    }
}

/// `walkStop`: a sell triggers at the extreme less the trail, a buy at the extreme plus it. None when a sell's trail
/// reaches the extreme.
pub fn walk_stop(side: Side, extreme: Amount, trail: Amount) -> Option<Amount> {
    match side {
        Side::Sell if extreme <= trail => None,
        Side::Sell => extreme.checked_sub(trail),
        Side::Buy => extreme.checked_add(trail),
    }
}

/// `triggerTightened`: a sell tightens by raising its trigger, a buy by lowering it.
fn tightened(side: Side, next: Amount, current: Amount) -> bool {
    match side {
        Side::Sell => next > current,
        Side::Buy => next < current,
    }
}

/// `markRefuse`: none, or not positive, is no mark.
pub fn mark_refuse(mark: Option<Amount>) -> Option<Reject> {
    match mark {
        Some(m) if m > 0 => None,
        _ => Some(Reject::new(
            MARK_MISSING,
            "a trailing stop walks with the mark; the engine does not invent a mark",
        )),
    }
}

/// What a mark did to one book: refused, or whether a peak or a trigger moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkWalk {
    pub refused: Option<Reject>,
    pub changed: bool,
}

/// `wantsOcoCancel`, for the parts an order of this port can carry (an option, an exercise, a cover, an expire, a
/// replace, an amend, a strike or an expiry is another slice's and never reaches a book here).
fn wants_oco_cancel(order: &EngineOrder) -> bool {
    let x = &order.exits;
    if !x.cancel {
        return false;
    }
    let truthy = |v: &Opt<String>| v.value().is_some_and(|s| !s.is_empty());
    x.oco
        || x.take_profit.present()
        || x.stop_loss.present()
        || order.oco_sibling_id.as_ref().is_some_and(|s| !s.is_empty())
        || truthy(&x.take_profit_order_id)
        || truthy(&x.stop_loss_order_id)
}

/// `wantsOco`.
fn wants_oco(x: &Exits) -> bool {
    x.oco || x.take_profit.present() || x.stop_loss.present()
}

impl OrderBook {
    /// Place one order through every wrapper, outermost first. `now` is the engine clock in milliseconds, when it has
    /// one.
    pub fn submit(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        self.spread_submit(order, now)
    }

    /// The trigger wrappers' submit, under the spread and combo layers and over the option layer: the TypeScript's
    /// imports install `option.ts` before these, and `combo-book.ts` and `spread-book.ts` after them.
    pub(super) fn triggers_submit(
        &mut self,
        order: &EngineOrder,
        now: Option<i64>,
    ) -> SubmitResult {
        self.submit_trailing(order, now)
    }

    /// Amend one order: the core book's amend, then any bracket entry it traded arms its exits (`installBracket`'s
    /// amend). The exits it rests take no clock, as the TypeScript passes none.
    pub fn amend(&mut self, cmd: &EngineAmend, now: Option<i64>) -> AmendResult {
        self.spread_amend(cmd, now)
    }

    /// `installBracket`'s amend, under the spread layer and over the option layer.
    pub(super) fn bracket_amend(&mut self, cmd: &EngineAmend, now: Option<i64>) -> AmendResult {
        let amended = self.option_amend(cmd, now);
        if !amended.accepted {
            return amended;
        }
        let viewed = SubmitResult {
            accepted: amended.accepted,
            sequence: amended.sequence,
            fills: amended.fills.clone(),
            resting: amended.resting.clone(),
            rejected: amended.rejected.clone(),
            cancellations: amended.cancellations.clone(),
            triggered: amended.triggered.clone(),
            surveillance_cases: amended.surveillance_cases.clone(),
        };
        let Some(combined) = self.rest_exits_for_fills(&viewed, None) else {
            return amended;
        };
        AmendResult {
            accepted: combined.accepted,
            sequence: combined.sequence.or(amended.sequence),
            fills: combined.fills,
            resting: combined.resting,
            rejected: combined.rejected.or(amended.rejected),
            cancellations: combined.cancellations,
            triggered: combined.triggered,
            surveillance_cases: combined.surveillance_cases,
            ..amended
        }
    }

    // ── trailing stops ──────────────────────────────────────────────────

    /// `installTrailingStop`'s submit: a trailing stop needs a positive trail and mark, and rests as a market stop at
    /// its first walked trigger.
    fn submit_trailing(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        if !order.trail.present() {
            return self.submit_bracket(order, now);
        }
        let Some(trail) = positive(&order.trail) else {
            return rejected(
                TRAIL_MISSING,
                "a trailing stop requires a trail; the engine does not invent a distance",
            );
        };
        let mark = order.mark.get();
        if let Some(r) = mark_refuse(mark) {
            return SubmitResult::refused(r);
        }
        let mark = mark.unwrap_or_default();
        let Some(stop_price) = walk_stop(order.side, mark, trail).filter(|p| *p > 0) else {
            return rejected(
                "invalid_price",
                "trailing stop would not be a positive trigger; the engine does not invent a mark",
            );
        };
        let mut stop = order.clone();
        stop.order_type = OrderType::Stop;
        stop.price = None;
        stop.stop_price = Some(stop_price);
        let result = self.submit_bracket(&stop, now);
        if result.accepted && !self.triggers.trail_rows.contains(&order.order_id) {
            self.triggers.trail_rows.push(order.order_id.clone());
        }
        result
    }

    /// `applyMark`: walk every live trailing stop with an injected mark. The peak only ratchets and the trigger only
    /// tightens, so a repeated or older mark changes nothing. `changed` is true only when a peak or a trigger moved.
    pub fn apply_mark(&mut self, mark: Option<Amount>) -> MarkWalk {
        if let Some(r) = mark_refuse(mark) {
            return MarkWalk {
                refused: Some(r),
                changed: false,
            };
        }
        let mark = mark.unwrap_or_default();
        // `rowsFor`: a restored book has no rows, so they are rebuilt from the stops that already walk.
        let walking = self.trailing_stops();
        for s in &walking {
            if !self.triggers.trail_rows.contains(&s.order_id) {
                self.triggers.trail_rows.push(s.order_id.clone());
            }
        }
        let mut changed = false;
        let rows = self.triggers.trail_rows.clone();
        for order_id in rows {
            let Some(stop) = self
                .trailing_stops()
                .into_iter()
                .find(|s| s.order_id == order_id)
            else {
                // Gone, or no longer walking: the row goes (a row the TypeScript keeps for a stop whose peak it could
                // not note is rebuilt from the stop the next time anyway).
                if !self
                    .live_orders()
                    .iter()
                    .any(|o| o.order_id == order_id && o.kind == RestKind::Stop)
                {
                    self.triggers.trail_rows.retain(|id| *id != order_id);
                }
                continue;
            };
            let peak = ratchet_peak(stop.side, Some(stop.peak), mark);
            let Some(next) = walk_stop(stop.side, peak, stop.trail).filter(|n| *n > 0) else {
                continue;
            };
            if !tightened(stop.side, next, stop.stop_price) {
                if peak != stop.peak && self.note_stop_peak(&order_id, peak) {
                    changed = true;
                }
                continue;
            }
            let amended = self.amend(
                &EngineAmend {
                    order_id: order_id.clone(),
                    expected_version: stop.version.max(1),
                    stop_price: Some(next),
                    ..EngineAmend::default()
                },
                None,
            );
            if !amended.accepted {
                continue;
            }
            if !self.note_stop_peak(&order_id, peak) {
                self.triggers.trail_rows.retain(|id| *id != order_id);
                continue;
            }
            changed = true;
        }
        MarkWalk {
            refused: None,
            changed,
        }
    }

    // ── brackets ────────────────────────────────────────────────────────

    /// `installBracket`'s submit.
    fn submit_bracket(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        let armed_before: Vec<String> = self
            .triggers
            .live_exits
            .iter()
            .map(|(tp, _)| tp.clone())
            .collect();
        let x = &order.exits;
        if x.bracket.get() != Some(true) {
            let result = self.submit_oco_link(order, now);
            let result = self.rest_exits_for_fills(&result, now).unwrap_or(result);
            return self.pull_live_stop(result, &armed_before);
        }
        // `entryRefuse`: a market entry needs no price; any other needs a positive one.
        if order.order_type != OrderType::Market && order.price.is_none_or(|p| p <= 0) {
            return rejected(
                "missing_price",
                "a bracket entry is missing; the engine does not invent a trigger",
            );
        }
        let Some(take_profit) = positive(&x.take_profit) else {
            return rejected(
                STOP_PX_MISSING,
                "a bracket take-profit is missing; the engine does not invent a trigger",
            );
        };
        let Some(stop_loss) = positive(&x.stop_loss) else {
            return rejected(
                STOP_PX_MISSING,
                "a bracket stop-loss is missing; the engine does not invent a trigger",
            );
        };
        let tp_id =
            named(&x.take_profit_order_id).unwrap_or_else(|| format!("{}:tp", order.order_id));
        let sl_id =
            named(&x.stop_loss_order_id).unwrap_or_else(|| format!("{}:sl", order.order_id));
        // `baseEntry`: the entry without its exit parts (a linked cancel's flag rides on).
        let mut entry_order = order.clone();
        entry_order.exits = Exits {
            cancel: x.cancel,
            ..Exits::default()
        };
        entry_order.mark = Opt::Absent;
        let entry = self.submit_oco_link(&entry_order, now);
        if !entry.accepted {
            return entry;
        }
        let rec = PendingBracket {
            take_profit,
            stop_loss,
            tp_id,
            sl_id,
            side: order.side,
            qty: order.qty,
            traded: 0,
            account_id: order.account_id.clone(),
            tif: order.tif,
        };
        match self
            .triggers
            .pending
            .iter_mut()
            .find(|(id, _)| *id == order.order_id)
        {
            Some((_, slot)) => *slot = rec,
            None => self.triggers.pending.push((order.order_id.clone(), rec)),
        }
        let result = self.rest_exits_for_fills(&entry, now).unwrap_or(entry);
        self.pull_live_stop(result, &armed_before)
    }

    /// `restExits`: rest the take-profit, then the stop-loss for the size still open. A refused stop pulls the
    /// take-profit back and keeps the fills it already made.
    fn rest_exits(&mut self, rec: &PendingBracket, now: Option<i64>) -> SubmitResult {
        let side = opposite(rec.side);
        let mut tp_order = EngineOrder::new(
            rec.tp_id.clone(),
            rec.account_id.clone(),
            OrderType::Limit,
            side,
            rec.qty,
            Some(rec.take_profit),
            exit_tif(rec.tif),
        );
        tp_order.oco_sibling_id = Some(rec.sl_id.clone());
        let tp = self.submit_oco_link(&tp_order, now);
        if !tp.accepted {
            return tp;
        }
        // A partial take-profit has already sold: the stop covers only what is still open.
        let sold: Amount = all_fills(&tp)
            .iter()
            .filter(|f| touches(f, &rec.tp_id))
            .map(|f| f.qty)
            .sum();
        let stop_qty = if sold > 0 && sold < rec.qty {
            rec.qty - sold
        } else {
            rec.qty
        };
        let mut sl_order = EngineOrder::new(
            rec.sl_id.clone(),
            rec.account_id.clone(),
            OrderType::Stop,
            side,
            stop_qty,
            None,
            exit_tif(rec.tif),
        );
        sl_order.stop_price = Some(rec.stop_loss);
        sl_order.oco_sibling_id = Some(rec.tp_id.clone());
        let sl = self.submit_oco_link(&sl_order, now);
        if !sl.accepted {
            let rollback = self.cancel(&rec.tp_id, CancelReason::Requested);
            let mut fills = tp.fills;
            fills.extend(sl.fills);
            let mut cancellations = tp.cancellations;
            cancellations.extend(sl.cancellations);
            cancellations.extend(rollback.cancellation);
            let mut triggered = tp.triggered;
            triggered.extend(sl.triggered);
            let mut surveillance_cases = tp.surveillance_cases;
            surveillance_cases.extend(sl.surveillance_cases);
            return SubmitResult {
                accepted: false,
                sequence: sl.sequence.or(tp.sequence),
                fills,
                resting: None,
                rejected: sl.rejected,
                cancellations,
                triggered,
                surveillance_cases,
            };
        }
        if self.is_live_id(&rec.tp_id) && self.is_live_id(&rec.sl_id) {
            match self
                .triggers
                .live_exits
                .iter_mut()
                .find(|(tp_id, _)| *tp_id == rec.tp_id)
            {
                Some((_, slot)) => *slot = rec.sl_id.clone(),
                None => self
                    .triggers
                    .live_exits
                    .push((rec.tp_id.clone(), rec.sl_id.clone())),
            }
        }
        let pulled_tp = sl.cancellations.iter().any(|c| c.order_id == rec.tp_id);
        let resting = if pulled_tp {
            sl.resting
        } else {
            tp.resting.or(sl.resting)
        };
        let mut fills = tp.fills;
        fills.extend(sl.fills);
        let mut cancellations = tp.cancellations;
        cancellations.extend(sl.cancellations);
        let mut triggered = tp.triggered;
        triggered.extend(sl.triggered);
        let mut surveillance_cases = tp.surveillance_cases;
        surveillance_cases.extend(sl.surveillance_cases);
        SubmitResult {
            accepted: true,
            sequence: sl.sequence.or(tp.sequence),
            fills,
            resting,
            rejected: None,
            cancellations,
            triggered,
            surveillance_cases,
        }
    }

    fn is_live_id(&self, order_id: &str) -> bool {
        self.live_orders().iter().any(|o| o.order_id == order_id)
    }

    /// `restExitsForFills`: each bracket entry the result traded, and that has left the book, arms its exits for the
    /// size it traded; an exit's own fills are read again for the next entry. None when nothing was armed.
    fn rest_exits_for_fills(
        &mut self,
        result: &SubmitResult,
        now: Option<i64>,
    ) -> Option<SubmitResult> {
        if self.triggers.pending.is_empty() {
            return None;
        }
        let mut combined: Option<SubmitResult> = None;
        let mut incoming = all_fills(result);
        let mut seen: Vec<(u64, String, String)> = Vec::new();
        let mut filled_this_wave: Vec<String> = Vec::new();
        loop {
            for fill in &incoming {
                let key = (
                    fill.sequence,
                    fill.maker_order_id.clone(),
                    fill.taker_order_id.clone(),
                );
                if seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                for order_id in [&fill.maker_order_id, &fill.taker_order_id] {
                    if let Some((_, rec)) = self
                        .triggers
                        .pending
                        .iter_mut()
                        .find(|(id, _)| id == order_id)
                    {
                        rec.traded += fill.qty;
                        if !filled_this_wave.contains(order_id) {
                            filled_this_wave.push(order_id.clone());
                        }
                    }
                }
            }
            let live: Vec<String> = self.live_orders().into_iter().map(|o| o.order_id).collect();
            let mut armed: Option<SubmitResult> = None;
            for (order_id, rec) in self.triggers.pending.clone() {
                if live.contains(&order_id) {
                    continue;
                }
                self.triggers.pending.retain(|(id, _)| *id != order_id);
                if !filled_this_wave.contains(&order_id) || rec.traded <= 0 {
                    continue;
                }
                let traded = PendingBracket {
                    qty: rec.traded,
                    ..rec
                };
                armed = Some(self.rest_exits(&traded, now));
                break;
            }
            let Some(armed) = armed else {
                break;
            };
            incoming = all_fills(&armed);
            let base = combined.take().unwrap_or_else(|| result.clone());
            combined = Some(merge(base, armed));
        }
        combined
    }

    /// `pullLiveStop`: a take-profit armed before this submit that traded in it pulls its stop, which the book's own
    /// sibling rule no longer finds once the take-profit has left.
    fn pull_live_stop(
        &mut self,
        mut result: SubmitResult,
        armed_before: &[String],
    ) -> SubmitResult {
        if self.triggers.live_exits.is_empty() || armed_before.is_empty() {
            return result;
        }
        let fills = all_fills(&result);
        let live: Vec<String> = self.live_orders().into_iter().map(|o| o.order_id).collect();
        for tp_id in armed_before {
            let Some(sl_id) = self
                .triggers
                .live_exits
                .iter()
                .find(|(id, _)| id == tp_id)
                .map(|(_, sl)| sl.clone())
            else {
                continue;
            };
            let filled = fills.iter().any(|f| touches(f, tp_id));
            if !filled {
                if !live.contains(tp_id) || !live.contains(&sl_id) {
                    self.triggers.live_exits.retain(|(id, _)| id != tp_id);
                }
                continue;
            }
            self.triggers.live_exits.retain(|(id, _)| id != tp_id);
            if !live.contains(&sl_id) {
                continue;
            }
            if let Some(c) = self
                .cancel(&sl_id, CancelReason::OcoSiblingFilled)
                .cancellation
            {
                result.cancellations.push(c);
            }
        }
        result
    }

    // ── OCO ─────────────────────────────────────────────────────────────

    /// `installOcoLink`'s submit: a linked cancel first, then an OCO's two legs, rehearsed on a copy so a refused
    /// take-profit never leaves the stop's fills on the live book.
    fn submit_oco_link(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        if wants_oco_cancel(order) {
            return self.oco_cancel(order);
        }
        let x = &order.exits;
        if !wants_oco(x) {
            return self.option_submit(order, now);
        }
        let Some(take_profit) = positive(&x.take_profit) else {
            return rejected(
                STOP_PX_MISSING,
                "an OCO take-profit is missing; the engine does not invent a trigger",
            );
        };
        let Some(stop_loss) = positive(&x.stop_loss) else {
            return rejected(
                STOP_PX_MISSING,
                "an OCO stop-loss is missing; the engine does not invent a trigger",
            );
        };
        let id_or = |v: &Opt<String>, suffix: &str| {
            v.value()
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("{}:{suffix}", order.order_id))
        };
        let tp_id = id_or(&x.take_profit_order_id, "tp");
        let sl_id = id_or(&x.stop_loss_order_id, "sl");
        // A limit that is present but not positive refuses: a market stop would drop the worst price asked for.
        if x.stop_loss_limit.get().is_some_and(|l| l <= 0) {
            return rejected(
                "invalid_price",
                "an OCO stop-loss limit must be positive; the engine does not fall back to a market stop",
            );
        }
        let stop_limit = x.stop_loss_limit.get();
        // `baseOrder`: the order without its OCO parts (a bracket flag and a linked cancel's flag ride on).
        let mut base = order.clone();
        base.exits = Exits {
            bracket: x.bracket.clone(),
            cancel: x.cancel,
            ..Exits::default()
        };
        let mut sl_leg = base.clone();
        sl_leg.order_id = sl_id.clone();
        sl_leg.order_type = if stop_limit.is_some() {
            OrderType::StopLimit
        } else {
            OrderType::Stop
        };
        sl_leg.price = stop_limit;
        sl_leg.stop_price = Some(stop_loss);
        sl_leg.oco_sibling_id = Some(tp_id.clone());
        let mut tp_leg = base;
        tp_leg.order_id = tp_id;
        tp_leg.order_type = OrderType::Limit;
        tp_leg.price = Some(take_profit);
        tp_leg.stop_price = None;
        tp_leg.oco_sibling_id = Some(sl_id.clone());

        let mut rehearsal = match self.rehearsal_copy() {
            Ok(copy) => copy,
            Err(e) => return rejected("book_unreadable", &e.to_string()),
        };
        let rehearsed_sl = rehearsal.submit_oco_cancel(&sl_leg, now);
        if rehearsed_sl.accepted {
            let rehearsed_tp = rehearsal.submit_oco_cancel(&tp_leg, now);
            if !rehearsed_tp.accepted {
                return SubmitResult {
                    accepted: false,
                    sequence: rehearsed_tp.sequence,
                    rejected: rehearsed_tp.rejected,
                    ..SubmitResult::default()
                };
            }
        }

        let sl = self.submit_oco_cancel(&sl_leg, now);
        if !sl.accepted {
            return sl;
        }
        let tp = self.submit_oco_cancel(&tp_leg, now);
        if !tp.accepted {
            let pulled = self.cancel(&sl_id, CancelReason::Requested);
            // A missed cancel leaves the stop on the book: say where it rests rather than claim a clean book.
            let resting = match pulled.cancellation {
                Some(_) => None,
                None => self.live_resting(&sl_id),
            };
            let mut fills = sl.fills;
            fills.extend(tp.fills);
            let mut cancellations = sl.cancellations;
            cancellations.extend(pulled.cancellation);
            cancellations.extend(tp.cancellations);
            let mut triggered = sl.triggered;
            triggered.extend(tp.triggered);
            let mut surveillance_cases = sl.surveillance_cases;
            surveillance_cases.extend(tp.surveillance_cases);
            return SubmitResult {
                accepted: false,
                sequence: sl.sequence.or(pulled.sequence).or(tp.sequence),
                fills,
                resting,
                rejected: tp.rejected,
                cancellations,
                triggered,
                surveillance_cases,
            };
        }
        let mut fills = sl.fills;
        fills.extend(tp.fills);
        let mut cancellations = sl.cancellations;
        cancellations.extend(tp.cancellations);
        let mut triggered = sl.triggered;
        triggered.extend(tp.triggered);
        let mut surveillance_cases = sl.surveillance_cases;
        surveillance_cases.extend(tp.surveillance_cases);
        SubmitResult {
            accepted: true,
            sequence: tp.sequence.or(sl.sequence),
            fills,
            resting: tp.resting,
            rejected: None,
            cancellations,
            triggered,
            surveillance_cases,
        }
    }

    /// `installOcoCancel`'s submit, the wrapper just above the core book.
    fn submit_oco_cancel(&mut self, order: &EngineOrder, now: Option<i64>) -> SubmitResult {
        if wants_oco_cancel(order) {
            return self.oco_cancel(order);
        }
        self.option_submit(order, now)
    }

    /// `liveResting`: where an order still rests, as a resting reference.
    fn live_resting(&self, order_id: &str) -> Option<RestingRef> {
        self.live_orders()
            .into_iter()
            .find(|o| o.order_id == order_id)
            .map(|o| RestingRef {
                kind: o.kind,
                order_id: o.order_id,
                account_id: o.account_id,
                side: o.side,
                price: o.price,
                remaining: o.remaining,
                sequence: o.sequence,
                version: o.version,
            })
    }

    /// `readOcoPair`: both ids when the caller named both, the order stores a live sibling, or the caller named its
    /// sibling; sorted. One named side with nothing linked is none: never `orderId:tp`.
    fn read_oco_pair(&self, order: &EngineOrder) -> Option<(String, String)> {
        let sort = |a: String, b: String| {
            if js_sort_cmp(&a, &b).is_lt() {
                (a, b)
            } else {
                (b, a)
            }
        };
        let x = &order.exits;
        if let (Some(tp), Some(sl)) = (named(&x.take_profit_order_id), named(&x.stop_loss_order_id))
            && tp != sl
        {
            return Some(sort(tp, sl));
        }
        if let Some(sibling) = self.live_sibling(&order.order_id)
            && sibling != order.order_id
        {
            return Some(sort(order.order_id.clone(), sibling));
        }
        let named_sibling = order
            .oco_sibling_id
            .as_ref()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        if let Some(sibling) = named_sibling
            && sibling != order.order_id
        {
            return Some(sort(order.order_id.clone(), sibling));
        }
        None
    }

    /// `ocoCancelResult`: cancel both live siblings, or refuse when either is already gone.
    fn oco_cancel(&mut self, order: &EngineOrder) -> SubmitResult {
        let Some((a, b)) = self.read_oco_pair(order) else {
            return rejected(
                "order_not_found",
                "a linked OCO requires both siblings; the engine does not invent a trigger",
            );
        };
        let live = [self.is_live_id(&a), self.is_live_id(&b)];
        match live.iter().filter(|l| **l).count() {
            2 => {}
            1 => {
                return rejected(
                    "oco_sibling_terminal",
                    "an OCO sibling is already terminal; the engine does not invent a trigger",
                );
            }
            _ => {
                return rejected(
                    "order_not_found",
                    "a linked OCO requires both siblings; the engine does not invent a trigger",
                );
            }
        }
        let mut cancellations: Vec<CancelledRef> = Vec::new();
        let mut sequence = None;
        for id in [a, b] {
            let pulled = self.cancel(&id, CancelReason::Requested);
            if let Some(c) = pulled.cancellation {
                cancellations.push(c);
                sequence = pulled.sequence.or(sequence);
            }
        }
        SubmitResult {
            accepted: true,
            sequence,
            cancellations,
            ..SubmitResult::default()
        }
    }
}
