//! `blotter-limit-unset-refuse.test.ts` of the TypeScript service, ported test for test against the real door over a
//! real engine (`MatchingDoor::decide`, as `tests/door_auth.rs` drives it): the signed list doors
//! `GET /markets/:marketId/orders` and `GET /surveillance/cases` refuse their named code without a published window
//! (1 to 500), and slice to the one published.
//!
//! Not ported, because the Rust has no such path:
//!
//! - "router.ts does not invent 50 or 100 on the blotter door": a text search of `router.ts`, which is deleted. Its
//!   promise is the behaviour below: every unpublished window refuses its code.
//! - The "does not call the engine" half of the omit tests counted a stub's reads; a real engine's read leaves no
//!   record. What is ported is the answer: the refusal is the code and its copy alone, and lists no order or case.
//! - The stub's rows: the TypeScript handed the door fixed rows; here they are real resting orders and journalled
//!   surveillance cases, and the slice is checked against the same door's full list.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]
use std::sync::{Arc, Mutex};

use service_kit::json::{self, Json};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::{Digest, Sha256};
use svc_matching::approval::Stub;
use svc_matching::door::published_limit;
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::env::parse_operator_ids;
use svc_matching::errors::user_copy;
use svc_matching::journal::JournalCommand;
use svc_matching::journal::io::{EngineJournal, MemoryJournal};
use svc_matching::journal::replay::MemorySnapshotSink;

// ── the door, as door_auth.rs builds it ─────────────────────────────────

const SECRET: &str = "matching-internal-service-secret-32c";
const MARKET: &str = "BTC-USDT";

/// The door's clock is the real one, so the signed headers (signed now) are fresh.
fn now_ms() -> i64 {
    system_seconds() * 1000
}

/// A bus the test reads after handing it to the engine (`MemoryEventBus`'s `published`).
#[derive(Clone, Default)]
struct Bus(Arc<Mutex<Vec<Published>>>);

impl EventBus for Bus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        let mut inner = MemoryEventBus::default();
        inner.publish(name, payload, key)?;
        self.0.lock().unwrap().extend(inner.published);
        Ok(())
    }
}

fn engine_on(journal: Box<dyn EngineJournal + Send>, bus: Bus) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(bus),
        clock: now_ms,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

/// `registerRoutes(app, engine, SECRET, { bodyBind: 'require' })`.
fn door_over(engine: MatchingEngine) -> MatchingDoor {
    MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: None,
            edge_key: None,
            clock: now_ms,
            approvals: Box::new(Stub {
                approver_id: "ops-confirm".to_owned(),
                requester_id: "ops-1".to_owned(),
            }),
            operator_ids: parse_operator_ids(Some("ops-1, ops-confirm")),
        },
        engine,
    )
    .unwrap()
}

/// A door over a fresh engine on a memory journal, and the bus it publishes on.
fn mount() -> (MatchingDoor, Bus) {
    let bus = Bus::default();
    let door = door_over(engine_on(Box::new(MemoryJournal::new()), bus.clone()));
    (door, bus)
}

struct Answer {
    status: u16,
    raw: String,
    body: Json,
}

impl Answer {
    fn get(&self, key: &str) -> &Json {
        self.body
            .get(key)
            .unwrap_or_else(|| panic!("no {key} in {}", self.raw))
    }

    fn text(&self, key: &str) -> String {
        match self.body.get(key) {
            Some(Json::String(s)) => s.clone(),
            other => panic!("{key} is not text in {}: {other:?}", self.raw),
        }
    }

    fn has(&self, key: &str) -> bool {
        self.body.get(key).is_some()
    }
}

fn send(
    door: &MatchingDoor,
    method: &str,
    url: &str,
    payload: &str,
    headers: &[(String, String)],
) -> Answer {
    let mut all: Vec<(String, String)> = if payload.is_empty() {
        Vec::new()
    } else {
        vec![("content-type".to_owned(), "application/json".to_owned())]
    };
    all.extend_from_slice(headers);
    match door.decide(&Request {
        method,
        url,
        headers: &all,
        body: payload,
    }) {
        Outcome::Answer(r) => Answer {
            status: r.status,
            body: json::parse(&r.body).unwrap_or_else(|_| panic!("{} is JSON", r.body)),
            raw: r.body,
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

/// `serviceAuthHeadersForBody('svc-trade', SECRET, body)`.
fn signed(body: &str) -> Vec<(String, String)> {
    legacy_headers("svc-trade", SECRET, body, system_seconds()).unwrap()
}

/// A signed svc-trade read.
fn signed_get(door: &MatchingDoor, url: &str) -> Answer {
    send(door, "GET", url, "", &signed(""))
}

fn post(door: &MatchingDoor, url: &str, payload: &str) -> Answer {
    send(door, "POST", url, payload, &signed(payload))
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// The snapshot `createMarketLifecycleAdmissionProof` is handed: an OPEN market allowing these actions, observed at.
fn snapshot(market: &str, allowed: &[&str], at: &str) -> Json {
    Json::obj([
        ("marketId", Json::str(market)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(market)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(at)),
        ("observedAt", Json::str(at)),
        ("lastGoodState", Json::str("OPEN")),
        ("allowedActions", strs(allowed)),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
    ])
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)`: the snapshot's hash is its id.
fn proof_of(snapshot: Json, action: &str) -> Json {
    let checked_at = snapshot.get("observedAt").unwrap().clone();
    let hex: String = Sha256::digest(snapshot.compact().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Json::obj([
        ("action", Json::str(action)),
        ("decision", Json::str("ELIGIBLE")),
        ("checkedAt", checked_at),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// `proofFor(marketId, action)` of the TypeScript tests.
fn proof_for(market: &str, action: &str) -> Json {
    proof_of(snapshot(market, ALLOWED, OBSERVED_AT), action)
}

/// `submitBody(orderId, accountId, side, qty, price)`: a GTC limit order with its PLACE proof.
fn limit_body(order_id: &str, account: &str, side: &str, qty: &str, price: &str) -> String {
    Json::obj([
        ("orderId", Json::str(order_id)),
        ("accountId", Json::str(account)),
        ("type", Json::str("limit")),
        ("side", Json::str(side)),
        ("qty", Json::str(qty)),
        ("price", Json::str(price)),
        ("tif", Json::str("GTC")),
        ("lifecycleProof", proof_for(MARKET, "PLACE")),
    ])
    .compact()
}

fn place(
    door: &MatchingDoor,
    order_id: &str,
    account: &str,
    side: &str,
    qty: &str,
    price: &str,
) -> Answer {
    post(
        door,
        &format!("/markets/{MARKET}/orders"),
        &limit_body(order_id, account, side, qty, price),
    )
}

fn place_ok(
    door: &MatchingDoor,
    order_id: &str,
    account: &str,
    side: &str,
    qty: &str,
    price: &str,
) -> Answer {
    let a = place(door, order_id, account, side, qty, price);
    assert_eq!(a.status, 200, "{}", a.raw);
    assert_eq!(a.body.get("accepted"), Some(&Json::Bool(true)), "{}", a.raw);
    a
}

fn arr(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not an array: {}", other.compact()),
    }
}

/// The journal's record kinds: what the engine was asked to do.
fn kinds(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

const OBSERVED_AT: &str = "2026-08-25T16:00:00.000Z";
const ALLOWED: &[&str] = &["PLACE", "PLACE_POST_ONLY"];
const O1: &str = "11111111-1111-4111-8111-111111111111";
const O2: &str = "22222222-2222-4222-8222-222222222222";
const O3: &str = "33333333-3333-4333-8333-333333333333";
const ORDERS: &str = "/markets/BTC-USDT/orders";
const CASES: &str = "/surveillance/cases";

fn exact_refusal(res: &Answer, code: &str) {
    assert_eq!(res.status, 400, "{}", res.raw);
    assert_eq!(
        res.body,
        Json::obj([
            ("code", Json::str(code)),
            ("message", Json::str(user_copy(code))),
        ])
    );
}

/// Three resting orders of one account (`RESTING`).
fn resting_three() -> MatchingDoor {
    let (door, _) = mount();
    place_ok(&door, O1, "a", "sell", "1", "100");
    place_ok(&door, O2, "a", "sell", "1", "101");
    place_ok(&door, O3, "a", "sell", "1", "102");
    door
}

/// `recordOpenSurveillanceCase` for each case (`CASES`), then the door over an engine started cold on that journal.
fn with_cases(reasons: &[&str]) -> MatchingDoor {
    let mut journal = MemoryJournal::new();
    for reason in reasons {
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("open_surveillance")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str(OBSERVED_AT)),
                ("accountId", Json::str("desk")),
                ("reason", Json::str(*reason)),
            ])))
            .unwrap();
    }
    let mut engine = engine_on(Box::new(journal), Bus::default());
    engine.recover().unwrap();
    door_over(engine)
}

// ── HMAC list query limit parse ─────────────────────────────────────────

/// `parseMatchingListQueryLimit` is `parsePublicL2QueryLimit`; here both are `door::published_limit`. An absent
/// `limit` (`undefined`) refuses at the door, below.
#[test]
fn list_limit_unset_blank_non_integer_0_and_501_refuse_never_invent_50_or_100() {
    assert_eq!(published_limit(""), None);
    assert_eq!(published_limit("  "), None);
    assert_eq!(published_limit("50.5"), None);
    assert_eq!(published_limit("0"), None);
    assert_eq!(published_limit("501"), None);
    assert_eq!(published_limit("100"), Some(100));
    assert_eq!(published_limit("2"), Some(2));
}

// ── GET /markets/:marketId/orders ───────────────────────────────────────

#[test]
fn resting_orders_omitted_limit_refuses_the_named_code_and_lists_nothing() {
    let door = resting_three();
    let before = kinds(&door);
    let res = signed_get(&door, ORDERS);
    exact_refusal(&res, "matching.resting_orders_limit_unset");
    assert!(!res.raw.contains(O1));
    assert_eq!(kinds(&door), before);
}

#[test]
fn resting_orders_empty_zero_501_and_text_refuse_with_no_invented_50() {
    let door = resting_three();
    for q in ["?limit=", "?limit=0", "?limit=501", "?limit=nope"] {
        let res = signed_get(&door, &format!("{ORDERS}{q}"));
        assert_eq!(res.status, 400, "{q}: {}", res.raw);
        assert_eq!(
            res.text("code"),
            "matching.resting_orders_limit_unset",
            "{q}"
        );
        assert!(!res.has("orders"), "{q}");
    }
}

#[test]
fn resting_orders_published_2_slices_the_resting_book() {
    let door = resting_three();
    let all = signed_get(&door, &format!("{ORDERS}?limit=500"));
    assert_eq!(all.status, 200, "{}", all.raw);
    assert_eq!(arr(all.get("orders")).len(), 3);

    let res = signed_get(&door, &format!("{ORDERS}?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.text("marketId"), MARKET);
    let orders = arr(res.get("orders"));
    assert_eq!(orders, &arr(all.get("orders"))[..2]);
    let ids: Vec<&Json> = orders.iter().map(|o| o.get("orderId").unwrap()).collect();
    assert_eq!(ids, vec![&Json::str(O1), &Json::str(O2)]);
    match &res.body {
        Json::Object(fields) => assert_eq!(
            fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["marketId", "orders"]
        ),
        other => panic!("not an object: {}", other.compact()),
    }
}

/// The TypeScript's stub said the market exists with nothing resting; here the market traded and holds nothing.
#[test]
fn resting_orders_an_empty_book_with_a_published_limit_is_200_no_orders_not_404() {
    let (door, _) = mount();
    place_ok(&door, O1, "maker", "sell", "1", "100");
    place_ok(&door, O2, "taker", "buy", "1", "100");
    assert_eq!(door.engine().resting_order_count(), 0);
    let res = signed_get(&door, &format!("{ORDERS}?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(
        res.body,
        Json::obj([
            ("marketId", Json::str(MARKET)),
            ("orders", Json::Array(Vec::new())),
        ])
    );
}

// ── GET /surveillance/cases ─────────────────────────────────────────────

#[test]
fn surveillance_cases_omitted_limit_refuses_the_named_code_and_lists_nothing() {
    let door = with_cases(&["spoofing", "layering", "self_trade"]);
    let before = kinds(&door);
    let res = signed_get(&door, CASES);
    exact_refusal(&res, "matching.surveillance_cases_limit_unset");
    assert!(!res.raw.contains("spoofing"));
    assert_eq!(kinds(&door), before);
}

#[test]
fn surveillance_cases_published_2_slices_the_open_cases() {
    let door = with_cases(&["spoofing", "layering", "self_trade"]);
    let all = signed_get(&door, &format!("{CASES}?limit=500"));
    assert_eq!(all.status, 200, "{}", all.raw);
    assert_eq!(arr(all.get("cases")).len(), 3);

    let res = signed_get(&door, &format!("{CASES}?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    let cases = arr(res.get("cases"));
    assert_eq!(cases.len(), 2);
    assert_eq!(cases, &arr(all.get("cases"))[..2]);
    for c in cases {
        assert_eq!(c.get("accountId"), Some(&Json::str("desk")));
        assert_eq!(c.get("marketId"), Some(&Json::str(MARKET)));
        assert_eq!(c.get("status"), Some(&Json::str("open")));
    }
}

#[test]
fn surveillance_cases_none_open_with_a_published_limit_is_200_no_cases_not_404() {
    let (door, _) = mount();
    let res = signed_get(&door, &format!("{CASES}?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.get("cases"), &Json::Array(Vec::new()));
}
