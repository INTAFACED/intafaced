//! The `balances` slice against a real Postgres (`TEST_DATABASE_URL_LEDGER` or `TEST_DATABASE_URL`, a server whose
//! admin database name ends in `_test`), each test in its own throwaway database. Without a URL it skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! Every call goes through the door, signed as a service would sign it, so the answers are the wire's. The cases are
//! the TypeScript's for these five doors:
//! - `s2s-http.test.ts`: decimal-string balances, a missing account as typed zero, an infra failure as a 500 and never
//!   a 0, purpose surfaced so two holds stay apart, and the portfolio's indexer half present or named absent;
//! - `s2s-tx-by-key.test.ts` and `s2s-tx-by-id.test.ts`: not found, found with exactly the fields each answers, a
//!   refused input, and the service-credential door;
//! - `ledger/tx-hash-bind.test.ts`: a transaction whose claim no longer matches it is refused, not answered;
//! - `ledger/postgres-ledger.ts`: a read never creates an account, and purpose is matched after its trim.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use postgres::{Client, NoTls};
use service_kit::http::{FETCH_FAILED, Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::tokens::TokenConfig;
use svc_ledger::db::{self, Store};
use svc_ledger::door::{DoorConfig, LedgerDoor, Outcome};
use svc_ledger::migrate::{self, FILES};

const SECRET: &str = "placeholder-balances-test-secret-32ch";
const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAIN: &str = "0x1111111111111111111111111111111111111111";

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_LEDGER").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_LEDGER or TEST_DATABASE_URL is required"
    );
    url
}

fn assert_test_database(c: &mut Client) {
    let name: String = c
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        name.ends_with("_test"),
        "refusing: {name} is not a test database (its name must end in _test)"
    );
}

struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// A fresh database with every migration applied.
    fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_ledger_bal_{}_{}_{nanos:x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        let mut c = db.client();
        assert_test_database(&mut c);
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"ledger\"",
        )
        .unwrap();
        migrate::apply(&mut c, &FILES, false, &mut Vec::new()).unwrap();
        Some(db)
    }

    fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    fn store(&self) -> Store {
        db::open(&self.url, "svc-ledger", 2, false).unwrap()
    }

    fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    /// An account with this balance; its id.
    fn account(
        &self,
        owner_type: &str,
        owner_id: &str,
        asset: &str,
        kind: &str,
        purpose: &str,
        balance: &str,
    ) -> String {
        self.client()
            .query_one(
                "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
                 VALUES ($1::text::ledger.owner_type, $2, $3, $4::text::ledger.account_kind, $5, $6::text::numeric)
                 RETURNING id::text",
                &[&owner_type, &owner_id, &asset, &kind, &purpose, &balance],
            )
            .unwrap()
            .get(0)
    }

    /// A booked transaction and its claim, with these entries `(account, asset, direction, amount, balance_after)`;
    /// its id and `posted_at` as `toISOString` gives it.
    fn tx(
        &self,
        key: &str,
        module: &str,
        reason: &str,
        meta: &str,
        entries: &[(&str, &str, &str, &str, &str)],
    ) -> (String, String) {
        let mut client = self.client();
        // One transaction: the book checks at commit that each asset's debits equal its credits.
        let mut c = client.transaction().unwrap();
        let row = c
            .query_one(
                "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, meta, hash, previous_hash, posted_at)
                 VALUES ($1, $2, $3, $4::text::jsonb, md5($1), NULL, '2026-11-21 03:04:05.678912+00')
                 RETURNING id::text, to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
                &[&key, &module, &reason, &meta],
            )
            .unwrap();
        let (id, at): (String, String) = (row.get(0), row.get(1));
        c.execute(
            "INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta)
             SELECT idempotency_key, id, hash, meta FROM ledger.ledger_tx WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
        for (account, asset, direction, amount, after) in entries {
            c.execute(
                "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::ledger.direction, $5::text::numeric, $6::text::numeric)",
                &[&id, account, asset, direction, amount, after],
            )
            .unwrap();
        }
        c.commit().unwrap();
        (id, at)
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

/// A stand-in for the indexer: what it answers, and every request it was sent.
struct Indexer {
    answer: Result<HttpResponse, FetchError>,
    seen: Mutex<Vec<HttpRequest>>,
}

impl Indexer {
    fn answering(status: u16, body: &str) -> Arc<Indexer> {
        Arc::new(Indexer {
            answer: Ok(HttpResponse {
                status,
                body: body.to_owned(),
            }),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn failing() -> Arc<Indexer> {
        Arc::new(Indexer {
            answer: Err(FetchError {
                message: FETCH_FAILED.to_owned(),
            }),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn seen(&self) -> Vec<HttpRequest> {
        self.seen.lock().unwrap().clone()
    }
}

impl Fetch for Indexer {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.seen.lock().unwrap().push(req.clone());
        self.answer.clone()
    }
}

fn door_with(store: Store, indexer_url: Option<&str>, fetch: Arc<dyn Fetch>) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        internal_secret: SECRET.to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        tokens: TokenConfig {
            secret: "placeholder-balances-test-token-secret".to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store,
        service_name: "svc-ledger".to_owned(),
        indexer_url: indexer_url.map(str::to_owned),
        fetch,
    })
    .unwrap()
}

fn door(db: &TestDb) -> LedgerDoor {
    door_with(db.store(), None, Indexer::failing())
}

/// `POST <path>` signed by `caller` under the shared secret (or unsigned): the status and the parsed body.
fn call(door: &LedgerDoor, path: &str, body: &str, caller: Option<&str>) -> (u16, Json) {
    let mut headers: Vec<(String, String)> = match caller {
        Some(svc) => legacy_headers(svc, SECRET, body, system_seconds()).unwrap(),
        None => Vec::new(),
    };
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let outcome = door.decide(&Request {
        method: "POST",
        url: path,
        headers: &headers,
        body,
    });
    match outcome {
        Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
        Outcome::Owed(s) => panic!("{path} is still owed by {}", s.name()),
    }
}

fn bank(door: &LedgerDoor, path: &str, body: &str) -> (u16, Json) {
    call(door, path, body, Some("svc-bank"))
}

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k} is not a string: {other:?} in {}", v.compact()),
    }
}

fn available(asset: &str) -> String {
    format!(r#"{{"ownerType":"user","ownerId":"{USER}","assetId":"{asset}","kind":"available"}}"#)
}

// ---- balance ----

#[test]
fn a_balance_is_a_decimal_string_with_its_account_and_an_empty_purpose_for_available() {
    let Some(db) = TestDb::new() else { return };
    let id = db.account("user", USER, "USDT", "available", "", "42");
    let (status, out) = bank(&door(&db), "/trpc/balance", &available("USDT"));
    assert_eq!(status, 200);
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"accountId":"{id}","assetId":"USDT","kind":"available","purpose":"","amount":"42"}}"#
        )
    );
}

#[test]
fn an_amount_keeps_all_eighteen_places_and_a_treasury_balance_its_sign() {
    let Some(db) = TestDb::new() else { return };
    db.account(
        "user",
        USER,
        "ETH",
        "available",
        "",
        "12345678901234567890.000000000000000001",
    );
    let (_, out) = bank(&door(&db), "/trpc/balance", &available("ETH"));
    assert_eq!(s(&out, "amount"), "12345678901234567890.000000000000000001");

    db.account("treasury", "rail:test", "USDT", "available", "", "-5.5");
    let body =
        r#"{"ownerType":"treasury","ownerId":"rail:test","assetId":"USDT","kind":"available"}"#;
    let (status, out) = bank(&door(&db), "/trpc/balance", body);
    assert_eq!(status, 200, "{}", out.compact());
    assert_eq!(s(&out, "amount"), "-5.5");
}

#[test]
fn a_missing_account_is_typed_zero_and_the_read_creates_no_row() {
    let Some(db) = TestDb::new() else { return };
    let (status, out) = bank(&door(&db), "/trpc/balance", &available("USDT"));
    assert_eq!(status, 200);
    assert_eq!(s(&out, "accountId"), "");
    assert_eq!(out.get("amount"), Some(&Json::str("0")));
    assert_eq!(db.count("SELECT count(*) FROM ledger.accounts"), 0);
}

#[test]
fn a_padded_purpose_reads_the_same_pot_and_answers_the_trimmed_purpose() {
    let Some(db) = TestDb::new() else { return };
    let id = db.account("user", USER, "USDT", "hold", "order:x", "3");
    let body = format!(
        r#"{{"ownerType":"user","ownerId":"{USER}","assetId":"USDT","kind":"hold","purpose":"  order:x "}}"#
    );
    let (status, out) = bank(&door(&db), "/trpc/balance", &body);
    assert_eq!(status, 200, "{}", out.compact());
    assert_eq!(s(&out, "accountId"), id);
    assert_eq!(s(&out, "purpose"), "order:x");
    assert_eq!(s(&out, "amount"), "3");
}

#[test]
fn an_infra_failure_is_a_500_never_a_zero() {
    for path in ["/trpc/balance", "/trpc/balances", "/trpc/portfolio"] {
        let d = door_with(
            Store::Down("connect ECONNREFUSED".to_owned()),
            None,
            Indexer::failing(),
        );
        let body = if path == "/trpc/balance" {
            available("USDT")
        } else {
            format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#)
        };
        let (status, out) = bank(&d, path, &body);
        assert_eq!(status, 500, "{path}");
        assert_eq!(
            out.compact(),
            r#"{"message":"Ledger request failed"}"#,
            "{path}"
        );
    }
    for (path, body) in [
        ("/trpc/txByKey", r#"{"idempotencyKey":"deposit:x"}"#),
        (
            "/trpc/txById",
            r#"{"txId":"00000000-0000-4000-8000-000000000000"}"#,
        ),
    ] {
        let d = door_with(Store::Down("down".to_owned()), None, Indexer::failing());
        let (status, out) = bank(&d, path, body);
        assert_eq!(status, 500, "{path}");
        assert!(out.get("found").is_none(), "{path}: never a found:false");
    }
}

// ---- balances ----

#[test]
fn balances_surface_purpose_so_two_holds_do_not_re_commingle_and_come_in_asset_kind_purpose_order()
{
    let Some(db) = TestDb::new() else { return };
    let b = db.account("user", USER, "USDT", "hold", "order:order-b", "20");
    let avail = db.account("user", USER, "USDT", "available", "", "5");
    let a = db.account("user", USER, "USDT", "hold", "order:order-a", "10");
    let btc = db.account("user", USER, "BTC", "available", "", "0.00000001");
    // Another owner's account is never listed.
    db.account(
        "user",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "USDT",
        "available",
        "",
        "99",
    );
    let (status, out) = bank(
        &door(&db),
        "/trpc/balances",
        &format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
    );
    assert_eq!(status, 200);
    let row = |id: &str, asset: &str, kind: &str, purpose: &str, amount: &str| {
        format!(
            r#"{{"accountId":"{id}","assetId":"{asset}","kind":"{kind}","purpose":"{purpose}","amount":"{amount}"}}"#
        )
    };
    assert_eq!(
        out.compact(),
        format!(
            "[{},{},{},{}]",
            row(&btc, "BTC", "available", "", "0.00000001"),
            row(&avail, "USDT", "available", "", "5"),
            row(&a, "USDT", "hold", "order:order-a", "10"),
            row(&b, "USDT", "hold", "order:order-b", "20"),
        )
    );
}

#[test]
fn an_owner_with_no_accounts_has_an_empty_list() {
    let Some(db) = TestDb::new() else { return };
    let (status, out) = bank(
        &door(&db),
        "/trpc/balances",
        &format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
    );
    assert_eq!((status, out.compact()), (200, "[]".to_owned()));
}

// ---- portfolio ----

#[test]
fn a_portfolio_without_an_indexer_has_its_holdings_and_a_named_absent_chain_half_never_a_zero() {
    let Some(db) = TestDb::new() else { return };
    let id = db.account("user", USER, "USDT", "available", "", "7");
    let indexer = Indexer::failing();
    let d = door_with(db.store(), None, indexer.clone());
    let body = format!(r#"{{"ownerType":"user","ownerId":"{USER}","chainAccount":"{CHAIN}"}}"#);
    let (status, out) = bank(&d, "/trpc/portfolio", &body);
    assert_eq!(status, 200);
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"ownerType":"user","ownerId":"{USER}","custodial":[{{"accountId":"{id}","assetId":"USDT","kind":"available","purpose":"","amount":"7"}}],"indexer":{{"status":"absent","reason":"indexer.portfolio_positions_unwired"}}}}"#
        )
    );
    assert!(indexer.seen().is_empty(), "no URL: nothing is asked");
}

#[test]
fn an_empty_book_is_an_empty_custodial_list() {
    let Some(db) = TestDb::new() else { return };
    let (status, out) = bank(
        &door(&db),
        "/trpc/portfolio",
        &format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
    );
    assert_eq!(status, 200);
    assert_eq!(out.get("custodial"), Some(&Json::Array(Vec::new())));
}

#[test]
fn present_indexer_positions_are_composed_when_the_url_and_the_0x_account_work() {
    let Some(db) = TestDb::new() else { return };
    let reply = format!(
        r#"{{"result":{{"data":[{{"market":"IFC-USD","account":"{CHAIN}","size":"-2","entryPrice":"11.5","blockHeight":3,"blockHash":"0xab"}}]}}}}"#
    );
    let indexer = Indexer::answering(200, &reply);
    let d = door_with(db.store(), Some(" http://indexer.test/ "), indexer.clone());
    let body = format!(r#"{{"ownerType":"user","ownerId":"{USER}","chainAccount":"{CHAIN}"}}"#);
    let (status, out) = bank(&d, "/trpc/portfolio", &body);
    assert_eq!(status, 200);
    assert_eq!(
        out.get("indexer").unwrap().compact(),
        r#"{"status":"present","positions":[{"market":"IFC-USD","size":"-2","entryPrice":"11.5"}]}"#
    );
    let seen = indexer.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "GET");
    assert_eq!(
        seen[0].url,
        format!("http://indexer.test/trpc/positions?input=%7B%22account%22%3A%22{CHAIN}%22%7D")
    );
    assert_eq!(seen[0].timeout_ms, Some(3_000));
}

#[test]
fn the_chain_half_is_named_absent_on_any_failure_or_shape_it_cannot_verify() {
    let Some(db) = TestDb::new() else { return };
    let pos = |size: &str| {
        format!(
            r#"{{"result":{{"data":[{{"market":"IFC-USD","account":"{CHAIN}","size":{size},"entryPrice":"1","blockHeight":3,"blockHash":"0xab"}}]}}}}"#
        )
    };
    let cases: Vec<(&str, Arc<Indexer>, Option<&str>)> = vec![
        ("fetch fails", Indexer::failing(), Some(CHAIN)),
        ("not ok", Indexer::answering(503, "[]"), Some(CHAIN)),
        ("not JSON", Indexer::answering(200, "<html>"), Some(CHAIN)),
        (
            "size a JSON number",
            Indexer::answering(200, &pos("2")),
            Some(CHAIN),
        ),
        (
            "size not decimal",
            Indexer::answering(200, &pos("\"1e3\"")),
            Some(CHAIN),
        ),
        (
            "not a list",
            Indexer::answering(200, r#"{"result":{"data":{}}}"#),
            Some(CHAIN),
        ),
        ("no account given", Indexer::answering(200, "[]"), None),
    ];
    for (why, indexer, chain) in cases {
        let d = door_with(db.store(), Some("http://indexer.test"), indexer.clone());
        let body = match chain {
            Some(c) => format!(r#"{{"ownerType":"user","ownerId":"{USER}","chainAccount":"{c}"}}"#),
            None => format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
        };
        let (status, out) = bank(&d, "/trpc/portfolio", &body);
        assert_eq!(status, 200, "{why}");
        assert_eq!(
            out.get("indexer").unwrap().compact(),
            r#"{"status":"absent","reason":"indexer.portfolio_positions_unwired"}"#,
            "{why}"
        );
        if chain.is_none() {
            assert!(indexer.seen().is_empty(), "no account: nothing is asked");
        }
    }
    // An empty present list is empty, not zero money.
    let d = door_with(
        db.store(),
        Some("http://indexer.test"),
        Indexer::answering(200, r#"{"result":{"data":[]}}"#),
    );
    let body = format!(r#"{{"ownerType":"user","ownerId":"{USER}","chainAccount":"{CHAIN}"}}"#);
    let (_, out) = bank(&d, "/trpc/portfolio", &body);
    assert_eq!(
        out.get("indexer").unwrap().compact(),
        r#"{"status":"present","positions":[]}"#
    );
    // A URL that is not http(s) is unwired, and nothing is asked.
    let indexer = Indexer::answering(200, "[]");
    let d = door_with(db.store(), Some("ftp://indexer.test"), indexer.clone());
    let (_, out) = bank(&d, "/trpc/portfolio", &body);
    assert_eq!(s(out.get("indexer").unwrap(), "status"), "absent");
    assert!(indexer.seen().is_empty());
}

// ---- txByKey and txById ----

/// A deposit booked the way `recipes.deposit` books one: the rail boundary debited, the user's available credited.
fn deposit(db: &TestDb) -> (String, String, String, String) {
    let rail = db.account("treasury", "rail:test", "USDT", "available", "", "-10");
    let user = db.account("user", USER, "USDT", "available", "", "10");
    let (id, at) = db.tx(
        "deposit:test:tx-by-id",
        "wallet",
        "deposit",
        r#"{"rail":"test","railRef":"tx-by-id"}"#,
        &[
            (&rail, "USDT", "debit", "10", "-10"),
            (&user, "USDT", "credit", "10.000000000000000000", "10"),
        ],
    );
    (id, at, rail, user)
}

fn hash_of(db: &TestDb, id: &str) -> String {
    db.client()
        .query_one(
            "SELECT hash FROM ledger.ledger_tx WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0)
}

#[test]
fn tx_by_key_answers_found_false_for_a_key_never_booked() {
    let Some(db) = TestDb::new() else { return };
    deposit(&db);
    let (status, out) = call(
        &door(&db),
        "/trpc/txByKey",
        r#"{"idempotencyKey":"order.release:never-booked:0"}"#,
        Some("svc-trade"),
    );
    assert_eq!(
        (status, out.compact()),
        (200, r#"{"found":false}"#.to_owned())
    );
}

#[test]
fn tx_by_key_answers_the_identifying_fields_of_a_booked_key_and_not_its_entries() {
    let Some(db) = TestDb::new() else { return };
    let (id, at, _, _) = deposit(&db);
    let (status, out) = call(
        &door(&db),
        "/trpc/txByKey",
        r#"{"idempotencyKey":"deposit:test:tx-by-id"}"#,
        Some("svc-trade"),
    );
    assert_eq!(status, 200);
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"found":true,"txId":"{id}","hash":"{}","postedAt":"{at}","module":"wallet","reason":"deposit"}}"#,
            hash_of(&db, &id)
        )
    );
    assert_eq!(
        at, "2026-11-21T03:04:05.678Z",
        "toISOString keeps milliseconds"
    );
}

#[test]
fn tx_by_id_answers_found_false_for_a_well_formed_id_never_booked() {
    let Some(db) = TestDb::new() else { return };
    deposit(&db);
    let (status, out) = bank(
        &door(&db),
        "/trpc/txById",
        r#"{"txId":"00000000-0000-4000-8000-000000000000"}"#,
    );
    assert_eq!(
        (status, out.compact()),
        (200, r#"{"found":false}"#.to_owned())
    );
}

#[test]
fn tx_by_id_answers_the_booked_transaction_and_its_entries_and_not_its_meta() {
    let Some(db) = TestDb::new() else { return };
    let (id, at, rail, user) = deposit(&db);
    let (status, out) = bank(&door(&db), "/trpc/txById", &format!(r#"{{"txId":"{id}"}}"#));
    assert_eq!(status, 200);
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"found":true,"txId":"{id}","idempotencyKey":"deposit:test:tx-by-id","hash":"{}","postedAt":"{at}","module":"wallet","reason":"deposit","entries":[{{"accountId":"{rail}","assetId":"USDT","direction":"debit","amount":"10"}},{{"accountId":"{user}","assetId":"USDT","direction":"credit","amount":"10"}}]}}"#,
            hash_of(&db, &id)
        )
    );
    // An uppercase id is the same uuid.
    let (status, upper) = bank(
        &door(&db),
        "/trpc/txById",
        &format!(r#"{{"txId":"{}"}}"#, id.to_uppercase()),
    );
    assert_eq!((status, upper.compact()), (200, out.compact()));
}

#[test]
fn a_missing_empty_or_malformed_key_or_id_is_refused_never_read_as_absent() {
    let Some(db) = TestDb::new() else { return };
    deposit(&db);
    let d = door(&db);
    for (path, body) in [
        ("/trpc/txByKey", "{}"),
        ("/trpc/txByKey", r#"{"idempotencyKey":""}"#),
        ("/trpc/txById", "{}"),
        ("/trpc/txById", r#"{"txId":""}"#),
        ("/trpc/txById", r#"{"txId":"not-a-uuid"}"#),
        ("/trpc/txById", r#"{"txId":42}"#),
    ] {
        let (status, out) = bank(&d, path, body);
        assert_eq!(status, 400, "{path} {body}");
        assert!(out.get("found").is_none(), "{path} {body}");
    }
}

#[test]
fn every_read_is_behind_the_service_credential_door() {
    let Some(db) = TestDb::new() else { return };
    let (id, _, _, _) = deposit(&db);
    let d = door(&db);
    for (path, body) in [
        ("/trpc/balance", available("USDT")),
        (
            "/trpc/balances",
            format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
        ),
        (
            "/trpc/portfolio",
            format!(r#"{{"ownerType":"user","ownerId":"{USER}"}}"#),
        ),
        (
            "/trpc/txByKey",
            r#"{"idempotencyKey":"deposit:test:tx-by-id"}"#.to_owned(),
        ),
        ("/trpc/txById", format!(r#"{{"txId":"{id}"}}"#)),
    ] {
        let (status, out) = call(&d, path, &body, None);
        assert_eq!(status, 401, "{path}");
        assert_eq!(s(&out, "code"), "ledger.unauthenticated", "{path}");
        let (status, _) = bank(&d, path, &body);
        assert_eq!(status, 200, "{path}");
    }
}

#[test]
fn a_transaction_whose_claim_no_longer_matches_is_refused_not_answered() {
    let Some(db) = TestDb::new() else { return };
    let (id, _, _, _) = deposit(&db);
    let mut c = db.client();
    c.batch_execute(
        "ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable;
         ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_immutable;",
    )
    .unwrap();
    c.execute(
        r#"UPDATE ledger.ledger_tx SET meta = '{"forged":"metadata"}'::jsonb WHERE id = $1::text::uuid"#,
        &[&id],
    )
    .unwrap();
    let d = door(&db);
    let refused =
        r#"{"message":"ledger.posted_claim_mismatch","code":"ledger.posted_claim_mismatch"}"#;
    let (status, out) = call(
        &d,
        "/trpc/txByKey",
        r#"{"idempotencyKey":"deposit:test:tx-by-id"}"#,
        Some("svc-trade"),
    );
    assert_eq!((status, out.compact()), (500, refused.to_owned()));
    let (status, out) = bank(&d, "/trpc/txById", &format!(r#"{{"txId":"{id}"}}"#));
    assert_eq!((status, out.compact()), (500, refused.to_owned()));

    // A journal row with no claim at all is refused too.
    c.execute(
        "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, hash) VALUES ('deposit:unclaimed', 'wallet', 'deposit', 'h')",
        &[],
    )
    .unwrap();
    let (status, out) = call(
        &d,
        "/trpc/txByKey",
        r#"{"idempotencyKey":"deposit:unclaimed"}"#,
        Some("svc-trade"),
    );
    assert_eq!((status, out.compact()), (500, refused.to_owned()));
}
