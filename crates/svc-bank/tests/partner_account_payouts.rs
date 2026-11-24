//! Cash out that pays out, with the TEST payout stand-in as the partner, against the Rust door on a real Postgres: the
//! checks of the TypeScript's `cash-out/payouts.db.test.ts`, each test named after its words. The partner's answers are
//! its signed job doors; the re-drive's outcomes are read from the job's own function. Funds are TEST deposits on a
//! ledger held in memory, or the TEST partner bank's for the partner-held cases. Without `TEST_DATABASE_URL` each test
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript swaps the service's own `quote` for one priced before a drain; these write the request as that quote
//! left it (`processing`, priced, held at the partner, nothing taken) and drive it with the same request, which is the
//! same drive. Not ported: the sweep's count of which keys the partner was asked about (each sweep test checks the same
//! through what was given back and when each request was last checked).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::partner_account_kit::*;
use crate::support;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;
use std::sync::{Mutex, mpsc};
use support::TestDb;
use svc_bank::door::BankDoor;
use svc_bank::errors::Refusal;
use svc_bank::partner::{AccountRef, Funding, LABEL, MoveRequest, payouts_account};
use svc_bank::partner_account::cash_out::ledger::{Recipe, Withdrawal};
use svc_bank::partner_account::cash_out::payout_sim::{Partner, RAIL};
use svc_bank::partner_account::cash_out::receipt::{hkdf_sha256_32, hmac_sha256};
use svc_bank::partner_account::cash_out::security_lock::{LockState, SecurityLock};
use svc_bank::partner_account::cash_out::{self, Outcome};

struct Suite {
    db: TestDb,
    ledger: MemLedger,
    lock: Lock,
}

impl Suite {
    fn new() -> Option<Suite> {
        let s = Suite {
            db: db()?,
            ledger: MemLedger::default(),
            lock: Lock::default(),
        };
        fund(&s.ledger, ADA, "50", "cash-out-fund-ada");
        Some(s)
    }

    /// `services(partner)`'s door, on the ledger path.
    fn door(&self, partner: Option<Partner>) -> BankDoor {
        door(
            &self.db,
            &self.ledger,
            &self.lock,
            Setup {
                partner,
                ..Setup::default()
            },
        )
    }

    fn sim(&self) -> BankDoor {
        self.door(Some(sim(None)))
    }

    /// A door whose TEST partner bank holds Ada's money: 50 USDT in her main balance.
    fn held_at_partner(&self) -> BankDoor {
        let d = door(
            &self.db,
            &self.ledger,
            &self.lock,
            Setup {
                partner: Some(sim(None)),
                partner_bank: true,
                ..Setup::default()
            },
        );
        custody(&d, "off");
        partner_fund(&d, "cash-out-partner-fund-ada", "50");
        d
    }

    /// A linked account the partner verified, linked `hours_ago` hours ago (past the 24-hour cooling-off by default).
    fn usable(&self, d: &BankDoor) -> String {
        let input = r#"{"label":"TEST salary account","holderName":"TEST Holder","iban":"GB82WEST12345698765432"}"#;
        let a = mutate(d, ADA, STEPPED, "linkedAccounts.link", input).ok();
        let id = f(a.get("account").unwrap(), "accountId");
        job_ok(verify(d, &id));
        self.created_ago(&id, "25 hours");
        id
    }

    fn created_ago(&self, id: &str, ago: &str) {
        self.db
            .client()
            .execute(
                "UPDATE bank.linked_bank_accounts SET created_at = now() - $2::text::interval WHERE id = $1::text::uuid",
                &[&id, &ago],
            )
            .unwrap();
    }

    /// A request written `processing` five minutes ago, as if the process stopped right after; `booked` posts its
    /// hold too.
    fn left(&self, account: &str, booked: bool) -> String {
        let request = uuid();
        self.db
            .client()
            .execute(
                "INSERT INTO bank.cash_out_requests (id, user_id, asset_id, amount, linked_account_id, status, payout_rail, created_at) \
                 VALUES ($1::text::uuid, $2, 'USDT', 20, $3::text::uuid, 'processing', $4, now() - interval '5 minutes')",
                &[&request, &ADA, &account, &RAIL],
            )
            .unwrap();
        if booked {
            self.ledger.post_ok(&hold(&request));
        }
        request
    }

    fn sql(&self, q: &str, id: &str) {
        self.db.client().execute(q, &[&id]).unwrap();
    }
}

fn hold(request: &str) -> Recipe {
    Recipe::WithdrawHold(Withdrawal {
        user_id: ADA.to_owned(),
        asset_id: "USDT".to_owned(),
        amount: amount("20"),
        rail: RAIL.to_owned(),
        withdrawal_id: cash_out::withdrawal_id(request),
    })
}

fn verify(d: &BankDoor, id: &str) -> (u16, Json) {
    job(
        d,
        "/internal/jobs/payout-sim/verify",
        &format!(r#"{{"accountId":"{id}"}}"#),
    )
}

fn paid(d: &BankDoor, id: &str) -> (u16, Json) {
    job(
        d,
        "/internal/jobs/payout-sim/paid",
        &format!(r#"{{"cashOutId":"{id}"}}"#),
    )
}

fn failed(d: &BankDoor, id: &str, reason: &str) -> (u16, Json) {
    job(
        d,
        "/internal/jobs/payout-sim/failed",
        &format!(r#"{{"cashOutId":"{id}","reason":"{reason}"}}"#),
    )
}

fn cancelled(d: &BankDoor, id: &str, reason: &str) -> (u16, Json) {
    job(
        d,
        "/internal/jobs/payout-sim/cancelled",
        &format!(r#"{{"cashOutId":"{id}","reason":"{reason}"}}"#),
    )
}

fn returned(d: &BankDoor, id: &str, amount: &str, asset: &str) -> (u16, Json) {
    job(
        d,
        "/internal/jobs/payout-sim/returned",
        &format!(
            r#"{{"cashOutId":"{id}","amount":"{amount}","assetId":"{asset}","reason":"bank.payout_returned_by_bank"}}"#
        ),
    )
}

fn redrive(d: &BankDoor, limit: i64) -> Vec<Outcome> {
    cash_out::redrive(&d.partner_account(), limit).unwrap()
}

fn done(id: &str) -> Outcome {
    (id.to_owned(), "completed", None)
}

fn not_done(id: &str, why: &str) -> Outcome {
    (id.to_owned(), "failed", Some(why.to_owned()))
}

fn ask(request: &str, amount: &str, account: &str) -> String {
    format!(
        r#"{{"requestId":"{request}","assetId":"USDT","amount":"{amount}","linkedAccountId":"{account}"}}"#
    )
}

fn start(d: &BankDoor, account: &str, amount: &str, request: &str) -> Json {
    mutate(
        d,
        ADA,
        STEPPED,
        "cashOut.start",
        &ask(request, amount, account),
    )
    .ok()
}

fn quote(d: &BankDoor, amount: &str, account: &str) -> Answer {
    let input =
        format!(r#"{{"assetId":"USDT","amount":"{amount}","linkedAccountId":"{account}"}}"#);
    query(d, ADA, STEPPED, "cashOut.quote", Some(&input))
}

fn requests(d: &BankDoor, limit: i64) -> Vec<Json> {
    match query(
        d,
        ADA,
        STEPPED,
        "cashOut.requests",
        Some(&format!(r#"{{"limit":{limit}}}"#)),
    )
    .ok()
    {
        Json::Array(a) => a,
        other => panic!("{}", other.compact()),
    }
}

fn receipt(d: &BankDoor, user: &str, request: &str) -> Answer {
    query(
        d,
        user,
        STEPPED,
        "cashOut.receipt",
        Some(&format!(r#"{{"requestId":"{request}"}}"#)),
    )
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// The TEST partner bank, as the partner-held cases drive it.

fn custody(d: &BankDoor, on: &str) {
    mutate(
        d,
        ADA,
        STEPPED,
        "testPartner.set",
        &format!(r#"{{"custody":"{on}"}}"#),
    )
    .ok();
}

fn now() -> Instant {
    svc_bank::door::system_now()
}

fn partner_fund(d: &BankDoor, fund_id: &str, value: &str) {
    d.partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .fund(
            ADA,
            &Funding {
                fund_id: fund_id.to_owned(),
                asset_id: "USDT".to_owned(),
                amount: amount(value),
            },
            now(),
        )
        .unwrap();
}

fn main_usdt() -> AccountRef {
    AccountRef::main(ADA, "USDT")
}

fn at_partner(d: &BankDoor) -> String {
    let b = d
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .report(&main_usdt(), now());
    b.amount.map_or_else(|| "null".to_owned(), format_amount)
}

fn partner_move(d: &BankDoor, key: &str, from: AccountRef, to: AccountRef, value: &str) {
    d.partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .move_raw(
            &MoveRequest {
                key: key.to_owned(),
                from,
                to,
                amount: amount(value),
                payees: None,
            },
            now(),
        )
        .unwrap();
}

/// Forty-five of the fifty go to a space, so a twenty asked before it can no longer be taken.
fn drain(d: &BankDoor) {
    let space = AccountRef {
        space_id: Some("TEST-space".to_owned()),
        ..main_usdt()
    };
    partner_move(d, "TEST-drain", main_usdt(), space, "45");
}

fn move_by_key(d: &BankDoor, key: &str) -> Option<String> {
    d.partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .book
        .by_key(key)
        .map(|m| m.id.clone())
}

/// A partner-held request as a quote read before the drain left it: priced, held at the partner, nothing taken.
fn priced(s: &Suite, account: &str) -> String {
    let request = uuid();
    s.db.client()
        .execute(
            "INSERT INTO bank.cash_out_requests (id, user_id, asset_id, amount, linked_account_id, status, payout_rail, \
               fee, receive_amount, receive_currency, custodian) \
             VALUES ($1::text::uuid, $2, 'USDT', 20, $3::text::uuid, 'processing', $4, 1.5, 16.5, 'EUR', $5)",
            &[&request, &ADA, &account, &RAIL, &LABEL],
        )
        .unwrap();
    request
}

/// [`priced`], driven on by asking again with the same request: the drive is refused for funds. Its refusal and
/// creation are `ago` old.
fn drive_refused(s: &Suite, d: &BankDoor, account: &str, ago: &str) -> String {
    let request = priced(s, account);
    let kept = start(d, account, "20", &request);
    matches(
        &kept,
        &[
            ("status", "refused"),
            ("refusalCode", "bank.cash_out_over_available"),
            ("partnerMoveId", "null"),
        ],
    );
    s.db.client()
        .execute(
            "UPDATE bank.cash_out_requests SET drive_refused_at = now() - $2::text::interval, \
               created_at = now() - $2::text::interval WHERE id = $1::text::uuid",
            &[&request, &ago],
        )
        .unwrap();
    request
}

/// A driver that lost its lock makes the order move anyway, then crashes before giving it back.
fn stray_move(d: &BankDoor, request: &str, fund_id: &str) {
    partner_fund(d, fund_id, "20");
    partner_move(
        d,
        &cash_out::move_key(request),
        main_usdt(),
        payouts_account("USDT"),
        "20",
    );
}

fn stray_checked(s: &Suite, id: &str) -> Option<i64> {
    s.db.client()
        .query_one(
            "SELECT (floor(extract(epoch FROM stray_checked_at) * 1000))::int8 FROM bank.cash_out_requests WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0)
}

// The partner verifies the account.

#[test]
fn only_through_the_partner_with_none_it_refuses_rail_bank_and_the_account_stays_unverified() {
    let Some(s) = Suite::new() else { return };
    let none = s.door(None);
    let d = s.sim();
    let input = r#"{"label":"TEST","holderName":"TEST Holder","iban":"GB82WEST12345698765432"}"#;
    let a = mutate(&d, ADA, STEPPED, "linkedAccounts.link", input).ok();
    let id = f(a.get("account").unwrap(), "accountId");
    assert_eq!(job_refused(verify(&none, &id)), "rail.bank");
    let listed = query(&d, ADA, STEPPED, "linkedAccounts.list", None).ok();
    let Some(Json::Array(accounts)) = listed.get("accounts") else {
        panic!()
    };
    matches(&accounts[0], &[("state", "unverified")]);
    let verified = job_ok(verify(&d, &id));
    matches(
        &verified,
        &[
            ("state", "verified"),
            ("verificationRail", "null"),
            ("blocker", "bank.offramp_cooling_active"),
        ],
    );
    // Again is the same answer; an account that is not linked (removed, or none) is not found.
    assert_eq!(f(&job_ok(verify(&d, &id)), "state"), "verified");
    assert_eq!(
        job_refused(verify(&d, &uuid())),
        "bank.linked_account_not_found"
    );
    mutate(
        &d,
        ADA,
        STEPPED,
        "linkedAccounts.remove",
        &format!(r#"{{"accountId":"{id}"}}"#),
    )
    .ok();
    assert_eq!(
        job_refused(verify(&d, &id)),
        "bank.linked_account_not_found"
    );
}

// The quote.

#[test]
fn a_usable_account_shows_the_partners_fee_and_what_arrives_with_its_test_label_an_unverified_one_shows_neither()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    matches(
        &quote(&d, "20", &id).ok(),
        &[
            ("available", "50"),
            ("fee", "1.5"),
            ("receiveAmount", "16.5"),
            ("receiveCurrency", "EUR"),
            ("blocker", "null"),
            ("standIn", "TEST payout stand-in"),
        ],
    );
    s.created_ago(&id, "0 hours");
    matches(
        &quote(&d, "20", &id).ok(),
        &[
            ("fee", "null"),
            ("receiveAmount", "null"),
            ("blocker", "bank.offramp_cooling_active"),
            ("standIn", "null"),
        ],
    );
    // An amount the fee eats is not priced, so the partner is what stands in the way.
    s.created_ago(&id, "25 hours");
    assert_eq!(
        f(&quote(&d, "1", &id).ok(), "blocker"),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(s.ledger.posts(), 1);
}

// Confirming.

#[test]
fn holds_the_amount_once_under_the_request_hands_it_to_the_partner_and_the_same_id_posts_nothing_twice()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    let first = start(&d, &id, "20", &request);
    let payout = format!("TEST-PAYOUT-{request}");
    matches(
        &first,
        &[
            ("requestId", &request),
            ("status", "processing"),
            ("refusalCode", "null"),
            ("fee", "1.5"),
            ("receiveAmount", "16.5"),
            ("receiveCurrency", "EUR"),
            ("payoutRef", &payout),
            ("ledgerTxId", "null"),
        ],
    );
    assert_eq!(s.ledger.available(ADA), amount("30"));
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    let posts = s.ledger.posts();
    assert_eq!(start(&d, &id, "20.0", &request), first);
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(requests(&d, 10), vec![first]);
}

#[test]
fn a_balance_that_moved_after_the_quote_keeps_the_request_refused_with_nothing_held() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    // The available read says 100, but the ledger holds only 50 and the ask is 60: the hold is what refuses.
    s.ledger.available_says(Some(amount("100")));
    let kept = start(&d, &id, "60", &uuid());
    s.ledger.available_says(None);
    matches(
        &kept,
        &[
            ("status", "refused"),
            ("refusalCode", "bank.cash_out_over_available"),
            ("payoutRef", "null"),
        ],
    );
    assert_eq!(s.ledger.available(ADA), amount("50"));
    assert_eq!(s.ledger.posts(), 1);
}

#[test]
fn while_the_owners_security_lock_holds_no_cash_out_starts_nothing_kept_nothing_held() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    s.lock.set(LOCKED);
    assert_eq!(
        mutate(&d, ADA, STEPPED, "cashOut.start", &ask(&uuid(), "20", &id)).refused(),
        "bank.security_locked"
    );
    s.lock.set(OPEN);
    assert!(requests(&d, 10).is_empty());
    assert_eq!(s.ledger.posts(), 1);
}

#[test]
fn with_no_partner_a_usable_account_is_still_kept_refused_on_the_missing_partner_with_nothing_held()
{
    let Some(s) = Suite::new() else { return };
    let id = s.usable(&s.sim());
    let kept = start(&s.door(None), &id, "5", &uuid());
    matches(
        &kept,
        &[
            ("status", "refused"),
            ("refusalCode", "bank.fiat_ramp_socket"),
        ],
    );
    assert_eq!(s.ledger.posts(), 1);
}

#[test]
fn a_request_left_before_its_hold_or_the_partner_is_driven_on_by_the_re_drive_job_once() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let request = s.left(&s.usable(&d), false);
    assert_eq!(redrive(&d, 10), vec![done(&request)]);
    assert_eq!(redrive(&d, 10), Vec::<Outcome>::new());
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    let payout = format!("TEST-PAYOUT-{request}");
    matches(
        &requests(&d, 1)[0],
        &[("status", "processing"), ("payoutRef", &payout)],
    );
}

// If it crashes partway.

#[test]
fn a_hold_the_ledger_booked_but_the_request_never_recorded_is_stamped_never_posted_twice() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let request = s.left(&s.usable(&d), true);
    let posts = s.ledger.posts();
    assert_eq!(redrive(&d, 10), vec![done(&request)]);
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    assert_eq!(s.ledger.available(ADA), amount("30"));
}

#[test]
fn while_the_owners_self_freeze_is_open_the_re_drive_holds_nothing_new_and_pays_nothing_lifted_it_carries_on()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let unheld = s.left(&s.usable(&d), false);
    let posts = s.ledger.posts();
    s.lock.set(SELF_FROZEN);
    assert_eq!(
        redrive(&d, 10),
        vec![not_done(&unheld, "bank.account_frozen_self")]
    );
    s.lock.set(OPEN);
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.held(ADA, &unheld), Amount::ZERO);
    assert_eq!(s.ledger.available(ADA), amount("50"));
    matches(
        &requests(&d, 1)[0],
        &[("status", "processing"), ("payoutRef", "null")],
    );
    assert_eq!(redrive(&d, 10), vec![done(&unheld)]);
    assert_eq!(s.ledger.held(ADA, &unheld), amount("20"));
}

#[test]
fn a_hold_booked_before_the_self_freeze_is_stamped_and_stays_held_and_the_partner_is_not_asked_to_pay()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let request = s.left(&s.usable(&d), true);
    let posts = s.ledger.posts();
    s.lock.set(SELF_FROZEN);
    assert_eq!(
        redrive(&d, 10),
        vec![not_done(&request, "bank.account_frozen_self")]
    );
    s.lock.set(OPEN);
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    matches(
        &requests(&d, 1)[0],
        &[("status", "processing"), ("payoutRef", "null")],
    );
}

#[test]
fn a_failed_payout_gives_back_a_hold_the_ledger_booked_but_the_request_never_recorded() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let request = s.left(&s.usable(&d), true);
    matches(
        &job_ok(failed(&d, &request, "bank.payout_rejected")),
        &[("status", "failed")],
    );
    assert_eq!(s.ledger.held(ADA, &request), Amount::ZERO);
    assert_eq!(s.ledger.available(ADA), amount("50"));
}

#[test]
fn with_nothing_held_and_no_partner_here_nothing_is_held_and_it_stays_processing_for_a_hold_that_may_yet_land()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let request = s.left(&s.usable(&d), false);
    let none = s.door(None);
    assert_eq!(
        redrive(&none, 10),
        vec![not_done(&request, "bank.cash_out_partner_gone")]
    );
    matches(
        &requests(&d, 1)[0],
        &[("status", "processing"), ("payoutRef", "null")],
    );
    assert_eq!(s.ledger.held(ADA, &request), Amount::ZERO);
    assert_eq!(s.ledger.available(ADA), amount("50"));
    // The hold lands late: the next drive with the partner back finds it and posts none again.
    s.ledger.post_ok(&hold(&request));
    let posts = s.ledger.posts();
    assert_eq!(redrive(&d, 10), vec![done(&request)]);
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
}

// The partner's answers.

#[test]
fn paid_the_hold_settles_to_the_payout_rail_once_and_the_receipt_is_signed_and_names_the_ledger_transaction()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    assert_eq!(
        receipt(&d, ADA, &request).refused(),
        "bank.cash_out_receipt_not_ready"
    );
    let done_ = job_ok(paid(&d, &request));
    assert_eq!(f(&done_, "status"), "completed");
    let tx = f(&done_, "ledgerTxId");
    assert_ne!(tx, "null");
    assert_eq!(job_ok(paid(&d, &request)), done_);
    assert_eq!(s.ledger.held(ADA, &request), Amount::ZERO);
    assert_eq!(s.ledger.available(ADA), amount("30"));
    assert_ne!(s.ledger.rail(), Amount::ZERO);
    // Nothing else can close it now.
    assert_eq!(
        job_refused(failed(&d, &request, "bank.payout_rejected")),
        "bank.ramp_conflict"
    );

    let r = receipt(&d, ADA, &request).ok();
    assert_eq!(f(&r, "fileName"), format!("receipt-{request}.txt"));
    assert_eq!(f(&r, "ledgerTxId"), tx);
    let text = f(&r, "text");
    assert!(text.contains(&format!("Ledger transaction: {tx}")));
    assert!(text.contains("Sent: 20 USDT"));
    assert!(text.contains("Arrives: 16.5 EUR"));
    assert!(text.contains("To: TEST Holder · GB82 •••• 5432"));
    assert_eq!(f(&r, "sha256"), sha256_hex(&text));
    let sig = f(&r, "signature");
    assert!(
        sig.len() == 64
            && sig
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    );
    assert_eq!(receipt(&d, ADA, &request).ok(), r);
    assert_eq!(
        receipt(&d, BOB, &request).refused(),
        "bank.cash_out_not_found"
    );
}

#[test]
fn failed_the_hold_comes_back_once_with_the_reason_and_the_cash_out_has_no_receipt() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "10", &request);
    let out = job_ok(failed(&d, &request, "bank.payout_account_closed"));
    matches(
        &out,
        &[
            ("status", "failed"),
            ("failureCode", "bank.payout_account_closed"),
            ("ledgerTxId", "null"),
        ],
    );
    assert_eq!(s.ledger.available(ADA), amount("50"));
    let posts = s.ledger.posts();
    assert_eq!(
        job_ok(failed(&d, &request, "bank.payout_account_closed")),
        out
    );
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(
        job_refused(failed(&d, &request, "bank.payout_rejected")),
        "bank.ramp_conflict"
    );
    assert_eq!(job_refused(paid(&d, &request)), "bank.ramp_conflict");
    assert_eq!(
        receipt(&d, ADA, &request).refused(),
        "bank.cash_out_receipt_not_ready"
    );
    assert_eq!(s.ledger.available(ADA), amount("50"));
}

#[test]
fn returned_in_part_what_came_back_is_credited_once_the_rest_stays_paid_out_and_the_receipt_still_stands()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    assert_eq!(
        job_refused(returned(&d, &request, "5", "USDT")),
        "bank.ramp_conflict"
    );
    job_ok(paid(&d, &request));
    assert_eq!(
        job_refused(returned(&d, &request, "20.1", "USDT")),
        "bank.ramp_invalid_amount"
    );
    let back = job_ok(returned(&d, &request, "5", "USDT"));
    matches(
        &back,
        &[
            ("status", "returned"),
            ("returnedAmount", "5"),
            ("remainsPaidOut", "15"),
            ("failureCode", "bank.payout_returned_by_bank"),
        ],
    );
    assert_eq!(s.ledger.available(ADA), amount("35"));
    let posts = s.ledger.posts();
    assert_eq!(job_ok(returned(&d, &request, "5.0", "USDT")), back);
    assert_eq!(
        job_refused(returned(&d, &request, "6", "USDT")),
        "bank.ramp_conflict"
    );
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.available(ADA), amount("35"));
    let text = f(&receipt(&d, ADA, &request).ok(), "text");
    assert!(text.contains("Status: returned"));
    assert!(text.contains("Sent: 20 USDT"));
    assert!(text.contains("Came back: 5 USDT (bank.payout_returned_by_bank)"));
    assert!(text.contains("Stays paid out: 15 USDT"));
}

#[test]
fn what_came_back_is_stated_in_the_asset_that_left_never_in_the_currency_paid_out() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    job_ok(paid(&d, &request));
    assert_eq!(
        job_refused(returned(&d, &request, "5", "EUR")),
        "bank.ramp_invalid_asset"
    );
    assert_eq!(s.ledger.available(ADA), amount("30"));
}

#[test]
fn with_no_partner_here_or_another_one_no_answer_moves_anything() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    let posts = s.ledger.posts();
    let none = s.door(None);
    assert_eq!(job_refused(paid(&none, &request)), "rail.bank");
    assert_eq!(
        job_refused(failed(&none, &request, "bank.payout_rejected")),
        "rail.bank"
    );
    let mut other_partner = sim(None);
    other_partner.rail = "another-partner".to_owned();
    assert_eq!(
        job_refused(paid(&s.door(Some(other_partner)), &request)),
        "rail.bank"
    );
    job_ok(paid(&d, &request));
    assert_eq!(
        job_refused(returned(&none, &request, "5", "USDT")),
        "rail.bank"
    );
    assert_eq!(s.ledger.posts(), posts + 1);
}

fn records(dir: &str) -> Vec<Json> {
    std::fs::read_to_string(format!("{dir}/payout-sim.jsonl"))
        .unwrap()
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| json::parse(l).unwrap())
        .collect()
}

#[test]
fn with_its_records_folder_the_stand_ins_own_word_on_its_rail_matches_the_payout_rail_boundary_a_failed_payout_records_nothing()
 {
    let Some(s) = Suite::new() else { return };
    let dir = records_dir();
    let d = s.door(Some(sim(Some(&dir))));
    let id = s.usable(&d);
    let (paid_out, not_paid) = (uuid(), uuid());
    start(&d, &id, "20", &paid_out);
    start(&d, &id, "4", &not_paid);
    job_ok(paid(&d, &paid_out));
    job_ok(paid(&d, &paid_out));
    job_ok(returned(&d, &paid_out, "5", "USDT"));
    job_ok(returned(&d, &paid_out, "5", "USDT"));
    job_ok(failed(&d, &not_paid, "bank.payout_rejected"));

    let lines = records(&dir);
    let seen: Vec<[String; 6]> = lines
        .iter()
        .map(|r| {
            [
                f(r, "label"),
                f(r, "key"),
                f(r, "direction"),
                f(r, "assetId"),
                f(r, "amount"),
                f(r, "ref"),
            ]
        })
        .collect();
    // The payout carries the stand-in's own reference for it; the return has none of its own.
    let w = cash_out::withdrawal_id(&paid_out);
    let row = |k: String, dir: &str, a: &str, r: String| {
        [
            "TEST".to_owned(),
            k,
            dir.to_owned(),
            "USDT".to_owned(),
            a.to_owned(),
            r,
        ]
    };
    assert_eq!(
        seen,
        vec![
            row(
                format!("{w}:paid"),
                "out",
                "20",
                format!("TEST-PAYOUT-{paid_out}")
            ),
            row(format!("{w}:returned"), "in", "5", "null".to_owned()),
        ]
    );
    // The rail's own total, in the ledger's signed form for its boundary (out positive, in negative), against the ledger.
    let said: Amount = lines
        .iter()
        .map(|r| {
            if f(r, "direction") == "in" {
                -amount(&f(r, "amount"))
            } else {
                amount(&f(r, "amount"))
            }
        })
        .sum();
    assert_eq!(format_amount(said), "15");
    assert_eq!(s.ledger.rail(), said);
}

#[test]
fn a_record_the_stand_in_cannot_write_stops_the_answer_before_anything_is_posted() {
    let Some(s) = Suite::new() else { return };
    let dir = records_dir();
    let d = s.door(Some(sim(Some(&dir))));
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "10", &request);
    // The rail already says otherwise about this payout: it would contradict itself, so nothing settles.
    std::fs::create_dir_all(&dir).unwrap();
    let line = Json::obj([
        ("label", Json::str("TEST")),
        ("rail", Json::str("payout-sim")),
        (
            "key",
            Json::str(format!("{}:paid", cash_out::withdrawal_id(&request))),
        ),
        ("direction", Json::str("out")),
        ("assetId", Json::str("USDT")),
        ("amount", Json::str("9")),
        ("at", Json::str(now().iso())),
    ]);
    std::fs::write(
        format!("{dir}/payout-sim.jsonl"),
        format!("{}\n", line.compact()),
    )
    .unwrap();
    let posts = s.ledger.posts();
    assert_eq!(job_refused(paid(&d, &request)), "bank.ramp_conflict");
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.held(ADA, &request), amount("10"));
    let mine = requests(&d, 10)
        .into_iter()
        .find(|r| f(r, "requestId") == request)
        .unwrap();
    assert_eq!(f(&mine, "status"), "processing");
}

#[test]
fn a_settle_that_failed_after_the_stand_in_recorded_paid_is_finished_by_saying_paid_again_never_by_saying_failed()
 {
    let Some(s) = Suite::new() else { return };
    let dir = records_dir();
    let d = s.door(Some(sim(Some(&dir))));
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    s.ledger.down(true);
    let (status, body) = paid(&d, &request);
    s.ledger.down(false);
    assert_eq!(
        (status, f(&body, "message")),
        (500, "TEST ledger unavailable".to_owned())
    );
    assert_eq!(
        job_refused(failed(&d, &request, "bank.payout_rejected")),
        "bank.ramp_conflict"
    );
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    assert_eq!(f(&job_ok(paid(&d, &request)), "status"), "completed");
    assert_eq!(records(&dir).len(), 1);
    assert_eq!(s.ledger.rail(), amount("20"));
}

#[test]
fn an_answer_for_no_cash_out_is_not_found() {
    let Some(s) = Suite::new() else { return };
    assert_eq!(
        job_refused(paid(&s.sim(), &uuid())),
        "bank.cash_out_not_found"
    );
}

// Partner-held: the partner bank holds the money and the ledger posts nothing.

#[test]
fn quotes_against_the_partner_balance_named_and_refuses_more_than_it_holds() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    partner_fund(&d, "cash-out-partner-fund-ada-2", "7");
    matches(
        &quote(&d, "20", &id).ok(),
        &[
            ("available", "57"),
            ("heldAt", LABEL),
            ("fee", "1.5"),
            ("receiveAmount", "16.5"),
            ("blocker", "null"),
        ],
    );
    assert_eq!(
        quote(&d, "58", &id).refused(),
        "bank.cash_out_over_available"
    );
}

#[test]
fn confirming_is_one_partner_move_under_the_order_key_the_same_client_reference_returns_the_first_order()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    let posts = s.ledger.posts();
    let request = uuid();
    let first = start(&d, &id, "20", &request);
    let payout = format!("TEST-PAYOUT-{request}");
    matches(
        &first,
        &[
            ("status", "processing"),
            ("heldAt", LABEL),
            ("ledgerTxId", "null"),
            ("payoutRef", &payout),
        ],
    );
    assert!(f(&first, "partnerMoveId").starts_with("test-partner-move-"));
    assert_eq!(at_partner(&d), "30");
    let payouts = d
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .report(&payouts_account("USDT"), now());
    assert_eq!(payouts.amount, Some(amount("20")));
    assert_eq!(start(&d, &id, "20", &request), first);
    assert_eq!(at_partner(&d), "30");
    assert_eq!(
        move_by_key(&d, &cash_out::move_key(&request)),
        Some(f(&first, "partnerMoveId"))
    );
    // The ledger posts nothing for it, and the customer's ledger balance is untouched.
    assert_eq!(s.ledger.posts(), posts);
    assert_eq!(s.ledger.available(ADA), amount("50"));
}

#[test]
fn a_partner_balance_that_moved_after_the_quote_keeps_the_request_refused_nothing_taken() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    drain(&d);
    drive_refused(&s, &d, &id, "0 minutes");
    assert_eq!(at_partner(&d), "5");
}

/// The owner's lock, open; the n-th read (the n-th driver's, just before its partner move) says it arrived, then waits
/// until the test lets that driver on.
struct Gated {
    calls: std::sync::atomic::AtomicUsize,
    reached: Mutex<mpsc::Sender<usize>>,
    open: Vec<Mutex<mpsc::Receiver<()>>>,
}

impl SecurityLock for Gated {
    fn read(&self, _user_id: &str) -> Result<LockState, Refusal> {
        let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.reached.lock().unwrap().send(n).unwrap();
        self.open[n].lock().unwrap().recv().unwrap();
        Ok(OPEN)
    }
}

// The request's session lock lives on one connection. If that connection drops while the body runs (a failover, a reset
// socket), Postgres frees the lock at once and the body carries on, on the pool's other connections. A replay of the
// same request then drives it at the same time. A partner refusal keeps nothing under its key, so the replay's move
// under that same key can be made after the first driver was refused.
#[test]
fn a_request_refused_while_its_lock_was_lost_never_leaves_the_money_taken_a_refused_request_took_nothing()
 {
    let Some(s) = Suite::new() else { return };
    let (reached_tx, reached) = mpsc::channel();
    let (go_a, wait_a) = mpsc::channel();
    let (go_b, wait_b) = mpsc::channel();
    let gated = Gated {
        calls: 0.into(),
        reached: Mutex::new(reached_tx),
        open: vec![Mutex::new(wait_a), Mutex::new(wait_b)],
    };
    // Room in the pool and the lock gate for two drivers at once, as two instances would have.
    let d = door(
        &s.db,
        &s.ledger,
        &s.lock,
        Setup {
            partner: Some(sim(None)),
            partner_bank: true,
            pool_max: 4,
            security_lock: Some(Box::new(gated)),
            ..Setup::default()
        },
    );
    custody(&d, "off");
    partner_fund(&d, "cash-out-partner-fund-ada", "50");
    let id = s.usable(&d);
    drain(&d);
    let request = priced(&s, &id);
    let drive = || mutate(&d, ADA, STEPPED, "cashOut.start", &ask(&request, "20", &id));
    std::thread::scope(|t| {
        // Driver A holds the request's lock and is about to ask the partner.
        let a = t.spawn(drive);
        assert_eq!(reached.recv(), Ok(0));
        // A's lock connection drops: Postgres frees the lock, and A's body carries on.
        let dropped = s.db.count(
            "SELECT count(pg_terminate_backend(pid)) FROM pg_locks WHERE locktype = 'advisory' AND granted \
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        assert_eq!(dropped, 1);
        // A replay of the same request takes the freed lock and finds it still processing.
        let b = t.spawn(drive);
        assert_eq!(reached.recv(), Ok(1));
        // A's move is refused for funds and recorded so; then the money arrives and the replay makes its move under
        // the same key.
        go_a.send(()).unwrap();
        drop(a.join().unwrap());
        partner_fund(&d, "cash-out-partner-fund-ada-3", "20");
        go_b.send(()).unwrap();
        drop(b.join().unwrap());
    });
    let row = s
        .db
        .client()
        .query_one(
            "SELECT status, partner_move_id FROM bank.cash_out_requests WHERE id = $1::text::uuid",
            &[&request],
        )
        .unwrap();
    let (status, recorded): (String, Option<String>) = (row.get(0), row.get(1));
    let moved = move_by_key(&d, &cash_out::move_key(&request));
    let found = (status, moved.is_some() && recorded == moved, at_partner(&d));
    // Either the request took the money and says so, or it was refused and the money is still the customer's.
    assert!(
        [
            ("processing".to_owned(), true, "5".to_owned()),
            ("refused".to_owned(), false, "25".to_owned()),
        ]
        .contains(&found),
        "{found:?}"
    );
}

#[test]
fn a_refused_request_whose_move_a_crashed_driver_made_anyway_the_re_drive_job_gives_it_back_once() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    drain(&d);
    let request = drive_refused(&s, &d, &id, "0 minutes");
    s.sql(
        "UPDATE bank.cash_out_requests SET drive_refused_at = now() WHERE id = $1::text::uuid",
        &request,
    );
    // The money arrives, and a driver that lost its lock makes its move under the order key, then crashes before
    // giving it back.
    stray_move(&d, &request, "cash-out-partner-fund-ada-4");
    assert_eq!(at_partner(&d), "5");
    // Not yet a minute old: the job leaves it for a later pass.
    assert_eq!(redrive(&d, 10), Vec::<Outcome>::new());
    s.sql(
        "UPDATE bank.cash_out_requests SET drive_refused_at = now() - interval '2 minutes' WHERE id = $1::text::uuid",
        &request,
    );
    assert_eq!(redrive(&d, 10), vec![done(&request)]);
    assert_eq!(at_partner(&d), "25");
    let back = move_by_key(&d, &cash_out::back_key(&request));
    let row = s
        .db
        .client()
        .query_one(
            "SELECT status, partner_back_move_id FROM bank.cash_out_requests WHERE id = $1::text::uuid",
            &[&request],
        )
        .unwrap();
    assert_eq!(
        (row.get::<_, String>(0), row.get::<_, Option<String>>(1)),
        ("refused".to_owned(), back)
    );
    // Once: the next pass finds nothing, and the balance stays.
    assert_eq!(redrive(&d, 10), Vec::<Outcome>::new());
    assert_eq!(at_partner(&d), "25");
}

#[test]
fn a_refused_request_with_no_move_under_its_key_the_re_drive_job_moves_nothing() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    drain(&d);
    let request = drive_refused(&s, &d, &id, "2 minutes");
    assert_eq!(redrive(&d, 10), Vec::<Outcome>::new());
    assert_eq!(move_by_key(&d, &cash_out::back_key(&request)), None);
    assert_eq!(at_partner(&d), "5");
}

#[test]
fn more_refusals_than_the_limit_do_not_crowd_a_stray_move_out_and_an_unmoved_one_is_not_re_asked_within_the_hour()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    drain(&d);
    let unmoved = [
        drive_refused(&s, &d, &id, "30 minutes"),
        drive_refused(&s, &d, &id, "20 minutes"),
        drive_refused(&s, &d, &id, "10 minutes"),
    ];
    let stray = drive_refused(&s, &d, &id, "40 minutes");
    stray_move(&d, &stray, "cash-out-partner-fund-ada-8697-1");
    assert_eq!(at_partner(&d), "5");
    // Oldest first: the stray one, then the oldest unmoved.
    assert_eq!(redrive(&d, 2), vec![done(&stray)]);
    assert_eq!(at_partner(&d), "25");
    // The next pass reads the two not yet checked; the one checked a moment ago is not asked again.
    let first_check = stray_checked(&s, &unmoved[0]);
    assert!(first_check.is_some());
    assert_eq!(redrive(&d, 2), Vec::<Outcome>::new());
    assert_eq!(redrive(&d, 2), Vec::<Outcome>::new());
    assert!(unmoved.iter().all(|u| stray_checked(&s, u).is_some()));
    assert_eq!(stray_checked(&s, &unmoved[0]), first_check);
    // An hour on, a refusal still under a day old is asked again: a stray move may yet land.
    s.sql(
        "UPDATE bank.cash_out_requests SET stray_checked_at = now() - interval '61 minutes' WHERE id = $1::text::uuid",
        &unmoved[0],
    );
    stray_move(&d, &unmoved[0], "cash-out-partner-fund-ada-8697-2");
    assert_eq!(redrive(&d, 2), vec![done(&unmoved[0])]);
    assert_eq!(at_partner(&d), "45");
}

#[test]
fn a_request_refused_more_than_a_day_ago_is_still_read_until_a_check_a_day_after_its_refusal_finds_no_move()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    drain(&d);
    // Created and refused three days ago (a re-drive job down that long, or an old request re-driven), never checked.
    let old = drive_refused(&s, &d, &id, "3 days");
    let settled = drive_refused(&s, &d, &id, "3 days");
    s.sql(
        "UPDATE bank.cash_out_requests SET stray_checked_at = now() - interval '2 days' WHERE id = $1::text::uuid",
        &settled,
    );
    stray_move(&d, &old, "cash-out-partner-fund-ada-8697-3");
    assert_eq!(redrive(&d, 10), vec![done(&old)]);
    assert_eq!(at_partner(&d), "25");
    assert!(move_by_key(&d, &cash_out::back_key(&old)).is_some());
    // Settled: one checked a day after its refusal with no move is never read again.
    let checked = stray_checked(&s, &settled);
    assert_eq!(redrive(&d, 10), Vec::<Outcome>::new());
    assert_eq!(stray_checked(&s, &settled), checked);
}

#[test]
fn paid_closes_it_with_no_ledger_post_the_receipt_names_the_partner_payout_and_its_signature_verifies()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    let request = uuid();
    let first = start(&d, &id, "20", &request);
    let move_id = f(&first, "partnerMoveId");
    let posts = s.ledger.posts();
    let done_ = job_ok(paid(&d, &request));
    matches(
        &done_,
        &[
            ("status", "completed"),
            ("ledgerTxId", "null"),
            ("partnerMoveId", &move_id),
            ("remainsPaidOut", "20"),
        ],
    );
    assert_eq!(job_ok(paid(&d, &request)), done_);
    assert_eq!(at_partner(&d), "30");
    assert_eq!(s.ledger.posts(), posts);
    let r = receipt(&d, ADA, &request).ok();
    matches(&r, &[("ledgerTxId", "null"), ("partnerMoveId", &move_id)]);
    let text = f(&r, "text");
    assert!(text.contains(&format!("Payout reference: TEST-PAYOUT-{request}")));
    assert!(text.contains(&format!("Partner payout: {move_id}")));
    assert!(text.contains(&format!("Held at: {LABEL}")));
    assert!(!text.contains("Ledger transaction"));
    let key = hkdf_sha256_32(RECEIPTS.as_bytes(), b"bank.cash-out.receipt.v1");
    let want: String = hmac_sha256(&key, text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(f(&r, "signature"), want);
    // Once paid there is nothing to cancel or fail.
    assert_eq!(
        job_refused(cancelled(&d, &request, "bank.payout_cancelled_by_bank")),
        "bank.ramp_conflict"
    );
    assert_eq!(
        job_refused(failed(&d, &request, "bank.payout_rejected")),
        "bank.ramp_conflict"
    );
    assert_eq!(at_partner(&d), "30");
}

#[test]
fn failed_and_cancelled_each_give_the_amount_back_to_the_partner_balance_once_however_often_the_partner_says_so()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    let (failing, cancelling) = (uuid(), uuid());
    start(&d, &id, "10", &failing);
    start(&d, &id, "15", &cancelling);
    assert_eq!(at_partner(&d), "25");
    let posts = s.ledger.posts();
    matches(
        &job_ok(failed(&d, &failing, "bank.payout_account_closed")),
        &[
            ("status", "failed"),
            ("failureCode", "bank.payout_account_closed"),
        ],
    );
    job_ok(failed(&d, &failing, "bank.payout_account_closed"));
    assert_eq!(at_partner(&d), "35");
    let c = job_ok(cancelled(&d, &cancelling, "bank.payout_cancelled_by_bank"));
    matches(
        &c,
        &[
            ("status", "cancelled"),
            ("failureCode", "bank.payout_cancelled_by_bank"),
        ],
    );
    assert_ne!(f(&c, "cancelledAt"), "null");
    assert_eq!(
        job_ok(cancelled(&d, &cancelling, "bank.payout_cancelled_by_bank")),
        c
    );
    assert_eq!(at_partner(&d), "50");
    assert_eq!(
        receipt(&d, ADA, &cancelling).refused(),
        "bank.cash_out_receipt_not_ready"
    );
    assert_eq!(job_refused(paid(&d, &cancelling)), "bank.ramp_conflict");
    assert_eq!(s.ledger.posts(), posts);
}

#[test]
fn a_return_credits_what_came_back_to_the_partner_balance_once_and_the_rest_stays_paid_out() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    job_ok(paid(&d, &request));
    let posts = s.ledger.posts();
    let back = job_ok(returned(&d, &request, "5", "USDT"));
    matches(
        &back,
        &[
            ("status", "returned"),
            ("returnedAmount", "5"),
            ("remainsPaidOut", "15"),
        ],
    );
    assert_eq!(job_ok(returned(&d, &request, "5", "USDT")), back);
    assert_eq!(at_partner(&d), "35");
    assert_eq!(s.ledger.posts(), posts);
    let text = f(&receipt(&d, ADA, &request).ok(), "text");
    assert!(text.contains("Stays paid out: 15 USDT"));
    assert!(text.contains("Partner return: test-partner-move-"));
}

#[test]
fn with_the_partner_gone_an_answer_for_a_partner_held_cash_out_refuses_and_nothing_moves() {
    let Some(s) = Suite::new() else { return };
    let d = s.held_at_partner();
    let id = s.usable(&d);
    let request = uuid();
    start(&d, &id, "20", &request);
    custody(&d, "on");
    assert_eq!(
        job_refused(failed(&d, &request, "bank.payout_rejected")),
        "bank.partner_unavailable"
    );
    custody(&d, "off");
    matches(&requests(&d, 10)[0], &[("status", "processing")]);
    assert_eq!(at_partner(&d), "30");
}

// The job doors themselves (`jobDoor` in `index.ts`).

#[test]
fn a_job_body_out_of_shape_is_400_before_any_work_and_the_re_drive_door_answers_its_counts() {
    let Some(s) = Suite::new() else { return };
    let d = s.sim();
    let shape = r#"{"error":"body not in shape","code":"bank.validation_failed"}"#;
    for (path, body) in [
        (
            "/internal/jobs/payout-sim/paid",
            r#"{"cashOutId":"not-a-uuid"}"#,
        ),
        (
            "/internal/jobs/payout-sim/paid",
            r#"{"cashOutId":"11111111-1111-4111-8111-111111111111","extra":1}"#,
        ),
        (
            "/internal/jobs/payout-sim/failed",
            r#"{"cashOutId":"11111111-1111-4111-8111-111111111111","reason":"bank.payout_returned_by_bank"}"#,
        ),
        (
            "/internal/jobs/payout-sim/returned",
            r#"{"cashOutId":"11111111-1111-4111-8111-111111111111","amount":"1e3","assetId":"USDT","reason":"bank.payout_returned_by_bank"}"#,
        ),
        ("/internal/jobs/redrive-cash-outs", r#"{"limit":0}"#),
        ("/internal/jobs/redrive-cash-outs", r#"{"limit":1.5}"#),
    ] {
        let (status, body) = job(&d, path, body);
        assert_eq!((status, body.compact()), (400, shape.to_owned()), "{path}");
    }
    let request = s.left(&s.usable(&d), false);
    let (status, body) = job(&d, "/internal/jobs/redrive-cash-outs", r#"{"limit":10}"#);
    assert_eq!(
        (status, body.compact()),
        (
            200,
            r#"{"scanned":1,"resolved":1,"stillUnknown":0}"#.to_owned()
        )
    );
    assert_eq!(s.ledger.held(ADA, &request), amount("20"));
    // No body is an empty one: every key is missing.
    let (status, _) = job(&d, "/internal/jobs/payout-sim/paid", "");
    assert_eq!(status, 400);
}
