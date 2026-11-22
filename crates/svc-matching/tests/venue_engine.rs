//! The venue slice's engine switches, proven with the TypeScript's own tests ported test for test: `halt.test.ts`,
//! `halt-since.test.ts`, `venue-kill.test.ts`, `prelaunch.test.ts`, `expire.test.ts` and the switch parts of
//! `rulebook-refuse.test.ts` (all under `services/svc-matching/src/engine/`). Each test is named after the TypeScript
//! `it` it ports, prefixed with its file's topic.
//!
//! [`MatchingEngine::switch`] is each switch as `index.ts` composes it, outermost first: `cod-fence.ts` on the four
//! halts (two distinct operators; it installs last), `rulebook-refuse.ts` on the halts, the expiry and the delisting
//! (the operator, then the evidence, or a delisting's policy), then the base engine (two distinct operators on every
//! market switch). Most TypeScript files here run another composition (`halt`, `prelaunch` and `expire` the bare
//! engine, `halt-since` and `venue-kill` cod-fence over it, `rulebook-refuse` only its own gate over it), so the port
//! asserts what the composed switch answers, which is not a difference of the Rust:
//!
//! - every switch these tests make carries an evidence ref and a delisting policy ([`cmd`]), which the bare engine
//!   ignores; a refusal the TypeScript asserts for a missing or same confirming operator is then the composed
//!   switch's too (`missing_operator`), and not the evidence or policy gate's;
//! - `rulebook-refuse.test.ts` names one operator where it means to reach the evidence gate of a halt; composed,
//!   cod-fence would refuse that first, so the port adds a distinct confirming operator there. Its single-operator
//!   `haltAll` is accepted in that file; composed it refuses `missing_operator`, so the port asserts that, then halts
//!   the venue with a confirming operator. Its delisting keeps one operator: cod-fence does not wrap `delist`;
//! - `null` and `undefined` entries of `evidenceRefs` are not text and count as no evidence there; `evidence_refs` here
//!   holds only text, so they are dropped (held by the type).
//!
//! The TypeScript replay helpers (`replay`, `replayHaltedMarkets`, `replayHaltedSince`, `replayVenueHalted`,
//! `replayVenueHaltedSince`, `replayPrelaunchMarkets`, `replayExpiredMarkets`, `replayDelistedMarkets`) are the
//! engine's cold start here: a fresh engine on a copy of the journal, recovered, read through `flags`, `halted_since`,
//! `venue_halted_since` and `has_market`. `replayHaltedSince` keeps a market whose first halt time is unreadable with a
//! null time; here that is a halted market whose `halted_since` is none.
//!
//! Not ported:
//! - `rulebook-refuse.test.ts`, "listMarket permissionless refuses; hasMarket false; no invented book": `listMarket`
//!   is an engine call no door reaches, and this slice does not port it.
//! - `reduce-only.test.ts` (8 tests) and `post-only.test.ts` (6 tests): they test the book's reduce-only and post-only
//!   orders, not the market modes, and are already ported test for test in `tests/order_rules.rs` (the book slice).
//!   The market modes' own tests (`reduce-only-market.test.ts`, `post-only-market.test.ts`) are in
//!   `tests/engine_calls.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;

use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::schema::Value;
use service_kit::server::Request;
use service_kit::time::zod_datetime;
use svc_matching::approval::{MISSING_OPERATOR, dual_control_refuse, read_operator_id};
use svc_matching::book::types::{
    AmendResult, CancelReason, EngineAmend, EngineOrder, OrderType, Side, SubmitResult, Tif,
};
use svc_matching::door::book::serve;
use svc_matching::door::{Outcome, ROUTES};
use svc_matching::engine::venue::{
    DELIST_POLICY_MISSING, MISSING_EVIDENCE, Switch, SwitchCmd, SwitchResult,
};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal as _, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const MARKET: &str = "BTC/USDT";
const OTHER: &str = "ETH/USDT";
const REST: &str = "11111111-1111-4111-8111-111111111111";
const TAKER: &str = "22222222-2222-4222-8222-222222222222";
const OTHER_REST: &str = "33333333-3333-4333-8333-333333333333";
const AFTER: &str = "44444444-4444-4444-8444-444444444444";

const MARKET_HALTED: &str = "market_halted";
const VENUE_HALTED: &str = "venue_halted";
const MARKET_PRELAUNCH: &str = "market_prelaunch";
const MARKET_EXPIRED: &str = "market_expired";
const MARKET_DELISTED: &str = "market_delisted";

fn ms(iso: &str) -> i64 {
    zod_datetime(iso, false).unwrap().0
}

// ── the clock ───────────────────────────────────────────────────────────

thread_local! {
    /// `halt-since`'s movable clock; each test runs on its own thread.
    static NOW: Cell<i64> = Cell::new(ms("2026-10-30T10:00:00.000Z"));
}

fn now() -> i64 {
    NOW.with(Cell::get)
}

/// `at(iso)`: move the clock.
fn at(iso: &str) {
    NOW.with(|c| c.set(ms(iso)));
}

// ── engines ─────────────────────────────────────────────────────────────

/// `new MatchingEngine({ journal, bus, snapshotEvery: 0, clock? })`.
fn engine_on(journal: MemoryJournal, clocked: bool) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(MemoryEventBus::default()),
        clock: now,
        expiry_clock: clocked,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    })
}

fn build() -> MatchingEngine {
    engine_on(MemoryJournal::new(), false)
}

fn copy_journal(engine: &MatchingEngine) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in engine.journal().read() {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    journal
}

/// `new MatchingEngine({ journal, bus: new MemoryEventBus(...), snapshotEvery: 0 }).recover()`.
fn reboot(engine: &MatchingEngine) -> MatchingEngine {
    let mut next = engine_on(copy_journal(engine), false);
    next.recover().unwrap();
    next
}

fn jlen(engine: &MatchingEngine) -> usize {
    engine.journal().len()
}

fn last_record(engine: &MatchingEngine) -> Json {
    engine.journal().read().last().unwrap().0.clone()
}

// ── switches ────────────────────────────────────────────────────────────

/// A switch's command as the TypeScript writes it, plus the evidence and delisting policy the composed gate asks.
fn cmd(operator: Option<&str>, confirm: Option<&str>) -> SwitchCmd {
    SwitchCmd {
        operator_id: operator.map(str::to_owned),
        confirm_operator_id: confirm.map(str::to_owned),
        evidence: Some("incident-42".to_owned()),
        policy_id: Some("policy-7".to_owned()),
        ..SwitchCmd::default()
    }
}

/// `{ operatorId: 'ops-1', confirmOperatorId: 'ops-2' }`.
fn ops12() -> SwitchCmd {
    cmd(Some("ops-1"), Some("ops-2"))
}

/// `{ operatorId: 'ops-2', confirmOperatorId: 'ops-3' }`.
fn ops23() -> SwitchCmd {
    cmd(Some("ops-2"), Some("ops-3"))
}

fn sw(engine: &mut MatchingEngine, s: Switch, market: &str, c: &SwitchCmd) -> SwitchResult {
    engine.switch(s, market, c).unwrap()
}

fn code(r: &SwitchResult) -> &str {
    &r.rejected.as_ref().unwrap().code
}

// ── orders ──────────────────────────────────────────────────────────────

fn order(id: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        id,
        "desk",
        OrderType::Limit,
        side,
        parse_amount(qty).unwrap(),
        Some(parse_amount(price).unwrap()),
        Tif::Gtc,
    )
}

fn submit(
    engine: &mut MatchingEngine,
    market: &str,
    id: &str,
    side: Side,
    price: &str,
) -> SubmitResult {
    engine
        .submit(market, &order(id, side, "1", price), None)
        .unwrap()
}

/// `{ orderId, expectedVersion: 1, qty: parseAmount('2') }`.
fn amend_qty_2(engine: &mut MatchingEngine, order_id: &str) -> AmendResult {
    engine
        .amend(
            MARKET,
            &EngineAmend {
                order_id: order_id.to_owned(),
                expected_version: 1,
                qty: Some(parse_amount("2").unwrap()),
                ..EngineAmend::default()
            },
            None,
        )
        .unwrap()
}

fn sub_code(r: &SubmitResult) -> &str {
    &r.rejected.as_ref().unwrap().code
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

fn state(engine: &MatchingEngine) -> Json {
    engine.existing_book(MARKET).unwrap().to_state()
}

/// `engine.book(MARKET).toState().asks[0].orders[0].orderId`.
fn first_ask_id(engine: &MatchingEngine) -> String {
    text(
        &arr(&arr(&state(engine), "asks")[0], "orders")[0],
        "orderId",
    )
}

// ═══ halt.test.ts ═══════════════════════════════════════════════════════

mod halt {
    use super::*;

    #[test]
    fn halt_refuses_a_new_submit_on_the_halted_market_and_journals_nothing_for_that_submit() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        let halt = sw(&mut engine, Switch::Halt, MARKET, &ops12());

        assert!(halt.accepted);
        assert!(halt.state);
        assert_eq!(halt.operator_id.as_deref(), Some("ops-1"));
        assert_eq!(halt.confirm_operator_id, Some(Some("ops-2".to_owned())));
        assert!(engine.flags(MARKET).halted);
        let record = last_record(&engine);
        assert_eq!(text(&record, "kind"), "halt");
        assert_eq!(text(&record, "marketId"), MARKET);
        assert_eq!(text(&record, "operatorId"), "ops-1");
        assert_eq!(text(&record, "confirmOperatorId"), "ops-2");

        let before = jlen(&engine);
        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");

        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_HALTED);
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
        assert_eq!(first_ask_id(&engine), REST);
    }

    #[test]
    fn halt_leaves_another_market_open() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());

        let result = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");

        assert!(result.accepted);
        assert!(!engine.flags(OTHER).halted);
        assert!(engine.flags(MARKET).halted);
    }

    #[test]
    fn halt_still_cancels_while_halted() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "asks").is_empty());
    }

    #[test]
    fn halt_resumes_only_after_an_explicit_resume_halt_never_expires() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);

        let resume = sw(&mut engine, Switch::Resume, MARKET, &ops23());
        assert!(resume.accepted);
        assert!(!resume.state);
        assert!(!engine.flags(MARKET).halted);

        let result = submit(&mut engine, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn halt_refuses_halt_and_resume_without_an_operator_does_not_invent_a_caller() {
        let mut engine = build();
        let halt = sw(&mut engine, Switch::Halt, MARKET, &SwitchCmd::default());
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), 0);

        let blank = sw(&mut engine, Switch::Halt, MARKET, &cmd(Some("   "), None));
        assert!(!blank.accepted);
        assert_eq!(code(&blank), MISSING_OPERATOR);

        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        let resume = sw(&mut engine, Switch::Resume, MARKET, &cmd(None, None));
        assert!(!resume.accepted);
        assert_eq!(code(&resume), MISSING_OPERATOR);
        assert!(engine.flags(MARKET).halted);
    }

    #[test]
    fn halt_does_not_halt_every_market_the_process_kill_switch_is_a_different_door() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        assert!(engine.is_enabled());
        assert!(!engine.flags(OTHER).halted);
    }

    #[test]
    fn halt_replays_halt_so_a_recovered_engine_still_refuses_submits() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).halted);
        assert!(recovered.has_market(MARKET));

        let result = submit(&mut recovered, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_HALTED);
    }

    #[test]
    fn halt_refuses_amend_on_a_halted_market_without_journaling() {
        let mut engine = build();
        let rest = submit(&mut engine, MARKET, REST, Side::Sell, "100");
        assert!(rest.accepted);
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        let before = jlen(&engine);

        let amended = amend_qty_2(&mut engine, REST);

        assert!(!amended.accepted);
        assert_eq!(amended.rejected.as_ref().unwrap().code, MARKET_HALTED);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn halt_replay_of_halt_then_resume_leaves_the_market_open() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::Resume, MARKET, &ops23());

        let mut recovered = reboot(&engine);
        assert!(!recovered.flags(MARKET).halted);

        let result = submit(&mut recovered, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn halt_dual_control_refuses_halt_when_confirm_operator_id_is_missing_no_journal() {
        let mut engine = build();
        let halt = sw(&mut engine, Switch::Halt, MARKET, &cmd(Some("ops-1"), None));
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn halt_dual_control_refuses_halt_when_confirm_operator_id_is_the_same_caller_no_journal() {
        let mut engine = build();
        let halt = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &cmd(Some("ops-1"), Some("ops-1")),
        );
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn halt_dual_control_refuses_resume_when_confirm_is_missing_or_the_same_leaves_the_halt() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        let before = jlen(&engine);

        let missing = sw(
            &mut engine,
            Switch::Resume,
            MARKET,
            &cmd(Some("ops-2"), None),
        );
        assert!(!missing.accepted);
        assert_eq!(code(&missing), MISSING_OPERATOR);
        assert!(engine.flags(MARKET).halted);

        let same = sw(
            &mut engine,
            Switch::Resume,
            MARKET,
            &cmd(Some("ops-2"), Some("ops-2")),
        );
        assert!(!same.accepted);
        assert!(engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn halt_dual_control_refuse_refuses_unset_or_same_operator_ids() {
        let c = |a: Option<&str>, b: Option<&str>| dual_control_refuse(a, b).map(|r| r.code);
        assert_eq!(c(None, Some("ops-2")).as_deref(), Some(MISSING_OPERATOR));
        assert_eq!(c(Some("ops-1"), None).as_deref(), Some(MISSING_OPERATOR));
        assert_eq!(
            c(Some("ops-1"), Some("ops-1")).as_deref(),
            Some(MISSING_OPERATOR)
        );
        assert_eq!(c(Some("ops-1"), Some("ops-2")), None);
        // `readConfirmOperatorId` is the same reader as the operator's here.
        assert_eq!(read_operator_id(None), None);
        assert_eq!(
            read_operator_id(Some("  ops-2  ")).as_deref(),
            Some("ops-2")
        );
    }

    #[test]
    fn halt_dual_control_refuse_refuses_a_blank_or_whitespace_only_id_when_the_caller_skipped_the_readers()
     {
        let c = |a: &str, b: &str| dual_control_refuse(Some(a), Some(b)).map(|r| r.code);
        for (a, b) in [
            ("", "ops-2"),
            (" ", "ops-2"),
            ("\t", "ops-2"),
            ("ops-1", ""),
            ("ops-1", "   "),
            ("   ", "   "),
            ("ops-1", "ops-1"),
            (" ops-1 ", "ops-1"),
        ] {
            assert_eq!(c(a, b).as_deref(), Some(MISSING_OPERATOR), "{a:?} {b:?}");
        }
        assert_eq!(c("ops-1", "ops-2"), None);
        assert_eq!(c(" ops-1 ", " ops-2 "), None);
    }
}

// ═══ halt-since.test.ts ═════════════════════════════════════════════════

mod halt_since {
    use super::*;

    fn build_clocked() -> MatchingEngine {
        at("2026-10-30T10:00:00.000Z");
        engine_on(MemoryJournal::new(), true)
    }

    #[test]
    fn halt_since_a_market_halt_records_its_start_a_repeat_halt_keeps_the_first_a_resume_clears_it()
    {
        let mut engine = build_clocked();
        assert_eq!(engine.halted_since(MARKET), None);
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        assert_eq!(
            engine.halted_since(MARKET).as_deref(),
            Some("2026-10-30T10:00:00.000Z")
        );
        at("2026-10-30T10:05:00.000Z");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        assert_eq!(
            engine.halted_since(MARKET).as_deref(),
            Some("2026-10-30T10:00:00.000Z")
        );
        assert_eq!(engine.halted_since(OTHER), None);
        sw(&mut engine, Switch::Resume, MARKET, &ops12());
        assert_eq!(engine.halted_since(MARKET), None);
        at("2026-10-30T11:00:00.000Z");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        assert_eq!(
            engine.halted_since(MARKET).as_deref(),
            Some("2026-10-30T11:00:00.000Z")
        );
    }

    #[test]
    fn halt_since_a_refused_halt_no_second_operator_records_no_start() {
        let mut engine = build_clocked();
        let refused = sw(&mut engine, Switch::Halt, MARKET, &cmd(Some("ops-1"), None));
        assert!(!refused.accepted);
        assert_eq!(engine.halted_since(MARKET), None);
    }

    #[test]
    fn halt_since_the_venue_halt_records_its_start_the_same_way() {
        let mut engine = build_clocked();
        assert_eq!(engine.venue_halted_since(), None);
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        at("2026-10-30T10:07:00.000Z");
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        assert_eq!(
            engine.venue_halted_since().as_deref(),
            Some("2026-10-30T10:00:00.000Z")
        );
        sw(&mut engine, Switch::ResumeAll, "", &ops12());
        assert_eq!(engine.venue_halted_since(), None);
    }

    #[test]
    fn halt_since_a_recovered_engine_keeps_each_start_from_the_journal() {
        let mut engine = build_clocked();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        at("2026-10-30T10:03:00.000Z");
        sw(&mut engine, Switch::Halt, OTHER, &ops12());
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        at("2026-10-30T10:04:00.000Z");
        sw(&mut engine, Switch::Resume, OTHER, &ops12());

        let recovered = reboot(&engine);
        assert_eq!(
            recovered.halted_since(MARKET).as_deref(),
            Some("2026-10-30T10:00:00.000Z")
        );
        assert_eq!(recovered.halted_since(OTHER), None);
        assert!(!recovered.flags(OTHER).halted);
        assert_eq!(
            recovered.venue_halted_since().as_deref(),
            Some("2026-10-30T10:03:00.000Z")
        );
    }

    #[test]
    fn halt_since_replay_keeps_the_first_halt_even_when_its_time_is_unreadable_as_the_live_engine_does()
     {
        let mut journal = MemoryJournal::new();
        for record in [
            Json::obj([
                ("kind", Json::str("halt")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("")),
            ]),
            Json::obj([
                ("kind", Json::str("halt")),
                ("marketId", Json::str(MARKET)),
                ("at", Json::str("2026-10-30T10:09:00.000Z")),
            ]),
            Json::obj([("kind", Json::str("halt_all")), ("at", Json::str(""))]),
            Json::obj([
                ("kind", Json::str("halt_all")),
                ("at", Json::str("2026-10-30T10:09:00.000Z")),
            ]),
        ] {
            journal.append(&JournalCommand(record)).unwrap();
        }
        let mut recovered = engine_on(journal, false);
        recovered.recover().unwrap();

        // `[[MARKET, null]]`: the market is halted and its start stays unknown.
        assert!(recovered.flags(MARKET).halted);
        assert_eq!(recovered.halted_since(MARKET), None);
        assert!(!recovered.flags(OTHER).halted);
        assert!(recovered.flags(MARKET).venue_halted);
        assert_eq!(recovered.venue_halted_since(), None);
    }

    /// What `GET /markets` answers, past the caller check.
    fn markets_door(engine: &mut MatchingEngine) -> Json {
        let route = ROUTES
            .iter()
            .find(|r| r.method == "GET" && r.path == "/markets")
            .unwrap();
        let req = Request {
            method: "GET",
            url: "/markets",
            headers: &[],
            body: "",
        };
        match serve(route, &req, &|_| String::new(), &Value::Undefined, engine) {
            Outcome::Answer(r) => {
                assert_eq!(r.status, 200, "{}", r.body);
                json::parse(&r.body).unwrap()
            }
            Outcome::Owed(s) => panic!("owed by {}", s.name()),
        }
    }

    #[test]
    fn halt_since_the_public_market_list_serves_each_halted_markets_start_and_the_venues() {
        let mut engine = build_clocked();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");

        let open = markets_door(&mut engine);
        assert_eq!(open.get("halted").unwrap().compact(), "[]");
        assert_eq!(open.get("haltedSince").unwrap().compact(), "{}");
        assert_eq!(open.get("venueHalted"), Some(&Json::Bool(false)));
        assert_eq!(open.get("venueHaltedSince"), Some(&Json::Null));

        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let halted = markets_door(&mut engine);
        assert_eq!(halted.get("halted").unwrap().compact(), r#"["BTC/USDT"]"#);
        assert_eq!(
            halted.get("haltedSince").unwrap().compact(),
            r#"{"BTC/USDT":"2026-10-30T10:00:00.000Z"}"#
        );
        assert_eq!(halted.get("venueHalted"), Some(&Json::Bool(true)));
        assert_eq!(
            text(&halted, "venueHaltedSince"),
            "2026-10-30T10:00:00.000Z"
        );
    }
}

// ═══ venue-kill.test.ts ═════════════════════════════════════════════════

mod venue_kill {
    use super::*;

    fn venue_halted(engine: &MatchingEngine) -> bool {
        engine.flags(MARKET).venue_halted
    }

    #[test]
    fn venue_kill_refuses_a_new_submit_on_every_market_and_journals_nothing_for_that_submit() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        let halt = sw(&mut engine, Switch::HaltAll, "", &ops12());

        assert!(halt.accepted);
        assert!(halt.state);
        assert_eq!(halt.operator_id.as_deref(), Some("ops-1"));
        assert!(venue_halted(&engine));
        assert!(!engine.flags(MARKET).halted);
        let record = last_record(&engine);
        assert_eq!(text(&record, "kind"), "halt_all");
        assert!(record.get("marketId").is_none());
        assert_eq!(text(&record, "operatorId"), "ops-1");
        assert_eq!(text(&record, "confirmOperatorId"), "ops-2");

        let before = jlen(&engine);
        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        let other = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");

        assert!(!result.accepted);
        assert_eq!(sub_code(&result), VENUE_HALTED);
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert!(!other.accepted);
        assert_eq!(sub_code(&other), VENUE_HALTED);
        assert_eq!(jlen(&engine), before);
        assert_eq!(first_ask_id(&engine), REST);
    }

    #[test]
    fn venue_kill_is_not_one_market_halt_resume_of_one_market_does_not_reopen_submits() {
        let mut engine = build();
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let resume_one = sw(&mut engine, Switch::Resume, MARKET, &ops23());
        assert!(resume_one.accepted);
        assert!(venue_halted(&engine));

        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), VENUE_HALTED);
    }

    #[test]
    fn venue_kill_still_cancels_while_halted() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::HaltAll, "", &ops12());

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "asks").is_empty());
    }

    #[test]
    fn venue_kill_resumes_only_after_an_explicit_resume_all_halt_all_never_expires() {
        let mut engine = build();
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);

        let resume = sw(&mut engine, Switch::ResumeAll, "", &ops23());
        assert!(resume.accepted);
        assert!(!resume.state);
        assert!(!venue_halted(&engine));

        let result = submit(&mut engine, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn venue_kill_resume_all_does_not_clear_a_one_market_halt() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        sw(&mut engine, Switch::ResumeAll, "", &ops23());

        assert!(!venue_halted(&engine));
        assert!(engine.flags(MARKET).halted);

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_HALTED);

        let other = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");
        assert!(other.accepted);
    }

    #[test]
    fn venue_kill_refuses_halt_all_and_resume_all_without_an_operator_does_not_invent_a_caller() {
        let mut engine = build();
        let halt = sw(&mut engine, Switch::HaltAll, "", &SwitchCmd::default());
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!venue_halted(&engine));
        assert_eq!(jlen(&engine), 0);

        let blank = sw(&mut engine, Switch::HaltAll, "", &cmd(Some("   "), None));
        assert!(!blank.accepted);
        assert_eq!(code(&blank), MISSING_OPERATOR);

        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let resume = sw(&mut engine, Switch::ResumeAll, "", &cmd(None, None));
        assert!(!resume.accepted);
        assert_eq!(code(&resume), MISSING_OPERATOR);
        assert!(venue_halted(&engine));
    }

    #[test]
    fn venue_kill_does_not_disable_the_engine_the_process_kill_switch_is_a_different_door() {
        let mut engine = build();
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        assert!(engine.is_enabled());
    }

    #[test]
    fn venue_kill_replays_halt_all_so_a_recovered_engine_still_refuses_submits() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::HaltAll, "", &ops12());

        let mut recovered = reboot(&engine);

        assert!(venue_halted(&recovered));
        assert!(!recovered.flags(MARKET).halted);
        assert!(recovered.has_market(MARKET));

        let result = submit(&mut recovered, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), VENUE_HALTED);
    }

    #[test]
    fn venue_kill_refuses_amend_on_a_venue_halted_engine_without_journaling() {
        let mut engine = build();
        let rest = submit(&mut engine, MARKET, REST, Side::Sell, "100");
        assert!(rest.accepted);
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let before = jlen(&engine);

        let amended = amend_qty_2(&mut engine, REST);

        assert!(!amended.accepted);
        assert_eq!(amended.rejected.as_ref().unwrap().code, VENUE_HALTED);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn venue_kill_replay_of_halt_all_then_resume_all_leaves_markets_open() {
        let mut engine = build();
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        sw(&mut engine, Switch::ResumeAll, "", &ops23());

        let mut recovered = reboot(&engine);
        assert!(!venue_halted(&recovered));

        let result = submit(&mut recovered, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn venue_kill_dual_control_refuses_halt_all_when_confirm_operator_id_is_missing_no_journal() {
        let mut engine = build();
        let halt = sw(&mut engine, Switch::HaltAll, "", &cmd(Some("ops-1"), None));
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!venue_halted(&engine));
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn venue_kill_dual_control_refuses_halt_all_when_confirm_operator_id_is_the_same_caller_no_journal()
     {
        let mut engine = build();
        let halt = sw(
            &mut engine,
            Switch::HaltAll,
            "",
            &cmd(Some("ops-1"), Some("ops-1")),
        );
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!venue_halted(&engine));
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn venue_kill_dual_control_refuses_resume_all_when_confirm_is_missing_or_the_same_leaves_the_halt()
     {
        let mut engine = build();
        sw(&mut engine, Switch::HaltAll, "", &ops12());
        let before = jlen(&engine);

        let missing = sw(
            &mut engine,
            Switch::ResumeAll,
            "",
            &cmd(Some("ops-2"), None),
        );
        assert!(!missing.accepted);
        assert_eq!(code(&missing), MISSING_OPERATOR);
        assert!(venue_halted(&engine));

        let same = sw(
            &mut engine,
            Switch::ResumeAll,
            "",
            &cmd(Some("ops-2"), Some("ops-2")),
        );
        assert!(!same.accepted);
        assert!(venue_halted(&engine));
        assert_eq!(jlen(&engine), before);
    }
}

// ═══ prelaunch.test.ts ══════════════════════════════════════════════════

mod prelaunch {
    use super::*;

    #[test]
    fn prelaunch_refuses_a_public_submit_until_open_and_journals_nothing_for_that_submit() {
        let mut engine = build();
        let mode = sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());

        assert!(mode.accepted);
        assert!(mode.state);
        assert_eq!(mode.operator_id.as_deref(), Some("ops-1"));
        assert!(engine.flags(MARKET).prelaunch);
        assert!(!engine.flags(MARKET).halted);

        let before = jlen(&engine);
        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");

        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_PRELAUNCH);
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
        assert!(!engine.has_market(MARKET));
    }

    #[test]
    fn prelaunch_leaves_another_market_open() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());

        let result = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");

        assert!(result.accepted);
        assert!(!engine.flags(OTHER).prelaunch);
        assert!(engine.flags(MARKET).prelaunch);
    }

    #[test]
    fn prelaunch_cancel_of_nothing_is_a_no_op_does_not_invent_a_market_or_journal() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let before = jlen(&engine);

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(!cancelled.cancelled);
        assert_eq!(cancelled.sequence, None);
        assert!(!engine.has_market(MARKET));
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn prelaunch_mass_cancel_of_nothing_is_empty_not_an_error() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let before = jlen(&engine);

        let result = engine.mass_cancel(MARKET, "desk", None, None).unwrap();

        assert!(result.accepted);
        assert!(result.cancellations.is_empty());
        assert!(!engine.has_market(MARKET));
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn prelaunch_opens_only_after_an_explicit_open_prelaunch_never_expires() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);

        let opened = sw(&mut engine, Switch::Open, MARKET, &ops23());
        assert!(opened.accepted);
        assert!(!opened.state);
        assert!(!engine.flags(MARKET).prelaunch);

        let result = submit(&mut engine, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn prelaunch_is_not_halt_halt_still_uses_market_halted_and_open_does_not_clear_it() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_HALTED);

        sw(&mut engine, Switch::Open, MARKET, &ops23());
        assert!(!engine.flags(MARKET).prelaunch);
        assert!(engine.flags(MARKET).halted);

        let still = submit(&mut engine, MARKET, AFTER, Side::Buy, "100");
        assert!(!still.accepted);
        assert_eq!(sub_code(&still), MARKET_HALTED);
    }

    #[test]
    fn prelaunch_resume_of_halt_does_not_clear_prelaunch() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::Resume, MARKET, &ops23());

        assert!(!engine.flags(MARKET).halted);
        assert!(engine.flags(MARKET).prelaunch);

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_PRELAUNCH);
    }

    #[test]
    fn prelaunch_refuses_prelaunch_and_open_without_an_operator_does_not_invent_a_caller() {
        let mut engine = build();
        let mode = sw(
            &mut engine,
            Switch::Prelaunch,
            MARKET,
            &SwitchCmd::default(),
        );
        assert!(!mode.accepted);
        assert_eq!(code(&mode), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).prelaunch);
        assert_eq!(jlen(&engine), 0);

        let blank = sw(
            &mut engine,
            Switch::Prelaunch,
            MARKET,
            &cmd(Some("   "), None),
        );
        assert!(!blank.accepted);
        assert_eq!(code(&blank), MISSING_OPERATOR);

        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let opened = sw(&mut engine, Switch::Open, MARKET, &cmd(None, None));
        assert!(!opened.accepted);
        assert_eq!(code(&opened), MISSING_OPERATOR);
        assert!(engine.flags(MARKET).prelaunch);
    }

    #[test]
    fn prelaunch_does_not_disable_the_engine_the_process_kill_switch_is_a_different_door() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        assert!(engine.is_enabled());
        assert!(!engine.flags(OTHER).prelaunch);
        assert!(!engine.flags(MARKET).halted);
    }

    #[test]
    fn prelaunch_replays_prelaunch_so_a_recovered_engine_still_refuses_public_submits() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).prelaunch);
        assert!(!recovered.has_market(MARKET));

        let result = submit(&mut recovered, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_PRELAUNCH);
    }

    #[test]
    fn prelaunch_refuses_amend_on_a_prelaunch_market_without_journaling() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let before = jlen(&engine);

        let amended = amend_qty_2(&mut engine, REST);

        assert!(!amended.accepted);
        assert_eq!(amended.rejected.as_ref().unwrap().code, MARKET_PRELAUNCH);
        assert_eq!(jlen(&engine), before);
        assert!(!engine.has_market(MARKET));
    }

    #[test]
    fn prelaunch_replay_of_prelaunch_then_open_leaves_the_market_accepting_public_submits() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        sw(&mut engine, Switch::Open, MARKET, &ops23());

        let mut recovered = reboot(&engine);
        assert!(!recovered.flags(MARKET).prelaunch);

        let result = submit(&mut recovered, MARKET, AFTER, Side::Sell, "100");
        assert!(result.accepted);
    }

    #[test]
    fn prelaunch_dual_control_refuses_prelaunch_when_confirm_operator_id_is_missing_no_journal() {
        let mut engine = build();
        let mode = sw(
            &mut engine,
            Switch::Prelaunch,
            MARKET,
            &cmd(Some("ops-1"), None),
        );
        assert!(!mode.accepted);
        assert_eq!(code(&mode), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).prelaunch);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn prelaunch_dual_control_refuses_prelaunch_when_confirm_operator_id_is_the_same_caller_no_journal()
     {
        let mut engine = build();
        let mode = sw(
            &mut engine,
            Switch::Prelaunch,
            MARKET,
            &cmd(Some("ops-1"), Some("ops-1")),
        );
        assert!(!mode.accepted);
        assert_eq!(code(&mode), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).prelaunch);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn prelaunch_dual_control_refuses_open_when_confirm_is_missing_or_the_same_leaves_prelaunch() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        let before = jlen(&engine);

        let missing = sw(&mut engine, Switch::Open, MARKET, &cmd(Some("ops-2"), None));
        assert!(!missing.accepted);
        assert_eq!(code(&missing), MISSING_OPERATOR);
        assert!(engine.flags(MARKET).prelaunch);

        let same = sw(
            &mut engine,
            Switch::Open,
            MARKET,
            &cmd(Some("ops-2"), Some("ops-2")),
        );
        assert!(!same.accepted);
        assert!(engine.flags(MARKET).prelaunch);
        assert_eq!(jlen(&engine), before);
    }
}

// ═══ expire.test.ts ═════════════════════════════════════════════════════

mod expire {
    use super::*;

    #[test]
    fn expire_refuses_a_new_submit_on_the_expired_market_and_journals_nothing_for_that_submit() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        let expired = sw(&mut engine, Switch::Expire, MARKET, &ops12());

        assert!(expired.accepted);
        assert!(expired.state);
        assert_eq!(expired.operator_id.as_deref(), Some("ops-1"));
        let flags = engine.flags(MARKET);
        assert!(flags.expired);
        assert!(!flags.halted);
        assert!(!flags.prelaunch);
        assert!(!flags.delisted);

        let before = jlen(&engine);
        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");

        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_EXPIRED);
        assert_eq!(result.sequence, None);
        assert!(result.fills.is_empty());
        assert_eq!(jlen(&engine), before);
        assert_eq!(first_ask_id(&engine), REST);
    }

    #[test]
    fn expire_leaves_another_market_open() {
        let mut engine = build();
        sw(&mut engine, Switch::Expire, MARKET, &ops12());

        let result = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");

        assert!(result.accepted);
        assert!(!engine.flags(OTHER).expired);
        assert!(engine.flags(MARKET).expired);
    }

    #[test]
    fn expire_still_cancels_while_expired() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Expire, MARKET, &ops12());

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "asks").is_empty());
    }

    #[test]
    fn expire_is_not_halt_resume_of_halt_does_not_reopen_an_expired_market() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::Expire, MARKET, &ops12());
        sw(&mut engine, Switch::Resume, MARKET, &ops23());

        assert!(!engine.flags(MARKET).halted);
        assert!(engine.flags(MARKET).expired);

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_EXPIRED);
    }

    #[test]
    fn expire_is_not_prelaunch_open_does_not_clear_expire() {
        let mut engine = build();
        sw(&mut engine, Switch::Prelaunch, MARKET, &ops12());
        sw(&mut engine, Switch::Expire, MARKET, &ops12());
        sw(&mut engine, Switch::Open, MARKET, &ops23());

        assert!(!engine.flags(MARKET).prelaunch);
        assert!(engine.flags(MARKET).expired);

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_EXPIRED);
        assert_ne!(sub_code(&blocked), MARKET_PRELAUNCH);
        assert_ne!(sub_code(&blocked), MARKET_HALTED);
    }

    #[test]
    fn expire_refuses_expire_without_an_operator_does_not_invent_a_caller() {
        let mut engine = build();
        let expired = sw(&mut engine, Switch::Expire, MARKET, &SwitchCmd::default());
        assert!(!expired.accepted);
        assert_eq!(code(&expired), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).expired);
        assert_eq!(jlen(&engine), 0);

        let blank = sw(&mut engine, Switch::Expire, MARKET, &cmd(Some("   "), None));
        assert!(!blank.accepted);
        assert_eq!(code(&blank), MISSING_OPERATOR);
    }

    #[test]
    fn expire_does_not_disable_the_engine_the_process_kill_switch_is_a_different_door() {
        let mut engine = build();
        sw(&mut engine, Switch::Expire, MARKET, &ops12());
        assert!(engine.is_enabled());
        assert!(!engine.flags(OTHER).expired);
    }

    #[test]
    fn expire_replays_expire_so_a_recovered_engine_still_refuses_submits() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Expire, MARKET, &ops12());

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).expired);
        assert!(recovered.has_market(MARKET));

        let result = submit(&mut recovered, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_EXPIRED);
    }

    #[test]
    fn expire_refuses_amend_on_an_expired_market_without_journaling() {
        let mut engine = build();
        let rest = submit(&mut engine, MARKET, REST, Side::Sell, "100");
        assert!(rest.accepted);
        sw(&mut engine, Switch::Expire, MARKET, &ops12());
        let before = jlen(&engine);

        let amended = amend_qty_2(&mut engine, REST);

        assert!(!amended.accepted);
        assert_eq!(amended.rejected.as_ref().unwrap().code, MARKET_EXPIRED);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn expire_delist_refuses_a_new_submit_on_the_delisted_market_and_journals_nothing_for_that_submit()
     {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        let delisted = sw(&mut engine, Switch::Delist, MARKET, &ops12());

        assert!(delisted.accepted);
        assert!(delisted.state);
        assert_eq!(delisted.operator_id.as_deref(), Some("ops-1"));
        let flags = engine.flags(MARKET);
        assert!(flags.delisted);
        assert!(!flags.expired);
        assert!(!flags.halted);

        let before = jlen(&engine);
        let result = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");

        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_DELISTED);
        assert_eq!(result.sequence, None);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn expire_delist_still_cancels_while_delisted() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Delist, MARKET, &ops12());

        let cancelled = engine
            .cancel(MARKET, REST, CancelReason::Requested)
            .unwrap();

        assert!(cancelled.cancelled);
        assert!(arr(&state(&engine), "asks").is_empty());
    }

    #[test]
    fn expire_delist_leaves_another_market_open() {
        let mut engine = build();
        sw(&mut engine, Switch::Delist, MARKET, &ops12());

        let result = submit(&mut engine, OTHER, OTHER_REST, Side::Sell, "200");
        assert!(result.accepted);
        assert!(!engine.flags(OTHER).delisted);
    }

    #[test]
    fn expire_delist_is_not_expire_expire_refuse_code_stays_market_expired() {
        let mut engine = build();
        sw(&mut engine, Switch::Expire, MARKET, &ops12());

        let blocked = submit(&mut engine, MARKET, TAKER, Side::Buy, "100");
        assert_eq!(sub_code(&blocked), MARKET_EXPIRED);
        assert_ne!(sub_code(&blocked), MARKET_DELISTED);
    }

    #[test]
    fn expire_delist_is_not_halt_resume_of_halt_does_not_reopen_a_delisted_market() {
        let mut engine = build();
        sw(&mut engine, Switch::Halt, MARKET, &ops12());
        sw(&mut engine, Switch::Delist, MARKET, &ops12());
        sw(&mut engine, Switch::Resume, MARKET, &ops23());

        let blocked = submit(&mut engine, MARKET, AFTER, Side::Sell, "100");
        assert!(!blocked.accepted);
        assert_eq!(sub_code(&blocked), MARKET_DELISTED);
    }

    #[test]
    fn expire_delist_refuses_delist_without_an_operator_does_not_invent_a_caller() {
        let mut engine = build();
        let delisted = sw(&mut engine, Switch::Delist, MARKET, &SwitchCmd::default());
        assert!(!delisted.accepted);
        assert_eq!(code(&delisted), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).delisted);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn expire_delist_replays_delist_so_a_recovered_engine_still_refuses_submits() {
        let mut engine = build();
        sw(&mut engine, Switch::Delist, MARKET, &ops12());

        let mut recovered = reboot(&engine);

        assert!(recovered.flags(MARKET).delisted);

        let result = submit(&mut recovered, MARKET, TAKER, Side::Buy, "100");
        assert!(!result.accepted);
        assert_eq!(sub_code(&result), MARKET_DELISTED);
    }

    #[test]
    fn expire_delist_refuses_amend_on_a_delisted_market_without_journaling() {
        let mut engine = build();
        submit(&mut engine, MARKET, REST, Side::Sell, "100");
        sw(&mut engine, Switch::Delist, MARKET, &ops12());
        let before = jlen(&engine);

        let amended = amend_qty_2(&mut engine, REST);

        assert!(!amended.accepted);
        assert_eq!(amended.rejected.as_ref().unwrap().code, MARKET_DELISTED);
        assert_eq!(jlen(&engine), before);
    }

    #[test]
    fn expire_dual_control_refuses_expire_when_confirm_operator_id_is_missing_no_journal() {
        let mut engine = build();
        let expired = sw(
            &mut engine,
            Switch::Expire,
            MARKET,
            &cmd(Some("ops-1"), None),
        );
        assert!(!expired.accepted);
        assert_eq!(code(&expired), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).expired);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn expire_dual_control_refuses_expire_when_confirm_operator_id_is_the_same_caller_no_journal() {
        let mut engine = build();
        let expired = sw(
            &mut engine,
            Switch::Expire,
            MARKET,
            &cmd(Some("ops-1"), Some("ops-1")),
        );
        assert!(!expired.accepted);
        assert_eq!(code(&expired), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).expired);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn expire_dual_control_refuses_delist_when_confirm_is_missing_or_the_same_no_journal() {
        let mut engine = build();
        let missing = sw(
            &mut engine,
            Switch::Delist,
            MARKET,
            &cmd(Some("ops-1"), None),
        );
        assert!(!missing.accepted);
        assert_eq!(code(&missing), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).delisted);

        let same = sw(
            &mut engine,
            Switch::Delist,
            MARKET,
            &cmd(Some("ops-1"), Some("ops-1")),
        );
        assert!(!same.accepted);
        assert!(!engine.flags(MARKET).delisted);
        assert_eq!(jlen(&engine), 0);
    }
}

// ═══ rulebook-refuse.test.ts (the switches) ═════════════════════════════

mod rulebook_refuse {
    use super::*;

    /// A command as the TypeScript writes it, with nothing added.
    fn bare(operator: Option<&str>, confirm: Option<&str>) -> SwitchCmd {
        SwitchCmd {
            operator_id: operator.map(str::to_owned),
            confirm_operator_id: confirm.map(str::to_owned),
            ..SwitchCmd::default()
        }
    }

    fn with_refs(mut c: SwitchCmd, refs: &[&str]) -> SwitchCmd {
        c.evidence_refs = refs.iter().map(|r| (*r).to_owned()).collect();
        c
    }

    fn with_evidence(mut c: SwitchCmd, evidence: &str) -> SwitchCmd {
        c.evidence = Some(evidence.to_owned());
        c
    }

    /// `['', '   ', '\t', '\n', null, undefined]`, its text entries.
    const BLANK_REFS: [&str; 4] = ["", "   ", "\t", "\n"];

    #[test]
    fn rulebook_refuse_halt_without_evidence_refuses_market_not_halted() {
        let mut engine = build();
        // `{ operatorId: 'ops-1' }`, with the confirming operator cod-fence asks first.
        let halt = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &bare(Some("ops-1"), Some("ops-2")),
        );
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_EVIDENCE);
        assert_eq!(
            halt.rejected.as_ref().unwrap().message,
            "emergency action requires authority and evidence; the engine does not invent evidence"
        );
        assert!(!engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn rulebook_refuse_halt_with_operator_and_evidence_applies() {
        let mut engine = build();
        let halt_cmd = with_evidence(bare(Some("ops-1"), Some("ops-2")), "incident-42");
        let halt = sw(&mut engine, Switch::Halt, MARKET, &halt_cmd);
        assert!(halt.accepted);
        assert!(halt.state);
        assert_eq!(halt.operator_id.as_deref(), Some("ops-1"));
        assert!(engine.flags(MARKET).halted);

        let resume_cmd = with_refs(bare(Some("ops-2"), Some("ops-3")), &["ref-1"]);
        let resume = sw(&mut engine, Switch::Resume, MARKET, &resume_cmd);
        assert!(resume.accepted);
        assert!(!engine.flags(MARKET).halted);
    }

    #[test]
    fn rulebook_refuse_delist_without_policy_refuses() {
        let mut engine = build();
        let delisted = sw(
            &mut engine,
            Switch::Delist,
            MARKET,
            &bare(Some("ops-1"), None),
        );
        assert!(!delisted.accepted);
        assert_eq!(code(&delisted), DELIST_POLICY_MISSING);
        assert_eq!(
            delisted.rejected.as_ref().unwrap().message,
            "delist requires an owner policy; the engine does not invent a corporate action"
        );
        assert!(!engine.flags(MARKET).delisted);
        assert_eq!(jlen(&engine), 0);
    }

    #[test]
    fn rulebook_refuse_delist_with_operator_and_policy_id_applies() {
        let mut engine = build();
        let mut delist_cmd = bare(Some("ops-1"), Some("ops-2"));
        delist_cmd.policy_id = Some("policy-7".to_owned());
        let delisted = sw(&mut engine, Switch::Delist, MARKET, &delist_cmd);
        assert!(delisted.accepted);
        assert!(delisted.state);
        assert!(engine.flags(MARKET).delisted);
    }

    #[test]
    fn rulebook_refuse_blank_evidence_refs_are_not_evidence_and_do_not_change_the_halt() {
        let mut engine = build();
        let venue = |e: &MatchingEngine| e.flags(MARKET).venue_halted;

        let halt_blank = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &with_refs(
                with_evidence(bare(Some("ops-1"), Some("ops-2")), "   "),
                &BLANK_REFS,
            ),
        );
        assert!(!halt_blank.accepted);
        assert_eq!(code(&halt_blank), MISSING_EVIDENCE);
        assert!(!engine.flags(MARKET).halted);

        let halt_all_blank = sw(
            &mut engine,
            Switch::HaltAll,
            "",
            &with_refs(bare(Some("ops-1"), Some("ops-2")), &BLANK_REFS),
        );
        assert!(!halt_all_blank.accepted);
        assert_eq!(code(&halt_all_blank), MISSING_EVIDENCE);
        assert!(!venue(&engine));

        let expire_blank = sw(
            &mut engine,
            Switch::Expire,
            MARKET,
            &with_refs(bare(Some("ops-1"), Some("ops-2")), &BLANK_REFS),
        );
        assert!(!expire_blank.accepted);
        assert_eq!(code(&expire_blank), MISSING_EVIDENCE);
        assert!(!engine.flags(MARKET).expired);
        assert!(!engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), 0);

        let halt = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &with_evidence(bare(Some("ops-1"), Some("ops-2")), "incident-42"),
        );
        assert!(halt.accepted);
        assert!(engine.flags(MARKET).halted);
        let halted_length = jlen(&engine);

        let resume_blank = sw(
            &mut engine,
            Switch::Resume,
            MARKET,
            &with_refs(bare(Some("ops-2"), Some("ops-3")), &BLANK_REFS),
        );
        assert!(!resume_blank.accepted);
        assert_eq!(code(&resume_blank), MISSING_EVIDENCE);
        assert!(resume_blank.state);
        assert!(engine.flags(MARKET).halted);
        assert_eq!(jlen(&engine), halted_length);

        // `{ operatorId: 'ops-1', evidenceRefs: ['', '  venue-ticket  ', null] }`: accepted by the TypeScript file's
        // engine, which has no cod-fence; composed, cod-fence asks a second operator first.
        let one_operator = sw(
            &mut engine,
            Switch::HaltAll,
            "",
            &with_refs(bare(Some("ops-1"), None), &["", "  venue-ticket  "]),
        );
        assert!(!one_operator.accepted);
        assert_eq!(code(&one_operator), MISSING_OPERATOR);
        assert!(!venue(&engine));
        assert_eq!(jlen(&engine), halted_length);

        let halt_all = sw(
            &mut engine,
            Switch::HaltAll,
            "",
            &with_refs(
                bare(Some("ops-1"), Some("ops-2")),
                &["", "  venue-ticket  "],
            ),
        );
        assert!(halt_all.accepted);
        assert!(venue(&engine));
        assert!(engine.flags(MARKET).halted);

        let resume_all_blank = sw(
            &mut engine,
            Switch::ResumeAll,
            "",
            &with_refs(bare(Some("ops-2"), Some("ops-3")), &BLANK_REFS),
        );
        assert!(!resume_all_blank.accepted);
        assert_eq!(code(&resume_all_blank), MISSING_EVIDENCE);
        assert!(venue(&engine));
        assert!(engine.flags(MARKET).halted);

        let expire_while_halted = sw(
            &mut engine,
            Switch::Expire,
            MARKET,
            &with_refs(
                with_evidence(bare(Some("ops-1"), Some("ops-2")), "  "),
                &[""],
            ),
        );
        assert!(!expire_while_halted.accepted);
        assert_eq!(code(&expire_while_halted), MISSING_EVIDENCE);
        assert!(!engine.flags(MARKET).expired);
        assert!(engine.flags(MARKET).halted);

        let resume = sw(
            &mut engine,
            Switch::Resume,
            MARKET,
            &with_refs(bare(Some("ops-2"), Some("ops-3")), &["", "  ref-1  "]),
        );
        assert!(resume.accepted);
        assert!(!engine.flags(MARKET).halted);
        assert!(venue(&engine));
    }

    #[test]
    fn rulebook_refuse_missing_operator_still_missing_operator() {
        let mut engine = build();
        let halt = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &with_evidence(bare(None, None), "incident-42"),
        );
        assert!(!halt.accepted);
        assert_eq!(code(&halt), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).halted);

        let mut delist_cmd = bare(None, None);
        delist_cmd.policy_id = Some("policy-7".to_owned());
        let delisted = sw(&mut engine, Switch::Delist, MARKET, &delist_cmd);
        assert!(!delisted.accepted);
        assert_eq!(code(&delisted), MISSING_OPERATOR);
        assert!(!engine.flags(MARKET).delisted);

        let blank = sw(
            &mut engine,
            Switch::Halt,
            MARKET,
            &with_evidence(bare(Some("   "), None), "incident-42"),
        );
        assert_eq!(code(&blank), MISSING_OPERATOR);
    }
}
