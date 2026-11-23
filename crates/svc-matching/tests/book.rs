//! The order book, test for test: `services/svc-matching/src/engine/book.test.ts`, `book-clone.test.ts`,
//! `book-l2-depth-unset-refuse.test.ts` (the book's part) and `depth-memo.test.ts`, ported onto the Rust
//! `OrderBook`. Same inputs, same expected values. A TypeScript test that reads the TypeScript source, or an
//! engine-level wrapper the Rust book does not carry, is not ported here; the depth window a TypeScript caller could
//! leave unset is a required `usize` in Rust, so its "unset refuses" tests are held by the type.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicUsize, Ordering};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul, mul_div, parse_amount};
use service_kit::time::v8_date_parse;
use svc_matching::book::OrderBook;
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, Opt, OrderType, Priority, RestKind, Side, SubmitResult,
    Tif, TriggerBy,
};

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

static IDS: AtomicUsize = AtomicUsize::new(0);

fn next_id() -> String {
    let n = IDS.fetch_add(1, Ordering::SeqCst) + 1;
    format!("ord-{n:04}")
}

/// `OrderSpec` in book.test.ts: what a test names; the rest defaults the way `order()` defaults it.
#[derive(Default, Clone)]
struct Spec {
    id: Option<&'static str>,
    account: Option<&'static str>,
    ty: Option<OrderType>,
    side: Option<Side>,
    qty: &'static str,
    price: Option<&'static str>,
    stop_price: Option<&'static str>,
    tif: Option<Tif>,
    expire_at: Option<&'static str>,
    min_qty: Option<&'static str>,
    reduce_only: bool,
    oco: Option<&'static str>,
}

fn spec(side: Side, qty: &'static str) -> Spec {
    Spec {
        side: Some(side),
        qty,
        ..Spec::default()
    }
}

impl Spec {
    fn id(mut self, v: &'static str) -> Spec {
        self.id = Some(v);
        self
    }
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
    fn expire(mut self, v: &'static str) -> Spec {
        self.expire_at = Some(v);
        self
    }
    fn min_qty(mut self, v: &'static str) -> Spec {
        self.min_qty = Some(v);
        self
    }
    fn reduce_only(mut self) -> Spec {
        self.reduce_only = true;
        self
    }
    fn oco(mut self, v: &'static str) -> Spec {
        self.oco = Some(v);
        self
    }
}

/// `order(spec)`: the type is market when no price is named, limit otherwise.
fn order(s: &Spec) -> EngineOrder {
    let ty = s.ty.unwrap_or(if s.price.is_none() {
        OrderType::Market
    } else {
        OrderType::Limit
    });
    let mut o = EngineOrder::new(
        s.id.map_or_else(next_id, str::to_owned),
        s.account.unwrap_or("acct-default"),
        ty,
        s.side.unwrap(),
        a(s.qty),
        s.price.map(a),
        s.tif.unwrap_or(Tif::Gtc),
    );
    o.stop_price = s.stop_price.map(a);
    o.expire_at = s.expire_at.map(str::to_owned);
    if let Some(m) = s.min_qty {
        o.min_qty = Opt::Some(a(m));
    }
    o.reduce_only = s.reduce_only;
    o.oco_sibling_id = s.oco.map(str::to_owned);
    o
}

/// `seed`: every helper submit must be accepted.
fn seed(book: &mut OrderBook, s: Spec) -> SubmitResult {
    let result = book.submit(&order(&s), None);
    assert!(
        result.accepted,
        "seed order rejected: {:?}",
        result.rejected.as_ref().map(|r| r.code.clone())
    );
    result
}

fn submit(book: &mut OrderBook, s: Spec) -> SubmitResult {
    book.submit(&order(&s), None)
}

fn submit_at(book: &mut OrderBook, s: Spec, now: i64) -> SubmitResult {
    book.submit(&order(&s), Some(now))
}

fn fill_prices(r: &SubmitResult) -> Vec<String> {
    r.fills.iter().map(|x| f(x.price)).collect()
}

fn fill_qtys(r: &SubmitResult) -> Vec<String> {
    r.fills.iter().map(|x| f(x.qty)).collect()
}

fn makers(r: &SubmitResult) -> Vec<String> {
    r.fills.iter().map(|x| x.maker_order_id.clone()).collect()
}

fn code(r: Option<&svc_matching::book::types::Reject>) -> Option<String> {
    r.map(|x| x.code.clone())
}

/// One side of `depth(limit)` as the TypeScript's decimal-string tuples.
fn bids(book: &OrderBook, limit: usize) -> Vec<(String, String)> {
    book.depth(limit)
        .0
        .into_iter()
        .map(|(p, q)| (f(p), f(q)))
        .collect()
}

fn asks(book: &OrderBook, limit: usize) -> Vec<(String, String)> {
    book.depth(limit)
        .1
        .into_iter()
        .map(|(p, q)| (f(p), f(q)))
        .collect()
}

fn lvl(p: &str, q: &str) -> (String, String) {
    (p.to_owned(), q.to_owned())
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

// ── toState readers ────────────────────────────────────────────────────

fn arr(j: &Json) -> &Vec<Json> {
    match j {
        Json::Array(v) => v,
        other => panic!("not an array: {}", other.compact()),
    }
}

fn state_list(book: &OrderBook, key: &str) -> Vec<Json> {
    arr(book.to_state().get(key).unwrap()).clone()
}

/// `toState()[side][0].orders[0]`.
fn first_rest(book: &OrderBook, side: &str) -> Json {
    let levels = state_list(book, side);
    arr(levels[0].get("orders").unwrap())[0].clone()
}

fn s(j: &Json, key: &str) -> Option<String> {
    match j.get(key) {
        Some(Json::String(v)) => Some(v.clone()),
        Some(other) => panic!("{key} is not a string: {}", other.compact()),
        None => None,
    }
}

/// `toMatchObject`: each named key holds exactly this value.
fn matches(j: &Json, fields: &[(&str, Json)]) {
    for (k, v) in fields {
        assert_eq!(j.get(k), Some(v), "{k} in {}", j.compact());
    }
}

fn js(v: &str) -> Json {
    Json::str(v)
}

fn jn(n: i64) -> Json {
    Json::int(n)
}

/// `toState().positions` as `(accountId, qty)` pairs.
fn positions(book: &OrderBook) -> Vec<(String, String)> {
    book.to_state()
        .get("positions")
        .map(|p| {
            arr(p)
                .iter()
                .map(|row| (s(row, "accountId").unwrap(), s(row, "qty").unwrap()))
                .collect()
        })
        .unwrap_or_default()
}

fn pos(acct: &str, qty: &str) -> (String, String) {
    (acct.to_owned(), qty.to_owned())
}

// ── Price-time priority ─────────────────────────────────────────────────

#[test]
fn fills_the_earliest_order_first_when_prices_are_equal() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("first").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("second").acct("b").price("100"),
    );

    let result = submit(&mut book, spec(Side::Sell, "1").acct("taker").price("100"));

    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, "first");
}

#[test]
fn fills_the_better_price_first_regardless_of_arrival_order() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("worse").acct("a").price("99"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("better").acct("b").price("101"),
    );

    let result = submit(&mut book, spec(Side::Sell, "2").acct("taker").price("99"));

    assert_eq!(makers(&result), strs(&["better", "worse"]));
    assert_eq!(fill_prices(&result), strs(&["101", "99"]));
}

#[test]
fn ranks_the_ask_side_the_other_way_lowest_price_is_best() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "1").acct("a").price("105"));
    seed(&mut book, spec(Side::Sell, "1").acct("b").price("103"));
    seed(&mut book, spec(Side::Sell, "1").acct("c").price("104"));

    assert_eq!(f(book.best_ask().unwrap()), "103");
    let result = submit(&mut book, spec(Side::Buy, "3").acct("taker").price("105"));
    assert_eq!(fill_prices(&result), strs(&["103", "104", "105"]));
}

#[test]
fn a_resting_order_keeps_its_place_in_the_queue_after_a_partial_fill() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "5").id("front").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "5").id("back").acct("b").price("100"),
    );

    submit(&mut book, spec(Side::Buy, "2").acct("taker").price("100"));
    let second = submit(&mut book, spec(Side::Buy, "4").acct("taker2").price("100"));

    assert_eq!(makers(&second), strs(&["front", "back"]));
    assert_eq!(fill_qtys(&second), strs(&["3", "1"]));
}

// ── Resting, partials, and levels ───────────────────────────────────────

#[test]
fn rests_a_non_crossing_limit_order_and_reports_it() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(
        &mut book,
        spec(Side::Buy, "2.5").id("maker").acct("a").price("99.5"),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    let resting = result.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Book);
    assert_eq!(resting.order_id, "maker");
    assert_eq!(f(resting.remaining), "2.5");
    assert_eq!(f(book.best_bid().unwrap()), "99.5");
}

#[test]
fn fills_what_it_can_and_rests_the_exact_remainder() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "3").acct("a").price("100"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "10").id("taker").acct("b").price("100"),
    );

    assert_eq!(fill_qtys(&result), strs(&["3"]));
    assert_eq!(f(result.resting.as_ref().unwrap().remaining), "7");
    assert_eq!(book.best_ask(), None);
    assert_eq!(f(book.best_bid().unwrap()), "100");
}

#[test]
fn removes_a_price_level_that_empties_exactly_and_the_next_level_becomes_best() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Buy, "2").acct("a").price("100"));
    seed(&mut book, spec(Side::Buy, "3").acct("a").price("99"));

    let result = submit(&mut book, spec(Side::Sell, "2").acct("taker").price("100"));

    assert_eq!(fill_qtys(&result), strs(&["2"]));
    assert_eq!(f(book.best_bid().unwrap()), "99");
    assert_eq!(bids(&book, 50), vec![lvl("99", "3")]);
}

#[test]
fn empties_two_levels_exactly_in_one_sweep() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Buy, "2").acct("a").price("100"));
    seed(&mut book, spec(Side::Buy, "3").acct("a").price("99"));

    let result = submit(&mut book, spec(Side::Sell, "5").acct("taker").price("99"));

    assert_eq!(fill_qtys(&result), strs(&["2", "3"]));
    assert_eq!(book.best_bid(), None);
    assert_eq!(bids(&book, 50), Vec::<(String, String)>::new());
}

#[test]
fn carries_18_decimal_places_through_a_fill_without_losing_a_unit() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "0.000000000000000003")
            .acct("a")
            .price("0.000000000000000001"),
    );

    let result = submit(
        &mut book,
        spec(Side::Buy, "0.000000000000000002")
            .acct("b")
            .price("0.000000000000000001"),
    );

    assert_eq!(fill_qtys(&result), strs(&["0.000000000000000002"]));
    assert_eq!(fill_prices(&result), strs(&["0.000000000000000001"]));
    assert_eq!(
        asks(&book, 50),
        vec![lvl("0.000000000000000001", "0.000000000000000001")]
    );
}

// ── Market orders ───────────────────────────────────────────────────────

#[test]
fn into_an_empty_book_accepted_nothing_filled_whole_quantity_cancelled() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(&mut book, spec(Side::Buy, "5").id("lonely").acct("a"));

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(result.resting, None);
    assert_eq!(result.cancellations.len(), 1);
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::MarketRemainder
    );
    assert_eq!(f(result.cancellations[0].remaining_qty), "5");
    assert_eq!(bids(&book, 50), Vec::<(String, String)>::new());
}

#[test]
fn exhausts_the_book_and_cancels_what_it_could_not_take() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "1").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("101"));

    let result = submit(&mut book, spec(Side::Buy, "10").acct("taker"));

    assert_eq!(fill_qtys(&result), strs(&["1", "2"]));
    assert_eq!(f(result.cancellations[0].remaining_qty), "7");
    assert_eq!(book.best_ask(), None);
}

#[test]
fn crosses_multiple_levels_at_each_level_price_and_the_weighted_average_is_exact() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "1").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("101"));
    seed(&mut book, spec(Side::Sell, "3").acct("mm").price("102"));

    let result = submit(&mut book, spec(Side::Buy, "5").acct("taker"));

    assert_eq!(fill_prices(&result), strs(&["100", "101", "102"]));
    assert_eq!(fill_qtys(&result), strs(&["1", "2", "2"]));

    let notional: Amount = result.fills.iter().fold(Amount::ZERO, |t, x| {
        t.checked_add(mul(x.price, x.qty)).unwrap()
    });
    let quantity: Amount = result
        .fills
        .iter()
        .fold(Amount::ZERO, |t, x| t.checked_add(x.qty).unwrap());
    assert_eq!(f(notional), "506");
    assert_eq!(f(quantity), "5");
    // `div(notional, quantity)`: divideScaled(a * SCALE, b, 'half-up').
    assert_eq!(
        f(mul_div(notional, a("1"), quantity, Rounding::HalfUp)),
        "101.2"
    );

    assert_eq!(asks(&book, 50), vec![lvl("102", "1")]);
}

#[test]
fn ignores_gtc_on_a_market_order_it_can_never_rest() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(&mut book, spec(Side::Sell, "1").acct("a").tif(Tif::Gtc));

    assert!(result.accepted);
    assert_eq!(result.resting, None);
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::MarketRemainder
    );
}

// ── Time in force ───────────────────────────────────────────────────────

#[test]
fn ioc_fills_what_it_can_and_cancels_the_remainder_rather_than_resting() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "5")
            .id("ioc")
            .acct("taker")
            .price("100")
            .tif(Tif::Ioc),
    );

    assert_eq!(fill_qtys(&result), strs(&["2"]));
    assert_eq!(result.resting, None);
    assert_eq!(result.cancellations.len(), 1);
    assert_eq!(result.cancellations[0].order_id, "ioc");
    assert_eq!(result.cancellations[0].reason, CancelReason::IocRemainder);
    assert_eq!(f(result.cancellations[0].remaining_qty), "3");
    assert_eq!(book.best_bid(), None);
}

#[test]
fn ioc_that_cannot_touch_the_book_at_all_cancels_in_full() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("105"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "5")
            .acct("taker")
            .price("100")
            .tif(Tif::Ioc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(f(result.cancellations[0].remaining_qty), "5");
}

#[test]
fn fok_rejects_entirely_when_it_cannot_fill_completely_not_one_unit_trades() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    let before = book.serialize();

    let result = submit(
        &mut book,
        spec(Side::Buy, "5")
            .acct("taker")
            .price("100")
            .tif(Tif::Fok),
    );

    assert!(!result.accepted);
    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("fok_unfillable")
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(result.cancellations.len(), 0);
    assert_eq!(book.serialize(), before);
}

#[test]
fn fok_fills_completely_when_the_depth_is_there_across_levels() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "3").acct("mm").price("101"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "5")
            .acct("taker")
            .price("101")
            .tif(Tif::Fok),
    );

    assert!(result.accepted);
    assert_eq!(fill_qtys(&result), strs(&["2", "3"]));
    assert_eq!(result.resting, None);
    assert_eq!(result.cancellations.len(), 0);
}

#[test]
fn fok_respects_its_limit_price_when_deciding_it_cannot_fill() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "3").acct("mm").price("101"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "5")
            .acct("taker")
            .price("100")
            .tif(Tif::Fok),
    );

    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("fok_unfillable")
    );
}

#[test]
fn post_only_that_would_cross_is_rejected_and_never_fills() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    let before = book.serialize();

    let result = submit(
        &mut book,
        spec(Side::Buy, "1").acct("taker").price("100").tif(Tif::Po),
    );

    assert!(!result.accepted);
    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("post_only_would_cross")
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(result.resting, None);
    assert_eq!(book.serialize(), before);
}

#[test]
fn post_only_rests_when_it_stays_behind_the_spread() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));

    let result = submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("po")
            .acct("taker")
            .price("99.99")
            .tif(Tif::Po),
    );

    assert!(result.accepted);
    let resting = result.resting.as_ref().unwrap();
    assert_eq!(resting.order_id, "po");
    assert_eq!(resting.kind, RestKind::Book);
    assert_eq!(f(book.best_bid().unwrap()), "99.99");
}

#[test]
fn post_only_on_an_order_that_cannot_rest_is_refused_rather_than_reinterpreted() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(&mut book, spec(Side::Buy, "1").acct("a").tif(Tif::Po));
    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("invalid_tif")
    );
}

// ── Self-trade prevention ───────────────────────────────────────────────

#[test]
fn never_lets_one_account_be_both_sides_of_a_fill() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("own").acct("same").price("100"),
    );

    let result = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id("aggressor")
            .acct("same")
            .price("100"),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    for fill in &result.fills {
        assert_ne!(fill.maker_account_id, fill.taker_account_id);
    }
}

#[test]
fn expires_the_resting_maker_and_continues_the_taker_cancel_resting() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("own").acct("same").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1")
            .id("other")
            .acct("stranger")
            .price("100"),
    );

    let result = submit(
        &mut book,
        spec(Side::Sell, "2")
            .id("aggressor")
            .acct("same")
            .price("100"),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, "other");
    assert_eq!(result.fills[0].maker_account_id, "stranger");
    assert_eq!(result.cancellations.len(), 1);
    assert_eq!(result.cancellations[0].order_id, "own");
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert_eq!(result.resting.as_ref().unwrap().order_id, "aggressor");
    assert_eq!(f(book.best_ask().unwrap()), "100");
    assert_eq!(book.best_bid(), None);
}

#[test]
fn fok_that_cannot_fill_without_self_liquidity_is_unfillable_book_unchanged() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "3").id("own").acct("same").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "1")
            .id("other")
            .acct("stranger")
            .price("100"),
    );
    let before = book.serialize();

    let result = submit(
        &mut book,
        spec(Side::Buy, "2").acct("same").price("100").tif(Tif::Fok),
    );

    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("fok_unfillable")
    );
    assert_eq!(book.serialize(), before);
}

#[test]
fn fok_with_enough_stranger_size_expires_own_rest_and_fills_the_stranger() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("own").acct("same").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "2")
            .id("other")
            .acct("stranger")
            .price("100"),
    );

    let result = submit(
        &mut book,
        spec(Side::Buy, "2")
            .id("aggressor")
            .acct("same")
            .price("100")
            .tif(Tif::Fok),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, "other");
    assert_eq!(f(result.fills[0].qty), "2");
    let cancelled: Vec<String> = result
        .cancellations
        .iter()
        .map(|c| c.order_id.clone())
        .collect();
    assert_eq!(cancelled, strs(&["own"]));
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    assert_eq!(result.resting, None);
}

#[test]
fn walks_past_own_rest_across_price_levels() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("own-100").acct("same").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1")
            .id("other-99")
            .acct("stranger")
            .price("99"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("own-98").acct("same").price("98"),
    );

    let result = submit(
        &mut book,
        spec(Side::Sell, "3").acct("same").price("98").tif(Tif::Ioc),
    );

    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, "other-99");
    let got: Vec<(String, CancelReason)> = result
        .cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason))
        .collect();
    assert_eq!(got.len(), 3);
    assert_eq!(
        got,
        vec![
            ("own-100".to_owned(), CancelReason::SelfTradePrevention),
            ("own-98".to_owned(), CancelReason::SelfTradePrevention),
            (
                result.cancellations[2].order_id.clone(),
                CancelReason::IocRemainder
            ),
        ]
    );
}

// ── Stops ───────────────────────────────────────────────────────────────

/// A book with resting asks and a last trade price of 100.
fn primed() -> OrderBook {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "10").acct("mm").price("106"));
    let warmup = submit(&mut book, spec(Side::Buy, "2").acct("warmup"));
    assert_eq!(f(warmup.fills[0].price), "100");
    book
}

#[test]
fn never_triggers_before_the_market_has_printed_a_price() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("stop")
            .acct("a")
            .ty(OrderType::Stop)
            .stop("1"),
    );

    assert!(result.accepted);
    let resting = result.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Stop);
    assert_eq!(resting.order_id, "stop");
    assert_eq!(result.fills.len(), 0);
}

#[test]
fn rests_in_the_stop_book_until_a_print_reaches_the_trigger() {
    let mut book = primed();
    let resting = submit(
        &mut book,
        spec(Side::Buy, "3")
            .id("stop")
            .acct("b")
            .ty(OrderType::Stop)
            .stop("105"),
    );

    assert_eq!(resting.resting.as_ref().unwrap().kind, RestKind::Stop);
    assert_eq!(resting.fills.len(), 0);

    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));

    assert_eq!(fill_prices(&trigger), strs(&["106"]));
    assert_eq!(trigger.triggered.len(), 1);
    assert_eq!(trigger.triggered[0].order_id, "stop");
    let qtys: Vec<String> = trigger.triggered[0]
        .fills
        .iter()
        .map(|x| f(x.qty))
        .collect();
    assert_eq!(qtys, strs(&["3"]));
    assert_eq!(f(trigger.triggered[0].fills[0].price), "106");
}

#[test]
fn a_triggered_stop_limit_rests_its_remainder_as_an_ordinary_limit_order() {
    let mut book = primed();
    submit(
        &mut book,
        spec(Side::Buy, "20")
            .id("sl")
            .acct("b")
            .ty(OrderType::StopLimit)
            .price("106")
            .stop("105"),
    );

    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));
    let outcome = &trigger.triggered[0];

    let qtys: Vec<String> = outcome.fills.iter().map(|x| f(x.qty)).collect();
    assert_eq!(qtys, strs(&["9"]));
    let resting = outcome.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Book);
    assert_eq!(resting.order_id, "sl");
    assert_eq!(f(resting.remaining), "11");
    assert_eq!(f(book.best_bid().unwrap()), "106");
}

#[test]
fn a_sell_stop_triggers_on_the_way_down() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Buy, "5").acct("mm").price("100"));
    seed(&mut book, spec(Side::Buy, "5").acct("mm").price("90"));
    submit(&mut book, spec(Side::Sell, "5").acct("warmup"));

    let resting = submit(
        &mut book,
        spec(Side::Sell, "2")
            .id("sl")
            .acct("b")
            .ty(OrderType::Stop)
            .stop("95"),
    );
    assert_eq!(resting.resting.as_ref().unwrap().kind, RestKind::Stop);

    let trigger = submit(&mut book, spec(Side::Sell, "1").acct("c"));
    let ids: Vec<String> = trigger
        .triggered
        .iter()
        .map(|t| t.order_id.clone())
        .collect();
    assert_eq!(ids, strs(&["sl"]));
}

#[test]
fn cascades_a_triggered_stop_prints_a_price_that_arms_the_next_one() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "5").acct("mm").price("110"));
    seed(&mut book, spec(Side::Sell, "5").acct("mm").price("120"));
    submit(&mut book, spec(Side::Buy, "2").acct("warmup"));

    submit(
        &mut book,
        spec(Side::Buy, "5")
            .id("stop-a")
            .acct("x")
            .ty(OrderType::Stop)
            .stop("105"),
    );
    submit(
        &mut book,
        spec(Side::Buy, "5")
            .id("stop-b")
            .acct("y")
            .ty(OrderType::Stop)
            .stop("115"),
    );

    let trigger = submit(&mut book, spec(Side::Buy, "5").acct("c"));

    let ids: Vec<String> = trigger
        .triggered
        .iter()
        .map(|t| t.order_id.clone())
        .collect();
    assert_eq!(ids, strs(&["stop-a", "stop-b"]));
    let prices: Vec<String> = trigger.triggered[0]
        .fills
        .iter()
        .map(|x| f(x.price))
        .collect();
    assert_eq!(prices, strs(&["120"]));
    assert_eq!(trigger.triggered[1].fills.len(), 0);
    assert_eq!(
        trigger.triggered[1].cancellations[0].reason,
        CancelReason::MarketRemainder
    );
}

#[test]
fn fires_the_older_stop_first_when_two_arm_on_the_same_print() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "10").acct("mm").price("110"));
    submit(&mut book, spec(Side::Buy, "2").acct("warmup"));

    submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("older")
            .acct("x")
            .ty(OrderType::Stop)
            .stop("105"),
    );
    submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("newer")
            .acct("y")
            .ty(OrderType::Stop)
            .stop("104"),
    );

    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));
    let ids: Vec<String> = trigger
        .triggered
        .iter()
        .map(|t| t.order_id.clone())
        .collect();
    assert_eq!(ids, strs(&["older", "newer"]));
}

fn po_stop() -> Spec {
    spec(Side::Buy, "5")
        .id("po-stop")
        .acct("b")
        .ty(OrderType::StopLimit)
        .price("106")
        .stop("105")
        .tif(Tif::Po)
}

#[test]
fn a_triggered_post_only_stop_limit_that_would_cross_is_rejected_not_filled() {
    let mut book = primed();
    submit(&mut book, po_stop());

    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));
    let outcome = &trigger.triggered[0];

    assert_eq!(
        code(outcome.rejected.as_ref()).as_deref(),
        Some("post_only_would_cross")
    );
    assert_eq!(outcome.fills.len(), 0);
    assert_eq!(
        outcome.cancellations[0].reason,
        CancelReason::TriggerRejected
    );
}

#[test]
fn a_trigger_rejected_stop_burns_one_sequence_the_cancel_not_two() {
    let mut book = primed();
    submit(&mut book, po_stop());
    let before = book.current_sequence();

    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));
    let outcome = &trigger.triggered[0];

    assert_eq!(
        code(outcome.rejected.as_ref()).as_deref(),
        Some("post_only_would_cross")
    );
    assert_eq!(outcome.cancellations.len(), 1);
    assert_eq!(outcome.cancellations[0].sequence, outcome.sequence);
    assert_eq!(book.current_sequence(), before + 3);
    assert_eq!(book.depth(50).2, book.current_sequence());
}

// ── Cancels ─────────────────────────────────────────────────────────────

#[test]
fn removes_a_resting_order_and_reports_its_untouched_remainder() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "4").id("live").acct("a").price("100"),
    );
    submit(&mut book, spec(Side::Sell, "1").acct("b").price("100"));

    let result = book.cancel("live", CancelReason::Requested);

    assert!(result.cancelled);
    let c = result.cancellation.as_ref().unwrap();
    assert_eq!(f(c.remaining_qty), "3");
    assert_eq!(c.reason, CancelReason::Requested);
    assert_eq!(book.best_bid(), None);
}

#[test]
fn removes_the_price_level_when_the_last_order_at_it_is_cancelled() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("only").acct("a").price("100"),
    );
    seed(&mut book, spec(Side::Sell, "1").acct("a").price("101"));

    book.cancel("only", CancelReason::Requested);

    assert_eq!(f(book.best_ask().unwrap()), "101");
    assert_eq!(asks(&book, 50), vec![lvl("101", "1")]);
}

#[test]
fn cancels_a_stop_order_that_never_triggered() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1")
            .id("stop")
            .acct("a")
            .ty(OrderType::Stop)
            .stop("1"),
    );

    let result = book.cancel("stop", CancelReason::Requested);
    assert!(result.cancelled);
    assert_eq!(f(result.cancellation.as_ref().unwrap().remaining_qty), "1");
}

#[test]
fn is_a_no_op_for_an_unknown_id_a_cancel_racing_a_fill_is_not_an_error() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = book.cancel("never-existed", CancelReason::Requested);

    assert!(!result.cancelled);
    assert_eq!(result.sequence, None);
    assert_eq!(book.current_sequence(), 0);
}

// ── Validation ──────────────────────────────────────────────────────────

fn rejects(s: Spec, expected: &str) {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(&mut book, s);
    assert!(!result.accepted);
    assert_eq!(code(result.rejected.as_ref()).as_deref(), Some(expected));
}

#[test]
fn rejects_zero_quantity() {
    rejects(spec(Side::Buy, "0").price("100"), "invalid_qty");
}

#[test]
fn rejects_negative_price() {
    rejects(spec(Side::Buy, "1").price("0"), "invalid_price");
}

#[test]
fn rejects_limit_without_a_price() {
    rejects(spec(Side::Buy, "1").ty(OrderType::Limit), "missing_price");
}

#[test]
fn rejects_market_carrying_a_price() {
    rejects(
        spec(Side::Buy, "1").ty(OrderType::Market).price("100"),
        "unexpected_price",
    );
}

#[test]
fn rejects_stop_without_a_stop_price() {
    rejects(
        spec(Side::Buy, "1").ty(OrderType::Stop),
        "missing_stop_price",
    );
}

#[test]
fn rejects_limit_carrying_a_stop_price() {
    rejects(
        spec(Side::Buy, "1").price("100").stop("99"),
        "unexpected_stop_price",
    );
}

#[test]
fn rejects_a_duplicate_order_id_a_bot_retry_must_not_open_a_second_order() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("dup").acct("a").price("100"),
    );

    let result = submit(
        &mut book,
        spec(Side::Buy, "1").id("dup").acct("a").price("100"),
    );

    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("duplicate_order_id")
    );
    assert_eq!(bids(&book, 50), vec![lvl("100", "1")]);
}

#[test]
fn rejects_a_duplicate_id_held_by_an_untriggered_stop() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1")
            .id("dup")
            .acct("a")
            .ty(OrderType::Stop)
            .stop("1"),
    );
    let result = submit(
        &mut book,
        spec(Side::Buy, "1").id("dup").acct("a").price("100"),
    );
    assert_eq!(
        code(result.rejected.as_ref()).as_deref(),
        Some("duplicate_order_id")
    );
}

#[test]
fn rejects_a_fully_filled_id_a_200_retry_must_not_open_a_second_rest() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("maker").acct("a").price("100"),
    );

    submit(
        &mut book,
        spec(Side::Buy, "1").id("taker").acct("b").price("100"),
    );
    assert_eq!(asks(&book, 50), Vec::<(String, String)>::new());

    let again = submit(
        &mut book,
        spec(Side::Sell, "1").id("maker").acct("a").price("100"),
    );

    assert!(!again.accepted);
    assert_eq!(
        code(again.rejected.as_ref()).as_deref(),
        Some("duplicate_order_id")
    );
    assert_eq!(again.fills, vec![]);
    assert_eq!(asks(&book, 50), Vec::<(String, String)>::new());
}

#[test]
fn rejects_a_never_rested_id_a_200_retry_must_not_emit_a_duplicate_fill() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("liq1").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "1").id("liq2").acct("a").price("100"),
    );

    let first = submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("mkt")
            .acct("b")
            .ty(OrderType::Market),
    );
    assert!(first.accepted);
    assert_eq!(first.fills.len(), 1);

    let second = submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("mkt")
            .acct("b")
            .ty(OrderType::Market),
    );

    assert!(!second.accepted);
    assert_eq!(
        code(second.rejected.as_ref()).as_deref(),
        Some("duplicate_order_id")
    );
    assert_eq!(second.fills, vec![]);
    assert_eq!(asks(&book, 50), vec![lvl("100", "1")]);
}

#[test]
fn snapshot_restore_still_refuses_a_filled_id() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("maker").acct("a").price("100"),
    );
    submit(
        &mut book,
        spec(Side::Buy, "1").id("taker").acct("b").price("100"),
    );

    let mut restored = OrderBook::from_state(&book.to_state()).unwrap();
    assert_eq!(
        restored.to_state().get("acceptedOrderIds"),
        Some(&Json::Array(vec![js("maker"), js("taker")]))
    );

    let again = submit(
        &mut restored,
        spec(Side::Buy, "1").id("taker").acct("b").price("100"),
    );
    assert!(!again.accepted);
    assert_eq!(
        code(again.rejected.as_ref()).as_deref(),
        Some("duplicate_order_id")
    );
    assert_eq!(again.fills, vec![]);
}

// ── Sequences ───────────────────────────────────────────────────────────

#[test]
fn are_strictly_monotonic_across_acceptances_and_fills() {
    let mut book = OrderBook::new("BTC/USDT");
    let a1 = seed(&mut book, spec(Side::Sell, "1").acct("mm").price("100"));
    let b1 = seed(&mut book, spec(Side::Sell, "1").acct("mm").price("101"));
    let taker = submit(&mut book, spec(Side::Buy, "2").acct("taker"));

    let mut seen = vec![
        a1.sequence.unwrap(),
        b1.sequence.unwrap(),
        taker.sequence.unwrap(),
    ];
    seen.extend(taker.fills.iter().map(|x| x.sequence));
    for w in seen.windows(2) {
        assert!(w[1] > w[0], "{seen:?}");
    }
}

#[test]
fn are_not_consumed_by_a_rejected_order() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "1").acct("mm").price("100"));
    let before = book.current_sequence();

    submit(
        &mut book,
        spec(Side::Buy, "9")
            .acct("taker")
            .price("100")
            .tif(Tif::Fok),
    );
    submit(
        &mut book,
        spec(Side::Buy, "1").acct("taker").price("100").tif(Tif::Po),
    );
    submit(&mut book, spec(Side::Buy, "0").acct("taker").price("100"));

    assert_eq!(book.current_sequence(), before);
}

#[test]
fn gives_a_triggered_stop_its_activation_sequence_not_its_admission_sequence() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(&mut book, spec(Side::Sell, "2").acct("mm").price("100"));
    seed(&mut book, spec(Side::Sell, "5").acct("mm").price("110"));
    submit(&mut book, spec(Side::Buy, "2").acct("warmup"));

    let admitted = submit(
        &mut book,
        spec(Side::Buy, "1")
            .id("stop")
            .acct("x")
            .ty(OrderType::Stop)
            .stop("105"),
    );
    let trigger = submit(&mut book, spec(Side::Buy, "1").acct("c"));

    assert!(trigger.triggered[0].sequence > admitted.sequence.unwrap());
}

// ── Serialisation, replay, and the no-float guarantee (§5.4) ────────────

/// Both sides, multiple levels, partials, and a pending stop.
fn busy_book() -> OrderBook {
    let mut book = OrderBook::new("ETH/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1.5").acct("mm").price("1999.25"),
    );
    seed(&mut book, spec(Side::Buy, "2").acct("mm").price("1998"));
    seed(&mut book, spec(Side::Buy, "3").acct("mm2").price("1999.25"));
    seed(
        &mut book,
        spec(Side::Sell, "4.125").acct("mm").price("2000.5"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "0.000000000000000001")
            .acct("mm")
            .price("2001"),
    );
    submit(
        &mut book,
        spec(Side::Buy, "1").acct("taker").price("2000.5"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "2.5")
            .acct("x")
            .ty(OrderType::StopLimit)
            .price("1990")
            .stop("1995"),
    );
    book
}

#[test]
fn round_trips_through_a_snapshot_byte_for_byte() {
    let book = busy_book();
    let serialised = book.serialize();

    let restored = OrderBook::from_state(&json::parse(&serialised).unwrap()).unwrap();

    assert_eq!(restored.serialize(), serialised);
}

#[test]
fn a_restored_book_keeps_matching_exactly_where_the_original_left_off() {
    let mut original = busy_book();
    let mut restored = OrderBook::from_state(&original.to_state()).unwrap();

    let next = spec(Side::Sell, "5").price("1998").acct("late").id("twin");
    let r1 = submit(&mut original, next.clone());
    let r2 = submit(&mut restored, next);

    let shape = |r: &SubmitResult| -> Vec<(String, String, u64)> {
        r.fills
            .iter()
            .map(|x| (f(x.price), f(x.qty), x.sequence))
            .collect()
    };
    assert_eq!(shape(&r1), shape(&r2));
    assert_eq!(original.serialize(), restored.serialize());
}

/// `/:\s*-?\d+\.\d/` and `/:\s*-?\d+(\.\d+)?[eE][+-]?\d+/`: a JSON number after a key with a fraction or an exponent.
fn float_like_after_colon(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut hits = Vec::new();
    for (i, &c) in b.iter().enumerate() {
        if c != b':' {
            continue;
        }
        let mut j = i + 1;
        while j < b.len() && (b[j] as char).is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'-' {
            j += 1;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            continue;
        }
        let fraction = j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit();
        let mut k = j;
        if k < b.len() && b[k] == b'.' {
            k += 1;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
        }
        let exponent = k < b.len() && (b[k] == b'e' || b[k] == b'E');
        if fraction || exponent {
            hits.push(text[i..(k + 1).min(text.len())].to_owned());
        }
    }
    hits
}

/// `/^-?\d+(\.\d{1,18})?$/` (or without the sign when `signed` is false).
fn is_decimal_string(v: &str, signed: bool) -> bool {
    let body = match v.strip_prefix('-') {
        Some(rest) if signed => rest,
        _ => v,
    };
    let (int, frac) = match body.split_once('.') {
        Some((i, fr)) => (i, Some(fr)),
        None => (body, None),
    };
    !int.is_empty()
        && int.bytes().all(|c| c.is_ascii_digit())
        && frac.is_none_or(|fr| {
            !fr.is_empty() && fr.len() <= 18 && fr.bytes().all(|c| c.is_ascii_digit())
        })
}

fn walk(node: &Json, path: &str, problems: &mut Vec<String>) {
    const AMOUNT_KEYS: [&str; 5] = ["price", "remaining", "qty", "stopPrice", "lastTradePrice"];
    const NUMBER_KEYS: [&str; 2] = ["sequence", "version"];
    match node {
        Json::Null | Json::String(_) | Json::Bool(_) => {}
        Json::Number(_) => {
            let key = path.rsplit('.').next().unwrap_or(path);
            if !NUMBER_KEYS.contains(&key) {
                problems.push(format!("{path} is a JS number"));
            } else {
                let text = node.compact();
                let safe = text
                    .parse::<i64>()
                    .is_ok_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991);
                if !safe {
                    problems.push(format!("{path} is not a safe integer"));
                }
            }
        }
        Json::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                walk(child, &format!("{path}[{i}]"), problems);
            }
        }
        Json::Object(fields) => {
            for (key, value) in fields {
                if AMOUNT_KEYS.contains(&key.as_str()) {
                    match value {
                        Json::Null => continue,
                        Json::String(v) => {
                            if !is_decimal_string(v, true) {
                                problems.push(format!(
                                    "{path}.{key} = \"{v}\" is not a decimal string"
                                ));
                            }
                        }
                        other => problems.push(format!(
                            "{path}.{key} is {}, not a decimal string",
                            other.compact()
                        )),
                    }
                }
                walk(value, &format!("{path}.{key}"), problems);
            }
        }
    }
}

#[test]
fn contains_no_floating_point_value_anywhere_every_amount_is_a_decimal_string() {
    let serialised = busy_book().serialize();

    assert_eq!(float_like_after_colon(&serialised), Vec::<String>::new());

    let mut problems = Vec::new();
    walk(&json::parse(&serialised).unwrap(), "$", &mut problems);
    assert_eq!(problems, Vec::<String>::new());
}

#[test]
fn depth_is_emitted_as_decimal_string_tuples_never_numbers() {
    let book = busy_book();
    for (price, qty) in bids(&book, 50).into_iter().chain(asks(&book, 50)) {
        assert!(is_decimal_string(&price, false), "{price}");
        assert!(is_decimal_string(&qty, false), "{qty}");
    }
}

#[test]
fn aggregates_a_price_level_rather_than_reporting_each_order() {
    let book = busy_book();
    assert_eq!(bids(&book, 50)[0], lvl("1999.25", "4.5"));
}

// ── Native amend ────────────────────────────────────────────────────────

fn amend(order_id: &str, expected_version: u64) -> EngineAmend {
    EngineAmend {
        order_id: order_id.to_owned(),
        expected_version,
        ..EngineAmend::default()
    }
}

#[test]
fn qty_down_at_the_same_price_retains_queue_sequence_and_bumps_version() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "2").id("first").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("second").acct("b").price("100"),
    );

    let result = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("first", 1)
        },
        None,
    );

    assert!(result.accepted);
    assert_eq!(result.priority, Some(Priority::Retained));
    assert_eq!(result.sequence, Some(1));
    assert_eq!(result.version, Some(2));
    assert_eq!(f(result.resting.as_ref().unwrap().remaining), "1");

    let take = submit(&mut book, spec(Side::Sell, "1").acct("taker").price("100"));
    assert_eq!(take.fills[0].maker_order_id, "first");
}

#[test]
fn price_change_loses_priority_and_receives_a_new_sequence() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("first").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("second").acct("b").price("100"),
    );

    let result = book.amend(
        &EngineAmend {
            price: Some(a("100")),
            ..amend("first", 1)
        },
        None,
    );
    assert_eq!(result.priority, Some(Priority::Retained));

    let moved = book.amend(
        &EngineAmend {
            price: Some(a("99")),
            ..amend("first", 2)
        },
        None,
    );
    assert!(moved.accepted);
    assert_eq!(moved.priority, Some(Priority::Lost));
    assert_ne!(moved.sequence, Some(1));

    let take = submit(&mut book, spec(Side::Sell, "1").acct("taker").price("99"));
    assert_eq!(take.fills[0].maker_order_id, "second");
}

#[test]
fn qty_up_loses_priority() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("first").acct("a").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "1").id("second").acct("b").price("100"),
    );

    let result = book.amend(
        &EngineAmend {
            qty: Some(a("2")),
            ..amend("first", 1)
        },
        None,
    );
    assert!(result.accepted);
    assert_eq!(result.priority, Some(Priority::Lost));

    let take = submit(&mut book, spec(Side::Sell, "1").acct("taker").price("100"));
    assert_eq!(take.fills[0].maker_order_id, "second");
}

#[test]
fn refused_amend_leaves_the_original_order_unchanged() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "2").id("keep").acct("a").price("100"),
    );
    let before = book.serialize();

    let missing = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("keep", 99)
        },
        None,
    );
    assert!(!missing.accepted);
    assert_eq!(
        code(missing.rejected.as_ref()).as_deref(),
        Some("version_mismatch")
    );
    assert_eq!(book.serialize(), before);

    let ghost = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("nope", 1)
        },
        None,
    );
    assert!(!ghost.accepted);
    assert_eq!(
        code(ghost.rejected.as_ref()).as_deref(),
        Some("order_not_found")
    );
    assert_eq!(book.serialize(), before);
}

#[test]
fn amend_racing_a_partial_fill_operates_on_remaining_quantity() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "2").id("keep").acct("a").price("100"),
    );
    submit(&mut book, spec(Side::Sell, "1").acct("taker").price("100"));

    let too_much = book.amend(
        &EngineAmend {
            qty: Some(a("2")),
            ..amend("keep", 1)
        },
        None,
    );
    assert!(too_much.accepted);
    assert_eq!(too_much.priority, Some(Priority::Lost));

    let mut book2 = OrderBook::new("BTC/USDT");
    seed(
        &mut book2,
        spec(Side::Buy, "2").id("keep").acct("a").price("100"),
    );
    submit(&mut book2, spec(Side::Sell, "1").acct("taker").price("100"));
    let down = book2.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("keep", 1)
        },
        None,
    );
    assert_eq!(down.priority, Some(Priority::Retained));
    assert_eq!(f(down.resting.as_ref().unwrap().remaining), "1");
}

const EARLY: &str = "2026-08-25T12:00:00.000Z";
const LATE: &str = "2026-08-25T18:00:00.000Z";

fn before_ms() -> i64 {
    v8_date_parse("2026-08-25T11:00:00.000Z").unwrap()
}

fn between_ms() -> i64 {
    v8_date_parse("2026-08-25T15:00:00.000Z").unwrap()
}

#[test]
fn a_retained_amend_stores_an_earlier_expire_at_and_that_deadline_is_the_one_expiry_uses() {
    let mut book = OrderBook::new("BTC/USDT");
    let rested = submit_at(
        &mut book,
        spec(Side::Buy, "1")
            .id("gtd")
            .acct("a")
            .price("100")
            .tif(Tif::Gtd)
            .expire(LATE),
        before_ms(),
    );
    assert!(rested.accepted);

    let amended = book.amend(
        &EngineAmend {
            expire_at: Some(EARLY.to_owned()),
            ..amend("gtd", 1)
        },
        None,
    );

    assert!(amended.accepted);
    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(amended.sequence, Some(1));
    assert_eq!(f(amended.resting.as_ref().unwrap().remaining), "1");
    assert_eq!(
        s(&first_rest(&book, "bids"), "expireAt").as_deref(),
        Some(EARLY)
    );

    let take = submit_at(
        &mut book,
        spec(Side::Sell, "1").id("taker").acct("taker").price("100"),
        between_ms(),
    );
    assert_eq!(take.fills.len(), 0);
    let got: Vec<(String, CancelReason)> = take
        .cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason))
        .collect();
    assert_eq!(got, vec![("gtd".to_owned(), CancelReason::Expired)]);
    assert_eq!(state_list(&book, "bids"), Vec::<Json>::new());
}

#[test]
fn a_retained_amend_that_omits_expire_at_does_not_invent_one() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "2").id("gtc").acct("a").price("100"),
    );

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("gtc", 1)
        },
        None,
    );

    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(first_rest(&book, "bids").get("expireAt"), None);
    assert_eq!(
        s(&first_rest(&book, "bids"), "remaining").as_deref(),
        Some("1")
    );
}

#[test]
fn a_retained_amend_that_omits_expire_at_keeps_the_stored_gtd_deadline() {
    let mut book = OrderBook::new("BTC/USDT");
    submit_at(
        &mut book,
        spec(Side::Buy, "2")
            .id("gtd")
            .acct("a")
            .price("100")
            .tif(Tif::Gtd)
            .expire(LATE),
        before_ms(),
    );

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("gtd", 1)
        },
        None,
    );

    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(
        s(&first_rest(&book, "bids"), "expireAt").as_deref(),
        Some(LATE)
    );
    assert_eq!(
        s(&first_rest(&book, "bids"), "remaining").as_deref(),
        Some("1")
    );

    let take = submit_at(
        &mut book,
        spec(Side::Sell, "1").id("taker").acct("taker").price("100"),
        between_ms(),
    );
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "gtd");
}

#[test]
fn a_retained_stop_amend_stores_an_earlier_expire_at_and_that_deadline_is_the_one_expiry_uses() {
    let mut book = OrderBook::new("BTC/USDT");
    let rested = submit_at(
        &mut book,
        spec(Side::Sell, "2")
            .id("stop")
            .acct("a")
            .ty(OrderType::Stop)
            .stop("90")
            .tif(Tif::Gtd)
            .expire(LATE),
        before_ms(),
    );
    assert!(rested.accepted);
    assert_eq!(rested.resting.as_ref().unwrap().kind, RestKind::Stop);

    let amended = book.amend(
        &EngineAmend {
            expire_at: Some(EARLY.to_owned()),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(amended.accepted);
    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(amended.sequence, Some(1));
    assert_eq!(f(amended.resting.as_ref().unwrap().remaining), "2");
    let stop = &state_list(&book, "stops")[0];
    assert_eq!(s(stop, "expireAt").as_deref(), Some(EARLY));
    assert_eq!(s(stop, "qty").as_deref(), Some("2"));

    let later = submit_at(
        &mut book,
        spec(Side::Buy, "1").id("other").acct("b").price("100"),
        between_ms(),
    );
    let got: Vec<(String, CancelReason)> = later
        .cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason))
        .collect();
    assert_eq!(got, vec![("stop".to_owned(), CancelReason::Expired)]);
    assert_eq!(state_list(&book, "stops"), Vec::<Json>::new());
}

#[test]
fn a_retained_stop_amend_that_omits_expire_at_keeps_the_stored_deadline() {
    let mut book = OrderBook::new("BTC/USDT");
    submit_at(
        &mut book,
        spec(Side::Sell, "2")
            .id("stop")
            .acct("a")
            .ty(OrderType::Stop)
            .stop("90")
            .tif(Tif::Gtd)
            .expire(LATE),
        before_ms(),
    );

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("stop", 1)
        },
        None,
    );

    assert_eq!(amended.priority, Some(Priority::Retained));
    let stop = &state_list(&book, "stops")[0];
    assert_eq!(s(stop, "expireAt").as_deref(), Some(LATE));
    assert_eq!(s(stop, "qty").as_deref(), Some("1"));
}

#[test]
fn a_retained_amend_to_po_stays_post_only_when_a_later_amend_omits_tif() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Sell, "1").id("ask").acct("mm").price("100"),
    );
    seed(
        &mut book,
        spec(Side::Buy, "2").id("bid").acct("a").price("99"),
    );

    let po = book.amend(
        &EngineAmend {
            tif: Some(Tif::Po),
            ..amend("bid", 1)
        },
        None,
    );
    assert!(po.accepted);
    assert_eq!(po.priority, Some(Priority::Retained));
    assert_eq!(
        first_rest(&book, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );

    let down = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("bid", 2)
        },
        None,
    );
    assert!(down.accepted);
    assert_eq!(down.priority, Some(Priority::Retained));
    assert_eq!(
        first_rest(&book, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );
    assert_eq!(
        s(&first_rest(&book, "bids"), "remaining").as_deref(),
        Some("1")
    );

    let cross = book.amend(
        &EngineAmend {
            price: Some(a("100")),
            ..amend("bid", 3)
        },
        None,
    );
    assert!(!cross.accepted);
    assert_eq!(
        code(cross.rejected.as_ref()).as_deref(),
        Some("post_only_would_cross")
    );
    assert_eq!(cross.fills.len(), 0);
    assert_eq!(
        s(&first_rest(&book, "asks"), "remaining").as_deref(),
        Some("1")
    );
    assert_eq!(
        first_rest(&book, "bids").get("postOnly"),
        Some(&Json::Bool(true))
    );
    assert_eq!(f(book.best_bid().unwrap()), "99");
}

#[test]
fn a_retained_amend_below_the_stored_min_qty_is_refused_and_does_not_rest_a_broken_maker() {
    let mut book = OrderBook::new("BTC/USDT");
    let rested = submit(
        &mut book,
        spec(Side::Sell, "10")
            .id("maker")
            .acct("mm")
            .price("100")
            .min_qty("5"),
    );
    assert!(rested.accepted);

    let shrunk = book.amend(
        &EngineAmend {
            qty: Some(a("4")),
            ..amend("maker", 1)
        },
        None,
    );

    assert!(!shrunk.accepted);
    assert_eq!(
        code(shrunk.rejected.as_ref()).as_deref(),
        Some("min_qty_exceeds_qty")
    );
    assert_eq!(shrunk.fills.len(), 0);
    let ask = first_rest(&book, "asks");
    assert_eq!(s(&ask, "remaining").as_deref(), Some("10"));
    assert_eq!(s(&ask, "minQty").as_deref(), Some("5"));
    assert_eq!(ask.get("version"), Some(&jn(1)));

    let take = submit(
        &mut book,
        spec(Side::Buy, "5").id("taker").acct("taker").price("100"),
    );
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "maker");
    assert_eq!(f(take.fills[0].qty), "5");
    assert_eq!(take.resting, None);
    assert_eq!(
        s(&first_rest(&book, "asks"), "remaining").as_deref(),
        Some("5")
    );
}

#[test]
fn a_retained_amend_down_to_the_stored_min_qty_keeps_priority_and_can_still_fill() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(Side::Sell, "10")
            .id("maker")
            .acct("mm")
            .price("100")
            .min_qty("5"),
    );
    seed(
        &mut book,
        spec(Side::Sell, "1").id("behind").acct("b").price("100"),
    );

    let shrunk = book.amend(
        &EngineAmend {
            qty: Some(a("5")),
            ..amend("maker", 1)
        },
        None,
    );

    assert!(shrunk.accepted);
    assert_eq!(shrunk.priority, Some(Priority::Retained));
    assert_eq!(shrunk.sequence, Some(1));
    let ask = first_rest(&book, "asks");
    assert_eq!(s(&ask, "orderId").as_deref(), Some("maker"));
    assert_eq!(s(&ask, "remaining").as_deref(), Some("5"));

    let take = submit(
        &mut book,
        spec(Side::Buy, "5").id("taker").acct("taker").price("100"),
    );
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.fills[0].maker_order_id, "maker");
    assert_eq!(f(take.fills[0].qty), "5");
    assert_eq!(
        s(&first_rest(&book, "asks"), "orderId").as_deref(),
        Some("behind")
    );
}

/// Desk buys 2 from mm at 100. Position is the fill, long 2.
fn long_two(book: &mut OrderBook) {
    seed(
        book,
        spec(Side::Sell, "2").id("liq").acct("mm").price("100"),
    );
    let open = submit(
        book,
        spec(Side::Buy, "2").id("open").acct("desk").price("100"),
    );
    assert_eq!(open.fills.len(), 1);
    assert_eq!(positions(book), vec![pos("desk", "2"), pos("mm", "-2")]);
}

fn reduce_stop(qty: &'static str) -> Spec {
    spec(Side::Sell, qty)
        .id("stop")
        .acct("desk")
        .ty(OrderType::Stop)
        .stop("90")
        .reduce_only()
}

#[test]
fn refuses_a_reduce_only_stop_amend_whose_qty_would_increase_the_position_and_does_not_park_it() {
    let mut book = OrderBook::new("BTC/USDT");
    long_two(&mut book);
    let rested = submit(&mut book, reduce_stop("1"));
    assert!(rested.accepted);
    matches(
        &state_list(&book, "stops")[0],
        &[
            ("orderId", js("stop")),
            ("qty", js("1")),
            ("stopPrice", js("90")),
            ("version", jn(1)),
        ],
    );

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("3")),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(!amended.accepted);
    assert_eq!(
        code(amended.rejected.as_ref()).as_deref(),
        Some("would_increase_position")
    );
    assert_eq!(amended.fills.len(), 0);
    assert_eq!(amended.triggered, vec![]);
    matches(
        &state_list(&book, "stops")[0],
        &[
            ("orderId", js("stop")),
            ("qty", js("1")),
            ("stopPrice", js("90")),
            ("version", jn(1)),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    assert_eq!(positions(&book), vec![pos("desk", "2"), pos("mm", "-2")]);
}

#[test]
fn refuses_a_triggered_reduce_only_stop_amend_whose_qty_would_increase_the_position_and_does_not_fill_or_flip_it()
 {
    let mut book = OrderBook::new("BTC/USDT");
    long_two(&mut book);
    seed(
        &mut book,
        spec(Side::Buy, "3").id("bid").acct("bid").price("100"),
    );
    submit(&mut book, reduce_stop("1"));

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("3")),
            stop_price: Some(a("100")),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(!amended.accepted);
    assert_eq!(
        code(amended.rejected.as_ref()).as_deref(),
        Some("would_increase_position")
    );
    assert_eq!(amended.fills.len(), 0);
    assert_eq!(amended.triggered, vec![]);
    matches(
        &state_list(&book, "stops")[0],
        &[
            ("orderId", js("stop")),
            ("qty", js("1")),
            ("stopPrice", js("90")),
            ("version", jn(1)),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    matches(
        &first_rest(&book, "bids"),
        &[("orderId", js("bid")), ("remaining", js("3"))],
    );
    assert_eq!(positions(&book), vec![pos("desk", "2"), pos("mm", "-2")]);
}

#[test]
fn amends_a_reduce_only_stop_to_a_qty_that_still_reduces_the_position() {
    let mut book = OrderBook::new("BTC/USDT");
    long_two(&mut book);
    submit(&mut book, reduce_stop("2"));

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(amended.accepted);
    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(amended.fills.len(), 0);
    matches(
        &state_list(&book, "stops")[0],
        &[
            ("orderId", js("stop")),
            ("qty", js("1")),
            ("stopPrice", js("90")),
            ("version", jn(2)),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    assert_eq!(positions(&book), vec![pos("desk", "2"), pos("mm", "-2")]);
}

#[test]
fn amends_a_reduce_only_stop_up_to_the_net_without_parking_a_flip_or_filling() {
    let mut book = OrderBook::new("BTC/USDT");
    long_two(&mut book);
    submit(&mut book, reduce_stop("1"));

    let amended = book.amend(
        &EngineAmend {
            qty: Some(a("2")),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(amended.accepted);
    assert_eq!(amended.priority, Some(Priority::Lost));
    assert_eq!(amended.fills.len(), 0);
    let stops = state_list(&book, "stops");
    assert_eq!(stops.len(), 1);
    matches(
        &stops[0],
        &[
            ("orderId", js("stop")),
            ("qty", js("2")),
            ("stopPrice", js("90")),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    assert_eq!(positions(&book), vec![pos("desk", "2"), pos("mm", "-2")]);
}

#[test]
fn amends_a_reduce_only_stop_onto_a_trigger_that_reduces_the_position_and_does_not_flip_it() {
    let mut book = OrderBook::new("BTC/USDT");
    long_two(&mut book);
    seed(
        &mut book,
        spec(Side::Buy, "1").id("bid").acct("bid").price("100"),
    );
    submit(&mut book, reduce_stop("1"));

    let amended = book.amend(
        &EngineAmend {
            stop_price: Some(a("100")),
            ..amend("stop", 1)
        },
        None,
    );

    assert!(amended.accepted);
    assert_eq!(amended.fills.len(), 1);
    assert_eq!(f(amended.fills[0].qty), "1");
    assert_eq!(state_list(&book, "stops"), Vec::<Json>::new());
    assert_eq!(
        positions(&book),
        vec![pos("bid", "1"), pos("desk", "1"), pos("mm", "-2")]
    );
}

// ── OCO sibling cancel ──────────────────────────────────────────────────

const TP: &str = "oco-tp";
const SL: &str = "oco-sl";

fn live_ids(book: &OrderBook) -> Vec<String> {
    let mut ids = Vec::new();
    for side in ["bids", "asks"] {
        for level in state_list(book, side) {
            for o in arr(level.get("orders").unwrap()) {
                ids.push(s(o, "orderId").unwrap());
            }
        }
    }
    for st in state_list(book, "stops") {
        ids.push(s(&st, "orderId").unwrap());
    }
    ids.sort();
    ids
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn a_stop_limit_that_triggers_and_rests_with_zero_fills_cancels_its_oco_sibling() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("bid-print").acct("mm").price("100"),
    );
    let printed = submit(
        &mut book,
        spec(Side::Sell, "1").id("print").acct("taker").price("100"),
    );
    assert_eq!(f(printed.fills[0].price), "100");

    seed(
        &mut book,
        spec(Side::Buy, "2").id("bid-90").acct("mm").price("90"),
    );
    let tp = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(TP)
            .acct("desk")
            .price("110")
            .oco(SL),
    );
    assert!(tp.accepted);
    assert_eq!(tp.fills.len(), 0);

    let parked = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(SL)
            .acct("desk")
            .ty(OrderType::StopLimit)
            .price("100")
            .stop("95")
            .oco(TP),
    );
    assert!(parked.accepted);
    assert_eq!(parked.fills.len(), 0);
    assert_eq!(parked.resting.as_ref().unwrap().kind, RestKind::Stop);

    let crash = submit(
        &mut book,
        spec(Side::Sell, "1").id("crash").acct("taker").price("90"),
    );

    assert_eq!(crash.fills.len(), 1);
    assert_eq!(crash.fills[0].maker_order_id, "bid-90");
    assert_eq!(f(crash.fills[0].price), "90");
    assert_eq!(f(crash.fills[0].qty), "1");
    let ids: Vec<String> = crash.triggered.iter().map(|t| t.order_id.clone()).collect();
    assert_eq!(ids, strs(&[SL]));

    let triggered = &crash.triggered[0];
    assert_eq!(triggered.fills.len(), 0);
    let resting = triggered.resting.as_ref().unwrap();
    assert_eq!(resting.kind, RestKind::Book);
    assert_eq!(resting.order_id, SL);
    assert_eq!(f(resting.remaining), "1");
    assert_eq!(f(resting.price), "100");
    assert!(
        triggered
            .cancellations
            .iter()
            .any(|c| c.order_id == TP && c.reason == CancelReason::OcoSiblingFilled),
        "{:?}",
        triggered.cancellations
    );
    let pulled = triggered
        .cancellations
        .iter()
        .find(|c| c.order_id == TP)
        .unwrap();
    assert_eq!(f(pulled.remaining_qty), "1");
    assert_eq!(live_ids(&book), sorted(strs(&["bid-90", SL])));
    assert_eq!(asks(&book, 50), vec![lvl("100", "1")]);
}

#[test]
fn a_sweep_that_trades_one_linked_order_pulls_the_sibling_before_the_other_leg_trades() {
    let mut book = OrderBook::new("BTC/USDT");
    let near = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id("oco-near")
            .acct("desk")
            .price("100")
            .oco("oco-far"),
    );
    let mid = submit(
        &mut book,
        spec(Side::Sell, "1").id("mid").acct("mm").price("101"),
    );
    let far = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id("oco-far")
            .acct("desk")
            .price("102")
            .oco("oco-near"),
    );
    assert_eq!(near.fills.len(), 0);
    assert_eq!(mid.fills.len(), 0);
    assert_eq!(far.fills.len(), 0);
    assert_eq!(live_ids(&book), strs(&["mid", "oco-far", "oco-near"]));

    let sweep = submit(
        &mut book,
        spec(Side::Buy, "3").id("buy").acct("taker").price("102"),
    );

    assert_eq!(makers(&sweep), strs(&["oco-near", "mid"]));
    assert_eq!(fill_prices(&sweep), strs(&["100", "101"]));
    assert_eq!(fill_qtys(&sweep), strs(&["1", "1"]));
    assert!(!makers(&sweep).contains(&"oco-far".to_owned()));
    assert!(
        sweep
            .cancellations
            .iter()
            .any(|c| c.order_id == "oco-far" && c.reason == CancelReason::OcoSiblingFilled),
        "{:?}",
        sweep.cancellations
    );
    let pulled = sweep
        .cancellations
        .iter()
        .find(|c| c.order_id == "oco-far")
        .unwrap();
    assert_eq!(f(pulled.remaining_qty), "1");
    assert_eq!(f(sweep.resting.as_ref().unwrap().remaining), "1");
    assert_eq!(live_ids(&book), strs(&["buy"]));
    assert_eq!(asks(&book, 50), Vec::<(String, String)>::new());
}

#[test]
fn a_leg_that_fills_still_cancels_its_oco_sibling() {
    let mut book = OrderBook::new("BTC/USDT");
    seed(
        &mut book,
        spec(Side::Buy, "1").id("bid").acct("mm").price("110"),
    );
    submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(SL)
            .acct("desk")
            .ty(OrderType::Stop)
            .stop("90")
            .oco(TP),
    );
    let tp = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(TP)
            .acct("desk")
            .price("110")
            .oco(SL),
    );

    assert_eq!(tp.fills.len(), 1);
    assert_eq!(tp.fills[0].maker_order_id, "bid");
    assert_eq!(f(tp.fills[0].qty), "1");
    assert_eq!(f(tp.fills[0].price), "110");
    let got: Vec<(String, CancelReason)> = tp
        .cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason))
        .collect();
    assert_eq!(got, vec![(SL.to_owned(), CancelReason::OcoSiblingFilled)]);
    assert_eq!(f(tp.cancellations[0].remaining_qty), "1");
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

#[test]
fn resting_a_limit_leg_leaves_its_live_oco_sibling_on_the_book() {
    let mut book = OrderBook::new("BTC/USDT");
    let sl = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(SL)
            .acct("desk")
            .ty(OrderType::Stop)
            .stop("90")
            .oco(TP),
    );
    let tp = submit(
        &mut book,
        spec(Side::Sell, "1")
            .id(TP)
            .acct("desk")
            .price("110")
            .oco(SL),
    );

    assert!(sl.accepted);
    assert!(tp.accepted);
    assert_eq!(tp.fills.len(), 0);
    assert!(
        tp.cancellations
            .iter()
            .all(|c| c.reason != CancelReason::OcoSiblingFilled)
    );
    assert_eq!(live_ids(&book), sorted(strs(&[SL, TP])));
}

// ── OrderBook.clone (book-clone.test.ts) ────────────────────────────────

/// `id(n)` in book-clone.test.ts: a UUID made of one repeated digit.
fn uid(n: u32) -> String {
    let d = n.to_string();
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
        uid(i),
        acct,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

/// A private field of the book, read from its `Debug` form (the TypeScript test reads it through a cast).
fn private_field(book: &OrderBook, name: &str) -> String {
    let text = format!("{book:?}");
    let key = format!(" {name}: ");
    let start = text.find(&key).unwrap_or_else(|| panic!("no field {name}")) + key.len();
    let rest = &text[start..];
    let end = rest.find(", ").or_else(|| rest.find(" }")).unwrap();
    rest[..end].to_owned()
}

#[test]
fn keeps_the_previous_print_and_the_mark_and_index_prices_that_to_state_drops() {
    let mut book = OrderBook::new("BTC/USDT");
    book.submit(&lim(1, "mm", Side::Sell, "1", "100"), None);
    book.submit(&lim(2, "tk", Side::Buy, "1", "100"), None);
    book.submit(&lim(3, "mm", Side::Sell, "1", "101"), None);
    book.submit(&lim(4, "tk", Side::Buy, "1", "101"), None);
    book.apply_trigger_reference(TriggerBy::Mark, Some(a("105")));
    book.apply_trigger_reference(TriggerBy::Index, Some(a("106")));
    let copy = book.rehearsal_copy().unwrap();

    assert_eq!(
        private_field(&copy, "previous_trade_price"),
        private_field(&book, "previous_trade_price")
    );
    assert_eq!(
        private_field(&copy, "previous_trade_price"),
        format!("{:?}", Some(a("100")))
    );
    assert_eq!(
        private_field(&copy, "mark_price"),
        format!("{:?}", Some(a("105")))
    );
    assert_eq!(
        private_field(&copy, "index_price"),
        format!("{:?}", Some(a("106")))
    );
    assert_eq!(copy.last_price(), Some(a("101")));
}

#[test]
fn a_copy_is_independent_of_the_live_book() {
    let mut book = OrderBook::new("BTC/USDT");
    book.submit(&lim(1, "mm", Side::Sell, "1", "100"), None);
    let mut copy = book.rehearsal_copy().unwrap();
    copy.submit(&lim(2, "tk", Side::Buy, "1", "100"), None);
    assert_eq!(state_list(&book, "asks").len(), 1);
    assert_eq!(state_list(&copy, "asks").len(), 0);
}

// ── book-l2-depth-unset-refuse.test.ts (the book's part) ────────────────

#[test]
fn owner_explicit_50_is_published_not_invented() {
    let book = OrderBook::new("BTC-USDT");
    assert_eq!(book.depth(50), (Vec::new(), Vec::new(), 0));
}

// ── depth-memo.test.ts ──────────────────────────────────────────────────

static MEMO_IDS: AtomicUsize = AtomicUsize::new(0);

/// depth-memo's `order(over)`: account `acct-1`, a GTC limit at 100, unless overridden.
fn memo(side: Side, qty: &str) -> EngineOrder {
    let n = MEMO_IDS.fetch_add(1, Ordering::SeqCst) + 1;
    EngineOrder::new(
        format!("o-{n}"),
        "acct-1",
        OrderType::Limit,
        side,
        a(qty),
        Some(a("100")),
        Tif::Gtc,
    )
}

/// Total size reported at a price, or none when the level is absent.
fn size_at(book: &OrderBook, side: Side, price: &str) -> Option<String> {
    let (b, s, _) = book.depth(50);
    let ladder = if side == Side::Buy { b } else { s };
    ladder
        .into_iter()
        .find(|(p, _)| f(*p) == price)
        .map(|(_, q)| f(q))
}

#[test]
fn a_new_resting_order_changes_the_reported_size() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Buy, "1"), None);
    assert_eq!(size_at(&book, Side::Buy, "100").as_deref(), Some("1"));
    assert_eq!(size_at(&book, Side::Buy, "100").as_deref(), Some("1"));

    book.submit(&memo(Side::Buy, "2"), None);
    assert_eq!(size_at(&book, Side::Buy, "100").as_deref(), Some("3"));
}

#[test]
fn a_cancel_removes_the_level_from_the_reported_book() {
    let mut book = OrderBook::new("m");
    let placed = book.submit(&memo(Side::Buy, "5"), None);
    assert_eq!(size_at(&book, Side::Buy, "100").as_deref(), Some("5"));

    let resting_id = placed.resting.as_ref().unwrap().order_id.clone();
    book.cancel(&resting_id, CancelReason::Requested);

    assert_eq!(size_at(&book, Side::Buy, "100"), None);
}

#[test]
fn a_partial_fill_decrements_the_reported_size() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Sell, "10"), None);
    assert_eq!(size_at(&book, Side::Sell, "100").as_deref(), Some("10"));

    let mut taker = memo(Side::Buy, "4");
    taker.tif = Tif::Ioc;
    taker.account_id = "acct-2".to_owned();
    book.submit(&taker, None);

    assert_eq!(size_at(&book, Side::Sell, "100").as_deref(), Some("6"));
}

#[test]
fn a_full_fill_empties_the_reported_book() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Sell, "3"), None);
    assert_eq!(size_at(&book, Side::Sell, "100").as_deref(), Some("3"));

    let mut taker = memo(Side::Buy, "3");
    taker.tif = Tif::Ioc;
    taker.account_id = "acct-2".to_owned();
    book.submit(&taker, None);

    assert_eq!(size_at(&book, Side::Sell, "100"), None);
}

#[test]
fn a_rejected_order_leaves_the_answer_alone_the_book_did_not_change() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Buy, "7"), None);
    let before = book.depth(50);

    let rejected = book.submit(&memo(Side::Buy, "0"), None);
    assert!(!rejected.accepted);

    assert_eq!(book.depth(50), before);
}

#[test]
fn different_limits_do_not_serve_each_other_answers() {
    let mut book = OrderBook::new("m");
    for i in 0..5_u32 {
        let mut o = memo(Side::Buy, "1");
        o.price = Some(a(&(100 - i).to_string()));
        book.submit(&o, None);
    }

    assert_eq!(book.depth(2).0.len(), 2);
    assert_eq!(book.depth(5).0.len(), 5);
    assert_eq!(book.depth(2).0.len(), 2);
}

#[test]
fn hands_back_a_fresh_outer_array_each_call_so_a_caller_cannot_corrupt_the_cache() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Buy, "1"), None);

    let mut first = book.depth(50);
    first.0.clear();

    assert_eq!(book.depth(50).0.len(), 1);
}

#[test]
fn a_restored_book_starts_with_no_inherited_answer() {
    let mut book = OrderBook::new("m");
    book.submit(&memo(Side::Buy, "9"), None);
    assert_eq!(size_at(&book, Side::Buy, "100").as_deref(), Some("9"));

    let mut restored = OrderBook::from_state(&book.to_state()).unwrap();
    assert_eq!(size_at(&restored, Side::Buy, "100").as_deref(), Some("9"));

    restored.submit(&memo(Side::Buy, "1"), None);
    assert_eq!(size_at(&restored, Side::Buy, "100").as_deref(), Some("10"));
}
