//! Cancel integrity, phantom-market refusals, determinism and the unsigned doors, ported test for test from the
//! TypeScript service's `promise-falsify-public-doors.test.ts` (`services/svc-matching/src/`, D26-P2-01d and
//! D26-P2-12). Each test is named after the `it` it ports, prefixed with its `describe`'s topic (`cancel_`,
//! `phantom_`, `determinism_`, `unauth_`), and drives the real door (`MatchingDoor::decide`) over a real engine on a
//! `MemoryJournal`, with the TypeScript's fixed clock (one second a read from 2026-01-01).
//!
//! Where the TypeScript reads `engine.hasMarket`, `engine.markets` and `engine.serialize()`, these read the same calls
//! on the door's engine. A TypeScript recovery hands the same `MemoryJournal` to a second engine; here the second
//! engine gets a record-for-record copy of it. Nothing in the file is left unported.
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
use svc_matching::errors::user_copy;
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
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

/// The door's journal, copied record for record: the same `MemoryJournal` handed to a second engine.
fn copy_journal(door: &MatchingDoor) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in door.engine().journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

/// `new MatchingEngine({ journal, ... }).recover()`, mounted.
fn recovered(journal: MemoryJournal) -> MatchingDoor {
    reset_clock();
    let mut engine = engine_on(journal);
    engine.recover().unwrap();
    mount(engine)
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

    fn text(&self, key: &str) -> String {
        text(self.at(key))
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

fn cancel(door: &MatchingDoor, market: &str, order: &str) -> Answer {
    send(
        door,
        "DELETE",
        &format!("/markets/{market}/orders/{order}"),
        "",
        &signed(""),
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

/// `GET /markets`'s list.
fn listed(door: &MatchingDoor) -> Json {
    let a = send(door, "GET", "/markets", "", &[]);
    assert_eq!(a.status, 200, "{}", a.payload);
    a.at("markets").clone()
}

fn ok(a: &Answer) {
    assert_eq!(a.status, 200, "{}", a.payload);
}

const SECRET: &str = "matching-promise-falsify-public-doors-secret-32";
const OTHER: &str = "ETH-USDT";

fn submit(
    door: &MatchingDoor,
    market: &str,
    order: &str,
    account: &str,
    side: &str,
    qty: &str,
    price: &str,
) -> Answer {
    submit_raw(
        door,
        market,
        &limit_body(market, order, account, side, qty, price, "GTC"),
    )
}

/// `GET /markets/:marketId/orders?limit=500`, signed.
fn orders(door: &MatchingDoor, market: &str) -> Answer {
    send(
        door,
        "GET",
        &format!("/markets/{market}/orders?limit=500"),
        "",
        &signed(""),
    )
}

/// The live order ids `GET /orders` lists, in its order.
fn live_ids(door: &MatchingDoor, market: &str) -> Vec<String> {
    let a = orders(door, market);
    ok(&a);
    a.list("orders")
        .iter()
        .map(|o| text(field(o, "orderId")))
        .collect()
}

fn not_found(a: &Answer, code: &str) {
    assert_eq!(a.status, 404, "{}", a.payload);
    assert_eq!(a.text("code"), code, "{}", a.payload);
}

fn markets(door: &MatchingDoor) -> Vec<String> {
    door.engine().markets()
}

fn has(door: &MatchingDoor, market: &str) -> bool {
    door.engine().has_market(market)
}

fn serialized(door: &MatchingDoor) -> String {
    door.engine().serialize()
}

fn jlen(door: &MatchingDoor) -> usize {
    door.engine().journal().len()
}

/// `res.json().sequence` is a number and the cancellation carries the same one.
fn same_sequence(a: &Answer) {
    let seq = a.at("sequence");
    assert!(matches!(seq, Json::Number(_)), "{}", a.payload);
    assert_eq!(
        field(a.at("cancellation"), "sequence"),
        seq,
        "{}",
        a.payload
    );
}

// ── D26-P2-01d public doors: cancel integrity ───────────────────────────

#[test]
fn cancel_cancels_only_the_named_live_order_and_returns_remaining_qty_and_sequence() {
    let door = fresh();
    let keep = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let kill = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    ok(&submit(&door, MARKET, keep, "acct-keep", "buy", "2", "100"));
    ok(&submit(
        &door,
        MARKET,
        kill,
        "acct-kill",
        "buy",
        "3.5",
        "99",
    ));

    let res = cancel(&door, MARKET, kill);
    ok(&res);
    assert_eq!(res.at("cancelled"), &Json::Bool(true), "{}", res.payload);
    assert_eq!(res.text("orderId"), kill);
    let c = res.at("cancellation");
    assert_eq!(text(field(c, "orderId")), kill);
    assert_eq!(text(field(c, "accountId")), "acct-kill");
    assert_eq!(text(field(c, "remainingQty")), "3.5");
    assert_eq!(text(field(c, "reason")), "requested");
    same_sequence(&res);

    assert_eq!(live_ids(&door, MARKET), vec![keep]);
}

#[test]
fn cancel_double_cancel_is_404_and_leaves_the_other_resting_order_untouched() {
    let door = fresh();
    let keep = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let kill = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    ok(&submit(&door, MARKET, keep, "acct-a", "buy", "1", "100"));
    ok(&submit(&door, MARKET, kill, "acct-b", "buy", "1", "99"));

    ok(&cancel(&door, MARKET, kill));
    not_found(&cancel(&door, MARKET, kill), "OrderNotFound");
    assert_eq!(live_ids(&door, MARKET), vec![keep]);
}

#[test]
fn cancel_aimed_at_the_wrong_market_is_404_and_does_not_invent_that_market() {
    let door = fresh();
    let order = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    ok(&submit(&door, MARKET, order, "acct-1", "buy", "1", "100"));
    let before = markets(&door);

    let res = cancel(&door, OTHER, order);
    assert_eq!(res.status, 404, "{}", res.payload);
    assert!(!has(&door, OTHER));
    assert_eq!(markets(&door), before);

    // Still live on the real book: a wrong-market cancel must not steal it.
    assert_eq!(live_ids(&door, MARKET), vec![order]);
}

#[test]
fn cancel_after_a_partial_fill_reports_leftover_remaining_qty_not_the_original_size() {
    let door = fresh();
    let maker = "12121212-1212-4121-8121-121212121212";
    let taker = "13131313-1313-4131-8131-131313131313";
    let sibling = "14141414-1414-4141-8141-141414141414";
    ok(&submit(
        &door,
        MARKET,
        maker,
        "acct-maker",
        "sell",
        "5",
        "100",
    ));
    ok(&submit(
        &door, MARKET, sibling, "acct-sib", "sell", "1", "100",
    ));
    let take = submit(&door, MARKET, taker, "acct-taker", "buy", "2", "100");
    ok(&take);
    assert_eq!(take.at("accepted"), &Json::Bool(true), "{}", take.payload);
    let fills = take.list("fills");
    assert_eq!(fills.len(), 1, "{}", take.payload);
    assert_eq!(text(field(&fills[0], "qty")), "2");
    assert_eq!(text(field(&fills[0], "price")), "100");
    assert_eq!(text(field(&fills[0], "makerOrderId")), maker);

    let listed_before = listed(&door);
    let live_before = orders(&door, MARKET);
    let maker_row = live_before
        .list("orders")
        .iter()
        .find(|o| text(field(o, "orderId")) == maker)
        .unwrap_or_else(|| panic!("{}", live_before.payload))
        .clone();
    assert_eq!(text(field(&maker_row, "remaining")), "3");

    let res = cancel(&door, MARKET, maker);
    ok(&res);
    assert_eq!(res.at("cancelled"), &Json::Bool(true));
    assert_eq!(res.text("orderId"), maker);
    let c = res.at("cancellation");
    assert_eq!(text(field(c, "orderId")), maker);
    assert_eq!(text(field(c, "remainingQty")), "3");
    assert_eq!(text(field(c, "reason")), "requested");
    assert_eq!(field(c, "remainingQty"), field(&maker_row, "remaining"));
    same_sequence(&res);

    not_found(&cancel(&door, MARKET, maker), "OrderNotFound");
    assert_eq!(live_ids(&door, MARKET), vec![sibling]);
    let listed_after = listed(&door);
    assert_eq!(listed_after, listed_before);
    assert_eq!(listed_after, strs(&[MARKET]));
}

#[test]
fn cancel_unknown_order_id_on_a_known_market_is_404_and_does_not_steal_the_live_book() {
    let door = fresh();
    let live = "15151515-1515-4151-8151-151515151515";
    let ghost = "16161616-1616-4161-8161-161616161616";
    ok(&submit(&door, MARKET, live, "acct-live", "buy", "1", "100"));
    let before = serialized(&door);

    not_found(&cancel(&door, MARKET, ghost), "OrderNotFound");
    assert_eq!(serialized(&door), before);
    assert_eq!(live_ids(&door, MARKET), vec![live]);
}

#[test]
fn cancel_a_fully_filled_taker_cannot_be_cancelled_while_the_leftover_maker_stays_live() {
    let door = fresh();
    let maker = "17171717-1717-4171-8171-171717171717";
    let taker = "18181818-1818-4181-8181-181818181818";
    ok(&submit(
        &door,
        MARKET,
        maker,
        "acct-maker",
        "sell",
        "5",
        "50",
    ));
    let take = submit(&door, MARKET, taker, "acct-taker", "buy", "4", "50");
    assert_eq!(take.at("accepted"), &Json::Bool(true), "{}", take.payload);
    assert_eq!(take.at("resting"), &Json::Null, "{}", take.payload);

    not_found(&cancel(&door, MARKET, taker), "OrderNotFound");
    let live = orders(&door, MARKET);
    let rows: Vec<(String, String)> = live
        .list("orders")
        .iter()
        .map(|o| (text(field(o, "orderId")), text(field(o, "remaining"))))
        .collect();
    assert_eq!(rows, vec![(maker.to_owned(), "1".to_owned())]);
    assert!(has(&door, MARKET));
}

#[test]
fn cancel_unauthenticated_cancel_never_reaches_the_engine() {
    let door = fresh();
    let order = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    ok(&submit(&door, MARKET, order, "acct-1", "buy", "1", "100"));
    let journalled = jlen(&door);

    let res = send(
        &door,
        "DELETE",
        &format!("/markets/{MARKET}/orders/{order}"),
        "",
        &[],
    );
    assert_eq!(res.status, 401, "{}", res.payload);
    assert_eq!(jlen(&door), journalled, "the engine journalled a cancel");
    assert_eq!(live_ids(&door, MARKET), vec![order]);
}

// ── D26-P2-01d public doors: phantom market refuse ──────────────────────

#[test]
fn phantom_get_depth_on_a_never_traded_market_is_404_and_allocates_nothing() {
    let door = fresh();
    let ghost = "NEVER-TRADED-DEPTH-DOOR";
    not_found(&depth(&door, ghost), "MarketNotFound");
    assert!(!has(&door, ghost));
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn phantom_delete_cancel_on_a_never_traded_market_is_404_and_journals_nothing() {
    let door = fresh();
    let ghost = "NEVER-TRADED-CANCEL-DOOR";
    let res = cancel(&door, ghost, "00000000-0000-4000-8000-deadbeef0001");
    assert_eq!(res.status, 404, "{}", res.payload);
    assert!(!has(&door, ghost));
    assert!(markets(&door).is_empty());
    // No journal side effect: a recovered engine would still have no market, and serialize stays the empty form.
    assert_eq!(serialized(&door), "[]");
    assert_eq!(jlen(&door), 0);
}

#[test]
fn phantom_get_orders_on_a_never_traded_market_is_404_without_allocating() {
    let door = fresh();
    let ghost = "NEVER-TRADED-ORDERS-DOOR";
    let res = orders(&door, ghost);
    assert_eq!(res.status, 404, "{}", res.payload);
    assert!(!has(&door, ghost));
}

#[test]
fn phantom_fok_reject_through_the_submit_door_does_not_leave_a_phantom_market_listed() {
    let door = fresh();
    let ghost = "NEVER-TRADED-FOK-DOOR";
    let body = limit_body(
        ghost,
        "11111111-1111-4111-8111-111111111111",
        "acct-fok",
        "buy",
        "1",
        "100",
        "FOK",
    );
    let res = submit_raw(&door, ghost, &body);
    ok(&res);
    assert_eq!(res.at("accepted"), &Json::Bool(false), "{}", res.payload);
    assert_eq!(text(field(res.at("rejected"), "code")), "fok_unfillable");
    assert!(!has(&door, ghost));

    assert_eq!(depth(&door, ghost).status, 404);
    assert!(!list(&listed(&door)).contains(&Json::str(ghost)));
}

#[test]
fn phantom_ioc_into_a_virgin_market_through_the_submit_door_does_not_list_the_market() {
    let door = fresh();
    let ghost = "NEVER-TRADED-IOC-DOOR";
    let body = limit_body(
        ghost,
        "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b",
        "acct-ioc",
        "buy",
        "1",
        "100",
        "IOC",
    );
    let res = submit_raw(&door, ghost, &body);
    ok(&res);
    assert_eq!(res.at("accepted"), &Json::Bool(true), "{}", res.payload);
    assert_eq!(res.at("resting"), &Json::Null);
    assert!(res.list("fills").is_empty());
    let cancellations = res.list("cancellations");
    assert_eq!(cancellations.len(), 1, "{}", res.payload);
    assert_eq!(text(field(&cancellations[0], "remainingQty")), "1");
    assert_eq!(text(field(&cancellations[0], "reason")), "ioc_remainder");
    assert!(!has(&door, ghost));

    assert_eq!(depth(&door, ghost).status, 404);
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn phantom_repeated_phantom_probes_across_all_three_doors_leave_get_markets_empty() {
    let door = fresh();
    for i in 0..40 {
        let ghost = format!("PHANTOM-PROBE-{i}");
        depth(&door, &ghost);
        cancel(&door, &ghost, &format!("00000000-0000-4000-8000-{i:012}"));
        orders(&door, &ghost);
    }
    assert!(markets(&door).is_empty());
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn phantom_ghost_depth_orders_cancel_do_not_allocate_even_when_another_market_already_exists() {
    let door = fresh();
    ok(&submit(
        &door,
        MARKET,
        "19191919-1919-4191-8191-191919191919",
        "acct-live",
        "buy",
        "1",
        "100",
    ));
    let ghost = "NEVER-TRADED-BESIDE-LIVE";

    assert_eq!(depth(&door, ghost).status, 404);
    assert_eq!(orders(&door, ghost).status, 404);
    assert_eq!(
        cancel(&door, ghost, "00000000-0000-4000-8000-deadbeef0002").status,
        404
    );
    assert!(!has(&door, ghost));

    assert_eq!(listed(&door), strs(&[MARKET]));
    assert_eq!(live_ids(&door, MARKET).len(), 1);
}

#[test]
fn phantom_a_market_that_traded_then_emptied_still_answers_depth_a_never_traded_ghost_stays_404() {
    let door = fresh();
    let only = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
    ok(&submit(&door, MARKET, only, "acct-only", "buy", "1", "100"));
    ok(&cancel(&door, MARKET, only));

    assert!(has(&door, MARKET));
    let emptied = depth(&door, MARKET);
    ok(&emptied);
    assert_eq!(emptied.text("marketId"), MARKET);
    assert!(emptied.list("bids").is_empty());
    assert!(emptied.list("asks").is_empty());

    let ghost = "NEVER-TRADED-EMPTY-VS-GHOST";
    not_found(&depth(&door, ghost), "MarketNotFound");
    assert!(!has(&door, ghost));
    assert_eq!(listed(&door), strs(&[MARKET]));
}

// ── D26-P2-01d public doors: determinism edges ──────────────────────────

/// What one door-fed engine answered and holds after the stream.
#[derive(Debug, PartialEq)]
struct Drive {
    serialize: String,
    submit_payloads: Vec<String>,
    cancel_payloads: Vec<String>,
    depth_payload: String,
    orders_payload: String,
    submit_bodies: Vec<Json>,
    cancel_bodies: Vec<Json>,
    depth: Json,
    resting: Json,
}

fn drive() -> Drive {
    let door = fresh();
    let mut submits: Vec<Answer> = Vec::new();
    let maker = "22222222-2222-4222-8222-222222222222";
    let taker_partial = "33333333-3333-4333-8333-333333333333";
    let rest_buy = "44444444-4444-4444-8444-444444444444";
    let cancel_me = "55555555-5555-4555-8555-555555555555";
    submits.push(submit(
        &door,
        MARKET,
        maker,
        "acct-maker",
        "sell",
        "5",
        "100",
    ));
    submits.push(submit(
        &door,
        MARKET,
        taker_partial,
        "acct-taker",
        "buy",
        "2",
        "100",
    ));
    submits.push(submit(
        &door,
        MARKET,
        rest_buy,
        "acct-rest",
        "buy",
        "1",
        "99",
    ));
    submits.push(submit(
        &door,
        MARKET,
        cancel_me,
        "acct-gone",
        "buy",
        "4",
        "98",
    ));
    let cancelled = cancel(&door, MARKET, cancel_me);
    // Cross-market noise that must still be deterministic.
    submits.push(submit(
        &door,
        OTHER,
        "66666666-6666-4666-8666-666666666666",
        "acct-eth",
        "buy",
        "1",
        "2000",
    ));

    let depth_res = depth(&door, MARKET);
    let orders_res = orders(&door, MARKET);
    assert_eq!(
        orders_res.text("marketId"),
        MARKET,
        "{}",
        orders_res.payload
    );
    Drive {
        serialize: serialized(&door),
        submit_payloads: submits.iter().map(|a| a.payload.clone()).collect(),
        cancel_payloads: vec![cancelled.payload.clone()],
        depth_payload: depth_res.payload.clone(),
        orders_payload: orders_res.payload.clone(),
        submit_bodies: submits.iter().map(|a| a.body.clone()).collect(),
        cancel_bodies: vec![cancelled.body.clone()],
        depth: depth_res.body.clone(),
        resting: orders_res.body.clone(),
    }
}

#[test]
fn determinism_two_door_fed_engines_produce_byte_identical_serialize_and_matching_payloads() {
    let a = drive();
    let b = drive();

    assert_eq!(a.serialize.as_bytes(), b.serialize.as_bytes());
    assert!(a.serialize.len() > 40, "{}", a.serialize);
    assert_eq!(a.submit_payloads, b.submit_payloads);
    assert_eq!(a.cancel_payloads, b.cancel_payloads);
    assert_eq!(a.depth_payload, b.depth_payload);
    assert_eq!(a.orders_payload, b.orders_payload);
    assert_eq!(a, b);

    // Guard: the stream really filled and left resting depth; empty books comparing equal would prove nothing.
    let second = &a.submit_bodies[1];
    assert_eq!(field(second, "accepted"), &Json::Bool(true));
    let fills = list(field(second, "fills"));
    assert_eq!(fills.len(), 1, "{}", second.compact());
    assert_eq!(text(field(&fills[0], "qty")), "2");
    assert_eq!(text(field(&fills[0], "price")), "100");
    assert_eq!(field(&a.cancel_bodies[0], "cancelled"), &Json::Bool(true));
    assert_eq!(
        text(field(&a.cancel_bodies[0], "orderId")),
        "55555555-5555-4555-8555-555555555555"
    );
    assert_eq!(text(field(&a.resting, "marketId")), MARKET);
    let rows = list(field(&a.resting, "orders"));
    assert_eq!(rows.len(), 2, "{}", a.resting.compact());
    assert!(rows.iter().any(|o| text(field(o, "orderId"))
        == "22222222-2222-4222-8222-222222222222"
        && text(field(o, "remaining")) == "3"));
    assert!(
        rows.iter()
            .any(|o| text(field(o, "orderId")) == "44444444-4444-4444-8444-444444444444")
    );
}

#[test]
fn determinism_replay_of_the_journal_recorded_through_the_http_door_reconstructs_serialize() {
    let door = fresh();
    let a = "77777777-7777-4777-8777-777777777777";
    let b = "88888888-8888-4888-8888-888888888888";
    ok(&submit(&door, MARKET, a, "acct-a", "sell", "3", "50"));
    ok(&submit(&door, MARKET, b, "acct-b", "buy", "1", "50"));
    ok(&cancel(&door, MARKET, a));

    let live = serialized(&door);
    assert!(jlen(&door) >= 3);

    let back = recovered(copy_journal(&door));
    assert_eq!(serialized(&back), live);

    // The public depth door on the recovered engine answers as the live one does.
    let live_depth = depth(&door, MARKET);
    let back_depth = depth(&back, MARKET);
    ok(&live_depth);
    assert_eq!(back_depth.body, live_depth.body);
}

#[test]
fn determinism_boot_recover_of_an_ioc_only_journal_does_not_list_a_phantom_on_get_markets() {
    let door = fresh();
    let ghost = "NEVER-TRADED-IOC-REPLAY-DOOR";
    let body = limit_body(
        ghost,
        "1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c",
        "acct-ioc-replay",
        "buy",
        "2",
        "100",
        "IOC",
    );
    let res = submit_raw(&door, ghost, &body);
    assert_eq!(res.at("accepted"), &Json::Bool(true), "{}", res.payload);
    assert_eq!(jlen(&door), 1);

    let back = recovered(copy_journal(&door));
    assert!(!list(&listed(&back)).contains(&Json::str(ghost)));
    assert_eq!(listed(&back), strs(&[]));
    assert_eq!(depth(&back, ghost).status, 404);
}

#[test]
fn determinism_boot_recover_of_a_cancel_only_journal_does_not_list_a_phantom_on_get_markets() {
    let mut journal = MemoryJournal::new();
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("cancel")),
            ("marketId", Json::str("LEGACY-CANCEL-PUBLIC-DOOR")),
            ("at", Json::str("2026-01-01T00:00:00.000Z")),
            ("orderId", Json::str("00000000-0000-4000-8000-cafebabe0099")),
        ])))
        .unwrap();
    let back = recovered(journal);
    assert_eq!(listed(&back), strs(&[]));
    assert_eq!(depth(&back, "LEGACY-CANCEL-PUBLIC-DOOR").status, 404);
}

// ── promise-falsify public doors: D26-P2-12 spine reprove (phantom / unauth) ──

const GHOST: &str = "NEVER-TRADED-SPINE-REPROVE-PF";
const GHOST_ORDER: &str = "12121212-1212-4121-8121-121212121212";

fn ghost_limit_body() -> String {
    limit_body(GHOST, GHOST_ORDER, "acct-spine", "buy", "1", "100", "GTC")
}

/// A submit with a content type and no credentials.
fn unauth_submit(door: &MatchingDoor, market: &str, payload: &str) -> Answer {
    send(
        door,
        "POST",
        &format!("/markets/{market}/orders"),
        payload,
        &[],
    )
}

fn unauth_orders(door: &MatchingDoor, market: &str) -> Answer {
    send(door, "GET", &format!("/markets/{market}/orders"), "", &[])
}

fn unauth_reconcile(door: &MatchingDoor, orders: Json) -> Answer {
    send(
        door,
        "POST",
        "/reconcile",
        &Json::obj([("orders", orders)]).compact(),
        &[],
    )
}

/// `{ orderId, marketId, state: 'open', remaining: '1', funded: true }`.
fn funded_open(order: &str, market: &str, detail: Option<&str>) -> Json {
    let mut row = Json::obj([
        ("orderId", Json::str(order)),
        ("marketId", Json::str(market)),
        ("state", Json::str("open")),
        ("remaining", Json::str("1")),
        ("funded", Json::Bool(true)),
    ]);
    if let (Some(d), Json::Object(fields)) = (detail, &mut row) {
        fields.push(("detail".to_owned(), Json::str(d)));
    }
    row
}

fn unauthenticated(a: &Answer) {
    assert_eq!(a.status, 401, "{}", a.payload);
    assert_eq!(a.text("code"), "Unauthenticated", "{}", a.payload);
    assert_eq!(a.text("message"), user_copy("matching.unauthenticated"));
}

#[test]
fn unauth_unauthenticated_submit_on_a_never_traded_market_is_401_and_allocates_nothing() {
    let door = fresh();
    let before = serialized(&door);
    unauthenticated(&unauth_submit(&door, GHOST, &ghost_limit_body()));
    assert!(!has(&door, GHOST));
    assert_eq!(serialized(&door), before);
    assert_eq!(jlen(&door), 0);
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn unauth_unauthenticated_submit_on_a_live_market_is_401_and_leaves_the_resting_book_untouched() {
    let door = fresh();
    ok(&submit(
        &door,
        MARKET,
        "13131313-1313-4131-8131-131313131313",
        "acct-live",
        "buy",
        "1",
        "100",
    ));
    let before = serialized(&door);
    let journalled = jlen(&door);

    let attack = limit_body(
        MARKET,
        "14141414-1414-4141-8141-141414141414",
        "acct-attack",
        "sell",
        "1",
        "100",
        "GTC",
    );
    let res = unauth_submit(&door, MARKET, &attack);
    assert_eq!(res.status, 401, "{}", res.payload);
    assert_eq!(serialized(&door), before);
    assert_eq!(jlen(&door), journalled);
    assert_eq!(live_ids(&door, MARKET).len(), 1);
}

#[test]
fn unauth_unauthenticated_orders_read_on_a_ghost_market_is_401_never_allocates_to_answer_404() {
    let door = fresh();
    let res = unauth_orders(&door, GHOST);
    assert_eq!(res.status, 401, "{}", res.payload);
    assert!(!has(&door, GHOST));
    assert!(markets(&door).is_empty());
}

#[test]
fn unauth_forged_service_credentials_on_submit_refuse_before_the_engine_and_leave_get_markets_empty()
 {
    let door = fresh();
    let payload = ghost_limit_body();
    let forged: Headers = vec![
        ("x-intafaced-service".to_owned(), "svc-trade".to_owned()),
        (
            "x-intafaced-service-ts".to_owned(),
            system_seconds().to_string(),
        ),
        ("x-intafaced-service-sig".to_owned(), "a".repeat(64)),
    ];
    let res = send(
        &door,
        "POST",
        &format!("/markets/{GHOST}/orders"),
        &payload,
        &forged,
    );
    assert_eq!(res.status, 401, "{}", res.payload);
    assert!(!has(&door, GHOST));
    assert_eq!(jlen(&door), 0);
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn unauth_cancel_credentials_lifted_onto_submit_on_a_ghost_market_refuse_with_body_mismatch() {
    let door = fresh();
    let payload = ghost_limit_body();
    let res = send(
        &door,
        "POST",
        &format!("/markets/{GHOST}/orders"),
        &payload,
        &signed(""),
    );
    unauthenticated(&res);
    assert_eq!(res.text("rejected"), "body-mismatch", "{}", res.payload);
    assert!(!has(&door, GHOST));
    assert_eq!(jlen(&door), 0);
}

#[test]
fn unauth_unauthenticated_reconcile_with_a_funded_ghost_open_refuses_before_inventing_the_market() {
    let door = fresh();
    let before = serialized(&door);
    let res = unauth_reconcile(
        &door,
        Json::Array(vec![funded_open(GHOST_ORDER, GHOST, Some("hold=100 USDT"))]),
    );
    assert_eq!(res.status, 401, "{}", res.payload);
    assert!(!has(&door, GHOST));
    assert_eq!(serialized(&door), before);
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn unauth_repeated_unauthenticated_write_probes_across_submit_cancel_orders_and_reconcile_stay_empty()
 {
    let door = fresh();
    for i in 0..20 {
        let probe = format!("PHANTOM-UNAUTH-{i}");
        let order = format!("15151515-1515-4151-8151-{i:012}");
        let body = limit_body(&probe, &order, "acct-probe", "buy", "1", "100", "GTC");
        assert_eq!(unauth_submit(&door, &probe, &body).status, 401);
        assert_eq!(
            send(
                &door,
                "DELETE",
                &format!("/markets/{probe}/orders/{order}"),
                "",
                &[]
            )
            .status,
            401
        );
        assert_eq!(unauth_orders(&door, &probe).status, 401);
        assert_eq!(
            unauth_reconcile(&door, Json::Array(vec![funded_open(&order, &probe, None)])).status,
            401
        );
    }
    assert!(markets(&door).is_empty());
    assert_eq!(serialized(&door), "[]");
    assert_eq!(jlen(&door), 0);
    assert_eq!(listed(&door), strs(&[]));
}

#[test]
fn unauth_unauthenticated_cancel_on_a_ghost_market_is_401_and_does_not_journal_a_phantom_book() {
    let door = fresh();
    let res = send(
        &door,
        "DELETE",
        &format!("/markets/{GHOST}/orders/{GHOST_ORDER}"),
        "",
        &[],
    );
    assert_eq!(res.status, 401, "{}", res.payload);
    assert!(!has(&door, GHOST));
    assert_eq!(serialized(&door), "[]");
    assert_eq!(jlen(&door), 0);
}
