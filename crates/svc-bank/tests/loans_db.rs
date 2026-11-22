//! Slice `loans` against Postgres: the DB half of `services/svc-bank/src/loans/loans.test.ts` ("svc-bank loans
//! PG-hard › LoanService"), each test named after the TypeScript test's words. A call on `LoanService` is the Rust
//! function it became, given the dependencies `loans_kit` builds (the TypeScript's `MemoryLedger`, `fixedPriceSource`,
//! `marketMakerVenue` and recording sink). Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it
//! fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::loans_kit::{self, BORROWER, Kit, OTHER, code, fmt};

use svc_bank::loans::service;

fn kit() -> Option<Kit> {
    Kit::new()
}

#[test]
fn locks_collateral_before_releasing_principal() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let r = k.open(&p.id, "1", "5000").unwrap();
    assert_eq!(r.loan.status, "active");
    assert_eq!(r.ltv_bps, 5_000);
    let events = k.rows(&format!(
        "SELECT direction::text, sequence::text, status::text FROM bank.loan_collateral_events WHERE loan_id = '{}'",
        r.loan.id
    ));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0][0].as_deref(), Some("lock"));
    assert_eq!(events[0][2].as_deref(), Some("settled"));
    assert_eq!(
        fmt(k.d(|d| service::collateral_of(d, &r.loan)).unwrap()),
        "1"
    );
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0");
    k.ledger.closes();
}

#[test]
fn refuses_a_draw_that_would_open_above_the_products_maximum_ltv() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let e = k.open(&p.id, "1", "6000").err().unwrap();
    assert!(loans_kit::message(&e).contains("exceeds the"), "{e:?}");
}

#[test]
fn refuses_an_underfunded_loan_reserve_draw_rather_than_printing_principal() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "1000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let e = k.open(&p.id, "1", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.loan_reserve_underfunded");
    assert_eq!(k.ledger.reserve("USDT"), "1000");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
}

#[test]
fn refuses_the_second_borrower_and_draws_nothing_for_them() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.fund(OTHER, "BTC", "1");
    let p = k.product();
    let id = "6f000000-0000-4000-8000-00000000dddd";
    k.open_as(BORROWER, id, &p.id, "1", "5000").unwrap();
    let e = k.open_as(OTHER, id, &p.id, "1", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.loan_borrower_mismatch");
    assert_eq!(k.ledger.available(OTHER, "USDT"), "0");
    assert_eq!(k.ledger.available(OTHER, "BTC"), "1");
    assert_eq!(
        k.d(|d| service::loans_of(d, OTHER, Some(50.0)))
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn recovers_by_re_driving_once_the_reserve_is_funded_locking_collateral_exactly_once() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let _ = k.open(&p.id, "1", "5000");
    k.fund_reserve("USDT", "100000");
    let resumed = k.d(|d| service::resume_pending(d, Some(100.0))).unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].outcome, "completed");
    let id = k.one("SELECT id::text FROM bank.loans").unwrap();
    assert_eq!(k.status(&id), "active");
    let l = k.loan(&id);
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.posts("loanCollateralLock").len(), 1);
}
