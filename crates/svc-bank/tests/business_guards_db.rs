//! Slice `business`'s database guards and its approver read, against the Rust door on a real Postgres. Ports four
//! TypeScript files under `services/svc-bank/src/business/`, each test named after the TypeScript test's words:
//! `approved-checker-distinct.test.ts` (0029: an approved row needs a checker who is not the maker),
//! `approver-eligibility.db.test.ts` (svc-pay's approver check), `approval-asset-and-space.db.test.ts` (an approval keeps
//! the account's asset and changes space) and `business-create-race.db.test.ts` (racing creates of one account).
//! A direct call on `bank.business.*` is the Rust function in `svc_bank::business::service` with the door's own dependencies
//! (`Bank::deps`); the router's caller is a door call. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - `approved-checker-distinct` migrates the shared `TEST_DATABASE_URL` database itself and then re-applies 0029 so a stale
//!   function body is replaced. Here each test has its own freshly migrated database (`svc-bank migrate`); 0029 is still
//!   re-applied, as written. Each test still runs in one transaction that rolls back, with a savepoint per refused write.
//! - `approval-asset-and-space` shares one database across its tests (`beforeAll`); here each test has its own, with
//!   the same account inserted first.
//! - The racing creates are threads, each on its own door over the one database (its own connection pool), where the
//!   TypeScript races promises on one pool.
//! - The router's caller with `service: null` is a `/trpc` call signed by nobody; `svc-pay` and `svc-trade` are calls signed
//!   as that service. The tRPC code is read from `error.data.code`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use postgres::Transaction;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use svc_bank::business::policy::{self, Capability};
use svc_bank::business::service::{self as svc, Account, NewAccount};
use svc_bank::errors::Refusal;

use crate::business_kit::{Answer, Bank, Mount, amt, bank, call_as_service, door_over, uuid};

fn code<T: std::fmt::Debug>(r: &Result<T, Refusal>) -> String {
    match r {
        Ok(v) => format!("ok: {v:?}"),
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        Err(Refusal::Trpc(t)) => t.cause.clone().unwrap_or_else(|| t.code.to_owned()),
        Err(Refusal::Other(m)) => format!("other: {m}"),
    }
}

fn database_name(b: &Bank) -> String {
    url::Url::parse(&b.db.url)
        .unwrap()
        .path()
        .trim_start_matches('/')
        .to_owned()
}

fn sqlstate(e: &postgres::Error) -> String {
    e.code()
        .map_or_else(|| format!("no sqlstate: {e}"), |c| c.code().to_owned())
}

// ---------------------------------------------------------------------------------------------------------------
// approved-checker-distinct.test.ts: an approved business transfer needs a checker who is not the maker

const THRESHOLD: &str = "100";
const OVER: &str = "100";
const ABOVE: &str = "101";
const UNDER: &str = "99.5";
const MAKER: &str = "l1126-maker";
const CHECKER: &str = "l1126-checker";
const CHECK_VIOLATION: &str = "23514";
const ABSENT_CHECKERS: [(&str, &str); 7] = [
    ("tab", "\t"),
    ("newline", "\n"),
    ("cr", "\r"),
    ("form feed", "\u{0C}"),
    ("vertical tab", "\u{0B}"),
    ("nbsp", "\u{A0}"),
    ("spaces around a tab", " \t "),
];
const MAKER_SHAPED_CHECKERS: [(&str, &str); 8] = [
    ("trailing space", "l1126-maker "),
    ("trailing tab", "l1126-maker\t"),
    ("trailing newline", "l1126-maker\n"),
    ("trailing cr", "l1126-maker\r"),
    ("trailing form feed", "l1126-maker\u{0C}"),
    ("trailing vertical tab", "l1126-maker\u{0B}"),
    ("trailing nbsp", "l1126-maker\u{A0}"),
    ("pads around the maker", " \tl1126-maker\u{A0}"),
];

/// The suite's `beforeAll`: a migrated database, with 0029 re-applied as the TypeScript does.
fn checker_bank() -> Option<Bank> {
    let b = bank()?;
    b.sql()
        .batch_execute(include_str!(
            "../migrations/0029_business_approved_checker_distinct.sql"
        ))
        .unwrap();
    Some(b)
}

fn open_account(tx: &mut Transaction<'_>) -> String {
    tx.query_one(
        "INSERT INTO bank.business_accounts (name, asset_id, spend_threshold) \
         VALUES ($1, $2, $3::text::numeric) RETURNING id::text AS id",
        &[&"l1126-account", &"USDT", &THRESHOLD],
    )
    .unwrap()
    .get(0)
}

fn try_insert_approval(
    tx: &mut Transaction<'_>,
    account_id: &str,
    amount: &str,
    status: &str,
    checker: Option<&str>,
) -> Result<String, postgres::Error> {
    tx.query_one(
        "INSERT INTO bank.business_approvals \
           (account_id, maker_user_id, checker_user_id, from_space_id, to_space_id, asset_id, amount, status) \
         VALUES ($1::text::uuid, $2, $3, gen_random_uuid(), gen_random_uuid(), $4, $5::text::numeric, \
           $6::text::bank.business_approval_status) \
         RETURNING id::text AS id",
        &[&account_id, &MAKER, &checker, &"USDT", &amount, &status],
    )
    .map(|r| r.get(0))
}

fn insert_approval(
    tx: &mut Transaction<'_>,
    account_id: &str,
    amount: &str,
    status: &str,
    checker: Option<&str>,
) -> String {
    try_insert_approval(tx, account_id, amount, status, checker).unwrap()
}

/// `refused`: the write in a savepoint that rolls back; its SQLSTATE, or `stored` when it was not refused.
fn refused(
    tx: &mut Transaction<'_>,
    write: impl FnOnce(&mut Transaction<'_>) -> Result<(), postgres::Error>,
) -> String {
    let mut sp = tx.transaction().unwrap();
    let out = write(&mut sp);
    drop(sp);
    match out {
        Ok(()) => "stored".to_owned(),
        Err(e) => sqlstate(&e),
    }
}

fn refused_insert(
    tx: &mut Transaction<'_>,
    account_id: &str,
    amount: &str,
    status: &str,
    checker: Option<&str>,
) -> String {
    refused(tx, |sp| {
        try_insert_approval(sp, account_id, amount, status, checker).map(|_| ())
    })
}

/// Approves a pending row: `checker` set when given, else left as it is.
fn refused_approve(tx: &mut Transaction<'_>, id: &str, checker: Option<&str>) -> String {
    refused(tx, |sp| {
        match checker {
            Some(c) => sp.execute(
                "UPDATE bank.business_approvals SET status = 'approved', checker_user_id = $1, decided_at = now() \
                 WHERE id = $2::text::uuid",
                &[&c, &id],
            ),
            None => sp.execute(
                "UPDATE bank.business_approvals SET status = 'approved', decided_at = now() \
                 WHERE id = $1::text::uuid",
                &[&id],
            ),
        }
        .map(|_| ())
    })
}

fn status_of(tx: &mut Transaction<'_>, id: &str) -> (String, Option<String>) {
    let r = tx
        .query_one(
            "SELECT status::text AS status, checker_user_id FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    (r.get(0), r.get(1))
}

fn st(status: &str, checker: Option<&str>) -> (String, Option<String>) {
    (status.to_owned(), checker.map(str::to_owned))
}

#[test]
fn refuses_self_approved_and_checkerless_over_threshold_approvals_keeps_the_under_threshold_post() {
    let Some(b) = checker_bank() else { return };
    let mut c = b.sql();
    let mut tx = c.transaction().unwrap();
    let account_id = open_account(&mut tx);

    assert_eq!(
        refused_insert(&mut tx, &account_id, OVER, "approved", None),
        CHECK_VIOLATION,
        "an approved over-threshold row with no checker is refused"
    );
    assert_eq!(
        refused_insert(&mut tx, &account_id, OVER, "approved", Some(MAKER)),
        CHECK_VIOLATION,
        "an approved row whose checker is the maker is refused"
    );
    assert_eq!(
        refused_insert(&mut tx, &account_id, UNDER, "approved", Some(MAKER)),
        CHECK_VIOLATION,
        "self-approval is refused below the threshold too"
    );

    let pending_id = insert_approval(&mut tx, &account_id, OVER, "pending", None);
    assert_eq!(
        refused_approve(&mut tx, &pending_id, Some(MAKER)),
        CHECK_VIOLATION,
        "approving a pending row as the maker is refused"
    );
    assert_eq!(
        refused_approve(&mut tx, &pending_id, None),
        CHECK_VIOLATION,
        "approving a pending over-threshold row with no checker is refused"
    );
    assert_eq!(status_of(&mut tx, &pending_id), st("pending", None));

    tx.execute(
        "UPDATE bank.business_approvals SET status = 'approved', checker_user_id = $1, decided_at = now() \
         WHERE id = $2::text::uuid",
        &[&CHECKER, &pending_id],
    )
    .unwrap();
    assert_eq!(
        status_of(&mut tx, &pending_id),
        st("approved", Some(CHECKER))
    );

    let under_id = insert_approval(&mut tx, &account_id, UNDER, "approved", None);
    assert_eq!(status_of(&mut tx, &under_id), st("approved", None));

    let cancel_id = insert_approval(&mut tx, &account_id, OVER, "pending", None);
    tx.execute(
        "UPDATE bank.business_approvals SET status = 'cancelled', checker_user_id = $1, decided_at = now() \
         WHERE id = $2::text::uuid",
        &[&MAKER, &cancel_id],
    )
    .unwrap();
    assert_eq!(status_of(&mut tx, &cancel_id), st("cancelled", Some(MAKER)));

    tx.rollback().unwrap();
}

#[test]
fn treats_a_blank_or_whitespace_only_checker_as_absent_on_an_over_threshold_approval() {
    let Some(b) = checker_bank() else { return };
    let mut c = b.sql();
    let mut tx = c.transaction().unwrap();
    let account_id = open_account(&mut tx);

    assert_eq!(
        refused_insert(&mut tx, &account_id, OVER, "approved", Some("")),
        CHECK_VIOLATION,
        "an approved row at the threshold with a blank checker is refused"
    );
    assert_eq!(
        refused_insert(&mut tx, &account_id, ABOVE, "approved", Some(" ")),
        CHECK_VIOLATION,
        "an approved row over the threshold with a whitespace checker is refused"
    );

    let pending_at = insert_approval(&mut tx, &account_id, OVER, "pending", None);
    assert_eq!(
        refused_approve(&mut tx, &pending_at, Some("")),
        CHECK_VIOLATION,
        "approving a pending row at the threshold with a blank checker is refused"
    );
    assert_eq!(status_of(&mut tx, &pending_at), st("pending", None));

    let pending_above = insert_approval(&mut tx, &account_id, ABOVE, "pending", None);
    assert_eq!(
        refused_approve(&mut tx, &pending_above, Some(" ")),
        CHECK_VIOLATION,
        "approving a pending row over the threshold with a whitespace checker is refused"
    );
    assert_eq!(status_of(&mut tx, &pending_above), st("pending", None));

    let under_blank = insert_approval(&mut tx, &account_id, UNDER, "approved", Some(""));
    assert_eq!(status_of(&mut tx, &under_blank), st("approved", Some("")));
    let under_spaces = insert_approval(&mut tx, &account_id, UNDER, "approved", Some(" "));
    assert_eq!(status_of(&mut tx, &under_spaces), st("approved", Some(" ")));

    let pending_blank = insert_approval(&mut tx, &account_id, ABOVE, "pending", Some(""));
    assert_eq!(status_of(&mut tx, &pending_blank), st("pending", Some("")));
    let rejected_spaces = insert_approval(&mut tx, &account_id, ABOVE, "rejected", Some(" "));
    assert_eq!(
        status_of(&mut tx, &rejected_spaces),
        st("rejected", Some(" "))
    );
    let cancelled_blank = insert_approval(&mut tx, &account_id, ABOVE, "cancelled", Some(""));
    assert_eq!(
        status_of(&mut tx, &cancelled_blank),
        st("cancelled", Some(""))
    );

    tx.rollback().unwrap();
}

#[test]
fn refuses_a_pad_only_checker_at_or_above_the_spend_threshold_and_stores_one_below_it() {
    let Some(b) = checker_bank() else { return };
    let mut c = b.sql();
    let mut tx = c.transaction().unwrap();
    let account_id = open_account(&mut tx);
    for (label, checker) in ABSENT_CHECKERS {
        assert_eq!(
            refused_insert(&mut tx, &account_id, OVER, "approved", Some(checker)),
            CHECK_VIOLATION,
            "an approved row at the threshold with a {label} checker is refused"
        );
        assert_eq!(
            refused_insert(&mut tx, &account_id, ABOVE, "approved", Some(checker)),
            CHECK_VIOLATION,
            "an approved row over the threshold with a {label} checker is refused"
        );

        let pending_id = insert_approval(&mut tx, &account_id, OVER, "pending", None);
        assert_eq!(
            refused_approve(&mut tx, &pending_id, Some(checker)),
            CHECK_VIOLATION,
            "approving a pending row at the threshold with a {label} checker is refused"
        );
        assert_eq!(status_of(&mut tx, &pending_id), st("pending", None));

        let under_id = insert_approval(&mut tx, &account_id, UNDER, "approved", Some(checker));
        assert_eq!(status_of(&mut tx, &under_id), st("approved", Some(checker)));
    }
    tx.rollback().unwrap();
}

#[test]
fn refuses_a_checker_that_trims_to_the_maker_at_any_amount() {
    let Some(b) = checker_bank() else { return };
    let mut c = b.sql();
    let mut tx = c.transaction().unwrap();
    let account_id = open_account(&mut tx);
    for (label, checker) in MAKER_SHAPED_CHECKERS {
        assert_eq!(
            refused_insert(&mut tx, &account_id, UNDER, "approved", Some(checker)),
            CHECK_VIOLATION,
            "an approved row below the threshold whose checker is the maker with {label} is refused"
        );
        assert_eq!(
            refused_insert(&mut tx, &account_id, OVER, "approved", Some(checker)),
            CHECK_VIOLATION,
            "an approved row at the threshold whose checker is the maker with {label} is refused"
        );

        let pending_id = insert_approval(&mut tx, &account_id, UNDER, "pending", None);
        assert_eq!(
            refused_approve(&mut tx, &pending_id, Some(checker)),
            CHECK_VIOLATION,
            "approving a pending row as the maker with {label} is refused"
        );
        assert_eq!(status_of(&mut tx, &pending_id), st("pending", None));
    }
    tx.rollback().unwrap();
}

#[test]
fn stores_an_exact_different_checker_at_the_threshold_and_leaves_other_statuses_unconstrained() {
    let Some(b) = checker_bank() else { return };
    let mut c = b.sql();
    let mut tx = c.transaction().unwrap();
    let account_id = open_account(&mut tx);
    let at_id = insert_approval(&mut tx, &account_id, OVER, "approved", Some(CHECKER));
    assert_eq!(status_of(&mut tx, &at_id), st("approved", Some(CHECKER)));
    let above_id = insert_approval(&mut tx, &account_id, ABOVE, "approved", Some(CHECKER));
    assert_eq!(status_of(&mut tx, &above_id), st("approved", Some(CHECKER)));

    let pending_tab = insert_approval(&mut tx, &account_id, OVER, "pending", Some("\t"));
    assert_eq!(status_of(&mut tx, &pending_tab), st("pending", Some("\t")));
    let rejected_nbsp = insert_approval(&mut tx, &account_id, ABOVE, "rejected", Some("\u{A0}"));
    assert_eq!(
        status_of(&mut tx, &rejected_nbsp),
        st("rejected", Some("\u{A0}"))
    );
    let maker_padded = format!("{MAKER} ");
    let cancelled_maker =
        insert_approval(&mut tx, &account_id, OVER, "cancelled", Some(&maker_padded));
    assert_eq!(
        status_of(&mut tx, &cancelled_maker),
        st("cancelled", Some(&maker_padded))
    );
    let pending_wrapped = insert_approval(&mut tx, &account_id, ABOVE, "pending", Some(" \t "));
    assert_eq!(
        status_of(&mut tx, &pending_wrapped),
        st("pending", Some(" \t "))
    );

    tx.rollback().unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// approver-eligibility.db.test.ts: approver eligibility

const ADMIN: &str = "11111111-1111-4111-8111-111111111111";

fn uid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn open(b: &Bank, creator: &str) -> Account {
    let id = uuid();
    b.deps(|d| {
        svc::create_account(
            d,
            &NewAccount {
                account_id: &id,
                name: "Team Co",
                asset_id: "USDT",
                spend_threshold: amt("100"),
                creator_user_id: creator,
            },
        )
    })
    .unwrap()
}

fn eligibility(b: &Bank, account_id: &str, user_id: &str) -> String {
    b.deps(|d| svc::approver_eligibility(d, account_id, user_id))
        .unwrap()
        .compact()
}

#[test]
fn answers_for_every_role_exactly_as_the_capability_table_says() {
    let Some(b) = bank() else { return };
    let account = open(&b, ADMIN);
    let roles: Vec<&str> = policy::ROLES
        .iter()
        .copied()
        .filter(|r| *r != "admin")
        .collect();
    for (i, role) in roles.iter().enumerate() {
        b.deps(|d| svc::add_member(d, &account.id, ADMIN, &uid(i + 1), role))
            .unwrap();
    }
    for (i, role) in roles.iter().enumerate() {
        let answer = eligibility(&b, &account.id, &uid(i + 1));
        let want = if policy::role_can(role, Capability::Approve) {
            format!(r#"{{"state":"eligible","role":"{role}"}}"#)
        } else {
            format!(r#"{{"state":"role_cannot_approve","role":"{role}"}}"#)
        };
        assert_eq!(answer, want, "{role}");
    }
    assert_eq!(
        eligibility(&b, &account.id, ADMIN),
        r#"{"state":"eligible","role":"admin"}"#
    );
}

#[test]
fn refuses_someone_who_is_not_on_the_team_an_unknown_account_and_a_closed_one() {
    let Some(b) = bank() else { return };
    let account = open(&b, ADMIN);
    assert_eq!(
        eligibility(&b, &account.id, &uid(99)),
        r#"{"state":"not_a_member"}"#
    );
    assert_eq!(
        eligibility(&b, &uuid(), ADMIN),
        r#"{"state":"no_such_account"}"#
    );
    b.sql()
        .execute(
            "UPDATE bank.business_accounts SET status = 'closed' WHERE id = $1::text::uuid",
            &[&account.id],
        )
        .unwrap();
    assert_eq!(
        eligibility(&b, &account.id, ADMIN),
        r#"{"state":"account_closed"}"#
    );
}

/// A `/trpc` call signed by no service and no person.
fn call_unsigned(b: &Bank, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    let url = format!("/trpc/{path}");
    let res = b.door.handle(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: &body,
    });
    Answer(res.status, json::parse(&res.body).unwrap_or(Json::Null))
}

#[test]
fn serves_svc_pay_only_another_service_is_forbidden_and_no_service_is_unauthorized() {
    let Some(b) = bank() else { return };
    let account = open(&b, ADMIN);
    let input = Json::obj([
        ("accountId", Json::str(account.id.clone())),
        ("userId", Json::str(ADMIN)),
    ]);
    let pay = call_as_service(&b, "svc-pay", "business.approverEligibility", &input);
    assert_eq!(pay.ok().compact(), r#"{"state":"eligible","role":"admin"}"#);
    let trade = call_as_service(&b, "svc-trade", "business.approverEligibility", &input);
    assert_eq!(trade.trpc(), "FORBIDDEN", "{}", trade.1.compact());
    let none = call_unsigned(&b, "business.approverEligibility", &input);
    assert_eq!(none.trpc(), "UNAUTHORIZED", "{}", none.1.compact());
}

// ---------------------------------------------------------------------------------------------------------------
// approval-asset-and-space.db.test.ts: a business approval keeps the account asset and changes space

const ASSET: &str = "USDT";
const OTHER_ASSET: &str = "BTC";
const L1127_THRESHOLD: &str = "1";
const AMOUNT: &str = "1";
const FROM_SPACE: &str = "11111111-1111-4111-8111-111111111111";
const TO_SPACE: &str = "22222222-2222-4222-8222-222222222222";
const FK_VIOLATION: &str = "23503";

/// The suite's `beforeAll`: the account the approvals name.
fn l1127_account(b: &Bank) -> String {
    b.sql()
        .query_one(
            "INSERT INTO bank.business_accounts (name, asset_id, spend_threshold) \
             VALUES ($1, $2, $3::text::numeric) RETURNING id::text AS id",
            &[&"l1127", &ASSET, &L1127_THRESHOLD],
        )
        .unwrap()
        .get(0)
}

/// `insertApproval`: the ids returned, or the SQLSTATE.
fn l1127_insert(
    b: &Bank,
    account_id: &str,
    asset_id: &str,
    from_space_id: &str,
    to_space_id: &str,
) -> Result<Vec<String>, String> {
    b.sql()
        .query(
            "INSERT INTO bank.business_approvals \
               (account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status) \
             VALUES ($1::text::uuid, $2, $3::text::uuid, $4::text::uuid, $5, $6::text::numeric, \
               $7::text::bank.business_approval_status) \
             RETURNING id::text AS id",
            &[
                &account_id,
                &"l1127-maker",
                &from_space_id,
                &to_space_id,
                &asset_id,
                &AMOUNT,
                &"pending",
            ],
        )
        .map(|rows| rows.iter().map(|r| r.get(0)).collect())
        .map_err(|e| sqlstate(&e))
}

#[test]
fn runs_in_the_per_run_bank_database_not_the_admin_database() {
    let Some(b) = bank() else { return };
    let _ = l1127_account(&b);
    let name = database_name(&b);
    assert!(
        name.starts_with("itf_run_bank_") && name.ends_with("_test"),
        "{name}"
    );
    assert_ne!(name, "intafaced_test");
    assert_ne!(name, "postgres");
    let current: String = b
        .sql()
        .query_one("SELECT current_database() AS name", &[])
        .unwrap()
        .get(0);
    assert_eq!(current, name);
}

#[test]
fn refuses_an_approval_whose_asset_is_not_the_account_asset() {
    let Some(b) = bank() else { return };
    let account = l1127_account(&b);
    assert_eq!(
        l1127_insert(&b, &account, OTHER_ASSET, FROM_SPACE, TO_SPACE),
        Err(FK_VIOLATION.to_owned())
    );
}

#[test]
fn refuses_an_approval_that_stays_in_one_space() {
    let Some(b) = bank() else { return };
    let account = l1127_account(&b);
    assert_eq!(
        l1127_insert(&b, &account, ASSET, FROM_SPACE, FROM_SPACE),
        Err(CHECK_VIOLATION.to_owned())
    );
}

#[test]
fn inserts_an_approval_for_the_account_asset_across_two_spaces() {
    let Some(b) = bank() else { return };
    let account = l1127_account(&b);
    let rows = l1127_insert(&b, &account, ASSET, FROM_SPACE, TO_SPACE).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// business-create-race.db.test.ts: creating one business account twice at once

const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const ROUNDS: usize = 40;
const AT_ONCE: usize = 8;

/// `n` doors over the bank's database and stand-ins, each with its own pool.
fn doors(b: &Bank, n: usize) -> Vec<svc_bank::door::BankDoor> {
    (0..n)
        .map(|_| {
            door_over(
                &b.db,
                &b.ledger,
                &b.people,
                &b.identity,
                &b.approvals,
                &Mount::default(),
            )
        })
        .collect()
}

fn create_on(
    door: &svc_bank::door::BankDoor,
    account_id: &str,
    asset_id: &str,
) -> Result<Account, Refusal> {
    door.transfers_deps(|d| {
        svc::create_account(
            d,
            &NewAccount {
                account_id,
                name: "Race Co",
                asset_id,
                spend_threshold: amt("100"),
                creator_user_id: OWNER,
            },
        )
    })
}

#[test]
fn every_racing_create_returns_the_one_account_that_won_with_one_admin_member() {
    let Some(b) = bank() else { return };
    let racers = doors(&b, AT_ONCE);
    let mut failures: Vec<String> = Vec::new();
    for _round in 0..ROUNDS {
        let account_id = uuid();
        let results: Vec<Result<Account, Refusal>> = std::thread::scope(|scope| {
            let handles: Vec<_> = racers
                .iter()
                .map(|door| {
                    let id = account_id.as_str();
                    scope.spawn(move || create_on(door, id, "USDT"))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for result in &results {
            match result {
                Err(_) => failures.push(code(result)),
                Ok(a) => assert_eq!(a.id, account_id),
            }
        }
        let mut c = b.sql();
        let accounts = c
            .query(
                "SELECT id FROM bank.business_accounts WHERE id = $1::text::uuid",
                &[&account_id],
            )
            .unwrap();
        let members: Vec<(String, String)> = c
            .query(
                "SELECT user_id, role::text FROM bank.business_members WHERE account_id = $1::text::uuid",
                &[&account_id],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect();
        assert_eq!(accounts.len(), 1);
        assert_eq!(members, vec![(OWNER.to_owned(), "admin".to_owned())]);
    }
    assert_eq!(failures, Vec::<String>::new());
}

#[test]
fn a_racing_create_on_different_terms_is_still_refused_as_bank_business_conflict() {
    let Some(b) = bank() else { return };
    let racers = doors(&b, 2);
    let account_id = uuid();
    let results: Vec<Result<Account, Refusal>> = std::thread::scope(|scope| {
        let id = account_id.as_str();
        let first = scope.spawn(|| create_on(&racers[0], id, "USDT"));
        let second = scope.spawn(|| create_on(&racers[1], id, "USDC"));
        vec![first.join().unwrap(), second.join().unwrap()]
    });
    let won = results.iter().filter(|r| r.is_ok()).count();
    let lost: Vec<String> = results.iter().filter(|r| r.is_err()).map(code).collect();
    assert_eq!(won, 1);
    assert_eq!(lost, vec!["bank.business_conflict".to_owned()]);
}
