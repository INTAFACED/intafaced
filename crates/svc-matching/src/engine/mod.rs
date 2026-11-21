//! The engine (`engine.ts`): one book per market, every input journalled before its book moves, the order events, the
//! periodic snapshot, and the cold start that replays the journal back to the same books.
//!
//! The TypeScript wraps `MatchingEngine` and `OrderBook` with modules that install themselves on import. For a plain
//! order every one of them passes it through but two, and this holds those two as the engine's own steps: the declared
//! split-brain fence (`cod-fence.ts`) and its mass cancel, which pulls each order through `cancel`. What the others add
//! belongs to their slices, and the door owes an order that needs one (`door::book`).
//!
//! The market modes (halt, maintenance, prelaunch, reduce-only, post-only, expiry, delisting, the venue halt) and dead
//! sessions are switched by the `venue` slice's doors. Here they are read back from the journal on a cold start and
//! every submit and amend is gated on them, as the base engine gates them.

pub mod reconcile;

use std::collections::{HashMap, HashSet};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

use crate::approval::dual_control_refuse;
use crate::book::order_book::{OrderBook, QueueLevel};
use crate::book::rules::{mass_cancel_session_refuse, read_session_id};
use crate::book::types::{
    AmendResult, CancelReason, CancelResult, CancelledRef, EngineAmend, EngineOrder, Fill,
    OrderType, Reject, RestKind, Side, SubmitResult, Tif, TriggerFact, seq_json,
};
use crate::book::wire::{WireError, from_wire, from_wire_amend, to_wire, to_wire_amend};
use crate::door::Slice;
use crate::journal::JournalError;
use crate::journal::io::EngineJournal;
use crate::journal::record::{JournalCommand, JournalRecord, js_string};
use crate::journal::replay::{
    EngineSnapshot, ReplayBooks, ReplayCancel, SnapshotSink, js_sort_cmp, replay_journal,
    snapshot_due,
};
use crate::rulebook::{self, Draft, Version};

/// Where the order events go (`EventBus`): the topic, the payload and its idempotency key.
pub trait EventBus {
    fn publish(&mut self, name: &str, payload: &Json, idempotency_key: &str) -> Result<(), String>;
}

/// One event a [`MemoryEventBus`] kept.
#[derive(Debug, Clone, PartialEq)]
pub struct Published {
    pub name: String,
    pub payload: Json,
    pub key: String,
}

/// For tests: keeps every event in order.
#[derive(Debug, Default)]
pub struct MemoryEventBus {
    pub published: Vec<Published>,
}

impl EventBus for MemoryEventBus {
    fn publish(&mut self, name: &str, payload: &Json, idempotency_key: &str) -> Result<(), String> {
        self.published.push(Published {
            name: name.to_owned(),
            payload: payload.clone(),
            key: idempotency_key.to_owned(),
        });
        Ok(())
    }
}

/// Why an engine call stopped: where the TypeScript throws.
#[derive(Debug)]
pub enum EngineError {
    /// The journal refused the record: nothing moved.
    Journal(JournalError),
    /// The bus refused an event; the book had already moved, as it has in the TypeScript.
    Publish(String),
    /// The journal holds a record this port cannot replay yet, or one that does not read.
    Replay(String),
    /// A cold start met state a later slice owns.
    Owed { slice: Slice, why: String },
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Journal(e) => write!(f, "journal: {e}"),
            EngineError::Publish(e) => write!(f, "event bus: {e}"),
            EngineError::Replay(e) => write!(f, "replay: {e}"),
            EngineError::Owed { slice, why } => {
                write!(f, "{why} (slice {} is not ported)", slice.name())
            }
        }
    }
}

impl std::error::Error for EngineError {}

impl From<JournalError> for EngineError {
    fn from(e: JournalError) -> Self {
        EngineError::Journal(e)
    }
}

/// What the engine is put together from, once (`MatchingEngineOptions`).
pub struct EngineParts {
    pub journal: Box<dyn EngineJournal + Send>,
    pub bus: Box<dyn EventBus + Send>,
    /// Milliseconds since the epoch: the time each record is stamped with.
    pub clock: fn() -> i64,
    /// `options.clock` was given, so GTD and GTT expire on it (`expiryClock`). Without it they refuse.
    pub expiry_clock: bool,
    /// `MATCHING_SNAPSHOT_EVERY`: snapshot every this many records; 0 never. The owner sets it; there is no default.
    pub snapshot_every: u64,
    pub sink: Box<dyn SnapshotSink<Json> + Send>,
    /// `MATCHING_ENGINE_ENABLED`.
    pub enabled: bool,
}

/// One live order, as the engine lists it (`EngineLiveOrder`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineLiveOrder {
    pub market_id: String,
    pub order_id: String,
    pub account_id: String,
    pub kind: RestKind,
    pub side: Side,
    pub price: Amount,
    pub remaining: Amount,
    pub sequence: u64,
    pub version: u64,
}

impl EngineLiveOrder {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("marketId", Json::str(self.market_id.clone())),
            ("orderId", Json::str(self.order_id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("kind", Json::str(self.kind.as_str())),
            ("side", Json::str(self.side.as_str())),
            ("price", Json::str(format_amount(self.price))),
            ("remaining", Json::str(format_amount(self.remaining))),
            ("sequence", seq_json(self.sequence)),
            ("version", seq_json(self.version)),
        ])
    }
}

/// L2 as the engine answers it: each level's price and visible size, and the book's sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Depth {
    pub bids: Vec<(Amount, Amount)>,
    pub asks: Vec<(Amount, Amount)>,
    pub sequence: u64,
}

/// The native L3 queue (`L3Queue`): each level's price and its orders' ids, remaining and sequences, in queue order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct L3Queue {
    pub market_id: String,
    pub sequence: u64,
    pub bids: Vec<QueueLevel>,
    pub asks: Vec<QueueLevel>,
}

/// What a mass cancel answers (`MassCancelResult`, with cod-fence's `failed`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MassCancelResult {
    pub accepted: bool,
    pub account_id: String,
    pub cancellations: Vec<CancelledRef>,
    /// The ids whose cancel was refused, and why.
    pub failed: Vec<(String, String)>,
    pub rejected: Option<Reject>,
}

/// The public modes of one market (`publicMatchingFlags`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flags {
    pub venue_halted: bool,
    pub halted: bool,
    pub prelaunch: bool,
    pub expired: bool,
    pub delisted: bool,
    pub reduce_only: bool,
    pub post_only: bool,
}

/// The modes the venue doors switch, as the journal last left them.
#[derive(Debug, Default)]
struct Modes {
    halted: HashSet<String>,
    halted_since: HashMap<String, Option<String>>,
    maintenance: HashSet<String>,
    venue_halted: bool,
    venue_halted_at: Option<String>,
    reduce_only: HashSet<String>,
    post_only: HashSet<String>,
    prelaunch: HashSet<String>,
    listed: HashSet<String>,
    expired: HashSet<String>,
    delisted: HashSet<String>,
    dead_sessions: HashSet<String>,
    split_brain: bool,
}

/// An event before it goes out, with the sequence it sorts by.
struct Pending {
    sequence: u64,
    name: &'static str,
    payload: Json,
    key: String,
}

fn filled_event(market_id: &str, fill: &Fill, at: &str) -> Pending {
    Pending {
        sequence: fill.sequence,
        name: "orderFilled",
        payload: Json::obj([
            ("marketId", Json::str(market_id)),
            ("makerOrderId", Json::str(fill.maker_order_id.clone())),
            ("takerOrderId", Json::str(fill.taker_order_id.clone())),
            ("price", Json::str(format_amount(fill.price))),
            ("qty", Json::str(format_amount(fill.qty))),
            ("sequence", seq_json(fill.sequence)),
            ("ts", Json::str(at)),
            ("makerAccountId", Json::str(fill.maker_account_id.clone())),
            ("takerAccountId", Json::str(fill.taker_account_id.clone())),
        ]),
        key: format!("matching.order.filled:{market_id}:{}", fill.sequence),
    }
}

fn cancelled_event(market_id: &str, c: &CancelledRef) -> Pending {
    Pending {
        sequence: c.sequence,
        name: "orderCancelled",
        payload: Json::obj([
            ("orderId", Json::str(c.order_id.clone())),
            ("marketId", Json::str(market_id)),
            ("remainingQty", Json::str(format_amount(c.remaining_qty))),
            ("sequence", seq_json(c.sequence)),
            ("reason", Json::str(c.reason.as_str())),
        ]),
        key: format!("matching.order.cancelled:{market_id}:{}", c.sequence),
    }
}

fn triggered_event(
    market_id: &str,
    order_id: &str,
    sequence: u64,
    t: &TriggerFact,
    at: &str,
) -> Pending {
    Pending {
        sequence,
        name: "orderTriggered",
        payload: Json::obj([
            ("orderId", Json::str(order_id)),
            ("marketId", Json::str(market_id)),
            ("sequence", seq_json(sequence)),
            ("triggerBy", Json::str(t.by.as_str())),
            ("stopPrice", Json::str(format_amount(t.stop_price))),
            ("referencePrice", Json::str(format_amount(t.reference))),
            ("ts", Json::str(at)),
        ]),
        key: format!("matching.order.triggered:{market_id}:{sequence}"),
    }
}

fn refused(code: &str, message: String) -> Reject {
    Reject::new(code, message)
}

/// The base engine's gates, in its order, for a submit (`true`) or an amend (`false`) on `market_id`. Each refusal's
/// message names the order.
fn mode_refusal(modes: &Modes, market_id: &str, order_id: &str) -> Option<Reject> {
    let m = market_id;
    let o = order_id;
    if modes.venue_halted {
        return Some(refused(
            "venue_halted",
            format!("all markets are halted — order {o} not processed"),
        ));
    }
    if modes.maintenance.contains(m) {
        return Some(refused(
            "market_maintenance",
            format!("market {m} is in maintenance — order {o} not processed"),
        ));
    }
    if modes.halted.contains(m) {
        return Some(refused(
            "market_halted",
            format!("market {m} is halted — order {o} not processed"),
        ));
    }
    if modes.expired.contains(m) {
        return Some(refused(
            "market_expired",
            format!("market {m} is expired — order {o} not processed"),
        ));
    }
    if modes.delisted.contains(m) {
        return Some(refused(
            "market_delisted",
            format!("market {m} is delisted — order {o} not processed"),
        ));
    }
    if modes.prelaunch.contains(m) {
        return Some(refused(
            "market_prelaunch",
            format!("market {m} is prelaunch — order {o} not processed"),
        ));
    }
    None
}

fn disabled(order_id: &str) -> Reject {
    refused(
        "engine_disabled",
        format!("matching engine is disabled — order {order_id} not processed"),
    )
}

fn split_brain(order_id: &str) -> Reject {
    refused(
        "split_brain",
        format!("split-brain is declared — order {order_id} not processed"),
    )
}

/// `positionFlatResult`.
fn position_flat() -> SubmitResult {
    SubmitResult::refused(Reject::new(
        "position_flat",
        "account is flat on this book; the engine does not invent a mark",
    ))
}

fn not_live(order_id: &str, market_id: &str) -> AmendResult {
    AmendResult::refused(
        order_id,
        Reject::new(
            "order_not_found",
            format!("order {order_id} is not live in {market_id}"),
        ),
    )
}

/// The engine.
pub struct MatchingEngine {
    books: HashMap<String, OrderBook>,
    journal: Box<dyn EngineJournal + Send>,
    bus: Box<dyn EventBus + Send>,
    clock: fn() -> i64,
    expiry_clock: bool,
    snapshot_every: u64,
    sink: Box<dyn SnapshotSink<Json> + Send>,
    enabled: bool,
    modes: Modes,
    /// Owner rulebook versions in publish order, rebuilt from `rulebook_version` records. Empty is unpublished.
    rulebook: Vec<Version>,
}

impl MatchingEngine {
    pub fn new(parts: EngineParts) -> MatchingEngine {
        MatchingEngine {
            books: HashMap::new(),
            journal: parts.journal,
            bus: parts.bus,
            clock: parts.clock,
            expiry_clock: parts.expiry_clock,
            snapshot_every: parts.snapshot_every,
            sink: parts.sink,
            enabled: parts.enabled,
            modes: Modes::default(),
            rulebook: Vec::new(),
        }
    }

    pub fn journal(&self) -> &dyn EngineJournal {
        self.journal.as_ref()
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn existing_book(&self, market_id: &str) -> Option<&OrderBook> {
        self.books.get(market_id)
    }

    pub fn has_market(&self, market_id: &str) -> bool {
        self.books.contains_key(market_id)
    }

    /// Opened by an approved OPEN and still live (not expired, not delisted).
    pub fn is_listed(&self, market_id: &str) -> bool {
        self.modes.listed.contains(market_id)
            && !self.modes.expired.contains(market_id)
            && !self.modes.delisted.contains(market_id)
    }

    /// Every market with a book, plus every opened market that has none yet, sorted.
    pub fn markets(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.books.keys().cloned().collect();
        for id in &self.modes.listed {
            if self.is_listed(id) && !self.books.contains_key(id) {
                ids.push(id.clone());
            }
        }
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids
    }

    pub fn flags(&self, market_id: &str) -> Flags {
        Flags {
            venue_halted: self.modes.venue_halted,
            halted: self.modes.halted.contains(market_id),
            prelaunch: self.modes.prelaunch.contains(market_id),
            expired: self.modes.expired.contains(market_id),
            delisted: self.modes.delisted.contains(market_id),
            reduce_only: self.modes.reduce_only.contains(market_id),
            post_only: self.modes.post_only.contains(market_id),
        }
    }

    /// When this market's halt began, when it is halted and the time was readable.
    pub fn halted_since(&self, market_id: &str) -> Option<String> {
        if !self.modes.halted.contains(market_id) {
            return None;
        }
        self.modes.halted_since.get(market_id).cloned().flatten()
    }

    /// When the venue halt began, when the venue is halted.
    pub fn venue_halted_since(&self) -> Option<String> {
        if self.modes.venue_halted {
            self.modes.venue_halted_at.clone()
        } else {
            None
        }
    }

    pub fn is_session_dead(&self, session_id: &str) -> bool {
        self.modes.dead_sessions.contains(session_id)
    }

    pub fn is_split_brain(&self) -> bool {
        self.modes.split_brain
    }

    /// L2 to `limit` levels; an opened market with no book is empty at sequence 0; an unknown market is none.
    pub fn depth(&self, market_id: &str, limit: usize) -> Option<Depth> {
        if let Some(book) = self.books.get(market_id) {
            let (bids, asks, sequence) = book.depth(limit);
            return Some(Depth {
                bids,
                asks,
                sequence,
            });
        }
        self.is_listed(market_id).then(|| Depth {
            bids: Vec::new(),
            asks: Vec::new(),
            sequence: 0,
        })
    }

    /// The native queue (`l3Queue`): empty at sequence 0 when the market has no book.
    pub fn l3_queue(&self, market_id: &str) -> L3Queue {
        match self.books.get(market_id) {
            None => L3Queue {
                market_id: market_id.to_owned(),
                sequence: 0,
                bids: Vec::new(),
                asks: Vec::new(),
            },
            Some(book) => L3Queue {
                market_id: market_id.to_owned(),
                sequence: book.current_sequence(),
                bids: book.queue(Side::Buy),
                asks: book.queue(Side::Sell),
            },
        }
    }

    /// Every live order, one market's or all, sorted by market and then sequence.
    pub fn resting_orders(&self, market_id: Option<&str>) -> Vec<EngineLiveOrder> {
        let mut live: Vec<EngineLiveOrder> = self
            .books
            .iter()
            .filter(|(id, _)| market_id.is_none_or(|m| m == id.as_str()))
            .flat_map(|(id, book)| {
                book.live_orders()
                    .into_iter()
                    .map(move |o| EngineLiveOrder {
                        market_id: id.clone(),
                        order_id: o.order_id,
                        account_id: o.account_id,
                        kind: o.kind,
                        side: o.side,
                        price: o.price,
                        remaining: o.remaining,
                        sequence: o.sequence,
                        version: o.version,
                    })
            })
            .collect();
        // Within one market the books' own order (bids, asks, stops) is kept for equal sequences.
        live.sort_by(|a, b| {
            if a.market_id == b.market_id {
                a.sequence.cmp(&b.sequence)
            } else {
                js_sort_cmp(&a.market_id, &b.market_id)
            }
        });
        live
    }

    pub fn resting_order_count(&self) -> usize {
        self.books.values().map(|b| b.live_orders().len()).sum()
    }

    /// The account's signed net fill quantity on this book; zero with no book.
    pub fn net_position(&self, market_id: &str, account_id: &str) -> Amount {
        self.books
            .get(market_id)
            .map_or(0, |b| b.net_position(account_id))
    }

    /// The engine's snapshot: every book's state at the journal's length, and the dead sessions.
    pub fn snapshot(&self) -> EngineSnapshot<Json> {
        EngineSnapshot::of(
            self.books
                .iter()
                .map(|(id, b)| (id.clone(), b.to_state()))
                .collect(),
            self.journal.len(),
            self.modes.dead_sessions.iter().cloned(),
        )
    }

    /// `serializeBooks`: every book's state, sorted by market.
    pub fn serialize(&self) -> String {
        let mut ids: Vec<&String> = self.books.keys().collect();
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        Json::Array(
            ids.into_iter()
                .filter_map(|id| self.books.get(id))
                .map(OrderBook::to_state)
                .collect(),
        )
        .compact()
    }

    fn now_iso(&self, at: i64) -> String {
        Instant(at).iso()
    }

    fn expiry_now(&self) -> Option<i64> {
        self.expiry_clock.then(|| (self.clock)())
    }

    fn book_mut(&mut self, market_id: &str) -> &mut OrderBook {
        self.books
            .entry(market_id.to_owned())
            .or_insert_with(|| OrderBook::new(market_id))
    }

    /// `rulebookView()`: the public rulebook at the engine's clock.
    pub fn rulebook_view(&self) -> Json {
        rulebook::published_view(&self.rulebook, (self.clock)())
    }

    /// `rulebookHistory()`: every version, newest publish first.
    pub fn rulebook_history(&self) -> Json {
        rulebook::history_view(&self.rulebook, (self.clock)())
    }

    /// One version as the history writes it, or null.
    pub fn rulebook_history_of(&self, version: &str) -> Json {
        rulebook::history_of(&self.rulebook, version, (self.clock)())
    }

    /// `rulebookPrecheck(draft)`: whether a draft may be published, read before any approval is spent.
    pub fn rulebook_precheck(&self, draft: &Draft) -> Precheck {
        if let Some(existing) = self.rulebook.iter().find(|v| v.version == draft.version) {
            return if existing.digest == draft.digest {
                Precheck::Same
            } else {
                Precheck::Refused(rulebook::immutable_refuse(&draft.version))
            };
        }
        match rulebook::effective_past(draft, (self.clock)()) {
            Some(r) => Precheck::Refused(r),
            None => Precheck::New,
        }
    }

    /// `publishRulebook(draft, cmd)`: the door has spent the two-person approval; this journals the version with who
    /// proposed and approved it, and only then serves it. The same draft again returns the first publish; other text
    /// under a published id refuses.
    pub fn publish_rulebook(
        &mut self,
        draft: &Draft,
        operator_id: &str,
        confirm_operator_id: &str,
        approval_id: &str,
    ) -> Result<RulebookPublish, EngineError> {
        if let Some(rejected) = dual_control_refuse(Some(operator_id), Some(confirm_operator_id)) {
            return Ok(RulebookPublish::Refused(rejected));
        }
        if let Some(existing) = self.rulebook.iter().find(|v| v.version == draft.version) {
            return Ok(if existing.digest == draft.digest {
                RulebookPublish::Published { already: true }
            } else {
                RulebookPublish::Refused(rulebook::immutable_refuse(&draft.version))
            });
        }
        let now = (self.clock)();
        if let Some(rejected) = rulebook::effective_past(draft, now) {
            return Ok(RulebookPublish::Refused(rejected));
        }
        let at = Instant(now).iso();
        let version = Version {
            version: draft.version.clone(),
            effective_at: draft.effective_at.clone().unwrap_or_else(|| at.clone()),
            published_at: at,
            supersedes: self.rulebook.last().map(|v| v.version.clone()),
            digest: draft.digest.clone(),
            sections: draft.sections.clone(),
            operator_id: service_kit::schema::js_trim(operator_id).to_owned(),
            confirm_operator_id: service_kit::schema::js_trim(confirm_operator_id).to_owned(),
            approval_id: approval_id.to_owned(),
        };
        self.append(version.record())?;
        self.rulebook.push(version);
        Ok(RulebookPublish::Published { already: false })
    }

    fn drop_if_never_traded(&mut self, market_id: &str) {
        if self
            .books
            .get(market_id)
            .is_some_and(OrderBook::is_never_printed_empty)
        {
            self.books.remove(market_id);
        }
    }

    fn append(&mut self, record: Json) -> Result<(), EngineError> {
        self.journal.append(&JournalCommand(record))?;
        Ok(())
    }

    fn emit(&mut self, events: Vec<Pending>) -> Result<(), EngineError> {
        for e in events {
            self.bus
                .publish(e.name, &e.payload, &e.key)
                .map_err(EngineError::Publish)?;
        }
        Ok(())
    }

    fn maybe_snapshot(&mut self) {
        if snapshot_due(self.journal.len(), self.snapshot_every) {
            let snapshot = self.snapshot();
            self.sink.write(snapshot);
        }
    }

    /// `beginInFlight`: an `in_flight` record for a live order before its cancel or amend.
    fn begin_in_flight(
        &mut self,
        market_id: &str,
        order_id: &str,
        mutation: &str,
        at: &str,
    ) -> Result<(), EngineError> {
        let Some(remaining) = self
            .resting_orders(Some(market_id))
            .into_iter()
            .find(|o| o.order_id == order_id)
            .map(|o| o.remaining)
        else {
            return Ok(());
        };
        self.append(Json::obj([
            ("kind", Json::str("in_flight")),
            ("marketId", Json::str(market_id)),
            ("at", Json::str(at)),
            ("orderId", Json::str(order_id)),
            ("mutation", Json::str(mutation)),
            ("inFlight", Json::Bool(true)),
            ("qty", Json::str(format_amount(remaining))),
        ]))
    }

    // ── submit ──────────────────────────────────────────────────────────

    /// Place one order. `lifecycle_proof` is the door's admission evidence, journalled with it.
    pub fn submit(
        &mut self,
        market_id: &str,
        order: &EngineOrder,
        lifecycle_proof: Option<&Json>,
    ) -> Result<SubmitResult, EngineError> {
        let id = order.order_id.as_str();
        if self.modes.split_brain {
            return Ok(SubmitResult::refused(split_brain(id)));
        }
        if !self.enabled {
            return Ok(SubmitResult::refused(disabled(id)));
        }
        if let Some(r) = mode_refusal(&self.modes, market_id, id) {
            return Ok(SubmitResult::refused(r));
        }
        let m = market_id;
        if self.modes.reduce_only.contains(m)
            && self.books.get(m).is_none_or(|b| {
                b.would_open_or_increase(&order.account_id, order.side, order.qty, Some(id))
            })
        {
            return Ok(SubmitResult::refused(refused(
                "market_reduce_only",
                format!("market {m} is reduce-only — order {id} would open or increase"),
            )));
        }
        if self.modes.post_only.contains(m) && order.tif != Tif::Po {
            return Ok(SubmitResult::refused(refused(
                "market_post_only",
                format!("market {m} is post-only — order {id} is not post-only"),
            )));
        }
        if let Some(session) = read_session_id(order.session_id.as_deref())
            && self.modes.dead_sessions.contains(&session)
        {
            return Ok(SubmitResult::refused(refused(
                "session_gone",
                format!("session {session} is gone — order {id} not processed"),
            )));
        }
        let expiry_now = self.expiry_now();
        if let Some(book) = self.books.get_mut(m)
            && book.has_accepted(id)
        {
            return Ok(book.submit(order, expiry_now));
        }
        if order.tif.expires() && expiry_now.is_none() {
            return Ok(SubmitResult::refused(refused(
                "engine_clock_missing",
                format!(
                    "GTD/GTT expires on the engine clock; refuse when that clock is missing — order {id} not journalled"
                ),
            )));
        }
        let at = self.now_iso(expiry_now.unwrap_or_else(|| (self.clock)()));
        self.append(Json::obj([
            ("kind", Json::str("submit")),
            ("marketId", Json::str(m)),
            ("at", Json::str(at.clone())),
            ("order", to_wire(order, lifecycle_proof)),
        ]))?;
        let result = self.book_mut(m).submit(order, expiry_now);
        self.drop_if_never_traded(m);
        let events = events_for_submit(m, id, &result, &at);
        self.emit(events)?;
        self.maybe_snapshot();
        Ok(result)
    }

    // ── cancel ──────────────────────────────────────────────────────────

    pub fn cancel(
        &mut self,
        market_id: &str,
        order_id: &str,
        reason: CancelReason,
    ) -> Result<CancelResult, EngineError> {
        if self.modes.maintenance.contains(market_id) {
            return Ok(CancelResult {
                rejected: Some(refused(
                    "market_maintenance",
                    format!(
                        "market {market_id} is in maintenance — cancels are refused and the resting order stays"
                    ),
                )),
                ..CancelResult::missing(order_id)
            });
        }
        if !self.books.contains_key(market_id) {
            return Ok(CancelResult::missing(order_id));
        }
        let at = self.now_iso((self.clock)());
        self.begin_in_flight(market_id, order_id, "cancel", &at)?;
        let mut record: Vec<(String, Json)> = vec![
            ("kind".into(), Json::str("cancel")),
            ("marketId".into(), Json::str(market_id)),
            ("at".into(), Json::str(at)),
            ("orderId".into(), Json::str(order_id)),
        ];
        if reason != CancelReason::Requested {
            record.push(("reason".into(), Json::str(reason.as_str())));
        }
        self.append(Json::Object(record))?;
        let result = self.book_mut(market_id).cancel(order_id, reason);
        if let Some(c) = &result.cancellation {
            self.emit(vec![cancelled_event(market_id, c)])?;
        }
        self.maybe_snapshot();
        Ok(result)
    }

    /// Pull every live order of one account in one market, on one side when given (cod-fence's mass cancel). The
    /// record is journalled first; each order then goes through [`cancel`](Self::cancel), which journals and announces
    /// its own.
    pub fn mass_cancel(
        &mut self,
        market_id: &str,
        account_id: &str,
        session_id: Option<&str>,
        side: Option<Side>,
    ) -> Result<MassCancelResult, EngineError> {
        if let Some(r) = mass_cancel_session_refuse(read_session_id(session_id).as_deref()) {
            return Ok(MassCancelResult {
                accepted: false,
                account_id: account_id.to_owned(),
                cancellations: Vec::new(),
                failed: Vec::new(),
                rejected: Some(r),
            });
        }
        let Some(book) = self.books.get(market_id) else {
            return Ok(MassCancelResult {
                accepted: true,
                account_id: account_id.to_owned(),
                cancellations: Vec::new(),
                failed: Vec::new(),
                rejected: None,
            });
        };
        let ids = book.owned_order_ids(account_id, side);
        let at = self.now_iso((self.clock)());
        let mut record: Vec<(String, Json)> = vec![
            ("kind".into(), Json::str("mass_cancel")),
            ("marketId".into(), Json::str(market_id)),
            ("at".into(), Json::str(at)),
            ("accountId".into(), Json::str(account_id)),
        ];
        if let Some(s) = side {
            record.push(("side".into(), Json::str(s.as_str())));
        }
        self.append(Json::Object(record))?;
        let mut cancellations = Vec::new();
        let mut failed = Vec::new();
        for id in ids {
            let r = self.cancel(market_id, &id, CancelReason::Requested)?;
            match (r.cancelled, r.cancellation) {
                (true, Some(c)) => cancellations.push(c),
                _ => failed.push((
                    id,
                    r.rejected
                        .map_or_else(|| "cancel_failed".to_owned(), |rj| rj.message),
                )),
            }
        }
        self.drop_if_never_traded(market_id);
        Ok(MassCancelResult {
            accepted: true,
            account_id: account_id.to_owned(),
            cancellations,
            failed,
            rejected: None,
        })
    }

    // ── amend ───────────────────────────────────────────────────────────

    /// `amendRefusal`: the refusal before the journal and the book, none when the book would take it.
    fn amend_refusal(&self, market_id: &str, cmd: &EngineAmend) -> Option<AmendResult> {
        let id = cmd.order_id.as_str();
        if !self.enabled {
            return Some(AmendResult::refused(id, disabled(id)));
        }
        if let Some(r) = mode_refusal(&self.modes, market_id, id) {
            return Some(AmendResult::refused(id, r));
        }
        let book = self.books.get(market_id);
        let m = market_id;
        if self.modes.reduce_only.contains(m)
            && let Some(b) = book
            && let Some((account, side, live_qty)) = b.live_identity(id)
        {
            let qty = cmd.qty.unwrap_or(live_qty);
            if b.would_open_or_increase(&account, side, qty, Some(id)) {
                return Some(AmendResult::refused(
                    id,
                    refused(
                        "market_reduce_only",
                        format!("market {m} is reduce-only — order {id} would open or increase"),
                    ),
                ));
            }
        }
        if self.modes.post_only.contains(m)
            && let Some(live) = book.and_then(|b| b.amend_target(id).map(|t| (b, t)))
        {
            let (b, target) = live;
            let tif = cmd.tif.unwrap_or(target.inherited_tif);
            let detail = if tif != Tif::Po {
                Some(format!("order {id} is not post-only"))
            } else {
                let price = cmd.price.or(target.price);
                let takes = if target.kind == RestKind::Book {
                    price.is_some_and(|p| b.would_cross_limit(target.side, p))
                } else {
                    let stop = cmd.stop_price.or(target.stop_price);
                    match stop {
                        Some(s) if b.stop_would_trigger(target.side, s) => {
                            price.is_none_or(|p| b.would_cross_limit(target.side, p))
                        }
                        _ => false,
                    }
                };
                takes.then(|| format!("order {id} would take"))
            };
            if let Some(detail) = detail {
                return Some(AmendResult::refused(
                    id,
                    refused(
                        "market_post_only",
                        format!("market {m} is post-only — {detail}"),
                    ),
                ));
            }
        }
        if book.is_none() {
            return Some(not_live(id, m));
        }
        None
    }

    pub fn amend(
        &mut self,
        market_id: &str,
        cmd: &EngineAmend,
        lifecycle_proof: Option<&Json>,
    ) -> Result<AmendResult, EngineError> {
        if self.modes.split_brain {
            return Ok(AmendResult::refused(
                &cmd.order_id,
                split_brain(&cmd.order_id),
            ));
        }
        if let Some(blocked) = self.amend_refusal(market_id, cmd) {
            return Ok(blocked);
        }
        let expiry_now = self.expiry_now();
        let at = self.now_iso(expiry_now.unwrap_or_else(|| (self.clock)()));
        self.begin_in_flight(market_id, &cmd.order_id, "amend", &at)?;
        let mut record: Vec<(String, Json)> = vec![
            ("kind".into(), Json::str("amend")),
            ("marketId".into(), Json::str(market_id)),
            ("at".into(), Json::str(at.clone())),
            ("orderId".into(), Json::str(cmd.order_id.clone())),
            ("expectedVersion".into(), seq_json(cmd.expected_version)),
            ("patch".into(), to_wire_amend(cmd)),
        ];
        if let Some(p) = lifecycle_proof {
            record.push(("lifecycleProof".into(), p.clone()));
        }
        self.append(Json::Object(record))?;
        let result = self.book_mut(market_id).amend(cmd, expiry_now);
        self.drop_if_never_traded(market_id);
        let events = events_for_amend(market_id, &result, &at);
        self.emit(events)?;
        self.maybe_snapshot();
        Ok(result)
    }

    // ── positions ───────────────────────────────────────────────────────

    /// Flatten the account's net on this book with a reduce-only market order (`closePosition`).
    pub fn close_position(
        &mut self,
        market_id: &str,
        order_id: &str,
        account_id: &str,
        lifecycle_proof: Option<&Json>,
    ) -> Result<SubmitResult, EngineError> {
        if !self.enabled {
            return Ok(SubmitResult::refused(disabled(order_id)));
        }
        let net = self.net_position(market_id, account_id);
        if net == 0 {
            return Ok(position_flat());
        }
        let long = net > 0;
        let mut order = EngineOrder::new(
            order_id,
            account_id,
            OrderType::Market,
            if long { Side::Sell } else { Side::Buy },
            if long { net } else { -net },
            None,
            Tif::Ioc,
        );
        order.reduce_only = true;
        self.submit(market_id, &order, lifecycle_proof)
    }

    // ── cold start ──────────────────────────────────────────────────────

    /// Rebuild every book and mode from the journal alone, then announce again what replay printed (the fills, the
    /// hold cancels and the stops that fired), each under its original key. Stops at a record this port cannot
    /// rebuild, and at state a later slice owns.
    pub fn recover(&mut self) -> Result<Recovered, EngineError> {
        let records: Vec<JournalRecord> = self.journal.read().to_vec();
        if let Some(r) = records.iter().find(|r| r.kind() == Some("spread_list")) {
            return Err(EngineError::Owed {
                slice: Slice::Spreads,
                why: format!(
                    "the journal lists spread {}",
                    js_string(r.field("marketId"))
                ),
            });
        }
        let unresolved = unresolved_in_flight(&records);
        if let Some(id) = unresolved.first() {
            return Err(EngineError::Owed {
                slice: Slice::Liquidity,
                why: format!("order {id} has an in-flight mutation the journal never resolved"),
            });
        }
        let mut into = Rebuild::default();
        replay_journal(&records, &mut into).map_err(|e| EngineError::Replay(e.to_string()))?;
        if let Some(e) = into.error {
            return Err(match e {
                WireError::Owed { field, slice } => EngineError::Owed {
                    slice,
                    why: format!("the journal holds a {field}"),
                },
                WireError::Malformed(why) => EngineError::Replay(why),
            });
        }
        self.books = into.books;
        self.modes = replay_modes(&records);
        self.rulebook.clear();
        for r in records
            .iter()
            .filter(|r| r.kind() == Some("rulebook_version"))
        {
            let v = Version::from_record(r);
            if !self.rulebook.iter().any(|p| p.version == v.version) {
                self.rulebook.push(v);
            }
        }
        let mut announced: Vec<Pending> = Vec::new();
        for (market, at, fill) in &into.fills {
            announced.push(filled_event(market, fill, at));
        }
        for (market, c) in &into.hold_cancels {
            announced.push(cancelled_event(market, c));
        }
        for (market, at, order_id, sequence, t) in &into.triggers {
            announced.push(triggered_event(market, order_id, *sequence, t, at));
        }
        announced.sort_by_key(|e| e.sequence);
        self.emit(announced)?;
        Ok(Recovered {
            records: records.len(),
            markets: self.books.len(),
        })
    }
}

/// `rulebookPrecheck`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Precheck {
    /// Not published yet, and its time has not gone by.
    New,
    /// This exact version is published: a retry returns the first.
    Same,
    /// Other text under a published id, or a time gone by.
    Refused(Reject),
}

/// `publishRulebook`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RulebookPublish {
    /// Journalled now, or (`already`) the same draft published before.
    Published {
        already: bool,
    },
    Refused(Reject),
}

/// What a cold start rebuilt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Recovered {
    pub records: usize,
    pub markets: usize,
}

fn events_for_submit(
    market_id: &str,
    order_id: &str,
    result: &SubmitResult,
    at: &str,
) -> Vec<Pending> {
    let mut events = Vec::new();
    if let (true, Some(sequence)) = (result.accepted, result.sequence) {
        events.push(Pending {
            sequence,
            name: "orderAccepted",
            payload: Json::obj([
                ("orderId", Json::str(order_id)),
                ("marketId", Json::str(market_id)),
                ("sequence", seq_json(sequence)),
            ]),
            key: format!("matching.order.accepted:{market_id}:{order_id}"),
        });
    }
    let collect = |events: &mut Vec<Pending>, fills: &[Fill], cancels: &[CancelledRef]| {
        events.extend(fills.iter().map(|f| filled_event(market_id, f, at)));
        events.extend(cancels.iter().map(|c| cancelled_event(market_id, c)));
    };
    collect(&mut events, &result.fills, &result.cancellations);
    for t in &result.triggered {
        if let Some(fact) = &t.trigger {
            events.push(triggered_event(
                market_id,
                &t.order_id,
                t.sequence,
                fact,
                at,
            ));
        }
        collect(&mut events, &t.fills, &t.cancellations);
    }
    events.sort_by_key(|e| e.sequence);
    events
}

fn events_for_amend(market_id: &str, result: &AmendResult, at: &str) -> Vec<Pending> {
    let mut events = Vec::new();
    events.extend(
        result
            .cancellations
            .iter()
            .map(|c| cancelled_event(market_id, c)),
    );
    events.extend(result.fills.iter().map(|f| filled_event(market_id, f, at)));
    for t in &result.triggered {
        if let Some(fact) = &t.trigger {
            events.push(triggered_event(
                market_id,
                &t.order_id,
                t.sequence,
                fact,
                at,
            ));
        }
        events.extend(t.fills.iter().map(|f| filled_event(market_id, f, at)));
        events.extend(
            t.cancellations
                .iter()
                .map(|c| cancelled_event(market_id, c)),
        );
    }
    // An amend that fires its own stop reports that stop's fills and cancels on the result and on its trigger outcome.
    let mut seen = HashSet::new();
    events.retain(|e| seen.insert(e.key.clone()));
    events.sort_by_key(|e| e.sequence);
    events
}

/// `replayInFlight`: the orders whose last `in_flight` mark no later cancel or amend of theirs resolved.
fn unresolved_in_flight(records: &[JournalRecord]) -> Vec<String> {
    let mut open: Vec<String> = Vec::new();
    for r in records {
        let id = match r.field("orderId") {
            Some(Json::String(s)) => s.clone(),
            _ => continue,
        };
        match r.kind() {
            Some("in_flight") if matches!(r.field("inFlight"), Some(Json::Bool(true))) => {
                if !open.contains(&id) {
                    open.push(id);
                }
            }
            Some("amend" | "cancel") => open.retain(|o| *o != id),
            _ => {}
        }
    }
    open
}

/// The venue modes and dead sessions as the journal last left them (`replayHaltedMarkets` and its kin).
fn replay_modes(records: &[JournalRecord]) -> Modes {
    let mut m = Modes::default();
    for r in records {
        let kind = r.kind().unwrap_or("");
        let at = || match r.field("at") {
            Some(Json::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        match kind {
            "halt_all" => {
                if !m.venue_halted {
                    m.venue_halted_at = at();
                }
                m.venue_halted = true;
            }
            "resume_all" => {
                m.venue_halted = false;
                m.venue_halted_at = None;
            }
            "split_brain" => m.split_brain = true,
            "clear_split_brain" => m.split_brain = false,
            "session_dead" => {
                if let Some(Json::String(s)) = r.field("sessionId") {
                    m.dead_sessions.insert(s.clone());
                }
            }
            _ => {}
        }
        // A market's record: `marketId !== undefined`.
        let Some(market) = r.field("marketId") else {
            continue;
        };
        let market = js_string(Some(market));
        match kind {
            "halt" => {
                m.halted.insert(market.clone());
                m.halted_since.entry(market).or_insert_with(at);
            }
            "resume" => {
                m.halted.remove(&market);
                m.halted_since.remove(&market);
            }
            "maintenance" => {
                m.maintenance.insert(market);
            }
            "end_maintenance" => {
                m.maintenance.remove(&market);
            }
            "reduce_only" => {
                m.reduce_only.insert(market);
            }
            "resume_reduce_only" => {
                m.reduce_only.remove(&market);
            }
            "post_only" => {
                m.post_only.insert(market);
            }
            "resume_post_only" => {
                m.post_only.remove(&market);
            }
            "prelaunch" => {
                m.prelaunch.insert(market);
            }
            "open" => {
                m.prelaunch.remove(&market);
                m.listed.insert(market);
            }
            "expire" => {
                m.expired.insert(market);
            }
            "delist" => {
                m.delisted.insert(market);
            }
            _ => {}
        }
    }
    m
}

/// The books replay rebuilds, and what it printed on the way.
#[derive(Default)]
struct Rebuild {
    books: HashMap<String, OrderBook>,
    fills: Vec<(String, String, Fill)>,
    hold_cancels: Vec<(String, CancelledRef)>,
    triggers: Vec<(String, String, String, u64, TriggerFact)>,
    /// The first record that does not rebuild here; replay goes no further once it is set.
    error: Option<WireError>,
}

impl Rebuild {
    fn drop_if_never_traded(&mut self, market_id: &str) {
        if self
            .books
            .get(market_id)
            .is_some_and(OrderBook::is_never_printed_empty)
        {
            self.books.remove(market_id);
        }
    }

    /// `collectFills`: each fill once, in sequence order, and each stop that fired.
    fn collect(
        &mut self,
        market_id: &str,
        at: &str,
        fills: &[Fill],
        triggered: &[crate::book::types::TriggerOutcome],
    ) {
        let mut chunk: Vec<Fill> = Vec::new();
        let mut add = |f: &Fill| {
            if !chunk.contains(f) {
                chunk.push(f.clone());
            }
        };
        fills.iter().for_each(&mut add);
        for t in triggered {
            if let Some(fact) = &t.trigger {
                self.triggers.push((
                    market_id.to_owned(),
                    at.to_owned(),
                    t.order_id.clone(),
                    t.sequence,
                    fact.clone(),
                ));
            }
            t.fills.iter().for_each(&mut add);
        }
        chunk.sort_by_key(|f| f.sequence);
        self.fills.extend(
            chunk
                .into_iter()
                .map(|f| (market_id.to_owned(), at.to_owned(), f)),
        );
    }
}

impl ReplayBooks for Rebuild {
    fn has_market(&self, market_id: &str) -> bool {
        self.error.is_none() && self.books.contains_key(market_id)
    }

    fn submit(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        if self.error.is_some() {
            return;
        }
        let order = match record.field("order").map(from_wire) {
            Some(Ok(order)) => order,
            Some(Err(e)) => {
                self.error = Some(e);
                return;
            }
            None => {
                self.error = Some(WireError::Malformed("a submit without an order".to_owned()));
                return;
            }
        };
        let result = self
            .books
            .entry(market_id.to_owned())
            .or_insert_with(|| OrderBook::new(market_id))
            .submit(&order, clock);
        let at = js_string(record.field("at"));
        self.collect(market_id, &at, &result.fills, &result.triggered);
        self.drop_if_never_traded(market_id);
    }

    fn amend(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>) {
        if self.error.is_some() {
            return;
        }
        let order_id = js_string(record.field("orderId"));
        let version = match record.field("expectedVersion") {
            Some(v) => crate::journal::record::whole(v).and_then(|n| u64::try_from(n).ok()),
            None => None,
        };
        let empty = Json::Object(Vec::new());
        let cmd = match version {
            Some(v) => from_wire_amend(&order_id, v, record.field("patch").unwrap_or(&empty)),
            None => Err(WireError::Malformed(
                "an amend without its expected version".to_owned(),
            )),
        };
        let cmd = match cmd {
            Ok(c) => c,
            Err(e) => {
                self.error = Some(e);
                return;
            }
        };
        let Some(book) = self.books.get_mut(market_id) else {
            return;
        };
        let result = book.amend(&cmd, clock);
        let at = js_string(record.field("at"));
        self.collect(market_id, &at, &result.fills, &result.triggered);
        self.drop_if_never_traded(market_id);
    }

    fn mark(&mut self, _market_id: &str, _record: &JournalRecord) {
        if self.error.is_none() {
            self.error = Some(WireError::Owed {
                field: "trailing-stop mark".to_owned(),
                slice: Slice::Triggers,
            });
        }
    }

    fn mass_cancel(&mut self, market_id: &str, record: &JournalRecord) {
        if self.error.is_some() {
            return;
        }
        let account = js_string(record.field("accountId"));
        let side = match record.field("side") {
            Some(Json::String(s)) => Side::parse(s),
            _ => None,
        };
        if let Some(book) = self.books.get_mut(market_id) {
            book.cancel_account(&account, side);
        }
        self.drop_if_never_traded(market_id);
    }

    fn cancel(&mut self, market_id: &str, record: &JournalRecord, why: ReplayCancel<'_>) {
        if self.error.is_some() {
            return;
        }
        let reason = match why {
            ReplayCancel::Requested => CancelReason::Requested,
            ReplayCancel::Reason(r) => match CancelReason::parse(r) {
                Some(reason) => reason,
                None => {
                    self.error = Some(WireError::Malformed(format!("a cancel with reason {r}")));
                    return;
                }
            },
        };
        let order_id = js_string(record.field("orderId"));
        let Some(book) = self.books.get_mut(market_id) else {
            return;
        };
        let result = book.cancel(&order_id, reason);
        if reason == CancelReason::HoldUnconfirmed
            && let Some(c) = result.cancellation
        {
            self.hold_cancels.push((market_id.to_owned(), c));
        }
    }

    fn session_dead(&mut self, session_id: &Json) {
        if self.error.is_some() {
            return;
        }
        // Only a text id names a session: anything else matches no order.
        let Json::String(id) = session_id else {
            return;
        };
        let markets: Vec<String> = self.books.keys().cloned().collect();
        for market in markets {
            if let Some(book) = self.books.get_mut(&market) {
                book.cancel_session(id);
            }
            self.drop_if_never_traded(&market);
        }
    }
}
