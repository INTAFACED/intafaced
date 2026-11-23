//! Slice `loans` against Postgres: the DB half of `services/svc-bank/src/loans/loans.test.ts` ("svc-bank loans
//! PG-hard › LoanService"), each test named after the TypeScript test's words. A call on `LoanService` is the Rust
//! function it became, given the dependencies `loans_kit` builds (the TypeScript's `MemoryLedger`, `fixedPriceSource`,
//! `marketMakerVenue` and recording sink). Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it
//! fails.
//!
//! Every test of that block (`loans.test.ts`, from `describe('LoanService'` up to `describe('the risk sweep'`) is here;
//! none is skipped. The suite's `ledger.post` overrides (`loseDrawReply`, the gate a resume's draw is parked behind)
//! are `Hooked`, a wrapper over the kit's book; a second `LoanService` with other marks is the kit's marks reset;
//! `recipes.withdrawHold` is a seed from the borrower's available into a hold account.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use crate::loans_kit::{
    BORROWER, Book, DAY, HOUR, Kit, OTHER, amt, code, fmt, message, plus, uuid,
};

use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;
use svc_bank::errors::Refusal;
use svc_bank::loans::model::Loan;
use svc_bank::loans::ports::Deps;
use svc_bank::loans::prices::default_mark_policy;
use svc_bank::loans::service::{self, OpenAsk, house_fees};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};

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
    assert!(message(&e).contains("exceeds the"), "{e:?}");
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
fn refuses_the_second_borrower_on_a_loan_still_stuck_pending_leaving_the_first_one_alone() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    k.fund(OTHER, "BTC", "5");
    let p = k.product();
    let id = "6f000000-0000-4000-8000-00000000eeee";
    let _ = k.open_as(BORROWER, id, &p.id, "1", "5000");
    k.fund_reserve("USDT", "100000");
    let e = k.open_as(OTHER, id, &p.id, "5", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.loan_borrower_mismatch");
    let l = k.loan(id);
    assert_eq!(l.user_id, BORROWER);
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.available(OTHER, "BTC"), "5");
}

#[test]
fn refuses_a_loan_id_reused_by_the_same_borrower_for_a_different_product() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let first = k.product_with(|p| p.name = "First BTC-backed USDT".to_owned());
    let other = k.product_with(|p| p.name = "Other BTC-backed USDT".to_owned());
    let id = "6f000000-0000-4000-8000-00000000eeef";
    let opened = k.open_as(BORROWER, id, &first.id, "1", "5000").unwrap();
    let e = k
        .open_as(BORROWER, id, &other.id, "1", "5000")
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.loan_borrower_mismatch");
    assert_eq!(opened.loan.product_id, first.id);
    assert_eq!(
        fmt(k.d(|d| service::collateral_of(d, &opened.loan)).unwrap()),
        "1"
    );
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
}

// ── The crash window between locking collateral and releasing principal ──────────────────────────────────────────

#[test]
fn leaves_the_collateral_in_the_borrowers_own_account_with_the_reserve_untouched() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let e = k.open(&p.id, "1", "5000").err().unwrap();
    assert!(matches!(e, Refusal::Bank(_)), "{e:?}");
    let rows = k.rows("SELECT id::text, status::text FROM bank.loans");
    assert_eq!(rows[0][1].as_deref(), Some("pending"));
    let l = k.loan(rows[0][0].as_deref().unwrap());
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.reserve("USDT"), "0");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
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
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
}

#[test]
fn refuses_a_retry_that_changes_the_principal_instead_of_drawing_the_stored_one() {
    let Some(k) = kit() else { return };
    let p = k.product();
    k.fund_reserve("USDT", "100000");
    let id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    let e = k.open_as(BORROWER, id, &p.id, "1", "5000").err().unwrap();
    assert!(matches!(e, Refusal::Bank(_)), "{e:?}");
    assert_eq!(k.status(id), "pending");
    k.fund(BORROWER, "BTC", "0.01");
    let e = k.open_as(BORROWER, id, &p.id, "0.01", "1").err().unwrap();
    assert_eq!(code(&e), "bank.loan_principal_mismatch");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
    assert_eq!(k.ledger.reserve("USDT"), "100000");
}

#[test]
fn refuses_a_retry_that_changes_the_opening_collateral_instead_of_locking_the_new_amount_against_the_old_principal()
 {
    let Some(k) = kit() else { return };
    let p = k.product();
    k.fund_reserve("USDT", "100000");
    let id = "3fa85f64-5717-4562-b3fc-2c963f66afb1";
    let e = k.open_as(BORROWER, id, &p.id, "1", "5000").err().unwrap();
    assert!(matches!(e, Refusal::Bank(_)), "{e:?}");
    let row = k.rows(&format!(
        "SELECT status::text, opening_collateral::text FROM bank.loans WHERE id = '{id}'"
    ));
    assert_eq!(row[0][0].as_deref(), Some("pending"));
    assert_eq!(fmt(amt(row[0][1].as_deref().unwrap())), "1");
    k.fund(BORROWER, "BTC", "2");
    let e = k.open_as(BORROWER, id, &p.id, "2", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.loan_collateral_mismatch");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "2");
    assert_eq!(k.ledger.reserve("USDT"), "100000");
}

#[test]
fn refuses_a_hostile_collateral_swap_after_the_loan_is_already_active() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let id = "3fa85f64-5717-4562-b3fc-2c963f66afb2";
    let opened = k.open_as(BORROWER, id, &p.id, "1", "5000").unwrap();
    assert_eq!(opened.loan.status, "active");
    let e = k.open_as(BORROWER, id, &p.id, "2", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.loan_collateral_mismatch");
    assert_eq!(
        fmt(k.d(|d| service::collateral_of(d, &opened.loan)).unwrap()),
        "1"
    );
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
}

#[test]
fn still_lets_an_unchanged_retry_re_drive_the_same_loan() {
    let Some(k) = kit() else { return };
    let p = k.product();
    k.fund(BORROWER, "BTC", "1");
    let id = "3fa85f64-5717-4562-b3fc-2c963f66afa7";
    let _ = k.open_as(BORROWER, id, &p.id, "1", "5000");
    k.fund_reserve("USDT", "100000");
    let retried = k.open_as(BORROWER, id, &p.id, "1", "5000").unwrap();
    assert_eq!(retried.loan.id, id);
    assert_eq!(retried.loan.status, "active");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(
        fmt(k.d(|d| service::collateral_of(d, &retried.loan)).unwrap()),
        "1"
    );
}

#[test]
fn recovers_by_abandoning_the_collateral_goes_back_to_the_borrower() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let _ = k.open(&p.id, "1", "5000");
    let id = k.one("SELECT id::text FROM bank.loans").unwrap();
    k.age_last_attempt(&id, service::IN_FLIGHT_BOUND_SECONDS + 60);
    let r = k.d(|d| service::abandon_pending(d, &id)).unwrap();
    assert_eq!(fmt(r.released), "1");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

#[test]
fn refuses_to_abandon_a_loan_whose_principal_has_been_drawn() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let opened = k.open(&p.id, "1", "5000").unwrap();
    let e = k
        .d(|d| service::abandon_pending(d, &opened.loan.id))
        .err()
        .unwrap();
    assert!(message(&e).contains("secures drawn principal"), "{e:?}");
}

// ── Recovering a pending loan looks the draw up first ────────────────────────────────────────────────────────────

const LOAN_ID: &str = "6f000000-0000-4000-8000-0000000000a1";

/// The suite's `ledger.post` override: the kit's book, with a count of draw posts, a draw whose reply is lost once
/// after it commits (`loseDrawReply`), and a gate a draw post can be parked behind.
struct Hooked<'a> {
    inner: &'a Book,
    lose_draw: AtomicBool,
    draw_posts: AtomicUsize,
    entered: Mutex<Option<mpsc::Sender<()>>>,
    gate: Mutex<Option<mpsc::Receiver<()>>>,
}

impl<'a> Hooked<'a> {
    fn new(inner: &'a Book) -> Hooked<'a> {
        Hooked {
            inner,
            lose_draw: AtomicBool::new(false),
            draw_posts: AtomicUsize::new(0),
            entered: Mutex::new(None),
            gate: Mutex::new(None),
        }
    }
    fn posts(&self) -> usize {
        self.draw_posts.load(Ordering::SeqCst)
    }
}

impl Ledger for Hooked<'_> {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        self.inner.balance(a)
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        self.inner.balances(owner_type, owner)
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.inner.assets()
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        self.inner.account_id(a)
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_id(tx_id)
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_key(key)
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let draw = key.starts_with("bank.loan.draw:");
        if draw {
            self.draw_posts.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.entered.lock().unwrap().take() {
                tx.send(()).unwrap();
            }
            let gate = self.gate.lock().unwrap().take();
            if let Some(rx) = gate {
                rx.recv().unwrap();
            }
        }
        let receipt = self.inner.post_recipe(recipe, input, key)?;
        if draw && self.lose_draw.swap(false, Ordering::SeqCst) {
            return Err(PostFailure::Unknown("reply lost after commit".to_owned()));
        }
        Ok(receipt)
    }
}

/// The kit's dependencies, with `ledger` in place of the kit's book.
fn deps<'a>(k: &'a Kit, ledger: &'a dyn Ledger) -> Deps<'a> {
    Deps {
        store: &k.store,
        ledger,
        custody_layer: &k.custody,
        approvals: &k.desk,
        prices: &k.prices,
        venue: &k.venue,
        margin_calls: &k.calls,
        affiliates: &k.told,
        settings: &k.settings,
        now: k.now,
    }
}

fn open_ask<'a>(product: &'a str, collateral: &str, principal: &str) -> OpenAsk<'a> {
    OpenAsk {
        loan_id: LOAN_ID,
        product_id: product,
        user_id: BORROWER,
        collateral_amount: amt(collateral),
        principal: amt(principal),
        expected_apr_bps: None,
    }
}

/// `openWithLostDrawReply`: a funded reserve, 1 BTC, and an open whose draw commits and whose reply is lost.
fn open_with_lost_draw_reply<'a>(k: &'a Kit) -> Hooked<'a> {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let lossy = Hooked::new(&k.ledger);
    lossy.lose_draw.store(true, Ordering::SeqCst);
    let e = service::open(&deps(k, &lossy), &open_ask(&p.id, "1", "5000"))
        .err()
        .unwrap();
    assert!(message(&e).contains("reply lost after commit"), "{e:?}");
    lossy
}

fn open_pending(k: &Kit, p: &str) {
    let _ = k.open_as(BORROWER, LOAN_ID, p, "1", "5000");
}

fn keyed(k: &Kit, prefix: &str) -> usize {
    k.ledger
        .journal()
        .iter()
        .filter(|b| b.key.starts_with(prefix))
        .count()
}

#[test]
fn abandon_adopts_a_booked_draw_the_loan_goes_active_and_the_collateral_stays_locked() {
    let Some(k) = kit() else { return };
    let lossy = open_with_lost_draw_reply(&k);
    assert_eq!(k.status(LOAN_ID), "pending");
    let r = service::abandon_pending(&deps(&k, &lossy), LOAN_ID).unwrap();
    assert_eq!(r.released, Amount::ZERO);
    assert_eq!(r.ledger_tx_id, None);
    assert!(r.adopted);
    let draw_tx = r.draw_ledger_tx_id.clone().unwrap();
    let l = k.loan(LOAN_ID);
    assert_eq!(l.status, "active");
    assert_eq!(l.draw_ledger_tx_id.as_deref(), Some(draw_tx.as_str()));
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(keyed(&k, "bank.loan.collateral.release:"), 0);
    assert_eq!(lossy.posts(), 1);
    let lock = k.one(&format!(
        "SELECT status::text FROM bank.loan_collateral_events WHERE loan_id = '{LOAN_ID}' AND sequence = 0"
    ));
    assert_eq!(lock.as_deref(), Some("settled"));
    let e = k.d(|d| service::abandon_pending(d, LOAN_ID)).err().unwrap();
    assert!(message(&e).contains("secures drawn principal"), "{e:?}");
}

#[test]
fn abandon_refuses_an_unbooked_draw_whose_last_attempt_is_inside_the_in_flight_bound() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    let e = k.d(|d| service::abandon_pending(d, LOAN_ID)).err().unwrap();
    assert_eq!(code(&e), "bank.loan_attempt_too_recent");
    k.age_last_attempt(LOAN_ID, service::IN_FLIGHT_BOUND_SECONDS - 30);
    let e = k.d(|d| service::abandon_pending(d, LOAN_ID)).err().unwrap();
    assert_eq!(code(&e), "bank.loan_attempt_too_recent");
    let l = k.loan(LOAN_ID);
    assert_eq!(l.status, "pending");
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0");
}

#[test]
fn abandon_releases_an_unbooked_draw_once_the_last_attempt_is_older_than_the_bound() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    k.age_last_attempt(LOAN_ID, service::IN_FLIGHT_BOUND_SECONDS + 5);
    let r = k.d(|d| service::abandon_pending(d, LOAN_ID)).unwrap();
    assert!(!r.adopted);
    assert_eq!(r.draw_ledger_tx_id, None);
    assert_eq!(fmt(r.released), "1");
    assert_eq!(k.status(LOAN_ID), "repaid");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

#[test]
fn every_post_attempt_moves_the_last_attempt_time_forward() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    k.age_last_attempt(LOAN_ID, service::IN_FLIGHT_BOUND_SECONDS + 5);
    open_pending(&k, &p.id);
    let e = k.d(|d| service::abandon_pending(d, LOAN_ID)).err().unwrap();
    assert_eq!(code(&e), "bank.loan_attempt_too_recent");
}

#[test]
fn resume_adopts_a_booked_draw_without_posting_it_again() {
    let Some(k) = kit() else { return };
    let lossy = open_with_lost_draw_reply(&k);
    let resumed = service::resume_pending(&deps(&k, &lossy), Some(100.0)).unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].loan_id, LOAN_ID);
    assert_eq!(resumed[0].outcome, "completed");
    assert_eq!(resumed[0].reason, None);
    let l = k.loan(LOAN_ID);
    assert_eq!(l.status, "active");
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(lossy.posts(), 1);
}

#[test]
fn resume_re_checks_the_ltv_before_re_posting_a_draw_a_failed_check_posts_nothing() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    k.fund_reserve("USDT", "100000");
    // BTC crashed while the loan sat pending: 1 BTC at 5200 against a 5000 draw is 96% LTV.
    k.prices.btc("5200");
    let resumed = k.d(|d| service::resume_pending(d, Some(100.0))).unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].outcome, "failed");
    let reason = resumed[0].reason.clone().unwrap_or_default();
    assert!(reason.contains("Opening LTV"), "{reason}");
    assert_eq!(k.status(LOAN_ID), "pending");
    assert_eq!(keyed(&k, "bank.loan.draw:"), 0);
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
}

#[test]
fn resume_refuses_a_mark_older_than_the_price_policy_before_re_posting_a_draw() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    k.fund_reserve("USDT", "100000");
    // The feed is stuck at a mark stamped two policy windows before "now".
    k.prices.stamp(plus(
        k.now,
        -2 * default_mark_policy().max_age_seconds * 1000,
    ));
    let resumed = k.d(|d| service::resume_pending(d, Some(100.0))).unwrap();
    assert_eq!(resumed[0].outcome, "failed");
    let reason = resumed[0].reason.clone().unwrap_or_default();
    assert!(reason.contains("No usable mark"), "{reason}");
    assert_eq!(keyed(&k, "bank.loan.draw:"), 0);
    k.prices.stamp(k.now);
    let ok = k.d(|d| service::resume_pending(d, Some(100.0))).unwrap();
    assert_eq!(ok[0].outcome, "completed");
}

#[test]
fn add_collateral_refuses_a_pending_loan_a_top_up_is_for_a_drawn_loan() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "2");
    let p = k.product();
    open_pending(&k, &p.id);
    let e = k
        .d(|d| service::add_collateral(d, LOAN_ID, &uuid(), amt("1")))
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.loan_not_drawable");
    let l = k.loan(LOAN_ID);
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

#[test]
fn abandon_blocks_while_a_resume_is_inside_its_draw_post_then_sees_the_loan_active() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    open_pending(&k, &p.id);
    k.fund_reserve("USDT", "100000");
    // Old enough that the bound alone would let an abandon through.
    k.age_last_attempt(LOAN_ID, service::IN_FLIGHT_BOUND_SECONDS + 60);

    // Park the resume inside its draw post.
    let gated = Hooked::new(&k.ledger);
    let (entered_tx, entered) = mpsc::channel();
    let (open, gate) = mpsc::channel();
    *gated.entered.lock().unwrap() = Some(entered_tx);
    *gated.gate.lock().unwrap() = Some(gate);

    let (k, gated) = (&k, &gated);
    std::thread::scope(|s| {
        let resume = s.spawn(move || service::resume_pending(&deps(k, gated), Some(100.0)));
        entered.recv_timeout(Duration::from_secs(30)).unwrap();

        let (done_tx, done) = mpsc::channel();
        let abandon = s.spawn(move || {
            let r = k.d(|d| service::abandon_pending(d, LOAN_ID));
            done_tx.send(()).unwrap();
            r
        });
        assert_eq!(
            done.recv_timeout(Duration::from_millis(500)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "abandon settled while the draw was in flight"
        );
        // Nothing was released while the draw was in flight.
        let l = k.loan(LOAN_ID);
        assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");

        open.send(()).unwrap();
        let resumed = resume.join().unwrap().unwrap();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].loan_id, LOAN_ID);
        assert_eq!(resumed[0].outcome, "completed");
        assert_eq!(resumed[0].reason, None);
        let e = abandon.join().unwrap().err().unwrap();
        assert!(message(&e).contains("secures drawn principal"), "{e:?}");
    });
    let l = k.loan(LOAN_ID);
    assert_eq!(l.status, "active");
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
}

#[test]
fn resume_treats_a_rejected_collateral_lock_as_final_and_does_not_post_it_again() {
    let Some(k) = kit() else { return };
    let p = k.product();
    k.fund_reserve("USDT", "100000");
    let e = k
        .open_as(BORROWER, LOAN_ID, &p.id, "1", "5000")
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.loan_collateral_short");
    let lock = k.one(&format!(
        "SELECT status::text FROM bank.loan_collateral_events WHERE loan_id = '{LOAN_ID}' AND sequence = 0"
    ));
    assert_eq!(lock.as_deref(), Some("rejected"));
    k.fund(BORROWER, "BTC", "1");
    let resumed = k.d(|d| service::resume_pending(d, Some(100.0))).unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].loan_id, LOAN_ID);
    assert_eq!(resumed[0].outcome, "failed");
    let reason = resumed[0].reason.clone().unwrap_or_default();
    assert!(reason.contains("collateral_rejected"), "{reason}");
    assert_eq!(k.status(LOAN_ID), "pending");
    assert_eq!(keyed(&k, "bank.loan.collateral.lock:"), 0);
    assert_eq!(keyed(&k, "bank.loan.draw:"), 0);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

#[test]
fn a_retried_open_with_the_same_loan_id_opens_one_loan_not_two() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "2");
    let p = k.product();
    let id = "44444444-4444-4444-8444-444444444444";
    let first = k.open_as(BORROWER, id, &p.id, "1", "5000").unwrap();
    let second = k.open_as(BORROWER, id, &p.id, "1", "5000").unwrap();
    assert_eq!(second.loan.id, first.loan.id);
    assert_eq!(k.count("SELECT count(*) FROM bank.loans"), 1);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

// ── Interest accrual is idempotent per (loan, day) ───────────────────────────────────────────────────────────────

/// 36.5% APR == 0.1%/day.
fn open_accruing(k: &Kit) -> Loan {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product_with(|p| p.apr_bps = 3_650);
    k.open(&p.id, "1", "5000").unwrap().loan
}

fn accrue(k: &Kit, id: &str, until: Instant) -> service::Accrued {
    k.d(|d| service::accrue(d, id, until)).unwrap()
}

#[test]
fn charges_nothing_on_the_day_the_loan_opens() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    let r = accrue(&k, &l.id, plus(k.now, 6 * HOUR));
    assert_eq!(r.days.len(), 0);
    assert_eq!(fmt(k.debt(&l.id).total), "5000");
}

#[test]
fn running_the_job_three_times_for_the_same_day_charges_that_day_once() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    let until = plus(k.now, DAY);
    let first = accrue(&k, &l.id, until);
    let second = accrue(&k, &l.id, until);
    let third = accrue(&k, &l.id, until);
    assert_eq!(first.days.len(), 1);
    assert!(!first.days[0].already);
    assert_eq!(second.days.len(), 0);
    assert_eq!(third.days.len(), 0);
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_interest_accruals WHERE loan_id = '{}'",
            l.id
        )),
        1
    );
    assert_eq!(fmt(k.debt(&l.id).interest), "5");
}

#[test]
fn catches_up_a_three_day_outage_charging_each_day_once_and_compounding_correctly() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    let r = accrue(&k, &l.id, plus(k.now, 3 * DAY));
    let dates: Vec<&str> = r.days.iter().map(|d| d.date.as_str()).collect();
    assert_eq!(dates, ["2026-06-02", "2026-06-03", "2026-06-04"]);
    assert_eq!(fmt(k.debt(&l.id).total), "5015.015005");
    let bases: Vec<String> = k
        .rows(&format!(
            "SELECT principal_basis::text FROM bank.loan_interest_accruals WHERE loan_id = '{}' ORDER BY accrual_date",
            l.id
        ))
        .iter()
        .map(|r| fmt(amt(r[0].as_deref().unwrap())))
        .collect();
    assert_eq!(bases, ["5000", "5005", "5010.005"]);
}

#[test]
fn a_catch_up_charges_exactly_what_three_separate_nightly_runs_would_have() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.fund(OTHER, "BTC", "1");
    let p = k.product_with(|p| p.apr_bps = 3_650);
    let nightly = k.open(&p.id, "1", "5000").unwrap().loan;
    let caught_up = k.open_as(OTHER, &uuid(), &p.id, "1", "5000").unwrap().loan;
    for day in 1..=3 {
        accrue(&k, &nightly.id, plus(k.now, day * DAY));
    }
    accrue(&k, &caught_up.id, plus(k.now, 3 * DAY));
    let a = k.debt(&nightly.id);
    let b = k.debt(&caught_up.id);
    assert_eq!(fmt(b.total), fmt(a.total));
    assert_eq!(fmt(b.total), "5015.015005");
    let per_loan: Vec<String> = k
        .rows("SELECT COUNT(*)::text FROM bank.loan_interest_accruals GROUP BY loan_id")
        .iter()
        .map(|r| r[0].clone().unwrap())
        .collect();
    assert_eq!(per_loan, ["3", "3"]);
}

#[test]
fn posts_nothing_to_the_ledger_interest_capitalises_rather_than_being_debited() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    let before = k.ledger.available(BORROWER, "USDT");
    let house_before = k.ledger.bal(&house_fees("USDT"));
    accrue(&k, &l.id, plus(k.now, DAY));
    assert_eq!(k.ledger.available(BORROWER, "USDT"), before);
    assert_eq!(k.ledger.bal(&house_fees("USDT")), house_before);
    assert_eq!(fmt(k.debt(&l.id).interest), "5");
}

#[test]
fn does_not_charge_interest_on_a_loan_whose_principal_was_never_drawn() {
    let Some(k) = kit() else { return };
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let _ = k.open(&p.id, "1", "5000");
    let id = k.one("SELECT id::text FROM bank.loans").unwrap();
    let r = accrue(&k, &id, plus(k.now, 5 * DAY));
    assert_eq!(r.days.len(), 0);
}

// ── Repayment ────────────────────────────────────────────────────────────────────────────────────────────────────

fn repay(k: &Kit, id: &str, amount: &str) -> Result<service::Repaid, Refusal> {
    k.d(|d| service::repay(d, id, amt(amount), &uuid()))
}

#[test]
fn settles_interest_before_principal() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    accrue(&k, &l.id, plus(k.now, DAY));
    let r = repay(&k, &l.id, "100").unwrap();
    assert_eq!(fmt(r.interest_paid), "5");
    assert_eq!(fmt(r.principal_paid), "95");
    assert_eq!(fmt(r.remaining.total), "4905");
}

#[test]
fn refuses_to_release_collateral_while_anything_is_outstanding() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    repay(&k, &l.id, "1000").unwrap();
    let e = k.d(|d| service::release_settled(d, &l.id)).err().unwrap();
    assert!(message(&e).contains("still owes"), "{e:?}");
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "1");
}

#[test]
fn releases_the_collateral_automatically_the_moment_the_debt_reaches_zero() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    let r = repay(&k, &l.id, "5000").unwrap();
    assert!(r.closed);
    assert_eq!(fmt(k.d(|d| service::collateral_of(d, &l)).unwrap()), "0");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
    assert_eq!(k.status(&l.id), "repaid");
}

#[test]
fn never_takes_more_than_is_owed() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    k.fund(BORROWER, "USDT", "10000");
    let r = repay(&k, &l.id, "99999").unwrap();
    assert_eq!(fmt(r.principal_paid), "5000");
    assert_eq!(fmt(r.remaining.total), "0");
}

#[test]
fn a_repayment_the_borrower_cannot_fund_fails_without_corrupting_the_loan() {
    let Some(k) = kit() else { return };
    let l = open_accruing(&k);
    // `recipes.withdrawHold({ userId: BORROWER, assetId: 'USDT', amount: 5000, withdrawalId: 'drain' })`: the
    // borrower's available moves to a withdrawal hold.
    k.ledger.seed(
        BORROWER,
        &LedgerAccount {
            owner_type: "user",
            owner_id: BORROWER.to_owned(),
            asset_id: "USDT".to_owned(),
            kind: "hold",
            purpose: Some("withdrawal:drain".to_owned()),
        },
        "5000",
    );
    let e = repay(&k, &l.id, "1000").err().unwrap();
    assert!(message(&e).contains("nsufficient"), "{e:?}");
    let status = k.one(&format!(
        "SELECT status::text FROM bank.loan_repayments WHERE loan_id = '{}'",
        l.id
    ));
    assert_eq!(status.as_deref(), Some("rejected"));
    assert_eq!(fmt(k.debt(&l.id).total), "5000");
}
