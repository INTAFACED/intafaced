//! svc-agents' own ledger client against this door: the Rust `LedgerHttp` (`crates/svc-agents/src/metering/ports.rs`)
//! signs each window's charge as svc-agents and sends it to `/trpc/postRecipe` on a real Rust svc-ledger over a fresh
//! Postgres book (`support`), and gets its receipt. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The door is mounted as at launch: per-service keys in `keypair` mode, the body bound, svc-agents' own key, and the
//! custody layer off, where the window is earned and collected (`chargeEarn`, `chargeCollect`) and the custodial
//! `feeCharge` is refused; then with the custody layer on, where the fee charge books. Only the HTTP transport is in
//! process (`Fetch` hands the request to the door): the signing, the body, the door and the book are the real ones.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::sync::Arc;

use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::money::parse_amount;
use service_kit::s2s::{CallSigner, Mode};
use service_kit::server::Request;
use support::TestDb;
use support::door::{Kit, Setup, fx, migrated};
use svc_agents::metering::ports::{Ledger, LedgerHttp, Recipe};
use svc_ledger::door::Outcome;
use svc_ledger::errors::{CALLER_FORBIDDEN, CUSTODY_LAYER_OFF, INSUFFICIENT_FUNDS};

const BASE: &str = "http://svc-ledger.test";
const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSINESS: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// The wire, in process: each request is handed to the door as the server hands it one.
struct DoorFetch(Arc<Kit>);

impl Fetch for DoorFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let path = req
            .url
            .strip_prefix(BASE)
            .expect("the client calls the ledger's base url");
        let headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
            .collect();
        match self.0.door.decide(&Request {
            method: &req.method,
            url: path,
            headers: &headers,
            body: req.body.as_deref().unwrap_or(""),
        }) {
            Outcome::Answer(r) => Ok(HttpResponse {
                status: r.status,
                body: r.body,
            }),
            Outcome::Owed(s) => panic!("{path} is still owed by {}", s.name()),
        }
    }
}

/// The door over a fresh book, and svc-agents' client to it, signed with svc-agents' own key (`main.rs`).
fn wired(custody_on: bool) -> Option<(TestDb, Arc<Kit>, LedgerHttp)> {
    let db = migrated()?;
    let kit = Arc::new(Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Keypair),
            services: &["svc-agents", "svc-academy"],
            custody_on,
        },
    ));
    let signer = CallSigner::new(
        "svc-agents",
        "svc-ledger",
        "unused-shared-secret-in-keypair-mode",
        Some((kit.signer("svc-agents"), Mode::Keypair)),
    );
    let ledger = LedgerHttp::new(BASE, signer, Arc::new(DoorFetch(kit.clone())));
    Some((db, kit, ledger))
}

fn amt(s: &str) -> i128 {
    parse_amount(s).unwrap()
}

fn earn() -> Recipe {
    Recipe::ChargeEarn {
        module: "agents".to_owned(),
        sale_id: format!("{SESSION}.w1"),
        user_id: BUSINESS.to_owned(),
        member_user_id: Some(USER.to_owned()),
        asset_id: "USDC".to_owned(),
        per_unit: amt("0.25"),
    }
}

fn collect() -> Recipe {
    Recipe::ChargeCollect {
        module: "agents".to_owned(),
        user_id: BUSINESS.to_owned(),
        partner_id: "reserve-a".to_owned(),
        payment_id: "pay_1".to_owned(),
        asset_id: "USDC".to_owned(),
        amount: amt("0.25"),
    }
}

fn fee(asset: &str) -> Recipe {
    Recipe::FeeCharge {
        charge_id: format!("agent.usage:{SESSION}:w1"),
        user_id: USER.to_owned(),
        module: "agents".to_owned(),
        asset_id: asset.to_owned(),
        amount: amt("1"),
        reason: "agents.usage.metered".to_owned(),
    }
}

fn account(owner_type: &str, owner_id: &str, asset: &str) -> service_kit::json::Json {
    use service_kit::json::Json;
    Json::obj([
        ("ownerType", Json::str(owner_type)),
        ("ownerId", Json::str(owner_id)),
        ("assetId", Json::str(asset)),
        ("kind", Json::str("available")),
    ])
}

#[test]
fn a_window_earned_then_collected_gets_the_ledgers_receipt_for_each_once_under_its_own_key() {
    let Some((_db, k, ledger)) = wired(false) else {
        return;
    };
    let earned = ledger.post_recipe(&earn()).unwrap();
    assert_eq!(k.tx(&earn().idempotency_key()).unwrap().0, earned);
    let collected = ledger.post_recipe(&collect()).unwrap();
    assert_eq!(k.tx(&collect().idempotency_key()).unwrap().0, collected);
    // A retry (the receipt was lost on the way back) is the same transaction, booked once.
    assert_eq!(ledger.post_recipe(&earn()).unwrap(), earned);
    assert_eq!(ledger.post_recipe(&collect()).unwrap(), collected);
    assert_eq!(k.rows(&earn().idempotency_key()), 1);
    assert_eq!(k.rows(&collect().idempotency_key()), 1);
    // Revenue up by the window; the business owes nothing after the collect; the partner's reserve holds it as ours.
    assert_eq!(k.bal(&account("house", "fees:agents", "USDC")), "0.25");
    assert_eq!(
        k.bal(&account(
            "treasury",
            &format!("charge-receivable:agents.{BUSINESS}"),
            "USDC"
        )),
        "0"
    );
    assert_eq!(
        k.bal(&account("treasury", "partner-reserve:reserve-a", "USDC")),
        "-0.25"
    );
    // The member whose run it was is named on the earn.
    let (_, meta) = k.tx(&earn().idempotency_key()).unwrap();
    assert_eq!(
        meta.get("memberUserId"),
        Some(&service_kit::json::Json::str(USER))
    );
}

#[test]
fn a_collect_before_the_earn_is_refused_insufficient_funds_and_nothing_is_booked() {
    let Some((_db, k, ledger)) = wired(false) else {
        return;
    };
    let err = ledger.post_recipe(&collect()).unwrap_err();
    assert_eq!(
        err.code.as_deref(),
        Some(INSUFFICIENT_FUNDS),
        "{}",
        err.message
    );
    assert_eq!(k.rows(&collect().idempotency_key()), 0);
}

#[test]
fn with_the_custody_layer_off_the_fee_charge_is_refused_and_nothing_is_booked() {
    let Some((_db, k, ledger)) = wired(false) else {
        return;
    };
    let err = ledger.post_recipe(&fee("USDT")).unwrap_err();
    assert_eq!(
        err.code.as_deref(),
        Some(CUSTODY_LAYER_OFF),
        "{}",
        err.message
    );
    assert_eq!(k.rows(&fee("USDT").idempotency_key()), 0);
}

#[test]
fn with_the_custody_layer_on_the_fee_charge_books_from_the_persons_balance_and_gets_its_receipt() {
    let Some((_db, k, ledger)) = wired(true) else {
        return;
    };
    // 100 USDT deposited to USER by the engine, as the binding tests fund it.
    k.engine(&fx(&["callerBinding", "funded"]));
    let tx = ledger.post_recipe(&fee("USDT")).unwrap();
    assert_eq!(k.tx(&fee("USDT").idempotency_key()).unwrap().0, tx);
    assert_eq!(ledger.post_recipe(&fee("USDT")).unwrap(), tx);
    assert_eq!(k.bal(&account("user", USER, "USDT")), "99");
    assert_eq!(k.bal(&account("house", "fees:agents", "USDT")), "1");
}

#[test]
fn svc_academy_may_not_post_svc_agents_recipes() {
    let Some((_db, k, _)) = wired(false) else {
        return;
    };
    let body = service_kit::json::Json::obj([
        ("recipe", service_kit::json::Json::str("chargeEarn")),
        ("input", earn().input()),
    ]);
    let (status, reply) = k.keyed("svc-academy", "/trpc/postRecipe", &body);
    assert_eq!(status, 403);
    assert_eq!(
        reply.get("code"),
        Some(&service_kit::json::Json::str(CALLER_FORBIDDEN))
    );
    assert_eq!(k.rows(&earn().idempotency_key()), 0);
}
