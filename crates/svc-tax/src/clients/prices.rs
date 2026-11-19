//! svc-trade's public market data (`services/svc-tax/src/prices.ts`, `createTradePrices`): a coin's price when it
//! arrived, and its candles over a window, on its USDT market, else its USDC market. Never a later price, never zero.

use std::sync::Arc;

use crate::http::{Fetch, HttpRequest};
use crate::json::{self, Json};
use crate::money::parse_amount;
use crate::ports::{CloseSeries, CloseSeriesSource, PriceAt, PriceAtTime, SeriesTimeframe};
use crate::tax::{Amount, Failure};
use crate::time::Instant;

const QUOTES: [&str; 2] = ["USDT", "USDC"];
/// Candle sizes in order, with how far back before the arrival each looks for its last candle (read windows).
const FRAMES: [(&str, i64, i64); 3] = [
    ("1m", 60_000, 60),
    ("1h", 3_600_000, 24),
    ("1d", 86_400_000, 30),
];
/// A read's timeout and the most points the door returns: technical bounds.
pub const READ_TIMEOUT_MS: u64 = 3_000;
pub const POINTS_PER_READ: i64 = 720;

enum Rows {
    Candles(Vec<(i64, String)>),
    NoMarket,
    TooFar,
}

pub struct TradePrices {
    base: String,
    fetch: Arc<dyn Fetch>,
}

fn thrown(message: String) -> Failure {
    Failure::Internal(message)
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `Math.floor(t / ms) * ms`.
fn floor_to(t: i64, ms: i64) -> i64 {
    t.div_euclid(ms) * ms
}

/// `typeof x === 'number'` holding a time: a whole millisecond count. A fractional open time is not one svc-trade
/// sends; it is left out rather than rounded.
fn whole_ms(v: &Json) -> Option<i64> {
    let Json::Number(n) = v else { return None };
    if !n.is_finite() || n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole number inside 2^53, checked above"
    )]
    Some(*n as i64)
}

impl TradePrices {
    pub fn new(base_url: &str, fetch: Arc<dyn Fetch>) -> TradePrices {
        TradePrices {
            base: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            fetch,
        }
    }

    /// Candles from `since` on, or why there are none.
    fn candles(&self, market: &str, timeframe: &str, since: i64) -> Result<Rows, Failure> {
        let url = format!(
            "{}/api/v1/ohlcv/{}?timeframe={timeframe}&since={since}&limit={POINTS_PER_READ}",
            self.base,
            encode_component(market)
        );
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url,
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(READ_TIMEOUT_MS),
                refuse_redirect: false,
            })
            .map_err(|e| thrown(e.message))?;
        if res.status == 400 || res.status == 404 {
            let body = json::parse(&res.body).ok();
            let field = |k: &str| match body.as_ref().and_then(|b| b.get(k)) {
                Some(Json::String(s)) => Some(s.clone()),
                _ => None,
            };
            if field("code").as_deref() == Some("BadSymbol") {
                return Ok(Rows::NoMarket);
            }
            let code = field("intafacedCode");
            if code.as_deref() == Some("trade.candles_range_point_cap") {
                return Ok(Rows::TooFar);
            }
            return Err(thrown(format!(
                "market data refused {market} {timeframe}: {} {}",
                res.status,
                code.unwrap_or_default()
            )));
        }
        if !res.ok() {
            return Err(thrown(format!(
                "market data read failed {market} {timeframe}: {}",
                res.status
            )));
        }
        let rows = json::parse(&res.body).map_err(|e| thrown(e.message))?;
        let Json::Array(rows) = rows else {
            return Ok(Rows::Candles(Vec::new()));
        };
        Ok(Rows::Candles(
            rows.iter()
                .filter_map(|row| {
                    let Json::Array(cells) = row else { return None };
                    let open = cells.first().and_then(whole_ms)?;
                    match cells.get(4) {
                        Some(Json::String(close)) => Some((open, close.clone())),
                        _ => None,
                    }
                })
                .collect(),
        ))
    }
}

impl PriceAtTime for TradePrices {
    fn price_at(&self, asset_id: &str, at: Instant) -> Result<Option<PriceAt>, Failure> {
        let t = at.0;
        let mut failure: Option<Failure> = None;
        for quote in QUOTES {
            let market = format!("{}/{quote}", asset_id.to_uppercase());
            for (timeframe, ms, lookback) in FRAMES {
                let since = floor_to(t, ms) - lookback * ms;
                let rows = match self.candles(&market, timeframe, since) {
                    Ok(rows) => rows,
                    Err(e) => {
                        // One failed read: try the next candle size or market before giving up.
                        failure = Some(e);
                        continue;
                    }
                };
                let candles = match rows {
                    Rows::NoMarket => break,
                    Rows::TooFar => continue,
                    Rows::Candles(c) => c,
                };
                // One-minute: the minute it arrived in counts. Bigger: only a candle that had ended by the arrival.
                let last = candles.iter().rfind(|(open, _)| {
                    if timeframe == "1m" {
                        *open <= t
                    } else {
                        open + ms <= t
                    }
                });
                if let Some((open, close)) = last {
                    return Ok(Some(PriceAt {
                        price: parse_amount(close).map_err(thrown)?,
                        market,
                        timeframe,
                        candle_at: Instant(*open),
                    }));
                }
            }
        }
        match failure {
            Some(f) => Err(f),
            None => Ok(None),
        }
    }
}

impl CloseSeriesSource for TradePrices {
    fn closes(
        &self,
        asset_id: &str,
        timeframe: SeriesTimeframe,
        from: Instant,
        to: Instant,
    ) -> Result<Option<CloseSeries>, Failure> {
        let frame = timeframe.ms();
        // One read: svc-trade answers a window only whole, from `since` to now.
        let since = floor_to(from.0, frame) - frame;
        for quote in QUOTES {
            let market = format!("{}/{quote}", asset_id.to_uppercase());
            let rows = match self.candles(&market, timeframe.name(), since)? {
                Rows::NoMarket => continue,
                Rows::TooFar => {
                    return Err(thrown(format!(
                        "market data refused {market} {} from {}",
                        timeframe.name(),
                        Instant(since).iso()
                    )));
                }
                Rows::Candles(c) => c,
            };
            let mut series: Vec<(i64, Amount)> = rows
                .into_iter()
                .filter(|(open, _)| *open <= to.0)
                .map(|(open, close)| Ok((open, parse_amount(&close).map_err(thrown)?)))
                .collect::<Result<_, Failure>>()?;
            // A coin that last traded before the window: its last price, on this market only, as a candle ended by the
            // start. Never a later price.
            if !series.iter().any(|(open, _)| open + frame <= from.0) {
                let before = self.price_at(asset_id, from)?;
                if let Some(b) = before.filter(|b| b.market == market) {
                    series.insert(0, (from.0 - frame, b.price));
                }
            }
            return Ok(Some(CloseSeries {
                market,
                candles: series,
            }));
        }
        Ok(None)
    }
}
