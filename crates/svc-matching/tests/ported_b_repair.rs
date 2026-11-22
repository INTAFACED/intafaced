//! Ported from the TypeScript service's \`recovery-repair-native.test.ts\` ("native matching review repairs"): each of its
//! seven scenarios (\`bracket\`, \`quote\`, \`quote-pair\`, \`expiry\`, \`gtt\`, \`option\`, \`codec\`) is one test here, on the
//! real Rust engine over its real file journal on disk. The TypeScript runs each in a child Node process to keep the
//! production install order of its prototype wrappers; the Rust engine has no install order (its layers are one
//! chain), so the scenarios run in-process. "Reopen" is what it is in the TypeScript: the engine is dropped (closing
//! its journal and releasing the writer lock), the file is opened again and a fresh engine recovers from it.
//!
//! Where the port differs, by scenario:
//! - \`quote\` and \`quote-pair\` replace \`fs.fsyncSync\` with one that syncs and then throws. Rust's \`File::sync_all\`
//!   cannot be replaced from a test, so the journal under the engine is [\`AckLost\`]: a real \`FileJournal\` whose chosen
//!   append is written and fsynced, and then reported failed, after which it admits nothing (\`journal_io_unknown\`).
//!   That is exactly what \`FileJournal\` itself does when \`sync_all\` fails after a whole write: the record may be
//!   durable, it is not admitted, and the latch holds until a reopen.
//! - The client order id claims those two scenarios assert (\`client_order_id_reuse\` on a retry after reopen) are their
//!   own tests, the \`defect_*\` ones, named for the defect they first caught: the Rust engine had no claim. It has one
//!   now (\`src/engine/client_ids.rs\`), rebuilt from the journal on reopen, and they pass.
//! - \`codec\`'s \`amend({ ..., replace: true })\` refusing \`amend_field_unsupported\` before the journal: \`EngineAmend\` is
//!   a struct with no \`replace\` (nor any other unknown) field, so no Rust call can carry one; the door's amend schema
//!   does not read it either. The rest of \`codec\` (the patch codec's omitted fields, its round trip and explicit nulls,
//!   and replay to the same state) is ported.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use svc_matching::book::types::{EngineAmend, EngineOrder, Opt, OrderType, Side, Tif};
use svc_matching::book::wire::{from_wire_amend, to_wire_amend};
use svc_matching::engine::liquidity::MassQuote;
use svc_matching::engine::{EngineParts, EventBus, MatchingEngine, MemoryEventBus, Published};
use svc_matching::journal::replay::MemorySnapshotSink;
use svc_matching::journal::{
    EngineJournal, FileJournal, JournalCommand, JournalError, JournalRecord,
};

/// 2026-10-11T00:00:00Z.
const START_MS: i64 = 1_791_676_800_000;
/// 2026-10-11T01:30:00Z.
const LATER_MS: i64 = 1_791_682_200_000;

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(START_MS) };
}

/// \`clock = () => new Date(instant)\`, \`instant\` settable per test thread.
fn clock() -> i64 {
    NOW.with(Cell::get)
}

fn set_now(ms: i64) {
    NOW.with(|n| n.set(ms));
}

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn p(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// \`order(n, accountId, side)\`: a GTC limit of 1 at 100.
fn order(n: u32, account: &str, side: Side) -> EngineOrder {
    EngineOrder::new(
        id(n),
        account,
        OrderType::Limit,
        side,
        p("1"),
        Some(p("100")),
        Tif::Gtc,
    )
}

fn priced(mut o: EngineOrder, price: &str) -> EngineOrder {
    o.price = Some(p(price));
    o
}

fn client(mut o: EngineOrder, client_order_id: &str) -> EngineOrder {
    o.client_order_id = Some(client_order_id.to_owned());
    o.environment = Some("paper".to_owned());
    o
}

#[derive(Clone, Default)]
struct Bus {
    seen: Arc<Mutex<Vec<Published>>>,
}

impl EventBus for Bus {
    fn publish(&mut self, name: &str, payload: &Json, key: &str) -> Result<(), String> {
        let mut inner = MemoryEventBus::default();
        inner.publish(name, payload, key)?;
        self.seen.lock().unwrap().extend(inner.published);
        Ok(())
    }
}

impl Bus {
    fn emitted(&self, name: &str) -> Vec<Published> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name == name)
            .cloned()
            .collect()
    }

    /// \`fillPayloads(bus)\`.
    fn fill_payloads(&self) -> Vec<Json> {
        self.emitted("orderFilled")
            .into_iter()
            .map(|e| e.payload)
            .collect()
    }

    fn fill_keys(&self) -> Vec<String> {
        self.emitted("orderFilled")
            .into_iter()
            .map(|e| e.key)
            .collect()
    }

    fn published(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

/// A real file journal whose \`fail_on\`-th append (counted from its making) is written and fsynced and then reported
/// failed, as \`FileJournal\` reports a \`sync_all\` that fails after a whole write: the record is not admitted, and every
/// later append is refused \`journal_io_unknown\` until the file is opened again.
struct AckLost {
    inner: FileJournal,
    fail_on: usize,
    appends: usize,
    why: &'static str,
    latched: bool,
    visible: usize,
}

impl AckLost {
    fn open(path: &Path, fail_on: usize, why: &'static str) -> AckLost {
        let inner = FileJournal::open(path).unwrap();
        let visible = inner.len();
        AckLost {
            inner,
            fail_on,
            appends: 0,
            why,
            latched: false,
            visible,
        }
    }
}

impl EngineJournal for AckLost {
    fn append(&mut self, command: &JournalCommand) -> Result<JournalRecord, JournalError> {
        if self.latched {
            return Err(JournalError::IoUnknown);
        }
        self.appends += 1;
        let record = self.inner.append(command)?;
        if self.appends == self.fail_on {
            self.latched = true;
            return Err(JournalError::Io(std::io::Error::other(self.why)));
        }
        self.visible = self.inner.len();
        Ok(record)
    }

    fn read(&self) -> &[JournalRecord] {
        &self.inner.read()[..self.visible]
    }

    fn len(&self) -> usize {
        self.visible
    }

    fn close(&mut self) -> Result<(), JournalError> {
        self.inner.close()
    }
}

fn engine_on(journal: Box<dyn EngineJournal + Send>, bus: Bus) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(bus),
        clock,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

fn temp_dir(prefix: &str) -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("{prefix}{name}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// One scenario's journal file, removed when the scenario ends.
struct Scenario {
    dir: PathBuf,
    path: PathBuf,
}

impl Scenario {
    fn new() -> Scenario {
        set_now(START_MS);
        let dir = temp_dir("matching-repair-native-");
        let path = dir.join("journal.ndjson");
        Scenario { dir, path }
    }

    fn live(&self, bus: Bus) -> MatchingEngine {
        engine_on(Box::new(FileJournal::open(&self.path).unwrap()), bus)
    }

    /// \`reopen()\`: a fresh engine and bus on the journal opened again, recovered.
    fn reopen(&self) -> (MatchingEngine, Bus) {
        let bus = Bus::default();
        let mut recovered = self.live(bus.clone());
        recovered.recover().unwrap();
        (recovered, bus)
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn live_ids(engine: &MatchingEngine, market: &str) -> Vec<String> {
    let mut ids: Vec<String> = engine
        .resting_orders(Some(market))
        .into_iter()
        .map(|r| r.order_id)
        .collect();
    ids.sort();
    ids
}

fn records_of<'a>(engine: &'a MatchingEngine, kind: &str) -> Vec<&'a JournalRecord> {
    engine
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some(kind))
        .collect()
}

fn code(r: Option<&svc_matching::book::types::Reject>) -> Option<&str> {
    r.map(|r| r.code.as_str())
}

fn text(j: Option<&Json>) -> String {
    match j {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not text: {other:?}"),
    }
}

// ── bracket ─────────────────────────────────────────────────────────────

#[test]
fn bracket_preserves_actual_effects_and_durable_replay() {
    let s = Scenario::new();
    let bus = Bus::default();
    let mut engine = s.live(bus.clone());
    engine
        .submit("B", &priced(order(1, "unrelated", Side::Buy), "20"), None)
        .unwrap();
    engine
        .submit("B", &order(2, "maker", Side::Sell), None)
        .unwrap();
    let mut entry = priced(order(3, "desk", Side::Buy), "90");
    entry.exits.bracket = Opt::Some(true);
    entry.exits.take_profit = Opt::Some(p("110"));
    entry.exits.stop_loss = Opt::Some(p("80"));
    entry.exits.take_profit_order_id = Opt::Some(id(4));
    entry.exits.stop_loss_order_id = Opt::Some(id(1));
    let placed = engine.submit("B", &entry, None).unwrap();
    assert!(placed.accepted, "{:?}", placed.rejected);

    let amend = EngineAmend {
        order_id: id(3),
        expected_version: 1,
        price: Some(p("100")),
        ..EngineAmend::default()
    };
    let result = engine.amend("B", &amend, None).unwrap();
    assert!(!result.accepted);
    assert_eq!(result.fills.len(), 1);
    assert_eq!(code(result.rejected.as_ref()), Some("duplicate_order_id"));
    let fills: Vec<(String, String, String)> = bus
        .fill_payloads()
        .iter()
        .map(|f| {
            (
                text(f.get("makerOrderId")),
                text(f.get("takerOrderId")),
                text(f.get("qty")),
            )
        })
        .collect();
    assert_eq!(fills, [(id(2), id(3), "1".to_owned())]);
    assert!(
        result.cancellations.iter().any(|c| c.order_id == id(4)),
        "rollback cancellation must be returned: {:?}",
        result.cancellations
    );
    let cancelled: Vec<String> = bus
        .emitted("orderCancelled")
        .iter()
        .map(|e| text(e.payload.get("orderId")))
        .collect();
    assert_eq!(cancelled, [id(4)]);
    let resting = live_ids(&engine, "B");
    assert!(resting.contains(&id(1)), "{resting:?}");
    assert!(!resting.contains(&id(4)), "{resting:?}");

    let again = engine.amend("B", &amend, None).unwrap();
    assert!(!again.accepted);
    assert_eq!(bus.fill_payloads().len(), 1);
    assert_eq!(bus.emitted("orderCancelled").len(), 1);

    let state = engine.serialize();
    drop(engine);
    let (recovered, recovered_bus) = s.reopen();
    assert_eq!(recovered.serialize(), state);
    assert_eq!(recovered_bus.fill_payloads(), bus.fill_payloads());
    assert_eq!(recovered_bus.fill_keys(), bus.fill_keys());
}

// ── quote ───────────────────────────────────────────────────────────────

/// The \`quote\` scenario up to its reopen: the one-sided quote's only append is written and its ACK lost.
fn quote_ack_lost(s: &Scenario) -> MatchingEngine {
    let bus = Bus::default();
    let journal = AckLost::open(&s.path, 1, "actual fsync ACK lost");
    let mut engine = engine_on(Box::new(journal), bus.clone());
    let outcome = engine.mass_quote(&MassQuote {
        set_id: "original-quote".to_owned(),
        market_id: "Q".to_owned(),
        account_id: "desk".to_owned(),
        one_sided: true,
        bid: Some(client(order(20, "desk", Side::Buy), "original-client")),
        ask: None,
        lifecycle_proof: None,
    });
    let Err(error) = outcome else {
        panic!("unknown cannot return a result: {outcome:?}")
    };
    assert!(
        error.to_string().contains("actual fsync ACK lost"),
        "{error}"
    );
    assert_eq!(engine.resting_order_count(), 0);
    assert_eq!(engine.journal().len(), 0);
    assert_eq!(bus.published(), 0);
    drop(engine);
    let (recovered, _) = s.reopen();
    assert_eq!(live_ids(&recovered, "Q"), [id(20)]);
    assert_eq!(records_of(&recovered, "submit").len(), 1);
    let original = &recovered.journal().read()[0];
    let row = original.field("order").unwrap();
    assert_eq!(
        row.get("clientOrderId"),
        Some(&Json::str("original-client"))
    );
    assert_eq!(row.get("environment"), Some(&Json::str("paper")));
    recovered
}

#[test]
fn quote_preserves_actual_effects_and_durable_replay() {
    let s = Scenario::new();
    let recovered = quote_ack_lost(&s);
    assert_eq!(recovered.journal().len(), 1);
}

#[test]
fn defect_quote_a_reopened_engine_refuses_the_durable_quotes_client_id() {
    let s = Scenario::new();
    let mut recovered = quote_ack_lost(&s);
    let retry = recovered
        .submit(
            "Q",
            &client(order(21, "desk", Side::Buy), "original-client"),
            None,
        )
        .unwrap();
    assert_eq!(code(retry.rejected.as_ref()), Some("client_order_id_reuse"));
    assert_eq!(recovered.journal().len(), 1);
    assert_eq!(live_ids(&recovered, "Q"), [id(20)]);
}

// ── quote-pair ──────────────────────────────────────────────────────────

/// The \`quote-pair\` scenario up to and through its reopen: the bid takes half the maker and rests, the ask's append
/// is written and its ACK lost.
fn quote_pair_ack_lost(s: &Scenario) -> MatchingEngine {
    let bus = Bus::default();
    // Append 1 is the maker, 2 the bid, 3 the ask.
    let journal = AckLost::open(&s.path, 3, "second quote fsync ACK lost");
    let mut engine = engine_on(Box::new(journal), bus.clone());
    engine
        .submit("Q", &order(61, "maker", Side::Sell), None)
        .unwrap();
    let mut bid = client(order(62, "desk", Side::Buy), "pair-bid");
    bid.qty = p("2");
    let ask = client(priced(order(63, "desk", Side::Sell), "110"), "pair-ask");
    let outcome = engine.mass_quote(&MassQuote {
        set_id: "original-pair".to_owned(),
        market_id: "Q".to_owned(),
        account_id: "desk".to_owned(),
        one_sided: false,
        bid: Some(bid),
        ask: Some(ask),
        lifecycle_proof: None,
    });
    let Err(error) = outcome else {
        panic!("unknown cannot return a result: {outcome:?}")
    };
    assert!(
        error.to_string().contains("second quote fsync ACK lost"),
        "{error}"
    );
    // The bid's print stands and is not undone.
    assert_eq!(bus.fill_payloads().len(), 1);
    assert_eq!(bus.emitted("orderCancelled").len(), 0);
    assert_eq!(live_ids(&engine, "Q"), [id(62)]);
    assert!(records_of(&engine, "cancel").is_empty());
    let state_fills = bus.fill_payloads();
    let state_keys = bus.fill_keys();
    drop(engine);
    let (recovered, recovered_bus) = s.reopen();
    assert_eq!(live_ids(&recovered, "Q"), [id(62), id(63)]);
    assert_eq!(recovered_bus.fill_payloads(), state_fills);
    assert_eq!(recovered_bus.fill_keys(), state_keys);
    assert_eq!(records_of(&recovered, "submit").len(), 3);
    recovered
}

#[test]
fn quote_pair_preserves_actual_effects_and_durable_replay() {
    let s = Scenario::new();
    let recovered = quote_pair_ack_lost(&s);
    assert_eq!(recovered.journal().len(), 3);
}

#[test]
fn defect_quote_pair_a_reopened_engine_refuses_both_durable_quote_client_ids() {
    let s = Scenario::new();
    let mut recovered = quote_pair_ack_lost(&s);
    for (n, side, client_order_id) in [(64, Side::Buy, "pair-bid"), (65, Side::Sell, "pair-ask")] {
        let retry = recovered
            .submit("Q", &client(order(n, "desk", side), client_order_id), None)
            .unwrap();
        assert_eq!(
            code(retry.rejected.as_ref()),
            Some("client_order_id_reuse"),
            "{client_order_id}"
        );
    }
    assert_eq!(records_of(&recovered, "submit").len(), 3);
}

// ── expiry and gtt ──────────────────────────────────────────────────────

fn amended_deadline_replays(tif: Tif) {
    let s = Scenario::new();
    let bus = Bus::default();
    let mut engine = s.live(bus.clone());
    let mut maker = order(31, "maker", Side::Sell);
    maker.tif = tif;
    maker.expire_at = Some("2026-10-11T02:00:00Z".to_owned());
    let placed = engine.submit("E", &maker, None).unwrap();
    assert!(placed.accepted, "{:?}", placed.rejected);
    let result = engine
        .amend(
            "E",
            &EngineAmend {
                order_id: id(31),
                expected_version: 1,
                expire_at: Some("2026-10-11T01:00:00Z".to_owned()),
                ..EngineAmend::default()
            },
            None,
        )
        .unwrap();
    assert!(result.accepted, "{:?}", result.rejected);

    set_now(LATER_MS);
    let take = engine
        .submit("E", &order(32, "taker", Side::Buy), None)
        .unwrap();
    assert!(take.fills.is_empty(), "{:?}", take.fills);
    let cancelled: Vec<String> = take
        .cancellations
        .iter()
        .map(|c| c.order_id.clone())
        .collect();
    assert_eq!(cancelled, [id(31)]);
    let amend_row = records_of(&engine, "amend")[0].clone();
    assert_eq!(
        amend_row.field("patch").and_then(|p| p.get("expireAt")),
        Some(&Json::str("2026-10-11T01:00:00Z"))
    );
    let state = engine.serialize();
    drop(engine);
    let (recovered, recovered_bus) = s.reopen();
    assert_eq!(recovered.serialize(), state);
    assert!(recovered_bus.fill_payloads().is_empty());
    assert!(!live_ids(&recovered, "E").contains(&id(31)));
}

#[test]
fn expiry_preserves_actual_effects_and_durable_replay() {
    amended_deadline_replays(Tif::Gtd);
}

#[test]
fn gtt_preserves_actual_effects_and_durable_replay() {
    amended_deadline_replays(Tif::Gtt);
}

// ── option ──────────────────────────────────────────────────────────────

const OPTION_EXPIRY: &str = "2026-12-31T00:00:00Z";

fn terms(mut o: EngineOrder) -> EngineOrder {
    o.strike = Opt::Some(p("120"));
    o.expiry = Opt::Some(OPTION_EXPIRY.to_owned());
    o
}

#[test]
fn option_preserves_actual_effects_and_durable_replay() {
    let s = Scenario::new();
    let bus = Bus::default();
    let mut engine = s.live(bus.clone());
    engine
        .submit(
            "O",
            &terms(priced(order(41, "writer", Side::Sell), "11")),
            None,
        )
        .unwrap();
    engine
        .submit(
            "O",
            &terms(priced(order(42, "holder", Side::Buy), "9")),
            None,
        )
        .unwrap();
    let amended = engine
        .amend(
            "O",
            &EngineAmend {
                order_id: id(42),
                expected_version: 1,
                price: Some(p("11")),
                strike: Opt::Some(p("120")),
                expiry: Opt::Some(OPTION_EXPIRY.to_owned()),
                ..EngineAmend::default()
            },
            None,
        )
        .unwrap();
    assert!(amended.accepted, "{:?}", amended.rejected);
    assert_eq!(amended.fills.len(), 1);
    let row = records_of(&engine, "amend")[0].clone();
    assert_eq!(
        row.field("patch"),
        Some(&Json::obj([
            ("price", Json::str("11")),
            ("strike", Json::str("120")),
            ("expiry", Json::str(OPTION_EXPIRY)),
        ]))
    );
    let state = engine.serialize();
    drop(engine);
    let (recovered, recovered_bus) = s.reopen();
    assert_eq!(recovered.serialize(), state);
    assert_eq!(recovered_bus.fill_payloads(), bus.fill_payloads());
    assert_eq!(recovered.resting_order_count(), 0);
}

// ── codec ───────────────────────────────────────────────────────────────

#[test]
fn codec_preserves_actual_effects_and_durable_replay() {
    let bare = EngineAmend {
        order_id: id(51),
        expected_version: 1,
        ..EngineAmend::default()
    };
    assert_eq!(to_wire_amend(&bare), Json::Object(Vec::new()));

    let patched = EngineAmend {
        qty: Some(p("0.000000000000000001")),
        price: Some(p("12")),
        stop_price: Some(p("9")),
        tif: Some(Tif::Gtd),
        expire_at: Some("2026-10-11T02:00:00Z".to_owned()),
        strike: Opt::Some(p("120")),
        expiry: Opt::Some(OPTION_EXPIRY.to_owned()),
        ..bare.clone()
    };
    assert_eq!(format_amount(patched.qty.unwrap()), "0.000000000000000001");
    assert_eq!(
        from_wire_amend(&id(51), 1, &to_wire_amend(&patched)).unwrap(),
        patched
    );
    let invalid = EngineAmend {
        strike: Opt::Null,
        expiry: Opt::Null,
        ..bare.clone()
    };
    assert_eq!(
        to_wire_amend(&invalid),
        Json::obj([("strike", Json::Null), ("expiry", Json::Null)])
    );
    assert_eq!(
        from_wire_amend(&id(51), 1, &to_wire_amend(&invalid)).unwrap(),
        invalid
    );

    let s = Scenario::new();
    let mut engine = s.live(Bus::default());
    engine
        .submit("U", &order(51, "maker", Side::Sell), None)
        .unwrap();
    let state = engine.serialize();
    drop(engine);
    let (recovered, _) = s.reopen();
    assert_eq!(recovered.serialize(), state);
}
