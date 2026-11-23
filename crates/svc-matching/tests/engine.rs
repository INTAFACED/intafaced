//! The engine's own tests, ported test for test from `services/svc-matching/src/engine/`: `engine.test.ts`,
//! `engine-l2-limit-unset-refuse.test.ts`, `engine-snapshot-every-ctor-refuse.test.ts`, `gtd-journal-clock.test.ts`
//! and the real-book replay of `journal-gaps.test.ts` (the journal-only ones are in `journal_replay.rs`).
//! `oco-replay.test.ts` is the triggers slice's and is ported in `triggers_oco.rs`; the triggers slice's stop-limit,
//! trailing-stop and GTD engine tests are in `triggers_engine.rs`.
//!
//! The TypeScript `replay` and `replayFrom` hand back books; here they are `replay_journal` and `replay_from` over a
//! plain map of `OrderBook`s ([`Books`]), as the engine's own cold start feeds its books.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, zod_datetime};
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, OrderType, Priority, Side, Tif, TriggerBy, TriggerFact,
    TriggerRole, seq_json,
};
use svc_matching::book::wire::{from_wire, from_wire_amend, to_wire};
use svc_matching::engine::{
    EngineError, EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published,
};
use svc_matching::journal::JournalError;
use svc_matching::journal::gaps::{GatewayStamp, reconstruct_transitions};
use svc_matching::journal::record::whole;
use svc_matching::journal::replay::{
    EngineSnapshot, ReplayBooks, ReplayCancel, SnapshotSink, js_sort_cmp, replay_from,
    replay_journal,
};
use svc_matching::journal::{
    EngineJournal, FileJournal, JournalCommand, JournalRecord, MemoryJournal,
};

const MARKET: &str = "BTC/USDT";
const OTHER_MARKET: &str = "ETH/USDT";

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────

thread_local! {
    static UUID: Cell<u64> = const { Cell::new(0) };
    static TICK: Cell<i64> = const { Cell::new(0) };
    static STEPS: RefCell<Vec<i64>> = const { RefCell::new(Vec::new()) };
    static STEP: Cell<usize> = const { Cell::new(0) };
}

fn uuid() -> String {
    let n = UUID.with(|c| {
        c.set(c.get() + 1);
        c.get()
    });
    format!("00000000-0000-4000-8000-{n:012}")
}

/// `fixedClock()`: one second further per read, from 2026-01-01. Each test runs on its own thread, so each has its own.
fn fixed_clock() -> i64 {
    let tick = TICK.with(|t| {
        t.set(t.get() + 1);
        t.get()
    });
    Instant::start_of_year(2026).0 + tick * 1000
}

fn reset_clock() {
    TICK.with(|t| t.set(0));
}

/// `new Date()`: the default clock when none is injected.
fn wall_clock() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

/// `reads[step++] ?? AFTER`, the reads set by [`set_steps`].
fn stepped_clock() -> i64 {
    let step = STEP.with(|s| {
        let n = s.get();
        s.set(n + 1);
        n
    });
    STEPS.with(|s| {
        let reads = s.borrow();
        reads
            .get(step)
            .copied()
            .unwrap_or_else(|| *reads.last().unwrap())
    })
}

fn set_steps(reads: Vec<i64>) {
    STEPS.with(|s| *s.borrow_mut() = reads);
    STEP.with(|s| s.set(0));
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// A bus the test reads after handing it to the engine (`MemoryEventBus`).
#[derive(Clone, Default)]
struct Bus(Arc<Mutex<Vec<Published>>>);

impl EventBus for Bus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        let mut inner = MemoryEventBus::default();
        inner.publish(name, payload, key)?;
        self.0.lock().unwrap().extend(inner.published);
        Ok(())
    }
}

impl Bus {
    fn published(&self) -> Vec<Published> {
        self.0.lock().unwrap().clone()
    }

    fn emitted(&self, name: &str) -> Vec<Published> {
        self.published()
            .into_iter()
            .filter(|e| e.name == name)
            .collect()
    }

    fn reset(&self) {
        self.0.lock().unwrap().clear();
    }
}

/// Journal fsync happened; orderFilled never left the process (`FailFilledBus`).
#[derive(Clone, Default)]
struct FailFilledBus(Bus);

impl EventBus for FailFilledBus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        if name == "orderFilled" {
            return Err("nats down after journal fsync".to_owned());
        }
        self.0.publish(name, payload, key)
    }
}

/// A snapshot sink the test reads (`{ write: (s) => writes.push(s) }`).
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<EngineSnapshot<Json>>>>);

impl SnapshotSink<Json> for Sink {
    fn write(&mut self, snapshot: EngineSnapshot<Json>) {
        self.0.lock().unwrap().push(snapshot);
    }
}

struct Options {
    journal: Box<dyn EngineJournal + Send>,
    clock: Option<fn() -> i64>,
    snapshot_every: u64,
    sink: Sink,
    enabled: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            journal: Box::new(MemoryJournal::new()),
            clock: Some(fixed_clock),
            snapshot_every: 0,
            sink: Sink::default(),
            enabled: true,
        }
    }
}

fn engine_on(options: Options, bus: Box<dyn EventBus + Send>) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: options.journal,
        bus,
        clock: options.clock.unwrap_or(wall_clock),
        expiry_clock: options.clock.is_some(),
        snapshot_every: options.snapshot_every,
        sink: Box::new(options.sink),
        enabled: options.enabled,
        spread_fills: false,
    })
}

/// `build(overrides)`: a memory journal, a memory bus, the fixed clock, no snapshots.
fn build_with(options: Options) -> (MatchingEngine, Bus) {
    reset_clock();
    let bus = Bus::default();
    (engine_on(options, Box::new(bus.clone())), bus)
}

fn build() -> (MatchingEngine, Bus) {
    build_with(Options::default())
}

/// The same journal handed to a second engine: a memory journal holding exactly the records the first one holds.
fn same_journal(records: &[JournalRecord]) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    assert_eq!(journal.read(), records);
    journal
}

/// `new MatchingEngine({ journal, bus: recoveryBus, clock: fixedClock(), snapshotEvery: 0 })`.
fn recovery_engine(records: &[JournalRecord]) -> (MatchingEngine, Bus) {
    build_with(Options {
        journal: Box::new(same_journal(records)),
        ..Options::default()
    })
}

fn records(engine: &MatchingEngine) -> Vec<JournalRecord> {
    engine.journal().read().to_vec()
}

fn kinds(engine: &MatchingEngine) -> Vec<String> {
    engine
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap().to_owned())
        .collect()
}

/// `order(spec)`: a limit when it has a price, a market order when not; GTC.
fn order(id: &str, account: &str, side: Side, qty: &str, price: Option<&str>) -> EngineOrder {
    EngineOrder::new(
        id,
        account,
        if price.is_some() {
            OrderType::Limit
        } else {
            OrderType::Market
        },
        side,
        a(qty),
        price.map(a),
        Tif::Gtc,
    )
}

fn with_tif(mut o: EngineOrder, tif: Tif) -> EngineOrder {
    o.tif = tif;
    o
}

/// `order({ type: 'stop', stopPrice })`: no limit price.
fn stop(id: &str, account: &str, side: Side, qty: &str, stop_price: &str) -> EngineOrder {
    let mut o = EngineOrder::new(id, account, OrderType::Stop, side, a(qty), None, Tif::Gtc);
    o.stop_price = Some(a(stop_price));
    o
}

fn submit(
    engine: &mut MatchingEngine,
    market: &str,
    o: &EngineOrder,
) -> svc_matching::book::types::SubmitResult {
    engine.submit(market, o, None).unwrap()
}

fn amend(qty: Option<&str>, stop_price: Option<&str>, id: &str) -> EngineAmend {
    EngineAmend {
        order_id: id.to_owned(),
        expected_version: 1,
        qty: qty.map(a),
        stop_price: stop_price.map(a),
        ..EngineAmend::default()
    }
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is text, got {other:?}"),
    }
}

fn seq_of(j: &Json) -> i64 {
    whole(j.get("sequence").unwrap()).unwrap()
}

fn item(j: &Json, i: usize) -> Option<&Json> {
    match j {
        Json::Array(xs) => xs.get(i),
        _ => None,
    }
}

fn list(j: Option<&Json>) -> &[Json] {
    match j {
        Some(Json::Array(xs)) => xs,
        other => panic!("a list, got {other:?}"),
    }
}

/// `toMatchObject`: every field named holds the value given.
fn assert_matches(payload: &Json, expected: &[(&str, Json)]) {
    for (key, value) in expected {
        assert_eq!(
            payload.get(key),
            Some(value),
            "{key} of {}",
            payload.compact()
        );
    }
}

/// `/^-?\d+(\.\d{1,18})?$/`.
fn is_decimal(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
}

// ── replay over plain books (`replay`, `replayFrom`, `serializeBooks`) ──────────────────────────────────────────

#[derive(Default)]
struct Books(HashMap<String, OrderBook>);

impl Books {
    fn drop_if_never_traded(&mut self, market_id: &str) {
        if self
            .0
            .get(market_id)
            .is_some_and(OrderBook::is_never_printed_empty)
        {
            self.0.remove(market_id);
        }
    }

    fn keys(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.0.keys().cloned().collect();
        ids.sort_by(|x, y| js_sort_cmp(x, y));
        ids
    }

    /// `serializeBooks`.
    fn serialize(&self) -> String {
        Json::Array(self.keys().iter().map(|id| self.0[id].to_state()).collect()).compact()
    }
}

impl ReplayBooks for Books {
    fn has_market(&self, market_id: &str) -> bool {
        self.0.contains_key(market_id)
    }

    fn submit(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        let o = from_wire(record.field("order").unwrap()).unwrap();
        self.0
            .entry(market_id.to_owned())
            .or_insert_with(|| OrderBook::new(market_id))
            .submit(&o, clock);
        self.drop_if_never_traded(market_id);
    }

    fn amend(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        let id = text(&record.0, "orderId");
        let version =
            u64::try_from(whole(record.field("expectedVersion").unwrap()).unwrap()).unwrap();
        let empty = Json::Object(Vec::new());
        let cmd = from_wire_amend(&id, version, record.field("patch").unwrap_or(&empty)).unwrap();
        if let Some(book) = self.0.get_mut(market_id) {
            book.amend(&cmd, clock);
        }
        self.drop_if_never_traded(market_id);
    }

    /// `applyMark(existing, parseAmount(record.mark))`.
    fn mark(&mut self, market_id: &str, record: &JournalRecord) {
        let mark = parse_amount(&text(&record.0, "mark")).unwrap();
        if let Some(book) = self.0.get_mut(market_id) {
            book.apply_mark(Some(mark));
        }
    }

    fn mass_cancel(&mut self, market_id: &str, record: &JournalRecord) {
        let account = text(&record.0, "accountId");
        let side = record.field("side").map(|s| match s {
            Json::String(s) => Side::parse(s).unwrap(),
            other => panic!("side {other:?}"),
        });
        if let Some(book) = self.0.get_mut(market_id) {
            book.cancel_account(&account, side);
        }
        self.drop_if_never_traded(market_id);
    }

    fn cancel(&mut self, market_id: &str, record: &JournalRecord, why: ReplayCancel<'_>) {
        let reason = match why {
            ReplayCancel::Requested => CancelReason::Requested,
            ReplayCancel::Reason(r) => CancelReason::parse(r).unwrap(),
        };
        let id = text(&record.0, "orderId");
        if let Some(book) = self.0.get_mut(market_id) {
            book.cancel(&id, reason);
        }
    }

    fn session_dead(&mut self, session_id: &Json) {
        let Json::String(id) = session_id else {
            return;
        };
        for market in self.keys() {
            if let Some(book) = self.0.get_mut(&market) {
                book.cancel_session(id);
            }
            self.drop_if_never_traded(&market);
        }
    }
}

/// `replay(records)`.
fn replay(records: &[JournalRecord]) -> Books {
    let mut books = Books::default();
    replay_journal(records, &mut books).unwrap();
    books
}

/// `replayFrom(snapshot, records)`.
fn replay_from_snapshot(snapshot: &EngineSnapshot<Json>, records: &[JournalRecord]) -> Books {
    let mut books = Books::default();
    for state in &snapshot.books {
        let book = OrderBook::from_state(state).unwrap();
        books.0.insert(book.market_id().to_owned(), book);
    }
    replay_from(
        snapshot.journal_seq,
        &snapshot.dead_sessions,
        records,
        &mut books,
    )
    .unwrap();
    books
}

fn record(json: Json) -> JournalRecord {
    JournalRecord(json)
}

fn legacy_submit(market: &str, id: &str, tif: &str) -> JournalRecord {
    record(Json::obj([
        ("kind", Json::str("submit")),
        ("marketId", Json::str(market)),
        ("at", Json::str("2026-01-01T00:00:00.000Z")),
        ("seq", Json::int(1)),
        (
            "order",
            Json::obj([
                ("orderId", Json::str(id)),
                ("accountId", Json::str("a")),
                ("type", Json::str("limit")),
                ("side", Json::str("buy")),
                ("qty", Json::str("1")),
                ("price", Json::str("100")),
                ("stopPrice", Json::Null),
                ("tif", Json::str(tif)),
            ]),
        ),
    ]))
}

fn legacy_cancel(market: &str, id: &str) -> JournalRecord {
    record(Json::obj([
        ("kind", Json::str("cancel")),
        ("marketId", Json::str(market)),
        ("at", Json::str("2026-01-01T00:00:00.000Z")),
        ("orderId", Json::str(id)),
        ("seq", Json::int(1)),
    ]))
}

// ── the journal comes first ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn records_the_input_before_the_book_moves() {
    let (mut engine, _) = build();
    submit(
        &mut engine,
        MARKET,
        &order(
            "aaaaaaaa-0000-4000-8000-000000000001",
            "acct-default",
            Side::Buy,
            "1",
            Some("100"),
        ),
    );
    let recs = records(&engine);
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].kind(), Some("submit"));
    assert_eq!(recs[0].field("marketId"), Some(&Json::str(MARKET)));
}

struct ExplodingJournal;

impl EngineJournal for ExplodingJournal {
    fn append(&mut self, _command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        Err(std::io::Error::other("disk full").into())
    }
    fn read(&self) -> &[JournalRecord] {
        &[]
    }
    fn len(&self) -> usize {
        0
    }
    fn close(&mut self) -> Result<(), JournalError> {
        Ok(())
    }
}

#[test]
fn leaves_the_book_untouched_when_the_journal_write_fails() {
    let (mut engine, bus) = build_with(Options {
        journal: Box::new(ExplodingJournal),
        ..Options::default()
    });
    let err = engine
        .submit(
            MARKET,
            &order(&uuid(), "acct-default", Side::Buy, "1", Some("100")),
            None,
        )
        .unwrap_err();
    assert!(err.to_string().contains("disk full"), "{err}");
    // `engine.book(MARKET).currentSequence`: the TypeScript opens an empty book to read it.
    assert_eq!(
        engine
            .existing_book(MARKET)
            .map_or(0, OrderBook::current_sequence),
        0
    );
    assert!(bus.published().is_empty());
}

#[test]
fn journals_cancels_too_so_replay_sees_the_same_input_stream() {
    let (mut engine, _) = build();
    let id = uuid();
    submit(
        &mut engine,
        MARKET,
        &order(&id, "acct-default", Side::Buy, "1", Some("100")),
    );
    engine.cancel(MARKET, &id, CancelReason::Requested).unwrap();
    assert_eq!(kinds(&engine), ["submit", "in_flight", "cancel"]);
}

#[test]
fn journals_native_amend_and_replay_restores_retained_remaining() {
    let (mut engine, _) = build();
    let id = uuid();
    submit(
        &mut engine,
        MARKET,
        &order(&id, "acct-default", Side::Buy, "2", Some("100")),
    );
    let amended = engine
        .amend(MARKET, &amend(Some("1"), None, &id), None)
        .unwrap();
    assert_eq!(amended.priority, Some(Priority::Retained));
    assert_eq!(kinds(&engine), ["submit", "in_flight", "amend"]);
    assert_eq!(replay(&records(&engine)).serialize(), engine.serialize());
}

#[test]
fn amend_on_an_unknown_market_does_not_create_a_book_or_journal_entry() {
    let (mut engine, _) = build();
    let result = engine
        .amend("NEVER-TRADED", &amend(Some("1"), None, &uuid()), None)
        .unwrap();
    assert!(!result.accepted);
    assert_eq!(result.rejected.unwrap().code, "order_not_found");
    assert_eq!(engine.journal().len(), 0);
    assert!(engine.markets().is_empty());
}

#[test]
fn cancel_on_an_unknown_market_does_not_create_a_book_or_journal_entry() {
    let (mut engine, _) = build();
    let ghost = "NEVER-TRADED-MARKET";
    let result = engine
        .cancel(ghost, &uuid(), CancelReason::Requested)
        .unwrap();
    assert!(!result.cancelled);
    assert!(!engine.has_market(ghost));
    assert!(!engine.markets().contains(&ghost.to_owned()));
    assert_eq!(engine.journal().len(), 0);
}

#[test]
fn replaying_a_cancel_only_journal_line_does_not_invent_a_market() {
    let ghost = "LEGACY-CANCEL-PHANTOM";
    let books = replay(&[legacy_cancel(ghost, "00000000-0000-4000-8000-cafebabe0001")]);
    assert!(!books.has_market(ghost));
    assert!(books.keys().is_empty());
}

#[test]
fn replay_from_also_refuses_to_invent_a_market_from_a_cancel_only_tail() {
    let ghost = "LEGACY-TAIL-PHANTOM";
    let empty = EngineSnapshot::of(Vec::new(), 0, Vec::new());
    let books = replay_from_snapshot(
        &empty,
        &[legacy_cancel(ghost, "00000000-0000-4000-8000-cafebabe0002")],
    );
    assert!(!books.has_market(ghost));
}

#[test]
fn fok_into_a_virgin_market_does_not_leave_the_market_listed() {
    let (mut engine, _) = build();
    let ghost = "NEVER-TRADED-FOK-MKT";
    let result = submit(
        &mut engine,
        ghost,
        &with_tif(
            order(&uuid(), "acct-default", Side::Buy, "1", Some("100")),
            Tif::Fok,
        ),
    );
    assert!(!result.accepted);
    assert_eq!(result.rejected.unwrap().code, "fok_unfillable");
    assert!(!engine.has_market(ghost));
    assert!(!engine.markets().contains(&ghost.to_owned()));
    assert!(engine.depth(ghost, 50).is_none());
    assert_eq!(kinds(&engine), ["submit"]);
}

#[test]
fn ioc_into_a_virgin_market_does_not_leave_the_market_listed() {
    let (mut engine, _) = build();
    let ghost = "NEVER-TRADED-IOC-MKT";
    let result = submit(
        &mut engine,
        ghost,
        &with_tif(
            order(&uuid(), "acct-default", Side::Buy, "1", Some("100")),
            Tif::Ioc,
        ),
    );
    assert!(result.accepted);
    assert!(result.resting.is_none());
    assert!(result.fills.is_empty());
    assert_eq!(result.cancellations.len(), 1);
    assert!(!engine.has_market(ghost));
    assert!(!engine.markets().contains(&ghost.to_owned()));
    assert!(engine.depth(ghost, 50).is_none());
    assert_eq!(kinds(&engine), ["submit"]);
}

#[test]
fn replaying_an_ioc_only_journal_line_does_not_invent_a_market() {
    let ghost = "LEGACY-IOC-PHANTOM";
    let books = replay(&[legacy_submit(
        ghost,
        "00000000-0000-4000-8000-cafebabe0004",
        "IOC",
    )]);
    assert!(!books.has_market(ghost));
}

#[test]
fn structural_reject_into_a_virgin_market_does_not_invent_a_market() {
    let (mut engine, _) = build();
    let ghost = "NEVER-TRADED-BAD-QTY";
    let result = submit(
        &mut engine,
        ghost,
        &order(&uuid(), "acct-default", Side::Buy, "0", Some("100")),
    );
    assert!(!result.accepted);
    assert_eq!(result.rejected.unwrap().code, "invalid_qty");
    assert!(!engine.has_market(ghost));
    assert!(engine.depth(ghost, 50).is_none());
}

#[test]
fn replaying_a_reject_only_journal_line_does_not_invent_a_market() {
    let ghost = "LEGACY-REJECT-PHANTOM";
    let books = replay(&[legacy_submit(
        ghost,
        "00000000-0000-4000-8000-cafebabe0003",
        "FOK",
    )]);
    assert!(!books.has_market(ghost));
}

#[test]
fn reject_on_a_real_market_leaves_that_market_listed() {
    let (mut engine, _) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "maker", Side::Sell, "1", Some("100")),
    );
    let result = submit(
        &mut engine,
        MARKET,
        &with_tif(
            order(&uuid(), "taker", Side::Buy, "9", Some("100")),
            Tif::Fok,
        ),
    );
    assert!(!result.accepted);
    assert_eq!(result.rejected.unwrap().code, "fok_unfillable");
    assert!(engine.has_market(MARKET));
    assert!(engine.depth(MARKET, 50).is_some());
}

#[test]
fn does_not_journal_an_input_the_kill_switch_refused() {
    let (mut engine, bus) = build_with(Options {
        enabled: false,
        ..Options::default()
    });
    let result = submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "acct-default", Side::Buy, "1", Some("100")),
    );
    assert!(!result.accepted);
    assert_eq!(result.rejected.unwrap().code, "engine_disabled");
    assert_eq!(engine.journal().len(), 0);
    assert!(bus.published().is_empty());
}

#[test]
fn resumes_accepting_once_the_operator_flips_the_switch_back() {
    let (mut engine, _) = build_with(Options {
        enabled: false,
        ..Options::default()
    });
    engine.set_enabled(true);
    let result = submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "acct-default", Side::Buy, "1", Some("100")),
    );
    assert!(result.accepted);
}

// ── events ───────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn publishes_order_accepted_for_an_order_that_rests() {
    let (mut engine, bus) = build();
    let id = uuid();
    let result = submit(
        &mut engine,
        MARKET,
        &order(&id, "acct-default", Side::Buy, "1", Some("100")),
    );
    let accepted = bus.emitted("orderAccepted");
    assert_eq!(accepted.len(), 1);
    assert_eq!(
        accepted[0].payload,
        Json::obj([
            ("orderId", Json::str(id)),
            ("marketId", Json::str(MARKET)),
            ("sequence", seq_json(result.sequence.unwrap())),
        ])
    );
    // `subject` is `intafaced.matching.order.accepted`: the events package maps the name to its subject; the Rust
    // bus is handed the name.
    assert_eq!(accepted[0].name, "orderAccepted");
}

#[test]
fn publishes_order_filled_with_decimal_string_amounts_and_the_engine_sequence() {
    let (mut engine, bus) = build();
    let maker = uuid();
    let taker = uuid();
    submit(
        &mut engine,
        MARKET,
        &order(&maker, "mm", Side::Sell, "2", Some("100.25")),
    );
    let result = submit(
        &mut engine,
        MARKET,
        &order(&taker, "tk", Side::Buy, "1.5", Some("100.25")),
    );
    let filled = bus.emitted("orderFilled");
    assert_eq!(filled.len(), 1);
    assert_matches(
        &filled[0].payload,
        &[
            ("marketId", Json::str(MARKET)),
            ("makerOrderId", Json::str(maker)),
            ("takerOrderId", Json::str(taker)),
            ("price", Json::str("100.25")),
            ("qty", Json::str("1.5")),
            ("sequence", seq_json(result.fills[0].sequence)),
            ("makerAccountId", Json::str("mm")),
            ("takerAccountId", Json::str("tk")),
        ],
    );
}

#[test]
fn publishes_order_cancelled_for_an_ioc_remainder() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("100")),
    );
    let id = uuid();
    submit(
        &mut engine,
        MARKET,
        &with_tif(order(&id, "tk", Side::Buy, "3", Some("100")), Tif::Ioc),
    );
    let cancelled = bus.emitted("orderCancelled");
    assert_eq!(cancelled.len(), 1);
    assert_matches(
        &cancelled[0].payload,
        &[
            ("orderId", Json::str(id)),
            ("marketId", Json::str(MARKET)),
            ("remainingQty", Json::str("2")),
        ],
    );
}

#[test]
fn publishes_order_cancelled_when_a_self_rest_is_expired() {
    let (mut engine, bus) = build();
    let own = uuid();
    let stranger = uuid();
    submit(
        &mut engine,
        MARKET,
        &order(&own, "same", Side::Buy, "1", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&stranger, "other", Side::Buy, "2", Some("100")),
    );
    bus.reset();
    let result = submit(
        &mut engine,
        MARKET,
        &with_tif(
            order(&uuid(), "same", Side::Sell, "1", Some("100")),
            Tif::Ioc,
        ),
    );
    assert!(result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(result.fills[0].maker_order_id, stranger);
    assert_eq!(result.cancellations[0].order_id, own);
    assert_eq!(
        result.cancellations[0].reason,
        CancelReason::SelfTradePrevention
    );
    let cancelled = bus.emitted("orderCancelled");
    assert_eq!(cancelled.len(), 1);
    assert_matches(
        &cancelled[0].payload,
        &[
            ("orderId", Json::str(own)),
            ("marketId", Json::str(MARKET)),
            ("remainingQty", Json::str("1")),
            ("reason", Json::str("self_trade_prevention")),
        ],
    );
    let book = engine.existing_book(MARKET).unwrap();
    let state = book.to_state();
    let first_bid = item(state.get("bids").unwrap(), 0).unwrap();
    assert_eq!(
        text(
            item(first_bid.get("orders").unwrap(), 0).unwrap(),
            "orderId"
        ),
        stranger
    );
    let cases: Vec<Json> = result
        .surveillance_cases
        .iter()
        .map(|c| c.to_json())
        .collect();
    assert_eq!(
        cases,
        [Json::obj([
            ("accountId", Json::str("same")),
            ("marketId", Json::str(MARKET)),
            ("reason", Json::str("self_trade")),
            ("status", Json::str("open")),
        ])]
    );
    // `engine.openSurveillanceCases()`: one market here, so its book's open cases.
    assert_eq!(
        book.open_surveillance_cases(),
        result.surveillance_cases.as_slice()
    );
    assert!(cases[0].get("fine").is_none());
    assert!(cases[0].get("amount").is_none());
}

#[test]
fn publishes_order_triggered_when_a_trade_reaches_a_resting_stop_before_the_fills_it_then_makes() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b1", Side::Buy, "1", Some("99")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b2", Side::Buy, "5", Some("98")),
    );
    let stop_id = uuid();
    submit(
        &mut engine,
        MARKET,
        &stop(&stop_id, "st", Side::Sell, "1", "99"),
    );
    assert!(bus.emitted("orderTriggered").is_empty());

    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "1", Some("99")),
    );

    let triggered = bus.emitted("orderTriggered");
    assert_eq!(triggered.len(), 1);
    assert_matches(
        &triggered[0].payload,
        &[
            ("orderId", Json::str(stop_id.clone())),
            ("marketId", Json::str(MARKET)),
            ("triggerBy", Json::str("last")),
            ("stopPrice", Json::str("99")),
            ("referencePrice", Json::str("99")),
        ],
    );
    let at = seq_of(&triggered[0].payload);
    let fill = bus
        .emitted("orderFilled")
        .into_iter()
        .find(|e| text(&e.payload, "takerOrderId") == stop_id)
        .unwrap();
    assert_matches(
        &fill.payload,
        &[("price", Json::str("98")), ("qty", Json::str("1"))],
    );
    assert!(seq_of(&fill.payload) > at);
    let published = bus.published();
    let pos = |p: &Json| published.iter().position(|e| e.payload == *p).unwrap();
    assert!(pos(&triggered[0].payload) < pos(&fill.payload));
}

#[test]
fn publishes_order_triggered_for_a_stop_already_through_its_price_on_arrival_with_the_last_price_it_met()
 {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Buy, "5", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "1", Some("100")),
    );
    bus.reset();

    let stop_id = uuid();
    let result = submit(
        &mut engine,
        MARKET,
        &stop(&stop_id, "st", Side::Sell, "1", "101"),
    );

    assert_eq!(result.fills.len(), 1);
    let triggered = bus.emitted("orderTriggered");
    assert_eq!(triggered.len(), 1);
    assert_matches(
        &triggered[0].payload,
        &[
            ("orderId", Json::str(stop_id)),
            ("sequence", seq_json(result.sequence.unwrap())),
            ("triggerBy", Json::str("last")),
            ("stopPrice", Json::str("101")),
            ("referencePrice", Json::str("100")),
        ],
    );
}

#[test]
fn publishes_order_triggered_when_an_amend_moves_a_stop_through_the_last_price() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Buy, "5", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "1", Some("100")),
    );
    let stop_id = uuid();
    submit(
        &mut engine,
        MARKET,
        &stop(&stop_id, "st", Side::Sell, "1", "90"),
    );
    bus.reset();

    engine
        .amend(MARKET, &amend(None, Some("100"), &stop_id), None)
        .unwrap();

    assert_eq!(bus.emitted("orderFilled").len(), 1);
    let triggered = bus.emitted("orderTriggered");
    assert_eq!(triggered.len(), 1);
    assert_matches(
        &triggered[0].payload,
        &[
            ("orderId", Json::str(stop_id)),
            ("stopPrice", Json::str("100")),
            ("referencePrice", Json::str("100")),
        ],
    );
}

fn sweep_through(role: Option<TriggerRole>) {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b1", Side::Buy, "1", Some("99")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b2", Side::Buy, "1", Some("97")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b3", Side::Buy, "5", Some("95")),
    );
    let stop_id = uuid();
    let mut s = stop(&stop_id, "st", Side::Sell, "1", "98");
    s.trigger_role = role;
    submit(&mut engine, MARKET, &s);
    bus.reset();

    // One sell sweeps 99 then 97: no trade prints at 98, and the last price passes the stop on its way to 97.
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "2", Some("97")),
    );

    let triggered = bus.emitted("orderTriggered");
    assert_eq!(triggered.len(), 1);
    assert_matches(
        &triggered[0].payload,
        &[
            ("orderId", Json::str(stop_id)),
            ("triggerBy", Json::str("last")),
            ("stopPrice", Json::str("98")),
            ("referencePrice", Json::str("97")),
        ],
    );
}

#[test]
fn publishes_the_price_that_reached_a_plain_stop_when_a_sweep_goes_through_it_not_the_stop_price() {
    sweep_through(None);
}

#[test]
fn publishes_the_price_that_reached_a_stop_loss_when_a_sweep_goes_through_it_not_the_stop_price() {
    sweep_through(Some(TriggerRole::StopLoss));
}

#[test]
fn records_a_mark_stops_trigger_with_the_mark_that_reached_it() {
    let mut book = OrderBook::new(MARKET);
    let stop_id = uuid();
    let mut s = stop(&stop_id, "st", Side::Sell, "1", "90");
    s.trigger_by = Some(TriggerBy::Mark);
    book.submit(&s, None);
    assert!(
        book.apply_trigger_reference(TriggerBy::Mark, Some(a("95")))
            .is_empty()
    );

    let fired = book.apply_trigger_reference(TriggerBy::Mark, Some(a("88.5")));

    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].order_id, stop_id);
    assert_eq!(
        fired[0].trigger,
        Some(TriggerFact {
            by: TriggerBy::Mark,
            stop_price: a("90"),
            reference: a("88.5"),
        })
    );
}

fn keys(events: &[Published]) -> Vec<String> {
    events.iter().map(|e| e.key.clone()).collect()
}

#[test]
fn republishes_an_amend_fired_stops_fill_once_on_recovery_under_the_key_it_had_live() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Buy, "5", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "1", Some("100")),
    );
    let stop_id = uuid();
    submit(
        &mut engine,
        MARKET,
        &stop(&stop_id, "st", Side::Sell, "1", "90"),
    );
    engine
        .amend(MARKET, &amend(None, Some("100"), &stop_id), None)
        .unwrap();
    let live = bus.emitted("orderFilled");
    assert_eq!(
        live.iter()
            .filter(|e| text(&e.payload, "takerOrderId") == stop_id)
            .count(),
        1
    );

    let (mut recovered, recovery_bus) = recovery_engine(&records(&engine));
    recovered.recover().unwrap();

    assert_eq!(keys(&recovery_bus.emitted("orderFilled")), keys(&live));
    assert_eq!(
        keys(&recovery_bus.emitted("orderTriggered")),
        keys(&bus.emitted("orderTriggered"))
    );
}

#[test]
fn publishes_nothing_at_all_for_a_rejected_order() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("100")),
    );
    bus.reset();
    let result = submit(
        &mut engine,
        MARKET,
        &with_tif(order(&uuid(), "tk", Side::Buy, "9", Some("100")), Tif::Fok),
    );
    assert!(!result.accepted);
    assert!(bus.published().is_empty());
}

#[test]
fn emits_in_engine_sequence_order_so_a_consumer_replaying_the_subject_sees_the_book_order() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("101")),
    );
    bus.reset();

    submit(
        &mut engine,
        MARKET,
        &with_tif(order(&uuid(), "tk", Side::Buy, "5", None), Tif::Ioc),
    );

    let sequences: Vec<i64> = bus.published().iter().map(|e| seq_of(&e.payload)).collect();
    let mut sorted = sequences.clone();
    sorted.sort_unstable();
    assert_eq!(sequences, sorted);
    let mut unique = sorted.clone();
    unique.dedup();
    assert_eq!(unique.len(), sequences.len());
}

#[test]
fn uses_the_engine_sequence_as_the_fill_idempotency_key_a_redelivery_finds_the_original() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("100")),
    );
    let result = submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Buy, "1", Some("100")),
    );
    let filled = &bus.emitted("orderFilled")[0];
    assert_eq!(
        filled.key,
        format!(
            "matching.order.filled:{MARKET}:{}",
            result.fills[0].sequence
        )
    );
}

#[test]
fn never_puts_a_js_number_where_an_amount_belongs() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "2", Some("100.125")),
    );
    submit(
        &mut engine,
        MARKET,
        &with_tif(
            order(&uuid(), "tk", Side::Buy, "5", Some("100.125")),
            Tif::Ioc,
        ),
    );
    for envelope in bus.published() {
        for field in ["price", "qty", "remainingQty"] {
            match envelope.payload.get(field) {
                None => {}
                Some(Json::String(s)) => assert!(is_decimal(s), "{}.{field} = {s}", envelope.name),
                Some(other) => panic!("{}.{field} is not text: {other:?}", envelope.name),
            }
        }
    }
}

#[test]
fn keeps_markets_independent() {
    let (mut engine, _) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "1", Some("100")),
    );
    let result = submit(
        &mut engine,
        OTHER_MARKET,
        &order(&uuid(), "tk", Side::Buy, "1", Some("100")),
    );
    assert!(result.fills.is_empty());
    let mut expected = vec![MARKET.to_owned(), OTHER_MARKET.to_owned()];
    expected.sort_by(|x, y| js_sort_cmp(x, y));
    assert_eq!(engine.markets(), expected);
}

// ── recovery ─────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn rebuilds_the_books_from_the_journal_and_republishes_fills_with_the_original_keys() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Sell, "5", Some("100")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "mm", Side::Buy, "3", Some("99")),
    );
    submit(
        &mut engine,
        OTHER_MARKET,
        &order(&uuid(), "mm", Side::Sell, "2", Some("2000")),
    );
    let cancel_me = uuid();
    submit(
        &mut engine,
        MARKET,
        &order(&cancel_me, "mm", Side::Buy, "1", Some("98")),
    );
    engine
        .cancel(MARKET, &cancel_me, CancelReason::Requested)
        .unwrap();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Buy, "2", Some("100")),
    );

    let live = engine.serialize();
    let live_fills = bus.emitted("orderFilled");
    assert!(!live_fills.is_empty());

    let (mut recovered, recovery_bus) = recovery_engine(&records(&engine));
    let report = recovered.recover().unwrap();

    assert_eq!(report.records, engine.journal().len());
    assert_eq!(report.markets, 2);
    assert_eq!(recovered.serialize(), live);
    let recovered_fills = recovery_bus.emitted("orderFilled");
    assert_eq!(keys(&recovered_fills), keys(&live_fills));
    let seqs = |es: &[Published]| es.iter().map(|e| seq_of(&e.payload)).collect::<Vec<_>>();
    assert_eq!(seqs(&recovered_fills), seqs(&live_fills));
    assert!(recovery_bus.emitted("orderAccepted").is_empty());
}

#[test]
fn republishes_a_stop_trigger_on_recovery_with_its_original_key_and_price() {
    let (mut engine, bus) = build();
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b1", Side::Buy, "1", Some("99")),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "b2", Side::Buy, "5", Some("98")),
    );
    submit(
        &mut engine,
        MARKET,
        &stop(&uuid(), "st", Side::Sell, "1", "99"),
    );
    submit(
        &mut engine,
        MARKET,
        &order(&uuid(), "tk", Side::Sell, "1", Some("99")),
    );
    let live = bus.emitted("orderTriggered");
    assert_eq!(live.len(), 1);

    let (mut recovered, recovery_bus) = recovery_engine(&records(&engine));
    recovered.recover().unwrap();
    let again = recovery_bus.emitted("orderTriggered");
    assert_eq!(keys(&again), keys(&live));
    let payloads = |es: &[Published]| es.iter().map(|e| e.payload.clone()).collect::<Vec<_>>();
    assert_eq!(payloads(&again), payloads(&live));
}

fn temp_dir(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn recover_after_journal_fsync_without_emit_republishes_the_same_fill_not_a_new_one() {
    let dir = temp_dir("matching-recover-fill-");
    let path = dir.join("engine.ndjson");
    let maker = uuid();
    let taker = uuid();
    {
        reset_clock();
        let mut live = engine_on(
            Options {
                journal: Box::new(FileJournal::open(&path).unwrap()),
                ..Options::default()
            },
            Box::new(FailFilledBus::default()),
        );
        submit(
            &mut live,
            MARKET,
            &order(&maker, "mm", Side::Sell, "1", Some("100")),
        );
        let err = live
            .submit(
                MARKET,
                &order(&taker, "tk", Side::Buy, "1", Some("100")),
                None,
            )
            .unwrap_err();
        assert!(matches!(err, EngineError::Publish(_)), "{err}");
        assert!(err.to_string().contains("nats down after journal fsync"));
        assert_eq!(live.journal().len(), 2);
        // `journal.close()`: dropping the engine closes its journal.
    }

    let (mut recovered, recovery_bus) = build_with(Options {
        journal: Box::new(FileJournal::open(&path).unwrap()),
        ..Options::default()
    });
    recovered.recover().unwrap();

    let fills = recovery_bus.emitted("orderFilled");
    assert_eq!(fills.len(), 1);
    let fill = &fills[0];
    assert_eq!(text(&fill.payload, "makerOrderId"), maker);
    assert_eq!(text(&fill.payload, "takerOrderId"), taker);
    assert_eq!(
        fill.key,
        format!("matching.order.filled:{MARKET}:{}", seq_of(&fill.payload))
    );
    // The TypeScript hands the same open journal to a third engine; here the second engine owns it, so the third
    // opens the same file once the second is gone.
    drop(recovered);

    let (mut again, again_bus) = build_with(Options {
        journal: Box::new(FileJournal::open(&path).unwrap()),
        ..Options::default()
    });
    again.recover().unwrap();
    let again_fills = again_bus.emitted("orderFilled");
    assert_eq!(again_fills.len(), 1);
    assert_eq!(again_fills[0].key, fill.key);
    assert_eq!(seq_of(&again_fills[0].payload), seq_of(&fill.payload));
    assert_eq!(text(&again_fills[0].payload, "makerOrderId"), maker);
    assert_eq!(text(&again_fills[0].payload, "takerOrderId"), taker);
    assert_eq!(again_fills[0].payload.get("qty"), fill.payload.get("qty"));
    assert_eq!(
        again_fills[0].payload.get("price"),
        fill.payload.get("price")
    );
    drop(again);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn writes_a_snapshot_every_n_journal_records_and_no_more_often() {
    let sink = Sink::default();
    let (mut engine, _) = build_with(Options {
        snapshot_every: 3,
        sink: sink.clone(),
        ..Options::default()
    });
    for _ in 0..7 {
        submit(
            &mut engine,
            MARKET,
            &order(&uuid(), "mm", Side::Buy, "1", Some("100")),
        );
    }
    let writes = sink.0.lock().unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes.iter().map(|w| w.journal_seq).collect::<Vec<_>>(),
        [3, 6]
    );
}

#[test]
fn replays_forward_from_a_snapshot_to_the_same_state_as_a_full_replay() {
    let (mut engine, _) = build();
    for i in 0..12 {
        let buy = i % 2 == 0;
        submit(
            &mut engine,
            MARKET,
            &order(
                &uuid(),
                &format!("acct-{}", i % 3),
                if buy { Side::Buy } else { Side::Sell },
                "1",
                Some(if buy { "99" } else { "101" }),
            ),
        );
    }
    let snapshot = engine.snapshot();
    for i in 0..8 {
        let sell = i % 2 == 0;
        submit(
            &mut engine,
            MARKET,
            &order(
                &uuid(),
                "late",
                if sell { Side::Sell } else { Side::Buy },
                "2",
                Some(if sell { "99" } else { "101" }),
            ),
        );
    }
    let recs = records(&engine);
    let full = replay(&recs).serialize();
    let incremental = replay_from_snapshot(&snapshot, &recs).serialize();
    assert_eq!(incremental, full);
    assert_eq!(incremental, engine.serialize());
}

// ── §5.4 determinism ─────────────────────────────────────────────────────────────────────────────────────────────

/// `mulberry32(seed)`, in whole numbers: each draw is the 32-bit value `t` the TypeScript divides by 2^32.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// `rand() < p`, with `p` given as `p * 2^32` rounded up: `t / 2^32 < p` exactly when `t < ceil(p * 2^32)`.
    fn below(&mut self, threshold: u64) -> bool {
        u64::from(self.next()) < threshold
    }

    /// `Math.floor(rand() * len)`.
    fn index(&mut self, len: usize) -> usize {
        let len = u64::try_from(len).unwrap();
        usize::try_from((u64::from(self.next()) * len) >> 32).unwrap()
    }

    /// `xs[Math.floor(rand() * xs.length)]`.
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.index(xs.len())]
    }
}

/// `p * 2^32`, rounded up, for each probability the workload draws against.
const P_012: u64 = 515_396_076; // 0.12 * 2^32 = 515396075.52
const P_050: u64 = 2_147_483_648; // 0.5 * 2^32
const P_062: u64 = 2_662_879_724; // 0.62 * 2^32 = 2662879723.52
const P_080: u64 = 3_435_973_837; // 0.8 * 2^32 = 3435973836.8
const P_092: u64 = 3_951_369_913; // 0.92 * 2^32 = 3951369912.32

const PRICES: [&str; 13] = [
    "95", "96", "97", "97.5", "98", "99", "99.5", "100", "100.5", "101", "102", "103", "105",
];
const QTYS: [&str; 7] = ["0.5", "1", "1.5", "2", "3", "5", "0.000000000000000001"];
const MARKETS: [&str; 2] = [MARKET, OTHER_MARKET];
const ACCOUNTS: [&str; 6] = ["acct-0", "acct-1", "acct-2", "acct-3", "acct-4", "acct-5"];

struct Workload {
    journal: Vec<JournalRecord>,
    live_state: String,
    fills: usize,
    accepted: usize,
    rejected: usize,
}

/// ~1000 mixed operations across two markets, driven through the real engine.
fn run_workload(seed: u32) -> Workload {
    let operations = 1000;
    let mut rand = Mulberry32(seed);
    let (mut engine, _) = build();

    let mut submitted: Vec<(&str, String)> = Vec::new();
    let mut fills = 0;
    let mut accepted = 0;
    let mut rejected = 0;
    let mut n = 0;

    for _ in 0..operations {
        let market_id = rand.pick(&MARKETS);

        if rand.below(P_012) && !submitted.is_empty() {
            let (m, id) = submitted[rand.index(submitted.len())].clone();
            engine.cancel(m, &id, CancelReason::Requested).unwrap();
            continue;
        }

        let roll = rand.next();
        let roll = u64::from(roll);
        let order_type = if roll < P_062 {
            OrderType::Limit
        } else if roll < P_080 {
            OrderType::Market
        } else if roll < P_092 {
            OrderType::Stop
        } else {
            OrderType::StopLimit
        };
        let side = if rand.below(P_050) {
            Side::Buy
        } else {
            Side::Sell
        };
        let needs_price = matches!(order_type, OrderType::Limit | OrderType::StopLimit);
        let tif = if needs_price {
            rand.pick(&[
                Tif::Gtc,
                Tif::Gtc,
                Tif::Gtc,
                Tif::Gtc,
                Tif::Ioc,
                Tif::Fok,
                Tif::Po,
            ])
        } else {
            rand.pick(&[Tif::Ioc, Tif::Fok, Tif::Gtc])
        };

        n += 1;
        let order_id = format!("00000000-0000-4000-9000-{n:012}");
        let account = rand.pick(&ACCOUNTS);
        let qty = a(rand.pick(&QTYS));
        let price = needs_price.then(|| a(rand.pick(&PRICES)));
        let stop_price = matches!(order_type, OrderType::Stop | OrderType::StopLimit)
            .then(|| a(rand.pick(&PRICES)));
        let mut o = EngineOrder::new(order_id.clone(), account, order_type, side, qty, price, tif);
        o.stop_price = stop_price;
        let result = submit(&mut engine, market_id, &o);

        submitted.push((market_id, order_id));
        fills += result.fills.len();
        for t in &result.triggered {
            fills += t.fills.len();
        }
        if result.accepted {
            accepted += 1;
        } else {
            rejected += 1;
        }
    }

    Workload {
        journal: records(&engine),
        live_state: engine.serialize(),
        fills,
        accepted,
        rejected,
    }
}

fn journal_text(records: &[JournalRecord]) -> String {
    Json::Array(records.iter().map(|r| r.0.clone()).collect()).compact()
}

#[test]
fn produces_identical_state_on_two_independent_replays_of_1000_mixed_operations() {
    let workload = run_workload(0x00c0_ffee);
    let recs = &workload.journal;
    assert!(recs.len() > 900, "{}", recs.len());
    let first = replay(recs).serialize();
    let second = replay(recs).serialize();
    assert_eq!(first, second);
    assert!(first.len() > 200);
}

#[test]
fn replay_reconstructs_exactly_the_state_the_live_engine_reached() {
    let workload = run_workload(0x00c0_ffee);
    assert_eq!(replay(&workload.journal).serialize(), workload.live_state);
}

#[test]
fn the_workload_is_worth_asserting_on_it_fills_rests_and_rejects() {
    let workload = run_workload(0x00c0_ffee);
    assert!(workload.fills > 100, "fills {}", workload.fills);
    assert!(workload.accepted > 500, "accepted {}", workload.accepted);
    assert!(workload.rejected > 0);
    assert!(workload.live_state.contains("\"orders\""));
}

#[test]
fn is_reproducible_across_processes_worth_of_engines_same_journal_same_books() {
    let x = run_workload(0x5eed);
    let y = run_workload(0x5eed);
    assert_eq!(journal_text(&y.journal), journal_text(&x.journal));
    assert_eq!(y.live_state, x.live_state);
}

#[test]
fn a_different_seed_produces_a_different_book_the_test_can_actually_fail() {
    let x = run_workload(0x00c0_ffee);
    let y = run_workload(0x1234);
    assert_ne!(y.live_state, x.live_state);
}

/// `/:\s*-?\d+\.\d/`.
fn has_float_after_colon(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len()).filter(|&i| b[i] == b':').any(|i| {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'-' {
            j += 1;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        j > start && j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit()
    })
}

/// `/[eE][+-]\d/`.
fn has_exponent(s: &str) -> bool {
    s.as_bytes().windows(3).any(|w| {
        matches!(w[0], b'e' | b'E') && matches!(w[1], b'+' | b'-') && w[2].is_ascii_digit()
    })
}

/// Every `"<key>":"<value>"` for the keys given: the values.
fn quoted_values<'s>(s: &'s str, keys: &[&str]) -> Vec<&'s str> {
    let mut out = Vec::new();
    for key in keys {
        let needle = format!("\"{key}\":\"");
        let mut rest = s;
        while let Some(at) = rest.find(&needle) {
            let after = &rest[at + needle.len()..];
            let end = after.find('"').unwrap();
            if end > 0 {
                out.push(&after[..end]);
            }
            rest = &after[end..];
        }
    }
    out
}

#[test]
fn carries_no_floating_point_value_into_the_replayed_state() {
    let workload = run_workload(0x00c0_ffee);
    let state = replay(&workload.journal).serialize();
    assert!(!has_float_after_colon(&state));
    assert!(!has_exponent(&state));
    let values = quoted_values(
        &state,
        &["price", "remaining", "qty", "stopPrice", "lastTradePrice"],
    );
    assert!(!values.is_empty());
    for v in values {
        assert!(is_decimal(v), "{v}");
    }
}

/// `/"(?:qty|price|stopPrice)":\s*-?\d/`.
fn has_number_amount(s: &str) -> bool {
    ["qty", "price", "stopPrice"].iter().any(|key| {
        let needle = format!("\"{key}\":");
        s.match_indices(&needle).any(|(at, _)| {
            let rest = s[at + needle.len()..].trim_start();
            let rest = rest.strip_prefix('-').unwrap_or(rest);
            rest.as_bytes().first().is_some_and(u8::is_ascii_digit)
        })
    })
}

#[test]
fn the_journal_itself_is_a_decimal_string_document() {
    let workload = run_workload(0x00c0_ffee);
    let encoded = journal_text(&workload.journal);
    assert!(!has_number_amount(&encoded));
    assert_eq!(
        format_amount(a("0.000000000000000001")),
        "0.000000000000000001"
    );
}

// ── engine-l2-limit-unset-refuse.test.ts ─────────────────────────────────────────────────────────────────────────

#[test]
fn owner_explicit_50_is_published_not_invented() {
    let (engine, _) = build();
    assert!(engine.depth("BTC-USDT", 50).is_none());
}

// ── engine-snapshot-every-ctor-refuse.test.ts ────────────────────────────────────────────────────────────────────

#[test]
fn owner_explicit_500_is_published_not_invented() {
    let (engine, _) = build_with(Options {
        clock: None,
        snapshot_every: 500,
        ..Options::default()
    });
    assert!(engine.is_enabled());
}

#[test]
fn owner_explicit_0_disables_snapshotting_constructs_0_is_not_unset() {
    let (engine, _) = build_with(Options {
        clock: None,
        snapshot_every: 0,
        ..Options::default()
    });
    assert!(engine.is_enabled());
}

// ── gtd-journal-clock.test.ts ────────────────────────────────────────────────────────────────────────────────────

const GTC: &str = "11111111-1111-4111-8111-111111111111";
const GTD: &str = "44444444-4444-4444-8444-444444444444";
const GTT: &str = "55555555-5555-4555-8555-555555555555";
const ASK: &str = "66666666-6666-4666-8666-666666666666";
const OPEN_EXPIRE: &str = "2099-01-01T00:00:00.000Z";
const EXPIRE: &str = "2026-08-25T12:00:00.000Z";

fn ms(iso: &str) -> i64 {
    zod_datetime(iso, false).unwrap().0
}

fn gtd_order(
    id: &str,
    account: &str,
    side: Side,
    price: &str,
    tif: Tif,
    expire_at: Option<&str>,
) -> EngineOrder {
    let mut o = with_tif(order(id, account, side, "1", Some(price)), tif);
    o.expire_at = expire_at.map(str::to_owned);
    o
}

/// `engine(journal, clock?)`: no injected clock is the wall clock, and no expiry clock.
fn gtd_engine(journal: MemoryJournal, clock: Option<fn() -> i64>) -> (MatchingEngine, Bus) {
    let bus = Bus::default();
    let engine = engine_on(
        Options {
            journal: Box::new(journal),
            clock,
            ..Options::default()
        },
        Box::new(bus.clone()),
    );
    (engine, bus)
}

fn resting_ids(engine: &MatchingEngine) -> Vec<String> {
    let mut ids: Vec<String> = engine
        .resting_orders(Some(MARKET))
        .into_iter()
        .map(|o| o.order_id)
        .collect();
    ids.sort_by(|x, y| js_sort_cmp(x, y));
    ids
}

#[test]
fn refuses_a_clockless_gtd_gtt_before_the_journal_and_recover_does_not_match_a_second_clock_read() {
    let (mut live, _) = gtd_engine(MemoryJournal::new(), None);
    let ask = submit(
        &mut live,
        MARKET,
        &gtd_order(GTC, "mm", Side::Sell, "100", Tif::Gtc, None),
    );
    let gtd = submit(
        &mut live,
        MARKET,
        &gtd_order(GTD, "desk", Side::Buy, "100", Tif::Gtd, Some(OPEN_EXPIRE)),
    );
    let gtt = submit(
        &mut live,
        MARKET,
        &gtd_order(GTT, "gtt", Side::Buy, "99", Tif::Gtt, Some(OPEN_EXPIRE)),
    );

    assert!(ask.accepted);
    assert!(!gtd.accepted);
    assert_eq!(gtd.rejected.as_ref().unwrap().code, "engine_clock_missing");
    assert!(gtd.fills.is_empty());
    assert!(gtd.resting.is_none());
    assert!(!gtt.accepted);
    assert_eq!(gtt.rejected.as_ref().unwrap().code, "engine_clock_missing");
    let submitted: Vec<String> = live
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some("submit"))
        .map(|r| text(r.field("order").unwrap(), "orderId"))
        .collect();
    assert_eq!(submitted, [GTC]);
    assert_eq!(resting_ids(&live), [GTC]);

    let (mut recovered, recovered_bus) = gtd_engine(same_journal(&records(&live)), None);
    recovered.recover().unwrap();
    assert_eq!(resting_ids(&recovered), [GTC]);
    assert!(recovered_bus.emitted("orderFilled").is_empty());

    let before = ms("2026-08-25T11:00:00.000Z");
    let after = ms("2026-08-25T12:00:00.000Z");
    set_steps(vec![before, before, before, after]);
    let (mut crossed, _) = gtd_engine(MemoryJournal::new(), Some(stepped_clock));
    submit(
        &mut crossed,
        MARKET,
        &gtd_order(ASK, "mm", Side::Sell, "100", Tif::Gtc, None),
    );
    let taking = submit(
        &mut crossed,
        MARKET,
        &gtd_order(GTT, "desk", Side::Buy, "100", Tif::Gtt, Some(EXPIRE)),
    );
    let (mut replayed, replay_bus) = gtd_engine(same_journal(&records(&crossed)), None);
    replayed.recover().unwrap();

    assert_eq!(replayed.serialize(), crossed.serialize());
    let takers: Vec<String> = replay_bus
        .emitted("orderFilled")
        .iter()
        .map(|e| text(&e.payload, "takerOrderId"))
        .collect();
    let live_takers: Vec<String> = taking
        .fills
        .iter()
        .map(|f| f.taker_order_id.clone())
        .collect();
    assert_eq!(takers, live_takers);
}

// ── journal-gaps.test.ts: the holey tape over a real book ────────────────────────────────────────────────────────

const GAP_ASK: &str = "11111111-1111-4111-8111-111111111111";
const LATER: &str = "33333333-3333-4333-8333-333333333333";
const T0: &str = "2026-09-02T22:00:00.000Z";
const T1: &str = "2026-09-02T22:00:01.000Z";
const T2: &str = "2026-09-02T22:00:02.000Z";

fn gap_ask(id: &str, price: &str) -> EngineOrder {
    order(id, "mm", Side::Sell, "2", Some(price))
}

fn stamp(at: &str, seq: Option<i64>, kind: Option<&str>) -> GatewayStamp {
    GatewayStamp {
        at: at.to_owned(),
        seq,
        kind: kind.map(str::to_owned),
    }
}

#[test]
fn replay_of_holey_reconstruct_transitions_does_not_invent_a_fill_that_was_never_journalled() {
    let holey = vec![
        record(Json::obj([
            ("kind", Json::str("submit")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str(T0)),
            ("seq", Json::int(1)),
            ("order", to_wire(&gap_ask(GAP_ASK, "100"), None)),
        ])),
        record(Json::obj([
            ("kind", Json::str("submit")),
            ("marketId", Json::str(MARKET)),
            ("at", Json::str(T2)),
            ("seq", Json::int(4)),
            ("order", to_wire(&gap_ask(LATER, "101"), None)),
        ])),
    ];
    let reconstructed = reconstruct_transitions(
        &holey,
        &[
            stamp(T0, Some(1), None),
            stamp(T1, Some(2), Some("fill")),
            stamp(T2, Some(4), None),
        ],
    );
    assert_eq!(reconstructed.transitions.len(), 2);
    assert_eq!(
        reconstructed
            .transitions
            .iter()
            .map(|r| r.kind().unwrap())
            .collect::<Vec<_>>(),
        ["submit", "submit"]
    );
    let books = replay(reconstructed.transitions);
    let state = books.0[MARKET].to_state();
    let first_ask = item(state.get("asks").unwrap(), 0).unwrap();
    let first_order = item(first_ask.get("orders").unwrap(), 0).unwrap();
    assert_eq!(text(first_order, "orderId"), GAP_ASK);
    assert_eq!(text(first_order, "remaining"), "2");
    assert_eq!(state.get("lastTradePrice"), Some(&Json::Null));
    assert!(list(state.get("bids")).is_empty());
}
