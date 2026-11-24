//! Profit and loss over time (`pnl-over-time.ts`, J-portfolio-05 #4-#5), worked out from the
//! finished lot book and never stored: the cumulative result at each moment of a range, and the change over it split by
//! coin, market and day, each split adding up to the change exactly (refused if it does not).

use std::collections::{BTreeSet, HashMap};

use crate::json::Json;
use crate::lot_book::{BookFee, Counted, LotBook, is_par};
use crate::money::mul;
use crate::ports::{CloseSeries, SeriesTimeframe};
use crate::tax::{Amount, Failure, TAX_PNL_RANGE_INVALID, TaxError, format_amount, locale_compare};
use crate::time::Instant;

pub const TAX_PNL_BREAKDOWN_MISMATCH: &str = "tax.pnl_breakdown_mismatch";
pub const HELD_KEY: &str = "held";
pub const MOVED_KEY_PREFIX: &str = "moved:";
pub const SWAP_KEY_PREFIX: &str = "swap:";
const MAX_POINTS: i128 = 400;
const MAX_CANDLES_TO_NOW: i128 = 718;
/// `PNL_BREAKDOWN_MAX_DAYS`.
pub const MAX_BREAKDOWN_DAYS: usize = 400;
const DAY_MS: i64 = 86_400_000;

/// `chooseInterval`: the finest candle whose points fit a chart and whose window to now fits one read.
pub fn choose_interval(from: Instant, to: Instant, now: Instant) -> Option<SeriesTimeframe> {
    let span = i128::from(to.0) - i128::from(from.0);
    let back = i128::from(now.0) - i128::from(from.0);
    SeriesTimeframe::ALL.into_iter().find(|t| {
        let ms = i128::from(t.ms());
        span <= MAX_POINTS * ms && back <= MAX_CANDLES_TO_NOW * ms
    })
}

/// `samplesOf`: `from`, every candle boundary strictly inside the range, and `to`.
pub fn samples_of(from: Instant, to: Instant, interval: SeriesTimeframe) -> Vec<Instant> {
    let ms = interval.ms();
    let mut out = vec![from];
    let mut t = from.0.div_euclid(ms) * ms + ms;
    while t < to.0 {
        out.push(Instant(t));
        t += ms;
    }
    if to.0 > from.0 {
        out.push(to);
    }
    out
}

/// `dayEdges`: the customer's midnights strictly inside the range.
pub fn day_edges(from: Instant, to: Instant, utc_offset_minutes: i64) -> Vec<Instant> {
    let shift = utc_offset_minutes * 60_000;
    let mut out = Vec::new();
    let mut local = (from.0 + shift).div_euclid(DAY_MS) * DAY_MS + DAY_MS;
    while local - shift < to.0 {
        out.push(Instant(local - shift));
        local += DAY_MS;
    }
    out
}

fn day_key(at: Instant, utc_offset_minutes: i64) -> String {
    Instant(at.0 + utc_offset_minutes * 60_000)
        .iso()
        .get(0..10)
        .unwrap_or_default()
        .to_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    NoPrice,
    CostUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Missing {
    asset_id: String,
    reason: Reason,
}

#[derive(Debug, Clone)]
struct CoinAt {
    realized: Option<Amount>,
    unrealized: Option<Amount>,
    missing: Option<Missing>,
}

#[derive(Debug, Clone, Copy)]
pub struct Position {
    pub qty: Amount,
    pub cost: Option<Amount>,
}

fn plus(a: Option<Amount>, b: Option<Amount>) -> Option<Amount> {
    Some(a? + b?)
}

fn sub(a: Option<Amount>, b: Option<Amount>) -> Option<Amount> {
    Some(a? - b?)
}

struct TimelineLot {
    asset_id: String,
    arrived: i64,
    qty: Amount,
    cost: Option<Amount>,
}

struct Draw {
    lot: usize,
    when: i64,
    qty: Amount,
    cost: Option<Amount>,
}

struct TimelineSale {
    asset_id: String,
    when: i64,
    realized: Option<Amount>,
    market_key: String,
}

/// `BookTimeline`: what the figures at a moment are built from.
pub struct BookTimeline {
    /// The counted main-account lots, in the book's order (the TypeScript `Map`'s insertion order).
    lots: Vec<(String, TimelineLot)>,
    draws: Vec<Draw>,
    assets: Vec<String>,
    sales: Vec<TimelineSale>,
    fees: Vec<(i64, Option<Amount>)>,
    unknown: Vec<String>,
}

fn fee_usd(fee: Option<&BookFee>) -> Option<Amount> {
    match fee {
        None => Some(Amount::ZERO),
        Some(BookFee::Known { usd, .. }) => *usd,
        Some(BookFee::Unknown) => None,
    }
}

impl BookTimeline {
    pub fn new(book: &LotBook) -> BookTimeline {
        let mut lots: Vec<(String, TimelineLot)> = Vec::new();
        for lot in &book.lots {
            if lot.space_id.is_some() || !lot.counted || is_par(&lot.asset_id) {
                continue;
            }
            let arrived = lot
                .carried_from
                .as_ref()
                .map_or(lot.acquired_at, |c| c.moved_at)
                .0;
            let entry = TimelineLot {
                asset_id: lot.asset_id.clone(),
                arrived,
                qty: lot.qty,
                cost: lot.cost_usd,
            };
            match lots.iter_mut().find(|(id, _)| *id == lot.id) {
                Some((_, slot)) => *slot = entry,
                None => lots.push((lot.id.clone(), entry)),
            }
        }
        let index = |id: &str| lots.iter().position(|(x, _)| x == id);
        let mut draws = Vec::new();
        let mut sales = Vec::new();
        let mut fees = Vec::new();
        for sale in &book.sales {
            let when = sale.disposed_at.0;
            for m in &sale.matches {
                if let Some(lot) = index(&m.lot_id) {
                    draws.push(Draw {
                        lot,
                        when,
                        qty: m.qty,
                        cost: m.cost_usd,
                    });
                }
            }
            if sale.counted == Counted::None {
                continue;
            }
            let market_key = sale.market.clone().unwrap_or_else(|| {
                let prefix = if sale.moved_out {
                    MOVED_KEY_PREFIX
                } else {
                    SWAP_KEY_PREFIX
                };
                format!("{prefix}{}", sale.asset_id)
            });
            sales.push(TimelineSale {
                asset_id: sale.asset_id.clone(),
                when,
                realized: sale.realized_usd,
                market_key,
            });
            if !sale.moved_out {
                fees.push((when, fee_usd(sale.fee.as_ref())));
            }
        }
        for carried in &book.lots {
            let Some(from) = &carried.carried_from else {
                continue;
            };
            if let Some(lot) = index(&from.lot_id) {
                draws.push(Draw {
                    lot,
                    when: from.moved_at.0,
                    qty: carried.qty,
                    cost: carried.cost_usd,
                });
            }
        }
        for lot in &book.lots {
            if index(&lot.id).is_none()
                || lot.source != crate::lot_engine::LotSource::Trade
                || lot.carried_from.is_some()
            {
                continue;
            }
            fees.push((lot.acquired_at.0, fee_usd(lot.fee.as_ref())));
        }
        sales.sort_by_key(|s| s.when);
        let mut assets: BTreeSet<String> = lots.iter().map(|(_, l)| l.asset_id.clone()).collect();
        for s in &sales {
            assets.insert(s.asset_id.clone());
        }
        BookTimeline {
            lots,
            draws,
            assets: assets.into_iter().collect(),
            sales,
            fees,
            unknown: book.outside_assets.clone().unwrap_or_default(),
        }
    }

    /// `coins`.
    pub fn coins(&self) -> &[String] {
        &self.assets
    }

    /// `positionsAt`: the counted main-account position in each coin at T.
    pub fn positions_at(&self, time: Instant) -> HashMap<String, Position> {
        let t = time.0;
        let mut left: Vec<Option<Amount>> = vec![None; self.lots.len()];
        let mut out: HashMap<String, Position> = HashMap::new();
        for (i, (_, lot)) in self.lots.iter().enumerate() {
            if lot.arrived > t {
                continue;
            }
            if let Some(slot) = left.get_mut(i) {
                *slot = Some(lot.qty);
            }
            let p = out.entry(lot.asset_id.clone()).or_insert(Position {
                qty: Amount::ZERO,
                cost: Some(Amount::ZERO),
            });
            p.qty += lot.qty;
            if lot.cost.is_some() {
                p.cost = plus(p.cost, lot.cost);
            }
        }
        for draw in &self.draws {
            let Some(Some(remaining)) = left.get(draw.lot).copied() else {
                continue;
            };
            if draw.when > t {
                continue;
            }
            if let Some(slot) = left.get_mut(draw.lot) {
                *slot = Some(remaining - draw.qty);
            }
            let Some((_, lot)) = self.lots.get(draw.lot) else {
                continue;
            };
            let p = out.entry(lot.asset_id.clone()).or_insert(Position {
                qty: Amount::ZERO,
                cost: Some(Amount::ZERO),
            });
            p.qty -= draw.qty;
            if lot.cost.is_some() {
                p.cost = sub(p.cost, draw.cost);
            }
        }
        for (i, remaining) in left.iter().enumerate() {
            let (Some(r), Some((_, lot))) = (remaining, self.lots.get(i)) else {
                continue;
            };
            if lot.cost.is_none() && *r != Amount::ZERO {
                out.entry(lot.asset_id.clone())
                    .or_insert(Position {
                        qty: Amount::ZERO,
                        cost: Some(Amount::ZERO),
                    })
                    .cost = None;
            }
        }
        for p in out.values_mut() {
            if p.qty == Amount::ZERO && p.cost.is_some() {
                *p = Position {
                    qty: Amount::ZERO,
                    cost: Some(Amount::ZERO),
                };
            }
        }
        out
    }

    pub fn is_unknown(&self, asset_id: &str) -> bool {
        self.unknown.iter().any(|a| a == asset_id)
    }

    /// The realised result of the counted sales in (after, time], keyed as asked, in first-seen order.
    fn realized_in(
        &self,
        after: Option<Instant>,
        time: Instant,
        market: bool,
    ) -> Vec<(String, Option<Amount>)> {
        let mut out: Vec<(String, Option<Amount>)> = Vec::new();
        for sale in &self.sales {
            if sale.when > time.0 {
                break;
            }
            if after.is_some_and(|a| sale.when <= a.0) {
                continue;
            }
            let key = if market {
                &sale.market_key
            } else {
                &sale.asset_id
            };
            match out.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = plus(*v, sale.realized),
                None => out.push((key.clone(), plus(Some(Amount::ZERO), sale.realized))),
            }
        }
        out
    }

    /// `realizedBy`.
    pub fn realized_by(
        &self,
        time: Instant,
        after: Option<Instant>,
    ) -> Vec<(String, Option<Amount>)> {
        self.realized_in(after, time, false)
    }

    /// `realizedByMarket`.
    pub fn realized_by_market(
        &self,
        after: Instant,
        time: Instant,
    ) -> Vec<(String, Option<Amount>)> {
        self.realized_in(Some(after), time, true)
    }

    /// `feesIn`.
    pub fn fees_in(&self, after: Instant, time: Instant) -> Option<Amount> {
        let mut total = Some(Amount::ZERO);
        for (when, usd) in &self.fees {
            if *when > after.0 && *when <= time.0 {
                total = plus(total, *usd);
            }
        }
        total
    }
}

/// `closeAt`: the close of the last candle that had ended by T; the open one only at the live end of the range.
pub fn close_at(
    series: &CloseSeries,
    interval: SeriesTimeframe,
    at: Instant,
    live: bool,
) -> Option<Amount> {
    let ms = interval.ms();
    let t = at.0;
    let mut found = None;
    for (open_at, close) in &series.candles {
        if open_at + ms <= t || (live && *open_at <= t) {
            found = Some(*close);
        } else if *open_at > t {
            break;
        }
    }
    found
}

/// `PnlInputs`.
pub struct PnlInputs<'a> {
    pub book: &'a LotBook,
    pub from: Instant,
    pub to: Instant,
    pub now: Instant,
    pub interval: SeriesTimeframe,
    pub utc_offset_minutes: i64,
    /// Each coin's candles; `None`: the coin has no market.
    pub closes: &'a HashMap<String, Option<CloseSeries>>,
    pub timeline: Option<&'a BookTimeline>,
}

fn lookup(list: &[(String, Option<Amount>)], key: &str) -> Option<Option<Amount>> {
    list.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
}

fn fmt(v: Option<Amount>) -> Json {
    v.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

/// `pnlOverTime`, its answer in `pnlOverTimeSchema`'s order.
pub fn pnl_over_time(input: &PnlInputs<'_>) -> Result<Json, Failure> {
    let (from, to, now) = (input.from, input.to, input.now);
    if from >= to {
        return Err(Failure::Refused(TaxError {
            code: TAX_PNL_RANGE_INVALID,
            message: "the range must start before it ends".to_owned(),
        }));
    }
    let owned;
    let timeline = match input.timeline {
        Some(t) => t,
        None => {
            owned = BookTimeline::new(input.book);
            &owned
        }
    };
    let coins = timeline.coins();
    let live_end = to >= now;
    let mut seen: HashMap<i64, Vec<(String, CoinAt)>> = HashMap::new();
    let mut coins_at = |time: Instant| -> Vec<(String, CoinAt)> {
        if let Some(c) = seen.get(&time.0) {
            return c.clone();
        }
        let live = live_end && time == to;
        let positions = timeline.positions_at(time);
        let realized = timeline.realized_by(time, None);
        let mut out = Vec::new();
        for asset_id in coins {
            if timeline.is_unknown(asset_id) {
                out.push((
                    asset_id.clone(),
                    CoinAt {
                        realized: None,
                        unrealized: None,
                        missing: Some(Missing {
                            asset_id: asset_id.clone(),
                            reason: Reason::CostUnknown,
                        }),
                    },
                ));
                continue;
            }
            let r = lookup(&realized, asset_id).unwrap_or(Some(Amount::ZERO));
            let p = positions.get(asset_id).copied().unwrap_or(Position {
                qty: Amount::ZERO,
                cost: Some(Amount::ZERO),
            });
            let mut unrealized = Some(Amount::ZERO);
            let mut missing = r.is_none().then(|| Missing {
                asset_id: asset_id.clone(),
                reason: Reason::CostUnknown,
            });
            if p.qty != Amount::ZERO {
                let price = input
                    .closes
                    .get(asset_id)
                    .and_then(Option::as_ref)
                    .and_then(|s| close_at(s, input.interval, time, live));
                match (p.cost, price) {
                    (None, _) => {
                        unrealized = None;
                        missing = Some(Missing {
                            asset_id: asset_id.clone(),
                            reason: Reason::CostUnknown,
                        });
                    }
                    (Some(_), None) => {
                        unrealized = None;
                        if missing.is_none() {
                            missing = Some(Missing {
                                asset_id: asset_id.clone(),
                                reason: Reason::NoPrice,
                            });
                        }
                    }
                    (Some(cost), Some(price)) => unrealized = Some(mul(p.qty, price) - cost),
                }
            }
            out.push((
                asset_id.clone(),
                CoinAt {
                    realized: r,
                    unrealized,
                    missing,
                },
            ));
        }
        seen.insert(time.0, out.clone());
        out
    };
    struct Totals {
        realized: Option<Amount>,
        unrealized: Option<Amount>,
        total: Option<Amount>,
        missing: Vec<Missing>,
    }
    let totals = |by_coin: &[(String, CoinAt)]| {
        let mut realized = Some(Amount::ZERO);
        let mut unrealized = Some(Amount::ZERO);
        let mut missing = Vec::new();
        for (_, c) in by_coin {
            realized = plus(realized, c.realized);
            unrealized = plus(unrealized, c.unrealized);
            if let Some(m) = &c.missing {
                missing.push(m.clone());
            }
        }
        Totals {
            realized,
            unrealized,
            total: plus(realized, unrealized),
            missing,
        }
    };
    let unrealized_of = |list: &[(String, CoinAt)], asset: &str| {
        list.iter()
            .find(|(k, _)| k == asset)
            .and_then(|(_, c)| c.unrealized)
    };
    let change_between =
        |a: Instant, b: Instant, coins_at: &mut dyn FnMut(Instant) -> Vec<(String, CoinAt)>| {
            let at_a = coins_at(a);
            let at_b = coins_at(b);
            let sold = timeline.realized_by(b, Some(a));
            let mut out: Vec<(String, Option<Amount>)> = Vec::new();
            for asset_id in coins {
                if timeline.is_unknown(asset_id) {
                    out.push((asset_id.clone(), None));
                    continue;
                }
                let in_range = lookup(&sold, asset_id).unwrap_or(Some(Amount::ZERO));
                out.push((
                    asset_id.clone(),
                    plus(
                        in_range,
                        sub(
                            unrealized_of(&at_b, asset_id),
                            unrealized_of(&at_a, asset_id),
                        ),
                    ),
                ));
            }
            out
        };
    let total_of = |parts: &[(String, Option<Amount>)]| {
        parts
            .iter()
            .try_fold(Amount::ZERO, |t: Amount, (_, v)| v.map(|x| t + x))
    };
    let blank = input
        .book
        .residuals
        .contains(&crate::tax::TAX_LOT_BOOK_INCOMPLETE);
    let mut points = Vec::new();
    for time in samples_of(from, to, input.interval) {
        let t = totals(&coins_at(time));
        let hide = |v: Option<Amount>| if blank { Json::Null } else { fmt(v) };
        points.push(Json::obj([
            ("at", Json::str(time.iso())),
            ("totalUsd", hide(t.total)),
            ("realizedUsd", hide(t.realized)),
            ("unrealizedUsd", hide(t.unrealized)),
            (
                "missing",
                Json::Array(
                    t.missing
                        .iter()
                        .map(|m| {
                            Json::obj([
                                ("assetId", Json::str(m.asset_id.clone())),
                                (
                                    "reason",
                                    Json::str(match m.reason {
                                        Reason::NoPrice => "no_price",
                                        Reason::CostUnknown => "cost_unknown",
                                    }),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]));
    }
    let parts = change_between(from, to, &mut coins_at);
    let period = if blank { None } else { total_of(&parts) };
    let by_asset: Vec<(String, Option<Amount>)> = coins
        .iter()
        .map(|a| {
            (
                a.clone(),
                if blank {
                    None
                } else {
                    lookup(&parts, a).flatten()
                },
            )
        })
        .collect();
    let start_t = totals(&coins_at(from));
    let end_t = totals(&coins_at(to));
    let mut markets = timeline.realized_by_market(from, to);
    markets.sort_by(|(a, _), (b, _)| locale_compare(a, b));
    let mut by_market: Vec<(String, Option<Amount>)> = markets
        .into_iter()
        .map(|(k, v)| (k, if blank { None } else { v }))
        .collect();
    by_market.push((
        HELD_KEY.to_owned(),
        if blank {
            None
        } else {
            sub(end_t.unrealized, start_t.unrealized)
        },
    ));
    let edges = day_edges(from, to, input.utc_offset_minutes);
    let by_day = if edges.len() < MAX_BREAKDOWN_DAYS {
        let mut marks = vec![from];
        marks.extend(edges);
        marks.push(to);
        let mut rows = Vec::new();
        for pair in marks.windows(2) {
            let (Some(a), Some(b)) = (pair.first(), pair.get(1)) else {
                continue;
            };
            rows.push((
                day_key(*a, input.utc_offset_minutes),
                if blank {
                    None
                } else {
                    total_of(&change_between(*a, *b, &mut coins_at))
                },
            ));
        }
        Some(rows)
    } else {
        None
    };
    if let Some(period) = period {
        let none: Vec<(String, Option<Amount>)> = Vec::new();
        for (name, rows) in [
            ("coin", &by_asset),
            ("market", &by_market),
            ("day", by_day.as_ref().unwrap_or(&none)),
        ] {
            if rows.iter().any(|(_, v)| v.is_none()) {
                continue;
            }
            let sum: Amount = rows.iter().map(|(_, v)| v.unwrap_or(Amount::ZERO)).sum();
            if sum != period {
                return Err(Failure::Refused(TaxError {
                    code: TAX_PNL_BREAKDOWN_MISMATCH,
                    message: format!("the {name} breakdown does not add up to the period"),
                }));
            }
        }
    }
    let fees = timeline.fees_in(from, to);
    let rows = |rows: &[(String, Option<Amount>)]| {
        Json::Array(
            rows.iter()
                .map(|(k, v)| Json::obj([("key", Json::str(k.clone())), ("usd", fmt(*v))]))
                .collect(),
        )
    };
    Ok(Json::obj([
        ("indicator", Json::str(crate::lot_book::INDICATOR_LABEL)),
        ("from", Json::str(from.iso())),
        ("to", Json::str(to.iso())),
        ("interval", Json::str(input.interval.name())),
        ("includeTransfers", Json::Bool(input.book.include_transfers)),
        ("points", Json::Array(points)),
        ("periodUsd", fmt(period)),
        ("feesUsd", fmt(fees)),
        ("byAsset", rows(&by_asset)),
        ("byMarket", rows(&by_market)),
        ("byDay", by_day.as_deref().map_or(Json::Null, rows)),
        ("utcOffsetMinutes", Json::int(input.utc_offset_minutes)),
        (
            "residuals",
            Json::Array(input.book.residuals.iter().map(|r| Json::str(*r)).collect()),
        ),
    ]))
}
