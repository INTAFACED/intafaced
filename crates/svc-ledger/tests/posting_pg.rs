//! The `posting` slice on a real Postgres (`TEST_DATABASE_URL_LEDGER` or `TEST_DATABASE_URL`, an admin database whose
//! name ends in `_test`), each test in its own throwaway database. Without a URL it skips; with `REQUIRE_POSTGRES=1`
//! it fails.
//!
//! The engine, the gate and the binding checks are proved against the TypeScript's own database tests in
//! `tests/conformance/` (`run.mjs`). This file holds what those reach only through a live bus or a switch the binary
//! reads once: the `ledgerTxPosted` intent and its relay, a failed publish and its retry, the posting freeze and the
//! custody switch.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use service_kit::json::{self, Json};
use svc_ledger::boot;
use svc_ledger::db::{self, Store};
use svc_ledger::errors::Failure;
use svc_ledger::freeze::{self, MemoryBus};
use svc_ledger::migrate::{self, FILES};
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::gate::Caller;
use svc_ledger::posting::{self, Posting, TX_POSTED_SUBJECT, TxRelay};

struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    fn new() -> Option<TestDb> {
        let pick = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let admin = pick("TEST_DATABASE_URL_LEDGER").or_else(|| pick("TEST_DATABASE_URL"));
        let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
        assert!(
            admin.is_some() || !required,
            "TEST_DATABASE_URL_LEDGER or TEST_DATABASE_URL is required"
        );
        let admin = admin?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        let current: String = a
            .query_one("SELECT current_database()", &[])
            .unwrap()
            .get(0);
        assert!(
            current.ends_with("_test"),
            "refusing: {current} is not a test database"
        );
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_post_ledger_{}_{}_{nanos:x}_test",
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

    fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    fn store(&self) -> Store {
        db::open(&self.url, "svc-ledger", 4, false).unwrap()
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

fn posting(bus: &Arc<MemoryBus>, custody_layer_on: bool) -> Posting {
    Posting::new(
        bus.clone(),
        "svc-ledger".to_owned(),
        custody_layer_on,
        EngineOptions {
            conflict: Conflict::Refuse,
            clock_skew_bound_ms: None,
            clock_ms: || 1_795_000_000_000,
        },
        false,
        None,
    )
}

const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/// `recipes.deposit`, as the recorder wrote it: a customer's balance moves.
fn deposit(rail_ref: &str, amount: &str) -> Json {
    json::parse(&format!(
        r#"{{"idempotencyKey":"deposit:crypto-native:{rail_ref}","module":"ledger","reason":"deposit.credited","entries":[{{"account":{{"ownerType":"treasury","ownerId":"rail:crypto-native","assetId":"USDT","kind":"available"}},"direction":"credit","amount":"{amount}"}},{{"account":{{"ownerType":"user","ownerId":"{USER}","assetId":"USDT","kind":"available"}},"direction":"debit","amount":"{amount}"}}],"meta":{{"rail":"crypto-native","railRef":"{rail_ref}"}},"correlationId":"corr-{rail_ref}"}}"#
    ))
    .unwrap()
}

/// `recipes.marketMakerSeedFund`: our own money only.
fn seed_fund() -> Json {
    json::parse(
        r#"{"idempotencyKey":"mm.seed.fund:seed1:USDT","module":"trade","reason":"mm.seed.funded","entries":[{"account":{"ownerType":"treasury","ownerId":"rail:mm-seed","assetId":"USDT","kind":"available"},"direction":"credit","amount":"10"},{"account":{"ownerType":"house","ownerId":"market-maker","assetId":"USDT","kind":"available"},"direction":"debit","amount":"10"}],"meta":{"seedId":"seed1","rail":"mm-seed"}}"#,
    )
    .unwrap()
}

fn post(store: &Store, p: &Posting, body: &Json) -> Result<Json, Failure> {
    posting::post(
        store,
        p,
        Some(&Caller::Legacy(Some("svc-wallet".to_owned()))),
        "dual",
        body,
    )
}

fn text(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

fn keys(j: &Json) -> Vec<String> {
    match j {
        Json::Object(fields) => fields.iter().map(|(k, _)| k.clone()).collect(),
        other => panic!("not an object: {other:?}"),
    }
}

fn code(f: &Failure) -> &str {
    match f {
        Failure::Ledger { code, .. } => code,
        other => panic!("not a ledger refusal: {other:?}"),
    }
}

#[test]
fn a_post_is_booked_once_and_its_intent_published_once_in_the_events_shape() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let bus = Arc::new(MemoryBus::default());
    let p = posting(&bus, true);

    let ack = post(&store, &p, &deposit("relay-1", "12.5")).unwrap();
    let tx_id = text(&ack, "txId");
    let again = post(&store, &p, &deposit("relay-1", "12.5")).unwrap();
    assert_eq!(again, ack, "a retry answers the first booking");
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_tx_outbox WHERE published_at IS NULL"),
        0
    );

    let sent = bus.sent.lock().unwrap();
    assert_eq!(sent.len(), 1, "the retry publishes nothing new");
    let (subject, msg_id, env) = &sent[0];
    assert_eq!(subject, TX_POSTED_SUBJECT);
    assert_eq!(msg_id, &format!("ledger.tx:{tx_id}"));
    assert_eq!(
        keys(env),
        [
            "id",
            "subject",
            "version",
            "occurredAt",
            "producer",
            "idempotencyKey",
            "correlationId",
            "payload"
        ]
    );
    assert_eq!(text(env, "subject"), TX_POSTED_SUBJECT);
    assert_eq!(env.get("version"), Some(&Json::int(1)));
    assert_eq!(text(env, "producer"), "svc-ledger");
    assert_eq!(text(env, "idempotencyKey"), format!("ledger.tx:{tx_id}"));
    assert_eq!(text(env, "correlationId"), "corr-relay-1");
    let payload = env.get("payload").unwrap();
    assert_eq!(
        keys(payload),
        [
            "txId",
            "module",
            "reason",
            "hash",
            "previousHash",
            "entries",
            "postedAt"
        ]
    );
    assert_eq!(text(payload, "txId"), tx_id);
    assert_eq!(text(payload, "hash"), text(&ack, "hash"));
    let Some(Json::Array(entries)) = payload.get("entries") else {
        panic!("no entries")
    };
    assert_eq!(entries.len(), 2);
    for e in entries {
        assert_eq!(keys(e), ["accountId", "assetId", "direction", "amount"]);
        assert_eq!(
            text(e, "amount"),
            "12.5",
            "a decimal string, never a number"
        );
    }
}

#[test]
fn a_failed_publish_answers_a_fault_and_the_booked_post_is_sent_by_its_retry_or_the_recovery() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let bus = Arc::new(MemoryBus::default());
    let p = posting(&bus, true);

    // The bus is down after commit: the caller is told it failed, the booking and its intent stay.
    bus.failing.store(true, Ordering::SeqCst);
    assert_eq!(
        post(&store, &p, &deposit("down-1", "3")),
        Err(Failure::Fault)
    );
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_tx_outbox WHERE published_at IS NULL"),
        1
    );

    // The caller retries the same key once the bus is back: the booked post, and its intent sent.
    bus.failing.store(false, Ordering::SeqCst);
    let ack = post(&store, &p, &deposit("down-1", "3")).unwrap();
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_tx_outbox WHERE published_at IS NULL"),
        0
    );
    assert_eq!(
        bus.sent.lock().unwrap()[0].1,
        format!("ledger.tx:{}", text(&ack, "txId"))
    );

    // A caller that never retries: the recovery sends it, once.
    bus.failing.store(true, Ordering::SeqCst);
    assert_eq!(
        post(&store, &p, &deposit("down-2", "4")),
        Err(Failure::Fault)
    );
    bus.failing.store(false, Ordering::SeqCst);
    assert_eq!(boot::recover_outbox(&store, &[&TxRelay(&p)]).unwrap(), 1);
    assert_eq!(boot::recover_outbox(&store, &[&TxRelay(&p)]).unwrap(), 0);
    assert_eq!(bus.sent.lock().unwrap().len(), 2);
}

#[test]
fn a_frozen_book_refuses_a_new_post_and_writes_nothing_but_answers_a_booked_one() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let bus = Arc::new(MemoryBus::default());
    let p = posting(&bus, true);
    let booked = post(&store, &p, &deposit("before-freeze", "5")).unwrap();

    freeze::write(
        &store,
        freeze::Command::Freeze {
            reason: "reconcile mismatch (test)",
            actor: "ops-test",
        },
    )
    .unwrap();
    let refused = post(&store, &p, &deposit("after-freeze", "5")).unwrap_err();
    assert_eq!(code(&refused), "ledger.frozen");
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx_outbox"), 1);
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.accounts WHERE owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"),
        1,
        "the refused post opened no account"
    );
    // A retry of a post that committed before the freeze still learns it committed.
    assert_eq!(
        post(&store, &p, &deposit("before-freeze", "5")).unwrap(),
        booked
    );
}

#[test]
fn with_custody_off_a_customer_post_is_refused_before_any_write_and_our_own_books() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let bus = Arc::new(MemoryBus::default());
    let on = posting(&bus, true);
    let off = posting(&bus, false);
    let booked = post(&store, &on, &deposit("while-on", "6")).unwrap();

    let refused = post(&store, &off, &deposit("while-off", "6")).unwrap_err();
    assert_eq!(code(&refused), "ledger.custody_layer_off");
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);

    // A key booked while the layer was on: the caller still gets its booking back.
    assert_eq!(
        post(&store, &off, &deposit("while-on", "6")).unwrap(),
        booked
    );
    // Our own money moves whatever the switch says.
    post(&store, &off, &seed_fund()).unwrap();
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 2);
    assert_eq!(bus.sent.lock().unwrap().len(), 2);
}
