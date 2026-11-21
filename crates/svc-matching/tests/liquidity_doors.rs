//! The `liquidity` slice's doors, ported test for test from the TypeScript router tests under
//! `services/svc-matching/src/`: `iceberg.router.test.ts`, `peg.router.test.ts`, `aon.router.test.ts`,
//! `ifm.router.test.ts`, `auction.router.test.ts` and `mass-quote.router.test.ts`. Each test is named after its
//! TypeScript `it`, prefixed with the file's topic. Requests go through `MatchingDoor::decide`, signed as svc-trade with
//! the body bound, as `tests/wire_replay.rs` signs them; the lifecycle proof is made here as
//! `createMarketLifecycleAdmissionProof` makes it (the snapshot in its schema's key order, its id the SHA-256 of that
//! snapshot's JSON). The TypeScript `engine.book(MARKET).toState()` is the engine's book, or an empty one when the
//! engine holds none; `replay(records)` is a cold start over a copy of the same journal.
//!
//! Where the port differs, by test:
//! - The TypeScript's distinct secret per file is one secret here: the secret is not what these tests prove.
//! - `ifm.router.test.ts`'s `CrashAfterInFlight` throws from the journal's `append`; here the journal refuses the
//!   record of that kind the same way (`Crash`), and the door answers the engine's error. `crashHttp` accepts a status
//!   of 500 or more or a thrown error; a Rust door cannot throw, so only the status is checked. `persistInFlight(row)`
//!   is `row.inFlight === true`, checked on the row read from disk.
//! - `mass-quote.router.test.ts`'s `watchSubmits` replaces `engine.submit` to see each proof; nothing can replace an
//!   engine method in Rust. What it saw is read where the engine wrote it: each `submit` record's
//!   `order.lifecycleProof` in the journal, so `seen` is those proofs and its length their count. `seen[1]` being the
//!   very object `seen[0]` is (`toBe`) is object identity, which has no meaning for journalled JSON; the two are
//!   checked equal instead.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::path::{Path, PathBuf};

use service_kit::json::{self, Json};
use service_kit::money::format_amount;
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::{Digest, Sha256};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::JournalError;
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::{JournalCommand, JournalRecord};
use svc_matching::journal::replay::MemorySnapshotSink;

const SECRET: &str = "matching-liquidity-doors-secret-at-least-32";
const MARKET: &str = "BTC-USDT";
/// 2026-11-19T00:00:00.000Z.
const NOW_SECONDS: i64 = 1_795_046_400;
const IN_FLIGHT_UNKNOWN: &str = "in_flight_unknown";
const QUOTE_PAIR_REJECTED: &str = "quote_pair_rejected";
const QUOTE_PAIR_INCOMPLETE: &str = "quote_pair_incomplete";
const QUOTE_SET_MISSING: &str = "quote_set_missing";
const MMP_UNPUBLISHED: &str = "mmp_unpublished";
const MMP_SIDECAR_REFUSED: &str = "mmp_sidecar_refused";

fn now_ms() -> i64 {
    NOW_SECONDS * 1000
}

// ── the proof ───────────────────────────────────────────────────────────

fn strs(list: &[&str]) -> Json {
    Json::Array(list.iter().map(|s| Json::str(*s)).collect())
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)` for an OPEN market, `checkedAt` its `observedAt`.
fn proof(market: &str, observed_at: &str, allowed: &[&str], action: &str) -> Json {
    let snapshot = Json::obj([
        ("marketId", Json::str(market)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(market)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(observed_at)),
        ("observedAt", Json::str(observed_at)),
        ("lastGoodState", Json::str("OPEN")),
        ("allowedActions", strs(allowed)),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
    ]);
    let hex: String = Sha256::digest(snapshot.compact().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Json::obj([
        ("action", Json::str(action)),
        ("decision", Json::str("ELIGIBLE")),
        ("checkedAt", Json::str(observed_at)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// The iceberg, peg, AON and auction files' `proofFor()`.
fn place_proof(observed_at: &str) -> Json {
    proof(MARKET, observed_at, &["PLACE", "PLACE_POST_ONLY"], "PLACE")
}

// ── bodies ──────────────────────────────────────────────────────────────

/// `{ ...base, ...over }` as `JSON.stringify` writes it: an override keeps its key's place, a new key goes last, and
/// `None` is `undefined` (the key is dropped).
fn merged(base: Json, over: Vec<(&str, Option<Json>)>) -> Json {
    let Json::Object(mut fields) = base else {
        panic!("a body is an object")
    };
    for (k, v) in over {
        match (fields.iter().position(|(f, _)| f == k), v) {
            (Some(i), Some(v)) => fields[i].1 = v,
            (Some(i), None) => {
                fields.remove(i);
            }
            (None, Some(v)) => fields.push((k.to_owned(), v)),
            (None, None) => {}
        }
    }
    Json::Object(fields)
}

fn s(v: &str) -> Option<Json> {
    Some(Json::str(v))
}

fn yes() -> Option<Json> {
    Some(Json::Bool(true))
}

fn no() -> Option<Json> {
    Some(Json::Bool(false))
}

// ── the door ────────────────────────────────────────────────────────────

fn engine_on(journal: Box<dyn EngineJournal + Send>) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(MemoryEventBus::default()),
        clock: now_ms,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
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
            // These doors spend no approval: unwired, and nobody on the operator list, as the TypeScript mounts them.
            approvals: Box::new(svc_matching::approval::Unwired),
            operator_ids: Vec::new(),
        },
        engine,
    )
    .unwrap()
}

/// `mount()`: an engine over a journal in memory.
fn mount() -> MatchingDoor {
    door_over(engine_on(Box::new(MemoryJournal::new())))
}

/// One answer: its status and its body read as JSON.
struct Res {
    status: u16,
    body: Json,
}

/// `app.inject`, signed as svc-trade over the exact payload when `signed`.
fn send(door: &MatchingDoor, method: &str, url: &str, body: Option<&Json>, signed: bool) -> Res {
    let payload = body.map(Json::compact).unwrap_or_default();
    let mut headers = if signed {
        s2s::legacy_headers("svc-trade", SECRET, &payload, NOW_SECONDS).unwrap()
    } else {
        Vec::new()
    };
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    match door.decide(&Request {
        method,
        url,
        headers: &headers,
        body: &payload,
    }) {
        Outcome::Answer(r) => Res {
            status: r.status,
            body: json::parse(&r.body).unwrap_or(Json::Null),
        },
        Outcome::Owed(slice) => panic!("{method} {url} is owed by {}", slice.name()),
    }
}

fn post_order(door: &MatchingDoor, body: &Json) -> Res {
    send(
        door,
        "POST",
        &format!("/markets/{MARKET}/orders"),
        Some(body),
        true,
    )
}

/// The value at a dotted path (`fills.0.qty`), or none when any step is missing.
fn at<'a>(j: &'a Json, path: &str) -> Option<&'a Json> {
    path.split('.').try_fold(j, |cur, step| match cur {
        Json::Array(items) => step.parse::<usize>().ok().and_then(|i| items.get(i)),
        other => other.get(step),
    })
}

fn text_at(j: &Json, path: &str) -> String {
    match at(j, path) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{path} is not text: {other:?}"),
    }
}

fn bool_at(j: &Json, path: &str) -> bool {
    match at(j, path) {
        Some(Json::Bool(b)) => *b,
        other => panic!("{path} is not a boolean: {other:?}"),
    }
}

fn list_at<'a>(j: &'a Json, path: &str) -> &'a [Json] {
    match at(j, path) {
        Some(Json::Array(items)) => items,
        other => panic!("{path} is not a list: {other:?}"),
    }
}

fn is_null(j: &Json, path: &str) -> bool {
    matches!(at(j, path), Some(Json::Null))
}

/// `engine.book(MARKET).toState()`: the book, or an empty one.
fn book_state(door: &MatchingDoor) -> Json {
    door.engine().existing_book(MARKET).map_or_else(
        || {
            Json::obj([
                ("bids", Json::Array(Vec::new())),
                ("asks", Json::Array(Vec::new())),
            ])
        },
        svc_matching::book::order_book::OrderBook::to_state,
    )
}

/// `engine.depth(MARKET, 50)?.asks ?? []`, as decimal strings.
fn depth_asks(door: &MatchingDoor) -> Vec<(String, String)> {
    door.engine()
        .depth(MARKET, 50)
        .map(|d| {
            d.asks
                .iter()
                .map(|(p, q)| (format_amount(*p), format_amount(*q)))
                .collect()
        })
        .unwrap_or_default()
}

fn pair(p: &str, q: &str) -> (String, String) {
    (p.to_owned(), q.to_owned())
}

// ── iceberg.router.test.ts ──────────────────────────────────────────────

fn iceberg_body(over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("sell")),
            ("qty", Json::str("10")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("displayQty", Json::str("2")),
            ("lifecycleProof", place_proof("2026-08-24T16:00:00.000Z")),
        ]),
        over,
    )
}

#[test]
fn iceberg_rests_with_only_the_display_qty_visible() {
    let door = mount();
    let res = post_order(&door, &iceberg_body(vec![]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "resting.remaining"), "10");
    assert_eq!(depth_asks(&door), vec![pair("100", "2")]);
    let state = book_state(&door);
    assert_eq!(text_at(&state, "asks.0.orders.0.displayQty"), "2");
    assert_eq!(text_at(&state, "asks.0.orders.0.remaining"), "10");
}

#[test]
fn iceberg_a_take_larger_than_display_does_not_invent_hidden_fills() {
    let door = mount();
    post_order(
        &door,
        &iceberg_body(vec![
            ("orderId", s("11111111-1111-4111-8111-111111111111")),
            ("accountId", s("mm")),
        ]),
    );
    let take = post_order(
        &door,
        &iceberg_body(vec![
            ("orderId", s("22222222-2222-4222-8222-222222222222")),
            ("side", s("buy")),
            ("qty", s("8")),
            ("displayQty", None),
            ("iceberg", None),
        ]),
    );
    assert_eq!(take.status, 200);
    assert!(bool_at(&take.body, "accepted"));
    assert_eq!(list_at(&take.body, "fills").len(), 1);
    assert_eq!(text_at(&take.body, "fills.0.qty"), "2");
    assert_eq!(
        text_at(&book_state(&door), "asks.0.orders.0.remaining"),
        "8"
    );
    assert_eq!(
        depth_asks(&door).first().map(|l| l.1.clone()).as_deref(),
        Some("2")
    );
}

#[test]
fn iceberg_missing_display_refuses_no_invented_display() {
    let door = mount();
    let res = post_order(
        &door,
        &iceberg_body(vec![("displayQty", None), ("iceberg", yes())]),
    );
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(
        text_at(&res.body, "rejected.code"),
        "iceberg_display_missing"
    );
    assert_eq!(depth_asks(&door), Vec::new());
}

#[test]
fn iceberg_display_not_smaller_than_total_refuses() {
    let door = mount();
    let res = post_order(&door, &iceberg_body(vec![("displayQty", s("10"))]));
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(
        text_at(&res.body, "rejected.code"),
        "iceberg_display_not_smaller"
    );
}

// ── peg.router.test.ts ──────────────────────────────────────────────────

fn buy_body(observed_at: &str, over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("buy")),
            ("qty", Json::str("10")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", place_proof(observed_at)),
        ]),
        over,
    )
}

const PEG_AT: &str = "2026-08-25T16:00:00.000Z";

fn peg_body(over: Vec<(&str, Option<Json>)>) -> Json {
    buy_body(PEG_AT, over)
}

fn maker_sell(qty: &str) -> Vec<(&'static str, Option<Json>)> {
    vec![
        ("orderId", s("11111111-1111-4111-8111-111111111111")),
        ("accountId", s("mm")),
        ("side", s("sell")),
        ("qty", s(qty)),
    ]
}

#[test]
fn peg_missing_flags_are_a_normal_order_no_invented_reference() {
    let door = mount();
    post_order(&door, &peg_body(maker_sell("2")));
    let res = post_order(&door, &peg_body(vec![("qty", s("10"))]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "fills.0.qty"), "2");
}

#[test]
fn peg_peg_true_without_reference_plus_offset_refuses_no_rest_as_a_limit() {
    let door = mount();
    let res = post_order(&door, &peg_body(vec![("peg", yes())]));
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "missing_reference");
    assert!(list_at(&res.body, "fills").is_empty());
    assert!(is_null(&res.body, "resting"));
    assert!(list_at(&book_state(&door), "bids").is_empty());
}

#[test]
fn peg_peg_true_with_reference_plus_offset_takes_at_that_price() {
    let door = mount();
    let mut maker = maker_sell("2");
    maker.push(("price", s("101")));
    post_order(&door, &peg_body(maker));
    let res = post_order(
        &door,
        &peg_body(vec![
            ("peg", yes()),
            ("reference", s("100")),
            ("offset", s("1")),
            ("qty", s("10")),
        ]),
    );
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "fills.0.qty"), "2");
    assert_eq!(text_at(&res.body, "fills.0.price"), "101");
    assert_eq!(text_at(&res.body, "resting.price"), "101");
}

#[test]
fn peg_relative_true_with_a_signed_offset_rests_at_reference_plus_offset() {
    let door = mount();
    let res = post_order(
        &door,
        &peg_body(vec![
            ("relative", yes()),
            ("reference", s("100")),
            ("offset", s("-1")),
            ("qty", s("3")),
        ]),
    );
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert!(list_at(&res.body, "fills").is_empty());
    assert_eq!(text_at(&res.body, "resting.price"), "99");
    assert_eq!(text_at(&book_state(&door), "bids.0.price"), "99");
}

#[test]
fn peg_midpoint_true_refuses_no_invented_mid() {
    let door = mount();
    let res = post_order(&door, &peg_body(vec![("midpoint", yes())]));
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "midpoint_unsupported");
    assert!(list_at(&res.body, "fills").is_empty());
    assert!(list_at(&book_state(&door), "bids").is_empty());
}

#[test]
fn peg_relative_true_without_offset_refuses() {
    let door = mount();
    let res = post_order(
        &door,
        &peg_body(vec![("relative", yes()), ("reference", s("100"))]),
    );
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "missing_offset");
}

// ── aon.router.test.ts ──────────────────────────────────────────────────

fn aon_body(over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("buy")),
            ("qty", Json::str("10")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("aon", Json::Bool(true)),
            ("lifecycleProof", place_proof(PEG_AT)),
        ]),
        over,
    )
}

fn aon_maker(qty: &str) -> Vec<(&'static str, Option<Json>)> {
    let mut over = maker_sell(qty);
    over.push(("aon", None));
    over
}

#[test]
fn aon_rests_with_aon_a_smaller_opposite_does_not_take_a_stub() {
    let door = mount();
    let ask = post_order(&door, &aon_body(aon_maker("2")));
    assert_eq!(ask.status, 200);
    assert!(bool_at(&ask.body, "accepted"));

    let res = post_order(&door, &aon_body(vec![]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert!(list_at(&res.body, "fills").is_empty());
    assert_eq!(text_at(&res.body, "resting.remaining"), "10");
    let state = book_state(&door);
    assert_eq!(text_at(&state, "asks.0.orders.0.remaining"), "2");
    assert!(bool_at(&state, "bids.0.orders.0.aon"));
}

#[test]
fn aon_fills_when_the_sweep_covers_remaining() {
    let door = mount();
    post_order(&door, &aon_body(aon_maker("10")));
    let res = post_order(&door, &aon_body(vec![]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(list_at(&res.body, "fills").len(), 1);
    assert_eq!(text_at(&res.body, "fills.0.qty"), "10");
    assert!(is_null(&res.body, "resting"));
}

#[test]
fn aon_missing_aon_is_a_normal_order_no_invented_all_or_none() {
    let door = mount();
    post_order(&door, &aon_body(aon_maker("2")));
    let res = post_order(&door, &aon_body(vec![("aon", None), ("qty", s("10"))]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "fills.0.qty"), "2");
}

#[test]
fn aon_iceberg_plus_aon_refuses_no_invented_fill() {
    let door = mount();
    let res = post_order(
        &door,
        &aon_body(vec![
            ("side", s("sell")),
            ("iceberg", yes()),
            ("displayQty", s("2")),
        ]),
    );
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "aon_iceberg");
    assert!(list_at(&res.body, "fills").is_empty());
    assert!(list_at(&book_state(&door), "asks").is_empty());
}

// ── auction.router.test.ts ──────────────────────────────────────────────

fn auction_body(over: Vec<(&str, Option<Json>)>) -> Json {
    buy_body(PEG_AT, over)
}

#[test]
fn auction_missing_flags_are_a_normal_order_no_invented_auction_price() {
    let door = mount();
    post_order(&door, &auction_body(maker_sell("2")));
    let res = post_order(&door, &auction_body(vec![("qty", s("10"))]));
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "fills.0.qty"), "2");
}

#[test]
fn auction_auction_true_refuses_no_rest_as_a_limit() {
    let door = mount();
    let res = post_order(&door, &auction_body(vec![("auction", yes())]));
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "auction_unsupported");
    assert!(list_at(&res.body, "fills").is_empty());
    assert!(is_null(&res.body, "resting"));
    assert!(list_at(&book_state(&door), "bids").is_empty());
}

#[test]
fn auction_benchmark_true_refuses_no_invented_benchmark_price() {
    let door = mount();
    let res = post_order(&door, &auction_body(vec![("benchmark", yes())]));
    assert_eq!(res.status, 200);
    assert!(!bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "rejected.code"), "benchmark_unsupported");
    assert!(list_at(&res.body, "fills").is_empty());
    assert!(list_at(&book_state(&door), "bids").is_empty());
}

#[test]
fn auction_auction_false_benchmark_false_is_a_normal_order() {
    let door = mount();
    post_order(&door, &auction_body(maker_sell("2")));
    let res = post_order(
        &door,
        &auction_body(vec![("auction", no()), ("benchmark", no())]),
    );
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "accepted"));
    assert_eq!(text_at(&res.body, "fills.0.qty"), "2");
}

// ── ifm.router.test.ts ──────────────────────────────────────────────────

const REST: &str = "11111111-1111-4111-8111-111111111111";
const ASK: &str = "33333333-3333-4333-8333-333333333333";
const TAKE: &str = "22222222-2222-4222-8222-222222222222";
const IFM_AT: &str = "2026-09-03T16:00:00.000Z";

/// `CrashAfterInFlight`: the `in_flight` record is durable, then the journal refuses the record of kind `boom_on`.
struct Crash {
    inner: FileJournal,
    boom_on: &'static str,
}

impl EngineJournal for Crash {
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        if command.0.get("kind") == Some(&Json::str(self.boom_on)) {
            return Err(JournalError::IoUnknown);
        }
        self.inner.append(command)
    }
    fn read(&self) -> &[JournalRecord] {
        self.inner.read()
    }
    fn len(&self) -> usize {
        self.inner.len()
    }
    fn close(&mut self) -> Result<(), JournalError> {
        self.inner.close()
    }
}

fn ifm_proof(action: &str) -> Json {
    proof(
        MARKET,
        IFM_AT,
        &["PLACE", "PLACE_POST_ONLY", "AMEND"],
        action,
    )
}

fn ifm_body(over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("orderId", Json::str(REST)),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("sell")),
            ("qty", Json::str("1.5")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", ifm_proof("PLACE")),
        ]),
        over,
    )
}

fn tmp_journal() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "matching-h8e-ifm-http-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("engine.ndjson")
}

fn order_url(id: &str) -> String {
    format!("/markets/{MARKET}/orders/{id}")
}

fn del(door: &MatchingDoor, id: &str) -> Res {
    send(door, "DELETE", &order_url(id), None, true)
}

fn patch(door: &MatchingDoor, id: &str, body: &Json) -> Res {
    send(door, "PATCH", &order_url(id), Some(body), true)
}

fn get_orders(door: &MatchingDoor) -> Res {
    send(
        door,
        "GET",
        &format!("/markets/{MARKET}/orders?limit=100"),
        None,
        true,
    )
}

/// `crashHttp`: the crashed call answers 500 or more.
fn crash_http(res: &Res) {
    assert!(
        res.status >= 500,
        "the crash answers 500 or more: {} {:?}",
        res.status,
        res.body
    );
}

fn disk_rows(path: &Path) -> Vec<Json> {
    std::fs::read_to_string(path)
        .unwrap()
        .trim()
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| json::parse(line).unwrap())
        .collect()
}

fn kind_of(row: &Json) -> String {
    text_at(row, "kind")
}

/// `persistInFlight(record)`: `record.inFlight === true`.
fn persist_in_flight(row: &Json) -> bool {
    matches!(row.get("inFlight"), Some(Json::Bool(true)))
}

/// A cold start over the journal at `path`, opened again.
fn recovered(path: &Path) -> MatchingEngine {
    let mut engine = engine_on(Box::new(FileJournal::open(path).unwrap()));
    engine.recover().unwrap();
    engine
}

/// `replay(records)`: a cold start over a copy of the same records.
fn replay(records: &[JournalRecord]) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for r in records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut engine = engine_on(Box::new(journal));
    engine.recover().unwrap();
    engine
}

fn has_kind(engine: &MatchingEngine, kind: &str) -> bool {
    engine
        .journal()
        .read()
        .iter()
        .any(|r| r.kind() == Some(kind))
}

#[test]
fn ifm_http_cancel_crash_after_in_flight_journal_refuses_further_mutation_and_does_not_invent_a_cancel()
 {
    let path = tmp_journal();
    {
        let live = door_over(engine_on(Box::new(Crash {
            inner: FileJournal::open(&path).unwrap(),
            boom_on: "cancel",
        })));
        let placed = post_order(&live, &ifm_body(vec![]));
        assert_eq!(placed.status, 200);
        assert!(bool_at(&placed.body, "accepted"));
        assert_eq!(text_at(&placed.body, "resting.remaining"), "1.5");
        assert!(matches!(
            at(&placed.body, "resting.remaining"),
            Some(Json::String(_))
        ));
        assert!(matches!(
            at(&placed.body, "resting.price"),
            Some(Json::String(_))
        ));

        crash_http(&del(&live, REST));
    }

    // `recovered.recover()` appends nothing: the length before is the journal as opened.
    let length_before = FileJournal::open(&path).unwrap().len();
    let engine = recovered(&path);
    assert_eq!(engine.journal().len(), length_before);
    assert!(!has_kind(&engine, "cancel"));
    let records: Vec<JournalRecord> = engine.journal().read().to_vec();

    let door = door_over(engine);

    let cancelled = del(&door, REST);
    assert_eq!(cancelled.status, 200);
    assert!(!bool_at(&cancelled.body, "cancelled"));
    assert_eq!(text_at(&cancelled.body, "orderId"), REST);
    assert!(is_null(&cancelled.body, "cancellation"));
    assert_eq!(text_at(&cancelled.body, "rejected.code"), IN_FLIGHT_UNKNOWN);

    let amended = patch(
        &door,
        REST,
        &Json::obj([
            ("expectedVersion", Json::Number(1.0)),
            ("qty", Json::str("1")),
            ("lifecycleProof", ifm_proof("AMEND")),
        ]),
    );
    assert_eq!(amended.status, 200);
    assert!(!bool_at(&amended.body, "accepted"));
    assert_eq!(text_at(&amended.body, "rejected.code"), IN_FLIGHT_UNKNOWN);
    assert!(list_at(&amended.body, "fills").is_empty());
    assert!(is_null(&amended.body, "resting"));

    let second = post_order(
        &door,
        &ifm_body(vec![
            ("accountId", s("other")),
            ("qty", s("9")),
            ("price", s("50")),
        ]),
    );
    assert_eq!(second.status, 200);
    assert!(!bool_at(&second.body, "accepted"));
    assert_eq!(text_at(&second.body, "rejected.code"), IN_FLIGHT_UNKNOWN);
    assert!(list_at(&second.body, "fills").is_empty());
    assert!(is_null(&second.body, "resting"));

    let listed = get_orders(&door);
    assert_eq!(listed.status, 200);
    assert_eq!(list_at(&listed.body, "orders").len(), 1);
    assert_eq!(text_at(&listed.body, "orders.0.orderId"), REST);
    assert_eq!(text_at(&listed.body, "orders.0.remaining"), "1.5");
    assert_eq!(text_at(&listed.body, "orders.0.price"), "100");
    assert!(matches!(
        at(&listed.body, "orders.0.remaining"),
        Some(Json::String(_))
    ));
    assert!(matches!(
        at(&listed.body, "orders.0.price"),
        Some(Json::String(_))
    ));

    let on_disk = disk_rows(&path);
    assert_eq!(
        on_disk.iter().map(kind_of).collect::<Vec<_>>(),
        ["submit", "in_flight"]
    );
    assert_eq!(text_at(&on_disk[0], "order.qty"), "1.5");
    assert!(bool_at(&on_disk[1], "inFlight"));
    assert_eq!(text_at(&on_disk[1], "qty"), "1.5");
    assert!(persist_in_flight(&on_disk[1]));

    let books = replay(&records);
    let state = books.existing_book(MARKET).unwrap().to_state();
    let orders = list_at(&state, "asks.0.orders");
    assert_eq!(
        orders
            .iter()
            .map(|o| text_at(o, "orderId"))
            .collect::<Vec<_>>(),
        [REST]
    );
    assert_eq!(orders.len(), 1);
}

#[test]
fn ifm_http_amend_crash_window_does_not_emit_a_duplicate_fill() {
    let path = tmp_journal();
    {
        let live = door_over(engine_on(Box::new(Crash {
            inner: FileJournal::open(&path).unwrap(),
            boom_on: "amend",
        })));
        let ask = post_order(
            &live,
            &ifm_body(vec![
                ("orderId", s(ASK)),
                ("accountId", s("mm")),
                ("qty", s("1")),
                ("price", s("100")),
            ]),
        );
        assert_eq!(ask.status, 200);
        let rest = post_order(
            &live,
            &ifm_body(vec![
                ("orderId", s(REST)),
                ("accountId", s("desk")),
                ("side", s("buy")),
                ("qty", s("1.5")),
                ("price", s("90")),
            ]),
        );
        assert_eq!(rest.status, 200);

        crash_http(&patch(
            &live,
            REST,
            &Json::obj([
                ("expectedVersion", Json::Number(1.0)),
                ("price", Json::str("100")),
                ("lifecycleProof", ifm_proof("AMEND")),
            ]),
        ));
    }

    let engine = recovered(&path);
    assert!(!has_kind(&engine, "amend"));
    assert!(!has_kind(&engine, "cancel"));

    let door = door_over(engine);

    let second_amend = patch(
        &door,
        REST,
        &Json::obj([
            ("expectedVersion", Json::Number(1.0)),
            ("price", Json::str("100")),
            ("lifecycleProof", ifm_proof("AMEND")),
        ]),
    );
    assert_eq!(second_amend.status, 200);
    assert!(!bool_at(&second_amend.body, "accepted"));
    assert_eq!(
        text_at(&second_amend.body, "rejected.code"),
        IN_FLIGHT_UNKNOWN
    );
    assert!(list_at(&second_amend.body, "fills").is_empty());

    let take = post_order(
        &door,
        &ifm_body(vec![
            ("orderId", s(TAKE)),
            ("accountId", s("taker")),
            ("side", s("buy")),
            ("qty", s("1")),
            ("price", s("100")),
        ]),
    );
    assert_eq!(take.status, 200);
    assert!(bool_at(&take.body, "accepted"));
    assert_eq!(list_at(&take.body, "fills").len(), 1);
    assert_eq!(text_at(&take.body, "fills.0.makerOrderId"), ASK);
    assert_eq!(text_at(&take.body, "fills.0.takerOrderId"), TAKE);
    assert_eq!(text_at(&take.body, "fills.0.qty"), "1");
    assert_eq!(text_at(&take.body, "fills.0.price"), "100");
    assert!(matches!(
        at(&take.body, "fills.0.qty"),
        Some(Json::String(_))
    ));
    assert!(matches!(
        at(&take.body, "fills.0.price"),
        Some(Json::String(_))
    ));

    let listed = get_orders(&door);
    assert_eq!(listed.status, 200);
    let mut ids: Vec<String> = list_at(&listed.body, "orders")
        .iter()
        .map(|o| text_at(o, "orderId"))
        .collect();
    ids.sort();
    assert_eq!(ids, [REST]);
    assert_eq!(text_at(&listed.body, "orders.0.orderId"), REST);
    assert_eq!(text_at(&listed.body, "orders.0.remaining"), "1.5");
    assert_eq!(text_at(&listed.body, "orders.0.price"), "90");
    assert!(matches!(
        at(&listed.body, "orders.0.remaining"),
        Some(Json::String(_))
    ));

    let on_disk = disk_rows(&path);
    assert!(on_disk.iter().any(|row| kind_of(row) == "in_flight"
        && persist_in_flight(row)
        && row.get("qty") == Some(&Json::str("1.5"))));
    assert!(!on_disk.iter().any(|row| kind_of(row) == "amend"));
    assert!(!on_disk.iter().any(|row| kind_of(row) == "cancel"));
}

// ── mass-quote.router.test.ts ───────────────────────────────────────────

const SET: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BID: &str = "11111111-1111-4111-8111-111111111111";
const Q_ASK: &str = "22222222-2222-4222-8222-222222222222";
const QUOTE_AT: &str = "2026-09-03T16:00:00.000Z";

fn quote_proof(market: &str, action: &str) -> Json {
    proof(market, QUOTE_AT, &["PLACE", "PLACE_POST_ONLY"], action)
}

fn side(order_id: &str, qty: &str, price: Option<&str>, over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("orderId", Json::str(order_id)),
            ("type", Json::str("limit")),
            ("qty", Json::str(qty)),
            ("price", price.map_or(Json::Null, Json::str)),
            ("tif", Json::str("GTC")),
        ]),
        over,
    )
}

fn quote_body(over: Vec<(&str, Option<Json>)>) -> Json {
    merged(
        Json::obj([
            ("setId", Json::str(SET)),
            ("accountId", Json::str("desk")),
            ("bid", side(BID, "1", Some("99"), vec![])),
            ("ask", side(Q_ASK, "1", Some("101"), vec![])),
            ("lifecycleProof", quote_proof(MARKET, "PLACE")),
        ]),
        over,
    )
}

fn post_quote(door: &MatchingDoor, body: &Json) -> Res {
    send(
        door,
        "POST",
        &format!("/markets/{MARKET}/mass-quote"),
        Some(body),
        true,
    )
}

/// `engine.restingOrders(MARKET).map((row) => row.orderId)`.
fn live_ids(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .resting_orders(Some(MARKET))
        .into_iter()
        .map(|row| row.order_id)
        .collect()
}

/// `journalProofs(journal)`: each submit record's `order.lifecycleProof`, which stands in for `watchSubmits`'s `seen`.
fn journal_proofs(door: &MatchingDoor) -> Vec<Json> {
    door.engine()
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some("submit"))
        .map(|r| {
            at(&r.0, "order.lifecycleProof")
                .cloned()
                .unwrap_or(Json::Null)
        })
        .collect()
}

fn journal_len(door: &MatchingDoor) -> usize {
    door.engine().journal().read().len()
}

fn invented_zero(body: &Json) -> bool {
    let keys = [
        "maxQuote",
        "maxPosition",
        "maxLoss",
        "delta",
        "vega",
        "qty",
        "band",
        "max",
    ];
    keys.iter().any(|k| {
        matches!(body.get(k), Some(Json::Number(n)) if *n == 0.0)
            || body.get(k) == Some(&Json::str("0"))
    })
}

fn statuses(body: &Json) -> Vec<String> {
    list_at(body, "results")
        .iter()
        .map(|row| text_at(row, "status"))
        .collect()
}

fn result_codes(body: &Json) -> Vec<String> {
    list_at(body, "results")
        .iter()
        .map(|row| text_at(row, "rejected.code"))
        .collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn mass_quote_two_sided_set_applies_both_rests_as_decimal_string_qty() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![]));
    assert_eq!(res.status, 200);
    let body = &res.body;
    assert_eq!(text_at(body, "setId"), SET);
    assert!(!bool_at(body, "oneSided"));
    assert!(is_null(body, "rejected"));
    assert_eq!(statuses(body), ["APPLIED", "APPLIED"]);
    assert_eq!(
        sorted(live_ids(&door)),
        sorted(vec![Q_ASK.to_owned(), BID.to_owned()])
    );
    let rows = door.engine().resting_orders(Some(MARKET));
    assert!(rows.iter().all(|row| format_amount(row.remaining) == "1"));
    assert!(matches!(
        rows[0].to_json().get("remaining"),
        Some(Json::String(_))
    ));
}

#[test]
fn mass_quote_ptx_m11_r11_ask_missing_price_unwinds_bid_pair_refused_book_empty() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![("ask", Some(side(Q_ASK, "1", None, vec![])))]),
    );
    assert_eq!(res.status, 200);
    let body = &res.body;
    assert_eq!(text_at(body, "rejected.code"), QUOTE_PAIR_REJECTED);
    assert_eq!(statuses(body), ["REFUSED", "REFUSED"]);
    assert_eq!(
        text_at(body, "results.0.rejected.code"),
        QUOTE_PAIR_REJECTED
    );
    assert_eq!(text_at(body, "results.1.rejected.code"), "missing_price");
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_missing_ask_on_two_sided_refuses_quote_pair_incomplete_nothing_rests() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("ask", Some(Json::Null))]));
    assert_eq!(res.status, 200);
    assert_eq!(text_at(&res.body, "rejected.code"), QUOTE_PAIR_INCOMPLETE);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_empty_set_id_refuses_quote_set_missing_set_id_not_invented() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("setId", s(""))]));
    assert_eq!(res.status, 200);
    assert!(is_null(&res.body, "setId"));
    assert_eq!(text_at(&res.body, "rejected.code"), QUOTE_SET_MISSING);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_mmp_true_with_unset_magnitudes_refuses_unpublished_book_empty_no_invented_0() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("mmp", yes())]));
    assert_eq!(res.status, 200);
    let body = &res.body;
    assert_eq!(text_at(body, "rejected.code"), QUOTE_PAIR_REJECTED);
    assert!(statuses(body).iter().all(|st| st == "REFUSED"));
    assert!(result_codes(body).iter().all(|c| c == MMP_UNPUBLISHED));
    assert!(!invented_zero(body));
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_blank_mmp_max_quote_delta_vega_still_unpublished_never_become_0() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![
            ("mmpMaxQuote", s("")),
            ("mmpMaxDelta", s("")),
            ("mmpMaxVega", s("")),
        ]),
    );
    assert_eq!(res.status, 200);
    let body = &res.body;
    assert!(result_codes(body).iter().all(|c| c == MMP_UNPUBLISHED));
    assert!(!invented_zero(body));
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_stated_mmp_max_quote_decimal_is_still_unpublished_not_a_live_max() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("mmpMaxQuote", s("1"))]));
    assert_eq!(res.status, 200);
    assert_eq!(
        text_at(&res.body, "results.0.rejected.code"),
        MMP_UNPUBLISHED
    );
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_ask_only_mmp_refuses_the_pair_and_unwinds_the_applied_bid() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![(
            "ask",
            Some(side(Q_ASK, "1", Some("101"), vec![("mmp", yes())])),
        )]),
    );
    assert_eq!(res.status, 200);
    let body = &res.body;
    assert_eq!(text_at(body, "rejected.code"), QUOTE_PAIR_REJECTED);
    assert_eq!(
        text_at(body, "results.0.rejected.code"),
        QUOTE_PAIR_REJECTED
    );
    assert_eq!(text_at(body, "results.1.rejected.code"), MMP_UNPUBLISHED);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_sidecar_mm_refuses_mmp_sidecar_refused() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("sidecar", yes())]));
    assert_eq!(res.status, 200);
    assert!(
        result_codes(&res.body)
            .iter()
            .all(|c| c == MMP_SIDECAR_REFUSED)
    );
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_json_number_qty_is_400_amounts_stay_decimal_strings() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![(
            "bid",
            Some(side(
                BID,
                "1",
                Some("99"),
                vec![("qty", Some(Json::Number(1.0)))],
            )),
        )]),
    );
    assert_eq!(res.status, 400);
    assert_eq!(text_at(&res.body, "code"), "BadRequest");
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_json_number_mmp_max_quote_is_400_never_a_live_0() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![("mmpMaxQuote", Some(Json::Number(0.0)))]),
    );
    assert_eq!(res.status, 400);
    assert_eq!(text_at(&res.body, "code"), "BadRequest");
}

#[test]
fn mass_quote_unsigned_request_is_401_engine_never_called() {
    let door = mount();
    let res = send(
        &door,
        "POST",
        &format!("/markets/{MARKET}/mass-quote"),
        Some(&quote_body(vec![])),
        false,
    );
    assert_eq!(res.status, 401);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_forwards_the_parsed_lifecycle_proof_into_each_side_submit() {
    let door = mount();
    let proof = quote_proof(MARKET, "PLACE");
    let res = post_quote(
        &door,
        &quote_body(vec![("lifecycleProof", Some(proof.clone()))]),
    );
    assert_eq!(res.status, 200);
    let seen = journal_proofs(&door);
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0], proof);
    assert_eq!(seen[1], seen[0]);
    assert_eq!(journal_proofs(&door), [seen[0].clone(), seen[0].clone()]);
}

#[test]
fn mass_quote_one_sided_quote_submits_only_the_given_side_with_that_same_proof() {
    let door = mount();
    let proof = quote_proof(MARKET, "PLACE");
    let res = post_quote(
        &door,
        &quote_body(vec![
            ("oneSided", yes()),
            ("ask", Some(Json::Null)),
            ("lifecycleProof", Some(proof.clone())),
        ]),
    );
    assert_eq!(res.status, 200);
    assert!(bool_at(&res.body, "oneSided"));
    let seen = journal_proofs(&door);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0], proof);
    assert_eq!(journal_proofs(&door), [seen[0].clone()]);
    assert_eq!(live_ids(&door), [BID]);
}

#[test]
fn mass_quote_omitting_lifecycle_proof_fails_the_schema_and_does_not_submit() {
    let door = mount();
    let res = post_quote(&door, &quote_body(vec![("lifecycleProof", None)]));
    assert_eq!(res.status, 400);
    assert_eq!(text_at(&res.body, "code"), "BadRequest");
    assert!(issues_of(&res.body).join("\n").contains("lifecycleProof"));
    assert!(journal_proofs(&door).is_empty());
    assert_eq!(journal_len(&door), 0);
    assert!(live_ids(&door).is_empty());
}

fn issues_of(body: &Json) -> Vec<String> {
    list_at(body, "issues")
        .iter()
        .map(|i| match i {
            Json::String(v) => v.clone(),
            other => other.compact(),
        })
        .collect()
}

#[test]
fn mass_quote_a_proof_for_another_market_is_400_and_does_not_quote() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![(
            "lifecycleProof",
            Some(quote_proof("ETH-USDT", "PLACE")),
        )]),
    );
    assert_eq!(res.status, 400);
    assert!(
        issues_of(&res.body).contains(
            &"lifecycleProof.snapshot.marketId: must match the route marketId".to_owned()
        ),
        "{:?}",
        res.body
    );
    assert!(journal_proofs(&door).is_empty());
    assert_eq!(journal_len(&door), 0);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_a_non_place_proof_is_400_and_does_not_quote() {
    let door = mount();
    let res = post_quote(
        &door,
        &quote_body(vec![(
            "lifecycleProof",
            Some(quote_proof(MARKET, "PLACE_POST_ONLY")),
        )]),
    );
    assert_eq!(res.status, 400);
    assert!(
        issues_of(&res.body)
            .contains(&"lifecycleProof.action: must be PLACE for this quote set".to_owned()),
        "{:?}",
        res.body
    );
    assert!(journal_proofs(&door).is_empty());
    assert_eq!(journal_len(&door), 0);
    assert!(live_ids(&door).is_empty());
}

#[test]
fn mass_quote_pair_incomplete_and_missing_set_id_refuse_without_submit() {
    let incomplete = mount();
    let missing_ask = post_quote(&incomplete, &quote_body(vec![("ask", Some(Json::Null))]));
    assert_eq!(missing_ask.status, 200);
    assert_eq!(
        text_at(&missing_ask.body, "rejected.code"),
        QUOTE_PAIR_INCOMPLETE
    );
    assert!(journal_proofs(&incomplete).is_empty());
    assert_eq!(journal_len(&incomplete), 0);

    let missing_set = mount();
    let empty_set = post_quote(&missing_set, &quote_body(vec![("setId", s(""))]));
    assert_eq!(empty_set.status, 200);
    assert_eq!(text_at(&empty_set.body, "rejected.code"), QUOTE_SET_MISSING);
    assert!(journal_proofs(&missing_set).is_empty());
    assert_eq!(journal_len(&missing_set), 0);
}
