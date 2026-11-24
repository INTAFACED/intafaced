//! `halt-law.test.ts` (`services/svc-matching/src/engine/`), ported test for test onto the Rust engine. Each test is
//! named after the TypeScript `it` it ports. The halt is [`MatchingEngine::switch`] as `index.ts` composes it, so each
//! switch carries a confirming operator, an evidence ref and a delisting policy (as `tests/venue_engine.rs` does).
//!
//! `halt-law.ts` adds one call, `engine.restart(marketId)`, which no door, no other module and the binary never reach:
//! the port has no such call. Its law, that a restart never reopens a halted market, is held here by the restart the
//! Rust has, a cold start: a fresh engine on the same journal, recovered. So the two `restart` tests are ported with the
//! cold start in place of `restart`; `halt_restart_open` itself, the refusal code of the missing call, is not ported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::money::parse_amount;
use svc_matching::book::types::{EngineOrder, OrderType, Side, SubmitResult, Tif};
use svc_matching::engine::venue::{Switch, SwitchCmd, SwitchResult};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const REST: &str = "11111111-1111-4111-8111-111111111111";
const TAKER: &str = "22222222-2222-4222-8222-222222222222";
const AFTER: &str = "44444444-4444-4444-8444-444444444444";
const PO: &str = "55555555-5555-4555-8555-555555555555";
const RO: &str = "66666666-6666-4666-8666-666666666666";

const MARKET_HALTED: &str = "market_halted";
const MARKET_REDUCE_ONLY: &str = "market_reduce_only";
const MARKET_POST_ONLY: &str = "market_post_only";

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

/// `new MatchingEngine({ journal, bus: new MemoryEventBus(...), snapshotEvery: 0 }).recover()`: the cold start.
fn reboot(engine: &MatchingEngine) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut next = engine_on(journal);
    next.recover().unwrap();
    next
}

fn ops(operator: &str, confirm: &str) -> SwitchCmd {
    SwitchCmd {
        operator_id: Some(operator.to_owned()),
        confirm_operator_id: Some(confirm.to_owned()),
        evidence: Some("incident-42".to_owned()),
        policy_id: Some("policy-7".to_owned()),
        ..SwitchCmd::default()
    }
}

fn halt(engine: &mut MatchingEngine) -> SwitchResult {
    engine
        .switch(Switch::Halt, MARKET, &ops("ops-1", "ops-2"))
        .unwrap()
}

fn order(id: &str, account: &str, side: Side, price: &str, tif: Tif) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        parse_amount("1").unwrap(),
        Some(parse_amount(price).unwrap()),
        tif,
    )
}

fn submit(engine: &mut MatchingEngine, o: &EngineOrder) -> SubmitResult {
    engine.submit(MARKET, o, None).unwrap()
}

fn rest(engine: &mut MatchingEngine) {
    let r = submit(engine, &order(REST, "desk", Side::Sell, "100", Tif::Gtc));
    assert!(r.accepted, "{:?}", r.rejected);
}

fn code(r: &SubmitResult) -> &str {
    &r.rejected.as_ref().unwrap().code
}

/// `engine.book(marketId).toState().asks[0]?.orders[0]?.orderId`.
fn live_ask_id(engine: &MatchingEngine) -> Option<String> {
    let state = engine.existing_book(MARKET)?.to_state();
    let Some(Json::Array(asks)) = state.get("asks") else {
        return None;
    };
    let Some(Json::Array(orders)) = asks.first()?.get("orders") else {
        return None;
    };
    match orders.first()?.get("orderId") {
        Some(Json::String(id)) => Some(id.clone()),
        _ => None,
    }
}

fn kinds(engine: &MatchingEngine) -> Vec<String> {
    engine
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

#[test]
fn halt_leaves_a_resting_order_live_journal_has_halt_not_a_cancel_of_that_id() {
    let mut engine = build();
    rest(&mut engine);
    let result = halt(&mut engine);

    assert!(result.accepted);
    assert!(engine.flags(MARKET).halted);
    assert_eq!(live_ask_id(&engine).as_deref(), Some(REST));
    assert!(
        engine
            .resting_orders(Some(MARKET))
            .iter()
            .any(|o| o.order_id == REST)
    );

    let records = engine.journal().read();
    assert!(
        records
            .iter()
            .any(|r| r.kind() == Some("halt") && r.field("marketId") == Some(&Json::str(MARKET)))
    );
    assert!(!records.iter().any(|r| r.kind() == Some("cancel")));
    // `replay(journal.read()).get(MARKET)`: the book a cold start rebuilds still holds the rest.
    assert_eq!(live_ask_id(&reboot(&engine)).as_deref(), Some(REST));
}

#[test]
fn halt_is_not_reduce_only_or_post_only_po_and_gtc_submits_refuse_market_halted() {
    let mut engine = build();
    rest(&mut engine);
    halt(&mut engine);

    let flags = engine.flags(MARKET);
    assert!(flags.halted);
    assert!(!flags.reduce_only);
    assert!(!flags.post_only);

    let gtc = submit(
        &mut engine,
        &order(TAKER, "desk", Side::Buy, "100", Tif::Gtc),
    );
    assert!(!gtc.accepted);
    assert_eq!(code(&gtc), MARKET_HALTED);
    assert_ne!(code(&gtc), MARKET_REDUCE_ONLY);
    assert_ne!(code(&gtc), MARKET_POST_ONLY);

    let po = submit(&mut engine, &order(PO, "desk", Side::Buy, "99", Tif::Po));
    assert!(!po.accepted);
    assert_eq!(code(&po), MARKET_HALTED);

    let mut reducing = order(RO, "desk", Side::Sell, "101", Tif::Gtc);
    reducing.reduce_only = true;
    let reducing = submit(&mut engine, &reducing);
    assert!(!reducing.accepted);
    assert_eq!(code(&reducing), MARKET_HALTED);

    assert_eq!(live_ask_id(&engine).as_deref(), Some(REST));
}

#[test]
fn recover_of_a_halted_journal_stays_halted_does_not_invent_open() {
    let mut engine = build();
    rest(&mut engine);
    halt(&mut engine);

    let mut recovered = reboot(&engine);

    assert!(recovered.flags(MARKET).halted);
    assert_eq!(live_ask_id(&recovered).as_deref(), Some(REST));

    let blocked = submit(
        &mut recovered,
        &order(TAKER, "desk", Side::Buy, "100", Tif::Gtc),
    );
    assert!(!blocked.accepted);
    assert_eq!(code(&blocked), MARKET_HALTED);
}

/// `restart` is the cold start (header): it appends nothing, so no resume and no cancel; the market stays halted and
/// the rest stays.
#[test]
fn restart_while_halted_still_halted_rest_stays_no_resume_or_cancel_journalled() {
    let mut engine = build();
    rest(&mut engine);
    halt(&mut engine);
    let before = engine.journal().len();

    let restarted = reboot(&engine);

    assert!(restarted.flags(MARKET).halted);
    assert_eq!(live_ask_id(&restarted).as_deref(), Some(REST));
    assert_eq!(restarted.journal().len(), before);
    assert!(!kinds(&restarted).iter().any(|k| k == "resume"));
    assert!(!kinds(&restarted).iter().any(|k| k == "cancel"));
}

#[test]
fn explicit_resume_is_the_only_way_back_to_live_submits() {
    let mut engine = build();
    rest(&mut engine);
    halt(&mut engine);

    let mut engine = reboot(&engine);
    assert!(engine.flags(MARKET).halted);
    let blocked = submit(
        &mut engine,
        &order(TAKER, "desk", Side::Buy, "100", Tif::Gtc),
    );
    assert!(!blocked.accepted);
    assert_eq!(code(&blocked), MARKET_HALTED);

    let resume = engine
        .switch(Switch::Resume, MARKET, &ops("ops-2", "ops-3"))
        .unwrap();
    assert!(resume.accepted);
    assert!(!engine.flags(MARKET).halted);

    let live = submit(
        &mut engine,
        &order(AFTER, "taker", Side::Buy, "100", Tif::Gtc),
    );
    assert!(live.accepted, "{:?}", live.rejected);
    assert_eq!(live.fills.len(), 1);
}
