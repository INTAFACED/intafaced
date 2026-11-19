//! `services/svc-tax/src/lots.test.ts`, case for case.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::too_many_arguments,
    reason = "a test: a failure is the point"
)]

mod common;

use common::{amt, date, some, text};
use svc_tax::lots::{LotMethod, LotMovement, run_lots};
use svc_tax::tax::{TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW};

fn mv(
    asset: &str,
    acquire: bool,
    qty: &str,
    cost: Option<&str>,
    proceeds: Option<&str>,
    tx: &str,
    reason: &str,
    at: &str,
) -> LotMovement {
    LotMovement {
        asset_id: asset.to_owned(),
        acquire,
        qty: amt(qty),
        cost_basis: cost.map(amt),
        proceeds: proceeds.map(amt),
        posted_at: date(at),
        tx_id: tx.to_owned(),
        reason: reason.to_owned(),
    }
}

fn two_acquires_then_dispose() -> Vec<LotMovement> {
    vec![
        mv(
            "BTC",
            true,
            "2",
            Some("20000"),
            None,
            "a1",
            "deposit",
            "2024-01-01T00:00:00.000Z",
        ),
        mv(
            "BTC",
            true,
            "1",
            Some("30000"),
            None,
            "a2",
            "deposit",
            "2024-06-01T00:00:00.000Z",
        ),
        mv(
            "BTC",
            false,
            "1",
            None,
            Some("25000"),
            "d1",
            "trade.fill",
            "2024-12-01T00:00:00.000Z",
        ),
    ]
}

#[test]
fn fifo_disposes_the_oldest_lot() {
    let out = run_lots(&two_acquires_then_dispose(), LotMethod::Fifo);
    assert_eq!(out.lots_closed.len(), 1);
    assert_eq!(text(&out.lots_closed[0], "acquireTxId"), some("a1"));
    assert_eq!(text(&out.lots_closed[0], "qty"), some("1"));
    assert_eq!(text(&out.lots_closed[0], "realized"), some("15000"));
    assert_eq!(out.realized, some("15000"));
    assert_eq!(out.lots_open.len(), 2);
}

#[test]
fn lifo_disposes_the_newest_lot() {
    let out = run_lots(&two_acquires_then_dispose(), LotMethod::Lifo);
    assert_eq!(text(&out.lots_closed[0], "acquireTxId"), some("a2"));
    assert_eq!(text(&out.lots_closed[0], "realized"), some("-5000"));
}

#[test]
fn hifo_disposes_the_highest_cost_lot() {
    let out = run_lots(&two_acquires_then_dispose(), LotMethod::Hifo);
    assert_eq!(text(&out.lots_closed[0], "acquireTxId"), some("a2"));
    assert_eq!(text(&out.lots_closed[0], "costBasis"), some("30000"));
}

#[test]
fn missing_cost_is_never_treated_as_zero() {
    let out = run_lots(
        &[
            mv(
                "ETH",
                true,
                "1",
                None,
                None,
                "a",
                "deposit",
                "2024-01-01T00:00:00.000Z",
            ),
            mv(
                "ETH",
                false,
                "1",
                None,
                None,
                "d",
                "trade.fill",
                "2024-02-01T00:00:00.000Z",
            ),
        ],
        LotMethod::Fifo,
    );
    assert!(out.lots_closed.is_empty());
    assert_eq!(out.lots_open.len(), 1);
    assert_eq!(text(&out.lots_open[0], "costBasis"), None);
    assert_eq!(out.realized, None);
    assert!(out.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
    assert!(!out.residuals.contains(&TAX_LOT_UNDERFLOW));
}

#[test]
fn no_pairing_is_invented_when_any_open_lot_lacks_basis() {
    let mixed = [
        mv(
            "BTC",
            true,
            "1",
            None,
            None,
            "unknown",
            "deposit",
            "2024-01-01T00:00:00.000Z",
        ),
        mv(
            "BTC",
            true,
            "1",
            Some("40000"),
            None,
            "known",
            "deposit",
            "2024-02-01T00:00:00.000Z",
        ),
        mv(
            "BTC",
            false,
            "1",
            None,
            Some("50000"),
            "d",
            "trade.fill",
            "2024-03-01T00:00:00.000Z",
        ),
    ];
    for method in [LotMethod::Fifo, LotMethod::Lifo, LotMethod::Hifo] {
        let out = run_lots(&mixed, method);
        assert!(out.lots_closed.is_empty(), "{method:?}");
        assert_eq!(out.lots_open.len(), 2);
        assert_eq!(out.realized, None);
        assert!(out.residuals.contains(&TAX_COST_BASIS_UNAVAILABLE));
    }
}

#[test]
fn empty_movements_are_empty_not_a_zero_pnl() {
    let out = run_lots(&[], LotMethod::Fifo);
    assert!(out.lots_closed.is_empty());
    assert!(out.lots_open.is_empty());
    assert_eq!(out.realized, None);
    assert_eq!(out.unrealized, None);
}

#[test]
fn a_blank_market_price_leaves_unrealized_null() {
    let out = run_lots(
        &[
            mv(
                "BTC",
                true,
                "2",
                Some("20000"),
                None,
                "a1",
                "deposit",
                "2024-01-01T00:00:00.000Z",
            ),
            mv(
                "BTC",
                true,
                "1",
                Some("30000"),
                None,
                "a2",
                "deposit",
                "2024-06-01T00:00:00.000Z",
            ),
        ],
        LotMethod::Fifo,
    );
    assert_eq!(out.lots_open.len(), 2);
    assert_eq!(text(&out.lots_open[0], "costBasis"), some("20000"));
    assert_eq!(text(&out.lots_open[1], "costBasis"), some("30000"));
    assert_eq!(out.unrealized, None);
}

#[test]
fn a_dispose_beyond_open_lots_is_a_named_underflow() {
    let out = run_lots(
        &[mv(
            "BTC",
            false,
            "1",
            None,
            None,
            "d",
            "trade.fill",
            "2024-01-01T00:00:00.000Z",
        )],
        LotMethod::Fifo,
    );
    assert!(out.lots_closed.is_empty());
    assert!(out.residuals.contains(&TAX_LOT_UNDERFLOW));
    assert_eq!(out.realized, None);
}
