//! Cash out to a linked bank account against the Rust door on a real Postgres, with no payout partner: the checks of the
//! TypeScript's `cash-out/cash-out.db.test.ts`, each test named after its words. Funds are a TEST deposit on a ledger held
//! in memory. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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

    fn door(&self, cooling: Option<&'static str>) -> BankDoor {
        door(
            &self.db,
            &self.ledger,
            &self.lock,
            Setup {
                cooling,
                ..Setup::default()
            },
        )
    }

    fn linked(&self, d: &BankDoor, user: &str) -> String {
        let input = r#"{"label":"TEST salary account","holderName":"TEST Holder","iban":"GB82WEST12345698765432"}"#;
        let a = mutate(d, user, STEPPED, "linkedAccounts.link", input).ok();
        f(a.get("account").unwrap(), "accountId")
    }

    fn verify(&self, id: &str, hours_ago: i32) {
        self.db
            .client()
            .execute(
                "UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = now(), \
                 created_at = now() - make_interval(hours => $2) WHERE id = $1::text::uuid",
                &[&id, &hours_ago],
            )
            .unwrap();
    }

    fn nothing_moved(&self) {
        assert_eq!(self.ledger.posts(), 1);
    }

    fn requests_kept(&self) -> i64 {
        self.db.count("SELECT count(*) FROM bank.cash_out_requests")
    }
}

fn ask(request: &str, asset: &str, amount: &str, account: &str) -> String {
    Json::obj([
        ("requestId", Json::str(request)),
        ("assetId", Json::str(asset)),
        ("amount", Json::str(amount)),
        ("linkedAccountId", Json::str(account)),
    ])
    .compact()
}

fn quote(d: &BankDoor, user: &str, asset: &str, amount: &str, account: &str) -> Answer {
    let input = Json::obj([
        ("assetId", Json::str(asset)),
        ("amount", Json::str(amount)),
        ("linkedAccountId", Json::str(account)),
    ])
    .compact();
    query(d, user, STEPPED, "cashOut.quote", Some(&input))
}

fn start(d: &BankDoor, user: &str, scopes: &[&str], input: &str) -> Answer {
    mutate(d, user, scopes, "cashOut.start", input)
}

fn requests(d: &BankDoor, user: &str) -> Json {
    query(
        d,
        user,
        STEPPED,
        "cashOut.requests",
        Some(r#"{"limit":10}"#),
    )
    .ok()
}

#[test]
fn an_unverified_account_the_amount_the_available_balance_no_fee_invented_and_the_account_as_the_reason()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    let q = quote(&d, ADA, "usdt", "20", &id).ok();
    matches(
        &q,
        &[
            ("assetId", "USDT"),
            ("amount", "20"),
            ("available", "50"),
            ("rail", "rail.bank"),
            ("fee", "null"),
            ("receiveAmount", "null"),
            ("blocker", "bank.linked_account_unverified"),
        ],
    );
    matches(
        q.get("account").unwrap(),
        &[
            ("accountId", &id),
            ("state", "unverified"),
            ("ibanMasked", "GB82 •••• 5432"),
        ],
    );
    s.nothing_moved();
}

#[test]
fn refuses_a_zero_or_malformed_amount_and_more_than_the_available_balance_before_reading_the_account()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    for amount in ["0", "0.000"] {
        assert_eq!(
            quote(&d, ADA, "USDT", amount, &id).both(),
            (
                "BAD_REQUEST".to_owned(),
                "bank.ramp_invalid_amount".to_owned()
            )
        );
    }
    assert_eq!(quote(&d, ADA, "USDT", "1e3", &id).both().0, "BAD_REQUEST");
    assert_eq!(
        quote(&d, ADA, "USDT", "50.000000000000000001", &id).both(),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.cash_out_over_available".to_owned()
        )
    );
    // Exactly the balance is allowed.
    assert_eq!(f(&quote(&d, ADA, "USDT", "50", &id).ok(), "amount"), "50");
}

#[test]
fn someone_elses_account_a_removed_one_or_none_is_not_found() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let bobs = s.linked(&d, BOB);
    assert_eq!(
        quote(&d, ADA, "USDT", "1", &bobs).both(),
        (
            "NOT_FOUND".to_owned(),
            "bank.linked_account_not_found".to_owned()
        )
    );
    let id = s.linked(&d, ADA);
    mutate(
        &d,
        ADA,
        STEPPED,
        "linkedAccounts.remove",
        &format!(r#"{{"accountId":"{id}"}}"#),
    )
    .ok();
    assert_eq!(
        quote(&d, ADA, "USDT", "1", &id).refused(),
        "bank.linked_account_not_found"
    );
    assert_eq!(
        quote(&d, ADA, "USDT", "1", &uuid()).refused(),
        "bank.linked_account_not_found"
    );
}

#[test]
fn a_verified_account_names_its_cooling_off_first_blank_then_active_with_the_end_and_after_it_the_missing_partner()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    s.verify(&id, 0);
    assert_eq!(
        f(
            &quote(&s.door(Some("")), ADA, "USDT", "5", &id).ok(),
            "blocker"
        ),
        "bank.offramp_cooling_unset"
    );
    let inside = quote(&d, ADA, "USDT", "5", &id).ok();
    assert_eq!(f(&inside, "blocker"), "bank.offramp_cooling_active");
    assert_ne!(
        f(inside.get("account").unwrap(), "coolingOffEndsAt"),
        "null"
    );
    s.verify(&id, 25);
    assert_eq!(
        f(&quote(&d, ADA, "USDT", "5", &id).ok(), "blocker"),
        "bank.fiat_ramp_socket"
    );
    s.nothing_moved();
}

#[test]
fn needs_the_step_up_scope_a_plain_session_is_refused_and_nothing_is_kept() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    assert_eq!(
        start(&d, ADA, PLAIN, &ask(&uuid(), "USDT", "20", &id))
            .both()
            .0,
        "FORBIDDEN"
    );
    assert_eq!(s.requests_kept(), 0);
    s.nothing_moved();
}

#[test]
fn is_kept_refused_with_the_first_reason_nothing_held_or_posted_and_the_same_id_is_the_same_request()
 {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    let request = uuid();
    let first = start(&d, ADA, STEPPED, &ask(&request, "USDT", "20", &id)).ok();
    matches(
        &first,
        &[
            ("requestId", &request),
            ("assetId", "USDT"),
            ("amount", "20"),
            ("linkedAccountId", &id),
            ("rail", "rail.bank"),
            ("status", "refused"),
            ("refusalCode", "bank.linked_account_unverified"),
        ],
    );
    assert_eq!(
        start(&d, ADA, STEPPED, &ask(&request, "USDT", "20.0", &id)).ok(),
        first
    );
    assert_eq!(requests(&d, ADA), Json::Array(vec![first]));
    s.nothing_moved();
    assert_eq!(s.ledger.available(ADA), amount("50"));
}

#[test]
fn a_usable_account_still_ends_on_the_missing_partner_with_nothing_held() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    s.verify(&id, 25);
    let kept = start(&d, ADA, STEPPED, &ask(&uuid(), "USDT", "5", &id)).ok();
    assert_eq!(f(&kept, "refusalCode"), "bank.fiat_ramp_socket");
    s.nothing_moved();
}

#[test]
fn the_same_id_on_other_terms_or_from_someone_else_is_a_conflict_and_changes_nothing() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    let request = uuid();
    start(&d, ADA, STEPPED, &ask(&request, "USDT", "20", &id)).ok();
    assert_eq!(
        start(&d, ADA, STEPPED, &ask(&request, "USDT", "21", &id)).refused(),
        "bank.ramp_conflict"
    );
    let bobs = s.linked(&d, BOB);
    assert_eq!(
        start(&d, BOB, STEPPED, &ask(&request, "USDT", "20", &bobs)).refused(),
        "bank.ramp_conflict"
    );
    assert_eq!(requests(&d, BOB), Json::Array(Vec::new()));
    assert_eq!(s.requests_kept(), 1);
}

#[test]
fn an_entry_check_that_fails_keeps_nothing() {
    let Some(s) = Suite::new() else { return };
    let d = s.door(Some("24"));
    let id = s.linked(&d, ADA);
    assert_eq!(
        start(&d, ADA, STEPPED, &ask(&uuid(), "USDT", "51", &id)).refused(),
        "bank.cash_out_over_available"
    );
    assert_eq!(s.requests_kept(), 0);
}
