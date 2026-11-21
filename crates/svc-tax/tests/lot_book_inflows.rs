//! `lot-book.inflows.test.ts`, case for case. Every figure here is hand-computed TEST data.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, assert_match, find, list, some, text, utc};
use svc_tax::json::Json;
use svc_tax::lot_engine::LotSource;
use svc_tax::ports::{Fill, FillLeg, InflowLine, PriceAtTime, TradeFills};
use svc_tax::tax::{
    DepositBasisPolicy, TAX_DEPOSIT_BASIS_POLICY_UNSET, TAX_LOT_BOOK_UNRECONCILED,
    TAX_PRICE_AT_TIME_UNAVAILABLE, inflow_source,
};
use svc_tax::time::Instant;

const USER: &str = "u-1";

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 12, 0)
}

fn now() -> Instant {
    at(21)
}

fn fill(tx: &str, day: i64, received: (&str, &str), paid: (&str, &str)) -> Fill {
    Fill {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        received: FillLeg {
            asset_id: received.0.to_owned(),
            amount: amt(received.1),
        },
        paid: Some(FillLeg {
            asset_id: paid.0.to_owned(),
            amount: amt(paid.1),
        }),
        fee: None,
        fee_asset_id: None,
    }
}

fn buy() -> Fill {
    fill("b1", 1, ("BTC", "1"), ("USDT", "100"))
}

fn sell() -> Fill {
    fill("s1", 10, ("USDT", "300"), ("BTC", "1"))
}

fn inflow(tx: &str, day: i64, asset: &str, qty: &str, reason: &str) -> InflowLine {
    InflowLine {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: asset.to_owned(),
        amount: amt(qty),
        reason: reason.to_owned(),
    }
}

fn deposit() -> InflowLine {
    inflow("d1", 5, "BTC", "0.5", "deposit.credited")
}

fn reward() -> InflowLine {
    inflow("r1", 6, "BTC", "0.1", "bank.earn.interest")
}

fn reads(fills: Vec<Fill>, inflows: Vec<InflowLine>, held: &[(&str, &str)]) -> Arc<FakeLedger> {
    let mut outside: Vec<String> = inflows.iter().map(|i| i.asset_id.clone()).collect();
    outside.sort();
    outside.dedup();
    Arc::new(FakeLedger {
        balances: fake::held(USER, held),
        fills: Some(Ok(TradeFills {
            fills,
            truncated: false,
            outside_inflows: outside,
            inflows: Some(inflows),
            outflows: None,
            withdrawal_holds: None,
        })),
        ..FakeLedger::default()
    })
}

/// TEST prices: BTC at 200 on day 5 and 210 on day 6, by the minute candle.
fn prices() -> Arc<dyn PriceAtTime> {
    fake::prices(|asset, when| {
        Ok((asset == "BTC").then(|| {
            let day5 = when.iso().get(8..10) == Some("05");
            fake::minute_price(if day5 { "200" } else { "210" }, "BTC/USDT", when)
        }))
    })
}

fn book(
    ledger: Arc<FakeLedger>,
    policy: Option<DepositBasisPolicy>,
    with_prices: bool,
    method: Option<&str>,
) -> Json {
    let mut deps = fake::deps(ledger, now());
    deps.deposit_basis = policy;
    if with_prices {
        deps.prices = Some(prices());
    }
    fake::service(deps).lot_book(USER, method).unwrap().json()
}

fn residuals(j: &Json) -> Vec<String> {
    list(j, "residuals")
        .iter()
        .map(|r| match r {
            Json::String(s) => s.clone(),
            other => text(other, "code").unwrap_or_default(),
        })
        .collect()
}

fn lot(j: &Json, k: usize) -> &Json {
    &list(j, "lots")[k]
}

#[test]
fn a_deposit_and_a_reward_are_lots_valued_when_they_arrived() {
    let j = book(
        reads(vec![buy()], vec![deposit(), reward()], &[("BTC", "1.6")]),
        Some(DepositBasisPolicy::Customer),
        true,
        None,
    );
    let rows: Vec<_> = list(&j, "lots")
        .iter()
        .map(|l| {
            (
                text(l, "id"),
                text(l, "source"),
                text(l, "qty"),
                text(l, "costUsd"),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (some("lot:b1:BTC"), some("trade"), some("1"), some("100")),
            (some("lot:d1:BTC"), some("deposit"), some("0.5"), None),
            (some("lot:r1:BTC"), some("reward"), some("0.1"), None),
        ]
    );
    assert_json(
        lot(&j, 1).get("valuedAt").unwrap(),
        &format!(
            r#"{{"usd":"100","price":"200","market":"BTC/USDT","timeframe":"1m","candleAt":"{}"}}"#,
            at(5).iso()
        ),
    );
    assert_eq!(text(lot(&j, 2).get("valuedAt").unwrap(), "usd"), some("21"));
    assert_eq!(lot(&j, 0).get("valuedAt"), Some(&Json::Null));
    let days: Vec<_> = list(&j, "lots")
        .iter()
        .map(|l| text(l, "daysHeld"))
        .collect();
    assert_eq!(days, vec![some("20"), some("16"), some("15")]);
    assert!(
        list(&j, "lots")
            .iter()
            .all(|l| l.get("termClass") == Some(&Json::Null))
    );
    assert_json(
        j.get("termRule").unwrap(),
        r#"{"status":"unset","code":"tax.term_rule_unset"}"#,
    );
    assert_match(
        find(list(&j, "assets"), "assetId", "BTC").unwrap(),
        r#"{"openQty":"1.6","openCostUsd":null,"held":"1.6"}"#,
    );
    assert!(!residuals(&j).contains(&TAX_LOT_BOOK_UNRECONCILED.to_owned()));
}

#[test]
fn under_the_market_policy_an_arrival_costs_its_value_when_it_arrived() {
    let j = book(
        reads(vec![buy()], vec![deposit(), reward()], &[("BTC", "1.6")]),
        Some(DepositBasisPolicy::Market),
        true,
        None,
    );
    let costs: Vec<_> = list(&j, "lots")
        .iter()
        .map(|l| text(l, "costUsd"))
        .collect();
    assert_eq!(costs, vec![some("100"), some("100"), some("21")]);
    assert_eq!(
        text(
            find(list(&j, "assets"), "assetId", "BTC").unwrap(),
            "openCostUsd"
        ),
        some("221")
    );
}

#[test]
fn fifo_sells_the_bought_coin_first_and_lifo_reaches_the_deposit() {
    let first = book(
        reads(vec![buy(), sell()], vec![deposit()], &[("BTC", "0.5")]),
        Some(DepositBasisPolicy::Customer),
        true,
        None,
    );
    assert_match(
        &list(&first, "sales")[0],
        r#"{"realizedUsd":"200","costUsd":"100"}"#,
    );
    let lifo = book(
        reads(vec![buy(), sell()], vec![deposit()], &[("BTC", "0.5")]),
        Some(DepositBasisPolicy::Customer),
        true,
        Some("LIFO"),
    );
    let sale = &list(&lifo, "sales")[0];
    assert_match(
        sale,
        r#"{"costUsd":null,"realizedUsd":null,"unmatchedQty":"0"}"#,
    );
    let matches: Vec<_> = list(sale, "matches")
        .iter()
        .map(|m| (text(m, "lotId"), text(m, "qty"), text(m, "costUsd")))
        .collect();
    assert_eq!(
        matches,
        vec![
            (some("lot:d1:BTC"), some("0.5"), None),
            (some("lot:b1:BTC"), some("0.5"), some("50")),
        ]
    );
    assert_eq!(text(&lifo, "realizedUsd"), None);
}

#[test]
fn with_no_policy_or_no_price_source_the_gap_is_named() {
    let unset = book(
        reads(vec![buy()], vec![deposit()], &[("BTC", "1.5")]),
        None,
        true,
        None,
    );
    assert_match(lot(&unset, 1), r#"{"costUsd":null}"#);
    assert!(residuals(&unset).contains(&TAX_DEPOSIT_BASIS_POLICY_UNSET.to_owned()));
    let blind = book(
        reads(vec![buy()], vec![deposit()], &[("BTC", "1.5")]),
        Some(DepositBasisPolicy::Market),
        false,
        None,
    );
    assert_match(lot(&blind, 1), r#"{"costUsd":null,"valuedAt":null}"#);
    assert!(residuals(&blind).contains(&TAX_PRICE_AT_TIME_UNAVAILABLE.to_owned()));
}

#[test]
fn a_failed_price_read_leaves_that_value_unknown() {
    let mut deps = fake::deps(
        reads(vec![buy()], vec![deposit()], &[("BTC", "1.5")]),
        now(),
    );
    deps.deposit_basis = Some(DepositBasisPolicy::Market);
    deps.prices = Some(fake::prices(|_, _| Err(fake::internal("market data down"))));
    let j = fake::service(deps).lot_book(USER, None).unwrap().json();
    assert_match(lot(&j, 1), r#"{"costUsd":null,"valuedAt":null}"#);
    assert!(residuals(&j).contains(&TAX_PRICE_AT_TIME_UNAVAILABLE.to_owned()));
}

#[test]
fn a_dollar_coin_deposit_is_not_a_lot() {
    let usdt = inflow("u1", 2, "USDT", "500", "deposit.credited");
    let j = book(
        reads(
            vec![buy()],
            vec![usdt, deposit()],
            &[("BTC", "1"), ("USDT", "400")],
        ),
        Some(DepositBasisPolicy::Market),
        true,
        None,
    );
    let assets: Vec<_> = list(&j, "lots")
        .iter()
        .map(|l| text(l, "assetId"))
        .collect();
    assert_eq!(assets, vec![some("BTC"), some("BTC")]);
    assert_eq!(
        text(
            find(list(&j, "assets"), "assetId", "BTC").unwrap(),
            "openCostUsd"
        ),
        None
    );
    assert!(residuals(&j).contains(&TAX_LOT_BOOK_UNRECONCILED.to_owned()));
}

#[test]
fn names_where_a_coin_came_from_by_the_ledger_reason() {
    assert_eq!(inflow_source("deposit.credited"), LotSource::Deposit);
    assert_eq!(inflow_source("bank.earn.interest"), LotSource::Reward);
    assert_eq!(inflow_source("bank.transfer.manual"), LotSource::TransferIn);
    assert_eq!(inflow_source("loan.drawn"), LotSource::OtherIn);
}
