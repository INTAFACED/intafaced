//! The `reports` slice against a real Postgres, in a throwaway database (`support`). Without a URL it skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! It ports `statement-pnl-postgres.test.ts` ("refuses missing lots/marks/NAV after a real deposit — never 0, never
//! cash as NAV"). The TypeScript books its deposit with `PostgresLedger.post`, which is the `posting` slice's; here the
//! two accounts the deposit leaves are written as rows, so the statement reads the same balances.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json;
use service_kit::schema::{Outcome, Value};
use support::TestDb;
use svc_ledger::door;
use svc_ledger::errors::{self, Failure};
use svc_ledger::migrate::FILES;
use svc_ledger::reports::{self, STATEMENT_LOTS_MISSING, STATEMENT_NAV_INPUTS_MISSING};

const OWNER: &str = "77777777-7777-4777-8777-777777777777";

fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

/// The statement door's answer on this book, as the wire carries it.
fn statement(db: &TestDb, body: &str) -> (u16, String) {
    let store = db.store();
    let Ok(Outcome::Ok(input)) = door::parse(
        "statementPnl",
        Value::from_json(&json::parse(body).unwrap()),
    ) else {
        panic!("the body passes the door's input check")
    };
    let read = |t: &str, id: &str| reports::read_balances(&store, t, id);
    let (status, body) = match reports::answer("statementPnl", &input, 0, &read) {
        Ok(b) => (200, b),
        Err(f) => errors::http_error(&f),
    };
    store.end();
    (status, body.compact())
}

const BODY: &str = r#"{"ownerType":"user","ownerId":"77777777-7777-4777-8777-777777777777","reportingAssetId":"USDT"}"#;

#[test]
fn refuses_missing_lots_marks_and_nav_after_a_real_deposit_never_0_never_cash_as_nav() {
    let Some(db) = migrated() else { return };
    db.client()
        .execute(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, balance)
             VALUES ('user', $1, 'USDT', 'available', 40.25),
                    ('treasury', 'rail:crypto-native', 'USDT', 'available', -40.25)",
            &[&OWNER],
        )
        .unwrap();
    let (status, body) = statement(&db, BODY);
    assert_eq!(status, 200);
    let out = json::parse(&body).unwrap();
    assert_eq!(out.get("status"), Some(&json::Json::str("refused")));
    for code in [STATEMENT_LOTS_MISSING, STATEMENT_NAV_INPUTS_MISSING] {
        assert!(body.contains(code), "{body} names {code}");
    }
    for figure in ["realized", "unrealized", "nav"] {
        assert_eq!(out.get(figure), Some(&json::Json::Null), "{figure} is null");
    }
    assert!(!body.contains("\"0\""), "never 0: {body}");
    assert!(!body.contains("40.25"), "never cash as NAV: {body}");
}

/// The book is read, not skipped: when the read fails, the call fails as the TypeScript's does.
#[test]
fn a_failed_balance_read_fails_the_statement() {
    let Some(db) = migrated() else { return };
    db.client()
        .batch_execute("ALTER TABLE ledger.accounts RENAME TO accounts_gone")
        .unwrap();
    assert_eq!(
        statement(&db, BODY),
        (500, errors::http_error(&Failure::Fault).1.compact())
    );
}
