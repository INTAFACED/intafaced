//! svc-trade's public market data (`prices.ts`, `createTradePrices`): a coin's price when it
//! arrived, and its candles over a window, on its USDT market, else its USDC market. Never a later price, never zero.

use std::sync::Arc;

use crate::http::{Fetch, HttpRequest};
use crate::json::{self, Json};
use crate::lot_book::is_par;
use crate::money::parse_amount;
use crate::ports::{CloseSeries, CloseSeriesSource, PriceAt, PriceAtTime, SeriesTimeframe};
use crate::tax::{Amount, Failure};
use crate::time::{Instant, zod_datetime};

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

/// The venue's own spot candles (`GET /api/v1/venue/spot-candles?base=<asset>&interval=<tf>&limit=500`),
/// used to value coins arriving into the person's own venue account (deposits and staking rewards,
/// J-portfolio-04 #3) without touching our own order book. Never values from a non-dollar pair, never
/// reads a candle after the arrival, and never invents a zero.
pub struct VenueSpotPrices {
    base: String,
    fetch: Arc<dyn Fetch>,
}

/// The most candles `/api/v1/venue/spot-candles` answers in one read (`user-venue-rest.ts`).
const VENUE_CANDLES_LIMIT: i64 = 500;

enum VenueRows {
    Candles {
        symbol: String,
        rows: Vec<(i64, String)>,
    },
    NoMarket,
}

impl VenueSpotPrices {
    pub fn new(base_url: &str, fetch: Arc<dyn Fetch>) -> VenueSpotPrices {
        VenueSpotPrices {
            base: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            fetch,
        }
    }

    fn spot_candles(&self, asset_id: &str, timeframe: &str) -> Result<VenueRows, Failure> {
        let base = asset_id.to_uppercase();
        let url = format!(
            "{}/api/v1/venue/spot-candles?base={}&interval={timeframe}&limit={VENUE_CANDLES_LIMIT}",
            self.base,
            encode_component(&base),
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
        if matches!(res.status, 400 | 404 | 422) {
            return Ok(VenueRows::NoMarket);
        }
        if !res.ok() {
            return Err(thrown(format!(
                "venue spot candles read failed {base} {timeframe}: {}",
                res.status
            )));
        }
        let body = json::parse(&res.body).map_err(|e| thrown(e.message))?;
        let Some(Json::String(symbol)) = body.get("symbol") else {
            return Ok(VenueRows::NoMarket);
        };
        if !symbol.rsplit_once('-').is_some_and(|(_, q)| is_par(q)) {
            return Ok(VenueRows::NoMarket);
        }
        let Some(Json::Array(items)) = body.get("value") else {
            return Ok(VenueRows::Candles {
                symbol: symbol.clone(),
                rows: Vec::new(),
            });
        };
        let rows = items
            .iter()
            .filter_map(|item| {
                let open = match item.get("openAt") {
                    Some(Json::String(s)) => zod_datetime(s, false)?.0,
                    _ => return None,
                };
                match item.get("closePrice") {
                    Some(Json::String(close)) => Some((open, close.clone())),
                    _ => None,
                }
            })
            .collect();
        Ok(VenueRows::Candles {
            symbol: symbol.clone(),
            rows,
        })
    }
}

impl PriceAtTime for VenueSpotPrices {
    fn price_at(&self, asset_id: &str, at: Instant) -> Result<Option<PriceAt>, Failure> {
        let t = at.0;
        let mut failure: Option<Failure> = None;
        for (timeframe, ms, _) in FRAMES {
            let (symbol, candles) = match self.spot_candles(asset_id, timeframe) {
                Ok(VenueRows::NoMarket) => return Ok(None),
                Ok(VenueRows::Candles { symbol, rows }) => (symbol, rows),
                Err(e) => {
                    failure = Some(e);
                    continue;
                }
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
                    market: symbol,
                    timeframe,
                    candle_at: Instant(*open),
                }));
            }
        }
        match failure {
            Some(f) => Err(f),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{FetchError, HttpResponse};
    use std::sync::Mutex;

    type ReplyFn = Box<dyn Fn(&str) -> Result<HttpResponse, FetchError> + Send + Sync>;

    struct StubFetch {
        asked: Mutex<Vec<String>>,
        reply: ReplyFn,
    }

    impl Fetch for StubFetch {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.asked.lock().expect("lock").push(req.url.clone());
            (self.reply)(&req.url)
        }
    }

    fn ok(body: &str) -> Result<HttpResponse, FetchError> {
        Ok(HttpResponse {
            status: 200,
            body: body.to_owned(),
        })
    }

    #[test]
    fn venue_spot_prices_picks_the_minute_candle_at_or_before_arrival_never_a_later_one() {
        let fetch = Arc::new(StubFetch {
            asked: Mutex::new(Vec::new()),
            reply: Box::new(|_| {
                ok(
                    r#"{"venueId":"test-venue","symbol":"HYPE-USDC","test":true,"asOf":"2026-11-24T12:05:00.000Z","value":[
                    {"openAt":"2026-11-24T12:01:00.000Z","closePrice":"24.5"},
                    {"openAt":"2026-11-24T12:02:00.000Z","closePrice":"25"},
                    {"openAt":"2026-11-24T12:03:00.000Z","closePrice":"29"}
                ]}"#,
                )
            }),
        });
        let prices = VenueSpotPrices::new("http://trade.test/", fetch.clone());
        let at = zod_datetime("2026-11-24T12:02:35.000Z", false).expect("time");
        let found = prices.price_at("hype", at).expect("read").expect("price");
        assert_eq!(found.market, "HYPE-USDC");
        assert_eq!(found.timeframe, "1m");
        assert_eq!(found.price, parse_amount("25").expect("25"));
        assert_eq!(
            found.candle_at,
            zod_datetime("2026-11-24T12:02:00.000Z", false).expect("open")
        );
        assert_eq!(
            *fetch.asked.lock().expect("lock"),
            vec!["http://trade.test/api/v1/venue/spot-candles?base=HYPE&interval=1m&limit=500"]
        );
    }

    #[test]
    fn venue_spot_prices_ignores_non_dollar_quote_and_not_offered() {
        let non_dollar = Arc::new(StubFetch {
            asked: Mutex::new(Vec::new()),
            reply: Box::new(|_| {
                ok(
                    r#"{"venueId":"test-venue","symbol":"ALT-BTC","test":true,"asOf":"2026-11-24T12:05:00.000Z","value":[
                    {"openAt":"2026-11-24T12:01:00.000Z","closePrice":"0.01"}
                ]}"#,
                )
            }),
        });
        let at = zod_datetime("2026-11-24T12:02:00.000Z", false).expect("time");
        assert_eq!(
            VenueSpotPrices::new("http://trade.test", non_dollar)
                .price_at("ALT", at)
                .expect("read"),
            None
        );

        let missing = Arc::new(StubFetch {
            asked: Mutex::new(Vec::new()),
            reply: Box::new(|_| {
                Ok(HttpResponse {
                    status: 422,
                    body: r#"{"intafacedCode":"trade.venue.not_offered"}"#.to_owned(),
                })
            }),
        });
        assert_eq!(
            VenueSpotPrices::new("http://trade.test", missing)
                .price_at("NOPE", at)
                .expect("read"),
            None
        );
    }
}
