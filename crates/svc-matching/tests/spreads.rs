//! The spread book, ported test for test from `services/svc-matching/src/`: `engine/spread-book.test.ts`,
//! `engine/spread-core-refuse.test.ts`, `spread-fill-publisher.test.ts` and `spread.router.test.ts`. The router tests
//! run through [`MatchingDoor::decide`], signed as `tests/wire_replay.rs` signs; the TypeScript `spreadFills`
//! publisher is the engine's own bus (`EngineParts::spread_fills`), so "published" is every `spreadFilled` on it.
//!
//! A market mode (halt, delist, expire, prelaunch, maintenance) is switched by a `venue` slice door this port does not
//! serve yet. Each test that needs one writes the mode's journal record and cold-starts an engine on that journal, as
//! `tests/wire_replay.rs` seeds `open`.
//!
//! Not ported:
//! - `spread-book.test.ts`, "a leg market held closed by the replay hold check refuses the whole spread": `holdHalt`
//!   is the ledger hold check's, the `serve` slice's, and is not ported.
//! - `spread-core-refuse.test.ts`, "refuses a spread order spread_order_unsupported and takes no sequence": the Rust
//!   book has no state without the spread layer (its `submit` always runs it), so a bare book admits a spread order
//!   whose legs price. What still applies, that a spread order never rests or matches without its legs and a refusal
//!   takes no sequence, is
//!   `core_book_without_the_spread_hitch_a_spread_order_never_rests_or_matches_without_its_legs`.
//! - `spread-fill-publisher.test.ts`, "index.ts, the file the container runs, wires the publisher into the engine":
//!   the binary is the `serve` slice's and is not written yet.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};
use svc_matching::approval::{Approvals, Refused, Stub};
use svc_matching::book::order_book::OrderBook;
use svc_matching::book::spread::{
    SpreadLegInput, SpreadListingInput, read_spread_listing, spread_leg_fills,
};
use svc_matching::book::types::{
    CancelReason, EngineAmend, EngineOrder, Fill, Opt, OrderType, Side, SpreadInstrument,
    SpreadTerms, SubmitResult, Tif,
};
use svc_matching::book::wire::{from_wire, from_wire_amend};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{
    EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published, SpreadOrderInput,
};
use svc_matching::journal::record::whole;
use svc_matching::journal::replay::{
    MemorySnapshotSink, ReplayBooks, ReplayCancel, js_sort_cmp, replay_journal,
};
use svc_matching::journal::{EngineJournal, JournalCommand, JournalRecord, MemoryJournal};
use svc_matching::journal::{decode_all, encode};

// ═══ harness ═════════════════════════════════════════════════════════════════════════════════════════════════════

const SCALE: Amount = Amount::ONE;

/// Calendar: buying the spread sells the near leg and buys the far leg. Spread = far - near. Near is the anchor.
const CAL: &str = "BTC-CAL-MAR-JUN";
const NEAR: &str = "BTC-27MAR";
const FAR: &str = "BTC-26JUN";
/// Inter-coin 2:1: buying the spread buys 2 ETH and sells 1 BTC. Spread = 2 x ETH - BTC. ETH is the anchor.
const PAIR: &str = "ETH-BTC-2X1";

const OPERATOR: &str = "ops-1";
const CONFIRM: &str = "ops-2";

/// 2026-10-20T00:00:00.000Z.
const DAY: i64 = 1_792_454_400_000;

thread_local! {
    static UUID: Cell<u64> = const { Cell::new(0) };
    static TICK: Cell<i64> = const { Cell::new(0) };
}

fn uuid() -> String {
    let n = UUID.with(|c| {
        c.set(c.get() + 1);
        c.get()
    });
    format!("00000000-0000-4000-8000-{n:012}")
}

/// `fixedClock()`: one second further per read, from 2026-10-20.
fn fixed_clock() -> i64 {
    let tick = TICK.with(|t| {
        t.set(t.get() + 1);
        t.get()
    });
    DAY + tick * 1000
}

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// A bus the test reads after handing it to the engine.
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

struct Built {
    engine: MatchingEngine,
    bus: Bus,
}

impl Built {
    /// The `RecordingPublisher`'s rows: every `spreadFilled` the engine announced.
    fn published(&self) -> Vec<Published> {
        self.bus.emitted("spreadFilled")
    }
}

fn engine_on(journal: MemoryJournal, bus: Bus, spread_fills: bool) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(bus),
        clock: fixed_clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills,
    })
}

/// `build({ journal, publisher })`: `publisher: null` is `spread_fills: false`.
fn build_on(journal: MemoryJournal, publisher: bool) -> Built {
    TICK.with(|t| t.set(0));
    let bus = Bus::default();
    Built {
        engine: engine_on(journal, bus.clone(), publisher),
        bus,
    }
}

fn build() -> Built {
    build_on(MemoryJournal::new(), true)
}

/// The same journal handed to a second engine.
fn same_journal(records: &[JournalRecord]) -> MemoryJournal {
    let mut journal = MemoryJournal::new();
    for r in records {
        journal.append(&JournalCommand(r.0.clone())).unwrap();
    }
    assert_eq!(journal.read(), records);
    journal
}

fn records(engine: &MatchingEngine) -> Vec<JournalRecord> {
    engine.journal().read().to_vec()
}

fn journal_len(engine: &MatchingEngine) -> usize {
    engine.journal().len()
}

/// A market mode switched as the venue door journals it, read back by a cold start: the engine that follows.
fn with_mode(built: &Built, kind: &str, market: &str) -> Built {
    let mut journal = same_journal(&records(&built.engine));
    journal
        .append(&JournalCommand(Json::obj([
            ("kind", Json::str(kind)),
            ("marketId", Json::str(market)),
            ("at", Json::str(Instant(fixed_clock()).iso())),
            ("operatorId", Json::str(OPERATOR)),
            ("confirmOperatorId", Json::str(CONFIRM)),
        ])))
        .unwrap();
    let bus = Bus::default();
    let mut engine = engine_on(journal, bus.clone(), true);
    engine.recover().unwrap();
    Built { engine, bus }
}

fn leg(symbol: &str, side: &str, ratio: &str) -> SpreadLegInput {
    SpreadLegInput {
        symbol: Some(symbol.to_owned()),
        side: Some(side.to_owned()),
        ratio: Some(ratio.to_owned()),
    }
}

fn cal_listing() -> SpreadListingInput {
    SpreadListingInput {
        spread_id: Some(CAL.to_owned()),
        kind: Some("calendar".to_owned()),
        legs: Some(vec![leg(NEAR, "sell", "1"), leg(FAR, "buy", "1")]),
        tick: Some("0.5".to_owned()),
        lot: Some("0.001".to_owned()),
    }
}

fn pair_listing() -> SpreadListingInput {
    SpreadListingInput {
        spread_id: Some(PAIR.to_owned()),
        kind: Some("inter_coin".to_owned()),
        legs: Some(vec![
            leg("ETH-USDT", "buy", "2"),
            leg("BTC-USDT", "sell", "1"),
        ]),
        tick: Some("0.01".to_owned()),
        lot: Some("0.01".to_owned()),
    }
}

fn list(
    engine: &mut MatchingEngine,
    listing: &SpreadListingInput,
) -> svc_matching::engine::SpreadListResult {
    engine
        .list_spread(listing, Some(OPERATOR), Some(CONFIRM))
        .unwrap()
}

fn listed(listings: &[SpreadListingInput]) -> Built {
    let mut built = build();
    for l in listings {
        assert!(list(&mut built.engine, l).accepted);
    }
    built
}

fn instrument_of(input: &SpreadListingInput) -> SpreadInstrument {
    read_spread_listing(input).unwrap()
}

/// `spreadOrder(spec)`: account `acct-taker`, GTC, anchor reference 60000 unless set.
#[derive(Clone)]
struct Spec {
    side: Side,
    qty: String,
    price: String,
    reference: Option<String>,
    account: String,
    id: Option<String>,
    tif: Tif,
    client_order_id: Option<String>,
}

fn spec(side: Side, qty: &str, price: &str) -> Spec {
    Spec {
        side,
        qty: qty.to_owned(),
        price: price.to_owned(),
        reference: Some("60000".to_owned()),
        account: "acct-taker".to_owned(),
        id: None,
        tif: Tif::Gtc,
        client_order_id: None,
    }
}

impl Spec {
    fn account(mut self, account: &str) -> Spec {
        account.clone_into(&mut self.account);
        self
    }

    fn reference(mut self, reference: Option<&str>) -> Spec {
        self.reference = reference.map(str::to_owned);
        self
    }

    fn tif(mut self, tif: Tif) -> Spec {
        self.tif = tif;
        self
    }

    fn client_order_id(mut self, id: &str) -> Spec {
        self.client_order_id = Some(id.to_owned());
        self
    }

    fn input(&self) -> SpreadOrderInput {
        SpreadOrderInput {
            order_id: self.id.clone().unwrap_or_else(uuid),
            account_id: self.account.clone(),
            side: self.side,
            qty: a(&self.qty),
            price: a(&self.price),
            tif: self.tif,
            anchor_reference: self.reference.as_deref().map(a),
            client_order_id: self.client_order_id.clone(),
            environment: None,
            session_id: None,
        }
    }
}

fn submit_spread(
    engine: &mut MatchingEngine,
    spread_id: &str,
    input: &SpreadOrderInput,
) -> SubmitResult {
    engine.submit_spread(spread_id, input, None).unwrap()
}

fn place(engine: &mut MatchingEngine, spread_id: &str, s: &Spec) -> SubmitResult {
    submit_spread(engine, spread_id, &s.input())
}

fn sign(side: Side) -> i128 {
    match side {
        Side::Buy => 1,
        Side::Sell => -1,
    }
}

/// Legs in exact ratio, positive prices, and the leg prices sum to the spread price with no rounding.
fn expect_whole_spread(fill: &Fill, instrument: &SpreadInstrument) {
    let legs = fill.legs.as_ref().expect("a spread fill carries its legs");
    assert_eq!(legs.len(), instrument.legs.len());
    let mut spread = Amount::ZERO;
    for (leg, printed) in instrument.legs.iter().zip(legs) {
        assert_eq!(printed.symbol, leg.symbol);
        assert_eq!(
            printed.qty.scaled().checked_mul(SCALE.scaled()).unwrap(),
            fill.qty.scaled().checked_mul(leg.ratio.scaled()).unwrap()
        );
        assert!(printed.price > Amount::ZERO);
        let taker_side = if fill.taker_side == Side::Buy {
            leg.side
        } else {
            leg.side.opposite()
        };
        assert_eq!(printed.taker_side, taker_side);
        // BigInt division truncates; both factors are positive, so this is the floor.
        spread += sign(leg.side) * mul_div(leg.ratio, printed.price, SCALE, Rounding::Trunc);
    }
    assert_eq!(spread, fill.price);
}

fn ladder(levels: &[(&str, &str)]) -> Vec<(Amount, Amount)> {
    levels.iter().map(|(p, q)| (a(p), a(q))).collect()
}

fn leg_rows(fill: &Fill) -> Vec<(String, &'static str, String, String)> {
    fill.legs
        .as_ref()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l.symbol.clone(),
                l.taker_side.as_str(),
                format_amount(l.qty),
                format_amount(l.price),
            )
        })
        .collect()
}

fn rows(
    expected: &[(&str, &'static str, &str, &str)],
) -> Vec<(String, &'static str, String, String)> {
    expected
        .iter()
        .map(|(s, t, q, p)| ((*s).to_owned(), *t, (*q).to_owned(), (*p).to_owned()))
        .collect()
}

fn code(r: &SubmitResult) -> Option<&str> {
    r.rejected.as_ref().map(|r| r.code.as_str())
}

/// A limit order at a spread price, outright unless `spread` is set.
fn limit(account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        uuid(),
        account,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

fn with_spread(mut o: EngineOrder, instrument: SpreadInstrument, reference: &str) -> EngineOrder {
    o.spread = Some(SpreadTerms {
        instrument,
        anchor_reference: Some(a(reference)),
    });
    o
}

/// `unchanged(...)`: the books, the journal and the spread fills announced are the same after `act`.
fn unchanged(
    built: &mut Built,
    act: impl FnOnce(&mut MatchingEngine) -> SubmitResult,
) -> SubmitResult {
    let book = built.engine.serialize();
    let records = journal_len(&built.engine);
    let fills = built.published().len();
    let out = act(&mut built.engine);
    assert_eq!(built.engine.serialize(), book);
    assert_eq!(journal_len(&built.engine), records);
    assert_eq!(built.published().len(), fills);
    out
}

/// A key the payload carries, as text.
fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is text, got {other:?}"),
    }
}

/// The books replay rebuilds, and every fill replay printed with its market (`replayJournal(...).fills`).
#[derive(Default)]
struct Books {
    books: HashMap<String, OrderBook>,
    fills: Vec<(String, Fill)>,
}

impl Books {
    fn drop_if_never_traded(&mut self, market_id: &str) {
        if self
            .books
            .get(market_id)
            .is_some_and(OrderBook::is_never_printed_empty)
        {
            self.books.remove(market_id);
        }
    }

    /// `serializeBooks`.
    fn serialize(&self) -> String {
        let mut ids: Vec<&String> = self.books.keys().collect();
        ids.sort_by(|x, y| js_sort_cmp(x, y));
        Json::Array(ids.iter().map(|id| self.books[*id].to_state()).collect()).compact()
    }
}

impl ReplayBooks for Books {
    fn has_market(&self, market_id: &str) -> bool {
        self.books.contains_key(market_id)
    }

    fn submit(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        let o = from_wire(record.field("order").unwrap()).unwrap();
        let result = self
            .books
            .entry(market_id.to_owned())
            .or_insert_with(|| OrderBook::new(market_id))
            .submit(&o, clock);
        self.fills
            .extend(result.fills.into_iter().map(|f| (market_id.to_owned(), f)));
        self.drop_if_never_traded(market_id);
    }

    fn amend(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        let id = text(&record.0, "orderId");
        let version =
            u64::try_from(whole(record.field("expectedVersion").unwrap()).unwrap()).unwrap();
        let empty = Json::Object(Vec::new());
        let cmd = from_wire_amend(&id, version, record.field("patch").unwrap_or(&empty)).unwrap();
        if let Some(book) = self.books.get_mut(market_id) {
            let result = book.amend(&cmd, clock);
            self.fills
                .extend(result.fills.into_iter().map(|f| (market_id.to_owned(), f)));
        }
        self.drop_if_never_traded(market_id);
    }

    fn mark(&mut self, _: &str, _: &JournalRecord) {
        panic!("no spread test journals a mark");
    }

    fn mass_cancel(&mut self, _: &str, _: &JournalRecord) {
        panic!("no spread test journals a mass cancel");
    }

    fn cancel(&mut self, market_id: &str, record: &JournalRecord, why: ReplayCancel<'_>) {
        let reason = match why {
            ReplayCancel::Requested => CancelReason::Requested,
            ReplayCancel::Reason(r) => CancelReason::parse(r).unwrap(),
        };
        let id = text(&record.0, "orderId");
        if let Some(book) = self.books.get_mut(market_id) {
            book.cancel(&id, reason);
        }
    }

    fn session_dead(&mut self, _: &Json) {
        panic!("no spread test journals a dead session");
    }
}

fn replay(records: &[JournalRecord]) -> Books {
    let mut books = Books::default();
    replay_journal(records, &mut books).unwrap();
    books
}

// ═══ spread-book.test.ts ═════════════════════════════════════════════════════════════════════════════════════════

mod spread_listing {
    use super::*;

    #[test]
    fn no_listing_is_an_empty_registry_with_no_sample_instruments() {
        let built = build();
        assert!(built.engine.spread_instruments().is_empty());
        assert!(built.engine.spread_book(CAL, 10).is_none());
    }

    #[test]
    fn lists_a_calendar_and_an_inter_coin_spread_and_journals_each_listing_once() {
        let mut built = listed(&[cal_listing(), pair_listing()]);
        let mut want = vec![PAIR, CAL];
        want.sort_unstable();
        let ids: Vec<&str> = built
            .engine
            .spread_instruments()
            .iter()
            .map(|i| i.spread_id.as_str())
            .collect();
        assert_eq!(ids, want);
        let lists = records(&built.engine)
            .iter()
            .filter(|r| r.kind() == Some("spread_list"))
            .count();
        assert_eq!(lists, 2);

        let again = list(&mut built.engine, &cal_listing());
        assert!(again.accepted);
        assert!(again.already_listed);
        assert_eq!(journal_len(&built.engine), 2);
    }

    /// The `it.each` rows: a label, the listing with one field changed, and the code it refuses with.
    fn refusal_rows() -> Vec<(&'static str, SpreadListingInput, &'static str)> {
        let with = |f: &dyn Fn(&mut SpreadListingInput)| {
            let mut l = cal_listing();
            f(&mut l);
            l
        };
        let legs = |l: Vec<SpreadLegInput>| {
            with(&move |x: &mut SpreadListingInput| x.legs = Some(l.clone()))
        };
        let mut null_side = leg(NEAR, "sell", "1");
        null_side.side = None;
        vec![
            (
                "spread id",
                with(&|l| l.spread_id = Some("  ".to_owned())),
                "spread_id_missing",
            ),
            (
                "kind",
                with(&|l| l.kind = Some(String::new())),
                "spread_kind_unsupported",
            ),
            (
                "unknown kind",
                with(&|l| l.kind = Some("butterfly".to_owned())),
                "spread_kind_unsupported",
            ),
            ("legs", with(&|l| l.legs = None), "spread_legs_invalid"),
            (
                "one leg",
                legs(vec![leg(NEAR, "sell", "1")]),
                "spread_legs_invalid",
            ),
            (
                "leg symbol",
                legs(vec![leg("", "sell", "1"), leg(FAR, "buy", "1")]),
                "spread_leg_symbol_missing",
            ),
            (
                "leg side",
                legs(vec![null_side, leg(FAR, "buy", "1")]),
                "spread_leg_side_missing",
            ),
            (
                "blank ratio",
                legs(vec![leg(NEAR, "sell", ""), leg(FAR, "buy", "1")]),
                "spread_ratio_missing",
            ),
            (
                "zero ratio",
                legs(vec![leg(NEAR, "sell", "0"), leg(FAR, "buy", "1")]),
                "spread_ratio_missing",
            ),
            (
                "same side twice",
                legs(vec![leg(NEAR, "buy", "1"), leg(FAR, "buy", "1")]),
                "spread_legs_invalid",
            ),
            (
                "one symbol twice",
                legs(vec![leg(NEAR, "sell", "1"), leg(NEAR, "buy", "1")]),
                "spread_legs_invalid",
            ),
            (
                "a leg that is the spread itself",
                legs(vec![leg(CAL, "sell", "1"), leg(FAR, "buy", "1")]),
                "spread_legs_invalid",
            ),
            (
                "calendar at unequal ratios",
                legs(vec![leg(NEAR, "sell", "1"), leg(FAR, "buy", "2")]),
                "spread_legs_invalid",
            ),
            ("tick", with(&|l| l.tick = None), "spread_tick_missing"),
            (
                "zero tick",
                with(&|l| l.tick = Some("0".to_owned())),
                "spread_tick_missing",
            ),
            (
                "lot",
                with(&|l| l.lot = Some(String::new())),
                "spread_lot_missing",
            ),
            (
                "malformed lot",
                with(&|l| l.lot = Some("1e-3".to_owned())),
                "spread_lot_missing",
            ),
        ]
    }

    #[test]
    fn a_missing_or_invalid_field_refuses_typed_and_lists_nothing() {
        for (label, listing, want) in refusal_rows() {
            let mut built = build();
            let result = list(&mut built.engine, &listing);
            assert!(!result.accepted, "{label}");
            assert_eq!(
                result.rejected.as_ref().map(|r| r.code.as_str()),
                Some(want),
                "{label}"
            );
            assert!(built.engine.spread_instruments().is_empty(), "{label}");
            assert_eq!(journal_len(&built.engine), 0, "{label}");
        }
    }

    #[test]
    fn a_lot_or_tick_that_would_force_rounding_a_leg_refuses_spread_size_inexact() {
        let mut built = build();
        let mut lot_rounds = pair_listing();
        lot_rounds.lot = Some("0.000000000000000001".to_owned());
        lot_rounds.legs = Some(vec![
            leg("ETH-USDT", "buy", "0.5"),
            leg("BTC-USDT", "sell", "1"),
        ]);
        let r = list(&mut built.engine, &lot_rounds);
        assert_eq!(r.rejected.unwrap().code, "spread_size_inexact");
        let mut tick_rounds = pair_listing();
        tick_rounds.legs = Some(vec![
            leg("ETH-USDT", "buy", "1"),
            leg("BTC-USDT", "sell", "3"),
        ]);
        let r = list(&mut built.engine, &tick_rounds);
        assert_eq!(r.rejected.unwrap().code, "spread_size_inexact");
    }

    #[test]
    fn a_second_different_definition_under_a_listed_id_refuses_an_outright_market_id_refuses() {
        let mut built = listed(&[cal_listing()]);
        let mut changed = cal_listing();
        changed.tick = Some("1".to_owned());
        let r = list(&mut built.engine, &changed);
        assert_eq!(r.rejected.unwrap().code, "spread_listing_conflict");
        assert_eq!(built.engine.spread_instrument(CAL).unwrap().tick, a("0.5"));

        let outright = limit("mm", Side::Sell, "1", "100");
        built.engine.submit("XRP-USDT", &outright, None).unwrap();
        let mut collides = pair_listing();
        collides.spread_id = Some("XRP-USDT".to_owned());
        let r = list(&mut built.engine, &collides);
        assert_eq!(r.rejected.unwrap().code, "spread_id_collides");
        let lists = records(&built.engine)
            .iter()
            .filter(|r| r.kind() == Some("spread_list"))
            .count();
        assert_eq!(lists, 1);
    }

    #[test]
    fn a_spread_whose_leg_is_itself_a_listed_spread_refuses() {
        let mut built = listed(&[cal_listing()]);
        let mut nested = pair_listing();
        nested.spread_id = Some("NESTED".to_owned());
        nested.legs = Some(vec![leg(CAL, "buy", "1"), leg("BTC-USDT", "sell", "1")]);
        let r = list(&mut built.engine, &nested);
        assert_eq!(r.rejected.unwrap().code, "spread_legs_invalid");
        assert!(built.engine.spread_instrument("NESTED").is_none());
    }

    #[test]
    fn a_listing_needs_two_distinct_operators() {
        let mut built = build();
        let single = built
            .engine
            .list_spread(&cal_listing(), Some("ops-1"), Some("ops-1"))
            .unwrap();
        assert!(!single.accepted);
        assert!(built.engine.spread_instruments().is_empty());
    }
}

mod spread_book {
    use super::*;

    #[test]
    fn given_a_calendar_spread_listed_the_book_shows_the_spread_price_including_a_negative_one() {
        let mut built = listed(&[cal_listing()]);
        let view = built.engine.spread_book(CAL, 10).unwrap();
        assert!(view.bids.is_empty());
        assert!(view.asks.is_empty());
        assert_eq!(view.best_bid, None);
        assert_eq!(view.best_ask, None);
        assert_eq!(view.last_price, None);

        place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "0.5", "150").account("mm"),
        );
        place(
            &mut built.engine,
            CAL,
            &spec(Side::Buy, "0.25", "-25").account("mm-2"),
        );
        let view = built.engine.spread_book(CAL, 10).unwrap();
        assert_eq!(view.bids, ladder(&[("-25", "0.25")]));
        assert_eq!(view.asks, ladder(&[("150", "0.5")]));
        assert_eq!(view.best_bid, Some(a("-25")));
        assert_eq!(view.best_ask, Some(a("150")));
        assert_eq!(view.last_price, None);

        let take = place(&mut built.engine, CAL, &spec(Side::Buy, "0.1", "150"));
        assert_eq!(take.fills.len(), 1);
        let view = built.engine.spread_book(CAL, 10).unwrap();
        assert_eq!(view.last_price, Some(a("150")));
        assert_eq!(view.asks, ladder(&[("150", "0.4")]));
    }

    #[test]
    fn fills_at_the_maker_spread_price_and_prints_both_calendar_legs_near_at_the_reference_far_is_near_plus_spread()
     {
        let mut built = listed(&[cal_listing()]);
        place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "2", "150")
                .account("mm")
                .reference(Some("59000")),
        );
        let take = place(
            &mut built.engine,
            CAL,
            &spec(Side::Buy, "2", "155").reference(Some("60000")),
        );
        assert!(take.accepted);
        assert_eq!(take.fills.len(), 1);
        let fill = &take.fills[0];
        assert_eq!(format_amount(fill.price), "150");
        assert_eq!(
            leg_rows(fill),
            rows(&[(NEAR, "sell", "2", "60000"), (FAR, "buy", "2", "60150")])
        );
        expect_whole_spread(fill, &instrument_of(&cal_listing()));
        let published = built.published();
        assert_eq!(published.len(), 1);
        assert_eq!(
            published[0].key,
            format!("matching.spread.filled:{CAL}:{}", fill.sequence)
        );
        assert_eq!(built.bus.emitted("orderFilled").len(), 0);
    }

    #[test]
    fn given_an_inter_coin_spread_at_2_1_one_match_is_one_spread_fill_carrying_both_legs() {
        let mut built = listed(&[pair_listing()]);
        place(
            &mut built.engine,
            PAIR,
            &spec(Side::Sell, "3", "-54000")
                .account("mm")
                .reference(Some("3000")),
        );
        let take = place(
            &mut built.engine,
            PAIR,
            &spec(Side::Buy, "3", "-54000").reference(Some("3000")),
        );
        assert_eq!(take.fills.len(), 1);
        let fill = &take.fills[0];
        assert_eq!(
            leg_rows(fill),
            rows(&[
                ("ETH-USDT", "buy", "6", "3000"),
                ("BTC-USDT", "sell", "3", "60000")
            ])
        );
        expect_whole_spread(fill, &instrument_of(&pair_listing()));

        let published = built.published();
        assert_eq!(published.len(), 1);
        let event = &published[0].payload;
        assert_eq!(text(event, "spreadId"), PAIR);
        assert_eq!(text(event, "price"), "-54000");
        assert_eq!(text(event, "qty"), "3");
        assert_eq!(text(event, "takerSide"), "buy");
        assert_eq!(text(event, "makerAccountId"), "mm");
        let legs = json::parse(
            r#"[{"symbol":"ETH-USDT","takerSide":"buy","qty":"6","price":"3000"},
                {"symbol":"BTC-USDT","takerSide":"sell","qty":"3","price":"60000"}]"#,
        )
        .unwrap();
        assert!(
            same(event.get("legs").unwrap(), &legs),
            "{}",
            event.compact()
        );
    }

    #[test]
    fn a_partial_spread_fill_keeps_every_leg_at_the_ratio_and_rests_the_rest_as_one_spread_order() {
        let mut built = listed(&[pair_listing()]);
        place(
            &mut built.engine,
            PAIR,
            &spec(Side::Sell, "1", "-100")
                .account("mm")
                .reference(Some("3000")),
        );
        let take = place(
            &mut built.engine,
            PAIR,
            &spec(Side::Buy, "2.5", "-100").reference(Some("3000")),
        );
        assert_eq!(take.fills.len(), 1);
        assert_eq!(format_amount(take.fills[0].qty), "1");
        let qtys: Vec<String> = take.fills[0]
            .legs
            .as_ref()
            .unwrap()
            .iter()
            .map(|l| format_amount(l.qty))
            .collect();
        assert_eq!(qtys, ["2", "1"]);
        assert_eq!(take.resting.as_ref().unwrap().remaining, a("1.5"));
        assert_eq!(
            built.engine.spread_book(PAIR, 10).unwrap().bids,
            ladder(&[("-100", "1.5")])
        );
    }

    #[test]
    fn outright_orders_never_touch_a_spread_book_and_spread_orders_never_touch_an_outright_book() {
        let mut built = listed(&[cal_listing()]);
        let outright = limit("acct", Side::Buy, "1", "100");
        let before = journal_len(&built.engine);
        let refused = built.engine.submit(CAL, &outright, None).unwrap();
        assert_eq!(code(&refused), Some("spread_book_outright_refused"));
        assert_eq!(journal_len(&built.engine), before);

        let unlisted = place(&mut built.engine, "NOT-LISTED", &spec(Side::Buy, "1", "1"));
        assert_eq!(code(&unlisted), Some("spread_unlisted"));
        assert_eq!(journal_len(&built.engine), before);
    }

    #[test]
    fn cancel_works_through_the_normal_door_and_releases_the_whole_spread_order() {
        let mut built = listed(&[cal_listing()]);
        let maker = spec(Side::Sell, "1", "150").account("mm").input();
        submit_spread(&mut built.engine, CAL, &maker);
        let cancel = built
            .engine
            .cancel(CAL, &maker.order_id, CancelReason::Requested)
            .unwrap();
        assert!(cancel.cancelled);
        assert_eq!(
            format_amount(cancel.cancellation.unwrap().remaining_qty),
            "1"
        );
        assert_eq!(built.bus.emitted("orderCancelled").len(), 1);
        assert!(built.engine.spread_book(CAL, 10).unwrap().asks.is_empty());
    }

    #[test]
    fn native_amend_on_a_spread_refuses_before_the_journal() {
        let mut built = listed(&[cal_listing()]);
        let maker = spec(Side::Sell, "1", "150").account("mm").input();
        submit_spread(&mut built.engine, CAL, &maker);
        let before = journal_len(&built.engine);
        let amended = built
            .engine
            .amend(
                CAL,
                &EngineAmend {
                    order_id: maker.order_id.clone(),
                    expected_version: 1,
                    price: Some(a("149.5")),
                    ..EngineAmend::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(amended.rejected.unwrap().code, "spread_amend_unsupported");
        assert_eq!(journal_len(&built.engine), before);
    }
}

mod equal_or_nothing {
    use super::*;

    #[test]
    fn given_one_leg_market_halted_the_whole_spread_refuses_and_nothing_is_journalled_or_filled() {
        let mut built = listed(&[cal_listing()]);
        place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "150").account("mm"),
        );
        let mut built = with_mode(&built, "halt", FAR);
        let records_after_halt = journal_len(&built.engine);
        let refused = unchanged(&mut built, |e| place(e, CAL, &spec(Side::Buy, "1", "150")));
        assert_eq!(code(&refused), Some("spread_leg_unavailable"));
        assert_eq!(journal_len(&built.engine), records_after_halt);
    }

    #[test]
    fn a_leg_market_closed_refuses_the_whole_spread() {
        for (label, kind) in [
            ("halted", "halt"),
            ("delisted", "delist"),
            ("expired", "expire"),
            ("in prelaunch", "prelaunch"),
            ("in maintenance", "maintenance"),
        ] {
            let mut built = listed(&[cal_listing()]);
            place(
                &mut built.engine,
                CAL,
                &spec(Side::Sell, "1", "150").account("mm"),
            );
            let mut built = with_mode(&built, kind, FAR);
            let refused = unchanged(&mut built, |e| place(e, CAL, &spec(Side::Buy, "1", "150")));
            assert_eq!(code(&refused), Some("spread_leg_unavailable"), "{label}");
        }
    }

    #[test]
    fn given_a_fill_that_would_price_the_residual_leg_at_or_below_zero_nothing_fills_not_even_a_good_level_first()
     {
        let mut built = listed(&[cal_listing()]);
        // Rests priced for their own reference: far = 100 - 70 = 30 and 100 + 10 = 110.
        place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "-70")
                .account("mm")
                .reference(Some("100")),
        );
        place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "10")
                .account("mm")
                .reference(Some("100")),
        );
        // Taker reference 60: the -70 level would print far at -10. The 10 level alone would be fine.
        let refused = unchanged(&mut built, |e| {
            place(e, CAL, &spec(Side::Buy, "2", "10").reference(Some("60")))
        });
        assert!(!refused.accepted);
        assert!(refused.fills.is_empty());
        assert_eq!(code(&refused), Some("spread_leg_unfillable"));
        assert_eq!(
            built.engine.spread_book(CAL, 10).unwrap().asks,
            ladder(&[("-70", "1"), ("10", "1")])
        );
    }

    #[test]
    fn an_order_whose_own_price_cannot_price_the_residual_leg_refuses_before_it_can_rest() {
        let mut built = listed(&[pair_listing()]);
        // 2 x 120 - 300 = -60 for BTC.
        let refused = unchanged(&mut built, |e| {
            place(e, PAIR, &spec(Side::Buy, "1", "300").reference(Some("120")))
        });
        assert_eq!(code(&refused), Some("spread_leg_unfillable"));
    }

    #[test]
    fn a_bad_order_part_refuses_typed_and_leaves_no_trace() {
        let base = spec(Side::Buy, "1", "150");
        let mut off_tick = base.clone();
        off_tick.price = "150.25".to_owned();
        let mut off_lot = base.clone();
        off_lot.qty = "0.0005".to_owned();
        for (label, s, want) in [
            (
                "a missing anchor reference",
                base.clone().reference(None),
                "spread_reference_missing",
            ),
            (
                "a zero anchor reference",
                base.clone().reference(Some("0")),
                "spread_reference_missing",
            ),
            (
                "an off-tick spread price",
                off_tick,
                "spread_price_off_tick",
            ),
            ("an off-lot qty", off_lot, "spread_qty_off_lot"),
            (
                "IOC (CB-otc-17)",
                base.clone().tif(Tif::Ioc),
                "spread_order_unsupported",
            ),
        ] {
            let mut built = listed(&[cal_listing()]);
            place(
                &mut built.engine,
                CAL,
                &spec(Side::Sell, "1", "150").account("mm"),
            );
            let refused = unchanged(&mut built, |e| place(e, CAL, &s));
            assert_eq!(code(&refused), Some(want), "{label}");
        }
    }

    #[test]
    fn a_spread_order_for_an_id_that_is_not_listed_refuses_before_the_journal_even_off_the_spread_door()
     {
        let mut built = listed(&[cal_listing()]);
        let mut other = cal_listing();
        other.spread_id = Some("NOT-LISTED".to_owned());
        let forged = with_spread(
            limit("acct", Side::Buy, "1", "150"),
            instrument_of(&other),
            "60000",
        );
        let refused = unchanged(&mut built, |e| {
            e.submit("NOT-LISTED", &forged, None).unwrap()
        });
        assert_eq!(code(&refused), Some("spread_unlisted"));
        assert!(built.engine.existing_book("NOT-LISTED").is_none());
    }

    #[test]
    fn an_order_carrying_another_listing_than_the_registry_refuses_before_the_journal() {
        let mut built = listed(&[cal_listing()]);
        let mut other = cal_listing();
        other.tick = Some("0.25".to_owned());
        let forged = with_spread(
            limit("acct", Side::Buy, "1", "150"),
            instrument_of(&other),
            "60000",
        );
        let refused = unchanged(&mut built, |e| e.submit(CAL, &forged, None).unwrap());
        assert_eq!(code(&refused), Some("spread_identity_disagrees"));
    }

    #[test]
    fn a_part_that_is_not_a_spread_feature_yet_refuses_spread_order_unsupported() {
        type Change = fn(&mut EngineOrder);
        let rows: [(&str, Change); 5] = [
            ("a market spread order", |o| {
                o.order_type = OrderType::Market;
                o.price = None;
            }),
            ("a stop price", |o| o.stop_price = Some(a("1"))),
            ("reduce-only", |o| o.reduce_only = true),
            ("an iceberg", |o| {
                o.iceberg = true;
                o.display_qty = Opt::Some(a("0.5"));
            }),
            ("option legs", |o| o.combo = Opt::Some(true)),
        ];
        for (label, change) in rows {
            let mut built = listed(&[cal_listing()]);
            let mut order = with_spread(
                limit("acct", Side::Buy, "1", "150"),
                instrument_of(&cal_listing()),
                "60000",
            );
            change(&mut order);
            let refused = unchanged(&mut built, |e| e.submit(CAL, &order, None).unwrap());
            assert_eq!(code(&refused), Some("spread_order_unsupported"), "{label}");
        }
    }

    #[test]
    fn a_reference_that_would_force_rounding_a_leg_refuses_spread_reference_missing() {
        for (label, legs, lot) in [
            (
                "anchor ratio 0.5",
                vec![leg("ETH-USDT", "buy", "0.5"), leg("BTC-USDT", "sell", "1")],
                "2",
            ),
            (
                "residual ratio 4",
                vec![leg("ETH-USDT", "buy", "1"), leg("BTC-USDT", "sell", "4")],
                "1",
            ),
        ] {
            let mut listing = pair_listing();
            listing.spread_id = Some("ROUNDING".to_owned());
            listing.tick = Some("0.04".to_owned());
            listing.lot = Some(lot.to_owned());
            listing.legs = Some(legs);
            let mut built = listed(&[listing]);
            let refused = unchanged(&mut built, |e| {
                place(
                    e,
                    "ROUNDING",
                    &spec(Side::Buy, lot, "0").reference(Some("0.000000000000000001")),
                )
            });
            assert_eq!(code(&refused), Some("spread_reference_missing"), "{label}");
        }
    }

    #[test]
    fn with_no_spread_fill_publisher_wired_spread_orders_refuse_before_the_journal_no_maker_fill_goes_unannounced()
     {
        let mut built = build_on(MemoryJournal::new(), false);
        list(&mut built.engine, &cal_listing());
        let records = journal_len(&built.engine);
        let refused = place(&mut built.engine, CAL, &spec(Side::Sell, "1", "150"));
        assert_eq!(code(&refused), Some("spread_fill_event_unwired"));
        assert_eq!(journal_len(&built.engine), records);
        assert!(built.engine.spread_book(CAL, 10).unwrap().asks.is_empty());
    }
}

mod idempotency {
    use super::*;

    #[test]
    fn a_spread_order_journals_its_client_order_id_for_the_claim_to_read() {
        let mut built = listed(&[cal_listing()]);
        let first = place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "150").client_order_id("spread:mm:1"),
        );
        assert!(first.accepted);
        let last = records(&built.engine).pop().unwrap();
        let order = last.field("order").unwrap();
        assert_eq!(
            order.get("clientOrderId"),
            Some(&service_kit::json::Json::str("spread:mm:1"))
        );
    }

    #[test]
    fn a_reused_client_order_id_refuses_client_order_id_reuse() {
        let mut built = listed(&[cal_listing()]);
        let first = place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "150").client_order_id("spread:mm:1"),
        );
        assert!(first.accepted);
        let records = journal_len(&built.engine);
        let again = place(
            &mut built.engine,
            CAL,
            &spec(Side::Sell, "1", "150").client_order_id("spread:mm:1"),
        );
        assert_eq!(code(&again), Some("client_order_id_reuse"));
        assert_eq!(journal_len(&built.engine), records);
    }

    #[test]
    fn a_retried_order_id_does_not_rest_or_fill_twice_and_is_not_journalled_again() {
        let mut built = listed(&[cal_listing()]);
        let maker = spec(Side::Sell, "2", "150").account("mm").input();
        submit_spread(&mut built.engine, CAL, &maker);
        let take = spec(Side::Buy, "1", "150").input();
        submit_spread(&mut built.engine, CAL, &take);
        let records = journal_len(&built.engine);

        let retry_take = submit_spread(&mut built.engine, CAL, &take);
        assert_eq!(code(&retry_take), Some("duplicate_order_id"));
        let retry_maker = submit_spread(&mut built.engine, CAL, &maker);
        assert_eq!(code(&retry_maker), Some("duplicate_order_id"));
        assert_eq!(journal_len(&built.engine), records);
        assert_eq!(built.published().len(), 1);
        assert_eq!(
            built.engine.spread_book(CAL, 10).unwrap().asks,
            ladder(&[("150", "1")])
        );
    }

    #[test]
    fn a_retried_id_answers_duplicate_order_id_even_when_the_retry_would_now_refuse_for_a_spread_reason()
     {
        let mut built = listed(&[cal_listing()]);
        let maker = spec(Side::Sell, "1", "150").account("mm").input();
        submit_spread(&mut built.engine, CAL, &maker);
        let mut retry = maker.clone();
        retry.anchor_reference = None;
        let retry = submit_spread(&mut built.engine, CAL, &retry);
        assert_eq!(code(&retry), Some("duplicate_order_id"));
    }
}

mod journal_and_replay {
    use super::*;

    fn trade() -> Built {
        let mut built = listed(&[cal_listing(), pair_listing()]);
        let e = &mut built.engine;
        place(
            e,
            CAL,
            &spec(Side::Sell, "2", "150")
                .account("mm")
                .reference(Some("59000")),
        );
        place(
            e,
            CAL,
            &spec(Side::Buy, "1", "-20")
                .account("mm-2")
                .reference(Some("59000")),
        );
        place(
            e,
            CAL,
            &spec(Side::Buy, "1.5", "150").reference(Some("60000")),
        );
        place(
            e,
            PAIR,
            &spec(Side::Sell, "1", "-54000")
                .account("mm")
                .reference(Some("3000")),
        );
        place(
            e,
            PAIR,
            &spec(Side::Buy, "0.5", "-54000").reference(Some("3000")),
        );
        built
    }

    #[test]
    fn a_restart_replays_the_listings_and_rebuilds_the_exact_spread_books_then_keeps_trading_the_same_way()
     {
        let mut live = trade();
        let mut restarted = build_on(same_journal(&records(&live.engine)), true);
        restarted.engine.recover().unwrap();

        assert_eq!(restarted.engine.serialize(), live.engine.serialize());
        assert_eq!(
            restarted.engine.spread_instruments(),
            live.engine.spread_instruments()
        );
        assert_eq!(
            restarted.engine.spread_book(CAL, 10),
            live.engine.spread_book(CAL, 10)
        );

        // Recovery re-announces each spread fill once, under the original key (ordered by sequence, as for outright
        // fills).
        let keys = |rows: Vec<Published>| {
            let mut k: Vec<String> = rows.into_iter().map(|r| r.key).collect();
            k.sort();
            k
        };
        assert_eq!(keys(restarted.published()), keys(live.published()));
        assert_eq!(restarted.published().len(), 2);

        let next = spec(Side::Buy, "0.5", "150")
            .reference(Some("61000"))
            .input();
        let a = submit_spread(&mut live.engine, CAL, &next);
        let b = submit_spread(&mut restarted.engine, CAL, &next);
        assert_eq!(b, a);
    }

    #[test]
    fn the_journal_on_disk_carries_each_order_with_the_listing_it_was_admitted_under() {
        let live = trade();
        let records = records(&live.engine);
        let text: Vec<String> = records.iter().map(|r| encode(r).unwrap()).collect();
        let decoded = decode_all(&text.join("\n")).unwrap();
        // `toEqual(JSON.parse(JSON.stringify(records)))`: the same records, whatever the order of their keys.
        assert_eq!(decoded.len(), records.len());
        for (got, want) in decoded.iter().zip(&records) {
            assert!(
                super::same(&got.0, &want.0),
                "{} vs {}",
                got.0.compact(),
                want.0.compact()
            );
        }
        assert_eq!(replay(&decoded).serialize(), live.engine.serialize());
        let submit = decoded.iter().find(|r| r.kind() == Some("submit")).unwrap();
        let spread = submit.field("order").unwrap().get("spread").unwrap();
        assert_eq!(text_of(spread.get("instrument").unwrap(), "spreadId"), CAL);
        assert_eq!(text_of(spread, "anchorReference"), "59000");
    }

    fn text_of(j: &Json, key: &str) -> String {
        super::text(j, key)
    }

    #[test]
    fn a_recovered_journal_with_spread_fills_and_no_publisher_fails_closed_instead_of_dropping_the_fills()
     {
        let live = trade();
        let mut restarted = build_on(same_journal(&records(&live.engine)), false);
        let err = restarted.engine.recover().unwrap_err();
        assert!(err.to_string().contains("no publisher"), "{err}");
    }
}

mod book_hitch {
    use super::*;

    fn book_order(side: Side, qty: &str, price: &str, reference: &str) -> EngineOrder {
        with_spread(
            limit(if side == Side::Buy { "b" } else { "s" }, side, qty, price),
            instrument_of(&cal_listing()),
            reference,
        )
    }

    #[test]
    fn an_outright_order_on_a_spread_book_refuses_and_a_spread_order_on_a_traded_outright_book_refuses()
     {
        let mut spread_book = OrderBook::new(CAL);
        assert!(
            spread_book
                .submit(&book_order(Side::Sell, "1", "5", "100"), None)
                .accepted
        );
        let mut outright = book_order(Side::Buy, "1", "5", "100");
        outright.spread = None;
        assert_eq!(
            code(&spread_book.submit(&outright, None)),
            Some("spread_book_outright_refused")
        );

        let mut outright_book = OrderBook::new(CAL);
        let mut rest = book_order(Side::Sell, "1", "5", "100");
        rest.spread = None;
        assert!(outright_book.submit(&rest, None).accepted);
        assert_eq!(
            code(&outright_book.submit(&book_order(Side::Buy, "1", "5", "100"), None)),
            Some("spread_book_outright_refused")
        );
    }

    #[test]
    fn a_spread_order_for_another_spread_id_refuses_spread_identity_disagrees() {
        let mut book = OrderBook::new("SOMETHING-ELSE");
        assert_eq!(
            code(&book.submit(&book_order(Side::Sell, "1", "5", "100"), None)),
            Some("spread_identity_disagrees")
        );
    }

    #[test]
    fn a_spread_book_refuses_an_order_for_a_different_listing_of_the_same_id() {
        let mut book = OrderBook::new(CAL);
        assert!(
            book.submit(&book_order(Side::Sell, "1", "5", "100"), None)
                .accepted
        );
        let mut other_listing = cal_listing();
        other_listing.lot = Some("0.01".to_owned());
        let other = with_spread(
            limit("b", Side::Buy, "1", "5"),
            instrument_of(&other_listing),
            "100",
        );
        assert_eq!(
            code(&book.submit(&other, None)),
            Some("spread_identity_disagrees")
        );
    }

    #[test]
    fn native_amend_on_a_spread_book_refuses_at_the_book_too_replay_of_an_old_amend_record() {
        let mut book = OrderBook::new(CAL);
        let rest = book_order(Side::Sell, "1", "5", "100");
        book.submit(&rest, None);
        let amended = book.amend(
            &EngineAmend {
                order_id: rest.order_id.clone(),
                expected_version: 1,
                price: Some(a("5.5")),
                ..EngineAmend::default()
            },
            None,
        );
        assert_eq!(amended.rejected.unwrap().code, "spread_amend_unsupported");
    }

    #[test]
    fn a_refused_spread_takes_no_sequence() {
        let mut book = OrderBook::new(CAL);
        book.submit(&book_order(Side::Sell, "1", "-70", "100"), None);
        let sequence = book.current_sequence();
        assert_eq!(
            code(&book.submit(&book_order(Side::Buy, "1", "10", "60"), None)),
            Some("spread_leg_unfillable")
        );
        assert_eq!(book.current_sequence(), sequence);
    }
}

mod property {
    use super::*;

    /// Mulberry32: seeded, so a failure reproduces. JavaScript's `>>> 0`, `Math.imul` and `^` are u32 wrapping here.
    #[expect(
        clippy::float_arithmetic,
        reason = "the TypeScript's generator returns a JavaScript number in [0, 1)"
    )]
    fn prng(seed: u32) -> impl FnMut() -> f64 {
        let mut a = seed;
        move || {
            a = a.wrapping_add(0x6d2b_79f5);
            let mut t = a;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            f64::from(t ^ (t >> 14)) / 4_294_967_296.0
        }
    }

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::float_arithmetic,
        reason = "Math.floor of a value in [0, len)"
    )]
    fn pick<T: Copy>(rand: &mut impl FnMut() -> f64, items: &[T]) -> T {
        items[(rand() * items.len() as f64).floor() as usize]
    }

    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::float_arithmetic,
        reason = "Math.floor of a small value, as the TypeScript's Number()"
    )]
    fn on_grid(rand: &mut impl FnMut() -> f64, step: Amount, lo: i128, hi: i128) -> Amount {
        let k = lo + (rand() * (hi - lo + 1) as f64).floor() as i128;
        step * k
    }

    #[test]
    fn seed_every_fill_is_whole_and_in_ratio_refusals_change_nothing_replay_agrees() {
        for seed in [1u32, 7, 42, 2026] {
            let mut rand = prng(seed);
            let mut built = listed(&[cal_listing(), pair_listing()]);
            let instruments: HashMap<&str, SpreadInstrument> = HashMap::from([
                (CAL, instrument_of(&cal_listing())),
                (PAIR, instrument_of(&pair_listing())),
            ]);
            let mut live: Vec<(&str, String)> = Vec::new();
            let mut fills = 0usize;
            let mut refusals = 0usize;

            for _ in 0..300 {
                let spread_id = pick(&mut rand, &[CAL, PAIR]);
                let instrument = &instruments[spread_id];
                if rand() < 0.1 && !live.is_empty() {
                    #[expect(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        clippy::cast_precision_loss,
                        reason = "Math.floor of a value in [0, len)"
                    )]
                    let at = (rand() * live.len() as f64).floor() as usize;
                    let (victim_spread, victim_id) = live.remove(at);
                    built
                        .engine
                        .cancel(victim_spread, &victim_id, CancelReason::Requested)
                        .unwrap();
                    continue;
                }
                let reference = if spread_id == CAL {
                    on_grid(&mut rand, a("1"), 40, 160)
                } else {
                    on_grid(&mut rand, a("1"), 20, 80)
                };
                let price = on_grid(&mut rand, instrument.tick, -400, 400);
                let qty = on_grid(&mut rand, instrument.lot, 1, 300);
                let input = SpreadOrderInput {
                    order_id: uuid(),
                    account_id: pick(&mut rand, &["a", "b", "c", "d"]).to_owned(),
                    side: pick(&mut rand, &[Side::Buy, Side::Sell]),
                    qty,
                    price,
                    tif: Tif::Gtc,
                    anchor_reference: Some(reference),
                    client_order_id: None,
                    environment: None,
                    session_id: None,
                };

                let before = built.engine.serialize();
                let records = journal_len(&built.engine);
                let result = submit_spread(&mut built.engine, spread_id, &input);
                if !result.accepted {
                    refusals += 1;
                    assert!(result.fills.is_empty(), "seed {seed}");
                    assert_eq!(built.engine.serialize(), before, "seed {seed}");
                    assert_eq!(journal_len(&built.engine), records, "seed {seed}");
                    continue;
                }
                for fill in &result.fills {
                    fills += 1;
                    expect_whole_spread(fill, instrument);
                    // Each leg is exactly re-derivable from the journalled taker reference.
                    let again = spread_leg_fills(
                        instrument,
                        reference,
                        fill.price,
                        fill.qty,
                        fill.taker_side,
                    )
                    .unwrap();
                    assert_eq!(Some(&again), fill.legs.as_ref(), "seed {seed}");
                }
                if result.resting.is_some() {
                    live.push((spread_id, input.order_id.clone()));
                }
            }

            // The workload must actually fill and refuse, or the property is vacuous.
            assert!(fills > 10, "seed {seed}: {fills} fills");
            assert!(refusals > 0, "seed {seed}");

            // Every announced spread fill carries both legs.
            for event in built.published() {
                match event.payload.get("legs") {
                    Some(Json::Array(legs)) => assert_eq!(legs.len(), 2),
                    other => panic!("legs {other:?}"),
                }
            }

            // Replay of the journal reaches the same books and prints only whole spreads.
            let replayed = replay(&records(&built.engine));
            assert_eq!(
                replayed.serialize(),
                built.engine.serialize(),
                "seed {seed}"
            );
            assert_eq!(replayed.fills.len(), fills, "seed {seed}");
            for (market, fill) in &replayed.fills {
                expect_whole_spread(fill, &instruments[market.as_str()]);
            }
        }
    }
}

// ═══ spread-core-refuse.test.ts ══════════════════════════════════════════════════════════════════════════════════

mod core_book {
    use super::*;

    /// The TypeScript core book, unhitched, refused every spread order. The Rust book always runs the spread layer, so
    /// what is held is the reason for that refusal: a spread order never rests a price its legs cannot print, a
    /// refusal takes no sequence, and every fill it makes carries its legs.
    #[test]
    fn core_book_without_the_spread_hitch_a_spread_order_never_rests_or_matches_without_its_legs() {
        let listing = SpreadListingInput {
            spread_id: Some("BTC-CAL".to_owned()),
            kind: Some("calendar".to_owned()),
            legs: Some(vec![
                leg("BTC-27MAR", "sell", "1"),
                leg("BTC-26JUN", "buy", "1"),
            ]),
            tick: Some("0.5".to_owned()),
            lot: Some("0.001".to_owned()),
        };
        let instrument = instrument_of(&listing);
        let order = |id: &str, side: Side, price: &str| {
            let mut o = EngineOrder::new(
                id,
                "acct",
                OrderType::Limit,
                side,
                a("1"),
                Some(a(price)),
                Tif::Gtc,
            );
            o.spread = Some(SpreadTerms {
                instrument: instrument.clone(),
                anchor_reference: Some(a("100")),
            });
            o
        };
        let mut book = OrderBook::new("BTC-CAL");
        // Far = 100 - 150 = -50: no leg price, so no rest and no sequence.
        let unpriced = book.submit(
            &order("00000000-0000-4000-8000-000000000001", Side::Buy, "-150"),
            None,
        );
        assert_eq!(code(&unpriced), Some("spread_leg_unfillable"));
        assert_eq!(book.current_sequence(), 0);

        // The TypeScript's own order (-5 at 100: far 95) rests as a spread, and a fill against it prints both legs.
        let rest = book.submit(
            &order("00000000-0000-4000-8000-000000000002", Side::Buy, "-5"),
            None,
        );
        assert!(rest.accepted);
        let mut taker = order("00000000-0000-4000-8000-000000000003", Side::Sell, "-5");
        taker.account_id = "other".to_owned();
        let take = book.submit(&taker, None);
        assert_eq!(take.fills.len(), 1);
        expect_whole_spread(&take.fills[0], &instrument);
    }
}

// ═══ the doors: spread.router.test.ts and spread-fill-publisher.test.ts ═════════════════════════════════════════

mod doors {
    use super::*;

    pub const SECRET: &str = "matching-spread-router-secret-32chars!!";
    /// The door's clock: 2026-10-20T12:00:00.000Z, the proofs' time.
    const NOW_SECONDS: i64 = 1_792_497_600;

    fn door_now() -> i64 {
        NOW_SECONDS * 1000
    }

    pub const LISTING: &str = r#"{"kind":"calendar","legs":[{"symbol":"BTC-27MAR","side":"sell","ratio":"1"},{"symbol":"BTC-26JUN","side":"buy","ratio":"1"}],"tick":"0.5","lot":"0.001","operatorId":"ops-1","confirmOperatorId":"ops-confirm","approvalId":"appr-1","operationId":"op-1"}"#;

    /// `stubApprovalConsumer('ops-confirm')`, counting what it spends.
    struct Counting {
        inner: Stub,
        count: Arc<AtomicUsize>,
    }

    impl Approvals for Counting {
        fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
            self.count.fetch_add(1, Ordering::SeqCst);
            self.inner.consume(input)
        }
    }

    pub struct Mounted {
        pub door: MatchingDoor,
        pub bus: Bus,
        consumed: Arc<AtomicUsize>,
    }

    impl Mounted {
        pub fn consumed(&self) -> usize {
            self.consumed.load(Ordering::SeqCst)
        }

        /// The `spreadFills` publisher's rows.
        pub fn fills(&self) -> Vec<Published> {
            self.bus.emitted("spreadFilled")
        }
    }

    fn door_over(engine: MatchingEngine, bus: Bus) -> Mounted {
        let consumed = Arc::new(AtomicUsize::new(0));
        let door = MatchingDoor::new(
            DoorConfig {
                internal_secret: SECRET.to_owned(),
                body_bind: BodyBind::Require,
                keys: None,
                edge_secret: None,
                edge_key: None,
                clock: door_now,
                approvals: Box::new(Counting {
                    inner: Stub {
                        approver_id: "ops-confirm".to_owned(),
                        requester_id: "ops-1".to_owned(),
                    },
                    count: Arc::clone(&consumed),
                }),
                operator_ids: vec!["ops-1".to_owned(), "ops-confirm".to_owned()],
            },
            engine,
        )
        .unwrap();
        Mounted {
            door,
            bus,
            consumed,
        }
    }

    /// `mount()`: a memory journal, a bus, the spread fill publisher, the door with its approvals and operators.
    pub fn mount() -> Mounted {
        let bus = Bus::default();
        door_over(engine_on(MemoryJournal::new(), bus.clone(), true), bus)
    }

    /// `engine.halt(market, ...)`: the venue door's record, read back by a cold start under a fresh door.
    fn halted(m: &Mounted, market: &str) -> Mounted {
        let mut journal = same_journal(&records(&m.door.engine()));
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", Json::str("halt")),
                ("marketId", Json::str(market)),
                ("at", Json::str(Instant(door_now()).iso())),
                ("operatorId", Json::str("ops-1")),
                ("confirmOperatorId", Json::str("ops-confirm")),
            ])))
            .unwrap();
        let bus = Bus::default();
        let mut engine = engine_on(journal, bus.clone(), true);
        engine.recover().unwrap();
        door_over(engine, bus)
    }

    pub fn answer(
        m: &Mounted,
        method: &str,
        url: &str,
        body: Option<&str>,
        signed: bool,
    ) -> (u16, Json) {
        let payload = body.unwrap_or("");
        let mut headers = if signed {
            s2s::legacy_headers("svc-trade", SECRET, payload, NOW_SECONDS).unwrap()
        } else {
            Vec::new()
        };
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        match m.door.decide(&Request {
            method,
            url,
            headers: &headers,
            body: payload,
        }) {
            Outcome::Answer(r) => (
                r.status,
                if r.body.is_empty() {
                    Json::Null
                } else {
                    json::parse(&r.body).unwrap_or_else(|_| panic!("a JSON body: {}", r.body))
                },
            ),
            Outcome::Owed(slice) => panic!("{method} {url} is owed by {}", slice.name()),
        }
    }

    pub fn post(m: &Mounted, url: &str, body: &Json) -> (u16, Json) {
        answer(m, "POST", url, Some(&body.compact()), true)
    }

    pub fn get(m: &Mounted, url: &str) -> (u16, Json) {
        answer(m, "GET", url, None, false)
    }

    pub fn listing() -> Json {
        json::parse(LISTING).unwrap()
    }

    /// `createMarketLifecycleAdmissionProof(snapshot, 'PLACE')`: the snapshot as the TypeScript builds it, and its id
    /// the sha256 of that snapshot's JSON.
    pub fn proof_for(market_id: &str) -> Json {
        let observed_at = "2026-10-20T12:00:00.000Z";
        let snapshot = Json::obj([
            ("marketId", Json::str(market_id)),
            ("ruleVersion", Json::str("test.rules.v1")),
            ("instrumentId", Json::str(market_id)),
            ("instrumentVersion", Json::str("test.instrument.v1")),
            ("state", Json::str("OPEN")),
            ("reasonCategory", Json::str("NORMAL")),
            ("reasonCode", Json::str("trade.lifecycle.ready")),
            ("effectiveAt", Json::str(observed_at)),
            ("observedAt", Json::str(observed_at)),
            ("lastGoodState", Json::str("OPEN")),
            (
                "allowedActions",
                Json::Array(vec![Json::str("PLACE"), Json::str("PLACE_POST_ONLY")]),
            ),
            ("transitionId", Json::str("test.transition")),
            (
                "evidenceRefs",
                Json::Array(vec![Json::str("test.evidence")]),
            ),
        ]);
        let digest = Sha256::digest(snapshot.compact().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        Json::obj([
            ("action", Json::str("PLACE")),
            ("decision", Json::str("ELIGIBLE")),
            ("checkedAt", Json::str(observed_at)),
            (
                "snapshotId",
                Json::str(format!("trade.lifecycle.snapshot:{hex}")),
            ),
            ("transitionId", Json::str("test.transition")),
            (
                "evidenceRefs",
                Json::Array(vec![Json::str("test.evidence")]),
            ),
            ("snapshot", snapshot),
        ])
    }

    /// `orderBody(over)`.
    pub fn order_body(over: &[(&str, Json)]) -> Json {
        let mut fields: Vec<(String, Json)> = vec![
            (
                "orderId".into(),
                Json::str("11111111-1111-4111-8111-111111111111"),
            ),
            ("accountId".into(), Json::str("mm")),
            ("side".into(), Json::str("sell")),
            ("qty".into(), Json::str("2")),
            ("price".into(), Json::str("150")),
            ("tif".into(), Json::str("GTC")),
            ("anchorReference".into(), Json::str("60000")),
            ("lifecycleProof".into(), proof_for(CAL)),
        ];
        for (k, v) in over {
            match fields.iter_mut().find(|(f, _)| f == k) {
                Some(slot) => slot.1 = v.clone(),
                None => fields.push(((*k).to_owned(), v.clone())),
            }
        }
        Json::Object(fields)
    }

    fn book_url() -> String {
        format!("/spreads/{CAL}/book?limit=10")
    }

    fn list_url() -> String {
        format!("/spreads/{CAL}/list")
    }

    fn orders_url() -> String {
        format!("/spreads/{CAL}/orders")
    }

    fn j(text: &str) -> Json {
        json::parse(text).unwrap()
    }

    #[test]
    fn the_proof_hashes_its_snapshot_as_the_recording_does() {
        // The recording's proof for this market, taken at its own clock: the same construction must give its id.
        let recorded = "trade.lifecycle.snapshot:0b864e828707b03ccaf658f0af584b68f570e2b1801d7e405102c700136e8472";
        let snapshot = j(&format!(
            r#"{{"marketId":"{CAL}","ruleVersion":"test.rules.v1","instrumentId":"{CAL}","instrumentVersion":"test.instrument.v1","state":"OPEN","reasonCategory":"NORMAL","reasonCode":"trade.lifecycle.ready","effectiveAt":"2026-11-19T00:00:00.000Z","observedAt":"2026-11-19T00:00:00.000Z","lastGoodState":"OPEN","allowedActions":["PLACE","PLACE_POST_ONLY","AMEND"],"transitionId":"test.transition","evidenceRefs":["test.evidence"]}}"#
        ));
        let digest = Sha256::digest(snapshot.compact().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(format!("trade.lifecycle.snapshot:{hex}"), recorded);
    }

    // ── GET /spreads and /spreads/:id/book ──

    #[test]
    fn given_no_listing_the_list_is_empty_and_a_book_read_refuses_spread_unlisted() {
        let m = mount();
        let (status, list) = get(&m, "/spreads");
        assert_eq!(status, 200);
        assert!(same(&list, &j(r#"{"instruments":[]}"#)));

        let (status, book) = get(&m, &book_url());
        assert_eq!(status, 404);
        assert_eq!(text(&book, "code"), "spread_unlisted");
    }

    #[test]
    fn a_book_read_without_a_limit_refuses_rather_than_inventing_one() {
        let m = mount();
        let (status, _) = get(&m, &format!("/spreads/{CAL}/book"));
        assert_eq!(status, 400);
    }

    // ── POST /spreads/:id/list ──

    #[test]
    fn lists_through_dual_control_approval_the_list_and_the_book_show_it() {
        let m = mount();
        let (status, listed) = post(&m, &list_url(), &listing());
        assert_eq!(status, 200);
        assert_matches(
            &listed,
            &j(&format!(
                r#"{{"accepted":true,"spreadId":"{CAL}","alreadyListed":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null,"instrument":{{"spreadId":"{CAL}","kind":"calendar","tick":"0.5","lot":"0.001"}}}}"#
            )),
        );
        assert_eq!(m.consumed(), 1);

        let (_, list) = get(&m, "/spreads");
        assert!(
            same(
                list.get("instruments").unwrap(),
                &j(&format!(
                    r#"[{{"spreadId":"{CAL}","kind":"calendar","legs":[{{"symbol":"{NEAR}","side":"sell","ratio":"1"}},{{"symbol":"{FAR}","side":"buy","ratio":"1"}}],"tick":"0.5","lot":"0.001"}}]"#
                )),
            ),
            "{}",
            list.compact()
        );
        let (_, book) = get(&m, &book_url());
        assert_matches(
            &book,
            &j(&format!(
                r#"{{"spreadId":"{CAL}","bids":[],"asks":[],"bestBid":null,"bestAsk":null,"lastPrice":null}}"#
            )),
        );
    }

    #[test]
    fn a_blank_owner_field_refuses_typed_and_does_not_spend_the_approval() {
        let m = mount();
        let mut body = listing();
        if let Json::Object(fields) = &mut body {
            fields.iter_mut().find(|(k, _)| k == "tick").unwrap().1 = Json::str("");
        }
        let (status, refused) = post(&m, &list_url(), &body);
        assert_eq!(status, 200);
        assert_matches(
            &refused,
            &j(r#"{"accepted":false,"rejected":{"code":"spread_tick_missing"}}"#),
        );
        assert_eq!(m.consumed(), 0);
        assert!(m.door.engine().spread_instruments().is_empty());
    }

    #[test]
    fn an_unsigned_listing_is_401() {
        let m = mount();
        let (status, _) = answer(&m, "POST", &list_url(), Some(LISTING), false);
        assert_eq!(status, 401);
    }

    // ── POST /spreads/:id/orders ──

    #[test]
    fn rests_and_fills_at_the_spread_price_the_fill_carries_both_legs_as_decimal_strings() {
        let m = mount();
        post(&m, &list_url(), &listing());

        let (_, maker) = post(&m, &orders_url(), &order_body(&[]));
        assert_matches(
            &maker,
            &j(r#"{"accepted":true,"resting":{"price":"150","remaining":"2"}}"#),
        );
        let (_, book) = get(&m, &book_url());
        assert_matches(&book, &j(r#"{"asks":[["150","2"]],"bestAsk":"150"}"#));

        let (status, taker) = post(
            &m,
            &orders_url(),
            &order_body(&[
                ("orderId", Json::str("22222222-2222-4222-8222-222222222222")),
                ("accountId", Json::str("taker")),
                ("side", Json::str("buy")),
                ("qty", Json::str("2")),
                ("price", Json::str("155")),
            ]),
        );
        assert_eq!(status, 200);
        let want = j(&format!(
            r#"[{{"sequence":3,"makerOrderId":"11111111-1111-4111-8111-111111111111","makerAccountId":"mm","takerOrderId":"22222222-2222-4222-8222-222222222222","takerAccountId":"taker","takerSide":"buy","price":"150","qty":"2","legs":[{{"symbol":"{NEAR}","takerSide":"sell","qty":"2","price":"60000"}},{{"symbol":"{FAR}","takerSide":"buy","qty":"2","price":"60150"}}]}}]"#
        ));
        assert!(
            same(taker.get("fills").unwrap(), &want),
            "{}",
            taker.compact()
        );
        assert_eq!(m.fills().len(), 1);
        let (_, after) = get(&m, &book_url());
        assert_matches(&after, &j(r#"{"asks":[],"lastPrice":"150"}"#));
    }

    #[test]
    fn a_negative_spread_price_is_accepted_on_the_spread_door() {
        let m = mount();
        post(&m, &list_url(), &listing());
        let (_, negative) = post(
            &m,
            &orders_url(),
            &order_body(&[("side", Json::str("buy")), ("price", Json::str("-25"))]),
        );
        assert_matches(
            &negative,
            &j(r#"{"accepted":true,"resting":{"price":"-25"}}"#),
        );
        // The outright depth doors still read a spread book: decimal strings, and SBE refuses or encodes, never a 500.
        let (_, depth) = get(&m, &format!("/markets/{CAL}/depth?limit=10"));
        assert_matches(&depth, &j(r#"{"bids":[["-25","2"]],"asks":[]}"#));
        let (sbe, _) = get(&m, &format!("/markets/{CAL}/depth/sbe?limit=10"));
        assert!([200, 409].contains(&sbe), "{sbe}");
    }

    #[test]
    fn given_one_leg_halted_the_whole_spread_refuses() {
        let m = mount();
        post(&m, &list_url(), &listing());
        post(&m, &orders_url(), &order_body(&[]));
        let m = halted(&m, NEAR);
        let (_, refused) = post(
            &m,
            &orders_url(),
            &order_body(&[
                ("orderId", Json::str("33333333-3333-4333-8333-333333333333")),
                ("accountId", Json::str("taker")),
                ("side", Json::str("buy")),
            ]),
        );
        assert_matches(
            &refused,
            &j(r#"{"accepted":false,"fills":[],"rejected":{"code":"spread_leg_unavailable"}}"#),
        );
        assert_eq!(m.fills().len(), 0);
    }

    #[test]
    fn an_unlisted_spread_refuses_spread_unlisted_a_proof_for_another_market_is_400() {
        let m = mount();
        let (_, unlisted) = post(&m, &orders_url(), &order_body(&[]));
        assert_eq!(
            text(unlisted.get("rejected").unwrap(), "code"),
            "spread_unlisted"
        );
        let (status, _) = post(
            &m,
            &orders_url(),
            &order_body(&[("lifecycleProof", proof_for("BTC-USDT"))]),
        );
        assert_eq!(status, 400);
    }

    #[test]
    fn an_outright_order_on_the_spread_id_refuses_and_a_spread_order_cancels_through_the_normal_door()
     {
        let m = mount();
        post(&m, &list_url(), &listing());
        post(&m, &orders_url(), &order_body(&[]));

        let outright = Json::obj([
            ("orderId", Json::str("44444444-4444-4444-8444-444444444444")),
            ("accountId", Json::str("acct")),
            ("type", Json::str("limit")),
            ("side", Json::str("buy")),
            ("qty", Json::str("1")),
            ("price", Json::str("150")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof_for(CAL)),
        ]);
        let (_, refused) = post(&m, &format!("/markets/{CAL}/orders"), &outright);
        assert_eq!(
            text(refused.get("rejected").unwrap(), "code"),
            "spread_book_outright_refused"
        );

        let (status, cancel) = answer(
            &m,
            "DELETE",
            &format!("/markets/{CAL}/orders/11111111-1111-4111-8111-111111111111"),
            None,
            true,
        );
        assert_eq!(status, 200);
        assert_matches(&cancel, &j(r#"{"cancelled":true}"#));
    }

    // ── spread-fill-publisher.test.ts ──

    /// `/^[0-9a-fA-F]{8}-...{12}(:(tp|sl))?$/`.
    fn is_order_id(s: &str) -> bool {
        let id = s
            .strip_suffix(":tp")
            .or_else(|| s.strip_suffix(":sl"))
            .unwrap_or(s);
        let parts: Vec<&str> = id.split('-').collect();
        parts.len() == 5
            && parts
                .iter()
                .zip([8, 4, 4, 4, 12])
                .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    /// `amountSchema` (`signed`: `signedAmountSchema`).
    fn is_amount(s: &str, signed: bool) -> bool {
        let body = if signed {
            s.strip_prefix('-').unwrap_or(s)
        } else {
            s
        };
        let (int, frac) = body
            .split_once('.')
            .map_or((body, None), |(i, f)| (i, Some(f)));
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        digits(int) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
    }

    fn is_side(j: Option<&Json>) -> bool {
        matches!(j, Some(Json::String(s)) if s == "buy" || s == "sell")
    }

    fn nonempty(j: Option<&Json>) -> bool {
        matches!(j, Some(Json::String(s)) if !s.is_empty())
    }

    /// `EVENT_CATALOG.spreadFilled.schema.parse(payload)` gives the payload back unchanged: exactly the catalog's
    /// fields (zod strips any other), each of the catalog's type (`packages/events/src/catalog.ts`, `spreadFilled`).
    fn catalog_valid(p: &Json) -> bool {
        let Json::Object(fields) = p else {
            return false;
        };
        let mut keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort_unstable();
        let mut want = vec![
            "spreadId",
            "makerOrderId",
            "takerOrderId",
            "makerAccountId",
            "takerAccountId",
            "takerSide",
            "price",
            "qty",
            "sequence",
            "ts",
            "legs",
        ];
        want.sort_unstable();
        let s = |k: &str| match p.get(k) {
            Some(Json::String(s)) => s.clone(),
            _ => String::new(),
        };
        let legs_ok = match p.get("legs") {
            Some(Json::Array(legs)) => {
                legs.len() >= 2
                    && legs.iter().all(|l| {
                        let Json::Object(f) = l else { return false };
                        let ls = |k: &str| match l.get(k) {
                            Some(Json::String(s)) => s.clone(),
                            _ => String::new(),
                        };
                        f.len() == 4
                            && nonempty(l.get("symbol"))
                            && is_side(l.get("takerSide"))
                            && is_amount(&ls("qty"), false)
                            && is_amount(&ls("price"), false)
                    })
            }
            _ => false,
        };
        keys == want
            && nonempty(p.get("spreadId"))
            && is_order_id(&s("makerOrderId"))
            && is_order_id(&s("takerOrderId"))
            && nonempty(p.get("makerAccountId"))
            && nonempty(p.get("takerAccountId"))
            && is_side(p.get("takerSide"))
            && is_amount(&s("price"), true)
            && is_amount(&s("qty"), false)
            && matches!(p.get("sequence"), Some(Json::Number(n)) if n.fract() == 0.0)
            && service_kit::time::zod_datetime(&s("ts"), true).is_some()
            && legs_ok
    }

    #[test]
    fn a_negative_price_spread_fill_reaches_the_bus_once_catalog_valid_keyed_by_the_journal_key() {
        let m = mount();
        let (status, _) = post(&m, &list_url(), &listing());
        assert_eq!(status, 200);

        let (_, maker) = post(
            &m,
            &orders_url(),
            &order_body(&[
                ("orderId", Json::str("11111111-1111-4111-8111-111111111111")),
                ("accountId", Json::str("mm")),
                ("side", Json::str("sell")),
                ("price", Json::str("-25")),
            ]),
        );
        assert_matches(&maker, &j(r#"{"accepted":true,"resting":{"price":"-25"}}"#));
        let (status, taker) = post(
            &m,
            &orders_url(),
            &order_body(&[
                ("orderId", Json::str("22222222-2222-4222-8222-222222222222")),
                ("accountId", Json::str("taker")),
                ("side", Json::str("buy")),
                ("price", Json::str("-20")),
            ]),
        );
        assert_eq!(status, 200);
        match taker.get("fills") {
            Some(Json::Array(f)) => assert_eq!(f.len(), 1),
            other => panic!("fills {other:?}"),
        }

        let sent = m.fills();
        assert_eq!(sent.len(), 1);
        let env = &sent[0];
        assert_eq!(env.name, "spreadFilled");
        // The catalog schema is what svc-trade's consumer parses with; the envelope must pass it unchanged.
        assert!(catalog_valid(&env.payload), "{}", env.payload.compact());
        assert_matches(
            &env.payload,
            &j(&format!(
                r#"{{"spreadId":"{CAL}","makerOrderId":"11111111-1111-4111-8111-111111111111","takerOrderId":"22222222-2222-4222-8222-222222222222","makerAccountId":"mm","takerAccountId":"taker","takerSide":"buy","price":"-25","qty":"2","legs":[{{"symbol":"{NEAR}","takerSide":"sell","qty":"2","price":"60000"}},{{"symbol":"{FAR}","takerSide":"buy","qty":"2","price":"59975"}}]}}"#
            )),
        );
        // No outright print for a spread fill: svc-trade must never settle it as an order.filled trade.
        assert_eq!(m.bus.emitted("orderFilled").len(), 0);
        // The envelope carries the engine's journal key, which the consumer dedupes on.
        let Some(Json::Number(sequence)) = env.payload.get("sequence") else {
            panic!("sequence")
        };
        assert_eq!(env.key, format!("matching.spread.filled:{CAL}:{sequence}"));
    }
}

// ═══ JSON comparison ═════════════════════════════════════════════════════════════════════════════════════════════

/// `toEqual`: the same value, whatever the order of an object's keys.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.iter().any(|(k2, v2)| k == k2 && same(v, v2)))
        }
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        _ => a == b,
    }
}

/// `toMatchObject`: every key `expected` names holds a value that matches; arrays match element for element.
fn matches_object(actual: &Json, expected: &Json) -> bool {
    match (actual, expected) {
        (Json::Object(_), Json::Object(want)) => want
            .iter()
            .all(|(k, v)| actual.get(k).is_some_and(|got| matches_object(got, v))),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| matches_object(v, w))
        }
        _ => actual == expected,
    }
}

fn assert_matches(actual: &Json, expected: &Json) {
    assert!(
        matches_object(actual, expected),
        "{}\n  does not match {}",
        actual.compact(),
        expected.compact()
    );
}
