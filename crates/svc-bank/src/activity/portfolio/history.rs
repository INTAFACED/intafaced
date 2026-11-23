//! Value over time and holdings change (`portfolio/value-history.ts`, J-portfolio-05 #6-#7, J-portfolio-06 #3), worked
//! out from svc-ledger's holdings history, never stored. The holdings at a moment are what is held now less every
//! movement from that moment on, over the main account and named Spaces; each moment is valued at the close of the last
//! candle that had ended by then (only the live end may use the candle still open); USDT, USDC and USD count as 1. A
//! coin held with no price leaves that moment missing, never zero. The bridge sorts each movement by the ledger's own
//! reason: deposits and withdrawals crossed the platform's edge, fees are fees, trades are left to the market move, and
//! everything else is another flow; moves between the person's own accounts net to zero.
//!
//! Also here: svc-ledger's `holdingsHistory` port (`createLedgerHoldingsHistory`), with the history budget.

use std::collections::{BTreeSet, HashMap};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, mul, parse_amount};
use service_kit::time::{Instant, js_date, zod_datetime};

use super::candles::{CloseSeries, INTERVALS, close_at, timeframe_ms};
use super::valuation::{PAR_ASSETS, locale_compare};
use crate::activity::pages::HISTORY;
use crate::spaces::ports::LedgerHttp;

const MAX_POINTS: i64 = 400;
/// svc-trade answers a window only whole, at most 720 candles to now; one candle back from the start and one spare.
const MAX_CANDLES_TO_NOW: i64 = 718;
const DAY_SECONDS: i64 = 86_400;
const ONE: Amount = 1_000_000_000_000_000_000;

/// `LEDGER_HOLDINGS_HISTORY_BUCKETS`.
const BUCKETS: [i64; 5] = [60, 300, 3_600, 14_400, 86_400];

/// One movement row (`ledgerMovementSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub asset_id: String,
    pub module: String,
    pub reason: String,
    pub bucket_start: i64,
    pub inflow: Amount,
    pub outflow: Amount,
    pub fee: Amount,
}

/// One owner's holdings now and its movements since `from` (`LedgerHoldingsHistory`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Holdings {
    pub holdings: Vec<(String, Amount)>,
    pub movements: Vec<Movement>,
}

/// Why a holdings history read failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryError {
    /// `ledger.holdings_history_too_large`.
    TooLarge,
    Other(String),
}

/// svc-ledger's `holdingsHistory`.
pub trait HoldingsHistory: Send + Sync {
    fn holdings_history(
        &self,
        owner_type: &str,
        owner_id: &str,
        from: &str,
        bucket_seconds: i64,
    ) -> Result<Holdings, HistoryError>;
}

/// Nothing wired: every read fails.
pub struct NoHistory;

impl HoldingsHistory for NoHistory {
    fn holdings_history(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: i64,
    ) -> Result<Holdings, HistoryError> {
        Err(HistoryError::Other(
            "svc-bank in Rust: no ledger history is wired".to_owned(),
        ))
    }
}

/// `holdingsHistory` over svc-ledger's HTTP door.
pub struct LedgerHoldings(pub LedgerHttp);

/// `^\d+(\.\d{1,18})?$`.
fn decimal(s: &str) -> Result<Amount, String> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let ok = !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (!s.contains('.')
            || ((1..=18).contains(&frac.len()) && frac.bytes().all(|b| b.is_ascii_digit())));
    if !ok {
        return Err(format!(
            "svc-ledger holdingsHistory: {s:?} is not a decimal"
        ));
    }
    parse_amount(s)
}

fn text<'j>(j: &'j Json, key: &str) -> Result<&'j str, String> {
    match j.get(key) {
        Some(Json::String(s)) => Ok(s),
        _ => Err(format!("svc-ledger holdingsHistory: {key} is not a string")),
    }
}

fn asset(j: &Json) -> Result<String, String> {
    let a = text(j, "assetId")?;
    if a.is_empty() {
        return Err("svc-ledger holdingsHistory: an empty assetId".to_owned());
    }
    Ok(a.to_owned())
}

fn iso_time(s: &str) -> Result<i64, String> {
    if zod_datetime(s, true).is_none() {
        return Err(format!(
            "svc-ledger holdingsHistory: {s:?} is not a datetime"
        ));
    }
    js_date(s)
        .map(|t| t.0)
        .ok_or_else(|| format!("svc-ledger holdingsHistory: {s:?} is not a date"))
}

/// `ledgerHoldingsHistorySchema.parse`: a row that does not fit fails the read.
pub fn parse_holdings(answer: &Json) -> Result<Holdings, String> {
    iso_time(text(answer, "asOf")?)?;
    iso_time(text(answer, "from")?)?;
    match answer.get("bucketSeconds") {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "checked to be one of five integers"
        )]
        Some(Json::Number(n)) if BUCKETS.iter().any(|b| *n == *b as f64) => {}
        _ => return Err("svc-ledger holdingsHistory: bucketSeconds".to_owned()),
    }
    let (Some(Json::Array(holdings)), Some(Json::Array(movements))) =
        (answer.get("holdings"), answer.get("movements"))
    else {
        return Err("svc-ledger holdingsHistory: holdings or movements is not a list".to_owned());
    };
    Ok(Holdings {
        holdings: holdings
            .iter()
            .map(|h| Ok((asset(h)?, decimal(text(h, "amount")?)?)))
            .collect::<Result<_, String>>()?,
        movements: movements
            .iter()
            .map(|m| {
                Ok(Movement {
                    asset_id: asset(m)?,
                    module: text(m, "module")?.to_owned(),
                    reason: text(m, "reason")?.to_owned(),
                    bucket_start: iso_time(text(m, "bucketStart")?)?,
                    inflow: decimal(text(m, "inflow")?)?,
                    outflow: decimal(text(m, "outflow")?)?,
                    fee: decimal(text(m, "fee")?)?,
                })
            })
            .collect::<Result<_, String>>()?,
    })
}

impl HoldingsHistory for LedgerHoldings {
    fn holdings_history(
        &self,
        owner_type: &str,
        owner_id: &str,
        from: &str,
        bucket_seconds: i64,
    ) -> Result<Holdings, HistoryError> {
        let body = Json::obj([
            ("ownerType", Json::str(owner_type)),
            ("ownerId", Json::str(owner_id)),
            ("from", Json::str(from)),
            ("bucketSeconds", Json::int(bucket_seconds)),
        ]);
        let answer = self
            .0
            .call_with("/trpc/holdingsHistory", &body, HISTORY)
            .map_err(|f| {
                // `rehydrateLedgerHttpError`: svc-ledger's own code from its answer.
                let code = f
                    .detail
                    .as_deref()
                    .and_then(|d| service_kit::json::parse(d).ok())
                    .and_then(|j| match j.get("code") {
                        Some(Json::String(c)) => Some(c.clone()),
                        _ => None,
                    });
                if code.as_deref() == Some("ledger.holdings_history_too_large") {
                    HistoryError::TooLarge
                } else {
                    HistoryError::Other(f.message)
                }
            })?;
        parse_holdings(&answer).map_err(HistoryError::Other)
    }
}

/// `chooseInterval`: the finest candle size whose points fit a chart and whose window to now fits one read.
pub fn choose_interval(from: i64, to: i64, now: i64) -> Option<&'static str> {
    INTERVALS.into_iter().find(|i| {
        let ms = timeframe_ms(i);
        to - from <= MAX_POINTS * ms && now - from <= MAX_CANDLES_TO_NOW * ms
    })
}

/// `bucketOf`: the interval itself, up to a day.
pub fn bucket_of(interval: &str) -> i64 {
    (timeframe_ms(interval) / 1000).min(DAY_SECONDS)
}

/// The moments drawn and whether the end is live (`gridOf`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grid {
    pub samples: Vec<i64>,
    pub live: bool,
}

/// `gridOf`.
pub fn grid_of(from: i64, to: i64, now: i64, interval: &str) -> Option<Grid> {
    let bucket = bucket_of(interval) * 1000;
    let frame = timeframe_ms(interval);
    let live = to >= now;
    let start = from.div_euclid(bucket) * bucket;
    let end = if live {
        now
    } else {
        to.div_euclid(bucket) * bucket
    };
    if end <= start {
        return None;
    }
    let mut samples = vec![start];
    let mut t = start.div_euclid(frame) * frame + frame;
    while t < end {
        samples.push(t);
        t += frame;
    }
    samples.push(end);
    Some(Grid { samples, live })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leg {
    Deposits,
    Withdrawals,
    Fees,
    OtherFlows,
}

/// `legOf(classify(...))`: which bridge leg a ledger reason feeds, from `activity-kind.ts`'s tables. Trades, converts and
/// order reservations feed none (they are the market move). No rail or product reaches this read, so a welcome grant is
/// a deposit and a convert fill a trade, as `classify` makes them without one.
fn leg_of(module: &str, reason: &str) -> Option<Leg> {
    let key = format!("{module}/{reason}");
    match key.as_str() {
        "ledger/deposit.credited" | "ledger/deposit.reversed" => Some(Leg::Deposits),
        "ledger/withdraw.held" | "ledger/withdraw.settled" | "ledger/withdraw.reversed" => {
            Some(Leg::Withdrawals)
        }
        "market/market.listing_fee" | "market/market.premium_placement" => Some(Leg::Fees),
        "trade/trade.fill"
        | "trade/trade.fill.mm_maker"
        | "trade/trade.fill.buyback"
        | "trade/futures.margin.lock"
        | "trade/futures.margin.add"
        | "trade/futures.margin.release"
        | "trade/futures.loss.realized"
        | "trade/futures.profit.realized"
        | "trade/futures.funding.paid"
        | "trade/order.hold"
        | "trade/order.hold.amend"
        | "trade/order.hold.released"
        | "p2p/p2p.escrow.lock"
        | "p2p/p2p.escrow.release"
        | "p2p/p2p.escrow.refund" => None,
        // Every other row of the exact table is a kind that feeds the other flows, and none of them is a
        // `fee.charged`, so `KIND_BY_REASON` decides only for a reason outside it.
        _ if reason == "fee.charged" => Some(Leg::Fees),
        _ => Some(Leg::OtherFlows),
    }
}

struct Row {
    asset_id: String,
    leg: Option<Leg>,
    bucket_start: i64,
    net: Amount,
    fee: Amount,
}

/// What the replay reads: one answer per owner, the interval, the moments, whether the end is live, and each
/// non-dollar coin's candles (`None`: the coin has no market).
pub struct ValueInputs {
    pub histories: Vec<Holdings>,
    pub interval: &'static str,
    pub samples: Vec<i64>,
    pub live: bool,
    pub closes: HashMap<String, Option<CloseSeries>>,
}

/// `coinsOf`: every coin that is not a dollar coin, held at any point or moved in the range, in code-unit order.
pub fn coins_of(histories: &[Holdings]) -> Vec<String> {
    let mut coins = BTreeSet::new();
    for h in histories {
        for (a, _) in &h.holdings {
            coins.insert(a.to_uppercase());
        }
        for m in &h.movements {
            coins.insert(m.asset_id.to_uppercase());
        }
    }
    coins
        .into_iter()
        .filter(|c| !PAR_ASSETS.contains(&c.as_str()))
        .collect()
}

struct Replay<'a> {
    input: &'a ValueInputs,
    rows: Vec<Row>,
    holdings_at: Vec<HashMap<String, Amount>>,
}

impl Replay<'_> {
    fn price_at(&self, asset: &str, at: i64, live_end: bool) -> Option<Amount> {
        if PAR_ASSETS.contains(&asset) {
            return Some(ONE);
        }
        self.input
            .closes
            .get(asset)
            .and_then(Option::as_ref)
            .and_then(|s| close_at(s, self.input.interval, at, live_end))
    }
}

fn replay(input: &ValueInputs) -> Replay<'_> {
    let mut now: HashMap<String, Amount> = HashMap::new();
    let mut rows = Vec::new();
    for h in &input.histories {
        for (a, amount) in &h.holdings {
            *now.entry(a.to_uppercase()).or_insert(0) += amount;
        }
        for m in &h.movements {
            rows.push(Row {
                asset_id: m.asset_id.to_uppercase(),
                leg: leg_of(&m.module, &m.reason),
                bucket_start: m.bucket_start,
                net: m.inflow - m.outflow,
                fee: m.fee,
            });
        }
    }
    let mut by_newest: Vec<&Row> = rows.iter().collect();
    by_newest.sort_by_key(|r| std::cmp::Reverse(r.bucket_start));
    let mut held = now;
    let mut next = by_newest.iter().peekable();
    let n = input.samples.len();
    let mut holdings_at = vec![HashMap::new(); n];
    for (i, (t, slot)) in input
        .samples
        .iter()
        .zip(holdings_at.iter_mut())
        .enumerate()
        .rev()
    {
        let live_end = input.live && i + 1 == n;
        while !live_end && next.peek().is_some_and(|r| r.bucket_start >= *t) {
            if let Some(row) = next.next() {
                *held.entry(row.asset_id.clone()).or_insert(0) -= row.net;
            }
        }
        slot.clone_from(&held);
    }
    Replay {
        input,
        rows,
        holdings_at,
    }
}

/// One row of the holdings change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeRow {
    pub asset_id: String,
    pub start: Amount,
    pub end: Amount,
    pub start_price: Option<Amount>,
    pub end_price: Option<Amount>,
}

fn money(a: Option<Amount>) -> Json {
    a.map_or(Json::Null, |v| Json::str(format_amount(v)))
}

/// `bankHoldingsChangeSchema`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldingsChange {
    pub from: i64,
    pub to: i64,
    pub rows: Vec<ChangeRow>,
}

impl HoldingsChange {
    pub fn json(&self) -> Json {
        Json::obj([
            ("from", Json::str(Instant(self.from).iso())),
            ("to", Json::str(Instant(self.to).iso())),
            (
                "rows",
                Json::Array(
                    self.rows
                        .iter()
                        .map(|r| {
                            Json::obj([
                                ("assetId", Json::str(r.asset_id.clone())),
                                ("startAmount", Json::str(format_amount(r.start))),
                                ("endAmount", Json::str(format_amount(r.end))),
                                ("change", Json::str(format_amount(r.end - r.start))),
                                ("startPriceUsd", money(r.start_price)),
                                ("endPriceUsd", money(r.end_price)),
                                (
                                    "startValueUsd",
                                    money(r.start_price.map(|p| mul(r.start, p))),
                                ),
                                ("endValueUsd", money(r.end_price.map(|p| mul(r.end, p)))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// `holdingsChange`: what rose and fell in amount between the first and last samples, per coin.
pub fn holdings_change(input: &ValueInputs) -> HoldingsChange {
    let r = replay(input);
    let first = input.samples.first().copied().unwrap_or_default();
    let last = input.samples.last().copied().unwrap_or_default();
    let empty = HashMap::new();
    let start = r.holdings_at.first().unwrap_or(&empty);
    let end = r.holdings_at.last().unwrap_or(&empty);
    let coins: BTreeSet<&String> = start.keys().chain(end.keys()).collect();
    let rows = coins
        .into_iter()
        .filter_map(|asset| {
            let before = start.get(asset).copied().unwrap_or(0);
            let after = end.get(asset).copied().unwrap_or(0);
            if before == 0 && after == 0 {
                return None;
            }
            Some(ChangeRow {
                asset_id: asset.clone(),
                start: before,
                end: after,
                start_price: r.price_at(asset, first, false),
                end_price: r.price_at(asset, last, input.live),
            })
        })
        .collect();
    HoldingsChange {
        from: first,
        to: last,
        rows,
    }
}

/// One moment's value: `None` when a coin held then has no price, with the coins named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Point {
    pub at: i64,
    pub value: Option<Amount>,
    pub missing: Vec<String>,
}

/// `bankValueBridgeSchema`'s answer: every leg `None` when any part has no price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bridge {
    pub opening: Option<Amount>,
    pub deposits: Option<Amount>,
    pub withdrawals: Option<Amount>,
    pub fees: Option<Amount>,
    pub other_flows: Option<Amount>,
    pub market_move: Option<Amount>,
    pub closing: Option<Amount>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueOverTime {
    pub from: i64,
    pub to: i64,
    pub interval: &'static str,
    pub points: Vec<Point>,
    pub bridge: Bridge,
}

fn missing_json(m: &[String]) -> Json {
    Json::Array(
        m.iter()
            .map(|a| {
                Json::obj([
                    ("assetId", Json::str(a.clone())),
                    ("reason", Json::str("no_price")),
                ])
            })
            .collect(),
    )
}

impl ValueOverTime {
    pub fn json(&self) -> Json {
        let b = &self.bridge;
        Json::obj([
            ("from", Json::str(Instant(self.from).iso())),
            ("to", Json::str(Instant(self.to).iso())),
            ("interval", Json::str(self.interval)),
            (
                "points",
                Json::Array(
                    self.points
                        .iter()
                        .map(|p| {
                            Json::obj([
                                ("at", Json::str(Instant(p.at).iso())),
                                ("valueUsd", money(p.value)),
                                ("missing", missing_json(&p.missing)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "bridge",
                Json::obj([
                    ("openingUsd", money(b.opening)),
                    ("depositsUsd", money(b.deposits)),
                    ("withdrawalsUsd", money(b.withdrawals)),
                    ("feesUsd", money(b.fees)),
                    ("otherFlowsUsd", money(b.other_flows)),
                    ("marketMoveUsd", money(b.market_move)),
                    ("closingUsd", money(b.closing)),
                    ("missing", missing_json(&b.missing)),
                ]),
            ),
        ])
    }
}

/// `valueOverTime`.
pub fn value_over_time(input: &ValueInputs) -> ValueOverTime {
    let r = replay(input);
    let bucket = bucket_of(input.interval) * 1000;
    let n = input.samples.len();
    let end = input.samples.last().copied().unwrap_or_default();
    let value_of = |holdings: &HashMap<String, Amount>, at: i64, live_end: bool| {
        let mut sorted: Vec<(&String, &Amount)> = holdings.iter().collect();
        sorted.sort_by(|a, b| locale_compare(a.0, b.0));
        let mut total: Amount = 0;
        let mut missing = Vec::new();
        for (asset, qty) in sorted {
            if *qty == 0 {
                continue;
            }
            match r.price_at(asset, at, live_end) {
                None => missing.push(asset.clone()),
                Some(p) => total += mul(*qty, p),
            }
        }
        Point {
            at,
            value: missing.is_empty().then_some(total),
            missing,
        }
    };
    let points: Vec<Point> = input
        .samples
        .iter()
        .zip(&r.holdings_at)
        .enumerate()
        .map(|(i, (at, held))| value_of(held, *at, input.live && i + 1 == n))
        .collect();
    let empty = Point {
        at: 0,
        value: None,
        missing: Vec::new(),
    };
    let opening = points.first().unwrap_or(&empty);
    let closing = points.last().unwrap_or(&empty);

    let mut deposits: Amount = 0;
    let mut withdrawals: Amount = 0;
    let mut fees: Amount = 0;
    let mut other: Amount = 0;
    let mut missing: Vec<String> = Vec::new();
    let mut note = |a: &String| {
        if !missing.contains(a) {
            missing.push(a.clone());
        }
    };
    for a in opening.missing.iter().chain(&closing.missing) {
        note(a);
    }
    for row in r
        .rows
        .iter()
        .filter(|row| input.live || row.bucket_start < end)
    {
        if row.leg.is_none() && row.fee == 0 {
            continue;
        }
        let bucket_end = row.bucket_start + bucket;
        let price = if bucket_end >= end {
            r.price_at(&row.asset_id, end, input.live)
        } else {
            r.price_at(&row.asset_id, bucket_end, false)
        };
        let Some(price) = price else {
            note(&row.asset_id);
            continue;
        };
        match row.leg {
            Some(Leg::Deposits) => deposits += mul(row.net, price),
            Some(Leg::Withdrawals) => withdrawals -= mul(row.net, price),
            Some(Leg::Fees) => fees -= mul(row.net, price),
            Some(Leg::OtherFlows) => other += mul(row.net, price),
            None => {}
        }
        fees += mul(row.fee, price);
    }
    missing.sort_by(|a, b| locale_compare(a, b));
    let known = missing.is_empty() && opening.value.is_some() && closing.value.is_some();
    let usd = |v: Amount| known.then_some(v);
    let market_move = match (opening.value, closing.value) {
        (Some(o), Some(c)) if known => c - o - deposits + withdrawals + fees - other,
        _ => 0,
    };
    let bridge = Bridge {
        opening: opening.value,
        deposits: usd(deposits),
        withdrawals: usd(withdrawals),
        fees: usd(fees),
        other_flows: usd(other),
        market_move: usd(market_move),
        closing: closing.value,
        missing,
    };
    ValueOverTime {
        from: input.samples.first().copied().unwrap_or_default(),
        to: end,
        interval: input.interval,
        points,
        bridge,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]
    use super::*;
    use service_kit::time::days_from_civil;

    pub const DAY: i64 = 86_400_000;

    /// 2026-10-<d> at `hour`, UTC.
    pub fn day(d: i64, hour: i64) -> i64 {
        days_from_civil(2026, 10, d) * DAY + hour * 3_600_000
    }

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn mv(
        d: i64,
        a: &str,
        module: &str,
        reason: &str,
        inflow: &str,
        outflow: &str,
        fee: &str,
    ) -> Movement {
        Movement {
            asset_id: a.to_owned(),
            module: module.to_owned(),
            reason: reason.to_owned(),
            bucket_start: day(d, 0),
            inflow: amt(inflow),
            outflow: amt(outflow),
            fee: amt(fee),
        }
    }

    fn history(holdings: &[(&str, &str)], movements: Vec<Movement>) -> Holdings {
        Holdings {
            holdings: holdings
                .iter()
                .map(|(a, v)| ((*a).to_owned(), amt(v)))
                .collect(),
            movements,
        }
    }

    /// Day 2: TEST 1000 USDT deposited. Day 3: 1 BTC bought for 500 USDT, 0.01 BTC fee. Day 4: 0.5 BTC moved to the
    /// person's own Space, and 100 USDT withdrawn.
    pub fn main_history() -> Holdings {
        history(
            &[("BTC", "0.5"), ("USDT", "400")],
            vec![
                mv(2, "USDT", "ledger", "deposit.credited", "1000", "0", "0"),
                mv(3, "BTC", "trade", "trade.fill", "1", "0", "0.01"),
                mv(3, "USDT", "trade", "trade.fill", "0", "500", "0"),
                mv(
                    4,
                    "BTC",
                    "identity",
                    "identity.sub_account.transfer",
                    "0",
                    "0.5",
                    "0",
                ),
                mv(4, "USDT", "ledger", "withdraw.settled", "0", "100", "0"),
            ],
        )
    }

    pub fn savings_history() -> Holdings {
        history(
            &[("BTC", "0.5")],
            vec![mv(
                4,
                "BTC",
                "identity",
                "identity.sub_account.transfer",
                "0.5",
                "0",
                "0",
            )],
        )
    }

    /// Daily BTC/USDT candles: the one opening on day d closes at 100d.
    pub fn daily(first: i64) -> CloseSeries {
        CloseSeries {
            market: "BTC/USDT".to_owned(),
            candles: (first..=10)
                .map(|d| (day(d, 0), amt(&(100 * d).to_string())))
                .collect(),
        }
    }

    fn samples() -> Vec<i64> {
        (1..=5).map(|d| day(d, 0)).collect()
    }

    fn inputs(
        histories: Vec<Holdings>,
        samples: Vec<i64>,
        live: bool,
        closes: &[(&str, Option<CloseSeries>)],
    ) -> ValueInputs {
        ValueInputs {
            histories,
            interval: "1d",
            samples,
            live,
            closes: closes
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        }
    }

    fn values(out: &ValueOverTime) -> Vec<Option<String>> {
        out.points
            .iter()
            .map(|p| p.value.map(format_amount))
            .collect()
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_owned())
    }

    #[test]
    fn replays_the_holdings_backwards_from_now_and_values_each_moment_at_the_last_closed_candle() {
        let out = value_over_time(&inputs(
            vec![main_history(), savings_history()],
            samples(),
            false,
            &[("BTC", Some(daily(0)))],
        ));
        assert_eq!(
            values(&out),
            vec![s("0"), s("0"), s("1000"), s("800"), s("800")]
        );
        assert!(out.points.iter().all(|p| p.missing.is_empty()));
    }

    #[test]
    fn a_moment_with_a_coin_held_and_no_price_is_missing_and_names_the_coin_never_zero() {
        let mut with_sol = main_history();
        with_sol.holdings.push(("SOL".to_owned(), amt("3")));
        with_sol
            .movements
            .push(mv(3, "SOL", "ledger", "deposit.credited", "3", "0", "0"));
        let out = value_over_time(&inputs(
            vec![with_sol, savings_history()],
            samples(),
            false,
            &[("BTC", Some(daily(0))), ("SOL", None)],
        ));
        assert_eq!(values(&out)[..3], [s("0"), s("0"), s("1000")]);
        for p in &out.points[3..] {
            assert_eq!(p.value, None);
            assert_eq!(p.missing, vec!["SOL".to_owned()]);
        }
        let late = value_over_time(&inputs(
            vec![main_history(), savings_history()],
            samples(),
            false,
            &[("BTC", Some(daily(4)))],
        ));
        assert_eq!(
            values(&late),
            vec![s("0"), s("0"), s("1000"), None, s("800")]
        );
    }

    #[test]
    fn a_live_end_is_the_ledger_read_itself_priced_at_the_candle_still_open() {
        let mut live = samples();
        live.push(day(5, 12));
        let out = value_over_time(&inputs(
            vec![main_history(), savings_history()],
            live,
            true,
            &[("BTC", Some(daily(0)))],
        ));
        let last = out.points.last().unwrap();
        assert_eq!(last.at, day(5, 12));
        assert_eq!(last.value.map(format_amount), s("900"));
    }

    #[test]
    fn gives_each_coin_its_amount_at_both_ends_the_change_between_them_and_its_price_and_value_there()
     {
        let out = holdings_change(&inputs(
            vec![main_history(), savings_history()],
            samples(),
            false,
            &[("BTC", Some(daily(0)))],
        ));
        let j = out.json();
        assert_eq!(
            j.get("rows").unwrap().compact(),
            r#"[{"assetId":"BTC","startAmount":"0","endAmount":"1","change":"1","startPriceUsd":"0","endPriceUsd":"400","startValueUsd":"0","endValueUsd":"400"},{"assetId":"USDT","startAmount":"0","endAmount":"400","change":"400","startPriceUsd":"1","endPriceUsd":"1","startValueUsd":"0","endValueUsd":"400"}]"#
        );
    }

    #[test]
    fn counts_what_fell_leaves_out_a_coin_held_at_neither_end_and_never_prices_a_coin_with_no_market()
     {
        let mut with_sol = main_history();
        with_sol.holdings.push(("SOL".to_owned(), amt("3")));
        with_sol
            .movements
            .push(mv(3, "SOL", "ledger", "deposit.credited", "3", "0", "0"));
        let out = holdings_change(&inputs(
            vec![with_sol, savings_history()],
            vec![day(4, 0), day(5, 0)],
            false,
            &[("BTC", Some(daily(0))), ("SOL", None)],
        ));
        let got: Vec<_> = out
            .rows
            .iter()
            .map(|r| {
                (
                    r.asset_id.as_str(),
                    format_amount(r.start),
                    format_amount(r.end),
                    format_amount(r.end - r.start),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("BTC", "1".to_owned(), "1".to_owned(), "0".to_owned()),
                ("SOL", "3".to_owned(), "3".to_owned(), "0".to_owned()),
                (
                    "USDT",
                    "500".to_owned(),
                    "400".to_owned(),
                    "-100".to_owned()
                ),
            ]
        );
        let sol = &out.rows[1];
        assert_eq!((sol.start_price, sol.end_price), (None, None));
    }

    fn bridge_text(b: &Bridge) -> Vec<Option<String>> {
        [
            b.opening,
            b.deposits,
            b.withdrawals,
            b.fees,
            b.other_flows,
            b.market_move,
            b.closing,
        ]
        .iter()
        .map(|v| v.map(format_amount))
        .collect()
    }

    #[test]
    fn opening_plus_deposits_less_withdrawals_less_fees_plus_other_flows_plus_market_move_is_closing_and_own_moves_cancel()
     {
        let out = value_over_time(&inputs(
            vec![main_history(), savings_history()],
            samples(),
            false,
            &[("BTC", Some(daily(0)))],
        ));
        assert_eq!(
            bridge_text(&out.bridge),
            vec![
                s("0"),
                s("1000"),
                s("100"),
                s("3"),
                s("0"),
                s("-97"),
                s("800")
            ]
        );
        assert!(out.bridge.missing.is_empty());
    }

    #[test]
    fn counts_other_money_in_and_out_at_its_value_then_and_leaves_a_past_ends_later_movements_out()
    {
        let mut reward = main_history();
        reward.holdings = vec![
            ("BTC".to_owned(), amt("0.6")),
            ("USDT".to_owned(), amt("450")),
        ];
        reward.movements.push(mv(
            3,
            "BTC",
            "token",
            "token.yield.distributed",
            "0.1",
            "0",
            "0",
        ));
        reward
            .movements
            .push(mv(4, "USDT", "ledger", "deposit.credited", "50", "0", "0"));
        let out = value_over_time(&inputs(
            vec![reward, savings_history()],
            samples()[..4].to_vec(),
            false,
            &[("BTC", Some(daily(0)))],
        ));
        let b = &out.bridge;
        let t = bridge_text(b);
        assert_eq!(
            [&t[0], &t[1], &t[2], &t[3], &t[4], &t[6]],
            [&s("0"), &s("1000"), &s("0"), &s("3"), &s("30"), &s("830")]
        );
        let sum =
            b.opening.unwrap() + b.deposits.unwrap() - b.withdrawals.unwrap() - b.fees.unwrap()
                + b.other_flows.unwrap()
                + b.market_move.unwrap();
        assert_eq!(sum, b.closing.unwrap());
    }

    #[test]
    fn is_unknown_with_the_coin_named_when_a_part_of_it_has_no_price() {
        let out = value_over_time(&inputs(
            vec![main_history(), savings_history()],
            samples(),
            false,
            &[("BTC", None)],
        ));
        let b = &out.bridge;
        assert_eq!(b.opening.map(format_amount), s("0"));
        assert_eq!((b.deposits, b.market_move, b.closing), (None, None, None));
        assert_eq!(b.missing, vec!["BTC".to_owned()]);
    }

    #[test]
    fn picks_the_finest_candle_that_fits_reads_weeks_in_days_and_sets_the_moments_on_the_ledger_grid()
     {
        let ten = day(10, 0);
        assert_eq!(choose_interval(day(9, 0), ten, ten), Some("5m"));
        assert_eq!(choose_interval(ten - 365 * DAY, ten, ten), Some("1d"));
        assert_eq!(choose_interval(ten - 20 * 365 * DAY, ten, ten), None);
        assert_eq!(bucket_of("1w"), 86_400);
        assert_eq!(bucket_of("5m"), 300);
        let grid = grid_of(day(1, 7), day(3, 7), ten, "1d").unwrap();
        assert_eq!(grid.samples, vec![day(1, 0), day(2, 0), day(3, 0)]);
        assert!(!grid.live);
        assert_eq!(grid_of(day(3, 1), day(3, 2), ten, "1d"), None);
        assert_eq!(
            grid_of(day(9, 7), day(11, 0), day(10, 5), "1d")
                .unwrap()
                .samples
                .last(),
            Some(&day(10, 5))
        );
    }

    #[test]
    fn a_ledger_answer_that_does_not_fit_its_schema_fails_the_read() {
        let ok = service_kit::json::parse(
            r#"{"asOf":"2026-10-10T00:00:00.000Z","from":"2026-10-01T00:00:00.000Z","bucketSeconds":86400,"holdings":[{"assetId":"BTC","amount":"0.5"}],"movements":[{"assetId":"BTC","module":"trade","reason":"trade.fill","bucketStart":"2026-10-03T00:00:00.000Z","inflow":"1","outflow":"0","fee":"0.01"}]}"#,
        )
        .unwrap();
        let got = parse_holdings(&ok).unwrap();
        assert_eq!(got.movements[0].bucket_start, day(3, 0));
        let bad = service_kit::json::parse(
            r#"{"asOf":"2026-10-10T00:00:00.000Z","from":"2026-10-01T00:00:00.000Z","bucketSeconds":86400,"holdings":[{"assetId":"BTC","amount":"-1"}],"movements":[]}"#,
        )
        .unwrap();
        assert!(parse_holdings(&bad).is_err());
    }
}
