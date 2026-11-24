//! `split-brain.test.ts` (`services/svc-matching/src/engine/`), ported onto the Rust engine. Each test is named after
//! the TypeScript `it` it ports.
//!
//! The fence is `cod-fence.ts`'s: while split-brain is declared, submit and amend refuse `split_brain` before anything is
//! journalled, and cancels stay. The Rust engine holds the fence and reads `split_brain` and `clear_split_brain` back
//! from the journal on a cold start (last record wins, as `replaySplitBrain` does). What it does not have is
//! `declareSplitBrain` and `clearSplitBrain`: no door, no other module and no binary path calls them in the TypeScript,
//! and the port has no such call. So here a declaration is the journal record the TypeScript's `declareSplitBrain`
//! appends (`{ kind: 'split_brain', at, operatorId, confirmOperatorId }`), read by a cold start.
//!
//! Not ported, because the call does not exist in the Rust: "refuses declare when operator or confirm is unset — no
//! journal", "refuses declare when both ids are the same caller — no journal", and the first half of "clear needs two
//! distinct operators; then submits resume" (a same-operator clear refused). The two-person rule they test is
//! `dualControlRefuse`, which the Rust holds as `approval::dual_control_refuse` for every switch that exists
//! (`tests/venue_engine.rs`, the `*_dual_control_*` tests). The second half (after a clear, submits resume) is ported as
//! the replay of a declare then a clear.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::money::parse_amount;
use svc_matching::book::types::{CancelReason, EngineAmend, EngineOrder, OrderType, Side, Tif};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const REST: &str = "11111111-1111-4111-8111-111111111111";
const TAKER: &str = "22222222-2222-4222-8222-222222222222";
const AFTER: &str = "33333333-3333-4333-8333-333333333333";

const SPLIT_BRAIN: &str = "split_brain";

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

fn build() -> MatchingEngine {
    engine_on(MemoryJournal::new())
}

/// The record `declareSplitBrain` / `clearSplitBrain` appends once both operators are distinct.
fn fence(kind: &str, operator: &str, confirm: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str(kind)),
        ("at", Json::str("2026-11-22T00:00:00.000Z")),
        ("operatorId", Json::str(operator)),
        ("confirmOperatorId", Json::str(confirm)),
    ]))
}

/// A cold start on `engine`'s journal with `more` appended after it.
fn reboot_with(engine: &MatchingEngine, more: &[JournalCommand]) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    for c in more {
        journal.append(c).unwrap();
    }
    let mut next = engine_on(journal);
    next.recover().unwrap();
    next
}

fn order(id: &str, side: Side) -> EngineOrder {
    EngineOrder::new(
        id,
        "desk",
        OrderType::Limit,
        side,
        parse_amount("1").unwrap(),
        Some(parse_amount("100").unwrap()),
        Tif::Gtc,
    )
}

fn rested() -> MatchingEngine {
    let mut engine = build();
    let r = engine
        .submit(MARKET, &order(REST, Side::Sell), None)
        .unwrap();
    assert!(r.accepted, "{:?}", r.rejected);
    engine
}

#[test]
fn declared_split_brain_refuses_submit_and_amend_journals_nothing_for_those_cancels_stay() {
    let mut engine = reboot_with(&rested(), &[fence("split_brain", "ops-1", "ops-2")]);
    assert!(engine.is_split_brain());

    let before = engine.journal().len();
    let submit = engine
        .submit(MARKET, &order(TAKER, Side::Buy), None)
        .unwrap();
    assert!(!submit.accepted);
    assert_eq!(submit.rejected.as_ref().unwrap().code, SPLIT_BRAIN);
    assert_eq!(submit.sequence, None);
    assert!(submit.fills.is_empty());

    let amended = engine
        .amend(
            MARKET,
            &EngineAmend {
                order_id: REST.to_owned(),
                expected_version: 1,
                qty: Some(parse_amount("2").unwrap()),
                ..EngineAmend::default()
            },
            None,
        )
        .unwrap();
    assert!(!amended.accepted);
    assert_eq!(amended.rejected.as_ref().unwrap().code, SPLIT_BRAIN);
    assert_eq!(engine.journal().len(), before);
    // The rest is untouched: the refused amend changed nothing.
    let live = engine.resting_orders(Some(MARKET));
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].remaining, parse_amount("1").unwrap());

    let cancelled = engine
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert!(cancelled.cancelled);
}

#[test]
fn replays_split_brain_so_a_recovered_engine_still_refuses_order_entry() {
    let mut recovered = reboot_with(&rested(), &[fence("split_brain", "ops-1", "ops-2")]);

    assert!(recovered.is_split_brain());
    assert!(recovered.has_market(MARKET));

    let blocked = recovered
        .submit(MARKET, &order(TAKER, Side::Buy), None)
        .unwrap();
    assert!(!blocked.accepted);
    assert_eq!(blocked.rejected.as_ref().unwrap().code, SPLIT_BRAIN);
}

/// Also the second half of "clear needs two distinct operators; then submits resume" (header).
#[test]
fn replay_of_declare_then_clear_leaves_order_entry_open() {
    let mut recovered = reboot_with(
        &build(),
        &[
            fence("split_brain", "ops-1", "ops-2"),
            fence("clear_split_brain", "ops-2", "ops-3"),
        ],
    );
    assert!(!recovered.is_split_brain());

    let result = recovered
        .submit(MARKET, &order(AFTER, Side::Sell), None)
        .unwrap();
    assert!(result.accepted, "{:?}", result.rejected);
}

/// `replaySplitBrain`'s last-write-wins, the other way round: a clear followed by a later declare is declared.
#[test]
fn replay_last_split_brain_record_wins() {
    let recovered = reboot_with(
        &build(),
        &[
            fence("split_brain", "ops-1", "ops-2"),
            fence("clear_split_brain", "ops-2", "ops-3"),
            fence("split_brain", "ops-1", "ops-3"),
        ],
    );
    assert!(recovered.is_split_brain());
}
