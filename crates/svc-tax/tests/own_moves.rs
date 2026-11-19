//! `services/svc-tax/src/own-moves.test.ts`, case for case. TEST lines only; SPACE is one of the customer's own spaces.
#![allow(clippy::indexing_slicing, reason = "a test: a failure is the point")]

mod common;

use common::{amt, utc};
use svc_tax::own_moves::{OwnMove, SpaceInflow, pair_own_moves};
use svc_tax::ports::{AccountLine, InflowLine, SpaceLine};
use svc_tax::time::Instant;

const SPACE: &str = "33333333-3333-4333-8333-333333333333";
const OTHER: &str = "44444444-4444-4444-8444-444444444444";
const MANUAL: &str = "bank.transfer.manual";

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 0, 0)
}

fn line(tx: &str, debit: bool, qty: &str, reason: &str, day: i64) -> AccountLine {
    AccountLine {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        amount: amt(qty),
        reason: reason.to_owned(),
        debit,
    }
}

fn credit(tx: &str, qty: &str) -> AccountLine {
    line(tx, false, qty, MANUAL, 5)
}

fn debit(tx: &str, qty: &str) -> AccountLine {
    line(tx, true, qty, MANUAL, 5)
}

fn on(space: &str, line: AccountLine) -> SpaceLine {
    SpaceLine {
        space_id: space.to_owned(),
        line,
    }
}

fn inflow(tx: &str, qty: &str, reason: &str) -> InflowLine {
    InflowLine {
        tx_id: tx.to_owned(),
        posted_at: at(5),
        asset_id: "BTC".to_owned(),
        amount: amt(qty),
        reason: reason.to_owned(),
    }
}

fn moved(tx: &str, qty: &str, from: Option<&str>, to: Option<&str>) -> OwnMove {
    OwnMove {
        tx_id: tx.to_owned(),
        posted_at: at(5),
        asset_id: "BTC".to_owned(),
        amount: amt(qty),
        from: from.map(str::to_owned),
        to: to.map(str::to_owned),
    }
}

#[test]
fn pairs_a_credit_on_main_and_a_debit_on_a_space_as_a_move_to_the_space() {
    let got = pair_own_moves(&[], &[credit("m1", "1")], &[on(SPACE, debit("m1", "1"))]);
    assert_eq!(got.moves, vec![moved("m1", "1", None, Some(SPACE))]);
    assert!(got.space_inflows.is_empty());
}

#[test]
fn pairs_a_move_back_to_main_and_drops_it_from_the_main_arrivals() {
    let got = pair_own_moves(
        &[
            inflow("m2", "0.4", MANUAL),
            inflow("dep", "2", "deposit.credited"),
        ],
        &[],
        &[on(SPACE, credit("m2", "0.4"))],
    );
    assert_eq!(got.moves, vec![moved("m2", "0.4", Some(SPACE), None)]);
    let ids: Vec<_> = got.main_inflows.iter().map(|l| l.tx_id.as_str()).collect();
    assert_eq!(ids, vec!["dep"]);
}

#[test]
fn pairs_a_move_between_two_spaces() {
    let got = pair_own_moves(
        &[],
        &[],
        &[on(SPACE, credit("m3", "1")), on(OTHER, debit("m3", "1"))],
    );
    assert_eq!(got.moves, vec![moved("m3", "1", Some(SPACE), Some(OTHER))]);
}

#[test]
fn never_pairs_a_withdrawal_and_an_arrival_in_two_transactions() {
    let got = pair_own_moves(
        &[],
        &[line("wd", false, "1", "withdraw.sent", 4)],
        &[on(SPACE, line("in", true, "1", MANUAL, 6))],
    );
    assert!(got.moves.is_empty());
    assert_eq!(
        got.space_inflows,
        vec![SpaceInflow {
            line: InflowLine {
                tx_id: "in".to_owned(),
                posted_at: at(6),
                asset_id: "BTC".to_owned(),
                amount: amt("1"),
                reason: MANUAL.to_owned(),
            },
            space_id: SPACE.to_owned(),
        }]
    );
}

#[test]
fn does_not_pair_uneven_legs_or_more_than_one_leg_each_way() {
    let uneven = pair_own_moves(&[], &[credit("m4", "1")], &[on(SPACE, debit("m4", "0.9"))]);
    assert!(uneven.moves.is_empty());
    let ids: Vec<_> = uneven
        .space_inflows
        .iter()
        .map(|l| l.line.tx_id.as_str())
        .collect();
    assert_eq!(ids, vec!["m4"]);
    let split = pair_own_moves(
        &[],
        &[credit("m5", "1")],
        &[on(SPACE, debit("m5", "0.5")), on(OTHER, debit("m5", "0.5"))],
    );
    assert!(split.moves.is_empty());
}

#[test]
fn leaves_unpaired_lines_alone() {
    let got = pair_own_moves(
        &[inflow("dep", "1", "deposit.credited")],
        &[line("hold", false, "1", "order.hold.placed", 5)],
        &[on(SPACE, credit("gift", "0.1"))],
    );
    assert!(got.moves.is_empty());
    assert_eq!(
        got.main_inflows,
        vec![inflow("dep", "1", "deposit.credited")]
    );
    assert!(got.space_inflows.is_empty());
}
