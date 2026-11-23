//! `lot-book.test.ts`, case for case. Every figure here is hand-computed TEST data.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::common;

use std::collections::HashMap;

use common::{amt, assert_json, assert_match, find, list, some, text, utc};
use svc_tax::json::Json;
use svc_tax::lot_book::{BookInput, LotBook, build_lot_book};
use svc_tax::ports::{EngineMethod, Fill, FillLeg};
use svc_tax::tax::{
    Amount, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED,
    TAX_LOT_UNDERFLOW,
};
use svc_tax::time::Instant;

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 0, 0)
}

fn leg(asset: &str, qty: &str) -> FillLeg {
    FillLeg {
        asset_id: asset.to_owned(),
        amount: amt(qty),
    }
}

fn fill(tx: &str, day: i64, received: FillLeg, paid: Option<FillLeg>) -> Fill {
    Fill {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        received,
        paid,
        fee: None,
        fee_asset_id: None,
    }
}

fn buy(tx: &str, day: i64, asset: &str, qty: &str, paid: &str) -> Fill {
    fill(tx, day, leg(asset, qty), Some(leg("USDT", paid)))
}

fn sell(tx: &str, day: i64, asset: &str, qty: &str, got: &str) -> Fill {
    fill(tx, day, leg("USDT", got), Some(leg(asset, qty)))
}

fn held(entries: &[(&str, &str)]) -> HashMap<String, Amount> {
    entries
        .iter()
        .map(|(k, v)| ((*k).to_owned(), amt(v)))
        .collect()
}

fn book(
    fills: &[Fill],
    held: &HashMap<String, Amount>,
    method: EngineMethod,
    truncated: bool,
    outside: &[String],
) -> (LotBook, Json) {
    let b = build_lot_book(BookInput {
        fills,
        held,
        method,
        rules: None,
        preview: false,
        choices: None,
        truncated,
        outside_inflows: outside,
        inflows: &[],
        now: at(30),
        override_price_per_unit: None,
        moves: &[],
        carried_in: &[],
        spaces: None,
        space_held: None,
        withdrawals: &[],
        include_transfers: false,
    });
    let json = b.json();
    (b, json)
}

fn fifo(fills: &[Fill], held: &HashMap<String, Amount>, truncated: bool) -> (LotBook, Json) {
    book(fills, held, EngineMethod::Fifo, truncated, &[])
}

fn fills() -> Vec<Fill> {
    vec![
        buy("t1", 1, "BTC", "1", "100"),
        buy("t2", 2, "BTC", "1", "200"),
        sell("t3", 3, "BTC", "1", "300"),
    ]
}

fn sale(j: &Json) -> &Json {
    &list(j, "sales")[0]
}

fn asset<'a>(j: &'a Json, id: &str) -> &'a Json {
    find(list(j, "assets"), "assetId", id).unwrap()
}

#[test]
fn fifo_realises_200_and_leaves_the_200_lot_open() {
    let (b, j) = fifo(&fills(), &held(&[("BTC", "1"), ("USDT", "300")]), false);
    assert_json(
        j.get("sales").unwrap(),
        &format!(
            r#"[{{"kind":"sale","counted":"all","fee":{{"status":"unknown"}},"market":"BTC/USDT","method":"FIFO",
            "methodSource":"default","pickedLotId":null,"assetId":"BTC","txId":"t3","disposedAt":"{}","qty":"1",
            "unmatchedQty":"0","proceedsUsd":"300","costUsd":"100","realizedUsd":"200",
            "matches":[{{"lotId":"lot:t1:BTC","qty":"1","costUsd":"100","proceedsUsd":"300","realizedUsd":"200","counted":true}}]}}]"#,
            at(3).iso()
        ),
    );
    assert_eq!(text(&j, "realizedUsd"), some("200"));
    assert_json(
        asset(&j, "BTC"),
        r#"{"assetId":"BTC","openQty":"1","openCostUsd":"200","held":"1","uncountedQty":"0"}"#,
    );
    assert_eq!(text(&j, "indicator"), some("indicator_not_tax_advice"));
    assert!(b.residuals.is_empty());
}

#[test]
fn lifo_and_hifo_realise_100() {
    for method in [EngineMethod::Lifo, EngineMethod::Hifo] {
        let (_, j) = book(&fills(), &held(&[("BTC", "1")]), method, false, &[]);
        assert_eq!(text(&j, "realizedUsd"), some("100"), "{method:?}");
    }
}

#[test]
fn a_sale_of_deposited_coins_reaches_no_lot() {
    let (b, j) = fifo(
        &[sell("s1", 5, "BTC", "1", "300")],
        &held(&[("BTC", "1")]),
        false,
    );
    assert_match(
        sale(&j),
        r#"{"unmatchedQty":"1","costUsd":null,"realizedUsd":null,"proceedsUsd":"300"}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
    assert!(b.residuals.contains(&TAX_LOT_UNDERFLOW));
}

#[test]
fn a_sale_half_deposit_half_bought_is_unknown_as_a_whole() {
    let (_, j) = fifo(
        &[
            buy("b1", 1, "BTC", "1", "100"),
            sell("s1", 2, "BTC", "2", "500"),
        ],
        &held(&[("BTC", "0")]),
        false,
    );
    assert_match(
        sale(&j),
        r#"{"qty":"2","unmatchedQty":"1","realizedUsd":null}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn a_trade_between_two_non_dollar_coins_has_no_dollar_figure() {
    let swap = fill("x1", 1, leg("ETH", "10"), Some(leg("BTC", "1")));
    let (b, j) = fifo(
        &[buy("b1", 0, "BTC", "1", "100"), swap],
        &held(&[("ETH", "10")]),
        false,
    );
    assert_match(asset(&j, "ETH"), r#"{"openQty":"10","openCostUsd":null}"#);
    assert_match(
        sale(&j),
        r#"{"assetId":"BTC","proceedsUsd":null,"realizedUsd":null}"#,
    );
    assert!(b.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
}

#[test]
fn dollar_coin_for_dollar_coin_is_not_a_position() {
    let swap = fill("p1", 1, leg("USDC", "50"), Some(leg("USDT", "50")));
    let (_, j) = fifo(&[swap], &held(&[("USDC", "50")]), false);
    assert!(list(&j, "sales").is_empty());
    let ids: Vec<_> = list(&j, "assets")
        .iter()
        .map(|a| text(a, "assetId"))
        .collect();
    assert_eq!(ids, vec![some("USDC")]);
}

#[test]
fn more_open_in_lots_than_held_makes_that_cost_unknown() {
    let (b, j) = fifo(
        &[buy("b1", 1, "BTC", "1", "100")],
        &held(&[("BTC", "0.4")]),
        false,
    );
    assert_match(
        &list(&j, "assets")[0],
        r#"{"assetId":"BTC","openQty":"1","openCostUsd":null,"held":"0.4"}"#,
    );
    assert!(b.residuals.contains(&TAX_LOT_BOOK_UNRECONCILED));
    assert_json(j.get("outsideAssets").unwrap(), r#"["BTC"]"#);
}

#[test]
fn no_sale_is_a_null_result_not_a_zero() {
    let (_, j) = fifo(
        &[buy("b1", 1, "BTC", "1", "100")],
        &held(&[("BTC", "1")]),
        false,
    );
    assert!(list(&j, "sales").is_empty());
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn an_unread_paying_leg_and_a_cut_short_read_are_named() {
    let lonely = fill("l1", 1, leg("BTC", "1"), None);
    let (b, j) = fifo(&[lonely], &held(&[("BTC", "1")]), true);
    assert!(b.residuals.contains(&TAX_LOT_BOOK_INCOMPLETE));
    assert_match(
        &list(&j, "assets")[0],
        r#"{"openQty":"1","openCostUsd":null}"#,
    );
}

#[test]
fn an_empty_book_is_empty() {
    let (_, j) = fifo(&[], &held(&[]), false);
    assert_match(
        &j,
        r#"{"assets":[],"sales":[],"realizedUsd":null,"residuals":[]}"#,
    );
}

#[test]
fn coins_held_beyond_the_fills_make_the_result_unknown() {
    let (b, j) = fifo(
        &[
            buy("b1", 1, "BTC", "1", "100"),
            sell("s1", 2, "BTC", "1", "300"),
        ],
        &held(&[("BTC", "1")]),
        false,
    );
    assert_match(
        sale(&j),
        r#"{"costUsd":null,"realizedUsd":null,"proceedsUsd":"300"}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
    assert_match(
        asset(&j, "BTC"),
        r#"{"openQty":"0","openCostUsd":null,"held":"1"}"#,
    );
    assert!(b.residuals.contains(&TAX_LOT_BOOK_UNRECONCILED));
}

#[test]
fn a_cut_short_read_shows_no_result_and_no_cost() {
    let (b, j) = fifo(&fills(), &held(&[("BTC", "1")]), true);
    assert_eq!(text(&j, "realizedUsd"), None);
    assert_match(sale(&j), r#"{"realizedUsd":null,"costUsd":null}"#);
    assert_eq!(text(asset(&j, "BTC"), "openCostUsd"), None);
    assert!(b.residuals.contains(&TAX_LOT_BOOK_INCOMPLETE));
}

#[test]
fn dollar_coins_held_with_no_lots_are_not_unreconciled() {
    let (b, _) = fifo(&fills(), &held(&[("BTC", "1"), ("USDT", "300")]), false);
    assert!(b.residuals.is_empty());
}

#[test]
fn a_coin_that_arrived_outside_a_fill_makes_its_sales_unknown() {
    let (b, j) = book(
        &[
            buy("b1", 1, "ETH", "1", "2000"),
            sell("s1", 2, "ETH", "1", "3000"),
        ],
        &held(&[("USDT", "1000")]),
        EngineMethod::Fifo,
        false,
        &["ETH".to_owned()],
    );
    assert_eq!(text(sale(&j), "costUsd"), None);
    assert_eq!(text(sale(&j), "realizedUsd"), None);
    assert_eq!(text(&j, "realizedUsd"), None);
    assert!(b.residuals.contains(&TAX_LOT_BOOK_UNRECONCILED));
}

#[test]
fn a_dollar_coin_deposit_makes_nothing_unknown() {
    let (_, j) = book(
        &[
            buy("b1", 1, "ETH", "1", "2000"),
            sell("s1", 2, "ETH", "1", "3000"),
        ],
        &held(&[("USDT", "3000")]),
        EngineMethod::Fifo,
        false,
        &["USDT".to_owned()],
    );
    assert_eq!(text(&j, "realizedUsd"), some("1000"));
}
