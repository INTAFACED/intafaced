//! The `store` slice against a real Postgres (`TEST_DATABASE_URL_LEDGER` or `TEST_DATABASE_URL`, a server whose admin
//! database name ends in `_test`), each test in its own throwaway database. Without a URL it skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! The migration runner's proofs are `services/svc-ledger/scripts/migrate.test.ts`, case for case; then the binary's
//! `migrate`, the pool's session settings, the boot checks (`chain_tip`, the custody guard, the startup freeze) and
//! `/health` and `/ready` through the kit's server routing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use postgres::Client;

use service_kit::json::{self, Json};
use service_kit::s2s::system_seconds;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::App;
use service_kit::tokens::TokenConfig;
use support::TestDb;
use svc_ledger::boot::{
    self, CUSTODY_LAYER_OPEN_BALANCES, STARTUP_FREEZE_ACTOR, STARTUP_FREEZE_REASON,
};
use svc_ledger::db::{self, Store};
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::freeze::{self, FreezeRelay, MemoryBus};
use svc_ledger::migrate::FILES;

/// The freeze relay over a memory bus, as the binary drives it over NATS.
fn relay(bus: &MemoryBus) -> FreezeRelay<'_> {
    FreezeRelay {
        bus,
        producer: "svc-ledger".to_owned(),
        now_ms: svc_ledger::clock::system_ms,
    }
}

fn halt<'a>(reason: &'a str, actor: &'a str) -> freeze::Command<'a> {
    freeze::Command::Freeze { reason, actor }
}

fn real(pred: impl Fn(&str) -> bool) -> Vec<(&'static str, &'static str)> {
    FILES.iter().copied().filter(|(n, _)| pred(n)).collect()
}

const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

#[test]
fn concurrent_runners_apply_one_file_once_with_its_tracking_row() {
    let Some(db) = TestDb::new() else { return };
    let files = [
        (
            "0001_probe.sql",
            "CREATE TABLE ledger.probe(n integer); INSERT INTO ledger.probe VALUES (1); SELECT pg_sleep(0.03);",
        ),
        ("0001_probe.down.sql", "DROP TABLE ledger.probe;"),
    ];
    std::thread::scope(|s| {
        let runs: Vec<_> = (0..3)
            .map(|_| s.spawn(|| db.migrate(&files, false)))
            .collect();
        for r in runs {
            r.join().unwrap().unwrap();
        }
    });
    assert_eq!(db.count("SELECT count(*) FROM ledger.probe"), 1);
    assert_eq!(db.count("SELECT count(*) FROM ledger.__migrations"), 1);
    db.migrate(&files, true).unwrap();
    assert_eq!(db.regclass("ledger.probe"), None);
    assert_eq!(db.count("SELECT count(*) FROM ledger.__migrations"), 0);
}

#[test]
fn a_refused_tracking_insert_rolls_the_up_ddl_back() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&[], false).unwrap();
    db.client()
        .batch_execute(
            "CREATE FUNCTION ledger.reject_tracking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'tracking refusal'; END $$; CREATE TRIGGER reject_tracking BEFORE INSERT ON ledger.__migrations FOR EACH ROW EXECUTE FUNCTION ledger.reject_tracking();",
        )
        .unwrap();
    let files = [
        ("0001_probe.sql", "CREATE TABLE ledger.probe(n integer);"),
        ("0001_probe.down.sql", "DROP TABLE ledger.probe;"),
    ];
    assert!(
        db.migrate(&files, false)
            .unwrap_err()
            .contains("tracking refusal")
    );
    assert_eq!(db.regclass("ledger.probe"), None);
    assert_eq!(db.count("SELECT count(*) FROM ledger.__migrations"), 0);
}

#[test]
fn a_refused_tracking_delete_rolls_every_reversal_back_together() {
    let Some(db) = TestDb::new() else { return };
    let files = [
        ("0001_a.sql", "CREATE TABLE ledger.a(n integer);"),
        ("0001_a.down.sql", "DROP TABLE ledger.a;"),
        ("0002_b.sql", "CREATE TABLE ledger.b(n integer);"),
        ("0002_b.down.sql", "DROP TABLE ledger.b;"),
    ];
    db.migrate(&files, false).unwrap();
    db.client()
        .batch_execute(
            "CREATE FUNCTION ledger.reject_tracking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.name = '0001_a.sql' THEN RAISE EXCEPTION 'tracking refusal'; END IF; RETURN OLD; END $$; CREATE TRIGGER reject_tracking BEFORE DELETE ON ledger.__migrations FOR EACH ROW EXECUTE FUNCTION ledger.reject_tracking();",
        )
        .unwrap();
    assert!(
        db.migrate(&files, true)
            .unwrap_err()
            .contains("tracking refusal")
    );
    assert_eq!(db.regclass("ledger.a").as_deref(), Some("ledger.a"));
    assert_eq!(db.regclass("ledger.b").as_deref(), Some("ledger.b"));
    assert_eq!(db.count("SELECT count(*) FROM ledger.__migrations"), 2);
}

#[test]
fn unapplied_files_are_ignored_and_a_missing_applied_reversal_refuses_before_any_ddl() {
    let Some(db) = TestDb::new() else { return };
    let a = [
        ("0001_a.sql", "CREATE TABLE ledger.a(n integer);"),
        ("0001_a.down.sql", "DROP TABLE ledger.a;"),
    ];
    db.migrate(&a, false).unwrap();
    let with_unapplied = [a[0], a[1], ("0002_unapplied.sql", "SELECT 1;")];
    db.migrate(&with_unapplied, true).unwrap();
    db.migrate(&with_unapplied, false).unwrap();
    let no_down = [a[0], ("0002_unapplied.sql", "SELECT 1;")];
    assert_eq!(
        db.migrate(&no_down, true).unwrap_err(),
        "refusing --down: missing 0001_a.down.sql"
    );
    assert_eq!(db.regclass("ledger.a").as_deref(), Some("ledger.a"));
}

#[test]
fn a_booked_transaction_refuses_down_and_keeps_every_tracking_row() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    // A raw booked row stands in for a posting (the `posting` slice ports the poster): what the guard reads is that
    // `ledger_tx` holds a row at all.
    db.client()
        .batch_execute(
            "INSERT INTO ledger.ledger_tx(idempotency_key, module, reason, hash) VALUES ('deposit:test:migration-history', 'test', 'migration history', 'fixture-hash')",
        )
        .unwrap();
    let before = db.names();
    assert_eq!(
        db.migrate(&FILES, true).unwrap_err(),
        "refusing --down: ledger.ledger_tx is not empty"
    );
    assert_eq!(db.names(), before);
    assert_eq!(db.count("SELECT count(*) FROM ledger.ledger_tx"), 1);
}

#[test]
fn a_genesis_snapshot_anchor_refuses_down_atomically() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    let mut c = db.client();
    let id: String = c
        .query_one(
            "INSERT INTO ledger.accounts(owner_type, owner_id, asset_id, kind, purpose) VALUES ('user', $1, 'USDT', 'available', '') RETURNING id::text",
            &[&USER],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO ledger.balance_snapshots(account_id, as_of, balance, chain_tip_seq, chain_tip_hash) VALUES ($1::text::uuid, now(), 0, 0, NULL)",
        &[&id],
    )
    .unwrap();
    let before = db.names();
    assert!(
        db.migrate(&FILES, true)
            .unwrap_err()
            .contains("snapshot chain-tip identity")
    );
    assert_eq!(db.names(), before);
    assert_eq!(
        db.regclass("ledger.ledger_freeze_outbox").as_deref(),
        Some("ledger.ledger_freeze_outbox")
    );
}

#[test]
fn malformed_freeze_intents_are_refused_and_a_published_switch_refuses_down() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    let mut c = db.client();
    let insert = |c: &mut Client, key: &str, payload: &str| {
        c.execute(
            "INSERT INTO ledger.ledger_freeze_outbox(idempotency_key, payload) VALUES ($1, $2::text::jsonb)",
            &[&key, &payload],
        )
    };
    let code = |r: Result<u64, postgres::Error>| r.unwrap_err().code().map(|c| c.code().to_owned());
    assert_eq!(
        code(insert(&mut c, "ledger.freeze:bad", "{}")).as_deref(),
        Some("23514")
    );
    assert_eq!(
        code(insert(
            &mut c,
            "ledger.freeze:bad-thaw",
            r#"{"frozen":false,"actor":"ops","changedAt":"2026-11-21T00:00:00.000Z","reason":"wrong"}"#
        ))
        .as_deref(),
        Some("23514")
    );
    c.execute(
        "INSERT INTO ledger.ledger_freeze_outbox(idempotency_key, payload, published_at) VALUES ('ledger.freeze:recorded', $1::text::jsonb, now())",
        &[&r#"{"frozen":false,"actor":"ops","changedAt":"2026-11-21T00:00:00.000Z","reason":null}"#],
    )
    .unwrap();
    let before = db.names();
    assert!(
        db.migrate(&FILES, true)
            .unwrap_err()
            .contains("recorded ledgerFreezeUpdated")
    );
    assert_eq!(db.names(), before);
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_freeze_outbox"),
        1
    );
}

#[test]
fn a_populated_nested_array_outbox_refuses_0019_without_rewriting_it() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(
        &real(|n| n[..4].parse::<u32>().is_ok_and(|v| v <= 13)),
        false,
    )
    .unwrap();
    let mut c = db.client();
    let tx: String = c
        .query_one(
            "INSERT INTO ledger.ledger_tx(idempotency_key, module, reason, hash) VALUES ('legacy-nested-array', 'test', 'upgrade shape', 'fixture-hash') RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    let payload = format!(
        r#"{{"txId":"{tx}","module":"test","reason":"upgrade shape","hash":"fixture-hash","previousHash":null,"postedAt":"2026-11-21T00:00:00.000Z","entries":[[]]}}"#
    );
    c.execute(
        "INSERT INTO ledger.ledger_tx_outbox(tx_id, payload, correlation_id) VALUES ($1::text::uuid, $2::text::jsonb, 'legacy-structure')",
        &[&tx, &payload],
    )
    .unwrap();
    let constraint = "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'ledger.ledger_tx_outbox'::regclass AND conname = 'ledger_tx_outbox_amount_string_ck'";
    let before: Vec<String> = c
        .query(constraint, &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(
        db.migrate(&FILES, false)
            .unwrap_err()
            .contains("Cannot apply 0019")
    );
    assert_eq!(
        db.count(
            "SELECT count(*) FROM ledger.__migrations WHERE name = '0019_outbox_amount_string.sql'"
        ),
        0
    );
    let kept: bool = c
        .query_one(
            "SELECT payload = $2::text::jsonb FROM ledger.ledger_tx_outbox WHERE tx_id = $1::text::uuid",
            &[&tx, &payload],
        )
        .unwrap()
        .get(0);
    assert!(kept, "the legacy payload is kept as it was");
    let after: Vec<String> = c
        .query(constraint, &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(after, before);
}

#[test]
fn the_0007_backfill_refuses_to_invent_a_purpose() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&real(|n| n < "0007"), false).unwrap();
    db.client()
        .execute(
            "INSERT INTO ledger.accounts(owner_type, owner_id, asset_id, kind, purpose) VALUES ('user', $1, 'USDT', 'stake', '')",
            &[&USER],
        )
        .unwrap();
    let with_0007 = real(|n| n < "0007" || n == "0007_purposed_lock_kinds.sql");
    assert_eq!(
        db.migrate(&with_0007, false).unwrap_err(),
        "Cannot apply 0007: unnamed lock claim; refusing invented legacy purpose"
    );
    let purpose: String = db
        .client()
        .query_one("SELECT purpose FROM ledger.accounts", &[])
        .unwrap()
        .get(0);
    assert_eq!(purpose, "");
    assert_eq!(
        db.count(
            "SELECT count(*) FROM ledger.__migrations WHERE name = '0007_purposed_lock_kinds.sql'"
        ),
        0
    );
}

#[test]
fn the_binary_applies_every_migration_once_and_reverses_them_all() {
    let Some(db) = TestDb::new() else { return };
    let ups = FILES
        .iter()
        .filter(|(n, _)| !n.ends_with(".down.sql"))
        .count();
    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.matches("↑ ").count(), ups, "{out}");
    assert!(out.ends_with("✓ migrations up to date\n"), "{out}");
    let (code, again) = db.binary(false);
    assert_eq!(code, 0, "{again}");
    assert_eq!(again.matches("(already applied)").count(), ups, "{again}");
    assert_eq!(db.names().len(), ups);
    let (code, down) = db.binary(true);
    assert_eq!(code, 0, "{down}");
    assert!(down.ends_with("✓ reversed\n"), "{down}");
    assert_eq!(db.count("SELECT count(*) FROM ledger.__migrations"), 0);
    assert_eq!(
        db.count("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'ledger' AND table_name <> '__migrations'"),
        0
    );
}

#[test]
fn every_pooled_connection_carries_the_ledgers_session_settings() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let shown = db::with_client(store.pool().unwrap(), |c| {
        let show = |c: &mut Client, k: &str| -> String {
            c.query_one(&format!("SHOW {k}"), &[]).unwrap().get(0)
        };
        Ok([
            show(c, "search_path"),
            show(c, "statement_timeout"),
            show(c, "idle_in_transaction_session_timeout"),
            show(c, "application_name"),
        ])
    })
    .unwrap();
    assert_eq!(shown, ["ledger,public", "15s", "1min", "svc-ledger"]);
    store.end();
}

#[test]
fn the_boot_checks_read_the_book() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    assert!(boot::chain_tip(&store).is_err(), "no schema, no start");
    db.migrate(&FILES, false).unwrap();
    assert_eq!(boot::chain_tip(&store).unwrap(), "0");
    db.client()
        .execute("DELETE FROM ledger.chain_tip", &[])
        .ok();
    if db.count("SELECT count(*) FROM ledger.chain_tip") == 0 {
        assert_eq!(
            boot::chain_tip(&store).unwrap_err().message,
            boot::CHAIN_TIP_MISSING
        );
    }

    // The custody guard: off with a customer balance refuses, naming how many; on reads nothing; no balance passes.
    assert!(boot::assert_custody_layer_bootable(&store, false).is_ok());
    let mut c = db.client();
    for (owner_type, owner) in [
        ("user", USER),
        ("module", "pay:clearing:merchant-1"),
        ("module", "fees"),
    ] {
        c.execute(
            "INSERT INTO ledger.accounts(owner_type, owner_id, asset_id, kind, purpose, balance) VALUES ($1::text::ledger.owner_type, $2, 'USDT', 'available', '', 5)",
            &[&owner_type, &owner],
        )
        .unwrap();
    }
    let refused = boot::assert_custody_layer_bootable(&store, false).unwrap_err();
    assert_eq!(refused.code.as_deref(), Some(CUSTODY_LAYER_OPEN_BALANCES));
    assert!(
        refused
            .message
            .starts_with("LEDGER_CUSTODY_LAYER is off, but 2 customer account(s)"),
        "{}",
        refused.message
    );
    assert!(boot::assert_custody_layer_bootable(&Store::Down("unread".to_owned()), true).is_ok());
    store.end();
}

#[test]
fn the_startup_policy_can_freeze_and_never_thaws() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    let store = db.store();
    let bus = MemoryBus::default();
    let relay = relay(&bus);
    // Enabled on an open book: nothing moves.
    assert!(
        !boot::apply_startup_policy(&store, true, &relay)
            .unwrap()
            .frozen
    );
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_freeze_outbox"),
        0
    );

    // Disabled: a durable, attributed freeze and its one intent, committed together, then published once.
    let state = boot::apply_startup_policy(&store, false, &relay).unwrap();
    assert!(state.frozen);
    assert_eq!(state.reason.as_deref(), Some(STARTUP_FREEZE_REASON));
    assert_eq!(state.actor.as_deref(), Some(STARTUP_FREEZE_ACTOR));
    let (key, payload): (String, String) = {
        let r = db
            .client()
            .query_one(
                "SELECT idempotency_key, payload::text FROM ledger.ledger_freeze_outbox WHERE published_at IS NOT NULL",
                &[],
            )
            .unwrap();
        (r.get(0), r.get(1))
    };
    assert!(key.starts_with("ledger.freeze:seq:"), "{key}");
    let p = json::parse(&payload).unwrap();
    assert_eq!(p.get("frozen"), Some(&Json::Bool(true)));
    assert_eq!(p.get("reason"), Some(&Json::str(STARTUP_FREEZE_REASON)));
    assert_eq!(p.get("actor"), Some(&Json::str(STARTUP_FREEZE_ACTOR)));
    assert_eq!(
        p.get("changedAt"),
        Some(&Json::str(state.changed_at.clone()))
    );
    assert_eq!(state.changed_at.len(), "2026-11-21T00:00:00.000Z".len());
    let sent = bus.emitted(freeze::SUBJECT);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].get("idempotencyKey"), Some(&Json::str(key)));
    // The payload as `ledgerFreezeUpdatedPayload` rebuilds it, in the catalogue's key order (jsonb keeps its own).
    let sent_payload = sent[0].get("payload").unwrap();
    for key in ["frozen", "reason", "actor", "changedAt"] {
        assert_eq!(sent_payload.get(key), p.get(key), "{key}");
    }

    // A second boot with the flag still off is a true no-op; a boot with it on never thaws.
    assert_eq!(
        boot::apply_startup_policy(&store, false, &relay).unwrap(),
        state
    );
    assert_eq!(
        boot::apply_startup_policy(&store, true, &relay).unwrap(),
        state
    );
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_freeze_outbox"),
        1
    );

    // Another attribution never overwrites the standing freeze.
    let refused = freeze::write(&store, halt("operator halt", "op-1")).unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("ledger.freeze_attributed"));
    assert_eq!(
        freeze::write(&store, halt(STARTUP_FREEZE_REASON, STARTUP_FREEZE_ACTOR)).unwrap(),
        (state, false)
    );
    assert_eq!(bus.emitted(freeze::SUBJECT).len(), 1);
    store.end();
}

#[test]
fn a_book_frozen_by_an_operator_boots_frozen_by_that_operator() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    let store = db.store();
    freeze::write(&store, halt("operator halt", "op-1")).unwrap();
    let bus = MemoryBus::default();
    let state = boot::apply_startup_policy(&store, false, &relay(&bus)).unwrap();
    assert_eq!(state.actor.as_deref(), Some("op-1"));
    assert_eq!(
        db.count("SELECT count(*) FROM ledger.ledger_freeze_outbox"),
        1
    );
    store.end();
}

fn served(db: &TestDb) -> App<LedgerDoor> {
    App {
        wire: LedgerDoor::new(DoorConfig {
            internal_secret: "placeholder-store-test-secret".to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            tokens: TokenConfig {
                secret: "placeholder-store-test-token-secret".to_owned(),
                issuer: "intafaced".to_owned(),
                audience: "intafaced.api".to_owned(),
                key_id: None,
                verify_only: Vec::new(),
            },
            clock: system_seconds,
            store: db.store(),
            service_name: "svc-ledger".to_owned(),
            bus: std::sync::Arc::new(svc_ledger::freeze::MemoryBus::default()),
            approvals: Box::new(svc_ledger::approval::Unwired),
            clock_skew_bound_ms: None,
            now_ms: svc_ledger::clock::system_ms,
            log: service_kit::telemetry::Logger::new("info", Box::new(std::io::sink())),
            custody: svc_ledger::reconcile::CustodyLayer::On,
            reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
            indexer_url: None,
            fetch: std::sync::Arc::new(service_kit::http::UreqFetch::new()),
            posting: support::idle_posting(),
            reconciliation_sources: std::sync::Arc::new(svc_ledger::controls::sources::Unset),
        })
        .unwrap(),
        service_name: "svc-ledger".to_owned(),
        ready_body: String::new(),
    }
}

fn get(app: &App<LedgerDoor>, path: &str) -> (u16, String) {
    let a = app.route("GET", path, &[], "", "req-1");
    (a.status, a.body)
}

#[test]
fn health_and_ready_say_what_the_database_says() {
    let Some(db) = TestDb::new() else { return };
    db.migrate(&FILES, false).unwrap();
    let app = served(&db);
    assert_eq!(get(&app, "/ready"), (200, r#"{"ready":true}"#.to_owned()));
    assert_eq!(
        get(&app, "/health"),
        (
            200,
            r#"{"ok":true,"service":"svc-ledger","postingEnabled":true,"frozenReason":null,"frozenBy":null,"frozenCause":null,"lastVerifiedAt":null,"lastVerifiedSeq":null}"#
                .to_owned()
        )
    );

    // A proof on file: when, and through which seq.
    db.client()
        .batch_execute(
            "INSERT INTO ledger.reconcile_runs(started_at, finished_at, outcome, through_seq) VALUES ('2026-11-20T10:00:00Z', '2026-11-20T10:00:01.234567Z', 'ok', 0)",
        )
        .unwrap();
    // Frozen by the startup setting: alive, not ready.
    boot::apply_startup_policy(app.wire.store(), false, &relay(&MemoryBus::default())).unwrap();
    assert_eq!(
        get(&app, "/ready"),
        (
            503,
            format!(r#"{{"ready":false,"reason":"{STARTUP_FREEZE_REASON}"}}"#)
        )
    );
    let (status, body) = get(&app, "/health");
    assert_eq!(status, 200);
    assert_eq!(
        body,
        format!(
            r#"{{"ok":true,"service":"svc-ledger","postingEnabled":false,"frozenReason":"{STARTUP_FREEZE_REASON}","frozenBy":"{STARTUP_FREEZE_ACTOR}","frozenCause":"startup_setting","lastVerifiedAt":"2026-11-20T10:00:01.234Z","lastVerifiedSeq":"0"}}"#
        )
    );

    // The freeze row gone: Fastify's 500 with the ledger's code, on both doors.
    db.client()
        .batch_execute("ALTER TABLE ledger.posting_freeze DISABLE TRIGGER USER; DELETE FROM ledger.posting_freeze")
        .unwrap();
    let missing = format!(
        r#"{{"statusCode":500,"code":"ledger.uninitialised","error":"Internal Server Error","message":"{}"}}"#,
        svc_ledger::status::FREEZE_MISSING
    );
    assert_eq!(get(&app, "/ready"), (500, missing.clone()));
    assert_eq!(get(&app, "/health"), (500, missing));
    app.wire.end();
}
