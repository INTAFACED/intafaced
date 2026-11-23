//! `collars.test.ts` (`services/svc-matching/src/engine/`), ported where the Rust has the behaviour. Each test is named
//! after the TypeScript `it` it ports.
//!
//! `collars.ts` installs five engine calls, `applyCollar`, `collarBand`, `applyFatFinger`, `throttleCheck` and
//! `enterSevereMarket`, each of which only refuses (`collar_unpublished`, `fat_finger_unpublished`,
//! `throttle_unpublished`, `severe_market_unset`) while the owner's magnitudes are blank. No door, no other module and
//! no binary path calls them, and the Rust engine has none of them: there is no collar band, fat-finger limit, throttle
//! or severe-market mode to invent or to refuse. So the first four tests ("applyCollar refuses collar_unpublished",
//! "collarBand / fat-finger / throttle refuse unpublished", "severe-market missing/false refuses severe_market_unset",
//! "explicit severe-market still unpublished while magnitudes are blank") have nothing to call and are not ported.
//! The caller's own per-order collar (`collar`, `min`, `max` on the order) is `collar.test.ts`'s, ported in
//! `tests/order_rules.rs`.
//!
//! What the file also holds is ported: a normal submit still fills (no hidden halt), and the journal never holds a
//! collar, fat-finger, throttle or severe-market record. The Rust holds the second more strongly: the journal's codec
//! refuses to encode any of those kinds, so no file journal can grow one.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::money::parse_amount;
use svc_matching::book::types::{EngineOrder, OrderType, Side, Tif};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::codec::encode;
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const ASK: &str = "11111111-1111-4111-8111-111111111111";
const TAKE: &str = "22222222-2222-4222-8222-222222222222";

const FAKE_KINDS: [&str; 4] = ["collar", "fat_finger", "throttle", "severe_market"];

fn now() -> i64 {
    1_790_000_000_000
}

fn engine_on(journal: MemoryJournal) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(MemoryEventBus::default()),
        clock: now,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

fn order(id: &str, account: &str, side: Side) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        parse_amount("2").unwrap(),
        Some(parse_amount("100").unwrap()),
        Tif::Gtc,
    )
}

/// `liveIds`: bids then asks of the market's existing book.
fn live_ids(engine: &MatchingEngine) -> Vec<String> {
    let Some(book) = engine.existing_book(MARKET) else {
        return Vec::new();
    };
    let state = book.to_state();
    let mut ids = Vec::new();
    for side in ["bids", "asks"] {
        let Some(Json::Array(levels)) = state.get(side) else {
            panic!("{side} is an array");
        };
        for level in levels {
            let Some(Json::Array(orders)) = level.get("orders") else {
                panic!("orders is an array");
            };
            for o in orders {
                if let Some(Json::String(id)) = o.get("orderId") {
                    ids.push(id.clone());
                }
            }
        }
    }
    ids
}

fn last_trade_price(engine: &MatchingEngine) -> Option<Json> {
    engine
        .existing_book(MARKET)
        .and_then(|b| b.to_state().get("lastTradePrice").cloned())
}

#[test]
fn normal_submit_still_fills_while_collars_are_unpublished_not_a_hidden_halt() {
    let mut engine = engine_on(MemoryJournal::new());
    let ask = engine
        .submit(MARKET, &order(ASK, "mm", Side::Sell), None)
        .unwrap();
    assert!(ask.accepted, "{:?}", ask.rejected);
    let take = engine
        .submit(MARKET, &order(TAKE, "desk", Side::Buy), None)
        .unwrap();

    assert!(take.accepted);
    assert_eq!(take.fills.len(), 1);
    assert_eq!(take.rejected, None);
}

#[test]
fn journal_does_not_grow_a_fake_collar_record() {
    let mut engine = engine_on(MemoryJournal::new());
    let ask = engine
        .submit(MARKET, &order(ASK, "mm", Side::Sell), None)
        .unwrap();
    assert!(ask.accepted, "{:?}", ask.rejected);

    let kinds: Vec<String> = engine
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect();
    assert!(!kinds.iter().any(|k| FAKE_KINDS.contains(&k.as_str())));

    // A cold start on the same journal: the one ask, nothing traded (`replay(...)` and `recovered`).
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut recovered = engine_on(journal);
    recovered.recover().unwrap();
    assert_eq!(live_ids(&recovered), vec![ASK.to_owned()]);
    assert_eq!(last_trade_price(&recovered), Some(Json::Null));

    // No file journal can hold one: the codec refuses each kind.
    for kind in FAKE_KINDS {
        let record = JournalCommand(Json::obj([
            ("kind", Json::str(kind)),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str("2026-11-22T00:00:00.000Z")),
        ]))
        .with_seq(1);
        assert!(encode(&record).is_err(), "{kind} encodes");
    }
}
