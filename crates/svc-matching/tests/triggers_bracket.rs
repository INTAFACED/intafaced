//! The bracket, test for test: `services/svc-matching/src/engine/bracket.test.ts`, ported onto the Rust `OrderBook`,
//! whose `submit` and `amend` run the whole trigger chain (`src/book/triggers.rs`). Same inputs, same expected values.
//!
//! Every TypeScript test is ported. One differs in how it reaches its subject: `read helpers treat missing and zero as
//! not set` calls `wantsBracket`, `readEntry`, `entryRefuse`, `takeProfitRefuse` and `stopLossRefuse` directly. The
//! Rust inlines them in the bracket's submit and exports none, so the port asks the same questions through
//! `OrderBook::submit`: each helper's answer is the refusal, or the resting entry, that submit gives for that input.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::OrderBook;
use svc_matching::book::types::{
    EngineAmend, EngineOrder, Fill, Opt, OrderType, Side, SubmitResult, Tif,
};

const ENTRY: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TP: &str = "22222222-2222-4222-8222-222222222222";
const SL: &str = "33333333-3333-4333-8333-333333333333";
const LIQ: &str = "11111111-1111-4111-8111-111111111111";
const ENTRY_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TP_B: &str = "44444444-4444-4444-8444-444444444444";
const SL_B: &str = "55555555-5555-4555-8555-555555555555";

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

/// What `order(spec)` in bracket.test.ts takes; the rest defaults the way it defaults.
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
    bracket: Option<bool>,
    take_profit: Option<&'static str>,
    stop_loss: Option<&'static str>,
    take_profit_order_id: Option<&'static str>,
    stop_loss_order_id: Option<&'static str>,
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
    fn bracket(mut self) -> Spec {
        self.bracket = Some(true);
        self
    }
    fn tp(mut self, v: &'static str) -> Spec {
        self.take_profit = Some(v);
        self
    }
    fn sl(mut self, v: &'static str) -> Spec {
        self.stop_loss = Some(v);
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
    /// The bracket most tests name: `bracket: true`, the two exit prices, and `TP`/`SL` as the exit ids.
    fn exits(self, take_profit: &'static str, stop_loss: &'static str) -> Spec {
        self.bracket()
            .tp(take_profit)
            .sl(stop_loss)
            .tp_id(TP)
            .sl_id(SL)
    }
}

/// `order(spec)`: the type is market when no price is named, limit otherwise; the account defaults to `desk`.
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
    if let Some(b) = s.bracket {
        o.exits.bracket = Opt::Some(b);
    }
    if let Some(v) = s.take_profit {
        o.exits.take_profit = Opt::Some(a(v));
    }
    if let Some(v) = s.stop_loss {
        o.exits.stop_loss = Opt::Some(a(v));
    }
    if let Some(v) = s.take_profit_order_id {
        o.exits.take_profit_order_id = Opt::Some(v.to_owned());
    }
    if let Some(v) = s.stop_loss_order_id {
        o.exits.stop_loss_order_id = Opt::Some(v.to_owned());
    }
    o
}

fn submit(book: &mut OrderBook, s: Spec) -> SubmitResult {
    book.submit(&order(&s), None)
}

// ── toState readers ────────────────────────────────────────────────────

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(v) => v.clone(),
        other => panic!("not an array: {}", other.compact()),
    }
}

fn st(j: &Json, key: &str) -> Option<String> {
    match j.get(key) {
        Some(Json::String(v)) => Some(v.clone()),
        Some(other) => panic!("{key} is not a string: {}", other.compact()),
        None => None,
    }
}

/// `toState()[side].flatMap((level) => level.orders)`.
fn rests(book: &OrderBook, side: &str) -> Vec<Json> {
    arr(book.to_state().get(side).unwrap())
        .iter()
        .flat_map(|level| arr(level.get("orders").unwrap()))
        .collect()
}

fn stops(book: &OrderBook) -> Vec<Json> {
    arr(book.to_state().get("stops").unwrap())
}

fn find(rows: Vec<Json>, order_id: &str) -> Option<Json> {
    rows.into_iter()
        .find(|row| st(row, "orderId").as_deref() == Some(order_id))
}

/// `toState().stops.find((row) => row.orderId === id)?.qty`.
fn stop_qty(book: &OrderBook, order_id: &str) -> Option<String> {
    find(stops(book), order_id).and_then(|row| st(&row, "qty"))
}

/// `toState().asks.flatMap(...).find((row) => row.orderId === id)?.remaining`.
fn ask_remaining(book: &OrderBook, order_id: &str) -> Option<String> {
    find(rests(book, "asks"), order_id).and_then(|row| st(&row, "remaining"))
}

/// `toState().positions?.find((row) => row.accountId === account)`.
fn position(book: &OrderBook, account: &str) -> Option<Json> {
    book.to_state()
        .get("positions")
        .map(arr)
        .unwrap_or_default()
        .into_iter()
        .find(|row| st(row, "accountId").as_deref() == Some(account))
}

/// `toState().positions?.find(...)?.qty`.
fn position_qty(book: &OrderBook, account: &str) -> Option<String> {
    position(book, account).and_then(|row| st(&row, "qty"))
}

/// `liveIds`: every resting bid, ask and stop, sorted.
fn live_ids(book: &OrderBook) -> Vec<String> {
    let mut ids: Vec<String> = rests(book, "bids")
        .iter()
        .chain(rests(book, "asks").iter())
        .chain(stops(book).iter())
        .map(|row| st(row, "orderId").unwrap())
        .collect();
    ids.sort();
    ids
}

fn sorted(v: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = v.iter().map(|s| (*s).to_owned()).collect();
    out.sort();
    out
}

fn touches(fill: &Fill, order_id: &str) -> bool {
    fill.maker_order_id == order_id || fill.taker_order_id == order_id
}

/// `filledQty`: the summed quantity of the fills that touch the order.
fn filled_qty(fills: &[Fill], order_id: &str) -> String {
    f(fills
        .iter()
        .filter(|x| touches(x, order_id))
        .map(|x| x.qty)
        .sum())
}

/// The result's fills, then each triggered stop's.
fn every_fill(result: &SubmitResult) -> Vec<Fill> {
    let mut out = result.fills.clone();
    for t in &result.triggered {
        out.extend(t.fills.iter().cloned());
    }
    out
}

/// `tradedQty`: `filledQty` over the result's fills and each triggered stop's.
fn traded_qty(result: &SubmitResult, order_id: &str) -> String {
    filled_qty(&every_fill(result), order_id)
}

/// `cancellations.map((row) => [row.orderId, row.reason])`.
fn cancels(result: &SubmitResult) -> Vec<(String, String)> {
    result
        .cancellations
        .iter()
        .map(|c| (c.order_id.clone(), c.reason.as_str().to_owned()))
        .collect()
}

fn pair(id: &str, reason: &str) -> (String, String) {
    (id.to_owned(), reason.to_owned())
}

fn has(ids: &[String], id: &str) -> bool {
    ids.iter().any(|x| x == id)
}

// ── bracket — rest entry, take-profit, and stop-loss ──────────────────

#[test]
fn rests_the_entry_without_resting_the_exits() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    assert!(result.accepted);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[ENTRY]));
    assert_eq!(book.last_price(), None);
}

#[test]
fn entry_fill_rests_the_exits_no_invented_trigger() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    let result = submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    assert!(result.accepted);
    assert!(!result.fills.is_empty());
    assert_eq!(f(result.fills[0].qty), "1");
    assert_eq!(live_ids(&book), sorted(&[SL, TP]));
    assert!(!has(&live_ids(&book), ENTRY));
    let stop = find(stops(&book), SL);
    let take_profit = find(rests(&book, "asks"), TP);
    assert_eq!(
        stop.and_then(|r| st(&r, "ocoSiblingId")),
        Some(TP.to_owned())
    );
    assert_eq!(
        take_profit.and_then(|r| st(&r, "ocoSiblingId")),
        Some(SL.to_owned())
    );
}

#[test]
fn a_stop_already_at_the_fill_price_does_not_leave_the_take_profit_live() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec("ask", Side::Sell, "1").acct("mm").price("100"),
    );
    submit(
        &mut book,
        spec("bid", Side::Buy, "1").acct("mm").price("99"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "100"),
    );

    assert!(result.accepted);
    assert!(result.rejected.is_none());
    let stop_fill = result.fills.iter().find(|x| x.taker_order_id == SL);
    assert!(stop_fill.is_some());
    let stop_fill = stop_fill.unwrap();
    assert_eq!(f(stop_fill.qty), "1");
    assert_eq!(f(stop_fill.price), "99");
    assert!(cancels(&result).contains(&pair(TP, "oco_sibling_filled")));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));
    assert!(position(&book, "desk").is_none());

    let again = submit(
        &mut book,
        spec("lift-tp", Side::Buy, "1").acct("mm").price("110"),
    );
    assert_eq!(again.fills.iter().filter(|x| touches(x, TP)).count(), 0);
}

#[test]
fn a_partial_take_profit_does_not_let_the_stop_sell_that_size_again() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "2").price("100").exits("100", "100"),
    );
    submit(
        &mut book,
        spec("behind", Side::Buy, "1").acct("buyer").price("100"),
    );
    submit(
        &mut book,
        spec("below", Side::Buy, "2").acct("buyer").price("99"),
    );
    let result = submit(
        &mut book,
        spec("hit", Side::Sell, "2").acct("mm").price("100"),
    );

    assert!(result.accepted);
    assert_eq!(filled_qty(&result.fills, TP), "1");
    assert_eq!(filled_qty(&result.fills, SL), "1");
    let stop_fill = result
        .fills
        .iter()
        .find(|x| x.taker_order_id == SL)
        .unwrap();
    assert_eq!(f(stop_fill.price), "99");
    assert!(cancels(&result).contains(&pair(TP, "oco_sibling_filled")));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));
    assert!(position(&book, "desk").is_none());

    let again = submit(
        &mut book,
        spec("lift-tp", Side::Buy, "1").acct("mm").price("100"),
    );
    assert_eq!(again.fills.iter().filter(|x| touches(x, TP)).count(), 0);
}

#[test]
fn an_immediate_entry_with_a_partial_take_profit_does_not_let_the_stop_sell_that_size_again() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec("ask", Side::Sell, "2").acct("mm").price("100"),
    );
    submit(
        &mut book,
        spec("bid-99", Side::Buy, "1").acct("buyer").price("99"),
    );
    submit(
        &mut book,
        spec("bid-98", Side::Buy, "2").acct("buyer").price("98"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "2").price("100").exits("99", "99"),
    );

    assert!(result.accepted);
    assert_eq!(filled_qty(&result.fills, ENTRY), "2");
    assert_eq!(filled_qty(&result.fills, TP), "1");
    assert_eq!(filled_qty(&result.fills, SL), "1");
    let stop_fill = result
        .fills
        .iter()
        .find(|x| x.taker_order_id == SL)
        .unwrap();
    assert_eq!(f(stop_fill.price), "98");
    assert!(cancels(&result).contains(&pair(TP, "oco_sibling_filled")));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));
    assert!(position(&book, "desk").is_none());
}

#[test]
fn a_later_fill_of_the_resting_take_profit_pulls_the_stop() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "2").price("100").exits("100", "90"),
    );
    submit(
        &mut book,
        spec("bid-100", Side::Buy, "1").acct("buyer").price("100"),
    );
    submit(
        &mut book,
        spec("bid-80", Side::Buy, "5").acct("buyer").price("80"),
    );
    let opened = submit(
        &mut book,
        spec("hit", Side::Sell, "2").acct("mm").price("100"),
    );

    assert!(opened.accepted);
    assert_eq!(filled_qty(&opened.fills, TP), "1");
    assert_eq!(filled_qty(&opened.fills, SL), "0");
    assert_eq!(stop_qty(&book, SL), Some("1".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("1".to_owned()));

    let later = submit(
        &mut book,
        spec("lift", Side::Buy, "1").acct("mm").price("100"),
    );
    assert_eq!(filled_qty(&later.fills, TP), "1");
    assert!(cancels(&later).contains(&pair(SL, "oco_sibling_filled")));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    let print = submit(
        &mut book,
        spec("print-80", Side::Sell, "1").acct("mm").price("80"),
    );
    assert_eq!(traded_qty(&print, SL), "0");
    assert!(position(&book, "desk").is_none());
}

#[test]
fn a_take_profit_fill_on_the_triggered_outcome_sizes_the_stop_from_every_sale() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec("buy-stop-limit", Side::Buy, "1")
            .acct("chase")
            .ty(OrderType::StopLimit)
            .price("110")
            .stop("100"),
    );
    submit(
        &mut book,
        spec("buy-stop-105", Side::Buy, "1")
            .acct("chase")
            .ty(OrderType::Stop)
            .stop("105"),
    );
    submit(
        &mut book,
        spec("bid-99", Side::Buy, "5").acct("buyer").price("99"),
    );
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "3").price("100").exits("100", "110"),
    );
    let result = submit(
        &mut book,
        spec("hit", Side::Sell, "3").acct("mm").price("100"),
    );

    assert!(result.accepted);
    let at110 = every_fill(&result)
        .into_iter()
        .find(|x| touches(x, TP) && f(x.price) == "110");
    assert!(at110.is_some());
    assert_eq!(f(at110.unwrap().qty), "1");
    assert_eq!(traded_qty(&result, TP), "2");
    assert_eq!(traded_qty(&result, SL), "1");
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));
    assert!(position(&book, "desk").is_none());
}

#[test]
fn a_full_size_marketable_take_profit_flattens_and_does_not_fill_the_stop() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("100", "100"),
    );
    submit(
        &mut book,
        spec("behind", Side::Buy, "1").acct("buyer").price("100"),
    );
    let result = submit(
        &mut book,
        spec("hit", Side::Sell, "1").acct("mm").price("100"),
    );

    assert!(!result.accepted);
    assert_eq!(
        result.rejected.as_ref().map(|r| r.code.as_str()),
        Some("oco_sibling_terminal")
    );
    assert_eq!(filled_qty(&result.fills, SL), "0");
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));
    assert!(position(&book, "desk").is_none());
}

#[test]
fn a_rejected_stop_does_not_rest_the_take_profit() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(SL, Side::Buy, "1").acct("other").price("50"),
    );
    submit(
        &mut book,
        spec("ask", Side::Sell, "1").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    assert!(!result.accepted);
    assert!(!has(&live_ids(&book), TP));
    assert!(has(&live_ids(&book), SL));
}

#[test]
fn an_immediate_entry_fill_rests_the_exits_in_the_same_submit() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    assert!(result.accepted);
    assert!(!result.fills.is_empty());
    assert_eq!(live_ids(&book), sorted(&[SL, TP]));
    assert!(!has(&live_ids(&book), ENTRY));
}

#[test]
fn a_partial_market_entry_arms_the_exits_for_the_size_it_traded() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "2")
            .ty(OrderType::Market)
            .exits("110", "90"),
    );

    assert!(result.accepted);
    assert_eq!(filled_qty(&result.fills, ENTRY), "1");
    assert!(cancels(&result).contains(&pair(ENTRY, "market_remainder")));
    assert!(!has(&live_ids(&book), ENTRY));
    assert_eq!(stop_qty(&book, SL), Some("1".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("1".to_owned()));
}

#[test]
fn a_resting_entry_that_fills_across_submits_arms_both_children_for_the_size_it_traded() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "4").price("100").exits("110", "90"),
    );

    let first = submit(
        &mut book,
        spec("hit-1", Side::Sell, "1").acct("mm").price("100"),
    );
    assert_eq!(filled_qty(&first.fills, ENTRY), "1");
    assert!(has(&live_ids(&book), ENTRY));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    // One unit never trades. The original order is 4; the book now holds 2.
    let cut = book.amend(
        &EngineAmend {
            order_id: ENTRY.to_owned(),
            expected_version: 1,
            qty: Some(a("2")),
            ..EngineAmend::default()
        },
        None,
    );
    assert!(cut.accepted);
    assert_eq!(cut.fills.len(), 0);
    assert!(has(&live_ids(&book), ENTRY));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    let rest = submit(
        &mut book,
        spec("hit-2", Side::Sell, "2").acct("mm").price("100"),
    );
    assert!(rest.accepted);
    assert_eq!(filled_qty(&rest.fills, ENTRY), "2");
    assert!(!has(&live_ids(&book), ENTRY));
    // Traded 1 then 2. Not the original 4, and not the last slice of 2.
    assert_eq!(stop_qty(&book, SL), Some("3".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("3".to_owned()));
}

#[test]
fn a_partial_ioc_entry_arms_both_children_for_the_size_it_traded() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1.5").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "4")
            .price("100")
            .tif(Tif::Ioc)
            .exits("110", "90"),
    );

    assert!(result.accepted);
    assert!(result.rejected.is_none());
    assert_eq!(filled_qty(&result.fills, ENTRY), "1.5");
    let rows: Vec<(String, String, String)> = result
        .cancellations
        .iter()
        .map(|c| {
            (
                c.order_id.clone(),
                c.reason.as_str().to_owned(),
                f(c.remaining_qty),
            )
        })
        .collect();
    assert!(rows.contains(&(
        ENTRY.to_owned(),
        "ioc_remainder".to_owned(),
        "2.5".to_owned()
    )));
    assert!(!has(&live_ids(&book), ENTRY));
    assert_eq!(position_qty(&book, "desk"), Some("1.5".to_owned()));
    assert_eq!(stop_qty(&book, SL), Some("1.5".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("1.5".to_owned()));
}

#[test]
fn an_amend_fill_counts_in_the_size_both_children_arm_for() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "4").price("100").exits("110", "90"),
    );

    let first = submit(
        &mut book,
        spec("hit-1", Side::Sell, "1").acct("mm").price("100"),
    );
    assert_eq!(filled_qty(&first.fills, ENTRY), "1");
    assert!(has(&live_ids(&book), ENTRY));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    submit(
        &mut book,
        spec("ask-101", Side::Sell, "1").acct("mm").price("101"),
    );
    let amended = book.amend(
        &EngineAmend {
            order_id: ENTRY.to_owned(),
            expected_version: 1,
            price: Some(a("101")),
            ..EngineAmend::default()
        },
        None,
    );
    assert!(amended.accepted);
    assert_eq!(filled_qty(&amended.fills, ENTRY), "1");
    assert!(has(&live_ids(&book), ENTRY));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    let rest = submit(
        &mut book,
        spec("hit-2", Side::Sell, "2").acct("mm").price("101"),
    );
    assert!(rest.accepted);
    assert_eq!(filled_qty(&rest.fills, ENTRY), "2");
    assert!(!has(&live_ids(&book), ENTRY));
    assert_eq!(position_qty(&book, "desk"), Some("4".to_owned()));
    assert_eq!(stop_qty(&book, SL), Some("4".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("4".to_owned()));
}

#[test]
fn a_fill_from_another_bracket_exit_arms_the_resting_entry_for_the_size_it_traded() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(ENTRY, Side::Buy, "2")
            .acct("alpha")
            .price("100")
            .exits("110", "90"),
    );

    let first = submit(
        &mut book,
        spec("hit-a", Side::Sell, "1").acct("mm").price("100"),
    );
    assert_eq!(filled_qty(&first.fills, ENTRY), "1");
    assert!(has(&live_ids(&book), ENTRY));
    assert!(!has(&live_ids(&book), TP));
    assert!(!has(&live_ids(&book), SL));

    submit(
        &mut book,
        spec("ask-105", Side::Sell, "1").acct("mm").price("105"),
    );
    submit(
        &mut book,
        spec(ENTRY_B, Side::Buy, "1")
            .acct("beta")
            .price("105")
            .bracket()
            .tp("100")
            .sl("80")
            .tp_id(TP_B)
            .sl_id(SL_B),
    );

    assert!(!has(&live_ids(&book), ENTRY));
    assert_eq!(position_qty(&book, "alpha"), Some("2".to_owned()));
    assert_eq!(stop_qty(&book, SL), Some("2".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("2".to_owned()));

    submit(
        &mut book,
        spec("later", Side::Buy, "1").acct("gamma").price("50"),
    );
    assert_eq!(stop_qty(&book, SL), Some("2".to_owned()));
    assert_eq!(ask_remaining(&book, TP), Some("2".to_owned()));
    assert_eq!(position_qty(&book, "alpha"), Some("2".to_owned()));
}

#[test]
fn refuses_a_missing_take_profit_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").bracket().sl("90"),
    );
    assert!(!result.accepted);
    let rejected = result.rejected.as_ref().unwrap();
    assert_eq!(rejected.code, "missing_stop_price");
    assert!(
        rejected.message.contains("take-profit"),
        "{}",
        rejected.message
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[LIQ]));
}

#[test]
fn refuses_a_missing_stop_loss_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").bracket().tp("110"),
    );
    assert!(!result.accepted);
    let rejected = result.rejected.as_ref().unwrap();
    assert_eq!(rejected.code, "missing_stop_price");
    assert!(
        rejected.message.contains("stop-loss"),
        "{}",
        rejected.message
    );
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), Vec::<String>::new());
}

#[test]
fn refuses_a_missing_entry_last_on_the_book_is_not_a_trigger() {
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    let result = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1")
            .ty(OrderType::Limit)
            .bracket()
            .tp("110")
            .sl("90"),
    );
    assert!(!result.accepted);
    let rejected = result.rejected.as_ref().unwrap();
    assert_eq!(rejected.code, "missing_price");
    assert!(rejected.message.contains("entry"), "{}", rejected.message);
    assert_eq!(result.fills.len(), 0);
    assert_eq!(live_ids(&book), sorted(&[LIQ]));
}

#[test]
fn plain_gtc_does_not_rest_a_bracket() {
    let mut book = OrderBook::new("BTC/USDT");
    let result = submit(&mut book, spec(ENTRY, Side::Buy, "1").price("100"));
    assert!(result.accepted);
    assert_eq!(live_ids(&book), sorted(&[ENTRY]));
}

/// The TypeScript calls the five read helpers directly; the Rust inlines them in the bracket's submit, so each answer
/// is read from what submit does with that input (see the header).
#[test]
fn read_helpers_treat_missing_and_zero_as_not_set() {
    // `wantsBracket({})` is false: an order with no bracket flag rests plainly, with no exits armed after it trades.
    let mut book = OrderBook::new("BTC/USDT");
    let plain = submit(&mut book, spec(ENTRY, Side::Buy, "1").price("100"));
    assert!(plain.accepted);
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    assert_eq!(live_ids(&book), Vec::<String>::new());

    // `wantsBracket({ bracket: true })` is true: the bracket's own refusals run.
    let mut book = OrderBook::new("BTC/USDT");
    let flagged = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").bracket(),
    );
    assert_eq!(
        flagged.rejected.as_ref().map(|r| r.code.as_str()),
        Some("missing_stop_price")
    );

    // `readEntry({})`, `readEntry({ price: null })` and `readEntry({ price: 0 })` are null, so `entryRefuse` on a
    // limit refuses, and its message names the invented trigger.
    for price in [None, Some("0")] {
        let mut book = OrderBook::new("BTC/USDT");
        let mut s = spec(ENTRY, Side::Buy, "1")
            .ty(OrderType::Limit)
            .exits("110", "90");
        s.price = price;
        let result = submit(&mut book, s);
        assert!(!result.accepted);
        let rejected = result.rejected.as_ref().unwrap();
        assert_eq!(rejected.code, "missing_price");
        assert!(
            rejected.message.contains("invent a trigger"),
            "{}",
            rejected.message
        );
    }

    // `readEntry({ price: 100 })` is 100: the entry rests at 100.
    let mut book = OrderBook::new("BTC/USDT");
    let entry = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    assert!(entry.accepted);
    assert_eq!(entry.resting.as_ref().map(|r| r.price), Some(a("100")));

    // `readEntry({ type: 'market' })` is null and `entryRefuse({ type: 'market' })` is null: a market entry needs no
    // price and is not refused for one.
    let mut book = OrderBook::new("BTC/USDT");
    submit(
        &mut book,
        spec(LIQ, Side::Sell, "1").acct("mm").price("100"),
    );
    let market = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1")
            .ty(OrderType::Market)
            .exits("110", "90"),
    );
    assert!(market.accepted);
    assert!(market.rejected.is_none());

    // `takeProfitRefuse(null)` and `stopLossRefuse(null)` refuse with the invented trigger named.
    let mut book = OrderBook::new("BTC/USDT");
    let no_tp = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").bracket().sl("90"),
    );
    assert!(
        no_tp
            .rejected
            .as_ref()
            .unwrap()
            .message
            .contains("invent a trigger")
    );
    let no_sl = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").bracket().tp("110"),
    );
    assert!(
        no_sl
            .rejected
            .as_ref()
            .unwrap()
            .message
            .contains("invent a trigger")
    );

    // `takeProfitRefuse(110)` and `stopLossRefuse(90)` are null: both set, the bracket is accepted.
    let both = submit(
        &mut book,
        spec(ENTRY, Side::Buy, "1").price("100").exits("110", "90"),
    );
    assert!(both.accepted);
    assert!(both.rejected.is_none());
}
