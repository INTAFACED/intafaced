//! Extra deposit addresses through the Rust door against a real Postgres: the checks of the TypeScript's
//! `deposits/deposit-addresses.db.test.ts`, each test named after its words. The owner's cap and expiry window are TEST
//! values handed in; custody is a memory port that issues one address per number and keeps the expiry it was first
//! given, as svc-pay does. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner_account::Wiring;
use svc_bank::partner_account::deposits::{self, pay};

use support::TestDb;

const SECRET: &str = "a-bank-deposit-addresses-edge-secret-long-0";
const HOLDER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const PAIR: &str = r#""assetId":"USDT","networkId":"testnet""#;

/// `NOW`: 2026-10-24T12:00:00.000Z.
fn now() -> Instant {
    Instant(1792843200000)
}

#[derive(Default)]
struct Book {
    asked: Vec<pay::AddressRequest>,
    stored: BTreeMap<String, (String, Option<String>)>,
}

/// `memoryCustody`: one address per user, asset, network and number, the expiry kept from the first ask.
#[derive(Clone, Default)]
struct Memory {
    book: Arc<Mutex<Book>>,
    halted: bool,
    refuse: bool,
    no_expiry: bool,
}

impl Memory {
    fn asked(&self) -> usize {
        self.book.lock().unwrap().asked.len()
    }
    fn last(&self) -> pay::AddressRequest {
        self.book.lock().unwrap().asked.last().cloned().unwrap()
    }
}

impl pay::Custody for Memory {
    fn catalogue(&self) -> Result<Option<pay::Catalogue>, String> {
        let network = pay::Network {
            id: "testnet".into(),
            label: "Test network".into(),
            minimum_deposit: "10".into(),
            confirmations_required: 6,
            estimated_arrival_minutes: 5,
            unsupported: None,
        };
        Ok(Some(if self.halted {
            pay::Catalogue {
                assets: Vec::new(),
                halted: vec![pay::Halted {
                    asset_id: "USDT".into(),
                    network_id: "testnet".into(),
                    label: "Test network".into(),
                    halt_note: None,
                }],
            }
        } else {
            pay::Catalogue {
                assets: vec![pay::Asset {
                    asset_id: "USDT".into(),
                    networks: vec![network],
                }],
                halted: Vec::new(),
            }
        }))
    }

    fn address(&self, req: &pay::AddressRequest) -> Result<Option<pay::Issued>, String> {
        let mut book = self.book.lock().unwrap();
        book.asked.push(req.clone());
        if self.refuse {
            return Ok(None);
        }
        let index = req.address_index.unwrap_or(0);
        let key = format!(
            "{}:{}:{}:{index}",
            req.user_id, req.asset_id, req.network_id
        );
        let row = book
            .stored
            .entry(key)
            .or_insert_with(|| {
                (
                    format!("test-addr-{}-{index}", &req.user_id[..4]),
                    req.expires_at.clone(),
                )
            })
            .clone();
        Ok(Some(pay::Issued {
            address: row.0,
            memo: None,
            qr_payload: None,
            expires_at: if self.no_expiry { None } else { row.1 },
        }))
    }

    fn pending(&self, _: &str) -> Result<Option<Vec<pay::Pending>>, String> {
        Ok(Some(Vec::new()))
    }

    fn records(&self, _: &pay::RecordsQuery) -> Result<Option<pay::Page>, String> {
        Ok(None)
    }
}

/// `memoryAssetRegistry([registryRow('USDT', { state })])`.
struct Listed(&'static str);

impl pay::Registry for Listed {
    fn listed(&self) -> Result<Vec<pay::RegistryAsset>, String> {
        Ok(vec![pay::RegistryAsset {
            id: "USDT".into(),
            precision: 6,
            state: self.0.into(),
            allowed_actions: ["deposit", "withdraw", "trade", "transfer"]
                .map(str::to_owned)
                .to_vec(),
            networks: vec!["testnet".into()],
        }])
    }
}

fn env() -> BTreeMap<String, String> {
    [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// `caller(custody, userId, owner, registry)`: the door with this custody, the owner's settings and the registry.
fn door(
    db: &TestDb,
    custody: &Memory,
    cap: Option<&str>,
    days: Option<&str>,
    state: &'static str,
) -> BankDoor {
    let mut wiring = Wiring::from_env(&env()).unwrap();
    wiring.deposits = deposits::Wiring {
        custody: Box::new(custody.clone()),
        registry: Box::new(Listed(state)),
        address_cap: cap.map(str::to_owned),
        address_expiry_days: days.map(str::to_owned),
    };
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env: env(),
        now,
        store: db.store(),
    })
    .unwrap()
    .with_partner_account(wiring)
}

fn owned(db: &TestDb, custody: &Memory) -> BankDoor {
    door(db, custody, Some("3"), Some("30"), "active")
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
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn send(b: &BankDoor, method: &str, url: &str, body: &str, user: &str) -> (u16, Json) {
    let mut headers = person(user);
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-deposit-addresses",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(b: &BankDoor, user: &str, path: &str, input: &str) -> (u16, Json) {
    send(b, "POST", &format!("/trpc/{path}"), input, user)
}

fn query(b: &BankDoor, user: &str, path: &str, input: Option<&str>) -> (u16, Json) {
    let url = match input {
        Some(i) => format!(
            "/trpc/{path}?input={}",
            url::form_urlencoded::byte_serialize(i.as_bytes()).collect::<String>()
        ),
        None => format!("/trpc/{path}"),
    };
    send(b, "GET", &url, "", user)
}

/// The answer's data, or a panic naming the refusal.
fn data(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
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

fn message(answer: &(u16, Json)) -> String {
    match answer.1.get("error").and_then(|e| e.get("message")) {
        Some(Json::String(m)) => m.clone(),
        _ => String::new(),
    }
}

fn field(v: &Json, key: &str) -> Json {
    v.get(key).cloned().unwrap_or(Json::Null)
}

fn items(list: &Json) -> Vec<Json> {
    match list.get("items") {
        Some(Json::Array(a)) => a.clone(),
        _ => panic!("no items: {}", list.compact()),
    }
}

fn first(b: &BankDoor, user: &str) -> Json {
    data(mutate(b, user, "deposits.address", &format!("{{{PAIR}}}")))
}

fn create(b: &BankDoor, user: &str, extra: &str) -> (u16, Json) {
    mutate(
        b,
        user,
        "deposits.addresses.create",
        &format!("{{{PAIR}{extra}}}"),
    )
}

fn label(b: &BankDoor, user: &str, index: i64, label: &str) -> (u16, Json) {
    mutate(
        b,
        user,
        "deposits.addresses.label",
        &format!(r#"{{{PAIR},"addressIndex":{index},"label":{label}}}"#),
    )
}

fn count(db: &TestDb) -> i64 {
    db.count("SELECT count(*)::bigint FROM bank.deposit_addresses")
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

#[test]
fn a_blank_cap_or_expiry_window_refuses_by_name_before_custody_is_asked_and_the_list_says_both_are_unpublished()
 {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    for (cap, days, want) in [
        (None, Some("30"), "bank.deposit_address_cap_unset"),
        (Some(" "), Some("30"), "bank.deposit_address_cap_unset"),
        (Some("0"), Some("30"), "bank.deposit_address_cap_unset"),
        (Some("3"), None, "bank.deposit_address_expiry_unset"),
        (Some("3"), Some("1.5"), "bank.deposit_address_expiry_unset"),
    ] {
        let b = door(&db, &custody, cap, days, "active");
        assert_eq!(code(&create(&b, HOLDER, r#","label":"Savings""#)), want);
    }
    assert_eq!(custody.asked(), 0);
    assert_eq!(count(&db), 0);
    let b = door(&db, &custody, None, None, "active");
    assert_eq!(
        data(query(&b, HOLDER, "deposits.addresses.list", None)).compact(),
        r#"{"items":[],"cap":null,"expiryDays":null}"#
    );
}

#[test]
fn lists_the_first_address_and_each_extra_one_with_its_label_and_expiry_numbered_without_reuse() {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    let b = owned(&db, &custody);
    first(&b, HOLDER);
    let savings = data(create(&b, HOLDER, r#","label":"  Savings ""#));
    assert_eq!(field(&savings, "addressIndex"), Json::int(1));
    assert_eq!(field(&savings, "address"), Json::str("test-addr-1111-1"));
    assert_eq!(field(&savings, "label"), Json::str("Savings"));
    assert_eq!(
        field(&savings, "expiresAt"),
        Json::str("2026-11-23T12:00:00.000Z")
    );
    assert_eq!(field(&savings, "state"), Json::str("active"));
    // Custody was asked for number 1 with the owner's window from now.
    assert_eq!(
        custody.last(),
        pay::AddressRequest {
            user_id: HOLDER.into(),
            asset_id: "USDT".into(),
            network_id: "testnet".into(),
            address_index: Some(1),
            expires_at: Some("2026-11-23T12:00:00.000Z".into()),
        }
    );
    data(create(&b, HOLDER, ""));
    let list = data(query(
        &b,
        HOLDER,
        "deposits.addresses.list",
        Some(r#"{"assetId":"USDT"}"#),
    ));
    assert_eq!(field(&list, "cap"), Json::int(3));
    assert_eq!(field(&list, "expiryDays"), Json::int(30));
    // The first address, then the newest first.
    let rows: Vec<String> = items(&list)
        .iter()
        .map(|r| {
            Json::Array(vec![
                field(r, "addressIndex"),
                field(r, "label"),
                field(r, "expiresAt"),
                field(r, "state"),
            ])
            .compact()
        })
        .collect();
    assert_eq!(
        rows,
        [
            r#"[0,null,null,"active"]"#,
            r#"[2,null,"2026-11-23T12:00:00.000Z","active"]"#,
            r#"[1,"Savings","2026-11-23T12:00:00.000Z","active"]"#,
        ]
    );
    // The first address door still returns the first address, never an extra one.
    assert_eq!(
        field(&first(&b, HOLDER), "address"),
        Json::str("test-addr-1111-0")
    );
    assert!(items(&data(query(&b, OTHER, "deposits.addresses.list", None))).is_empty());
}

#[test]
fn refuses_beyond_the_cap_with_the_cap_named_asks_custody_for_nothing_and_an_expired_address_frees_a_place()
 {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    let b = owned(&db, &custody);
    first(&b, HOLDER);
    data(create(&b, HOLDER, ""));
    data(create(&b, HOLDER, ""));
    let before = custody.asked();
    let over = create(&b, HOLDER, "");
    assert_eq!(code(&over), "bank.deposit_address_cap_reached");
    assert!(message(&over).contains("at most 3"), "{}", message(&over));
    assert_eq!(custody.asked(), before);
    assert_eq!(count(&db), 3);

    // Number 1 expires: it stays listed as expired, and the next address is number 3, never 1 again.
    db.client()
        .execute(
            "UPDATE bank.deposit_addresses SET expires_at = now() - interval '1 minute' WHERE address_index = 1",
            &[],
        )
        .unwrap();
    let third = data(create(&b, HOLDER, ""));
    assert_eq!(field(&third, "addressIndex"), Json::int(3));
    let states: Vec<String> = items(&data(query(&b, HOLDER, "deposits.addresses.list", None)))
        .iter()
        .map(|r| Json::Array(vec![field(r, "addressIndex"), field(r, "state")]).compact())
        .collect();
    assert_eq!(
        states,
        [
            r#"[0,"active"]"#,
            r#"[3,"active"]"#,
            r#"[2,"active"]"#,
            r#"[1,"expired"]"#
        ]
    );
}

#[test]
fn counts_the_first_address_in_the_cap_even_before_it_is_asked_for_and_refuses_once_every_number_is_used()
 {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    let b = owned(&db, &custody);
    data(create(&b, HOLDER, ""));
    data(create(&b, HOLDER, ""));
    assert_eq!(
        code(&create(&b, HOLDER, "")),
        "bank.deposit_address_cap_reached"
    );
    // Asking for the first address afterwards fills its reserved place: three open, the cap.
    first(&b, HOLDER);
    let active = items(&data(query(&b, HOLDER, "deposits.addresses.list", None)))
        .iter()
        .filter(|r| field(r, "state") == Json::str("active"))
        .count();
    assert_eq!(active, 3);

    let mut c = db.client();
    c.batch_execute("TRUNCATE bank.deposit_addresses").unwrap();
    c.execute(
        "INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at) \
         VALUES ($1, 'USDT', 'testnet', 0, 'first', NULL), ($1, 'USDT', 'testnet', 9999, 'last', now() - interval '1 day')",
        &[&HOLDER],
    )
    .unwrap();
    assert_eq!(
        code(&create(&b, HOLDER, "")),
        "bank.deposit_address_numbers_used"
    );
}

#[test]
fn makes_at_most_the_cap_under_concurrent_requests() {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    let b = owned(&db, &custody);
    first(&b, HOLDER);
    let made = std::thread::scope(|s| {
        let runs: Vec<_> = (0..6)
            .map(|_| s.spawn(|| create(&b, HOLDER, "").0))
            .collect();
        runs.into_iter()
            .map(|r| r.join().unwrap())
            .filter(|status| *status == 200)
            .count()
    });
    assert_eq!(made, 2);
    assert_eq!(count(&db), 3);
}

#[test]
fn gives_no_extra_address_for_a_switched_off_pair_one_the_supported_list_does_not_allow_or_when_custody_will_not_issue()
 {
    let Some(db) = db() else { return };
    let off = Memory {
        halted: true,
        ..Memory::default()
    };
    assert_eq!(
        code(&create(&owned(&db, &off), HOLDER, "")),
        "bank.deposit_network_halted"
    );
    let retired = Memory::default();
    let b = door(&db, &retired, Some("3"), Some("30"), "retired");
    assert_eq!(
        code(&create(&b, HOLDER, "")),
        "bank.deposit_asset_unpublished"
    );
    let refusing = Memory {
        refuse: true,
        ..Memory::default()
    };
    assert_eq!(
        code(&create(&owned(&db, &refusing), HOLDER, "")),
        "bank.deposit_custody_unset"
    );
    assert_eq!(off.asked(), 0);
    assert_eq!(retired.asked(), 0);
    assert_eq!(count(&db), 0);
}

#[test]
fn a_custody_answer_with_no_expiry_for_an_extra_address_is_not_stored() {
    let Some(db) = db() else { return };
    let no_expiry = Memory {
        no_expiry: true,
        ..Memory::default()
    };
    assert_eq!(
        code(&create(&owned(&db, &no_expiry), HOLDER, "")),
        "bank.deposit_catalogue_invalid"
    );
    assert_eq!(count(&db), 0);
}

#[test]
fn sets_keeps_and_clears_a_label_refuses_a_bad_one_and_anyone_elses_address() {
    let Some(db) = db() else { return };
    let custody = Memory::default();
    let b = owned(&db, &custody);
    first(&b, HOLDER);
    data(create(&b, HOLDER, r#","label":"Savings""#));
    let named = data(label(&b, HOLDER, 1, r#""Exchange payouts""#));
    assert_eq!(field(&named, "label"), Json::str("Exchange payouts"));
    let again = data(label(&b, HOLDER, 1, r#""Exchange payouts""#));
    assert_eq!(field(&again, "label"), Json::str("Exchange payouts"));
    assert_eq!(
        field(&data(label(&b, HOLDER, 0, r#""Main""#)), "label"),
        Json::str("Main")
    );
    assert_eq!(
        field(&data(label(&b, HOLDER, 1, r#""""#)), "label"),
        Json::Null
    );
    let long = format!("\"{}\"", "x".repeat(41));
    assert_eq!(
        code(&label(&b, HOLDER, 1, &long)),
        "bank.deposit_address_label_invalid"
    );
    assert_eq!(
        code(&create(&b, HOLDER, r#","label":"tab\there""#)),
        "bank.deposit_address_label_invalid"
    );
    assert_eq!(
        code(&label(&b, OTHER, 1, r#""Mine now""#)),
        "bank.deposit_address_not_found"
    );
    assert_eq!(
        code(&label(&b, HOLDER, 7, r#""Nowhere""#)),
        "bank.deposit_address_not_found"
    );
    let rows: Vec<(i32, Option<String>)> = db
        .client()
        .query(
            "SELECT address_index, label FROM bank.deposit_addresses ORDER BY address_index",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(rows, [(0, Some("Main".to_owned())), (1, None)]);
}

#[test]
fn refuses_at_the_table_an_index_outside_0_to_9999_an_expiry_that_does_not_match_the_index_and_an_untrimmed_label()
 {
    let Some(db) = db() else { return };
    let insert = |index: i32, expires: Option<&str>, label: Option<&str>| {
        db.client().execute(
            "INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at, label) \
             VALUES ($1, 'USDT', 'testnet', $2, $3, $4::text::timestamptz, $5)",
            &[&HOLDER, &index, &format!("addr-{index}"), &expires, &label],
        )
    };
    let padded = " padded";
    let long = "y".repeat(41);
    assert!(insert(10000, Some("2026-11-24T00:00:00Z"), None).is_err());
    assert!(insert(1, None, None).is_err());
    assert!(insert(0, Some("2026-11-24T00:00:00Z"), None).is_err());
    assert!(insert(0, None, Some(padded)).is_err());
    assert!(insert(0, None, Some(&long)).is_err());
}
