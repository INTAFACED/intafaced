//! The `store` slice against a real Postgres (`TEST_DATABASE_URL`, a server whose admin database name ends in
//! `_test`), each test in its own throwaway database. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The binary's `migrate` up, re-run and `--down` (`scripts/migrate.ts`'s three behaviours, a file never applied left
//! alone), the schema check, each pooled connection's session settings, `POST /internal/restore/watermark` through the
//! door (svc-ops alone, the counts and stamp the TypeScript reads), the recovery lock between two replicas, and
//! `/health` and `/ready` through the kit's server routing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use service_kit::json::{self, Json};
use service_kit::s2s::{self, system_seconds};
use service_kit::server::{App, Request};
use svc_bank::db::{self, SCHEMA_MISSING, Store, with_client};
use svc_bank::door::{BankDoor, DoorConfig, ServiceAuth, system_now};
use svc_bank::migrate::MIGRATIONS;
use svc_bank::recovery::{AdvisoryLock, Lock};
use svc_bank::restore_watermark;

use crate::support;
use support::TestDb;

const INTERNAL: &str = "placeholder-bank-store-pg-internal-secret-0";

fn door(store: Store) -> BankDoor {
    BankDoor::new(DoorConfig {
        edge_secret: "placeholder-bank-store-pg-edge-secret-00000".to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: service_kit::s2s_verify::BodyBind::Require,
        },
        env: BTreeMap::new(),
        now: system_now,
        store,
    })
    .unwrap()
}

/// `POST <path>` with a JSON body, signed as `service` (or unsigned).
fn post(door: &BankDoor, path: &str, service: Option<&str>) -> (u16, Json) {
    let body = "{}";
    let mut headers: Vec<(String, String)> =
        vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(s) = service {
        headers.extend(s2s::legacy_headers(s, INTERNAL, body, system_seconds()).unwrap());
    }
    let res = door.handle(&Request {
        method: "POST",
        url: path,
        headers: &headers,
        body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

#[test]
fn the_binary_applies_every_migration_once_then_skips_them_then_reverses_them() {
    let Some(db) = TestDb::new() else { return };
    let ups: Vec<&str> = MIGRATIONS.ups().into_iter().map(|(n, _)| n).collect();
    assert_eq!(ups.len(), 128);

    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    let mut want: Vec<String> = ups.iter().map(|n| format!("↑ {n}")).collect();
    want.push("✓ migrations up to date".to_owned());
    assert_eq!(out.lines().collect::<Vec<_>>(), want);
    assert_eq!(db.count("SELECT count(*) FROM bank.__migrations"), 128);
    // 175 tables, PORT.md's count, and the tracking table.
    assert_eq!(
        db.count("SELECT count(*) FROM pg_tables WHERE schemaname = 'bank' AND tablename <> '__migrations'"),
        175
    );

    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    let mut want: Vec<String> = ups
        .iter()
        .map(|n| format!("· {n} (already applied)"))
        .collect();
    want.push("✓ migrations up to date".to_owned());
    assert_eq!(out.lines().collect::<Vec<_>>(), want);

    let (code, out) = db.binary(true);
    assert_eq!(code, 0, "{out}");
    let mut want: Vec<String> = ups
        .iter()
        .rev()
        .map(|n| format!("↓ {}", n.replace(".sql", ".down.sql")))
        .collect();
    want.push("✓ reversed".to_owned());
    assert_eq!(out.lines().collect::<Vec<_>>(), want);
    assert_eq!(db.count("SELECT count(*) FROM bank.__migrations"), 0);
    assert_eq!(
        db.count("SELECT count(*) FROM pg_tables WHERE schemaname = 'bank' AND tablename <> '__migrations'"),
        0
    );
}

/// `reversalNames`: a file the record does not name was never applied, so `--down` leaves it alone.
#[test]
fn a_reversal_skips_a_file_the_record_does_not_name() {
    let Some(db) = TestDb::new() else { return };
    db.migrated_in_place();
    let ups: Vec<&str> = MIGRATIONS.ups().into_iter().map(|(n, _)| n).collect();
    let latest = *ups.last().unwrap();
    // The latest file reversed by hand and its record gone: as if it had never been applied.
    let mut c = db.client();
    c.batch_execute(
        MIGRATIONS
            .file(&latest.replace(".sql", ".down.sql"))
            .unwrap(),
    )
    .unwrap();
    c.execute("DELETE FROM bank.__migrations WHERE name = $1", &[&latest])
        .unwrap();

    let (code, out) = db.binary(true);
    assert_eq!(code, 0, "{out}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 128, "127 reversals and the closing line");
    assert!(
        !out.contains(&format!("↓ {}", latest.replace(".sql", ".down.sql"))),
        "the file never applied is not reversed"
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.__migrations"), 0);
}

#[test]
fn the_schema_check_refuses_until_the_migrations_ran() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    assert_eq!(db::check_schema(&store), Err(SCHEMA_MISSING.to_owned()));
    db.migrated_in_place();
    assert_eq!(db::check_schema(&store), Ok(()));
    store.end();
}

#[test]
fn every_pooled_connection_carries_the_banks_session_settings() {
    let Some(db) = TestDb::new() else { return };
    db.migrated_in_place();
    let store = db.store();
    let (name, path): (String, String) = with_client(store.pool().unwrap(), |c| {
        let r = c.query_one(
            "SELECT current_setting('application_name'), current_setting('search_path')",
            &[],
        )?;
        Ok((r.get(0), r.get(1)))
    })
    .unwrap();
    assert_eq!(name, "svc-bank");
    assert_eq!(path, "bank,public");
    // An unqualified name finds the bank's table.
    let n: i64 = with_client(store.pool().unwrap(), |c| {
        Ok(c.query_one("SELECT count(*) FROM spaces", &[])?.get(0))
    })
    .unwrap();
    assert_eq!(n, 0);
    store.end();
}

#[test]
fn the_watermark_is_svc_ops_alone_and_counts_every_bank_row() {
    let Some(db) = TestDb::new() else { return };
    db.migrated_in_place();
    let d = door(db.store());

    assert_eq!(post(&d, "/internal/restore/watermark", None).0, 401);
    // svc-edge is never a job caller: its signature reads as none.
    let (status, body) = post(&d, "/internal/restore/watermark", Some("svc-edge"));
    assert_eq!(status, 401);
    assert_eq!(body.get("code"), Some(&Json::str("bank.unauthenticated")));
    let (status, body) = post(&d, "/internal/restore/watermark", Some("svc-pay"));
    assert_eq!(status, 403);
    assert_eq!(
        body.compact(),
        r#"{"error":"caller not allowed","code":"bank.caller_forbidden"}"#
    );

    let (status, empty) = post(&d, "/internal/restore/watermark", Some("svc-ops"));
    assert_eq!(status, 200, "{}", empty.compact());
    // Every table of the schema is counted, the migrations' record (128 rows) with them, as the TypeScript counts it.
    assert_eq!(empty.get("position"), Some(&Json::str("128")));
    assert_eq!(empty.get("lastWriteAt"), Some(&Json::Null));
    assert_eq!(empty.get("kind"), Some(&Json::str("bank.rows")));

    // Two rows in a stamped table move the position and the digest, and the stamp is the newest one.
    let mut c = db.client();
    c.batch_execute(
        "INSERT INTO bank.spaces (user_id, asset_id, name, created_at, updated_at) VALUES
           ('user-a', 'USDC', 'a', '2026-11-20T10:00:00.123456Z', '2026-11-20T10:00:00.123456Z'),
           ('user-b', 'USDC', 'b', '2026-11-21T09:30:00.5Z', '2026-11-21T09:30:00.5Z')",
    )
    .unwrap();
    let (status, read) = post(&d, "/internal/restore/watermark", Some("svc-ops"));
    assert_eq!(status, 200, "{}", read.compact());
    assert_eq!(read.get("position"), Some(&Json::str("130")));
    assert_ne!(read.get("integrity"), empty.get("integrity"));
    assert_eq!(
        read.get("lastWriteAt"),
        Some(&Json::str("2026-11-21T09:30:00.500Z"))
    );

    // The digest is the TypeScript's: sha-256 of every table's `name=rows`, sorted.
    let tables: Vec<String> = c
        .query(
            "SELECT relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'bank' AND c.relkind = 'r'",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    let counts: Vec<(String, u64)> = tables
        .into_iter()
        .map(|t| {
            let n = match t.as_str() {
                "spaces" => 2,
                "__migrations" => 128,
                _ => 0,
            };
            (t, n)
        })
        .collect();
    assert_eq!(
        read.get("integrity"),
        Some(&Json::str(restore_watermark::digest_counts(&counts)))
    );
    // A read changes nothing.
    assert_eq!(db.count("SELECT count(*) FROM bank.spaces"), 2);

    // The capital read is svc-ops' too, and the card-ops slice's past that: a deployment with no partner adapter lists
    // none (`card_ops_desk_programme_db.rs` holds the partners' rows).
    assert_eq!(
        post(&d, "/internal/capital/partner-reserves", Some("svc-pay")).0,
        403
    );
    let (status, body) = post(&d, "/internal/capital/partner-reserves", Some("svc-ops"));
    assert_eq!(status, 200, "{}", body.compact());
    assert_eq!(body.get("partners"), Some(&Json::Array(vec![])));
    d.end();
}

#[test]
/// Unsigned, a job door answers 401; signed, the call reaches its slice, whose own body check answers (every slice is
/// ported, so none answers "not ported").
fn a_job_door_answers_401_unsigned_then_its_slice_checks_the_body() {
    let Some(db) = TestDb::new() else { return };
    db.migrated_in_place();
    let d = door(db.store());
    let (status, body) = post(&d, "/internal/jobs/run-due-transfers", None);
    assert_eq!(status, 401);
    assert_eq!(
        body.compact(),
        r#"{"error":"service credentials required","code":"bank.unauthenticated"}"#
    );
    let (status, body) = post(&d, "/internal/jobs/bill-pay/run-due", Some("svc-bank"));
    assert_eq!(status, 400);
    assert_eq!(
        body.compact(),
        r#"{"error":"body not in shape","code":"bank.validation_failed"}"#
    );
    d.end();
}

#[test]
fn a_second_replica_skips_the_recovery_pass_while_the_first_holds_its_lock() {
    let Some(db) = TestDb::new() else { return };
    let first = AdvisoryLock(db::open_lock(&db.url, "svc-bank", false).unwrap());
    let second = AdvisoryLock(db::open_lock(&db.url, "svc-bank", false).unwrap());
    let inner_ran = AtomicBool::new(false);
    let mut inner = || inner_ran.store(true, Ordering::SeqCst);
    let mut seen = None;
    let mut outer = || {
        seen = Some(second.try_with(&mut inner).unwrap());
    };
    assert!(first.try_with(&mut outer).unwrap());
    assert_eq!(seen, Some(false), "the second replica did not get the lock");
    assert!(!inner_ran.load(Ordering::SeqCst));
    // Released after the pass: the next one gets it.
    let mut ran = false;
    let mut body = || ran = true;
    assert!(second.try_with(&mut body).unwrap());
    assert!(ran);
    // The lock connection is the recovery's own.
    let name: String = with_client(&first.0, |c| {
        Ok(
            c.query_one("SELECT current_setting('application_name')", &[])?
                .get(0),
        )
    })
    .unwrap();
    assert_eq!(name, "svc-bank-recovery");
    first.0.end();
    second.0.end();
}

#[test]
fn health_and_ready_answer_through_the_server() {
    let Some(db) = TestDb::new() else { return };
    db.migrated_in_place();
    let app = App {
        wire: door(db.store()),
        service_name: "svc-bank".to_owned(),
        ready_body: r#"{"ready":true}"#.to_owned(),
    };
    let health = app.route("GET", "/health", &[], "", "req-1");
    assert_eq!(
        (health.status, health.body.as_str()),
        (200, r#"{"ok":true,"service":"svc-bank"}"#)
    );
    let ready = app.route("GET", "/ready", &[], "", "req-2");
    assert_eq!(
        (ready.status, ready.body.as_str()),
        (200, r#"{"ready":true}"#)
    );
    app.wire.end();
}
