//! Slice `partner`'s database checks against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! `partner/partner-moves.db.test.ts`, `partner/partner-stops.db.test.ts` and `test-age-door.test.ts` that fall on this
//! slice's own calls, each test named after the TypeScript test's words. The TypeScript drives the freeze, the stop and
//! the desk's count through `transfers.create`, whose slice is not ported; these drive the same guard through
//! `testPartner.spend`, the slice's own partner move, and read the partner's book through its loopback record door.
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading, NotWired};
use svc_bank::partner::router::Wiring;

use support::TestDb;

const SECRET: &str = "a-bank-partner-db-edge-secret-long-enough-0";
const INTERNAL: &str = "a-bank-partner-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const INVITE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// svc-ledger's freeze as a test sets it.
#[derive(Clone)]
enum Reading {
    Read(bool, Option<&'static str>),
    Unreadable,
    NotWired,
}

#[derive(Clone)]
struct Set(Arc<Mutex<Reading>>);

impl Set {
    fn to(&self, r: Reading) {
        *self.0.lock().unwrap() = r;
    }
}

impl Freeze for Set {
    fn read(&self) -> Result<FreezeReading, String> {
        match self.0.lock().unwrap().clone() {
            Reading::Read(posting_enabled, cause) => Ok(FreezeReading {
                posting_enabled,
                cause: cause.map(str::to_owned),
            }),
            Reading::Unreadable => Err("svc-ledger /health did not answer".to_owned()),
            Reading::NotWired => NotWired.read(),
        }
    }
}

struct Bank {
    door: BankDoor,
    freeze: Set,
}

fn bank(db: &TestDb, age_open: bool) -> Bank {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let freeze = Set(Arc::new(Mutex::new(Reading::Read(true, None))));
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(Wiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(freeze.clone()),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_test_age(age_open);
    Bank { door, freeze }
}

fn person(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![Json::str("bank:read"), Json::str("bank:write")]),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "GB").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "GB".to_owned()),
    ]
}

fn send(
    b: &Bank,
    method: &str,
    url: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.door.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-partner-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(b: &Bank, user: &str, path: &str, input: &str) -> (u16, Json) {
    send(b, "POST", &format!("/trpc/{path}"), input, person(user))
}

/// The refusal's own code (`cause.code`), or `ok`.
fn code(answer: &(u16, Json)) -> String {
    let cause = answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("cause"))
        .and_then(|c| c.get("code"));
    match (answer.0, cause) {
        (200, _) => "ok".to_owned(),
        (_, Some(Json::String(c))) => c.clone(),
        (status, _) => panic!("no refusal code: {status} {}", answer.1.compact()),
    }
}

/// A person held at the TEST partner with TEST 100 EUR in their main balance.
fn partner_held(b: &Bank, user: &str) {
    assert_eq!(
        mutate(b, user, "testPartner.set", r#"{"custody":"off"}"#).0,
        200
    );
    let fund = format!(r#"{{"fundId":"fund-{user}","assetId":"EUR","amount":"100"}}"#);
    assert_eq!(mutate(b, user, "testPartner.fund", &fund).0, 200);
}

fn spend(b: &Bank, user: &str, id: &str, amount: &str) -> String {
    let input =
        format!(r#"{{"spendId":"{id}","assetId":"EUR","amount":"{amount}","kind":"payment"}}"#);
    code(&mutate(b, user, "testPartner.spend", &input))
}

/// The partner's own book on loopback: the person's moves and their EUR balance.
fn book(b: &Bank, user: &str) -> (usize, String) {
    let account = format!(r#"{{"account":{{"venueId":"test-partner-bank","owner":"{user}"}}}}"#);
    let (status, moves) = send(b, "POST", "/test-partner/moves", &account, Vec::new());
    assert_eq!(status, 200);
    let Some(Json::Array(moves)) = moves.get("value") else {
        panic!("moves")
    };
    let (_, balances) = send(b, "POST", "/test-partner/balances", &account, Vec::new());
    let Some(Json::Array(rows)) = balances.get("value") else {
        panic!("balances")
    };
    let eur = rows
        .iter()
        .find(|r| r.get("asset") == Some(&Json::str("EUR")))
        .and_then(|r| r.get("total"))
        .map_or_else(|| "none".to_owned(), Json::compact);
    (moves.len(), eur)
}

fn stop(db: &TestDb, partner: &str, kinds: &[&str]) {
    let kinds: Vec<String> = kinds.iter().map(|k| (*k).to_owned()).collect();
    db.client()
        .execute(
            "INSERT INTO bank.partner_stops (partner_id, stopped_kinds, revision, reason, approved_by) \
             VALUES ($1, $2, 1, 'TEST wrong instructions seen', 'approver-2') \
             ON CONFLICT (partner_id) DO UPDATE SET stopped_kinds = EXCLUDED.stopped_kinds",
            &[&partner, &kinds],
        )
        .unwrap();
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

#[test]
fn test_partner_spend_obeys_the_posting_freeze_and_refuses_a_person_with_no_money_at_the_partner() {
    let Some(db) = db() else { return };
    let b = bank(&db, false);
    partner_held(&b, ADA);
    for state in [
        Reading::Read(false, Some("person")),
        Reading::Unreadable,
        Reading::NotWired,
    ] {
        b.freeze.to(state);
        assert_eq!(
            spend(&b, ADA, "spend-frozen-1", "30"),
            "bank.posting_frozen"
        );
    }
    b.freeze.to(Reading::Read(true, None));
    // The partner moved nothing while frozen; the fund is its only move.
    assert_eq!(book(&b, ADA), (1, "\"100\"".to_owned()));
    assert_eq!(spend(&b, ADA, "spend-frozen-1", "30"), "ok");
    assert_eq!(book(&b, ADA), (2, "\"70\"".to_owned()));
    assert_eq!(spend(&b, BOB, "spend-none-1", "30"), "bank.no_partner_bank");
}

#[test]
fn the_operators_partner_stop_refuses_a_partner_move_while_posting_is_enabled_moving_nothing_lifted_the_same_move_is_made_once()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, false);
    partner_held(&b, ADA);
    stop(&db, "test-partner", &["card_capture", "bank_move"]);
    assert_eq!(spend(&b, ADA, "move-stopped", "20"), "bank.partner_stopped");
    assert_eq!(book(&b, ADA), (1, "\"100\"".to_owned()));
    // Another partner's row stops nothing here; another kind stopped alone leaves bank moves open.
    stop(&db, "test-partner", &[]);
    stop(&db, "other-partner", &["bank_move"]);
    stop(&db, "test-partner", &["card_hold"]);
    assert_eq!(spend(&b, ADA, "move-stopped", "20"), "ok");
    assert_eq!(spend(&b, ADA, "move-stopped", "20"), "ok");
    assert_eq!(book(&b, ADA), (2, "\"80\"".to_owned()));
    // Lifting the stop never lifts the freeze.
    b.freeze.to(Reading::Read(false, Some("person")));
    assert_eq!(
        spend(&b, ADA, "move-stopped-frozen", "5"),
        "bank.posting_frozen"
    );
    // A stop that cannot be read refuses by name, before the freeze is asked.
    db.client()
        .batch_execute("ALTER TABLE bank.partner_stops RENAME TO partner_stops_moved")
        .unwrap();
    b.freeze.to(Reading::Read(true, None));
    let unreadable = spend(&b, ADA, "move-stop-unreadable", "5");
    db.client()
        .batch_execute("ALTER TABLE bank.partner_stops_moved RENAME TO partner_stops")
        .unwrap();
    assert_eq!(unreadable, "bank.partner_stop_unreadable");
    assert_eq!(book(&b, ADA), (2, "\"80\"".to_owned()));
}

#[test]
fn the_desk_counts_each_refused_move_by_what_refused_it_and_why_the_freeze_names_its_cause_and_the_stop_is_counted_apart()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, false);
    partner_held(&b, ADA);
    for (state, id) in [
        (Reading::Read(false, Some("mismatch")), "count-mismatch"),
        (Reading::Read(false, Some("person")), "count-person"),
        (Reading::Unreadable, "count-unreadable"),
        (Reading::Read(false, None), "count-not-reported"),
        (Reading::NotWired, "count-unwired"),
    ] {
        b.freeze.to(state);
        assert_eq!(spend(&b, ADA, id, "1"), "bank.posting_frozen", "{id}");
    }
    b.freeze.to(Reading::Read(true, None));
    stop(&db, "test-partner", &["bank_move"]);
    assert_eq!(spend(&b, ADA, "count-stopped", "1"), "bank.partner_stopped");
    assert_eq!(
        spend(&b, ADA, "count-stopped-again", "1"),
        "bank.partner_stopped"
    );
    assert_eq!(book(&b, ADA), (1, "\"100\"".to_owned()));
    let rows: Vec<(String, String, String, String, i64)> = db
        .client()
        .query(
            "SELECT refused_by, cause, kind, to_char(day, 'YYYY-MM-DD'), count FROM bank.partner_refusal_counts \
             ORDER BY refused_by, cause, kind",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4)))
        .collect();
    let today: String = db
        .client()
        .query_one(
            "SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')",
            &[],
        )
        .unwrap()
        .get(0);
    let want = [
        ("partner_stop", "stopped", 2),
        ("posting_freeze", "mismatch", 1),
        ("posting_freeze", "not_reported", 1),
        ("posting_freeze", "not_wired", 1),
        ("posting_freeze", "person", 1),
        ("posting_freeze", "unreadable", 1),
    ];
    assert_eq!(
        rows,
        want.iter()
            .map(|(by, cause, n)| (
                (*by).to_owned(),
                (*cause).to_owned(),
                "bank_move".to_owned(),
                today.clone(),
                *n
            ))
            .collect::<Vec<_>>()
    );
}

#[test]
fn a_refusal_the_desk_cannot_count_is_still_refused_and_nothing_moves() {
    let Some(db) = db() else { return };
    let b = bank(&db, false);
    partner_held(&b, ADA);
    db.client()
        .batch_execute(
            "ALTER TABLE bank.partner_refusal_counts RENAME TO partner_refusal_counts_moved",
        )
        .unwrap();
    b.freeze.to(Reading::Read(false, Some("person")));
    let frozen = spend(&b, ADA, "count-dropped", "1");
    b.freeze.to(Reading::Read(true, None));
    stop(&db, "test-partner", &["bank_move"]);
    let stopped = spend(&b, ADA, "count-dropped", "1");
    db.client()
        .batch_execute(
            "ALTER TABLE bank.partner_refusal_counts_moved RENAME TO partner_refusal_counts",
        )
        .unwrap();
    assert_eq!(
        (frozen.as_str(), stopped.as_str()),
        ("bank.posting_frozen", "bank.partner_stopped")
    );
    assert_eq!(book(&b, ADA), (1, "\"100\"".to_owned()));
}

/// The open business invite the age door may age, made at a known time.
fn invite(db: &TestDb) {
    let mut c = db.client();
    c.batch_execute(
        "INSERT INTO bank.business_accounts (id, name, asset_id, spend_threshold) \
         VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'TEST Ada Ltd', 'EUR', 1000)",
    )
    .unwrap();
    c.execute(
        "INSERT INTO bank.business_invites (id, account_id, kind, token_hash, role, invited_by, created_at, expires_at) \
         VALUES ($1::text::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'link', 'age-token-hash', 'admin', $2, \
                 '2026-11-22T10:00:00Z', '2026-11-29T10:00:00Z')",
        &[&INVITE, &ADA],
    )
    .unwrap();
}

fn invite_times(db: &TestDb) -> (String, String) {
    let r = db
        .client()
        .query_one(
            "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                    to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
               FROM bank.business_invites WHERE id = $1::text::uuid",
            &[&INVITE],
        )
        .unwrap();
    (r.get(0), r.get(1))
}

fn age(b: &Bank, body: &str, headers: Vec<(String, String)>) -> (u16, Json) {
    send(b, "POST", "/internal/test/age", body, headers)
}

fn signed(service: &str, body: &str) -> Vec<(String, String)> {
    s2s::legacy_headers(service, INTERNAL, body, system_seconds()).unwrap()
}

#[test]
fn closed_not_a_test_stack_a_signed_call_is_refused_by_name_and_ages_nothing() {
    let Some(db) = db() else { return };
    invite(&db);
    let b = bank(&db, false);
    let body = format!(r#"{{"subject":"business-invite","id":"{INVITE}","ms":125000}}"#);
    let (status, answer) = age(&b, &body, signed("local-test-stack", &body));
    assert_eq!(status, 403);
    assert_eq!(
        answer.get("error"),
        Some(&Json::str("test_age.door_closed"))
    );
    assert_eq!(
        invite_times(&db),
        (
            "2026-11-22T10:00:00.000Z".to_owned(),
            "2026-11-29T10:00:00.000Z".to_owned()
        )
    );
}

#[test]
fn open_ages_the_named_invite_once_unsigned_a_v1_signature_edited_after_signing_or_svc_edge_ages_nothing()
 {
    let Some(db) = db() else { return };
    invite(&db);
    let b = bank(&db, true);
    let body = format!(r#"{{"subject":"business-invite","id":"{INVITE}","ms":125000}}"#);
    let v1: Vec<(String, String)> = signed("local-test-stack", &body)
        .into_iter()
        .filter(|(k, _)| k != "x-intafaced-service-body")
        .collect();
    let edited = signed("local-test-stack", &body.replace("125000", "1"));
    for (why, headers) in [
        ("unsigned", Vec::new()),
        ("a v1 signature", v1),
        ("edited after signing", edited),
        ("svc-edge", signed("svc-edge", &body)),
    ] {
        assert_eq!(age(&b, &body, headers).0, 401, "{why}");
    }
    assert_eq!(
        invite_times(&db),
        (
            "2026-11-22T10:00:00.000Z".to_owned(),
            "2026-11-29T10:00:00.000Z".to_owned()
        )
    );
    let (status, answer) = age(&b, &body, signed("local-test-stack", &body));
    assert_eq!(status, 200);
    let want = format!(
        r#"{{"ok":true,"subject":"business-invite","id":"{INVITE}","agedMs":125000,"createdAt":"2026-11-22T09:57:55.000Z","expiresAt":"2026-11-29T09:57:55.000Z"}}"#
    );
    assert_eq!(answer.compact(), want);
    assert_eq!(
        invite_times(&db),
        (
            "2026-11-22T09:57:55.000Z".to_owned(),
            "2026-11-29T09:57:55.000Z".to_owned()
        )
    );
    // An invite this door may not age under that subject, and a subject it does not age, age nothing.
    let pot = body.replace("business-invite", "shared-pot-invite");
    assert_eq!(age(&b, &pot, signed("local-test-stack", &pot)).0, 404);
    let loan = body.replace("business-invite", "loan");
    let (status, answer) = age(&b, &loan, signed("local-test-stack", &loan));
    assert_eq!(
        (status, answer.get("error")),
        (400, Some(&Json::str("test_age.invalid")))
    );
    assert_eq!(
        invite_times(&db),
        (
            "2026-11-22T09:57:55.000Z".to_owned(),
            "2026-11-29T09:57:55.000Z".to_owned()
        )
    );
}
