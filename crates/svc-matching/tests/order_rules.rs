//! The order rules of the book slice, ported test for test from the TypeScript engine tests under
//! `services/svc-matching/src/engine/`: `fok.test.ts`, `ioc.test.ts`, `min-qty.test.ts`, `min-notional.test.ts`,
//! `self-trade.test.ts`, `maker-or-cancel.test.ts`, `collar.test.ts`, `post-only.test.ts` and `reduce-only.test.ts`.
//! Each test is named after its TypeScript `it`, prefixed with the file's topic. The TypeScript `replay(records)` is
//! the engine's cold start here (`MatchingEngine::recover` over the same journal), which rebuilds each book the same
//! way and drops a book that never printed and holds nothing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::rules::{
    clip_meets_min_qty, collar_intent_refuse, is_self_trade, min_notional_intent_refuse,
    min_qty_refuse, read_min_qty, self_trade_case, stp_identity_refuse,
};
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, Opt, OrderType, RestKind, Side, SubmitResult,
    SurveillanceCase, Tif,
};
use svc_matching::book::wire::to_wire;
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// The tests' `order(spec)`: a market order without a price, a limit with one; every other part absent.
fn order(
    id: &str,
    account: &str,
    side: Side,
    qty: &str,
    price: Option<&str>,
    tif: Tif,
) -> EngineOrder {
    let kind = if price.is_some() {
        OrderType::Limit
    } else {
        OrderType::Market
    };
    EngineOrder::new(id, account, kind, side, a(qty), price.map(a), tif)
}

fn submit(book: &mut OrderBook, o: &EngineOrder) -> SubmitResult {
    book.submit(o, None)
}

fn ids_of(levels: Option<&Json>) -> Vec<String> {
    let Some(Json::Array(levels)) = levels else {
        panic!("levels are an array")
    };
    let mut out = Vec::new();
    for level in levels {
        let Some(Json::Array(orders)) = level.get("orders") else {
            panic!("a level holds orders")
        };
        for o in orders {
            out.push(text(o.get("orderId")));
        }
    }
    out
}

fn text(j: Option<&Json>) -> String {
    match j {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not text: {other:?}"),
    }
}

/// Bids then asks, unsorted (the `liveIds` of the min-notional, collar and self-trade tests).
fn live_ids(book: &OrderBook) -> Vec<String> {
    let state = book.to_state();
    let mut ids = ids_of(state.get("bids"));
    ids.extend(ids_of(state.get("asks")));
    ids
}

/// Bids, asks and stops, sorted (the `liveIds` of the fok, ioc, min-qty, post-only and reduce-only tests).
fn live_ids_sorted(book: &OrderBook) -> Vec<String> {
    let state = book.to_state();
    let mut ids = live_ids(book);
    let Some(Json::Array(stops)) = state.get("stops") else {
        panic!("stops are an array")
    };
    for s in stops {
        ids.push(text(s.get("orderId")));
    }
    ids.sort();
    ids
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

/// `book.toState()[side][0].orders[0]`.
fn first_order(book: &OrderBook, side: &str) -> Json {
    let state = book.to_state();
    let Some(Json::Array(levels)) = state.get(side) else {
        panic!("{side} is an array")
    };
    let Some(Json::Array(orders)) = levels[0].get("orders") else {
        panic!("a level holds orders")
    };
    orders[0].clone()
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|r| r.code.as_str())
}

fn submit_record(o: &EngineOrder, at: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str("submit")),
        ("marketId", Json::str(MARKET)),
        ("at", Json::str(at)),
        ("order", to_wire(o, None)),
    ]))
}

fn fixed_clock() -> i64 {
    1_787_000_000_000
}

/// `replay(journal.read())`: the engine's cold start over this journal.
fn replay(journal: Box<dyn EngineJournal + Send>) -> MatchingEngine {
    let mut engine = MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(MemoryEventBus::default()),
        clock: fixed_clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    });
    engine.recover().unwrap();
    engine
}

fn replay_memory(orders: &[&EngineOrder], at: &str) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for o in orders {
        journal.append(&submit_record(o, at)).unwrap();
    }
    replay(Box::new(journal))
}

fn case_json(account: &str) -> Json {
    Json::obj([
        ("accountId", Json::str(account)),
        ("marketId", Json::str(MARKET)),
        ("reason", Json::str("self_trade")),
        ("status", Json::str("open")),
    ])
}

fn cases_json(cases: &[SurveillanceCase]) -> Vec<Json> {
    cases.iter().map(SurveillanceCase::to_json).collect()
}

// ── fok.test.ts ─────────────────────────────────────────────────────────

const FOK_ASK: &str = "11111111-1111-4111-8111-111111111111";
const FOK_FOK: &str = "22222222-2222-4222-8222-222222222222";
const FOK_SHORT: &str = "33333333-3333-4333-8333-333333333333";
const FOK_MISS: &str = "44444444-4444-4444-8444-444444444444";
const FOK_IOC: &str = "55555555-5555-4555-8555-555555555555";

fn ask_qty(book: &OrderBook) -> String {
    let state = book.to_state();
    let Some(Json::Array(levels)) = state.get("asks") else {
        panic!("asks are an array")
    };
    let mut parts = Vec::new();
    for level in levels {
        let Some(Json::Array(orders)) = level.get("orders") else {
            panic!("a level holds orders")
        };
        for o in orders {
            parts.push(text(o.get("remaining")));
        }
    }
    if parts.is_empty() {
        "0".to_owned()
    } else {
        parts.join(",")
    }
}

#[test]
fn fok_fills_completely_when_the_book_has_the_full_qty() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(FOK_ASK, "mm", Side::Sell, "3", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(FOK_FOK, "desk", Side::Buy, "3", Some("100"), Tif::Fok),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(format_amount(result.fills[0].qty), "3");
    assert!(result.resting.is_none());
    assert!(result.rejected.is_none());
    assert!(!live_ids_sorted(&book).contains(&FOK_FOK.to_owned()));
    assert!(!live_ids_sorted(&book).contains(&FOK_ASK.to_owned()));
}

#[test]
fn fok_short_book_cancels_the_whole_no_partial_leftover_no_invented_fill() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(FOK_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let before = book.serialize();
    let result = submit(
        &mut book,
        &order(FOK_SHORT, "desk", Side::Buy, "3", Some("100"), Tif::Fok),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("fok_unfillable"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids_sorted(&book), ids(&[FOK_ASK]));
    assert_eq!(ask_qty(&book), "1");
    assert_eq!(book.serialize(), before);
}

#[test]
fn fok_empty_book_refuses_no_invented_fill() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &order(FOK_MISS, "desk", Side::Buy, "1", Some("100"), Tif::Fok),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("fok_unfillable"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn fok_ioc_still_takes_a_partial_fok_does_not() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(FOK_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let ioc = submit(
        &mut book,
        &order(FOK_IOC, "desk", Side::Buy, "3", Some("100"), Tif::Ioc),
    );
    assert!(ioc.accepted);
    assert_eq!(ioc.fills.len(), 1);
    assert_eq!(format_amount(ioc.fills[0].qty), "1");
}

#[test]
fn fok_journal_replay_of_a_refused_fok_does_not_invent_a_fill() {
    let mut live = OrderBook::new(MARKET);
    let ask = order(FOK_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc);
    let fok = order(FOK_SHORT, "desk", Side::Buy, "3", Some("100"), Tif::Fok);
    for o in [&ask, &fok] {
        submit(&mut live, o);
    }
    let engine = replay_memory(&[&ask, &fok], "2026-08-25T15:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(live_ids_sorted(restored), ids(&[FOK_ASK]));
    assert_eq!(ask_qty(restored), "1");
}

// ── ioc.test.ts ─────────────────────────────────────────────────────────

const IOC_ASK: &str = "11111111-1111-4111-8111-111111111111";
const IOC_IOC: &str = "22222222-2222-4222-8222-222222222222";
const IOC_MISS: &str = "33333333-3333-4333-8333-333333333333";
const IOC_GTC: &str = "44444444-4444-4444-8444-444444444444";
const IOC_MKT: &str = "55555555-5555-4555-8555-555555555555";

#[test]
fn ioc_partial_take_cancels_the_leftover_no_invented_rest() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(IOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(IOC_IOC, "desk", Side::Buy, "3", Some("100"), Tif::Ioc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(format_amount(result.fills[0].qty), "1");
    assert!(result.resting.is_none());
    assert_eq!(result.cancellations.len(), 1);
    assert_eq!(result.cancellations[0].order_id, IOC_IOC);
    assert_eq!(result.cancellations[0].reason, CancelReason::IocRemainder);
    assert_eq!(format_amount(result.cancellations[0].remaining_qty), "2");
    assert!(!live_ids_sorted(&book).contains(&IOC_IOC.to_owned()));
}

#[test]
fn ioc_a_miss_cancels_the_full_qty_no_leftover_rest() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(IOC_ASK, "mm", Side::Sell, "1", Some("101"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(IOC_MISS, "desk", Side::Buy, "1", Some("100"), Tif::Ioc),
    );

    assert!(result.accepted);
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(result.cancellations[0].reason, CancelReason::IocRemainder);
    assert_eq!(format_amount(result.cancellations[0].remaining_qty), "1");
    assert_eq!(live_ids_sorted(&book), ids(&[IOC_ASK]));
}

#[test]
fn ioc_market_ioc_remainder_is_market_remainder_no_invented_leftover() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &order(IOC_MKT, "desk", Side::Buy, "1", None, Tif::Ioc),
    );

    assert!(result.accepted);
    assert!(result.resting.is_none());
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::MarketRemainder
    );
    assert_eq!(format_amount(result.cancellations[0].remaining_qty), "1");
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn ioc_gtc_still_rests_leftover() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(IOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(IOC_GTC, "desk", Side::Buy, "3", Some("100"), Tif::Gtc),
    );

    assert!(result.accepted);
    assert_eq!(
        result.resting.as_ref().map(|r| r.kind),
        Some(RestKind::Book)
    );
    assert_eq!(
        format_amount(result.resting.as_ref().unwrap().remaining),
        "2"
    );
    assert_eq!(
        result
            .cancellations
            .iter()
            .filter(|c| c.reason == CancelReason::IocRemainder)
            .count(),
        0
    );
    assert!(live_ids_sorted(&book).contains(&IOC_GTC.to_owned()));
}

#[test]
fn ioc_journal_replay_does_not_invent_an_ioc_leftover() {
    let mut live = OrderBook::new(MARKET);
    let ask = order(IOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc);
    let ioc = order(IOC_IOC, "desk", Side::Buy, "3", Some("100"), Tif::Ioc);
    for o in [&ask, &ioc] {
        submit(&mut live, o);
    }
    let engine = replay_memory(&[&ask, &ioc], "2026-08-25T15:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert!(!live_ids_sorted(restored).contains(&IOC_IOC.to_owned()));
}

// ── min-qty.test.ts ─────────────────────────────────────────────────────

const MQ_ASK: &str = "11111111-1111-4111-8111-111111111111";
const MQ_ASK2: &str = "22222222-2222-4222-8222-222222222222";
const MQ_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const MQ_MISS: &str = "44444444-4444-4444-8444-444444444444";
const MQ_PLAIN: &str = "55555555-5555-4555-8555-555555555555";
const MQ_MAKER: &str = "66666666-6666-4666-8666-666666666666";

fn with_min_qty(mut o: EngineOrder, min_qty: &str) -> EngineOrder {
    o.min_qty = Opt::Some(a(min_qty));
    o
}

#[test]
fn min_qty_missing_min_qty_is_not_set_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MQ_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(MQ_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.resting.as_ref().unwrap().remaining), "8");
}

#[test]
fn min_qty_zero_min_qty_is_not_set_no_invented_default() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MQ_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_qty(
            order(MQ_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "0",
        ),
    );

    assert!(take.accepted);
    assert_eq!(format_amount(take.fills[0].qty), "2");
}

#[test]
fn min_qty_above_remaining_refuses_no_invented_fill() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &with_min_qty(
            order(MQ_MISS, "desk", Side::Buy, "2", Some("100"), Tif::Gtc),
            "5",
        ),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("min_qty_exceeds_qty"));
    assert!(result.fills.is_empty());
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn min_qty_a_clip_smaller_than_min_qty_does_not_occur_gtc_rests_the_whole() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MQ_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_qty(
            order(MQ_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "5",
        ),
    );

    assert!(take.accepted);
    assert!(take.fills.is_empty());
    assert_eq!(
        format_amount(take.resting.as_ref().unwrap().remaining),
        "10"
    );
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "2");
    assert_eq!(text(first_order(&book, "bids").get("minQty")), "5");
}

#[test]
fn min_qty_does_not_take_a_clip_that_would_leave_a_stub_below_min_qty() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MQ_ASK, "mm", Side::Sell, "6", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_qty(
            order(MQ_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "5",
        ),
    );

    assert!(take.fills.is_empty());
    assert_eq!(
        format_amount(take.resting.as_ref().unwrap().remaining),
        "10"
    );
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "6");
}

#[test]
fn min_qty_fills_two_clips_each_at_the_floor() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MQ_ASK, "mm", Side::Sell, "5", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(MQ_ASK2, "mm-2", Side::Sell, "5", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_qty(
            order(MQ_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "5",
        ),
    );

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 2);
    assert_eq!(
        take.fills
            .iter()
            .map(|f| format_amount(f.qty))
            .collect::<Vec<_>>(),
        ids(&["5", "5"])
    );
    assert!(take.resting.is_none());
    assert!(!live_ids_sorted(&book).contains(&MQ_TAKE.to_owned()));
}

#[test]
fn min_qty_a_resting_min_qty_does_not_fill_below_the_floor() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_min_qty(
            order(MQ_MAKER, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            "5",
        ),
    );
    let crumb = submit(
        &mut book,
        &order(MQ_TAKE, "desk", Side::Buy, "4", Some("100"), Tif::Gtc),
    );

    assert!(crumb.fills.is_empty());
    assert_eq!(
        format_amount(crumb.resting.as_ref().unwrap().remaining),
        "4"
    );
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "10");
}

#[test]
fn min_qty_a_resting_min_qty_fills_when_the_clip_meets_the_floor_and_leftover_is_not_a_stub() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_min_qty(
            order(MQ_MAKER, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            "5",
        ),
    );
    let take = submit(
        &mut book,
        &order(MQ_TAKE, "desk", Side::Buy, "5", Some("100"), Tif::Gtc),
    );

    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "5");
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "5");
}

#[test]
fn min_qty_journal_replay_of_a_resting_min_qty_keeps_the_floor() {
    let mut live = OrderBook::new(MARKET);
    let rest = with_min_qty(
        order(MQ_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        "5",
    );
    submit(&mut live, &rest);
    let engine = replay_memory(&[&rest], "2026-08-25T15:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(text(first_order(restored, "bids").get("minQty")), "5");
}

#[test]
fn min_qty_journal_replay_of_a_refused_min_qty_does_not_invent_a_book() {
    let too_big = with_min_qty(
        order(MQ_MISS, "desk", Side::Buy, "2", Some("100"), Tif::Gtc),
        "5",
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &too_big).accepted);
    let engine = replay_memory(&[&too_big], "2026-08-25T15:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn min_qty_read_min_qty_treats_missing_and_zero_as_not_set_min_qty_refuse_fires_above_remaining() {
    assert_eq!(read_min_qty(&Opt::Absent), None);
    assert_eq!(read_min_qty(&Opt::Null), None);
    assert_eq!(read_min_qty(&Opt::Some(a("0"))), None);
    assert_eq!(read_min_qty(&Opt::Some(a("5"))), Some(a("5")));
    assert_eq!(
        min_qty_refuse(a("2"), Some(a("5"))).map(|r| r.code),
        Some("min_qty_exceeds_qty".to_owned())
    );
    assert!(min_qty_refuse(a("5"), Some(a("5"))).is_none());
    assert!(!clip_meets_min_qty(a("2"), a("8"), Some(a("5"))));
    assert!(!clip_meets_min_qty(a("6"), a("4"), Some(a("5"))));
    assert!(clip_meets_min_qty(a("5"), a("5"), Some(a("5"))));
    assert!(clip_meets_min_qty(a("10"), a("0"), Some(a("5"))));
}

// ── min-notional.test.ts ────────────────────────────────────────────────

const MN_ASK: &str = "11111111-1111-4111-8111-111111111111";
const MN_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const MN_MISS: &str = "44444444-4444-4444-8444-444444444444";
const MN_PLAIN: &str = "55555555-5555-4555-8555-555555555555";
const MN_LAST: &str = "66666666-6666-4666-8666-666666666666";

fn with_min_notional(mut o: EngineOrder, floor: &str) -> EngineOrder {
    o.min_notional = Opt::Some(a(floor));
    o
}

#[test]
fn min_notional_missing_min_notional_is_a_normal_order_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MN_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(MN_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(take.resting.as_ref().map(|r| r.remaining), Some(a("8")));
}

#[test]
fn min_notional_zero_is_not_requested_no_invented_floor() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MN_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_notional(
            order(MN_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "0",
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
}

#[test]
fn min_notional_without_a_price_refuses_last_on_the_book_is_not_a_notional() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MN_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(MN_LAST, "desk", Side::Buy, "1", Some("100"), Tif::Gtc),
    );
    assert_eq!(format_amount(book.last_price().unwrap()), "100");
    let result = submit(
        &mut book,
        &with_min_notional(
            order(MN_MISS, "desk", Side::Buy, "10", None, Tif::Gtc),
            "1000",
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_notional"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[MN_ASK]));
    assert_eq!(format_amount(book.last_price().unwrap()), "100");
}

#[test]
fn min_notional_submit_below_the_caller_floor_refuses_no_rest() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MN_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &with_min_notional(
            order(MN_MISS, "desk", Side::Buy, "9", Some("100"), Tif::Gtc),
            "1000",
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("below_min_notional"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[MN_ASK]));
}

#[test]
fn min_notional_submit_at_the_caller_floor_takes_at_the_caller_price() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(MN_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_min_notional(
            order(MN_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            "1000",
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.fills[0].price), "100");
}

#[test]
fn min_notional_journal_replay_of_a_refused_missing_notional_does_not_invent_a_book() {
    let incoming = with_min_notional(
        order(MN_MISS, "desk", Side::Buy, "10", None, Tif::Gtc),
        "1000",
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &incoming).accepted);
    let engine = replay_memory(&[&incoming], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn min_notional_journal_replay_of_a_refused_below_floor_submit_does_not_invent_a_book() {
    let incoming = with_min_notional(
        order(MN_TAKE, "desk", Side::Buy, "9", Some("100"), Tif::Gtc),
        "1000",
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &incoming).accepted);
    let engine = replay_memory(&[&incoming], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

/// The `minNotionalIntentRefuse` part of "read helpers treat missing and zero as not set; execute needs a caller
/// notional". `readMinNotional`, `callerNotional`, `missingNotionalRefuse` and `belowMinNotionalRefuse` have no Rust
/// counterpart (helpers not ported).
#[test]
fn min_notional_read_helpers_treat_missing_and_zero_as_not_set_execute_needs_a_caller_notional() {
    let intent = |qty: &str, price: Option<&str>, floor: Option<&str>| {
        let mut o = order(MN_TAKE, "desk", Side::Buy, qty, price, Tif::Gtc);
        if let Some(f) = floor {
            o.min_notional = Opt::Some(a(f));
        }
        min_notional_intent_refuse(&o).map(|r| r.code)
    };
    assert_eq!(
        intent("10", None, Some("1000")),
        Some("missing_notional".to_owned())
    );
    assert_eq!(
        intent("9", Some("100"), Some("1000")),
        Some("below_min_notional".to_owned())
    );
    assert_eq!(intent("10", Some("100"), Some("1000")), None);
    assert_eq!(intent("10", Some("100"), None), None);
}

// ── self-trade.test.ts ──────────────────────────────────────────────────

const ST_OWN: &str = "11111111-1111-4111-8111-111111111111";
const ST_STRANGER: &str = "22222222-2222-4222-8222-222222222222";
const ST_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const ST_BEHIND: &str = "44444444-4444-4444-8444-444444444444";

#[test]
fn self_trade_crossing_own_rest_expires_the_rest_no_fill_taker_continues() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_OWN, "same", Side::Buy, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "same", Side::Sell, "1", Some("100"), Tif::Gtc),
    );

    assert!(result.accepted);
    assert!(result.rejected.is_none());
    assert!(result.fills.is_empty());
    assert_eq!(result.cancellations.len(), 1);
    assert_eq!(result.cancellations[0].order_id, ST_OWN);
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert_eq!(format_amount(result.cancellations[0].remaining_qty), "1");
    assert_eq!(
        result.resting.as_ref().map(|r| r.order_id.as_str()),
        Some(ST_TAKE)
    );
    assert_eq!(live_ids(&book), ids(&[ST_TAKE]));
    assert!(book.best_bid().is_none());
    assert_eq!(format_amount(book.best_ask().unwrap()), "100");
    assert_eq!(
        cases_json(&result.surveillance_cases),
        vec![case_json("same")]
    );
    assert_eq!(
        book.open_surveillance_cases(),
        result.surveillance_cases.as_slice()
    );
    assert!(result.surveillance_cases[0].to_json().get("fine").is_none());
    assert!(
        result.surveillance_cases[0]
            .to_json()
            .get("amount")
            .is_none()
    );
}

#[test]
fn self_trade_expires_own_rest_and_fills_the_stranger_behind_it() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_OWN, "same", Side::Buy, "1", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(ST_STRANGER, "other", Side::Buy, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "same", Side::Sell, "2", Some("100"), Tif::Gtc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, ST_STRANGER);
    assert_eq!(result.fills[0].maker_account_id, "other");
    assert_eq!(result.fills[0].taker_account_id, "same");
    assert_eq!(format_amount(result.fills[0].qty), "1");
    assert_eq!(
        result
            .cancellations
            .iter()
            .map(|c| c.order_id.as_str())
            .collect::<Vec<_>>(),
        vec![ST_OWN]
    );
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert_eq!(
        result.resting.as_ref().map(|r| r.order_id.as_str()),
        Some(ST_TAKE)
    );
    assert_eq!(live_ids(&book), ids(&[ST_TAKE]));
    assert_eq!(
        cases_json(&result.surveillance_cases),
        vec![case_json("same")]
    );
}

#[test]
fn self_trade_crossing_a_different_account_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_STRANGER, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "desk", Side::Buy, "1", Some("100"), Tif::Gtc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_account_id, "mm");
    assert_eq!(result.fills[0].taker_account_id, "desk");
    assert_eq!(format_amount(result.fills[0].qty), "1");
    assert!(live_ids(&book).is_empty());
    assert!(result.surveillance_cases.is_empty());
    assert!(book.open_surveillance_cases().is_empty());
}

#[test]
fn self_trade_empty_account_ids_are_missing_they_refuse_the_match_not_a_fill() {
    let mut book = OrderBook::new(MARKET);
    let rest = submit(
        &mut book,
        &order(ST_OWN, "", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    assert!(!rest.accepted);
    assert_eq!(code(&rest), Some("self_trade"));
    assert!(rest.fills.is_empty());

    let result = submit(
        &mut book,
        &order(ST_TAKE, "", Side::Buy, "1", Some("100"), Tif::Gtc),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("self_trade"));
    assert!(result.fills.is_empty());
    assert!(result.surveillance_cases.is_empty());
    assert!(book.open_surveillance_cases().is_empty());
    assert!(live_ids(&book).is_empty());
}

#[test]
fn self_trade_empty_taker_against_a_named_rest_refuses_the_match() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_STRANGER, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "", Side::Buy, "1", Some("100"), Tif::Gtc),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("self_trade"));
    assert!(result.fills.is_empty());
    assert_eq!(live_ids(&book), ids(&[ST_STRANGER]));
    assert!(result.surveillance_cases.is_empty());
}

#[test]
fn self_trade_walks_past_own_rest_across_price_levels_and_fills_the_stranger() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_OWN, "same", Side::Buy, "1", Some("101"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(ST_BEHIND, "other", Side::Buy, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "same", Side::Sell, "2", Some("100"), Tif::Ioc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, ST_BEHIND);
    assert_eq!(format_amount(result.fills[0].qty), "1");
    assert_eq!(
        result
            .cancellations
            .iter()
            .map(|c| (c.order_id.as_str(), c.reason))
            .collect::<Vec<_>>(),
        vec![
            (ST_OWN, CancelReason::SelfTradePrevention),
            (ST_TAKE, CancelReason::IocRemainder),
        ]
    );
    assert!(live_ids(&book).is_empty());
    assert_eq!(
        cases_json(&result.surveillance_cases),
        vec![case_json("same")]
    );
}

#[test]
fn self_trade_fok_with_own_rest_in_front_of_a_stranger_expires_own_rest_and_fills_the_stranger() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_OWN, "same", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(ST_BEHIND, "other", Side::Sell, "10", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "same", Side::Buy, "5", Some("100"), Tif::Fok),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, ST_BEHIND);
    assert_eq!(result.fills[0].maker_account_id, "other");
    assert_eq!(format_amount(result.fills[0].qty), "5");
    assert_eq!(
        result
            .cancellations
            .iter()
            .map(|c| c.order_id.as_str())
            .collect::<Vec<_>>(),
        vec![ST_OWN]
    );
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[ST_BEHIND]));
}

#[test]
fn self_trade_fok_still_fills_when_every_rest_is_a_different_account() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(ST_OWN, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(ST_BEHIND, "other", Side::Sell, "10", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(ST_TAKE, "desk", Side::Buy, "5", Some("100"), Tif::Fok),
    );

    assert!(result.accepted);
    assert!(result.rejected.is_none());
    assert_eq!(result.fills.len(), 2);
    assert_eq!(result.fills[0].maker_account_id, "mm");
    assert_eq!(result.fills[1].maker_account_id, "other");
    assert_eq!(format_amount(result.fills[0].qty), "1");
    assert_eq!(format_amount(result.fills[1].qty), "4");
    assert_eq!(live_ids(&book), ids(&[ST_BEHIND]));
}

#[test]
fn self_trade_fok_empty_account_ids_are_missing_they_refuse_not_fill() {
    let mut book = OrderBook::new(MARKET);
    let rest = submit(
        &mut book,
        &order(ST_OWN, "", Side::Sell, "5", Some("100"), Tif::Gtc),
    );
    assert!(!rest.accepted);
    assert_eq!(code(&rest), Some("self_trade"));

    let result = submit(
        &mut book,
        &order(ST_TAKE, "", Side::Buy, "5", Some("100"), Tif::Fok),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("self_trade"));
    assert!(result.fills.is_empty());
}

#[test]
fn self_trade_journal_replay_expires_the_rest_and_does_not_invent_a_self_fill() {
    let rest = order(ST_OWN, "same", Side::Buy, "1", Some("100"), Tif::Gtc);
    let take = order(ST_TAKE, "same", Side::Sell, "1", Some("100"), Tif::Gtc);
    let mut journal = MemoryJournal::new();
    journal
        .append(&submit_record(&rest, "2026-08-25T16:00:00.000Z"))
        .unwrap();
    journal
        .append(&submit_record(&take, "2026-08-25T16:00:01.000Z"))
        .unwrap();

    let mut live = OrderBook::new(MARKET);
    assert!(submit(&mut live, &rest).accepted);
    let taken = submit(&mut live, &take);
    assert!(taken.accepted);
    assert!(taken.fills.is_empty());
    assert_eq!(
        taken.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    let engine = replay(Box::new(journal));
    let replayed = engine.existing_book(MARKET);
    assert_eq!(replayed.map(OrderBook::serialize), Some(live.serialize()));
    let replayed = replayed.unwrap();
    assert_eq!(
        replayed.to_state().get("bids"),
        Some(&Json::Array(Vec::new()))
    );
    assert_eq!(ids_of(replayed.to_state().get("asks")), ids(&[ST_TAKE]));
    assert_eq!(
        cases_json(live.open_surveillance_cases()),
        vec![case_json("same")]
    );
    assert_eq!(
        replayed.open_surveillance_cases(),
        live.open_surveillance_cases()
    );
}

/// "helpers: same live account only when both ids are present", but for `selfTradeExpire`, which Rust has no
/// counterpart of (helper not ported).
#[test]
fn self_trade_helpers_same_live_account_only_when_both_ids_are_present() {
    assert!(is_self_trade("a", "a"));
    assert!(!is_self_trade("a", "b"));
    assert!(!is_self_trade("", ""));
    assert!(!is_self_trade("", "a"));
    assert!(stp_identity_refuse("same").is_none());
    assert_eq!(
        stp_identity_refuse("").map(|r| r.code),
        Some("self_trade".to_owned())
    );
    assert_eq!(
        stp_identity_refuse("   ").map(|r| r.code),
        Some("self_trade".to_owned())
    );
}

/// `selfTradeSurveillanceCase` is `self_trade_case` in Rust: `{ ok: true, case }` is `Some(case)`, `ok: false` is
/// `None`.
#[test]
fn self_trade_stp_names_an_open_self_trade_case_not_a_silent_drop_not_a_sanction() {
    let named = self_trade_case("same", MARKET);
    assert_eq!(named.map(|c| c.to_json()), Some(case_json("same")));
    assert!(self_trade_case("", MARKET).is_none());
}

// ── maker-or-cancel.test.ts ─────────────────────────────────────────────

const MOC_ASK: &str = "11111111-1111-4111-8111-111111111111";
const MOC_BUY: &str = "22222222-2222-4222-8222-222222222222";
const MOC_MARKET: &str = "BTC-USDT";

#[test]
fn maker_or_cancel_given_btc_usdt_best_ask_100_a_limit_buy_at_100_with_moc_is_rejected_and_no_fill_is_posted()
 {
    let mut book = OrderBook::new(MOC_MARKET);
    submit(
        &mut book,
        &order(MOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(MOC_BUY, "desk", Side::Buy, "1", Some("100"), Tif::Moc),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("moc_would_take"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(format_amount(book.best_ask().unwrap()), "100");
    assert!(book.best_bid().is_none());
}

#[test]
fn maker_or_cancel_a_retry_with_the_same_order_id_does_not_rest() {
    let mut book = OrderBook::new(MOC_MARKET);
    submit(
        &mut book,
        &order(MOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(MOC_BUY, "desk", Side::Buy, "1", Some("100"), Tif::Moc),
    );

    let again = submit(
        &mut book,
        &order(MOC_BUY, "desk", Side::Buy, "1", Some("99"), Tif::Moc),
    );

    assert!(!again.accepted);
    assert_eq!(code(&again), Some("duplicate_order_id"));
    assert!(again.fills.is_empty());
    assert!(again.resting.is_none());
    assert!(book.best_bid().is_none());
    assert_eq!(format_amount(book.best_ask().unwrap()), "100");
}

#[test]
fn maker_or_cancel_a_maker_or_cancel_behind_the_ask_rests_at_its_own_price() {
    let mut book = OrderBook::new(MOC_MARKET);
    submit(
        &mut book,
        &order(MOC_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );

    let result = submit(
        &mut book,
        &order(MOC_BUY, "desk", Side::Buy, "1", Some("99"), Tif::Moc),
    );

    assert!(result.accepted);
    assert!(result.fills.is_empty());
    assert_eq!(format_amount(result.resting.as_ref().unwrap().price), "99");
    assert_eq!(format_amount(book.best_ask().unwrap()), "100");
}

// ── collar.test.ts ──────────────────────────────────────────────────────

const CO_ASK: &str = "11111111-1111-4111-8111-111111111111";
const CO_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const CO_MISS: &str = "44444444-4444-4444-8444-444444444444";
const CO_PLAIN: &str = "55555555-5555-4555-8555-555555555555";
const CO_LAST: &str = "66666666-6666-4666-8666-666666666666";

fn collared(mut o: EngineOrder, collar: bool, min: Option<&str>, max: Option<&str>) -> EngineOrder {
    o.collar = Opt::Some(collar);
    if let Some(m) = min {
        o.min = Opt::Some(a(m));
    }
    if let Some(m) = max {
        o.max = Opt::Some(a(m));
    }
    o
}

/// A fresh directory under the system's temporary one (`mkdtempSync`).
fn temp_dir(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn collar_missing_flags_are_a_normal_order_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(CO_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(take.resting.as_ref().map(|r| r.remaining), Some(a("8")));
}

#[test]
fn collar_false_is_a_normal_order_no_invented_band() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &collared(
            order(CO_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            false,
            None,
            None,
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
}

#[test]
fn collar_true_without_min_max_refuses_last_and_mid_on_the_book_are_not_a_band() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_LAST, "mm", Side::Buy, "1", Some("99"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "1", Some("101"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &collared(
            order(CO_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            true,
            None,
            None,
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_collar"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[CO_LAST, CO_ASK]));
}

#[test]
fn collar_true_with_only_min_refuses_no_invented_max_from_last_or_mid() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &collared(
            order(CO_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            true,
            Some("90"),
            None,
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_collar"));
    assert_eq!(live_ids(&book), ids(&[CO_ASK]));
}

#[test]
fn collar_true_with_only_max_refuses_no_invented_min_from_last_or_mid() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &collared(
            order(CO_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            true,
            None,
            Some("110"),
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_collar"));
    assert!(live_ids(&book).is_empty());
}

#[test]
fn collar_submit_below_min_refuses_no_rest() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "2", Some("80"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &collared(
            order(CO_MISS, "desk", Side::Buy, "10", Some("80"), Tif::Gtc),
            true,
            Some("90"),
            Some("110"),
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("outside_collar"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[CO_ASK]));
}

#[test]
fn collar_submit_above_max_refuses_no_rest() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &collared(
            order(CO_MISS, "desk", Side::Sell, "10", Some("120"), Tif::Gtc),
            true,
            Some("90"),
            Some("110"),
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("outside_collar"));
    assert!(live_ids(&book).is_empty());
}

#[test]
fn collar_submit_on_the_band_takes_at_the_caller_price() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(CO_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &collared(
            order(CO_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            true,
            Some("90"),
            Some("110"),
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.fills[0].price), "100");
}

#[test]
fn collar_submit_at_min_and_max_edges_is_inside_the_band() {
    let mut book = OrderBook::new(MARKET);
    let lo = submit(
        &mut book,
        &collared(
            order(CO_TAKE, "desk", Side::Buy, "1", Some("90"), Tif::Gtc),
            true,
            Some("90"),
            Some("110"),
        ),
    );
    assert!(lo.accepted);
    let hi = submit(
        &mut book,
        &collared(
            order(CO_PLAIN, "desk", Side::Sell, "1", Some("110"), Tif::Gtc),
            true,
            Some("90"),
            Some("110"),
        ),
    );
    assert!(hi.accepted);
}

#[test]
fn collar_journal_replay_of_a_refused_missing_band_does_not_invent_a_book() {
    let c = collared(
        order(CO_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        true,
        None,
        None,
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &c).accepted);
    let engine = replay_memory(&[&c], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn collar_journal_replay_of_a_refused_outside_band_submit_does_not_invent_a_book() {
    let c = collared(
        order(CO_TAKE, "desk", Side::Buy, "10", Some("50"), Tif::Gtc),
        true,
        Some("90"),
        Some("110"),
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &c).accepted);
    let engine = replay_memory(&[&c], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn collar_file_journal_encode_persists_collar_min_max_crash_replay_of_a_missing_band_still_refuses_does_not_rest()
 {
    let dir = temp_dir("matching-collar-journal-");
    let path = dir.join("engine.ndjson");
    let c = collared(
        order(CO_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        true,
        None,
        None,
    );
    let live = submit(&mut OrderBook::new(MARKET), &c);
    assert!(!live.accepted);
    assert_eq!(code(&live), Some("missing_collar"));
    assert!(live.resting.is_none());

    let mut j1 = FileJournal::open(&path).unwrap();
    j1.append(&submit_record(&c, "2026-08-25T16:00:00.000Z"))
        .unwrap();
    j1.close().unwrap();
    drop(j1);

    let on_disk = json::parse(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
    assert_eq!(
        on_disk.get("order").and_then(|o| o.get("collar")),
        Some(&Json::Bool(true))
    );

    let j2 = FileJournal::open(&path).unwrap();
    let engine = replay(Box::new(j2));
    assert!(engine.existing_book(MARKET).is_none());
    drop(engine);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn collar_file_journal_encode_persists_min_max_crash_replay_of_an_outside_band_submit_still_refuses_does_not_rest()
 {
    let dir = temp_dir("matching-collar-journal-");
    let path = dir.join("engine.ndjson");
    let c = collared(
        order(CO_TAKE, "desk", Side::Buy, "10", Some("50"), Tif::Gtc),
        true,
        Some("90"),
        Some("110"),
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &c).accepted);

    let mut j1 = FileJournal::open(&path).unwrap();
    j1.append(&submit_record(&c, "2026-08-25T16:00:00.000Z"))
        .unwrap();
    j1.close().unwrap();
    drop(j1);

    let on_disk = json::parse(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
    let o = on_disk.get("order").unwrap();
    assert_eq!(o.get("collar"), Some(&Json::Bool(true)));
    assert_eq!(o.get("min"), Some(&Json::str("90")));
    assert_eq!(o.get("max"), Some(&Json::str("110")));

    let j2 = FileJournal::open(&path).unwrap();
    let engine = replay(Box::new(j2));
    assert!(engine.existing_book(MARKET).is_none());
    drop(engine);
    std::fs::remove_dir_all(&dir).ok();
}

/// The `collarIntentRefuse` part of "read helpers treat missing and false as not set; execute needs both bounds".
/// `readCollar`, `readMin`, `readMax`, `missingCollarRefuse` and `outsideCollarRefuse` have no Rust counterpart
/// (helpers not ported).
#[test]
fn collar_read_helpers_treat_missing_and_false_as_not_set_execute_needs_both_bounds() {
    let intent =
        |collar: Option<bool>, min: Option<&str>, max: Option<&str>, price: Option<&str>| {
            let mut o = order(CO_TAKE, "desk", Side::Buy, "1", price, Tif::Gtc);
            if let Some(c) = collar {
                o.collar = Opt::Some(c);
            }
            if let Some(m) = min {
                o.min = Opt::Some(a(m));
            }
            if let Some(m) = max {
                o.max = Opt::Some(a(m));
            }
            collar_intent_refuse(&o).map(|r| r.code)
        };
    assert_eq!(
        intent(Some(true), None, None, None),
        Some("missing_collar".to_owned())
    );
    assert_eq!(
        intent(Some(true), Some("90"), Some("110"), Some("80")),
        Some("outside_collar".to_owned())
    );
    assert_eq!(
        intent(Some(true), Some("90"), Some("110"), Some("100")),
        None
    );
    assert_eq!(intent(None, None, None, None), None);
}

// ── post-only.test.ts ───────────────────────────────────────────────────

const PO_ASK: &str = "11111111-1111-4111-8111-111111111111";
const PO_PO: &str = "22222222-2222-4222-8222-222222222222";
const PO_CROSS: &str = "33333333-3333-4333-8333-333333333333";
const PO_AMEND: &str = "22222222-2222-4222-8222-222222222222";

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn post_only_rests_a_post_only_behind_the_spread_no_invented_price() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PO_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(PO_PO, "desk", Side::Buy, "1", Some("99"), Tif::Po),
    );

    assert!(result.accepted);
    assert!(result.fills.is_empty());
    assert_eq!(
        result.resting.as_ref().map(|r| r.kind),
        Some(RestKind::Book)
    );
    assert_eq!(format_amount(result.resting.as_ref().unwrap().price), "99");
    assert_eq!(
        first_order(&book, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );
    assert_eq!(live_ids_sorted(&book), sorted(ids(&[PO_ASK, PO_PO])));
}

#[test]
fn post_only_refuses_a_post_only_that_would_take() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PO_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &order(PO_CROSS, "desk", Side::Buy, "1", Some("100"), Tif::Po),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("post_only_would_cross"));
    assert!(result.fills.is_empty());
    assert_eq!(live_ids_sorted(&book), ids(&[PO_ASK]));
    assert_eq!(book.current_sequence(), 1);
}

#[test]
fn post_only_refuses_a_post_only_without_a_price_the_engine_does_not_invent_one() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &order(PO_PO, "desk", Side::Buy, "1", None, Tif::Po),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("invalid_tif"));
    assert_eq!(book.current_sequence(), 0);
}

#[test]
fn post_only_a_later_price_amend_that_would_take_is_refused_the_rest_stays_post_only() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PO_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let rest = submit(
        &mut book,
        &order(PO_PO, "desk", Side::Buy, "1", Some("99"), Tif::Po),
    );
    assert!(rest.accepted);

    let amended = book.amend(
        &EngineAmend {
            order_id: PO_AMEND.to_owned(),
            expected_version: rest.resting.as_ref().unwrap().version,
            price: Some(a("100")),
            ..EngineAmend::default()
        },
        None,
    );

    assert!(!amended.accepted);
    assert_eq!(
        amended.rejected.as_ref().map(|r| r.code.as_str()),
        Some("post_only_would_cross")
    );
    assert!(amended.fills.is_empty());
    assert_eq!(live_ids_sorted(&book), sorted(ids(&[PO_ASK, PO_PO])));
    assert_eq!(
        first_order(&book, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );
    assert_eq!(text(first_order(&book, "bids").get("remaining")), "1");
}

#[test]
fn post_only_journal_replay_rebuilds_the_post_only_rest() {
    let mut live = OrderBook::new(MARKET);
    let ask = order(PO_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc);
    let rest = order(PO_PO, "desk", Side::Buy, "1", Some("99"), Tif::Po);
    for o in [&ask, &rest] {
        submit(&mut live, o);
    }
    let engine = replay_memory(&[&ask, &rest], "2026-08-25T14:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(
        first_order(restored, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );
}

// ── reduce-only.test.ts ─────────────────────────────────────────────────

const RO_OPEN: &str = "11111111-1111-4111-8111-111111111111";
const RO_LIQ: &str = "22222222-2222-4222-8222-222222222222";
const RO_RO: &str = "33333333-3333-4333-8333-333333333333";
const RO_FLAT: &str = "44444444-4444-4444-8444-444444444444";
const RO_CLOSE: &str = "55555555-5555-4555-8555-555555555555";
const RO_TAKER: &str = "66666666-6666-4666-8666-666666666666";
const RO_RO2: &str = "77777777-7777-4777-8777-777777777777";

fn reduce_only(mut o: EngineOrder) -> EngineOrder {
    o.reduce_only = true;
    o
}

fn position(account: &str, qty: &str) -> Json {
    Json::obj([("accountId", Json::str(account)), ("qty", Json::str(qty))])
}

/// Desk buys 2 from mm at 100: desk is long 2. Position is fills, not a mark.
fn open_long(book: &mut OrderBook) {
    submit(
        book,
        &order(RO_LIQ, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let fill = submit(
        book,
        &order(RO_OPEN, "desk", Side::Buy, "2", Some("100"), Tif::Gtc),
    );
    assert!(fill.accepted);
    assert_eq!(fill.fills.len(), 1);
    assert_eq!(
        book.to_state().get("positions"),
        Some(&Json::Array(vec![
            position("desk", "2"),
            position("mm", "-2")
        ]))
    );
}

#[test]
fn reduce_only_rests_a_reduce_only_sell_against_a_long_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    open_long(&mut book);
    let result = submit(
        &mut book,
        &reduce_only(order(RO_RO, "desk", Side::Sell, "1", Some("101"), Tif::Gtc)),
    );

    assert!(result.accepted);
    assert_eq!(
        result.resting.as_ref().map(|r| r.kind),
        Some(RestKind::Book)
    );
    assert_eq!(
        format_amount(result.resting.as_ref().unwrap().remaining),
        "1"
    );
    assert_eq!(
        first_order(&book, "asks").get("reduceOnly"),
        Some(&Json::Bool(true))
    );
    assert_eq!(live_ids_sorted(&book), ids(&[RO_RO]));
}

#[test]
fn reduce_only_refuses_a_reduce_only_buy_on_a_long_that_would_increase() {
    let mut book = OrderBook::new(MARKET);
    open_long(&mut book);
    let result = submit(
        &mut book,
        &reduce_only(order(RO_RO, "desk", Side::Buy, "1", Some("99"), Tif::Gtc)),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("would_increase_position"));
    assert!(result.fills.is_empty());
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn reduce_only_refuses_a_flat_account_opening_is_an_increase() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &reduce_only(order(
            RO_RO,
            "stranger",
            Side::Sell,
            "1",
            Some("101"),
            Tif::Gtc,
        )),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("would_increase_position"));
    assert_eq!(book.current_sequence(), 0);
}

#[test]
fn reduce_only_refuses_a_qty_larger_than_the_position_flip_would_increase_the_other_side() {
    let mut book = OrderBook::new(MARKET);
    open_long(&mut book);
    let result = submit(
        &mut book,
        &reduce_only(order(RO_RO, "desk", Side::Sell, "3", Some("101"), Tif::Gtc)),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("would_increase_position"));
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn reduce_only_two_reduce_only_sells_that_each_equal_the_long_do_not_both_fill() {
    let mut book = OrderBook::new(MARKET);
    open_long(&mut book);

    let first = submit(
        &mut book,
        &reduce_only(order(RO_RO, "desk", Side::Sell, "2", Some("101"), Tif::Gtc)),
    );
    assert!(first.accepted);
    assert!(first.fills.is_empty());

    let second = submit(
        &mut book,
        &reduce_only(order(
            RO_RO2,
            "desk",
            Side::Sell,
            "2",
            Some("102"),
            Tif::Gtc,
        )),
    );
    let lift = submit(
        &mut book,
        &order(RO_TAKER, "buyer", Side::Buy, "4", Some("102"), Tif::Ioc),
    );

    let state = book.to_state();
    let desk = match state.get("positions") {
        Some(Json::Array(rows)) => rows
            .iter()
            .find(|p| p.get("accountId") == Some(&Json::str("desk")))
            .cloned(),
        _ => None,
    };
    assert!(desk.is_none());
    assert_eq!(lift.fills.len(), 1);
    assert_eq!(format_amount(lift.fills[0].qty), "2");
    assert!(!second.accepted);
    assert_eq!(code(&second), Some("would_increase_position"));
    assert!(second.fills.is_empty());
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn reduce_only_a_later_fill_that_closes_the_long_pulls_the_resting_reduce_only() {
    let mut book = OrderBook::new(MARKET);
    open_long(&mut book);
    submit(
        &mut book,
        &reduce_only(order(RO_RO, "desk", Side::Sell, "1", Some("101"), Tif::Gtc)),
    );
    submit(
        &mut book,
        &order(RO_FLAT, "mm", Side::Buy, "2", Some("99"), Tif::Gtc),
    );
    let close = submit(
        &mut book,
        &order(RO_CLOSE, "desk", Side::Sell, "2", Some("99"), Tif::Gtc),
    );

    assert!(close.accepted);
    assert_eq!(
        close
            .cancellations
            .iter()
            .map(|c| (c.order_id.as_str(), c.reason))
            .collect::<Vec<_>>(),
        vec![(RO_RO, CancelReason::WouldIncreasePosition)]
    );
    assert!(live_ids_sorted(&book).is_empty());
    assert!(book.to_state().get("positions").is_none());
}

#[test]
fn reduce_only_gtc_without_reduce_only_never_grows_a_reduce_only_flag() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(RO_LIQ, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    assert!(first_order(&book, "asks").get("reduceOnly").is_none());
    assert!(book.to_state().get("positions").is_none());
}

#[test]
fn reduce_only_journal_replay_rebuilds_the_rest_and_the_fill_derived_position() {
    let mut live = OrderBook::new(MARKET);
    let liq = order(RO_LIQ, "mm", Side::Sell, "2", Some("100"), Tif::Gtc);
    let open = order(RO_OPEN, "desk", Side::Buy, "2", Some("100"), Tif::Gtc);
    let rest = reduce_only(order(RO_RO, "desk", Side::Sell, "1", Some("101"), Tif::Gtc));
    for o in [&liq, &open, &rest] {
        submit(&mut live, o);
    }

    let engine = replay_memory(&[&liq, &open, &rest], "2026-08-25T12:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(live_ids_sorted(restored), ids(&[RO_RO]));
    assert_eq!(
        restored.to_state().get("positions"),
        Some(&Json::Array(vec![
            position("desk", "2"),
            position("mm", "-2")
        ]))
    );
    assert_eq!(
        first_order(restored, "asks").get("reduceOnly"),
        Some(&Json::Bool(true))
    );
}
