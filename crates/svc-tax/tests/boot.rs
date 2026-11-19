//! How svc-tax is started: the door gets the edge's trust settings from the environment (edge-trust.test.ts's start-up
//! pin), and the fleet's compose file starts it with the owner's blanks left blank (compose-wiring.test.ts and
//! history-years-unset.test.ts's compose half). The settings' own parsing is `env.rs`'s tests.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::Arc;

use svc_tax::env;
use svc_tax::http::{Fetch, UreqFetch};
use svc_tax::service;

const COMPOSE: &str = include_str!("../../../docker-compose.apps.yml");
const SECRET: &str = "placeholder-edge-principal-secret-32-chars";
/// An Ed25519 public key in the form the edge publishes (base64url, raw 32 bytes): io-golden.json's edge key.
const EDGE_KEY: &str = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg";

fn booted(extra: &[(&str, &str)]) -> svc_tax::wire::Wire {
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    vars.insert("EDGE_PRINCIPAL_SECRET".into(), SECRET.into());
    vars.insert("INTERNAL_SERVICE_SECRET".into(), SECRET.into());
    for (k, v) in extra {
        vars.insert((*k).into(), (*v).into());
    }
    let env = env::load(&vars).unwrap();
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let ports = service::ports(&env, &fetch).unwrap();
    service::wire(&env, &ports).unwrap()
}

#[test]
fn the_door_trusts_the_edge_key_only_when_the_environment_sets_it() {
    assert!(!booted(&[]).trusts_edge_key());
    let with_key = booted(&[
        ("EDGE_PRINCIPAL_PUBLIC_KEY", EDGE_KEY),
        ("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS", "120"),
        ("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS", "10"),
    ]);
    assert!(with_key.trusts_edge_key());
}

/// The lines under `  svc-tax:` up to the next top-level service.
fn block(name: &str) -> String {
    let head = format!("  {name}:\n");
    let start = COMPOSE
        .find(&head)
        .unwrap_or_else(|| panic!("no {name} block in docker-compose.apps.yml"));
    let rest = &COMPOSE[start + head.len()..];
    let end = rest
        .lines()
        .scan(0usize, |at, line| {
            let here = *at;
            *at += line.len() + 1;
            Some((here, line))
        })
        .find(|(_, line)| {
            line.starts_with("  ") && !line.starts_with("   ") && line.trim_end().ends_with(':')
        })
        .map_or(rest.len(), |(at, _)| at);
    rest[..end].to_owned()
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.lines().filter(|l| l.trim() == needle).count()
}

#[test]
fn compose_runs_the_rust_binary_on_4020_with_the_owner_values_blank() {
    let b = block("svc-tax");
    for line in [
        "image: intafaced/svc-tax:dev",
        "dockerfile: crates/svc-tax/Dockerfile",
        "command: ['/app/svc-tax']",
        "SERVICE_NAME: svc-tax",
        "HTTP_PORT: '4020'",
        "LEDGER_URL: http://svc-ledger:4001",
        "BANK_URL: http://svc-bank:4009",
        "DATABASE_URL: postgres://svc_tax:${SVC_TAX_DB_PASSWORD:-svc_tax}@postgres:5432/intafaced",
    ] {
        assert_eq!(count(&b, line), 1, "svc-tax's block holds `{line}` once");
    }
    // The owner's values pass through blank: never a filled-in map, window, lake or indexer.
    for line in [
        "TAX_JURISDICTION_MAP_JSON: ${TAX_JURISDICTION_MAP_JSON:-}",
        "TAX_HISTORY_YEARS: ${TAX_HISTORY_YEARS:-}",
        "CONNECT_DATA_LAKE_TSDB_URL: ${CONNECT_DATA_LAKE_TSDB_URL:-}",
        "INDEXER_URL: ${INDEXER_URL:-}",
    ] {
        assert_eq!(count(&b, line), 1, "svc-tax's block holds `{line}` once");
    }
    assert_eq!(
        COMPOSE
            .lines()
            .filter(|l| l.trim_start().starts_with("TAX_HISTORY_YEARS:"))
            .count(),
        1,
        "TAX_HISTORY_YEARS is set in svc-tax's block only"
    );
    assert!(
        !COMPOSE.contains("${TAX_HISTORY_YEARS:-10}"),
        "a window of 10 years is never invented"
    );
    // It starts after its schema is migrated and the ledger is up, and the edge reaches it.
    assert!(b.contains("svc-tax-migrate:\n        condition: service_completed_successfully"));
    assert!(b.contains("svc-ledger:\n        condition: service_healthy"));
    assert_eq!(count(COMPOSE, "TAX_URL: http://svc-tax:4020"), 1);
    let m = block("svc-tax-migrate");
    assert_eq!(count(&m, "command: ['/app/svc-tax', 'migrate']"), 1);
}
