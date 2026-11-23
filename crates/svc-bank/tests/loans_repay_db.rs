//! Slice `loans` against Postgres: repayment, its overlap with liquidation, lost ledger receipts and their recovery,
//! and the loan tables' own guards. Each test is named after the TypeScript test's words, from
//! `services/svc-bank/src/loans/`:
//!
//! - `repay-liquidation-one-lock.test.ts`, `repay-lost-ack-no-double-collect.test.ts`,
//!   `repay-overlapping-once.test.ts`, `repay-public-door.test.ts`, `repay-retry-id.test.ts`,
//!   `repay-retry-releases-collateral.test.ts`, `lost-receipt-recovery-guards.test.ts`;
//! - `settled-needs-ledger-tx.test.ts`, `loan-bps-bounds.test.ts`, `loan-floor-blank.test.ts`,
//!   `loan-interest-zero-principal.test.ts`, `opening-collateral-write-once.test.ts` (raw SQL on the migrated schema;
//!   a down then up migration runs inside a transaction that rolls back);
//! - `blank-min-principal.test.ts` (on a real database where the TypeScript recorded the SQL it would have sent).
//!
//! A `LoanService` call is the Rust function it became; a router call goes through the door. A TypeScript test that
//! wraps `ledger.post` is the [`Tap`] here, which wraps the kit's book the same way (fail before it, lose the answer
//! after it, or park after it). Two calls "in flight together" run on two threads, each with its own pool, as two
//! replicas would.
//!
//! Not ported, because they read TypeScript source text, not behaviour:
//! - `repay-public-door.test.ts` › "repay loads the loan before recipes.loanRepay" and "public door looks up the loan
//!   before repay" (string positions in `loan-service.ts` and `router.ts`);
//! - `repay-retry-id.test.ts` › "repay requires eventId before nextSequence and does not mint" and "public door
//!   requires eventId so omit is not a second loanRepay" (regexes over the same files);
//! - the last block of `loan-floor-blank.test.ts` (the line declaring `min_principal` in `db/schema.ts` has no
//!   `.default(` and no `.notNull(`); the rest of that test is ported.
//!
//! Where the Rust types close a case the TypeScript had to test (`blank-min-principal.test.ts` passes `''`, `'   '`
//! and `null` as a floor; the Rust floor is `Option<Amount>`, so only `None` is expressible, and a numeric column cannot
//! store `''`), the reachable case is tested and the rest is named in the test.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant as Clock};

use postgres::error::SqlState;
use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;
use svc_bank::db::Store;
use svc_bank::door;
use svc_bank::errors::Refusal;
use svc_bank::loans::model::{self, NewProduct};
use svc_bank::loans::ports::{Deps, MarketMaker, SaleAsk, Venue, VenueQuote, market_maker};
use svc_bank::loans::{service, sweep};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
use svc_bank::spaces::space;

use crate::loans_kit::{
    self, BORROWER, Book, Kit, MM_FUNDER, amt, available, call, fmt, new_product, obj, plus, s,
    uuid,
};

const MISSING: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MINUTE: i64 = 60_000;

fn kit() -> Option<Kit> {
    Kit::new()
}

/// The refusal a call answered; panics when it succeeded.
fn err<T>(r: Result<T, Refusal>) -> Refusal {
    match r {
        Ok(_) => panic!("expected a refusal"),
        Err(e) => e,
    }
}

/// The refusal's own code: a bank error's code, or a tRPC refusal's `cause.code`.
fn code(r: &Refusal) -> String {
    match r {
        Refusal::Trpc(t) if t.cause.is_some() => t.cause.clone().unwrap(),
        other => loans_kit::code(other),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The wrapped `ledger.post`

#[derive(Default)]
struct TapState {
    /// Fail the first post of this recipe: (recipe, after it books, message).
    fail: Option<(String, bool, String)>,
    /// Park after the first booked post of one of these recipes, until released.
    park: Vec<String>,
    parked: bool,
    released: bool,
}

/// The TypeScript suites' `ledger.post = async (request) => ...` around the kit's book.
struct Tap {
    book: Book,
    st: Mutex<TapState>,
    cv: Condvar,
}

impl Tap {
    fn new(book: &Book) -> Tap {
        Tap {
            book: book.clone(),
            st: Mutex::new(TapState::default()),
            cv: Condvar::new(),
        }
    }
    /// Throw `message` on the first post of `recipe`, before it reaches the ledger.
    fn fail_before(&self, recipe: &str, message: &str) {
        self.st.lock().unwrap().fail = Some((recipe.to_owned(), false, message.to_owned()));
    }
    /// Book the first post of `recipe`, then throw `message`.
    fn lose_after(&self, recipe: &str, message: &str) {
        self.st.lock().unwrap().fail = Some((recipe.to_owned(), true, message.to_owned()));
    }
    fn park_after(&self, recipes: &[&str]) {
        self.st.lock().unwrap().park = recipes.iter().map(|r| (*r).to_owned()).collect();
    }
    fn parked(&self) -> bool {
        self.st.lock().unwrap().parked
    }
    fn release(&self) {
        self.st.lock().unwrap().released = true;
        self.cv.notify_all();
    }
}

impl Ledger for Tap {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        self.book.balance(a)
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        self.book.balances(owner_type, owner)
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.book.assets()
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        self.book.account_id(a)
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        self.book.tx_by_id(tx_id)
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        self.book.tx_by_key(key)
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let fail = {
            let mut st = self.st.lock().unwrap();
            match &st.fail {
                Some((r, _, _)) if r == recipe => st.fail.take(),
                _ => None,
            }
        };
        if let Some((_, false, message)) = &fail {
            return Err(PostFailure::Unknown(message.clone()));
        }
        let posted = self.book.post_recipe(recipe, input, key);
        if let (Some((_, true, message)), Ok(_)) = (&fail, &posted) {
            return Err(PostFailure::Unknown(message.clone()));
        }
        let mut st = self.st.lock().unwrap();
        if posted.is_ok() && !st.parked && st.park.iter().any(|r| r == recipe) {
            st.parked = true;
            while !st.released {
                st = self.cv.wait(st).unwrap();
            }
        }
        posted
    }
}

/// A venue whose quote waits until released, then answers as the market maker.
#[derive(Default)]
struct HeldQuote {
    st: Mutex<(bool, bool)>,
    cv: Condvar,
}

impl HeldQuote {
    fn wait_started(&self) {
        let mut st = self.st.lock().unwrap();
        let until = Clock::now() + Duration::from_secs(15);
        while !st.0 {
            assert!(Clock::now() < until, "the quote never started");
            st = self
                .cv
                .wait_timeout(st, Duration::from_millis(50))
                .unwrap()
                .0;
        }
    }
    fn release(&self) {
        self.st.lock().unwrap().1 = true;
        self.cv.notify_all();
    }
}

impl Venue for HeldQuote {
    fn quote(&self, ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String> {
        let mut st = self.st.lock().unwrap();
        st.0 = true;
        self.cv.notify_all();
        while !st.1 {
            st = self.cv.wait(st).unwrap();
        }
        drop(st);
        MarketMaker.quote(ask)
    }
}

/// The kit's dependencies with another pool, ledger or venue.
fn deps<'a>(
    k: &'a Kit,
    store: &'a Store,
    ledger: &'a dyn Ledger,
    venue: &'a dyn Venue,
    now: Instant,
) -> Deps<'a> {
    Deps {
        store,
        ledger,
        custody_layer: &k.custody,
        approvals: &k.desk,
        prices: &k.prices,
        venue,
        margin_calls: &k.calls,
        affiliates: &k.told,
        settings: &k.settings,
        now,
    }
}

/// Sessions of this database waiting on a lock, other than the asking one.
fn lock_waits(k: &Kit) -> i64 {
    k.count(
        "SELECT count(*)::int8 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Openings

/// `openLoan` of `repay-liquidation-one-lock.test.ts`: a funded reserve, 1 BTC, a market maker with 100000 USDT,
/// 5000 spare USDT on the borrower, then 1 BTC for 5000 USDT at 10000.
fn open_for_lock(k: &Kit) -> model::Loan {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.ledger.seed_market_maker("USDT", "100000");
    k.fund(BORROWER, "USDT", "5000");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap().loan
}

/// `seedOpenLoan`: a funded reserve, 1 BTC, 1 BTC for 5000 USDT at 10000, at `now`.
fn open_at(k: &Kit, now: Instant) -> model::Loan {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    k.prices.stamp(now);
    k.at(now, |d| {
        service::open(
            d,
            &service::OpenAsk {
                loan_id: &uuid(),
                product_id: &p.id,
                user_id: BORROWER,
                collateral_amount: amt("1"),
                principal: amt("5000"),
                expected_apr_bps: None,
            },
        )
    })
    .unwrap()
    .loan
}

/// `openLoan` of `lost-receipt-recovery-guards.test.ts`: as [`open_at`] at the kit's clock, with a funded market
/// maker, `collateral` BTC for `principal` USDT, and the product's policy changed by `policy`.
fn open_for_recovery(
    k: &Kit,
    collateral: &str,
    principal: &str,
    policy: impl FnOnce(&mut NewProduct),
) -> model::Loan {
    k.prices.stamp(k.now);
    k.prices.btc("10000");
    k.fund(BORROWER, "BTC", collateral);
    k.ledger.seed_market_maker("USDT", "100000");
    k.fund_reserve("USDT", "100000");
    let p = k.product_with(policy);
    k.open(&p.id, collateral, principal).unwrap().loan
}

fn repay(k: &Kit, loan: &str, amount: &str, event: &str) -> Result<service::Repaid, Refusal> {
    k.d(|d| service::repay(d, loan, amt(amount), event))
}

fn repay_via(
    k: &Kit,
    ledger: &dyn Ledger,
    loan: &str,
    amount: &str,
    event: &str,
) -> Result<service::Repaid, Refusal> {
    let d = deps(k, &k.store, ledger, &k.venue, k.now);
    service::repay(&d, loan, amt(amount), event)
}

fn sweep_via(k: &Kit, ledger: &dyn Ledger, at: Instant) -> sweep::Swept {
    k.prices.stamp(at);
    let d = deps(k, &k.store, ledger, &k.venue, at);
    sweep::run_risk_sweep(&d, at, Some(500.0)).unwrap()
}

/// The loan's posts of one recipe (`journal().filter(reason && key includes loanId)`).
fn posts(k: &Kit, recipe: &str, loan: &str) -> usize {
    k.ledger
        .posts(recipe)
        .iter()
        .filter(|b| b.key.contains(loan))
        .count()
}

fn all_posts(k: &Kit, recipe: &str) -> usize {
    k.ledger.posts(recipe).len()
}

/// `collections(ledger, loanId)`: the loan's repayments and sales.
fn collections(k: &Kit, loan: &str) -> usize {
    posts(k, "loanRepay", loan) + posts(k, "loanLiquidate", loan)
}

fn status_of(k: &Kit, table: &str, id: &str) -> (Option<String>, Option<String>) {
    let r = k.rows(&format!(
        "SELECT status::text, ledger_tx_id FROM bank.{table} WHERE id = '{id}'"
    ));
    (r[0][0].clone(), r[0][1].clone())
}

fn collateral(k: &Kit, l: &model::Loan) -> String {
    fmt(k.d(|d| service::collateral_of(d, l)).unwrap())
}

// ---------------------------------------------------------------------------------------------------------------
// repay-liquidation-one-lock.test.ts › one lock covers repayment and liquidation

#[test]
fn a_repay_post_and_a_liquidation_sale_overlap_on_one_ledger_post_the_other_waits() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    k.prices.btc("5200");
    let tap = Tap::new(&k.ledger);
    tap.park_after(&["loanRepay", "loanLiquidate"]);
    let (sa, sb) = (k.db.store(), k.db.store());
    let done = AtomicUsize::new(0);
    let saw_lock_wait = AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            let d = deps(&k, &sa, &tap, &k.venue, k.now);
            let _ = service::repay(&d, &loan.id, amt("5000"), &uuid());
            tap.release();
            done.fetch_add(1, Ordering::SeqCst);
        });
        s.spawn(|| {
            let d = deps(&k, &sb, &tap, &k.venue, k.now);
            let _ = sweep::run_risk_sweep(&d, k.now, Some(500.0));
            tap.release();
            done.fetch_add(1, Ordering::SeqCst);
        });
        let until = Clock::now() + Duration::from_secs(15);
        while done.load(Ordering::SeqCst) < 2 {
            if Clock::now() > until {
                tap.release();
                panic!("repay and liquidation did not finish");
            }
            if tap.parked() {
                if lock_waits(&k) > 0 {
                    saw_lock_wait.store(true, Ordering::SeqCst);
                    tap.release();
                }
                if collections(&k, &loan.id) >= 2 {
                    tap.release();
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    assert!(
        saw_lock_wait.load(Ordering::SeqCst),
        "the other call never waited on the lock"
    );
    let repaid = k
        .one(&format!(
            "SELECT COALESCE(SUM(principal_amount), 0)::text FROM bank.loan_repayments WHERE loan_id = '{}' AND status = 'settled'",
            loan.id
        ))
        .unwrap();
    let sold = k
        .one(&format!(
            "SELECT COALESCE(SUM(principal_repaid), 0)::text FROM bank.loan_liquidations WHERE loan_id = '{}' AND status = 'settled'",
            loan.id
        ))
        .unwrap();
    // The overlapping pair must not collect the same principal twice.
    assert!(
        amt(&repaid) + amt(&sold) <= amt("5000"),
        "{repaid} + {sold}"
    );
    k.ledger.closes();
}

#[test]
fn a_repayment_that_settles_during_the_quote_is_not_sold_at_the_pre_repayment_debt() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    k.prices.btc("5200");
    let held = HeldQuote::default();
    let sb = k.db.store();
    let (repaid, result) = std::thread::scope(|s| {
        let sweep = s.spawn(|| {
            let d = deps(&k, &sb, &k.ledger, &held, k.now);
            sweep::run_risk_sweep(&d, k.now, Some(500.0))
        });
        held.wait_started();
        let repaid = repay(&k, &loan.id, "4500", &uuid());
        held.release();
        (repaid, sweep.join().unwrap())
    });
    let repaid = repaid.unwrap();
    let result = result.unwrap();
    assert_eq!(repaid.principal_paid, amt("4500"));
    assert_eq!(repaid.interest_paid, 0);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 0);
    assert_eq!(k.debt(&loan.id).principal, amt("500"));
    assert_eq!(
        k.count(&format!(
            "SELECT count(*)::int8 FROM bank.loan_liquidations WHERE loan_id = '{}'",
            loan.id
        )),
        0
    );
    k.ledger.closes();
}

#[test]
fn a_lost_repayment_acknowledgement_stays_pending_and_is_not_collected_by_a_sale() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanRepay", "receipt lost after ledger commit");
    k.prices.btc("5200");
    let e = err(repay_via(&k, &tap, &loan.id, "1000", &event));
    assert!(
        loans_kit::message(&e).contains("receipt lost after ledger commit"),
        "{e:?}"
    );
    let (status, tx) = status_of(&k, "loan_repayments", &event);
    assert_eq!(status.as_deref(), Some("pending"));
    assert_eq!(tx, None);

    let e = err(k.d(|d| sweep::seize(d, &loan.id, k.now)));
    assert_eq!(code(&e), "bank.ledger_outcome_unknown");
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 0);
    assert_eq!(
        status_of(&k, "loan_repayments", &event).0.as_deref(),
        Some("pending")
    );
    assert_eq!(posts(&k, "loanRepay", &loan.id), 1);
}

#[test]
fn posts_the_same_repayment_event_id_once() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    let event = uuid();
    let first = repay(&k, &loan.id, "1000", &event).unwrap();
    let again = repay(&k, &loan.id, "1000", &event).unwrap();
    assert_eq!(again.ledger_tx_id, first.ledger_tx_id);
    assert_eq!(posts(&k, "loanRepay", &loan.id), 1);
    assert_eq!(k.debt(&loan.id).principal, amt("4000"));
}

#[test]
fn refuses_repay_with_bank_loan_liquidating_once_status_is_liquidating() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    k.sql(&format!(
        "UPDATE bank.loans SET status = 'liquidating' WHERE id = '{}'",
        loan.id
    ));
    k.prices.btc("5200");
    let e = err(repay(&k, &loan.id, "1000", &uuid()));
    assert_eq!(code(&e), "bank.loan_liquidating");
    assert_eq!(collections(&k, &loan.id), 0);
}

#[test]
fn a_lost_liquidation_acknowledgement_stays_pending_and_repay_does_not_collect_it() {
    let Some(k) = kit() else { return };
    let loan = open_for_lock(&k);
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanLiquidate", "receipt lost after ledger commit");
    k.prices.btc("5200");
    let swept = sweep_via(&k, &tap, k.now);
    assert!(
        swept
            .refused
            .iter()
            .any(|(_, reason)| reason == "receipt lost after ledger commit"),
        "{:?}",
        swept.refused
    );
    let pending = k.rows(&format!(
        "SELECT status::text, ledger_tx_id FROM bank.loan_liquidations WHERE loan_id = '{}'",
        loan.id
    ));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0][0].as_deref(), Some("pending"));
    assert_eq!(pending[0][1], None);
    let e = err(repay(&k, &loan.id, "1000", &uuid()));
    assert_eq!(code(&e), "bank.loan_liquidating");
    assert_eq!(posts(&k, "loanRepay", &loan.id), 0);
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 1);
    assert_eq!(
        k.one(&format!(
            "SELECT status::text FROM bank.loan_liquidations WHERE loan_id = '{}'",
            loan.id
        ))
        .as_deref(),
        Some("pending")
    );
}

// ---------------------------------------------------------------------------------------------------------------
// repay-lost-ack-no-double-collect.test.ts

#[test]
fn does_not_collect_the_same_principal_again_under_a_new_event_id() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let loan = k.open(&p.id, "1", "5000").unwrap().loan;
    // Spare funds so a second collection would be executable if the service allowed it.
    k.fund(BORROWER, "USDT", "5000");
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanRepay", "receipt lost after ledger commit");
    assert!(repay_via(&k, &tap, &loan.id, "5000", &uuid()).is_err());
    // Refusing while the original outcome is reconciled is acceptable; collecting again is not.
    let _ = repay(&k, &loan.id, "5000", &uuid());
    assert_eq!(posts(&k, "loanRepay", &loan.id), 1);
    assert_eq!(
        k.count(&format!(
            "SELECT count(*)::int8 FROM bank.loan_repayments WHERE loan_id = '{}' AND status = 'rejected' AND ledger_tx_id IS NULL",
            loan.id
        )),
        0
    );
}

/// `openLoan` of "unattended recovery after a lost loan acknowledgement".
fn open_plain(k: &Kit) -> model::Loan {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap().loan
}

fn recover(k: &Kit) -> Vec<service::Resumed> {
    k.d(|d| service::recover_repayments(d, Some(10.0))).unwrap()
}

fn outcome_of(out: &[service::Resumed], loan: &str) -> (String, Option<String>) {
    let r = out
        .iter()
        .find(|o| o.loan_id == loan)
        .expect("the loan was recovered");
    (r.outcome.to_owned(), r.reason.clone())
}

#[test]
fn settles_the_original_repayment_and_closes_the_loan_without_the_borrower() {
    let Some(k) = kit() else { return };
    let loan = open_plain(&k);
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanRepay", "receipt lost after ledger commit");
    let e = err(repay_via(&k, &tap, &loan.id, "5000", &event));
    assert!(
        loans_kit::message(&e).contains("receipt lost after ledger commit"),
        "{e:?}"
    );
    assert_eq!(
        status_of(&k, "loan_repayments", &event).0.as_deref(),
        Some("pending")
    );
    k.fund(BORROWER, "USDT", "5000");
    let e = err(repay(&k, &loan.id, "5000", &uuid()));
    assert_eq!(code(&e), "bank.ledger_outcome_unknown");

    let out = recover(&k);
    assert_eq!(outcome_of(&out, &loan.id), ("completed".to_owned(), None));
    let repaid = k.ledger.posts("loanRepay");
    assert_eq!(repaid.len(), 1);
    let (status, tx) = status_of(&k, "loan_repayments", &event);
    assert_eq!(status.as_deref(), Some("settled"));
    assert_eq!(tx.as_deref(), Some(repaid[0].tx.id.as_str()));
    let after = k.loan(&loan.id);
    assert_eq!(after.status, "repaid");
    assert_eq!(collateral(&k, &after), "0");
    assert_eq!(posts(&k, "loanCollateralRelease", &loan.id), 1);
}

#[test]
fn finishes_a_committed_release_whose_acknowledgement_was_lost_releasing_once() {
    let Some(k) = kit() else { return };
    let loan = open_plain(&k);
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanCollateralRelease", "receipt lost after ledger commit");
    let e = err(repay_via(&k, &tap, &loan.id, "5000", &uuid()));
    assert!(
        loans_kit::message(&e).contains("receipt lost after ledger commit"),
        "{e:?}"
    );
    assert_ne!(k.status(&loan.id), "repaid");

    let out = recover(&k);
    assert_eq!(outcome_of(&out, &loan.id), ("completed".to_owned(), None));
    assert_eq!(k.status(&loan.id), "repaid");
    let releases = k.ledger.posts("loanCollateralRelease");
    assert_eq!(releases.len(), 1);
    let rows = k.rows(&format!(
        "SELECT status::text, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = '{}' AND direction = 'release'",
        loan.id
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some("settled"));
    assert_eq!(rows[0][1].as_deref(), Some(releases[0].tx.id.as_str()));
}

#[test]
fn still_records_a_definite_ledger_refusal_as_rejected_and_lets_a_new_repayment_through() {
    let Some(k) = kit() else { return };
    let loan = open_plain(&k);
    // Spend the borrower's drawn USDT so the first repayment is definitely refused.
    let drained = k.ledger.of(&available(BORROWER, "USDT"));
    k.ledger.transfer(
        &available(BORROWER, "USDT"),
        &available(MM_FUNDER, "USDT"),
        drained,
    );
    let refused = uuid();
    let e = err(repay(&k, &loan.id, "5000", &refused));
    assert_eq!(code(&e), "ledger.insufficient_funds");
    let r = k.rows(&format!(
        "SELECT status::text, rejection_code FROM bank.loan_repayments WHERE id = '{refused}'"
    ));
    assert_eq!(r[0][0].as_deref(), Some("rejected"));
    assert_eq!(r[0][1].as_deref(), Some("ledger.insufficient_funds"));

    k.fund(BORROWER, "USDT", "5000");
    let ok = repay(&k, &loan.id, "5000", &uuid()).unwrap();
    assert!(ok.closed);
}

// ---------------------------------------------------------------------------------------------------------------
// repay-overlapping-once.test.ts

#[test]
fn two_overlapping_repayments_with_different_event_ids_do_not_each_pay_the_full_outstanding() {
    let Some(k) = kit() else { return };
    let loan = open_plain(&k);
    // The draw already put 5000 USDT in hand. Another 5000 means both callers can fund a full repayment.
    k.fund(BORROWER, "USDT", "5000");
    let (event_a, event_b) = (uuid(), uuid());
    let tap = Tap::new(&k.ledger);
    tap.park_after(&["loanRepay"]);
    let (sa, sb) = (k.db.store(), k.db.store());
    let done = AtomicUsize::new(0);
    let saw_lock_wait = AtomicBool::new(false);
    let (ra, rb) = std::thread::scope(|s| {
        let a = s.spawn(|| {
            let d = deps(&k, &sa, &tap, &k.venue, k.now);
            let r = service::repay(&d, &loan.id, amt("5000"), &event_a);
            tap.release();
            done.fetch_add(1, Ordering::SeqCst);
            r
        });
        let b = s.spawn(|| {
            let d = deps(&k, &sb, &tap, &k.venue, k.now);
            let r = service::repay(&d, &loan.id, amt("5000"), &event_b);
            tap.release();
            done.fetch_add(1, Ordering::SeqCst);
            r
        });
        let until = Clock::now() + Duration::from_secs(15);
        while done.load(Ordering::SeqCst) < 2 {
            if Clock::now() > until {
                tap.release();
                panic!("the two repayments did not finish");
            }
            if tap.parked() && lock_waits(&k) > 0 {
                saw_lock_wait.store(true, Ordering::SeqCst);
                tap.release();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        (a.join().unwrap(), b.join().unwrap())
    });
    // The TypeScript also counts debt re-reads through a SQL proxy; that tap has no Rust counterpart, and its
    // disjunction (`debtReads >= 2 || sawLockWait`) is met by the lock wait alone.
    assert!(
        saw_lock_wait.load(Ordering::SeqCst),
        "the second caller never waited on the lock"
    );
    let a_won = ra.is_ok();
    let (paid, refused) = match (ra, rb) {
        (Ok(p), Err(e)) | (Err(e), Ok(p)) => (p, e),
        (Ok(_), Ok(_)) => panic!("both repayments succeeded"),
        (Err(a), Err(b)) => panic!("both repayments failed: {a:?} {b:?}"),
    };
    assert_eq!(code(&refused), "bank.loan_closed");
    assert_eq!(paid.principal_paid, amt("5000"));
    assert_eq!(paid.interest_paid, 0);
    assert!(paid.closed);
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    assert_eq!(all_posts(&k, "loanCollateralRelease"), 1);
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(collateral(&k, &loan), "0");
    assert_eq!(k.status(&loan.id), "repaid");
    assert_eq!(k.debt(&loan.id).total, 0);

    let winner = if a_won { &event_a } else { &event_b };
    let again = repay(&k, &loan.id, "5000", winner).unwrap();
    assert_eq!(again.ledger_tx_id, paid.ledger_tx_id);
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    assert_eq!(all_posts(&k, "loanCollateralRelease"), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// repay-public-door.test.ts

const SCOPES: &[&str] = &["bank:read", "bank:write"];

/// `procedureData`: the answer's data, unwrapped from `json` when it is wrapped.
fn data(a: &loans_kit::Answer) -> Json {
    let d = a.ok();
    d.get("json").cloned().unwrap_or(d)
}

#[test]
fn bank_loan_not_found_no_loan_repaid() {
    let Some(k) = kit() else { return };
    let e = err(repay(&k, MISSING, "1", &uuid()));
    assert_eq!(code(&e), "bank.loan_not_found");
    assert!(!k.ledger.asked().iter().any(|r| r == "loanRepay"));
}

#[test]
fn refuses_bank_loan_not_found_on_the_public_door_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let door = k.door();
    let a = call(
        &door,
        BORROWER,
        SCOPES,
        "loans.repay",
        &obj(&[
            ("loanId", Json::str(MISSING)),
            ("amount", Json::str("1")),
            ("eventId", Json::str(uuid())),
        ]),
    );
    assert_eq!(a.0, 404, "{}", a.1.compact());
    assert_eq!(a.trpc(), "NOT_FOUND");
    assert_eq!(a.cause(), "bank.loan_not_found");
    assert!(!k.ledger.asked().iter().any(|r| r == "loanRepay"));
}

#[test]
fn with_a_live_loan_posts_loan_repaid_no_invented_rate() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, door::system_now());
    let door = k.door();
    let a = call(
        &door,
        BORROWER,
        SCOPES,
        "loans.repay",
        &obj(&[
            ("loanId", Json::str(loan.id.clone())),
            ("amount", Json::str("1000")),
            ("eventId", Json::str(uuid())),
        ]),
    );
    assert_eq!(a.0, 200, "{}", a.1.compact());
    let d = data(&a);
    assert!(!s(&d, "ledgerTxId").is_empty());
    assert_eq!(s(&d, "interestPaid"), "0");
    assert_eq!(s(&d, "principalPaid"), "1000");
    assert_eq!(s(&d, "remainingPrincipal"), "4000");
    assert_eq!(s(&d, "closed"), "false");
    let journal = k.ledger.journal();
    let draw_at = journal.iter().position(|b| b.recipe == "loanDraw").unwrap();
    let repay_at = journal
        .iter()
        .position(|b| b.recipe == "loanRepay")
        .unwrap();
    assert!(repay_at > draw_at);
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "4000");
}

// ---------------------------------------------------------------------------------------------------------------
// repay-retry-id.test.ts

#[test]
fn omit_event_id_refuses_bank_repayment_id_required_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, k.now);
    let e = err(repay(&k, &loan.id, "1000", ""));
    assert_eq!(code(&e), "bank.repayment_id_required");
    assert_eq!(all_posts(&k, "loanRepay"), 0);
}

#[test]
fn two_repays_of_the_same_event_id_one_loan_repaid() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, k.now);
    let event = uuid();
    let first = repay(&k, &loan.id, "1000", &event).unwrap();
    let retry = repay(&k, &loan.id, "1000", &event).unwrap();
    assert_eq!(retry.ledger_tx_id, first.ledger_tx_id);
    assert_eq!(retry.sequence, first.sequence);
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    let rows = k.rows(&format!(
        "SELECT id::text FROM bank.loan_repayments WHERE loan_id = '{}' AND status = 'settled'",
        loan.id
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some(event.as_str()));
}

#[test]
fn timeout_after_repay_posts_retry_same_event_id_one_loan_repaid() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, k.now);
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanRepay", "timed out after repay posted");
    let e = err(repay_via(&k, &tap, &loan.id, "1000", &event));
    assert!(
        loans_kit::message(&e).contains("timed out after repay posted"),
        "{e:?}"
    );
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    let retry = repay(&k, &loan.id, "1000", &event).unwrap();
    assert!(!retry.ledger_tx_id.is_empty());
    assert_eq!(all_posts(&k, "loanRepay"), 1);
}

#[test]
fn two_event_ids_of_the_same_amount_are_two_repayments() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, k.now);
    let first = repay(&k, &loan.id, "1000", &uuid()).unwrap();
    let second = repay(&k, &loan.id, "1000", &uuid()).unwrap();
    assert_ne!(second.sequence, first.sequence);
    assert_eq!(all_posts(&k, "loanRepay"), 2);
}

#[test]
fn http_without_event_id_is_400() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, door::system_now());
    let door = k.door();
    let a = call(
        &door,
        BORROWER,
        SCOPES,
        "loans.repay",
        &obj(&[
            ("loanId", Json::str(loan.id.clone())),
            ("amount", Json::str("1000")),
        ]),
    );
    assert_eq!(a.0, 400, "{}", a.1.compact());
    assert_eq!(all_posts(&k, "loanRepay"), 0);
}

#[test]
fn two_http_posts_with_the_same_event_id_are_one_loan_repaid() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, door::system_now());
    let event = uuid();
    let door = k.door();
    let body = obj(&[
        ("loanId", Json::str(loan.id.clone())),
        ("amount", Json::str("1000")),
        ("eventId", Json::str(event)),
    ]);
    let first = call(&door, BORROWER, SCOPES, "loans.repay", &body);
    assert_eq!(first.0, 200, "{}", first.1.compact());
    let retry = call(&door, BORROWER, SCOPES, "loans.repay", &body);
    assert_eq!(retry.0, 200, "{}", retry.1.compact());
    assert_eq!(
        s(&data(&retry), "ledgerTxId"),
        s(&data(&first), "ledgerTxId")
    );
    assert_eq!(all_posts(&k, "loanRepay"), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// repay-retry-releases-collateral.test.ts

#[test]
fn releases_collateral_the_first_post_left_locked_and_does_not_post_the_repayment_again() {
    let Some(k) = kit() else { return };
    let loan = open_at(&k, k.now);
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.fail_before("loanCollateralRelease", "crashed after repayment settled");
    let e = err(repay_via(&k, &tap, &loan.id, "5000", &event));
    assert!(
        loans_kit::message(&e).contains("crashed after repayment settled"),
        "{e:?}"
    );
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    assert_eq!(all_posts(&k, "loanCollateralRelease"), 0);
    assert_eq!(collateral(&k, &loan), "1");

    let retry = repay(&k, &loan.id, "5000", &event).unwrap();
    assert!(retry.closed);
    assert!(!retry.ledger_tx_id.is_empty());
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    assert_eq!(all_posts(&k, "loanCollateralRelease"), 1);
    assert_eq!(collateral(&k, &loan), "0");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
    assert_eq!(k.status(&loan.id), "repaid");

    let again = repay(&k, &loan.id, "5000", &event).unwrap();
    assert_eq!(again.ledger_tx_id, retry.ledger_tx_id);
    assert!(again.closed);
    assert_eq!(all_posts(&k, "loanRepay"), 1);
    assert_eq!(all_posts(&k, "loanCollateralRelease"), 1);
    assert_eq!(collateral(&k, &loan), "0");
}

// ---------------------------------------------------------------------------------------------------------------
// lost-receipt-recovery-guards.test.ts › recovery after a lost loan receipt

#[test]
fn does_not_release_excess_collateral_from_a_loan_that_still_owes() {
    let Some(k) = kit() else { return };
    let loan = open_for_recovery(&k, "2", "5000", |_| {});
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.fail_before("loanCollateralRelease", "socket hang up before the ledger");
    let d = deps(&k, &k.store, &tap, &k.venue, k.now);
    assert!(service::release_excess(&d, &loan.id, &event, amt("1")).is_err());

    // The market falls: with 2 BTC the loan is healthy, with 1 BTC it would be past the margin-call line.
    k.prices.btc("6000");
    let out = k
        .d(|d| service::recover_repayments(d, Some(100.0)))
        .unwrap();
    assert_eq!(outcome_of(&out, &loan.id), ("open".to_owned(), None));
    assert_eq!(collateral(&k, &loan), "2");
    assert_eq!(posts(&k, "loanCollateralRelease", &loan.id), 0);
    assert_eq!(
        status_of(&k, "loan_collateral_events", &event).0.as_deref(),
        Some("pending")
    );
}

#[test]
fn does_not_re_send_a_repayment_that_stopped_being_pending_while_recovery_waited() {
    let Some(k) = kit() else { return };
    let loan = open_for_recovery(&k, "1", "5000", |_| {});
    let event = uuid();
    let tap = Tap::new(&k.ledger);
    tap.fail_before("loanRepay", "socket hang up before the ledger");
    assert!(repay_via(&k, &tap, &loan.id, "1000", &event).is_err());

    let mut other = k.db.client();
    other
        .execute(
            "SELECT pg_advisory_lock(hashtext('bank.loan.repay'), hashtext($1))",
            &[&loan.id],
        )
        .unwrap();
    let rs = k.db.store();
    let out = std::thread::scope(|s| {
        let running = s.spawn(|| {
            let d = deps(&k, &rs, &k.ledger, &k.venue, k.now);
            service::recover_repayments(&d, Some(100.0))
        });
        for _ in 0..100 {
            let waiting: i64 = other
                .query_one(
                    "SELECT count(*)::int8 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
                    &[],
                )
                .unwrap()
                .get(0);
            if waiting > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // What a concurrent same-id retry that met a definite refusal leaves behind.
        other
            .execute(
                "UPDATE bank.loan_repayments SET status = 'rejected', rejection_code = 'ledger.insufficient_funds' \
                 WHERE id = $1::text::uuid",
                &[&event],
            )
            .unwrap();
        other
            .execute(
                "SELECT pg_advisory_unlock(hashtext('bank.loan.repay'), hashtext($1))",
                &[&loan.id],
            )
            .unwrap();
        running.join().unwrap()
    });
    // `await running`: the recovery itself answers.
    out.unwrap();
    assert_eq!(
        status_of(&k, "loan_repayments", &event).0.as_deref(),
        Some("rejected")
    );
    assert_eq!(posts(&k, "loanRepay", &loan.id), 0);
}

#[test]
fn refuses_repayment_while_a_liquidation_sale_has_an_unknown_outcome_then_finishes_that_sale_once()
{
    let Some(k) = kit() else { return };
    let loan = open_for_recovery(&k, "1", "5000", |_| {});
    k.prices.btc("5700");
    sweep_via(&k, &k.ledger, k.now);
    assert_eq!(k.status(&loan.id), "margin_call");

    let later = plus(k.now, 2 * 3_600_000);
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanLiquidate", "receipt lost after ledger commit");
    sweep_via(&k, &tap, later);

    assert_eq!(k.status(&loan.id), "liquidating");
    let owed = k.debt(&loan.id);
    k.fund(BORROWER, "USDT", "6000");
    let e = err(k.at(later, |d| service::repay(d, &loan.id, owed.total, &uuid())));
    let c = code(&e);
    assert!(
        c == "bank.ledger_outcome_unknown" || c == "bank.loan_liquidating",
        "{e:?}"
    );

    sweep_via(&k, &k.ledger, later);
    let rungs = k.rows(&format!(
        "SELECT status::text FROM bank.loan_liquidations WHERE loan_id = '{}' ORDER BY tranche",
        loan.id
    ));
    assert_eq!(rungs[0][0].as_deref(), Some("settled"));
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 1);
    assert_eq!(posts(&k, "loanRepay", &loan.id), 0);
}

#[test]
fn books_the_bad_debt_cover_when_a_closing_sale_is_finished_after_its_receipt_was_lost() {
    let Some(k) = kit() else { return };
    let loan = open_for_recovery(&k, "1", "5000", |p| p.policy.max_tranche_bps = 10_000);
    k.ledger.seed_insurance("USDT", "10000");
    k.prices.btc("4000");
    let tap = Tap::new(&k.ledger);
    tap.lose_after("loanLiquidate", "receipt lost after ledger commit");
    sweep_via(&k, &tap, k.now);
    for minutes in [1, 2] {
        sweep_via(&k, &k.ledger, plus(k.now, minutes * MINUTE));
    }
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 1);
    assert_eq!(posts(&k, "loanBadDebt", &loan.id), 1);
    let rungs = k.rows(&format!(
        "SELECT status::text, shortfall::text FROM bank.loan_liquidations WHERE loan_id = '{}'",
        loan.id
    ));
    assert_eq!(rungs[0][0].as_deref(), Some("settled"));
    assert_ne!(rungs[0][1].as_deref(), Some("0"));
    assert_eq!(k.debt(&loan.id).total, 0);
    assert_eq!(k.status(&loan.id), "liquidated");
}

#[test]
fn does_not_strand_a_loan_in_liquidating_when_the_re_drive_of_a_pending_sale_is_definitely_refused()
{
    let Some(k) = kit() else { return };
    let loan = open_for_recovery(&k, "1", "5000", |p| p.policy.max_tranche_bps = 10_000);
    k.ledger.seed_insurance("USDT", "10000");
    k.prices.btc("4000");
    let tap = Tap::new(&k.ledger);
    tap.fail_before("loanLiquidate", "socket hang up before the ledger");
    sweep_via(&k, &tap, k.now);
    assert_eq!(k.status(&loan.id), "liquidating");

    // The buyer is empty, so the re-drive is a definite refusal.
    let mm = k.ledger.of(&market_maker("USDT"));
    let sink = available(MM_FUNDER, "USDT");
    k.ledger.transfer(&market_maker("USDT"), &sink, mm);
    sweep_via(&k, &k.ledger, plus(k.now, MINUTE));
    assert_ne!(k.status(&loan.id), "liquidating");

    // The buyer is funded again: the next sweeps liquidate for real.
    k.ledger.transfer(&sink, &market_maker("USDT"), mm);
    for minutes in [2, 3] {
        sweep_via(&k, &k.ledger, plus(k.now, minutes * MINUTE));
    }
    assert_eq!(posts(&k, "loanLiquidate", &loan.id), 1);
    assert_eq!(collateral(&k, &loan), "0");
}

// ---------------------------------------------------------------------------------------------------------------
// Raw SQL on the migrated schema

/// The SQLSTATE and constraint a statement failed with.
fn sql_err<T>(r: Result<T, postgres::Error>) -> (SqlState, Option<String>) {
    let Err(e) = r else {
        panic!("expected the statement to be refused")
    };
    let db = e.as_db_error().expect("a database error");
    (db.code().clone(), db.constraint().map(str::to_owned))
}

fn check_violation<T>(r: Result<T, postgres::Error>, constraint: Option<&str>) {
    let (state, name) = sql_err(r);
    assert_eq!(state, SqlState::CHECK_VIOLATION, "{name:?}");
    if let Some(c) = constraint {
        assert_eq!(name.as_deref(), Some(c));
    }
}

/// Text cells of every row.
fn texts(rows: &[postgres::Row]) -> Vec<Vec<Option<String>>> {
    rows.iter()
        .map(|r| {
            (0..r.len())
                .map(|i| r.get::<_, Option<String>>(i))
                .collect()
        })
        .collect()
}

// settled-needs-ledger-tx.test.ts › settled loan rows require a ledger tx

fn seed_loan(c: &mut postgres::Client) -> String {
    let product: String = c
        .query_one(
            "INSERT INTO bank.loan_products (
               name, debt_asset_id, collateral_asset_id, quote_asset_id,
               apr_bps, max_ltv_bps, margin_call_ltv_bps, liquidation_ltv_bps,
               insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, grace_seconds
             ) VALUES ('probe', 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, 3600)
             RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    c.query_one(
        "INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal)
         VALUES ($1::text::uuid, '11111111-1111-4111-8111-111111111111', 'USDT', 'BTC', 'USDT', 1000, '1'::numeric)
         RETURNING id::text",
        &[&product],
    )
    .unwrap()
    .get(0)
}

fn probe(sql: &str) -> Option<Result<u64, postgres::Error>> {
    let k = kit()?;
    let mut c = k.db.client();
    let loan = seed_loan(&mut c);
    Some(c.execute(sql, &[&loan]))
}

const LIQUIDATION_COLS: &str = "loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds, principal_repaid, \
     interest_repaid, penalty, surplus_returned, shortfall";

#[test]
fn refuses_a_settled_collateral_event_with_a_null_ledger_tx() {
    let Some(r) = probe(
        "INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount, status, settled_at)
         VALUES ($1::text::uuid, 0, 'lock', '1'::numeric, 'settled', now())",
    ) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn refuses_a_settled_repayment_with_a_null_ledger_tx() {
    let Some(r) = probe(
        "INSERT INTO bank.loan_repayments (loan_id, sequence, interest_amount, principal_amount, status, settled_at)
         VALUES ($1::text::uuid, 0, '0'::numeric, '1'::numeric, 'settled', now())",
    ) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn refuses_a_settled_liquidation_with_a_null_ledger_tx() {
    let Some(r) = probe(&format!(
        "INSERT INTO bank.loan_liquidations ({LIQUIDATION_COLS}, status, settled_at)
         VALUES ($1::text::uuid, 0, 8500, '1', '1', '1', '1', '0', '0', '0', '0', 'settled', now())"
    )) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn refuses_settled_without_settled_at_matching_a_settled_transfer() {
    let Some(r) = probe(
        "INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount, status, ledger_tx_id)
         VALUES ($1::text::uuid, 0, 'lock', '1'::numeric, 'settled', 'ledger-tx-probe')",
    ) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn refuses_a_liquidation_whose_shortfall_is_above_zero_without_a_bad_debt_ledger_tx() {
    let Some(r) = probe(&format!(
        "INSERT INTO bank.loan_liquidations ({LIQUIDATION_COLS}, status, ledger_tx_id, settled_at)
         VALUES ($1::text::uuid, 0, 8500, '1', '1', '1', '1', '0', '0', '0', '1', 'settled', 'ledger-tx-probe', now())"
    )) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn refuses_shortfall_above_zero_on_a_row_that_is_not_yet_settled() {
    let Some(r) = probe(&format!(
        "INSERT INTO bank.loan_liquidations ({LIQUIDATION_COLS})
         VALUES ($1::text::uuid, 0, 8500, '1', '1', '1', '1', '0', '0', '0', '1')"
    )) else {
        return;
    };
    check_violation(r, None);
}

#[test]
fn accepts_a_settled_collateral_event_that_names_its_ledger_tx() {
    let Some(r) = probe(
        "INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount, status, ledger_tx_id, settled_at)
         VALUES ($1::text::uuid, 0, 'lock', '1'::numeric, 'settled', 'ledger-tx-probe', now())",
    ) else {
        return;
    };
    assert_eq!(r.unwrap(), 1);
}

#[test]
fn accepts_a_settled_liquidation_with_no_shortfall_and_no_bad_debt_tx() {
    let Some(r) = probe(&format!(
        "INSERT INTO bank.loan_liquidations ({LIQUIDATION_COLS}, status, ledger_tx_id, settled_at)
         VALUES ($1::text::uuid, 0, 8500, '1', '1', '1', '1', '0', '0', '0', '0', 'settled', 'ledger-tx-probe', now())"
    )) else {
        return;
    };
    assert_eq!(r.unwrap(), 1);
}

#[test]
fn accepts_a_liquidation_whose_shortfall_above_zero_names_the_bad_debt_tx() {
    let Some(r) = probe(&format!(
        "INSERT INTO bank.loan_liquidations ({LIQUIDATION_COLS}, bad_debt_ledger_tx_id)
         VALUES ($1::text::uuid, 0, 8500, '1', '1', '1', '1', '0', '0', '0', '1', 'bad-debt-tx-probe')"
    )) else {
        return;
    };
    assert_eq!(r.unwrap(), 1);
}

// loan-bps-bounds.test.ts › loan product liquidation stop and APR bounds

const BPS_UP: &str = include_str!("../migrations/0022_loan_bps_bounds.sql");
const BPS_DOWN: &str = include_str!("../migrations/0022_loan_bps_bounds.down.sql");
const APR_CAP_BPS: i32 = 1_000_000;

/// One product with this APR and liquidation stop: (id, apr, target, margin call).
fn insert_bps(
    c: &mut impl postgres::GenericClient,
    name: &str,
    apr: i32,
    target: i32,
) -> Result<(String, i32, i32, i32), postgres::Error> {
    let r = c.query_one(
        "INSERT INTO bank.loan_products (
           name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
           margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
           penalty_bps, max_tranche_bps, grace_seconds
         ) VALUES ($1, 'USDT', 'BTC', 'USDT', $2, 5000, 7500, 8500, 9500, $3, 200, 2500, 3600)
         RETURNING id::text, apr_bps, target_ltv_bps, margin_call_ltv_bps",
        &[&name, &apr, &target],
    )?;
    Ok((r.get(0), r.get(1), r.get(2), r.get(3)))
}

/// The insert in a savepoint, rolled back whatever it answered.
fn in_savepoint<T>(
    tx: &mut postgres::Transaction<'_>,
    f: impl FnOnce(&mut postgres::Transaction<'_>) -> Result<T, postgres::Error>,
) -> Result<T, postgres::Error> {
    let mut sp = tx.transaction().unwrap();
    let out = f(&mut sp);
    sp.rollback().unwrap();
    out
}

fn bps_products(tx: &mut postgres::Transaction<'_>) -> Vec<Vec<Option<String>>> {
    texts(
        &tx.query(
            "SELECT id::text, apr_bps::text, target_ltv_bps::text, margin_call_ltv_bps::text
               FROM bank.loan_products ORDER BY id",
            &[],
        )
        .unwrap(),
    )
}

#[test]
fn refuses_a_non_positive_liquidation_stop_and_an_apr_above_1000000_on_a_new_insert() {
    let Some(k) = kit() else { return };
    let mut c = k.db.client();
    let mut tx = c.transaction().unwrap();
    tx.batch_execute(BPS_DOWN).unwrap();

    let zero = insert_bps(&mut tx, "l1102-zero-stop", 1000, 0).unwrap();
    assert_eq!(zero.2, 0, "a zero liquidation stop stores before the bound");
    let negative = insert_bps(&mut tx, "l1102-negative-stop", 1000, -1).unwrap();
    assert_eq!(
        negative.2, -1,
        "a negative liquidation stop stores before the bound"
    );
    let uncapped = insert_bps(&mut tx, "l1102-uncapped-apr", APR_CAP_BPS + 1, 6500).unwrap();
    assert_eq!(
        uncapped.1,
        APR_CAP_BPS + 1,
        "an APR above 1000000 stores before the cap"
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_bps(t, "l1102-negative-apr-before", -1, 6500)
        }),
        Some("loan_products_bps_bounded"),
    );

    let before = bps_products(&mut tx);
    tx.batch_execute(BPS_UP).unwrap();
    assert_eq!(bps_products(&mut tx), before);

    check_violation(
        in_savepoint(&mut tx, |t| insert_bps(t, "l1102-zero-stop-after", 1000, 0)),
        Some("loan_products_ltv_ordered"),
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_bps(t, "l1102-negative-stop-after", 1000, -1)
        }),
        Some("loan_products_ltv_ordered"),
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_bps(t, "l1102-uncapped-apr-after", APR_CAP_BPS + 1, 6500)
        }),
        Some("loan_products_bps_bounded"),
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_bps(t, "l1102-negative-apr-after", -1, 6500)
        }),
        Some("loan_products_bps_bounded"),
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_bps(t, "l1102-stop-at-margin", 1000, 7500)
        }),
        Some("loan_products_ltv_ordered"),
    );

    let positive = insert_bps(&mut tx, "l1102-positive-stop", 1000, 1).unwrap();
    assert_eq!(positive.2, 1);
    assert_eq!(positive.3, 7500);
    let apr_zero = insert_bps(&mut tx, "l1102-apr-zero", 0, 6500).unwrap();
    assert_eq!(apr_zero.1, 0);
    let apr_cap = insert_bps(&mut tx, "l1102-apr-cap", APR_CAP_BPS, 6500).unwrap();
    assert_eq!(apr_cap.1, APR_CAP_BPS);

    let after = bps_products(&mut tx);
    for row in &before {
        assert!(after.contains(row), "{row:?} was rewritten");
    }
    tx.rollback().unwrap();
}

// loan-floor-blank.test.ts › loan product min_principal blank floor

const FLOOR_UP: &str = include_str!("../migrations/0021_loan_floor_blank.sql");
const FLOOR_DOWN: &str = include_str!("../migrations/0021_loan_floor_blank.down.sql");

/// (id, floor as text, blank, is 0, is 12.5, is 100).
type Floor = (String, Option<String>, bool, bool, bool, bool);

const FLOOR_RETURNING: &str = "RETURNING id::text, min_principal::text, (min_principal IS NULL),
     (min_principal IS NOT NULL AND min_principal = 0), (min_principal IS NOT NULL AND min_principal = 12.5),
     (min_principal IS NOT NULL AND min_principal = 100)";

const FLOOR_COLS: &str = "name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps, \
     margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, \
     grace_seconds";

fn floor_of(r: &postgres::Row) -> Floor {
    (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5))
}

fn insert_omit(c: &mut impl postgres::GenericClient, name: &str) -> Floor {
    floor_of(
        &c.query_one(
            &format!(
                "INSERT INTO bank.loan_products ({FLOOR_COLS}) VALUES \
                 ($1, 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, 3600) {FLOOR_RETURNING}"
            ),
            &[&name],
        )
        .unwrap(),
    )
}

fn insert_floor(
    c: &mut impl postgres::GenericClient,
    name: &str,
    amount: &str,
) -> Result<Floor, postgres::Error> {
    c.query_one(
        &format!(
            "INSERT INTO bank.loan_products ({FLOOR_COLS}, min_principal) VALUES \
             ($1, 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, 3600, $2::text::numeric) \
             {FLOOR_RETURNING}"
        ),
        &[&name, &amount],
    )
    .map(|r| floor_of(&r))
}

fn floors(tx: &mut postgres::Transaction<'_>) -> Vec<Vec<Option<String>>> {
    texts(
        &tx.query(
            "SELECT id::text, min_principal::text FROM bank.loan_products ORDER BY id",
            &[],
        )
        .unwrap(),
    )
}

#[test]
fn stores_an_omitted_floor_as_null_and_keeps_an_explicit_floor_including_0() {
    let Some(k) = kit() else { return };
    let mut c = k.db.client();
    let mut tx = c.transaction().unwrap();
    tx.batch_execute(FLOOR_DOWN).unwrap();

    let legacy = insert_omit(&mut tx, "l1101-legacy-omit");
    assert!(!legacy.2, "the pre-0021 default stores an allow-all floor");
    assert!(legacy.3);
    assert!(legacy.1.is_some());
    let kept = insert_floor(&mut tx, "l1101-kept", "100").unwrap();
    assert!(kept.5);
    assert!(kept.1.is_some());
    let zero_before = insert_floor(&mut tx, "l1101-explicit-zero-before", "0").unwrap();
    assert!(!zero_before.2);
    assert!(zero_before.3);

    let before = floors(&mut tx);
    tx.batch_execute(FLOOR_UP).unwrap();
    assert_eq!(floors(&mut tx), before);

    let blank = insert_omit(&mut tx, "l1101-blank");
    assert_eq!(blank.1, None, "an omitted min_principal is a blank limit");
    assert!(blank.2);
    assert!(!blank.3);
    let zero = insert_floor(&mut tx, "l1101-explicit-zero", "0").unwrap();
    assert!(!zero.2);
    assert!(zero.3);
    assert!(zero.1.is_some());
    let floor = insert_floor(&mut tx, "l1101-explicit-floor", "12.5").unwrap();
    assert!(!floor.2);
    assert!(floor.4);
    assert!(!floor.3);
    assert!(floor.1.is_some());

    let column = texts(
        &tx.query(
            "SELECT data_type::text, numeric_precision::text, numeric_scale::text, is_nullable::text,
                    column_default::text
               FROM information_schema.columns
              WHERE table_schema = 'bank' AND table_name = 'loan_products' AND column_name = 'min_principal'",
            &[],
        )
        .unwrap(),
    );
    assert_eq!(
        column[0],
        vec![
            Some("numeric".to_owned()),
            Some("38".to_owned()),
            Some("18".to_owned()),
            Some("YES".to_owned()),
            None
        ]
    );

    check_violation(
        in_savepoint(&mut tx, |t| insert_floor(t, "l1101-negative", "-1")),
        Some("loan_products_min_principal_non_negative_ck"),
    );

    let after = floors(&mut tx);
    for row in &before {
        assert!(after.contains(row), "{row:?} was rewritten");
    }
    let find = |id: &str| after.iter().find(|r| r[0].as_deref() == Some(id)).unwrap()[1].clone();
    assert_eq!(find(&legacy.0), legacy.1);
    assert_eq!(find(&kept.0), kept.1);
    assert_eq!(find(&blank.0), None);
    tx.rollback().unwrap();
}

// loan-interest-zero-principal.test.ts › loan interest on a zero principal basis

const INTEREST_UP: &str = include_str!("../migrations/0023_loan_interest_zero_principal.sql");
const INTEREST_DOWN: &str =
    include_str!("../migrations/0023_loan_interest_zero_principal.down.sql");

fn accruals(tx: &mut postgres::Transaction<'_>, loan: &str) -> Vec<Vec<Option<String>>> {
    texts(
        &tx.query(
            "SELECT id::text, accrual_date::text, principal_basis::text, interest_amount::text
               FROM bank.loan_interest_accruals WHERE loan_id = $1::text::uuid ORDER BY accrual_date",
            &[&loan],
        )
        .unwrap(),
    )
}

fn insert_accrual(
    c: &mut impl postgres::GenericClient,
    loan: &str,
    day: &str,
    principal: &str,
    interest: &str,
) -> Result<(), postgres::Error> {
    let r = c.query_one(
        "INSERT INTO bank.loan_interest_accruals (loan_id, accrual_date, rate_bps, principal_basis, interest_amount)
         VALUES ($1::text::uuid, $2::text::date, 1000, $3::text::numeric, $4::text::numeric)
         RETURNING principal_basis::text, interest_amount::text,
                   (principal_basis = $3::text::numeric), (interest_amount = $4::text::numeric)",
        &[&loan, &day, &principal, &interest],
    )?;
    let (_, _): (String, String) = (r.get(0), r.get(1));
    assert!(r.get::<_, bool>(2), "principal_basis stores {principal}");
    assert!(r.get::<_, bool>(3), "interest_amount stores {interest}");
    Ok(())
}

#[test]
fn refuses_a_charge_on_no_debt_and_still_stores_a_zero_charge() {
    let Some(k) = kit() else { return };
    let mut c = k.db.client();
    let mut tx = c.transaction().unwrap();
    tx.batch_execute(INTEREST_DOWN).unwrap();
    let product: String = tx
        .query_one(
            &format!(
                "INSERT INTO bank.loan_products ({FLOOR_COLS}) VALUES \
                 ('l1103-product', 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, 3600) \
                 RETURNING id::text"
            ),
            &[],
        )
        .unwrap()
        .get(0);
    let loan: String = tx
        .query_one(
            "INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps,
                                     principal, status)
             VALUES ($1::text::uuid, 'l1103-user', 'USDT', 'BTC', 'USDT', 1000, '100'::numeric, 'active')
             RETURNING id::text",
            &[&product],
        )
        .unwrap()
        .get(0);
    const NONE: Option<&str> = Some("loan_interest_non_negative");

    insert_accrual(&mut tx, &loan, "2026-01-01", "0", "1.25").unwrap();
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_accrual(t, &loan, "2026-01-02", "0", "-1")
        }),
        NONE,
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_accrual(t, &loan, "2026-01-03", "-1", "0")
        }),
        NONE,
    );

    let before = accruals(&mut tx, &loan);
    tx.batch_execute(INTEREST_UP).unwrap();
    assert_eq!(accruals(&mut tx, &loan), before);

    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_accrual(t, &loan, "2026-01-04", "0", "1.25")
        }),
        NONE,
    );
    insert_accrual(&mut tx, &loan, "2026-01-05", "0", "0").unwrap();
    insert_accrual(&mut tx, &loan, "2026-01-06", "5000", "1.25").unwrap();
    insert_accrual(&mut tx, &loan, "2026-01-07", "5000", "0").unwrap();
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_accrual(t, &loan, "2026-01-08", "0", "-1")
        }),
        NONE,
    );
    check_violation(
        in_savepoint(&mut tx, |t| {
            insert_accrual(t, &loan, "2026-01-09", "-1", "1.25")
        }),
        NONE,
    );

    let after = accruals(&mut tx, &loan);
    for row in &before {
        assert!(after.contains(row), "{row:?} was rewritten");
    }
    tx.rollback().unwrap();
}

// opening-collateral-write-once.test.ts › opening collateral is write-once at insert

/// (status, opening collateral as text, is 10, is 1, is null).
fn opening(
    tx: &mut postgres::Transaction<'_>,
    loan: &str,
) -> (String, Option<String>, bool, bool, bool) {
    let r = tx
        .query_one(
            "SELECT status::text, opening_collateral::text,
                    (opening_collateral IS NOT NULL AND opening_collateral = 10),
                    (opening_collateral IS NOT NULL AND opening_collateral = 1),
                    (opening_collateral IS NULL)
               FROM bank.loans WHERE id = $1::text::uuid",
            &[&loan],
        )
        .unwrap();
    (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))
}

fn insert_opening(
    c: &mut impl postgres::GenericClient,
    product: &str,
    pledged: Option<&str>,
) -> Result<String, postgres::Error> {
    c.query_one(
        "INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps,
                                 principal, opening_collateral)
         VALUES ($1::text::uuid, 'l1125-user', 'USDT', 'BTC', 'USDT', 1000, '100'::numeric, $2::text::numeric)
         RETURNING id::text",
        &[&product, &pledged],
    )
    .map(|r| r.get(0))
}

fn rewrite_opening(
    c: &mut impl postgres::GenericClient,
    loan: &str,
    amount: &str,
) -> Result<u64, postgres::Error> {
    c.execute(
        "UPDATE bank.loans SET opening_collateral = $2::text::numeric WHERE id = $1::text::uuid",
        &[&loan, &amount],
    )
}

#[test]
fn keeps_a_pledged_amount_leaves_a_legacy_null_null_and_allows_another_column_to_change() {
    let Some(k) = kit() else { return };
    let mut c = k.db.client();
    let mut tx = c.transaction().unwrap();
    let product: String = tx
        .query_one(
            &format!(
                "INSERT INTO bank.loan_products ({FLOOR_COLS}) VALUES \
                 ('l1125-opening-collateral', 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, \
                 3600) RETURNING id::text"
            ),
            &[],
        )
        .unwrap()
        .get(0);
    let pledged = insert_opening(&mut tx, &product, Some("10")).unwrap();
    let legacy = insert_opening(&mut tx, &product, None).unwrap();

    let pledged_before = opening(&mut tx, &pledged);
    assert!(pledged_before.1.is_some());
    assert!(pledged_before.2);
    assert!(!pledged_before.3);
    assert!(!pledged_before.4);
    let legacy_before = opening(&mut tx, &legacy);
    assert_eq!(legacy_before.1, None);
    assert!(legacy_before.4);
    assert!(!legacy_before.2);

    check_violation(
        in_savepoint(&mut tx, |t| rewrite_opening(t, &pledged, "1")),
        None,
    );
    let pledged_after = opening(&mut tx, &pledged);
    assert_eq!(pledged_after.1, pledged_before.1);
    assert!(pledged_after.2);
    assert!(!pledged_after.3);
    assert_eq!(pledged_after.0, pledged_before.0);

    check_violation(
        in_savepoint(&mut tx, |t| rewrite_opening(t, &legacy, "10")),
        None,
    );
    let legacy_after = opening(&mut tx, &legacy);
    assert_eq!(legacy_after.1, None);
    assert!(legacy_after.4);
    assert_eq!(legacy_after.0, legacy_before.0);

    tx.execute(
        "UPDATE bank.loans SET status = 'active' WHERE id = $1::text::uuid",
        &[&pledged],
    )
    .unwrap();
    let pledged_moved = opening(&mut tx, &pledged);
    assert_eq!(pledged_moved.0, "active");
    assert_eq!(pledged_moved.1, pledged_before.1);
    assert!(pledged_moved.2);
    tx.execute(
        "UPDATE bank.loans SET status = 'active' WHERE id = $1::text::uuid",
        &[&legacy],
    )
    .unwrap();
    let legacy_moved = opening(&mut tx, &legacy);
    assert_eq!(legacy_moved.0, "active");
    assert_eq!(legacy_moved.1, None);
    assert!(legacy_moved.4);

    check_violation(
        in_savepoint(&mut tx, |t| insert_opening(t, &product, Some("0"))),
        Some("loans_opening_collateral_positive"),
    );

    let column = texts(
        &tx.query(
            "SELECT data_type::text, numeric_precision::text, numeric_scale::text, is_nullable::text
               FROM information_schema.columns
              WHERE table_schema = 'bank' AND table_name = 'loans' AND column_name = 'opening_collateral'",
            &[],
        )
        .unwrap(),
    );
    assert_eq!(
        column[0],
        vec![
            Some("numeric".to_owned()),
            Some("38".to_owned()),
            Some("18".to_owned()),
            Some("YES".to_owned())
        ]
    );
    tx.rollback().unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// blank-min-principal.test.ts › blank loan minPrincipal refuses and is not stored as 0

const PRODUCT_ID: &str = "11111111-1111-4111-8111-111111111111";

fn blank_terms() -> NewProduct {
    NewProduct {
        min_principal: None,
        ..new_product()
    }
}

fn products(k: &Kit) -> i64 {
    k.count("SELECT count(*)::int8 FROM bank.loan_products")
}

#[test]
fn create_product_refuses_a_blank_floor_before_any_insert() {
    // `undefined` and `null` are the Rust `None`; `''` and `'   '` cannot be built as a floor (`Option<Amount>`).
    let Some(k) = kit() else { return };
    let e = err(space::with(&k.store, |c| {
        model::create_product(c, &blank_terms())
    }));
    assert!(matches!(e, Refusal::Bank(_)), "{e:?}");
    assert_eq!(code(&e), "bank.loan_params_invalid");
    assert_eq!(
        products(&k),
        0,
        "a blank floor must not be written, including as 0"
    );
}

#[test]
fn create_product_stores_an_explicit_0n() {
    let Some(k) = kit() else { return };
    let p = k.product_with(|p| p.min_principal = Some(0));
    assert_eq!(products(&k), 1);
    assert_eq!(
        k.one(&format!(
            "SELECT (min_principal IS NOT NULL AND min_principal = 0)::text FROM bank.loan_products WHERE id = '{}'",
            p.id
        ))
        .as_deref(),
        Some("true")
    );
    assert_eq!(p.min_principal, 0);
}

#[test]
fn create_product_once_refuses_a_blank_floor_before_any_insert_and_still_accepts_0n() {
    let Some(k) = kit() else { return };
    let e = err(space::with(&k.store, |c| {
        model::create_product_once(c, PRODUCT_ID, &blank_terms())
    }));
    assert_eq!(code(&e), "bank.loan_params_invalid");
    assert_eq!(products(&k), 0);

    let (product, replayed) = space::with(&k.store, |c| {
        model::create_product_once(c, PRODUCT_ID, &new_product())
    })
    .unwrap();
    assert!(!replayed);
    assert_eq!(product.min_principal, 0);
    assert_eq!(products(&k), 1);
}

#[test]
fn assert_loan_params_names_a_blank_floor_and_still_allows_0n() {
    let e = err(model::assert_loan_params(&blank_terms()));
    assert_eq!(code(&e), "bank.loan_params_invalid");
    assert!(
        loans_kit::message(&e).contains("minPrincipal is blank"),
        "{e:?}"
    );
    assert!(model::assert_loan_params(&new_product()).is_ok());
    let e = err(model::assert_loan_params(&NewProduct {
        min_principal: Some(-1),
        ..new_product()
    }));
    assert!(
        loans_kit::message(&e).contains("cannot be negative"),
        "{e:?}"
    );
}

#[test]
fn reading_a_stored_blank_floor_is_a_typed_refusal_not_0() {
    // A stored `null`; `''` and `'   '` cannot be stored in the numeric column the Rust reads.
    let Some(k) = kit() else { return };
    k.sql(&format!(
        "INSERT INTO bank.loan_products (id, {FLOOR_COLS}, min_principal) VALUES \
         ('{PRODUCT_ID}', 'BTC-backed USDT', 'USDT', 'BTC', 'USDT', 1000, 5000, 7500, 8500, 9500, 6500, 200, 2500, \
         3600, NULL)"
    ));
    let e = err(space::with(&k.store, |c| model::product(c, PRODUCT_ID)));
    assert!(
        matches!(e, Refusal::Bank(_)),
        "a typed refusal, not a money error: {e:?}"
    );
    assert_eq!(code(&e), "bank.loan_params_invalid");
}

#[test]
fn reading_a_stored_number_keeps_that_number_including_0() {
    let Some(k) = kit() else { return };
    let zero = k.product_with(|p| p.min_principal = Some(0));
    assert_eq!(
        space::with(&k.store, |c| model::product(c, &zero.id))
            .unwrap()
            .min_principal,
        0
    );
    let floor = k.product_with(|p| p.min_principal = Some(amt("12.5")));
    assert_eq!(
        space::with(&k.store, |c| model::product(c, &floor.id))
            .unwrap()
            .min_principal,
        amt("12.5")
    );
}
