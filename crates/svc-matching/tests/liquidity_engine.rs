//! The `liquidity` slice's engine calls, ported test for test from the TypeScript engine tests under
//! `services/svc-matching/src/engine/`: `ifm.test.ts`, `ifm-crash.test.ts`, `mass-quote.test.ts`, `mmp.test.ts`,
//! `auction-uncross.test.ts` and `liquidity.test.ts`. Each test is named after its TypeScript `it`, prefixed with the
//! file's topic. The TypeScript `replay(records)` is the engine's cold start over a copy of the same journal.
//!
//! Where the port differs, by test:
//! - The TypeScript's injected throws (`engine.cancel = ...`, `engine.submit = ...`) are made here the way they happen
//!   in the service: a journal that refuses the cancel record (the cancel fails with the order still live) and a bus
//!   that refuses the bid's `orderAccepted` (the submit fails after the book took the order).
//! - `ifm.test.ts`'s read helpers (`persistInFlight`, `persistIfmQty`, `readIfmQty`, `parseIfmQty`) are the journal
//!   codec's (`tests/journal_codec.rs` holds `inFlight` and `qty`) and the engine's own cold start, which reads the
//!   marks; `replayInFlight([])` is a cold start over an empty journal. They are checked through what the engine does.
//! - `mmp.test.ts`'s "no `MATCHING_MMP_` env invented" and `liquidity.test.ts`'s `MATCHING_REBATE_PROGRAM` check read
//!   `src/env.rs`, which names no such variable (`tests/env_parity.rs` holds it to `env.ts`); here the process
//!   environment is read the same way.
//! - `sourcedDepth` without a limit throws in the TypeScript; the window is a required `usize` here, so that refusal is
//!   held by the type. A blank-magnitude MMP (`mmpMaxDelta: ''`) is a present magnitude here (`MmpIntent::magnitude`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use svc_matching::book::types::{CancelReason, EngineAmend, EngineOrder, OrderType, Side, Tif};
use svc_matching::engine::liquidity::{
    DepthSource, MassQuote, MassQuoteResult, QuoteSide, apply_mmp, mmp_magnitudes_unset,
    pay_rebate, quality_telemetry, rebate_program_unset, uncrossing_rules_unset,
};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::journal::replay::MemorySnapshotSink;
use svc_matching::journal::{
    EngineJournal, FileJournal, JournalCommand, JournalError, JournalRecord, MemoryJournal,
};

const MARKET: &str = "BTC/USDT";
const REST: &str = "11111111-1111-4111-8111-111111111111";
const TAKE: &str = "22222222-2222-4222-8222-222222222222";
const ASK3: &str = "33333333-3333-4333-8333-333333333333";

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn clock() -> i64 {
    1_787_000_000_000
}

/// A bus the test reads after handing it to the engine.
#[derive(Clone, Default)]
struct Bus {
    seen: Arc<Mutex<Vec<Published>>>,
    /// Refuse this order's `orderAccepted`, after the book took it.
    refuse_accepted_of: Option<&'static str>,
}

impl EventBus for Bus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        if name == "orderAccepted"
            && let Some(id) = self.refuse_accepted_of
            && payload.get("orderId") == Some(&Json::str(id))
        {
            return Err("submit boom".to_owned());
        }
        let mut inner = MemoryEventBus::default();
        inner.publish(name, payload, key)?;
        self.seen.lock().unwrap().extend(inner.published);
        Ok(())
    }
}

impl Bus {
    fn emitted(&self, name: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == name)
            .count()
    }
}

/// `BoomOnMutation`: the `in_flight` record is durable, then the journal refuses the record of this kind (and, with
/// `order`, only that order's).
struct Boom {
    inner: MemoryJournal,
    kind: &'static str,
    order: Option<&'static str>,
}

impl EngineJournal for Boom {
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        let c = &command.0;
        if c.get("kind") == Some(&Json::str(self.kind))
            && self
                .order
                .is_none_or(|id| c.get("orderId") == Some(&Json::str(id)))
        {
            return Err(JournalError::IoUnknown);
        }
        self.inner.append(command)
    }
    fn read(&self) -> &[JournalRecord] {
        self.inner.read()
    }
    fn len(&self) -> usize {
        self.inner.len()
    }
    fn close(&mut self) -> Result<(), JournalError> {
        Ok(())
    }
}

fn engine_on(journal: Box<dyn EngineJournal + Send>, bus: Bus) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(bus),
        clock,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    })
}

fn build() -> (MatchingEngine, Bus) {
    let bus = Bus::default();
    (engine_on(Box::new(MemoryJournal::new()), bus.clone()), bus)
}

fn boom(kind: &'static str) -> (MatchingEngine, Bus) {
    let bus = Bus::default();
    let journal = Boom {
        inner: MemoryJournal::new(),
        kind,
        order: None,
    };
    (engine_on(Box::new(journal), bus.clone()), bus)
}

fn limit(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

fn no_price(id: &str, side: Side) -> EngineOrder {
    EngineOrder::new(id, "desk", OrderType::Limit, side, a("1"), None, Tif::Gtc)
}

fn amend_price(id: &str, price: &str) -> EngineAmend {
    EngineAmend {
        order_id: id.to_owned(),
        expected_version: 1,
        price: Some(a(price)),
        ..EngineAmend::default()
    }
}

fn amend_qty(id: &str, qty: &str) -> EngineAmend {
    EngineAmend {
        order_id: id.to_owned(),
        expected_version: 1,
        qty: Some(a(qty)),
        ..EngineAmend::default()
    }
}

fn live_ids(engine: &MatchingEngine, market: &str) -> Vec<String> {
    let mut ids: Vec<String> = engine
        .resting_orders(Some(market))
        .into_iter()
        .map(|o| o.order_id)
        .collect();
    ids.sort();
    ids
}

fn ids(list: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = list.iter().map(|s| (*s).to_owned()).collect();
    v.sort();
    v
}

fn code(r: Option<&svc_matching::book::types::Reject>) -> Option<&str> {
    r.map(|r| r.code.as_str())
}

/// `replay(records)`: a cold start over a copy of these records.
fn replay(records: &[JournalRecord]) -> MatchingEngine {
    let mut journal = MemoryJournal::new();
    for r in records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut engine = engine_on(Box::new(journal), Bus::default());
    engine.recover().unwrap();
    engine
}

fn temp_path(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("engine.ndjson")
}

fn in_flight(order_id: &str, mutation: &str, qty: &str, at: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str("in_flight")),
        ("marketId", Json::str(MARKET)),
        ("at", Json::str(at)),
        ("orderId", Json::str(order_id)),
        ("mutation", Json::str(mutation)),
        ("inFlight", Json::Bool(true)),
        ("qty", Json::str(qty)),
    ]))
}

/// A file journal holding one live order and then an `in_flight` mark for it with no cancel or amend after: the crash
/// window. Returns its path.
fn crash_window(side: Side, qty: &str, mutation: &str) -> std::path::PathBuf {
    let path = temp_path("matching-ifm-crash-");
    {
        let mut live = engine_on(Box::new(FileJournal::open(&path).unwrap()), Bus::default());
        live.submit(MARKET, &limit(REST, "desk", side, qty, "100"), None)
            .unwrap();
    }
    let mut j1 = FileJournal::open(&path).unwrap();
    j1.append(&in_flight(REST, mutation, qty, "2026-09-03T00:00:01.000Z"))
        .unwrap();
    assert!(!j1.read().iter().any(|r| r.kind() == Some("cancel")));
    j1.close().unwrap();
    path
}

fn recovered_from(path: &std::path::Path) -> MatchingEngine {
    let mut engine = engine_on(Box::new(FileJournal::open(path).unwrap()), Bus::default());
    engine.recover().unwrap();
    engine
}

fn has_cancel(engine: &MatchingEngine) -> bool {
    engine
        .journal()
        .read()
        .iter()
        .any(|r| r.kind() == Some("cancel"))
}

// ── ifm.test.ts ─────────────────────────────────────────────────────────

#[test]
fn ifm_refuses_a_second_live_submit_of_the_same_order_id_while_cancel_is_in_flight() {
    let (mut engine, _) = boom("cancel");
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "100"), None)
        .unwrap();
    let e = engine
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap_err();
    assert!(e.to_string().contains("journal"));

    let second = engine
        .submit(MARKET, &limit(REST, "other", Side::Sell, "4", "99"), None)
        .unwrap();
    assert!(!second.accepted);
    assert_eq!(code(second.rejected.as_ref()), Some("in_flight"));
    assert!(second.fills.is_empty());
    assert!(second.resting.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
    assert_eq!(engine.resting_orders(Some(MARKET)).len(), 1);
}

#[test]
fn ifm_refuses_a_second_amend_so_a_duplicate_fill_is_not_emitted() {
    let (mut engine, bus) = boom("amend");
    engine
        .submit(MARKET, &limit(ASK3, "mm", Side::Sell, "1", "100"), None)
        .unwrap();
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Buy, "1", "90"), None)
        .unwrap();
    assert!(
        engine
            .amend(MARKET, &amend_price(REST, "100"), None)
            .is_err()
    );

    let second = engine
        .amend(MARKET, &amend_price(REST, "100"), None)
        .unwrap();
    assert!(!second.accepted);
    assert_eq!(code(second.rejected.as_ref()), Some("in_flight"));
    assert!(second.fills.is_empty());
    assert_eq!(bus.emitted("orderFilled"), 0);
    assert_eq!(live_ids(&engine, MARKET), ids(&[ASK3, REST]));
}

#[test]
fn ifm_refuses_a_second_cancel_while_the_first_is_unconfirmed() {
    let (mut engine, _) = boom("cancel");
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Buy, "1", "100"), None)
        .unwrap();
    assert!(
        engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .is_err()
    );

    let second = engine
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert!(!second.cancelled);
    assert_eq!(code(second.rejected.as_ref()), Some("in_flight"));
    assert!(second.cancellation.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
}

#[test]
fn ifm_unknown_in_flight_refuses_further_mutation_and_does_not_invent_a_reconstructed_book() {
    let path = crash_window(Side::Sell, "2", "cancel");
    let mut recovered = recovered_from(&path);

    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
    let books = replay(recovered.journal().read());
    assert_eq!(books.resting_orders(Some(MARKET)).len(), 1);

    let cancel = recovered
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert!(!cancel.cancelled);
    assert_eq!(code(cancel.rejected.as_ref()), Some("in_flight_unknown"));

    let amend = recovered
        .amend(MARKET, &amend_qty(REST, "1"), None)
        .unwrap();
    assert!(!amend.accepted);
    assert_eq!(code(amend.rejected.as_ref()), Some("in_flight_unknown"));
    assert!(amend.fills.is_empty());

    let second = recovered
        .submit(MARKET, &limit(REST, "other", Side::Sell, "9", "50"), None)
        .unwrap();
    assert!(!second.accepted);
    assert_eq!(code(second.rejected.as_ref()), Some("in_flight_unknown"));
    assert!(second.fills.is_empty());
    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
}

#[test]
fn ifm_persists_in_flight_and_decimal_qty_so_a_crash_cannot_rest_a_second_live_order() {
    let path = temp_path("matching-ifm-");
    let qty = "1.5";
    let mut j1 = FileJournal::open(&path).unwrap();
    let rest = limit(REST, "desk", Side::Sell, qty, "100");
    j1.append(&JournalCommand(Json::obj([
        ("kind", Json::str("submit")),
        ("marketId", Json::str(MARKET)),
        ("at", Json::str("2026-09-01T00:00:00.000Z")),
        ("order", svc_matching::book::wire::to_wire(&rest, None)),
    ])))
    .unwrap();
    j1.append(&in_flight(REST, "amend", qty, "2026-09-01T00:00:01.000Z"))
        .unwrap();
    j1.close().unwrap();

    let on_disk: Vec<Json> = std::fs::read_to_string(&path)
        .unwrap()
        .trim()
        .split('\n')
        .map(|l| service_kit::json::parse(l).unwrap())
        .collect();
    assert_eq!(on_disk[1].get("kind"), Some(&Json::str("in_flight")));
    assert_eq!(on_disk[1].get("inFlight"), Some(&Json::Bool(true)));
    assert_eq!(on_disk[1].get("qty"), Some(&Json::str("1.5")));

    let mut recovered = recovered_from(&path);
    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
    assert_eq!(recovered.resting_orders(Some(MARKET)).len(), 1);
    assert_eq!(
        recovered.resting_orders(Some(MARKET))[0].remaining,
        a("1.5")
    );
    // `replayInFlight(...).get(REST).status === 'unknown'`: the mark reads back as unknown.
    let r = recovered
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert_eq!(code(r.rejected.as_ref()), Some("in_flight_unknown"));
}

#[test]
fn ifm_clears_in_flight_after_a_confirmed_cancel_so_a_later_submit_of_that_id_can_rest_once() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "100"), None)
        .unwrap();
    let cancelled = engine
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert!(cancelled.cancelled);

    let again = engine
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "101"), None)
        .unwrap();
    assert!(again.accepted);
    assert!(again.rejected.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
}

#[test]
fn ifm_confirmed_amend_then_take_emits_one_fill_not_a_duplicate() {
    let (mut engine, bus) = build();
    engine
        .submit(MARKET, &limit(ASK3, "mm", Side::Sell, "1", "100"), None)
        .unwrap();
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Buy, "1", "90"), None)
        .unwrap();
    let amended = engine
        .amend(MARKET, &amend_price(REST, "100"), None)
        .unwrap();
    assert!(amended.accepted);
    assert_eq!(amended.fills.len(), 1);
    assert_eq!(amended.fills[0].qty, a("1"));
    assert_eq!(bus.emitted("orderFilled"), 1);

    let extra = engine
        .submit(MARKET, &limit(TAKE, "desk", Side::Buy, "1", "100"), None)
        .unwrap();
    assert!(extra.fills.is_empty());
}

#[test]
fn ifm_read_helpers_treat_missing_as_not_set() {
    // `replayInFlight([]).size === 0`: a cold start over nothing marks nothing.
    let mut empty = replay(&[]);
    let r = empty
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "100"), None)
        .unwrap();
    assert!(r.accepted);
    // `persistInFlight({ inFlight: false })` is false: an `in_flight` record without the flag still marks the order
    // for the base engine (`replayInFlight` reads every one), but not for the crash store, so the refusal comes at the
    // base engine's place and is still unknown.
    let mut journal = MemoryJournal::new();
    let rest = limit(REST, "desk", Side::Sell, "1", "100");
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("submit")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str("2026-09-01T00:00:00.000Z")),
            ("order", svc_matching::book::wire::to_wire(&rest, None)),
        ])))
        .unwrap();
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("in_flight")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str("2026-09-01T00:00:01.000Z")),
            ("orderId", Json::str(REST)),
            ("mutation", Json::str("cancel")),
        ])))
        .unwrap();
    let mut engine = engine_on(Box::new(journal), Bus::default());
    engine.recover().unwrap();
    let r = engine
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert_eq!(code(r.rejected.as_ref()), Some("in_flight_unknown"));
}

// ── ifm-crash.test.ts ───────────────────────────────────────────────────

#[test]
fn ifm_crash_file_journal_encode_of_in_flight_includes_in_flight_true_and_decimal_qty() {
    let path = temp_path("matching-ifm-crash-");
    let mut journal = FileJournal::open(&path).unwrap();
    journal
        .append(&in_flight(
            REST,
            "cancel",
            "1.5",
            "2026-09-03T00:00:00.000Z",
        ))
        .unwrap();
    journal.close().unwrap();
    let on_disk: Vec<Json> = std::fs::read_to_string(&path)
        .unwrap()
        .trim()
        .split('\n')
        .map(|l| service_kit::json::parse(l).unwrap())
        .collect();
    assert_eq!(on_disk.len(), 1);
    assert_eq!(on_disk[0].get("kind"), Some(&Json::str("in_flight")));
    assert_eq!(on_disk[0].get("inFlight"), Some(&Json::Bool(true)));
    assert_eq!(on_disk[0].get("qty"), Some(&Json::str("1.5")));
}

#[test]
fn ifm_crash_crash_window_recover_leaves_rest_live_no_invented_cancel_mutations_in_flight_unknown()
{
    let path = crash_window(Side::Sell, "2", "cancel");
    let mut recovered = engine_on(Box::new(FileJournal::open(&path).unwrap()), Bus::default());
    let before = recovered.journal().len();
    recovered.recover().unwrap();
    assert_eq!(recovered.journal().len(), before);
    assert!(!has_cancel(&recovered));
    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
    assert_eq!(recovered.resting_orders(Some(MARKET)).len(), 1);

    let cancel = recovered
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert!(!cancel.cancelled);
    assert_eq!(code(cancel.rejected.as_ref()), Some("in_flight_unknown"));
    assert!(cancel.cancellation.is_none());

    let amend = recovered
        .amend(MARKET, &amend_qty(REST, "1"), None)
        .unwrap();
    assert!(!amend.accepted);
    assert_eq!(code(amend.rejected.as_ref()), Some("in_flight_unknown"));
    assert!(amend.fills.is_empty());

    let second = recovered
        .submit(MARKET, &limit(REST, "other", Side::Sell, "9", "50"), None)
        .unwrap();
    assert!(!second.accepted);
    assert_eq!(code(second.rejected.as_ref()), Some("in_flight_unknown"));
    assert!(second.fills.is_empty());
    assert!(second.resting.is_none());
    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
    assert_eq!(recovered.resting_orders(Some(MARKET)).len(), 1);
    assert!(!has_cancel(&recovered));

    let books = replay(recovered.journal().read());
    assert_eq!(live_ids(&books, MARKET), ids(&[REST]));
}

#[test]
fn ifm_crash_replay_of_crash_window_journal_does_not_drop_the_rest_and_does_not_emit_a_cancel() {
    let path = crash_window(Side::Buy, "1", "amend");
    let j2 = FileJournal::open(&path).unwrap();
    let records = j2.read().to_vec();
    drop(j2);
    assert!(!records.iter().any(|r| r.kind() == Some("cancel")));
    let bus = Bus::default();
    let mut journal = MemoryJournal::new();
    for r in &records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    let mut books = engine_on(Box::new(journal), bus.clone());
    books.recover().unwrap();
    assert_eq!(live_ids(&books, MARKET), ids(&[REST]));
    assert_eq!(bus.emitted("orderCancelled"), 0);
}

#[test]
fn ifm_crash_confirmed_cancel_after_a_clean_path_still_clears_so_a_later_submit_of_that_id_can_rest_once()
 {
    let path = temp_path("matching-ifm-crash-");
    let mut engine = engine_on(Box::new(FileJournal::open(&path).unwrap()), Bus::default());
    engine
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "100"), None)
        .unwrap();
    assert!(
        engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap()
            .cancelled
    );
    assert!(live_ids(&engine, MARKET).is_empty());
    let again = engine
        .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "101"), None)
        .unwrap();
    assert!(again.accepted);
    assert!(again.rejected.is_none());
    assert!(again.fills.is_empty());
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
}

// ── mass-quote.test.ts ──────────────────────────────────────────────────

const BID: &str = "11111111-1111-4111-8111-111111111111";
const ASK: &str = "22222222-2222-4222-8222-222222222222";
const SET: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn quote(
    set_id: &str,
    one_sided: bool,
    bid: Option<EngineOrder>,
    ask: Option<EngineOrder>,
) -> MassQuote {
    MassQuote {
        set_id: set_id.to_owned(),
        market_id: MARKET.to_owned(),
        account_id: "desk".to_owned(),
        one_sided,
        bid,
        ask,
        lifecycle_proof: None,
    }
}

fn statuses(r: &MassQuoteResult) -> Vec<&'static str> {
    r.results
        .iter()
        .map(|s| if s.applied { "APPLIED" } else { "REFUSED" })
        .collect()
}

fn row_code(r: &MassQuoteResult, i: usize) -> Option<&str> {
    code(r.results[i].rejected.as_ref())
}

#[test]
fn mass_quote_two_sided_set_both_apply_two_live_rests_one_set_id() {
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(
            SET,
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            Some(limit(ASK, "desk", Side::Sell, "1", "101")),
        ))
        .unwrap();
    assert_eq!(r.set_id.as_deref(), Some(SET));
    assert!(!r.one_sided);
    assert_eq!(r.results.len(), 2);
    assert_eq!(statuses(&r), ["APPLIED", "APPLIED"]);
    let mut got: Vec<String> = r
        .results
        .iter()
        .filter_map(|s| s.order_id.clone())
        .collect();
    got.sort();
    assert_eq!(got, ids(&[ASK, BID]));
    assert!(r.rejected.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[ASK, BID]));
}

#[test]
fn mass_quote_two_sided_set_ask_rejected_bid_cancelled_live_ids_empty_pair_refused() {
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(
            SET,
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            Some(no_price(ASK, Side::Sell)),
        ))
        .unwrap();
    assert_eq!(r.set_id.as_deref(), Some(SET));
    assert_eq!(code(r.rejected.as_ref()), Some("quote_pair_rejected"));
    assert_eq!(statuses(&r), ["REFUSED", "REFUSED"]);
    assert_eq!(row_code(&r, 0), Some("quote_pair_rejected"));
    assert_eq!(row_code(&r, 1), Some("missing_price"));
    assert!(live_ids(&engine, MARKET).is_empty());
}

#[test]
fn mass_quote_missing_ask_on_two_sided_quote_pair_incomplete_nothing_rests() {
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(
            SET,
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            None,
        ))
        .unwrap();
    assert_eq!(code(r.rejected.as_ref()), Some("quote_pair_incomplete"));
    assert!(r.results.iter().all(|s| !s.applied));
    assert!(
        r.results
            .iter()
            .all(|s| code(s.rejected.as_ref()) == Some("quote_pair_incomplete"))
    );
    assert!(live_ids(&engine, MARKET).is_empty());
}

#[test]
fn mass_quote_one_sided_true_with_only_bid_bid_rests_no_invented_ask() {
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(
            SET,
            true,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            None,
        ))
        .unwrap();
    assert_eq!(r.set_id.as_deref(), Some(SET));
    assert!(r.one_sided);
    assert_eq!(r.results.len(), 1);
    assert_eq!(r.results[0].side, QuoteSide::Bid);
    assert!(r.results[0].applied);
    assert_eq!(r.results[0].order_id.as_deref(), Some(BID));
    assert!(r.rejected.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[BID]));
    assert!(!live_ids(&engine, MARKET).contains(&ASK.to_owned()));
}

#[test]
fn mass_quote_missing_set_id_refuses_both_sides() {
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(
            "",
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            Some(limit(ASK, "desk", Side::Sell, "1", "101")),
        ))
        .unwrap();
    assert!(r.set_id.is_none());
    assert_eq!(code(r.rejected.as_ref()), Some("quote_set_missing"));
    assert_eq!(r.results.len(), 2);
    assert!(r.results.iter().all(|s| !s.applied));
    assert!(
        r.results
            .iter()
            .all(|s| code(s.rejected.as_ref()) == Some("quote_set_missing"))
    );
    assert!(live_ids(&engine, MARKET).is_empty());
}

#[test]
fn mass_quote_qty_is_a_scaled_integer() {
    let bid = limit(BID, "desk", Side::Buy, "1", "99");
    assert_eq!(bid.qty, a("1"));
    let (mut engine, _) = build();
    let r = engine
        .mass_quote(&quote(SET, true, Some(bid), None))
        .unwrap();
    assert!(r.results[0].applied);
    assert_eq!(engine.resting_orders(Some(MARKET))[0].remaining, a("1"));
    assert_eq!(
        engine.resting_orders(Some(MARKET))[0]
            .to_json()
            .get("remaining"),
        Some(&Json::str("1"))
    );
}

#[test]
fn mass_quote_a_thrown_cancel_that_leaves_the_order_resting_does_not_claim_the_side_was_unwound() {
    let bus = Bus::default();
    let journal = Boom {
        inner: MemoryJournal::new(),
        kind: "cancel",
        order: Some(BID),
    };
    let mut engine = engine_on(Box::new(journal), bus);
    let r = engine
        .mass_quote(&quote(
            SET,
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            Some(no_price(ASK, Side::Sell)),
        ))
        .unwrap();
    assert_eq!(live_ids(&engine, MARKET), ids(&[BID]));
    assert_eq!(r.results[0].side, QuoteSide::Bid);
    assert!(r.results[0].applied);
    assert_eq!(r.results[0].order_id.as_deref(), Some(BID));
    assert!(r.rejected.is_none());
    assert!(r.results.iter().all(|s| {
        s.rejected.as_ref().is_none_or(|x| {
            x.message != "quote pair refused; applied side was unwound so the book is not one-sided"
        })
    }));
    assert_eq!(row_code(&r, 1), Some("missing_price"));
}

#[test]
fn mass_quote_a_thrown_submit_that_already_rested_the_order_is_applied_so_the_pair_can_unwind_it() {
    let bus = Bus {
        refuse_accepted_of: Some(BID),
        ..Bus::default()
    };
    let mut engine = engine_on(Box::new(MemoryJournal::new()), bus);
    let r = engine
        .mass_quote(&quote(
            SET,
            false,
            Some(limit(BID, "desk", Side::Buy, "1", "99")),
            Some(no_price(ASK, Side::Sell)),
        ))
        .unwrap();
    assert!(live_ids(&engine, MARKET).is_empty());
    assert_eq!(code(r.rejected.as_ref()), Some("quote_pair_rejected"));
    assert_eq!(
        r.rejected.as_ref().unwrap().message,
        "quote pair refused; applied side was unwound so the book is not one-sided"
    );
    assert_eq!(r.results[0].side, QuoteSide::Bid);
    assert!(!r.results[0].applied);
    assert_eq!(r.results[0].order_id.as_deref(), Some(BID));
    assert_eq!(row_code(&r, 0), Some("quote_pair_rejected"));
    assert_eq!(row_code(&r, 1), Some("missing_price"));
}

// ── mmp.test.ts ─────────────────────────────────────────────────────────

fn with_mmp(
    mut o: EngineOrder,
    f: impl FnOnce(&mut svc_matching::book::types::MmpIntent),
) -> EngineOrder {
    f(&mut o.mmp);
    o
}

#[test]
fn mmp_on_a_quote_or_submit_with_unset_magnitudes_refuses_mmp_unpublished_book_empty() {
    let (mut engine, _) = build();
    let flagged = engine
        .submit(
            MARKET,
            &with_mmp(limit(REST, "desk", Side::Sell, "1", "100"), |m| {
                m.flag = true
            }),
            None,
        )
        .unwrap();
    assert!(mmp_magnitudes_unset());
    assert!(!flagged.accepted);
    assert_eq!(code(flagged.rejected.as_ref()), Some("mmp_unpublished"));
    assert!(live_ids(&engine, MARKET).is_empty());

    let magnitude = engine
        .submit(
            MARKET,
            &with_mmp(limit(TAKE, "desk", Side::Buy, "1", "99"), |m| {
                m.magnitude = true
            }),
            None,
        )
        .unwrap();
    assert!(!magnitude.accepted);
    assert_eq!(code(magnitude.rejected.as_ref()), Some("mmp_unpublished"));
    assert!(live_ids(&engine, MARKET).is_empty());

    // `mmpMaxDelta: ''`: a blank magnitude is still a magnitude given.
    let blank = engine
        .submit(
            MARKET,
            &with_mmp(limit(ASK3, "desk", Side::Sell, "1", "100"), |m| {
                m.magnitude = true
            }),
            None,
        )
        .unwrap();
    assert!(!blank.accepted);
    assert_eq!(code(blank.rejected.as_ref()), Some("mmp_unpublished"));
    assert!(live_ids(&engine, MARKET).is_empty());
    assert_eq!(engine.journal().len(), 0);
}

#[test]
fn mmp_vendor_or_sidecar_flag_refuses_mmp_sidecar_refused() {
    let (mut engine, _) = build();
    let vendor = engine
        .submit(
            MARKET,
            &with_mmp(limit(REST, "desk", Side::Sell, "1", "100"), |m| {
                m.vendor = true
            }),
            None,
        )
        .unwrap();
    assert!(!vendor.accepted);
    assert_eq!(code(vendor.rejected.as_ref()), Some("mmp_sidecar_refused"));
    let sidecar = engine
        .submit(
            MARKET,
            &with_mmp(limit(TAKE, "desk", Side::Buy, "1", "99"), |m| {
                m.sidecar = true
            }),
            None,
        )
        .unwrap();
    assert!(!sidecar.accepted);
    assert_eq!(code(sidecar.rejected.as_ref()), Some("mmp_sidecar_refused"));
    assert!(live_ids(&engine, MARKET).is_empty());
}

#[test]
fn mmp_apply_mmp_unpublished_never_returns_0_as_a_live_max() {
    let (engine, _) = build();
    let hitch = engine.apply_mmp(MARKET);
    let direct = apply_mmp(MARKET);
    for r in [&hitch, &direct] {
        assert!(!r.accepted);
        assert_eq!(code(r.rejected.as_ref()), Some("mmp_unpublished"));
    }
    // `MmpResult` has no magnitude field to present as zero: held by the type.
    assert_eq!(hitch, direct);
}

#[test]
fn mmp_no_matching_mmp_env_invented() {
    assert!(mmp_magnitudes_unset());
    let invented: Vec<String> = std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| k.starts_with("MATCHING_MMP_"))
        .collect();
    assert!(invented.is_empty());
    let env = include_str!("../src/env.rs");
    assert!(!env.contains("MATCHING_MMP_"));
}

// ── auction-uncross.test.ts ─────────────────────────────────────────────

fn book_state(engine: &MatchingEngine) -> Json {
    engine.existing_book(MARKET).unwrap().to_state()
}

#[test]
fn auction_uncross_uncross_with_rules_unset_is_refused_book_identical_no_fills() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "mm", Side::Sell, "2", "100"), None)
        .unwrap();
    let before_journal = engine.journal().len();
    let before_book = book_state(&engine);

    let r = engine.uncross(MARKET);
    assert!(uncrossing_rules_unset());
    assert!(!r.accepted);
    assert_eq!(code(r.rejected.as_ref()), Some("uncrossing_unset"));
    assert_eq!(
        r.rejected.as_ref().unwrap().message,
        "uncrossing rules are unset; the engine does not invent an uncross"
    );
    assert!(r.fills.is_empty());
    assert_eq!(book_state(&engine), before_book);
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
    assert_eq!(engine.journal().len(), before_journal);
    assert!(
        !engine
            .journal()
            .read()
            .iter()
            .any(|r| r.kind() == Some("uncross"))
    );
}

#[test]
fn auction_uncross_enter_and_leave_auction_refuse_while_rules_unset() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "mm", Side::Sell, "2", "100"), None)
        .unwrap();
    let before_journal = engine.journal().len();
    let before_book = book_state(&engine);
    for r in [engine.enter_auction(MARKET), engine.leave_auction(MARKET)] {
        assert!(!r.accepted);
        assert_eq!(code(r.rejected.as_ref()), Some("uncrossing_unset"));
        assert!(r.fills.is_empty());
    }
    assert_eq!(book_state(&engine), before_book);
    assert_eq!(engine.journal().len(), before_journal);
}

#[test]
fn auction_uncross_auction_true_order_still_refuses_auction_unsupported() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "mm", Side::Sell, "2", "100"), None)
        .unwrap();
    let mut miss = limit(ASK3, "desk", Side::Buy, "10", "100");
    miss.auction = svc_matching::book::types::Opt::Some(true);
    let r = engine.submit(MARKET, &miss, None).unwrap();
    assert!(!r.accepted);
    assert_eq!(code(r.rejected.as_ref()), Some("auction_unsupported"));
    assert!(r.fills.is_empty());
    assert!(r.resting.is_none());
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
}

#[test]
fn auction_uncross_journal_does_not_grow_a_fake_uncross_record_that_would_print_fills_on_replay() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "mm", Side::Sell, "2", "100"), None)
        .unwrap();
    engine.uncross(MARKET);
    assert!(
        !engine
            .journal()
            .read()
            .iter()
            .any(|r| r.kind() == Some("uncross"))
    );
    let recovered = replay(engine.journal().read());
    assert_eq!(live_ids(&recovered, MARKET), ids(&[REST]));
    assert_eq!(
        book_state(&recovered).get("lastTradePrice"),
        Some(&Json::Null)
    );
}

#[test]
fn auction_uncross_submit_during_marked_auction_state_does_not_silently_uncross() {
    let (mut engine, _) = build();
    engine
        .submit(MARKET, &limit(REST, "mm", Side::Sell, "2", "100"), None)
        .unwrap();
    engine.mark_auction_state(MARKET);
    let before_journal = engine.journal().len();
    let before_book = book_state(&engine);

    let take = engine
        .submit(MARKET, &limit(TAKE, "desk", Side::Buy, "2", "100"), None)
        .unwrap();
    assert!(!take.accepted);
    assert_eq!(code(take.rejected.as_ref()), Some("uncrossing_unset"));
    assert!(take.fills.is_empty());
    assert!(take.sequence.is_none());
    assert_eq!(book_state(&engine), before_book);
    assert_eq!(live_ids(&engine, MARKET), ids(&[REST]));
    assert_eq!(engine.journal().len(), before_journal);
}

// ── liquidity.test.ts ───────────────────────────────────────────────────

const LMARKET: &str = "BTC-USDT";
const BUY: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

#[test]
fn liquidity_native_depth_is_sourced_matching() {
    let (mut engine, _) = build();
    engine
        .submit(LMARKET, &limit(BUY, "desk", Side::Buy, "1", "100"), None)
        .unwrap();
    let depth = engine.sourced_depth(LMARKET, DepthSource::Native { limit: 50 });
    assert!(depth.accepted);
    assert_eq!(depth.source.as_deref(), Some("matching"));
    assert!(depth.native);
    assert!(!depth.bids.is_empty());
}

#[test]
fn liquidity_external_depth_without_a_source_refuses_no_invented_venue() {
    let (engine, _) = build();
    for source in [None, Some("   ")] {
        let depth = engine.sourced_depth(LMARKET, DepthSource::External { source });
        assert!(!depth.accepted);
        assert!(depth.source.is_none());
        assert!(!depth.native);
        assert_eq!(code(depth.rejected.as_ref()), Some("unsourced_depth"));
    }
}

#[test]
fn liquidity_external_depth_carries_the_visible_source_and_is_not_native() {
    let (engine, _) = build();
    let depth = engine.sourced_depth(
        LMARKET,
        DepthSource::External {
            source: Some("venue.alpha"),
        },
    );
    assert!(depth.accepted);
    assert_eq!(depth.source.as_deref(), Some("venue.alpha"));
    assert!(!depth.native);
    assert!(depth.bids.is_empty());
}

#[test]
fn liquidity_unset_rebate_program_does_not_pay_paid_is_null_never_a_zero_rebate() {
    assert!(rebate_program_unset());
    let paid = pay_rebate(Some("mm"), Some("desk"));
    assert!(!paid.accepted);
    assert!(paid.paid.is_none());
    assert_eq!(paid.rejected.code, "rebate_program_unset");
    assert!(std::env::var_os("MATCHING_REBATE_PROGRAM").is_none());
}

#[test]
fn liquidity_same_account_maker_taker_is_wash_not_paid() {
    let (engine, _) = build();
    let paid = engine.pay_rebate(Some("desk"), Some("desk"));
    assert!(!paid.accepted);
    assert!(paid.paid.is_none());
    assert_eq!(paid.rejected.code, "rebate_wash");
}

#[test]
fn liquidity_quality_telemetry_may_exist_without_proving_liquid() {
    let (engine, _) = build();
    let tel = engine.quality_telemetry(LMARKET, 12);
    assert_eq!(tel.samples, 12);
    assert!(!tel.proven_liquid);
    assert!(!quality_telemetry(LMARKET, 0).proven_liquid);
}

/// `installIfmCrash` wraps the engine from outside, so its refusal comes before the base engine's gates: in
/// maintenance a crash-window order refuses `in_flight_unknown`, while an `in_flight` record without the durable flag
/// only reaches the base engine, whose maintenance refusal comes first.
#[test]
fn ifm_crash_the_crash_window_refusal_comes_before_the_base_engines_gates() {
    let records = |flag: bool| {
        let mut journal = MemoryJournal::new();
        let rest = limit(REST, "desk", Side::Sell, "1", "100");
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("submit")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-09-01T00:00:00.000Z")),
                ("order", svc_matching::book::wire::to_wire(&rest, None)),
            ])))
            .unwrap();
        let mut mark = vec![
            ("kind".to_owned(), Json::str("in_flight")),
            ("marketId".to_owned(), Json::str(MARKET)),
            ("at".to_owned(), Json::str("2026-09-01T00:00:01.000Z")),
            ("orderId".to_owned(), Json::str(REST)),
            ("mutation".to_owned(), Json::str("cancel")),
        ];
        if flag {
            mark.push(("inFlight".to_owned(), Json::Bool(true)));
        }
        journal.append(&JournalCommand(Json::Object(mark))).unwrap();
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("maintenance")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-09-01T00:00:02.000Z")),
            ])))
            .unwrap();
        let mut engine = engine_on(Box::new(journal), Bus::default());
        engine.recover().unwrap();
        engine
    };
    let mut crashed = records(true);
    let r = crashed
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert_eq!(code(r.rejected.as_ref()), Some("in_flight_unknown"));
    let mut base_only = records(false);
    let r = base_only
        .cancel(MARKET, REST, CancelReason::Requested)
        .unwrap();
    assert_eq!(code(r.rejected.as_ref()), Some("market_maintenance"));
}
