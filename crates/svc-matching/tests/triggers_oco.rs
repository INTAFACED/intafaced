//! The `triggers` slice's OCO, proven with the TypeScript's own tests ported test for test: `oco.test.ts`,
//! `oco-link.test.ts`, `oco-link.atomic-reject.test.ts`, `oco-cancel.test.ts`, `oco-stop-limit.test.ts` and
//! `oco-replay.test.ts` (all under `services/svc-matching/src/engine/`). Each test is named after the TypeScript `it`
//! it ports, prefixed with its file's topic.
//!
//! Every TypeScript file here runs with the whole wrapper chain installed (`journal.ts` imports `trailing-stop.ts`,
//! which imports `oco-link.ts`, `oco-cancel.ts` and `bracket.ts`; each `install*` is guarded by its flag, so a test's
//! second call changes nothing). The Rust `OrderBook::submit` is that one chain, so every test submits through it.
//! The TypeScript `replay` hands back books; here it is `replay_journal` over a plain map of `OrderBook`s ([`Books`]),
//! as `tests/engine.rs` does.
//!
//! Not ported as written, and why:
//! - `oco-link.test.ts` "read helpers treat missing and zero as not set" and `oco-cancel.test.ts` "read helpers treat a
//!   missing pair as not set" call `wantsOco`, `readTakeProfit`, `readStopLoss`, `takeProfitRefuse`, `stopLossRefuse`,
//!   `wantsOcoCancel`, `readOcoPair` and `ocoCancelRefuse` directly. In Rust these are private to
//!   `src/book/triggers.rs`, so each assertion is made instead on what the helper decides at `OrderBook::submit`, the
//!   one door that reaches it (the same codes and messages). One assertion has no Rust form at all:
//!   `wantsOcoCancel` with `type: 'option'`, since the Rust `OrderType` has no option (an option order is the
//!   `spreads` slice's and never reaches a book here).
//! - `oco-cancel.test.ts` "does not invent a sibling id when only one side is named" also calls `readOcoPair` directly;
//!   the submit right after it in the same test makes the same decision observable, and is ported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::HashMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::types::{
    CancelReason, EngineOrder, Opt, OrderType, RestKind, Side, SubmitResult, Tif,
};
use svc_matching::book::wire::{from_wire, to_wire};
use svc_matching::journal::replay::{ReplayBooks, ReplayCancel, js_sort_cmp, replay_journal};
use svc_matching::journal::{
    EngineJournal as _, JournalCommand, JournalRecord, MemoryJournal, decode_all, encode,
};

const MARKET: &str = "BTC/USDT";
const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIQ: &str = "11111111-1111-4111-8111-111111111111";
const TP: &str = "22222222-2222-4222-8222-222222222222";
const SL: &str = "33333333-3333-4333-8333-333333333333";
const PRINT: &str = "44444444-4444-4444-8444-444444444444";
const BID: &str = "55555555-5555-4555-8555-555555555555";

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

// ── orders ──────────────────────────────────────────────────────────────

/// What a test names in the TypeScript `order(spec)`; the rest defaults the way it defaults: account `desk`, GTC,
/// market when no price is named and limit otherwise.
#[derive(Default, Clone)]
struct Spec {
    id: &'static str,
    account: Option<&'static str>,
    ty: Option<OrderType>,
    side: Option<Side>,
    qty: &'static str,
    price: Option<&'static str>,
    stop_price: Option<&'static str>,
    tif: Option<Tif>,
    oco: Option<bool>,
    cancel: bool,
    take_profit: Opt<&'static str>,
    stop_loss: Opt<&'static str>,
    take_profit_order_id: Option<&'static str>,
    stop_loss_order_id: Option<&'static str>,
    oco_sibling_id: Option<&'static str>,
    mark: Option<&'static str>,
}

fn spec(id: &'static str, side: Side, qty: &'static str) -> Spec {
    Spec {
        id,
        side: Some(side),
        qty,
        ..Spec::default()
    }
}

impl Spec {
    fn acct(mut self, v: &'static str) -> Spec {
        self.account = Some(v);
        self
    }
    fn ty(mut self, v: OrderType) -> Spec {
        self.ty = Some(v);
        self
    }
    fn price(mut self, v: &'static str) -> Spec {
        self.price = Some(v);
        self
    }
    fn stop(mut self, v: &'static str) -> Spec {
        self.stop_price = Some(v);
        self
    }
    fn tif(mut self, v: Tif) -> Spec {
        self.tif = Some(v);
        self
    }
    fn oco(mut self) -> Spec {
        self.oco = Some(true);
        self
    }
    fn cancel(mut self) -> Spec {
        self.cancel = true;
        self
    }
    fn tp(mut self, v: &'static str) -> Spec {
        self.take_profit = Opt::Some(v);
        self
    }
    fn sl(mut self, v: &'static str) -> Spec {
        self.stop_loss = Opt::Some(v);
        self
    }
    fn tp_null(mut self) -> Spec {
        self.take_profit = Opt::Null;
        self
    }
    fn sl_null(mut self) -> Spec {
        self.stop_loss = Opt::Null;
        self
    }
    fn tp_id(mut self, v: &'static str) -> Spec {
        self.take_profit_order_id = Some(v);
        self
    }
    fn sl_id(mut self, v: &'static str) -> Spec {
        self.stop_loss_order_id = Some(v);
        self
    }
    fn sibling(mut self, v: &'static str) -> Spec {
        self.oco_sibling_id = Some(v);
        self
    }
    fn mark(mut self, v: &'static str) -> Spec {
        self.mark = Some(v);
        self
    }
}

fn amount_opt(v: &Opt<&'static str>) -> Opt<Amount> {
    match v {
        Opt::Absent => Opt::Absent,
        Opt::Null => Opt::Null,
        Opt::Some(s) => Opt::Some(a(s)),
    }
}

/// `order(spec)`.
fn order(s: &Spec) -> EngineOrder {
    let ty = s.ty.unwrap_or(if s.price.is_none() {
        OrderType::Market
    } else {
        OrderType::Limit
    });
    let mut o = EngineOrder::new(
        s.id,
        s.account.unwrap_or("desk"),
        ty,
        s.side.unwrap(),
        a(s.qty),
        s.price.map(a),
        s.tif.unwrap_or(Tif::Gtc),
    );
    o.stop_price = s.stop_price.map(a);
    o.oco_sibling_id = s.oco_sibling_id.map(str::to_owned);
    o.exits.oco = s.oco == Some(true);
    o.exits.cancel = s.cancel;
    o.exits.take_profit = amount_opt(&s.take_profit);
    o.exits.stop_loss = amount_opt(&s.stop_loss);
    if let Some(id) = s.take_profit_order_id.filter(|v| !v.is_empty()) {
        o.exits.take_profit_order_id = Opt::Some(id.to_owned());
    }
    if let Some(id) = s.stop_loss_order_id.filter(|v| !v.is_empty()) {
        o.exits.stop_loss_order_id = Opt::Some(id.to_owned());
    }
    if let Some(m) = s.mark {
        o.mark = Opt::Some(a(m));
    }
    o
}

fn submit(book: &mut OrderBook, s: &Spec) -> SubmitResult {
    book.submit(&order(s), None)
}

// ── reading a book ──────────────────────────────────────────────────────

fn list(j: Option<&Json>) -> &[Json] {
    match j {
        Some(Json::Array(xs)) => xs,
        other => panic!("a list, got {other:?}"),
    }
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is text, got {other:?}"),
    }
}

/// The ids resting on one side of `toState()`, level by level.
fn side_ids(state: &Json, side: &str) -> Vec<String> {
    list(state.get(side))
        .iter()
        .flat_map(|level| list(level.get("orders")).iter().map(|o| text(o, "orderId")))
        .collect()
}

fn stops(state: &Json) -> &[Json] {
    list(state.get("stops"))
}

fn stop_ids(state: &Json) -> Vec<String> {
    stops(state).iter().map(|s| text(s, "orderId")).collect()
}

/// `liveIds(book)`: bids, asks and stops from `toState()`, sorted as JavaScript's `sort()` sorts.
fn live_ids(book: &OrderBook) -> Vec<String> {
    let state = book.to_state();
    let mut ids = side_ids(&state, "bids");
    ids.extend(side_ids(&state, "asks"));
    ids.extend(stop_ids(&state));
    ids.sort_by(|x, y| js_sort_cmp(x, y));
    ids
}

/// `[...ids].sort()`.
fn sorted(ids: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = ids.iter().map(|s| (*s).to_owned()).collect();
    out.sort_by(|x, y| js_sort_cmp(x, y));
    out
}

fn cancels(r: &SubmitResult) -> Vec<(String, String)> {
    r.cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason.as_str().to_owned()))
        .collect()
}

fn cancels_sorted(r: &SubmitResult) -> Vec<(String, String)> {
    let mut out = cancels(r);
    out.sort_by(|x, y| js_sort_cmp(&format!("{},{}", x.0, x.1), &format!("{},{}", y.0, y.1)));
    out
}

fn pair(id: &str, reason: CancelReason) -> (String, String) {
    (id.to_owned(), reason.as_str().to_owned())
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|x| x.code.as_str())
}

fn message(r: &SubmitResult) -> &str {
    &r.rejected.as_ref().unwrap().message
}

// ── replay over plain books (`replay`) ──────────────────────────────────

#[derive(Default)]
struct Books(HashMap<String, OrderBook>);

impl Books {
    fn drop_if_never_traded(&mut self, market_id: &str) {
        if self
            .0
            .get(market_id)
            .is_some_and(OrderBook::is_never_printed_empty)
        {
            self.0.remove(market_id);
        }
    }

    fn get(&self, market_id: &str) -> Option<&OrderBook> {
        self.0.get(market_id)
    }
}

impl ReplayBooks for Books {
    fn has_market(&self, market_id: &str) -> bool {
        self.0.contains_key(market_id)
    }

    fn submit(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        let o = from_wire(record.field("order").unwrap()).unwrap();
        self.0
            .entry(market_id.to_owned())
            .or_insert_with(|| OrderBook::new(market_id))
            .submit(&o, clock);
        self.drop_if_never_traded(market_id);
    }

    fn amend(&mut self, _market_id: &str, _record: &JournalRecord, _clock: Option<i64>) {
        panic!("these tapes hold only submits");
    }

    fn mark(&mut self, _market_id: &str, _record: &JournalRecord) {
        panic!("these tapes hold only submits");
    }

    fn mass_cancel(&mut self, _market_id: &str, _record: &JournalRecord) {
        panic!("these tapes hold only submits");
    }

    fn cancel(&mut self, _market_id: &str, _record: &JournalRecord, _why: ReplayCancel<'_>) {
        panic!("these tapes hold only submits");
    }

    fn session_dead(&mut self, _session_id: &Json) {
        panic!("these tapes hold only submits");
    }
}

/// `replay(records)`.
fn replay(records: &[JournalRecord]) -> Books {
    let mut books = Books::default();
    replay_journal(records, &mut books).unwrap();
    books
}

/// `{ kind: 'submit', marketId, at, seq: 1, order: toWire(order) }`.
fn submit_record(order: &EngineOrder) -> JournalRecord {
    JournalRecord(Json::obj([
        ("kind", Json::str("submit")),
        ("marketId", Json::str(MARKET)),
        ("at", Json::str("2026-10-19T08:00:00.000Z")),
        ("seq", Json::int(1)),
        ("order", to_wire(order, None)),
    ]))
}

/// `decodeAll(records.map(encode).join('\n'))`.
fn on_disk(records: &[JournalRecord]) -> Vec<JournalRecord> {
    let lines: Vec<String> = records.iter().map(|r| encode(r).unwrap()).collect();
    decode_all(&lines.join("\n")).unwrap()
}

// ── oco.test.ts: OCO — rest a linked TP+SL ──────────────────────────────

#[test]
fn oco_rests_both_legs_on_the_existing_stop_book_without_inventing_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    let tp = submit(
        &mut book,
        &spec(TP, Side::Sell, "1")
            .ty(OrderType::StopLimit)
            .price("110")
            .stop("110")
            .sibling(SL),
    );
    let sl = submit(
        &mut book,
        &spec(SL, Side::Sell, "1")
            .ty(OrderType::Stop)
            .stop("90")
            .sibling(TP),
    );

    assert!(tp.accepted);
    assert!(sl.accepted);
    assert_eq!(tp.resting.as_ref().map(|r| r.kind), Some(RestKind::Stop));
    assert_eq!(sl.resting.as_ref().map(|r| r.kind), Some(RestKind::Stop));
    assert_eq!(tp.fills.len(), 0);
    assert_eq!(sl.fills.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[SL, TP]));
    // No last print — existing trigger rule leaves both resting.
    assert_eq!(book.last_price(), None);
}

#[test]
fn oco_first_fill_of_the_tp_cancels_the_resting_sl_sibling() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    submit(
        &mut book,
        &spec(SL, Side::Sell, "1")
            .ty(OrderType::Stop)
            .stop("90")
            .sibling(TP),
    );
    let tp = submit(
        &mut book,
        &spec(TP, Side::Sell, "1")
            .acct("desk")
            .price("110")
            .sibling(SL),
    );

    assert!(tp.accepted);
    assert_eq!(tp.fills.len(), 1);
    assert_eq!(f(tp.fills[0].qty), "1");
    assert_eq!(cancels(&tp), vec![pair(SL, CancelReason::OcoSiblingFilled)]);
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

#[test]
fn oco_first_fill_of_the_sl_cancels_the_tp_sibling_before_the_tp_can_also_fire() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec("bid-100", Side::Buy, "5").acct("mm").price("100"),
    );
    submit(
        &mut book,
        &spec("bid-90", Side::Buy, "5").acct("mm").price("90"),
    );
    submit(&mut book, &spec("warmup", Side::Sell, "5").acct("warmup")); // last = 100

    // TP is a resting sell limit above last — the engine does not invent an upside-stop trigger. SL is the existing
    // sell-stop on the way down.
    submit(
        &mut book,
        &spec(TP, Side::Sell, "1").price("110").sibling(SL),
    );
    submit(
        &mut book,
        &spec(SL, Side::Sell, "1")
            .ty(OrderType::Stop)
            .stop("95")
            .sibling(TP),
    );

    let print = submit(&mut book, &spec("crash", Side::Sell, "1").acct("taker")); // prints 90

    assert_eq!(
        print
            .triggered
            .iter()
            .map(|t| t.order_id.as_str())
            .collect::<Vec<_>>(),
        vec![SL]
    );
    let sl = &print.triggered[0];
    assert!(!sl.fills.is_empty());
    assert!(
        sl.cancellations
            .iter()
            .any(|c| c.order_id == TP && c.reason == CancelReason::OcoSiblingFilled),
        "{:?}",
        sl.cancellations
    );
    assert!(!live_ids(&book).contains(&TP.to_owned()));
    assert!(!live_ids(&book).contains(&SL.to_owned()));
}

#[test]
fn oco_refuses_the_second_leg_when_its_sibling_is_already_terminal() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    let first = submit(
        &mut book,
        &spec(TP, Side::Sell, "1")
            .acct("desk")
            .price("110")
            .sibling(SL),
    );
    assert!(first.accepted);
    assert_eq!(first.fills.len(), 1);

    let second = submit(
        &mut book,
        &spec(SL, Side::Sell, "1")
            .ty(OrderType::Stop)
            .stop("90")
            .sibling(TP),
    );

    assert!(!second.accepted);
    assert_eq!(code(&second), Some("oco_sibling_terminal"));
    assert_eq!(second.fills.len(), 0);
    assert_eq!(
        book.current_sequence(),
        first.sequence.unwrap() + u64::try_from(first.fills.len()).unwrap()
    );
}

#[test]
fn oco_refuses_a_self_linked_sibling() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &spec(TP, Side::Sell, "1").price("110").sibling(TP),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("invalid_oco_sibling"));
    assert_eq!(book.current_sequence(), 0);
}

#[test]
fn oco_a_partial_first_fill_still_cancels_the_sibling() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    submit(
        &mut book,
        &spec(SL, Side::Sell, "1")
            .ty(OrderType::Stop)
            .stop("90")
            .sibling(TP),
    );
    let tp = submit(
        &mut book,
        &spec(TP, Side::Sell, "3")
            .acct("desk")
            .price("110")
            .sibling(SL),
    );

    assert_eq!(f(tp.fills[0].qty), "1");
    assert_eq!(f(tp.resting.as_ref().unwrap().remaining), "2");
    assert!(
        tp.cancellations
            .iter()
            .any(|c| c.reason == CancelReason::OcoSiblingFilled)
    );
    assert_eq!(live_ids(&book), vec![TP.to_owned()]);
}

#[test]
fn oco_journal_replay_rebuilds_the_pair_and_the_first_fill_cancel() {
    let at = "2026-08-25T00:00:00.000Z";
    let mut journal = MemoryJournal::new();
    let mut live = OrderBook::new(MARKET);

    let submits = [
        order(&spec(LIQ, Side::Buy, "1").acct("mm").price("110")),
        order(
            &spec(SL, Side::Sell, "1")
                .ty(OrderType::Stop)
                .stop("90")
                .sibling(TP),
        ),
        order(
            &spec(TP, Side::Sell, "1")
                .acct("desk")
                .price("110")
                .sibling(SL),
        ),
    ];
    for o in &submits {
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("submit")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str(at)),
                ("order", to_wire(o, None)),
            ])))
            .unwrap();
        live.submit(o, None);
    }

    let books = replay(journal.read());
    let restored = books.get(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(live_ids(restored), Vec::<String>::new());
}

// ── oco-link.test.ts: OCO — rest linked take-profit and stop-loss ───────

fn linked(qty: &'static str) -> Spec {
    spec(PARENT, Side::Sell, qty)
        .oco()
        .tp("110")
        .sl("90")
        .tp_id(TP)
        .sl_id(SL)
}

#[test]
fn oco_link_rests_both_siblings_without_inventing_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(&mut book, &linked("1"));
    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[SL, TP]));
    assert_eq!(book.last_price(), None);
}

#[test]
fn oco_link_first_fill_of_the_take_profit_cancels_the_stop_loss_sibling() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    let result = submit(&mut book, &linked("1").acct("desk"));
    assert!(result.accepted);
    assert!(!result.fills.is_empty());
    assert_eq!(f(result.fills[0].qty), "1");
    assert!(cancels(&result).contains(&pair(SL, CancelReason::OcoSiblingFilled)));
    assert!(!live_ids(&book).contains(&SL.to_owned()));
}

#[test]
fn oco_link_a_rejected_take_profit_leaves_the_book_untouched_no_stop_fills_no_stop_leg_no_cancellation()
 {
    let mut filled = OrderBook::new(MARKET);
    submit(
        &mut filled,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("100"),
    );
    submit(
        &mut filled,
        &spec(PRINT, Side::Sell, "1").acct("taker").price("100"),
    );
    submit(
        &mut filled,
        &spec(BID, Side::Buy, "1").acct("mm").price("95"),
    );
    let rejected_tp = submit(
        &mut filled,
        &spec(PARENT, Side::Sell, "1")
            .oco()
            .tp("110")
            .sl("100")
            .tp_id(TP)
            .sl_id(SL),
    );
    assert!(!rejected_tp.accepted);
    assert_eq!(code(&rejected_tp), Some("oco_sibling_terminal"));
    // A rejected submit means the book was never touched: svc-trade releases the whole hold on it and settles no
    // fills.
    assert_eq!(rejected_tp.fills, vec![]);
    assert_eq!(rejected_tp.triggered, vec![]);
    assert!(!live_ids(&filled).contains(&SL.to_owned()));
    assert!(live_ids(&filled).contains(&BID.to_owned()));
    assert_eq!(rejected_tp.resting, None);
    assert_eq!(f(filled.last_price().unwrap()), "100");

    let mut book = OrderBook::new(MARKET);
    let removed = submit(&mut book, &linked("1").tif(Tif::Fok));
    assert!(!removed.accepted);
    assert_eq!(code(&removed), Some("fok_unfillable"));
    assert_eq!(removed.resting, None);
    assert!(!live_ids(&book).contains(&SL.to_owned()));
    assert!(!live_ids(&book).contains(&TP.to_owned()));
    assert_eq!(removed.cancellations, vec![]);

    let mut crossed = OrderBook::new(MARKET);
    submit(
        &mut crossed,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    let filled_tp = submit(&mut crossed, &linked("1"));
    assert!(filled_tp.accepted);
    assert!(!filled_tp.fills.is_empty());
    assert_eq!(filled_tp.resting, None);
    assert!(!live_ids(&crossed).contains(&SL.to_owned()));
}

#[test]
fn oco_link_refuses_a_missing_take_profit_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("100"),
    );
    let result = submit(&mut book, &spec(PARENT, Side::Sell, "1").oco().sl("90"));
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_stop_price"));
    assert!(
        message(&result).contains("take-profit"),
        "{}",
        message(&result)
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), vec![LIQ.to_owned()]);
}

#[test]
fn oco_link_cancels_both_live_siblings_when_the_outer_link_hook_omits_take_profit() {
    let mut book = OrderBook::new(MARKET);
    let rested = submit(&mut book, &linked("1"));
    assert!(rested.accepted);
    assert_eq!(live_ids(&book), sorted(&[SL, TP]));

    let pulled = submit(
        &mut book,
        &spec(TP, Side::Sell, "1").price("110").oco().cancel(),
    );
    assert!(pulled.accepted);
    assert_ne!(code(&pulled), Some("missing_stop_price"));
    assert_eq!(pulled.fills.len(), 0);
    assert_eq!(pulled.resting, None);
    let mut expected = vec![
        pair(SL, CancelReason::Requested),
        pair(TP, CancelReason::Requested),
    ];
    expected.sort_by(|x, y| js_sort_cmp(&format!("{},{}", x.0, x.1), &format!("{},{}", y.0, y.1)));
    assert_eq!(cancels_sorted(&pulled), expected);
    assert_eq!(live_ids(&book), Vec::<String>::new());
    assert_eq!(book.last_price(), None);
}

#[test]
fn oco_link_refuses_a_missing_stop_loss_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(&mut book, &spec(PARENT, Side::Sell, "1").oco().tp("110"));
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_stop_price"));
    assert!(
        message(&result).contains("stop-loss"),
        "{}",
        message(&result)
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

#[test]
fn oco_link_plain_gtc_does_not_rest_an_oco() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(&mut book, &spec(PARENT, Side::Sell, "1").price("110"));
    assert!(result.accepted);
    assert_eq!(live_ids(&book), vec![PARENT.to_owned()]);
}

/// The TypeScript calls the read helpers directly; in Rust they are private, so each verdict is read where it lands:
/// the submit it decides. `wantsOco({})` is false (a plain order is not an OCO); `wantsOco({ oco: true })` is true (it
/// is read as one, and refuses its missing take-profit); `readTakeProfit` and `readStopLoss` read missing, null and
/// zero as not set and a positive amount as set; each refuse says the engine does not invent a trigger, and a set
/// value refuses nothing.
#[test]
fn oco_link_read_helpers_treat_missing_and_zero_as_not_set() {
    // wantsOco({}) === false
    let mut book = OrderBook::new(MARKET);
    let plain = submit(&mut book, &spec(PARENT, Side::Sell, "1").price("110"));
    assert!(plain.accepted);
    assert_eq!(live_ids(&book), vec![PARENT.to_owned()]);

    // wantsOco({ oco: true }) === true
    let mut book = OrderBook::new(MARKET);
    let flagged = submit(&mut book, &spec(PARENT, Side::Sell, "1").price("110").oco());
    assert!(!flagged.accepted);
    assert_eq!(code(&flagged), Some("missing_stop_price"));

    // readTakeProfit: {}, null, 0 → null; takeProfitRefuse(null) says it does not invent a trigger.
    for take_profit in [Opt::Absent, Opt::Null, Opt::Some("0")] {
        let mut book = OrderBook::new(MARKET);
        let mut s = spec(PARENT, Side::Sell, "1").oco().sl("90");
        s.take_profit = take_profit.clone();
        let r = submit(&mut book, &s);
        assert!(!r.accepted, "{take_profit:?}");
        assert_eq!(code(&r), Some("missing_stop_price"), "{take_profit:?}");
        assert!(message(&r).contains("take-profit"), "{}", message(&r));
        assert!(message(&r).contains("invent a trigger"), "{}", message(&r));
    }
    // readStopLoss: {}, null, 0 → null; stopLossRefuse(null) says it does not invent a trigger.
    for stop_loss in [Opt::Absent, Opt::Null, Opt::Some("0")] {
        let mut book = OrderBook::new(MARKET);
        let mut s = spec(PARENT, Side::Sell, "1").oco().tp("110");
        s.stop_loss = stop_loss.clone();
        let r = submit(&mut book, &s);
        assert!(!r.accepted, "{stop_loss:?}");
        assert_eq!(code(&r), Some("missing_stop_price"), "{stop_loss:?}");
        assert!(message(&r).contains("stop-loss"), "{}", message(&r));
        assert!(message(&r).contains("invent a trigger"), "{}", message(&r));
    }
    // The null forms through the builder as well.
    let mut book = OrderBook::new(MARKET);
    let r = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1").oco().tp_null().sl("90"),
    );
    assert_eq!(code(&r), Some("missing_stop_price"));
    let r = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1").oco().tp("110").sl_null(),
    );
    assert_eq!(code(&r), Some("missing_stop_price"));

    // readTakeProfit(110) === 110 and readStopLoss(90) === 90; neither refuse refuses: the legs rest at those prices.
    let mut book = OrderBook::new(MARKET);
    let r = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1").oco().tp("110").sl("90"),
    );
    assert!(r.accepted);
    let state = book.to_state();
    let asks = list(state.get("asks"));
    assert_eq!(text(&asks[0], "price"), "110");
    assert_eq!(side_ids(&state, "asks"), vec![format!("{PARENT}:tp")]);
    assert_eq!(text(&stops(&state)[0], "stopPrice"), "90");
    assert_eq!(stop_ids(&state), vec![format!("{PARENT}:sl")]);
}

// ── oco-link.atomic-reject.test.ts: L287 linked OCO submit is atomic ────

fn digit_id(n: u32) -> String {
    let d = char::from_digit(n, 10).unwrap().to_string();
    format!(
        "{}-{}-4{}-8{}-{}",
        d.repeat(8),
        d.repeat(4),
        d.repeat(3),
        d.repeat(3),
        d.repeat(12)
    )
}

fn lim(i: u32, acct: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        digit_id(i),
        acct,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

#[test]
fn oco_atomic_a_rejected_take_profit_leg_must_not_leave_the_stop_leg_executed() {
    let mut book = OrderBook::new(MARKET);
    book.submit(&lim(1, "mm", Side::Sell, "1", "100"), None);
    book.submit(&lim(2, "tk", Side::Buy, "1", "100"), None); // last trade 100
    book.submit(&lim(3, "mm", Side::Buy, "1", "99"), None);
    let mut o = EngineOrder::new(
        digit_id(4),
        "desk",
        OrderType::Limit,
        Side::Sell,
        a("1"),
        Some(a("99")),
        Tif::Fok,
    );
    o.exits.oco = true;
    o.exits.take_profit = Opt::Some(a("99"));
    o.exits.stop_loss = Opt::Some(a("100"));
    o.exits.take_profit_order_id = Opt::Some(digit_id(5));
    o.exits.stop_loss_order_id = Opt::Some(digit_id(6));
    let r = book.submit(&o, None);
    let executed = r.fills.len() + r.triggered.iter().map(|t| t.fills.len()).sum::<usize>();
    assert!(
        !(!r.accepted && executed > 0),
        "accepted {} with {executed} fills",
        r.accepted
    );
}

// ── oco-cancel.test.ts: OCO — cancel both siblings ──────────────────────

fn rest_pair(book: &mut OrderBook) {
    let result = submit(book, &linked("1"));
    assert!(result.accepted);
}

fn pull_named(qty: &'static str) -> Spec {
    spec(PARENT, Side::Sell, qty)
        .oco()
        .cancel()
        .tp_id(TP)
        .sl_id(SL)
        .mark("50")
}

#[test]
fn oco_cancel_cancels_both_live_siblings_without_inventing_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    rest_pair(&mut book);
    let pulled = submit(&mut book, &pull_named("1"));
    assert!(pulled.accepted);
    assert_eq!(pulled.fills.len(), 0);
    assert_eq!(pulled.resting, None);
    let mut expected = vec![
        pair(SL, CancelReason::Requested),
        pair(TP, CancelReason::Requested),
    ];
    expected.sort_by(|x, y| js_sort_cmp(&format!("{},{}", x.0, x.1), &format!("{},{}", y.0, y.1)));
    assert_eq!(cancels_sorted(&pulled), expected);
    assert_eq!(live_ids(&book), Vec::<String>::new());
    assert_eq!(book.last_price(), None);
}

#[test]
fn oco_cancel_cancels_both_when_the_caller_names_one_live_sibling() {
    let mut book = OrderBook::new(MARKET);
    rest_pair(&mut book);
    let pulled = submit(
        &mut book,
        &spec(TP, Side::Sell, "1").price("110").oco().cancel(),
    );
    assert!(pulled.accepted);
    let mut ids: Vec<String> = pulled
        .cancellations
        .iter()
        .map(|c| c.order_id.clone())
        .collect();
    ids.sort_by(|x, y| js_sort_cmp(x, y));
    assert_eq!(ids, sorted(&[SL, TP]));
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

#[test]
fn oco_cancel_refuses_when_the_stop_loss_sibling_is_already_terminal_remaining_take_profit_stays() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("110"),
    );
    let rest = submit(&mut book, &linked("3").acct("desk"));
    assert!(rest.accepted);
    assert_eq!(f(rest.fills[0].qty), "1");
    assert!(rest.cancellations.iter().any(|c| c.order_id == SL));
    assert_eq!(live_ids(&book), vec![TP.to_owned()]);

    let pulled = submit(&mut book, &pull_named("2"));
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some("oco_sibling_terminal"));
    assert!(
        message(&pulled).contains("invent a trigger"),
        "{}",
        message(&pulled)
    );
    assert_eq!(pulled.cancellations.len(), 0);
    assert_eq!(live_ids(&book), vec![TP.to_owned()]);
}

#[test]
fn oco_cancel_refuses_when_neither_sibling_is_live_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &spec(LIQ, Side::Buy, "1").acct("mm").price("100"),
    );
    let pulled = submit(&mut book, &pull_named("1"));
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some("order_not_found"));
    assert!(
        message(&pulled).contains("invent a trigger"),
        "{}",
        message(&pulled)
    );
    assert_eq!(pulled.fills.len(), 0);
    assert_eq!(live_ids(&book), vec![LIQ.to_owned()]);
}

#[test]
fn oco_cancel_plain_gtc_cancel_flag_without_oco_does_not_pull_an_unrelated_rest() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &spec(PARENT, Side::Sell, "1").price("110"));
    let pulled = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1").price("110").cancel(),
    );
    assert!(!pulled.accepted);
    assert_eq!(live_ids(&book), vec![PARENT.to_owned()]);
}

#[test]
fn oco_cancel_does_not_invent_a_sibling_id_when_only_one_side_is_named() {
    let mut book = OrderBook::new(MARKET);
    let coincidental: &'static str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:tp";
    assert_eq!(coincidental, format!("{PARENT}:tp"));
    submit(&mut book, &spec(coincidental, Side::Sell, "1").price("110"));
    submit(&mut book, &spec(SL, Side::Buy, "1").price("90"));

    let one_side = spec(PARENT, Side::Sell, "1").oco().cancel().sl_id(SL);
    // `readOcoPair(book, oneSide)` is null: private in Rust, its verdict is the refusal just below.

    let pulled = submit(&mut book, &one_side);
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some("order_not_found"));
    assert_eq!(pulled.cancellations.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[SL, coincidental]));

    let linked = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1")
            .oco()
            .cancel()
            .tp_id(coincidental)
            .sl_id(SL),
    );
    assert!(linked.accepted);
    let mut ids: Vec<String> = linked
        .cancellations
        .iter()
        .map(|c| c.order_id.clone())
        .collect();
    ids.sort_by(|x, y| js_sort_cmp(x, y));
    assert_eq!(ids, sorted(&[SL, coincidental]));
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

/// The TypeScript calls `wantsOcoCancel`, `readOcoPair` and `ocoCancelRefuse` directly; in Rust they are private, so
/// each verdict is read at the submit it decides. `wantsOcoCancel` with `type: 'option'` has no Rust form (no option
/// order type): not ported.
#[test]
fn oco_cancel_read_helpers_treat_a_missing_pair_as_not_set() {
    // wantsOcoCancel({ cancel: true }) === false: a bare cancel flag is not a linked OCO cancel. It passes on to the
    // option layer under the trigger wrappers (`option.ts` is installed first), whose `wantsCancel` reads it as an
    // option cancel and refuses the missing strike; nothing rests and nothing is pulled.
    let mut book = OrderBook::new(MARKET);
    let plain = submit(
        &mut book,
        &spec(PARENT, Side::Sell, "1").price("110").cancel(),
    );
    assert!(!plain.accepted);
    assert_eq!(code(&plain), Some("missing_strike"));
    assert!(plain.cancellations.is_empty());
    assert_eq!(live_ids(&book), Vec::<String>::new());

    // wantsOcoCancel({ oco: true, cancel: true }) === true, and readOcoPair(book, { cancel: true }) with nothing named
    // or linked is null: the linked cancel refuses `order_not_found` (ocoCancelRefuse(0)) rather than read an OCO's
    // missing take-profit.
    let mut book = OrderBook::new(MARKET);
    let r = submit(&mut book, &spec(PARENT, Side::Sell, "1").oco().cancel());
    assert!(!r.accepted);
    assert_eq!(code(&r), Some("order_not_found"));

    // ocoCancelRefuse(2) === null: both live, both cancelled.
    let mut book = OrderBook::new(MARKET);
    rest_pair(&mut book);
    let r = submit(&mut book, &pull_named("1"));
    assert!(r.accepted);
    assert_eq!(r.rejected, None);

    // ocoCancelRefuse(1).code === 'oco_sibling_terminal': one live.
    let mut book = OrderBook::new(MARKET);
    rest_pair(&mut book);
    book.cancel(SL, CancelReason::Requested);
    let r = submit(&mut book, &pull_named("1"));
    assert_eq!(code(&r), Some("oco_sibling_terminal"));

    // ocoCancelRefuse(0).code === 'order_not_found': none live.
    let mut book = OrderBook::new(MARKET);
    let r = submit(&mut book, &pull_named("1"));
    assert_eq!(code(&r), Some("order_not_found"));
}

// ── oco-stop-limit.test.ts: OCO stop-loss limit ─────────────────────────

const NEAR: &str = "11111111-1111-4111-8111-111111111111";
const FAR: &str = "22222222-2222-4222-8222-222222222222";

fn limit(id: &str, side: Side, qty: &str, price: &str, account: &str) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

/// `buyOco(extra)`: a limit buy 1 at 100, OCO take-profit 100, stop-loss 120; `stop_loss_limit` is the one extra the
/// tests pass.
fn buy_oco(stop_loss_limit: Opt<Amount>) -> EngineOrder {
    let mut o = EngineOrder::new(
        PARENT,
        "desk",
        OrderType::Limit,
        Side::Buy,
        a("1"),
        Some(a("100")),
        Tif::Gtc,
    );
    o.exits.oco = true;
    o.exits.take_profit = Opt::Some(a("100"));
    o.exits.stop_loss = Opt::Some(a("120"));
    o.exits.stop_loss_limit = stop_loss_limit;
    o
}

/// Asks: 0.1 at 121 (the print that triggers the stop) and 1 at 130 (the thin liquidity behind it).
fn seeded() -> OrderBook {
    let mut book = OrderBook::new(MARKET);
    book.submit(&limit(NEAR, Side::Sell, "0.1", "121", "mm"), None);
    book.submit(&limit(FAR, Side::Sell, "1", "130", "mm"), None);
    book
}

fn trigger(book: &mut OrderBook) -> SubmitResult {
    book.submit(&limit(PRINT, Side::Buy, "0.1", "121", "taker"), None)
}

fn sl_stop(book: &OrderBook) -> Option<Json> {
    let id = format!("{PARENT}:sl");
    stops(&book.to_state())
        .iter()
        .find(|s| s.get("orderId") == Some(&Json::str(id.clone())))
        .cloned()
}

#[test]
fn oco_stop_limit_rests_the_stop_leg_as_a_stop_limit_with_the_caller_limit_price() {
    let mut book = seeded();
    let placed = book.submit(&buy_oco(Opt::Some(a("125"))), None);
    assert!(placed.accepted);
    let stop = sl_stop(&book).expect("the stop leg rests");
    assert_eq!(stop.get("type"), Some(&Json::str("stop_limit")));
    assert_eq!(stop.get("stopPrice"), Some(&Json::str("120")));
    assert_eq!(stop.get("price"), Some(&Json::str("125")));
}

#[test]
fn oco_stop_limit_a_triggered_stop_limit_buy_never_pays_above_its_limit_where_a_market_stop_pays_the_thin_book_at_130()
 {
    let sl_id = format!("{PARENT}:sl");
    let mut bounded = seeded();
    bounded.submit(&buy_oco(Opt::Some(a("125"))), None);
    let bounded_out = trigger(&mut bounded);
    let mut bounded_fills = bounded_out.fills.clone();
    bounded_fills.extend(bounded_out.triggered.iter().flat_map(|t| t.fills.clone()));
    assert_eq!(
        bounded_fills
            .iter()
            .filter(|f| f.taker_order_id == sl_id)
            .count(),
        0
    );
    // the far ask is untouched and the stop leg now rests as a bid at its limit
    let state = bounded.to_state();
    assert!(side_ids(&state, "asks").contains(&FAR.to_owned()));
    assert!(side_ids(&state, "bids").contains(&sl_id));

    let mut market = seeded();
    market.submit(&buy_oco(Opt::Absent), None);
    let market_out = trigger(&mut market);
    let mut market_fills = market_out.fills.clone();
    market_fills.extend(market_out.triggered.iter().flat_map(|t| t.fills.clone()));
    assert!(
        market_fills
            .iter()
            .any(|f| f.taker_order_id == sl_id && f.price == a("130")),
        "{market_fills:?}"
    );
}

#[test]
fn oco_stop_limit_refuses_a_zero_stop_loss_limit_instead_of_falling_back_to_an_unbounded_market_stop()
 {
    let mut book = seeded();
    let placed = book.submit(&buy_oco(Opt::Some(a("0"))), None);
    assert!(!placed.accepted);
    assert_eq!(code(&placed), Some("invalid_price"));
    assert_eq!(stops(&book.to_state()), &[] as &[Json]);
}

#[test]
fn oco_stop_limit_the_stop_loss_limit_survives_the_journal_replay_and_the_on_disk_codec_rest_the_same_stop_limit()
 {
    let records = vec![submit_record(&buy_oco(Opt::Some(a("125"))))];
    let disk = on_disk(&records);
    for tape in [&records, &disk] {
        let books = replay(tape);
        let book = books.get(MARKET).unwrap();
        let stop = sl_stop(book).expect("the stop leg rests after replay");
        assert_eq!(stop.get("type"), Some(&Json::str("stop_limit")));
        assert_eq!(stop.get("price"), Some(&Json::str("125")));
    }
}

// ── oco-replay.test.ts: OCO submits replay the way they ran live ────────

const REPLAY_ID: &str = "11111111-1111-4111-8111-111111111111";

/// `bare(extra)`: a limit sell 1 at 100; the OCO parts are the extra.
fn bare(take_profit: Opt<Amount>, stop_loss: Opt<Amount>) -> EngineOrder {
    let mut o = EngineOrder::new(
        REPLAY_ID,
        "desk",
        OrderType::Limit,
        Side::Sell,
        a("1"),
        Some(a("100")),
        Tif::Gtc,
    );
    o.exits.oco = true;
    o.exits.take_profit = take_profit;
    o.exits.stop_loss = stop_loss;
    o
}

/// `book?.toState().<side> ?? []`.
fn or_empty(book: Option<&OrderBook>, side: &str) -> Vec<Json> {
    book.map(|b| list(b.to_state().get(side)).to_vec())
        .unwrap_or_default()
}

#[test]
fn oco_replay_a_refused_bare_oco_order_stays_refused_after_replay_nothing_rests() {
    let books = replay(&[submit_record(&bare(Opt::Absent, Opt::Absent))]);
    let book = books.get(MARKET);
    assert_eq!(or_empty(book, "asks"), Vec::<Json>::new());
    assert_eq!(or_empty(book, "stops"), Vec::<Json>::new());
}

#[test]
fn oco_replay_a_full_oco_submit_replays_to_the_same_two_legs() {
    let books = replay(&[submit_record(&bare(
        Opt::Some(a("110")),
        Opt::Some(a("90")),
    ))]);
    let state = books.get(MARKET).unwrap().to_state();
    let asks = list(state.get("asks"));
    assert_eq!(
        text(&list(asks[0].get("orders"))[0], "orderId"),
        format!("{REPLAY_ID}:tp")
    );
    assert_eq!(stop_ids(&state), vec![format!("{REPLAY_ID}:sl")]);
}

#[test]
fn oco_replay_the_on_disk_journal_keeps_the_oco_flag_a_refused_bare_oco_stays_refused_after_encode_and_decode()
 {
    let disk = on_disk(&[submit_record(&bare(Opt::Absent, Opt::Absent))]);
    let books = replay(&disk);
    assert_eq!(or_empty(books.get(MARKET), "asks"), Vec::<Json>::new());
}
