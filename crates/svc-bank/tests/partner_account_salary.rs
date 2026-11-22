//! Salary paid in by direct deposit (J-bank-30) against the Rust door on a real Postgres: the checks of the TypeScript's
//! `salary/salary.db.test.ts` that fall on this part's own calls, each test named after the TypeScript test's words. The
//! money is the TEST partner's: a credit is one pay-in there, a split leg one guarded partner move into a space, a
//! reversal one move out, each under its business key and read back once. Customers enter through the tRPC door, the
//! payroll network through its signed job doors.
//!
//! Two unported slices stand in as rows: the space (`spaces.create`, slice `spaces`) and the income sorter
//! (`sorter.create`, slice `automations`) are written straight into their tables, and the operator's stop
//! (`partnerStops.set`, slice `ops-desk`) into `bank.partner_stops`, as `tests/partner_db.rs` does. Without
//! `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, MoveRequest, TestPartner};
use svc_bank::partner_account::Wiring;

use support::TestDb;

const SECRET: &str = "a-bank-salary-db-edge-secret-long-enough-00";
const INTERNAL: &str = "a-bank-salary-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const EMPLOYER: &str = "TEST Employer Ltd";
const HOLDER: &str = "TEST Ada Lovelace";
const DAY_MS: i64 = 86_400_000;

thread_local! {
    /// How far this test's clock runs ahead of the wall clock: the TypeScript test moves `now` for the window.
    static AHEAD: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    Instant(door::system_now().0 + AHEAD.with(Cell::get))
}

/// svc-ledger's posting freeze as the test sets it: open unless a test closes it.
#[derive(Clone)]
struct Posting(Arc<Mutex<bool>>);

impl Freeze for Posting {
    fn read(&self) -> Result<FreezeReading, String> {
        let open = *self.0.lock().unwrap();
        Ok(FreezeReading {
            posting_enabled: open,
            cause: (!open).then(|| "person".to_owned()),
        })
    }
}

struct Bank {
    door: Option<BankDoor>,
    posting: Posting,
    records: PathBuf,
}

/// What `make()` varies.
#[derive(Clone, Copy)]
struct Make {
    currencies: Option<&'static str>,
    payroll: bool,
    reversal_days: Option<&'static str>,
}

const MAKE: Make = Make {
    currencies: Some("EUR,GBP,USD"),
    payroll: true,
    reversal_days: Some("5"),
};

fn env(b: &Bank, m: Make) -> BTreeMap<String, String> {
    let mut e: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("NODE_ENV", "test"),
        ("BANK_TEST_PARTNER", "test"),
        ("BANK_INCOME_SORTER_MIN_CREDIT", "1"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    if m.payroll {
        e.insert("BANK_PAYROLL_PARTNER".to_owned(), "payroll-sim".to_owned());
        e.insert(
            "BANK_PAYROLL_SIM_RECORDS_DIR".to_owned(),
            b.records.to_string_lossy().into_owned(),
        );
    }
    if let Some(c) = m.currencies {
        e.insert("BANK_ACCOUNT_DETAILS_CURRENCIES".to_owned(), c.to_owned());
    }
    if let Some(d) = m.reversal_days {
        e.insert("BANK_DIRECT_DEPOSIT_REVERSAL_DAYS".to_owned(), d.to_owned());
    }
    e
}

impl Bank {
    fn door(&self) -> &BankDoor {
        self.door.as_ref().unwrap()
    }

    /// `make(over)`: the same partner book and store, this part's wiring rebuilt from the varied environment.
    fn make(&mut self, m: Make) {
        let wiring = Wiring::from_env(&env(self, m)).unwrap();
        self.door = Some(self.door.take().unwrap().with_partner_account(wiring));
    }

    fn partner(&self) -> &TestPartner {
        self.door().partner().partner.as_ref().unwrap()
    }

    fn posting(&self, open: bool) {
        *self.posting.0.lock().unwrap() = open;
    }
}

impl Drop for Bank {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.records);
        AHEAD.with(|a| a.set(0));
    }
}

fn bank(db: &TestDb) -> Bank {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let records = std::env::temp_dir().join(format!("jb30-payroll-{}-{nanos}", std::process::id()));
    let posting = Posting(Arc::new(Mutex::new(true)));
    let mut b = Bank {
        door: None,
        posting: posting.clone(),
        records,
    };
    let e = env(&b, MAKE);
    b.door = Some(
        BankDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(INTERNAL.to_owned()),
                keys: None,
                trpc_bind: BodyBind::AcceptBoth,
            },
            env: e,
            now: clock,
            store: db.store(),
        })
        .unwrap()
        .with_partner(PartnerWiring {
            partner: Some(TestPartner::new().unwrap()),
            freeze: Box::new(posting),
            custody_layer: "off".to_owned(),
            cash_legs: None,
            pay_in: None,
        }),
    );
    let set = format!(r#"{{"custody":"off","accountDetails":"issued","holderName":"{HOLDER}"}}"#);
    assert_eq!(
        trpc(
            &b,
            ADA,
            "POST",
            "testPartner.set",
            &set,
            &["bank:read", "bank:write"]
        )
        .0,
        200
    );
    b
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
    let res = b.door().handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-salary-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A tRPC call as one person: a query is a GET with its input in the URL, a mutation a POST.
fn trpc(
    b: &Bank,
    user: &str,
    method: &str,
    path: &str,
    input: &str,
    scopes: &[&str],
) -> (u16, Json) {
    if method == "GET" {
        let url = if input.is_empty() {
            format!("/trpc/{path}")
        } else {
            format!("/trpc/{path}?input={}", encode(input))
        };
        send(b, "GET", &url, "", person(user, scopes))
    } else {
        send(
            b,
            "POST",
            &format!("/trpc/{path}"),
            input,
            person(user, scopes),
        )
    }
}

fn query(b: &Bank, path: &str, input: &str) -> (u16, Json) {
    trpc(b, ADA, "GET", path, input, &["bank:read", "bank:write"])
}

/// The payroll network's signed job call.
fn job(b: &Bank, path: &str, body: &str) -> (u16, Json) {
    let headers = // Signed at the door's clock, which a test may move ahead.
    s2s::legacy_headers("svc-bank", INTERNAL, body, clock().0.div_euclid(1000)).unwrap();
    send(
        b,
        "POST",
        &format!("/internal/jobs/payroll-sim/{path}"),
        body,
        headers,
    )
}

/// `codeOf`: the refusal's own code (a tRPC cause or a job door's `code`), or `resolved`.
fn code(answer: &(u16, Json)) -> String {
    if answer.0 == 200 {
        return "resolved".to_owned();
    }
    let trpc = answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("cause"))
        .and_then(|c| c.get("code"));
    match (trpc, answer.1.get("code")) {
        (Some(Json::String(c)), _) | (None, Some(Json::String(c))) => c.clone(),
        _ => panic!("no refusal code: {} {}", answer.0, answer.1.compact()),
    }
}

fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

fn credit_body(network_id: &str, amount: &str, holder: &str, details: &str) -> String {
    Json::obj([
        ("networkId", Json::str(network_id)),
        ("accountDetailsId", Json::str(details)),
        ("amount", Json::str(amount)),
        ("currency", Json::str("USD")),
        ("originatorName", Json::str(EMPLOYER)),
        ("holderName", Json::str(holder)),
    ])
    .compact()
}

/// `send(networkId, amount, holderName)`: the network's credit to Ada's USD details.
fn credit(b: &Bank, network_id: &str, amount: &str, holder: &str) -> (u16, Json) {
    job(
        b,
        "credit",
        &credit_body(
            network_id,
            amount,
            holder,
            &format!("test-partner:{ADA}:USD"),
        ),
    )
}

fn reverse(b: &Bank, network_id: &str) -> (u16, Json) {
    job(b, "reverse", &format!(r#"{{"networkId":"{network_id}"}}"#))
}

fn field<'a>(v: &'a Json, path: &[&str]) -> &'a Json {
    path.iter().fold(v, |v, k| {
        v.get(k)
            .unwrap_or_else(|| panic!("no {k} in {}", v.compact()))
    })
}

fn text(v: &Json, path: &[&str]) -> String {
    match field(v, path) {
        Json::String(s) => s.clone(),
        other => other.compact(),
    }
}

/// `held(spaceId)`: what the partner's own book holds for Ada in USD.
fn held(b: &Bank, space: Option<&str>) -> String {
    let account = AccountRef {
        user_id: ADA.to_owned(),
        asset_id: "USD".to_owned(),
        space_id: space.map(str::to_owned),
    };
    format_amount(b.partner().lock().book.amount(&account))
}

fn move_by_key(b: &Bank, key: &str) -> Option<(String, String)> {
    b.partner()
        .lock()
        .book
        .by_key(key)
        .map(|m| (m.id.clone(), format_amount(m.amount)))
}

fn salary_moves(b: &Bank, keep: impl Fn(&str) -> bool) -> usize {
    b.partner()
        .lock()
        .record(ADA)
        .moves
        .iter()
        .filter(|m| keep(&m.key))
        .count()
}

/// `savings()`: Ada's USD Savings space and her Main, as `spaces.create` and `spaces.ensurePrimary` write them.
fn savings(db: &TestDb) -> String {
    let mut c = db.client();
    let id: String = c
        .query_one(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USD', 'named', 'Savings') RETURNING id::text",
            &[&ADA],
        )
        .unwrap()
        .get(0);
    main_space(db);
    id
}

fn main_space(db: &TestDb) {
    db.client()
        .execute(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USD', 'primary', 'Main') ON CONFLICT DO NOTHING",
            &[&ADA],
        )
        .unwrap();
}

/// `split10(spaceId)`: Ada's live USD income sorter, 10% into the space, as `sorter.create` writes it.
fn split10(db: &TestDb, space: &str) {
    let mut c = db.client();
    let sorter: String = c
        .query_one(
            "INSERT INTO bank.income_sorters (id, user_id, asset_id) VALUES (gen_random_uuid(), $1, 'USD') RETURNING id::text",
            &[&ADA],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO bank.income_sorter_legs (sorter_id, position, space_id, share_bp) VALUES ($1::text::uuid, 0, $2::text::uuid, 1000)",
        &[&sorter, &space],
    )
    .unwrap();
}

fn stop(db: &TestDb, kinds: &[&str]) {
    let kinds: Vec<String> = kinds.iter().map(|k| (*k).to_owned()).collect();
    db.client()
        .execute(
            "INSERT INTO bank.partner_stops (partner_id, stopped_kinds, revision, reason, approved_by) \
             VALUES ('test-partner', $1, 1, 'TEST wrong instructions seen', 'approver-2') \
             ON CONFLICT (partner_id) DO UPDATE SET stopped_kinds = EXCLUDED.stopped_kinds",
            &[&kinds],
        )
        .unwrap();
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

#[test]
fn n1_refuses_the_details_while_the_owner_lists_no_currency_and_says_rail_bank_with_no_payroll_network()
 {
    let Some(db) = db() else { return };
    let mut b = bank(&db);
    b.make(Make {
        currencies: Some(""),
        ..MAKE
    });
    assert_eq!(
        code(&query(&b, "salary.details", "")),
        "bank.account_details_currencies_unset"
    );
    b.make(Make {
        payroll: false,
        ..MAKE
    });
    assert_eq!(code(&query(&b, "salary.details", "")), "rail.bank");
    assert_eq!(code(&credit(&b, "net-none", "10", HOLDER)), "rail.bank");
}

#[test]
fn n2_shows_the_test_details_with_the_holder_name_and_the_employer_form_with_the_same_details() {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let details = data(&query(&b, "salary.details", ""));
    assert_eq!(text(&details, &["partnerBank"]), "TEST partner bank");
    assert_eq!(text(&details, &["holderName"]), HOLDER);
    let Some(Json::Array(currencies)) = details.get("currencies") else {
        panic!("currencies")
    };
    let usd = currencies
        .iter()
        .find(|c| text(c, &["currency"]) == "USD")
        .unwrap();
    let Some(Json::Array(sets)) = usd.get("sets") else {
        panic!("sets")
    };
    assert_eq!(text(&sets[0], &["id"]), format!("test-partner:{ADA}:USD"));
    assert_eq!(text(&sets[0], &["partnerBank"]), "TEST partner bank");
    let number = text(&sets[0], &["accountNumber"]);
    let form = data(&query(&b, "salary.form", r#"{"currency":"USD"}"#));
    assert_eq!(text(&form, &["holderName"]), HOLDER);
    assert_eq!(text(&form, &["accountNumber"]), number);
    assert_eq!(text(&form, &["partnerBank"]), "TEST partner bank");
    let words = text(&form, &["text"]);
    assert!(words.contains(&format!("Account holder: {HOLDER}")));
    assert!(words.contains(&format!("Account number: {number}")));
    assert_eq!(
        trpc(
            &b,
            ADA,
            "POST",
            "testPartner.set",
            r#"{"holderName":null}"#,
            &["bank:read", "bank:write"]
        )
        .0,
        200
    );
    assert_eq!(
        code(&query(&b, "salary.form", r#"{"currency":"USD"}"#)),
        "bank.direct_deposit_holder_unknown"
    );
}

#[test]
fn n3_n4_n5_credits_once_at_the_partner_splits_10_percent_into_savings_once_and_a_replay_posts_nothing()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let space = savings(&db);
    split10(&db, &space);
    let first = credit(&b, "net-1", "2000.00", HOLDER);
    assert_eq!(first.0, 200, "{}", first.1.compact());
    assert_eq!(text(&first.1, &["replayed"]), "false");
    assert_eq!(text(&first.1, &["credit", "state"]), "received");
    assert_eq!(text(&first.1, &["credit", "originatorName"]), EMPLOYER);
    assert_eq!(text(&first.1, &["credit", "amount"]), "2000");
    let Some(Json::Array(legs)) = field(&first.1, &["credit"]).get("legs") else {
        panic!("legs")
    };
    assert_eq!(legs.len(), 1);
    assert_eq!(
        (
            text(&legs[0], &["status"]),
            text(&legs[0], &["amount"]),
            text(&legs[0], &["spaceId"])
        ),
        ("settled".to_owned(), "200".to_owned(), space.clone())
    );
    assert_eq!(held(&b, None), "1800");
    assert_eq!(held(&b, Some(&space)), "200");
    assert_eq!(
        move_by_key(&b, "salary:credit:net-1").unwrap().0,
        text(&first.1, &["credit", "creditMoveId"])
    );
    assert_eq!(move_by_key(&b, "salary:split:net-1:0").unwrap().1, "200");

    let again = credit(&b, "net-1", "2000.00", HOLDER);
    assert_eq!(text(&again.1, &["replayed"]), "true");
    assert_eq!(held(&b, None), "1800");
    assert_eq!(held(&b, Some(&space)), "200");
    assert_eq!(salary_moves(&b, |k| k.starts_with("salary:")), 2);
    let listed = data(&query(&b, "salary.credits", r#"{"limit":10}"#));
    assert!(
        matches!(&listed, Json::Array(a) if a.len() == 1),
        "{}",
        listed.compact()
    );
    assert_eq!(
        code(&credit(&b, "net-1", "2001", HOLDER)),
        "bank.direct_deposit_conflict"
    );
    // The ledger posts nothing for money the partner holds: this part holds no ledger client, and the store holds no
    // row but the credit and its leg.
    assert_eq!(db.count("SELECT count(*) FROM bank.salary_credits"), 1);
    assert_eq!(db.count("SELECT count(*) FROM bank.salary_split_legs"), 1);
}

#[test]
fn n6_returns_a_credit_that_names_another_account_holder_crediting_nothing() {
    let Some(db) = db() else { return };
    let b = bank(&db);
    main_space(&db);
    let back = credit(&b, "net-2", "75", "TEST Somebody Else");
    assert_eq!(back.0, 200);
    assert_eq!(text(&back.1, &["credit", "state"]), "returned");
    assert_eq!(
        text(&back.1, &["credit", "refusalCode"]),
        "bank.direct_deposit_name_mismatch"
    );
    assert_eq!(text(&back.1, &["credit", "creditMoveId"]), "null");
    assert_eq!(held(&b, None), "0");
    assert_eq!(move_by_key(&b, "salary:credit:net-2"), None);
    // Case and spacing do not make a different name.
    assert_eq!(
        text(
            &credit(&b, "net-3", "5", "  test ada   LOVELACE ").1,
            &["credit", "state"]
        ),
        "received"
    );
}

#[test]
fn n7_reverses_inside_the_window_split_legs_come_back_first_then_the_whole_credit_leaves_once() {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let space = savings(&db);
    split10(&db, &space);
    assert_eq!(credit(&b, "net-4", "2000", HOLDER).0, 200);
    let reversed = reverse(&b, "net-4");
    assert_eq!(reversed.0, 200, "{}", reversed.1.compact());
    assert_eq!(text(&reversed.1, &["credit", "state"]), "reversed");
    let Some(Json::Array(legs)) = field(&reversed.1, &["credit"]).get("legs") else {
        panic!("legs")
    };
    assert_eq!(text(&legs[0], &["status"]), "unsplit");
    assert_eq!(held(&b, None), "0");
    assert_eq!(held(&b, Some(&space)), "0");
    assert_eq!(move_by_key(&b, "salary:reverse:net-4").unwrap().1, "2000");
    // Asked again, the same reversal: nothing more moves.
    assert_eq!(
        text(&reverse(&b, "net-4").1, &["credit", "reversalMoveId"]),
        text(&reversed.1, &["credit", "reversalMoveId"])
    );
    assert_eq!(salary_moves(&b, |k| k == "salary:reverse:net-4"), 1);
}

#[test]
fn a_split_or_reversal_move_asks_the_posting_freeze_and_the_operator_stop_and_moves_nothing_while_either_refuses()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let space = savings(&db);
    split10(&db, &space);
    // Frozen: the network's pay-in lands (the partner's own act), but our split instruction is refused and stays pending.
    b.posting(false);
    assert_eq!(
        code(&credit(&b, "net-guard", "2000", HOLDER)),
        "bank.posting_frozen"
    );
    assert_eq!(held(&b, None), "2000");
    assert_eq!(held(&b, Some(&space)), "0");
    assert_eq!(move_by_key(&b, "salary:split:net-guard:0"), None);
    // Lifted: the network's retry sends the split once under the same key.
    b.posting(true);
    let retry = credit(&b, "net-guard", "2000", HOLDER);
    let Some(Json::Array(legs)) = field(&retry.1, &["credit"]).get("legs") else {
        panic!("legs")
    };
    assert_eq!(text(&legs[0], &["status"]), "settled");
    assert_eq!(held(&b, Some(&space)), "200");

    // An operator's stop on partner moves refuses the reversal before the partner is asked, with the freeze open.
    stop(&db, &["bank_move"]);
    assert_eq!(code(&reverse(&b, "net-guard")), "bank.partner_stopped");
    assert_eq!(held(&b, None), "1800");
    assert_eq!(held(&b, Some(&space)), "200");
    assert_eq!(
        salary_moves(&b, |k| k.starts_with("salary:")
            && k != "salary:credit:net-guard"),
        1
    );
}

#[test]
fn n7_refuses_a_reversal_the_account_cannot_pay_outside_the_window_unpublished_or_of_a_returned_credit()
 {
    let Some(db) = db() else { return };
    let mut b = bank(&db);
    main_space(&db);
    assert_eq!(credit(&b, "net-5", "500", HOLDER).0, 200);
    b.partner()
        .lock()
        .move_raw(
            &MoveRequest {
                key: "test:spend".to_owned(),
                from: AccountRef {
                    user_id: ADA.to_owned(),
                    asset_id: "USD".to_owned(),
                    space_id: None,
                },
                to: AccountRef {
                    user_id: "partner:test-merchant".to_owned(),
                    asset_id: "USD".to_owned(),
                    space_id: None,
                },
                amount: parse_amount("400").unwrap(),
                payees: None,
            },
            clock(),
        )
        .unwrap();
    assert_eq!(
        code(&reverse(&b, "net-5")),
        "bank.direct_deposit_reversal_insufficient"
    );
    assert_eq!(held(&b, None), "100");

    assert_eq!(credit(&b, "net-6", "50", HOLDER).0, 200);
    AHEAD.with(|a| a.set(6 * DAY_MS));
    assert_eq!(
        code(&reverse(&b, "net-6")),
        "bank.direct_deposit_reversal_window"
    );
    AHEAD.with(|a| a.set(0));
    b.make(Make {
        reversal_days: Some(""),
        ..MAKE
    });
    assert_eq!(
        code(&reverse(&b, "net-6")),
        "bank.direct_deposit_reversal_window_unset"
    );

    assert_eq!(credit(&b, "net-7", "5", "TEST Nobody").0, 200);
    b.make(MAKE);
    assert_eq!(
        code(&reverse(&b, "net-7")),
        "bank.direct_deposit_not_received"
    );
    assert_eq!(
        code(&reverse(&b, "net-unknown")),
        "bank.direct_deposit_not_found"
    );
}

#[test]
fn n8_the_rail_desk_reads_matches_the_network_credits_minus_reversals_equal_what_the_app_showed() {
    let Some(db) = db() else { return };
    let b = bank(&db);
    main_space(&db);
    assert_eq!(credit(&b, "net-8", "2000", HOLDER).0, 200);
    assert_eq!(credit(&b, "net-9", "500", HOLDER).0, 200);
    assert_eq!(credit(&b, "net-10", "9", "TEST Nobody").0, 200);
    assert_eq!(reverse(&b, "net-9").0, 200);
    let desk = || {
        data(&trpc(
            &b,
            ADA,
            "GET",
            "ops.salaryRails",
            "",
            &["admin:read"],
        ))
    };
    assert_eq!(
        field(&desk(), &["partner", "lines"]).compact(),
        r#"[{"currency":"USD","network":{"credits":"2500","reversals":"500"},"app":{"credits":"2500","reversals":"500"},"matches":true,"difference":"0"}]"#
    );
    assert_eq!(
        text(&desk(), &["partner", "label"]),
        "TEST payroll network (payroll-sim), payroll-sim"
    );
    // A row the network never carried is a difference, named.
    db.client()
        .execute(
            "INSERT INTO bank.salary_credits (network_id, user_id, account_details_id, asset_id, amount, originator_name, holder_name, state, credit_move_id, received_at) \
             VALUES ('net-ghost', $1, 'x', 'USD', 7, $2, $3, 'received', 'ghost', now())",
            &[&ADA, &EMPLOYER, &HOLDER],
        )
        .unwrap();
    let Json::Array(lines) = field(&desk(), &["partner", "lines"]).clone() else {
        panic!("lines")
    };
    assert_eq!(
        (
            text(&lines[0], &["matches"]),
            text(&lines[0], &["difference"])
        ),
        ("false".to_owned(), "-7".to_owned())
    );
}

#[test]
fn refuses_a_credit_to_details_nobody_holds_or_to_a_person_whose_money_is_not_at_the_partner() {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let bob = credit_body("net-x", "1", HOLDER, &format!("test-partner:{BOB}:USD"));
    assert_eq!(
        code(&job(&b, "credit", &bob)),
        "bank.direct_deposit_details_unknown"
    );
    assert_eq!(
        trpc(
            &b,
            ADA,
            "POST",
            "testPartner.set",
            r#"{"custody":"on"}"#,
            &["bank:read", "bank:write"]
        )
        .0,
        200
    );
    assert_eq!(
        code(&credit(&b, "net-y", "1", HOLDER)),
        "bank.partner_unset"
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.salary_credits"), 0);
}

#[test]
fn refuses_to_start_payroll_sim_outside_dev_test_or_without_the_test_partner() {
    let env = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    let sim = ("BANK_PAYROLL_PARTNER", "payroll-sim");
    assert!(
        Wiring::from_env(&env(&[
            sim,
            ("BANK_TEST_PARTNER", "test"),
            ("APP_ENV", "production")
        ]))
        .is_err()
    );
    assert!(Wiring::from_env(&env(&[sim, ("APP_ENV", "test"), ("NODE_ENV", "test")])).is_err());
    assert!(
        Wiring::from_env(&env(&[
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("BANK_PAYROLL_SIM_RECORDS_DIR", "relative/dir")
        ]))
        .is_err()
    );
    assert!(
        Wiring::from_env(&env(&[("APP_ENV", "test"), ("NODE_ENV", "test")]))
            .unwrap()
            .salary
            .payroll
            .is_none()
    );
}
