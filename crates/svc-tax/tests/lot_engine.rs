//! `lot-engine.test.ts`, case for case. Every figure here is hand-computed TEST data.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::collections::HashMap;

use common::{amt, f, s, utc};
use svc_tax::lot_engine::{
    EngineRun, LotSource, Movement, SaleRules, Side, lot_id_of, run_lot_engine,
};
use svc_tax::ports::EngineMethod;
use svc_tax::tax::{TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW};
use svc_tax::time::Instant;

const SPACE: &str = "33333333-3333-4333-8333-333333333333";

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 0, 0)
}

fn buy(tx: &str, day: i64, qty: &str, cost: Option<&str>, deposit: bool) -> Movement {
    Movement {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        qty: amt(qty),
        side: Side::Acquire {
            cost_usd: cost.map(amt),
            source: if deposit {
                LotSource::Deposit
            } else {
                LotSource::Trade
            },
            reason: if deposit {
                "deposit.credited"
            } else {
                "trade.fill"
            }
            .to_owned(),
            valued_at: None,
            space: None,
            carried: None,
        },
    }
}

fn bought(tx: &str, day: i64, qty: &str, cost: &str) -> Movement {
    buy(tx, day, qty, Some(cost), false)
}

fn deposited(tx: &str, day: i64, qty: &str) -> Movement {
    buy(tx, day, qty, None, true)
}

fn sell(tx: &str, day: i64, qty: &str, proceeds: &str) -> Movement {
    Movement {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        qty: amt(qty),
        side: Side::Dispose {
            proceeds_usd: Some(amt(proceeds)),
            moved_out: false,
        },
    }
}

fn mv(tx: &str, day: i64, qty: &str, from: Option<&str>, to: Option<&str>) -> Movement {
    Movement {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        qty: amt(qty),
        side: Side::Move {
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
        },
    }
}

fn run(history: &[Movement], method: EngineMethod) -> EngineRun {
    run_lot_engine(history, &SaleRules::One(method), None, None)
}

fn run_priced(history: &[Movement], prices: &[(String, &str)]) -> EngineRun {
    let prices: HashMap<String, i128> = prices.iter().map(|(k, v)| (k.clone(), amt(v))).collect();
    run_lot_engine(
        history,
        &SaleRules::One(EngineMethod::Fifo),
        Some(&prices),
        None,
    )
}

fn two() -> Vec<Movement> {
    vec![
        bought("b1", 1, "1", "100"),
        bought("b2", 2, "1", "200"),
        sell("s1", 3, "1", "300"),
    ]
}

fn open_total(r: &EngineRun) -> i128 {
    r.lots.iter().map(|l| l.remaining).sum()
}

fn some(text: &str) -> Option<String> {
    Some(text.to_owned())
}

#[test]
fn each_method_realises_and_leaves_its_own_cost() {
    for (method, realised, left) in [
        (EngineMethod::Fifo, "200", "200"),
        (EngineMethod::Lifo, "100", "100"),
        (EngineMethod::Hifo, "100", "100"),
        (EngineMethod::Average, "150", "150"),
    ] {
        let r = run(&two(), method);
        assert_eq!(s(r.sales[0].realized_usd), some(realised), "{method:?}");
        let open: Vec<_> = r.lots.iter().filter(|l| l.remaining > 0).collect();
        assert_eq!(open.len(), 1, "{method:?}");
        assert_eq!(s(open[0].remaining_cost_usd), some(left), "{method:?}");
        assert_eq!(open_total(&r), amt("1"));
    }
}

#[test]
fn average_a_sale_leaves_the_average_unchanged_a_later_buy_moves_it() {
    let mut h = two();
    h.push(bought("b3", 4, "2", "600"));
    h.push(sell("s2", 5, "3", "900"));
    let r = run(&h, EngineMethod::Average);
    let last = r.sales.iter().find(|x| x.tx_id == "s2").unwrap();
    assert_eq!(s(last.cost_usd), some("750"));
    assert_eq!(s(last.realized_usd), some("150"));
    assert!(r.lots.iter().all(|l| l.remaining == 0));
}

#[test]
fn lot_ids_come_from_the_arrival_and_the_coin() {
    let r = run(&two(), EngineMethod::Fifo);
    let ids: Vec<_> = r.lots.iter().map(|l| l.id.clone()).collect();
    assert_eq!(ids, vec![lot_id_of("b1", "BTC"), lot_id_of("b2", "BTC")]);
    let m = &r.sales[0].matches;
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].lot_id, "lot:b1:BTC");
    assert_eq!(
        (
            m[0].qty,
            m[0].cost_usd,
            m[0].proceeds_usd,
            m[0].realized_usd
        ),
        (
            amt("1"),
            Some(amt("100")),
            Some(amt("300")),
            Some(amt("200"))
        )
    );
}

#[test]
fn a_sale_on_a_lot_with_no_basis_is_unknown_for_that_part() {
    let h = [
        deposited("d1", 1, "1"),
        bought("b2", 2, "1", "200"),
        sell("s1", 3, "1", "300"),
    ];
    let fifo = run(&h, EngineMethod::Fifo);
    let sale = &fifo.sales[0];
    assert_eq!(
        (sale.unmatched_qty, sale.cost_usd, sale.realized_usd),
        (0, None, None)
    );
    assert_eq!(sale.matches[0].lot_id, "lot:d1:BTC");
    assert_eq!(
        (sale.matches[0].cost_usd, sale.matches[0].realized_usd),
        (None, None)
    );
    assert!(fifo.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
    let lifo = run(&h, EngineMethod::Lifo);
    assert_eq!(s(lifo.sales[0].realized_usd), some("100"));
    let d1 = lifo.lots.iter().find(|l| l.id == "lot:d1:BTC").unwrap();
    assert_eq!((d1.remaining, d1.remaining_cost_usd), (amt("1"), None));
}

#[test]
fn hifo_and_average_cannot_rank_a_lot_with_no_basis() {
    let h = [
        deposited("d1", 1, "1"),
        bought("b2", 2, "1", "200"),
        sell("s1", 3, "1", "300"),
    ];
    for method in [EngineMethod::Hifo, EngineMethod::Average] {
        let r = run(&h, method);
        assert_eq!((r.sales[0].cost_usd, r.sales[0].realized_usd), (None, None));
    }
}

#[test]
fn hifo_with_an_unknown_lot_still_draws_the_quantity() {
    let r = run(
        &[
            bought("b1", 1, "1", "100"),
            deposited("d1", 2, "1"),
            bought("b3", 3, "1", "300"),
            sell("s1", 4, "2", "400"),
        ],
        EngineMethod::Hifo,
    );
    let sale = &r.sales[0];
    assert_eq!(
        (sale.unmatched_qty, sale.cost_usd, sale.realized_usd),
        (0, None, None)
    );
    assert_eq!(sale.matches.iter().map(|m| m.qty).sum::<i128>(), amt("2"));
    assert_eq!(open_total(&r), amt("1"));
    assert!(
        r.lots
            .iter()
            .filter(|l| l.remaining > 0)
            .all(|l| l.remaining_cost_usd.is_none())
    );
    assert!(r.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
    assert!(!r.residuals.contains(&TAX_LOT_UNDERFLOW));
}

#[test]
fn a_sale_bigger_than_every_open_lot_names_the_shortfall() {
    let r = run(
        &[bought("b1", 1, "1", "100"), sell("s1", 2, "3", "600")],
        EngineMethod::Fifo,
    );
    let sale = &r.sales[0];
    assert_eq!(
        (sale.unmatched_qty, sale.cost_usd, sale.realized_usd),
        (amt("2"), None, None)
    );
    assert!(r.residuals.contains(&TAX_LOT_UNDERFLOW));
}

#[test]
fn a_partial_sale_splits_the_lot_cost() {
    let r = run(
        &[bought("b1", 1, "4", "100"), sell("s1", 2, "1", "40")],
        EngineMethod::Fifo,
    );
    assert_eq!(s(r.sales[0].cost_usd), some("25"));
    assert_eq!(s(r.sales[0].realized_usd), some("15"));
    let l = &r.lots[0];
    assert_eq!(
        (l.remaining, l.remaining_cost_usd, l.cost_usd),
        (amt("3"), Some(amt("75")), Some(amt("100")))
    );
}

#[test]
fn two_arrivals_in_one_transaction_get_distinct_repeatable_ids() {
    let r = run(
        &[deposited("t1", 1, "1"), deposited("t1", 1, "2")],
        EngineMethod::Fifo,
    );
    let mut ids: Vec<_> = r.lots.iter().map(|l| l.id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["lot:t1:BTC", "lot:t1:BTC:2"]);
}

#[test]
fn average_many_small_sales_never_drift_from_the_pool() {
    let mut h = vec![bought("b1", 1, "1", "10"), bought("b2", 2, "2", "90")];
    for i in 0..10 {
        h.push(sell(&format!("s{i}"), 3 + i, "0.1", "10"));
    }
    let r = run(&h, EngineMethod::Average);
    let taken: i128 = r.sales.iter().map(|x| x.cost_usd.unwrap_or(0)).sum();
    let left: i128 = r
        .lots
        .iter()
        .map(|l| l.remaining_cost_usd.unwrap_or(0))
        .sum();
    assert_eq!(taken + left, amt("100"));
    assert_eq!(open_total(&r), amt("2"));
}

// runLotEngine own-account carry (LB-6)

#[test]
fn carries_lots_to_a_space_oldest_first_and_a_later_sale_draws_on_main_only() {
    let r = run(
        &[
            bought("b1", 1, "1", "100"),
            bought("b2", 2, "1", "200"),
            mv("mv", 3, "1.5", None, Some(SPACE)),
            sell("s1", 4, "0.5", "150"),
        ],
        EngineMethod::Fifo,
    );
    let in_space: Vec<_> = r
        .lots
        .iter()
        .filter(|l| l.space.as_deref() == Some(SPACE))
        .collect();
    let rows: Vec<_> = in_space
        .iter()
        .map(|l| {
            (
                l.id.clone(),
                l.acquired_at.iso(),
                f(l.qty),
                s(l.cost_usd),
                l.source,
                l.carried_from.as_ref().map(|c| c.lot_id.clone()),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                format!("{}>mv", lot_id_of("b1", "BTC")),
                at(1).iso(),
                "1".to_owned(),
                some("100"),
                LotSource::Trade,
                Some(lot_id_of("b1", "BTC"))
            ),
            (
                format!("{}>mv", lot_id_of("b2", "BTC")),
                at(2).iso(),
                "0.5".to_owned(),
                some("100"),
                LotSource::Trade,
                Some(lot_id_of("b2", "BTC"))
            ),
        ]
    );
    let matches: Vec<_> = r.sales[0]
        .matches
        .iter()
        .map(|m| (m.lot_id.clone(), f(m.qty), s(m.cost_usd)))
        .collect();
    assert_eq!(
        matches,
        vec![(lot_id_of("b2", "BTC"), "0.5".to_owned(), some("100"))]
    );
    assert_eq!(s(r.sales[0].realized_usd), some("50"));
    let b2 = r
        .lots
        .iter()
        .find(|l| l.id == lot_id_of("b2", "BTC"))
        .unwrap();
    assert_eq!((f(b2.remaining), b2.space.clone()), ("0".to_owned(), None));
    assert!(in_space.iter().all(|l| l.remaining == l.qty));
    assert!(r.residuals.is_empty());
}

#[test]
fn carries_a_lot_back_to_main_with_its_first_date() {
    let r = run(
        &[
            bought("b1", 1, "1", "100"),
            mv("out", 2, "1", None, Some(SPACE)),
            bought("b2", 3, "1", "300"),
            mv("back", 4, "1", Some(SPACE), None),
            sell("s1", 5, "1", "400"),
        ],
        EngineMethod::Fifo,
    );
    let back = format!("{}>out>back", lot_id_of("b1", "BTC"));
    let matches: Vec<_> = r.sales[0]
        .matches
        .iter()
        .map(|m| (m.lot_id.clone(), s(m.cost_usd)))
        .collect();
    assert_eq!(matches, vec![(back.clone(), some("100"))]);
    assert_eq!(
        r.lots.iter().find(|l| l.id == back).unwrap().acquired_at,
        at(1)
    );
}

#[test]
fn a_move_with_too_few_coins_behind_it_names_the_part_with_no_basis() {
    let r = run(
        &[
            bought("b1", 1, "1", "100"),
            mv("mv", 2, "1.5", None, Some(SPACE)),
        ],
        EngineMethod::Fifo,
    );
    let arrived: Vec<_> = r
        .lots
        .iter()
        .filter(|l| l.space.as_deref() == Some(SPACE))
        .map(|l| (f(l.qty), s(l.cost_usd), l.source))
        .collect();
    assert_eq!(
        arrived,
        vec![
            ("1".to_owned(), some("100"), LotSource::Trade),
            ("0.5".to_owned(), None, LotSource::TransferIn),
        ]
    );
    assert!(r.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
}

#[test]
fn a_moved_lot_with_no_basis_takes_a_price_entered_for_the_carried_part() {
    let r = run_priced(
        &[deposited("d1", 1, "1"), mv("mv", 2, "1", None, Some(SPACE))],
        &[(format!("{}>mv", lot_id_of("d1", "BTC")), "50")],
    );
    let carried = r
        .lots
        .iter()
        .find(|l| l.space.as_deref() == Some(SPACE))
        .unwrap();
    assert_eq!(
        (
            s(carried.cost_usd),
            carried.customer_entered,
            carried.source
        ),
        (some("50"), true, LotSource::Deposit)
    );
}

// runLotEngine own-account carry follows the method in force

fn method_history() -> Vec<Movement> {
    vec![
        bought("b1", 1, "1", "100"),
        bought("b2", 2, "1", "300"),
        mv("mv", 3, "1", None, Some(SPACE)),
        sell("s1", 4, "1", "500"),
    ]
}

fn carried(r: &EngineRun) -> Vec<(Option<String>, Option<String>)> {
    r.lots
        .iter()
        .filter(|l| l.space.as_deref() == Some(SPACE))
        .map(|l| {
            (
                l.carried_from.as_ref().map(|c| c.lot_id.clone()),
                s(l.cost_usd),
            )
        })
        .collect()
}

#[test]
fn average_the_move_goes_at_the_average_and_leaves_it() {
    let moved = run(&method_history(), EngineMethod::Average);
    let unmoved = run(
        &[
            bought("b1", 1, "1", "100"),
            bought("b2", 2, "1", "300"),
            sell("s1", 4, "1", "500"),
        ],
        EngineMethod::Average,
    );
    assert_eq!(s(moved.sales[0].cost_usd), some("200"));
    assert_eq!(moved.sales[0].cost_usd, unmoved.sales[0].cost_usd);
    assert_eq!(
        carried(&moved),
        vec![(Some(lot_id_of("b1", "BTC")), some("200"))]
    );
}

#[test]
fn lifo_moves_the_newest_lot_fifo_the_oldest() {
    let lifo = run(&method_history(), EngineMethod::Lifo);
    assert_eq!(
        carried(&lifo),
        vec![(Some(lot_id_of("b2", "BTC")), some("300"))]
    );
    assert_eq!(s(lifo.sales[0].cost_usd), some("100"));
    let fifo = run(&method_history(), EngineMethod::Fifo);
    assert_eq!(
        carried(&fifo).into_iter().map(|c| c.0).collect::<Vec<_>>(),
        vec![Some(lot_id_of("b1", "BTC"))]
    );
    assert_eq!(s(fifo.sales[0].cost_usd), some("300"));
}

#[test]
fn a_carried_part_keeps_the_entered_price_and_names_where_it_is_stored() {
    let r = run_priced(
        &[
            deposited("d1", 1, "1"),
            mv("mv", 2, "0.4", None, Some(SPACE)),
        ],
        &[(lot_id_of("d1", "BTC"), "50")],
    );
    let c = r
        .lots
        .iter()
        .find(|l| l.space.as_deref() == Some(SPACE))
        .unwrap();
    assert_eq!(
        (s(c.cost_usd), c.customer_entered, c.price_lot_id.clone()),
        (some("20"), true, Some(lot_id_of("d1", "BTC")))
    );
    assert_eq!(
        r.lots
            .iter()
            .find(|l| l.id == lot_id_of("d1", "BTC"))
            .unwrap()
            .price_lot_id,
        None
    );
}
