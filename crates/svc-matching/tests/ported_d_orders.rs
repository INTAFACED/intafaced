//! The order door's money tests of the TypeScript service, ported test for test against the real door over a real
//! engine (`MatchingDoor::decide`, as `tests/door_auth.rs` drives it):
//!
//! - `h8c.router.test.ts`: a submit answered 200 and then retried after svc-trade died neither rests twice nor fills
//!   twice, on the live process and on one started cold from the same file journal; replay invents no cancel.
//! - `lifecycle-proof.test.ts`: a submit whose lifecycle admission proof is missing or does not hold refuses 400 before
//!   any record, book or event; a valid proof is journalled whole and survives a restart; a legacy record without one
//!   still replays.
//!
//! Where the Rust differs: the TypeScript replays with `replay(journal.read())` while the journal is still open. A
//! `FileJournal` holds its file's one writer lock, so here the door is dropped (its journal closed, as
//! `journal.close()`) and a fresh engine is started cold on the same file (`recover`, which is `replay` over every
//! record); the book it rebuilds is the one read. The TypeScript's `recover()` returns `{ records, markets }`, which is
//! `Recovered` here.
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
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::Recovered;
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::env::parse_operator_ids;
use svc_matching::journal::JournalCommand;
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
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

impl Bus {
    fn published(&self) -> Vec<Published> {
        self.0.lock().unwrap().clone()
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

fn arr(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not an array: {}", other.compact()),
    }
}

const OBSERVED_AT: &str = "2026-08-24T16:00:00.000Z";
const ALLOWED: &[&str] = &["PLACE", "PLACE_POST_ONLY"];

/// A fresh directory under the system's temporary one (`mkdtempSync`).
fn temp_journal(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("engine.ndjson")
}

/// A door over a fresh engine on the file journal at `path`, started cold on what the file holds.
fn mount_file(path: &std::path::Path) -> (MatchingDoor, Bus, Recovered) {
    let bus = Bus::default();
    let mut engine = engine_on(Box::new(FileJournal::open(path).unwrap()), bus.clone());
    let recovered = engine.recover().unwrap();
    (door_over(engine), bus, recovered)
}

/// `diskKinds(path)`: each line's `kind`, read off the file itself.
fn disk_kinds(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| match json::parse(l).unwrap().get("kind") {
            Some(Json::String(k)) => k.clone(),
            other => panic!("a record without a kind: {other:?}"),
        })
        .collect()
}

/// `replay(journal.read()).get(MARKET).toState()`: the book a cold start on the file rebuilds.
fn replayed_state(path: &std::path::Path) -> Json {
    let (door, _, _) = mount_file(path);
    let engine = door.engine();
    engine.existing_book(MARKET).unwrap().to_state()
}

fn ask_ids(state: &Json) -> Vec<Json> {
    let asks = arr(state.get("asks").unwrap());
    arr(asks[0].get("orders").unwrap())
        .iter()
        .map(|o| o.get("orderId").unwrap().clone())
        .collect()
}

fn is_text(v: Option<&Json>) -> bool {
    matches!(v, Some(Json::String(_)))
}

fn signed_list(door: &MatchingDoor) -> Answer {
    send(
        door,
        "GET",
        &format!("/markets/{MARKET}/orders?limit=100"),
        "",
        &signed(""),
    )
}

fn refused_duplicate(res: &Answer) {
    assert_eq!(res.status, 200, "{}", res.raw);
    assert_eq!(res.get("accepted"), &Json::Bool(false), "{}", res.raw);
    assert_eq!(
        res.get("rejected").get("code"),
        Some(&Json::str("duplicate_order_id")),
        "{}",
        res.raw
    );
    assert_eq!(res.get("fills"), &Json::Array(Vec::new()));
    assert_eq!(res.get("resting"), &Json::Null);
}

// ── h8c.router.test.ts ──────────────────────────────────────────────────

mod h8c {
    use super::*;

    const REST: &str = "11111111-1111-4111-8111-111111111111";
    const TAKE: &str = "22222222-2222-4222-8222-222222222222";
    const ASK: &str = "33333333-3333-4333-8333-333333333333";
    const ASK2: &str = "44444444-4444-4444-8444-444444444444";

    /// `proofFor('PLACE')` of the H8c test: observed 2026-09-03, allowing AMEND too.
    fn body(order_id: &str, account: &str, side: &str, qty: &str, price: &str) -> String {
        let proof = proof_of(
            snapshot(
                MARKET,
                &["PLACE", "PLACE_POST_ONLY", "AMEND"],
                "2026-09-03T16:00:00.000Z",
            ),
            "PLACE",
        );
        Json::obj([
            ("orderId", Json::str(order_id)),
            ("accountId", Json::str(account)),
            ("type", Json::str("limit")),
            ("side", Json::str(side)),
            ("qty", Json::str(qty)),
            ("price", Json::str(price)),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof),
        ])
        .compact()
    }

    fn submit(door: &MatchingDoor, payload: &str) -> Answer {
        post(door, &format!("/markets/{MARKET}/orders"), payload)
    }

    #[test]
    fn http_200_rest_then_trade_death_a_retry_of_the_same_id_does_not_double_live() {
        let path = temp_journal("matching-h8c-submit-200-");
        {
            let (door, _, _) = mount_file(&path);
            let placed = submit(&door, &body(REST, "desk", "sell", "1.5", "100"));
            assert_eq!(placed.status, 200, "{}", placed.raw);
            assert_eq!(placed.get("accepted"), &Json::Bool(true));
            let resting = placed.get("resting");
            assert_eq!(resting.get("remaining"), Some(&Json::str("1.5")));
            assert_eq!(resting.get("price"), Some(&Json::str("100")));

            let retry = submit(&door, &body(REST, "other", "sell", "9", "50"));
            refused_duplicate(&retry);

            let listed = signed_list(&door);
            assert_eq!(listed.status, 200, "{}", listed.raw);
            let orders = arr(listed.get("orders"));
            assert_eq!(orders.len(), 1);
            assert_eq!(orders[0].get("orderId"), Some(&Json::str(REST)));
            assert_eq!(orders[0].get("remaining"), Some(&Json::str("1.5")));
            assert_eq!(orders[0].get("price"), Some(&Json::str("100")));
            assert!(is_text(orders[0].get("remaining")) && is_text(orders[0].get("price")));

            assert_eq!(disk_kinds(&path), vec!["submit"]);
            // `app.close(); liveJournal.close()`: dropping the door closes its journal.
        }
        assert!(!disk_kinds(&path).iter().any(|k| k == "cancel"));
        assert_eq!(ask_ids(&replayed_state(&path)), vec![Json::str(REST)]);
    }

    #[test]
    fn http_200_fill_then_trade_death_a_retry_of_the_same_id_does_not_emit_a_duplicate_fill() {
        let path = temp_journal("matching-h8c-submit-200-");
        {
            let (live, _, _) = mount_file(&path);
            assert_eq!(
                submit(&live, &body(ASK, "mm", "sell", "1", "100")).status,
                200
            );
            assert_eq!(
                submit(&live, &body(ASK2, "mm2", "sell", "1", "100")).status,
                200
            );

            let filled = submit(&live, &body(TAKE, "taker", "buy", "1", "100"));
            assert_eq!(filled.status, 200, "{}", filled.raw);
            assert_eq!(filled.get("accepted"), &Json::Bool(true));
            let fills = arr(filled.get("fills"));
            assert_eq!(fills.len(), 1);
            assert_eq!(fills[0].get("makerOrderId"), Some(&Json::str(ASK)));
            assert_eq!(fills[0].get("takerOrderId"), Some(&Json::str(TAKE)));
            assert_eq!(fills[0].get("qty"), Some(&Json::str("1")));
            assert_eq!(fills[0].get("price"), Some(&Json::str("100")));
            assert_eq!(filled.get("resting"), &Json::Null);
        }

        {
            let (recovered, recovery_bus, _) = mount_file(&path);
            let announced = recovery_bus.published().len();
            let retry = submit(&recovered, &body(TAKE, "taker", "buy", "1", "100"));
            refused_duplicate(&retry);
            // The refused retry announces nothing past what the cold start announced again.
            assert_eq!(recovery_bus.published().len(), announced);

            let listed = signed_list(&recovered);
            assert_eq!(listed.status, 200, "{}", listed.raw);
            let orders = arr(listed.get("orders"));
            assert_eq!(orders.len(), 1);
            assert_eq!(orders[0].get("orderId"), Some(&Json::str(ASK2)));
            assert_eq!(orders[0].get("remaining"), Some(&Json::str("1")));
            assert_eq!(orders[0].get("price"), Some(&Json::str("100")));
            assert!(is_text(orders[0].get("remaining")) && is_text(orders[0].get("price")));
        }

        assert_eq!(disk_kinds(&path), vec!["submit", "submit", "submit"]);
        assert!(!disk_kinds(&path).iter().any(|k| k == "cancel"));
        let state = replayed_state(&path);
        assert_eq!(ask_ids(&state), vec![Json::str(ASK2)]);
        assert_eq!(state.get("acceptedOrderIds"), Some(&strs(&[TAKE, ASK])));
    }
}

// ── lifecycle-proof.test.ts ─────────────────────────────────────────────

mod lifecycle_proof {
    use super::*;

    const ORDER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const LEGACY: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn set(obj: &Json, key: &str, value: Json) -> Json {
        let Json::Object(fields) = obj else {
            panic!("not an object")
        };
        let mut fields = fields.clone();
        match fields.iter_mut().find(|(k, _)| k == key) {
            Some((_, slot)) => *slot = value,
            None => fields.push((key.to_owned(), value)),
        }
        Json::Object(fields)
    }

    /// `body(over)`: a GTC limit buy of 1 at 100 with its PLACE proof; `None` leaves a field out.
    fn body(over: &[(&str, Option<Json>)]) -> String {
        let mut b = Json::obj([
            ("orderId", Json::str(ORDER)),
            ("accountId", Json::str("acct-a")),
            ("type", Json::str("limit")),
            ("side", Json::str("buy")),
            ("qty", Json::str("1")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof_for(MARKET, "PLACE")),
        ]);
        for (k, v) in over {
            b = match v {
                Some(v) => set(&b, k, v.clone()),
                None => match b {
                    Json::Object(fields) => {
                        Json::Object(fields.into_iter().filter(|(f, _)| f != k).collect())
                    }
                    other => other,
                },
            };
        }
        b.compact()
    }

    /// `refuses %s before every durable side effect`.
    fn refuses_before_every_durable_side_effect(over: &[(&str, Option<Json>)]) {
        let (door, bus) = mount();
        let res = post(&door, &format!("/markets/{MARKET}/orders"), &body(over));
        assert_eq!(res.status, 400, "{}", res.raw);
        assert_eq!(res.text("code"), "BadRequest");
        assert_eq!(door.engine().journal().len(), 0);
        assert!(door.engine().markets().is_empty());
        assert!(bus.published().is_empty());
    }

    fn proof_with(key: &str, value: Json) -> Option<Json> {
        Some(set(&proof_for(MARKET, "PLACE"), key, value))
    }

    #[test]
    fn refuses_a_missing_proof_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[("lifecycleProof", None)]);
    }

    #[test]
    fn refuses_a_bad_snapshot_hash_before_every_durable_side_effect() {
        let tampered = set(
            &snapshot(MARKET, ALLOWED, OBSERVED_AT),
            "reasonCode",
            Json::str("tampered.reason"),
        );
        refuses_before_every_durable_side_effect(&[(
            "lifecycleProof",
            proof_with("snapshot", tampered),
        )]);
    }

    #[test]
    fn refuses_a_wrong_market_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[(
            "lifecycleProof",
            Some(proof_for("ETH-USDT", "PLACE")),
        )]);
    }

    #[test]
    fn refuses_the_wrong_action_for_po_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[
            ("tif", Some(Json::str("PO"))),
            ("lifecycleProof", Some(proof_for(MARKET, "PLACE"))),
        ]);
    }

    #[test]
    fn refuses_a_disallowed_action_before_every_durable_side_effect() {
        let narrowed = set(
            &snapshot(MARKET, ALLOWED, OBSERVED_AT),
            "allowedActions",
            strs(&["PLACE"]),
        );
        let proof = set(&proof_for(MARKET, "PLACE_POST_ONLY"), "snapshot", narrowed);
        refuses_before_every_durable_side_effect(&[("lifecycleProof", Some(proof))]);
    }

    #[test]
    fn refuses_checked_at_tampering_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[(
            "lifecycleProof",
            proof_with("checkedAt", Json::str("2026-08-24T16:00:01.000Z")),
        )]);
    }

    #[test]
    fn refuses_evidence_tampering_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[(
            "lifecycleProof",
            proof_with("evidenceRefs", strs(&["tampered-evidence"])),
        )]);
    }

    #[test]
    fn refuses_transition_tampering_before_every_durable_side_effect() {
        refuses_before_every_durable_side_effect(&[(
            "lifecycleProof",
            proof_with("transitionId", Json::str("tampered-transition")),
        )]);
    }

    fn journalled_proof(door: &MatchingDoor) -> Option<Json> {
        let engine = door.engine();
        let first = engine.journal().read().first().cloned().unwrap();
        assert_eq!(first.kind(), Some("submit"));
        first
            .0
            .get("order")
            .and_then(|o| o.get("lifecycleProof"))
            .cloned()
    }

    #[test]
    fn persists_the_full_validated_proof_matches_normally_and_recovers_after_restart() {
        let path = temp_journal("matching-lifecycle-proof-");
        let proof = proof_for(MARKET, "PLACE");
        {
            let (first, first_bus, _) = mount_file(&path);
            let accepted = post(
                &first,
                &format!("/markets/{MARKET}/orders"),
                &body(&[("lifecycleProof", Some(proof.clone()))]),
            );
            assert_eq!(accepted.status, 200, "{}", accepted.raw);
            assert_eq!(accepted.get("accepted"), &Json::Bool(true));
            assert_eq!(
                accepted.get("resting").get("orderId"),
                Some(&Json::str(ORDER))
            );
            assert_eq!(journalled_proof(&first), Some(proof.clone()));
            assert_eq!(first_bus.published().len(), 1);
        }

        let (restarted, replay_bus, recovered) = mount_file(&path);
        assert_eq!(
            recovered,
            Recovered {
                records: 1,
                markets: 1
            }
        );
        assert_eq!(journalled_proof(&restarted), Some(proof));
        let resting = restarted.engine().resting_orders(None);
        assert_eq!(resting.len(), 1);
        assert_eq!(resting[0].to_json().get("orderId"), Some(&Json::str(ORDER)));
        assert!(replay_bus.published().is_empty());
    }

    #[test]
    fn replays_legacy_submit_records_with_the_proof_absent() {
        let mut journal = MemoryJournal::new();
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("submit")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str(OBSERVED_AT)),
                (
                    "order",
                    Json::obj([
                        ("orderId", Json::str(LEGACY)),
                        ("accountId", Json::str("acct-legacy")),
                        ("type", Json::str("limit")),
                        ("side", Json::str("sell")),
                        ("qty", Json::str("1")),
                        ("price", Json::str("101")),
                        ("stopPrice", Json::Null),
                        ("tif", Json::str("GTC")),
                    ]),
                ),
            ])))
            .unwrap();
        let mut restarted = engine_on(Box::new(journal), Bus::default());
        assert_eq!(
            restarted.recover().unwrap(),
            Recovered {
                records: 1,
                markets: 1
            }
        );
        let door = door_over(restarted);
        assert_eq!(journalled_proof(&door), None);
        let resting = door.engine().resting_orders(None);
        assert_eq!(resting.len(), 1);
        assert_eq!(
            resting[0].to_json().get("orderId"),
            Some(&Json::str(LEGACY))
        );
    }
}
