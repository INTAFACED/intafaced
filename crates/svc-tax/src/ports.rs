//! What svc-tax reads and keeps outside itself, one trait per port, each the Rust form of the TypeScript interface named
//! on it. The service (`tax.rs`) depends on these traits only; the HTTP clients and the Postgres stores implement them
//! (`clients/`, `stores/`), and tests inject fakes. Every port is synchronous: the service answers one request per
//! thread, and a port that reads several things at once does so inside itself.
//!
//! Types here are the data that crosses a port. The lot book's own types live with the lot book.

use crate::tax::{Account, Amount, Failure, HistoryEntry, Range, SubAccountLine};
use crate::time::Instant;

// ── The ledger (`ledger-reads.ts`, `TaxLedgerReads`) ────────────────────────────────────────────────────────────────

/// One of the caller's ledger accounts with its id and amount (`TaxBalance`). `account.purpose` is the hold's purpose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxBalance {
    pub account: Account,
    pub purpose: Option<String>,
    pub account_id: String,
    pub amount: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillLeg {
    pub asset_id: String,
    pub amount: Amount,
}

/// `Fill`: one of the customer's own trade fills, both legs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fill {
    pub tx_id: String,
    pub posted_at: Instant,
    /// Credited to the customer's balance, net of fee.
    pub received: FillLeg,
    /// Left the customer's order hold. `None` when the paying leg could not be read.
    pub paid: Option<FillLeg>,
    /// The fee taken from `received` in its asset; `None` when the ledger did not say.
    pub fee: Option<Amount>,
    /// The coin the fee was taken in when it is not `received`'s (venue fills); `None`: `received`'s coin.
    pub fee_asset_id: Option<String>,
}

/// `AccountLine`: one line on one of the customer's accounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLine {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub amount: Amount,
    pub reason: String,
    pub debit: bool,
}

/// `InflowLine`: an arrival on available that was not a fill and not the customer's own coins coming back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InflowLine {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub amount: Amount,
    pub reason: String,
}

/// `WithdrawalHold`: one withdrawal's own hold account (`withdraw:<id>`) and every line on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawalHold {
    pub purpose: String,
    pub lines: Vec<AccountLine>,
}

/// `TradeFills`. `inflows`, `outflows` and `withdrawal_holds` are `None` where the TypeScript leaves them absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TradeFills {
    pub fills: Vec<Fill>,
    pub truncated: bool,
    /// Assets that reached available other than by a fill or an own-coin return, sorted for a stable order.
    pub outside_inflows: Vec<String>,
    pub inflows: Option<Vec<InflowLine>>,
    pub outflows: Option<Vec<AccountLine>>,
    pub withdrawal_holds: Option<Vec<WithdrawalHold>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceLine {
    pub space_id: String,
    pub line: AccountLine,
}

/// `SpaceHistory`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceHistory {
    pub lines: Vec<SpaceLine>,
    pub truncated: bool,
}

/// `TaxLedgerReads`, the whole of it. The optional readers are `None` when not attached (`tradeFills` absent: the lot
/// book refuses `tax.ledger_unwired`; `spaceHistory` absent: the spaces are unavailable; the sub-account pair absent:
/// the year pack's sub-account books stay `unwired`).
pub trait Ledger: Send + Sync {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<TaxBalance>, Failure>;
    fn history(&self, account: &Account, range: Range) -> Result<Vec<HistoryEntry>, Failure>;
    fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
        None
    }
    fn space_history(&self) -> Option<&dyn SpaceHistoryReader> {
        None
    }
    fn sub_account_ids(&self, _user_id: &str) -> Option<Result<Vec<String>, Failure>> {
        None
    }
    fn sub_account_activity(
        &self,
        _id: &str,
        _range: Range,
    ) -> Option<Result<Vec<SubAccountLine>, Failure>> {
        None
    }
}

pub trait TradeFillReader: Send + Sync {
    fn trade_fills(&self, user_id: &str) -> Result<TradeFills, Failure>;
}

pub trait SpaceHistoryReader: Send + Sync {
    fn space_history(&self, space_ids: &[String]) -> Result<SpaceHistory, Failure>;
}

// ── Market data (`prices.ts`) ───────────────────────────────────────────────────────────────────────────────────────

/// `PriceAt`: a coin's price at a past moment and where it came from. `timeframe` is `1m`, `1h` or `1d`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceAt {
    pub price: Amount,
    pub market: String,
    pub timeframe: &'static str,
    pub candle_at: Instant,
}

/// `PriceAtTime`. An error is read as no price by the service, as the TypeScript's `.catch(() => null)`.
pub trait PriceAtTime: Send + Sync {
    fn price_at(&self, asset_id: &str, at: Instant) -> Result<Option<PriceAt>, Failure>;
}

/// `SeriesTimeframe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SeriesTimeframe {
    M5,
    H1,
    H4,
    D1,
    W1,
}

impl SeriesTimeframe {
    pub const ALL: [SeriesTimeframe; 5] = [Self::M5, Self::H1, Self::H4, Self::D1, Self::W1];

    pub fn name(self) -> &'static str {
        match self {
            Self::M5 => "5m",
            Self::H1 => "1h",
            Self::H4 => "4h",
            Self::D1 => "1d",
            Self::W1 => "1w",
        }
    }

    /// `SERIES_TIMEFRAME_MS`.
    pub fn ms(self) -> i64 {
        match self {
            Self::M5 => 300_000,
            Self::H1 => 3_600_000,
            Self::H4 => 14_400_000,
            Self::D1 => 86_400_000,
            Self::W1 => 604_800_000,
        }
    }
}

/// `CloseSeries`: one market's candles, open time (epoch ms) and close, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseSeries {
    pub market: String,
    pub candles: Vec<(i64, Amount)>,
}

/// `CloseSeriesSource`. `Ok(None)`: the coin has no such market. An error: market data could not be read.
pub trait CloseSeriesSource: Send + Sync {
    fn closes(
        &self,
        asset_id: &str,
        timeframe: SeriesTimeframe,
        from: Instant,
        to: Instant,
    ) -> Result<Option<CloseSeries>, Failure>;
}

// ── Customer basis (`basis-store.ts`) ───────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BasisKind {
    Override,
    Manual,
    Tombstone,
}

impl BasisKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Override => "override",
            Self::Manual => "manual",
            Self::Tombstone => "tombstone",
        }
    }
}

/// `BasisRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasisRow {
    pub user_id: String,
    pub lot_id: String,
    pub version: i64,
    pub kind: BasisKind,
    pub price_per_unit: Option<String>,
    pub acquired_at: Option<String>,
    pub source_note: Option<String>,
    pub asset_id: Option<String>,
    pub qty: Option<String>,
    pub business_key: String,
}

/// `ActiveBasis`: an override (asset and qty `None`) or a manual position (both set).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveBasis {
    pub manual: bool,
    pub lot_id: String,
    pub version: i64,
    pub price_per_unit: String,
    pub acquired_at: String,
    pub source_note: String,
    pub asset_id: Option<String>,
    pub qty: Option<String>,
}

/// `BasisWrite`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasisWrite {
    pub user_id: String,
    pub lot_id: String,
    pub manual: bool,
    pub price_per_unit: String,
    pub acquired_at: String,
    pub source_note: String,
    pub asset_id: Option<String>,
    pub qty: Option<String>,
}

/// `BasisStore`.
pub trait BasisStore: Send + Sync {
    fn list_active(&self, user_id: &str) -> Result<Vec<ActiveBasis>, Failure>;
    fn save(&self, write: &BasisWrite) -> Result<BasisRow, Failure>;
    fn clear(&self, user_id: &str, lot_id: &str) -> Result<BasisRow, Failure>;
}

// ── Cost-basis choices (`choices.ts`) ───────────────────────────────────────────────────────────────────────────────

/// `EngineMethod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineMethod {
    Fifo,
    Lifo,
    Hifo,
    Average,
}

impl EngineMethod {
    pub fn name(self) -> &'static str {
        match self {
            Self::Fifo => "FIFO",
            Self::Lifo => "LIFO",
            Self::Hifo => "HIFO",
            Self::Average => "AVERAGE",
        }
    }

    /// `isEngineMethod`.
    pub fn parse(raw: &str) -> Option<EngineMethod> {
        match raw {
            "FIFO" => Some(Self::Fifo),
            "LIFO" => Some(Self::Lifo),
            "HIFO" => Some(Self::Hifo),
            "AVERAGE" => Some(Self::Average),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayChoice {
    /// UTC day, `YYYY-MM-DD`.
    pub day: String,
    pub asset_id: Option<String>,
    pub method: EngineMethod,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotPick {
    pub sale_tx_id: String,
    pub asset_id: String,
    pub lot_id: String,
}

/// `CostBasisChoices`. `asset_methods` keeps the store's order (the TypeScript `Map`'s insertion order).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CostBasisChoices {
    pub account_method: Option<EngineMethod>,
    pub asset_methods: Vec<(String, EngineMethod)>,
    pub days: Vec<DayChoice>,
    pub picks: Vec<LotPick>,
    pub include_transfers: Option<bool>,
}

/// `ChoiceStore`.
pub trait ChoiceStore: Send + Sync {
    fn read(&self, user_id: &str) -> Result<CostBasisChoices, Failure>;
    fn set_method(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        method: Option<EngineMethod>,
    ) -> Result<(), Failure>;
    fn set_day_method(
        &self,
        user_id: &str,
        day: &str,
        asset_id: Option<&str>,
        method: Option<EngineMethod>,
    ) -> Result<(), Failure>;
    fn set_pick(
        &self,
        user_id: &str,
        sale_tx_id: &str,
        asset_id: &str,
        lot_id: Option<&str>,
    ) -> Result<(), Failure>;
    fn set_include_transfers(&self, user_id: &str, include: Option<bool>) -> Result<(), Failure>;
}

// ── svc-bank: the customer's own spaces (`@intafaced/contracts` `BankOwnSpacesPort`) ────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnSpace {
    pub space_id: String,
    pub asset_id: String,
    pub name: String,
    pub archived: bool,
}

/// `BankOwnSpacesResult`: `None` is `{ state: 'unavailable' }`, never an empty list.
pub trait OwnSpaces: Send + Sync {
    fn list(&self, user_id: &str) -> Option<Vec<OwnSpace>>;
}

// ── svc-trade: the customer's own venue accounts (`TradeVenueActivityPort`) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueFill {
    pub fill_id: String,
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub buy: bool,
    pub price: String,
    pub amount: String,
    pub fee: String,
    pub fee_asset: String,
    pub filled_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueOwnMove {
    pub move_id: String,
    pub sub_account: String,
    /// `into_sub_account` when true, `out_of_sub_account` when false.
    pub into_sub_account: bool,
    pub asset: String,
    pub amount: String,
    pub settled_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueArrival {
    pub arrival_id: String,
    /// `deposit`, `transfer_in` or `reward`.
    pub kind: String,
    pub asset: String,
    pub amount: String,
    pub arrived_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueBalance {
    pub asset: String,
    pub total: String,
}

/// `TradeVenueAccountActivity`. Strings stay as the wire sent them: the venue book parses them as the TypeScript does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueAccountActivity {
    pub venue_id: String,
    pub owner: String,
    pub sub_account: Option<String>,
    pub balances: Vec<VenueBalance>,
    pub fills: Vec<VenueFill>,
    pub transfers: Option<Vec<VenueOwnMove>>,
    pub arrivals: Option<Vec<VenueArrival>>,
    pub as_of: String,
}

/// `TradeVenueActivityResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VenueActivity {
    Off,
    Read {
        test: bool,
        accounts: Vec<VenueAccountActivity>,
    },
    /// `trade.venue_activity_unavailable`.
    Unavailable,
}

pub trait VenueActivitySource: Send + Sync {
    fn read(&self, user_id: &str) -> VenueActivity;
}
