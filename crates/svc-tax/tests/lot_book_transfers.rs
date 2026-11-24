//! `lot-book.transfers.test.ts`, case for case (J-portfolio-05 #2 and #3). Every figure is
//! hand-computed TEST data.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::common;
use service_kit::money::Amount;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, assert_match, find, list, some, text, utc};
use svc_tax::choices::MemoryChoiceStore;
use svc_tax::json::Json;
use svc_tax::own_moves::outside_withdrawals;
use svc_tax::ports::{
    AccountLine, Fill, FillLeg, InflowLine, PriceAtTime, TaxBalance, TradeFills, WithdrawalHold,
};
use svc_tax::tax::{
    DepositBasisPolicy, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_UNRECONCILED,
    TAX_PRICE_AT_TIME_UNAVAILABLE, TaxService,
};
use svc_tax::time::Instant;

const USER: &str = "u-transfers";

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 12, 0)
}

fn now() -> Instant {
    at(21)
}

fn leg(asset: &str, qty: &str) -> FillLeg {
    FillLeg {
        asset_id: asset.to_owned(),
        amount: amt(qty),
    }
}

/// Day 1: buy 1 BTC for 100 USDT, no fee (the ledger says 0).
fn buy() -> Fill {
    Fill {
        tx_id: "b1".to_owned(),
        posted_at: at(1),
        received: leg("BTC", "1"),
        paid: Some(leg("USDT", "100")),
        fee: Some(Amount::ZERO),
        fee_asset_id: None,
    }
}

/// Day 8: sell 0.5 BTC, 150 USDT received after a 1.5 USDT fee.
fn sell() -> Fill {
    Fill {
        tx_id: "s1".to_owned(),
        posted_at: at(8),
        received: leg("USDT", "150"),
        paid: Some(leg("BTC", "0.5")),
        fee: Some(amt("1.5")),
        fee_asset_id: None,
    }
}

/// Day 5: 0.5 BTC deposited from outside (worth 100 at 200).
fn deposit_on(day: i64) -> InflowLine {
    InflowLine {
        tx_id: "d1".to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        amount: amt("0.5"),
        reason: "deposit.credited".to_owned(),
    }
}

fn line(tx: &str, day: i64, amount: &str, reason: &str, debit: bool) -> AccountLine {
    AccountLine {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        amount: amt(amount),
        reason: reason.to_owned(),
        debit,
    }
}

/// Day 9: 0.5 BTC withdrawn (worth 125 at 250).
fn withdrawal() -> AccountLine {
    line("w1", 9, "0.5", "withdraw.held", false)
}

fn order_hold() -> AccountLine {
    line("h1", 8, "0.5", "order.hold", false)
}

fn held_on(tx: &str, day: i64, amount: &str) -> AccountLine {
    line(tx, day, amount, "withdraw.held", true)
}

fn settled_on(tx: &str, day: i64, amount: &str) -> AccountLine {
    line(tx, day, amount, "withdraw.settled", false)
}

fn back_on(tx: &str, day: i64, amount: &str) -> AccountLine {
    line(tx, day, amount, "withdraw.reversed", false)
}

fn hold(id: &str, lines: Vec<AccountLine>) -> WithdrawalHold {
    WithdrawalHold {
        purpose: format!("withdraw:{id}"),
        lines,
    }
}

fn settled_w1() -> WithdrawalHold {
    hold(
        "w1",
        vec![held_on("w1", 9, "0.5"), settled_on("w1-s", 9, "0.5")],
    )
}

fn btc_price(when: Instant) -> Option<svc_tax::ports::PriceAt> {
    let day = when.iso().get(8..10).map(str::to_owned);
    let price = match day.as_deref() {
        Some("05") => "200",
        Some("09") => "250",
        _ => "300",
    };
    Some(fake::minute_price(price, "BTC/USDT", when))
}

fn prices() -> Arc<dyn PriceAtTime> {
    fake::prices(|asset, when| {
        Ok(if asset == "BTC" {
            btc_price(when)
        } else {
            None
        })
    })
}

struct Reads {
    held: Vec<TaxBalance>,
    outflows: Option<Vec<AccountLine>>,
    holds: Option<Vec<WithdrawalHold>>,
    inflows: Option<Vec<InflowLine>>,
    fills: Option<Vec<Fill>>,
}

fn held_btc(amount: &str) -> Reads {
    Reads {
        held: vec![fake::balance(USER, "BTC", amount)],
        outflows: None,
        holds: None,
        inflows: None,
        fills: None,
    }
}

fn reads(o: Reads) -> Arc<FakeLedger> {
    let inflows = o.inflows.unwrap_or_else(|| vec![deposit_on(5)]);
    let mut outside: Vec<String> = inflows.iter().map(|i| i.asset_id.clone()).collect();
    outside.dedup();
    let mut outflows = vec![order_hold()];
    outflows.extend(o.outflows.unwrap_or_else(|| vec![withdrawal()]));
    Arc::new(FakeLedger {
        balances: o.held,
        fills: Some(Ok(TradeFills {
            fills: o.fills.unwrap_or_else(|| vec![buy(), sell()]),
            truncated: false,
            outside_inflows: outside,
            inflows: Some(inflows),
            outflows: Some(outflows),
            withdrawal_holds: Some(o.holds.unwrap_or_else(|| vec![settled_w1()])),
        })),
        ..FakeLedger::default()
    })
}

fn service_with(r: Arc<FakeLedger>, policy: DepositBasisPolicy) -> TaxService {
    let mut deps = fake::deps(r, now());
    deps.deposit_basis = Some(policy);
    deps.prices = Some(prices());
    deps.choices = Some(Arc::new(MemoryChoiceStore::new()));
    fake::service(deps)
}

fn service(r: Arc<FakeLedger>) -> TaxService {
    service_with(r, DepositBasisPolicy::Market)
}

fn book(tax: &TaxService, method: Option<&str>) -> Json {
    tax.lot_book(USER, method).unwrap().json()
}

fn include(tax: &TaxService, value: Option<bool>) {
    tax.set_include_transfers(USER, value).unwrap();
}

fn btc(j: &Json) -> &Json {
    find(list(j, "assets"), "assetId", "BTC").unwrap()
}

fn has(j: &Json, code: &str) -> bool {
    list(j, "residuals")
        .iter()
        .any(|r| r == &Json::str(code) || text(r, "code").as_deref() == Some(code))
}

fn sale(j: &Json, k: usize) -> &Json {
    &list(j, "sales")[k]
}

#[test]
fn transfers_count_by_default() {
    let j = book(&service(reads(held_btc("0.5"))), None);
    assert_eq!(j.get("includeTransfers"), Some(&Json::Bool(true)));
    let rows: Vec<_> = list(&j, "sales")
        .iter()
        .map(|s| {
            [
                text(s, "kind"),
                text(s, "counted"),
                text(s, "costUsd"),
                text(s, "proceedsUsd"),
                text(s, "realizedUsd"),
            ]
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            [
                some("moved_out"),
                some("all"),
                some("50"),
                some("125"),
                some("75")
            ],
            [
                some("sale"),
                some("all"),
                some("50"),
                some("150"),
                some("100")
            ],
        ]
    );
    assert_eq!(text(&j, "realizedUsd"), some("175"));
    assert_json(
        btc(&j),
        r#"{"assetId":"BTC","openQty":"0.5","openCostUsd":"100","held":"0.5","uncountedQty":"0"}"#,
    );
    assert!(!has(&j, TAX_LOT_BOOK_UNRECONCILED));
}

#[test]
fn transfers_left_out_stay_listed_but_count_for_nothing() {
    let tax = service(reads(held_btc("0.5")));
    include(&tax, Some(false));
    let j = book(&tax, None);
    assert_eq!(j.get("includeTransfers"), Some(&Json::Bool(false)));
    assert_match(
        j.get("choices").unwrap(),
        r#"{"status":"saved","includeTransfers":false}"#,
    );
    let rows: Vec<_> = list(&j, "sales")
        .iter()
        .map(|s| [text(s, "kind"), text(s, "counted"), text(s, "realizedUsd")])
        .collect();
    assert_eq!(
        rows,
        vec![
            [some("moved_out"), some("none"), None],
            [some("sale"), some("all"), some("100")],
        ]
    );
    assert!(
        list(sale(&j, 0), "matches")
            .iter()
            .all(|m| m.get("counted") == Some(&Json::Bool(false)))
    );
    assert_eq!(text(&j, "realizedUsd"), some("100"));
    let lots: Vec<_> = list(&j, "lots")
        .iter()
        .map(|l| (text(l, "source"), text(l, "counted")))
        .collect();
    assert_eq!(
        lots,
        vec![
            (some("trade"), some("true")),
            (some("deposit"), some("false"))
        ]
    );
    let ids: Vec<_> = list(sale(&j, 0), "matches")
        .iter()
        .map(|m| text(m, "lotId"))
        .collect();
    assert_eq!(ids, vec![some("lot:d1:BTC")]);
    assert_match(
        btc(&j),
        r#"{"openQty":"0.5","openCostUsd":"50","uncountedQty":"0","held":"0.5"}"#,
    );
    assert_eq!(
        book(&tax, Some("LIFO")).get("includeTransfers"),
        Some(&Json::Bool(false))
    );
    include(&tax, None);
    assert_eq!(text(&book(&tax, None), "realizedUsd"), some("175"));
}

fn older_deposit(held: &str) -> Reads {
    Reads {
        held: vec![fake::balance(USER, "BTC", held)],
        outflows: Some(vec![]),
        holds: Some(vec![]),
        inflows: Some(vec![deposit_on(0)]),
        fills: None,
    }
}

#[test]
fn left_out_a_sale_draws_on_bought_lots_first() {
    let tax = service(reads(older_deposit("1")));
    assert_match(
        book(&tax, None).get("sales").unwrap(),
        r#"[{"kind":"sale","counted":"all","realizedUsd":"0"}]"#,
    );
    include(&tax, Some(false));
    let j = book(&tax, None);
    assert_match(
        j.get("sales").unwrap(),
        r#"[{"kind":"sale","counted":"all","realizedUsd":"100","matches":[{"lotId":"lot:b1:BTC"}]}]"#,
    );
    assert_eq!(text(&j, "realizedUsd"), some("100"));
    assert_match(
        btc(&j),
        r#"{"openQty":"0.5","openCostUsd":"50","uncountedQty":"0.5"}"#,
    );
}

#[test]
fn left_out_a_deposit_with_no_cost_does_not_reach_a_trade_under_average_or_hifo() {
    let tax = service_with(reads(older_deposit("1")), DepositBasisPolicy::Customer);
    for method in ["AVERAGE", "HIFO"] {
        include(&tax, None);
        let on = book(&tax, Some(method));
        assert_match(sale(&on, 0), r#"{"realizedUsd":null}"#);
        assert!(has(&on, TAX_COST_BASIS_UNAVAILABLE), "{method}");
        include(&tax, Some(false));
        let off = book(&tax, Some(method));
        assert_match(
            sale(&off, 0),
            r#"{"counted":"all","costUsd":"50","realizedUsd":"100"}"#,
        );
        assert_match(
            btc(&off),
            r#"{"openQty":"0.5","openCostUsd":"50","uncountedQty":"0.5"}"#,
        );
        assert!(!has(&off, TAX_COST_BASIS_UNAVAILABLE), "{method}");
        assert_eq!(text(&off, "realizedUsd"), some("100"));
    }
}

#[test]
fn left_out_a_sale_bigger_than_the_bought_lots_counts_only_its_bought_part() {
    let mut big = sell();
    big.received = leg("USDT", "360");
    big.paid = Some(leg("BTC", "1.2"));
    let tax = service(reads(Reads {
        held: vec![fake::balance(USER, "BTC", "0.3")],
        outflows: Some(vec![]),
        holds: Some(vec![]),
        inflows: Some(vec![deposit_on(5)]),
        fills: Some(vec![buy(), big]),
    }));
    include(&tax, Some(false));
    let j = book(&tax, None);
    assert_match(
        j.get("sales").unwrap(),
        r#"[{"counted":"part","costUsd":"100","proceedsUsd":"300","realizedUsd":"200"}]"#,
    );
    assert_eq!(text(&j, "realizedUsd"), some("200"));
}

#[test]
fn a_withdrawal_held_on_its_way_out_is_gone_and_its_hold_is_not_held() {
    let mut r = held_btc("0");
    r.held.push(fake::balance_on(
        USER,
        "BTC",
        "0.5",
        "hold",
        Some("withdraw:w1"),
    ));
    r.held.push(fake::balance(USER, "BTC", "0.5"));
    let j = book(&service(reads(r)), None);
    assert_match(
        btc(&j),
        r#"{"held":"0.5","openQty":"0.5","openCostUsd":"100"}"#,
    );
    assert!(!has(&j, TAX_LOT_BOOK_UNRECONCILED));
}

#[test]
fn a_withdrawal_the_rail_put_back_did_not_happen() {
    let failed = hold(
        "w1",
        vec![held_on("w1", 9, "0.5"), back_on("w1-back", 10, "0.5")],
    );
    let mut r = held_btc("1");
    r.holds = Some(vec![failed]);
    let j = book(&service(reads(r)), None);
    let kinds: Vec<_> = list(&j, "sales").iter().map(|s| text(s, "kind")).collect();
    assert_eq!(kinds, vec![some("sale")]);
    assert_eq!(text(&j, "realizedUsd"), some("100"));
    assert_match(btc(&j), r#"{"openQty":"1","openCostUsd":"150","held":"1"}"#);
}

#[test]
fn a_withdrawal_with_no_price_when_it_left_has_an_unknown_result() {
    let mut deps = fake::deps(reads(held_btc("0.5")), now());
    deps.deposit_basis = Some(DepositBasisPolicy::Market);
    deps.prices = Some(fake::prices(|asset, when| {
        Ok(if when.iso().get(8..10) == Some("09") || asset != "BTC" {
            None
        } else {
            btc_price(when)
        })
    }));
    deps.choices = Some(Arc::new(MemoryChoiceStore::new()));
    let tax = fake::service(deps);
    let j = book(&tax, None);
    assert_match(
        sale(&j, 0),
        r#"{"kind":"moved_out","proceedsUsd":null,"realizedUsd":null}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
    assert!(has(&j, TAX_PRICE_AT_TIME_UNAVAILABLE));
    include(&tax, Some(false));
    let off = book(&tax, None);
    assert_eq!(text(&off, "realizedUsd"), some("100"));
    assert!(!has(&off, TAX_PRICE_AT_TIME_UNAVAILABLE));
}

#[test]
fn each_sale_fee_is_on_its_own_line_and_a_buy_fee_is_valued_at_the_fill_price() {
    let j = book(&service(reads(held_btc("0.5"))), None);
    let sales = list(&j, "sales");
    assert_json(
        find(sales, "kind", "sale").unwrap().get("fee").unwrap(),
        r#"{"status":"known","assetId":"USDT","amount":"1.5","usd":"1.5"}"#,
    );
    assert_eq!(find(sales, "kind", "moved_out").unwrap().get("fee"), None);
    assert_json(
        find(list(&j, "lots"), "source", "trade")
            .unwrap()
            .get("fee")
            .unwrap(),
        r#"{"status":"known","assetId":"BTC","amount":"0","usd":"0"}"#,
    );
    assert_eq!(text(&j, "feesUsd"), some("1.5"));
}

#[test]
fn a_fee_in_the_coin_bought_is_worth_what_the_fill_paid_for_it() {
    let mut fee_buy = buy();
    fee_buy.paid = Some(leg("USDT", "101"));
    fee_buy.fee = Some(amt("0.01"));
    let ledger = Arc::new(FakeLedger {
        balances: vec![fake::balance(USER, "BTC", "1")],
        fills: Some(Ok(TradeFills {
            fills: vec![fee_buy],
            truncated: false,
            outside_inflows: vec![],
            inflows: Some(vec![]),
            outflows: Some(vec![]),
            withdrawal_holds: Some(vec![]),
        })),
        ..FakeLedger::default()
    });
    let j = book(&fake::service(fake::deps(ledger, now())), None);
    assert_match(
        &list(&j, "lots")[0],
        r#"{"qty":"1","costUsd":"101","fee":{"status":"known","assetId":"BTC","amount":"0.01","usd":"1"}}"#,
    );
    assert_eq!(text(&j, "feesUsd"), some("1"));
}

// outsideWithdrawals

fn kept(holds: &[WithdrawalHold]) -> Vec<(String, Amount)> {
    outside_withdrawals(holds)
        .into_iter()
        .map(|l| (l.tx_id, l.amount))
        .collect()
}

#[test]
fn each_withdrawal_is_what_its_hold_took_in_less_what_went_back() {
    assert_eq!(
        kept(&[
            hold("a", vec![held_on("a", 2, "1"), settled_on("a-s", 3, "1")]),
            hold("b", vec![held_on("b", 4, "2"), back_on("b-r", 5, "2")]),
        ]),
        vec![("a".to_owned(), amt("1"))]
    );
}

#[test]
fn of_two_alike_in_flight_the_one_that_failed_is_cancelled() {
    let got: Vec<_> = outside_withdrawals(&[
        hold("A", vec![held_on("A", 2, "1"), back_on("A-r", 6, "1")]),
        hold("B", vec![held_on("B", 3, "1"), settled_on("B-s", 4, "1")]),
    ])
    .into_iter()
    .map(|l| (l.tx_id, l.posted_at))
    .collect();
    assert_eq!(got, vec![("B".to_owned(), at(3))]);
}

#[test]
fn a_partial_capture_counts_only_what_the_rail_took() {
    assert_eq!(
        kept(&[hold(
            "c",
            vec![
                held_on("c", 2, "1"),
                settled_on("c-s", 3, "0.6"),
                back_on("c-r", 3, "0.4")
            ]
        )]),
        vec![("c".to_owned(), amt("0.6"))]
    );
}

#[test]
fn a_hold_that_is_not_a_withdrawal_is_not_one() {
    assert!(
        outside_withdrawals(&[WithdrawalHold {
            purpose: "order:x".to_owned(),
            lines: vec![held_on("x", 2, "1")],
        }])
        .is_empty()
    );
    assert!(
        outside_withdrawals(&[hold("d", vec![line("d", 2, "1", "order.hold", true)])]).is_empty()
    );
}
