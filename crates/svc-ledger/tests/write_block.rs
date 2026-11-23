//! A store that cannot take a write refuses with a typed write-block code the service door answers 503, so a caller
//! retries with the same key: `services/svc-ledger/src/ledger/write-block.test.ts`, case for case. `toWriteBlockError`'s
//! pass-through is `posting::tests`'s (it is private).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::sync::Arc;

use service_kit::json::{self, Json};
use svc_ledger::db::{self, StoreError};
use svc_ledger::errors::{Failure, http_error};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::gate::Caller;
use svc_ledger::posting::{self, Posting, write_block};

const DISK_FULL: &str = "ledger.writes_blocked_store_disk_full";
const UNAVAILABLE: &str = "ledger.writes_blocked_store_unavailable";

fn pg(code: &str) -> StoreError {
    StoreError::new(format!("pg {code}"), Some(code))
}

/// The TypeScript driver's socket codes (`ECONNREFUSED`, `CONNECTION_CLOSED`, `CONNECT_TIMEOUT`): no SQLSTATE, the
/// server never answered.
fn socket(message: &str) -> StoreError {
    StoreError {
        socket: true,
        ..StoreError::new(message, None)
    }
}

#[test]
fn names_a_full_disk() {
    assert_eq!(write_block(&pg("53100")), Some(DISK_FULL));
}

#[test]
fn names_an_unavailable_store() {
    for code in ["08006", "08001", "57P01", "25006"] {
        assert_eq!(write_block(&pg(code)), Some(UNAVAILABLE), "{code}");
    }
    for code in ["ECONNREFUSED", "CONNECTION_CLOSED", "CONNECT_TIMEOUT"] {
        assert_eq!(write_block(&socket(code)), Some(UNAVAILABLE), "{code}");
    }
}

#[test]
fn leaves_everything_else_alone() {
    // A ledger refusal never reaches the classifier as a store error (`posting::tests` holds that it passes through).
    for code in ["23505", "53200"] {
        assert_eq!(write_block(&pg(code)), None, "{code}");
    }
    assert_eq!(write_block(&StoreError::new("no code", None)), None);
}

#[test]
fn maps_to_503_on_the_service_door_so_callers_retry_with_the_same_key() {
    let refusal = Failure::ledger(UNAVAILABLE, "ledger writes are blocked");
    let (status, body) = http_error(&refusal);
    assert_eq!(status, 503);
    assert_eq!(
        body,
        Json::Object(vec![
            ("message".to_owned(), Json::str(UNAVAILABLE)),
            ("code".to_owned(), Json::str(UNAVAILABLE)),
        ])
    );
    assert_eq!(http_error(&Failure::ledger(DISK_FULL, "full")).0, 503);
}

#[test]
fn a_post_against_a_store_that_is_down_refuses_with_store_unavailable_not_an_untyped_error() {
    // Port 1 on loopback: nothing listens, so the connection is refused before anything could be booked.
    let store = db::open(
        "postgres://nobody:nobody@127.0.0.1:1/none_test",
        "svc-ledger",
        1,
        false,
    )
    .unwrap();
    let p = Posting::new(
        Arc::new(MemoryBus::default()),
        "svc-ledger".to_owned(),
        true,
        EngineOptions {
            conflict: Conflict::Refuse,
            clock_skew_bound_ms: None,
            clock_ms: || 1_795_000_000_000,
        },
        false,
        None,
    );
    let deposit = json::parse(
        r#"{"idempotencyKey":"deposit:test:write-block-1","module":"ledger","reason":"deposit.credited","entries":[{"account":{"ownerType":"treasury","ownerId":"rail:test","assetId":"USDT","kind":"available"},"direction":"credit","amount":"1"},{"account":{"ownerType":"user","ownerId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","assetId":"USDT","kind":"available"},"direction":"debit","amount":"1"}],"meta":{"rail":"test","railRef":"write-block-1"}}"#,
    )
    .unwrap();
    let refused = posting::post(
        &store,
        &p,
        Some(&Caller::Legacy(Some("svc-wallet".to_owned()))),
        "dual",
        &deposit,
    )
    .unwrap_err();
    match &refused {
        Failure::Ledger { code, .. } => assert_eq!(code, UNAVAILABLE),
        other => panic!("not a typed refusal: {other:?}"),
    }
    assert_eq!(http_error(&refused).0, 503);
}
