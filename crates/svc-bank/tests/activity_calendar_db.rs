//! Part `calendar` of slice `activity` against the Rust door on a real Postgres: the checks of the TypeScript's
//! `calendar/calendar.db.test.ts`, each test named after the TypeScript test's words. The calendar is read through the
//! door (`calendar.window`) at a pinned clock; standing orders are made, run, edited and paused through the door
//! (`transfers.schedule`, `ops.runDueTransfers` signed as svc-bank, `transfers.updateSchedule`, `transfers.pause`),
//! against a stand-in ledger that books `bankTransfer` and refuses `ledger.insufficient_funds`.
//!
//! Where the TypeScript drives a slice that is not ported, the test writes the rows that slice's service writes:
//! - the direct debit: `DirectDebitService.setUpMandate` and `present` (slice not ported) are their two inserts, with
//!   the TEST stand-in's scheme (`dd-sim`) and creditor (`TEST-GYM`, `TEST Gym`);
//! - the fixed-term earn position: `earn.createPool` and `earn.deposit` need the earn recipes and identity's approvals,
//!   which this file's ledger does not book; the calendar reads only the position's row, so the pool and the active
//!   position are inserted as `deposit` leaves them (matures `termDays` after it opened).
//!
//! Not ported: none of the file's tests is left out. Without `TEST_DATABASE_URL` each test skips; with
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

use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::MemoryIdentity;
use svc_bank::transfers::{Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "bank-calendar-principal-secret-32chars-x";
const INTERNAL: &str = "a-bank-calendar-db-internal-secret-long-enough";
const USER: &str = "61111111-1111-4111-8111-111111111111";
const OTHER: &str = "62222222-2222-4222-8222-222222222222";
const DAY: i64 = 86_400_000;
const NOW: &str = "2026-11-10T09:00:00.000Z";

thread_local! {
    static CLOCK: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    let at = CLOCK.with(Cell::get);
    if at == 0 {
        door::system_now()
    } else {
        Instant(at)
    }
}

fn at(iso: &str) -> i64 {
    js_date(iso).unwrap().0
}

fn set_now(ms: i64) {
    CLOCK.with(|n| n.set(ms));
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book (`bankTransfer` only), the directory, the freeze.

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
}

#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
    )
}

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}", a.0, a.1, a.2, a.3)
}

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    };
    (s("ownerType"), s("ownerId"), s("assetId"), s("kind"))
}

impl Book {
    /// `recipes.deposit`: money in to the person's main balance.
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn posts(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(Amount::ZERO))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .iter()
            .filter(|(k, _)| k.0 == owner_type && k.1 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.2.clone(),
                kind: k.3.clone(),
                purpose: String::new(),
                amount: *v,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        Ok(acct_id(&acct(a)))
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(_, t)| t.id == tx_id)
            .map(|(_, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        assert_eq!(
            recipe, "bankTransfer",
            "the bank posts only bankTransfer here"
        );
        let mut st = self.0.lock().unwrap();
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        let held = st.balances.get(&from).copied().unwrap_or(Amount::ZERO);
        if held < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!(
                    "Insufficient funds: {} < {}",
                    format_amount(held),
                    format_amount(amount)
                ),
                attempts: 1,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            key: String::new(),
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: clock(),
            entries: vec![
                TxEntry {
                    account_id: acct_id(&from),
                    asset_id: from.2.clone(),
                    direction: "credit".to_owned(),
                    amount,
                },
                TxEntry {
                    account_id: acct_id(&to),
                    asset_id: to.2.clone(),
                    direction: "debit".to_owned(),
                    amount,
                },
            ],
        };
        st.journal.push((key.to_owned(), tx.clone()));
        Ok(tx)
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

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls.

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
    let mut transfers = TransfersWiring::none();
    transfers.recipients = Box::new(MemoryIdentity::default());
    transfers.lock = Box::new(MemoryIdentity::default());
    transfers.extras = Box::new(MemoryIdentity::default());
    transfers.handles = Some(Box::new(MemoryIdentity::default()));
    transfers.settings = Settings {
        // TEST cutoff, as the TypeScript's `scheduleEditCutoffMinutes: '60'`.
        schedule_edit_cutoff: Some("60".to_owned()),
        scheduled_transfers: true,
        batch_size: Some(200),
        ..Settings::default()
    };
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: clock,
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
            space_limit: Some("20".to_owned()),
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
    .with_transfers(transfers);
    Some(Bank { door, db, ledger })
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
        ("sid", Json::str("63333333-3333-4333-8333-333333333333")),
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

fn send(
    door: &BankDoor,
    path: &str,
    input: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-calendar-db",
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

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Json {
    ok(send(&b.door, path, input, person(user)))
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

/// `runDueTransfers({ now, limit })`, as svc-bank's own job calls it.
fn run_at(b: &Bank, now: &str) {
    set_now(at(now));
    let input = r#"{"limit":10}"#;
    let headers =
        s2s::legacy_headers("svc-bank", INTERNAL, input, clock().0.div_euclid(1000)).unwrap();
    ok(send(&b.door, "ops.runDueTransfers", input, headers));
}

/// A weekly order of `amount` from the person's main space into a new "Rent" space, starting 2 Nov at 08:00.
fn weekly(b: &Bank, amount: &str) -> Json {
    set_now(at("2026-11-01T00:00:00.000Z"));
    let from = space::with(&b.db.store(), |c| space::ensure_primary(c, USER, "USDT"))
        .unwrap()
        .id;
    let to = text(
        &call(
            b,
            USER,
            "spaces.create",
            r#"{"assetId":"USDT","name":"Rent"}"#,
        ),
        "id",
    );
    call(
        b,
        USER,
        "transfers.schedule",
        &format!(
            r#"{{"scheduleId":"{}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}","cadence":"weekly","startsAt":"2026-11-02T08:00:00.000Z"}}"#,
            uuid()
        ),
    )
}

/// `directDebits.setUpMandate` and `present` (slice not ported): the rows they write, with the TEST stand-in scheme.
fn direct_debit(b: &Bank, due: i64) {
    b.db.client()
        .execute(
            "INSERT INTO bank.dd_mandates (id, user_id, scheme, creditor_id, creditor_name, reference, asset_id) \
             VALUES ('MD-1', $1::text::uuid, 'dd-sim', 'TEST-GYM', 'TEST Gym', 'TEST 1', 'USDT')",
            &[&USER],
        )
        .unwrap();
    b.db.client()
        .execute(
            "INSERT INTO bank.dd_collections (mandate_id, collection_id, user_id, asset_id, amount, due_at, status) \
             VALUES ('MD-1', 'C-1', $1::text::uuid, 'USDT', '5', timestamptz 'epoch' + $2::int8 * interval '1 millisecond', 'upcoming')",
            &[&USER, &due],
        )
        .unwrap();
}

/// A fixed 10-day TEST pool and an active position of 50 opened at `NOW`, as `earn.deposit` leaves it. Its id.
fn fixed_position(b: &Bank) -> String {
    let pool: String = b
        .db
        .client()
        .query_one(
            "INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, term_days, min_deposit) \
             VALUES ('USDT', 'fixed', 'TEST fixed 10 days', 100, 10, 0) RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    b.db.client()
        .query_one(
            "INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, opened_at, matures_at, status) \
             VALUES ($1::text::uuid, $2, 'USDT', 50, $3::text::timestamptz, $3::text::timestamptz + interval '10 days', 'active') \
             RETURNING id::text",
            &[&pool, &USER, &NOW],
        )
        .unwrap()
        .get(0)
}

/// `calendar.window` for `[1 Nov, 1 Dec)`, page size 50, at `NOW`.
fn window(b: &Bank, user: &str) -> Json {
    set_now(at(NOW));
    call(
        b,
        user,
        "calendar.window",
        r#"{"from":"2026-11-01","days":30,"limit":50}"#,
    )
}

fn items(v: &Json) -> Vec<Json> {
    arr(v.get("items").unwrap())
}

fn source(v: &Json, name: &str) -> Json {
    arr(v.get("sources").unwrap())
        .into_iter()
        .find(|s| text(s, "source") == name)
        .unwrap()
}

#[test]
fn shows_a_settled_run_as_done_a_run_with_too_little_money_as_failed_by_name_and_what_is_still_to_come()
 {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "30");
    let order = weekly(&b, "20");
    let id = text(&order, "id");
    // 2 Nov posts 20; 9 Nov finds 10 left and fails; 16, 23 and 30 Nov are still to come.
    run_at(&b, "2026-11-02T08:05:00.000Z");
    run_at(&b, "2026-11-09T08:05:00.000Z");
    direct_debit(&b, at(NOW) + 3 * DAY);
    let position = fixed_position(&b);

    let posts = b.ledger.posts();
    let view = window(&b, USER);
    let got: Vec<(String, String, String, String)> = items(&view)
        .iter()
        .map(|i| {
            (
                text(i, "source"),
                text(i, "date").get(..10).unwrap().to_owned(),
                text(i, "status"),
                text(i, "reasonCode"),
            )
        })
        .collect();
    let row = |s: &str, d: &str, st: &str, r: &str| {
        (s.to_owned(), d.to_owned(), st.to_owned(), r.to_owned())
    };
    assert_eq!(got.len(), 7, "{}", view.compact());
    assert_eq!(got[0], row("standing_orders", "2026-11-02", "done", "null"));
    assert_eq!(
        (&got[1].0, &got[1].1, &got[1].2),
        (
            &"standing_orders".to_owned(),
            &"2026-11-09".to_owned(),
            &"failed".to_owned()
        )
    );
    assert!(got[1].3.contains("insufficient"), "{}", got[1].3);
    assert_eq!(
        got[2..],
        [
            row("direct_debits", "2026-11-13", "upcoming", "null"),
            row("standing_orders", "2026-11-16", "upcoming", "null"),
            row("earn", "2026-11-20", "upcoming", "null"),
            row("standing_orders", "2026-11-23", "upcoming", "null"),
            row("standing_orders", "2026-11-30", "upcoming", "null"),
        ]
    );
    assert!(
        items(&view)
            .iter()
            .filter(|i| text(i, "source") == "standing_orders")
            .all(|i| text(i, "refId") == id)
    );
    let keys: std::collections::BTreeSet<String> =
        items(&view).iter().map(|i| text(i, "key")).collect();
    assert_eq!(keys.len(), items(&view).len());
    let earn = items(&view)
        .into_iter()
        .find(|i| text(i, "source") == "earn")
        .unwrap();
    assert_eq!(
        (text(&earn, "refId"), text(&earn, "amount")),
        (position, "50".to_owned())
    );
    assert_eq!(
        source(&view, "loans").compact(),
        r#"{"source":"loans","state":"not_set","count":0,"code":"bank.loan_schedule_unset","complete":true}"#
    );
    let bills = source(&view, "bills");
    assert_eq!(
        (
            text(&bills, "state"),
            text(&bills, "count"),
            text(&bills, "code")
        ),
        (
            "ok".to_owned(),
            "0".to_owned(),
            "bank.bills_psp_unset".to_owned()
        )
    );

    // A paused order keeps its future dates on the calendar, marked paused.
    call(
        &b,
        USER,
        "transfers.pause",
        &format!(r#"{{"scheduleId":"{id}"}}"#),
    );
    let paused = window(&b, USER);
    assert_eq!(
        items(&paused)
            .iter()
            .filter(|i| text(i, "source") == "standing_orders")
            .map(|i| text(i, "status"))
            .collect::<Vec<_>>(),
        ["done", "failed", "paused", "paused", "paused"]
    );

    // The calendar posted nothing.
    assert_eq!(b.ledger.posts(), posts);

    // Another person's calendar holds none of it.
    assert!(items(&window(&b, OTHER)).is_empty());
}

#[test]
fn shows_a_run_that_already_happened_at_the_amount_it_booked_after_the_order_amount_changes_9854() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "100");
    let order = weekly(&b, "10");
    let id = text(&order, "id");
    run_at(&b, "2026-11-02T08:05:00.000Z");
    run_at(&b, "2026-11-09T08:05:00.000Z");
    set_now(at(NOW));
    call(
        &b,
        USER,
        "transfers.updateSchedule",
        &format!(
            r#"{{"scheduleId":"{id}","revision":{},"amount":"25","endsAt":null}}"#,
            b.db.count(&format!(
                "SELECT revision::int8 FROM bank.scheduled_transfers WHERE id = '{id}'"
            ))
        ),
    );

    let view = window(&b, USER);
    assert_eq!(
        items(&view)
            .iter()
            .filter(|i| text(i, "source") == "standing_orders")
            .map(|i| format!(
                "{} {} {}",
                text(i, "date").get(..10).unwrap(),
                text(i, "status"),
                text(i, "amount")
            ))
            .collect::<Vec<_>>(),
        [
            "2026-11-02 done 10",
            "2026-11-09 done 10",
            "2026-11-16 upcoming 25",
            "2026-11-23 upcoming 25",
            "2026-11-30 upcoming 25",
        ]
    );
}

// describe('the customer door')

#[test]
fn answers_the_signed_person_with_their_own_window_and_refuses_a_window_without_a_page_size_or_over_two_months()
 {
    let Some(b) = bank() else { return };
    // The TypeScript reads the real clock; this pins it, a day after the window opens.
    let now = at(NOW);
    direct_debit(&b, now + 2 * DAY);
    set_now(now);
    let from = Instant(now - DAY).iso().get(..10).unwrap().to_owned();
    let get = |user: &str, input: &str| send(&b.door, "calendar.window", input, person(user));
    let mine = get(
        USER,
        &format!(r#"{{"from":"{from}","days":31,"limit":50}}"#),
    );
    assert_eq!(mine.0, 200, "{}", mine.1.compact());
    let mine = items(&ok(mine));
    assert_eq!(mine.len(), 1);
    assert_eq!(
        (
            text(&mine[0], "source"),
            text(&mine[0], "refId"),
            text(&mine[0], "label"),
            text(&mine[0], "status")
        ),
        (
            "direct_debits".to_owned(),
            "MD-1".to_owned(),
            "TEST Gym".to_owned(),
            "upcoming".to_owned()
        )
    );
    assert!(
        items(&ok(get(
            OTHER,
            &format!(r#"{{"from":"{from}","days":31,"limit":50}}"#)
        )))
        .is_empty()
    );
    assert_eq!(
        get(USER, &format!(r#"{{"from":"{from}","days":31}}"#)).0,
        400
    );
    assert_eq!(
        get(
            USER,
            &format!(r#"{{"from":"{from}","days":63,"limit":50}}"#)
        )
        .0,
        400
    );
    assert_eq!(
        get(USER, r#"{"from":"2026-02-30","days":28,"limit":50}"#).0,
        400
    );
}
