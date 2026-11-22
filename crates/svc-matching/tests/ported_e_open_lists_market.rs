//! Ported from the TypeScript service's `engine/open-lists-market.test.ts`: an approved OPEN is what lists a market, so
//! svc-trade (which refuses an order on a market svc-matching does not list) can send a never-traded market its first
//! order. The listing is control state, journalled and replayed, never an invented book. Each test is named after the
//! `it` it ports, against `MatchingEngine::switch` as `index.ts` composes it.
//!
//! As in `tests/venue_engine.rs`, every switch carries an evidence ref and a delisting policy (`cmd`): the composed
//! switch asks the expiry for evidence and the delisting for a policy, which the TypeScript's bare engine did not.
//!
//! Not ported, and why:
//! - "an opened market with no orders reads as an empty ladder": its line `depth(MARKET, null)` throws "refuse to
//!   invent 50". Here the window is a required `usize` (`MatchingEngine::depth`), held by the type; the rest of the test
//!   is ported.
//! - `replayOpenedMarkets(journal.read())` in "survives a restart": a TypeScript replay helper; here replay is the
//!   engine's cold start, and the recovered engine's `markets` and `is_listed` are asserted.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::money::parse_amount;
use svc_matching::book::types::{EngineOrder, OrderType, Side, SubmitResult, Tif};
use svc_matching::engine::venue::{Switch, SwitchCmd, SwitchResult};
use svc_matching::engine::{Depth, EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const OTHER: &str = "ETH/USDT";
const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const MARKET_HALTED: &str = "market_halted";

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

/// `build()`: a fresh engine on an empty journal.
fn build() -> MatchingEngine {
    engine_on(MemoryJournal::new())
}

/// `build(journal)` then `recover()`: a cold start on a copy of the engine's journal.
fn reboot(engine: &MatchingEngine) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut next = engine_on(journal);
    next.recover().unwrap();
    next
}

fn cmd(operator: Option<&str>, confirm: Option<&str>) -> SwitchCmd {
    SwitchCmd {
        operator_id: operator.map(str::to_owned),
        confirm_operator_id: confirm.map(str::to_owned),
        evidence: Some("incident-42".to_owned()),
        policy_id: Some("policy-7".to_owned()),
        ..SwitchCmd::default()
    }
}

/// `DUAL`: `{ operatorId: 'ops-1', confirmOperatorId: 'ops-2' }`.
fn dual() -> SwitchCmd {
    cmd(Some("ops-1"), Some("ops-2"))
}

fn sw(engine: &mut MatchingEngine, s: Switch, market: &str, c: &SwitchCmd) -> SwitchResult {
    engine.switch(s, market, c).unwrap()
}

fn limit(id: &str, side: Side, qty: &str, price: &str, tif: Tif) -> EngineOrder {
    EngineOrder::new(
        id,
        "desk",
        OrderType::Limit,
        side,
        parse_amount(qty).unwrap(),
        Some(parse_amount(price).unwrap()),
        tif,
    )
}

fn submit(engine: &mut MatchingEngine, side: Side, tif: Tif) -> SubmitResult {
    engine
        .submit(MARKET, &limit(FIRST, side, "1", "100", tif), None)
        .unwrap()
}

fn listed(markets: &[&str]) -> Vec<String> {
    markets.iter().map(|m| (*m).to_owned()).collect()
}

#[test]
fn lists_an_opened_market_that_has_never_taken_an_order_so_trade_can_send_the_first_one() {
    let mut engine = build();
    assert!(!engine.markets().contains(&MARKET.to_owned()));

    let opened = sw(&mut engine, Switch::Open, MARKET, &dual());

    assert!(opened.accepted);
    assert_eq!(engine.markets(), listed(&[MARKET]));
    assert!(engine.is_listed(MARKET));
    assert!(!engine.is_listed(OTHER));
}

#[test]
fn the_listed_market_takes_its_first_order_and_stays_listed_when_the_empty_never_traded_book_is_dropped()
 {
    let mut engine = build();
    sw(&mut engine, Switch::Open, MARKET, &dual());

    let first = submit(&mut engine, Side::Sell, Tif::Gtc);
    assert!(first.accepted);
    assert!(engine.has_market(MARKET));

    // An IOC that cannot fill leaves an empty never-traded book: dropped.
    let mut other = build();
    sw(&mut other, Switch::Open, MARKET, &dual());
    submit(&mut other, Side::Buy, Tif::Ioc);
    assert!(!other.has_market(MARKET));
    assert_eq!(other.markets(), listed(&[MARKET]));
}

#[test]
fn an_opened_market_with_no_orders_reads_as_an_empty_ladder_so_its_first_order_can_be_checked() {
    let mut engine = build();
    assert_eq!(engine.depth(MARKET, 50), None);

    sw(&mut engine, Switch::Open, MARKET, &dual());

    assert_eq!(
        engine.depth(MARKET, 50),
        Some(Depth {
            bids: Vec::new(),
            asks: Vec::new(),
            sequence: 0,
        })
    );
    assert_eq!(engine.depth(OTHER, 50), None);

    let first = submit(&mut engine, Side::Buy, Tif::Gtc);
    assert!(first.accepted);
    assert_eq!(
        engine.depth(MARKET, 50).unwrap().bids,
        vec![(parse_amount("100").unwrap(), parse_amount("1").unwrap())]
    );
}

#[test]
fn a_delisted_or_expired_empty_market_has_no_ladder() {
    let mut engine = build();
    sw(&mut engine, Switch::Open, MARKET, &dual());
    sw(&mut engine, Switch::Open, OTHER, &dual());
    assert!(sw(&mut engine, Switch::Delist, MARKET, &dual()).accepted);
    assert!(sw(&mut engine, Switch::Expire, OTHER, &dual()).accepted);

    assert_eq!(engine.depth(MARKET, 50), None);
    assert_eq!(engine.depth(OTHER, 50), None);
}

#[test]
fn survives_a_restart_a_recovered_engine_still_lists_the_opened_empty_market() {
    let mut engine = build();
    sw(&mut engine, Switch::Open, MARKET, &dual());

    let recovered = reboot(&engine);

    assert_eq!(recovered.markets(), listed(&[MARKET]));
    assert!(recovered.is_listed(MARKET));
}

#[test]
fn prelaunch_alone_does_not_list_open_after_prelaunch_does() {
    let mut engine = build();
    assert!(sw(&mut engine, Switch::Prelaunch, MARKET, &dual()).accepted);
    assert!(!engine.markets().contains(&MARKET.to_owned()));

    sw(&mut engine, Switch::Open, MARKET, &dual());
    assert_eq!(engine.markets(), listed(&[MARKET]));
}

#[test]
fn an_unapproved_open_missing_or_same_confirm_operator_lists_nothing_and_journals_nothing() {
    let mut engine = build();

    let same = sw(
        &mut engine,
        Switch::Open,
        MARKET,
        &cmd(Some("ops-1"), Some("ops-1")),
    );
    let missing = sw(&mut engine, Switch::Open, MARKET, &cmd(Some("ops-1"), None));

    assert!(!same.accepted);
    assert!(!missing.accepted);
    assert!(engine.markets().is_empty());
    assert!(!engine.is_listed(MARKET));
    assert_eq!(engine.journal().len(), 0);
}

#[test]
fn a_halted_opened_market_stays_listed_and_still_refuses_as_halted() {
    let mut engine = build();
    sw(&mut engine, Switch::Open, MARKET, &dual());
    assert!(sw(&mut engine, Switch::Halt, MARKET, &dual()).accepted);

    assert_eq!(engine.markets(), listed(&[MARKET]));
    let refused = submit(&mut engine, Side::Sell, Tif::Gtc);
    assert!(!refused.accepted);
    assert_eq!(refused.rejected.unwrap().code, MARKET_HALTED);
}

#[test]
fn a_delisted_or_expired_empty_market_is_not_listed_before_or_after_a_restart() {
    let mut engine = build();
    sw(&mut engine, Switch::Open, MARKET, &dual());
    sw(&mut engine, Switch::Open, OTHER, &dual());
    assert!(sw(&mut engine, Switch::Delist, MARKET, &dual()).accepted);
    assert!(sw(&mut engine, Switch::Expire, OTHER, &dual()).accepted);

    assert!(engine.markets().is_empty());

    let recovered = reboot(&engine);
    assert!(recovered.markets().is_empty());
}
