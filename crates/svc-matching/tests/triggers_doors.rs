//! The `triggers` slice's doors, proven with the TypeScript's own router tests ported test for test:
//! `stop-limit.router.test.ts`, `trailing-stop.router.test.ts`, `trailing-mark.router.test.ts` and
//! `oco.router.test.ts` (all under `services/svc-matching/src/`). Each module is one file; each test is named after the
//! `it` it ports.
//!
//! Every request goes through the whole door (`MatchingDoor::decide`): signed as `serviceAuthHeadersForBody` signs it
//! (svc-trade, the body bound), its input checked, then served by the engine. A body the TypeScript builds with an
//! `undefined` field leaves that field out, as `JSON.stringify` does; a `null` field is sent as `null`.
//!
//! The TypeScript engines run without a clock (`snapshotEvery: 0`, no `clock`): records are stamped with a fixed time
//! here and the expiry clock is off, as there. `trailing-mark`'s halt is `engine.halt(...)`, a venue-slice call this port
//! does not serve: the market is halted the way the Rust engine reads it, its `halt` record appended to the journal and
//! the engine recovered from it (as `tests/engine_calls.rs` switches a mode). Its restart is a fresh engine on the same
//! journal, recovered (`mount(first.journal)` then `recover()`).
//!
//! Nothing is left unported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::{Digest as _, Sha256};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC-USDT";
/// The door's clock and the signatures' time: 2026-11-19T00:00:00.000Z.
const NOW_SECONDS: i64 = 1_795_046_400;

fn now_ms() -> i64 {
    NOW_SECONDS * 1000
}

// ── the engine and the door ─────────────────────────────────────────────

/// `new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 })`.
fn engine_on(journal: MemoryJournal) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(MemoryEventBus::default()),
        clock: now_ms,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    })
}

/// `registerRoutes(app, engine, SECRET, { bodyBind: 'require' })`.
fn door_on(engine: MatchingEngine, secret: &str) -> MatchingDoor {
    MatchingDoor::new(
        DoorConfig {
            internal_secret: secret.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: None,
            edge_key: None,
            clock: now_ms,
            approvals: Box::new(svc_matching::approval::Unwired),
            operator_ids: Vec::new(),
        },
        engine,
    )
    .unwrap()
}

/// `mount()`: a fresh engine on a fresh journal.
fn mount(secret: &str) -> MatchingDoor {
    door_on(engine_on(MemoryJournal::new()), secret)
}

/// The door's journal, copied record for record.
fn copy_journal(door: &MatchingDoor) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in door.engine().journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

fn jlen(door: &MatchingDoor) -> usize {
    door.engine().journal().len()
}

fn kinds(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

// ── requests ────────────────────────────────────────────────────────────

/// One answer: its status, its exact body, and the body read.
struct Answer {
    status: u16,
    body: String,
    json: Json,
}

/// `app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) })`, signed by svc-trade when `signed`.
fn post_to(door: &MatchingDoor, secret: &str, url: &str, body: &Json, signed: bool) -> Answer {
    let payload = body.compact();
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if signed {
        headers.extend(s2s::legacy_headers("svc-trade", secret, &payload, NOW_SECONDS).unwrap());
    }
    let outcome = door.decide(&Request {
        method: "POST",
        url,
        headers: &headers,
        body: &payload,
    });
    match outcome {
        Outcome::Answer(r) => Answer {
            status: r.status,
            json: json::parse(&r.body).unwrap_or(Json::Null),
            body: r.body,
        },
        Outcome::Owed(slice) => panic!("{url} is owed by {}", slice.name()),
    }
}

/// `{ ...base, ...over }`: a field set to `None` is `undefined`, left out of the body.
fn with(base: &Json, over: &[(&str, Option<Json>)]) -> Json {
    let Json::Object(mut fields) = base.clone() else {
        panic!("a body is an object")
    };
    for (k, v) in over {
        let at = fields.iter().position(|(name, _)| name == k);
        match (at, v) {
            (Some(i), Some(v)) => fields[i].1 = v.clone(),
            (Some(i), None) => {
                fields.remove(i);
            }
            (None, Some(v)) => fields.push(((*k).to_owned(), v.clone())),
            (None, None) => {}
        }
    }
    Json::Object(fields)
}

fn s(v: &str) -> Option<Json> {
    Some(Json::str(v))
}

fn null() -> Option<Json> {
    Some(Json::Null)
}

/// `createMarketLifecycleAdmissionProof({ ... BTC-USDT OPEN ... }, 'PLACE')` observed at `observed_at`.
fn proof_for(observed_at: &str) -> Json {
    let snapshot = Json::obj([
        ("marketId", Json::str(MARKET)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(MARKET)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(observed_at)),
        ("observedAt", Json::str(observed_at)),
        ("lastGoodState", Json::str("OPEN")),
        (
            "allowedActions",
            Json::Array(vec![Json::str("PLACE"), Json::str("PLACE_POST_ONLY")]),
        ),
        ("transitionId", Json::str("test.transition")),
        (
            "evidenceRefs",
            Json::Array(vec![Json::str("test.evidence")]),
        ),
    ]);
    let hex: String = Sha256::digest(snapshot.compact().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Json::obj([
        ("action", Json::str("PLACE")),
        ("decision", Json::str("ELIGIBLE")),
        ("checkedAt", Json::str(observed_at)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        (
            "evidenceRefs",
            Json::Array(vec![Json::str("test.evidence")]),
        ),
        ("snapshot", snapshot),
    ])
}

// ── reads ───────────────────────────────────────────────────────────────

fn field<'a>(j: &'a Json, path: &[&str]) -> &'a Json {
    let mut at = j;
    for k in path {
        at = match (at, k.parse::<usize>()) {
            (Json::Array(v), Ok(i)) => v.get(i).unwrap_or_else(|| panic!("no [{i}] in {j:?}")),
            _ => at
                .get(k)
                .unwrap_or_else(|| panic!("no {k} in {}", j.compact())),
        };
    }
    at
}

fn boolean(j: &Json, path: &[&str]) -> bool {
    match field(j, path) {
        Json::Bool(b) => *b,
        other => panic!("{path:?} is a boolean: {other:?}"),
    }
}

fn text(j: &Json, path: &[&str]) -> String {
    match field(j, path) {
        Json::String(s) => s.clone(),
        other => panic!("{path:?} is text: {other:?}"),
    }
}

fn arr(j: &Json, k: &str) -> Vec<Json> {
    match j.get(k) {
        Some(Json::Array(v)) => v.clone(),
        other => panic!("{k} is an array: {other:?}"),
    }
}

/// `engine.book(MARKET).toState()`: the TypeScript makes an empty book for a market it has none of.
fn state(door: &MatchingDoor) -> Json {
    door.engine().existing_book(MARKET).map_or_else(
        || {
            Json::obj([
                ("bids", Json::Array(Vec::new())),
                ("asks", Json::Array(Vec::new())),
                ("stops", Json::Array(Vec::new())),
            ])
        },
        svc_matching::book::order_book::OrderBook::to_state,
    )
}

fn stops(door: &MatchingDoor) -> Vec<Json> {
    arr(&state(door), "stops")
}

/// `engine.depth(MARKET, 50)!.<side>`: the depth must exist.
fn depth_side(door: &MatchingDoor, bids: bool) -> usize {
    let depth = door
        .engine()
        .depth(MARKET, 50)
        .expect("engine.depth(MARKET, 50) is not null");
    if bids {
        depth.bids.len()
    } else {
        depth.asks.len()
    }
}

/// `engine.depth(MARKET, 50)?.<side> ?? []`.
fn depth_side_or_empty(door: &MatchingDoor, bids: bool) -> usize {
    door.engine()
        .depth(MARKET, 50)
        .map_or(0, |d| if bids { d.bids.len() } else { d.asks.len() })
}

// ── stop-limit.router.test.ts ───────────────────────────────────────────

mod stop_limit {
    use super::*;

    const SECRET: &str = "matching-stop-limit-router-secret-32ch";

    fn submit_body(over: &[(&str, Option<Json>)]) -> Json {
        let base = Json::obj([
            ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
            ("accountId", Json::str("desk")),
            ("type", Json::str("stop_limit")),
            ("side", Json::str("buy")),
            ("qty", Json::str("2")),
            ("price", Json::str("106")),
            ("stopPx", Json::str("105")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof_for("2026-08-24T16:00:00.000Z")),
        ]);
        with(&base, over)
    }

    fn post(door: &MatchingDoor, body: &Json) -> Answer {
        post_to(
            door,
            SECRET,
            &format!("/markets/{MARKET}/orders"),
            body,
            true,
        )
    }

    #[test]
    fn rests_off_the_book_only_the_stop_book_holds_it() {
        let door = mount(SECRET);
        let res = post(&door, &submit_body(&[]));
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(text(&res.json, &["resting", "kind"]), "stop");
        assert_eq!(depth_side(&door, true), 0);
        assert_eq!(text(&stops(&door)[0], &["stopPrice"]), "105");
    }

    #[test]
    fn a_print_that_reaches_stop_px_puts_the_leftover_on_the_book() {
        let door = mount(SECRET);
        post(
            &door,
            &submit_body(&[
                ("orderId", s("11111111-1111-4111-8111-111111111111")),
                ("accountId", s("mm")),
                ("type", s("limit")),
                ("side", s("sell")),
                ("qty", s("2")),
                ("price", s("100")),
                ("stopPx", None),
            ]),
        );
        post(
            &door,
            &submit_body(&[
                ("orderId", s("22222222-2222-4222-8222-222222222222")),
                ("accountId", s("warm")),
                ("type", s("market")),
                ("side", s("buy")),
                ("qty", s("2")),
                ("price", None),
                ("stopPx", None),
            ]),
        );
        post(
            &door,
            &submit_body(&[
                ("orderId", s("33333333-3333-4333-8333-333333333333")),
                ("accountId", s("mm")),
                ("type", s("limit")),
                ("side", s("sell")),
                ("qty", s("10")),
                ("price", s("106")),
                ("stopPx", None),
            ]),
        );
        post(
            &door,
            &submit_body(&[("orderId", s("44444444-4444-4444-8444-444444444444"))]),
        );
        let trigger = post(
            &door,
            &submit_body(&[
                ("orderId", s("55555555-5555-4555-8555-555555555555")),
                ("accountId", s("taker")),
                ("type", s("market")),
                ("side", s("buy")),
                ("qty", s("1")),
                ("price", None),
                ("stopPx", None),
            ]),
        );
        assert_eq!(trigger.status, 200, "{}", trigger.body);
        assert_eq!(
            text(&trigger.json, &["triggered", "0", "orderId"]),
            "44444444-4444-4444-8444-444444444444",
            "{}",
            trigger.body
        );
        assert_eq!(stops(&door).len(), 0);
    }

    #[test]
    fn missing_stop_px_refuses_no_invented_trigger() {
        let door = mount(SECRET);
        let res = post(
            &door,
            &submit_body(&[("stopPx", None), ("stopPrice", None)]),
        );
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(!boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(text(&res.json, &["rejected", "code"]), "missing_stop_price");
        assert_eq!(depth_side_or_empty(&door, true), 0);
    }
}

// ── trailing-stop.router.test.ts ────────────────────────────────────────

mod trailing_stop {
    use super::*;

    const SECRET: &str = "matching-trailing-stop-router-secret-32ch";

    fn submit_body(over: &[(&str, Option<Json>)]) -> Json {
        let base = Json::obj([
            ("orderId", Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
            ("accountId", Json::str("desk")),
            ("type", Json::str("stop")),
            ("side", Json::str("sell")),
            ("qty", Json::str("2")),
            ("tif", Json::str("GTC")),
            ("trail", Json::str("5")),
            ("mark", Json::str("100")),
            ("lifecycleProof", proof_for("2026-08-25T16:00:00.000Z")),
        ]);
        with(&base, over)
    }

    fn post(door: &MatchingDoor, body: &Json) -> Answer {
        post_to(
            door,
            SECRET,
            &format!("/markets/{MARKET}/orders"),
            body,
            true,
        )
    }

    #[test]
    fn rests_off_the_book_only_the_stop_book_holds_it_at_mark_minus_trail() {
        let door = mount(SECRET);
        let res = post(&door, &submit_body(&[]));
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(text(&res.json, &["resting", "kind"]), "stop");
        assert_eq!(depth_side(&door, false), 0);
        assert_eq!(text(&stops(&door)[0], &["stopPrice"]), "95");
    }

    #[test]
    fn missing_trail_refuses_no_invented_distance() {
        let door = mount(SECRET);
        let res = post(&door, &submit_body(&[("trail", null())]));
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(!boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(text(&res.json, &["rejected", "code"]), "missing_trail");
        assert_eq!(depth_side_or_empty(&door, false), 0);
    }

    #[test]
    fn missing_mark_refuses_no_invented_mark() {
        let door = mount(SECRET);
        let res = post(&door, &submit_body(&[("mark", null())]));
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(!boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(text(&res.json, &["rejected", "code"]), "missing_mark");
        assert_eq!(stops(&door).len(), 0);
    }
}

// ── trailing-mark.router.test.ts ────────────────────────────────────────

mod trailing_mark {
    use super::*;

    const SECRET: &str = "matching-trailing-mark-router-secret-32chr";
    const SELL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const BUY: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn place(door: &MatchingDoor, over: &[(&str, Option<Json>)]) -> Answer {
        let base = Json::obj([
            ("orderId", Json::str(SELL)),
            ("accountId", Json::str("desk")),
            ("type", Json::str("stop")),
            ("side", Json::str("sell")),
            ("qty", Json::str("2")),
            ("tif", Json::str("GTC")),
            ("trail", Json::str("5")),
            ("mark", Json::str("100")),
            ("lifecycleProof", proof_for("2026-08-25T16:00:00.000Z")),
        ]);
        post_to(
            door,
            SECRET,
            &format!("/markets/{MARKET}/orders"),
            &with(&base, over),
            true,
        )
    }

    fn mark_on(door: &MatchingDoor, value: Json, market: &str) -> Answer {
        post_to(
            door,
            SECRET,
            &format!("/markets/{market}/mark"),
            &Json::obj([("mark", value)]),
            true,
        )
    }

    fn mark(door: &MatchingDoor, value: &str) -> Answer {
        mark_on(door, Json::str(value), MARKET)
    }

    fn marks(door: &MatchingDoor) -> usize {
        kinds(door).iter().filter(|k| *k == "mark").count()
    }

    fn stop_of(door: &MatchingDoor, order_id: &str) -> String {
        let found = stops(door)
            .into_iter()
            .find(|s| text(s, &["orderId"]) == order_id)
            .unwrap_or_else(|| panic!("no stop {order_id}"));
        text(&found, &["stopPrice"])
    }

    const MOVED: &str = r#"{"accepted":true,"applied":true,"rejected":null}"#;
    const STILL: &str = r#"{"accepted":true,"applied":false,"rejected":null}"#;

    #[test]
    fn walks_a_sell_trailing_stop_up_with_the_mark_and_journals_the_move() {
        let door = mount(SECRET);
        assert!(boolean(&place(&door, &[]).json, &["accepted"]));
        assert_eq!(stop_of(&door, SELL), "95");
        let res = mark(&door, "110");
        assert_eq!(res.status, 200, "{}", res.body);
        assert_eq!(res.body, MOVED);
        assert_eq!(stop_of(&door, SELL), "105");
        assert_eq!(marks(&door), 1);
    }

    #[test]
    fn walks_a_buy_trailing_stop_down_with_the_mark() {
        let door = mount(SECRET);
        let placed = place(
            &door,
            &[("orderId", s(BUY)), ("side", s("buy")), ("mark", s("100"))],
        );
        assert!(boolean(&placed.json, &["accepted"]), "{}", placed.body);
        assert_eq!(stop_of(&door, BUY), "105");
        assert!(boolean(&mark(&door, "90").json, &["applied"]));
        assert_eq!(stop_of(&door, BUY), "95");
    }

    #[test]
    fn a_lower_mark_does_not_walk_the_stop_back_and_writes_nothing() {
        let door = mount(SECRET);
        place(&door, &[]);
        mark(&door, "110");
        let before = jlen(&door);
        let res = mark(&door, "90");
        assert_eq!(res.body, STILL);
        assert_eq!(stop_of(&door, SELL), "105");
        assert_eq!(jlen(&door), before);
    }

    #[test]
    fn the_same_mark_twice_changes_and_journals_nothing_the_second_time() {
        let door = mount(SECRET);
        place(&door, &[]);
        mark(&door, "110");
        let before = jlen(&door);
        let again = mark(&door, "110");
        assert!(!boolean(&again.json, &["applied"]), "{}", again.body);
        assert_eq!(stop_of(&door, SELL), "105");
        assert_eq!(jlen(&door), before);
    }

    #[test]
    fn a_restart_replays_the_journaled_marks_to_the_same_trigger_and_the_same_peak() {
        let first = mount(SECRET);
        place(&first, &[]);
        mark(&first, "110");
        mark(&first, "120");
        assert_eq!(stop_of(&first, SELL), "115");

        let mut engine = engine_on(copy_journal(&first));
        engine.recover().unwrap();
        let second = door_on(engine, SECRET);
        assert_eq!(stop_of(&second, SELL), "115");
        // The peak survived: a lower mark after the restart still does not walk it back.
        assert!(!boolean(&mark(&second, "100").json, &["applied"]));
        assert_eq!(stop_of(&second, SELL), "115");
        // And a higher one still ratchets from the replayed peak.
        assert!(boolean(&mark(&second, "130").json, &["applied"]));
        assert_eq!(stop_of(&second, SELL), "125");
    }

    #[test]
    fn refuses_a_blank_malformed_or_zero_mark_the_engine_never_invents_one() {
        let door = mount(SECRET);
        place(&door, &[]);
        let before = jlen(&door);
        for bad in [
            Json::str(""),
            Json::str("abc"),
            Json::str("-5"),
            Json::str("1e3"),
            Json::int(110),
        ] {
            let res = mark_on(&door, bad.clone(), MARKET);
            assert_eq!(res.status, 400, "{} answered {}", bad.compact(), res.body);
        }
        let zero = mark(&door, "0");
        assert_eq!(zero.status, 200, "{}", zero.body);
        // toMatchObject({ accepted: false, applied: false, rejected: { code: 'missing_mark' } }).
        assert!(!boolean(&zero.json, &["accepted"]), "{}", zero.body);
        assert!(!boolean(&zero.json, &["applied"]), "{}", zero.body);
        assert_eq!(text(&zero.json, &["rejected", "code"]), "missing_mark");
        let empty = post_to(
            &door,
            SECRET,
            &format!("/markets/{MARKET}/mark"),
            &Json::Object(Vec::new()),
            true,
        );
        assert_eq!(empty.status, 400, "{}", empty.body);
        assert_eq!(stop_of(&door, SELL), "95");
        assert_eq!(jlen(&door), before);
    }

    #[test]
    fn refuses_on_a_halted_market_and_moves_nothing() {
        let placed = mount(SECRET);
        place(&placed, &[]);
        // `engine.halt(MARKET, { operatorId: 'op-a', confirmOperatorId: 'op-b' })`: the record it journals.
        let mut journal = copy_journal(&placed);
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("halt")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-11-19T00:00:00.000Z")),
                ("operatorId", Json::str("op-a")),
                ("confirmOperatorId", Json::str("op-b")),
            ])))
            .unwrap();
        let mut engine = engine_on(journal);
        engine.recover().unwrap();
        assert!(engine.flags(MARKET).halted, "the market is halted");
        let door = door_on(engine, SECRET);
        let before = jlen(&door);
        let res = mark(&door, "110");
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(!boolean(&res.json, &["accepted"]), "{}", res.body);
        assert!(!boolean(&res.json, &["applied"]), "{}", res.body);
        assert_eq!(stop_of(&door, SELL), "95");
        assert_eq!(jlen(&door), before);
    }

    #[test]
    fn a_market_with_no_book_accepts_the_mark_and_does_nothing() {
        let door = mount(SECRET);
        let res = mark_on(&door, Json::str("110"), "ETH-USDT");
        assert_eq!(res.body, STILL);
        assert_eq!(jlen(&door), 0);
    }

    #[test]
    fn a_plain_resting_stop_no_trail_is_not_moved_by_a_mark() {
        let door = mount(SECRET);
        let placed = place(
            &door,
            &[
                ("trail", None),
                ("mark", None),
                ("stopPrice", s("95")),
                ("price", null()),
            ],
        );
        assert_eq!(placed.status, 200, "{}", placed.body);
        let before = jlen(&door);
        assert!(!boolean(&mark(&door, "200").json, &["applied"]));
        assert_eq!(jlen(&door), before);
        assert!(
            stops(&door)
                .iter()
                .all(|s| text(s, &["stopPrice"]) != "195")
        );
    }

    #[test]
    fn an_unsigned_request_is_refused() {
        let door = mount(SECRET);
        let res = post_to(
            &door,
            SECRET,
            &format!("/markets/{MARKET}/mark"),
            &Json::obj([("mark", Json::str("110"))]),
            false,
        );
        assert!([401, 403].contains(&res.status), "{}", res.status);
        assert_eq!(jlen(&door), 0);
    }
}

// ── oco.router.test.ts ──────────────────────────────────────────────────

mod oco {
    use super::*;

    const SECRET: &str = "matching-iceberg-router-secret-32char";
    const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn submit_body(over: &[(&str, Option<Json>)]) -> Json {
        let base = Json::obj([
            ("orderId", Json::str(ID)),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("sell")),
            ("qty", Json::str("10")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof_for("2026-08-24T16:00:00.000Z")),
        ]);
        with(&base, over)
    }

    fn post(door: &MatchingDoor, body: &Json) -> Answer {
        post_to(
            door,
            SECRET,
            &format!("/markets/{MARKET}/orders"),
            body,
            true,
        )
    }

    fn yes() -> Option<Json> {
        Some(Json::Bool(true))
    }

    #[test]
    fn carries_take_profit_and_stop_loss_to_the_engine_one_submit_rests_both_legs_linked() {
        let door = mount(SECRET);
        let res = post(
            &door,
            &submit_body(&[
                ("oco", yes()),
                ("takeProfit", s("110")),
                ("stopLoss", s("90")),
                ("price", s("110")),
            ]),
        );
        assert_eq!(res.status, 200, "{}", res.body);
        assert!(boolean(&res.json, &["accepted"]), "{}", res.body);
        let st = state(&door);
        assert_eq!(
            text(&st, &["asks", "0", "orders", "0", "orderId"]),
            format!("{ID}:tp")
        );
        assert_eq!(text(&st, &["asks", "0", "price"]), "110");
        let legs: Vec<(String, String)> = arr(&st, "stops")
            .iter()
            .map(|s| (text(s, &["orderId"]), text(s, &["stopPrice"])))
            .collect();
        assert_eq!(legs, vec![(format!("{ID}:sl"), "90".to_owned())]);
    }

    #[test]
    fn refuses_a_missing_leg_with_a_typed_rejection_and_rests_nothing() {
        let door = mount(SECRET);
        let overs: [&[(&str, Option<Json>)]; 3] = [
            &[("oco", yes()), ("takeProfit", s("110"))],
            &[("oco", yes()), ("stopLoss", s("90"))],
            &[("oco", yes())],
        ];
        for over in overs {
            let res = post(&door, &submit_body(over));
            assert_eq!(res.status, 200, "{}", res.body);
            assert!(!boolean(&res.json, &["accepted"]), "{}", res.body);
            assert_eq!(
                text(&res.json, &["rejected", "code"]),
                "missing_stop_price",
                "{}",
                res.body
            );
        }
        assert!(arr(&state(&door), "asks").is_empty());
        assert!(arr(&state(&door), "stops").is_empty());
    }

    #[test]
    fn an_explicit_null_leg_on_a_plain_order_is_not_an_oco() {
        let door = mount(SECRET);
        let res = post(
            &door,
            &submit_body(&[("takeProfit", null()), ("stopLoss", null())]),
        );
        assert!(boolean(&res.json, &["accepted"]), "{}", res.body);
        assert_eq!(
            text(&state(&door), &["asks", "0", "orders", "0", "orderId"]),
            ID
        );
    }
}
