//! `ops.customerPartnerBalances` (J-derivatives-26 #8) against the Rust door on a real Postgres, as the TypeScript's
//! `ops/customer-partner-balances.db.test.ts` drives the router: the founder console reads one customer's partner-held
//! spending balances with `admin:read`, each the figure the customer's own `spaces.list` shows, with the partner's label
//! as its source and its as-of time; a stale figure says so and one the partner has not reported refuses by name; a
//! person no partner holds answers `heldByPartner: false` with no ledger figure read; nothing is written.
//!
//! Not ported, with the reason: the audit line's words and a log sink that throws are the process's stdout, which a test
//! of the door cannot capture or break (as `ops_desk_db`'s head says for `customerBalances`); the line is written before
//! any read by `balances::partner_audit`, on the path these tests drive. Without `TEST_DATABASE_URL` each test skips;
//! with `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::money::Amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, HistoryPage, HistoryRequest, Ledger, LedgerAccount, LedgerBalance, Lookup,
    Lookups,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::Wiring as TransfersWiring;

use support::TestDb;

const SECRET: &str = "a-bank-ops-partner-balances-edge-secret-long";
const INTERNAL: &str = "a-bank-ops-partner-balances-internal-secret";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "88888888-8888-4888-8888-888888888888";
const PATH: &str = "ops.customerPartnerBalances";

/// svc-ledger, counting every read: the desk's partner-held read must never ask it.
#[derive(Clone, Default)]
struct Book(Arc<Mutex<usize>>);

impl Book {
    fn reads(&self) -> usize {
        *self.0.lock().unwrap()
    }
}

impl Ledger for Book {
    fn balance(&self, _account: &LedgerAccount) -> Result<Amount, String> {
        *self.0.lock().unwrap() += 1;
        Ok(Amount::ZERO)
    }
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        *self.0.lock().unwrap() += 1;
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn history_page(&self, _r: &HistoryRequest<'_>) -> Result<HistoryPage, String> {
        *self.0.lock().unwrap() += 1;
        Ok(HistoryPage {
            entries: Vec::new(),
            next_cursor: None,
        })
    }
}

struct NoPeople;

impl Directory for NoPeople {
    fn handles_of(&self, _ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, _q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok(None)
    }
}

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
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
    .with_partner(PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
        },
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: None,
            currencies: None,
            plans: None,
            fees: None,
            dormancy: None,
        },
    })
    .with_transfers(TransfersWiring::none());
    Some(Bank { door, db, ledger })
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// One call through the door: the status and the body.
fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &str) -> (u16, Json) {
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    let headers = person(user, scopes);
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-ops-partner-balances",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn ok(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

fn data(answer: &(u16, Json), k: &str) -> String {
    match answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get(k))
    {
        Some(Json::String(c)) => c.clone(),
        Some(Json::Object(_)) if k == "cause" => match answer
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => format!("no cause: {}", answer.1.compact()),
        },
        _ => format!("{} {}", answer.0, answer.1.compact()),
    }
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(v) => v.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

const OWNER: &[&str] = &["bank:read", "bank:write"];
const DESK: &[&str] = &["admin:read"];

fn who(user: &str) -> String {
    format!(r#"{{"userId":"{user}"}}"#)
}

/// A person held at the TEST partner with TEST 100 USDT in their main balance and a named space "Trip TEST"; their own
/// `spaces.list` has been read once, as the owner's app does.
fn partner_held(b: &Bank, user: &str) -> Vec<Json> {
    ok(call(
        b,
        user,
        OWNER,
        "testPartner.set",
        r#"{"custody":"off"}"#,
    ));
    let fund = format!(r#"{{"fundId":"fund-{user}","assetId":"USDT","amount":"100"}}"#);
    ok(call(b, user, OWNER, "testPartner.fund", &fund));
    ok(call(
        b,
        user,
        OWNER,
        "spaces.create",
        r#"{"assetId":"USDT","name":"Trip TEST"}"#,
    ));
    own_list(b, user)
}

fn own_list(b: &Bank, user: &str) -> Vec<Json> {
    arr(&ok(call(b, user, OWNER, "spaces.list", r#"{"limit":50}"#)))
}

fn spaces_rows(b: &Bank) -> i64 {
    b.db.count("SELECT count(*) FROM bank.spaces")
}

#[test]
fn answers_each_partner_held_space_with_the_customers_own_figure_its_source_and_as_of_time_read_only()
 {
    let Some(b) = bank() else { return };
    let own = partner_held(&b, ADA);
    assert_eq!(own.len(), 2, "the main balance and Trip TEST");
    let rows = spaces_rows(&b);
    let reads = b.ledger.reads();

    let out = ok(call(&b, OPERATOR, DESK, PATH, &who(ADA)));

    assert_eq!(s(&out, "userId"), ADA);
    assert_eq!(out.get("heldByPartner"), Some(&Json::Bool(true)));
    let desk = arr(out.get("spaces").unwrap());
    assert_eq!(desk.len(), own.len());
    for mine in &own {
        let id = s(mine, "id");
        let row = desk
            .iter()
            .find(|r| s(r, "spaceId") == id)
            .unwrap_or_else(|| panic!("{id} missing from the desk's answer"));
        let held = mine.get("heldAt").unwrap();
        let figure = held.get("figure").unwrap();
        assert_eq!(s(row, "assetId"), s(mine, "assetId"));
        assert_eq!(s(row, "kind"), s(mine, "kind"));
        assert_eq!(s(row, "name"), s(mine, "name"));
        assert_eq!(s(row, "balance"), s(mine, "balance"));
        assert_eq!(s(row, "source"), s(held, "label"));
        assert_eq!(s(row, "source"), s(figure, "source"));
        assert_eq!(s(row, "state"), "known");
        assert_eq!(row.get("staleAfterMs"), figure.get("staleAfterMs"));
        // The TEST partner stamps each report with the time it was read: the desk's as-of is its own read's, never earlier.
        assert!(s(row, "asOf") >= s(held, "asOf"), "{}", row.compact());
        assert!(s(row, "asOf").ends_with('Z'));
    }
    let main = desk.iter().find(|r| s(r, "kind") == "primary").unwrap();
    assert_eq!(s(main, "balance"), "100");
    // Read-only: no ledger read, no row written.
    assert_eq!(b.ledger.reads(), reads);
    assert_eq!(spaces_rows(&b), rows);
}

#[test]
fn says_stale_when_the_partners_figure_is_stale_and_refuses_by_name_when_it_is_not_known_never_zero()
 {
    let Some(b) = bank() else { return };
    partner_held(&b, ADA);

    ok(call(
        &b,
        ADA,
        OWNER,
        "testPartner.set",
        r#"{"figures":"stale"}"#,
    ));
    let stale = ok(call(&b, OPERATOR, DESK, PATH, &who(ADA)));
    let rows = arr(stale.get("spaces").unwrap());
    assert!(!rows.is_empty());
    for r in &rows {
        assert_eq!(s(r, "state"), "stale", "{}", r.compact());
    }
    // The same rule as the customer's own list.
    for mine in own_list(&b, ADA) {
        assert_eq!(
            s(mine.get("heldAt").unwrap().get("figure").unwrap(), "state"),
            "stale"
        );
    }

    ok(call(
        &b,
        ADA,
        OWNER,
        "testPartner.set",
        r#"{"figures":"unknown"}"#,
    ));
    let unknown = call(&b, OPERATOR, DESK, PATH, &who(ADA));
    assert_eq!(data(&unknown, "cause"), "bank.partner_balance_not_known");
}

#[test]
fn answers_held_by_partner_false_with_no_spaces_for_a_person_no_partner_holds_reading_no_ledger_figure()
 {
    let Some(b) = bank() else { return };
    let reads = b.ledger.reads();
    let rows = spaces_rows(&b);
    let out = ok(call(&b, OPERATOR, DESK, PATH, &who(BOB)));
    assert_eq!(
        out.compact(),
        Json::obj([
            ("userId", Json::str(BOB)),
            ("heldByPartner", Json::Bool(false)),
            ("spaces", Json::Array(Vec::new())),
        ])
        .compact()
    );
    assert_eq!(b.ledger.reads(), reads);
    assert_eq!(spaces_rows(&b), rows);
}

#[test]
fn refuses_a_customers_own_session_and_an_operator_without_admin_read() {
    let Some(b) = bank() else { return };
    partner_held(&b, ADA);
    assert_eq!(
        data(&call(&b, ADA, OWNER, PATH, &who(ADA)), "code"),
        "FORBIDDEN"
    );
    assert_eq!(
        data(&call(&b, OPERATOR, &["bank:read"], PATH, &who(ADA)), "code"),
        "FORBIDDEN"
    );
    assert_eq!(
        data(
            &call(&b, OPERATOR, DESK, PATH, r#"{"userId":"nope"}"#),
            "code"
        ),
        "BAD_REQUEST"
    );
}
