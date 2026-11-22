//! The engine's calls, proven with the TypeScript's own tests ported test for test: `engine/mass-cancel.test.ts`,
//! `engine/close-position.test.ts`, `engine/l3-queue.test.ts`, `engine/post-only-market.test.ts`,
//! `engine/reduce-only-market.test.ts`, `engine/core-tif.test.ts` and `reconcile.test.ts` (all under
//! `services/svc-matching/src/`). Each test is named after the TypeScript `it` it ports, prefixed with its file's topic.
//!
//! A market mode (post-only, reduce-only, halt) is switched by a venue door that is not ported here, so a test puts a
//! market in a mode the way the Rust engine reads it: the record the TypeScript door journals is appended to a copy of
//! the engine's journal and the engine recovers from it. The doors' own answers (approvals, operators) are the venue
//! slice's and are not ported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::HashMap;

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Request;
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::rules::{
    LiveOwned, mass_cancel_session_refuse, owned_order_ids, read_session_id,
};
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, OrderType, RestKind, Side, Tif,
};
use svc_matching::book::wire::{from_wire, to_wire};
use svc_matching::door::book::serve;
use svc_matching::door::{Outcome, ROUTES};
use svc_matching::engine::reconcile::{CounterpartOrder, reconcile};
use svc_matching::engine::{EngineParts, L3Queue, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const OTHER: &str = "ETH/USDT";
/// 2026-08-25T16:00:00.000Z, the clock the TypeScript gives its engines when it gives one.
const AT: &str = "2026-08-25T16:00:00.000Z";
const EXPIRE: &str = "2026-08-25T12:00:00.000Z";

fn at_ms() -> i64 {
    1_787_673_600_000
}

/// 2026-08-25T11:00:00.000Z (`BEFORE` in core-tif).
fn before_ms() -> i64 {
    1_787_655_600_000
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn f(x: Amount) -> String {
    format_amount(x)
}

// ── engines ─────────────────────────────────────────────────────────────

/// `new MatchingEngine({ journal, bus, snapshotEvery: 0, clock?, enabled? })`. Without a clock the TypeScript stamps
/// records with the wall clock and has no expiry clock; here the stamp is fixed and GTD/GTT refuse, as there.
fn engine_on(journal: MemoryJournal, clock: Option<fn() -> i64>, enabled: bool) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(MemoryEventBus::default()),
        clock: clock.unwrap_or(at_ms),
        expiry_clock: clock.is_some(),
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled,
        spread_fills: false,
    })
}

fn build() -> MatchingEngine {
    engine_on(MemoryJournal::new(), None, true)
}

fn build_clock(clock: fn() -> i64) -> MatchingEngine {
    engine_on(MemoryJournal::new(), Some(clock), true)
}

/// The engine's journal, copied record for record.
fn copy_journal(engine: &MatchingEngine) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

/// A fresh engine on the same journal, recovered (`new MatchingEngine({ journal, ... }).recover()`).
fn reboot(engine: &MatchingEngine) -> MatchingEngine {
    let mut next = engine_on(copy_journal(engine), None, true);
    next.recover().unwrap();
    next
}

/// The venue door's mode switch: its journal record, read back by a recovering engine.
fn switch(engine: &MatchingEngine, kind: &str, market: &str) -> MatchingEngine {
    let mut journal = copy_journal(engine);
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str(kind)),
            ("marketId", Json::str(market)),
            ("at", Json::str(AT)),
            ("operatorId", Json::str("ops-1")),
            ("confirmOperatorId", Json::str("ops-2")),
        ])))
        .unwrap();
    let mut next = engine_on(journal, None, true);
    next.recover().unwrap();
    next
}

fn jlen(engine: &MatchingEngine) -> usize {
    engine.journal().len()
}

fn kinds(engine: &MatchingEngine) -> Vec<String> {
    engine
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

fn book(engine: &MatchingEngine) -> &OrderBook {
    engine.existing_book(MARKET).unwrap()
}

fn state(engine: &MatchingEngine) -> Json {
    book(engine).to_state()
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

fn limit_tif(id: &str, account: &str, side: Side, qty: &str, price: &str, tif: Tif) -> EngineOrder {
    let mut o = limit(id, account, side, qty, price);
    o.tif = tif;
    o
}

fn reduce_only(mut o: EngineOrder) -> EngineOrder {
    o.reduce_only = true;
    o
}

fn stop(id: &str, account: &str, side: Side, qty: &str, stop_price: &str) -> EngineOrder {
    let mut o = EngineOrder::new(id, account, OrderType::Stop, side, a(qty), None, Tif::Gtc);
    o.stop_price = Some(a(stop_price));
    o
}

fn amend(order_id: &str, expected_version: u64) -> EngineAmend {
    EngineAmend {
        order_id: order_id.to_owned(),
        expected_version,
        ..EngineAmend::default()
    }
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

fn has(j: &Json, k: &str) -> bool {
    j.get(k).is_some()
}

/// `liveIds(book)`: every rest's and stop's id, sorted.
fn live_ids(book: &OrderBook) -> Vec<String> {
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

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn strs(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

/// The desk's row in `toState().positions`, if any.
fn position_of(s: &Json, account: &str) -> Option<String> {
    match s.get("positions") {
        Some(Json::Array(rows)) => rows
            .iter()
            .find(|r| text(r, "accountId") == account)
            .map(|r| text(r, "qty")),
        _ => None,
    }
}

// ═══ mass-cancel.test.ts ════════════════════════════════════════════════

mod mass_cancel {
    use super::*;

    const ASK: &str = "11111111-1111-4111-8111-111111111111";
    const ASK2: &str = "22222222-2222-4222-8222-222222222222";
    const BID: &str = "33333333-3333-4333-8333-333333333333";
    const STOP: &str = "44444444-4444-4444-8444-444444444444";
    const KEEP: &str = "55555555-5555-4555-8555-555555555555";

    fn submit(book: &mut OrderBook, o: &EngineOrder) {
        book.submit(o, None);
    }

    #[test]
    fn pulls_every_rest_for_that_account_and_leaves_other_owners() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(ASK, "desk", Side::Sell, "1", "101"));
        submit(&mut b, &limit(ASK2, "desk", Side::Sell, "2", "102"));
        submit(&mut b, &limit(KEEP, "mm", Side::Sell, "3", "103"));
        submit(&mut b, &limit(BID, "desk", Side::Buy, "1", "99"));

        let pulled = b.cancel_account("desk", None);

        assert_eq!(
            sorted(pulled.iter().map(|c| c.order_id.clone()).collect()),
            sorted(strs(&[ASK, ASK2, BID]))
        );
        assert!(pulled.iter().all(|c| c.reason == CancelReason::Requested));
        assert!(pulled.iter().all(|c| c.account_id == "desk"));
        assert_eq!(live_ids(&b), strs(&[KEEP]));
        let s = b.to_state();
        assert_eq!(
            text(&arr(&arr(&s, "asks")[0], "orders")[0], "remaining"),
            "3"
        );
    }

    #[test]
    fn pulls_a_stop_for_that_account_and_leaves_a_stranger_stop() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &stop(STOP, "desk", Side::Buy, "1", "110"));
        submit(&mut b, &stop(KEEP, "mm", Side::Sell, "1", "90"));

        let pulled = b.cancel_account("desk", None);

        assert_eq!(
            pulled
                .iter()
                .map(|c| c.order_id.clone())
                .collect::<Vec<_>>(),
            strs(&[STOP])
        );
        assert_eq!(live_ids(&b), strs(&[KEEP]));
    }

    #[test]
    fn unknown_account_is_a_no_op_no_invented_owner_book_unchanged() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(KEEP, "mm", Side::Sell, "1", "100"));
        let before = b.serialize();
        let pulled = b.cancel_account("nobody", None);
        assert!(pulled.is_empty());
        assert_eq!(b.serialize(), before);
        assert_eq!(live_ids(&b), strs(&[KEEP]));
    }

    #[test]
    fn empty_account_matches_nothing_missing_owner_cannot_apply() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(KEEP, "mm", Side::Sell, "1", "100"));
        assert!(b.cancel_account("", None).is_empty());
        assert_eq!(live_ids(&b), strs(&[KEEP]));
    }

    #[test]
    fn different_owners_still_match_after_a_mass_cancel() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(ASK, "desk", Side::Sell, "1", "100"));
        submit(&mut b, &limit(KEEP, "mm", Side::Sell, "2", "100"));
        b.cancel_account("desk", None);

        let take = b.submit(&limit(BID, "taker", Side::Buy, "2", "100"), None);
        assert!(take.accepted);
        assert_eq!(take.fills.len(), 1);
        assert_eq!(f(take.fills[0].qty), "2");
        assert_eq!(take.fills[0].maker_account_id, "mm");
        assert_eq!(take.fills[0].taker_account_id, "taker");
        assert!(!live_ids(&b).contains(&KEEP.to_owned()));
    }

    #[test]
    fn journal_replay_of_a_mass_cancel_does_not_invent_a_rest() {
        let mut journal = MemoryJournal::new();
        let mut live = OrderBook::new(MARKET);
        let own = limit(ASK, "desk", Side::Sell, "1", "100");
        let other = limit(KEEP, "mm", Side::Sell, "1", "101");
        for o in [&own, &other] {
            journal
                .append(&JournalCommand(Json::obj([
                    ("kind", Json::str("submit")),
                    ("marketId", Json::str(MARKET)),
                    ("at", Json::str("2026-08-25T16:00:00.000Z")),
                    ("order", to_wire(o, None)),
                ])))
                .unwrap();
            live.submit(o, None);
        }
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("mass_cancel")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-08-25T16:00:01.000Z")),
                ("accountId", Json::str("desk")),
            ])))
            .unwrap();
        live.cancel_account("desk", None);

        let mut restored = engine_on(journal, None, true);
        restored.recover().unwrap();
        let restored = restored.existing_book(MARKET).unwrap();
        assert_eq!(restored.serialize(), live.serialize());
        assert_eq!(live_ids(restored), strs(&[KEEP]));
    }

    #[test]
    fn engine_mass_cancel_journals_once_emits_each_cancel_skips_unknown_markets() {
        let mut engine = build_clock(at_ms);
        engine
            .submit(MARKET, &limit(ASK, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(KEEP, "mm", Side::Sell, "1", "101"), None)
            .unwrap();

        let ghost = engine
            .mass_cancel("NEVER-TRADED", "desk", None, None)
            .unwrap();
        assert!(ghost.accepted);
        assert!(ghost.cancellations.is_empty());
        assert!(!engine.has_market("NEVER-TRADED"));
        assert_eq!(
            kinds(&engine)
                .iter()
                .filter(|k| *k == "mass_cancel")
                .count(),
            0
        );

        let result = engine.mass_cancel(MARKET, "desk", None, None).unwrap();
        assert!(result.accepted);
        assert_eq!(result.cancellations.len(), 1);
        assert_eq!(result.cancellations[0].order_id, ASK);
        assert_eq!(
            kinds(&engine)
                .iter()
                .filter(|k| *k == "mass_cancel")
                .count(),
            1
        );
        assert_eq!(live_ids(book(&engine)), strs(&[KEEP]));
    }

    #[test]
    fn a_session_id_refuses_the_engine_does_not_invent_a_session() {
        let mut engine = build();
        engine
            .submit(MARKET, &limit(ASK, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        let before = engine.serialize();

        let result = engine
            .mass_cancel(MARKET, "desk", Some("sess-1"), None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(
            result.rejected.as_ref().unwrap().code,
            "session_unsupported"
        );
        assert!(result.cancellations.is_empty());
        assert_eq!(engine.serialize(), before);
        assert_eq!(kinds(&engine), strs(&["submit"]));
    }

    #[test]
    fn owned_order_ids_is_oldest_sequence_first_missing_and_false_session_is_unset() {
        let row = |order_id, account_id, sequence, side| LiveOwned {
            order_id,
            account_id,
            sequence,
            side,
        };
        assert!(owned_order_ids("desk", &[], None).is_empty());
        assert!(owned_order_ids("", &[row(ASK, "desk", 1, Side::Sell)], None).is_empty());
        assert_eq!(
            owned_order_ids(
                "desk",
                &[
                    row(ASK2, "desk", 4, Side::Sell),
                    row(KEEP, "mm", 2, Side::Sell),
                    row(ASK, "desk", 1, Side::Sell),
                ],
                None
            ),
            strs(&[ASK, ASK2])
        );
        assert_eq!(
            owned_order_ids(
                "desk",
                &[
                    row(ASK, "desk", 1, Side::Sell),
                    row(BID, "desk", 2, Side::Buy)
                ],
                Some(Side::Buy)
            ),
            strs(&[BID])
        );
        // `null` and a missing side are one input here: `None`.
        assert_eq!(
            owned_order_ids(
                "desk",
                &[
                    row(ASK, "desk", 1, Side::Sell),
                    row(BID, "desk", 2, Side::Buy)
                ],
                None
            ),
            strs(&[ASK, BID])
        );
        // `{}` and `{ sessionId: null }` are one input here: `None`.
        assert_eq!(read_session_id(None), None);
        assert_eq!(read_session_id(Some("")), None);
        assert_eq!(read_session_id(Some("  ")), None);
        assert_eq!(read_session_id(Some("sess-1")), Some("sess-1".to_owned()));
        assert!(mass_cancel_session_refuse(None).is_none());
        assert_eq!(
            mass_cancel_session_refuse(Some("sess-1")).unwrap().code,
            "session_unsupported"
        );
    }

    #[test]
    fn buy_only_pulls_buys_rest_and_stop_and_leaves_sells() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(ASK, "desk", Side::Sell, "1", "101"));
        submit(&mut b, &limit(BID, "desk", Side::Buy, "1", "99"));
        submit(&mut b, &stop(STOP, "desk", Side::Buy, "1", "110"));
        submit(&mut b, &stop(KEEP, "desk", Side::Sell, "1", "90"));

        let pulled = b.cancel_account("desk", Some(Side::Buy));

        assert_eq!(
            sorted(pulled.iter().map(|c| c.order_id.clone()).collect()),
            sorted(strs(&[BID, STOP]))
        );
        assert_eq!(live_ids(&b), sorted(strs(&[ASK, KEEP])));
    }

    #[test]
    fn sell_only_pulls_sells_and_leaves_buys() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(ASK, "desk", Side::Sell, "1", "101"));
        submit(&mut b, &limit(BID, "desk", Side::Buy, "1", "99"));

        let pulled = b.cancel_account("desk", Some(Side::Sell));

        assert_eq!(
            pulled
                .iter()
                .map(|c| c.order_id.clone())
                .collect::<Vec<_>>(),
            strs(&[ASK])
        );
        assert_eq!(live_ids(&b), strs(&[BID]));
    }

    #[test]
    fn missing_or_null_side_still_cancels_both() {
        // A missing side and `null` are one input here (`None`); both books of the TypeScript run it.
        for _ in 0..2 {
            let mut b = OrderBook::new(MARKET);
            submit(&mut b, &limit(ASK, "desk", Side::Sell, "1", "101"));
            submit(&mut b, &limit(BID, "desk", Side::Buy, "1", "99"));
            assert_eq!(
                sorted(
                    b.cancel_account("desk", None)
                        .iter()
                        .map(|c| c.order_id.clone())
                        .collect()
                ),
                sorted(strs(&[ASK, BID]))
            );
        }
    }

    #[test]
    fn empty_account_with_a_side_still_matches_nothing() {
        let mut b = OrderBook::new(MARKET);
        submit(&mut b, &limit(KEEP, "mm", Side::Buy, "1", "99"));
        assert!(b.cancel_account("", Some(Side::Buy)).is_empty());
        assert_eq!(live_ids(&b), strs(&[KEEP]));
    }

    #[test]
    fn a_session_id_with_a_side_still_refuses_no_invented_session() {
        let mut engine = build();
        engine
            .submit(MARKET, &limit(ASK, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(BID, "desk", Side::Buy, "1", "99"), None)
            .unwrap();
        let before = engine.serialize();

        let result = engine
            .mass_cancel(MARKET, "desk", Some("sess-1"), Some(Side::Buy))
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(
            result.rejected.as_ref().unwrap().code,
            "session_unsupported"
        );
        assert!(result.cancellations.is_empty());
        assert_eq!(engine.serialize(), before);
    }

    #[test]
    fn engine_buy_only_journals_the_side_so_replay_does_not_wipe_sells() {
        let mut engine = build_clock(at_ms);
        engine
            .submit(MARKET, &limit(ASK, "desk", Side::Sell, "1", "101"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(BID, "desk", Side::Buy, "1", "99"), None)
            .unwrap();

        let result = engine
            .mass_cancel(MARKET, "desk", None, Some(Side::Buy))
            .unwrap();
        assert!(result.accepted);
        assert_eq!(
            result
                .cancellations
                .iter()
                .map(|c| c.order_id.clone())
                .collect::<Vec<_>>(),
            strs(&[BID])
        );
        assert_eq!(live_ids(book(&engine)), strs(&[ASK]));

        let record = engine
            .journal()
            .read()
            .iter()
            .find(|r| r.kind() == Some("mass_cancel"))
            .unwrap()
            .clone();
        assert_eq!(text(&record.0, "kind"), "mass_cancel");
        assert_eq!(text(&record.0, "accountId"), "desk");
        assert_eq!(text(&record.0, "side"), "buy");

        let restored = reboot(&engine);
        assert_eq!(live_ids(book(&restored)), strs(&[ASK]));
    }
}

// ═══ close-position.test.ts ═════════════════════════════════════════════

mod close_position {
    use super::*;

    const OPEN: &str = "11111111-1111-4111-8111-111111111111";
    const LIQ: &str = "22222222-2222-4222-8222-222222222222";
    const EXIT: &str = "33333333-3333-4333-8333-333333333333";
    const CLOSE: &str = "55555555-5555-4555-8555-555555555555";
    const AGAIN: &str = "66666666-6666-4666-8666-666666666666";
    const SHORT_OPEN: &str = "77777777-7777-4777-8777-777777777777";

    fn long_with_exit(engine: &mut MatchingEngine) {
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Sell, "2", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(OPEN, "desk", Side::Buy, "2", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(EXIT, "liq", Side::Buy, "2", "100"), None)
            .unwrap();
    }

    #[test]
    fn long_2_vs_resting_ask_close_sells_2_at_the_book_price_desk_goes_flat() {
        let mut engine = build();
        long_with_exit(&mut engine);

        let result = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();

        assert!(result.accepted);
        assert_eq!(result.fills.len(), 1);
        assert_eq!(f(result.fills[0].qty), "2");
        assert_eq!(f(result.fills[0].price), "100");
        assert_eq!(result.fills[0].taker_side, Side::Sell);
        assert_eq!(book(&engine).net_position("desk"), 0);
        assert_eq!(position_of(&state(&engine), "desk"), None);
    }

    #[test]
    fn short_close_buys_the_abs_net_against_a_resting_ask() {
        let mut engine = build();
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Buy, "2", "100"), None)
            .unwrap();
        engine
            .submit(
                MARKET,
                &limit(SHORT_OPEN, "desk", Side::Sell, "2", "100"),
                None,
            )
            .unwrap();
        engine
            .submit(MARKET, &limit(EXIT, "liq", Side::Sell, "2", "100"), None)
            .unwrap();

        assert_eq!(book(&engine).net_position("desk"), a("-2"));

        let result = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();

        assert!(result.accepted);
        assert_eq!(result.fills.len(), 1);
        assert_eq!(f(result.fills[0].qty), "2");
        assert_eq!(f(result.fills[0].price), "100");
        assert_eq!(result.fills[0].taker_side, Side::Buy);
        assert_eq!(book(&engine).net_position("desk"), 0);
    }

    #[test]
    fn flat_account_on_a_never_traded_market_position_flat_no_book_sequence_0() {
        let mut engine = build();
        let result = engine
            .close_position("NEVER-TRADED", CLOSE, "desk", None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "position_flat");
        assert_eq!(result.sequence, None);
        assert!(!engine.has_market("NEVER-TRADED"));
        assert!(engine.markets().is_empty());
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn flat_account_on_a_live_book_position_flat_nothing_journalled() {
        let mut engine = build();
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Sell, "2", "100"), None)
            .unwrap();
        let before = jlen(&engine);

        let result = engine
            .close_position(MARKET, CLOSE, "stranger", None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "position_flat");
        assert_eq!(result.sequence, None);
        assert_eq!(jlen(&engine), before);
        assert!(book(&engine).current_sequence() > 0);
    }

    #[test]
    fn second_close_after_flatten_refuses_position_flat() {
        let mut engine = build();
        long_with_exit(&mut engine);
        let first = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();
        assert!(first.accepted);
        let after = jlen(&engine);

        let second = engine.close_position(MARKET, AGAIN, "desk", None).unwrap();

        assert!(!second.accepted);
        assert_eq!(second.rejected.as_ref().unwrap().code, "position_flat");
        assert_eq!(jlen(&engine), after);
    }

    #[test]
    fn disabled_engine_refuses_like_submit_nothing_journalled() {
        let mut engine = engine_on(MemoryJournal::new(), None, false);
        let result = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "engine_disabled");
        assert_eq!(jlen(&engine), 0);
        assert!(!engine.has_market(MARKET));
    }

    #[test]
    fn journal_replay_of_a_close_after_an_open_long_matches_live_serialize() {
        let mut engine = build();
        long_with_exit(&mut engine);
        let closed = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();
        assert!(closed.accepted);

        let live = engine.serialize();
        let recovered = reboot(&engine);
        assert_eq!(recovered.serialize(), live);
        assert_eq!(book(&recovered).net_position("desk"), 0);
    }

    /// `flattenCloseOrder` is not its own function in Rust: `close_position` builds the order inline and journals it
    /// before the book sees it, so the order it chose is read back from that journal record.
    #[test]
    fn flatten_chooses_side_and_qty_from_the_signed_net_no_mark() {
        let mut engine = build();
        // openLong: desk buys 2 from mm at 100.
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Sell, "2", "100"), None)
            .unwrap();
        let fill = engine
            .submit(MARKET, &limit(OPEN, "desk", Side::Buy, "2", "100"), None)
            .unwrap();
        assert!(fill.accepted);
        assert_eq!(fill.fills.len(), 1);
        assert_eq!(book(&engine).net_position("desk"), a("2"));
        assert_eq!(
            state(&engine).get("positions").unwrap().compact(),
            r#"[{"accountId":"desk","qty":"2"},{"accountId":"mm","qty":"-2"}]"#
        );

        engine.close_position(MARKET, CLOSE, "desk", None).unwrap();
        let record = engine.journal().read().last().unwrap().clone();
        assert_eq!(record.kind(), Some("submit"));
        let flatten = from_wire(record.field("order").unwrap()).unwrap();

        assert_eq!(flatten.order_type, OrderType::Market);
        assert_eq!(flatten.side, Side::Sell);
        assert_eq!(flatten.qty, a("2"));
        assert_eq!(flatten.price, None);
        assert_eq!(flatten.stop_price, None);
        assert_eq!(flatten.tif, Tif::Ioc);
        assert!(flatten.reduce_only);
    }
}

// ═══ l3-queue.test.ts ═══════════════════════════════════════════════════

mod l3_queue {
    use super::*;

    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";

    fn two_rests(engine: &mut MatchingEngine) {
        engine
            .submit(
                MARKET,
                &limit(FIRST, "maker-a", Side::Sell, "1", "100"),
                None,
            )
            .unwrap();
        engine
            .submit(
                MARKET,
                &limit(SECOND, "maker-b", Side::Sell, "2", "100"),
                None,
            )
            .unwrap();
    }

    /// What `GET /markets/:marketId/depth/l3?limit=50` answers, past the caller check.
    fn l3_door(engine: &mut MatchingEngine, market: &str) -> Json {
        let route = ROUTES
            .iter()
            .find(|r| r.method == "GET" && r.path == "/markets/:marketId/depth/l3")
            .unwrap();
        let url = format!("/markets/{}/depth/l3?limit=50", market.replace('/', "%2F"));
        let req = Request {
            method: "GET",
            url: &url,
            headers: &[],
            body: "",
        };
        let m = market.to_owned();
        match serve(route, &req, &|_| m.clone(), &Value::Undefined, engine) {
            Outcome::Answer(r) => {
                assert_eq!(r.status, 200, "{}", r.body);
                json::parse(&r.body).unwrap()
            }
            Outcome::Owed(s) => panic!("owed by {}", s.name()),
        }
    }

    #[test]
    fn two_rests_at_the_same_price_list_both_order_ids_in_sequence_order_as_l3_decimal_remaining() {
        let mut engine = build();
        two_rests(&mut engine);

        let l3 = engine.l3_queue(MARKET);
        assert_eq!(l3.market_id, MARKET);
        assert_eq!(l3.asks.len(), 1);
        assert_eq!(f(l3.asks[0].0), "100");
        let orders = &l3.asks[0].1;
        assert_eq!(
            orders.iter().map(|o| o.0.clone()).collect::<Vec<_>>(),
            strs(&[FIRST, SECOND])
        );
        assert_eq!(f(orders[0].1), "1");
        assert_eq!(f(orders[1].1), "2");
        assert!(orders[0].2 < orders[1].2);

        // The `level` label and the rows' shape are the answer's: read them there.
        let answer = l3_door(&mut engine, MARKET);
        assert_eq!(text(&answer, "level"), "L3");
        let rows = arr(&arr(&answer, "asks")[0], "orders");
        assert!(!has(&rows[0], "accountId"));
        assert!(!has(&rows[1], "accountId"));
    }

    #[test]
    fn carries_the_book_sequence_the_queue_was_read_at_the_same_number_depth_answers() {
        let mut engine = build();
        two_rests(&mut engine);
        let l3 = engine.l3_queue(MARKET);
        let (_, _, depth_sequence) = book(&engine).depth(1);
        assert_eq!(l3.sequence, depth_sequence);
        assert!(l3.sequence >= l3.asks[0].1[1].2);
    }

    /// `l2Depth` (the `level: 'L2'` read) is a helper the liquidity slice calls, not ported; and the book's depth is a
    /// tuple here, so it has no `level` to carry (held by the type). The rest is ported.
    #[test]
    fn book_depth_l2_is_aggregated_size_and_is_not_labeled_l3() {
        let mut engine = build();
        two_rests(&mut engine);

        let (_, asks, _) = book(&engine).depth(50);
        assert_eq!(asks, vec![(a("100"), a("3"))]);

        let l3 = l3_door(&mut engine, MARKET);
        assert_eq!(text(&l3, "level"), "L3");
        assert!(has(&arr(&l3, "asks")[0], "orders"));
    }

    #[test]
    fn public_maker_identity_and_l4_refuse_unpublished_no_maker_account_id_leaked_as_public_identity()
     {
        let mut engine = build();
        engine
            .submit(
                MARKET,
                &limit(FIRST, "secret-maker", Side::Sell, "1", "100"),
                None,
            )
            .unwrap();
        let answer = l3_door(&mut engine, MARKET);

        let ident = answer.get("makerIdentity").unwrap();
        assert_eq!(ident.get("accepted"), Some(&Json::Bool(false)));
        assert_eq!(
            text(ident.get("rejected").unwrap(), "code"),
            "maker_identity_unpublished"
        );
        assert_eq!(ident.get("identity"), Some(&Json::Null));
        assert!(!has(ident, "accountId"));
        assert!(!ident.compact().contains("secret-maker"));

        let unpublished = answer.get("l4").unwrap();
        assert_eq!(unpublished.get("accepted"), Some(&Json::Bool(false)));
        assert_eq!(
            text(unpublished.get("rejected").unwrap(), "code"),
            "l4_unpublished"
        );
        assert!(!has(unpublished, "level"));
        assert!(!unpublished.compact().contains("secret-maker"));

        assert!(!answer.compact().contains("secret-maker"));
        assert!(!has(
            &arr(&arr(&answer, "asks")[0], "orders")[0],
            "accountId"
        ));
    }

    /// The engine's read; the door answers an unknown market 404 before it reads the queue, so the `level` label of an
    /// empty queue is the engine wrapper's and not checked here.
    #[test]
    fn missing_market_is_empty_l3_not_a_fake_book() {
        let engine = build();
        let missing = "ETH/USDT";
        assert!(!engine.has_market(missing));
        assert_eq!(
            engine.l3_queue(missing),
            L3Queue {
                market_id: missing.to_owned(),
                sequence: 0,
                bids: Vec::new(),
                asks: Vec::new(),
            }
        );
        assert!(!engine.has_market(missing));
        assert!(engine.markets().is_empty());
    }
}

// ═══ post-only-market.test.ts ═══════════════════════════════════════════

mod post_only {
    use super::*;

    const ASK: &str = "11111111-1111-4111-8111-111111111111";
    const GTC: &str = "22222222-2222-4222-8222-222222222222";
    const PO: &str = "33333333-3333-4333-8333-333333333333";
    const CROSS: &str = "44444444-4444-4444-8444-444444444444";
    const REST: &str = "55555555-5555-4555-8555-555555555555";
    const AFTER: &str = "66666666-6666-4666-8666-666666666666";
    const OTHER_REST: &str = "88888888-8888-4888-8888-888888888888";

    fn ask(engine: &mut MatchingEngine) {
        engine
            .submit(MARKET, &limit(ASK, "mm", Side::Sell, "1", "100"), None)
            .unwrap();
    }

    fn first_order(s: &Json, side: &str) -> Json {
        arr(&arr(s, side)[0], "orders")[0].clone()
    }

    #[test]
    fn post_only_refuses_a_non_post_only_submit_and_journals_nothing_for_that_submit() {
        let mut engine = build();
        ask(&mut engine);
        let mut engine = switch(&engine, "post_only", MARKET);

        assert!(engine.flags(MARKET).post_only);
        assert!(!engine.flags(MARKET).halted);

        let before = jlen(&engine);
        let result = engine
            .submit(MARKET, &limit(GTC, "desk", Side::Buy, "1", "99"), None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "market_post_only");
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn post_only_still_rests_a_post_only_that_would_not_take() {
        let mut engine = build();
        ask(&mut engine);
        let mut engine = switch(&engine, "post_only", MARKET);

        let result = engine
            .submit(
                MARKET,
                &limit_tif(PO, "desk", Side::Buy, "1", "99", Tif::Po),
                None,
            )
            .unwrap();

        assert!(result.accepted);
        assert_eq!(result.resting.as_ref().unwrap().kind, RestKind::Book);
        assert_eq!(text(&first_order(&state(&engine), "bids"), "orderId"), PO);
    }

    #[test]
    fn post_only_still_refuses_a_post_only_that_would_take_existing_po_law() {
        let mut engine = build();
        ask(&mut engine);
        let mut engine = switch(&engine, "post_only", MARKET);
        let before = jlen(&engine);

        let result = engine
            .submit(
                MARKET,
                &limit_tif(CROSS, "desk", Side::Buy, "1", "100", Tif::Po),
                None,
            )
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(
            result.rejected.as_ref().unwrap().code,
            "post_only_would_cross"
        );
        assert!(result.fills.is_empty());
        assert_eq!(text(&first_order(&state(&engine), "asks"), "orderId"), ASK);
        assert_eq!(jlen(&engine), before + 1);
    }

    #[test]
    fn post_only_does_not_take_through_amend_while_the_market_is_post_only() {
        let mut engine = build();
        ask(&mut engine);
        let rested = engine
            .submit(MARKET, &limit(REST, "taker", Side::Buy, "1", "99"), None)
            .unwrap();
        assert!(rested.accepted);
        let mut engine = switch(&engine, "post_only", MARKET);
        let before = jlen(&engine);

        let crossed = engine
            .amend(
                MARKET,
                &EngineAmend {
                    price: Some(a("100")),
                    ..amend(REST, 1)
                },
                None,
            )
            .unwrap();

        assert!(!crossed.accepted);
        assert_eq!(crossed.rejected.as_ref().unwrap().code, "market_post_only");
        assert!(crossed.fills.is_empty());
        let s = state(&engine);
        assert_eq!(s.get("lastTradePrice"), Some(&Json::Null));
        assert_eq!(text(&first_order(&s, "asks"), "remaining"), "1");
        assert_eq!(text(&first_order(&s, "bids"), "orderId"), REST);
        assert_eq!(jlen(&engine), before);

        let not_post_only = engine
            .amend(
                MARKET,
                &EngineAmend {
                    tif: Some(Tif::Gtc),
                    price: Some(a("98")),
                    ..amend(REST, 1)
                },
                None,
            )
            .unwrap();
        assert!(!not_post_only.accepted);
        assert_eq!(
            not_post_only.rejected.as_ref().unwrap().code,
            "market_post_only"
        );
        assert!(not_post_only.fills.is_empty());
        assert_eq!(text(&arr(&state(&engine), "bids")[0], "price"), "99");

        let resting = engine
            .amend(
                MARKET,
                &EngineAmend {
                    tif: Some(Tif::Po),
                    price: Some(a("98")),
                    ..amend(REST, 1)
                },
                None,
            )
            .unwrap();
        assert!(resting.accepted, "{:?}", resting.rejected);
        assert!(resting.fills.is_empty());
        let s = state(&engine);
        assert_eq!(text(&arr(&s, "bids")[0], "price"), "98");
        assert_eq!(
            first_order(&s, "bids").get("postOnly"),
            Some(&Json::Bool(true))
        );
        assert_eq!(text(&first_order(&s, "asks"), "remaining"), "1");
        assert_eq!(s.get("lastTradePrice"), Some(&Json::Null));

        let po_cross = engine
            .amend(
                MARKET,
                &EngineAmend {
                    tif: Some(Tif::Po),
                    price: Some(a("100")),
                    ..amend(REST, resting.version.unwrap_or(0))
                },
                None,
            )
            .unwrap();
        assert!(!po_cross.accepted);
        assert_eq!(po_cross.rejected.as_ref().unwrap().code, "market_post_only");
        assert!(po_cross.fills.is_empty());
        let s = state(&engine);
        assert_eq!(text(&first_order(&s, "asks"), "remaining"), "1");
        assert_eq!(text(&arr(&s, "bids")[0], "price"), "98");
        assert_eq!(s.get("lastTradePrice"), Some(&Json::Null));

        let submit = engine
            .submit(MARKET, &limit(GTC, "desk", Side::Buy, "1", "97"), None)
            .unwrap();
        assert!(!submit.accepted);
        assert_eq!(submit.rejected.as_ref().unwrap().code, "market_post_only");
    }

    #[test]
    fn post_only_leaves_another_market_open_for_new_submits() {
        let mut engine = switch(&build(), "post_only", MARKET);

        let result = engine
            .submit(
                OTHER,
                &limit(OTHER_REST, "desk", Side::Sell, "1", "200"),
                None,
            )
            .unwrap();

        assert!(result.accepted);
        assert!(!engine.flags(OTHER).post_only);
        assert!(engine.flags(MARKET).post_only);
    }

    #[test]
    fn post_only_still_cancels_while_post_only() {
        let mut engine = build();
        ask(&mut engine);
        let mut engine = switch(&engine, "post_only", MARKET);
        engine
            .submit(
                MARKET,
                &limit_tif(REST, "desk", Side::Buy, "1", "99", Tif::Po),
                None,
            )
            .unwrap();

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "bids").is_empty());
    }

    #[test]
    fn post_only_is_not_halt_halt_still_blocks_a_resting_post_only() {
        let mut engine = build();
        ask(&mut engine);
        let mut engine = switch(&engine, "post_only", MARKET);
        let resting = engine
            .submit(
                MARKET,
                &limit_tif(PO, "desk", Side::Buy, "1", "99", Tif::Po),
                None,
            )
            .unwrap();
        assert!(resting.accepted);

        let mut engine = switch(&engine, "halt", MARKET);
        let blocked = engine
            .submit(
                MARKET,
                &limit_tif(CROSS, "desk", Side::Buy, "1", "98", Tif::Po),
                None,
            )
            .unwrap();
        assert!(!blocked.accepted);
        assert_eq!(blocked.rejected.as_ref().unwrap().code, "market_halted");
    }

    #[test]
    fn post_only_resumes_only_after_an_explicit_resume_post_only_never_expires() {
        let mut engine = switch(&build(), "post_only", MARKET);
        let blocked = engine
            .submit(MARKET, &limit(GTC, "desk", Side::Buy, "1", "100"), None)
            .unwrap();
        assert!(!blocked.accepted);

        let mut engine = switch(&engine, "resume_post_only", MARKET);
        assert!(!engine.flags(MARKET).post_only);

        let result = engine
            .submit(MARKET, &limit(AFTER, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        assert!(result.accepted);
    }

    #[test]
    fn post_only_does_not_disable_the_engine_the_process_kill_switch_is_a_different_door() {
        let engine = switch(&build(), "post_only", MARKET);
        assert!(engine.is_enabled());
        assert!(!engine.flags(OTHER).post_only);
        assert!(!engine.flags(MARKET).halted);
    }

    #[test]
    fn post_only_replays_post_only_so_a_recovered_engine_still_refuses_non_post_only_submits() {
        let mut engine = build();
        ask(&mut engine);
        let engine = switch(&engine, "post_only", MARKET);

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).post_only);
        assert!(recovered.has_market(MARKET));

        let result = recovered
            .submit(MARKET, &limit(GTC, "desk", Side::Buy, "1", "99"), None)
            .unwrap();
        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "market_post_only");
    }

    #[test]
    fn post_only_replay_of_post_only_then_resume_leaves_the_market_open() {
        let engine = switch(&build(), "post_only", MARKET);
        let engine = switch(&engine, "resume_post_only", MARKET);

        let mut recovered = reboot(&engine);
        assert!(!recovered.flags(MARKET).post_only);

        let result = recovered
            .submit(MARKET, &limit(AFTER, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        assert!(result.accepted);
    }
}

// ═══ reduce-only-market.test.ts ═════════════════════════════════════════

mod reduce_only_market {
    use super::*;

    const LIQ: &str = "11111111-1111-4111-8111-111111111111";
    const OPEN: &str = "22222222-2222-4222-8222-222222222222";
    const TAKER: &str = "33333333-3333-4333-8333-333333333333";
    const RO: &str = "44444444-4444-4444-8444-444444444444";
    const REST: &str = "55555555-5555-4555-8555-555555555555";
    const AFTER: &str = "66666666-6666-4666-8666-666666666666";
    const CLOSE: &str = "77777777-7777-4777-8777-777777777777";
    const OTHER_REST: &str = "88888888-8888-4888-8888-888888888888";
    const AMEND: &str = "99999999-9999-4999-8999-999999999999";
    const EXIT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const BID_HIGH: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const BID_LOW: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const FLAT: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const REDUCE: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    fn open_long(engine: &mut MatchingEngine) {
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Sell, "2", "100"), None)
            .unwrap();
        let fill = engine
            .submit(MARKET, &limit(OPEN, "desk", Side::Buy, "2", "100"), None)
            .unwrap();
        assert!(fill.accepted);
    }

    fn long_engine() -> MatchingEngine {
        let mut engine = build();
        open_long(&mut engine);
        engine
    }

    #[test]
    fn reduce_only_refuses_a_submit_that_would_open_or_increase_and_journals_nothing_for_that_submit()
     {
        let mut engine = switch(&long_engine(), "reduce_only", MARKET);

        assert!(engine.flags(MARKET).reduce_only);
        assert!(!engine.flags(MARKET).halted);

        let before = jlen(&engine);
        let result = engine
            .submit(MARKET, &limit(TAKER, "desk", Side::Buy, "1", "100"), None)
            .unwrap();

        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "market_reduce_only");
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn reduce_only_still_rests_a_reduce_only_that_shrinks_the_position() {
        let mut engine = switch(&long_engine(), "reduce_only", MARKET);

        let result = engine
            .submit(
                MARKET,
                &reduce_only(limit(RO, "desk", Side::Sell, "1", "101")),
                None,
            )
            .unwrap();

        assert!(result.accepted, "{:?}", result.rejected);
        assert_eq!(result.resting.as_ref().unwrap().kind, RestKind::Book);
        assert_eq!(
            text(
                &arr(&arr(&state(&engine), "asks")[0], "orders")[0],
                "orderId"
            ),
            RO
        );
    }

    #[test]
    fn reduce_only_still_flattens_close_position_while_reduce_only() {
        let mut engine = long_engine();
        engine
            .submit(MARKET, &limit(EXIT, "liq", Side::Buy, "2", "100"), None)
            .unwrap();
        let mut engine = switch(&engine, "reduce_only", MARKET);

        let closed = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();

        assert!(closed.accepted, "{:?}", closed.rejected);
        assert_eq!(closed.rejected, None);
        assert!(!closed.fills.is_empty());
    }

    #[test]
    fn reduce_only_leaves_another_market_open_for_new_submits() {
        let mut engine = switch(&build(), "reduce_only", MARKET);

        let result = engine
            .submit(
                OTHER,
                &limit(OTHER_REST, "desk", Side::Sell, "1", "200"),
                None,
            )
            .unwrap();

        assert!(result.accepted);
        assert!(!engine.flags(OTHER).reduce_only);
        assert!(engine.flags(MARKET).reduce_only);
    }

    #[test]
    fn reduce_only_still_cancels_while_reduce_only() {
        let mut engine = switch(&long_engine(), "reduce_only", MARKET);
        engine
            .submit(
                MARKET,
                &reduce_only(limit(REST, "desk", Side::Sell, "1", "101")),
                None,
            )
            .unwrap();

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "asks").is_empty());
    }

    #[test]
    fn reduce_only_is_not_halt_halt_still_blocks_a_reducing_submit() {
        let mut engine = switch(&long_engine(), "reduce_only", MARKET);
        let reducing = engine
            .submit(
                MARKET,
                &reduce_only(limit(RO, "desk", Side::Sell, "1", "101")),
                None,
            )
            .unwrap();
        assert!(reducing.accepted);

        let mut engine = switch(&engine, "halt", MARKET);
        let blocked = engine
            .submit(
                MARKET,
                &reduce_only(limit(TAKER, "desk", Side::Sell, "1", "101")),
                None,
            )
            .unwrap();
        assert!(!blocked.accepted);
        assert_eq!(blocked.rejected.as_ref().unwrap().code, "market_halted");
    }

    #[test]
    fn reduce_only_resumes_only_after_an_explicit_resume_reduce_only_never_expires() {
        let mut engine = switch(&build(), "reduce_only", MARKET);
        let blocked = engine
            .submit(MARKET, &limit(TAKER, "desk", Side::Buy, "1", "100"), None)
            .unwrap();
        assert!(!blocked.accepted);

        let mut engine = switch(&engine, "resume_reduce_only", MARKET);
        assert!(!engine.flags(MARKET).reduce_only);

        let result = engine
            .submit(MARKET, &limit(AFTER, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        assert!(result.accepted);
    }

    #[test]
    fn reduce_only_does_not_disable_the_engine_the_process_kill_switch_is_a_different_door() {
        let engine = switch(&build(), "reduce_only", MARKET);
        assert!(engine.is_enabled());
        assert!(!engine.flags(OTHER).reduce_only);
        assert!(!engine.flags(MARKET).halted);
    }

    #[test]
    fn reduce_only_replays_reduce_only_so_a_recovered_engine_still_refuses_opens() {
        let engine = switch(&long_engine(), "reduce_only", MARKET);

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).reduce_only);
        assert!(recovered.has_market(MARKET));

        let result = recovered
            .submit(MARKET, &limit(TAKER, "desk", Side::Buy, "1", "100"), None)
            .unwrap();
        assert!(!result.accepted);
        assert_eq!(result.rejected.as_ref().unwrap().code, "market_reduce_only");
    }

    #[test]
    fn reduce_only_refuses_an_amend_that_would_increase_without_journaling() {
        let mut engine = switch(&long_engine(), "reduce_only", MARKET);
        let rest = engine
            .submit(
                MARKET,
                &reduce_only(limit(AMEND, "desk", Side::Sell, "1", "101")),
                None,
            )
            .unwrap();
        assert!(rest.accepted);
        let before = jlen(&engine);

        let amended = engine
            .amend(
                MARKET,
                &EngineAmend {
                    qty: Some(a("3")),
                    ..amend(AMEND, 1)
                },
                None,
            )
            .unwrap();

        assert!(!amended.accepted);
        assert_eq!(
            amended.rejected.as_ref().unwrap().code,
            "market_reduce_only"
        );
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn reduce_only_a_price_amend_that_omits_qty_does_not_grow_a_position_on_a_reduce_only_market() {
        let mut engine = long_engine();
        engine
            .submit(MARKET, &limit(BID_LOW, "mm", Side::Buy, "2", "80"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(BID_HIGH, "mm", Side::Buy, "2", "100"), None)
            .unwrap();
        let rest = engine
            .submit(MARKET, &limit(AMEND, "desk", Side::Sell, "2", "110"), None)
            .unwrap();
        assert!(rest.accepted);
        let reducing = engine
            .submit(MARKET, &limit(REDUCE, "desk", Side::Sell, "1", "120"), None)
            .unwrap();
        assert!(reducing.accepted);
        let mut engine = switch(&engine, "reduce_only", MARKET);

        let shrunk = engine
            .amend(
                MARKET,
                &EngineAmend {
                    qty: Some(a("1")),
                    price: Some(a("119")),
                    ..amend(REDUCE, 1)
                },
                None,
            )
            .unwrap();
        assert!(shrunk.accepted, "{:?}", shrunk.rejected);
        assert!(shrunk.fills.is_empty());
        assert_eq!(position_of(&state(&engine), "desk"), Some("2".to_owned()));

        let flat = engine
            .submit(MARKET, &limit(FLAT, "desk", Side::Sell, "2", "100"), None)
            .unwrap();
        assert!(flat.accepted, "{:?}", flat.rejected);
        assert_eq!(flat.fills.len(), 1);
        assert!(!has(&state(&engine), "positions"));

        let before = jlen(&engine);
        let amended = engine
            .amend(
                MARKET,
                &EngineAmend {
                    price: Some(a("80")),
                    ..amend(AMEND, 1)
                },
                None,
            )
            .unwrap();

        assert!(!amended.accepted);
        assert_eq!(
            amended.rejected.as_ref().unwrap().code,
            "market_reduce_only"
        );
        assert!(amended.fills.is_empty());
        assert_eq!(jlen(&engine), before);
        let s = state(&engine);
        assert!(!has(&s, "positions"));
        assert_eq!(text(&s, "lastTradePrice"), "100");
        let level = arr(&s, "asks")
            .iter()
            .find(|l| text(l, "price") == "110")
            .unwrap();
        let first = &arr(level, "orders")[0];
        assert_eq!(text(first, "orderId"), AMEND);
        assert_eq!(text(first, "remaining"), "2");
        let bid = &arr(&s, "bids")[0];
        assert_eq!(text(bid, "price"), "80");
        assert_eq!(text(&arr(bid, "orders")[0], "remaining"), "2");
    }

    #[test]
    fn reduce_only_replay_of_reduce_only_then_resume_leaves_the_market_open() {
        let engine = switch(&build(), "reduce_only", MARKET);
        let engine = switch(&engine, "resume_reduce_only", MARKET);

        let mut recovered = reboot(&engine);
        assert!(!recovered.flags(MARKET).reduce_only);

        let result = recovered
            .submit(MARKET, &limit(AFTER, "desk", Side::Sell, "1", "100"), None)
            .unwrap();
        assert!(result.accepted);
    }
}

// ═══ core-tif.test.ts ═══════════════════════════════════════════════════

mod core_tif {
    use super::*;

    const REST: &str = "11111111-1111-4111-8111-111111111111";
    const BLANK: &str = "22222222-2222-4222-8222-222222222222";
    const EMPTY: &str = "33333333-3333-4333-8333-333333333333";
    const GTD: &str = "44444444-4444-4444-8444-444444444444";
    const GTT: &str = "55555555-5555-4555-8555-555555555555";
    const CLID_NONE: &str = "99999999-9999-4999-8999-999999999999";
    const LIQ: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const OPEN: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const EXIT: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const CLOSE: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const UNKNOWN: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const RETRY_BAD: &str = "17171717-1717-4717-8717-171717171717";
    const RETRY_OK: &str = "18181818-1818-4818-8818-181818181818";

    const TIF_MISSING: &str = "tif_missing";
    const CLIENT_ORDER_ID_REUSE: &str = "client_order_id_reuse";

    fn live_ids(engine: &MatchingEngine) -> Vec<String> {
        engine
            .resting_orders(Some(MARKET))
            .into_iter()
            .map(|o| o.order_id)
            .collect()
    }

    fn dated(mut o: EngineOrder) -> EngineOrder {
        o.expire_at = Some(EXPIRE.to_owned());
        o
    }

    #[test]
    fn present_tif_gtc_still_rests_control() {
        let mut engine = build();
        let result = engine
            .submit(MARKET, &limit(REST, "desk", Side::Sell, "1", "100"), None)
            .unwrap();

        assert!(result.accepted);
        assert_eq!(result.rejected, None);
        assert_eq!(result.resting.as_ref().unwrap().order_id, REST);
        assert_eq!(live_ids(&engine), strs(&[REST]));
    }

    #[test]
    fn present_gtc_ioc_fok_po_gtd_gtt_with_required_fields_are_not_tif_missing() {
        let mut engine = build_clock(before_ms);
        let mut go = |o: EngineOrder| engine.submit(MARKET, &o, None).unwrap();
        let gtc = go(limit_tif(REST, "desk", Side::Sell, "1", "100", Tif::Gtc));
        let ioc = go(limit_tif(EMPTY, "ioc", Side::Buy, "1", "99", Tif::Ioc));
        let fok = go(limit_tif(BLANK, "fok", Side::Buy, "1", "99", Tif::Fok));
        let po = go(limit_tif(UNKNOWN, "po", Side::Buy, "1", "99", Tif::Po));
        let gtd = go(dated(limit_tif(GTD, "gtd", Side::Buy, "1", "98", Tif::Gtd)));
        let gtt = go(dated(limit_tif(GTT, "gtt", Side::Buy, "1", "97", Tif::Gtt)));

        for r in [&gtc, &ioc, &fok, &po, &gtd, &gtt] {
            assert_ne!(
                r.rejected.as_ref().map(|r| r.code.as_str()),
                Some(TIF_MISSING)
            );
        }
        assert!(gtc.accepted);
        assert!(gtd.accepted, "{:?}", gtd.rejected);
        assert!(gtt.accepted, "{:?}", gtt.rejected);
        assert_eq!(gtd.resting.as_ref().unwrap().order_id, GTD);
        assert_eq!(gtt.resting.as_ref().unwrap().order_id, GTT);
    }

    #[test]
    fn engine_submit_gtd_with_expire_at_and_clock_rests_gtt_missing_expire_at_refuses_missing_expire_at()
     {
        let mut engine = build_clock(before_ms);
        let gtd = engine
            .submit(
                MARKET,
                &dated(limit_tif(GTD, "desk", Side::Buy, "1", "100", Tif::Gtd)),
                None,
            )
            .unwrap();
        let gtt = engine
            .submit(
                MARKET,
                &limit_tif(GTT, "desk", Side::Sell, "1", "101", Tif::Gtt),
                None,
            )
            .unwrap();

        assert!(gtd.accepted, "{:?}", gtd.rejected);
        assert_eq!(gtd.resting.as_ref().unwrap().order_id, GTD);
        assert_ne!(
            gtd.rejected.as_ref().map(|r| r.code.as_str()),
            Some(TIF_MISSING)
        );
        assert!(!gtt.accepted);
        assert_eq!(gtt.rejected.as_ref().unwrap().code, "missing_expire_at");
        assert_ne!(gtt.rejected.as_ref().unwrap().code, TIF_MISSING);
        assert_eq!(gtt.resting, None);
        assert_eq!(gtt.sequence, None);
        assert_eq!(live_ids(&engine), strs(&[GTD]));
    }

    /// The order has no client order id here: that field is not part of the Rust order.
    #[test]
    fn missing_client_order_id_still_accepts() {
        let mut engine = build();
        let result = engine
            .submit(
                MARKET,
                &limit(CLID_NONE, "desk", Side::Buy, "1", "100"),
                None,
            )
            .unwrap();

        assert!(result.accepted);
        assert_eq!(result.rejected, None);
        assert_eq!(result.resting.as_ref().unwrap().order_id, CLID_NONE);
        assert_eq!(live_ids(&engine), strs(&[CLID_NONE]));
    }

    /// Ported without the client order id and environment, which the Rust order does not carry: what is left is the
    /// refusal and the retry that rests.
    #[test]
    fn a_submit_that_does_not_accept_releases_the_client_order_id_for_a_later_retry() {
        let mut engine = build_clock(before_ms);
        let refused = engine
            .submit(
                MARKET,
                &limit_tif(RETRY_BAD, "desk", Side::Sell, "1", "100", Tif::Gtt),
                None,
            )
            .unwrap();
        assert!(!refused.accepted);
        assert_eq!(refused.rejected.as_ref().unwrap().code, "missing_expire_at");
        assert_eq!(refused.resting, None);
        assert!(refused.fills.is_empty());
        assert!(live_ids(&engine).is_empty());

        let retry = engine
            .submit(
                MARKET,
                &dated(limit_tif(
                    RETRY_OK,
                    "desk",
                    Side::Sell,
                    "1",
                    "100",
                    Tif::Gtt,
                )),
                None,
            )
            .unwrap();
        assert!(retry.accepted, "{:?}", retry.rejected);
        assert_ne!(
            retry.rejected.as_ref().map(|r| r.code.as_str()),
            Some(CLIENT_ORDER_ID_REUSE)
        );
        assert_eq!(retry.resting.as_ref().unwrap().order_id, RETRY_OK);
        assert!(retry.fills.is_empty());
        assert_eq!(live_ids(&engine), strs(&[RETRY_OK]));
    }

    /// `flattenCloseOrder` is inline in `close_position`: its TIF is read back from the journalled order.
    #[test]
    fn close_position_flatten_still_works_ioc_not_a_gtc_map() {
        let mut engine = build();
        engine
            .submit(MARKET, &limit(LIQ, "mm", Side::Sell, "2", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(OPEN, "desk", Side::Buy, "2", "100"), None)
            .unwrap();
        engine
            .submit(MARKET, &limit(EXIT, "liq", Side::Buy, "2", "100"), None)
            .unwrap();

        let result = engine.close_position(MARKET, CLOSE, "desk", None).unwrap();
        let record = engine
            .journal()
            .read()
            .iter()
            .rev()
            .find(|r| r.kind() == Some("submit"))
            .unwrap()
            .clone();
        let flatten = from_wire(record.field("order").unwrap()).unwrap();
        assert_eq!(flatten.order_id, CLOSE);
        assert_eq!(flatten.tif, Tif::Ioc);
        assert_ne!(flatten.tif, Tif::Gtc);

        assert!(result.accepted);
        assert_eq!(result.fills.len(), 1);
        assert_ne!(
            result.rejected.as_ref().map(|r| r.code.as_str()),
            Some(TIF_MISSING)
        );
        assert_eq!(book(&engine).net_position("desk"), 0);
    }
}

// ═══ reconcile.test.ts ══════════════════════════════════════════════════

mod reconcile_calls {
    use super::*;

    /// `idFactory`: a readable label to a stable uuid, in first-use order.
    #[derive(Default)]
    struct Ids(HashMap<String, String>);

    impl Ids {
        fn id(&mut self, label: &str) -> String {
            let next = self.0.len() + 1;
            self.0
                .entry(label.to_owned())
                .or_insert_with(|| format!("00000000-0000-4000-8000-{next:012}"))
                .clone()
        }
    }

    fn lim(order_id: &str, account_label: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
        limit(order_id, &format!("acct-{account_label}"), side, qty, price)
    }

    fn claim(order_id: String) -> CounterpartOrder {
        CounterpartOrder {
            order_id,
            market_id: MARKET.to_owned(),
            state: "open".to_owned(),
            remaining: "1".to_owned(),
            funded: true,
            detail: None,
        }
    }

    fn put(engine: &mut MatchingEngine, market: &str, o: &EngineOrder) {
        let r = engine.submit(market, o, None).unwrap();
        assert!(r.accepted, "{:?}", r.rejected);
    }

    // ── restingOrders — the non-destructive read ──

    #[test]
    fn resting_orders_reports_a_resting_order_with_its_id_account_and_remaining_and_does_not_remove_it()
     {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let first = engine.resting_orders(None);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].market_id, MARKET);
        assert_eq!(first[0].order_id, ids.id("o1"));
        assert_eq!(first[0].account_id, "acct-o1");
        assert_eq!(first[0].kind, RestKind::Book);
        assert_eq!(first[0].side, Side::Buy);
        assert_eq!(f(first[0].remaining), "2");

        assert_eq!(engine.resting_orders(None), first);
        assert_eq!(
            engine.depth(MARKET, 50).unwrap().bids,
            vec![(a("100"), a("2"))]
        );
    }

    #[test]
    fn resting_orders_reports_the_unfilled_remainder_after_a_partial_fill_not_the_original_qty() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("maker"), "maker", Side::Sell, "5", "100"),
        );
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("taker"), "taker", Side::Buy, "2", "100"),
        );

        let live = engine.resting_orders(None);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].order_id, ids.id("maker"));
        assert_eq!(f(live[0].remaining), "3");
    }

    #[test]
    fn resting_orders_includes_an_untriggered_stop_which_never_appears_in_depth() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &stop(&ids.id("stop-1"), "acct-stop", Side::Sell, "4", "90"),
        );

        let depth = engine.depth(MARKET, 50).unwrap();
        assert!(depth.bids.is_empty());
        assert!(depth.asks.is_empty());

        let live = engine.resting_orders(None);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].order_id, ids.id("stop-1"));
        assert_eq!(live[0].kind, RestKind::Stop);
        assert_eq!(f(live[0].remaining), "4");
        assert_eq!(f(live[0].price), "90");
    }

    #[test]
    fn resting_orders_is_empty_once_an_order_is_cancelled_and_filters_by_market() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "1", "100"),
        );
        put(
            &mut engine,
            OTHER,
            &lim(&ids.id("o2"), "o2", Side::Buy, "1", "100"),
        );

        assert_eq!(engine.resting_orders(None).len(), 2);
        assert_eq!(
            engine
                .resting_orders(Some(MARKET))
                .into_iter()
                .map(|o| o.order_id)
                .collect::<Vec<_>>(),
            vec![ids.id("o1")]
        );
        assert!(engine.resting_orders(Some("never-traded")).is_empty());

        engine
            .cancel(MARKET, &ids.id("o1"), CancelReason::Requested)
            .unwrap();
        assert_eq!(
            engine
                .resting_orders(None)
                .into_iter()
                .map(|o| o.order_id)
                .collect::<Vec<_>>(),
            vec![ids.id("o2")]
        );
    }

    #[test]
    fn resting_orders_survives_replay_the_count_after_recovery_is_the_count_before_it() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o2"), "o2", Side::Buy, "3", "99"),
        );
        let before = engine.resting_orders(None);

        let rebooted = reboot(&engine);

        assert_eq!(rebooted.resting_orders(None), before);
        assert_eq!(rebooted.resting_order_count(), 2);
    }

    // ── reconcile — a clean pair is silent ──

    #[test]
    fn reconcile_reports_ok_with_no_findings_when_both_sides_agree() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                remaining: "2".into(),
                ..claim(ids.id("o1"))
            }],
        );

        assert!(report.findings.is_empty());
        assert!(report.ok);
        assert_eq!(report.refusals, 0);
        assert_eq!(report.agreed, 1);
        assert_eq!(report.checked, 1);
    }

    #[test]
    fn reconcile_treats_a_decimal_string_that_spells_the_same_amount_as_agreement() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                remaining: "2.000000000000000000".into(),
                ..claim(ids.id("o1"))
            }],
        );

        assert!(report.ok);
        assert!(report.findings.is_empty());
    }

    #[test]
    fn reconcile_says_nothing_when_both_sides_agree_an_order_is_over() {
        let mut ids = Ids::default();
        let report = reconcile(
            &[],
            &[CounterpartOrder {
                state: "terminal".into(),
                remaining: "0".into(),
                funded: false,
                ..claim(ids.id("gone"))
            }],
        );
        assert!(report.ok);
        assert_eq!(report.agreed, 1);
        assert!(report.findings.is_empty());
    }

    // ── ledger has a hold the engine does not ──

    #[test]
    fn reconcile_stranded_refuses_and_names_the_order_and_both_states() {
        let mut ids = Ids::default();
        let report = reconcile(
            &[],
            &[CounterpartOrder {
                remaining: "2".into(),
                funded: true,
                detail: Some("hold=200 USDT".into()),
                ..claim(ids.id("stranded-1"))
            }],
        );

        assert!(!report.ok);
        assert_eq!(report.refusals, 1);

        let finding = &report.findings[0];
        assert_eq!(finding.order_id, ids.id("stranded-1"));
        assert_eq!(finding.case, "counterpart_open_engine_missing");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains("NOT LIVE"));
        assert!(finding.counterpart.contains("OPEN"));
        assert!(finding.counterpart.contains("remaining=2"));
        assert!(finding.counterpart.contains("hold=200 USDT"));
        assert!(finding.reason.to_lowercase().contains("lost fill"));
    }

    #[test]
    fn reconcile_stranded_does_not_auto_release_no_verdict_in_the_report_authorises_moving_value() {
        let mut ids = Ids::default();
        let report = reconcile(
            &[],
            &[CounterpartOrder {
                funded: true,
                ..claim(ids.id("stranded-1"))
            }],
        );
        assert!(report.findings.iter().all(|f| f.verdict != "auto"));
    }

    // ── journal has an order the counterpart does not ──

    #[test]
    fn reconcile_refuses_rather_than_cancelling_a_book_it_cannot_see_all_of() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("phantom"), "phantom", Side::Sell, "1", "100"),
        );

        let report = reconcile(&engine.resting_orders(None), &[]);

        assert!(!report.ok);
        let finding = &report.findings[0];
        assert_eq!(finding.case, "engine_only");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains("LIVE"));
        assert!(finding.counterpart.contains("UNKNOWN"));
        assert!(
            finding
                .reason
                .to_lowercase()
                .contains("incomplete counterpart view")
        );
    }

    // ── both have it but disagree ──

    #[test]
    fn reconcile_refuses_on_a_quantity_disagreement_naming_both_quantities() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("maker"), "maker", Side::Sell, "5", "100"),
        );
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("taker"), "taker", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                state: "open".into(),
                remaining: "5".into(),
                funded: true,
                ..claim(ids.id("maker"))
            }],
        );

        assert!(!report.ok);
        let maker = ids.id("maker");
        let finding = report
            .findings
            .iter()
            .find(|f| f.order_id == maker)
            .unwrap();
        assert_eq!(finding.case, "quantity_disagreement");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains("remaining=3"));
        assert!(finding.counterpart.contains("remaining=5"));
    }

    #[test]
    fn reconcile_refuses_a_pending_claim_whose_id_is_already_resting_including_when_unfunded_and_the_qty_matches()
     {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("intent"), "intent", Side::Buy, "2", "100"),
        );

        let before = engine.resting_orders(None);
        let intent = ids.id("intent");
        let pending = |funded| CounterpartOrder {
            state: "pending".into(),
            remaining: "2".into(),
            funded,
            ..claim(intent.clone())
        };
        let unfunded = reconcile(&before, &[pending(false)]);

        assert_eq!(unfunded.agreed, 0);
        assert!(!unfunded.ok);
        assert_eq!(unfunded.refusals, 1);
        assert_eq!(unfunded.findings.len(), 1);
        let finding = &unfunded.findings[0];
        assert_eq!(finding.order_id, intent);
        assert_eq!(finding.case, "counterpart_pending_engine_live");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains("LIVE"));
        assert!(finding.engine.contains("remaining=2"));
        assert!(finding.counterpart.contains("PENDING"));
        assert!(finding.counterpart.contains("funded=false"));
        assert!(finding.counterpart.contains("remaining=2"));
        let reason = finding.reason.to_lowercase();
        assert!(reason.contains("not yet live"));
        assert!(reason.contains("auto-cancel"));
        assert!(reason.contains("auto-release"));

        let funded = reconcile(&before, &[pending(true)]);
        assert_eq!(funded.agreed, 0);
        assert!(!funded.ok);
        assert_eq!(funded.findings[0].case, "counterpart_pending_engine_live");
        assert_eq!(funded.findings[0].verdict, "refuse");

        let opened = reconcile(
            &before,
            &[CounterpartOrder {
                state: "open".into(),
                remaining: "2".into(),
                funded: true,
                ..claim(ids.id("intent"))
            }],
        );
        assert!(opened.ok);
        assert_eq!(opened.refusals, 0);
        assert_eq!(opened.agreed, 1);
        assert_eq!(opened.checked, 1);
        assert!(opened.findings.is_empty());

        assert_eq!(engine.resting_orders(None), before);
    }

    #[test]
    fn reconcile_refuses_when_the_counterpart_calls_it_terminal_and_the_engine_is_still_working_it()
    {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                state: "terminal".into(),
                remaining: "0".into(),
                funded: false,
                ..claim(ids.id("o1"))
            }],
        );

        let finding = &report.findings[0];
        assert_eq!(finding.case, "counterpart_terminal_engine_live");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains("LIVE"));
        assert!(finding.counterpart.contains("TERMINAL"));
        assert!(finding.reason.to_lowercase().contains("free book risk"));
    }

    #[test]
    fn reconcile_refuses_when_one_order_id_is_resting_under_a_different_market_than_the_caller_believes()
     {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                market_id: OTHER.into(),
                remaining: "2".into(),
                ..claim(ids.id("o1"))
            }],
        );

        let finding = &report.findings[0];
        assert_eq!(finding.case, "market_disagreement");
        assert_eq!(finding.verdict, "refuse");
        assert!(finding.engine.contains(&format!("market={MARKET}")));
        assert!(finding.counterpart.contains(&format!("market={OTHER}")));
    }

    #[test]
    fn reconcile_refuses_on_an_unreadable_quantity_instead_of_coercing_one() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[CounterpartOrder {
                remaining: "not-a-number".into(),
                ..claim(ids.id("o1"))
            }],
        );

        assert_eq!(report.findings[0].case, "unreadable_amount");
        assert_eq!(report.findings[0].verdict, "refuse");
    }

    // ── the one case that is safe to automate ──

    #[test]
    fn reconcile_marks_an_unfunded_intent_row_the_engine_never_saw_as_auto_and_does_not_count_it_as_a_refusal()
     {
        let mut ids = Ids::default();
        let report = reconcile(
            &[],
            &[CounterpartOrder {
                state: "pending".into(),
                remaining: "2".into(),
                funded: false,
                ..claim(ids.id("orphan"))
            }],
        );

        let finding = &report.findings[0];
        assert_eq!(finding.case, "counterpart_unfunded_engine_missing");
        assert_eq!(finding.verdict, "auto");
        assert!(finding.reason.to_lowercase().contains("moves no value"));

        assert!(report.ok);
        assert_eq!(report.refusals, 0);
    }

    #[test]
    fn reconcile_is_not_auto_once_the_same_row_is_funded_the_hold_is_the_whole_difference() {
        let mut ids = Ids::default();
        let funded = reconcile(
            &[],
            &[CounterpartOrder {
                state: "pending".into(),
                remaining: "2".into(),
                funded: true,
                ..claim(ids.id("orphan"))
            }],
        );
        assert_eq!(funded.findings[0].verdict, "refuse");
        assert!(!funded.ok);
    }

    // ── the counterpart contradicts itself ──

    #[test]
    fn reconcile_refuses_a_duplicated_order_id_instead_of_silently_judging_it_twice() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("o1"), "o1", Side::Buy, "2", "100"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[
                CounterpartOrder {
                    remaining: "2".into(),
                    ..claim(ids.id("o1"))
                },
                CounterpartOrder {
                    remaining: "5".into(),
                    ..claim(ids.id("o1"))
                },
            ],
        );

        assert!(!report.ok);
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].case, "duplicate_counterpart_id");
        assert_eq!(report.findings[0].verdict, "refuse");
        assert!(report.findings[0].counterpart.contains("remaining=2"));
        assert!(report.findings[0].counterpart.contains("remaining=5"));
        assert_eq!(report.agreed, 0);
    }

    // ── report shape ──

    #[test]
    fn reconcile_sorts_findings_by_order_id_so_two_runs_read_the_same() {
        const LOW: &str = "00000000-0000-4000-8000-0000000000a1";
        const HIGH: &str = "00000000-0000-4000-8000-0000000000f9";

        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(HIGH, "high", Side::Buy, "1", "100"),
        );
        put(&mut engine, MARKET, &lim(LOW, "low", Side::Buy, "1", "99"));

        let report = reconcile(&engine.resting_orders(None), &[]);
        assert_eq!(
            report
                .findings
                .iter()
                .map(|f| f.order_id.clone())
                .collect::<Vec<_>>(),
            strs(&[LOW, HIGH])
        );
    }

    #[test]
    fn reconcile_counts_both_directions_in_a_mixed_run() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("agreed"), "agreed", Side::Buy, "1", "100"),
        );
        put(
            &mut engine,
            MARKET,
            &lim(&ids.id("phantom"), "phantom", Side::Buy, "1", "99"),
        );

        let report = reconcile(
            &engine.resting_orders(None),
            &[
                CounterpartOrder {
                    remaining: "1".into(),
                    ..claim(ids.id("agreed"))
                },
                CounterpartOrder {
                    funded: true,
                    ..claim(ids.id("stranded"))
                },
                CounterpartOrder {
                    state: "pending".into(),
                    funded: false,
                    ..claim(ids.id("orphan"))
                },
            ],
        );

        assert_eq!(report.agreed, 1);
        assert_eq!(report.refusals, 2);
        assert!(!report.ok);
        assert_eq!(report.checked, 4);
        let mut cases: Vec<&str> = report.findings.iter().map(|f| f.case).collect();
        cases.sort_unstable();
        assert_eq!(
            cases,
            vec![
                "counterpart_open_engine_missing",
                "counterpart_unfunded_engine_missing",
                "engine_only",
            ]
        );
    }

    // ── EngineLiveOrder carries amounts as strings ──

    /// The amounts are `Amount` (an integer) in memory, so a float cannot reach them (held by the type); on the wire
    /// (`to_json`) they are strings, which is what the TypeScript's `typeof` checks.
    #[test]
    fn engine_live_order_has_no_numeric_price_or_quantity() {
        let mut ids = Ids::default();
        let mut engine = build();
        put(
            &mut engine,
            MARKET,
            &lim(
                &ids.id("o1"),
                "o1",
                Side::Buy,
                "0.000000000000000001",
                "100",
            ),
        );

        let live = engine.resting_orders(None)[0].to_json();
        assert!(matches!(live.get("price"), Some(Json::String(_))));
        assert!(matches!(live.get("remaining"), Some(Json::String(_))));
        assert_eq!(text(&live, "remaining"), "0.000000000000000001");
    }
}
