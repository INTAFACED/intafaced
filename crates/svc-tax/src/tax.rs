//! svc-tax's own logic (`tax-service.ts`, `lots.ts`, `jurisdiction-map.ts`): the year export over
//! the caller's ledger reads, and each call's named refusals.
//!
//! What this service holds today: the export (preview and pack) in full. Not yet: the ledger fill reader the lot book
//! is built from, and the Postgres stores for a customer's basis and cost-basis choices. Without them the TypeScript
//! service refuses those calls by name (`tax.ledger_unwired`, `tax.basis_store_unwired`), and so does this one; each
//! moves here with its reader or store.

use std::collections::HashMap;
use std::sync::Arc;

use crate::basis::{
    BasisSet, MissingBasisItem, TAX_BASIS_LOT_UNKNOWN, list_missing_basis, parse_basis_set,
    result_json,
};
use crate::choices::{no_choices, sale_rules};
use crate::inputs::{BasisSetInput, DayMethodInput, LotMethodInput, PickInput, PnlInput};
use crate::json::Json;
use crate::lot_book::{
    BookChoices, BookInput, BookSpaces, DEFAULT_LOT_BOOK_METHOD, Inflow, LotBook, ManualPosition,
    SpaceHeld, Withdrawal, build_lot_book, is_par,
};
use crate::lot_engine::{LotSource, SaleRules, ValuedAt};
use crate::lots::{LotMethod, LotMovement, run_lots};
use crate::own_moves::{
    OwnMove, SpaceInflow, WITHDRAWAL_HOLD_PREFIX, outside_withdrawals, pair_own_moves,
};
use crate::pnl_over_time::{BookTimeline, PnlInputs, choose_interval, pnl_over_time};
use crate::ports::{
    AccountLine, ActiveBasis, BasisStore, ChoiceStore, CloseSeries, CloseSeriesSource,
    CostBasisChoices, EngineMethod, InflowLine, Ledger, LotPick, OwnSpaces, PriceAt, PriceAtTime,
    TaxBalance, VenueAccountActivity, VenueActivity, VenueActivitySource,
};
use crate::time::Instant;
use crate::venue_book::{BookShared, VenueExtras, venue_arrival_lines, with_venue};

/// Money is a scaled integer: 18 decimal places (`packages/ledger-client/src/money.ts`).
pub type Amount = i128;
const DECIMALS: usize = 18;
const SCALE: Amount = 1_000_000_000_000_000_000;

/// `formatAmount`: the shortest decimal string, no trailing zeros.
pub fn format_amount(value: Amount) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let abs = value.unsigned_abs();
    let scale = SCALE.unsigned_abs();
    let (whole, frac) = (abs / scale, abs % scale);
    if frac == 0 {
        return format!("{sign}{whole}");
    }
    let digits = format!("{frac:0DECIMALS$}");
    format!("{sign}{whole}.{}", digits.trim_end_matches('0'))
}

/// A named refusal (`TaxError`): sent as PRECONDITION_FAILED, the code leading the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxError {
    pub code: &'static str,
    pub message: String,
}

/// What a call can end in besides an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// One of the call's named refusals.
    Refused(TaxError),
    /// Anything else: sent as INTERNAL_SERVER_ERROR with this message.
    Internal(String),
}

fn refuse<T>(code: &'static str, message: &str) -> Result<T, Failure> {
    Err(Failure::Refused(TaxError {
        code,
        message: message.to_owned(),
    }))
}

pub const TAX_LEDGER_UNWIRED: &str = "tax.ledger_unwired";
pub const TAX_BASIS_STORE_UNWIRED: &str = "tax.basis_store_unwired";
pub const TAX_JURISDICTION_UNMAPPED: &str = "tax.jurisdiction_unmapped";
pub const TAX_JURISDICTION_MAP_INVALID: &str = "tax.jurisdiction_map_invalid";
pub const TAX_EXPORT_INCOMPLETE: &str = "tax.export_incomplete";
pub const TAX_HISTORY_YEARS_UNSET: &str = "tax.history_years_unset";
pub const TAX_LOT_METHOD_REQUIRED: &str = "tax.lot_method_required";
pub const TAX_PNL_RANGE_INVALID: &str = "tax.pnl_range_invalid";
pub const TAX_PNL_RANGE_TOO_LONG: &str = "tax.pnl_range_too_long";
pub const TAX_CLOSED_LOTS_UNINDEXED: &str = "tax.closed_lots_unindexed";
pub const TAX_COST_BASIS_UNAVAILABLE: &str = "tax.cost_basis_unavailable";
pub const TAX_LOT_UNDERFLOW: &str = "tax.lot_underflow";
pub const TAX_LOT_BOOK_INCOMPLETE: &str = "tax.lot_book_incomplete";
pub const TAX_LOT_BOOK_UNRECONCILED: &str = "tax.lot_book_unreconciled";
pub const TAX_LOT_PICK_UNUSABLE: &str = "tax.lot_pick_unusable";
pub const TAX_LOT_PICK_INVALID: &str = "tax.lot_pick_invalid";
pub const TAX_CHOICES_UNAVAILABLE: &str = "tax.choices_unavailable";
pub const TAX_OWN_SPACES_UNAVAILABLE: &str = "tax.own_spaces_unavailable";
pub const TAX_OWN_SPACES_UNWIRED: &str = "tax.own_spaces_unwired";
pub const TAX_DEPOSIT_BASIS_POLICY_UNSET: &str = "tax.deposit_basis_policy_unset";
pub const TAX_PRICE_AT_TIME_UNAVAILABLE: &str = "tax.price_at_time_unavailable";
pub const TAX_PNL_PRICES_UNAVAILABLE: &str = "tax.pnl_prices_unavailable";
pub const TAX_CUSTOMER_BASIS_EXPORT_UNSET: &str = "tax.customer_basis_export_unset";
pub const PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED: &str = "portfolio.basis_override_not_allowed";

const FILLS_UNWIRED: &str = "the ledger fill reader is not attached — tax does not invent a book";
const BASIS_UNWIRED: &str = "DATABASE_URL is unset — a customer basis is not stored";
const CHOICE_UNWIRED: &str = "DATABASE_URL is unset — a cost-basis choice is not stored";

/// `LakeStatus`: an env URL is configuration, never evidence the lake answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LakeStatus {
    DataLakeAbsent,
    DataLakeConfigured,
    IndexerAbsent,
    IndexerConfigured,
}

impl LakeStatus {
    /// `lakeStatusFromUrl`.
    pub fn lake(url: Option<&str>) -> LakeStatus {
        if url.is_some_and(|u| !u.trim().is_empty()) {
            LakeStatus::DataLakeConfigured
        } else {
            LakeStatus::DataLakeAbsent
        }
    }

    /// `indexerStatusFromUrl`.
    pub fn indexer(url: Option<&str>) -> LakeStatus {
        if url.is_some_and(|u| !u.trim().is_empty()) {
            LakeStatus::IndexerConfigured
        } else {
            LakeStatus::IndexerAbsent
        }
    }

    fn json(self) -> Json {
        let (status, code) = match self {
            LakeStatus::DataLakeAbsent => ("absent", "tax.data_lake_unavailable"),
            LakeStatus::DataLakeConfigured => ("configured", "tax.data_lake_unprobed"),
            LakeStatus::IndexerAbsent => ("absent", "tax.indexer_unavailable"),
            LakeStatus::IndexerConfigured => ("configured", "tax.indexer_unprobed"),
        };
        Json::obj([("status", Json::str(status)), ("code", Json::str(code))])
    }
}

/// One of the caller's ledger accounts, as the ledger names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub owner_type: String,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub tx_id: String,
    pub reason: String,
    pub debit: bool,
    pub amount: Amount,
    pub posted_at: Instant,
}

/// The export's window: the start of the year `historyYears` back, to now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub from: Instant,
    pub to: Instant,
}

/// One fill or convert on one sub-account. A missing figure stays missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubAccountLine {
    pub id: String,
    pub convert: bool,
    pub posted_at: Instant,
    pub asset_id: String,
    pub qty: Amount,
    pub fee: Option<Amount>,
    pub maker_rebate: Option<Amount>,
    pub cost_basis: Option<Amount>,
    pub proceeds: Option<Amount>,
}

/// `parseJurisdictionMap`: the counsel map, a JSON array or object of ISO alpha-2 codes. Blank, `[]` and `{}` map nothing.
pub fn parse_map(raw: &str) -> Result<Vec<String>, TaxError> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let invalid = |message: &str| TaxError {
        code: TAX_JURISDICTION_MAP_INVALID,
        message: message.to_owned(),
    };
    let parsed = crate::json::parse(text)
        .map_err(|_| invalid("TAX_JURISDICTION_MAP_JSON is not valid JSON"))?;
    let codes: Vec<String> = match parsed {
        Json::Array(items) => items
            .into_iter()
            .map(|i| match i {
                Json::String(s) if is_alpha2(&s) => Ok(s),
                _ => Err(invalid(
                    "TAX_JURISDICTION_MAP_JSON array entries must be ISO-3166 alpha-2",
                )),
            })
            .collect::<Result<_, _>>()?,
        Json::Object(fields) => fields
            .into_iter()
            .map(|(k, _)| {
                if is_alpha2(&k) {
                    Ok(k)
                } else {
                    Err(invalid(
                        "TAX_JURISDICTION_MAP_JSON keys must be ISO-3166 alpha-2",
                    ))
                }
            })
            .collect::<Result<_, _>>()?,
        _ => {
            return Err(invalid(
                "TAX_JURISDICTION_MAP_JSON must be an object or array of region codes",
            ));
        }
    };
    Ok(codes)
}

fn is_alpha2(s: &str) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase())
}

/// `DepositBasisPolicy`: the owner's cost for a coin that arrived other than by a trade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepositBasisPolicy {
    /// Its value when it arrived.
    Market,
    /// Unknown until the customer enters one.
    Customer,
}

/// How the service is put together: everything it reads, handed in once (`TaxServiceDeps`). An optional port is `None`
/// where the TypeScript leaves it absent.
pub struct TaxDeps {
    /// `TAX_JURISDICTION_MAP_JSON`.
    pub map_raw: String,
    pub ledger: Arc<dyn Ledger>,
    pub lake: LakeStatus,
    pub indexer: LakeStatus,
    /// `TAX_HISTORY_YEARS`: the owner's export window, 1 to 100. Unset refuses; never 10 by default.
    pub history_years: Option<i64>,
    pub now: Box<dyn Fn() -> Instant + Send + Sync>,
    pub deposit_basis: Option<DepositBasisPolicy>,
    pub prices: Option<Arc<dyn PriceAtTime>>,
    pub closes: Option<Arc<dyn CloseSeriesSource>>,
    pub basis: Option<Arc<dyn BasisStore>>,
    pub choices: Option<Arc<dyn ChoiceStore>>,
    pub spaces: Option<Arc<dyn OwnSpaces>>,
    pub venue: Option<Arc<dyn VenueActivitySource>>,
}

impl TaxDeps {
    /// The service with only the ledger attached: every optional port absent.
    pub fn new(
        map_raw: impl Into<String>,
        ledger: Arc<dyn Ledger>,
        history_years: Option<i64>,
        now: Box<dyn Fn() -> Instant + Send + Sync>,
    ) -> TaxDeps {
        TaxDeps {
            map_raw: map_raw.into(),
            ledger,
            lake: LakeStatus::DataLakeAbsent,
            indexer: LakeStatus::IndexerAbsent,
            history_years,
            now,
            deposit_basis: None,
            prices: None,
            closes: None,
            basis: None,
            choices: None,
            spaces: None,
            venue: None,
        }
    }
}

pub struct TaxService {
    regions: Vec<String>,
    ledger: Arc<dyn Ledger>,
    lake: LakeStatus,
    indexer: LakeStatus,
    history_years: Option<i64>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    deposit_basis: Option<DepositBasisPolicy>,
    prices: Option<Arc<dyn PriceAtTime>>,
    closes: Option<Arc<dyn CloseSeriesSource>>,
    basis: Option<Arc<dyn BasisStore>>,
    choices: Option<Arc<dyn ChoiceStore>>,
    spaces: Option<Arc<dyn OwnSpaces>>,
    venue: Option<Arc<dyn VenueActivitySource>>,
}

/// The export's preview and its file.
pub struct Export {
    pub preview: Vec<(String, Json)>,
    pub body: String,
    pub filename: String,
}

impl Export {
    /// `tax.exportPreview`'s answer.
    pub fn preview(self) -> Json {
        Json::Object(self.preview)
    }

    /// `tax.exportPack`'s answer: the preview, the file's name and type, and the file itself in base64.
    pub fn pack(self) -> Json {
        let mut fields = self.preview;
        fields.push(("filename".to_owned(), Json::str(self.filename)));
        fields.push(("mime".to_owned(), Json::str("application/json")));
        fields.push((
            "bodyBase64".to_owned(),
            Json::str(base64(self.body.as_bytes())),
        ));
        Json::Object(fields)
    }
}

/// Standard base64 with padding, as `Buffer#toString('base64')`.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let sym = |n: u32| {
        char::from(
            ALPHABET
                .get(usize::try_from(n & 63).unwrap_or(0))
                .copied()
                .unwrap_or(b'A'),
        )
    };
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        out.push(sym(n >> 18));
        out.push(sym(n >> 12));
        out.push(if chunk.len() > 1 { sym(n >> 6) } else { '=' });
        out.push(if chunk.len() > 2 { sym(n) } else { '=' });
    }
    out
}

/// `requireBookMethod`: the lot book also offers AVERAGE.
fn require_book_method(raw: &str) -> Result<EngineMethod, Failure> {
    EngineMethod::parse(raw).ok_or_else(|| {
        Failure::Refused(TaxError {
            code: TAX_LOT_METHOD_REQUIRED,
            message: "Caller must select FIFO, LIFO, HIFO or AVERAGE".to_owned(),
        })
    })
}

/// `inflowSource`: where a coin that was not bought came from, by the ledger reason that brought it.
pub fn inflow_source(reason: &str) -> LotSource {
    if reason.starts_with("deposit.") {
        LotSource::Deposit
    } else if reason == crate::venue_book::VENUE_TRANSFER_IN {
        LotSource::TransferIn
    } else if reason == "bank.earn.interest" || reason.contains("reward") {
        LotSource::Reward
    } else if reason.starts_with("bank.transfer")
        || reason == "identity.sub_account.transfer"
        || reason.starts_with("pay.")
    {
        LotSource::TransferIn
    } else {
        LotSource::OtherIn
    }
}

/// `pricesOf`: the customer's price per unit for each lot with an override.
fn prices_of(active: &[ActiveBasis]) -> Result<Option<HashMap<String, Amount>>, Failure> {
    let mut map = HashMap::new();
    for row in active.iter().filter(|r| !r.manual) {
        map.insert(
            row.lot_id.clone(),
            crate::money::parse_amount(&row.price_per_unit).map_err(Failure::Internal)?,
        );
    }
    Ok((!map.is_empty()).then_some(map))
}

/// `manualOf`.
fn manual_of(active: &[ActiveBasis]) -> Result<Vec<ManualPosition>, Failure> {
    let mut out = Vec::new();
    for row in active.iter().filter(|r| r.manual) {
        let (Some(asset_id), Some(qty)) = (&row.asset_id, &row.qty) else {
            continue;
        };
        let price = crate::money::parse_amount(&row.price_per_unit).map_err(Failure::Internal)?;
        let units = crate::money::parse_amount(qty).map_err(Failure::Internal)?;
        out.push(ManualPosition {
            id: row.lot_id.clone(),
            asset_id: asset_id.clone(),
            acquired_at: row.acquired_at.clone(),
            qty: qty.clone(),
            price_per_unit: row.price_per_unit.clone(),
            cost_usd: format_amount(crate::money::mul(price, units)),
            source_note: row.source_note.clone(),
        });
    }
    Ok(out)
}

fn with_manual(mut book: LotBook, active: &[ActiveBasis]) -> Result<LotBook, Failure> {
    let manual = manual_of(active)?;
    if !manual.is_empty() {
        book.manual_positions = Some(manual);
    }
    Ok(book)
}

fn saved_json() -> Json {
    Json::obj([("saved", Json::Bool(true))])
}

/// What `ownMoves` hands the book.
struct OwnMoves {
    spaces: BookSpaces,
    moves: Vec<OwnMove>,
    main_inflows: Vec<InflowLine>,
    space_inflows: Vec<SpaceInflow>,
    truncated: bool,
    space_held: Option<Vec<SpaceHeld>>,
}

/// One arrival to value: a line, and the space it reached (`None`: the main account).
struct Arrival<'a> {
    line: &'a InflowLine,
    space_id: Option<&'a str>,
}

impl TaxService {
    /// A map that is not valid refuses here, at start-up, as the TypeScript constructor throws.
    pub fn new(deps: TaxDeps) -> Result<TaxService, TaxError> {
        Ok(TaxService {
            regions: parse_map(&deps.map_raw)?,
            ledger: deps.ledger,
            lake: deps.lake,
            indexer: deps.indexer,
            history_years: deps.history_years,
            now: deps.now,
            deposit_basis: deps.deposit_basis,
            prices: deps.prices,
            closes: deps.closes,
            basis: deps.basis,
            choices: deps.choices,
            spaces: deps.spaces,
            venue: deps.venue,
        })
    }

    pub fn now(&self) -> Instant {
        (self.now)()
    }

    /// `tax.lotBook`: the customer's saved choices, else the product default FIFO; with a method, that method previewed for
    /// every sale. The person's own venue accounts are listed beside it.
    pub fn lot_book(&self, user_id: &str, method: Option<&str>) -> Result<LotBook, Failure> {
        self.book(user_id, method, true)
    }

    /// `tax.missingBasis`.
    pub fn missing_basis(&self, user_id: &str, method: Option<&str>) -> Result<Json, Failure> {
        let book = self.lot_book(user_id, method)?;
        let items = list_missing_basis(&book);
        Ok(Json::obj([(
            "items",
            Json::Array(items.iter().map(MissingBasisItem::json).collect()),
        )]))
    }

    fn book(
        &self,
        user_id: &str,
        method: Option<&str>,
        with_venue_accounts: bool,
    ) -> Result<LotBook, Failure> {
        let preview = method.map(require_book_method).transpose()?;
        let mut saved = no_choices();
        let mut unreadable = false;
        if let Some(store) = &self.choices {
            match store.read(user_id) {
                Ok(c) => saved = c,
                Err(_) => unreadable = true,
            }
        }
        let choices = if unreadable {
            BookChoices::Unavailable
        } else {
            self.book_choices(&saved)
        };
        let main = self.book_with(user_id, preview, &saved, choices.clone())?;
        if !with_venue_accounts {
            return Ok(main);
        }
        let activity = self.venue.as_ref().map(|v| v.read(user_id));
        let arrived: Vec<&VenueAccountActivity> = match &activity {
            Some(VenueActivity::Read { accounts, .. }) => {
                accounts.iter().filter(|a| a.arrivals.is_some()).collect()
            }
            _ => Vec::new(),
        };
        let mut residuals: Vec<&'static str> = Vec::new();
        let mut extras = VenueExtras::default();
        let override_prices;
        if !arrived.is_empty() {
            let active = self.active_basis(user_id)?;
            for a in &arrived {
                let lines = venue_arrival_lines(a)?;
                let arrivals: Vec<Arrival<'_>> = lines
                    .iter()
                    .map(|line| Arrival {
                        line,
                        space_id: None,
                    })
                    .collect();
                let valued = self.value_inflows(&arrivals, &mut residuals);
                extras.inflows.insert(crate::venue_book::key_of(a), valued);
            }
            override_prices = prices_of(&active)?;
            extras.override_price_per_unit = override_prices.as_ref();
        }
        let rules_fn = sale_rules(&saved, DEFAULT_LOT_BOOK_METHOD, preview);
        let rules = SaleRules::By(&rules_fn);
        let shared = BookShared {
            method: main.method,
            rules: &rules,
            preview: preview.is_some(),
            choices,
            include_transfers: main.include_transfers,
            now: self.now(),
        };
        let mut book = with_venue(main, activity.as_ref(), &shared, &extras)?;
        if !residuals.is_empty() {
            book.residuals.extend(residuals);
            book.residuals.sort_unstable();
            book.residuals.dedup();
        }
        Ok(book)
    }

    /// `bookChoices`.
    fn book_choices(&self, saved: &CostBasisChoices) -> BookChoices {
        if self.choices.is_none() {
            return BookChoices::Unwired;
        }
        let mut asset_methods = saved.asset_methods.clone();
        asset_methods.sort_by(|(a, _), (b, _)| locale_compare(a, b));
        BookChoices::Saved {
            account_method: saved.account_method,
            asset_methods,
            days: saved.days.clone(),
            picks: saved.picks.clone(),
            include_transfers: saved.include_transfers,
        }
    }

    fn active_basis(&self, user_id: &str) -> Result<Vec<ActiveBasis>, Failure> {
        match &self.basis {
            Some(b) => b.list_active(user_id),
            None => Ok(Vec::new()),
        }
    }

    /// `bookWith`: the ledger's own book.
    fn book_with(
        &self,
        user_id: &str,
        preview: Option<EngineMethod>,
        saved: &CostBasisChoices,
        choices: BookChoices,
    ) -> Result<LotBook, Failure> {
        let method = preview
            .or(saved.account_method)
            .unwrap_or(DEFAULT_LOT_BOOK_METHOD);
        let rules_fn = sale_rules(saved, DEFAULT_LOT_BOOK_METHOD, preview);
        let rules = SaleRules::By(&rules_fn);
        let include_transfers = saved.include_transfers.unwrap_or(true);
        let Some(reader) = self.ledger.trade_fills() else {
            return refuse(TAX_LEDGER_UNWIRED, FILLS_UNWIRED);
        };
        let balances = self.ledger.balances("user", user_id)?;
        let filled = reader.trade_fills(user_id)?;
        let active = self.active_basis(user_id)?;
        let spaces = self.own_spaces(user_id);
        let follows_withdrawals = filled.inflows.is_some();
        let mut held: HashMap<String, Amount> = HashMap::new();
        for row in &balances {
            if follows_withdrawals
                && row.account.kind == "hold"
                && row
                    .purpose
                    .as_deref()
                    .unwrap_or("")
                    .starts_with(WITHDRAWAL_HOLD_PREFIX)
            {
                continue;
            }
            if row.amount > 0 {
                *held.entry(row.account.asset_id.clone()).or_insert(0) += row.amount;
            }
        }
        let override_prices = prices_of(&active)?;
        let now = self.now();
        let Some(main_inflows) = &filled.inflows else {
            let book = build_lot_book(BookInput {
                fills: &filled.fills,
                held: &held,
                method,
                rules: Some(&rules),
                preview: preview.is_some(),
                choices: Some(choices),
                truncated: filled.truncated,
                outside_inflows: &filled.outside_inflows,
                inflows: &[],
                now,
                override_price_per_unit: override_prices.as_ref(),
                moves: &[],
                carried_in: &[],
                spaces: None,
                space_held: None,
                withdrawals: &[],
                include_transfers,
            });
            return with_manual(book, &active);
        };
        let mut extra: Vec<&'static str> = Vec::new();
        let own = self.own_moves(
            spaces,
            main_inflows,
            filled.outflows.as_deref().unwrap_or(&[]),
            &mut extra,
        );
        let arrivals: Vec<Arrival<'_>> = own
            .main_inflows
            .iter()
            .map(|line| Arrival {
                line,
                space_id: None,
            })
            .chain(own.space_inflows.iter().map(|s| Arrival {
                line: &s.line,
                space_id: Some(&s.space_id),
            }))
            .collect();
        let inflows = self.value_inflows(&arrivals, &mut extra);
        let out = outside_withdrawals(filled.withdrawal_holds.as_deref().unwrap_or(&[]));
        let mut dropped: Vec<&'static str> = Vec::new();
        let withdrawals = self.value_withdrawals(
            &out,
            if include_transfers {
                &mut extra
            } else {
                &mut dropped
            },
        );
        let mut book = build_lot_book(BookInput {
            fills: &filled.fills,
            held: &held,
            method,
            rules: Some(&rules),
            preview: preview.is_some(),
            choices: Some(choices),
            truncated: filled.truncated || own.truncated,
            outside_inflows: &[],
            inflows: &inflows,
            now,
            override_price_per_unit: override_prices.as_ref(),
            moves: &own.moves,
            carried_in: &[],
            spaces: Some(own.spaces),
            space_held: own.space_held.as_deref(),
            withdrawals: &withdrawals,
            include_transfers,
        });
        book.residuals.extend(extra);
        book.residuals.sort_unstable();
        book.residuals.dedup();
        with_manual(book, &active)
    }

    /// `ownSpaces`.
    fn own_spaces(&self, user_id: &str) -> BookSpaces {
        match &self.spaces {
            None => BookSpaces::Unwired,
            Some(port) => match port.list(user_id) {
                None => BookSpaces::Unavailable,
                Some(list) => BookSpaces::Read(list),
            },
        }
    }

    /// `ownMoves`: the spaces' history, paired into moves between the customer's own accounts.
    fn own_moves(
        &self,
        spaces: BookSpaces,
        main_inflows: &[InflowLine],
        main_outflows: &[AccountLine],
        residuals: &mut Vec<&'static str>,
    ) -> OwnMoves {
        let none = |spaces: BookSpaces| OwnMoves {
            spaces,
            moves: Vec::new(),
            main_inflows: main_inflows.to_vec(),
            space_inflows: Vec::new(),
            truncated: false,
            space_held: None,
        };
        if spaces == BookSpaces::Unavailable {
            residuals.push(TAX_OWN_SPACES_UNAVAILABLE);
        }
        let list = match &spaces {
            BookSpaces::Read(list) if !list.is_empty() => list.clone(),
            _ => return none(spaces),
        };
        let Some(reader) = self.ledger.space_history() else {
            residuals.push(TAX_OWN_SPACES_UNAVAILABLE);
            return none(BookSpaces::Unavailable);
        };
        let ids: Vec<String> = list.iter().map(|s| s.space_id.clone()).collect();
        let Ok(history) = reader.space_history(&ids) else {
            residuals.push(TAX_OWN_SPACES_UNAVAILABLE);
            return none(BookSpaces::Unavailable);
        };
        let mut space_held: Vec<SpaceHeld> = Vec::new();
        for l in &history.lines {
            let signed = if l.line.debit {
                l.line.amount
            } else {
                -l.line.amount
            };
            let held = match space_held.iter_mut().find(|(s, _)| *s == l.space_id) {
                Some((_, held)) => held,
                None => {
                    space_held.push((l.space_id.clone(), Vec::new()));
                    match space_held.last_mut() {
                        Some((_, held)) => held,
                        None => continue,
                    }
                }
            };
            match held.iter_mut().find(|(a, _)| *a == l.line.asset_id) {
                Some((_, q)) => *q += signed,
                None => held.push((l.line.asset_id.clone(), signed)),
            }
        }
        for s in &list {
            if !space_held.iter().any(|(id, _)| *id == s.space_id) {
                space_held.push((s.space_id.clone(), Vec::new()));
            }
        }
        let paired = pair_own_moves(main_inflows, main_outflows, &history.lines);
        OwnMoves {
            spaces,
            moves: paired.moves,
            main_inflows: paired.main_inflows,
            space_inflows: paired.space_inflows,
            truncated: history.truncated,
            space_held: Some(space_held),
        }
    }

    /// `valueInflows`: each arrival becomes a lot, valued when it arrived, with the basis the owner's policy gives it.
    fn value_inflows(
        &self,
        lines: &[Arrival<'_>],
        residuals: &mut Vec<&'static str>,
    ) -> Vec<Inflow> {
        if self.deposit_basis.is_none() && lines.iter().any(|a| !is_par(&a.line.asset_id)) {
            residuals.push(TAX_DEPOSIT_BASIS_POLICY_UNSET);
        }
        let mut cache: HashMap<String, Option<PriceAt>> = HashMap::new();
        let mut out = Vec::new();
        for a in lines.iter().filter(|a| !is_par(&a.line.asset_id)) {
            let line = a.line;
            let price = match &self.prices {
                None => None,
                Some(prices) => {
                    let key = format!("{}|{}", line.asset_id, line.posted_at.0.div_euclid(60_000));
                    cache
                        .entry(key)
                        .or_insert_with(|| {
                            prices
                                .price_at(&line.asset_id, line.posted_at)
                                .ok()
                                .flatten()
                        })
                        .clone()
                }
            };
            if price.is_none() {
                residuals.push(TAX_PRICE_AT_TIME_UNAVAILABLE);
            }
            let valued_at = price.map(|p| ValuedAt {
                usd: crate::money::mul(line.amount, p.price),
                market: p.market,
                timeframe: Some(p.timeframe.to_owned()),
                candle_at: Some(p.candle_at),
                price: p.price,
            });
            out.push(Inflow {
                tx_id: line.tx_id.clone(),
                posted_at: line.posted_at,
                asset_id: line.asset_id.clone(),
                amount: line.amount,
                reason: line.reason.clone(),
                source: inflow_source(&line.reason),
                cost_usd: if self.deposit_basis == Some(DepositBasisPolicy::Market) {
                    valued_at.as_ref().map(|v| v.usd)
                } else {
                    None
                },
                valued_at,
                space_id: a.space_id.map(str::to_owned),
            });
        }
        out
    }

    /// `valueWithdrawals`: each withdrawal valued when it left, or unknown when no price was found.
    fn value_withdrawals(
        &self,
        lines: &[AccountLine],
        residuals: &mut Vec<&'static str>,
    ) -> Vec<Withdrawal> {
        let mut out = Vec::new();
        for line in lines.iter().filter(|l| !is_par(&l.asset_id)) {
            let price = self
                .prices
                .as_ref()
                .and_then(|p| p.price_at(&line.asset_id, line.posted_at).ok().flatten());
            if price.is_none() {
                residuals.push(TAX_PRICE_AT_TIME_UNAVAILABLE);
            }
            out.push(Withdrawal {
                tx_id: line.tx_id.clone(),
                posted_at: line.posted_at,
                asset_id: line.asset_id.clone(),
                amount: line.amount,
                value_usd: price.map(|p| crate::money::mul(line.amount, p.price)),
            });
        }
        out
    }

    /// `tax.pnlOverTime`: the range is checked first, then the ledger's own book is read and priced.
    pub fn pnl_over_time(&self, user_id: &str, input: &PnlInput) -> Result<Json, Failure> {
        let now = self.now();
        let asked = input.to.unwrap_or(now);
        let to = if asked > now { now } else { asked };
        let from = input.from;
        if from >= to {
            return refuse(
                TAX_PNL_RANGE_INVALID,
                "the range must start before it ends, and before now",
            );
        }
        let Some(interval) = choose_interval(from, to, now) else {
            return refuse(
                TAX_PNL_RANGE_TOO_LONG,
                "the range starts too long ago to be priced: pick a later start",
            );
        };
        let book = self.book(user_id, None, false)?;
        let timeline = BookTimeline::new(&book);
        let mut closes: HashMap<String, Option<CloseSeries>> = HashMap::new();
        if !timeline.coins().is_empty() {
            let Some(source) = &self.closes else {
                return refuse(
                    TAX_PNL_PRICES_UNAVAILABLE,
                    "market data is not attached: no chart is drawn without prices",
                );
            };
            for asset_id in timeline.coins() {
                match source.closes(asset_id, interval, from, to) {
                    Ok(series) => {
                        closes.insert(asset_id.clone(), series);
                    }
                    Err(_) => {
                        return refuse(
                            TAX_PNL_PRICES_UNAVAILABLE,
                            "market data could not be read: no chart is drawn from part of it",
                        );
                    }
                }
            }
        }
        pnl_over_time(&PnlInputs {
            book: &book,
            from,
            to,
            now,
            interval,
            utc_offset_minutes: input.utc_offset_minutes,
            closes: &closes,
            timeline: Some(&timeline),
        })
    }

    fn choice_store(&self) -> Result<&Arc<dyn ChoiceStore>, Failure> {
        match &self.choices {
            Some(c) => Ok(c),
            None => refuse(TAX_BASIS_STORE_UNWIRED, CHOICE_UNWIRED),
        }
    }

    fn basis_store(&self) -> Result<&Arc<dyn BasisStore>, Failure> {
        match &self.basis {
            Some(b) => Ok(b),
            None => refuse(TAX_BASIS_STORE_UNWIRED, BASIS_UNWIRED),
        }
    }

    /// `tax.basisOverride.set`: a price for a lot with no cost from our own records, or a manual position.
    pub fn basis_override_set(
        &self,
        user_id: &str,
        input: &BasisSetInput,
    ) -> Result<Json, Failure> {
        let store = self.basis_store()?;
        let write = parse_basis_set(&BasisSet {
            user_id,
            lot_id: &input.lot_id,
            price_per_unit: &input.price_per_unit,
            date: &input.date,
            source_note: &input.source_note,
            asset_id: input.asset_id.as_deref(),
            qty: input.qty.as_deref(),
        })?;
        if !write.manual {
            let book = self.lot_book(user_id, None)?;
            let Some(lot) = book.lots.iter().find(|l| l.id == write.lot_id) else {
                return refuse(TAX_BASIS_LOT_UNKNOWN, "that lot is not in this account");
            };
            if lot.cost_usd.is_some() && !lot.customer_entered {
                return refuse(
                    PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED,
                    "a lot that already has a cost from our own records is not overwritten",
                );
            }
        }
        Ok(result_json(&store.save(&write)?))
    }

    /// `tax.basisOverride.remove`: a tombstone; the unknown it replaced shows again.
    pub fn basis_override_remove(&self, user_id: &str, lot_id: &str) -> Result<Json, Failure> {
        let store = self.basis_store()?;
        let lot_id = crate::basis::js_trim(lot_id);
        if lot_id.is_empty() {
            return refuse(TAX_BASIS_LOT_UNKNOWN, "a basis write needs a lot id");
        }
        Ok(result_json(&store.clear(user_id, lot_id)?))
    }

    /// `tax.setLotMethod`.
    pub fn set_lot_method(&self, user_id: &str, input: &LotMethodInput) -> Result<Json, Failure> {
        let method = input
            .method
            .as_deref()
            .map(require_book_method)
            .transpose()?;
        self.choice_store()?
            .set_method(user_id, input.asset_id.as_deref(), method)?;
        Ok(saved_json())
    }

    /// `tax.setDayMethod`.
    pub fn set_day_method(&self, user_id: &str, input: &DayMethodInput) -> Result<Json, Failure> {
        let method = input
            .method
            .as_deref()
            .map(require_book_method)
            .transpose()?;
        self.choice_store()?.set_day_method(
            user_id,
            &input.day,
            input.asset_id.as_deref(),
            method,
        )?;
        Ok(saved_json())
    }

    /// `tax.pickSaleLot`: worked out with the pick in place; a lot the sale could not draw on is refused, not stored.
    pub fn pick_sale_lot(&self, user_id: &str, input: &PickInput) -> Result<Json, Failure> {
        let store = self.choice_store()?;
        if let Some(lot_id) = &input.lot_id {
            let saved = store.read(user_id)?;
            let mut with_pick = saved.clone();
            with_pick
                .picks
                .retain(|p| !(p.sale_tx_id == input.sale_tx_id && p.asset_id == input.asset_id));
            with_pick.picks.push(LotPick {
                sale_tx_id: input.sale_tx_id.clone(),
                asset_id: input.asset_id.clone(),
                lot_id: lot_id.clone(),
            });
            let book = self.book_with(user_id, None, &with_pick, self.book_choices(&saved))?;
            let sale = book
                .sales
                .iter()
                .find(|s| s.tx_id == input.sale_tx_id && s.asset_id == input.asset_id);
            let Some(sale) = sale.filter(|s| s.picked_lot_id.as_deref() == Some(lot_id.as_str()))
            else {
                return refuse(
                    TAX_LOT_PICK_INVALID,
                    "that lot is not one this sale could draw on: same coin, arrived by then, not used up",
                );
            };
            if sale.method == EngineMethod::Average {
                return refuse(
                    TAX_LOT_PICK_INVALID,
                    "a sale matched at the average cost draws on no one lot",
                );
            }
        }
        store.set_pick(
            user_id,
            &input.sale_tx_id,
            &input.asset_id,
            input.lot_id.as_deref(),
        )?;
        Ok(saved_json())
    }

    /// `tax.setIncludeTransfers`.
    pub fn set_include_transfers(
        &self,
        user_id: &str,
        include: Option<bool>,
    ) -> Result<Json, Failure> {
        self.choice_store()?
            .set_include_transfers(user_id, include)?;
        Ok(saved_json())
    }

    /// `build`: the year export, refused unless the caller's region is on the counsel map and the window is published.
    pub fn export(
        &self,
        user_id: &str,
        region: &str,
        lot_method: &str,
        complete: Option<bool>,
    ) -> Result<Export, Failure> {
        if complete == Some(true) {
            return refuse(
                TAX_EXPORT_INCOMPLETE,
                "Tax export completeness is OWNER map — never certified complete, never invent jurisdictions",
            );
        }
        let Some(method) = LotMethod::parse(lot_method) else {
            return refuse(
                TAX_LOT_METHOD_REQUIRED,
                "Caller must select FIFO, LIFO, or HIFO — no silent default",
            );
        };
        let code = region.trim().to_uppercase();
        if !is_alpha2(&code) || !self.regions.contains(&code) {
            return refuse(
                TAX_JURISDICTION_UNMAPPED,
                "No counsel jurisdiction map for this region — owner TAX_JURISDICTION_MAP_JSON is blank or does not include it. Never default a country.",
            );
        }
        let Some(years) = self.history_years.filter(|y| (1..=100).contains(y)) else {
            return refuse(
                TAX_HISTORY_YEARS_UNSET,
                "TAX_HISTORY_YEARS is unset — owner must publish the export history window (never invent 10 years)",
            );
        };
        let now = self.now();
        let range = Range {
            from: Instant::start_of_year(now.year() - years),
            to: now,
        };

        let available: Vec<TaxBalance> = self
            .ledger
            .balances("user", user_id)?
            .into_iter()
            .filter(|b| b.account.kind == "available")
            .collect();
        let mut residuals: Vec<&'static str> =
            vec![TAX_CLOSED_LOTS_UNINDEXED, TAX_EXPORT_INCOMPLETE];
        let mut movements: Vec<LotMovement> = Vec::new();
        for row in &available {
            for e in self.ledger.history(&row.account, range)? {
                movements.push(LotMovement {
                    asset_id: row.account.asset_id.clone(),
                    acquire: e.debit,
                    qty: e.amount,
                    cost_basis: None,
                    proceeds: None,
                    posted_at: e.posted_at,
                    tx_id: e.tx_id,
                    reason: e.reason,
                });
            }
        }
        if !movements.is_empty() {
            residuals.push(TAX_COST_BASIS_UNAVAILABLE);
        }
        if !self.active_basis(user_id)?.is_empty() {
            residuals.push(TAX_CUSTOMER_BASIS_EXPORT_UNSET);
        }
        let lots = run_lots(&movements, method);
        residuals.extend(lots.residuals.iter().copied());
        let (books, accounts) = self.sub_account_books(user_id, range)?;
        for account in &accounts {
            residuals.extend(account.residuals.iter().copied());
        }
        residuals.sort_unstable();
        residuals.dedup();

        let empty = lots.lots_closed.is_empty()
            && lots.lots_open.is_empty()
            && accounts.iter().all(|a| a.lines.is_empty());
        let residuals_json = Json::Array(residuals.iter().map(|r| Json::str(*r)).collect());
        let accounts_json = Json::Array(accounts.iter().map(SubAccountYear::json).collect());
        let lot_count = i64::try_from(lots.lots_closed.len() + lots.lots_open.len())
            .map_err(|e| Failure::Internal(e.to_string()))?;
        let opt = |v: &Option<String>| match v {
            Some(s) if !empty => Json::str(s.clone()),
            _ => Json::Null,
        };
        let (realized, unrealized) = (opt(&lots.realized), opt(&lots.unrealized));
        let preview = vec![
            ("empty".to_owned(), Json::Bool(empty)),
            ("complete".to_owned(), Json::Bool(false)),
            ("lotMethod".to_owned(), Json::str(lot_method)),
            ("jurisdiction".to_owned(), Json::str(code.clone())),
            ("lotCount".to_owned(), Json::int(lot_count)),
            ("realized".to_owned(), realized.clone()),
            ("unrealized".to_owned(), unrealized.clone()),
            ("lake".to_owned(), self.lake.json()),
            ("indexer".to_owned(), self.indexer.json()),
            ("residuals".to_owned(), residuals_json.clone()),
            ("subAccountBooks".to_owned(), Json::str(books)),
            ("subAccounts".to_owned(), accounts_json.clone()),
        ];
        let note = if empty {
            "empty book — not a $0 PnL"
        } else {
            "cost basis not on the ledger history wire; missing basis is unknown, not a FIFO/LIFO/HIFO invent or 0"
        };
        let body = Json::obj([
            ("schema", Json::str("intafaced.tax.export.v1")),
            ("empty", Json::Bool(empty)),
            ("complete", Json::Bool(false)),
            ("lotMethod", Json::str(lot_method)),
            ("jurisdiction", Json::str(code.clone())),
            ("lotsClosed", Json::Array(lots.lots_closed)),
            ("lotsOpen", Json::Array(lots.lots_open)),
            ("realized", realized),
            ("unrealized", unrealized),
            ("lake", self.lake.json()),
            ("indexer", self.indexer.json()),
            ("residuals", residuals_json),
            ("subAccountBooks", Json::str(books)),
            ("subAccounts", accounts_json),
            ("note", Json::str(note)),
            (
                "currentAvailable",
                Json::Array(
                    available
                        .iter()
                        .map(|b| {
                            Json::obj([
                                ("assetId", Json::str(b.account.asset_id.clone())),
                                ("amount", Json::str(format_amount(b.amount))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]);
        let day = now.iso().get(0..10).unwrap_or_default().to_owned();
        Ok(Export {
            preview,
            body: format!("{}\n", body.pretty()),
            filename: format!("intafaced-tax-{code}-{lot_method}-{day}.json"),
        })
    }

    fn sub_account_books(
        &self,
        user_id: &str,
        range: Range,
    ) -> Result<(&'static str, Vec<SubAccountYear>), Failure> {
        let Some(ids) = self.ledger.sub_account_ids(user_id) else {
            return Ok(("unwired", Vec::new()));
        };
        let mut accounts = Vec::new();
        for id in ids? {
            let Some(lines) = self.ledger.sub_account_activity(&id, range) else {
                return Ok(("unwired", Vec::new()));
            };
            accounts.push(sub_account_year(id, lines?, range)?);
        }
        Ok(("read", accounts))
    }
}

/// `String#localeCompare` for the ids svc-tax sorts by (printable ASCII), as ICU's root collation orders them: each
/// character by its primary weight (white space, then punctuation and symbols in ICU's own order, then digits, then
/// letters without case), and on a tie lower case before upper case.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    // Printable ASCII in root collation order, as `[...].sort((a, b) => a.localeCompare(b))` gives it (Node's ICU).
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
    fn primary(c: char) -> (usize, char) {
        let folded = c.to_ascii_lowercase();
        match ORDER.find(folded) {
            Some(at) => (at, '\0'),
            // Outside printable ASCII: after every ASCII character, by code point.
            None => (ORDER.len(), c),
        }
    }
    let primary_order = a.chars().map(primary).cmp(b.chars().map(primary));
    primary_order.then_with(|| {
        a.chars()
            .map(|c| !c.is_ascii_lowercase())
            .cmp(b.chars().map(|c| !c.is_ascii_lowercase()))
    })
}

struct SubAccountYear {
    id: String,
    lines: Vec<Json>,
    realized: Option<Amount>,
    residuals: Vec<&'static str>,
}

impl SubAccountYear {
    fn json(&self) -> Json {
        Json::obj([
            ("subAccountId", Json::str(self.id.clone())),
            ("lines", Json::Array(self.lines.clone())),
            (
                "realized",
                self.realized
                    .map_or(Json::Null, |r| Json::str(format_amount(r))),
            ),
            (
                "residuals",
                Json::Array(self.residuals.iter().map(|r| Json::str(*r)).collect()),
            ),
        ])
    }
}

fn money(v: Option<Amount>) -> Json {
    v.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

fn overflow() -> Failure {
    Failure::Internal("an amount is beyond 128 bits".to_owned())
}

/// `subAccountYear`: one sub-account's lines inside the window, oldest first; its realised result only when every line
/// has a basis, and the basis read from that line alone.
fn sub_account_year(
    id: String,
    activity: Vec<SubAccountLine>,
    range: Range,
) -> Result<SubAccountYear, Failure> {
    let mut kept: Vec<SubAccountLine> = activity
        .into_iter()
        .filter(|l| l.posted_at >= range.from && l.posted_at <= range.to)
        .collect();
    kept.sort_by(|a, b| {
        a.posted_at
            .cmp(&b.posted_at)
            .then_with(|| locale_compare(&a.id, &b.id))
    });
    let missing = kept.iter().any(|l| l.cost_basis.is_none());
    let mut sum: Amount = 0;
    let mut any = false;
    let mut lines = Vec::new();
    for l in &kept {
        let realized = match (l.cost_basis, l.proceeds) {
            (Some(c), Some(p)) => Some(p.checked_sub(c).ok_or_else(overflow)?),
            _ => None,
        };
        if !missing && let Some(r) = realized {
            sum = sum.checked_add(r).ok_or_else(overflow)?;
            any = true;
        }
        lines.push(Json::obj([
            (
                "kind",
                Json::str(if l.convert { "convert" } else { "fill" }),
            ),
            ("postedAt", Json::str(l.posted_at.iso())),
            ("assetId", Json::str(l.asset_id.clone())),
            ("qty", Json::str(format_amount(l.qty))),
            ("fee", money(l.fee)),
            ("makerRebate", money(l.maker_rebate)),
            ("costBasis", money(l.cost_basis)),
            ("proceeds", money(l.proceeds)),
            ("realized", money(realized)),
        ]));
    }
    Ok(SubAccountYear {
        id,
        lines,
        realized: (!missing && any).then_some(sum),
        residuals: if missing {
            vec![TAX_COST_BASIS_UNAVAILABLE]
        } else {
            Vec::new()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_as_buffer_does() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("é\n".as_bytes()), "w6kK");
    }

    #[test]
    fn formats_amounts_as_the_ledger_client_does() {
        assert_eq!(format_amount(0), "0");
        assert_eq!(format_amount(1_500_000_000_000_000_000), "1.5");
        assert_eq!(format_amount(-1), "-0.000000000000000001");
        assert_eq!(format_amount(-2 * SCALE), "-2");
    }

    #[test]
    fn orders_ids_as_locale_compare_does() {
        use std::cmp::Ordering::Less;
        assert_eq!(locale_compare("a", "B"), Less);
        assert_eq!(locale_compare("a", "A"), Less);
        assert_eq!(locale_compare("_", "0"), Less);
        assert_eq!(locale_compare("9", "a"), Less);
        assert_eq!(locale_compare("tx-1", "tx-10"), Less);
    }
}
