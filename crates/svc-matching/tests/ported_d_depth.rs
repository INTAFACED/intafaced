//! The public depth doors' tests of the TypeScript service, ported test for test against the real door over a real
//! engine (`MatchingDoor::decide`, as `tests/door_auth.rs` drives it):
//!
//! - `l3.router.test.ts`: `GET /markets/:marketId/depth/l3` reads the engine's native queue, `/depth` stays L2 tuples.
//! - `l3-limit-unset-refuse.test.ts`: the L3 door refuses `matching.l3_depth_limit_unset` without a published window.
//! - `sbe.router.test.ts` and `sbe-l2.test.ts`: `?format=sbe` and `/depth/sbe` never answer the JSON ladder as SBE.
//!
//! Not ported, because the Rust has no such path:
//!
//! - `l3.router`'s "missing l3Queue hitch refuses l3_unavailable": it mounts an engine stub without `l3Queue`. Here
//!   `MatchingEngine::l3_queue` is a method of the one engine the door is built over, so no door can lack it.
//! - The halves of `l3.router`'s and `l3-limit-unset-refuse`'s stub tests that set L2 and L3 apart (a stub's `depth`
//!   full while its `l3Queue` is empty) and "does not call the engine" (a read the stub counted): a real engine's L2
//!   and L3 are read from the same book, and a read leaves no record. What is ported is the answer: a traded-out book's
//!   L3 is 200 and empty, and a refused window answers its code alone, before any level is read.
//! - `l3-limit-unset-refuse`'s "router.ts does not invent 50": a text search of `router.ts`, which is deleted. Its
//!   promise is the behaviour below: every unpublished window refuses.
//! - `sbe.router`'s and `sbe-l2`'s "linked Real Logic codec" tests (they skipped themselves without the Java bridge),
//!   `sbe-l2`'s utf8 stub and IEEE input to `encodeMatchingL2Sbe`: this port links no SBE encoder (PORT.md), so there is
//!   no encoder to hand a stub, a float or a frame; every SBE ask refuses, which the tests below hold. An amount on
//!   the book is a scaled integer (`service_kit::money`), so a float has no way in.
//! - "content-type is JSON": the door answers a body, and the server writes every door answer as JSON; the tests read
//!   that the body parses as JSON.
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

/// A public read (`app.inject({ method: 'GET', url })`).
fn get(door: &MatchingDoor, url: &str) -> Answer {
    send(door, "GET", url, "", &[])
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
const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";
const THIRD: &str = "33333333-3333-4333-8333-333333333333";

/// `assertNoJsonNumbers`: every amount is a decimal string; only `sequence` is a number.
fn assert_no_json_numbers(value: &Json, path: &str) {
    match value {
        Json::Number(n) => panic!("money amount at {path} left as JSON number {n}"),
        Json::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                assert_no_json_numbers(v, &format!("{path}[{i}]"));
            }
        }
        Json::Object(fields) => {
            for (k, v) in fields {
                if k != "sequence" {
                    assert_no_json_numbers(v, &format!("{path}.{k}"));
                }
            }
        }
        Json::Null | Json::Bool(_) | Json::String(_) => {}
    }
}

fn ladder(levels: &[(&str, &str)]) -> Json {
    Json::Array(levels.iter().map(|(p, s)| strs(&[p, s])).collect())
}

/// Two sells resting at 100, 1 then 2 (`l3.router`'s book).
fn two_rests() -> MatchingDoor {
    let (door, _) = mount();
    place_ok(&door, FIRST, "maker-a", "sell", "1", "100");
    place_ok(&door, SECOND, "maker-b", "sell", "2", "100");
    door
}

/// A market that traded and holds nothing now: the book exists, and its every level is empty.
fn traded_out() -> MatchingDoor {
    let (door, _) = mount();
    place_ok(&door, FIRST, "maker-a", "sell", "1", "100");
    let fill = place_ok(&door, SECOND, "taker-b", "buy", "1", "100");
    assert_eq!(arr(fill.get("fills")).len(), 1, "{}", fill.raw);
    assert!(door.engine().has_market(MARKET));
    assert_eq!(door.engine().resting_order_count(), 0);
    door
}

/// `seedBook` of `sbe.router`: a sell at 101 and a buy at 100.
fn seeded() -> MatchingDoor {
    let (door, _) = mount();
    place_ok(&door, FIRST, "maker-a", "sell", "1", "101");
    place_ok(&door, SECOND, "maker-b", "buy", "1", "100");
    door
}

// ── l3.router.test.ts ───────────────────────────────────────────────────

#[test]
fn l3_router_depth_l3_lists_the_per_order_queue_from_the_native_queue_not_l2_size_tuples() {
    let door = two_rests();

    let l2 = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(l2.status, 200, "{}", l2.raw);
    assert_eq!(l2.get("asks"), &ladder(&[("100", "3")]));
    assert!(!l2.has("level"));
    assert!(!l2.has("orders"));

    let l3 = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=2"));
    assert_eq!(l3.status, 200, "{}", l3.raw);
    assert_eq!(l3.text("level"), "L3");
    assert_eq!(l3.text("marketId"), MARKET);
    let asks = arr(l3.get("asks"));
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].get("price"), Some(&Json::str("100")));
    let orders = arr(asks[0].get("orders").unwrap());
    let ids: Vec<&Json> = orders.iter().map(|o| o.get("orderId").unwrap()).collect();
    assert_eq!(ids, vec![&Json::str(FIRST), &Json::str(SECOND)]);
    assert_eq!(orders[0].get("remaining"), Some(&Json::str("1")));
    assert_eq!(orders[1].get("remaining"), Some(&Json::str("2")));
    let seq = |o: &Json| match o.get("sequence") {
        Some(Json::Number(n)) => *n,
        other => panic!("sequence is not a number: {other:?}"),
    };
    assert!(seq(&orders[0]) < seq(&orders[1]));
    assert_ne!(l3.get("asks"), l2.get("asks"));
    assert!(!l3.raw.contains("maker-a"));
    assert!(!l3.raw.contains("maker-b"));
    assert!(orders[0].get("accountId").is_none());

    let ident = l3.get("makerIdentity");
    assert_eq!(ident.get("accepted"), Some(&Json::Bool(false)));
    assert_eq!(
        ident.get("rejected").and_then(|r| r.get("code")),
        Some(&Json::str("maker_identity_unpublished"))
    );
    assert_eq!(ident.get("identity"), Some(&Json::Null));
    let l4 = l3.get("l4");
    assert_eq!(l4.get("accepted"), Some(&Json::Bool(false)));
    assert_eq!(
        l4.get("rejected").and_then(|r| r.get("code")),
        Some(&Json::str("l4_unpublished"))
    );
    assert!(l4.get("level").is_none());
    assert_no_json_numbers(l3.get("asks"), "$.asks");
    assert_no_json_numbers(l3.get("bids"), "$.bids");
}

#[test]
fn l3_router_depth_stays_l2_even_with_format_l3() {
    let door = two_rests();
    let res = get(
        &door,
        &format!("/markets/{MARKET}/depth?limit=50&format=l3"),
    );
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.get("asks"), &ladder(&[("100", "3")]));
    assert_ne!(res.body.get("level"), Some(&Json::str("L3")));
    assert!(arr(res.get("asks"))[0].get("orders").is_none());
}

#[test]
fn l3_router_a_never_traded_market_is_404_with_no_invented_l3_levels() {
    let (door, _) = mount();
    let ghost = "NEVER-TRADED-L3";
    let res = get(&door, &format!("/markets/{ghost}/depth/l3?limit=2"));
    assert_eq!(res.status, 404, "{}", res.raw);
    assert_eq!(res.text("code"), "MarketNotFound");
    assert_eq!(res.text("message"), user_copy("matching.market_not_found"));
    assert!(!res.has("bids"));
    assert!(!res.has("asks"));
    assert!(!door.engine().has_market(ghost));
    assert!(door.engine().markets().is_empty());
}

#[test]
fn l3_router_an_empty_native_queue_is_honest_empty_l3() {
    let door = traded_out();
    let l2 = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(l2.status, 200, "{}", l2.raw);
    let l3 = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=2"));
    assert_eq!(l3.status, 200, "{}", l3.raw);
    assert_eq!(l3.text("level"), "L3");
    assert_eq!(l3.get("bids"), &Json::Array(Vec::new()));
    assert_eq!(l3.get("asks"), &Json::Array(Vec::new()));
}

// ── l3-limit-unset-refuse.test.ts ───────────────────────────────────────

#[test]
fn l3_limit_reuses_the_l2_1_to_500_window_never_a_third_cap() {
    assert_eq!(published_limit("2"), Some(2));
    assert_eq!(published_limit("50"), Some(50));
    assert_eq!(published_limit("501"), None);
    // `parsePublicL2QueryLimit(undefined)`: no `limit` at all refuses at the door (next test).
}

#[test]
fn l3_limit_omitted_refuses_the_named_code_and_reads_no_queue() {
    let door = two_rests();
    let before = kinds(&door);
    let res = get(&door, &format!("/markets/{MARKET}/depth/l3"));
    assert_eq!(res.status, 400, "{}", res.raw);
    assert_eq!(
        res.body,
        Json::obj([
            ("code", Json::str("matching.l3_depth_limit_unset")),
            (
                "message",
                Json::str(user_copy("matching.l3_depth_limit_unset"))
            ),
        ])
    );
    assert!(!res.raw.contains(FIRST));
    assert_eq!(kinds(&door), before);
}

#[test]
fn l3_limit_empty_zero_501_and_text_refuse_with_no_invented_50() {
    let door = two_rests();
    for q in ["?limit=", "?limit=0", "?limit=501", "?limit=nope"] {
        let res = get(&door, &format!("/markets/{MARKET}/depth/l3{q}"));
        assert_eq!(res.status, 400, "{q}: {}", res.raw);
        assert_eq!(res.text("code"), "matching.l3_depth_limit_unset", "{q}");
        assert!(!res.has("asks"), "{q}");
    }
}

#[test]
fn l3_limit_published_2_slices_the_native_l3_queue() {
    let (door, _) = mount();
    place_ok(&door, FIRST, "maker-a", "sell", "1", "100");
    place_ok(&door, SECOND, "maker-b", "sell", "1", "101");
    place_ok(&door, THIRD, "maker-c", "sell", "1", "102");
    let all = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=500"));
    assert_eq!(arr(all.get("asks")).len(), 3);

    let res = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.text("level"), "L3");
    let asks = arr(res.get("asks"));
    assert_eq!(asks.len(), 2);
    assert_eq!(asks, &arr(all.get("asks"))[..2]);
    let prices: Vec<&Json> = asks.iter().map(|l| l.get("price").unwrap()).collect();
    assert_eq!(prices, vec![&Json::str("100"), &Json::str("101")]);
    assert_eq!(res.get("bids"), &Json::Array(Vec::new()));
}

#[test]
fn l3_limit_an_empty_book_with_a_published_limit_is_200_empty_arrays_not_404() {
    let door = traded_out();
    let res = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=2"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.text("level"), "L3");
    assert_eq!(res.get("bids"), &Json::Array(Vec::new()));
    assert_eq!(res.get("asks"), &Json::Array(Vec::new()));
}

// ── sbe.router.test.ts ──────────────────────────────────────────────────

fn refuses_sbe(res: &Answer) {
    assert_eq!(res.status, 409, "{}", res.raw);
    assert_eq!(res.text("code"), "matching.sbe_unavailable");
    assert_eq!(res.text("reason"), "sbe_unavailable");
    assert!(!res.has("bids"));
    assert!(!res.has("asks"));
    assert!(!res.raw.contains("\"bids\""));
    assert!(!res.raw.contains("DepthLevel:"));
}

#[test]
fn sbe_router_depth_without_format_stays_json_l2() {
    let door = seeded();
    let res = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.get("bids"), &ladder(&[("100", "1")]));
    assert_eq!(res.get("asks"), &ladder(&[("101", "1")]));
}

#[test]
fn sbe_router_format_sbe_without_an_encoder_refuses_and_serves_no_json_bids() {
    let door = seeded();
    let res = get(
        &door,
        &format!("/markets/{MARKET}/depth?limit=50&format=sbe"),
    );
    refuses_sbe(&res);
    let copy = user_copy("matching.sbe_unavailable");
    // `expect(userCopy('matching.sbe_unavailable')).toBeTruthy()`: the copy the TypeScript catalog resolves to.
    assert!(!copy.is_empty());
    assert_eq!(res.text("message"), copy);
}

#[test]
fn sbe_router_depth_sbe_refuses_and_never_serves_a_utf8_marker_as_sbe() {
    let door = seeded();
    refuses_sbe(&get(
        &door,
        &format!("/markets/{MARKET}/depth/sbe?limit=50"),
    ));
}

#[test]
fn sbe_router_a_never_traded_market_sbe_is_404_not_an_invented_binary_book() {
    let (door, _) = mount();
    let ghost = "NEVER-TRADED-SBE";
    let res = get(
        &door,
        &format!("/markets/{ghost}/depth?limit=50&format=sbe"),
    );
    assert_eq!(res.status, 404, "{}", res.raw);
    assert_eq!(res.text("code"), "MarketNotFound");
    assert!(!door.engine().has_market(ghost));
}

// ── sbe-l2.test.ts ──────────────────────────────────────────────────────

/// `encodeMatchingL2Sbe` over an unlinked codec: here the door's whole answer, which names the code and nothing else.
#[test]
fn sbe_l2_an_unlinked_encoder_refuses_sbe_unavailable_rather_than_emitting_json() {
    let door = seeded();
    let res = get(&door, &format!("/markets/{MARKET}/depth/sbe?limit=50"));
    refuses_sbe(&res);
    let keys: Vec<&str> = match &res.body {
        Json::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
        other => panic!("not an object: {}", other.compact()),
    };
    assert_eq!(keys, vec!["code", "reason", "message"]);
}

/// `wantsMatchingSbe`: `format=sbe` is the SBE ask; `format=l3` and no format are not.
#[test]
fn sbe_l2_format_sbe_is_the_sbe_ask_other_formats_are_not() {
    let door = seeded();
    refuses_sbe(&get(
        &door,
        &format!("/markets/{MARKET}/depth?limit=50&format=sbe"),
    ));
    for url in [
        format!("/markets/{MARKET}/depth?limit=50&format=l3"),
        format!("/markets/{MARKET}/depth?limit=50"),
    ] {
        let res = get(&door, &url);
        assert_eq!(res.status, 200, "{url}: {}", res.raw);
        assert_eq!(res.get("bids"), &ladder(&[("100", "1")]), "{url}");
    }
}
