//! `svc-bank test-seed`, the binary itself, on a real Postgres: what the local test stack's seed
//! (`tooling/scripts/local-test-seed.mjs`) asks it. It opens a TEST earn pool and a TEST loan product through the
//! crate's own code, lists them, makes the same pool again rather than a second one, keeps a refusal's code, and refuses
//! to run outside a TEST stack before touching the database.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::io::Write;
use std::process::{Command, Stdio};

use service_kit::json::{self, Json};

use crate::support;

/// One run: exit code and stdout as JSON.
fn seed(url: &str, app_env: &str, op: &str, input: &str) -> (i32, Json) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_svc-bank"))
        .args(["test-seed", op])
        .env_clear()
        .env("DATABASE_URL", url)
        .env("APP_ENV", app_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let body = if text.is_empty() {
        Json::Null
    } else {
        json::parse(&text).unwrap_or_else(|e| panic!("not JSON ({e:?}): {text}"))
    };
    (out.status.code().unwrap_or(-1), body)
}

fn field<'a>(v: &'a Json, key: &str) -> &'a str {
    match v.get(key) {
        Some(Json::String(s)) => s,
        other => panic!("{key}: {other:?} in {}", v.compact()),
    }
}

fn items(v: &Json) -> &[Json] {
    match v {
        Json::Array(a) => a,
        other => panic!("not a list: {}", other.compact()),
    }
}

const POOL: &str = r#"{"poolId":"6c1d2f4e-0b7a-4c1e-8a2d-3f4b5c6d7e8f","assetId":"USDT","kind":"flexible","name":"TEST · USDT flexible (local test, not a real rate)","aprBps":400,"termDays":null,"minDeposit":"0"}"#;

const PRODUCT: &str = r#"{"name":"TEST · BTC collateral against USDT debt (local test, not a real rate)","debtAssetId":"USDT","collateralAssetId":"BTC","quoteAssetId":"USDT","aprBps":1000,"maxLtvBps":5000,"minPrincipal":"0","policy":{"marginCallLtvBps":7500,"liquidationLtvBps":8500,"insolvencyLtvBps":9500,"targetLtvBps":6500,"penaltyBps":200,"maxTrancheBps":2500,"graceSeconds":3600}}"#;

#[test]
fn the_seed_opens_lists_and_reopens_its_test_pool_and_product() {
    let Some(db) = support::TestDb::new() else {
        return;
    };
    db.migrated();

    // Nothing open yet: the list refuses by its code, which the seed reads as empty.
    let (code, empty) = seed(&db.url, "test", "list-pools", r#"{"limit":50}"#);
    assert_eq!(code, 1, "{}", empty.compact());
    let refused = empty.get("refused").unwrap();
    assert_eq!(field(refused, "code"), "bank.earn_rate_unset");

    let (code, pool) = seed(&db.url, "test", "create-pool", POOL);
    assert_eq!(code, 0, "{}", pool.compact());
    assert_eq!(field(&pool, "id"), "6c1d2f4e-0b7a-4c1e-8a2d-3f4b5c6d7e8f");
    assert_eq!(field(&pool, "status"), "open");
    assert_eq!(field(&pool, "assetId"), "USDT");
    // Its opening rate is recorded with it, as the service's own create does.
    assert_eq!(
        db.count("SELECT count(*) FROM bank.earn_rate_changes WHERE rate_bps = 400"),
        1
    );

    // The same pool again: the same row, not a second one.
    let (code, again) = seed(&db.url, "test", "create-pool", POOL);
    assert_eq!(code, 0, "{}", again.compact());
    assert_eq!(field(&again, "id"), field(&pool, "id"));
    assert_eq!(db.count("SELECT count(*) FROM bank.earn_pools"), 1);

    let (code, pools) = seed(&db.url, "test", "list-pools", r#"{"limit":50}"#);
    assert_eq!(code, 0, "{}", pools.compact());
    assert_eq!(items(&pools).len(), 1);
    assert_eq!(field(&items(&pools)[0], "name"), field(&pool, "name"));

    let (code, product) = seed(&db.url, "test", "create-product", PRODUCT);
    assert_eq!(code, 0, "{}", product.compact());
    assert_eq!(field(&product, "debtAssetId"), "USDT");
    let (code, products) = seed(&db.url, "test", "list-products", r#"{"limit":50}"#);
    assert_eq!(code, 0, "{}", products.compact());
    assert_eq!(items(&products).len(), 1);
    assert_eq!(field(&items(&products)[0], "id"), field(&product, "id"));

    // The service's own policy check is the judge: an incoherent policy refuses by its code and writes nothing.
    let bad = PRODUCT
        .replace("TEST · BTC", "TEST · bad BTC")
        .replace("\"targetLtvBps\":6500", "\"targetLtvBps\":9900");
    let (code, refused) = seed(&db.url, "test", "create-product", &bad);
    assert_eq!(code, 1, "{}", refused.compact());
    assert_eq!(
        field(refused.get("refused").unwrap(), "code"),
        "bank.policy_incoherent"
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.loan_products"), 1);
}

#[test]
fn outside_a_test_stack_it_refuses_before_reading_the_database() {
    // No database answers here: a refusal that came after a connection would fail differently.
    for app_env in ["production", "staging", ""] {
        let (code, out) = seed(
            "postgres://nobody:nothing@127.0.0.1:1/none_test",
            app_env,
            "create-pool",
            POOL,
        );
        assert_eq!(code, 1, "APP_ENV {app_env:?}");
        assert_eq!(out, Json::Null, "APP_ENV {app_env:?}: nothing on stdout");
    }
}
