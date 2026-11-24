//! svc-trade's public tickers and markets (`httpTickerSource` in `portfolio-service.ts`): a read of another stream's
//! public surface, nothing written back. Both calls go out at once, each with a 3 s timeout and `?limit=500`
//! (svc-trade's cap; the limit is required). Any failure, a non-2xx answer or a wrong-shaped body refuses
//! `bank.prices_unavailable` in the service.

use std::collections::{HashMap, HashSet};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;

use super::valuation::{PriceBook, TickerQuote};

/// The port: current prices. An `Err` is any failure; its words are for the log only.
pub trait TickerSource: Send + Sync {
    fn prices(&self) -> Result<PriceBook, String>;
}

/// Nothing wired: every read fails.
pub struct NoTickers;

impl TickerSource for NoTickers {
    fn prices(&self) -> Result<PriceBook, String> {
        Err("svc-bank in Rust: no price source is wired".to_owned())
    }
}

/// `DEFAULT_TICKER_TIMEOUT_MS`.
pub const TIMEOUT_MS: u64 = 3_000;
/// `TICKER_LIMIT`.
pub const LIMIT: u32 = 500;

/// `httpTickerSource`.
pub struct HttpTickers {
    base: String,
    fetch: Box<dyn Fetch>,
    timeout_ms: u64,
}

impl HttpTickers {
    pub fn new(base_url: &str, fetch: Box<dyn Fetch>, timeout_ms: Option<u64>) -> HttpTickers {
        HttpTickers {
            base: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            fetch,
            timeout_ms: timeout_ms.unwrap_or(TIMEOUT_MS),
        }
    }

    fn get(&self, path: &str) -> Result<Json, String> {
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{path}?limit={LIMIT}", self.base),
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("svc-trade {path} answered {}", res.status));
        }
        json::parse(&res.body).map_err(|e| e.message)
    }
}

/// `amountOrNull`.
fn amount_or_null(v: Option<&Json>) -> Option<service_kit::money::Amount> {
    match v {
        Some(Json::String(s)) => parse_amount(s).ok(),
        _ => None,
    }
}

/// The two answers as a price book: tickers by upper-case symbol (an entry that is not an object is skipped), and the
/// listed spot markets (a market marked inactive, or of another type, is not listed).
pub fn book_of(tickers: &Json, markets: &Json) -> Result<PriceBook, String> {
    let Json::Object(tickers) = tickers else {
        return Err("svc-trade tickers is not an object".to_owned());
    };
    let Json::Array(markets) = markets else {
        return Err("svc-trade markets is not a list".to_owned());
    };
    let mut book: HashMap<String, TickerQuote> = HashMap::new();
    for (symbol, raw) in service_kit::json::js_key_order(tickers.clone()) {
        if !matches!(raw, Json::Object(_) | Json::Array(_)) {
            continue;
        }
        book.insert(
            symbol.to_uppercase(),
            TickerQuote {
                last: amount_or_null(raw.get("last")),
                open: amount_or_null(raw.get("open")),
                window_start: match raw.get("windowStart") {
                    Some(Json::Number(n)) if n.is_finite() => Some(*n),
                    _ => None,
                },
            },
        );
    }
    let mut listed = HashSet::new();
    for m in markets {
        if !matches!(m, Json::Object(_) | Json::Array(_)) {
            continue;
        }
        let Some(Json::String(symbol)) = m.get("symbol") else {
            continue;
        };
        if matches!(m.get("active"), Some(Json::Bool(false))) {
            continue;
        }
        match m.get("type") {
            None => {}
            Some(Json::String(t)) if t == "spot" => {}
            Some(_) => continue,
        }
        listed.insert(symbol.to_uppercase());
    }
    Ok(PriceBook {
        tickers: book,
        listed,
    })
}

impl TickerSource for HttpTickers {
    fn prices(&self) -> Result<PriceBook, String> {
        let (tickers, markets) = std::thread::scope(|s| {
            let t = s.spawn(|| self.get("/api/v1/tickers"));
            let m = s.spawn(|| self.get("/api/v1/markets"));
            (
                t.join()
                    .unwrap_or_else(|_| Err("tickers read panicked".to_owned())),
                m.join()
                    .unwrap_or_else(|_| Err("markets read panicked".to_owned())),
            )
        });
        book_of(&tickers?, &markets?)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::{Arc, Mutex};

    struct Trade {
        tickers: (u16, &'static str),
        markets: (u16, &'static str),
        urls: Arc<Mutex<Vec<String>>>,
        down: bool,
    }

    impl Fetch for Trade {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.urls.lock().unwrap().push(req.url.clone());
            if self.down {
                return Err(FetchError {
                    message: "fetch failed".to_owned(),
                });
            }
            let (status, body) = if req.url.contains("/api/v1/tickers") {
                self.tickers
            } else {
                self.markets
            };
            Ok(HttpResponse {
                status,
                body: body.to_owned(),
            })
        }
    }

    fn source(
        tickers: (u16, &'static str),
        markets: (u16, &'static str),
    ) -> (HttpTickers, Arc<Mutex<Vec<String>>>) {
        let urls = Arc::new(Mutex::new(Vec::new()));
        (
            HttpTickers::new(
                "http://trade.test/",
                Box::new(Trade {
                    tickers,
                    markets,
                    urls: urls.clone(),
                    down: false,
                }),
                None,
            ),
            urls,
        )
    }

    #[test]
    fn reads_api_v1_tickers_and_api_v1_markets_limit_500_and_parses_prices_and_the_listed_set() {
        let (src, urls) = source(
            (
                200,
                r#"{"BTC/USDT":{"symbol":"BTC/USDT","last":"60000.5","open":"59000","windowStart":1700000000000,"sparkline":["1"]},"ETH/USDT":{"last":null,"open":null},"JUNK/USDT":{"last":"abc","open":12},"bad":null}"#,
            ),
            (
                200,
                r#"[{"symbol":"BTC/USDT","type":"spot","active":true},{"symbol":"SOL/USDT","type":"spot","active":true},{"symbol":"OLD/USDT","type":"spot","active":false},{"symbol":"BTC/USDT:USDT","type":"swap","active":true}]"#,
            ),
        );
        let book = src.prices().unwrap();
        let mut asked = urls.lock().unwrap().clone();
        asked.sort();
        assert_eq!(
            asked,
            vec![
                "http://trade.test/api/v1/markets?limit=500",
                "http://trade.test/api/v1/tickers?limit=500"
            ]
        );
        assert_eq!(
            book.tickers.get("BTC/USDT"),
            Some(&TickerQuote {
                last: Some(parse_amount("60000.5").unwrap()),
                open: Some(parse_amount("59000").unwrap()),
                window_start: Some(1_700_000_000_000.0),
            })
        );
        let blank = TickerQuote {
            last: None,
            open: None,
            window_start: None,
        };
        assert_eq!(book.tickers.get("ETH/USDT"), Some(&blank));
        assert_eq!(book.tickers.get("JUNK/USDT"), Some(&blank));
        assert!(!book.tickers.contains_key("BAD"));
        let mut listed: Vec<_> = book.listed.into_iter().collect();
        listed.sort();
        assert_eq!(listed, vec!["BTC/USDT", "SOL/USDT"]);
    }

    #[test]
    fn refuses_on_a_5xx_from_either_call_a_refused_connection_and_a_wrong_shaped_body() {
        assert!(
            source((503, r#"{"error":"x"}"#), (200, "[]"))
                .0
                .prices()
                .is_err()
        );
        assert!(
            source((200, "{}"), (502, r#"{"error":"x"}"#))
                .0
                .prices()
                .is_err()
        );
        let down = HttpTickers::new(
            "http://trade.test",
            Box::new(Trade {
                tickers: (200, "{}"),
                markets: (200, "[]"),
                urls: Arc::default(),
                down: true,
            }),
            None,
        );
        assert!(down.prices().is_err());
        assert!(source((200, "[1,2]"), (200, "[]")).0.prices().is_err());
        assert!(
            source((200, "{}"), (200, r#"{"not":"a list"}"#))
                .0
                .prices()
                .is_err()
        );
        assert!(source((200, "not json"), (200, "[]")).0.prices().is_err());
    }
}
