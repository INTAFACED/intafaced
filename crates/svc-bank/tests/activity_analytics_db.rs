//! Part `analytics` of slice `activity` against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! `analytics/budgets.db.test.ts`, `analytics/spend-archived-pot.test.ts`, `analytics/spend-partner.test.ts` ("spend for
//! a person the partner holds money for") and `bank-service.test.ts` ("spend analytics are computed, not accumulated"),
//! each test named after the TypeScript test's words. Every call enters through the door, as the TypeScript's enter
//! through the router, except a refusal the call's input schema already stops at the door: that one is asked of the
//! part's own function, as the TypeScript asks `BudgetService` directly.
//!
//! svc-ledger's book is a stand-in journal (`MemoryLedger` and `memoryLedgerHistory`): each test books the entries the
//! recipe would book (`deposit.credited`, `bank.transfer.manual`, `fee.charged`). `budgets.db.test.ts` folds a stand-in
//! spend; here the real fold runs over that journal, so each case books the month's outflow it reads.
//!
//! Not ported, and why:
//! - `spend-categorise.test.ts` and `ledger-history.socket.test.ts`: pure, ported as unit tests in
//!   `src/activity/analytics.rs`, with `ledger-client.test.ts`'s `entriesFor` case.
//! - `spend-partner.test.ts`, "the TEST partner record" (two tests): they check the TEST partner's own `moves` and
//!   `limits`, not an analytics call; they belong to the partner slice.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::activity::{self, analytics};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, FEES_OWNER, MoveRequest, PAYOUTS_OWNER, TestPartner};
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance};

use support::TestDb;

const SECRET: &str = "a-bank-analytics-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-analytics-db-internal-secret-long-eno";
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

/// The budgets suite's clock: `2026-11-20T12:00:00Z`.
fn november() -> Instant {
    at("2026-11-20T12:00:00.000Z")
}

fn december() -> Instant {
    at("2026-12-02T00:00:00.000Z")
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in book: svc-ledger's journal, its balances and its history.

/// One leg: the account's key, whether it is a credit, and the amount.
type Leg = (String, bool, Amount);
/// One posting: when, its reason, its legs.
type Tx = (i64, String, Vec<Leg>);

#[derive(Clone, Default)]
struct Journal {
    txs: Arc<Mutex<Vec<Tx>>>,
    /// Every history read fails (`a partner-held person is never read from the ledger`).
    down: Arc<AtomicBool>,
}

fn key(a: &LedgerAccount) -> String {
    format!("{}:{}:{}:{}", a.owner_type, a.owner_id, a.asset_id, a.kind)
}

fn main_of(user: &str) -> LedgerAccount {
    LedgerAccount::user_available(user, "USDT")
}

fn pot_of(space: &str) -> LedgerAccount {
    LedgerAccount::sub_account_available(space, "USDT")
}

impl Journal {
    fn post(&self, at: i64, reason: &str, legs: &[(&LedgerAccount, bool, &str)]) {
        self.txs.lock().unwrap().push((
            at,
            reason.to_owned(),
            legs.iter().map(|(a, c, x)| (key(a), *c, amt(x))).collect(),
        ));
    }
    /// `recipes.deposit`: the rail boundary credited, the person's main balance debited.
    fn deposit(&self, at: i64, user: &str, amount: &str) {
        let rail = LedgerAccount::user_available("rail:test", "USDT");
        self.post(
            at,
            "deposit.credited",
            &[(&rail, true, amount), (&main_of(user), false, amount)],
        );
    }
    /// `recipes.bankTransfer` (manual): out of one account, into another.
    fn transfer(&self, at: i64, from: &LedgerAccount, to: &LedgerAccount, amount: &str) {
        self.post(
            at,
            "bank.transfer.manual",
            &[(from, true, amount), (to, false, amount)],
        );
    }
    /// `recipes.feeCharge` (asset mode): out of the person's main balance into the fee revenue.
    fn fee(&self, at: i64, user: &str, amount: &str) {
        let revenue = LedgerAccount::user_available("platform:fees", "USDT");
        self.post(
            at,
            "fee.charged",
            &[(&main_of(user), true, amount), (&revenue, false, amount)],
        );
    }
}

impl Ledger for Journal {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        let k = key(a);
        Ok(self
            .txs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|t| t.2.iter())
            .filter(|l| l.0 == k)
            .map(|l| if l.1 { -l.2 } else { l.2 })
            .sum())
    }
    fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
}

impl analytics::History for Journal {
    fn entries_for(
        &self,
        a: &LedgerAccount,
        from: Instant,
        to: Instant,
    ) -> Result<Vec<analytics::Entry>, String> {
        if self.down.load(Ordering::SeqCst) {
            return Err("a partner-held person is never read from the ledger".to_owned());
        }
        let k = key(a);
        Ok(self
            .txs
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.0 >= from.0 && t.0 < to.0)
            .flat_map(|t| {
                t.2.iter().filter(|l| l.0 == k).map(|l| analytics::Entry {
                    reason: t.1.clone(),
                    credit: l.1,
                    amount: l.2,
                })
            })
            .collect())
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

fn bank(db: &TestDb, journal: &Journal, now: fn() -> Instant) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now,
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
        ledger: Box::new(journal.clone()),
        ..SpacesWiring::none()
    })
    .with_activity(activity::Wiring {
        analytics: analytics::Wiring {
            history: Box::new(journal.clone()),
        },
        ..activity::Wiring::none()
    })
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
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn call(b: &BankDoor, user: &str, path: &str, input: &str) -> Answer {
    let mut headers = person(user);
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
            ("POST", format!("/trpc/{path}"), input.to_owned())
        }
    };
    let res = b.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-analytics-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
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

/// A space row as `ensurePrimary` or `spaces.create` writes it; its id.
fn space(db: &TestDb, user: &str, kind: &str, name: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USDT', $2::text::bank.space_kind, $3) \
             RETURNING id::text",
            &[&user, &kind, &name],
        )
        .unwrap()
        .get(0)
}

fn spend(b: &BankDoor, user: &str, from: i64, to: i64) -> Json {
    call(
        b,
        user,
        "analytics.spend",
        &format!(
            r#"{{"assetId":"USDT","from":"{}","to":"{}"}}"#,
            Instant(from).iso(),
            Instant(to).iso()
        ),
    )
    .ok()
}

fn bucket(s: &Json, category: &str) -> String {
    text(s.get("outflowByCategory").unwrap(), category)
}

fn set_budget(b: &BankDoor, user: &str, category: &str, target: &str, alert: i64) -> Answer {
    call(
        b,
        user,
        "analytics.setBudget",
        &format!(
            r#"{{"assetId":"USDT","category":"{category}","target":"{target}","alertBps":{alert}}}"#
        ),
    )
}

fn code_of(r: Result<impl Sized, Refusal>) -> String {
    match r {
        Ok(_) => "ok".to_owned(),
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        Err(other) => panic!("not a bank refusal: {other:?}"),
    }
}

/// A person with a primary space, as the budgets suite's people have.
fn budget_person(db: &TestDb) -> String {
    let user = uuid();
    space(db, &user, "primary", "Main");
    user
}

/// One line of the month's outflow out of the person's main balance, under `reason`.
fn out(j: &Journal, at_iso: &str, user: &str, reason: &str, amount: &str) {
    let stranger = LedgerAccount::user_available("someone-else", "USDT");
    j.post(
        at(at_iso).0,
        reason,
        &[(&main_of(user), true, amount), (&stranger, false, amount)],
    );
}

// ---------------------------------------------------------------------------------------------------------------
// budgets.db.test.ts: budgets by category (J-bank-16 #4 #5, PG-hard).

#[test]
fn reads_80_percent_for_a_spend_of_80_on_a_budget_of_100_and_the_alert_is_new_once_then_seen_for_the_rest_of_the_month()
 {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = budget_person(&db);
    out(
        &j,
        "2026-11-10T00:00:00.000Z",
        &user,
        "bank.transfer.manual",
        "80",
    );
    j.deposit(at("2026-11-05T00:00:00.000Z").0, &user, "150.25");
    let b = bank(&db, &j, november);

    let set = set_budget(&b, &user, "transfers", "100", 8_000).ok();
    assert_eq!(
        (
            text(&set, "target"),
            text(&set, "spent"),
            text(&set, "progressBps"),
            text(&set, "alert"),
            text(&set, "period")
        ),
        (
            "100".to_owned(),
            "80".to_owned(),
            "8000".to_owned(),
            "new".to_owned(),
            "2026-11".to_owned()
        )
    );
    let shown_input = r#"{"assetId":"USDT","category":"transfers"}"#;
    let shown = call(&b, &user, "analytics.budgetAlertShown", shown_input).ok();
    assert_eq!(text(&shown, "alert"), "seen");
    let again = call(&b, &user, "analytics.budgetAlertShown", shown_input).ok();
    assert_ne!(text(&again, "alertShownAt"), "null");
    assert_eq!(text(&again, "alertShownAt"), text(&shown, "alertShownAt"));
    let listed = call(&b, &user, "analytics.budgets", r#"{"assetId":"USDT"}"#).ok();
    let Json::Array(listed) = listed else {
        panic!("not a list")
    };
    assert_eq!(text(&listed[0], "alert"), "seen");

    // A new month is a new period: the alert is new again once the share is reached.
    out(
        &j,
        "2026-12-01T00:00:00.000Z",
        &user,
        "bank.transfer.manual",
        "90",
    );
    let dec = bank(&db, &j, december);
    let Json::Array(listed) = call(&dec, &user, "analytics.budgets", r#"{"assetId":"USDT"}"#).ok()
    else {
        panic!("not a list")
    };
    assert_eq!(
        (text(&listed[0], "period"), text(&listed[0], "alert")),
        ("2026-12".to_owned(), "new".to_owned())
    );
}

#[test]
fn shows_no_alert_below_the_share_the_person_chose() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = budget_person(&db);
    out(
        &j,
        "2026-11-10T00:00:00.000Z",
        &user,
        "bank.transfer.manual",
        "79.99",
    );
    let b = bank(&db, &j, november);
    let set = set_budget(&b, &user, "transfers", "100", 8_000).ok();
    assert_eq!(
        (text(&set, "progressBps"), text(&set, "alert")),
        ("7999".to_owned(), "null".to_owned())
    );
}

#[test]
fn refuses_a_budget_on_deposits_a_zero_target_or_an_alert_share_out_of_range() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = budget_person(&db);
    let b = bank(&db, &j, november);
    b.activity_deps(november(), |d| {
        let set = |category, target, alert| {
            code_of(analytics::set(d, &user, "USDT", category, target, alert))
        };
        assert_eq!(set("deposits", "100", 8_000.0), "bank.budget_invalid");
        assert_eq!(set("transfers", "0", 8_000.0), "bank.budget_invalid");
        assert_eq!(set("transfers", "100", 0.0), "bank.budget_invalid");
    });
    // At the door each is refused before anything is written.
    for (category, target, alert) in [
        ("deposits", "100", 8_000),
        ("transfers", "0", 8_000),
        ("transfers", "100", 0),
    ] {
        assert_eq!(set_budget(&b, &user, category, target, alert).0, 400);
    }
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM bank.budgets WHERE user_id = '{user}'"
        )),
        0
    );
}

#[test]
fn left_to_spend_is_the_targets_less_the_spend_and_refuses_bank_budget_unset_with_no_budget() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = budget_person(&db);
    out(
        &j,
        "2026-11-10T00:00:00.000Z",
        &user,
        "bank.transfer.manual",
        "80",
    );
    j.fee(at("2026-11-11T00:00:00.000Z").0, &user, "2.5");
    let b = bank(&db, &j, november);
    let input = r#"{"assetId":"USDT"}"#;
    assert_eq!(
        call(&b, &user, "analytics.leftToSpend", input).code(),
        "bank.budget_unset"
    );
    set_budget(&b, &user, "transfers", "100", 8_000).ok();
    set_budget(&b, &user, "fees", "10", 9_000).ok();
    assert_eq!(
        call(&b, &user, "analytics.leftToSpend", input)
            .ok()
            .compact(),
        r#"{"assetId":"USDT","period":"2026-11","target":"110","spent":"82.5","left":"27.5"}"#
    );
}

#[test]
fn compares_months_side_by_side_a_month_with_no_movement_is_zero_and_refuses_a_future_or_single_month()
 {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = budget_person(&db);
    out(
        &j,
        "2026-11-10T00:00:00.000Z",
        &user,
        "bank.transfer.manual",
        "80",
    );
    let b = bank(&db, &j, november);
    let c = call(
        &b,
        &user,
        "analytics.compare",
        r#"{"assetId":"USDT","months":["2026-10","2026-11"]}"#,
    )
    .ok();
    assert_eq!(text(&c, "months"), r#"["2026-10","2026-11"]"#);
    let Some(Json::Array(rows)) = c.get("categories") else {
        panic!("categories")
    };
    let row = |category: &str| {
        rows.iter()
            .find(|r| text(r, "category") == category)
            .map(Json::compact)
    };
    assert_eq!(
        row("transfers").unwrap(),
        r#"{"category":"transfers","byMonth":["0","80"],"change":"80"}"#
    );
    assert_eq!(
        row("fees").unwrap(),
        r#"{"category":"fees","byMonth":["0","0"],"change":"0"}"#
    );
    assert!(row("deposits").is_none());
    b.activity_deps(november(), |d| {
        let compare = |months: &[&str]| {
            let months: Vec<String> = months.iter().map(|m| (*m).to_owned()).collect();
            code_of(analytics::compare(d, &user, "USDT", &months))
        };
        assert_eq!(compare(&["2026-11"]), "bank.compare_months");
        assert_eq!(compare(&["2026-11", "2026-12"]), "bank.compare_months");
    });
    assert_eq!(
        call(
            &b,
            &user,
            "analytics.compare",
            r#"{"assetId":"USDT","months":["2026-11","2026-12"]}"#
        )
        .code(),
        "bank.compare_months"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// spend-archived-pot.test.ts

#[test]
fn keeps_the_historical_spend_totals_when_an_empty_pot_is_archived() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = uuid();
    space(&db, &user, "primary", "Main");
    let pot = space(&db, &user, "named", "Rent");
    let t = november().0 - HOUR;
    j.deposit(t, &user, "10");
    j.transfer(t, &main_of(&user), &pot_of(&pot), "10");
    j.transfer(t, &pot_of(&pot), &main_of(&user), "10");
    let b = bank(&db, &j, november);
    let before = spend(&b, &user, 0, november().0 + 60_000);
    assert_eq!(
        (
            text(&before, "movements"),
            text(&before, "totalInflow"),
            text(&before, "totalOutflow"),
            text(&before, "net")
        ),
        (
            "5".to_owned(),
            "30".to_owned(),
            "20".to_owned(),
            "10".to_owned()
        )
    );
    db.client()
        .execute(
            "UPDATE bank.spaces SET archived_at = now() WHERE id = $1::text::uuid",
            &[&pot],
        )
        .unwrap();
    assert_eq!(
        spend(&b, &user, 0, november().0 + 60_000).compact(),
        before.compact()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// spend-partner.test.ts: spend for a person the partner holds money for (J-bank-16 #4 #5).

fn usdt(user: &str) -> AccountRef {
    AccountRef::main(user, "USDT")
}

/// `held()`: the partner holds the person's money, TEST 200 USDT paid in.
fn held(b: &BankDoor, user: &str) {
    assert_eq!(
        call(b, user, "testPartner.set", r#"{"custody":"off"}"#).0,
        200
    );
    let fund = r#"{"fundId":"spend-fund-1","assetId":"USDT","amount":"200"}"#;
    assert_eq!(call(b, user, "testPartner.fund", fund).0, 200);
}

fn partner_move(b: &BankDoor, key: &str, from: AccountRef, to: AccountRef, amount: &str) {
    b.partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .move_raw(
            &MoveRequest {
                key: key.to_owned(),
                from,
                to,
                amount: amt(amount),
                payees: None,
            },
            november(),
        )
        .unwrap();
}

/// A journal every read of which fails: a partner-held person is never read from the ledger.
fn no_ledger() -> Journal {
    let j = Journal::default();
    j.down.store(true, Ordering::SeqCst);
    j
}

#[test]
fn folds_the_partners_record_a_pay_in_is_money_in_and_not_outflow_a_send_is_transfers_each_named_out()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, &no_ledger(), november);
    let (ada, bob) = (uuid(), uuid());
    held(&b, &ada);
    partner_move(&b, "k-send", usdt(&ada), usdt(&bob), "80");
    partner_move(&b, "k-out", usdt(&ada), usdt(PAYOUTS_OWNER), "10");
    partner_move(&b, "k-fee", usdt(&ada), usdt(FEES_OWNER), "5");
    let s = spend(&b, &ada, november().0 - HOUR, november().0 + HOUR);
    assert_eq!(
        (
            text(&s, "totalOutflow"),
            text(&s, "totalInflow"),
            text(&s, "net"),
            text(&s, "movements")
        ),
        (
            "95".to_owned(),
            "200".to_owned(),
            "105".to_owned(),
            "4".to_owned()
        )
    );
    assert_eq!(
        (
            bucket(&s, "transfers"),
            bucket(&s, "withdrawals"),
            bucket(&s, "fees"),
            bucket(&s, "deposits")
        ),
        (
            "80".to_owned(),
            "10".to_owned(),
            "5".to_owned(),
            "200".to_owned()
        )
    );
}

#[test]
fn a_move_between_the_persons_own_spaces_is_not_spending() {
    let Some(db) = db() else { return };
    let b = bank(&db, &no_ledger(), november);
    let ada = uuid();
    held(&b, &ada);
    let trip = AccountRef {
        user_id: ada.clone(),
        asset_id: "USDT".to_owned(),
        space_id: Some("trip".to_owned()),
    };
    partner_move(&b, "k-own", usdt(&ada), trip, "20");
    let s = spend(&b, &ada, november().0 - HOUR, november().0 + HOUR);
    assert_eq!(
        (
            text(&s, "totalOutflow"),
            text(&s, "totalInflow"),
            text(&s, "movements")
        ),
        ("0".to_owned(), "200".to_owned(), "1".to_owned())
    );
}

#[test]
fn counts_a_line_only_inside_the_range() {
    let Some(db) = db() else { return };
    let b = bank(&db, &no_ledger(), november);
    let ada = uuid();
    held(&b, &ada);
    let s = spend(&b, &ada, november().0 - 2 * HOUR, november().0 - HOUR);
    assert_eq!(
        (text(&s, "totalInflow"), text(&s, "movements")),
        ("0".to_owned(), "0".to_owned())
    );
}

#[test]
fn a_person_on_the_custodial_layer_still_reads_the_ledger() {
    let Some(db) = db() else { return };
    let b = bank(&db, &no_ledger(), november);
    let ada = uuid();
    space(&db, &ada, "primary", "Main");
    let a = call(
        &b,
        &ada,
        "analytics.spend",
        &format!(
            r#"{{"assetId":"USDT","from":"{}","to":"{}"}}"#,
            Instant(november().0 - HOUR).iso(),
            Instant(november().0 + HOUR).iso()
        ),
    );
    assert_eq!(a.0, 500);
    assert!(
        a.message().starts_with("Bank operation failed (ref "),
        "{}",
        a.message()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// bank-service.test.ts: spend analytics are computed, not accumulated.

/// A person with a primary space and a `Rent` pot, 1000 USDT funded, and `moved` sent from the primary into the pot.
fn funded_with_rent(db: &TestDb, j: &Journal, moved: &str) -> String {
    let user = uuid();
    space(db, &user, "primary", "Main");
    let rent = space(db, &user, "named", "Rent");
    let t = november().0 - HOUR;
    j.deposit(t, &user, "1000");
    j.transfer(t, &main_of(&user), &pot_of(&rent), moved);
    user
}

#[test]
fn buckets_outflows_by_ledger_reason_code() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = funded_with_rent(&db, &j, "200");
    j.fee(november().0 - HOUR, &user, "5");
    let b = bank(&db, &j, november);
    let s = spend(&b, &user, november().0 - DAY, november().0 + DAY);
    assert_eq!(bucket(&s, "fees"), "5");
    // The transfer left the primary space AND arrived in the named one, so it shows as an outflow of 200 with a
    // matching inflow: moving your own money between your own pots is not spending it.
    assert_eq!(bucket(&s, "transfers"), "200");
    // The funding posts deposit.credited for 1000. That arrival is a deposit, not a reward.
    assert_eq!(bucket(&s, "deposits"), "1000");
    assert_eq!(bucket(&s, "rewards"), "0");
    assert_eq!(text(&s, "totalOutflow"), "205");
    assert_eq!(text(&s, "totalInflow"), "1200");
}

#[test]
fn reports_nothing_outside_the_window() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = funded_with_rent(&db, &j, "200");
    let b = bank(&db, &j, november);
    let s = spend(
        &b,
        &user,
        at("2020-01-01T00:00:00.000Z").0,
        at("2020-02-01T00:00:00.000Z").0,
    );
    assert_eq!(text(&s, "movements"), "0");
    assert_eq!(text(&s, "totalOutflow"), "0");
    assert_eq!(bucket(&s, "deposits"), "0");
}

#[test]
fn gives_the_same_answer_twice_nothing_is_consumed_by_asking() {
    let Some(db) = db() else { return };
    let j = Journal::default();
    let user = funded_with_rent(&db, &j, "123.456");
    let b = bank(&db, &j, november);
    let first = spend(&b, &user, november().0 - DAY, november().0 + DAY);
    let second = spend(&b, &user, november().0 - DAY, november().0 + DAY);
    assert_eq!(second.compact(), first.compact());
}
