//! Slice `business`'s maker/checker dual control with ledger holds against the Rust slice on a real Postgres. Ports the
//! TypeScript's `services/svc-bank/src/business/business.test.ts`, the describe "maker/checker dual control with ledger
//! holds" from its `beforeEach` through "a release that dies after reject returns the hold on the next reject" (the
//! tests from "held funds cannot be double-spent while pending" on are another file's). Each test is named after the
//! TypeScript test's words; an `it.each` is one Rust test per case, its case in the name.
//!
//! The TypeScript calls `bank.business.*` directly; here each is the Rust function in `svc_bank::business::service`,
//! given the door's own dependencies (`Bank::deps`). `bank.spaces.ensurePrimary`, `bank.spaces.create` and
//! `bank.spaces.balanceOf` are the kit's `primary`, `pot` and `balance`; `bank.transfers.transfer` is
//! `transfers::moves::transfer`. Each test has its own migrated database, so the `beforeEach` TRUNCATE is implied.
//!
//! Where the TypeScript wraps `ledger.post`, the kit's `Book` hook answers for the ledger before a post is booked (a post
//! that throws without landing) or after (a lost acknowledgement, or a pause while the post has landed). Where it wraps
//! `ledger.getTxByKey`, the call runs over [`Spy`], this file's ledger that answers `tx_by_key` as the test says and
//! passes everything else to the same `Book`. Where it pauses a call on a promise and races a second call, the first
//! call runs on its own thread and pauses on a [`Latch`]; a pause that is never released (the TypeScript would hang)
//! gives up after [`WAIT`] and fails the test, so a deadlock is a failure, not a hung run.
//!
//! Not ported as written:
//! - `rejects.toMatchObject({ code: 'ledger.unavailable' })`: the Rust slice turns a ledger failure that is not a
//!   definite refusal into `Refusal::Other` (`transfers::moves::post_refusal`), which carries the ledger's message and
//!   no code. The test accepts either the code (should the slice carry it) or `Refusal::Other` naming the very ledger
//!   failure the test injected ([`unavailable`]).
//! - `ledger.journal().filter((tx) => tx.reason === 'bank.business.approval.settled')`: the kit's journal keeps the
//!   recipe, not its reason; the settle recipe (`businessApprovalSettle`) is the one that books that reason, and is
//!   counted instead.
//! - `rejects.toThrow(/.../)`: matched against the refusal's own text (its code and sentence, or the opaque failure's
//!   message), as [`text_of`] reads it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use svc_bank::business::service::{
    self as biz, NewAccount, Propose, Proposed, hold_key, release_key, settle_key,
};
use svc_bank::errors::Refusal;
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
use svc_bank::transfers::Deps;
use svc_bank::transfers::moves::{self, MoveAsk};

use crate::business_kit::{Bank, Book, Hook, amt, bank, uuid};

const MAKER: &str = "11111111-1111-4111-8111-111111111111";
const CHECKER: &str = "22222222-2222-4222-8222-222222222222";

/// How long a paused call waits to be released before the test calls it a deadlock.
const WAIT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------------------------------------------
// Helpers

fn code_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        Refusal::Trpc(e) => e.cause.clone().unwrap_or_else(|| e.code.to_owned()),
        Refusal::Other(_) => "none".to_owned(),
    }
}

/// The refusal's text: code and sentence, or the opaque failure's message.
fn text_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => format!("{} {}", e.row.code, e.message),
        Refusal::Trpc(e) => format!(
            "{} {} {}",
            e.code,
            e.cause.clone().unwrap_or_default(),
            e.message
        ),
        Refusal::Other(s) => s.clone(),
    }
}

/// `rejects.toMatchObject({ code })`.
#[track_caller]
fn refused<T: std::fmt::Debug>(r: Result<T, Refusal>, code: &str) {
    match r {
        Ok(v) => panic!("expected the refusal {code}, got {v:?}"),
        Err(e) => assert_eq!(code_of(&e), code, "{e:?}"),
    }
}

/// `rejects.toThrow(/text/)`.
#[track_caller]
fn throws<T: std::fmt::Debug>(r: Result<T, Refusal>, text: &str) {
    match r {
        Ok(v) => panic!("expected a failure naming {text:?}, got {v:?}"),
        Err(e) => assert!(text_of(&e).contains(text), "{text:?} not in {e:?}"),
    }
}

/// `rejects.toMatchObject({ code: 'ledger.unavailable' })`: the code, or the opaque failure carrying one of the
/// ledger failures the test injected (see the module's notes).
#[track_caller]
fn unavailable<T: std::fmt::Debug>(r: Result<T, Refusal>, injected: &[&str]) {
    match r {
        Ok(v) => panic!("expected ledger.unavailable, got {v:?}"),
        Err(e) => {
            let named = matches!(&e, Refusal::Other(s) if injected.iter().any(|m| s.contains(m)));
            assert!(code_of(&e) == "ledger.unavailable" || named, "{e:?}");
        }
    }
}

fn coded(code: &str, message: &str) -> PostFailure {
    PostFailure::Coded {
        code: code.to_owned(),
        message: message.to_owned(),
        attempts: 1,
    }
}

fn hook(f: impl Fn(&str, bool) -> Result<(), PostFailure> + Send + Sync + 'static) -> Option<Hook> {
    Some(Arc::new(
        move |_n: u32, _recipe: &str, key: &str, booked: bool| f(key, booked),
    ))
}

/// A one-way gate: shut until opened, then open for good.
#[derive(Clone, Default)]
struct Latch(Arc<(Mutex<bool>, Condvar)>);

impl Latch {
    fn open(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
    /// Whether it opened within [`WAIT`].
    fn wait(&self) -> bool {
        let (m, c) = &*self.0;
        let (g, _) = c
            .wait_timeout_while(m.lock().unwrap(), WAIT, |open| !*open)
            .unwrap();
        *g
    }
}

/// A ledger that answers `getTxByKey` as the test says (`None`: as the book does) and leaves the rest to the book.
/// What a lookup answers in the test's place (`None`: ask the book).
type ByKey = Box<dyn Fn(&str) -> Option<Result<Option<LedgerTx>, String>> + Send + Sync>;

struct Spy {
    book: Book,
    by_key: ByKey,
}

impl Ledger for Spy {
    fn balance(&self, a: &LedgerAccount) -> Result<service_kit::money::Amount, String> {
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
        (self.by_key)(key).unwrap_or_else(|| self.book.tx_by_key(key))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        self.book.post_recipe(recipe, input, key)
    }
}

/// `f` given the door's dependencies over another ledger.
fn deps_over<T>(b: &Bank, l: &dyn Ledger, f: impl FnOnce(&Deps<'_>) -> T) -> T {
    b.deps(|d| {
        let over = Deps {
            store: d.store,
            ledger: l,
            custody: d.custody,
            partner: d.partner,
            spaces: d.spaces,
            w: d.w,
            now: d.now,
        };
        f(&over)
    })
}

fn create(b: &Bank, name: &str, threshold: &str) -> String {
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

fn add_checker(b: &Bank, account: &str) {
    b.deps(|d| biz::add_member(d, account, MAKER, CHECKER, "checker"))
        .unwrap();
}

fn ask<'a>(
    client: &'a str,
    account: &'a str,
    from: &'a str,
    to: &'a str,
    amount: &str,
) -> Propose<'a> {
    Propose {
        account_id: account,
        maker_user_id: MAKER,
        from_space_id: from,
        to_space_id: to,
        amount: amt(amount),
        client_id: client,
    }
}

fn propose(b: &Bank, p: &Propose<'_>) -> Result<Proposed, Refusal> {
    b.deps(|d| biz::propose_transfer(d, p))
}

fn approve(b: &Bank, id: &str, checker: &str) -> Result<(String, String), Refusal> {
    b.deps(|d| biz::approve(d, id, checker))
}

fn pending(p: Proposed) -> biz::Approval {
    match p {
        Proposed::Pending(a) => *a,
        Proposed::Posted { .. } => panic!("expected pending"),
    }
}

fn posted(p: &Proposed) -> (String, String) {
    match p {
        Proposed::Posted {
            transfer_id,
            ledger_tx_id,
        } => (transfer_id.clone(), ledger_tx_id.clone()),
        Proposed::Pending(_) => panic!("expected posted"),
    }
}

/// `ledger.journal().filter((tx) => tx.idempotencyKey === key)`'s length.
fn keyed(b: &Bank, key: &str) -> usize {
    b.ledger.keys().iter().filter(|k| *k == key).count()
}

fn any_release(b: &Bank) -> bool {
    b.ledger
        .keys()
        .iter()
        .any(|k| k.starts_with("bank.business.release:"))
}

fn own_key(client: &str) -> String {
    format!("bank.transfer.own:{client}:0")
}

/// `SELECT status, ledger_tx_id, rejection_code`.
fn decision(b: &Bank, id: &str) -> Vec<(String, Option<String>, Option<String>)> {
    b.sql()
        .query(
            "SELECT status::text, ledger_tx_id, rejection_code FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

fn rows_with_id(b: &Bank, id: &str) -> i64 {
    b.sql()
        .query_one(
            "SELECT count(*) FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0)
}

/// `approvalFixture()`.
struct Fx {
    account: String,
    primary: String,
    pot: String,
}

fn approval_fixture(b: &Bank) -> Fx {
    let account = create(b, "Recovery Co", "100");
    add_checker(b, &account);
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Recovery destination");
    b.ledger.fund_user(MAKER, "USDT", "1000");
    Fx {
        account,
        primary,
        pot,
    }
}

/// The over-threshold set-up the last three tests share: "Ops Co" at 100 with a checker, 250 proposed to "Payroll".
fn ops_pending(b: &Bank) -> (String, biz::Approval) {
    let account = create(b, "Ops Co", "100");
    add_checker(b, &account);
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Payroll");
    b.ledger.fund_user(MAKER, "USDT", "1000");
    let client = uuid();
    let p = propose(b, &ask(&client, &account, &primary, &pot, "250")).unwrap();
    (pot, pending(p))
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

#[test]
fn posts_under_threshold_without_a_checker() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", "500");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "200");

    let client = uuid();
    let result = propose(&b, &ask(&client, &account, &primary, &pot, "100")).unwrap();
    assert!(matches!(result, Proposed::Posted { .. }), "{result:?}");
    assert_eq!(b.ledger.available(MAKER, "USDT"), "100");
    assert_eq!(b.balance(&pot), "100");
    assert!(b.ledger.reconciles());
}

#[test]
fn an_under_threshold_propose_remembers_its_client_id() {
    let Some(b) = bank() else { return };
    let client = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let account = create(&b, "Ops Co", "500");
    add_checker(&b, &account);
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Vendor");
    let other = b.pot(MAKER, "USDT", "Other");
    b.ledger.fund_user(MAKER, "USDT", "1000");

    let first = propose(&b, &ask(client, &account, &primary, &pot, "100")).unwrap();
    let (transfer_id, ledger_tx_id) = posted(&first);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "900");
    assert_eq!(b.balance(&pot), "100");

    // The same instruction is now at or above the spend floor. Terms did not change.
    b.sql()
        .execute(
            "UPDATE bank.business_accounts SET spend_threshold = $1::text::numeric WHERE id = $2::text::uuid",
            &[&format_amount(amt("50")), &account],
        )
        .unwrap();

    refused(
        propose(&b, &ask(client, &account, &primary, &other, "100")),
        "bank.business_request_conflict",
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "900");
    assert_eq!(b.balance(&pot), "100");
    assert_eq!(b.balance(&other), "0");

    let again = propose(&b, &ask(client, &account, &primary, &pot, "100")).unwrap();
    assert_eq!(
        again,
        Proposed::Posted {
            transfer_id: transfer_id.clone(),
            ledger_tx_id: ledger_tx_id.clone()
        }
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "900");
    assert_eq!(b.balance(&pot), "100");

    let settled = approve(&b, client, CHECKER).unwrap();
    assert_eq!(settled, (transfer_id, ledger_tx_id));
    assert_eq!(b.ledger.available(MAKER, "USDT"), "900");
    assert_eq!(b.balance(&pot), "100");
    assert!(b.ledger.reconciles());
}

/// An existing row the conflicting-propose test writes before it proposes.
struct Existing<'a> {
    to_space_id: &'a str,
    amount: &'a str,
    status: &'a str,
    transfer_id: Option<&'a str>,
    ledger_tx_id: Option<&'a str>,
    hold_ledger_tx_id: Option<&'a str>,
}

#[test]
fn a_conflicting_propose_is_not_reported_as_pending() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", "100");
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Vendor");
    let other = b.pot(MAKER, "USDT", "Other");
    b.ledger.fund_user(MAKER, "USDT", "5000");

    // Existing durable instructions control retries before any post. An
    // approved over-threshold winner names a checker who is not the maker (0029).
    let propose_against = |client: &str, to: &str, amount: &str, e: &Existing<'_>| {
        let checker = (e.status == "approved").then_some(CHECKER);
        let decided = e.status != "pending";
        b.sql()
            .execute(
                "INSERT INTO bank.business_approvals \
                   (id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id, asset_id, amount, status, \
                    transfer_id, hold_ledger_tx_id, ledger_tx_id, decided_at) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5::text::uuid, $6::text::uuid, 'USDT', \
                         $7::text::numeric, $8::text::bank.business_approval_status, $9::text, $10::text, $11::text, \
                         CASE WHEN $12::bool THEN now() ELSE NULL END)",
                &[
                    &client,
                    &account,
                    &MAKER,
                    &checker,
                    &primary,
                    &e.to_space_id,
                    &format_amount(amt(e.amount)),
                    &e.status,
                    &e.transfer_id,
                    &e.hold_ledger_tx_id,
                    &e.ledger_tx_id,
                    &decided,
                ],
            )
            .unwrap();
        propose(&b, &ask(client, &account, &primary, to, amount))
    };

    refused(
        propose_against(
            "f1580001-0000-4000-8000-000000000001",
            &pot,
            "250",
            &Existing {
                to_space_id: &other,
                amount: "400",
                status: "pending",
                transfer_id: None,
                ledger_tx_id: None,
                hold_ledger_tx_id: None,
            },
        ),
        "bank.business_request_conflict",
    );
    assert_eq!(b.balance(&pot), "0");
    assert_eq!(b.balance(&other), "0");

    let approved = propose_against(
        "f1580002-0000-4000-8000-000000000002",
        &pot,
        "250",
        &Existing {
            to_space_id: &pot,
            amount: "250",
            status: "approved",
            transfer_id: Some("orig-transfer-f158"),
            ledger_tx_id: Some("orig-ledger-f158"),
            hold_ledger_tx_id: None,
        },
    )
    .unwrap();
    assert_eq!(
        approved,
        Proposed::Posted {
            transfer_id: "orig-transfer-f158".to_owned(),
            ledger_tx_id: "orig-ledger-f158".to_owned(),
        }
    );
    assert_eq!(b.balance(&pot), "0");

    refused(
        propose_against(
            "f1580003-0000-4000-8000-000000000003",
            &pot,
            "250",
            &Existing {
                to_space_id: &pot,
                amount: "250",
                status: "rejected",
                transfer_id: None,
                ledger_tx_id: None,
                hold_ledger_tx_id: None,
            },
        ),
        "bank.business_approval_inactive",
    );

    refused(
        propose_against(
            "f1580004-0000-4000-8000-000000000004",
            &pot,
            "250",
            &Existing {
                to_space_id: &pot,
                amount: "250",
                status: "cancelled",
                transfer_id: None,
                ledger_tx_id: None,
                hold_ledger_tx_id: None,
            },
        ),
        "bank.business_approval_inactive",
    );

    let p = propose_against(
        "f1580005-0000-4000-8000-000000000005",
        &pot,
        "250",
        &Existing {
            to_space_id: &pot,
            amount: "250",
            status: "pending",
            transfer_id: None,
            ledger_tx_id: None,
            hold_ledger_tx_id: Some("existing-hold-f158"),
        },
    )
    .unwrap();
    let a = pending(p);
    assert_eq!(a.id, "f1580005-0000-4000-8000-000000000005");
    assert_eq!(a.status, "pending");
    assert_eq!(a.to_space_id, pot);
    assert_eq!(a.amount, amt("250"));
    assert_eq!(a.hold_ledger_tx_id.as_deref(), Some("existing-hold-f158"));
    assert_eq!(b.balance(&pot), "0");
    assert!(b.ledger.reconciles());
}

#[test]
fn reserves_over_threshold_on_propose_checker_settle_lands_at_destination() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", "100");
    add_checker(&b, &account);
    let primary = b.primary(MAKER, "USDT");
    let pot = b.pot(MAKER, "USDT", "Payroll");
    b.ledger.fund_user(MAKER, "USDT", "1000");

    let client = uuid();
    let proposed = propose(&b, &ask(&client, &account, &primary, &pot, "250")).unwrap();
    assert!(matches!(proposed, Proposed::Pending(_)), "{proposed:?}");
    // LEDger hold: available drops immediately; pot not credited yet.
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(b.balance(&pot), "0");
    let a = pending(proposed);
    assert!(
        a.hold_ledger_tx_id
            .as_deref()
            .is_some_and(|h| !h.is_empty())
    );

    refused(approve(&b, &a.id, MAKER), "bank.business_self_approve");

    let (_, ledger_tx_id) = approve(&b, &a.id, CHECKER).unwrap();
    assert!(!ledger_tx_id.is_empty());
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(b.balance(&pot), "250");
    assert!(b.ledger.reconciles());
}

#[test]
fn reconciles_a_committed_settle_after_its_acknowledgement_is_lost_without_releasing_the_hold() {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let a = pending(propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "250")).unwrap());
    b.ledger.set_hook(hook(|key, booked| {
        if booked && key.starts_with("bank.business.settle:") {
            return Err(coded("ledger.unavailable", "settle acknowledgement lost"));
        }
        Ok(())
    }));
    let settled = approve(&b, &a.id, CHECKER).unwrap();
    assert_eq!(approve(&b, &a.id, CHECKER).unwrap(), settled);
    assert_eq!(
        decision(&b, &a.id),
        vec![("approved".to_owned(), Some(settled.1.clone()), None)]
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(b.balance(&fx.pot), "250");
    assert_eq!(keyed(&b, &settle_key(&a.id)), 1);
    assert!(!any_release(&b));
    assert!(b.ledger.reconciles());
}

/// The race the two "claims ... terms" tests share: the first proposal pauses once its post under `pause_key` has
/// landed; a changed proposal under the same id is made meanwhile. Answers (first, changed, whether a pause timed out).
fn race_changed(
    b: &Bank,
    fx: &Fx,
    client: &str,
    amount: &str,
    pause_key: String,
    other: &str,
    conflicting: &str,
) -> (Result<Proposed, Refusal>, Result<Proposed, Refusal>, bool) {
    let arrived = Latch::default();
    let resume = Latch::default();
    let blocked = Arc::new(AtomicBool::new(false));
    let pause = Arc::new(AtomicBool::new(true));
    {
        let (arrived, resume, blocked, pause) = (
            arrived.clone(),
            resume.clone(),
            blocked.clone(),
            pause.clone(),
        );
        b.ledger.set_hook(hook(move |key, booked| {
            if booked && key == pause_key && pause.swap(false, Ordering::SeqCst) {
                arrived.open();
                if !resume.wait() {
                    blocked.store(true, Ordering::SeqCst);
                }
            }
            Ok(())
        }));
    }
    std::thread::scope(|s| {
        let first = s.spawn(|| propose(b, &ask(client, &fx.account, &fx.primary, &fx.pot, amount)));
        assert!(arrived.wait(), "the first proposal never reached its post");
        let changed = propose(
            b,
            &ask(client, &fx.account, &fx.primary, other, conflicting),
        );
        resume.open();
        let first = first.join().unwrap();
        (first, changed, blocked.load(Ordering::SeqCst))
    })
}

fn claims_immediate_terms(conflicting: &str) {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let other = b.pot(MAKER, "USDT", "Conflicting destination");
    let client = uuid();
    let (first, changed, blocked) = race_changed(
        &b,
        &fx,
        &client,
        "10",
        own_key(&client),
        &other,
        conflicting,
    );
    assert!(
        !blocked,
        "the changed proposal waited on the paused first one (the TypeScript would hang)"
    );
    refused(changed, "bank.business_request_conflict");
    let result = first.unwrap();
    let (_, ledger_tx_id) = posted(&result);
    let rows: Vec<(String, String, Option<String>)> = b
        .sql()
        .query(
            "SELECT amount::text, to_space_id::text, ledger_tx_id FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&client],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        rows,
        vec![(
            "10.000000000000000000".to_owned(),
            fx.pot.clone(),
            Some(ledger_tx_id)
        )]
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "990");
    assert_eq!(b.balance(&fx.pot), "10");
    assert_eq!(b.balance(&other), "0");
    assert_eq!(keyed(&b, &own_key(&client)), 1);
}

#[test]
fn claims_immediate_terms_before_a_concurrent_changed_proposal_of_20() {
    claims_immediate_terms("20");
}

#[test]
fn claims_immediate_terms_before_a_concurrent_changed_proposal_of_250() {
    claims_immediate_terms("250");
}

fn claims_over_threshold_terms(conflicting: &str) {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let other = b.pot(MAKER, "USDT", "Conflicting destination");
    let client = uuid();
    let (first, changed, blocked) = race_changed(
        &b,
        &fx,
        &client,
        "250",
        hold_key(&client),
        &other,
        conflicting,
    );
    assert!(
        !blocked,
        "the changed proposal waited on the paused first one (the TypeScript would hang)"
    );
    refused(changed, "bank.business_request_conflict");
    let a = pending(first.unwrap());
    let rows: Vec<(String, String, Option<String>)> = b
        .sql()
        .query(
            "SELECT amount::text, to_space_id::text, hold_ledger_tx_id FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&client],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        rows,
        vec![(
            "250.000000000000000000".to_owned(),
            fx.pot.clone(),
            a.hold_ledger_tx_id.clone()
        )]
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(b.balance(&fx.pot), "0");
    assert_eq!(b.balance(&other), "0");
    assert_eq!(keyed(&b, &hold_key(&client)), 1);
}

#[test]
fn claims_over_threshold_terms_before_a_concurrent_changed_proposal_of_400() {
    claims_over_threshold_terms("400");
}

#[test]
fn claims_over_threshold_terms_before_a_concurrent_changed_proposal_of_20() {
    claims_over_threshold_terms("20");
}

fn keeps_an_unknown_settlement_recoverable(committed: bool, lookup_unavailable: bool) {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let a = pending(propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "250")).unwrap());
    b.ledger.set_hook(hook(move |key, booked| {
        // committed: the settle lands and its answer is lost; else it never lands.
        if key.starts_with("bank.business.settle:") && booked == committed {
            return Err(coded("ledger.unavailable", "unknown settlement outcome"));
        }
        Ok(())
    }));
    let spy = Spy {
        book: b.ledger.clone(),
        by_key: Box::new(move |_key| {
            lookup_unavailable.then(|| Err("receipt lookup unavailable".to_owned()))
        }),
    };
    unavailable(
        deps_over(&b, &spy, |d| biz::approve(d, &a.id, CHECKER)),
        &["unknown settlement outcome", "receipt lookup unavailable"],
    );
    assert_eq!(
        decision(&b, &a.id),
        vec![("approved".to_owned(), None, None)]
    );
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(b.balance(&fx.pot), if committed { "250" } else { "0" });
    assert!(!any_release(&b));
    b.ledger.set_hook(None);
    let recovered = approve(&b, &a.id, CHECKER).unwrap();
    assert_eq!(approve(&b, &a.id, CHECKER).unwrap(), recovered);
    assert_eq!(b.balance(&fx.pot), "250");
    assert_eq!(keyed(&b, &settle_key(&a.id)), 1);
    assert!(b.ledger.reconciles());
}

#[test]
fn keeps_an_unknown_settlement_recoverable_without_releasing_its_hold_committed_true_lookup_unavailable_true()
 {
    keeps_an_unknown_settlement_recoverable(true, true);
}

#[test]
fn keeps_an_unknown_settlement_recoverable_without_releasing_its_hold_committed_false_lookup_unavailable_false()
 {
    keeps_an_unknown_settlement_recoverable(false, false);
}

#[test]
fn a_stale_definitive_rejection_cannot_release_a_settlement_another_retry_already_recorded() {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let a = pending(propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "250")).unwrap());
    let fail = Arc::new(AtomicBool::new(true));
    {
        let fail = fail.clone();
        b.ledger.set_hook(hook(move |key, booked| {
            if !booked
                && key.starts_with("bank.business.settle:")
                && fail.swap(false, Ordering::SeqCst)
            {
                return Err(coded("ledger.insufficient_funds", "settle refused"));
            }
            Ok(())
        }));
    }
    let arrived = Latch::default();
    let resume = Latch::default();
    let blocked = Arc::new(AtomicBool::new(false));
    let settle = settle_key(&a.id);
    let spy = {
        let (arrived, resume, blocked) = (arrived.clone(), resume.clone(), blocked.clone());
        Spy {
            book: b.ledger.clone(),
            by_key: Box::new(move |key| {
                (key == settle).then(|| {
                    arrived.open();
                    if !resume.wait() {
                        blocked.store(true, Ordering::SeqCst);
                    }
                    // The failed contender's receipt read began before the winning retry.
                    Ok(None)
                })
            }),
        }
    };
    let (first, second) = std::thread::scope(|s| {
        let first = s.spawn(|| deps_over(&b, &spy, |d| biz::approve(d, &a.id, CHECKER)));
        assert!(
            arrived.wait(),
            "the first approval never read the settle's receipt"
        );
        let second = deps_over(&b, &spy, |d| biz::approve(d, &a.id, CHECKER));
        resume.open();
        (first.join().unwrap(), second)
    });
    assert!(
        !blocked.load(Ordering::SeqCst),
        "the second approval waited on the paused first one (the TypeScript would hang)"
    );
    let second = second.unwrap();
    assert_eq!(first.unwrap(), second);
    assert_eq!(b.balance(&fx.pot), "250");
    assert_eq!(keyed(&b, &settle_key(&a.id)), 1);
    assert!(!any_release(&b));
}

#[test]
fn identical_concurrent_immediate_proposals_return_one_verified_transfer() {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "10");
    let (r0, r1) = std::thread::scope(|s| {
        let one = s.spawn(|| propose(&b, &input));
        let two = s.spawn(|| propose(&b, &input));
        (one.join().unwrap(), two.join().unwrap())
    });
    let r0 = r0.unwrap();
    assert_eq!(r0, r1.unwrap());
    assert_eq!(propose(&b, &input).unwrap(), r0);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "990");
    assert_eq!(b.balance(&fx.pot), "10");
    assert_eq!(keyed(&b, &own_key(&client)), 1);
}

fn identical_approval_proposals_recover(committed: bool) {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "250");
    let hold = hold_key(&client);
    b.ledger.set_hook(hook(move |key, booked| {
        if key == hold && booked == committed {
            return Err(coded("ledger.unavailable", "hold acknowledgement lost"));
        }
        Ok(())
    }));
    unavailable(propose(&b, &input), &["hold acknowledgement lost"]);
    refused(
        propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "20")),
        "bank.business_request_conflict",
    );
    refused(
        approve(&b, &client, CHECKER),
        "bank.business_approval_inactive",
    );
    b.ledger.set_hook(None);
    let (r0, r1) = std::thread::scope(|s| {
        let one = s.spawn(|| propose(&b, &input));
        let two = s.spawn(|| propose(&b, &input));
        (one.join().unwrap(), two.join().unwrap())
    });
    let r0 = r0.unwrap();
    assert_eq!(r0, r1.unwrap());
    assert_eq!(propose(&b, &input).unwrap(), r0);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(keyed(&b, &hold_key(&client)), 1);
    b.deps(|d| biz::cancel(d, &client, MAKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "1000");
}

#[test]
fn identical_approval_proposals_recover_an_unknown_hold_outcome_committed_false() {
    identical_approval_proposals_recover(false);
}

#[test]
fn identical_approval_proposals_recover_an_unknown_hold_outcome_committed_true() {
    identical_approval_proposals_recover(true);
}

fn cancellation_releases_a_late_hold(committed: bool) {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "250");
    let arrived = Latch::default();
    let resume = Latch::default();
    let blocked = Arc::new(AtomicBool::new(false));
    {
        let (arrived, resume, blocked) = (arrived.clone(), resume.clone(), blocked.clone());
        let hold = hold_key(&client);
        // committed: the hold lands, then its answer waits; else it waits, then lands.
        b.ledger.set_hook(hook(move |key, booked| {
            if key == hold && booked == committed {
                arrived.open();
                if !resume.wait() {
                    blocked.store(true, Ordering::SeqCst);
                }
            }
            Ok(())
        }));
    }
    let (proposing, cancelled) = std::thread::scope(|s| {
        let proposing = s.spawn(|| propose(&b, &input));
        assert!(arrived.wait(), "the proposal never reached its hold");
        let cancelled = b.deps(|d| biz::cancel(d, &client, MAKER));
        resume.open();
        (proposing.join().unwrap(), cancelled)
    });
    assert!(
        !blocked.load(Ordering::SeqCst),
        "the cancel waited on the paused proposal (the TypeScript would hang)"
    );
    cancelled.unwrap();
    refused(proposing, "bank.business_approval_inactive");
    b.deps(|d| biz::cancel(d, &client, MAKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "1000");
    assert_eq!(b.balance(&fx.pot), "0");
    assert_eq!(keyed(&b, &hold_key(&client)), 1);
    assert_eq!(keyed(&b, &release_key(&client)), 1);
}

#[test]
fn cancellation_releases_a_hold_arriving_after_its_original_intent_committed_false() {
    cancellation_releases_a_late_hold(false);
}

#[test]
fn cancellation_releases_a_hold_arriving_after_its_original_intent_committed_true() {
    cancellation_releases_a_late_hold(true);
}

#[test]
fn an_immediate_proposal_with_a_lost_acknowledgement_retains_its_original_terms_and_recovers_the_same_transfer()
 {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "10");
    let own = own_key(&client);
    b.ledger.set_hook(hook(move |key, booked| {
        if booked && key == own {
            return Err(coded("ledger.unavailable", "transfer acknowledgement lost"));
        }
        Ok(())
    }));
    unavailable(propose(&b, &input), &["transfer acknowledgement lost"]);
    refused(
        propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "20")),
        "bank.business_request_conflict",
    );
    refused(
        approve(&b, &client, CHECKER),
        "bank.business_approval_inactive",
    );
    b.ledger.set_hook(None);
    let recovered = propose(&b, &input).unwrap();
    assert_eq!(propose(&b, &input).unwrap(), recovered);
    assert_eq!(b.balance(&fx.pot), "10");
    assert_eq!(keyed(&b, &own_key(&client)), 1);
}

#[test]
fn a_legacy_approval_hold_without_a_row_refuses_changed_terms_and_recovers_one_reserved_amount() {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "250");
    let original = b
        .ledger
        .post_recipe(
            "businessApprovalHold",
            &Json::obj([
                ("approvalId", Json::str(client.clone())),
                ("from", LedgerAccount::user_available(MAKER, "USDT").json()),
                ("amount", Json::str(format_amount(input.amount))),
            ]),
            &hold_key(&client),
        )
        .unwrap();
    refused(
        propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "20")),
        "bank.business_request_conflict",
    );
    assert_eq!(rows_with_id(&b, &client), 0);
    let recovered = propose(&b, &input).unwrap();
    assert!(matches!(recovered, Proposed::Pending(_)), "{recovered:?}");
    let a = pending(recovered);
    assert_eq!(a.hold_ledger_tx_id, Some(original.id));
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");
    assert_eq!(keyed(&b, &hold_key(&client)), 1);
    b.deps(|d| biz::cancel(d, &client, MAKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "1000");
}

#[test]
fn a_legacy_immediate_transfer_without_an_approval_row_refuses_changed_terms_and_recovers_its_original_receipt()
 {
    let Some(b) = bank() else { return };
    let fx = approval_fixture(&b);
    let client = uuid();
    let input = ask(&client, &fx.account, &fx.primary, &fx.pot, "10");
    let original = b
        .deps(|d| {
            moves::transfer(
                d,
                &MoveAsk {
                    transfer_id: &client,
                    from_space_id: &fx.primary,
                    to_space_id: &fx.pot,
                    amount: input.amount,
                    note: None,
                    reference: None,
                    key_space: "own",
                },
            )
        })
        .unwrap();
    refused(
        propose(&b, &ask(&client, &fx.account, &fx.primary, &fx.pot, "20")),
        "bank.business_request_conflict",
    );
    assert_eq!(rows_with_id(&b, &client), 0);
    assert_eq!(
        propose(&b, &input).unwrap(),
        Proposed::Posted {
            transfer_id: client.clone(),
            ledger_tx_id: original.ledger_tx_id().unwrap().to_owned(),
        }
    );
    assert_eq!(keyed(&b, &own_key(&client)), 1);
}

/// Counts settle and release posts asked of the ledger; a settle is refused as too little money, and a release
/// answers `release` (`None`: it books).
fn counting(b: &Bank, release: Option<&'static str>) -> (Arc<AtomicU32>, Arc<AtomicU32>) {
    let settles = Arc::new(AtomicU32::new(0));
    let releases = Arc::new(AtomicU32::new(0));
    let (s, r) = (settles.clone(), releases.clone());
    b.ledger.set_hook(hook(move |key, booked| {
        if booked {
            return Ok(());
        }
        if key.starts_with("bank.business.settle:") {
            s.fetch_add(1, Ordering::SeqCst);
            return Err(coded("ledger.insufficient_funds", "settle refused"));
        }
        if key.starts_with("bank.business.release:") {
            r.fetch_add(1, Ordering::SeqCst);
            if let Some(m) = release {
                return Err(PostFailure::Unknown(m.to_owned()));
            }
        }
        Ok(())
    }));
    (settles, releases)
}

fn settles_booked(b: &Bank) -> usize {
    b.ledger
        .recipes()
        .iter()
        .filter(|r| *r == "businessApprovalSettle")
        .count()
}

#[test]
fn a_failing_settle_posts_the_release_once_and_a_second_approve_does_not_settle() {
    let Some(b) = bank() else { return };
    let (pot, a) = ops_pending(&b);
    let (settles, releases) = counting(&b, None);

    throws(
        approve(&b, &a.id, CHECKER),
        "settle did not post and the hold was released",
    );
    assert_eq!(settles.load(Ordering::SeqCst), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "1000");
    assert_eq!(b.balance(&pot), "0");

    let rows: Vec<(String, Option<String>, Option<String>, String)> = b
        .sql()
        .query(
            "SELECT status::text AS status, rejection_code, ledger_tx_id, amount::text AS amount \
               FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&a.id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert_eq!(rows[0].0, "rejected");
    assert_eq!(rows[0].1.as_deref(), Some("bank.business_settle_unposted"));
    assert_eq!(rows[0].2, None);
    assert_eq!(format_amount(parse_amount(&rows[0].3).unwrap()), "250");

    refused(
        approve(&b, &a.id, CHECKER),
        "bank.business_approval_inactive",
    );
    assert_eq!(settles.load(Ordering::SeqCst), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    let released: Vec<LedgerTx> = b
        .ledger
        .st
        .lock()
        .unwrap()
        .journal
        .iter()
        .filter(|j| j.0 == release_key(&a.id))
        .map(|j| j.3.clone())
        .collect();
    assert_eq!(released.len(), 1);
    assert_eq!(
        released[0]
            .entries
            .iter()
            .map(|e| format_amount(e.amount))
            .collect::<Vec<_>>(),
        vec!["250", "250"]
    );
    assert_eq!(settles_booked(&b), 0);
    assert!(b.ledger.reconciles());
}

#[test]
fn a_release_that_throws_after_a_failed_settle_leaves_the_row_unapproved_and_a_later_approve_does_not_settle()
 {
    let Some(b) = bank() else { return };
    let (_pot, a) = ops_pending(&b);
    let (settles, releases) = counting(&b, Some("release down"));

    throws(approve(&b, &a.id, CHECKER), "release down");
    assert_eq!(settles.load(Ordering::SeqCst), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");

    let rows = decision(&b, &a.id);
    assert_ne!(rows[0].0, "approved");
    assert_eq!(rows[0].0, "rejected");
    assert_eq!(rows[0].2.as_deref(), Some("bank.business_settle_unposted"));
    assert_eq!(rows[0].1, None);

    refused(
        approve(&b, &a.id, CHECKER),
        "bank.business_approval_inactive",
    );
    assert_eq!(settles.load(Ordering::SeqCst), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(settles_booked(&b), 0);
    assert_eq!(keyed(&b, &release_key(&a.id)), 0);
    assert!(b.ledger.reconciles());
}

#[test]
fn a_release_that_dies_after_reject_returns_the_hold_on_the_next_reject() {
    let Some(b) = bank() else { return };
    let (pot, a) = ops_pending(&b);
    let fail_release = Arc::new(AtomicBool::new(true));
    {
        let fail_release = fail_release.clone();
        b.ledger.set_hook(hook(move |key, booked| {
            if !booked
                && key.starts_with("bank.business.release:")
                && fail_release.swap(false, Ordering::SeqCst)
            {
                return Err(PostFailure::Unknown("release down".to_owned()));
            }
            Ok(())
        }));
    }

    throws(b.deps(|d| biz::reject(d, &a.id, CHECKER)), "release down");
    assert_eq!(b.ledger.available(MAKER, "USDT"), "750");

    b.deps(|d| biz::reject(d, &a.id, CHECKER)).unwrap();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "1000");
    assert_eq!(b.balance(&pot), "0");
    assert!(b.ledger.reconciles());
}
