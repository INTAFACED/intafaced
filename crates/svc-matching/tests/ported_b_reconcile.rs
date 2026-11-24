//! Ported from the TypeScript service's \`money-spine-tip-reprove.test.ts\` (D26-P2-12, the tip re-prove of the matching
//! money doors): reconcile stays read-only after a real fill and cancel stream through the door, and a funded
//! counterpart view the engine never saw refuses without inventing a market or repairing anything. Each test drives the
//! real door over a real engine (\`MatchingDoor::decide\`), signed as svc-trade over the exact body, as
//! \`tests/door_auth.rs\` does; the TypeScript's \`MemoryJournal\` is the Rust \`MemoryJournal\`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

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

const SECRET: &str = "matching-money-spine-tip-reprove-secret-32c";
const MARKET: &str = "BTC-USDT";

/// The door's clock is the real one, so the signed headers are fresh.
fn now_ms() -> i64 {
    system_seconds() * 1000
}

/// \`fixedClock()\`: 2026-08-12, the stamp every record carries.
fn engine_clock() -> i64 {
    1_786_492_800_000
}

/// \`buildEngine()\` mounted with \`registerRoutes(app, engine, SECRET, { bodyBind: 'require' })\`.
fn mount() -> MatchingDoor {
    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(MemoryJournal::new()),
        bus: Box::new(MemoryEventBus::default()),
        clock: engine_clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    });
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

struct Answer {
    status: u16,
    body: Json,
}

fn send(door: &MatchingDoor, method: &str, url: &str, payload: &str, signed: bool) -> Answer {
    let mut headers: Vec<(String, String)> = if payload.is_empty() {
        Vec::new()
    } else {
        vec![("content-type".to_owned(), "application/json".to_owned())]
    };
    if signed {
        headers.extend(legacy_headers("svc-trade", SECRET, payload, system_seconds()).unwrap());
    }
    match door.decide(&Request {
        method,
        url,
        headers: &headers,
        body: payload,
    }) {
        Outcome::Answer(r) => Answer {
            status: r.status,
            body: json::parse(&r.body).unwrap_or_else(|_| panic!("{} is JSON", r.body)),
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// \`lifecycleProof()\`: \`createMarketLifecycleAdmissionProof(snapshot, 'PLACE')\`.
fn lifecycle_proof() -> Json {
    let at = "2026-08-24T16:00:00.000Z";
    let snapshot = Json::obj([
        ("marketId", Json::str(MARKET)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(MARKET)),
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
        ("action", Json::str("PLACE")),
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

/// \`limitBody(orderId, accountId, side, qty, price)\`.
fn limit_body(order_id: &str, account_id: &str, side: &str, qty: &str, price: &str) -> String {
    Json::obj([
        ("orderId", Json::str(order_id)),
        ("accountId", Json::str(account_id)),
        ("type", Json::str("limit")),
        ("side", Json::str(side)),
        ("qty", Json::str(qty)),
        ("price", Json::str(price)),
        ("tif", Json::str("GTC")),
        ("lifecycleProof", lifecycle_proof()),
    ])
    .compact()
}

fn submit(door: &MatchingDoor, body: &str) -> Answer {
    send(
        door,
        "POST",
        &format!("/markets/{MARKET}/orders"),
        body,
        true,
    )
}

fn cancel(door: &MatchingDoor, order_id: &str) -> Answer {
    send(
        door,
        "DELETE",
        &format!("/markets/{MARKET}/orders/{order_id}"),
        "",
        true,
    )
}

/// One counterpart row: \`{ orderId, marketId, state: 'open', remaining, funded: true, detail? }\`.
fn open_row(order_id: &str, market_id: &str, remaining: &str, detail: Option<&str>) -> Json {
    let mut row = vec![
        ("orderId".to_owned(), Json::str(order_id)),
        ("marketId".to_owned(), Json::str(market_id)),
        ("state".to_owned(), Json::str("open")),
        ("remaining".to_owned(), Json::str(remaining)),
        ("funded".to_owned(), Json::Bool(true)),
    ];
    if let Some(d) = detail {
        row.push(("detail".to_owned(), Json::str(d)));
    }
    Json::Object(row)
}

fn reconcile_body(orders: Vec<Json>) -> String {
    Json::obj([("orders", Json::Array(orders))]).compact()
}

fn reconcile(door: &MatchingDoor, orders: Vec<Json>) -> Answer {
    send(door, "POST", "/reconcile", &reconcile_body(orders), true)
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not text in {}: {other:?}", j.compact()),
    }
}

fn findings(j: &Json) -> &[Json] {
    match j.get("findings") {
        Some(Json::Array(items)) => items,
        other => panic!("findings is not a list: {other:?}"),
    }
}

#[test]
fn fill_and_cancel_through_the_door_then_reconcile_clean_leaves_the_book_untouched() {
    let door = mount();
    let maker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let taker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let rest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    let placed = submit(&door, &limit_body(maker, "acct-maker", "sell", "5", "100"));
    assert_eq!(placed.status, 200, "{}", placed.body.compact());
    let fill = submit(&door, &limit_body(taker, "acct-taker", "buy", "2", "100"));
    assert_eq!(fill.status, 200, "{}", fill.body.compact());
    assert_eq!(fill.body.get("accepted"), Some(&Json::Bool(true)));
    let Some(Json::Array(fills)) = fill.body.get("fills") else {
        panic!("no fills in {}", fill.body.compact())
    };
    assert_eq!(fills.len(), 1);
    assert_eq!(text(&fills[0], "qty"), "2");
    assert_eq!(text(&fills[0], "price"), "100");
    let rested = submit(&door, &limit_body(rest, "acct-rest", "buy", "1", "99"));
    assert_eq!(rested.status, 200, "{}", rested.body.compact());

    let before = door.engine().serialize();
    let records_before = door.engine().journal().len();
    let clean = reconcile(
        &door,
        vec![
            open_row(maker, MARKET, "3", Some("hold=3 BTC")),
            open_row(rest, MARKET, "1", Some("hold=99 USDT")),
        ],
    );

    assert_eq!(clean.status, 200, "{}", clean.body.compact());
    assert_eq!(clean.body.get("ok"), Some(&Json::Bool(true)));
    assert_eq!(clean.body.get("agreed"), Some(&Json::int(2)));
    assert_eq!(clean.body.get("refusals"), Some(&Json::int(0)));
    assert_eq!(door.engine().serialize(), before);
    // Read-only: reconcile journals nothing either.
    assert_eq!(door.engine().journal().len(), records_before);
}

#[test]
fn a_funded_open_on_the_counterpart_with_no_engine_row_refuses_without_invent_or_cancel() {
    let door = mount();
    let ghost_order = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let ghost_market = "NEVER-TRADED-SPINE-REPROVE";

    let before = door.engine().serialize();
    let res = reconcile(
        &door,
        vec![open_row(
            ghost_order,
            ghost_market,
            "2",
            Some("hold=200 USDT"),
        )],
    );

    assert_eq!(res.status, 200, "{}", res.body.compact());
    assert_eq!(res.body.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(res.body.get("refusals"), Some(&Json::int(1)));
    let first = &findings(&res.body)[0];
    assert_eq!(text(first, "case"), "counterpart_open_engine_missing");
    assert_eq!(text(first, "orderId"), ghost_order);
    assert!(
        text(first, "counterpart").contains("hold=200 USDT"),
        "{}",
        first.compact()
    );
    assert!(!door.engine().has_market(ghost_market));
    assert_eq!(door.engine().serialize(), before);
    assert!(door.engine().markets().is_empty());
    assert!(door.engine().journal().is_empty());
}

#[test]
fn after_cancel_through_the_door_a_still_funded_counterpart_open_refuses_as_missing() {
    let door = mount();
    let order_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    let placed = submit(&door, &limit_body(order_id, "acct-1", "buy", "1", "100"));
    assert_eq!(placed.status, 200, "{}", placed.body.compact());
    let cancelled = cancel(&door, order_id);
    assert_eq!(cancelled.status, 200, "{}", cancelled.body.compact());
    // Cancel empties the book but keeps the traded market id: reconcile must still refuse a funded open that is no
    // longer live, without inventing a second market or resurrecting the order.
    let before = door.engine().serialize();
    let state = json::parse(&before).unwrap();
    let Json::Array(books) = &state else {
        panic!("the engine state is not a list: {before}")
    };
    assert_eq!(books.len(), 1, "{before}");
    assert_eq!(text(&books[0], "marketId"), MARKET);
    for side in ["bids", "asks", "stops"] {
        assert_eq!(
            books[0].get(side),
            Some(&Json::Array(Vec::new())),
            "{side} in {before}"
        );
    }

    let res = reconcile(
        &door,
        vec![open_row(
            order_id,
            MARKET,
            "1",
            Some("hold=100 USDT stranded"),
        )],
    );

    assert_eq!(res.status, 200, "{}", res.body.compact());
    assert_eq!(res.body.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(res.body.get("refusals"), Some(&Json::int(1)));
    assert_eq!(
        text(&findings(&res.body)[0], "case"),
        "counterpart_open_engine_missing"
    );
    assert_eq!(door.engine().serialize(), before);
    assert_eq!(door.engine().markets(), vec![MARKET.to_owned()]);
    assert_eq!(door.engine().resting_order_count(), 0);
}

#[test]
fn an_unauthenticated_reconcile_never_reaches_the_engine_and_allocates_nothing() {
    let door = mount();
    let ghost = "UNAUTH-RECONCILE-GHOST";
    let body = reconcile_body(vec![open_row(
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        ghost,
        "1",
        None,
    )]);

    let res = send(&door, "POST", "/reconcile", &body, false);

    assert_eq!(res.status, 401, "{}", res.body.compact());
    assert!(!door.engine().has_market(ghost));
    assert!(door.engine().markets().is_empty());
    assert!(door.engine().journal().is_empty());
}
