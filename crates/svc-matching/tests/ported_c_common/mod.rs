//! The helpers the `ported_c_*` tests share: a real door over a real engine (`MatchingDoor::decide`), as
//! `tests/door_auth.rs` builds it, with the TypeScript router tests' `registerRoutes(app, engine, SECRET, { bodyBind:
//! 'require' })`, their `submitBody` and their `engine.book(MARKET).toState()` reads.

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

pub const SECRET: &str = "matching-ported-c-router-secret-32chars";
pub const MARKET: &str = "BTC-USDT";
pub const ORDERS: &str = "/markets/BTC-USDT/orders";

/// The door's clock is the real one, so the signed headers (signed now) are fresh.
fn now_ms() -> i64 {
    system_seconds() * 1000
}

/// `registerRoutes(app, new MatchingEngine({ journal: new MemoryJournal(), bus, snapshotEvery: 0 }), SECRET, { bodyBind:
/// 'require' })`.
pub fn mount() -> MatchingDoor {
    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(MemoryJournal::new()),
        bus: Box::new(MemoryEventBus::default()),
        clock: now_ms,
        expiry_clock: false,
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

pub struct Answer {
    pub status: u16,
    pub body: Json,
}

impl Answer {
    pub fn get(&self, key: &str) -> &Json {
        self.body
            .get(key)
            .unwrap_or_else(|| panic!("no {key} in {}", self.body.compact()))
    }

    pub fn text(&self, key: &str) -> String {
        text(self.get(key))
    }

    pub fn accepted(&self) -> bool {
        match self.get("accepted") {
            Json::Bool(b) => *b,
            other => panic!("accepted is {other:?} in {}", self.body.compact()),
        }
    }

    /// `res.json().rejected?.code`.
    pub fn rejected_code(&self) -> Option<String> {
        match self.get("rejected") {
            Json::Null => None,
            r => Some(text(at(r, "code"))),
        }
    }

    pub fn list(&self, key: &str) -> &[Json] {
        list(self.get(key))
    }

    /// The answer was 200; prints the body when it was not.
    pub fn ok(&self) -> &Answer {
        assert_eq!(self.status, 200, "{}", self.body.compact());
        self
    }
}

pub fn at<'a>(j: &'a Json, key: &str) -> &'a Json {
    j.get(key)
        .unwrap_or_else(|| panic!("no {key} in {}", j.compact()))
}

pub fn text(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        other => panic!("not text: {}", other.compact()),
    }
}

pub fn list(j: &Json) -> &[Json] {
    match j {
        Json::Array(items) => items,
        other => panic!("not a list: {}", other.compact()),
    }
}

/// `serviceAuthHeadersForBody(service, SECRET, body)`: v2, the body bound by its digest.
pub fn signed(service: &str, body: &str) -> Vec<(String, String)> {
    legacy_headers(service, SECRET, body, system_seconds()).unwrap()
}

/// One request through the whole door: its caller check, its input checks, then the engine.
pub fn send(
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
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

/// `post(app, url, body)` as svc-trade signs it.
pub fn post(door: &MatchingDoor, url: &str, body: &Json) -> Answer {
    let payload = body.compact();
    send(door, "POST", url, &payload, &signed("svc-trade", &payload))
}

/// `patch(app, orderId, body)` as svc-trade signs it.
pub fn patch(door: &MatchingDoor, order_id: &str, body: &Json) -> Answer {
    let payload = body.compact();
    send(
        door,
        "PATCH",
        &format!("{ORDERS}/{order_id}"),
        &payload,
        &signed("svc-trade", &payload),
    )
}

/// A signed svc-trade GET (the empty body bound by its digest).
pub fn get(door: &MatchingDoor, url: &str, service: &str) -> Answer {
    send(door, "GET", url, "", &signed(service, ""))
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)` for an OPEN market allowing `allowed`.
pub fn proof(action: &str, allowed: &[&str]) -> Json {
    let observed = "2026-08-24T16:00:00.000Z";
    let snapshot = Json::obj([
        ("marketId", Json::str(MARKET)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(MARKET)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(observed)),
        ("observedAt", Json::str(observed)),
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
        ("checkedAt", Json::str(observed)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// The proof every `submitBody` carries: `PLACE`, the market allowing `PLACE` and `PLACE_POST_ONLY`.
pub fn place() -> Json {
    proof("PLACE", &["PLACE", "PLACE_POST_ONLY"])
}

/// A request body as `{ ...submitBody(), ...over }` builds it: a field set again keeps its place, a new one is added
/// last, and `unset` is the TypeScript's `field: undefined` (`JSON.stringify` leaves it out).
#[derive(Clone)]
pub struct Body(Vec<(String, Json)>);

impl Body {
    /// `submitBody()`: a GTC limit buy of 1 at 100 by `desk`, with a `PLACE` proof.
    pub fn order() -> Body {
        Body(Vec::new())
            .s("orderId", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .s("accountId", "desk")
            .s("type", "limit")
            .s("side", "buy")
            .s("qty", "1")
            .s("price", "100")
            .s("tif", "GTC")
            .set("lifecycleProof", place())
    }

    pub fn empty() -> Body {
        Body(Vec::new())
    }

    pub fn set(mut self, key: &str, value: Json) -> Body {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_owned(), value)),
        }
        self
    }

    pub fn s(self, key: &str, value: &str) -> Body {
        self.set(key, Json::str(value))
    }

    pub fn unset(mut self, key: &str) -> Body {
        self.0.retain(|(k, _)| k != key);
        self
    }

    pub fn json(&self) -> Json {
        Json::Object(self.0.clone())
    }
}

/// `engine.book(MARKET).toState()`: `engine.book` opens an empty book where none is held, so a market the engine never
/// opened (or dropped) reads as one with no orders.
pub fn state(door: &MatchingDoor) -> Json {
    door.engine().existing_book(MARKET).map_or_else(
        || {
            Json::obj([
                ("bids", Json::Array(Vec::new())),
                ("asks", Json::Array(Vec::new())),
                ("lastTradePrice", Json::Null),
            ])
        },
        svc_matching::book::OrderBook::to_state,
    )
}

/// The order ids on one side, level by level (`side.map((l) => l.orders.map((o) => o.orderId))`).
pub fn side_ids(state: &Json, side: &str) -> Vec<Vec<String>> {
    list(at(state, side))
        .iter()
        .map(|l| {
            list(at(l, "orders"))
                .iter()
                .map(|o| text(at(o, "orderId")))
                .collect()
        })
        .collect()
}

/// Every live order id, bids then asks.
pub fn live_ids(door: &MatchingDoor) -> Vec<String> {
    let s = state(door);
    let mut ids: Vec<String> = side_ids(&s, "bids").into_iter().flatten().collect();
    ids.extend(side_ids(&s, "asks").into_iter().flatten());
    ids
}

/// `toState()[side][0].orders[0]`.
pub fn first_order(door: &MatchingDoor, side: &str) -> Json {
    let s = state(door);
    let level = list(at(&s, side))
        .first()
        .unwrap_or_else(|| panic!("no {side} level in {}", s.compact()));
    list(at(level, "orders"))
        .first()
        .unwrap_or_else(|| panic!("no order at the first {side} level"))
        .clone()
}

/// `toState()[side].length`.
pub fn levels(door: &MatchingDoor, side: &str) -> usize {
    list(at(&state(door), side)).len()
}

/// The journal's record kinds: what the engine was asked to do.
pub fn kinds(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}
