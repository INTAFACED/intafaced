//! Every money-affecting matching guard reached through the public door, ported test for test from the TypeScript
//! service's `unreachable-guard-public-doors.test.ts` (`services/svc-matching/src/`, D26-P2-03): self-trade
//! prevention, the maker's price, the IOC remainder, post-only, a duplicate order id, the kill switch, a reconcile
//! quantity disagreement, and depth written as decimal strings. Each test is named after the `it` it ports, prefixed
//! with its `describe`'s topic (`stp_`, `tif_`, `honesty_`), and drives the real door (`MatchingDoor::decide`), signed
//! as svc-trade with the body bound, over a real engine on a `MemoryJournal` with the TypeScript's fixed clock.
//! Nothing in the file is left unported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;

use service_kit::json::{self, Json};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::{Digest, Sha256};
use svc_matching::approval::Stub;
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::env::parse_operator_ids;
use svc_matching::journal::io::MemoryJournal;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC-USDT";

// ── engines and doors ───────────────────────────────────────────────────

thread_local! {
    static TICK: Cell<i64> = const { Cell::new(0) };
}

/// 2026-01-01T00:00:00.000Z.
const CLOCK_BASE: i64 = 1_767_225_600_000;

/// `fixedClock()`: one second later on every read. Each test runs on its own thread, so each has its own clock;
/// `reset_clock` starts it again, as a second `fixedClock()` would.
fn fixed_clock() -> i64 {
    TICK.with(|t| {
        t.set(t.get() + 1);
        CLOCK_BASE + t.get() * 1000
    })
}

fn reset_clock() {
    TICK.with(|t| t.set(0));
}

/// The door's own clock is the real one, so the signed headers (signed now) are fresh.
fn now_ms() -> i64 {
    system_seconds() * 1000
}

/// `new MatchingEngine({ journal, bus, clock: fixedClock(), snapshotEvery: 0 })`.
fn engine_on(journal: MemoryJournal) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(MemoryEventBus::default()),
        clock: fixed_clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

/// `registerRoutes(app, engine, SECRET, { bodyBind: 'require' })`.
fn mount(engine: MatchingEngine) -> MatchingDoor {
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

/// `mount(buildEngine())`.
fn fresh() -> MatchingDoor {
    reset_clock();
    mount(engine_on(MemoryJournal::new()))
}

// ── requests ────────────────────────────────────────────────────────────

struct Answer {
    status: u16,
    payload: String,
    body: Json,
}

impl Answer {
    fn at(&self, key: &str) -> &Json {
        self.body
            .get(key)
            .unwrap_or_else(|| panic!("no {key} in {}", self.payload))
    }

    fn list(&self, key: &str) -> &[Json] {
        list(self.at(key))
    }
}

fn text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        other => panic!("not text: {}", other.compact()),
    }
}

fn list(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not a list: {}", other.compact()),
    }
}

fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    v.get(key)
        .unwrap_or_else(|| panic!("no {key} in {}", v.compact()))
}

type Headers = Vec<(String, String)>;

fn send(
    door: &MatchingDoor,
    method: &str,
    url: &str,
    payload: &str,
    headers: &[(String, String)],
) -> Answer {
    // A bodyless call sends no content type, as `app.inject` sends none without a payload.
    let mut all: Headers = if payload.is_empty() {
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
            payload: r.body,
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

/// `serviceAuthHeadersForBody('svc-trade', SECRET, body)`.
fn signed(body: &str) -> Headers {
    legacy_headers("svc-trade", SECRET, body, system_seconds()).unwrap()
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)` for an open market.
fn proof(market: &str, action: &str) -> Json {
    let at = "2026-08-24T16:00:00.000Z";
    let snapshot = Json::obj([
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
        ("allowedActions", strs(&["PLACE", "PLACE_POST_ONLY"])),
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
        ("checkedAt", Json::str(at)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// `limitBody(...)` with its lifecycle proof for `market`: a limit order, `PLACE_POST_ONLY` for a post-only one.
fn limit_body(
    market: &str,
    order: &str,
    account: &str,
    side: &str,
    qty: &str,
    price: &str,
    tif: &str,
) -> String {
    let action = if tif == "PO" {
        "PLACE_POST_ONLY"
    } else {
        "PLACE"
    };
    Json::obj([
        ("orderId", Json::str(order)),
        ("accountId", Json::str(account)),
        ("type", Json::str("limit")),
        ("side", Json::str(side)),
        ("qty", Json::str(qty)),
        ("price", Json::str(price)),
        ("tif", Json::str(tif)),
        ("lifecycleProof", proof(market, action)),
    ])
    .compact()
}

fn submit_raw(door: &MatchingDoor, market: &str, payload: &str) -> Answer {
    send(
        door,
        "POST",
        &format!("/markets/{market}/orders"),
        payload,
        &signed(payload),
    )
}

fn depth(door: &MatchingDoor, market: &str) -> Answer {
    send(
        door,
        "GET",
        &format!("/markets/{market}/depth?limit=50"),
        "",
        &[],
    )
}

fn ok(a: &Answer) {
    assert_eq!(a.status, 200, "{}", a.payload);
}

const SECRET: &str = "matching-unreachable-guard-public-doors-secret-32";

fn submit(
    door: &MatchingDoor,
    order: &str,
    account: &str,
    side: &str,
    qty: &str,
    price: &str,
    tif: &str,
) -> Answer {
    submit_raw(
        door,
        MARKET,
        &limit_body(MARKET, order, account, side, qty, price, tif),
    )
}

/// `GET /markets/BTC-USDT/orders?limit=100`, signed.
fn orders(door: &MatchingDoor) -> Answer {
    let a = send(
        door,
        "GET",
        &format!("/markets/{MARKET}/orders?limit=100"),
        "",
        &signed(""),
    );
    ok(&a);
    a
}

/// `assertNoJsonNumbers`: no amount is left a JSON number. Sequences and counts are integers by design.
fn no_json_numbers(value: &Json, path: &str) {
    match value {
        Json::Number(n) => panic!("money amount at {path} left as JSON number {n}"),
        Json::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                no_json_numbers(v, &format!("{path}[{i}]"));
            }
        }
        Json::Object(fields) => {
            for (k, v) in fields {
                if matches!(
                    k.as_str(),
                    "sequence" | "version" | "agreed" | "refusals" | "checked" | "autos"
                ) {
                    continue;
                }
                no_json_numbers(v, &format!("{path}.{k}"));
            }
        }
        Json::Null | Json::Bool(_) | Json::String(_) => {}
    }
}

/// The book's resting ids by level on one side: `engine.book(MARKET).toState().<side>.map(l => l.orders.map(o => o.orderId))`.
fn side_ids(door: &MatchingDoor, side: &str) -> Vec<Vec<String>> {
    let engine = door.engine();
    let state = engine
        .existing_book(MARKET)
        .expect("the book exists")
        .to_state();
    list(field(&state, side))
        .iter()
        .map(|level| {
            list(field(level, "orders"))
                .iter()
                .map(|o| text(field(o, "orderId")))
                .collect()
        })
        .collect()
}

fn refused(a: &Answer, code: &str) {
    ok(a);
    assert_eq!(a.at("accepted"), &Json::Bool(false), "{}", a.payload);
    assert_eq!(text(field(a.at("rejected"), "code")), code, "{}", a.payload);
    assert!(a.list("fills").is_empty(), "{}", a.payload);
    assert_eq!(a.at("resting"), &Json::Null, "{}", a.payload);
}

// ── D26-P2-03 public doors: self-trade and maker price ──────────────────

#[test]
fn stp_expire_resting_no_same_account_fill_rest_cancelled_taker_continues() {
    let door = fresh();
    let own = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let stranger = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let aggressor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    ok(&submit(&door, own, "acct-same", "buy", "1", "100", "GTC"));
    ok(&submit(
        &door,
        stranger,
        "acct-stranger",
        "buy",
        "1",
        "100",
        "GTC",
    ));

    let res = submit(&door, aggressor, "acct-same", "sell", "2", "100", "GTC");
    ok(&res);
    assert_eq!(res.at("accepted"), &Json::Bool(true), "{}", res.payload);
    assert_eq!(res.at("rejected"), &Json::Null);
    let fills = res.list("fills");
    assert_eq!(fills.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&fills[0], "makerOrderId")), stranger);
    assert_eq!(text(field(&fills[0], "makerAccountId")), "acct-stranger");
    assert_eq!(text(field(&fills[0], "takerAccountId")), "acct-same");
    assert_eq!(text(field(&fills[0], "qty")), "1");
    let cancellations = res.list("cancellations");
    assert_eq!(cancellations.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&cancellations[0], "orderId")), own);
    assert_eq!(
        text(field(&cancellations[0], "reason")),
        "self_trade_prevention"
    );
    assert_eq!(text(field(&cancellations[0], "remainingQty")), "1");
    assert_eq!(text(field(res.at("resting"), "orderId")), aggressor);
    assert_eq!(side_ids(&door, "asks"), vec![vec![aggressor.to_owned()]]);
    assert!(side_ids(&door, "bids").is_empty());
    no_json_numbers(res.at("fills"), "$");
    no_json_numbers(res.at("cancellations"), "$");
}

#[test]
fn stp_crossed_fill_through_the_submit_door_uses_maker_price_not_taker_limit() {
    let door = fresh();
    let maker = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let taker = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    ok(&submit(
        &door, maker, "acct-mm", "sell", "2", "100.25", "GTC",
    ));
    let res = submit(&door, taker, "acct-tk", "buy", "1.5", "101", "GTC");
    ok(&res);
    let fills = res.list("fills");
    assert_eq!(fills.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&fills[0], "makerOrderId")), maker);
    assert_eq!(text(field(&fills[0], "price")), "100.25");
    assert_eq!(text(field(&fills[0], "qty")), "1.5");
    // The taker improved on the book; settlement must still see the maker's price on the wire.
    assert_ne!(text(field(&fills[0], "price")), "101");
    no_json_numbers(res.at("fills"), "$");
}

// ── D26-P2-03 public doors: TIF, identity and the kill switch ───────────

#[test]
fn tif_ioc_remainder_cancels_through_the_door_with_reason_ioc_remainder() {
    let door = fresh();
    let maker = "11111111-1111-4111-8111-111111111111";
    let taker = "22222222-2222-4222-8222-222222222222";
    ok(&submit(&door, maker, "acct-mm", "sell", "1", "100", "GTC"));
    let res = submit(&door, taker, "acct-tk", "buy", "3", "100", "IOC");
    ok(&res);
    assert_eq!(res.at("accepted"), &Json::Bool(true), "{}", res.payload);
    let fills = res.list("fills");
    assert_eq!(fills.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&fills[0], "qty")), "1");
    assert_eq!(text(field(&fills[0], "price")), "100");
    assert_eq!(res.at("resting"), &Json::Null);
    let cancellations = res.list("cancellations");
    assert_eq!(cancellations.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&cancellations[0], "orderId")), taker);
    assert_eq!(text(field(&cancellations[0], "remainingQty")), "2");
    assert_eq!(text(field(&cancellations[0], "reason")), "ioc_remainder");
}

#[test]
fn tif_post_only_that_would_cross_is_rejected_on_the_door_and_leaves_depth_unchanged() {
    let door = fresh();
    ok(&submit(
        &door,
        "33333333-3333-4333-8333-333333333333",
        "acct-mm",
        "sell",
        "2",
        "100",
        "GTC",
    ));
    let before = depth(&door, MARKET);
    ok(&before);

    let res = submit(
        &door,
        "44444444-4444-4444-8444-444444444444",
        "acct-tk",
        "buy",
        "1",
        "100",
        "PO",
    );
    refused(&res, "post_only_would_cross");
    assert_eq!(depth(&door, MARKET).body, before.body);
}

#[test]
fn tif_duplicate_live_order_id_is_rejected_on_the_door_bot_retry_cannot_open_a_second_rest() {
    let door = fresh();
    let id = "55555555-5555-4555-8555-555555555555";
    ok(&submit(&door, id, "acct-a", "buy", "1", "100", "GTC"));

    let again = submit(&door, id, "acct-a", "buy", "9", "99", "GTC");
    refused(&again, "duplicate_order_id");

    let live = orders(&door);
    let rows = live.list("orders");
    assert_eq!(rows.len(), 1, "{}", live.payload);
    assert_eq!(text(field(&rows[0], "orderId")), id);
    assert_eq!(text(field(&rows[0], "remaining")), "1");
}

#[test]
fn tif_kill_switch_refuses_submit_on_the_door_as_engine_disabled_and_journals_nothing() {
    let door = fresh();
    door.engine().set_enabled(false);
    let before = door.engine().journal().len();

    let res = submit(
        &door,
        "66666666-6666-4666-8666-666666666666",
        "acct-a",
        "buy",
        "1",
        "100",
        "GTC",
    );
    refused(&res, "engine_disabled");
    assert_eq!(door.engine().journal().len(), before);
    assert!(door.engine().markets().is_empty());
}

// ── D26-P2-03 public doors: reconcile and depth honesty ─────────────────

#[test]
fn honesty_post_reconcile_refuses_quantity_disagreement_naming_both_remainings_real_engine() {
    let door = fresh();
    let maker = "77777777-7777-4777-8777-777777777777";
    let taker = "88888888-8888-4888-8888-888888888888";
    ok(&submit(&door, maker, "acct-mm", "sell", "5", "100", "GTC"));
    ok(&submit(&door, taker, "acct-tk", "buy", "2", "100", "GTC"));

    // The counterpart never saw the fill: it still believes 5 working and funded.
    let payload = Json::obj([(
        "orders",
        Json::Array(vec![Json::obj([
            ("orderId", Json::str(maker)),
            ("marketId", Json::str(MARKET)),
            ("state", Json::str("open")),
            ("remaining", Json::str("5")),
            ("funded", Json::Bool(true)),
            ("detail", Json::str("hold=500 USDT")),
        ])]),
    )])
    .compact();
    let res = send(&door, "POST", "/reconcile", &payload, &signed(&payload));
    ok(&res);
    assert_eq!(res.at("ok"), &Json::Bool(false), "{}", res.payload);
    let Json::Number(refusals) = res.at("refusals") else {
        panic!("{}", res.payload)
    };
    assert!(*refusals >= 1.0, "{}", res.payload);
    let finding = res
        .list("findings")
        .iter()
        .find(|f| text(field(f, "orderId")) == maker)
        .unwrap_or_else(|| panic!("no finding for the maker in {}", res.payload));
    assert_eq!(text(field(finding, "case")), "quantity_disagreement");
    assert_eq!(text(field(finding, "verdict")), "refuse");
    assert!(
        text(field(finding, "engine")).contains("remaining=3"),
        "{}",
        finding.compact()
    );
    assert!(
        text(field(finding, "counterpart")).contains("remaining=5"),
        "{}",
        finding.compact()
    );

    // Read-only: the maker still rests after the refusal.
    let live = orders(&door);
    assert!(
        live.list("orders")
            .iter()
            .any(|o| text(field(o, "orderId")) == maker),
        "{}",
        live.payload
    );
}

#[test]
fn honesty_get_depth_emits_decimal_string_level_tuples_never_json_numbers() {
    let door = fresh();
    ok(&submit(
        &door,
        "99999999-9999-4999-8999-999999999999",
        "acct-a",
        "buy",
        "1.125",
        "100.5",
        "GTC",
    ));
    ok(&submit(
        &door,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
        "acct-b",
        "sell",
        "2.5",
        "101.25",
        "GTC",
    ));

    let res = depth(&door, MARKET);
    ok(&res);
    assert_eq!(res.list("bids")[0], strs(&["100.5", "1.125"]));
    assert_eq!(res.list("asks")[0], strs(&["101.25", "2.5"]));
    for level in res.list("bids").iter().chain(res.list("asks")) {
        let tuple = list(level);
        assert_eq!(tuple.len(), 2, "{}", level.compact());
        assert!(
            tuple.iter().all(|v| matches!(v, Json::String(_))),
            "{}",
            level.compact()
        );
    }
    no_json_numbers(res.at("bids"), "$.bids");
    no_json_numbers(res.at("asks"), "$.asks");
}
