//! The business slice's held transfers and payroll against the Rust slice on a real Postgres. Ports the tests of the
//! TypeScript's `services/svc-bank/src/business/business.test.ts` from "held funds cannot be double-spent while pending"
//! to the end of the file (describe "maker/checker dual control with ledger holds"), each test named after the
//! TypeScript test's words. Where the TypeScript calls `bank.business.<fn>` (or `bank.transfers.transfer`) directly,
//! this calls the Rust function it became with the door's own dependencies (`Bank::deps`).
//!
//! Each test has its own database (the TypeScript's `beforeEach` truncates one), its own ledger stand-in
//! (`business_kit::Book`, the TypeScript's `MemoryLedger`) and its own bank. Where the TypeScript wraps
//! `ledger.post` (counting payroll posts, or recording the run row while the post is in flight), a hook on the book does
//! the same: it is called before each post is booked (counted there, as the TypeScript counts before it awaits the inner
//! post) and after (where the raced run row is written). `ledgerThatHidesEntries` is `Book::hide_entries`. A post the
//! TypeScript makes straight on the ledger (`recipes.businessPayroll`) is a `post_recipe` on the book with the body the
//! slice itself sends. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - `rejects.toThrow(/run insert rolled back/)`: the Rust refusal is a value, not a thrown `Error`; the trigger's
//!   sentence is looked for in the refusal as debug-printed.
//! - "records a payroll when the ledger client returns no entries" builds a second bank over the same tables with the
//!   hiding client; here the test's one bank hides its entries from the start (the TypeScript's first bank is not used
//!   in that test), and the deposit and `book` posts go to the same book (`inner` in the TypeScript).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use postgres::{Client, NoTls};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use svc_bank::business::service::{
    self as biz, NewAccount, Payroll, PayrollRun, Propose, Proposed,
};
use svc_bank::errors::Refusal;
use svc_bank::spaces::ports::{Ledger, LedgerTx};
use svc_bank::transfers::moves::{self, MoveAsk};

use crate::business_kit::{Bank, Hook, amt, bank, uuid};

const MAKER: &str = "11111111-1111-4111-8111-111111111111";
const CHECKER: &str = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------------------------------------------
// Helpers

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        other => format!("not a BankError: {other:?}"),
    }
}

fn refused<T: std::fmt::Debug>(r: Result<T, Refusal>, want: &str) -> Refusal {
    match r {
        Ok(v) => panic!("expected {want}, got {v:?}"),
        Err(e) => {
            assert_eq!(code(&e), want, "{e:?}");
            e
        }
    }
}

/// `bank.business.createAccount` named "Ops Co" in USDT, created by MAKER: the account's id.
fn account_named(b: &Bank, name: &str, threshold: &str) -> String {
    let id = uuid();
    b.deps(|d| {
        biz::create_account(
            d,
            &NewAccount {
                account_id: &id,
                name,
                asset_id: "USDT",
                spend_threshold: amt(threshold),
                creator_user_id: MAKER,
            },
        )
    })
    .unwrap()
    .id
}

fn account(b: &Bank, threshold: &str) -> String {
    account_named(b, "Ops Co", threshold)
}

fn add_member(b: &Bank, account_id: &str, user: &str, role: &str) {
    b.deps(|d| biz::add_member(d, account_id, MAKER, user, role))
        .unwrap();
}

fn propose(b: &Bank, account_id: &str, from: &str, to: &str, amount: &str) -> Proposed {
    let client = uuid();
    b.deps(|d| {
        biz::propose_transfer(
            d,
            &Propose {
                account_id,
                maker_user_id: MAKER,
                from_space_id: from,
                to_space_id: to,
                amount: amt(amount),
                client_id: &client,
            },
        )
    })
    .unwrap()
}

/// `if (proposed.kind !== 'pending') throw`: the approval's id.
fn pending_id(p: &Proposed) -> String {
    match p {
        Proposed::Pending(a) => a.id.clone(),
        other => panic!("expected pending, got {other:?}"),
    }
}

fn lines(recipients: &[(&str, &str)]) -> Vec<(String, Amount)> {
    recipients
        .iter()
        .map(|(to, a)| ((*to).to_owned(), amt(a)))
        .collect()
}

fn run_payroll(
    b: &Bank,
    payroll_id: &str,
    account_id: &str,
    actor: &str,
    from: &str,
    recipients: &[(&str, &str)],
) -> Result<PayrollRun, Refusal> {
    b.deps(|d| {
        biz::run_payroll(
            d,
            &Payroll {
                payroll_id,
                account_id,
                actor_user_id: actor,
                from_space_id: from,
                recipients: lines(recipients),
            },
        )
    })
}

/// `expect(run.recipients).toHaveLength(2)` and `toEqual(arrayContaining([...]))`.
fn has_exactly(run: &PayrollRun, want: &[(&str, &str)]) {
    assert_eq!(run.recipients.len(), want.len(), "{:?}", run.recipients);
    for (to, a) in want {
        assert!(
            run.recipients.contains(&((*to).to_owned(), amt(a))),
            "{to} {a} not in {:?}",
            run.recipients
        );
    }
}

/// `ledger.post(recipes.businessPayroll({ payrollId, from: accountForSpace(from), recipients }))`, with the body the
/// slice sends.
fn book_payroll(b: &Bank, payroll_id: &str, from: &str, recipients: &[(&str, &str)]) -> LedgerTx {
    let input = Json::obj([
        ("payrollId", Json::str(payroll_id)),
        ("from", b.account(from).json()),
        (
            "recipients",
            Json::Array(
                recipients
                    .iter()
                    .map(|(to, a)| {
                        Json::obj([
                            ("to", b.account(to).json()),
                            ("amount", Json::str(format_amount(amt(a)))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    b.ledger
        .post_recipe("businessPayroll", &input, &biz::payroll_key(payroll_id))
        .unwrap()
}

fn insert_run(c: &mut Client, payroll_id: &str, account_id: &str, from: &str, tx: &str) {
    c.execute(
        "INSERT INTO bank.business_payroll_runs (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id) \
         VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid, 'USDT', $5)",
        &[&payroll_id, &account_id, &MAKER, &from, &tx],
    )
    .unwrap();
}

/// `seedRun`: a run row and the lines given.
fn seed_run(
    b: &Bank,
    payroll_id: &str,
    account_id: &str,
    from: &str,
    tx: &str,
    recipients: &[(&str, &str)],
) {
    let mut c = b.sql();
    insert_run(&mut c, payroll_id, account_id, from, tx);
    for (to, a) in recipients {
        c.execute(
            "INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric)",
            &[&payroll_id, to, &format_amount(amt(a))],
        )
        .unwrap();
    }
}

/// The stored lines' spaces, by space id.
fn stored_lines(b: &Bank, payroll_id: &str) -> Vec<String> {
    b.sql()
        .query(
            "SELECT to_space_id::text FROM bank.business_payroll_lines WHERE payroll_id = $1::text::uuid ORDER BY to_space_id",
            &[&payroll_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

/// `ledger.journal().filter((tx) => tx.idempotencyKey === key).length`.
fn movements(b: &Bank, key: &str) -> usize {
    b.ledger.keys().iter().filter(|k| *k == key).count()
}

fn booked_id(b: &Bank, key: &str) -> String {
    b.ledger
        .st
        .lock()
        .unwrap()
        .journal
        .iter()
        .find(|j| j.0 == key)
        .map(|j| j.3.id.clone())
        .unwrap()
}

/// A hook that counts payroll posts and, the first time `raced` is booked, writes its run row (no lines) before the
/// slice records it, as the TypeScript's wrapped `ledger.post` does. The raced transaction's id lands in the second
/// value.
fn racing_hook(
    b: &Bank,
    raced: &str,
    account_id: &str,
    from: &str,
) -> (Hook, Arc<AtomicU32>, Arc<Mutex<String>>) {
    let calls = Arc::new(AtomicU32::new(0));
    let raced_tx = Arc::new(Mutex::new(String::new()));
    let (c2, r2) = (calls.clone(), raced_tx.clone());
    let book = b.ledger.clone();
    let url = b.db.url.clone();
    let raced = raced.to_owned();
    let raced_key = biz::payroll_key(&raced);
    let account_id = account_id.to_owned();
    let from = from.to_owned();
    let hook: Hook = Arc::new(move |_, _, key: &str, booked| {
        if !booked {
            if key.starts_with("bank.business.payroll:") {
                c2.fetch_add(1, Ordering::SeqCst);
            }
            return Ok(());
        }
        if key == raced_key && r2.lock().unwrap().is_empty() {
            let id = book
                .st
                .lock()
                .unwrap()
                .journal
                .iter()
                .find(|j| j.0 == key)
                .map(|j| j.3.id.clone())
                .unwrap();
            r2.lock().unwrap().clone_from(&id);
            let mut c = Client::connect(&url, NoTls).unwrap();
            insert_run(&mut c, &raced, &account_id, &from, &id);
        }
        Ok(())
    });
    (hook, calls, raced_tx)
}

// ---------------------------------------------------------------------------------------------------------------
// Holds

#[test]
fn held_funds_cannot_be_double_spent_while_pending() {
    let Some(b) = bank() else { return };
    let account = account(&b, "50");
    add_member(&b, &account, CHECKER, "checker");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "A");
    let other = b.pot(MAKER, "USDT", "B");
    b.ledger.fund_user(MAKER, "USDT", "100");

    let proposed = propose(&b, &account, &primary, &pot, "100");
    let approval = pending_id(&proposed);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "0");

    let drain = b.deps(|d| {
        moves::transfer(
            d,
            &MoveAsk {
                transfer_id: "drain-attempt",
                from_space_id: &primary,
                to_space_id: &other,
                amount: amt("1"),
                note: None,
                reference: None,
                key_space: "own",
            },
        )
    });
    assert!(drain.is_err(), "{drain:?}");

    b.deps(|d| biz::approve(d, &approval, CHECKER)).unwrap();
    assert_eq!(b.balance(&pot), "100");
    assert!(b.ledger.reconciles());
}

#[test]
fn reject_releases_the_hold_back_to_available() {
    let Some(b) = bank() else { return };
    let account = account(&b, "10");
    add_member(&b, &account, CHECKER, "checker");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "X");
    b.ledger.fund_user(MAKER, "USDT", "100");

    let proposed = propose(&b, &account, &primary, &pot, "50");
    let approval = pending_id(&proposed);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "50");

    b.deps(|d| biz::reject(d, &approval, CHECKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "100");
    assert_eq!(b.balance(&pot), "0");
    assert!(b.ledger.reconciles());
}

#[test]
fn maker_cancel_releases_the_hold() {
    let Some(b) = bank() else { return };
    let account = account(&b, "10");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Y");
    b.ledger.fund_user(MAKER, "USDT", "80");

    let proposed = propose(&b, &account, &primary, &pot, "40");
    let approval = pending_id(&proposed);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "40");

    b.deps(|d| biz::cancel(d, &approval, MAKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "80");
    assert!(b.ledger.reconciles());
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll

#[test]
fn pays_every_payroll_recipient_in_one_post_or_none_when_short() {
    let Some(b) = bank() else { return };
    let account = account(&b, "100");
    let primary = b.primary(MAKER, "USDT");
    let alice = b.primary(CHECKER, "USDT");
    let bob = b.pot(MAKER, "USDT", "Contractor");
    b.ledger.fund_user(MAKER, "USDT", "100");
    let payroll_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let recipients = [(alice.as_str(), "40"), (bob.as_str(), "25")];

    let run = run_payroll(&b, payroll_id, &account, MAKER, &primary, &recipients).unwrap();
    assert!(!run.ledger_tx_id.is_empty());
    assert_eq!(b.ledger.available(MAKER, "USDT"), "35");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");
    assert!(b.ledger.reconciles());

    let again = run_payroll(&b, payroll_id, &account, MAKER, &primary, &recipients).unwrap();
    assert_eq!(again.ledger_tx_id, run.ledger_tx_id);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "35");

    let short = run_payroll(
        &b,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        &account,
        MAKER,
        &primary,
        &[(alice.as_str(), "30"), (bob.as_str(), "10")],
    );
    assert!(short.is_err(), "{short:?}");
    assert_eq!(b.ledger.available(MAKER, "USDT"), "35");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");
    assert!(b.ledger.reconciles());
}

#[test]
fn two_runs_of_one_payroll_at_once_record_it_once_and_both_get_the_row_that_won_8892() {
    let Some(b) = bank() else { return };
    let account = account(&b, "1000");
    let primary = b.primary(MAKER, "USDT");
    let alice = b.primary(CHECKER, "USDT");
    let bob = b.pot(MAKER, "USDT", "Contractor");
    b.ledger.fund_user(MAKER, "USDT", "1000");

    // Each round races 8 copies of one payroll. Before the fix the losers' insert raised 23505 on
    // business_payroll_runs_ledger_tx_id_key instead of absorbing.
    for _round in 0..10 {
        let payroll_id = uuid();
        let recipients = [(alice.as_str(), "4"), (bob.as_str(), "1")];
        let runs: Vec<PayrollRun> = std::thread::scope(|s| {
            let racers: Vec<_> = (0..8)
                .map(|_| {
                    s.spawn(|| run_payroll(&b, &payroll_id, &account, MAKER, &primary, &recipients))
                })
                .collect();
            racers
                .into_iter()
                .map(|r| r.join().unwrap().unwrap())
                .collect()
        });
        let tx_ids: BTreeSet<&str> = runs.iter().map(|r| r.ledger_tx_id.as_str()).collect();
        assert_eq!(tx_ids.len(), 1, "{tx_ids:?}");
        assert!(
            runs.iter()
                .all(|r| r.payroll_id == payroll_id && r.recipients.len() == 2),
            "{runs:?}"
        );
        let stored: String = b
            .sql()
            .query_one(
                "SELECT count(*)::text AS n FROM bank.business_payroll_lines WHERE payroll_id = $1::text::uuid",
                &[&payroll_id],
            )
            .unwrap()
            .get(0);
        assert_eq!(stored, "2");
    }
    // Paid once per payroll: 10 rounds of 5.
    assert_eq!(b.ledger.available(MAKER, "USDT"), "950");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "10");
    assert!(b.ledger.reconciles());
}

#[test]
fn a_matching_payroll_retry_completes_lines_that_are_not_all_visible_yet() {
    let Some(b) = bank() else { return };
    let account = account(&b, "100");
    let other_account = account_named(&b, "Other Co", "100");
    let primary = b.primary(MAKER, "USDT");
    let other_source = b.pot(MAKER, "USDT", "Reserve");
    let alice = b.primary(CHECKER, "USDT");
    let bob = b.pot(MAKER, "USDT", "Contractor");
    let carol = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "1000");

    let same = [(alice.as_str(), "40"), (bob.as_str(), "25")];
    let run = |id: &str, recipients: &[(&str, &str)]| {
        run_payroll(&b, id, &account, MAKER, &primary, recipients)
    };

    let raced_id = "a1590001-0000-4000-8000-000000000001";
    let (hook, calls, raced_tx) = racing_hook(&b, raced_id, &account, &primary);
    b.ledger.set_hook(Some(hook));
    let payroll_post_calls = || calls.load(Ordering::SeqCst);

    let raced = run(raced_id, &same).unwrap();
    let raced_tx = raced_tx.lock().unwrap().clone();
    assert_eq!(raced.ledger_tx_id, raced_tx);
    assert_eq!(payroll_post_calls(), 1);
    has_exactly(&raced, &same);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "935");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");

    let raced_again = run(raced_id, &same).unwrap();
    assert_eq!(raced_again.ledger_tx_id, raced_tx);
    assert_eq!(payroll_post_calls(), 2);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "935");

    let partial_id = "a1590002-0000-4000-8000-000000000002";
    let partial_posted = book_payroll(&b, partial_id, &primary, &same);
    seed_run(
        &b,
        partial_id,
        &account,
        &primary,
        &partial_posted.id,
        &[(alice.as_str(), "40")],
    );
    let calls_after_partial_seed = payroll_post_calls();
    let partial = run(partial_id, &same).unwrap();
    assert_eq!(partial.ledger_tx_id, partial_posted.id);
    assert_eq!(payroll_post_calls(), calls_after_partial_seed + 1);
    has_exactly(&partial, &same);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "870");

    let bare_id = "a1590003-0000-4000-8000-000000000003";
    let bare_posted = book_payroll(&b, bare_id, &primary, &same);
    seed_run(&b, bare_id, &account, &primary, &bare_posted.id, &[]);
    let calls_after_bare_seed = payroll_post_calls();
    let bare = run(bare_id, &same).unwrap();
    assert_eq!(bare.ledger_tx_id, bare_posted.id);
    assert_eq!(payroll_post_calls(), calls_after_bare_seed + 1);
    assert_eq!(bare.recipients.len(), 2);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "805");

    let divergent_id = "a1590004-0000-4000-8000-000000000004";
    let divergent_posted = book_payroll(&b, divergent_id, &primary, &same);
    seed_run(
        &b,
        divergent_id,
        &account,
        &primary,
        &divergent_posted.id,
        &[],
    );
    let calls_after_divergent_seed = payroll_post_calls();
    refused(
        run(
            divergent_id,
            &[(alice.as_str(), "40"), (carol.as_str(), "25")],
        ),
        "bank.business_request_conflict",
    );
    assert_eq!(payroll_post_calls(), calls_after_divergent_seed + 1);
    assert_eq!(b.balance(&carol), "0");
    assert_eq!(stored_lines(&b, divergent_id), Vec::<String>::new());

    let mismatch_id = "a1590005-0000-4000-8000-000000000005";
    seed_run(
        &b,
        mismatch_id,
        &account,
        &primary,
        "orig-partial-mismatch",
        &[(alice.as_str(), "10")],
    );
    let calls_after_mismatch = payroll_post_calls();
    refused(run(mismatch_id, &same), "bank.business_request_conflict");
    assert_eq!(payroll_post_calls(), calls_after_mismatch);
    assert_eq!(stored_lines(&b, mismatch_id), vec![alice.clone()]);

    let calls_before_conflicts = payroll_post_calls();
    refused(
        run(raced_id, &[(alice.as_str(), "40"), (bob.as_str(), "30")]),
        "bank.business_request_conflict",
    );
    refused(
        run(raced_id, &[(alice.as_str(), "40"), (carol.as_str(), "25")]),
        "bank.business_request_conflict",
    );
    refused(
        run_payroll(&b, raced_id, &account, MAKER, &other_source, &same),
        "bank.business_request_conflict",
    );
    refused(
        run_payroll(&b, raced_id, &other_account, MAKER, &primary, &same),
        "bank.business_request_conflict",
    );
    assert_eq!(payroll_post_calls(), calls_before_conflicts);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "740");
    assert_eq!(b.balance(&alice), "160");
    assert_eq!(b.balance(&bob), "100");
    assert_eq!(b.balance(&carol), "0");
    assert_eq!(b.balance(&other_source), "0");

    b.sql()
        .batch_execute(
            "CREATE OR REPLACE FUNCTION bank.business_payroll_run_lines_present()
             RETURNS trigger
             LANGUAGE plpgsql
             AS $$
             BEGIN
               IF NOT EXISTS (
                 SELECT 1 FROM bank.business_payroll_lines WHERE payroll_id = NEW.id
               ) THEN
                 RAISE EXCEPTION 'payroll run % committed with zero lines', NEW.id;
               END IF;
               RETURN NEW;
             END;
             $$;
             CREATE CONSTRAINT TRIGGER business_payroll_run_lines_present
             AFTER INSERT ON bank.business_payroll_runs
             DEFERRABLE INITIALLY DEFERRED
             FOR EACH ROW
             EXECUTE FUNCTION bank.business_payroll_run_lines_present();",
        )
        .unwrap();
    let fresh_id = "a1590006-0000-4000-8000-000000000006";
    let calls_before_fresh = payroll_post_calls();
    let fresh = run(fresh_id, &same).unwrap();
    assert_eq!(payroll_post_calls(), calls_before_fresh + 1);
    assert!(!fresh.ledger_tx_id.is_empty());
    has_exactly(&fresh, &same);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "675");
    let again = run(fresh_id, &same).unwrap();
    assert_eq!(again.ledger_tx_id, fresh.ledger_tx_id);
    assert_eq!(payroll_post_calls(), calls_before_fresh + 2);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "675");
    assert!(b.ledger.reconciles());
    b.ledger.set_hook(None);
}

#[test]
fn records_a_payroll_when_the_ledger_client_returns_no_entries() {
    let Some(b) = bank() else { return };
    b.ledger.hide_entries();
    let account = account(&b, "100");
    let primary = b.primary(MAKER, "USDT");
    let alice = b.primary(CHECKER, "USDT");
    let bob = b.pot(MAKER, "USDT", "Contractor");
    b.ledger.fund_user(MAKER, "USDT", "1000");
    let available = || b.ledger.available(MAKER, "USDT");
    let moved = |id: &str| movements(&b, &biz::payroll_key(id));
    let same = [(alice.as_str(), "40"), (bob.as_str(), "25")];
    let run = |id: &str, recipients: &[(&str, &str)]| {
        run_payroll(&b, id, &account, MAKER, &primary, recipients)
    };
    let book = |id: &str| {
        booked_id(&b, &{
            book_payroll(&b, id, &primary, &same);
            biz::payroll_key(id)
        })
    };

    let pay_id = "a1590011-0000-4000-8000-000000000011";
    let paid = run(pay_id, &same).unwrap();
    assert!(!paid.ledger_tx_id.is_empty());
    has_exactly(&paid, &same);
    assert_eq!(available(), "935");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");
    assert_eq!(moved(pay_id), 1);

    let again = run(pay_id, &same).unwrap();
    assert_eq!(again.ledger_tx_id, paid.ledger_tx_id);
    assert_eq!(moved(pay_id), 1);
    assert_eq!(available(), "935");

    let partial_id = "a1590012-0000-4000-8000-000000000012";
    let partial_posted = book(partial_id);
    seed_run(
        &b,
        partial_id,
        &account,
        &primary,
        &partial_posted,
        &[(alice.as_str(), "40")],
    );
    let partial = run(partial_id, &same).unwrap();
    assert_eq!(partial.ledger_tx_id, partial_posted);
    has_exactly(&partial, &same);
    assert_eq!(moved(partial_id), 1);
    assert_eq!(available(), "870");

    let short_id = "a1590013-0000-4000-8000-000000000013";
    let short_posted = book(short_id);
    seed_run(
        &b,
        short_id,
        &account,
        &primary,
        &short_posted,
        &[(alice.as_str(), "40")],
    );
    // The booked payment pays alice AND bob; this retry names only alice. The ledger refuses a reused key with a
    // different body, so a client that hides entries can no longer paper over it.
    refused(
        run(short_id, &[(alice.as_str(), "40")]),
        "bank.business_request_conflict",
    );
    assert_eq!(moved(short_id), 1);
    assert_eq!(stored_lines(&b, short_id), vec![alice.clone()]);

    let race_id = "a1590014-0000-4000-8000-000000000014";
    let (hook, _calls, raced_tx) = racing_hook(&b, race_id, &account, &primary);
    b.ledger.set_hook(Some(hook));
    let raced = run(race_id, &same).unwrap();
    assert_eq!(raced.ledger_tx_id, *raced_tx.lock().unwrap());
    assert_eq!(raced.recipients.len(), 2);
    assert_eq!(moved(race_id), 1);
    b.ledger.set_hook(None);

    let replay_id = "a1590015-0000-4000-8000-000000000015";
    b.sql()
        .batch_execute(
            "DROP TRIGGER IF EXISTS payroll_run_fail_first ON bank.business_payroll_runs;
             DROP FUNCTION IF EXISTS bank.payroll_run_fail_first();
             DROP SEQUENCE IF EXISTS bank.payroll_run_attempt_l159;
             CREATE SEQUENCE bank.payroll_run_attempt_l159;
             CREATE OR REPLACE FUNCTION bank.payroll_run_fail_first()
             RETURNS trigger
             LANGUAGE plpgsql
             AS $$
             BEGIN
               IF nextval('bank.payroll_run_attempt_l159') = 1 THEN
                 RAISE EXCEPTION 'run insert rolled back';
               END IF;
               RETURN NEW;
             END;
             $$;
             DROP TRIGGER IF EXISTS payroll_run_fail_first ON bank.business_payroll_runs;
             CREATE TRIGGER payroll_run_fail_first
             BEFORE INSERT ON bank.business_payroll_runs
             FOR EACH ROW
             EXECUTE FUNCTION bank.payroll_run_fail_first();",
        )
        .unwrap();
    let first = run(replay_id, &same);
    let Err(e) = first else {
        panic!("expected the run insert to roll back, got {first:?}")
    };
    assert!(format!("{e:?}").contains("run insert rolled back"), "{e:?}");
    let replayed = run(replay_id, &same).unwrap();
    assert!(!replayed.ledger_tx_id.is_empty());
    has_exactly(&replayed, &same);
    assert_eq!(moved(replay_id), 1);
    assert_eq!(available(), "675");
}

#[test]
fn a_shorter_payroll_conflicts_when_the_booked_payment_still_includes_the_dropped_recipient() {
    let Some(b) = bank() else { return };
    let account = account(&b, "100");
    let primary = b.primary(MAKER, "USDT");
    let alice = b.primary(CHECKER, "USDT");
    let bob = b.pot(MAKER, "USDT", "Contractor");
    b.ledger.fund_user(MAKER, "USDT", "1000");
    let payroll_id = "a1590016-0000-4000-8000-000000000016";
    let posted = book_payroll(
        &b,
        payroll_id,
        &primary,
        &[(alice.as_str(), "40"), (bob.as_str(), "25")],
    );
    seed_run(
        &b,
        payroll_id,
        &account,
        &primary,
        &posted.id,
        &[(alice.as_str(), "40")],
    );

    refused(
        run_payroll(
            &b,
            payroll_id,
            &account,
            MAKER,
            &primary,
            &[(alice.as_str(), "40")],
        ),
        "bank.business_request_conflict",
    );

    assert_eq!(stored_lines(&b, payroll_id), vec![alice.clone()]);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "935");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");
    assert_eq!(movements(&b, &biz::payroll_key(payroll_id)), 1);
}

#[test]
fn refuses_mixed_asset_payroll_as_rate_unset_never_invents_fx() {
    let Some(b) = bank() else { return };
    let account = account(&b, "10");
    let primary = b.primary(MAKER, "USDT");
    let eur = b.primary(CHECKER, "EUR");
    b.ledger.fund_user(MAKER, "USDT", "100");

    refused(
        run_payroll(
            &b,
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            &account,
            MAKER,
            &primary,
            &[(eur.as_str(), "10")],
        ),
        "bank.business_payroll_rate_unset",
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "100");
    assert_eq!(b.balance(&eur), "0");
}

#[test]
fn refuses_an_over_threshold_payroll_from_one_admin_or_maker_and_still_posts_under_it() {
    let Some(b) = bank() else { return };
    let account = account(&b, "100");
    add_member(&b, &account, CHECKER, "maker");
    let admin_from = b.primary(MAKER, "USDT");
    let maker_from = b.primary(CHECKER, "USDT");
    let alice = b.pot(MAKER, "USDT", "Alice");
    let bob = b.pot(MAKER, "USDT", "Bob");
    b.ledger.fund_user(MAKER, "USDT", "500");
    b.ledger.fund_user(CHECKER, "USDT", "500");
    let keyed = |prefix: &str| {
        b.ledger
            .keys()
            .iter()
            .filter(|k| k.starts_with(prefix))
            .count()
    };
    let payroll_or_hold = || keyed("bank.business.payroll:") + keyed("bank.business.hold:");
    let dual_control = |e: &Refusal| match e {
        Refusal::Bank(be) => assert!(
            be.message
                .to_lowercase()
                .contains("dual control is required"),
            "{}",
            be.message
        ),
        other => panic!("{other:?}"),
    };

    let e = refused(
        run_payroll(
            &b,
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            &account,
            MAKER,
            &admin_from,
            &[(alice.as_str(), "60"), (bob.as_str(), "40")],
        ),
        "bank.business_self_approve",
    );
    dual_control(&e);

    let e = refused(
        run_payroll(
            &b,
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            &account,
            CHECKER,
            &maker_from,
            &[(alice.as_str(), "100")],
        ),
        "bank.business_self_approve",
    );
    dual_control(&e);

    assert_eq!(b.ledger.available(MAKER, "USDT"), "500");
    assert_eq!(b.ledger.available(CHECKER, "USDT"), "500");
    assert_eq!(b.balance(&alice), "0");
    assert_eq!(b.balance(&bob), "0");
    assert_eq!(payroll_or_hold(), 0);
    assert_eq!(b.count("SELECT count(*) FROM bank.business_approvals"), 0);
    assert_eq!(
        b.count("SELECT count(*) FROM bank.business_payroll_runs"),
        0
    );

    let under = run_payroll(
        &b,
        "abababab-abab-4bab-8bab-abababababab",
        &account,
        MAKER,
        &admin_from,
        &[(alice.as_str(), "40"), (bob.as_str(), "25")],
    )
    .unwrap();
    assert!(!under.ledger_tx_id.is_empty());
    assert_eq!(b.ledger.available(MAKER, "USDT"), "435");
    assert_eq!(b.ledger.available(CHECKER, "USDT"), "500");
    assert_eq!(b.balance(&alice), "40");
    assert_eq!(b.balance(&bob), "25");
    assert_eq!(keyed("bank.business.payroll:"), 1);
    assert_eq!(keyed("bank.business.hold:"), 0);
    assert!(b.ledger.reconciles());
}

#[test]
fn refuses_an_empty_payroll() {
    let Some(b) = bank() else { return };
    let account = account(&b, "10");
    let primary = b.primary(MAKER, "USDT");
    refused(
        run_payroll(
            &b,
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            &account,
            MAKER,
            &primary,
            &[],
        ),
        "bank.business_payroll_empty",
    );
}

#[test]
fn refuses_a_non_member_checker() {
    let Some(b) = bank() else { return };
    let account = account(&b, "10");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "X");
    b.ledger.fund_user(MAKER, "USDT", "100");
    let proposed = propose(&b, &account, &primary, &pot, "50");
    let approval = pending_id(&proposed);
    refused(
        b.deps(|d| biz::approve(d, &approval, CHECKER)),
        "bank.business_not_member",
    );
}
