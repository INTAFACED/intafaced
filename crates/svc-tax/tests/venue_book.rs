//! `venue-book.test.ts`, case for case (J-cex-spot-01 #11, J-portfolio-04 #2, J-portfolio-02 #6).
//! Every figure is TEST. The TypeScript's `lotBookSchema.parse(book)` checks have no Rust counterpart: the Rust crate
//! does not hold the contracts' output schema (named in the port's report).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::collections::HashMap;

use common::{amt, assert_json, assert_match, date, f, find, list, some, text};
use svc_tax::json::Json;
use svc_tax::lot_book::{BookChoices, BookInput, Inflow, LotBook, build_lot_book};
use svc_tax::lot_engine::{LotSource, SaleRules};
use svc_tax::money::{Rounding, mul_div};
use svc_tax::ports::{
    EngineMethod, Fill, FillLeg, VenueAccountActivity, VenueActivity, VenueArrival, VenueBalance,
    VenueFill, VenueOwnMove,
};
use svc_tax::tax::Amount;
use svc_tax::time::Instant;
use svc_tax::venue_book::{
    BookShared, VenueExtras, key_of, venue_account_key, venue_arrival_lines, venue_fill_to_fill,
    with_venue,
};

const OWNER: &str = "0x00000000000000000000000000000000000000a1";
const ONE: Amount = 1_000_000_000_000_000_000;

fn account() -> String {
    format!("venue:test-venue:{OWNER}")
}

fn now() -> Instant {
    date("2026-11-12T00:00:00.000Z")
}

#[allow(clippy::too_many_arguments, reason = "the fill's own fields")]
fn fill(
    id: &str,
    buy: bool,
    price: &str,
    amount: &str,
    fee: &str,
    fee_asset: &str,
    at: &str,
) -> VenueFill {
    VenueFill {
        fill_id: id.to_owned(),
        symbol: "BTC-USDC".to_owned(),
        base: "BTC".to_owned(),
        quote: "USDC".to_owned(),
        buy,
        price: price.to_owned(),
        amount: amount.to_owned(),
        fee: fee.to_owned(),
        fee_asset: fee_asset.to_owned(),
        filled_at: at.to_owned(),
    }
}

fn buy_1() -> VenueFill {
    fill(
        "f1",
        true,
        "60000",
        "0.01",
        "0.00001",
        "BTC",
        "2026-11-10T03:00:00.000Z",
    )
}

fn buy_2() -> VenueFill {
    fill(
        "f2",
        true,
        "61000.5",
        "0.003",
        "0.000003",
        "BTC",
        "2026-11-10T03:05:00.000Z",
    )
}

fn sell() -> VenueFill {
    fill(
        "f3",
        false,
        "59400",
        "0.012",
        "0.7128",
        "USDC",
        "2026-11-11T03:00:00.000Z",
    )
}

fn balance(asset: &str, total: &str) -> VenueBalance {
    VenueBalance {
        asset: asset.to_owned(),
        total: total.to_owned(),
    }
}

fn activity(fills: Vec<VenueFill>, btc: &str) -> VenueAccountActivity {
    VenueAccountActivity {
        venue_id: "test-venue".to_owned(),
        owner: OWNER.to_owned(),
        sub_account: None,
        balances: vec![balance("USDC", "268.31"), balance("BTC", btc)],
        fills,
        transfers: None,
        arrivals: None,
        as_of: "2026-11-11T03:00:01.000Z".to_owned(),
    }
}

fn read(accounts: Vec<VenueAccountActivity>) -> VenueActivity {
    VenueActivity::Read {
        test: true,
        accounts,
    }
}

fn main_of(fills: &[Fill]) -> LotBook {
    build_lot_book(BookInput {
        fills,
        held: &HashMap::new(),
        method: EngineMethod::Fifo,
        rules: None,
        preview: false,
        choices: None,
        truncated: false,
        outside_inflows: &[],
        inflows: &[],
        now: now(),
        override_price_per_unit: None,
        moves: &[],
        carried_in: &[],
        spaces: None,
        space_held: None,
        withdrawals: &[],
        include_transfers: false,
    })
}

fn empty_main() -> LotBook {
    main_of(&[])
}

fn venue_with(
    main: LotBook,
    activity: Option<&VenueActivity>,
    method: EngineMethod,
    extras: &VenueExtras<'_>,
) -> Json {
    let rules = SaleRules::One(method);
    let shared = BookShared {
        method,
        rules: &rules,
        preview: false,
        choices: BookChoices::Unwired,
        include_transfers: true,
        now: now(),
    };
    with_venue(main, activity, &shared, extras).unwrap().json()
}

fn venue(main: LotBook, activity: &VenueActivity) -> Json {
    venue_with(
        main,
        Some(activity),
        EngineMethod::Fifo,
        &VenueExtras::default(),
    )
}

fn u(v: &str) -> Amount {
    amt(v)
}

fn usd(price: &str, amount: &str) -> Amount {
    mul_div(u(price), u(amount), ONE, Rounding::Trunc)
}

/// The FIFO result worked out by hand from the venue's own fills, as the journey test does (realisedFifo).
fn expected_realised(buys: &[VenueFill], sells: &[VenueFill]) -> String {
    let lots: Vec<(Amount, Amount)> = buys
        .iter()
        .map(|f| {
            (
                u(&f.amount) - if f.fee_asset == "BTC" { u(&f.fee) } else { 0 },
                usd(&f.price, &f.amount) + if f.fee_asset == "USDC" { u(&f.fee) } else { 0 },
            )
        })
        .collect();
    let mut left: Amount = sells.iter().map(|f| u(&f.amount)).sum();
    let proceeds: Amount = sells
        .iter()
        .map(|f| usd(&f.price, &f.amount) - if f.fee_asset == "USDC" { u(&f.fee) } else { 0 })
        .sum();
    let mut used = 0;
    for (qty, cost) in lots {
        if left == 0 {
            break;
        }
        let take = left.min(qty);
        used += if take == qty {
            cost
        } else {
            mul_div(cost, take, qty, Rounding::Trunc)
        };
        left -= take;
    }
    f(proceeds - used)
}

fn has(j: &Json, code: &str) -> bool {
    list(j, "residuals").contains(&Json::str(code))
}

fn ledger_fill(tx: &str, at: &str, received: (&str, &str), paid: (&str, &str)) -> Fill {
    Fill {
        tx_id: tx.to_owned(),
        posted_at: date(at),
        received: FillLeg {
            asset_id: received.0.to_owned(),
            amount: u(received.1),
        },
        paid: Some(FillLeg {
            asset_id: paid.0.to_owned(),
            amount: u(paid.1),
        }),
        fee: Some(0),
        fee_asset_id: None,
    }
}

// venue fills as lot book fills

#[test]
fn a_buy_receives_the_coin_less_the_fee_and_pays_price_times_amount() {
    let x = venue_fill_to_fill(&account(), &buy_1()).unwrap();
    assert_eq!(x.tx_id, format!("{}:f1", account()));
    assert_eq!(
        (x.received.asset_id.as_str(), x.received.amount),
        ("BTC", u("0.00999"))
    );
    let paid = x.paid.unwrap();
    assert_eq!((paid.asset_id.as_str(), paid.amount), ("USDC", u("600")));
    assert_eq!(x.fee, Some(u("0.00001")));
    assert_eq!(x.fee_asset_id, None);
}

#[test]
fn a_sale_receives_the_dollars_less_the_fee_and_pays_the_coins_sold() {
    let x = venue_fill_to_fill(&account(), &sell()).unwrap();
    assert_eq!(
        (x.received.asset_id.as_str(), x.received.amount),
        ("USDC", u("712.8") - u("0.7128"))
    );
    let paid = x.paid.unwrap();
    assert_eq!((paid.asset_id.as_str(), paid.amount), ("BTC", u("0.012")));
}

#[test]
fn a_fee_in_the_coin_paid_is_inside_what_was_paid() {
    let mut b = buy_1();
    b.fee = "0.6".to_owned();
    b.fee_asset = "USDC".to_owned();
    let x = venue_fill_to_fill(&account(), &b).unwrap();
    assert_eq!(x.received.amount, u("0.01"));
    assert_eq!(x.paid.unwrap().amount, u("600.6"));
    assert_eq!(x.fee_asset_id.as_deref(), Some("USDC"));
}

#[test]
fn a_fee_in_a_third_coin_is_unknown_rather_than_guessed() {
    let mut b = buy_1();
    b.fee = "1".to_owned();
    b.fee_asset = "HYPE".to_owned();
    let x = venue_fill_to_fill(&account(), &b).unwrap();
    assert_eq!(x.received.amount, u("0.01"));
    assert_eq!(x.paid.unwrap().amount, u("600"));
    assert_eq!(x.fee, None);
}

#[test]
fn the_account_key_names_the_venue_the_owner_and_a_sub_account() {
    assert_eq!(
        venue_account_key("v", OWNER, None),
        format!("venue:v:{OWNER}")
    );
    assert_eq!(
        venue_account_key("v", OWNER, Some("s1")),
        format!("venue:v:{OWNER}:s1")
    );
}

// the venue account beside the ledger book (J-cex-spot-01 #11)

#[test]
fn after_the_buys_the_lots_are_open_at_cost_and_hold_what_the_venue_holds() {
    let j = venue(
        empty_main(),
        &read(vec![activity(vec![buy_1(), buy_2()], "0.012987")]),
    );
    let lots: Vec<_> = list(&j, "lots")
        .iter()
        .filter(|l| text(l, "assetId").as_deref() == Some("BTC"))
        .collect();
    let rows: Vec<_> = lots
        .iter()
        .map(|l| {
            [
                text(l, "id"),
                text(l, "venueAccount"),
                text(l, "source"),
                text(l, "remaining"),
                text(l, "costUsd"),
                text(l, "daysHeld"),
            ]
        })
        .collect();
    let a = account();
    assert_eq!(
        rows,
        vec![
            [
                some(&format!("lot:{a}:f1:BTC")),
                some(&a),
                some("trade"),
                some("0.00999"),
                some("600"),
                some("1")
            ],
            [
                some(&format!("lot:{a}:f2:BTC")),
                some(&a),
                some("trade"),
                some("0.002997"),
                some("183.0015"),
                some("1")
            ],
        ]
    );
    let total: Amount = lots.iter().map(|l| u(&text(l, "remaining").unwrap())).sum();
    assert_eq!(total, u("0.012987"));
    assert_json(
        j.get("assets").unwrap(),
        &format!(
            r#"[{{"assetId":"BTC","openQty":"0.012987","openCostUsd":"783.0015","held":"0.012987","uncountedQty":"0","venueAccount":"{a}"}}]"#
        ),
    );
    assert!(list(&j, "sales").is_empty());
    assert_eq!(text(&j, "realizedUsd"), None);
    assert_json(
        j.get("venue").unwrap(),
        &format!(
            r#"{{"status":"read","test":true,"accounts":[{{"account":"{a}","venueId":"test-venue","owner":"{OWNER}","subAccount":null,"asOf":"2026-11-11T03:00:01.000Z"}}]}}"#
        ),
    );
    assert!(!has(&j, "tax.lot_book_unreconciled"));
    assert!(!has(&j, "tax.venue_unavailable"));
}

#[test]
fn after_the_sale_the_result_is_fifo_over_the_venue_fills() {
    let j = venue(
        empty_main(),
        &read(vec![activity(vec![buy_1(), buy_2(), sell()], "0.000987")]),
    );
    let want = expected_realised(&[buy_1(), buy_2()], &[sell()]);
    assert_eq!(text(&j, "realizedUsd"), Some(want.clone()));
    assert_eq!(list(&j, "sales").len(), 1);
    assert_match(
        &list(&j, "sales")[0],
        &format!(
            r#"{{"kind":"sale","venueAccount":"{}","assetId":"BTC","qty":"0.012","market":"BTC/USDC","realizedUsd":"{want}",
            "fee":{{"status":"known","assetId":"USDC","amount":"0.7128","usd":"0.7128"}}}}"#,
            account()
        ),
    );
    let open: Vec<_> = list(&j, "lots")
        .iter()
        .filter(|l| u(&text(l, "remaining").unwrap()) > 0)
        .map(|l| (text(l, "id"), text(l, "remaining")))
        .collect();
    assert_eq!(
        open,
        vec![(some(&format!("lot:{}:f2:BTC", account())), some("0.000987"))]
    );
    assert_match(
        &list(&j, "assets")[0],
        r#"{"openQty":"0.000987","held":"0.000987"}"#,
    );
}

#[test]
fn the_ledger_and_venue_results_add_up_and_never_mix() {
    let main = main_of(&[
        ledger_fill(
            "tx-buy",
            "2026-11-01T00:00:00Z",
            ("ETH", "0.1"),
            ("USDT", "300"),
        ),
        ledger_fill(
            "tx-sell",
            "2026-11-02T00:00:00Z",
            ("USDT", "320"),
            ("ETH", "0.1"),
        ),
    ]);
    assert_eq!(main.json().get("realizedUsd"), Some(&Json::str("20")));
    let j = venue(
        main,
        &read(vec![activity(vec![buy_1(), buy_2(), sell()], "0.000987")]),
    );
    let want = f(u("20") + u(&expected_realised(&[buy_1(), buy_2()], &[sell()])));
    assert_eq!(text(&j, "realizedUsd"), Some(want));
    let ledger_sale = find(list(&j, "sales"), "txId", "tx-sell").unwrap();
    assert_eq!(ledger_sale.get("venueAccount"), None);
    let ids: Vec<_> = list(ledger_sale, "matches")
        .iter()
        .map(|m| text(m, "lotId"))
        .collect();
    assert_eq!(ids, vec![some("lot:tx-buy:ETH")]);
}

#[test]
fn a_venue_coin_that_arrived_other_than_by_a_fill_does_not_reconcile() {
    let j = venue(
        empty_main(),
        &read(vec![activity(vec![buy_1(), buy_2(), sell()], "0.500987")]),
    );
    assert!(has(&j, "tax.lot_book_unreconciled"));
    assert_match(
        &list(&j, "assets")[0],
        r#"{"openCostUsd":null,"held":"0.500987"}"#,
    );
    assert_eq!(text(&list(&j, "sales")[0], "realizedUsd"), None);
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn two_venue_accounts_stay_apart() {
    let other = "0x00000000000000000000000000000000000000b2";
    let a = activity(vec![buy_1()], "0.00999");
    let mut g1 = sell();
    g1.fill_id = "g1".to_owned();
    g1.amount = "0.00999".to_owned();
    g1.fee = "0".to_owned();
    let mut b = activity(vec![g1], "0");
    b.owner = other.to_owned();
    let j = venue(empty_main(), &read(vec![a, b]));
    let sale = find(
        list(&j, "sales"),
        "venueAccount",
        &format!("venue:test-venue:{other}"),
    )
    .unwrap();
    assert!(list(sale, "matches").is_empty());
    assert_eq!(text(sale, "unmatchedQty"), some("0.00999"));
    assert_eq!(
        text(
            find(list(&j, "lots"), "venueAccount", &account()).unwrap(),
            "remaining"
        ),
        some("0.00999")
    );
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn a_dollar_coin_on_the_venue_is_not_a_position() {
    let j = venue(
        empty_main(),
        &read(vec![activity(vec![buy_1()], "0.00999")]),
    );
    let ids: Vec<_> = list(&j, "assets")
        .iter()
        .map(|a| text(a, "assetId"))
        .collect();
    assert_eq!(ids, vec![some("BTC")]);
}

#[test]
fn the_venue_not_read_shows_no_venue_figure_and_no_total() {
    let main = main_of(&[
        ledger_fill("t1", "2026-11-01T00:00:00Z", ("ETH", "1"), ("USDT", "3000")),
        ledger_fill("t2", "2026-11-02T00:00:00Z", ("USDT", "3100"), ("ETH", "1")),
    ]);
    let j = venue(main, &VenueActivity::Unavailable);
    assert_json(
        j.get("venue").unwrap(),
        r#"{"status":"unavailable","code":"tax.venue_unavailable"}"#,
    );
    assert!(has(&j, "tax.venue_unavailable"));
    assert_eq!(text(&j, "realizedUsd"), None);
    assert_eq!(text(&j, "feesUsd"), None);
    assert!(
        list(&j, "lots")
            .iter()
            .all(|l| l.get("venueAccount").is_none())
    );
}

#[test]
fn the_door_off_or_unwired_leaves_the_ledger_book_and_says_which() {
    let with = |venue_json: &str| {
        let mut m = empty_main().json();
        // `{ ...main, venue }`: replaced where it is, added last where it is not.
        if let Json::Object(fields) = &mut m {
            let venue = svc_tax::json::parse(venue_json).unwrap();
            match fields.iter_mut().find(|(k, _)| k == "venue") {
                Some((_, v)) => *v = venue,
                None => fields.push(("venue".to_owned(), venue)),
            }
        }
        m
    };
    let extras = VenueExtras::default();
    assert_eq!(
        venue_with(
            empty_main(),
            Some(&VenueActivity::Off),
            EngineMethod::Fifo,
            &extras
        )
        .compact(),
        with(r#"{"status":"off","code":"tax.venue_off"}"#).compact()
    );
    assert_eq!(
        venue_with(empty_main(), None, EngineMethod::Fifo, &extras).compact(),
        with(r#"{"status":"unwired","code":"tax.venue_unwired"}"#).compact()
    );
    assert_eq!(
        venue(empty_main(), &read(vec![])).compact(),
        with(r#"{"status":"read","test":true,"accounts":[]}"#).compact()
    );
}

// a move into the person's own venue sub-account carries the lots (J-portfolio-04 #2)

const SUB: &str = "0x00000000000000000000000000000000000000c5";
const MOVED_AT: &str = "2026-11-11T01:00:00.000Z";

fn sub_key() -> String {
    format!("venue:test-venue:{OWNER}:{SUB}")
}

fn fill_a() -> VenueFill {
    fill(
        "a",
        true,
        "60000",
        "0.6",
        "0",
        "BTC",
        "2026-11-10T01:00:00.000Z",
    )
}

fn fill_b() -> VenueFill {
    fill(
        "b",
        true,
        "61000",
        "0.6",
        "0",
        "BTC",
        "2026-11-10T02:00:00.000Z",
    )
}

fn main_account(
    transfers: Vec<VenueOwnMove>,
    btc: &str,
    fills: Vec<VenueFill>,
) -> VenueAccountActivity {
    let mut a = activity(fills, btc);
    a.transfers = Some(transfers);
    a
}

fn sub(btc: &str, fills: Vec<VenueFill>) -> VenueAccountActivity {
    VenueAccountActivity {
        venue_id: "test-venue".to_owned(),
        owner: OWNER.to_owned(),
        sub_account: Some(SUB.to_owned()),
        balances: vec![balance("BTC", btc)],
        fills,
        transfers: None,
        arrivals: None,
        as_of: "2026-11-11T03:00:01.000Z".to_owned(),
    }
}

fn into(amount: &str, id: &str, at: &str) -> VenueOwnMove {
    VenueOwnMove {
        move_id: id.to_owned(),
        sub_account: SUB.to_owned(),
        into_sub_account: true,
        asset: "BTC".to_owned(),
        amount: amount.to_owned(),
        settled_at: at.to_owned(),
    }
}

fn lots_in<'a>(j: &'a Json, account: &str) -> Vec<&'a Json> {
    list(j, "lots")
        .iter()
        .filter(|l| text(l, "venueAccount").as_deref() == Some(account))
        .collect()
}

#[test]
fn fifo_the_oldest_lot_and_a_share_of_the_next_arrive_in_the_sub_account() {
    let j = venue(
        empty_main(),
        &read(vec![
            main_account(
                vec![into("1", "n1", MOVED_AT)],
                "0.2",
                vec![fill_a(), fill_b()],
            ),
            sub("1", vec![]),
        ]),
    );
    let moved = lots_in(&j, &sub_key());
    let rows: Vec<_> = moved
        .iter()
        .map(|l| {
            let c = l.get("carriedFrom").unwrap();
            [
                text(l, "acquiredAt"),
                text(l, "source"),
                text(l, "qty"),
                text(l, "remaining"),
                text(l, "costUsd"),
                text(l, "remainingCostUsd"),
                text(c, "lotId"),
                text(c, "movedAt"),
            ]
        })
        .collect();
    let a = account();
    assert_eq!(
        rows,
        vec![
            [
                some(&fill_a().filled_at),
                some("trade"),
                some("0.6"),
                some("0.6"),
                some("36000"),
                some("36000"),
                some(&format!("lot:{a}:a:BTC")),
                some(MOVED_AT)
            ],
            [
                some(&fill_b().filled_at),
                some("trade"),
                some("0.4"),
                some("0.4"),
                some("24400"),
                some("24400"),
                some(&format!("lot:{a}:b:BTC")),
                some(MOVED_AT)
            ],
        ]
    );
    assert!(moved.iter().all(|l| l.get("fee").is_none()));
    let left: Vec<_> = lots_in(&j, &a)
        .iter()
        .map(|l| {
            [
                text(l, "id"),
                text(l, "remaining"),
                text(l, "remainingCostUsd"),
            ]
        })
        .collect();
    assert_eq!(
        left,
        vec![
            [some(&format!("lot:{a}:a:BTC")), some("0"), some("0")],
            [some(&format!("lot:{a}:b:BTC")), some("0.2"), some("12200")],
        ]
    );
    assert!(list(&j, "residuals").is_empty());
    assert!(list(&j, "sales").is_empty());
    let assets: Vec<_> = list(&j, "assets")
        .iter()
        .filter(|x| text(x, "assetId").as_deref() == Some("BTC"))
        .map(|x| {
            [
                text(x, "venueAccount"),
                text(x, "openQty"),
                text(x, "openCostUsd"),
                text(x, "held"),
            ]
        })
        .collect();
    assert_eq!(
        assets,
        vec![
            [some(&a), some("0.2"), some("12200"), some("0.2")],
            [some(&sub_key()), some("1"), some("60400"), some("1")],
        ]
    );
}

#[test]
fn lifo_moves_the_newest_lot_first() {
    let j = venue_with(
        empty_main(),
        Some(&read(vec![
            main_account(
                vec![into("1", "n1", MOVED_AT)],
                "0.2",
                vec![fill_a(), fill_b()],
            ),
            sub("1", vec![]),
        ])),
        EngineMethod::Lifo,
        &VenueExtras::default(),
    );
    let rows: Vec<_> = lots_in(&j, &sub_key())
        .iter()
        .map(|l| [text(l, "acquiredAt"), text(l, "qty"), text(l, "costUsd")])
        .collect();
    assert_eq!(
        rows,
        vec![
            [some(&fill_a().filled_at), some("0.4"), some("24000")],
            [some(&fill_b().filled_at), some("0.6"), some("36600")],
        ]
    );
}

#[test]
fn a_sale_in_the_sub_account_draws_on_the_lots_carried_there() {
    let sell_sub = fill(
        "s",
        false,
        "62000",
        "0.5",
        "0",
        "USDC",
        "2026-11-11T02:00:00.000Z",
    );
    let j = venue(
        empty_main(),
        &read(vec![
            main_account(
                vec![into("1", "n1", MOVED_AT)],
                "0.2",
                vec![fill_a(), fill_b()],
            ),
            sub("0.5", vec![sell_sub]),
        ]),
    );
    let sale = find(list(&j, "sales"), "venueAccount", &sub_key()).unwrap();
    assert_eq!(
        [
            text(sale, "costUsd"),
            text(sale, "proceedsUsd"),
            text(sale, "realizedUsd")
        ],
        [some("30000"), some("31000"), some("1000")]
    );
    let ids: Vec<_> = list(sale, "matches")
        .iter()
        .map(|m| text(m, "lotId"))
        .collect();
    assert_eq!(ids, vec![text(lots_in(&j, &sub_key())[0], "id")]);
    assert_eq!(
        lots_in(&j, &account())
            .iter()
            .find(|l| text(l, "remaining").as_deref() != Some("0"))
            .and_then(|l| text(l, "remaining")),
        some("0.2")
    );
    assert!(list(&j, "residuals").is_empty());
}

#[test]
fn a_move_with_no_lot_behind_it_arrives_with_no_basis() {
    let j = venue(
        empty_main(),
        &read(vec![
            main_account(vec![into("1", "n1", MOVED_AT)], "0", vec![]),
            sub("1", vec![]),
        ]),
    );
    let rows: Vec<_> = lots_in(&j, &sub_key())
        .iter()
        .map(|l| [text(l, "source"), text(l, "qty"), text(l, "costUsd")])
        .collect();
    assert_eq!(rows, vec![[some("transfer_in"), some("1"), None]]);
    assert!(has(&j, "tax.cost_basis_unavailable"));
}

#[test]
fn a_move_back_out_of_a_sub_account_is_not_followed() {
    let mut out = into("0.3", "n2", "2026-11-11T02:00:00.000Z");
    out.into_sub_account = false;
    let j = venue(
        empty_main(),
        &read(vec![
            main_account(
                vec![into("1", "n1", MOVED_AT), out],
                "0.5",
                vec![fill_a(), fill_b()],
            ),
            sub("0.7", vec![]),
        ]),
    );
    assert!(has(&j, "tax.lot_book_unreconciled"));
    for key in [account(), sub_key()] {
        let a = list(&j, "assets")
            .iter()
            .find(|a| {
                text(a, "venueAccount").as_deref() == Some(key.as_str())
                    && text(a, "assetId").as_deref() == Some("BTC")
            })
            .unwrap();
        assert_eq!(text(a, "openCostUsd"), None, "{key}");
    }
}

// coins the venue credited from outside (J-portfolio-02 #6)

const ARRIVED: &str = "2026-11-10T01:00:00.000Z";

fn sale_f9() -> VenueFill {
    fill(
        "f9",
        false,
        "59400",
        "0.02",
        "1.188",
        "USDC",
        "2026-11-11T03:00:00.000Z",
    )
}

fn credited() -> VenueAccountActivity {
    let mut a = activity(vec![sale_f9()], "0.03");
    a.arrivals = Some(vec![VenueArrival {
        arrival_id: "84532:0xabc:0".to_owned(),
        kind: "deposit".to_owned(),
        asset: "BTC".to_owned(),
        amount: "0.05".to_owned(),
        arrived_at: ARRIVED.to_owned(),
    }]);
    a
}

/// As svc-tax values them under a policy that leaves the cost to the customer: no cost, never zero.
fn inflows_of(a: &VenueAccountActivity) -> HashMap<String, Vec<Inflow>> {
    let lines = venue_arrival_lines(a)
        .unwrap()
        .into_iter()
        .map(|l| Inflow {
            tx_id: l.tx_id,
            posted_at: l.posted_at,
            asset_id: l.asset_id,
            amount: l.amount,
            reason: l.reason,
            source: LotSource::Deposit,
            cost_usd: None,
            valued_at: None,
            space_id: None,
        })
        .collect();
    HashMap::from([(key_of(a), lines)])
}

fn proceeds() -> Amount {
    u("1188") - u("1.188")
}

fn credited_book(prices: Option<&HashMap<String, Amount>>) -> Json {
    let a = credited();
    venue_with(
        empty_main(),
        Some(&read(vec![a.clone()])),
        EngineMethod::Fifo,
        &VenueExtras {
            inflows: inflows_of(&a),
            override_price_per_unit: prices,
        },
    )
}

#[test]
fn each_credit_is_an_arrival_line_keyed_by_the_account_and_the_venue_id() {
    let lines = venue_arrival_lines(&credited()).unwrap();
    assert_eq!(lines.len(), 1);
    let l = &lines[0];
    assert_eq!(l.tx_id, format!("{}:arrival:84532:0xabc:0", account()));
    assert_eq!(
        (
            l.posted_at,
            l.asset_id.as_str(),
            l.amount,
            l.reason.as_str()
        ),
        (date(ARRIVED), "BTC", u("0.05"), "deposit.venue")
    );
    assert!(
        venue_arrival_lines(&activity(vec![sale_f9()], "0.03"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_credit_is_a_lot_with_no_cost_and_the_total_stays_blank() {
    let j = credited_book(None);
    assert!(!has(&j, "tax.lot_book_unreconciled"));
    assert!(has(&j, "tax.cost_basis_unavailable"));
    let lot = find(list(&j, "lots"), "source", "deposit").unwrap();
    assert_match(
        lot,
        &format!(
            r#"{{"assetId":"BTC","qty":"0.05","remaining":"0.03","costUsd":null,"venueAccount":"{}"}}"#,
            account()
        ),
    );
    let sale = &list(&j, "sales")[0];
    assert_match(
        sale,
        &format!(
            r#"{{"assetId":"BTC","qty":"0.02","proceedsUsd":"{}","realizedUsd":null,"venueAccount":"{}"}}"#,
            f(proceeds()),
            account()
        ),
    );
    let matches: Vec<_> = list(sale, "matches")
        .iter()
        .map(|m| (text(m, "lotId"), text(m, "costUsd")))
        .collect();
    assert_eq!(matches, vec![(text(lot, "id"), None)]);
    assert_match(
        &list(&j, "assets")[0],
        r#"{"assetId":"BTC","openQty":"0.03","openCostUsd":null,"held":"0.03"}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn a_price_the_person_enters_gives_the_lot_its_cost() {
    let lot_id = text(
        find(list(&credited_book(None), "lots"), "source", "deposit").unwrap(),
        "id",
    )
    .unwrap();
    let prices = HashMap::from([(lot_id.clone(), u("50000"))]);
    let j = credited_book(Some(&prices));
    assert_match(
        find(list(&j, "lots"), "id", &lot_id).unwrap(),
        r#"{"costUsd":"2500","basisSource":"customer-entered"}"#,
    );
    let realised = f(proceeds() - u("1000"));
    assert_eq!(
        text(&list(&j, "sales")[0], "realizedUsd"),
        Some(realised.clone())
    );
    assert_match(&list(&j, "assets")[0], r#"{"openCostUsd":"1500"}"#);
    assert_eq!(text(&j, "realizedUsd"), Some(realised));
}

#[test]
fn a_dollar_coin_credited_is_not_a_position() {
    let mut a = activity(vec![], "0");
    a.arrivals = Some(vec![VenueArrival {
        arrival_id: "r1".to_owned(),
        kind: "deposit".to_owned(),
        asset: "USDC".to_owned(),
        amount: "268.31".to_owned(),
        arrived_at: ARRIVED.to_owned(),
    }]);
    let j = venue_with(
        empty_main(),
        Some(&read(vec![a.clone()])),
        EngineMethod::Fifo,
        &VenueExtras {
            inflows: inflows_of(&a),
            override_price_per_unit: None,
        },
    );
    assert!(list(&j, "lots").is_empty());
    assert!(list(&j, "assets").is_empty());
}
