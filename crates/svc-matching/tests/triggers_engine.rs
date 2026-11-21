//! The `triggers` slice's TypeScript tests, ported test for test onto the Rust book and engine:
//! `services/svc-matching/src/engine/stop-limit.test.ts`, `engine/trailing-stop.test.ts`, `engine/gtd.test.ts`,
//! `engine/gtd-amend-clock.test.ts`, and what `services/svc-matching/src/expiry-sweep.test.ts` proves of the engine's
//! own `sweepExpiry`, and the trigger tests of `engine/slice-s20.test.ts` (TRD-0329, TRD-0332, TRD-0333, TRD-0337,
//! TRD-0516, the legacy stop cascade, and the two reduce-only groups that guard a protective stop).
//! Each test is named after its TypeScript `it` (the slice-s20 ones prefixed with their row); an `it.each` is one Rust
//! test per case.
//!
//! Not ported, and why:
//!
//! - `stop-limit.test.ts`, "helpers refuse a missing stopPx and wait off-book until the print": `stopPxRefuse`,
//!   `wantsStopLimit` and `readStopPx` have no Rust counterpart. `stopPxRefuse` is a helper no book path calls (the
//!   book's own check answers `invalid_price` for a zero trigger, `missing_stop_price` only for none);
//!   `wantsStopLimit` is `OrderType::StopLimit`, an enum; `readStopPx` is the `stop_price` field. Its five
//!   `waitsOffBook` expectations are ported, against `OrderBook::stop_would_trigger`, the book's own rule for the
//!   same question (a stop waits off the book exactly while it would not trigger).
//! - `trailing-stop.test.ts`: `trailRefuse`, `wantsTrailing`, `readTrail` and `readMark` have no Rust function:
//!   a trail is present when `EngineOrder.trail` is not `Opt::Absent`, and the trail and mark are read with
//!   `Opt::get`. Their expectations in "helpers refuse a missing trail or mark…" and the last line of "a plain limit and
//!   a plain stop without trail stay unchanged" (`wantsTrailing({ type: 'stop' })`) are not made; the trail refusal
//!   is held through the book in "refuses a missing trail". `markRefuse`, `ratchetPeak` and `walkStop` are ported.
//! - `expiry-sweep.test.ts` tests `startExpirySweep`, the timer around the engine, which is the `serve` slice's. The
//!   first two tests are ported as the engine's own `sweep_expiry`, called where the timer would tick. "does not sweep
//!   a disabled engine" is the timer's own `isEnabled` check (the engine's cancel does not read the kill switch, in
//!   the TypeScript or here), and "reports a failed pass and keeps running the next one" runs a fake engine through
//!   the timer: both are the `serve` slice's. The file also installs `installIfmCrash` on the engine's cancel, which
//!   is the `liquidity` slice's (IFM).
//! - `slice-s20.test.ts`: TRD-0248 and TRD-0492 (maintenance, cancel-only, halts) are the `venue` slice's; TRD-0255 and
//!   TRD-0325 (reduce-only) are the `book` slice's. TRD-0516 "leaves the order and records a miss when the pass cannot
//!   read the book" is not ported: it marks the book unreadable with `noteBookUnreadable` and asserts the sweep's
//!   `misses`. The Rust engine has no unreadable-book state (every book it holds is a typed `OrderBook`) and its
//!   `ExpirySweep` has no `misses`; without that state every assertion of the test reads something else (the sweep
//!   would cancel the order), so none is made. In TRD-0333 "rejects stop_market on an option…", `stop_market` is no
//!   Rust `OrderType` (`from_wire` refuses it as not an order type), so the refusal is asked with `stop`, which is in
//!   the same `OPTION_TRIGGER_TYPES` set; every assertion is made.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::zod_datetime;
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::triggers::{mark_refuse, ratchet_peak, walk_stop};
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, Opt, OrderType, RestKind, Side, SubmitResult, Tif,
};
use svc_matching::book::wire::{from_wire, from_wire_amend, to_wire};
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::journal::record::whole;
use svc_matching::journal::replay::{
    MemorySnapshotSink, ReplayBooks, ReplayCancel, js_sort_cmp, replay_journal,
};
use svc_matching::journal::{EngineJournal, JournalCommand, JournalRecord, MemoryJournal};

const MARKET: &str = "BTC/USDT";

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

fn ms(iso: &str) -> i64 {
    zod_datetime(iso, false).unwrap().0
}

/// One side of `depth(50)` as the TypeScript's decimal-string tuples.
fn bids(book: &OrderBook) -> Vec<(String, String)> {
    book.depth(50)
        .0
        .into_iter()
        .map(|(p, q)| (f(p), f(q)))
        .collect()
}

fn asks(book: &OrderBook) -> Vec<(String, String)> {
    book.depth(50)
        .1
        .into_iter()
        .map(|(p, q)| (f(p), f(q)))
        .collect()
}

fn lvl(p: &str, q: &str) -> (String, String) {
    (p.to_owned(), q.to_owned())
}

fn arr(j: Option<&Json>) -> &[Json] {
    match j {
        Some(Json::Array(v)) => v,
        other => panic!("not an array: {other:?}"),
    }
}

/// `book.toState().stops`.
fn stops(book: &OrderBook) -> Vec<Json> {
    arr(book.to_state().get("stops")).to_vec()
}

/// `book.toState()[side][0].orders[0]`.
fn first_order(book: &OrderBook, side: &str) -> Json {
    let state = book.to_state();
    let level = arr(state.get(side))[0].clone();
    arr(level.get("orders"))[0].clone()
}

/// `toMatchObject`: every field named holds the text given.
fn assert_matches(j: &Json, expected: &[(&str, &str)]) {
    for (key, value) in expected {
        assert_eq!(
            j.get(key),
            Some(&Json::str(*value)),
            "{key} of {}",
            j.compact()
        );
    }
}

fn version(j: &Json) -> i64 {
    whole(j.get("version").unwrap()).unwrap()
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|x| x.code.as_str())
}

fn assert_resting(r: &SubmitResult, kind: RestKind, order_id: &str) {
    let resting = r.resting.as_ref().expect("resting");
    assert_eq!(resting.kind, kind);
    assert_eq!(resting.order_id, order_id);
}

// ── replay over plain books (`replay`) ──────────────────────────────────────────────────────────────────────────

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

    fn get(&self, market_id: &str) -> Option<&OrderBook> {
        self.0.get(market_id)
    }
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is text, got {other:?}"),
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
        let mark = a(&text(&record.0, "mark"));
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

/// `journal.append({ kind: 'submit', marketId, at, order: toWire(order) })`.
fn journal_submit(journal: &mut MemoryJournal, market_id: &str, at: &str, o: &EngineOrder) {
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str("submit")),
            ("marketId", Json::str(market_id)),
            ("at", Json::str(at)),
            ("order", to_wire(o, None)),
        ])))
        .unwrap();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// stop-limit.test.ts — off-book until the stop prints
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod stop_limit {
    use super::*;

    const SL: &str = "11111111-1111-4111-8111-111111111111";
    const MM: &str = "22222222-2222-4222-8222-222222222222";
    const TAKE: &str = "33333333-3333-4333-8333-333333333333";
    const MISS: &str = "44444444-4444-4444-8444-444444444444";
    const WARM: &str = "55555555-5555-4555-8555-555555555555";

    /// `order(spec)`: account `desk` and GTC unless named.
    fn order(
        id: &str,
        account: &str,
        ty: OrderType,
        side: Side,
        qty: &str,
        price: Option<&str>,
        stop_px: Option<&str>,
    ) -> EngineOrder {
        let mut o = EngineOrder::new(id, account, ty, side, a(qty), price.map(a), Tif::Gtc);
        o.stop_price = stop_px.map(a);
        o
    }

    fn sl(qty: &str) -> EngineOrder {
        order(
            SL,
            "desk",
            OrderType::StopLimit,
            Side::Buy,
            qty,
            Some("106"),
            Some("105"),
        )
    }

    /// MM sells 2 at 100, WARM takes them (a print at 100), TAKE offers 10 at 106.
    fn warmed() -> OrderBook {
        let mut book = OrderBook::new(MARKET);
        book.submit(
            &order(
                MM,
                "mm",
                OrderType::Limit,
                Side::Sell,
                "2",
                Some("100"),
                None,
            ),
            None,
        );
        book.submit(
            &order(WARM, "warm", OrderType::Market, Side::Buy, "2", None, None),
            None,
        );
        book.submit(
            &order(
                TAKE,
                "mm",
                OrderType::Limit,
                Side::Sell,
                "10",
                Some("106"),
                None,
            ),
            None,
        );
        book
    }

    fn trigger(book: &mut OrderBook) -> SubmitResult {
        book.submit(
            &order(MISS, "taker", OrderType::Market, Side::Buy, "1", None, None),
            None,
        )
    }

    #[test]
    fn does_not_live_on_the_public_book_before_any_print() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&sl("2"), None);

        assert!(result.accepted);
        assert_resting(&result, RestKind::Stop, SL);
        assert!(result.fills.is_empty());
        assert!(bids(&book).is_empty());
        assert!(asks(&book).is_empty());
        let s = stops(&book);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].get("stopPrice"), Some(&Json::str("105")));
    }

    #[test]
    fn stays_off_the_book_until_a_print_reaches_stop_px() {
        let mut book = warmed();

        let parked = book.submit(&sl("3"), None);
        assert_eq!(
            parked.resting.as_ref().map(|r| r.kind),
            Some(RestKind::Stop)
        );
        assert!(bids(&book).is_empty());

        let trigger = trigger(&mut book);
        assert_eq!(trigger.triggered.len(), 1);
        assert_eq!(trigger.triggered[0].order_id, SL);
        assert_eq!(f(trigger.triggered[0].fills[0].qty), "3");
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn a_print_that_reaches_stop_px_rests_leftover_as_a_limit_on_the_book() {
        let mut book = warmed();

        book.submit(&sl("20"), None);
        let trigger = trigger(&mut book);
        let outcome = &trigger.triggered[0];

        assert_eq!(f(outcome.fills[0].qty), "9");
        let resting = outcome.resting.as_ref().expect("resting");
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(resting.order_id, SL);
        assert_eq!(f(resting.remaining), "11");
        assert_eq!(bids(&book), vec![lvl("106", "11")]);
    }

    #[test]
    fn refuses_a_missing_stop_px_no_invented_trigger() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(
            &order(
                MISS,
                "desk",
                OrderType::StopLimit,
                Side::Buy,
                "2",
                Some("106"),
                None,
            ),
            None,
        );

        assert!(!result.accepted);
        assert_eq!(code(&result), Some("missing_stop_price"));
        assert!(result.resting.is_none());
        assert!(bids(&book).is_empty());
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn journal_replay_keeps_an_untriggered_stop_limit_off_the_public_book() {
        let mut journal = MemoryJournal::new();
        let mut live = OrderBook::new(MARKET);
        let sl = sl("2");
        journal_submit(&mut journal, MARKET, "2026-08-25T15:00:00.000Z", &sl);
        live.submit(&sl, None);
        let books = replay(journal.read());
        let restored = books.get(MARKET).unwrap();
        assert_eq!(restored.serialize(), live.serialize());
        assert!(bids(restored).is_empty());
        assert_eq!(stops(restored)[0].get("stopPrice"), Some(&Json::str("105")));
    }

    /// A book whose last print is `last` (none when `None`).
    fn printed_at(last: Option<&str>) -> OrderBook {
        let mut book = OrderBook::new(MARKET);
        if let Some(px) = last {
            book.submit(
                &order(MM, "mm", OrderType::Limit, Side::Sell, "1", Some(px), None),
                None,
            );
            book.submit(
                &order(
                    WARM,
                    "warm",
                    OrderType::Limit,
                    Side::Buy,
                    "1",
                    Some(px),
                    None,
                ),
                None,
            );
            assert_eq!(book.last_price().map(f).as_deref(), Some(px));
        } else {
            assert_eq!(book.last_price(), None);
        }
        book
    }

    /// `waitsOffBook(side, stopPx, lastTrade)`: a stop waits off the book exactly while it would not trigger.
    fn waits_off_book(side: Side, stop_px: &str, last: Option<&str>) -> bool {
        !printed_at(last).stop_would_trigger(side, a(stop_px))
    }

    #[test]
    fn helpers_refuse_a_missing_stop_px_and_wait_off_book_until_the_print() {
        // `stopPxRefuse`, `wantsStopLimit` and `readStopPx` have no Rust counterpart: see the top of this file.
        assert!(waits_off_book(Side::Buy, "105", None));
        assert!(waits_off_book(Side::Buy, "105", Some("100")));
        assert!(!waits_off_book(Side::Buy, "105", Some("105")));
        assert!(waits_off_book(Side::Sell, "95", Some("100")));
        assert!(!waits_off_book(Side::Sell, "95", Some("90")));
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// trailing-stop.test.ts — walks with the mark
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod trailing_stop {
    use super::*;

    const TS: &str = "11111111-1111-4111-8111-111111111111";
    const MM: &str = "22222222-2222-4222-8222-222222222222";
    const TAKE: &str = "33333333-3333-4333-8333-333333333333";
    const MISS: &str = "44444444-4444-4444-8444-444444444444";
    const PLAIN: &str = "55555555-5555-4555-8555-555555555555";

    /// What a spec names of `trail` and `mark`: absent, `null`, or a value.
    fn opt(v: Option<Option<&str>>) -> Opt<Amount> {
        match v {
            None => Opt::Absent,
            Some(None) => Opt::Null,
            Some(Some(s)) => Opt::Some(a(s)),
        }
    }

    /// `order({ type: 'stop', trail, mark })`: a trailing stop from `desk`.
    fn trailing(
        id: &str,
        side: Side,
        qty: &str,
        trail: Option<Option<&str>>,
        mark: Option<Option<&str>>,
    ) -> EngineOrder {
        let mut o = EngineOrder::new(id, "desk", OrderType::Stop, side, a(qty), None, Tif::Gtc);
        o.trail = opt(trail);
        o.mark = opt(mark);
        o
    }

    fn ts_sell() -> EngineOrder {
        trailing(TS, Side::Sell, "2", Some(Some("5")), Some(Some("100")))
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

    fn apply(book: &mut OrderBook, mark: &str) -> Option<String> {
        book.apply_mark(Some(a(mark))).refused.map(|r| r.code)
    }

    fn stop0(book: &OrderBook) -> Json {
        stops(book)[0].clone()
    }

    #[test]
    fn rests_a_sell_trail_off_the_public_book_at_mark_minus_trail() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&ts_sell(), None);

        assert!(result.accepted);
        assert_resting(&result, RestKind::Stop, TS);
        assert!(result.fills.is_empty());
        assert!(bids(&book).is_empty());
        assert!(asks(&book).is_empty());
        assert_eq!(stops(&book).len(), 1);
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("95")));
    }

    #[test]
    fn refuses_a_missing_trail_no_invented_distance() {
        let mut book = OrderBook::new(MARKET);
        for trail in [None, Some("0")] {
            let result = book.submit(
                &trailing(MISS, Side::Sell, "2", Some(trail), Some(Some("100"))),
                None,
            );
            assert!(!result.accepted);
            assert_eq!(code(&result), Some("missing_trail"));
            assert!(result.resting.is_none());
        }
        assert!(stops(&book).is_empty());
        assert!(asks(&book).is_empty());
    }

    #[test]
    fn refuses_a_missing_mark_no_invented_mark() {
        let mut book = OrderBook::new(MARKET);
        for mark in [None, Some("0")] {
            let result = book.submit(
                &trailing(MISS, Side::Sell, "2", Some(Some("5")), Some(mark)),
                None,
            );
            assert!(!result.accepted);
            assert_eq!(code(&result), Some("missing_mark"));
            assert!(result.resting.is_none());
        }
        let omitted = book.submit(
            &trailing(MISS, Side::Sell, "2", Some(Some("5")), None),
            None,
        );
        assert!(!omitted.accepted);
        assert_eq!(code(&omitted), Some("missing_mark"));
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn walks_a_sell_stop_with_a_better_mark_and_does_not_walk_back() {
        let mut book = OrderBook::new(MARKET);
        book.submit(&ts_sell(), None);
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("95")));

        assert_eq!(apply(&mut book, "110"), None);
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("105")));

        assert_eq!(apply(&mut book, "108"), None);
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("105")));
    }

    #[test]
    fn a_print_that_reaches_the_walked_stop_triggers_it() {
        let mut book = OrderBook::new(MARKET);
        book.submit(&ts_sell(), None);
        apply(&mut book, "110");
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("105")));

        book.submit(&limit(MM, "mm", Side::Buy, "2", "100"), None);
        let trigger = book.submit(
            &EngineOrder::new(
                TAKE,
                "taker",
                OrderType::Market,
                Side::Sell,
                a("1"),
                None,
                Tif::Gtc,
            ),
            None,
        );
        assert_eq!(trigger.triggered.len(), 1);
        assert_eq!(trigger.triggered[0].order_id, TS);
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn a_plain_limit_and_a_plain_stop_without_trail_stay_unchanged() {
        let mut book = OrderBook::new(MARKET);
        let limit = book.submit(&limit(PLAIN, "desk", Side::Buy, "2", "99"), None);
        assert!(limit.accepted);
        assert_resting(&limit, RestKind::Book, PLAIN);
        assert_eq!(bids(&book), vec![lvl("99", "2")]);

        let mut plain = EngineOrder::new(
            TS,
            "desk",
            OrderType::Stop,
            Side::Sell,
            a("2"),
            None,
            Tif::Gtc,
        );
        plain.stop_price = Some(a("90"));
        let stop = book.submit(&plain, None);
        assert!(stop.accepted);
        assert_resting(&stop, RestKind::Stop, TS);
        assert_eq!(stop0(&book).get("stopPrice"), Some(&Json::str("90")));
        // `wantsTrailing({ type: 'stop' })` has no Rust function: see the top of this file.
    }

    fn tighten(book: &mut OrderBook, stop_price: &str) -> bool {
        book.amend(
            &EngineAmend {
                order_id: TS.to_owned(),
                expected_version: 1,
                stop_price: Some(a(stop_price)),
                ..EngineAmend::default()
            },
            None,
        )
        .accepted
    }

    /// `OrderBook.fromState(JSON.parse(book.serialize()))`.
    fn restore(book: &OrderBook) -> OrderBook {
        let state = service_kit::json::parse(&book.serialize()).unwrap();
        OrderBook::from_state(&state).unwrap()
    }

    #[test]
    fn a_journaled_trailing_stop_walks_after_restore_and_a_tighter_stop_price_is_not_loosened() {
        let mut book = OrderBook::new(MARKET);
        book.submit(&ts_sell(), None);
        assert_matches(
            &stop0(&book),
            &[("stopPrice", "95"), ("trail", "5"), ("peak", "100")],
        );
        assert!(matches!(stop0(&book).get("trail"), Some(Json::String(_))));
        assert!(matches!(stop0(&book).get("peak"), Some(Json::String(_))));

        assert!(tighten(&mut book, "98"));
        assert_matches(
            &stop0(&book),
            &[("stopPrice", "98"), ("trail", "5"), ("peak", "100")],
        );
        assert_eq!(version(&stop0(&book)), 2);

        assert_eq!(apply(&mut book, "100"), None);
        assert_matches(&stop0(&book), &[("stopPrice", "98"), ("peak", "100")]);
        assert_eq!(version(&stop0(&book)), 2);

        assert_eq!(apply(&mut book, "99"), None);
        assert_matches(&stop0(&book), &[("stopPrice", "98"), ("peak", "100")]);
        assert_eq!(version(&stop0(&book)), 2);

        assert_eq!(apply(&mut book, "102"), None);
        assert_matches(
            &stop0(&book),
            &[("stopPrice", "98"), ("peak", "102"), ("trail", "5")],
        );
        assert_eq!(version(&stop0(&book)), 2);

        assert_eq!(apply(&mut book, "110"), None);
        assert_matches(
            &stop0(&book),
            &[("stopPrice", "105"), ("peak", "110"), ("trail", "5")],
        );
        assert!(asks(&book).is_empty());
        assert!(bids(&book).is_empty());

        let mut restored = restore(&book);
        assert_matches(
            &stop0(&restored),
            &[("stopPrice", "105"), ("trail", "5"), ("peak", "110")],
        );
        assert_eq!(apply(&mut restored, "120"), None);
        assert_matches(
            &stop0(&restored),
            &[("stopPrice", "115"), ("peak", "120"), ("trail", "5")],
        );
        assert_eq!(apply(&mut restored, "118"), None);
        assert_matches(&stop0(&restored), &[("stopPrice", "115"), ("peak", "120")]);
        assert!(asks(&restored).is_empty());

        let mut buy = OrderBook::new("ETH/USDT");
        buy.submit(
            &trailing(TS, Side::Buy, "1", Some(Some("5")), Some(Some("100"))),
            None,
        );
        assert_matches(
            &stop0(&buy),
            &[("stopPrice", "105"), ("trail", "5"), ("peak", "100")],
        );
        assert!(tighten(&mut buy, "102"));
        assert_eq!(apply(&mut buy, "100"), None);
        assert_matches(
            &stop0(&buy),
            &[("stopPrice", "102"), ("peak", "100"), ("trail", "5")],
        );
        assert_eq!(apply(&mut buy, "101"), None);
        assert_matches(&stop0(&buy), &[("stopPrice", "102"), ("peak", "100")]);

        let mut buy_restored = restore(&buy);
        assert_eq!(apply(&mut buy_restored, "90"), None);
        assert_matches(
            &stop0(&buy_restored),
            &[("stopPrice", "95"), ("peak", "90"), ("trail", "5")],
        );
        assert_eq!(apply(&mut buy_restored, "92"), None);
        assert_matches(
            &stop0(&buy_restored),
            &[("stopPrice", "95"), ("peak", "90")],
        );
    }

    #[test]
    fn a_refused_trail_amend_keeps_the_previous_peak_and_stop_price() {
        let mut book = OrderBook::new(MARKET);
        book.submit(&limit(MM, "mm", Side::Sell, "1", "100"), None);
        book.submit(&limit(TAKE, "taker", Side::Buy, "1", "100"), None);
        assert_eq!(f(book.last_price().unwrap()), "100");

        let mut fok = ts_sell();
        fok.tif = Tif::Fok;
        let rested = book.submit(&fok, None);
        assert!(rested.accepted);
        assert_matches(
            &stop0(&book),
            &[
                ("stopPrice", "95"),
                ("trail", "5"),
                ("peak", "100"),
                ("tif", "FOK"),
            ],
        );
        assert_eq!(version(&stop0(&book)), 1);

        assert_eq!(apply(&mut book, "110"), None);
        assert_matches(&stop0(&book), &[("stopPrice", "95"), ("peak", "100")]);
        assert_eq!(version(&stop0(&book)), 1);
        assert_eq!(stops(&book).len(), 1);

        assert_eq!(apply(&mut book, "104"), None);
        assert_matches(
            &stop0(&book),
            &[("stopPrice", "99"), ("peak", "104"), ("trail", "5")],
        );
    }

    #[test]
    fn journal_replay_keeps_a_trailing_rest_off_the_public_book_at_the_same_stop() {
        let mut journal = MemoryJournal::new();
        let mut live = OrderBook::new(MARKET);
        let ts = ts_sell();
        journal_submit(&mut journal, MARKET, "2026-08-25T16:00:00.000Z", &ts);
        live.submit(&ts, None);
        let books = replay(journal.read());
        let restored = books.get(MARKET).unwrap();
        assert_eq!(restored.serialize(), live.serialize());
        assert!(asks(restored).is_empty());
        assert_eq!(stops(restored)[0].get("stopPrice"), Some(&Json::str("95")));
    }

    #[test]
    fn helpers_refuse_a_missing_trail_or_mark_and_walk_only_with_the_extreme() {
        // `trailRefuse`, `wantsTrailing`, `readTrail` and `readMark` have no Rust function: see the top of this file.
        assert_eq!(
            mark_refuse(None).map(|r| r.code).as_deref(),
            Some("missing_mark")
        );
        assert_eq!(
            mark_refuse(Some(a("0"))).map(|r| r.code).as_deref(),
            Some("missing_mark")
        );
        assert_eq!(mark_refuse(Some(a("100"))), None);
        assert_eq!(f(ratchet_peak(Side::Sell, Some(a("100")), a("110"))), "110");
        assert_eq!(f(ratchet_peak(Side::Sell, Some(a("110")), a("108"))), "110");
        assert_eq!(f(ratchet_peak(Side::Buy, Some(a("100")), a("90"))), "90");
        assert_eq!(f(ratchet_peak(Side::Buy, Some(a("90")), a("95"))), "90");
        assert_eq!(
            walk_stop(Side::Sell, a("100"), a("5")).map(f).as_deref(),
            Some("95")
        );
        assert_eq!(
            walk_stop(Side::Buy, a("100"), a("5")).map(f).as_deref(),
            Some("105")
        );
        assert_eq!(walk_stop(Side::Sell, a("5"), a("5")), None);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// gtd.test.ts — rest until the engine clock
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod gtd {
    use super::*;

    const GTD: &str = "44444444-4444-4444-8444-444444444444";
    const GTT: &str = "55555555-5555-4555-8555-555555555555";
    const LIQ: &str = "11111111-1111-4111-8111-111111111111";
    const TAKER: &str = "66666666-6666-4666-8666-666666666666";

    const EXPIRE: &str = "2026-08-25T12:00:00.000Z";
    const BEFORE: &str = "2026-08-25T11:00:00.000Z";
    const AFTER: &str = "2026-08-25T12:00:00.000Z";

    /// `order(spec)`: a limit when it has a price, a market order when not; account `desk`.
    fn order(
        id: &str,
        account: &str,
        side: Side,
        qty: &str,
        price: Option<&str>,
        tif: Tif,
        expire_at: Option<&str>,
    ) -> EngineOrder {
        let ty = if price.is_some() {
            OrderType::Limit
        } else {
            OrderType::Market
        };
        let mut o = EngineOrder::new(id, account, ty, side, a(qty), price.map(a), tif);
        o.expire_at = expire_at.map(str::to_owned);
        o
    }

    fn gtd_buy() -> EngineOrder {
        order(
            GTD,
            "desk",
            Side::Buy,
            "1",
            Some("100"),
            Tif::Gtd,
            Some(EXPIRE),
        )
    }

    fn later() -> EngineOrder {
        order(TAKER, "mm", Side::Buy, "1", Some("99"), Tif::Gtc, None)
    }

    fn live_ids(book: &OrderBook) -> Vec<String> {
        let state = book.to_state();
        let mut ids = Vec::new();
        for side in ["bids", "asks"] {
            for level in arr(state.get(side)) {
                for o in arr(level.get("orders")) {
                    ids.push(text(o, "orderId"));
                }
            }
        }
        for s in arr(state.get("stops")) {
            ids.push(text(s, "orderId"));
        }
        ids.sort_by(|x, y| js_sort_cmp(x, y));
        ids
    }

    #[test]
    fn rests_a_gtd_limit_when_expire_at_is_after_the_injected_clock() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&gtd_buy(), Some(ms(BEFORE)));

        assert!(result.accepted);
        let resting = result.resting.as_ref().unwrap();
        assert_eq!(resting.kind, RestKind::Book);
        assert_eq!(f(resting.remaining), "1");
        assert_eq!(
            first_order(&book, "bids").get("expireAt"),
            Some(&Json::str(EXPIRE))
        );
        assert_eq!(live_ids(&book), vec![GTD.to_owned()]);
    }

    #[test]
    fn rests_a_gtt_limit_the_same_way_expire_at_is_the_caller_instant_not_an_invented_eod() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(
            &order(
                GTT,
                "desk",
                Side::Sell,
                "2",
                Some("101"),
                Tif::Gtt,
                Some(EXPIRE),
            ),
            Some(ms(BEFORE)),
        );

        assert!(result.accepted);
        assert_eq!(
            result.resting.as_ref().map(|r| r.kind),
            Some(RestKind::Book)
        );
        assert_eq!(
            first_order(&book, "asks").get("expireAt"),
            Some(&Json::str(EXPIRE))
        );
    }

    #[test]
    fn refuses_gtd_when_the_engine_clock_is_missing() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&gtd_buy(), None);

        assert!(!result.accepted);
        assert_eq!(code(&result), Some("engine_clock_missing"));
        assert!(result.fills.is_empty());
        assert_eq!(book.current_sequence(), 0);
        assert!(live_ids(&book).is_empty());
    }

    #[test]
    fn refuses_gtt_when_expire_at_is_missing_the_engine_does_not_invent_one() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(
            &order(GTT, "desk", Side::Buy, "1", Some("100"), Tif::Gtt, None),
            Some(ms(BEFORE)),
        );

        assert!(!result.accepted);
        assert_eq!(code(&result), Some("missing_expire_at"));
        assert_eq!(book.current_sequence(), 0);
    }

    #[test]
    fn refuses_when_expire_at_is_not_after_the_engine_clock() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&gtd_buy(), Some(ms(AFTER)));

        assert!(!result.accepted);
        assert_eq!(code(&result), Some("already_expired"));
        assert_eq!(book.current_sequence(), 0);
    }

    #[test]
    fn refuses_a_market_gtd_it_cannot_rest() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(
            &order(GTD, "desk", Side::Buy, "1", None, Tif::Gtd, Some(EXPIRE)),
            Some(ms(BEFORE)),
        );

        assert!(!result.accepted);
        assert_eq!(code(&result), Some("invalid_tif"));
        assert_eq!(book.current_sequence(), 0);
    }

    #[test]
    fn a_later_clocked_submit_expires_the_resting_gtd_and_reports_expired_so_the_hold_can_release()
    {
        let mut book = OrderBook::new(MARKET);
        book.submit(&gtd_buy(), Some(ms(BEFORE)));
        let later = book.submit(&later(), Some(ms(AFTER)));

        assert!(later.accepted);
        let cancelled: Vec<(String, CancelReason)> = later
            .cancellations
            .iter()
            .map(|c| (c.order_id.clone(), c.reason))
            .collect();
        assert_eq!(cancelled, vec![(GTD.to_owned(), CancelReason::Expired)]);
        assert_eq!(later.cancellations[0].reason.as_str(), "expired");
        assert_eq!(live_ids(&book), vec![TAKER.to_owned()]);
    }

    #[test]
    fn gtc_never_grows_an_expire_at_no_invented_expiry_on_a_book_that_is_not_gtd_gtt() {
        let mut book = OrderBook::new(MARKET);
        book.submit(
            &order(LIQ, "desk", Side::Buy, "1", Some("100"), Tif::Gtc, None),
            None,
        );
        assert_eq!(first_order(&book, "bids").get("expireAt"), None);
    }

    #[test]
    fn journal_replay_uses_the_journalled_clock_and_expires_when_a_later_admission_is_due() {
        let mut journal = MemoryJournal::new();
        let mut live = OrderBook::new(MARKET);

        let gtd = gtd_buy();
        let later = later();

        journal_submit(&mut journal, MARKET, BEFORE, &gtd);
        live.submit(&gtd, Some(ms(BEFORE)));
        journal_submit(&mut journal, MARKET, AFTER, &later);
        live.submit(&later, Some(ms(AFTER)));

        let books = replay(journal.read());
        let restored = books.get(MARKET).unwrap();
        assert_eq!(restored.serialize(), live.serialize());
        assert_eq!(live_ids(restored), vec![TAKER.to_owned()]);
    }
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────────────────────────

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

/// `new MatchingEngine({ journal, bus, snapshotEvery: 0, clock })`: an injected clock, so GTD and GTT expire on it.
fn engine_with(journal: MemoryJournal, clock: fn() -> i64) -> (MatchingEngine, Bus) {
    let bus = Bus::default();
    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(bus.clone()),
        clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::<Json>::default()),
        enabled: true,
    });
    (engine, bus)
}

/// The same journal handed to a second engine: a memory journal holding exactly the records the first one holds.
fn same_journal(engine: &MatchingEngine) -> MemoryJournal {
    let records = engine.journal().read().to_vec();
    let mut journal = MemoryJournal::new();
    for r in &records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    assert_eq!(journal.read(), records.as_slice());
    journal
}

fn payload_pairs(events: &[Published], a: &str, b: &str) -> Vec<(String, String)> {
    events
        .iter()
        .map(|e| (text(&e.payload, a), text(&e.payload, b)))
        .collect()
}

thread_local! {
    /// `let now`: the clock a test moves. Each test runs on its own thread, so each has its own.
    static NOW: Cell<i64> = const { Cell::new(0) };
}

fn set_now(iso: &str) {
    NOW.with(|n| n.set(ms(iso)));
}

/// `() => now`.
fn now_clock() -> i64 {
    NOW.with(Cell::get)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// gtd-amend-clock.test.ts — amend applies the expiry clock
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod gtd_amend_clock {
    use super::*;

    const MAKER: &str = "44444444-4444-4444-8444-444444444444";
    const BID: &str = "66666666-6666-4666-8666-666666666666";

    const EXPIRE: &str = "2026-08-25T12:00:00.000Z";
    const BEFORE: &str = "2026-08-25T11:00:00.000Z";
    const AFTER: &str = "2026-08-25T12:00:00.000Z";

    fn before_clock() -> i64 {
        ms(BEFORE)
    }

    fn after_clock() -> i64 {
        ms(AFTER)
    }

    fn order(
        id: &str,
        account: &str,
        side: Side,
        qty: &str,
        price: &str,
        tif: Tif,
        expire_at: Option<&str>,
    ) -> EngineOrder {
        let mut o = EngineOrder::new(
            id,
            account,
            OrderType::Limit,
            side,
            a(qty),
            Some(a(price)),
            tif,
        );
        o.expire_at = expire_at.map(str::to_owned);
        o
    }

    fn maker(tif: Tif) -> EngineOrder {
        order(MAKER, "desk", Side::Sell, "2", "100", tif, Some(EXPIRE))
    }

    fn bid() -> EngineOrder {
        order(BID, "mm", Side::Buy, "1", "99", Tif::Gtc, None)
    }

    fn reprice() -> EngineAmend {
        EngineAmend {
            order_id: BID.to_owned(),
            expected_version: 1,
            price: Some(a("100")),
            ..EngineAmend::default()
        }
    }

    fn an_amend_after_expire_at_does_not_print_the_expired_order_and_does_not_leave_it_resting(
        tif: Tif,
    ) {
        set_now(BEFORE);
        let (mut live, live_bus) = engine_with(MemoryJournal::new(), now_clock);
        let rested = live.submit(MARKET, &maker(tif), None).unwrap();
        let bid = live.submit(MARKET, &bid(), None).unwrap();
        assert!(rested.accepted);
        assert!(bid.accepted);

        set_now(AFTER);
        let amended = live.amend(MARKET, &reprice(), None).unwrap();

        assert!(amended.accepted);
        assert!(amended.fills.is_empty());
        let cancelled: Vec<(String, &str)> = amended
            .cancellations
            .iter()
            .map(|c| (c.order_id.clone(), c.reason.as_str()))
            .collect();
        assert_eq!(cancelled, vec![(MAKER.to_owned(), "expired")]);
        let resting: Vec<String> = live
            .resting_orders(Some(MARKET))
            .into_iter()
            .map(|o| o.order_id)
            .collect();
        assert_eq!(resting, vec![BID.to_owned()]);
        assert!(live_bus.emitted("orderFilled").is_empty());
        // The event says why, so svc-trade ends the order expired whichever of the event and the inline outcome
        // comes first.
        assert_eq!(
            payload_pairs(&live_bus.emitted("orderCancelled"), "orderId", "reason"),
            vec![(MAKER.to_owned(), "expired".to_owned())]
        );

        let (mut recovered, recovered_bus) = engine_with(same_journal(&live), after_clock);
        recovered.recover().unwrap();
        assert_eq!(recovered.serialize(), live.serialize());
        assert!(recovered_bus.emitted("orderFilled").is_empty());
    }

    #[test]
    fn an_amend_after_expire_at_does_not_print_the_expired_gtd_and_does_not_leave_it_resting() {
        an_amend_after_expire_at_does_not_print_the_expired_order_and_does_not_leave_it_resting(
            Tif::Gtd,
        );
    }

    #[test]
    fn an_amend_after_expire_at_does_not_print_the_expired_gtt_and_does_not_leave_it_resting() {
        an_amend_after_expire_at_does_not_print_the_expired_order_and_does_not_leave_it_resting(
            Tif::Gtt,
        );
    }

    fn one_not_yet_expired_still_rests_and_trades_on_amend(tif: Tif) {
        let (mut live, _) = engine_with(MemoryJournal::new(), before_clock);
        live.submit(MARKET, &maker(tif), None).unwrap();
        live.submit(MARKET, &bid(), None).unwrap();

        let amended = live.amend(MARKET, &reprice(), None).unwrap();

        assert!(amended.accepted);
        let makers: Vec<String> = amended
            .fills
            .iter()
            .map(|x| x.maker_order_id.clone())
            .collect();
        assert_eq!(makers, vec![MAKER.to_owned()]);
        assert!(amended.cancellations.is_empty());
        let resting = live.resting_orders(Some(MARKET));
        assert_eq!(resting.len(), 1);
        assert_eq!(resting[0].order_id, MAKER);
        assert_eq!(f(resting[0].remaining), "1");

        let (mut recovered, recovered_bus) = engine_with(same_journal(&live), before_clock);
        recovered.recover().unwrap();
        assert_eq!(recovered.serialize(), live.serialize());
        let replayed: Vec<String> = recovered_bus
            .emitted("orderFilled")
            .iter()
            .map(|e| text(&e.payload, "makerOrderId"))
            .collect();
        assert_eq!(replayed, vec![MAKER.to_owned()]);
    }

    #[test]
    fn a_gtd_that_is_not_yet_expired_still_rests_and_trades_on_amend() {
        one_not_yet_expired_still_rests_and_trades_on_amend(Tif::Gtd);
    }

    #[test]
    fn a_gtt_that_is_not_yet_expired_still_rests_and_trades_on_amend() {
        one_not_yet_expired_still_rests_and_trades_on_amend(Tif::Gtt);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// expiry-sweep.test.ts — the engine's own `sweepExpiry` (the timer around it is the `serve` slice's)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod expiry_sweep {
    use super::*;

    const GTD: &str = "88888888-8888-4888-8888-888888888888";

    fn rest_gtd(engine: &mut MatchingEngine) {
        let mut o = EngineOrder::new(
            GTD,
            "desk",
            OrderType::Limit,
            Side::Buy,
            a("0.001"),
            Some(a("100")),
            Tif::Gtd,
        );
        o.expire_at = Some("2026-11-07T16:03:00.000Z".to_owned());
        let rested = engine.submit(MARKET, &o, None).unwrap();
        assert!(rested.accepted);
    }

    /// `engine.book(MARKET).toState().bids`: `book()` opens an empty book where none is left.
    fn bids_state(engine: &MatchingEngine) -> Vec<Json> {
        engine
            .existing_book(MARKET)
            .map(|b| arr(b.to_state().get("bids")).to_vec())
            .unwrap_or_default()
    }

    #[test]
    fn expires_a_due_gtd_rest_in_a_quiet_market_with_no_later_order_and_publishes_the_cancel_with_reason_expired()
     {
        set_now("2026-11-07T16:01:30.000Z");
        let (mut engine, bus) = engine_with(MemoryJournal::new(), now_clock);
        rest_gtd(&mut engine);

        // Not due yet: the sweep runs and the order stays.
        let quiet = engine.sweep_expiry().unwrap();
        assert!(quiet.accepted);
        assert_eq!(
            text(&arr(bids_state(&engine)[0].get("orders"))[0], "orderId"),
            GTD
        );
        assert!(bus.emitted("orderCancelled").is_empty());

        set_now("2026-11-07T16:03:00.000Z");
        engine.sweep_expiry().unwrap();
        assert!(bids_state(&engine).is_empty());
        assert_eq!(
            payload_pairs(&bus.emitted("orderCancelled"), "orderId", "reason"),
            vec![(GTD.to_owned(), "expired".to_owned())]
        );
        let reasons: Vec<Option<Json>> = engine
            .journal()
            .read()
            .iter()
            .filter(|r| r.kind() == Some("cancel"))
            .map(|r| r.field("reason").cloned())
            .collect();
        assert_eq!(reasons, vec![Some(Json::str("expired"))]);
    }

    #[test]
    fn expires_once_later_ticks_find_nothing_more_to_cancel() {
        set_now("2026-11-07T16:01:30.000Z");
        let (mut engine, bus) = engine_with(MemoryJournal::new(), now_clock);
        rest_gtd(&mut engine);
        set_now("2026-11-07T16:04:00.000Z");
        engine.sweep_expiry().unwrap();
        engine.sweep_expiry().unwrap();
        engine.sweep_expiry().unwrap();
        assert_eq!(bus.emitted("orderCancelled").len(), 1);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// slice-s20.test.ts — the trigger rows: TRD-0329, TRD-0332, TRD-0333, TRD-0337
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

mod slice_s20 {
    use super::*;
    use svc_matching::book::types::{TriggerBy, TriggerRole};

    const TAKER: &str = "22222222-2222-4222-8222-222222222222";
    const OTHER: &str = "33333333-3333-4333-8333-333333333333";
    const RO: &str = "44444444-4444-4444-8444-444444444444";
    const RO2: &str = "55555555-5555-4555-8555-555555555555";
    const TP: &str = "66666666-6666-4666-8666-666666666666";
    const SL: &str = "77777777-7777-4777-8777-777777777777";

    /// `limit(spec)`: GTC.
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

    /// `{ type: 'stop', price: null, stopPrice, tif: 'GTC' }`, qty 1.
    fn stop(id: &str, account: &str, side: Side, stop_price: Option<&str>) -> EngineOrder {
        let mut o = EngineOrder::new(id, account, OrderType::Stop, side, a("1"), None, Tif::Gtc);
        o.stop_price = stop_price.map(a);
        o
    }

    fn with_role(mut o: EngineOrder, role: TriggerRole) -> EngineOrder {
        o.trigger_role = Some(role);
        o
    }

    fn with_trigger_by(mut o: EngineOrder, by: TriggerBy) -> EngineOrder {
        o.trigger_by = Some(by);
        o
    }

    fn stop_ids(book: &OrderBook) -> Vec<String> {
        stops(book).iter().map(|s| text(s, "orderId")).collect()
    }

    /// OTHER sells 1 at 100 to `warm`: the last print is 100.
    fn printed_at_100(book: &mut OrderBook) {
        book.submit(&limit(OTHER, "mm", Side::Sell, "1", "100"), None);
        book.submit(&limit(TAKER, "warm", Side::Buy, "1", "100"), None);
    }

    /// OTHER bids 1 at 90 and `warm` sells into it: a last print at 90.
    fn print_at_90(book: &mut OrderBook) -> SubmitResult {
        book.submit(&limit(OTHER, "mm", Side::Buy, "1", "90"), None);
        book.submit(&limit(TAKER, "warm", Side::Sell, "1", "90"), None)
    }

    // TRD-0329 take-profit arms only on the profit side

    #[test]
    fn trd_0329_rejects_a_take_profit_sell_below_the_market_and_stores_a_valid_one_as_take_profit()
    {
        let mut book = OrderBook::new(MARKET);
        printed_at_100(&mut book);
        assert_eq!(f(book.last_price().unwrap()), "100");

        let wrong = book.submit(
            &with_role(
                stop(TP, "desk", Side::Sell, Some("90")),
                TriggerRole::TakeProfit,
            ),
            None,
        );
        assert!(!wrong.accepted);
        assert_eq!(code(&wrong), Some("trigger_wrong_side"));
        assert!(wrong.resting.is_none());
        assert!(stops(&book).is_empty());

        let valid = book.submit(
            &with_role(
                stop(RO, "desk", Side::Sell, Some("110")),
                TriggerRole::TakeProfit,
            ),
            None,
        );
        assert!(valid.accepted);
        assert_eq!(valid.resting.as_ref().map(|r| r.kind), Some(RestKind::Stop));
        assert_matches(
            &stops(&book)[0],
            &[("orderId", RO), ("triggerRole", "take_profit")],
        );
    }

    // TRD-0332 a rising print fires a take-profit sell and not a stop-loss sell

    #[test]
    fn trd_0332_activates_the_take_profit_at_110_and_leaves_the_stop_loss_armed() {
        let mut book = OrderBook::new(MARKET);
        printed_at_100(&mut book);

        book.submit(
            &with_role(
                stop(TP, "desk", Side::Sell, Some("110")),
                TriggerRole::TakeProfit,
            ),
            None,
        );
        book.submit(
            &with_role(
                stop(SL, "desk-sl", Side::Sell, Some("110")),
                TriggerRole::StopLoss,
            ),
            None,
        );

        book.submit(&limit(RO, "mm", Side::Sell, "1", "110"), None);
        let print = book.submit(&limit(RO2, "lift", Side::Buy, "1", "110"), None);

        assert_eq!(f(print.fills[0].price), "110");
        let fired: Vec<&str> = print
            .triggered
            .iter()
            .map(|t| t.order_id.as_str())
            .collect();
        assert_eq!(fired, vec![TP]);
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
        assert_eq!(
            stops(&book)[0].get("triggerRole"),
            Some(&Json::str("stop_loss"))
        );
    }

    #[test]
    fn trd_0332_does_not_trigger_a_stop_when_the_book_has_no_last_trade() {
        let mut book = OrderBook::new(MARKET);
        let parked = book.submit(&stop(SL, "desk", Side::Sell, Some("90")), None);
        assert!(parked.accepted);
        assert!(parked.triggered.is_empty());
        assert!(parked.fills.is_empty());
        assert_eq!(book.last_price(), None);
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
    }

    // TRD-0333 option trigger types and a trigger without a price

    #[test]
    fn trd_0333_rejects_stop_market_on_an_option_and_does_not_change_a_position() {
        // `stop_market` is no Rust `OrderType`: the type cannot hold it (see the top of this file). `stop` is in the same
        // set of option trigger types (`OPTION_TRIGGER_TYPES` in `book.ts`), so the same refusal is asked with it.
        let mut book = OrderBook::new(MARKET);
        let mut o = stop(SL, "desk", Side::Sell, Some("90"));
        o.option_instrument = true;
        let result = book.submit(&o, None);
        assert!(!result.accepted);
        assert_eq!(code(&result), Some("option_trigger_unsupported"));
        assert!(result.fills.is_empty());
        assert_eq!(book.current_sequence(), 0);
        assert_eq!(book.to_state().get("positions"), None);
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn trd_0333_rejects_a_stop_that_does_not_name_a_trigger_price() {
        let mut book = OrderBook::new(MARKET);
        let result = book.submit(&stop(SL, "desk", Side::Sell, None), None);
        assert!(!result.accepted);
        assert_eq!(code(&result), Some("missing_stop_price"));
        assert_eq!(book.current_sequence(), 0);
    }

    // TRD-0337 a mark stop does not fire on a last print

    #[test]
    fn trd_0337_leaves_the_stop_untriggered_when_last_prints_through_and_the_mark_is_away() {
        let mut book = OrderBook::new(MARKET);
        book.submit(
            &with_trigger_by(stop(SL, "desk", Side::Sell, Some("90")), TriggerBy::Mark),
            None,
        );
        assert!(
            book.apply_trigger_reference(TriggerBy::Mark, Some(a("95")))
                .is_empty()
        );

        let print = print_at_90(&mut book);

        assert_eq!(f(book.last_price().unwrap()), "90");
        assert!(print.triggered.is_empty());
        assert!(!print.fills.iter().any(|x| x.maker_order_id == SL));
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
    }

    #[test]
    fn trd_0337_does_not_retarget_an_index_stop_onto_last_when_the_index_feed_is_down() {
        let mut book = OrderBook::new(MARKET);
        book.submit(
            &with_trigger_by(stop(SL, "desk", Side::Sell, Some("90")), TriggerBy::Index),
            None,
        );
        assert!(
            book.apply_trigger_reference(TriggerBy::Index, None)
                .is_empty()
        );
        let print = print_at_90(&mut book);
        assert!(print.triggered.is_empty());
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
    }

    #[test]
    fn trd_0337_does_not_fall_back_to_last_when_the_mark_is_missing() {
        let mut book = OrderBook::new(MARKET);
        book.submit(
            &with_trigger_by(stop(SL, "desk", Side::Sell, Some("90")), TriggerBy::Mark),
            None,
        );
        assert!(
            book.apply_trigger_reference(TriggerBy::Mark, None)
                .is_empty()
        );
        let print = print_at_90(&mut book);
        assert!(print.triggered.is_empty());
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
    }

    // TRD-0516 a scheduled expiry pass cancels a quiet GTD

    const GTD: &str = "88888888-8888-4888-8888-888888888888";
    const SLIM: &str = "99999999-9999-4999-8999-999999999999";

    fn gtd_sell() -> EngineOrder {
        let mut o = limit(GTD, "desk", Side::Sell, "1", "100");
        o.tif = Tif::Gtd;
        o.expire_at = Some("2026-08-25T12:00:00.000Z".to_owned());
        o
    }

    /// `build()` with no clock: records carry the wall clock and GTD/GTT have no expiry clock.
    fn engine_without_clock() -> MatchingEngine {
        fn wall() -> i64 {
            let since = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap();
            i64::try_from(since.as_millis()).unwrap()
        }
        MatchingEngine::new(EngineParts {
            journal: Box::new(MemoryJournal::new()),
            bus: Box::new(Bus::default()),
            clock: wall,
            expiry_clock: false,
            snapshot_every: 0,
            sink: Box::new(MemorySnapshotSink::<Json>::default()),
            enabled: true,
        })
    }

    #[test]
    fn trd_0516_cancels_a_gtd_that_is_already_past_expire_at_when_no_other_order_arrives() {
        set_now("2026-08-25T11:00:00.000Z");
        let (mut engine, _) = engine_with(MemoryJournal::new(), now_clock);
        let rested = engine.submit(MARKET, &gtd_sell(), None).unwrap();
        assert!(rested.accepted);

        set_now("2026-08-25T12:01:00.000Z");
        let swept = engine.sweep_expiry().unwrap();
        assert!(swept.accepted);
        let cancelled: Vec<(String, &str)> = swept
            .cancelled
            .iter()
            .map(|c| (c.order_id.clone(), c.reason.as_str()))
            .collect();
        assert_eq!(cancelled, vec![(GTD.to_owned(), "expired")]);
        // `engine.book(MARKET)` opens an empty book where none is left.
        let asks = engine
            .existing_book(MARKET)
            .map(|b| arr(b.to_state().get("asks")).to_vec())
            .unwrap_or_default();
        assert!(asks.is_empty());

        let later = engine
            .submit(MARKET, &limit(TAKER, "mm", Side::Buy, "1", "100"), None)
            .unwrap();
        assert!(later.accepted);
        assert!(later.fills.is_empty());
        assert_eq!(
            later.resting.as_ref().map(|r| r.order_id.as_str()),
            Some(TAKER)
        );
    }

    #[test]
    fn trd_0516_refuses_a_gtd_submit_when_the_expiry_clock_is_missing() {
        let mut engine = engine_without_clock();
        let before = engine.journal().len();
        let result = engine.submit(MARKET, &gtd_sell(), None).unwrap();
        assert!(!result.accepted);
        assert_eq!(code(&result), Some("engine_clock_missing"));
        assert_eq!(engine.journal().len(), before);
    }

    // legacy stops fire the way main does

    /// `orderId(n)`: `aaaaaaaa-aaaa-4aaa-8aaa-` and `n` in hex, twelve wide.
    fn order_id(n: u32) -> String {
        format!("aaaaaaaa-aaaa-4aaa-8aaa-{n:012x}")
    }

    fn seed_at_100(book: &mut OrderBook) {
        book.submit(
            &limit(&order_id(1), "seed-ask", Side::Sell, "1", "100"),
            None,
        );
        book.submit(
            &limit(&order_id(2), "seed-bid", Side::Buy, "1", "100"),
            None,
        );
    }

    #[test]
    fn fires_every_legacy_stop_in_a_70_deep_cascade_and_prints_down_to_29() {
        let mut book = OrderBook::new(MARKET);
        seed_at_100(&mut book);
        assert_eq!(f(book.last_price().unwrap()), "100");

        for price in (29..=99u32).rev() {
            let rested = book.submit(
                &limit(
                    &order_id(1_000 + price),
                    &format!("bid-{price}"),
                    Side::Buy,
                    "1",
                    &price.to_string(),
                ),
                None,
            );
            assert!(rested.accepted);
        }

        let mut stop_ids_in: Vec<String> = Vec::new();
        for price in (30..=99u32).rev() {
            let id = order_id(2_000 + price);
            stop_ids_in.push(id.clone());
            let parked = book.submit(
                &stop(
                    &id,
                    &format!("stop-{price}"),
                    Side::Sell,
                    Some(&price.to_string()),
                ),
                None,
            );
            assert!(parked.accepted);
            assert_eq!(
                parked.resting.as_ref().map(|r| r.kind),
                Some(RestKind::Stop)
            );
        }

        let print = book.submit(&limit(&order_id(3), "taker", Side::Sell, "1", "99"), None);
        assert!(print.accepted);
        assert!(stops(&book).is_empty());
        let fired: Vec<String> = print.triggered.iter().map(|t| t.order_id.clone()).collect();
        assert_eq!(fired, stop_ids_in);
        assert_eq!(f(book.last_price().unwrap()), "29");
    }

    #[test]
    fn triggers_legacy_stops_in_insertion_order_across_a_cascade() {
        let mut book = OrderBook::new(MARKET);
        seed_at_100(&mut book);

        for price in [95u32, 89, 88, 87] {
            book.submit(
                &limit(
                    &order_id(price),
                    &format!("bid-{price}"),
                    Side::Buy,
                    "1",
                    &price.to_string(),
                ),
                None,
            );
        }

        let s1 = order_id(11);
        let s2 = order_id(12);
        let s3 = order_id(13);
        for (id, account, stop_price) in [
            (&s1, "stop-s1", "95"),
            (&s2, "stop-s2", "90"),
            (&s3, "stop-s3", "96"),
        ] {
            let parked = book.submit(&stop(id, account, Side::Sell, Some(stop_price)), None);
            assert!(parked.accepted);
        }

        let print = book.submit(&limit(&order_id(3), "taker", Side::Sell, "1", "95"), None);
        let fired: Vec<String> = print.triggered.iter().map(|t| t.order_id.clone()).collect();
        assert_eq!(fired, vec![s1, s2, s3]);
    }

    // a priceless reduce-only order does not cancel a protective stop

    fn displaced(cancellations: &[svc_matching::book::types::CancelledRef]) -> bool {
        cancellations
            .iter()
            .any(|c| c.reason == CancelReason::ReduceOnlyDisplaced)
    }

    fn reduce_only_stop() -> EngineOrder {
        let mut o = stop(SL, "desk", Side::Sell, Some("90"));
        o.reduce_only = true;
        o
    }

    #[test]
    fn refuses_a_reduce_only_market_sell_and_leaves_the_stop_armed_when_the_bid_side_is_empty() {
        let mut book = OrderBook::new(MARKET);
        book.submit(&limit(OTHER, "mm", Side::Sell, "1", "100"), None);
        book.submit(&limit(TAKER, "desk", Side::Buy, "1", "100"), None);
        let stop = book.submit(&reduce_only_stop(), None);
        assert!(stop.accepted);
        assert!(arr(book.to_state().get("bids")).is_empty());

        let mut close = EngineOrder::new(
            RO,
            "desk",
            OrderType::Market,
            Side::Sell,
            a("1"),
            None,
            Tif::Ioc,
        );
        close.reduce_only = true;
        let close = book.submit(&close, None);
        assert_eq!(code(&close), Some("would_increase_position"));
        assert!(!displaced(&close.cancellations));
        assert_eq!(stop_ids(&book), vec![SL.to_owned()]);
    }

    #[test]
    fn close_position_leaves_the_protective_stop_when_the_close_cannot_fill() {
        let mut engine = engine_without_clock();
        engine
            .submit(MARKET, &limit(OTHER, "mm", Side::Sell, "1", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(TAKER, "desk", Side::Buy, "1", "100"), None)
            .unwrap();
        let stop = engine.submit(MARKET, &reduce_only_stop(), None).unwrap();
        assert!(stop.accepted);

        let closed = engine.close_position(MARKET, RO, "desk", None).unwrap();
        assert_eq!(code(&closed), Some("would_increase_position"));
        assert!(!displaced(&closed.cancellations));
        assert_eq!(
            stop_ids(engine.existing_book(MARKET).unwrap()),
            vec![SL.to_owned()]
        );
    }

    // a reduce-only stop-limit never displaces a resting reduce-only limit

    fn ask_ids(book: &OrderBook) -> Vec<String> {
        arr(book.to_state().get("asks"))
            .iter()
            .flat_map(|level| {
                arr(level.get("orders"))
                    .iter()
                    .map(|o| text(o, "orderId"))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn reduce_only_take_profit(book: &mut OrderBook) -> SubmitResult {
        let mut o = limit(RO, "desk", Side::Sell, "1", "110");
        o.reduce_only = true;
        book.submit(&o, None)
    }

    fn reduce_only_stop_limit(price: &str, stop_price: &str) -> EngineOrder {
        let mut o = EngineOrder::new(
            SLIM,
            "desk",
            OrderType::StopLimit,
            Side::Sell,
            a("1"),
            Some(a(price)),
            Tif::Gtc,
        );
        o.stop_price = Some(a(stop_price));
        o.reduce_only = true;
        o
    }

    fn desk_long_at_100() -> OrderBook {
        let mut book = OrderBook::new(MARKET);
        book.submit(&limit(OTHER, "mm", Side::Sell, "1", "100"), None);
        book.submit(&limit(TAKER, "desk", Side::Buy, "1", "100"), None);
        assert_eq!(f(book.last_price().unwrap()), "100");
        book
    }

    #[test]
    fn an_untriggered_stop_limit_does_not_cancel_a_take_profit() {
        let mut book = desk_long_at_100();

        let take_profit = reduce_only_take_profit(&mut book);
        assert!(take_profit.accepted);
        assert_eq!(
            take_profit.resting.as_ref().map(|r| r.order_id.as_str()),
            Some(RO)
        );

        let stop_limit = book.submit(&reduce_only_stop_limit("89", "90"), None);
        assert_eq!(code(&stop_limit), Some("would_increase_position"));
        assert!(!displaced(&stop_limit.cancellations));
        assert_eq!(ask_ids(&book), vec![RO.to_owned()]);
        assert!(stops(&book).is_empty());
    }

    #[test]
    fn a_stop_limit_that_triggers_at_once_does_not_displace_either() {
        let mut book = desk_long_at_100();

        let take_profit = reduce_only_take_profit(&mut book);
        assert!(take_profit.accepted);

        let stop_limit = book.submit(&reduce_only_stop_limit("99", "100"), None);
        assert_eq!(code(&stop_limit), Some("would_increase_position"));
        assert!(!displaced(&stop_limit.cancellations));
        assert_eq!(ask_ids(&book), vec![RO.to_owned()]);
    }
}
