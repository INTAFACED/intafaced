//! The navigator's live reads: svc-trade's public REST (`trade-data-port.ts`, `trade-data-http-port.ts`) and
//! svc-identity's session projection (`identity-session-port.ts`, `identity-session-http-port.ts`). Each maps only
//! what the other service publishes; a miss is a miss, never an invented row.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;

use super::tools::{Market, Quote, SessionFixture};

/// Why a live read gave nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortError {
    /// `agents.navigator_markets_limit_unset`: no page size was published or passed.
    MarketsLimitUnset,
    /// Anything else: unreachable, unreadable, empty.
    Failed(String),
}

/// `NavigatorTradeDataPort`.
pub trait TradeData: Send + Sync {
    fn list_markets(&self, limit: Option<f64>) -> Result<Vec<Market>, PortError>;
    fn quote(&self, market_id: &str) -> Result<Option<Quote>, PortError>;
}

/// `NavigatorIdentitySessionPort`.
pub trait IdentitySession: Send + Sync {
    fn read(&self, session_id: &str) -> Option<SessionFixture>;
}

/// `LiveNavigatorMarkets`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveMarkets {
    Ok(Vec<Market>),
    NoLiveMarkets,
    MarketsLimitUnset,
}

/// `readLiveNavigatorMarkets`.
pub fn read_live_markets(port: Option<&dyn TradeData>, limit: Option<f64>) -> LiveMarkets {
    let Some(port) = port else {
        return LiveMarkets::NoLiveMarkets;
    };
    match port.list_markets(limit) {
        Ok(m) if !m.is_empty() => LiveMarkets::Ok(m),
        Ok(_) | Err(PortError::Failed(_)) => LiveMarkets::NoLiveMarkets,
        Err(PortError::MarketsLimitUnset) => LiveMarkets::MarketsLimitUnset,
    }
}

/// `readLiveNavigatorQuote`: the quote only when it names the market asked for and has a last price.
pub fn read_live_quote(port: Option<&dyn TradeData>, market_id: &str) -> Option<Quote> {
    let port = port?;
    if market_id.trim().is_empty() {
        return None;
    }
    let q = port.quote(market_id).ok()??;
    let last_blank = q.last.as_deref().is_none_or(|l| l.trim().is_empty());
    if q.market_id.trim().is_empty() || q.market_id != market_id || last_blank {
        return None;
    }
    Some(q)
}

/// `readLiveNavigatorSession`: the requester's own session, or none.
pub fn read_live_session(
    port: Option<&dyn IdentitySession>,
    session_id: &str,
    requester: &str,
) -> Option<SessionFixture> {
    let port = port?;
    if session_id.trim().is_empty() || requester.trim().is_empty() {
        return None;
    }
    let s = port.read(session_id)?;
    if s.session_id.trim().is_empty() || s.user_id.trim().is_empty() || s.user_id != requester {
        return None;
    }
    Some(s)
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
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

/// `symbolToNavigatorMarketId`: `BTC/USDT` is `btc-usdt` (the first slash only).
pub fn symbol_to_market_id(symbol: &str) -> String {
    symbol.trim().to_lowercase().replacen('/', "-", 1)
}

/// `navigatorMarketIdToSymbol`.
pub fn market_id_to_symbol(market_id: &str) -> Option<String> {
    let lower = market_id.trim().to_lowercase();
    let parts: Vec<&str> = lower.split('-').collect();
    match parts.as_slice() {
        [base, quote] if !base.is_empty() && !quote.is_empty() => {
            Some(format!("{}/{}", base.to_uppercase(), quote.to_uppercase()))
        }
        _ => None,
    }
}

/// `assertNavigatorMarketsPageLimit`: a finite number, floored, at least 1, at most 500.
pub fn markets_page_limit(limit: Option<f64>) -> Result<i64, PortError> {
    let Some(n) = limit.filter(|n| n.is_finite()) else {
        return Err(PortError::MarketsLimitUnset);
    };
    let n = n.floor();
    if n < 1.0 {
        return Err(PortError::MarketsLimitUnset);
    }
    #[allow(clippy::cast_possible_truncation, reason = "bounded to 500 here")]
    Ok(n.min(500.0) as i64)
}

/// `createHttpNavigatorTradeDataPort({ tradeUrl })`: no published page size, a quote fresh for a minute.
pub struct TradeHttp {
    pub trade_url: String,
    pub markets_limit: Option<f64>,
    pub max_age_ms: f64,
    pub fetch: Arc<dyn Fetch>,
}

impl TradeHttp {
    pub fn new(trade_url: &str, fetch: Arc<dyn Fetch>) -> TradeHttp {
        TradeHttp {
            trade_url: trade_url.strip_suffix('/').unwrap_or(trade_url).to_owned(),
            markets_limit: None,
            max_age_ms: 60_000.0,
            fetch,
        }
    }

    fn get(&self, url: String) -> Result<Json, PortError> {
        let unreachable = || PortError::Failed("trade unreachable".to_owned());
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url,
                headers: vec![("accept".to_owned(), "application/json".to_owned())],
                body: None,
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|_| unreachable())?;
        if !res.ok() {
            return Err(unreachable());
        }
        Ok(json::parse(&res.body).unwrap_or(Json::Null))
    }
}

fn status_of(active: bool, session_open: bool) -> &'static str {
    if !active {
        "closed"
    } else if !session_open {
        "halted"
    } else {
        "open"
    }
}

impl TradeData for TradeHttp {
    fn list_markets(&self, limit: Option<f64>) -> Result<Vec<Market>, PortError> {
        let page = markets_page_limit(limit.or(self.markets_limit))?;
        let body = self.get(format!("{}/api/v1/markets?limit={page}", self.trade_url))?;
        let Json::Array(rows) = body else {
            return Err(PortError::Failed("trade markets parse failed".to_owned()));
        };
        // A row that is not `{ id, symbol, active, sessionOpen }` is skipped, as `safeParse` skips it.
        Ok(rows
            .iter()
            .filter_map(|row| {
                let (
                    Some(Json::String(_)),
                    Some(Json::String(symbol)),
                    Some(Json::Bool(active)),
                    Some(Json::Bool(open)),
                ) = (
                    row.get("id"),
                    row.get("symbol"),
                    row.get("active"),
                    row.get("sessionOpen"),
                )
                else {
                    return None;
                };
                Some(Market {
                    market_id: symbol_to_market_id(symbol),
                    symbol: symbol.clone(),
                    status: status_of(*active, *open).to_owned(),
                })
            })
            .collect())
    }

    fn quote(&self, market_id: &str) -> Result<Option<Quote>, PortError> {
        let symbol = market_id_to_symbol(market_id)
            .ok_or_else(|| PortError::Failed("invalid navigator marketId".to_owned()))?;
        let body = self.get(format!(
            "{}/api/v1/ticker/{}",
            self.trade_url,
            encode_uri_component(&symbol)
        ))?;
        let parse_failed = || PortError::Failed("trade ticker parse failed".to_owned());
        let (Some(Json::String(body_symbol)), Some(Json::Number(_)), Some(Json::String(datetime))) = (
            body.get("symbol"),
            body.get("timestamp"),
            body.get("datetime"),
        ) else {
            return Err(parse_failed());
        };
        let last = match body.get("last") {
            Some(Json::String(l)) => Some(l.clone()),
            Some(Json::Null) => None,
            _ => return Err(parse_failed()),
        };
        if *body_symbol != symbol {
            return Err(PortError::Failed(format!(
                "ticker body symbol {body_symbol} does not match ticker URL symbol {symbol}"
            )));
        }
        match last.filter(|l| !l.trim().is_empty()) {
            None => Err(PortError::Failed("trade ticker empty last".to_owned())),
            Some(last) => Ok(Some(Quote {
                market_id: market_id.to_owned(),
                last: Some(last),
                as_of: datetime.clone(),
                max_age_ms: self.max_age_ms,
            })),
        }
    }
}

/// The identity path of the navigator's session read.
pub const IDENTITY_NAVIGATOR_SESSION_PATH: &str = "/internal/agents/navigator-session";

/// `createHttpNavigatorIdentitySessionPort`: `GET /internal/agents/navigator-session/:id`, signed as svc-agents.
pub struct IdentitySessionHttp {
    pub identity_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl IdentitySessionHttp {
    pub fn new(
        identity_url: &str,
        signer: CallSigner,
        fetch: Arc<dyn Fetch>,
    ) -> IdentitySessionHttp {
        IdentitySessionHttp {
            identity_url: identity_url
                .strip_suffix('/')
                .unwrap_or(identity_url)
                .to_owned(),
            signer,
            fetch,
        }
    }
}

impl IdentitySession for IdentitySessionHttp {
    fn read(&self, session_id: &str) -> Option<SessionFixture> {
        let path = format!(
            "{IDENTITY_NAVIGATOR_SESSION_PATH}/{}",
            encode_uri_component(session_id)
        );
        let signed = self.signer.sign("", "GET", &path, "").ok()?;
        let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
        headers.extend(signed);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{path}", self.identity_url),
                headers,
                body: None,
                timeout_ms: None,
                refuse_redirect: false,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        let body = json::parse(&res.body).ok()?;
        if body.get("ok") != Some(&Json::Bool(true)) {
            return None;
        }
        let row = body.get("session")?;
        let field = |k: &str| match row.get(k) {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        };
        let (session_id, user_id, status) =
            (field("sessionId")?, field("userId")?, field("status")?);
        if session_id.trim().is_empty() || user_id.trim().is_empty() {
            return None;
        }
        if status != "open" && status != "closed" {
            return None;
        }
        Some(SessionFixture {
            session_id,
            user_id,
            status,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_ids_and_symbols_map_both_ways_and_a_page_limit_is_never_invented() {
        assert_eq!(symbol_to_market_id(" BTC/USDT "), "btc-usdt");
        assert_eq!(market_id_to_symbol("btc-usdt").as_deref(), Some("BTC/USDT"));
        assert_eq!(market_id_to_symbol("btc"), None);
        assert_eq!(market_id_to_symbol("a-b-c"), None);
        assert_eq!(markets_page_limit(None), Err(PortError::MarketsLimitUnset));
        assert_eq!(
            markets_page_limit(Some(0.5)),
            Err(PortError::MarketsLimitUnset)
        );
        assert_eq!(markets_page_limit(Some(50.9)), Ok(50));
        assert_eq!(markets_page_limit(Some(9000.0)), Ok(500));
        assert_eq!(encode_uri_component("BTC/USDT"), "BTC%2FUSDT");
    }
}
