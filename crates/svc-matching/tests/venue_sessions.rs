//! The venue slice's dead sessions, halts' dual control and surveillance evidence, proven with the TypeScript's own
//! tests ported test for test: `engine/session.test.ts`, `engine/cod-fence.test.ts`,
//! `engine/surveillance-persist.test.ts` and `engine/surveillance-case.test.ts` (all under
//! `services/svc-matching/src/`). Each test is named after the TypeScript `it` it ports, prefixed with its file's topic.
//! `index.ts` installs `cod-fence.ts` and `surveillance-persist.ts` over the base engine, and those wrappers are what
//! the Rust engine follows.
//!
//! Not ported, and why:
//! - session `still records the session dead if a book.cancel throws`, cod-fence `cancelIdsIndependently names the
//!   throw`, `one cancel throw still cancels the other` and `one book cancel throw still cancels the other market`:
//!   each replaces a book's or the engine's `cancel` with one that throws. A Rust cancel cannot throw and nothing can
//!   replace it, so the `failed` rows they read have no source here (`SessionDeadResult` has no `failed`).
//! - cod-fence `split-brain`: `declareSplitBrain` is reached by no door and this slice does not port it.
//! - surveillance-persist `returns the accepted SubmitResult when the journal throws on read`: a Rust journal's `read`
//!   cannot fail. The `append` half is ported.
//! - cod-fence's mass-cancel parts are not in `engine_calls.rs` (it ports `mass-cancel.test.ts`, not these); the one
//!   that injects no throw, `cancels both lives when neither throw`, is ported here.
//!
//! Ported in part, and why:
//! - `recordOpenSurveillanceCase`, `runDetector`, `detectorStatus`, `closeSurveillanceCase` and
//!   `punishSurveillanceCase` are reached by no door and are not ported. A test that records a case appends the
//!   `open_surveillance` record `persistToJournal` writes and recovers, as `engine_calls.rs` does with a mode switch; the
//!   checks before that recover (the in-process store) have nothing to read. The detectors and the adjudicate and fine
//!   refusals are read where the Rust answers them: the `/surveillance/*` doors (`door/venue.rs`).
//! - cod-fence's halt tests install only cod-fence. In production cod-fence installs last, so its dual control runs
//!   before `rulebook-refuse.ts`'s evidence gate, and the Rust switch follows that: the refused call names no evidence,
//!   as in the TypeScript; the accepted one names evidence, which the production gate behind the dual control asks.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Request;
use svc_matching::approval::Unwired;
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::rules::{LiveSession, session_order_ids};
use svc_matching::book::types::{
    CancelReason, EngineOrder, OrderType, Side, SurveillanceCase, Tif,
};
use svc_matching::book::wire::{from_wire, to_wire};
use svc_matching::door::venue::{VenueConfig, serve};
use svc_matching::door::{Outcome, ROUTES};
use svc_matching::engine::venue::{Switch, SwitchCmd, open_surveillance_case};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::journal::JournalError;
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::{JournalCommand, JournalRecord};
use svc_matching::journal::replay::{
    MemorySnapshotSink, ReplayBooks, ReplayCancel, js_sort_cmp, replay_from, replay_journal,
};

const MARKET: &str = "BTC/USDT";
const OTHER: &str = "ETH/USDT";
const AT: &str = "2026-09-03T00:00:00.000Z";

fn at_ms() -> i64 {
    1_787_673_600_000
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

fn strs(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

// ── engines ─────────────────────────────────────────────────────────────

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
    fn emitted(&self, name: &str) -> Vec<Published> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == name)
            .cloned()
            .collect()
    }
}

/// `new MatchingEngine({ journal, bus, snapshotEvery: 0 })`: no clock is given, so GTD and GTT refuse; the stamp is
/// fixed here.
fn engine_on(
    journal: Box<dyn EngineJournal + Send>,
    bus: Box<dyn EventBus + Send>,
) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus,
        clock: at_ms,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    })
}

/// `build()`: a memory journal, a memory bus, no snapshots.
fn build() -> (MatchingEngine, Bus) {
    let bus = Bus::default();
    (
        engine_on(Box::new(MemoryJournal::new()), Box::new(bus.clone())),
        bus,
    )
}

/// The engine's journal, copied record for record.
fn copy_journal(engine: &MatchingEngine) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

/// `new MatchingEngine({ journal, bus: new MemoryEventBus(...) }).recover()` on the same journal.
fn recovered_from(journal: MemoryJournal) -> MatchingEngine {
    let mut next = engine_on(Box::new(journal), Box::new(MemoryEventBus::default()));
    next.recover().unwrap();
    next
}

fn jlen(engine: &MatchingEngine) -> usize {
    engine.journal().len()
}

fn kinds(records: &[JournalRecord]) -> Vec<String> {
    records
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
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

// ── orders ──────────────────────────────────────────────────────────────

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

fn stop(id: &str, account: &str, side: Side, qty: &str, stop_price: &str) -> EngineOrder {
    let mut o = EngineOrder::new(id, account, OrderType::Stop, side, a(qty), None, Tif::Gtc);
    o.stop_price = Some(a(stop_price));
    o
}

fn tagged(mut o: EngineOrder, session: &str) -> EngineOrder {
    o.session_id = Some(session.to_owned());
    o
}

fn submit(
    engine: &mut MatchingEngine,
    market: &str,
    o: &EngineOrder,
) -> svc_matching::book::types::SubmitResult {
    engine.submit(market, o, None).unwrap()
}

// ── JSON reads ──────────────────────────────────────────────────────────

fn arr<'a>(j: &'a Json, k: &str) -> &'a [Json] {
    match j.get(k) {
        Some(Json::Array(v)) => v,
        other => panic!("{k} is an array: {other:?}"),
    }
}

fn text(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k} is text: {other:?}"),
    }
}

/// `liveIds(book)`: every rest's and stop's id, sorted.
fn live_ids_of(book: &OrderBook) -> Vec<String> {
    let s = book.to_state();
    let mut ids = Vec::new();
    for side in ["bids", "asks"] {
        for level in arr(&s, side) {
            for o in arr(level, "orders") {
                ids.push(text(o, "orderId"));
            }
        }
    }
    for st in arr(&s, "stops") {
        ids.push(text(st, "orderId"));
    }
    ids.sort();
    ids
}

/// `liveIds(engine, marketId)`: none when the engine holds no book for the market.
fn live_ids(engine: &MatchingEngine, market: &str) -> Vec<String> {
    engine
        .existing_book(market)
        .map(live_ids_of)
        .unwrap_or_default()
}

// ── replay over plain books (`replay`, `replayFrom`, `serializeBooks`) ──

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

    /// `restingIds(books, marketId)`.
    fn resting_ids(&self, market: &str) -> Vec<String> {
        self.0.get(market).map(live_ids_of).unwrap_or_default()
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

    fn amend(&mut self, _market_id: &str, _record: &JournalRecord, _clock: Option<i64>) {
        panic!("no amend is journalled in these tests");
    }

    fn mark(&mut self, _market_id: &str, _record: &JournalRecord) {
        panic!("a trailing-stop mark is the triggers slice's");
    }

    fn mass_cancel(&mut self, _market_id: &str, _record: &JournalRecord) {
        panic!("no mass cancel is journalled in these tests");
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

// ── the venue doors ─────────────────────────────────────────────────────

/// What a `/surveillance/*` door answers, past the caller check.
fn surveillance_door(engine: &mut MatchingEngine, method: &str, path: &str) -> Json {
    let venue = VenueConfig {
        approvals: Box::new(Unwired),
        operator_ids: Vec::new(),
    };
    let route = ROUTES
        .iter()
        .find(|r| r.method == method && r.path == path)
        .unwrap();
    let url = format!("{path}?limit=50");
    let req = Request {
        method,
        url: &url,
        headers: &[],
        body: "",
    };
    match serve(
        &venue,
        route,
        &req,
        &|_| String::new(),
        &Value::Undefined,
        engine,
    ) {
        Outcome::Answer(r) => {
            assert_eq!(r.status, 200, "{}", r.body);
            json::parse(&r.body).unwrap()
        }
        Outcome::Owed(s) => panic!("owed by {}", s.name()),
    }
}

/// The record `persistToJournal` appends for a case `recordOpenSurveillanceCase` opens.
fn open_surveillance_record(account: &str, market: &str, reason: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str("open_surveillance")),
        ("marketId", Json::str(market)),
        ("at", Json::str(AT)),
        ("accountId", Json::str(account)),
        ("reason", Json::str(reason)),
    ]))
}

fn case(account: &str, market: &str, reason: &str) -> SurveillanceCase {
    SurveillanceCase {
        account_id: account.to_owned(),
        market_id: market.to_owned(),
        reason: reason.to_owned(),
    }
}

fn spoofing_case() -> SurveillanceCase {
    case("desk", MARKET, "spoofing")
}

fn layering_case() -> SurveillanceCase {
    case("desk", MARKET, "layering")
}

// ═══ session.test.ts ════════════════════════════════════════════════════

mod session {
    use super::*;

    const REST: &str = "11111111-1111-4111-8111-111111111111";
    const KEEP: &str = "22222222-2222-4222-8222-222222222222";
    const TAKER: &str = "33333333-3333-4333-8333-333333333333";
    const OTHER_REST: &str = "44444444-4444-4444-8444-444444444444";
    const STOP: &str = "55555555-5555-4555-8555-555555555555";
    const AFTER: &str = "66666666-6666-4666-8666-666666666666";

    #[test]
    fn cancels_tagged_rests_on_every_market_and_reports_session_dead_so_the_hold_can_release() {
        let (mut engine, bus) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );
        submit(
            &mut engine,
            OTHER,
            &tagged(limit(OTHER_REST, "desk", Side::Sell, "2", "200"), "sess-1"),
        );
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(KEEP, "mm", Side::Sell, "3", "101"), "sess-2"),
        );

        let dead = engine.session_dead(Some("sess-1")).unwrap();

        assert!(dead.accepted);
        assert_eq!(dead.session_id.as_deref(), Some("sess-1"));
        assert_eq!(
            dead.cancellations
                .iter()
                .map(|c| (c.order_id.clone(), c.reason))
                .collect::<Vec<_>>(),
            vec![
                (REST.to_owned(), CancelReason::SessionDead),
                (OTHER_REST.to_owned(), CancelReason::SessionDead),
            ]
        );
        assert_eq!(dead.cancellations[0].reason.as_str(), "session_dead");
        assert_eq!(live_ids(&engine, MARKET), strs(&[KEEP]));
        assert_eq!(live_ids(&engine, OTHER), Vec::<String>::new());
        assert!(engine.is_session_dead("sess-1"));
        assert!(!engine.is_session_dead("sess-2"));

        assert_eq!(
            sorted(
                bus.emitted("orderCancelled")
                    .iter()
                    .map(|e| text(&e.payload, "orderId"))
                    .collect()
            ),
            sorted(strs(&[OTHER_REST, REST]))
        );
    }

    #[test]
    fn does_not_fill_a_tagged_rest_after_session_dead_a_later_cross_misses_it() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );
        engine.session_dead(Some("sess-1")).unwrap();

        let take = submit(
            &mut engine,
            MARKET,
            &limit(TAKER, "mm", Side::Buy, "1", "100"),
        );

        assert!(take.accepted);
        assert!(take.fills.is_empty());
        assert_eq!(
            take.resting.as_ref().map(|r| r.order_id.as_str()),
            Some(TAKER)
        );
        assert_eq!(live_ids(&engine, MARKET), strs(&[TAKER]));
    }

    #[test]
    fn leaves_an_untagged_rest_the_engine_does_not_invent_a_session() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &limit(KEEP, "desk", Side::Sell, "1", "100"),
        );
        let dead = engine.session_dead(Some("sess-1")).unwrap();

        assert!(dead.accepted);
        assert!(dead.cancellations.is_empty());
        assert_eq!(live_ids(&engine, MARKET), strs(&[KEEP]));
    }

    #[test]
    fn pulls_a_tagged_stop_and_leaves_a_stranger_stop() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(stop(STOP, "desk", Side::Buy, "1", "110"), "sess-1"),
        );
        submit(
            &mut engine,
            MARKET,
            &stop(KEEP, "mm", Side::Sell, "1", "90"),
        );

        let dead = engine.session_dead(Some("sess-1")).unwrap();

        assert_eq!(
            dead.cancellations
                .iter()
                .map(|c| c.order_id.clone())
                .collect::<Vec<_>>(),
            strs(&[STOP])
        );
        assert_eq!(live_ids(&engine, MARKET), strs(&[KEEP]));
    }

    #[test]
    fn refuses_a_new_submit_tagged_with_the_dead_session_and_journals_nothing_for_that_submit() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );
        engine.session_dead(Some("sess-1")).unwrap();
        let before = jlen(&engine);

        let result = submit(
            &mut engine,
            MARKET,
            &tagged(limit(AFTER, "desk", Side::Buy, "1", "99"), "sess-1"),
        );

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "session_gone");
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn still_accepts_a_submit_with_a_live_session_or_no_session() {
        let (mut engine, _) = build();
        engine.session_dead(Some("sess-1")).unwrap();

        let live = submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-2"),
        );
        let plain = submit(
            &mut engine,
            MARKET,
            &limit(KEEP, "mm", Side::Sell, "1", "101"),
        );

        assert!(live.accepted);
        assert!(plain.accepted);
    }

    #[test]
    fn refuses_session_dead_without_a_session_does_not_invent_one() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &limit(KEEP, "desk", Side::Sell, "1", "100"),
        );

        let missing = engine.session_dead(None).unwrap();
        assert!(!missing.accepted);
        assert_eq!(missing.rejected.as_ref().unwrap().code, "missing_session");
        assert!(!engine.is_session_dead("sess-1"));
        assert_eq!(jlen(&engine), 1);

        let blank = engine.session_dead(Some("   ")).unwrap();
        assert!(!blank.accepted);
        assert_eq!(blank.rejected.as_ref().unwrap().code, "missing_session");
        assert_eq!(live_ids(&engine, MARKET), strs(&[KEEP]));
    }

    #[test]
    fn mass_cancel_with_a_session_id_still_refuses_session_dead_is_the_door() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );

        let result = engine
            .mass_cancel(MARKET, "desk", Some("sess-1"), None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(
            result.rejected.as_ref().unwrap().code,
            "session_unsupported"
        );
        assert_eq!(live_ids(&engine, MARKET), strs(&[REST]));
    }

    #[test]
    fn replays_session_dead_so_a_recovered_engine_still_has_no_tagged_rest_and_still_refuses() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );
        engine.session_dead(Some("sess-1")).unwrap();

        let mut recovered = recovered_from(copy_journal(&engine));

        assert!(recovered.is_session_dead("sess-1"));
        // `replayDeadSessions(journal.read())`: the sessions a cold start read back as dead.
        assert!(
            recovered
                .snapshot()
                .dead_sessions
                .contains(&"sess-1".to_owned())
        );
        assert_eq!(live_ids(&recovered, MARKET), Vec::<String>::new());

        let restored = replay(engine.journal().read());
        assert!(!restored.0.contains_key(MARKET));

        let blocked = submit(
            &mut recovered,
            MARKET,
            &tagged(limit(AFTER, "desk", Side::Buy, "1", "99"), "sess-1"),
        );
        assert!(!blocked.accepted);
        assert_eq!(blocked.rejected.as_ref().unwrap().code, "session_gone");
    }

    #[test]
    fn a_snapshot_taken_after_session_dead_does_not_rest_a_later_submit_for_that_session() {
        let (mut engine, _) = build();
        engine.session_dead(Some("sess-1")).unwrap();
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.dead_sessions, strs(&["sess-1"]));
        assert_eq!(snapshot.journal_seq, jlen(&engine));

        let mut journal = copy_journal(&engine);
        let submit_record = |at: &str, o: &EngineOrder| {
            JournalCommand(Json::obj([
                ("kind", Json::str("submit")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str(at)),
                ("order", to_wire(o, None)),
            ]))
        };
        journal
            .append(&submit_record(
                "2026-10-08T00:00:00.000Z",
                &tagged(limit(AFTER, "desk", Side::Buy, "1", "99"), "sess-1"),
            ))
            .unwrap();
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("session_dead")),
                ("at", Json::str("2026-10-08T00:00:01.000Z")),
                ("sessionId", Json::str("sess-3")),
            ])))
            .unwrap();
        journal
            .append(&submit_record(
                "2026-10-08T00:00:02.000Z",
                &tagged(limit(TAKER, "mm", Side::Buy, "1", "98"), "sess-3"),
            ))
            .unwrap();
        journal
            .append(&submit_record(
                "2026-10-08T00:00:03.000Z",
                &tagged(limit(KEEP, "mm", Side::Sell, "1", "101"), "sess-2"),
            ))
            .unwrap();

        let records = journal.read();
        #[expect(
            clippy::cast_precision_loss,
            reason = "a journal's length is far below 2^53"
        )]
        let after = snapshot.journal_seq as f64;
        let tail: Vec<JournalRecord> = records
            .iter()
            .filter(|r| matches!(r.field("seq"), Some(Json::Number(n)) if *n > after))
            .cloned()
            .collect();
        assert_eq!(
            kinds(&tail),
            strs(&["submit", "session_dead", "submit", "submit"])
        );

        let full = replay(records);
        let mut from_snapshot = Books::default();
        for state in &snapshot.books {
            let book = OrderBook::from_state(state).unwrap();
            from_snapshot.0.insert(book.market_id().to_owned(), book);
        }
        replay_from(
            snapshot.journal_seq,
            &snapshot.dead_sessions,
            records,
            &mut from_snapshot,
        )
        .unwrap();
        assert_eq!(from_snapshot.serialize(), full.serialize());
        assert_eq!(from_snapshot.resting_ids(MARKET), strs(&[KEEP]));
        assert_eq!(full.resting_ids(MARKET), strs(&[KEEP]));
    }

    #[test]
    fn snapshot_restore_keeps_the_session_tag_so_a_later_session_dead_still_pulls_it() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1", "100"), "sess-1"),
        );
        let s = engine.existing_book(MARKET).unwrap().to_state();
        assert_eq!(
            text(&arr(&arr(&s, "asks")[0], "orders")[0], "sessionId"),
            "sess-1"
        );

        let dead = engine.session_dead(Some("sess-1")).unwrap();
        assert_eq!(dead.cancellations.len(), 1);
    }

    #[test]
    fn session_order_ids_is_oldest_sequence_first_missing_session_matches_nothing() {
        let live = [
            LiveSession {
                order_id: "b",
                session_id: Some("sess-1"),
                sequence: 2,
            },
            LiveSession {
                order_id: "a",
                session_id: Some("sess-1"),
                sequence: 1,
            },
            LiveSession {
                order_id: "c",
                session_id: Some("sess-2"),
                sequence: 3,
            },
            LiveSession {
                order_id: "d",
                session_id: None,
                sequence: 0,
            },
        ];
        assert_eq!(session_order_ids("sess-1", &live), strs(&["a", "b"]));
        assert!(
            session_order_ids(
                "",
                &[LiveSession {
                    order_id: "a",
                    session_id: Some("sess-1"),
                    sequence: 1,
                }]
            )
            .is_empty()
        );
    }

    #[test]
    fn does_not_invent_a_fill_qty_as_a_js_number() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &tagged(limit(REST, "desk", Side::Sell, "1.5", "100"), "sess-1"),
        );
        let dead = engine.session_dead(Some("sess-1")).unwrap();
        assert_eq!(f(dead.cancellations[0].remaining_qty), "1.5");
    }
}

// ═══ cod-fence.test.ts ══════════════════════════════════════════════════

mod cod_fence {
    use super::*;

    const ASK: &str = "11111111-1111-4111-8111-111111111111";
    const ASK2: &str = "22222222-2222-4222-8222-222222222222";

    /// `{ operatorId }`: one operator, nothing else.
    fn one(operator: &str) -> SwitchCmd {
        SwitchCmd {
            operator_id: Some(operator.to_owned()),
            ..SwitchCmd::default()
        }
    }

    /// `{ operatorId, confirmOperatorId }`, with the evidence `rulebook-refuse.ts` asks after the dual control.
    fn two(operator: &str, confirm: &str) -> SwitchCmd {
        SwitchCmd {
            operator_id: Some(operator.to_owned()),
            confirm_operator_id: Some(confirm.to_owned()),
            evidence: Some("incident-1".to_owned()),
            ..SwitchCmd::default()
        }
    }

    #[test]
    fn mass_cancel_cancels_both_lives_when_neither_throw() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &limit(ASK, "desk", Side::Sell, "1", "100"),
        );
        submit(
            &mut engine,
            MARKET,
            &limit(ASK2, "desk", Side::Sell, "1", "101"),
        );
        let result = engine.mass_cancel(MARKET, "desk", None, None).unwrap();
        assert!(result.accepted);
        assert_eq!(
            sorted(
                result
                    .cancellations
                    .iter()
                    .map(|c| c.order_id.clone())
                    .collect()
            ),
            sorted(strs(&[ASK, ASK2]))
        );
        assert!(result.failed.is_empty());
        assert_eq!(live_ids(&engine, MARKET), Vec::<String>::new());
    }

    #[test]
    fn halt_all_without_confirm_operator_id_refuses_two_distinct_operators_accepts() {
        let (mut engine, _) = build();
        let missing = engine.switch(Switch::HaltAll, "", &one("ops-1")).unwrap();
        assert!(!missing.accepted);
        assert_eq!(missing.rejected.as_ref().unwrap().code, "missing_operator");
        assert!(!engine.mode_state(Switch::HaltAll, ""));

        let halt = engine
            .switch(Switch::HaltAll, "", &two("ops-1", "ops-2"))
            .unwrap();
        assert!(halt.accepted);
        assert!(halt.state);
        assert!(engine.mode_state(Switch::HaltAll, ""));
    }

    #[test]
    fn one_market_halt_without_confirm_operator_id_refuses_two_distinct_operators_accepts() {
        let (mut engine, _) = build();
        let missing = engine.switch(Switch::Halt, MARKET, &one("ops-1")).unwrap();
        assert!(!missing.accepted);
        assert_eq!(missing.rejected.as_ref().unwrap().code, "missing_operator");
        assert!(!engine.mode_state(Switch::Halt, MARKET));

        let halt = engine
            .switch(Switch::Halt, MARKET, &two("ops-1", "ops-2"))
            .unwrap();
        assert!(halt.accepted);
        assert!(halt.state);
        assert_eq!(halt.confirm_operator_id, Some(Some("ops-2".to_owned())));
        assert!(engine.mode_state(Switch::Halt, MARKET));
    }
}

// ═══ surveillance-persist.test.ts ═══════════════════════════════════════

mod surveillance_persist {
    use super::*;

    const OWN: &str = "11111111-1111-4111-8111-111111111111";
    const TAKE: &str = "22222222-2222-4222-8222-222222222222";

    /// Match appends succeed. The surveillance append after accept fails.
    struct FaultAfterAcceptJournal(MemoryJournal);

    impl EngineJournal for FaultAfterAcceptJournal {
        fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
            if command.0.get("kind") == Some(&Json::str("open_surveillance")) {
                return Err(JournalError::Io(std::io::Error::other(
                    "journal append failed",
                )));
            }
            self.0.append(command)
        }

        fn read(&self) -> &[JournalRecord] {
            self.0.read()
        }

        fn len(&self) -> usize {
            self.0.len()
        }

        fn close(&mut self) -> Result<(), JournalError> {
            self.0.close()
        }
    }

    fn cases_json(answer: &Json) -> Vec<Json> {
        arr(answer, "cases").to_vec()
    }

    #[test]
    fn named_spoofing_case_persists_across_recover_wrap() {
        let opened = open_surveillance_case(Some("desk"), Some(MARKET), Some("spoofing"));
        assert_eq!(opened, Ok(spoofing_case()));
        let mut journal = MemoryJournal::new();
        journal
            .append(&open_surveillance_record("desk", MARKET, "spoofing"))
            .unwrap();
        let mut engine = engine_on(Box::new(journal), Box::new(MemoryEventBus::default()));

        engine.recover().unwrap();

        let persisted = engine.open_surveillance_cases();
        assert_eq!(persisted, vec![spoofing_case()]);
        let shown = persisted[0].to_json();
        assert_eq!(text(&shown, "status"), "open");
        assert!(shown.get("closed").is_none());
    }

    #[test]
    fn spoofing_layering_stay_open_adjudicate_refuses_auto_adjudicate_forbidden() {
        let mut journal = MemoryJournal::new();
        journal
            .append(&open_surveillance_record("desk", MARKET, "spoofing"))
            .unwrap();
        journal
            .append(&open_surveillance_record("desk", MARKET, "layering"))
            .unwrap();
        let mut engine = recovered_from(journal);

        // The door takes no reason: one refusal stands for spoofing, layering, self_trade and the direct call.
        let refused = surveillance_door(&mut engine, "POST", "/surveillance/adjudicate");
        assert_eq!(refused.get("ok"), Some(&Json::Bool(false)));
        assert_eq!(text(&refused, "code"), "auto_adjudicate_forbidden");

        let open = engine.open_surveillance_cases();
        assert_eq!(open, vec![layering_case(), spoofing_case()]);
        let listed = cases_json(&refused);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|row| text(row, "status") == "open"));
    }

    #[test]
    fn detector_status_spoofing_is_disabled_detector_gap_with_threshold_null_not_0_run_detector_invents_no_case()
     {
        let (mut engine, _) = build();
        let answer = surveillance_door(&mut engine, "GET", "/surveillance/cases");
        let detectors = answer.get("detectors").unwrap();
        for reason in ["spoofing", "layering"] {
            let status = detectors.get(reason).unwrap();
            assert_eq!(status.get("enabled"), Some(&Json::Bool(false)));
            assert_eq!(text(status, "gap"), "detector_gap");
            assert_eq!(text(status, "reason"), reason);
            assert_eq!(status.get("threshold"), Some(&Json::Null));
            assert_ne!(status.get("threshold"), Some(&Json::int(0)));
        }
        assert!(cases_json(&answer).is_empty());
        assert!(engine.open_surveillance_cases().is_empty());
    }

    #[test]
    fn self_trade_mill_still_opens_close_surveillance_case_still_auto_close_forbidden() {
        let (mut engine, _) = build();
        submit(
            &mut engine,
            MARKET,
            &limit(OWN, "same", Side::Buy, "1", "100"),
        );
        let take = submit(
            &mut engine,
            MARKET,
            &limit(TAKE, "same", Side::Sell, "1", "100"),
        );

        let named = case("same", MARKET, "self_trade");
        assert!(take.accepted);
        assert_eq!(take.surveillance_cases, vec![named.clone()]);
        assert_eq!(engine.open_surveillance_cases(), vec![named.clone()]);
        assert_eq!(engine.open_surveillance_cases().len(), 1);

        engine.recover().unwrap();
        assert_eq!(engine.open_surveillance_cases(), vec![named]);

        assert_eq!(
            text(&engine.open_surveillance_cases()[0].to_json(), "status"),
            "open"
        );
    }

    #[test]
    fn no_matching_surveillance_env_invented() {
        assert_eq!(
            std::env::vars()
                .map(|(k, _)| k)
                .filter(|k| k.starts_with("MATCHING_SURVEILLANCE_"))
                .collect::<Vec<_>>(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn file_journal_encode_of_open_surveillance_keeps_account_market_named_reason_no_fine() {
        let path = temp_dir("matching-h9-surv-").join("engine.ndjson");
        let mut journal = FileJournal::open(&path).unwrap();
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("open_surveillance")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-09-03T00:00:00.000Z")),
                ("accountId", Json::str("desk")),
                ("reason", Json::str("spoofing")),
            ])))
            .unwrap();
        journal.close().unwrap();

        let on_disk = json::parse(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(text(&on_disk, "kind"), "open_surveillance");
        assert_eq!(text(&on_disk, "accountId"), "desk");
        assert_eq!(text(&on_disk, "marketId"), MARKET);
        assert_eq!(text(&on_disk, "reason"), "spoofing");
        assert!(on_disk.get("fine").is_none());
        assert!(on_disk.get("amount").is_none());
        assert!(on_disk.get("orderId").is_none());
    }

    #[test]
    fn named_spoofing_layering_survive_a_new_engine_recover_from_file_journal() {
        let path = temp_dir("matching-h9-surv-").join("engine.ndjson");
        {
            let mut j1 = FileJournal::open(&path).unwrap();
            j1.append(&open_surveillance_record("desk", MARKET, "spoofing"))
                .unwrap();
            j1.append(&open_surveillance_record("desk", MARKET, "layering"))
                .unwrap();
            j1.close().unwrap();
        }

        let mut recovered = engine_on(
            Box::new(FileJournal::open(&path).unwrap()),
            Box::new(MemoryEventBus::default()),
        );
        recovered.recover().unwrap();

        let open = recovered.open_surveillance_cases();
        assert_eq!(open, vec![layering_case(), spoofing_case()]);
        let shown: Vec<Json> = open.iter().map(SurveillanceCase::to_json).collect();
        assert!(shown.iter().all(|row| text(row, "status") == "open"));
        assert!(shown[0].get("fine").is_none());
        let records = recovered.journal().read();
        assert_eq!(
            kinds(records)
                .iter()
                .filter(|k| *k == "open_surveillance")
                .count(),
            2
        );
        assert!(replay(records).0.is_empty());
    }

    #[test]
    fn self_trade_from_file_journal_submit_replay_stays_open_replay_does_not_cancel_from_open_surveillance()
     {
        let path = temp_dir("matching-h9-surv-").join("engine.ndjson");
        let named = case("same", MARKET, "self_trade");
        {
            let mut live = engine_on(
                Box::new(FileJournal::open(&path).unwrap()),
                Box::new(MemoryEventBus::default()),
            );
            submit(
                &mut live,
                MARKET,
                &limit(OWN, "same", Side::Buy, "1", "100"),
            );
            submit(
                &mut live,
                MARKET,
                &limit(TAKE, "same", Side::Sell, "1", "100"),
            );
            assert_eq!(live.open_surveillance_cases(), vec![named.clone()]);
        }

        let mut recovered = engine_on(
            Box::new(FileJournal::open(&path).unwrap()),
            Box::new(MemoryEventBus::default()),
        );
        recovered.recover().unwrap();
        assert_eq!(recovered.open_surveillance_cases(), vec![named]);
        let k = kinds(recovered.journal().read());
        assert!(k.iter().any(|k| k == "open_surveillance"));
        assert!(!k.iter().any(|k| k == "cancel"));
    }

    #[test]
    fn returns_the_accepted_submit_result_when_the_journal_throws_on_append_after_a_matched_submit()
    {
        let mut engine = engine_on(
            Box::new(FaultAfterAcceptJournal(MemoryJournal::new())),
            Box::new(MemoryEventBus::default()),
        );
        submit(
            &mut engine,
            MARKET,
            &limit(OWN, "same", Side::Buy, "1", "100"),
        );
        let take = submit(
            &mut engine,
            MARKET,
            &limit(TAKE, "same", Side::Sell, "1", "100"),
        );

        assert!(take.accepted);
        assert!(take.rejected.is_none());
        assert!(take.fills.is_empty());
        let resting = take.resting.as_ref().unwrap();
        assert_eq!(resting.order_id, TAKE);
        assert_eq!(resting.remaining, a("1"));
        assert_eq!(
            take.cancellations
                .iter()
                .map(|c| (c.order_id.clone(), c.reason))
                .collect::<Vec<_>>(),
            vec![(OWN.to_owned(), CancelReason::SelfTradePrevention)]
        );
        assert_eq!(
            take.surveillance_cases,
            vec![case("same", MARKET, "self_trade")]
        );
        let s = engine.existing_book(MARKET).unwrap().to_state();
        let top = &arr(&arr(&s, "asks")[0], "orders")[0];
        assert_eq!(text(top, "orderId"), TAKE);
        assert_eq!(text(top, "remaining"), "1");
        assert!(arr(&s, "bids").is_empty());
        assert_eq!(kinds(engine.journal().read()), strs(&["submit", "submit"]));
    }
}

// ═══ surveillance-case.test.ts ══════════════════════════════════════════

mod surveillance_case {
    use super::*;

    fn code(r: Result<SurveillanceCase, svc_matching::book::types::Reject>) -> String {
        r.unwrap_err().code
    }

    #[test]
    fn opens_when_account_id_market_id_and_a_known_reason_are_present() {
        let opened =
            open_surveillance_case(Some("desk"), Some(MARKET), Some("self_trade")).unwrap();
        assert_eq!(opened, case("desk", MARKET, "self_trade"));
        assert_eq!(
            opened.to_json(),
            Json::obj([
                ("accountId", Json::str("desk")),
                ("marketId", Json::str(MARKET)),
                ("reason", Json::str("self_trade")),
                ("status", Json::str("open")),
            ])
        );
    }

    #[test]
    fn names_spoofing_and_layering_as_open_cases_it_does_not_adjudicate_them() {
        assert_eq!(
            open_surveillance_case(Some("desk"), Some(MARKET), Some("spoofing")),
            Ok(case("desk", MARKET, "spoofing"))
        );
        assert_eq!(
            open_surveillance_case(Some("desk"), Some(MARKET), Some("layering")),
            Ok(case("desk", MARKET, "layering"))
        );
    }

    #[test]
    fn blank_or_missing_account_id_refuses() {
        assert!(open_surveillance_case(Some(""), Some(MARKET), Some("self_trade")).is_err());
        assert_eq!(
            code(open_surveillance_case(
                Some("   "),
                Some(MARKET),
                Some("self_trade")
            )),
            "missing_account"
        );
        assert_eq!(
            code(open_surveillance_case(
                None,
                Some(MARKET),
                Some("self_trade")
            )),
            "missing_account"
        );
    }

    #[test]
    fn blank_or_missing_market_id_refuses() {
        assert_eq!(
            code(open_surveillance_case(
                Some("desk"),
                Some(""),
                Some("self_trade")
            )),
            "missing_market"
        );
        assert_eq!(
            code(open_surveillance_case(
                Some("desk"),
                None,
                Some("self_trade")
            )),
            "missing_market"
        );
    }

    #[test]
    fn blank_reason_refuses_it_does_not_invent_a_pattern() {
        assert_eq!(
            code(open_surveillance_case(Some("desk"), Some(MARKET), Some(""))),
            "missing_reason"
        );
        assert_eq!(
            code(open_surveillance_case(
                Some("desk"),
                Some(MARKET),
                Some("   ")
            )),
            "missing_reason"
        );
        assert_eq!(
            code(open_surveillance_case(Some("desk"), Some(MARKET), None)),
            "missing_reason"
        );
    }

    #[test]
    fn unknown_pattern_refuses_rather_than_auto_adjudicate() {
        let refused = open_surveillance_case(Some("desk"), Some(MARKET), Some("quote_stuffing"));
        // An `Err` holds no case.
        assert_eq!(code(refused), "unknown_pattern");
    }

    #[test]
    fn auto_close_fine_and_punish_refuse_a_case_is_not_a_money_movement() {
        // `fineSurveillanceCase` is answered by `POST /surveillance/fine`; auto-close and punish have no Rust call.
        let (mut engine, _) = build();
        let fine = surveillance_door(&mut engine, "POST", "/surveillance/fine");
        assert_eq!(fine.get("ok"), Some(&Json::Bool(false)));
        assert_eq!(text(&fine, "code"), "invented_sanction");
        let opened =
            open_surveillance_case(Some("desk"), Some(MARKET), Some("self_trade")).unwrap();
        let shown = opened.to_json();
        assert!(shown.get("fine").is_none());
        assert!(shown.get("amount").is_none());
        assert!(shown.get("closed").is_none());
    }
}
