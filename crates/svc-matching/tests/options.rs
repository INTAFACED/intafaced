//! The option layer of the `spreads` slice, ported test for test from the TypeScript under `services/svc-matching/src/`:
//! `engine/option.test.ts`, `engine/option-amend-price.test.ts`, `engine/option-cancel.test.ts`,
//! `engine/option-expire.test.ts`, `engine/option-replace.test.ts` and the door test `option.router.test.ts`. Each test
//! is named after its TypeScript `it`, prefixed with the file's topic (`option_`, `amend_`, `cancel_`, `expire_`,
//! `replace_`, `router_`). The TypeScript `replay(records)` is the engine's cold start here (`MatchingEngine::recover`
//! over the same journal), which rebuilds each book the same way and drops a book that never printed and holds nothing.
//!
//! Not ported, and why:
//! - `option-amend-price.test.ts` "refuses a missing price — still at the old price, no invented mark": it sends
//!   `price: null`, which `EngineAmend::price` (an `Option`) cannot hold apart from an omitted price.
//! - `option-amend-price.test.ts` "refuses a supplied mark — unsupported amend field, rest unchanged": `EngineAmend`
//!   has no `mark` field, so the amend cannot name one.
//! - `option-replace.test.ts`, every test but "native amend of price and qty together is one command — priority lost"
//!   (nine): each sends `replace: true`, which `EngineAmend` has no field for.
//! - `option.test.ts` "helpers refuse a missing strike or expiry and do not invent a mark": its `strikeRefuse`,
//!   `expiryRefuse`, `readStrike` and `readExpiry` assertions call helpers private to the option layer that no door
//!   calls directly (their refusals are proven through `submit` and `amend` below), and `wantsOption({ type: 'option' })`
//!   names an order type `OrderType` cannot hold. Its `wantsOption` assertions on strike, expiry and plain types are
//!   ported as `option_helpers_wants_option`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::v8_date_parse;
use svc_matching::approval::Unwired;
use svc_matching::book::order_book::{OrderBook, wants_option};
use svc_matching::book::types::{
    AmendResult, EngineAmend, EngineOrder, Opt, OrderType, Priority, RestKind, Side, SubmitResult,
    Tif,
};
use svc_matching::book::wire::to_wire;
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";

const STRIKE_MISSING: &str = "missing_strike";
const EXPIRY_MISSING: &str = "missing_expiry";
const STRIKE_DISAGREES: &str = "strike_disagrees";
const EXPIRY_DISAGREES: &str = "expiry_disagrees";

const OPT: &str = "11111111-1111-4111-8111-111111111111";
const TAKE: &str = "22222222-2222-4222-8222-222222222222";
const ASK2: &str = "33333333-3333-4333-8333-333333333333";
const MISS: &str = "44444444-4444-4444-8444-444444444444";
const PLAIN: &str = "55555555-5555-4555-8555-555555555555";
const EXER: &str = "66666666-6666-4666-8666-666666666666";
const WRITER: &str = "77777777-7777-4777-8777-777777777777";
const EXER2: &str = "77777777-7777-4777-8777-777777777777";
const HOLDER: &str = "88888888-8888-4888-8888-888888888888";
const NEAR: &str = "12121212-1212-4212-8212-121212121212";
const FAR: &str = "13131313-1313-4313-8313-131313131313";
const BID: &str = "14141414-1414-4414-8414-141414141414";
const SELL: &str = "15151515-1515-4515-8515-151515151515";
const RO: &str = "16161616-1616-4616-8616-161616161616";
const FRONT: &str = "17171717-1717-4717-8717-171717171717";
const OPEN: &str = "18181818-1818-4818-8818-181818181818";
const EXPIRY: &str = "2026-12-31T00:00:00.000Z";
const OTHER: &str = "2026-06-30T00:00:00.000Z";

const LIMIT: OrderType = OrderType::Limit;
const MARKET_T: OrderType = OrderType::Market;
const STOP: OrderType = OrderType::Stop;
const BUY: Side = Side::Buy;
const SELL_S: Side = Side::Sell;

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn at(iso: &str) -> Option<i64> {
    Some(v8_date_parse(iso).unwrap())
}

/// The tests' `order(spec)`: GTC, every optional part absent.
fn order(
    id: &str,
    account: &str,
    kind: OrderType,
    side: Side,
    qty: &str,
    price: Option<&str>,
) -> EngineOrder {
    EngineOrder::new(id, account, kind, side, a(qty), price.map(a), Tif::Gtc)
}

/// `strike: s` (`None` is `strike: null`).
fn strike(mut o: EngineOrder, s: Option<&str>) -> EngineOrder {
    o.strike = s.map_or(Opt::Null, |s| Opt::Some(a(s)));
    o
}

/// `expiry: e` (`None` is `expiry: null`).
fn expiry(mut o: EngineOrder, e: Option<&str>) -> EngineOrder {
    o.expiry = e.map_or(Opt::Null, |e| Opt::Some(e.to_owned()));
    o
}

/// `strike` and `expiry` both named.
fn opt(o: EngineOrder, s: &str, e: &str) -> EngineOrder {
    expiry(strike(o, Some(s)), Some(e))
}

fn exercise(mut o: EngineOrder) -> EngineOrder {
    o.exercise = true;
    o
}

fn cancel(mut o: EngineOrder) -> EngineOrder {
    o.cancel = true;
    o
}

fn mark(mut o: EngineOrder, m: &str) -> EngineOrder {
    o.mark = Some(a(m));
    o
}

fn stop_px(mut o: EngineOrder, s: &str) -> EngineOrder {
    o.stop_price = Some(a(s));
    o
}

fn tif(mut o: EngineOrder, t: Tif, expire_at: &str) -> EngineOrder {
    o.tif = t;
    o.expire_at = Some(expire_at.to_owned());
    o
}

/// The exercise `order({ id, account, type: 'limit', side: 'buy', qty, strike: '100', expiry: EXPIRY, exercise: true })`.
fn exer(id: &str, account: &str, side: Side, qty: &str) -> EngineOrder {
    exercise(opt(
        order(id, account, LIMIT, side, qty, None),
        "100",
        EXPIRY,
    ))
}

/// `amend({ orderId, expectedVersion, price })`.
fn amend_price(order_id: &str, version: u64, price: &str) -> EngineAmend {
    EngineAmend {
        order_id: order_id.to_owned(),
        expected_version: version,
        price: Some(a(price)),
        ..EngineAmend::default()
    }
}

/// The amend tests' `patch(rest, { strike, expiry, price })` (`None` is omitted).
fn patch(
    order_id: &str,
    version: u64,
    strike: Option<&str>,
    expiry: Option<&str>,
    price: Option<&str>,
) -> EngineAmend {
    EngineAmend {
        order_id: order_id.to_owned(),
        expected_version: version,
        price: price.map(a),
        strike: strike.map_or(Opt::Absent, |s| Opt::Some(a(s))),
        expiry: expiry.map_or(Opt::Absent, |e| Opt::Some(e.to_owned())),
        ..EngineAmend::default()
    }
}

fn submit(book: &mut OrderBook, o: &EngineOrder) -> SubmitResult {
    book.submit(o, None)
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|r| r.code.as_str())
}

fn amend_code(r: &AmendResult) -> Option<&str> {
    r.rejected.as_ref().map(|r| r.code.as_str())
}

fn ladder(levels: &[(Amount, Amount)]) -> Vec<(String, String)> {
    levels
        .iter()
        .map(|(p, q)| (format_amount(*p), format_amount(*q)))
        .collect()
}

fn bids(book: &OrderBook) -> Vec<(String, String)> {
    ladder(&book.depth(50).0)
}

fn asks(book: &OrderBook) -> Vec<(String, String)> {
    ladder(&book.depth(50).1)
}

fn lv(rows: &[(&str, &str)]) -> Vec<(String, String)> {
    rows.iter()
        .map(|(p, q)| ((*p).to_owned(), (*q).to_owned()))
        .collect()
}

fn none() -> Vec<(String, String)> {
    Vec::new()
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn text(j: Option<&Json>) -> String {
    match j {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not text: {other:?}"),
    }
}

fn array(j: Option<&Json>) -> Vec<Json> {
    match j {
        Some(Json::Array(v)) => v.clone(),
        other => panic!("not an array: {other:?}"),
    }
}

/// `book.toState()[side].map((level) => level.orders.map((row) => row.orderId))`, one entry a level.
fn level_ids(book: &OrderBook, side: &str) -> Vec<Vec<String>> {
    let state = book.to_state();
    array(state.get(side))
        .iter()
        .map(|level| {
            array(level.get("orders"))
                .iter()
                .map(|o| text(o.get("orderId")))
                .collect()
        })
        .collect()
}

/// Every order id on a side, best level first (`flatMap`).
fn side_ids(book: &OrderBook, side: &str) -> Vec<String> {
    level_ids(book, side).into_iter().flatten().collect()
}

fn stops(book: &OrderBook) -> usize {
    array(book.to_state().get("stops")).len()
}

/// `book.toState().positions ?? []`.
fn positions(book: &OrderBook) -> Json {
    book.to_state()
        .get("positions")
        .cloned()
        .unwrap_or(Json::Array(Vec::new()))
}

fn makers(r: &SubmitResult) -> Vec<String> {
    r.fills.iter().map(|f| f.maker_order_id.clone()).collect()
}

fn reasons(r: &[svc_matching::book::types::CancelledRef]) -> Vec<(String, String)> {
    r.iter()
        .map(|c| (c.order_id.clone(), c.reason.as_str().to_owned()))
        .collect()
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    lv(list)
}

fn remaining_of(r: &[svc_matching::book::types::CancelledRef], id: &str) -> String {
    format_amount(r.iter().find(|c| c.order_id == id).unwrap().remaining_qty)
}

fn rests_on_book(r: &SubmitResult, id: &str) {
    let resting = r.resting.as_ref().expect("resting");
    assert_eq!(resting.kind, RestKind::Book);
    assert_eq!(resting.order_id, id);
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

/// The resting option most tests start from: desk buys 2 at 99, strike 100, expiry EXPIRY.
fn rest_bid(book: &mut OrderBook) -> SubmitResult {
    submit(
        book,
        &opt(
            order(OPT, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
    )
}

// ── option.test.ts: rest as a limit ─────────────────────────────────────

#[test]
fn option_rests_with_strike_expiry_price_on_the_public_book() {
    let mut book = OrderBook::new(MARKET);
    let result = rest_bid(&mut book);
    assert!(result.accepted);
    rests_on_book(&result, OPT);
    assert!(result.fills.is_empty());
    assert_eq!(bids(&book), lv(&[("99", "2")]));
    assert_eq!(stops(&book), 0);
}

#[test]
fn option_refuses_a_missing_strike_no_invented_strike() {
    let mut book = OrderBook::new(MARKET);
    for s in [None, Some("0")] {
        let o = expiry(
            strike(order(MISS, "desk", LIMIT, BUY, "2", Some("99")), s),
            Some(EXPIRY),
        );
        let result = submit(&mut book, &o);
        assert!(!result.accepted);
        assert_eq!(code(&result), Some(STRIKE_MISSING));
        assert!(result.resting.is_none());
    }
    assert_eq!(bids(&book), none());
}

#[test]
fn option_refuses_a_missing_expiry_no_invented_expiry() {
    let mut book = OrderBook::new(MARKET);
    for e in [None, Some(""), Some("   ")] {
        let o = expiry(
            strike(
                order(MISS, "desk", LIMIT, BUY, "2", Some("99")),
                Some("100"),
            ),
            e,
        );
        let result = submit(&mut book, &o);
        assert!(!result.accepted);
        assert_eq!(code(&result), Some(EXPIRY_MISSING));
        assert!(result.resting.is_none());
    }
    assert_eq!(bids(&book), none());
}

#[test]
fn option_omitted_mark_is_fine_do_not_require_a_mark() {
    let mut book = OrderBook::new(MARKET);
    let result = rest_bid(&mut book);
    assert!(result.accepted);
    rests_on_book(&result, OPT);
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn option_missing_price_refuses_invalid_price_do_not_substitute_a_mark() {
    let mut book = OrderBook::new(MARKET);
    let result = submit(
        &mut book,
        &opt(order(MISS, "desk", LIMIT, BUY, "2", None), "100", EXPIRY),
    );
    assert!(!result.accepted);
    assert_eq!(code(&result), Some("invalid_price"));
    assert!(result.resting.is_none());
    assert_eq!(bids(&book), none());
}

#[test]
fn option_a_plain_limit_without_strike_expiry_still_rests() {
    let mut book = OrderBook::new(MARKET);
    let plain = order(PLAIN, "desk", LIMIT, BUY, "2", Some("99"));
    let limit = submit(&mut book, &plain);
    assert!(limit.accepted);
    rests_on_book(&limit, PLAIN);
    assert_eq!(bids(&book), lv(&[("99", "2")]));
    assert!(!wants_option(&order(PLAIN, "desk", LIMIT, BUY, "1", None)));
}

#[test]
fn option_journal_replay_keeps_strike_expiry_and_rests_at_the_same_price() {
    let mut journal = MemoryJournal::new();
    let mut live = OrderBook::new(MARKET);
    let o = opt(
        order(OPT, "desk", LIMIT, BUY, "2", Some("99")),
        "100",
        EXPIRY,
    );
    let wire = to_wire(&o, None);
    assert_eq!(wire.get("strike"), Some(&Json::str("100")));
    assert_eq!(wire.get("expiry"), Some(&Json::str(EXPIRY)));
    journal
        .append(&submit_record(&o, "2026-08-31T12:00:00.000Z"))
        .unwrap();
    submit(&mut live, &o);
    let engine = replay(Box::new(journal));
    let restored = engine.existing_book(MARKET).unwrap();
    assert_eq!(restored.serialize(), live.serialize());
    assert_eq!(bids(restored), lv(&[("99", "2")]));
}

#[test]
fn option_journal_replay_still_refuses_a_missing_strike_crash_cannot_rest_a_refused_option() {
    let mut journal = MemoryJournal::new();
    let mut live = OrderBook::new(MARKET);
    let bad = expiry(
        strike(order(MISS, "desk", LIMIT, BUY, "2", Some("99")), None),
        Some(EXPIRY),
    );
    assert_eq!(to_wire(&bad, None).get("strike"), Some(&Json::Null));
    assert_eq!(to_wire(&bad, None).get("expiry"), Some(&Json::str(EXPIRY)));
    journal
        .append(&submit_record(&bad, "2026-08-31T12:00:00.000Z"))
        .unwrap();
    let result = submit(&mut live, &bad);
    assert!(!result.accepted);
    assert_eq!(code(&result), Some(STRIKE_MISSING));
    let engine = replay(Box::new(journal));
    assert!(engine.existing_book(MARKET).is_none());
}

#[test]
fn option_file_journal_encode_keeps_a_missing_strike_so_a_crash_still_refuses() {
    let dir = temp_dir("matching-option-");
    let path = dir.join("engine.ndjson");
    let bad = expiry(
        strike(order(MISS, "desk", LIMIT, BUY, "2", Some("99")), None),
        Some(EXPIRY),
    );
    let mut j1 = FileJournal::open(&path).unwrap();
    j1.append(&submit_record(&bad, "2026-08-31T12:00:00.000Z"))
        .unwrap();
    j1.close().unwrap();
    drop(j1);
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"strike\":null"));
    assert!(raw.contains(&format!("\"expiry\":\"{EXPIRY}\"")));
    let engine = replay(Box::new(FileJournal::open(&path).unwrap()));
    assert!(engine.existing_book(MARKET).is_none());
    drop(engine);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn option_helpers_wants_option() {
    // The `wantsOption` assertions of "helpers refuse a missing strike or expiry and do not invent a mark".
    let base = || order(PLAIN, "desk", LIMIT, BUY, "1", None);
    let mut with_strike = base();
    with_strike.strike = Opt::Some(a("100"));
    assert!(wants_option(&with_strike));
    let mut with_expiry = base();
    with_expiry.expiry = Opt::Some(EXPIRY.to_owned());
    assert!(wants_option(&with_expiry));
    assert!(!wants_option(&base()));
    assert!(!wants_option(&order(PLAIN, "desk", STOP, BUY, "1", None)));
}

// ── option.test.ts: take against a resting option ───────────────────────

fn rest_ask(book: &mut OrderBook, account: &str, price: &str) -> SubmitResult {
    submit(
        book,
        &opt(
            order(OPT, account, LIMIT, SELL_S, "2", Some(price)),
            "100",
            EXPIRY,
        ),
    )
}

#[test]
fn option_takes_a_resting_option_with_the_same_strike_and_expiry() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_ask(&mut book, "writer", "99");
    assert!(rest.accepted);
    rests_on_book(&rest, OPT);

    let take = submit(
        &mut book,
        &opt(
            order(TAKE, "taker", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, OPT);
    assert_eq!(take.fills[0].taker_order_id, TAKE);
    assert_eq!(format_amount(take.fills[0].price), "99");
    assert!(take.resting.is_none());
    assert_eq!(asks(&book), none());
    assert_eq!(bids(&book), none());
}

#[test]
fn option_refuses_a_missing_strike_on_the_take_no_invented_strike() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "desk", "99");
    let take = submit(
        &mut book,
        &expiry(
            strike(order(TAKE, "desk", LIMIT, BUY, "2", Some("99")), None),
            Some(EXPIRY),
        ),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(STRIKE_MISSING));
    assert!(take.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_a_missing_expiry_on_the_take_no_invented_expiry() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "desk", "99");
    let take = submit(
        &mut book,
        &expiry(
            strike(
                order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
                Some("100"),
            ),
            None,
        ),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(EXPIRY_MISSING));
    assert!(take.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_when_strike_disagrees_do_not_take_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "desk", "99");
    let take = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "105",
            EXPIRY,
        ),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(STRIKE_DISAGREES));
    assert!(take.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_when_expiry_disagrees_do_not_take_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "desk", "99");
    let take = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            OTHER,
        ),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(EXPIRY_DISAGREES));
    assert!(take.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_a_take_that_would_print_a_plain_limit_not_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(
        &mut book,
        &order(PLAIN, "desk", LIMIT, SELL_S, "2", Some("99")),
    );
    let take = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(STRIKE_DISAGREES));
    assert!(take.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_omitted_mark_is_fine_on_a_take_do_not_require_a_mark() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "writer", "99");
    let take = submit(
        &mut book,
        &opt(
            order(TAKE, "taker", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
    );
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
}

#[test]
fn option_a_non_crossing_option_still_rests_do_not_invent_a_take() {
    let mut book = OrderBook::new(MARKET);
    rest_ask(&mut book, "desk", "101");
    let bid = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
    );
    assert!(bid.accepted);
    assert!(bid.fills.is_empty());
    rests_on_book(&bid, TAKE);
    assert_eq!(asks(&book), lv(&[("101", "2")]));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

// ── option.test.ts: a non-option cannot take a resting option ───────────

fn opt_order(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    opt(
        order(id, account, LIMIT, side, qty, Some(price)),
        "100",
        EXPIRY,
    )
}

fn plain(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    order(id, account, LIMIT, side, qty, Some(price))
}

fn invented_is_flat(book: &mut OrderBook, account: &str) {
    let invented = submit(book, &exer(EXER, account, BUY, "1"));
    assert!(!invented.accepted);
    assert_eq!(code(&invented), Some("position_flat"));
}

#[test]
fn option_refuses_a_plain_order_that_would_take_a_resting_option_and_leaves_the_option_position_unchanged()
 {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(WRITER, "writer", SELL_S, "2", "99"));
    submit(&mut book, &opt_order(HOLDER, "holder", BUY, "2", "99"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "2", "99"));
    let before = positions(&book);

    let p = submit(&mut book, &plain(PLAIN, "taker", BUY, "2", "99"));
    assert!(!p.accepted);
    assert_eq!(code(&p), Some(STRIKE_DISAGREES));
    assert!(p.fills.is_empty());
    assert!(p.resting.is_none());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
    assert_eq!(positions(&book), before);

    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "2"));
    assert!(ex.accepted);
    assert_eq!(ex.fills.len(), 1);
    assert_eq!(format_amount(ex.fills[0].qty), "2");
    assert_eq!(format_amount(ex.fills[0].price), "100");

    let extra = submit(&mut book, &exer(TAKE, "holder", BUY, "1"));
    assert!(!extra.accepted);
    assert_eq!(code(&extra), Some("position_flat"));

    let invented = submit(&mut book, &exer(MISS, "taker", BUY, "1"));
    assert!(!invented.accepted);
    assert_eq!(code(&invented), Some("position_flat"));
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_a_plain_order_that_does_not_cross_a_resting_option_still_submits() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "101"));
    let bid = submit(&mut book, &plain(PLAIN, "desk", BUY, "2", "99"));
    assert!(bid.accepted);
    assert!(bid.fills.is_empty());
    rests_on_book(&bid, PLAIN);
    assert_eq!(asks(&book), lv(&[("101", "2")]));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn option_a_plain_order_that_fills_in_front_of_a_resting_option_still_submits() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &plain(PLAIN, "maker", SELL_S, "1", "90"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "2", "99"));
    let buy = submit(&mut book, &plain(TAKE, "taker", BUY, "1", "99"));
    assert!(buy.accepted);
    assert_eq!(buy.fills.len(), 1);
    assert_eq!(buy.fills[0].maker_order_id, PLAIN);
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_a_market_order_that_would_take_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "2", "99"));
    let market = submit(&mut book, &order(PLAIN, "taker", MARKET_T, BUY, "1", None));
    assert!(!market.accepted);
    assert_eq!(code(&market), Some(STRIKE_DISAGREES));
    assert!(market.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_refuses_a_stop_that_would_trigger_through_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &plain(MISS, "seed-ask", SELL_S, "1", "50"));
    submit(&mut book, &plain(TAKE, "seed-bid", BUY, "1", "50"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "2", "50"));
    let stop = submit(
        &mut book,
        &stop_px(order(PLAIN, "taker", STOP, BUY, "1", None), "50"),
    );
    assert!(!stop.accepted);
    assert_eq!(code(&stop), Some(STRIKE_DISAGREES));
    assert!(stop.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("50", "2")]));
    assert_eq!(stops(&book), 0);
}

#[test]
fn option_a_stop_that_does_not_trigger_still_rests_beside_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "99"));
    let stop = submit(
        &mut book,
        &stop_px(order(PLAIN, "desk", STOP, BUY, "1", None), "120"),
    );
    assert!(stop.accepted);
    assert!(stop.fills.is_empty());
    let resting = stop.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Stop);
    assert_eq!(resting.order_id, PLAIN);
    assert_eq!(asks(&book), lv(&[("99", "2")]));
}

#[test]
fn option_a_later_trade_that_triggers_a_resting_stop_does_not_take_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    let stop = submit(
        &mut book,
        &stop_px(order(PLAIN, "taker", STOP, BUY, "1", None), "50"),
    );
    assert!(stop.accepted);
    let resting = stop.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Stop);
    assert_eq!(resting.order_id, PLAIN);
    submit(&mut book, &plain(BID, "mm", BUY, "1", "50"));

    let trade = submit(&mut book, &plain(SELL, "seller", SELL_S, "1", "50"));
    assert!(trade.accepted);
    assert_eq!(trade.fills.len(), 1);
    assert_eq!(trade.fills[0].maker_order_id, BID);
    assert_eq!(trade.triggered.len(), 1);
    assert_eq!(trade.triggered[0].order_id, PLAIN);
    assert!(trade.triggered[0].fills.is_empty());
    assert_eq!(
        trade.triggered[0]
            .rejected
            .as_ref()
            .map(|r| r.code.as_str()),
        Some(STRIKE_DISAGREES)
    );
    assert_eq!(
        trade.triggered[0]
            .cancellations
            .iter()
            .map(|c| c.reason.as_str())
            .collect::<Vec<_>>(),
        vec!["trigger_rejected"]
    );
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[OPT]));
    assert_eq!(stops(&book), 0);

    let invented = submit(&mut book, &exer(EXER, "taker", BUY, "1"));
    assert!(!invented.accepted);
    assert_eq!(code(&invented), Some("position_flat"));
    assert_eq!(asks(&book), lv(&[("99", "1")]));
}

#[test]
fn option_a_stop_that_triggers_into_a_plain_in_front_of_a_resting_option_still_fills_that_plain() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &plain(FRONT, "maker", SELL_S, "1", "90"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    submit(
        &mut book,
        &stop_px(order(PLAIN, "taker", STOP, BUY, "1", None), "50"),
    );
    submit(&mut book, &plain(BID, "mm", BUY, "1", "50"));

    let trade = submit(&mut book, &plain(SELL, "seller", SELL_S, "1", "50"));
    assert!(trade.accepted);
    assert_eq!(trade.triggered.len(), 1);
    assert_eq!(trade.triggered[0].fills.len(), 1);
    assert_eq!(trade.triggered[0].fills[0].maker_order_id, FRONT);
    assert!(trade.triggered[0].rejected.is_none());
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[OPT]));
}

#[test]
fn option_an_oco_sibling_cancelled_before_the_sweep_does_not_let_the_remainder_take_a_resting_option()
 {
    let mut book = OrderBook::new(MARKET);
    let mut near = plain(NEAR, "desk", SELL_S, "1", "100");
    near.oco_sibling_id = Some(FAR.to_owned());
    let mut far = plain(FAR, "desk", SELL_S, "1", "101");
    far.oco_sibling_id = Some(NEAR.to_owned());
    submit(&mut book, &near);
    submit(&mut book, &far);
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "102"));

    let sized = submit(&mut book, &plain(PLAIN, "taker", BUY, "2", "102"));
    assert!(!sized.accepted);
    assert_eq!(code(&sized), Some(STRIKE_DISAGREES));
    assert!(sized.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("100", "1"), ("101", "1"), ("102", "1")]));
    assert_eq!(side_ids(&book, "asks"), ids(&[NEAR, FAR, OPT]));

    let one = submit(&mut book, &plain(TAKE, "taker", BUY, "1", "102"));
    assert!(one.accepted);
    assert_eq!(makers(&one), ids(&[NEAR]));
    assert!(one.cancellations.iter().any(|c| c.order_id == FAR));
    assert_eq!(side_ids(&book, "asks"), ids(&[OPT]));

    invented_is_flat(&mut book, "taker");
}

#[test]
fn option_a_reduce_only_clip_does_not_let_the_remainder_take_a_resting_option() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &plain(OPEN, "mm", SELL_S, "2", "50"));
    let opened = submit(&mut book, &plain(HOLDER, "desk", BUY, "2", "50"));
    assert_eq!(opened.fills.len(), 1);
    submit(&mut book, &plain(FRONT, "desk", SELL_S, "1", "60"));
    let mut ro_order = plain(RO, "desk", SELL_S, "2", "70");
    ro_order.reduce_only = true;
    let ro = submit(&mut book, &ro_order);
    assert!(ro.accepted);
    rests_on_book(&ro, RO);
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "80"));
    let before = positions(&book);

    let sized = submit(&mut book, &plain(PLAIN, "taker", BUY, "3", "80"));
    assert!(!sized.accepted);
    assert_eq!(code(&sized), Some(STRIKE_DISAGREES));
    assert!(sized.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("60", "1"), ("70", "2"), ("80", "1")]));
    assert_eq!(positions(&book), before);
    assert_eq!(level_ids(&book, "asks")[2], ids(&[OPT]));

    let printed = submit(&mut book, &plain(TAKE, "taker", BUY, "2", "80"));
    assert!(printed.accepted);
    assert_eq!(makers(&printed), ids(&[FRONT, RO]));
    assert_eq!(
        printed
            .fills
            .iter()
            .map(|f| format_amount(f.qty))
            .collect::<Vec<_>>(),
        ids(&["1", "1"])
    );
    assert_eq!(asks(&book), lv(&[("80", "1")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[OPT]));

    invented_is_flat(&mut book, "taker");
}

#[test]
fn option_an_amend_that_moves_a_plain_order_into_a_resting_option_refuses() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &plain(PLAIN, "taker", BUY, "1", "90"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    let before = positions(&book);

    let moved = book.amend(&amend_price(PLAIN, 1, "99"), None);
    assert!(!moved.accepted);
    assert_eq!(amend_code(&moved), Some(STRIKE_DISAGREES));
    assert!(moved.fills.is_empty());
    assert_eq!(bids(&book), lv(&[("90", "1")]));
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(positions(&book), before);

    let aside = book.amend(&amend_price(PLAIN, 1, "91"), None);
    assert!(aside.accepted);
    assert!(aside.fills.is_empty());
    assert_eq!(bids(&book), lv(&[("91", "1")]));
    assert_eq!(asks(&book), lv(&[("99", "1")]));

    invented_is_flat(&mut book, "taker");
}

#[test]
fn option_a_due_gtd_or_gtt_plain_in_front_does_not_let_the_remainder_print_a_resting_option() {
    let early = at("2026-08-25T11:00:00.000Z");
    let late = at("2026-08-25T15:00:00.000Z");
    let due_at = "2026-08-25T12:00:00.000Z";

    let arm = |t: Tif| {
        let mut book = OrderBook::new(MARKET);
        submit(&mut book, &plain(OPEN, "mm", SELL_S, "1", "50"));
        submit(&mut book, &plain(HOLDER, "desk", BUY, "1", "50"));
        let due = book.submit(
            &tif(plain(FRONT, "maker", SELL_S, "1", "90"), t, due_at),
            early,
        );
        assert!(due.accepted);
        submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
        submit(&mut book, &plain(BID, "taker", BUY, "1", "80"));
        book
    };
    let expired_front = pairs(&[(FRONT, "expired")]);

    let mut gtd = arm(Tif::Gtd);
    let before = positions(&gtd);
    let p = gtd.submit(&plain(PLAIN, "taker", BUY, "1", "99"), late);
    assert!(!p.accepted);
    assert_eq!(code(&p), Some(STRIKE_DISAGREES));
    assert!(p.fills.is_empty());
    assert_eq!(reasons(&p.cancellations), expired_front);
    assert_eq!(bids(&gtd), lv(&[("80", "1")]));
    assert_eq!(asks(&gtd), lv(&[("99", "1")]));
    assert_eq!(level_ids(&gtd, "asks")[0], ids(&[OPT]));
    assert_eq!(positions(&gtd), before);

    let mut market_book = arm(Tif::Gtd);
    let market = market_book.submit(&order(MISS, "taker", MARKET_T, BUY, "1", None), late);
    assert!(!market.accepted);
    assert_eq!(code(&market), Some(STRIKE_DISAGREES));
    assert!(market.fills.is_empty());
    assert_eq!(reasons(&market.cancellations), expired_front);
    assert_eq!(asks(&market_book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&market_book, "asks")[0], ids(&[OPT]));

    let mut stop_book = arm(Tif::Gtt);
    let stop = stop_book.submit(
        &stop_px(order(TAKE, "taker", STOP, BUY, "1", None), "50"),
        late,
    );
    assert!(!stop.accepted);
    assert_eq!(code(&stop), Some(STRIKE_DISAGREES));
    assert!(stop.fills.is_empty());
    assert_eq!(reasons(&stop.cancellations), expired_front);
    assert_eq!(stops(&stop_book), 0);
    assert_eq!(asks(&stop_book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&stop_book, "asks")[0], ids(&[OPT]));

    let mut gtt = arm(Tif::Gtt);
    let moved = gtt.amend(&amend_price(BID, 1, "99"), late);
    assert!(!moved.accepted);
    assert_eq!(amend_code(&moved), Some(STRIKE_DISAGREES));
    assert!(moved.fills.is_empty());
    assert_eq!(reasons(&moved.cancellations), expired_front);
    assert_eq!(bids(&gtt), lv(&[("80", "1")]));
    assert_eq!(asks(&gtt), lv(&[("99", "1")]));
    assert_eq!(level_ids(&gtt, "asks")[0], ids(&[OPT]));
    assert_eq!(positions(&gtt), before);

    let mut aside_book = arm(Tif::Gtd);
    let aside = aside_book.submit(&plain(SELL, "taker", BUY, "1", "70"), late);
    assert!(aside.accepted);
    assert!(aside.fills.is_empty());
    assert_eq!(reasons(&aside.cancellations), expired_front);
    rests_on_book(&aside, SELL);
    assert_eq!(asks(&aside_book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&aside_book, "asks")[0], ids(&[OPT]));
    assert_eq!(bids(&aside_book), lv(&[("80", "1"), ("70", "1")]));

    let invented = submit(&mut gtd, &exer(EXER, "taker", BUY, "1"));
    assert!(!invented.accepted);
    assert_eq!(code(&invented), Some("position_flat"));
    assert_eq!(asks(&gtd), lv(&[("99", "1")]));
}

#[test]
fn option_a_peg_or_relative_order_is_judged_after_it_binds_and_does_not_print_a_resting_option_it_reaches()
 {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    let before = positions(&book);

    let mut relative = plain(PLAIN, "taker", BUY, "1", "80");
    relative.relative = Opt::Some(true);
    relative.reference = Opt::Some(a("90"));
    relative.offset = Opt::Some(a("9"));
    let reached = submit(&mut book, &relative);
    assert!(!reached.accepted);
    assert_eq!(code(&reached), Some(STRIKE_DISAGREES));
    assert!(reached.fills.is_empty());
    assert!(reached.resting.is_none());
    assert_eq!(bids(&book), none());
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[OPT]));
    assert_eq!(positions(&book), before);

    let mut peg = order(TAKE, "taker", MARKET_T, BUY, "1", None);
    peg.peg = Opt::Some(true);
    peg.reference = Opt::Some(a("80"));
    peg.offset = Opt::Some(a("0"));
    let rests = submit(&mut book, &peg);
    assert!(rests.accepted);
    assert!(rests.fills.is_empty());
    rests_on_book(&rests, TAKE);
    assert_eq!(bids(&book), lv(&[("80", "1")]));
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[OPT]));
    assert_eq!(positions(&book), before);

    let invented = submit(&mut book, &exer(EXER, "taker", BUY, "1"));
    assert!(!invented.accepted);
    assert_eq!(code(&invented), Some("position_flat"));
    assert_eq!(asks(&book), lv(&[("99", "1")]));
}

// ── option.test.ts: exercise a long ─────────────────────────────────────

#[test]
fn option_exercises_a_long_at_strike_never_a_mark() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(WRITER, "writer", SELL_S, "2", "99"));
    let take = submit(&mut book, &opt_order(HOLDER, "holder", BUY, "2", "99"));
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);

    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "2"));
    assert!(ex.accepted);
    assert!(ex.resting.is_none());
    assert_eq!(ex.fills.len(), 1);
    assert_eq!(format_amount(ex.fills[0].price), "100");
    assert!(book.would_open_or_increase("holder", SELL_S, a("2"), None));
}

#[test]
fn option_assigns_the_earlier_short_then_the_later_short_when_one_account_sold_twice() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(WRITER, "writer", SELL_S, "1", "99"));
    submit(&mut book, &opt_order(HOLDER, "holder", BUY, "1", "99"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    let second = submit(&mut book, &opt_order(TAKE, "holder", BUY, "1", "99"));
    assert!(second.accepted);
    assert_eq!(second.fills[0].maker_order_id, OPT);

    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "2"));
    assert!(ex.accepted);
    assert_eq!(makers(&ex), ids(&[WRITER, OPT]));
    assert_eq!(
        ex.fills
            .iter()
            .map(|f| f.maker_account_id.clone())
            .collect::<Vec<_>>(),
        ids(&["writer", "writer"])
    );
    assert_eq!(
        ex.fills
            .iter()
            .map(|f| format_amount(f.qty))
            .collect::<Vec<_>>(),
        ids(&["1", "1"])
    );
    assert_eq!(
        ex.fills
            .iter()
            .map(|f| format_amount(f.price))
            .collect::<Vec<_>>(),
        ids(&["100", "100"])
    );
}

#[test]
fn option_reducing_a_short_consumes_the_earliest_lot_and_leaves_the_later_order_id() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(WRITER, "writer", SELL_S, "1", "99"));
    submit(&mut book, &opt_order(HOLDER, "holder", BUY, "1", "99"));
    submit(&mut book, &opt_order(OPT, "writer", SELL_S, "1", "99"));
    submit(&mut book, &opt_order(TAKE, "holder", BUY, "1", "99"));
    submit(&mut book, &opt_order(SELL, "other", SELL_S, "1", "99"));
    let reduced = submit(&mut book, &opt_order(BID, "writer", BUY, "1", "99"));
    assert!(reduced.accepted);
    assert_eq!(reduced.fills[0].maker_order_id, SELL);

    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "1"));
    assert!(ex.accepted);
    assert_eq!(makers(&ex), ids(&[OPT]));
    assert_eq!(
        ex.fills
            .iter()
            .map(|f| f.maker_account_id.clone())
            .collect::<Vec<_>>(),
        ids(&["writer"])
    );
    assert_eq!(
        ex.fills
            .iter()
            .map(|f| format_amount(f.qty))
            .collect::<Vec<_>>(),
        ids(&["1"])
    );
}

fn long_holder(book: &mut OrderBook) {
    submit(book, &opt_order(WRITER, "writer", SELL_S, "2", "99"));
    submit(book, &opt_order(HOLDER, "holder", BUY, "2", "99"));
}

#[test]
fn option_exercise_refuses_a_missing_strike_no_invented_strike() {
    let mut book = OrderBook::new(MARKET);
    long_holder(&mut book);
    let mut ex = exercise(order(EXER, "holder", LIMIT, BUY, "2", None));
    ex.expiry = Opt::Some(EXPIRY.to_owned());
    let ex = submit(&mut book, &ex);
    assert!(!ex.accepted);
    assert_eq!(code(&ex), Some(STRIKE_MISSING));
    assert!(ex.fills.is_empty());
}

#[test]
fn option_exercise_refuses_a_missing_expiry_no_invented_expiry() {
    let mut book = OrderBook::new(MARKET);
    long_holder(&mut book);
    let mut ex = exercise(order(EXER, "holder", LIMIT, BUY, "2", None));
    ex.strike = Opt::Some(a("100"));
    let ex = submit(&mut book, &ex);
    assert!(!ex.accepted);
    assert_eq!(code(&ex), Some(EXPIRY_MISSING));
    assert!(ex.fills.is_empty());
}

#[test]
fn option_a_supplied_mark_is_ignored_exercise_prints_at_strike() {
    let mut book = OrderBook::new(MARKET);
    long_holder(&mut book);
    let ex = submit(&mut book, &mark(exer(EXER, "holder", BUY, "2"), "50"));
    assert!(ex.accepted);
    assert_eq!(format_amount(ex.fills[0].price), "100");
}

#[test]
fn option_refuses_when_the_account_is_not_long_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "2"));
    assert!(!ex.accepted);
    assert_eq!(code(&ex), Some("position_flat"));
    assert!(ex.fills.is_empty());
}

// ── option-amend-price.test.ts ──────────────────────────────────────────

fn version(r: &SubmitResult) -> u64 {
    r.resting.as_ref().unwrap().version
}

#[test]
fn amend_moves_the_rest_to_the_new_price_remainder_stays_mark_is_not_used() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    assert!(rest.accepted);
    assert_eq!(bids(&book), lv(&[("99", "2")]));

    let amended = book.amend(
        &patch(OPT, version(&rest), Some("100"), Some(EXPIRY), Some("101")),
        None,
    );
    assert!(amended.accepted);
    assert!(amended.rejected.is_none());
    let resting = amended.resting.as_ref().unwrap();
    assert_eq!(format_amount(resting.price), "101");
    assert_eq!(format_amount(resting.remaining), "2");
    assert_eq!(bids(&book), lv(&[("101", "2")]));
}

#[test]
fn amend_refuses_a_missing_strike_still_at_the_old_price_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    let amended = book.amend(
        &patch(OPT, version(&rest), None, Some(EXPIRY), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(STRIKE_MISSING));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_a_missing_expiry_still_at_the_old_price_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    let amended = book.amend(
        &patch(OPT, version(&rest), Some("100"), None, Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(EXPIRY_MISSING));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_when_strike_disagrees_do_not_amend_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    let amended = book.amend(
        &patch(OPT, version(&rest), Some("105"), Some(EXPIRY), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(STRIKE_DISAGREES));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_when_expiry_disagrees_do_not_amend_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    let amended = book.amend(
        &patch(OPT, version(&rest), Some("100"), Some(OTHER), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(EXPIRY_DISAGREES));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_when_nothing_is_resting_no_invented_amend() {
    let mut book = OrderBook::new(MARKET);
    let amended = book.amend(
        &patch(MISS, 1, Some("100"), Some(EXPIRY), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some("order_not_found"));
    assert_eq!(bids(&book), none());
}

#[test]
fn amend_refuses_an_amend_that_would_cross_a_plain_limit_book_unchanged() {
    let mut book = OrderBook::new(MARKET);
    let rest = submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "101"));
    submit(&mut book, &plain(PLAIN, "desk", BUY, "2", "99"));
    let before = book.current_sequence();
    let amended = book.amend(
        &patch(OPT, version(&rest), Some("100"), Some(EXPIRY), Some("99")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(STRIKE_DISAGREES));
    assert!(amended.fills.is_empty());
    assert_eq!(book.current_sequence(), before);
    assert_eq!(asks(&book), lv(&[("101", "2")]));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_an_amend_that_would_cross_a_different_strike_book_unchanged() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "101"));
    let bid = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "105",
            EXPIRY,
        ),
    );
    let before = book.current_sequence();
    let amended = book.amend(
        &patch(TAKE, version(&bid), Some("105"), Some(EXPIRY), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(STRIKE_DISAGREES));
    assert!(amended.fills.is_empty());
    assert_eq!(book.current_sequence(), before);
    assert_eq!(asks(&book), lv(&[("101", "2")]));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_refuses_an_amend_that_would_cross_a_different_expiry_book_unchanged() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "101"));
    let bid = submit(
        &mut book,
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            OTHER,
        ),
    );
    let before = book.current_sequence();
    let amended = book.amend(
        &patch(TAKE, version(&bid), Some("100"), Some(OTHER), Some("101")),
        None,
    );
    assert!(!amended.accepted);
    assert_eq!(amend_code(&amended), Some(EXPIRY_DISAGREES));
    assert!(amended.fills.is_empty());
    assert_eq!(book.current_sequence(), before);
    assert_eq!(asks(&book), lv(&[("101", "2")]));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn amend_a_non_crossing_amend_of_the_same_strike_and_expiry_still_applies() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "desk", SELL_S, "2", "110"));
    let bid = submit(&mut book, &opt_order(TAKE, "desk", BUY, "2", "99"));
    let amended = book.amend(
        &patch(TAKE, version(&bid), Some("100"), Some(EXPIRY), Some("101")),
        None,
    );
    assert!(amended.accepted);
    assert!(amended.fills.is_empty());
    assert_eq!(
        format_amount(amended.resting.as_ref().unwrap().price),
        "101"
    );
    assert_eq!(bids(&book), lv(&[("101", "2")]));
    assert_eq!(asks(&book), lv(&[("110", "2")]));
    let ex = submit(&mut book, &exer(EXER, "desk", BUY, "2"));
    assert!(!ex.accepted);
    assert_eq!(code(&ex), Some("position_flat"));
}

#[test]
fn amend_records_every_amend_fill_on_the_option_position_for_that_strike_and_expiry() {
    let mut book = OrderBook::new(MARKET);
    submit(&mut book, &opt_order(OPT, "writer-a", SELL_S, "1", "101"));
    submit(&mut book, &opt_order(ASK2, "writer-b", SELL_S, "1", "102"));
    let bid = submit(&mut book, &opt_order(TAKE, "holder", BUY, "3", "99"));
    let amended = book.amend(
        &patch(TAKE, version(&bid), Some("100"), Some(EXPIRY), Some("102")),
        None,
    );
    assert!(amended.accepted);
    assert_eq!(amended.fills.len(), 2);
    assert_eq!(format_amount(amended.fills[0].qty), "1");
    assert_eq!(format_amount(amended.fills[0].price), "101");
    assert_eq!(format_amount(amended.fills[1].qty), "1");
    assert_eq!(format_amount(amended.fills[1].price), "102");
    assert_eq!(
        format_amount(amended.resting.as_ref().unwrap().remaining),
        "1"
    );

    let ex = submit(&mut book, &exer(EXER, "holder", BUY, "2"));
    assert!(ex.accepted);
    assert_eq!(ex.fills.len(), 2);
    assert_eq!(format_amount(ex.fills[0].qty), "1");
    assert_eq!(format_amount(ex.fills[0].price), "100");
    assert_eq!(format_amount(ex.fills[1].qty), "1");
    assert_eq!(format_amount(ex.fills[1].price), "100");

    let again = submit(&mut book, &exer(EXER2, "holder", BUY, "1"));
    assert!(!again.accepted);
    assert_eq!(code(&again), Some("position_flat"));
}

// ── option-cancel.test.ts ───────────────────────────────────────────────

/// The cancel `order({ id, type: 'limit', side: 'buy', qty: '2', cancel: true })`, before strike and expiry.
fn pull(id: &str) -> EngineOrder {
    cancel(order(id, "desk", LIMIT, BUY, "2", None))
}

#[test]
fn cancel_unfilled_remainder_leaves_the_book() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    assert!(rest.accepted);
    assert_eq!(bids(&book), lv(&[("99", "2")]));

    let pulled = submit(&mut book, &opt(pull(OPT), "100", EXPIRY));
    assert!(pulled.accepted);
    assert!(pulled.resting.is_none());
    assert!(pulled.fills.is_empty());
    assert!(reasons(&pulled.cancellations).contains(&(OPT.to_owned(), "requested".to_owned())));
    assert_eq!(remaining_of(&pulled.cancellations, OPT), "2");
    assert_eq!(bids(&book), none());
}

#[test]
fn cancel_refuses_a_missing_strike_still_on_the_book_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    rest_bid(&mut book);
    let mut o = mark(pull(OPT), "50");
    o.expiry = Opt::Some(EXPIRY.to_owned());
    let pulled = submit(&mut book, &o);
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some(STRIKE_MISSING));
    assert!(pulled.cancellations.is_empty());
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn cancel_refuses_a_missing_expiry_still_on_the_book_no_invented_mark() {
    let mut book = OrderBook::new(MARKET);
    rest_bid(&mut book);
    let mut o = mark(pull(OPT), "50");
    o.strike = Opt::Some(a("100"));
    let pulled = submit(&mut book, &o);
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some(EXPIRY_MISSING));
    assert!(pulled.cancellations.is_empty());
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn cancel_a_supplied_mark_is_ignored_cancel_still_names_strike_and_expiry() {
    let mut book = OrderBook::new(MARKET);
    rest_bid(&mut book);
    let pulled = submit(&mut book, &mark(opt(pull(OPT), "100", EXPIRY), "50"));
    assert!(pulled.accepted);
    assert!(reasons(&pulled.cancellations).contains(&(OPT.to_owned(), "requested".to_owned())));
    assert_eq!(bids(&book), none());
}

#[test]
fn cancel_refuses_when_strike_disagrees_do_not_cancel_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    rest_bid(&mut book);
    let pulled = submit(&mut book, &opt(pull(OPT), "105", EXPIRY));
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some(STRIKE_DISAGREES));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn cancel_refuses_when_expiry_disagrees_do_not_cancel_a_different_contract() {
    let mut book = OrderBook::new(MARKET);
    rest_bid(&mut book);
    let pulled = submit(&mut book, &opt(pull(OPT), "100", OTHER));
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some(EXPIRY_DISAGREES));
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn cancel_refuses_when_nothing_is_resting_no_invented_cancel() {
    let mut book = OrderBook::new(MARKET);
    let pulled = submit(&mut book, &opt(pull(MISS), "100", EXPIRY));
    assert!(!pulled.accepted);
    assert_eq!(code(&pulled), Some("order_not_found"));
    assert!(pulled.cancellations.is_empty());
    assert_eq!(bids(&book), none());
}

// ── option-expire.test.ts ───────────────────────────────────────────────

const DUE_REST: &str = "66666666-6666-4666-8666-666666666666";
const LIVE: &str = "77777777-7777-4777-8777-777777777777";
const TAKER: &str = "88888888-8888-4888-8888-888888888888";
const EXER_E: &str = "99999999-9999-4999-8999-999999999999";
const GTD: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOON: &str = "2026-09-01T00:00:00.000Z";
const BEFORE: &str = "2026-06-01T00:00:00.000Z";
const MID: &str = "2026-10-01T00:00:00.000Z";
const AT: &str = "2026-12-31T00:00:00.000Z";
const AFTER: &str = "2027-01-01T00:00:00.000Z";
const GTD_AT: &str = "2026-09-15T00:00:00.000Z";

#[test]
fn expire_unfilled_remainder_leaves_the_book_at_expiry() {
    let mut book = OrderBook::new(MARKET);
    let rest = book.submit(
        &opt(
            order(OPT, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
        at(BEFORE),
    );
    assert!(rest.accepted);
    rests_on_book(&rest, OPT);
    assert_eq!(bids(&book), lv(&[("99", "2")]));

    let later = book.submit(&plain(PLAIN, "desk", SELL_S, "1", "101"), at(AT));
    assert!(later.accepted);
    assert!(reasons(&later.cancellations).contains(&(OPT.to_owned(), "expired".to_owned())));
    assert_eq!(remaining_of(&later.cancellations, OPT), "2");
    assert_eq!(bids(&book), none());
    assert_eq!(asks(&book), lv(&[("101", "1")]));
}

#[test]
fn expire_a_rest_already_past_expiry_leaves_immediately() {
    let mut book = OrderBook::new(MARKET);
    let rest = book.submit(
        &opt(
            order(OPT, "desk", LIMIT, BUY, "2", Some("99")),
            "100",
            EXPIRY,
        ),
        at(AFTER),
    );
    assert!(rest.accepted);
    assert!(rest.resting.is_none());
    assert!(reasons(&rest.cancellations).contains(&(OPT.to_owned(), "expired".to_owned())));
    assert_eq!(remaining_of(&rest.cancellations, OPT), "2");
    assert_eq!(bids(&book), none());
}

#[test]
fn expire_partial_take_then_expiry_remaining_qty_leaves() {
    let mut book = OrderBook::new(MARKET);
    book.submit(&opt_order(OPT, "writer", SELL_S, "2", "99"), at(BEFORE));
    let take = book.submit(&opt_order(TAKE, "holder", BUY, "1", "99"), at(BEFORE));
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(asks(&book), lv(&[("99", "1")]));

    let later = book.submit(&plain(PLAIN, "desk", BUY, "1", "90"), at(AT));
    assert!(reasons(&later.cancellations).contains(&(OPT.to_owned(), "expired".to_owned())));
    assert_eq!(remaining_of(&later.cancellations, OPT), "1");
    assert_eq!(asks(&book), none());
}

#[test]
fn expire_refuses_a_missing_expiry_no_invented_expiry_from_a_mark() {
    let mut book = OrderBook::new(MARKET);
    for e in [None, Some(""), Some("   ")] {
        let o = mark(
            expiry(
                strike(
                    order(MISS, "desk", LIMIT, BUY, "2", Some("99")),
                    Some("100"),
                ),
                e,
            ),
            "50",
        );
        let result = book.submit(&o, at(AFTER));
        assert!(!result.accepted);
        assert_eq!(code(&result), Some(EXPIRY_MISSING));
        assert!(result.resting.is_none());
        assert!(result.cancellations.is_empty());
    }
    assert_eq!(bids(&book), none());
}

#[test]
fn expire_a_supplied_mark_is_not_an_expiry_rest_stays_until_expiry() {
    let mut book = OrderBook::new(MARKET);
    let rest = book.submit(
        &mark(
            opt(
                order(OPT, "desk", LIMIT, BUY, "2", Some("99")),
                "100",
                EXPIRY,
            ),
            "50",
        ),
        at(BEFORE),
    );
    assert!(rest.accepted);
    rests_on_book(&rest, OPT);
    assert!(rest.cancellations.is_empty());
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

#[test]
fn expire_a_due_option_taker_does_not_print() {
    let mut book = OrderBook::new(MARKET);
    book.submit(
        &opt(
            order(DUE_REST, "writer", LIMIT, SELL_S, "2", Some("98")),
            "100",
            SOON,
        ),
        at(BEFORE),
    );
    book.submit(
        &tif(plain(GTD, "maker", SELL_S, "1", "97"), Tif::Gtd, GTD_AT),
        at(BEFORE),
    );
    let live = book.submit(&opt_order(LIVE, "writer", SELL_S, "2", "99"), at(BEFORE));
    assert!(live.accepted);
    rests_on_book(&live, LIVE);

    let take = book.submit(
        &opt(
            order(TAKER, "holder", LIMIT, BUY, "2", Some("99")),
            "100",
            SOON,
        ),
        at(MID),
    );
    assert!(take.accepted);
    assert!(take.fills.is_empty());
    assert!(take.resting.is_none());
    assert_eq!(
        reasons(&take.cancellations),
        pairs(&[(DUE_REST, "expired"), (GTD, "expired"), (TAKER, "expired")])
    );
    assert_eq!(remaining_of(&take.cancellations, TAKER), "2");
    assert_eq!(asks(&book), lv(&[("99", "2")]));
    assert_eq!(level_ids(&book, "asks")[0], ids(&[LIVE]));
    assert_eq!(positions(&book), Json::Array(Vec::new()));

    let mut ex = exercise(order(EXER_E, "holder", LIMIT, BUY, "2", None));
    ex = opt(ex, "100", SOON);
    let ex = book.submit(&ex, at(MID));
    assert!(!ex.accepted);
    assert_eq!(code(&ex), Some("position_flat"));
    assert!(ex.fills.is_empty());
    assert_eq!(asks(&book), lv(&[("99", "2")]));

    let mut at_book = OrderBook::new(MARKET);
    at_book.submit(&opt_order(LIVE, "writer", SELL_S, "1", "99"), at(BEFORE));
    let exact = at_book.submit(&opt_order(TAKER, "holder", BUY, "1", "99"), at(AT));
    assert!(exact.fills.is_empty());
    assert!(exact.resting.is_none());
    assert_eq!(
        reasons(&exact.cancellations),
        pairs(&[(LIVE, "expired"), (TAKER, "expired")])
    );
    assert_eq!(asks(&at_book), none());
    assert_eq!(positions(&at_book), Json::Array(Vec::new()));
}

#[test]
fn expire_an_option_that_is_not_yet_due_still_prints() {
    let mut book = OrderBook::new(MARKET);
    book.submit(&opt_order(OPT, "writer", SELL_S, "2", "99"), at(BEFORE));
    let take = book.submit(&opt_order(TAKE, "holder", BUY, "2", "99"), at(BEFORE));
    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, OPT);
    assert_eq!(take.fills[0].taker_order_id, TAKE);
    assert_eq!(format_amount(take.fills[0].qty), "2");
    assert_eq!(asks(&book), none());

    let ex = book.submit(&exer(EXER_E, "holder", SELL_S, "2"), at(BEFORE));
    assert!(ex.accepted);
    assert_eq!(ex.fills.len(), 1);
    assert_eq!(format_amount(ex.fills[0].price), "100");
}

#[test]
fn expire_cancels_a_due_rest_before_a_strike_or_expiry_disagreement_returns() {
    let mut book = OrderBook::new(MARKET);
    book.submit(
        &opt(
            order(DUE_REST, "writer", LIMIT, SELL_S, "2", Some("98")),
            "100",
            SOON,
        ),
        at(BEFORE),
    );
    book.submit(
        &opt(
            order(LIVE, "writer", LIMIT, SELL_S, "1", Some("99")),
            "110",
            EXPIRY,
        ),
        at(BEFORE),
    );

    let take = book.submit(
        &opt(
            order(TAKER, "holder", LIMIT, BUY, "1", Some("99")),
            "105",
            EXPIRY,
        ),
        at(MID),
    );
    assert!(!take.accepted);
    assert_eq!(code(&take), Some(STRIKE_DISAGREES));
    assert!(take.fills.is_empty());
    assert_eq!(
        reasons(&take.cancellations),
        pairs(&[(DUE_REST, "expired")])
    );
    assert_eq!(remaining_of(&take.cancellations, DUE_REST), "2");
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    assert_eq!(side_ids(&book, "asks"), ids(&[LIVE]));

    let later = book.submit(
        &opt(
            order(OPT, "holder", LIMIT, BUY, "1", Some("98")),
            "105",
            EXPIRY,
        ),
        at(MID),
    );
    assert!(later.accepted);
    assert!(later.fills.is_empty());
    assert!(later.cancellations.is_empty());
    rests_on_book(&later, OPT);
    assert_eq!(bids(&book), lv(&[("98", "1")]));
    assert_eq!(asks(&book), lv(&[("99", "1")]));
    let mut both = side_ids(&book, "bids");
    both.extend(side_ids(&book, "asks"));
    assert_eq!(both, ids(&[OPT, LIVE]));

    let mut early = OrderBook::new(MARKET);
    early.submit(&opt_order(LIVE, "desk", SELL_S, "2", "99"), at(BEFORE));
    let disagree = early.submit(
        &opt(
            order(TAKE, "desk", LIMIT, BUY, "2", Some("99")),
            "105",
            EXPIRY,
        ),
        at(BEFORE),
    );
    assert!(!disagree.accepted);
    assert_eq!(code(&disagree), Some(STRIKE_DISAGREES));
    assert!(disagree.fills.is_empty());
    assert!(disagree.cancellations.is_empty());
    assert_eq!(asks(&early), lv(&[("99", "2")]));
    assert_eq!(level_ids(&early, "asks")[0], ids(&[LIVE]));

    let mut quiet = OrderBook::new(MARKET);
    submit(
        &mut quiet,
        &opt(
            order(DUE_REST, "desk", LIMIT, SELL_S, "2", Some("98")),
            "100",
            SOON,
        ),
    );
    let blocked = submit(
        &mut quiet,
        &opt(
            order(TAKER, "desk", LIMIT, BUY, "1", Some("99")),
            "105",
            EXPIRY,
        ),
    );
    assert!(!blocked.accepted);
    assert_eq!(code(&blocked), Some(STRIKE_DISAGREES));
    assert!(blocked.cancellations.is_empty());
    assert_eq!(asks(&quiet), lv(&[("98", "2")]));
    assert_eq!(level_ids(&quiet, "asks")[0], ids(&[DUE_REST]));
}

#[test]
fn expire_omitted_now_does_not_expire_the_engine_does_not_invent_a_clock() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    assert!(rest.accepted);
    rests_on_book(&rest, OPT);
    let later = submit(&mut book, &plain(PLAIN, "desk", SELL_S, "1", "101"));
    assert!(later.cancellations.is_empty());
    assert_eq!(bids(&book), lv(&[("99", "2")]));
}

// ── option-replace.test.ts ──────────────────────────────────────────────

#[test]
fn replace_native_amend_of_price_and_qty_together_is_one_command_priority_lost() {
    let mut book = OrderBook::new(MARKET);
    let rest = rest_bid(&mut book);
    let mut cmd = patch(OPT, version(&rest), Some("100"), Some(EXPIRY), Some("101"));
    cmd.qty = Some(a("3"));
    let amended = book.amend(&cmd, None);
    assert!(amended.accepted);
    assert_eq!(amended.priority, Some(Priority::Lost));
    let resting = amended.resting.as_ref().unwrap();
    assert_eq!(format_amount(resting.price), "101");
    assert_eq!(format_amount(resting.remaining), "3");
    assert_eq!(bids(&book), lv(&[("101", "3")]));
}

// ── option.router.test.ts ───────────────────────────────────────────────

const SECRET: &str = "matching-option-router-secret-32chxxxx";
const ROUTER_MARKET: &str = "BTC-USDT";
/// The wire replay's frozen clock, 2026-11-19T00:00:00.000Z, at which its recorded lifecycle proof was checked.
const NOW_SECONDS: i64 = 1_795_046_400;

fn now_ms() -> i64 {
    NOW_SECONDS * 1000
}

/// `mount()`: an engine over a memory journal and bus, no snapshots, behind the door with body binding required.
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

/// The lifecycle admission proof `createMarketLifecycleAdmissionProof` makes for an OPEN BTC-USDT, as recorded by the
/// wire replay's matrix (`fixtures/requests.json`, the `orders-submit` `valid` body).
fn proof() -> Json {
    let doc = json::parse(include_str!("fixtures/requests.json")).unwrap();
    for r in array(doc.get("requests")) {
        if text(r.get("file")) == "orders-submit" && text(r.get("input")) == "valid" {
            let body = json::parse(&text(r.get("body"))).unwrap();
            return body.get("lifecycleProof").unwrap().clone();
        }
    }
    panic!("the matrix records a valid submit")
}

/// `submitBody(over)`: the option submit, with its strike and expiry as given (`Json::Null` is `null`).
fn submit_body(strike: Json, expiry: Json) -> String {
    Json::obj([
        ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
        ("accountId", Json::str("desk")),
        ("type", Json::str("limit")),
        ("side", Json::str("buy")),
        ("qty", Json::str("2")),
        ("price", Json::str("99")),
        ("tif", Json::str("GTC")),
        ("strike", strike),
        ("expiry", expiry),
        ("lifecycleProof", proof()),
    ])
    .compact()
}

/// `post(app, body)`: signed by svc-trade with the body bound; the status and the parsed answer.
fn post(door: &MatchingDoor, payload: &str) -> (u16, Json) {
    let headers = {
        let mut h = vec![("content-type".to_owned(), "application/json".to_owned())];
        h.extend(s2s::legacy_headers("svc-trade", SECRET, payload, NOW_SECONDS).unwrap());
        h
    };
    let url = format!("/markets/{ROUTER_MARKET}/orders");
    match door.decide(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: payload,
    }) {
        Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
        Outcome::Owed(slice) => panic!("the submit door is owed by {}", slice.name()),
    }
}

fn engine_bids(door: &MatchingDoor) -> Vec<(String, String)> {
    door.engine()
        .depth(ROUTER_MARKET, 50)
        .map(|d| ladder(&d.bids))
        .unwrap_or_default()
}

#[test]
fn router_200_accepted_rests_on_the_public_book() {
    let door = mount();
    let (status, body) = post(&door, &submit_body(Json::str("100"), Json::str(EXPIRY)));
    assert_eq!(status, 200);
    assert_eq!(body.get("accepted"), Some(&Json::Bool(true)));
    assert_eq!(
        body.get("resting").and_then(|r| r.get("kind")),
        Some(&Json::str("book"))
    );
    assert_eq!(engine_bids(&door), lv(&[("99", "2")]));
}

#[test]
fn router_missing_strike_refuses() {
    let door = mount();
    let (status, body) = post(&door, &submit_body(Json::Null, Json::str(EXPIRY)));
    assert_eq!(status, 200);
    assert_eq!(body.get("accepted"), Some(&Json::Bool(false)));
    assert_eq!(
        body.get("rejected").and_then(|r| r.get("code")),
        Some(&Json::str("missing_strike"))
    );
    assert_eq!(engine_bids(&door), none());
}

#[test]
fn router_missing_expiry_refuses() {
    let door = mount();
    let (status, body) = post(&door, &submit_body(Json::str("100"), Json::Null));
    assert_eq!(status, 200);
    assert_eq!(body.get("accepted"), Some(&Json::Bool(false)));
    assert_eq!(
        body.get("rejected").and_then(|r| r.get("code")),
        Some(&Json::str("missing_expiry"))
    );
    assert_eq!(engine_bids(&door), none());
}

#[test]
fn router_omitted_mark_is_fine_do_not_require_a_mark() {
    let door = mount();
    let payload = submit_body(Json::str("100"), Json::str(EXPIRY));
    let sent = json::parse(&payload).unwrap();
    assert!(sent.get("mark").is_none());
    let (status, body) = post(&door, &payload);
    assert_eq!(status, 200);
    assert_eq!(body.get("accepted"), Some(&Json::Bool(true)));
    assert_eq!(engine_bids(&door), lv(&[("99", "2")]));
}
