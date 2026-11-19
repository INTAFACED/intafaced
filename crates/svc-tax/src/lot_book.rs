//! The lot book (`lot-book.ts`): profit and loss as an indicator, built only from the customer's own
//! fills, arrivals, moves and withdrawals. Not a tax form and not tied to a jurisdiction. A figure that cannot be known is
//! null with its reason named, never zero. Its answer is written in `lotBookSchema`'s key order, which is the order the
//! TypeScript router sends it in (tRPC parses the output through that schema).

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::json::Json;
use crate::lot_engine::{
    CarriedFrom, CarriedIn, LotSource, MethodSource, Movement, SaleRules, Side, ValuedAt,
    run_lot_engine,
};
use crate::own_moves::OwnMove;
use crate::ports::{DayChoice, EngineMethod, Fill, LotPick, OwnSpace};
use crate::tax::{
    Amount, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED,
    format_amount,
};
use crate::time::Instant;

pub const TAX_TERM_RULE_UNSET: &str = "tax.term_rule_unset";
pub const INDICATOR_LABEL: &str = "indicator_not_tax_advice";
/// `DEFAULT_LOT_BOOK_METHOD`.
pub const DEFAULT_LOT_BOOK_METHOD: EngineMethod = EngineMethod::Fifo;

/// `PAR_ASSETS`: counted as exactly 1 USD.
pub fn is_par(asset_id: &str) -> bool {
    matches!(asset_id.to_uppercase().as_str(), "USDT" | "USDC" | "USD")
}

const DAY_MS: i64 = 86_400_000;

/// `Withdrawal`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub amount: Amount,
    pub value_usd: Option<Amount>,
}

/// `Inflow`: a coin that reached the customer other than by a fill, already valued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inflow {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub amount: Amount,
    pub reason: String,
    pub source: LotSource,
    pub cost_usd: Option<Amount>,
    pub valued_at: Option<ValuedAt>,
    pub space_id: Option<String>,
}

/// `CarriedLot`: a lot carried in from a book built apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CarriedLot {
    pub lot_id: String,
    pub asset_id: String,
    pub acquired_at: Instant,
    pub source: LotSource,
    pub reason: String,
    pub qty: Amount,
    pub cost_usd: Option<Amount>,
    pub valued_at: Option<ValuedAt>,
    pub tx_id: String,
    pub moved_at: Instant,
    pub from: Option<CarriedFrom>,
    pub customer_entered: bool,
    pub price_lot_id: Option<String>,
}

/// `BookFee`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookFee {
    Known {
        asset_id: String,
        amount: Amount,
        usd: Option<Amount>,
    },
    Unknown,
}

impl BookFee {
    pub fn json(&self) -> Json {
        match self {
            BookFee::Known {
                asset_id,
                amount,
                usd,
            } => Json::obj([
                ("status", Json::str("known")),
                ("assetId", Json::str(asset_id.clone())),
                ("amount", Json::str(format_amount(*amount))),
                ("usd", money(*usd)),
            ]),
            BookFee::Unknown => Json::obj([("status", Json::str("unknown"))]),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookAsset {
    pub asset_id: String,
    pub open_qty: Amount,
    pub open_cost_usd: Option<Amount>,
    pub held: Amount,
    pub uncounted_qty: Amount,
    pub venue_account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookLot {
    pub id: String,
    pub asset_id: String,
    pub acquired_at: Instant,
    pub source: LotSource,
    pub qty: Amount,
    pub remaining: Amount,
    pub cost_usd: Option<Amount>,
    pub remaining_cost_usd: Option<Amount>,
    pub valued_at: Option<ValuedAt>,
    pub days_held: Option<i64>,
    /// `basisSource: 'customer-entered'`.
    pub customer_entered: bool,
    pub space_id: Option<String>,
    pub basis_lot_id: Option<String>,
    pub carried_from: Option<CarriedFrom>,
    pub counted: bool,
    pub fee: Option<BookFee>,
    pub venue_account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookMatch {
    pub lot_id: String,
    pub qty: Amount,
    pub cost_usd: Option<Amount>,
    pub proceeds_usd: Option<Amount>,
    pub realized_usd: Option<Amount>,
    pub customer_entered: bool,
    pub counted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counted {
    All,
    Part,
    None,
}

impl Counted {
    fn name(self) -> &'static str {
        match self {
            Counted::All => "all",
            Counted::Part => "part",
            Counted::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookSale {
    pub moved_out: bool,
    pub counted: Counted,
    pub fee: Option<BookFee>,
    pub market: Option<String>,
    pub method: EngineMethod,
    pub method_source: MethodSource,
    pub picked_lot_id: Option<String>,
    pub asset_id: String,
    pub tx_id: String,
    pub disposed_at: Instant,
    pub qty: Amount,
    pub unmatched_qty: Amount,
    pub proceeds_usd: Option<Amount>,
    pub cost_usd: Option<Amount>,
    pub realized_usd: Option<Amount>,
    pub matches: Vec<BookMatch>,
    pub customer_entered: bool,
    pub venue_account: Option<String>,
}

/// `BookChoices`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookChoices {
    Saved {
        account_method: Option<EngineMethod>,
        asset_methods: Vec<(String, EngineMethod)>,
        days: Vec<DayChoice>,
        picks: Vec<LotPick>,
        include_transfers: Option<bool>,
    },
    Unwired,
    Unavailable,
}

/// `BookSpaces`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookSpaces {
    Read(Vec<OwnSpace>),
    Unwired,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueAccountRef {
    pub account: String,
    pub venue_id: String,
    pub owner: String,
    pub sub_account: Option<String>,
    pub as_of: String,
}

/// `LotBookVenue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookVenue {
    Read {
        test: bool,
        accounts: Vec<VenueAccountRef>,
    },
    Unwired,
    Off,
    Unavailable,
}

/// `ManualPosition`: a customer-typed position held apart from balances.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualPosition {
    pub id: String,
    pub asset_id: String,
    pub acquired_at: String,
    pub qty: String,
    pub cost_usd: String,
    pub price_per_unit: String,
    pub source_note: String,
}

/// `LotBook`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotBook {
    pub method: EngineMethod,
    pub preview: bool,
    pub choices: BookChoices,
    pub assets: Vec<BookAsset>,
    pub sales: Vec<BookSale>,
    pub lots: Vec<BookLot>,
    pub realized_usd: Option<Amount>,
    pub include_transfers: bool,
    pub fees_usd: Option<Amount>,
    pub residuals: Vec<&'static str>,
    pub outside_assets: Option<Vec<String>>,
    pub manual_positions: Option<Vec<ManualPosition>>,
    pub spaces: Option<BookSpaces>,
    pub venue: Option<BookVenue>,
}

pub fn money(v: Option<Amount>) -> Json {
    v.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

fn opt_str(v: Option<&String>) -> Json {
    v.map_or(Json::Null, |s| Json::str(s.clone()))
}

/// Builds an object, leaving out each `None` field (an absent optional key).
fn object(fields: Vec<(&str, Option<Json>)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v)))
            .collect(),
    )
}

pub fn valued_at_json(v: &ValuedAt) -> Json {
    Json::obj([
        ("usd", Json::str(format_amount(v.usd))),
        ("price", Json::str(format_amount(v.price))),
        ("market", Json::str(v.market.clone())),
        ("timeframe", opt_str(v.timeframe.as_ref())),
        (
            "candleAt",
            v.candle_at.map_or(Json::Null, |c| Json::str(c.iso())),
        ),
    ])
}

impl BookChoices {
    pub fn json(&self) -> Json {
        match self {
            BookChoices::Saved {
                account_method,
                asset_methods,
                days,
                picks,
                include_transfers,
            } => Json::obj([
                ("status", Json::str("saved")),
                (
                    "accountMethod",
                    account_method.map_or(Json::Null, |m| Json::str(m.name())),
                ),
                (
                    "assetMethods",
                    Json::Array(
                        asset_methods
                            .iter()
                            .map(|(a, m)| {
                                Json::obj([
                                    ("assetId", Json::str(a.clone())),
                                    ("method", Json::str(m.name())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "days",
                    Json::Array(
                        days.iter()
                            .map(|d| {
                                Json::obj([
                                    ("day", Json::str(d.day.clone())),
                                    ("assetId", opt_str(d.asset_id.as_ref())),
                                    ("method", Json::str(d.method.name())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "picks",
                    Json::Array(
                        picks
                            .iter()
                            .map(|p| {
                                Json::obj([
                                    ("saleTxId", Json::str(p.sale_tx_id.clone())),
                                    ("assetId", Json::str(p.asset_id.clone())),
                                    ("lotId", Json::str(p.lot_id.clone())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "includeTransfers",
                    include_transfers.map_or(Json::Null, Json::Bool),
                ),
            ]),
            BookChoices::Unwired => Json::obj([
                ("status", Json::str("unwired")),
                ("code", Json::str("tax.basis_store_unwired")),
            ]),
            BookChoices::Unavailable => Json::obj([
                ("status", Json::str("unavailable")),
                ("code", Json::str("tax.choices_unavailable")),
            ]),
        }
    }
}

impl BookSpaces {
    pub fn json(&self) -> Json {
        match self {
            BookSpaces::Read(list) => Json::obj([
                ("status", Json::str("read")),
                (
                    "list",
                    Json::Array(
                        list.iter()
                            .map(|s| {
                                Json::obj([
                                    ("spaceId", Json::str(s.space_id.clone())),
                                    ("assetId", Json::str(s.asset_id.clone())),
                                    ("name", Json::str(s.name.clone())),
                                    ("archived", Json::Bool(s.archived)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]),
            BookSpaces::Unwired => Json::obj([
                ("status", Json::str("unwired")),
                ("code", Json::str("tax.own_spaces_unwired")),
            ]),
            BookSpaces::Unavailable => Json::obj([
                ("status", Json::str("unavailable")),
                ("code", Json::str("tax.own_spaces_unavailable")),
            ]),
        }
    }
}

impl BookVenue {
    pub fn json(&self) -> Json {
        match self {
            BookVenue::Read { test, accounts } => Json::obj([
                ("status", Json::str("read")),
                ("test", Json::Bool(*test)),
                (
                    "accounts",
                    Json::Array(
                        accounts
                            .iter()
                            .map(|a| {
                                Json::obj([
                                    ("account", Json::str(a.account.clone())),
                                    ("venueId", Json::str(a.venue_id.clone())),
                                    ("owner", Json::str(a.owner.clone())),
                                    ("subAccount", opt_str(a.sub_account.as_ref())),
                                    ("asOf", Json::str(a.as_of.clone())),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]),
            BookVenue::Unwired => Json::obj([
                ("status", Json::str("unwired")),
                ("code", Json::str("tax.venue_unwired")),
            ]),
            BookVenue::Off => Json::obj([
                ("status", Json::str("off")),
                ("code", Json::str("tax.venue_off")),
            ]),
            BookVenue::Unavailable => Json::obj([
                ("status", Json::str("unavailable")),
                ("code", Json::str("tax.venue_unavailable")),
            ]),
        }
    }
}

impl BookLot {
    pub fn json(&self) -> Json {
        let customer = self.customer_entered.then(|| Json::str("customer-entered"));
        object(vec![
            ("id", Some(Json::str(self.id.clone()))),
            ("assetId", Some(Json::str(self.asset_id.clone()))),
            ("acquiredAt", Some(Json::str(self.acquired_at.iso()))),
            ("source", Some(Json::str(self.source.name()))),
            ("qty", Some(Json::str(format_amount(self.qty)))),
            ("remaining", Some(Json::str(format_amount(self.remaining)))),
            ("costUsd", Some(money(self.cost_usd))),
            ("remainingCostUsd", Some(money(self.remaining_cost_usd))),
            (
                "valuedAt",
                Some(self.valued_at.as_ref().map_or(Json::Null, valued_at_json)),
            ),
            (
                "daysHeld",
                Some(self.days_held.map_or(Json::Null, Json::int)),
            ),
            ("termClass", Some(Json::Null)),
            ("basisSource", customer),
            (
                "spaceId",
                self.space_id.as_ref().map(|s| Json::str(s.clone())),
            ),
            (
                "basisLotId",
                self.basis_lot_id.as_ref().map(|s| Json::str(s.clone())),
            ),
            (
                "carriedFrom",
                self.carried_from.as_ref().map(|c| {
                    Json::obj([
                        ("lotId", Json::str(c.lot_id.clone())),
                        ("txId", Json::str(c.tx_id.clone())),
                        ("movedAt", Json::str(c.moved_at.iso())),
                    ])
                }),
            ),
            ("counted", Some(Json::Bool(self.counted))),
            ("fee", self.fee.as_ref().map(BookFee::json)),
            (
                "venueAccount",
                self.venue_account.as_ref().map(|s| Json::str(s.clone())),
            ),
        ])
    }
}

impl BookSale {
    pub fn json(&self) -> Json {
        let matches = self
            .matches
            .iter()
            .map(|m| {
                object(vec![
                    ("lotId", Some(Json::str(m.lot_id.clone()))),
                    ("qty", Some(Json::str(format_amount(m.qty)))),
                    ("costUsd", Some(money(m.cost_usd))),
                    ("proceedsUsd", Some(money(m.proceeds_usd))),
                    ("realizedUsd", Some(money(m.realized_usd))),
                    (
                        "basisSource",
                        m.customer_entered.then(|| Json::str("customer-entered")),
                    ),
                    ("counted", Some(Json::Bool(m.counted))),
                ])
            })
            .collect();
        object(vec![
            (
                "kind",
                Some(Json::str(if self.moved_out { "moved_out" } else { "sale" })),
            ),
            ("counted", Some(Json::str(self.counted.name()))),
            ("fee", self.fee.as_ref().map(BookFee::json)),
            ("market", self.market.as_ref().map(|s| Json::str(s.clone()))),
            ("method", Some(Json::str(self.method.name()))),
            ("methodSource", Some(Json::str(self.method_source.name()))),
            ("pickedLotId", Some(opt_str(self.picked_lot_id.as_ref()))),
            ("assetId", Some(Json::str(self.asset_id.clone()))),
            ("txId", Some(Json::str(self.tx_id.clone()))),
            ("disposedAt", Some(Json::str(self.disposed_at.iso()))),
            ("qty", Some(Json::str(format_amount(self.qty)))),
            (
                "unmatchedQty",
                Some(Json::str(format_amount(self.unmatched_qty))),
            ),
            ("proceedsUsd", Some(money(self.proceeds_usd))),
            ("costUsd", Some(money(self.cost_usd))),
            ("realizedUsd", Some(money(self.realized_usd))),
            ("matches", Some(Json::Array(matches))),
            (
                "basisSource",
                self.customer_entered.then(|| Json::str("customer-entered")),
            ),
            (
                "venueAccount",
                self.venue_account.as_ref().map(|s| Json::str(s.clone())),
            ),
        ])
    }
}

impl BookAsset {
    pub fn json(&self) -> Json {
        object(vec![
            ("assetId", Some(Json::str(self.asset_id.clone()))),
            ("openQty", Some(Json::str(format_amount(self.open_qty)))),
            ("openCostUsd", Some(money(self.open_cost_usd))),
            ("held", Some(Json::str(format_amount(self.held)))),
            (
                "uncountedQty",
                Some(Json::str(format_amount(self.uncounted_qty))),
            ),
            (
                "venueAccount",
                self.venue_account.as_ref().map(|s| Json::str(s.clone())),
            ),
        ])
    }
}

impl ManualPosition {
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("acquiredAt", Json::str(self.acquired_at.clone())),
            ("qty", Json::str(self.qty.clone())),
            ("costUsd", Json::str(self.cost_usd.clone())),
            ("pricePerUnit", Json::str(self.price_per_unit.clone())),
            ("sourceNote", Json::str(self.source_note.clone())),
            ("basisSource", Json::str("customer-entered")),
            ("heldApart", Json::Bool(true)),
        ])
    }
}

impl LotBook {
    /// The answer as the router sends it (`lotBookSchema`'s order).
    pub fn json(&self) -> Json {
        let strings = |v: &[String]| Json::Array(v.iter().map(|s| Json::str(s.clone())).collect());
        object(vec![
            ("method", Some(Json::str(self.method.name()))),
            ("preview", Some(Json::Bool(self.preview))),
            ("choices", Some(self.choices.json())),
            ("indicator", Some(Json::str(INDICATOR_LABEL))),
            (
                "assets",
                Some(Json::Array(
                    self.assets.iter().map(BookAsset::json).collect(),
                )),
            ),
            (
                "sales",
                Some(Json::Array(self.sales.iter().map(BookSale::json).collect())),
            ),
            (
                "lots",
                Some(Json::Array(self.lots.iter().map(BookLot::json).collect())),
            ),
            ("realizedUsd", Some(money(self.realized_usd))),
            ("includeTransfers", Some(Json::Bool(self.include_transfers))),
            ("feesUsd", Some(money(self.fees_usd))),
            (
                "termRule",
                Some(Json::obj([
                    ("status", Json::str("unset")),
                    ("code", Json::str(TAX_TERM_RULE_UNSET)),
                ])),
            ),
            (
                "residuals",
                Some(Json::Array(
                    self.residuals.iter().map(|r| Json::str(*r)).collect(),
                )),
            ),
            ("outsideAssets", self.outside_assets.as_deref().map(strings)),
            ("spaces", self.spaces.as_ref().map(BookSpaces::json)),
            ("venue", self.venue.as_ref().map(BookVenue::json)),
            (
                "manualPositions",
                self.manual_positions
                    .as_ref()
                    .map(|m| Json::Array(m.iter().map(ManualPosition::json).collect())),
            ),
        ])
    }
}

/// What one named space holds now: its id, and each coin's quantity.
pub type SpaceHeld = (String, Vec<(String, Amount)>);

/// What `buildLotBook` takes. `Default` is the TypeScript's absent fields.
pub struct BookInput<'a> {
    pub fills: &'a [Fill],
    pub held: &'a HashMap<String, Amount>,
    pub method: EngineMethod,
    pub rules: Option<&'a SaleRules<'a>>,
    pub preview: bool,
    pub choices: Option<BookChoices>,
    pub truncated: bool,
    pub outside_inflows: &'a [String],
    pub inflows: &'a [Inflow],
    pub now: Instant,
    pub override_price_per_unit: Option<&'a HashMap<String, Amount>>,
    pub moves: &'a [OwnMove],
    pub carried_in: &'a [CarriedLot],
    pub spaces: Option<BookSpaces>,
    /// What each named space holds now, by coin, in the order the spaces were read.
    pub space_held: Option<&'a [SpaceHeld]>,
    pub withdrawals: &'a [Withdrawal],
    pub include_transfers: bool,
}

fn movements_of(fills: &[Fill], residuals: &mut BTreeSet<&'static str>) -> Vec<Movement> {
    let mut out = Vec::new();
    for fill in fills {
        let received = &fill.received;
        let received_par = is_par(&received.asset_id);
        let acquire = |cost_usd: Option<Amount>| Movement {
            tx_id: fill.tx_id.clone(),
            posted_at: fill.posted_at,
            asset_id: received.asset_id.clone(),
            qty: received.amount,
            side: Side::Acquire {
                cost_usd,
                source: LotSource::Trade,
                reason: "trade.fill".to_owned(),
                valued_at: None,
                space: None,
                carried: None,
            },
        };
        let Some(paid) = &fill.paid else {
            residuals.insert(TAX_LOT_BOOK_INCOMPLETE);
            if !received_par {
                out.push(acquire(None));
            }
            continue;
        };
        let paid_par = is_par(&paid.asset_id);
        if received_par && paid_par {
            continue;
        }
        if !received_par {
            out.push(acquire(paid_par.then_some(paid.amount)));
        }
        if !paid_par {
            out.push(Movement {
                tx_id: fill.tx_id.clone(),
                posted_at: fill.posted_at,
                asset_id: paid.asset_id.clone(),
                qty: paid.amount,
                side: Side::Dispose {
                    proceeds_usd: received_par.then_some(received.amount),
                    moved_out: false,
                },
            });
        }
    }
    out
}

/// `feeOf`: the fee a fill took and its dollar value at the fill's own price.
fn fee_of(fill: &Fill) -> (BookFee, Option<Amount>) {
    let Some(fee) = fill.fee else {
        return (BookFee::Unknown, None);
    };
    let received = &fill.received;
    if let Some(fee_asset) = fill
        .fee_asset_id
        .as_ref()
        .filter(|a| **a != received.asset_id)
    {
        let usd = is_par(fee_asset).then_some(fee);
        return (
            BookFee::Known {
                asset_id: fee_asset.clone(),
                amount: fee,
                usd,
            },
            usd,
        );
    }
    let usd = if is_par(&received.asset_id) {
        Some(fee)
    } else {
        match &fill.paid {
            Some(paid) if is_par(&paid.asset_id) => Some(if fee == 0 {
                0
            } else {
                crate::money::mul_div(
                    fee,
                    paid.amount,
                    received.amount + fee,
                    crate::money::Rounding::Trunc,
                )
            }),
            _ => None,
        }
    };
    (
        BookFee::Known {
            asset_id: received.asset_id.clone(),
            amount: fee,
            usd,
        },
        usd,
    )
}

struct FeePart {
    sale_key: Option<String>,
    makes_lot: bool,
    usd: Option<Amount>,
}

#[derive(Default, Clone, Copy)]
struct Open {
    qty: Amount,
    counted_qty: Amount,
    cost: Option<Amount>,
}

/// `buildLotBook`.
pub fn build_lot_book(input: BookInput<'_>) -> LotBook {
    let mut residuals: BTreeSet<&'static str> = BTreeSet::new();
    if input.truncated {
        residuals.insert(TAX_LOT_BOOK_INCOMPLETE);
    }
    let include = input.include_transfers;
    let mut movements = movements_of(input.fills, &mut residuals);
    for out in input.withdrawals {
        if is_par(&out.asset_id) {
            continue;
        }
        movements.push(Movement {
            tx_id: out.tx_id.clone(),
            posted_at: out.posted_at,
            asset_id: out.asset_id.clone(),
            qty: out.amount,
            side: Side::Dispose {
                proceeds_usd: out.value_usd,
                moved_out: true,
            },
        });
    }
    let mut sale_fees: HashMap<String, BookFee> = HashMap::new();
    let mut sale_markets: HashMap<String, String> = HashMap::new();
    let mut lot_fees: HashMap<String, BookFee> = HashMap::new();
    let mut fee_parts: Vec<FeePart> = Vec::new();
    for fill in input.fills {
        if is_par(&fill.received.asset_id)
            && fill.paid.as_ref().is_some_and(|p| is_par(&p.asset_id))
        {
            continue;
        }
        let (fee, usd) = fee_of(fill);
        let makes_lot = !is_par(&fill.received.asset_id);
        let sale_key = fill
            .paid
            .as_ref()
            .filter(|p| !is_par(&p.asset_id))
            .map(|p| format!("{}|{}", fill.tx_id, p.asset_id));
        if makes_lot {
            lot_fees.insert(
                format!("{}|{}", fill.tx_id, fill.received.asset_id),
                fee.clone(),
            );
        }
        if let (Some(key), Some(paid)) = (&sale_key, &fill.paid) {
            sale_fees.insert(key.clone(), fee);
            if is_par(&fill.received.asset_id) {
                sale_markets.insert(
                    key.clone(),
                    format!(
                        "{}/{}",
                        paid.asset_id.to_uppercase(),
                        fill.received.asset_id.to_uppercase()
                    ),
                );
            }
        }
        fee_parts.push(FeePart {
            sale_key,
            makes_lot,
            usd,
        });
    }
    for inflow in input.inflows {
        if is_par(&inflow.asset_id) {
            continue;
        }
        movements.push(Movement {
            tx_id: inflow.tx_id.clone(),
            posted_at: inflow.posted_at,
            asset_id: inflow.asset_id.clone(),
            qty: inflow.amount,
            side: Side::Acquire {
                cost_usd: inflow.cost_usd,
                source: inflow.source,
                reason: inflow.reason.clone(),
                valued_at: inflow.valued_at.clone(),
                space: inflow.space_id.clone(),
                carried: None,
            },
        });
    }
    for lot in input.carried_in {
        if is_par(&lot.asset_id) {
            continue;
        }
        movements.push(Movement {
            tx_id: lot.tx_id.clone(),
            posted_at: lot.moved_at,
            asset_id: lot.asset_id.clone(),
            qty: lot.qty,
            side: Side::Acquire {
                cost_usd: lot.cost_usd,
                source: lot.source,
                reason: lot.reason.clone(),
                valued_at: lot.valued_at.clone(),
                space: None,
                carried: Some(Box::new(CarriedIn {
                    lot_id: lot.lot_id.clone(),
                    acquired_at: lot.acquired_at,
                    from: lot.from.clone(),
                    customer_entered: lot.customer_entered,
                    price_lot_id: lot.price_lot_id.clone(),
                })),
            },
        });
    }
    for mv in input.moves {
        if is_par(&mv.asset_id) {
            continue;
        }
        movements.push(Movement {
            tx_id: mv.tx_id.clone(),
            posted_at: mv.posted_at,
            asset_id: mv.asset_id.clone(),
            qty: mv.amount,
            side: Side::Move {
                from: mv.from.clone(),
                to: mv.to.clone(),
            },
        });
    }
    let one = SaleRules::One(input.method);
    let rules = input.rules.unwrap_or(&one);
    let transfer = |s: LotSource| s.is_transfer();
    let apart: Option<&dyn Fn(LotSource) -> bool> = if include { None } else { Some(&transfer) };
    let run = run_lot_engine(&movements, rules, input.override_price_per_unit, apart);
    let lot_counted: HashMap<&str, bool> = run
        .lots
        .iter()
        .map(|l| (l.id.as_str(), include || !l.source.is_transfer()))
        .collect();
    let counted_lot = |id: &str| lot_counted.get(id).copied();
    for r in &run.residuals {
        if *r == TAX_COST_BASIS_UNAVAILABLE && !include {
            continue;
        }
        residuals.insert(r);
    }
    if !include {
        let open_unknown = run.lots.iter().any(|l| {
            l.remaining > 0 && l.remaining_cost_usd.is_none() && counted_lot(&l.id) == Some(true)
        });
        let part_unknown = run.sales.iter().any(|s| {
            !s.moved_out
                && s.matches
                    .iter()
                    .any(|m| m.cost_usd.is_none() && counted_lot(&m.lot_id) == Some(true))
        });
        if open_unknown || part_unknown {
            residuals.insert(TAX_COST_BASIS_UNAVAILABLE);
        }
    }

    let mut open_by_asset: HashMap<&str, Open> = HashMap::new();
    for lot in &run.lots {
        if lot.remaining == 0 || lot.space.is_some() {
            continue;
        }
        let entry = open_by_asset.entry(&lot.asset_id).or_insert(Open {
            qty: 0,
            counted_qty: 0,
            cost: Some(0),
        });
        entry.qty += lot.remaining;
        if counted_lot(&lot.id) == Some(true) {
            entry.counted_qty += lot.remaining;
            entry.cost = match (entry.cost, lot.remaining_cost_usd) {
                (Some(c), Some(r)) => Some(c + r),
                _ => None,
            };
        }
    }
    let sold_assets: Vec<&str> = {
        let mut seen: Vec<&str> = Vec::new();
        for s in &run.sales {
            if !seen.contains(&s.asset_id.as_str()) {
                seen.push(&s.asset_id);
            }
        }
        seen
    };
    let outside_in = |a: &str| input.outside_inflows.iter().any(|x| x == a);
    let asset_ids: BTreeSet<String> = open_by_asset
        .keys()
        .map(|k| (*k).to_owned())
        .chain(input.held.keys().cloned())
        .chain(input.outside_inflows.iter().cloned())
        .collect();
    let mut assets = Vec::new();
    let mut outside: BTreeSet<String> = BTreeSet::new();
    for asset_id in &asset_ids {
        let open = open_by_asset.get(asset_id.as_str()).copied();
        let held = input.held.get(asset_id).copied().unwrap_or(0);
        let par = is_par(asset_id);
        let came_from_outside = outside_in(asset_id) && !par;
        if came_from_outside
            && (sold_assets.contains(&asset_id.as_str()) || open.is_some() || held > 0)
        {
            residuals.insert(TAX_LOT_BOOK_UNRECONCILED);
            outside.insert(asset_id.clone());
        }
        if open.is_none() && held == 0 {
            continue;
        }
        let reconciled = !came_from_outside && (open.map_or(0, |o| o.qty) == held || par);
        if !reconciled {
            residuals.insert(TAX_LOT_BOOK_UNRECONCILED);
            outside.insert(asset_id.clone());
        }
        if open.is_some_and(|o| o.cost.is_none()) {
            residuals.insert(TAX_COST_BASIS_UNAVAILABLE);
        }
        assets.push(BookAsset {
            asset_id: asset_id.clone(),
            open_qty: open.map_or(0, |o| o.counted_qty),
            open_cost_usd: match open {
                Some(o) if reconciled && !input.truncated => o.cost,
                _ => None,
            },
            held,
            uncounted_qty: open.map_or(0, |o| o.qty - o.counted_qty),
            venue_account: None,
        });
    }
    for asset_id in &sold_assets {
        if outside_in(asset_id) && !is_par(asset_id) {
            outside.insert((*asset_id).to_owned());
        }
    }

    let mut space_outside: HashSet<String> = HashSet::new();
    for (space_id, held_here) in input.space_held.unwrap_or(&[]) {
        let mut open: Vec<(&str, Amount)> = Vec::new();
        for lot in run
            .lots
            .iter()
            .filter(|l| l.space.as_deref() == Some(space_id))
        {
            match open.iter_mut().find(|(a, _)| *a == lot.asset_id) {
                Some((_, q)) => *q += lot.remaining,
                None => open.push((&lot.asset_id, lot.remaining)),
            }
        }
        let held_of = |a: &str| {
            held_here
                .iter()
                .find(|(x, _)| x == a)
                .map_or(0, |(_, q)| *q)
        };
        let open_of = |a: &str| open.iter().find(|(x, _)| *x == a).map_or(0, |(_, q)| *q);
        let keys: Vec<&str> = open
            .iter()
            .map(|(a, _)| *a)
            .chain(held_here.iter().map(|(a, _)| a.as_str()))
            .collect();
        for asset_id in keys {
            if is_par(asset_id) {
                continue;
            }
            if open_of(asset_id) != held_of(asset_id) {
                residuals.insert(TAX_LOT_BOOK_UNRECONCILED);
                space_outside.insert(format!("{space_id}|{asset_id}"));
            }
        }
    }

    let blank = |asset_id: &str| input.truncated || outside.contains(asset_id);
    let blank_lot = |asset_id: &str, space: Option<&str>| match space {
        None => blank(asset_id),
        Some(s) => input.truncated || space_outside.contains(&format!("{s}|{asset_id}")),
    };
    let sales: Vec<BookSale> = run
        .sales
        .iter()
        .map(|sale| {
            let sale_counts = !sale.moved_out || include;
            let counts = |lot_id: &str| sale_counts && counted_lot(lot_id).unwrap_or(true);
            let matches: Vec<BookMatch> = sale
                .matches
                .iter()
                .map(|m| {
                    let cost_usd = if blank(&sale.asset_id) {
                        None
                    } else {
                        m.cost_usd
                    };
                    BookMatch {
                        lot_id: m.lot_id.clone(),
                        qty: m.qty,
                        cost_usd,
                        proceeds_usd: m.proceeds_usd,
                        realized_usd: if blank(&sale.asset_id) {
                            None
                        } else {
                            m.realized_usd
                        },
                        customer_entered: m.customer_entered && cost_usd.is_some(),
                        counted: counts(&m.lot_id),
                    }
                })
                .collect();
            let counted_parts: Vec<_> = sale.matches.iter().filter(|m| counts(&m.lot_id)).collect();
            let counted = if !sale_counts {
                Counted::None
            } else if counted_parts.len() == sale.matches.len() {
                Counted::All
            } else if counted_parts.is_empty() && sale.unmatched_qty == 0 {
                Counted::None
            } else {
                Counted::Part
            };
            let sum_of = |f: &dyn Fn(&crate::lot_engine::LotMatch) -> Option<Amount>| {
                counted_parts
                    .iter()
                    .try_fold(0, |t: Amount, m| f(m).map(|v| t + v))
            };
            let part_cost = if sale.unmatched_qty > 0 {
                None
            } else {
                sum_of(&|m| m.cost_usd)
            };
            let part_proceeds = sum_of(&|m| m.proceeds_usd);
            let (proceeds_usd, cost_usd, realized_usd) = match counted {
                Counted::All => (sale.proceeds_usd, sale.cost_usd, sale.realized_usd),
                Counted::None => (sale.proceeds_usd, None, None),
                Counted::Part => (
                    part_proceeds,
                    part_cost,
                    match (part_cost, part_proceeds) {
                        (Some(c), Some(p)) => Some(p - c),
                        _ => None,
                    },
                ),
            };
            let key = format!("{}|{}", sale.tx_id, sale.asset_id);
            let fee =
                (!sale.moved_out).then(|| sale_fees.get(&key).cloned().unwrap_or(BookFee::Unknown));
            let market = if sale.moved_out {
                None
            } else {
                sale_markets.get(&key).cloned()
            };
            let customer = matches.iter().any(|m| m.customer_entered);
            BookSale {
                moved_out: sale.moved_out,
                counted,
                fee,
                market,
                method: sale.rule.method,
                method_source: sale.rule.source,
                picked_lot_id: sale.picked_lot_id.clone(),
                asset_id: sale.asset_id.clone(),
                tx_id: sale.tx_id.clone(),
                disposed_at: sale.posted_at,
                qty: sale.qty,
                unmatched_qty: sale.unmatched_qty,
                proceeds_usd,
                cost_usd: if blank(&sale.asset_id) {
                    None
                } else {
                    cost_usd
                },
                realized_usd: if blank(&sale.asset_id) {
                    None
                } else {
                    realized_usd
                },
                matches,
                customer_entered: customer,
                venue_account: None,
            }
        })
        .collect();
    let now = input.now;
    let lots: Vec<BookLot> = run
        .lots
        .iter()
        .map(|lot| {
            let shows_customer = !input.truncated && lot.customer_entered && lot.cost_usd.is_some();
            let fee_key = format!("{}|{}", lot.acquire_tx_id, lot.asset_id);
            BookLot {
                id: lot.id.clone(),
                asset_id: lot.asset_id.clone(),
                acquired_at: lot.acquired_at,
                source: lot.source,
                qty: lot.qty,
                remaining: lot.remaining,
                cost_usd: if input.truncated { None } else { lot.cost_usd },
                remaining_cost_usd: if blank_lot(&lot.asset_id, lot.space.as_deref()) {
                    None
                } else {
                    lot.remaining_cost_usd
                },
                valued_at: lot.valued_at.clone(),
                days_held: (lot.remaining != 0)
                    .then(|| (now.0 - lot.acquired_at.0).div_euclid(DAY_MS).max(0)),
                customer_entered: shows_customer,
                space_id: lot.space.clone(),
                basis_lot_id: if shows_customer {
                    lot.price_lot_id.clone()
                } else {
                    None
                },
                carried_from: lot.carried_from.clone(),
                counted: counted_lot(&lot.id).unwrap_or(true),
                fee: if lot.source == LotSource::Trade && lot.carried_from.is_none() {
                    lot_fees.get(&fee_key).cloned()
                } else {
                    None
                },
                venue_account: None,
            }
        })
        .collect();

    let sale_by_key: HashMap<String, &BookSale> = sales
        .iter()
        .map(|s| (format!("{}|{}", s.tx_id, s.asset_id), s))
        .collect();
    let mut fees_usd: Option<Amount> = Some(0);
    for part in &fee_parts {
        let sale = part.sale_key.as_ref().and_then(|k| sale_by_key.get(k));
        if !part.makes_lot && sale.is_some_and(|s| s.counted == Counted::None) {
            continue;
        }
        match (fees_usd, part.usd) {
            (Some(t), Some(u)) => fees_usd = Some(t + u),
            _ => {
                fees_usd = None;
                break;
            }
        }
    }
    let any_counted = sales.iter().any(|s| s.counted != Counted::None);
    let realized_total = sales
        .iter()
        .filter(|s| s.counted != Counted::None)
        .try_fold(0, |t: Amount, s| s.realized_usd.map(|r| t + r));

    LotBook {
        method: input.method,
        preview: input.preview,
        choices: input.choices.unwrap_or(BookChoices::Unwired),
        assets,
        sales,
        lots,
        realized_usd: if !any_counted { None } else { realized_total },
        include_transfers: include,
        fees_usd,
        residuals: residuals.into_iter().collect(),
        outside_assets: (!outside.is_empty()).then(|| outside.into_iter().collect()),
        manual_positions: None,
        spaces: input.spaces,
        venue: None,
    }
}
