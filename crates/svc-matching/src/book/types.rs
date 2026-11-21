//! The engine's vocabulary (`engine/types.ts`): an order as the book sees it, and what each book command answers. Every
//! price and quantity is an [`Amount`], the ledger's scaled integer; the only plain numbers are sequences and versions.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};

/// A sequence or version as JSON.
pub fn seq_json(n: u64) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `buy` or `sell`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }

    pub fn parse(s: &str) -> Option<Side> {
        match s {
            "buy" => Some(Side::Buy),
            "sell" => Some(Side::Sell),
            _ => None,
        }
    }
}

/// The engine's order types (`EngineOrderType`: the public contract's types but `take_profit`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderType {
    Limit,
    Market,
    Stop,
    StopLimit,
}

impl OrderType {
    pub fn as_str(self) -> &'static str {
        match self {
            OrderType::Limit => "limit",
            OrderType::Market => "market",
            OrderType::Stop => "stop",
            OrderType::StopLimit => "stop_limit",
        }
    }

    pub fn parse(s: &str) -> Option<OrderType> {
        match s {
            "limit" => Some(OrderType::Limit),
            "market" => Some(OrderType::Market),
            "stop" => Some(OrderType::Stop),
            "stop_limit" => Some(OrderType::StopLimit),
            _ => None,
        }
    }

    /// `stop` or `stop_limit`: the order waits in the stop book.
    pub fn is_stop(self) -> bool {
        matches!(self, OrderType::Stop | OrderType::StopLimit)
    }

    /// `limit` or `stop_limit`: the order carries a limit price.
    pub fn needs_price(self) -> bool {
        matches!(self, OrderType::Limit | OrderType::StopLimit)
    }
}

/// Time in force (`timeInForceSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tif {
    Gtc,
    Ioc,
    Fok,
    Po,
    Moc,
    Gtd,
    Gtt,
}

impl Tif {
    pub fn as_str(self) -> &'static str {
        match self {
            Tif::Gtc => "GTC",
            Tif::Ioc => "IOC",
            Tif::Fok => "FOK",
            Tif::Po => "PO",
            Tif::Moc => "MOC",
            Tif::Gtd => "GTD",
            Tif::Gtt => "GTT",
        }
    }

    pub fn parse(s: &str) -> Option<Tif> {
        match s {
            "GTC" => Some(Tif::Gtc),
            "IOC" => Some(Tif::Ioc),
            "FOK" => Some(Tif::Fok),
            "PO" => Some(Tif::Po),
            "MOC" => Some(Tif::Moc),
            "GTD" => Some(Tif::Gtd),
            "GTT" => Some(Tif::Gtt),
            _ => None,
        }
    }

    /// GTD or GTT: expires on the engine clock.
    pub fn expires(self) -> bool {
        matches!(self, Tif::Gtd | Tif::Gtt)
    }

    /// A remainder of an order with this time in force may rest.
    pub fn can_rest(self) -> bool {
        matches!(self, Tif::Gtc | Tif::Po | Tif::Moc | Tif::Gtd | Tif::Gtt)
    }
}

/// Which price fires a stop (`triggerBy`). Absent is last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerBy {
    Last,
    Mark,
    Index,
}

impl TriggerBy {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerBy::Last => "last",
            TriggerBy::Mark => "mark",
            TriggerBy::Index => "index",
        }
    }
}

/// A stop's direction rule (`triggerRole`). Absent is the legacy level test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerRole {
    Legacy,
    TakeProfit,
    StopLoss,
}

impl TriggerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerRole::Legacy => "legacy",
            TriggerRole::TakeProfit => "take_profit",
            TriggerRole::StopLoss => "stop_loss",
        }
    }
}

/// A field JavaScript tells apart as absent (`undefined`), `null`, or a value: what an order keeps on the wire and
/// what a `!== undefined` test reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Opt<T> {
    #[default]
    Absent,
    Null,
    Some(T),
}

impl<T> Opt<T> {
    /// `value ?? null`.
    pub fn value(&self) -> Option<&T> {
        match self {
            Opt::Some(v) => Some(v),
            _ => None,
        }
    }

    /// `value !== undefined`.
    pub fn present(&self) -> bool {
        !matches!(self, Opt::Absent)
    }
}

impl<T: Copy> Opt<T> {
    pub fn get(&self) -> Option<T> {
        self.value().copied()
    }
}

/// An order's OCO and bracket parts, each as JavaScript tells it apart (absent, `null`, or a value).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Exits {
    /// `bracket`: `true` rests the exits once the entry trades.
    pub bracket: Opt<bool>,
    /// `oco: true`.
    pub oco: bool,
    pub take_profit: Opt<Amount>,
    pub stop_loss: Opt<Amount>,
    /// The stop-loss leg's limit price; absent makes it a market stop.
    pub stop_loss_limit: Opt<Amount>,
    pub take_profit_order_id: Opt<String>,
    pub stop_loss_order_id: Opt<String>,
    /// `cancel: true`: a linked OCO cancel, never journalled (`toWire` leaves it out).
    pub cancel: bool,
}

impl Exits {
    /// None of the parts is set.
    pub fn is_empty(&self) -> bool {
        *self == Exits::default()
    }
}

/// An order as the engine sees it (`EngineOrder`), already checked by svc-trade and in scaled integers. It holds every
/// field the core book (`book.ts`) reads, and the trigger wrappers' [`Exits`]. The parts only a later slice's module reads
/// (option and combo terms, spreads, client ids) are not here: an order naming one is that slice's, and the door owes it
/// before it reaches a book.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineOrder {
    pub order_id: String,
    pub account_id: String,
    pub order_type: OrderType,
    pub side: Side,
    pub qty: Amount,
    /// Limit price: required for `limit` and `stop_limit`, null otherwise.
    pub price: Option<Amount>,
    /// Trigger price: required for `stop` and `stop_limit`, null otherwise.
    pub stop_price: Option<Amount>,
    pub tif: Tif,
    pub session_id: Option<String>,
    pub expire_at: Option<String>,
    pub oco_sibling_id: Option<String>,
    pub reduce_only: bool,
    /// `triggerRole` as sent: `take_profit` or `stop_loss` name the direction rule; anything else is the legacy test.
    pub trigger_role: Option<TriggerRole>,
    /// `triggerBy` as sent; absent is last.
    pub trigger_by: Option<TriggerBy>,
    /// `instrument: option | option_combo`.
    pub option_instrument: bool,
    /// Signed futures position for reduce-only. Absent keeps the fill net.
    pub position_qty: Option<Amount>,
    pub display_qty: Opt<Amount>,
    pub iceberg: bool,
    /// Trail distance (`trail`): present makes the order a trailing stop, which refuses while it is null or not
    /// positive.
    pub trail: Opt<Amount>,
    /// The mark the trail starts from (`mark`).
    pub mark: Opt<Amount>,
    /// The trigger parts the `triggers` wrappers read before the core book (`oco-link.ts`, `oco-cancel.ts`,
    /// `bracket.ts`); the core book never reads them.
    pub exits: Exits,
    pub min_qty: Opt<Amount>,
    pub aon: Opt<bool>,
    pub peg: Opt<bool>,
    pub midpoint: Opt<bool>,
    pub relative: Opt<bool>,
    pub reference: Opt<Amount>,
    pub offset: Opt<Amount>,
    pub auction: Opt<bool>,
    pub benchmark: Opt<bool>,
    pub collar: Opt<bool>,
    pub min: Opt<Amount>,
    pub max: Opt<Amount>,
    pub min_notional: Opt<Amount>,
    /// A spread order (`spread != null`): the core book refuses it.
    pub spread: bool,
}

impl EngineOrder {
    /// A plain order: every optional part absent.
    pub fn new(
        order_id: impl Into<String>,
        account_id: impl Into<String>,
        order_type: OrderType,
        side: Side,
        qty: Amount,
        price: Option<Amount>,
        tif: Tif,
    ) -> EngineOrder {
        EngineOrder {
            order_id: order_id.into(),
            account_id: account_id.into(),
            order_type,
            side,
            qty,
            price,
            stop_price: None,
            tif,
            session_id: None,
            expire_at: None,
            oco_sibling_id: None,
            reduce_only: false,
            trigger_role: None,
            trigger_by: None,
            option_instrument: false,
            position_qty: None,
            display_qty: Opt::Absent,
            iceberg: false,
            trail: Opt::Absent,
            mark: Opt::Absent,
            exits: Exits::default(),
            min_qty: Opt::Absent,
            aon: Opt::Absent,
            peg: Opt::Absent,
            midpoint: Opt::Absent,
            relative: Opt::Absent,
            reference: Opt::Absent,
            offset: Opt::Absent,
            auction: Opt::Absent,
            benchmark: Opt::Absent,
            collar: Opt::Absent,
            min: Opt::Absent,
            max: Opt::Absent,
            min_notional: Opt::Absent,
            spread: false,
        }
    }
}

/// Native amend (`EngineAmend`): omitted fields inherit. `qty` is the new remaining quantity.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EngineAmend {
    pub order_id: String,
    pub expected_version: u64,
    pub qty: Option<Amount>,
    pub price: Option<Amount>,
    pub stop_price: Option<Amount>,
    pub tif: Option<Tif>,
    pub expire_at: Option<String>,
}

/// Why the engine refused (`RejectReason`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reject {
    pub code: String,
    pub message: String,
}

impl Reject {
    pub fn new(code: &str, message: impl Into<String>) -> Reject {
        Reject {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Json {
        Json::obj([
            ("code", Json::str(self.code.clone())),
            ("message", Json::str(self.message.clone())),
        ])
    }
}

/// `rejected ?? null`.
pub fn reject_or_null(r: Option<&Reject>) -> Json {
    r.map_or(Json::Null, Reject::to_json)
}

/// A match: `price` is the resting order's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fill {
    pub sequence: u64,
    pub maker_order_id: String,
    pub maker_account_id: String,
    pub taker_order_id: String,
    pub taker_account_id: String,
    pub taker_side: Side,
    pub price: Amount,
    pub qty: Amount,
}

impl Fill {
    /// `presentFill`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("sequence", seq_json(self.sequence)),
            ("makerOrderId", Json::str(self.maker_order_id.clone())),
            ("makerAccountId", Json::str(self.maker_account_id.clone())),
            ("takerOrderId", Json::str(self.taker_order_id.clone())),
            ("takerAccountId", Json::str(self.taker_account_id.clone())),
            ("takerSide", Json::str(self.taker_side.as_str())),
            ("price", Json::str(format_amount(self.price))),
            ("qty", Json::str(format_amount(self.qty))),
        ])
    }
}

/// `book` (the limit book) or `stop` (the pending-trigger stop book).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestKind {
    Book,
    Stop,
}

impl RestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RestKind::Book => "book",
            RestKind::Stop => "stop",
        }
    }
}

/// Where an order came to rest (`RestingRef`). `price` is the limit for `book`, the trigger for `stop`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestingRef {
    pub kind: RestKind,
    pub order_id: String,
    pub account_id: String,
    pub side: Side,
    pub price: Amount,
    pub remaining: Amount,
    pub sequence: u64,
    pub version: u64,
}

impl RestingRef {
    /// `presentResting`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("kind", Json::str(self.kind.as_str())),
            ("orderId", Json::str(self.order_id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("side", Json::str(self.side.as_str())),
            ("price", Json::str(format_amount(self.price))),
            ("remaining", Json::str(format_amount(self.remaining))),
            ("sequence", seq_json(self.sequence)),
            ("version", seq_json(self.version)),
        ])
    }
}

/// `presentResting` of an optional rest.
pub fn resting_json(r: Option<&RestingRef>) -> Json {
    r.map_or(Json::Null, RestingRef::to_json)
}

/// Why quantity left the engine without filling (`CANCEL_REASONS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    Requested,
    SelfTradePrevention,
    IocRemainder,
    MarketRemainder,
    TriggerRejected,
    OcoSiblingFilled,
    Expired,
    WouldIncreasePosition,
    ReduceOnlyDisplaced,
    SessionDead,
    HoldUnconfirmed,
}

impl CancelReason {
    pub const ALL: [CancelReason; 11] = [
        CancelReason::Requested,
        CancelReason::SelfTradePrevention,
        CancelReason::IocRemainder,
        CancelReason::MarketRemainder,
        CancelReason::TriggerRejected,
        CancelReason::OcoSiblingFilled,
        CancelReason::Expired,
        CancelReason::WouldIncreasePosition,
        CancelReason::ReduceOnlyDisplaced,
        CancelReason::SessionDead,
        CancelReason::HoldUnconfirmed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CancelReason::Requested => "requested",
            CancelReason::SelfTradePrevention => "self_trade_prevention",
            CancelReason::IocRemainder => "ioc_remainder",
            CancelReason::MarketRemainder => "market_remainder",
            CancelReason::TriggerRejected => "trigger_rejected",
            CancelReason::OcoSiblingFilled => "oco_sibling_filled",
            CancelReason::Expired => "expired",
            CancelReason::WouldIncreasePosition => "would_increase_position",
            CancelReason::ReduceOnlyDisplaced => "reduce_only_displaced",
            CancelReason::SessionDead => "session_dead",
            CancelReason::HoldUnconfirmed => "hold_unconfirmed",
        }
    }

    pub fn parse(s: &str) -> Option<CancelReason> {
        CancelReason::ALL.into_iter().find(|r| r.as_str() == s)
    }
}

/// Quantity that left the engine without filling, whose ledger hold is released (`CancelledRef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelledRef {
    pub order_id: String,
    pub account_id: String,
    pub remaining_qty: Amount,
    pub sequence: u64,
    pub reason: CancelReason,
}

impl CancelledRef {
    /// `presentCancellation`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("orderId", Json::str(self.order_id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("remainingQty", Json::str(format_amount(self.remaining_qty))),
            ("sequence", seq_json(self.sequence)),
            ("reason", Json::str(self.reason.as_str())),
        ])
    }
}

/// Matching-abuse evidence (`EngineSurveillanceCase`). Open only: never a fine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurveillanceCase {
    pub account_id: String,
    pub market_id: String,
    /// `self_trade`, `spoofing` or `layering`.
    pub reason: String,
}

impl SurveillanceCase {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("accountId", Json::str(self.account_id.clone())),
            ("marketId", Json::str(self.market_id.clone())),
            ("reason", Json::str(self.reason.clone())),
            ("status", Json::str("open")),
        ])
    }
}

/// Why a stop fired (`TriggerFact`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerFact {
    pub by: TriggerBy,
    pub stop_price: Amount,
    pub reference: Amount,
}

/// What a stop did once its trigger fired (`TriggerOutcome`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerOutcome {
    pub order_id: String,
    pub trigger: Option<TriggerFact>,
    pub sequence: u64,
    pub fills: Vec<Fill>,
    pub resting: Option<RestingRef>,
    pub cancellations: Vec<CancelledRef>,
    pub rejected: Option<Reject>,
    pub surveillance_cases: Vec<SurveillanceCase>,
}

impl TriggerOutcome {
    /// The trigger entry `presentSubmit` writes.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("orderId", Json::str(self.order_id.clone())),
            ("sequence", seq_json(self.sequence)),
            (
                "fills",
                Json::Array(self.fills.iter().map(Fill::to_json).collect()),
            ),
            ("resting", resting_json(self.resting.as_ref())),
            (
                "cancellations",
                Json::Array(
                    self.cancellations
                        .iter()
                        .map(CancelledRef::to_json)
                        .collect(),
                ),
            ),
            ("rejected", reject_or_null(self.rejected.as_ref())),
        ])
    }
}

/// What `submit` answers (`SubmitResult`): a pure function of the book and the order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SubmitResult {
    pub accepted: bool,
    /// Only on acceptance: a refused order never consumes a sequence.
    pub sequence: Option<u64>,
    pub fills: Vec<Fill>,
    pub resting: Option<RestingRef>,
    pub rejected: Option<Reject>,
    pub cancellations: Vec<CancelledRef>,
    pub triggered: Vec<TriggerOutcome>,
    pub surveillance_cases: Vec<SurveillanceCase>,
}

impl SubmitResult {
    /// A refusal: nothing touched the book.
    pub fn refused(reason: Reject) -> SubmitResult {
        SubmitResult {
            rejected: Some(reason),
            ..SubmitResult::default()
        }
    }

    /// `presentSubmit`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("accepted", Json::Bool(self.accepted)),
            ("sequence", self.sequence.map_or(Json::Null, seq_json)),
            (
                "fills",
                Json::Array(self.fills.iter().map(Fill::to_json).collect()),
            ),
            ("resting", resting_json(self.resting.as_ref())),
            ("rejected", reject_or_null(self.rejected.as_ref())),
            (
                "cancellations",
                Json::Array(
                    self.cancellations
                        .iter()
                        .map(CancelledRef::to_json)
                        .collect(),
                ),
            ),
            (
                "triggered",
                Json::Array(self.triggered.iter().map(TriggerOutcome::to_json).collect()),
            ),
        ])
    }
}

/// What `cancel` answers (`CancelResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelResult {
    pub cancelled: bool,
    pub order_id: String,
    pub sequence: Option<u64>,
    pub cancellation: Option<CancelledRef>,
    /// Present when the cancel is refused rather than missing.
    pub rejected: Option<Reject>,
}

impl CancelResult {
    pub fn missing(order_id: &str) -> CancelResult {
        CancelResult {
            cancelled: false,
            order_id: order_id.to_owned(),
            sequence: None,
            cancellation: None,
            rejected: None,
        }
    }
}

/// `retained` or `lost`: whether an amend kept the order's place in the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Retained,
    Lost,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Retained => "retained",
            Priority::Lost => "lost",
        }
    }
}

/// What `amend` answers (`AmendResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmendResult {
    pub accepted: bool,
    pub order_id: String,
    pub sequence: Option<u64>,
    pub version: Option<u64>,
    pub priority: Option<Priority>,
    pub fills: Vec<Fill>,
    pub resting: Option<RestingRef>,
    pub rejected: Option<Reject>,
    pub cancellations: Vec<CancelledRef>,
    pub triggered: Vec<TriggerOutcome>,
    pub surveillance_cases: Vec<SurveillanceCase>,
}

impl AmendResult {
    /// `refusedAmend`.
    pub fn refused(order_id: &str, reason: Reject) -> AmendResult {
        AmendResult {
            accepted: false,
            order_id: order_id.to_owned(),
            sequence: None,
            version: None,
            priority: None,
            fills: Vec::new(),
            resting: None,
            rejected: Some(reason),
            cancellations: Vec::new(),
            triggered: Vec::new(),
            surveillance_cases: Vec::new(),
        }
    }

    /// `presentAmend`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("accepted", Json::Bool(self.accepted)),
            ("orderId", Json::str(self.order_id.clone())),
            ("sequence", self.sequence.map_or(Json::Null, seq_json)),
            ("version", self.version.map_or(Json::Null, seq_json)),
            (
                "priority",
                self.priority.map_or(Json::Null, |p| Json::str(p.as_str())),
            ),
            (
                "fills",
                Json::Array(self.fills.iter().map(Fill::to_json).collect()),
            ),
            ("resting", resting_json(self.resting.as_ref())),
            ("rejected", reject_or_null(self.rejected.as_ref())),
            (
                "cancellations",
                Json::Array(
                    self.cancellations
                        .iter()
                        .map(CancelledRef::to_json)
                        .collect(),
                ),
            ),
            (
                "triggered",
                Json::Array(self.triggered.iter().map(TriggerOutcome::to_json).collect()),
            ),
        ])
    }
}
