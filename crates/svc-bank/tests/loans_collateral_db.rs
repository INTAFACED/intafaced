//! Slice `loans` against Postgres: collateral in and out, and the public doors that open, top up, release and seize.
//! Ports of these TypeScript suites in `services/svc-bank/src/loans/`, each test named after the TypeScript test's
//! words:
//!
//! - `add-collateral-public-door.test.ts`
//! - `add-collateral-race.db.test.ts`
//! - `add-collateral-retry-id.test.ts`
//! - `releasable.test.ts`
//! - `release-excess-once.test.ts`
//! - `release-excess-public-door.test.ts`
//! - `seize-public-door.test.ts`
//! - `originate-public-door.test.ts`
//!
//! A `LoanService` call is the Rust function it became; a router call (`caller(bank)` or HTTP `/trpc/...`) goes
//! through the bank's door, where both TypeScript routes are one. A `ledger.post` wrapped to time out after it books
//! is `Book::lose_reply`; one wrapped to hold a post until released is this file's `Gate`. TypeScript's
//! `Promise.allSettled` is one thread per call, each on its own pooled connection.
//!
//! Skipped, because each reads TypeScript source text rather than running the code:
//! - add-collateral-public-door: "addCollateral loads the loan, then marks, then lockCollateral".
//! - add-collateral-retry-id: "addCollateral resolves the client event id before nextCollateralSequence and does not
//!   mint", "lockCollateral re-reads by id and takes MAX+1 under the loan lock, and posts the claimed row sequence",
//!   "public door requires eventId so omit is not a second loanCollateralLock".
//! - release-excess-public-door: "releaseExcess loads the loan, then marks, then releaseCollateral".
//! - seize-public-door: "seize asks for marks before loanLiquidate", "operator door is ops.seizeLoan, not a user
//!   liquidate".
//! - originate-public-door: "open asks for marks before loanCollateralLock / loanDraw".
//!
//! The behaviour those pins guard is run here instead: no post before the loan and the marks are read (the
//! `mark_missing` and `loan_not_found` tests), and no second lock when the event id is omitted (the 400 tests).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;
use svc_bank::db::{self, Store};
use svc_bank::door;
use svc_bank::errors::Refusal;
use svc_bank::loans::model::{self, Product};
use svc_bank::loans::ports::Deps;
use svc_bank::loans::prices::MarkQuality;
use svc_bank::loans::{service, sweep};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};

use crate::loans_kit::{self, Answer, BORROWER, Kit, Loss, PAYER, amt, call, code, obj, s, uuid};

const MISSING: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUNDS: usize = 25;
const WIDTH: usize = 6;
const RW: &[&str] = &["bank:read", "bank:write"];
const OPS: &[&str] = &["bank:read", "bank:write", "admin:treasury"];

fn kit() -> Option<Kit> {
    Kit::new()
}

// ---------------------------------------------------------------------------------------------------------------
// This file's helpers

/// A ledger that holds the first post matching `hold` until released: the TypeScript's wrapped `ledger.post` that
/// awaits a promise before booking.
#[derive(Clone)]
struct Gate {
    inner: loans_kit::Book,
    state: Arc<(Mutex<GateState>, Condvar)>,
}

#[derive(Default)]
struct GateState {
    /// The recipe and the least sequence a held post carries.
    hold: Option<(String, i64)>,
    reached: bool,
    released: bool,
}

impl Gate {
    fn new(inner: &loans_kit::Book, recipe: &str, min_sequence: i64) -> Gate {
        Gate {
            inner: inner.clone(),
            state: Arc::new((
                Mutex::new(GateState {
                    hold: Some((recipe.to_owned(), min_sequence)),
                    ..GateState::default()
                }),
                Condvar::new(),
            )),
        }
    }

    /// Waits until a post is held there.
    fn wait_reached(&self) {
        let (m, cv) = &*self.state;
        let g = m.lock().unwrap();
        let (g, t) = cv
            .wait_timeout_while(g, Duration::from_secs(20), |s| !s.reached)
            .unwrap();
        assert!(!t.timed_out() && g.reached, "no post reached the ledger");
    }

    fn release(&self) {
        let (m, cv) = &*self.state;
        m.lock().unwrap().released = true;
        cv.notify_all();
    }
}

fn sequence_of(input: &Json) -> i64 {
    match input.get("sequence") {
        #[allow(clippy::cast_possible_truncation, reason = "a whole number")]
        Some(Json::Number(n)) => *n as i64,
        _ => -1,
    }
}

impl Ledger for Gate {
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
        let (m, cv) = &*self.state;
        let mut g = m.lock().unwrap();
        let held = matches!(&g.hold, Some((r, min)) if r == recipe && sequence_of(input) >= *min);
        if held {
            g.hold = None;
            g.reached = true;
            cv.notify_all();
            let (_g, t) = cv
                .wait_timeout_while(g, Duration::from_secs(20), |s| !s.released)
                .unwrap();
            assert!(!t.timed_out(), "the held post was never released");
        } else {
            drop(g);
        }
        self.inner.post_recipe(recipe, input, key)
    }
}

/// A store with room for every racing caller (the kit's holds two connections).
fn wide_store(k: &Kit) -> Store {
    db::open(&k.db.url, "svc-bank", 12, false).unwrap()
}

/// The slice's dependencies over another store and ledger.
fn deps_on<T>(
    k: &Kit,
    store: &Store,
    ledger: &dyn Ledger,
    now: Instant,
    f: impl FnOnce(&Deps<'_>) -> T,
) -> T {
    f(&Deps {
        store,
        ledger,
        custody_layer: &k.custody,
        approvals: &k.desk,
        prices: &k.prices,
        venue: &k.venue,
        margin_calls: &k.calls,
        affiliates: &k.told,
        settings: &k.settings,
        now,
    })
}

/// `seedOpenLoan`: a 100000 USDT reserve from the payer, `btc` on the borrower, the default product with `f`
/// applied, and a loan of `collateral` BTC for `principal` USDT opened at `now`.
fn seed_open_with(
    k: &Kit,
    now: Instant,
    btc: &str,
    collateral: &str,
    principal: &str,
    f: impl FnOnce(&mut model::NewProduct),
) -> (Product, service::Opened) {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", btc);
    let p = k.product_with(f);
    let id = uuid();
    let o = k
        .at(now, |d| {
            service::open(
                d,
                &service::OpenAsk {
                    loan_id: &id,
                    product_id: &p.id,
                    user_id: BORROWER,
                    collateral_amount: amt(collateral),
                    principal: amt(principal),
                    expected_apr_bps: None,
                },
            )
        })
        .unwrap();
    (p, o)
}

fn seed_open(k: &Kit, now: Instant, btc: &str, collateral: &str) -> service::Opened {
    seed_open_with(k, now, btc, collateral, "5000", |_| {}).1
}

/// The wall clock, with the marks stamped at it: `fixedPriceSource(prices)` with no clock of its own, as the door
/// tests use (the door reads the wall clock).
fn live(k: &Kit) -> Instant {
    let now = door::system_now();
    k.prices.stamp(now);
    now
}

fn locks(k: &Kit) -> usize {
    k.ledger.posts("loanCollateralLock").len()
}

fn releases(k: &Kit) -> usize {
    k.ledger.posts("loanCollateralRelease").len()
}

fn liquidations(k: &Kit) -> usize {
    k.ledger.posts("loanLiquidate").len()
}

fn add(k: &Kit, loan: &str, event: &str, amount: &str) -> Result<(String, i64), Refusal> {
    k.d(|d| service::add_collateral(d, loan, event, amt(amount)))
}

fn release(k: &Kit, loan: &str, event: &str, amount: &str) -> Result<(String, i64), Refusal> {
    k.d(|d| service::release_excess(d, loan, event, amt(amount)))
}

fn top_up_body(loan: &str, event: Option<&str>, amount: &str) -> Json {
    let mut f = vec![("loanId", Json::str(loan)), ("amount", Json::str(amount))];
    if let Some(e) = event {
        f.push(("eventId", Json::str(e)));
    }
    obj(&f)
}

/// The door's answer to a borrower's write.
fn borrower(k: &Kit, path: &str, input: &Json) -> Answer {
    live(k);
    call(&k.door(), BORROWER, RW, path, input)
}

/// `{ ledgerTxId, sequence }` from a 200.
fn receipt(a: &Answer) -> (String, i64) {
    let data = a.ok();
    let seq: i64 = s(&data, "sequence").parse().unwrap();
    (s(&data, "ledgerTxId"), seq)
}

fn decimal(v: &str) -> bool {
    let mut parts = v.splitn(2, '.');
    let whole = parts.next().unwrap_or_default();
    let frac = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// An operator's approval of `ops.seizeLoan` on this loan, as the door hashes it.
fn seize_body(k: &Kit, loan: &str) -> Json {
    let approval = k
        .desk
        .issue("bank.seize_loan", &[("loanId".to_owned(), loan.to_owned())]);
    obj(&[
        ("loanId", Json::str(loan)),
        (
            "confirmOperatorId",
            Json::str("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
        ),
        ("approvalId", Json::str(approval)),
        ("operationId", Json::str("op-1")),
    ])
}

fn liquidation_rows(k: &Kit, loan: &str) -> i64 {
    k.count(&format!(
        "SELECT count(*) FROM bank.loan_liquidations WHERE loan_id = '{loan}'"
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// add-collateral-public-door.test.ts

// "LoanService.addCollateral refuses missing loan or mark before any post"

#[test]
fn add_collateral_bank_loan_not_found_no_loan_collateral_locked() {
    let Some(k) = kit() else { return };
    let e = add(&k, MISSING, &uuid(), "1").err().unwrap();
    assert_eq!(code(&e), "bank.loan_not_found");
    assert_eq!(locks(&k), 0);
}

#[test]
fn add_collateral_bank_mark_missing_no_extra_lock() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "2", "1");
    let before = locks(&k);
    k.prices.clear();
    let e = add(&k, &o.loan.id, &uuid(), "1").err().unwrap();
    assert_eq!(code(&e), "bank.mark_missing");
    assert_eq!(locks(&k), before);
}

// "HTTP /trpc/loans.addCollateral — top-up through ledger-client"

#[test]
fn add_collateral_refuses_bank_loan_not_found_on_the_public_door_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let a = borrower(
        &k,
        "loans.addCollateral",
        &top_up_body(MISSING, Some(&uuid()), "1"),
    );
    assert_eq!(a.0, 404, "{}", a.1.compact());
    assert_eq!(a.trpc(), "NOT_FOUND");
    assert_eq!(a.cause(), "bank.loan_not_found");
    assert_eq!(locks(&k), 0);
}

#[test]
fn add_collateral_refuses_bank_mark_missing_on_the_public_door_and_posts_no_extra_lock() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "2", "1");
    let before = locks(&k);
    k.prices.clear();
    let a = borrower(
        &k,
        "loans.addCollateral",
        &top_up_body(&o.loan.id, Some(&uuid()), "1"),
    );
    assert_eq!(a.0, 412, "{}", a.1.compact());
    assert_eq!(a.trpc(), "PRECONDITION_FAILED");
    assert_eq!(a.cause(), "bank.mark_missing");
    assert!(
        a.1.get("error")
            .unwrap()
            .compact()
            .contains("bank.mark_missing")
    );
    assert_eq!(locks(&k), before);
}

#[test]
fn add_collateral_with_a_mark_posts_loan_collateral_locked_no_invented_rate() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "2", "1");
    let before = locks(&k);
    let a = borrower(
        &k,
        "loans.addCollateral",
        &top_up_body(&o.loan.id, Some(&uuid()), "1"),
    );
    let (tx, seq) = receipt(&a);
    assert!(!tx.is_empty());
    assert!(seq >= 0);
    assert_eq!(locks(&k), before + 1);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0");
}

// ---------------------------------------------------------------------------------------------------------------
// add-collateral-race.db.test.ts — "collateral top-ups that race on one loan"

/// The race suite's seed: 1000 BTC on the borrower, a 5% product with a minimum of 1, 1 BTC for 100 USDT.
fn race_seed(k: &mut Kit) -> service::Opened {
    k.settings.payoff_fee = Some("0".to_owned());
    k.settings.payoff_window_minutes = Some("15".to_owned());
    k.settings.statement_secret = Some("bank-add-collateral-race-secret".to_owned());
    seed_open_with(k, k.now, "1000", "1", "100", |p| {
        p.apr_bps = 500;
        p.min_principal = Some(amt("1"));
    })
    .1
}

#[test]
fn the_same_event_id_sent_at_once_no_23505_one_row_one_ledger_lock_the_same_answer_to_every_caller()
{
    let Some(mut k) = kit() else { return };
    let l = race_seed(&mut k).loan;
    let store = wide_store(&k);
    let before = k.d(|d| service::collateral_of(d, &l)).unwrap();
    for _ in 0..ROUNDS {
        let event = uuid();
        let settled: Vec<Result<(String, i64), Refusal>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..WIDTH)
                .map(|_| {
                    sc.spawn(|| {
                        deps_on(&k, &store, &k.ledger, k.now, |d| {
                            service::add_collateral(d, &l.id, &event, amt("0.01"))
                        })
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let failed: Vec<String> = settled
            .iter()
            .filter_map(|r| r.as_ref().err().map(|e| format!("{e:?}")))
            .collect();
        assert_eq!(failed, Vec::<String>::new());
        let mut answers: Vec<(String, i64)> = settled.into_iter().map(Result::unwrap).collect();
        answers.dedup();
        assert_eq!(answers.len(), 1, "{answers:?}");
        assert_eq!(
            k.count(&format!(
                "SELECT count(*) FROM bank.loan_collateral_events WHERE id = '{event}'"
            )),
            1
        );
    }
    let rounds = i128::try_from(ROUNDS).unwrap();
    assert_eq!(
        k.d(|d| service::collateral_of(d, &l)).unwrap(),
        before + amt("0.01") * rounds
    );
    let settled_locks = k.count(&format!(
        "SELECT count(*) FROM bank.loan_collateral_events WHERE loan_id = '{}' AND direction = 'lock' AND status = 'settled'",
        l.id
    ));
    assert!(settled_locks >= i64::try_from(ROUNDS).unwrap());
}

#[test]
fn different_top_ups_at_once_each_takes_its_own_sequence_and_every_one_locks() {
    let Some(mut k) = kit() else { return };
    let l = race_seed(&mut k).loan;
    let store = wide_store(&k);
    let before = k.d(|d| service::collateral_of(d, &l)).unwrap();
    for _ in 0..ROUNDS {
        let settled: Vec<Result<(String, i64), Refusal>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..WIDTH)
                .map(|_| {
                    sc.spawn(|| {
                        deps_on(&k, &store, &k.ledger, k.now, |d| {
                            service::add_collateral(d, &l.id, &uuid(), amt("0.01"))
                        })
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let failed: Vec<String> = settled
            .iter()
            .filter_map(|r| r.as_ref().err().map(|e| format!("{e:?}")))
            .collect();
        assert_eq!(failed, Vec::<String>::new());
        let mut seqs: Vec<i64> = settled.into_iter().map(|r| r.unwrap().1).collect();
        seqs.sort_unstable();
        seqs.dedup();
        assert_eq!(seqs.len(), WIDTH);
    }
    let all = i128::try_from(ROUNDS * WIDTH).unwrap();
    assert_eq!(
        k.d(|d| service::collateral_of(d, &l)).unwrap(),
        before + amt("0.01") * all
    );
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_collateral_events WHERE loan_id = '{}' AND status <> 'settled'",
            l.id
        )),
        0
    );
}

// ---------------------------------------------------------------------------------------------------------------
// add-collateral-retry-id.test.ts

// "LoanService.addCollateral — timed-out retry is one lock". Three BTC: one to open, one for the top-up, one left so
// a buggy retry could post a second lock instead of failing on funds.

#[test]
fn omit_event_id_refuses_bank_event_id_required_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "3", "1");
    let at_open = locks(&k);
    let e = add(&k, &o.loan.id, "", "1").err().unwrap();
    assert_eq!(code(&e), "bank.event_id_required");
    assert_eq!(locks(&k), at_open);
}

#[test]
fn timeout_after_lock_posts_retry_same_event_id_and_amount_one_extra_lock_not_two() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "3", "1");
    let at_open = locks(&k);
    let event = uuid();
    // The open's lock is sequence 0 and already booked: the next lock on this loan is the top-up.
    k.ledger.lose_reply(
        &format!("bank.loan.collateral.lock:{}:", o.loan.id),
        Loss::Unknown,
    );
    let e = add(&k, &o.loan.id, &event, "1").err().unwrap();
    assert!(
        loans_kit::message(&e).contains("receipt lost after ledger commit"),
        "{e:?}"
    );
    assert_eq!(locks(&k), at_open + 1);

    let (tx, seq) = add(&k, &o.loan.id, &event, "1").unwrap();
    assert!(seq > 0);
    assert!(!tx.is_empty());
    assert_eq!(locks(&k), at_open + 1);
    let events = k.rows(&format!(
        "SELECT id::text, sequence::text FROM bank.loan_collateral_events WHERE loan_id = '{}' AND direction = 'lock' ORDER BY sequence",
        o.loan.id
    ));
    assert_eq!(events.len(), 2);
    assert_eq!(
        events
            .iter()
            .filter(|e| e[1].as_deref().unwrap().parse::<i64>().unwrap() > 0)
            .count(),
        1
    );
    assert!(
        events
            .iter()
            .any(|e| e[0].as_deref() == Some(event.as_str()))
    );
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

/// "two overlapping addCollateral with the same eventId lock once (%s promise is held)": the first call to reach the
/// ledger is held there with its claim committed; the second claims, finds the row by id, and re-drives the same
/// idempotent post. The held post is released once either caller completes.
fn overlapping_same_event(held_first: bool) {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "3", "1");
    let at_open = locks(&k);
    let event = uuid();
    let store = wide_store(&k);
    let gate = Gate::new(&k.ledger, "loanCollateralLock", 1);
    let (arriving_first, arriving_second) = std::thread::scope(|sc| {
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let spawn = |done: mpsc::Sender<()>| {
            let (g, st, ev, id) = (&gate, &store, &event, &o.loan.id);
            let k = &k;
            sc.spawn(move || {
                let r = deps_on(k, st, g, k.now, |d| {
                    service::add_collateral(d, id, ev, amt("1"))
                });
                let _ = done.send(());
                r
            })
        };
        let a = spawn(done_tx.clone());
        gate.wait_reached();
        let b = spawn(done_tx);
        let raced = done_rx.recv_timeout(Duration::from_secs(20));
        gate.release();
        raced.expect("neither overlapping call finished while the first post was held");
        (a.join().unwrap(), b.join().unwrap())
    });
    let (first, second) = if held_first {
        (arriving_first, arriving_second)
    } else {
        (arriving_second, arriving_first)
    };
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first.1, second.1);
    assert_eq!(first.0, second.0);
    assert_eq!(locks(&k), at_open + 1);
    let events = k.rows(&format!(
        "SELECT id::text FROM bank.loan_collateral_events WHERE loan_id = '{}' AND sequence > 0",
        o.loan.id
    ));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0][0].as_deref(), Some(event.as_str()));
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

#[test]
fn two_overlapping_add_collateral_with_the_same_event_id_lock_once_first_promise_is_held() {
    overlapping_same_event(true);
}

#[test]
fn two_overlapping_add_collateral_with_the_same_event_id_lock_once_second_promise_is_held() {
    overlapping_same_event(false);
}

#[test]
fn same_event_id_with_a_different_amount_refuses_and_does_not_post_a_second_lock() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "3", "1");
    let event = uuid();
    let first = add(&k, &o.loan.id, &event, "1").unwrap();
    let after = locks(&k);
    let e = add(&k, &o.loan.id, &event, "0.5").err().unwrap();
    assert_eq!(code(&e), "bank.loan_collateral_mismatch");
    assert_eq!(locks(&k), after);
    let retry = add(&k, &o.loan.id, &event, "1").unwrap();
    assert_eq!(retry.0, first.0);
    assert_eq!(retry.1, first.1);
    assert_eq!(locks(&k), after);
}

// "HTTP /trpc/loans.addCollateral — retry with the same eventId is one lock"

#[test]
fn two_http_posts_with_the_same_event_id_and_amount_lock_once() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "1");
    let at_open = locks(&k);
    let event = uuid();
    let body = top_up_body(&o.loan.id, Some(&event), "1");
    let first = receipt(&borrower(&k, "loans.addCollateral", &body));
    let retry = receipt(&borrower(&k, "loans.addCollateral", &body));
    assert_eq!(retry.0, first.0);
    assert_eq!(retry.1, first.1);
    assert_eq!(locks(&k), at_open + 1);
    let events = k.rows(&format!(
        "SELECT id::text FROM bank.loan_collateral_events WHERE loan_id = '{}' AND sequence > 0",
        o.loan.id
    ));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0][0].as_deref(), Some(event.as_str()));
}

#[test]
fn add_collateral_http_without_event_id_is_400() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "1");
    let at_open = locks(&k);
    let a = borrower(
        &k,
        "loans.addCollateral",
        &top_up_body(&o.loan.id, None, "1"),
    );
    assert_eq!(a.0, 400, "{}", a.1.compact());
    assert_eq!(locks(&k), at_open);
}

// ---------------------------------------------------------------------------------------------------------------
// releasable.test.ts — "loans.releasable (BK-loan-05)". The marks are stamped on the wall clock
// (`fixedPriceSource(marks, () => new Date())`).

fn releasable_of(k: &Kit, user: &str, loan: &str) -> Answer {
    live(k);
    call(
        &k.door(),
        user,
        RW,
        "loans.releasable",
        &obj(&[("loanId", Json::str(loan))]),
    )
}

#[test]
fn answers_exactly_what_release_excess_allows_one_unit_more_is_refused_the_amount_itself_posts_then_nothing_is_left()
 {
    let Some(k) = kit() else { return };
    // TEST figures: 3 BTC at 10000, debt 5000, max LTV 50%, so 1 BTC must stay.
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    let r = releasable_of(&k, BORROWER, &o.loan.id).ok();
    let Json::Object(fields) = &r else {
        panic!("not an object: {}", r.compact())
    };
    assert_eq!(fields.len(), 5, "{}", r.compact());
    assert_eq!(s(&r, "loanId"), o.loan.id);
    assert_eq!(s(&r, "held"), "3");
    assert_eq!(s(&r, "releasable"), "2");
    assert_eq!(s(&r, "maxLtvBps"), "5000");
    assert_eq!(s(&r, "ltvBps"), "1667");

    let now = live(&k);
    let e = k
        .at(now, |d| {
            service::release_excess(d, &o.loan.id, &uuid(), amt("2.000000000000000001"))
        })
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.ltv_exceeded");
    let now = live(&k);
    k.at(now, |d| {
        service::release_excess(d, &o.loan.id, &uuid(), amt("2"))
    })
    .unwrap();
    let r = releasable_of(&k, BORROWER, &o.loan.id).ok();
    assert_eq!(s(&r, "held"), "1");
    assert_eq!(s(&r, "releasable"), "0");
    assert_eq!(s(&r, "ltvBps"), "5000");
}

#[test]
fn is_zero_not_negative_when_the_loan_is_already_above_the_cap() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    k.prices.btc("2000");
    let r = releasable_of(&k, BORROWER, &o.loan.id).ok();
    assert_eq!(s(&r, "releasable"), "0");
    assert_eq!(s(&r, "ltvBps"), "8334");
}

#[test]
fn refuses_with_no_usable_mark_for_another_user_and_for_an_unknown_loan() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    k.prices.clear();
    let blind = releasable_of(&k, BORROWER, &o.loan.id);
    assert_ne!(blind.0, 200);
    assert!(
        blind.message().contains("No usable mark"),
        "{}",
        blind.1.compact()
    );
    k.prices.btc("10000");
    let stranger = releasable_of(&k, PAYER, &o.loan.id);
    assert_eq!(stranger.trpc(), "FORBIDDEN", "{}", stranger.1.compact());
    let unknown = releasable_of(&k, BORROWER, &uuid());
    assert_ne!(unknown.0, 200);
    assert_eq!(releases(&k), 0);
}

#[test]
fn releasable_refuses_on_a_pending_loan() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    k.sql(&format!(
        "UPDATE bank.loans SET status = 'pending' WHERE id = '{}'",
        o.loan.id
    ));
    let now = live(&k);
    let e = k
        .at(now, |d| service::releasable(d, &o.loan.id))
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.loan_not_drawable");
}

// ---------------------------------------------------------------------------------------------------------------
// release-excess-once.test.ts

// "LoanService.releaseExcess — one release, cap held across callers"

#[test]
fn timeout_after_the_release_posts_retry_same_event_id_and_amount_one_loan_collateral_release() {
    let Some(k) = kit() else { return };
    // 3 BTC at 10000, debt 5000, max LTV 50%: up to 2 BTC may leave. A second 0.5 still fits the cap, so a fresh
    // sequence would post again.
    let o = seed_open(&k, k.now, "3", "3");
    let event = uuid();
    k.ledger
        .lose_reply("bank.loan.collateral.release:", Loss::Unknown);
    let e = release(&k, &o.loan.id, &event, "0.5").err().unwrap();
    assert!(
        loans_kit::message(&e).contains("receipt lost after ledger commit"),
        "{e:?}"
    );
    assert_eq!(releases(&k), 1);

    let (tx, seq) = release(&k, &o.loan.id, &event, "0.5").unwrap();
    assert!(!tx.is_empty());
    assert!(seq > 0);
    assert_eq!(releases(&k), 1);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0.5");
}

#[test]
fn two_overlapping_releases_of_the_capped_headroom_do_not_both_pass() {
    let Some(k) = kit() else { return };
    // 2 BTC, debt 5000 at 10000, max LTV 50%. Releasing 1 leaves LTV at the cap. A second 1 leaves nothing pledged.
    // Each call alone is allowed.
    let o = seed_open(&k, k.now, "2", "2");
    let store = wide_store(&k);
    let gate = Gate::new(&k.ledger, "loanCollateralRelease", 0);
    let results: Vec<Result<(String, i64), Refusal>> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..2)
            .map(|_| {
                let (g, st, id, k) = (&gate, &store, &o.loan.id, &k);
                sc.spawn(move || {
                    let r = deps_on(k, st, g, k.now, |d| {
                        service::release_excess(d, id, &uuid(), amt("1"))
                    });
                    // Releasing before the park starts is safe: the cap decision has already committed with the
                    // ledger unmoved.
                    g.release();
                    r
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let fulfilled = results.iter().filter(|r| r.is_ok()).count();
    let rejected: Vec<&Refusal> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    assert_eq!(fulfilled, 1, "{results:?}");
    assert_eq!(rejected.len(), 1);
    assert_eq!(code(rejected[0]), "bank.ltv_exceeded");
    assert_eq!(releases(&k), 1);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

// "HTTP /trpc/loans.releaseExcess — same event is one release"

#[test]
fn two_http_posts_with_the_same_event_id_and_amount_release_once() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    let body = top_up_body(&o.loan.id, Some(&uuid()), "0.5");
    let first = borrower(&k, "loans.releaseExcess", &body);
    assert_eq!(first.0, 200, "{}", first.1.compact());
    let retry = borrower(&k, "loans.releaseExcess", &body);
    assert_eq!(retry.0, 200, "{}", retry.1.compact());
    assert_eq!(releases(&k), 1);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0.5");
}

#[test]
fn release_excess_http_without_event_id_is_400_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "3", "3");
    let a = borrower(
        &k,
        "loans.releaseExcess",
        &top_up_body(&o.loan.id, None, "0.5"),
    );
    assert_eq!(a.0, 400, "{}", a.1.compact());
    assert_eq!(releases(&k), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// release-excess-public-door.test.ts

// "LoanService.releaseExcess refuses missing loan or mark before any post"

#[test]
fn release_excess_bank_loan_not_found_no_loan_collateral_released() {
    let Some(k) = kit() else { return };
    let e = release(&k, MISSING, &uuid(), "1").err().unwrap();
    assert_eq!(code(&e), "bank.loan_not_found");
    assert_eq!(releases(&k), 0);
}

#[test]
fn release_excess_bank_mark_missing_no_release() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "2", "2");
    k.prices.clear();
    let e = release(&k, &o.loan.id, &uuid(), "1").err().unwrap();
    assert_eq!(code(&e), "bank.mark_missing");
    assert_eq!(releases(&k), 0);
}

// "HTTP /trpc/loans.releaseExcess — peel through ledger-client"

#[test]
fn release_excess_refuses_bank_loan_not_found_on_the_public_door_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let a = borrower(
        &k,
        "loans.releaseExcess",
        &top_up_body(MISSING, Some(&uuid()), "1"),
    );
    assert_eq!(a.0, 404, "{}", a.1.compact());
    assert_eq!(a.trpc(), "NOT_FOUND");
    assert_eq!(a.cause(), "bank.loan_not_found");
    assert_eq!(releases(&k), 0);
}

#[test]
fn release_excess_refuses_bank_mark_missing_on_the_public_door_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let o = seed_open(&k, k.now, "2", "2");
    k.prices.clear();
    let a = borrower(
        &k,
        "loans.releaseExcess",
        &top_up_body(&o.loan.id, Some(&uuid()), "1"),
    );
    assert_eq!(a.0, 412, "{}", a.1.compact());
    assert_eq!(a.trpc(), "PRECONDITION_FAILED");
    assert_eq!(a.cause(), "bank.mark_missing");
    assert!(
        a.1.get("error")
            .unwrap()
            .compact()
            .contains("bank.mark_missing")
    );
    assert_eq!(releases(&k), 0);
}

#[test]
fn release_excess_with_a_mark_posts_loan_collateral_released_no_invented_rate() {
    let Some(k) = kit() else { return };
    let now = live(&k);
    let o = seed_open(&k, now, "2", "2");
    let a = borrower(
        &k,
        "loans.releaseExcess",
        &top_up_body(&o.loan.id, Some(&uuid()), "1"),
    );
    let (tx, seq) = receipt(&a);
    assert!(!tx.is_empty());
    assert!(seq >= 0);
    assert!(releases(&k) > 0);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

// ---------------------------------------------------------------------------------------------------------------
// seize-public-door.test.ts. The market maker holds 100000 USDT to buy with; the venue is `marketMakerVenue()`.

fn seize_seed(k: &Kit, now: Instant) -> service::Opened {
    k.ledger.seed_market_maker("USDT", "100000");
    seed_open(k, now, "1", "1")
}

/// The operator door: `ops.seizeLoan` as an `admin:treasury` caller, the risk sweep on.
fn seize_door(k: &Kit, loan: &str) -> Answer {
    live(k);
    call(
        &k.door(),
        BORROWER,
        OPS,
        "ops.seizeLoan",
        &seize_body(k, loan),
    )
}

// "LoanService.seize refuses a missing mark before any post"

#[test]
fn seize_bank_mark_missing_no_loan_liquidated() {
    let Some(k) = kit() else { return };
    let o = seize_seed(&k, k.now);
    k.prices.clear();
    let e = k.d(|d| sweep::seize(d, &o.loan.id, k.now)).err().unwrap();
    assert_eq!(code(&e), "bank.mark_missing");
    assert_eq!(liquidations(&k), 0);
    assert_eq!(liquidation_rows(&k, &o.loan.id), 0);
}

#[test]
fn refuses_seizure_when_the_quote_asset_differs_from_the_debt_asset_and_posts_nothing() {
    let Some(k) = kit() else { return };
    let mid = Some(MarkQuality::Mid);
    k.prices.set(&[("BTC", "10000", mid), ("USDT", "1", mid)]);
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.ledger.seed_market_maker("USDT", "100000");
    let p = k.product_with(|p| {
        p.name = "BTC marked in USD, borrowed in USDT".to_owned();
        p.quote_asset_id = "USD".to_owned();
    });
    let o = k.open(&p.id, "1", "5000").unwrap();
    k.prices.set(&[("BTC", "5200", mid), ("USDT", "1", mid)]);
    let posts_before = k.ledger.journal().len();
    let e = k.d(|d| sweep::seize(d, &o.loan.id, k.now)).err().unwrap();
    assert_eq!(code(&e), "bank.loan_seizure_cross_asset");
    assert_eq!(k.ledger.journal().len(), posts_before);
    assert_eq!(liquidations(&k), 0);
    assert_eq!(liquidation_rows(&k, &o.loan.id), 0);
}

// "HTTP /trpc/ops.seizeLoan — seize through ledger-client"

#[test]
fn refuses_bank_mark_missing_on_the_operator_door_and_posts_nothing() {
    let Some(mut k) = kit() else { return };
    k.settings.risk_sweep_enabled = true;
    let o = seize_seed(&k, k.now);
    k.prices.clear();
    // The router's caller and the HTTP post are one door here; each carries its own approval.
    for _ in 0..2 {
        let a = seize_door(&k, &o.loan.id);
        assert_eq!(a.0, 412, "{}", a.1.compact());
        assert_eq!(a.trpc(), "PRECONDITION_FAILED");
        assert_eq!(a.cause(), "bank.mark_missing");
        assert!(
            a.1.get("error")
                .unwrap()
                .compact()
                .contains("bank.mark_missing")
        );
    }
    assert_eq!(liquidations(&k), 0);
}

#[test]
fn with_an_insolvency_mark_posts_loan_liquidated_no_invented_rate() {
    let Some(mut k) = kit() else { return };
    k.settings.risk_sweep_enabled = true;
    let now = live(&k);
    let o = seize_seed(&k, now);
    k.prices.btc("5200");
    let data = seize_door(&k, &o.loan.id).ok();
    assert!(!s(&data, "ledgerTxId").is_empty());
    for f in ["collateralSold", "proceeds", "principalRepaid"] {
        assert!(decimal(&s(&data, f)), "{f}: {}", data.compact());
    }
    assert!(amt(&s(&data, "collateralSold")) > Amount::ZERO);
    let journal = k.ledger.journal();
    let draw_at = journal.iter().position(|b| b.recipe == "loanDraw").unwrap();
    let liq_at = journal
        .iter()
        .position(|b| b.recipe == "loanLiquidate")
        .unwrap();
    assert!(liq_at > draw_at);
}

// ---------------------------------------------------------------------------------------------------------------
// originate-public-door.test.ts

/// `seedProduct`: the reserve, 1 BTC on the borrower, the default product.
fn seed_product(k: &Kit) -> Product {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.product()
}

fn no_loan_no_post(k: &Kit) {
    assert_eq!(k.count("SELECT count(*) FROM bank.loans"), 0);
    assert_eq!(locks(k), 0);
    assert_eq!(k.ledger.posts("loanDraw").len(), 0);
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "1");
}

// "LoanService.open refuses a missing mark before any post"

#[test]
fn open_bank_mark_missing_no_loan_row_no_lock_no_draw() {
    let Some(k) = kit() else { return };
    let p = seed_product(&k);
    k.prices.clear();
    let e = k.open(&p.id, "1", "5000").err().unwrap();
    assert_eq!(code(&e), "bank.mark_missing");
    no_loan_no_post(&k);
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "0");
}

// "HTTP /trpc/loans.open — originate through ledger-client"

fn open_body(product: &str, loan: &str) -> Json {
    obj(&[
        ("loanId", Json::str(loan)),
        ("productId", Json::str(product)),
        ("collateralAmount", Json::str("1")),
        ("principal", Json::str("5000")),
    ])
}

#[test]
fn open_refuses_bank_mark_missing_on_the_public_door_and_posts_nothing() {
    let Some(mut k) = kit() else { return };
    // `createBankServices(sql, ledger, history)` with no loan options: no marks and no published origination fee.
    k.settings.origination_fee_bps = None;
    k.prices.clear();
    let p = seed_product(&k);
    let a = borrower(&k, "loans.open", &open_body(&p.id, &uuid()));
    assert_eq!(a.0, 412, "{}", a.1.compact());
    assert_eq!(a.trpc(), "PRECONDITION_FAILED");
    assert!(
        a.1.get("error")
            .unwrap()
            .compact()
            .contains("bank.mark_missing")
    );
    no_loan_no_post(&k);
}

#[test]
fn open_with_a_mark_posts_lock_then_draw_no_invented_rate() {
    let Some(k) = kit() else { return };
    let p = seed_product(&k);
    let loan = uuid();
    let data = borrower(&k, "loans.open", &open_body(&p.id, &loan)).ok();
    assert_eq!(s(&data, "loanId"), loan);
    assert_eq!(s(&data, "status"), "active");
    assert!(!s(&data, "drawLedgerTxId").is_empty());
    let journal = k.ledger.journal();
    let lock_at = journal
        .iter()
        .position(|b| b.recipe == "loanCollateralLock")
        .unwrap();
    let draw_at = journal.iter().position(|b| b.recipe == "loanDraw").unwrap();
    assert!(draw_at > lock_at);
    assert_eq!(k.ledger.available(BORROWER, "USDT"), "5000");
    assert_eq!(k.ledger.available(BORROWER, "BTC"), "0");
}
