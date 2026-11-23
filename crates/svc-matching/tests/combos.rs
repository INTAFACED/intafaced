//! The combo layer of the spreads slice, ported test for test from the TypeScript: `engine/combo-book.test.ts`
//! (module `combo_book`), `engine/option-combo.test.ts` (module `option_combo`) and `option-combo.router.test.ts`
//! (module `router`, driven through `MatchingDoor::decide` as `wire_replay.rs` builds a door). Each test is named after
//! its TypeScript `it`. The TypeScript `replay(records)` is the engine's cold start here (`MatchingEngine::recover`
//! over the same journal), which drops a book that never printed and holds nothing; `comboRestOf(book, id)` is
//! `OrderBook::combo_rest_of`. A TypeScript `typeof x === 'bigint'` check is held by the type: the value is bound to an
//! `Amount`.
//!
//! Every TypeScript test is ported. Assertions not ported as written, and why:
//! - `option-combo.test.ts` "read helpers treat missing and false as not set; combo true without legs refuses":
//!   `comboUnsupportedRefuse().code` is not ported: a helper no door or module calls (the TypeScript never refuses
//!   with `combo_unsupported`), and the Rust has no such refusal. `readRatio`, `readStrike`, `readExpiry`,
//!   `comboLegsRefuse`, `ratioRefuse` and `comboDisagreesRefuse` are private to the Rust combo layer; each is checked
//!   through the public call that reads it (`combo_identity`, `combo_intent_refuse`, or the book's refusal).
//! - The same helpers in "missing ratio on a combo rest refuses" (`readRatio({ ratio: -1 })`) and in "a leg name
//!   containing an identity separator…" (`comboLegsRefuse(pipe | semi)`) are checked the same way.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::order_book::{OrderBook, combo_identity, combo_intent_refuse, wants_combo};
use svc_matching::book::types::{
    CancelReason, ComboLeg, EngineOrder, Opt, OrderType, RestKind, Side, SubmitResult, Tif,
};
use svc_matching::book::wire::to_wire;
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const EXPIRY: &str = "2026-12-31T00:00:00.000Z";
const OTHER: &str = "2026-06-30T00:00:00.000Z";

const COMBO_LEGS_MISSING: &str = "missing_combo_legs";
const RATIO_MISSING: &str = "missing_ratio";
const STRIKE_MISSING: &str = "missing_strike";
const EXPIRY_MISSING: &str = "missing_expiry";
const COMBO_DISAGREES: &str = "combo_disagrees";

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn leg(name: &str, ratio: Option<&str>, strike: Option<&str>, expiry: Option<&str>) -> ComboLeg {
    ComboLeg {
        name: Some(name.to_owned()),
        ratio: ratio.map(a),
        strike: strike.map(a),
        expiry: expiry.map(str::to_owned),
    }
}

/// `namedLegs()`: a call and a put at 100, the same expiry, ratios 1 and -1.
fn named_legs() -> Vec<ComboLeg> {
    vec![
        leg("call", Some("1"), Some("100"), Some(EXPIRY)),
        leg("put", Some("-1"), Some("100"), Some(EXPIRY)),
    ]
}

/// `namedLegs([over])`: the first leg changed.
fn named_legs_first(f: impl FnOnce(&mut ComboLeg)) -> Vec<ComboLeg> {
    let mut legs = named_legs();
    f(&mut legs[0]);
    legs
}

/// The tests' `order(spec)`: a market order without a price, a limit with one, GTC; every other part absent.
fn order(id: &str, account: &str, side: Side, qty: &str, price: Option<&str>) -> EngineOrder {
    let kind = if price.is_some() {
        OrderType::Limit
    } else {
        OrderType::Market
    };
    EngineOrder::new(id, account, kind, side, a(qty), price.map(a), Tif::Gtc)
}

/// `order({ ..., combo: true, legs })`: `legs: None` leaves legs absent.
fn combo(
    id: &str,
    account: &str,
    side: Side,
    qty: &str,
    price: Option<&str>,
    legs: Option<Vec<ComboLeg>>,
) -> EngineOrder {
    let mut o = order(id, account, side, qty, price);
    o.combo = Opt::Some(true);
    o.legs = legs.map_or(Opt::Absent, Opt::Some);
    o
}

/// `order({ ..., strike, expiry })`: an option.
fn option(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    let mut o = order(id, account, side, qty, Some(price));
    o.strike = Opt::Some(a("100"));
    o.expiry = Opt::Some(EXPIRY.to_owned());
    o
}

/// An order carrying only combo intent, for the TypeScript helpers that read a bare `{ combo, legs }`.
fn intent(combo: Opt<bool>, legs: Opt<Vec<ComboLeg>>) -> EngineOrder {
    let mut o = order("intent", "desk", Side::Buy, "1", None);
    o.combo = combo;
    o.legs = legs;
    o
}

fn submit(book: &mut OrderBook, o: &EngineOrder) -> SubmitResult {
    book.submit(o, None)
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|r| r.code.as_str())
}

fn text(j: Option<&Json>) -> String {
    match j {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not text: {other:?}"),
    }
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

/// `liveIds(book)`: bids then asks.
fn live_ids(book: &OrderBook) -> Vec<String> {
    let state = book.to_state();
    let mut ids = ids_of(state.get("bids"));
    ids.extend(ids_of(state.get("asks")));
    ids
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn ladder(levels: &[(Amount, Amount)]) -> Vec<(String, String)> {
    levels
        .iter()
        .map(|(p, q)| (format_amount(*p), format_amount(*q)))
        .collect()
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(p, q)| ((*p).to_owned(), (*q).to_owned()))
        .collect()
}

/// `book.depth(50).bids`.
fn bids(book: &OrderBook) -> Vec<(String, String)> {
    ladder(&book.depth(50).0)
}

/// `book.depth(50).asks`.
fn asks(book: &OrderBook) -> Vec<(String, String)> {
    ladder(&book.depth(50).1)
}

fn stops_len(book: &OrderBook) -> usize {
    match book.to_state().get("stops") {
        Some(Json::Array(s)) => s.len(),
        other => panic!("stops are an array: {other:?}"),
    }
}

/// `comboRestOf(book, id)?.legs.map(leg => leg.name)`.
fn rest_names(book: &OrderBook, id: &str) -> Vec<String> {
    book.combo_rest_of(id)
        .unwrap()
        .legs
        .iter()
        .map(|l| l.name.clone())
        .collect()
}

/// `comboRestOf(book, id)?.legs.map(leg => formatAmount(leg.ratio))`.
fn rest_ratios(book: &OrderBook, id: &str) -> Vec<String> {
    book.combo_rest_of(id)
        .unwrap()
        .legs
        .iter()
        .map(|l| format_amount(l.ratio))
        .collect()
}

/// `toWire(order).legs[i].ratio`.
fn wire_leg(wire: &Json, i: usize, key: &str) -> Json {
    let Some(Json::Array(legs)) = wire.get("legs") else {
        panic!("legs are an array")
    };
    legs[i].get(key).cloned().unwrap()
}

fn wire_legs_len(wire: &Json) -> usize {
    match wire.get("legs") {
        Some(Json::Array(l)) => l.len(),
        other => panic!("legs are an array: {other:?}"),
    }
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
        spread_fills: false,
    });
    engine.recover().unwrap();
    engine
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

fn identity_code(r: &Result<String, svc_matching::book::types::Reject>) -> Option<&str> {
    r.as_ref().err().map(|e| e.code.as_str())
}

// ── combo-book.test.ts ──────────────────────────────────────────────────

mod combo_book {
    use super::*;

    const COMBO: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TAKE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const OPT_A: &str = "11111111-1111-4111-8111-111111111111";
    const OPT_B: &str = "22222222-2222-4222-8222-222222222222";
    const MISS: &str = "44444444-4444-4444-8444-444444444444";
    const STOP_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const FUEL: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const SPARK: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const WARM_SELL: &str = "abababab-abab-4aba-8aba-abababababab";
    const WARM_BUY: &str = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";

    // combo book — named legs rest as one instrument

    #[test]
    fn named_legs_ratios_combo_true_one_qty_price_accepted_exactly_one_live_order_id() {
        let mut book = OrderBook::new(MARKET);
        let result = submit(
            &mut book,
            &combo(
                COMBO,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        assert!(result.accepted);
        let resting = result.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(resting.order_id, COMBO);
        assert_eq!(live_ids(&book), ids(&[COMBO]));
        assert_eq!(bids(&book), pairs(&[("99", "2")]));
        assert_eq!(asks(&book), pairs(&[]));
        assert!(combo_intent_refuse(&intent(Opt::Some(true), Opt::Some(named_legs()))).is_none());
    }

    #[test]
    fn remembered_combo_has_both_leg_names_and_ratios_as_ledger_amounts() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                COMBO,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let remembered = book.combo_rest_of(COMBO).unwrap();
        assert_eq!(remembered.order_id, COMBO);
        assert_eq!(remembered.legs.len(), 2);
        assert_eq!(rest_names(&book, COMBO), ids(&["call", "put"]));
        assert_eq!(rest_ratios(&book, COMBO), ids(&["1", "-1"]));
        let first: Amount = remembered.legs[0].ratio;
        let second: Amount = remembered.legs[1].ratio;
        assert_eq!(first, a("1"));
        assert_eq!(second, a("-1"));
    }

    #[test]
    fn missing_legs_ratio_strike_expiry_still_refuse_a8_codes_live_ids_empty() {
        let mut book = OrderBook::new(MARKET);
        let missing_legs = submit(
            &mut book,
            &combo(MISS, "desk", Side::Buy, "2", Some("99"), None),
        );
        assert!(!missing_legs.accepted);
        assert_eq!(code(&missing_legs), Some(COMBO_LEGS_MISSING));
        assert_eq!(
            combo_intent_refuse(&intent(Opt::Some(true), Opt::Absent)).map(|r| r.code),
            Some(COMBO_LEGS_MISSING.to_owned())
        );

        let missing_ratio = submit(
            &mut book,
            &combo(
                MISS,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs_first(|l| l.ratio = None)),
            ),
        );
        assert!(!missing_ratio.accepted);
        assert_eq!(code(&missing_ratio), Some(RATIO_MISSING));

        let missing_strike = submit(
            &mut book,
            &combo(
                MISS,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs_first(|l| l.strike = None)),
            ),
        );
        assert!(!missing_strike.accepted);
        assert_eq!(code(&missing_strike), Some(STRIKE_MISSING));

        let missing_expiry = submit(
            &mut book,
            &combo(
                MISS,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs_first(|l| l.expiry = None)),
            ),
        );
        assert!(!missing_expiry.accepted);
        assert_eq!(code(&missing_expiry), Some(EXPIRY_MISSING));
        assert!(live_ids(&book).is_empty());
        assert_eq!(bids(&book), pairs(&[]));
        assert!(book.combo_rest_of(MISS).is_none());
    }

    #[test]
    fn two_separate_option_submits_no_combo_are_two_rests_not_labeled_combo() {
        let mut book = OrderBook::new(MARKET);
        let a_ = submit(&mut book, &option(OPT_A, "desk", Side::Buy, "2", "99"));
        let b_ = submit(&mut book, &option(OPT_B, "desk", Side::Buy, "3", "98"));
        assert!(a_.accepted);
        assert!(b_.accepted);
        let mut live = live_ids(&book);
        live.sort();
        let mut want = ids(&[OPT_A, OPT_B]);
        want.sort();
        assert_eq!(live, want);
        assert_eq!(bids(&book), pairs(&[("99", "2"), ("98", "3")]));
        assert!(book.combo_rest_of(OPT_A).is_none());
        assert!(book.combo_rest_of(OPT_B).is_none());
    }

    #[test]
    fn journal_replay_of_a_complete_combo_restores_one_rest_not_two_not_empty() {
        let mut journal = MemoryJournal::new();
        let comboed = combo(
            COMBO,
            "desk",
            Side::Buy,
            "2",
            Some("99"),
            Some(named_legs()),
        );
        let wire = to_wire(&comboed, None);
        assert_eq!(wire.get("combo"), Some(&Json::Bool(true)));
        assert_eq!(wire_legs_len(&wire), 2);
        assert_eq!(wire_leg(&wire, 0, "ratio"), Json::str("1"));
        assert_eq!(wire_leg(&wire, 1, "ratio"), Json::str("-1"));
        journal
            .append(&submit_record(&comboed, "2026-08-31T12:00:00.000Z"))
            .unwrap();
        let live = submit(&mut OrderBook::new(MARKET), &comboed);
        assert!(live.accepted);
        assert_eq!(live.resting.as_ref().unwrap().order_id, COMBO);
        let engine = replay(Box::new(journal));
        let restored = engine.existing_book(MARKET).unwrap();
        assert_eq!(live_ids(restored), ids(&[COMBO]));
        assert_eq!(bids(restored), pairs(&[("99", "2")]));
        assert_eq!(asks(restored), pairs(&[]));
        assert_eq!(rest_names(restored, COMBO), ids(&["call", "put"]));
        assert_eq!(rest_ratios(restored, COMBO), ids(&["1", "-1"]));
    }

    // combo book — match/unwind as one instrument

    #[test]
    fn two_combos_with_the_same_named_legs_ratios_match_as_one_fill_not_two_option_legs() {
        let mut book = OrderBook::new(MARKET);
        let rest = submit(
            &mut book,
            &combo(
                COMBO,
                "maker",
                Side::Sell,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        assert!(rest.accepted);
        assert!(rest.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[COMBO]));

        let take = submit(
            &mut book,
            &combo(
                TAKE,
                "taker",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        assert!(take.accepted);
        assert_eq!(take.fills.len(), 1);
        assert_eq!(take.fills[0].maker_order_id, COMBO);
        assert_eq!(take.fills[0].taker_order_id, TAKE);
        assert_eq!(take.fills[0].taker_side, Side::Buy);
        assert_eq!(format_amount(take.fills[0].qty), "2");
        assert_eq!(format_amount(take.fills[0].price), "99");
        let _: Amount = take.fills[0].qty;
        let _: Amount = take.fills[0].price;
        assert!(take.resting.is_none());
        assert!(live_ids(&book).is_empty());
        assert_eq!(bids(&book), pairs(&[]));
        assert_eq!(asks(&book), pairs(&[]));
        assert!(book.combo_rest_of(COMBO).is_none());
        assert!(book.combo_rest_of(TAKE).is_none());
        let mut reversed = named_legs();
        reversed.reverse();
        assert_eq!(combo_identity(&named_legs()), combo_identity(&reversed));
    }

    #[test]
    fn partial_combo_take_unwinds_one_remaining_combo_rest() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                COMBO,
                "maker",
                Side::Sell,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let take = submit(
            &mut book,
            &combo(
                TAKE,
                "taker",
                Side::Buy,
                "1",
                Some("99"),
                Some(named_legs()),
            ),
        );
        assert!(take.accepted);
        assert_eq!(take.fills.len(), 1);
        assert_eq!(format_amount(take.fills[0].qty), "1");
        assert!(take.resting.is_none());
        assert_eq!(live_ids(&book), ids(&[COMBO]));
        assert_eq!(asks(&book), pairs(&[("99", "1")]));
        assert_eq!(rest_ratios(&book, COMBO), ids(&["1", "-1"]));
    }

    #[test]
    fn refuses_a_combo_take_against_a_different_named_leg_identity() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                COMBO,
                "maker",
                Side::Sell,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let take = submit(
            &mut book,
            &combo(
                TAKE,
                "taker",
                Side::Buy,
                "2",
                Some("99"),
                Some(named_legs_first(|l| l.strike = Some(a("105")))),
            ),
        );
        assert!(!take.accepted);
        assert_eq!(code(&take), Some(COMBO_DISAGREES));
        assert!(take.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[COMBO]));
        assert_eq!(asks(&book), pairs(&[("99", "2")]));
    }

    #[test]
    fn refuses_a_combo_take_against_a_plain_rest_not_two_independent_option_legs() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &order(OPT_A, "desk", Side::Sell, "2", Some("99")),
        );
        let take = submit(
            &mut book,
            &combo(TAKE, "desk", Side::Buy, "2", Some("99"), Some(named_legs())),
        );
        assert!(!take.accepted);
        assert_eq!(code(&take), Some(COMBO_DISAGREES));
        assert!(take.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[OPT_A]));
    }

    #[test]
    fn refuses_a_plain_take_against_a_resting_combo_does_not_unwind_legs_independently() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                COMBO,
                "desk",
                Side::Sell,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let take = submit(&mut book, &order(OPT_A, "desk", Side::Buy, "2", Some("99")));
        assert!(!take.accepted);
        assert_eq!(code(&take), Some(COMBO_DISAGREES));
        assert!(take.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[COMBO]));
        assert_eq!(book.combo_rest_of(COMBO).unwrap().order_id, COMBO);
    }

    #[test]
    fn refuses_a_combo_take_against_a_resting_option_not_a_combo_instrument() {
        let mut book = OrderBook::new(MARKET);
        submit(&mut book, &option(OPT_A, "desk", Side::Sell, "2", "99"));
        let take = submit(
            &mut book,
            &combo(TAKE, "desk", Side::Buy, "2", Some("99"), Some(named_legs())),
        );
        assert!(!take.accepted);
        assert_eq!(code(&take), Some(COMBO_DISAGREES));
        assert!(take.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[OPT_A]));
    }

    #[test]
    fn incomplete_combo_still_refuses_and_does_not_take_a_resting_combo() {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                COMBO,
                "desk",
                Side::Sell,
                "2",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let mut legs = named_legs();
        legs[0].expiry = Some(OTHER.to_owned());
        legs[1].expiry = None;
        let take = submit(
            &mut book,
            &combo(MISS, "desk", Side::Buy, "2", Some("99"), Some(legs)),
        );
        assert!(!take.accepted);
        assert_eq!(code(&take), Some(EXPIRY_MISSING));
        assert!(take.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[COMBO]));
    }

    #[test]
    fn journal_replay_of_two_matching_combos_restores_an_empty_book_not_two_legs() {
        let mut journal = MemoryJournal::new();
        let maker = combo(
            COMBO,
            "maker",
            Side::Sell,
            "2",
            Some("99"),
            Some(named_legs()),
        );
        let taker = combo(
            TAKE,
            "taker",
            Side::Buy,
            "2",
            Some("99"),
            Some(named_legs()),
        );
        journal
            .append(&submit_record(&maker, "2026-08-31T12:00:00.000Z"))
            .unwrap();
        journal
            .append(&submit_record(&taker, "2026-08-31T12:00:01.000Z"))
            .unwrap();
        let mut live = OrderBook::new(MARKET);
        assert!(submit(&mut live, &maker).accepted);
        let printed = submit(&mut live, &taker);
        assert!(printed.accepted);
        assert_eq!(printed.fills.len(), 1);
        assert_eq!(format_amount(printed.fills[0].qty), "2");
        let engine = replay(Box::new(journal));
        // The book printed, so the cold start keeps it (`restored` is defined).
        let restored = engine.existing_book(MARKET).unwrap();
        assert!(live_ids(restored).is_empty());
        assert_eq!(bids(restored), pairs(&[]));
        assert_eq!(asks(restored), pairs(&[]));
        assert!(restored.combo_rest_of(COMBO).is_none());
    }

    // combo book — a triggered stop does not print a different identity

    fn book_at_100() -> OrderBook {
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &order(WARM_SELL, "warm", Side::Sell, "1", Some("100")),
        );
        let bought = submit(&mut book, &order(WARM_BUY, "spark", Side::Buy, "1", None));
        assert_eq!(bought.fills.len(), 1);
        assert_eq!(format_amount(bought.fills[0].price), "100");
        assert!(live_ids(&book).is_empty());
        book
    }

    fn park_stop(book: &mut OrderBook, kind: OrderType, price: Option<&str>) {
        let mut stop = combo(
            STOP_ID,
            "stopdesk",
            Side::Buy,
            "2",
            price,
            Some(named_legs()),
        );
        stop.order_type = kind;
        stop.stop_price = Some(a("105"));
        let parked = submit(book, &stop);
        assert!(parked.accepted);
        assert!(parked.fills.is_empty());
        let resting = parked.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Stop);
        assert_eq!(resting.order_id, STOP_ID);
        assert!(live_ids(book).is_empty());
        assert_eq!(
            Ok(book.combo_rest_of(STOP_ID).unwrap().identity.clone()),
            combo_identity(&named_legs())
        );
    }

    fn arm(book: &mut OrderBook) -> SubmitResult {
        submit(book, &order(FUEL, "fuel", Side::Sell, "1", Some("105")));
        submit(book, &order(SPARK, "spark2", Side::Buy, "1", Some("105")))
    }

    #[test]
    fn a_combo_stop_limit_that_later_activates_does_not_print_against_a_plain_order() {
        let mut book = book_at_100();
        park_stop(&mut book, OrderType::StopLimit, Some("120"));
        submit(
            &mut book,
            &order(OPT_A, "maker", Side::Sell, "2", Some("110")),
        );

        let trigger = arm(&mut book);

        assert!(trigger.accepted);
        assert_eq!(trigger.fills.len(), 1);
        assert_eq!(format_amount(trigger.fills[0].price), "105");
        assert_eq!(format_amount(trigger.fills[0].qty), "1");
        assert_eq!(trigger.triggered.len(), 1);
        let t = &trigger.triggered[0];
        assert_eq!(t.order_id, STOP_ID);
        assert!(t.fills.is_empty());
        assert_eq!(
            t.rejected.as_ref().map(|r| r.code.as_str()),
            Some(COMBO_DISAGREES)
        );
        assert!(t.resting.is_none());
        assert_eq!(t.cancellations[0].reason, CancelReason::TriggerRejected);
        assert_eq!(t.cancellations[0].sequence, t.sequence);
        let _: Amount = t.cancellations[0].remaining_qty;
        assert_eq!(live_ids(&book), ids(&[OPT_A]));
        assert_eq!(asks(&book), pairs(&[("110", "2")]));
        assert_eq!(bids(&book), pairs(&[]));
        assert_eq!(stops_len(&book), 0);
        assert!(book.combo_rest_of(STOP_ID).is_none());
        assert!(book.combo_rest_of(OPT_A).is_none());
    }

    #[test]
    fn a_combo_stop_that_later_activates_does_not_print_against_a_different_leg_identity() {
        let mut book = book_at_100();
        park_stop(&mut book, OrderType::Stop, None);
        submit(
            &mut book,
            &combo(
                COMBO,
                "maker",
                Side::Sell,
                "2",
                Some("110"),
                Some(named_legs_first(|l| l.strike = Some(a("105")))),
            ),
        );

        let trigger = arm(&mut book);

        assert!(trigger.accepted);
        assert_eq!(trigger.fills.len(), 1);
        assert_eq!(format_amount(trigger.fills[0].price), "105");
        assert_eq!(trigger.triggered.len(), 1);
        let t = &trigger.triggered[0];
        assert!(t.fills.is_empty());
        assert_eq!(
            t.rejected.as_ref().map(|r| r.code.as_str()),
            Some(COMBO_DISAGREES)
        );
        assert!(t.resting.is_none());
        assert_eq!(live_ids(&book), ids(&[COMBO]));
        assert_eq!(asks(&book), pairs(&[("110", "2")]));
        assert_eq!(bids(&book), pairs(&[]));
        assert_eq!(
            format_amount(book.combo_rest_of(COMBO).unwrap().legs[0].ratio),
            "1"
        );
    }

    #[test]
    fn a_same_identity_combo_stop_limit_still_prints_at_the_resting_combo_price() {
        let mut book = book_at_100();
        park_stop(&mut book, OrderType::StopLimit, Some("120"));
        submit(
            &mut book,
            &combo(
                COMBO,
                "maker",
                Side::Sell,
                "2",
                Some("110"),
                Some(named_legs()),
            ),
        );

        let trigger = arm(&mut book);
        let printed = &trigger.triggered[0];

        assert!(trigger.accepted);
        assert_eq!(trigger.fills.len(), 1);
        assert_eq!(format_amount(trigger.fills[0].price), "105");
        assert_eq!(printed.fills.len(), 1);
        assert_eq!(printed.fills[0].maker_order_id, COMBO);
        assert_eq!(printed.fills[0].taker_order_id, STOP_ID);
        assert_eq!(printed.fills[0].taker_side, Side::Buy);
        assert_eq!(format_amount(printed.fills[0].qty), "2");
        assert_eq!(format_amount(printed.fills[0].price), "110");
        let _: Amount = printed.fills[0].qty;
        let _: Amount = printed.fills[0].price;
        assert!(printed.rejected.is_none());
        assert!(printed.resting.is_none());
        assert!(live_ids(&book).is_empty());
        assert_eq!(asks(&book), pairs(&[]));
        assert_eq!(bids(&book), pairs(&[]));
        assert!(book.combo_rest_of(COMBO).is_none());
        assert!(book.combo_rest_of(STOP_ID).is_none());
    }
}

// ── option-combo.test.ts ────────────────────────────────────────────────

mod option_combo {
    use super::*;

    const ASK: &str = "11111111-1111-4111-8111-111111111111";
    const MISS: &str = "44444444-4444-4444-8444-444444444444";
    const PLAIN: &str = "55555555-5555-4555-8555-555555555555";
    const OPT: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn missing_flags_are_a_normal_option_rest() {
        let mut book = OrderBook::new(MARKET);
        let result = submit(&mut book, &option(OPT, "desk", Side::Buy, "2", "99"));
        assert!(result.accepted);
        let resting = result.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(resting.order_id, OPT);
        assert_eq!(bids(&book), pairs(&[("99", "2")]));
        assert!(!wants_combo(&intent(Opt::Absent, Opt::Absent)));
        assert!(combo_intent_refuse(&intent(Opt::Absent, Opt::Absent)).is_none());
    }

    #[test]
    fn combo_false_is_a_normal_order_no_invented_combo_book() {
        let mut book = OrderBook::new(MARKET);
        submit(&mut book, &order(ASK, "mm", Side::Sell, "2", Some("100")));
        let mut plain = order(PLAIN, "desk", Side::Buy, "10", Some("100"));
        plain.combo = Opt::Some(false);
        let take = submit(&mut book, &plain);
        assert!(take.accepted);
        assert_eq!(take.fills.len(), 1);
        assert_eq!(format_amount(take.fills[0].qty), "2");
    }

    #[test]
    fn combo_true_without_named_legs_refuses_does_not_rest_as_an_option() {
        let mut book = OrderBook::new(MARKET);
        let mut o = option(MISS, "desk", Side::Buy, "2", "99");
        o.combo = Opt::Some(true);
        let result = submit(&mut book, &o);
        assert!(!result.accepted);
        assert_eq!(code(&result), Some(COMBO_LEGS_MISSING));
        assert!(result.fills.is_empty());
        assert!(result.resting.is_none());
        assert!(live_ids(&book).is_empty());
        assert_eq!(bids(&book), pairs(&[]));
    }

    #[test]
    fn combo_with_unnamed_or_one_leg_refuses() {
        let mut book = OrderBook::new(MARKET);
        let unnamed = submit(
            &mut book,
            &combo(
                MISS,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(vec![
                    leg("", Some("1"), Some("100"), Some(EXPIRY)),
                    leg("put", Some("-1"), Some("100"), Some(EXPIRY)),
                ]),
            ),
        );
        assert!(!unnamed.accepted);
        assert_eq!(code(&unnamed), Some(COMBO_LEGS_MISSING));

        let one = submit(
            &mut book,
            &combo(
                PLAIN,
                "desk",
                Side::Buy,
                "2",
                Some("99"),
                Some(vec![leg("call", Some("1"), Some("100"), Some(EXPIRY))]),
            ),
        );
        assert!(!one.accepted);
        assert_eq!(code(&one), Some(COMBO_LEGS_MISSING));
        assert!(live_ids(&book).is_empty());
    }

    #[test]
    fn missing_ratio_on_a_combo_rest_refuses_qty_is_a_ledger_amount_never_a_number() {
        let mut book = OrderBook::new(MARKET);
        for ratio in [None, Some(a("0"))] {
            let result = submit(
                &mut book,
                &combo(
                    MISS,
                    "desk",
                    Side::Buy,
                    "2",
                    Some("99"),
                    Some(named_legs_first(|l| l.ratio = ratio)),
                ),
            );
            assert!(!result.accepted);
            assert_eq!(code(&result), Some(RATIO_MISSING));
            assert!(result.resting.is_none());
        }
        let _qty: Amount = a("2");
        // `readRatio({ ratio: A('-1') })` is `A('-1')`: the identity it builds holds the short leg's ratio as -1.
        assert!(
            combo_identity(&named_legs())
                .unwrap()
                .contains(&format!("put|{}|", format_amount(a("-1"))))
        );
        assert!(live_ids(&book).is_empty());
    }

    #[test]
    fn missing_strike_on_a_combo_rest_refuses_no_invented_strike() {
        let mut book = OrderBook::new(MARKET);
        for strike in [None, Some(a("0"))] {
            let result = submit(
                &mut book,
                &combo(
                    MISS,
                    "desk",
                    Side::Buy,
                    "2",
                    Some("99"),
                    Some(named_legs_first(|l| l.strike = strike)),
                ),
            );
            assert!(!result.accepted);
            assert_eq!(code(&result), Some(STRIKE_MISSING));
            assert!(result.resting.is_none());
        }
        assert_eq!(bids(&book), pairs(&[]));
    }

    #[test]
    fn missing_expiry_on_a_combo_rest_refuses_no_invented_expiry() {
        let mut book = OrderBook::new(MARKET);
        for expiry in [None, Some(""), Some("   ")] {
            let result = submit(
                &mut book,
                &combo(
                    MISS,
                    "desk",
                    Side::Buy,
                    "2",
                    Some("99"),
                    Some(named_legs_first(|l| l.expiry = expiry.map(str::to_owned))),
                ),
            );
            assert!(!result.accepted);
            assert_eq!(code(&result), Some(EXPIRY_MISSING));
            assert!(result.resting.is_none());
        }
        assert_eq!(asks(&book), pairs(&[]));
    }

    #[test]
    fn named_legs_with_ratios_rest_as_one_instrument_not_two_independent_options() {
        let mut book = OrderBook::new(MARKET);
        let result = submit(
            &mut book,
            &combo(MISS, "desk", Side::Buy, "2", Some("99"), Some(named_legs())),
        );
        assert!(result.accepted);
        let resting = result.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(resting.order_id, MISS);
        assert!(result.fills.is_empty());
        assert_eq!(live_ids(&book), ids(&[MISS]));
        assert_eq!(bids(&book), pairs(&[("99", "2")]));
        assert_eq!(asks(&book), pairs(&[]));
        assert_eq!(rest_names(&book, MISS), ids(&["call", "put"]));
        assert_eq!(rest_ratios(&book, MISS), ids(&["1", "-1"]));
        let _: Amount = book.combo_rest_of(MISS).unwrap().legs[0].ratio;
    }

    #[test]
    fn legs_without_combo_flag_rest_as_one_instrument_when_named_legs_are_complete() {
        let mut book = OrderBook::new(MARKET);
        let mut o = order(MISS, "desk", Side::Buy, "2", Some("99"));
        o.legs = Opt::Some(named_legs());
        let result = submit(&mut book, &o);
        assert!(result.accepted);
        let resting = result.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(resting.order_id, MISS);
        assert_eq!(live_ids(&book), ids(&[MISS]));
        assert_eq!(book.combo_rest_of(MISS).unwrap().legs.len(), 2);
    }

    #[test]
    fn journal_replay_of_a_combo_without_named_legs_does_not_invent_a_book() {
        let mut journal = MemoryJournal::new();
        let mut comboed = option(MISS, "desk", Side::Buy, "2", "99");
        comboed.combo = Opt::Some(true);
        assert_eq!(
            to_wire(&comboed, None).get("combo"),
            Some(&Json::Bool(true))
        );
        journal
            .append(&submit_record(&comboed, "2026-08-31T12:00:00.000Z"))
            .unwrap();
        assert!(!submit(&mut OrderBook::new(MARKET), &comboed).accepted);
        let engine = replay(Box::new(journal));
        assert!(engine.existing_book(MARKET).is_none());
    }

    #[test]
    fn journal_replay_of_a_complete_combo_restores_one_rest_not_two_not_empty() {
        let mut journal = MemoryJournal::new();
        let comboed = combo(MISS, "desk", Side::Buy, "2", Some("99"), Some(named_legs()));
        let wire = to_wire(&comboed, None);
        assert_eq!(wire_legs_len(&wire), 2);
        assert_eq!(wire_leg(&wire, 0, "ratio"), Json::str("1"));
        assert_eq!(wire_leg(&wire, 1, "ratio"), Json::str("-1"));
        journal
            .append(&submit_record(&comboed, "2026-08-31T12:00:00.000Z"))
            .unwrap();
        assert!(submit(&mut OrderBook::new(MARKET), &comboed).accepted);
        let engine = replay(Box::new(journal));
        let restored = engine.existing_book(MARKET).unwrap();
        assert_eq!(live_ids(restored), ids(&[MISS]));
        assert_eq!(bids(restored), pairs(&[("99", "2")]));
        assert_eq!(rest_ratios(restored, MISS), ids(&["1", "-1"]));
    }

    #[test]
    fn file_journal_encode_keeps_missing_legs_so_a_crash_still_refuses() {
        let dir = temp_dir("matching-option-combo-");
        let path = dir.join("engine.ndjson");
        let comboed = combo(
            MISS,
            "desk",
            Side::Buy,
            "2",
            Some("99"),
            Some(named_legs_first(|l| l.strike = None)),
        );
        let live = submit(&mut OrderBook::new(MARKET), &comboed);
        assert!(!live.accepted);
        assert_eq!(code(&live), Some(STRIKE_MISSING));

        let mut j1 = FileJournal::open(&path).unwrap();
        j1.append(&submit_record(&comboed, "2026-08-31T12:00:00.000Z"))
            .unwrap();
        j1.close().unwrap();
        drop(j1);

        let on_disk = json::parse(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        let wire = on_disk.get("order").unwrap();
        assert_eq!(wire.get("combo"), Some(&Json::Bool(true)));
        assert_eq!(wire_leg(wire, 0, "strike"), Json::Null);
        assert_eq!(wire_leg(wire, 0, "ratio"), Json::str("1"));

        let j2 = FileJournal::open(&path).unwrap();
        let engine = replay(Box::new(j2));
        assert!(engine.existing_book(MARKET).is_none());
        drop(engine);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_helpers_treat_missing_and_false_as_not_set_combo_true_without_legs_refuses() {
        assert!(!wants_combo(&intent(Opt::Absent, Opt::Absent)));
        assert!(!wants_combo(&intent(Opt::Null, Opt::Absent)));
        assert!(!wants_combo(&intent(Opt::Some(false), Opt::Absent)));
        assert!(wants_combo(&intent(Opt::Some(true), Opt::Absent)));
        assert!(wants_combo(&intent(Opt::Absent, Opt::Some(Vec::new()))));
        // `readRatio({})`, `readRatio({ ratio: 0 })`, `readStrike({ strike: 0 })`, `readExpiry({ expiry: '  ' })` are
        // null, and `ratioRefuse(null)` is `missing_ratio`: through `combo_identity`, which reads each leg with them.
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(|l| l.ratio = None))),
            Some(RATIO_MISSING)
        );
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.ratio = Some(a("0"))
            ))),
            Some(RATIO_MISSING)
        );
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.strike = Some(a("0"))
            ))),
            Some(STRIKE_MISSING)
        );
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.expiry = Some("  ".to_owned())
            ))),
            Some(EXPIRY_MISSING)
        );
        // `comboLegsRefuse(undefined)`: a combo naming no legs.
        assert_eq!(
            combo_intent_refuse(&intent(Opt::Some(true), Opt::Absent)).map(|r| r.code),
            Some(COMBO_LEGS_MISSING.to_owned())
        );
        // `comboDisagreesRefuse().code`: the refusal the book answers a plain take of a resting combo with.
        let mut book = OrderBook::new(MARKET);
        submit(
            &mut book,
            &combo(
                "rest",
                "desk",
                Side::Sell,
                "1",
                Some("99"),
                Some(named_legs()),
            ),
        );
        let plain = submit(
            &mut book,
            &order("take", "desk", Side::Buy, "1", Some("99")),
        );
        assert_eq!(code(&plain), Some(COMBO_DISAGREES));
        assert_eq!(
            combo_intent_refuse(&intent(Opt::Some(true), Opt::Absent)).map(|r| r.code),
            Some(COMBO_LEGS_MISSING.to_owned())
        );
        assert!(combo_intent_refuse(&intent(Opt::Some(true), Opt::Some(named_legs()))).is_none());
        assert!(
            combo_identity(&named_legs())
                .unwrap()
                .contains("call|1|100|")
        );
        let mut reversed = named_legs();
        reversed.reverse();
        assert_eq!(combo_identity(&named_legs()), combo_identity(&reversed));
    }

    #[test]
    fn a_leg_name_containing_an_identity_separator_is_refused_and_does_not_alias_another_leg_set() {
        let pipe = vec![
            leg("call|1", Some("100"), Some("50"), Some(EXPIRY)),
            leg("put", Some("-1"), Some("90"), Some(EXPIRY)),
        ];
        let shifted_expiry = format!("50|{EXPIRY}");
        let shifted = vec![
            leg("call", Some("1"), Some("100"), Some(&shifted_expiry)),
            leg("put", Some("-1"), Some("90"), Some(EXPIRY)),
        ];
        let semi = vec![
            leg("call;put", Some("1"), Some("100"), Some(EXPIRY)),
            leg("hedge", Some("-1"), Some("100"), Some(EXPIRY)),
        ];
        let collided = format!("call|1|100|50|{EXPIRY};put|-1|90|{EXPIRY}");
        let alias_of_named = vec![leg(
            &format!("call|1|100|{EXPIRY};put"),
            Some("-1"),
            Some("100"),
            Some(EXPIRY),
        )];

        // `comboLegsRefuse(pipe | semi)` and `comboIntentRefuse({ combo: true, legs: pipe | semi })`: the intent check
        // runs the legs check first, so both read the same refusal.
        for legs in [&pipe, &semi] {
            assert_eq!(
                combo_intent_refuse(&intent(Opt::Some(true), Opt::Some(legs.clone())))
                    .map(|r| r.code),
                Some(COMBO_LEGS_MISSING.to_owned())
            );
        }

        let pipe_id = combo_identity(&pipe);
        let shifted_id = combo_identity(&shifted);
        let semi_id = combo_identity(&semi);
        let alias_id = combo_identity(&alias_of_named);
        let stable = combo_identity(&named_legs());

        assert_eq!(identity_code(&pipe_id), Some(COMBO_LEGS_MISSING));
        assert_eq!(identity_code(&shifted_id), Some(COMBO_LEGS_MISSING));
        assert_eq!(identity_code(&semi_id), Some(COMBO_LEGS_MISSING));
        assert_eq!(identity_code(&alias_id), Some(COMBO_LEGS_MISSING));
        assert!(pipe_id.is_err());
        assert!(shifted_id.is_err());
        assert!(semi_id.is_err());
        assert!(alias_id.is_err());
        assert!(!(pipe_id.is_ok() && pipe_id == shifted_id));
        assert_ne!(pipe_id, Ok(collided.clone()));
        assert_ne!(shifted_id, Ok(collided.clone()));
        assert_ne!(alias_id, stable);
        assert_ne!(stable, Ok(collided));

        let mut book = OrderBook::new(MARKET);
        let rested = submit(
            &mut book,
            &combo(MISS, "desk", Side::Buy, "2", Some("99"), Some(pipe)),
        );
        assert!(!rested.accepted);
        assert_eq!(code(&rested), Some(COMBO_LEGS_MISSING));
        assert!(rested.resting.is_none());
        assert!(live_ids(&book).is_empty());
    }

    #[test]
    fn combo_identity_refuses_a_missing_ratio_strike_or_expiry() {
        let missing_ratio = combo_identity(&named_legs_first(|l| l.ratio = None));
        let missing_strike = combo_identity(&named_legs_first(|l| l.strike = None));
        let missing_expiry = combo_identity(&named_legs_first(|l| l.expiry = None));
        assert_eq!(identity_code(&missing_ratio), Some(RATIO_MISSING));
        assert_eq!(identity_code(&missing_strike), Some(STRIKE_MISSING));
        assert_eq!(identity_code(&missing_expiry), Some(EXPIRY_MISSING));
        assert!(missing_ratio.is_err());
        assert!(missing_strike.is_err());
        assert!(missing_expiry.is_err());
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.ratio = Some(a("0"))
            ))),
            Some(RATIO_MISSING)
        );
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.strike = Some(a("0"))
            ))),
            Some(STRIKE_MISSING)
        );
        assert_eq!(
            identity_code(&combo_identity(&named_legs_first(
                |l| l.expiry = Some("   ".to_owned())
            ))),
            Some(EXPIRY_MISSING)
        );
    }

    #[test]
    fn an_ordinary_named_pair_keeps_one_stable_combo_id() {
        let id = combo_identity(&named_legs());
        assert!(id.is_ok());
        assert!(id.as_ref().unwrap().contains("call|1|100|"));
        let mut reversed = named_legs();
        reversed.reverse();
        assert_eq!(id, combo_identity(&reversed));
        assert!(combo_intent_refuse(&intent(Opt::Some(true), Opt::Some(named_legs()))).is_none());
    }
}

// ── option-combo.router.test.ts ─────────────────────────────────────────

mod router {
    use sha2::{Digest, Sha256};

    use service_kit::json::{self, Json};
    use service_kit::s2s;
    use service_kit::s2s_verify::BodyBind;
    use service_kit::server::Request;
    use svc_matching::approval::Unwired;
    use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
    use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
    use svc_matching::journal::io::MemoryJournal;
    use svc_matching::journal::replay::MemorySnapshotSink;

    use super::{EXPIRY, ladder, pairs};

    const SECRET: &str = "matching-option-combo-router-secretxx";
    const MARKET: &str = "BTC-USDT";
    const OBSERVED_AT: &str = "2026-08-31T12:00:00.000Z";
    /// The proof's clock, 2026-08-31T12:00:00.000Z.
    const NOW_SECONDS: i64 = 1_788_177_600;
    const REST_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TAKE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn now_ms() -> i64 {
        NOW_SECONDS * 1000
    }

    /// `createMarketLifecycleAdmissionProof(snapshot, 'PLACE')`: the snapshot, its id the hash of the snapshot as
    /// parsed (its keys in the schema's order).
    fn proof_for() -> Json {
        let strs = |v: &[&str]| Json::Array(v.iter().map(|s| Json::str(*s)).collect());
        let snapshot = Json::obj([
            ("marketId", Json::str(MARKET)),
            ("ruleVersion", Json::str("test.rules.v1")),
            ("instrumentId", Json::str(MARKET)),
            ("instrumentVersion", Json::str("test.instrument.v1")),
            ("state", Json::str("OPEN")),
            ("reasonCategory", Json::str("NORMAL")),
            ("reasonCode", Json::str("trade.lifecycle.ready")),
            ("effectiveAt", Json::str(OBSERVED_AT)),
            ("observedAt", Json::str(OBSERVED_AT)),
            ("lastGoodState", Json::str("OPEN")),
            ("allowedActions", strs(&["PLACE", "PLACE_POST_ONLY"])),
            ("transitionId", Json::str("test.transition")),
            ("evidenceRefs", strs(&["test.evidence"])),
        ]);
        let digest = Sha256::digest(snapshot.compact().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        Json::obj([
            ("action", Json::str("PLACE")),
            ("decision", Json::str("ELIGIBLE")),
            ("checkedAt", Json::str(OBSERVED_AT)),
            (
                "snapshotId",
                Json::str(format!("trade.lifecycle.snapshot:{hex}")),
            ),
            ("transitionId", Json::str("test.transition")),
            ("evidenceRefs", strs(&["test.evidence"])),
            ("snapshot", snapshot),
        ])
    }

    /// `legs([over])`: the call and put as decimal strings, the first leg's `key` set to `value`.
    fn legs(over: Option<(&str, Json)>) -> Json {
        let mut call = vec![
            ("name", Json::str("call")),
            ("ratio", Json::str("1")),
            ("strike", Json::str("100")),
            ("expiry", Json::str(EXPIRY)),
        ];
        if let Some((key, value)) = over {
            for (k, v) in &mut call {
                if *k == key {
                    *v = value.clone();
                }
            }
        }
        Json::Array(vec![
            Json::Object(call.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
            Json::obj([
                ("name", Json::str("put")),
                ("ratio", Json::str("-1")),
                ("strike", Json::str("100")),
                ("expiry", Json::str(EXPIRY)),
            ]),
        ])
    }

    /// `submitBody(over)`: a combo limit buy of 2 at 99; `over` replaces or adds fields, and `None` drops one (a JSON
    /// body never carries `undefined`).
    fn submit_body(over: &[(&str, Option<Json>)]) -> String {
        let mut fields: Vec<(String, Json)> = vec![
            ("orderId".into(), Json::str(REST_ID)),
            ("accountId".into(), Json::str("desk")),
            ("type".into(), Json::str("limit")),
            ("side".into(), Json::str("buy")),
            ("qty".into(), Json::str("2")),
            ("price".into(), Json::str("99")),
            ("tif".into(), Json::str("GTC")),
            ("strike".into(), Json::str("100")),
            ("expiry".into(), Json::str(EXPIRY)),
            ("combo".into(), Json::Bool(true)),
            ("lifecycleProof".into(), proof_for()),
        ];
        for (key, value) in over {
            fields.retain(|(k, _)| k != key);
            if let Some(v) = value {
                fields.push(((*key).to_owned(), v.clone()));
            }
        }
        Json::Object(fields).compact()
    }

    /// `mount()`: an engine over an in-memory journal and bus, no snapshots, behind the door with bound bodies.
    fn mount() -> MatchingDoor {
        let mut engine = MatchingEngine::new(EngineParts {
            journal: Box::new(MemoryJournal::new()),
            bus: Box::new(MemoryEventBus::default()),
            clock: now_ms,
            expiry_clock: true,
            snapshot_every: 0,
            sink: Box::new(MemorySnapshotSink::default()),
            enabled: true,
            spread_fills: false,
        });
        engine.recover().unwrap();
        MatchingDoor::new(
            DoorConfig {
                internal_secret: SECRET.to_owned(),
                body_bind: BodyBind::Require,
                keys: None,
                edge_secret: None,
                edge_key: None,
                clock: now_ms,
                approvals: Box::new(Unwired),
                operator_ids: Vec::new(),
            },
            engine,
        )
        .unwrap()
    }

    /// `post(app, body)`: signed by svc-trade, bound to the body. The status and the parsed reply.
    fn post(door: &MatchingDoor, payload: &str) -> (u16, Json) {
        let mut headers = s2s::legacy_headers("svc-trade", SECRET, payload, NOW_SECONDS).unwrap();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let url = format!("/markets/{MARKET}/orders");
        match door.decide(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: payload,
        }) {
            Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
            Outcome::Owed(slice) => panic!("owed by {}", slice.name()),
        }
    }

    fn bids(door: &MatchingDoor) -> Vec<(String, String)> {
        door.engine()
            .depth(MARKET, 50)
            .map_or_else(Vec::new, |d| ladder(&d.bids))
    }

    fn asks(door: &MatchingDoor) -> Vec<(String, String)> {
        door.engine()
            .depth(MARKET, 50)
            .map_or_else(Vec::new, |d| ladder(&d.asks))
    }

    fn rejected_code(body: &Json) -> Option<&Json> {
        body.get("rejected").and_then(|r| r.get("code"))
    }

    fn refuses(over: &[(&str, Option<Json>)], want: &str) {
        let door = mount();
        let (status, body) = post(&door, &submit_body(over));
        assert_eq!(status, 200, "{}", body.compact());
        assert_eq!(body.get("accepted"), Some(&Json::Bool(false)));
        assert_eq!(rejected_code(&body), Some(&Json::str(want)));
        assert_eq!(bids(&door), pairs(&[]));
    }

    #[test]
    fn combo_without_named_legs_refuses_does_not_rest_as_an_option() {
        refuses(&[], "missing_combo_legs");
    }

    #[test]
    fn missing_ratio_on_a_combo_rest_refuses() {
        refuses(
            &[("legs", Some(legs(Some(("ratio", Json::Null)))))],
            "missing_ratio",
        );
    }

    #[test]
    fn missing_strike_on_a_combo_rest_refuses() {
        refuses(
            &[("legs", Some(legs(Some(("strike", Json::Null)))))],
            "missing_strike",
        );
    }

    #[test]
    fn missing_expiry_on_a_combo_rest_refuses() {
        refuses(
            &[("legs", Some(legs(Some(("expiry", Json::Null)))))],
            "missing_expiry",
        );
    }

    #[test]
    fn named_legs_with_ratios_rest_as_one_instrument_does_not_rest_two_independent_options() {
        let door = mount();
        let (status, body) = post(&door, &submit_body(&[("legs", Some(legs(None)))]));
        assert_eq!(status, 200, "{}", body.compact());
        assert_eq!(body.get("accepted"), Some(&Json::Bool(true)));
        assert_eq!(
            body.get("resting").and_then(|r| r.get("orderId")),
            Some(&Json::str(REST_ID))
        );
        assert_eq!(bids(&door), pairs(&[("99", "2")]));
        assert_eq!(asks(&door), pairs(&[]));
        assert_eq!(door.engine().resting_orders(Some(MARKET)).len(), 1);
    }

    #[test]
    fn two_combos_with_the_same_named_legs_ratios_match_as_one_instrument_decimal_strings() {
        let door = mount();
        let (status, rest) = post(&door, &submit_body(&[("legs", Some(legs(None)))]));
        assert_eq!(status, 200);
        assert_eq!(rest.get("accepted"), Some(&Json::Bool(true)));

        let (status, body) = post(
            &door,
            &submit_body(&[
                ("orderId", Some(Json::str(TAKE_ID))),
                ("accountId", Some(Json::str("taker"))),
                ("side", Some(Json::str("sell"))),
                ("price", Some(Json::str("99"))),
                ("legs", Some(legs(None))),
            ]),
        );
        assert_eq!(status, 200, "{}", body.compact());
        assert_eq!(body.get("accepted"), Some(&Json::Bool(true)));
        let Some(Json::Array(fills)) = body.get("fills") else {
            panic!("fills are an array")
        };
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].get("makerOrderId"), Some(&Json::str(REST_ID)));
        assert_eq!(fills[0].get("takerOrderId"), Some(&Json::str(TAKE_ID)));
        // `typeof qty === 'string'` and `typeof price === 'string'`: each is a JSON string holding the decimal.
        assert_eq!(fills[0].get("qty"), Some(&Json::str("2")));
        assert_eq!(fills[0].get("price"), Some(&Json::str("99")));
        assert_eq!(body.get("resting"), Some(&Json::Null));
        assert_eq!(bids(&door), pairs(&[]));
        assert_eq!(asks(&door), pairs(&[]));
        assert!(door.engine().resting_orders(Some(MARKET)).is_empty());
    }

    #[test]
    fn plain_take_against_a_resting_combo_refuses_does_not_unwind_independent_legs() {
        let door = mount();
        let (_, rest) = post(&door, &submit_body(&[("legs", Some(legs(None)))]));
        assert_eq!(rest.get("accepted"), Some(&Json::Bool(true)));

        let (status, body) = post(
            &door,
            &submit_body(&[
                ("orderId", Some(Json::str(TAKE_ID))),
                ("accountId", Some(Json::str("taker"))),
                ("side", Some(Json::str("sell"))),
                ("price", Some(Json::str("99"))),
                ("combo", Some(Json::Bool(false))),
                ("legs", None),
            ]),
        );
        assert_eq!(status, 200, "{}", body.compact());
        assert_eq!(body.get("accepted"), Some(&Json::Bool(false)));
        assert_eq!(rejected_code(&body), Some(&Json::str("combo_disagrees")));
        assert_eq!(bids(&door), pairs(&[("99", "2")]));
        assert_eq!(door.engine().resting_orders(Some(MARKET)).len(), 1);
    }
}
