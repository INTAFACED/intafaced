//! How svc-tax is started: the door gets the edge's trust settings from the environment (edge-trust.test.ts's start-up
//! pin). The settings' own parsing is `env.rs`'s tests.
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
