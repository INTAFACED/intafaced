//! The paper flag is not taken on trust (`paper/market-flag-verify.ts`, D26-P1-C4): a caller's `paper: true` must match
//! trade's public markets listing (`GET {TRADE_URL}/api/v1/markets?limit=`). It does not import svc-trade, invent fills
//! or hold a balance, and every way it cannot confirm the flag refuses by name:
//!
//! - no verification port (`TRADE_URL` unset) → `academy.paper_flag_unverified`
//! - port set but the listing page size unpublished → `academy.paper_markets_limit_unset`
//! - listing unreachable or an HTTP error → `academy.paper_flag_unavailable`
//! - market not on the listing → `academy.paper_market_unlisted`
//! - listing `paper ≠ true`, or another id or symbol, while the caller claimed true → `academy.paper_flag_mismatch`

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest, TIMED_OUT};
use service_kit::json::{self, Json};
use service_kit::schema::{Value, js_trim};

use super::workbook::PaperMarketRef;
use crate::errors::{AcademyError, Refusal};
use crate::ports::{PaperFlag, PaperFlags};

/// `PAPER_MARKETS_LIMIT_MAX`: trade's page cap.
pub const PAPER_MARKETS_LIMIT_MAX: i64 = 500;

/// The listing's timeout (`timeoutMs ?? 3_000`).
pub const PAPER_FLAG_TIMEOUT_MS: u64 = 3_000;

fn refuse(code: &str, message: impl Into<String>) -> Refusal {
    AcademyError::new(message, code).into()
}

/// `assertPaperMarketsListLimit(limit)`: an integer in 1..500, or `academy.paper_markets_limit_unset`.
#[expect(
    clippy::float_cmp,
    reason = "Number.isInteger: a whole number equals its truncation"
)]
pub fn assert_paper_markets_list_limit(limit: &Value) -> Result<i64, Refusal> {
    match limit.as_number() {
        Some(n) if n.is_finite() && n.trunc() == n && (1.0..=500.0).contains(&n) =>
        {
            #[expect(clippy::cast_possible_truncation, reason = "a whole number in 1..500")]
            Ok(n as i64)
        }
        _ => Err(refuse(
            "academy.paper_markets_limit_unset",
            "Paper markets listing limit is unset — pass limit (never invent 50)",
        )),
    }
}

/// `memoryPaperFlagPort(rows)`: an in-process listing for tests, never a production fallback.
pub struct MemoryPaperFlags(pub Vec<PaperFlag>);

impl PaperFlags for MemoryPaperFlags {
    fn lookup(&self, market_id: &str, symbol: &str) -> Result<Option<PaperFlag>, Refusal> {
        let id = js_trim(market_id);
        let by_id = self.0.iter().find(|r| r.market_id == id);
        Ok(by_id
            .or_else(|| self.0.iter().find(|r| r.symbol == symbol))
            .cloned())
    }
}

/// `createTradePublicPaperFlagPort`: trade's public markets listing, unsigned, 3 s. Built only when `TRADE_URL` is
/// set; an unset URL leaves no port, so a drill claiming paper refuses unverified.
pub struct TradePaperFlags {
    base: String,
    limit: Value,
    fetch: Arc<dyn Fetch>,
    timeout_ms: u64,
}

impl TradePaperFlags {
    /// `limit` is `ACADEMY_PAPER_MARKETS_LIMIT` as published (`None` when unset: every lookup refuses).
    pub fn new(base_url: &str, limit: Option<i64>, fetch: Arc<dyn Fetch>) -> TradePaperFlags {
        TradePaperFlags {
            base: base_url.trim_end_matches('/').to_owned(),
            limit: limit.map_or(Value::Undefined, |n| Value::Number(as_f64(n))),
            fetch,
            timeout_ms: PAPER_FLAG_TIMEOUT_MS,
        }
    }

    /// The same port with a limit exactly as given (a test hands it what the TypeScript's options could hold).
    pub fn with_limit_value(mut self, limit: Value) -> TradePaperFlags {
        self.limit = limit;
        self
    }
}

#[expect(clippy::cast_precision_loss, reason = "a page size below 2^53")]
fn as_f64(n: i64) -> f64 {
    n as f64
}

fn unavailable(message: String) -> Refusal {
    refuse("academy.paper_flag_unavailable", message)
}

impl PaperFlags for TradePaperFlags {
    fn lookup(&self, market_id: &str, symbol: &str) -> Result<Option<PaperFlag>, Refusal> {
        let page = assert_paper_markets_list_limit(&self.limit)?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}/api/v1/markets?limit={page}", self.base),
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            })
            .map_err(|e| {
                // The listing's own timer aborts the controller: `This operation was aborted`.
                let message = if e.message == TIMED_OUT {
                    "This operation was aborted".to_owned()
                } else {
                    e.message
                };
                unavailable(format!(
                    "Trade markets listing unreachable ({message}) — refuse paper drill rather than trust the caller."
                ))
            })?;
        if !res.ok() {
            return Err(unavailable(format!(
                "Trade markets listing HTTP {} — refuse paper drill rather than trust the caller.",
                res.status
            )));
        }
        let Ok(Json::Array(rows)) = json::parse(&res.body) else {
            return Err(unavailable(
                "Trade markets listing was unreadable — refuse paper drill rather than trust the caller."
                    .to_owned(),
            ));
        };
        let wanted_id = js_trim(market_id);
        let wanted_symbol = js_trim(symbol);
        let mut found = None;
        for row in &rows {
            let text = |key: &str| match row.get(key) {
                Some(Json::String(s)) => s.clone(),
                _ => String::new(),
            };
            let (id, sym) = (text("id"), text("symbol"));
            if id.is_empty() || sym.is_empty() {
                continue;
            }
            let exact = id == wanted_id;
            if exact || sym == wanted_symbol {
                found = Some(PaperFlag {
                    market_id: id,
                    symbol: sym,
                    paper: row.get("paper") == Some(&Json::Bool(true)),
                });
                if exact {
                    break;
                }
            }
        }
        Ok(found)
    }
}

/// `assertCallerCannotLiePaperFlag(port, claimed)`: a missing or false flag is left to the loop; a claimed `paper:
/// true` must be confirmed by the port, never by the wire body. `port` is `None` when `TRADE_URL` is unset.
pub fn assert_caller_cannot_lie_paper_flag(
    port: Option<&dyn PaperFlags>,
    claimed: Option<&PaperMarketRef>,
) -> Result<(), Refusal> {
    let Some(claimed) = claimed else {
        return Ok(());
    };
    if !claimed.paper {
        return Ok(());
    }
    let Some(port) = port else {
        return Err(refuse(
            "academy.paper_flag_unverified",
            "TRADE_URL unset — paper flag cannot be verified against trade public markets. Refuse rather than trust paper: true.",
        ));
    };
    let Some(listed) = port.lookup(&claimed.market_id, &claimed.symbol)? else {
        return Err(refuse(
            "academy.paper_market_unlisted",
            format!(
                "Market {} is not on trade's public listing — refuse paper drill rather than trust the caller.",
                claimed.market_id
            ),
        ));
    };
    if listed.market_id != js_trim(&claimed.market_id) || listed.symbol != js_trim(&claimed.symbol)
    {
        return Err(refuse(
            "academy.paper_flag_mismatch",
            format!(
                "Caller market {}/{} does not match trade listing {}/{} — refuse rather than trust the wire.",
                claimed.market_id, claimed.symbol, listed.market_id, listed.symbol
            ),
        ));
    }
    if !listed.paper {
        return Err(refuse(
            "academy.paper_flag_mismatch",
            format!(
                "Trade lists {} as live (paper≠true). Caller paper: true is a lie — refuse (no live drill).",
                listed.market_id
            ),
        ));
    }
    Ok(())
}
