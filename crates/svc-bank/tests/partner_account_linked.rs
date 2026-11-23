//! Linked bank accounts against the Rust door on a real Postgres: the checks of the TypeScript's
//! `linked-accounts/linked-accounts.db.test.ts`, each test named after its words. Without `TEST_DATABASE_URL` each test
//! skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::partner_account_kit::*;
use crate::support;
use service_kit::json::Json;
use support::TestDb;
use svc_bank::door::BankDoor;
use svc_bank::partner_account::linked_accounts::{mask_iban, normalize_iban};

fn setup(cap: Option<&'static str>, cooling: Option<&'static str>) -> Setup {
    Setup {
        cap,
        cooling,
        ..Setup::default()
    }
}

struct Suite {
    db: TestDb,
    ledger: MemLedger,
    lock: Lock,
}

impl Suite {
    fn new() -> Option<Suite> {
        Some(Suite {
            db: db()?,
            ledger: MemLedger::default(),
            lock: Lock::default(),
        })
    }

    /// `as(user, scopes, owner)`'s door: the owner's cap and cooling-off.
    fn door(&self, cap: Option<&'static str>, cooling: Option<&'static str>) -> BankDoor {
        door(&self.db, &self.ledger, &self.lock, setup(cap, cooling))
    }

    fn rows(&self, user: &str) -> Vec<postgres::Row> {
        self.db
            .client()
            .query(
                "SELECT iban, state, verified_at IS NULL, removed_at IS NULL, \
                 (floor(extract(epoch FROM created_at) * 1000))::int8 \
                 FROM bank.linked_bank_accounts WHERE user_id = $1 ORDER BY created_at",
                &[&user],
            )
            .unwrap()
    }
}

fn link_input(label: &str, holder: &str, iban: &str) -> String {
    Json::obj([
        ("label", Json::str(label)),
        ("holderName", Json::str(holder)),
        ("iban", Json::str(iban)),
    ])
    .compact()
}

fn ada(iban: &str) -> String {
    link_input("TEST salary account", "Ada Lovelace", iban)
}

fn link(d: &BankDoor, user: &str, input: &str) -> Answer {
    mutate(d, user, STEPPED, "linkedAccounts.link", input)
}

fn list(d: &BankDoor, user: &str) -> Json {
    query(d, user, STEPPED, "linkedAccounts.list", None).ok()
}

fn accounts(d: &BankDoor, user: &str) -> Vec<Json> {
    match list(d, user).get("accounts") {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("{other:?}"),
    }
}

fn remove(d: &BankDoor, user: &str, scopes: &[&str], id: &str) -> Answer {
    mutate(
        d,
        user,
        scopes,
        "linkedAccounts.remove",
        &format!(r#"{{"accountId":"{id}"}}"#),
    )
}

fn account_of(a: &Json) -> Json {
    a.get("account").cloned().unwrap()
}

#[test]
fn lists_nothing_before_an_account_is_linked() {
    let Some(s) = Suite::new() else { return };
    assert_eq!(
        list(&s.door(Some("10"), Some("24")), ADA).compact(),
        r#"{"accounts":[]}"#
    );
}

#[test]
fn links_an_account_as_unverified_listed_with_its_state_never_usable_and_the_full_iban_never_sent_back()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let answer = link(&d, ADA, &ada("gb82 west 1234 5698 7654 32")).ok();
    assert_eq!(f(&answer, "created"), "true");
    let account = account_of(&answer);
    matches(
        &account,
        &[
            ("label", "TEST salary account"),
            ("holderName", "Ada Lovelace"),
            ("ibanMasked", "GB82 •••• 5432"),
            ("country", "GB"),
            ("state", "unverified"),
            ("usable", "false"),
            ("blocker", "bank.linked_account_unverified"),
            ("verificationRail", "rail.bank"),
        ],
    );
    let stored = s.rows(ADA);
    assert_eq!(stored.len(), 1);
    let (iban, state, unverified, kept): (String, String, bool, bool) = (
        stored[0].get(0),
        stored[0].get(1),
        stored[0].get(2),
        stored[0].get(3),
    );
    assert_eq!(
        (iban.as_str(), state.as_str(), unverified, kept),
        (GB, "unverified", true, true)
    );
    let created: i64 = stored[0].get(4);
    assert_eq!(
        f(&account, "coolingOffEndsAt"),
        service_kit::time::Instant(created + 24 * 3_600_000).iso()
    );
    let listed = list(&d, ADA);
    assert_eq!(
        listed.compact(),
        Json::obj([("accounts", Json::Array(vec![account]))]).compact()
    );
    assert!(!listed.compact().contains("WEST1234"));
    // Only the suite's own funding is on the ledger: linking posts nothing.
    assert_eq!(s.ledger.posts(), 0);
}

#[test]
fn linking_the_same_iban_again_returns_the_same_account_unchanged_and_links_nothing_twice() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let first = link(&d, ADA, &ada(GB)).ok();
    let again = link(
        &d,
        ADA,
        &link_input("TEST other name", "Ada Lovelace", &GB.to_lowercase()),
    )
    .ok();
    assert_eq!(
        again.compact(),
        Json::obj([
            ("account", account_of(&first)),
            ("created", Json::Bool(false))
        ])
        .compact()
    );
    assert_eq!(s.rows(ADA).len(), 1);
}

#[test]
fn refuses_an_iban_that_fails_its_check_digits_and_a_blank_name_keeping_nothing() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let want = (
        "BAD_REQUEST".to_owned(),
        "bank.linked_account_invalid".to_owned(),
    );
    assert_eq!(link(&d, ADA, &ada("GB82WEST12345698765433")).both(), want);
    assert_eq!(
        link(&d, ADA, &link_input("TEST salary account", "   ", GB)).both(),
        want
    );
    assert!(s.rows(ADA).is_empty());
}

#[test]
fn needs_the_step_up_scope_to_link_or_remove_a_plain_session_is_refused_and_nothing_changes() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    assert_eq!(
        mutate(&d, ADA, PLAIN, "linkedAccounts.link", &ada(GB))
            .both()
            .0,
        "FORBIDDEN"
    );
    assert!(s.rows(ADA).is_empty());
    let account = account_of(&link(&d, ADA, &ada(GB)).ok());
    assert_eq!(
        remove(&d, ADA, PLAIN, &f(&account, "accountId")).both().0,
        "FORBIDDEN"
    );
    assert_eq!(
        query(&d, ADA, PLAIN, "linkedAccounts.list", None)
            .ok()
            .compact(),
        Json::obj([("accounts", Json::Array(vec![account]))]).compact()
    );
}

#[test]
fn holds_the_owners_cap_and_a_blank_cap_refuses_rather_than_inventing_one() {
    let Some(s) = Suite::new() else { return };
    let capped = s.door(Some("2"), Some("24"));
    link(&capped, ADA, &ada(GB)).ok();
    link(&capped, ADA, &ada(DE)).ok();
    assert_eq!(
        link(&capped, ADA, &ada(NL)).both(),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.linked_accounts_full".to_owned()
        )
    );
    // At the cap, linking one already linked still answers with it.
    assert_eq!(f(&link(&capped, ADA, &ada(GB)).ok(), "created"), "false");
    let blank = s.door(Some(" "), Some("24"));
    assert_eq!(
        link(&blank, BOB, &ada(GB)).both(),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.address_book_cap_unset".to_owned()
        )
    );
    assert!(s.rows(BOB).is_empty());
}

#[test]
fn two_links_racing_at_the_last_free_place_one_is_linked_and_the_other_is_refused_full() {
    let Some(s) = Suite::new() else { return };
    let capped = s.door(Some("1"), Some("24"));
    let results: Vec<Answer> = std::thread::scope(|t| {
        let a = t.spawn(|| link(&capped, ADA, &ada(GB)));
        let b = t.spawn(|| link(&capped, ADA, &ada(DE)));
        vec![a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Answer::Ok(_)))
            .count(),
        1
    );
    let lost = results
        .into_iter()
        .find(|r| !matches!(r, Answer::Ok(_)))
        .unwrap();
    assert_eq!(lost.refused(), "bank.linked_accounts_full");
    assert_eq!(s.rows(ADA).len(), 1);
}

fn verify_now(s: &Suite, id: &str) {
    s.db.client()
        .execute(
            "UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = now() WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
}

#[test]
fn names_the_cooling_off_for_a_verified_account_blank_window_inside_the_window_and_usable_once_it_ends()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let id = f(&account_of(&link(&d, ADA, &ada(GB)).ok()), "accountId");
    verify_now(&s, &id);
    let blank = accounts(&s.door(Some("10"), None), ADA).remove(0);
    matches(
        &blank,
        &[
            ("state", "verified"),
            ("verificationRail", "null"),
            ("usable", "false"),
            ("blocker", "bank.offramp_cooling_unset"),
            ("coolingOffEndsAt", "null"),
        ],
    );
    matches(
        &accounts(&d, ADA)[0],
        &[
            ("usable", "false"),
            ("blocker", "bank.offramp_cooling_active"),
        ],
    );
    matches(
        &accounts(&s.door(Some("10"), Some("0")), ADA)[0],
        &[("usable", "true"), ("blocker", "null")],
    );
    s.db.client()
        .execute(
            "UPDATE bank.linked_bank_accounts SET created_at = now() - interval '25 hours' WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    matches(
        &accounts(&d, ADA)[0],
        &[("usable", "true"), ("blocker", "null")],
    );
}

#[test]
fn a_window_too_large_for_a_date_reads_as_unset_the_list_still_answers_and_the_account_is_not_usable()
 {
    let Some(s) = Suite::new() else { return };
    let id = f(
        &account_of(&link(&s.door(Some("10"), Some("24")), ADA, &ada(GB)).ok()),
        "accountId",
    );
    verify_now(&s, &id);
    for hours in ["2500000000", "99999999999"] {
        matches(
            &accounts(&s.door(Some("10"), Some(hours)), ADA)[0],
            &[
                ("usable", "false"),
                ("blocker", "bank.offramp_cooling_unset"),
                ("coolingOffEndsAt", "null"),
            ],
        );
    }
}

#[test]
fn an_unverified_account_stays_unusable_whatever_the_cooling_off_says() {
    let Some(s) = Suite::new() else { return };
    let account = account_of(&link(&s.door(Some("10"), Some("0")), ADA, &ada(GB)).ok());
    matches(
        &account,
        &[
            ("usable", "false"),
            ("blocker", "bank.linked_account_unverified"),
        ],
    );
}

#[test]
fn removes_once_answers_the_same_again_and_linking_it_later_is_a_new_account_with_a_new_window() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let id = f(&account_of(&link(&d, ADA, &ada(GB)).ok()), "accountId");
    let removed = format!(r#"{{"accountId":"{id}","removed":true}}"#);
    assert_eq!(remove(&d, ADA, STEPPED, &id).ok().compact(), removed);
    assert_eq!(remove(&d, ADA, STEPPED, &id).ok().compact(), removed);
    assert_eq!(list(&d, ADA).compact(), r#"{"accounts":[]}"#);
    let again = link(&d, ADA, &ada(GB)).ok();
    assert_eq!(f(&again, "created"), "true");
    assert_ne!(f(&account_of(&again), "accountId"), id);
    assert_eq!(s.rows(ADA).len(), 2);
}

#[test]
fn each_customer_sees_and_removes_only_their_own_accounts() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("10"), Some("24"));
    let id = f(&account_of(&link(&d, ADA, &ada(GB)).ok()), "accountId");
    assert_eq!(list(&d, BOB).compact(), r#"{"accounts":[]}"#);
    assert_eq!(
        remove(&d, BOB, STEPPED, &id).both(),
        (
            "NOT_FOUND".to_owned(),
            "bank.linked_account_not_found".to_owned()
        )
    );
    assert_eq!(accounts(&d, ADA).len(), 1);
    // Bob may link the same IBAN: the business key is per customer.
    assert_eq!(f(&link(&d, BOB, &ada(GB)).ok(), "created"), "true");
}

#[test]
fn normalises_and_masks_an_iban_and_refuses_a_bad_shape() {
    assert_eq!(normalize_iban(" nl91 abna 0417 1643 00 ").unwrap(), NL);
    assert_eq!(mask_iban(DE), "DE89 •••• 3000");
    let Err(svc_bank::errors::Refusal::Bank(e)) =
        normalize_iban("0x0000000000000000000000000000000000000000")
    else {
        panic!("a bad shape is refused")
    };
    assert!(e.message.contains("IBAN"));
}
