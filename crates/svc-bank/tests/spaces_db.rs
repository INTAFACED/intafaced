//! Slice `spaces`'s database checks against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! `spaces/own-spaces.db.test.ts`, `space-name-conflict.db.test.ts`, `pot-lock-goal.db.test.ts`, `bills-pot.db.test.ts`
//! ("choosing the bills pot"), `shared-pots.db.test.ts`, `account-home/account-home.db.test.ts`, `profile.db.test.ts`,
//! `dormancy/dormancy.db.test.ts`, `plans/plans.test.ts` and `assets/supported-assets.test.ts` that fall on this slice's
//! own calls, each test named after the TypeScript test's words. Every call enters through the door, as the TypeScript's
//! enter through the router.
//!
//! What the TypeScript does through another slice is done here the nearest way this slice allows: money a transfer would
//! move into a pot is booked straight into the stand-in ledger, a business is the rows `business.create` writes, and a
//! card is the row `cards.issue` writes. Checks that read another slice's work (a debit's lock check, the bills runner,
//! a card's own status door) stay with that slice. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, Lookup, Lookups,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring};

use support::TestDb;

const SECRET: &str = "a-bank-spaces-db-edge-secret-long-enough-00";
const INTERNAL: &str = "a-bank-spaces-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const OWNER: &str = "61111111-1111-4111-8111-111111111111";
const PARTNER: &str = "62222222-2222-4222-8222-222222222222";
const VIEWER: &str = "63333333-3333-4333-8333-333333333333";
const THIRD: &str = "64444444-4444-4444-8444-444444444444";
const FROZEN: &str = "65555555-5555-4555-8555-555555555555";
const ADA_CO: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB_CO: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book (`MemoryLedger`), svc-identity's directory (`memoryBusinessDirectory`), the freeze.

/// One ledger book: (owner type, owner id, asset, kind) to amount. The test books money as a recipe would.
/// One row: owner type, owner id, asset, kind, amount.
type Line = (String, String, String, String, Amount);

#[derive(Clone, Default)]
struct Book {
    rows: Arc<Mutex<Vec<Line>>>,
    assets: Arc<Mutex<Option<Vec<Json>>>>,
}

impl Book {
    fn add(&self, owner_type: &str, owner: &str, asset: &str, kind: &str, delta: Amount) {
        let mut rows = self.rows.lock().unwrap();
        if let Some(r) = rows
            .iter_mut()
            .find(|r| r.0 == owner_type && r.1 == owner && r.2 == asset && r.3 == kind)
        {
            r.4 += delta;
        } else {
            rows.push((
                owner_type.to_owned(),
                owner.to_owned(),
                asset.to_owned(),
                kind.to_owned(),
                delta,
            ));
        }
    }
    /// `recipes.deposit`: money in to the person's main balance.
    fn fund(&self, user: &str, asset: &str, amount: &str) {
        self.add("user", user, asset, "available", amt(amount));
    }
    /// `recipes.orderHold`: available money held for an open order.
    fn hold(&self, user: &str, asset: &str, amount: &str) {
        self.add("user", user, asset, "available", -amt(amount));
        self.add("user", user, asset, "held", amt(amount));
    }
    /// What `transfers.create` books from the person's main balance into one of their pots.
    fn fill_pot(&self, user: &str, pot: &str, asset: &str, amount: &str) {
        self.add("user", user, asset, "available", -amt(amount));
        self.add("subaccount", pot, asset, "available", amt(amount));
    }
    fn of(&self, owner_type: &str, owner: &str, asset: &str) -> String {
        format_amount(
            self.balance(&LedgerAccount {
                owner_type: if owner_type == "user" {
                    "user"
                } else {
                    "subaccount"
                },
                owner_id: owner.to_owned(),
                asset_id: asset.to_owned(),
                kind: "available",
            })
            .unwrap(),
        )
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|r| {
                r.0 == a.owner_type && r.1 == a.owner_id && r.2 == a.asset_id && r.3 == a.kind
            })
            .map(|r| r.4)
            .sum())
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.0 == owner_type && r.1 == owner)
            .map(|r| LedgerBalance {
                asset_id: r.2.clone(),
                kind: r.3.clone(),
                purpose: String::new(),
                amount: r.4,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.assets
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no registry".to_owned())
    }
}

/// The people the directory knows: id, handle, email, status.
struct People(Vec<(&'static str, &'static str, &'static str, &'static str)>);

impl Directory for People {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(self
            .0
            .iter()
            .filter(|p| ids.iter().any(|i| i == p.0))
            .map(|p| (p.0.to_owned(), p.1.to_owned()))
            .collect())
    }
    fn find_active(&self, q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok(self
            .0
            .iter()
            .find(|p| {
                p.3 == "active"
                    && match q {
                        Lookup::Handle(h) => p.1.eq_ignore_ascii_case(h),
                        Lookup::Email(e) => p.2.eq_ignore_ascii_case(e),
                    }
            })
            .map(|p| (p.0.to_owned(), p.1.to_owned())))
    }
}

fn people() -> People {
    People(vec![
        (OWNER, "Olga_Owner", "olga@example.com", "active"),
        (PARTNER, "Pia_Partner", "pia@example.com", "active"),
        (VIEWER, "Vic_Viewer", "vic@example.com", "active"),
        (THIRD, "Tom_Third", "tom@example.com", "active"),
        (FROZEN, "Fro_Zen", "fro@example.com", "frozen"),
    ])
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

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls

/// The owner values one test runs under, as `createBankServices`' options give them.
#[derive(Default, Clone)]
struct Owner {
    space_limit: Option<&'static str>,
    unlock_wait: Option<&'static str>,
    invite_minutes: Option<&'static str>,
    people_cap: Option<&'static str>,
    account_terms: Option<String>,
    currencies: Option<&'static str>,
    plans: Option<String>,
    fees: Option<String>,
    dormancy: Option<String>,
}

struct Bank {
    door: BankDoor,
}

fn bank(db: &TestDb, ledger: &Book, o: &Owner) -> Bank {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let s = |v: Option<&str>| v.map(str::to_owned);
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
    .with_spaces(Wiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(people()),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: s(o.space_limit),
            unlock_wait_hours: s(o.unlock_wait),
        },
        terms: Terms {
            invite_minutes: s(o.invite_minutes),
            people_cap: s(o.people_cap),
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: o.account_terms.clone(),
            currencies: s(o.currencies),
            plans: o.plans.clone(),
            fees: o.fees.clone(),
            dormancy: o.dormancy.clone(),
        },
    });
    Bank { door }
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

/// One answer: the status, and the data or the error.
#[derive(Debug, Clone)]
struct Answer(u16, Json);

impl Answer {
    fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    /// The refusal's own code (`cause.code`), or `ok`.
    fn code(&self) -> String {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        match (self.0, cause) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
    /// tRPC's code (`FORBIDDEN`, `BAD_REQUEST`, ...).
    fn trpc(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => "ok".to_owned(),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn send(b: &Bank, path: &str, input: Option<&str>, mut headers: Vec<(String, String)>) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            match input {
                Some(i) => format!("/trpc/{path}?input={}", encode(i)),
                None => format!("/trpc/{path}"),
            },
            String::new(),
        ),
        _ => (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or("").to_owned(),
        ),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-spaces-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// A call as the person.
fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    send(b, path, (!input.is_empty()).then_some(input), person(user))
}

/// A call as a service, signed with the shared secret.
fn as_service(b: &Bank, service: Option<&str>, path: &str, input: &str) -> Answer {
    let headers = match service {
        Some(s) => s2s::legacy_headers(s, INTERNAL, input, system_seconds()).unwrap(),
        None => Vec::new(),
    };
    send(b, path, Some(input), headers)
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

fn now() -> i64 {
    door::system_now().0
}

fn ms(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

/// `spaces.create` as the person.
fn create(b: &Bank, user: &str, asset: &str, name: &str) -> Answer {
    call(
        b,
        user,
        "spaces.create",
        &format!(r#"{{"assetId":"{asset}","name":"{name}"}}"#),
    )
}

fn created(b: &Bank, user: &str, asset: &str, name: &str) -> String {
    text(&create(b, user, asset, name).ok(), "id")
}

/// The person's spaces in one asset (`spaces.list`, a page of 50).
fn list(b: &Bank, user: &str, asset: Option<&str>) -> Vec<Json> {
    let input = match asset {
        Some(a) => format!(r#"{{"assetId":"{a}","limit":50}}"#),
        None => r#"{"limit":50}"#.to_owned(),
    };
    arr(&call(b, user, "spaces.list", &input).ok())
}

fn row(b: &Bank, user: &str, id: &str) -> Json {
    list(b, user, None)
        .into_iter()
        .find(|s| text(s, "id") == id)
        .expect("the space is listed")
}

fn space_id(sp: &str) -> String {
    format!(r#"{{"spaceId":"{sp}"}}"#)
}

// ---------------------------------------------------------------------------------------------------------------
// `own-spaces.db.test.ts`: the list svc-tax asks for

fn limit5() -> Owner {
    Owner {
        space_limit: Some("5"),
        unlock_wait: Some("24"),
        ..Owner::default()
    }
}

#[test]
fn lists_every_named_space_the_customer_owns_archived_ones_too_and_no_primary_and_nobody_elses() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &limit5());
    let cold = created(&b, ADA, "BTC", "TEST cold");
    let old = created(&b, ADA, "ETH", "TEST old");
    assert_eq!(
        call(&b, ADA, "spaces.archive", &space_id(&old))
            .ok()
            .compact(),
        r#"{"archived":true}"#
    );
    created(&b, BOB, "BTC", "TEST not Ada’s");
    let got = as_service(
        &b,
        Some("svc-tax"),
        "spaces.ownedAccounts",
        &format!(r#"{{"userId":"{ADA}"}}"#),
    )
    .ok();
    assert_eq!(
        got.compact(),
        format!(
            r#"{{"spaces":[{{"spaceId":"{cold}","assetId":"BTC","name":"TEST cold","archived":false}},{{"spaceId":"{old}","assetId":"ETH","name":"TEST old","archived":true}}]}}"#
        )
    );
    assert!(!got.compact().to_lowercase().contains("balance"));
}

#[test]
fn answers_an_empty_list_for_a_customer_with_no_named_space() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(
        &db,
        &ledger,
        &Owner {
            currencies: Some("BTC"),
            ..limit5()
        },
    );
    call(&b, BOB, "currencies.add", r#"{"assetId":"BTC"}"#).ok();
    let got = as_service(
        &b,
        Some("svc-tax"),
        "spaces.ownedAccounts",
        &format!(r#"{{"userId":"{BOB}"}}"#),
    )
    .ok();
    assert_eq!(got.compact(), r#"{"spaces":[]}"#);
}

#[test]
fn serves_svc_tax_only_another_service_is_forbidden_and_no_service_is_unauthorized() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let input = format!(r#"{{"userId":"{ADA}"}}"#);
    assert_eq!(
        as_service(&b, Some("svc-pay"), "spaces.ownedAccounts", &input).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        as_service(&b, None, "spaces.ownedAccounts", &input).trpc(),
        "UNAUTHORIZED"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `space-name-conflict.db.test.ts`

#[test]
fn a_second_space_with_the_same_name_in_the_same_asset_refuses_bank_space_name_taken_409_one_row_stored()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    created(&b, ADA, "USDT", "Holiday");
    let again = create(&b, ADA, "USDT", "Holiday");
    assert_eq!(
        (again.0, again.code().as_str(), again.trpc().as_str()),
        (409, "bank.space_name_taken", "CONFLICT")
    );
    assert_eq!(
        db.count(&format!("SELECT count(*) FROM bank.spaces WHERE user_id = '{ADA}' AND asset_id = 'USDT' AND name = 'Holiday'")),
        1
    );
    // An archived space still holds its name: the refusal is the same typed conflict.
    let car = created(&b, ADA, "USDT", "Car");
    db.client()
        .execute(
            "UPDATE bank.spaces SET archived_at = now() WHERE id = $1::text::uuid",
            &[&car],
        )
        .unwrap();
    assert_eq!(
        create(&b, ADA, "USDT", "Car").code(),
        "bank.space_name_taken"
    );
    // The same name in another asset or for another user is allowed.
    assert_eq!(
        text(&create(&b, ADA, "BTC", "Holiday").ok(), "name"),
        "Holiday"
    );
    assert_eq!(
        text(&create(&b, BOB, "USDT", "Holiday").ok(), "name"),
        "Holiday"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `pot-lock-goal.db.test.ts` (BK-pots-02). A debit's lock check (`resolveForDebit`) is slice `transfers`'s.

fn pot(b: &Bank, locked_until: Option<i64>) -> String {
    let lock = locked_until.map_or(String::new(), |t| format!(r#","lockedUntil":"{}""#, iso(t)));
    text(
        &call(
            b,
            ADA,
            "spaces.create",
            &format!(r#"{{"assetId":"USDT","name":"TEST holiday"{lock}}}"#),
        )
        .ok(),
        "id",
    )
}

fn primary(b: &Bank, user: &str, asset: &str) -> String {
    list(b, user, Some(asset))
        .into_iter()
        .find(|s| text(s, "kind") == "primary")
        .map(|s| text(&s, "id"))
        .expect("a primary")
}

#[test]
fn sets_changes_and_clears_a_goal_and_refuses_a_goal_of_zero_the_primary_space_and_another_owner() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let holiday = pot(&b, None);
    let goal = |user: &str, g: &str| {
        call(
            &b,
            user,
            "spaces.setGoal",
            &format!(r#"{{"spaceId":"{holiday}","goalTarget":{g}}}"#),
        )
    };
    assert_eq!(text(&goal(ADA, r#""50""#).ok(), "goalTarget"), "50");
    assert_eq!(text(&goal(ADA, r#""15.5""#).ok(), "goalTarget"), "15.5");
    assert_eq!(text(&row(&b, ADA, &holiday), "goalTarget"), "15.5");
    assert_eq!(text(&goal(ADA, "null").ok(), "goalTarget"), "null");
    assert_eq!(text(&row(&b, ADA, &holiday), "goalTarget"), "null");
    assert_eq!(goal(ADA, r#""0""#).code(), "bank.space_change_invalid");
    let main = primary(&b, ADA, "USDT");
    let on_main = call(
        &b,
        ADA,
        "spaces.setGoal",
        &format!(r#"{{"spaceId":"{main}","goalTarget":"5"}}"#),
    );
    assert_eq!(on_main.code(), "bank.space_change_invalid");
    assert_eq!(goal(BOB, r#""5""#).code(), "bank.space_not_found");
    assert_eq!(text(&row(&b, ADA, &holiday), "goalTarget"), "null");
}

#[test]
fn locks_a_pot_keeps_it_locked_longer_and_refuses_a_shorter_lock_or_a_past_date() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let holiday = pot(&b, None);
    let lock = |t: i64| {
        call(
            &b,
            ADA,
            "spaces.setLock",
            &format!(r#"{{"spaceId":"{holiday}","lockedUntil":"{}"}}"#, iso(t)),
        )
    };
    let in10 = now() + 10 * DAY;
    let in20 = now() + 20 * DAY;
    let first = lock(in10).ok();
    assert_eq!(
        (text(&first, "lockedUntil"), text(&first, "unlocksAt")),
        (iso(in10), "null".to_owned())
    );
    assert_eq!(text(&lock(in20).ok(), "lockedUntil"), iso(in20));
    assert_eq!(lock(in10).code(), "bank.space_change_invalid");
    assert_eq!(lock(now() - HOUR).code(), "bank.space_change_invalid");
    assert_eq!(text(&row(&b, ADA, &holiday), "lockedUntil"), iso(in20));
}

#[test]
fn opens_a_locked_pot_early_only_after_the_owners_wait_and_asking_again_keeps_the_first_opening_time()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let until = now() + 30 * DAY;
    let holiday = pot(&b, Some(until));
    let before = now();
    let asked = call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).ok();
    let opens = ms(&text(&asked, "unlocksAt"));
    assert!(opens >= before + 24 * HOUR && opens <= now() + 24 * HOUR);
    assert_eq!(text(&asked, "lockedUntil"), iso(until));
    assert_ne!(text(&asked, "unlockRequestedAt"), "null");
    assert_eq!(
        call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).ok(),
        asked
    );
    let listed = row(&b, ADA, &holiday);
    assert_eq!(
        (text(&listed, "unlocksAt"), text(&listed, "lockedUntil")),
        (text(&asked, "unlocksAt"), iso(until))
    );
}

#[test]
fn never_opens_later_than_the_lock_date_and_a_wait_of_0_opens_at_once() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &limit5());
    let soon = now() + 2 * HOUR;
    let holiday = pot(&b, Some(soon));
    assert_eq!(
        text(
            &call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).ok(),
            "unlocksAt"
        ),
        iso(soon)
    );
    let other_until = iso(now() + DAY);
    let other = text(
        &call(
            &b,
            ADA,
            "spaces.create",
            &format!(r#"{{"assetId":"USDT","name":"TEST other","lockedUntil":"{other_until}"}}"#),
        )
        .ok(),
        "id",
    );
    let b = bank(
        &db,
        &ledger,
        &Owner {
            unlock_wait: Some("0"),
            ..limit5()
        },
    );
    let opened = call(&b, ADA, "spaces.requestUnlock", &space_id(&other)).ok();
    assert_eq!(
        (text(&opened, "lockedUntil"), text(&opened, "unlocksAt")),
        ("null".to_owned(), "null".to_owned())
    );
}

#[test]
fn refuses_an_early_unlock_with_no_owner_wait_and_writes_nothing_and_refuses_one_on_an_unlocked_pot()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let until = now() + 5 * DAY;
    let holiday = pot(&bank(&db, &ledger, &limit5()), Some(until));
    for blank in [
        None,
        Some(""),
        Some(" "),
        Some("soon"),
        Some("-1"),
        Some("8761"),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                unlock_wait: blank,
                ..limit5()
            },
        );
        assert_eq!(
            call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).code(),
            "bank.space_unlock_rule_unset"
        );
    }
    let b = bank(&db, &ledger, &limit5());
    let listed = row(&b, ADA, &holiday);
    assert_eq!(
        (
            text(&listed, "lockedUntil"),
            text(&listed, "unlocksAt"),
            text(&listed, "unlockRequestedAt")
        ),
        (iso(until), "null".to_owned(), "null".to_owned())
    );
    let open = created(&b, ADA, "USDT", "TEST open");
    assert_eq!(
        call(&b, ADA, "spaces.requestUnlock", &space_id(&open)).code(),
        "bank.space_not_locked"
    );
    assert_eq!(
        call(&b, BOB, "spaces.requestUnlock", &space_id(&holiday)).code(),
        "bank.space_not_found"
    );
}

#[test]
fn makes_no_lock_while_the_owner_wait_is_blank_so_no_lock_is_made_that_cannot_be_ended_early() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let holiday = pot(&bank(&db, &ledger, &limit5()), None);
    let b = bank(
        &db,
        &ledger,
        &Owner {
            unlock_wait: None,
            ..limit5()
        },
    );
    let until = iso(now() + 100 * 365 * DAY);
    let lock = call(
        &b,
        ADA,
        "spaces.setLock",
        &format!(r#"{{"spaceId":"{holiday}","lockedUntil":"{until}"}}"#),
    );
    assert_eq!(lock.code(), "bank.space_unlock_rule_unset");
    let locked = call(
        &b,
        ADA,
        "spaces.create",
        &format!(r#"{{"assetId":"USDT","name":"TEST locked","lockedUntil":"{until}"}}"#),
    );
    assert_eq!(locked.code(), "bank.space_unlock_rule_unset");
    assert_eq!(text(&row(&b, ADA, &holiday), "lockedUntil"), "null");
    assert!(
        !list(&b, ADA, Some("USDT"))
            .iter()
            .any(|s| text(s, "name") == "TEST locked")
    );
    assert_eq!(
        text(&create(&b, ADA, "USDT", "TEST unlocked").ok(), "name"),
        "TEST unlocked"
    );
}

#[test]
fn withdraws_a_waiting_early_unlock_and_a_new_lock_date_replaces_one() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &limit5());
    let until = now() + 5 * DAY;
    let holiday = pot(&b, Some(until));
    call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).ok();
    let cancelled = call(&b, ADA, "spaces.cancelUnlock", &space_id(&holiday)).ok();
    assert_eq!(
        (
            text(&cancelled, "lockedUntil"),
            text(&cancelled, "unlocksAt")
        ),
        (iso(until), "null".to_owned())
    );
    assert_eq!(
        text(
            &call(&b, ADA, "spaces.cancelUnlock", &space_id(&holiday)).ok(),
            "unlocksAt"
        ),
        "null"
    );

    // Once an early unlock has opened the space, withdrawing it changes nothing and answers the open space.
    let opened = text(
        &call(
            &b,
            ADA,
            "spaces.create",
            &format!(
                r#"{{"assetId":"USDT","name":"TEST opened","lockedUntil":"{}"}}"#,
                iso(until)
            ),
        )
        .ok(),
        "id",
    );
    let at_once = bank(
        &db,
        &ledger,
        &Owner {
            unlock_wait: Some("0"),
            ..limit5()
        },
    );
    call(&at_once, ADA, "spaces.requestUnlock", &space_id(&opened)).ok();
    let after = call(&b, ADA, "spaces.cancelUnlock", &space_id(&opened)).ok();
    assert_eq!(
        (text(&after, "lockedUntil"), text(&after, "unlocksAt")),
        ("null".to_owned(), "null".to_owned())
    );

    call(&b, ADA, "spaces.requestUnlock", &space_id(&holiday)).ok();
    let later = until + DAY;
    let relocked = call(
        &b,
        ADA,
        "spaces.setLock",
        &format!(
            r#"{{"spaceId":"{holiday}","lockedUntil":"{}"}}"#,
            iso(later)
        ),
    )
    .ok();
    assert_eq!(
        (
            text(&relocked, "lockedUntil"),
            text(&relocked, "unlocksAt"),
            text(&relocked, "unlockRequestedAt")
        ),
        (iso(later), "null".to_owned(), "null".to_owned())
    );
}

#[test]
fn keeps_the_early_unlock_columns_consistent_in_the_table() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let holiday = pot(&b, Some(now() + DAY));
    let mut c = db.client();
    for sql in [
        "UPDATE bank.spaces SET unlocks_at = now() WHERE id = $1::text::uuid",
        "UPDATE bank.spaces SET unlock_requested_at = now(), unlocks_at = locked_until + interval '1 hour' WHERE id = $1::text::uuid",
    ] {
        let err = c.execute(sql, &[&holiday]).unwrap_err();
        assert!(
            format!("{err:?}").contains("spaces_early_unlock_ck"),
            "{err:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------
// `bills-pot.db.test.ts`, "choosing the bills pot". The runner that tops a bill up is slice `transfers`'s.

#[test]
fn takes_one_of_the_persons_own_live_pots_moves_the_role_between_pots_and_archiving_ends_it() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &limit5());
    let bills = created(&b, ADA, "USDT", "Bills TEST");
    let other = created(&b, ADA, "USDT", "Other TEST");
    let theirs = created(&b, BOB, "USDT", "Theirs TEST");
    let account = primary(&b, ADA, "USDT");
    let set = |sp: &str, fallback: bool| {
        call(
            &b,
            ADA,
            "spaces.setBillsPot",
            &format!(r#"{{"spaceId":"{sp}","fallback":{fallback}}}"#),
        )
    };
    let clear = |sp: &str| call(&b, ADA, "spaces.clearBillsPot", &space_id(sp));
    let bills_of = || {
        list(&b, ADA, Some("USDT"))
            .into_iter()
            .filter(|s| text(s, "billsPot") != "null")
            .map(|s| (text(&s, "id"), text(&s, "billsPot")))
            .collect::<Vec<_>>()
    };
    assert_eq!(set(&account, true).code(), "bank.space_change_invalid");
    assert_eq!(set(&theirs, true).code(), "bank.space_not_found");
    assert_eq!(clear(&theirs).code(), "bank.space_not_found");
    assert_eq!(
        set(&bills, false).ok().compact(),
        format!(r#"{{"spaceId":"{bills}","assetId":"USDT","fallback":false}}"#)
    );
    assert_eq!(text(&set(&bills, true).ok(), "fallback"), "true");
    assert_eq!(
        bills_of(),
        vec![(bills.clone(), r#"{"fallback":true}"#.to_owned())]
    );
    set(&other, false).ok();
    assert_eq!(
        bills_of(),
        vec![(other.clone(), r#"{"fallback":false}"#.to_owned())]
    );
    assert_eq!(
        clear(&other).ok().compact(),
        format!(r#"{{"spaceId":"{other}","billsPot":null}}"#)
    );
    assert!(bills_of().is_empty());
    set(&bills, true).ok();
    call(&b, ADA, "spaces.archive", &space_id(&bills)).ok();
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM bank.bills_pots WHERE space_id = '{bills}'::uuid"
        )),
        0
    );
    assert_eq!(set(&bills, true).code(), "bank.space_archived");
}

// ---------------------------------------------------------------------------------------------------------------
// `account-home.db.test.ts` (BK-acct-01, BK-pots-01)

fn test_terms(monthly_fee: &str, overdraft: &str) -> String {
    format!(
        r#"{{"tier":"TEST base tier","version":"test-1","currency":"USDT","monthlyFee":"{monthly_fee}","minimumBalance":"0","overdraftFee":{overdraft},"included":["TEST spaces","TEST transfers between your spaces"]}}"#
    )
}

#[test]
fn accounts_features_refuses_bank_account_terms_unset_while_the_owner_has_published_nothing_and_for_terms_out_of_shape()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    for terms in [
        None,
        Some(String::new()),
        Some("   ".to_owned()),
        Some("not json".to_owned()),
        Some(test_terms("free", "null")),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                account_terms: terms,
                ..Owner::default()
            },
        );
        assert_eq!(
            call(&b, ADA, "accounts.features", "").code(),
            "bank.account_terms_unset"
        );
    }
}

#[test]
fn accounts_features_returns_the_published_terms_exactly_figures_as_decimal_strings_and_names_the_overdraft_blocker()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let terms = test_terms("2.50", r#""0""#);
    let b = bank(
        &db,
        &ledger,
        &Owner {
            account_terms: Some(terms.clone()),
            ..Owner::default()
        },
    );
    let want = format!(
        r#"{},"overdraftBlocker":"bank.overdraft_switched_off"}}"#,
        &terms[..terms.len() - 1]
    );
    assert_eq!(call(&b, ADA, "accounts.features", "").ok().compact(), want);
    // No overdraft blocker for a plan with no overdraft (J-bank-02 #8).
    let none = bank(
        &db,
        &ledger,
        &Owner {
            account_terms: Some(test_terms("0", "null")),
            ..Owner::default()
        },
    );
    let got = call(&none, ADA, "accounts.features", "").ok();
    assert_eq!(
        (text(&got, "overdraftFee"), text(&got, "overdraftBlocker")),
        ("null".to_owned(), "null".to_owned())
    );
}

fn allowed() -> Owner {
    Owner {
        currencies: Some("USDT, USDC,BTC"),
        space_limit: Some("5"),
        unlock_wait: Some("24"),
        ..Owner::default()
    }
}

fn primaries(db: &TestDb, user: &str) -> Vec<(String, bool)> {
    db.client()
        .query(
            "SELECT asset_id, removed_at IS NOT NULL FROM bank.spaces WHERE user_id = $1 AND kind = 'primary' ORDER BY asset_id",
            &[&user],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect()
}

fn currencies(b: &Bank, user: &str) -> Json {
    call(b, user, "currencies.list", "").ok()
}

fn currency_ids(b: &Bank, user: &str) -> Vec<String> {
    arr(currencies(b, user).get("currencies").unwrap())
        .iter()
        .map(|c| text(c, "assetId"))
        .collect()
}

fn add(b: &Bank, user: &str, asset: &str) -> Answer {
    call(
        b,
        user,
        "currencies.add",
        &format!(r#"{{"assetId":"{asset}"}}"#),
    )
}

fn remove(b: &Bank, user: &str, asset: &str) -> Answer {
    call(
        b,
        user,
        "currencies.remove",
        &format!(r#"{{"assetId":"{asset}"}}"#),
    )
}

#[test]
fn adds_a_currency_from_the_owner_list_once_however_often_it_is_asked() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &allowed());
    let first = add(&b, ADA, "usdc").ok();
    assert_eq!(add(&b, ADA, "USDC").ok(), first);
    assert_eq!(
        (text(&first, "assetId"), text(&first, "balance")),
        ("USDC".to_owned(), "0".to_owned())
    );
    assert_eq!(primaries(&db, ADA), vec![("USDC".to_owned(), false)]);
    assert_eq!(currency_ids(&b, ADA), ["USDC"]);
    assert_eq!(
        currencies(&b, ADA).get("addable").unwrap().compact(),
        r#"["USDT","BTC"]"#
    );
}

#[test]
fn refuses_an_asset_not_on_the_owner_list_and_every_add_while_the_list_is_blank() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    assert_eq!(
        add(&bank(&db, &ledger, &allowed()), ADA, "DOGE").code(),
        "bank.asset_unknown"
    );
    let blank = bank(&db, &ledger, &Owner::default());
    assert_eq!(
        add(&blank, ADA, "USDT").code(),
        "bank.account_currencies_unset"
    );
    assert!(primaries(&db, ADA).is_empty());
    // The list still shows what the account holds and says why nothing can be added.
    ledger.fund(ADA, "USDT", "5");
    let listed = currencies(&blank, ADA);
    let row = &arr(listed.get("currencies").unwrap())[0];
    assert_eq!(
        (text(row, "assetId"), text(row, "balance")),
        ("USDT".to_owned(), "5".to_owned())
    );
    assert_eq!(
        (text(&listed, "addable"), text(&listed, "addableBlocker")),
        (
            "null".to_owned(),
            "bank.account_currencies_unset".to_owned()
        )
    );
}

#[test]
fn refuses_bank_currency_in_use_while_the_currency_holds_a_balance_and_moves_nothing() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &allowed());
    ledger.fund(ADA, "USDT", "100");
    add(&b, ADA, "USDT").ok();
    assert_eq!(remove(&b, ADA, "USDT").code(), "bank.currency_in_use");
    assert_eq!(
        text(
            &arr(currencies(&b, ADA).get("currencies").unwrap())[0],
            "balance"
        ),
        "100"
    );
    assert_eq!(primaries(&db, ADA), vec![("USDT".to_owned(), false)]);
    assert_eq!(ledger.of("user", ADA, "USDT"), "100");
}

#[test]
fn refuses_while_all_of_it_is_held_for_an_open_order_with_nothing_available() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &allowed());
    ledger.fund(ADA, "BTC", "1");
    ledger.hold(ADA, "BTC", "1");
    add(&b, ADA, "BTC").ok();
    assert_eq!(remove(&b, ADA, "BTC").code(), "bank.currency_in_use");
}

#[test]
fn refuses_while_a_named_space_uses_the_currency_live_and_empty_or_archived_and_funded() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &allowed());
    add(&b, ADA, "USDC").ok();
    let trip = created(&b, ADA, "USDC", "Trip");
    assert_eq!(remove(&b, ADA, "USDC").code(), "bank.currency_in_use");
    ledger.fund(ADA, "USDC", "30");
    ledger.fill_pot(ADA, &trip, "USDC", "30");
    call(&b, ADA, "spaces.archive", &space_id(&trip)).ok();
    assert_eq!(remove(&b, ADA, "USDC").code(), "bank.currency_in_use");
}

#[test]
fn removes_an_empty_currency_shows_it_again_once_money_arrives_and_an_add_brings_back_the_same_space()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &allowed());
    let added = add(&b, ADA, "USDC").ok();
    let space = text(&added, "spaceId");
    assert_eq!(
        remove(&b, ADA, "USDC").ok().compact(),
        r#"{"assetId":"USDC","removed":true}"#
    );
    assert_eq!(
        remove(&b, ADA, "USDC").ok().compact(),
        r#"{"assetId":"USDC","removed":true}"#
    );
    assert!(currency_ids(&b, ADA).is_empty());
    assert!(list(&b, ADA, None).is_empty());

    ledger.fund(ADA, "USDC", "7");
    assert_eq!(
        currencies(&b, ADA).get("currencies").unwrap().compact(),
        format!(r#"[{{"assetId":"USDC","spaceId":"{space}","balance":"7"}}]"#)
    );
    ledger.fund(ADA, "BTC", "0.5");
    currencies(&b, ADA);
    db.client()
        .execute(
            "UPDATE bank.spaces SET removed_at = now() WHERE user_id = $1 AND asset_id = 'USDC'",
            &[&ADA],
        )
        .unwrap();
    assert_eq!(
        list(&b, ADA, None)
            .iter()
            .map(|s| text(s, "assetId"))
            .collect::<Vec<_>>(),
        ["BTC", "USDC"]
    );
    assert_eq!(
        add(&b, ADA, "USDC").ok().compact(),
        format!(r#"{{"assetId":"USDC","spaceId":"{space}","balance":"7"}}"#)
    );
}

#[test]
fn puts_a_removed_currency_back_when_a_space_is_made_in_it_or_an_archived_one_restored() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &allowed());
    add(&b, ADA, "USDC").ok();
    let trip = created(&b, ADA, "USDC", "Trip");
    call(&b, ADA, "spaces.archive", &space_id(&trip)).ok();
    remove(&b, ADA, "USDC").ok();
    call(&b, ADA, "spaces.unarchive", &space_id(&trip)).ok();
    assert_eq!(currency_ids(&b, ADA), ["USDC"]);
    call(&b, ADA, "spaces.archive", &space_id(&trip)).ok();
    remove(&b, ADA, "USDC").ok();
    created(&b, ADA, "USDC", "Rent");
    assert_eq!(currency_ids(&b, ADA), ["USDC"]);
}

#[test]
fn never_leaves_a_live_space_under_a_removed_currency_when_a_remove_and_a_create_race() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        &Book::default(),
        &Owner {
            space_limit: Some("20"),
            ..allowed()
        },
    );
    for round in 0..5 {
        add(&b, ADA, "USDC").ok();
        std::thread::scope(|s| {
            s.spawn(|| remove(&b, ADA, "USDC"));
            s.spawn(|| create(&b, ADA, "USDC", &format!("Race {round}")));
        });
        let r = db
            .client()
            .query_one(
                "SELECT p.removed_at IS NOT NULL, (SELECT count(*) FROM bank.spaces n WHERE n.user_id = p.user_id \
                 AND n.asset_id = p.asset_id AND n.kind = 'named' AND n.archived_at IS NULL) \
                 FROM bank.spaces p WHERE p.user_id = $1 AND p.asset_id = 'USDC' AND p.kind = 'primary'",
                &[&ADA],
            )
            .unwrap();
        let (removed, live): (bool, i64) = (r.get(0), r.get(1));
        assert!(
            !(live > 0 && removed),
            "round {round}: a live space under a removed currency"
        );
        db.client()
            .execute(
                "UPDATE bank.spaces SET archived_at = now() WHERE user_id = $1 AND kind = 'named'",
                &[&ADA],
            )
            .unwrap();
    }
}

#[test]
fn refuses_for_a_person_the_partner_holds_money_for_while_the_partner_reports_a_purchase_hold_or_an_open_order_in_it_with_a_balance_of_0()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &allowed());
    call(&b, ADA, "testPartner.set", r#"{"custody":"off"}"#).ok();
    add(&b, ADA, "USDC").ok();
    assert_eq!(
        text(
            &arr(currencies(&b, ADA).get("currencies").unwrap())[0],
            "balance"
        ),
        "0"
    );
    // An open order the partner reports in it.
    call(&b, ADA, "testPartner.set", r#"{"openOrder":"USDC"}"#).ok();
    assert_eq!(remove(&b, ADA, "USDC").code(), "bank.currency_in_use");
    call(&b, ADA, "testPartner.set", r#"{"openOrder":"BTC"}"#).ok();
    // A purchase hold the partner reports, not yet released, with the partner's balance reading 0.
    let partner = b.door.partner().partner.as_ref().unwrap();
    {
        let mut state = partner.lock();
        state
            .purchase_credit(
                ADA,
                &svc_bank::partner::desks::Purchase {
                    key: "p1".to_owned(),
                    asset_id: "USDC".to_owned(),
                    amount: amt("3"),
                    paid_by: "card".to_owned(),
                },
                Instant(now()),
            )
            .unwrap();
        state
            .book
            .add(&svc_bank::partner::AccountRef::main(ADA, "USDC"), -amt("3"))
            .unwrap();
    }
    assert_eq!(remove(&b, ADA, "USDC").code(), "bank.currency_in_use");
    assert_eq!(primaries(&db, ADA), vec![("USDC".to_owned(), false)]);
    // Nothing held, no order in it: it comes off.
    partner.lock().purchases = svc_bank::partner::desks::PurchaseDesk::default();
    assert_eq!(
        remove(&b, ADA, "USDC").ok().compact(),
        r#"{"assetId":"USDC","removed":true}"#
    );
}

#[test]
fn touches_only_the_callers_own_currencies() {
    let Some(db) = db() else { return };
    let b = bank(&db, &Book::default(), &allowed());
    add(&b, BOB, "USDC").ok();
    remove(&b, ADA, "USDC").ok();
    assert_eq!(primaries(&db, BOB), vec![("USDC".to_owned(), false)]);
}

#[test]
fn refuses_bank_space_limit_unset_while_the_limit_is_blank_and_makes_no_space() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    for limit in [
        None,
        Some(""),
        Some("0"),
        Some("-1"),
        Some("2.5"),
        Some("ten"),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                space_limit: limit,
                ..Owner::default()
            },
        );
        assert_eq!(
            create(&b, ADA, "USDT", "Trip").code(),
            "bank.space_limit_unset"
        );
    }
    // Not even the primary label: a refused create writes no row at all.
    assert_eq!(db.count("SELECT count(*) FROM bank.spaces"), 0);
}

#[test]
fn refuses_bank_space_limit_reached_at_the_limit_with_the_number_archived_spaces_do_not_count_until_restored()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(
        &db,
        &ledger,
        &Owner {
            space_limit: Some("2"),
            ..Owner::default()
        },
    );
    let a = created(&b, ADA, "USDT", "A");
    created(&b, ADA, "BTC", "B");
    let full = create(&b, ADA, "USDT", "C");
    assert_eq!(full.code(), "bank.space_limit_reached");
    assert!(full.message().contains('2'), "{}", full.message());
    call(&b, ADA, "spaces.archive", &space_id(&a)).ok();
    let c = created(&b, ADA, "USDT", "C");
    assert_eq!(
        call(&b, ADA, "spaces.unarchive", &space_id(&a)).code(),
        "bank.space_limit_reached"
    );
    call(&b, ADA, "spaces.archive", &space_id(&c)).ok();
    assert_eq!(
        call(&b, ADA, "spaces.unarchive", &space_id(&a))
            .ok()
            .compact(),
        r#"{"archived":false}"#
    );
    // Another customer's spaces never use up this one's room.
    assert_eq!(text(&create(&b, BOB, "USDT", "A").ok(), "name"), "A");
}

#[test]
fn makes_one_space_when_two_creates_race_for_the_last_place() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        &Book::default(),
        &Owner {
            space_limit: Some("1"),
            ..Owner::default()
        },
    );
    let answers: Vec<Answer> = std::thread::scope(|s| {
        let one = s.spawn(|| create(&b, ADA, "USDT", "One"));
        let two = s.spawn(|| create(&b, ADA, "USDT", "Two"));
        vec![one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(answers.iter().filter(|a| a.0 == 200).count(), 1);
    assert_eq!(
        answers.iter().find(|a| a.0 != 200).unwrap().code(),
        "bank.space_limit_reached"
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM bank.spaces WHERE user_id = '{ADA}' AND kind = 'named'"
        )),
        1
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `profile.db.test.ts` (J-bank-01 #7). `accountDetails.*` is slice `partner-account`'s.

/// What `business.create` writes: the account, owned by its maker, who is its admin.
fn business(db: &TestDb, id: &str, name: &str, owner: &str) {
    let mut c = db.client();
    c.execute(
        "INSERT INTO bank.business_accounts (id, name, asset_id, spend_threshold, owner_user_id) VALUES ($1::text::uuid, $2, 'USDT', 10, $3)",
        &[&id, &name, &owner],
    )
    .unwrap();
    c.execute(
        "INSERT INTO bank.business_members (account_id, user_id, role) VALUES ($1::text::uuid, $2, 'admin')",
        &[&id, &owner],
    )
    .unwrap();
}

fn profiled() -> Owner {
    Owner {
        account_terms: Some(test_terms("0", "null")),
        currencies: Some("USDT,USDC"),
        ..Owner::default()
    }
}

fn footprint(db: &TestDb) -> (i64, i64, i64, i64) {
    (
        db.count("SELECT count(*) FROM bank.spaces"),
        db.count("SELECT count(*) FROM bank.spaces WHERE removed_at IS NOT NULL"),
        db.count("SELECT count(*) FROM bank.business_accounts"),
        db.count("SELECT count(*) FROM bank.business_members"),
    )
}

fn with_profile(profile: &str, rest: &str) -> String {
    format!(r#"{{{rest}"profile":"{profile}"}}"#)
}

#[test]
fn a_call_with_no_profile_or_personal_is_the_personal_account_as_before() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    ledger.fund(ADA, "USDT", "100");
    business(&db, ADA_CO, "Ada TEST Studio", ADA);
    let b = bank(&db, &ledger, &profiled());
    for input in ["", "{}", r#"{"profile":"personal"}"#] {
        assert_eq!(
            text(&call(&b, ADA, "accounts.features", input).ok(), "tier"),
            "TEST base tier"
        );
        assert_eq!(
            arr(call(&b, ADA, "currencies.list", input)
                .ok()
                .get("currencies")
                .unwrap())
            .len(),
            1
        );
    }
    assert_eq!(
        call(&b, ADA, "accounts.profile", r#"{"profile":"personal"}"#)
            .ok()
            .compact(),
        r#"{"profile":"personal","kind":"personal","business":null}"#
    );
    assert_eq!(
        text(
            &call(
                &b,
                ADA,
                "currencies.add",
                r#"{"assetId":"USDC","profile":"personal"}"#
            )
            .ok(),
            "assetId"
        ),
        "USDC"
    );
}

#[test]
fn a_business_the_caller_holds_reads_back_with_its_name_and_their_role_and_has_no_company_account_to_show()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    ledger.fund(ADA, "USDT", "100");
    business(&db, ADA_CO, "Ada TEST Studio", ADA);
    let b = bank(&db, &ledger, &profiled());
    currencies(&b, ADA);
    let profile = format!("business:{ADA_CO}");
    assert_eq!(
        call(&b, ADA, "accounts.profile", &with_profile(&profile, ""))
            .ok()
            .compact(),
        format!(
            r#"{{"profile":"{profile}","kind":"business","business":{{"accountId":"{ADA_CO}","name":"Ada TEST Studio","role":"admin"}}}}"#
        )
    );
    // A member who is not an admin sees their own role.
    db.client()
        .execute("INSERT INTO bank.business_members (account_id, user_id, role) VALUES ($1::text::uuid, $2, 'viewer')", &[&ADA_CO, &BOB])
        .unwrap();
    let bob = call(&b, BOB, "accounts.profile", &with_profile(&profile, "")).ok();
    assert_eq!(text(bob.get("business").unwrap(), "role"), "viewer");

    let before = footprint(&db);
    for (path, rest) in [
        ("accounts.features", ""),
        ("currencies.list", ""),
        ("currencies.add", r#""assetId":"USDC","#),
        ("currencies.remove", r#""assetId":"USDT","#),
    ] {
        let a = call(&b, ADA, path, &with_profile(&profile, rest));
        assert_eq!(
            (a.trpc(), a.code()),
            (
                "PRECONDITION_FAILED".to_owned(),
                "bank.company_account_unwired".to_owned()
            ),
            "{path}"
        );
    }
    // Personal money is not moved, labelled or hidden by a business call.
    assert_eq!(footprint(&db), before);
    let listed = arr(currencies(&b, ADA).get("currencies").unwrap());
    assert_eq!(
        (text(&listed[0], "assetId"), text(&listed[0], "balance")),
        ("USDT".to_owned(), "100".to_owned())
    );
}

#[test]
fn a_profile_the_caller_does_not_hold_is_refused_with_one_answer_and_no_side_effect() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    ledger.fund(ADA, "USDT", "100");
    business(&db, ADA_CO, "Ada TEST Studio", ADA);
    business(&db, BOB_CO, "Bob TEST Works", BOB);
    let closed_own = uuid();
    business(&db, &closed_own, "Ada TEST Closed", ADA);
    let mut c = db.client();
    for id in [BOB_CO, closed_own.as_str()] {
        c.execute(
            "UPDATE bank.business_accounts SET status = 'closed' WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    }
    let b = bank(&db, &ledger, &profiled());
    currencies(&b, ADA);
    let before = footprint(&db);
    for profile in [
        format!("business:{BOB_CO}"),
        format!("business:{}", uuid()),
        format!("business:{closed_own}"),
    ] {
        for (path, rest) in [
            ("accounts.profile", ""),
            ("accounts.features", ""),
            ("currencies.list", ""),
            ("currencies.add", r#""assetId":"USDC","#),
            ("currencies.remove", r#""assetId":"USDT","#),
        ] {
            let a = call(&b, ADA, path, &with_profile(&profile, rest));
            assert_eq!(
                (a.trpc(), a.code()),
                ("FORBIDDEN".to_owned(), "bank.profile_not_held".to_owned()),
                "{path} {profile}"
            );
        }
    }
    assert_eq!(footprint(&db), before);
    assert_eq!(
        arr(
            call(&b, ADA, "currencies.list", r#"{"profile":"personal"}"#)
                .ok()
                .get("currencies")
                .unwrap()
        )
        .len(),
        1
    );
}

#[test]
fn a_profile_that_is_not_in_the_stored_form_is_a_bad_request_never_a_business_lookup() {
    let Some(db) = db() else { return };
    business(&db, ADA_CO, "Ada TEST Studio", ADA);
    let b = bank(&db, &Book::default(), &profiled());
    for profile in [
        "business:".to_owned(),
        "business:not-a-uuid".to_owned(),
        format!("company:{ADA_CO}"),
        ADA_CO.to_owned(),
        String::new(),
    ] {
        assert_eq!(
            call(&b, ADA, "accounts.profile", &with_profile(&profile, "")).trpc(),
            "BAD_REQUEST",
            "{profile}"
        );
    }
    // Case and spaces are the same profile.
    let upper = format!(" BUSINESS:{} ", ADA_CO.to_uppercase());
    let got = call(&b, ADA, "accounts.profile", &with_profile(&upper, "")).ok();
    assert_eq!(text(got.get("business").unwrap(), "accountId"), ADA_CO);
}

// ---------------------------------------------------------------------------------------------------------------
// `shared-pots.db.test.ts` (BK-acct-09). Adding to or taking from a pot (`transfers.create`) is slice `transfers`'s,
// and a card's own doors (`cards.*`) slice `cards`'s.

fn joint(minutes: Option<&'static str>, cap: Option<&'static str>) -> Owner {
    Owner {
        invite_minutes: minutes,
        people_cap: cap,
        ..limit5()
    }
}

/// The owner's pot holding 10, the partner and the viewer each with 20 in their own account.
fn shared_pot(b: &Bank, ledger: &Book) -> String {
    ledger.fund(OWNER, "USDT", "10");
    let pot = text(
        &call(
            b,
            OWNER,
            "spaces.create",
            r#"{"assetId":"USDT","name":"Holiday TEST"}"#,
        )
        .ok(),
        "id",
    );
    ledger.fill_pot(OWNER, &pot, "USDT", "10");
    for who in [PARTNER, VIEWER] {
        ledger.fund(who, "USDT", "20");
    }
    pot
}

fn invite(b: &Bank, pot: &str, who: &str, role: &str) -> Answer {
    let by = if who.contains('@') && !who.starts_with('@') {
        "email"
    } else {
        "handle"
    };
    call(
        b,
        OWNER,
        "sharedPots.invite",
        &format!(
            r#"{{"inviteId":"{}","spaceId":"{pot}","{by}":"{who}","role":"{role}"}}"#,
            uuid()
        ),
    )
}

fn invited(b: &Bank, pot: &str, who: &str, role: &str) -> String {
    text(&invite(b, pot, who, role).ok(), "inviteId")
}

fn answer(b: &Bank, user: &str, path: &str, invite: &str) -> Answer {
    call(b, user, path, &format!(r#"{{"inviteId":"{invite}"}}"#))
}

fn shared_list(b: &Bank, user: &str) -> Json {
    call(b, user, "sharedPots.list", r#"{"limit":50}"#).ok()
}

fn refused(a: &Answer, code: &str, trpc: &str) {
    assert_eq!(
        (a.code(), a.trpc()),
        (code.to_owned(), trpc.to_owned()),
        "{}",
        a.1.compact()
    );
}

#[test]
fn a_contributor_and_a_viewer_join_by_handle_and_email_and_each_sees_the_pot_its_balance_and_its_members()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let as_partner = invite(&b, &pot, "@pia_partner", "contributor").ok();
    assert_eq!(
        as_partner.get("invitee").unwrap().compact(),
        format!(r#"{{"userId":"{PARTNER}","handle":"Pia_Partner"}}"#)
    );
    let as_viewer = invite(&b, &pot, "vic@example.com", "viewer").ok();
    assert_eq!(
        ms(&text(&as_viewer, "expiresAt")) - ms(&text(&as_viewer, "createdAt")),
        60 * 60_000
    );

    let mine = shared_list(&b, PARTNER);
    let invites: Vec<_> = arr(mine.get("invites").unwrap())
        .iter()
        .map(|i| {
            (
                text(i.get("pot").unwrap(), "name"),
                text(i.get("owner").unwrap(), "handle"),
                text(i, "role"),
                text(i, "expired"),
            )
        })
        .collect();
    assert_eq!(
        invites,
        vec![(
            "Holiday TEST".to_owned(),
            "Olga_Owner".to_owned(),
            "contributor".to_owned(),
            "false".to_owned()
        )]
    );
    let joined = format!(r#"{{"spaceId":"{pot}","role":"contributor"}}"#);
    assert_eq!(
        answer(
            &b,
            PARTNER,
            "sharedPots.accept",
            &text(&as_partner, "inviteId")
        )
        .ok()
        .compact(),
        joined
    );
    // Accepting again returns the same membership.
    assert_eq!(
        answer(
            &b,
            PARTNER,
            "sharedPots.accept",
            &text(&as_partner, "inviteId")
        )
        .ok()
        .compact(),
        joined
    );
    answer(
        &b,
        VIEWER,
        "sharedPots.accept",
        &text(&as_viewer, "inviteId"),
    )
    .ok();

    let seen = shared_list(&b, VIEWER);
    let shared = arr(seen.get("shared").unwrap());
    assert_eq!(shared.len(), 1);
    let p = shared[0].get("pot").unwrap();
    assert_eq!(
        (
            text(p, "name"),
            text(p, "balance"),
            text(shared[0].get("owner").unwrap(), "handle"),
            text(&shared[0], "role")
        ),
        (
            "Holiday TEST".to_owned(),
            "10".to_owned(),
            "Olga_Owner".to_owned(),
            "viewer".to_owned()
        )
    );
    let members: Vec<_> = arr(shared[0].get("members").unwrap())
        .iter()
        .map(|m| (text(m, "handle"), text(m, "role")))
        .collect();
    assert_eq!(
        members,
        vec![
            ("Pia_Partner".to_owned(), "contributor".to_owned()),
            ("Vic_Viewer".to_owned(), "viewer".to_owned())
        ]
    );
}

#[test]
fn an_invite_past_its_lifetime_refuses_bank_invite_expired_and_nobody_joins() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let made = invited(&b, &pot, "Vic_Viewer", "viewer");
    db.client()
        .execute(
            "UPDATE bank.shared_pot_invites SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1::text::uuid",
            &[&made],
        )
        .unwrap();
    let expired: Vec<_> = arr(shared_list(&b, VIEWER).get("invites").unwrap())
        .iter()
        .map(|i| text(i, "expired"))
        .collect();
    assert_eq!(expired, ["true"]);
    refused(
        &answer(&b, VIEWER, "sharedPots.accept", &made),
        "bank.invite_expired",
        "CONFLICT",
    );
    assert_eq!(
        shared_list(&b, VIEWER).get("shared").unwrap().compact(),
        "[]"
    );
    // An expired invite no longer holds a place, and the owner can ask again.
    let again = invited(&b, &pot, "Vic_Viewer", "viewer");
    assert_eq!(
        text(
            &answer(&b, VIEWER, "sharedPots.accept", &again).ok(),
            "role"
        ),
        "viewer"
    );
}

#[test]
fn a_pot_shared_with_the_cap_open_invites_included_refuses_another_invite() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let first = invited(&b, &pot, "Pia_Partner", "contributor");
    invited(&b, &pot, "Vic_Viewer", "viewer");
    refused(
        &invite(&b, &pot, "Tom_Third", "viewer"),
        "bank.shared_pot_full",
        "CONFLICT",
    );
    answer(&b, PARTNER, "sharedPots.accept", &first).ok();
    refused(
        &invite(&b, &pot, "Tom_Third", "viewer"),
        "bank.shared_pot_full",
        "CONFLICT",
    );
    // A member who leaves frees the place.
    call(&b, PARTNER, "sharedPots.leave", &space_id(&pot)).ok();
    invite(&b, &pot, "Tom_Third", "viewer").ok();
}

#[test]
fn the_same_invite_id_returns_the_same_invite_a_different_invite_under_it_yourself_a_member_a_frozen_or_unknown_person_refuse()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let id = uuid();
    let ask = |user: &str, sp: &str, handle: &str, role: &str, id: &str| {
        call(
            &b,
            user,
            "sharedPots.invite",
            &format!(
                r#"{{"inviteId":"{id}","spaceId":"{sp}","handle":"{handle}","role":"{role}"}}"#
            ),
        )
    };
    let made = ask(OWNER, &pot, "Pia_Partner", "contributor", &id).ok();
    assert_eq!(
        ask(OWNER, &pot, "Pia_Partner", "contributor", &id).ok(),
        made
    );
    refused(
        &ask(OWNER, &pot, "Pia_Partner", "viewer", &id),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
    refused(
        &ask(OWNER, &pot, "Pia_Partner", "viewer", &uuid()),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
    refused(
        &ask(OWNER, &pot, "Olga_Owner", "viewer", &uuid()),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
    for handle in ["Fro_Zen", "nobody_here"] {
        refused(
            &ask(OWNER, &pot, handle, "viewer", &uuid()),
            "bank.invitee_not_found",
            "NOT_FOUND",
        );
    }
    // Only the owner's own live named pot can be shared.
    let main = primary(&b, OWNER, "USDT");
    refused(
        &ask(OWNER, &main, "Tom_Third", "viewer", &uuid()),
        "bank.space_change_invalid",
        "BAD_REQUEST",
    );
    refused(
        &ask(PARTNER, &pot, "Tom_Third", "viewer", &uuid()),
        "bank.space_not_found",
        "NOT_FOUND",
    );
    // A pot that is not theirs answers the same whether the person exists or not: the directory is never asked.
    refused(
        &ask(PARTNER, &pot, "nobody_here", "viewer", &uuid()),
        "bank.space_not_found",
        "NOT_FOUND",
    );
    answer(&b, PARTNER, "sharedPots.accept", &id).ok();
    refused(
        &ask(OWNER, &pot, "Pia_Partner", "viewer", &uuid()),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
}

fn log(b: &Bank, user: &str, pot: &str, extra: &str) -> Answer {
    call(
        b,
        user,
        "sharedPots.activity",
        &format!(r#"{{"spaceId":"{pot}"{extra}}}"#),
    )
}

fn handle_of(e: &Json, key: &str) -> String {
    match e.get(key) {
        Some(Json::Null) | None => "null".to_owned(),
        Some(p) => text(p, "handle"),
    }
}

#[test]
fn the_log_names_who_invited_joined_declined_left_and_was_removed_newest_first_for_the_owner_and_members_only()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("3")));
    let pot = shared_pot(&b, &ledger);
    let a = invited(&b, &pot, "Pia_Partner", "contributor");
    let v = invited(&b, &pot, "Vic_Viewer", "viewer");
    let c = invited(&b, &pot, "Tom_Third", "viewer");
    answer(&b, PARTNER, "sharedPots.accept", &a).ok();
    answer(&b, VIEWER, "sharedPots.accept", &v).ok();
    answer(&b, THIRD, "sharedPots.decline", &c).ok();
    refused(
        &answer(&b, THIRD, "sharedPots.accept", &c),
        "bank.invite_not_found",
        "NOT_FOUND",
    );
    call(&b, VIEWER, "sharedPots.leave", &space_id(&pot)).ok();
    call(
        &b,
        OWNER,
        "sharedPots.remove",
        &format!(r#"{{"spaceId":"{pot}","userId":"{PARTNER}"}}"#),
    )
    .ok();

    let entries = arr(&log(&b, OWNER, &pot, r#","limit":50"#).ok());
    let seen: Vec<_> = entries
        .iter()
        .map(|e| {
            format!(
                "{} {} {} {}",
                text(e, "kind"),
                handle_of(e, "actor"),
                handle_of(e, "subject"),
                text(e, "role")
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            "removed Olga_Owner Pia_Partner contributor",
            "left Vic_Viewer null viewer",
            "declined Tom_Third null viewer",
            "joined Vic_Viewer null viewer",
            "joined Pia_Partner null contributor",
            "invited Olga_Owner Tom_Third viewer",
            "invited Olga_Owner Vic_Viewer viewer",
            "invited Olga_Owner Pia_Partner contributor",
        ]
    );
    let older = arr(&log(
        &b,
        OWNER,
        &pot,
        &format!(r#","limit":2,"before":"{}""#, text(&entries[5], "id")),
    )
    .ok());
    assert_eq!(
        older
            .iter()
            .map(|e| handle_of(e, "subject"))
            .collect::<Vec<_>>(),
        ["Vic_Viewer", "Pia_Partner"]
    );
    // Gone from the pot, gone from its log.
    refused(
        &log(&b, PARTNER, &pot, r#","limit":50"#),
        "bank.space_not_found",
        "NOT_FOUND",
    );
    assert_eq!(shared_list(&b, OWNER).get("owned").unwrap().compact(), "[]");
}

#[test]
fn blank_owner_values_refuse_bank_joint_unset_and_the_list_says_they_are_not_set_a_blank_page_size_refuses()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(None, None));
    let pot = shared_pot(&b, &ledger);
    refused(
        &invite(&b, &pot, "Pia_Partner", "viewer"),
        "bank.joint_unset",
        "PRECONDITION_FAILED",
    );
    assert_eq!(
        shared_list(&b, OWNER).get("terms").unwrap().compact(),
        r#"{"inviteMinutes":null,"peopleCap":null}"#
    );
    refused(
        &call(&b, OWNER, "sharedPots.list", "{}"),
        "bank.shared_pots_list_limit_unset",
        "BAD_REQUEST",
    );
    refused(
        &log(&b, OWNER, &pot, ""),
        "bank.shared_pots_list_limit_unset",
        "BAD_REQUEST",
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.shared_pot_invites"), 0);
}

#[test]
fn the_owner_cancels_an_open_invite_which_frees_its_place_a_used_invite_opens_nothing_once_its_member_has_gone()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let wrong = invited(&b, &pot, "Tom_Third", "viewer");
    let right = invited(&b, &pot, "Pia_Partner", "contributor");
    refused(
        &invite(&b, &pot, "Vic_Viewer", "viewer"),
        "bank.shared_pot_full",
        "CONFLICT",
    );
    // Only the owner cancels; cancelling twice changes nothing; the cancelled invite opens nothing.
    refused(
        &answer(&b, THIRD, "sharedPots.cancelInvite", &wrong),
        "bank.space_not_found",
        "NOT_FOUND",
    );
    assert_eq!(
        answer(&b, OWNER, "sharedPots.cancelInvite", &wrong)
            .ok()
            .compact(),
        r#"{"cancelled":true}"#
    );
    assert_eq!(
        answer(&b, OWNER, "sharedPots.cancelInvite", &wrong)
            .ok()
            .compact(),
        r#"{"cancelled":true}"#
    );
    refused(
        &answer(&b, THIRD, "sharedPots.accept", &wrong),
        "bank.invite_not_found",
        "NOT_FOUND",
    );
    assert_eq!(
        shared_list(&b, THIRD).get("invites").unwrap().compact(),
        "[]"
    );
    invite(&b, &pot, "Vic_Viewer", "viewer").ok();

    // An answered invite cannot be cancelled.
    answer(&b, PARTNER, "sharedPots.accept", &right).ok();
    refused(
        &answer(&b, OWNER, "sharedPots.cancelInvite", &right),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
    // Accepting again answers while the membership lasts; after leaving, the used invite opens nothing.
    assert_eq!(
        answer(&b, PARTNER, "sharedPots.accept", &right)
            .ok()
            .compact(),
        format!(r#"{{"spaceId":"{pot}","role":"contributor"}}"#)
    );
    call(&b, PARTNER, "sharedPots.leave", &space_id(&pot)).ok();
    refused(
        &answer(&b, PARTNER, "sharedPots.accept", &right),
        "bank.invite_not_found",
        "NOT_FOUND",
    );
    assert_eq!(
        shared_list(&b, PARTNER).get("shared").unwrap().compact(),
        "[]"
    );
    let seen: Vec<_> = arr(&log(&b, OWNER, &pot, r#","limit":50"#).ok())
        .iter()
        .map(|e| {
            format!(
                "{} {} {}",
                text(e, "kind"),
                handle_of(e, "actor"),
                handle_of(e, "subject")
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            "left Pia_Partner null",
            "joined Pia_Partner null",
            "invited Olga_Owner Vic_Viewer",
            "cancelled Olga_Owner Tom_Third",
            "invited Olga_Owner Pia_Partner",
            "invited Olga_Owner Tom_Third",
        ]
    );
}

/// What `cards.issue` writes for the TEST card programme.
fn card(db: &TestDb, user: &str, issuer: &str) -> (String, String) {
    let id = uuid();
    let tail = "4242".to_owned();
    db.client()
        .execute(
            "INSERT INTO bank.cards (id, user_id, asset_id, issuer, simulated, issuer_ref, pan_tail, per_authorization_limit, settlement_asset_id) \
             VALUES ($1::text::uuid, $2, 'USDT', $3, true, $1, $4, 50, 'USDT')",
            &[&id, &user, &issuer, &tail],
        )
        .unwrap();
    (id, tail)
}

#[test]
fn a_holder_may_freeze_the_card_linked_to_the_pot_a_viewer_cannot_and_only_the_owner_links_and_unlinks()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    for (who, handle, role) in [
        (PARTNER, "Pia_Partner", "contributor"),
        (VIEWER, "Vic_Viewer", "viewer"),
    ] {
        let made = invited(&b, &pot, handle, role);
        answer(&b, who, "sharedPots.accept", &made).ok();
    }
    let (card_id, tail) = card(&db, OWNER, "card-sim");
    let (theirs, _) = card(&db, PARTNER, "card-sim");
    let link = |user: &str, sp: &str, c: &str| {
        call(
            &b,
            user,
            "sharedPots.linkCard",
            &format!(r#"{{"spaceId":"{sp}","cardId":"{c}"}}"#),
        )
    };
    let freeze = |user: &str| call(&b, user, "sharedPots.freezeCard", &space_id(&pot));

    // No card yet: nothing to freeze. Only the owner links, and only their own card.
    refused(&freeze(PARTNER), "bank.card_not_found", "BAD_REQUEST");
    refused(
        &link(PARTNER, &pot, &theirs),
        "bank.space_not_found",
        "NOT_FOUND",
    );
    refused(
        &link(OWNER, &pot, &theirs),
        "bank.card_not_found",
        "BAD_REQUEST",
    );
    let linked = link(OWNER, &pot, &card_id).ok();
    assert_eq!(
        linked.compact(),
        format!(r#"{{"cardId":"{card_id}","panTail":"{tail}","status":"active","frozenBy":null}}"#)
    );
    assert_eq!(link(OWNER, &pot, &card_id).ok(), linked);
    let other = created(&b, OWNER, "USDT", "Other TEST");
    refused(
        &link(OWNER, &other, &card_id),
        "bank.shared_pot_invalid",
        "BAD_REQUEST",
    );
    assert_eq!(
        arr(shared_list(&b, PARTNER).get("shared").unwrap())[0]
            .get("card")
            .unwrap(),
        &linked
    );

    // A viewer cannot freeze it; a stranger is told the pot is not found. A contributor's freeze passes the pot's
    // checks, and the card's status is slice `cards`'s to set: until it is ported it answers "not ported".
    refused(&freeze(VIEWER), "bank.space_forbidden", "FORBIDDEN");
    refused(&freeze(THIRD), "bank.space_not_found", "NOT_FOUND");
    let holder = freeze(PARTNER);
    assert_eq!(
        (holder.0, holder.message()),
        (
            500,
            "svc-bank in Rust: the cards slice is not ported".to_owned()
        )
    );

    assert_eq!(
        call(&b, PARTNER, "sharedPots.unlinkCard", &space_id(&pot)).code(),
        "bank.space_not_found"
    );
    assert_eq!(
        call(&b, OWNER, "sharedPots.unlinkCard", &space_id(&pot))
            .ok()
            .compact(),
        r#"{"unlinked":true}"#
    );
    assert_eq!(
        call(&b, OWNER, "sharedPots.unlinkCard", &space_id(&pot))
            .ok()
            .compact(),
        r#"{"unlinked":true}"#
    );
    refused(&freeze(PARTNER), "bank.card_not_found", "BAD_REQUEST");
    let entries = arr(&log(&b, VIEWER, &pot, r#","limit":50"#).ok());
    let seen: Vec<_> = entries
        .iter()
        .take(2)
        .map(|e| {
            format!(
                "{} {} {}",
                text(e, "kind"),
                handle_of(e, "actor"),
                e.get("card")
                    .map_or("null".to_owned(), |c| text(c, "panTail"))
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            format!("card_unlinked Olga_Owner {tail}"),
            format!("card_linked Olga_Owner {tail}")
        ]
    );
    assert_eq!(entries[2].get("card"), Some(&Json::Null));
}

#[test]
fn one_card_is_linked_to_one_pot_even_when_asked_twice_at_once_and_a_card_from_another_programme_is_never_linked()
 {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &joint(Some("60"), Some("2")));
    let pot = shared_pot(&b, &ledger);
    let other = created(&b, OWNER, "USDT", "Other TEST");
    let (card_id, _) = card(&db, OWNER, "card-sim");
    let link = |sp: &str, c: &str| {
        call(
            &b,
            OWNER,
            "sharedPots.linkCard",
            &format!(r#"{{"spaceId":"{sp}","cardId":"{c}"}}"#),
        )
    };
    let both: Vec<Answer> = std::thread::scope(|s| {
        let one = s.spawn(|| link(&pot, &card_id));
        let two = s.spawn(|| link(&other, &card_id));
        vec![one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(both.iter().filter(|a| a.0 == 200).count(), 1);
    if let Some(lost) = both.iter().find(|a| a.0 != 200) {
        refused(lost, "bank.shared_pot_invalid", "BAD_REQUEST");
    }
    let (foreign, _) = card(&db, OWNER, "another-programme");
    let third = created(&b, OWNER, "USDT", "Third TEST");
    refused(
        &link(&third, &foreign),
        "bank.card_not_active",
        "BAD_REQUEST",
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `dormancy/dormancy.db.test.ts` (RC-bank-01, J-bank-16 #7), through `ops.runDormancy` against the TEST partner.

const RULES: &str =
    r#"[{"assetId":"USDT","fee":"5","inactiveDays":365,"noticeLeadDays":30,"version":"test-1"}]"#;

struct Dormant {
    b: Bank,
    user: String,
}

fn dormant(db: &TestDb) -> Dormant {
    let b = bank(
        db,
        &Book::default(),
        &Owner {
            dormancy: Some(RULES.to_owned()),
            ..Owner::default()
        },
    );
    let user = held(&b);
    Dormant { b, user }
}

fn held(b: &Bank) -> String {
    let id = uuid();
    call(b, &id, "testPartner.set", r#"{"custody":"off"}"#).ok();
    id
}

impl Dormant {
    fn partner(&self) -> &TestPartner {
        self.b.door.partner().partner.as_ref().unwrap()
    }
    fn fund(&self, amount: &str) {
        call(
            &self.b,
            &self.user,
            "testPartner.fund",
            &format!(
                r#"{{"fundId":"{}","assetId":"USDT","amount":"{amount}"}}"#,
                uuid()
            ),
        )
        .ok();
    }
    fn balance(&self) -> String {
        let account = svc_bank::partner::AccountRef::main(&self.user, "USDT");
        self.partner()
            .lock()
            .report(&account, Instant(now()))
            .amount
            .map_or("none".to_owned(), format_amount)
    }
    /// Money leaves the person now, to another TEST person at the partner.
    fn spend(&self, amount: &str) {
        self.partner()
            .lock()
            .move_raw(
                &svc_bank::partner::MoveRequest {
                    key: format!("spend:{}", uuid()),
                    from: svc_bank::partner::AccountRef::main(&self.user, "USDT"),
                    to: svc_bank::partner::AccountRef::main(&uuid(), "USDT"),
                    amount: amt(amount),
                    payees: None,
                },
                Instant(now()),
            )
            .unwrap();
    }
    fn run(&self, at: i64, users: &[&str]) -> Answer {
        let ids: Vec<Json> = users.iter().map(|u| Json::str(*u)).collect();
        let input =
            Json::obj([("at", Json::str(iso(at))), ("userIds", Json::Array(ids))]).compact();
        as_service(&self.b, Some("svc-bank"), "ops.runDormancy", &input)
    }
    fn mine(&self, at: i64) -> Json {
        self.run(at, &[&self.user]).ok()
    }
    fn notices(&self) -> Vec<Json> {
        arr(&call(&self.b, &self.user, "dormancy.notices", "").ok())
    }
    fn charged(&self, at: i64) -> Option<svc_bank::partner::Move> {
        self.partner()
            .lock()
            .book
            .by_key(&format!(
                "fee:bank.dormancy:{}:USDT:{}",
                self.user,
                debit_day(at)
            ))
            .cloned()
    }
}

fn quiet_until() -> i64 {
    now() + 366 * DAY
}

fn debit_day(at: i64) -> String {
    iso(at + 30 * DAY)[..10].to_owned()
}

fn due(at: i64) -> i64 {
    ms(&format!("{}T00:01:00Z", debit_day(at)))
}

fn outcomes(j: &Json) -> Vec<String> {
    arr(j.get("settled").unwrap())
        .iter()
        .map(|s| text(s, "outcome"))
        .collect()
}

#[test]
fn notices_a_quiet_account_once_naming_the_fee_and_the_debit_date() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let at = quiet_until();
    assert_eq!(
        d.mine(at).get("noticed").unwrap().compact(),
        format!(
            r#"[{{"userId":"{}","assetId":"USDT","fee":"5","debitDate":"{}"}}]"#,
            d.user,
            debit_day(at)
        )
    );
    assert_eq!(d.mine(at).get("noticed").unwrap().compact(), "[]");
    let n = d.notices();
    assert_eq!(
        (
            n.len(),
            text(&n[0], "state"),
            text(&n[0], "fee"),
            text(&n[0], "debitDate")
        ),
        (1, "noticed".to_owned(), "5".to_owned(), debit_day(at))
    );
    // Too early for a debit: nothing settles.
    assert_eq!(d.mine(at + DAY).get("settled").unwrap().compact(), "[]");
}

#[test]
fn gives_no_notice_to_an_account_active_within_the_rule_or_one_that_never_moved() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    assert_eq!(
        d.mine(now() + 100 * DAY).get("noticed").unwrap().compact(),
        "[]"
    );
    let never = held(&d.b);
    assert_eq!(
        d.run(quiet_until(), &[&never])
            .ok()
            .get("noticed")
            .unwrap()
            .compact(),
        "[]"
    );
}

#[test]
fn passes_over_a_person_the_partner_does_not_hold_money_for_and_posts_nothing_for_them() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let custodial = uuid();
    assert_eq!(
        d.run(quiet_until(), &[&custodial]).ok().compact(),
        r#"{"noticed":[],"settled":[]}"#
    );
    assert!(arr(&call(&d.b, &custodial, "dormancy.notices", "").ok()).is_empty());
}

#[test]
fn takes_no_fee_after_a_full_withdrawal_a_zero_balance_on_the_debit_date_is_skipped_zero() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let at = quiet_until();
    d.mine(at);
    d.spend("20");
    assert_eq!(d.balance(), "0");
    assert_eq!(
        d.mine(due(at)).get("settled").unwrap().compact(),
        format!(
            r#"[{{"userId":"{}","assetId":"USDT","debitDate":"{}","outcome":"skipped_zero"}}]"#,
            d.user,
            debit_day(at)
        )
    );
    assert_eq!(d.balance(), "0");
    assert!(d.charged(at).is_none());
    let n = &d.notices()[0];
    assert_eq!(
        (text(n, "state"), text(n, "partnerMoveId")),
        ("skipped_zero".to_owned(), "null".to_owned())
    );
}

#[test]
fn cancels_the_notice_on_activity_after_it() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    // Noticed an hour ago on a quiet account; the line below is after that notice.
    let at = now() - HOUR;
    d.fund("20");
    d.mine(at);
    assert_eq!(outcomes(&d.mine(due(at))), ["cancelled"]);
    assert_eq!(d.balance(), "20");
    assert!(d.charged(at).is_none());
}

#[test]
fn skips_a_balance_below_the_fee_on_the_debit_date_without_part_charging() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("6");
    let at = quiet_until();
    d.mine(at);
    d.spend("3");
    assert_eq!(outcomes(&d.mine(due(at))), ["skipped_insufficient"]);
    assert_eq!(d.balance(), "3");
}

#[test]
fn gives_no_notice_to_an_account_holding_less_than_the_fee() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("4.99");
    assert_eq!(
        d.mine(quiet_until()).get("noticed").unwrap().compact(),
        "[]"
    );
}

#[test]
fn decides_nothing_on_a_figure_the_partner_has_not_given_no_notice_and_an_open_notice_waits() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let at = quiet_until();
    call(&d.b, &d.user, "testPartner.set", r#"{"figures":"unknown"}"#).ok();
    assert_eq!(d.mine(at).get("noticed").unwrap().compact(), "[]");
    call(&d.b, &d.user, "testPartner.set", r#"{"figures":"live"}"#).ok();
    d.mine(at);
    call(&d.b, &d.user, "testPartner.set", r#"{"figures":"stale"}"#).ok();
    assert_eq!(d.mine(due(at)).get("settled").unwrap().compact(), "[]");
    assert_eq!(text(&d.notices()[0], "state"), "noticed");
    call(&d.b, &d.user, "testPartner.set", r#"{"figures":"live"}"#).ok();
    assert_eq!(d.balance(), "20");
}

#[test]
fn adopts_a_fee_the_partner_already_took_under_the_notice_key_so_a_crash_before_the_row_was_settled_never_re_judges_it()
 {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("7");
    let at = quiet_until();
    d.mine(at);
    let taken = d
        .partner()
        .lock()
        .move_raw(
            &svc_bank::partner::MoveRequest {
                key: format!("fee:bank.dormancy:{}:USDT:{}", d.user, debit_day(at)),
                from: svc_bank::partner::AccountRef::main(&d.user, "USDT"),
                to: svc_bank::partner::fees_account("USDT"),
                amount: amt("5"),
                payees: None,
            },
            Instant(now()),
        )
        .unwrap();
    assert_eq!(outcomes(&d.mine(due(at))), ["charged"]);
    assert_eq!(d.balance(), "2");
    let n = &d.notices()[0];
    assert_eq!(
        (text(n, "state"), text(n, "partnerMoveId")),
        ("charged".to_owned(), taken.id)
    );
}

#[test]
fn survives_a_lost_reply_the_fee_is_taken_once_and_the_next_run_settles_it() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let at = quiet_until();
    d.mine(at);
    call(&d.b, &d.user, "testPartner.set", r#"{"nextReply":"lost"}"#).ok();
    assert_eq!(d.run(due(at), &[&d.user]).code(), "bank.partner_reply_lost");
    assert_eq!(text(&d.notices()[0], "state"), "noticed");
    assert_eq!(outcomes(&d.mine(due(at))), ["charged"]);
    assert_eq!(d.balance(), "15");
}

#[test]
fn has_the_partner_take_the_noticed_fee_once_under_its_key_and_a_replay_takes_nothing_more() {
    let Some(db) = db() else { return };
    let d = dormant(&db);
    d.fund("20");
    let at = quiet_until();
    d.mine(at);
    assert_eq!(outcomes(&d.mine(due(at))), ["charged"]);
    assert_eq!(d.mine(due(at)).get("settled").unwrap().compact(), "[]");
    assert_eq!(d.balance(), "15");
    let taken = d.charged(at).expect("the fee is under its key");
    assert_eq!(
        (taken.amount, taken.to.clone()),
        (amt("5"), svc_bank::partner::fees_account("USDT"))
    );
    let n = &d.notices()[0];
    assert_eq!(
        (text(n, "state"), text(n, "partnerMoveId")),
        ("charged".to_owned(), taken.id)
    );
}

#[test]
fn refuses_bank_dormancy_rule_unset_with_no_rule_and_reads_a_rule_not_in_shape_as_none() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    for rules in [
        None,
        Some(
            r#"[{"assetId":"USDT","fee":5,"inactiveDays":365,"noticeLeadDays":30,"version":"x"}]"#,
        ),
        Some(
            r#"[{"assetId":"USDT","fee":"0","inactiveDays":365,"noticeLeadDays":30,"version":"x"}]"#,
        ),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                dormancy: rules.map(str::to_owned),
                ..Owner::default()
            },
        );
        let user = held(&b);
        let input = Json::obj([
            ("at", Json::str(iso(quiet_until()))),
            ("userIds", Json::Array(vec![Json::str(user.clone())])),
        ])
        .compact();
        assert_eq!(
            as_service(&b, Some("svc-bank"), "ops.runDormancy", &input).code(),
            "bank.dormancy_rule_unset"
        );
        assert_eq!(
            call(&b, &user, "dormancy.rules", "").code(),
            "bank.dormancy_rule_unset"
        );
    }
    let b = bank(
        &db,
        &ledger,
        &Owner {
            dormancy: Some(RULES.to_owned()),
            ..Owner::default()
        },
    );
    assert_eq!(
        call(&b, ADA, "dormancy.rules", "").ok().compact(),
        r#"[{"assetId":"USDT","fee":"5","inactiveDays":365,"noticeLeadDays":30,"version":"test-1"}]"#
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `plans/plans.test.ts` and `assets/supported-assets.test.ts`, through the door

const TABLE: &str = r#"{"defaultPlanId":"standard","plans":[{"id":"standard","name":"TEST Standard","tier":"standard","price":"0","assetId":"USDT","period":"month"},{"id":"plus","name":"TEST Plus","tier":"plus","price":"4.990","assetId":"USDT","period":"month"}]}"#;

#[test]
fn reads_the_plans_and_puts_a_person_who_never_subscribed_on_the_default_plan_a_paid_plan_names_its_blocker()
 {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        &Book::default(),
        &Owner {
            plans: Some(TABLE.to_owned()),
            ..Owner::default()
        },
    );
    let view = call(&b, ADA, "plans.list", "").ok();
    let current = view.get("current").unwrap();
    assert_eq!(
        (
            text(current, "id"),
            text(current, "price"),
            text(current, "period")
        ),
        ("standard".to_owned(), "0".to_owned(), "month".to_owned())
    );
    let plans: Vec<_> = arr(view.get("plans").unwrap())
        .iter()
        .map(|p| (text(p, "id"), text(p, "price"), text(p, "blocker")))
        .collect();
    assert_eq!(
        plans,
        vec![
            ("standard".to_owned(), "0".to_owned(), "null".to_owned()),
            (
                "plus".to_owned(),
                "4.99".to_owned(),
                "bank.plan_fee_unwired".to_owned()
            ),
        ]
    );
}

#[test]
fn refuses_bank_plans_unset_when_the_table_is_blank_or_not_in_shape_and_invents_no_plan() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let gone = TABLE.replace(r#""defaultPlanId":"standard""#, r#""defaultPlanId":"gone""#);
    let priced = TABLE.replace(r#""price":"4.990""#, r#""price":4.99"#);
    for raw in [
        None,
        Some(""),
        Some("  "),
        Some("{"),
        Some(r#"{"plans":[]}"#),
        Some(gone.as_str()),
        Some(priced.as_str()),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                plans: raw.map(str::to_owned),
                ..Owner::default()
            },
        );
        assert_eq!(
            call(&b, ADA, "plans.list", "").code(),
            "bank.plans_unset",
            "{raw:?}"
        );
    }
}

#[test]
fn reads_a_blank_fee_table_as_none_published_and_refuses_a_line_not_in_shape() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    for (raw, want) in [
        (None, r#"{"set":false,"lines":[]}"#),
        (Some(""), r#"{"set":false,"lines":[]}"#),
        (
            Some(
                r#"{"lines":[{"id":"card-order","label":"Card order","fee":"5","assetId":"USDT"}]}"#,
            ),
            r#"{"set":true,"lines":[{"id":"card-order","label":"Card order","fee":"5","assetId":"USDT"}]}"#,
        ),
        (
            Some(
                r#"{"lines":[{"id":"card-order","label":"Card order","fee":5,"assetId":"USDT"}]}"#,
            ),
            r#"{"set":false,"lines":[]}"#,
        ),
    ] {
        let b = bank(
            &db,
            &ledger,
            &Owner {
                fees: raw.map(str::to_owned),
                ..Owner::default()
            },
        );
        assert_eq!(call(&b, ADA, "fees.account", "").ok().compact(), want);
    }
}

#[test]
fn hands_on_a_network_contract_and_its_links_as_the_registry_publishes_them() {
    let Some(db) = db() else { return };
    let ledger = Book::default();
    let b = bank(&db, &ledger, &Owner::default());
    // No registry, or an unreadable one, refuses; never an empty list.
    assert_eq!(
        call(&b, ADA, "assets.list", "").code(),
        "bank.asset_registry_unavailable"
    );
    let row = json::parse(
        r#"{"id":"TESTCOIN","kind":"crypto","precision":6,"networks":[{"networkId":"test-a","label":"TEST A","contract":"0x7e57","links":[{"label":"TEST explorer","url":"https://example.com/a"}]},{"networkId":"test-b","label":"TEST B"}],"defaultNetworkId":"test-a","allowedActions":["deposit","withdraw"],"state":"active","revision":1,"updatedAt":"2026-11-12T00:00:00.000Z"}"#,
    )
    .unwrap();
    *ledger.assets.lock().unwrap() = Some(vec![row]);
    let asset = &arr(call(&b, ADA, "assets.list", "").ok().get("assets").unwrap())[0];
    assert_eq!(
        asset.get("networks").unwrap().compact(),
        // Not known: null and empty, never guessed.
        r#"[{"networkId":"test-a","label":"TEST A","contract":"0x7e57","links":[{"label":"TEST explorer","url":"https://example.com/a"}]},{"networkId":"test-b","label":"TEST B","contract":null,"links":[]}]"#
    );
}
