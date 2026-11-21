//! The liquidity rules of the book slice, ported test for test from the TypeScript engine tests under
//! `services/svc-matching/src/engine/`: `iceberg.test.ts`, `peg.test.ts`, `aon.test.ts` and `auction.test.ts`.
//! Each test is named after its TypeScript `it`, prefixed with the file's topic. The TypeScript `replay(records)` is
//! the engine's cold start here (`MatchingEngine::recover` over the same journal), which rebuilds each book the same
//! way and drops a book that never printed and holds nothing.
//!
//! Not ported one for one, and why (each is ported through its Rust equivalent instead):
//! - `iceberg.test.ts` "helpers refuse missing and not-smaller display": `hiddenRemaining` has no Rust counterpart
//!   (helper not ported); its `10 - 2 = 8` is held by the book's own `remaining` in "a take larger than display".
//!   `wantsIceberg` takes the whole order in Rust, so `{ iceberg: true }` and `{}` are orders.
//! - `peg.test.ts` "read helpers ...": `readPeg`, `readRelative`, `readMidpoint`, `readReference`, `readOffset`,
//!   `referenceRefuse`, `offsetRefuse`, `midpointRefuse` and `pegPrice` have no Rust counterpart (private or folded
//!   into `peg_intent_refuse` and `bind_peg_relative`). Each read is checked through `peg_intent_refuse` (what a value
//!   reads as decides the refusal) and `pegPrice` through `bind_peg_relative`'s bound price.
//! - `auction.test.ts` "read helpers ...": `readAuction`, `readBenchmark`, `auctionRefuse` and `benchmarkRefuse` have
//!   no Rust counterpart (folded into `auction_intent_refuse`); each is checked through `auction_intent_refuse`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::rules::{
    aon_iceberg_refuse, auction_intent_refuse, bind_peg_relative, can_fill_aon, clip_meets_aon,
    iceberg_display_refuse, peg_intent_refuse, read_aon, refill_display, visible_remaining,
    wants_iceberg,
};
use svc_matching::book::types::{
    CancelReason, EngineOrder, Opt, OrderType, Side, SubmitResult, Tif,
};
use svc_matching::book::wire::to_wire;
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal, MemoryJournal};
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

/// Bids then asks, unsorted (the `liveIds` of the peg and auction tests).
fn live_ids(book: &OrderBook) -> Vec<String> {
    let state = book.to_state();
    let mut ids = ids_of(state.get("bids"));
    ids.extend(ids_of(state.get("asks")));
    ids
}

/// Bids, asks and stops, sorted (the `liveIds` of the aon tests).
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

/// `book.toState()[side][0].orders`.
fn first_level_orders(book: &OrderBook, side: &str) -> Vec<Json> {
    let state = book.to_state();
    let Some(Json::Array(levels)) = state.get(side) else {
        panic!("{side} is an array")
    };
    let Some(Json::Array(orders)) = levels[0].get("orders") else {
        panic!("a level holds orders")
    };
    orders.clone()
}

/// `book.toState()[side][0].orders[0]`.
fn first_order(book: &OrderBook, side: &str) -> Json {
    first_level_orders(book, side)[0].clone()
}

/// `book.toState()[side][0].orders.find((o) => o.orderId === id)`.
fn find_order(book: &OrderBook, side: &str, id: &str) -> Json {
    first_level_orders(book, side)
        .into_iter()
        .find(|o| text(o.get("orderId")) == id)
        .unwrap()
}

/// `book.depth(50).bids` and `.asks`, as `[price, qty]` text pairs.
fn depth_bids(book: &OrderBook) -> Vec<(String, String)> {
    book.depth(50)
        .0
        .iter()
        .map(|(p, q)| (format_amount(*p), format_amount(*q)))
        .collect()
}

fn depth_asks(book: &OrderBook) -> Vec<(String, String)> {
    book.depth(50)
        .1
        .iter()
        .map(|(p, q)| (format_amount(*p), format_amount(*q)))
        .collect()
}

fn level(price: &str, qty: &str) -> (String, String) {
    (price.to_owned(), qty.to_owned())
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

fn fill_pairs(r: &SubmitResult) -> Vec<(String, String)> {
    r.fills
        .iter()
        .map(|f| (f.maker_order_id.clone(), format_amount(f.qty)))
        .collect()
}

// ── iceberg.test.ts ─────────────────────────────────────────────────────

const ICE: &str = "11111111-1111-4111-8111-111111111111";
const ICE_TAKE: &str = "22222222-2222-4222-8222-222222222222";
const ICE_TAKE2: &str = "33333333-3333-4333-8333-333333333333";
const ICE_MISS: &str = "44444444-4444-4444-8444-444444444444";
const ICE_BIG: &str = "55555555-5555-4555-8555-555555555555";
const ICE_OTHER: &str = "66666666-6666-4666-8666-666666666666";

/// `order({ ..., displayQty })`: `iceberg: true` and the display (`null` is `Opt::Null`).
fn with_display(mut o: EngineOrder, display: Option<&str>) -> EngineOrder {
    o.iceberg = true;
    o.display_qty = display.map_or(Opt::Null, |d| Opt::Some(a(d)));
    o
}

#[test]
fn iceberg_rests_with_only_the_display_qty_on_the_public_book() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &with_display(
            order(ICE, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("2"),
        ),
    );

    assert!(result.accepted);
    assert!(result.resting.is_some());
    assert_eq!(
        format_amount(result.resting.as_ref().unwrap().remaining),
        "10"
    );
    assert_eq!(depth_asks(&book), vec![level("100", "2")]);
    let state = first_order(&book, "asks");
    assert_eq!(text(state.get("remaining")), "10");
    assert_eq!(text(state.get("displayQty")), "2");
    assert_eq!(text(state.get("displayRemaining")), "2");
}

#[test]
fn iceberg_a_take_larger_than_display_only_hits_the_visible_slice() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_display(
            order(ICE, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("2"),
        ),
    );
    let take = submit(
        &mut book,
        &order(ICE_TAKE, "desk", Side::Buy, "8", Some("100"), Tif::Gtc),
    );

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.resting.as_ref().unwrap().remaining), "6");
    let ice = find_order(&book, "asks", ICE);
    assert_eq!(text(ice.get("remaining")), "8");
    assert_eq!(text(ice.get("displayRemaining")), "2");
    assert_eq!(depth_asks(&book), vec![level("100", "2")]);
}

#[test]
fn iceberg_fills_the_other_order_at_the_same_price_and_does_not_take_a_second_iceberg_slice() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_display(
            order(ICE, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("2"),
        ),
    );
    submit(
        &mut book,
        &order(ICE_OTHER, "other", Side::Sell, "3", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(ICE_TAKE, "taker", Side::Buy, "8", Some("100"), Tif::Gtc),
    );
    assert_eq!(
        fill_pairs(&take),
        vec![level(ICE, "2"), level(ICE_OTHER, "3")]
    );
    let ice = find_order(&book, "asks", ICE);
    assert_eq!(text(ice.get("remaining")), "8");
    assert_eq!(text(ice.get("displayRemaining")), "2");
}

#[test]
fn iceberg_still_fills_the_next_price_after_one_iceberg_slice() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_display(
            order(ICE, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("2"),
        ),
    );
    submit(
        &mut book,
        &order(ICE_OTHER, "other", Side::Sell, "1", Some("101"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(ICE_TAKE, "taker", Side::Buy, "8", Some("101"), Tif::Gtc),
    );
    assert_eq!(
        fill_pairs(&take),
        vec![level(ICE, "2"), level(ICE_OTHER, "1")]
    );
    let ice = find_order(&book, "asks", ICE);
    assert_eq!(text(ice.get("remaining")), "8");
}

#[test]
fn iceberg_hidden_remainder_refills_the_display_after_the_visible_slice_is_taken() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_display(
            order(ICE, "mm", Side::Sell, "5", Some("100"), Tif::Gtc),
            Some("2"),
        ),
    );
    submit(
        &mut book,
        &order(ICE_TAKE, "desk", Side::Buy, "2", Some("100"), Tif::Gtc),
    );

    let ice = first_order(&book, "asks");
    assert_eq!(text(ice.get("orderId")), ICE);
    assert_eq!(text(ice.get("remaining")), "3");
    assert_eq!(text(ice.get("displayRemaining")), "2");
    assert_eq!(depth_asks(&book), vec![level("100", "2")]);

    let take2 = submit(
        &mut book,
        &order(ICE_TAKE2, "desk", Side::Buy, "2", Some("100"), Tif::Gtc),
    );
    assert_eq!(format_amount(take2.fills[0].qty), "2");
    let after = first_order(&book, "asks");
    assert_eq!(text(after.get("remaining")), "1");
    assert_eq!(text(after.get("displayRemaining")), "1");
    assert_eq!(depth_asks(&book), vec![level("100", "1")]);
}

#[test]
fn iceberg_refuses_a_missing_display_no_invented_display() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &with_display(
            order(ICE_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            None,
        ),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("iceberg_display_missing"));
    assert!(result.resting.is_none());
    assert!(depth_asks(&book).is_empty());
}

#[test]
fn iceberg_refuses_a_display_that_is_not_smaller_than_total() {
    let mut book = OrderBook::new(MARKET);
    let same = submit(
        &mut book,
        &with_display(
            order(ICE_BIG, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("10"),
        ),
    );
    assert!(!same.accepted);
    assert_eq!(code(&same), Some("iceberg_display_not_smaller"));

    let over = submit(
        &mut book,
        &with_display(
            order(ICE_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            Some("11"),
        ),
    );
    assert!(!over.accepted);
    assert_eq!(code(&over), Some("iceberg_display_not_smaller"));
    assert!(depth_asks(&book).is_empty());
}

#[test]
fn iceberg_journal_replay_keeps_hidden_remainder_off_the_public_book() {
    let mut live = OrderBook::new(MARKET);
    let ice = with_display(
        order(ICE, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
        Some("2"),
    );
    let take = order(ICE_TAKE, "desk", Side::Buy, "2", Some("100"), Tif::Gtc);
    for o in [&ice, &take] {
        submit(&mut live, o);
    }
    let engine = replay_memory(&[&ice, &take], "2026-08-25T15:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(depth_asks(restored), vec![level("100", "2")]);
    assert_eq!(text(first_order(restored, "asks").get("remaining")), "8");
}

#[test]
fn iceberg_helpers_refuse_missing_and_not_smaller_display() {
    let refuse = |qty: &str, display: Option<&str>| {
        iceberg_display_refuse(a(qty), display.map(a)).map(|r| r.code)
    };
    assert_eq!(
        refuse("10", None),
        Some("iceberg_display_missing".to_owned())
    );
    assert_eq!(
        refuse("10", Some("0")),
        Some("iceberg_display_missing".to_owned())
    );
    assert_eq!(
        refuse("10", Some("10")),
        Some("iceberg_display_not_smaller".to_owned())
    );
    assert_eq!(refuse("10", Some("2")), None);
    assert_eq!(format_amount(visible_remaining(a("10"), Some(a("2")))), "2");
    assert_eq!(format_amount(visible_remaining(a("10"), None)), "10");
    assert_eq!(format_amount(refill_display(a("2"), a("1"))), "1");
    let mut flagged = order(ICE, "desk", Side::Sell, "10", Some("100"), Tif::Gtc);
    flagged.iceberg = true;
    assert!(wants_iceberg(&flagged));
    assert!(!wants_iceberg(&order(
        ICE,
        "desk",
        Side::Sell,
        "10",
        Some("100"),
        Tif::Gtc
    )));
}

// ── peg.test.ts ─────────────────────────────────────────────────────────

const PEG_ASK: &str = "11111111-1111-4111-8111-111111111111";
const PEG_BID: &str = "22222222-2222-4222-8222-222222222222";
const PEG_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const PEG_MISS: &str = "44444444-4444-4444-8444-444444444444";
const PEG_PLAIN: &str = "55555555-5555-4555-8555-555555555555";

/// The peg spec's flags and terms: each `None` is absent.
#[derive(Default, Clone, Copy)]
struct PegSpec<'a> {
    peg: Option<bool>,
    midpoint: Option<bool>,
    relative: Option<bool>,
    reference: Option<&'a str>,
    offset: Option<&'a str>,
}

fn pegged(mut o: EngineOrder, spec: PegSpec<'_>) -> EngineOrder {
    if let Some(v) = spec.peg {
        o.peg = Opt::Some(v);
    }
    if let Some(v) = spec.midpoint {
        o.midpoint = Opt::Some(v);
    }
    if let Some(v) = spec.relative {
        o.relative = Opt::Some(v);
    }
    if let Some(v) = spec.reference {
        o.reference = Opt::Some(a(v));
    }
    if let Some(v) = spec.offset {
        o.offset = Opt::Some(a(v));
    }
    o
}

#[test]
fn peg_missing_flags_are_a_normal_order_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PEG_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(PEG_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(take.resting.as_ref().map(|r| r.remaining), Some(a("8")));
}

#[test]
fn peg_false_relative_false_is_a_normal_order_no_invented_reference() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PEG_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &pegged(
            order(PEG_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            PegSpec {
                peg: Some(false),
                relative: Some(false),
                ..PegSpec::default()
            },
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
}

#[test]
fn peg_true_without_reference_refuses_no_rest_no_invented_mid() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PEG_BID, "mm", Side::Buy, "1", Some("10"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(PEG_ASK, "mm", Side::Sell, "1", Some("90"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &pegged(
            order(PEG_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            PegSpec {
                peg: Some(true),
                offset: Some("1"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_reference"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[PEG_BID, PEG_ASK]));
}

#[test]
fn peg_true_without_offset_refuses_no_rest_no_invented_mid() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &pegged(
            order(PEG_MISS, "desk", Side::Buy, "10", None, Tif::Gtc),
            PegSpec {
                peg: Some(true),
                reference: Some("100"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("missing_offset"));
    assert!(result.fills.is_empty());
    assert!(live_ids(&book).is_empty());
}

#[test]
fn peg_relative_true_without_reference_or_offset_refuses() {
    let mut book = OrderBook::new(MARKET);
    let missing_ref = submit(
        &mut book,
        &pegged(
            order(PEG_MISS, "desk", Side::Sell, "10", None, Tif::Gtc),
            PegSpec {
                relative: Some(true),
                offset: Some("0"),
                ..PegSpec::default()
            },
        ),
    );
    assert_eq!(code(&missing_ref), Some("missing_reference"));
    let missing_off = submit(
        &mut book,
        &pegged(
            order(PEG_TAKE, "desk", Side::Sell, "10", None, Tif::Gtc),
            PegSpec {
                relative: Some(true),
                reference: Some("100"),
                ..PegSpec::default()
            },
        ),
    );
    assert_eq!(code(&missing_off), Some("missing_offset"));
}

#[test]
fn peg_midpoint_true_refuses_even_with_reference_and_offset_no_invented_mid() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &pegged(
            order(PEG_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            PegSpec {
                midpoint: Some(true),
                reference: Some("100"),
                offset: Some("0"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("midpoint_unsupported"));
    assert!(result.fills.is_empty());
    assert!(live_ids(&book).is_empty());
}

#[test]
fn peg_true_with_reference_and_offset_takes_at_that_price_not_at_the_book_mid() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PEG_BID, "mm", Side::Buy, "1", Some("10"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(PEG_ASK, "mm", Side::Sell, "2", Some("101"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &pegged(
            order(PEG_TAKE, "desk", Side::Buy, "10", None, Tif::Gtc),
            PegSpec {
                peg: Some(true),
                reference: Some("100"),
                offset: Some("1"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.fills[0].price), "101");
    assert_eq!(take.resting.as_ref().map(|r| r.remaining), Some(a("8")));
    assert_eq!(format_amount(take.resting.as_ref().unwrap().price), "101");
    let bids = depth_bids(&book);
    assert!(!bids.iter().any(|(p, _)| p == "50"));
    assert_eq!(
        bids.iter()
            .find(|(p, _)| p == "101")
            .map(|(_, q)| q.as_str()),
        Some("8")
    );
}

#[test]
fn peg_relative_true_with_a_negative_offset_rests_at_reference_plus_offset_not_the_book_mid() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PEG_BID, "mm", Side::Buy, "1", Some("10"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(PEG_ASK, "mm", Side::Sell, "1", Some("190"), Tif::Gtc),
    );
    let rest = submit(
        &mut book,
        &pegged(
            order(PEG_TAKE, "desk", Side::Buy, "3", None, Tif::Gtc),
            PegSpec {
                relative: Some(true),
                reference: Some("100"),
                offset: Some("-1"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(rest.accepted);
    assert!(rest.fills.is_empty());
    assert_eq!(format_amount(rest.resting.as_ref().unwrap().price), "99");
    assert_eq!(
        depth_bids(&book)
            .into_iter()
            .map(|(p, _)| p)
            .collect::<Vec<_>>(),
        ids(&["99", "10"])
    );
}

#[test]
fn peg_zero_offset_is_supplied_price_is_the_reference_not_a_mid() {
    let mut book = OrderBook::new(MARKET);
    let rest = submit(
        &mut book,
        &pegged(
            order(PEG_TAKE, "desk", Side::Buy, "3", None, Tif::Gtc),
            PegSpec {
                peg: Some(true),
                reference: Some("100"),
                offset: Some("0"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(rest.accepted);
    assert_eq!(format_amount(rest.resting.as_ref().unwrap().price), "100");
}

#[test]
fn peg_reference_plus_offset_that_is_not_a_positive_price_refuses_no_invented_mid() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &pegged(
            order(PEG_MISS, "desk", Side::Buy, "1", None, Tif::Gtc),
            PegSpec {
                peg: Some(true),
                reference: Some("1"),
                offset: Some("-1"),
                ..PegSpec::default()
            },
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("invalid_price"));
    assert!(live_ids(&book).is_empty());
}

#[test]
fn peg_journal_replay_of_an_executed_peg_rebuilds_the_bound_price() {
    let pegged_order = pegged(
        order(PEG_TAKE, "desk", Side::Buy, "10", None, Tif::Gtc),
        PegSpec {
            peg: Some(true),
            reference: Some("100"),
            offset: Some("1"),
            ..PegSpec::default()
        },
    );
    assert_eq!(
        submit(&mut OrderBook::new(MARKET), &pegged_order)
            .resting
            .map(|r| r.price),
        Some(a("101"))
    );
    let engine = replay_memory(&[&pegged_order], "2026-08-25T16:00:00.000Z");
    let recovered = engine.existing_book(MARKET).unwrap();
    let state = recovered.to_state();
    let Some(Json::Array(bids)) = state.get("bids") else {
        panic!("bids are an array")
    };
    assert_eq!(text(bids[0].get("price")), "101");
    assert_eq!(
        text(first_order(recovered, "bids").get("orderId")),
        PEG_TAKE
    );
}

#[test]
fn peg_journal_replay_of_a_refused_peg_does_not_invent_a_book() {
    let pegged_order = pegged(
        order(PEG_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        PegSpec {
            peg: Some(true),
            ..PegSpec::default()
        },
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &pegged_order).accepted);
    let engine = replay_memory(&[&pegged_order], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

/// The read helpers are checked through `peg_intent_refuse` (what each value reads as decides the refusal) and
/// `pegPrice` through `bind_peg_relative` (see the header).
#[test]
fn peg_read_helpers_treat_missing_and_false_as_not_set_execute_needs_both_numbers() {
    let base = || order(PEG_TAKE, "desk", Side::Buy, "1", None, Tif::Gtc);
    let refuse = |spec: PegSpec<'_>| peg_intent_refuse(&pegged(base(), spec)).map(|r| r.code);
    let with_null = |mut o: EngineOrder, reference_null: bool, offset_null: bool| {
        if reference_null {
            o.reference = Opt::Null;
        }
        if offset_null {
            o.offset = Opt::Null;
        }
        peg_intent_refuse(&o).map(|r| r.code)
    };

    // readPeg({}) is false; readPeg / readRelative / readMidpoint({ x: true }) is true.
    assert_eq!(refuse(PegSpec::default()), None);
    assert_eq!(
        refuse(PegSpec {
            peg: Some(true),
            ..PegSpec::default()
        }),
        Some("missing_reference".to_owned())
    );
    assert_eq!(
        refuse(PegSpec {
            relative: Some(true),
            ..PegSpec::default()
        }),
        Some("missing_reference".to_owned())
    );
    assert_eq!(
        refuse(PegSpec {
            midpoint: Some(true),
            ..PegSpec::default()
        }),
        Some("midpoint_unsupported".to_owned())
    );
    // readReference: missing, null and 0 are not set; 100 is.
    let peg_off = PegSpec {
        peg: Some(true),
        offset: Some("1"),
        ..PegSpec::default()
    };
    assert_eq!(refuse(peg_off), Some("missing_reference".to_owned()));
    assert_eq!(
        with_null(pegged(base(), peg_off), true, false),
        Some("missing_reference".to_owned())
    );
    assert_eq!(
        refuse(PegSpec {
            reference: Some("0"),
            ..peg_off
        }),
        Some("missing_reference".to_owned())
    );
    assert_eq!(
        refuse(PegSpec {
            reference: Some("100"),
            ..peg_off
        }),
        None
    );
    // readOffset: missing and null are not set; 0 and -1 are.
    let peg_ref = PegSpec {
        peg: Some(true),
        reference: Some("100"),
        ..PegSpec::default()
    };
    assert_eq!(refuse(peg_ref), Some("missing_offset".to_owned()));
    assert_eq!(
        with_null(pegged(base(), peg_ref), false, true),
        Some("missing_offset".to_owned())
    );
    assert_eq!(
        refuse(PegSpec {
            offset: Some("0"),
            ..peg_ref
        }),
        None
    );
    assert_eq!(
        refuse(PegSpec {
            offset: Some("-1"),
            ..peg_ref
        }),
        None
    );
    // pegIntentRefuse.
    assert_eq!(
        refuse(PegSpec {
            peg: Some(true),
            reference: Some("100"),
            offset: Some("1"),
            ..PegSpec::default()
        }),
        None
    );
    assert_eq!(
        refuse(PegSpec {
            relative: Some(true),
            reference: Some("100"),
            offset: Some("0"),
            ..PegSpec::default()
        }),
        None
    );
    assert_eq!(
        refuse(PegSpec {
            midpoint: Some(true),
            reference: Some("100"),
            offset: Some("0"),
            ..PegSpec::default()
        }),
        Some("midpoint_unsupported".to_owned())
    );
    // pegPrice(100, 1) = 101, pegPrice(100, -1) = 99, and bindPegRelative.
    let bound = |offset: &str| {
        bind_peg_relative(&pegged(
            base(),
            PegSpec {
                peg: Some(true),
                reference: Some("100"),
                offset: Some(offset),
                ..PegSpec::default()
            },
        ))
        .price
    };
    assert_eq!(bound("1"), Some(a("101")));
    assert_eq!(bound("-1"), Some(a("99")));
}

// ── aon.test.ts ─────────────────────────────────────────────────────────

const AON_ASK: &str = "11111111-1111-4111-8111-111111111111";
const AON_ASK2: &str = "22222222-2222-4222-8222-222222222222";
const AON_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const AON_MISS: &str = "44444444-4444-4444-8444-444444444444";
const AON_PLAIN: &str = "55555555-5555-4555-8555-555555555555";
const AON_MAKER: &str = "66666666-6666-4666-8666-666666666666";
const AON_FOK: &str = "77777777-7777-4777-8777-777777777777";
const AON_IOC: &str = "88888888-8888-4888-8888-888888888888";

fn with_aon(mut o: EngineOrder, aon: bool) -> EngineOrder {
    o.aon = Opt::Some(aon);
    o
}

#[test]
fn aon_missing_aon_is_a_normal_order_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(AON_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(format_amount(take.resting.as_ref().unwrap().remaining), "8");
}

#[test]
fn aon_false_is_a_normal_order_no_invented_all_or_none() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_aon(
            order(AON_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            false,
        ),
    );

    assert!(take.accepted);
    assert_eq!(format_amount(take.fills[0].qty), "2");
}

#[test]
fn aon_short_book_does_not_take_a_stub_gtc_rests_the_whole() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_aon(
            order(AON_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            true,
        ),
    );

    assert!(take.accepted);
    assert!(take.fills.is_empty());
    assert_eq!(
        format_amount(take.resting.as_ref().unwrap().remaining),
        "10"
    );
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "2");
    assert_eq!(
        first_order(&book, "bids").get("aon"),
        Some(&Json::Bool(true))
    );
}

#[test]
fn aon_fills_two_clips_that_together_cover_remaining() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "5", Some("100"), Tif::Gtc),
    );
    submit(
        &mut book,
        &order(AON_ASK2, "mm-2", Side::Sell, "5", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_aon(
            order(AON_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            true,
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
    assert!(!live_ids_sorted(&book).contains(&AON_TAKE.to_owned()));
}

#[test]
fn aon_a_resting_aon_does_not_fill_below_remaining() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_aon(
            order(AON_MAKER, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            true,
        ),
    );
    let crumb = submit(
        &mut book,
        &order(AON_TAKE, "desk", Side::Buy, "4", Some("100"), Tif::Gtc),
    );

    assert!(crumb.fills.is_empty());
    assert_eq!(
        format_amount(crumb.resting.as_ref().unwrap().remaining),
        "4"
    );
    assert_eq!(text(first_order(&book, "asks").get("remaining")), "10");
}

#[test]
fn aon_a_resting_aon_fills_when_the_clip_exhausts_remaining() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &with_aon(
            order(AON_MAKER, "mm", Side::Sell, "10", Some("100"), Tif::Gtc),
            true,
        ),
    );
    let take = submit(
        &mut book,
        &order(AON_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );

    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "10");
    assert!(!live_ids_sorted(&book).contains(&AON_MAKER.to_owned()));
}

#[test]
fn aon_fok_that_cannot_fill_all_refuses_no_rest_no_stub() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &with_aon(
            order(AON_FOK, "desk", Side::Buy, "3", Some("100"), Tif::Fok),
            true,
        ),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("fok_unfillable"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids_sorted(&book), ids(&[AON_ASK]));
}

#[test]
fn aon_ioc_that_cannot_fill_all_cancels_the_whole_no_stub_fill() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AON_ASK, "mm", Side::Sell, "1", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &with_aon(
            order(AON_IOC, "desk", Side::Buy, "3", Some("100"), Tif::Ioc),
            true,
        ),
    );

    assert!(result.accepted);
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(result.cancellations[0].reason, CancelReason::IocRemainder);
    assert_eq!(format_amount(result.cancellations[0].remaining_qty), "3");
    assert_eq!(live_ids_sorted(&book), ids(&[AON_ASK]));
}

#[test]
fn aon_iceberg_plus_aon_refuses_unsupported_not_a_silent_stub() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &with_display(
            with_aon(
                order(AON_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
                true,
            ),
            Some("2"),
        ),
    );

    assert!(!result.accepted);
    assert_eq!(code(&result), Some("aon_iceberg"));
    assert!(result.fills.is_empty());
    assert!(live_ids_sorted(&book).is_empty());
}

#[test]
fn aon_journal_replay_of_a_resting_aon_keeps_the_flag() {
    let mut live = OrderBook::new(MARKET);
    let rest = with_aon(
        order(AON_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        true,
    );
    submit(&mut live, &rest);
    let engine = replay_memory(&[&rest], "2026-08-25T15:00:00.000Z");
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(
        first_order(restored, "bids").get("aon"),
        Some(&Json::Bool(true))
    );
}

#[test]
fn aon_read_aon_treats_missing_and_false_as_not_set_iceberg_combo_refuses() {
    assert!(!read_aon(&Opt::Absent));
    assert!(!read_aon(&Opt::Null));
    assert!(!read_aon(&Opt::Some(false)));
    assert!(read_aon(&Opt::Some(true)));
    assert_eq!(
        aon_iceberg_refuse(true, true).map(|r| r.code),
        Some("aon_iceberg".to_owned())
    );
    assert!(aon_iceberg_refuse(true, false).is_none());
    assert!(aon_iceberg_refuse(false, true).is_none());
    assert!(!clip_meets_aon(a("4"), a("10"), true));
    assert!(clip_meets_aon(a("10"), a("10"), true));
    assert!(clip_meets_aon(a("4"), a("10"), false));
    assert!(!can_fill_aon(a("8"), a("10"), true));
    assert!(can_fill_aon(a("10"), a("10"), true));
    assert!(can_fill_aon(a("2"), a("10"), false));
}

// ── auction.test.ts ─────────────────────────────────────────────────────

const AU_ASK: &str = "11111111-1111-4111-8111-111111111111";
const AU_TAKE: &str = "33333333-3333-4333-8333-333333333333";
const AU_MISS: &str = "44444444-4444-4444-8444-444444444444";
const AU_PLAIN: &str = "55555555-5555-4555-8555-555555555555";

fn with_auction(mut o: EngineOrder, auction: Opt<bool>, benchmark: Opt<bool>) -> EngineOrder {
    o.auction = auction;
    o.benchmark = benchmark;
    o
}

#[test]
fn auction_missing_flags_are_a_normal_order_a_smaller_clip_still_fills() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AU_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &order(AU_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(take.resting.as_ref().map(|r| r.remaining), Some(a("8")));
}

#[test]
fn auction_false_benchmark_false_is_a_normal_order_no_invented_price() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AU_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let take = submit(
        &mut book,
        &with_auction(
            order(AU_PLAIN, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            Opt::Some(false),
            Opt::Some(false),
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(format_amount(take.fills[0].qty), "2");
}

#[test]
fn auction_true_refuses_no_rest_no_invented_auction_price() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(AU_ASK, "mm", Side::Sell, "2", Some("100"), Tif::Gtc),
    );
    let result = submit(
        &mut book,
        &with_auction(
            order(AU_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
            Opt::Some(true),
            Opt::Absent,
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("auction_unsupported"));
    assert!(result.fills.is_empty());
    assert!(result.resting.is_none());
    assert_eq!(live_ids(&book), ids(&[AU_ASK]));
}

#[test]
fn auction_benchmark_true_refuses_no_rest_no_invented_benchmark_price() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &with_auction(
            order(AU_MISS, "desk", Side::Sell, "10", Some("100"), Tif::Gtc),
            Opt::Absent,
            Opt::Some(true),
        ),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("benchmark_unsupported"));
    assert!(result.fills.is_empty());
    assert!(live_ids(&book).is_empty());
}

#[test]
fn auction_journal_replay_of_a_refused_auction_does_not_invent_a_book() {
    let auctioned = with_auction(
        order(AU_MISS, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        Opt::Some(true),
        Opt::Absent,
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &auctioned).accepted);
    let engine = replay_memory(&[&auctioned], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn auction_journal_replay_of_a_refused_benchmark_does_not_invent_a_book() {
    let bench = with_auction(
        order(AU_TAKE, "desk", Side::Buy, "10", Some("100"), Tif::Gtc),
        Opt::Absent,
        Opt::Some(true),
    );
    assert!(!submit(&mut OrderBook::new(MARKET), &bench).accepted);
    let engine = replay_memory(&[&bench], "2026-08-25T16:00:00.000Z");
    assert!(engine.existing_book(MARKET).is_none());
}

/// `readAuction`, `readBenchmark`, `auctionRefuse` and `benchmarkRefuse` are checked through
/// `auction_intent_refuse` (see the header).
#[test]
fn auction_read_helpers_treat_missing_and_false_as_not_set_true_refuses() {
    let refuse = |auction: Opt<bool>, benchmark: Opt<bool>| {
        auction_intent_refuse(&with_auction(
            order(AU_TAKE, "desk", Side::Buy, "1", Some("100"), Tif::Gtc),
            auction,
            benchmark,
        ))
        .map(|r| r.code)
    };
    // readAuction / auctionRefuse: missing, null and false are not set; true refuses.
    assert_eq!(refuse(Opt::Absent, Opt::Absent), None);
    assert_eq!(refuse(Opt::Null, Opt::Absent), None);
    assert_eq!(refuse(Opt::Some(false), Opt::Absent), None);
    assert_eq!(
        refuse(Opt::Some(true), Opt::Absent),
        Some("auction_unsupported".to_owned())
    );
    // readBenchmark / benchmarkRefuse: missing and false are not set; true refuses.
    assert_eq!(refuse(Opt::Absent, Opt::Some(false)), None);
    assert_eq!(
        refuse(Opt::Absent, Opt::Some(true)),
        Some("benchmark_unsupported".to_owned())
    );
}
