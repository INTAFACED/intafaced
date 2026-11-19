//! svc-tax's own logic (`services/svc-tax/src/tax-service.ts`, `lots.ts`, `jurisdiction-map.ts`): the year export over
//! the caller's ledger reads, and each call's named refusals.
//!
//! What this service holds today: the export (preview and pack) in full. Not yet: the ledger fill reader the lot book
//! is built from, and the Postgres stores for a customer's basis and cost-basis choices. Without them the TypeScript
//! service refuses those calls by name (`tax.ledger_unwired`, `tax.basis_store_unwired`), and so does this one; each
//! moves here with its reader or store.

use crate::inputs::{BasisSetInput, DayMethodInput, LotMethodInput, PickInput, PnlInput};
use crate::json::Json;
use crate::time::Instant;

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
pub struct Balance {
    pub account: Account,
    pub amount: Amount,
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

/// What svc-tax reads from the ledger (`TaxLedgerReads`): balances and history, and the caller's sub-accounts when that
/// reader is attached.
pub trait LedgerReads {
    fn balances(&self, user_id: &str) -> Result<Vec<Balance>, Failure>;
    fn history(&self, account: &Account, range: Range) -> Result<Vec<HistoryEntry>, Failure>;
    /// `subAccountIds` and `subAccountActivity`, attached together or not at all: `None` leaves the year unwired.
    fn sub_accounts(&self) -> Option<&dyn SubAccountReads> {
        None
    }
}

/// The two sub-account reads, which exist only as a pair.
pub trait SubAccountReads {
    /// The caller's sub-account ids, in parent order.
    fn ids(&self, user_id: &str) -> Result<Vec<String>, Failure>;
    /// One sub-account's lines in the window.
    fn activity(&self, id: &str, range: Range) -> Result<Vec<SubAccountLine>, Failure>;
}

/// `parseJurisdictionMap`: the counsel map, a JSON array or object of ISO alpha-2 codes. Blank, `[]` and `{}` map nothing.
fn parse_map(raw: &str) -> Result<Vec<String>, TaxError> {
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

/// How the service is put together: everything it reads, handed in once.
pub struct TaxDeps {
    /// `TAX_JURISDICTION_MAP_JSON`.
    pub map_raw: String,
    pub reads: Box<dyn LedgerReads + Send + Sync>,
    pub lake: LakeStatus,
    pub indexer: LakeStatus,
    /// `TAX_HISTORY_YEARS`: the owner's export window, 1 to 100. Unset refuses; never 10 by default.
    pub history_years: Option<i64>,
    pub now: Box<dyn Fn() -> Instant + Send + Sync>,
}

pub struct TaxService {
    regions: Vec<String>,
    reads: Box<dyn LedgerReads + Send + Sync>,
    lake: LakeStatus,
    indexer: LakeStatus,
    history_years: Option<i64>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
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

impl TaxService {
    /// A map that is not valid refuses here, at start-up, as the TypeScript constructor throws.
    pub fn new(deps: TaxDeps) -> Result<TaxService, TaxError> {
        Ok(TaxService {
            regions: parse_map(&deps.map_raw)?,
            reads: deps.reads,
            lake: deps.lake,
            indexer: deps.indexer,
            history_years: deps.history_years,
            now: deps.now,
        })
    }

    pub fn now(&self) -> Instant {
        (self.now)()
    }

    /// `tax.lotBook` and `tax.missingBasis`: the book is built from the ledger's trade fills, whose reader is not here yet.
    pub fn lot_book(&self, _user_id: &str, _method: Option<&str>) -> Result<Json, Failure> {
        refuse(TAX_LEDGER_UNWIRED, FILLS_UNWIRED)
    }

    /// `tax.pnlOverTime`: the range is checked first, then the book is read.
    pub fn pnl_over_time(&self, _user_id: &str, input: &PnlInput) -> Result<Json, Failure> {
        let now = self.now();
        let asked = input.to.unwrap_or(now);
        let to = if asked > now { now } else { asked };
        if input.from >= to {
            return refuse(
                TAX_PNL_RANGE_INVALID,
                "the range must start before it ends, and before now",
            );
        }
        if choose_interval(input.from, to, now).is_none() {
            return refuse(
                TAX_PNL_RANGE_TOO_LONG,
                "the range starts too long ago to be priced: pick a later start",
            );
        }
        let _ = input.utc_offset_minutes;
        refuse(TAX_LEDGER_UNWIRED, FILLS_UNWIRED)
    }

    /// `tax.basisOverride.set`: no store, so nothing is written.
    pub fn basis_override_set(
        &self,
        _user_id: &str,
        _input: &BasisSetInput,
    ) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, BASIS_UNWIRED)
    }

    /// `tax.basisOverride.remove`.
    pub fn basis_override_remove(&self, _user_id: &str, _lot_id: &str) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, BASIS_UNWIRED)
    }

    /// `tax.setLotMethod`.
    pub fn set_lot_method(&self, _user_id: &str, _input: &LotMethodInput) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, CHOICE_UNWIRED)
    }

    /// `tax.setDayMethod`.
    pub fn set_day_method(&self, _user_id: &str, _input: &DayMethodInput) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, CHOICE_UNWIRED)
    }

    /// `tax.pickSaleLot`.
    pub fn pick_sale_lot(&self, _user_id: &str, _input: &PickInput) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, CHOICE_UNWIRED)
    }

    /// `tax.setIncludeTransfers`.
    pub fn set_include_transfers(
        &self,
        _user_id: &str,
        _include: Option<bool>,
    ) -> Result<Json, Failure> {
        refuse(TAX_BASIS_STORE_UNWIRED, CHOICE_UNWIRED)
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
        if !crate::inputs::EXPORT_LOT_METHODS.contains(&lot_method) {
            return refuse(
                TAX_LOT_METHOD_REQUIRED,
                "Caller must select FIFO, LIFO, or HIFO — no silent default",
            );
        }
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

        let available: Vec<Balance> = self
            .reads
            .balances(user_id)?
            .into_iter()
            .filter(|b| b.account.kind == "available")
            .collect();
        let mut residuals: Vec<&'static str> =
            vec![TAX_CLOSED_LOTS_UNINDEXED, TAX_EXPORT_INCOMPLETE];
        let mut movements: Vec<Movement> = Vec::new();
        for row in &available {
            for e in self.reads.history(&row.account, range)? {
                movements.push(Movement {
                    asset_id: row.account.asset_id.clone(),
                    acquire: e.debit,
                    qty: e.amount,
                    posted_at: e.posted_at,
                    tx_id: e.tx_id,
                });
            }
        }
        if !movements.is_empty() {
            residuals.push(TAX_COST_BASIS_UNAVAILABLE);
        }
        // No basis store here, so no customer basis is active and none is left out of the export.
        let lots = run_lots_without_basis(movements);
        residuals.extend(lots.residuals.iter().copied());
        let (books, accounts) = self.sub_account_books(user_id, range)?;
        for account in &accounts {
            residuals.extend(account.residuals.iter().copied());
        }
        residuals.sort_unstable();
        residuals.dedup();

        let empty = lots.open.is_empty() && accounts.iter().all(|a| a.lines.is_empty());
        let residuals_json = Json::Array(residuals.iter().map(|r| Json::str(*r)).collect());
        let accounts_json = Json::Array(accounts.iter().map(SubAccountYear::json).collect());
        // Every lot here is open: with no basis on the history wire nothing is matched, so the realised figure is unknown.
        let lot_count =
            i64::try_from(lots.open.len()).map_err(|e| Failure::Internal(e.to_string()))?;
        let preview = vec![
            ("empty".to_owned(), Json::Bool(empty)),
            ("complete".to_owned(), Json::Bool(false)),
            ("lotMethod".to_owned(), Json::str(lot_method)),
            ("jurisdiction".to_owned(), Json::str(code.clone())),
            ("lotCount".to_owned(), Json::int(lot_count)),
            ("realized".to_owned(), Json::Null),
            ("unrealized".to_owned(), Json::Null),
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
            ("lotsClosed", Json::Array(Vec::new())),
            ("lotsOpen", Json::Array(lots.open)),
            ("realized", Json::Null),
            ("unrealized", Json::Null),
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
        let Some(reads) = self.reads.sub_accounts() else {
            return Ok(("unwired", Vec::new()));
        };
        let mut accounts = Vec::new();
        for id in reads.ids(user_id)? {
            let lines = reads.activity(&id, range)?;
            accounts.push(sub_account_year(id, lines, range)?);
        }
        Ok(("read", accounts))
    }
}

/// `chooseInterval`: the finest candle whose points fit a chart (400) and whose window to now fits one read (718).
fn choose_interval(from: Instant, to: Instant, now: Instant) -> Option<&'static str> {
    const INTERVALS: [(&str, i64); 5] = [
        ("5m", 300_000),
        ("1h", 3_600_000),
        ("4h", 14_400_000),
        ("1d", 86_400_000),
        ("1w", 604_800_000),
    ];
    let span = i128::from(to.0) - i128::from(from.0);
    let back = i128::from(now.0) - i128::from(from.0);
    INTERVALS
        .iter()
        .find(|(_, ms)| span <= 400 * i128::from(*ms) && back <= 718 * i128::from(*ms))
        .map(|(name, _)| *name)
}

struct Movement {
    asset_id: String,
    acquire: bool,
    qty: Amount,
    posted_at: Instant,
    tx_id: String,
}

struct LotRun {
    open: Vec<Json>,
    residuals: Vec<&'static str>,
}

/// `String#localeCompare` for the ids svc-tax sorts by (ASCII), as ICU's root collation orders them: letters compared
/// without case first, punctuation before digits before letters, and on a tie lower case before upper case.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    fn primary(c: char) -> (u8, char) {
        if c.is_ascii_alphabetic() {
            (2, c.to_ascii_lowercase())
        } else if c.is_ascii_digit() {
            (1, c)
        } else {
            (0, c)
        }
    }
    let primary_order = a.chars().map(primary).cmp(b.chars().map(primary));
    primary_order.then_with(|| {
        a.chars()
            .map(|c| !c.is_ascii_lowercase())
            .cmp(b.chars().map(|c| !c.is_ascii_lowercase()))
    })
}

/// `runLots` for the movements the export builds, whose cost basis is always unknown (the ledger history carries none):
/// nothing is matched, every acquisition stays an open lot, a sale names the unknown basis, and a sale with no lot left
/// to draw on is an underflow.
fn run_lots_without_basis(movements: Vec<Movement>) -> LotRun {
    let mut by_asset: Vec<(String, Vec<Movement>)> = Vec::new();
    for m in movements.into_iter().filter(|m| m.qty != 0) {
        match by_asset.iter_mut().find(|(a, _)| *a == m.asset_id) {
            Some((_, list)) => list.push(m),
            None => by_asset.push((m.asset_id.clone(), vec![m])),
        }
    }
    let mut open_out = Vec::new();
    let mut residuals = Vec::new();
    for (_, mut list) in by_asset {
        list.sort_by(|a, b| {
            a.posted_at
                .cmp(&b.posted_at)
                .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
        });
        let mut open: Vec<&Movement> = Vec::new();
        for m in &list {
            if m.acquire {
                open.push(m);
            } else if m.qty > 0 {
                residuals.push(if open.is_empty() {
                    TAX_LOT_UNDERFLOW
                } else {
                    TAX_COST_BASIS_UNAVAILABLE
                });
            }
        }
        for lot in open {
            residuals.push(TAX_COST_BASIS_UNAVAILABLE);
            open_out.push(Json::obj([
                ("assetId", Json::str(lot.asset_id.clone())),
                ("qtyRemaining", Json::str(format_amount(lot.qty))),
                ("acquiredAt", Json::str(lot.posted_at.iso())),
                ("acquireTxId", Json::str(lot.tx_id.clone())),
                ("costBasis", Json::Null),
            ]));
        }
    }
    residuals.sort_unstable();
    residuals.dedup();
    LotRun {
        open: open_out,
        residuals,
    }
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

    #[test]
    fn leaves_every_lot_open_and_names_why_when_no_basis_is_known() {
        let at = |ms| Instant(ms);
        let mv = |asset: &str, acquire, qty, ms, tx: &str| Movement {
            asset_id: asset.to_owned(),
            acquire,
            qty,
            posted_at: at(ms),
            tx_id: tx.to_owned(),
        };
        let run = run_lots_without_basis(vec![
            mv("BTC", false, 1, 0, "s0"),
            mv("BTC", true, 2 * SCALE, 2, "b"),
            mv("BTC", true, SCALE, 2, "a"),
            mv("ETH", true, 0, 1, "zero"),
            mv("BTC", false, SCALE, 3, "s1"),
        ]);
        assert_eq!(
            run.residuals,
            vec![TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW]
        );
        let ids: Vec<String> = run
            .open
            .iter()
            .map(|l| l.get("acquireTxId").map(Json::compact).unwrap_or_default())
            .collect();
        assert_eq!(ids, vec!["\"a\"", "\"b\""]);
    }
}
