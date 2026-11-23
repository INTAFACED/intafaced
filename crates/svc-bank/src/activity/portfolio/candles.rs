//! One coin's closes over a window (`portfolio/candles.ts`), from svc-trade's public candles (`/api/v1/ohlcv`), read on
//! the coin's USDT market, else its USDC market. svc-trade answers a window only whole, from `since` to now in at most
//! 720 candles, and leaves out a candle in which nothing traded; a coin that last traded before the window gets its last
//! close before the start (the hours of the day before, else the days of the 30 days before) as a candle ended by the
//! start. A market with no candle at all is passed over for the next quote. No candle means no price, never zero.

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::time::Instant;

use super::valuation::PRICE_QUOTES;

/// `VALUE_SERIES_INTERVALS`, finest first.
pub const INTERVALS: [&str; 5] = ["5m", "1h", "4h", "1d", "1w"];

/// `SERIES_TIMEFRAME_MS`.
pub fn timeframe_ms(interval: &str) -> i64 {
    match interval {
        "5m" => 300_000,
        "1h" => 3_600_000,
        "4h" => 14_400_000,
        "1d" => 86_400_000,
        _ => 604_800_000,
    }
}

/// One market's candles: open time (epoch ms) and close, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseSeries {
    pub market: String,
    pub candles: Vec<(i64, Amount)>,
}

/// The port. `Ok(None)`: the coin has neither market. `Err`: the market data cannot be read.
pub trait CloseSource: Send + Sync {
    fn closes(
        &self,
        asset_id: &str,
        interval: &str,
        from: Instant,
        to: Instant,
    ) -> Result<Option<CloseSeries>, String>;
}

/// Nothing wired: every read fails.
pub struct NoCloses;

impl CloseSource for NoCloses {
    fn closes(
        &self,
        _: &str,
        _: &str,
        _: Instant,
        _: Instant,
    ) -> Result<Option<CloseSeries>, String> {
        Err("svc-bank in Rust: no market data is wired".to_owned())
    }
}

const READ_TIMEOUT_MS: u64 = 3_000;
const POINTS_PER_READ: i64 = 720;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
/// Where the start's last close is looked for: a day of hours, else 30 days of days.
const START_LOOKBACK: [(&str, i64, i64); 2] = [("1h", HOUR_MS, 24), ("1d", DAY_MS, 30)];

enum Rows {
    Found(Vec<(i64, String)>),
    NoMarket,
    TooFar,
}

/// `encodeURIComponent`.
pub fn encode_component(s: &str) -> String {
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

/// `httpCloseSeries`.
pub struct HttpCloses {
    base: String,
    fetch: Box<dyn Fetch>,
    now: fn() -> Instant,
}

impl HttpCloses {
    pub fn new(base_url: &str, fetch: Box<dyn Fetch>, now: fn() -> Instant) -> HttpCloses {
        HttpCloses {
            base: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            fetch,
            now,
        }
    }

    fn candles(&self, market: &str, timeframe: &str, since: i64) -> Result<Rows, String> {
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
            .map_err(|e| e.message)?;
        if res.status == 400 || res.status == 404 {
            let body = json::parse(&res.body).ok();
            let field = |k: &str| match body.as_ref().and_then(|b| b.get(k)) {
                Some(Json::String(s)) => Some(s.clone()),
                _ => None,
            };
            if field("code").as_deref() == Some("BadSymbol") {
                return Ok(Rows::NoMarket);
            }
            if field("intafacedCode").as_deref() == Some("trade.candles_range_point_cap") {
                return Ok(Rows::TooFar);
            }
            return Err(format!(
                "market data refused {market} {timeframe}: {} {}",
                res.status,
                field("intafacedCode").unwrap_or_default()
            ));
        }
        if !res.ok() {
            return Err(format!(
                "market data read failed {market} {timeframe}: {}",
                res.status
            ));
        }
        let rows = json::parse(&res.body).map_err(|e| e.message)?;
        let Json::Array(rows) = rows else {
            return Ok(Rows::Found(Vec::new()));
        };
        Ok(Rows::Found(
            rows.iter()
                .filter_map(|row| match row {
                    Json::Array(cells) => match (cells.first(), cells.get(4)) {
                        #[allow(clippy::cast_possible_truncation, reason = "a candle's epoch ms")]
                        (Some(Json::Number(at)), Some(Json::String(close))) => {
                            Some((*at as i64, close.clone()))
                        }
                        _ => None,
                    },
                    _ => None,
                })
                .collect(),
        ))
    }

    /// The last close before `from` on `market`; none within reach is `None`.
    fn start_close(&self, market: &str, from: i64) -> Result<Option<Amount>, String> {
        for (timeframe, ms, back) in START_LOOKBACK {
            let since = from.div_euclid(ms) * ms - back * ms;
            if (self.now)().0 - since >= POINTS_PER_READ * ms {
                continue;
            }
            let Rows::Found(rows) = self.candles(market, timeframe, since)? else {
                continue;
            };
            if let Some((_, close)) = rows.iter().rev().find(|(at, _)| at + ms <= from) {
                return parse_amount(close).map(Some);
            }
        }
        Ok(None)
    }
}

impl CloseSource for HttpCloses {
    fn closes(
        &self,
        asset_id: &str,
        interval: &str,
        from: Instant,
        to: Instant,
    ) -> Result<Option<CloseSeries>, String> {
        let frame = timeframe_ms(interval);
        let since = from.0.div_euclid(frame) * frame - frame;
        let mut first: Option<CloseSeries> = None;
        for quote in PRICE_QUOTES {
            let market = format!("{}/{quote}", asset_id.to_uppercase());
            let rows = match self.candles(&market, interval, since)? {
                Rows::NoMarket => continue,
                Rows::TooFar => {
                    return Err(format!(
                        "market data refused {market} {interval} from {}",
                        Instant(since).iso()
                    ));
                }
                Rows::Found(rows) => rows,
            };
            let mut series = Vec::new();
            for (at, close) in rows.into_iter().filter(|(at, _)| *at <= to.0) {
                series.push((at, parse_amount(&close)?));
            }
            if !series.iter().any(|(at, _)| at + frame <= from.0)
                && let Some(start) = self.start_close(&market, from.0)?
            {
                series.insert(0, (from.0 - frame, start));
            }
            let found = CloseSeries {
                market,
                candles: series,
            };
            if !found.candles.is_empty() {
                return Ok(Some(found));
            }
            if first.is_none() {
                first = Some(found);
            }
        }
        Ok(first)
    }
}

/// `closeAt`: the close of the last candle that had ended by `at`; the candle still open only at the live end.
pub fn close_at(series: &CloseSeries, interval: &str, at: i64, live: bool) -> Option<Amount> {
    let limit = if live {
        at
    } else {
        at - timeframe_ms(interval)
    };
    let count = series.candles.partition_point(|(open, _)| *open <= limit);
    count
        .checked_sub(1)
        .and_then(|i| series.candles.get(i))
        .map(|(_, close)| *close)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::Mutex;

    const H: i64 = 3_600_000;
    const M5: i64 = 300_000;
    /// 2026-10-20T15:00:00Z.
    const T0: i64 = 1_792_508_400_000;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    /// svc-trade's candles: one answer per "<market> <timeframe>", every URL asked for kept.
    struct Trade {
        answers: Vec<(&'static str, u16, String)>,
        asked: Mutex<Vec<String>>,
    }

    impl Fetch for Trade {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.asked.lock().unwrap().push(req.url.clone());
            let path = req.url.split("/ohlcv/").nth(1).unwrap();
            let (market, rest) = path.split_once('?').unwrap();
            let market = market.replace("%2F", "/");
            let timeframe = rest
                .split('&')
                .find_map(|p| p.strip_prefix("timeframe="))
                .unwrap();
            let key = format!("{market} {timeframe}");
            for (k, status, body) in &self.answers {
                if *k == key {
                    return Ok(HttpResponse {
                        status: *status,
                        body: body.clone(),
                    });
                }
            }
            Ok(HttpResponse {
                status: 404,
                body: r#"{"code":"BadSymbol","intafacedCode":"trade.market_not_found"}"#.to_owned(),
            })
        }
    }

    fn candle(at: i64, close: &str) -> String {
        format!(r#"[{at},"{close}","{close}","{close}","{close}","1"]"#)
    }

    fn rows(c: &[String]) -> String {
        format!("[{}]", c.join(","))
    }

    fn now_t0_h() -> Instant {
        Instant(T0 + H)
    }

    fn source(answers: Vec<(&'static str, u16, String)>) -> (HttpCloses, &'static Trade) {
        let trade: &'static Trade = Box::leak(Box::new(Trade {
            answers,
            asked: Mutex::new(Vec::new()),
        }));
        struct Shared(&'static Trade);
        impl Fetch for Shared {
            fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
                self.0.fetch(req)
            }
        }
        (
            HttpCloses::new("http://trade", Box::new(Shared(trade)), now_t0_h),
            trade,
        )
    }

    #[test]
    fn passes_over_a_listed_usdt_market_that_never_traded_for_the_usdc_one_as_the_money_total_does()
    {
        let (s, _) = source(vec![
            ("XYZ/USDT 5m", 200, "[]".to_owned()),
            ("XYZ/USDT 1h", 200, "[]".to_owned()),
            ("XYZ/USDT 1d", 200, "[]".to_owned()),
            (
                "XYZ/USDC 5m",
                200,
                rows(&[candle(T0 - M5, "2"), candle(T0, "3")]),
            ),
        ]);
        let series = s
            .closes("XYZ", "5m", Instant(T0), Instant(T0 + H))
            .unwrap()
            .unwrap();
        assert_eq!(series.market, "XYZ/USDC");
        assert_eq!(close_at(&series, "5m", T0, false), Some(amt("2")));
    }

    #[test]
    fn a_market_with_no_candle_at_all_is_kept_so_the_coin_reads_missing_never_zero_no_market_at_all_is_null()
     {
        let (s, _) = source(vec![
            ("XYZ/USDT 5m", 200, "[]".to_owned()),
            ("XYZ/USDT 1h", 200, "[]".to_owned()),
        ]);
        let series = s
            .closes("XYZ", "5m", Instant(T0), Instant(T0 + H))
            .unwrap()
            .unwrap();
        assert_eq!(
            series,
            CloseSeries {
                market: "XYZ/USDT".to_owned(),
                candles: Vec::new()
            }
        );
        assert_eq!(close_at(&series, "5m", T0 + H, true), None);
        assert_eq!(
            s.closes("NOPE", "5m", Instant(T0), Instant(T0 + H))
                .unwrap(),
            None
        );
    }

    #[test]
    fn starts_a_thin_market_from_its_last_hourly_close_of_the_same_day_before_the_start_not_the_day_before()
     {
        let (s, trade) = source(vec![
            ("BTC/USDT 5m", 200, rows(&[candle(T0 + 2 * M5, "61000")])),
            (
                "BTC/USDT 1h",
                200,
                rows(&[candle(T0 - 5 * H, "60000"), candle(T0 + 2 * M5, "61000")]),
            ),
            (
                "BTC/USDT 1d",
                200,
                rows(&[candle(T0 - 15 * H - DAY_MS, "59000")]),
            ),
        ]);
        let series = s
            .closes("BTC", "5m", Instant(T0), Instant(T0 + H))
            .unwrap()
            .unwrap();
        assert_eq!(close_at(&series, "5m", T0, false), Some(amt("60000")));
        assert!(
            !trade
                .asked
                .lock()
                .unwrap()
                .iter()
                .any(|u| u.contains("timeframe=1d"))
        );
    }

    #[test]
    fn refuses_rather_than_draws_from_part_of_the_data_when_a_read_fails() {
        let (s, _) = source(vec![("BTC/USDT 5m", 503, "{}".to_owned())]);
        assert!(s.closes("BTC", "5m", Instant(T0), Instant(T0 + H)).is_err());
    }

    #[test]
    fn takes_the_last_candle_ended_by_t_and_the_open_one_only_at_the_live_end() {
        let series = CloseSeries {
            market: "BTC/USDT".to_owned(),
            candles: [0, 1, 2, 3, 5]
                .iter()
                .map(|h| (T0 + h * H, amt(&(100 + h).to_string())))
                .collect(),
        };
        assert_eq!(close_at(&series, "1h", T0, false), None);
        assert_eq!(close_at(&series, "1h", T0 + H, false), Some(amt("100")));
        assert_eq!(close_at(&series, "1h", T0 + H - 1, false), None);
        assert_eq!(
            close_at(&series, "1h", T0 + 4 * H + 30, false),
            Some(amt("103"))
        );
        assert_eq!(close_at(&series, "1h", T0 + 5 * H, false), Some(amt("103")));
        assert_eq!(
            close_at(&series, "1h", T0 + 5 * H + 1, true),
            Some(amt("105"))
        );
        assert_eq!(close_at(&series, "1h", T0 + 9 * H, false), Some(amt("105")));
    }

    #[test]
    fn encodes_a_market_as_encode_uri_component_does() {
        assert_eq!(encode_component("BTC/USDT"), "BTC%2FUSDT");
        assert_eq!(encode_component("a b~*'()"), "a%20b~*'()");
    }
}
