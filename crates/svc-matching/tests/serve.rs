//! The `serve` slice's TypeScript tests, ported test for test: `health.router.test.ts`, `operation-latency.test.ts`,
//! `metrics.test.ts` (through the server's routing), `replay-hold.test.ts` (the hold check, the startup publish and the
//! ledger lookup), `replay-hold.boot-wrapper.test.ts`, `expiry-sweep.test.ts` and `shutdown.test.ts`, with `/ready`,
//! which `index.ts` writes inline and no TypeScript test mounts.
//!
//! Not ported, and why:
//! - `health.router.test.ts`'s halt-all and resume-all through the doors: those doors are the `venue` slice's. The
//!   venue halt is read back from a journalled `halt_all` here instead, so `venueHalted` is still read live.
//! - Its source check of `index.ts`, and `metrics.boot.e2e.test.ts`: they read the TypeScript entrypoint's text. Here
//!   the door the binary serves keeps the scrape and the latency itself (`Door::metrics`, `MatchingDoor::decide`), so
//!   there is no separate registration to forget.
//! - `replay-hold.test.ts`'s "halts the market when the bad hold cannot be cancelled": it leaves an `in_flight` record
//!   the journal never resolved, and a cold start stops on that (`PORT.md`: the `liquidity` slice's fence). The halt
//!   is held here through a market in maintenance, where the pull's cancel is refused.
//! - The startup publish tests' engine `startupSleep` is the same seam (`with_startup_sleep`).
//! - `expiry-sweep.test.ts`'s "reports a failed pass and keeps running the next one" and the timer itself: the binary's
//!   sweep is a loop over `expiry_tick` that logs a failed pass and goes on; the pass is tested here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use service_kit::json::{self, Json};
use service_kit::metrics::{DURATION_BUCKETS, PROMETHEUS_CONTENT_TYPE};
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::{App, Door, Request};
use svc_matching::approval::Unwired;
use svc_matching::book::types::{EngineOrder, OrderType, Side, Tif};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::admission::{RestingHoldSubject, STARTUP_PUBLISH_ATTEMPTS};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::holds::{
    BalanceRow, Boot, HOLD_CHECK_UNREACHABLE, Hold, HoldReadError, HoldVerdict, LedgerHolds,
    ReplayHoldLedger, ReplayHoldLookup, UnwiredHolds, balance_rows, enforce_replay_holds,
    open_after_replay, required_hold_amount,
};
use svc_matching::journal::replay::MemorySnapshotSink;
use svc_matching::journal::{EngineJournal, FileJournal, JournalCommand, MemoryJournal};
use svc_matching::status::{Operation, OperationLatency, bounds_ms, operation_of};

const SECRET: &str = "matching-serve-slice-secret-32chars!!";
const MARKET: &str = "BTC/USDT";
const REST: &str = "11111111-1111-4111-8111-111111111111";
const TAKER: &str = "22222222-2222-4222-8222-222222222222";
const MAKER: &str = "33333333-3333-4333-8333-333333333333";
const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAKER_ACCT: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAKER_ACCT: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GTD: &str = "88888888-8888-4888-8888-888888888888";

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────

thread_local! {
    static TICK: Cell<i64> = const { Cell::new(0) };
    static NOW: Cell<i64> = const { Cell::new(0) };
}

/// `fixedClock`: one second later on every read, from 2026-01-01.
fn ticking() -> i64 {
    TICK.with(|t| {
        t.set(t.get() + 1);
        1_767_225_600_000 + t.get() * 1000
    })
}

/// A clock the test moves.
fn settable() -> i64 {
    NOW.with(Cell::get)
}

fn set_now(iso: &str) {
    NOW.with(|n| n.set(service_kit::time::js_date(iso).unwrap().0));
}

fn parts(journal: MemoryJournal, bus: Box<dyn EventBus + Send>, clock: fn() -> i64) -> EngineParts {
    EngineParts {
        journal: Box::new(journal),
        bus,
        clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    }
}

fn engine_on(journal: MemoryJournal) -> MatchingEngine {
    MatchingEngine::new(parts(journal, Box::new(MemoryEventBus::default()), ticking))
        .with_startup_sleep(Box::new(|_| {}))
}

fn order(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        parse_amount(qty).unwrap(),
        Some(parse_amount(price).unwrap()),
        Tif::Gtc,
    )
}

fn copy_journal(engine: &MatchingEngine) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

/// A journal holding one resting buy of 1 at 100.
fn resting_buy() -> MemoryJournal {
    let mut writer = engine_on(MemoryJournal::new());
    let r = writer
        .submit(MARKET, &order(REST, USER, Side::Buy, "1", "100"), None)
        .unwrap();
    assert!(r.accepted);
    writer.finish_startup_announce();
    copy_journal(&writer)
}

/// A lookup that answers every read the same.
struct Fixed(Result<Option<Hold>, HoldReadError>);

impl ReplayHoldLookup for Fixed {
    fn read(&mut self, _: &RestingHoldSubject) -> Result<Option<Hold>, HoldReadError> {
        self.0.clone()
    }
}

fn none() -> Fixed {
    Fixed(Ok(None))
}

fn held(amount: &str) -> Fixed {
    Fixed(Ok(Some(Hold::Order(amount.to_owned()))))
}

struct Booted {
    engine: MatchingEngine,
    boot: Boot,
    listens: usize,
}

fn boot_with(mut engine: MatchingEngine, holds: &mut dyn ReplayHoldLookup) -> Booted {
    let mut listens = 0;
    let boot = open_after_replay(&mut engine, holds, &mut || {
        listens += 1;
        Ok(())
    })
    .unwrap();
    Booted {
        engine,
        boot,
        listens,
    }
}

fn boot(journal: MemoryJournal, holds: &mut dyn ReplayHoldLookup) -> Booted {
    boot_with(engine_on(journal), holds)
}

fn gate(b: &Booted) -> &svc_matching::holds::HoldGate {
    match &b.boot {
        Boot::Open { gate, .. } => gate,
        Boot::Exit { message } => panic!("the boot exited: {message}"),
    }
}

fn resting_ids(engine: &MatchingEngine) -> Vec<String> {
    engine
        .resting_orders(None)
        .into_iter()
        .map(|o| o.order_id)
        .collect()
}

fn journal_kinds(engine: &MatchingEngine, kind: &str) -> Vec<Json> {
    engine
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some(kind))
        .map(|r| r.0.clone())
        .collect()
}

fn door_over(engine: MatchingEngine, clock: fn() -> i64) -> MatchingDoor {
    MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: None,
            edge_key: None,
            clock,
            approvals: Box::new(Unwired),
            operator_ids: Vec::new(),
        },
        engine,
    )
    .unwrap()
}

fn get(door: &MatchingDoor, url: &str) -> (u16, Json) {
    match door.decide(&Request {
        method: "GET",
        url,
        headers: &[],
        body: "",
    }) {
        Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap_or(Json::Null)),
        Outcome::Owed(s) => panic!("{url} is owed by {}", s.name()),
    }
}

fn path<'a>(j: &'a Json, keys: &[&str]) -> &'a Json {
    keys.iter().fold(j, |at, k| {
        at.get(k)
            .unwrap_or_else(|| panic!("no {k} in {}", at.compact()))
    })
}

// ── health.router.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn health_on_a_fresh_engine_keeps_every_field_and_venue_halted_is_false() {
    let door = door_over(engine_on(MemoryJournal::new()), ticking);
    let (status, body) = get(&door, "/health");
    assert_eq!(status, 200);
    let Json::Object(fields) = &body else {
        panic!("not an object")
    };
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "ok",
            "service",
            "enabled",
            "venueHalted",
            "markets",
            "restingOrders",
            "journalRecords",
            "admissionOpen",
            "admissionReason",
            "holdHalted",
            "metrics"
        ]
    );
    let expect = json::parse(
        r#"{"ok":true,"service":"svc-matching","enabled":true,"venueHalted":false,"markets":0,"restingOrders":0,"journalRecords":0,"admissionOpen":true,"admissionReason":null,"holdHalted":[]}"#,
    )
    .unwrap();
    let Json::Object(want) = expect else { panic!() };
    for (k, v) in want {
        assert_eq!(body.get(&k), Some(&v), "{k}");
    }
}

#[test]
fn health_reads_the_venue_halt_live_from_the_engine() {
    let mut journal = MemoryJournal::new();
    let at = "2026-01-01T00:00:01.000Z";
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("halt_all")),
            ("at", Json::str(at)),
            ("operatorId", Json::str("ops-1")),
            ("confirmOperatorId", Json::str("ops-2")),
        ])))
        .unwrap();
    let mut engine = engine_on(journal);
    engine.recover().unwrap();
    let door = door_over(engine, ticking);
    let (_, halted) = get(&door, "/health");
    assert_eq!(halted.get("venueHalted"), Some(&Json::Bool(true)));
    assert!(matches!(halted.get("journalRecords"), Some(Json::Number(n)) if *n > 0.0));
    // The board svc-execution and svc-ws read agrees.
    let (_, board) = get(&door, "/markets");
    assert_eq!(board.get("venueHalted"), halted.get("venueHalted"));
}

// ── operation-latency.test.ts ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_fresh_engine_has_timed_nothing_counts_0_and_no_percentile_never_0_ms() {
    let door = door_over(engine_on(MemoryJournal::new()), ticking);
    let (_, body) = get(&door, "/health");
    for op in ["submit", "cancel", "depth"] {
        assert_eq!(
            path(&body, &["metrics", "operations", op]).compact(),
            r#"{"count":0,"errors":0,"p50Ms":null,"p99Ms":null,"perMinute":"0"}"#
        );
    }
    let Json::String(started) = path(&body, &["metrics", "startedAt"]) else {
        panic!()
    };
    assert!(service_kit::time::js_date(started).is_some());
}

#[test]
fn times_a_depth_read_under_its_own_operation_by_route_pattern_and_not_the_health_read_itself() {
    let door = door_over(engine_on(MemoryJournal::new()), ticking);
    let (status, _) = get(&door, "/markets/no-such-market/depth");
    assert_ne!(status, 200);
    get(&door, "/health");
    let (_, body) = get(&door, "/health");
    let depth = path(&body, &["metrics", "operations", "depth"]);
    assert_eq!(depth.get("count"), Some(&Json::int(1)));
    assert!(matches!(depth.get("p99Ms"), Some(Json::Number(n)) if *n > 0.0));
    assert_eq!(
        path(&body, &["metrics", "operations", "submit", "count"]),
        &Json::int(0)
    );
    let Some(Json::String(rate)) = depth.get("perMinute") else {
        panic!()
    };
    let per_minute: f64 = rate.parse().unwrap();
    assert!(per_minute > 0.0);
}

#[test]
fn classifies_only_the_three_order_routes() {
    assert_eq!(
        operation_of("post", Some("/markets/:marketId/orders")),
        Some(Operation::Submit)
    );
    assert_eq!(
        operation_of("DELETE", Some("/markets/:marketId/orders/:orderId")),
        Some(Operation::Cancel)
    );
    assert_eq!(
        operation_of("GET", Some("/markets/:marketId/depth")),
        Some(Operation::Depth)
    );
    assert_eq!(operation_of("GET", Some("/markets/:marketId/orders")), None);
    assert_eq!(operation_of("GET", None), None);
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn reports_the_bucket_bound_holding_each_percentile_and_5xx_replies_as_errors() {
    let mut l = OperationLatency::new(0);
    for _ in 0..98 {
        l.observe(Operation::Submit, ms(3), 200, None);
    }
    l.observe(Operation::Submit, ms(40), 200, None);
    l.observe(Operation::Submit, ms(400), 503, None);
    let r = l.reading(Operation::Submit, 60_000);
    assert_eq!(
        (r.count, r.errors, r.p50_ms, r.p99_ms, r.per_minute.as_str()),
        (100, 1, Some(5), Some(50), "100.00")
    );
}

#[test]
fn a_reply_slower_than_the_last_bound_has_no_finite_percentile() {
    let mut l = OperationLatency::new(0);
    l.observe(Operation::Cancel, ms(20_000), 200, None);
    let r = l.reading(Operation::Cancel, 60_000);
    assert_eq!((r.count, r.p50_ms, r.p99_ms), (1, None, None));
}

#[test]
fn reads_submit_latency_per_engine_market_every_market_listed_one_with_nothing_timed_has_no_percentile()
 {
    let mut l = OperationLatency::new(0);
    l.observe(Operation::Submit, ms(3), 200, Some("m-busy"));
    l.observe(Operation::Submit, ms(40), 200, Some("m-busy"));
    l.observe(Operation::Cancel, ms(3), 200, Some("m-busy"));
    let body = l.read(60_000, &["m-quiet".to_owned(), "m-busy".to_owned()]);
    let Some(Json::Object(by)) = body.get("submitByMarket") else {
        panic!()
    };
    let ids: Vec<&str> = by.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(ids, ["m-busy", "m-quiet"]);
    let busy = l.market_reading("m-busy", 60_000);
    assert_eq!(
        (busy.count, busy.p50_ms, busy.p99_ms),
        (2, Some(5), Some(50))
    );
    assert_eq!(
        by[1].1.compact(),
        r#"{"count":0,"errors":0,"p50Ms":null,"p99Ms":null,"perMinute":"0"}"#
    );
    assert_eq!(l.reading(Operation::Submit, 60_000).count, 2);
}

#[test]
fn the_door_counts_a_market_only_when_the_engine_has_it_never_a_raw_url_value() {
    let mut engine = engine_on(MemoryJournal::new());
    engine
        .submit("known", &order(REST, USER, Side::Buy, "1", "100"), None)
        .unwrap();
    let door = door_over(engine, ticking);
    for market in ["known", "made-up"] {
        door.decide(&Request {
            method: "POST",
            url: &format!("/markets/{market}/orders"),
            headers: &[("content-type".to_owned(), "application/json".to_owned())],
            body: "{}",
        });
    }
    let (_, body) = get(&door, "/health");
    assert_eq!(
        path(&body, &["metrics", "operations", "submit", "count"]),
        &Json::int(2)
    );
    let Some(Json::Object(by)) = path(&body, &["metrics"]).get("submitByMarket") else {
        panic!()
    };
    assert_eq!(by.len(), 1);
    assert_eq!(by[0].0, "known");
    assert_eq!(by[0].1.get("count"), Some(&Json::int(1)));
}

#[test]
fn the_bounds_are_the_scrape_buckets_in_whole_milliseconds() {
    let rounded: Vec<u64> = DURATION_BUCKETS
        .iter()
        .map(|s| format!("{:.0}", s * 1000.0).parse().unwrap())
        .collect();
    assert_eq!(rounded, bounds_ms());
}

// ── /ready ───────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn ready_answers_503_while_the_engine_is_off_or_admission_is_closed_and_200_with_the_market_count_otherwise()
 {
    let door = door_over(engine_on(MemoryJournal::new()), ticking);
    assert_eq!(
        get(&door, "/ready").1.compact(),
        r#"{"ready":true,"sequence":0}"#
    );
    door.engine().close_admission("matching.hold_check_unwired");
    assert_eq!(
        get(&door, "/ready"),
        (
            503,
            json::parse(r#"{"ready":false,"reason":"matching.hold_check_unwired"}"#).unwrap()
        )
    );
    door.engine().set_enabled(false);
    assert_eq!(
        get(&door, "/ready"),
        (
            503,
            json::parse(r#"{"ready":false,"reason":"matching.engine flag is off"}"#).unwrap()
        )
    );
}

// ── metrics.test.ts, through the server's routing ─────────────────────────────────────────────────────────────────

#[test]
fn metrics_is_mounted_with_the_prometheus_content_type_and_counts_every_reply_under_local() {
    let app = App {
        wire: door_over(engine_on(MemoryJournal::new()), ticking).with_service_name("svc-matching"),
        service_name: "svc-matching".to_owned(),
        ready_body: String::new(),
    };
    let before = app.route("GET", "/metrics", &[], "", "req-1");
    assert_eq!(
        (before.status, before.content_type),
        (200, PROMETHEUS_CONTENT_TYPE)
    );
    for url in [
        "/health",
        "/markets/x/depth?limit=10&secret=1",
        "/no-such-door",
    ] {
        let a = app.route("GET", url, &[], "", "req-2");
        app.observe("GET", a.status, ms(2));
    }
    let after = app.route("GET", "/metrics", &[], "", "req-3").body;
    assert!(after.contains("intafaced_http_request_duration_seconds_bucket"));
    assert!(after.contains(r#"module="_local""#));
    assert!(after.contains(r#"status="2xx""#));
    assert!(
        after.contains(r#"status="4xx""#),
        "a failure is counted: {after}"
    );
    assert!(!after.contains("secret"), "no query string reaches a label");
    assert!(app.wire.metrics().size() > 0);
    // The door's own /health and /ready, not the server's fixed ones.
    let health = app.route("GET", "/health", &[], "", "req-4");
    assert!(health.body.contains("\"admissionOpen\":true"));
    let ready = app.route("GET", "/ready", &[], "", "req-5");
    assert_eq!(ready.body, r#"{"ready":true,"sequence":0}"#);
    assert!(Door::metrics(&app.wire).is_some());
}

// ── replay-hold.test.ts: the hold check ───────────────────────────────────────────────────────────────────────────

#[test]
fn pulls_a_resting_order_whose_hold_is_gone_and_never_matches_it() {
    let mut b = boot(resting_buy(), &mut none());
    assert_eq!(b.listens, 1);
    let g = gate(&b).clone();
    assert!(g.open);
    assert_eq!(g.halted, []);
    assert_eq!(g.pulled.len(), 1);
    assert_eq!(
        (
            g.pulled[0].order_id.as_str(),
            g.pulled[0].market_id.as_str(),
            g.pulled[0].verdict
        ),
        (REST, MARKET, HoldVerdict::Missing)
    );
    assert!(!resting_ids(&b.engine).contains(&REST.to_owned()));
    assert!(journal_kinds(&b.engine, "cancel").iter().any(|r| {
        r.get("orderId") == Some(&Json::str(REST))
            && r.get("reason") == Some(&Json::str("hold_unconfirmed"))
    }));
    let crossed = b
        .engine
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    assert!(crossed.fills.is_empty());
    assert_eq!(resting_ids(&b.engine), [TAKER]);
}

/// A bus the test can read after the engine owns it.
#[derive(Clone, Default)]
struct SharedBus(Arc<Mutex<Vec<Published>>>);

impl EventBus for SharedBus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(Published {
            name: name.to_owned(),
            payload: payload.clone(),
            key: key.to_owned(),
        });
        Ok(())
    }
}

#[test]
fn re_announces_a_hold_cancel_on_the_next_boot_with_the_same_idempotency_key() {
    let first = SharedBus::default();
    let b = boot_with(
        MatchingEngine::new(parts(resting_buy(), Box::new(first.clone()), ticking)),
        &mut none(),
    );
    let key = first
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.key.starts_with("matching.order.cancelled:"))
        .map(|e| e.key.clone())
        .unwrap();
    let second = SharedBus::default();
    let mut restarted = MatchingEngine::new(parts(
        copy_journal(&b.engine),
        Box::new(second.clone()),
        ticking,
    ));
    restarted.recover().unwrap();
    assert_eq!(
        second
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.key == key)
            .count(),
        1
    );
    assert_eq!(restarted.resting_order_count(), 0);
}

#[test]
fn pulls_a_resting_order_whose_hold_is_smaller_than_the_remaining_size() {
    let mut b = boot(resting_buy(), &mut held("99"));
    let g = gate(&b).clone();
    assert!(g.open);
    assert_eq!(g.pulled[0].verdict, HoldVerdict::Short);
    assert_eq!(b.engine.resting_order_count(), 0);
    let crossed = b
        .engine
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    assert!(crossed.fills.is_empty());
}

#[test]
fn pulls_a_resting_order_whose_hold_row_is_unreadable() {
    let b = boot(
        resting_buy(),
        &mut Fixed(Err(HoldReadError::Order(
            "svc-ledger answered a transaction lookup malformed".to_owned(),
        ))),
    );
    assert!(!resting_ids(&b.engine).contains(&REST.to_owned()));
    assert!(
        journal_kinds(&b.engine, "cancel")
            .iter()
            .any(|r| r.get("reason") == Some(&Json::str("hold_unconfirmed")))
    );
}

#[test]
fn opens_an_unchanged_book_when_every_resting_hold_covers_the_remaining_size() {
    let journal = resting_buy();
    let mut mirror = engine_on(copy_journal_of(&journal));
    mirror.recover().unwrap();
    mirror.finish_startup_announce();
    let b = boot(journal, &mut held("100"));
    let g = gate(&b);
    assert!(g.open && g.checked == 1 && g.pulled.is_empty() && g.halted.is_empty());
    assert_eq!(b.listens, 1);
    assert!(b.engine.admission_open());
    assert_eq!(b.engine.serialize(), mirror.serialize());
    assert_eq!(resting_ids(&b.engine), [REST]);
}

fn copy_journal_of(journal: &MemoryJournal) -> MemoryJournal {
    let mut copy = MemoryJournal::new();
    for r in journal.read() {
        copy.append(&JournalCommand(r.0.clone())).unwrap();
    }
    copy
}

#[test]
fn keeps_a_resting_futures_order_whose_margin_pot_holds_anything_margin_is_not_compared_with_notional()
 {
    // Far below price × quantity: it is margin, not the order's value.
    let b = boot(
        resting_buy(),
        &mut Fixed(Ok(Some(Hold::FuturesMargin("5".to_owned())))),
    );
    let g = gate(&b);
    assert!(g.open && g.checked == 1 && g.pulled.is_empty() && g.halted.is_empty());
    assert!(b.engine.admission_open());
    assert_eq!(resting_ids(&b.engine), [REST]);
}

#[test]
fn pulls_a_resting_futures_order_whose_margin_pot_is_empty_or_unreadable() {
    for (margin, verdict) in [
        ("0", HoldVerdict::Missing),
        ("not-a-number", HoldVerdict::Unreadable),
    ] {
        let b = boot(
            resting_buy(),
            &mut Fixed(Ok(Some(Hold::FuturesMargin(margin.to_owned())))),
        );
        let g = gate(&b);
        assert!(g.open);
        assert_eq!(g.pulled[0].verdict, verdict, "{margin}");
        assert_eq!(b.engine.resting_order_count(), 0);
    }
}

#[test]
fn keeps_the_market_closed_when_the_hold_service_is_unreachable() {
    let mut b = boot(
        resting_buy(),
        &mut Fixed(Err(HoldReadError::Unreachable {
            code: HOLD_CHECK_UNREACHABLE,
            message: "connect ECONNREFUSED".to_owned(),
        })),
    );
    assert_eq!(b.listens, 1);
    let g = gate(&b);
    assert!(!g.open);
    assert_eq!(g.reason, Some(HOLD_CHECK_UNREACHABLE));
    assert!(!b.engine.admission_open());
    assert_eq!(b.engine.admission_reason(), Some(HOLD_CHECK_UNREACHABLE));
    assert_eq!(resting_ids(&b.engine), [REST]);
    let crossed = b
        .engine
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    assert_eq!(crossed.rejected.unwrap().code, "hold_check_unreachable");
    assert!(crossed.fills.is_empty());
    assert_eq!(resting_ids(&b.engine), [REST]);
    // The door answers the same: /ready 503 with the reason, /health with it.
    let door = door_over(b.engine, ticking);
    assert_eq!(get(&door, "/ready").0, 503);
    let (_, health) = get(&door, "/health");
    assert_eq!(health.get("admissionOpen"), Some(&Json::Bool(false)));
    assert_eq!(
        health.get("admissionReason"),
        Some(&Json::str(HOLD_CHECK_UNREACHABLE))
    );
}

#[test]
fn keeps_the_market_closed_when_ledger_url_is_unwired_and_a_resting_order_came_back() {
    let mut b = boot(resting_buy(), &mut UnwiredHolds);
    let g = gate(&b);
    assert!(!g.open);
    assert_eq!(g.reason, Some("matching.hold_check_unwired"));
    assert!(!b.engine.admission_open());
    let crossed = b
        .engine
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    assert!(crossed.fills.is_empty());
    assert_eq!(crossed.rejected.unwrap().code, "hold_check_unreachable");
}

#[test]
fn an_empty_book_opens_with_the_ledger_unwired() {
    let b = boot(MemoryJournal::new(), &mut UnwiredHolds);
    let g = gate(&b);
    assert!(g.open && g.checked == 0);
    assert!(b.engine.admission_open());
}

#[test]
fn halts_the_market_when_the_bad_hold_cannot_be_cancelled() {
    // The pull's cancel is refused while the market is in maintenance: the market is then held halted.
    let mut journal = resting_buy();
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("maintenance")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str("2026-01-01T00:00:02.000Z")),
            ("operatorId", Json::str("ops-1")),
            ("confirmOperatorId", Json::str("ops-2")),
        ])))
        .unwrap();
    let mut b = boot(journal, &mut none());
    let g = gate(&b).clone();
    assert!(g.open);
    assert!(g.pulled.is_empty());
    assert_eq!(g.halted.len(), 1);
    assert_eq!(
        (
            g.halted[0].market_id.as_str(),
            g.halted[0].order_id.as_str(),
            g.halted[0].reason.as_str()
        ),
        (MARKET, REST, "matching.hold_missing")
    );
    assert_eq!(
        b.engine.hold_halt_reason(MARKET),
        Some("matching.hold_missing")
    );
    assert_eq!(b.engine.hold_halted_markets(), [MARKET]);
    assert_eq!(resting_ids(&b.engine), [REST]);
    let crossed = b
        .engine
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    assert_eq!(crossed.rejected.unwrap().code, "hold_unconfirmed");
    assert!(crossed.fills.is_empty());
    assert_eq!(resting_ids(&b.engine), [REST]);
}

fn subject(side: Side, remaining: &str, funding: Option<&str>) -> RestingHoldSubject {
    RestingHoldSubject {
        market_id: MARKET.to_owned(),
        order_id: REST.to_owned(),
        account_id: USER.to_owned(),
        side,
        remaining: parse_amount(remaining).unwrap(),
        funding_price: funding.map(|p| parse_amount(p).unwrap()),
        sequence: 1,
    }
}

#[test]
fn sizes_a_buy_hold_as_ceil_price_times_remaining_and_a_sell_hold_as_remaining() {
    assert_eq!(
        required_hold_amount(&subject(Side::Buy, "2", Some("100"))),
        Some(parse_amount("200").unwrap())
    );
    assert_eq!(
        required_hold_amount(&subject(Side::Sell, "2.5", Some("100"))),
        Some(parse_amount("2.5").unwrap())
    );
    assert_eq!(required_hold_amount(&subject(Side::Buy, "1", None)), None);
    // Ceil, not half-up: the smallest unit over is still a unit.
    assert_eq!(
        required_hold_amount(&subject(Side::Buy, "0.000000000000000001", Some("0.5"))),
        Some(1)
    );
}

#[test]
fn the_hold_check_reads_every_resting_order_by_market_then_sequence() {
    let mut writer = engine_on(MemoryJournal::new());
    writer
        .submit(
            "ETH/USDT",
            &order(MAKER, MAKER_ACCT, Side::Sell, "1", "200"),
            None,
        )
        .unwrap();
    writer
        .submit(MARKET, &order(REST, USER, Side::Buy, "1", "100"), None)
        .unwrap();
    writer
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Sell, "2", "300"),
            None,
        )
        .unwrap();
    let ids: Vec<(String, String)> = writer
        .resting_hold_subjects()
        .into_iter()
        .map(|s| (s.market_id, s.order_id))
        .collect();
    assert_eq!(
        ids,
        [
            (MARKET.to_owned(), REST.to_owned()),
            (MARKET.to_owned(), TAKER.to_owned()),
            ("ETH/USDT".to_owned(), MAKER.to_owned())
        ]
    );
    let buy = &writer.resting_hold_subjects()[0];
    assert_eq!(buy.funding_price, Some(parse_amount("100").unwrap()));
    let mut lookup = held("1000");
    let g = enforce_replay_holds(&mut writer, &mut lookup).unwrap();
    assert_eq!(g.checked, 3);
}

// ── replay-hold.test.ts: the startup publish ──────────────────────────────────────────────────────────────────────

/// A journal whose replay prints one fill.
fn filled_journal() -> MemoryJournal {
    let mut writer = engine_on(MemoryJournal::new());
    writer
        .submit(
            MARKET,
            &order(MAKER, MAKER_ACCT, Side::Sell, "1", "100"),
            None,
        )
        .unwrap();
    let crossed = writer
        .submit(
            MARKET,
            &order(TAKER, TAKER_ACCT, Side::Buy, "1", "100"),
            None,
        )
        .unwrap();
    assert_eq!(crossed.fills.len(), 1);
    assert_eq!(writer.resting_order_count(), 0);
    writer.finish_startup_announce();
    copy_journal(&writer)
}

/// The first fill's publish times out once; the stream deduplicates by message id.
#[derive(Clone, Default)]
struct DedupingTimeoutOnce {
    attempts: Arc<Mutex<Vec<String>>>,
    stored: Arc<Mutex<Vec<String>>>,
    failed: Arc<Mutex<bool>>,
}

impl EventBus for DedupingTimeoutOnce {
    fn publish(&mut self, name: &str, _: &Json, key: &str) -> Result<(), String> {
        self.attempts.lock().unwrap().push(key.to_owned());
        let mut stored = self.stored.lock().unwrap();
        if stored.iter().any(|k| k == key) {
            return Ok(());
        }
        stored.push(key.to_owned());
        let mut failed = self.failed.lock().unwrap();
        if name == "orderFilled" && !*failed {
            *failed = true;
            return Err("nats: read: Resource temporarily unavailable (os error 11)".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
struct AlwaysTimeout(Arc<Mutex<u32>>);

impl EventBus for AlwaysTimeout {
    fn publish(&mut self, _: &str, _: &Json, _: &str) -> Result<(), String> {
        *self.0.lock().unwrap() += 1;
        Err("TIMEOUT".to_owned())
    }
}

#[test]
fn retries_one_timeout_with_the_same_message_id_and_starts_the_engine_once() {
    let bus = DedupingTimeoutOnce::default();
    let sleeps = Arc::new(Mutex::new(0));
    let counted = sleeps.clone();
    let engine = MatchingEngine::new(parts(filled_journal(), Box::new(bus.clone()), ticking))
        .with_startup_sleep(Box::new(move |_| *counted.lock().unwrap() += 1));
    let b = boot_with(
        engine,
        &mut Fixed(Err(HoldReadError::Order("no resting orders".to_owned()))),
    );
    assert!(matches!(b.boot, Boot::Open { .. }));
    assert_eq!(b.listens, 1);
    assert_eq!(*sleeps.lock().unwrap(), 1);
    let attempts = bus.attempts.lock().unwrap().clone();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0], attempts[1]);
    assert!(attempts[0].starts_with("matching.order.filled:"));
    assert_eq!(bus.stored.lock().unwrap().len(), 1);
}

#[test]
fn exits_cleanly_when_the_startup_publish_keeps_timing_out_and_does_not_listen() {
    let bus = AlwaysTimeout::default();
    let sleeps = Arc::new(Mutex::new(Vec::new()));
    let counted = sleeps.clone();
    let engine = MatchingEngine::new(parts(filled_journal(), Box::new(bus.clone()), ticking))
        .with_startup_sleep(Box::new(move |ms| counted.lock().unwrap().push(ms)));
    let b = boot_with(
        engine,
        &mut Fixed(Err(HoldReadError::Order("no resting orders".to_owned()))),
    );
    assert_eq!(b.listens, 0);
    let Boot::Exit { message } = &b.boot else {
        panic!("the boot listened")
    };
    assert_eq!(*bus.0.lock().unwrap(), STARTUP_PUBLISH_ATTEMPTS);
    assert_eq!(*sleeps.lock().unwrap(), [200, 400, 800]);
    assert!(message.contains("TIMEOUT"));
    assert!(message.contains("not announced"));
    assert!(message.contains("Exiting before listen"));
}

#[test]
fn a_live_publish_after_the_boot_takes_no_startup_retry() {
    let bus = AlwaysTimeout::default();
    let mut engine =
        MatchingEngine::new(parts(MemoryJournal::new(), Box::new(bus.clone()), ticking))
            .with_startup_sleep(Box::new(|_| panic!("a live publish waited")));
    let b = boot_with(engine_on(MemoryJournal::new()), &mut none());
    assert!(matches!(b.boot, Boot::Open { .. }));
    engine.recover().unwrap();
    engine.finish_startup_announce();
    let r = engine.submit(MARKET, &order(REST, USER, Side::Buy, "1", "100"), None);
    assert!(r.is_err());
    assert_eq!(*bus.0.lock().unwrap(), 1);
}

// ── replay-hold.test.ts: the ledger lookup ────────────────────────────────────────────────────────────────────────

struct Ledger<F: Fn(&str, &str) -> Result<Vec<BalanceRow>, String>>(F);

impl<F: Fn(&str, &str) -> Result<Vec<BalanceRow>, String>> ReplayHoldLedger for Ledger<F> {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<BalanceRow>, String> {
        (self.0)(owner_type, owner_id)
    }
}

fn row(purpose: &str, amount: &str) -> BalanceRow {
    BalanceRow {
        kind: "hold".to_owned(),
        purpose: purpose.to_owned(),
        amount: parse_amount(amount).unwrap(),
    }
}

#[test]
fn reads_the_order_hold_balance_and_reports_a_missing_purpose_as_no_hold() {
    let mut lookup = LedgerHolds::new(Ledger(|owner_type: &str, owner_id: &str| {
        assert_eq!((owner_type, owner_id), ("user", USER));
        Ok(vec![row(&format!("order:{REST}"), "100")])
    }));
    let s = subject(Side::Buy, "1", Some("100"));
    assert_eq!(
        lookup.read(&s),
        Ok(Some(Hold::Order(format_amount(
            parse_amount("100").unwrap()
        ))))
    );
    assert_eq!(
        lookup.read(&RestingHoldSubject {
            order_id: TAKER.to_owned(),
            ..s
        }),
        Ok(None)
    );
}

#[test]
fn reads_a_futures_orders_margin_pot_as_its_hold_and_refuses_two_holds_for_one_order() {
    let s = subject(Side::Buy, "1", Some("100"));
    let mut margin = LedgerHolds::new(Ledger(|_: &str, _: &str| {
        Ok(vec![row(&format!("futures-order:{REST}"), "7.5")])
    }));
    assert_eq!(
        margin.read(&s),
        Ok(Some(Hold::FuturesMargin("7.5".to_owned())))
    );
    let mut both = LedgerHolds::new(Ledger(|_: &str, _: &str| {
        Ok(vec![
            row(&format!("futures-order:{REST}"), "7.5"),
            row(&format!("order:{REST}"), "100"),
        ])
    }));
    match both.read(&s) {
        Err(HoldReadError::Order(m)) => assert!(m.contains("multiple ledger holds"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn does_not_pull_the_book_when_the_ledger_refuses_the_balances_call() {
    let mut lookup = LedgerHolds::new(Ledger(|_: &str, _: &str| {
        Err("ledger.unauthenticated".to_owned())
    }));
    let b = boot(resting_buy(), &mut lookup);
    let g = gate(&b);
    assert!(!g.open);
    assert_eq!(g.reason, Some(HOLD_CHECK_UNREACHABLE));
    assert!(g.pulled.is_empty());
    assert_eq!(resting_ids(&b.engine), [REST]);
    assert!(journal_kinds(&b.engine, "cancel").is_empty());
}

#[test]
fn treats_a_refused_ledger_connection_as_unreachable() {
    let mut lookup = LedgerHolds::new(Ledger(|_: &str, _: &str| Err("fetch failed".to_owned())));
    assert!(matches!(
        lookup.read(&subject(Side::Sell, "1", Some("100"))),
        Err(HoldReadError::Unreachable { code, .. }) if code == HOLD_CHECK_UNREACHABLE
    ));
}

#[test]
fn reads_each_owner_once_and_names_the_house_maker_and_refuses_an_account_that_is_no_ledger_owner()
{
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let mut lookup = LedgerHolds::new(Ledger(move |t: &str, id: &str| {
        seen.lock().unwrap().push(format!("{t}:{id}"));
        Ok(Vec::new())
    }));
    let s = subject(Side::Sell, "1", Some("100"));
    lookup.read(&s).unwrap();
    lookup.read(&s).unwrap();
    lookup
        .read(&RestingHoldSubject {
            account_id: "house:market-maker".to_owned(),
            ..s.clone()
        })
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        [format!("user:{USER}"), "house:market-maker".to_owned()]
    );
    assert!(matches!(
        lookup.read(&RestingHoldSubject {
            account_id: "mm".to_owned(),
            ..s
        }),
        Err(HoldReadError::Order(_))
    ));
}

#[test]
fn the_balances_wire_keeps_each_purpose_and_refuses_a_body_that_does_not_read() {
    let rows = balance_rows(
        r#"[{"accountId":"a","assetId":"USDT","kind":"hold","purpose":" order:x ","amount":"1.5"},{"accountId":"b","assetId":"USDT","kind":"available","amount":"2"}]"#,
    )
    .unwrap();
    assert_eq!(rows[0].purpose, "order:x");
    assert_eq!(rows[1].purpose, "");
    assert_eq!(rows[0].amount, parse_amount("1.5").unwrap());
    assert!(balance_rows(r#"{"error":"x"}"#).is_err());
    assert!(
        balance_rows(r#"[{"accountId":"a","assetId":"USDT","kind":"hold","amount":1}]"#).is_err()
    );
}

// ── replay-hold.boot-wrapper.test.ts ──────────────────────────────────────────────────────────────────────────────

#[test]
fn through_the_boot_a_pulled_order_leaves_its_market_open() {
    for (holds, verdict) in [
        (none(), HoldVerdict::Missing),
        (held("99"), HoldVerdict::Short),
    ] {
        let mut holds = holds;
        let b = boot(resting_buy(), &mut holds);
        let g = gate(&b);
        assert!(g.open);
        assert_eq!(g.pulled.len(), 1);
        assert_eq!(g.pulled[0].verdict, verdict);
        assert!(g.halted.is_empty());
        assert!(b.engine.hold_halted_markets().is_empty());
        assert_eq!(b.engine.resting_order_count(), 0);
    }
}

// ── expiry-sweep.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

fn rest_gtd(engine: &mut MatchingEngine) {
    let mut o = order(GTD, "desk", Side::Buy, "0.001", "100");
    o.tif = Tif::Gtd;
    o.expire_at = Some("2026-11-07T16:03:00.000Z".to_owned());
    let r = engine.submit(MARKET, &o, None).unwrap();
    assert!(r.accepted, "{:?}", r.rejected);
}

fn gtd_engine(bus: SharedBus) -> MatchingEngine {
    set_now("2026-11-07T16:01:30.000Z");
    let mut engine = MatchingEngine::new(parts(MemoryJournal::new(), Box::new(bus), settable));
    rest_gtd(&mut engine);
    engine
}

#[test]
fn expires_a_due_gtd_rest_in_a_quiet_market_with_no_later_order_and_publishes_the_cancel_with_reason_expired()
 {
    let bus = SharedBus::default();
    let mut engine = gtd_engine(bus.clone());
    // Not due yet: the pass runs and the order stays.
    engine.expiry_tick().unwrap();
    assert_eq!(resting_ids(&engine), [GTD]);
    let cancels = |b: &SharedBus| -> Vec<(Json, Json)> {
        b.0.lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == "orderCancelled")
            .map(|e| {
                (
                    e.payload.get("orderId").cloned().unwrap(),
                    e.payload.get("reason").cloned().unwrap(),
                )
            })
            .collect()
    };
    assert!(cancels(&bus).is_empty());
    set_now("2026-11-07T16:03:00.000Z");
    engine.expiry_tick().unwrap();
    assert!(resting_ids(&engine).is_empty());
    assert_eq!(cancels(&bus), [(Json::str(GTD), Json::str("expired"))]);
    let reasons: Vec<Json> = journal_kinds(&engine, "cancel")
        .iter()
        .map(|r| r.get("reason").cloned().unwrap())
        .collect();
    assert_eq!(reasons, [Json::str("expired")]);
}

#[test]
fn expires_once_later_passes_find_nothing_more_to_cancel() {
    let bus = SharedBus::default();
    let mut engine = gtd_engine(bus.clone());
    set_now("2026-11-07T16:04:00.000Z");
    for _ in 0..3 {
        engine.expiry_tick().unwrap();
    }
    assert_eq!(
        bus.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == "orderCancelled")
            .count(),
        1
    );
}

#[test]
fn does_not_sweep_a_disabled_engine_so_nothing_is_journalled_while_it_drains() {
    let mut engine = gtd_engine(SharedBus::default());
    engine.set_enabled(false);
    let before = engine.journal().len();
    set_now("2026-11-07T16:04:00.000Z");
    assert_eq!(engine.expiry_tick().unwrap(), None);
    assert_eq!(engine.journal().len(), before);
    assert_eq!(resting_ids(&engine), [GTD]);
}

#[test]
fn the_sweep_refuses_without_the_engine_clock() {
    let mut p = parts(
        MemoryJournal::new(),
        Box::new(MemoryEventBus::default()),
        ticking,
    );
    p.expiry_clock = false;
    let mut engine = MatchingEngine::new(p);
    let r = engine.sweep_expiry().unwrap();
    assert!(!r.accepted);
    assert_eq!(r.rejected.unwrap().code, "engine_clock_missing");
}

// ── shutdown.test.ts ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_drain_disables_the_engine_and_dropping_the_door_releases_the_journal_lock() {
    let dir = std::env::temp_dir().join(format!("matching-shutdown-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("engine.ndjson");
    let _ = std::fs::remove_file(&path);
    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(FileJournal::open(&path).unwrap()),
        bus: Box::new(MemoryEventBus::default()),
        clock: ticking,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    });
    let door = door_over(engine, ticking);
    // While the process holds the journal, a second writer is refused.
    assert!(FileJournal::open(&path).is_err());
    door.engine().set_enabled(false);
    assert!(!door.engine().is_enabled());
    assert_eq!(get(&door, "/ready").0, 503);
    drop(door);
    let reopened = FileJournal::open(&path);
    assert!(reopened.is_ok(), "{:?}", reopened.err());
    let _ = std::fs::remove_dir_all(&dir);
}
